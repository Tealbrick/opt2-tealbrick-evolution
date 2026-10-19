// C250 (D2) upgrade check on REAL data: node scripts/upgrade-check.ts <0.2.12, 0.2.13, 0.3.0 or 0.3.0 + R8 app.db> --work <empty dir>
// Copies the database (VACUUM INTO from a read-only handle; the source is never written), checks that it is at app
// schema 3 (0.2.12), 4 (0.2.13), 5 (0.3.0) or 6 (0.3.0 + R8) with the released migration files, applies the pending app migrations the way the SDK does (one transaction
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
  console.error("usage: node scripts/upgrade-check.ts <app.db of 0.2.12, 0.2.13, 0.3.0 or 0.3.0 + R8> --work <empty dir>");
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
const from = applied.length;
assert.ok(from >= 3 && from <= 6, "the file is at app schema 3 (0.2.12), 4 (0.2.13), 5 (0.3.0) or 6 (0.3.0 + R8)");
assert.deepEqual(
  applied.map((a) => a.version),
  Array.from({ length: from }, (_, i) => i + 1),
  "applied app migrations are gap-free",
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
for (const name of before.keys()) assert.ok(after.has(name), `table ${name} is still there`);
const added = [...after.keys()].filter((k) => !before.has(k));
for (const name of added) assert.equal(after.get(name)?.length, 0, `new table ${name} starts empty`);
// columns a migration adds to an existing table (0005: routine_runs.reported_at) must be null on every old row; every
// other value must be unchanged (0006 only adds the table run_metrics: empty)
const addedColumns: string[] = [];
for (const [name, rows] of before) {
  const now = (after.get(name) ?? []) as Record<string, unknown>[];
  const was = rows as Record<string, unknown>[];
  const extra = now.length ? Object.keys(now[0] as object).filter((k) => !(was[0] && k in (was[0] as object))) : [];
  if (was.length) for (const k of extra) addedColumns.push(`${name}.${k}`);
  for (const r of now) for (const k of extra) assert.equal(r[k], null, `table ${name}: new column ${k} is null on old rows`);
  // node:sqlite rows have a null prototype: keep it, so only the values are compared
  const strip = now.map((r) => Object.assign(Object.create(null), Object.fromEntries(Object.entries(r).filter(([k]) => !extra.includes(k)))));
  assert.deepEqual(strip, was, `table ${name}: every row unchanged`);
}
assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "foreign keys");
assert.equal((db.prepare("PRAGMA integrity_check").get() as Record<string, string>).integrity_check, "ok", "integrity");
const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'routine_runs' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((x) => x.name);
assert.deepEqual(idx, ["routine_runs_by_automation", "routine_runs_open"], "routine_runs indexes");
db.close();

console.log(
  JSON.stringify(
    {
      check: `evolution upgrade from app schema ${from} to ${files.length}`,
      applied: pending.map((f) => f.file),
      addedTables: added,
      addedColumns,
      rows: Object.fromEntries([...before].map(([k, v]) => [k, v.length])),
      runStatuses: statusesBefore,
      result: "pass",
    },
    null,
    2,
  ),
);
