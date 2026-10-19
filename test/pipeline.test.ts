// C288 R10: typed pipeline contract import / export (tealbrick.agents/pipeline-contract/0.1). Quiet-on-good and fire-on-bad (L34).
// Fixtures: the 8 real pipelines of the Henry typed contracts, copied unchanged from
// coordination/leads/foxy/henry-contracts/pipelines/ (2026-10-19) into test/fixtures/pipelines/. The schema is vendored in
// contracts/pipeline-contract-0.1.schema.json; every contract is checked with the SDK's own JSON Schema validator.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAgainstSchema, validateInput } from "@opt2-tealbrick/manifest";
import { type Caller, type CompanionResult, type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { handlers, manifest, toTbError } from "../src/app.ts";
import * as pipeline from "../src/pipeline.ts";
import * as r from "../src/routines.ts";
import * as store from "../src/store.ts";
import { TEMPLATES } from "../src/templates.ts";
import { AGENT_A, type CallApp, call, ctxFor, migratedDb, OWNER } from "./helpers.ts";

const H = handlers as unknown as Parameters<typeof call>[0];
const BOUND: Caller = { ...AGENT_A, mode: "bound" };
const T = (s: string) => Date.parse(s);
const D0 = T("2026-10-12T06:00:00Z");
type Json = Parameters<typeof validateAgainstSchema>[1];
type Contract = Record<string, any>;

const FIXTURES = readdirSync(new URL("./fixtures/pipelines/", import.meta.url))
  .filter((f) => f.endsWith(".json"))
  .sort();
const load = (f: string): Contract => JSON.parse(readFileSync(new URL(`./fixtures/pipelines/${f}`, import.meta.url), "utf8")) as Contract;
const p = (n: number): Contract => load(FIXTURES.find((f) => f.startsWith(`p${n}-`)) as string);
const valid = (c: unknown) => {
  const { $schema: _s, ...body } = c as Contract; // the reference validator sets `$schema` aside, so do we
  return validateAgainstSchema(pipeline.PIPELINE_SCHEMA, JSON.parse(JSON.stringify(body)) as Json);
};
const owner = (db: Db) => ctxFor(db, OWNER);
const refusal = (fn: () => unknown): TbError => {
  try {
    fn();
  } catch (e) {
    const t = toTbError(e);
    assert.ok(t instanceof TbError, `a TbError, got ${String(e)}`);
    return t as TbError;
  }
  throw new Error("expected a refusal");
};
const READ = [{ product: "kanban", operations: ["issues_list"], crud: ["read" as const] }];

/** import → (give the draft an allowed operation when the contract names none) → promote → export. */
async function through(db: Db, c: Contract): Promise<{ draftId: string; wf: string; out: K.PipelineExportOutput; imported: K.PipelineImportOutput }> {
  const imported = await call<K.PipelineImportOutput>(H, "pipeline_import", { contract: c }, owner(db));
  let d = store.getDraft(db, imported.draft.id);
  if (d.allowed.length === 0) d = store.updateDraft(db, d.id, d.revision, { allowed: READ }, D0);
  const wf = store.promote(db, d.id, d.revision, D0).workflow.id;
  const out = await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: wf }, owner(db));
  return { draftId: d.id, wf, out, imported };
}

// ── the vendored schema and the fixtures ──

const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);

test("the vendored schema is the Henry schema: provenance, id, and a pinned digest of its content", () => {
  const { $comment, ...schema } = pipeline.PIPELINE_SCHEMA as unknown as Contract;
  assert.match($comment, /Henry typed contracts \(tealbrick\.agents\/pipeline-contract\/0\.1\)/);
  assert.equal(schema.$id, pipeline.PIPELINE_CONTRACT_ID);
  assert.equal(createHash("sha256").update(canon(schema)).digest("hex"), "42e449a725d0e6f0f10d8a6de97e0030c292d933612689249d88b7b19b49b8d4", "the schema changed: refresh the copy on purpose, then this digest");
});

test("the 8 example pipelines are valid contracts (the control for the refusal tests)", () => {
  assert.equal(FIXTURES.length, 8);
  for (const f of FIXTURES) {
    const v = valid(load(f));
    assert.equal(v.ok, true, `${f}: ${v.ok ? "" : JSON.stringify(v.errors)}`);
  }
});

// ── import: all 8, mapping, round trip ──

