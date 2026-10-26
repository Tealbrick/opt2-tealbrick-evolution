// Kanban evidence → suggestion: the pattern detector over a fake companion call (the real call path, grant and
// bridge envelope, is the SDK's `callApp`; conformance A12 covers it for apps whose agent ops call companions).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CompanionResult } from "@opt2-tealbrick/miniapp-sdk";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { handlers } from "../src/app.ts";
import { buildGroups, normalizeTitle, parseDoneIssues } from "../src/detector.ts";
import { AGENT_A, AGENT_B, type CallApp, call, ctxFor, migratedDb, OWNER } from "./helpers.ts";
import { waitFor } from "./poll.ts";

const H = handlers as unknown as Parameters<typeof call>[0];

const issue = (id: string, title: string, agent: string, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  status: "done",
  assignee: { kind: "agent", id: agent, name: agent === AGENT_A.id ? "Agent A" : "Agent B" },
  updatedAt: `2026-10-0${id.slice(-1)}T10:00:00Z`,
  ...extra,
});

function kanban(issues: unknown[], calls: { product: string; op: string; input: unknown }[] = []): CallApp {
  return async (product, op, input) => {
    calls.push({ product, op, input });
    return { status: "ok", output: { issues } } as unknown as CompanionResult;
  };
}

test("normalised titles ignore numbers, case and punctuation", () => {
  assert.equal(normalizeTitle("Weekly report #41 — Team"), normalizeTitle("weekly REPORT 42 team"));
  assert.notEqual(normalizeTitle("Weekly report"), normalizeTitle("Monthly report"));
});

test("the parser keeps done issues assigned to an agent, in any of the accepted shapes", () => {
  const out = parseDoneIssues({
    issues: [
      issue("i1", "A", AGENT_A.id),
      { id: "i2", title: "B", status: "done", assigneeId: AGENT_B.id, templateId: "tpl-x" },
      { id: "i3", title: "C", status: "in_progress", assignee: { kind: "agent", id: AGENT_A.id, name: "A" } },
      { id: "i4", title: "D", status: "done", assignee: { kind: "owner", id: "per_1", name: "Owner" } },
      { id: "i6", title: "E", status: "done", assignee: null },
      { id: "i7", title: "F", status: "done", assignee: { type: "agent", id: AGENT_A.id } },
      { id: "i5", status: "done", assignee: AGENT_A.id },
      "junk",
    ],
  });
  assert.deepEqual(out.map((i) => [i.id, i.agentId, i.agentName, i.template]), [
    ["i1", AGENT_A.id, "Agent A", null],
    ["i2", AGENT_B.id, null, "tpl-x"],
    ["i7", AGENT_A.id, null, null],
  ]);
  assert.deepEqual(parseDoneIssues({ items: [issue("i1", "A", AGENT_A.id)] }).length, 1);
  assert.deepEqual(parseDoneIssues(null), []);
});

test("groups are per agent and per template (or title); covered issues are skipped", () => {
  const issues = parseDoneIssues({
    issues: [
      issue("i1", "Weekly report 1", AGENT_A.id),
      issue("i2", "Weekly report 2", AGENT_A.id),
      issue("i3", "Weekly report 3", AGENT_B.id),
      issue("i4", "Anything", AGENT_A.id, { template: "weekly" }),
      issue("i5", "Else", AGENT_A.id, { template: { id: "weekly" } }),
    ],
  });
  const groups = buildGroups(issues, new Set(["i2"]));
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g.issues.map((i) => i.id)]));
  assert.deepEqual(byKey, {
    [`${AGENT_A.id}|title:weekly report #`]: ["i1"],
    [`${AGENT_B.id}|title:weekly report #`]: ["i3"],
    [`${AGENT_A.id}|template:weekly`]: ["i5", "i4"],
  });
});

