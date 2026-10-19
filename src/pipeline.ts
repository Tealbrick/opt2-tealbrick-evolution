// Typed pipeline contract import / export (C288 R10; Martin: "workflow definitions import or map 1:1 the typed pipeline
// contract"). The contract is tealbrick.agents/pipeline-contract/0.1 (the Henry typed contracts; the vendored schema is
// contracts/pipeline-contract-0.1.schema.json). Evolution maps the part it can ENFORCE (the operation allow-list: a
// step's `mcp__tealbrick__<product>__<operation>` tools) and keeps everything else losslessly as data.
//
// Where things live (migration 0007, two new tables, nothing existing changes):
//   pipeline_sources            one row per imported DRAFT: key (pipeline_id), pipeline_version, the contract as imported
//                               (`source`), and the import report. Beside the draft, NOT inside the Snapshot: versions stay
//                               immutable snapshots with their own diff, and every agent op that returns a snapshot
//                               (workflow_get) is unchanged.
//   workflow_version_pipelines  the contract of the draft as it was at promotion, per version (copied by store.promote).
// `source` holds dictation refs, owners and purposes: only person ops read it (C88 / L12 posture).
//
// Validation uses `validateAgainstSchema` from @opt2-tealbrick/manifest (the SDK's own JSON Schema 2020-12 validator, the
// one that checks every op input), so every keyword of the contract schema is enforced; there is no hand-written subset.
import { readFileSync } from "node:fs";
import { CronError, nextCronTime, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { allowedFromSteps, normalizeSteps, type Snapshot, type StepInput, type StepOp } from "./model.ts";
import { SELF_OPS } from "./recipe.ts";
import * as store from "./store.ts";

type Schema = Parameters<typeof validateAgainstSchema>[0];
type Json = Parameters<typeof validateAgainstSchema>[1];
type Obj = Record<string, unknown>;

export const PIPELINE_CONTRACT_ID = "tealbrick.agents/pipeline-contract/0.1";
const readJson = (rel: string): Obj => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as Obj;
/** The vendored contract schema (provenance in its `$comment`). Next to dist/ in the image, like eval/thresholds.json. */
export const PIPELINE_SCHEMA = readJson("../contracts/pipeline-contract-0.1.schema.json") as unknown as Schema;

export interface PipelineStep {
  id: string;
  do: string;
  lead?: string;
  tools?: string[];
  skills?: string[];
  in?: string;
  out?: string;
  when?: string;
  on_fail?: string;
}
export interface PipelineContract {
  $schema?: string;
  id: string;
  version: number;
  status?: string;
  owner: string;
  purpose: string;
  dictation_refs?: string[];
  trigger: { cron?: string; timezone?: string; event?: string; once?: boolean };
  inputs: { source: string; what: string; type?: string }[];
  steps: PipelineStep[];
  outputs: string[];
  done_when: string[];
  approvals: Obj;
  escalation: Obj[];
  metrics: string[];
  taskboard?: { project?: string; issue_title?: string };
}

export interface ImportReport {
  /** Contract fields that became workflow fields. */
  mapped: { from: string; to: string }[];
  /** Tools that are not Teal Brick app operations: not mapped, not enforced (C288 R5 / R6 are owned elsewhere). */
  unmapped: { tools: { step: string; tool: string; reason: string }[] };
  /** Fields kept as JSON on the draft: Evolution does not enforce them. `steps` lists the step ids that carry the field. */
  kept_as_data: { field: string; steps?: string[] }[];
  /** The trigger, for the owner to create the schedule by hand (Evolution schedules run in UTC). */
  schedule_hint: { cron: string | null; timezone: string | null; event: string | null; once: boolean | null };
  /** The metric names the contract declares, in contract order. Run reports of the workflow may carry only these (R10). */
  declaredMetrics: string[];
  /** What an agent that runs the workflow can read of it (workflow_get): the owner reviews these before promotion. */
  agent_visible: string[];
  notes: string[];
}

export interface PipelineInfo {
  id: string;
  version: number;
  importedAt: string;
  /** asDraftOf: the version of the workflow that was active at import; null for a draft of a new workflow. */
  baseVersion: number | null;
  report: ImportReport;
}

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const refuse = (message: string, pointer: string, extra: Obj = {}): store.StoreError => new store.StoreError("validation_failed", message, { pointer, ...extra });

// ── validation ──

/** The schema node a JSON pointer lands on (objects by `properties`, arrays by `items`), or null. */
function schemaAt(path: string): Obj | null {
  let node: Obj | null = PIPELINE_SCHEMA as unknown as Obj;
  for (const seg of path.split("/").filter(Boolean)) {
    if (!node) return null;
    const next: unknown = /^\d+$/.test(seg) ? node.items : isObject(node.properties) ? node.properties[seg] : undefined;
    node = isObject(next) ? next : null;
  }
  return node;
}
function valueAt(root: unknown, path: string): unknown {
  let v: unknown = root;
  for (const seg of path.split("/").filter(Boolean)) v = Array.isArray(v) ? v[Number(seg)] : isObject(v) ? v[seg] : undefined;
  return v;
}

/** The contract object, checked against the vendored schema. A leading `$schema` string (the examples carry one) is
 *  set aside before the check, like the reference validator of the Henry contracts does, and kept in the result.
 *  Refusal = StoreError validation_failed (422) with `pointer` (JSON pointer of the first problem) and every error. */
export const MAX_CONTRACT_BYTES = 256 * 1024;
export const MAX_ARRAY_ITEMS = 200;
const tooLarge = (message: string, pointer: string, extra: Obj = {}): store.StoreError => new store.StoreError("contract_too_large", message, { pointer, ...extra });
/** Bounds checked before anything else: the serialized contract, and every array anywhere in it. */
function checkBounds(raw: Obj): void {
  const bytes = Buffer.byteLength(JSON.stringify(raw), "utf8");
  if (bytes > MAX_CONTRACT_BYTES) throw tooLarge(`The pipeline contract is too large (${bytes} bytes; the limit is ${MAX_CONTRACT_BYTES}).`, "", { bytes, limit: MAX_CONTRACT_BYTES });
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      if (v.length > MAX_ARRAY_ITEMS) throw tooLarge(`${path || "/"} has ${v.length} items; the limit is ${MAX_ARRAY_ITEMS}.`, path, { items: v.length, limit: MAX_ARRAY_ITEMS });
      for (const [i, x] of v.entries()) walk(x, `${path}/${i}`);
    } else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, `${path}/${k}`);
  };
  walk(raw, "");
}

