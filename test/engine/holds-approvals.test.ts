// M2: the durable waits. A held app step waits for the owner (tb.hold_status behind the bridge cap app_hold_status, else the
// tb.holds_pending list) and repeats the exact call once with the same key; an approval step asks in Inbox and polls
// inbox_status; onFail "ask" asks the owner whether to retry, skip or stop. The time-skipping server skips the waits.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { WorkflowFailedError } from "@temporalio/client";
import { type Env, indexOf, read, startEnv, wf, write } from "./harness.ts";

let t: Env;
before(async () => {
  t = await startEnv();
});
after(async () => {
  await t.stop();
});

let n = 0;
function install(steps: unknown[], extra: Record<string, unknown> = {}): string {
  const id = `wait-flow-${++n}`;
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
function reset(): void {
  t.apps.calls.length = 0;
  t.apps.options.length = 0;
  for (const k of Object.keys(t.apps.on)) delete t.apps.on[k];
  for (const k of Object.keys(t.apps.held)) delete t.apps.held[k];
  for (const k of Object.keys(t.apps.heldFirst)) delete t.apps.heldFirst[k];
  t.caps.length = 0;
}
const calls = (product: string, op: string) => t.apps.calls.filter((c) => c.product === product && c.op === op);
const nth = <T>(list: T[], i: number): T => list[i] as T;

// ───────────────────────────── held app steps ─────────────────────────────

test("held + cap app_hold_status: waits 30 s, 60 s, 120 s ..., then repeats the SAME call (same input, same key) once", async () => {
  reset();
  t.caps.push("app_hold_status");
  t.apps.heldFirst["kanban.issue_create"] = { holdId: "hld_01", times: 1 };
  t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "iss_7" } });
  let polls = 0;
  t.apps.on["kanban.tb.hold_status"] = () => ({ status: ++polls < 4 ? "held" : "approved", expiresAt: "9999-12-31T00:00:00Z" });
  const id = install([write("send", { input: { title: "Send it" } })], { outputs: { issue: "$steps.send.output.issue.id" } });
  const t0 = await t.env.currentTimeMs();
  const res = await t.run({ workflowId: id, runId: "run_h1" });
  const waited = (await t.env.currentTimeMs()) - t0;
  assert.deepEqual(res.outputs, { issue: "iss_7" });
  assert.equal(calls("kanban", "issue_create").length, 2, "the call and its single repeat");
  assert.deepEqual(nth(calls("kanban", "issue_create"), 0).input, nth(calls("kanban", "issue_create"), 1).input);
  assert.equal(nth(calls("kanban", "issue_create"), 0).key, nth(calls("kanban", "issue_create"), 1).key, "the same key");
  assert.equal(nth(calls("kanban", "issue_create"), 0).key, `wfrun:${id}:run_h1:send`);
  assert.deepEqual(calls("kanban", "tb.hold_status").map((c) => c.input), [{ holdId: "hld_01" }, { holdId: "hld_01" }, { holdId: "hld_01" }, { holdId: "hld_01" }]);
  assert.equal(calls("kanban", "tb.holds_pending").length, 0, "the cap decides: no list fallback");
  assert.ok(waited >= 30_000 + 60_000 + 120_000 + 240_000, `the waits were 30, 60, 120, 240 s (${waited} ms)`);
  const step = indexOf(t.db, id, "run_h1").steps[0];
  assert.deepEqual([step?.status, step?.hold_id, step?.hold_outcome], ["completed", "hld_01", "approved"]);
  assert.ok(Number(step?.hold_ended_at) >= Number(step?.hold_started_at));
  assert.equal(indexOf(t.db, id, "run_h1").run?.held_waits, 1);
});