test("Kanban evidence → suggestion: N ≥ 3 by one agent creates one suggestion; a re-scan adds new evidence, never duplicates", async () => {
  const db = migratedDb();
  const calls: { product: string; op: string; input: unknown }[] = [];
  const three = [issue("i1", "Weekly report 1", AGENT_A.id), issue("i2", "Weekly report 2", AGENT_A.id), issue("i3", "weekly report 3", AGENT_A.id), issue("i4", "Weekly report 4", AGENT_B.id)];
  const r1 = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, kanban(three, calls)));
  assert.deepEqual(calls[0], { product: "kanban", op: "issues_list", input: { status: "done", limit: 200 } });
  assert.equal(r1.kanban, "ok");
  assert.equal(r1.issuesSeen, 4);
  assert.equal(r1.created.length, 1, "agent B has one issue only: no suggestion");
  assert.equal(r1.created[0]?.agentId, AGENT_A.id);
  assert.equal(r1.created[0]?.evidenceCount, 3);
  const s = await call<K.ReviewSuggestionOutput>(H, "review_suggestion", { id: r1.created[0]?.id }, ctxFor(db, OWNER));
  assert.equal(s.suggestion.source, "detector");
  assert.match(s.suggestion.summary, /Agent A finished 3 Kanban issues/);
  assert.deepEqual(s.suggestion.evidence.map((e) => [e.kind, e.ref, e.title]), [
    ["kanban_issue", "i3", "weekly report 3"],
    ["kanban_issue", "i2", "Weekly report 2"],
    ["kanban_issue", "i1", "Weekly report 1"],
  ]);

  // the agent whose work it is can read it
  const mine = await call<K.SuggestionsListOutput>(H, "suggestions_list", {}, ctxFor(db, AGENT_A));
  assert.equal(mine.suggestions.length, 1);

  const r2 = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, kanban(three)));
  assert.deepEqual([r2.created.length, r2.updated.length], [0, 0], "same issues: nothing new");
  const r3 = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, kanban([...three, issue("i5", "Weekly report 5", AGENT_A.id)])));
  assert.deepEqual([r3.created.length, r3.updated.length, r3.updated[0]?.evidenceCount], [0, 1, 4], "open suggestion gets the new issue");

  // after a decision the group starts over and needs N new issues again
  await call(H, "suggestion_decide", { id: r1.created[0]?.id, decision: "reject" }, ctxFor(db, OWNER));
  const more = [issue("i6", "Weekly report 6", AGENT_A.id), issue("i7", "Weekly report 7", AGENT_A.id)];
  const r4 = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, kanban([...three, ...more])));
  assert.deepEqual([r4.created.length, r4.updated.length], [0, 0]);
  const r5 = await call<K.DetectorScanOutput>(H, "detector_scan", { minRepeats: 2 }, ctxFor(db, OWNER, kanban([...three, ...more])));
  assert.equal(r5.created.length, 1);
});

test("Kanban is a soft dependency: not deployed, refused or held → a normal answer, nothing written", async () => {
  const db = migratedDb();
  const absent: CallApp = async () => {
    throw new TbError("companion_undeclared", "no grant", 403);
  };
  const r = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, absent));
  assert.equal(r.kanban, "unavailable");
  assert.match(r.message ?? "", /companion_undeclared/);
  const held: CallApp = async () => ({ status: "held", holdId: "hld_1", expiresAt: "x" }) as unknown as CompanionResult;
  assert.equal((await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, held))).kanban, "unavailable");
  assert.equal((await call<K.ReviewSuggestionsOutput>(H, "review_suggestions", {}, ctxFor(db, OWNER))).suggestions.length, 0);
});

