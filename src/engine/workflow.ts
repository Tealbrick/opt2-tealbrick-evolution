// The interpreter workflow `evolutionRun` (ENGINE-BUILD §2, §3): ONE Temporal workflow type that runs any stored contract.
//
// Runs in the Temporal workflow sandbox: deterministic code only. It imports no Node API and no validator; refs, templates,
// conditions and `transform` steps come from the pure files expr.ts / transform.ts. Every effect is an activity.
// The definition is loaded by an activity (prepareRun) from app.db; it is never part of the start arguments or a Schedule.
//
// Replay safety (CI replays stored histories, test/engine/replay.test.ts): a change of behaviour must be wrapped in
// `patched(PATCH.<name>)`. The first patch id below guards the run-index writes; a later change adds a new id.
import {
  ActivityFailure,
  ApplicationFailure,
  CancellationScope,
  ChildWorkflowFailure,
  ContinueAsNew,
  continueAsNew,
  executeChild,
  isCancellation,
  patched,
  proxyActivities,
  proxyLocalActivities,
  sleep,
  TimeoutFailure,
  workflowInfo,
} from "@temporalio/workflow";
import type { AiStep, ApprovalStep, AppStep, ConditionStep, LoopStep, OnFail, ParallelStep, Step, TimerStep, TransformStep, WorkflowContract, WorkflowStep } from "./contract.ts";
import { ExprError, evalCondition, renderString, renderTree, type Scope } from "./expr.ts";
import type { Json } from "./json.ts";
import type { Activities, LocalActivities, Prepared, RecordStepArgs, ResumeState, RunInput, RunResult, StepRef, TriggerInfo } from "./run-types.ts";
import { runTransform, type TransformSpec } from "./transform.ts";

/** Patch ids. Never rename or reuse one: a stored history may carry the marker. */
export const PATCH = { index: "evo-index-1", childCheck: "evo-child-check-1" } as const;

const MAX_EXECUTIONS = 5000;
/** F2: a value the interpreter builds and hands to an activity (or carries over a continue-as-new) may not exceed this; Temporal's
 *  own limit is 2 MB per payload, and a bigger one would wedge the workflow task instead of failing the step. */
export const MAX_PAYLOAD_BYTES = 1_500_000;
const DEFAULT_CAN_EVERY = 100;

const base = proxyActivities<Activities>({ startToCloseTimeout: "2 minutes", retry: { maximumAttempts: 3, initialInterval: "2 seconds", backoffCoefficient: 2 } });
const local = proxyLocalActivities<LocalActivities>({ startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 2 } });

export class StepFailed extends Error {
  readonly code: string;
  readonly stepId: string | undefined;
  constructor(code: string, message: string, stepId?: string) {
    super(message);
    this.code = code;
    this.stepId = stepId;
  }
}

interface Rt {
  input: RunInput;
  workflowId: string;
  version: number;
  runId: string;
  contract: WorkflowContract;
  trigger: TriggerInfo;
  noRetry: ReadonlySet<string>;
  deadlineMs: number;
  startedAtMs: number;
  executed: number;
  /** model tokens used so far (limits.maxModelTokens) */
  tokens: number;
  canEvery: number;
  depth: number;
  /** step ids for which a failure is recorded as a held wait */
}

interface RtScope extends Scope {
  steps: Record<string, { output: unknown } | undefined>;
}

/** `evo:<workflowId>:<scheduleId>-<time>` (a Schedule start) gives the run id `<scheduleId>-<time>` without punctuation that a key dislikes. */
export function deriveRunId(temporalWorkflowId: string, workflowId: string): string {
  const prefix = `evo:${workflowId}:`;
  const tail = temporalWorkflowId.startsWith(prefix) ? temporalWorkflowId.slice(prefix.length) : temporalWorkflowId;
  return tail.replace(/[^A-Za-z0-9._@-]/g, "").slice(0, 60);
}

