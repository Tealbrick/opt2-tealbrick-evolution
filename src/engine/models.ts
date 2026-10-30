// The model-role call of an `ai` step with `by: {role}` (ENGINE-BUILD §3, M2): `modelRole(role)` gives the binding the workspace
// bridge holds (provider, model, base URL, key), then ONE provider call with temperature 0, at most 4000 output tokens, no tools,
// and the answer is validated against the step's `outputSchema` with ONE repair retry. Content only: the model never acts.
//
// The SDK's modelRole() is injected (tests use a fake binding and a local fake provider server). A missing binding, a bridge
// without the `model_roles` cap, a role the manifest does not declare, or a role that is not a text role all end the step with
// a code (`model_role_unavailable`, `model_role_unsupported`) that onFail handles.
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import { MODEL_PROVIDERS } from "@opt2-tealbrick/spec/models";
import type { ModelPort, ModelRequest, ModelResponse } from "./agent-port.ts";
import type { Json } from "./json.ts";
import { TEXT_ROLES } from "./model-text-roles.ts";

export interface RoleBinding {
  provider: string;
  model: string;
  baseUrl: string | null;
  key: string | null;
  dataPolicy?: string;
}

/** A failure with a code the owner sees; `retryable` tells Temporal whether another attempt can help. */
export class ModelError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

/** Roles whose call is text in, JSON out. The others (embeddings, rerank, transcribe, vision) are other kinds of call. */
export { TEXT_ROLES };
export const MODEL_ROLES_CAP = "model_roles";
export const MAX_OUTPUT_TOKENS = 4000;

export interface ModelPortDeps {
  /** the SDK's `modelRole` */
  modelRole: (role: string) => Promise<RoleBinding | null>;
  /** the SDK's `ctx.bridgeCaps()` */
  bridgeCaps: () => readonly string[];
  fetch?: typeof fetch;
}

const SYSTEM = [
  "You are one step of an automated workflow. You produce CONTENT ONLY: you have no tools and you take no action.",
  "Reply with exactly one JSON value that matches the JSON Schema below. No prose, no code fence.",
  "Use only the data in the input. If the data is not enough, say so inside the fields the schema allows; do not invent facts.",
].join("\n");

function userMessage(req: ModelRequest): string {
  return [`Task:\n${req.instruction}`, `Input (JSON):\n${JSON.stringify(req.inputs ?? {})}`, `JSON Schema of the reply:\n${JSON.stringify(req.outputSchema)}`].join("\n\n");
}

/** Extracts the JSON value of a reply (also when the model wrapped it in a code fence or added a sentence). */
export function parseJsonReply(text: string): Json {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  const body = fenced ? (fenced[1] as string) : t;
  try {
    return JSON.parse(body) as Json;
  } catch {
    const a = body.search(/[{[]/);
    const z = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (a >= 0 && z > a) return JSON.parse(body.slice(a, z + 1)) as Json;
    throw new Error("not JSON");
  }
}

interface Reply {
  text: string;
  tokensIn: number;
  tokensOut: number;
}
type Turn = { role: "user" | "assistant"; content: string };

function baseUrlOf(b: RoleBinding): string {
  const provider = MODEL_PROVIDERS.find((p) => p.id === b.provider);
  const url = b.baseUrl ?? provider?.defaultBaseUrl ?? null;
  if (!url) throw new ModelError("model_role_unavailable", `The binding of the role has no address for provider ${b.provider}.`);
  return url.replace(/\/+$/, "");
}

async function post(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // network, DNS, timeout: another attempt can help
    throw new ModelError("model_unavailable", `The model provider did not answer (${e instanceof Error ? e.name : "error"}).`, true);
  }
  if (!res.ok) {
    // never echo the body of an error: it may carry the prompt or the key
    const transient = res.status === 408 || res.status === 429 || res.status >= 500;
    throw new ModelError(transient ? "model_unavailable" : "model_failed", `The model provider answered ${res.status}.`, transient);
  }
  try {
    return await res.json();
  } catch {
    throw new ModelError("model_failed", "The model provider answer is not JSON.");
  }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

async function callProvider(f: typeof fetch, b: RoleBinding, turns: Turn[], maxTokens: number, timeoutMs: number): Promise<Reply> {
  const base = baseUrlOf(b);
  const provider = MODEL_PROVIDERS.find((p) => p.id === b.provider);
  const system = SYSTEM;
  if (b.provider === "anthropic") {
    const r = obj(await post(f, `${base}/v1/messages`, { "x-api-key": b.key ?? "", "anthropic-version": "2023-06-01" }, { model: b.model, max_tokens: maxTokens, temperature: 0, system, messages: turns }, timeoutMs));
    const text = (Array.isArray(r.content) ? r.content : []).map((c) => (obj(c).type === "text" ? String(obj(c).text ?? "") : "")).join("");
    const u = obj(r.usage);
    return { text, tokensIn: num(u.input_tokens), tokensOut: num(u.output_tokens) };
  }
  if (b.provider === "google") {
    const r = obj(
      await post(
        f,
        `${base}/v1beta/models/${encodeURIComponent(b.model)}:generateContent`,
        { "x-goog-api-key": b.key ?? "" },
        { systemInstruction: { parts: [{ text: system }] }, contents: turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.content }] })), generationConfig: { temperature: 0, maxOutputTokens: maxTokens } },
        timeoutMs,
      ),
    );
    const parts = obj(obj((Array.isArray(r.candidates) ? r.candidates : [])[0]).content).parts;
    const text = (Array.isArray(parts) ? parts : []).map((p) => String(obj(p).text ?? "")).join("");
    const u = obj(r.usageMetadata);
    return { text, tokensIn: num(u.promptTokenCount), tokensOut: num(u.candidatesTokenCount) };
  }
  if (provider?.openaiCompatible || b.provider === "openai-compatible") {
    // OpenAI itself wants max_completion_tokens; the compatible servers still use max_tokens
    const limit = b.provider === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
    const r = obj(
      await post(f, `${base}/chat/completions`, b.key ? { authorization: `Bearer ${b.key}` } : {}, { model: b.model, temperature: 0, ...limit, messages: [{ role: "system", content: system }, ...turns] }, timeoutMs),
    );
    const msg = obj(obj((Array.isArray(r.choices) ? r.choices : [])[0]).message);
    const u = obj(r.usage);
    return { text: typeof msg.content === "string" ? msg.content : "", tokensIn: num(u.prompt_tokens), tokensOut: num(u.completion_tokens) };
  }
  throw new ModelError("model_provider_unsupported", `The engine has no client for the provider ${b.provider}.`);
}

