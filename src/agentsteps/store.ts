// Agent-step store (C367 WP3, ENGINE-BUILD §5): the app-side mirror of the async Temporal activity of an `ai` step with
// `by: {agent}`. Pure database rules; the Temporal calls (complete / fail / heartbeat) are made by ./ops.ts around them.
//
//   offer (engine)  → offered
//   step_claim      → claimed      at most once: the UPDATE only matches status 'offered' (primary key + status guard)
//   step_report     → completed | failed
//   deadline / 3 missed heartbeats → timed_out (the same rule Temporal applies; Temporal wins, see `sweep` and `markGone`)
//   cancel (engine) → cancelled
// R1a (C364a): a caller reaches a step only when (agent_id = caller id AND target_mode = caller mode); a paused or removed
// agent (src/directory.ts) gets nothing. An open step keeps its inputs; an ended step keeps neither inputs nor task token.
import { createHash } from "node:crypto";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import * as directory from "../directory.ts";
import * as store from "../store.ts";
import {
  type AgentStepOffer,
  type ClaimedStep,
  CONTENT_ONLY_NOTE,
  HEARTBEAT_MISSES,
  OPEN_STATUSES,
  type StepEvent,
  type StepRefusal,
  type StepStatus,
  type StepView,
  type TargetMode,
} from "./types.ts";

export const MAX_INSTRUCTION_CHARS = 20_000;
export const MAX_INPUTS_BYTES = 512 * 1024;
export const MAX_SCHEMA_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const MAX_SUMMARY_CHARS = 500;
export const MAX_DUE = 50;
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Refusal of an agent-step rule; ./ops.ts maps `code` to the CORE §8 envelope. */
export class AgentStepError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, httpStatus: number, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const isoOrNull = (ms: unknown): string | null => (ms === null || ms === undefined ? null : iso(ms));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));

export interface StepRow {
  stepRunId: string;
  workflowId: string;
  version: number;
  runId: string;
  stepId: string;
  agentId: string;
  targetMode: TargetMode;
  status: StepStatus;
  attempt: number;
  instruction: string;
  inputsJson: string | null;
  outputSchemaJson: string;
  timeoutSec: number;
  heartbeatSec: number;
  taskToken: string | null;
  offeredAt: number;
  deadlineAt: number;
  claimedBy: string | null;
  claimedAt: number | null;
  heartbeatAt: number | null;
  finishedAt: number | null;
  outputBytes: number | null;
  outputSha256: string | null;
  summary: string | null;
  metricsJson: string | null;
  invalidReports: number;
  updatedAt: number;
}

function toRow(r: Record<string, unknown>): StepRow {
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    stepRunId: String(r.step_run_id),
    workflowId: String(r.workflow_id),
    version: Number(r.version),
    runId: String(r.run_id),
    stepId: String(r.step_id),
    agentId: String(r.agent_id),
    targetMode: r.target_mode === "bound" ? "bound" : "free",
    status: r.status as StepStatus,
    attempt: Number(r.attempt),
    instruction: String(r.instruction),
    inputsJson: strOrNull(r.inputs_json),
    outputSchemaJson: String(r.output_schema_json),
    timeoutSec: Number(r.timeout_sec),
    heartbeatSec: Number(r.heartbeat_sec),
    taskToken: strOrNull(r.task_token),
    offeredAt: Number(r.offered_at),
    deadlineAt: Number(r.deadline_at),
    claimedBy: strOrNull(r.claimed_by),
    claimedAt: n(r.claimed_at),
    heartbeatAt: n(r.heartbeat_at),
    finishedAt: n(r.finished_at),
    outputBytes: n(r.output_bytes),
    outputSha256: strOrNull(r.output_sha256),
    summary: strOrNull(r.summary),
    metricsJson: strOrNull(r.metrics_json),
    invalidReports: Number(r.invalid_reports),
    updatedAt: Number(r.updated_at),
  };
}

export function getRow(db: Db, stepRunId: string): StepRow | null {
  const r = db.prepare("SELECT * FROM agent_step_runs WHERE step_run_id = ?").get(stepRunId);
  return r ? toRow(r) : null;
}