test("all 8 example pipelines import, become a draft with the mapped text, and round-trip through promotion and export (only `status` differs)", async () => {
  for (const f of FIXTURES) {
    const c = load(f);
    const db = migratedDb();
    const { out, imported, wf, draftId } = await through(db, c);
    const d = imported.draft;
    assert.equal(d.state, "open", f);
    assert.equal(d.workflowId, null);
    assert.equal(d.summary, c.purpose.trim(), "purpose → summary");
    assert.equal(d.pipeline?.id, c.id);
    assert.equal(d.pipeline?.version, c.version);
    assert.deepEqual(
      d.steps.map((s) => [s.id, s.instruction]),
      c.steps.map((s: Contract) => [s.id, s.do.trim()]),
      "step id and instruction = id and do",
    );
    for (const s of d.steps) assert.ok(s.title.length >= 1 && s.title.length <= 100, `${f}: step title is a short label`);
    assert.equal(imported.report.metrics_keys.join(), c.metrics.join());
    assert.equal(imported.report.schedule_hint.cron, c.trigger.cron ?? null);

    // export: the stored contract comes back; Evolution owns `status` (a promoted, active version is `active`)
    assert.equal(out.imported, true);
    assert.equal(out.filename, `${c.id}.pipeline.json`);
    assert.equal(valid(out.contract).ok, true, `${f}: the export is a valid contract`);
    const { status: exportedStatus, ...got } = out.contract as Contract;
    const { status: _was, ...want } = c;
    assert.equal(exportedStatus, "active");
    assert.deepEqual(got, want, `${f}: round trip`);
    // and the version's contract is frozen: editing the draft later changes the draft, not version 1
    assert.equal(pipeline.versionSource(db, wf, 1)?.source.id, c.id);
    assert.equal(draftId, store.getWorkflow(db, wf).draftId);
  }
});

test("p1: Teal Brick tools become step ops and allowed operations; every other tool is listed as not mapped; the rest is kept as data", async () => {
  const c = p(1);
  const db = migratedDb();
  const { draft, report } = await call<K.PipelineImportOutput>(H, "pipeline_import", { contract: c }, owner(db));
  assert.equal(draft.title, "P1 daily tidbit", "title = the id, made readable");
  assert.equal(draft.trigger, "cron 0 10 * * * (Asia/Bangkok)");
  assert.deepEqual(draft.steps.find((s) => s.id === "send")?.ops, [{ product: "knowledge", operation: "remember" }]);
  assert.deepEqual(draft.steps.find((s) => s.id === "scan")?.ops, []);
  assert.deepEqual(draft.allowed, [{ product: "knowledge", operations: ["remember"], crud: ["create", "read"] }]);
  assert.deepEqual(report.unmapped.tools, [{ step: "send", tool: "buzz reply (runtime)" }]);
  assert.deepEqual(report.schedule_hint, { cron: "0 10 * * *", timezone: "Asia/Bangkok", event: null, once: null });
  assert.deepEqual(report.metrics_keys, ["minutes", "candidates_seen", "shortlist_size", "martin_choice_rank"]);
  const kept = Object.fromEntries(report.kept_as_data.map((k) => [k.field, k.steps ?? true]));
  for (const f of ["status", "owner", "dictation_refs", "inputs", "outputs", "done_when", "approvals", "escalation", "taskboard"]) assert.equal(kept[f], true, f);
  assert.deepEqual(kept["steps[].lead"], ["scan", "write", "check"]);
  assert.deepEqual(kept["steps[].skills"], ["gate"]);
  assert.deepEqual(kept["steps[].out"], ["scan", "gate", "write", "check"]);
  assert.equal(kept["steps[].on_fail"], undefined, "a field no step carries is not listed");
  assert.ok(report.notes.some((n) => /No field for them yet: candidates_seen, shortlist_size, martin_choice_rank/.test(n)), "metrics R8 cannot take are named");
  assert.ok(report.notes.some((n) => /UTC/.test(n)));
  // a pipeline with several Teal Brick tools and other MCP servers (p5 and p7 name mcp__transcribe__ tools)
  const p7 = (await call<K.PipelineImportOutput>(H, "pipeline_import", { contract: p(7) }, owner(db))).report;
  assert.ok(p7.unmapped.tools.some((t) => t.tool.startsWith("mcp__transcribe__")));
  assert.ok(p7.mapped.some((m) => /mcp__tealbrick__knowledge__document_create/.test(m.from) && /knowledge\.document_create/.test(m.to)));
});

test("mcp__tealbrick__<product>__<operation> is mapped; local tools, `buzz …`, other MCP servers, `connect …` and malformed names are not", () => {
  const mapped: [string, { product: string; operation: string }][] = [
    ["mcp__tealbrick__knowledge__remember", { product: "knowledge", operation: "remember" }],
    ["mcp__tealbrick__kanban__issue_create", { product: "kanban", operation: "issue_create" }],
    ["mcp__tealbrick__connect-hub__send_mail", { product: "connect-hub", operation: "send_mail" }],
  ];
  for (const [tool, op] of mapped) assert.deepEqual(pipeline.tealbrickOp(tool), op, tool);
  for (const tool of [
    "buzz reply (runtime)",
    "local:observer",
    "connect listmonk",
    "mcp__transcribe__transcribe_video",
    "mcp__tealbrick__",
    "mcp__tealbrick__knowledge",
    "mcp__tealbrick__knowledge__",
    "mcp__tealbrick____remember",
    "mcp__tealbrick__Knowledge__remember",
    "mcp__tealbrick__knowledge__Remember",
    "mcp__tealbrick__knowledge__remember now",
    "tealbrick__knowledge__remember",
    "",
  ])
    assert.equal(pipeline.tealbrickOp(tool), null, JSON.stringify(tool));
  assert.equal(pipeline.toolName({ product: "knowledge", operation: "remember" }), "mcp__tealbrick__knowledge__remember");
});

