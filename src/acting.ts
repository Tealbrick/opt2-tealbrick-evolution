// C380 B7 dev.2: acting tickets for durable work done for an agent (DESIGN-ACTING-AGENT.md section 3, SDK 0.1.45).
//   routine_claim  (the agent's call)  -> mint, job `rt.<occurrence>`            -> the run's Task Board calls carry it
//   step_claim     (the agent's call)  -> mint, job `run.<workflow>.<run>`        -> every later `app` step of that run carries it
// The ticket only makes a call STRICTER: Rules may deny or hold on the agent; an allow never reads it. Without the bridge cap
// `acting_agents` nothing is minted and nothing is sent (an older bridge: today's path). With the cap, a ticket that cannot be
// minted refuses the claim (503, nothing claimed), and a ticket the bridge refuses stops the run (`acting_ticket_invalid`).
// Tickets are stored in app.db only, never in a Temporal payload, a log line or an answer (C371), and are dropped when the job ends.
import { createHash } from "node:crypto";
import type { Db, OpContext, SdkOpContext } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";

export const CAP_ACTING = "acting_agents";
/** A job id the bridge accepts. */
const JOB = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The bridge takes 1..4 acting agents per call. */
export const MAX_ACTING_AGENTS = 4;

export interface ActingEnvelope {
  job: string;
  tickets: string[];
}

const hashed = (s: string): string => `h.${createHash("sha256").update(s).digest("hex").slice(0, 40)}`;
const safe = (job: string): string => (JOB.test(job) ? job : hashed(job));
export const jobOfOccurrence = (occurrence: string): string => safe(`rt.${occurrence}`);
export const jobOfRun = (workflowId: string, runId: string): string => safe(`run.${workflowId}.${runId}`);

/** The bridge of this workspace can issue and verify tickets. */
export function hasActingCap(ctx: OpContext): boolean {
  const fn = (ctx as Partial<SdkOpContext>).bridgeCaps;
  return typeof fn === "function" && fn.call(ctx).includes(CAP_ACTING);
}

interface Parsed {
  agent: string;
  exp: number;
}
/** `sub` (`tb:agt:<id>`) and `exp` of a ticket. Decoded for filing only: the bridge is the one that verifies it. */
function parse(ticket: string): Parsed | null {
  try {
    const p = JSON.parse(Buffer.from(ticket.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown };
    const m = typeof p.sub === "string" ? /^tb:agt:(agt_[0-9A-HJKMNP-TV-Z]{26})$/.exec(p.sub) : null;
    if (!m?.[1] || typeof p.exp !== "number" || !Number.isFinite(p.exp)) return null;
    return { agent: m[1], exp: p.exp * 1000 };
  } catch {
    return null;
  }
}

const unavailable = (): TbError => new TbError("acting_unavailable", "The workspace could not issue the ticket that shows who this work is for. Nothing was changed. Try again in a moment.", 503);

/** Asks the bridge for the tickets of the open call, for one job. Throws 503 when it cannot (nothing is written here). */
export async function mint(ctx: OpContext, job: string): Promise<string[]> {
  const fn = (ctx as Partial<SdkOpContext>).actingTickets;
  if (typeof fn !== "function") throw unavailable();
  try {
    const tickets = await fn.call(ctx, job);
    if (!Array.isArray(tickets) || tickets.length === 0 || tickets.some((t) => typeof t !== "string" || parse(t) === null)) throw unavailable();
    return tickets;
  } catch (e) {
    if (e instanceof TbError && e.code === "acting_unavailable") throw e;
    ctx.log.warn("acting ticket: the bridge did not issue one", { code: e instanceof TbError ? e.code : "unknown" });
    throw unavailable();
  }
}

/** Files minted tickets under their job (one per agent; a newer one replaces an older one) and drops the expired ones. */
export function store(db: Db, job: string, tickets: readonly string[], now: number): void {
  db.transaction(() => {
    db.prepare("DELETE FROM acting_tickets WHERE exp < ?").run(now);
    for (const t of tickets) {
      const p = parse(t);
      if (!p) continue;
      db.prepare("INSERT INTO acting_tickets (job, agent_id, ticket, minted_at, exp) VALUES (?, ?, ?, ?, ?) ON CONFLICT (job, agent_id) DO UPDATE SET ticket = excluded.ticket, minted_at = excluded.minted_at, exp = excluded.exp").run(job, p.agent, t, now, p.exp);
    }
  });
}

/** The tickets of a job that are not expired (oldest first, at most 4 agents), or null: nothing to send. */
export function envelopeFor(db: Db, job: string, now: number): ActingEnvelope | null {
  const rows = db.prepare("SELECT ticket FROM acting_tickets WHERE job = ? AND exp >= ? ORDER BY minted_at, agent_id LIMIT ?").all(job, now, MAX_ACTING_AGENTS);
  return rows.length === 0 ? null : { job, tickets: rows.map((r) => String(r.ticket)) };
}

/** True when the job has a ticket row, expired or not (an expired ticket must fail the run, not be left out). */
export function hasTickets(db: Db, job: string): boolean {
  return db.prepare("SELECT 1 AS x FROM acting_tickets WHERE job = ? LIMIT 1").get(job) !== undefined;
}

export function drop(db: Db, job: string): void {
  db.prepare("DELETE FROM acting_tickets WHERE job = ?").run(job);
}

/** The ticket of a job could not be used: the bridge refused it, or the cap is gone. The run stops; it never goes on unattributed. */
export function isTicketRefusal(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "acting_ticket_invalid" || code === "bridge_cap_missing";
}

type CallAppLike = (product: string, op: string, input: never, opts?: Record<string, unknown>) => Promise<never>;
/** The same callApp with the envelope of one job added to every call; the call's own options stay. */
export function withActing<F extends (...a: never[]) => unknown>(callApp: F, env: ActingEnvelope | null): F {
  if (!env) return callApp;
  const f = callApp as unknown as CallAppLike;
  return ((product: string, op: string, input: never, opts?: Record<string, unknown>) => f(product, op, input, { ...(opts ?? {}), acting: env })) as unknown as F;
}
