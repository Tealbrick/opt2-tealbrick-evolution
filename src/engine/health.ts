// Engine health (C367 WP1): is the Temporal companion reachable? One cheap TCP probe of TEMPORAL_ADDRESS, cached for 10 s.
// The answer is reported ONLY through `defineApp({attention})` (status push, readiness `degraded`, the owner sees the reason).
// It is never part of GET /tb/v1/health: that route is the E3 upgrade gate and must not depend on the engine.
import { connect } from "node:net";
import type { AppAttention } from "@opt2-tealbrick/spec/sdk";

export type Attention = AppAttention;

export const TEMPORAL_UNREACHABLE = "temporal_unreachable";
/** how long a probe answer is reused */
export const CACHE_MS = 10_000;
/** the SDK reads `attention()` with a 1 s timeout; the probe stays below it */
export const PROBE_TIMEOUT_MS = 700;
export const DEFAULT_PORT = 7233;
/**
 * Core's update gate needs readiness `ok` to stay `ok` after an update, and Core starts companions without waiting for their
 * health: Temporal may still be starting when the app boots. So `temporal_unreachable` is raised only after the probe has failed
 * CONTINUOUSLY for this long, and never before the boot grace (counted from onStart) has passed.
 */
export const SUSTAINED_MS = 90_000;
export const BOOT_GRACE_MS = 120_000;

/** Timing of the shared instance (tests change it; production keeps the defaults). */
export const timing = { sustainedMs: SUSTAINED_MS, bootGraceMs: BOOT_GRACE_MS };

export const UNREACHABLE_ATTENTION: Attention = {
  code: TEMPORAL_UNREACHABLE,
  reason: "The workflow engine (Temporal) cannot be reached. Running and scheduled workflows wait until it is back.",
};

export interface HostPort {
  host: string;
  port: number;
}

/** `host:port`, `[v6]:port` or a bare host (port 7233). Null for an empty or malformed value. */
export function parseAddress(address: string | undefined): HostPort | null {
  const a = address?.trim();
  if (!a) return null;
  const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(a);
  if (v6) return toHostPort(v6[1], v6[2]);
  const i = a.lastIndexOf(":");
  if (i < 0) return toHostPort(a, undefined);
  if (a.indexOf(":") !== i) return null; // a bare IPv6 literal without brackets is ambiguous
  return toHostPort(a.slice(0, i), a.slice(i + 1));
}

function toHostPort(host: string | undefined, port: string | undefined): HostPort | null {
  if (!host) return null;
  const p = port === undefined ? DEFAULT_PORT : Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  return { host, port: p };
}

/** True when a TCP connection opens within `timeoutMs`. The socket is closed at once; nothing is sent. */
export function tcpProbe(hp: HostPort, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: hp.host, port: hp.port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export interface EngineHealthOptions {
  /** read at every use (default: process.env.TEMPORAL_ADDRESS) */
  address?: () => string | undefined;
  probe?: (hp: HostPort, timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  cacheMs?: number;
  probeTimeoutMs?: number;
  /** the probe must have failed continuously this long before attention is raised (default SUSTAINED_MS) */
  sustainedMs?: number;
  /** no attention until this long after boot (default BOOT_GRACE_MS) */
  bootGraceMs?: number;
}

export interface EngineHealth {
  /** Probes unless the last answer is younger than the cache time. One probe at a time. Never rejects. */
  refresh(): Promise<void>;
  /**
   * The last known state, synchronously: null when TEMPORAL_ADDRESS is not set (no engine configured), when no probe has
   * answered yet (no false alarm at boot), when the engine answered, when the failure is younger than 90 s (a companion that is
   * still starting) or the app booted less than 120 s ago. A stale answer starts a refresh in the background.
   */
  attention(): Attention | null;
  /** The app has just started (onStart): the boot grace counts from now. */
  markBoot(): void;
  /** Probes every `intervalMs` and calls `onChange` when the state flips. Returns the stop function. */
  watch(onChange: () => void, intervalMs?: number): () => void;
}

export function createEngineHealth(opts: EngineHealthOptions = {}): EngineHealth {
  const address = opts.address ?? (() => process.env.TEMPORAL_ADDRESS);
  const probe = opts.probe ?? tcpProbe;
  const now = opts.now ?? Date.now;
  const cacheMs = opts.cacheMs ?? CACHE_MS;
  const timeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  let up: boolean | null = null;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;
  /** when the current run of failed probes began (null while the engine answers) */
  let downSince: number | null = null;
  let bootAt = now();
  const sustainedMs = (): number => opts.sustainedMs ?? timing.sustainedMs;
  const bootGraceMs = (): number => opts.bootGraceMs ?? timing.bootGraceMs;
  const raised = (): boolean => up === false && downSince !== null && now() - downSince >= sustainedMs() && now() - bootAt >= bootGraceMs();

  const refresh = (): Promise<void> => {
    const hp = parseAddress(address());
    if (!hp) return Promise.resolve();
    if (now() - checkedAt < cacheMs) return Promise.resolve();
    if (inflight) return inflight;
    inflight = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const answer = await Promise.race([
          probe(hp, timeoutMs).catch(() => false),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
        up = answer;
        checkedAt = now();
        if (answer) downSince = null;
        else downSince ??= checkedAt;
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();
    return inflight;
  };

  return {
    refresh,
    attention() {
      if (!parseAddress(address())) return null;
      if (now() - checkedAt >= cacheMs) void refresh();
      return raised() ? UNREACHABLE_ATTENTION : null;
    },
    markBoot() {
      bootAt = now();
    },
    watch(onChange, intervalMs = cacheMs) {
      bootAt = now(); // watch starts in onStart: the boot grace counts from here
      // the owner-visible state flips with TIME too (90 s of failure, 120 s of grace), not only when a probe answers differently
      let last = raised();
      const tick = () => {
        void refresh().then(() => {
          const r = raised();
          if (r !== last) {
            last = r;
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

const shared = createEngineHealth();

/** For `defineApp({attention})` (and the common interface of ENGINE-WP-COMMON): the cached state, synchronously. */
export function engineAttention(): Attention | null {
  return shared.attention();
}

/** Awaits a fresh-enough probe (at most one per 10 s, bounded below the SDK's 1 s attention timeout). */
export function refreshEngineHealth(): Promise<void> {
  return shared.refresh();
}

/** Probes in the background and calls `onChange` (the SDK's `ctx.statusChanged`) when the engine goes up or down. */
export function startEngineHealthWatch(onChange: () => void, intervalMs?: number): () => void {
  return shared.watch(onChange, intervalMs);
}