/** Throws input_too_large when a value is over MAX_PAYLOAD_BYTES (the step fails, the run does not wedge). */
export function assertPayloadSize(value: unknown, what: string, stepId: string): void {
  const bytes = JSON.stringify(value ?? null).length;
  if (bytes > MAX_PAYLOAD_BYTES) throw new StepFailed("input_too_large", `${what} is ${bytes} bytes; the engine passes ${MAX_PAYLOAD_BYTES} at most.`, stepId);
}

/** FNV-1a, 32 bit: a short deterministic hash (pure; the workflow sandbox has no crypto). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** F5: the run id of a child run = the parent's run id + the step key, kept UNIQUE per step and loop iteration when it is cut to 60. */
export function childRunId(runId: string, key: string): string {
  const full = `${runId}.${key}`;
  return full.length <= 60 ? full : `${full.slice(0, 44)}~${fnv1a(full)}`;
}

const keyOf = (id: string, path: readonly number[]): string => (path.length ? `${id}#${path.join(".")}` : id);

function ref(rt: Rt, step: Step, path: readonly number[]): StepRef {
  return { workflowId: rt.workflowId, version: rt.version, runId: rt.runId, stepId: step.id, stepKey: keyOf(step.id, path), loopPath: [...path] };
}

function toStepError(e: unknown): { code: string; message: string } {
  if (isCancellation(e)) throw e;
  if (e instanceof ContinueAsNew) throw e;
  if (e instanceof StepFailed) return { code: e.code, message: e.message };
  if (e instanceof ExprError) return { code: e.code, message: e.message };
  if (e instanceof ActivityFailure || e instanceof ChildWorkflowFailure) {
    const c = e.cause;
    if (c instanceof ApplicationFailure) return { code: c.type ?? "activity_failed", message: c.message };
    if (c instanceof TimeoutFailure) return { code: "timeout", message: c.message };
    if (c instanceof ChildWorkflowFailure || c instanceof ActivityFailure) return toStepError(c);
    return { code: "activity_failed", message: e.message };
  }
  if (e instanceof ApplicationFailure) return { code: e.type ?? "failed", message: e.message };
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}

async function record(a: RecordStepArgs): Promise<void> {
  if (!patched(PATCH.index)) return;
  try {
    await local.recordStep(a);
  } catch (e) {
    if (isCancellation(e)) throw e;
    // the index is not the truth; a failed index write never fails a run
  }
}

function scopeOf(sc: RtScope): Scope {
  return sc;
}

/** A failure no question can fix (a loop over a bad list): continue gives null, anything else stops. */
function failStep(step: { id: string; onFail?: OnFail }, err: { code: string; message: string }): null {
  if (step.onFail === "continue") return null;
  throw new StepFailed(err.code, err.message, step.id);
}

const BACKOFF_FIRST_SEC = 30;
const BACKOFF_MAX_SEC = 300;
const MAX_ASKS = 5;
const MAX_WAIT_MS = 7 * 86_400_000;
/** failures a question to the owner cannot fix */
const NO_ASK = new Set(["not_in_workflow", "not_activated", "sibling_stopped", "run_timeout", "run_too_large", "model_token_budget", "loop_bound_exceeded", "loop_not_list"]);

const light = proxyActivities<Activities>({ startToCloseTimeout: "60 seconds", retry: { maximumAttempts: 5, initialInterval: "2 seconds", backoffCoefficient: 2, maximumInterval: "1 minute" } });

/** The next wait of a durable poll: 30 s, 60 s, 120 s, 240 s, then 5 min. */
const nextDelay = (sec: number): number => Math.min(sec * 2, BACKOFF_MAX_SEC);

