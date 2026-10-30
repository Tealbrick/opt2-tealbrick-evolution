// biome-ignore-all lint/suspicious/noThenProperty: a condition step of the workflow contract has a `then` field
// C373 fix batch, each item with a quiet-on-good and a fire-on-bad test:
//   F-R1 the Rules denial text + rule id on the step row and in the run detail (hook_denied ONLY)
//   F-G5 the reason code of a failed agent-step offer
// (F-G3, F-G4 are in validate.test.ts / ops-level tests below; F-G6 and S3 in schedules.test.ts.)
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { WorkflowFailedError } from "@temporalio/client";
import { manifest } from "../../src/app.ts";
import { denialOf, offerReason } from "../../src/engine/activities.ts";
import { engineHandlers } from "../../src/engine/ops.ts";
import { call, ctxFor, OWNER } from "../helpers.ts";
import { type Env, indexOf, startEnv, wf, write } from "./harness.ts";

let t: Env;
let offerError: unknown = null;
before(async () => {
  t = await startEnv({
    agentPort: {
      async offer() {
        if (offerError !== null) throw offerError;
      },
      async cancel() {},
    },
  });
});
after(async () => {
  await t.stop();
});

const H = engineHandlers(manifest as never) as unknown as Parameters<typeof call>[0];
const op = <O>(id: string, input: unknown): Promise<O> => call<O>(H, id, input, ctxFor(t.db, OWNER));
async function failure(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WorkflowFailedError) {
      const c = e.cause as { type?: string; message: string; cause?: { type?: string; message: string } };
      // an activity failure wraps the application failure
      const inner = c.cause ?? c;
      return { code: inner.type ?? c.type ?? "", message: inner.message ?? c.message };
    }
    throw e;
  }
  assert.fail("the run should have failed");
}
const RULE = "rul_01ARZ3NDEKTSV4RRFFQ69G5FAV";
let n = 0;
const flow = (steps: unknown[]): string => {
  const id = `fix-flow-${++n}`;
  t.install(wf(steps, { id }));
  return id;
};
interface DetailStep {
  stepId: string;
  errorCode: string | null;
  errorMessage: string | null;
  ruleId: string | null;
}
const stepOf = async (workflowId: string, runId: string, stepId: string): Promise<DetailStep> => {
  const d = await op<{ steps: DetailStep[] }>("engine_run_get", { workflowId, runId });
  const s = d.steps.find((x) => x.stepId === stepId);
  assert.ok(s, `step ${stepId} in the run detail`);
  return s;
};

// ───────────────────────────── F-R1 ─────────────────────────────

test("F-R1 quiet: any other refusal keeps the code and the status only; no text, no rule id on the step", async () => {
  t.apps.on["kanban.issue_create"] = () => {
    throw new TbError("forbidden", `customer secret 4111 (rule ${RULE})`, 403);
  };
  const id = flow([write("w")]);
  const f = await failure(t.run({ workflowId: id, runId: "run_other" }));
  assert.equal(f.code, "forbidden");
  assert.equal(f.message, "w: forbidden (HTTP 403)", "the failure in Temporal history holds no text of the other app");
  const row = indexOf(t.db, id, "run_other").steps[0];
  assert.deepEqual([row?.error_code, row?.error_message, row?.rule_id], ["forbidden", null, null]);
  const s = await stepOf(id, "run_other", "w");
  assert.deepEqual([s.errorCode, s.errorMessage, s.ruleId], ["forbidden", null, null]);
});

test("F-R1 fire: a hook_denied step keeps the bridge text (200 characters at most) and the rule id; the row and the run detail show both", async () => {
  const text = `Rules: Do not email outside the company (rule ${RULE})`;
  t.apps.on["kanban.issue_create"] = () => {
    throw new TbError("hook_denied", text, 403);
  };
  const id = flow([write("w")]);
  const f = await failure(t.run({ workflowId: id, runId: "run_denied" }));
  assert.equal(f.code, "hook_denied");
  assert.equal(f.message, "w: hook_denied (HTTP 403)", "the failure in Temporal history stays code-only: the text lives on the step row in app.db");
  const row = indexOf(t.db, id, "run_denied").steps[0];
  assert.deepEqual([row?.status, row?.error_code, row?.error_message, row?.rule_id], ["failed", "hook_denied", text, RULE], "the workflow's own failed write (code only) did not erase the reason");
  const s = await stepOf(id, "run_denied", "w");
  assert.deepEqual([s.errorCode, s.errorMessage, s.ruleId], ["hook_denied", text, RULE]);
});

