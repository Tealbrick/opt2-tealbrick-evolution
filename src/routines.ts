// Step B: schedules (automations) and runs, harvested from the v1 avm routines model (STEP-B-DESIGN §1):
//   occurrence = sha256([automationId, revision, dueAt]); claim = INSERT of the run row (primary key) → at-most-once;
//   due older than the misfire grace → missed (several missed periods collapse into one row, never several runs);
//   the due / misfire rule and the cron parser are the ONE shared helper in @opt2-tealbrick/manifest (cronDue,
//   nextCronTime); this file only stores what they decide.
//   claimed > 10 min or dispatched > 30 min without a report → uncertain (never offered again; a late report may
//   still close it). Due times are computed when asked; nothing here runs on a timer and nothing starts an agent.
//   policy_stale (C250): a due occurrence of a wider active version than the recipe the agent has (`policyVersion`) is
//   skipped like a claimed period; the first one per schedule revision and version is recorded as a `policy_stale` run;
//   routines_due leaves it out and routine_claim answers policy_stale. One gate (`policyStale`) decides it for both.
import { createHash } from "node:crypto";
import { CronError, cronDue, nextCronTime, ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { diffSnapshots } from "./model.ts";
import { getVersion, getWorkflow, StoreError, snapshotOf, type Version } from "./store.ts";

export const CLAIMED_TIMEOUT_MS = 10 * 60_000;
export const DISPATCHED_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_GRACE_SEC = 120;
export type RunStatus = "claimed" | "dispatched" | "completed" | "failed" | "missed" | "uncertain" | "policy_stale";
export type ClaimReason = "already_claimed" | "missed" | "not_due" | "paused" | "not_bound" | "version_missing" | "policy_stale";

export interface Automation {
  id: string;
  workflowId: string;
  versionPin: number | null;
  policyVersion: number;
  agentId: string;
  cron: string;
  enabled: boolean;
  misfireGraceSec: number;
  kanbanProject: string | null;
  revision: number;
  nextDueAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface Run {
  occurrence: string;
  automationId: string;
  workflowId: string;
  workflowVersion: number | null;
  dueAt: string;
  status: RunStatus;
  claimedBy: string | null;
  summary: string | null;
  kanbanIssueId: string | null;
  kanbanSync: "none" | "pending" | "done" | "failed";
  updatedAt: string;
}

const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function occurrenceOf(automationId: string, revision: number, dueAt: number): string {
  return createHash("sha256").update(JSON.stringify([automationId, revision, dueAt])).digest("hex");
}

/** Kanban template key of a workflow's run issues (Kanban pattern `^[a-z0-9][a-z0-9._:-]*$`). */
export function runTemplateKey(workflowId: string): string {
  return `evolution:${workflowId.toLowerCase().replaceAll("_", "-")}`;
}

interface Row {
  id: string;
  workflowId: string;
  versionPin: number | null;
  policyVersion: number;
  agentId: string;
  cron: string;
  enabled: boolean;
  grace: number;
  kanbanProject: string | null;
  revision: number;
  nextDueAt: number;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function toRow(r: Record<string, unknown>): Row {
  return {
    id: String(r.id),
    workflowId: String(r.workflow_id),
    versionPin: r.version_pin === null ? null : Number(r.version_pin),
    policyVersion: Number(r.policy_version),
    agentId: String(r.agent_id),
    cron: String(r.cron),
    enabled: Number(r.enabled) === 1,
    grace: Number(r.misfire_grace_sec),
    kanbanProject: strOrNull(r.kanban_project)?.trim() || null, // 0.2.12 stored blanks untrimmed
    revision: Number(r.revision),
    nextDueAt: Number(r.next_due_at),
    deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function view(r: Row): Automation {
  return {
    id: r.id,
    workflowId: r.workflowId,
    versionPin: r.versionPin,
    policyVersion: r.policyVersion,
    agentId: r.agentId,
    cron: r.cron,
    enabled: r.enabled,
    misfireGraceSec: r.grace,
    kanbanProject: r.kanbanProject,
    revision: r.revision,
    nextDueAt: iso(r.nextDueAt),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

function load(db: Db, id: string): Row {
  const r = db.prepare("SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL").get(id);
  if (!r) throw new StoreError("not_found", "No schedule with this id.");
  return toRow(r);
}

function next(cron: string, after: number): number {
  let d: Date | null;
  try {
    d = nextCronTime(cron, after);
  } catch (e) {
    throw new StoreError("validation_failed", e instanceof CronError ? e.message : "Invalid schedule.", { pointer: "/cron" });
  }
  if (!d) throw new StoreError("validation_failed", "This schedule never fires (no time in the next 5 years).", { pointer: "/cron" });
  return d.getTime();
}

// ── owner side ──

export interface AutomationInput {
  id?: string;
  revision?: number;
  workflowId: string;
  versionPin?: number | null;
  policyVersion?: number;
  agentId: string;
  cron: string;
  enabled?: boolean;
  misfireGraceSec?: number;
  kanbanProject?: string | null;
}

/** `kanbanLinked`: Evolution has a companion grant for Task Board (the slice's companionTargets). Then a NEW schedule
 *  must name a Task Board project: run issues in Evolution's own project are invisible to the Bound agent (C250). An
 *  existing schedule without one keeps working and carries a warning in automations_list. */
export interface SetOptions {
  kanbanLinked?: boolean;
}

const KANBAN_PROJECT_REQUIRED =
  "Choose a Task Board project that you share with the Bound agent. Run issues in the own project of Evolving Workflows are not visible to the agent.";

export function setAutomation(db: Db, input: AutomationInput, now: number = Date.now(), opts: SetOptions = {}): Automation {
  return db.transaction(() => {
    const wf = getWorkflow(db, input.workflowId);
    const pin = input.versionPin ?? null;
    if (pin !== null) getVersion(db, wf.id, pin);
    // The applied recipe version is the owner's statement: a new schedule starts at the pin or the active version; an edit
    // that does not name it keeps it (an edit of the project or the cron must not silently clear a policy_stale gate).
    const prior = input.id ? load(db, input.id) : null;
    // (also when the pin changes: a pinned schedule skips the gate, so keeping the value is safe, and unpinning must not
    // jump to a wider active version)
    const policyVersion = input.policyVersion ?? (prior && prior.workflowId === wf.id ? prior.policyVersion : (pin ?? wf.activeVersion));
    getVersion(db, wf.id, policyVersion);
    const cron = input.cron.trim().replace(/\s+/g, " ");
    const firstDue = next(cron, now);
    const project = input.kanbanProject?.trim() || null;
    if (!input.id) {
      if (opts.kanbanLinked && project === null) throw new StoreError("kanban_project_required", KANBAN_PROJECT_REQUIRED, { pointer: "/kanbanProject" });
      const id = `aut_${ulid(now)}`;
      db.prepare(
        "INSERT INTO automations (id, workflow_id, version_pin, policy_version, agent_id, cron, enabled, misfire_grace_sec, kanban_project, revision, next_due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
      ).run(id, wf.id, pin, policyVersion, input.agentId, cron, input.enabled === false ? 0 : 1, input.misfireGraceSec ?? DEFAULT_GRACE_SEC, project, firstDue, now, now);
      return view(load(db, id));
    }
    const cur = load(db, input.id);
    if (input.revision !== cur.revision) throw new StoreError("revision_conflict", "The schedule changed since you opened it. Reload it.", { currentRevision: cur.revision });
    const kanbanProject = input.kanbanProject === undefined ? cur.kanbanProject : project;
    // an edit may keep a missing project (old schedules), never remove one
    if (opts.kanbanLinked && kanbanProject === null && cur.kanbanProject !== null)
      throw new StoreError("kanban_project_required", KANBAN_PROJECT_REQUIRED, { pointer: "/kanbanProject" });
    const enabled = input.enabled ?? cur.enabled;
    // a changed cron or a re-enabled schedule starts from now; otherwise keep the pending due time
    const keep = cron === cur.cron && enabled === cur.enabled;
    db.prepare(
      "UPDATE automations SET workflow_id = ?, version_pin = ?, policy_version = ?, agent_id = ?, cron = ?, enabled = ?, misfire_grace_sec = ?, kanban_project = ?, revision = revision + 1, next_due_at = ?, updated_at = ? WHERE id = ?",
    ).run(
      wf.id,
      pin,
      policyVersion,
      input.agentId,
      cron,
      enabled ? 1 : 0,
      input.misfireGraceSec ?? cur.grace,
      kanbanProject,
      keep ? cur.nextDueAt : firstDue,
      now,
      cur.id,
    );
    return view(load(db, cur.id));
  });
}

export function pauseAutomation(db: Db, id: string, revision: number, paused: boolean, now: number = Date.now()): Automation {
  const cur = load(db, id);
  return setAutomation(
    db,
    { id, revision, workflowId: cur.workflowId, versionPin: cur.versionPin, policyVersion: cur.policyVersion, agentId: cur.agentId, cron: cur.cron, enabled: !paused },
    now,
  );
}

export function deleteAutomation(db: Db, id: string, revision: number, now: number = Date.now()): void {
  db.transaction(() => {
    const cur = load(db, id);
    if (cur.revision !== revision) throw new StoreError("revision_conflict", "The schedule changed since you opened it. Reload it.", { currentRevision: cur.revision });
    db.prepare("UPDATE automations SET deleted_at = ?, enabled = 0, revision = revision + 1, updated_at = ? WHERE id = ?").run(now, now, id);
  });
}

export interface Settled {
  row: Row;
  /** the one occurrence runnable now (inside the grace), or null */
  due: number | null;
}

/** Applies the shared due / misfire rule (`cronDue`) and stores what it decides: a due time older than the grace is
 *  recorded `missed` (missed periods collapse into that one record) and the pending due time moves past now; a
 *  schedule that never fires again is switched off. This is bookkeeping of facts that follow from the clock alone,
 *  so the read ops (routines_due, the owner's lists) may run it too. Nothing here claims or starts a run. */
export function settle(db: Db, a: Row, now: number): Settled {
  const r = cronDue(a.cron, { nextDueAt: new Date(a.nextDueAt), now: new Date(now), graceSec: a.grace });
  if (!r.due) return { row: a, due: null };
  if (!r.missed) return { row: a, due: r.due.getTime() };
  recordMissed(db, a, r.due.getTime(), now);
  if (r.nextDueAt) advance(db, a, r.nextDueAt.getTime());
  else db.prepare("UPDATE automations SET enabled = 0 WHERE id = ?").run(a.id);
  return { row: load(db, a.id), due: null };
}

export type WarningCode = "policy_stale" | "kanban_project_missing";
export interface AutomationWarning {
  code: WarningCode;
  message: string;
}
export interface AutomationView extends Automation {
  workflowTitle: string;
  effectiveNextDueAt: string;
  missedSince: string | null;
  warnings: AutomationWarning[];
}

function warningsOf(db: Db, r: Row, kanbanLinked: boolean): AutomationWarning[] {
  const w: AutomationWarning[] = [];
  const v = resolveVersion(db, r);
  if (v && policyStale(db, r, v))
    w.push({
      code: "policy_stale",
      message: `Version ${v.version} needs more access than the recipe of version ${r.policyVersion} that the agent has. Runs are skipped. Apply the recipe of version ${v.version} in Portal, then choose Edit and set "Recipe applied" to version ${v.version}.`,
    });
  if (kanbanLinked && r.kanbanProject === null)
    w.push({
      code: "kanban_project_missing",
      message: "No Task Board project: run issues go to the own project of Evolving Workflows, which the Bound agent cannot see. Choose Edit and set a project that you share with the agent.",
    });
  return w;
}

export function listAutomations(db: Db, now: number = Date.now(), opts: SetOptions = {}): AutomationView[] {
  return db.transaction(() =>
    db
      .prepare("SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY created_at DESC")
      .all()
      .map(toRow)
      .map((r0) => {
        const { row: r, due } = settle(db, r0, now);
        const title = (() => {
          try {
            return getWorkflow(db, r.workflowId).title;
          } catch {
            return r.workflowId;
          }
        })();
        const last = db.prepare("SELECT status, due_at FROM routine_runs WHERE automation_id = ? ORDER BY due_at DESC LIMIT 1").get(r.id);
        return {
          ...view(r),
          workflowTitle: title,
          effectiveNextDueAt: iso(due ?? r.nextDueAt),
          missedSince: last && last.status === "missed" ? iso(last.due_at) : null,
          warnings: warningsOf(db, r, opts.kanbanLinked === true),
        };
      }),
  );
}

// ── runs ──

function toRun(r: Record<string, unknown>): Run {
  return {
    occurrence: String(r.occurrence),
    automationId: String(r.automation_id),
    workflowId: String(r.workflow_id),
    workflowVersion: r.workflow_version === null ? null : Number(r.workflow_version),
    dueAt: iso(r.due_at),
    status: r.status as RunStatus,
    claimedBy: strOrNull(r.claimed_by),
    summary: strOrNull(r.summary),
    kanbanIssueId: strOrNull(r.kanban_issue_id),
    kanbanSync: r.kanban_sync as Run["kanbanSync"],
    updatedAt: iso(r.updated_at),
  };
}

export function getRun(db: Db, occurrence: string): Run | null {
  const r = db.prepare("SELECT * FROM routine_runs WHERE occurrence = ?").get(occurrence);
  return r ? toRun(r) : null;
}

/** Owner view; stale claimed/dispatched runs are shown as uncertain even before a write op sweeps them. */
export function listRuns(db: Db, f: { automationId?: string; limit: number }, now: number = Date.now()): Run[] {
  const rows = f.automationId
    ? db.prepare("SELECT * FROM routine_runs WHERE automation_id = ? ORDER BY due_at DESC LIMIT ?").all(f.automationId, f.limit)
    : db.prepare("SELECT * FROM routine_runs ORDER BY due_at DESC LIMIT ?").all(f.limit);
  return rows.map(toRun).map((r) => (isStale(r.status, Date.parse(r.updatedAt), now) ? { ...r, status: "uncertain" as const } : r));
}

/** The one stale rule: listRuns shows these as uncertain, sweep stores it, the cycle ledger counts them so. */
export function isStale(status: string, updatedAt: number, now: number): boolean {
  return (status === "claimed" && now - updatedAt > CLAIMED_TIMEOUT_MS) || (status === "dispatched" && now - updatedAt > DISPATCHED_TIMEOUT_MS);
}

/** claimed/dispatched without a report for too long → uncertain (never offered again). Write ops only. */
export function sweep(db: Db, now: number = Date.now()): number {
  const a = db
    .prepare(
      "UPDATE routine_runs SET status = 'uncertain', summary = COALESCE(summary, 'No report from the runner in time.'), kanban_sync = CASE WHEN kanban_issue_id IS NULL THEN kanban_sync ELSE 'pending' END, updated_at = ? WHERE (status = 'claimed' AND updated_at < ?) OR (status = 'dispatched' AND updated_at < ?)",
    )
    .run(now, now - CLAIMED_TIMEOUT_MS, now - DISPATCHED_TIMEOUT_MS);
  return Number(a.changes);
}

export interface Job {
  occurrence: string;
  automationId: string;
  workflowId: string;
  version: number;
  dueAt: string;
  title: string;
}

/** THE policy gate of routines_due and routine_claim: a schedule that follows the active version may run it only when
 *  that version needs no more access than the recipe the owner applied (`policyVersion`). */
export function policyStale(db: Db, a: Row, v: Version): boolean {
  if (a.versionPin !== null || v.version === a.policyVersion) return false;
  const applied = resolveVersionAt(db, a.workflowId, a.policyVersion);
  return !applied || diffSnapshots(snapshotOf(applied), snapshotOf(v)).widensAccess;
}

function resolveVersion(db: Db, a: Row): Version | null {
  try {
    return getVersion(db, a.workflowId, a.versionPin ?? undefined);
  } catch {
    return null;
  }
}

/** routines_due: Bound callers only; one job per automation at most (its due occurrence inside the grace). Claims
 *  nothing. Bookkeeping only (facts from the clock and the policy gate): records missed runs (see `settle`) and skips /
 *  records policy-stale periods (`recordPolicyStale`); no receipt. */
export function dueJobs(db: Db, agentId: string, now: number = Date.now()): Job[] {
  return db.transaction(() => {
    const jobs: Job[] = [];
    for (const a0 of db.prepare("SELECT * FROM automations WHERE agent_id = ? AND deleted_at IS NULL AND enabled = 1").all(agentId).map(toRow)) {
      const { row: a, due } = settle(db, a0, now);
      if (due === null) continue;
      const occurrence = occurrenceOf(a.id, a.revision, due);
      if (getRun(db, occurrence)) continue;
      const v = resolveVersion(db, a);
      if (!v) continue;
      if (policyStale(db, a, v)) {
        recordPolicyStale(db, a, due, v, now);
        continue;
      }
      jobs.push({ occurrence, automationId: a.id, workflowId: a.workflowId, version: v.version, dueAt: iso(due), title: v.title });
    }
    return jobs.sort((x, y) => x.dueAt.localeCompare(y.dueAt));
  });
}

export interface ClaimedJob extends Job {
  instruction: string;
  trigger: string;
  steps: Version["steps"];
  allowed: Version["allowed"];
  deadline: string;
  kanbanIssueId: string | null;
  kanbanProject: string | null;
}
export type ClaimResult = { claimed: true; job: ClaimedJob; automation: Automation } | { claimed: false; reason: ClaimReason };

/** routine_claim: the ONE write that turns a due occurrence into a run (primary key = at-most-once). */
export function claim(db: Db, caller: { id: string; mode: string | null }, occurrence: string, now: number = Date.now()): ClaimResult {
  return db.transaction((): ClaimResult => {
    sweep(db, now);
    if (caller.mode !== "bound") return { claimed: false, reason: getRun(db, occurrence) ? "already_claimed" : "not_bound" };
    for (const a0 of db.prepare("SELECT * FROM automations WHERE agent_id = ? AND deleted_at IS NULL").all(caller.id).map(toRow)) settle(db, a0, now);
    const prior = getRun(db, occurrence);
    if (prior) return { claimed: false, reason: prior.status === "missed" || prior.status === "policy_stale" ? prior.status : "already_claimed" };
    for (const a of db.prepare("SELECT * FROM automations WHERE agent_id = ? AND deleted_at IS NULL").all(caller.id).map(toRow)) {
      const r = cronDue(a.cron, { nextDueAt: new Date(a.nextDueAt), now: new Date(now), graceSec: a.grace });
      if (!r.due || r.missed || occurrenceOf(a.id, a.revision, r.due.getTime()) !== occurrence) continue;
      const s = { due: r.due.getTime(), next: r.nextDueAt?.getTime() ?? null };
      if (!a.enabled) return { claimed: false, reason: "paused" };
      const v = resolveVersion(db, a);
      if (!v) return { claimed: false, reason: "version_missing" };
      if (policyStale(db, a, v)) {
        recordPolicyStale(db, a, s.due, v, now);
        return { claimed: false, reason: "policy_stale" };
      }
      db.prepare(
        "INSERT INTO routine_runs (occurrence, automation_id, revision, due_at, status, claimed_by, workflow_id, workflow_version, claimed_at, updated_at) VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)",
      ).run(occurrence, a.id, a.revision, s.due, caller.id, a.workflowId, v.version, now, now);
      if (s.next !== null) advance(db, a, s.next);
      else db.prepare("UPDATE automations SET enabled = 0 WHERE id = ?").run(a.id);
      return {
        claimed: true,
        automation: view(load(db, a.id)),
        job: {
          occurrence,
          automationId: a.id,
          workflowId: a.workflowId,
          version: v.version,
          dueAt: iso(s.due),
          title: v.title,
          instruction: v.instruction,
          trigger: v.trigger,
          steps: v.steps,
          allowed: v.allowed,
          deadline: iso(now + DISPATCHED_TIMEOUT_MS),
          kanbanIssueId: null,
          kanbanProject: a.kanbanProject,
        },
      };
    }
    return { claimed: false, reason: "not_due" };
  });
}

function resolveVersionAt(db: Db, workflowId: string, version: number): Version | null {
  try {
    return getVersion(db, workflowId, version);
  } catch {
    return null;
  }
}

/** The version a due time of this schedule resolves to: the pin, else the version that was active at `dueAt` (the
 *  ledger rule of src/cycles.ts), else the active one. */
function versionAtDue(db: Db, a: Row, dueAt: number): number | null {
  if (a.versionPin !== null) return a.versionPin;
  const r = db.prepare("SELECT max(version) AS v FROM workflow_versions WHERE workflow_id = ? AND promoted_at <= ?").get(a.workflowId, dueAt);
  if (r && r.v !== null) return Number(r.v);
  return resolveVersion(db, a)?.version ?? null;
}

/** 0.3.0 (C250 Release B): a missed row also stores the version it belongs to (0.2.x rows have none; the cycle ledger
 *  attributes those by due time). */
function recordMissed(db: Db, a: Row, dueAt: number, now: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO routine_runs (occurrence, automation_id, revision, due_at, status, workflow_id, workflow_version, summary, updated_at) VALUES (?, ?, ?, ?, 'missed', ?, ?, ?, ?)",
  ).run(
    occurrenceOf(a.id, a.revision, dueAt),
    a.id,
    a.revision,
    dueAt,
    a.workflowId,
    versionAtDue(db, a, dueAt),
    "Not claimed within the misfire grace; later periods collapsed into this record.",
    now,
  );
}

/** The due occurrence `dueAt` of a policy-stale version: the pending due time moves to the next period, like a claim.
 *  Only the FIRST such period of one schedule revision and version is stored (one `policy_stale` run row, never
 *  claimable); later periods are skipped without a row, so a frequent cron does not flood the run history. Applying the
 *  new recipe changes the schedule (new revision), so the next period runs. */
function recordPolicyStale(db: Db, a: Row, dueAt: number, v: Version, now: number): void {
  const seen = db
    .prepare("SELECT 1 AS x FROM routine_runs WHERE automation_id = ? AND revision = ? AND workflow_version = ? AND status = 'policy_stale' LIMIT 1")
    .get(a.id, a.revision, v.version);
  if (!seen) db.prepare(
    "INSERT OR IGNORE INTO routine_runs (occurrence, automation_id, revision, due_at, status, workflow_id, workflow_version, summary, updated_at) VALUES (?, ?, ?, ?, 'policy_stale', ?, ?, ?, ?)",
  ).run(
    occurrenceOf(a.id, a.revision, dueAt),
    a.id,
    a.revision,
    dueAt,
    a.workflowId,
    v.version,
    `Not offered: version ${v.version} needs more access than the recipe of version ${a.policyVersion}. Later periods are skipped without a record until the schedule says the new recipe is applied.`,
    now,
  );
  const r = cronDue(a.cron, { nextDueAt: new Date(dueAt), now: new Date(now), graceSec: a.grace });
  if (r.nextDueAt) advance(db, a, r.nextDueAt.getTime());
  else db.prepare("UPDATE automations SET enabled = 0 WHERE id = ?").run(a.id);
}

/** Moves the pending due time forward (never back); not a schedule change, so `revision` stays. */
function advance(db: Db, a: Row, nextDue: number): void {
  db.prepare("UPDATE automations SET next_due_at = ? WHERE id = ? AND next_due_at < ?").run(nextDue, a.id, nextDue);
}

export function setKanban(db: Db, occurrence: string, issueId: string | null, sync: Run["kanbanSync"], now: number = Date.now()): void {
  db.prepare("UPDATE routine_runs SET kanban_issue_id = COALESCE(?, kanban_issue_id), kanban_sync = ?, updated_at = MAX(updated_at, ?) WHERE occurrence = ?").run(
    issueId,
    sync,
    now,
    occurrence,
  );
}

const NEXT_STATUS: Record<RunStatus, RunStatus[]> = {
  claimed: ["dispatched", "completed", "failed", "uncertain"],
  dispatched: ["completed", "failed", "uncertain"],
  uncertain: ["completed", "failed"], // a late report from the runner is the truth
  completed: [],
  failed: [],
  missed: [],
  policy_stale: [],
};

export type ReportStatus = "dispatched" | "completed" | "failed" | "uncertain";
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "uncertain"]);

/** The optional `metrics` of routine_report (C288 R8): the RunReport of the Henry contracts. `pipeline` and `version` are
 *  accepted for 1:1 compatibility and IGNORED (Henry's pipeline ids and contract version are not ours); the stored truth
 *  is the run row's own workflow id and version. */
export interface MetricsInput {
  pipeline?: string;
  version?: number;
  ok: boolean;
  minutes: number;
  retries?: number;
  questions_to_martin?: number;
  lessons?: string[];
  /** the named per-pipeline numbers: name -> number (at most 20; any patterned name on this branch) */
  metrics?: Record<string, number>;
  /** the Task Board issue id of the run: accepted and IGNORED (the run row's kanban_issue_id is the truth) */
  issue?: string;
}
export interface StoredMetrics {
  ok: boolean;
  minutes: number;
  retries: number | null;
  questionsToMartin: number | null;
  lessons: string[];
  /** the named numbers, sorted by name */
  named: [string, number][];
}
export const NAMED_MAX = 20;
export const NAME_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
export const MINUTES_MAX = 10080;
export const COUNT_MAX = 1000;
export const LESSONS_MAX = 20;
export const LESSON_MAX_CHARS = 280;

const refuse = (pointer: string, message: string): StoreError => new StoreError("validation_failed", message, { pointer });

/** Invisible "filler" characters that are letters or symbols by category but show nothing (braille blank, Hangul fillers,
 *  Khmer inherent vowels). A lesson of only these is blank. Keep in step with the pattern in the manifest. */
const FILLERS = new Set(["\u2800", "\u3164", "\u115F", "\u1160", "\uFFA0", "\u17B4", "\u17B5"]);
const MEANINGFUL = /[\p{L}\p{N}\p{P}\p{S}]/u;
/** A lesson must show at least one letter, digit, punctuation or symbol. */
export const isMeaningful = (s: string): boolean => Array.from(s).some((ch) => MEANINGFUL.test(ch) && !FILLERS.has(ch));

function namedOf(map: unknown): [string, number][] {
  if (map === undefined) return [];
  if (typeof map !== "object" || map === null || Array.isArray(map)) throw refuse("/metrics/metrics", "metrics.metrics must be an object of names and numbers.");
  const entries = Object.entries(map);
  if (entries.length > NAMED_MAX) throw refuse("/metrics/metrics", `metrics.metrics has at most ${NAMED_MAX} names.`);
  for (const [name, v] of entries) {
    if (!NAME_PATTERN.test(name)) throw refuse(`/metrics/metrics/${name}`, "A metric name starts with a lower case letter and has 2 to 41 characters: lower case letters, digits and underscore.");
    if (typeof v !== "number" || !Number.isFinite(v)) throw refuse(`/metrics/metrics/${name}`, `metrics.metrics.${name} must be a finite number.`);
  }
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Checks `metrics` and returns what is stored (lessons trimmed). The manifest schema already refuses bad shapes with a
 *  pointer before the handler runs; the bounds are checked here too, so a direct call of `report` cannot store a value
 *  the table's CHECKs would refuse. Lesson length counts code points, like the schema.
 *  - terminal status only: completed or failed (an `uncertain` report is not a result of the run);
 *  - `pipeline`, `version` and `issue` are ignored: they are not compared with the run (the run row is the truth);
 *  - `metrics` (the named map): at most 20 names, each ^[a-z][a-z0-9_]{1,40}$, finite numbers. R8 does not know which names
 *    a pipeline declares: any patterned name is stored (the declared-names check is R10's).
 *  `ok` is not cross-checked with the status: it is the runner's own word on the outcome (a completed run can say ok: false). */
export function checkMetrics(m: MetricsInput, status: ReportStatus): StoredMetrics {
  if (status !== "completed" && status !== "failed")
    throw new StoreError("metrics_need_terminal_status", "Send metrics only with the report that ends the run: status completed or failed.", { pointer: "/metrics", status });
  if (typeof m.ok !== "boolean") throw refuse("/metrics/ok", "metrics.ok must be true or false.");
  if (typeof m.minutes !== "number" || !Number.isFinite(m.minutes) || m.minutes < 0 || m.minutes > MINUTES_MAX) throw refuse("/metrics/minutes", `metrics.minutes must be a number from 0 to ${MINUTES_MAX}.`);
  const count = (k: "retries" | "questions_to_martin"): number | null => {
    const v = m[k];
    if (v === undefined) return null;
    if (!Number.isInteger(v) || v < 0 || v > COUNT_MAX) throw refuse(`/metrics/${k}`, `metrics.${k} must be a whole number from 0 to ${COUNT_MAX}.`);
    return v;
  };
  const retries = count("retries");
  const questionsToMartin = count("questions_to_martin");
  const lessons = m.lessons ?? [];
  if (!Array.isArray(lessons) || lessons.length > LESSONS_MAX) throw refuse("/metrics/lessons", `metrics.lessons has at most ${LESSONS_MAX} entries.`);
  const trimmed = lessons.map((l, i) => {
    const t = typeof l === "string" ? l.trim() : "";
    const n = Array.from(t).length;
    if (n < 1 || n > LESSON_MAX_CHARS || !isMeaningful(t)) throw refuse(`/metrics/lessons/${i}`, `Each lesson has 1 to ${LESSON_MAX_CHARS} characters and shows at least one letter, digit or symbol.`);
    return t;
  });
  const named = namedOf(m.metrics);
  return { ok: m.ok, minutes: m.minutes, retries, questionsToMartin, lessons: trimmed, named };
}

/** routine_report: only the claimer; repeating the current status is a no-op; terminal states are final.
 *  `metrics` (C288 R8) are stored with the report that moves the run to completed / failed, in the same transaction.
 *  They are checked on every call (a bad payload is refused even on a repeat), but a REPEAT of the current status
 *  changes nothing: metrics that arrive on it, same or different, are not stored (the first terminal report decides). */
export function report(
  db: Db,
  callerId: string,
  occurrence: string,
  status: ReportStatus,
  summary: string | null,
  now: number = Date.now(),
  metrics: MetricsInput | null = null,
  declared?: (workflowId: string, version: number | null) => readonly string[] | null,
): { run: Run; changed: boolean } {
  return db.transaction(() => {
    sweep(db, now);
    const run = getRun(db, occurrence);
    if (!run || run.claimedBy !== callerId) throw new StoreError("not_found", "No run of yours with this occurrence.");
    const stored = metrics ? checkMetrics(metrics, status) : null;
    // C288 R10: when the run's workflow VERSION was imported from a pipeline contract, a named metric must be one the contract
    // declares (an empty list declares none). A version that was not imported accepts any patterned name. Checked on every
    // call like the other metrics errors; the answer does not list the declared names (they are the owner's data).
    const names = declared && stored?.named.length ? declared(run.workflowId, run.workflowVersion) : null;
    if (names) {
      const bad = stored?.named.find(([n]) => !names.includes(n));
      if (bad) throw new StoreError("metric_not_declared", `The metric "${bad[0]}" is not declared by the pipeline contract of this workflow version. Send only declared names, or send the report again without metrics.`, { pointer: `/metrics/metrics/${bad[0]}` });
    }
    if (run.status === status) return { run, changed: false };
    if (!NEXT_STATUS[run.status].includes(status)) throw new StoreError("conflict", `A ${run.status} run cannot become ${status}.`, { status: run.status });
    const sync = TERMINAL.has(status) && run.kanbanIssueId ? "pending" : run.kanbanSync;
    // reported_at (0.3.0): the moment of the runner's terminal report, for the cycle ledger's duration (updated_at moves
    // again when the Task Board issue is closed; the sweep never sets reported_at)
    db.prepare(
      "UPDATE routine_runs SET status = ?, summary = COALESCE(?, summary), kanban_sync = ?, updated_at = ?, reported_at = CASE WHEN ? THEN ? ELSE reported_at END WHERE occurrence = ?",
    ).run(status, summary, sync, now, TERMINAL.has(status) ? 1 : 0, now, occurrence);
    if (stored) {
      db.prepare("INSERT INTO run_metrics (occurrence, ok, minutes, retries, questions_to_martin, lessons, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        occurrence,
        stored.ok ? 1 : 0,
        stored.minutes,
        stored.retries,
        stored.questionsToMartin,
        JSON.stringify(stored.lessons),
        now,
      );
      for (const [name, value] of stored.named) db.prepare("INSERT INTO run_metric_values (occurrence, name, value) VALUES (?, ?, ?)").run(occurrence, name, value);
    }
    return { run: getRun(db, occurrence) as Run, changed: true };
  });
}

/** Runs whose Kanban issue must still be closed (terminal, issue known, not yet synced). */
export function pendingKanban(db: Db, limit = 10): Run[] {
  return db
    .prepare("SELECT * FROM routine_runs WHERE kanban_sync = 'pending' AND kanban_issue_id IS NOT NULL ORDER BY updated_at LIMIT ?")
    .all(limit)
    .map(toRun);
}