test("a contract with no Teal Brick tool still imports; the report says to add an allowed operation before promotion, and promotion refuses until then", async () => {
  const db = migratedDb();
  const { draft, report } = await call<K.PipelineImportOutput>(H, "pipeline_import", { contract: p(8) }, owner(db));
  assert.deepEqual(draft.allowed, []);
  assert.ok(report.notes.some((n) => /Add at least one allowed operation/.test(n)));
  assert.throws(() => store.promote(db, draft.id, draft.revision, D0), /at least one operation/);
});

test("step titles are short labels; the whole `do` is the instruction; an empty `do` falls back to the step id", () => {
  const c = p(7);
  c.steps[0].do = `${"word ".repeat(40)}end`; // 205 characters
  c.steps[1].do = "";
  const { snapshot } = pipeline.mapContract(pipeline.parseContract(c));
  assert.ok((snapshot.steps[0]?.title.length ?? 0) <= 100 && snapshot.steps[0]?.title.endsWith("…"));
  assert.equal(snapshot.steps[0]?.instruction, c.steps[0].do.trim());
  assert.equal(snapshot.steps[1]?.title, c.steps[1].id);
  assert.equal(snapshot.steps[1]?.instruction, "");
});

// ── import: refusals ──

test("fire-on-bad: an invalid contract is refused with 422 and the pointer of the problem; the good one is not", async () => {
  const db = migratedDb();
  const run = (c: unknown) => refusal(() => pipeline.importPipeline(db, { contract: c }));
  const good = p(1);
  const ok = pipeline.importPipeline(db, { contract: good });
  assert.ok(ok.draft.id, "control: the good contract imports");
  const mutate = (fn: (c: Contract) => void): Contract => {
    const c = structuredClone(good);
    fn(c);
    return c;
  };
  const cases: [string, unknown, string][] = [
    ["id pattern", mutate((c) => (c.id = "P1_Daily")), "/id"],
    ["version zero", mutate((c) => (c.version = 0)), "/version"],
    ["bad on_fail", mutate((c) => (c.steps[1].on_fail = "explode")), "/steps/1/on_fail"],
    ["bad status", mutate((c) => (c.status = "live")), "/status"],
    ["purpose over 400", mutate((c) => (c.purpose = "x".repeat(401))), "/purpose"],
    ["step id pattern", mutate((c) => (c.steps[2].id = "Write")), "/steps/2/id"],
    ["step without do", mutate((c) => delete c.steps[0].do), "/steps/0/do"],
    ["no steps", mutate((c) => (c.steps = [])), "/steps"],
    ["tools not a list", mutate((c) => (c.steps[4].tools = "buzz")), "/steps/4/tools"],
    ["trigger empty", mutate((c) => (c.trigger = {})), "/trigger"],
    ["missing owner", mutate((c) => delete c.owner), "/owner"],
    ["escalation target", mutate((c) => (c.escalation[0].to = "bob")), "/escalation/0/to"],
    ["metrics not strings", mutate((c) => (c.metrics = [1])), "/metrics/0"],
  ];
  for (const [why, c, pointer] of cases) {
    const t = run(c);
    assert.equal(t.httpStatus, 422, why);
    assert.equal(t.code, "validation_failed", why);
    assert.equal((t.details as { pointer: string }).pointer, pointer, `${why}: ${t.message}`);
    assert.match(t.message, /pipeline contract is not valid/, why);
  }
  for (const bad of [null, [], "text", 7]) assert.equal((run(bad).details as { pointer: string }).pointer, "", `not an object: ${JSON.stringify(bad)}`);
  assert.equal((run({ ...good, $schema: 7 }).details as { pointer: string }).pointer, "/$schema");
  assert.equal(store.listDrafts(db).length, 1, "a refused import creates nothing");
  assert.equal((db.prepare("SELECT count(*) AS n FROM pipeline_sources").get() as { n: number }).n, 1);
});