/** `onFail`: stop (default), continue (null output) or ask (the owner decides: retry, skip or stop). `body` runs the step once. */
async function withFailPolicy(step: { id: string; onFail?: OnFail }, kind: string, r: StepRef, extra: Partial<RecordStepArgs>, body: () => Promise<Json | null>): Promise<Json | null> {
  for (let asks = 0; ; asks++) {
    const startedAtMs = Date.now();
    try {
      return await body();
    } catch (e) {
      const err = toStepError(e);
      await record({ ...r, ...extra, kind, status: "failed", startedAtMs, endedAtMs: Date.now(), errorCode: err.code });
      if (step.onFail === "continue") return null;
      if (step.onFail !== "ask" || NO_ASK.has(err.code)) throw new StepFailed(err.code, err.message, step.id);
      if (asks >= MAX_ASKS) throw new StepFailed(err.code, `${err.message} (the owner was asked ${asks} times)`, step.id);
      const decision = await askOnFail(step.id, r, err, asks + 1);
      if (decision === "skip") return null;
      if (decision === "stop") throw new StepFailed(err.code, err.message, step.id);
      // retry: run the step again
    }
  }
}

/** The Rt of THIS workflow execution (a Temporal workflow runs in its own sandbox: module state is per execution). */
let current: Rt | undefined;
/** Time the owner takes (a hold, an approval) is not run time: it does not count against maxRunMinutes. */
function ownerWaited(sinceMs: number): void {
  if (current) current.deadlineMs += Date.now() - sinceMs;
}

/** Waits (durably) for the owner's answer to an Inbox item. Expired = the item expired unanswered. */
async function waitForAnswer(r: StepRef, purpose: "approval" | "on_fail", itemId: string, expiresAt: string, timeoutSec: number): Promise<{ status: "answered" | "expired"; response: string | null; message: string | null }> {
  const parsed = Date.parse(expiresAt);
  // never wait past the time we asked for (+2 min), whatever date Inbox answered
  const until = Math.min(Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed, Date.now() + timeoutSec * 1000) + 120_000;
  let delay = BACKOFF_FIRST_SEC;
  const began = Date.now();
  try {
    for (;;) {
      await sleep(delay * 1000);
      const p = await light.approvalPoll({ ...r, itemId, purpose });
      if (p.status === "answered") return { status: "answered", response: p.response, message: p.message };
      if (p.status === "expired") return { status: "expired", response: null, message: null };
      if (p.status === "unknown") throw new StepFailed("approval_lost", "Inbox does not know the question any more.", r.stepId);
      if (Date.now() > until) return { status: "expired", response: null, message: null };
      delay = nextDelay(delay);
    }
  } finally {
    ownerWaited(began);
  }
}

/** The owner decides what happens to a failed step: Approve = retry, Clarify = skip, Deny / no answer = stop. */
async function askOnFail(stepId: string, r: StepRef, err: { code: string; message: string }, askNo: number): Promise<"retry" | "skip" | "stop"> {
  const timeoutSec = 86400;
  const context = `Step "${stepId}" of ${r.workflowId} (run ${r.runId}) failed: ${err.code}. ${err.message.slice(0, 300)}\n\nApprove = try the step again. Clarify = skip the step and go on. Deny = stop the run.`;
  try {
    const ask = await light.approvalAsk({ ...r, title: `Workflow step failed: ${stepId}`, context, timeoutSec, responses: ["approve", "deny", "clarify"], purpose: "on_fail", askNo, startedAtMs: Date.now() });
    const a = await waitForAnswer(r, "on_fail", ask.itemId, ask.expiresAt, timeoutSec);
    if (a.status === "answered" && a.response === "approve") return "retry";
    if (a.status === "answered" && a.response === "clarify") return "skip";
    return "stop";
  } catch (e) {
    toStepError(e); // rethrows a cancellation
    return "stop";
  }
}

