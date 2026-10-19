// C288 R8: run metrics on routine_report (the RunReport of the Henry contracts): stored with the terminal report, rolled
// up per workflow version in the cycle ledger, read by the owner only (C88 / L12). Quiet-on-good and fire-on-bad (L34).
// Two layers refuse a bad payload: the manifest schema (the SDK answers 400 input_invalid with the pointer of each
// error; `validateInput` is the SDK's own check) and the handler (422 with a code and a pointer).
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateInput } from "@opt2-tealbrick/manifest";
import { type Caller, type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { handlers, manifest, toTbError } from "../src/app.ts";
import * as cycles from "../src/cycles.ts";
import * as r from "../src/routines.ts";
import * as store from "../src/store.ts";
import { AGENT_A, AGENT_B, call, ctxFor, migratedDb, OWNER } from "./helpers.ts";

const H = handlers as unknown as Parameters<typeof call>[0];
const BOUND: Caller = { ...AGENT_A, mode: "bound" };
const T = (s: string) => Date.parse(s);
const D0 = T("2026-10-12T06:00:00Z");
const NOW = T("2026-10-12T08:00:30Z");
const READ = [{ product: "kanban", operations: ["issues_list"], crud: ["read" as const] }];
const CANARY = "CANARY-lesson-7f3a9c";

function setup(): { db: Db; wf: string; draftId: string; automationId: string; occ: string } {
  const db = migratedDb();
  const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "Morning rollup", summary: "", instruction: "Roll up.", trigger: "", steps: [], allowed: READ } }, D0);
  const wf = store.promote(db, d.id, d.revision, D0).workflow.id;
  const a = r.setAutomation(db, { workflowId: wf, agentId: BOUND.id, cron: "0 8 * * *" }, D0);
  const occ = r.dueJobs(db, BOUND.id, NOW)[0]?.occurrence as string;
  assert.equal(r.claim(db, BOUND, occ, NOW).claimed, true);
  return { db, wf, draftId: d.id, automationId: a.id, occ };
}
/** A further claimed run of the same workflow (inserted like routine_claim does), to have several runs to roll up. */
function claimedRun(db: Db, wf: string, automationId: string, day: number, version: number): string {
  const due = T(`2026-10-${String(day).padStart(2, "0")}T08:00:00Z`);
  const occ = r.occurrenceOf(automationId, 1, due);
  db.prepare("INSERT INTO routine_runs (occurrence, automation_id, revision, due_at, status, claimed_by, workflow_id, workflow_version, claimed_at, updated_at) VALUES (?, ?, 1, ?, 'claimed', ?, ?, ?, ?, ?)").run(
    occ,
    automationId,
    due,
    BOUND.id,
    wf,
    version,
    due + 1000,
    due + 1000,
  );
  return occ;
}
const metricsRows = (db: Db): Record<string, unknown>[] => db.prepare("SELECT * FROM run_metrics ORDER BY occurrence").all();
const reportOp = manifest.operations.find((o) => o.id === "routine_report") as Parameters<typeof validateInput>[0];
const schemaErrors = (metrics: unknown): string[] => {
  const v = validateInput(reportOp, { occurrence: "a".repeat(64), status: "completed", metrics } as never);
  return v.ok ? [] : v.errors.map((e) => e.path);
};
const refusal = (fn: () => unknown): TbError | null => {
  try {
    fn();
    return null;
  } catch (e) {
    const t = toTbError(e);
    assert.ok(t instanceof TbError, "a TbError");
    return t as TbError;
  }
};

// ── stored, rolled up ──

test("quiet: metrics on the completing report are stored once and roll up in the version's cycle", async () => {
  const { db, wf, occ } = setup();
  const out = await call<K.RoutineReportOutput>(
    H,
    "routine_report",
    { occurrence: occ, status: "completed", summary: "done", metrics: { ok: true, minutes: 12.5, retries: 2, questions_to_martin: 1, lessons: ["  Check the calendar first  ", "Ask once"] } },
    ctxFor(db, BOUND),
  );
  assert.equal(out.status, "completed");
  assert.deepEqual(Object.keys(out).sort(), ["automationId", "claimedBy", "dueAt", "kanbanIssueId", "kanbanSync", "occurrence", "status", "summary", "updatedAt", "workflowId", "workflowVersion"], "the answer to the agent is the run, unchanged");
  const [row] = metricsRows(db);
  assert.deepEqual({ ...row }, { occurrence: occ, ok: 1, minutes: 12.5, retries: 2, questions_to_martin: 1, lessons: JSON.stringify(["Check the calendar first", "Ask once"]), created_at: row?.created_at });
  const c = cycles.getCycle(db, wf, 1, NOW);
  assert.deepEqual(c.runMetrics, { runs: 1, okRuns: 1, okRatio: 1, minutesMedian: 12.5, minutesMean: 12.5, retriesTotal: 2, questionsToMartinTotal: 1, lessonCount: 2, namedMetrics: [] });
  assert.equal(c.counts.completed, 1, "the run counts as before");
});

test("a failed run can carry ok: false; fields that are left out stay null and count as zero", () => {
  const { db, wf, occ } = setup();
  r.report(db, BOUND.id, occ, "failed", "x", NOW, { ok: false, minutes: 0 });
  assert.deepEqual({ ...metricsRows(db)[0] }, { occurrence: occ, ok: 0, minutes: 0, retries: null, questions_to_martin: null, lessons: "[]", created_at: metricsRows(db)[0]?.created_at });
  assert.deepEqual(cycles.getCycle(db, wf, 1, NOW).runMetrics, { runs: 1, okRuns: 0, okRatio: 0, minutesMedian: 0, minutesMean: 0, retriesTotal: 0, questionsToMartinTotal: 0, lessonCount: 0, namedMetrics: [] });
});

