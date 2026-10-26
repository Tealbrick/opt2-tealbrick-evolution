// Test harness of the engine: a Temporal test environment, the real interpreter workflow (bundled once per test process),
// the real activities over an in-memory app.db, and fakes for callApp / the model port / the agent port.
import { fileURLToPath } from "node:url";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { Client } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { type CallApp, createActivities } from "../../src/engine/activities.ts";
import { currentCatalog, injectCatalog } from "../../src/engine/catalog.ts";
import type { WorkflowContract } from "../../src/engine/contract.ts";
import * as store from "../../src/engine/engine-store.ts";
import type { Json } from "../../src/engine/json.ts";
import { type RunInput, type RunResult, TASK_QUEUE } from "../../src/engine/run-types.ts";
import { setTemporalClientForTests } from "../../src/engine/temporal.ts";
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
}
export function fakeApps(): FakeApps {
  const f: FakeApps = {
    calls: [],
    on: {},
    held: {},
    callApp: async (product, op, input, opts) => {
      f.calls.push({ product, op, input, key: opts?.idempotencyKey });
      const hold = f.held[`${product}.${op}`];
      if (hold) return { status: "held", holdId: hold, expiresAt: "2026-10-27T00:00:00Z" };
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
  /** run the workflow and wait for the result */
  run(input: Partial<RunInput> & { workflowId: string }): Promise<RunResult>;
  /** save + validate + activate a contract (returns the OpUse list) */
  install(c: WorkflowContract): void;
}

export async function startEnv(opts: {
  /** a real local dev server (schedules need it; the time-skipping server has none) */
  local?: boolean; models?: (typeof import("../../src/engine/agent-port.ts"))["notImplementedModels"]; agentPort?: import("../../src/engine/agent-port.ts").AgentStepPort } = {}): Promise<Env> {
  const env = opts.local ? await TestWorkflowEnvironment.createLocal() : await TestWorkflowEnvironment.createTimeSkipping();
  setTemporalClientForTests(env.client);
  const db = migratedDb();
  const apps = fakeApps();
  const acts = createActivities({ db, callApp: apps.callApp, log: console as never, ...(opts.models ? { models: () => opts.models as never } : {}), ...(opts.agentPort ? { agentPort: () => opts.agentPort as never } : {}) });
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: TASK_QUEUE, workflowBundle: await workflowBundle(), activities: acts as never });
  const running = worker.run();
  const client = env.client;
  return {
    env,
    client,
    db,
    apps,
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
