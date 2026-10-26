// C367 M1 integration: an `ai` step with `by.agent` runs through WP2's real interpreter (TestWorkflowEnvironment) into WP3's
// real port and store, with the app's real handlers. A fake agent does what `tealbrick agent serve` does: steps_due ->
// step_claim -> step_report. Nothing between the interpreter and the agent is faked: the port, the table, the ops and the
// Temporal async completion are the ones the app runs (wired by `wireAgentSteps`, the same call as `onStart`).
//   quiet: a valid output completes the workflow with that output.
//   fire:  an invalid output is a 422 (the step stays claimed); a step nobody answers times out per its timeout, and the
//          late agent is refused (Temporal wins).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type Caller, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { WorkflowFailedError } from "@temporalio/client";
import type * as K from "#kit";
import { setCompletionProvider } from "../src/agentsteps/completion.ts";
import { wireAgentSteps } from "../src/agentsteps/wire.ts";
import { handlers } from "../src/app.ts";
import * as directory from "../src/directory.ts";
import { resetAgentPort } from "../src/engine/agent-port.ts";
import { type Env, indexOf, startEnv, waitFor, wf } from "./engine/harness.ts";
import { call, ctxFor } from "./helpers.ts";

const FREE: Caller = { type: "agent", id: "agt_01J0000000000000000000000A" as Caller["id"], name: "Agent A", mode: "free" };
const OTHER: Caller = { type: "agent", id: "agt_01J0000000000000000000000B" as Caller["id"], name: "Agent B", mode: "free" };
const SCHEMA = { type: "object", required: ["bullets"], additionalProperties: false, properties: { bullets: { type: "array", items: { type: "string" }, maxItems: 5 } } };

let t: Env;
before(async () => {
  t = await startEnv();
  directory.recordDirectory(
    t.db,
    [FREE, OTHER].map((c) => ({ id: c.id as `agt_${string}`, name: c.name, mode: "free" as const, status: "active" as const })),
    Date.now(),
  );
  wireAgentSteps(t.db); // the production wiring: registerAgentPort(createAgentStepPort(db)) + setCompletionProvider(completionFromTemporal(getTemporal))
});
after(async () => {
  resetAgentPort();
  setCompletionProvider(null);
  await t.stop();
});

let n = 0;
function install(extra: Record<string, unknown> = {}, step: Record<string, unknown> = {}): string {
  const id = `agent-flow-${++n}`;
  t.install(
    wf([{ id: "ask", type: "ai", by: { agent: FREE.id }, instruction: "Research {{ $trigger.input.company }}", inputs: { company: "$trigger.input.company" }, outputSchema: SCHEMA, timeoutSec: 60, ...step }], {
      id,
      inputs: { type: "object", properties: { company: { type: "string" } } },
      outputs: { bullets: "$steps.ask.output.bullets" },
      ...extra,
    }),
  );
  return id;
}
const op = <O>(id: string, input: unknown, who: Caller = FREE): Promise<O> => call<O>(handlers as never, id, input, ctxFor(t.db, who));

/** What the agent runner does first: ask for steps until one is offered. */
async function waitForOffer(who: Caller = FREE): Promise<string> {
  let stepRunId = "";
  await waitFor(`the engine offers the step to ${who.name} (steps_due lists it)`, async () => {
    const due = await op<K.StepsDueOutput>("steps_due", {}, who);
    stepRunId = due.steps[0]?.stepRunId ?? "";
    return stepRunId !== "";
  });
  return stepRunId;
}
async function expectRefusal(p: Promise<unknown>, code: string, status: number): Promise<TbError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof TbError, String(e));
    assert.deepEqual([e.code, e.httpStatus], [code, status]);
    return e;
  }
  return assert.fail(`expected ${code}`);
}
async function failure(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WorkflowFailedError) {
      const c = e.cause as { type?: string; message: string };
      return { code: c.type ?? "", message: c.message };
    }
    throw e;
  }
  return assert.fail("the run should have failed");
}
const stepRow = (stepRunId: string) => t.db.prepare("SELECT status, inputs_json, task_token, attempt FROM agent_step_runs WHERE step_run_id = ?").get(stepRunId) as { status: string; inputs_json: string | null; task_token: string | null; attempt: number };

