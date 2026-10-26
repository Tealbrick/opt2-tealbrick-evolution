// The workflow contract `tealbrick.workflow/1` (ENGINE-BUILD §2, C367): types, JSON Schema and validateContract().
// WP3's UI imports `WorkflowContract`, `Step` and `validateContract` from here. Types only below: the interpreter imports them
// with `import type`, so nothing of the validator ends up in the Temporal workflow bundle.
import type { Json, JsonObject } from "./json.ts";
import type { NormaliseOp } from "./transform.ts";

export { CONTRACT_FORMAT, CONTRACT_SCHEMA, LIMITS, ON_FAIL, STAGES, STEP_TYPES } from "./contract-schema.ts";
export { type ValidateOptions, type ValidationIssue, type ValidationResult, validateContract } from "./validate.ts";

export type Stage = "process" | "enrichment" | "concat" | "intelligence" | "result";
export type OnFail = "stop" | "continue" | "ask";
export type JsonSchemaObject = { [k: string]: Json };
/** `$input.x`, `$steps.id.output.x`, `$trigger.x`, `$loop.item` */
export type RefString = string;
export interface RetryPolicy {
  /** attempts in total (1 = no retry) */
  max?: number;
  backoffSec?: number;
}

export type Trigger =
  | { kind: "schedule"; cron?: string; every?: string; timezone: string; input?: JsonObject }
  | { kind: "manual"; inputs?: JsonObject }
  | { kind: "poll"; product: string; op: string; input?: JsonObject; cursorPath: string; every: string }
  | { kind: "event"; product: string; type: string; filter?: JsonObject };

interface StepBase {
  id: string;
  stage?: Stage;
  title?: string;
}
export interface AppStep extends StepBase {
  type: "app";
  product: string;
  op: string;
  input?: JsonObject;
  retry?: RetryPolicy;
  timeoutSec?: number;
  onFail?: OnFail;
  /** for an op whose output the target manifest does not describe (a dynamic op): the author declares it */
  outputSchema?: JsonSchemaObject;
}
export interface AiStep extends StepBase {
  type: "ai";
  by: { role: string } | { agent: string };
  instruction: string;
  inputs?: Record<string, Json>;
  outputSchema: JsonSchemaObject;
  timeoutSec?: number;
  retry?: RetryPolicy;
  maxTokens?: number;
  onFail?: OnFail;
}
export interface ApprovalStep extends StepBase {
  type: "approval";
  title: string;
  context?: string;
  timeoutSec?: number;
  onDeny?: "stop" | "continue";
}
export interface TransformStep extends StepBase {
  type: "transform";
  pick?: JsonObject;
  merge?: Json[] | JsonObject;
  rename?: { from: RefString; map: Record<string, string> };
  concat?: { items: Json[]; separator?: string };
  template?: string;
  map?: { forEach: RefString; template: Json };
  filter?: { from: RefString; where: Json };
  dedupe?: { from: RefString; by?: string };
  sort?: { from: RefString; by?: string; order?: "asc" | "desc" };
  normalise?: { from: RefString; fields?: string[]; ops: NormaliseOp[] };
  /** declared output type; otherwise it is derived from the op */
  outputSchema?: JsonSchemaObject;
}
export interface TimerStep extends StepBase {
  type: "timer";
  seconds?: number;
  until?: RefString;
}
export interface ConditionStep extends StepBase {
  type: "condition";
  if: Json;
  then: Step[];
  else?: Step[];
}
export interface LoopStep extends StepBase {
  type: "loop";
  forEach: RefString;
  /** the bound: more items than this fail the step (never a silent cut) */
  max: number;
  steps: Step[];
  onFail?: OnFail;
}
export interface ParallelStep extends StepBase {
  type: "parallel";
  branches: Record<string, Step[]>;
}
export interface WorkflowStep extends StepBase {
  type: "workflow";
  workflow: string;
  version?: number;
  input?: JsonObject;
  onFail?: OnFail;
}
export type Step = AppStep | AiStep | ApprovalStep | TransformStep | TimerStep | ConditionStep | LoopStep | ParallelStep | WorkflowStep;
export type StepType = Step["type"];

export interface WorkflowContract {
  format: "tealbrick.workflow/1";
  id: string;
  version: number;
  title: string;
  summary?: string;
  /** JSON Schema (type object) */
  inputs?: JsonSchemaObject;
  triggers: Trigger[];
  steps: Step[];
  outputs?: Record<string, RefString>;
  metrics?: string[];
  limits?: { maxSteps?: number; maxRunMinutes?: number; maxModelTokens?: number };
}

/** Every step of a contract, depth first, with its parent chain (ids) and whether it sits inside a loop. */
export function walkSteps(steps: readonly Step[], visit: (s: Step, info: { path: string; depth: number; inLoop: boolean; topLevel: boolean }) => void, path = "/steps", depth = 0, inLoop = false): void {
  steps.forEach((s, i) => {
    const p = `${path}/${i}`;
    visit(s, { path: p, depth, inLoop, topLevel: depth === 0 });
    if (s.type === "condition") {
      walkSteps(s.then, visit, `${p}/then`, depth + 1, inLoop);
      if (s.else) walkSteps(s.else, visit, `${p}/else`, depth + 1, inLoop);
    } else if (s.type === "loop") walkSteps(s.steps, visit, `${p}/steps`, depth + 1, true);
    else if (s.type === "parallel") for (const [name, list] of Object.entries(s.branches)) walkSteps(list, visit, `${p}/branches/${name}`, depth + 1, inLoop);
  });
}
