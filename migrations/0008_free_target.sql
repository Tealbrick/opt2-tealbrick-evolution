-- C364a R1a (stacked on 0007): a schedule can target an existing FREE agent, which claims its runs with its own grant.
-- Forward only: ONE new column on automations and three on agent_names; no table is rebuilt and no existing value changes.
-- automations.target_mode: 'bound' (the schedule's agent is a Bound agent that holds the recipe; the 0.2.x / 0.3.0 meaning)
-- or 'free' (the agent keeps its own access; there is no applied recipe). Every existing row is 'bound'.
-- A caller claims a schedule only when (automations.agent_id = caller id AND automations.target_mode = caller mode).
ALTER TABLE automations ADD COLUMN target_mode TEXT NOT NULL DEFAULT 'bound' CHECK (target_mode IN ('bound', 'free'));

-- The agent directory of the slice (events.agentAdded / agentsChanged / agentRemoved) as Evolution last saw it: mode and
-- status of the agent, and whether it is still listed. Evolution reads it to accept a Free target (mode free) and to give
-- nothing to a paused or removed agent. Old rows (only id, name, seen_at) have no mode or status until the next
-- `agentsChanged` (the SDK sends it once after boot with the first slice): mode NULL is never a Free target, status NULL
-- and in_directory 1 do not stop an agent that the SDK itself admits.
ALTER TABLE agent_names ADD COLUMN mode TEXT CHECK (mode IS NULL OR mode IN ('bound', 'free'));
ALTER TABLE agent_names ADD COLUMN status TEXT CHECK (status IS NULL OR status IN ('active', 'paused'));
ALTER TABLE agent_names ADD COLUMN in_directory INTEGER NOT NULL DEFAULT 1 CHECK (in_directory IN (0, 1));
