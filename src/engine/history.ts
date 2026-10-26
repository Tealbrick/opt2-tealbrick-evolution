// What a step got and gave, read from the Temporal history for the owner's run detail (C88: owner-only; ENGINE-BUILD §7).
// app.db holds sizes, never bodies; the bodies live in Temporal history (the activity inputs and results), and this module
// reads them on demand, for one run, when the owner opens it. Every value is capped; a bigger one is replaced by its size.
import type { Client } from "@temporalio/client";
import type { Json } from "./json.ts";

export const IO_CAP_BYTES = 50_000;

export interface StepIo {
  input?: Json;
  output?: Json;
  /** a failure message of the last failed attempt, as Temporal recorded it */
  error?: string;
}

/** The structural slice of a history event this module reads (the proto types are not a direct dependency). */
export interface HistoryEventLike {
  eventId?: unknown;
  activityTaskScheduledEventAttributes?: { activityType?: { name?: string | null } | null; input?: { payloads?: PayloadLike[] | null } | null } | null;
  activityTaskCompletedEventAttributes?: { scheduledEventId?: unknown; result?: { payloads?: PayloadLike[] | null } | null } | null;
  activityTaskFailedEventAttributes?: { scheduledEventId?: unknown; failure?: { message?: string | null } | null } | null;
  workflowExecutionStartedEventAttributes?: { continuedExecutionRunId?: string | null } | null;
}
interface PayloadLike {
  metadata?: Record<string, Uint8Array> | null;
  data?: Uint8Array | string | null;
}

const id = (v: unknown): string => String(v ?? "");

function decode(p: PayloadLike | undefined): Json | undefined {
  if (!p?.data) return undefined;
  const enc = p.metadata?.encoding ? Buffer.from(p.metadata.encoding).toString("utf8") : "json/plain";
  if (enc !== "json/plain") return undefined;
  try {
    const text = typeof p.data === "string" ? Buffer.from(p.data, "base64").toString("utf8") : Buffer.from(p.data).toString("utf8");
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

function cap(v: Json | undefined): Json | undefined {
  if (v === undefined) return undefined;
  const bytes = JSON.stringify(v).length;
  return bytes > IO_CAP_BYTES ? { truncated: true, bytes } : v;
}

interface Args {
  stepKey?: string;
  input?: Json;
  inputs?: Json;
  instruction?: string;
  title?: string;
  context?: string;
  purpose?: string;
}

/** Per step key: the input and output of its activities. Pure: the events of every Temporal run of the chain, oldest first. */
export function stepIoFromEvents(events: readonly HistoryEventLike[]): Record<string, StepIo> {
  const scheduled = new Map<string, { type: string; args: Args }>();
  const out: Record<string, StepIo> = {};
  const slot = (key: string): StepIo => (out[key] ??= {});
  for (const e of events) {
    const s = e.activityTaskScheduledEventAttributes;
    if (s) {
      const args = (decode(s.input?.payloads?.[0]) ?? {}) as Args;
      scheduled.set(id(e.eventId), { type: s.activityType?.name ?? "", args });
      continue;
    }
    const done = e.activityTaskCompletedEventAttributes;
    const failed = e.activityTaskFailedEventAttributes;
    const sid = id((done ?? failed)?.scheduledEventId);
    const sc = scheduled.get(sid);
    if (!sc?.args.stepKey) continue;
    const key = sc.args.stepKey;
    const result = done ? decode(done.result?.payloads?.[0]) : undefined;
    if (sc.type === "appStep") {
      slot(key).input = cap(sc.args.input);
      if (done && result && typeof result === "object" && !Array.isArray(result) && (result as { status?: unknown }).status === "ok") slot(key).output = cap((result as { output?: Json }).output);
    } else if (sc.type === "aiStep") {
      slot(key).input = cap({ instruction: sc.args.instruction ?? "", inputs: sc.args.inputs ?? null });
      // a role call answers {output, tokens}; an agent step completes with the typed output itself
      if (done && result !== undefined) slot(key).output = cap(result && typeof result === "object" && !Array.isArray(result) && "output" in result && "tokensIn" in (result as object) ? (result as { output: Json }).output : result);
    } else if (sc.type === "approvalAsk" && sc.args.purpose === "approval") {
      slot(key).input = cap({ title: sc.args.title ?? "", context: sc.args.context ?? "" });
    } else if (sc.type === "approvalPoll" && sc.args.purpose === "approval" && done && result && typeof result === "object" && (result as { status?: unknown }).status === "answered") {
      slot(key).output = cap({ response: (result as { response?: Json }).response ?? null, message: (result as { message?: Json }).message ?? null });
    }
    if (failed) slot(key).error = String(failed.failure?.message ?? "failed").slice(0, 300);
  }
  return out;
}

/** The chain of Temporal runs of one workflow id (continue-as-new), oldest first, then the step I/O of all of them. */
export async function readStepIo(client: Client, temporalWorkflowId: string, timeoutMs = 5000): Promise<Record<string, StepIo> | null> {
  const work = (async () => {
    const latest = (await client.workflow.getHandle(temporalWorkflowId).describe()).runId;
    const chain: HistoryEventLike[][] = [];
    let runId: string | undefined = latest;
    for (let i = 0; runId && i < 50; i++) {
      const h = await client.workflow.getHandle(temporalWorkflowId, runId).fetchHistory();
      const events = (h.events ?? []) as unknown as HistoryEventLike[];
      chain.unshift(events);
      runId = events[0]?.workflowExecutionStartedEventAttributes?.continuedExecutionRunId || undefined;
    }
    return stepIoFromEvents(chain.flat());
  })();
  work.catch(() => undefined);
  return Promise.race([work.catch(() => null), new Promise<null>((ok) => setTimeout(() => ok(null), timeoutMs))]);
}
