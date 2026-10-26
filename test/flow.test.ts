// The step-A loop through the real handlers on a migrated database:
// an agent suggests → the owner reviews, drafts, promotes → versions and diff → recipe export.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { handlers } from "../src/app.ts";
import { ALLOWLIST_NOTICE } from "../src/model.ts";
import { AGENT_A, AGENT_B, call, ctxFor, migratedDb, OWNER } from "./helpers.ts";

const H = handlers as unknown as Parameters<typeof call>[0];

async function refused(p: Promise<unknown>, code: string, status: number): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof TbError && e.code === code && e.httpStatus === status);
}

test("agent suggests; it sees only its own suggestions; the owner sees all", async () => {
  const db = migratedDb();
  const a = ctxFor(db, AGENT_A);
  const s = await call<K.SuggestionCreateOutput>(H, "suggestion_create", {
    title: "Weekly status report",
    summary: "I wrote the Monday report four times.",
    evidence: [
      { kind: "kanban_issue", ref: "iss_1" },
      { kind: "receipt", ref: "call_9", product: "knowledge" },
      { kind: "kanban_issue", ref: "iss_1" },
    ],
    steps: [
      { title: "Collect", ops: [{ product: "kanban", operation: "issues_list" }] },
      { title: "Write", instruction: "Summarise.", ops: [{ product: "knowledge", operation: "remember" }] },
    ],
  }, a);
  assert.equal(s.status, "open");
  assert.equal(s.source, "agent");
  assert.equal(s.agentId, AGENT_A.id);
  assert.deepEqual(s.createdBy, { type: "agent", id: AGENT_A.id, name: "Agent A" });
  assert.equal(s.evidence.length, 2, "duplicate evidence is dropped");
  assert.equal(s.evidence[0]?.product, "kanban", "kanban_issue evidence names the product");
  assert.deepEqual(s.steps.map((x) => x.id), ["s1", "s2"]);

  await call(H, "suggestion_create", { title: "Other", evidence: [{ kind: "receipt", ref: "call_1", product: "connect" }] }, ctxFor(db, AGENT_B));
  const mine = await call<K.SuggestionsListOutput>(H, "suggestions_list", {}, a);
  assert.deepEqual(mine.suggestions.map((x) => x.title), ["Weekly status report"]);
  await refused(call(H, "suggestion_get", { id: s.id }, ctxFor(db, AGENT_B)), "not_found", 404);
  const all = await call<K.ReviewSuggestionsOutput>(H, "review_suggestions", {}, ctxFor(db, OWNER));
  assert.equal(all.suggestions.length, 2);
});

