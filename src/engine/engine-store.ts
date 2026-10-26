// app.db access of the engine: contract versions, activations, schedules and the run index (migrations/0009_engine.sql).
// Plain SQL over the SDK's Db. No Temporal, no SDK context: the activities, the owner ops and the reconcile job share it.
import { createHash } from "node:crypto";
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { WorkflowContract } from "./contract.ts";
import { EngineError } from "./errors.ts";
import type { OpUse } from "./validate.ts";

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function digestOf(c: WorkflowContract): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(c)).digest("hex")}`;
}

// ───────────────────────────── definitions ─────────────────────────────

export interface Definition {
  workflowId: string;
  version: number;
  title: string;
  contract: WorkflowContract;
  digest: string;
  createdAt: string;
}

function toDefinition(r: Record<string, unknown>): Definition {
  return { workflowId: String(r.workflow_id), version: Number(r.version), title: String(r.title), contract: JSON.parse(String(r.contract)) as WorkflowContract, digest: String(r.digest), createdAt: iso(Number(r.created_at)) as string };
}

/** Stores one immutable version. The same contract again is accepted (same digest); another contract under the same id and version is a conflict. */
export function saveDefinition(db: Db, c: WorkflowContract, now: number): { definition: Definition; created: boolean } {
  const digest = digestOf(c);
  const prior = db.prepare("SELECT * FROM engine_definitions WHERE workflow_id = ? AND version = ?").get(c.id, c.version);
  if (prior) {
    if (String(prior.digest) !== digest) throw new EngineError("version_exists", `Version ${c.version} of ${c.id} is stored with other content. A stored version never changes: save it as version ${c.version + 1}.`, 409);
    return { definition: toDefinition(prior), created: false };
  }
  db.prepare("INSERT INTO engine_definitions (workflow_id, version, title, contract, digest, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(c.id, c.version, c.title, JSON.stringify(c), digest, now);
  return { definition: toDefinition(db.prepare("SELECT * FROM engine_definitions WHERE workflow_id = ? AND version = ?").get(c.id, c.version) as Record<string, unknown>), created: true };
}

export function getDefinition(db: Db, workflowId: string, version: number): Definition | null {
  const r = db.prepare("SELECT * FROM engine_definitions WHERE workflow_id = ? AND version = ?").get(workflowId, version);
  return r ? toDefinition(r) : null;
}

export function latestVersion(db: Db, workflowId: string): number | null {
  return num(db.prepare("SELECT max(version) AS v FROM engine_definitions WHERE workflow_id = ?").get(workflowId)?.v);
}

export function listDefinitions(db: Db): { workflowId: string; version: number; title: string; createdAt: string; state: Activation["state"] | null }[] {
  return db
    .prepare("SELECT d.workflow_id, d.version, d.title, d.created_at, a.state FROM engine_definitions d LEFT JOIN engine_activations a ON a.workflow_id = d.workflow_id AND a.version = d.version ORDER BY d.workflow_id, d.version DESC")
    .all()
    .map((r) => ({ workflowId: String(r.workflow_id), version: Number(r.version), title: String(r.title), createdAt: iso(Number(r.created_at)) as string, state: (str(r.state) as Activation["state"] | null) ?? null }));
}

// ───────────────────────────── activations ─────────────────────────────

export interface Activation {
  workflowId: string;
  version: number;
  state: "active" | "superseded" | "deactivated";
  uses: OpUse[];
  activatedAt: string;
  endedAt: string | null;
}

function toActivation(r: Record<string, unknown>): Activation {
  return { workflowId: String(r.workflow_id), version: Number(r.version), state: r.state as Activation["state"], uses: JSON.parse(String(r.uses)) as OpUse[], activatedAt: iso(Number(r.activated_at)) as string, endedAt: iso(num(r.ended_at)) };
}

export function getActivation(db: Db, workflowId: string, version: number): Activation | null {
  const r = db.prepare("SELECT * FROM engine_activations WHERE workflow_id = ? AND version = ?").get(workflowId, version);
  return r ? toActivation(r) : null;
}

export function activeActivation(db: Db, workflowId: string): Activation | null {
  const r = db.prepare("SELECT * FROM engine_activations WHERE workflow_id = ? AND state = 'active'").get(workflowId);
  return r ? toActivation(r) : null;
}

/** Makes `version` the one active version; an older active version becomes `superseded` (runs in flight may finish). */
export function activate(db: Db, workflowId: string, version: number, uses: OpUse[], now: number): { activation: Activation; previous: number | null } {
  return db.transaction(() => {
    const prev = activeActivation(db, workflowId);
    if (prev && prev.version !== version) db.prepare("UPDATE engine_activations SET state = 'superseded', ended_at = ? WHERE workflow_id = ? AND version = ?").run(now, workflowId, prev.version);
    db.prepare(
      `INSERT INTO engine_activations (workflow_id, version, state, uses, activated_at, ended_at) VALUES (?, ?, 'active', ?, ?, NULL)
       ON CONFLICT (workflow_id, version) DO UPDATE SET state = 'active', uses = excluded.uses, activated_at = excluded.activated_at, ended_at = NULL`,
    ).run(workflowId, version, JSON.stringify(uses), now);
    return { activation: getActivation(db, workflowId, version) as Activation, previous: prev && prev.version !== version ? prev.version : null };
  });
}

/** Every activated version of the workflow becomes `deactivated`: the engine refuses all their calls from now on. */
export function deactivate(db: Db, workflowId: string, now: number): number[] {
  return db.transaction(() => {
    const rows = db.prepare("SELECT version FROM engine_activations WHERE workflow_id = ? AND state != 'deactivated'").all(workflowId);
    db.prepare("UPDATE engine_activations SET state = 'deactivated', ended_at = ? WHERE workflow_id = ? AND state != 'deactivated'").run(now, workflowId);
    return rows.map((r) => Number(r.version));
  });
}

// ───────────────────────────── schedules ─────────────────────────────

export interface ScheduleSpecRow {
  cron?: string;
  every?: string;
  timezone: string;
}
export interface PollRow {
  product: string;
  op: string;
  input: Record<string, unknown>;
  cursorPath: string;
}
export interface ScheduleRow {
  id: string;
  workflowId: string;
  versionPin: number | null;
  kind: "schedule" | "poll";
  spec: ScheduleSpecRow;
  input: Record<string, unknown>;
  poll: PollRow | null;
  overlap: "skip" | "buffer_one";
  paused: boolean;
  revision: number;
  cursor: string | null;
  cursorAt: string | null;
  temporalState: "pending" | "synced" | "missing" | "error";
  temporalError: string | null;
  /** F6: why the schedule no longer fits the active version (it is paused until the owner edits it); null = fine */
  staleReason: string | null;
  createdAt: string;
  updatedAt: string;
}

function toSchedule(r: Record<string, unknown>): ScheduleRow {
  return {
    id: String(r.id),
    workflowId: String(r.workflow_id),
    versionPin: num(r.version_pin),
    kind: r.kind as ScheduleRow["kind"],
    spec: JSON.parse(String(r.spec)) as ScheduleSpecRow,
    input: JSON.parse(String(r.input)) as Record<string, unknown>,
    poll: r.poll === null || r.poll === undefined ? null : (JSON.parse(String(r.poll)) as PollRow),
    overlap: r.overlap as ScheduleRow["overlap"],
    paused: Number(r.paused) === 1,
    revision: Number(r.revision),
    cursor: str(r.cursor),
    cursorAt: iso(num(r.cursor_at)),
    temporalState: r.temporal_state as ScheduleRow["temporalState"],
    temporalError: str(r.temporal_error),
    staleReason: str(r.stale_reason),
    createdAt: iso(Number(r.created_at)) as string,
    updatedAt: iso(Number(r.updated_at)) as string,
  };
}

export const newScheduleId = (now: number): string => `sch_${ulid(now).slice(-12)}`;

export function getSchedule(db: Db, id: string): ScheduleRow | null {
  const r = db.prepare("SELECT * FROM engine_schedules WHERE id = ? AND deleted_at IS NULL").get(id);
  return r ? toSchedule(r) : null;
}

export function listSchedules(db: Db, workflowId?: string): ScheduleRow[] {
  const rows = workflowId ? db.prepare("SELECT * FROM engine_schedules WHERE deleted_at IS NULL AND workflow_id = ? ORDER BY created_at").all(workflowId) : db.prepare("SELECT * FROM engine_schedules WHERE deleted_at IS NULL ORDER BY created_at").all();
  return rows.map(toSchedule);
}

export function insertSchedule(db: Db, s: Omit<ScheduleRow, "revision" | "cursor" | "cursorAt" | "temporalState" | "temporalError" | "staleReason" | "createdAt" | "updatedAt">, now: number): ScheduleRow {
  db.prepare(
    `INSERT INTO engine_schedules (id, workflow_id, version_pin, kind, spec, input, poll, overlap, paused, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(s.id, s.workflowId, s.versionPin, s.kind, JSON.stringify(s.spec), JSON.stringify(s.input), s.poll ? JSON.stringify(s.poll) : null, s.overlap, s.paused ? 1 : 0, now, now);
  return getSchedule(db, s.id) as ScheduleRow;
}

