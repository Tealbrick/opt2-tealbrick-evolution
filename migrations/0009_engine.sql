-- TEMP PLACEHOLDER (C367 WP3). The SDK needs migrations gap-free from 0001, and WP2 owns 0009_engine.sql (engine_runs,
-- engine_steps). This empty file lets WP3's branch boot and pass CI without it. When WP2's PR is merged, TAKE WP2's
-- version of this file (the conflict is add/add on this one path); nothing of WP3 depends on its content.
SELECT 1;
