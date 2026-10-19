// C288 R9 contract test: the run issue of a FREE agent's claimed run, as Task Board (Kanban 0.1.13) accepts it.
//
// Evolution records each claimed run as one Kanban issue via `createRunIssue` (issue_create, assignee = the claiming agent
// id, template `evolution:<workflow id>`, idempotency key `evolution-run:<occurrence>`). C288 R1 lets a Free agent claim
// runs; R9 says its run issue is assigned to that Free agent.
//
// Kanban's rule (opt2-tealbrick-kanban v0.1.13, 06e94fc, src/board.ts:149-160 `resolveAssignee`): the assignee must be
// "me", "owner" or an ACTIVE agent id of the workspace directory. The agent's MODE is NOT checked. The directory is filled
// by Kanban's `agentAdded` and its `upsertAgent(..., mode: ctx.caller.mode ?? "free")` (kanban src/app.ts:108), so a Free agent
// is in it. This file proves the SHAPE side: the input we send validates against Kanban's own `issue_create` input
// schema, vendored in test/fixtures. The LIVE side (Kanban accepting a Free agent id) is a queued qa1 probe; no unit test
// here can show it.
//
// Validation uses `validateAgainstSchema` from @opt2-tealbrick/manifest (the SDK's own JSON Schema 2020-12 validator, the
// one that checks every op input at runtime), so every schema keyword is enforced and nothing is a hand-written subset.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Caller, CompanionResult } from "@opt2-tealbrick/miniapp-sdk";
import { createRunIssue } from "../src/app.ts";
import * as r from "../src/routines.ts";
import * as store from "../src/store.ts";
import { AGENT_A, type CallApp, migratedDb } from "./helpers.ts";

type Schema = Parameters<typeof validateAgainstSchema>[0];
type Json = Parameters<typeof validateAgainstSchema>[1];
const SCHEMA = JSON.parse(readFileSync(new URL("./fixtures/kanban-0.1.13-issue_create.input.json", import.meta.url), "utf8")) as Schema;
const valid = (v: unknown) => validateAgainstSchema(SCHEMA, JSON.parse(JSON.stringify(v)) as Json);

const BOUND: Caller = { ...AGENT_A, mode: "bound" };
const FREE: Caller = { type: "agent", id: "agt_01J0000000000000000000000F" as Caller["id"], name: "Free F", mode: "free" };
const D0 = Date.parse("2026-10-12T06:00:00Z");

interface Captured {
  product: string;
  op: string;
  input: Record<string, unknown>;
  opts: { idempotencyKey?: string } | undefined;
}

/** A due, claimed run (claim itself is Bound-only until R1; createRunIssue takes the agent id as a plain argument). */
function claimedRun() {
  const db = migratedDb();
  const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "Morning rollup", summary: "", instruction: "Roll up.", trigger: "08:00", steps: [], allowed: [{ product: "kanban", operations: ["issues_list"], crud: ["read" as const] }] } }, D0);
  const wf = store.promote(db, d.id, d.revision, D0).workflow.id;
  const a = r.setAutomation(db, { workflowId: wf, agentId: BOUND.id, cron: "0 8 * * *" }, D0);
  const now = Date.parse("2026-10-12T08:00:30Z");
  const occ = r.dueJobs(db, BOUND.id, now)[0]?.occurrence as string;
  const c = r.claim(db, BOUND, occ, now);
  assert.equal(c.claimed, true);
  if (!c.claimed) throw new Error("not claimed");
  return { db, wf, automation: { ...a, ...c.automation }, job: c.job, occ };
}

async function runIssueFor(agentId: string, project: string | null = null): Promise<{ sent: Captured; wf: string; occ: string }> {
  const { db, wf, automation, job, occ } = claimedRun();
  let sent: Captured | undefined;
  const callApp: CallApp = async (product, op, input, opts) => {
    sent = { product, op, input: input as Record<string, unknown>, opts: opts as Captured["opts"] };
    return { status: "ok", output: { id: "iss_run1" } } as unknown as CompanionResult;
  };
  const id = await createRunIssue(db, callApp as unknown as Parameters<typeof createRunIssue>[1], job, { ...automation, kanbanProject: project }, agentId);
  assert.equal(id, "iss_run1");
  assert.ok(sent, "the Kanban companion was called");
  return { sent, wf, occ };
}

test("R9: a Free agent's run issue is assigned to that Free agent, unchanged, and fits Kanban 0.1.13 issue_create", async () => {
  const { sent, wf, occ } = await runIssueFor(FREE.id);
  assert.equal(sent.product, "kanban");
  assert.equal(sent.op, "issue_create");
  assert.equal(sent.input.assignee, FREE.id, "the Free agent id goes through as it is (not 'me', not remapped)");
  assert.equal(sent.input.template, `evolution:${wf.toLowerCase().replaceAll("_", "-")}`);
  assert.equal(sent.opts?.idempotencyKey, `evolution-run:${occ}`);
  assert.equal(sent.input.status, "in_progress");
  const v = valid(sent.input);
  assert.equal(v.ok, true, v.ok ? "" : JSON.stringify(v.errors));
});

test("the same input shape holds with a Task Board project set, and for a Bound agent", async () => {
  for (const [agent, project] of [[FREE.id, "prj_01J0000000000000000000000Q"], [BOUND.id, null]] as const) {
    const { sent } = await runIssueFor(agent, project);
    assert.equal(sent.input.assignee, agent);
    assert.equal(sent.input.project, project ?? undefined);
    const v = valid(sent.input);
    assert.equal(v.ok, true, v.ok ? "" : JSON.stringify(v.errors));
  }
});

test("the vendored schema is the real contract: it carries its provenance and the assignee limits this test relies on", () => {
  const s = SCHEMA as unknown as { $comment: string; additionalProperties: boolean; required: string[]; properties: Record<string, { minLength?: number; maxLength?: number }> };
  assert.match(s.$comment, /Tealbrick\/opt2-tealbrick-kanban v0\.1\.13 \(06e94fc\)/);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.required, ["title"]);
  assert.equal(s.properties.assignee?.minLength, 1);
  assert.equal(s.properties.assignee?.maxLength, 64);
});

// Fire on bad (L34): the check is not vacuous. Each bad input differs from the good one by exactly one thing.
test("fire-on-bad: the validator refuses an empty assignee, a 65-character assignee, an unknown property, a missing title, a bad template", async () => {
  const { sent } = await runIssueFor(FREE.id);
  const good = sent.input;
  assert.equal(valid(good).ok, true, "control: the good input passes");
  const long = `agt_${"X".repeat(61)}`;
  assert.equal(long.length, 65);
  const bad: [string, Record<string, unknown>][] = [
    ["empty assignee", { ...good, assignee: "" }],
    ["65-char assignee", { ...good, assignee: long }],
    ["unknown property", { ...good, assigneeMode: "free" }],
    ["missing title", { ...good, title: undefined }],
    ["assignee not a string", { ...good, assignee: 7 }],
    ["template with a space", { ...good, template: "evolution: bad" }],
  ];
  for (const [why, input] of bad) assert.equal(valid(input).ok, false, `${why} must fail`);
  // and the edge that must PASS: exactly 64 characters
  assert.equal(valid({ ...good, assignee: `agt_${"X".repeat(60)}` }).ok, true, "64 characters is the limit and passes");
});
