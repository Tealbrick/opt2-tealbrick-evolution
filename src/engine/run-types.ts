// Types shared by the interpreter workflow (runs in the Temporal sandbox) and the activities (run in the app process).
// Types only: no runtime code, so the workflow bundle stays free of Node APIs.
import type { WorkflowContract } from "./contract.ts";
import type { Json, JsonObject } from "./json.ts";

export const TASK_QUEUE = "evolution";
export const NAMESPACE = "evolution";
export const WORKFLOW_TYPE = "evolutionRun";

export interface TriggerInfo {
  kind: "schedule" | "manual" | "poll" | "event";
  /** local date (YYYY-MM-DD) in `timezone` at the start of the run; filled by prepareRun */
  date?: string;
  /** ISO time of the start; filled by prepareRun */
  firedAt?: string;
  timezone?: string;
  /** the workflow input; `$input` reads it */
  input?: JsonObject;
  /** poll: the output of the poll op when the cursor changed */
  item?: Json;
  cursor?: string;
  previousCursor?: string;
  scheduleId?: string;
  event?: Json;
}

export interface RunInput {
  workflowId: string;
  /** null = the active (activated) version */
  version: number | null;
  /** "" for a scheduled start: the interpreter derives it from the Temporal workflow id */
  runId: string;
  trigger: TriggerInfo;
  /** sub-workflow depth (0 = top) */
  depth?: number;
  parent?: { workflowId: string; runId: string; stepId: string };
  /** continue-as-new state (internal) */
  resume?: ResumeState;
  /** test hook: iterations of a top-level loop per Temporal run before it continues as new (default 100) */
  canEvery?: number;
}

export interface ResumeState {
  steps: Record<string, { output: Json }>;
  topIndex: number;
  loop?: { stepId: string; nextIndex: number; results: Json[] };
  executed: number;
  startedAtMs: number;
  /** model tokens used so far in this run (limits.maxModelTokens) */
  tokens?: number;
}

export interface RunResult {
  status: "completed" | "skipped";
  workflowId: string;
  version: number;
  runId: string;
  outputs: Record<string, Json>;
  reason?: string;
}

export interface Prepared {
  version: number;
  contract: WorkflowContract;
  trigger: TriggerInfo;
  /** step ids whose op has no idempotency: never retried */
  noRetry: string[];
  startedAtMs: number;
}

export interface PrepareArgs {
  workflowId: string;
  version: number | null;
  runId: string;
  trigger: TriggerInfo;
  startedAtMs: number;
  temporalWorkflowId: string;
  temporalRunId: string;
  depth: number;
  parent?: RunInput["parent"];
  /** continue-as-new run: the row exists, only reload the definition */
  resumed: boolean;
}

export interface PollArgs {
  workflowId: string;
  runId: string;
  version: number;
  scheduleId: string | null;
}
export interface PollResult {
  changed: boolean;
  item?: Json;
  cursor?: string;
  previousCursor?: string;
}

export interface StepRef {
  workflowId: string;
  version: number;
  runId: string;
  stepId: string;
  /** step id plus the loop path (`fetch#2.1`) */
  stepKey: string;
  loopPath: number[];
}

export interface AppStepArgs extends StepRef {
  product: string;
  op: string;
  input: Json;
  maxAttempts: number;
  startedAtMs: number;
  /** the owner approved this hold: repeat the SAME call (same input, same key) once */
  afterHold?: string;
}
export type AppStepResult = { status: "ok"; output: Json } | { status: "held"; holdId: string; expiresAt: string };

export interface AiStepArgs extends StepRef {
  by: { role: string } | { agent: string };
  instruction: string;
  inputs: Json;
  outputSchema: Json;
  timeoutSec: number;
  /** agent steps: 0 or absent = no heartbeat timeout (only startToClose); `tealbrick agent serve` sends no heartbeat today */
  heartbeatSec?: number;
  maxTokens?: number;
  maxAttempts: number;
  startedAtMs: number;
}
export interface AiStepResult {
  output: Json;
  tokensIn?: number;
  tokensOut?: number;
}

