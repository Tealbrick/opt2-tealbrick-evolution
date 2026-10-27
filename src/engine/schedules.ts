// Temporal Schedules of workflows (ENGINE-BUILD §6; ported from v1 createAutomationSchedule / trigger / pause / delete).
//   cron or interval + IANA time zone, overlap SKIP (or BUFFER_ONE), catch-up window 1 h, pause / unpause, run now (trigger),
//   update, describe. The Schedule carries only {workflowId, version pin, trigger} — the definition is loaded by the run's
//   first activity (v1 embedded the steps in the Schedule: a bug).
//   A `poll` schedule starts a run that begins with a read and stops early when the cursor did not change.

import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { type Client, type ScheduleDescription, ScheduleNotFoundError, type ScheduleOptions, ScheduleOverlapPolicy, type ScheduleSpec, WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from "@temporalio/client";
import * as store from "./engine-store.ts";
import type { RunInput } from "./run-types.ts";
import { executionCeilingMs, TASK_QUEUE, WORKFLOW_TYPE } from "./run-types.ts";

export const scheduleIdOf = (id: string): string => `evo-sched:${id}`;

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** "15m" / "6h" / "1d" -> ms */
export function everyMs(every: string): number {
  const m = /^([1-9][0-9]{0,3})([mhd])$/.exec(every);
  if (!m) throw new Error(`bad interval "${every}"`);
  return Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
}

/** The contract's schedule (cron or interval + IANA time zone) as a Temporal ScheduleSpec. The time zone is always passed on. */
export function toScheduleSpec(spec: store.ScheduleSpecRow): ScheduleSpec {
  if (spec.cron !== undefined) return { cronExpressions: [spec.cron], timezone: spec.timezone };
  if (spec.every !== undefined) return { intervals: [{ every: everyMs(spec.every) }], timezone: spec.timezone };
  throw new Error("a schedule needs cron or every");
}

/** The start input of a run of this schedule (the same for a Temporal Schedule action and for a "run now"). `runId` empty = the interpreter derives it from the workflow id. */
export function scheduleRunInput(row: store.ScheduleRow, runId = ""): RunInput {
  return {
    workflowId: row.workflowId,
    version: row.versionPin,
    runId,
    trigger: { kind: row.kind === "poll" ? "poll" : "schedule", timezone: row.spec.timezone, input: row.input as never, scheduleId: row.id },
  };
}

export function scheduleAction(row: store.ScheduleRow, executionTimeoutMs?: number): NonNullable<ScheduleOptions["action"]> {
  // empty runId: the interpreter derives it from the Temporal workflow id (`evo:<workflowId>:<scheduleId>-<time>`)
  const args = scheduleRunInput(row);
  return {
    type: "startWorkflow",
    workflowType: WORKFLOW_TYPE,
    taskQueue: TASK_QUEUE,
    workflowId: `evo:${row.workflowId}:${row.id}`,
    args: [args],
    // F2: a hard ceiling for the whole run, so a run that wedges ends
    ...(executionTimeoutMs ? { workflowExecutionTimeout: executionTimeoutMs } : {}),
    memo: { scheduleId: row.id, evolutionWorkflowId: row.workflowId },
  };
}

function options(row: store.ScheduleRow, note: string, timeoutMs?: number): ScheduleOptions {
  return {
    scheduleId: scheduleIdOf(row.id),
    spec: toScheduleSpec(row.spec),
    action: scheduleAction(row, timeoutMs),
    policies: {
      overlap: row.overlap === "buffer_one" ? ScheduleOverlapPolicy.BUFFER_ONE : ScheduleOverlapPolicy.SKIP,
      catchupWindow: "1h",
      // a failed run must not stop the schedule silently; Cycles shows the failure ratio instead
      pauseOnFailure: false,
    },
    memo: { scheduleId: row.id, workflowId: row.workflowId },
    state: { paused: row.paused, note },
  };
}

/** Creates the Temporal Schedule of a row, or updates it when it exists (idempotent: the reconcile job uses it too). */
export async function syncSchedule(client: Client, row: store.ScheduleRow, timeoutMs?: number): Promise<"created" | "updated"> {
  const handle = client.schedule.getHandle(scheduleIdOf(row.id));
  try {
    await handle.describe();
  } catch (e) {
    if (e instanceof ScheduleNotFoundError) {
      await client.schedule.create(options(row, row.paused ? "Created paused by Evolving Workflows." : "Created by Evolving Workflows.", timeoutMs));
      return "created";
    }
    throw e;
  }
  const o = options(row, "Updated by Evolving Workflows.", timeoutMs);
  await handle.update((prev) => ({ ...prev, spec: o.spec, action: o.action as never, policies: { ...prev.policies, ...o.policies }, state: { ...prev.state, paused: row.paused, note: o.state?.note } }));
  return "updated";
}

export async function pauseSchedule(client: Client, id: string, paused: boolean, note?: string): Promise<void> {
  const h = client.schedule.getHandle(scheduleIdOf(id));
  if (paused) await h.pause(note ?? "Paused by the owner.");
  else await h.unpause(note ?? "Resumed by the owner.");
}

/** The run id of a "run now": `<scheduleId>-rn<20 hex>`. The same request (same idempotency key) always gets the same id; another request, or a call without a key, gets its own. */
export function runNowId(scheduleId: string, idempotencyKey: string | null): string {
  const hex = idempotencyKey ? createHash("sha256").update(`run-now:${scheduleId}:${idempotencyKey}`).digest("hex").slice(0, 20) : randomBytes(10).toString("hex");
  return `${scheduleId}-rn${hex}`;
}

/** The hard ceiling of a run of this schedule (F2): maxRunMinutes of the version it would run, as for the Temporal Schedule. */
export function scheduleTimeoutMs(db: Db, row: store.ScheduleRow): number {
  const version = row.versionPin ?? store.activeActivation(db, row.workflowId)?.version ?? store.latestVersion(db, row.workflowId);
  const def = version === null ? null : store.getDefinition(db, row.workflowId, version);
  return executionCeilingMs(def?.contract.limits?.maxRunMinutes);
}

/**
 * Run now: starts ONE run of the schedule's workflow at once and returns its run id.
 *
 * It does not go through the Temporal Schedule's `trigger()`: the Schedule names every run it starts `<scheduleId>-<time to the
 * SECOND>`, so two "run now" in one second got the same workflow id and the second was lost, and its overlap policy dropped a
 * second one while the first was still running (S3). A deliberate click starts its own run; the Schedule keeps its own timing and
 * its overlap rule for the runs it starts itself.
 *
 * Idempotent per request: the run id comes from the idempotency key and the start refuses a duplicate id even after that run has
 * closed, so the same request sent again returns the same run (`started: false`) and never a second one.
 */
export async function runScheduleNow(client: Client, row: store.ScheduleRow, runId: string, executionTimeoutMs: number): Promise<{ runId: string; temporalWorkflowId: string; started: boolean }> {
  const temporalWorkflowId = `evo:${row.workflowId}:${runId}`;
  try {
    await client.workflow.start(WORKFLOW_TYPE, {
      taskQueue: TASK_QUEUE,
      workflowId: temporalWorkflowId,
      args: [scheduleRunInput(row, runId)],
      workflowExecutionTimeout: executionTimeoutMs,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      memo: { scheduleId: row.id, evolutionWorkflowId: row.workflowId },
    });
    return { runId, temporalWorkflowId, started: true };
  } catch (e) {
    if (e instanceof WorkflowExecutionAlreadyStartedError) return { runId, temporalWorkflowId, started: false };
    throw e;
  }
}

export async function deleteSchedule(client: Client, id: string): Promise<boolean> {
  try {
    await client.schedule.getHandle(scheduleIdOf(id)).delete();
    return true;
  } catch (e) {
    if (e instanceof ScheduleNotFoundError) return false;
    throw e;
  }
}

export interface ScheduleLive {
  state: "ok" | "missing" | "unreachable";
  paused: boolean | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunWorkflowId: string | null;
  runningCount: number;
  timezone: string | null;
  note: string | null;
}

function toLive(d: ScheduleDescription): ScheduleLive {
  const last = d.info.recentActions.at(-1);
  return {
    state: "ok",
    paused: d.state.paused,
    nextRunAt: d.info.nextActionTimes[0]?.toISOString() ?? null,
    lastRunAt: last?.takenAt.toISOString() ?? null,
    lastRunWorkflowId: last && "workflow" in last.action ? (last.action.workflow.workflowId ?? null) : null,
    runningCount: d.info.runningActions.length,
    timezone: d.spec.timezone ?? null,
    note: d.state.note ?? null,
  };
}

export async function describeSchedule(client: Client, id: string): Promise<ScheduleLive> {
  try {
    return toLive(await client.schedule.getHandle(scheduleIdOf(id)).describe());
  } catch (e) {
    if (e instanceof ScheduleNotFoundError) return { state: "missing", paused: null, nextRunAt: null, lastRunAt: null, lastRunWorkflowId: null, runningCount: 0, timezone: null, note: null };
    return { state: "unreachable", paused: null, nextRunAt: null, lastRunAt: null, lastRunWorkflowId: null, runningCount: 0, timezone: null, note: null };
  }
}

/** Marks a row `synced` or `error` after a sync attempt. */
export async function syncAndRecord(db: Db, client: Client, row: store.ScheduleRow, now: number): Promise<void> {
  try {
    await syncSchedule(client, row, scheduleTimeoutMs(db, row));
    store.setScheduleSync(db, row.id, "synced", null, now);
  } catch (e) {
    store.setScheduleSync(db, row.id, "error", e instanceof Error ? e.message : String(e), now);
    throw e;
  }
}