test("fire-on-bad: an unknown field (top level, in a step, in the trigger) is refused and named; the same contract without it imports", () => {
  const db = migratedDb();
  const good = p(2);
  const withField = (path: "top" | "step" | "trigger"): Contract => {
    const c = structuredClone(good);
    if (path === "top") c.zzz = 1;
    else if (path === "step") c.steps[0].foo = "x";
    else c.trigger.at = "9";
    return c;
  };
  const want = { top: "/zzz", step: "/steps/0/foo", trigger: "/trigger/at" } as const;
  for (const where of ["top", "step", "trigger"] as const) {
    const t = refusal(() => pipeline.importPipeline(db, { contract: withField(where) }));
    assert.equal(t.httpStatus, 422);
    assert.equal((t.details as { pointer: string }).pointer, want[where]);
    assert.match(t.message, /unknown field/);
  }
  assert.ok(pipeline.importPipeline(db, { contract: good }).draft.id, "control");
});

test("a contract that is valid but does not fit a draft is refused at import with a pointer, not at the first Save", () => {
  const db = migratedDb();
  const long = p(1);
  long.steps[0].do = "x".repeat(4001);
  const t = refusal(() => pipeline.importPipeline(db, { contract: long }));
  assert.equal(t.httpStatus, 422);
  assert.equal((t.details as { pointer: string }).pointer, "/steps/0/do");
  const dupe = p(1);
  dupe.steps[1].id = dupe.steps[0].id;
  const t2 = refusal(() => pipeline.importPipeline(db, { contract: dupe }));
  assert.equal(t2.httpStatus, 422);
  assert.equal((t2.details as { pointer: string }).pointer, "/steps/1/id");
  const many = p(1);
  many.steps = Array.from({ length: 51 }, (_, i) => ({ id: `step-${i}`, do: "x" }));
  assert.equal((refusal(() => pipeline.importPipeline(db, { contract: many })).details as { pointer: string }).pointer, "/steps");
  const ok = p(1);
  ok.steps[0].do = "x".repeat(4000);
  assert.ok(pipeline.importPipeline(db, { contract: ok }).draft.id, "4000 characters is the limit and fits");
  assert.equal(store.listDrafts(db).length, 1);
});

test("the manifest schema of pipeline_import refuses a missing contract, a non-object, extra fields and a bad asDraftOf before the handler runs", () => {
  const op = manifest.operations.find((o) => o.id === "pipeline_import") as Parameters<typeof validateInput>[0];
  assert.equal(validateInput(op, { contract: p(1) } as Json).ok, true);
  assert.equal(validateInput(op, { contract: p(1), asDraftOf: "wfl_01J0000000000000000000000A" } as Json).ok, true);
  for (const bad of [{}, { contract: "x" }, { contract: [] }, { contract: p(1), extra: 1 }, { contract: p(1), asDraftOf: "not an id" }]) assert.equal(validateInput(op, bad as Json).ok, false, JSON.stringify(bad).slice(0, 60));
});

// ── asDraftOf ──

test("asDraftOf: a new draft of the workflow; the pipeline key must match (409 pipeline_id_mismatch); promotion makes the next version and freezes its contract", async () => {
  const db = migratedDb();
  const c = p(1);
  const first = await through(db, c);
  const c2 = structuredClone(c);
  c2.version = 2;
  c2.steps[0].do = "Find candidate items of the last 24 h";
  const { draft } = await call<K.PipelineImportOutput>(H, "pipeline_import", { contract: c2, asDraftOf: first.wf }, owner(db));
  assert.equal(draft.workflowId, first.wf, "a draft of that workflow");
  assert.equal(draft.title, store.getWorkflow(db, first.wf).title, "the workflow's own title is kept");
  assert.equal(draft.instruction, store.getVersion(db, first.wf).instruction, "and its instruction");
  assert.equal(draft.steps[0]?.instruction, "Find candidate items of the last 24 h");
  assert.ok(draft.pipeline?.report.notes.some((n) => /title and instruction of the workflow are kept/.test(n)));
  const promoted = store.promote(db, draft.id, draft.revision, D0 + 1000);
  assert.equal(promoted.version.version, 2);
  assert.equal(pipeline.versionSource(db, first.wf, 2)?.pipelineVersion, 2);
  assert.equal(pipeline.versionSource(db, first.wf, 1)?.pipelineVersion, 1, "version 1 keeps its own contract");
  const v1 = await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: first.wf, version: 1 }, owner(db));
  const v2 = await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: first.wf }, owner(db));
  assert.equal((v1.contract as Contract).status, "retired", "an older version is retired");
  assert.equal((v2.contract as Contract).status, "active");
  assert.equal((v2.contract as Contract).steps[0].do, "Find candidate items of the last 24 h");
  assert.equal((v1.contract as Contract).steps[0].do, c.steps[0].do);
  const versions = await call<K.WorkflowVersionsOutput>(H, "workflow_versions", { workflowId: first.wf }, owner(db));
  assert.deepEqual(versions.pipelines, [
    { version: 1, id: c.id, pipelineVersion: 1 },
    { version: 2, id: c.id, pipelineVersion: 2 },
  ]);

  // fire: another pipeline id for the same workflow is refused, and nothing is created
  const before = store.listDrafts(db).length;
  const other = { ...c2, id: "p2-source-vetting" };
  const t = refusal(() => pipeline.importPipeline(db, { contract: other, asDraftOf: first.wf }));
  assert.equal(t.httpStatus, 409);
  assert.equal(t.code, "pipeline_id_mismatch");
  assert.deepEqual(t.details, { workflowId: first.wf, storedPipelineId: c.id, contractId: "p2-source-vetting" });
  assert.equal(store.listDrafts(db).length, before);
  // an open import not yet promoted counts as the workflow's key too
  const open = pipeline.importPipeline(db, { contract: c2, asDraftOf: first.wf });
  assert.ok(open.draft.id);
  assert.equal(refusal(() => pipeline.importPipeline(db, { contract: other, asDraftOf: first.wf })).code, "pipeline_id_mismatch");
  // unknown workflow
  assert.equal(refusal(() => pipeline.importPipeline(db, { contract: c, asDraftOf: "wfl_missing" })).httpStatus, 404);
});

