// C367 WP1: engine health. Quiet on good (Temporal reachable, not configured, no answer yet), fire on bad (unreachable).
// The state reaches the owner only through `attention()`; GET /tb/v1/health must not change.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defineApp, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { definition, manifest } from "../src/app.ts";
import { BOOT_GRACE_MS, CACHE_MS, createEngineHealth, type HostPort, parseAddress, SUSTAINED_MS, TEMPORAL_UNREACHABLE, tcpProbe, timing, UNREACHABLE_ATTENTION } from "../src/engine/health.ts";
import { waitFor } from "./poll.ts";

/** the timing of the old tests: no wait before the attention shows */
const NOW = { sustainedMs: 0, bootGraceMs: 0 };

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((s) => s.destroy());
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve({ server, port: typeof a === "object" && a ? a.port : 0 });
    });
  });
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

async function closedPort(): Promise<number> {
  const { server, port } = await listen();
  await close(server);
  return port;
}

test("parseAddress: host:port, bare host, [v6]:port, and refusals", () => {
  assert.deepEqual(parseAddress("temporal.railway.internal:7233"), { host: "temporal.railway.internal", port: 7233 });
  assert.deepEqual(parseAddress("temporal.railway.internal"), { host: "temporal.railway.internal", port: 7233 });
  assert.deepEqual(parseAddress("[fd12::1]:7000"), { host: "fd12::1", port: 7000 });
  assert.deepEqual(parseAddress(" 127.0.0.1:1 "), { host: "127.0.0.1", port: 1 });
  for (const bad of [undefined, "", "  ", ":7233", "host:0", "host:70000", "host:abc", "fd12::1:7233"]) assert.equal(parseAddress(bad), null, String(bad));
});

test("tcpProbe: true for an open port, false for a closed one", async () => {
  const { server, port } = await listen();
  try {
    assert.equal(await tcpProbe({ host: "127.0.0.1", port }, 500), true);
  } finally {
    await close(server);
  }
  assert.equal(await tcpProbe({ host: "127.0.0.1", port }, 500), false);
});

test("quiet on good: reachable, not configured, and no answer yet give no attention", async () => {
  const { server, port } = await listen();
  try {
    const up = createEngineHealth({ address: () => `127.0.0.1:${port}` });
    assert.equal(up.attention(), null, "no answer yet is not an alarm");
    await up.refresh();
    assert.equal(up.attention(), null, "reachable");
  } finally {
    await close(server);
  }
  let probes = 0;
  const none = createEngineHealth({
    address: () => undefined,
    probe: async () => {
      probes++;
      return false;
    },
  });
  await none.refresh();
  assert.equal(none.attention(), null, "TEMPORAL_ADDRESS not set: no engine configured");
  assert.equal(probes, 0, "nothing is probed without an address");
});

test("fire on bad: unreachable gives temporal_unreachable, and clears when it comes back", async () => {
  let address = `127.0.0.1:${await closedPort()}`;
  const h = createEngineHealth({ address: () => address, cacheMs: 0, ...NOW });
  await h.refresh();
  const a = h.attention();
  assert.deepEqual(a, UNREACHABLE_ATTENTION);
  assert.equal(a?.code, TEMPORAL_UNREACHABLE);
  assert.match(a?.code ?? "", /^[a-z][a-z0-9_]{0,39}$/, "the SDK's code pattern");
  assert.ok((a?.reason.length ?? 999) <= 200, "the SDK's reason limit");
  assert.ok(!/127\.0\.0\.1|\d{4,5}/.test(a?.reason ?? ""), "the reason carries no host or port");
  const { server, port } = await listen();
  try {
    address = `127.0.0.1:${port}`;
    await h.refresh(); // joins the background refresh that attention() started on the old address (cacheMs 0) ...
    await h.refresh(); // ... then probes the new one
    assert.equal(h.attention(), null, "back up");
  } finally {
    await close(server);
  }
});

