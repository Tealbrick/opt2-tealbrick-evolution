// TEMP (C367 WP3): a local copy of the workflow contract types and `validateContract()` for the owner UI.
// WP2 owns the real ones in `src/engine/contract.ts` (ENGINE-WP-COMMON: `WorkflowContract`, `Step`, `validateContract()`).
// When WP2's PR lands, replace the body of this file with
//     export type { Stage, Step, StepKind, Trigger, WorkflowContract } from "../engine/contract.ts";
//     export { validateContract } from "../engine/contract.ts";
// (the real module must stay browser-safe: no node: imports) and keep the helpers below the marker. Nothing else changes.
// The checks here are the local, pure ones of ENGINE-BUILD §2 (shape, ids, refs, bounds). The checks that need the
// installed apps (an op's input schema, its audience, idempotency) are the server's: `workflow_contract_validate`.

export type StepKind = "app" | "ai" | "transform" | "approval" | "timer" | "condition" | "loop" | "parallel";
export const STEP_KINDS: readonly StepKind[] = ["app", "ai", "transform", "approval", "timer", "condition", "loop", "parallel"];
/** The canonical shape (ENGINE-BUILD): event → process → enrichment → concat → intelligence → result action. */
export const STAGES = ["event", "process", "enrichment", "concat", "intelligence", "result"] as const;
export type Stage = (typeof STAGES)[number];

interface StepBase {
  id: string;
  stage?: Stage;
  title?: string;
}
export interface AppStep extends StepBase {
  type: "app";
  product: string;
  op: string;
  input: Record<string, unknown>;
  retry?: { max?: number; backoffSec?: number };
  timeoutSec?: number;
  onFail?: "stop" | "continue" | "ask";
}
export interface AiStep extends StepBase {
  type: "ai";
  by: { role: string } | { agent: string };
  instruction: string;
  inputs: Record<string, string>;
  outputSchema: Record<string, unknown>;
  timeoutSec?: number;
  retry?: { max?: number };
  maxTokens?: number;
  temperature?: number;
}
export interface TransformStep extends StepBase {
  type: "transform";
  pick?: Record<string, string>;
  merge?: Record<string, string>;
  map?: { forEach: string; template: unknown };
  filter?: { forEach: string; expr: unknown };
  template?: string;
  normalise?: { path: string; ops: string[] };
  dedupe?: { forEach: string; key: string };
}
export interface ApprovalStep extends StepBase {
  type: "approval";
  title: string;
  context?: string;
  responses?: string[];
  timeoutSec?: number;
  onDeny?: "stop" | "continue";
}
export interface TimerStep extends StepBase {
  type: "timer";
  seconds?: number;
  until?: string;
}
export interface ConditionStep extends StepBase {
  type: "condition";
  if: unknown;
  then: Step[];
  else?: Step[];
}
export interface LoopStep extends StepBase {
  type: "loop";
  forEach: string;
  max: number;
  steps: Step[];
}
export interface ParallelStep extends StepBase {
  type: "parallel";
  branches: Record<string, Step[]>;
}
export type Step = AppStep | AiStep | TransformStep | ApprovalStep | TimerStep | ConditionStep | LoopStep | ParallelStep;

export type Trigger =
  | { kind: "schedule"; cron?: string; every?: string; timezone: string }
  | { kind: "manual"; inputs?: Record<string, unknown> }
  | { kind: "poll"; product: string; op: string; input: Record<string, unknown>; cursorPath: string; every: string }
  | { kind: "event"; product: string; type: string; filter?: Record<string, unknown> };

export interface WorkflowContract {
  format: "tealbrick.workflow/1";
  id: string;
  version: number;
  title: string;
  summary?: string;
  inputs?: Record<string, unknown>;
  triggers: Trigger[];
  steps: Step[];
  outputs?: Record<string, string>;
  metrics?: string[];
  limits?: { maxSteps?: number; maxRunMinutes?: number; maxModelTokens?: number };
}

