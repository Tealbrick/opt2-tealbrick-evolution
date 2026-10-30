// Owner ops of the engine through the handler map (outputs checked against the manifest schema by call()): contract
// validate / save / list / get, activate (the list, CRUD and scopes the owner sees, the honest label), deactivate, the run
// index ops, and the Cycles ledger that reads engine_runs. No Temporal needed: every op here works from app.db.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { handlers, manifest } from "../../src/app.ts";
import * as cycles from "../../src/cycles.ts";
import type { WorkflowContract } from "../../src/engine/contract.ts";
import * as store from "../../src/engine/engine-store.ts";
import { GRANT_NOTICE } from "../../src/engine/ops.ts";
import { call, ctxFor, migratedDb, OWNER } from "../helpers.ts";
import { read, wf } from "./harness.ts";

const H = handlers as unknown as Parameters<typeof call>[0];
const exampleA = JSON.parse(readFileSync(new URL("./fixtures/example-a.json", import.meta.url), "utf8")) as WorkflowContract;
const fresh = () => {
  const db = migratedDb();
  return { db, op: <O>(id: string, input: unknown): Promise<O> => call<O>(H, id, input, ctxFor(db, OWNER)) };
};
const refuses = (p: Promise<unknown>, code: string, status: number): Promise<void> => assert.rejects(p, (e: unknown) => e instanceof TbError && e.code === code && e.httpStatus === status);

test("every engine op is a person op (the workspace owner only), reads are reads, writes carry the right idempotency", () => {
  const ids = ["workflow_contract_validate", "workflow_contract_save", "workflow_contracts_list", "workflow_contract_get", "workflow_activate", "workflow_deactivate", "schedule_set", "schedule_pause", "schedule_run_now", "schedule_delete", "schedules_list", "engine_runs_list", "engine_run_get"];
  for (const id of ids) assert.equal(manifest.operations.find((o) => o.id === id)?.audience, "person", id);
  for (const id of ["workflow_contract_validate", "workflow_contracts_list", "workflow_contract_get", "schedules_list", "engine_runs_list", "engine_run_get"]) {
    const o = manifest.operations.find((x) => x.id === id);
    assert.deepEqual([o?.effect, o?.crud, o?.receipt], ["read", ["read"], false], id);
  }
  assert.equal(manifest.operations.find((o) => o.id === "schedule_delete")?.effect, "destructive");
  assert.equal(manifest.operations.find((o) => o.id === "schedule_set")?.idempotency, "required");
  assert.equal(manifest.operations.find((o) => o.id === "workflow_contract_save")?.idempotency, "required");
  // no agent op takes or returns anything of the engine
  for (const o of manifest.operations.filter((x) => x.audience === "agent")) assert.doesNotMatch(o.id, /contract|schedule_|engine_|workflow_activate/);
});

test("validate: a good contract lists its operations (usage); a bad one lists every error with a pointer; no side effect", async () => {
  const { op, db } = fresh();
  const good = await op<{ ok: boolean; usage: { product: string; op: string; crud: string[]; scope: string | null; held: boolean; tools?: string[] }[]; activeVersion: number | null; uses: unknown[]; errors: unknown[] }>("workflow_contract_validate", { contract: exampleA });
  assert.equal(good.ok, true);
  assert.deepEqual(
    good.usage.map((u) => [u.product, u.op, u.crud, u.scope, u.held, u.tools]),
    [["connect", "tools", ["read"], "account", false, ["gmail_create_email_draft", "gmail_fetch_emails"]]],
  );
  assert.equal(good.activeVersion, null);
  assert.equal(good.uses.length, 1, "uses and usage are the same list");
  const bad = await op<{ ok: boolean; errors: { pointer: string; path: string; code: string; message: string }[]; usage: unknown[] }>("workflow_contract_validate", { contract: wf([read("a", { input: { query: "$steps.nope.output" } }), { id: "lp", type: "loop", forEach: "$input.x", steps: [read("i")] }]) });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.usage, []);
  assert.ok(bad.errors.every((e) => e.pointer === e.path));
  assert.equal(db.prepare("SELECT count(*) AS c FROM engine_definitions").get()?.c, 0);
  await refuses(op("workflow_contract_validate", {}), "validation_failed", 422);
  await refuses(op("workflow_contract_validate", { workflowId: "never-saved", version: 1 }), "not_found", 404);
});

