// Owner operations of the workflow engine (WP2): contract check/save/list/get, activation, schedules, run index.
// All are person ops (the workspace owner only, C88): they return inputs/outputs-adjacent data of other apps' calls only in
// the run detail, never to an agent. `engineHandlers(manifest)` is spread into the handler map of src/app.ts.
import { nextCronTime, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { type HandlerSpec, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { OP } from "#kit";
import { type WorkflowContract, walkSteps } from "./contract.ts";
import * as store from "./engine-store.ts";
import { EngineError } from "./errors.ts";
import type { Json } from "./json.ts";
import { deleteSchedule, describeSchedule, pauseSchedule, type ScheduleLive, syncAndRecord, triggerSchedule } from "./schedules.ts";
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
  return uses.map((u) => ({ product: u.product, op: u.op, crud: u.crud, effect: u.effect, scope: u.scopeType ?? null, held: u.holdFamily !== undefined, ...(u.tools ? { tools: u.tools } : {}) }));
}

export function engineHandlers(manifest: { companions?: Companions }) {
  const companions: Companions = manifest.companions ?? [];

  function validate(ctx: OpContext, contract: unknown): ValidationResult {
    return validateContract(contract, {
      companions,
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

  async function viewOf(row: store.ScheduleRow, live?: ScheduleLive | null): Promise<K.ScheduleSetOutput> {
    let l: ScheduleLive | null = live ?? null;
    if (l === null && live === undefined) {
      const t = await getTemporal();
      l = t.connected ? await describeSchedule(t.client, row.id) : { state: "unreachable", paused: null, nextRunAt: null, lastRunAt: null, lastRunWorkflowId: null, runningCount: 0, timezone: null, note: null };
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
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      live: l,
    } as K.ScheduleSetOutput;
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

  function resolveSchedule(ctx: OpContext, input: K.ScheduleSetInput, prior: store.ScheduleRow | null): Omit<store.ScheduleRow, "revision" | "cursor" | "cursorAt" | "temporalState" | "temporalError" | "createdAt" | "updatedAt" | "id"> {
    const workflowId = prior?.workflowId ?? input.workflowId;
    if (prior && input.workflowId !== prior.workflowId) throw new EngineError("validation_failed", "A schedule keeps its workflow. Create a new schedule for another workflow.", 422);
    const act = store.activeActivation(ctx.db, workflowId);
    if (!act) throw new EngineError("not_activated", `${workflowId} has no active version. Activate a version before you schedule it.`, 409);
    const versionPin = input.versionPin === undefined ? (prior?.versionPin ?? null) : input.versionPin;
    if (versionPin !== null) {
      const a = store.getActivation(ctx.db, workflowId, versionPin);
      if (!a || a.state === "deactivated") throw new EngineError("not_activated", `Version ${versionPin} of ${workflowId} is not activated.`, 409);
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
        const r = validate(ctx, contract);
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
        const r = validate(ctx, d.contract);
        if (!r.ok) failValidation(r);
        const { activation, previous } = store.activate(ctx.db, d.workflowId, d.version, r.uses, Date.now());
        const crud: Record<string, string[]> = {};
        for (const u of r.uses) crud[u.product] = [...new Set([...(crud[u.product] ?? []), ...u.crud])].sort();
        const scopes = [...new Map(r.uses.filter((u) => u.scopeType).map((u) => [`${u.product}/${u.scopeType}`, { product: u.product, scopeType: u.scopeType as string }])).values()];
        return { workflowId: d.workflowId, version: d.version, previousVersion: previous, activatedAt: activation.activatedAt, ops: r.uses as OpUse[], activeVersion: d.version, usage: usageRows(r.uses), crud, scopes, warnings: r.warnings as ValidationIssue[], notice: GRANT_NOTICE } as unknown as K.WorkflowActivateOutput;
      },
    }),
    [OP.workflowDeactivate]: eop<K.WorkflowDeactivateInput, K.WorkflowDeactivateOutput>({
      redact: (i) => `Deactivated ${i.workflowId}`,
      async run(input, ctx) {
        const versions = store.deactivate(ctx.db, input.workflowId, Date.now());
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
        return viewOf(await pushToTemporal(ctx, row));
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
        return viewOf(store.getSchedule(ctx.db, row.id) as store.ScheduleRow);
      },
    }),
    [OP.scheduleRunNow]: eop<K.ScheduleRunNowInput, K.ScheduleRunNowOutput>({
      redact: (i) => `Run schedule ${i.id} now`,
      async run(input, ctx) {
        const row = store.getSchedule(ctx.db, input.id);
        if (!row) throw new EngineError("not_found", "No schedule with this id.", 404);
        if (!store.activeActivation(ctx.db, row.workflowId)) throw new EngineError("not_activated", `${row.workflowId} has no active version.`, 409);
        const t = await mustTemporal();
        try {
          await triggerSchedule(t.client, row.id);
        } catch (first) {
          // the schedule may be missing in Temporal (a restored database): create it from the row and try once more
          try {
            await syncAndRecord(ctx.db, t.client, row, Date.now());
            await triggerSchedule(t.client, row.id);
          } catch (e) {
            throw new EngineError("temporal_failed", `Temporal refused the run: ${e instanceof Error ? e.message : String(first)}`, 502);
          }
        }
        return { id: row.id, triggered: true };
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
        return { schedules: await Promise.all(rows.map((r, i) => viewOf(r, lives[i] ?? null))), temporalConnected: t.connected } as unknown as K.SchedulesListOutput;
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
        const steps = r.steps.map((s) => ({ ...s, attempt: s.attempts, stage: stages.get(s.stepId) ?? null }));
        return { run: r.run, steps, outputs } as unknown as K.EngineRunGetOutput;
      },
    }),
  };
}
