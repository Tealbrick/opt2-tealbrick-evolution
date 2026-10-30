// Temporal client + worker bootstrap (ENGINE-BUILD §1, §3; ported from v1 temporal-runtime.ts).
//
// FIXED interface (ENGINE-WP-COMMON): `getTemporal(): Promise<{ client: Client; connected: boolean }>`. The address comes from
// TEMPORAL_ADDRESS (WP1 sets it in the manifest env: `{{services.temporal.host}}:7233`), namespace `evolution`, task queue
// `evolution`. `connected` is false while the Temporal service does not answer; the app stays up (health is never degraded
// by this: WP1's `attention()` reports it).
//
// The worker starts from the app's `onStart` (src/engine/engine.ts) and stops in `onStop`. The workflow code is a PREBUILT
// bundle (scripts/build-workflows.ts): the worker loads dist/engine/workflow-bundle.js instead of running webpack at start.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import type { Payload, PayloadCodec } from "@temporalio/common";
import { NativeConnection, Worker } from "@temporalio/worker";
import { lockedCodec } from "./codec.ts";
import type { Activities, LocalActivities } from "./run-types.ts";
import { NAMESPACE, TASK_QUEUE } from "./run-types.ts";

export interface TemporalConfig {
  address: string | null;
  namespace: string;
  taskQueue: string;
}

export function temporalConfig(env: Record<string, string | undefined> = process.env): TemporalConfig {
  const address = env.TEMPORAL_ADDRESS?.trim();
  return { address: address ? address : null, namespace: env.TEMPORAL_NAMESPACE?.trim() || NAMESPACE, taskQueue: env.TEMPORAL_TASK_QUEUE?.trim() || TASK_QUEUE };
}

interface Cached {
  key: string;
  connection: Connection;
  client: Client;
  checkedAt: number;
  connected: boolean;
  /** the probe in flight, so a close waits for it */
  probing: Promise<boolean> | null;
}
let cached: Cached | null = null;

// ── the payload codec (C371): every payload of the client and the worker goes through it ──
let activeCodec: PayloadCodec = lockedCodec;
let codecReady = false;
/** Installs the sealing codec once its key ring is loaded (engine.ts). Until then every payload is refused and getTemporal says not connected. */
export function setPayloadCodec(c: PayloadCodec | null): void {
  activeCodec = c ?? lockedCodec;
  codecReady = c !== null;
}
/** The codec the client, the worker and the history reads share; it follows setPayloadCodec. */
export const payloadCodec: PayloadCodec = {
  encode: (p: Payload[]) => activeCodec.encode(p),
  decode: (p: Payload[]) => activeCodec.decode(p),
};
export const dataConverter = { payloadCodecs: [payloadCodec] };
let override: Client | null = null;
const CHECK_TTL_MS = 3000;
const CHECK_TIMEOUT_MS = 2000;

/** Tests: use this client (for example `TestWorkflowEnvironment.client`) instead of a connection to TEMPORAL_ADDRESS. */
export function setTemporalClientForTests(c: Client | null): void {
  override = c;
}

/** One cheap call with a deadline. The deadline also ends the client's own retry loop (a call without one retries on a timer
 *  for a long time and throws from that timer after the connection is closed). */
async function probe(connection: Connection): Promise<boolean> {
  try {
    await connection.withDeadline(Date.now() + CHECK_TIMEOUT_MS, () => connection.workflowService.getSystemInfo({}));
    return true;
  } catch {
    return false;
  }
}

export async function getTemporal(): Promise<{ client: Client; connected: boolean }> {
  if (override) return { client: override, connected: true };
  const cfg = temporalConfig();
  const address = cfg.address ?? "localhost:7233";
  const key = `${address}|${cfg.namespace}`;
  if (!cached || cached.key !== key) {
    if (cached) void closeTemporal();
    // lazy: the app boots and serves while Temporal is still starting; the first call connects
    const connection = Connection.lazy({ address });
    cached = { key, connection, client: new Client({ connection, namespace: cfg.namespace, dataConverter }), checkedAt: 0, connected: false, probing: null };
  }
  const c = cached;
  if (cfg.address === null || !codecReady) return { client: c.client, connected: false };
  if (Date.now() - c.checkedAt > CHECK_TTL_MS) {
    c.probing ??= probe(c.connection).finally(() => {
      c.probing = null;
    });
    c.connected = await c.probing;
    c.checkedAt = Date.now();
  }
  return { client: c.client, connected: c.connected };
}