/** Waits for the owner to decide a held app call. Resolves when the call may be repeated; throws when the hold is denied or expired. */
async function waitForHold(r: StepRef, product: string, holdId: string, expiresAt: string): Promise<void> {
  const parsed = Date.parse(expiresAt);
  const until = Math.min(Number.isNaN(parsed) ? Date.now() + 86_400_000 : parsed + 120_000, Date.now() + MAX_WAIT_MS);
  let delay = BACKOFF_FIRST_SEC;
  const began = Date.now();
  try {
    for (;;) {
      await sleep(delay * 1000);
      const h = await light.holdCheck({ ...r, product, holdId });
      if (h.state === "approved" || h.state === "decided") return;
      if (h.state === "denied") throw new StepFailed("hold_denied", `The owner denied hold ${holdId}.`, r.stepId);
      if (h.state === "expired") throw new StepFailed("hold_expired", `Hold ${holdId} expired without a decision.`, r.stepId);
      if (h.state === "gone") throw new StepFailed("hold_gone", `The engine cannot see hold ${holdId} any more.`, r.stepId);
      if (Date.now() > until) throw new StepFailed("hold_expired", `Hold ${holdId} was not decided in time.`, r.stepId);
      delay = nextDelay(delay);
    }
  } finally {
    ownerWaited(began);
  }
}

/** A parallel branch gets a stop flag; a flag also stops when the flag of the enclosing branch is set. */
interface Stop {
  v: boolean;
  parent?: Stop | undefined;
}
const isStopped = (s: Stop | undefined): boolean => (s ? s.v || isStopped(s.parent) : false);

async function execSteps(steps: readonly Step[], sc: RtScope, rt: Rt, path: readonly number[], startAt = 0, resumeLoop?: ResumeState["loop"], stop?: Stop): Promise<Json | null> {
  let last: Json | null = null;
  for (let i = startAt; i < steps.length; i++) {
    const step = steps[i] as Step;
    last = await execStep(step, sc, rt, path, i, resumeLoop && resumeLoop.stepId === step.id ? resumeLoop : undefined, stop);
  }
  return last;
}

async function execStep(step: Step, sc: RtScope, rt: Rt, path: readonly number[], index: number, resumeLoop?: ResumeState["loop"], stop?: Stop): Promise<Json | null> {
  if (++rt.executed > MAX_EXECUTIONS) throw new StepFailed("run_too_large", `the run executed more than ${MAX_EXECUTIONS} steps`, step.id);
  if (isStopped(stop)) throw new StepFailed("sibling_stopped", "another branch stopped the run", step.id);
  if (Date.now() > rt.deadlineMs) throw new StepFailed("run_timeout", "the run is past its maxRunMinutes limit", step.id);
  let out: Json | null;
  switch (step.type) {
    case "app":
      out = await execApp(step, sc, rt, path);
      break;
    case "ai":
      out = await execAi(step, sc, rt, path);
      break;
    case "approval":
      out = await execApproval(step, sc, rt, path);
      break;
    case "transform":
      out = await execTransform(step, sc, rt, path);
      break;
    case "timer":
      out = await execTimer(step, sc, rt, path);
      break;
    case "condition":
      out = await execCondition(step, sc, rt, path, stop);
      break;
    case "loop":
      out = await execLoop(step, sc, rt, path, index, resumeLoop, stop);
      break;
    case "parallel":
      out = await execParallel(step, sc, rt, path, stop);
      break;
    case "workflow":
      out = await execWorkflow(step, sc, rt, path);
      break;
  }
  sc.steps[step.id] = { output: out };
  return out;
}

function retryOf(step: { id: string; retry?: { max?: number; backoffSec?: number } }, rt: Rt, dflt: number) {
  const noRetry = rt.noRetry.has(step.id);
  return { maximumAttempts: noRetry ? 1 : (step.retry?.max ?? dflt), initialInterval: `${step.retry?.backoffSec ?? 2} seconds`, backoffCoefficient: 2, maximumInterval: "5 minutes" } as const;
}

async function execApp(step: AppStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
  const r = ref(rt, step, path);
  return withFailPolicy(step, "app", r, { product: step.product, op: step.op }, async () => {
    const startedAtMs = Date.now();
    const input = renderTree(step.input ?? {}, scopeOf(sc)) as Json;
    assertPayloadSize(input, `The input of ${step.id}`, step.id);
    const retry = retryOf(step, rt, 3);
    const acts = proxyActivities<Activities>({ startToCloseTimeout: `${step.timeoutSec ?? 60} seconds`, retry });
    const args = { ...r, product: step.product, op: step.op, input, maxAttempts: retry.maximumAttempts, startedAtMs };
    let res = await acts.appStep(args);
    if (res.status === "held") {
      // the bridge holds the call for the owner: wait durably (30 s -> 5 min), then repeat the SAME call once (same input, same key)
      await waitForHold(r, step.product, res.holdId, res.expiresAt);
      res = await acts.appStep({ ...args, afterHold: res.holdId });
      if (res.status === "held") throw new StepFailed("held_again", "The call was held again after the owner approved it.", step.id);
    }
    if (step.outputSchema) await checkOutput(step.outputSchema, res.output, step.id);
    return res.output;
  });
}

