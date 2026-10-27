// validateContract(): everything a draft must satisfy before an owner may activate it (ENGINE-BUILD §2 "Draft checks").
//   1. structure           the JSON Schema (contract-schema.ts)
//   2. refs                every `$input` / `$steps` / `$trigger` / `$loop` ref resolves, in execution order, in scope
//   3. types               a ref's source schema fits its consumer (an app op input, a loop list, ...)
//   4. bounds              loops have a bound; parallel <= 8; steps <= 200; nesting; sub-workflow depth <= 3
//   5. targets             an `app` step names an agent-audience op of an app in the target catalog and in this app's companions
//   6. idempotency         an op that writes and has no idempotency is refused unless the step says `onFail: "ask"`
//   7. model roles         `ai.by.role` is one of MODEL_ROLES
// The result lists every problem (errors stop activation; warnings do not) and, when there is no error, the list of
// operations the workflow uses (`uses`), which is what activation shows the owner and stores for the engine's narrowing.
import { nextCronTime, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { UNASSIGNED_AGENT } from "../migrate/contract.ts";
import type { TargetCatalog, TargetOp } from "./catalog.ts";
import { currentCatalog, findOp } from "./catalog.ts";
import { crudOfCall } from "./catalog-rules.ts";
import { type AiStep, type ApprovalStep, type AppStep, type ConditionStep, type JsonSchemaObject, type LoopStep, type ParallelStep, type Step, type TimerStep, type TransformStep, type WorkflowContract, type WorkflowStep, walkSteps } from "./contract.ts";
import { CONTRACT_SCHEMA, LIMITS } from "./contract-schema.ts";
import { checkExpr, ExprError, exprRefs, hasTemplate, type PathSeg, parseRef, parseTemplate, type Ref, type ValueExpr } from "./expr.ts";
import type { Json, JsonObject } from "./json.ts";
import { MODEL_ROLES } from "./model-roles.ts";
import { TEXT_ROLES } from "./model-text-roles.ts";
import { clash, type Schema, schemaAt, schemaOfLiteral, typesOf } from "./schema-types.ts";
import { opOfTransform, TRANSFORM_OPS } from "./transform.ts";

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  /** JSON pointer into the contract */
  path: string;
  message: string;
  stepId?: string;
}

/** One operation a workflow version calls: what activation shows and what the engine's narrowing allows. */
export interface OpUse {
  product: string;
  op: string;
  crud: string[];
  effect: string;
  holdFamily?: string;
  scopeType?: string;
  idempotency: string;
  /** step ids (or "trigger") that call it */
  steps: string[];
  /** a dynamic op (Connect `tools`): the tool names the workflow calls; the engine refuses any other tool */
  tools?: string[];
  /** F4: listed because a CHILD workflow calls it (workflow step); the engine never lets the parent's own steps use these */
  via?: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** present when ok */
  uses: OpUse[];
  /** the type of each step output, as far as it is known (the owner UI shows it) */
  stepTypes: Record<string, Schema>;
}

export interface ValidateOptions {
  /** the target apps' operations; default: the bundled snapshot (src/engine/target-ops.json) or the injected test catalog */
  catalog?: TargetCatalog;
  /** this app's companion entries: an op outside them is `not_declared` (the bridge would refuse it). null = do not check. */
  companions?: readonly { product: string; operations: readonly string[] }[] | null;
  /** looks up a stored contract for a `workflow` step */
  lookupWorkflow?: (id: string, version?: number) => WorkflowContract | null;
  /** model roles; default MODEL_ROLES */
  modelRoles?: readonly string[];
  /** the owner ops (check, save, activate) set this: an ai step that still names the 0.3.x placeholder agent is an error (`agent_unassigned`).
   *  Default false: the 0.3.x migration validates the contracts it makes, and those carry the placeholder until the owner picks an agent. */
  refusePlaceholderAgent?: boolean;
}

// ajv follow-on messages of a step-kind schema: when a precise problem exists at or under the same pointer they only add noise.
// The editor drops them too (src/ui/FieldIssues.tsx `plainIssues`); keep the two rules the same (test/engine/validate.test.ts compares them).
const CASCADE = [/^must match "[^"]*" schema$/, /^must match exactly one schema in oneOf$/, /^must match a schema in anyOf$/];
const UNEVALUATED = /^must NOT have unevaluated properties$/;
const coversPath = (at: string, path: string): boolean => path === at || path.startsWith(`${at}/`);

/** The schema problems without their follow-on noise ("must match "then" schema", "must NOT have unevaluated properties") when a
 *  more precise problem at or under the same pointer says what is wrong; a repeated problem is listed once. */
