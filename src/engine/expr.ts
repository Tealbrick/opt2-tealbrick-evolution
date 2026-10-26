// Refs, `{{ }}` templates and the small safe expression set of the workflow contract (ENGINE-BUILD §2, C367).
//
// PURE: no imports, no I/O, no clock, no randomness. This file is bundled into the Temporal workflow sandbox, so it must
// stay deterministic (replay-safe). The expression language is DATA, not code: there is no eval, no Function, no property
// access outside a ref path, and no user-defined function. Operators: == != < <= > >= and or not in exists len join.
//
// Ref grammar:  $input.<path>  $trigger.<path>  $steps.<id>.output.<path>  $loop.item  $loop.index  $item  $index
//   <path> is a dotted path with optional [n] array indexes: `$steps.fetch.output.result.messages[0].subject`.
// Template:     "text {{ ref }} text {{ join($steps.a.output.list, ', ') }}". Functions inside a template: join, len, exists.
//   A string that is exactly one `{{ expr }}` keeps the TYPE of the expression (so it can feed an integer field);
//   anything else renders to a string. A string that is exactly one ref (`"$steps.slim.output"`) is a typed ref.
// Condition:    JSON form `{"==": ["$steps.a.output.ok", true]}`, `{"and": [...]}`, `{"not": x}`, `{"in": [needle, hay]}`,
//   `{"exists": ref}`, `{">": [{"len": ref}, 0]}`. Any other string is a literal; `{"lit": v}` makes a literal that looks like a ref.

export class ExprError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type PathSeg = string | number;
export type RefRoot = "input" | "trigger" | "steps" | "loop" | "item" | "index";
export interface Ref {
  root: RefRoot;
  /** segments after the root; for `steps` the first is the step id, the second `output` */
  segs: PathSeg[];
  text: string;
}

const REF_RE = /^\$(input|trigger|steps|loop|item|index)((?:\.[A-Za-z0-9_-]+|\[\d{1,6}\])*)$/;
const SEG_RE = /\.([A-Za-z0-9_-]+)|\[(\d{1,6})\]/g;

/** Parses `$root.a.b[0]`. Null when the text is not a ref (then it is a literal string). */
export function parseRef(text: string): Ref | null {
  const m = REF_RE.exec(text);
  if (!m) return null;
  const segs: PathSeg[] = [];
  const rest = m[2] ?? "";
  SEG_RE.lastIndex = 0;
  for (let s = SEG_RE.exec(rest); s; s = SEG_RE.exec(rest)) segs.push(s[1] !== undefined ? s[1] : Number(s[2]));
  const root = m[1] as RefRoot;
  if (root === "steps" && (segs.length < 2 || typeof segs[0] !== "string" || segs[1] !== "output")) return null;
  if (root === "loop" && !(segs.length >= 1 && (segs[0] === "item" || segs[0] === "index"))) return null;
  return { root, segs, text };
}

export interface Scope {
  input: unknown;
  trigger: unknown;
  steps: Record<string, { output: unknown } | undefined>;
  loop?: { item: unknown; index: number };
  /** inside a `map` / `filter` transform */
  item?: unknown;
  index?: number;
}

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

function descend(value: unknown, segs: readonly PathSeg[]): unknown {
  let cur: unknown = value;
  for (const s of segs) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof s === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[s];
    } else {
      if (FORBIDDEN.has(s) || typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = Object.hasOwn(cur, s) ? (cur as Record<string, unknown>)[s] : undefined;
    }
  }
  return cur;
}

/** Reads a path out of a value (own properties only). Undefined when anything on the way is missing. */
export function getPath(value: unknown, path: string): unknown {
  if (path === "" || path === ".") return value;
  const segs: PathSeg[] = [];
  SEG_RE.lastIndex = 0;
  for (let s = SEG_RE.exec(path.startsWith(".") || path.startsWith("[") ? path : `.${path}`); s; s = SEG_RE.exec(path.startsWith(".") || path.startsWith("[") ? path : `.${path}`)) segs.push(s[1] !== undefined ? s[1] : Number(s[2]));
  return descend(value, segs);
}

