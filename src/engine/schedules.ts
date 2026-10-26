// Temporal Schedules of workflows (ENGINE-BUILD §6; ported from v1 createAutomationSchedule / trigger / pause / delete).
//   cron or interval + IANA time zone, overlap SKIP (or BUFFER_ONE), catch-up window 1 h, pause / unpause, run now (trigger),
//   update, describe. The Schedule carries only {workflowId, version pin, trigger} — the definition is loaded by the run's
//   first activity (v1 embedded the steps in the Schedule: a bug).
//   A `poll` schedule starts a run that begins with a read and stops early when the cursor did not change.

import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { type Client, type ScheduleDescription, ScheduleNotFoundError, type ScheduleOptions, ScheduleOverlapPolicy, type ScheduleSpec } from "@temporalio/client";
import * as store from "./engine-store.ts";
import type { RunInput } from "./run-types.ts";
import { TASK_QUEUE, WORKFLOW_TYPE } from "./run-types.ts";

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

export function scheduleAction(row: store.ScheduleRow): NonNullable<ScheduleOptions["action"]> {
  const args: RunInput = {
    workflowId: row.workflowId,
    version: row.versionPin,
    // empty: the interpreter derives the run id from the Temporal workflow id (`evo:<workflowId>:<scheduleId>-<time>`)
    runId: "",
    trigger: { kind: row.kind === "poll" ? "poll" : "schedule", timezone: row.spec.timezone, input: row.input as never, scheduleId: row.id },
  };
  return {
    type: "startWorkflow",
    workflowType: WORKFLOW_TYPE,
    taskQueue: TASK_QUEUE,
    workflowId: `evo:${row.workflowId}:${row.id}`,
    args: [args],
    memo: { scheduleId: row.id, evolutionWorkflowId: row.workflowId },
  };
}

function options(row: store.ScheduleRow, note: string): ScheduleOptions {
  return {
    scheduleId: scheduleIdOf(row.id),
    spec: toScheduleSpec(row.spec),
    action: scheduleAction(row),
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
export async function syncSchedule(client: Client, row: store.ScheduleRow): Promise<"created" | "updated"> {
  const handle = client.schedule.getHandle(scheduleIdOf(row.id));
  try {
    await handle.describe();
  } catch (e) {
    if (e instanceof ScheduleNotFoundError) {
      await client.schedule.create(options(row, row.paused ? "Created paused by Evolving Workflows." : "Created by Evolving Workflows."));
      return "created";
    }
    throw e;
  }
  const o = options(row, "Updated by Evolving Workflows.");
  await handle.update((prev) => ({ ...prev, spec: o.spec, action: o.action as never, policies: { ...prev.policies, ...o.policies }, state: { ...prev.state, paused: row.paused, note: o.state?.note } }));
  return "updated";
}

export async function pauseSchedule(client: Client, id: string, paused: boolean, note?: string): Promise<void> {
  const h = client.schedule.getHandle(scheduleIdOf(id));
  if (paused) await h.pause(note ?? "Paused by the owner.");
  else await h.unpause(note ?? "Resumed by the owner.");
}

/** Run now: one action immediately (the schedule's overlap policy still applies). */
export async function triggerSchedule(client: Client, id: string): Promise<void> {
  await client.schedule.getHandle(scheduleIdOf(id)).trigger();
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
    await syncSchedule(client, row);
    store.setScheduleSync(db, row.id, "synced", null, now);
  } catch (e) {
    store.setScheduleSync(db, row.id, "error", e instanceof Error ? e.message : String(e), now);
    throw e;
  }
}