test("held + denied or expired: the step fails with hold_denied / hold_expired, the call is NOT repeated, onFail decides", async () => {
  for (const [status, code] of [["denied", "hold_denied"], ["expired", "hold_expired"]] as const) {
    reset();
    t.caps.push("app_hold_status");
    t.apps.heldFirst["kanban.issue_create"] = { holdId: "hld_02", times: 1 };
    t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "never" } });
    t.apps.on["kanban.tb.hold_status"] = () => ({ status, expiresAt: "9999-12-31T00:00:00Z" });
    const id = install([write("send")]);
    const f = await failure(t.run({ workflowId: id, runId: `run_${status}` }));
    assert.equal(f.code, code);
    assert.equal(calls("kanban", "issue_create").length, 1, "never repeated");
    const s = indexOf(t.db, id, `run_${status}`).steps[0];
    assert.deepEqual([s?.status, s?.hold_outcome, s?.error_code], ["failed", status, code]);
    const soft = install([write("send", { onFail: "continue" }), read("after")], { outputs: { sent: "$steps.send.output" } });
    t.apps.on["knowledge.recall"] = () => ({});
    t.apps.calls.length = 0;
    assert.equal((await t.run({ workflowId: soft })).outputs.sent, null);
  }
});

test("held and nobody decides: the step fails with hold_expired when the hold's own time is up", async () => {
  reset();
  t.caps.push("app_hold_status");
  t.apps.heldFirst["kanban.issue_create"] = { holdId: "hld_03", times: 1, expiresInMs: 20 * 60_000 };
  t.apps.on["kanban.tb.hold_status"] = () => ({ status: "held", expiresAt: null });
  const id = install([write("send")], { limits: { maxRunMinutes: 600 } });
  const f = await failure(t.run({ workflowId: id }));
  assert.equal(f.code, "hold_expired");
  assert.equal(calls("kanban", "issue_create").length, 1);
});

test("held without the cap: the tb.holds_pending list is the fallback; a hold that left the list is decided and the call is repeated once", async () => {
  reset();
  t.apps.heldFirst["kanban.issue_create"] = { holdId: "hld_04", times: 1 };
  t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "iss_8" } });
  let polls = 0;
  t.apps.on["kanban.tb.holds_pending"] = () => ({ items: ++polls < 3 ? [{ id: "hld_other" }, { id: "hld_04" }] : [{ id: "hld_other" }], nextCursor: null });
  const id = install([write("send")], { outputs: { issue: "$steps.send.output.issue.id" } });
  const res = await t.run({ workflowId: id, runId: "run_fb" });
  assert.deepEqual(res.outputs, { issue: "iss_8" });
  assert.equal(calls("kanban", "tb.hold_status").length, 0, "no cap: tb.hold_status is never called");
  assert.equal(calls("kanban", "tb.holds_pending").length, 3);
  assert.equal(calls("kanban", "issue_create").length, 2);
  assert.equal(indexOf(t.db, id, "run_fb").steps[0]?.hold_outcome, "decided");
});

test("held without the cap, the hold list is read page by page", async () => {
  reset();
  t.apps.heldFirst["kanban.issue_create"] = { holdId: "hld_05", times: 1 };
  t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "iss_9" } });
  let polls = 0;
  t.apps.on["kanban.tb.holds_pending"] = (input) => {
    const cursor = (input as { cursor?: string }).cursor;
    polls++;
    if (polls > 4) return { items: [], nextCursor: null };
    return cursor ? { items: [{ id: "hld_05" }], nextCursor: null } : { items: [{ id: "hld_x" }], nextCursor: "page2" };
  };
  const id = install([write("send")]);
  assert.equal((await t.run({ workflowId: id })).status, "completed");
  assert.ok(calls("kanban", "tb.holds_pending").some((c) => (c.input as { cursor?: string }).cursor === "page2"));
});

test("held without the cap and without the owner's consent for tb.holds_pending: hold_check_unavailable, never a guess", async () => {
  reset();
  t.apps.heldFirst["kanban.issue_create"] = { holdId: "hld_06", times: 1 };
  t.apps.on["kanban.tb.holds_pending"] = () => {
    throw new TbError("grant_invalid", "no consent", 403);
  };
  const id = install([write("send")]);
  const f = await failure(t.run({ workflowId: id }));
  assert.equal(f.code, "hold_check_unavailable");
  assert.equal(calls("kanban", "issue_create").length, 1, "the call was not repeated");
});

