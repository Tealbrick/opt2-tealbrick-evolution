// Engine size signal (C373a): the app cannot read the memory or the disk of the `temporal` companion (tb-exec offers only the backup and
// restore control routes, and the health check is a TCP connect). What it CAN read cheaply is the number of workflow executions the
// namespace still keeps (one visibility count). Each kept run costs about 30 KB of the SQLite file (measured: 2.78 MB/h at about 100 runs/h),
// so the count gives an estimate of the database size. A backup restore is capped at 512 MB by tb-exec (RESTORE_MAX_BYTES in the SDK, not
// configurable by the app). When the estimate nears that cap, `attention()` says so, as an operational signal: lower the retention, or plan
// the larger limits (see "Size and resources" in ARCHITECTURE.md). The estimate is a lower bound: SQLite keeps its high-water mark after
// the retention deletes rows. Interim constants; final values follow the 24 h measurement.
import type { AppAttention } from "@opt2-tealbrick/spec/sdk";
import { getTemporal } from "./temporal.ts";

export const TEMPORAL_NEAR_RESTORE_CAP = "temporal_near_restore_cap";
/** tb-exec refuses a restore body above this (RESTORE_MAX_BYTES in @opt2-tealbrick/miniapp-sdk exec/servers.ts). */
export const RESTORE_CAP_BYTES = 512 * 1024 * 1024;
/** about 2.78 MB per hour at about 100 runs per hour (interim measurement) */
export const BYTES_PER_RUN = 30_000;
/** warn from this share of the cap */
export const WARN_FRACTION = 0.8;
export const SAMPLE_INTERVAL_MS = 10 * 60_000;

export interface EngineLoadOptions {
  /** the number of workflow executions the namespace keeps; null when the engine does not answer (default: one visibility count) */
  count?: () => Promise<number | null>;
  bytesPerRun?: number;
  capBytes?: number;
  warnFraction?: number;
}

export interface EngineLoad {
  /** Reads the count once. Never rejects; an unanswered count leaves the last state as it is. */
  sample(): Promise<void>;
  /** The last state, synchronously. Null below the threshold or before the first sample. */
  attention(): AppAttention | null;
  /** The estimated database size in bytes from the last sample (null before the first one). */
  estimatedBytes(): number | null;
  /** Samples every `intervalMs` and calls `onChange` when the warning flips. Returns the stop function. */
  watch(onChange: () => void, intervalMs?: number): () => void;
}

async function countKeptRuns(): Promise<number | null> {
  if (!process.env.TEMPORAL_ADDRESS?.trim()) return null; // no engine configured
  const t = await getTemporal();
  if (!t.connected) return null;
  return (await t.client.workflow.count()).count;
}

const mb = (bytes: number): number => Math.round(bytes / 1_048_576);

export function createEngineLoad(opts: EngineLoadOptions = {}): EngineLoad {
  const count = opts.count ?? countKeptRuns;
  const perRun = opts.bytesPerRun ?? BYTES_PER_RUN;
  const cap = opts.capBytes ?? RESTORE_CAP_BYTES;
  const fraction = opts.warnFraction ?? WARN_FRACTION;
  let est: number | null = null;

  const attention = (): AppAttention | null =>
    est !== null && est >= cap * fraction
      ? {
          code: TEMPORAL_NEAR_RESTORE_CAP,
          reason: `The workflow engine keeps about ${mb(est)} MB of run history. A backup restore accepts at most ${mb(cap)} MB. Lower the retention or plan more room.`,
        }
      : null;

  const sample = async (): Promise<void> => {
    try {
      const n = await count();
      if (n !== null && Number.isFinite(n) && n >= 0) est = n * perRun;
    } catch {
      // the engine does not answer: temporal_unreachable covers that; keep the last state
    }
  };

  return {
    sample,
    attention,
    estimatedBytes: () => est,
    watch(onChange, intervalMs = SAMPLE_INTERVAL_MS) {
      let last = attention() !== null;
      const tick = () => {
        void sample().then(() => {
          const now = attention() !== null;
          if (now !== last) {
            last = now;
            onChange();
          }
        });
      };
      tick();
      const timer = setInterval(tick, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

const shared = createEngineLoad();

/** For `defineApp({attention})`: the cached state of the shared instance, synchronously. */
export function engineLoadAttention(): AppAttention | null {
  return shared.attention();
}

/** Samples in the background (onStart) and calls `onChange` (the SDK's `ctx.statusChanged`) when the warning flips. */
export function startEngineLoadWatch(onChange: () => void, intervalMs?: number): () => void {
  return shared.watch(onChange, intervalMs);
}
