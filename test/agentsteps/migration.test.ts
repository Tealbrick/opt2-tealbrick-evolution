// 0010 (C367 WP3) on data of the release before it: every old row is unchanged, the two new tables are empty,
// and their constraints hold. Forward only: nothing existing is rebuilt.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { migrationsDir } from "../../src/app.ts";

const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const before = files.filter((f) => f < "0010");

function tableRows(raw: DatabaseSync): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) out[String(t.name)] = raw.prepare(`SELECT * FROM ${String(t.name)}`).all();
  return out;
}

test("0010 on 0.3.x data: every old row is unchanged, agent_step_runs and agent_step_events are new and empty", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of before) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  raw.prepare("INSERT INTO agent_names (id, name, seen_at, mode, status, in_directory) VALUES ('agt_1', 'Agent', 1, 'free', 'active', 1)").run();
  const old = tableRows(raw);
  raw.exec(readFileSync(join(migrationsDir, "0010_agent_steps.sql"), "utf8"));
  const now = tableRows(raw);
  for (const [t, rows] of Object.entries(old)) assert.deepEqual(now[t], rows, `${t} unchanged`);
  assert.deepEqual(now.agent_step_runs, []);
  assert.deepEqual(now.agent_step_events, []);
  assert.deepEqual(Object.keys(now).filter((t) => !(t in old)).sort(), ["agent_step_events", "agent_step_runs"]);
});

test("0010 constraints: status, target_mode and attempt are checked; an event needs its step", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const f of files) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  const insert = (id: string, status: string, mode: string, attempt: number) =>
    raw
      .prepare(
        "INSERT INTO agent_step_runs (step_run_id, workflow_id, version, run_id, step_id, agent_id, target_mode, status, attempt, instruction, output_schema_json, timeout_sec, heartbeat_sec, offered_at, deadline_at, updated_at) VALUES (?, 'wfl_1', 1, 'run_1', 's', 'agt_1', ?, ?, ?, 'i', '{}', 900, 60, 1, 2, 1)",
      )
      .run(id, mode, status, attempt);
  insert("ok", "offered", "free", 1); // quiet on good
  assert.throws(() => insert("a", "running", "free", 1), /CHECK/);
  assert.throws(() => insert("b", "offered", "both", 1), /CHECK/);
  assert.throws(() => insert("c", "offered", "free", 0), /CHECK/);
  assert.throws(() => insert("ok", "offered", "free", 1), /UNIQUE|PRIMARY/);
  const ev = raw.prepare("INSERT INTO agent_step_events (step_run_id, attempt, kind, agent_id, at) VALUES (?, 1, ?, 'agt_1', 1)");
  ev.run("ok", "claimed");
  assert.throws(() => ev.run("ok", "heartbeat"), /CHECK/);
  assert.throws(() => ev.run("missing", "claimed"), /FOREIGN KEY/);
});
