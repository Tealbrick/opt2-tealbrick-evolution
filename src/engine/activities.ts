// Activities of the interpreter (ENGINE-BUILD §3). They run in the app process, so they can reach app.db and `callApp`.
// They write the run index (engine_runs / engine_steps) and are the only place that calls another app.
//
// Engine narrowing (§4, C366): the bridge limits Evolving Workflows AS A WHOLE (one companion grant per app). Each workflow's
// own limit is enforced HERE: an `app` call is refused (`not_in_workflow`) unless (product, op) is in the list the owner
// activated for that version, and for a dynamic op (Connect `tools`) the tool name too. Until per-workflow grants (P1).
import { createHash } from "node:crypto";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type CompanionResult, type Db, type Logger, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { ApplicationFailure, CompleteAsyncError, Context } from "@temporalio/activity";
import { type AgentStepPort, currentAgentPort, currentModelPort, type ModelPort } from "./agent-port.ts";
import { currentCatalog, findOp } from "./catalog.ts";
import { walkSteps } from "./contract.ts";
import * as store from "./engine-store.ts";
import type { Json } from "./json.ts";
import { ModelError } from "./models.ts";
import type { Activities, AiStepArgs, AiStepResult, ApprovalAskArgs, ApprovalAskResult, ApprovalPollArgs, ApprovalPollResult, AppStepArgs, AppStepResult, CheckActiveArgs, FinishArgs, HoldCheckArgs, HoldCheckResult, LocalActivities, PollArgs, PollResult, PrepareArgs, Prepared, RecordStepArgs, StepRef, TriggerInfo, ValidateOutputArgs } from "./run-types.ts";

/** `context` is sent only when the bridge declares the cap `app_call_context` (P4); the SDK of this build ignores it otherwise. */
export type CallApp = (product: string, op: string, input: Json, opts?: { idempotencyKey?: string; context?: Record<string, Json> }) => Promise<CompanionResult>;

/** Bridge capabilities the engine reads (ctx.bridgeCaps()): advisory, never a grant. */
export const CAP_HOLD_STATUS = "app_hold_status";
export const CAP_CALL_CONTEXT = "app_call_context";

export interface EngineDeps {
  db: Db;
  callApp: CallApp;
  log: Logger;
  now?: () => number;
  /** default: the registered agent port (agent-port.ts) */
  agentPort?: () => AgentStepPort;
  /** default: the registered model port (M2) */
  models?: () => ModelPort;
  /** the capabilities of the current slice's bridge (`ctx.bridgeCaps()`); default none */
  bridgeCaps?: () => readonly string[];
}

const MAX_OUTPUT_BYTES = 1_500_000;

/** A failure the workflow must not retry. `type` is the code the owner sees. */
export function permanent(type: string, message: string): ApplicationFailure {
  return ApplicationFailure.create({ message, type, nonRetryable: true });
}

/** Idempotency key of an `app` call (§3): wfrun:<workflowId>:<runId>:<stepId>[:<i>]. Over 128 characters it is hashed (the SDK allows 8..128). */
export function idempotencyKey(workflowId: string, runId: string, stepId: string, loopPath: readonly number[], suffix = ""): string {
  const key = `wfrun:${workflowId}:${runId}:${stepId}${loopPath.length ? `:${loopPath.join(".")}` : ""}${suffix}`;
  return key.length <= 128 ? key : `wfrun:${createHash("sha256").update(key).digest("hex").slice(0, 60)}`;
}

function classify(e: unknown): ApplicationFailure {
  if (e instanceof TbError) {
    const transient = e.httpStatus >= 500 || e.httpStatus === 429 || e.httpStatus === 408 || e.code === "rate_limited" || e.code === "timeout";
    // the code and the status only: the text of another app may hold its data, and a failure is stored in Temporal history
    return ApplicationFailure.create({ message: `${e.code} (HTTP ${e.httpStatus})`, type: e.code, nonRetryable: !transient });
  }
  if (e instanceof ApplicationFailure) return e;
  return ApplicationFailure.create({ message: (e instanceof Error ? e.message : String(e)).slice(0, 300), type: "call_failed", nonRetryable: false });
}

function attemptNo(): number {
  try {
    return Context.current().info.attempt;
  } catch {
    return 1;
  }
}

