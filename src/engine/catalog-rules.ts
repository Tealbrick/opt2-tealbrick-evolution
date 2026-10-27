// What the engine knows about the operations of the apps it may call (no JSON import: pure, shared by the sync script,
// the validator and the tests). The data itself is `target-ops.json` (src/engine/catalog.ts).
import type { Json } from "./json.ts";

export type CrudAction = "create" | "read" | "update" | "delete";
export type JsonSchemaLike = { [k: string]: Json };

export interface TargetOp {
  id: string;
  audience: "agent" | "person";
  crud: CrudAction[];
  effect: "read" | "write" | "outward" | "destructive" | "money" | string;
  holdFamily?: string;
  scopeType?: string;
  idempotency: "none" | "supported" | "required";
  input?: JsonSchemaLike;
  output?: JsonSchemaLike;
  /** a dynamic op (Connect `tools`): its input is `{tool, arguments}` and the real op is the tool.
   *  `crudCeiling`: the most the tools behind it may do (the app's own declaration). `tools`: the resolved crud of a tool by name,
   *  when the snapshot carries it (today it does not: the SDK shows no installed tool list). */
  dynamic?: { mode: string; crudCeiling?: CrudAction[]; tools?: Record<string, CrudAction[]> };
}

const CRUD_CANON: readonly CrudAction[] = ["read", "create", "update", "delete"];

/**
 * What a call of `op` may do with CRUD. A fixed op: its own `crud`. A dynamic op (Connect `tools`) is the tool the step names:
 * that tool's resolved crud when the snapshot has it, else the op's `crudCeiling` (the most any tool may do), else the op's
 * own `crud`. The op's `crud` alone ("read" for `tools`) is only the search part: a tool can still create or update.
 */
export function crudOfCall(op: TargetOp, tool?: string): CrudAction[] {
  if (!op.dynamic) return [...op.crud];
  const own = tool !== undefined && Object.hasOwn(op.dynamic.tools ?? {}, tool) ? op.dynamic.tools?.[tool] : undefined;
  const crud = own?.length ? own : op.dynamic.crudCeiling?.length ? op.dynamic.crudCeiling : op.crud;
  return CRUD_CANON.filter((c) => crud.includes(c));
}
export interface TargetApp {
  id: string;
  version: string;
  operations: TargetOp[];
}
export type TargetCatalog = Record<string, TargetApp>;

/** The apps in Evolving Workflows' SUPERSET companion block (ENGINE-BUILD §4, M1). */
export const COMPANION_PRODUCTS = ["kanban", "knowledge", "inbox", "rules", "connect"] as const;

/** Ops of those apps that the engine never calls, even though they are agent ops. `item_decide_dm`: only Connect may call it
 *  (it relays the owner's click on a DM alert); a workflow that could call it could approve its own approval. */
export const NEVER_COMPANION_OPS: Readonly<Record<string, readonly string[]>> = { inbox: ["item_decide_dm"] };

/**
 * The companion ops of one target app, the least privilege that still matches ENGINE-BUILD §4:
 *  - agent audience only;
 *  - effect `read` or `write` (the `destructive`, `outward` and `money` ops stay out: a delete or a send is not in the
 *    superset; the owner adds it later with its own decision);
 *  - Connect: its read ops plus the dynamic `tools` op;
 *  - never the ops in NEVER_COMPANION_OPS.
 */
export function companionOps(app: TargetApp): TargetOp[] {
  const denied = NEVER_COMPANION_OPS[app.id] ?? [];
  return app.operations.filter((o) => {
    if (o.audience !== "agent" || denied.includes(o.id)) return false;
    if (app.id === "connect") return o.effect === "read" || o.id === "tools";
    return o.effect === "read" || o.effect === "write";
  });
}

const PURPOSE: Readonly<Record<string, string>> = {
  kanban: "Spots repeated done work, records each scheduled run as an issue, and lets approved workflow steps read and write Task Board work.",
  knowledge: "Approved workflow steps read the knowledge base and may add notes or documents.",
  inbox: "Approval steps ask the owner in Inbox and read the answer. Nothing else in Inbox changes.",
  rules: "Approved workflow steps may read why a rule decided and may propose a rule draft for the owner.",
  connect: "Approved workflow steps read connected services (mail, calendars, data) and call the tools the owner approved.",
};

export interface CompanionEntry {
  product: string;
  operations: string[];
  crud: CrudAction[];
  purpose: string;
}

const CRUD_ORDER: readonly CrudAction[] = ["read", "create", "update", "delete"];

/** The wildcard companion (M-CP-3): `tb.holds_pending`, read only, after the owner's consent. A held app step waits for the owner and the
 *  engine reads which holds are still pending (the fallback when the bridge has no `app_hold_status`). */
export const HOLDS_PENDING_COMPANION: CompanionEntry = {
  product: "*",
  operations: ["tb.holds_pending"],
  crud: ["read"],
  purpose: "Lets a workflow wait for the owner to decide a held call: it reads which holds are still pending. Read only.",
};

/** The `companions` block of the manifest, derived from the target apps: crud = the union of the listed ops' crud (M-CP-2), then the wildcard. */
export function companionBlock(apps: TargetCatalog): CompanionEntry[] {
  const entries = COMPANION_PRODUCTS.flatMap((p) => {
    const app = apps[p];
    if (!app) return [];
    const ops = companionOps(app);
    const crud = CRUD_ORDER.filter((c) => ops.some((o) => o.crud.includes(c)));
    return [{ product: p, operations: ops.map((o) => o.id), crud: [...crud], purpose: PURPOSE[p] as string }];
  });
  return [...entries, HOLDS_PENDING_COMPANION];
}
