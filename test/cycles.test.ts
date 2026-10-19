// C250 Release B (E1): the cycle ledger on a migrated database: cycle bounds and authoring fields, run attribution
// (by version, version-less missed rows by due time), the stale rule, duplicate claims, ratios, the closing eval stored
// by promote, and the three person ops through the handlers (outputs checked against the manifest by call()).
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Caller, type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { handlers } from "../src/app.ts";
import * as cycles from "../src/cycles.ts";
import * as r from "../src/routines.ts";
import * as store from "../src/store.ts";
import { AGENT_A, call, ctxFor, migratedDb, OWNER } from "./helpers.ts";

const H = handlers as unknown as Parameters<typeof call>[0];
const BOUND: Caller = { ...AGENT_A, mode: "bound" };
const T = (s: string) => Date.parse(s);
const D0 = T("2026-10-01T06:00:00Z");
const D2 = T("2026-10-05T12:00:00Z"); // v2
const NOW = T("2026-10-12T00:00:00Z");
const READ = [{ product: "kanban", operations: ["issues_list"], crud: ["read" as const] }];

function workflow(db: Db, at = D0): { id: string; draftId: string } {
  const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "Morning rollup", summary: "", instruction: "Roll up.", trigger: "", steps: [], allowed: READ } }, at);
  return { id: store.promote(db, d.id, d.revision, at).workflow.id, draftId: d.id };
}
function promoteNext(db: Db, draftId: string, at: number, patch: store.DraftPatch): void {
  const d = store.getDraft(db, draftId);
  const u = store.updateDraft(db, d.id, d.revision, patch, at);
  store.promote(db, d.id, u.revision, at);
}
const widen = { allowed: [...READ, { product: "knowledge", operations: ["remember"], crud: ["create" as const] }] };

interface RunRow {
  status: r.RunStatus;
  due: number;
  version?: number | null;
  automation?: string;
  revision?: number;
  claimedAt?: number | null;
  updatedAt?: number;
  issue?: string | null;
  sync?: string;
}
function insertRuns(db: Db, workflowId: string, automationId: string, rows: RunRow[]): void {
  const ins = db.prepare(
    "INSERT INTO routine_runs (occurrence, automation_id, revision, due_at, status, claimed_by, workflow_id, workflow_version, summary, kanban_issue_id, kanban_sync, claimed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
  );
  for (const x of rows) {
    const claimed = x.status !== "missed" && x.status !== "policy_stale";
    const claimedAt = x.claimedAt === undefined ? (claimed ? x.due + 30_000 : null) : x.claimedAt;
    const rev = x.revision ?? 1;
    ins.run(
      r.occurrenceOf(x.automation ?? automationId, rev, x.due),
      x.automation ?? automationId,
      rev,
      x.due,
      x.status,
      claimed ? BOUND.id : null,
      workflowId,
      x.version === undefined ? 1 : x.version,
      x.issue ?? null,
      x.sync ?? "none",
      claimedAt,
      x.updatedAt ?? (claimedAt ?? x.due) + 60_000,
    );
  }
}
const day = (n: number, h = 8) => T(`2026-10-${String(n).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`);

