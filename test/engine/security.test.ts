// biome-ignore-all lint/suspicious/noThenProperty: a condition step of the workflow contract has a `then` field
// Fixes of the M1 security review (F2 to F5), each with a fire-on-bad test: size cap, superseded versions, activation checks in
// every step kind, child run ids.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { WorkflowFailedError } from "@temporalio/client";
import type { AgentStepOffer } from "../../src/engine/agent-port.ts";
import * as store from "../../src/engine/engine-store.ts";
import { executionCeilingMs } from "../../src/engine/run-types.ts";
import { scheduleAction } from "../../src/engine/schedules.ts";
import { assertPayloadSize, childRunId, MAX_PAYLOAD_BYTES } from "../../src/engine/workflow.ts";
import { within } from "../poll.ts";
import { type Env, indexOf, read, startEnv, waitFor, wf, write } from "./harness.ts";

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
  await t.stop();
});
const rd = (id: string, extra: Record<string, unknown> = {}) => read(id, { outputSchema: { type: "object" }, ...extra });
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
function reset(): void {
  t.apps.calls.length = 0;
  offers.length = 0;
  for (const k of Object.keys(t.apps.on)) delete t.apps.on[k];
}
const agentStep = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "ai", by: { agent: "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85" }, instruction: "do", inputs: {}, outputSchema: { type: "object" }, timeoutSec: 600, ...extra });

// ───────────────────────────── F2: size cap and ceiling ─────────────────────────────

test("F2: a value the interpreter composes over 1.5 MB fails the STEP (input_too_large); the run ends, it does not wedge", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({ text: "x".repeat(1_400_000) });
  t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "i" } });
  t.install(wf([rd("a"), { id: "big", type: "transform", template: "{{ $steps.a.output.text }}{{ $steps.a.output.text }}{{ $steps.a.output.text }}" }, write("w", { input: { title: "t", summary: "$steps.big.output" } })], { id: "big-flow" }));
  const f = await within(60_000, "the run wedged (no end within 60 s)", failure(t.run({ workflowId: "big-flow", runId: "run_big" })));
  assert.equal(f.code, "input_too_large");
  assert.equal(t.apps.calls.filter((c) => c.op === "issue_create").length, 0, "nothing was sent");
  assert.equal(indexOf(t.db, "big-flow", "run_big").run?.status, "failed");
  // the same for an ai step, an approval question, a child input
  t.install(wf([rd("a"), { id: "m", type: "ai", by: { role: "utility" }, instruction: "x", inputs: { v: "$steps.a.output.text", w: "$steps.a.output.text" }, outputSchema: { type: "object" } }], { id: "big-ai" }));
  assert.equal((await failure(t.run({ workflowId: "big-ai" }))).code, "input_too_large");
  assert.doesNotThrow(() => assertPayloadSize({ s: "x".repeat(1000) }, "v", "s"));
  assert.throws(() => assertPayloadSize({ s: "x".repeat(MAX_PAYLOAD_BYTES) }, "v", "s"), /input_too_large|bytes/);
});

test("F2: the state a loop carries over a continue-as-new is capped too", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({ text: "x".repeat(700_000) });
  t.install(wf([{ id: "lp", type: "loop", forEach: "$trigger.input.xs", max: 10, steps: [rd("one")] }], { id: "big-can", inputs: { type: "object", properties: { xs: { type: "array" } } } }));
  const f = await failure(t.run({ workflowId: "big-can", canEvery: 2, trigger: { kind: "manual", input: { xs: [1, 2, 3, 4, 5] } } }));
  assert.equal(f.code, "input_too_large");
});

