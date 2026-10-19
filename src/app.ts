// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, holds, idempotency, backups and status from it. This file registers exactly one handler per
// manifest operation id. Op ids and input/output types come from the kit that `tb-gen kit` generates from the
// manifest (`#kit`, built by `node --run kit`); none is written by hand.
//
// Audiences: agents suggest and read (their own suggestions, any promoted workflow); everything that decides,
// edits, promotes or exports is a person op, so only the workspace owner can do it (SDK-API §5).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AppDefinition, type Caller, type Db, defineApp, type HandlerSpec, type OpContext, type SdkAppDefinition, type SdkOpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { OP, type OpId } from "#kit";
import * as cycles from "./cycles.ts";
import { DEFAULT_MIN_REPEATS, KANBAN } from "./detector.ts";
import { ALLOWLIST_NOTICE, allowedFromSteps, diffNotice, diffSnapshots, ModelError, type Snapshot } from "./model.ts";
import * as pipeline from "./pipeline.ts";
import { buildRecipe } from "./recipe.ts";
import * as routines from "./routines.ts";
import { createDetectorRefresh, DETECTOR_REFRESH_MS, detectorStatus, scanKanban } from "./scan.ts";
import * as store from "./store.ts";
import { TEMPLATES } from "./templates.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  const run = spec.run;
  // Store/model refusals become the CORE §8 envelope (404 / 409 / 422) instead of a 500.
  return {
    ...spec,
    run: async (input: I, ctx: OpContext) => {
      try {
        return await run(input, ctx);
      } catch (e) {
        throw toTbError(e);
      }
    },
  } as unknown as HandlerSpec;
}

const STATUS: Record<store.StoreError["code"], number> = { not_found: 404, conflict: 409, revision_conflict: 409, validation_failed: 422, kanban_project_required: 422, metrics_need_terminal_status: 422, metric_names_full: 422, pipeline_id_mismatch: 409, confirm_replace_required: 409, contract_too_large: 422, metric_not_declared: 422 };
export function toTbError(e: unknown): unknown {
  if (e instanceof store.StoreError) return new TbError(e.code, e.message, STATUS[e.code], e.details);
  if (e instanceof ModelError) return new TbError("validation_failed", e.message, 422, { pointer: e.pointer });
  return e;
}

function actorOf(c: Caller): store.Actor {
  return { type: c.type, id: c.id, name: c.type === "person" ? "Owner" : c.name || c.id };
}


// C88 / L12: data Evolution read with ITS OWN companion grant (Kanban issue titles, the text built from them) is shown
// only to the owner (person ops). An agent sees a detector suggestion only as ids and fixed text: it may not have
// access to the Kanban project those issues are in. Evidence an agent supplied itself carries no title anyway.
export const DETECTOR_AGENT_TITLE = "Repeated Kanban work could become a workflow";
export const DETECTOR_AGENT_SUMMARY =
  "Evolution found finished Kanban work of yours that repeats. The owner reviews the details; the evidence below is listed by issue id only.";

export function agentView(s: store.Suggestion): store.Suggestion {
  const evidence = s.evidence.map((e) => ({ ...e, title: null, note: s.source === "detector" ? null : e.note }));
  return s.source === "detector" ? { ...s, title: DETECTOR_AGENT_TITLE, summary: DETECTOR_AGENT_SUMMARY, evidence } : { ...s, evidence };
}

/** An agent sees only suggestions it made or that are about its own work. */
function visibleTo(s: store.Suggestion, c: Caller): boolean {
  return s.createdBy.id === c.id || s.agentId === c.id;
}

/** Draft text from an approved suggestion (v1: draft created from a suggestion keeps its source). */
export function snapshotFromSuggestion(s: store.Suggestion): Snapshot {
  const title = s.title.replace(/^Make a workflow for "(.*)"$/, "$1").slice(0, 200);
  return {
    title,
    summary: s.summary,
    instruction: s.steps.length ? `Do "${title}" as the owner reviewed it. Follow the steps below and use only the allowed operations.` : "",
    trigger: "",
    steps: s.steps,
    allowed: allowedFromSteps(s.steps),
  };
}

