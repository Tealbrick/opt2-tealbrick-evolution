-- C367 WP2 M2 (security review of M1): forward only, two columns on engine_schedules, nothing else changes.
-- pending_cursor / pending_run_id (F7): a poll moves its cursor only when the run it started COMPLETED. The poll puts the new
--   cursor here with the run id; engine_runs finishing `completed` commits it, a failed run leaves `cursor` where it was, so the
--   next poll sees the same change again instead of losing it.
-- stale_reason (F6): an activation of a newer version re-checks the schedules that follow the active version; one that no
--   longer fits (its input, its trigger) is paused and carries the reason here until the owner edits it.
ALTER TABLE engine_schedules ADD COLUMN pending_cursor TEXT;
ALTER TABLE engine_schedules ADD COLUMN pending_run_id TEXT;
ALTER TABLE engine_schedules ADD COLUMN stale_reason TEXT;
