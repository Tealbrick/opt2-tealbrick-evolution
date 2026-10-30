// Cycle ledger (C250 Release B, E1; G6 §4.2): one cycle = one workflow version, from its promotion until the next
// version of the same workflow is promoted (retiredAt = that version's promotedAt; null = active). The ledger is
// COMPUTED ON READ from workflow_versions, drafts, suggestions and routine_runs: no copy that can go stale. Only eval
// verdicts at a point in time are stored (eval_runs, migrations/0005_eval_runs.sql). Owner-only data (C88 / L12: person
// ops only); it carries no Task Board titles and no cost (E2 later).
//   run → version: by routine_runs.workflow_version; a run without one (0.2.x `missed` rows) belongs to the version that
//   was active at its due time (the highest version promoted at or before due_at).
//   claimed / dispatched runs past their timeout count as uncertain (the listRuns rule, routines.isStale), the others as open.
//   C367 (engine): runs of contract workflows come from `engine_runs` (the Temporal run index, migrations/0009_engine.sql) and
//   count like routine runs (completed, failed; a running one is open and never "uncertain": Temporal is its truth). Skipped
//   polls and cancelled runs are not counted. A contract version that was never promoted through drafts is a cycle too
//   (engine_definitions; its cycle starts when the version was activated). `Cycle.engine` adds the step metrics.
//   C288 R8: the run metrics (run_metrics, written by routine_report) roll up per cycle in `runMetrics`; the lessons of one
//   cycle are read with `cycleLessons` (cycle_get). Free text from agents: person ops only, never an agent op (C88 / L12).
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { APP_VERSION, cycleEval, type EvalResult, round, THRESHOLDS, type Thresholds, type Verdict, verdictOf } from "./evals.ts";
import { diffSnapshots, type Snapshot } from "./model.ts";
import { isStale, type RunStatus, type StoredMetrics, TERMINAL } from "./routines.ts";
import { StoreError } from "./store.ts";

export const CYCLES_MAX = 500;
export const STORED_EVALS_MAX = 50;
export const LESSONS_LIST_MAX = 500;

