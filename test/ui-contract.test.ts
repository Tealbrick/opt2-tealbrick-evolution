// The owner UI's contract helpers (src/ui/engine-contract.ts: the editor's live check; WP2's validateContract runs on the server): quiet on the two
// example workflows of ENGINE-BUILD §12, loud on every rule they break; the lanes of the canonical shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateContract } from "../src/engine/validate.ts";
import { appOps, LANES, liveCheck, placeSteps, STAGES, type Step, type WorkflowContract } from "../src/ui/engine-contract.ts";
import { DAILY_EMAIL_SUMMARY, INBOUND_EMAIL_ADVISOR } from "../src/ui/engine-samples.ts";

const clone = (): WorkflowContract => structuredClone(DAILY_EMAIL_SUMMARY);
const errorsOf = (c: unknown) => liveCheck(c).errors;
const has = (c: unknown, pointer: string, text: RegExp) => errorsOf(c).some((e) => e.pointer === pointer && text.test(e.message));

test("quiet: both example workflows of ENGINE-BUILD §12 are valid", () => {
  for (const c of [DAILY_EMAIL_SUMMARY, INBOUND_EMAIL_ADVISOR]) {
    const v = liveCheck(c);
    assert.deepEqual(v.errors, [], c.id);
    assert.equal(v.ok, true);
  }
  // the notes are honest: events need P2, an agent step acts with its own access
  const notes = liveCheck(INBOUND_EMAIL_ADVISOR).warnings.map((w) => w.message).join(" | ");
  assert.match(notes, /P2/);
  assert.match(notes, /own access/);
  assert.deepEqual(liveCheck(DAILY_EMAIL_SUMMARY).warnings, [], "the model-role workflow has nothing to note");
});

test("fire: not an object, wrong format, bad ids, no title, no trigger", () => {
  assert.equal(liveCheck(null).ok, false);
  assert.equal(liveCheck([]).ok, false);
  const c = { ...clone(), format: "x", id: "Bad Id", version: 0, title: " ", triggers: [] };
  for (const p of ["/format", "/id", "/version", "/title", "/triggers"]) assert.ok(errorsOf(c).some((e) => e.pointer === p), p);
});

test("fire: a step id used twice, a bad id and an unknown kind", () => {
  const c = clone();
  (c.steps[1] as Step).id = "fetch";
  assert.ok(has(c, "/steps/1/id", /used twice/));
  const d = clone();
  (d.steps[0] as Step).id = "Fetch-1";
  assert.ok(has(d, "/steps/0/id", /lower case/));
  const e = clone();
  e.steps.push({ id: "x", type: "magic" } as unknown as Step);
  assert.ok(has(e, "/steps/5/type", /one of/));
});

test("fire: refs must resolve, and only to steps that have run", () => {
  const dangling = clone();
  (dangling.steps[4] as { input: Record<string, unknown> }).input = { tool: "t", arguments: { body: "{{ $steps.nope.output }}" } };
  assert.ok(has(dangling, "/steps/4/input", /\$steps\.nope .* does not exist/));
  const early = clone();
  early.steps.reverse(); // `draft` first: it reads body, which has not run yet
  assert.ok(errorsOf(early).some((e) => /used before it has run/.test(e.message)));
  const undeclared = clone();
  (undeclared.steps[0] as { input: Record<string, unknown> }).input = { tool: "t", arguments: { who: "{{ $input.nobody }}" } };
  assert.ok(has(undeclared, "/steps/0/input", /\$input\.nobody is not declared/));
  const outputs = clone();
  outputs.outputs = { x: "$steps.ghost.output" };
  assert.ok(has(outputs, "/outputs/x", /does not exist/));
});

test("fire: a sibling branch of a parallel step is not visible to the other branch; after the parallel it is", () => {
  const c = structuredClone(INBOUND_EMAIL_ADVISOR);
  const gate = c.steps[2] as unknown as { then: Step[] };
  const par = gate.then[0] as unknown as { branches: Record<string, Step[]> };
  const notes = par.branches.history?.[0] as unknown as { input: Record<string, unknown> };
  notes.input = { query: "{{ $steps.crm.output }}" }; // `crm` is in the branch next door
  assert.ok(errorsOf(c).some((e) => /used before it has run/.test(e.message)));
  assert.deepEqual(errorsOf(INBOUND_EMAIL_ADVISOR), [], "brief reads crm, notes and sentiment after the parallel step");
});

