-- C373 fix batch (F-R1, F-G5): forward only, two columns on engine_steps, nothing else changes.
-- error_message: a short reason the owner may read. Set only where the text is safe to keep: the bridge message of a `hook_denied`
--   refusal (cut to 200 characters; Rules writes it for the owner) and the reason code of a failed agent-step offer. Any other
--   failure keeps the code only (another app's text may hold its data).
-- rule_id: the Rules rule that denied the call (`rul_<ULID>`), parsed from the end of a `hook_denied` message.
ALTER TABLE engine_steps ADD COLUMN error_message TEXT;
ALTER TABLE engine_steps ADD COLUMN rule_id TEXT;
