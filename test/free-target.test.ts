// C364a R1a: a schedule can target an existing FREE agent, which claims its runs with its own grant.
// A caller gets and claims a schedule only when (automation.agent_id = caller.id AND automation.target_mode = caller.mode).
// Every test has a quiet-on-good half and a fire-on-bad half. The Bound behaviour is in test/routines.test.ts.
// The SDK refuses a paused or unlisted caller before any handler runs (trust.paused(), ops.ts agent_paused / agent_unknown);
// these tests cover the second layer: the handler asks the agent directory that Evolution keeps from the directory events.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Caller, CompanionResult, Db } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { definition, handlers } from "../src/app.ts";
import * as directory from "../src/directory.ts";
import { ALLOWLIST_NOTICE, freeTargetNotice } from "../src/model.ts";
import * as r from "../src/routines.ts";
import * as store from "../src/store.ts";
import { AGENT_A, AGENT_B, type CallApp, call, ctxFor, migratedDb, OWNER } from "./helpers.ts";

const H = handlers as unknown as Parameters<typeof call>[0];
const FREE_A: Caller = { ...AGENT_A, mode: "free" };
const FREE_B: Caller = { ...AGENT_B, mode: "free" };
const BOUND_C: Caller = { type: "agent", id: "agt_01J0000000000000000000000C" as Caller["id"], name: "Agent C", mode: "bound" };
const T = (s: string) => Date.parse(s);
const D0 = T("2026-10-12T06:00:00Z");
const NOW = T("2026-10-12T08:00:30Z"); // 30 s after the 08:00 occurrence of a daily schedule created at D0

function workflow(db: Db): string {
  const allowed = [{ product: "kanban", operations: ["issues_list"], crud: ["read" as const] }];
  const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "Morning rollup", summary: "", instruction: "Roll up.", trigger: "08:00", steps: [], allowed } }, D0);
  return store.promote(db, d.id, d.revision, D0).workflow.id;
}
/** the agent directory as the slice lists it: A and B are Free, C is Bound, all active */
function directoryOf(db: Db, status: "active" | "paused" = "active"): void {
  directory.recordDirectory(
    db,
    [FREE_A, FREE_B, BOUND_C].map((c) => ({ id: c.id as `agt_${string}`, name: c.name, mode: c.mode as "free" | "bound", status })),
    D0,
  );
}
function freeSchedule(db: Db, agent: Caller = FREE_A, workflowId: string = workflow(db), extra: Partial<r.AutomationInput> = {}): r.Automation {
  return r.setAutomation(db, { workflowId, agentId: agent.id, targetMode: "free", cron: "0 8 * * *", ...extra }, D0);
}
const refusal = (code: string, status = 422) => (e: unknown) => {
  const t = e as { code?: string; httpStatus?: number };
  return t.code === code && t.httpStatus === status;
};

