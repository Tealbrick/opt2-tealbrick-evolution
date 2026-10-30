-- C380 B7 dev.2: acting tickets (spec 0.1.88, BRIDGE section 8.7, bridge cap `acting_agents`).
-- A ticket is minted by the bridge while an AGENT's own call is open (routine_claim, step_claim) and proves, later and outside
-- that call, that durable work is done for that agent. Evolution sends it with the calls of the same job so that Rules can deny or
-- hold on the agent (acting facts only narrow; they never allow). One row per (job, agent). The tickets live here, in the app
-- database only: never in a Temporal payload, a log line or an answer (C371). Forward only, one new table, nothing else changes.
--   job   `rt.<occurrence>` for a routine run, `run.<workflowId>.<runId>` for an engine run (hashed when it is not a legal job id)
--   exp   the `exp` of the ticket in ms, read from its payload for housekeeping only; the bridge verifies the ticket, never this app
CREATE TABLE acting_tickets (
  job TEXT NOT NULL CHECK (length(job) BETWEEN 1 AND 128),
  agent_id TEXT NOT NULL,
  ticket TEXT NOT NULL,
  minted_at INTEGER NOT NULL,
  exp INTEGER NOT NULL,
  PRIMARY KEY (job, agent_id)
);
CREATE INDEX acting_tickets_by_exp ON acting_tickets (exp);

-- A child run (a `workflow` step) acts for the same agents as the run that started it, so all runs of one tree share the job of the
-- ROOT run (a ticket is bound to one job). This table says whose child a run is; the row goes when the child ends.
CREATE TABLE acting_links (
  workflow_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  parent_workflow_id TEXT NOT NULL,
  parent_run_id TEXT NOT NULL,
  PRIMARY KEY (workflow_id, run_id)
);
