// Engine lifecycle: the Temporal worker and the reconcile job, started from the app's `onStart` and stopped in `onStop`
// (SDK-API: 5 s stop timeout). Without TEMPORAL_ADDRESS the engine is off and the app behaves as 0.3.x.
import type { Db, Logger } from "@opt2-tealbrick/miniapp-sdk";
import { type CallApp, createActivities } from "./activities.ts";
import { type Reconciler, startReconciler } from "./reconcile.ts";
import { newRunId, type StartRunInput, startRun } from "./start-run.ts";
import { closeTemporal, getTemporal, startWorker, temporalConfig, type WorkerHandle, type WorkerState } from "./temporal.ts";

export interface EngineStartContext {
  db: Db;
  callApp: CallApp;
  log: Logger;
}

let worker: WorkerHandle | null = null;
let reconciler: Reconciler | null = null;

export function startEngine(ctx: EngineStartContext): void {
  if (worker) return;
  const log = ctx.log;
  const activities = createActivities({ db: ctx.db, callApp: ctx.callApp, log });
  reconciler = startReconciler(ctx.db, getTemporal, log);
  worker = startWorker({
    activities,
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
    onRunning: () => {
      void reconciler?.runNow(true);
    },
  });
}

export async function stopEngine(): Promise<void> {
  const w = worker;
  const r = reconciler;
  worker = null;
  reconciler = null;
  r?.stop();
  await w?.stop(3500);
  await closeTemporal();
}

export function engineState(): { worker: WorkerState; lastError: string | null; configured: boolean } {
  return { worker: worker?.state() ?? "disabled", lastError: worker?.lastError() ?? null, configured: temporalConfig().address !== null };
}

export { newRunId, type StartRunInput, startRun };
