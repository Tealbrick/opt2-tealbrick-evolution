// M2 on a Temporal test server: model-role steps (tokens, budget, no role), the call context behind the cap app_call_context,
// the owner op workflow_run_now, and the step inputs/outputs read from the Temporal history for the owner's run detail.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { WorkflowFailedError } from "@temporalio/client";
import { manifest } from "../../src/app.ts";
import type { ModelPort, ModelRequest } from "../../src/engine/agent-port.ts";
import { IO_CAP_BYTES, stepIoFromEvents } from "../../src/engine/history.ts";
import { ModelError } from "../../src/engine/models.ts";
import { engineHandlers } from "../../src/engine/ops.ts";
import { setTemporalClientForTests } from "../../src/engine/temporal.ts";
import { call, ctxFor, OWNER } from "../helpers.ts";
import { type Env, indexOf, read, startEnv, wf, write } from "./harness.ts";

const SUMMARY = { type: "object", required: ["bullets"], additionalProperties: false, properties: { bullets: { type: "array", items: { type: "string" } } } };
const modelCalls: ModelRequest[] = [];
let modelBehavior: (req: ModelRequest, n: number) => { output: unknown; tokensIn?: number; tokensOut?: number } = () => ({ output: { bullets: ["ok"] }, tokensIn: 100, tokensOut: 20 });
const models: ModelPort = {
  async run(req) {
    modelCalls.push(req);
    return modelBehavior(req, modelCalls.length) as never;
  },
};

let t: Env;
before(async () => {
  t = await startEnv({ models });
});
after(async () => {
  await t.stop();
});

let n = 0;
function install(steps: unknown[], extra: Record<string, unknown> = {}): string {
  const id = `m2-flow-${++n}`;
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
const ai = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, type: "ai", by: { role }, instruction: "Do {{ $trigger.date }}", inputs: { x: "$trigger.input.x" }, outputSchema: SUMMARY, ...extra });
const INPUTS = { type: "object", properties: { x: { type: "string" } } };

