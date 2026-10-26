// Run-index reconcile (ENGINE-BUILD §7): Temporal history is the truth, engine_runs / engine_steps are an index. On boot and
// every 10 minutes: close the runs the index still shows as running when Temporal says they ended, add runs that Temporal has
// and the index lacks (an activity that never ran), and make sure every schedule row exists in Temporal. Temporal wins.
import type { Db, Logger } from "@opt2-tealbrick/miniapp-sdk";
import { type Client, WorkflowNotFoundError } from "@temporalio/client";
import * as store from "./engine-store.ts";
import { WORKFLOW_TYPE } from "./run-types.ts";
import { syncAndRecord } from "./schedules.ts";

export const RECONCILE_EVERY_MS = 10 * 60_000;
const BOOT_WINDOW_MS = 24 * 3_600_000;
const PASS_WINDOW_MS = 60 * 60_000;
const MAX_INSERT = 200;

export interface ReconcileResult {
  checked: number;
  closed: number;
  inserted: number;
  lost: number;
  schedulesChecked: number;
  schedulesCreated: number;
  errors: number;
}

type TemporalStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "TERMINATED" | "TIMED_OUT" | "CONTINUED_AS_NEW" | "UNSPECIFIED" | "PAUSED" | "UNKNOWN";

function runStatus(s: TemporalStatus): store.RunStatus | null {
  switch (s) {
    case "COMPLETED":
      return "completed";
    case "FAILED":
      return "failed";
    case "CANCELLED":
      return "cancelled";
    case "TERMINATED":
      return "terminated";
    case "TIMED_OUT":
      return "timed_out";
    default:
      return null;
  }
}

/** The failure type the interpreter threw (an ApplicationFailure with the step error code), when the run failed. */
async function failureCode(client: Client, workflowId: string): Promise<string | null> {
  try {
    await client.workflow.getHandle(workflowId).result();
    return null;
  } catch (e) {
    const cause = (e as { cause?: { type?: string | null; message?: string } }).cause;
    return cause?.type ?? null;
  }
}

export async function reconcile(db: Db, client: Client, opts: { now?: number; boot?: boolean; log?: Logger } = {}): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now();
  const out: ReconcileResult = { checked: 0, closed: 0, inserted: 0, lost: 0, schedulesChecked: 0, schedulesCreated: 0, errors: 0 };

  // 1. runs the index shows as running
  for (const r of store.runningRuns(db)) {
    out.checked++;
    try {
      const d = await client.workflow.getHandle(r.temporalWorkflowId).describe();
      const status = runStatus(d.status.name as TemporalStatus);
      if (!status) continue;
      const code = status === "failed" ? await failureCode(client, r.temporalWorkflowId) : null;
      store.finishRun(db, { workflowId: r.workflowId, runId: r.runId, status, endedAt: d.closeTime?.getTime() ?? now, errorCode: code ?? (status === "timed_out" ? "run_timeout" : null) }, now);
      out.closed++;
    } catch (e) {
      if (e instanceof WorkflowNotFoundError) {
        // Temporal has no such workflow (its data was lost or reset): the run cannot continue
        store.finishRun(db, { workflowId: r.workflowId, runId: r.runId, status: "terminated", endedAt: now, errorCode: "temporal_lost" }, now);
        out.lost++;
      } else {
        out.errors++;
        opts.log?.warn("reconcile: describe failed", { workflowId: r.temporalWorkflowId });
      }
    }
  }

  // 2. runs Temporal has and the index lacks
  try {
    const since = new Date(now - (opts.boot ? BOOT_WINDOW_MS : PASS_WINDOW_MS)).toISOString();
    for await (const w of client.workflow.list({ query: `WorkflowType = "${WORKFLOW_TYPE}" AND StartTime > "${since}"` })) {
      if (out.inserted >= MAX_INSERT) break;
      if (store.hasRun(db, w.workflowId)) continue;
      const m = /^evo:([a-z][a-z0-9-]{2,39}):(.+)$/.exec(w.workflowId);
      if (!m) continue;
      const status = runStatus(w.status.name as TemporalStatus);
      // a poll that found no change leaves no row on purpose: read the answer of a closed run before adding it
      if (status === "completed") {
        const res = await client.workflow
          .getHandle(w.workflowId)
          .result()
          .catch(() => null);
        if ((res as { status?: string } | null)?.status === "skipped") continue;
      }
      const code = status === "failed" ? await failureCode(client, w.workflowId) : null;
      const runId = (m[2] as string).slice(0, 80);
      const wfId = m[1] as string;
      db.transaction(() => {
        store.startRun(db, { workflowId: wfId, runId, version: 0, scheduleId: null, temporalWorkflowId: w.workflowId, temporalRunId: w.runId, triggerKind: "unknown", startedAt: w.startTime.getTime() }, now);
        db.prepare("UPDATE engine_runs SET source = 'reconcile', version = NULL WHERE workflow_id = ? AND run_id = ?").run(wfId, runId);
        if (status) store.finishRun(db, { workflowId: wfId, runId, status, endedAt: w.closeTime?.getTime() ?? now, errorCode: code }, now);
      });
      out.inserted++;
    }
  } catch (e) {
    out.errors++;
    opts.log?.warn("reconcile: list failed", { error: e instanceof Error ? e.message : String(e) });
  }

  // 3. schedules: every row exists in Temporal
  for (const s of store.listSchedules(db)) {
    out.schedulesChecked++;
    try {
      const was = s.temporalState;
      const h = client.schedule.getHandle(`evo-sched:${s.id}`);
      let exists = true;
      try {
        await h.describe();
      } catch {
        exists = false;
      }
      if (!exists || was !== "synced") {
        await syncAndRecord(db, client, s, now);
        if (!exists) out.schedulesCreated++;
      }
    } catch {
      out.errors++;
    }
  }
  return out;
}

export interface Reconciler {
  stop(): void;
  runNow(boot?: boolean): Promise<ReconcileResult | null>;
}

/** Boot pass + one pass every 10 minutes. Never overlaps itself; a failed pass is logged and tried again next time. */
export function startReconciler(db: Db, getClient: () => Promise<{ client: Client; connected: boolean }>, log: Logger, everyMs = RECONCILE_EVERY_MS): Reconciler {
  let busy = false;
  let first = true;
  const pass = async (boot: boolean): Promise<ReconcileResult | null> => {
    if (busy) return null;
    busy = true;
    try {
      const t = await getClient();
      if (!t.connected) return null;
      return await reconcile(db, t.client, { boot, log });
    } catch (e) {
      log.warn("reconcile failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void pass(false);
  }, everyMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    async runNow(boot = false) {
      const r = await pass(boot || first);
      if (r) first = false;
      return r;
    },
  };
}
