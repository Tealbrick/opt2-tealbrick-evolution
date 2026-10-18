// C250 (D2): migration 0004 rebuilds routine_runs to allow the `policy_stale` status. Upgrade test: a database at the
// 0.2.12 schema (migrations 0001-0003) with a run in every 0.2.12 status and every Kanban sync state, then 0004. Every
// row of every table must be byte-equal after it, the indexes and constraints must be back, and the 0.2.13 code must
// work on the result. `scripts/upgrade-check.ts` runs the same comparison on a COPY of a real 0.2.12 data file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Caller, Db } from "@opt2-tealbrick/miniapp-sdk";
import { migrationsDir } from "../src/app.ts";
import * as r from "../src/routines.ts";
import * as store from "../src/store.ts";
import { AGENT_A } from "./helpers.ts";

const BOUND: Caller = { ...AGENT_A, mode: "bound" };
const T = (s: string) => Date.parse(s);
const D0 = T("2026-10-12T06:00:00Z");

function dbAt(raw: DatabaseSync): Db {
  return {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN");
      try {
        const v = fn();
        raw.exec("COMMIT");
        return v;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as Db;
}

const files = readdirSync(migrationsDir)
  .filter((x) => x.endsWith(".sql"))
  .sort();

function tables(raw: DatabaseSync): Record<string, unknown[]> {
  const names = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return Object.fromEntries(names.map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}

/** 0.2.12 data: schema 0001-0003, one run per status and Kanban sync state, written with the run-row SQL of 0.2.12. */
function seed0212(raw: DatabaseSync): void {
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of files.filter((x) => x < "0004")) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  const db = dbAt(raw);
  const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "Rollup", summary: "", instruction: "Roll up.", trigger: "", steps: [], allowed: [{ product: "kanban", operations: ["issues_list"], crud: ["read"] }] } }, D0);
  const wf = store.promote(db, d.id, d.revision, D0).workflow.id;
  const a = r.setAutomation(db, { workflowId: wf, agentId: BOUND.id, cron: "0 8 * * *", kanbanProject: "prj_shared" }, D0);
  const ins = raw.prepare(
    "INSERT INTO routine_runs (occurrence, automation_id, revision, due_at, status, claimed_by, workflow_id, workflow_version, summary, kanban_issue_id, kanban_sync, claimed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const rows: [string, string | null, string | null, string][] = [
    ["claimed", BOUND.id, "iss_1", "none"],
    ["dispatched", BOUND.id, "iss_2", "none"],
    ["completed", BOUND.id, "iss_3", "done"],
    ["failed", BOUND.id, "iss_4", "pending"],
    ["uncertain", BOUND.id, null, "failed"],
    ["missed", null, null, "none"],
  ];
  rows.forEach(([status, by, issue, sync], i) => {
    const due = T("2026-10-01T08:00:00Z") + i * 86_400_000;
    ins.run(r.occurrenceOf(a.id, a.revision, due), a.id, a.revision, due, status, by, wf, status === "missed" ? null : 1, `run ${status} ✓ "quoted"`, issue, sync, by ? due + 5000 : null, due + 9000);
  });
}

test("0004 on 0.2.12 data: every row unchanged, indexes and constraints back, policy_stale now allowed", () => {
  const raw = new DatabaseSync(":memory:");
  seed0212(raw);
  const before = tables(raw);
  assert.equal((before.routine_runs as unknown[]).length, 6);
  assert.throws(() => raw.prepare("UPDATE routine_runs SET status = 'policy_stale' WHERE rowid = 1").run(), /CHECK constraint/, "0.2.12 refuses the new status");

  raw.exec("BEGIN");
  raw.exec(readFileSync(join(migrationsDir, "0004_policy_stale_runs.sql"), "utf8"));
  raw.exec("COMMIT");

  assert.deepEqual(tables(raw), before, "same tables, same rows, same order");
  const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'routine_runs' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((x) => x.name);
  assert.deepEqual(idx, ["routine_runs_by_automation", "routine_runs_open"]);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal((raw.prepare("PRAGMA integrity_check").get() as Record<string, string>).integrity_check, "ok");
  assert.equal((raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'routine_runs_0004'").get() as { n: number }).n, 0, "no temp table left");

  // constraints of the new table
  assert.throws(() => raw.prepare("UPDATE routine_runs SET status = 'bogus' WHERE rowid = 1").run(), /CHECK constraint/);
  assert.throws(() => raw.prepare("UPDATE routine_runs SET kanban_sync = 'bogus' WHERE rowid = 1").run(), /CHECK constraint/);
  assert.throws(() => raw.prepare("UPDATE routine_runs SET automation_id = 'aut_missing' WHERE rowid = 1").run(), /FOREIGN KEY/);
  const first = (before.routine_runs as { occurrence: string }[])[0]?.occurrence as string;
  assert.throws(
    () => raw.prepare("INSERT INTO routine_runs (occurrence, automation_id, revision, due_at, status, workflow_id, updated_at) SELECT occurrence, automation_id, revision, due_at, 'missed', workflow_id, 0 FROM routine_runs WHERE occurrence = ?").run(first),
    /UNIQUE|PRIMARY KEY/,
    "the occurrence is still the primary key (at-most-once)",
  );
});

test("the 0.2.13 code works on migrated 0.2.12 data", () => {
  const raw = new DatabaseSync(":memory:");
  seed0212(raw);
  raw.exec(readFileSync(join(migrationsDir, "0004_policy_stale_runs.sql"), "utf8"));
  const db = dbAt(raw);
  const now = T("2026-10-12T08:00:30Z");
  const runs = r.listRuns(db, { limit: 50 }, now);
  assert.deepEqual(runs.map((x) => x.status).sort(), ["completed", "failed", "missed", "uncertain", "uncertain", "uncertain"], "old claimed/dispatched runs read as uncertain, as in 0.2.12");
  assert.equal(r.pendingKanban(db).length, 1, "the failed run still waits for its Kanban close");
  const [a] = r.listAutomations(db, now, { kanbanLinked: true });
  assert.deepEqual(a?.warnings, [], "a schedule with a project and no wider version has no warning");
  const job = r.dueJobs(db, BOUND.id, now)[0];
  assert.equal(r.claim(db, BOUND, job?.occurrence as string, now).claimed, true, "the schedule runs on");
});

test("the migration files are gap-free and 0001-0003 are unchanged since 0.2.12 (the SDK refuses a changed file)", () => {
  assert.deepEqual(files, ["0001_init.sql", "0002_routines.sql", "0003_detector_state.sql", "0004_policy_stale_runs.sql"]);
  // sha256 of the files in tag v0.2.12 (the SDK stores these in tb_migrations and refuses a changed applied file)
  const V0212: Record<string, string> = {
    "0001_init.sql": "61853b592934920222d86bd1ec3d658822aa3307eec6d7faa2888f4a97615a68",
    "0002_routines.sql": "fb84ff74b28f2d82740b0a7065890faa8a181f07ac5f76cb330921784061f7da",
    "0003_detector_state.sql": "81cc359d49e0a1690a9e7adad321ba6a57882b667d558448219c91169cef98f7",
  };
  for (const [f, sum] of Object.entries(V0212)) assert.equal(createHash("sha256").update(readFileSync(join(migrationsDir, f))).digest("hex"), sum, f);
});
