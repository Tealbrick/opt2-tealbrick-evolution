-- C367 M3: the one-time move of 0.3.x agent workflows to the engine (src/migrate/). Forward only: two new tables.
-- migration_items: one row per 0.3.x workflow and per 0.3.x schedule the move looked at, with what became of it. The legacy
-- rows (workflows, workflow_versions, automations, routine_runs) are never changed or deleted by the move, except that a
-- schedule that moved is PAUSED (never deleted), so a rollback is: delete or pause the engine schedule, resume the old one.
-- migration_marker: the row that says the move has been done (it is run again at every start and changes nothing then).
CREATE TABLE migration_items (
  kind TEXT NOT NULL CHECK (kind IN ('workflow', 'schedule')),
  legacy_id TEXT NOT NULL,
  -- the engine workflow id (kind workflow) or the engine schedule id (kind schedule); NULL when nothing was made
  engine_id TEXT,
  -- migrated: moved. legacy_bound: a Bound target, stays on routines_*. skipped: left on routines_*, see reason.
  -- failed: could not be moved, see reason, nothing was changed. deferred: waits for the engine (Temporal is off).
  status TEXT NOT NULL CHECK (status IN ('migrated', 'legacy_bound', 'skipped', 'failed', 'deferred')),
  reason TEXT,
  -- workflows: how many versions became contract versions
  versions INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, legacy_id)
);
CREATE INDEX migration_items_by_engine ON migration_items (kind, engine_id);

CREATE TABLE migration_marker (
  name TEXT PRIMARY KEY,
  done_at INTEGER NOT NULL,
  summary TEXT NOT NULL CHECK (json_valid(summary))
);
