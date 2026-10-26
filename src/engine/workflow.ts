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
export const PATCH = { index: "evo-index-1" } as const;

const MAX_EXECUTIONS = 5000;
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

/** Applies onFail. Returns null to continue, or throws StepFailed. */
function failStep(step: { id: string; onFail?: OnFail }, err: { code: string; message: string }): null {
  if (step.onFail === "continue") return null;
  // "ask": the owner question arrives with M2 (approval + Inbox); until then it stops the run like "stop" and says why.
  throw new StepFailed(err.code, step.onFail === "ask" ? `${err.message} (onFail "ask" stops the run until the owner question ships)` : err.message, step.id);
}

async function execSteps(steps: readonly Step[], sc: RtScope, rt: Rt, path: readonly number[], startAt = 0, resumeLoop?: ResumeState["loop"]): Promise<Json | null> {
  let last: Json | null = null;
  for (let i = startAt; i < steps.length; i++) {
    const step = steps[i] as Step;
    last = await execStep(step, sc, rt, path, i, resumeLoop && resumeLoop.stepId === step.id ? resumeLoop : undefined);
  }
  return last;
}

async function execStep(step: Step, sc: RtScope, rt: Rt, path: readonly number[], index: number, resumeLoop?: ResumeState["loop"]): Promise<Json | null> {
  if (++rt.executed > MAX_EXECUTIONS) throw new StepFailed("run_too_large", `the run executed more than ${MAX_EXECUTIONS} steps`, step.id);
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
      out = await execCondition(step, sc, rt, path);
      break;
    case "loop":
      out = await execLoop(step, sc, rt, path, index, resumeLoop);
      break;
    case "parallel":
      out = await execParallel(step, sc, rt, path);
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
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  try {
    const input = renderTree(step.input ?? {}, scopeOf(sc)) as Json;
    const retry = retryOf(step, rt, 3);
    const acts = proxyActivities<Activities>({ startToCloseTimeout: `${step.timeoutSec ?? 60} seconds`, retry });
    const res = await acts.appStep({ ...r, product: step.product, op: step.op, input, maxAttempts: retry.maximumAttempts, startedAtMs });
    if (res.status === "held") {
      // M1: the hold is recorded (waiting_hold) and onFail decides. M2 adds the durable wait.
      throw new StepFailed("held", `the call is held for the owner (hold ${res.holdId}); M1 does not wait`, step.id);
    }
    if (step.outputSchema) await checkOutput(step.outputSchema, res.output, step.id);
    return res.output;
  } catch (e) {
    const err = toStepError(e);
    // a held call keeps the `waiting_hold` row the activity wrote
    if (err.code !== "held") await record({ ...r, kind: "app", status: "failed", startedAtMs, endedAtMs: Date.now(), product: step.product, op: step.op, errorCode: err.code });
    return failStep(step, err);
  }
}

async function checkOutput(schema: Json, value: Json, stepId: string): Promise<void> {
  const v = await local.validateOutput({ schema, value });
  if (!v.ok) throw new StepFailed("output_invalid", v.message ?? "the output does not fit its schema", stepId);
}

async function execAi(step: AiStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  const agent = "agent" in step.by;
  try {
    const s = scopeOf(sc);
    const inputs = renderTree(step.inputs ?? {}, s) as Json;
    const instruction = String(renderString(step.instruction, s) ?? "");
    const timeoutSec = step.timeoutSec ?? (agent ? 900 : 120);
    const retry = retryOf(step, rt, agent ? 1 : 2);
    const acts = proxyActivities<Activities>({ startToCloseTimeout: `${timeoutSec} seconds`, ...(agent ? { heartbeatTimeout: "3 minutes" } : {}), retry });
    const res = await acts.aiStep({ ...r, by: step.by, instruction, inputs, outputSchema: step.outputSchema, timeoutSec, ...(step.maxTokens ? { maxTokens: step.maxTokens } : {}), maxAttempts: retry.maximumAttempts, startedAtMs });
    await checkOutput(step.outputSchema, res.output, step.id);
    await record({ ...r, kind: "ai", status: "completed", startedAtMs, endedAtMs: Date.now(), outBytes: JSON.stringify(res.output ?? null).length });
    return res.output;
  } catch (e) {
    const err = toStepError(e);
    await record({ ...r, kind: "ai", status: "failed", startedAtMs, endedAtMs: Date.now(), errorCode: err.code });
    return failStep(step, err);
  }
}