test("a repeated call that is held AGAIN fails with held_again (the approval did not carry)", async () => {
  reset();
  t.caps.push("app_hold_status");
  t.apps.heldFirst["kanban.issue_create"] = { holdId: "hld_07", times: 2 };
  t.apps.on["kanban.tb.hold_status"] = () => ({ status: "approved" });
  const id = install([write("send")]);
  const f = await failure(t.run({ workflowId: id }));
  assert.equal(f.code, "held_again");
  assert.equal(calls("kanban", "issue_create").length, 2);
});

test("a hold the bridge no longer knows (hold_not_found) is hold_gone", async () => {
  reset();
  t.caps.push("app_hold_status");
  t.apps.heldFirst["kanban.issue_create"] = { holdId: "hld_08", times: 1 };
  t.apps.on["kanban.tb.hold_status"] = () => {
    throw new TbError("hold_not_found", "no such hold", 404);
  };
  const id = install([write("send")]);
  assert.equal((await failure(t.run({ workflowId: id }))).code, "hold_gone");
});

// ───────────────────────────── approval steps ─────────────────────────────

const APPROVAL = (extra: Record<string, unknown> = {}) => ({ id: "review", type: "approval", title: "Send to {{ $trigger.input.who }}?", context: "Draft: {{ $trigger.input.draft }}", timeoutSec: 3600, ...extra });
const INPUTS = { type: "object", properties: { who: { type: "string" }, draft: { type: "string" } } };
const TRIGGER = { kind: "manual" as const, input: { who: "Acme", draft: "Hello" } };

function inbox(answers: { status: string; response?: string | null; message?: string | null }[]): void {
  t.apps.on["inbox.inbox_ask"] = () => ({ itemId: "itm_1", status: "open", expiresAt: "9999-12-31T00:00:00Z" });
  let i = 0;
  t.apps.on["inbox.inbox_status"] = () => {
    const a = answers[Math.min(i++, answers.length - 1)] as { status: string; response?: string | null; message?: string | null };
    return { itemId: "itm_1", kind: "approval", status: a.status, seenByOwner: true, response: a.response ?? null, message: a.message ?? null, decidedAt: null, expiresAt: null };
  };
}

test("approval: asks in Inbox (key wfrun:..., approve and deny, the timeout as expiry), polls 30 s -> 5 min, approve continues", async () => {
  reset();
  inbox([{ status: "open" }, { status: "open" }, { status: "answered", response: "approve", message: "go" }]);
  t.apps.on["knowledge.recall"] = () => ({});
  const id = install([APPROVAL(), read("after")], { inputs: INPUTS, outputs: { answer: "$steps.review.output" } });
  const t0 = await t.env.currentTimeMs();
  const res = await t.run({ workflowId: id, runId: "run_a1", trigger: TRIGGER });
  const waited = (await t.env.currentTimeMs()) - t0;
  assert.deepEqual(res.outputs.answer, { response: "approve", message: "go" });
  const ask = nth(calls("inbox", "inbox_ask"), 0);
  assert.deepEqual(ask.input, { title: "Send to Acme?", kind: "approval", context: "Draft: Hello", responses: ["approve", "deny"], expiresInS: 3600 });
  assert.equal(ask.key, `wfrun:${id}:run_a1:review`);
  assert.equal(calls("inbox", "inbox_status").length, 3);
  assert.deepEqual(nth(calls("inbox", "inbox_status"), 0).input, { itemId: "itm_1" });
  assert.ok(waited >= 30_000 + 60_000 + 120_000, `waited ${waited} ms`);
  assert.equal(calls("knowledge", "recall").length, 1, "the step after the approval ran");
  const s = indexOf(t.db, id, "run_a1").steps.find((x) => x.step_id === "review");
  assert.deepEqual([s?.kind, s?.status], ["approval", "completed"]);
});

