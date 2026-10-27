// Owner operations of the workflow engine (WP2): contract check/save/list/get, activation, schedules, run index.
// All are person ops (the workspace owner only, C88): they return inputs/outputs-adjacent data of other apps' calls only in
// the run detail, never to an agent. `engineHandlers(manifest)` is spread into the handler map of src/app.ts.
import { nextCronTime, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type Db, type HandlerSpec, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { OP } from "#kit";
import { UNASSIGNED_AGENT } from "../migrate/contract.ts";
import { type WorkflowContract, walkSteps } from "./contract.ts";
import * as store from "./engine-store.ts";
import { EngineError } from "./errors.ts";
import { readStepIo } from "./history.ts";
import type { Json } from "./json.ts";
import { refreshRoleAttention } from "./role-attention.ts";
import { deleteSchedule, describeSchedule, pauseSchedule, runNowId, runScheduleNow, type ScheduleLive, scheduleTimeoutMs, syncAndRecord } from "./schedules.ts";
import { startRun } from "./start-run.ts";
import { getTemporal } from "./temporal.ts";
import { type OpUse, type ValidationIssue, type ValidationResult, validateContract } from "./validate.ts";

export const GRANT_NOTICE =
  "The bridge limits Evolving Workflows as a whole; each workflow's limit is enforced by the engine until per-workflow grants. The engine refuses any call of this workflow that is not in the list above.";

type Companions = readonly { product: string; operations: readonly string[] }[];

/** Typed handler; engine refusals become the CORE §8 envelope (404 / 409 / 422 / 503). */
function eop<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  const run = spec.run;
  return {
    ...spec,
    run: async (input: I, ctx: OpContext) => {
      try {
        return await run(input, ctx);
      } catch (e) {
        if (e instanceof EngineError) throw new TbError(e.code, e.message, e.status, e.details);
        throw e;
      }
    },
  } as unknown as HandlerSpec;
}

/** UsageRow of the owner UI: the ops a version calls, with the scope type and whether the target op is held. */
export function usageRows(uses: readonly OpUse[]) {
  return uses.map((u) => ({ product: u.product, op: u.op, crud: u.crud, effect: u.effect, scope: u.scopeType ?? null, held: u.holdFamily !== undefined, ...(u.tools ? { tools: u.tools } : {}), ...(u.via ? { via: u.via } : {}) }));
}

/**
 * F4 / F-G2: a `workflow` step starts another workflow, and the child's ops are part of what the owner approves (listed with `via`).
 * Check and activation both read the list from here, so they agree. A child that is not ACTIVE cannot be started: activation refuses
 * (`inactive[0]`), the check lists it as a dependency warning.
 */
export function withChildUses(db: Db, contract: WorkflowContract, own: readonly OpUse[]): { uses: OpUse[]; inactive: { stepId: string; path: string; workflow: string; version?: number }[] } {
  const uses: OpUse[] = [...own];
  const inactive: { stepId: string; path: string; workflow: string; version?: number }[] = [];
  walkSteps(contract.steps, (s, info) => {
    if (s.type !== "workflow") return;
    const child = s.version !== undefined ? store.getActivation(db, s.workflow, s.version) : store.activeActivation(db, s.workflow);
    if (child?.state !== "active") {
      inactive.push({ stepId: s.id, path: info.path, workflow: s.workflow, ...(s.version !== undefined ? { version: s.version } : {}) });
      return;
    }
    for (const u of child.uses) {
      const via = [...new Set([...(u.via ?? []), s.workflow])];
      if (!uses.some((x) => x.product === u.product && x.op === u.op && JSON.stringify(x.via ?? []) === JSON.stringify(via))) uses.push({ ...u, steps: [s.id], via });
    }
  });
  return { uses, inactive };
}