test("F2: a run gets a hard Temporal ceiling (maxRunMinutes + 30 days for the owner's waits), in the Schedule action and in startRun", async () => {
  assert.equal(executionCeilingMs(undefined), (60 + 43_200) * 60_000);
  assert.equal(executionCeilingMs(5), (5 + 43_200) * 60_000);
  const row = { id: "sch_x", workflowId: "wf-x", versionPin: null, kind: "schedule", spec: { cron: "0 8 * * *", timezone: "UTC" }, input: {} } as unknown as store.ScheduleRow;
  assert.equal((scheduleAction(row, executionCeilingMs(30)) as { workflowExecutionTimeout?: number }).workflowExecutionTimeout, executionCeilingMs(30));
  t.apps.on["knowledge.recall"] = () => ({});
  t.install(wf([rd("a")], { id: "ceiling-flow", limits: { maxRunMinutes: 30 } }));
  const { startRun } = await import("../../src/engine/start-run.ts");
  const s = await startRun({ workflowId: "ceiling-flow", runId: "run_ceil", maxRunMinutes: 30 });
  const d = await t.client.workflow.getHandle(s.temporalWorkflowId).describe();
  assert.equal(d.raw.executionConfig?.workflowExecutionTimeout?.seconds?.toString(), String((30 + 43_200) * 60));
  await t.client.workflow.getHandle(s.temporalWorkflowId).result();
});

test("F2: time the owner takes (an approval) is not run time: a wait longer than maxRunMinutes does not fail the next step", async () => {
  reset();
  t.apps.on["inbox.inbox_ask"] = () => ({ itemId: "itm_1", status: "open", expiresAt: "9999-12-31T00:00:00Z" });
  let polls = 0;
  t.apps.on["inbox.inbox_status"] = () => ({ status: ++polls < 12 ? "open" : "answered", response: polls < 12 ? null : "approve", message: null });
  t.apps.on["knowledge.recall"] = () => ({});
  t.install(wf([{ id: "ok", type: "approval", title: "go?", timeoutSec: 86400 }, rd("after")], { id: "owner-wait", limits: { maxRunMinutes: 5 } }));
  const res = await t.run({ workflowId: "owner-wait" });
  assert.equal(res.status, "completed", "30+60+120+240+300*7 s of waiting is far above 5 minutes of run time");
});

// ───────────────────────────── F3: superseded versions ─────────────────────────────

test("F3: a superseded version starts NO new run (manual, explicit version); the active one does", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({});
  t.install(wf([rd("r")], { id: "sup-flow", version: 1 }));
  t.install(wf([rd("r"), rd("r2")], { id: "sup-flow", version: 2 }));
  assert.deepEqual([store.getActivation(t.db, "sup-flow", 1)?.state, store.getActivation(t.db, "sup-flow", 2)?.state], ["superseded", "active"]);
  assert.equal((await failure(t.run({ workflowId: "sup-flow", version: 1 }))).code, "version_not_active");
  assert.equal(t.apps.calls.length, 0);
  const ok = await t.run({ workflowId: "sup-flow", version: 2 });
  assert.equal(ok.version, 2);
  assert.equal((await t.run({ workflowId: "sup-flow" })).version, 2);
});

test("F3: a run in flight on the old version FINISHES, and each of its app steps is checked against that version's own list", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({});
  t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "i" } });
  // v1: agent step (pending), then a read; v2 drops the read
  t.install(wf([agentStep("ask"), rd("after")], { id: "inflight", version: 1 }));
  const p = t.run({ workflowId: "inflight", runId: "run_old" });
  await waitFor("run_old: the agent step is offered", () => offers.length === 1);
  t.install(wf([agentStep("ask"), write("other")], { id: "inflight", version: 2 }));
  assert.equal(store.getActivation(t.db, "inflight", 1)?.state, "superseded");
  await t.client.activity.complete(Buffer.from((offers[0] as AgentStepOffer).taskToken, "base64"), {});
  const res = await p;
  assert.equal(res.status, "completed");
  assert.equal(res.version, 1, "it finished on the version it started on");
  assert.deepEqual(t.apps.calls.map((c) => c.op), ["recall"], "v1's own op ran; v2's issue_create did not");
  // and an op that is NOT in v1's own list is still refused for the run of v1
  reset();
  t.install(wf([agentStep("ask"), rd("after")], { id: "inflight2", version: 1 }));
  const q = t.run({ workflowId: "inflight2", runId: "run_old2" });
  await waitFor("run_old2: the agent step is offered", () => offers.length === 1);
  t.install(wf([agentStep("ask"), rd("after")], { id: "inflight2", version: 2 }));
  store.activate(t.db, "inflight2", 1, [], Date.now()); // the list of v1 narrowed behind the run's back: superseded stays, but its list is empty
  store.activate(t.db, "inflight2", 2, store.getActivation(t.db, "inflight2", 2)?.uses ?? [], Date.now()); // v2 active again
  await t.client.activity.complete(Buffer.from((offers[0] as AgentStepOffer).taskToken, "base64"), {});
  assert.equal((await failure(q)).code, "not_in_workflow");
});

