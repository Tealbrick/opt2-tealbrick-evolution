// Example B of ENGINE-BUILD §12 (inbound email -> triangulate customer data + market sentiment -> approval -> draft): it
// validates, and it runs with fakes (model roles, an agent card, Inbox, CRM and Knowledge reads) up to the Gmail draft step.
// That step is REFUSED by the bridge in a real workspace today: Connect's `tools` op is crud ["read"], so the companion grant
// cannot create (platform P5, reported in the PR). The refusal is the expected outcome and is tested as such.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { WorkflowFailedError } from "@temporalio/client";
import { manifest } from "../../src/app.ts";
import type { AgentStepOffer, ModelPort, ModelRequest, ModelResponse } from "../../src/engine/agent-port.ts";
import type { WorkflowContract } from "../../src/engine/contract.ts";
import { validateContract } from "../../src/engine/validate.ts";
import { type Env, indexOf, startEnv } from "./harness.ts";

const exampleB = JSON.parse(readFileSync(new URL("./fixtures/example-b.json", import.meta.url), "utf8")) as WorkflowContract;
const AGENT = "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85";
const offers: AgentStepOffer[] = [];
const modelCalls: ModelRequest[] = [];
const models: ModelPort = {
  async run(req) {
    modelCalls.push(req);
    if (req.role === "utility") return { output: { relevant: true, company: "Acme Corp", ask: "Pricing for 50 seats" }, tokensIn: 50, tokensOut: 10 } as ModelResponse;
    return { output: { subject: "Re: pricing", body: "Dear Acme, ...", recommendations: ["Offer a call", "Send the price list", "Check the contract"] }, tokensIn: 400, tokensOut: 120 } as ModelResponse;
  },
};

let t: Env;
before(async () => {
  t = await startEnv({
    models,
    agentPort: {
      async offer(o) {
        offers.push(o);
      },
      async cancel() {},
    },
  });
});
after(async () => {
  await t.stop();
});

const ITEM = { from: "boss@acme.com", fromDomain: "acme.com", subject: "Pricing?", snippet: "How much for 50 seats?", threadId: "th_1" };
async function failure(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WorkflowFailedError) {
      const c = e.cause as { type?: string; message: string };
      return { code: c.type ?? "", message: c.message };
    }
    throw e;
  }
  assert.fail("the run should have failed");
}
function fakes(draft: "refused" | "ok"): void {
  t.apps.calls.length = 0;
  offers.length = 0;
  modelCalls.length = 0;
  t.apps.on["connect.tools"] = (input) => {
    const tool = (input as { tool: string }).tool;
    if (tool === "crm_search_company") return { result: { company: "Acme Corp", tier: "gold" } };
    if (draft === "refused") throw new TbError("forbidden", "the grant of Evolving Workflows for connect is crud read; gmail_create_email_draft needs create", 403);
    return { result: { id: "draft_77" } };
  };
  t.apps.on["knowledge.recall"] = () => ({ results: [{ title: "Last call with Acme" }] });
  t.apps.on["inbox.inbox_ask"] = () => ({ itemId: "itm_b", status: "open", expiresAt: "9999-12-31T00:00:00Z" });
  let polls = 0;
  t.apps.on["inbox.inbox_status"] = () => ({ itemId: "itm_b", kind: "approval", status: ++polls < 2 ? "open" : "answered", seenByOwner: true, response: polls < 2 ? null : "approve", message: null, decidedAt: null, expiresAt: null });
}
async function completeAgent(): Promise<void> {
  const until = Date.now() + 15_000;
  while (offers.length === 0) {
    if (Date.now() > until) assert.fail("the agent step was never offered");
    await new Promise((r) => setTimeout(r, 25));
  }
  await t.client.activity.complete(Buffer.from((offers[0] as AgentStepOffer).taskToken, "base64"), { sentiment: "positive", notes: "good press", sources: ["https://news.example/acme"] });
}

test("example B validates: both triggers, a nested parallel, an agent card, two model roles, an approval, a result action", () => {
  const v = validateContract(exampleB, { companions: manifest.companions });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.deepEqual(v.warnings.map((w) => w.code), ["event_trigger_pending"]);
  assert.deepEqual(
    v.uses.map((u) => `${u.product}.${u.op}`),
    ["connect.tools", "inbox.inbox_ask", "inbox.inbox_status", "knowledge.recall"],
  );
  assert.deepEqual(v.uses.find((u) => u.op === "tools")?.tools, ["crm_search_company", "gmail_create_email_draft", "gmail_fetch_emails"]);
  assert.deepEqual(Object.keys(v.stepTypes).sort(), ["brief", "classify", "crm", "draft", "enrich", "gate", "notes", "parse", "review", "sentiment", "write"]);
});

