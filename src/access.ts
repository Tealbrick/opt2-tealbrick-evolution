// C380 B7: Evolving Workflows answers `tb.access/1` (Governance reads what the app lets an agent do, and may pause schedules).
// Two agent ops, appended last in the manifest with `listing: "workflow"`: `access_list` (read) and `access_revoke` (write).
//   routine               a schedule that runs for an agent (`automations.agent_id`). The only kind that can be revoked: it is paused.
//   workflow_agent_step   an `ai` step of an ACTIVE workflow version that names the agent (`by.agent`). Listed, never revoked.
//   schedule_of_workflow  a schedule of a workflow whose version uses the agent. Listed, never revoked ("manual").
// Never in this lane: Temporal (no call to it in the revoke path), acting tickets, any delete. A pause is `enabled = 0`.
// Guard (every call): the caller is an app, its VERIFIED product is `fleet`, and the signed slice still lists it (`listed`).
// Bind to Core (S2-6): a routine of an agent is paused only when the SIGNED slice shows that agent `paused` or removed
// (`ctx.paused(agent).agent`, which counts an unknown agent as paused). A running agent answers `not_revocable` / `agent_running`.
// Evolution cannot list calls that are held for an approval: `notShown` says so, and `complete` stays false (a stated limit).
import { digest as jcsDigest } from "@opt2-tealbrick/manifest";
import { type Db, type HandlerSpec, type OpContext, type SdkOpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { OP } from "#kit";
import { walkSteps } from "./engine/contract.ts";
import * as engineStore from "./engine/engine-store.ts";
import * as routines from "./routines.ts";
import { StoreError } from "./store.ts";

/** The one product allowed to call these ops. */
export const FLEET_PRODUCT = "fleet";
const TARGET = "evolution";
/** Placeholder agent of a workflow moved from 0.3.x (src/migrate/contract.ts): not an agent, never listed. */
const UNASSIGNED_AGENT = "agt_unassigned";
const DEFAULT_LIMIT = 100;
const LABEL_MAX = 120;

// The shapes of spec 0.1.89 (docs/ACCESS.md, packages/spec/src/access.ts). Written here because this app pins spec 0.1.87, and the
// kit generator types a `$ref` schema as unknown. test/contracts holds the byte copies of the spec schemas; the manifest embeds them.
export type Subject = { kind: "agent"; id: string } | { kind: "person"; id: string; handles: string[] } | { kind: "unlinked" } | { kind: "all" };
export interface AccessItem {
  id: string;
  kind: "routine" | "workflow_agent_step" | "schedule_of_workflow";
  subject: { kind: "agent" | "person"; id: string } | { kind: "unlinked" };
  resource: string;
  direction: "held_by" | "about";
  level: "read" | "write" | "use" | "info";
  label: string;
  state: "active" | "paused" | "scheduled" | "dormant";
  revocable: boolean;
  since?: string;
  digest: string;
}
export interface ListIn {
  v: 1;
  subjects: Subject[];
  cursor?: string;
  limit?: number;
  sweepId?: string;
}
export interface ListOut {
  v: 1;
  asOf: string;
  sweepId?: string;
  items: AccessItem[];
  nextCursor: string | null;
  notShown: { kind: string; reason: string }[];
  complete: boolean;
}
export interface RevokeIn {
  v: 1;
  plan: string;
  attempt: number;
  subject: { kind: "agent" | "person"; id: string };
  items: { id: string; digest: string }[];
}
export interface RevokeResult {
  id: string;
  outcome: "revoked" | "already_gone" | "changed" | "not_revocable" | "failed";
  code?: string;
  detail?: string;
}
export interface RevokeOut {
  v: 1;
  asOf: string;
  results: RevokeResult[];
}

type Item = AccessItem;
type Result = RevokeResult;

// ── guard ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `no_access`: not the Governance app. `caller_unverified`: the product or the slice entry is not proven. Fail closed. */
export function guardFleet(ctx: OpContext): void {
  const c = ctx.caller as { type?: unknown; product?: unknown; listed?: unknown };
  if (c.type !== "app") throw new TbError("no_access", "Only the Governance app may call this.", 403);
  if (typeof c.product !== "string" || c.product === "") throw new TbError("caller_unverified", "The calling app is not verified.", 403);
  if (c.product !== FLEET_PRODUCT) throw new TbError("no_access", "Only the Governance app may call this.", 403);
  if (c.listed !== true) throw new TbError("caller_unverified", "The calling app is not in the current workspace list.", 403);
}

// ── items ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Plain one-line text for the owner: no control, bidi or format characters, no markup brackets, at most `max` characters. */
export function plain(s: string, max = LABEL_MAX): string {
  const t = s
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** `sha256:` + hex of JCS {v:1, target, id, kind, subject, resource, level}. Not state, since, label, revocable or direction. */
export function itemDigest(i: Pick<Item, "id" | "kind" | "subject" | "resource" | "level">): string {
  return jcsDigest({ v: 1, target: TARGET, id: i.id, kind: i.kind, subject: i.subject, resource: i.resource, level: i.level });
}

function make(base: Omit<Item, "digest" | "direction" | "level" | "subject"> & { agent: string }): Item {
  const { agent, ...rest } = base;
  const core = { ...rest, subject: { kind: "agent" as const, id: agent }, direction: "held_by" as const, level: "use" as const };
  return { ...core, digest: itemDigest(core) };
}

const routineId = (automationId: string): string => `routine:${automationId}`;

function routineItems(db: Db): Item[] {
  const rows = db
    .prepare("SELECT a.id, a.agent_id, a.enabled, a.created_at, w.title FROM automations a LEFT JOIN workflows w ON w.id = a.workflow_id WHERE a.deleted_at IS NULL")
    .all();
  return rows.map((r) =>
    make({
      id: routineId(String(r.id)),
      kind: "routine",
      agent: String(r.agent_id),
      resource: String(r.id),
      label: plain(`Schedule of the workflow "${r.title ?? "unknown"}" runs for this agent`),
      state: Number(r.enabled) === 1 ? "scheduled" : "paused",
      revocable: true,
      since: iso(Number(r.created_at)),
    }),
  );
}

/** Agents named by `ai` steps (`by.agent`) of a contract, with the step; the placeholder agent is skipped. */
function agentSteps(contract: engineStore.Definition["contract"]): { agent: string; stepId: string; title: string }[] {
  const out: { agent: string; stepId: string; title: string }[] = [];
  walkSteps(contract.steps, (s) => {
    if (s.type !== "ai" || !("agent" in s.by)) return;
    const agent = s.by.agent;
    if (typeof agent === "string" && agent.startsWith("agt_") && agent !== UNASSIGNED_AGENT) out.push({ agent, stepId: s.id, title: s.title ?? s.id });
  });
  return out;
}

function stepItems(db: Db): Item[] {
  const rows = db
    .prepare("SELECT d.workflow_id, d.version, d.title, d.contract, a.activated_at FROM engine_activations a JOIN engine_definitions d ON d.workflow_id = a.workflow_id AND d.version = a.version WHERE a.state = 'active'")
    .all();
  const out: Item[] = [];
  for (const r of rows) {
    const contract = JSON.parse(String(r.contract)) as engineStore.Definition["contract"];
    for (const s of agentSteps(contract)) {
      const resource = `${String(r.workflow_id)}:${s.stepId}`;
      out.push(
        make({
          id: `workflow_agent_step:${resource}`,
          kind: "workflow_agent_step",
          agent: s.agent,
          resource,
          label: plain(`Workflow "${String(r.title)}": this agent does the step "${s.title}"`),
          state: "active",
          revocable: false,
          since: iso(Number(r.activated_at)),
        }),
      );
    }
  }
  return out;
}

function scheduleItems(db: Db): Item[] {
  const out: Item[] = [];
  for (const sch of engineStore.listSchedules(db)) {
    const active = engineStore.activeActivation(db, sch.workflowId);
    const version = sch.versionPin ?? active?.version ?? null;
    const def = version === null ? null : engineStore.getDefinition(db, sch.workflowId, version);
    if (!def) continue;
    const live = active?.version === def.version;
    const agents = [...new Set(agentSteps(def.contract).map((s) => s.agent))];
    for (const agent of agents) {
      out.push(
        make({
          id: `schedule_of_workflow:${sch.id}:${agent}`,
          kind: "schedule_of_workflow",
          agent,
          resource: sch.id,
          label: plain(`A schedule starts the workflow "${def.title}", which uses this agent. Change it in Evolving Workflows`),
          state: sch.paused ? "paused" : live ? "scheduled" : "dormant",
          revocable: false,
          since: sch.createdAt,
        }),
      );
    }
  }
  return out;
}

/** Every item of this app, sorted by id (a stable order for paging). */
export function allItems(db: Db): Item[] {
  return [...routineItems(db), ...stepItems(db), ...scheduleItems(db)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── access_list ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const NOT_SHOWN: ListOut["notShown"] = [{ kind: "held_call", reason: "Calls that wait for an owner approval are not listed by this version." }];

const refuse = (message: string, pointer: string): TbError => new TbError("validation_failed", message, 422, { pointer });

/** The agent ids a request asks for; null = every agent (`all`). A person or an unlinked subject has no item here. */
function askedAgents(subjects: readonly Subject[]): Set<string> | null {
  if (subjects.some((s) => s.kind === "all")) {
    if (subjects.length !== 1) throw refuse("The subject all must be the only subject.", "/subjects");
    return null;
  }
  return new Set(subjects.filter((s): s is Extract<Subject, { kind: "agent" }> => s.kind === "agent").map((s) => s.id));
}

const encodeCursor = (id: string): string => Buffer.from(JSON.stringify({ v: 1, after: id }), "utf8").toString("base64url");
function decodeCursor(c: string): string {
  try {
    const o = JSON.parse(Buffer.from(c, "base64url").toString("utf8")) as { v?: unknown; after?: unknown };
    if (o.v === 1 && typeof o.after === "string" && o.after !== "") return o.after;
  } catch {
    // falls through
  }
  throw refuse("This cursor is not valid. Start again without a cursor.", "/cursor");
}

export function listAccess(db: Db, input: ListIn, now: number = Date.now()): ListOut {
  const asked = askedAgents(input.subjects);
  const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const all = asked !== null && asked.size === 0 ? [] : allItems(db).filter((i) => asked === null || (i.subject.kind === "agent" && asked.has(i.subject.id)));
  const rest = after === null ? all : all.filter((i) => i.id > after);
  const page = rest.slice(0, limit);
  const nextCursor = rest.length > limit ? encodeCursor((page[page.length - 1] as Item).id) : null;
  const notShown = NOT_SHOWN;
  return { v: 1, asOf: iso(now), ...(input.sweepId === undefined ? {} : { sweepId: input.sweepId }), items: page, nextCursor, notShown, complete: nextCursor === null && notShown.length === 0 };
}

// ── access_revoke ───────────────────────────────────────────────────────────────────────────────────────────────────────

const MANUAL = "Evolving Workflows has no automatic stop for this. Change the workflow or its schedule in Evolving Workflows.";

/** `ctx.paused(agent).agent` is true for a paused agent AND for one that is not in the signed slice. No answer = running (fail closed). */
function stoppedInSlice(ctx: OpContext, agent: string): boolean {
  const fn = (ctx as Partial<SdkOpContext>).paused;
  if (typeof fn !== "function") return false;
  return fn.call(ctx, agent).agent === true;
}

/** A pause that cannot depend on the workflow still being editable: `pauseAutomation` first, a plain `enabled = 0` when it refuses. */
function pause(db: Db, id: string, revision: number, now: number): void {
  try {
    routines.pauseAutomation(db, id, revision, true, now);
  } catch (e) {
    if (!(e instanceof StoreError)) throw e;
    const r = db.prepare("UPDATE automations SET enabled = 0, revision = revision + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL AND enabled = 1").run(now, id);
    if (Number(r.changes) !== 1) throw e;
  }
}

function revokeOne(db: Db, ctx: OpContext, subject: RevokeIn["subject"], item: { id: string; digest: string }, now: number): Result {
  const id = item.id;
  if (subject.kind !== "agent") return { id, outcome: "not_revocable", code: "subject_not_supported", detail: "Evolving Workflows lists schedules of agents only." };
  if (id.startsWith("workflow_agent_step:") || id.startsWith("schedule_of_workflow:")) return { id, outcome: "not_revocable", code: "manual", detail: MANUAL };
  if (!id.startsWith("routine:")) return { id, outcome: "not_revocable", code: "unknown_kind", detail: "Evolving Workflows does not know this kind of item." };
  if (!stoppedInSlice(ctx, subject.id)) return { id, outcome: "not_revocable", code: "agent_running", detail: "The agent is not stopped in the workspace list. Stop the agent first." };
  return db.transaction((): Result => {
    const row = db.prepare("SELECT id, agent_id, enabled, revision, deleted_at FROM automations WHERE id = ?").get(id.slice("routine:".length));
    if (!row || row.deleted_at !== null) return { id, outcome: "already_gone" };
    const live = { id, kind: "routine" as const, subject: { kind: "agent" as const, id: String(row.agent_id) }, resource: String(row.id), level: "use" as const };
    if (live.subject.id !== subject.id || itemDigest(live) !== item.digest) return { id, outcome: "changed", code: "digest_changed", detail: "This schedule changed after the list was read." };
    if (Number(row.enabled) !== 1) return { id, outcome: "already_gone", code: "already_paused" };
    pause(db, String(row.id), Number(row.revision), now);
    return { id, outcome: "revoked" };
  });
}

export function revokeAccess(db: Db, ctx: OpContext, input: RevokeIn, now: number = Date.now()): RevokeOut {
  if (new Set(input.items.map((i) => i.id)).size !== input.items.length) throw refuse("An item may appear once.", "/items");
  const results = input.items.map((item): Result => {
    try {
      return revokeOne(db, ctx, input.subject, item, now);
    } catch (e) {
      ctx.log.warn("access_revoke: an item failed", { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
      return { id: item.id, outcome: "failed", code: "internal", detail: "This item could not be paused. Try again." };
    }
  });
  ctx.log.info("access_revoke", { plan: input.plan, attempt: input.attempt, revoked: results.filter((r) => r.outcome === "revoked").length, items: results.length });
  return { v: 1, asOf: iso(now), results };
}

// ── handlers ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const op = <I, O>(run: (input: I, ctx: OpContext) => Promise<O>): HandlerSpec => ({ run }) as unknown as HandlerSpec;

export function accessHandlers() {
  return {
    [OP.accessList]: op(async (input: ListIn, ctx) => {
      guardFleet(ctx);
      return listAccess(ctx.db, input);
    }),
    [OP.accessRevoke]: op(async (input: RevokeIn, ctx) => {
      guardFleet(ctx);
      return revokeAccess(ctx.db, ctx, input);
    }),
  };
}