// ───────────────────────────── F4: activation in every step kind ─────────────────────────────

test("F4: deactivated mid-run: an agent step is not offered, a model step is not called, an approval is not asked", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => {
    store.deactivate(t.db, "deact-flow", Date.now());
    return { secret: "other app data" };
  };
  t.install(wf([rd("r"), agentStep("ask", { inputs: { d: "$steps.r.output" } })], { id: "deact-flow" }));
  const f = await failure(t.run({ workflowId: "deact-flow", runId: "run_deact" }));
  assert.equal(f.code, "not_activated");
  assert.equal(offers.length, 0, "the data of the earlier step was not offered to the agent");
  // model step and approval step
  for (const [id, step] of [["deact-ai", { id: "m", type: "ai", by: { role: "utility" }, instruction: "x", outputSchema: { type: "object" } }], ["deact-appr", { id: "a", type: "approval", title: "go?" }]] as const) {
    t.apps.calls.length = 0;
    t.apps.on["knowledge.recall"] = () => {
      store.deactivate(t.db, id, Date.now());
      return {};
    };
    t.install(wf([rd("r"), step], { id }));
    assert.equal((await failure(t.run({ workflowId: id }))).code, "not_activated", id);
    assert.equal(t.apps.calls.filter((c) => c.product === "inbox").length, 0, "Inbox was not asked");
  }
});

test("F4: a workflow step: the child must be ACTIVE; the parent still activated; activation lists the child's ops (via) and refuses a child that is not active", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({});
  t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "i" } });
  const { engineHandlers } = await import("../../src/engine/ops.ts");
  const { manifest } = await import("../../src/app.ts");
  const { call, ctxFor, OWNER } = await import("../helpers.ts");
  const H = engineHandlers(manifest as never) as unknown as Parameters<typeof call>[0];
  const op = <O>(id: string, input: unknown): Promise<O> => call<O>(H, id, input, ctxFor(t.db, OWNER));
  const child = wf([write("make")], { id: "kid-flow" });
  const parent = wf([{ id: "sub", type: "workflow", workflow: "kid-flow" }], { id: "dad-flow" });
  await op("workflow_contract_save", { contract: child });
  await op("workflow_contract_save", { contract: parent });
  await assert.rejects(op("workflow_activate", { workflowId: "dad-flow", version: 1 }), (e: unknown) => e instanceof TbError && e.code === "child_not_active" && e.httpStatus === 409);
  await op("workflow_activate", { workflowId: "kid-flow", version: 1 });
  const a = await op<{ ops: { product: string; op: string; via?: string[] }[]; usage: { via?: string[] }[] }>("workflow_activate", { workflowId: "dad-flow", version: 1 });
  assert.deepEqual(a.ops.map((o) => [o.product, o.op, o.via]), [["kanban", "issue_create", ["kid-flow"]]]);
  assert.deepEqual(a.usage[0]?.via, ["kid-flow"]);
  // the parent runs the child; the child's op runs under the CHILD's own activation
  const ok = await t.run({ workflowId: "dad-flow" });
  assert.equal(ok.status, "completed");
  // the parent's own steps may NOT use an op that is listed only because a child calls it
  t.install(wf([write("direct"), { id: "sub", type: "workflow", workflow: "kid-flow" }], { id: "sneaky-flow" }));
  const uses = (store.getActivation(t.db, "sneaky-flow", 1)?.uses ?? []).filter((u) => u.op !== "issue_create");
  store.activate(t.db, "sneaky-flow", 1, [...uses, { product: "kanban", op: "issue_create", crud: ["create"], effect: "write", idempotency: "required", steps: ["sub"], via: ["kid-flow"] }], Date.now());
  assert.equal((await failure(t.run({ workflowId: "sneaky-flow" }))).code, "not_in_workflow");
  // the child is deactivated / superseded after the parent was activated: the step refuses
  store.deactivate(t.db, "kid-flow", Date.now());
  assert.equal((await failure(t.run({ workflowId: "dad-flow" }))).code, "child_not_active");
  // a child superseded by a new version also refuses an explicit pin on the old one
  t.install(wf([write("make")], { id: "kid2", version: 1 }));
  t.install(wf([write("make")], { id: "kid2", version: 2 }));
  t.install(wf([{ id: "sub", type: "workflow", workflow: "kid2", version: 1 }], { id: "dad2" }));
  assert.equal((await failure(t.run({ workflowId: "dad2" }))).code, "child_not_active");
});

