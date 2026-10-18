-- 0.2.13 (C250, QA LOW B6): a due occurrence of a WIDER active version than the recipe the agent has is recorded as a
-- `policy_stale` run, so routines_due leaves it out and the owner sees it in runs_list. SQLite cannot change a CHECK
-- constraint, so the table is rebuilt with the same columns and rows. Forward only: a failed update is rolled back
-- with the SDK pre-update snapshot. No other table references routine_runs.
CREATE TABLE routine_runs_0004 (
  occurrence TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations (id),
  revision INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'dispatched', 'completed', 'failed', 'missed', 'uncertain', 'policy_stale')),
  claimed_by TEXT,
  workflow_id TEXT NOT NULL,
  workflow_version INTEGER,
  summary TEXT,
  kanban_issue_id TEXT,
  kanban_sync TEXT NOT NULL DEFAULT 'none' CHECK (kanban_sync IN ('none', 'pending', 'done', 'failed')),
  claimed_at INTEGER,
  updated_at INTEGER NOT NULL
);
INSERT INTO routine_runs_0004 (occurrence, automation_id, revision, due_at, status, claimed_by, workflow_id, workflow_version, summary, kanban_issue_id, kanban_sync, claimed_at, updated_at)
  SELECT occurrence, automation_id, revision, due_at, status, claimed_by, workflow_id, workflow_version, summary, kanban_issue_id, kanban_sync, claimed_at, updated_at FROM routine_runs;
DROP TABLE routine_runs;
ALTER TABLE routine_runs_0004 RENAME TO routine_runs;
CREATE INDEX routine_runs_by_automation ON routine_runs (automation_id, due_at DESC);
CREATE INDEX routine_runs_open ON routine_runs (status, updated_at);
