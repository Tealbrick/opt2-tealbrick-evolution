-- C288 R8 (after 0.3.0): run metrics reported by the runner with the terminal routine_report (completed / failed), the
-- RunReport of the Henry contracts (ok, minutes, retries, questions_to_martin, lessons). One row per run, written in
-- the same transaction as the status change; never changed afterwards. Forward only: ONE new table; no existing table,
-- column or value changes, so 0.3.0 data upgrades unchanged (routine_runs, rebuilt by 0004, is not touched).
-- The workflow and version of a metrics row are NOT copied: the run row (routine_runs.workflow_id, workflow_version)
-- is the truth, and the cycle ledger joins on it. lessons = JSON array of trimmed strings: free text written by an
-- agent (C88 / L12): read by person ops only (cycle_get), never returned by an agent op.
CREATE TABLE run_metrics (
  occurrence TEXT PRIMARY KEY REFERENCES routine_runs (occurrence),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  minutes REAL NOT NULL CHECK (minutes >= 0 AND minutes <= 10080),
  retries INTEGER CHECK (retries IS NULL OR (typeof(retries) = 'integer' AND retries >= 0 AND retries <= 1000)),
  questions_to_martin INTEGER CHECK (questions_to_martin IS NULL OR (typeof(questions_to_martin) = 'integer' AND questions_to_martin >= 0 AND questions_to_martin <= 1000)),
  lessons TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(lessons) AND json_type(lessons) = 'array' AND json_array_length(lessons) <= 20),
  created_at INTEGER NOT NULL
);
