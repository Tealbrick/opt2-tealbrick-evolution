// transform step (C367 condition 1): pick, rename, merge, concat, template, map, filter, dedupe, sort, normalise.
// Pure and deterministic: no code, no AI, no I/O. A bad input is loud (ExprError), a missing optional value is not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ExprError, type Scope } from "../../src/engine/expr.ts";
import { normaliseDate, normalisePhone, opOfTransform, runTransform, type TransformSpec } from "../../src/engine/transform.ts";

const people = [
  { name: " Ann ", email: "ANN@X.ORG", age: 30, joined: "03.04.2025", phone: " 0049 170-123 " },
  { name: "bob", email: "bob@x.org", age: 25, joined: "2025-04-05", phone: "+1 (555) 010-9999" },
  { name: "ann", email: "ann@x.org", age: 41, joined: "Apr 6, 2025 10:00:00 GMT", phone: "555" },
  { name: "Cy", email: "cy@x.org", age: 25, joined: "not a date", phone: "" },
];
const scope: Scope = { input: { people, me: { id: "u1", name: "Me" }, tags: ["a", "b"], more: ["c"], n: 2 }, trigger: {}, steps: { s: { output: { list: [3, 1, 2] } } } };
const run = (spec: TransformSpec): unknown => runTransform(spec, scope);

test("pick builds an object from refs, templates and literals", () => {
  assert.deepEqual(run({ pick: { id: "$input.me.id", label: "User {{ $input.me.name }}", fixed: 7, nested: { n: "$input.n" }, gone: "$input.missing" } }), { id: "u1", label: "User Me", fixed: 7, nested: { n: 2 }, gone: null });
});

test("merge: a list of objects (later wins) or a map of whole values", () => {
  assert.deepEqual(run({ merge: [{ a: 1, b: 2 }, "$input.me", { b: 3 }] }), { a: 1, b: 3, id: "u1", name: "Me" });
  assert.deepEqual(run({ merge: { me: "$input.me", count: "$input.n" } }), { me: { id: "u1", name: "Me" }, count: 2 });
  assert.throws(() => run({ merge: ["$input.tags"] }), /takes objects/);
});

test("rename changes keys of an object, or of every object in a list", () => {
  assert.deepEqual(run({ rename: { from: "$input.me", map: { id: "userId" } } }), { userId: "u1", name: "Me" });
  assert.deepEqual((run({ rename: { from: "$input.people", map: { email: "mail" } } }) as Record<string, unknown>[])[1]?.mail, "bob@x.org");
});

test("concat: lists become one list, anything else one string with a separator", () => {
  assert.deepEqual(run({ concat: { items: ["$input.tags", "$input.more", ["z"]] } }), ["a", "b", "c", "z"]);
  assert.equal(run({ concat: { items: ["x", "$input.n", "$input.missing", "y"], separator: "-" } }), "x-2-y");
});

test("template renders a string (also from a list with join)", () => {
  assert.equal(run({ template: "Hi {{ $input.me.name }}: {{ join($input.tags, '/') }} ({{ len($input.people) }})" }), "Hi Me: a/b (4)");
  assert.equal(run({ template: "{{ $input.n }}" }), "2", "a transform template is always a string");
});

test("map renders one value per element with $item and $index", () => {
  assert.deepEqual(run({ map: { forEach: "$input.people", template: { who: "{{ $item.name }}", i: "$index" } } }), [
    { who: " Ann ", i: 0 },
    { who: "bob", i: 1 },
    { who: "ann", i: 2 },
    { who: "Cy", i: 3 },
  ]);
  assert.deepEqual(run({ map: { forEach: "$input.missing", template: "x" } }), [], "a missing list is empty");
  assert.throws(() => run({ map: { forEach: "$input.me", template: "x" } }), /must be a list/);
});

test("filter keeps the elements for which the expression is true", () => {
  const out = run({ filter: { from: "$input.people", where: { and: [{ ">=": ["$item.age", 25] }, { "!=": ["$item.name", "bob"] }] } } }) as { name: string }[];
  assert.deepEqual(
    out.map((x) => x.name),
    [" Ann ", "ann", "Cy"],
  );
});

