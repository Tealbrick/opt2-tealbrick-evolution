// Test harness of the engine: a Temporal test environment, the real interpreter workflow (bundled once per test process),
// the real activities over an in-memory app.db, and fakes for callApp / the model port / the agent port.

import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { Client } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { type CallApp, createActivities } from "../../src/engine/activities.ts";
import { currentCatalog, injectCatalog } from "../../src/engine/catalog.ts";
import { createSealCodec, type KeyRing, keyIdOf } from "../../src/engine/codec.ts";
import type { WorkflowContract } from "../../src/engine/contract.ts";
import * as store from "../../src/engine/engine-store.ts";
import type { Json } from "../../src/engine/json.ts";
import { type RunInput, type RunResult, TASK_QUEUE } from "../../src/engine/run-types.ts";
import { dataConverter, setPayloadCodec, setTemporalClientForTests } from "../../src/engine/temporal.ts";
import { validateContract } from "../../src/engine/validate.ts";
import { evolutionRun } from "../../src/engine/workflow.ts";
import { migratedDb } from "../helpers.ts";

// quiet logs in tests (a failing test still prints its own error)
Runtime.install({ logger: new DefaultLogger("ERROR") });

export const entry = fileURLToPath(new URL("../../src/engine/workflow-entry.ts", import.meta.url));
let bundled: Promise<{ code: string }> | null = null;
/** webpack runs once per test process */
export function workflowBundle(): Promise<{ code: string }> {
  bundled ??= bundleWorkflowCode({ workflowsPath: entry });
  return bundled;
}

export interface Call {
  product: string;
  op: string;
  input: Json;
  key: string | undefined;
}
export interface FakeApps {
  calls: Call[];
  callApp: CallApp;
  /** answers per "product.op"; a function sees (input, callNumber) and may throw */
  on: Record<string, (input: Json, n: number) => unknown>;
  /** "product.op" -> the bridge holds the call for the owner (answer {status:"held"}) */
  held: Record<string, string>;
  /** "product.op" -> the first `times` calls are held with `holdId`, then the call runs */
  heldFirst: Record<string, { holdId: string; times: number; expiresAt?: string; expiresInMs?: number }>;
  /** the test server clock (time skipping moves it far ahead of the real clock) */
  clock: () => Promise<number>;
  /** the options of every call, in order */
  options: (({ idempotencyKey?: string; context?: Record<string, Json> }) | undefined)[];
}
export function fakeApps(): FakeApps {
  const f: FakeApps = {
    calls: [],
    on: {},
    held: {},
    heldFirst: {},
    options: [],
    clock: async () => Date.now(),
    callApp: async (product, op, input, opts) => {
      f.calls.push({ product, op, input, key: opts?.idempotencyKey });
      f.options.push(opts);
      const hold = f.held[`${product}.${op}`];
      if (hold) return { status: "held", holdId: hold, expiresAt: "9999-12-31T00:00:00Z" };
      const first = f.heldFirst[`${product}.${op}`];
      if (first && f.calls.filter((c) => c.product === product && c.op === op).length <= first.times) return { status: "held", holdId: first.holdId, expiresAt: first.expiresInMs !== undefined ? new Date((await f.clock()) + first.expiresInMs).toISOString() : (first.expiresAt ?? "9999-12-31T00:00:00Z") };
      const h = f.on[`${product}.${op}`];
      if (!h) throw new Error(`no fake answer for ${product}.${op}`);
      const n = f.calls.filter((c) => c.product === product && c.op === op).length;
      return { status: "ok", output: (await h(input, n)) as Json };
    },
  };
  return f;
}

export interface Env {
  env: TestWorkflowEnvironment;
  client: Client;
  db: Db;
  apps: FakeApps;
  worker: Worker;
  stop(): Promise<void>;
  /** the bridge capabilities the activities see (mutate it in a test) */
  caps: string[];
  /** run the workflow and wait for the result */
  run(input: Partial<RunInput> & { workflowId: string }): Promise<RunResult>;
  /** save + validate + activate a contract (returns the OpUse list) */
  install(c: WorkflowContract): void;
}