/** The value a ref points to, or undefined (never throws: a missing value is a normal case, `exists` tests for it). */
export function resolveRef(ref: Ref, scope: Scope): unknown {
  switch (ref.root) {
    case "input":
      return descend(scope.input, ref.segs);
    case "trigger":
      return descend(scope.trigger, ref.segs);
    case "steps": {
      const id = ref.segs[0] as string;
      if (FORBIDDEN.has(id) || !Object.hasOwn(scope.steps, id)) return undefined;
      return descend(scope.steps[id]?.output, ref.segs.slice(2));
    }
    case "loop": {
      if (!scope.loop) return undefined;
      const head = ref.segs[0];
      return descend(head === "item" ? scope.loop.item : scope.loop.index, ref.segs.slice(1));
    }
    case "item":
      return descend(scope.item, ref.segs);
    case "index":
      return scope.index;
  }
}

// ───────────────────────────── value expressions inside {{ }} ─────────────────────────────

export type ValueExpr = { k: "ref"; ref: Ref } | { k: "lit"; v: unknown } | { k: "call"; name: string; args: ValueExpr[] };
export type TemplatePart = { lit: string } | { expr: ValueExpr };

const TEMPLATE_FUNCTIONS: Readonly<Record<string, readonly [number, number]>> = { join: [1, 2], len: [1, 1], exists: [1, 1] };

type Tok = { t: "ref" | "str" | "num" | "ident" | "(" | ")" | ","; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c === "(" || c === ")" || c === ",") {
      out.push({ t: c, v: c });
      i++;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new ExprError("expr_syntax", "unterminated string");
        const d = src[j] as string;
        if (d === "\\") {
          const e = src[j + 1];
          if (e === undefined) throw new ExprError("expr_syntax", "unterminated string");
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
        } else if (d === c) {
          j++;
          break;
        } else {
          s += d;
          j++;
        }
      }
      out.push({ t: "str", v: s });
      i = j;
    } else if (c === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+|\[\d{1,6}\])*/.exec(src.slice(i));
      if (!m) throw new ExprError("expr_syntax", `bad ref at position ${i}`);
      out.push({ t: "ref", v: m[0] });
      i += m[0].length;
    } else if (/[0-9-]/.test(c)) {
      const m = /^-?\d+(?:\.\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError("expr_syntax", `bad number at position ${i}`);
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)) as RegExpExecArray;
      out.push({ t: "ident", v: m[0] });
      i += m[0].length;
    } else {
      throw new ExprError("expr_syntax", `unexpected character "${c}" at position ${i}`);
    }
  }
  return out;
}

/** Parses the inside of one `{{ }}`: a ref, a literal, or a call of join / len / exists. */
export function parseValueExpr(src: string): ValueExpr {
  const toks = tokenize(src);
  let p = 0;
  const parseOne = (depth: number): ValueExpr => {
    if (depth > 8) throw new ExprError("expr_syntax", "expression nested too deeply");
    const tok = toks[p++];
    if (!tok) throw new ExprError("expr_syntax", "empty expression");
    if (tok.t === "ref") {
      const ref = parseRef(tok.v);
      if (!ref) throw new ExprError("expr_ref", `"${tok.v}" is not a valid ref`);
      return { k: "ref", ref };
    }
    if (tok.t === "str") return { k: "lit", v: tok.v };
    if (tok.t === "num") return { k: "lit", v: Number(tok.v) };
    if (tok.t === "ident") {
      if (tok.v === "true") return { k: "lit", v: true };
      if (tok.v === "false") return { k: "lit", v: false };
      if (tok.v === "null") return { k: "lit", v: null };
      const arity = TEMPLATE_FUNCTIONS[tok.v];
      if (!arity) throw new ExprError("expr_function", `unknown function "${tok.v}" (allowed: join, len, exists)`);
      if (toks[p]?.t !== "(") throw new ExprError("expr_syntax", `"${tok.v}" needs ( )`);
      p++;
      const args: ValueExpr[] = [];
      if (toks[p]?.t !== ")") {
        for (;;) {
          args.push(parseOne(depth + 1));
          if (toks[p]?.t === ",") {
            p++;
            continue;
          }
          break;
        }
      }
      if (toks[p]?.t !== ")") throw new ExprError("expr_syntax", `missing ) after ${tok.v}(`);
      p++;
      if (args.length < arity[0] || args.length > arity[1]) throw new ExprError("expr_arity", `${tok.v} takes ${arity[0] === arity[1] ? arity[0] : `${arity[0]} to ${arity[1]}`} argument(s)`);
      return { k: "call", name: tok.v, args };
    }
    throw new ExprError("expr_syntax", `unexpected "${tok.v}"`);
  };
  const e = parseOne(0);
  if (p !== toks.length) throw new ExprError("expr_syntax", `unexpected "${toks[p]?.v}"`);
  return e;
}

