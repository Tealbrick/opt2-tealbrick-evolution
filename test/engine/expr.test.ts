// Refs, templates and the safe expression set (src/engine/expr.ts): quiet on good input, loud on bad.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkExpr, ExprError, evalCondition, evalExpr, exprRefs, parseRef, parseTemplate, renderString, renderTree, type Scope } from "../../src/engine/expr.ts";

const scope: Scope = {
  input: { account: "acc1", n: 3, list: ["a", "b"], nested: { deep: [{ x: 1 }, { x: 2 }] } },
  trigger: { date: "2026-10-26", kind: "schedule" },
  steps: { fetch: { output: { result: { messages: [{ subject: "Hi" }, { subject: "Yo" }], count: 2 } } }, none: { output: null } },
  loop: { item: { id: "i1" }, index: 4 },
};

test("parseRef reads the four ref roots, dotted paths and indexes; a text that is not a ref is a literal", () => {
  assert.deepEqual(parseRef("$input.nested.deep[1].x")?.segs, ["nested", "deep", 1, "x"]);
  assert.equal(parseRef("$steps.fetch.output.result")?.root, "steps");
  assert.equal(parseRef("$loop.item")?.root, "loop");
  assert.equal(parseRef("$trigger.date")?.root, "trigger");
  assert.equal(parseRef("$5 off"), null);
  assert.equal(parseRef("hello"), null);
  assert.equal(parseRef("$steps.fetch"), null, "a step ref needs .output");
  assert.equal(parseRef("$steps.fetch.result"), null, "a step ref needs .output");
  assert.equal(parseRef("$loop.other"), null);
  assert.equal(parseRef("$input.__proto__.x")?.root, "input", "the path parses; resolving never reaches the prototype");
});

test("a ref resolves own properties only; a missing value is undefined, never a throw", () => {
  assert.equal(renderString("$input.account", scope), "acc1");
  assert.deepEqual(renderString("$input.list", scope), ["a", "b"]);
  assert.equal(renderString("$steps.fetch.output.result.messages[1].subject", scope), "Yo");
  assert.equal(renderString("$input.missing", scope), null);
  assert.equal(renderString("$input.__proto__", scope), null);
  assert.equal(renderString("$input.constructor", scope), null);
  assert.equal(renderString("$steps.nope.output.x", scope), null);
  assert.equal(renderString("$loop.item", scope) instanceof Object, true);
  assert.equal(renderString("$loop.index", scope), 4);
});

test("templates: text and refs; a lone {{ }} keeps its type; join, len, exists", () => {
  assert.equal(renderString("Hello {{ $input.account }}!", scope), "Hello acc1!");
  assert.equal(renderString("{{ $input.n }}", scope), 3, "a lone expression keeps the number");
  assert.equal(renderString("n={{ $input.n }}", scope), "n=3");
  assert.equal(renderString("{{ join($input.list, ', ') }}", scope), "a, b");
  assert.equal(renderString("{{ join($input.list, '\n- ') }}", scope), "a\n- b");
  assert.equal(renderString("- {{ join($input.list, '\\n- ') }}", scope), "- a\n- b", "an escaped \\n is a newline too");
  assert.equal(renderString("{{ len($input.list) }}", scope), 2);
  assert.equal(renderString("{{ len($steps.fetch.output.result.messages) }}", scope), 2);
  assert.equal(renderString("{{ exists($input.missing) }}", scope), false);
  assert.equal(renderString("{{ exists($input.account) }}", scope), true);
  assert.equal(renderString("x{{ $input.missing }}y", scope), "xy", "a missing value renders as empty text");
  assert.equal(renderString("{{ 'lit' }}", scope), "lit");
  assert.equal(renderString("plain text", scope), "plain text");
  assert.equal(renderString("{{ join($input.nope) }}", scope), "");
});

test("template errors are loud: unknown function, bad arity, open braces, bad ref, junk characters, no code", () => {
  for (const bad of ["{{ eval('x') }}", "{{ join() }}", "{{ len($a, $b) }}", "{{ $input.x ", "{{ $bad }}", "{{ 1 + 2 }}", "{{ constructor }}", "{{ process.exit() }}", "{{ join($input.list, ', ' }}"])
    assert.throws(() => parseTemplate(bad), ExprError, bad);
  assert.throws(() => renderString("{{ join(5, ',') }}", scope), /join needs a list/);
  assert.throws(() => renderString("{{ len(true) }}", scope), /len needs/);
});