test("a Free schedule: due and claim by that Free agent work; the run, its Task Board issue and its report belong to that agent", async () => {
  const db = migratedDb();
  directoryOf(db);
  const owner = ctxFor(db, OWNER);
  const wf = workflow(db);
  // created a minute ago through the handler, so one occurrence is due now (handlers use the real clock)
  const set = await call<K.AutomationSetOutput>(H, "automation_set", { workflowId: wf, agentId: FREE_A.id, targetMode: "free", cron: "* * * * *" }, owner);
  assert.equal(set.targetMode, "free");
  assert.deepEqual(set.warnings, []);
  await call(H, "automation_delete", { id: set.id, revision: set.revision }, owner);
  // created a minute ago, so one occurrence is due now
  const made = r.setAutomation(db, { workflowId: wf, agentId: FREE_A.id, targetMode: "free", cron: "* * * * *" }, Date.now() - 60_000);

  const calls: { op: string; input: Record<string, unknown> }[] = [];
  const callApp: CallApp = async (_p, op, input) => {
    calls.push({ op, input: input as Record<string, unknown> });
    return { status: "ok", output: { id: "iss_free1" } } as unknown as CompanionResult;
  };
  const due = await call<K.RoutinesDueOutput>(H, "routines_due", {}, ctxFor(db, FREE_A, callApp));
  assert.equal(due.jobs.length, 1, "the Free agent is offered its own Free schedule");
  assert.equal(due.jobs[0]?.automationId, made.id);
  const occ = due.jobs[0]?.occurrence as string;
  const claim = await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, ctxFor(db, FREE_A, callApp));
  assert.equal(claim.claimed, true);
  assert.equal(claim.job?.kanbanIssueId, "iss_free1");
  // the run issue is assigned to the claimer: the Free agent itself (same contract as the Bound agent's, test/routines.test.ts)
  assert.deepEqual(
    { op: calls[0]?.op, assignee: calls[0]?.input.assignee, template: calls[0]?.input.template, status: calls[0]?.input.status },
    { op: "issue_create", assignee: FREE_A.id, template: r.runTemplateKey(wf), status: "in_progress" },
  );
  assert.equal(r.getRun(db, occ)?.claimedBy, FREE_A.id);
  // at most once: the same Free agent and a Bound agent get already_claimed or nothing, and no second issue is made
  const again = await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, ctxFor(db, FREE_A, callApp));
  assert.deepEqual([again.claimed, again.reason], [false, "already_claimed"]);
  assert.equal(calls.length, 1);
  assert.deepEqual((await call<K.RoutinesDueOutput>(H, "routines_due", {}, ctxFor(db, FREE_A, callApp))).jobs, [], "a claimed occurrence is not offered again");
  // report: only the claimer; the issue closes
  await assert.rejects(call(H, "routine_report", { occurrence: occ, status: "completed" }, ctxFor(db, FREE_B, callApp)), /No run of yours/);
  const done = await call<K.RoutineReportOutput>(H, "routine_report", { occurrence: occ, status: "completed", summary: "Done." }, ctxFor(db, FREE_A, callApp));
  assert.deepEqual([done.status, done.claimedBy], ["completed", FREE_A.id]);
  assert.equal(calls[1]?.op, "issue_complete");
});

test("a Free agent claims ONLY its own schedule's runs: another Free agent gets no job for it and its claim is refused", () => {
  const db = migratedDb();
  directoryOf(db);
  const wf = workflow(db);
  const a = freeSchedule(db, FREE_A, wf);
  const b = freeSchedule(db, FREE_B, wf); // same workflow, same cron: different schedules, different occurrences
  const jobsA = r.dueJobs(db, FREE_A.id, NOW, "free");
  const jobsB = r.dueJobs(db, FREE_B.id, NOW, "free");
  assert.deepEqual([jobsA.map((j) => j.automationId), jobsB.map((j) => j.automationId)], [[a.id], [b.id]], "each sees only its own");
  assert.notEqual(jobsA[0]?.occurrence, jobsB[0]?.occurrence);
  const occA = jobsA[0]?.occurrence as string;

  // B tries to claim A's occurrence: refused, and nothing is written
  assert.deepEqual(r.claim(db, FREE_B, occA, NOW), { claimed: false, reason: "not_due" });
  assert.equal(r.getRun(db, occA), null, "a refused claim writes no run");
  // a Free agent with no Free schedule at all: not_bound
  assert.deepEqual(r.claim(db, { id: "agt_01J0000000000000000000000Z", mode: "free" }, occA, NOW), { claimed: false, reason: "not_bound" });
  // the owner of the schedule still claims it (quiet on good), and then B is told it is taken, not given it
  const ok = r.claim(db, FREE_A, occA, NOW);
  assert.equal(ok.claimed, true);
  assert.equal(ok.claimed && ok.job.automationId, a.id);
  assert.deepEqual(r.claim(db, FREE_B, occA, NOW + 1000), { claimed: false, reason: "already_claimed" });
  assert.equal(r.getRun(db, occA)?.claimedBy, FREE_A.id);
  // B still claims its own
  assert.equal(r.claim(db, FREE_B, jobsB[0]?.occurrence as string, NOW + 1000).claimed, true);
  // and B cannot report A's run
  assert.throws(() => r.report(db, FREE_B.id, occA, "completed", null, NOW), /No run of yours/);
});