async function checkOutput(schema: Json, value: Json, stepId: string): Promise<void> {
  const v = await local.validateOutput({ schema, value });
  if (!v.ok) throw new StepFailed("output_invalid", v.message ?? "the output does not fit its schema", stepId);
}

async function execAi(step: AiStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
  const r = ref(rt, step, path);
  const agent = "agent" in step.by;
  return withFailPolicy(step, "ai", r, {}, async () => {
    const startedAtMs = Date.now();
    const budget = rt.contract.limits?.maxModelTokens;
    if (!agent && budget !== undefined && rt.tokens >= budget) throw new StepFailed("model_token_budget", `The run used ${rt.tokens} model tokens; its limit is ${budget}.`, step.id);
    const s = scopeOf(sc);
    const inputs = renderTree(step.inputs ?? {}, s) as Json;
    const instruction = String(renderString(step.instruction, s) ?? "");
    assertPayloadSize({ inputs, instruction }, `The input of ${step.id}`, step.id);
    const timeoutSec = step.timeoutSec ?? (agent ? 900 : 120);
    const retry = retryOf(step, rt, agent ? 1 : 2);
    const acts = proxyActivities<Activities>({ startToCloseTimeout: `${timeoutSec} seconds`, ...(agent && (step.heartbeatSec ?? 0) > 0 ? { heartbeatTimeout: `${3 * (step.heartbeatSec as number)} seconds` } : {}), retry });
    const res = await acts.aiStep({ ...r, by: step.by, instruction, inputs, outputSchema: step.outputSchema, timeoutSec, ...(agent && step.heartbeatSec ? { heartbeatSec: step.heartbeatSec } : {}), ...(step.maxTokens ? { maxTokens: step.maxTokens } : {}), maxAttempts: retry.maximumAttempts, startedAtMs });
    // a role call answers {output, tokens}; an agent step completes asynchronously with the typed output itself (step_report)
    const output = (agent ? (res as unknown as Json) : res.output) ?? null;
    if (!agent) rt.tokens += (res.tokensIn ?? 0) + (res.tokensOut ?? 0);
    await checkOutput(step.outputSchema, output, step.id);
    await record({ ...r, kind: "ai", status: "completed", startedAtMs, endedAtMs: Date.now(), outBytes: JSON.stringify(output).length });
    return output;
  });
}

async function execApproval(step: ApprovalStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  try {
    const s = scopeOf(sc);
    const timeoutSec = step.timeoutSec ?? 86400;
    assertPayloadSize({ t: step.title, c: step.context }, `The question of ${step.id}`, step.id);
    // only `answered` + `approve` is an approval; deny, expiry and any other answer are "not approved" and onDeny decides
    const ask = await light.approvalAsk({ ...r, title: String(renderString(step.title, s) ?? ""), context: String(renderString(step.context ?? "", s) ?? ""), timeoutSec, responses: ["approve", "deny"], purpose: "approval", askNo: 0, startedAtMs });
    const a = await waitForAnswer(r, "approval", ask.itemId, ask.expiresAt, timeoutSec);
    const approved = a.status === "answered" && a.response === "approve";
    const response = a.status === "expired" ? "expired" : (a.response ?? "deny");
    if (!approved && step.onDeny !== "continue") throw new StepFailed(a.status === "expired" ? "approval_expired" : "denied", a.status === "expired" ? "The owner did not answer in time." : `The owner answered "${response}".`, step.id);
    await record({ ...r, kind: "approval", status: "completed", startedAtMs, endedAtMs: Date.now() });
    return { response, message: a.message };
  } catch (e) {
    const err = toStepError(e);
    await record({ ...r, kind: "approval", status: "failed", startedAtMs, endedAtMs: Date.now(), errorCode: err.code });
    throw new StepFailed(err.code, err.message, step.id);
  }
}