/** One run row as the ledger reads it (ms timestamps). */
export interface LedgerRun {
  automationId: string;
  dueAt: number;
  status: RunStatus;
  workflowVersion: number | null;
  claimedAt: number | null;
  updatedAt: number;
  /** when the runner's terminal report arrived (0.3.0; null for older rows and for swept runs) */
  reportedAt: number | null;
  kanbanIssueId: string | null;
  kanbanSync: string;
  /** the run's metrics (C288 R8), when its terminal report carried them */
  metrics?: (StoredMetrics & { occurrence: string; createdAt: number }) | null;
  /** C367: a run of the workflow engine (engine_runs); its start and end are the run's own */
  engine?: { durationMs: number | null; stepsDone: number; stepsFailed: number; heldWaits: number; heldWaitMs: number; modelTokens: number };
}
/** Per cycle: what the runners reported with metrics (runs without metrics are not counted here, they are in `counts`). */
export interface MetricsRollup {
  runs: number;
  okRuns: number;
  okRatio: number | null;
  /** nearest-rank median (the lower middle value for an even count), like the other p50 values of the ledger */
  minutesMedian: number | null;
  minutesMean: number | null;
  retriesTotal: number;
  questionsToMartinTotal: number;
  lessonCount: number;
  /** the named per-pipeline numbers (RunReport.metrics), one entry per name, sorted by name */
  namedMetrics: NamedRollup[];
}
/** One named metric over the runs of a cycle that reported it. Median is nearest-rank (lower middle); mean to 6 decimals. */
export interface NamedRollup {
  name: string;
  reports: number;
  median: number;
  mean: number;
  min: number;
  max: number;
}
export interface Lesson {
  occurrence: string;
  reportedAt: string;
  text: string;
}
export interface RunCounts {
  total: number;
  completed: number;
  failed: number;
  uncertain: number;
  missed: number;
  policyStale: number;
  open: number;
}
export interface RunStats {
  counts: RunCounts;
  completedRatio: number | null;
  uncertainRatio: number | null;
  failedRatio: number | null;
  missedRatio: number | null;
  claimLatencyP50Ms: number | null;
  durationP50Ms: number | null;
  kanbanClosedRatio: number | null;
  duplicateClaims: number;
  last10: RunStatus[];
}
export type Trigger = "promotion" | "owner";
export interface StoredEval {
  id: string;
  workflowId: string;
  version: number;
  verdict: Verdict;
  trigger: Trigger;
  results: EvalResult[];
  appVersion: string;
  createdAt: string;
}
/** C367: what the workflow engine's runs of one cycle add (null when the cycle has no engine run). */
export interface EngineRollup {
  runs: number;
  stepsDone: number;
  stepsFailed: number;
  /** failed / (done + failed) steps; null without steps */
  stepFailureRatio: number | null;
  heldWaits: number;
  /** median (nearest rank) of the held-wait time per run that waited; null when no run waited */
  heldWaitP50Ms: number | null;
  modelTokens: number;
}
export interface Cycle extends RunStats {
  runMetrics: MetricsRollup;
  engine: EngineRollup | null;
  /** The metric names the pipeline contract of this version declares, in contract order; null when it was not imported. Owner only. */
  declaredMetrics: string[] | null;
  workflowId: string;
  workflowTitle: string;
  version: number;
  parentVersion: number | null;
  promotedAt: string;
  retiredAt: string | null;
  active: boolean;
  suggestionId: string | null;
  evidenceCount: number;
  approvalDelayMs: number | null;
  draftRevisions: number;
  widensAccess: boolean;
  evalLive: { verdict: Verdict; results: EvalResult[] };
  evalStored: { id: string; verdict: Verdict; trigger: Trigger; createdAt: string } | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const ratio = (num: number, den: number): number | null => (den > 0 ? round(num / den) : null);

/** Nearest-rank median (the lower middle value for an even count); null without values. */
export function p50(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.ceil(s.length / 2) - 1] ?? null;
}

/** The named metrics of one cycle's runs, one entry per name (sorted): reports, median (nearest-rank), mean (6 decimals; the
 *  values are bounded to 1e12 so the sum is finite, and a non-finite mean would fall back to the median), min, max. Pure. */
export function namedRollup(m: readonly { named: readonly [string, number][] }[]): NamedRollup[] {
  const by = new Map<string, number[]>();
  for (const x of m)
    for (const [name, v] of x.named) {
      const a = by.get(name);
      if (a) a.push(v);
      else by.set(name, [v]);
    }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, v]) => {
      const median = p50(v) as number;
      const mean = round(v.reduce((a, b) => a + b, 0) / v.length);
      return { name, reports: v.length, median, mean: Number.isFinite(mean) ? mean : median, min: v.reduce((a, b) => (b < a ? b : a)), max: v.reduce((a, b) => (b > a ? b : a)) };
    });
}

/** Rollup of the metrics of one cycle's runs. Pure. Mean and ratio to 6 decimals; retries and questions count only the
 *  runs that sent them. */
export function metricsRollup(runs: readonly LedgerRun[]): MetricsRollup {
  const m = runs.flatMap((r) => (r.metrics ? [r.metrics] : []));
  const minutes = m.map((x) => x.minutes);
  const okRuns = m.filter((x) => x.ok).length;
  return {
    runs: m.length,
    okRuns,
    okRatio: ratio(okRuns, m.length),
    minutesMedian: p50(minutes),
    minutesMean: m.length ? round(minutes.reduce((a, b) => a + b, 0) / m.length) : null,
    retriesTotal: m.reduce((a, x) => a + (x.retries ?? 0), 0),
    questionsToMartinTotal: m.reduce((a, x) => a + (x.questionsToMartin ?? 0), 0),
    lessonCount: m.reduce((a, x) => a + x.lessons.length, 0),
    namedMetrics: namedRollup(m),
  };
}

