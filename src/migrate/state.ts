// What the 0.3.x -> engine move did (migration_items, migration_marker). Read by the owner op `migration_status`, by the
// schedule warnings and by the legacy claim; written only by ./run.ts.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";

export const MARKER = "m3_from_0_3";

export type ItemKind = "workflow" | "schedule";
export type ItemStatus = "migrated" | "legacy_bound" | "skipped" | "failed" | "deferred";
export interface Item {
  kind: ItemKind;
  legacyId: string;
  engineId: string | null;
  status: ItemStatus;
  reason: string | null;
  versions: number | null;
}

const toItem = (r: Record<string, unknown>): Item => ({
  kind: r.kind as ItemKind,
  legacyId: String(r.legacy_id),
  engineId: r.engine_id === null ? null : String(r.engine_id),
  status: r.status as ItemStatus,
  reason: r.reason === null ? null : String(r.reason),
  versions: r.versions === null ? null : Number(r.versions),
});

/** The schedule code reads this on every list and claim. A database that predates migration 0011 has no such table: nothing moved. */
const noTable = (e: unknown): boolean => e instanceof Error && /no such table/.test(e.message);

export function getItem(db: Db, kind: ItemKind, legacyId: string): Item | null {
  try {
    const r = db.prepare("SELECT * FROM migration_items WHERE kind = ? AND legacy_id = ?").get(kind, legacyId);
    return r ? toItem(r) : null;
  } catch (e) {
    if (noTable(e)) return null;
    throw e;
  }
}

export function listItems(db: Db): Item[] {
  return db.prepare("SELECT * FROM migration_items ORDER BY kind DESC, legacy_id").all().map(toItem);
}

export function putItem(db: Db, i: Item, now: number): void {
  db.prepare(
    "INSERT INTO migration_items (kind, legacy_id, engine_id, status, reason, versions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, legacy_id) DO UPDATE SET engine_id = excluded.engine_id, status = excluded.status, reason = excluded.reason, versions = excluded.versions, updated_at = excluded.updated_at",
  ).run(i.kind, i.legacyId, i.engineId, i.status, i.reason, i.versions, now);
}

export interface Counts {
  workflowsMigrated: number;
  workflowsFailed: number;
  schedulesMigrated: number;
  schedulesLegacyBound: number;
  schedulesSkipped: number;
  schedulesFailed: number;
  deferred: number;
}

export function countsOf(items: readonly Item[]): Counts {
  const n = (kind: ItemKind, status: ItemStatus) => items.filter((i) => i.kind === kind && i.status === status).length;
  return {
    workflowsMigrated: n("workflow", "migrated"),
    workflowsFailed: n("workflow", "failed"),
    schedulesMigrated: n("schedule", "migrated"),
    schedulesLegacyBound: n("schedule", "legacy_bound"),
    schedulesSkipped: n("schedule", "skipped"),
    schedulesFailed: n("schedule", "failed"),
    deferred: items.filter((i) => i.status === "deferred").length,
  };
}

export function marker(db: Db): { doneAt: number; counts: Counts } | null {
  const r = db.prepare("SELECT done_at, summary FROM migration_marker WHERE name = ?").get(MARKER);
  return r ? { doneAt: Number(r.done_at), counts: JSON.parse(String(r.summary)) as Counts } : null;
}

export function writeMarker(db: Db, counts: Counts, now: number): void {
  db.prepare("INSERT OR IGNORE INTO migration_marker (name, done_at, summary) VALUES (?, ?, ?)").run(MARKER, now, JSON.stringify(counts));
}

/** The engine schedule a legacy schedule moved to, or null (not moved, or never looked at). */
export function engineScheduleOf(db: Db, automationId: string): string | null {
  const i = getItem(db, "schedule", automationId);
  return i?.status === "migrated" ? i.engineId : null;
}
