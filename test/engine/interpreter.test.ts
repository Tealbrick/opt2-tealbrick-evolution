// biome-ignore-all lint/suspicious/noThenProperty: a condition step of the workflow contract has a `then` field
// The interpreter workflow `evolutionRun` on a real Temporal test server (TestWorkflowEnvironment, time skipping), with the
// real activities over an in-memory app.db and a fake callApp: sequence, condition, loop (bound, continue-as-new),
// parallel, timer skip, transform, app step retry + idempotency key, engine narrowing (not_in_workflow), held answers,
// ai steps (role not implemented, agent through the fake port), child workflows, poll trigger, run index.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { WorkflowFailedError } from "@temporalio/client";
import type { AgentStepOffer } from "../../src/engine/agent-port.ts";
import { bundledCatalog, injectCatalog } from "../../src/engine/catalog.ts";
import * as store from "../../src/engine/engine-store.ts";
import type { Json } from "../../src/engine/json.ts";
import { type Env, indexOf, read, startEnv, wf, write } from "./harness.ts";

let t: Env;
const offers: AgentStepOffer[] = [];
before(async () => {
  t = await startEnv({
    agentPort: {
      async offer(o) {
        offers.push(o);
      },
      async cancel() {},
    },
  });
});
after(async () => {
  injectCatalog(null);
  await t.stop();
});

let n = 0;
/** installs a contract under a fresh workflow id and returns the id */
function install(steps: unknown[], extra: Record<string, unknown> = {}): string {
  const id = `flow-${++n}`;
  t.install(wf(steps, { id, ...extra }));
  return id;
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
  assert.fail("the run should have failed");
}
const keys = (product: string, op: string): (string | undefined)[] => t.apps.calls.filter((c) => c.product === product && c.op === op).map((c) => c.key);
const calls = (product: string, op: string): number => t.apps.calls.filter((c) => c.product === product && c.op === op).length;
/** a read whose output the test shapes freely (declared as an open object) */
const rd = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => read(id, { outputSchema: { type: "object" }, ...extra });
function reset(): void {
  t.apps.calls.length = 0;
  for (const k of Object.keys(t.apps.held)) delete t.apps.held[k];
  for (const k of Object.keys(t.apps.on)) delete t.apps.on[k];
}

test("sequence: refs between steps, a transform in the middle, outputs; the key is wfrun:<workflow>:<run>:<step>", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({ results: [{ title: "A" }, { title: "B" }] });
  t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "iss_1" } });
  const id = install(
    [
      rd("find"),
      { id: "titles", type: "transform", map: { forEach: "$steps.find.output.results", template: "{{ $item.title }}" } },
      write("make", { input: { title: "Found {{ len($steps.titles.output) }}", summary: "{{ join($steps.titles.output, ', ') }}" } }),
    ],
    { outputs: { issue: "$steps.make.output.issue.id" } },
  );
  const res = await t.run({ workflowId: id, runId: "run_seq" });
  assert.equal(res.status, "completed");
  assert.deepEqual(res.outputs, { issue: "iss_1" });
  assert.deepEqual(t.apps.calls.map((c) => [c.product, c.op, c.input]), [
    ["knowledge", "recall", { query: "x" }],
    ["kanban", "issue_create", { title: "Found 2", summary: "A, B" }],
  ]);
  assert.deepEqual(keys("kanban", "issue_create"), [`wfrun:${id}:run_seq:make`]);
  assert.deepEqual(keys("knowledge", "recall"), [`wfrun:${id}:run_seq:find`]);
});

test("the run index holds ids, status, timing, attempts and sizes but no body of another app", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({ results: [{ title: "SECRET-BODY-123" }] });
  const id = install([rd("find"), { id: "x", type: "transform", template: "got {{ len($steps.find.output.results) }}" }]);
  await t.run({ workflowId: id, runId: "run_idx" });
  const { run, steps } = indexOf(t.db, id, "run_idx");
  assert.equal(run?.status, "completed");
  assert.equal(run?.trigger_kind, "manual");
  assert.equal(run?.steps_done, 2);
  assert.equal(run?.steps_failed, 0);
  assert.equal(run?.version, 1);
  assert.ok(Number(run?.ended_at) >= Number(run?.started_at));
  assert.deepEqual(steps.map((s) => [s.step_id, s.kind, s.status, s.attempts]), [
    ["find", "app", "completed", 1],
    ["x", "transform", "completed", 0],
  ]);
  assert.ok(Number(steps[0]?.out_bytes) > 10, "the size is kept");
  assert.doesNotMatch(JSON.stringify([run, steps]), /SECRET-BODY-123/, "no body in the index");
  const view = store.getRun(t.db, id, "run_idx");
  assert.equal(view?.run.stepsDone, 2);
  assert.equal(view?.steps.length, 2);
});