async function execTransform(step: TransformStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  try {
    const { id: _id, type: _type, stage: _stage, title: _title, outputSchema: _out, ...spec } = step;
    const out = runTransform(spec as TransformSpec, scopeOf(sc)) as Json;
    await record({ ...r, kind: "transform", status: "completed", startedAtMs, endedAtMs: Date.now(), outBytes: JSON.stringify(out ?? null).length });
    return out ?? null;
  } catch (e) {
    const err = toStepError(e);
    await record({ ...r, kind: "transform", status: "failed", startedAtMs, endedAtMs: Date.now(), errorCode: err.code });
    throw new StepFailed(err.code, err.message, step.id);
  }
}

async function execTimer(step: TimerStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  let ms: number;
  if (step.seconds !== undefined) ms = step.seconds * 1000;
  else {
    const v = renderString(step.until ?? "", scopeOf(sc));
    const at = typeof v === "string" ? Date.parse(v) : Number.NaN;
    if (Number.isNaN(at)) {
      await record({ ...r, kind: "timer", status: "failed", startedAtMs, endedAtMs: Date.now(), errorCode: "timer_until_invalid" });
      throw new StepFailed("timer_until_invalid", "timer.until is not a date", step.id);
    }
    ms = Math.max(0, at - Date.now());
  }
  ms = Math.min(ms, 31_536_000_000);
  await record({ ...r, kind: "timer", status: "running", startedAtMs });
  if (ms > 0) await sleep(ms);
  const waitedSec = Math.round(ms / 1000);
  await record({ ...r, kind: "timer", status: "completed", startedAtMs, endedAtMs: Date.now() });
  return { waitedSec };
}

async function execCondition(step: ConditionStep, sc: RtScope, rt: Rt, path: readonly number[], stop?: Stop): Promise<Json | null> {
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  let taken: "then" | "else" | "none";
  try {
    taken = evalCondition(step.if, scopeOf(sc)) ? "then" : step.else ? "else" : "none";
  } catch (e) {
    const err = toStepError(e);
    await record({ ...r, kind: "condition", status: "failed", startedAtMs, endedAtMs: Date.now(), errorCode: err.code });
    throw new StepFailed(err.code, err.message, step.id);
  }
  const branch = taken === "then" ? step.then : taken === "else" ? (step.else ?? []) : [];
  const output = await execSteps(branch, sc, rt, path, 0, undefined, stop);
  await record({ ...r, kind: "condition", status: "completed", startedAtMs, endedAtMs: Date.now() });
  return { branch: taken, output };
}

async function execLoop(step: LoopStep, sc: RtScope, rt: Rt, path: readonly number[], topIndex: number, resumeLoop?: ResumeState["loop"], stop?: Stop): Promise<Json | null> {
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  const list = renderString(step.forEach, scopeOf(sc));
  if (!Array.isArray(list)) {
    await record({ ...r, kind: "loop", status: "failed", startedAtMs, endedAtMs: Date.now(), errorCode: "loop_not_list" });
    return failStep(step, { code: "loop_not_list", message: `${step.forEach} is not a list` });
  }
  if (list.length > step.max) {
    // never a silent cut: the bound is part of the contract
    await record({ ...r, kind: "loop", status: "failed", startedAtMs, endedAtMs: Date.now(), errorCode: "loop_bound_exceeded" });
    return failStep(step, { code: "loop_bound_exceeded", message: `the list has ${list.length} elements; the loop bound is ${step.max}` });
  }
  const results: Json[] = resumeLoop ? [...resumeLoop.results] : [];
  const from = resumeLoop ? resumeLoop.nextIndex : 0;
  let doneHere = 0;
  for (let i = from; i < list.length; i++) {
    if (path.length === 0 && doneHere >= rt.canEvery) {
      // keep the history small: continue as a new Temporal run with the state so far
      assertPayloadSize({ steps: sc.steps, results }, "The state a loop carries over a continue-as-new", step.id);
      const resume: ResumeState = { steps: sc.steps as ResumeState["steps"], topIndex, loop: { stepId: step.id, nextIndex: i, results }, executed: rt.executed, startedAtMs: rt.startedAtMs, tokens: rt.tokens };
      await continueAsNew<typeof evolutionRun>({ ...rt.input, runId: rt.runId, version: rt.version, trigger: rt.trigger, resume });
    }
    const iter: RtScope = { ...sc, steps: { ...sc.steps }, loop: { item: list[i], index: i } };
    const last = await execSteps(step.steps, iter, rt, [...path, i], 0, undefined, stop);
    results.push(last);
    doneHere++;
  }
  await record({ ...r, kind: "loop", status: "completed", startedAtMs, endedAtMs: Date.now() });
  return { items: results, count: results.length };
}

