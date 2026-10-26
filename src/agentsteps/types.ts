// Agent steps (C367 WP3, ENGINE-BUILD §5): shared types.
//
// The seam types are the engine's: `AgentStepOffer` and `AgentStepPort` are defined in src/engine/agent-port.ts (WP2, fixed
// interface). This runtime implements the port (`createAgentStepPort` in ./port.ts).
export type { AgentStepOffer, AgentStepPort } from "../engine/agent-port.ts";

export type StepStatus = "offered" | "claimed" | "completed" | "failed" | "timed_out" | "cancelled";
export const OPEN_STATUSES: ReadonlySet<StepStatus> = new Set<StepStatus>(["offered", "claimed"]);
export type TargetMode = "bound" | "free";

/** Temporal times an async activity out after this many missed heartbeats (`heartbeatTimeout` = 3 x heartbeatSec). A step with heartbeatSec 0 has no heartbeat clock. */
export const HEARTBEAT_MISSES = 3;

/** The one sentence every claim carries (ENGINE-BUILD §0 canonical shape: an agent step produces CONTENT ONLY). */
export const CONTENT_ONLY_NOTE = "Return the output only. Do not act.";

/** Why a claim, a heartbeat or a report is refused. */
export type StepRefusal = "not_found" | "mode_mismatch" | "agent_unavailable" | "already_claimed" | "not_claimed" | "finished" | "timed_out" | "cancelled";

/** The part of the Temporal client that agent steps use: `client.activity` (AsyncCompletionClient) satisfies it as it is.
 *  No @temporalio package is imported here: the engine (WP2) hands the real client in, tests hand in a fake. */
export interface ActivityCompletion {
  complete(taskToken: Uint8Array, result: unknown): Promise<void>;
  fail(taskToken: Uint8Array, error: Error): Promise<void>;
  heartbeat(taskToken: Uint8Array, details?: unknown): Promise<void>;
}

/** What the owner sees of one attempt's history. */
export interface StepEvent {
  attempt: number;
  kind: StepStatus;
  agentId: string;
  detail: string | null;
  at: string;
}

/** A step as the owner sees it (person op `agent_steps_list`). Never the inputs and never the output body. */
export interface StepView {
  stepRunId: string;
  workflowId: string;
  workflowTitle: string;
  version: number;
  runId: string;
  stepId: string;
  agentId: string;
  status: StepStatus;
  attempt: number;
  offeredAt: string;
  deadlineAt: string;
  claimedBy: string | null;
  claimedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  heartbeatSec: number;
  outputBytes: number | null;
  summary: string | null;
  metrics: Record<string, number> | null;
  invalidReports: number;
  events: StepEvent[];
}

/** An agent's claim answer (ENGINE-BUILD §5, plus the content-only mode and note). */
export interface ClaimedStep {
  stepRunId: string;
  workflowTitle: string;
  attempt: number;
  instruction: string;
  inputs: Record<string, unknown>;
  outputSchema: object;
  allowedHint: { product: string; operations: string[]; crud: ("create" | "read" | "update" | "delete")[] }[];
  deadline: string;
  heartbeatSec: number;
  mode: "content";
  note: typeof CONTENT_ONLY_NOTE;
}