test("rollup per version: ok ratio, median (lower middle), mean, totals; runs without metrics and other versions are not counted; two versions compare", () => {
  const { db, wf, draftId, automationId, occ } = setup();
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 10, retries: 1, lessons: ["a"] });
  const o2 = claimedRun(db, wf, automationId, 13, 1);
  r.report(db, BOUND.id, o2, "failed", null, NOW, { ok: false, minutes: 40, questions_to_martin: 2 });
  const o3 = claimedRun(db, wf, automationId, 14, 1);
  r.report(db, BOUND.id, o3, "completed", null, NOW, { ok: true, minutes: 20, retries: 3, lessons: ["b", "c"] });
  const o4 = claimedRun(db, wf, automationId, 15, 1);
  r.report(db, BOUND.id, o4, "completed", null, NOW); // no metrics: counted as a completed run, not in the rollup
  // version 2, promoted after these runs
  const d = store.getDraft(db, draftId);
  const u = store.updateDraft(db, d.id, d.revision, { instruction: "Roll up, v2." }, T("2026-10-16T00:00:00Z"));
  store.promote(db, d.id, u.revision, T("2026-10-16T00:00:00Z"));
  const o5 = claimedRun(db, wf, automationId, 17, 2);
  r.report(db, BOUND.id, o5, "completed", null, NOW, { ok: true, minutes: 6, retries: 0, lessons: ["only v2"] });
  const o6 = claimedRun(db, wf, automationId, 18, 2);
  r.report(db, BOUND.id, o6, "completed", null, NOW, { ok: true, minutes: 8 });

  const [v1, v2] = cycles.workflowCycles(db, wf, NOW);
  // v1: minutes 10, 40, 20 → median (lower middle of 10, 20, 40) 20, mean 23.333333
  assert.deepEqual(v1?.runMetrics, { runs: 3, okRuns: 2, okRatio: 0.666667, minutesMedian: 20, minutesMean: 23.333333, retriesTotal: 4, questionsToMartinTotal: 2, lessonCount: 3, namedMetrics: [] });
  assert.equal(v1?.counts.completed, 3, "all completed runs, with or without metrics");
  // v2: minutes 6, 8 → median 6 (lower middle), mean 7
  assert.deepEqual(v2?.runMetrics, { runs: 2, okRuns: 2, okRatio: 1, minutesMedian: 6, minutesMean: 7, retriesTotal: 0, questionsToMartinTotal: 0, lessonCount: 1, namedMetrics: [] });
  // the same two cycles through the owner ops: comparable side by side, parentVersion links them
  assert.equal(v2?.parentVersion, 1);
});

test("the owner reads the lessons of ONE version with cycle_get: only that version, newest report first", async () => {
  const { db, wf, draftId, automationId, occ } = setup();
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, lessons: ["v1 first"] });
  const o2 = claimedRun(db, wf, automationId, 13, 1);
  r.report(db, BOUND.id, o2, "completed", null, NOW + 60_000, { ok: true, minutes: 1, lessons: ["v1 second", "v1 third"] });
  const d = store.getDraft(db, draftId);
  const u = store.updateDraft(db, d.id, d.revision, { instruction: "v2" }, T("2026-10-14T00:00:00Z"));
  store.promote(db, d.id, u.revision, T("2026-10-14T00:00:00Z"));
  const o3 = claimedRun(db, wf, automationId, 15, 2);
  r.report(db, BOUND.id, o3, "completed", null, NOW, { ok: true, minutes: 1, lessons: ["v2 only"] });

  const one = await call<K.CycleGetOutput>(H, "cycle_get", { workflowId: wf, version: 1 }, ctxFor(db, OWNER));
  assert.deepEqual(one.lessons.map((l) => l.text), ["v1 second", "v1 third", "v1 first"]);
  assert.equal(one.lessons[0]?.occurrence, o2);
  assert.equal(one.cycle.runMetrics.lessonCount, 3);
  const two = await call<K.CycleGetOutput>(H, "cycle_get", { workflowId: wf, version: 2 }, ctxFor(db, OWNER));
  assert.deepEqual(two.lessons.map((l) => l.text), ["v2 only"]);
  const list = await call<K.CyclesListOutput>(H, "cycles_list", {}, ctxFor(db, OWNER));
  assert.deepEqual(list.cycles.map((c) => [c.version, c.runMetrics.runs]), [[2, 1], [1, 2]]);
  assert.ok(!JSON.stringify(list).includes("v1 first"), "the list carries counts, never the text");
});

// ── fires: bad payloads ──

test("fires (schema layer): every bound violated is refused with a pointer; the bounds themselves pass", () => {
  const ok = { ok: true, minutes: 1 };
  assert.deepEqual(schemaErrors(ok), []);
  assert.deepEqual(schemaErrors({ ok: false, minutes: 0, retries: 0, questions_to_martin: 0, lessons: [] }), [], "lower bounds pass");
  assert.deepEqual(schemaErrors({ ok: true, minutes: 10080, retries: 1000, questions_to_martin: 1000, lessons: Array(20).fill("x".repeat(280)), pipeline: "wfl_x", version: 1 }), [], "upper bounds pass");
  const cases: [string, unknown, string][] = [
    ["ok missing", { minutes: 1 }, "/metrics/ok"],
    ["ok not boolean", { ok: "yes", minutes: 1 }, "/metrics/ok"],
    ["minutes missing", { ok: true }, "/metrics/minutes"],
    ["minutes negative", { ok: true, minutes: -0.5 }, "/metrics/minutes"],
    ["minutes over a week", { ok: true, minutes: 10080.5 }, "/metrics/minutes"],
    ["minutes a string", { ok: true, minutes: "5" }, "/metrics/minutes"],
    ["retries negative", { ok: true, minutes: 1, retries: -1 }, "/metrics/retries"],
    ["retries over 1000", { ok: true, minutes: 1, retries: 1001 }, "/metrics/retries"],
    ["retries not whole", { ok: true, minutes: 1, retries: 1.5 }, "/metrics/retries"],
    ["questions negative", { ok: true, minutes: 1, questions_to_martin: -1 }, "/metrics/questions_to_martin"],
    ["questions over 1000", { ok: true, minutes: 1, questions_to_martin: 1001 }, "/metrics/questions_to_martin"],
    ["questions not whole", { ok: true, minutes: 1, questions_to_martin: 0.5 }, "/metrics/questions_to_martin"],
    ["21 lessons", { ok: true, minutes: 1, lessons: Array(21).fill("x") }, "/metrics/lessons"],
    ["empty lesson", { ok: true, minutes: 1, lessons: ["fine", ""] }, "/metrics/lessons/1"],
    ["blank lesson", { ok: true, minutes: 1, lessons: ["   \n"] }, "/metrics/lessons/0"],
    ["281 characters", { ok: true, minutes: 1, lessons: ["x".repeat(281)] }, "/metrics/lessons/0"],
    ["lesson not a string", { ok: true, minutes: 1, lessons: [7] }, "/metrics/lessons/0"],
    ["unknown field", { ok: true, minutes: 1, cost: 3 }, "/metrics"],
    ["version zero", { ok: true, minutes: 1, version: 0 }, "/metrics/version"],
    ["pipeline empty", { ok: true, minutes: 1, pipeline: "" }, "/metrics/pipeline"],
    ["pipeline over 64", { ok: true, minutes: 1, pipeline: "p".repeat(65) }, "/metrics/pipeline"],
    ["zero-width lesson", { ok: true, minutes: 1, lessons: ["\u200b"] }, "/metrics/lessons/0"],
    ["metrics not an object", "ok", "/metrics"],
  ];
  for (const [name, metrics, pointer] of cases) assert.ok(schemaErrors(metrics).includes(pointer), `${name}: ${pointer} in ${JSON.stringify(schemaErrors(metrics))}`);
});

