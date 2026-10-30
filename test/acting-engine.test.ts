// C380 B7 dev.2: acting tickets in a real engine run (Temporal test server, the app's real handlers and activities).
//   quiet: a run with an agent step: step_claim files the ticket under the run, every later `app` step carries it, the ticket is
//          dropped when the run ends; a run with no agent step sends none; an older bridge (no cap) sends none.
//   fire:  the bridge refuses the ticket -> the run fails `acting_ticket_invalid` and goes no further; an expired ticket does too;
//          no ticket from the bridge at the claim -> 503 and the step stays offered.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Caller, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { WorkflowFailedError } from "@temporalio/client";
import type * as K from "#kit";
import * as acting from "../src/acting.ts";
import { setCompletionProvider } from "../src/agentsteps/completion.ts";
import { wireAgentSteps } from "../src/agentsteps/wire.ts";
import { handlers } from "../src/app.ts";
import * as directory from "../src/directory.ts";
import { resetAgentPort } from "../src/engine/agent-port.ts";
import { type Env, indexOf, read, startEnv, waitFor, wf } from "./engine/harness.ts";
import { AGENT_A, call, ctxFor, ticketOf } from "./helpers.ts";

const FREE: Caller = { ...AGENT_A, mode: "free" };
const SCHEMA = { type: "object", required: ["note"], additionalProperties: false, properties: { note: { type: "string" } } };

let t: Env;
let mintFails = false;
before(async () => {
  t = await startEnv();
  t.apps.on["knowledge.recall"] = () => ({});
  directory.recordDirectory(t.db, [{ id: FREE.id as `agt_${string}`, name: FREE.name, mode: "free", status: "active" }], Date.now());
  wireAgentSteps(t.db);
});
after(async () => {
  resetAgentPort();
  setCompletionProvider(null);
  await t.stop();
});

let n = 0;
/** ai step by the agent, then a knowledge read */
function install(steps?: unknown[]): string {
  const id = `acting-flow-${++n}`;
  t.install(wf(steps ?? [{ id: "ask", type: "ai", by: { agent: FREE.id }, instruction: "Note.", outputSchema: SCHEMA, timeoutSec: 60 }, read("after")], { id }));
  return id;
}
function agentCtx() {
  const c = ctxFor(t.db, FREE) as unknown as Record<string, unknown>;
  c.log = { info() {}, warn() {}, error() {}, debug() {} };
  c.bridgeCaps = () => (t.caps.includes(acting.CAP_ACTING) ? [acting.CAP_ACTING] : []);
  c.actingTickets = async () => {
    if (mintFails) throw new TbError("bridge_error", "down", 502);
    return [ticketOf(FREE.id)];
  };
  return c as never;
}
const op = <O>(id: string, input: unknown): Promise<O> => call<O>(handlers as never, id, input, agentCtx());
async function offered(): Promise<string> {
  let stepRunId = "";
  await waitFor("the step is offered", async () => {
    stepRunId = (await op<K.StepsDueOutput>("steps_due", {})).steps[0]?.stepRunId ?? "";
    return stepRunId !== "";
  });
  return stepRunId;
}
const ticketRows = (job: string) => t.db.prepare("SELECT agent_id FROM acting_tickets WHERE job = ?").all(job);
const recallOpts = () => t.apps.options.filter((_o, i) => t.apps.calls[i]?.op === "recall");
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WorkflowFailedError) return (e.cause as { type?: string }).type ?? "";
    throw e;
  }
  return assert.fail("the run should have failed");
}

test("quiet: the claim files the ticket under the run, the later app step carries it, the run ends and the ticket is dropped", async () => {
  t.caps.push(acting.CAP_ACTING);
  const id = install();
  const job = acting.jobOfRun(id, "run_act1");
  const pending = t.run({ workflowId: id, runId: "run_act1", trigger: { kind: "manual", input: {} } });
  const stepRunId = await offered();
  assert.equal(ticketRows(job).length, 0, "nothing before the claim");
  assert.equal((await op<K.StepClaimOutput>("step_claim", { stepRunId })).claimed, true);
  assert.deepEqual(ticketRows(job).map((x) => x.agent_id), [FREE.id]);
  await op("step_report", { stepRunId, status: "completed", output: { note: "ok" } });
  await pending;
  const sent = recallOpts().at(-1) as { acting?: { job: string; tickets: string[] }; idempotencyKey?: string } | undefined;
  assert.equal(sent?.acting?.job, job, "the app step after the agent step carries the run's ticket");
  assert.equal(sent?.acting?.tickets.length, 1);
  assert.ok(sent?.idempotencyKey, "the call's own options stay");
  assert.equal(indexOf(t.db, id, "run_act1").run?.status, "completed");
  assert.equal(ticketRows(job).length, 0, "the ticket is dropped when the run ends");
});