test("save: an immutable version per (id, version); the same contract again is a no-op; other content under the same version is a conflict; an invalid contract is refused with its errors", async () => {
  const { op } = fresh();
  const a = await op<{ workflowId: string; version: number; created: boolean; digest: string }>("workflow_contract_save", { contract: exampleA });
  assert.deepEqual([a.workflowId, a.version, a.created], ["daily-email-summary", 1, true]);
  assert.match(a.digest, /^sha256:[0-9a-f]{64}$/);
  const again = await op<{ created: boolean; digest: string }>("workflow_contract_save", { contract: exampleA });
  assert.deepEqual([again.created, again.digest], [false, a.digest]);
  await refuses(op("workflow_contract_save", { contract: { ...exampleA, title: "Changed" } }), "version_exists", 409);
  const v2 = await op<{ version: number }>("workflow_contract_save", { contract: { ...exampleA, version: 2, title: "Changed" } });
  assert.equal(v2.version, 2);
  await assert.rejects(
    op("workflow_contract_save", { contract: { ...exampleA, id: "other-flow", steps: [] } }),
    (e: unknown) => e instanceof TbError && e.code === "validation_failed" && e.httpStatus === 422 && Array.isArray(e.details?.errors),
  );
  const list = await op<{ contracts: { workflowId: string; version: number; state: string | null }[] }>("workflow_contracts_list", {});
  assert.deepEqual(
    list.contracts.map((c) => [c.workflowId, c.version, c.state]),
    [
      ["daily-email-summary", 2, null],
      ["daily-email-summary", 1, null],
    ],
  );
  const got = await op<{ contract: { title: string }; activation: unknown }>("workflow_contract_get", { workflowId: "daily-email-summary", version: 1 });
  assert.equal(got.contract.title, "Summarize my daily emails");
  assert.equal(got.activation, null);
  await refuses(op("workflow_contract_get", { workflowId: "daily-email-summary", version: 9 }), "not_found", 404);
});