test("mode_mismatch: a Bound caller never gets or claims a Free schedule, a Free caller never gets or claims a Bound one", () => {
  const db = migratedDb();
  directoryOf(db);
  const wfFree = workflow(db);
  const wfBound = workflow(db);
  // the SAME agent id has one schedule of each mode (it was Bound once, or Free once)
  const sFree = freeSchedule(db, FREE_A, wfFree);
  const sBound = r.setAutomation(db, { workflowId: wfBound, agentId: FREE_A.id, cron: "0 8 * * *" }, D0);
  assert.equal(sBound.targetMode, "bound");
  const asBound = { id: FREE_A.id, mode: "bound" };
  const asFree = { id: FREE_A.id, mode: "free" };

  assert.deepEqual(r.dueJobs(db, FREE_A.id, NOW, "bound").map((j) => j.automationId), [sBound.id]);
  assert.deepEqual(r.dueJobs(db, FREE_A.id, NOW, "free").map((j) => j.automationId), [sFree.id]);
  const occFree = r.occurrenceOf(sFree.id, sFree.revision, T("2026-10-12T08:00:00Z"));
  const occBound = r.occurrenceOf(sBound.id, sBound.revision, T("2026-10-12T08:00:00Z"));
  assert.deepEqual(r.claim(db, asBound, occFree, NOW), { claimed: false, reason: "mode_mismatch" }, "Bound caller, Free schedule");
  assert.deepEqual(r.claim(db, asFree, occBound, NOW), { claimed: false, reason: "mode_mismatch" }, "Free caller, Bound schedule");
  assert.equal(r.getRun(db, occFree), null);
  assert.equal(r.getRun(db, occBound), null);
  // the right mode claims (quiet on good)
  assert.equal(r.claim(db, asFree, occFree, NOW).claimed, true);
  assert.equal(r.claim(db, asBound, occBound, NOW).claimed, true);
  // a Bound agent that has ONLY a Free schedule gets mode_mismatch, not not_due; a non-agent is not_bound
  const db2 = migratedDb();
  directoryOf(db2);
  const only = freeSchedule(db2, FREE_A);
  const occ = r.occurrenceOf(only.id, only.revision, T("2026-10-12T08:00:00Z"));
  assert.deepEqual(r.dueJobs(db2, FREE_A.id, NOW, "bound"), []);
  assert.deepEqual(r.claim(db2, asBound, occ, NOW), { claimed: false, reason: "mode_mismatch" });
  assert.deepEqual(r.claim(db2, { id: OWNER.id, mode: null }, occ, NOW), { claimed: false, reason: "not_bound" });
});

test("through the handlers: routines_due answers by the caller's own mode, and only to agents", async () => {
  const db = migratedDb();
  directoryOf(db);
  const wf = workflow(db);
  const free = freeSchedule(db, FREE_A, wf);
  r.setAutomation(db, { workflowId: wf, agentId: BOUND_C.id, cron: "* * * * *" }, Date.now() - 60_000);
  r.setAutomation(db, { id: free.id, revision: free.revision, workflowId: wf, agentId: FREE_A.id, cron: "* * * * *" }, Date.now() - 60_000);
  const jobs = async (c: Caller) => (await call<K.RoutinesDueOutput>(H, "routines_due", {}, ctxFor(db, c))).jobs;
  assert.equal((await jobs(FREE_A)).length, 1, "the Free agent: its Free schedule");
  assert.equal((await jobs(BOUND_C)).length, 1, "the Bound agent: its Bound schedule");
  assert.deepEqual(await jobs({ ...FREE_A, mode: "bound" }), [], "FREE_A's id presented as a Bound agent: nothing");
  assert.deepEqual(await jobs({ ...BOUND_C, mode: "free" }), [], "BOUND_C's id presented as a Free agent: nothing");
  assert.deepEqual(await jobs(FREE_B), [], "another Free agent: nothing");
  assert.deepEqual(await jobs(OWNER), [], "a person: nothing");
});