/** Rollup of the engine runs of one cycle's runs. Pure. */
export function engineRollup(runs: readonly LedgerRun[]): EngineRollup | null {
  const e = runs.flatMap((r) => (r.engine ? [r.engine] : []));
  if (e.length === 0) return null;
  const done = e.reduce((a, x) => a + x.stepsDone, 0);
  const failed = e.reduce((a, x) => a + x.stepsFailed, 0);
  return {
    runs: e.length,
    stepsDone: done,
    stepsFailed: failed,
    stepFailureRatio: ratio(failed, done + failed),
    heldWaits: e.reduce((a, x) => a + x.heldWaits, 0),
    heldWaitP50Ms: p50(e.filter((x) => x.heldWaits > 0).map((x) => x.heldWaitMs)),
    modelTokens: e.reduce((a, x) => a + x.modelTokens, 0),
  };
}

/** The status the owner sees: stale claimed / dispatched runs are uncertain (routines.listRuns rule). */
export function effectiveStatus(r: LedgerRun, now: number): RunStatus {
  // an engine run that is still running is open: Temporal, not a timeout, says when it ended (a held wait can last days)
  if (r.engine) return r.status;
  return isStale(r.status, r.updatedAt, now) ? "uncertain" : r.status;
}

/** Counts, ratios and medians of one cycle's runs. Pure. durationP50Ms = reported_at - claimed_at of completed / failed
 *  runs with a reported_at (not updated_at: the Task Board close sync moves that later); rows without one (before
 *  0.3.0) are left out. */
export function runStats(runs: readonly LedgerRun[], now: number): RunStats {
  const counts: RunCounts = { total: runs.length, completed: 0, failed: 0, uncertain: 0, missed: 0, policyStale: 0, open: 0 };
  const latency: number[] = [];
  const duration: number[] = [];
  let kanbanTerminal = 0;
  let kanbanDone = 0;
  const claims = new Map<string, number>();
  for (const r of runs) {
    const s = effectiveStatus(r, now);
    if (s === "completed") counts.completed++;
    else if (s === "failed") counts.failed++;
    else if (s === "uncertain") counts.uncertain++;
    else if (s === "missed") counts.missed++;
    else if (s === "policy_stale") counts.policyStale++;
    else counts.open++;
    if (r.claimedAt !== null) latency.push(r.claimedAt - r.dueAt);
    if ((r.status === "completed" || r.status === "failed") && r.claimedAt !== null && r.reportedAt !== null) duration.push(r.reportedAt - r.claimedAt);
    if (r.engine && (r.status === "completed" || r.status === "failed") && r.engine.durationMs !== null) duration.push(r.engine.durationMs);
    if (TERMINAL.has(s) && r.kanbanIssueId !== null) {
      kanbanTerminal++;
      if (r.kanbanSync === "done") kanbanDone++;
    }
    // a claimed run = any status but missed / policy_stale (those are never claimed)
    if (!r.engine && r.status !== "missed" && r.status !== "policy_stale") {
      const k = JSON.stringify([r.automationId, r.dueAt]);
      claims.set(k, (claims.get(k) ?? 0) + 1);
    }
  }
  const terminal = counts.completed + counts.failed + counts.uncertain;
  const newest = [...runs].sort((a, b) => b.dueAt - a.dueAt || b.updatedAt - a.updatedAt).slice(0, 10);
  return {
    counts,
    completedRatio: ratio(counts.completed, terminal),
    uncertainRatio: ratio(counts.uncertain, terminal),
    failedRatio: ratio(counts.failed, terminal),
    missedRatio: ratio(counts.missed, counts.missed + terminal),
    claimLatencyP50Ms: p50(latency),
    durationP50Ms: p50(duration),
    kanbanClosedRatio: ratio(kanbanDone, kanbanTerminal),
    duplicateClaims: [...claims.values()].filter((x) => x > 1).length,
    last10: newest.map((r) => effectiveStatus(r, now)),
  };
}

