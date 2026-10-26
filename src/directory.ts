// The agent directory of the workspace slice as Evolution last saw it (C364a R1a). The SDK gives an op handler only the
// caller's id and mode, not the slice, so Evolution keeps what the directory events say in `agent_names` (migration 0008):
// `agentAdded` (first sight), `agentsChanged` (the FULL list: add, re-add, rename, pause, resume; also once after boot with
// the first slice) and `agentRemoved`. Two decisions read it:
//   - a Free target must be listed, in mode free (`isFreeAgent`, at `automation_set`);
//   - a paused or removed agent is offered and given nothing (`isAvailable`, at `routines_due` and `routine_claim`), for
//     both modes. The SDK refuses such a caller centrally first (`agent_paused` / `agent_unknown`, trust.paused()); this
//     is the second layer, in the handler, for the case where the central answer is stale or bypassed.
import type { Db, SliceAgent } from "@opt2-tealbrick/miniapp-sdk";

export type DirectoryAgent = Pick<SliceAgent, "id" | "name" | "mode" | "status">;
export interface Listed {
  id: string;
  name: string;
  mode: "bound" | "free" | null;
  status: "active" | "paused" | null;
  inDirectory: boolean;
}

const UPSERT =
  "INSERT INTO agent_names (id, name, seen_at, mode, status, in_directory) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (id) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at, mode = excluded.mode, status = excluded.status, in_directory = 1";

/** `agentAdded`, and one entry of `agentsChanged`: the agent is listed, with its mode and status. */
export function recordAgent(db: Db, a: DirectoryAgent, now: number = Date.now()): void {
  db.prepare(UPSERT).run(a.id, a.name, now, a.mode, a.status);
}

/** `agentsChanged`: the slice's FULL agent list. Everything in it is recorded; an agent we know that is not in it is no
 *  longer in the directory. */
export function recordDirectory(db: Db, agents: readonly DirectoryAgent[], now: number = Date.now()): void {
  db.transaction(() => {
    for (const a of agents) recordAgent(db, a, now);
    const here = new Set<string>(agents.map((a) => a.id));
    for (const r of db.prepare("SELECT id FROM agent_names WHERE in_directory = 1").all()) if (!here.has(String(r.id))) markRemoved(db, String(r.id));
  });
}

/** `agentRemoved`. The name stays (suggestion text still names who repeated the work). */
export function markRemoved(db: Db, id: string): void {
  db.prepare("UPDATE agent_names SET in_directory = 0 WHERE id = ?").run(id);
}

export function lookup(db: Db, id: string): Listed | null {
  const r = db.prepare("SELECT id, name, mode, status, in_directory FROM agent_names WHERE id = ?").get(id);
  if (!r) return null;
  return {
    id: String(r.id),
    name: String(r.name),
    mode: r.mode === "bound" || r.mode === "free" ? r.mode : null,
    status: r.status === "active" || r.status === "paused" ? r.status : null,
    inDirectory: Number(r.in_directory) === 1,
  };
}

/** A Free target: listed, and in mode free. An agent Evolution has not seen (or sees as Bound, or does not know the mode
 *  of yet) is not one. A paused Free agent still is: the schedule waits until it is resumed. */
export function isFreeAgent(db: Db, id: string): boolean {
  const a = lookup(db, id);
  return a?.inDirectory === true && a.mode === "free";
}

/** False when the directory says the agent is paused or no longer listed. An agent that Evolution has no row for passes:
 *  the SDK admits only slice agents, and the first sight of one writes its row (events.agentAdded) before its first call
 *  reaches a handler. */
export function isAvailable(db: Db, id: string): boolean {
  const a = lookup(db, id);
  return a === null || (a.inDirectory && a.status !== "paused");
}