export interface Issue {
  /** JSON pointer into the contract, "" = the contract itself */
  pointer: string;
  message: string;
}
export interface Validation {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

export const MAX_STEPS = 200;
export const MAX_PARALLEL = 8;
export const MAX_LOOP = 200;
const ID = /^[a-z][a-z0-9_]{0,39}$/;
const WORKFLOW_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PRODUCT = /^[a-z][a-z0-9-]{0,39}$/;
const OP = /^[a-z][a-z0-9_]{0,39}$/;
const AGENT = /^agt_[0-9A-Za-z]{10,40}$/;
const EVERY = /^[1-9][0-9]*[smhd]$/;
const CRON5 = /^\S+(\s+\S+){4}$/;

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Every `$steps.<id>` mentioned in a value (strings, nested in objects and arrays). */
export function stepRefs(v: unknown, into: string[] = []): string[] {
  if (typeof v === "string") for (const m of v.matchAll(/\$steps\.([a-z][a-z0-9_]*)/g)) into.push(m[1] as string);
  else if (Array.isArray(v)) for (const x of v) stepRefs(x, into);
  else if (isObj(v)) for (const x of Object.values(v)) stepRefs(x, into);
  return into;
}
/** Every `$input.<name>` mentioned in a value. */
export function inputRefs(v: unknown, into: string[] = []): string[] {
  if (typeof v === "string") for (const m of v.matchAll(/\$input\.([A-Za-z_][A-Za-z0-9_]*)/g)) into.push(m[1] as string);
  else if (Array.isArray(v)) for (const x of v) inputRefs(x, into);
  else if (isObj(v)) for (const x of Object.values(v)) inputRefs(x, into);
  return into;
}
const mentions = (v: unknown, needle: RegExp): boolean => (typeof v === "string" ? needle.test(v) : Array.isArray(v) ? v.some((x) => mentions(x, needle)) : isObj(v) ? Object.values(v).some((x) => mentions(x, needle)) : false);

/** Children of a container step, in document order. */
export function childrenOf(s: Step): { label: string; steps: Step[] }[] {
  switch (s.type) {
    case "condition":
      return [
        { label: "then", steps: Array.isArray(s.then) ? s.then : [] },
        { label: "else", steps: Array.isArray(s.else) ? s.else : [] },
      ];
    case "loop":
      return [{ label: "each", steps: Array.isArray(s.steps) ? s.steps : [] }];
    case "parallel":
      return isObj(s.branches) ? Object.entries(s.branches).map(([label, steps]) => ({ label, steps: Array.isArray(steps) ? steps : [] })) : [];
    default:
      return [];
  }
}

/** All steps, depth first, with the pointer of each. */
export function allSteps(steps: readonly Step[], pointer = "/steps"): { step: Step; pointer: string; depth: number }[] {
  const out: { step: Step; pointer: string; depth: number }[] = [];
  const go = (list: readonly Step[], ptr: string, depth: number) => {
    list.forEach((step, i) => {
      out.push({ step, pointer: `${ptr}/${i}`, depth });
      for (const c of childrenOf(step)) {
        const key = step.type === "condition" ? c.label : step.type === "loop" ? "steps" : `branches/${c.label}`;
        go(c.steps, `${ptr}/${i}/${key}`, depth + 1);
      }
    });
  };
  go(steps, pointer, 0);
  return out;
}

export function validateContract(c: unknown): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (pointer: string, message: string) => errors.push({ pointer, message });
  const warn = (pointer: string, message: string) => warnings.push({ pointer, message });
  if (!isObj(c)) return { ok: false, errors: [{ pointer: "", message: "The contract must be a JSON object." }], warnings };
  if (c.format !== "tealbrick.workflow/1") err("/format", 'format must be "tealbrick.workflow/1".');
  if (typeof c.id !== "string" || !WORKFLOW_ID.test(c.id)) err("/id", "id must be lower case letters, digits and hyphens, starting with a letter (at most 64).");
  if (!Number.isInteger(c.version) || (c.version as number) < 1) err("/version", "version must be a whole number from 1.");
  if (typeof c.title !== "string" || !c.title.trim()) err("/title", "title is required.");
  const inputs = isObj(c.inputs) ? c.inputs : null;
  const declared = new Set(isObj(inputs?.properties) ? Object.keys(inputs.properties as object) : []);
  if (c.inputs !== undefined && !inputs) err("/inputs", "inputs must be a JSON Schema object.");

