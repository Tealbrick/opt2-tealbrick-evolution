// Evolution store: plain functions over the SDK's Db (migrations/0001_init.sql). Handlers stay thin; tests run these
// against a migrated database. State machine (harvest of the v1 runtime store):
//   suggestion  open → approved | rejected | archived   (approved/rejected → archived; rejected → approved on review)
//   draft       open ⇄ promoted                          (any edit returns it to open; promotion snapshots it)
//   workflow    versions 1..n, immutable; active = latest promoted; promoting n+1 closes the cycle of n and stores its
//               eval in the same transaction (src/cycles.ts, eval_runs trigger 'promotion')
import { ulid } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { storeEval } from "./cycles.ts";
import { type Allowed, checkPromotable, normalizeAllowed, normalizeSteps, type Snapshot, type Step, type StepInput, sameSnapshot } from "./model.ts";

export type SuggestionStatus = "open" | "approved" | "rejected" | "archived";
export type Decision = "approve" | "reject" | "archive";
export interface Actor {
  type: "agent" | "app" | "person" | "system";
  id: string;
  name: string;
}
export interface Evidence {
  kind: "kanban_issue" | "receipt";
  ref: string;
  product: string | null;
  note: string | null;
  title: string | null;
}
export interface Suggestion {
  id: string;
  title: string;
  summary: string;
  source: "agent" | "detector";
  status: SuggestionStatus;
  agentId: string | null;
  createdBy: Actor;
  evidence: Evidence[];
  steps: Step[];
  note: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface SuggestionRow {
  id: string;
  title: string;
  source: "agent" | "detector";
  status: SuggestionStatus;
  agentId: string | null;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface Draft extends Snapshot {
  id: string;
  suggestionId: string | null;
  templateId: string | null;
  workflowId: string | null;
  revision: number;
  state: "open" | "promoted";
  promotedVersion: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface Workflow {
  id: string;
  title: string;
  summary: string;
  activeVersion: number;
  draftId: string;
  createdAt: string;
  updatedAt: string;
}
export interface Version extends Snapshot {
  workflowId: string;
  version: number;
  draftId: string;
  draftRevision: number;
  promotedAt: string;
}

/** Store-level refusal; the app maps `code` to the CORE §8 envelope. */
export class StoreError extends Error {
  readonly code: "not_found" | "conflict" | "revision_conflict" | "validation_failed" | "kanban_project_required" | "metrics_need_terminal_status" | "pipeline_id_mismatch" | "confirm_replace_required" | "contract_too_large" | "metric_not_declared";
  readonly details: Record<string, unknown> | undefined;
  constructor(code: StoreError["code"], message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const iso = (ms: unknown): string => new Date(Number(ms)).toISOString();
const isoOrNull = (ms: unknown): string | null => (ms === null || ms === undefined ? null : iso(ms));
const json = <T>(v: unknown): T => JSON.parse(String(v)) as T;
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ── suggestions ──

function toSuggestion(r: Record<string, unknown>): Suggestion {
  return {
    id: String(r.id),
    title: String(r.title),
    summary: String(r.summary),
    source: r.source as Suggestion["source"],
    status: r.status as SuggestionStatus,
    agentId: strOrNull(r.agent_id),
    createdBy: json<Actor>(r.created_by),
    evidence: json<Evidence[]>(r.evidence),
    steps: json<Step[]>(r.steps),
    note: strOrNull(r.note),
    decidedAt: isoOrNull(r.decided_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function toRow(s: Suggestion): SuggestionRow {
  return { id: s.id, title: s.title, source: s.source, status: s.status, agentId: s.agentId, evidenceCount: s.evidence.length, createdAt: s.createdAt, updatedAt: s.updatedAt };
}

function addEvent(db: Db, suggestionId: string, type: string, actor: Actor, note: string | null, now: number): void {
  db.prepare("INSERT INTO suggestion_events (id, suggestion_id, type, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)").run(
    `sev_${ulid(now)}`,
    suggestionId,
    type,
    JSON.stringify(actor),
    note,
    now,
  );
}

export function dedupeEvidence(list: readonly Evidence[]): Evidence[] {
  const out: Evidence[] = [];
  for (const e of list) if (!out.some((x) => x.kind === e.kind && x.ref === e.ref && x.product === e.product)) out.push(e);
  return out;
}

export function createSuggestion(
  db: Db,
  input: {
    title: string;
    summary: string;
    source: Suggestion["source"];
    agentId: string | null;
    createdBy: Actor;
    evidence: Evidence[];
    steps: StepInput[];
    groupKey?: string | null;
  },
  now: number = Date.now(),
): Suggestion {
  const steps = normalizeSteps(input.steps);
  const id = `sug_${ulid(now)}`;
  db.prepare(
    "INSERT INTO suggestions (id, title, summary, source, status, agent_id, created_by, evidence, steps, group_key, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    input.title.trim(),
    input.summary.trim(),
    input.source,
    input.agentId,
    JSON.stringify(input.createdBy),
    JSON.stringify(dedupeEvidence(input.evidence)),
    JSON.stringify(steps),
    input.groupKey ?? null,
    now,
    now,
  );
  addEvent(db, id, "created", input.createdBy, null, now);
  return getSuggestion(db, id);
}

export function getSuggestion(db: Db, id: string): Suggestion {
  const r = db.prepare("SELECT * FROM suggestions WHERE id = ?").get(id);
  if (!r) throw new StoreError("not_found", "No suggestion with this id.");
  return toSuggestion(r);
}

/** `agentId` set: only suggestions that agent made or that are about its work (an agent never reads others'). */
export function listSuggestions(db: Db, f: { status?: SuggestionStatus; agentId?: string; limit: number }): Suggestion[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.status) {
    where.push("status = ?");
    args.push(f.status);
  }
  if (f.agentId) {
    where.push("(agent_id = ? OR json_extract(created_by, '$.id') = ?)");
    args.push(f.agentId, f.agentId);
  }
  const sql = `SELECT * FROM suggestions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`;
  return db
    .prepare(sql)
    .all(...args, f.limit)
    .map(toSuggestion);
}

const NEXT: Record<Decision, { to: SuggestionStatus; from: SuggestionStatus[] }> = {
  approve: { to: "approved", from: ["open", "rejected"] },
  reject: { to: "rejected", from: ["open", "approved"] },
  archive: { to: "archived", from: ["open", "approved", "rejected"] },
};

export function decideSuggestion(db: Db, id: string, decision: Decision, actor: Actor, note: string | null, now: number = Date.now()): Suggestion {
  return db.transaction(() => {
    const s = getSuggestion(db, id);
    const rule = NEXT[decision];
    if (s.status === rule.to) return s; // repeating a decision is a no-op
    if (!rule.from.includes(s.status)) throw new StoreError("conflict", `A ${s.status} suggestion cannot be ${rule.to}.`, { status: s.status });
    db.prepare("UPDATE suggestions SET status = ?, note = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(rule.to, note, now, now, id);
    addEvent(db, id, rule.to, actor, note, now);
    return getSuggestion(db, id);
  });
}

export function suggestionEvents(db: Db, id: string): { type: string; actor: Actor; note: string | null; at: string }[] {
  return db
    .prepare("SELECT type, actor, note, at FROM suggestion_events WHERE suggestion_id = ? ORDER BY at, id")
    .all(id)
    .map((r) => ({ type: String(r.type), actor: json<Actor>(r.actor), note: strOrNull(r.note), at: iso(r.at) }));
}

// ── detector bookkeeping ──

export function coveredIssues(db: Db): Set<string> {
  return new Set(
    db
      .prepare("SELECT issue_id FROM detector_covered")
      .all()
      .map((r) => String(r.issue_id)),
  );
}

export function openSuggestionForGroup(db: Db, groupKey: string): Suggestion | null {
  const r = db.prepare("SELECT * FROM suggestions WHERE group_key = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1").get(groupKey);
  return r ? toSuggestion(r) : null;
}

export function coverIssues(db: Db, suggestionId: string, issueIds: readonly string[], now: number = Date.now()): void {
  const ins = db.prepare("INSERT OR IGNORE INTO detector_covered (issue_id, suggestion_id, at) VALUES (?, ?, ?)");
  for (const i of issueIds) ins.run(i, suggestionId, now);
}

export function addEvidence(db: Db, id: string, more: readonly Evidence[], actor: Actor, now: number = Date.now()): Suggestion {
  const s = getSuggestion(db, id);
  const evidence = dedupeEvidence([...s.evidence, ...more]);
  db.prepare("UPDATE suggestions SET evidence = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(evidence), now, id);
  addEvent(db, id, "evidence_added", actor, `${evidence.length - s.evidence.length} more`, now);
  return getSuggestion(db, id);
}

// ── drafts ──

function toDraft(r: Record<string, unknown>): Draft {
  return {
    id: String(r.id),
    suggestionId: strOrNull(r.suggestion_id),
    templateId: strOrNull(r.template_id),
    workflowId: strOrNull(r.workflow_id),
    title: String(r.title),
    summary: String(r.summary),
    instruction: String(r.instruction),
    trigger: String(r.trigger_text),
    steps: json<Step[]>(r.steps),
    allowed: json<Allowed[]>(r.allowed),
    revision: Number(r.revision),
    state: r.state as Draft["state"],
    promotedVersion: r.promoted_version === null ? null : Number(r.promoted_version),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export function snapshotOf(d: Snapshot): Snapshot {
  return { title: d.title, summary: d.summary, instruction: d.instruction, trigger: d.trigger, steps: d.steps, allowed: d.allowed };
}

export function createDraft(
  db: Db,
  input: { suggestionId: string | null; templateId: string | null; snapshot: Snapshot; workflowId?: string | null },
  now: number = Date.now(),
): Draft {
  const s = input.snapshot;
  // workflowId: a new draft OF an existing workflow (pipeline_import asDraftOf); promoting it makes that workflow's next version
  const workflowId = input.workflowId ?? null;
  if (workflowId) getWorkflow(db, workflowId);
  const id = `wfd_${ulid(now)}`;
  db.prepare(
    "INSERT INTO drafts (id, suggestion_id, template_id, workflow_id, title, summary, instruction, trigger_text, steps, allowed, revision, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, ?)",
  ).run(
    id,
    input.suggestionId,
    input.templateId,
    workflowId,
    s.title,
    s.summary,
    s.instruction,
    s.trigger,
    JSON.stringify(normalizeSteps(s.steps)),
    JSON.stringify(normalizeAllowed(s.allowed)),
    now,
    now,
  );
  return getDraft(db, id);
}

export function getDraft(db: Db, id: string): Draft {
  const r = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id);
  if (!r) throw new StoreError("not_found", "No draft with this id.");
  return toDraft(r);
}

export function listDrafts(db: Db, f: { suggestionId?: string } = {}): Draft[] {
  const rows = f.suggestionId
    ? db.prepare("SELECT * FROM drafts WHERE suggestion_id = ? ORDER BY updated_at DESC, id DESC").all(f.suggestionId)
    : db.prepare("SELECT * FROM drafts ORDER BY updated_at DESC, id DESC LIMIT 500").all();
  return rows.map(toDraft);
}

export interface DraftPatch {
  title?: string;
  summary?: string;
  instruction?: string;
  trigger?: string;
  steps?: StepInput[];
  allowed?: Allowed[];
}

export function updateDraft(db: Db, id: string, revision: number, patch: DraftPatch, now: number = Date.now()): Draft {
  return db.transaction(() => {
    const d = getDraft(db, id);
    if (d.revision !== revision) throw new StoreError("revision_conflict", "The draft changed since you opened it. Reload it and apply your edit again.", { currentRevision: d.revision });
    const next: Snapshot = {
      title: patch.title?.trim() ?? d.title,
      summary: patch.summary?.trim() ?? d.summary,
      instruction: patch.instruction?.trim() ?? d.instruction,
      trigger: patch.trigger?.trim() ?? d.trigger,
      steps: patch.steps ? normalizeSteps(patch.steps) : d.steps,
      allowed: patch.allowed ? normalizeAllowed(patch.allowed) : d.allowed,
    };
    if (sameSnapshot(next, snapshotOf(d))) return d;
    db.prepare(
      "UPDATE drafts SET title = ?, summary = ?, instruction = ?, trigger_text = ?, steps = ?, allowed = ?, revision = revision + 1, state = 'open', updated_at = ? WHERE id = ?",
    ).run(next.title, next.summary, next.instruction, next.trigger, JSON.stringify(next.steps), JSON.stringify(next.allowed), now, id);
    return getDraft(db, id);
  });
}

// ── workflows and versions ──

function toWorkflow(r: Record<string, unknown>): Workflow {
  return {
    id: String(r.id),
    title: String(r.title),
    summary: String(r.summary),
    activeVersion: Number(r.active_version),
    draftId: String(r.draft_id),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toVersion(r: Record<string, unknown>): Version {
  return {
    workflowId: String(r.workflow_id),
    version: Number(r.version),
    ...json<Snapshot>(r.snapshot),
    draftId: String(r.draft_id),
    draftRevision: Number(r.draft_revision),
    promotedAt: iso(r.promoted_at),
  };
}

export function getWorkflow(db: Db, id: string): Workflow {
  const r = db.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
  if (!r) throw new StoreError("not_found", "No workflow with this id.");
  return toWorkflow(r);
}

export function listWorkflows(db: Db): Workflow[] {
  return db.prepare("SELECT * FROM workflows ORDER BY updated_at DESC, id DESC LIMIT 500").all().map(toWorkflow);
}

export function getVersion(db: Db, workflowId: string, version?: number): Version {
  const wf = getWorkflow(db, workflowId);
  const v = version ?? wf.activeVersion;
  const r = db.prepare("SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ?").get(workflowId, v);
  if (!r) throw new StoreError("not_found", `Workflow ${workflowId} has no version ${v}.`);
  return toVersion(r);
}

export function listVersions(db: Db, workflowId: string): Version[] {
  getWorkflow(db, workflowId);
  return db.prepare("SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version").all(workflowId).map(toVersion);
}

/** Where promote reports a closing eval it could not store (the handler passes ctx.log). */
export interface PromoteOptions {
  log?: { warn(msg: string, f?: Record<string, unknown>): void };
}

/** Draft → permanent workflow: version 1 on first promotion, then the next version of the same workflow, which closes
 *  the previous version's cycle: its closing eval is stored in the same transaction, best effort (see below). */
export function promote(db: Db, draftId: string, revision: number, now: number = Date.now(), opts: PromoteOptions = {}): { workflow: Workflow; version: Version } {
  return db.transaction(() => {
    const d = getDraft(db, draftId);
    if (d.revision !== revision) throw new StoreError("revision_conflict", "The draft changed since you reviewed it. Review it again before you promote.", { currentRevision: d.revision });
    const snap = snapshotOf(d);
    try {
      checkPromotable(snap);
    } catch (e) {
      throw new StoreError("validation_failed", e instanceof Error ? e.message : "The draft cannot be promoted.", { pointer: (e as { pointer?: string }).pointer ?? null });
    }
    if (d.state === "promoted" && d.workflowId) throw new StoreError("conflict", "Nothing changed since the last promotion.", { workflowId: d.workflowId, version: d.promotedVersion });
    let workflowId = d.workflowId;
    let version = 1;
    if (workflowId) {
      version = getWorkflow(db, workflowId).activeVersion + 1;
      db.prepare("UPDATE workflows SET title = ?, summary = ?, active_version = ?, updated_at = ? WHERE id = ?").run(snap.title, snap.summary, version, now, workflowId);
    } else {
      workflowId = `wfl_${ulid(now)}`;
      db.prepare("INSERT INTO workflows (id, title, summary, active_version, draft_id, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)").run(
        workflowId,
        snap.title,
        snap.summary,
        draftId,
        now,
        now,
      );
    }
    db.prepare("INSERT INTO workflow_versions (workflow_id, version, snapshot, draft_id, draft_revision, promoted_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      workflowId,
      version,
      JSON.stringify(snap),
      draftId,
      d.revision,
      now,
    );
    db.prepare("UPDATE drafts SET workflow_id = ?, state = 'promoted', promoted_version = ?, updated_at = ? WHERE id = ?").run(workflowId, version, now, draftId);
    // C288 R10: the pipeline contract the draft was imported from (if any) is frozen with this version
    db.prepare("INSERT INTO workflow_version_pipelines (workflow_id, version, pipeline_id, pipeline_version, source) SELECT ?, ?, pipeline_id, pipeline_version, source FROM pipeline_sources WHERE draft_id = ?").run(
      workflowId,
      version,
      draftId,
    );
    // The closing eval is best effort: a nested transaction (an SDK savepoint) so a failure rolls back the eval only,
    // never the promotion. Without a logger (store-level callers, tests) the failure is dropped: the live eval of the
    // retired cycle stays computed on read, and the owner can store one with cycle_eval_run.
    if (version > 1) {
      const closed = workflowId;
      try {
        db.transaction(() => storeEval(db, closed, version - 1, "promotion", now));
      } catch (e) {
        // ids, the error's own message and a store code only: no Task Board data reaches the log
        opts.log?.warn("closing eval not stored", {
          workflowId: closed,
          version: version - 1,
          error: e instanceof Error ? e.name : "unknown",
          message: e instanceof Error ? e.message : String(e),
          ...(e instanceof StoreError ? { code: e.code } : {}),
        });
      }
    }
    return { workflow: getWorkflow(db, workflowId), version: getVersion(db, workflowId, version) };
  });
}