test("fires (handler layer): a direct call cannot store a value outside the bounds; 422 validation_failed with a pointer; nothing changes", () => {
  const { db, occ } = setup();
  const bad: [unknown, string][] = [
    [{ ok: true, minutes: 10081 }, "/metrics/minutes"],
    [{ ok: true, minutes: Number.NaN }, "/metrics/minutes"],
    [{ ok: "yes", minutes: 1 }, "/metrics/ok"],
    [{ ok: true, minutes: 1, retries: 1.5 }, "/metrics/retries"],
    [{ ok: true, minutes: 1, questions_to_martin: 1001 }, "/metrics/questions_to_martin"],
    [{ ok: true, minutes: 1, lessons: Array(21).fill("x") }, "/metrics/lessons"],
    [{ ok: true, minutes: 1, lessons: ["ok", "  "] }, "/metrics/lessons/1"],
    [{ ok: true, minutes: 1, lessons: [`${"x".repeat(281)}`] }, "/metrics/lessons/0"],
  ];
  for (const [metrics, pointer] of bad) {
    const t = refusal(() => r.report(db, BOUND.id, occ, "completed", null, NOW, metrics as r.MetricsInput));
    assert.ok(t, JSON.stringify(metrics));
    assert.deepEqual([t?.code, t?.httpStatus, (t?.details as { pointer?: string } | undefined)?.pointer], ["validation_failed", 422, pointer]);
  }
  assert.equal(r.getRun(db, occ)?.status, "claimed", "a refused report changes nothing");
  assert.deepEqual(metricsRows(db), []);
  // trimmed length decides: 280 characters plus spaces around is fine
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, lessons: [`  ${"x".repeat(280)}  `] });
  assert.equal(JSON.parse(String(metricsRows(db)[0]?.lessons))[0].length, 280);
});

test("quiet: a Henry-style RunReport (its own pipeline id and contract version) is accepted and stored against the run's own workflow and version", () => {
  const { db, wf, occ } = setup();
  const henry = { pipeline: "p1-daily-tidbit", version: 7, ok: true, minutes: 3 };
  assert.deepEqual(schemaErrors(henry), [], "the schema accepts them");
  assert.equal(r.report(db, BOUND.id, occ, "completed", null, NOW, henry).changed, true);
  // nothing of pipeline / version is stored: the run row is the truth
  assert.deepEqual(Object.keys(metricsRows(db)[0] ?? {}).sort(), ["created_at", "lessons", "minutes", "occurrence", "ok", "questions_to_martin", "retries"]);
  assert.equal(metricsRows(db)[0]?.occurrence, occ);
  const c = cycles.getCycle(db, wf, 1, NOW);
  assert.equal(c.runMetrics.runs, 1, "counted in the run's own workflow version (1), not in version 7");
  assert.equal(cycles.workflowCycles(db, wf, NOW).length, 1);
});

test("a lesson counts code points like the schema: 200 emoji pass, 281 are refused (schema and handler)", () => {
  const emoji = (n: number) => "😀".repeat(n);
  assert.equal(emoji(200).length, 400, "400 UTF-16 units");
  assert.deepEqual(schemaErrors({ ok: true, minutes: 1, lessons: [emoji(200), emoji(280)] }), []);
  assert.ok(schemaErrors({ ok: true, minutes: 1, lessons: [emoji(281)] }).includes("/metrics/lessons/0"));
  const { db, occ } = setup();
  const t = refusal(() => r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, lessons: [emoji(281)] }));
  assert.deepEqual([t?.code, t?.httpStatus, (t?.details as { pointer?: string } | undefined)?.pointer], ["validation_failed", 422, "/metrics/lessons/0"]);
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, lessons: [emoji(200), `  ${emoji(280)}  `] });
  assert.deepEqual(JSON.parse(String(metricsRows(db)[0]?.lessons)).map((l: string) => Array.from(l).length), [200, 280]);
});

