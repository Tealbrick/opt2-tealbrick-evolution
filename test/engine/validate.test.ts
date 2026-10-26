// biome-ignore-all lint/suspicious/noThenProperty: a condition step of the workflow contract has a `then` field
// validateContract(): quiet on the two example workflows of ENGINE-BUILD §12, loud on every bad case the plan names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { validateCompanions } from "@opt2-tealbrick/manifest";
import { manifest } from "../../src/app.ts";
import { bundledCatalog, injectCatalog, type TargetCatalog } from "../../src/engine/catalog.ts";
import { COMPANION_PRODUCTS, companionBlock } from "../../src/engine/catalog-rules.ts";
import { CONTRACT_SCHEMA, type Step, type WorkflowContract } from "../../src/engine/contract.ts";
import { MODEL_ROLES } from "../../src/engine/model-roles.ts";
import { type ValidationResult, validateContract } from "../../src/engine/validate.ts";
import { read, wf } from "./harness.ts";

const fixture = (n: string): WorkflowContract => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8")) as WorkflowContract;
const companions = manifest.companions ?? [];

afterEach(() => injectCatalog(null));

const must = (r: ValidationResult, code: string, text?: RegExp): void => {
  assert.equal(r.ok, false, `expected errors, got ok (${code})`);
  const e = r.errors.find((x) => x.code === code);
  assert.ok(e, `expected ${code}, got ${JSON.stringify(r.errors.map((x) => [x.code, x.path, x.message]))}`);
  if (text) assert.match(e.message, text);
};

test("quiet on good: example A and B validate (companions of this app checked); A has no warning", () => {
  const a = validateContract(fixture("example-a"), { companions });
  assert.equal(a.ok, true, JSON.stringify(a.errors));
  assert.deepEqual(a.warnings, []);
  assert.deepEqual(
    a.uses.map((u) => [u.product, u.op, u.tools]),
    [["connect", "tools", ["gmail_create_email_draft", "gmail_fetch_emails"]]],
  );
  const b = validateContract(fixture("example-b"), { companions });
  assert.equal(b.ok, true, JSON.stringify(b.errors));
  assert.deepEqual(
    b.warnings.map((w) => w.code),
    ["event_trigger_pending"],
  );
  assert.deepEqual(
    b.uses.map((u) => `${u.product}.${u.op}`),
    ["connect.tools", "inbox.inbox_ask", "inbox.inbox_status", "knowledge.recall"],
    "the approval step needs the two Inbox ops in the activated list",
  );
  assert.equal(b.uses.find((u) => u.op === "recall")?.crud.join(), "read");
});

test("step output types are derived: app = the op output, ai = outputSchema, transform = from its op", () => {
  const r = validateContract(fixture("example-a"), { companions });
  assert.deepEqual((r.stepTypes.summary as { required: string[] }).required, ["bullets", "needsReply"]);
  assert.equal((r.stepTypes.body as { type: string }).type, "string");
  assert.equal((r.stepTypes.slim as { type: string }).type, "array");
});

test("fire on bad: unresolved refs (no such step, no such input, no such trigger field, outside a loop, $item outside a transform)", () => {
  must(validateContract(wf([read("a", { input: { query: "$steps.nope.output.x" } })]), { companions }), "ref_unresolved", /no step "nope"/);
  must(validateContract(wf([read("a", { input: { query: "$input.q" } })]), { companions }), "ref_unresolved", /inputs have no such field/);
  must(validateContract(wf([read("a", { input: { query: "$trigger.nope" } })]), { companions }), "ref_unresolved", /trigger has no such field/);
  must(validateContract(wf([read("a", { input: { query: "$loop.item" } })]), { companions }), "ref_outside_loop");
  must(validateContract(wf([read("a", { input: { query: "$item.x" } })]), { companions }), "ref_outside_loop");
  must(validateContract(wf([read("a", { input: { query: "{{ $steps.nope.output }}" } })]), { companions }), "ref_unresolved");
  must(validateContract(wf([read("a", { input: { query: "$steps.broken" } })]), { companions }), "ref_invalid");
  must(validateContract(wf([{ id: "t", type: "transform", template: "{{ eval('x') }}" }])), "template_syntax");
  must(validateContract(wf([read("a")], { outputs: { out: "$steps.zzz.output" } }), { companions }), "ref_unresolved");
});

