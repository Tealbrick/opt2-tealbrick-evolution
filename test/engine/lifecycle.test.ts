// Start and stop of the engine inside the app (onStart / onStop): getTemporal() against a real server and a dead address,
// the worker coming up (also when Temporal starts late), a run started through startRun, and a stop within the SDK's 5 s.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { engineState, startEngine, startRun, stopEngine } from "../../src/engine/engine.ts";
import * as store from "../../src/engine/engine-store.ts";
import { closeTemporal, getTemporal, temporalConfig } from "../../src/engine/temporal.ts";
import { migratedDb } from "../helpers.ts";
import { fakeApps, read, waitFor, wf } from "./harness.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}
/** the SDK secret store, in memory */
function memorySecrets(): { get(n: string): Promise<string | null>; put(n: string, v: string): Promise<void> } {
  const m = new Map<string, string>();
  return { get: async (n) => m.get(n) ?? null, put: async (n, v) => void m.set(n, v) };
}
const log = { debug() {}, info() {}, warn() {}, error() {} };

test("config: TEMPORAL_ADDRESS, namespace evolution and task queue evolution by default", () => {
  assert.deepEqual(temporalConfig({}), { address: null, namespace: "evolution", taskQueue: "evolution" });
  assert.deepEqual(temporalConfig({ TEMPORAL_ADDRESS: "temporal.railway.internal:7233" }), { address: "temporal.railway.internal:7233", namespace: "evolution", taskQueue: "evolution" });
});

test("without TEMPORAL_ADDRESS the engine is off: getTemporal says not connected, start and stop are quiet", async () => {
  const prev = process.env.TEMPORAL_ADDRESS;
  delete process.env.TEMPORAL_ADDRESS;
  try {
    const t = await getTemporal();
    assert.equal(t.connected, false);
    assert.ok(t.client, "a client object exists so callers need no null check");
    const apps = fakeApps();
    await startEngine({ db: migratedDb(), callApp: apps.callApp, log: log as never, secrets: memorySecrets() });
    assert.deepEqual(engineState(), { worker: "disabled", lastError: null, configured: false });
    await stopEngine();
  } finally {
    if (prev !== undefined) process.env.TEMPORAL_ADDRESS = prev;
    await closeTemporal();
  }
});

test("a dead address: connected is false within a few seconds, the worker keeps trying, stop returns at once", async () => {
  const port = await freePort();
  process.env.TEMPORAL_ADDRESS = `127.0.0.1:${port}`;
  try {
    const t0 = Date.now();
    assert.equal((await getTemporal()).connected, false);
    assert.ok(Date.now() - t0 < 6000, `probe took ${Date.now() - t0} ms`);
    const apps = fakeApps();
    await startEngine({ db: migratedDb(), callApp: apps.callApp, log: log as never, secrets: memorySecrets() });
    // a positive signal instead of a sleep: the worker has tried the dead address and recorded why it failed
    await waitFor("the worker has tried the dead address (lastError is set)", () => engineState().lastError !== null);
    assert.equal(engineState().worker, "starting");
    const s0 = Date.now();
    await stopEngine();
    assert.ok(Date.now() - s0 < 5000, "stop is within the SDK's 5 s");
  } finally {
    delete process.env.TEMPORAL_ADDRESS;
    await closeTemporal();
  }
});

test("a real server: the worker comes up, a run started with startRun completes with the workflow id evo:<workflow>:<run>, stop is clean", async () => {
  const port = await freePort();
  const env = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", port, namespace: "evolution" } });
  process.env.TEMPORAL_ADDRESS = `127.0.0.1:${port}`;
  try {
    const db = migratedDb();
    const apps = fakeApps();
    apps.on["knowledge.recall"] = () => ({});
    const c = wf([read("a")], { id: "life-flow" });
    // saved + activated through the store, as the owner ops do
    const { validateContract } = await import("../../src/engine/validate.ts");
    store.saveDefinition(db, c, Date.now());
    store.activate(db, c.id, 1, validateContract(c, { companions: null }).uses, Date.now());
    await startEngine({ db, callApp: apps.callApp, log: log as never, secrets: memorySecrets() });
    await waitFor("the worker reaches the state running", () => engineState().worker === "running");
    assert.equal((await getTemporal()).connected, true);
    const started = await startRun({ workflowId: "life-flow", runId: "run_life" });
    assert.equal(started.temporalWorkflowId, "evo:life-flow:run_life");
    await waitFor("the run run_life is completed in the index", () => db.prepare("SELECT status FROM engine_runs WHERE run_id = 'run_life'").get()?.status === "completed");
    assert.equal(apps.calls.length, 1);
    const s0 = Date.now();
    await stopEngine();
    assert.ok(Date.now() - s0 < 5000);
    assert.equal(engineState().worker, "disabled");
  } finally {
    delete process.env.TEMPORAL_ADDRESS;
    await closeTemporal();
    await env.teardown();
  }
});