function logEvent(db: Db, row: Pick<StepRow, "stepRunId" | "attempt" | "agentId">, kind: StepStatus, detail: string | null, now: number, agentId: string = row.agentId): void {
  db.prepare("INSERT INTO agent_step_events (step_run_id, attempt, kind, agent_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)").run(row.stepRunId, row.attempt, kind, agentId, detail, now);
}

// ── time rules (the mirror of Temporal's startToClose and heartbeatTimeout) ──

/** Which rule has ended an OPEN step: its deadline (startToClose), or three missed heartbeats since the claim.
 *  An offered step has no heartbeat clock here: Temporal's own clock answers that, and `markGone` learns it on contact. */
export function expiryOf(r: Pick<StepRow, "status" | "deadlineAt" | "heartbeatAt" | "heartbeatSec">, now: number): { by: "deadline" | "heartbeat"; detail: string } | null {
  if (!OPEN_STATUSES.has(r.status)) return null;
  if (now > r.deadlineAt) return { by: "deadline", detail: "No result before the step deadline." };
  if (r.status === "claimed" && r.heartbeatAt !== null && now > r.heartbeatAt + HEARTBEAT_MISSES * r.heartbeatSec * 1000)
    return { by: "heartbeat", detail: `No heartbeat for ${HEARTBEAT_MISSES} x ${r.heartbeatSec} s.` };
  return null;
}

function end(db: Db, r: StepRow, status: Exclude<StepStatus, "offered" | "claimed">, detail: string | null, now: number, extra: { summary?: string | null; outputBytes?: number | null; outputSha256?: string | null; metricsJson?: string | null } = {}): void {
  db.prepare(
    "UPDATE agent_step_runs SET status = ?, inputs_json = NULL, task_token = NULL, finished_at = ?, summary = COALESCE(?, summary), output_bytes = COALESCE(?, output_bytes), output_sha256 = COALESCE(?, output_sha256), metrics_json = COALESCE(?, metrics_json), updated_at = ? WHERE step_run_id = ? AND status IN ('offered', 'claimed')",
  ).run(status, now, extra.summary ?? null, extra.outputBytes ?? null, extra.outputSha256 ?? null, extra.metricsJson ?? null, now, r.stepRunId);
  logEvent(db, r, status, detail, now, status === "completed" || status === "failed" ? (r.claimedBy ?? r.agentId) : r.agentId);
}

/** Ends every open step whose deadline or heartbeat window has passed as `timed_out`. Cheap; any op may run it. */
export function sweep(db: Db, now: number = Date.now()): number {
  let n = 0;
  for (const raw of db.prepare("SELECT * FROM agent_step_runs WHERE status IN ('offered', 'claimed')").all()) {
    const r = toRow(raw);
    const e = expiryOf(r, now);
    if (!e) continue;
    end(db, r, "timed_out", e.detail, now);
    n++;
  }
  return n;
}

/** Temporal says the activity is gone (timed out or finished there) or cancelled. Temporal wins: the mirror follows. */
export function markGone(db: Db, stepRunId: string, as: "timed_out" | "cancelled", detail: string, now: number = Date.now()): void {
  const r = getRow(db, stepRunId);
  if (r && OPEN_STATUSES.has(r.status)) end(db, r, as, detail, now);
}

// ── engine side (AgentStepPort) ──