/** the key ring of the tests (one per process): every payload of the test servers is sealed with it, as in the app */
const testKey = randomBytes(32);
export const testRing: KeyRing = { current: keyIdOf(testKey), keys: { [keyIdOf(testKey)]: testKey } };

export async function startEnv(opts: {
  /** false: payloads are plain (only record-histories.ts, which records the replay fixtures) */
  codec?: boolean;
  /** a real local dev server (schedules need it; the time-skipping server has none) */
  local?: boolean;
  /** local server only: keep its database in this file (the backup test reads it) */
  dbFilename?: string; models?: import("../../src/engine/agent-port.ts").ModelPort; agentPort?: import("../../src/engine/agent-port.ts").AgentStepPort } = {}): Promise<Env> {
  const sealed = opts.codec !== false;
  setPayloadCodec(sealed ? createSealCodec(() => testRing) : null);
  const clientOptions = sealed ? { dataConverter } : undefined;
  const env = opts.local ? await TestWorkflowEnvironment.createLocal({ ...(clientOptions ? { client: clientOptions } : {}), ...(opts.dbFilename ? { server: { dbFilename: opts.dbFilename } } : {}) }) : await TestWorkflowEnvironment.createTimeSkipping(clientOptions ? { client: clientOptions } : {});
  setTemporalClientForTests(env.client);
  const db = migratedDb();
  const apps = fakeApps();
  apps.clock = () => env.currentTimeMs();
  const caps: string[] = [];
  const acts = createActivities({ db, callApp: apps.callApp, bridgeCaps: () => caps, log: console as never, ...(opts.models ? { models: () => opts.models as never } : {}), ...(opts.agentPort ? { agentPort: () => opts.agentPort as never } : {}) });
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: TASK_QUEUE, workflowBundle: await workflowBundle(), activities: acts as never, ...(sealed ? { dataConverter } : {}) });
  const running = worker.run();
  const client = env.client;
  return {
    env,
    client,
    db,
    apps,
    caps,
    worker,
    async stop() {
      worker.shutdown();
      await running;
      setTemporalClientForTests(null);
      await env.teardown();
    },
    async run(input) {
      const runId = input.runId ?? `r${Math.random().toString(36).slice(2, 10)}`;
      const args: RunInput = { version: null, runId, trigger: { kind: "manual", input: {} }, ...input };
      return client.workflow.execute(evolutionRun, { taskQueue: TASK_QUEUE, workflowId: `evo:${input.workflowId}:${runId}`, args: [args] });
    },
    install(c) {
      const v = validateContract(c, { companions: null });
      if (!v.ok) throw new Error(`contract invalid: ${JSON.stringify(v.errors)}`);
      store.saveDefinition(db, c, Date.now());
      store.activate(db, c.id, c.version, v.uses, Date.now());
    },
  };
}

export { currentCatalog, injectCatalog };

/** a contract around some steps */
export function wf(steps: unknown[], extra: Record<string, unknown> = {}): WorkflowContract {
  return { format: "tealbrick.workflow/1", id: "test-flow", version: 1, title: "Test", triggers: [{ kind: "manual" }], steps, ...extra } as unknown as WorkflowContract;
}
/** a knowledge.recall read step */
export const read = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, type: "app", product: "knowledge", op: "recall", input: { query: "x" }, ...extra });
/** a kanban.issue_create write step */
export const write = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, type: "app", product: "kanban", op: "issue_create", input: { title: "t" }, ...extra });

export interface IndexView {
  run: Record<string, unknown> | undefined;
  steps: Record<string, unknown>[];
}
/** the run index rows of one run (raw columns) */
export function indexOf(db: Db, workflowId: string, runId: string): IndexView {
  return {
    run: db.prepare("SELECT * FROM engine_runs WHERE workflow_id = ? AND run_id = ?").get(workflowId, runId),
    steps: db.prepare("SELECT * FROM engine_steps WHERE workflow_id = ? AND run_id = ? ORDER BY started_at, step_key").all(workflowId, runId),
  };
}