export async function closeTemporal(): Promise<void> {
  const c = cached;
  cached = null;
  if (c) {
    await c.probing?.catch(() => undefined);
    await c.connection.close().catch(() => undefined);
  }
}

// ───────────────────────────── worker ─────────────────────────────

export type WorkerState = "disabled" | "starting" | "running" | "failed" | "stopped";

export interface WorkerHandle {
  state(): WorkerState;
  lastError(): string | null;
  stop(timeoutMs?: number): Promise<void>;
}

export interface WorkerOptions {
  activities: Activities & LocalActivities;
  config?: TemporalConfig;
  /** ms between connection attempts while Temporal is down (default 10 000) */
  retryMs?: number;
  log: { info(m: string, f?: Record<string, never>): void; warn(m: string, f?: Record<string, never>): void; error(m: string, f?: Record<string, never>): void };
  /** called when the worker is up (the engine runs its first reconcile here) */
  onRunning?: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The prebuilt bundle next to this file (dist/engine/), else the TypeScript entry (webpack at start; development only). */
export function workflowSource(): { workflowBundle: { codePath: string } } | { workflowsPath: string } {
  const bundle = fileURLToPath(new URL("./workflow-bundle.js", import.meta.url));
  if (existsSync(bundle)) return { workflowBundle: { codePath: bundle } };
  const ts = fileURLToPath(new URL("./workflow-entry.ts", import.meta.url));
  const js = fileURLToPath(new URL("./workflow-entry.js", import.meta.url));
  return { workflowsPath: existsSync(ts) ? ts : js };
}

/** Starts the worker in the background and keeps trying until Temporal answers (v1 start() retry loop). */
export function startWorker(o: WorkerOptions): WorkerHandle {
  const cfg = o.config ?? temporalConfig();
  let state: WorkerState = "disabled";
  let lastError: string | null = null;
  let stopped = false;
  let worker = null as Worker | null;
  let connection = null as NativeConnection | null;
  let run = null as Promise<void> | null;

  if (cfg.address === null) {
    o.log.info("engine worker disabled: TEMPORAL_ADDRESS is not set");
    return { state: () => state, lastError: () => null, async stop() {} };
  }
  const address = cfg.address;
  state = "starting";

  async function ensure(): Promise<void> {
    connection = await NativeConnection.connect({ address });
    worker = await Worker.create({
      connection,
      namespace: cfg.namespace,
      taskQueue: cfg.taskQueue,
      ...workflowSource(),
      activities: o.activities as never,
      dataConverter,
      // a small host (0.5 vCPU, 768 MB): few cached workflows, one workflow thread pair
      maxCachedWorkflows: 100,
      maxConcurrentActivityTaskExecutions: 20,
      maxConcurrentWorkflowTaskExecutions: 20,
      workflowThreadPoolSize: 2,
      shutdownGraceTime: "3s",
    });
    const w = worker;
    run = w.run().then(
      () => {
        if (!stopped) state = "stopped";
      },
      (e: unknown) => {
        lastError = e instanceof Error ? e.message : String(e);
        state = "failed";
        worker = null;
      },
    );
    state = "running";
    lastError = null;
    o.onRunning?.();
  }

  void (async () => {
    while (!stopped && !worker) {
      try {
        const t = await getTemporal();
        if (!t.connected) throw new Error(`Temporal at ${address} does not answer`);
        await ensure();
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        state = "starting";
        o.log.warn(`engine worker: ${lastError}; retrying`);
        await connection?.close().catch(() => undefined);
        connection = null;
        await sleep(o.retryMs ?? 10_000);
      }
    }
  })();

  return {
    state: () => state,
    lastError: () => lastError,
    async stop(timeoutMs = 4000) {
      stopped = true;
      worker?.shutdown();
      if (run) await Promise.race([run, sleep(timeoutMs)]);
      await connection?.close().catch(() => undefined);
      state = "stopped";
    },
  };
}