test("asDraftOf a workflow that was never imported is accepted (it takes the key); importing the same pipeline again without asDraftOf says a workflow exists", async () => {
  const db = migratedDb();
  const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "Hand made", summary: "", instruction: "Do it.", trigger: "", steps: [], allowed: READ } }, D0);
  const wf = store.promote(db, d.id, d.revision, D0).workflow.id;
  const r1 = pipeline.importPipeline(db, { contract: p(2), asDraftOf: wf });
  assert.ok(r1.report.notes.some((n) => /never imported/.test(n)));
  store.promote(db, r1.draft.id, r1.draft.revision, D0 + 1);
  assert.deepEqual(pipeline.pipelineIdsOfWorkflow(db, wf), ["p2-source-vetting"]);
  assert.equal(pipeline.versionSource(db, wf, 1), null, "version 1 was hand made");
  const again = pipeline.importPipeline(db, { contract: p(2) });
  assert.ok(again.report.notes.some((n) => n.includes(wf)), "the existing workflow is named");
});

// ── export ──

test("export of a workflow that was never imported is a valid contract with the documented defaults (every template, every state)", async () => {
  for (const t of TEMPLATES) {
    const db = migratedDb();
    const { id: _id, ...snapshot } = structuredClone(t);
    const d = store.createDraft(db, { suggestionId: null, templateId: t.id, snapshot }, D0);
    const wf = store.promote(db, d.id, d.revision, D0).workflow.id;
    const out = await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: wf }, owner(db));
    const c = out.contract as Contract;
    const v = valid(c);
    assert.equal(v.ok, true, `${t.id}: ${v.ok ? "" : JSON.stringify(v.errors)}`);
    assert.equal(out.imported, false);
    assert.equal(c.version, 1, "no contract: the Evolution version number");
    assert.equal(c.status, "active");
    assert.equal(c.owner, "unassigned");
    assert.match(c.id, /^[a-z][a-z0-9-]{2,40}$/);
    assert.equal(c.purpose, t.summary);
    assert.deepEqual(c.trigger, { event: "manual" }, "words in the trigger are not a schedule");
    assert.deepEqual(c.steps.map((s: Contract) => s.id), t.steps.map((s) => s.id));
    for (const [i, s] of t.steps.entries()) assert.deepEqual(c.steps[i].tools ?? [], s.ops.map((o) => `mcp__tealbrick__${o.product}__${o.operation}`), `${t.id} step ${s.id}`);
    assert.deepEqual(c.steps.map((s: Contract) => s.do), t.steps.map((s) => s.instruction || s.title));
  }
});