const parseCache = new Map<string, TemplatePart[]>();

/** Splits a string into literal text and `{{ expr }}` parts. A string without `{{` is one literal part. */
export function parseTemplate(text: string): TemplatePart[] {
  const hit = parseCache.get(text);
  if (hit) return hit;
  const parts: TemplatePart[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{{", i);
    if (open < 0) {
      parts.push({ lit: text.slice(i) });
      break;
    }
    if (open > i) parts.push({ lit: text.slice(i, open) });
    const close = text.indexOf("}}", open + 2);
    if (close < 0) throw new ExprError("template_syntax", "a {{ is not closed");
    parts.push({ expr: parseValueExpr(text.slice(open + 2, close)) });
    i = close + 2;
  }
  if (parseCache.size > 2000) parseCache.clear();
  parseCache.set(text, parts);
  return parts;
}

function lenOf(v: unknown): number {
  if (typeof v === "string" || Array.isArray(v)) return v.length;
  if (v && typeof v === "object") return Object.keys(v).length;
  if (v === undefined || v === null) return 0;
  throw new ExprError("expr_type", "len needs a string, list or object");
}

export function stringify(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function joinOf(list: unknown, sep: unknown): string {
  if (list === undefined || list === null) return "";
  if (!Array.isArray(list)) throw new ExprError("expr_type", "join needs a list");
  return list.map(stringify).join(sep === undefined ? ", " : stringify(sep));
}

export function evalValueExpr(e: ValueExpr, scope: Scope): unknown {
  switch (e.k) {
    case "lit":
      return e.v;
    case "ref":
      return resolveRef(e.ref, scope);
    case "call": {
      const args = e.args.map((a) => evalValueExpr(a, scope));
      if (e.name === "join") return joinOf(args[0], args[1]);
      if (e.name === "len") return lenOf(args[0]);
      return args[0] !== undefined && args[0] !== null; // exists
    }
  }
}

/** True when the text holds at least one `{{`. */
export function hasTemplate(text: string): boolean {
  return text.includes("{{");
}

/** Renders one string: a lone `{{ expr }}` keeps its type, other text renders to a string. */
export function renderString(text: string, scope: Scope): unknown {
  const ref = parseRef(text);
  if (ref) {
    const v = resolveRef(ref, scope);
    return v === undefined ? null : v;
  }
  if (!hasTemplate(text)) return text;
  const parts = parseTemplate(text);
  if (parts.length === 1 && "expr" in (parts[0] as TemplatePart)) {
    const v = evalValueExpr((parts[0] as { expr: ValueExpr }).expr, scope);
    return v === undefined ? null : v;
  }
  let out = "";
  for (const part of parts) out += "lit" in part ? part.lit : stringify(evalValueExpr(part.expr, scope));
  return out;
}

/** Evaluates a value tree (a step input, a transform template): strings are refs or templates, objects and lists recurse. */
export function renderTree(tree: unknown, scope: Scope, depth = 0): unknown {
  if (depth > 32) throw new ExprError("value_depth", "value nested too deeply");
  if (typeof tree === "string") return renderString(tree, scope);
  if (Array.isArray(tree)) return tree.map((x) => renderTree(x, scope, depth + 1));
  if (tree && typeof tree === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(tree)) {
      if (FORBIDDEN.has(k)) continue;
      out[k] = renderTree(v, scope, depth + 1);
    }
    return out;
  }
  return tree;
}

/** Every ref in a value tree (strings that are a ref, and the refs inside `{{ }}`), with the JSON pointer where it was found. */
export function collectRefs(tree: unknown, pointer = "", out: { ref: Ref; pointer: string }[] = [], depth = 0): { ref: Ref; pointer: string }[] {
  if (depth > 32) throw new ExprError("value_depth", "value nested too deeply");
  if (typeof tree === "string") {
    const ref = parseRef(tree);
    if (ref) {
      out.push({ ref, pointer });
      return out;
    }
    if (hasTemplate(tree)) for (const part of parseTemplate(tree)) if ("expr" in part) collectExprRefs(part.expr, pointer, out);
    return out;
  }
  if (Array.isArray(tree))
    tree.forEach((x, i) => {
      collectRefs(x, `${pointer}/${i}`, out, depth + 1);
    });
  else if (tree && typeof tree === "object") for (const [k, v] of Object.entries(tree)) collectRefs(v, `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`, out, depth + 1);
  return out;
}

function collectExprRefs(e: ValueExpr, pointer: string, out: { ref: Ref; pointer: string }[]): void {
  if (e.k === "ref") out.push({ ref: e.ref, pointer });
  else if (e.k === "call") for (const a of e.args) collectExprRefs(a, pointer, out);
}

// ───────────────────────────── condition expressions (JSON form) ─────────────────────────────

export const EXPR_OPS = ["==", "!=", "<", "<=", ">", ">=", "and", "or", "not", "in", "exists", "len", "join", "lit"] as const;
export type ExprOp = (typeof EXPR_OPS)[number];
const ARITY: Readonly<Record<ExprOp, readonly [number, number]>> = {
  "==": [2, 2],
  "!=": [2, 2],
  "<": [2, 2],
  "<=": [2, 2],
  ">": [2, 2],
  ">=": [2, 2],
  and: [1, 16],
  or: [1, 16],
  not: [1, 1],
  in: [2, 2],
  exists: [1, 1],
  len: [1, 1],
  join: [1, 2],
  lit: [1, 1],
};

export interface ExprIssue {
  pointer: string;
  message: string;
}

/** The op of an expression object (`{"==": [...]}`), or null when the value is not an operator object. */
function opOf(x: unknown): ExprOp | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const keys = Object.keys(x);
  if (keys.length !== 1) return null;
  return (EXPR_OPS as readonly string[]).includes(keys[0] as string) ? (keys[0] as ExprOp) : null;
}

function argsOf(op: ExprOp, x: unknown): unknown[] {
  const raw = (x as Record<string, unknown>)[op];
  if (op === "not" || op === "exists" || op === "len" || op === "lit") return [raw];
  return Array.isArray(raw) ? raw : [raw];
}

/** Shape check of an expression: known operators, arity, depth, refs that parse. Does not look at the data. */
export function checkExpr(x: unknown, pointer = "", issues: ExprIssue[] = [], depth = 0): ExprIssue[] {
  if (depth > 12) {
    issues.push({ pointer, message: "expression nested too deeply (12 levels)" });
    return issues;
  }
  if (typeof x === "string") {
    if (x.startsWith("$") && !parseRef(x)) issues.push({ pointer, message: `"${x}" is not a valid ref` });
    else if (hasTemplate(x)) issues.push({ pointer, message: "{{ }} templates are not allowed inside a condition; use a ref or an operator" });
    return issues;
  }
  if (Array.isArray(x)) {
    x.forEach((e, i) => {
      checkExpr(e, `${pointer}/${i}`, issues, depth + 1);
    });
    return issues;
  }
  if (x && typeof x === "object") {
    const op = opOf(x);
    if (!op) {
      issues.push({ pointer, message: `an expression object has exactly one key, one of: ${EXPR_OPS.join(" ")}` });
      return issues;
    }
    if (op === "lit") return issues;
    const raw = (x as Record<string, unknown>)[op];
    if (["==", "!=", "<", "<=", ">", ">=", "and", "or", "in"].includes(op) && !Array.isArray(raw)) {
      issues.push({ pointer: `${pointer}/${op}`, message: `"${op}" takes a list` });
      return issues;
    }
    const args = argsOf(op, x);
    const [lo, hi] = ARITY[op];
    if (args.length < lo || args.length > hi) issues.push({ pointer: `${pointer}/${op}`, message: `"${op}" takes ${lo === hi ? lo : `${lo} to ${hi}`} argument(s)` });
    args.forEach((a, i) => {
      checkExpr(a, `${pointer}/${op}${["not", "exists", "len"].includes(op) ? "" : `/${i}`}`, issues, depth + 1);
    });
  }
  return issues;
}

/** Every ref in an expression, with its pointer. */
export function exprRefs(x: unknown, pointer = "", out: { ref: Ref; pointer: string }[] = []): { ref: Ref; pointer: string }[] {
  if (typeof x === "string") {
    const ref = parseRef(x);
    if (ref) out.push({ ref, pointer });
  } else if (Array.isArray(x))
    x.forEach((e, i) => {
      exprRefs(e, `${pointer}/${i}`, out);
    });
  else if (x && typeof x === "object") {
    const op = opOf(x);
    if (op && op !== "lit")
      argsOf(op, x).forEach((a, i) => {
        exprRefs(a, `${pointer}/${op}/${i}`, out);
      });
  }
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b as object, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function order(a: unknown, b: unknown, op: string): boolean {
  if ((typeof a === "number" && typeof b === "number") || (typeof a === "string" && typeof b === "string")) {
    if (op === "<") return a < b;
    if (op === "<=") return a <= b;
    if (op === ">") return a > b;
    return a >= b;
  }
  if (a === undefined || a === null || b === undefined || b === null) return false;
  throw new ExprError("expr_type", `"${op}" compares two numbers or two strings`);
}

/** Evaluates an expression against a scope. Throws ExprError only for a real type error; a missing value is undefined. */
export function evalExpr(x: unknown, scope: Scope, depth = 0): unknown {
  if (depth > 12) throw new ExprError("expr_depth", "expression nested too deeply");
  if (typeof x === "string") {
    const ref = parseRef(x);
    return ref ? resolveRef(ref, scope) : x;
  }
  if (Array.isArray(x)) return x.map((e) => evalExpr(e, scope, depth + 1));
  if (x && typeof x === "object") {
    const op = opOf(x);
    if (!op) throw new ExprError("expr_syntax", "not an expression");
    if (op === "lit") return argsOf(op, x)[0];
    const args = argsOf(op, x);
    switch (op) {
      case "and": {
        for (const a of args) if (!truthy(evalExpr(a, scope, depth + 1))) return false;
        return true;
      }
      case "or": {
        for (const a of args) if (truthy(evalExpr(a, scope, depth + 1))) return true;
        return false;
      }
      case "not":
        return !truthy(evalExpr(args[0], scope, depth + 1));
      case "exists": {
        const v = evalExpr(args[0], scope, depth + 1);
        return v !== undefined && v !== null;
      }
      case "len":
        return lenOf(evalExpr(args[0], scope, depth + 1));
      case "join":
        return joinOf(evalExpr(args[0], scope, depth + 1), args[1] === undefined ? undefined : evalExpr(args[1], scope, depth + 1));
      default:
        break;
    }
    const a = evalExpr(args[0], scope, depth + 1);
    const b = evalExpr(args[1], scope, depth + 1);
    switch (op) {
      case "==":
        return deepEqual(a, b);
      case "!=":
        return !deepEqual(a, b);
      case "in": {
        if (Array.isArray(b)) return b.some((e) => deepEqual(e, a));
        if (typeof b === "string") return typeof a === "string" && b.includes(a);
        if (b && typeof b === "object") return typeof a === "string" && Object.hasOwn(b, a);
        return false;
      }
      default:
        return order(a, b, op);
    }
  }
  return x;
}

export function truthy(v: unknown): boolean {
  return v !== undefined && v !== null && v !== false && v !== 0 && v !== "";
}

/** Condition result as a strict boolean (a non-boolean result is read by `truthy`). */
export function evalCondition(x: unknown, scope: Scope): boolean {
  return truthy(evalExpr(x, scope));
}