test("a lesson must show something: zero-width space, braille blank and Hangul filler are blank; punctuation, digits and symbols count", () => {
  const blanks = ["\u200b", "\u2800", "\u3164", " \u200b\u2800 ", "\u115f\u1160\uffa0", "\u200d\u2060\ufeff"];
  const { db, occ } = setup();
  for (const b of blanks) {
    assert.ok(schemaErrors({ ok: true, minutes: 1, lessons: [b] }).includes("/metrics/lessons/0"), `schema refuses U+${b.codePointAt(0)?.toString(16)}`);
    const t = refusal(() => r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, lessons: [b] }));
    assert.deepEqual([t?.code, (t?.details as { pointer?: string } | undefined)?.pointer], ["validation_failed", "/metrics/lessons/0"], `handler refuses U+${b.codePointAt(0)?.toString(16)}`);
  }
  assert.equal(r.getRun(db, occ)?.status, "claimed");
  const shown = [".", "5", "✓", "é", "日本", "\u200b ok \u200b", "😀"];
  assert.deepEqual(schemaErrors({ ok: true, minutes: 1, lessons: shown }), []);
  assert.equal(r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, lessons: shown }).changed, true);
});

test("retry rule: a refused report with metrics leaves the run claimed; the same report without metrics ends it", () => {
  const { db, wf, occ } = setup();
  const bad = { ok: true, minutes: 99999, lessons: ["fine"] };
  assert.equal(refusal(() => r.report(db, BOUND.id, occ, "completed", "Rollup written.", NOW, bad))?.code, "validation_failed");
  assert.deepEqual([r.getRun(db, occ)?.status, r.getRun(db, occ)?.summary], ["claimed", null], "nothing of the refused report was applied");
  assert.deepEqual(metricsRows(db), []);
  const again = r.report(db, BOUND.id, occ, "completed", "Rollup written.", NOW);
  assert.deepEqual([again.changed, again.run.status, again.run.summary], [true, "completed", "Rollup written."]);
  assert.deepEqual(metricsRows(db), [], "the run ended without metrics");
  assert.equal(cycles.getCycle(db, wf, 1, NOW).counts.completed, 1);
  // the same holds for the non-terminal refusal
  const o2 = claimedRun(db, wf, r.getRun(db, occ)?.automationId as string, 13, 1);
  assert.equal(refusal(() => r.report(db, BOUND.id, o2, "dispatched", null, NOW, { ok: true, minutes: 1 }))?.code, "metrics_need_terminal_status");
  assert.equal(r.getRun(db, o2)?.status, "claimed");
  assert.equal(r.report(db, BOUND.id, o2, "dispatched", null, NOW).changed, true);
});

test("fires: metrics on a status that does not end the run are 422 metrics_need_terminal_status, even on a repeat; the report is not applied", () => {
  const { db, occ } = setup();
  const m = { ok: true, minutes: 3 };
  for (const status of ["dispatched", "uncertain"] as const) {
    const t = refusal(() => r.report(db, BOUND.id, occ, status, null, NOW, m));
    assert.deepEqual([t?.code, t?.httpStatus], ["metrics_need_terminal_status", 422], status);
    assert.equal(r.getRun(db, occ)?.status, "claimed", `${status} with metrics did not move the run`);
  }
  r.report(db, BOUND.id, occ, "dispatched", null, NOW);
  assert.equal(refusal(() => r.report(db, BOUND.id, occ, "dispatched", null, NOW, m))?.code, "metrics_need_terminal_status", "a repeat of dispatched with metrics is refused too");
  assert.deepEqual(metricsRows(db), []);
  assert.equal(r.report(db, BOUND.id, occ, "completed", null, NOW, m).changed, true, "the completing report takes them");
});

test("a late report of a run the sweep made uncertain may carry metrics", () => {
  const { db, wf, occ } = setup();
  const late = NOW + 11 * 60_000;
  r.sweep(db, late);
  assert.equal(r.getRun(db, occ)?.status, "uncertain");
  assert.equal(r.report(db, BOUND.id, occ, "completed", "late", late + 1000, { ok: true, minutes: 9 }).changed, true);
  assert.equal(cycles.getCycle(db, wf, 1, late).runMetrics.runs, 1);
});

// ── backward compatible, idempotent ──

test("quiet: a report without metrics works as before and stores nothing; the rollup is empty", async () => {
  const { db, wf, occ } = setup();
  const out = await call<K.RoutineReportOutput>(H, "routine_report", { occurrence: occ, status: "completed", summary: "Rollup written." }, ctxFor(db, BOUND));
  assert.equal(out.status, "completed");
  assert.deepEqual(metricsRows(db), []);
  assert.deepEqual(cycles.getCycle(db, wf, 1, NOW).runMetrics, { runs: 0, okRuns: 0, okRatio: null, minutesMedian: null, minutesMean: null, retriesTotal: 0, questionsToMartinTotal: 0, lessonCount: 0, namedMetrics: [] });
  assert.deepEqual(schemaErrors(undefined), [], "the schema does not require metrics");
});

test("a repeated terminal report is a no-op: the same or different metrics never overwrite what the first report stored", () => {
  const { db, occ } = setup();
  const first = { ok: true, minutes: 7, retries: 1, lessons: ["first"] };
  assert.equal(r.report(db, BOUND.id, occ, "completed", "a", NOW, first).changed, true);
  const stored = metricsRows(db);
  assert.equal(r.report(db, BOUND.id, occ, "completed", "a", NOW + 5000, first).changed, false, "same payload");
  assert.equal(r.report(db, BOUND.id, occ, "completed", "b", NOW + 6000, { ok: false, minutes: 99, lessons: ["other"] }).changed, false, "different payload");
  assert.equal(r.report(db, BOUND.id, occ, "completed", null, NOW + 7000).changed, false, "no payload");
  assert.deepEqual(metricsRows(db), stored, "the stored row is untouched");
  assert.equal(r.getRun(db, occ)?.summary, "a", "the run is untouched too");
  assert.equal(refusal(() => r.report(db, BOUND.id, occ, "completed", null, NOW + 8000, { ok: true, minutes: -1 }))?.code, "validation_failed", "a bad payload is still refused on a repeat");
  assert.equal(refusal(() => r.report(db, BOUND.id, occ, "failed", null, NOW + 9000, { ok: true, minutes: 1 }))?.code, "conflict", "terminal states stay final");
});