test("a paused agent gets no jobs and its claim is refused, in both modes; resuming gives them back", async () => {
  const db = migratedDb();
  directoryOf(db);
  const wf = workflow(db);
  const sFree = freeSchedule(db, FREE_A, wf);
  const sBound = r.setAutomation(db, { workflowId: wf, agentId: BOUND_C.id, cron: "0 8 * * *" }, D0);
  const occFree = r.occurrenceOf(sFree.id, sFree.revision, T("2026-10-12T08:00:00Z"));
  const occBound = r.occurrenceOf(sBound.id, sBound.revision, T("2026-10-12T08:00:00Z"));
  assert.equal(r.dueJobs(db, FREE_A.id, NOW, "free").length, 1, "control: active");

  // the slice says both are paused: agentsChanged is the event for a pause (the full list)
  await definition.events?.agentsChanged?.(
    [
      { id: FREE_A.id, name: "Agent A", mode: "free", status: "paused" },
      { id: BOUND_C.id, name: "Agent C", mode: "bound", status: "paused" },
    ] as never,
    { db } as never,
  );
  assert.deepEqual(r.dueJobs(db, FREE_A.id, NOW, "free"), []);
  assert.deepEqual(r.dueJobs(db, BOUND_C.id, NOW, "bound"), []);
  assert.deepEqual(r.claim(db, FREE_A, occFree, NOW), { claimed: false, reason: "agent_unavailable" });
  assert.deepEqual(r.claim(db, BOUND_C, occBound, NOW), { claimed: false, reason: "agent_unavailable" });
  assert.equal(r.getRun(db, occFree), null, "no run row for a refused claim");
  assert.equal(r.getRun(db, occBound), null);
  // the handler layer, as the SDK would run it if it had let the call through
  const viaHandler = await call<K.RoutinesDueOutput>(H, "routines_due", {}, ctxFor(db, FREE_A));
  assert.deepEqual(viaHandler.jobs, []);
  const claimed = await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occFree }, ctxFor(db, FREE_A));
  assert.deepEqual([claimed.claimed, claimed.reason, claimed.job], [false, "agent_unavailable", null]);

  // resumed: the same occurrence (still inside the grace) is offered and claimed
  directoryOf(db, "active");
  assert.equal(r.dueJobs(db, FREE_A.id, NOW, "free").length, 1);
  assert.equal(r.claim(db, FREE_A, occFree, NOW).claimed, true);
  assert.equal(r.claim(db, BOUND_C, occBound, NOW).claimed, true);
});