test("owner review: decide, draft (needs approval), edit with revisions, promote v1, edit, promote v2, diff, recipe", async () => {
  const db = migratedDb();
  const owner = ctxFor(db, OWNER);
  const s = await call<K.SuggestionCreateOutput>(H, "suggestion_create", {
    title: "Weekly status report",
    evidence: [{ kind: "kanban_issue", ref: "iss_1" }],
    steps: [{ title: "Collect", ops: [{ product: "kanban", operation: "issues_list" }] }],
  }, ctxFor(db, AGENT_A));

  await refused(call(H, "draft_create", { suggestionId: s.id }, owner), "conflict", 409);
  const approved = await call<K.SuggestionDecideOutput>(H, "suggestion_decide", { id: s.id, decision: "approve", note: "yes" }, owner);
  assert.equal(approved.status, "approved");
  assert.equal(approved.note, "yes");
  assert.equal((await call<K.SuggestionDecideOutput>(H, "suggestion_decide", { id: s.id, decision: "approve" }, owner)).status, "approved", "repeat is a no-op");

  const d1 = await call<K.DraftCreateOutput>(H, "draft_create", { suggestionId: s.id }, owner);
  assert.equal(d1.revision, 1);
  assert.equal(d1.state, "open");
  assert.deepEqual(d1.allowed, [{ product: "kanban", operations: ["issues_list"], crud: ["read"] }], "allowed ops come from the steps");

  // promote refuses a draft that allows a step op outside the list
  const bad = await call<K.DraftUpdateOutput>(H, "draft_update", { id: d1.id, revision: 1, allowed: [{ product: "knowledge", operations: ["remember"], crud: ["create"] }] }, owner);
  await refused(call(H, "workflow_promote", { draftId: d1.id, revision: bad.revision }, owner), "validation_failed", 422);
  await refused(call(H, "draft_update", { id: d1.id, revision: 1, title: "stale" }, owner), "revision_conflict", 409);

  const d2 = await call<K.DraftUpdateOutput>(H, "draft_update", {
    id: d1.id,
    revision: bad.revision,
    instruction: "Every Monday, list last week's done issues and write one report issue.",
    trigger: "Every Monday 08:00",
    allowed: [{ product: "kanban", operations: ["issues_list", "issue_create"], crud: ["read", "create"] }],
    steps: [
      { id: "s1", title: "Collect", ops: [{ product: "kanban", operation: "issues_list" }] },
      { title: "Report", ops: [{ product: "kanban", operation: "issue_create" }] },
    ],
  }, owner);
  const p1 = await call<K.WorkflowPromoteOutput>(H, "workflow_promote", { draftId: d1.id, revision: d2.revision }, owner);
  assert.equal(p1.version.version, 1);
  assert.equal(p1.workflow.activeVersion, 1);
  await refused(call(H, "workflow_promote", { draftId: d1.id, revision: d2.revision }, owner), "conflict", 409);

  // the Bound agent reads it, with the honest notice (a Free agent gets the Free-target notice: test/free-target.test.ts)
  const wf = await call<K.WorkflowGetOutput>(H, "workflow_get", { id: p1.workflow.id }, ctxFor(db, { ...AGENT_B, mode: "bound" }));
  assert.equal(wf.version, 1);
  assert.equal(wf.notice, ALLOWLIST_NOTICE);
  assert.match(wf.notice, /may call these operations/);

  // v2 widens access: one more product
  const d3 = await call<K.DraftUpdateOutput>(H, "draft_update", {
    id: d1.id,
    revision: d2.revision,
    instruction: "Every Monday, list last week's done issues, write one report issue and remember it.",
    allowed: [
      { product: "kanban", operations: ["issues_list", "issue_create"], crud: ["read", "create"] },
      { product: "knowledge", operations: ["remember"], crud: ["create"] },
    ],
  }, owner);
  assert.equal(d3.state, "open");
  const p2 = await call<K.WorkflowPromoteOutput>(H, "workflow_promote", { draftId: d1.id, revision: d3.revision }, owner);
  assert.equal(p2.workflow.id, p1.workflow.id);
  assert.equal(p2.version.version, 2);

  const versions = await call<K.WorkflowVersionsOutput>(H, "workflow_versions", { workflowId: p1.workflow.id }, owner);
  assert.deepEqual(versions.versions.map((v) => v.version), [1, 2]);
  assert.equal((await call<K.WorkflowGetOutput>(H, "workflow_get", { id: p1.workflow.id, version: 1 }, ctxFor(db, AGENT_A))).allowed.length, 1, "old versions stay readable");

  const diff = await call<K.WorkflowDiffOutput>(H, "workflow_diff", { workflowId: p1.workflow.id, from: 1, to: 2 }, owner);
  assert.deepEqual(diff.operations, { added: ["knowledge.remember"], removed: [] });
  assert.equal(diff.widensAccess, true);
  assert.deepEqual(diff.fields.map((f) => f.field), ["instruction"]);
  assert.match(diff.notice, /Portal/);
  const back = await call<K.WorkflowDiffOutput>(H, "workflow_diff", { workflowId: p1.workflow.id, from: 2, to: 1 }, owner);
  assert.equal(back.widensAccess, false);
  assert.deepEqual(back.operations.removed, ["knowledge.remember"]);

  const exported = await call<K.RecipeExportOutput>(H, "recipe_export", { workflowId: p1.workflow.id, agentName: "Monday reporter" }, owner);
  assert.equal(exported.recipe.format, "tealbrick.recipe/1");
  assert.deepEqual(exported.recipe.steps.map((x) => x.opId), ["agents.create", "agents.policy_set", "edges.create", "edges.create", "edges.create"]);
  const policy = exported.recipe.steps[1]?.input as { mode: string; workflow: { product: string; operations: string[] }[] };
  assert.equal(policy.mode, "bound");
  assert.deepEqual(policy.workflow, [
    { product: "evolution", operations: ["routine_claim", "routine_report", "routines_due", "workflow_get"] },
    { product: "kanban", operations: ["issue_comment_add", "issue_create", "issue_get", "issues_list"] },
    { product: "knowledge", operations: ["remember"] },
  ]);
  assert.match(exported.notice, /may call these operations/);

  const detail = await call<K.ReviewSuggestionOutput>(H, "review_suggestion", { id: s.id }, owner);
  assert.deepEqual(detail.events.map((e) => e.type), ["created", "approved"]);
  assert.equal(detail.drafts[0]?.workflowId, p1.workflow.id);
});