test("the answer is cached for 10 s, one probe at a time, and a hanging probe counts as down", async () => {
  let clock = 1_000_000;
  let probes = 0;
  let answer = true;
  const h = createEngineHealth({
    ...NOW,
    address: () => "temporal:7233",
    now: () => clock,
    probe: async () => {
      probes++;
      await new Promise((r) => setTimeout(r, 5));
      return answer;
    },
  });
  await Promise.all([h.refresh(), h.refresh(), h.refresh()]);
  assert.equal(probes, 1, "concurrent refreshes share one probe");
  clock += CACHE_MS - 1;
  await h.refresh();
  assert.equal(probes, 1, "younger than 10 s: reused");
  answer = false;
  assert.equal(h.attention(), null, "the cached answer still says up");
  clock += 1;
  await h.refresh();
  assert.equal(probes, 2, "10 s passed: probed again");
  assert.deepEqual(h.attention(), UNREACHABLE_ATTENTION);

  const hang = createEngineHealth({ ...NOW, address: () => "temporal:7233", cacheMs: 0, probeTimeoutMs: 20, probe: () => new Promise<boolean>(() => {}) });
  const t0 = Date.now();
  await hang.refresh();
  assert.ok(Date.now() - t0 < 1000, "bounded below the SDK's 1 s attention timeout");
  assert.deepEqual(hang.attention(), UNREACHABLE_ATTENTION);
  const throwing = createEngineHealth({ ...NOW, address: () => "temporal:7233", cacheMs: 0, probe: async () => Promise.reject(new Error("boom")) });
  await throwing.refresh();
  assert.deepEqual(throwing.attention(), UNREACHABLE_ATTENTION, "a throwing probe is down, never an exception");
});

test("sync attention() starts a refresh when the answer is stale", async () => {
  let probes = 0;
  const h = createEngineHealth({
    ...NOW,
    address: () => "temporal:7233",
    probe: async (_hp: HostPort) => {
      probes++;
      return false;
    },
  });
  assert.equal(h.attention(), null);
  await waitFor("the first attention() call kicked off a probe and its answer (down) is cached", () => h.attention() !== null);
  assert.equal(probes, 1, "the first call kicked off a probe");
  assert.deepEqual(h.attention(), UNREACHABLE_ATTENTION);
  assert.equal(probes, 1, "fresh: no new probe");
});

test("watch calls onChange when the owner-visible state flips (the attention shows or clears) and stops when told", async () => {
  let up = true;
  let probes = 0;
  const h = createEngineHealth({
    ...NOW,
    address: () => "temporal:7233",
    cacheMs: 0,
    probe: async () => {
      probes++;
      return up;
    },
  });
  const changes: number[] = [];
  const stop = h.watch(() => changes.push(Date.now()), 15);
  // wait for watch ticks (probes), not for wall-clock time: a loaded runner delays a timer, never the order of events
  const ticks = (n: number, what: string) => {
    const goal = probes + n;
    return waitFor(what, () => probes >= goal);
  };
  await ticks(3, "three watch ticks with Temporal up");
  assert.equal(changes.length, 0, "unknown -> up shows nothing new");
  up = false;
  await waitFor("up -> down: the attention shows (onChange called once)", () => changes.length >= 1);
  await ticks(3, "three more watch ticks with Temporal down");
  assert.equal(changes.length, 1, "up -> down: the attention shows, once");
  assert.deepEqual(h.attention(), UNREACHABLE_ATTENTION);
  up = true;
  await waitFor("back up: the attention clears (onChange called again)", () => changes.length >= 2);
  await ticks(3, "three more watch ticks with Temporal up again");
  assert.equal(changes.length, 2, "back up: it clears, once");
  stop();
  const n = changes.length;
  up = false;
  await new Promise((r) => setTimeout(r, 60)); // an absence check: a slow runner can only make it pass sooner, never fail
  assert.equal(changes.length, n, "stopped");
});

