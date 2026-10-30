// One polling helper for every test that waits for something that happens later (Temporal visibility, a worker, a timer in
// the code under test). Never a bare sleep: a sleep is either too short on a loaded CI runner or too long everywhere.
import assert from "node:assert/strict";

export interface WaitOptions {
  /** give up after this long (default 60 s; CI can be slow, a poll that passes returns at once, so a long bound costs nothing) */
  timeoutMs?: number;
  /** pause between two checks (default 50 ms) */
  intervalMs?: number;
}
/**
 * Polls `check` until it passes. It passes when it returns without throwing and without returning `false`, so a plain
 * boolean condition and an assertion body (`async () => { assert.equal(...) }`) both work. Use it for everything Temporal
 * answers later than the call that caused it: schedule / workflow LIST (visibility is eventually consistent), a describe
 * right after a create, a worker that has not picked a task up yet. Never a bare sleep.
 * On timeout it FAILS with what it waited for, how long, and the last answer or error, so a CI log says what was missing.
 */
export async function waitFor(what: string, check: () => unknown, opts: WaitOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 50;
  const t0 = Date.now();
  let last = "the condition was never true";
  for (;;) {
    try {
      if ((await check()) !== false) return;
    } catch (e) {
      last = `last error: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (Date.now() - t0 > timeoutMs) assert.fail(`timed out after ${Date.now() - t0} ms waiting for: ${what} (${last})`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** The result of `p`, or a failure with `what` when it takes longer than `ms`. The timer is cleared, so it never keeps the process alive. */
export async function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, no) => {
        timer = setTimeout(() => no(new Error(what)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