test("export defaults: a schedule gives the cron in UTC; a cron-looking trigger text too; odd step ids are made valid and unique; no steps gives one run step; allowed operations no step uses are named", async () => {
  const db = migratedDb();
  const d = store.createDraft(
    db,
    {
      suggestionId: null,
      templateId: null,
      snapshot: {
        title: "Weekly Café Report!",
        summary: "",
        instruction: "Write the report.",
        trigger: "30 8 * * 1",
        steps: [
          { id: "Step_One", title: "First", instruction: "Do 1", ops: [{ product: "kanban", operation: "issues_list" }] },
          { id: "step-one", title: "Second", instruction: "", ops: [] },
          { id: "9", title: "Third", instruction: "Do 3", ops: [] },
        ],
        allowed: [
          { product: "kanban", operations: ["issues_list"], crud: ["read"] },
          { product: "knowledge", operations: ["remember"], crud: ["create"] },
        ],
      },
    },
    D0,
  );
  const wf = store.promote(db, d.id, d.revision, D0).workflow.id;
  let out = await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: wf }, owner(db));
  let c = out.contract as Contract;
  assert.equal(valid(c).ok, true);
  assert.deepEqual(c.trigger, { cron: "30 8 * * 1", timezone: "UTC" });
  assert.equal(c.id, "weekly-caf-report");
  assert.equal(c.purpose, "Weekly Café Report!", "no summary: the title");
  assert.deepEqual(c.steps.map((s: Contract) => s.id), ["step-one", "step-one-2", "s-9"], "lower case, hyphen, starts with a letter, unique");
  assert.equal(c.steps[1].do, "Second", "no instruction: the title");
  assert.deepEqual(out.omitted, ["knowledge.remember"]);
  r.setAutomation(db, { workflowId: wf, agentId: BOUND.id, cron: "0 7 * * *" }, D0);
  out = await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: wf }, owner(db));
  c = out.contract as Contract;
  assert.deepEqual(c.trigger, { cron: "0 7 * * *", timezone: "UTC" }, "the live schedule wins");

  const e = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "!!", summary: "", instruction: "Do it.", trigger: "", steps: [], allowed: READ } }, D0);
  const wf2 = store.promote(db, e.id, e.revision, D0).workflow.id;
  const o2 = await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: wf2 }, owner(db));
  const c2 = o2.contract as Contract;
  assert.equal(valid(c2).ok, true);
  assert.match(c2.id, /^wfl-/, "a title with no letters: the workflow id");
  assert.deepEqual(c2.steps, [{ id: "run", do: "Do it.", tools: ["mcp__tealbrick__kanban__issues_list"] }]);
});

test("owner edits show in the export: a removed Teal Brick tool goes, an added one comes, unmapped tools and typed fields stay with their step, new steps get ids", async () => {
  const db = migratedDb();
  const c = p(1);
  const { draftId } = await through(db, c);
  let d = store.getDraft(db, draftId);
  const send = d.steps.find((s) => s.id === "send");
  assert.ok(send);
  d = store.updateDraft(
    db,
    d.id,
    d.revision,
    {
      summary: "A new purpose.",
      steps: [
        ...d.steps.filter((s) => s.id !== "gate").map((s) => (s.id === "send" ? { ...s, ops: [{ product: "knowledge", operation: "link_add" }] } : s)),
        { title: "Archive it", instruction: "File the shortlist.", ops: [] },
      ],
      allowed: [{ product: "knowledge", operations: ["link_add", "remember"], crud: ["create", "read"] }],
    },
    D0 + 5,
  );
  const wf = store.getWorkflow(db, store.getDraft(db, draftId).workflowId as string).id;
  store.promote(db, d.id, d.revision, D0 + 10);
  const out = (await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: wf }, owner(db))).contract as Contract;
  assert.equal(valid(out).ok, true);
  assert.equal(out.purpose, "A new purpose.");
  assert.deepEqual(out.steps.map((s: Contract) => s.id), ["scan", "write", "check", "send", "s1"], "gate removed, the new step last");
  const sent = out.steps.find((s: Contract) => s.id === "send");
  assert.deepEqual(sent.tools, ["buzz reply (runtime)", "mcp__tealbrick__knowledge__link_add"], "remember removed, link_add added after the unmapped tool, unmapped kept");
  assert.equal(out.steps.find((s: Contract) => s.id === "scan").lead, "research-lead", "typed fields stay with their step");
  assert.deepEqual(out.steps[4], { id: "s1", do: "File the shortlist." });
  // untouched parts are exactly what came in
  for (const k of ["owner", "dictation_refs", "trigger", "inputs", "outputs", "done_when", "approvals", "escalation", "metrics", "taskboard", "$schema", "id", "version"]) assert.deepEqual(out[k], c[k], k);
  // version 1 is still exactly the import (round trip), version 2 is the edit
  const v1 = (await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: wf, version: 1 }, owner(db))).contract as Contract;
  const { status: _a, ...a } = v1;
  const { status: _b, ...b } = c;
  assert.deepEqual(a, b);
});

test("a step's `do` and the purpose come back exactly as imported, also with leading or trailing spaces; an edited one comes back as edited", async () => {
  const db = migratedDb();
  const c = p(2);
  c.purpose = `  ${c.purpose}  `;
  c.steps[0].do = `\t${c.steps[0].do} \n`;
  const { out, draftId } = await through(db, c);
  assert.equal((out.contract as Contract).purpose, c.purpose);
  assert.equal((out.contract as Contract).steps[0].do, c.steps[0].do);
  const d = store.getDraft(db, draftId);
  store.updateDraft(db, d.id, d.revision, { steps: d.steps.map((s, i) => (i === 0 ? { ...s, instruction: "Changed." } : s)) }, D0 + 1);
  const d2 = store.getDraft(db, draftId);
  store.promote(db, d2.id, d2.revision, D0 + 2);
  const wf = store.getDraft(db, draftId).workflowId as string;
  assert.equal(((await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: wf }, owner(db))).contract as Contract).steps[0].do, "Changed.");
});