  // triggers
  if (!Array.isArray(c.triggers) || c.triggers.length === 0) err("/triggers", "Add at least one trigger (schedule, manual, poll or event).");
  else
    c.triggers.forEach((t: unknown, i: number) => {
      const p = `/triggers/${i}`;
      if (!isObj(t)) {
        err(p, "A trigger must be an object.");
        return;
      }
      if (t.kind === "schedule") {
        const hasCron = typeof t.cron === "string" && t.cron.trim() !== "";
        const hasEvery = typeof t.every === "string" && t.every !== "";
        if (hasCron === hasEvery) err(p, "A schedule trigger has a cron or an every, not both and not neither.");
        if (hasCron && !CRON5.test((t.cron as string).trim())) err(`${p}/cron`, "cron needs 5 fields: minute hour day month weekday.");
        if (hasEvery && !EVERY.test(t.every as string)) err(`${p}/every`, 'every looks like "15m", "6h" or "1d".');
        if (typeof t.timezone !== "string" || !validTimeZone(t.timezone)) err(`${p}/timezone`, 'timezone must be an IANA name such as "Asia/Bangkok" or "UTC".');
      } else if (t.kind === "poll") {
        if (typeof t.product !== "string" || !PRODUCT.test(t.product)) err(`${p}/product`, "product is required.");
        if (typeof t.op !== "string" || !OP.test(t.op)) err(`${p}/op`, "op is required.");
        if (typeof t.cursorPath !== "string" || !t.cursorPath.startsWith("/")) err(`${p}/cursorPath`, 'cursorPath is a JSON pointer such as "/result/historyId".');
        if (typeof t.every !== "string" || !EVERY.test(t.every)) err(`${p}/every`, 'every looks like "5m".');
      } else if (t.kind === "event") {
        if (typeof t.product !== "string" || !PRODUCT.test(t.product)) err(`${p}/product`, "product is required.");
        if (typeof t.type !== "string" || !t.type) err(`${p}/type`, "type is required.");
        warn(p, "Event triggers need app event subscriptions (P2). Until then the engine runs the same steps from a poll trigger.");
      } else if (t.kind !== "manual") err(`${p}/kind`, "kind must be schedule, manual, poll or event.");
    });