test("a cycle runs from its promotion to the next promotion; authoring fields come from the draft and its suggestion", async () => {
  const db = migratedDb();
  const s = store.createSuggestion(
    db,
    { title: "Weekly report", summary: "", source: "agent", agentId: AGENT_A.id, createdBy: { type: "agent", id: AGENT_A.id, name: "A" }, evidence: [1, 2, 3].map((i) => ({ kind: "receipt" as const, ref: `call_${i}`, product: "knowledge", note: null, title: null })), steps: [] },
    D0 - 3_600_000,
  );
  store.decideSuggestion(db, s.id, "approve", { type: "person", id: OWNER.id, name: "Owner" }, null, D0 - 600_000);
  const d = store.createDraft(db, { suggestionId: s.id, templateId: null, snapshot: { title: "Weekly report", summary: "", instruction: "Write it.", trigger: "", steps: [], allowed: READ } }, D0);
  store.promote(db, d.id, d.revision, D0);
  promoteNext(db, d.id, D2, widen);
  promoteNext(db, d.id, day(8), { instruction: "Write it, shorter." });
  const wf = store.getDraft(db, d.id).workflowId as string;
  const [v1, v2, v3] = cycles.workflowCycles(db, wf, NOW);
  assert.deepEqual(
    [v1, v2, v3].map((c) => [c?.version, c?.parentVersion, c?.active, c?.draftRevisions, c?.widensAccess]),
    [
      [1, null, false, 1, false],
      [2, 1, false, 2, true],
      [3, 2, true, 3, false],
    ],
  );
  assert.equal(v1?.promotedAt, new Date(D0).toISOString());
  assert.equal(v1?.retiredAt, v2?.promotedAt, "retiredAt = the next version's promotedAt");
  assert.equal(v3?.retiredAt, null);
  assert.equal(v1?.suggestionId, s.id);
  assert.equal(v1?.evidenceCount, 3);
  assert.equal(v1?.approvalDelayMs, 3_000_000);
  assert.equal(v1?.workflowTitle, "Weekly report");

  // a blank draft: no suggestion, no evidence, no approval delay
  const blank = workflow(db);
  const [b1] = cycles.workflowCycles(db, blank.id, NOW);
  assert.deepEqual([b1?.suggestionId, b1?.evidenceCount, b1?.approvalDelayMs], [null, 0, null]);
});

test("approvalDelayMs is the FIRST approval: a later archive (decided_at overwritten) does not change it", () => {
  const db = migratedDb();
  const owner = { type: "person" as const, id: OWNER.id, name: "Owner" };
  const s = store.createSuggestion(db, { title: "Rollup", summary: "", source: "agent", agentId: AGENT_A.id, createdBy: { type: "agent", id: AGENT_A.id, name: "A" }, evidence: [], steps: [] }, D0);
  store.decideSuggestion(db, s.id, "approve", owner, null, D0 + 3_600_000);
  const d = store.createDraft(db, { suggestionId: s.id, templateId: null, snapshot: { title: "Rollup", summary: "", instruction: "Do it.", trigger: "", steps: [], allowed: READ } }, D0 + 3_700_000);
  const wf = store.promote(db, d.id, d.revision, D0 + 3_800_000).workflow.id;
  assert.equal(cycles.workflowCycles(db, wf, NOW)[0]?.approvalDelayMs, 3_600_000, "quiet");
  store.decideSuggestion(db, s.id, "archive", owner, null, D0 + 5 * 86_400_000);
  assert.equal(store.getSuggestion(db, s.id).decidedAt, new Date(D0 + 5 * 86_400_000).toISOString(), "decided_at moved");
  assert.equal(cycles.workflowCycles(db, wf, NOW)[0]?.approvalDelayMs, 3_600_000, "fires on decided_at: it would read 5 days");
});

test("run attribution: by workflow_version; a version-less missed row belongs to the version active at its due time", () => {
  const db = migratedDb();
  const wf = workflow(db);
  promoteNext(db, wf.draftId, D2, { instruction: "Roll up, v2." });
  const a = r.setAutomation(db, { workflowId: wf.id, agentId: BOUND.id, cron: "0 8 * * *" }, D0);
  insertRuns(db, wf.id, a.id, [
    { status: "completed", due: day(2), version: 1 },
    { status: "missed", due: day(3), version: null }, // before v2 → v1
    { status: "missed", due: day(5, 12), version: null }, // exactly at v2's promotion → v2
    { status: "missed", due: day(6), version: null }, // after → v2
    { status: "completed", due: day(7), version: 1 }, // a pinned run after v2: its own version wins
    { status: "completed", due: day(8), version: 2 },
  ]);
  const [v1, v2] = cycles.workflowCycles(db, wf.id, NOW);
  assert.deepEqual([v1?.counts.total, v1?.counts.completed, v1?.counts.missed], [3, 2, 1]);
  assert.deepEqual([v2?.counts.total, v2?.counts.completed, v2?.counts.missed], [3, 1, 2]);
  assert.equal(cycles.versionOfRun({ workflowVersion: null, dueAt: D0 - 1 }, [{ version: 1, promotedAt: D0 }]), null, "before v1: no cycle");
});