test("F-R1: the form 'denied by <product>/<hookId>' is kept without a rule id", async () => {
  t.apps.on["kanban.issue_create"] = () => {
    throw new TbError("hook_denied", "denied by rules/hk_01", 403);
  };
  const id = flow([write("w")]);
  await failure(t.run({ workflowId: id, runId: "run_denied2" }));
  const s = await stepOf(id, "run_denied2", "w");
  assert.deepEqual([s.errorMessage, s.ruleId], ["denied by rules/hk_01", null]);
});

test("F-R1 denialOf: cut to 200, rule id from the end of the whole text, control characters removed; not for another code", () => {
  assert.equal(denialOf(new TbError("forbidden", `x (rule ${RULE})`, 403)), null, "another code keeps nothing");
  assert.equal(denialOf(new Error("hook_denied")), null);
  assert.deepEqual(denialOf(new TbError("hook_denied", `Rules: no (rule ${RULE})`, 403)), { message: `Rules: no (rule ${RULE})`, ruleId: RULE });
  // long text: the cut is 200, the id (read before the cut) is still found
  const long = `Rules: ${"a".repeat(300)} (rule ${RULE})`;
  const d = denialOf(new TbError("hook_denied", long, 403));
  assert.equal(d?.message.length, 200);
  assert.equal(d?.ruleId, RULE);
  // the id must END the text, be a real id (Crockford letters only, 26 characters), and be written as "(rule rul_...)"
  assert.equal(denialOf(new TbError("hook_denied", `(rule ${RULE}) and more`, 403))?.ruleId, null);
  assert.equal(denialOf(new TbError("hook_denied", "x (rule rul_01ARZ3NDEKTSV4RRFFQ69G5FAU)", 403))?.ruleId, null, "U is not a Crockford letter");
  assert.equal(denialOf(new TbError("hook_denied", "x (rule rul_01ARZ3NDEKTSV4RRFFQ69G5FA)", 403))?.ruleId, null, "25 characters");
  assert.equal(denialOf(new TbError("hook_denied", `x rule ${RULE}`, 403))?.ruleId, null);
  // line breaks and other control or format characters become spaces
  assert.equal(denialOf(new TbError("hook_denied", `no\nway\t(rule ${RULE})`, 403))?.message, `no way (rule ${RULE})`);
});

// ───────────────────────────── F-G5 ─────────────────────────────

const agentStep = (id: string) => ({ id, type: "ai", by: { agent: "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85" }, instruction: "do", inputs: {}, outputSchema: { type: "object" }, timeoutSec: 600 });

test("F-G5 fire: a failed offer stores the reason code on the step (and shows it in the run detail); the text of the error is not kept", async () => {
  offerError = new TbError("agent_not_found", "agent agt_x of customer Acme is gone", 404);
  const id = flow([agentStep("ask")]);
  const f = await failure(t.run({ workflowId: id, runId: "run_offer" }));
  assert.equal(f.code, "offer_failed");
  assert.equal(f.message, "ask: The agent step could not be offered: agent_not_found.");
  const row = indexOf(t.db, id, "run_offer").steps[0];
  assert.deepEqual([row?.status, row?.error_code, row?.error_message], ["failed", "offer_failed", "The agent step could not be offered: agent_not_found."]);
  const s = await stepOf(id, "run_offer", "ask");
  assert.equal(s.errorMessage, "The agent step could not be offered: agent_not_found.");

  // an error without a code: "unknown", never its message
  offerError = new Error("database says: customer Acme has 3 open invoices");
  const id2 = flow([agentStep("ask")]);
  const f2 = await failure(t.run({ workflowId: id2, runId: "run_offer2" }));
  assert.equal(f2.message, "ask: The agent step could not be offered: unknown.");
  assert.doesNotMatch(JSON.stringify(indexOf(t.db, id2, "run_offer2").steps), /Acme|invoices/);
  offerError = null;
});

test("F-G5 offerReason: a code, an upper-case library code, a message that IS a code; else unknown", () => {
  assert.equal(offerReason(new TbError("agent_not_found", "x", 404)), "agent_not_found");
  assert.equal(offerReason(Object.assign(new Error("x"), { code: "ERR_SQLITE_ERROR" })), "err_sqlite_error");
  assert.equal(offerReason(new Error("agent_port_busy")), "agent_port_busy");
  assert.equal(offerReason(new Error("has spaces and data")), "unknown");
  assert.equal(offerReason("text"), "unknown");
  assert.equal(offerReason(null), "unknown");
});

test("F-G5 quiet: a good offer leaves no reason on the waiting step", async () => {
  offerError = null;
  const id = flow([agentStep("ask")]);
  const pending = t.run({ workflowId: id, runId: "run_offer_ok" });
  const { waitFor } = await import("./harness.ts");
  await waitFor("the step waits for the agent", () => indexOf(t.db, id, "run_offer_ok").steps[0]?.status === "waiting_agent");
  const row = indexOf(t.db, id, "run_offer_ok").steps[0];
  assert.deepEqual([row?.error_code, row?.error_message, row?.rule_id], [null, null, null]);
  await t.client.workflow.getHandle(`evo:${id}:run_offer_ok`).terminate("test over");
  await pending.catch(() => undefined);
});