/** The version a run belongs to: its own workflow_version, else the version active at its due time. */
export function versionOfRun(r: Pick<LedgerRun, "workflowVersion" | "dueAt">, promotions: readonly { version: number; promotedAt: number }[]): number | null {
  if (r.workflowVersion !== null) return r.workflowVersion;
  let v: number | null = null;
  for (const p of promotions) if (p.promotedAt <= r.dueAt && (v === null || p.version > v)) v = p.version;
  return v;
}

interface VersionRow {
  workflowId: string;
  workflowTitle: string;
  version: number;
  snapshot: Snapshot;
  draftRevision: number;
  promotedAt: number;
  suggestionId: string | null;
  evidenceCount: number;
  approvalDelayMs: number | null;
}

function versionRows(db: Db, workflowId: string): VersionRow[] {
  const promoted = promotedVersionRows(db, workflowId);
  const have = new Set(promoted.map((v) => v.version));
  // C367: contract versions saved through the engine (not through drafts); a cycle starts when the version was activated
  const engineOnly = db
    .prepare(
      `SELECT d.workflow_id, d.version, d.title, d.created_at, a.activated_at
         FROM engine_definitions d LEFT JOIN engine_activations a ON a.workflow_id = d.workflow_id AND a.version = d.version
        WHERE d.workflow_id = ? ORDER BY d.version`,
    )
    .all(workflowId)
    .filter((r) => !have.has(Number(r.version)))
    .map(
      (r): VersionRow => ({
        workflowId: String(r.workflow_id),
        workflowTitle: String(r.title),
        version: Number(r.version),
        snapshot: { title: String(r.title), summary: "", instruction: "", trigger: "", steps: [], allowed: [] },
        draftRevision: 1,
        promotedAt: Number(r.activated_at ?? r.created_at),
        suggestionId: null,
        evidenceCount: 0,
        approvalDelayMs: null,
      }),
    );
  return [...promoted, ...engineOnly].sort((a, b) => a.version - b.version);
}

function promotedVersionRows(db: Db, workflowId: string): VersionRow[] {
  return db
    .prepare(
      `SELECT v.workflow_id, w.title AS workflow_title, v.version, v.snapshot, v.draft_revision, v.promoted_at, d.suggestion_id,
              s.evidence AS s_evidence, s.created_at AS s_created_at,
              (SELECT min(e.at) FROM suggestion_events e WHERE e.suggestion_id = s.id AND e.type = 'approved') AS s_approved_at
         FROM workflow_versions v
         JOIN workflows w ON w.id = v.workflow_id
         LEFT JOIN drafts d ON d.id = v.draft_id
         LEFT JOIN suggestions s ON s.id = d.suggestion_id
        WHERE v.workflow_id = ?
        ORDER BY v.version`,
    )
    .all(workflowId)
    .map((r) => ({
      workflowId: String(r.workflow_id),
      workflowTitle: String(r.workflow_title),
      version: Number(r.version),
      snapshot: JSON.parse(String(r.snapshot)) as Snapshot,
      draftRevision: Number(r.draft_revision),
      promotedAt: Number(r.promoted_at),
      suggestionId: r.suggestion_id === null || r.suggestion_id === undefined ? null : String(r.suggestion_id),
      evidenceCount: r.s_evidence === null || r.s_evidence === undefined ? 0 : (JSON.parse(String(r.s_evidence)) as unknown[]).length,
      // the FIRST approval: decided_at is overwritten by every later decision (an archive after promotion, for example)
      approvalDelayMs: r.s_approved_at === null || r.s_approved_at === undefined ? null : Number(r.s_approved_at) - Number(r.s_created_at),
    }));
}