export function parseContract(raw: unknown): PipelineContract {
  if (!isObject(raw)) throw refuse("The pipeline contract must be a JSON object.", "");
  checkBounds(raw);
  const { $schema, ...body } = raw;
  if ($schema !== undefined && typeof $schema !== "string") throw refuse("$schema must be text.", "/$schema");
  const v = validateAgainstSchema(PIPELINE_SCHEMA, body as Json);
  if (!v.ok) {
    const errors = v.errors.slice(0, 20).map((e) => {
      if (!/additional properties/.test(e.message)) return { path: e.path, message: e.message };
      // name the unknown field: the schema's own message does not
      const props = schemaAt(e.path)?.properties;
      const at = valueAt(body, e.path);
      const extra = isObject(props) && isObject(at) ? Object.keys(at).filter((k) => !(k in props)) : [];
      return extra.length ? { path: `${e.path}/${extra[0]}`, message: `unknown field "${extra[0]}"` } : { path: e.path, message: e.message };
    });
    const first = errors[0];
    throw refuse(`The pipeline contract is not valid (${PIPELINE_CONTRACT_ID}): ${first?.path || "/"} ${first?.message ?? ""}`.trim(), first?.path ?? "", { errors });
  }
  return { ...($schema !== undefined ? { $schema } : {}), ...body } as unknown as PipelineContract;
}

// ── tools ──

const TOOL_PREFIX = "mcp__tealbrick__";
/** The op-name rule of the draft editor: the patterns of the manifest (draft_update `allowed`), the one source. */
let nameRules: { product: RegExp; operation: RegExp } | null = null;
function names(): { product: RegExp; operation: RegExp } {
  if (!nameRules) {
    const props = ((limits() as unknown as Obj).properties as Obj).allowed as Obj;
    const item = (props.items as Obj).properties as Obj;
    nameRules = { product: new RegExp(String((item.product as Obj).pattern)), operation: new RegExp(String(((item.operations as Obj).items as Obj).pattern)) };
  }
  return nameRules;
}
/** `mcp__tealbrick__<product>__<operation>` → a step operation; anything else → the reason it is not mapped.
 *  Refused although well formed: product `tb` (standard operations are never in an allow-list), product `evolution` other
 *  than the Bound-agent operations (SELF_OPS), and an operation name with a double underscore. */