test("dedupe keeps the first element per value", () => {
  assert.deepEqual(
    (run({ dedupe: { from: "$input.people", by: "age" } }) as { name: string }[]).map((x) => x.name),
    [" Ann ", "bob", "ann"],
  );
  assert.deepEqual(run({ dedupe: { from: "$steps.s.output.list" } }), [3, 1, 2]);
});

test("sort is stable, asc by default, desc on request, by a path or the whole value", () => {
  assert.deepEqual(run({ sort: { from: "$steps.s.output.list" } }), [1, 2, 3]);
  assert.deepEqual(run({ sort: { from: "$steps.s.output.list", order: "desc" } }), [3, 2, 1]);
  const byAge = run({ sort: { from: "$input.people", by: "age" } }) as { name: string }[];
  assert.deepEqual(
    byAge.map((x) => x.name),
    ["bob", "Cy", " Ann ", "ann"],
    "bob and Cy are both 25: the input order stays",
  );
});

test("normalise: trim, lowercase, uppercase, collapse_spaces, date, phone on a value or on fields", () => {
  const out = run({ normalise: { from: "$input.people", fields: ["name", "email", "joined", "phone"], ops: ["trim", "lowercase"] } }) as Record<string, unknown>[];
  assert.equal(out[0]?.name, "ann");
  assert.equal(out[0]?.email, "ann@x.org");
  assert.equal(out[0]?.age, 30, "a field not listed stays");
  const joined = (run({ normalise: { from: "$input.people", fields: ["joined"], ops: ["date"] } }) as Record<string, string>[]).map((x) => x.joined);
  assert.deepEqual(joined, ["2025-04-03", "2025-04-05", "2025-04-06T10:00:00.000Z", "not a date"]);
  assert.deepEqual(
    (run({ normalise: { from: "$input.people", fields: ["phone"], ops: ["phone"] } }) as Record<string, unknown>[]).map((x) => x.phone),
    ["+49170123", "+15550109999", "555", ""],
  );
  assert.equal(run({ normalise: { from: "$input.me.name", ops: ["uppercase"] } }), "ME");
  assert.equal(run({ normalise: { from: "$input.me.name", ops: ["collapse_spaces"] } }), "Me");
  assert.equal(run({ normalise: { from: "$input.missing", ops: ["trim"] } }), undefined, "a missing value stays missing");
  assert.equal(normaliseDate("2025-01-02"), "2025-01-02");
  assert.equal(normaliseDate("31.12.2024"), "2024-12-31");
  assert.equal(normaliseDate("32.13.2024"), "32.13.2024");
  assert.equal(normalisePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalisePhone("00 44 20"), "+4420");
});

test("normalise never reaches a prototype key and does not change its input", () => {
  const before = JSON.stringify(scope.input);
  run({ normalise: { from: "$input.people", fields: ["__proto__.x", "constructor", "name"], ops: ["trim"] } });
  assert.equal(JSON.stringify(scope.input), before);
  assert.equal(({} as Record<string, unknown>).x, undefined);
});

test("one op per step; errors are loud", () => {
  assert.equal(opOfTransform({ id: "a", type: "transform", pick: {} }), "pick");
  assert.equal(opOfTransform({ id: "a", type: "transform" }), null);
  assert.equal(opOfTransform({ id: "a", type: "transform", pick: {}, template: "x" }), null);
  assert.throws(() => run({} as TransformSpec), ExprError);
  const big = { input: { l: Array.from({ length: 5001 }, (_, i) => i) }, trigger: {}, steps: {} } as Scope;
  assert.throws(() => runTransform({ sort: { from: "$input.l" } }, big), /more than 5000/);
});

test("deterministic: the same input gives the same output twice (replay-safe)", () => {
  const spec: TransformSpec = { sort: { from: "$input.people", by: "age", order: "desc" } };
  assert.equal(JSON.stringify(runTransform(spec, scope)), JSON.stringify(runTransform(spec, scope)));
});