test("0.3.0: a missed row stores its version (pin, else the version active at the due time)", () => {
  const db = migratedDb();
  const wf = workflow(db);
  const a = r.setAutomation(db, { workflowId: wf.id, agentId: BOUND.id, cron: "0 8 * * *" }, D0);
  const pinned = r.setAutomation(db, { workflowId: wf.id, agentId: BOUND.id, cron: "0 9 * * *", versionPin: 1 }, D0);
  // v2 is promoted after the 08:00 due time of day 1, but before anything polls: the missed row still belongs to v1
  promoteNext(db, wf.draftId, day(1, 10), { instruction: "Roll up, v2." });
  r.dueJobs(db, BOUND.id, day(2, 12));
  const runs = r.listRuns(db, { limit: 50 }, day(2, 12));
  const byDue = (aut: string, due: number) => runs.find((x) => x.automationId === aut && x.dueAt === new Date(due).toISOString());
  assert.equal(byDue(a.id, day(1))?.workflowVersion, 1, "due before v2: v1");
  assert.equal(byDue(pinned.id, day(1, 9))?.workflowVersion, 1, "pinned");
  assert.ok(runs.every((x) => x.status === "missed" && x.workflowVersion !== null), "no missed row without a version");
  // the next missed due times (day 3) come after v2's promotion: the following schedule's row is v2's, the pinned one v1's
  r.dueJobs(db, BOUND.id, day(4, 12));
  assert.equal(r.listRuns(db, { automationId: a.id, limit: 50 }, day(4, 12))[0]?.workflowVersion, 2);
  assert.equal(r.listRuns(db, { automationId: pinned.id, limit: 50 }, day(4, 12))[0]?.workflowVersion, 1);
});

test("stale rule: claimed > 10 min or dispatched > 30 min count as uncertain (as listRuns shows them); fresh ones are open", () => {
  const db = migratedDb();
  const wf = workflow(db);
  const a = r.setAutomation(db, { workflowId: wf.id, agentId: BOUND.id, cron: "0 8 * * *" }, D0);
  insertRuns(db, wf.id, a.id, [
    { status: "claimed", due: day(10), updatedAt: NOW - r.CLAIMED_TIMEOUT_MS - 1 },
    { status: "dispatched", due: day(9), updatedAt: NOW - r.DISPATCHED_TIMEOUT_MS - 1 },
    { status: "claimed", due: day(11, 23), updatedAt: NOW - 1000 },
    { status: "dispatched", due: day(11, 22), updatedAt: NOW - r.CLAIMED_TIMEOUT_MS - 1 }, // > 10 min but dispatched: open
  ]);
  const [c] = cycles.workflowCycles(db, wf.id, NOW);
  assert.deepEqual([c?.counts.uncertain, c?.counts.open], [2, 2]);
  const shown = r.listRuns(db, { automationId: a.id, limit: 50 }, NOW).map((x) => x.status);
  assert.deepEqual(c?.last10, shown, "same statuses as runs_list, newest first");
});

test("duplicate claims: two claimed runs of one schedule and due time count once; missed / policy_stale rows and other due times never", () => {
  const db = migratedDb();
  const wf = workflow(db);
  const a = r.setAutomation(db, { workflowId: wf.id, agentId: BOUND.id, cron: "0 8 * * *" }, D0);
  insertRuns(db, wf.id, a.id, [
    { status: "completed", due: day(2) },
    { status: "completed", due: day(3) },
    { status: "missed", due: day(4), revision: 1 },
    { status: "policy_stale", due: day(4), revision: 2 },
    { status: "completed", due: day(4), revision: 3 },
  ]);
  assert.equal(cycles.workflowCycles(db, wf.id, NOW)[0]?.duplicateClaims, 0, "quiet");
  insertRuns(db, wf.id, a.id, [{ status: "failed", due: day(2), revision: 2 }]);
  const [c] = cycles.workflowCycles(db, wf.id, NOW);
  assert.equal(c?.duplicateClaims, 1, "fires");
  assert.equal(c?.evalLive.verdict, "fail");
  assert.equal(c?.evalLive.results.find((x) => x.metric === "duplicate_claims")?.pass, false);
});