test("a run that finished without metrics does not take them from a later repeat (the first terminal report decides)", () => {
  const { db, occ } = setup();
  r.report(db, BOUND.id, occ, "completed", null, NOW);
  assert.equal(r.report(db, BOUND.id, occ, "completed", null, NOW + 1000, { ok: true, minutes: 3 }).changed, false);
  assert.deepEqual(metricsRows(db), []);
});

test("a refused report rolls back as a whole: no status change, no Kanban sync mark", () => {
  const { db, occ } = setup();
  db.prepare("UPDATE routine_runs SET kanban_issue_id = 'iss_1' WHERE occurrence = ?").run(occ);
  assert.ok(refusal(() => r.report(db, BOUND.id, occ, "completed", "x", NOW, { ok: true, minutes: 99999 })));
  const run = r.getRun(db, occ);
  assert.deepEqual([run?.status, run?.summary, run?.kanbanSync], ["claimed", null, "none"]);
});

// ── C88 / L12: no agent op returns lessons or metrics ──

test("no agent-audience op can return lessons or metrics: manifest outputs carry none, and answers to every agent hold none (canary)", async () => {
  const { db, wf, automationId, occ } = setup();
  // metrics with a canary lesson, from the claiming agent; a second run of another agent's schedule would be a leak target too
  r.report(db, BOUND.id, occ, "completed", "done", NOW, { ok: true, minutes: 31.25, retries: 7, questions_to_martin: 5, lessons: [CANARY], metrics: { canary_metric_zz: 987654.5 } });
  const o2 = claimedRun(db, wf, automationId, 13, 1);
  r.report(db, BOUND.id, o2, "completed", null, NOW, { ok: true, minutes: 12.125, lessons: [`${CANARY}-2`] });

  // static: no output schema of an agent op names a metrics or lessons field
  const agentOps = manifest.operations.filter((o) => o.audience === "agent");
  assert.ok(agentOps.length >= 7);
  for (const o of agentOps) assert.doesNotMatch(JSON.stringify((o as { output?: unknown }).output), /lessons|runMetrics|questions_to_martin|minutesMedian|okRatio/, `${o.id} output`);
  // the metrics input exists only on routine_report (an agent WRITES it; nothing returns it)
  assert.deepEqual(agentOps.filter((o) => JSON.stringify((o as { input?: unknown }).input).includes("lessons")).map((o) => o.id), ["routine_report"]);
  // the readers are person ops
  for (const id of ["cycles_list", "cycle_get", "runs_list"]) assert.equal(manifest.operations.find((o) => o.id === id)?.audience, "person", id);
  assert.deepEqual(manifest.operations.filter((o) => JSON.stringify((o as { output?: unknown }).output).includes("lessons")).map((o) => o.id), ["cycle_get"], "lessons come out of exactly one op");

  // dynamic: every agent op, as the claiming (Bound) agent, another agent and a Free agent
  const callers: Caller[] = [BOUND, { ...AGENT_B, mode: "bound" }, AGENT_B];
  const wfBody = store.getWorkflow(db, wf);
  const seen: unknown[] = [];
  for (const who of callers) {
    const ctx = ctxFor(db, who);
    seen.push(await call(H, "routines_due", {}, ctx));
    seen.push(await call(H, "routine_claim", { occurrence: occ }, ctx));
    seen.push(await call(H, "workflow_get", { id: wf }, ctx));
    seen.push(await call(H, "suggestions_list", {}, ctx));
  }
  // the reporter itself: a repeat of its own terminal report answers the run, not the metrics; another agent cannot touch it
  seen.push(await call(H, "routine_report", { occurrence: occ, status: "completed", metrics: { ok: false, minutes: 1, lessons: ["x"] } }, ctxFor(db, BOUND)));
  await assert.rejects(call(H, "routine_report", { occurrence: occ, status: "completed" }, ctxFor(db, { ...AGENT_B, mode: "bound" })), /No run of yours/);
  assert.ok(wfBody.id);
  const text = JSON.stringify(seen);
  for (const needle of [CANARY, "31.25", "12.125", "lessons", "runMetrics", "questions_to_martin", "minutesMedian", "canary_metric_zz", "987654.5", "namedMetrics"]) assert.ok(!text.includes(needle), `no agent answer contains ${needle}`);
  // and the owner does see it (the test would pass trivially if nothing were stored)
  const owner = await call<K.CycleGetOutput>(H, "cycle_get", { workflowId: wf, version: 1 }, ctxFor(db, OWNER));
  assert.deepEqual(owner.lessons.map((l) => l.text).sort(), [CANARY, `${CANARY}-2`]);
  assert.deepEqual(owner.cycle.runMetrics.namedMetrics, [{ name: "canary_metric_zz", reports: 1, median: 987654.5, mean: 987654.5, min: 987654.5, max: 987654.5 }]);
});

test("the receipt text of routine_report never carries the metrics", () => {
  const spec = (handlers as unknown as Record<string, unknown>).routine_report as unknown as { redact: (i: unknown, o?: unknown) => string };
  const text = spec.redact({ occurrence: "a".repeat(64), status: "completed", metrics: { ok: true, minutes: 1, lessons: [CANARY] } });
  assert.equal(text, "Run aaaaaaaaaaaa: completed (with metrics)");
  assert.equal(spec.redact({ occurrence: "a".repeat(64), status: "completed" }), "Run aaaaaaaaaaaa: completed");
});

// ── named per-pipeline metrics (RunReport.metrics, agent-stack 640a4aa) ──

const namedRows = (db: Db): Record<string, unknown>[] => db.prepare("SELECT * FROM run_metric_values ORDER BY occurrence, name").all();