test("quiet: the agent claims the offered step, reports a valid output, and the workflow completes with that output", async () => {
  const id = install();
  const pending = t.run({ workflowId: id, runId: "run_ok", trigger: { kind: "manual", input: { company: "Acme" } } });

  const stepRunId = await waitForOffer();
  assert.deepEqual((await op<K.StepsDueOutput>("steps_due", {}, OTHER)).steps, [], "another Free agent is offered nothing");
  assert.equal(indexOf(t.db, id, "run_ok").steps[0]?.status, "waiting_agent", "WP2's index shows the wait");

  const claim = await op<K.StepClaimOutput>("step_claim", { stepRunId });
  assert.equal(claim.claimed, true);
  assert.equal(claim.step?.mode, "content");
  assert.equal(claim.step?.note, "Return the output only. Do not act.");
  assert.equal(claim.step?.instruction, "Research Acme", "the engine rendered the template");
  assert.deepEqual(claim.step?.inputs, { company: "Acme" });
  assert.deepEqual(claim.step?.outputSchema, SCHEMA);
  assert.equal(claim.step?.heartbeatSec, 0, "the contract asked for no heartbeat");
  // F8: the same agent asking again (a lost answer) gets the same payload as a read; it is still ONE claim
  assert.deepEqual(await op<K.StepClaimOutput>("step_claim", { stepRunId }), claim, "a lost answer is answered again");

  const report = await op<K.StepReportOutput>("step_report", { stepRunId, status: "completed", output: { bullets: ["one", "two"] }, summary: "two bullets" });
  assert.equal(report.status, "completed");

  const result = await pending;
  assert.deepEqual(result.outputs, { bullets: ["one", "two"] }, "the workflow completed with the agent's output");
  assert.equal(indexOf(t.db, id, "run_ok").steps[0]?.status, "completed");
  assert.equal(indexOf(t.db, id, "run_ok").run?.status, "completed");
  const row = stepRow(stepRunId);
  assert.deepEqual([row.status, row.inputs_json, row.task_token], ["completed", null, null], "an ended step keeps neither its inputs nor its task token");
});

test("fire: an invalid output is a 422 and the step stays claimed; a valid one after it still completes the run", async () => {
  const id = install();
  const pending = t.run({ workflowId: id, runId: "run_fix", trigger: { kind: "manual", input: { company: "Acme" } } });
  const stepRunId = await waitForOffer();
  await op("step_claim", { stepRunId });

  const bad = await expectRefusal(op("step_report", { stepRunId, status: "completed", output: { bullets: "not a list" } }), "output_invalid", 422);
  assert.equal((bad.details as { pointer?: string } | undefined)?.pointer, "/output/bullets");
  await expectRefusal(op("step_report", { stepRunId, status: "completed", output: { bullets: ["a"], extra: 1 } }), "output_invalid", 422);
  assert.equal(stepRow(stepRunId).status, "claimed", "the step stays claimed so the agent can report again");
  assert.equal(indexOf(t.db, id, "run_fix").run?.status, "running", "the workflow did not move");

  await op("step_report", { stepRunId, status: "completed", output: { bullets: ["fixed"] } });
  assert.deepEqual((await pending).outputs, { bullets: ["fixed"] });
});

test("fire: a step nobody answers times out per its timeout; the run fails and the late agent is refused", async () => {
  const id = install({}, { timeoutSec: 10 });
  const pending = t.run({ workflowId: id, runId: "run_late", trigger: { kind: "manual", input: { company: "Acme" } } });
  const failed = failure(pending);
  const stepRunId = await waitForOffer();
  await op("step_claim", { stepRunId });

  // Temporal's clock: 10 s startToClose, skipped on the test server
  await t.env.sleep(20_000);
  const f = await failed;
  assert.equal(f.code, "timeout", `the run failed because Temporal timed the step out (${f.code}: ${f.message})`);
  const run = indexOf(t.db, id, "run_late").run;
  assert.deepEqual([run?.status, run?.error_step], ["failed", "ask"]);

  // the agent answers too late: Temporal no longer has the activity, so the table follows Temporal
  await expectRefusal(op("step_report", { stepRunId, status: "completed", output: { bullets: ["too late"] } }), "step_timed_out", 409);
  assert.equal(stepRow(stepRunId).status, "timed_out");
  await expectRefusal(op("step_heartbeat", { stepRunId }), "step_timed_out", 409);
  assert.deepEqual((await op<K.StepsDueOutput>("steps_due", {})).steps, [], "a timed-out step is not offered again");
});

test("fire: the agent reports failed; the run fails with the step's error", async () => {
  const id = install();
  const pending = t.run({ workflowId: id, runId: "run_failed", trigger: { kind: "manual", input: { company: "Acme" } } });
  const failed = failure(pending);
  const stepRunId = await waitForOffer();
  await op("step_claim", { stepRunId });
  const r = await op<K.StepReportOutput>("step_report", { stepRunId, status: "failed", summary: "could not reach the source" });
  assert.equal(r.status, "failed");
  const f = await failed;
  assert.deepEqual(f, { code: "AgentStepFailed", message: "ask: could not reach the source" }, "the run shows the agent's own reason, typed");
  assert.equal(indexOf(t.db, id, "run_failed").run?.status, "failed");
});