test("ratios, medians and the Task Board close ratio", () => {
  const db = migratedDb();
  const wf = workflow(db);
  const a = r.setAutomation(db, { workflowId: wf.id, agentId: BOUND.id, cron: "0 8 * * *" }, D0);
  insertRuns(db, wf.id, a.id, [
    { status: "completed", due: day(2), claimedAt: day(2) + 10_000, updatedAt: day(2) + 70_000, issue: "iss_1", sync: "done" },
    { status: "completed", due: day(3), claimedAt: day(3) + 20_000, updatedAt: day(3) + 140_000, issue: "iss_2", sync: "done" },
    { status: "failed", due: day(4), claimedAt: day(4) + 40_000, updatedAt: day(4) + 340_000, issue: "iss_3", sync: "failed" },
    { status: "uncertain", due: day(5), claimedAt: day(5) + 90_000, issue: null },
    { status: "missed", due: day(6) },
  ]);
  const [c] = cycles.workflowCycles(db, wf.id, NOW);
  assert.deepEqual(c?.counts, { total: 5, completed: 2, failed: 1, uncertain: 1, missed: 1, policyStale: 0, open: 0 });
  assert.deepEqual([c?.completedRatio, c?.failedRatio, c?.uncertainRatio, c?.missedRatio], [0.5, 0.25, 0.25, 0.2]);
  assert.equal(c?.claimLatencyP50Ms, 20_000, "median of 10, 20, 40, 90 s (lower middle)");
  assert.equal(c?.durationP50Ms, null, "rows without reported_at (written before 0.3.0) are left out");
  assert.equal(c?.kanbanClosedRatio, 0.666667, "2 of 3 terminal runs with an issue");
  assert.deepEqual(c?.last10, ["missed", "uncertain", "failed", "completed", "completed"]);
  const [empty] = cycles.workflowCycles(db, workflow(db).id, NOW);
  assert.deepEqual([empty?.completedRatio, empty?.claimLatencyP50Ms, empty?.durationP50Ms, empty?.kanbanClosedRatio, empty?.last10], [null, null, null, null, []]);
  assert.equal(empty?.evalLive.verdict, "insufficient");
});

test("duration = reported_at - claimed_at of the runner's report; a Task Board close after the report does not change it", () => {
  const db = migratedDb();
  const wf = workflow(db);
  r.setAutomation(db, { workflowId: wf.id, agentId: BOUND.id, cron: "0 8 * * *" }, D0);
  const reportedAt = (occ: string) => (db.prepare("SELECT reported_at FROM routine_runs WHERE occurrence = ?").get(occ) as { reported_at: number | null }).reported_at;
  const occs: string[] = [];
  [60, 120, 300].forEach((secs, k) => {
    const t = day(1 + k) + 30_000;
    const occ = r.dueJobs(db, BOUND.id, t)[0]?.occurrence as string;
    assert.equal(r.claim(db, BOUND, occ, t).claimed, true);
    assert.equal(r.report(db, BOUND.id, occ, "dispatched", null, t + 1000).run.status, "dispatched");
    assert.equal(reportedAt(occ), null, "dispatched is not a terminal report");
    r.report(db, BOUND.id, occ, k === 1 ? "failed" : "completed", null, t + secs * 1000);
    assert.equal(reportedAt(occ), t + secs * 1000);
    occs.push(occ);
  });
  assert.equal(cycles.workflowCycles(db, wf.id, NOW)[0]?.durationP50Ms, 120_000, "quiet: 60, 120, 300 s");
  // the Task Board issues are closed hours later (setKanban moves updated_at): the duration must not move
  for (const occ of occs) r.setKanban(db, occ, "iss_1", "done", day(5));
  assert.equal(cycles.workflowCycles(db, wf.id, NOW)[0]?.durationP50Ms, 120_000, "fires on updated_at: the median would be days");

  // a run the sweep makes uncertain has no reported_at; a late report of the runner sets it
  const t = day(4) + 30_000;
  const occ = r.dueJobs(db, BOUND.id, t)[0]?.occurrence as string;
  r.claim(db, BOUND, occ, t);
  assert.equal(r.sweep(db, t + r.CLAIMED_TIMEOUT_MS + 1), 1);
  assert.equal(reportedAt(occ), null, "the sweep is not a report");
  r.report(db, BOUND.id, occ, "completed", "late", t + 3_600_000);
  assert.equal(reportedAt(occ), t + 3_600_000);
});