export function updateSchedule(db: Db, id: string, revision: number, patch: Partial<Pick<ScheduleRow, "versionPin" | "spec" | "input" | "poll" | "overlap" | "paused">>, now: number): ScheduleRow {
  const cur = getSchedule(db, id);
  if (!cur) throw new EngineError("not_found", "No schedule with this id.", 404);
  if (cur.revision !== revision) throw new EngineError("revision_conflict", `The schedule changed (revision ${cur.revision}). Reload it and try again.`, 409, { revision: cur.revision });
  const n = { ...cur, ...patch };
  db.prepare("UPDATE engine_schedules SET version_pin = ?, spec = ?, input = ?, poll = ?, overlap = ?, paused = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(n.versionPin, JSON.stringify(n.spec), JSON.stringify(n.input), n.poll ? JSON.stringify(n.poll) : null, n.overlap, n.paused ? 1 : 0, now, id);
  return getSchedule(db, id) as ScheduleRow;
}

export function setScheduleSync(db: Db, id: string, state: ScheduleRow["temporalState"], error: string | null, now: number): void {
  db.prepare("UPDATE engine_schedules SET temporal_state = ?, temporal_error = ?, updated_at = ? WHERE id = ?").run(state, error ? error.slice(0, 300) : null, now, id);
}

export function markScheduleDeleted(db: Db, id: string, now: number): void {
  db.prepare("UPDATE engine_schedules SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
}

/** F7: the cursor of a poll is PENDING until the run it started completes (see finishRun). */
export function setPendingCursor(db: Db, id: string, runId: string, cursor: string): void {
  db.prepare("UPDATE engine_schedules SET pending_cursor = ?, pending_run_id = ? WHERE id = ?").run(cursor.slice(0, 200), runId, id);
}

export function setStale(db: Db, id: string, reason: string | null, now: number): void {
  db.prepare("UPDATE engine_schedules SET stale_reason = ?, updated_at = ? WHERE id = ?").run(reason ? reason.slice(0, 300) : null, now, id);
}

// ───────────────────────────── run index ─────────────────────────────

export type RunStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out" | "terminated" | "skipped";
export interface RunRow {
  workflowId: string;
  runId: string;
  version: number | null;
  scheduleId: string | null;
  temporalWorkflowId: string;
  temporalRunId: string | null;
  triggerKind: string;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  errorCode: string | null;
  errorStep: string | null;
  skippedReason: string | null;
  stepsDone: number;
  stepsFailed: number;
  heldWaits: number;
  heldWaitMs: number;
  modelTokens: number;
  outputBytes: number | null;
  source: "activity" | "reconcile";
}
export interface StepRow {
  stepKey: string;
  stepId: string;
  loopPath: string | null;
  kind: string;
  product: string | null;
  op: string | null;
  status: string;
  attempts: number;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  holdId: string | null;
  holdStartedAt: string | null;
  holdEndedAt: string | null;
  holdOutcome: string | null;
  stepRunId: string | null;
  agentId: string | null;
  inBytes: number | null;
  outBytes: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  errorCode: string | null;
}

const RUN_SELECT = `SELECT r.*,
  (SELECT count(*) FROM engine_steps s WHERE s.workflow_id = r.workflow_id AND s.run_id = r.run_id AND s.status = 'completed') AS n_done,
  (SELECT count(*) FROM engine_steps s WHERE s.workflow_id = r.workflow_id AND s.run_id = r.run_id AND s.status = 'failed') AS n_failed
  FROM engine_runs r`;

function toRun(r: Record<string, unknown>): RunRow {
  const started = Number(r.started_at);
  const ended = num(r.ended_at);
  const running = r.status === "running";
  return {
    workflowId: String(r.workflow_id),
    runId: String(r.run_id),
    version: num(r.version),
    scheduleId: str(r.schedule_id),
    temporalWorkflowId: String(r.temporal_workflow_id),
    temporalRunId: str(r.temporal_run_id),
    triggerKind: String(r.trigger_kind),
    status: r.status as RunStatus,
    startedAt: iso(started) as string,
    endedAt: iso(ended),
    durationMs: ended === null ? null : ended - started,
    errorCode: str(r.error_code),
    errorStep: str(r.error_step),
    skippedReason: str(r.skipped_reason),
    stepsDone: running ? Number(r.n_done) : Number(r.steps_done),
    stepsFailed: running ? Number(r.n_failed) : Number(r.steps_failed),
    heldWaits: Number(r.held_waits),
    heldWaitMs: Number(r.held_wait_ms),
    modelTokens: Number(r.model_tokens),
    outputBytes: num(r.output_bytes),
    source: r.source as RunRow["source"],
  };
}

function toStep(r: Record<string, unknown>): StepRow {
  const started = Number(r.started_at);
  const ended = num(r.ended_at);
  return {
    stepKey: String(r.step_key),
    stepId: String(r.step_id),
    loopPath: str(r.loop_path),
    kind: String(r.kind),
    product: str(r.product),
    op: str(r.op),
    status: String(r.status),
    attempts: Number(r.attempts),
    startedAt: iso(started) as string,
    endedAt: iso(ended),
    durationMs: ended === null ? null : ended - started,
    holdId: str(r.hold_id),
    holdStartedAt: iso(num(r.hold_started_at)),
    holdEndedAt: iso(num(r.hold_ended_at)),
    holdOutcome: str(r.hold_outcome),
    stepRunId: str(r.step_run_id),
    agentId: str(r.agent_id),
    inBytes: num(r.in_bytes),
    outBytes: num(r.out_bytes),
    tokensIn: num(r.tokens_in),
    tokensOut: num(r.tokens_out),
    errorCode: str(r.error_code),
  };
}

export interface RunStart {
  workflowId: string;
  runId: string;
  version: number;
  scheduleId: string | null;
  temporalWorkflowId: string;
  temporalRunId: string;
  triggerKind: string;
  startedAt: number;
}

/** Inserts the run row (running). A repeat (an activity retry, a continue-as-new run) only refreshes the Temporal run id. */
export function startRun(db: Db, r: RunStart, now: number): void {
  db.prepare(
    `INSERT INTO engine_runs (workflow_id, run_id, version, schedule_id, temporal_workflow_id, temporal_run_id, trigger_kind, status, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
     ON CONFLICT (workflow_id, run_id) DO UPDATE SET temporal_run_id = excluded.temporal_run_id, version = excluded.version, updated_at = excluded.updated_at`,
  ).run(r.workflowId, r.runId, r.version, r.scheduleId, r.temporalWorkflowId, r.temporalRunId, r.triggerKind, r.startedAt, now);
}

export function finishRun(db: Db, f: { workflowId: string; runId: string; status: RunStatus; endedAt: number; errorCode?: string | null; errorStep?: string | null; skippedReason?: string | null; outputBytes?: number | null }, now: number): void {
  const counts = db
    .prepare("SELECT sum(status = 'completed') AS done, sum(status = 'failed') AS failed, sum(CASE WHEN hold_id IS NOT NULL THEN 1 ELSE 0 END) AS holds, coalesce(sum(coalesce(hold_ended_at, ?) - hold_started_at), 0) AS hold_ms, coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0) AS tokens FROM engine_steps WHERE workflow_id = ? AND run_id = ?")
    .get(f.endedAt, f.workflowId, f.runId);
  db.prepare(
    `UPDATE engine_runs SET status = ?, ended_at = ?, error_code = ?, error_step = ?, skipped_reason = ?, output_bytes = ?, steps_done = ?, steps_failed = ?, held_waits = ?, held_wait_ms = ?, model_tokens = ?, updated_at = ?
      WHERE workflow_id = ? AND run_id = ? AND (status = 'running' OR source = 'reconcile')`,
  ).run(f.status, f.endedAt, f.errorCode ?? null, f.errorStep ?? null, f.skippedReason ?? null, f.outputBytes ?? null, Number(counts?.done ?? 0), Number(counts?.failed ?? 0), Number(counts?.holds ?? 0), Number(counts?.hold_ms ?? 0), Number(counts?.tokens ?? 0), now, f.workflowId, f.runId);
  // F7: a poll's cursor moves only when the run it started completed
  if (f.status === "completed") {
    db.prepare("UPDATE engine_schedules SET cursor = pending_cursor, cursor_at = ?, pending_cursor = NULL, pending_run_id = NULL WHERE pending_run_id = ? AND id = (SELECT schedule_id FROM engine_runs WHERE workflow_id = ? AND run_id = ?)").run(now, f.runId, f.workflowId, f.runId);
  }
}

export interface StepWrite {
  workflowId: string;
  runId: string;
  stepKey: string;
  stepId: string;
  loopPath: number[];
  kind: string;
  status: "running" | "completed" | "failed" | "skipped" | "waiting_hold" | "waiting_agent" | "waiting_owner";
  startedAt: number;
  endedAt?: number | null;
  product?: string | null;
  op?: string | null;
  attempts?: number;
  errorCode?: string | null;
  inBytes?: number | null;
  outBytes?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  hold?: { id: string; startedAt: number } | null;
  agent?: { stepRunId: string; agentId: string } | null;
}

export function writeStep(db: Db, w: StepWrite, now: number): void {
  // the run row may be missing in a unit test of one activity; a step without a run is not indexed
  if (!db.prepare("SELECT 1 AS x FROM engine_runs WHERE workflow_id = ? AND run_id = ?").get(w.workflowId, w.runId)) return;
  db.prepare(
    `INSERT INTO engine_steps (workflow_id, run_id, step_key, step_id, loop_path, kind, product, op, status, attempts, started_at, ended_at, hold_id, hold_started_at, step_run_id, agent_id, in_bytes, out_bytes, tokens_in, tokens_out, error_code, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workflow_id, run_id, step_key) DO UPDATE SET
       status = excluded.status,
       attempts = max(engine_steps.attempts, excluded.attempts),
       ended_at = excluded.ended_at,
       product = coalesce(excluded.product, engine_steps.product),
       op = coalesce(excluded.op, engine_steps.op),
       hold_id = coalesce(excluded.hold_id, engine_steps.hold_id),
       hold_started_at = coalesce(engine_steps.hold_started_at, excluded.hold_started_at),
       step_run_id = coalesce(excluded.step_run_id, engine_steps.step_run_id),
       agent_id = coalesce(excluded.agent_id, engine_steps.agent_id),
       in_bytes = coalesce(excluded.in_bytes, engine_steps.in_bytes),
       out_bytes = coalesce(excluded.out_bytes, engine_steps.out_bytes),
       tokens_in = coalesce(excluded.tokens_in, engine_steps.tokens_in),
       tokens_out = coalesce(excluded.tokens_out, engine_steps.tokens_out),
       error_code = excluded.error_code,
       updated_at = excluded.updated_at`,
  ).run(w.workflowId, w.runId, w.stepKey, w.stepId, w.loopPath.length ? w.loopPath.join(".") : null, w.kind, w.product ?? null, w.op ?? null, w.status, w.attempts ?? 0, w.startedAt, w.endedAt ?? null, w.hold?.id ?? null, w.hold?.startedAt ?? null, w.agent?.stepRunId ?? null, w.agent?.agentId ?? null, w.inBytes ?? null, w.outBytes ?? null, w.tokensIn ?? null, w.tokensOut ?? null, w.errorCode ?? null, now);
}

export function endHold(db: Db, workflowId: string, runId: string, stepKey: string, outcome: string, now: number): void {
  db.prepare("UPDATE engine_steps SET hold_ended_at = ?, hold_outcome = ?, updated_at = ? WHERE workflow_id = ? AND run_id = ? AND step_key = ?").run(now, outcome, now, workflowId, runId, stepKey);
}

export function getRun(db: Db, workflowId: string, runId: string): { run: RunRow; steps: StepRow[] } | null {
  const r = db.prepare(`${RUN_SELECT} WHERE r.workflow_id = ? AND r.run_id = ?`).get(workflowId, runId);
  if (!r) return null;
  const steps = db.prepare("SELECT * FROM engine_steps WHERE workflow_id = ? AND run_id = ? ORDER BY started_at, step_key").all(workflowId, runId).map(toStep);
  return { run: toRun(r), steps };
}

export function listRuns(db: Db, f: { workflowId?: string; version?: number; status?: RunStatus; scheduleId?: string; limit: number }): RunRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.workflowId) {
    where.push("r.workflow_id = ?");
    args.push(f.workflowId);
  }
  if (f.version !== undefined) {
    where.push("r.version = ?");
    args.push(f.version);
  }
  if (f.status) {
    where.push("r.status = ?");
    args.push(f.status);
  }
  if (f.scheduleId) {
    where.push("r.schedule_id = ?");
    args.push(f.scheduleId);
  }
  return db
    .prepare(`${RUN_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY r.started_at DESC, r.run_id DESC LIMIT ?`)
    .all(...args, f.limit)
    .map(toRun);
}

export function runningRuns(db: Db, limit = 500): { workflowId: string; runId: string; temporalWorkflowId: string }[] {
  return db
    .prepare("SELECT workflow_id, run_id, temporal_workflow_id FROM engine_runs WHERE status = 'running' ORDER BY started_at LIMIT ?")
    .all(limit)
    .map((r) => ({ workflowId: String(r.workflow_id), runId: String(r.run_id), temporalWorkflowId: String(r.temporal_workflow_id) }));
}

export function hasRun(db: Db, temporalWorkflowId: string): boolean {
  return db.prepare("SELECT 1 AS x FROM engine_runs WHERE temporal_workflow_id = ?").get(temporalWorkflowId) !== undefined;
}

/** The workflow of a run id (run ids are ULIDs or schedule ids, unique in practice; the newest wins). */
export function workflowOfRun(db: Db, runId: string): string | null {
  const r = db.prepare("SELECT workflow_id FROM engine_runs WHERE run_id = ? ORDER BY started_at DESC LIMIT 1").get(runId);
  return r ? String(r.workflow_id) : null;
}
