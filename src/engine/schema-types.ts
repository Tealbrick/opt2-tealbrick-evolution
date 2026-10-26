// A small reader of JSON Schema for the draft-time type checks (ENGINE-BUILD §3 "Typing and composition"): what type does a
// ref have, and may that type go into the consumer's schema? Lenient where the schema says too little (unknown = accepted),
// strict where it says enough (a definite type clash, a missing required field, a value outside an enum).
import type { PathSeg } from "./expr.ts";
import type { Json } from "./json.ts";

export type Schema = { [k: string]: Json } | undefined;
const BASE = ["string", "number", "integer", "boolean", "null", "object", "array"] as const;
type Base = (typeof BASE)[number];

function obj(v: Json | undefined): { [k: string]: Json } | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

/** The JSON types a schema allows; null when the schema does not say. */
export function typesOf(s: Schema): Base[] | null {
  if (!s) return null;
  const t = s.type;
  if (typeof t === "string" && (BASE as readonly string[]).includes(t)) return [t as Base];
  if (Array.isArray(t)) {
    const ok = t.filter((x): x is Base => typeof x === "string" && (BASE as readonly string[]).includes(x));
    if (ok.length) return ok;
  }
  if (Array.isArray(s.enum) && s.enum.length) {
    const set = new Set<Base>();
    for (const e of s.enum) set.add(e === null ? "null" : Array.isArray(e) ? "array" : typeof e === "object" ? "object" : (typeof e as Base));
    return [...set];
  }
  if ("const" in s) {
    const c = s.const;
    return [c === null ? "null" : Array.isArray(c) ? "array" : typeof c === "object" ? "object" : (typeof c as Base)];
  }
  if (obj(s.properties)) return ["object"];
  if (s.items !== undefined && typeof s.items === "object") return ["array"];
  return null;
}

/** The schema of `segs` below `s`: a schema, undefined (the schema does not say), or "missing" (it says there is nothing). */
export function schemaAt(s: Schema, segs: readonly PathSeg[]): Schema | "missing" {
  let cur: Schema = s;
  for (const seg of segs) {
    if (!cur) return undefined;
    if (cur.anyOf || cur.oneOf || cur.allOf) return undefined;
    const types = typesOf(cur);
    if (typeof seg === "number") {
      if (types && !types.includes("array")) return "missing";
      cur = obj(cur.items);
    } else {
      if (types && !types.includes("object")) return "missing";
      const props = obj(cur.properties);
      if (props && Object.hasOwn(props, seg)) cur = obj(props[seg]);
      else {
        const ap = cur.additionalProperties;
        if (obj(ap)) cur = obj(ap);
        else if (ap === false || (props && types?.includes("object") && cur.additionalProperties === false)) return "missing";
        else return undefined;
      }
    }
  }
  return cur;
}

function accepts(dst: readonly Base[], src: Base): boolean {
  return dst.includes(src) || (src === "integer" && dst.includes("number"));
}

export interface Clash {
  severity: "error" | "warning";
  message: string;
}

/** Whether a value of schema `src` may go where `dst` is expected. Null = fine or not decidable. */
export function clash(src: Schema, dst: Schema, path = "", depth = 0): Clash | null {
  if (!src || !dst || depth > 8) return null;
  if (src.anyOf || src.oneOf || dst.anyOf || dst.oneOf || dst.allOf || src.allOf) return null;
  const st = typesOf(src);
  const dt = typesOf(dst);
  const at = path ? ` at ${path}` : "";
  if (st && dt) {
    const bad = st.filter((t) => !accepts(dt, t));
    if (bad.length === st.length) return { severity: "error", message: `type ${st.join("|")} cannot go into ${dt.join("|")}${at}` };
    if (bad.length > 0 && bad.every((t) => t === "null")) return { severity: "warning", message: `the value may be null but ${dt.join("|")} is expected${at}` };
    if (bad.length > 0) return { severity: "error", message: `type ${bad.join("|")} cannot go into ${dt.join("|")}${at}` };
  }
  const se = Array.isArray(src.enum) ? src.enum : "const" in src ? [src.const as Json] : null;
  const de = Array.isArray(dst.enum) ? dst.enum : "const" in dst ? [dst.const as Json] : null;
  if (se && de) {
    const out = se.filter((v) => !de.some((d) => JSON.stringify(d) === JSON.stringify(v)));
    if (out.length) return { severity: "error", message: `value ${JSON.stringify(out[0])} is not allowed${at} (allowed: ${de.map((d) => JSON.stringify(d)).join(", ")})` };
  } else if (de && st && !se && st.every((t) => t === "string")) {
    return { severity: "warning", message: `any string may go into a fixed list of values${at}` };
  }
  if (st?.includes("object") && dt?.includes("object")) {
    const sp = obj(src.properties);
    const dp = obj(dst.properties);
    const req = Array.isArray(dst.required) ? dst.required.filter((x): x is string => typeof x === "string") : [];
    if (sp) {
      const sreq = Array.isArray(src.required) ? src.required : [];
      for (const r of req) {
        if (!Object.hasOwn(sp, r)) {
          return { severity: src.additionalProperties === false ? "error" : "warning", message: `required field "${r}" is not in the value${at}` };
        } else if (!sreq.includes(r)) return { severity: "warning", message: `field "${r}"${at} is optional here but required there` };
      }
      if (dp) for (const [k, ds] of Object.entries(dp)) if (Object.hasOwn(sp, k)) {
        const c = clash(obj(sp[k]), obj(ds), `${path}/${k}`, depth + 1);
        if (c) return c;
      }
    }
  }
  if (st?.includes("array") && dt?.includes("array")) {
    const c = clash(obj(src.items), obj(dst.items), `${path}[]`, depth + 1);
    if (c) return c;
  }
  return null;
}

/** The schema of a JSON literal. */
export function schemaOfLiteral(v: unknown): Schema {
  if (v === null) return { type: "null" };
  if (typeof v === "string") return { type: "string" };
  if (typeof v === "boolean") return { type: "boolean" };
  if (typeof v === "number") return { type: Number.isInteger(v) ? "integer" : "number" };
  if (Array.isArray(v)) return { type: "array" };
  return { type: "object" };
}