test("fire on bad: a ref to a step that runs later, or sits in another branch or loop, is not ready", () => {
  must(validateContract(wf([read("a", { input: { query: "$steps.b.output.x" } }), read("b")]), { companions }), "ref_not_ready", /has not run yet/);
  const par = wf([{ id: "p", type: "parallel", branches: { l: [read("x")], r: [read("y", { input: { query: "$steps.x.output" } })] } }]);
  must(validateContract(par, { companions }), "ref_not_ready");
  const loop = wf([{ id: "lp", type: "loop", forEach: "$input.xs", max: 5, steps: [read("inner")] }, read("after", { input: { query: "$steps.inner.output" } })], { inputs: { type: "object", properties: { xs: { type: "array", items: { type: "string" } } } } });
  must(validateContract(loop, { companions }), "ref_not_ready");
});

test("fire on bad: type mismatches between a ref's source schema and its consumer", () => {
  const inputs = { type: "object", properties: { n: { type: "integer" }, s: { type: "string" }, tags: { type: "array", items: { type: "string" } }, maybe: { type: ["string", "null"] } } };
  // string into an integer field
  must(validateContract(wf([read("a", { input: { query: "x", limit: "$input.s" } })], { inputs }), { companions }), "type_mismatch", /string cannot go into integer/);
  // integer into a string field
  must(validateContract(wf([read("a", { input: { query: "$input.n" } })], { inputs }), { companions }), "type_mismatch", /integer cannot go into string/);
  // a literal of the wrong type, and one outside an enum
  must(validateContract(wf([read("a", { input: { query: "x", limit: "ten" } })], { inputs }), { companions }), "type_mismatch");
  must(validateContract(wf([{ id: "k", type: "app", product: "kanban", op: "issues_list", input: { status: "finished" } }], { inputs }), { companions }), "type_mismatch");
  // the output of one op into the input of another: a list where a string is expected
  const chain = wf([{ id: "k", type: "app", product: "kanban", op: "issues_list", input: {} }, read("a", { input: { query: "$steps.k.output.issues" } })]);
  must(validateContract(chain, { companions }), "type_mismatch", /array cannot go into string/);
  // a good typed passthrough, and a lone {{ }} keeps the type
  assert.equal(validateContract(wf([read("a", { input: { query: "$input.s", limit: "{{ $input.n }}" } })], { inputs }), { companions }).ok, true);
  // a template is a string: into an integer field it fails
  must(validateContract(wf([read("a", { input: { query: "x", limit: "n={{ $input.n }}" } })], { inputs }), { companions }), "type_mismatch");
  // may-be-null is a warning, not an error
  const warn = validateContract(wf([read("a", { input: { query: "$input.maybe" } })], { inputs }), { companions });
  assert.equal(warn.ok, true);
  assert.equal(warn.warnings[0]?.code, "type_mismatch");
  // forEach needs a list
  must(validateContract(wf([{ id: "lp", type: "loop", forEach: "$input.s", max: 3, steps: [read("i")] }], { inputs }), { companions }), "type_mismatch", /forEach needs a list/);
  // required fields and unknown fields of the target op
  must(validateContract(wf([{ id: "k", type: "app", product: "kanban", op: "issue_create", input: {} }]), { companions }), "input_missing_required", /"title"/);
  must(validateContract(wf([read("a", { input: { query: "x", bogus: 1 } })]), { companions }), "input_unknown_field");
});

test("fire on bad: loops need a bound; above 100 only at the top level; parallel is 1 to 8 branches", () => {
  must(validateContract(wf([{ id: "lp", type: "loop", forEach: "$input.xs", steps: [read("i")] }], { inputs: { type: "object", properties: { xs: { type: "array" } } } }), { companions }), "loop_unbounded", /needs a bound/);
  must(validateContract(wf([{ id: "lp", type: "loop", forEach: "$input.xs", max: 0, steps: [read("i")] }], { inputs: { type: "object", properties: { xs: { type: "array" } } } }), { companions }), "schema_invalid");
  must(validateContract(wf([{ id: "lp", type: "loop", forEach: "$input.xs", max: 201, steps: [read("i")] }], { inputs: { type: "object", properties: { xs: { type: "array" } } } }), { companions }), "schema_invalid");
  const xs = { type: "object", properties: { xs: { type: "array" } } };
  must(validateContract(wf([{ id: "c", type: "condition", if: { exists: "$input.xs" }, then: [{ id: "lp", type: "loop", forEach: "$input.xs", max: 150, steps: [read("i")] }] }], { inputs: xs }), { companions }), "loop_bound_nested", /top-level/);
  assert.equal(validateContract(wf([{ id: "lp", type: "loop", forEach: "$input.xs", max: 150, steps: [read("i")] }], { inputs: xs }), { companions }).ok, true, "a top-level loop of 150 continues as new");
  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`b${i}`, [read(`s${i}`)]]));
  must(validateContract(wf([{ id: "p", type: "parallel", branches: nine }]), { companions }), "schema_invalid");
  must(validateContract(wf([{ id: "p", type: "parallel", branches: {} }]), { companions }), "schema_invalid");
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`b${i}`, [read(`s${i}`)]]));
  assert.equal(validateContract(wf([{ id: "p", type: "parallel", branches: eight }]), { companions }).ok, true);
});

