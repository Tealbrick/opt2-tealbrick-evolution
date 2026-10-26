// Workflow model: the pure rules for steps, allowed operations, versions and diffs. No database, no SDK.
// Harvested from the v1 workflow runtime (suggestion → draft → permanent version → diff), reduced to what opt2 enforces:
// a Bound agent's grant lists allowed operations per product; nothing enforces step order or arguments.

export type Crud = "create" | "read" | "update" | "delete";
export interface StepOp {
  product: string;
  operation: string;
}
export interface Step {
  id: string;
  title: string;
  instruction: string;
  ops: StepOp[];
}
export interface StepInput {
  id?: string;
  title: string;
  instruction?: string;
  ops?: StepOp[];
}
export interface Allowed {
  product: string;
  operations: string[];
  crud: Crud[];
}
/** What a version freezes. */
export interface Snapshot {
  title: string;
  summary: string;
  instruction: string;
  trigger: string;
  steps: Step[];
  allowed: Allowed[];
}

export const CRUD_ORDER: readonly Crud[] = ["create", "read", "update", "delete"];

/** The one honest sentence (G11): the bridge enforces the operation list, not the steps. */
export const ALLOWLIST_NOTICE =
  "The agent may call these operations; the bridge blocks every other operation. The steps are guidance the owner reviewed: nothing forces the agent to follow them in order or with given inputs.";

/** The same honest sentence for a schedule that targets a FREE agent (C364a R1a): there is no run token and no recipe yet,
 *  so the operation list is guidance only. Shown to the Free caller (`workflow_get`) and in the Schedules page. */
export const freeTargetNotice = (agentName: string): string =>
  `Runs with ${agentName}'s own access. The operation list is guidance until per-run narrowing (C288 R2–R4).`;

/** Thrown for input the owner or agent must fix (mapped to 422 validation_failed by the app). */
export class ModelError extends Error {
  readonly pointer: string | null;
  constructor(message: string, pointer: string | null = null) {
    super(message);
    this.pointer = pointer;
  }
}

/** Steps get stable ids (`s1`, `s2`, … unless given) so versions can be compared step by step. */
export function normalizeSteps(input: readonly StepInput[]): Step[] {
  const seen = new Set<string>();
  let n = 0;
  return input.map((s, i) => {
    let id = s.id;
    if (!id) {
      do id = `s${++n}`;
      while (seen.has(id) || input.some((x) => x.id === id));
    }
    if (seen.has(id)) throw new ModelError(`Step ${i + 1}: the id "${id}" is used twice.`, `/steps/${i}/id`);
    seen.add(id);
    const ops = dedupeOps(s.ops ?? []);
    return { id, title: s.title.trim(), instruction: (s.instruction ?? "").trim(), ops };
  });
}

function dedupeOps(ops: readonly StepOp[]): StepOp[] {
  const out: StepOp[] = [];
  for (const o of ops) if (!out.some((x) => x.product === o.product && x.operation === o.operation)) out.push({ product: o.product, operation: o.operation });
  return out;
}

/** One entry per product, operations sorted and unique, CRUD in canonical order. */
export function normalizeAllowed(input: readonly Allowed[]): Allowed[] {
  const by = new Map<string, { ops: Set<string>; crud: Set<Crud> }>();
  for (const a of input) {
    const cur = by.get(a.product) ?? { ops: new Set<string>(), crud: new Set<Crud>() };
    for (const o of a.operations) cur.ops.add(o);
    for (const c of a.crud) cur.crud.add(c);
    by.set(a.product, cur);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([product, v]) => ({ product, operations: [...v.ops].sort(), crud: CRUD_ORDER.filter((c) => v.crud.has(c)) }));
}

/** Default CRUD for a product's allowed operations, from the op names (the owner can change it before promoting). */
export function guessCrud(operations: readonly string[]): Crud[] {
  const set = new Set<Crud>(["read"]);
  for (const op of operations) {
    if (/(^|_)(create|add|remember|write|send|post|start|ask|submit|dm|reply|schedule)(_|$)/.test(op)) set.add("create");
    if (/(^|_)(update|set|edit|move|complete|block|link|rename|react|decide)(_|$)/.test(op)) set.add("update");
    if (/(^|_)(delete|remove|archive|unlink|cancel)(_|$)/.test(op)) set.add("delete");
  }
  return CRUD_ORDER.filter((c) => set.has(c));
}

