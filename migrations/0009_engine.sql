-- C367 WP2 (engine): contract versions, activations, Temporal schedules and the run index. Forward only: new tables, no
-- existing table, column or value changes, so 0.3.x data upgrades unchanged.
-- Temporal holds the truth about a run's progress; engine_runs / engine_steps are an INDEX of it (ids, status, timing,
-- attempts, held waits, sizes). They hold no body of another app's data (no inputs, no outputs); the owner reads those from
-- the Temporal history through the run detail. A reconcile job (boot + every 10 min) fixes the index from Temporal.

-- One immutable row per contract version (tealbrick.workflow/1). The workflow id is the contract id.
CREATE TABLE engine_definitions (
  workflow_id TEXT NOT NULL CHECK (length(workflow_id) BETWEEN 3 AND 40),
  version INTEGER NOT NULL CHECK (typeof(version) = 'integer' AND version >= 1),
  title TEXT NOT NULL,
  contract TEXT NOT NULL CHECK (json_valid(contract) AND json_type(contract) = 'object'),
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, version)
);

-- The owner's Activate click (C366): the list of operations (with crud, effect, scope type, tools) this version may call.
-- The engine refuses any other call (`not_in_workflow`). 'active' = new runs start on it; 'superseded' = a newer version
-- was activated (runs already started may finish); 'deactivated' = the engine refuses every call of it.
CREATE TABLE engine_activations (
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'deactivated')),
  uses TEXT NOT NULL CHECK (json_valid(uses) AND json_type(uses) = 'array'),
  activated_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (workflow_id, version),
  FOREIGN KEY (workflow_id, version) REFERENCES engine_definitions (workflow_id, version)
);
CREATE UNIQUE INDEX engine_activations_one_active ON engine_activations (workflow_id) WHERE state = 'active';

-- One row per Temporal Schedule (id evo-sched:<id>). `kind` poll = the run starts with a read and stops early when the cursor
-- did not change. The cursor is a short opaque marker (a history id), never a body.
CREATE TABLE engine_schedules (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version_pin INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('schedule', 'poll')),
  spec TEXT NOT NULL CHECK (json_valid(spec) AND json_type(spec) = 'object'),
  input TEXT NOT NULL CHECK (json_valid(input) AND json_type(input) = 'object'),
  poll TEXT CHECK (poll IS NULL OR (json_valid(poll) AND json_type(poll) = 'object')),
  overlap TEXT NOT NULL DEFAULT 'skip' CHECK (overlap IN ('skip', 'buffer_one')),
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  revision INTEGER NOT NULL,
  cursor TEXT,
  cursor_at INTEGER,
  temporal_state TEXT NOT NULL DEFAULT 'pending' CHECK (temporal_state IN ('pending', 'synced', 'missing', 'error')),
  temporal_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX engine_schedules_by_workflow ON engine_schedules (workflow_id, deleted_at);

-- The run index. (workflow_id, run_id) is the key; the Temporal workflow id is evo:<workflow_id>:<run_id> (or the schedule form).
CREATE TABLE engine_runs (
  workflow_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  version INTEGER,
  schedule_id TEXT,
  temporal_workflow_id TEXT NOT NULL,
  temporal_run_id TEXT,
  trigger_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'timed_out', 'terminated', 'skipped')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error_code TEXT,
  error_step TEXT,
  skipped_reason TEXT,
  steps_done INTEGER NOT NULL DEFAULT 0,
  steps_failed INTEGER NOT NULL DEFAULT 0,
  held_waits INTEGER NOT NULL DEFAULT 0,
  held_wait_ms INTEGER NOT NULL DEFAULT 0,
  model_tokens INTEGER NOT NULL DEFAULT 0,
  output_bytes INTEGER,
  source TEXT NOT NULL DEFAULT 'activity' CHECK (source IN ('activity', 'reconcile')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, run_id)
);
CREATE INDEX engine_runs_by_version ON engine_runs (workflow_id, version, started_at DESC);
CREATE INDEX engine_runs_by_status ON engine_runs (status, updated_at);
CREATE INDEX engine_runs_by_start ON engine_runs (started_at DESC);

-- One row per step execution: step_key = the step id, plus the loop path for a step inside a loop (`fetch#2.1`).
CREATE TABLE engine_steps (
  workflow_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  step_id TEXT NOT NULL,
  loop_path TEXT,
  kind TEXT NOT NULL,
  product TEXT,
  op TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped', 'waiting_hold', 'waiting_owner')),
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  hold_id TEXT,
  hold_started_at INTEGER,
  hold_ended_at INTEGER,
  hold_outcome TEXT,
  in_bytes INTEGER,
  out_bytes INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, run_id, step_key),
  FOREIGN KEY (workflow_id, run_id) REFERENCES engine_runs (workflow_id, run_id) ON DELETE CASCADE
);
CREATE INDEX engine_steps_by_step ON engine_steps (workflow_id, step_id, status);