test("export refusals: an unknown workflow or version is 404", async () => {
  const db = migratedDb();
  const { wf } = await through(db, p(1));
  await assert.rejects(call(H, "pipeline_export", { workflowId: "wfl_missing" }, owner(db)), /No workflow/);
  await assert.rejects(call(H, "pipeline_export", { workflowId: wf, version: 9 }, owner(db)), /no version 9/);
  const op = manifest.operations.find((o) => o.id === "pipeline_export") as Parameters<typeof validateInput>[0];
  assert.equal(validateInput(op, { workflowId: wf, version: 0 } as Json).ok, false);
});

// ── who may call, and what an agent never sees ──

test("both new ops are person ops; no agent op takes or returns a pipeline field; the schema of draft_get and workflow_versions carry the import for the owner only", () => {
  const byId = new Map(manifest.operations.map((o) => [o.id, o]));
  assert.equal(byId.get("pipeline_import")?.audience, "person");
  assert.equal(byId.get("pipeline_export")?.audience, "person");
  assert.deepEqual([byId.get("pipeline_import")?.crud, byId.get("pipeline_import")?.effect, byId.get("pipeline_import")?.receipt], [["create"], "write", true]);
  assert.deepEqual([byId.get("pipeline_export")?.crud, byId.get("pipeline_export")?.effect, byId.get("pipeline_export")?.receipt], [["read"], "read", false]);
  for (const o of manifest.operations.filter((x) => x.audience === "agent")) assert.doesNotMatch(JSON.stringify([o.input, o.output]), /pipelineId|pipelineSource|pipeline_source|dictation|done_when|escalation/i, `${o.id} schema`);
  assert.equal(manifest.operations.length, 32);
});

const CANARY = {
  owner: "CANARY-owner-91f3",
  dictation: "CANARY-dictation-a7c2#part9",
  done: "CANARY-done-when-5d10",
  escalation: "CANARY-escalation-3be8",
  note: "CANARY-approval-note-c04a",
  input: "CANARY-input-what-77e1",
  output: "CANARY-output-2fa9",
  issue: "CANARY-issue-title-b6d3",
  lead: "canary-lead-e51c",
  skill: "canary-skill-08ab",
  when: "CANARY-when-d9f4",
  purpose: "CANARY-purpose-1c7e",
};

test("leak: nothing of the stored contract reaches an agent op (workflow_get, suggestions, due, claim, report); the purpose reaches it only as the workflow summary the owner promoted", async () => {
  const db = migratedDb();
  const c: Contract = {
    id: "canary-pipeline",
    version: 4,
    owner: CANARY.owner,
    purpose: CANARY.purpose,
    dictation_refs: [CANARY.dictation],
    trigger: { cron: "0 8 * * *" },
    inputs: [{ source: "taskboard", what: CANARY.input }],
    steps: [
      { id: "read", do: "Read the board", lead: CANARY.lead, skills: [CANARY.skill], when: CANARY.when, tools: ["mcp__tealbrick__kanban__issues_list", "buzz reply (runtime)"] },
    ],
    outputs: [CANARY.output],
    done_when: [CANARY.done],
    approvals: { notes: CANARY.note },
    escalation: [{ to: "martin", when: CANARY.escalation, via: "buzz_martin" }],
    metrics: ["minutes"],
    taskboard: { issue_title: CANARY.issue },
  };
  const imp = await call<K.PipelineImportOutput>(H, "pipeline_import", { contract: c }, owner(db));
  const wf = store.promote(db, imp.draft.id, imp.draft.revision, D0).workflow.id;
  r.setAutomation(db, { workflowId: wf, agentId: BOUND.id, cron: "0 8 * * *" }, D0);
  const calls: unknown[] = [];
  const callApp: CallApp = async (_product, op, input) => {
    calls.push({ op, input });
    return { status: "ok", output: { id: "iss_run1" } } as unknown as CompanionResult;
  };
  const now = Date.now();
  r.setAutomation(db, { workflowId: wf, agentId: BOUND.id, cron: "* * * * *" }, now - 120_000);
  const ctx = ctxFor(db, BOUND, callApp);
  const seen: unknown[] = [];
  seen.push(await call(H, "workflow_get", { id: wf }, ctx));
  seen.push(await call(H, "workflow_get", { id: wf, version: 1 }, ctx));
  const due = await call<K.RoutinesDueOutput>(H, "routines_due", {}, ctx);
  seen.push(due);
  const occ = due.jobs[0]?.occurrence;
  assert.ok(occ, "a run is due");
  seen.push(await call(H, "routine_claim", { occurrence: occ }, ctx));
  seen.push(await call(H, "routine_report", { occurrence: occ, status: "completed", summary: "done" }, ctx));
  seen.push(await call(H, "suggestions_list", {}, ctx));
  const text = JSON.stringify([seen, calls]);
  for (const [k, canary] of Object.entries(CANARY)) {
    if (k === "purpose") continue;
    assert.ok(!text.includes(canary), `agent ops and the Kanban call must not carry the contract's ${k}`);
  }
  assert.doesNotMatch(text, /pipeline_id|pipelineId|pipelineSource|pipeline_source|dictation_refs|done_when/);
  const get = seen[0] as { summary: string };
  assert.equal(get.summary, CANARY.purpose, "the purpose is the workflow summary: agent-visible by the owner's own promotion, as for any workflow");
  // control: the owner sees the stored contract (the canaries are really stored)
  const stored = JSON.stringify((await call<K.PipelineExportOutput>(H, "pipeline_export", { workflowId: wf }, owner(db))).contract);
  for (const canary of Object.values(CANARY)) assert.ok(stored.includes(canary), `the owner's export has ${canary}`);
});

