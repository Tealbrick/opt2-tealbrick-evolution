// scripts/upgrade-check.ts on real-shaped 0.3.0 data files (C367 M3): the schema upgrade, then the move run twice, then the
// rollback check. Counts only are printed (never row contents).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { migrationsDir } from "../../src/app.ts";
import * as directory from "../../src/directory.ts";
import * as r from "../../src/routines.ts";
import { D0, dbOf, FREE_F, files, seed030 } from "./fixture.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));

/** the 0.3.0 + R8 + R10 fixture as a file, with the SDK's record of the applied migrations (like a copy of the real app.db) */
function dataFile(upTo: string, extra?: (s: ReturnType<typeof seed030>) => void): { file: string; work: string } {
  const dir = mkdtempSync(join(tmpdir(), "evolution-move-check-"));
  const s = seed030();
  if (extra) {
    for (const f of files.filter((x) => x >= "0008" && x <= upTo)) s.raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
    extra(s);
  }
  const file = join(dir, "app.db");
  s.raw.prepare("VACUUM INTO ?").run(file);
  s.raw.close();
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE tb_migrations (scope TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (scope, version))");
  const ins = raw.prepare("INSERT INTO tb_migrations (scope, version, name, sha256, applied_at) VALUES ('app', ?, ?, ?, 0)");
  for (const f of files.filter((x) => x <= upTo)) ins.run(Number(f.slice(0, 4)), f.slice(5, -4), createHash("sha256").update(readFileSync(join(migrationsDir, f))).digest("hex"));
  raw.close();
  const work = join(dir, "work");
  mkdirSync(work);
  return { file, work };
}
const check = (file: string, work: string) => spawnSync(process.execPath, [join(root, "scripts", "upgrade-check.ts"), file, "--work", work], { encoding: "utf8" });
type Out = { applied: string[]; move: Record<string, unknown>; result: string; addedTables: string[] };

test("0.3.0 data (every schedule Bound): the upgrade applies 0008-0011, the move keeps every schedule on routines_*, twice is the same", () => {
  const { file, work } = dataFile("0007_pipeline_contract.sql");
  const run = check(file, work);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const out = JSON.parse(run.stdout) as Out;
  assert.deepEqual(out.applied, files.filter((f) => f >= "0008"));
  assert.ok(out.addedTables.includes("migration_items") && out.addedTables.includes("migration_marker"));
  assert.deepEqual(out.move, { workflowsMigrated: 4, workflowsFailed: 0, schedulesMigrated: 0, schedulesLegacyBound: 3, schedulesSkipped: 0, schedulesFailed: 0, deferred: 0, secondRun: "no-op", rollback: "checked" });
  assert.equal(out.result, "pass");
  assert.doesNotMatch(run.stdout, /Daily rollup|Roll up/, "counts only, never row contents");
});

test("data with a Free schedule (+ R1a): the schedule moves and is paused, not deleted; the check verifies the rollback and the second run", () => {
  const { file, work } = dataFile("0008_free_target.sql", (s) => {
    directory.recordDirectory(s.db, [{ id: FREE_F as never, name: "Free agent", mode: "free", status: "active" }], D0);
    r.setAutomation(dbOf(s.raw), { workflowId: s.daily, agentId: FREE_F, targetMode: "free", cron: "0 7 * * *" }, D0);
  });
  const run = check(file, work);
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const out = JSON.parse(run.stdout) as Out;
  assert.equal(out.move.schedulesMigrated, 1);
  assert.equal(out.move.schedulesLegacyBound, 3);
  assert.equal(out.move.rollback, "checked");
});

test("fire: a file that is not at a released schema is refused before anything is moved", () => {
  const { file, work } = dataFile("0002_routines.sql");
  const run = check(file, work);
  assert.notEqual(run.status, 0);
});
