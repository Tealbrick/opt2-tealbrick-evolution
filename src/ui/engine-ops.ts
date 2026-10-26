// TEMP (C367 WP3): typed stubs of WP2's owner ops, matched by NAME to ENGINE-WP-COMMON:
//   workflow_contract_validate, workflow_activate, workflow_deactivate, schedule_set, schedule_pause, schedule_run_now,
//   schedule_delete, schedules_list, engine_runs_list, engine_run_get.
// The input and output SHAPES below are WP3's reading of ENGINE-BUILD §3-§7 (the common brief lists names only). WP2 adds the
// real manifest entries, so the generated kit (`#kit`, PersonOps) will carry the real types. When WP2's PR lands:
//   1. delete the `EngineOps` interface and `engine()` below;
//   2. make `engine` a re-export of `person` from ./ops.ts and let the type errors point at every shape that differs.
// Until then these ops are called by name through the same client call as every person op (`callOp`).
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import type { Issue } from "./engine-contract.ts";

export type Crud = "create" | "read" | "update" | "delete";

/** One op a workflow version calls, as the installed manifest describes it (activation review). */
export interface UsageRow {
  product: string;
  op: string;
  crud: Crud[];
  effect: "read" | "write" | "outward" | "money";
  /** the scope the call needs on the target app (a project, an area, an account), when the manifest declares one */
  scope: string | null;
  /** the target op is held by the app (holds apply to the call) */
  held: boolean;
}

export interface ValidateOut {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** ops, CRUD and scopes the version uses (ENGINE-BUILD §4) */
  usage: UsageRow[];
  /** the version the engine runs for this workflow now (null = none); with a contract in the input: null */
  activeVersion: number | null;
}

export interface EngineSchedule {
  id: string;
  workflowId: string;
  workflowTitle: string;
  /** pinned version, or null = the active one */
  version: number | null;
  /** exactly one of cron / everySec is set */
  cron: string | null;
  everySec: number | null;
  /** IANA name */
  timezone: string;
  overlap: "skip" | "buffer_one";
  paused: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: EngineRunStatus | null;
  revision: number;
}

export type EngineRunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled" | "timed_out";
export type EngineStepStatus = "pending" | "running" | "completed" | "failed" | "skipped" | "waiting_hold" | "waiting_agent" | "waiting_approval" | "sleeping";

export interface EngineRun {
  runId: string;
  workflowId: string;
  workflowTitle: string;
  version: number;
  status: EngineRunStatus;
  trigger: "schedule" | "manual" | "poll" | "event";
  scheduleId: string | null;
  startedAt: string;
  endedAt: string | null;
  stepsDone: number;
  stepsTotal: number | null;
  /** what the run waits for now, if anything */
  waiting: { kind: "hold" | "agent" | "approval" | "timer"; stepId: string } | null;
  error: string | null;
  modelTokens: number | null;
}

export interface EngineRunStep {
  stepId: string;
  /** "fetch", or "crm[2]" for a loop iteration */
  title: string | null;
  kind: "app" | "ai" | "transform" | "approval" | "timer" | "condition" | "loop" | "parallel";
  stage: string | null;
  status: EngineStepStatus;
  attempt: number;
  startedAt: string | null;
  endedAt: string | null;
  /** a held app call: the hold the owner decides on the Holds page */
  holdId: string | null;
  /** an agent step: the offer the agent works on (see agent_steps_list) */
  stepRunId: string | null;
  agentId: string | null;
  error: string | null;
  /** owner-only (C88): what the step got and gave. The index keeps sizes, not bodies, so these are absent unless Temporal history is read. */
  input?: unknown;
  output?: unknown;
}

export interface EngineOps {
  workflow_contract_validate: { input: { contract?: object; workflowId?: string; version?: number }; output: ValidateOut };
  workflow_activate: { input: { workflowId: string; version: number }; output: { workflowId: string; activeVersion: number; activatedAt: string } };
  workflow_deactivate: { input: { workflowId: string }; output: { workflowId: string; deactivatedAt: string } };
  schedules_list: { input: Record<string, never>; output: { schedules: EngineSchedule[] } };
  schedule_set: {
    input: { id?: string; revision?: number; workflowId: string; version?: number | null; cron?: string; everySec?: number; timezone: string; overlap?: "skip" | "buffer_one" };
    output: EngineSchedule;
  };
  schedule_pause: { input: { id: string; revision: number; paused: boolean }; output: EngineSchedule };
  schedule_run_now: { input: { id: string }; output: { runId: string } };
  schedule_delete: { input: { id: string; revision: number }; output: { id: string; deleted: true } };
  engine_runs_list: { input: { workflowId?: string; version?: number; scheduleId?: string; status?: EngineRunStatus; limit?: number }; output: { runs: EngineRun[] } };
  engine_run_get: { input: { runId: string }; output: { run: EngineRun; steps: EngineRunStep[] } };
}

export function engine<K extends keyof EngineOps>(op: K, input: EngineOps[K]["input"]): Promise<EngineOps[K]["output"]> {
  return callOp<EngineOps[K]["output"]>(op, input as never);
}

/** Honest label of ENGINE-BUILD §4 (M1): shown wherever the ops of a workflow version are listed. */
export const GRANT_LABEL =
  "The bridge limits Evolving Workflows as a whole; each workflow's limit is enforced by the engine until per-workflow grants (P1). The engine refuses any call outside this list (not_in_workflow) before it reaches the app.";

/** The line for an agent step (ENGINE-BUILD §0, canonical shape). */
export const AGENT_STEP_LABEL =
  "An agent step only returns content. In this version the agent can still use its own access during its turn; the engine accepts only the typed output and runs every action itself.";