test("condition: then, else, and none; the branch steps run only when taken", async () => {
  reset();
  t.apps.on["knowledge.recall"] = (i) => ({ results: [], q: (i as { query: string }).query });
  const steps = [
    { id: "gate", type: "condition", if: { "==": ["$trigger.input.go", true] }, then: [rd("yes", { input: { query: "yes" } })], else: [rd("no", { input: { query: "no" } })] },
    { id: "gate2", type: "condition", if: { "==": ["$trigger.input.go", true] }, then: [rd("only", { input: { query: "only" } })] },
  ];
  const id = install(steps, { inputs: { type: "object", properties: { go: { type: "boolean" } } } });
  const a = await t.run({ workflowId: id, trigger: { kind: "manual", input: { go: true } } });
  assert.equal(a.status, "completed");
  assert.deepEqual(t.apps.calls.map((c) => (c.input as { query: string }).query), ["yes", "only"]);
  reset();
  t.apps.on["knowledge.recall"] = (i) => ({ results: [], q: (i as { query: string }).query });
  await t.run({ workflowId: id, trigger: { kind: "manual", input: { go: false } } });
  assert.deepEqual(t.apps.calls.map((c) => (c.input as { query: string }).query), ["no"]);
});

test("loop: runs the steps per element with $loop.item; each call gets the index in its key; the output lists the last output per element", async () => {
  reset();
  t.apps.on["knowledge.recall"] = (i) => ({ echo: (i as { query: string }).query });
  const id = install([{ id: "lp", type: "loop", forEach: "$trigger.input.names", max: 5, steps: [rd("one", { input: { query: "{{ $loop.item }}-{{ $loop.index }}" } })] }], {
    inputs: { type: "object", properties: { names: { type: "array", items: { type: "string" } } } },
    outputs: { all: "$steps.lp.output.items" },
  });
  const res = await t.run({ workflowId: id, runId: "run_loop", trigger: { kind: "manual", input: { names: ["a", "b", "c"] } } });
  assert.deepEqual(res.outputs.all, [{ echo: "a-0" }, { echo: "b-1" }, { echo: "c-2" }]);
  assert.deepEqual(keys("knowledge", "recall"), [`wfrun:${id}:run_loop:one:0`, `wfrun:${id}:run_loop:one:1`, `wfrun:${id}:run_loop:one:2`]);
  const { steps } = indexOf(t.db, id, "run_loop");
  assert.deepEqual(steps.filter((s) => s.step_id === "one").map((s) => s.step_key), ["one#0", "one#1", "one#2"]);
});

test("loop bound: more elements than max fails the run (never a silent cut); the bound is also checked for onFail continue", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({});
  const inputs = { type: "object", properties: { xs: { type: "array" } } };
  const id = install([{ id: "lp", type: "loop", forEach: "$trigger.input.xs", max: 2, steps: [read("one")] }], { inputs });
  const f = await failure(t.run({ workflowId: id, trigger: { kind: "manual", input: { xs: [1, 2, 3] } } }));
  assert.equal(f.code, "loop_bound_exceeded");
  assert.equal(calls("knowledge", "recall"), 0, "nothing ran");
  const id2 = install([{ id: "lp", type: "loop", forEach: "$trigger.input.xs", max: 2, onFail: "continue", steps: [read("one")] }, read("after")], { inputs });
  const ok = await t.run({ workflowId: id2, trigger: { kind: "manual", input: { xs: [1, 2, 3] } } });
  assert.equal(ok.status, "completed");
  assert.equal(calls("knowledge", "recall"), 1, "only the step after the loop ran");
  const id3 = install([{ id: "lp", type: "loop", forEach: "$trigger.input.xs", max: 2, steps: [read("one")] }], { inputs });
  const f3 = await failure(t.run({ workflowId: id3, trigger: { kind: "manual", input: { xs: "not a list" } } }));
  assert.equal(f3.code, "input_invalid", "the input schema allows an array only");
});