test("promote of version n+1 stores the closing eval of version n in the same transaction; version 1 stores none", () => {
  const db = migratedDb();
  const wf = workflow(db);
  assert.deepEqual(cycles.storedEvals(db, wf.id, 1), [], "quiet: a first promotion closes no cycle");
  const a = r.setAutomation(db, { workflowId: wf.id, agentId: BOUND.id, cron: "0 8 * * *" }, D0);
  insertRuns(db, wf.id, a.id, [2, 3, 4, 5, 6, 7].map((n) => ({ status: "completed" as const, due: day(n) })));
  // a refused promotion (stale revision) stores nothing
  const d = store.getDraft(db, wf.draftId);
  const u = store.updateDraft(db, d.id, d.revision, { instruction: "Roll up, v2." }, day(8));
  assert.throws(() => store.promote(db, d.id, d.revision, day(8)), (e: unknown) => e instanceof store.StoreError && e.code === "revision_conflict");
  assert.deepEqual(cycles.storedEvals(db, wf.id, 1), []);
  store.promote(db, d.id, u.revision, day(8));
  const [closing, ...more] = cycles.storedEvals(db, wf.id, 1);
  assert.equal(more.length, 0);
  assert.deepEqual([closing?.trigger, closing?.verdict, closing?.version, closing?.createdAt], ["promotion", "pass", 1, new Date(day(8)).toISOString()]);
  assert.equal(closing?.results.find((x) => x.metric === "completed_ratio")?.value, 1);
  assert.equal(cycles.getCycle(db, wf.id, 1, NOW).evalStored?.id, closing?.id);
  assert.deepEqual(cycles.storedEvals(db, wf.id, 2), [], "the new version's cycle is open");
});

test("the closing eval is best effort: an eval that throws never fails the promotion and leaves no eval row", () => {
  const db = migratedDb();
  const wf = workflow(db);
  db.exec("CREATE TRIGGER no_evals BEFORE INSERT ON eval_runs BEGIN SELECT RAISE(ABORT, 'eval store down'); END");
  const warned: { msg: string; f?: Record<string, unknown> }[] = [];
  const d = store.getDraft(db, wf.draftId);
  const u = store.updateDraft(db, d.id, d.revision, { instruction: "Roll up, v2." }, day(8));
  const out = store.promote(db, d.id, u.revision, day(8), { log: { warn: (msg, f) => void warned.push({ msg, f }) } });
  assert.equal(out.version.version, 2, "promoted");
  assert.equal(store.getWorkflow(db, wf.id).activeVersion, 2);
  assert.equal(store.getDraft(db, d.id).state, "promoted", "the promotion's own writes are kept");
  assert.equal((db.prepare("SELECT count(*) AS n FROM eval_runs").get() as { n: number }).n, 0, "no eval row");
  assert.deepEqual(warned, [{ msg: "closing eval not stored", f: { workflowId: wf.id, version: 1, error: "Error", message: "eval store down" } }]);
  // without a logger it is dropped too (store-level callers)
  db.exec("DROP TRIGGER no_evals");
  db.exec("CREATE TRIGGER no_evals BEFORE INSERT ON eval_runs BEGIN SELECT RAISE(ABORT, 'eval store down'); END");
  const d3 = store.updateDraft(db, d.id, store.getDraft(db, d.id).revision, { instruction: "Roll up, v3." }, day(9));
  assert.equal(store.promote(db, d.id, d3.revision, day(9)).version.version, 3);
  db.exec("DROP TRIGGER no_evals");
  // quiet: with a working store the next promotion stores its closing eval
  const d4 = store.updateDraft(db, d.id, store.getDraft(db, d.id).revision, { instruction: "Roll up, v4." }, day(10));
  store.promote(db, d.id, d4.revision, day(10));
  assert.deepEqual(cycles.storedEvals(db, wf.id, 3).map((e) => e.trigger), ["promotion"]);
});