// ───────────────────────────── F-G2: child workflow ops in the check ─────────────────────────────

interface CheckOut {
  ok: boolean;
  usage: { product: string; op: string; via?: string[] }[];
  warnings: { code: string; path: string; message: string }[];
  errors: { code: string; path: string }[];
}

test("F-G2 quiet: a workflow without a workflow step lists only its own ops, with no dependency note", async () => {
  const c = wf([write("make")], { id: "plain-parent" });
  const r = await op<CheckOut>("workflow_contract_validate", { contract: c });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.usage.map((u) => [u.product, u.op, u.via]),
    [["kanban", "issue_create", undefined]],
  );
  assert.deepEqual(r.warnings, []);
});

test("F-G2 fire: the ops of an active child are in the parent's check (via the child) exactly as at activation; a child that is not active is a dependency note, and activation refuses", async () => {
  const child = wf([write("make")], { id: "g2-kid" });
  const parent = wf([{ id: "sub", type: "workflow", workflow: "g2-kid" }], { id: "g2-dad" });
  await op("workflow_contract_save", { contract: child });
  await op("workflow_contract_save", { contract: parent });
  // the child is saved but not active: the check says so, and lists no op of it
  const before = await op<CheckOut>("workflow_contract_validate", { workflowId: "g2-dad", version: 1 });
  assert.equal(before.ok, true);
  assert.deepEqual(before.usage, []);
  assert.deepEqual(
    before.warnings.map((w) => [w.code, w.path]),
    [["child_not_active", "/steps/0/workflow"]],
  );
  assert.match(before.warnings[0]?.message ?? "", /g2-kid.*not active.*activate it first/);
  await assert.rejects(op("workflow_activate", { workflowId: "g2-dad", version: 1 }), (e: unknown) => e instanceof TbError && e.code === "child_not_active" && e.httpStatus === 409);
  // the child is active: its op is counted, and the check equals what activation then stores
  await op("workflow_activate", { workflowId: "g2-kid", version: 1 });
  const after = await op<CheckOut>("workflow_contract_validate", { workflowId: "g2-dad", version: 1 });
  assert.deepEqual(
    after.usage.map((u) => [u.product, u.op, u.via]),
    [["kanban", "issue_create", ["g2-kid"]]],
  );
  assert.deepEqual(after.warnings, []);
  const act = await op<{ usage: { product: string; op: string; via?: string[] }[] }>("workflow_activate", { workflowId: "g2-dad", version: 1 });
  assert.deepEqual(act.usage, after.usage, "check and activation list the same operations");
});

// ───────────────────────────── F-G3: the placeholder agent, through the owner ops ─────────────────────────────

test("F-G3: the check and the save refuse the 0.3.x placeholder agent with a pointer; activation of a stored one keeps its own code; a real agent passes", async () => {
  const mk = (agent: string, id: string) => wf([{ id: "ask", type: "ai", by: { agent }, instruction: "do", inputs: {}, outputSchema: { type: "object" }, timeoutSec: 600 }], { id });
  const good = await op<CheckOut>("workflow_contract_validate", { contract: mk("agt_01M5BDHMN8ZQJPS4YQ4EWH8W85", "g3-good") });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  const bad = await op<Omit<CheckOut, "errors"> & { errors: { code: string; path: string; pointer: string; message: string }[] }>("workflow_contract_validate", { contract: mk("agt_unassigned", "g3-bad") });
  assert.equal(bad.ok, false);
  assert.deepEqual(
    bad.errors.map((e) => [e.code, e.path, e.pointer]),
    [["agent_unassigned", "/steps/0/by/agent", "/steps/0/by/agent"]],
  );
  await assert.rejects(
    op("workflow_contract_save", { contract: mk("agt_unassigned", "g3-bad") }),
    (e: unknown) => e instanceof TbError && e.code === "validation_failed" && /placeholder agent/.test(e.message),
  );
  // a version the migration stored (it validates without the option) is still refused at activation, with the code the UI knows
  const { saveDefinition } = await import("../../src/engine/engine-store.ts");
  saveDefinition(t.db, mk("agt_unassigned", "g3-stored"), Date.now());
  await assert.rejects(op("workflow_activate", { workflowId: "g3-stored", version: 1 }), (e: unknown) => e instanceof TbError && e.code === "agent_unassigned" && e.httpStatus === 422);
  const stored = await op<CheckOut>("workflow_contract_validate", { workflowId: "g3-stored", version: 1 });
  assert.equal(stored.ok, false, "and the check of the stored version says so before the owner tries to activate");
});