test("approval: deny stops the run (denied); onDeny continue goes on with the answer", async () => {
  reset();
  inbox([{ status: "answered", response: "deny", message: "no" }]);
  t.apps.on["knowledge.recall"] = () => ({});
  const stop = install([APPROVAL(), read("after")], { inputs: INPUTS });
  const f = await failure(t.run({ workflowId: stop, trigger: TRIGGER }));
  assert.equal(f.code, "denied");
  assert.equal(calls("knowledge", "recall").length, 0);
  inbox([{ status: "answered", response: "deny", message: "no" }]);
  const go = install([APPROVAL({ onDeny: "continue" }), read("after")], { inputs: INPUTS, outputs: { a: "$steps.review.output.response" } });
  const ok = await t.run({ workflowId: go, trigger: TRIGGER });
  assert.equal(ok.outputs.a, "deny");
  assert.equal(calls("knowledge", "recall").length, 1);
});

test("approval: ONLY answered + approve is an approval. Expired, unknown, open-with-a-response and clarify are not", async () => {
  reset();
  t.apps.on["knowledge.recall"] = () => ({});
  // expired -> approval_expired
  inbox([{ status: "open" }, { status: "expired" }]);
  const a = install([APPROVAL(), read("after")], { inputs: INPUTS });
  assert.equal((await failure(t.run({ workflowId: a, trigger: TRIGGER }))).code, "approval_expired");
  // unknown (Inbox lost the item) -> approval_lost, never approval
  inbox([{ status: "unknown" }]);
  const b = install([APPROVAL(), read("after")], { inputs: INPUTS });
  assert.equal((await failure(t.run({ workflowId: b, trigger: TRIGGER }))).code, "approval_lost");
  // an open item that (wrongly) carries response approve is still open: the run waits until the item expires
  inbox([{ status: "open", response: "approve" }]);
  const c = install([APPROVAL({ timeoutSec: 600 }), read("after")], { inputs: INPUTS, limits: { maxRunMinutes: 600 } });
  assert.equal((await failure(t.run({ workflowId: c, trigger: TRIGGER }))).code, "approval_expired");
  // answered clarify is not an approval
  inbox([{ status: "answered", response: "clarify" }]);
  const d = install([APPROVAL(), read("after")], { inputs: INPUTS });
  assert.equal((await failure(t.run({ workflowId: d, trigger: TRIGGER }))).code, "denied");
  assert.equal(calls("knowledge", "recall").length, 0, "nothing after an unapproved approval ever ran");
});

test("approval: Inbox down while asking fails the step with the code; Inbox not in the activated list is not_in_workflow", async () => {
  reset();
  t.apps.on["inbox.inbox_ask"] = () => {
    throw new TbError("validation_failed", "bad", 422);
  };
  const a = install([APPROVAL()], { inputs: INPUTS });
  assert.equal((await failure(t.run({ workflowId: a, trigger: TRIGGER }))).code, "validation_failed");
  const b = install([APPROVAL()], { inputs: INPUTS });
  const { getActivation, activate } = await import("../../src/engine/engine-store.ts");
  activate(t.db, b, 1, (getActivation(t.db, b, 1)?.uses ?? []).filter((u) => u.product !== "inbox"), Date.now());
  assert.equal((await failure(t.run({ workflowId: b, trigger: TRIGGER }))).code, "not_in_workflow");
});

// ───────────────────────────── onFail: ask ─────────────────────────────

const failing = (): void => {
  t.apps.on["kanban.issue_create"] = (_i, k) => {
    if (k < 2) throw new TbError("validation_failed", "bad title", 422);
    return { issue: { id: "iss_ok" } };
  };
};

