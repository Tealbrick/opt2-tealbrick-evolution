// The engine's owner ops as the owner UI uses them (C367 M1): the real generated kit types (`person`, from the manifest),
// plus the view types the pages share. The ops belong to WP2 (src/engine/ops.ts); this file only names their shapes.
import type { PersonOps } from "#kit";
import { person } from "./ops.ts";

/** One call of an engine owner op. The same typed call as every person op. */
export const engine = person;

type Out<K extends keyof PersonOps> = PersonOps[K]["output"];

export type Crud = "create" | "read" | "update" | "delete";

/** One op a workflow version calls, as the installed manifest describes it (activation review): `usage` of `workflow_activate` / `workflow_contract_validate`. */
export type UsageRow = Out<"workflow_activate">["usage"][number];

export type ConnectAccess = Out<"connect_access">;
export type ValidateOut = Out<"workflow_contract_validate">;
export type ActivateOut = Out<"workflow_activate">;
export type SavedContract = Out<"workflow_contract_save">;
export type ContractVersion = Out<"workflow_contracts_list">["contracts"][number];
export type ContractGet = Out<"workflow_contract_get">;

/** A Temporal schedule of the engine (`schedules_list`, `schedule_set`, `schedule_pause`). */
export type EngineSchedule = Out<"schedules_list">["schedules"][number];

export type EngineRun = Out<"engine_runs_list">["runs"][number];
export type EngineRunStatus = EngineRun["status"];
export type EngineRunStep = Out<"engine_run_get">["steps"][number];
/** What the engine index stores for a step (the kit types it as a string; this is the documented set). */
export type EngineStepStatus = "running" | "completed" | "failed" | "skipped" | "waiting_hold" | "waiting_agent" | "waiting_owner";

/** Honest label of ENGINE-BUILD §4 (M1): shown wherever the ops of a workflow version are listed. */
export const GRANT_LABEL =
  "The bridge limits Evolving Workflows as a whole; each workflow's limit is enforced by the engine until per-workflow grants (P1). The engine refuses any call outside this list (not_in_workflow) before it reaches the app.";

/** The line for an agent step (ENGINE-BUILD §0, canonical shape). */
export const AGENT_STEP_LABEL =
  "An agent step only returns content. In this version the agent can still use its own access during its turn; the engine accepts only the typed output and runs every action itself.";