async function execApproval(step: ApprovalStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  try {
    const s = scopeOf(sc);
    const timeoutSec = step.timeoutSec ?? 86400;
    const acts = proxyActivities<Activities>({ startToCloseTimeout: `${Math.min(timeoutSec + 60, 2_592_000)} seconds`, retry: { maximumAttempts: 1 } });
    const res = await acts.approvalStep({ ...r, title: String(renderString(step.title, s) ?? ""), context: String(renderString(step.context ?? "", s) ?? ""), timeoutSec, startedAtMs });
    if (res.response !== "approve" && step.onDeny !== "continue") throw new StepFailed("denied", `the owner answered "${res.response}"`, step.id);
    return { response: res.response, message: res.message };
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

async function execCondition(step: ConditionStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
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
  const output = await execSteps(branch, sc, rt, path);
  await record({ ...r, kind: "condition", status: "completed", startedAtMs, endedAtMs: Date.now() });
  return { branch: taken, output };
}

async function execLoop(step: LoopStep, sc: RtScope, rt: Rt, path: readonly number[], topIndex: number, resumeLoop?: ResumeState["loop"]): Promise<Json | null> {
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
      const resume: ResumeState = { steps: sc.steps as ResumeState["steps"], topIndex, loop: { stepId: step.id, nextIndex: i, results }, executed: rt.executed, startedAtMs: rt.startedAtMs };
      await continueAsNew<typeof evolutionRun>({ ...rt.input, runId: rt.runId, version: rt.version, trigger: rt.trigger, resume });
    }
    const iter: RtScope = { ...sc, steps: { ...sc.steps }, loop: { item: list[i], index: i } };
    const last = await execSteps(step.steps, iter, rt, [...path, i]);
    results.push(last);
    doneHere++;
  }
  await record({ ...r, kind: "loop", status: "completed", startedAtMs, endedAtMs: Date.now() });
  return { items: results, count: results.length };
}

async function execParallel(step: ParallelStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  const names = Object.keys(step.branches);
  const scopes = names.map(() => ({ ...sc, steps: { ...sc.steps } }) as RtScope);
  const outputs = await CancellationScope.cancellable(async () => {
    try {
      return await Promise.all(names.map((n, i) => execSteps(step.branches[n] as Step[], scopes[i] as RtScope, rt, path)));
    } catch (e) {
      // one branch stopped the run: cancel the others
      CancellationScope.current().cancel();
      throw e;
    }
  });
  for (const b of scopes) for (const [k, v] of Object.entries(b.steps)) if (!(k in sc.steps)) sc.steps[k] = v;
  await record({ ...r, kind: "parallel", status: "completed", startedAtMs, endedAtMs: Date.now() });
  const out: { [k: string]: Json } = {};
  names.forEach((n, i) => {
    out[n] = outputs[i] ?? null;
  });
  return out;
}

async function execWorkflow(step: WorkflowStep, sc: RtScope, rt: Rt, path: readonly number[]): Promise<Json | null> {
  const startedAtMs = Date.now();
  const r = ref(rt, step, path);
  try {
    if (rt.depth + 1 > 3) throw new StepFailed("workflow_depth", "workflows nest 3 levels deep at most", step.id);
    const input = renderTree(step.input ?? {}, scopeOf(sc)) as Record<string, Json>;
    const childRun = `${rt.runId}.${keyOf(step.id, path)}`.slice(0, 60);
    const res = await executeChild(evolutionRun, {
      workflowId: `evo:${step.workflow}:${childRun}`,
      args: [{ workflowId: step.workflow, version: step.version ?? null, runId: childRun, trigger: { kind: "manual", input, firedAt: new Date(Date.now()).toISOString() }, depth: rt.depth + 1, parent: { workflowId: rt.workflowId, runId: rt.runId, stepId: step.id } }],
    });
    await record({ ...r, kind: "workflow", status: "completed", startedAtMs, endedAtMs: Date.now() });
    return res.outputs;
  } catch (e) {
    const err = toStepError(e);
    await record({ ...r, kind: "workflow", status: "failed", startedAtMs, endedAtMs: Date.now(), errorCode: err.code });
    return failStep(step, err);
  }
}

export async function evolutionRun(input: RunInput): Promise<RunResult> {
  const info = workflowInfo();
  const runId = input.runId || deriveRunId(info.workflowId, input.workflowId);
  const startedAtMs = input.resume?.startedAtMs ?? info.startTime.getTime();
  let trigger = input.trigger;

  // A poll start reads first and stops early, without a run row, when the cursor did not change.
  if (trigger.kind === "poll" && !input.resume && trigger.item === undefined) {
    const p = await base.pollCheck({ workflowId: input.workflowId, runId, version: input.version ?? 0, scheduleId: trigger.scheduleId ?? null });
    if (!p.changed) return { status: "skipped", workflowId: input.workflowId, version: input.version ?? 0, runId, outputs: {}, reason: "no_change" };
    trigger = { ...trigger, item: p.item ?? null, ...(p.cursor !== undefined ? { cursor: p.cursor } : {}), ...(p.previousCursor !== undefined ? { previousCursor: p.previousCursor } : {}) };
  }

  const prepared: Prepared = await base.prepareRun({
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
  });
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
    canEvery: input.canEvery ?? DEFAULT_CAN_EVERY,
    depth: input.depth ?? 0,
  };
  const sc: RtScope = { input: trigger.input ?? {}, trigger, steps: input.resume ? { ...input.resume.steps } : {} };

  try {
    await execSteps(c.steps, sc, rt, [], input.resume?.topIndex ?? 0, input.resume?.loop);
    const outputs: Record<string, Json> = {};
    for (const [name, text] of Object.entries(c.outputs ?? {})) outputs[name] = (renderString(text, scopeOf(sc)) as Json | undefined) ?? null;
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