/** Engine runs as ledger rows: completed, failed (also timed out and terminated) and still running; skipped and cancelled do not count. */
function engineRunsOf(db: Db, workflowId: string): LedgerRun[] {
  return db
    .prepare(
      `SELECT run_id, version, status, started_at, ended_at, updated_at, steps_done, steps_failed, held_waits, held_wait_ms, model_tokens,
              (SELECT count(*) FROM engine_steps s WHERE s.workflow_id = r.workflow_id AND s.run_id = r.run_id AND s.status = 'completed') AS n_done,
              (SELECT count(*) FROM engine_steps s WHERE s.workflow_id = r.workflow_id AND s.run_id = r.run_id AND s.status = 'failed') AS n_failed
         FROM engine_runs r WHERE r.workflow_id = ? AND r.status NOT IN ('skipped', 'cancelled') AND r.version IS NOT NULL`,
    )
    .all(workflowId)
    .map((r): LedgerRun => {
      const running = r.status === "running";
      const ended = r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at);
      return {
        automationId: String(r.run_id),
        dueAt: Number(r.started_at),
        status: running ? "dispatched" : r.status === "completed" ? "completed" : "failed",
        workflowVersion: Number(r.version),
        claimedAt: null,
        updatedAt: Number(r.updated_at),
        reportedAt: ended,
        kanbanIssueId: null,
        kanbanSync: "none",
        engine: {
          durationMs: ended === null ? null : ended - Number(r.started_at),
          stepsDone: running ? Number(r.n_done) : Number(r.steps_done),
          stepsFailed: running ? Number(r.n_failed) : Number(r.steps_failed),
          heldWaits: Number(r.held_waits),
          heldWaitMs: Number(r.held_wait_ms),
          modelTokens: Number(r.model_tokens),
        },
      };
    });
}

function runsOf(db: Db, workflowId: string): LedgerRun[] {
  return [...routineRunsOf(db, workflowId), ...engineRunsOf(db, workflowId)];
}

function routineRunsOf(db: Db, workflowId: string): LedgerRun[] {
  const named = new Map<string, [string, number][]>();
  for (const v of db
    .prepare("SELECT v.occurrence, v.name, v.value FROM run_metric_values v JOIN routine_runs r ON r.occurrence = v.occurrence WHERE r.workflow_id = ? ORDER BY v.occurrence, v.name")
    .all(workflowId))
    named.set(String(v.occurrence), [...(named.get(String(v.occurrence)) ?? []), [String(v.name), Number(v.value)]]);
  return db
    .prepare(
      `SELECT r.occurrence, r.automation_id, r.due_at, r.status, r.workflow_version, r.claimed_at, r.updated_at, r.reported_at, r.kanban_issue_id, r.kanban_sync,
              m.ok AS m_ok, m.minutes AS m_minutes, m.retries AS m_retries, m.questions_to_martin AS m_questions, m.lessons AS m_lessons, m.created_at AS m_created_at
         FROM routine_runs r LEFT JOIN run_metrics m ON m.occurrence = r.occurrence
        WHERE r.workflow_id = ?`,
    )
    .all(workflowId)
    .map((r) => ({
      automationId: String(r.automation_id),
      dueAt: Number(r.due_at),
      status: r.status as RunStatus,
      workflowVersion: r.workflow_version === null ? null : Number(r.workflow_version),
      claimedAt: r.claimed_at === null ? null : Number(r.claimed_at),
      updatedAt: Number(r.updated_at),
      reportedAt: r.reported_at === null || r.reported_at === undefined ? null : Number(r.reported_at),
      kanbanIssueId: r.kanban_issue_id === null ? null : String(r.kanban_issue_id),
      kanbanSync: String(r.kanban_sync),
      metrics:
        r.m_ok === null || r.m_ok === undefined
          ? null
          : {
              occurrence: String(r.occurrence),
              ok: Number(r.m_ok) === 1,
              minutes: Number(r.m_minutes),
              retries: r.m_retries === null ? null : Number(r.m_retries),
              questionsToMartin: r.m_questions === null ? null : Number(r.m_questions),
              lessons: JSON.parse(String(r.m_lessons)) as string[],
              named: named.get(String(r.occurrence)) ?? [],
              createdAt: Number(r.m_created_at),
            },
    }));
}