test("renderTree evaluates a value tree: objects, lists, refs, templates, literals", () => {
  const out = renderTree({ a: "$input.account", b: ["{{ $input.n }}", "t-{{ $input.n }}", 7, true, null], c: { d: "$trigger.date" }, __proto__: { x: 1 }, constructor: "no" }, scope) as Record<string, unknown>;
  assert.equal(out.a, "acc1");
  assert.deepEqual(out.b, [3, "t-3", 7, true, null]);
  assert.deepEqual(out.c, { d: "2026-10-26" });
  assert.equal(Object.hasOwn(out, "constructor"), false, "a forbidden key is dropped");
});

test("conditions: == != < <= > >= and or not in exists len join", () => {
  const t = (e: unknown): boolean => evalCondition(e, scope);
  assert.equal(t({ "==": ["$input.account", "acc1"] }), true);
  assert.equal(t({ "==": ["$input.list", ["a", "b"]] }), true, "deep equality");
  assert.equal(t({ "!=": ["$input.account", "x"] }), true);
  assert.equal(t({ "<": ["$input.n", 4] }), true);
  assert.equal(t({ "<=": ["$input.n", 3] }), true);
  assert.equal(t({ ">": ["$input.n", 3] }), false);
  assert.equal(t({ ">=": ["$input.n", 3] }), true);
  assert.equal(t({ "<": ["a", "b"] }), true, "two strings compare");
  assert.equal(t({ and: [{ ">": ["$input.n", 1] }, { exists: "$input.account" }] }), true);
  assert.equal(t({ or: [{ "==": [1, 2] }, { "==": [2, 2] }] }), true);
  assert.equal(t({ not: { "==": [1, 2] } }), true);
  assert.equal(t({ in: ["a", "$input.list"] }), true);
  assert.equal(t({ in: ["z", "$input.list"] }), false);
  assert.equal(t({ in: ["ell", "hello"] }), true, "a string in a string");
  assert.equal(t({ in: ["deep", "$input.nested"] }), true, "a key in an object");
  assert.equal(t({ exists: "$input.missing" }), false);
  assert.equal(t({ exists: "$steps.none.output" }), false, "null is not there");
  assert.equal(t({ ">": [{ len: "$input.list" }, 1] }), true);
  assert.equal(evalExpr({ join: ["$input.list", "|"] }, scope), "a|b");
  assert.equal(t({ "==": [{ lit: "$input.account" }, "$input.account"] }), false, "lit makes a ref-looking text a literal");
  assert.equal(t({ ">": ["$input.missing", 1] }), false, "a missing value compares false, it does not throw");
  assert.equal(t({ "==": ["$input.missing", null] }), false, "undefined is not null");
});

test("a real type error in a condition throws; shape errors are listed by checkExpr", () => {
  assert.throws(() => evalCondition({ "<": ["a", 1] }, scope), /two numbers or two strings/);
  const bad = (e: unknown): string[] => checkExpr(e).map((i) => i.message);
  assert.match(bad({ "==": ["a"] })[0] ?? "", /takes 2/);
  assert.match(bad({ foo: [1] })[0] ?? "", /exactly one key/);
  assert.match(bad({ "==": 5 })[0] ?? "", /takes a list/);
  assert.match(bad({ and: [{ nope: 1 }] })[0] ?? "", /exactly one key/);
  assert.match(bad("$steps.x")[0] ?? "", /not a valid ref/);
  assert.match(bad("{{ $input.a }}")[0] ?? "", /not allowed inside a condition/);
  assert.equal(bad({ and: [{ "==": [1, 1] }, { not: { exists: "$input.a" } }] }).length, 0);
  let deep: unknown = { "==": [1, 1] };
  for (let i = 0; i < 20; i++) deep = { not: deep };
  assert.match(bad(deep)[0] ?? "", /nested too deeply/);
  assert.deepEqual(
    exprRefs({ and: [{ "==": ["$input.a", "x"] }, { in: ["y", "$steps.s.output.list"] }] }).map((r) => r.ref.text),
    ["$input.a", "$steps.s.output.list"],
  );
});

test("no code runs: a hostile string, object key or operator is data", () => {
  assert.equal(renderString("$input.constructor.constructor('return 1')()", scope), "$input.constructor.constructor('return 1')()", "not a ref -> literal text");
  assert.throws(() => evalExpr({ eval: ["1"] }, scope), /not an expression/);
  assert.equal(evalExpr("process.exit()", scope), "process.exit()");
  assert.equal(typeof (globalThis as { __pwned?: unknown }).__pwned, "undefined");
});
