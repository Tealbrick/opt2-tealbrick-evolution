// C373a: the size signal of the engine database. Quiet on good (small count, no answer, no engine), fire on bad (near the restore cap).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BYTES_PER_RUN, createEngineLoad, RESTORE_CAP_BYTES, SAMPLE_INTERVAL_MS, TEMPORAL_NEAR_RESTORE_CAP, WARN_FRACTION } from "../src/engine/load.ts";

/** the number of kept runs at which the estimate reaches the warning share of the cap */
const THRESHOLD_RUNS = Math.ceil((RESTORE_CAP_BYTES * WARN_FRACTION) / BYTES_PER_RUN);

test("quiet on good: few kept runs, no sample yet, no answer from the engine", async () => {
  const fresh = createEngineLoad({ count: async () => 100 });
  assert.equal(fresh.attention(), null, "no sample yet");
  await fresh.sample();
  assert.equal(fresh.attention(), null, "100 runs are far below the cap");
  assert.equal(fresh.estimatedBytes(), 100 * BYTES_PER_RUN);
  const justBelow = createEngineLoad({ count: async () => THRESHOLD_RUNS - 1 });
  await justBelow.sample();
  assert.equal(justBelow.attention(), null, "one run below the threshold");
  const silent = createEngineLoad({ count: async () => null });
  await silent.sample();
  assert.equal(silent.attention(), null, "engine not configured or not answering");
  const failing = createEngineLoad({
    count: async () => {
      throw new Error("unreachable");
    },
  });
  await failing.sample();
  assert.equal(failing.attention(), null, "a failed count is not an alarm (temporal_unreachable covers it)");
});

test("fire on bad: the estimate reaches the warning share of the 512 MB restore cap", async () => {
  const load = createEngineLoad({ count: async () => THRESHOLD_RUNS });
  await load.sample();
  const a = load.attention();
  assert.equal(a?.code, TEMPORAL_NEAR_RESTORE_CAP);
  assert.match(a?.reason ?? "", /512 MB/);
  assert.equal(RESTORE_CAP_BYTES, 512 * 1024 * 1024, "the cap is the tb-exec restore cap");
});

test("the warning clears when the count falls, and a failed count keeps the last state", async () => {
  let n: number | null = THRESHOLD_RUNS + 1000;
  const load = createEngineLoad({ count: async () => n });
  await load.sample();
  assert.ok(load.attention());
  n = null;
  await load.sample();
  assert.ok(load.attention(), "no answer keeps the last state");
  n = 10;
  await load.sample();
  assert.equal(load.attention(), null);
});

test("watch: calls onChange only when the warning flips", async () => {
  let n = 10;
  const load = createEngineLoad({ count: async () => n });
  let changes = 0;
  const stop = load.watch(() => changes++, 20);
  try {
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(changes, 0, "quiet on good");
    n = THRESHOLD_RUNS + 1;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(changes, 1, "one flip, not one call per sample");
    assert.ok(load.attention());
  } finally {
    stop();
  }
  assert.ok(SAMPLE_INTERVAL_MS >= 60_000, "production samples rarely (one visibility count)");
});