test("example B runs with fakes up to the Gmail draft; that step is refused (crud read only, P5) and the run fails there, with every step before it done", async () => {
  fakes("refused");
  t.install({ ...exampleB, id: "inbound-email-advisor" });
  const pending = t.run({ workflowId: "inbound-email-advisor", runId: "run_b1", trigger: { kind: "manual", item: ITEM as never } });
  await completeAgent();
  const f = await failure(pending);
  assert.equal(f.code, "forbidden");
  assert.match(f.message, /^draft: forbidden \(HTTP 403\)$/, "the failure keeps the code and the status, not the text of the other app");
  const { run, steps } = indexOf(t.db, "inbound-email-advisor", "run_b1");
  assert.deepEqual([run?.status, run?.error_step, run?.error_code], ["failed", "draft", "forbidden"]);
  const by = Object.fromEntries(steps.map((s) => [String(s.step_id), String(s.status)]));
  for (const id of ["parse", "classify", "crm", "notes", "sentiment", "brief", "write", "review"]) assert.equal(by[id], "completed", id);
  // the containers (gate, enrich) end with the step that failed inside them: they are not recorded as completed
  assert.equal(by.draft, "failed");
  // what the engine sent
  assert.deepEqual(modelCalls.map((m) => m.role), ["utility", "reasoning"]);
  assert.deepEqual(modelCalls[0]?.inputs, { email: { from: "boss@acme.com", domain: "acme.com", subject: "Pricing?", text: "How much for 50 seats?", threadId: "th_1" } });
  assert.equal(offers.length, 1);
  assert.deepEqual([offers[0]?.agentId, offers[0]?.inputs, offers[0]?.timeoutSec], [AGENT, { company: "Acme Corp" }, 900]);
  const ask = t.apps.calls.find((c) => c.op === "inbox_ask") as unknown as { input: { title: string; context: string } };
  assert.equal(ask.input.title, "Draft reply to Acme Corp?");
  assert.match(ask.input.context, /Offer a call\nSend the price list\nCheck the contract/);
  const brief = ((modelCalls[1] as { inputs: { brief: Record<string, unknown> } }).inputs).brief;
  assert.deepEqual(Object.keys(brief).sort(), ["ask", "crm", "email", "market", "notes"]);
  assert.deepEqual(brief.market, { sentiment: "positive", notes: "good press", sources: ["https://news.example/acme"] });
  assert.deepEqual(brief.crm, { company: "Acme Corp", tier: "gold" });
  const draft = t.apps.calls.filter((c) => c.op === "tools").at(-1);
  assert.deepEqual(draft?.input, { tool: "gmail_create_email_draft", arguments: { account: "sales", thread: "th_1", subject: "Re: pricing", body: "Dear Acme, ..." } });
});

test("example B with a grant that allows the draft completes (the engine side is whole; only the platform grant is missing)", async () => {
  fakes("ok");
  t.install({ ...exampleB, id: "inbound-email-advisor-ok" });
  const pending = t.run({ workflowId: "inbound-email-advisor-ok", runId: "run_b2", trigger: { kind: "manual", item: ITEM as never } });
  await completeAgent();
  const res = await pending;
  assert.equal(res.status, "completed");
  assert.equal(indexOf(t.db, "inbound-email-advisor-ok", "run_b2").run?.status, "completed");
});

test("example B stops at the gate when the email is not relevant: no enrichment, no model for the draft, no approval", async () => {
  fakes("ok");
  const irrelevant: ModelPort = {
    async run(req) {
      modelCalls.push(req);
      return { output: { relevant: false, company: "", ask: "" }, tokensIn: 5, tokensOut: 5 } as ModelResponse;
    },
  };
  const other = await startEnv({ models: irrelevant });
  try {
    other.apps.on["connect.tools"] = () => ({ result: {} });
    other.install({ ...exampleB, id: "inbound-email-skip" });
    const res = await other.run({ workflowId: "inbound-email-skip", runId: "run_b3", trigger: { kind: "manual", item: ITEM as never } });
    assert.equal(res.status, "completed");
    assert.equal(other.apps.calls.length, 0, "no app call at all");
    assert.equal(indexOf(other.db, "inbound-email-skip", "run_b3").steps.find((s) => s.step_id === "enrich"), undefined);
  } finally {
    await other.stop();
  }
});