test("quiet: the named map is stored per run in the same transaction and rolled up BY NAME per version (reports, median nearest-rank, mean, min, max); names sort; runs that left a name out are not counted for it", () => {
  const { db, wf, draftId, automationId, occ } = setup();
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 5, metrics: { candidates_seen: 12, shortlist_size: 4 } });
  const o2 = claimedRun(db, wf, automationId, 13, 1);
  r.report(db, BOUND.id, o2, "completed", null, NOW, { ok: true, minutes: 5, metrics: { candidates_seen: 20.5 } });
  const o3 = claimedRun(db, wf, automationId, 14, 1);
  r.report(db, BOUND.id, o3, "failed", null, NOW, { ok: false, minutes: 5, metrics: { candidates_seen: 3, shortlist_size: 0 } });
  const o4 = claimedRun(db, wf, automationId, 15, 1);
  r.report(db, BOUND.id, o4, "completed", null, NOW, { ok: true, minutes: 5 }); // metrics without the map
  const o5 = claimedRun(db, wf, automationId, 16, 1);
  r.report(db, BOUND.id, o5, "completed", null, NOW, { ok: true, minutes: 5, metrics: {} }); // an empty map stores no value
  assert.deepEqual(namedRows(db).map((x) => `${x.name}=${x.value}`).sort(), ["candidates_seen=12", "candidates_seen=20.5", "candidates_seen=3", "shortlist_size=0", "shortlist_size=4"]);
  assert.equal(namedRows(db).filter((x) => x.occurrence === o4 || x.occurrence === o5).length, 0);
  const d = store.getDraft(db, draftId);
  const u = store.updateDraft(db, d.id, d.revision, { instruction: "v2" }, T("2026-10-17T00:00:00Z"));
  store.promote(db, d.id, u.revision, T("2026-10-17T00:00:00Z"));
  const o6 = claimedRun(db, wf, automationId, 18, 2);
  r.report(db, BOUND.id, o6, "completed", null, NOW, { ok: true, minutes: 5, metrics: { candidates_seen: 99 } });
  const [v1, v2] = cycles.workflowCycles(db, wf, NOW);
  // candidates_seen over 12, 20.5, 3: sorted 3, 12, 20.5 → median 12 (middle), mean 11.833333, min 3, max 20.5
  assert.deepEqual(v1?.runMetrics.namedMetrics, [
    { name: "candidates_seen", reports: 3, median: 12, mean: 11.833333, min: 3, max: 20.5 },
    { name: "shortlist_size", reports: 2, median: 0, mean: 2, min: 0, max: 4 },
  ]);
  assert.deepEqual(v2?.runMetrics.namedMetrics, [{ name: "candidates_seen", reports: 1, median: 99, mean: 99, min: 99, max: 99 }], "another version has its own numbers");
  assert.equal(v1?.runMetrics.runs, 5, "the core rollup still counts every report with metrics");
});

test("the owner ops carry the rollup by name; the manifest output schema accepts it", async () => {
  const { db, wf, automationId, occ } = setup();
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 5, metrics: { candidates_seen: 12 } });
  const list = await call<K.CyclesListOutput>(H, "cycles_list", {}, ctxFor(db, OWNER));
  assert.equal(list.cycles[0]?.runMetrics.namedMetrics[0]?.name, "candidates_seen");
  const one = await call<K.CycleGetOutput>(H, "cycle_get", { workflowId: wf, version: 1 }, ctxFor(db, OWNER));
  assert.equal(one.cycle.runMetrics.namedMetrics[0]?.median, 12);
  void automationId;
});