test("fire on bad: the target op must be an AGENT op of a known app, listed in this app's companions", () => {
  must(validateContract(wf([{ id: "a", type: "app", product: "nope", op: "x_y" }]), { companions }), "unknown_product");
  must(validateContract(wf([{ id: "a", type: "app", product: "knowledge", op: "nope_op" }]), { companions }), "unknown_op");
  // a person op of the installed Task Board manifest is not in the agent catalog at all
  must(validateContract(wf([{ id: "a", type: "app", product: "kanban", op: "board_view" }]), { companions }), "unknown_op");
  // an injected catalog with a person op shows the dedicated refusal
  injectCatalog({ ...bundledCatalog(), kanban: { id: "kanban", version: "x", operations: [{ id: "owner_only", audience: "person", crud: ["read"], effect: "read", idempotency: "none" }] } });
  must(validateContract(wf([{ id: "a", type: "app", product: "kanban", op: "owner_only" }]), { companions: null }), "not_agent_op", /owner \(person\) operation/);
  injectCatalog(null);
  // a destructive agent op exists in the snapshot but is NOT in the companion superset: the bridge would refuse it
  must(validateContract(wf([{ id: "a", type: "app", product: "kanban", op: "issue_delete", input: { issue: "x" }, onFail: "ask" }]), { companions }), "not_declared", /companion list/);
  must(validateContract(wf([{ id: "a", type: "app", product: "connect", op: "buzz_post", input: {} }]), { companions }), "not_declared");
});

test("fire on bad: an op that writes and has no idempotency is refused unless onFail is ask; reads are fine", () => {
  const cat: TargetCatalog = { ...bundledCatalog(), kanban: { id: "kanban", version: "x", operations: [{ id: "zap", audience: "agent", crud: ["update"], effect: "write", idempotency: "none" }, { id: "peek", audience: "agent", crud: ["read"], effect: "read", idempotency: "none" }] } };
  injectCatalog(cat);
  must(validateContract(wf([{ id: "a", type: "app", product: "kanban", op: "zap" }]), { companions: null }), "idempotency_missing", /no idempotency/);
  assert.equal(validateContract(wf([{ id: "a", type: "app", product: "kanban", op: "zap", onFail: "ask" }]), { companions: null }).ok, true);
  assert.equal(validateContract(wf([{ id: "a", type: "app", product: "kanban", op: "peek" }]), { companions: null }).ok, true, "a read needs no key");
  // the real ops: a write with a required or supported key is fine
  injectCatalog(null);
  assert.equal(validateContract(wf([{ id: "a", type: "app", product: "kanban", op: "issue_create", input: { title: "t" } }]), { companions }).ok, true);
});

test("fire on bad: model roles come from MODEL_ROLES", () => {
  assert.deepEqual([...MODEL_ROLES], ["embeddings", "rerank", "reasoning", "utility", "dreaming", "summarize", "vision", "transcribe"]);
  const ai = (role: string): unknown => ({ id: "m", type: "ai", by: { role }, instruction: "do it", inputs: {}, outputSchema: { type: "object", properties: { x: { type: "string" } } } });
  must(validateContract(wf([ai("genius")]), { companions }), "unknown_model_role", /not a model role/);
  for (const role of MODEL_ROLES) assert.equal(validateContract(wf([ai(role)]), { companions }).ok, true, role);
  // an agent card: shape only
  must(validateContract(wf([{ id: "m", type: "ai", by: { agent: "polly" }, instruction: "x", outputSchema: { type: "object" } }]), { companions }), "schema_invalid");
  must(validateContract(wf([{ id: "m", type: "ai", by: { role: "utility" }, instruction: "x" }]), { companions }), "schema_invalid", undefined);
  must(validateContract(wf([{ id: "m", type: "ai", by: { role: "utility" }, instruction: "x", outputSchema: { description: "no type" } }]), { companions }), "output_schema", /declare a type/);
});