test("onFail ask: the owner approves = retry. The step runs again and the run goes on", async () => {
  reset();
  failing();
  inbox([{ status: "open" }, { status: "answered", response: "approve" }]);
  const id = install([write("make", { onFail: "ask" })], { outputs: { issue: "$steps.make.output.issue.id" } });
  const res = await t.run({ workflowId: id, runId: "run_ask1" });
  assert.deepEqual(res.outputs, { issue: "iss_ok" });
  assert.equal(calls("kanban", "issue_create").length, 2);
  const q = nth(calls("inbox", "inbox_ask"), 0);
  assert.equal(q.key, `wfrun:${id}:run_ask1:make:ask1`);
  const body = q.input as { title: string; context: string; responses: string[]; kind: string };
  assert.deepEqual([body.kind, body.responses, body.title], ["approval", ["approve", "deny", "clarify"], "Workflow step failed: make"]);
  assert.match(body.context, /validation_failed/);
  assert.match(body.context, /Approve = try the step again\. Clarify = skip the step and go on\. Deny = stop the run\./);
  assert.equal(calls("inbox", "inbox_ask").length, 1);
});

test("onFail ask: clarify = skip (null output, run goes on), deny = stop with the step's own error, no answer = stop", async () => {
  reset();
  failing();
  t.apps.on["knowledge.recall"] = () => ({});
  inbox([{ status: "answered", response: "clarify" }]);
  const skip = install([write("make", { onFail: "ask" }), read("after")], { outputs: { m: "$steps.make.output" } });
  const r = await t.run({ workflowId: skip });
  assert.equal(r.status, "completed");
  assert.equal(r.outputs.m, null);
  assert.equal(calls("kanban", "issue_create").length, 1);

  reset();
  failing();
  inbox([{ status: "answered", response: "deny" }]);
  const stop = install([write("make", { onFail: "ask" })]);
  const f = await failure(t.run({ workflowId: stop }));
  assert.equal(f.code, "validation_failed", "the run fails with the step's own code");

  reset();
  failing();
  inbox([{ status: "expired" }]);
  const none = install([write("make", { onFail: "ask" })]);
  assert.equal((await failure(t.run({ workflowId: none }))).code, "validation_failed");
});

test("onFail ask: a failure no answer can fix is not asked (not_in_workflow); the owner is asked at most 5 times per step", async () => {
  reset();
  inbox([{ status: "answered", response: "approve" }]);
  const a = install([write("make", { onFail: "ask" })]);
  const { getActivation, activate } = await import("../../src/engine/engine-store.ts");
  activate(t.db, a, 1, (getActivation(t.db, a, 1)?.uses ?? []).filter((u) => u.op !== "issue_create"), Date.now());
  assert.equal((await failure(t.run({ workflowId: a }))).code, "not_in_workflow");
  assert.equal(calls("inbox", "inbox_ask").length, 0, "no question for a refusal the owner cannot fix");

  reset();
  t.apps.on["kanban.issue_create"] = () => {
    throw new TbError("validation_failed", "always bad", 422);
  };
  inbox([{ status: "answered", response: "approve" }]);
  const b = install([write("make", { onFail: "ask" })]);
  const f = await failure(t.run({ workflowId: b }));
  assert.equal(f.code, "validation_failed");
  assert.match(f.message, /asked 5 times/);
  assert.equal(calls("kanban", "issue_create").length, 6);
  assert.equal(calls("inbox", "inbox_ask").length, 5);
  assert.deepEqual(
    calls("inbox", "inbox_ask").map((c) => c.key?.split(":").at(-1)),
    ["ask1", "ask2", "ask3", "ask4", "ask5"],
  );
});

test("onFail ask works for an ai step and a held-then-denied app step too", async () => {
  reset();
  t.caps.push("app_hold_status");
  t.apps.heldFirst["kanban.issue_create"] = { holdId: "hld_ask", times: 1 };
  t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "iss_after_ask" } });
  let hs = 0;
  t.apps.on["kanban.tb.hold_status"] = () => ({ status: ++hs === 1 ? "denied" : "approved" });
  inbox([{ status: "answered", response: "approve" }]);
  const id = install([write("make", { onFail: "ask" })], { outputs: { issue: "$steps.make.output.issue.id" } });
  const res = await t.run({ workflowId: id });
  assert.deepEqual(res.outputs, { issue: "iss_after_ask" }, "denied -> the owner is asked -> retry -> held again? no: the retry is held (times 1 spent) -> runs");
  assert.equal(calls("inbox", "inbox_ask").length, 1);
});