export function engineHandlers(manifest: { companions?: Companions }) {
  const companions: Companions = manifest.companions ?? [];

  function validate(ctx: OpContext, contract: unknown): ValidationResult {
    return validateContract(contract, {
      companions,
      // F-G3: the 0.3.x placeholder agent is refused when the owner checks, saves or activates (the migration itself still validates with it)
      refusePlaceholderAgent: true,
      lookupWorkflow: (id, version) => {
        const v = version ?? store.latestVersion(ctx.db, id);
        return v === null ? null : (store.getDefinition(ctx.db, id, v)?.contract ?? null);
      },
    });
  }

  function mustDefinition(ctx: OpContext, workflowId: string, version: number): store.Definition {
    const d = store.getDefinition(ctx.db, workflowId, version);
    if (!d) throw new EngineError("not_found", `No saved version ${version} of ${workflowId}.`, 404);
    return d;
  }

  /** The validate answer with the field names the owner UI reads too: `pointer` (= path) and `usage` (= uses). */
  function withAliases(r: ValidationResult, activeVersion: number | null) {
    const pt = (i: ValidationIssue) => ({ ...i, pointer: i.path });
    return { ...r, errors: r.errors.map(pt), warnings: r.warnings.map(pt), usage: usageRows(r.uses), activeVersion };
  }

  function failValidation(r: ValidationResult): never {
    throw new EngineError("validation_failed", `The contract has ${r.errors.length} error(s): ${r.errors.slice(0, 3).map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`, 422, { errors: r.errors.slice(0, 20) as unknown as Record<string, unknown>[] });
  }

  const cronOf = (spec: store.ScheduleSpecRow): string | null => spec.cron ?? null;

  async function viewOf(db: Db, row: store.ScheduleRow, live?: ScheduleLive | null): Promise<K.ScheduleSetOutput> {
    let l: ScheduleLive | null = live ?? null;
    if (l === null && live === undefined) {
      const t = await getTemporal();
      l = t.connected ? await describeSchedule(t.client, row.id) : { state: "unreachable", paused: null, nextRunAt: null, lastRunAt: null, lastRunWorkflowId: null, runningCount: 0, timezone: null, note: null };
    }
    // a "run now" starts its run directly, so the Temporal Schedule does not list it among its actions: the run index knows it
    if (l && l.state === "ok") {
      const last = store.lastScheduleRun(db, row.id);
      if (last && (l.lastRunAt === null || Date.parse(l.lastRunAt) < Date.parse(last.startedAt))) l = { ...l, lastRunAt: last.startedAt, lastRunWorkflowId: last.temporalWorkflowId };
    }
    return {
      id: row.id,
      workflowId: row.workflowId,
      versionPin: row.versionPin,
      kind: row.kind,
      cron: cronOf(row.spec),
      every: row.spec.every ?? null,
      timezone: row.spec.timezone,
      input: row.input,
      poll: row.poll as unknown as Record<string, unknown> | null,
      overlap: row.overlap,
      paused: row.paused,
      revision: row.revision,
      cursor: row.cursor,
      cursorAt: row.cursorAt,
      temporalState: row.temporalState,
      temporalError: row.temporalError,
      stale: row.staleReason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      live: l,
    } as K.ScheduleSetOutput;
  }

  /**
   * F6: a schedule that follows the active version was resolved against the version that was active when it was made. After a
   * newer version is activated, resolve it again: it still fits (its trigger, its input) -> it follows the new version; it does
   * not fit -> it is paused and carries the reason (`stale`) until the owner edits it. A pinned schedule whose pin is no longer
   * the active version is stale for the same reason: a replaced version starts no new run.
   */
  async function revalidateSchedules(ctx: OpContext, workflowId: string): Promise<{ id: string; reason: string }[]> {
    const out: { id: string; reason: string }[] = [];
    for (const s of store.listSchedules(ctx.db, workflowId)) {
      let reason: string | null = null;
      let next: ReturnType<typeof resolveSchedule> | null = null;
      try {
        next = resolveSchedule(ctx, { workflowId, kind: s.kind, versionPin: s.versionPin } as K.ScheduleSetInput, s);
      } catch (e) {
        reason = e instanceof EngineError ? e.message : "The schedule could not be checked.";
      }
      if (next && !reason) {
        const changedPoll = JSON.stringify(next.poll) !== JSON.stringify(s.poll);
        if (changedPoll || JSON.stringify(next.spec) !== JSON.stringify(s.spec)) store.updateSchedule(ctx.db, s.id, s.revision, { spec: next.spec, input: next.input, poll: next.poll }, Date.now());
        if (changedPoll) ctx.db.prepare("UPDATE engine_schedules SET cursor = NULL, cursor_at = NULL, pending_cursor = NULL, pending_run_id = NULL WHERE id = ?").run(s.id);
        if (s.staleReason) store.setStale(ctx.db, s.id, null, Date.now());
      } else if (reason) {
        const fresh = store.getSchedule(ctx.db, s.id) as store.ScheduleRow;
        if (!fresh.paused) store.updateSchedule(ctx.db, s.id, fresh.revision, { paused: true }, Date.now());
        store.setStale(ctx.db, s.id, reason, Date.now());
        out.push({ id: s.id, reason });
      }
      const row = store.getSchedule(ctx.db, s.id);
      if (row) await pushToTemporal(ctx, row);
    }
    return out;
  }

  /** Pushes a row to Temporal; a failure is recorded on the row (the reconcile job retries) and does not fail the owner's call. */
  async function pushToTemporal(ctx: OpContext, row: store.ScheduleRow): Promise<store.ScheduleRow> {
    const t = await getTemporal();
    if (!t.connected) {
      store.setScheduleSync(ctx.db, row.id, "pending", "Temporal does not answer; the schedule is created when it does.", Date.now());
    } else {
      try {
        await syncAndRecord(ctx.db, t.client, row, Date.now());
      } catch (e) {
        ctx.log.warn("schedule sync failed", { id: row.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return store.getSchedule(ctx.db, row.id) as store.ScheduleRow;
  }

  function resolveSchedule(ctx: OpContext, input: K.ScheduleSetInput, prior: store.ScheduleRow | null): Omit<store.ScheduleRow, "revision" | "cursor" | "cursorAt" | "temporalState" | "temporalError" | "staleReason" | "createdAt" | "updatedAt" | "id"> {
    const workflowId = prior?.workflowId ?? input.workflowId;
    if (prior && input.workflowId !== prior.workflowId) throw new EngineError("validation_failed", "A schedule keeps its workflow. Create a new schedule for another workflow.", 422);
    const act = store.activeActivation(ctx.db, workflowId);
    if (!act) throw new EngineError("not_activated", `${workflowId} has no active version. Activate a version before you schedule it.`, 409);
    const versionPin = input.versionPin === undefined ? (prior?.versionPin ?? null) : input.versionPin;
    if (versionPin !== null) {
      const a = store.getActivation(ctx.db, workflowId, versionPin);
      // F3: only the ACTIVE version starts runs, so a pin may name the active version only
      if (a?.state !== "active") throw new EngineError("not_activated", `Version ${versionPin} of ${workflowId} is not the active version; a schedule can follow the active version or pin it.`, 409);
    }
    const def = mustDefinition(ctx, workflowId, versionPin ?? act.version);
    const c: WorkflowContract = def.contract;
    const kind = input.kind ?? prior?.kind ?? "schedule";
    let spec: store.ScheduleSpecRow;
    let poll: store.PollRow | null = null;
    let defaults: Record<string, unknown> = {};
    if (kind === "poll") {
      const t = c.triggers.find((x) => x.kind === "poll");
      if (t?.kind !== "poll") throw new EngineError("validation_failed", `Version ${def.version} of ${workflowId} has no poll trigger.`, 422);
      poll = { product: t.product, op: t.op, input: (t.input ?? {}) as Record<string, unknown>, cursorPath: t.cursorPath };
      spec = { every: input.every ?? t.every, timezone: input.timezone ?? prior?.spec.timezone ?? "UTC" };
      if (input.cron) throw new EngineError("validation_failed", "A poll schedule runs every <interval>; cron is for kind schedule.", 422);
    } else {
      const t = c.triggers.find((x) => x.kind === "schedule");
      const cron = input.cron ?? (input.every ? undefined : (prior?.spec.cron ?? (t?.kind === "schedule" ? t.cron : undefined)));
      const every = input.every ?? (input.cron ? undefined : (prior?.spec.every ?? (t?.kind === "schedule" && !cron ? t.every : undefined)));
      if ((cron === undefined) === (every === undefined)) throw new EngineError("validation_failed", "Give cron or every (not both), or put a schedule trigger in the contract.", 422);
      const timezone = input.timezone ?? prior?.spec.timezone ?? (t?.kind === "schedule" ? t.timezone : undefined);
      if (!timezone) throw new EngineError("validation_failed", "Give an IANA time zone, for example Asia/Bangkok.", 422);
      spec = { timezone, ...(cron !== undefined ? { cron } : {}), ...(every !== undefined ? { every } : {}) };
      if (t?.kind === "schedule") defaults = (t.input ?? {}) as Record<string, unknown>;
    }
    try {
      nextCronTime(spec.cron ?? "* * * * *", Date.now(), { tz: spec.timezone });
    } catch (e) {
      throw new EngineError("validation_failed", e instanceof Error ? e.message : "Bad cron or time zone.", 422);
    }
    const inputObj = { ...defaults, ...(prior ? prior.input : {}), ...((input.input ?? {}) as Record<string, unknown>) };
    const v = validateAgainstSchema((c.inputs ?? { type: "object", additionalProperties: false }) as never, inputObj as never);
    if (!v.ok) throw new EngineError("validation_failed", `The schedule input does not fit the workflow inputs: ${v.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`, 422);
    return { workflowId, versionPin, kind, spec, input: inputObj, poll, overlap: input.overlap ?? prior?.overlap ?? "skip", paused: input.paused ?? prior?.paused ?? false };
  }

  async function ioOf(temporalWorkflowId: string): Promise<Awaited<ReturnType<typeof readStepIo>>> {
    const t = await getTemporal();
    return t.connected ? readStepIo(t.client, temporalWorkflowId) : null;
  }

  async function mustTemporal(): Promise<Awaited<ReturnType<typeof getTemporal>>> {
    const t = await getTemporal();
    if (!t.connected) throw new EngineError("temporal_unavailable", "The workflow engine (Temporal) does not answer. Try again in a minute.", 503);
    return t;
  }

  return {
    [OP.workflowContractValidate]: eop<K.WorkflowContractValidateInput, K.WorkflowContractValidateOutput>({
      redact: (_i, o) => (o ? `Checked a contract: ${o.ok ? "valid" : `${o.errors.length} error(s)`}` : "Checked a contract"),
      async run(input, ctx) {
        let contract: unknown = input.contract;
        if (contract === undefined) {
          if (!input.workflowId || input.version === undefined) throw new EngineError("validation_failed", "Give the contract, or workflowId and version of a saved one.", 422);
          contract = mustDefinition(ctx, input.workflowId, input.version).contract;
        }
        let r = validate(ctx, contract);
        // F-G2: the ops of the child workflows count here as they do at activation; a child that is not active is listed as a dependency
        if (r.ok) {
          const dep = withChildUses(ctx.db, contract as WorkflowContract, r.uses);
          const notes: ValidationIssue[] = dep.inactive.map((d) => ({
            severity: "warning",
            code: "child_not_active",
            path: `${d.path}/workflow`,
            message: `Step ${d.stepId} starts the workflow ${d.workflow}${d.version !== undefined ? ` version ${d.version}` : ""}, which is not active. Its operations are not in this list yet; activate it first, or activation of this version is refused.`,
            stepId: d.stepId,
          }));
          r = { ...r, uses: dep.uses, warnings: [...r.warnings, ...notes] };
        }
        const id = (contract as { id?: unknown } | null)?.id;
        const active = typeof id === "string" ? (store.activeActivation(ctx.db, id)?.version ?? null) : null;
        return withAliases(r, active) as unknown as K.WorkflowContractValidateOutput;
      },
    }),
    [OP.workflowContractSave]: eop<K.WorkflowContractSaveInput, K.WorkflowContractSaveOutput>({
      redact: (_i, o) => (o ? `Saved ${o.workflowId} v${o.version}` : "Saved a contract version"),
      async run(input, ctx) {
        const r = validate(ctx, input.contract);
        if (!r.ok) failValidation(r);
        const c = input.contract as unknown as WorkflowContract;
        const { definition, created } = store.saveDefinition(ctx.db, c, Date.now());
        return { workflowId: definition.workflowId, version: definition.version, digest: definition.digest, created, warnings: r.warnings } as K.WorkflowContractSaveOutput;
      },
    }),
    [OP.workflowContractsList]: eop<K.WorkflowContractsListInput, K.WorkflowContractsListOutput>({
      async run(input, ctx) {
        const all = store.listDefinitions(ctx.db);
        return { contracts: (input.workflowId ? all.filter((d) => d.workflowId === input.workflowId) : all).slice(0, 500) } as K.WorkflowContractsListOutput;
      },
    }),
    [OP.workflowContractGet]: eop<K.WorkflowContractGetInput, K.WorkflowContractGetOutput>({
      async run(input, ctx) {
        const d = mustDefinition(ctx, input.workflowId, input.version);
        return { workflowId: d.workflowId, version: d.version, title: d.title, digest: d.digest, createdAt: d.createdAt, contract: d.contract as unknown as Record<string, unknown>, activation: store.getActivation(ctx.db, d.workflowId, d.version) as unknown as Record<string, unknown> | null } as K.WorkflowContractGetOutput;
      },
    }),
    [OP.workflowActivate]: eop<K.WorkflowActivateInput, K.WorkflowActivateOutput>({
      redact: (i, o) => `Activated ${i.workflowId} v${i.version}${o ? ` (${o.ops.length} operation(s))` : ""}`,
      async run(input, ctx) {
        const d = mustDefinition(ctx, input.workflowId, input.version);
        // M3 rule: a migrated 0.3.x workflow whose agent is the placeholder is never activated (the owner picks the agent first)
        walkSteps(d.contract.steps, (s) => {
          if (s.type === "ai" && "agent" in s.by && s.by.agent === UNASSIGNED_AGENT) throw new EngineError("agent_unassigned", `Step ${s.id} still names the placeholder agent. Choose the agent in the editor, save the new version and activate that.`, 422);
        });
        const r = validate(ctx, d.contract);
        if (!r.ok) failValidation(r);
        // F4: a workflow step starts another workflow: the child must be ACTIVE now, and its ops are part of what the owner approves
        const dep = withChildUses(ctx.db, d.contract, r.uses);
        const first = dep.inactive[0];
        if (first) throw new EngineError("child_not_active", `The workflow ${first.workflow}${first.version !== undefined ? ` version ${first.version}` : ""} (step ${first.stepId}) is not active. Activate it first.`, 409);
        const uses = dep.uses;
        const { activation, previous } = store.activate(ctx.db, d.workflowId, d.version, uses, Date.now());
        const crud: Record<string, string[]> = {};
        for (const u of uses) crud[u.product] = [...new Set([...(crud[u.product] ?? []), ...u.crud])].sort();
        const scopes = [...new Map(uses.filter((u) => u.scopeType).map((u) => [`${u.product}/${u.scopeType}`, { product: u.product, scopeType: u.scopeType as string }])).values()];
        const staleSchedules = await revalidateSchedules(ctx, d.workflowId);
        void refreshRoleAttention().then(() => (ctx as Partial<OpContext>).statusChanged?.(), () => undefined);
        return { workflowId: d.workflowId, version: d.version, previousVersion: previous, activatedAt: activation.activatedAt, ops: uses, activeVersion: d.version, usage: usageRows(uses), crud, scopes, staleSchedules, warnings: r.warnings as ValidationIssue[], notice: GRANT_NOTICE } as unknown as K.WorkflowActivateOutput;
      },
    }),
    [OP.workflowDeactivate]: eop<K.WorkflowDeactivateInput, K.WorkflowDeactivateOutput>({
      redact: (i) => `Deactivated ${i.workflowId}`,
      async run(input, ctx) {
        const versions = store.deactivate(ctx.db, input.workflowId, Date.now());
        void refreshRoleAttention().then(() => (ctx as Partial<OpContext>).statusChanged?.(), () => undefined);
        let paused = 0;
        const t = await getTemporal();
        for (const s of store.listSchedules(ctx.db, input.workflowId)) {
          if (s.paused) continue;
          store.updateSchedule(ctx.db, s.id, s.revision, { paused: true }, Date.now());
          if (t.connected) {
            try {
              await pauseSchedule(t.client, s.id, true, "The workflow was deactivated.");
            } catch (e) {
              ctx.log.warn("pause on deactivate failed", { id: s.id, error: e instanceof Error ? e.message : String(e) });
            }
          }
          paused++;
        }
        return { workflowId: input.workflowId, deactivatedVersions: versions, schedulesPaused: paused };
      },
    }),
    [OP.scheduleSet]: eop<K.ScheduleSetInput, K.ScheduleSetOutput>({
      redact: (i) => `Schedule ${i.id ?? "new"} for ${i.workflowId}`,
      async run(input, ctx) {
        const now = Date.now();
        let row: store.ScheduleRow;
        if (input.id) {
          const prior = store.getSchedule(ctx.db, input.id);
          if (!prior) throw new EngineError("not_found", "No schedule with this id.", 404);
          if (input.revision === undefined) throw new EngineError("validation_failed", "Give the revision of the schedule you edit.", 422);
          const n = resolveSchedule(ctx, input, prior);
          row = store.updateSchedule(ctx.db, prior.id, input.revision, { versionPin: n.versionPin, spec: n.spec, input: n.input, poll: n.poll, overlap: n.overlap, paused: n.paused }, now);
        } else {
          const n = resolveSchedule(ctx, input, null);
          row = store.insertSchedule(ctx.db, { id: store.newScheduleId(now), ...n }, now);
        }
        if (row.staleReason) store.setStale(ctx.db, row.id, null, now);
        return viewOf(ctx.db, await pushToTemporal(ctx, store.getSchedule(ctx.db, row.id) as store.ScheduleRow));
      },
    }),
    [OP.schedulePause]: eop<K.SchedulePauseInput, K.SchedulePauseOutput>({
      redact: (i) => `Schedule ${i.id}: ${i.paused ? "paused" : "resumed"}`,
      async run(input, ctx) {
        const prior = store.getSchedule(ctx.db, input.id);
        if (!prior) throw new EngineError("not_found", "No schedule with this id.", 404);
        const row = store.updateSchedule(ctx.db, input.id, input.revision, { paused: input.paused }, Date.now());
        const t = await getTemporal();
        if (t.connected) {
          try {
            await pauseSchedule(t.client, row.id, input.paused);
            store.setScheduleSync(ctx.db, row.id, "synced", null, Date.now());
          } catch {
            await pushToTemporal(ctx, row);
          }
        } else store.setScheduleSync(ctx.db, row.id, "pending", "Temporal does not answer; the state is applied when it does.", Date.now());
        return viewOf(ctx.db, store.getSchedule(ctx.db, row.id) as store.ScheduleRow);
      },
    }),
    [OP.scheduleRunNow]: eop<K.ScheduleRunNowInput, K.ScheduleRunNowOutput>({
      redact: (i) => `Run schedule ${i.id} now`,
      async run(input, ctx) {
        const row = store.getSchedule(ctx.db, input.id);
        if (!row) throw new EngineError("not_found", "No schedule with this id.", 404);
        if (!store.activeActivation(ctx.db, row.workflowId)) throw new EngineError("not_activated", `${row.workflowId} has no active version.`, 409);
        const t = await mustTemporal();
        // S3 / F-G6: a deliberate click starts its own run (the id comes from the request's idempotency key) and the answer names it
        const runId = runNowId(row.id, ctx.idempotencyKey ?? null);
        try {
          await runScheduleNow(t.client, row, runId, scheduleTimeoutMs(ctx.db, row));
        } catch (e) {
          throw new EngineError("temporal_failed", `Temporal refused the run: ${e instanceof Error ? e.message : String(e)}`, 502);
        }
        return { id: row.id, triggered: true, runId, workflowId: row.workflowId };
      },
    }),
    [OP.scheduleDelete]: eop<K.ScheduleDeleteInput, K.ScheduleDeleteOutput>({
      redact: (i) => `Schedule ${i.id}: deleted`,
      async run(input, ctx) {
        const row = store.getSchedule(ctx.db, input.id);
        if (!row) throw new EngineError("not_found", "No schedule with this id.", 404);
        if (row.revision !== input.revision) throw new EngineError("revision_conflict", `The schedule changed (revision ${row.revision}). Reload it and try again.`, 409, { revision: row.revision });
        // Temporal first: a schedule that stays in Temporal would keep starting runs
        const t = await mustTemporal();
        await deleteSchedule(t.client, row.id);
        store.markScheduleDeleted(ctx.db, row.id, Date.now());
        return { id: row.id, deleted: true };
      },
    }),
    [OP.schedulesList]: eop<K.SchedulesListInput, K.SchedulesListOutput>({
      async run(input, ctx) {
        const rows = store.listSchedules(ctx.db, input.workflowId).slice(0, 500);
        const t = await getTemporal();
        const lives = await Promise.all(rows.map((r) => (t.connected ? describeSchedule(t.client, r.id) : Promise.resolve<ScheduleLive>({ state: "unreachable", paused: null, nextRunAt: null, lastRunAt: null, lastRunWorkflowId: null, runningCount: 0, timezone: null, note: null }))));
        return { schedules: await Promise.all(rows.map((r, i) => viewOf(ctx.db, r, lives[i] ?? null))), temporalConnected: t.connected } as unknown as K.SchedulesListOutput;
      },
    }),
    [OP.workflowRunNow]: eop<K.WorkflowRunNowInput, K.WorkflowRunNowOutput>({
      redact: (i) => `Run ${i.workflowId} now`,
      async run(input, ctx) {
        const act = input.version === undefined || input.version === null ? store.activeActivation(ctx.db, input.workflowId) : store.getActivation(ctx.db, input.workflowId, input.version);
        if (!act || act.state === "deactivated") throw new EngineError("not_activated", `${input.workflowId} has no activated version${input.version ? ` ${input.version}` : ""}. Activate one first.`, 409);
        const def = mustDefinition(ctx, input.workflowId, act.version);
        const inputs = (input.inputs ?? {}) as Record<string, Json>;
        const merged = { ...(def.contract.triggers.flatMap((t) => (t.kind === "manual" ? [t.inputs ?? {}] : []))[0] ?? {}), ...inputs };
        const v = validateAgainstSchema((def.contract.inputs ?? { type: "object", additionalProperties: false }) as never, merged as never);
        if (!v.ok) throw new EngineError("validation_failed", `The run inputs do not fit the workflow inputs: ${v.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`, 422);
        await mustTemporal();
        const started = await startRun({ workflowId: input.workflowId, version: act.version, input: inputs, maxRunMinutes: def.contract.limits?.maxRunMinutes });
        return { runId: started.runId, workflowId: input.workflowId, version: act.version, temporalWorkflowId: started.temporalWorkflowId };
      },
    }),
    [OP.engineRunsList]: eop<K.EngineRunsListInput, K.EngineRunsListOutput>({
      async run(input, ctx) {
        return { runs: store.listRuns(ctx.db, { ...(input.workflowId ? { workflowId: input.workflowId } : {}), ...(input.version !== undefined ? { version: input.version } : {}), ...(input.status ? { status: input.status } : {}), ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}), limit: input.limit ?? 50 }) } as unknown as K.EngineRunsListOutput;
      },
    }),
    [OP.engineRunGet]: eop<K.EngineRunGetInput, K.EngineRunGetOutput>({
      async run(input, ctx) {
        const workflowId = input.workflowId ?? store.workflowOfRun(ctx.db, input.runId);
        const r = workflowId ? store.getRun(ctx.db, workflowId, input.runId) : null;
        if (!r) throw new EngineError("not_found", "No run with this id.", 404);
        let outputs: Record<string, Json> | null = null;
        if (r.run.status === "completed") {
          const t = await getTemporal();
          if (t.connected) {
            const res = await Promise.race([t.client.workflow.getHandle(r.run.temporalWorkflowId).result().catch(() => null), new Promise<null>((ok) => setTimeout(() => ok(null), 2000))]);
            const o = (res as { outputs?: Record<string, Json> } | null)?.outputs;
            if (o && typeof o === "object") outputs = o;
          }
        }
        // the stage label of each step comes from the contract version the run used
        const stages = new Map<string, string>();
        const def = r.run.version === null ? null : store.getDefinition(ctx.db, r.run.workflowId, r.run.version);
        if (def) walkSteps(def.contract.steps, (s) => (s.stage ? stages.set(s.id, s.stage) : undefined));
        // C88: what each step got and gave comes from the Temporal history, only for the owner, never from app.db
        const io = await ioOf(r.run.temporalWorkflowId);
        const steps = r.steps.map((s) => ({ ...s, attempt: s.attempts, stage: stages.get(s.stepId) ?? null, ...(io?.[s.stepKey] ?? {}) }));
        return { run: r.run, steps, outputs } as unknown as K.EngineRunGetOutput;
      },
    }),
  };
}