test("fire on bad: structure (misspelt field, wrong format, duplicate ids, reserved ids, two transform ops, timer spec, bad schedule)", () => {
  must(validateContract({ ...wf([read("a")]), format: "tealbrick.workflow/2" }, { companions }), "schema_invalid");
  must(validateContract(wf([read("a", { proudct: "x" })]), { companions }), "schema_invalid");
  must(validateContract(wf([read("a"), read("a")]), { companions }), "duplicate_id");
  must(validateContract(wf([read("constructor")]), { companions }), "reserved_id");
  must(validateContract(wf([{ id: "t", type: "transform", template: "x", pick: {} }])), "transform_op");
  must(validateContract(wf([{ id: "t", type: "transform" }])), "transform_op");
  must(validateContract(wf([{ id: "t", type: "timer" }])), "timer_spec");
  must(validateContract(wf([{ id: "t", type: "timer", seconds: 5, until: "$trigger.date" }])), "timer_spec");
  must(validateContract(wf([{ id: "t", type: "timer", seconds: 0 }])), "schema_invalid");
  must(validateContract({ ...wf([read("a")]), triggers: [{ kind: "schedule", cron: "0 8 * * *", timezone: "Mars/Olympus" }] }, { companions }), "schedule_spec", undefined);
  must(validateContract({ ...wf([read("a")]), triggers: [{ kind: "schedule", cron: "99 8 * * *", timezone: "UTC" }] }, { companions }), "schedule_spec");
  must(validateContract({ ...wf([read("a")]), triggers: [{ kind: "schedule", timezone: "UTC" }] }, { companions }), "schedule_spec", /exactly one of cron or every/);
  must(validateContract({ ...wf([read("a")]), triggers: [{ kind: "schedule", cron: "0 8 * * *" }] }, { companions }), "schema_invalid");
  must(validateContract({ ...wf([read("a")]), metrics: Array.from({ length: 21 }, (_, i) => `m${i}`) }, { companions }), "schema_invalid");
  must(validateContract({ ...wf([read("a")]), triggers: [] }, { companions }), "schema_invalid");
  must(validateContract(wf(Array.from({ length: 201 }, (_, i) => read(`s${i}`))), { companions }), "schema_invalid");
  must(validateContract(null as never), "schema_invalid");
  assert.equal(validateContract({ ...wf([read("a")]), triggers: [{ kind: "schedule", every: "15m", timezone: "Asia/Bangkok" }] }, { companions }).ok, true);
});

test("fire on bad: conditions, dynamic tools, poll triggers, sub-workflows", () => {
  must(validateContract(wf([{ id: "c", type: "condition", if: { "==": ["a"] }, then: [read("x")] }]), { companions }), "expr_invalid");
  must(validateContract(wf([{ id: "c", type: "condition", if: { "==": ["$steps.nope.output", 1] }, then: [read("x")] }]), { companions }), "ref_unresolved");
  must(validateContract(wf([{ id: "c", type: "condition", if: { exists: "$input.q" }, then: [read("x")] }]), { companions }), "ref_unresolved");
  must(validateContract(wf([{ id: "d", type: "app", product: "connect", op: "tools", input: { tool: "{{ $input.t }}", arguments: {} } }], { inputs: { type: "object", properties: { t: { type: "string" } } } }), { companions }), "dynamic_tool_not_static");
  must(validateContract(wf([{ id: "d", type: "app", product: "connect", op: "tools", input: { arguments: {} } }]), { companions }), "input_missing_required");
  must(validateContract({ ...wf([read("a")]), triggers: [{ kind: "poll", product: "kanban", op: "issue_create", cursorPath: "/x", every: "5m" }] }, { companions }), "poll_not_read");
  must(validateContract({ ...wf([read("a")]), triggers: [{ kind: "poll", product: "connect", op: "tools", input: { tool: "{{ $input.x }}" }, cursorPath: "/x", every: "5m" }] }, { companions }), "dynamic_tool_not_static");
  must(validateContract(wf([{ id: "w", type: "workflow", workflow: "missing-flow" }]), { companions, lookupWorkflow: () => null }), "workflow_unknown");
  must(validateContract(wf([{ id: "w", type: "workflow", workflow: "test-flow" }]), { companions, lookupWorkflow: () => wf([read("z")]) }), "workflow_cycle");
});