test("loop above the continue-as-new size: the run continues as a new Temporal run, the state carries over, no step runs twice", async () => {
  reset();
  t.apps.on["knowledge.recall"] = (i) => ({ q: (i as { query: string }).query });
  const id = install(
    [rd("before", { input: { query: "before" } }), { id: "lp", type: "loop", forEach: "$trigger.input.xs", max: 200, steps: [rd("one", { input: { query: "{{ $loop.item }}" } })] }, read("after", { input: { query: "n={{ len($steps.lp.output.items) }}" } })],
    { inputs: { type: "object", properties: { xs: { type: "array", items: { type: "string" } } } }, outputs: { count: "$steps.lp.output.count", first: "$steps.before.output.q" } },
  );
  const xs = Array.from({ length: 7 }, (_, i) => `x${i}`);
  // canEvery 3: runs 3 + 3 + 1 iterations in three Temporal runs
  const res = await t.run({ workflowId: id, runId: "run_can", canEvery: 3, trigger: { kind: "manual", input: { xs } } });
  assert.deepEqual(res.outputs, { count: 7, first: "before" });
  assert.deepEqual(
    t.apps.calls.map((c) => (c.input as { query: string }).query),
    ["before", ...xs, "n=7"],
    "every call exactly once, in order",
  );
  assert.equal(new Set(t.apps.calls.map((c) => c.key)).size, 9);
  // walk the chain of Temporal runs back from the last one: 7 elements at 3 per run = 3 runs
  let runId: string | undefined = (await t.client.workflow.getHandle(`evo:${id}:run_can`).describe()).runId;
  let chain = 0;
  while (runId) {
    chain++;
    const hist = await t.client.workflow.getHandle(`evo:${id}:run_can`, runId).fetchHistory();
    runId = hist.events?.[0]?.workflowExecutionStartedEventAttributes?.continuedExecutionRunId || undefined;
  }
  assert.equal(chain, 3, "continued as new twice");
  const { run } = indexOf(t.db, id, "run_can");
  assert.equal(run?.status, "completed");
  assert.equal(t.db.prepare("SELECT count(*) AS c FROM engine_runs WHERE workflow_id = ?").get(id)?.c, 1, "one index row for the whole chain");
});

test("parallel: branches run side by side and their last outputs join; the steps of all branches are visible after", async () => {
  reset();
  t.apps.on["knowledge.recall"] = (i) => ({ q: (i as { query: string }).query });
  t.apps.on["kanban.projects_list"] = () => ({ projects: [] });
  const id = install(
    [
      {
        id: "par",
        type: "parallel",
        branches: { left: [rd("l1", { input: { query: "L" } })], right: [{ id: "r1", type: "app", product: "kanban", op: "projects_list", input: {} }, { id: "r2", type: "transform", template: "right done" }] },
      },
      { id: "join", type: "transform", template: "{{ $steps.l1.output.q }} + {{ $steps.r2.output }}" },
    ],
    { outputs: { par: "$steps.par.output", joined: "$steps.join.output" } },
  );
  const res = await t.run({ workflowId: id });
  assert.deepEqual(res.outputs, { par: { left: { q: "L" }, right: "right done" }, joined: "L + right done" });
});

test("parallel: a failing branch fails the run with its error", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => {
    throw new TbError("forbidden", "no", 403);
  };
  t.apps.on["kanban.projects_list"] = () => ({ projects: [] });
  const id = install([{ id: "par", type: "parallel", branches: { a: [read("bad")], b: [{ id: "good", type: "app", product: "kanban", op: "projects_list", input: {} }] } }]);
  const f = await failure(t.run({ workflowId: id, runId: "run_pf" }));
  assert.equal(f.code, "forbidden");
  assert.match(f.message, /^bad: /);
  const { run } = indexOf(t.db, id, "run_pf");
  assert.deepEqual([run?.status, run?.error_code, run?.error_step], ["failed", "forbidden", "bad"]);
});