export function classifyTool(tool: string): { op: StepOp } | { reason: string } {
  if (!tool.startsWith(TOOL_PREFIX)) return { reason: "not a Teal Brick app operation" };
  const rest = tool.slice(TOOL_PREFIX.length);
  const i = rest.indexOf("__"); // a product id has no underscore, so the first "__" ends it
  if (i < 1) return { reason: "not of the form mcp__tealbrick__<product>__<operation>" };
  const product = rest.slice(0, i);
  const operation = rest.slice(i + 2);
  const rule = names();
  if (!rule.product.test(product)) return { reason: "the product name is not valid" };
  if (!rule.operation.test(operation)) return { reason: "the operation name is not valid" };
  if (operation.includes("__")) return { reason: "the operation name has a double underscore" };
  if (product === "tb") return { reason: "standard (tb) operations are never in an allow-list" };
  if (product === "evolution" && !SELF_OPS.operations.includes(operation)) return { reason: "this Evolution operation is for the owner, not for a Bound agent" };
  return { op: { product, operation } };
}
export function tealbrickOp(tool: string): StepOp | null {
  const c = classifyTool(tool);
  return "op" in c ? c.op : null;
}
export const toolName = (o: StepOp): string => `${TOOL_PREFIX}${o.product}__${o.operation}`;

// ── import mapping ──