function toStored(r: Record<string, unknown>): StoredEval {
  return {
    id: String(r.id),
    workflowId: String(r.workflow_id),
    version: Number(r.version),
    verdict: r.verdict as Verdict,
    trigger: r.trigger as Trigger,
    results: JSON.parse(String(r.results)) as EvalResult[],
    appVersion: String(r.app_version),
    createdAt: iso(Number(r.created_at)),
  };
}

function latestStored(db: Db, workflowId: string, version: number): Cycle["evalStored"] {
  const r = db.prepare('SELECT id, verdict, "trigger", created_at FROM eval_runs WHERE workflow_id = ? AND version = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(workflowId, version);
  return r ? { id: String(r.id), verdict: r.verdict as Verdict, trigger: r.trigger as Trigger, createdAt: iso(Number(r.created_at)) } : null;
}

/** The runs of one workflow by the version they belong to. */
function attribute(db: Db, workflowId: string): { versions: VersionRow[]; byVersion: Map<number, LedgerRun[]> } {
  const versions = versionRows(db, workflowId);
  const promotions = versions.map((v) => ({ version: v.version, promotedAt: v.promotedAt }));
  const byVersion = new Map<number, LedgerRun[]>(versions.map((v) => [v.version, []]));
  for (const r of runsOf(db, workflowId)) byVersion.get(versionOfRun(r, promotions) ?? -1)?.push(r);
  return { versions, byVersion };
}

/** Every cycle of one workflow, oldest version first (live evals at `now`). */
export function workflowCycles(db: Db, workflowId: string, now: number = Date.now(), t: Thresholds = THRESHOLDS): Cycle[] {
  const { versions, byVersion } = attribute(db, workflowId);
  // C288 R10: the declared metric names of the contract frozen with each version (SQL here: pipeline.ts imports the store, which imports this file)
  const declared = new Map<number, string[]>(
    db
      .prepare("SELECT version, source FROM workflow_version_pipelines WHERE workflow_id = ?")
      .all(workflowId)
      .map((r) => [Number(r.version), ((JSON.parse(String(r.source)) as { metrics?: string[] }).metrics ?? []).slice()]),
  );
  const out: Cycle[] = [];
  versions.forEach((v, i) => {
    const parent = i > 0 ? (versions[i - 1] as VersionRow) : null;
    const next = versions[i + 1];
    const stats = runStats(byVersion.get(v.version) ?? [], now);
    const c: Cycle = {
      workflowId: v.workflowId,
      workflowTitle: v.workflowTitle,
      version: v.version,
      parentVersion: parent ? parent.version : null,
      promotedAt: iso(v.promotedAt),
      retiredAt: next ? iso(next.promotedAt) : null,
      active: !next,
      suggestionId: v.suggestionId,
      evidenceCount: v.evidenceCount,
      approvalDelayMs: v.approvalDelayMs,
      draftRevisions: v.draftRevision,
      widensAccess: parent ? diffSnapshots(parent.snapshot, v.snapshot).widensAccess : false,
      ...stats,
      runMetrics: metricsRollup(byVersion.get(v.version) ?? []),
      engine: engineRollup(byVersion.get(v.version) ?? []),
      declaredMetrics: declared.get(v.version) ?? null,
      evalLive: { verdict: "insufficient", results: [] },
      evalStored: latestStored(db, v.workflowId, v.version),
    };
    const results = cycleEval(c, out[i - 1] ?? null, t, { ts: iso(now) });
    c.evalLive = { verdict: verdictOf(results), results };
    out.push(c);
  });
  return out;
}

/** cycles_list: newest promotion first, at most CYCLES_MAX. */
export function listCycles(db: Db, f: { workflowId?: string } = {}, now: number = Date.now()): Cycle[] {
  const ids = f.workflowId
    ? db.prepare("SELECT id FROM workflows WHERE id = ? UNION SELECT DISTINCT workflow_id AS id FROM engine_definitions WHERE workflow_id = ?").all(f.workflowId, f.workflowId)
    : db.prepare("SELECT id FROM workflows UNION SELECT DISTINCT workflow_id AS id FROM engine_definitions").all();
  return ids
    .flatMap((r) => workflowCycles(db, String(r.id), now))
    .sort((a, b) => b.promotedAt.localeCompare(a.promotedAt) || b.workflowId.localeCompare(a.workflowId) || b.version - a.version)
    .slice(0, CYCLES_MAX);
}

export function getCycle(db: Db, workflowId: string, version: number, now: number = Date.now()): Cycle {
  const c = workflowCycles(db, workflowId, now).find((x) => x.version === version);
  if (!c) throw new StoreError("not_found", `No cycle for workflow ${workflowId} version ${version}.`);
  return c;
}

/** The lessons that the runners of one cycle (workflow version) reported, newest report first, at most LESSONS_LIST_MAX
 *  (the cycle's `runMetrics.lessonCount` is the full count). Owner only: free text written by agents (C88 / L12). */
export function cycleLessons(db: Db, workflowId: string, version: number): Lesson[] {
  const { byVersion } = attribute(db, workflowId);
  const runs = (byVersion.get(version) ?? []).flatMap((r) => (r.metrics?.lessons.length ? [r.metrics] : []));
  runs.sort((a, b) => b.createdAt - a.createdAt || a.occurrence.localeCompare(b.occurrence));
  return runs.flatMap((m) => m.lessons.map((text) => ({ occurrence: m.occurrence, reportedAt: iso(m.createdAt), text }))).slice(0, LESSONS_LIST_MAX);
}

const STORED = 'SELECT id, workflow_id, version, verdict, "trigger", results, app_version, created_at FROM eval_runs';

export function storedEvals(db: Db, workflowId: string, version: number, limit = STORED_EVALS_MAX): StoredEval[] {
  return db.prepare(`${STORED} WHERE workflow_id = ? AND version = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(workflowId, version, limit).map(toStored);
}

/** Stores the eval of one cycle as it is now. `idempotencyKey` (cycle_eval_run): a repeated call with the same key
 *  answers the eval stored the first time and stores nothing new. Called inside the caller's transaction by promote. */
export function storeEval(db: Db, workflowId: string, version: number, trigger: Trigger, now: number = Date.now(), idempotencyKey: string | null = null): StoredEval {
  if (idempotencyKey) {
    const prior = db.prepare(`${STORED} WHERE idempotency_key = ?`).get(idempotencyKey);
    if (prior) {
      const e = toStored(prior);
      if (e.workflowId !== workflowId || e.version !== version) throw new StoreError("conflict", "This idempotency key was used for another cycle.", { workflowId: e.workflowId, version: e.version });
      return e;
    }
  }
  const c = getCycle(db, workflowId, version, now);
  const id = `evr_${ulid(now)}`;
  db.prepare('INSERT INTO eval_runs (id, workflow_id, version, suite, tier, verdict, results, app_version, "trigger", idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    workflowId,
    version,
    `cycle:${workflowId}@v${version}`,
    "T2",
    c.evalLive.verdict,
    JSON.stringify(c.evalLive.results),
    APP_VERSION,
    trigger,
    idempotencyKey,
    now,
  );
  return toStored(db.prepare(`${STORED} WHERE id = ?`).get(id) as Record<string, unknown>);
}