test("timer: the wait is skipped by the time-skipping server and the clock moves on", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({});
  const id = install([read("before"), { id: "nap", type: "timer", seconds: 3600 }, read("after")], { limits: { maxRunMinutes: 120 }, outputs: { waited: "$steps.nap.output.waitedSec" } });
  const t0 = await t.env.currentTimeMs();
  const wall = Date.now();
  const res = await t.run({ workflowId: id });
  const t1 = await t.env.currentTimeMs();
  assert.deepEqual(res.outputs, { waited: 3600 });
  assert.ok(t1 - t0 >= 3_600_000, `the test clock moved at least one hour (${t1 - t0} ms)`);
  assert.ok(Date.now() - wall < 30_000, "and the test did not wait for it");
  assert.equal(calls("knowledge", "recall"), 2);
});

test("timer until a date from a ref; a bad date fails the step; maxRunMinutes stops a run that waits too long", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({});
  const inputs = { type: "object", properties: { at: { type: "string" } } };
  const id = install([{ id: "nap", type: "timer", until: "$trigger.input.at" }, read("after")], { inputs, limits: { maxRunMinutes: 600 } });
  const at = new Date((await t.env.currentTimeMs()) + 2 * 3600_000).toISOString();
  assert.equal((await t.run({ workflowId: id, trigger: { kind: "manual", input: { at } } })).status, "completed");
  const f = await failure(t.run({ workflowId: id, trigger: { kind: "manual", input: { at: "tomorrow-ish" } } }));
  assert.equal(f.code, "timer_until_invalid");
  const slow = install([{ id: "nap", type: "timer", seconds: 7200 }, read("after")], { limits: { maxRunMinutes: 30 } });
  const g = await failure(t.run({ workflowId: slow, runId: "run_slow" }));
  assert.equal(g.code, "run_timeout");
  assert.equal(indexOf(t.db, slow, "run_slow").run?.status, "timed_out");
});

test("app step retry: a transient failure is retried with the SAME idempotency key; a refusal is not retried", async () => {
  reset();
  t.apps.on["kanban.issue_create"] = (_i, nth) => {
    if (nth < 3) throw new TbError("unavailable", "try later", 503);
    return { issue: { id: "iss_9" } };
  };
  const id = install([write("make", { retry: { max: 4, backoffSec: 1 } })]);
  const res = await t.run({ workflowId: id, runId: "run_retry" });
  assert.equal(res.status, "completed");
  assert.equal(calls("kanban", "issue_create"), 3);
  assert.deepEqual(new Set(keys("kanban", "issue_create")), new Set([`wfrun:${id}:run_retry:make`]), "one key for all attempts");
  assert.equal(indexOf(t.db, id, "run_retry").steps[0]?.attempts, 3);

  reset();
  t.apps.on["kanban.issue_create"] = () => {
    throw new TbError("validation_failed", "bad title", 422);
  };
  const id2 = install([write("make", { retry: { max: 5 } })]);
  const f = await failure(t.run({ workflowId: id2, runId: "run_refused" }));
  assert.equal(f.code, "validation_failed");
  assert.equal(calls("kanban", "issue_create"), 1, "a 422 is not retried");
  const s = indexOf(t.db, id2, "run_refused").steps[0];
  assert.deepEqual([s?.status, s?.error_code], ["failed", "validation_failed"]);

  reset();
  t.apps.on["kanban.issue_create"] = () => {
    throw new TbError("unavailable", "again", 503);
  };
  const id3 = install([write("make", { retry: { max: 2, backoffSec: 1 } })]);
  const g = await failure(t.run({ workflowId: id3, runId: "run_giveup" }));
  assert.equal(g.code, "unavailable");
  assert.equal(calls("kanban", "issue_create"), 2, "retry.max is the number of attempts in total");
});

test("an op without idempotency is never retried (the contract needs onFail ask for it)", async () => {
  reset();
  injectCatalog({ ...bundledCatalog(), kanban: { id: "kanban", version: "t", operations: [{ id: "zap", audience: "agent", crud: ["update"], effect: "write", idempotency: "none", input: { type: "object", additionalProperties: false } }] } });
  t.apps.on["kanban.zap"] = () => {
    throw new TbError("unavailable", "again", 503);
  };
  const id = install([{ id: "z", type: "app", product: "kanban", op: "zap", input: {}, onFail: "ask", retry: { max: 5, backoffSec: 1 } }]);
  const f = await failure(t.run({ workflowId: id, runId: "run_zap" }));
  assert.equal(f.code, "unavailable");
  assert.equal(calls("kanban", "zap"), 1, "one attempt, whatever retry says");
  injectCatalog(null);
});

