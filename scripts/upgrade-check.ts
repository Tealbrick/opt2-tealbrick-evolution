// C250 (D2) upgrade check on REAL data: node scripts/upgrade-check.ts <0.2.12 app.db> --work <empty dir>
// Copies the database (VACUUM INTO from a read-only handle; the source is never written), checks that it is at app
// schema 3 with the 0.2.12 migration files, applies the pending app migrations the way the SDK does (one transaction
// each, a tb_migrations row each), and compares every table row by row. It prints counts and check results only, never
// row contents (the file may hold workspace data). Exit 0 = all checks pass.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));
const args = process.argv.slice(2);
const source = args[0];
const work = args[args.indexOf("--work") + 1];
if (!source || args.indexOf("--work") < 1 || !work) {
  console.error("usage: node scripts/upgrade-check.ts <app.db of 0.2.12> --work <empty dir>");
  process.exit(2);
}
if (!existsSync(work) || readdirSync(work).length > 0) {
  console.error("--work must be an existing EMPTY directory");
  process.exit(2);
}

const copy = join(resolve(work), "app.db");
const src = new DatabaseSync(resolve(source), { readOnly: true });
src.prepare("VACUUM INTO ?").run(copy);
src.close();

const db = new DatabaseSync(copy);
db.exec("PRAGMA foreign_keys = ON");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, version: Number(f.slice(0, 4)), name: f.slice(5, -4), body: readFileSync(join(migrationsDir, f)) }));
const sum = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const applied = db.prepare("SELECT version, name, sha256 FROM tb_migrations WHERE scope = 'app' ORDER BY version").all() as { version: number; name: string; sha256: string }[];
assert.deepEqual(
  applied.map((a) => a.version),
  [1, 2, 3],
  "the file is at app schema 3 (0.2.12)",
);
for (const a of applied) assert.equal(a.sha256, sum((files[a.version - 1] as { body: Buffer }).body), `applied migration ${a.version} is unchanged`);

function tables(): Map<string, unknown[]> {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'tb_%' ORDER BY name").all() as { name: string }[];
  return new Map(names.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
}
const before = tables();
const statusesBefore = db.prepare("SELECT status, count(*) AS n FROM routine_runs GROUP BY status ORDER BY status").all();

const pending = files.slice(applied.length);
for (const f of pending) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(f.body.toString("utf8"));
    db.prepare("INSERT INTO tb_migrations (scope, version, name, sha256, applied_at) VALUES ('app', ?, ?, ?, ?)").run(f.version, f.name, sum(f.body), Date.now());
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const after = tables();
assert.deepEqual([...after.keys()], [...before.keys()], "same tables");
for (const [name, rows] of before) assert.deepEqual(after.get(name), rows, `table ${name}: every row unchanged`);
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "foreign keys");
assert.equal((db.prepare("PRAGMA integrity_check").get() as Record<string, string>).integrity_check, "ok", "integrity");
const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'routine_runs' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((x) => x.name);
assert.deepEqual(idx, ["routine_runs_by_automation", "routine_runs_open"], "routine_runs indexes");
db.close();

console.log(
  JSON.stringify(
    {
      check: "evolution upgrade 0.2.12 -> 0.2.13",
      applied: pending.map((f) => f.file),
      rows: Object.fromEntries([...before].map(([k, v]) => [k, v.length])),
      runStatuses: statusesBefore,
      result: "pass",
    },
    null,
    2,
  ),
);