const sizeOf = (v: unknown): number => (v === undefined ? 0 : JSON.stringify(v).length);

function localDate(ms: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** Reads a JSON pointer (`/result/historyId`) out of a value. */
export function pointerGet(v: unknown, pointer: string): unknown {
  let cur = v;
  for (const raw of pointer.split("/").slice(1)) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(seg)] : Object.hasOwn(cur, seg) ? (cur as Record<string, unknown>)[seg] : undefined;
  }
  return cur;
}

export function createActivities(deps: EngineDeps): Activities & LocalActivities {
  const now = deps.now ?? Date.now;
  const { db } = deps;
  const caps = (): readonly string[] => deps.bridgeCaps?.() ?? [];

  /** callApp with the idempotency key and, behind the cap app_call_context, the call context (holds and receipts show the workflow). */
  function invoke(product: string, op: string, input: Json, key: string, r: StepRef): Promise<CompanionResult> {
    const context: Record<string, Json> | undefined = caps().includes(CAP_CALL_CONTEXT) ? { "evolution.workflow": r.workflowId, "evolution.version": r.version, "evolution.run": r.runId, "evolution.step": r.stepKey } : undefined;
    return deps.callApp(product, op, input, { idempotencyKey: key, ...(context ? { context } : {}) });
  }

  /** An activated version (active, or superseded with runs still finishing) may call; a deactivated or never activated one may not. */
  function activationFor(workflowId: string, version: number): store.Activation {
    const a = store.getActivation(db, workflowId, version);
    if (!a || a.state === "deactivated") throw permanent("not_activated", `Version ${version} of ${workflowId} is not activated.`);
    return a;
  }

  function writeStep(a: RecordStepArgs | (Omit<RecordStepArgs, "kind"> & { kind: string }), extra: Partial<store.StepWrite> = {}): void {
    store.writeStep(
      db,
      {
        workflowId: a.workflowId,
        runId: a.runId,
        stepKey: a.stepKey,
        stepId: a.stepId,
        loopPath: a.loopPath,
        kind: a.kind,
        status: a.status,
        startedAt: a.startedAtMs,
        endedAt: a.endedAtMs ?? null,
        product: a.product ?? null,
        op: a.op ?? null,
        errorCode: a.errorCode ?? null,
        outBytes: a.outBytes ?? null,
        ...extra,
      },
      now(),
    );
  }

  return {
    // ── run start: load the definition (never embedded in a Schedule), check the activation, create the index row ──
    async prepareRun(a: PrepareArgs): Promise<Prepared> {
      const version = a.version ?? store.activeActivation(db, a.workflowId)?.version ?? null;
      if (version === null) throw permanent("not_activated", `${a.workflowId} has no active version. Activate a version first.`);
      const def = store.getDefinition(db, a.workflowId, version);
      if (!def) throw permanent("not_found", `No stored version ${version} of ${a.workflowId}.`);
            const act = activationFor(a.workflowId, version);
      // F3: a version that a newer one replaced still lets its runs in flight finish (every call is checked against its own list),
      // but it starts nothing new: not by hand, not by a pinned schedule, not as a child step
      if (!a.resumed && act.state !== "active") throw permanent("version_not_active", `Version ${version} of ${a.workflowId} was replaced by a newer active version; it starts no new run.`);
      const c = def.contract;

      const timezone = a.trigger.timezone ?? c.triggers.flatMap((t) => (t.kind === "schedule" ? [t.timezone] : []))[0] ?? "UTC";
      const defaults = c.triggers.flatMap((t) => (a.trigger.kind === t.kind && t.kind === "schedule" ? [t.input ?? {}] : a.trigger.kind === t.kind && t.kind === "manual" ? [t.inputs ?? {}] : []))[0] ?? {};
      const input = { ...defaults, ...(a.trigger.input ?? {}) };
      if (!a.resumed) {
        const v = validateAgainstSchema((c.inputs ?? { type: "object", additionalProperties: false }) as never, input as never);
        if (!v.ok) throw permanent("input_invalid", `The run input does not fit the workflow inputs: ${v.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`.slice(0, 400));
      }
      const trigger: TriggerInfo = { ...a.trigger, input, timezone, firedAt: a.trigger.firedAt ?? new Date(a.startedAtMs).toISOString(), date: a.trigger.date ?? localDate(a.startedAtMs, timezone) };

      const noRetry: string[] = [];
      walkSteps(c.steps, (s) => {
        if (s.type !== "app") return;
        const op = findOp(currentCatalog(), s.product, s.op);
        if (op && op.effect !== "read" && op.idempotency === "none") noRetry.push(s.id);
      });

      db.transaction(() => {
        store.startRun(db, { workflowId: a.workflowId, runId: a.runId, version, scheduleId: a.trigger.scheduleId ?? null, temporalWorkflowId: a.temporalWorkflowId, temporalRunId: a.temporalRunId, triggerKind: a.trigger.kind, startedAt: a.startedAtMs }, now());
        // F7: the new cursor is pending until THIS run completes (engine-store finishRun); a failed run leaves the cursor, the change is seen again
        if (a.trigger.kind === "poll" && a.trigger.scheduleId && a.trigger.cursor !== undefined && !a.resumed) store.setPendingCursor(db, a.trigger.scheduleId, a.runId, a.trigger.cursor);
      });
      return { version, contract: c, trigger, noRetry, startedAtMs: a.startedAtMs };
    },

    // ── poll trigger: read, compare the cursor, stop early when nothing changed ──
    async pollCheck(a: PollArgs): Promise<PollResult> {
      const sch = a.scheduleId ? store.getSchedule(db, a.scheduleId) : null;
      if (!sch?.poll) throw permanent("poll_not_configured", "This run has no poll schedule.");
      const version = a.version || store.activeActivation(db, a.workflowId)?.version;
      if (!version) throw permanent("not_activated", `${a.workflowId} has no active version.`);
      const act = activationFor(a.workflowId, version);
      const { product, op, input, cursorPath } = sch.poll;
      const use = act.uses.find((u) => u.product === product && u.op === op && u.steps.includes("trigger"));
      if (!use) throw permanent("not_in_workflow", `${product}.${op} is not in the activated list of ${a.workflowId} v${version}.`);
      if (use.tools && !use.tools.includes(String((input as { tool?: unknown }).tool))) throw permanent("not_in_workflow", `The tool of the poll is not in the activated list of ${a.workflowId} v${version}.`);
      let r: CompanionResult;
      try {
        r = await deps.callApp(product, op, input as Json);
      } catch (e) {
        throw classify(e);
      }
      if (r.status !== "ok") throw permanent("held", "The poll call is held for the owner.");
      const value = pointerGet(r.output, cursorPath);
      if (value === undefined || value === null) throw permanent("cursor_missing", `The poll output has nothing at ${cursorPath}.`);
      const cursor = typeof value === "string" ? value : JSON.stringify(value);
      if (cursor === sch.cursor) return { changed: false };
      return { changed: true, item: r.output, cursor: cursor.slice(0, 200), ...(sch.cursor !== null ? { previousCursor: sch.cursor } : {}) };
    },

    // ── an `app` step: narrowing, then ctx.callApp with the idempotency key ──
    async appStep(a: AppStepArgs): Promise<AppStepResult> {
      const attempts = attemptNo();
      const act = activationFor(a.workflowId, a.version);
      const base = { workflowId: a.workflowId, runId: a.runId, stepKey: a.stepKey, stepId: a.stepId, loopPath: a.loopPath, kind: "app", product: a.product, op: a.op, startedAt: a.startedAtMs };
      const refuse = (message: string): never => {
        store.writeStep(db, { ...base, status: "failed", endedAt: now(), attempts, errorCode: "not_in_workflow" }, now());
        throw permanent("not_in_workflow", message);
      };
      const use = act.uses.find((u) => u.product === a.product && u.op === a.op && !u.via);
      if (!use) return refuse(`${a.product}.${a.op} is not in the activated list of ${a.workflowId} v${a.version}. The owner activates a list; the engine refuses every other call.`);
      if (use.tools) {
        const tool = (a.input as { tool?: unknown } | null)?.tool;
        if (typeof tool !== "string" || !use.tools.includes(tool)) return refuse(`The tool "${String(tool)}" of ${a.product}.${a.op} is not in the activated list of ${a.workflowId} v${a.version}.`);
      }
      store.writeStep(db, { ...base, status: "running", attempts, inBytes: sizeOf(a.input) }, now());
      let r: CompanionResult;
      try {
        r = await invoke(a.product, a.op, a.input, idempotencyKey(a.workflowId, a.runId, a.stepId, a.loopPath), a);
      } catch (e) {
        const f = classify(e);
        // the last attempt (or a refusal that no retry changes) closes the step row; an earlier one leaves it `running`
        if (f.nonRetryable || attempts >= a.maxAttempts) store.writeStep(db, { ...base, status: "failed", endedAt: now(), attempts, errorCode: f.type ?? "call_failed" }, now());
        throw f;
      }
      if (r.status === "held") {
        if (a.afterHold) {
          // the owner approved hold X and the repeated call is held AGAIN: the approval did not carry (the content changed): stop
          store.writeStep(db, { ...base, status: "failed", endedAt: now(), attempts, errorCode: "held_again" }, now());
          throw permanent("held_again", `The call was held again after the owner approved hold ${a.afterHold} (the request changed, or the approval was used).`);
        }
        // the owner sees `waiting_hold` with the hold id; the workflow waits durably and repeats the call once on approval
        store.writeStep(db, { ...base, status: "waiting_hold", attempts, hold: { id: r.holdId, startedAt: now() } }, now());
        return { status: "held", holdId: r.holdId, expiresAt: r.expiresAt };
      }
      const out = sizeOf(r.output);
      if (out > MAX_OUTPUT_BYTES) {
        store.writeStep(db, { ...base, status: "failed", endedAt: now(), attempts, errorCode: "output_too_large", outBytes: out }, now());
        throw permanent("output_too_large", `The answer of ${a.product}.${a.op} is ${out} bytes; the engine keeps ${MAX_OUTPUT_BYTES} at most.`);
      }
      store.writeStep(db, { ...base, status: "completed", endedAt: now(), attempts, outBytes: out }, now());
      return { status: "ok", output: r.output as Json };
    },

    // ── an `ai` step ──
    async aiStep(a: AiStepArgs): Promise<AiStepResult> {
      activationFor(a.workflowId, a.version); // F4: deactivated mid-run -> nothing is offered or called
      const attempts = attemptNo();
      const base = { workflowId: a.workflowId, runId: a.runId, stepKey: a.stepKey, stepId: a.stepId, loopPath: a.loopPath, kind: "ai", startedAt: a.startedAtMs };
      store.writeStep(db, { ...base, status: "running", attempts, inBytes: sizeOf(a.inputs) }, now());
      if ("agent" in a.by) {
        const port = (deps.agentPort ?? currentAgentPort)();
        const info = Context.current().info;
        const stepRunId = `stp_${createHash("sha256").update(`${a.workflowId}:${a.runId}:${a.stepKey}:${attempts}`).digest("hex").slice(0, 32)}`;
        try {
          await port.offer({
            stepRunId,
            workflowId: a.workflowId,
            version: a.version,
            runId: a.runId,
            stepId: a.stepId,
            agentId: a.by.agent,
            instruction: a.instruction,
            inputs: (a.inputs ?? {}) as Record<string, unknown>,
            outputSchema: a.outputSchema as object,
            timeoutSec: a.timeoutSec,
            heartbeatSec: a.heartbeatSec ?? 0,
            attempt: attempts,
            taskToken: Buffer.from(info.taskToken).toString("base64"),
          });
        } catch (e) {
          const code = e instanceof Error && e.message === "agent_port_unavailable" ? "agent_port_unavailable" : "offer_failed";
          store.writeStep(db, { ...base, status: "failed", endedAt: now(), attempts, errorCode: code }, now());
          throw permanent(code, code === "agent_port_unavailable" ? "Agent steps are not available in this build." : "The agent step could not be offered.");
        }
        store.writeStep(db, { ...base, status: "waiting_agent", attempts, agent: { stepRunId, agentId: a.by.agent } }, now());
        if ((a.heartbeatSec ?? 0) > 0) Context.current().heartbeat();
        // WP3 completes this activity from step_report (client.activity.complete). The index row is closed by the workflow's record.
        throw new CompleteAsyncError();
      }
      let res: Awaited<ReturnType<ModelPort["run"]>>;
      try {
        res = await (deps.models ?? currentModelPort)().run({ role: a.by.role, instruction: a.instruction, inputs: a.inputs, outputSchema: a.outputSchema, maxTokens: Math.min(a.maxTokens ?? 4000, 4000), timeoutSec: a.timeoutSec });
      } catch (e) {
        const code = e instanceof ModelError ? e.code : e instanceof Error && e.message === "not_implemented" ? "not_implemented" : "model_failed";
        const retryable = e instanceof ModelError && e.retryable;
        if (!retryable || attempts >= a.maxAttempts) store.writeStep(db, { ...base, status: "failed", endedAt: now(), attempts, errorCode: code }, now());
        const message = e instanceof ModelError ? e.message : code === "not_implemented" ? "This build has no model call." : "The model call failed.";
        throw ApplicationFailure.create({ message, type: code, nonRetryable: !retryable });
      }
      store.writeStep(db, { ...base, status: "completed", endedAt: now(), attempts, outBytes: sizeOf(res.output), tokensIn: res.tokensIn ?? null, tokensOut: res.tokensOut ?? null }, now());
      return { output: res.output, ...(res.tokensIn !== undefined ? { tokensIn: res.tokensIn } : {}), ...(res.tokensOut !== undefined ? { tokensOut: res.tokensOut } : {}) };
    },

    // ── approval (also the question of onFail "ask"): Inbox inbox_ask now, inbox_status polls from the workflow ──
    async approvalAsk(a: ApprovalAskArgs): Promise<ApprovalAskResult> {
      const act = activationFor(a.workflowId, a.version);
      if (!act.uses.some((u) => u.product === "inbox" && u.op === "inbox_ask")) throw permanent("not_in_workflow", `inbox.inbox_ask is not in the activated list of ${a.workflowId} v${a.version}.`);
      const attempts = attemptNo();
      const base = { workflowId: a.workflowId, runId: a.runId, stepKey: a.stepKey, stepId: a.stepId, loopPath: a.loopPath, kind: a.purpose === "approval" ? "approval" : "app", startedAt: a.startedAtMs };
      const key = idempotencyKey(a.workflowId, a.runId, a.stepId, a.loopPath, a.purpose === "approval" ? "" : `:ask${a.askNo}`);
      let r: CompanionResult;
      try {
        r = await invoke("inbox", "inbox_ask", { title: a.title.slice(0, 200) || "Workflow question", kind: "approval", context: (a.context || "No details.").slice(0, 8000), responses: a.responses, expiresInS: Math.max(60, Math.min(a.timeoutSec, 2_592_000)) }, key, a);
      } catch (e) {
        const f = classify(e);
        if (a.purpose === "approval" && (f.nonRetryable || attempts >= 5)) store.writeStep(db, { ...base, status: "failed", endedAt: now(), attempts, errorCode: f.type ?? "call_failed" }, now());
        throw f;
      }
      if (r.status !== "ok") {
        if (a.purpose === "approval") store.writeStep(db, { ...base, status: "failed", endedAt: now(), attempts, errorCode: "held" }, now());
        throw permanent("held", "Inbox held the question for the owner; the engine cannot ask.");
      }
      const out = r.output as { itemId?: unknown; expiresAt?: unknown };
      if (typeof out?.itemId !== "string") throw permanent("inbox_answer_invalid", "Inbox answered without an item id.");
      // the owner is asked now: the step waits for the owner (the index shows it; a reply ends it)
      if (a.purpose === "approval") store.writeStep(db, { ...base, status: "waiting_owner", attempts }, now());
      return { itemId: out.itemId, expiresAt: typeof out.expiresAt === "string" ? out.expiresAt : new Date(now() + a.timeoutSec * 1000).toISOString() };
    },

    async approvalPoll(a: ApprovalPollArgs): Promise<ApprovalPollResult> {
      const act = activationFor(a.workflowId, a.version);
      if (!act.uses.some((u) => u.product === "inbox" && u.op === "inbox_status")) throw permanent("not_in_workflow", `inbox.inbox_status is not in the activated list of ${a.workflowId} v${a.version}.`);
      let r: CompanionResult;
      try {
        r = await deps.callApp("inbox", "inbox_status", { itemId: a.itemId });
      } catch (e) {
        throw classify(e);
      }
      if (r.status !== "ok") throw permanent("held", "Inbox held the status call.");
      const o = r.output as { status?: unknown; response?: unknown; message?: unknown };
      const status = o.status === "open" || o.status === "answered" || o.status === "expired" || o.status === "unknown" ? o.status : "unknown";
      // NEVER treat a missing, expired or unknown answer as approval (Inbox rule): only status answered carries a response
      return { status, response: status === "answered" && typeof o.response === "string" ? o.response : null, message: typeof o.message === "string" ? o.message.slice(0, 1000) : null };
    },

    // ── a held app call: is the hold decided? tb.hold_status behind the bridge cap, else the tb.holds_pending list ──
    async holdCheck(a: HoldCheckArgs): Promise<HoldCheckResult> {
      const act = activationFor(a.workflowId, a.version);
      if (!act.uses.some((u) => u.product === a.product)) throw permanent("not_in_workflow", `${a.product} is not in the activated list of ${a.workflowId} v${a.version}.`);
      const end = (outcome: string): void => store.endHold(db, a.workflowId, a.runId, a.stepKey, outcome, now());
      if (caps().includes(CAP_HOLD_STATUS)) {
        let r: CompanionResult;
        try {
          r = await deps.callApp(a.product, "tb.hold_status", { holdId: a.holdId });
        } catch (e) {
          if (e instanceof TbError && e.code === "hold_not_found") return { state: "gone", via: "hold_status" };
          throw classify(e);
        }
        const st = r.status === "ok" ? String((r.output as { status?: unknown }).status) : "held";
        if (st === "held") return { state: "pending", via: "hold_status" };
        if (st === "denied") {
          end("denied");
          return { state: "denied", via: "hold_status" };
        }
        if (st === "expired") {
          end("expired");
          return { state: "expired", via: "hold_status" };
        }
        // approved, run (the approval was used) or anything else decided: repeat the call; the key makes it safe
        end("approved");
        return { state: "approved", via: "hold_status" };
      }
      // fallback: the hold is pending while the instance lists it (read, owner consent). Gone from the list = decided or expired.
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        let r: CompanionResult;
        try {
          r = await deps.callApp(a.product, "tb.holds_pending", { limit: 100, ...(cursor ? { cursor } : {}) });
        } catch (e) {
          if (e instanceof TbError && (e.httpStatus === 403 || e.code === "not_in_workflow" || e.code === "grant_invalid")) throw permanent("hold_check_unavailable", `The engine may not read the pending holds of ${a.product} (the owner has not consented to tb.holds_pending).`);
          throw classify(e);
        }
        if (r.status !== "ok") throw permanent("held", "The hold list call was held.");
        const out = r.output as { items?: { id?: unknown }[]; nextCursor?: unknown };
        if ((out.items ?? []).some((i) => i.id === a.holdId)) return { state: "pending", via: "holds_pending" };
        if (typeof out.nextCursor !== "string" || !out.nextCursor) break;
        cursor = out.nextCursor;
      }
      end("decided");
      return { state: "decided", via: "holds_pending" };
    },

    /** F4: the parent (and the child it is about to start) must still be activated; the child must be ACTIVE (it starts a new run). */
    async checkActive(a: CheckActiveArgs): Promise<void> {
      activationFor(a.workflowId, a.version);
      if (a.child) {
        const v = a.child.version ?? store.activeActivation(db, a.child.workflowId)?.version ?? null;
        const ca = v === null ? null : store.getActivation(db, a.child.workflowId, v);
        if (!ca || ca.state !== "active") throw permanent("child_not_active", `The workflow ${a.child.workflowId} is not active, so a workflow step cannot start it.`);
      }
    },

    async finishRun(a: FinishArgs): Promise<void> {
      store.finishRun(db, { workflowId: a.workflowId, runId: a.runId, status: a.status === "failed" && a.errorCode === "run_timeout" ? "timed_out" : a.status, endedAt: a.endedAtMs, errorCode: a.errorCode ?? null, errorStep: a.errorStep ?? null, skippedReason: a.skippedReason ?? null, outputBytes: a.outputBytes ?? null }, now());
    },

    // ── local activities (the workflow's own steps, and output validation) ──
    async recordStep(a: RecordStepArgs): Promise<void> {
      writeStep(a);
    },
    async validateOutput(a: ValidateOutputArgs): Promise<{ ok: boolean; message?: string }> {
      const r = validateAgainstSchema(a.schema as never, a.value as never);
      return r.ok ? { ok: true } : { ok: false, message: `The output does not fit its schema: ${r.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`.slice(0, 400) };
    },
  };
}