async function execParallel(step: ParallelStep, sc: RtScope, rt: Rt, path: readonly number[], outer?: Stop): Promise<Json | null> {
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  const names = Object.keys(step.branches);
  const scopes = names.map(() => ({ ...sc, steps: { ...sc.steps } }) as RtScope);
  // Branches run side by side. When one stops the run, the others do not start another step (cooperative stop) and the run
  // fails with the FIRST error. No cancellation of in-flight activities: cancelling a sibling that completes in the same
  // workflow activation is an SDK race (ACTIVITY_UNKNOWN), and an activity that already did its work should be recorded.
  let first: unknown;
  const flag: Stop = { v: false, parent: outer };
  const settled = await Promise.all(
    names.map(async (n, i) => {
      try {
        return { ok: true as const, v: await execSteps(step.branches[n] as Step[], scopes[i] as RtScope, rt, path, 0, undefined, flag) };
      } catch (e) {
        if (!flag.v) {
          flag.v = true;
          first = e;
        }
        return { ok: false as const, v: null };
      }
    }),
  );
  if (flag.v) throw first;
  const outputs = settled.map((x) => x.v);
  for (const b of scopes) for (const [k, v] of Object.entries(b.steps)) if (!(k in sc.steps)) sc.steps[k] = v;
  await record({ ...r, kind: "parallel", status: "completed", startedAtMs, endedAtMs: Date.now() });
  const out: { [k: string]: Json } = {};
  names.forEach((n, i) => {
    out[n] = outputs[i] ?? null;
  });
  return out;
}

async function execWorkflow(step: WorkflowStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
  const r = ref(rt, step, path);
  return withFailPolicy(step, "workflow", r, {}, async () => {
    const startedAtMs = Date.now();
    if (rt.depth + 1 > 3) throw new StepFailed("workflow_depth", "workflows nest 3 levels deep at most", step.id);
    const input = renderTree(step.input ?? {}, scopeOf(sc)) as Record<string, Json>;
    assertPayloadSize(input, `The input of ${step.id}`, step.id);
    // F4: the parent must still be activated and the child must be ACTIVE (it starts a new run)
    if (patched(PATCH.childCheck)) await light.checkActive({ workflowId: rt.workflowId, version: rt.version, child: { workflowId: step.workflow, version: step.version ?? null } });
    const childRun = childRunId(rt.runId, keyOf(step.id, path));
    const res = await executeChild(evolutionRun, {
      workflowId: `evo:${step.workflow}:${childRun}`,
      args: [{ workflowId: step.workflow, version: step.version ?? null, runId: childRun, trigger: { kind: "manual", input, firedAt: new Date(Date.now()).toISOString() }, depth: rt.depth + 1, parent: { workflowId: rt.workflowId, runId: rt.runId, stepId: step.id } }],
    });
    await record({ ...r, kind: "workflow", status: "completed", startedAtMs, endedAtMs: Date.now() });
    return res.outputs;
  });
}