// ───────────────────────────── F5: child run ids ─────────────────────────────

test("F5: childRunId stays unique per step and loop iteration when it is cut (60 characters), and keeps short ids readable", () => {
  assert.equal(childRunId("run_a", "sub"), "run_a.sub");
  const run = "sch_01abcdefghij-20261026T080000Z";
  const ids = new Set<string>();
  for (let i = 0; i < 300; i++) ids.add(childRunId(run, `send-welcome-email-to-the-user-x#${i}`));
  assert.equal(ids.size, 300);
  for (const id of ids) assert.ok(id.length <= 60, id);
  assert.notEqual(childRunId(run, "a-step-with-a-long-id-aaaaaaaaaaaaaa#1.10"), childRunId(run, "a-step-with-a-long-id-aaaaaaaaaaaaaa#11.0"));
});

test("F5: a child workflow step in a loop with a long step id and a long run id: every iteration gets its own run and its own idempotency key", async () => {
  reset();
  t.apps.on["kanban.issue_create"] = (i) => ({ issue: { id: `iss_${(i as { title: string }).title}` } });
  t.install(wf([write("w", { input: { title: "n-{{ $trigger.input.n }}" } })], { id: "kid3-flow", inputs: { type: "object", properties: { n: { type: "integer" } } }, outputs: { got: "$steps.w.output.issue.id" } }));
  t.install(
    wf(
      [
        { id: "lst", type: "transform", pick: { items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } },
        { id: "loop", type: "loop", forEach: "$steps.lst.output.items", max: 20, steps: [{ id: "send-welcome-email-to-the-user-x", type: "workflow", workflow: "kid3-flow", input: { n: "$loop.item" } }] },
      ],
      { id: "parent3-flow", outputs: { all: "$steps.loop.output.items" } },
    ),
  );
  const res = await t.run({ workflowId: "parent3-flow", runId: "sch_01abcdefghij-20261026T080000Z" });
  assert.equal(t.apps.calls.length, 12, "twelve child runs, twelve calls");
  assert.equal(new Set(t.apps.calls.map((c) => c.key)).size, 12, "twelve different keys");
  assert.equal(new Set(t.apps.calls.map((c) => JSON.stringify(c.input))).size, 12);
  assert.deepEqual((res.outputs.all as { got: string }[]).map((x) => x.got), Array.from({ length: 12 }, (_, i) => `iss_n-${i + 1}`));
});