test("a removed agent (gone from the directory) gets no jobs and its claim is refused; agentRemoved and a shorter agentsChanged both do it", async () => {
  const db = migratedDb();
  directoryOf(db);
  const wf = workflow(db);
  const sFree = freeSchedule(db, FREE_A, wf);
  const sFreeB = freeSchedule(db, FREE_B, wf);
  const sBound = r.setAutomation(db, { workflowId: wf, agentId: BOUND_C.id, cron: "0 8 * * *" }, D0);
  const occ = (s: r.Automation) => r.occurrenceOf(s.id, s.revision, T("2026-10-12T08:00:00Z"));

  await definition.events?.agentRemoved?.({ id: FREE_A.id, name: "Agent A", mode: "free", status: "active" } as never, { db } as never);
  assert.deepEqual(r.dueJobs(db, FREE_A.id, NOW, "free"), [], "agentRemoved");
  assert.deepEqual(r.claim(db, FREE_A, occ(sFree), NOW), { claimed: false, reason: "agent_unavailable" });
  assert.equal(r.dueJobs(db, FREE_B.id, NOW, "free").length, 1, "the others are not touched");

  // a full list without B and C: both are gone, A is back (re-added)
  await definition.events?.agentsChanged?.([{ id: FREE_A.id, name: "Agent A", mode: "free", status: "active" }] as never, { db } as never);
  assert.deepEqual(r.dueJobs(db, FREE_B.id, NOW, "free"), [], "agentsChanged without B");
  assert.deepEqual(r.claim(db, FREE_B, occ(sFreeB), NOW), { claimed: false, reason: "agent_unavailable" });
  assert.deepEqual(r.dueJobs(db, BOUND_C.id, NOW, "bound"), [], "a Bound agent that left the directory gets nothing either");
  assert.deepEqual(r.claim(db, BOUND_C, occ(sBound), NOW), { claimed: false, reason: "agent_unavailable" });
  assert.equal(r.dueJobs(db, FREE_A.id, NOW, "free").length, 1, "re-added");
  assert.equal(r.claim(db, FREE_A, occ(sFree), NOW).claimed, true);
  // the name is kept for suggestion text
  assert.equal(directory.lookup(db, FREE_B.id)?.name, "Agent B");
  // an agent Evolution has no row for passes (the SDK admits only slice agents; first sight writes the row): quiet on good
  assert.equal(directory.isAvailable(db, "agt_01J0000000000000000000000Y"), true);
});

test("a Free target must be a listed Free agent (422 agent_not_free); policyVersion must be absent (422 policy_version_not_applicable)", async () => {
  const db = migratedDb();
  directoryOf(db);
  const owner = ctxFor(db, OWNER);
  const wf = workflow(db);
  const base = { workflowId: wf, targetMode: "free", cron: "0 8 * * *" };
  const set = (extra: Record<string, unknown>) => call<K.AutomationSetOutput>(H, "automation_set", { ...base, ...extra }, owner);

  // fire on bad
  await assert.rejects(set({ agentId: BOUND_C.id }), refusal("agent_not_free"), "a Bound agent");
  await assert.rejects(set({ agentId: "agt_01J0000000000000000000000Y" }), refusal("agent_not_free"), "an agent the directory does not list");
  await assert.rejects(set({ agentId: FREE_A.id, policyVersion: 1 }), refusal("policy_version_not_applicable"), "a recipe version for a Free target");
  const gone = { ...FREE_B };
  await definition.events?.agentRemoved?.({ id: gone.id, name: gone.name, mode: "free", status: "active" } as never, { db } as never);
  await assert.rejects(set({ agentId: gone.id }), refusal("agent_not_free"), "a removed agent");
  const err = await set({ agentId: BOUND_C.id }).catch((e: unknown) => e as { details?: { pointer?: string } });
  assert.equal((err as { details?: { pointer?: string } }).details?.pointer, "/agentId");
  // a row from before 0008 (no mode yet) is not a Free target until the directory says so
  db.prepare("INSERT INTO agent_names (id, name, seen_at) VALUES (?, ?, ?)").run("agt_01J0000000000000000000000Q", "Old row", D0);
  await assert.rejects(set({ agentId: "agt_01J0000000000000000000000Q" }), refusal("agent_not_free"));
  assert.deepEqual(await call<K.AutomationsListOutput>(H, "automations_list", {}, owner).then((l) => l.automations), [], "nothing was stored by a refused call");

  // quiet on good: a listed Free agent, active or paused (a paused agent waits)
  const ok = await set({ agentId: FREE_A.id });
  assert.deepEqual([ok.targetMode, ok.agentId, ok.warnings], ["free", FREE_A.id, []]);
  directoryOf(db, "paused");
  assert.equal((await set({ agentId: FREE_A.id })).targetMode, "free");

  // the default is bound, and a Bound schedule still takes policyVersion
  const bound = await call<K.AutomationSetOutput>(H, "automation_set", { workflowId: wf, agentId: BOUND_C.id, cron: "0 8 * * *", policyVersion: 1 }, owner);
  assert.deepEqual([bound.targetMode, bound.policyVersion], ["bound", 1]);
});