test("not_in_workflow: the engine refuses an op (or a tool) that is not in the ACTIVATED list, before callApp", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({});
  t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "x" } });
  const id = install([read("fine"), write("sneaky")]);
  // the owner activated a list that does not contain kanban.issue_create
  const list = store.getActivation(t.db, id, 1)?.uses.filter((u) => u.op !== "issue_create") ?? [];
  store.activate(t.db, id, 1, list, Date.now());
  const f = await failure(t.run({ workflowId: id, runId: "run_narrow" }));
  assert.equal(f.code, "not_in_workflow");
  assert.match(f.message, /kanban\.issue_create is not in the activated list/);
  assert.equal(calls("kanban", "issue_create"), 0, "callApp was never reached");
  assert.equal(calls("knowledge", "recall"), 1, "the allowed step ran");
  const s = indexOf(t.db, id, "run_narrow").steps.find((x) => x.step_id === "sneaky");
  assert.deepEqual([s?.status, s?.error_code], ["failed", "not_in_workflow"]);

  // a dynamic op is narrowed by tool name too
  reset();
  t.apps.on["connect.tools"] = () => ({ result: {} });
  const id2 = install([{ id: "d", type: "app", product: "connect", op: "tools", input: { tool: "gmail_fetch_emails", arguments: {} } }]);
  const uses = store.getActivation(t.db, id2, 1)?.uses ?? [];
  store.activate(t.db, id2, 1, uses.map((u) => ({ ...u, tools: ["gmail_create_email_draft"] })), Date.now());
  const g = await failure(t.run({ workflowId: id2 }));
  assert.equal(g.code, "not_in_workflow");
  assert.match(g.message, /gmail_fetch_emails/);
  assert.equal(calls("connect", "tools"), 0);
});

test("a deactivated workflow cannot start, and a run in flight fails at its next call; a version that was never activated cannot run", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({});
  const id = install([read("a")]);
  store.deactivate(t.db, id, Date.now());
  const f = await failure(t.run({ workflowId: id }));
  assert.equal(f.code, "not_activated");
  const g = await failure(t.run({ workflowId: "never-installed", version: 1 }));
  assert.equal(g.code, "not_found");
  const h = await failure(t.run({ workflowId: "never-installed" }));
  assert.equal(h.code, "not_activated");
  assert.equal(calls("knowledge", "recall"), 0);
});

test("a held answer is recorded as waiting_hold and onFail decides (M1 does not wait)", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({});
  t.apps.held["kanban.issue_create"] = "hld_01";
  const stop = install([read("before"), write("send")]);
  const f = await failure(t.run({ workflowId: stop, runId: "run_hold" }));
  assert.equal(f.code, "held");
  const s = indexOf(t.db, stop, "run_hold").steps.find((x) => x.step_id === "send");
  assert.deepEqual([s?.status, s?.hold_id], ["waiting_hold", "hld_01"]);
  assert.ok(Number(s?.hold_started_at) > 0);
  assert.equal(indexOf(t.db, stop, "run_hold").run?.held_waits, 1);
  assert.equal(indexOf(t.db, stop, "run_hold").run?.status, "failed");
  const cont = install([write("send", { onFail: "continue" }), read("after")], { outputs: { sent: "$steps.send.output" } });
  const ok = await t.run({ workflowId: cont });
  assert.equal(ok.status, "completed");
  assert.equal(ok.outputs.sent, null, "a skipped step has a null output");
  delete t.apps.held["kanban.issue_create"];
});

test("onFail continue keeps the run going with a null output; the step is recorded as failed", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => {
    throw new TbError("forbidden", "no", 403);
  };
  t.apps.on["kanban.projects_list"] = () => ({ projects: [] });
  const id = install([read("bad", { onFail: "continue" }), { id: "p", type: "app", product: "kanban", op: "projects_list", input: {} }], { outputs: { bad: "$steps.bad.output" } });
  const res = await t.run({ workflowId: id, runId: "run_cont" });
  assert.equal(res.status, "completed");
  assert.equal(res.outputs.bad, null);
  const { run, steps } = indexOf(t.db, id, "run_cont");
  assert.deepEqual([run?.status, run?.steps_done, run?.steps_failed], ["completed", 1, 1]);
  assert.equal(steps.find((s) => s.step_id === "bad")?.status, "failed");
});

const SUMMARY = { type: "object", required: ["bullets"], additionalProperties: false, properties: { bullets: { type: "array", items: { type: "string" } } } };