  // steps
  const everywhere = new Set<string>(Array.isArray(c.steps) ? allSteps(c.steps.filter(isObj) as unknown as Step[]).map((x) => String(x.step.id)) : []);
  const all = new Set<string>();
  let count = 0;
  const limit = isObj(c.limits) && Number.isInteger(c.limits.maxSteps) ? Math.min(MAX_STEPS, c.limits.maxSteps as number) : MAX_STEPS;
  const refCheck = (value: unknown, pointer: string, visible: ReadonlySet<string>, ctx: { loop: boolean; item: boolean }) => {
    for (const id of stepRefs(value)) {
      if (!visible.has(id)) err(pointer, everywhere.has(id) ? `$steps.${id} is used before it has run (or in a branch that does not lead here).` : `$steps.${id} refers to a step that does not exist.`);
    }
    if (declared.size)
      for (const n of inputRefs(value))
        if (!declared.has(n)) err(pointer, `$input.${n} is not declared in inputs.properties.`);
    if (!ctx.loop && mentions(value, /\$loop\.item/)) err(pointer, "$loop.item can only be used inside a loop.");
    if (!ctx.loop && !ctx.item && mentions(value, /\$item\b/)) err(pointer, "$item can only be used in a map, filter or loop.");
  };
  const checkList = (list: unknown, ptr: string, visible: Set<string>, ctx: { loop: boolean; item: boolean }) => {
    if (!Array.isArray(list)) return err(ptr, "steps must be a list.");
    list.forEach((raw: unknown, i: number) => {
      const p = `${ptr}/${i}`;
      if (!isObj(raw)) {
        err(p, "A step must be an object.");
        return;
      }
      const s = raw as Record<string, unknown>;
      count++;
      if (typeof s.id !== "string" || !ID.test(s.id)) err(`${p}/id`, "id must be lower case letters, digits and underscores, starting with a letter (at most 40).");
      else if (all.has(s.id)) err(`${p}/id`, `The id "${s.id}" is used twice.`);
      else all.add(s.id);
      if (s.stage !== undefined && !(STAGES as readonly unknown[]).includes(s.stage)) err(`${p}/stage`, `stage must be one of ${STAGES.join(", ")}.`);
      switch (s.type) {
        case "app": {
          if (typeof s.product !== "string" || !PRODUCT.test(s.product)) err(`${p}/product`, "product is required (for example connect).");
          if (typeof s.op !== "string" || !OP.test(s.op)) err(`${p}/op`, "op is required (for example tools).");
          if (!isObj(s.input)) err(`${p}/input`, "input must be an object.");
          else refCheck(s.input, `${p}/input`, visible, ctx);
          if (s.onFail !== undefined && !["stop", "continue", "ask"].includes(s.onFail as string)) err(`${p}/onFail`, "onFail must be stop, continue or ask.");
          if (isObj(s.retry) && s.retry.max !== undefined && (!Number.isInteger(s.retry.max) || (s.retry.max as number) < 0 || (s.retry.max as number) > 10)) err(`${p}/retry/max`, "retry.max must be 0 to 10.");
          if (s.timeoutSec !== undefined && (!Number.isInteger(s.timeoutSec) || (s.timeoutSec as number) < 1 || (s.timeoutSec as number) > 86_400)) err(`${p}/timeoutSec`, "timeoutSec must be 1 to 86400.");
          break;
        }
        case "ai": {
          const by = isObj(s.by) ? s.by : {};
          const role = typeof by.role === "string" && by.role !== "";
          const agent = typeof by.agent === "string" && by.agent !== "";
          if (role === agent) err(`${p}/by`, "An ai step is done by a model role (by.role) or by an agent card (by.agent), not both and not neither.");
          if (agent && !AGENT.test(by.agent as string)) err(`${p}/by/agent`, "by.agent must be an agent id (agt_…).");
          if (typeof s.instruction !== "string" || !s.instruction.trim()) err(`${p}/instruction`, "instruction is required.");
          else refCheck(s.instruction, `${p}/instruction`, visible, ctx);
          if (s.inputs !== undefined && !isObj(s.inputs)) err(`${p}/inputs`, "inputs must map a name to a ref.");
          else refCheck(s.inputs, `${p}/inputs`, visible, ctx);
          if (!isObj(s.outputSchema)) err(`${p}/outputSchema`, "outputSchema is required: an ai step produces typed content.");
          else if (s.outputSchema.type !== "object") err(`${p}/outputSchema/type`, 'outputSchema must have "type": "object".');
          if (role && s.maxTokens !== undefined && (!Number.isInteger(s.maxTokens) || (s.maxTokens as number) < 1 || (s.maxTokens as number) > 4000)) err(`${p}/maxTokens`, "maxTokens must be 1 to 4000.");
          if (role && s.temperature !== undefined && s.temperature !== 0) warn(`${p}/temperature`, "A model role step runs at temperature 0; this value is ignored.");
          if (agent) warn(`${p}/by`, "An agent step runs with the agent's own access. It must return content only; the engine runs every action itself.");
          break;
        }
        case "transform": {
          const ops = ["pick", "merge", "map", "filter", "template", "normalise", "dedupe"].filter((k) => s[k] !== undefined);
          if (ops.length !== 1) err(p, `A transform step has exactly one operation (pick, merge, map, filter, template, normalise or dedupe); this one has ${ops.length}.`);
          const itemCtx = { ...ctx, item: true };
          for (const k of ops) refCheck(s[k], `${p}/${k}`, visible, k === "map" || k === "filter" || k === "dedupe" ? itemCtx : ctx);
          if ((s.pick !== undefined && !isObj(s.pick)) || (s.merge !== undefined && !isObj(s.merge))) err(p, "pick and merge map a name to a ref.");
          break;
        }
        case "approval": {
          if (typeof s.title !== "string" || !s.title.trim()) err(`${p}/title`, "title is required: it is the question the owner sees in Inbox.");
          else refCheck(s.title, `${p}/title`, visible, ctx);
          refCheck(s.context, `${p}/context`, visible, ctx);
          if (s.onDeny !== undefined && !["stop", "continue"].includes(s.onDeny as string)) err(`${p}/onDeny`, "onDeny must be stop or continue.");
          if (s.timeoutSec !== undefined && (!Number.isInteger(s.timeoutSec) || (s.timeoutSec as number) < 1)) err(`${p}/timeoutSec`, "timeoutSec must be a whole number from 1.");
          break;
        }
        case "timer": {
          const hasSeconds = s.seconds !== undefined;
          const hasUntil = s.until !== undefined;
          if (hasSeconds === hasUntil) err(p, "A timer waits for seconds or until a ref, not both and not neither.");
          if (hasSeconds && (typeof s.seconds !== "number" || s.seconds <= 0)) err(`${p}/seconds`, "seconds must be a number above 0.");
          if (hasUntil) refCheck(s.until, `${p}/until`, visible, ctx);
          break;
        }
        case "condition": {
          if (s.if === undefined || s.if === null) err(`${p}/if`, "if is required.");
          else refCheck(s.if, `${p}/if`, visible, ctx);
          checkList(s.then ?? [], `${p}/then`, new Set(visible), ctx);
          if (s.else !== undefined) checkList(s.else, `${p}/else`, new Set(visible), ctx);
          for (const sub of [s.then, s.else]) if (Array.isArray(sub)) for (const x of allSteps(sub as Step[])) visible.add(x.step.id);
          break;
        }
        case "loop": {
          if (typeof s.forEach !== "string" || !s.forEach.startsWith("$")) err(`${p}/forEach`, "forEach must be a ref to a list.");
          else refCheck(s.forEach, `${p}/forEach`, visible, ctx);
          if (!Number.isInteger(s.max) || (s.max as number) < 1 || (s.max as number) > MAX_LOOP) err(`${p}/max`, `A loop must have a bound: max is 1 to ${MAX_LOOP}.`);
          checkList(s.steps ?? [], `${p}/steps`, new Set(visible), { ...ctx, loop: true });
          if (Array.isArray(s.steps)) for (const x of allSteps(s.steps as Step[])) visible.add(x.step.id);
          break;
        }
        case "parallel": {
          const names = isObj(s.branches) ? Object.keys(s.branches) : [];
          if (names.length === 0) err(`${p}/branches`, "Add at least one branch.");
          if (names.length > MAX_PARALLEL) err(`${p}/branches`, `At most ${MAX_PARALLEL} branches.`);
          for (const name of names) checkList((s.branches as Record<string, unknown>)[name], `${p}/branches/${name}`, new Set(visible), ctx);
          for (const name of names) {
            const branch = (s.branches as Record<string, unknown>)[name];
            if (Array.isArray(branch)) for (const x of allSteps(branch as Step[])) visible.add(x.step.id);
          }
          break;
        }
        default:
          err(`${p}/type`, `type must be one of ${STEP_KINDS.join(", ")}.`);
      }
      if (typeof s.id === "string") visible.add(s.id);
    });
  };
  const visible = new Set<string>();
  if (!Array.isArray(c.steps)) err("/steps", "steps must be a list.");
  else {
    checkList(c.steps, "/steps", visible, { loop: false, item: false });
    if (c.steps.length === 0) warn("/steps", "This workflow has no steps yet.");
  }
  if (count > limit) err("/steps", `At most ${limit} steps (this has ${count}).`);
  if (c.outputs !== undefined) {
    if (!isObj(c.outputs)) err("/outputs", "outputs must map a name to a ref.");
    else
      for (const [k, v] of Object.entries(c.outputs)) {
        if (typeof v !== "string") err(`/outputs/${k}`, "An output is a ref string.");
        else for (const id of stepRefs(v)) if (!all.has(id)) err(`/outputs/${k}`, `$steps.${id} refers to a step that does not exist.`);
      }
  }
  if (c.metrics !== undefined && (!Array.isArray(c.metrics) || c.metrics.length > 20 || c.metrics.some((m: unknown) => typeof m !== "string" || !/^[a-z][a-z0-9_]{1,40}$/.test(m)))) err("/metrics", "metrics: at most 20 names (lower case letters, digits, underscore).");
  return { ok: errors.length === 0, errors, warnings };
}