test("edits: a Free schedule keeps its mode when the edit does not name it; pause and cron edits never need the directory; a changed agent or mode is checked again", async () => {
  const db = migratedDb();
  directoryOf(db);
  const owner = ctxFor(db, OWNER);
  const wf = workflow(db);
  const a = await call<K.AutomationSetOutput>(H, "automation_set", { workflowId: wf, agentId: FREE_A.id, targetMode: "free", cron: "0 8 * * *" }, owner);
  const edited = await call<K.AutomationSetOutput>(H, "automation_set", { id: a.id, revision: a.revision, workflowId: wf, agentId: FREE_A.id, cron: "0 9 * * *", kanbanProject: "prj_x" }, owner);
  assert.deepEqual([edited.targetMode, edited.cron, edited.revision], ["free", "0 9 * * *", a.revision + 1]);
  // an edit that sends a policyVersion to a Free schedule (no targetMode named) is refused too
  await assert.rejects(call(H, "automation_set", { id: a.id, revision: edited.revision, workflowId: wf, agentId: FREE_A.id, cron: "0 9 * * *", policyVersion: 1 }, owner), refusal("policy_version_not_applicable"));
  // the agent leaves the workspace: the owner can still pause, resume, change the cron and delete the schedule
  await definition.events?.agentRemoved?.({ id: FREE_A.id, name: "Agent A", mode: "free", status: "active" } as never, { db } as never);
  const paused = await call<K.AutomationPauseOutput>(H, "automation_pause", { id: a.id, revision: edited.revision, paused: true }, owner);
  assert.deepEqual([paused.enabled, paused.targetMode], [false, "free"]);
  const resumed = await call<K.AutomationPauseOutput>(H, "automation_pause", { id: a.id, revision: paused.revision, paused: false }, owner);
  assert.equal(resumed.enabled, true);
  const cron = await call<K.AutomationSetOutput>(H, "automation_set", { id: a.id, revision: resumed.revision, workflowId: wf, agentId: FREE_A.id, cron: "0 10 * * *" }, owner);
  assert.equal(cron.targetMode, "free");
  // moving the schedule to another agent, or switching its mode, checks the target again
  await assert.rejects(call(H, "automation_set", { id: a.id, revision: cron.revision, workflowId: wf, agentId: BOUND_C.id, cron: "0 10 * * *" }, owner), refusal("agent_not_free"), "a Free schedule moved to a Bound agent");
  const bound = await call<K.AutomationSetOutput>(H, "automation_set", { workflowId: wf, agentId: BOUND_C.id, cron: "0 8 * * *" }, owner);
  await assert.rejects(call(H, "automation_set", { id: bound.id, revision: bound.revision, workflowId: wf, agentId: BOUND_C.id, targetMode: "free", cron: "0 8 * * *" }, owner), refusal("agent_not_free"), "a Bound schedule switched to free for a Bound agent");
  assert.equal((await call<K.AutomationsListOutput>(H, "automations_list", {}, owner)).automations.find((x) => x.id === bound.id)?.targetMode, "bound", "the refused switch changed nothing");
  // free → bound with a policyVersion is a Bound schedule again, with the recipe statement
  const back = await call<K.AutomationSetOutput>(H, "automation_set", { id: a.id, revision: cron.revision, workflowId: wf, agentId: BOUND_C.id, targetMode: "bound", cron: "0 10 * * *", policyVersion: 1 }, owner);
  assert.deepEqual([back.targetMode, back.agentId, back.policyVersion], ["bound", BOUND_C.id, 1]);
  await call(H, "automation_delete", { id: a.id, revision: back.revision }, owner);
});