test("ai role: temperature/limits are the port's; the request carries the role, the rendered instruction, the inputs, the schema; tokens land in engine_steps and engine_runs", async () => {
  modelCalls.length = 0;
  modelBehavior = () => ({ output: { bullets: ["a", "b"] }, tokensIn: 120, tokensOut: 30 });
  const id = install([ai("m", "summarize", { maxTokens: 900, timeoutSec: 45 })], { inputs: INPUTS, outputs: { b: "$steps.m.output.bullets" } });
  const res = await t.run({ workflowId: id, runId: "run_m1", trigger: { kind: "manual", input: { x: "hello" } } });
  assert.deepEqual(res.outputs, { b: ["a", "b"] });
  const q = modelCalls[0] as ModelRequest;
  assert.deepEqual([q.role, q.maxTokens, q.timeoutSec, q.inputs], ["summarize", 900, 45, { x: "hello" }]);
  assert.match(q.instruction, /^Do \d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(q.outputSchema, SUMMARY);
  const { run, steps } = indexOf(t.db, id, "run_m1");
  assert.deepEqual([steps[0]?.tokens_in, steps[0]?.tokens_out, run?.model_tokens], [120, 30, 150]);
});

test("ai role: maxTokens defaults to 4000 and never goes above it", async () => {
  modelCalls.length = 0;
  const id = install([ai("m", "utility")], { inputs: INPUTS });
  await t.run({ workflowId: id, trigger: { kind: "manual", input: { x: "1" } } });
  assert.equal(modelCalls[0]?.maxTokens, 4000);
});

test("ai role: no role bound / no cap ends the step with model_role_unavailable and onFail decides (stop, continue)", async () => {
  modelBehavior = () => {
    throw new ModelError("model_role_unavailable", "No model is bound to the role summarize.");
  };
  const stop = install([ai("m", "summarize")], { inputs: INPUTS });
  const f = await failure(t.run({ workflowId: stop, runId: "run_nr", trigger: { kind: "manual", input: { x: "1" } } }));
  assert.equal(f.code, "model_role_unavailable");
  assert.equal(indexOf(t.db, stop, "run_nr").steps[0]?.error_code, "model_role_unavailable");
  const soft = install([ai("m", "summarize", { onFail: "continue" }), { id: "after", type: "transform", template: "went on" }], { inputs: INPUTS, outputs: { a: "$steps.after.output" } });
  assert.equal((await t.run({ workflowId: soft, trigger: { kind: "manual", input: { x: "1" } } })).outputs.a, "went on");
  modelBehavior = () => ({ output: { bullets: ["ok"] }, tokensIn: 100, tokensOut: 20 });
});

test("ai role: a transient provider failure is retried (retry.max attempts), a permanent one is not; output_invalid is not retried", async () => {
  modelCalls.length = 0;
  modelBehavior = (_r, k) => {
    if (k < 3) throw new ModelError("model_unavailable", "busy", true);
    return { output: { bullets: ["fine"] }, tokensIn: 1, tokensOut: 1 };
  };
  const a = install([ai("m", "reasoning", { retry: { max: 4, backoffSec: 1 } })], { inputs: INPUTS });
  assert.equal((await t.run({ workflowId: a, runId: "run_rt", trigger: { kind: "manual", input: { x: "1" } } })).status, "completed");
  assert.equal(modelCalls.length, 3);
  assert.equal(indexOf(t.db, a, "run_rt").steps[0]?.attempts, 3);
  modelCalls.length = 0;
  modelBehavior = () => {
    throw new ModelError("output_invalid", "bad twice");
  };
  const b = install([ai("m", "reasoning", { retry: { max: 4, backoffSec: 1 } })], { inputs: INPUTS });
  assert.equal((await failure(t.run({ workflowId: b, trigger: { kind: "manual", input: { x: "1" } } }))).code, "output_invalid");
  assert.equal(modelCalls.length, 1);
  modelBehavior = () => ({ output: { bullets: ["ok"] }, tokensIn: 100, tokensOut: 20 });
});

test("ai role: the engine validates the answer again; limits.maxModelTokens stops the NEXT model step (model_token_budget)", async () => {
  modelCalls.length = 0;
  modelBehavior = () => ({ output: { bullets: 5 }, tokensIn: 1, tokensOut: 1 });
  const bad = install([ai("m", "summarize")], { inputs: INPUTS });
  assert.equal((await failure(t.run({ workflowId: bad, trigger: { kind: "manual", input: { x: "1" } } }))).code, "output_invalid");
  modelBehavior = () => ({ output: { bullets: ["ok"] }, tokensIn: 600, tokensOut: 500 });
  const id = install([ai("one", "summarize"), ai("two", "summarize")], { inputs: INPUTS, limits: { maxModelTokens: 1000 } });
  modelCalls.length = 0;
  const f = await failure(t.run({ workflowId: id, runId: "run_budget", trigger: { kind: "manual", input: { x: "1" } } }));
  assert.equal(f.code, "model_token_budget");
  assert.equal(modelCalls.length, 1, "the second model call never happened");
  const ok = install([ai("one", "summarize"), ai("two", "summarize")], { inputs: INPUTS, limits: { maxModelTokens: 5000 } });
  assert.equal((await t.run({ workflowId: ok, trigger: { kind: "manual", input: { x: "1" } } })).status, "completed");
  modelBehavior = () => ({ output: { bullets: ["ok"] }, tokensIn: 100, tokensOut: 20 });
});

test("the call context is sent ONLY behind the cap app_call_context; without it the idempotency key alone", async () => {
  t.apps.calls.length = 0;
  t.apps.options.length = 0;
  t.apps.on["knowledge.recall"] = () => ({});
  const id = install([{ id: "lp", type: "loop", forEach: "$trigger.input.xs", max: 3, steps: [read("one")] }], { inputs: { type: "object", properties: { xs: { type: "array" } } } });
  await t.run({ workflowId: id, runId: "run_ctx1", trigger: { kind: "manual", input: { xs: ["a"] } } });
  assert.deepEqual(Object.keys(t.apps.options[0] ?? {}), ["idempotencyKey"], "no cap: key only");
  t.caps.push("app_call_context");
  t.apps.options.length = 0;
  await t.run({ workflowId: id, runId: "run_ctx2", trigger: { kind: "manual", input: { xs: ["a"] } } });
  assert.deepEqual(t.apps.options[0]?.context, { "evolution.workflow": id, "evolution.version": 1, "evolution.run": "run_ctx2", "evolution.step": "one#0" });
  assert.equal(t.apps.options[0]?.idempotencyKey, `wfrun:${id}:run_ctx2:one:0`);
  t.caps.length = 0;
});

// ───────────────────────────── workflow_run_now ─────────────────────────────

const H = engineHandlers(manifest as never) as unknown as Parameters<typeof call>[0];
const op = <O>(idv: string, input: unknown): Promise<O> => call<O>(H, idv, input, ctxFor(t.db, OWNER));

test("workflow_run_now: starts a run of the active version with the inputs; the run id and the Temporal id come back", async () => {
  t.apps.on["knowledge.recall"] = (i) => ({ q: (i as { query: string }).query });
  const id = install([{ ...read("r", { input: { query: "{{ $input.q }}/{{ $input.mode }}" } }), outputSchema: { type: "object" } }], {
    inputs: { type: "object", required: ["q"], additionalProperties: false, properties: { q: { type: "string" }, mode: { type: "string" } } },
    triggers: [{ kind: "manual", inputs: { mode: "fast" } }],
    outputs: { q: "$steps.r.output.q" },
  });
  const r = await op<{ runId: string; workflowId: string; version: number; temporalWorkflowId: string }>("workflow_run_now", { workflowId: id, inputs: { q: "hi" } });
  assert.match(r.runId, /^[0-9A-Z]{26}$/);
  assert.deepEqual([r.workflowId, r.version, r.temporalWorkflowId], [id, 1, `evo:${id}:${r.runId}`]);
  const result = (await t.client.workflow.getHandle(r.temporalWorkflowId).result()) as { outputs: Record<string, string> };
  assert.deepEqual(result.outputs, { q: "hi/fast" }, "the manual trigger's default fills the gap");
  assert.equal(indexOf(t.db, id, r.runId).run?.trigger_kind, "manual");
});

test("workflow_run_now: refused when not activated (409), for inputs that do not fit (422), for another version that is not activated, and while Temporal is down (503)", async () => {
  const id = install([read("a")], { inputs: { type: "object", required: ["q"], additionalProperties: false, properties: { q: { type: "string" } } } });
  const refuses = (p: Promise<unknown>, code: string, status: number) => assert.rejects(p, (e: unknown) => e instanceof TbError && e.code === code && e.httpStatus === status);
  await refuses(op("workflow_run_now", { workflowId: id, inputs: { q: 5 } }), "validation_failed", 422);
  await refuses(op("workflow_run_now", { workflowId: id, inputs: {} }), "validation_failed", 422);
  await refuses(op("workflow_run_now", { workflowId: id, version: 7, inputs: { q: "x" } }), "not_activated", 409);
  await refuses(op("workflow_run_now", { workflowId: "never-installed" }), "not_activated", 409);
  setTemporalClientForTests(null);
  const prev = process.env.TEMPORAL_ADDRESS;
  delete process.env.TEMPORAL_ADDRESS;
  try {
    await refuses(op("workflow_run_now", { workflowId: id, inputs: { q: "x" } }), "temporal_unavailable", 503);
  } finally {
    setTemporalClientForTests(t.env.client);
    if (prev !== undefined) process.env.TEMPORAL_ADDRESS = prev;
  }
  const m = manifest.operations.find((o) => o.id === "workflow_run_now");
  assert.deepEqual([m?.audience, m?.effect, m?.idempotency, m?.crud], ["person", "write", "required", ["create"]]);
});

// ───────────────────────────── step inputs/outputs from the history ─────────────────────────────

test("engine_run_get returns what each step got and gave, read from the Temporal history (never from app.db); the secrets of the index stay out of app.db", async () => {
  t.apps.calls.length = 0;
  t.apps.on["knowledge.recall"] = () => ({ results: [{ title: "SECRET-BODY-777" }] });
  modelBehavior = () => ({ output: { bullets: ["from model"] }, tokensIn: 3, tokensOut: 4 });
  const id = install(
    [
      { ...read("find", { input: { query: "q-{{ $trigger.input.x }}" } }), outputSchema: { type: "object" } },
      ai("sum", "summarize", { inputs: { found: "$steps.find.output.results" } }),
    ],
    { inputs: INPUTS },
  );
  await t.run({ workflowId: id, runId: "run_io", trigger: { kind: "manual", input: { x: "42" } } });
  const got = await op<{ steps: { stepId: string; input?: unknown; output?: unknown }[] }>("engine_run_get", { workflowId: id, runId: "run_io" });
  const find = got.steps.find((s) => s.stepId === "find");
  assert.deepEqual(find?.input, { query: "q-42" });
  assert.deepEqual(find?.output, { results: [{ title: "SECRET-BODY-777" }] });
  const sum = got.steps.find((s) => s.stepId === "sum");
  assert.deepEqual(((sum as { input: { inputs: unknown } }).input).inputs, { found: [{ title: "SECRET-BODY-777" }] });
  assert.deepEqual(sum?.output, { bullets: ["from model"] });
  assert.doesNotMatch(JSON.stringify([...t.db.prepare("SELECT * FROM engine_steps").all(), ...t.db.prepare("SELECT * FROM engine_runs").all()]), /SECRET-BODY-777|q-42/, "app.db keeps sizes only (C88)");
  // person op: an agent cannot reach it
  assert.equal(manifest.operations.find((o) => o.id === "engine_run_get")?.audience, "person");
});

test("engine_run_get with Temporal gone returns the index without inputs/outputs (no error)", async () => {
  const id = install([read("a")]);
  t.apps.on["knowledge.recall"] = () => ({ k: 1 });
  await t.run({ workflowId: id, runId: "run_noio" });
  setTemporalClientForTests(null);
  const prev = process.env.TEMPORAL_ADDRESS;
  delete process.env.TEMPORAL_ADDRESS;
  try {
    const got = await op<{ steps: { input?: unknown; output?: unknown }[] }>("engine_run_get", { runId: "run_noio" });
    assert.equal(got.steps.length, 1);
    assert.equal("input" in (got.steps[0] ?? {}), false);
  } finally {
    setTemporalClientForTests(t.env.client);
    if (prev !== undefined) process.env.TEMPORAL_ADDRESS = prev;
  }
});

test("stepIoFromEvents: a value over the cap is replaced by its size; a failed attempt keeps its message; approvals show title and answer", async () => {
  const payload = (v: unknown) => ({ metadata: { encoding: new TextEncoder().encode("json/plain") }, data: new TextEncoder().encode(JSON.stringify(v)) });
  const sched = (eventId: number, type: string, args: unknown) => ({ eventId, activityTaskScheduledEventAttributes: { activityType: { name: type }, input: { payloads: [payload(args)] } } });
  const done = (scheduledEventId: number, result: unknown) => ({ eventId: scheduledEventId + 100, activityTaskCompletedEventAttributes: { scheduledEventId, result: { payloads: [payload(result)] } } });
  const plain = async (p: { data?: Uint8Array | string | null } | undefined) => (p?.data ? (JSON.parse(Buffer.from(p.data as Uint8Array).toString("utf8")) as never) : undefined);
  const io = await stepIoFromEvents([
    sched(1, "appStep", { stepKey: "big", input: { q: 1 } }),
    done(1, { status: "ok", output: { blob: "x".repeat(IO_CAP_BYTES + 10) } }),
    sched(2, "appStep", { stepKey: "bad", input: { q: 2 } }),
    { eventId: 102, activityTaskFailedEventAttributes: { scheduledEventId: 2, failure: { message: "boom".repeat(200) } } },
    sched(3, "approvalAsk", { stepKey: "review", purpose: "approval", title: "Send?", context: "Draft" }),
    done(3, { itemId: "itm_1", expiresAt: "x" }),
    sched(4, "approvalPoll", { stepKey: "review", purpose: "approval" }),
    done(4, { status: "answered", response: "approve", message: "go" }),
    sched(5, "approvalAsk", { stepKey: "make", purpose: "on_fail", title: "failed", context: "x" }),
    sched(6, "holdCheck", { stepKey: "make" }),
    done(6, { state: "pending" }),
  ], plain);
  assert.deepEqual(io.big?.input, { q: 1 });
  assert.deepEqual(io.big?.output, { truncated: true, bytes: JSON.stringify({ blob: "x".repeat(IO_CAP_BYTES + 10) }).length });
  assert.equal(io.bad?.error?.length, 300);
  assert.deepEqual(io.review, { input: { title: "Send?", context: "Draft" }, output: { response: "approve", message: "go" } });
  assert.equal(io.make, undefined, "the owner question of onFail ask and hold polls are not step data");
});

test("write steps: the history shows the input the engine sent (rendered), not the template", async () => {
  t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "iss_io" } });
  const id = install([write("make", { input: { title: "T-{{ $trigger.input.x }}" } })], { inputs: INPUTS });
  await t.run({ workflowId: id, runId: "run_io2", trigger: { kind: "manual", input: { x: "7" } } });
  const got = await op<{ steps: { input?: unknown; output?: unknown }[] }>("engine_run_get", { runId: "run_io2" });
  assert.deepEqual(got.steps[0]?.input, { title: "T-7" });
  assert.deepEqual(got.steps[0]?.output, { issue: { id: "iss_io" } });
});