// ── helpers of the owner UI (not part of WP2's module; keep when swapping the body above) ──

/** Where a step sits in the canonical shape when it has no `stage` label: by its kind. Flow-control kinds have no lane. */
export function defaultStage(s: Step): Stage | null {
  switch (s.type) {
    case "transform":
      return "process";
    case "app":
      return "enrichment";
    case "ai":
      return "intelligence";
    default:
      return null;
  }
}

export interface Placed {
  step: Step;
  pointer: string;
  /** the lane: the step's own label, else the label of the container it is in, else the default of its kind */
  stage: Stage | null;
  inferred: boolean;
  /** "gate › then" and so on: the containers the step is in */
  within: string[];
}

/** Steps placed into the lanes of the canonical shape (containers inherit nothing; their children take the container's label). */
export function placeSteps(steps: readonly Step[]): Placed[] {
  const out: Placed[] = [];
  const go = (list: readonly Step[], ptr: string, parent: Stage | null, within: string[]) => {
    list.forEach((step, i) => {
      const pointer = `${ptr}/${i}`;
      const own = step.stage && (STAGES as readonly string[]).includes(step.stage) ? step.stage : null;
      const stage = own ?? parent ?? defaultStage(step);
      out.push({ step, pointer, stage, inferred: own === null, within });
      for (const c of childrenOf(step)) {
        const key = step.type === "condition" ? c.label : step.type === "loop" ? "steps" : `branches/${c.label}`;
        go(c.steps, `${pointer}/${key}`, own ?? parent, [...within, `${step.id} › ${c.label}`]);
      }
    });
  };
  go(steps, "/steps", null, []);
  return out;
}