test("ai step with a model role: not_implemented in M1 (onFail handles it); with a port it runs and the output is validated", async () => {
  reset();
  const id = install([{ id: "m", type: "ai", by: { role: "summarize" }, instruction: "Summarize {{ $trigger.date }}", inputs: {}, outputSchema: SUMMARY }]);
  // the harness default of this file has no model port: the activity's default says not_implemented
  const f = await failure(t.run({ workflowId: id, runId: "run_role" }));
  assert.equal(f.code, "not_implemented");
  assert.equal(indexOf(t.db, id, "run_role").steps[0]?.error_code, "not_implemented");
  const soft = install([{ id: "m", type: "ai", by: { role: "summarize" }, instruction: "x", outputSchema: SUMMARY, onFail: "continue" }, { id: "after", type: "transform", template: "went on" }], { outputs: { a: "$steps.after.output" } });
  assert.equal((await t.run({ workflowId: soft })).outputs.a, "went on");
});

test("ai step with an agent card: the engine offers it through the port, completes asynchronously, validates the output", async () => {
  reset();
  offers.length = 0;
  const id = install([{ id: "ask", type: "ai", by: { agent: "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85" }, instruction: "Research {{ $trigger.input.company }}", inputs: { company: "$trigger.input.company" }, outputSchema: SUMMARY, timeoutSec: 900, retry: { max: 1 } }], {
    inputs: { type: "object", properties: { company: { type: "string" } } },
    outputs: { bullets: "$steps.ask.output.bullets" },
  });
  const pending = t.run({ workflowId: id, runId: "run_agent", trigger: { kind: "manual", input: { company: "Acme" } } });
  await waitFor(() => offers.length === 1);
  const o = offers[0] as AgentStepOffer;
  assert.deepEqual([o.workflowId, o.version, o.runId, o.stepId, o.agentId, o.instruction, o.inputs, o.timeoutSec, o.heartbeatSec, o.attempt], [id, 1, "run_agent", "ask", "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85", "Research Acme", { company: "Acme" }, 900, 0, 1]);
  assert.deepEqual(o.outputSchema, SUMMARY);
  const waiting = indexOf(t.db, id, "run_agent").steps[0];
  assert.deepEqual([waiting?.status, waiting?.step_run_id, waiting?.agent_id], ["waiting_agent", o.stepRunId, "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85"], "the index shows the wait and the offer");
  assert.match(o.stepRunId, /^stp_[0-9a-f]{32}$/);
  assert.ok(o.taskToken.length > 10, "base64 task token");
  await t.client.activity.complete(Buffer.from(o.taskToken, "base64"), { bullets: ["one", "two"] });
  const res = await pending;
  assert.deepEqual(res.outputs, { bullets: ["one", "two"] });
  assert.equal(indexOf(t.db, id, "run_agent").steps[0]?.status, "completed");

  // an invalid answer is refused by the engine (output_invalid), not handed on
  offers.length = 0;
  const bad = t.run({ workflowId: id, runId: "run_agent_bad", trigger: { kind: "manual", input: { company: "Acme" } } });
  await waitFor(() => offers.length === 1);
  await t.client.activity.complete(Buffer.from((offers[0] as AgentStepOffer).taskToken, "base64"), { bullets: "not a list" });
  const f = await failure(bad);
  assert.equal(f.code, "output_invalid");
});

test("ai step with an agent and no port registered: a clear code, not a hang", async () => {
  const bare = await startEnv();
  try {
    bare.install(wf([{ id: "ask", type: "ai", by: { agent: "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85" }, instruction: "x", outputSchema: SUMMARY }], { id: "no-port" }));
    const f = await failure(bare.run({ workflowId: "no-port" }));
    assert.equal(f.code, "agent_port_unavailable");
  } finally {
    await bare.stop();
  }
});

test("approval steps are M2: they fail with not_implemented (and onFail continue is not offered for them)", async () => {
  const id = install([{ id: "ok", type: "approval", title: "Send {{ $trigger.date }}?", timeoutSec: 3600 }]);
  const f = await failure(t.run({ workflowId: id }));
  assert.equal(f.code, "not_implemented");
});