const humanise = (id: string): string => {
  const s = id.replaceAll("-", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};
/** A step title is a label (≤ 100 characters); the full `do` text is the step instruction. */
function stepTitle(s: PipelineStep): string {
  const line = (s.do.split("\n")[0] ?? "").trim();
  if (!line) return s.id;
  if (line.length <= 100) return line;
  const cut = line.slice(0, 99);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40))}…`;
}
function triggerText(t: PipelineContract["trigger"]): string {
  const parts: string[] = [];
  if (t.cron) parts.push(`cron ${t.cron} (${t.timezone ?? "Asia/Bangkok"})`);
  if (t.event) parts.push(`event ${t.event}`);
  if (t.once) parts.push("once");
  return parts.join("; ").slice(0, 500);
}
const STEP_DATA_FIELDS = ["lead", "skills", "in", "out", "when", "on_fail"] as const;
const TOP_DATA_FIELDS = ["status", "owner", "dictation_refs", "inputs", "outputs", "done_when", "approvals", "escalation", "taskboard"] as const;

export interface MapBase {
  /** asDraftOf: keep the owner's title and instruction of the workflow (the contract has neither). */
  title?: string;
  instruction?: string;
}

/** Contract → draft text + report. Throws ModelError (422, pointer) for a duplicate step id. */
export function mapContract(c: PipelineContract, base: MapBase = {}): { snapshot: Snapshot; report: ImportReport } {
  const mapped: ImportReport["mapped"] = [
    { from: "id", to: "pipeline key (stored with the draft)" },
    { from: "version", to: "pipeline version (stored as data; Evolution versions stay its own)" },
    { from: "purpose", to: "summary" },
    { from: "steps[].id", to: "step id" },
    { from: "steps[].do", to: "step title (first line, short) and step instruction (all of it)" },
    { from: "trigger", to: "trigger text (words only; no schedule is created)" },
  ];
  const unmapped: ImportReport["unmapped"]["tools"] = [];
  const stepInputs: StepInput[] = c.steps.map((s) => {
    const ops: StepOp[] = [];
    for (const tool of s.tools ?? []) {
      const r = classifyTool(tool);
      if ("op" in r) {
        // one line per step and tool: a tool named twice in a step is listed once
        if (!ops.some((o) => o.product === r.op.product && o.operation === r.op.operation)) {
          ops.push(r.op);
          mapped.push({ from: `steps[${s.id}].tools: ${tool}`, to: `step operation and allowed operation ${r.op.product}.${r.op.operation}` });
        }
      } else if (!unmapped.some((u) => u.step === s.id && u.tool === tool)) unmapped.push({ step: s.id, tool, reason: r.reason });
    }
    return { id: s.id, title: stepTitle(s), instruction: s.do, ops };
  });
  const steps = normalizeSteps(stepInputs); // a duplicate step id: ModelError with /steps/<i>/id (422 in the app)
  const allowed = allowedFromSteps(steps);

  const kept: ImportReport["kept_as_data"] = [];
  for (const f of TOP_DATA_FIELDS) if (c[f] !== undefined) kept.push({ field: f });
  for (const f of STEP_DATA_FIELDS) {
    const ids = c.steps.filter((s) => s[f] !== undefined).map((s) => s.id);
    if (ids.length) kept.push({ field: `steps[].${f}`, steps: ids });
  }

  const notes: string[] = ["The whole contract is stored as it came in. Export gives it back."];
  if (unmapped.length) notes.push(`${unmapped.length} tool(s) are not Teal Brick app operations. Evolution does not list or enforce them (C288 R5 and R6).`);
  if (allowed.length === 0) notes.push("No step names a Teal Brick operation. Add at least one allowed operation before you promote.");
  notes.push(
    c.metrics.length === 0
      ? "The contract declares no metrics. Run reports of this workflow may carry no named metric (routine_report refuses one: metric_not_declared)."
      : `The contract declares ${c.metrics.length} metric(s). Run reports of this workflow carry them as routine_report metrics.metrics (name to number). Any other name is refused (metric_not_declared).`,
  );
  if (c.trigger.timezone || c.trigger.cron) notes.push("Evolution schedules run in UTC and have no time zone. Convert the cron time before you create the schedule.");

  const snapshot: Snapshot = {
    title: base.title ?? humanise(c.id),
    summary: c.purpose.trim(),
    instruction: base.instruction ?? `Run the pipeline "${c.id}". Follow the steps below and use only the allowed operations.`,
    trigger: triggerText(c.trigger),
    steps,
    allowed,
  };
  return {
    snapshot,
    report: {
      mapped,
      unmapped: { tools: unmapped },
      kept_as_data: kept,
      schedule_hint: { cron: c.trigger.cron ?? null, timezone: c.trigger.cron ? (c.trigger.timezone ?? "Asia/Bangkok") : null, event: c.trigger.event ?? null, once: c.trigger.once ?? null },
      declaredMetrics: c.metrics,
      agent_visible: ["title", "summary", "steps"],
      notes,
    },
  };
}

let manifestOps: { id: string; input: Obj; output: Obj }[] | null = null;
const manifestOp = (id: string): { id: string; input: Obj; output: Obj } => {
  manifestOps ??= (readJson("../tealbrick.manifest.json") as { operations: { id: string; input: Obj; output: Obj }[] }).operations;
  return manifestOps.find((o) => o.id === id) as { id: string; input: Obj; output: Obj };
};
/** The draft limits of the manifest (draft_update input, without id and revision): a contract that maps to text beyond
 *  them is refused at import, not at the owner's first Save. */
let draftLimits: Schema | null = null;
function limits(): Schema {
  if (!draftLimits) {
    const input = manifestOp("draft_update").input;
    const { id: _i, revision: _r, ...props } = input.properties as Obj;
    draftLimits = { ...input, required: [], properties: props } as unknown as Schema;
  }
  return draftLimits;
}
const POINTER_FIX: [RegExp, string][] = [
  [/^\/steps\/(\d+)\/(title|instruction)$/, "/steps/$1/do"],
  [/^\/summary$/, "/purpose"],
];
export function checkDraftFits(s: Snapshot): void {
  const v = validateAgainstSchema(limits(), JSON.parse(JSON.stringify(s)) as Json);
  if (v.ok) return;
  const errors = v.errors.map((e) => ({ path: POINTER_FIX.reduce((p, [re, to]) => p.replace(re, to), e.path), message: e.message }));
  const first = errors[0];
  throw refuse(`The contract does not fit a workflow draft: ${first?.path} ${first?.message}`, first?.path ?? "", { errors });
}

/** The report must fit the output schema of pipeline_import (and draft_get, which carries it): checked BEFORE the draft is
 *  created, so a report the SDK would refuse never leaves a draft behind. 422 contract_too_large with the contract part. */
const REPORT_PART: Record<string, string> = { mapped: "/steps", unmapped: "/steps", kept_as_data: "/steps", declaredMetrics: "/metrics", notes: "/steps", schedule_hint: "/trigger", agent_visible: "" };
export function checkReportFits(report: ImportReport): void {
  const schema = (manifestOp("pipeline_import").output.properties as Obj).report as Schema;
  const v = validateAgainstSchema(schema, JSON.parse(JSON.stringify(report)) as Json);
  if (v.ok) return;
  const first = v.errors[0];
  const part = (first?.path ?? "").split("/")[1] ?? "";
  throw tooLarge(`The import report would be too large (${first?.path} ${first?.message}). Split the pipeline into smaller contracts.`, REPORT_PART[part] ?? "", { errors: v.errors.slice(0, 20) });
}

// ── storage ──

function toInfo(r: Obj): PipelineInfo {
  return {
    id: String(r.pipeline_id),
    version: Number(r.pipeline_version),
    importedAt: new Date(Number(r.imported_at)).toISOString(),
    baseVersion: r.base_version === null || r.base_version === undefined ? null : Number(r.base_version),
    report: JSON.parse(String(r.report)) as ImportReport,
  };
}
export function pipelineOfDraft(db: Db, draftId: string): PipelineInfo | null {
  const r = db.prepare("SELECT * FROM pipeline_sources WHERE draft_id = ?").get(draftId);
  return r ? toInfo(r) : null;
}
/** Pipeline keys stored for a workflow: its versions and its drafts (an import not yet promoted counts). */
export function pipelineIdsOfWorkflow(db: Db, workflowId: string): string[] {
  return db
    .prepare(
      "SELECT pipeline_id FROM workflow_version_pipelines WHERE workflow_id = ? UNION SELECT s.pipeline_id FROM pipeline_sources s JOIN drafts d ON d.id = s.draft_id WHERE d.workflow_id = ? ORDER BY 1",
    )
    .all(workflowId, workflowId)
    .map((r) => String(r.pipeline_id));
}
/** Workflows that already carry this pipeline key (by a promoted version). */
function workflowsWithPipeline(db: Db, pipelineId: string): string[] {
  return db
    .prepare("SELECT DISTINCT workflow_id FROM workflow_version_pipelines WHERE pipeline_id = ? ORDER BY 1")
    .all(pipelineId)
    .map((r) => String(r.workflow_id));
}
/** The metric names the contract of a workflow VERSION declares, in contract order; null when that version was never imported
 *  (then routine_report accepts any patterned name). An imported contract with an empty list declares none. */
export function declaredMetrics(db: Db, workflowId: string, version: number): string[] | null {
  const v = versionSource(db, workflowId, version);
  return v ? [...v.source.metrics] : null;
}
/** The contract frozen with one version, or null when that version was never imported. */
export function versionSource(db: Db, workflowId: string, version: number): { pipelineId: string; pipelineVersion: number; source: PipelineContract } | null {
  const r = db.prepare("SELECT * FROM workflow_version_pipelines WHERE workflow_id = ? AND version = ?").get(workflowId, version);
  return r ? { pipelineId: String(r.pipeline_id), pipelineVersion: Number(r.pipeline_version), source: JSON.parse(String(r.source)) as PipelineContract } : null;
}
export function versionPipelines(db: Db, workflowId: string): { version: number; id: string; pipelineVersion: number }[] {
  return db
    .prepare("SELECT version, pipeline_id, pipeline_version FROM workflow_version_pipelines WHERE workflow_id = ? ORDER BY version")
    .all(workflowId)
    .map((r) => ({ version: Number(r.version), id: String(r.pipeline_id), pipelineVersion: Number(r.pipeline_version) }));
}

/** pipeline_import: validate, map, create the draft and store the contract beside it, all in one transaction.
 *  `asDraftOf`: the draft is a new draft of that workflow (promoting it makes the next version). The workflow's stored
 *  pipeline key must be the contract's id (409 pipeline_id_mismatch). A workflow that was never imported accepts any key,
 *  but only with `confirmReplace: true` (409 confirm_replace_required): the draft replaces its steps and allowed operations. */
export function importPipeline(db: Db, input: { contract: unknown; asDraftOf?: string | undefined; confirmReplace?: boolean | undefined }, now: number = Date.now()): { draft: store.Draft; report: ImportReport; pipeline: PipelineInfo } {
  const contract = parseContract(input.contract);
  return db.transaction(() => {
    let base: MapBase = {};
    let baseVersion: number | null = null;
    const notes: string[] = [];
    if (input.asDraftOf) {
      const wf = store.getWorkflow(db, input.asDraftOf);
      const ids = pipelineIdsOfWorkflow(db, wf.id);
      const other = ids.find((x) => x !== contract.id);
      if (other)
        throw new store.StoreError("pipeline_id_mismatch", `The workflow ${wf.id} was imported from pipeline "${other}", not "${contract.id}". Import it without asDraftOf to start a separate workflow.`, {
          workflowId: wf.id,
          storedPipelineId: other,
          contractId: contract.id,
        });
      if (ids.length === 0 && !input.confirmReplace)
        throw new store.StoreError(
          "confirm_replace_required",
          `The workflow ${wf.id} was not imported from a pipeline contract. This draft replaces its steps and allowed operations with those of the contract "${contract.id}". Send confirmReplace: true to continue.`,
          { workflowId: wf.id, contractId: contract.id },
        );
      baseVersion = wf.activeVersion;
      base = { title: wf.title, instruction: store.getVersion(db, wf.id).instruction };
      notes.push(
        ids.length === 0
          ? `This workflow was never imported from a contract. It now carries the pipeline key "${contract.id}". The title and instruction of the workflow are kept.`
          : "The title and instruction of the workflow are kept; steps, allowed operations, summary and trigger text come from the contract.",
      );
    } else {
      const known = workflowsWithPipeline(db, contract.id);
      if (known.length) notes.push(`A workflow for pipeline "${contract.id}" already exists (${known.join(", ")}). To add a version to it, import again with asDraftOf.`);
    }
    const { snapshot, report } = mapContract(contract, base);
    checkDraftFits(snapshot);
    report.notes.push(...notes);
    checkReportFits(report);
    const draft = store.createDraft(db, { suggestionId: null, templateId: null, snapshot, workflowId: input.asDraftOf ?? null }, now);
    db.prepare("INSERT INTO pipeline_sources (draft_id, pipeline_id, pipeline_version, source, report, imported_at, base_version) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      draft.id,
      contract.id,
      contract.version,
      JSON.stringify(contract),
      JSON.stringify(report),
      now,
      baseVersion,
    );
    const pipeline = pipelineOfDraft(db, draft.id) as PipelineInfo;
    return { draft, report, pipeline };
  });
}

// ── export ──

/** Cron (UTC) of the workflow's oldest live schedule, or null. */
export function automationCronOf(db: Db, workflowId: string): string | null {
  const r = db.prepare("SELECT cron FROM automations WHERE workflow_id = ? AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1").get(workflowId);
  return r ? String(r.cron) : null;
}

export interface ExportInput {
  workflowId: string;
  version: number;
  /** The exported version is the workflow's active one. */
  active: boolean;
  snapshot: Snapshot;
  /** The contract frozen with that version, or null (never imported). */
  imported: { pipelineId: string; pipelineVersion: number; source: PipelineContract } | null;
  /** Cron of the workflow's first schedule, when it has one (used for a workflow that was never imported). */
  automationCron: string | null;
}

/** True when the SAME cron parser the schedules use (nextCronTime of @opt2-tealbrick/manifest) accepts the text and it fires. */
function isCron(text: string): boolean {
  try {
    return nextCronTime(text, Date.now()) !== null;
  } catch (e) {
    if (e instanceof CronError) return false;
    throw e;
  }
}
const STEP_ID = /^[a-z][a-z0-9-]{1,30}$/;
/** A contract step id from an Evolution step id: lower case, letters digits and hyphen, starts with a letter, 2..31 characters, unique. */
function contractStepId(id: string, used: Set<string>): string {
  let s = id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!/^[a-z]/.test(s)) s = `s-${s.replace(/^-+/, "")}`;
  if (s.length < 2) s = `${s}x`;
  s = s.slice(0, 31);
  for (let n = 2; used.has(s) || !STEP_ID.test(s); n++) s = `${s.slice(0, 28)}-${n}`;
  used.add(s);
  return s;
}
/** The source text when it is the same as the current text up to the trim Evolution applies; else the current text. */
const prefer = (src: string | undefined, current: string): string => (src !== undefined && src.trim() === current ? src : current);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Version snapshot (+ the contract stored with it) → a pipeline contract 0.1 object.
 *  IMPORTED: starts from the stored contract, so every field Evolution does not own comes back as it came in; Evolution
 *  owns exactly: `status` (active for the active version, retired for an older one), `purpose` (the summary), and
 *  `steps` (order, which steps exist, `do`, and the Teal Brick `tools` = the step's operations; unmapped tools and
 *  lead / skills / in / out / when / on_fail are kept per step id). An unchanged import round-trips except `status`.
 *  NOT IMPORTED: required fields are filled with documented defaults (see README, R10). */
export function exportContract(i: ExportInput): { contract: PipelineContract; omitted: string[]; notes: string[] } {
  const notes: string[] = [];
  const { snapshot: s, imported } = i;
  const src = imported?.source ?? null;
  const srcSteps = new Map((src?.steps ?? []).map((x) => [x.id, x]));
  // every id of the imported contract is taken, also those of steps since removed or renamed: a new step never reuses one
  const used = new Set<string>((src?.steps ?? []).map((x) => x.id));
  const steps: PipelineStep[] = s.steps.map((st) => {
    const old = srcSteps.get(st.id);
    const id = old ? st.id : contractStepId(st.id, used);
    const doText = old && old.do.trim() === st.instruction ? old.do : st.instruction || st.title;
    // tools: the step's own Teal Brick operations (in the source order where the source had them), then every tool that is
    // not a Teal Brick operation exactly as the source listed it
    const have = new Set(st.ops.map((o) => `${o.product}.${o.operation}`));
    const placed = new Set<string>();
    const tools: string[] = [];
    for (const t of old?.tools ?? []) {
      const op = tealbrickOp(t);
      if (!op) tools.push(t);
      else if (have.has(`${op.product}.${op.operation}`)) {
        tools.push(t);
        placed.add(`${op.product}.${op.operation}`);
      }
    }
    for (const o of st.ops) if (!placed.has(`${o.product}.${o.operation}`)) tools.push(toolName(o));
    const out: Obj = {};
    for (const k of Object.keys(old ?? {})) out[k] = k === "id" ? id : k === "do" ? doText : k === "tools" ? tools : (old as unknown as Obj)[k];
    if (!old) Object.assign(out, { id, do: doText });
    if (!("tools" in out) && tools.length) out.tools = tools;
    return out as unknown as PipelineStep;
  });
  if (steps.length === 0) {
    const tools = s.allowed.flatMap((a) => a.operations.map((o) => toolName({ product: a.product, operation: o })));
    steps.push({ id: "run", do: s.instruction || s.title, ...(tools.length ? { tools } : {}) });
  }
  const inSteps = new Set(s.steps.flatMap((st) => st.ops.map((o) => `${o.product}.${o.operation}`)));
  const omitted = s.allowed.flatMap((a) => a.operations.map((o) => `${a.product}.${o}`)).filter((k) => !inSteps.has(k));
  const status = i.active ? "active" : "retired";
  const purpose = s.summary ? (src ? prefer(src.purpose, s.summary) : s.summary).slice(0, 400) : (src?.purpose ?? s.title.slice(0, 400));

  let contract: PipelineContract;
  if (src) {
    contract = { ...src, status, purpose, steps };
  } else {
    const guess = slug(s.title).slice(0, 41).replace(/-+$/, "");
    const id = /^[a-z][a-z0-9-]{2,40}$/.test(guess) ? guess : `wfl-${slug(i.workflowId.replace(/^wfl_/, "")).slice(0, 36)}`;
    const text = s.trigger.trim();
    const cron = i.automationCron ?? (isCron(text) ? text : null);
    if (!cron && text) notes.push(`The trigger text "${text.slice(0, 80)}" is not a five-field cron, so it is not in the file (trigger is {"event":"manual"}).`);
    contract = {
      id,
      version: i.version,
      status,
      owner: "unassigned",
      purpose,
      trigger: cron ? { cron, timezone: "UTC" } : { event: "manual" },
      inputs: [{ source: "taskboard", what: "The Task Board run issue that Evolution opens for each claimed run" }],
      steps,
      outputs: ["The Task Board run issue, closed with the run result"],
      done_when: ["the run is reported completed (routine_report)"],
      approvals: {},
      escalation: [],
      metrics: [],
    };
  }
  // Guard: what leaves is always a valid contract (a failure here is a bug, not a user error).
  const { $schema: _s, ...body } = contract;
  const v = validateAgainstSchema(PIPELINE_SCHEMA, JSON.parse(JSON.stringify(body)) as Json);
  if (!v.ok) throw new store.StoreError("validation_failed", `The workflow cannot be exported as a valid contract: ${v.errors[0]?.path} ${v.errors[0]?.message}`, { pointer: v.errors[0]?.path ?? "", errors: v.errors.slice(0, 20) });
  return { contract, omitted, notes };
}

/** Plain file name for the download. */
export const exportFileName = (c: PipelineContract): string => `${c.id}.pipeline.json`;