test("leak: the person-only draft_get shows the import; the agent-side Version has exactly the fields it had before R10", async () => {
  const db = migratedDb();
  const { wf, imported } = await through(db, p(1));
  const draft = await call<K.DraftGetOutput>(H, "draft_get", { id: imported.draft.id }, owner(db));
  assert.equal(draft.pipeline?.id, "p1-daily-tidbit");
  assert.equal(draft.pipeline?.version, 1);
  const got = await call<Record<string, unknown>>(H, "workflow_get", { id: wf }, ctxFor(db, BOUND));
  assert.deepEqual(Object.keys(got).sort(), ["allowed", "draftId", "draftRevision", "instruction", "notice", "promotedAt", "steps", "summary", "title", "trigger", "version", "workflowId"]);
  const plain = await call<K.DraftGetOutput>(H, "draft_get", { id: store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "x", summary: "", instruction: "", trigger: "", steps: [], allowed: [] } }, D0).id }, owner(db));
  assert.equal(plain.pipeline, null, "a draft that was not imported says null");
});

test("the receipt text of pipeline_import names the pipeline id, never the contract text", async () => {
  const spec = (handlers as unknown as Record<string, { redact: (i: unknown, o?: unknown) => string }>).pipeline_import;
  assert.ok(spec);
  const text = spec.redact({ contract: { id: "p1-daily-tidbit", purpose: CANARY.purpose, owner: CANARY.owner } }, { draft: { id: "wfd_1" } });
  assert.equal(text, "Imported pipeline p1-daily-tidbit as draft wfd_1");
  assert.doesNotMatch(text, /CANARY/);
  assert.equal(spec.redact({ contract: null }), "Imported pipeline contract");
});

// ── storage ──

test("the stored contract is the contract as imported (not the mapped text) and promotion freezes a copy per version", async () => {
  const db = migratedDb();
  const c = p(3);
  const { draftId, wf } = await through(db, c);
  const row = db.prepare("SELECT * FROM pipeline_sources WHERE draft_id = ?").get(draftId) as Record<string, unknown>;
  assert.deepEqual(JSON.parse(String(row.source)), c);
  assert.equal(row.pipeline_id, c.id);
  assert.equal(row.pipeline_version, c.version);
  const frozen = db.prepare("SELECT * FROM workflow_version_pipelines WHERE workflow_id = ?").all(wf);
  assert.equal(frozen.length, 1);
  assert.deepEqual(JSON.parse(String(frozen[0]?.source)), c);
  // constraints: one row per draft, valid ids, JSON objects only
  const ins = db.prepare("INSERT INTO pipeline_sources (draft_id, pipeline_id, pipeline_version, source, report, imported_at) VALUES (?, ?, ?, ?, ?, 0)");
  assert.throws(() => ins.run(draftId, "p1-x", 1, "{}", "{}"), /UNIQUE|PRIMARY/);
  assert.throws(() => ins.run("wfd_missing", "p1-x", 1, "{}", "{}"), /FOREIGN KEY/);
  const other = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "o", summary: "", instruction: "", trigger: "", steps: [], allowed: [] } }, D0);
  assert.throws(() => ins.run(other.id, "ab", 1, "{}", "{}"), /CHECK/, "id too short");
  assert.throws(() => ins.run(other.id, "p1-x", 0, "{}", "{}"), /CHECK/, "version at least 1");
  assert.throws(() => ins.run(other.id, "p1-x", 1, "[]", "{}"), /CHECK/, "source is an object");
  assert.throws(() => ins.run(other.id, "p1-x", 1, "{}", "not json"), /CHECK/);
  ins.run(other.id, "p1-x", 1, "{}", "{}");
});
