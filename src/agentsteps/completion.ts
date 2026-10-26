// Async completion of the Temporal activity behind an agent step (ENGINE-BUILD §5): `client.activity.complete / fail /
// heartbeat(taskToken)`. The real client comes from the engine (WP2: `getTemporal()` in src/engine/temporal.ts); this module
// only holds the way to get it and sorts its errors, so no @temporalio package is imported here and tests use a fake.
import { AgentStepError } from "./store.ts";
import type { ActivityCompletion } from "./types.ts";

export type CompletionProvider = () => Promise<ActivityCompletion>;

let provider: CompletionProvider | null = null;

/** Set once at start-up by the engine wiring. See `completionFromTemporal`. */
export function setCompletionProvider(p: CompletionProvider | null): void {
  provider = p;
}

/** The provider the app handlers use. Until the engine is wired (TEMP until WP2's PR lands) every call answers 503. */
export const defaultCompletion: CompletionProvider = async () => {
  if (!provider) throw new AgentStepError("engine_unavailable", "The workflow engine is not connected, so steps cannot be completed now. Try again in a moment.", 503);
  return provider();
};

/** Adapts WP2's `getTemporal()` (`{ client, connected }`): `client.activity` is the Temporal AsyncCompletionClient. */
export function completionFromTemporal(getTemporal: () => Promise<{ client: { activity: ActivityCompletion }; connected: boolean }>): CompletionProvider {
  return async () => {
    const t = await getTemporal();
    if (!t.connected) throw new AgentStepError("engine_unavailable", "The workflow engine is not reachable, so steps cannot be completed now. Try again in a moment.", 503);
    return t.client.activity;
  };
}

/** What a failed Temporal call means for the step. Matching is by error name, so no Temporal class is imported.
 *  gone: Temporal no longer has the activity open (timed out, finished or cancelled there), cancelled: the workflow asked
 *  to cancel it, transient: anything else (network, server busy): the step is left as it is and the caller may retry. */
export function classify(e: unknown): "gone" | "cancelled" | "transient" {
  const names = [(e as { name?: unknown } | null)?.name, (e as { constructor?: { name?: unknown } } | null)?.constructor?.name];
  if (names.includes("ActivityNotFoundError")) return "gone";
  if (names.includes("ActivityCancelledError") || names.includes("CancelledFailure")) return "cancelled";
  return "transient";
}

export const tokenOf = (base64: string | null): Uint8Array => Buffer.from(base64 ?? "", "base64");