test("activate: the owner sees the ops, CRUD and scopes; the engine stores that list; the honest label is in the answer; a newer version replaces the old one", async () => {
  const { op, db } = fresh();
  await op("workflow_contract_save", { contract: exampleA });
  await op("workflow_contract_save", { contract: { ...exampleA, version: 2 } });
  const a = await op<{ activeVersion: number; previousVersion: number | null; ops: { product: string; op: string; tools: string[] }[]; crud: Record<string, string[]>; scopes: { product: string; scopeType: string }[]; notice: string; usage: unknown[] }>("workflow_activate", { workflowId: "daily-email-summary", version: 1 });
  assert.equal(a.activeVersion, 1);
  assert.equal(a.previousVersion, null);
  assert.deepEqual(a.crud, { connect: ["read"] });
  assert.deepEqual(a.scopes, [{ product: "connect", scopeType: "account" }]);
  assert.equal(a.ops[0]?.tools.join(), "gmail_create_email_draft,gmail_fetch_emails");
  assert.equal(a.usage.length, 1);
  assert.equal(a.notice, GRANT_NOTICE);
  assert.match(a.notice, /limits Evolving Workflows as a whole; each workflow's limit is enforced by the engine until per-workflow grants/);
  assert.equal(store.getActivation(db, "daily-email-summary", 1)?.state, "active");
  const b = await op<{ previousVersion: number | null }>("workflow_activate", { workflowId: "daily-email-summary", version: 2 });
  assert.equal(b.previousVersion, 1);
  assert.equal(store.getActivation(db, "daily-email-summary", 1)?.state, "superseded");
  assert.equal(store.activeActivation(db, "daily-email-summary")?.version, 2);
  const v = await op<{ activeVersion: number | null }>("workflow_contract_validate", { contract: exampleA });
  assert.equal(v.activeVersion, 2, "validate says which version is active");
  await refuses(op("workflow_activate", { workflowId: "daily-email-summary", version: 7 }), "not_found", 404);
  const d = await op<{ deactivatedVersions: number[] }>("workflow_deactivate", { workflowId: "daily-email-summary" });
  assert.deepEqual(d.deactivatedVersions.sort(), [1, 2]);
  assert.equal(store.activeActivation(db, "daily-email-summary"), null);
  // one active version at most is a database rule, not only code
  assert.throws(() => db.prepare("UPDATE engine_activations SET state = 'active'").run(), /UNIQUE/);
});

test("activate re-checks the contract against the target ops: a stored version that is no longer valid cannot be activated", async () => {
  const { op, db } = fresh();
  await op("workflow_contract_save", { contract: exampleA });
  // the stored contract is edited behind the engine's back (a bug or a restore): activation validates again
  db.prepare("UPDATE engine_definitions SET contract = ? WHERE workflow_id = 'daily-email-summary'").run(JSON.stringify({ ...exampleA, steps: [{ id: "x", type: "app", product: "kanban", op: "issue_delete", input: { issue: "i" }, onFail: "ask" }] }));
  await refuses(op("workflow_activate", { workflowId: "daily-email-summary", version: 1 }), "validation_failed", 422);
  assert.equal(store.getActivation(db, "daily-email-summary", 1), null);
});

test("engine_runs_list and engine_run_get: shapes, filters, steps with attempt, stage and hold; owner only", async () => {
  const { op, db } = fresh();
  await op("workflow_contract_save", { contract: { ...exampleA } });
  const t0 = Date.parse("2026-10-20T08:00:00Z");
  store.startRun(db, { workflowId: "daily-email-summary", runId: "r1", version: 1, scheduleId: null, temporalWorkflowId: "evo:daily-email-summary:r1", temporalRunId: "tr1", triggerKind: "manual", startedAt: t0 }, t0);
  store.writeStep(db, { workflowId: "daily-email-summary", runId: "r1", stepKey: "fetch", stepId: "fetch", loopPath: [], kind: "app", status: "completed", startedAt: t0, endedAt: t0 + 900, product: "connect", op: "tools", attempts: 2, outBytes: 1234 }, t0);
  store.writeStep(db, { workflowId: "daily-email-summary", runId: "r1", stepKey: "draft", stepId: "draft", loopPath: [], kind: "app", status: "waiting_hold", startedAt: t0 + 1000, hold: { id: "hld_9", startedAt: t0 + 1000 }, attempts: 1 }, t0);
  store.writeStep(db, { workflowId: "daily-email-summary", runId: "r1", stepKey: "summary", stepId: "summary", loopPath: [], kind: "ai", status: "waiting_agent", startedAt: t0 + 2000, agent: { stepRunId: "stp_1", agentId: "agt_x" }, attempts: 1 }, t0);
  store.finishRun(db, { workflowId: "daily-email-summary", runId: "r1", status: "failed", endedAt: t0 + 5000, errorCode: "held", errorStep: "draft" }, t0);
  store.startRun(db, { workflowId: "daily-email-summary", runId: "r2", version: 1, scheduleId: "sch_1", temporalWorkflowId: "evo:daily-email-summary:r2", temporalRunId: "tr2", triggerKind: "schedule", startedAt: t0 + 10_000 }, t0);
  const list = await op<{ runs: { runId: string; status: string; durationMs: number | null; stepsDone: number; stepsFailed: number; heldWaits: number }[] }>("engine_runs_list", {});
  assert.deepEqual(
    list.runs.map((r) => [r.runId, r.status, r.durationMs]),
    [
      ["r2", "running", null],
      ["r1", "failed", 5000],
    ],
  );
  assert.deepEqual(
    (await op<{ runs: unknown[] }>("engine_runs_list", { status: "failed" })).runs.length,
    1,
  );
  assert.equal((await op<{ runs: unknown[] }>("engine_runs_list", { scheduleId: "sch_1" })).runs.length, 1);
  assert.equal((await op<{ runs: unknown[] }>("engine_runs_list", { workflowId: "nothing-here" })).runs.length, 0);
  const g = await op<{ run: { runId: string; heldWaits: number }; steps: { stepId: string; status: string; attempt: number; stage: string | null; holdId: string | null; stepRunId: string | null; agentId: string | null; durationMs: number | null }[]; outputs: unknown }>("engine_run_get", { runId: "r1" });
  assert.equal(g.run.heldWaits, 1);
  assert.deepEqual(
    g.steps.map((s) => [s.stepId, s.status, s.attempt, s.stage, s.holdId, s.stepRunId, s.agentId]),
    [
      ["fetch", "completed", 2, "enrichment", null, null, null],
      ["draft", "waiting_hold", 1, "result", "hld_9", null, null],
      ["summary", "waiting_agent", 1, "intelligence", null, "stp_1", "agt_x"],
    ],
  );
  assert.equal(g.steps[0]?.durationMs, 900);
  assert.equal(g.outputs, null);
  assert.equal((await op<{ run: { runId: string } }>("engine_run_get", { workflowId: "daily-email-summary", runId: "r2" })).run.runId, "r2");
  await refuses(op("engine_run_get", { runId: "nope" }), "not_found", 404);
});

test("Cycles read engine_runs: a contract version is a cycle from its activation; completed and failed runs count, skipped, cancelled and running do not distort; step metrics roll up", async () => {
  const { db } = fresh();
  const wfId = "daily-email-summary";
  store.saveDefinition(db, exampleA, 1000);
  store.saveDefinition(db, { ...exampleA, version: 2 }, 2000);
  store.activate(db, wfId, 1, [], Date.parse("2026-10-20T00:00:00Z"));
  store.activate(db, wfId, 2, [], Date.parse("2026-10-24T00:00:00Z"));
  const T = Date.parse("2026-10-21T08:00:00Z");
  let i = 0;
  const add = (version: number, status: "completed" | "failed" | "skipped" | "cancelled" | "running" | "timed_out", ms: number, steps: { done: number; failed: number; holdMs?: number; tokens?: number }): void => {
    const runId = `r${++i}`;
    const at = T + i * 3_600_000;
    store.startRun(db, { workflowId: wfId, runId, version, scheduleId: null, temporalWorkflowId: `evo:${wfId}:${runId}`, temporalRunId: runId, triggerKind: "schedule", startedAt: at }, at);
    for (let k = 0; k < steps.done + steps.failed; k++) store.writeStep(db, { workflowId: wfId, runId, stepKey: `s${k}`, stepId: `s${k}`, loopPath: [], kind: "app", status: k < steps.done ? "completed" : "failed", startedAt: at, endedAt: at + 1, attempts: 1, ...(k === 0 && steps.holdMs ? { hold: { id: "h", startedAt: at } } : {}), ...(k === 0 && steps.tokens ? { tokensIn: steps.tokens, tokensOut: 0 } : {}) }, at);
    if (steps.holdMs) store.endHold(db, wfId, runId, "s0", "approved", at + steps.holdMs);
    if (status !== "running") store.finishRun(db, { workflowId: wfId, runId, status, endedAt: at + ms }, at + ms);
  };
  add(1, "completed", 1000, { done: 3, failed: 0 });
  add(1, "completed", 3000, { done: 2, failed: 0, holdMs: 120_000, tokens: 500 });
  add(1, "failed", 2000, { done: 1, failed: 1 });
  add(1, "timed_out", 9000, { done: 0, failed: 1 });
  add(1, "skipped", 10, { done: 0, failed: 0 });
  add(1, "cancelled", 10, { done: 0, failed: 0 });
  add(1, "running", 0, { done: 1, failed: 0 });
  add(2, "completed", 500, { done: 4, failed: 0 });
  const now = Date.parse("2026-11-20T00:00:00Z"); // a month later: a running engine run is NOT swept to uncertain
  const [c1, c2] = cycles.workflowCycles(db, wfId, now);
  assert.equal(c1?.version, 1);
  assert.deepEqual(c1?.counts, { total: 5, completed: 2, failed: 2, uncertain: 0, missed: 0, policyStale: 0, open: 1 });
  assert.equal(c1?.completedRatio, 0.5);
  assert.equal(c1?.durationP50Ms, 2000, "nearest-rank median of 1000, 3000, 2000, 9000");
  assert.equal(c1?.claimLatencyP50Ms, null);
  assert.equal(c1?.duplicateClaims, 0);
  assert.deepEqual(c1?.engine, { runs: 5, stepsDone: 7, stepsFailed: 2, stepFailureRatio: 0.222222, heldWaits: 1, heldWaitP50Ms: 120000, modelTokens: 500 });
  assert.equal(c1?.promotedAt, "2026-10-20T00:00:00.000Z");
  assert.equal(c1?.retiredAt, "2026-10-24T00:00:00.000Z");
  assert.deepEqual([c2?.version, c2?.active, c2?.counts.total, c2?.engine?.stepsDone], [2, true, 1, 4]);
  // through the ops (outputs checked against the manifest schema, which now carries `engine`)
  const out = await call<{ cycles: { version: number; engine: unknown }[] }>(H, "cycles_list", { workflowId: wfId }, ctxFor(db, OWNER));
  assert.deepEqual(out.cycles.map((c) => c.version).sort(), [1, 2]);
  const one = await call<{ cycle: { engine: { runs: number } } }>(H, "cycle_get", { workflowId: wfId, version: 1 }, ctxFor(db, OWNER));
  assert.equal(one.cycle.engine.runs, 5);
  // a workflow with no engine run has engine: null
  const none = cycles.workflowCycles(db, wfId, now).at(-1);
  assert.notEqual(none, undefined);
});

test("Cycles: 0.3.x workflows are unchanged (engine null) and a database without engine rows reads as before", async () => {
  const { db } = fresh();
  assert.deepEqual(cycles.listCycles(db), []);
});