function checkOffer(db: Db, o: AgentStepOffer): void {
  const bad = (message: string, pointer: string): never => {
    throw new AgentStepError("validation_failed", message, 422, { pointer });
  };
  if (!STEP_ID.test(o.stepRunId)) bad("stepRunId must be 1 to 128 letters, digits, and _ . : - .", "/stepRunId");
  if (!Number.isInteger(o.version) || o.version < 1) bad("version must be a positive integer.", "/version");
  if (!Number.isInteger(o.attempt) || o.attempt < 1) bad("attempt must be a positive integer.", "/attempt");
  if (!Number.isInteger(o.heartbeatSec) || o.heartbeatSec < 1 || o.heartbeatSec > 3600) bad("heartbeatSec must be 1 to 3600.", "/heartbeatSec");
  if (!Number.isInteger(o.timeoutSec) || o.timeoutSec < o.heartbeatSec || o.timeoutSec > 7 * 86_400) bad("timeoutSec must be at least heartbeatSec and at most 7 days.", "/timeoutSec");
  if (typeof o.instruction !== "string" || o.instruction.length === 0 || o.instruction.length > MAX_INSTRUCTION_CHARS) bad(`instruction must have 1 to ${MAX_INSTRUCTION_CHARS} characters.`, "/instruction");
  if (typeof o.taskToken !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.taskToken)) bad("taskToken must be base64.", "/taskToken");
  if (bytesOf(o.inputs) > MAX_INPUTS_BYTES) bad(`inputs may have at most ${MAX_INPUTS_BYTES} bytes.`, "/inputs");
  if (bytesOf(o.outputSchema) > MAX_SCHEMA_BYTES) bad(`outputSchema may have at most ${MAX_SCHEMA_BYTES} bytes.`, "/outputSchema");
  const schema = o.outputSchema as { type?: unknown };
  if (schema === null || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object") bad('outputSchema must be a JSON Schema with "type": "object" (a typed output is an object).', "/outputSchema/type");
  // Compile the schema now: a broken one is the engine's error at the offer, not the agent's at the report. The validator
  // answers a schema it cannot compile with "schema not compilable: ..." instead of throwing.
  const probe = validateAgainstSchema(o.outputSchema as never, {} as never);
  if (!probe.ok && probe.errors.some((e) => e.message.startsWith("schema not compilable"))) bad(`outputSchema is not a valid JSON Schema: ${probe.errors[0]?.message.slice(0, 200)}`, "/outputSchema");
  if (!directory.isFreeAgent(db, o.agentId))
    throw new AgentStepError("agent_not_free", "The agent of this step is not a Free agent that Evolving Workflows knows. An agent step runs with the agent's own access: choose an agent in the agent list with the mode Free.", 422, { pointer: "/agentId" });
}

/** The engine's `AgentStepPort.offer`. Idempotent per attempt; a higher attempt of the same step re-offers it (Temporal retry). */
export function offer(db: Db, o: AgentStepOffer, now: number = Date.now()): void {
  checkOffer(db, o);
  db.transaction(() => {
    const prior = getRow(db, o.stepRunId);
    const fields = [o.workflowId, o.version, o.runId, o.stepId, o.agentId, "free", o.attempt, o.instruction, JSON.stringify(o.inputs), JSON.stringify(o.outputSchema), o.timeoutSec, o.heartbeatSec, o.taskToken, now, now + o.timeoutSec * 1000, now] as const;
    if (!prior) {
      db.prepare(
        "INSERT INTO agent_step_runs (workflow_id, version, run_id, step_id, agent_id, target_mode, attempt, instruction, inputs_json, output_schema_json, timeout_sec, heartbeat_sec, task_token, offered_at, deadline_at, updated_at, status, step_run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offered', ?)",
      ).run(...fields, o.stepRunId);
      logEvent(db, { stepRunId: o.stepRunId, attempt: o.attempt, agentId: o.agentId }, "offered", null, now);
      return;
    }
    if (prior.workflowId !== o.workflowId || prior.runId !== o.runId || prior.stepId !== o.stepId)
      throw new AgentStepError("conflict", "This stepRunId belongs to another workflow, run or step.", 409);
    if (o.attempt < prior.attempt) return; // a stale offer of an older attempt
    if (o.attempt === prior.attempt) {
      // The same attempt offered again (the activity called the port twice): only a still-unclaimed step takes the new token.
      if (prior.status === "offered") db.prepare("UPDATE agent_step_runs SET task_token = ?, updated_at = ? WHERE step_run_id = ?").run(o.taskToken, now, o.stepRunId);
      return;
    }
    // A new attempt: an attempt that is still open is superseded (Temporal started a new one), then the row starts over.
    if (OPEN_STATUSES.has(prior.status)) end(db, prior, "cancelled", `Replaced by attempt ${o.attempt}.`, now);
    db.prepare(
      "UPDATE agent_step_runs SET workflow_id = ?, version = ?, run_id = ?, step_id = ?, agent_id = ?, target_mode = ?, attempt = ?, instruction = ?, inputs_json = ?, output_schema_json = ?, timeout_sec = ?, heartbeat_sec = ?, task_token = ?, offered_at = ?, deadline_at = ?, updated_at = ?, status = 'offered', claimed_by = NULL, claimed_at = NULL, heartbeat_at = NULL, finished_at = NULL, output_bytes = NULL, output_sha256 = NULL, summary = NULL, metrics_json = NULL, invalid_reports = 0 WHERE step_run_id = ?",
    ).run(...fields, o.stepRunId);
    logEvent(db, { stepRunId: o.stepRunId, attempt: o.attempt, agentId: o.agentId }, "offered", null, now);
  });
}

