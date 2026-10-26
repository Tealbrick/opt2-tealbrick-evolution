// `transform` step (C367 condition 1): deterministic data shaping. No code, no AI, no I/O.
// PURE and replay-safe: it runs INSIDE the workflow code (Temporal sandbox), so it uses no clock, no randomness and no
// Node API. One step has exactly one op:
//   pick      {key: valueTree}            build an object from refs / templates / literals
//   merge     [refs] | {key: ref}         shallow-merge objects (list) or build an object from whole values (map)
//   rename    {from, map: {old: new}}     rename keys of an object, or of every object in a list
//   concat    {items: [..], separator?}   lists -> one list; anything else -> one string
//   template  "text {{ ref }}"            a string
//   map       {forEach, template}         one rendered value per element (`$item`, `$index`)
//   filter    {from, where}               keep elements for which the expression is true (`$item`)
//   dedupe    {from, by?}                 keep the first element per value (by a path, or the whole element)
//   sort      {from, by?, order?}         stable sort, asc (default) or desc
//   normalise {from, fields?, ops}        trim, lowercase, uppercase, collapse_spaces, date, phone on a value or on fields
import { deepEqual, ExprError, evalCondition, getPath, parseRef, renderString, renderTree, type Scope, stringify } from "./expr.ts";

export const TRANSFORM_OPS = ["pick", "merge", "rename", "concat", "template", "map", "filter", "dedupe", "sort", "normalise"] as const;
export type TransformOp = (typeof TRANSFORM_OPS)[number];
export const NORMALISE_OPS = ["trim", "lowercase", "uppercase", "collapse_spaces", "date", "phone"] as const;
export type NormaliseOp = (typeof NORMALISE_OPS)[number];

export interface TransformSpec {
  pick?: Record<string, unknown>;
  merge?: unknown[] | Record<string, unknown>;
  rename?: { from: string; map: Record<string, string> };
  concat?: { items: unknown[]; separator?: string };
  template?: string;
  map?: { forEach: string; template: unknown };
  filter?: { from: string; where: unknown };
  dedupe?: { from: string; by?: string };
  sort?: { from: string; by?: string; order?: "asc" | "desc" };
  normalise?: { from: string; fields?: string[]; ops: NormaliseOp[] };
}

/** The one op a transform step uses (null when none or several). */
export function opOfTransform(step: object): TransformOp | null {
  const found = TRANSFORM_OPS.filter((o) => Object.hasOwn(step, o));
  return found.length === 1 ? (found[0] as TransformOp) : null;
}

const MAX_ITEMS = 5000;

function list(v: unknown, what: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ExprError("transform_type", `${what} must be a list`);
  if (v.length > MAX_ITEMS) throw new ExprError("transform_size", `${what} has more than ${MAX_ITEMS} elements`);
  return v;
}

function plainObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function valueOfRef(text: string, scope: Scope): unknown {
  const v = renderString(text, scope);
  return v === null ? undefined : v;
}

/** ISO date (YYYY-MM-DD) or ISO date-time from the common input forms; unparseable input is returned unchanged. */
export function normaliseDate(s: string): string {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const dmy = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(t);
  if (dmy) {
    const [, d, m, y] = dmy as unknown as [string, string, string, string];
    const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? s : iso;
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) return s;
  const iso = new Date(ms).toISOString();
  return /T00:00:00\.000Z$/.test(iso) && /^\d{4}-\d{2}-\d{2}$/.test(t) ? iso.slice(0, 10) : iso;
}

export function normalisePhone(s: string): string {
  const t = s.trim();
  const digits = t.replace(/[^0-9]/g, "");
  if (digits.length === 0) return "";
  if (t.startsWith("+")) return `+${digits}`;
  if (t.startsWith("00")) return `+${digits.slice(2)}`;
  return digits;
}

function applyOps(v: unknown, ops: readonly NormaliseOp[]): unknown {
  if (typeof v !== "string") return v;
  let s = v;
  for (const op of ops) {
    if (op === "trim") s = s.trim();
    else if (op === "lowercase") s = s.toLowerCase();
    else if (op === "uppercase") s = s.toUpperCase();
    else if (op === "collapse_spaces") s = s.replace(/\s+/g, " ").trim();
    else if (op === "date") s = normaliseDate(s);
    else if (op === "phone") s = normalisePhone(s);
  }
  return s;
}