test("cycles_list / cycle_get / cycle_eval_run through the handlers (owner ops, manifest outputs)", async () => {
  const db = migratedDb();
  const o = ctxFor(db, OWNER);
  const one = workflow(db);
  promoteNext(db, one.draftId, D2, widen);
  const two = workflow(db, day(3));
  const list = await call<K.CyclesListOutput>(H, "cycles_list", {}, o);
  assert.deepEqual(
    list.cycles.map((c) => [c.workflowId, c.version]),
    [
      [one.id, 2],
      [two.id, 1],
      [one.id, 1],
    ],
    "newest promotion first",
  );
  assert.deepEqual(
    (await call<K.CyclesListOutput>(H, "cycles_list", { workflowId: two.id }, o)).cycles.map((c) => c.version),
    [1],
  );
  assert.equal(list.cycles.find((c) => c.workflowId === one.id && c.version === 1)?.evalStored?.trigger, "promotion");

  const got = await call<K.CycleGetOutput>(H, "cycle_get", { workflowId: one.id, version: 1 }, o);
  assert.equal(got.cycle.widensAccess, false);
  assert.equal(got.evals.length, 1);
  await assert.rejects(call(H, "cycle_get", { workflowId: one.id, version: 9 }, o), (e: unknown) => e instanceof TbError && e.httpStatus === 404);
  await assert.rejects(call(H, "cycle_get", { workflowId: "wfl_01J000000000000000000000ZZ", version: 1 }, o), (e: unknown) => e instanceof TbError && e.httpStatus === 404);

  // idempotent through the handler: the same key answers the first eval and stores nothing new
  const keyed = (key: string) => ({ ...o, idempotencyKey: key }) as typeof o;
  const first = await call<K.CycleEvalRunOutput>(H, "cycle_eval_run", { workflowId: two.id, version: 1 }, keyed("key-0001"));
  const again = await call<K.CycleEvalRunOutput>(H, "cycle_eval_run", { workflowId: two.id, version: 1 }, keyed("key-0001"));
  assert.deepEqual(again, first);
  assert.equal(first.trigger, "owner");
  assert.equal(first.verdict, "insufficient");
  assert.equal(first.appVersion, cycles.storedEvals(db, two.id, 1)[0]?.appVersion);
  assert.equal(cycles.storedEvals(db, two.id, 1).length, 1, "one row for one key");
  const other = await call<K.CycleEvalRunOutput>(H, "cycle_eval_run", { workflowId: two.id, version: 1 }, keyed("key-0002"));
  assert.notEqual(other.id, first.id, "a new key stores a new eval");
  assert.equal((await call<K.CycleGetOutput>(H, "cycle_get", { workflowId: two.id, version: 1 }, o)).evals[0]?.id, other.id, "newest first");
  await assert.rejects(call(H, "cycle_eval_run", { workflowId: one.id, version: 1 }, keyed("key-0001")), (e: unknown) => e instanceof TbError && e.httpStatus === 409);
  await assert.rejects(call(H, "cycle_eval_run", { workflowId: two.id, version: 2 }, keyed("key-0003")), (e: unknown) => e instanceof TbError && e.httpStatus === 404);
});

test("C88: the ledger carries no Task Board titles (detector evidence titles stay on the suggestion)", async () => {
  const db = migratedDb();
  const s = store.createSuggestion(db, {
    title: "Make a workflow for \"Secret board item\"",
    summary: "",
    source: "detector",
    agentId: AGENT_A.id,
    createdBy: { type: "system", id: "detector", name: "Kanban detector" },
    evidence: [1, 2, 3].map((i) => ({ kind: "kanban_issue" as const, ref: `iss_${i}`, product: "kanban", note: null, title: `Secret board item ${i}` })),
    steps: [],
  });
  store.decideSuggestion(db, s.id, "approve", { type: "person", id: OWNER.id, name: "Owner" }, null);
  const d = store.createDraft(db, { suggestionId: s.id, templateId: null, snapshot: { title: "Rollup", summary: "", instruction: "Do it.", trigger: "", steps: [], allowed: READ } });
  store.promote(db, d.id, d.revision);
  const out = JSON.stringify(await call<K.CyclesListOutput>(H, "cycles_list", {}, ctxFor(db, OWNER)));
  assert.match(out, /"evidenceCount":3/);
  assert.doesNotMatch(out, /Secret board item/);
});