/** The engine's `AgentStepPort.cancel`. Idempotent: an unknown or ended step is left as it is. */
export function cancel(db: Db, stepRunId: string, now: number = Date.now()): void {
  db.transaction(() => {
    const r = getRow(db, stepRunId);
    if (r && OPEN_STATUSES.has(r.status)) end(db, r, "cancelled", "Cancelled by the engine.", now);
  });
}

// ── agent side ──

export interface CallerLike {
  type: string;
  id: string;
  mode: string | null;
}
const modeOf = (c: CallerLike): TargetMode | null => (c.type === "agent" && (c.mode === "bound" || c.mode === "free") ? c.mode : null);

/** steps_due: the caller's OFFERED steps of its own mode. A Bound agent, a non-agent, a paused or a removed agent gets none. Claims nothing. */
export function dueSteps(db: Db, caller: CallerLike, now: number = Date.now()): { stepRunId: string; workflowTitle: string; deadline: string }[] {
  return db.transaction(() => {
    sweep(db, now);
    const mode = modeOf(caller);
    if (mode === null || !directory.isAvailable(db, caller.id)) return [];
    return db
      .prepare("SELECT * FROM agent_step_runs WHERE agent_id = ? AND target_mode = ? AND status = 'offered' ORDER BY offered_at, step_run_id LIMIT ?")
      .all(caller.id, mode, MAX_DUE)
      .map(toRow)
      .map((r) => ({ stepRunId: r.stepRunId, workflowTitle: titleOf(db, r.workflowId), deadline: iso(r.deadlineAt) }));
  });
}

function titleOf(db: Db, workflowId: string): string {
  try {
    return store.getWorkflow(db, workflowId).title;
  } catch {
    return workflowId;
  }
}

/** Guidance only (the agent uses its own access): the operations of the reviewed version, when the version is one that
 *  Evolution stores (a workflow migrated from 0.3.x). Engine versions without such a list answer []. */
function allowedHintOf(db: Db, r: StepRow): ClaimedStep["allowedHint"] {
  try {
    return store.getVersion(db, r.workflowId, r.version).allowed.map((a) => ({ product: a.product, operations: [...a.operations], crud: [...a.crud] }));
  } catch {
    return [];
  }
}

export type ClaimResult = { claimed: true; step: ClaimedStep; row: StepRow } | { claimed: false; reason: StepRefusal };

const REFUSAL_BY_STATUS: Record<Exclude<StepStatus, "offered">, StepRefusal> = { claimed: "already_claimed", completed: "finished", failed: "finished", timed_out: "timed_out", cancelled: "cancelled" };

/** Loads the caller's own step and refuses everything the R1a rules refuse. Returns the row when the caller may touch it. */
function ownStep(db: Db, caller: CallerLike, stepRunId: string): { row: StepRow } | { reason: StepRefusal } {
  const mode = modeOf(caller);
  if (mode === null) return { reason: "mode_mismatch" };
  if (!directory.isAvailable(db, caller.id)) return { reason: "agent_unavailable" };
  const row = getRow(db, stepRunId);
  if (!row || row.agentId !== caller.id) return { reason: "not_found" }; // not yours looks the same as not there
  if (row.targetMode !== mode) return { reason: "mode_mismatch" };
  return { row };
}

