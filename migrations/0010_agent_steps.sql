-- C367 WP3 (engine line): agent steps. An `ai` step with `by: {agent}` is offered to ONE agent card, claimed at most once,
-- kept alive with heartbeats and answered with a typed output (ENGINE-BUILD §5). The Temporal activity completes
-- asynchronously; this table is the app-side mirror of that activity (Temporal wins, reconcile by `cancel` / the sweep).
-- Forward only: two new tables, no existing table changes. (0009 belongs to the engine run index.)
--
-- What is stored, and what is not (C88 / L12):
--   - the offer: ids, the rendered instruction, the typed inputs and the output schema. The inputs can hold data that other
--     apps returned to earlier steps; they are kept ONLY while the step is open (offered or claimed), because step_claim
--     must serve them. They are set to NULL, with the task token, when the step ends in any way.
--   - the answer: its size and its sha256, never the body. The typed output goes to Temporal (activity completion) and
--     lives in the run history there.
--   - the agent's one-line summary and its numbers (metrics), for the owner's step timeline.
CREATE TABLE agent_step_runs (
  step_run_id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  -- R1a: a caller gets and claims a step only when (agent_id = caller id AND target_mode = caller mode). The engine offers
  -- to Free agents (they act with their own grant); 'bound' is allowed by the table and unused by the engine.
  target_mode TEXT NOT NULL DEFAULT 'free' CHECK (target_mode IN ('bound', 'free')),
  status TEXT NOT NULL CHECK (status IN ('offered', 'claimed', 'completed', 'failed', 'timed_out', 'cancelled')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  instruction TEXT NOT NULL,
  inputs_json TEXT,                   -- NULL once the step has ended
  output_schema_json TEXT NOT NULL,
  timeout_sec INTEGER NOT NULL,       -- Temporal startToClose
  heartbeat_sec INTEGER NOT NULL,     -- Temporal heartbeatTimeout = 3 x this
  task_token TEXT,                    -- base64 of the Temporal activity task token; NULL once the step has ended
  offered_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,       -- offered_at + timeout_sec
  claimed_by TEXT,
  claimed_at INTEGER,
  heartbeat_at INTEGER,
  finished_at INTEGER,
  output_bytes INTEGER,
  output_sha256 TEXT,
  summary TEXT,                       -- the agent's own line (<= 500), owner-only
  metrics_json TEXT,                  -- the agent's own numbers {name: number}, owner-only
  invalid_reports INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX agent_step_runs_due ON agent_step_runs (agent_id, target_mode, status, offered_at);
CREATE INDEX agent_step_runs_by_run ON agent_step_runs (run_id, offered_at);
CREATE INDEX agent_step_runs_by_workflow ON agent_step_runs (workflow_id, version, offered_at);
CREATE INDEX agent_step_runs_open ON agent_step_runs (status, deadline_at);

-- What happened to a step, per attempt: offered, claimed, completed, failed, timed_out, cancelled. No heartbeats (volume).
CREATE TABLE agent_step_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step_run_id TEXT NOT NULL REFERENCES agent_step_runs (step_run_id),
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('offered', 'claimed', 'completed', 'failed', 'timed_out', 'cancelled')),
  agent_id TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX agent_step_events_by_step ON agent_step_events (step_run_id, id);
