// Cycle ledger (C250 Release B, E1; G6 §4.2): one cycle = one workflow version, from its promotion until the next
// version of the same workflow is promoted (retiredAt = that version's promotedAt; null = active). The ledger is
// COMPUTED ON READ from workflow_versions, drafts, suggestions and routine_runs: no copy that can go stale. Only eval
// verdicts at a point in time are stored (eval_runs, migrations/0005_eval_runs.sql). Owner-only data (C88 / L12: person
// ops only); it carries no Task Board titles and no cost (E2 later).
//   run → version: by routine_runs.workflow_version; a run without one (0.2.x `missed` rows) belongs to the version that
//   was active at its due time (the highest version promoted at or before due_at).
//   claimed / dispatched runs past their timeout count as uncertain (the listRuns rule, routines.isStale), the others as open.
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { APP_VERSION, cycleEval, type EvalResult, round, THRESHOLDS, type Thresholds, type Verdict, verdictOf } from "./evals.ts";
import { diffSnapshots, type Snapshot } from "./model.ts";
import { isStale, type RunStatus, TERMINAL } from "./routines.ts";
import { StoreError } from "./store.ts";

export const CYCLES_MAX = 500;
export const STORED_EVALS_MAX = 50;

/** One run row as the ledger reads it (ms timestamps). */
export interface LedgerRun {
  automationId: string;
  dueAt: number;
  status: RunStatus;
  workflowVersion: number | null;
  claimedAt: number | null;
  updatedAt: number;
  kanbanIssueId: string | null;
  kanbanSync: string;
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
export interface Cycle extends RunStats {
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

/** The status the owner sees: stale claimed / dispatched runs are uncertain (routines.listRuns rule). */
export function effectiveStatus(r: LedgerRun, now: number): RunStatus {
  return isStale(r.status, r.updatedAt, now) ? "uncertain" : r.status;
}

/** Counts, ratios and medians of one cycle's runs. Pure. */
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
    if ((r.status === "completed" || r.status === "failed") && r.claimedAt !== null) duration.push(r.updatedAt - r.claimedAt);
    if (TERMINAL.has(s) && r.kanbanIssueId !== null) {
      kanbanTerminal++;
      if (r.kanbanSync === "done") kanbanDone++;
    }
    // a claimed run = any status but missed / policy_stale (those are never claimed)
    if (r.status !== "missed" && r.status !== "policy_stale") {
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
  return db
    .prepare(
      `SELECT v.workflow_id, w.title AS workflow_title, v.version, v.snapshot, v.draft_revision, v.promoted_at, d.suggestion_id,
              s.evidence AS s_evidence, s.decided_at AS s_decided_at, s.created_at AS s_created_at
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
      approvalDelayMs: r.s_decided_at === null || r.s_decided_at === undefined ? null : Number(r.s_decided_at) - Number(r.s_created_at),
    }));
}

function runsOf(db: Db, workflowId: string): LedgerRun[] {
  return db
    .prepare("SELECT automation_id, due_at, status, workflow_version, claimed_at, updated_at, kanban_issue_id, kanban_sync FROM routine_runs WHERE workflow_id = ?")
    .all(workflowId)
    .map((r) => ({
      automationId: String(r.automation_id),
      dueAt: Number(r.due_at),
      status: r.status as RunStatus,
      workflowVersion: r.workflow_version === null ? null : Number(r.workflow_version),
      claimedAt: r.claimed_at === null ? null : Number(r.claimed_at),
      updatedAt: Number(r.updated_at),
      kanbanIssueId: r.kanban_issue_id === null ? null : String(r.kanban_issue_id),
      kanbanSync: String(r.kanban_sync),
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

/** Every cycle of one workflow, oldest version first (live evals at `now`). */
export function workflowCycles(db: Db, workflowId: string, now: number = Date.now(), t: Thresholds = THRESHOLDS): Cycle[] {
  const versions = versionRows(db, workflowId);
  const promotions = versions.map((v) => ({ version: v.version, promotedAt: v.promotedAt }));
  const byVersion = new Map<number, LedgerRun[]>(versions.map((v) => [v.version, []]));
  for (const r of runsOf(db, workflowId)) byVersion.get(versionOfRun(r, promotions) ?? -1)?.push(r);
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
    ? db.prepare("SELECT id FROM workflows WHERE id = ?").all(f.workflowId)
    : db.prepare("SELECT id FROM workflows").all();
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