test("fire: an ai step needs a role or an agent, not both, and a typed output", () => {
  const both = clone();
  (both.steps[2] as unknown as { by: object }).by = { role: "summarize", agent: "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85" };
  assert.ok(has(both, "/steps/2/by", /not both/));
  const none = clone();
  (none.steps[2] as unknown as { by: object }).by = {};
  assert.ok(has(none, "/steps/2/by", /not neither|not both and not neither/));
  const noSchema = clone();
  delete (noSchema.steps[2] as unknown as { outputSchema?: unknown }).outputSchema;
  assert.ok(has(noSchema, "/steps/2/outputSchema", /required/));
  const notObject = clone();
  (notObject.steps[2] as unknown as { outputSchema: object }).outputSchema = { type: "array" };
  assert.ok(has(notObject, "/steps/2/outputSchema/type", /object/));
  const badAgent = clone();
  (badAgent.steps[2] as unknown as { by: object }).by = { agent: "polly" };
  assert.ok(has(badAgent, "/steps/2/by/agent", /agent id/));
  const noInstruction = clone();
  (noInstruction.steps[2] as unknown as { instruction: string }).instruction = " ";
  assert.ok(has(noInstruction, "/steps/2/instruction", /required/));
});

test("fire: a loop must have a bound, a transform exactly one operation, a timer one way to wait", () => {
  const loop = (max: unknown): WorkflowContract => ({ ...clone(), outputs: {}, steps: [{ id: "each", type: "loop", forEach: "$input.account", max, steps: [] } as unknown as Step] });
  assert.ok(has(loop(undefined), "/steps/0/max", /bound/));
  assert.ok(has(loop(201), "/steps/0/max", /1 to 200/));
  assert.deepEqual(errorsOf(loop(200)), []);
  const t = clone();
  (t.steps[1] as unknown as { pick: object }).pick = { a: "$input.account" }; // map AND pick
  assert.ok(has(t, "/steps/1", /exactly one operation/));
  const timer = { ...clone(), outputs: {}, steps: [{ id: "w", type: "timer" } as Step] };
  assert.ok(has(timer, "/steps/0", /seconds or until/));
  const parallel = { ...clone(), outputs: {}, steps: [{ id: "p", type: "parallel", branches: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`b${i}`, []])) } as Step] };
  assert.ok(has(parallel, "/steps/0/branches", /At most 8/));
});

test("fire: $loop.item and $item only where they mean something; a condition needs its if", () => {
  const c = clone();
  (c.steps[0] as { input: Record<string, unknown> }).input = { tool: "t", arguments: { x: "{{ $loop.item }}" } };
  assert.ok(has(c, "/steps/0/input", /only be used inside a loop/));
  const item = clone();
  (item.steps[0] as { input: Record<string, unknown> }).input = { tool: "t", arguments: { x: "{{ $item.a }}" } };
  assert.ok(has(item, "/steps/0/input", /\$item/));
  const inLoop: WorkflowContract = { ...clone(), outputs: {}, steps: [{ id: "each", type: "loop", forEach: "$input.account", max: 3, steps: [{ id: "x", type: "app", product: "knowledge", op: "recall", input: { query: "{{ $loop.item }}" } }] } as Step] };
  assert.deepEqual(errorsOf(inLoop), []);
  // biome-ignore lint/suspicious/noThenProperty: the condition step of the contract names its branch "then"
  const noIf = { ...clone(), outputs: {}, steps: [{ id: "g", type: "condition", then: [] } as unknown as Step] };
  assert.ok(has(noIf, "/steps/0/if", /required/));
});

test("fire: triggers - cron xor every, five fields, an IANA time zone, a poll needs its cursor", () => {
  const trig = (t: unknown): WorkflowContract => ({ ...clone(), triggers: [t as WorkflowContract["triggers"][number]] });
  assert.ok(has(trig({ kind: "schedule", timezone: "UTC" }), "/triggers/0", /cron or an every/));
  assert.ok(has(trig({ kind: "schedule", cron: "0 8 * *", timezone: "UTC" }), "/triggers/0/cron", /5 fields/));
  assert.ok(has(trig({ kind: "schedule", cron: "0 8 * * *", timezone: "Mars/Olympus" }), "/triggers/0/timezone", /IANA/));
  assert.ok(has(trig({ kind: "schedule", every: "15 minutes", timezone: "UTC" }), "/triggers/0/every", /15m/));
  assert.deepEqual(errorsOf(trig({ kind: "schedule", every: "15m", timezone: "Europe/Berlin" })), []);
  assert.ok(has(trig({ kind: "poll", product: "connect", op: "tools", every: "5m", cursorPath: "result" }), "/triggers/0/cursorPath", /JSON pointer/));
  assert.ok(has(trig({ kind: "weird" }), "/triggers/0/kind", /one of|must be/));
});

test("fire: more steps than the limit, and metrics over 20", () => {
  const c = clone();
  c.steps = Array.from({ length: 201 }, (_, i) => ({ id: `s${i}`, type: "timer", seconds: 1 }) as Step);
  assert.ok(has(c, "/steps", /At most 200/));
  const m = clone();
  m.metrics = Array.from({ length: 21 }, (_, i) => `metric_${i}`);
  assert.ok(errorsOf(m).some((e) => e.pointer === "/metrics"));
});