test("background refresh (C85): scans on a timer without an op call, never twice at once, records status; the owner op stays", async () => {
  const { createDetectorRefresh } = await import("../src/scan.ts");
  const db = migratedDb();
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const slow: CallApp = async () => {
    calls++;
    await gate;
    return { status: "ok", output: { issues: [1, 2, 3].map((n) => issue(`b${n}`, `Daily check ${n}`, AGENT_A.id)) } } as unknown as CompanionResult;
  };
  const warn: string[] = [];
  const refresh = createDetectorRefresh({ firstDelayMs: 5, intervalMs: 60_000 });
  assert.equal(await refresh.tick(), null, "not started: nothing runs");
  refresh.start({ db, callApp: slow as never, log: { warn: (m) => warn.push(m) } });
  const first = refresh.tick();
  assert.equal(await refresh.tick(), null, "a second scan while one runs is skipped");
  release();
  const r = await first;
  assert.equal(r?.created.length, 1);
  assert.equal(calls, 1);
  const status = await call<K.DetectorStatusOutput>(H, "detector_status", {}, ctxFor(db, OWNER));
  assert.deepEqual([status.trigger, status.kanban, status.issuesSeen, status.created, status.intervalMinutes], ["background", "ok", 3, 1, 15]);

  // the timer fires on its own (first delay 5 ms)
  await waitFor("the scheduled first scan ran (the timer fired on its own)", () => calls >= 2);
  assert.equal(calls, 2, "the scheduled first scan ran once");
  refresh.stop();
  assert.equal(await refresh.tick(), null, "stopped: nothing runs");

  // Kanban unreachable in the background: a normal answer, recorded, no warning
  const down = createDetectorRefresh({ firstDelayMs: 60_000 });
  down.start({ db, callApp: async () => Promise.reject(new TbError("no_bridge", "x", 503)), log: { warn: (m) => warn.push(m) } });
  assert.equal((await down.tick())?.kanban, "unavailable");
  down.stop();
  assert.equal((await call<K.DetectorStatusOutput>(H, "detector_status", {}, ctxFor(db, OWNER))).kanban, "unavailable");
  assert.deepEqual(warn, []);

  // the owner op still scans on demand and is recorded as such
  await call(H, "detector_scan", {}, ctxFor(db, OWNER, kanban([])));
  assert.equal((await call<K.DetectorStatusOutput>(H, "detector_status", {}, ctxFor(db, OWNER))).trigger, "owner");
});

test("C88/L12: an agent never sees Kanban titles Evolution read with its own grant; the owner sees them", async () => {
  const { DETECTOR_AGENT_TITLE } = await import("../src/app.ts");
  const db = migratedDb();
  const secret = [1, 2, 3].map((n) => issue(`p${n}`, `Payroll for Jane Doe ${n}`, AGENT_A.id, { project: "prj_private" }));
  const r = await call<K.DetectorScanOutput>(H, "detector_scan", {}, ctxFor(db, OWNER, kanban(secret)));
  const id = r.created[0]?.id as string;
  assert.match(r.created[0]?.title ?? "", /Payroll/, "the owner (person op) sees the title");
  const owner = await call<K.ReviewSuggestionOutput>(H, "review_suggestion", { id }, ctxFor(db, OWNER));
  assert.match(owner.suggestion.evidence[0]?.title ?? "", /Payroll/);

  const list = await call<K.SuggestionsListOutput>(H, "suggestions_list", {}, ctxFor(db, AGENT_A));
  const got = await call<K.SuggestionGetOutput>(H, "suggestion_get", { id }, ctxFor(db, AGENT_A));
  const seen = JSON.stringify({ list, got });
  assert.doesNotMatch(seen, /Payroll|Jane|Doe/, "no Kanban text reaches the agent");
  assert.equal(got.title, DETECTOR_AGENT_TITLE);
  assert.deepEqual(got.evidence.map((e) => [e.kind, e.ref, e.title]), [
    ["kanban_issue", "p3", null],
    ["kanban_issue", "p2", null],
    ["kanban_issue", "p1", null],
  ]);
  // an agent's own suggestion keeps its own text
  const own = await call<K.SuggestionCreateOutput>(H, "suggestion_create", { title: "My weekly report", evidence: [{ kind: "kanban_issue", ref: "iss_9", note: "mine" }] }, ctxFor(db, AGENT_A));
  const back = await call<K.SuggestionGetOutput>(H, "suggestion_get", { id: own.id }, ctxFor(db, AGENT_A));
  assert.deepEqual([back.title, back.evidence[0]?.note], ["My weekly report", "mine"]);
});