function setPath(obj: Record<string, unknown>, path: string, fn: (v: unknown) => unknown): void {
  const keys = path.split(".").filter((k) => k !== "");
  if (keys.some((k) => k === "__proto__" || k === "prototype" || k === "constructor")) return;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = plainObject(cur[keys[i] as string]);
    if (!next) return;
    cur = next;
  }
  const last = keys[keys.length - 1];
  if (last !== undefined && Object.hasOwn(cur, last)) cur[last] = fn(cur[last]);
}

function cloneJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloneJson);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = cloneJson(x);
    return o;
  }
  return v;
}

function key(v: unknown, by: string | undefined): unknown {
  return by === undefined ? v : getPath(v, by);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = a === undefined || a === null ? "" : typeof a === "string" ? a : stringify(a);
  const sb = b === undefined || b === null ? "" : typeof b === "string" ? b : stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Runs one transform op against the scope. Throws ExprError for bad input (a missing optional value is not an error). */
export function runTransform(spec: TransformSpec, scope: Scope): unknown {
  if (spec.pick !== undefined) return renderTree(spec.pick, scope);
  if (spec.template !== undefined) {
    const v = renderString(spec.template, scope);
    return typeof v === "string" ? v : stringify(v);
  }
  if (spec.merge !== undefined) {
    if (Array.isArray(spec.merge)) {
      const out: Record<string, unknown> = {};
      for (const part of spec.merge) {
        const v = renderTree(part, scope);
        const o = plainObject(v);
        if (v !== null && v !== undefined && !o) throw new ExprError("transform_type", "merge of a list takes objects");
        if (o) for (const [k, x] of Object.entries(o)) out[k] = x;
      }
      return out;
    }
    return renderTree(spec.merge, scope);
  }
  if (spec.rename !== undefined) {
    const src = valueOfRef(spec.rename.from, scope);
    const one = (o: unknown): unknown => {
      const obj = plainObject(o);
      if (!obj) return o;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[Object.hasOwn(spec.rename?.map ?? {}, k) ? (spec.rename?.map[k] as string) : k] = v;
      return out;
    };
    return Array.isArray(src) ? list(src, "rename.from").map(one) : one(src);
  }
  if (spec.concat !== undefined) {
    const items = spec.concat.items.map((x) => renderTree(x, scope));
    const defined = items.filter((x) => x !== null && x !== undefined);
    if (defined.length > 0 && defined.every((x) => Array.isArray(x))) return defined.flatMap((x) => list(x, "concat item"));
    return defined.map(stringify).join(spec.concat.separator ?? "");
  }
  if (spec.map !== undefined) {
    const items = list(valueOfRef(spec.map.forEach, scope), "map.forEach");
    return items.map((item, index) => renderTree(spec.map?.template, { ...scope, item, index }));
  }
  if (spec.filter !== undefined) {
    const items = list(valueOfRef(spec.filter.from, scope), "filter.from");
    return items.filter((item, index) => evalCondition(spec.filter?.where, { ...scope, item, index }));
  }
  if (spec.dedupe !== undefined) {
    const items = list(valueOfRef(spec.dedupe.from, scope), "dedupe.from");
    const seen: unknown[] = [];
    const out: unknown[] = [];
    for (const item of items) {
      const k = key(item, spec.dedupe.by);
      if (seen.some((s) => deepEqual(s, k))) continue;
      seen.push(k);
      out.push(item);
    }
    return out;
  }
  if (spec.sort !== undefined) {
    const items = list(valueOfRef(spec.sort.from, scope), "sort.from").map((v, i) => ({ v, i }));
    const dir = spec.sort.order === "desc" ? -1 : 1;
    items.sort((a, b) => dir * compare(key(a.v, spec.sort?.by), key(b.v, spec.sort?.by)) || a.i - b.i);
    return items.map((x) => x.v);
  }
  if (spec.normalise !== undefined) {
    const src = valueOfRef(spec.normalise.from, scope);
    const { fields, ops } = spec.normalise;
    const one = (v: unknown): unknown => {
      if (!fields || fields.length === 0) return applyOps(v, ops);
      if (!plainObject(v)) return v;
      const copy = cloneJson(v) as Record<string, unknown>;
      for (const f of fields) setPath(copy, f, (x) => applyOps(x, ops));
      return copy;
    };
    return Array.isArray(src) ? list(src, "normalise.from").map(one) : one(src);
  }
  throw new ExprError("transform_op", "a transform step needs exactly one op");
}

/** Refs a transform names in its `from` / `forEach` fields (plain ref strings, not templates). */
export function isRefString(s: unknown): s is string {
  return typeof s === "string" && parseRef(s) !== null;
}