// ── Kanban run issues (step B): Evolution records every claimed run as one Kanban issue ASSIGNED to the Bound agent
// (template = the workflow's run key), and closes it on the run's terminal report. Kanban is optional: a failed
// companion call never fails a claim or a report; the run then shows kanbanSync "failed".
type CallApp = OpContext["callApp"];

function issueIdOf(output: unknown): string | null {
  const o = (output && typeof output === "object" ? output : {}) as Record<string, unknown>;
  const v = o.id ?? (o.issue && typeof o.issue === "object" ? (o.issue as Record<string, unknown>).id : undefined);
  return typeof v === "string" && v ? v : null;
}

export async function createRunIssue(
  db: Db,
  callApp: CallApp,
  job: routines.ClaimedJob,
  automation: routines.Automation,
  agentId: string,
): Promise<string | null> {
  const input: Record<string, unknown> = {
    title: `Run: ${job.title} (${job.dueAt.slice(0, 16).replace("T", " ")} UTC)`.slice(0, 200),
    summary: `Scheduled run of the Evolution workflow ${job.workflowId} v${job.version} (occurrence ${job.occurrence.slice(0, 12)}). ${job.instruction}`.slice(0, 4000),
    status: "in_progress",
    assignee: agentId,
    template: routines.runTemplateKey(job.workflowId),
    ...(automation.kanbanProject ? { project: automation.kanbanProject } : {}),
  };
  try {
    const r = await callApp(KANBAN.product, "issue_create", input as never, { idempotencyKey: `evolution-run:${job.occurrence}` });
    const id = r.status === "ok" ? issueIdOf(r.output) : null;
    routines.setKanban(db, job.occurrence, id, id ? "none" : "failed");
    return id;
  } catch {
    routines.setKanban(db, job.occurrence, null, "failed");
    return null;
  }
}

export async function closeRunIssue(db: Db, callApp: CallApp, run: routines.Run): Promise<void> {
  if (!run.kanbanIssueId || !routines.TERMINAL.has(run.status)) return;
  const text = (run.summary ?? "").trim();
  const [op, input] =
    run.status === "completed"
      ? ["issue_complete", { issue: run.kanbanIssueId, result: (text || "Run completed.").slice(0, 4000) }]
      : ["issue_block", { issue: run.kanbanIssueId, reason: `Run ${run.status}${text ? `: ${text}` : "."}`.slice(0, 1000) }];
  try {
    const r = await callApp(KANBAN.product, op, input as never, { idempotencyKey: `evolution-close:${run.occurrence}:${run.status}` });
    routines.setKanban(db, run.occurrence, null, r.status === "ok" ? "done" : "failed");
  } catch {
    routines.setKanban(db, run.occurrence, null, "failed");
  }
}

/** Closes Kanban issues of runs that ended without a report (swept to uncertain) — a few per write call. */
async function flushKanban(db: Db, callApp: CallApp): Promise<void> {
  for (const run of routines.pendingKanban(db, 5)) await closeRunIssue(db, callApp, run);
}

/** Evolution has a companion grant for Task Board in this workspace (the verified slice's companionTargets). */
export function kanbanLinked(ctx: OpContext): boolean {
  const targets = (ctx as Partial<SdkOpContext>).companionTargets;
  return typeof targets === "function" && targets.call(ctx).includes(KANBAN.product);
}

function automationView(db: Db, id: string, opts: routines.SetOptions): routines.AutomationView {
  const a = routines.listAutomations(db, Date.now(), opts).find((x) => x.id === id);
  if (!a) throw new store.StoreError("not_found", "No schedule with this id.");
  return a;
}