/** Asks the owner in Inbox (`inbox_ask`, key wfrun:...). `purpose` approval = an approval step; on_fail = `onFail: "ask"`. */
export interface ApprovalAskArgs extends StepRef {
  title: string;
  context: string;
  timeoutSec: number;
  responses: ("approve" | "deny" | "clarify")[];
  purpose: "approval" | "on_fail";
  /** the n-th question for this step (on_fail: one per failure) */
  askNo: number;
  startedAtMs: number;
}
export interface ApprovalAskResult {
  itemId: string;
  expiresAt: string;
}
export interface ApprovalPollArgs extends StepRef {
  itemId: string;
  purpose: "approval" | "on_fail";
  /** the workflow saw the item expire locally: close the index row */
  closeAs?: "expired";
}
/** Only `answered` with response `approve` is an approval (Inbox rule). */
export interface ApprovalPollResult {
  status: "open" | "answered" | "expired" | "unknown";
  response: string | null;
  message: string | null;
}

export interface CheckActiveArgs {
  workflowId: string;
  version: number;
  /** a workflow step: the child must be active */
  child?: { workflowId: string; version: number | null };
}

export interface HoldCheckArgs extends StepRef {
  product: string;
  holdId: string;
}
/** pending = still waiting; approved / denied / expired = the owner (or the clock) decided; decided = the hold left the pending list
 *  (fallback without tb.hold_status: the outcome is not known, repeat the call once); gone = the engine cannot see the hold. */
export interface HoldCheckResult {
  state: "pending" | "approved" | "denied" | "expired" | "decided" | "gone";
  via: "hold_status" | "holds_pending";
}

export interface FinishArgs {
  workflowId: string;
  runId: string;
  status: "completed" | "failed" | "cancelled" | "skipped";
  endedAtMs: number;
  errorCode?: string;
  errorStep?: string;
  skippedReason?: string;
  outputBytes?: number;
}

export interface RecordStepArgs extends StepRef {
  kind: string;
  status: "running" | "completed" | "failed" | "skipped" | "waiting_hold" | "waiting_agent" | "waiting_owner";
  startedAtMs: number;
  endedAtMs?: number;
  /** hold wait ended: how */
  holdOutcome?: string;
  product?: string;
  op?: string;
  errorCode?: string;
  outBytes?: number;
}

export interface ValidateOutputArgs {
  schema: Json;
  value: Json;
}

/** Activities the interpreter calls (names are the Temporal activity types). */
export interface Activities {
  prepareRun(a: PrepareArgs): Promise<Prepared>;
  pollCheck(a: PollArgs): Promise<PollResult>;
  appStep(a: AppStepArgs): Promise<AppStepResult>;
  aiStep(a: AiStepArgs): Promise<AiStepResult>;
  approvalAsk(a: ApprovalAskArgs): Promise<ApprovalAskResult>;
  approvalPoll(a: ApprovalPollArgs): Promise<ApprovalPollResult>;
  holdCheck(a: HoldCheckArgs): Promise<HoldCheckResult>;
  checkActive(a: CheckActiveArgs): Promise<void>;
  finishRun(a: FinishArgs): Promise<void>;
}
export interface LocalActivities {
  recordStep(a: RecordStepArgs): Promise<void>;
  validateOutput(a: ValidateOutputArgs): Promise<{ ok: boolean; message?: string }>;
}

/** The hard ceiling Temporal enforces on a whole run (every continue-as-new run included): maxRunMinutes of working time plus 30 days
 *  for the owner's waits (holds, approvals), which do not count as working time. The interpreter enforces maxRunMinutes itself. */
export function executionCeilingMs(maxRunMinutes: number | undefined): number {
  return ((maxRunMinutes ?? 60) + 30 * 24 * 60) * 60_000;
}