test("suggestion state machine: reject, re-approve, archive is final", async () => {
  const db = migratedDb();
  const owner = ctxFor(db, OWNER);
  const s = await call<K.SuggestionCreateOutput>(H, "suggestion_create", { title: "x", evidence: [{ kind: "receipt", ref: "c", product: "connect" }] }, ctxFor(db, AGENT_A));
  assert.equal((await call<K.SuggestionDecideOutput>(H, "suggestion_decide", { id: s.id, decision: "reject" }, owner)).status, "rejected");
  assert.equal((await call<K.SuggestionDecideOutput>(H, "suggestion_decide", { id: s.id, decision: "approve" }, owner)).status, "approved");
  assert.equal((await call<K.SuggestionDecideOutput>(H, "suggestion_decide", { id: s.id, decision: "archive" }, owner)).status, "archived");
  await refused(call(H, "suggestion_decide", { id: s.id, decision: "approve" }, owner), "conflict", 409);
  await refused(call(H, "suggestion_decide", { id: "sug_missing", decision: "approve" }, owner), "not_found", 404);
});

test("drafts from templates and from scratch; templates only use known shapes", async () => {
  const db = migratedDb();
  const owner = ctxFor(db, OWNER);
  const t = await call<K.TemplatesListOutput>(H, "templates_list", {}, owner);
  assert.ok(t.templates.length >= 3);
  for (const tpl of t.templates) {
    const d = await call<K.DraftCreateOutput>(H, "draft_create", { templateId: tpl.id }, owner);
    assert.equal(d.templateId, tpl.id);
    // every template is promotable as shipped (steps ⊆ allowed)
    const p = await call<K.WorkflowPromoteOutput>(H, "workflow_promote", { draftId: d.id, revision: d.revision }, owner);
    assert.equal(p.version.version, 1);
    assert.ok(!JSON.stringify(tpl).match(/\bA4\b|Doppel|Hermes|companyId|workspaceSlug/), "no v1 names");
  }
  const blank = await call<K.DraftCreateOutput>(H, "draft_create", { title: "Mine" }, owner);
  assert.equal(blank.title, "Mine");
  await refused(call(H, "workflow_promote", { draftId: blank.id, revision: 1 }, owner), "validation_failed", 422);
  await refused(call(H, "draft_create", { templateId: "nope" }, owner), "not_found", 404);
  const list = await call<K.DraftsListOutput>(H, "drafts_list", {}, owner);
  assert.equal(list.drafts.length, t.templates.length + 1);
});