test("fires (schema layer): a bad name, a value that is not a number, more than 20 names and a bad issue are refused; 20 names and the name limits pass", () => {
  const base = { ok: true, minutes: 1 };
  const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m_${i}`, i]));
  assert.deepEqual(schemaErrors({ ...base, metrics: twenty, issue: "iss_1" }), []);
  assert.deepEqual(schemaErrors({ ...base, metrics: { ab: 1, [`a${"b".repeat(40)}`]: -0.5, a1_: 1e12, z9: -1e12 } }), [], "2 and 41 characters; negative numbers and the bounds 1e12 and -1e12 pass");
  const cases: [string, unknown][] = [
    ["upper case", { Bad: 1 }],
    ["one character", { a: 1 }],
    ["42 characters", { [`a${"b".repeat(41)}`]: 1 }],
    ["starts with a digit", { "1x": 1 }],
    ["hyphen", { "x-y": 1 }],
    ["space", { "x y": 1 }],
    ["string value", { candidates_seen: "12" }],
    ["null value", { candidates_seen: null }],
    ["boolean value", { candidates_seen: true }],
    ["object value", { candidates_seen: { v: 1 } }],
    ["21 names", { ...twenty, m_20: 1 }],
    ["map is an array", [1, 2]],
  ];
  for (const [why, map] of cases) {
    const v = validateInput(reportOp, { occurrence: "a".repeat(64), status: "completed", metrics: { ...base, metrics: map } } as never);
    assert.equal(v.ok, false, why);
  }
  for (const issue of ["", "x".repeat(65), 7]) assert.equal(validateInput(reportOp, { occurrence: "a".repeat(64), status: "completed", metrics: { ...base, issue } } as never).ok, false, `issue ${JSON.stringify(issue)}`);
});

test("fires (handler layer): a direct call refuses NaN, Infinity, a bad name and more than 20 names with the pointer of the name; nothing is stored", () => {
  const { db, occ } = setup();
  const bad: [Record<string, unknown> | unknown, string][] = [
    [{ candidates_seen: Number.NaN }, "/metrics/metrics/candidates_seen"],
    [{ candidates_seen: Number.POSITIVE_INFINITY }, "/metrics/metrics/candidates_seen"],
    [{ candidates_seen: Number.NEGATIVE_INFINITY }, "/metrics/metrics/candidates_seen"],
    [{ candidates_seen: "12" }, "/metrics/metrics/candidates_seen"],
    [{ Bad: 1 }, "/metrics/metrics/Bad"],
    [{ "x-y": 1 }, "/metrics/metrics/x-y"],
    [{ a: 1 }, "/metrics/metrics/a"],
    [Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`m_${i}`, 1])), "/metrics/metrics"],
    [[1], "/metrics/metrics"],
    [null, "/metrics/metrics"],
  ];
  for (const [map, pointer] of bad) {
    const t = refusal(() => r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, metrics: map as Record<string, number> }));
    assert.ok(t, JSON.stringify(map)?.slice(0, 50));
    assert.deepEqual([t?.code, t?.httpStatus, (t?.details as { pointer?: string } | undefined)?.pointer], ["validation_failed", 422, pointer]);
  }
  assert.equal(r.getRun(db, occ)?.status, "claimed");
  assert.deepEqual(metricsRows(db), []);
  assert.deepEqual(namedRows(db), []);
  // control: the same call with good numbers goes through
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, metrics: { candidates_seen: 0 } });
  assert.deepEqual(namedRows(db).map((x) => [x.name, x.value]), [["candidates_seen", 0]]);
});

test("`issue` is accepted and ignored: the run keeps its own Task Board issue id and no row holds the sent one", () => {
  const { db, occ } = setup();
  db.prepare("UPDATE routine_runs SET kanban_issue_id = 'iss_truth' WHERE occurrence = ?").run(occ);
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, issue: "iss_other", pipeline: "p1", version: 3 });
  assert.equal(r.getRun(db, occ)?.kanbanIssueId, "iss_truth");
  assert.ok(!JSON.stringify([metricsRows(db), namedRows(db), db.prepare("SELECT * FROM routine_runs").all()]).includes("iss_other"));
});

test("terminal only, repeats store nothing, and a refused report rolls the named values back with the run", () => {
  const { db, occ } = setup();
  const t = refusal(() => r.report(db, BOUND.id, occ, "dispatched", null, NOW, { ok: true, minutes: 1, metrics: { candidates_seen: 1 } }));
  assert.equal(t?.code, "metrics_need_terminal_status");
  assert.deepEqual(namedRows(db), []);
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, metrics: { candidates_seen: 1 } });
  assert.equal(r.report(db, BOUND.id, occ, "completed", null, NOW + 1000, { ok: true, minutes: 2, metrics: { candidates_seen: 2, other_one: 5 } }).changed, false);
  assert.deepEqual(namedRows(db).map((x) => [x.name, x.value]), [["candidates_seen", 1]], "the first terminal report decides");
  assert.equal(refusal(() => r.report(db, BOUND.id, occ, "completed", null, NOW + 2000, { ok: true, minutes: 1, metrics: { Bad: 1 } }))?.code, "validation_failed", "a bad map is refused even on a repeat");
});

test("a report without the map is exactly as before: nothing in run_metric_values, namedMetrics empty", () => {
  const { db, wf, occ } = setup();
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 3 });
  assert.equal(metricsRows(db).length, 1);
  assert.deepEqual(namedRows(db), []);
  assert.deepEqual(cycles.getCycle(db, wf, 1, NOW).runMetrics.namedMetrics, []);
});

test("the table itself refuses what the handler would: a 21st name, an infinite value, a bad name, a name for no metrics row", () => {
  const { db, occ } = setup();
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1 });
  const ins = db.prepare("INSERT INTO run_metric_values (occurrence, name, value) VALUES (?, ?, ?)");
  assert.throws(() => ins.run(occ, "Bad", 1), /CHECK/);
  assert.throws(() => ins.run(occ, "a", 1), /CHECK/);
  assert.throws(() => ins.run(occ, "x-y", 1), /CHECK/);
  assert.throws(() => ins.run(occ, "ok_name", Number.POSITIVE_INFINITY), /CHECK/);
  assert.throws(() => ins.run(occ, "ok_name", Number.NaN), /NOT NULL|CHECK/);
  assert.throws(() => ins.run(occ, "ok_name", "abc"), /CHECK/, "text is not a number");
  assert.throws(() => ins.run("a".repeat(64), "ok_name", 1), /FOREIGN KEY/);
  for (let i = 0; i < 20; i++) ins.run(occ, `m_${i}`, i);
  assert.throws(() => ins.run(occ, "m_20", 1), /at most 20/);
  assert.throws(() => ins.run(occ, "m_0", 1), /UNIQUE|PRIMARY|at most 20/);
});

// ── review round: distinct names per version, value bound, name rule, atomicity ──

const twenty = (prefix: string): Record<string, number> => Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${prefix}${String(i).padStart(2, "0")}`, i]));

test("S1: a workflow version keeps at most 20 DISTINCT names over all its runs (422 metric_names_full); existing names still pass; the cycle ops keep answering", async () => {
  const { db, wf, automationId, occ } = setup();
  const first = twenty("na");
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, metrics: first });
  const o2 = claimedRun(db, wf, automationId, 13, 1);
  const t = refusal(() => r.report(db, BOUND.id, o2, "completed", null, NOW, { ok: true, minutes: 1, metrics: { na00: 5, nb01: 2 } }));
  assert.deepEqual([t?.code, t?.httpStatus, (t?.details as { pointer?: string })?.pointer], ["metric_names_full", 422, "/metrics/metrics/nb01"]);
  assert.match(t?.message ?? "", /already has 20 metric names/);
  assert.match(t?.message ?? "", /send the report again without metrics/);
  assert.equal(r.getRun(db, o2)?.status, "claimed", "the run stays claimed");
  assert.equal(namedRows(db).filter((x) => x.occurrence === o2).length, 0, "nothing of the refused report is stored");
  // the same names (all 20 or a few) pass, in the same run version
  r.report(db, BOUND.id, o2, "completed", null, NOW, { ok: true, minutes: 1, metrics: { na00: 5, na19: 7 } });
  const o3 = claimedRun(db, wf, automationId, 14, 1);
  r.report(db, BOUND.id, o3, "completed", null, NOW, { ok: true, minutes: 1, metrics: first });
  // a repeat of a report that is already in carries no new name: no refusal
  assert.equal(r.report(db, BOUND.id, o3, "completed", null, NOW, { ok: true, minutes: 1, metrics: first }).changed, false);
  // the cycle ops answer (their output schema holds at most 20 names)
  const list = await call<K.CyclesListOutput>(H, "cycles_list", {}, ctxFor(db, OWNER));
  assert.equal(list.cycles[0]?.runMetrics.namedMetrics.length, 20);
  assert.equal((await call<K.CycleGetOutput>(H, "cycle_get", { workflowId: wf, version: 1 }, ctxFor(db, OWNER))).cycle.runMetrics.namedMetrics.length, 20);
  // another version of the workflow has its own 20
  const d = store.getDraft(db, store.getWorkflow(db, wf).draftId);
  const u = store.updateDraft(db, d.id, d.revision, { instruction: "v2" }, T("2026-10-16T00:00:00Z"));
  store.promote(db, d.id, u.revision, T("2026-10-16T00:00:00Z"));
  const o4 = claimedRun(db, wf, automationId, 17, 2);
  r.report(db, BOUND.id, o4, "completed", null, NOW, { ok: true, minutes: 1, metrics: twenty("nc") });
  assert.equal((await call<K.CycleGetOutput>(H, "cycle_get", { workflowId: wf, version: 2 }, ctxFor(db, OWNER))).cycle.runMetrics.namedMetrics.length, 20);
  // 19 names then two new ones in ONE report: the first that does not fit is named
  const small = setup();
  r.report(small.db, BOUND.id, small.occ, "completed", null, NOW, { ok: true, minutes: 1, metrics: Object.fromEntries(Object.entries(twenty("nd")).slice(0, 19)) });
  const o5 = claimedRun(small.db, small.wf, small.automationId, 13, 1);
  const t2 = refusal(() => r.report(small.db, BOUND.id, o5, "completed", null, NOW, { ok: true, minutes: 1, metrics: { ne01: 1, ne02: 2 } }));
  assert.equal((t2?.details as { pointer?: string })?.pointer, "/metrics/metrics/ne02", "one new name fits, the second does not");
});