test("the lanes: a label wins, a container's label goes to its children, the kind decides the rest, flow control has no lane", () => {
  const a = placeSteps(DAILY_EMAIL_SUMMARY.steps).map((p) => [p.step.id, p.stage, p.inferred]);
  assert.deepEqual(a, [
    ["fetch", "enrichment", false],
    ["slim", "process", false],
    ["summary", "intelligence", false],
    ["body", "concat", false],
    ["draft", "result", false],
  ]);
  const b = placeSteps(INBOUND_EMAIL_ADVISOR.steps);
  const stage = (id: string) => b.find((p) => p.step.id === id);
  assert.deepEqual([stage("crm")?.stage, stage("crm")?.inferred], ["enrichment", true], "the branches take the label of their parallel step");
  assert.deepEqual([stage("sentiment")?.stage, stage("sentiment")?.step.type], ["enrichment", "ai"], "an agent step can sit in the enrichment lane");
  assert.equal(stage("gate")?.stage, null, "a condition without a label is flow control");
  assert.equal(stage("review")?.stage, null, "so is an approval");
  assert.deepEqual(stage("crm")?.within, ["gate › then", "enrich › customer"]);
  // the canonical order is the order of LANES (the event lane is the trigger; the labels of a step are WP2's STAGES)
  assert.deepEqual([...LANES], ["event", "process", "enrichment", "concat", "intelligence", "result"]);
  assert.deepEqual([...STAGES], ["process", "enrichment", "concat", "intelligence", "result"]);
});

test("appOps lists each op once, a dynamic tool by its name, the poll trigger first", () => {
  assert.deepEqual(
    appOps(DAILY_EMAIL_SUMMARY).map((o) => `${o.product}.${o.op}:${o.tool}`),
    ["connect.tools:gmail_fetch_emails", "connect.tools:gmail_create_email_draft"],
  );
  const b = appOps(INBOUND_EMAIL_ADVISOR).map((o) => `${o.product}.${o.op}:${o.tool}|${o.via}`);
  assert.equal(b[0], "connect.tools:gmail_fetch_emails|poll trigger");
  assert.ok(b.includes("knowledge.recall:null|step notes"));
  assert.equal(new Set(b).size, b.length);
  assert.deepEqual(appOps({ steps: [], triggers: [] }), []);
});

// ── the quick check is bound to WP2's validator (the real one runs on the server) ──

test("quiet: the editor's examples are accepted by WP2's validateContract, so Save and Activate work on them", () => {
  for (const c of [DAILY_EMAIL_SUMMARY, INBOUND_EMAIL_ADVISOR]) {
    const v = validateContract(c, { companions: null });
    assert.deepEqual(v.errors, [], c.id);
  }
});

test("fire: what the quick check refuses, WP2's validator refuses too (ids, transform ops, retry, timer, workflow step, stage labels)", () => {
  const mutate = (f: (c: WorkflowContract) => void): WorkflowContract => {
    const c = clone();
    f(c);
    return c;
  };
  const cases: Record<string, WorkflowContract> = {
    "a workflow id of two characters": mutate((c) => {
      c.id = "ab";
    }),
    "a step id with an upper-case letter": mutate((c) => {
      (c.steps[1] as Step).id = "Slim";
    }),
    "a transform with two operations": mutate((c) => {
      (c.steps[3] as { pick?: object }).pick = {};
    }),
    "retry.max of 0": mutate((c) => {
      (c.steps[0] as { retry?: object }).retry = { max: 0 };
    }),
    "a timer of 0 seconds": mutate((c) => {
      c.steps.push({ id: "wait", type: "timer", seconds: 0 });
    }),
    "an unknown stage label": mutate((c) => {
      (c.steps[0] as { stage?: string }).stage = "event";
    }),
    "an agent id that is not an agent id": mutate((c) => {
      (c.steps[2] as { by: object }).by = { agent: "not-an-agent" };
    }),
    "a workflow step without a workflow": mutate((c) => {
      c.steps.push({ id: "sub", type: "workflow" } as unknown as Step);
    }),
  };
  for (const [what, c] of Object.entries(cases)) {
    assert.equal(liveCheck(c).ok, false, `quick check: ${what}`);
    assert.equal(validateContract(c, { companions: null }).ok, false, `WP2: ${what}`);
  }
});

test("quiet: the new engine shapes pass the quick check (a workflow step, the WP2 transform operations, a hyphen in an id)", () => {
  const c = clone();
  c.steps.push({ id: "child", type: "workflow", workflow: "inbound-email-advisor", input: {} });
  c.steps.push({ id: "sorted", type: "transform", sort: { from: "$steps.slim.output", by: "from", order: "asc" } });
  c.steps.push({ id: "clean", type: "transform", normalise: { from: "$steps.slim.output", fields: ["from"], ops: ["trim", "lowercase"] } });
  c.steps.push({ id: "a-b", type: "transform", template: "x" });
  assert.deepEqual(liveCheck(c).errors, []);
});
