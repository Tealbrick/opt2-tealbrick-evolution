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
import { NativeConnection, Worker } from "@temporalio/worker";
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
}
let cached: Cached | null = null;
let override: Client | null = null;
const CHECK_TTL_MS = 3000;
const CHECK_TIMEOUT_MS = 2000;

/** Tests: use this client (for example `TestWorkflowEnvironment.client`) instead of a connection to TEMPORAL_ADDRESS. */
export function setTemporalClientForTests(c: Client | null): void {
  override = c;
}

async function probe(connection: Connection): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connection.workflowService.getSystemInfo({}),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getTemporal(): Promise<{ client: Client; connected: boolean }> {
  if (override) return { client: override, connected: true };
  const cfg = temporalConfig();
  const address = cfg.address ?? "localhost:7233";
  const key = `${address}|${cfg.namespace}`;
  if (!cached || cached.key !== key) {
    if (cached) void cached.connection.close().catch(() => undefined);
    // lazy: the app boots and serves while Temporal is still starting; the first call connects
    const connection = Connection.lazy({ address });
    cached = { key, connection, client: new Client({ connection, namespace: cfg.namespace }), checkedAt: 0, connected: false };
  }
  const c = cached;
  if (cfg.address === null) return { client: c.client, connected: false };
  if (Date.now() - c.checkedAt > CHECK_TTL_MS) {
    c.connected = await probe(c.connection);
    c.checkedAt = Date.now();
  }
  return { client: c.client, connected: c.connected };
}

export async function closeTemporal(): Promise<void> {
  const c = cached;
  cached = null;
  if (c) await c.connection.close().catch(() => undefined);
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