test("a workflow step runs another workflow as a child (depth 1) and returns its outputs", async () => {
  reset();
  t.apps.on["knowledge.recall"] = (i) => ({ q: (i as { query: string }).query });
  t.install(wf([rd("r", { input: { query: "{{ $trigger.input.q }}" } })], { id: "child-flow", inputs: { type: "object", required: ["q"], properties: { q: { type: "string" } } }, outputs: { got: "$steps.r.output.q" } }));
  const id = install([{ id: "sub", type: "workflow", workflow: "child-flow", input: { q: "from parent" } }], { outputs: { child: "$steps.sub.output.got" } });
  const res = await t.run({ workflowId: id, runId: "run_parent" });
  assert.deepEqual(res.outputs, { child: "from parent" });
  assert.equal(indexOf(t.db, "child-flow", "run_parent.sub").run?.status, "completed", "the child run is indexed under the child workflow");
  assert.deepEqual(keys("knowledge", "recall"), ["wfrun:child-flow:run_parent.sub:r"]);
});

test("input that does not fit the workflow inputs is refused before any step; defaults from a manual trigger fill the gaps", async () => {
  reset();
  t.apps.on["knowledge.recall"] = (i) => ({ q: (i as { query: string }).query });
  const id = install([rd("r", { input: { query: "{{ $input.q }}/{{ $input.mode }}" } })], {
    inputs: { type: "object", required: ["q"], additionalProperties: false, properties: { q: { type: "string" }, mode: { type: "string" } } },
    triggers: [{ kind: "manual", inputs: { mode: "fast" } }],
    outputs: { q: "$steps.r.output.q" },
  });
  const f = await failure(t.run({ workflowId: id, trigger: { kind: "manual", input: { q: 5 } } }));
  assert.equal(f.code, "input_invalid");
  assert.equal(calls("knowledge", "recall"), 0);
  const ok = await t.run({ workflowId: id, trigger: { kind: "manual", input: { q: "hi" } } });
  assert.equal(ok.outputs.q, "hi/fast");
});

test("poll trigger: an unchanged cursor ends the run early with no index row; a changed one runs with $trigger.item", async () => {
  reset();
  injectCatalog(null);
  const id = install([{ id: "t", type: "transform", template: "{{ $trigger.item.result.n }}" }], {
    triggers: [{ kind: "poll", product: "knowledge", op: "recall", input: { query: "inbox" }, cursorPath: "/cursor", every: "5m" }],
    outputs: { n: "$steps.t.output" },
  });
  const sid = "sch_poll1";
  t.db
    .prepare("INSERT INTO engine_schedules (id, workflow_id, kind, spec, input, poll, paused, revision, created_at, updated_at) VALUES (?, ?, 'poll', ?, '{}', ?, 0, 1, 1, 1)")
    .run(sid, id, JSON.stringify({ every: "5m", timezone: "UTC" }), JSON.stringify({ product: "knowledge", op: "recall", input: { query: "inbox" }, cursorPath: "/cursor" }));
  let cursor = "h1";
  t.apps.on["knowledge.recall"] = () => ({ cursor, result: { n: "seven" } });
  const trigger = { kind: "poll" as const, scheduleId: sid, timezone: "UTC", input: {} };
  const first = await t.run({ workflowId: id, runId: "", trigger });
  assert.equal(first.status, "completed", "the first poll sees a cursor and runs");
  assert.deepEqual(first.outputs, { n: "seven" });
  assert.equal(store.getSchedule(t.db, sid)?.cursor, "h1", "the cursor moved with the run");
  const second = await t.run({ workflowId: id, runId: "run_poll2", trigger });
  assert.equal(second.status, "skipped");
  assert.equal(second.reason, "no_change");
  assert.equal(indexOf(t.db, id, "run_poll2").run, undefined, "an early stop leaves no run row");
  cursor = "h2";
  const third = await t.run({ workflowId: id, runId: "run_poll3", trigger });
  assert.equal(third.status, "completed");
  assert.equal(store.getSchedule(t.db, sid)?.cursor, "h2");
  assert.equal(t.db.prepare("SELECT count(*) AS c FROM engine_runs WHERE workflow_id = ?").get(id)?.c, 2);
});

test("a step whose output is bigger than the engine keeps fails with output_too_large (the answer is not stored in Temporal history)", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({ blob: "x".repeat(1_600_000) });
  const id = install([read("big")]);
  const f = await failure(t.run({ workflowId: id }));
  assert.equal(f.code, "output_too_large");
});

async function waitFor(cond: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) assert.fail("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}
void ({} as Json);