test("sub-workflows: input typed against the child's inputs; nesting deeper than 3 is refused", () => {
  const child = (id: string, inner?: string): WorkflowContract => ({ ...wf(inner ? [{ id: "w", type: "workflow", workflow: inner }] : [read("z")]), id, inputs: { type: "object", required: ["q"], properties: { q: { type: "string" } } } }) as WorkflowContract;
  const store: Record<string, WorkflowContract> = { "c-one": child("c-one"), "c-two": child("c-two", "c-three"), "c-three": child("c-three", "c-four"), "c-four": child("c-four", "c-five"), "c-five": child("c-five") };
  const lookup = (id: string): WorkflowContract | null => store[id] ?? null;
  assert.equal(validateContract(wf([{ id: "w", type: "workflow", workflow: "c-one", input: { q: "hi" } }]), { companions, lookupWorkflow: lookup }).ok, true);
  must(validateContract(wf([{ id: "w", type: "workflow", workflow: "c-one", input: { q: 5 } }]), { companions, lookupWorkflow: lookup }), "type_mismatch");
  must(validateContract(wf([{ id: "w", type: "workflow", workflow: "c-one", input: {} }]), { companions, lookupWorkflow: lookup }), "input_missing_required");
  must(validateContract(wf([{ id: "w", type: "workflow", workflow: "c-two", input: { q: "x" } }]), { companions, lookupWorkflow: lookup }), "workflow_depth");
});

test("transform output types are derived and a declared outputSchema is checked against them", () => {
  const inputs = { type: "object", properties: { people: { type: "array", items: { type: "object", additionalProperties: false, properties: { name: { type: "string" } } } } } };
  const ok = validateContract(wf([{ id: "t", type: "transform", map: { forEach: "$input.people", template: { n: "{{ $item.name }}" } } }], { inputs }));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal((ok.stepTypes.t as { type: string }).type, "array");
  must(validateContract(wf([{ id: "t", type: "transform", map: { forEach: "$input.people", template: { n: "{{ $item.nope }}" } } }], { inputs })), "ref_unresolved");
  must(validateContract(wf([{ id: "t", type: "transform", map: { forEach: "$input.people", template: "x" }, outputSchema: { type: "object" } }], { inputs })), "output_schema_mismatch", undefined);
  must(validateContract(wf([{ id: "t", type: "transform", filter: { from: "$input.people", where: { "==": ["$item.name", "x"] } } }, { id: "u", type: "transform", sort: { from: "$steps.nope.output" } }], { inputs })), "ref_unresolved");
});

test("the JSON Schema of the contract is a valid JSON Schema and names every step type", () => {
  const s = JSON.stringify(CONTRACT_SCHEMA);
  for (const t of ["app", "ai", "approval", "transform", "timer", "condition", "loop", "parallel", "workflow"]) assert.match(s, new RegExp(`"const":"${t}"`), t);
  assert.match(s, /"stage"/);
  const probe = validateContract({ ...wf([read("a")]), unknownTop: 1 }, { companions });
  must(probe, "schema_invalid");
});

test("M-CP-2: the superset companion block equals the union of its ops' crud, checked with the manifest package", () => {
  const targets = Object.values(bundledCatalog()).map((a) => ({ id: a.id, operations: a.operations })) as never;
  const v = validateCompanions(manifest as never, targets);
  assert.equal(v.ok, true, JSON.stringify(v.ok ? [] : v.errors));
  assert.deepEqual(
    (manifest.companions ?? []).map((c) => c.product),
    [...COMPANION_PRODUCTS, "*"],
    "the five apps and the wildcard tb.holds_pending (owner consent, read): never tb.hold_status (Core pin pending)",
  );
  assert.deepEqual((manifest.companions ?? []).find((c) => c.product === "*")?.operations, ["tb.holds_pending"]);
  // the block in the manifest is the one the sync script derives from the snapshot (no hand edit)
  assert.deepEqual(
    JSON.parse(JSON.stringify(manifest.companions)),
    JSON.parse(JSON.stringify(companionBlock(bundledCatalog()))),
  );
  // least privilege: no destructive, outward or money op; Connect only reads + tools; never item_decide_dm
  const cat = bundledCatalog();
  for (const c of (manifest.companions ?? []).filter((x) => x.product !== "*")) for (const id of c.operations) assert.ok(["read", "write"].includes(cat[c.product]?.operations.find((o) => o.id === id)?.effect ?? "?"), `${c.product}.${id}`);
  assert.ok(!(manifest.companions ?? []).find((c) => c.product === "inbox")?.operations.includes("item_decide_dm"));
  assert.deepEqual((manifest.companions ?? []).find((c) => c.product === "connect")?.crud, ["read"]);
  // a drifted block fails: add a destructive op
  const bad = { ...manifest, companions: (manifest.companions ?? []).map((c) => (c.product === "kanban" ? { ...c, operations: [...c.operations, "nope_op"] } : c)) };
  assert.equal(validateCompanions(bad as never, targets).ok, false);
});

test("steps typed as Step are what the validator reads (type check only)", () => {
  const s: Step = { id: "a", type: "timer", seconds: 1 };
  assert.equal(s.type, "timer");
});