/** step_claim: the ONE write that turns an offered step into a claimed one. At most once: the conditional UPDATE matches only 'offered'. */
export function claim(db: Db, caller: CallerLike, stepRunId: string, now: number = Date.now()): ClaimResult {
  return db.transaction((): ClaimResult => {
    sweep(db, now);
    const own = ownStep(db, caller, stepRunId);
    if ("reason" in own) return { claimed: false, reason: own.reason };
    const { row } = own;
    if (row.status !== "offered") return { claimed: false, reason: REFUSAL_BY_STATUS[row.status] };
    const won = db.prepare("UPDATE agent_step_runs SET status = 'claimed', claimed_by = ?, claimed_at = ?, heartbeat_at = ?, updated_at = ? WHERE step_run_id = ? AND status = 'offered'").run(caller.id, now, now, now, stepRunId);
    if (Number(won.changes) !== 1) return { claimed: false, reason: "already_claimed" };
    logEvent(db, row, "claimed", null, now, caller.id);
    const claimed = getRow(db, stepRunId) ?? row;
    return {
      claimed: true,
      row: claimed,
      step: {
        stepRunId,
        workflowTitle: titleOf(db, row.workflowId),
        attempt: row.attempt,
        instruction: row.instruction,
        inputs: JSON.parse(row.inputsJson ?? "{}") as Record<string, unknown>,
        outputSchema: JSON.parse(row.outputSchemaJson) as object,
        allowedHint: allowedHintOf(db, row),
        deadline: iso(row.deadlineAt),
        heartbeatSec: row.heartbeatSec,
        mode: "content",
        note: CONTENT_ONLY_NOTE,
      },
    };
  });
}

const REFUSAL_TEXT: Record<StepRefusal, [code: string, status: number, message: string]> = {
  not_found: ["not_found", 404, "No step with this id is offered to you."],
  mode_mismatch: ["mode_mismatch", 409, "This step is not for an agent of your mode. Agent steps go to Free agents."],
  agent_unavailable: ["agent_unavailable", 409, "You are paused or removed, so you get no steps."],
  already_claimed: ["already_claimed", 409, "This step is already claimed."],
  not_claimed: ["not_claimed", 409, "Claim the step before you work on it."],
  finished: ["step_finished", 409, "This step has ended."],
  timed_out: ["step_timed_out", 409, "This step timed out: its deadline or its heartbeat window passed. Stop working on it."],
  cancelled: ["step_cancelled", 409, "The engine cancelled this step. Stop working on it."],
};
export const refusal = (reason: StepRefusal, details?: Record<string, unknown>): AgentStepError => {
  const [code, status, message] = REFUSAL_TEXT[reason];
  return new AgentStepError(code, message, status, details);
};

/** The caller's CLAIMED, still-open step for a heartbeat or a report; throws the refusal otherwise. Ends an expired step first. */
export function openClaimed(db: Db, caller: CallerLike, stepRunId: string, now: number = Date.now()): StepRow {
  const found = db.transaction(() => {
    sweep(db, now);
    return ownStep(db, caller, stepRunId);
  });
  if ("reason" in found) throw refusal(found.reason);
  const { row } = found;
  if (row.status === "offered") throw refusal("not_claimed");
  if (row.status !== "claimed") throw refusal(REFUSAL_BY_STATUS[row.status]);
  if (row.claimedBy !== caller.id) throw refusal("not_found");
  return row;
}

export function beat(db: Db, stepRunId: string, now: number = Date.now()): StepRow {
  db.prepare("UPDATE agent_step_runs SET heartbeat_at = ?, updated_at = ? WHERE step_run_id = ? AND status = 'claimed'").run(now, now, stepRunId);
  const r = getRow(db, stepRunId);
  if (!r) throw refusal("not_found");
  return r;
}

export function heartbeatBy(r: StepRow): string {
  return iso(Math.min(r.deadlineAt, (r.heartbeatAt ?? r.offeredAt) + HEARTBEAT_MISSES * r.heartbeatSec * 1000));
}

export interface ReportInput {
  status: "completed" | "failed";
  output?: unknown;
  summary?: string;
  metrics?: Record<string, number>;
}