test("quiet: a run with no agent step sends no ticket; so does a run on an older bridge (no cap)", async () => {
  const id = install([read("only")]);
  const before = recallOpts().length;
  await t.run({ workflowId: id, runId: "run_noagent", trigger: { kind: "manual", input: {} } });
  assert.equal((recallOpts().at(-1) as { acting?: unknown } | undefined)?.acting, undefined);
  assert.equal(recallOpts().length, before + 1);

  t.caps.length = 0; // an older bridge: the claim mints nothing
  const id2 = install();
  const pending = t.run({ workflowId: id2, runId: "run_nocap", trigger: { kind: "manual", input: {} } });
  const stepRunId = await offered();
  await op("step_claim", { stepRunId });
  assert.equal(ticketRows(acting.jobOfRun(id2, "run_nocap")).length, 0);
  await op("step_report", { stepRunId, status: "completed", output: { note: "ok" } });
  await pending;
  assert.equal((recallOpts().at(-1) as { acting?: unknown } | undefined)?.acting, undefined, "no envelope without a ticket");
  t.caps.push(acting.CAP_ACTING);
});

test("fire: the bridge refuses the ticket on the app step -> the run fails acting_ticket_invalid, stops there, and says why", async () => {
  const id = install();
  t.apps.on["knowledge.recall"] = () => {
    throw new TbError("acting_ticket_invalid", "the ticket is not valid", 403);
  };
  try {
    const pending = t.run({ workflowId: id, runId: "run_refused", trigger: { kind: "manual", input: {} } });
    const failed = failure(pending);
    const stepRunId = await offered();
    await op("step_claim", { stepRunId });
    await op("step_report", { stepRunId, status: "completed", output: { note: "ok" } });
    assert.equal(await failed, "acting_ticket_invalid");
    const run = indexOf(t.db, id, "run_refused");
    assert.deepEqual([run.run?.status, run.run?.error_code, run.run?.error_step], ["failed", "acting_ticket_invalid", "after"]);
    assert.equal(ticketRows(acting.jobOfRun(id, "run_refused")).length, 0, "a failed run drops its ticket");
  } finally {
    t.apps.on["knowledge.recall"] = () => ({});
  }
});

test("fire: a run whose ticket row is expired stops at its next app step (never goes on unattributed) and sends no call", async () => {
  const id = install([read("first")]);
  acting.store(t.db, acting.jobOfRun(id, "run_exp"), [ticketOf(FREE.id, Math.floor(Date.now() / 1000) - 5)], Date.now() - 1000);
  const before = t.apps.calls.length;
  assert.equal(await failure(t.run({ workflowId: id, runId: "run_exp", trigger: { kind: "manual", input: {} } })), "acting_ticket_invalid");
  assert.equal(t.apps.calls.length, before, "no call went out");
});

test("fire: no ticket from the bridge at the claim -> 503, the step stays offered and the agent can ask again", async () => {
  const id = install();
  const pending = t.run({ workflowId: id, runId: "run_503", trigger: { kind: "manual", input: {} } });
  const stepRunId = await offered();
  mintFails = true;
  try {
    await assert.rejects(() => op("step_claim", { stepRunId }), (e: unknown) => e instanceof TbError && e.code === "acting_unavailable" && e.httpStatus === 503);
  } finally {
    mintFails = false;
  }
  assert.equal((t.db.prepare("SELECT status FROM agent_step_runs WHERE step_run_id = ?").get(stepRunId) as { status: string }).status, "offered");
  assert.equal(ticketRows(acting.jobOfRun(id, "run_503")).length, 0);
  assert.equal((await op<K.StepClaimOutput>("step_claim", { stepRunId })).claimed, true);
  await op("step_report", { stepRunId, status: "completed", output: { note: "ok" } });
  await pending;
});