/** A failure before the run exists (no definition, not activated, bad input): the workflow fails with the activity's code. */
function failRun(e: unknown): never {
  const err = toStepError(e);
  throw ApplicationFailure.nonRetryable(err.message, err.code);
}

export async function evolutionRun(input: RunInput): Promise<RunResult> {
  const info = workflowInfo();
  const runId = input.runId || deriveRunId(info.workflowId, input.workflowId);
  const startedAtMs = input.resume?.startedAtMs ?? info.startTime.getTime();
  let trigger = input.trigger;

  // A poll start reads first and stops early, without a run row, when the cursor did not change.
  if (trigger.kind === "poll" && !input.resume && trigger.item === undefined) {
    const p = await base.pollCheck({ workflowId: input.workflowId, runId, version: input.version ?? 0, scheduleId: trigger.scheduleId ?? null }).catch(failRun);
    if (!p.changed) return { status: "skipped", workflowId: input.workflowId, version: input.version ?? 0, runId, outputs: {}, reason: "no_change" };
    trigger = { ...trigger, item: p.item ?? null, ...(p.cursor !== undefined ? { cursor: p.cursor } : {}), ...(p.previousCursor !== undefined ? { previousCursor: p.previousCursor } : {}) };
  }

  const prepared: Prepared = await base
    .prepareRun({
    workflowId: input.workflowId,
    version: input.version,
    runId,
    trigger,
    startedAtMs,
    temporalWorkflowId: info.workflowId,
    temporalRunId: info.runId,
    depth: input.depth ?? 0,
    ...(input.parent ? { parent: input.parent } : {}),
    resumed: input.resume !== undefined,
  })
    .catch(failRun);
  trigger = prepared.trigger;
  const c = prepared.contract;
  const rt: Rt = {
    input,
    workflowId: input.workflowId,
    version: prepared.version,
    runId,
    contract: c,
    trigger,
    noRetry: new Set(prepared.noRetry),
    deadlineMs: startedAtMs + (c.limits?.maxRunMinutes ?? 60) * 60_000,
    startedAtMs,
    executed: input.resume?.executed ?? 0,
    tokens: input.resume?.tokens ?? 0,
    canEvery: input.canEvery ?? DEFAULT_CAN_EVERY,
    depth: input.depth ?? 0,
  };
  current = rt;
  const sc: RtScope = { input: trigger.input ?? {}, trigger, steps: input.resume ? { ...input.resume.steps } : {} };

  try {
    await execSteps(c.steps, sc, rt, [], input.resume?.topIndex ?? 0, input.resume?.loop);
    const outputs: Record<string, Json> = {};
    for (const [name, text] of Object.entries(c.outputs ?? {})) outputs[name] = (renderString(text, scopeOf(sc)) as Json | undefined) ?? null;
    assertPayloadSize(outputs, "The outputs of the workflow", "outputs");
    await base.finishRun({ workflowId: input.workflowId, runId, status: "completed", endedAtMs: Date.now(), outputBytes: JSON.stringify(outputs).length });
    return { status: "completed", workflowId: input.workflowId, version: prepared.version, runId, outputs };
  } catch (e) {
    if (e instanceof ContinueAsNew) throw e;
    if (isCancellation(e)) {
      await CancellationScope.nonCancellable(() => base.finishRun({ workflowId: input.workflowId, runId, status: "cancelled", endedAtMs: Date.now() }));
      throw e;
    }
    const f = e instanceof StepFailed ? e : new StepFailed(toStepError(e).code, toStepError(e).message);
    await CancellationScope.nonCancellable(() => base.finishRun({ workflowId: input.workflowId, runId, status: "failed", endedAtMs: Date.now(), errorCode: f.code, ...(f.stepId ? { errorStep: f.stepId } : {}) }));
    // a failed workflow, not a failed workflow task: the run ends here and Temporal does not retry it
    throw ApplicationFailure.nonRetryable(`${f.stepId ? `${f.stepId}: ` : ""}${f.message}`, f.code);
  }
}