function check(schema: Json, text: string): { ok: true; value: Json } | { ok: false; why: string } {
  let value: Json;
  try {
    value = parseJsonReply(text);
  } catch {
    return { ok: false, why: "the reply is not a JSON value" };
  }
  const v = validateAgainstSchema(schema as never, value as never);
  return v.ok ? { ok: true, value } : { ok: false, why: v.errors.map((e) => `${e.path || "/"} ${e.message}`).join("; ").slice(0, 400) };
}

export function createModelPort(deps: ModelPortDeps): ModelPort {
  const f = deps.fetch ?? fetch;
  return {
    async run(req: ModelRequest): Promise<ModelResponse> {
      if (!TEXT_ROLES.includes(req.role)) throw new ModelError("model_role_unsupported", `The role ${req.role} is not a text role; a workflow step can use reasoning, utility, dreaming or summarize.`);
      if (!deps.bridgeCaps().includes(MODEL_ROLES_CAP)) throw new ModelError("model_role_unavailable", "The workspace bridge has no model roles (capability model_roles); the step cannot call a model.");
      let binding: RoleBinding | null;
      try {
        binding = await deps.modelRole(req.role);
      } catch (e) {
        const code = (e as { code?: string }).code;
        // a paused workspace and a 5xx are transient; an undeclared role is a build error
        throw new ModelError("model_role_unavailable", `The model role ${req.role} cannot be read (${code ?? "error"}).`, code === "paused" ? false : code === undefined);
      }
      if (!binding) throw new ModelError("model_role_unavailable", `No model is bound to the role ${req.role}. The owner binds one in the workspace model settings.`);
      const maxTokens = Math.max(1, Math.min(req.maxTokens, MAX_OUTPUT_TOKENS));
      const timeoutMs = Math.max(5, req.timeoutSec) * 1000;
      const turns: Turn[] = [{ role: "user", content: userMessage(req) }];
      let tokensIn = 0;
      let tokensOut = 0;
      for (let attempt = 0; attempt < 2; attempt++) {
        const reply = await callProvider(f, binding, turns, maxTokens, timeoutMs);
        tokensIn += reply.tokensIn;
        tokensOut += reply.tokensOut;
        const r = check(req.outputSchema, reply.text);
        if (r.ok) return { output: r.value, tokensIn, tokensOut };
        if (attempt === 1) throw new ModelError("output_invalid", `The model reply does not fit the output schema: ${r.why}`);
        // ONE repair retry: say what is wrong, ask for the corrected JSON only
        turns.push({ role: "assistant", content: reply.text.slice(0, 8000) }, { role: "user", content: `That reply is not valid: ${r.why}. Reply again with ONLY the corrected JSON value.` });
      }
      throw new ModelError("output_invalid", "The model reply does not fit the output schema.");
    },
  };
}