test("S2: values are bounded to 1e12 in the schema, the handler and the table; the mean of several 1e12 values is finite; a non-finite mean falls back to the median", async () => {
  const base = { ok: true, minutes: 1 };
  assert.deepEqual(schemaErrors({ ...base, metrics: { aa: 1e12, bb: -1e12, cc: 0.000001 } }), []);
  for (const v of [1e12 + 1, -1e13, 1e300, 1.7976931348623157e308])
    assert.ok(validateInput(reportOp, { occurrence: "a".repeat(64), status: "completed", metrics: { ...base, metrics: { aa: v } } } as never).ok === false, `schema refuses ${v}`);
  const { db, wf, automationId, occ } = setup();
  for (const v of [1e12 + 1, -1e13, 1e300, 1.7976931348623157e308, -1.7976931348623157e308]) {
    const t = refusal(() => r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, metrics: { aa: v } }));
    assert.deepEqual([t?.code, (t?.details as { pointer?: string })?.pointer], ["validation_failed", "/metrics/metrics/aa"], String(v));
  }
  assert.equal(r.getRun(db, occ)?.status, "claimed");
  r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, metrics: { aa: 1e12 } });
  for (let day = 13; day < 18; day++) r.report(db, BOUND.id, claimedRun(db, wf, automationId, day, 1), "completed", null, NOW, { ok: true, minutes: 1, metrics: { aa: 1e12 } });
  const list = await call<K.CyclesListOutput>(H, "cycles_list", {}, ctxFor(db, OWNER));
  assert.deepEqual(list.cycles[0]?.runMetrics.namedMetrics, [{ name: "aa", reports: 6, median: 1e12, mean: 1e12, min: 1e12, max: 1e12 }]);
  // the table
  const ins = db.prepare("INSERT INTO run_metric_values (occurrence, name, value) VALUES (?, ?, ?)");
  const other = claimedRun(db, wf, automationId, 20, 1);
  r.report(db, BOUND.id, other, "completed", null, NOW, { ok: true, minutes: 1 });
  assert.throws(() => ins.run(other, "bb", 1e12 + 1), /CHECK/);
  assert.throws(() => ins.run(other, "bb", -1e13), /CHECK/);
  ins.run(other, "bb", -1e12);
  // pure: a mean that overflows (cannot be stored today) is the median, never Infinity
  const rolled = cycles.namedRollup([{ named: [["aa", 1e308]] }, { named: [["aa", 1e308]] }]);
  assert.deepEqual(rolled, [{ name: "aa", reports: 2, median: 1e308, mean: 1e308, min: 1e308, max: 1e308 }]);
  assert.ok(Number.isFinite(rolled[0]?.mean));
});

test("S3: the name rule is the same in the schema and the handler for edge names (newline, accents, digits first, length 2 and 41 and 42)", () => {
  const cases: [string, boolean][] = [
    ["ab", true], ["a_", true], ["a".repeat(41), true], ["a1", true],
    ["a", false], ["a-b", false], ["Ab", false], ["aé", false], ["ab\n", false], ["1a", false], ["_a", false], ["a".repeat(42), false], ["a b", false], [" ab", false], ["ab ", false], ["", false],
  ];
  for (const [name, ok] of cases) {
    const schema = validateInput(reportOp, { occurrence: "a".repeat(64), status: "completed", metrics: { ok: true, minutes: 1, metrics: { [name]: 1 } } } as never).ok;
    const { db, occ } = setup();
    const handler = refusal(() => r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, metrics: { [name]: 1 } })) === null;
    assert.equal(schema, ok, `schema: ${JSON.stringify(name)}`);
    assert.equal(handler, ok, `handler: ${JSON.stringify(name)}`);
    if (ok) assert.deepEqual(namedRows(db).map((x) => x.name), [name], "stored under the table's own name CHECK");
  }
});

test("S3: a failure while the named values are written rolls the whole report back (status, run_metrics, values)", () => {
  const { db, occ } = setup();
  db.exec("CREATE TRIGGER boom BEFORE INSERT ON run_metric_values WHEN NEW.name = 'zz' BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => r.report(db, BOUND.id, occ, "completed", null, NOW, { ok: true, minutes: 1, metrics: { aa: 1, zz: 2 } }), /boom/);
  assert.equal(r.getRun(db, occ)?.status, "claimed");
  assert.deepEqual([metricsRows(db).length, namedRows(db).length], [0, 0]);
});
