-- 0.3.0 (C250 Release B, E1): stored evals of a workflow cycle (one cycle = one workflow version, from its promotion to
-- the next promotion of the same workflow). The ledger itself is computed on read from workflow_versions, drafts,
-- suggestions and routine_runs (no copy that can go stale); only an eval verdict at a point in time is stored here:
-- the closing eval of version n when version n+1 is promoted (trigger 'promotion', same transaction) and an eval the
-- owner stores with cycle_eval_run (trigger 'owner'). results = JSON [tealbrick.eval/1 result]. Forward only: a new
-- table and one new nullable column; no existing value changes.
CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY,               -- evr_<ulid>
  workflow_id TEXT NOT NULL REFERENCES workflows (id),
  version INTEGER NOT NULL,
  suite TEXT NOT NULL,               -- cycle:<workflow id>@v<version>
  tier TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail', 'insufficient')),
  results TEXT NOT NULL,             -- JSON [{app, version, suite, tier, metric, value, threshold, baseline, pass, ts}]
  app_version TEXT NOT NULL,
  "trigger" TEXT NOT NULL CHECK ("trigger" IN ('promotion', 'owner')),
  idempotency_key TEXT,              -- cycle_eval_run: the call's key, so a repeated owner call stores one eval only
  created_at INTEGER NOT NULL
);
CREATE INDEX eval_runs_by_cycle ON eval_runs (workflow_id, version, created_at DESC);
CREATE UNIQUE INDEX eval_runs_by_key ON eval_runs (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- When the runner's terminal report arrived (routine_report: completed / failed / uncertain); null for rows before 0.3.0
-- and for runs the sweep made uncertain. The ledger's duration is reported_at - claimed_at: updated_at also moves when
-- the run's Task Board issue is closed.
ALTER TABLE routine_runs ADD COLUMN reported_at INTEGER;
