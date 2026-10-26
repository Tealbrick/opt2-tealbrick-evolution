// Typed person-op calls (the kit's PersonOps map: id → {input, output}, generated from the manifest).
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import type { PersonOps } from "#kit";
import { errorMessage } from "./standard.tsx";

export function person<K extends keyof PersonOps>(op: K, input: PersonOps[K]["input"]): Promise<PersonOps[K]["output"]> {
  return callOp<PersonOps[K]["output"]>(op as string, input as never);
}

export type Out<K extends keyof PersonOps> = PersonOps[K]["output"];

/** The one honest sentence about Bound workflows (G11), shown wherever allowed operations appear. */
export const ALLOWLIST_TEXT =
  "The agent may call these operations; the bridge blocks every other operation. The steps are guidance you reviewed: nothing forces the agent to follow them in order.";

/** The same sentence for a schedule that targets a Free agent (C364a R1a; keep in step with `freeTargetNotice` in src/model.ts). */
export const freeTargetText = (agentName: string): string => `Runs with ${agentName}'s own access. The operation list is guidance until per-run narrowing (C288 R2–R4).`;

const SESSION_CODES = new Set(["session_required", "csrf_invalid", "network_error"]);

/** Plain sentence for a failed call: the app's own message (it is written for the owner), or the shared one for session and network errors. */
export function errorText(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && SESSION_CODES.has(code)) return errorMessage(e);
  if ((e as { httpStatus?: unknown } | null)?.httpStatus === 401) return errorMessage(e);
  return e instanceof Error && e.message ? e.message : "Something went wrong. Try again in a moment.";
}

// Dates as the approved mockup shows them (C185, D5): fixed en-GB locale and 24-hour clock, so every owner sees one form.
const DAY: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
const parts = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  Object.fromEntries(new Intl.DateTimeFormat("en-GB", opts).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));

/** "11 Oct 2026" (the owner's own day) */
export function day(iso: string): string {
  const p = parts(iso, DAY);
  return `${p.day} ${p.month} ${p.year}`;
}

/** "14 Oct 2026, 08:00" in UTC (schedules say "Times are UTC") */
export function utcStamp(iso: string): string {
  const p = parts(iso, { ...DAY, ...TIME, timeZone: "UTC" });
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}

/** "13 Oct 08:00" in UTC (the Due column of the run history) */
export function utcDue(iso: string): string {
  const p = parts(iso, { day: "numeric", month: "short", ...TIME, timeZone: "UTC" });
  return `${p.day} ${p.month} ${p.hour}:${p.minute}`;
}

/** "14 Oct 2026, 08:00" in the owner's own time zone (activity and history stamps) */
export function stamp(iso: string): string {
  const p = parts(iso, { ...DAY, ...TIME });
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}
