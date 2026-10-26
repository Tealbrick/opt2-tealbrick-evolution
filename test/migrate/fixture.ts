// Real-shaped 0.3.0 data for the move to the engine (C367 M3): a database at the 0.3.0 schema with its draft line (migrations
// 0001-0007: 0.3.0, run metrics R8, pipeline contract R10; no target_mode yet, so every schedule is Bound), seeded the way 0.3.0 wrote it, then upgraded to the current schema with the SDK's rule (one transaction
// per file). The rows below are what an owner who ran Bound agents for a few weeks has.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { migrationsDir } from "../../src/app.ts";
import * as r from "../../src/routines.ts";
import * as store from "../../src/store.ts";

export const files = readdirSync(migrationsDir)
  .filter((x) => x.endsWith(".sql"))
  .sort();
export const T = (s: string) => Date.parse(s);
export const D0 = T("2026-10-05T06:00:00Z");
export const BOUND_AGENT = "agt_01J0000000000000000000000B";
export const FREE_F = "agt_01J0000000000000000000000F";
export const FREE_G = "agt_01J0000000000000000000000G";

/** a Db like the SDK's: nested transactions are savepoints */
export function dbOf(raw: DatabaseSync): Db {
  let depth = 0;
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      const d = depth;
      raw.exec(d === 0 ? "BEGIN" : `SAVEPOINT sp${d}`);
      depth = d + 1;
      try {
        const v = fn();
        raw.exec(d === 0 ? "COMMIT" : `RELEASE sp${d}`);
        return v;
      } catch (e) {
        raw.exec(d === 0 ? "ROLLBACK" : `ROLLBACK TO sp${d}; RELEASE sp${d}`);
        throw e;
      } finally {
        depth = d;
      }
    },
  } as unknown as Db;
}

export interface Seeded {
  raw: DatabaseSync;
  db: Db;
  /** workflow ids */
  daily: string;
  loose: string;
  pinned: string;
  /** automation ids (all Bound, as every 0.3.0 schedule is) */
  dailyAut: string;
  pinnedAut: string;
  pausedAut: string;
}

function promote(db: Db, title: string, versions: { instruction: string; steps?: store.Draft["steps"]; trigger?: string }[]): string {
  const allowed = [{ product: "kanban", operations: ["issues_list"], crud: ["read" as const] }];
  let draftId = "";
  let workflowId = "";
  versions.forEach((v, i) => {
    const now = D0 + i * 3_600_000;
    const fields = { title, summary: `${title}, summary.`, instruction: v.instruction, trigger: v.trigger ?? "", steps: v.steps ?? [], allowed };
    if (i === 0) draftId = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: fields }, now).id;
    else store.updateDraft(db, draftId, store.getDraft(db, draftId).revision, { instruction: fields.instruction, steps: fields.steps }, now);
    workflowId = store.promote(db, draftId, store.getDraft(db, draftId).revision, now).workflow.id;
  });
  return workflowId;
}

/** 0.3.0 (migrations 0001-0007) with: a daily rollup (3 versions, a Bound schedule with run history), a workflow nobody
 *  scheduled, a workflow with a pinned Bound schedule, and a paused one. Not yet upgraded. */
export function seed030(): Seeded {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of files.filter((x) => x < "0008")) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  const db = dbOf(raw);
  const step = (id: string, title: string, instruction: string, ops: [string, string][]) => ({ id, title, instruction, ops: ops.map(([product, operation]) => ({ product, operation })) });
  const daily = promote(db, "Daily rollup", [
    { instruction: "Roll up yesterday's done issues.", trigger: "08:00", steps: [step("scan", "Scan", "Read the done issues.", [["kanban", "issues_list"]])] },
    { instruction: "Roll up yesterday's done issues and name the owner of each.", trigger: "08:00", steps: [step("scan", "Scan", "Read the done issues.", [["kanban", "issues_list"]]), step("write", "Write", "Write the roll-up.", [])] },
    { instruction: "Roll up yesterday's done issues, group by project.", trigger: "08:00", steps: [step("scan", "Scan", "Read the done issues.", [["kanban", "issues_list"]])] },
  ]);
  const loose = promote(db, "Triage inbox", [{ instruction: "Triage the inbox." }]);
  const pinned = promote(db, "Weekly report", [{ instruction: "Write the weekly report." }, { instruction: "Write the weekly report with numbers." }]);
  const paused = promote(db, "Monthly invoice check", [{ instruction: "Check the invoices." }]);
  const aut = (workflow: string, pin: number | null, cron: string, enabled: number, n: number): string => {
    const id = `aut_${ulid(D0 + n)}`;
    raw
      .prepare(
        "INSERT INTO automations (id, workflow_id, version_pin, policy_version, agent_id, cron, enabled, misfire_grace_sec, kanban_project, revision, next_due_at, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, 120, 'prj_shared', 1, ?, ?, ?)",
      )
      .run(id, workflow, pin, BOUND_AGENT, cron, enabled, T("2026-10-12T08:00:00Z"), D0 + n, D0 + n);
    return id;
  };
  const dailyAut = aut(daily, null, "0 8 * * *", 1, 1);
  const pinnedAut = aut(pinned, 1, "30 9 * * 1", 1, 2);
  const pausedAut = aut(paused, null, "0 6 1 * *", 0, 3);
  const ins = raw.prepare(
    "INSERT INTO routine_runs (occurrence, automation_id, revision, due_at, status, claimed_by, workflow_id, workflow_version, summary, kanban_issue_id, kanban_sync, claimed_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  ["completed", "completed", "failed", "uncertain", "missed", "completed"].forEach((status, i) => {
    const due = T("2026-10-01T08:00:00Z") + i * 86_400_000;
    ins.run(r.occurrenceOf(dailyAut, 1, due), dailyAut, due, status, status === "missed" ? null : BOUND_AGENT, daily, status === "missed" ? null : 2, `run ${status}`, status === "missed" ? null : `iss_${i}`, "none", due + 5000, due + 9000);
  });
  return { raw, db, daily, loose, pinned, dailyAut, pinnedAut, pausedAut };
}

/** applies the migrations after 0007 like the SDK does (one transaction per file) */
export function upgrade(raw: DatabaseSync): void {
  for (const f of files.filter((x) => x >= "0008")) {
    raw.exec("BEGIN");
    raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
    raw.exec("COMMIT");
  }
}

/** every table, row by row (for "nothing else changed") */
export function snapshot(raw: DatabaseSync, only?: string[]): Record<string, unknown[]> {
  const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((x) => x.name).filter((n) => !only || only.includes(n));
  return Object.fromEntries(names.map((name) => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
