// The model-role call (src/engine/models.ts): modelRole() binding -> ONE provider call with temperature 0, at most 4000 output
// tokens, no tools; the reply is validated against the output schema with ONE repair retry. A local server plays the providers.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, test } from "node:test";
import { createModelPort, MAX_OUTPUT_TOKENS, type ModelError, parseJsonReply, type RoleBinding } from "../../src/engine/models.ts";

interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}
let server: Server;
let base = "";
const seen: Seen[] = [];
let replies: (() => { status: number; body: unknown })[] = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw || "{}") as Record<string, unknown> });
      const r = (replies.shift() ?? (() => ({ status: 500, body: { error: "no reply queued" } })))();
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

const SCHEMA = { type: "object", required: ["bullets"], additionalProperties: false, properties: { bullets: { type: "array", items: { type: "string" } } } };
const req = (over: Record<string, unknown> = {}) => ({ role: "summarize", instruction: "Summarize.", inputs: { emails: ["a", "b"] }, outputSchema: SCHEMA, maxTokens: 4000, timeoutSec: 20, ...over });
const openai = (text: string, usage = { prompt_tokens: 11, completion_tokens: 7 }) => () => ({ status: 200, body: { choices: [{ message: { content: text } }], usage } });
const anthropic = (text: string) => () => ({ status: 200, body: { content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 3 } } });
const google = (text: string) => () => ({ status: 200, body: { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } } });

function port(binding: RoleBinding | null, caps: string[] = ["model_roles"], roleFn?: () => Promise<RoleBinding | null>) {
  return createModelPort({ modelRole: roleFn ?? (async () => binding), bridgeCaps: () => caps });
}
const OPENAI: RoleBinding = { provider: "openai-compatible", model: "m-1", baseUrl: base, key: "SECRET-KEY-123" };
const bind = (over: Partial<RoleBinding>): RoleBinding => ({ ...OPENAI, baseUrl: base, ...over });
const code = (p: Promise<unknown>): Promise<ModelError> =>
  p.then(
    () => assert.fail("should have failed"),
    (e) => e as ModelError,
  );

test("OpenAI-compatible: temperature 0, max_tokens <= 4000 even when more is asked, no tools, key as bearer, tokens counted", async () => {
  seen.length = 0;
  replies = [openai('{"bullets":["x"]}')];
  const r = await port(bind({}) as RoleBinding).run(req({ maxTokens: 99_999 }) as never);
  assert.deepEqual(r.output, { bullets: ["x"] });
  assert.deepEqual([r.tokensIn, r.tokensOut], [11, 7]);
  const s = seen[0] as Seen;
  assert.equal(s.url, "/chat/completions");
  assert.equal(s.headers.authorization, "Bearer SECRET-KEY-123");
  assert.equal(s.body.temperature, 0);
  assert.equal(s.body.max_tokens, MAX_OUTPUT_TOKENS);
  assert.equal(s.body.model, "m-1");
  for (const k of ["tools", "tool_choice", "functions", "stream"]) assert.equal(k in s.body, false, `no ${k}`);
  const messages = s.body.messages as { role: string; content: string }[];
  assert.match(messages[0]?.content ?? "", /CONTENT ONLY[\s\S]*no tools/);
  assert.match(messages[1]?.content ?? "", /Summarize\.[\s\S]*"emails":\["a","b"\][\s\S]*"bullets"/);
});

test("OpenAI itself gets max_completion_tokens; Anthropic and Google get their own request shape", async () => {
  seen.length = 0;
  replies = [openai('{"bullets":[]}'), anthropic('{"bullets":["a"]}'), google('{"bullets":["g"]}')];
  await port(bind({ provider: "openai", key: null })).run(req() as never);
  assert.equal(seen[0]?.body.max_completion_tokens, 4000);
  assert.equal("max_tokens" in (seen[0]?.body ?? {}), false);
  const a = await port(bind({ provider: "anthropic", key: "ANT-KEY" })).run(req({ maxTokens: 500 }) as never);
  assert.deepEqual([a.output, a.tokensIn, a.tokensOut], [{ bullets: ["a"] }, 5, 3]);
  assert.equal(seen[1]?.url, "/v1/messages");
  assert.equal(seen[1]?.headers["x-api-key"], "ANT-KEY");
  assert.equal(seen[1]?.body.temperature, 0);
  assert.equal(seen[1]?.body.max_tokens, 500);
  assert.match(String(seen[1]?.body.system), /CONTENT ONLY/);
  const g = await port(bind({ provider: "google", key: "G-KEY", model: "gem-1" })).run(req() as never);
  assert.deepEqual([g.output, g.tokensIn, g.tokensOut], [{ bullets: ["g"] }, 4, 2]);
  assert.equal(seen[2]?.url, "/v1beta/models/gem-1:generateContent");
  assert.equal(seen[2]?.headers["x-goog-api-key"], "G-KEY");
  assert.equal(((seen[2] as Seen).body.generationConfig as { temperature: number }).temperature, 0);
  assert.equal("tools" in (seen[2]?.body ?? {}), false);
});