/** The ops, in document order and without repeats, that an engine run of this contract calls (the activation review).
 *  A Connect-style dynamic call (`op: "tools"` with `input.tool`) is listed per tool name. */
export function appOps(c: Pick<WorkflowContract, "steps" | "triggers">): { product: string; op: string; tool: string | null; via: string }[] {
  const seen = new Set<string>();
  const out: { product: string; op: string; tool: string | null; via: string }[] = [];
  const add = (product: unknown, op: unknown, input: unknown, via: string) => {
    if (typeof product !== "string" || typeof op !== "string") return;
    const tool = isObj(input) && typeof input.tool === "string" && input.tool && !input.tool.includes("{{") ? input.tool : null;
    const k = `${product}.${op}:${tool ?? ""}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ product, op, tool, via });
    }
  };
  for (const t of Array.isArray(c.triggers) ? c.triggers : []) if (t.kind === "poll") add(t.product, t.op, t.input, "poll trigger");
  for (const { step } of allSteps(Array.isArray(c.steps) ? c.steps : [])) if (step.type === "app") add(step.product, step.op, step.input, `step ${step.id}`);
  return out;
}

export function newContract(): WorkflowContract {
  return {
    format: "tealbrick.workflow/1",
    id: "new-workflow",
    version: 1,
    title: "New workflow",
    summary: "",
    triggers: [{ kind: "manual" }],
    steps: [],
    outputs: {},
    metrics: [],
  };
}