export function dropSchemaNoise<T extends { path: string; message: string }>(list: readonly T[]): T[] {
  const noise = (m: string): boolean => CASCADE.some((r) => r.test(m)) || UNEVALUATED.test(m);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const i of list) {
    if (noise(i.message) && list.some((o) => o !== i && !noise(o.message) && coversPath(i.path, o.path))) continue;
    if (CASCADE.some((r) => r.test(i.message)) && list.some((o) => o !== i && UNEVALUATED.test(o.message) && o.path === i.path)) continue;
    const key = `${i.path}|${i.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  return out;
}

interface SScope {
  input: Schema;
  trigger: Schema;
  steps: Map<string, Schema>;
  /** null = not inside a loop; otherwise the schema of one element */
  loopItem: Schema | null;
  /** inside a transform `map` / `filter` template: the schema of `$item` (null = not inside one) */
  itemSchema: Schema | null;
}

const RESERVED_IDS = new Set(["constructor", "prototype", "output", "input", "trigger"]);
const NO_FIELDS: Schema = { type: "object", additionalProperties: false, properties: {} };
const asSchema = (v: Json | undefined): Schema => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);

export function validateContract(contract: unknown, opts: ValidateOptions = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const stepTypes: Record<string, Schema> = {};
  const uses = new Map<string, OpUse>();
  const catalog = opts.catalog ?? currentCatalog();
  const roles: readonly string[] = opts.modelRoles ?? MODEL_ROLES;
  const err = (code: string, path: string, message: string, stepId?: string): void => {
    errors.push({ severity: "error", code, path, message, ...(stepId ? { stepId } : {}) });
  };
  const warn = (code: string, path: string, message: string, stepId?: string): void => {
    warnings.push({ severity: "warning", code, path, message, ...(stepId ? { stepId } : {}) });
  };
  const done = (): ValidationResult => ({ ok: errors.length === 0, errors, warnings, uses: errors.length === 0 ? [...uses.values()].sort((a, b) => `${a.product}.${a.op}`.localeCompare(`${b.product}.${b.op}`)) : [], stepTypes });

  // ── 1. structure ──
  if (contract === null || typeof contract !== "object") {
    err("schema_invalid", "", "the contract must be an object");
    return done();
  }
  const structural = validateAgainstSchema(CONTRACT_SCHEMA as never, contract as never);
  if (!structural.ok) {
    for (const e of dropSchemaNoise(structural.errors)) {
      // only a MISSING max is "unbounded"; max 0 or 201 keeps its precise message ("must be >= 1")
      const unbounded = e.path.endsWith("/max") && /required/.test(e.message) ? "loop_unbounded" : "schema_invalid";
      err(unbounded, e.path, unbounded === "loop_unbounded" ? "a loop needs a bound: set max (1 to 200)" : e.message);
    }
    return done();
  }
  const c = contract as WorkflowContract;

  // ── ids, counts, nesting ──
  const ids = new Map<string, string>();
  let count = 0;
  let maxDepth = 0;
  walkSteps(c.steps, (s, info) => {
    count++;
    maxDepth = Math.max(maxDepth, info.depth);
    if (ids.has(s.id)) err("duplicate_id", `${info.path}/id`, `the step id "${s.id}" is used twice (first at ${ids.get(s.id)}); step ids are unique in the whole workflow`, s.id);
    else ids.set(s.id, info.path);
    if (RESERVED_IDS.has(s.id)) err("reserved_id", `${info.path}/id`, `"${s.id}" is a reserved word`, s.id);
    if (s.type === "loop" && s.max > LIMITS.loopContinueAsNew && !info.topLevel) err("loop_bound_nested", `${info.path}/max`, `a loop above ${LIMITS.loopContinueAsNew} items must be a top-level step (it continues as new)`, s.id);
  });
  const maxSteps = Math.min(c.limits?.maxSteps ?? LIMITS.maxSteps, LIMITS.maxSteps);
  if (count > maxSteps) err("too_many_steps", "/steps", `the workflow has ${count} steps; the limit is ${maxSteps}`);
  if (maxDepth + 1 > LIMITS.maxNesting) err("nesting_too_deep", "/steps", `steps nest ${maxDepth + 1} levels deep; the limit is ${LIMITS.maxNesting}`);

  // ── input schema and trigger schema ──
  let inputSchema: Schema = NO_FIELDS;
  if (c.inputs) {
    const t = typesOf(c.inputs);
    if (t && !t.includes("object")) err("inputs_not_object", "/inputs", "inputs must be a JSON Schema of type object");
    else if (compile(c.inputs) !== null) err("inputs_schema", "/inputs", `inputs is not a valid JSON Schema: ${compile(c.inputs)}`);
    else inputSchema = c.inputs;
  }
  const triggerSchema: Schema = {
    type: "object",
    additionalProperties: false,
    properties: { kind: { type: "string" }, date: { type: "string" }, firedAt: { type: "string" }, timezone: { type: "string" }, input: inputSchema as Json, item: {}, cursor: {}, previousCursor: {}, scheduleId: { type: "string" }, event: {} },
  };

  c.triggers.forEach((t, i) => {
    const p = `/triggers/${i}`;
    if (t.kind === "schedule") {
      if ((t.cron === undefined) === (t.every === undefined)) err("schedule_spec", p, "a schedule trigger needs exactly one of cron or every");
      try {
        nextCronTime(t.cron ?? "* * * * *", Date.now(), { tz: t.timezone });
      } catch (e) {
        err("schedule_spec", `${p}/${(e as { code?: string }).code === "tz_invalid" ? "timezone" : "cron"}`, e instanceof Error ? e.message : "invalid schedule");
      }
      if (t.every !== undefined && /^[1-9][0-9]{0,3}m$/.test(t.every) && Number(t.every.slice(0, -1)) < 1) err("schedule_spec", `${p}/every`, "the interval is too short");
      if (t.input) validateInputObject(t.input, `${p}/input`);
    } else if (t.kind === "manual") {
      if (t.inputs) validateInputObject(t.inputs, `${p}/inputs`);
    } else if (t.kind === "poll") {
      const op = checkTargetOp(t.product, t.op, `${p}`, "trigger", true);
      if (op && op.effect !== "read") err("poll_not_read", p, `a poll trigger must call a read op; ${t.product}.${t.op} is ${op.effect}`);
      else if (op) {
        let tool: string | undefined;
        if (op.dynamic) {
          const named = t.input?.tool;
          if (typeof named !== "string" || hasTemplate(named) || parseRef(named)) err("dynamic_tool_not_static", `${p}/input/tool`, `${t.product}.${t.op} calls a tool by name; write the tool name in the trigger`);
          else tool = named;
        } else if (t.input) {
          const r = validateAgainstSchema((op.input ?? { type: "object", additionalProperties: false }) as never, t.input as never);
          if (!r.ok) err("type_mismatch", `${p}/input`, `the poll input does not fit ${t.product}.${t.op}: ${r.errors.map((e) => e.message).join("; ")}`);
        }
        // a poll reads by definition (poll_not_read above): its access is read whichever tool it names
        addUse(op, t.product, "trigger", tool, ["read"]);
      }
    } else if (t.kind === "event") {
      warn("event_trigger_pending", p, "event triggers need app event subscriptions (P2); until then the same workflow runs from a poll trigger");
    }
  });

  function validateInputObject(values: JsonObject, path: string): void {
    // defaults may be partial: check the types of the given fields, not the required list
    const { required: _required, ...partial } = (inputSchema ?? {}) as { [k: string]: Json };
    const r = validateAgainstSchema(partial as never, values as never);
    if (!r.ok) for (const e of r.errors) err("input_default_invalid", `${path}${e.path}`, `${e.message}: the value does not fit the workflow inputs`);
  }

  // ── helpers over the catalog ──
  function compile(schema: JsonSchemaObject): string | null {
    const r = validateAgainstSchema(schema as never, null as never);
    if (!r.ok && r.errors.some((e) => e.message.startsWith("schema not compilable"))) return r.errors[0]?.message.replace("schema not compilable: ", "") ?? "invalid";
    return null;
  }

  function checkTargetOp(product: string, opId: string, path: string, stepId: string | undefined, forTrigger = false): TargetOp | null {
    const app = catalog[product];
    if (!app) {
      err("unknown_product", `${path}/product`, `no app "${product}" is known to the engine (known: ${Object.keys(catalog).join(", ")})`, stepId);
      return null;
    }
    const op = findOp(catalog, product, opId);
    if (!op) {
      err("unknown_op", `${path}/op`, `${product} has no operation "${opId}" in version ${app.version}`, stepId);
      return null;
    }
    if (op.audience !== "agent") {
      err("not_agent_op", `${path}/op`, `${product}.${opId} is an owner (person) operation; a workflow may call agent operations only`, stepId);
      return null;
    }
    if (opts.companions !== null && opts.companions !== undefined) {
      const comp = opts.companions.find((x) => x.product === product);
      if (!comp?.operations.includes(opId)) {
        err("not_declared", `${path}/op`, `${product}.${opId} is not in this app's companion list, so the bridge would refuse the call`, stepId);
        return null;
      }
    }
    if (!forTrigger && op.effect !== "read" && op.idempotency === "none") {
      // the caller checks onFail; recorded by the app-step branch
    }
    return op;
  }

  /** `crud`: what the call may do. Default: the op's own, or for a dynamic op (Connect `tools`) the named tool's (F-G1: not the search op's "read"). */
  function addUse(op: TargetOp, product: string, stepId: string, tool: string | undefined, crud?: readonly string[]): void {
    const k = `${product}.${op.id}`;
    const callCrud = crud ?? crudOfCall(op, tool);
    const u = uses.get(k) ?? { product, op: op.id, crud: op.dynamic ? [] : [...op.crud], effect: op.effect, ...(op.holdFamily ? { holdFamily: op.holdFamily } : {}), ...(op.scopeType ? { scopeType: op.scopeType } : {}), idempotency: op.idempotency, steps: [] };
    // a dynamic op's crud is the union over the tools the workflow names, in the order read, create, update, delete
    u.crud = op.dynamic ? (["read", "create", "update", "delete"] as const).filter((c) => u.crud.includes(c) || callCrud.includes(c)) : u.crud;
    if (!u.steps.includes(stepId)) u.steps.push(stepId);
    if (tool !== undefined) u.tools = [...new Set([...(u.tools ?? []), tool])].sort();
    uses.set(k, u);
  }

  // ── refs and value trees ──
  function checkRef(ref: Ref, sc: SScope, path: string, stepId: string | undefined): Schema | "error" {
    const segs: readonly PathSeg[] = ref.segs;
    if (ref.root === "input") {
      const r = schemaAt(sc.input, segs);
      if (r === "missing") {
        err("ref_unresolved", path, `${ref.text}: the workflow inputs have no such field`, stepId);
        return "error";
      }
      return r;
    }
    if (ref.root === "trigger") {
      const r = schemaAt(sc.trigger, segs);
      if (r === "missing") {
        err("ref_unresolved", path, `${ref.text}: a trigger has no such field (kind, date, firedAt, timezone, input, item, cursor, previousCursor, scheduleId)`, stepId);
        return "error";
      }
      return r;
    }
    if (ref.root === "steps") {
      const id = ref.segs[0] as string;
      if (!sc.steps.has(id)) {
        err(ids.has(id) ? "ref_not_ready" : "ref_unresolved", path, ids.has(id) ? `${ref.text}: step "${id}" has not run yet at this point, or is in another branch or loop` : `${ref.text}: there is no step "${id}"`, stepId);
        return "error";
      }
      const r = schemaAt(sc.steps.get(id), ref.segs.slice(2));
      if (r === "missing") {
        err("ref_unresolved", path, `${ref.text}: the output of "${id}" has no such field`, stepId);
        return "error";
      }
      return r;
    }
    if (ref.root === "loop") {
      if (sc.loopItem === null) {
        err("ref_outside_loop", path, `${ref.text}: $loop is only available inside a loop`, stepId);
        return "error";
      }
      if (ref.segs[0] === "index") return { type: "integer" };
      const r = schemaAt(sc.loopItem, ref.segs.slice(1));
      if (r === "missing") {
        err("ref_unresolved", path, `${ref.text}: the loop element has no such field`, stepId);
        return "error";
      }
      return r;
    }
    // item / index
    if (sc.itemSchema === null) {
      err("ref_outside_loop", path, `${ref.text}: $item and $index are only available inside a transform map or filter`, stepId);
      return "error";
    }
    if (ref.root === "index") return { type: "integer" };
    const r = schemaAt(sc.itemSchema, ref.segs);
    if (r === "missing") {
      err("ref_unresolved", path, `${ref.text}: the element has no such field`, stepId);
      return "error";
    }
    return r;
  }

  function exprSchema(e: ValueExpr, sc: SScope, path: string, stepId: string | undefined): Schema | "error" {
    if (e.k === "lit") return schemaOfLiteral(e.v);
    if (e.k === "ref") return checkRef(e.ref, sc, path, stepId);
    let bad = false;
    for (const a of e.args) if (exprSchema(a, sc, path, stepId) === "error") bad = true;
    if (bad) return "error";
    return e.name === "join" ? { type: "string" } : e.name === "len" ? { type: "integer" } : { type: "boolean" };
  }

  /** The type of a value tree (a literal, a ref, a template, an object of those). Reports unresolved refs and bad templates. */
  function typeOfTree(tree: Json, sc: SScope, path: string, stepId: string | undefined): Schema | "error" {
    if (typeof tree === "string") {
      const ref = parseRef(tree);
      if (ref) return checkRef(ref, sc, path, stepId);
      if (tree.startsWith("$") && /^\$[a-z]+(\.|\[|$)/.test(tree) && !hasTemplate(tree)) {
        // looks like a ref but is not one: a typo that would silently stay a literal
        if (/^\$(input|trigger|steps|loop|item|index)\b/.test(tree)) {
          err("ref_invalid", path, `"${tree}" is not a valid ref (a step ref is $steps.<id>.output[.path])`, stepId);
          return "error";
        }
      }
      if (!hasTemplate(tree)) return { type: "string" };
      try {
        const parts = parseTemplate(tree);
        let bad = false;
        const types: (Schema | "error")[] = [];
        for (const part of parts) if ("expr" in part) types.push(exprSchema(part.expr, sc, path, stepId));
        for (const t of types) if (t === "error") bad = true;
        if (bad) return "error";
        if (parts.length === 1 && "expr" in (parts[0] as object)) return types[0] as Schema;
        return { type: "string" };
      } catch (e) {
        err("template_syntax", path, e instanceof ExprError ? e.message : "bad template", stepId);
        return "error";
      }
    }
    if (Array.isArray(tree)) {
      let bad = false;
      tree.forEach((x, i) => {
        if (typeOfTree(x, sc, `${path}/${i}`, stepId) === "error") bad = true;
      });
      return bad ? "error" : { type: "array" };
    }
    if (tree && typeof tree === "object") {
      let bad = false;
      const props: { [k: string]: Json } = {};
      for (const [k, v] of Object.entries(tree)) {
        const t = typeOfTree(v, sc, `${path}/${k}`, stepId);
        if (t === "error") bad = true;
        else props[k] = (t ?? {}) as Json;
      }
      return bad ? "error" : { type: "object", properties: props, required: Object.keys(props) };
    }
    return schemaOfLiteral(tree);
  }

  /** Checks a value tree against the consumer schema `dst` (an app op input, a child workflow's inputs). */
  function checkAgainst(tree: Json, dst: Schema, sc: SScope, path: string, stepId: string | undefined): void {
    const dt = dst ? typesOf(dst) : null;
    if (tree && typeof tree === "object" && !Array.isArray(tree) && dst && (dt === null || dt.includes("object"))) {
      const props = asSchema(dst.properties as Json) as { [k: string]: Json } | undefined;
      for (const [k, v] of Object.entries(tree)) {
        const ps = props && Object.hasOwn(props, k) ? asSchema(props[k]) : undefined;
        if (props && !ps && dst.additionalProperties === false) {
          err("input_unknown_field", `${path}/${k}`, `"${k}" is not an input of this operation`, stepId);
          typeOfTree(v, sc, `${path}/${k}`, stepId);
          continue;
        }
        checkAgainst(v, ps ?? asSchema(dst.additionalProperties as Json), sc, `${path}/${k}`, stepId);
      }
      const req = Array.isArray(dst.required) ? dst.required : [];
      for (const r of req) if (typeof r === "string" && !Object.hasOwn(tree, r)) err("input_missing_required", path, `the required input "${r}" is missing`, stepId);
      return;
    }
    if (Array.isArray(tree) && dst && (dt === null || dt.includes("array"))) {
      const items = asSchema(dst.items as Json);
      tree.forEach((x, i) => {
        checkAgainst(x, items, sc, `${path}/${i}`, stepId);
      });
      return;
    }
    const t = typeOfTree(tree, sc, path, stepId);
    if (t === "error" || !dst) return;
    const isLiteral = typeof tree !== "string" ? tree === null || typeof tree !== "object" : !hasTemplate(tree) && !parseRef(tree);
    if (isLiteral) {
      const r = validateAgainstSchema(dst as never, tree as never);
      if (!r.ok) err("type_mismatch", path, `the value does not fit: ${r.errors.map((e) => e.message).join("; ")}`, stepId);
      return;
    }
    const k = clash(t, dst, "");
    if (k) (k.severity === "error" ? err : warn)("type_mismatch", path, k.message, stepId);
  }

  // ── steps ──
  function runSteps(steps: readonly Step[], sc: SScope, base: string): void {
    steps.forEach((s, i) => {
      checkStep(s, sc, `${base}/${i}`);
    });
  }

  function refsOk(tree: Json, sc: SScope, path: string, stepId: string): void {
    typeOfTree(tree, sc, path, stepId);
  }

  function checkStep(s: Step, sc: SScope, path: string): void {
    let out: Schema = {};
    switch (s.type) {
      case "app":
        out = checkApp(s, sc, path);
        break;
      case "ai":
        out = checkAi(s, sc, path);
        break;
      case "approval":
        out = checkApproval(s, sc, path);
        break;
      case "transform":
        out = checkTransform(s, sc, path);
        break;
      case "timer":
        out = checkTimer(s, sc, path);
        break;
      case "condition":
        out = checkCondition(s, sc, path);
        break;
      case "loop":
        out = checkLoop(s, sc, path);
        break;
      case "parallel":
        out = checkParallel(s, sc, path);
        break;
      case "workflow":
        out = checkWorkflow(s, sc, path);
        break;
    }
    // approval steps and `onFail: "ask"` ask the owner through Inbox: the engine needs inbox_ask / inbox_status in the activated list
    if (s.type === "approval" || ("onFail" in s && s.onFail === "ask")) needInbox(s.id, path);
    stepTypes[s.id] = out;
    sc.steps.set(s.id, out);
  }

  function checkApp(s: AppStep, sc: SScope, path: string): Schema {
    const op = checkTargetOp(s.product, s.op, path, s.id);
    const input = (s.input ?? {}) as Json;
    if (!op) {
      refsOk(input, sc, `${path}/input`, s.id);
      return asSchema(s.outputSchema as Json);
    }
    if (op.effect !== "read" && op.idempotency === "none" && s.onFail !== "ask") {
      err("idempotency_missing", path, `${s.product}.${s.op} changes data and has no idempotency, so a retry could do it twice. Set onFail "ask" on this step, or use an op with idempotency`, s.id);
    }
    if (op.idempotency === "none" && s.retry?.max !== undefined && s.retry.max > 1 && op.effect !== "read") warn("retry_ignored", `${path}/retry`, "the engine does not retry an op without idempotency; retry.max is ignored", s.id);
    let tool: string | undefined;
    if (op.dynamic) {
      const t = (s.input as JsonObject | undefined)?.tool;
      if (typeof t !== "string" || hasTemplate(t) || parseRef(t)) {
        err("dynamic_tool_not_static", `${path}/input/tool`, `${s.product}.${s.op} calls a tool by name; the name must be written in the workflow (not a ref), so activation can show the owner which tools it uses`, s.id);
      } else tool = t;
      const args = (s.input as JsonObject | undefined)?.arguments;
      if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) err("type_mismatch", `${path}/input/arguments`, "arguments must be an object", s.id);
      refsOk(input, sc, `${path}/input`, s.id);
      const unknownKeys = Object.keys(s.input ?? {}).filter((k) => k !== "tool" && k !== "arguments");
      for (const k of unknownKeys) err("input_unknown_field", `${path}/input/${k}`, `"${k}" is not an input of a dynamic operation (tool, arguments)`, s.id);
      if (s.input === undefined || (s.input as JsonObject).tool === undefined) err("input_missing_required", `${path}/input`, 'the required input "tool" is missing', s.id);
    } else {
      checkAgainst(input, op.input ?? { type: "object", additionalProperties: false }, sc, `${path}/input`, s.id);
    }
    addUse(op, s.product, s.id, tool);
    if (s.outputSchema) {
      const bad = compile(s.outputSchema);
      if (bad) err("output_schema", `${path}/outputSchema`, `not a valid JSON Schema: ${bad}`, s.id);
      return s.outputSchema;
    }
    return asSchema(op.output as Json);
  }

  function checkAi(s: AiStep, sc: SScope, path: string): Schema {
    if (opts.refusePlaceholderAgent && "agent" in s.by && s.by.agent === UNASSIGNED_AGENT) {
      err("agent_unassigned", `${path}/by/agent`, `Step ${s.id} still names the placeholder agent of a workflow moved from 0.3.x. In the editor, choose the agent for this step, save a new version and activate that one.`, s.id);
    }
    if ("role" in s.by) {
      if (!roles.includes(s.by.role)) err("unknown_model_role", `${path}/by/role`, `"${s.by.role}" is not a model role (${roles.join(", ")})`, s.id);
      else if (!TEXT_ROLES.includes(s.by.role)) warn("model_role_not_text", `${path}/by/role`, `${s.by.role} is not a text role: the engine runs reasoning, utility, dreaming and summarize steps; this step would fail with model_role_unsupported`, s.id);
    }
    if (hasTemplate(s.instruction)) refsOk(s.instruction, sc, `${path}/instruction`, s.id);
    for (const [name, v] of Object.entries(s.inputs ?? {})) {
      if (typeof v === "string" && !parseRef(v) && !hasTemplate(v) && v.startsWith("$")) err("ref_invalid", `${path}/inputs/${name}`, `"${v}" is not a valid ref`, s.id);
      refsOk(v, sc, `${path}/inputs/${name}`, s.id);
    }
    const bad = compile(s.outputSchema);
    if (bad) err("output_schema", `${path}/outputSchema`, `not a valid JSON Schema: ${bad}`, s.id);
    else if (typesOf(s.outputSchema) === null) err("output_schema", `${path}/outputSchema`, "outputSchema must declare a type", s.id);
    if ("role" in s.by && s.timeoutSec !== undefined && s.timeoutSec > 600) warn("timeout_long", `${path}/timeoutSec`, "a model-role call rarely needs more than 10 minutes", s.id);
    return s.outputSchema;
  }

  function needInbox(stepId: string, path: string): void {
    for (const opId of ["inbox_ask", "inbox_status"]) {
      const op = checkTargetOp("inbox", opId, path, stepId);
      if (op) addUse(op, "inbox", stepId, undefined);
    }
  }

  function checkApproval(s: ApprovalStep, sc: SScope, path: string): Schema {
    refsOk(s.title, sc, `${path}/title`, s.id);
    if (s.context) refsOk(s.context, sc, `${path}/context`, s.id);
    return { type: "object", required: ["response", "message"], properties: { response: { enum: ["approve", "deny", "answer", "clarify", "expired"] }, message: { type: ["string", "null"] } } };
  }

  function checkTimer(s: TimerStep, sc: SScope, path: string): Schema {
    if ((s.seconds === undefined) === (s.until === undefined)) err("timer_spec", path, "a timer step needs exactly one of seconds or until", s.id);
    if (s.until !== undefined) {
      const ref = parseRef(s.until);
      if (!ref) err("ref_invalid", `${path}/until`, `"${s.until}" is not a valid ref`, s.id);
      else {
        const t = checkRef(ref, sc, `${path}/until`, s.id);
        if (t !== "error") {
          const k = clash(t, { type: "string" }, "");
          if (k?.severity === "error") err("type_mismatch", `${path}/until`, k.message, s.id);
        }
      }
    }
    return { type: "object", required: ["waitedSec"], properties: { waitedSec: { type: "integer" } } };
  }

  function checkCondition(s: ConditionStep, sc: SScope, path: string): Schema {
    for (const i of checkExpr(s.if, `${path}/if`)) err("expr_invalid", i.pointer, i.message, s.id);
    for (const r of exprRefs(s.if, `${path}/if`)) checkRef(r.ref, sc, r.pointer, s.id);
    const a = branchScope(sc);
    runSteps(s.then, a, `${path}/then`);
    const b = branchScope(sc);
    if (s.else) runSteps(s.else, b, `${path}/else`);
    mergeInto(sc, a);
    mergeInto(sc, b);
    return { type: "object", required: ["branch", "output"], properties: { branch: { enum: ["then", "else", "none"] }, output: {} } };
  }

  function checkLoop(s: LoopStep, sc: SScope, path: string): Schema {
    let itemSchema: Schema;
    const ref = parseRef(s.forEach);
    if (!ref) err("ref_invalid", `${path}/forEach`, `forEach must be a ref to a list, not "${s.forEach}"`, s.id);
    else {
      const t = checkRef(ref, sc, `${path}/forEach`, s.id);
      if (t !== "error") {
        const k = clash(t, { type: "array" }, "");
        if (k?.severity === "error") err("type_mismatch", `${path}/forEach`, `forEach needs a list: ${k.message}`, s.id);
        itemSchema = asSchema(t?.items as Json);
      }
    }
    const inner = branchScope(sc);
    inner.loopItem = itemSchema ?? {};
    runSteps(s.steps, inner, `${path}/steps`);
    // the steps of one iteration are not visible after the loop; only the loop's own output is
    return { type: "object", required: ["items", "count"], properties: { items: { type: "array" }, count: { type: "integer" } } };
  }

  function checkParallel(s: ParallelStep, sc: SScope, path: string): Schema {
    const props: { [k: string]: Json } = {};
    const scopes: SScope[] = [];
    for (const [name, list] of Object.entries(s.branches)) {
      const b = branchScope(sc);
      runSteps(list, b, `${path}/branches/${name}`);
      scopes.push(b);
      const last = list[list.length - 1];
      props[name] = (last ? b.steps.get(last.id) : {}) ?? {};
    }
    for (const b of scopes) mergeInto(sc, b);
    return { type: "object", required: Object.keys(props), properties: props };
  }

  function checkWorkflow(s: WorkflowStep, sc: SScope, path: string): Schema {
    const child = opts.lookupWorkflow?.(s.workflow, s.version);
    if (opts.lookupWorkflow && !child) {
      err("workflow_unknown", `${path}/workflow`, `no workflow "${s.workflow}"${s.version ? ` version ${s.version}` : ""} is stored`, s.id);
      return {};
    }
    if (child) {
      if (child.id === c.id) err("workflow_cycle", `${path}/workflow`, "a workflow cannot call itself", s.id);
      const depth = subDepth(child, new Set([c.id]), 1);
      if (depth > LIMITS.maxSubWorkflowDepth) err("workflow_depth", `${path}/workflow`, `workflows may nest ${LIMITS.maxSubWorkflowDepth} levels deep; this chain is ${depth}`, s.id);
      checkAgainst((s.input ?? {}) as Json, child.inputs ?? NO_FIELDS, sc, `${path}/input`, s.id);
    } else refsOk((s.input ?? {}) as Json, sc, `${path}/input`, s.id);
    return { type: "object" };
  }

  function subDepth(w: WorkflowContract, seen: Set<string>, depth: number): number {
    if (seen.has(w.id)) return LIMITS.maxSubWorkflowDepth + 1;
    const next = new Set(seen).add(w.id);
    let d = depth;
    walkSteps(w.steps, (st) => {
      if (st.type === "workflow") {
        const ch = opts.lookupWorkflow?.(st.workflow, st.version);
        if (ch) d = Math.max(d, subDepth(ch, next, depth + 1));
      }
    });
    return d;
  }

  function checkTransform(s: TransformStep, sc: SScope, path: string): Schema {
    const op = opOfTransform(s);
    if (!op) {
      err("transform_op", path, `a transform step has exactly one op of: ${TRANSFORM_OPS.join(", ")}`, s.id);
      return asSchema(s.outputSchema as Json);
    }
    const fromType = (ref: string, p: string): Schema | "error" => {
      const r = parseRef(ref);
      if (!r) {
        err("ref_invalid", p, `"${ref}" is not a valid ref`, s.id);
        return "error";
      }
      return checkRef(r, sc, p, s.id);
    };
    const itemScope = (item: Schema): SScope => ({ ...sc, itemSchema: item ?? {} });
    let out: Schema | "error" = {};
    switch (op) {
      case "pick":
        out = typeOfTree(s.pick as Json, sc, `${path}/pick`, s.id);
        break;
      case "template":
        out = typeOfTree(s.template as string, sc, `${path}/template`, s.id);
        if (out !== "error") out = { type: "string" };
        break;
      case "merge": {
        const m = s.merge as Json;
        const t = typeOfTree(m, sc, `${path}/merge`, s.id);
        if (t === "error") out = t;
        else if (Array.isArray(m)) {
          const props: { [k: string]: Json } = {};
          m.forEach((part, i) => {
            const pt = typeOfTree(part, sc, `${path}/merge/${i}`, s.id);
            if (pt && pt !== "error") {
              const k = clash(pt, { type: "object" }, "");
              if (k?.severity === "error") err("type_mismatch", `${path}/merge/${i}`, `merge of a list takes objects: ${k.message}`, s.id);
              Object.assign(props, asSchema(pt.properties as Json) ?? {});
            }
          });
          out = { type: "object", properties: props };
        } else out = t;
        break;
      }
      case "rename": {
        const t = fromType(s.rename?.from ?? "", `${path}/rename/from`);
        out = t === "error" ? t : (t ?? {});
        break;
      }
      case "concat": {
        const items = s.concat?.items ?? [];
        const ts = items.map((x, i) => typeOfTree(x, sc, `${path}/concat/items/${i}`, s.id));
        if (ts.includes("error")) out = "error";
        else out = ts.length > 0 && ts.every((t) => t !== "error" && t !== undefined && typesOf(t)?.[0] === "array") ? { type: "array" } : { type: "string" };
        break;
      }
      case "map": {
        const t = fromType(s.map?.forEach ?? "", `${path}/map/forEach`);
        if (t === "error") out = t;
        else {
          const k = clash(t, { type: "array" }, "");
          if (k?.severity === "error") err("type_mismatch", `${path}/map/forEach`, `map needs a list: ${k.message}`, s.id);
          const it = typeOfTree(s.map?.template as Json, itemScope(asSchema(t?.items as Json)), `${path}/map/template`, s.id);
          out = it === "error" ? it : { type: "array", items: (it ?? {}) as Json };
        }
        break;
      }
      case "filter": {
        const t = fromType(s.filter?.from ?? "", `${path}/filter/from`);
        if (t !== "error") {
          const k = clash(t, { type: "array" }, "");
          if (k?.severity === "error") err("type_mismatch", `${path}/filter/from`, `filter needs a list: ${k.message}`, s.id);
          const isc = itemScope(asSchema(t?.items as Json));
          for (const i of checkExpr(s.filter?.where, `${path}/filter/where`)) err("expr_invalid", i.pointer, i.message, s.id);
          for (const r of exprRefs(s.filter?.where, `${path}/filter/where`)) checkRef(r.ref, isc, r.pointer, s.id);
        }
        out = t;
        break;
      }
      case "dedupe":
      case "sort": {
        const spec = (op === "dedupe" ? s.dedupe : s.sort) as { from: string };
        const t = fromType(spec.from, `${path}/${op}/from`);
        if (t !== "error") {
          const k = clash(t, { type: "array" }, "");
          if (k?.severity === "error") err("type_mismatch", `${path}/${op}/from`, `${op} needs a list: ${k.message}`, s.id);
        }
        out = t;
        break;
      }
      case "normalise": {
        const t = fromType(s.normalise?.from ?? "", `${path}/normalise/from`);
        out = t;
        break;
      }
    }
    if (out === "error") return asSchema(s.outputSchema as Json);
    if (s.outputSchema) {
      const bad = compile(s.outputSchema);
      if (bad) err("output_schema", `${path}/outputSchema`, `not a valid JSON Schema: ${bad}`, s.id);
      else {
        const k = clash(out, s.outputSchema, "");
        if (k) (k.severity === "error" ? err : warn)("output_schema_mismatch", `${path}/outputSchema`, `the declared output type does not match what the step builds: ${k.message}`, s.id);
      }
      return s.outputSchema;
    }
    return out;
  }

  function branchScope(sc: SScope): SScope {
    return { ...sc, steps: new Map(sc.steps) };
  }
  function mergeInto(parent: SScope, child: SScope): void {
    for (const [k, v] of child.steps) if (!parent.steps.has(k)) parent.steps.set(k, v);
  }

  const root: SScope = { input: inputSchema, trigger: triggerSchema, steps: new Map(), loopItem: null, itemSchema: null };
  runSteps(c.steps, root, "/steps");

  // ── outputs ──
  for (const [name, text] of Object.entries(c.outputs ?? {})) {
    const ref = parseRef(text);
    if (!ref) err("ref_invalid", `/outputs/${name}`, `"${text}" is not a valid ref`);
    else checkRef(ref, root, `/outputs/${name}`, undefined);
  }
  return done();
}