/** Allowed operations implied by the steps (used when a draft starts from a suggestion). */
export function allowedFromSteps(steps: readonly Step[]): Allowed[] {
  const by = new Map<string, Set<string>>();
  for (const s of steps) for (const o of s.ops) by.set(o.product, (by.get(o.product) ?? new Set()).add(o.operation));
  return normalizeAllowed([...by.entries()].map(([product, ops]) => ({ product, operations: [...ops], crud: guessCrud([...ops]) })));
}

/** Rules checked before promotion: something to allow, every step op inside the allowlist. */
export function checkPromotable(s: Snapshot): void {
  if (!s.title.trim()) throw new ModelError("The workflow needs a title.", "/title");
  if (!s.instruction.trim()) throw new ModelError("The workflow needs an instruction for the Bound agent.", "/instruction");
  if (s.allowed.length === 0 || s.allowed.every((a) => a.operations.length === 0))
    throw new ModelError("List at least one operation the Bound agent may call.", "/allowed");
  s.steps.forEach((step, i) => {
    step.ops.forEach((o, j) => {
      const a = s.allowed.find((x) => x.product === o.product);
      if (!a?.operations.includes(o.operation))
        throw new ModelError(`Step "${step.title}" uses ${o.product}.${o.operation}, which is not in the allowed operations.`, `/steps/${i}/ops/${j}`);
    });
  });
  s.allowed.forEach((a, i) => {
    if (a.crud.length === 0) throw new ModelError(`Choose the access (CRUD) for ${a.product}.`, `/allowed/${i}/crud`);
  });
}

export function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const opKeys = (allowed: readonly Allowed[]): Set<string> => new Set(allowed.flatMap((a) => a.operations.map((o) => `${a.product}.${o}`)));
const crudKeys = (allowed: readonly Allowed[]): Set<string> => new Set(allowed.flatMap((a) => a.crud.map((c) => `${a.product}:${c}`)));

export interface Diff {
  fields: { field: string; from: string; to: string }[];
  steps: { added: string[]; removed: string[]; changed: { id: string; title: string; fields: string[] }[] };
  operations: { added: string[]; removed: string[] };
  widensAccess: boolean;
}

/** Version diff (harvest of v1 workflow diffs, computed instead of stored): text fields, steps by id, operations. */
export function diffSnapshots(from: Snapshot, to: Snapshot): Diff {
  const fields: Diff["fields"] = [];
  for (const f of ["title", "summary", "instruction", "trigger"] as const) if (from[f] !== to[f]) fields.push({ field: f, from: from[f], to: to[f] });
  const before = new Map(from.steps.map((s) => [s.id, s]));
  const after = new Map(to.steps.map((s) => [s.id, s]));
  const added = to.steps.filter((s) => !before.has(s.id)).map((s) => s.title);
  const removed = from.steps.filter((s) => !after.has(s.id)).map((s) => s.title);
  const changed: Diff["steps"]["changed"] = [];
  for (const s of to.steps) {
    const p = before.get(s.id);
    if (!p) continue;
    const f: string[] = [];
    if (p.title !== s.title) f.push("title");
    if (p.instruction !== s.instruction) f.push("instruction");
    if (JSON.stringify(p.ops) !== JSON.stringify(s.ops)) f.push("ops");
    if (from.steps.indexOf(p) !== to.steps.indexOf(s)) f.push("order");
    if (f.length) changed.push({ id: s.id, title: s.title, fields: f });
  }
  const opsFrom = opKeys(from.allowed);
  const opsTo = opKeys(to.allowed);
  const crudFrom = crudKeys(from.allowed);
  const opsAdded = [...opsTo].filter((k) => !opsFrom.has(k)).sort();
  const opsRemoved = [...opsFrom].filter((k) => !opsTo.has(k)).sort();
  const widensAccess = opsAdded.length > 0 || [...crudKeys(to.allowed)].some((k) => !crudFrom.has(k));
  return { fields, steps: { added, removed, changed }, operations: { added: opsAdded, removed: opsRemoved }, widensAccess };
}

export function diffNotice(d: Diff): string {
  if (d.widensAccess)
    return "This version allows more than the previous one. An existing Bound agent keeps its old operation list until you change its policy in Portal (agents.policy_set needs your confirmation), for example by applying the recipe of this version.";
  if (d.operations.removed.length)
    return "This version allows less. Update the Bound agent's policy in Portal so the bridge blocks the removed operations.";
  return "The allowed operations did not change; a running Bound agent reads the new text with workflow_get.";
}