test("the reply is validated; ONE repair retry says what is wrong; tokens of both calls add up; a second bad reply is output_invalid", async () => {
  seen.length = 0;
  replies = [openai('{"bullets":"not a list"}'), openai('```json\n{"bullets":["fixed"]}\n```', { prompt_tokens: 20, completion_tokens: 4 })];
  const r = await port(bind({})).run(req() as never);
  assert.deepEqual(r.output, { bullets: ["fixed"] });
  assert.deepEqual([r.tokensIn, r.tokensOut], [31, 11]);
  const second = seen[1]?.body.messages as { role: string; content: string }[];
  assert.deepEqual(
    second.map((m) => m.role),
    ["system", "user", "assistant", "user"],
  );
  assert.match(second[3]?.content ?? "", /not valid: .*bullets.*Reply again with ONLY the corrected JSON/s);

  replies = [openai("I cannot do that"), openai('{"bullets":5}')];
  const e = await code(port(bind({})).run(req() as never));
  assert.deepEqual([e.code, e.retryable], ["output_invalid", false]);
  assert.equal(seen.length, 4, "exactly two calls: one repair retry, never more");
});

test("parseJsonReply reads a bare value, a fenced value and a value inside a sentence; rejects the rest", () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonReply('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Here you go: {"a":1} Done.'), { a: 1 });
  assert.deepEqual(parseJsonReply("[1,2]"), [1, 2]);
  assert.throws(() => parseJsonReply("no json here"));
});

test("fire on bad: no binding, no model_roles cap, a role the bridge cannot give, a non-text role: codes, and the provider is not called", async () => {
  seen.length = 0;
  let asked = 0;
  const counting = async (): Promise<RoleBinding | null> => {
    asked++;
    return null;
  };
  assert.equal((await code(port(null, ["model_roles"], counting).run(req() as never))).code, "model_role_unavailable");
  assert.equal(asked, 1);
  assert.match((await code(port(null, ["model_roles"]).run(req() as never))).message, /No model is bound to the role summarize/);
  const noCap = await code(port(bind({}), []).run(req() as never));
  assert.equal(noCap.code, "model_role_unavailable");
  assert.match(noCap.message, /capability model_roles/);
  const throwing = await code(
    port(null, ["model_roles"], async () => {
      throw Object.assign(new Error("x"), { code: "role_undeclared" });
    }).run(req() as never),
  );
  assert.deepEqual([throwing.code, throwing.retryable], ["model_role_unavailable", false]);
  for (const role of ["embeddings", "rerank", "transcribe", "vision"]) assert.equal((await code(port(bind({})).run(req({ role }) as never))).code, "model_role_unsupported", role);
  assert.equal((await code(port(bind({ provider: "voyage" })).run(req() as never))).code, "model_provider_unsupported");
  assert.equal(seen.length, 0, "no call reached a provider");
});

test("provider failures: 5xx and 429 are retryable (model_unavailable), 4xx is not (model_failed); no body, prompt or key in the error", async () => {
  seen.length = 0;
  replies = [() => ({ status: 503, body: { error: "overloaded, prompt was Summarize. SECRET-KEY-123" } })];
  const a = await code(port(bind({})).run(req() as never));
  assert.deepEqual([a.code, a.retryable], ["model_unavailable", true]);
  replies = [() => ({ status: 429, body: {} })];
  assert.equal((await code(port(bind({})).run(req() as never))).retryable, true);
  replies = [() => ({ status: 401, body: { error: "bad key SECRET-KEY-123 for prompt Summarize" } })];
  const b = await code(port(bind({})).run(req() as never));
  assert.deepEqual([b.code, b.retryable], ["model_failed", false]);
  for (const e of [a, b]) {
    assert.doesNotMatch(e.message, /SECRET-KEY-123|Summarize|overloaded/);
    assert.match(e.message, /answered (503|401)/);
  }
  // an address that does not answer
  const dead = await code(port(bind({ baseUrl: "http://127.0.0.1:9" })).run(req({ timeoutSec: 5 }) as never));
  assert.deepEqual([dead.code, dead.retryable], ["model_unavailable", true]);
});
