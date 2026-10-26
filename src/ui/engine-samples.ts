// The two example workflows of ENGINE-BUILD §12, in the canonical shape (C366a + Martin's shape). The editor offers them as
// starting points; the tests use them as the "good" contracts. Product and op names are today's: Connect dynamic tools go
// through `connect.tools`. Every result action is an `app` step that the ENGINE runs: no LLM calls a tool for it.
import type { WorkflowContract } from "./engine-contract.ts";

/** A. Schedule → enrich (fetch) → process (pick) → model → concat → result action (a draft to me). */
export const DAILY_EMAIL_SUMMARY: WorkflowContract = {
  format: "tealbrick.workflow/1",
  id: "daily-email-summary",
  version: 1,
  title: "Summarize my daily emails",
  inputs: { type: "object", required: ["account", "me"], properties: { account: { type: "string" }, me: { type: "string", format: "email" } } },
  triggers: [{ kind: "schedule", cron: "0 8 * * *", timezone: "Asia/Bangkok" }, { kind: "manual" }],
  steps: [
    { id: "fetch", stage: "enrichment", type: "app", product: "connect", op: "tools", input: { tool: "gmail_fetch_emails", arguments: { account: "{{ $input.account }}", query: "newer_than:1d", max: 50 } } },
    { id: "slim", stage: "process", type: "transform", map: { forEach: "$steps.fetch.output.result.messages", template: { from: "{{ $item.from }}", subject: "{{ $item.subject }}", snippet: "{{ $item.snippet }}" } } },
    {
      id: "summary",
      stage: "intelligence",
      type: "ai",
      by: { role: "summarize" },
      instruction: "Summarize these emails for the owner: 5 bullets, then the ones that need a reply.",
      inputs: { emails: "$steps.slim.output" },
      outputSchema: {
        type: "object",
        required: ["bullets", "needsReply"],
        properties: { bullets: { type: "array", items: { type: "string" }, maxItems: 5 }, needsReply: { type: "array", items: { type: "string" } } },
      },
    },
    {
      id: "body",
      stage: "concat",
      type: "transform",
      template: "Daily summary\n- {{ join($steps.summary.output.bullets, '\n- ') }}\n\nNeeds a reply:\n- {{ join($steps.summary.output.needsReply, '\n- ') }}",
    },
    {
      id: "draft",
      stage: "result",
      type: "app",
      product: "connect",
      op: "tools",
      input: { tool: "gmail_create_email_draft", arguments: { account: "{{ $input.account }}", to: "{{ $input.me }}", subject: "Email summary {{ $trigger.date }}", body: "{{ $steps.body.output }}" } },
    },
  ],
  outputs: { draftId: "$steps.draft.output.result.id" },
  metrics: ["emails", "needs_reply"],
};

/** B. Email arrives → classify → enrich in parallel (CRM read, notes, an agent's research) → concat → model → approval → draft. */
export const INBOUND_EMAIL_ADVISOR: WorkflowContract = {
  format: "tealbrick.workflow/1",
  id: "inbound-email-advisor",
  version: 1,
  title: "Inbound email: draft with recommendations",
  triggers: [
    { kind: "event", product: "connect", type: "connect.email.received", filter: { account: "sales" } },
    { kind: "poll", product: "connect", op: "tools", every: "5m", cursorPath: "/result/historyId", input: { tool: "gmail_fetch_emails", arguments: { account: "sales", query: "is:unread" } } },
  ],
  steps: [
    {
      id: "parse",
      stage: "process",
      type: "transform",
      pick: { from: "$trigger.item.from", domain: "$trigger.item.fromDomain", subject: "$trigger.item.subject", text: "$trigger.item.snippet", threadId: "$trigger.item.threadId" },
    },
    {
      id: "classify",
      stage: "process",
      type: "ai",
      by: { role: "utility" },
      instruction: "Is this a customer or lead email about work? Give the company name and the ask in one line.",
      inputs: { email: "$steps.parse.output" },
      outputSchema: { type: "object", required: ["relevant", "company", "ask"], properties: { relevant: { type: "boolean" }, company: { type: "string" }, ask: { type: "string" } } },
    },
    {
      id: "gate",
      type: "condition",
      if: { "==": ["$steps.classify.output.relevant", true] },
      else: [],
      // biome-ignore lint/suspicious/noThenProperty: the condition step of the contract names its branch "then" (ENGINE-BUILD §3)
      then: [
        {
          id: "enrich",
          stage: "enrichment",
          type: "parallel",
          branches: {
            customer: [{ id: "crm", type: "app", product: "connect", op: "tools", input: { tool: "crm_search_company", arguments: { name: "{{ $steps.classify.output.company }}" } } }],
            history: [{ id: "notes", type: "app", product: "knowledge", op: "recall", input: { query: "{{ $steps.classify.output.company }}" } }],
            market: [
              {
                id: "sentiment",
                type: "ai",
                by: { agent: "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85" },
                instruction: "Return recent market sentiment about this company and its sector, with sources. Do not act.",
                inputs: { company: "$steps.classify.output.company" },
                timeoutSec: 900,
                retry: { max: 1 },
                outputSchema: {
                  type: "object",
                  required: ["sentiment", "sources"],
                  properties: { sentiment: { enum: ["positive", "neutral", "negative"] }, notes: { type: "string" }, sources: { type: "array", items: { type: "string" } } },
                },
              },
            ],
          },
        },
        {
          id: "brief",
          stage: "concat",
          type: "transform",
          merge: { email: "$steps.parse.output", ask: "$steps.classify.output.ask", crm: "$steps.crm.output.result", notes: "$steps.notes.output", market: "$steps.sentiment.output" },
        },
        {
          id: "write",
          stage: "intelligence",
          type: "ai",
          by: { role: "reasoning" },
          instruction: "Write a reply draft and 3 recommendations for the owner, using the brief.",
          inputs: { brief: "$steps.brief.output" },
          outputSchema: {
            type: "object",
            required: ["subject", "body", "recommendations"],
            properties: { subject: { type: "string" }, body: { type: "string" }, recommendations: { type: "array", items: { type: "string" }, maxItems: 3 } },
          },
        },
        { id: "review", type: "approval", title: "Draft reply to {{ $steps.classify.output.company }}?", context: "{{ join($steps.write.output.recommendations, '\n') }}", timeoutSec: 86400, onDeny: "stop" },
        {
          id: "draft",
          stage: "result",
          type: "app",
          product: "connect",
          op: "tools",
          input: { tool: "gmail_create_email_draft", arguments: { account: "sales", thread: "{{ $steps.parse.output.threadId }}", subject: "{{ $steps.write.output.subject }}", body: "{{ $steps.write.output.body }}" } },
        },
      ],
    },
  ],
  metrics: ["relevant", "approved"],
};

export const SAMPLES: { id: string; label: string; contract: WorkflowContract }[] = [
  { id: "daily-email-summary", label: "Summarize my daily emails (schedule, model role)", contract: DAILY_EMAIL_SUMMARY },
  { id: "inbound-email-advisor", label: "Inbound email: draft with recommendations (parallel, agent, approval)", contract: INBOUND_EMAIL_ADVISOR },
];