export const handlers = {
  // ── agent ──
  [OP.suggestionCreate]: op<K.SuggestionCreateInput, K.SuggestionCreateOutput>({
    // Idempotency (manifest "required") is the SDK's: a repeated key returns the stored result without calling run.
    redact: (input) => `Suggested "${input.title.slice(0, 120)}" with ${input.evidence.length} evidence reference(s)`,
    async run(input, ctx) {
      return store.createSuggestion(ctx.db, {
        title: input.title,
        summary: input.summary ?? "",
        source: "agent",
        agentId: ctx.caller.type === "agent" ? ctx.caller.id : null,
        createdBy: actorOf(ctx.caller),
        evidence: input.evidence.map((e) => ({ kind: e.kind, ref: e.ref, product: e.product ?? (e.kind === "kanban_issue" ? KANBAN.product : null), note: e.note ?? null, title: null })),
        steps: input.steps ?? [],
      });
    },
  }),
  [OP.suggestionsList]: op<K.SuggestionsListInput, K.SuggestionsListOutput>({
    async run(input, ctx) {
      return { suggestions: store.listSuggestions(ctx.db, { status: input.status, agentId: ctx.caller.id, limit: input.limit ?? 50 }).map((x) => store.toRow(agentView(x))) };
    },
  }),
  [OP.suggestionGet]: op<K.SuggestionGetInput, K.SuggestionGetOutput>({
    async run(input, ctx) {
      const s = store.getSuggestion(ctx.db, input.id);
      if (!visibleTo(s, ctx.caller)) throw new store.StoreError("not_found", "No suggestion with this id.");
      return agentView(s);
    },
  }),
  [OP.workflowGet]: op<K.WorkflowGetInput, K.WorkflowGetOutput>({
    async run(input, ctx) {
      return { ...store.getVersion(ctx.db, input.id, input.version), notice: ALLOWLIST_NOTICE };
    },
  }),

  [OP.routinesDue]: op<K.RoutinesDueInput, K.RoutinesDueOutput>({
    // The poll target of `tealbrick agent serve` routines mode. No receipt and no decision: it only books what the clock
    // and the policy gate imply (missed and policy_stale periods), the same bookkeeping the owner's lists do.
    async run(_input, ctx) {
      if (ctx.caller.type !== "agent" || ctx.caller.mode !== "bound") return { jobs: [] };
      return { jobs: routines.dueJobs(ctx.db, ctx.caller.id) };
    },
  }),
  [OP.routineClaim]: op<K.RoutineClaimInput, K.RoutineClaimOutput>({
    redact: (input, output) => `Claim ${input.occurrence.slice(0, 12)}: ${output ? (output.claimed ? "claimed" : output.reason) : "?"}`,
    async run(input, ctx) {
      const callApp = ctx.callApp.bind(ctx);
      const r = routines.claim(ctx.db, { id: ctx.caller.id, mode: ctx.caller.type === "agent" ? ctx.caller.mode : null }, input.occurrence);
      if (!r.claimed) {
        await flushKanban(ctx.db, callApp);
        return { claimed: false, reason: r.reason, job: null };
      }
      const kanbanIssueId = await createRunIssue(ctx.db, callApp, r.job, r.automation, ctx.caller.id);
      await flushKanban(ctx.db, callApp);
      return { claimed: true, reason: null, job: { ...r.job, kanbanIssueId, kanbanTemplate: routines.runTemplateKey(r.job.workflowId) } };
    },
  }),
  [OP.routineReport]: op<K.RoutineReportInput, K.RoutineReportOutput>({
    // never the metrics themselves: lessons are free text from the agent (C88 / L12)
    redact: (input) => `Run ${input.occurrence.slice(0, 12)}: ${input.status}${input.metrics ? " (with metrics)" : ""}`,
    async run(input, ctx) {
      const callApp = ctx.callApp.bind(ctx);
      const { run, changed } = routines.report(ctx.db, ctx.caller.id, input.occurrence, input.status, input.summary?.trim() || null, Date.now(), input.metrics ?? null, (workflowId, version) => (version === null ? null : pipeline.declaredMetrics(ctx.db, workflowId, version)));
      if (changed) await closeRunIssue(ctx.db, callApp, run);
      await flushKanban(ctx.db, callApp);
      return routines.getRun(ctx.db, input.occurrence) ?? run;
    },
  }),

  // ── person (owner) ──
  [OP.reviewSuggestions]: op<K.ReviewSuggestionsInput, K.ReviewSuggestionsOutput>({
    async run(input, ctx) {
      return { suggestions: store.listSuggestions(ctx.db, { status: input.status, limit: input.limit ?? 100 }).map(store.toRow) };
    },
  }),
  [OP.reviewSuggestion]: op<K.ReviewSuggestionInput, K.ReviewSuggestionOutput>({
    async run(input, ctx) {
      const suggestion = store.getSuggestion(ctx.db, input.id);
      const drafts = store.listDrafts(ctx.db, { suggestionId: input.id }).map(draftRow);
      return { suggestion, events: store.suggestionEvents(ctx.db, input.id), drafts };
    },
  }),
  [OP.suggestionDecide]: op<K.SuggestionDecideInput, K.SuggestionDecideOutput>({
    redact: (input) => `Suggestion ${input.id}: ${input.decision}`,
    async run(input, ctx) {
      return store.decideSuggestion(ctx.db, input.id, input.decision, actorOf(ctx.caller), input.note?.trim() || null);
    },
  }),
  [OP.detectorScan]: op<K.DetectorScanInput, K.DetectorScanOutput>({
    redact: (_input, output) => (output ? `Kanban scan: ${output.kanban}, ${output.created.length} new, ${output.updated.length} updated` : "Kanban scan"),
    async run(input, ctx) {
      return scanKanban(ctx.db, ctx.callApp.bind(ctx), input.minRepeats ?? DEFAULT_MIN_REPEATS, "owner");
    },
  }),
  [OP.detectorStatus]: op<K.DetectorStatusInput, K.DetectorStatusOutput>({
    async run(_input, ctx) {
      return { ...detectorStatus(ctx.db), intervalMinutes: DETECTOR_REFRESH_MS / 60_000 };
    },
  }),
  [OP.templatesList]: op<K.TemplatesListInput, K.TemplatesListOutput>({
    async run() {
      return { templates: TEMPLATES.map((t) => structuredClone(t)) };
    },
  }),
  [OP.draftCreate]: op<K.DraftCreateInput, K.DraftCreateOutput>({
    redact: (input) => `Draft from ${input.suggestionId ? `suggestion ${input.suggestionId}` : input.templateId ? `template ${input.templateId}` : "scratch"}`,
    async run(input, ctx) {
      if (input.suggestionId && input.templateId) throw new store.StoreError("validation_failed", "Start a draft from a suggestion or from a template, not both.");
      let snapshot: Snapshot;
      if (input.suggestionId) {
        const s = store.getSuggestion(ctx.db, input.suggestionId);
        if (s.status !== "approved") throw new store.StoreError("conflict", "Approve the suggestion before you draft a workflow from it.", { status: s.status });
        snapshot = snapshotFromSuggestion(s);
      } else if (input.templateId) {
        const t = TEMPLATES.find((x) => x.id === input.templateId);
        if (!t) throw new store.StoreError("not_found", "No template with this id.");
        const { id: _id, ...snap } = structuredClone(t);
        snapshot = snap;
      } else snapshot = { title: "New workflow", summary: "", instruction: "", trigger: "", steps: [], allowed: [] };
      if (input.title) snapshot.title = input.title;
      return store.createDraft(ctx.db, { suggestionId: input.suggestionId ?? null, templateId: input.templateId ?? null, snapshot });
    },
  }),
  [OP.draftsList]: op<K.DraftsListInput, K.DraftsListOutput>({
    async run(_input, ctx) {
      return { drafts: store.listDrafts(ctx.db).map(draftRow) };
    },
  }),
  [OP.draftGet]: op<K.DraftGetInput, K.DraftGetOutput>({
    async run(input, ctx) {
      return { ...store.getDraft(ctx.db, input.id), pipeline: pipeline.pipelineOfDraft(ctx.db, input.id) };
    },
  }),
  [OP.draftUpdate]: op<K.DraftUpdateInput, K.DraftUpdateOutput>({
    redact: (input) => `Draft ${input.id} edited (revision ${input.revision})`,
    async run(input, ctx) {
      const { id, revision, ...patch } = input;
      return store.updateDraft(ctx.db, id, revision, patch);
    },
  }),
  [OP.workflowPromote]: op<K.WorkflowPromoteInput, K.WorkflowPromoteOutput>({
    redact: (input, output) => (output ? `Promoted draft ${input.draftId} to ${output.workflow.id} v${output.version.version}` : `Promote draft ${input.draftId}`),
    async run(input, ctx) {
      return store.promote(ctx.db, input.draftId, input.revision, Date.now(), { log: ctx.log });
    },
  }),
  // ── typed pipeline contract (C288 R10): person ops only; the stored contract is never returned by an agent op ──
  [OP.pipelineImport]: op<K.PipelineImportInput, K.PipelineImportOutput>({
    // the id of the contract only: purposes, dictation refs and owners are not receipt text
    redact: (input, output) => {
      const id = (input.contract as { id?: unknown } | null)?.id;
      return `Imported pipeline ${typeof id === "string" ? id.slice(0, 41) : "contract"}${output ? ` as draft ${output.draft.id}` : ""}${input.asDraftOf ? ` for ${input.asDraftOf}` : ""}`;
    },
    async run(input, ctx) {
      const r = pipeline.importPipeline(ctx.db, { contract: input.contract, asDraftOf: input.asDraftOf, confirmReplace: input.confirmReplace });
      return { draft: { ...r.draft, pipeline: r.pipeline }, report: r.report };
    },
  }),
  [OP.pipelineExport]: op<K.PipelineExportInput, K.PipelineExportOutput>({
    async run(input, ctx) {
      const wf = store.getWorkflow(ctx.db, input.workflowId);
      const v = store.getVersion(ctx.db, wf.id, input.version);
      const stored = pipeline.versionSource(ctx.db, wf.id, v.version);
      const { contract, omitted, notes } = pipeline.exportContract({
        workflowId: wf.id,
        version: v.version,
        active: v.version === wf.activeVersion,
        snapshot: store.snapshotOf(v),
        imported: stored,
        automationCron: pipeline.automationCronOf(ctx.db, wf.id),
      });
      const imported = stored !== null;
      return {
        contract: contract as unknown as K.PipelineExportOutput["contract"],
        filename: pipeline.exportFileName(contract),
        imported,
        omitted,
        notice: [
          imported
            ? "Rebuilt from the contract you imported and the version you edited. Status is set by Evolution (active, or retired for an older version). Fields Evolution does not enforce come back as they were imported."
            : "This workflow was not imported from a contract, so the required fields that Evolution has no data for are filled with defaults: owner unassigned, the Task Board run issue as input and output, a default done check, and no declared metrics.",
          ...notes,
        ].join(" "),
      };
    },
  }),
  [OP.workflowsList]: op<K.WorkflowsListInput, K.WorkflowsListOutput>({
    async run(_input, ctx) {
      return { workflows: store.listWorkflows(ctx.db) };
    },
  }),
  [OP.workflowVersions]: op<K.WorkflowVersionsInput, K.WorkflowVersionsOutput>({
    async run(input, ctx) {
      return {
        workflow: store.getWorkflow(ctx.db, input.workflowId),
        versions: store.listVersions(ctx.db, input.workflowId),
        pipelines: pipeline.versionPipelines(ctx.db, input.workflowId),
      };
    },
  }),
  [OP.workflowDiff]: op<K.WorkflowDiffInput, K.WorkflowDiffOutput>({
    async run(input, ctx) {
      const a = store.getVersion(ctx.db, input.workflowId, input.from);
      const b = store.getVersion(ctx.db, input.workflowId, input.to);
      const d = diffSnapshots(store.snapshotOf(a), store.snapshotOf(b));
      return { workflowId: input.workflowId, from: input.from, to: input.to, ...d, notice: diffNotice(d) };
    },
  }),
  [OP.recipeExport]: op<K.RecipeExportInput, K.RecipeExportOutput>({
    async run(input, ctx) {
      const v = store.getVersion(ctx.db, input.workflowId, input.version);
      const recipe = buildRecipe({ id: v.workflowId, version: v.version, snapshot: store.snapshotOf(v) }, { agentName: input.agentName, harnessOptionId: input.harnessOptionId });
      return {
        recipe,
        notice:
          "Save this JSON as a file. Import it in Portal (tealbrick recipe import <file>, then open the review link), check the steps and apply them with one confirmation. Portal creates the agent, sets it Bound with these operations only, and connects it to each app. Connect the agent on its machine with tealbrick agent login. " +
          ALLOWLIST_NOTICE,
      };
    },
  }),
  [OP.automationSet]: op<K.AutomationSetInput, K.AutomationSetOutput>({
    redact: (input) => `Schedule ${input.id ?? "new"} for ${input.workflowId}: ${input.cron}`,
    async run(input, ctx) {
      const opts = { kanbanLinked: kanbanLinked(ctx) };
      return automationView(ctx.db, routines.setAutomation(ctx.db, input, Date.now(), opts).id, opts);
    },
  }),
  [OP.automationPause]: op<K.AutomationPauseInput, K.AutomationPauseOutput>({
    redact: (input) => `Schedule ${input.id}: ${input.paused ? "paused" : "resumed"}`,
    async run(input, ctx) {
      return automationView(ctx.db, routines.pauseAutomation(ctx.db, input.id, input.revision, input.paused).id, { kanbanLinked: kanbanLinked(ctx) });
    },
  }),
  [OP.automationDelete]: op<K.AutomationDeleteInput, K.AutomationDeleteOutput>({
    redact: (input) => `Schedule ${input.id}: deleted`,
    async run(input, ctx) {
      routines.deleteAutomation(ctx.db, input.id, input.revision);
      return { id: input.id, deleted: true };
    },
  }),
  [OP.automationsList]: op<K.AutomationsListInput, K.AutomationsListOutput>({
    async run(_input, ctx) {
      const linked = kanbanLinked(ctx);
      return { automations: routines.listAutomations(ctx.db, Date.now(), { kanbanLinked: linked }), kanbanLinked: linked };
    },
  }),
  [OP.runsList]: op<K.RunsListInput, K.RunsListOutput>({
    async run(input, ctx) {
      return { runs: routines.listRuns(ctx.db, { automationId: input.automationId, limit: input.limit ?? 50 }) };
    },
  }),

  // ── cycles (0.3.0, C250 Release B): ledger computed on read, evals live; stored evals in eval_runs ──
  [OP.cyclesList]: op<K.CyclesListInput, K.CyclesListOutput>({
    async run(input, ctx) {
      return { cycles: cycles.listCycles(ctx.db, { workflowId: input.workflowId }) };
    },
  }),
  [OP.cycleGet]: op<K.CycleGetInput, K.CycleGetOutput>({
    async run(input, ctx) {
      // the lessons are free text from agents: person op only (C88 / L12), never in an agent op
      const cycle = cycles.getCycle(ctx.db, input.workflowId, input.version);
      return { cycle, evals: cycles.storedEvals(ctx.db, input.workflowId, input.version), lessons: cycles.cycleLessons(ctx.db, input.workflowId, input.version) };
    },
  }),
  [OP.cycleEvalRun]: op<K.CycleEvalRunInput, K.CycleEvalRunOutput>({
    // Idempotency (manifest "required") is the SDK's; the key is also stored with the eval, so a repeated key never
    // stores a second eval even past the SDK's own record.
    redact: (input, output) => `Eval of ${input.workflowId} v${input.version}${output ? `: ${output.verdict}` : ""}`,
    async run(input, ctx) {
      return ctx.db.transaction(() => cycles.storeEval(ctx.db, input.workflowId, input.version, "owner", Date.now(), ctx.idempotencyKey ?? null));
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

function draftRow(d: store.Draft): K.DraftsListOutput["drafts"][number] {
  return { id: d.id, title: d.title, state: d.state, revision: d.revision, workflowId: d.workflowId, suggestionId: d.suggestionId, updatedAt: d.updatedAt };
}

/** The one background detector of this process (started by onStart, stopped with the app). */
export const detectorRefresh = createDetectorRefresh();

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  migrations: migrationsDir,
  // C85: the Kanban scan runs without an op call (app-initiated companion call with Evolution's own grant).
  async onStart(ctx) {
    detectorRefresh.start({ db: ctx.db, callApp: ctx.callApp.bind(ctx), log: ctx.log });
  },
  events: {
    // Agent directory (manifest needsAgentDirectory): keep names so suggestion text can say who repeated the work.
    async agentAdded(agent, ctx) {
      ctx.db.prepare("INSERT INTO agent_names (id, name, seen_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, seen_at = excluded.seen_at").run(agent.id, agent.name, Date.now());
    },
  },
};

export const app = defineApp(definition);