/** Checks the typed output against the step's own schema. A bad output is a 422 with a pointer; the step stays claimed. */
export function checkOutput(db: Db, row: StepRow, output: unknown, now: number = Date.now()): { bytes: number; sha256: string } {
  const reject = (message: string, pointer: string, errors?: unknown): never => {
    db.prepare("UPDATE agent_step_runs SET invalid_reports = invalid_reports + 1, updated_at = ? WHERE step_run_id = ?").run(now, row.stepRunId);
    throw new AgentStepError("output_invalid", message, 422, { pointer, ...(errors ? { errors } : {}) });
  };
  if (output === undefined || output === null) return reject("A completed report needs the typed output.", "/output");
  const bytes = bytesOf(output);
  if (bytes > MAX_OUTPUT_BYTES) return reject(`The output may have at most ${MAX_OUTPUT_BYTES} bytes.`, "/output");
  const v = validateAgainstSchema(JSON.parse(row.outputSchemaJson) as never, JSON.parse(JSON.stringify(output)) as never);
  if (!v.ok) {
    const first = v.errors[0];
    const pointer = `/output${first?.path ?? ""}`.replace(/\/$/, "");
    return reject(`The output does not match the step's output schema${first ? `: ${first.message}` : ""}. Fix it and report again; the step stays claimed until it times out.`, pointer, v.errors.slice(0, 5));
  }
  return { bytes, sha256: createHash("sha256").update(JSON.stringify(output)).digest("hex") };
}

export function finish(db: Db, stepRunId: string, status: "completed" | "failed", r: ReportInput, out: { bytes: number; sha256: string } | null, now: number = Date.now()): StepRow {
  db.transaction(() => {
    const row = getRow(db, stepRunId);
    if (!row) throw refusal("not_found");
    end(db, row, status, status === "failed" ? (r.summary?.slice(0, MAX_SUMMARY_CHARS) ?? "The agent reported failure.") : null, now, {
      summary: r.summary?.trim().slice(0, MAX_SUMMARY_CHARS) || null,
      outputBytes: out?.bytes ?? null,
      outputSha256: out?.sha256 ?? null,
      metricsJson: r.metrics && Object.keys(r.metrics).length ? JSON.stringify(r.metrics) : null,
    });
  });
  const done = getRow(db, stepRunId);
  if (!done) throw refusal("not_found");
  return done;
}

// ── owner side ──

export function eventsOf(db: Db, stepRunId: string): StepEvent[] {
  return db
    .prepare("SELECT attempt, kind, agent_id, detail, at FROM agent_step_events WHERE step_run_id = ? ORDER BY id")
    .all(stepRunId)
    .map((e) => ({ attempt: Number(e.attempt), kind: e.kind as StepStatus, agentId: String(e.agent_id), detail: strOrNull(e.detail), at: iso(e.at) }));
}

export function viewOf(db: Db, r: StepRow): StepView {
  return {
    stepRunId: r.stepRunId,
    workflowId: r.workflowId,
    workflowTitle: titleOf(db, r.workflowId),
    version: r.version,
    runId: r.runId,
    stepId: r.stepId,
    agentId: r.agentId,
    status: r.status,
    attempt: r.attempt,
    offeredAt: iso(r.offeredAt),
    deadlineAt: iso(r.deadlineAt),
    claimedBy: r.claimedBy,
    claimedAt: isoOrNull(r.claimedAt),
    heartbeatAt: isoOrNull(r.heartbeatAt),
    finishedAt: isoOrNull(r.finishedAt),
    heartbeatSec: r.heartbeatSec,
    outputBytes: r.outputBytes,
    summary: r.summary,
    metrics: r.metricsJson ? (JSON.parse(r.metricsJson) as Record<string, number>) : null,
    invalidReports: r.invalidReports,
    events: eventsOf(db, r.stepRunId),
  };
}

/** Owner view (person op): the steps of one run or one workflow, newest first. Open steps past their time are shown as timed out. */
export function listSteps(db: Db, f: { runId?: string; workflowId?: string; limit: number }, now: number = Date.now()): StepView[] {
  return db.transaction(() => {
    sweep(db, now);
    const where = [f.runId ? "run_id = ?" : null, f.workflowId ? "workflow_id = ?" : null].filter(Boolean);
    const args = [f.runId, f.workflowId].filter((x): x is string => typeof x === "string");
    const sql = `SELECT * FROM agent_step_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY offered_at DESC, step_run_id DESC LIMIT ?`;
    return db
      .prepare(sql)
      .all(...args, f.limit)
      .map(toRow)
      .map((r) => viewOf(db, r));
  });
}