test("gate-safe: an early failure (Temporal still starting) gives NO attention; a failure that lasts 90 s does; the boot grace of 120 s counts from onStart", async () => {
  assert.equal(SUSTAINED_MS, 90_000);
  assert.equal(BOOT_GRACE_MS, 120_000);
  let clock = 1_000_000;
  let up = false;
  let probes = 0;
  const h = createEngineHealth({
    address: () => "temporal:7233",
    now: () => clock,
    cacheMs: 0,
    probe: async () => {
      probes++;
      return up;
    },
  });
  const at = async (ms: number) => {
    clock = 1_000_000 + ms;
    await h.refresh(); // joins the background refresh that attention() started on the previous call ...
    await h.refresh(); // ... then probes with the current answer
    return h.attention();
  };
  h.markBoot(); // onStart at t = 0
  assert.equal(await at(1_000), null, "the first failed probe at boot: no attention");
  assert.equal(await at(30_000), null, "30 s of failure");
  assert.equal(await at(89_000), null, "89 s: not yet 90 s of failure");
  assert.equal(await at(100_000), null, "failing for 99 s, but the app booted 100 s ago: boot grace (120 s)");
  assert.equal(await at(119_000), null, "still in the boot grace");
  assert.deepEqual(await at(121_000), UNREACHABLE_ATTENTION, "failed continuously for 120 s and past the boot grace: now it shows");
  up = true;
  assert.equal(await at(131_000), null, "one good probe clears it");
  up = false;
  assert.equal(await at(141_000), null, "a NEW failure starts the 90 s over (a single failed probe after a good one is nothing)");
  assert.equal(await at(200_000), null, "59 s of the new failure");
  assert.deepEqual(await at(232_000), UNREACHABLE_ATTENTION, "91 s of the new failure");
  assert.ok(probes >= 8);
});

test("gate-safe: flapping never shows (down 80 s, up, down 80 s ...), a failure of 95 s in a row after the grace does", async () => {
  let clock = 5_000_000;
  let up = false;
  const h = createEngineHealth({ address: () => "temporal:7233", now: () => clock, cacheMs: 0, probe: async () => up });
  const step = async (ms: number, answer: boolean) => {
    clock += ms;
    up = answer;
    await h.refresh();
    await h.refresh();
    return h.attention();
  };
  h.markBoot();
  clock += 200_000; // far past the grace
  for (let i = 0; i < 4; i++) {
    assert.equal(await step(10_000, false), null);
    assert.equal(await step(70_000, false), null, "80 s down");
    assert.equal(await step(5_000, true), null);
  }
  assert.equal(await step(1_000, false), null);
  assert.deepEqual(await step(95_000, false), UNREACHABLE_ATTENTION, "95 s in a row");
});

test("gate-safe: the shared instance uses the defaults (90 s / 120 s); only the app test switches them off", () => {
  assert.deepEqual({ ...timing }, { sustainedMs: 90_000, bootGraceMs: 120_000 });
});

test("the app reports the engine through attention() and never through /tb/v1/health", async (t) => {
  const prior = process.env.TEMPORAL_ADDRESS;
  const priorTiming = { ...timing };
  Object.assign(timing, NOW); // this test checks the route, not the waiting
  const dead = await closedPort();
  process.env.TEMPORAL_ADDRESS = `127.0.0.1:${dead}`;
  const dir = mkdtempSync(join(tmpdir(), `${manifest.id}-engine-health-`));
  const { server, port: free } = await listen();
  await close(server);
  const local = { ...manifest, runtime: { ...manifest.runtime, port: free } };
  const running = await startApp(defineApp({ ...definition, manifest: local }), { TB_DATA_DIR: dir, TB_STANDALONE: "1", TB_LOG_LEVEL: "error", TB_DATA_EPHEMERAL: "1" });
  t.after(() => {
    Object.assign(timing, priorTiming);
    if (prior === undefined) delete process.env.TEMPORAL_ADDRESS;
    else process.env.TEMPORAL_ADDRESS = prior;
    rmSync(dir, { recursive: true, force: true });
  });
  try {
    const attention = await definition.attention?.({} as never);
    assert.equal(attention?.code, TEMPORAL_UNREACHABLE, "the engine is down: the owner sees it");
    const res = await fetch(`http://127.0.0.1:${free}/tb/v1/health`);
    const health = (await res.json()) as { status: string };
    assert.equal(res.status, 200);
    assert.equal(health.status, "ok", "the E3 gate does not depend on the engine");
    assert.ok(!JSON.stringify(health).toLowerCase().includes("temporal"), "no engine text in /tb/v1/health");
  } finally {
    await running.stop();
  }
});