test("the policy_stale gate does not apply to a Free schedule (no applied recipe); the same widening still stops a Bound schedule", () => {
  const db = migratedDb();
  directoryOf(db);
  const wf = workflow(db);
  const free = freeSchedule(db, FREE_A, wf);
  const bound = r.setAutomation(db, { workflowId: wf, agentId: BOUND_C.id, cron: "0 8 * * *" }, D0);
  // v2 needs more access than v1
  const wfRow = store.getWorkflow(db, wf);
  const d = store.getDraft(db, wfRow.draftId);
  const u = store.updateDraft(db, d.id, d.revision, { allowed: [...d.allowed, { product: "knowledge", operations: ["remember"], crud: ["create"] }] }, D0);
  store.promote(db, d.id, u.revision, D0);
  assert.equal(store.getWorkflow(db, wf).activeVersion, 2);

  // control (fire on bad): the Bound schedule is stopped by the gate and warns
  const views = r.listAutomations(db, NOW);
  assert.deepEqual(views.find((x) => x.id === bound.id)?.warnings.map((w) => w.code), ["policy_stale"]);
  assert.deepEqual(r.dueJobs(db, BOUND_C.id, NOW, "bound"), []);
  assert.equal(r.getRun(db, r.occurrenceOf(bound.id, bound.revision, T("2026-10-12T08:00:00Z")))?.status, "policy_stale");
  // the Free schedule runs v2 with no warning and no policy_stale run
  assert.deepEqual(views.find((x) => x.id === free.id)?.warnings, []);
  const jobs = r.dueJobs(db, FREE_A.id, NOW, "free");
  assert.deepEqual(jobs.map((j) => j.version), [2]);
  const c = r.claim(db, FREE_A, jobs[0]?.occurrence as string, NOW);
  assert.equal(c.claimed, true);
  assert.equal(c.claimed && c.job.version, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM routine_runs WHERE automation_id = ? AND status = 'policy_stale'").get(free.id)?.n, 0);
  // the gate function itself
  assert.equal(r.listAutomations(db, NOW).find((x) => x.id === free.id)?.policyVersion, 1, "a stored value that no one applied");
});

test("workflow_get tells a Free caller that the run uses the agent's own access; a Bound caller keeps the allow-list notice", async () => {
  const db = migratedDb();
  const wf = workflow(db);
  const get = (c: Caller) => call<K.WorkflowGetOutput>(H, "workflow_get", { id: wf }, ctxFor(db, c));
  const free = await get(FREE_A);
  assert.equal(free.notice, "Runs with Agent A's own access. The operation list is guidance until per-run narrowing (C288 R2–R4).");
  assert.equal(free.notice, freeTargetNotice("Agent A"));
  assert.doesNotMatch(free.notice, /bridge blocks/, "the Free notice does not claim the bridge enforces the list");
  assert.equal((await get(BOUND_C)).notice, ALLOWLIST_NOTICE);
  assert.match((await get(BOUND_C)).notice, /bridge blocks every other operation/);
  assert.deepEqual(free.allowed, (await get(BOUND_C)).allowed, "the same workflow text");
});

test("automations_list shows targetMode for both kinds", async () => {
  const db = migratedDb();
  directoryOf(db);
  const wf = workflow(db);
  const f = freeSchedule(db, FREE_A, wf);
  const b = r.setAutomation(db, { workflowId: wf, agentId: BOUND_C.id, cron: "0 8 * * *" }, D0);
  const list = await call<K.AutomationsListOutput>(H, "automations_list", {}, ctxFor(db, OWNER));
  assert.deepEqual(
    list.automations.map((x) => [x.id, x.targetMode]).sort(),
    [
      [f.id, "free"],
      [b.id, "bound"],
    ].sort(),
  );
});
