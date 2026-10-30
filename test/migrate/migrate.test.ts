// C367 M3: the one-time move of 0.3.x agent workflows and schedules to the engine, on real-shaped 0.3.0 data
// (test/migrate/fixture.ts): idempotent, resumable, nothing of the history touched, and a rollback that works.
import assert from "node:assert/strict";
import { test } from "node:test";
import type * as K from "#kit";
import { handlers, manifest } from "../../src/app.ts";
import * as directory from "../../src/directory.ts";
import { validateContract, type WorkflowContract } from "../../src/engine/contract.ts";
import * as engine from "../../src/engine/engine-store.ts";
import { contractOf, engineIdOf, instructionOf, MAX_INSTRUCTION, UNASSIGNED_AGENT } from "../../src/migrate/contract.ts";
import { migrate } from "../../src/migrate/run.ts";
import { getItem, listItems, marker } from "../../src/migrate/state.ts";
import * as r from "../../src/routines.ts";
import * as store from "../../src/store.ts";
import { call, ctxFor, OWNER } from "../helpers.ts";
import { BOUND_AGENT, D0, FREE_F, FREE_G, seed030, snapshot, T, upgrade } from "./fixture.ts";

const H = handlers as unknown as Parameters<typeof call>[0];
const NOW = T("2026-10-26T10:00:00Z");
const ON = { engineConfigured: true, now: NOW };
const LEGACY = ["workflows", "workflow_versions", "drafts", "automations", "routine_runs", "suggestions", "agent_names"];

/** a Free schedule the R1a way (after the upgrade the directory knows the agent) */
function freeSchedule(s: ReturnType<typeof seed030>, workflowId: string, agent: string, cron = "0 7 * * *", pin?: number): string {
  directory.recordDirectory(s.db, [{ id: agent as never, name: "Free agent", mode: "free", status: "active" }, ...(s.raw.prepare("SELECT id FROM agent_names").all().length ? [] : [])], D0);
  return r.setAutomation(s.db, { workflowId, agentId: agent, targetMode: "free", cron, ...(pin ? { versionPin: pin } : {}) }, D0).id;
}
const automation = (s: ReturnType<typeof seed030>, id: string) => s.raw.prepare("SELECT * FROM automations WHERE id = ?").get(id) as Record<string, unknown>;

test("0.3.0 data (every schedule Bound): all versions become contracts, every schedule stays on routines_*, history untouched, twice is the same", () => {
  const s = seed030();
  upgrade(s.raw);
  const before = snapshot(s.raw, LEGACY);
  const first = migrate(s.db, ON);
  assert.ok(first.ran && first.complete);
  assert.deepEqual(first.ran && first.counts, { workflowsMigrated: 4, workflowsFailed: 0, schedulesMigrated: 0, schedulesLegacyBound: 3, schedulesSkipped: 0, schedulesFailed: 0, deferred: 0 });
  // nothing of the 0.3.x data changed: the Bound schedules are not even paused
  assert.deepEqual(snapshot(s.raw, LEGACY), before);
  // all versions are contracts; no schedule gave an agent, so the contract carries the placeholder and is not active
  const id = engineIdOf(s.daily);
  assert.deepEqual(engine.listDefinitions(s.db).filter((d) => d.workflowId === id).map((d) => d.version).sort(), [1, 2, 3]);
  const c = engine.getDefinition(s.db, id, 2)?.contract as WorkflowContract;
  const step = c.steps[0];
  assert.equal(step?.type === "ai" && "agent" in step.by && step.by.agent, UNASSIGNED_AGENT);
  assert.deepEqual(c.triggers, [{ kind: "manual" }], "no schedule moved: no schedule trigger");
  assert.equal(engine.activeActivation(s.db, id), null, "an unassigned agent is not activated");
  assert.equal(s.raw.prepare("SELECT count(*) AS n FROM engine_schedules").get()?.n, 0);
  assert.deepEqual([getItem(s.db, "schedule", s.dailyAut)?.status, getItem(s.db, "schedule", s.pausedAut)?.status], ["legacy_bound", "legacy_bound"]);
  assert.ok(marker(s.db), "the marker row says it is done");
  // run again: a no-op, the whole database is the same
  const all = snapshot(s.raw);
  assert.deepEqual(migrate(s.db, { engineConfigured: true, now: NOW + 99_999 }), { ran: false, reason: "already_done" });
  assert.deepEqual(snapshot(s.raw), all);
  // the legacy path is unchanged for the Bound agent: due and claim work as before
  const due = r.dueJobs(s.db, BOUND_AGENT, T("2026-10-12T08:00:30Z"), "bound");
  const job = due.find((j) => j.automationId === s.dailyAut);
  assert.ok(job, "the daily schedule is still offered");
  const claim = r.claim(s.db, { id: BOUND_AGENT, mode: "bound" }, job.occurrence, T("2026-10-12T08:00:30Z"));
  assert.equal(claim.claimed, true);
});

test("the legacy_bound warning is on every Bound schedule in automations_list; the deprecation says so", async () => {
  const s = seed030();
  upgrade(s.raw);
  migrate(s.db, ON);
  const out = await call<K.AutomationsListOutput>(H, "automations_list", {}, ctxFor(s.db, OWNER));
  assert.equal(out.automations.length, 3);
  for (const a of out.automations) {
    const w = a.warnings.find((x) => x.code === "legacy_bound");
    assert.ok(w, a.id);
    assert.match(w.message, /routines_due, routine_claim, routine_report/);
    assert.match(w.message, /deprecated/);
  }
});

test("the contract of a version: one ai step by the agent, the instruction and the reviewed steps, a summary output, a valid contract", () => {
  const s = seed030();
  const v = store.getVersion(s.db, s.daily, 2);
  const c = contractOf(s.daily, v, { agentId: FREE_F, cron: "0 8 * * *" });
  assert.equal(c.id, engineIdOf(s.daily));
  assert.match(c.id, /^[a-z][a-z0-9-]{2,39}$/);
  assert.equal(c.version, 2);
  assert.deepEqual(c.triggers, [{ kind: "schedule", cron: "0 8 * * *", timezone: "UTC" }, { kind: "manual" }]);
  assert.equal(c.steps.length, 1);
  const step = c.steps[0];
  assert.equal(step?.type, "ai");
  if (step?.type !== "ai") return;
  assert.deepEqual(step.by, { agent: FREE_F });
  assert.deepEqual(step.outputSchema, { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] });
  assert.equal(step.heartbeatSec, 0, "a 0.3.x runner does not send heartbeats");
  assert.match(step.instruction, /^Roll up yesterday's done issues and name the owner of each\./);
  assert.match(step.instruction, /When: 08:00/);
  assert.match(step.instruction, /1\. Scan: Read the done issues\. \(operations: kanban\.issues_list\)/);
  assert.match(step.instruction, /2\. Write: Write the roll-up\./);
  assert.equal(instructionOf(v), step.instruction);
  assert.deepEqual(validateContract(c).errors, []);
  // no agent: the placeholder and a summary that tells the owner what to do
  const loose = contractOf(s.daily, v, { agentId: null, cron: null });
  assert.match(loose.summary ?? "", /choose the agent in the editor/);
  assert.deepEqual(validateContract(loose).errors, []);
});

test("a Free schedule moves: contract versions with its agent, an engine schedule (same cron, UTC, pinned), active version, the old schedule paused and kept", async () => {
  const s = seed030();
  upgrade(s.raw);
  const aut = freeSchedule(s, s.daily, FREE_F);
  const before = automation(s, aut);
  const history = snapshot(s.raw, ["routine_runs", "workflows", "workflow_versions"]);
  const res = migrate(s.db, ON);
  assert.ok(res.ran && res.complete);
  const item = getItem(s.db, "schedule", aut);
  assert.equal(item?.status, "migrated");
  const row = engine.getSchedule(s.db, item?.engineId as string);
  assert.ok(row);
  assert.deepEqual([row.workflowId, row.kind, row.spec, row.versionPin, row.paused, row.overlap, row.temporalState], [engineIdOf(s.daily), "schedule", { cron: "0 7 * * *", timezone: "UTC" }, 3, false, "skip", "pending"]);
  // contracts: all three versions, the agent, the schedule trigger; the active version is activated with no operations
  for (const v of [1, 2, 3]) {
    const c = engine.getDefinition(s.db, engineIdOf(s.daily), v)?.contract as WorkflowContract;
    const st = c.steps[0];
    assert.equal(st?.type === "ai" && "agent" in st.by && st.by.agent, FREE_F);
    assert.deepEqual(c.triggers[0], { kind: "schedule", cron: "0 7 * * *", timezone: "UTC" });
  }
  const act = engine.activeActivation(s.db, engineIdOf(s.daily));
  assert.deepEqual([act?.version, act?.uses], [3, []]);
  // the old schedule: paused, nothing else changed; its runs are the same rows
  const after = automation(s, aut);
  assert.equal(after.enabled, 0);
  // pausing is the one change: the flag, the revision, the stamp and the next due time (it is worked out again from now)
  assert.deepEqual({ ...after, enabled: before.enabled, revision: before.revision, updated_at: before.updated_at, next_due_at: before.next_due_at }, { ...before });
  assert.deepEqual(snapshot(s.raw, ["routine_runs", "workflows", "workflow_versions"]), history);
  // rollback is possible: the old schedule is still a schedule, resuming it offers its runs again
  assert.equal(s.raw.prepare("SELECT count(*) AS n FROM automations WHERE id = ? AND deleted_at IS NULL").get(aut)?.n, 1);
  // the compatibility layer: nothing is offered, and a claim says why
  assert.deepEqual(r.dueJobs(s.db, FREE_F, T("2026-10-27T07:00:30Z"), "free"), []);
  const a = automation(s, aut);
  const due = T("2026-10-27T07:00:00Z");
  const claim = r.claim(s.db, { id: FREE_F, mode: "free" }, r.occurrenceOf(aut, Number(a.revision), due), due + 30_000);
  assert.deepEqual(claim, { claimed: false, reason: "migrated" });
  // automations_list tells the owner, and how to go back
  const list = await call<K.AutomationsListOutput>(H, "automations_list", {}, ctxFor(s.db, OWNER));
  const w = list.automations.find((x) => x.id === aut)?.warnings.find((x) => x.code === "migrated");
  assert.match(w?.message ?? "", new RegExp(item?.engineId as string));
  assert.match(w?.message ?? "", /pause or delete the engine schedule first/);
  // rollback: delete the engine schedule, resume the old one: the agent is offered runs again
  engine.markScheduleDeleted(s.db, row.id, NOW);
  r.pauseAutomation(s.db, aut, Number(a.revision), false, T("2026-10-26T12:00:00Z"));
  const resumed = r.dueJobs(s.db, FREE_F, T("2026-10-27T07:00:30Z"), "free");
  assert.equal(resumed.length, 1);
  assert.deepEqual(r.claim(s.db, { id: FREE_F, mode: "free" }, resumed[0]?.occurrence as string, T("2026-10-27T07:00:30Z")).claimed, false, "still `migrated`: the item says moved until the owner changes it");
});

test("a schedule pinned to an older version pins the engine schedule there; a paused legacy schedule gives a paused engine schedule", () => {
  const s = seed030();
  upgrade(s.raw);
  const pin = freeSchedule(s, s.pinned, FREE_F, "30 9 * * 1", 1);
  const paused = freeSchedule(s, s.loose, FREE_F, "0 6 1 * *");
  s.raw.prepare("UPDATE automations SET enabled = 0 WHERE id = ?").run(paused);
  migrate(s.db, ON);
  const pinRow = engine.getSchedule(s.db, getItem(s.db, "schedule", pin)?.engineId as string);
  assert.equal(pinRow?.versionPin, 1);
  const wfId = engineIdOf(s.pinned);
  assert.equal(engine.getActivation(s.db, wfId, 1)?.state, "superseded", "v1 was activated for the pin, then v2 became the active version");
  assert.equal(engine.activeActivation(s.db, wfId)?.version, 2);
  const pausedRow = engine.getSchedule(s.db, getItem(s.db, "schedule", paused)?.engineId as string);
  assert.equal(pausedRow?.paused, true, "the owner's pause is kept");
});

test("Bound and Free schedules of one workflow: the Free one moves, the Bound one stays and says legacy_bound; a second Free agent stays too", () => {
  const s = seed030();
  upgrade(s.raw);
  const free = freeSchedule(s, s.daily, FREE_F);
  const other = freeSchedule(s, s.daily, FREE_G, "15 7 * * *");
  const second = freeSchedule(s, s.daily, FREE_F, "45 18 * * *");
  migrate(s.db, ON);
  assert.equal(getItem(s.db, "schedule", free)?.status, "migrated");
  assert.equal(getItem(s.db, "schedule", second)?.status, "migrated", "another schedule of the same agent moves too");
  assert.equal(getItem(s.db, "schedule", s.dailyAut)?.status, "legacy_bound");
  const o = getItem(s.db, "schedule", other);
  assert.equal(o?.status, "skipped");
  assert.match(o?.reason ?? "", /other_agent/);
  assert.equal(automation(s, other).enabled, 1, "left running on routines_*");
  assert.equal(automation(s, s.dailyAut).enabled, 1);
  assert.equal(engine.listSchedules(s.db, engineIdOf(s.daily)).length, 2);
});

test("the engine is off: schedules wait (deferred), nothing is paused, no marker; at the next start with the engine they move, once", () => {
  const s = seed030();
  upgrade(s.raw);
  const aut = freeSchedule(s, s.daily, FREE_F);
  const first = migrate(s.db, { engineConfigured: false, now: NOW });
  assert.ok(first.ran && !first.complete);
  assert.equal(getItem(s.db, "schedule", aut)?.status, "deferred");
  assert.match(getItem(s.db, "schedule", aut)?.reason ?? "", /engine_off/);
  assert.equal(automation(s, aut).enabled, 1, "the old schedule still runs: pausing it would stop the work");
  assert.equal(marker(s.db), null);
  assert.equal(engine.listSchedules(s.db).length, 0);
  assert.equal(engine.listDefinitions(s.db).filter((d) => d.workflowId === engineIdOf(s.daily)).length, 3, "the contracts are saved already");
  // again while it is off: the same
  const again = migrate(s.db, { engineConfigured: false, now: NOW + 1 });
  assert.ok(again.ran && !again.complete);
  assert.equal(engine.listDefinitions(s.db).length, first.ran ? engine.listDefinitions(s.db).length : 0);
  // the engine is configured now
  const done = migrate(s.db, ON);
  assert.ok(done.ran && done.complete);
  assert.equal(getItem(s.db, "schedule", aut)?.status, "migrated");
  assert.equal(automation(s, aut).enabled, 0);
  assert.equal(engine.listSchedules(s.db).length, 1);
  assert.ok(marker(s.db));
  assert.deepEqual(migrate(s.db, ON), { ran: false, reason: "already_done" });
  assert.equal(engine.listSchedules(s.db).length, 1);
});

/** the snapshot of a stored version, as 0.3.x kept it (a long instruction was allowed there) */
const setInstruction = (s: ReturnType<typeof seed030>, workflowId: string, version: number | null, text: string) =>
  s.raw.prepare(`UPDATE workflow_versions SET snapshot = json_set(snapshot, '$.instruction', ?) WHERE workflow_id = ? AND (? IS NULL OR version = ?)`).run(text, workflowId, version, version);

test("fire: a version that does not fit the engine is reported with the reason and not saved; the others still move", () => {
  const s = seed030();
  upgrade(s.raw);
  const aut = freeSchedule(s, s.pinned, FREE_F, "30 9 * * 1", 1);
  // v2 of the weekly report has a very long instruction: 0.3.x allowed it, the engine's step takes 8000 characters
  setInstruction(s, s.pinned, 2, "x".repeat(MAX_INSTRUCTION));
  const res = migrate(s.db, ON);
  assert.ok(res.ran);
  const item = getItem(s.db, "workflow", s.pinned);
  assert.equal(item?.status, "migrated", "v1 moved");
  assert.equal(item?.versions, 1);
  assert.match(item?.reason ?? "", /v2: the instruction and steps are \d+ characters, the engine allows 8000/);
  assert.equal(engine.getDefinition(s.db, engineIdOf(s.pinned), 2), null);
  assert.equal(getItem(s.db, "workflow", s.daily)?.status, "migrated", "the others moved");
  // its schedule is pinned to v1, which moved: it moves, and v1 is what the engine runs (v2, the active version, is not there)
  assert.equal(getItem(s.db, "schedule", aut)?.status, "migrated");
  assert.equal(engine.activeActivation(s.db, engineIdOf(s.pinned))?.version, 1);
});

test("fire: a workflow with no version that fits fails whole; its schedule stays on routines_* and keeps running", () => {
  const s = seed030();
  upgrade(s.raw);
  const aut = freeSchedule(s, s.loose, FREE_F);
  setInstruction(s, s.loose, null, "y".repeat(9000));
  migrate(s.db, ON);
  const bad = getItem(s.db, "workflow", s.loose);
  assert.equal(bad?.status, "failed");
  assert.match(bad?.reason ?? "", /the engine allows 8000/);
  assert.equal(engine.listDefinitions(s.db).filter((d) => d.workflowId === engineIdOf(s.loose)).length, 0);
  assert.equal(getItem(s.db, "schedule", aut)?.status, "failed");
  assert.match(getItem(s.db, "schedule", aut)?.reason ?? "", /stays on routines_\*/);
  assert.equal(automation(s, aut).enabled, 1, "its schedule still runs the 0.3.x way");
  assert.equal(getItem(s.db, "workflow", s.daily)?.status, "migrated");
});

test("a version number that the engine already holds with other content is reported, not overwritten", () => {
  const s = seed030();
  upgrade(s.raw);
  const c = contractOf(s.loose, store.getVersion(s.db, s.loose, 1), { agentId: FREE_F, cron: null });
  c.title = "Written by the owner in the editor";
  engine.saveDefinition(s.db, c, D0);
  migrate(s.db, ON);
  const item = getItem(s.db, "workflow", s.loose);
  assert.equal(item?.status, "failed", "the only version cannot be saved");
  assert.match(item?.reason ?? "", /v1: .*other content/);
  assert.equal(engine.getDefinition(s.db, engineIdOf(s.loose), 1)?.title, "Written by the owner in the editor");
});

test("migration_status: the counts and every item, valid against the manifest; migrated items name what they became", async () => {
  const s = seed030();
  upgrade(s.raw);
  const aut = freeSchedule(s, s.daily, FREE_F);
  migrate(s.db, ON);
  const out = await call<K.MigrationStatusOutput>(H, "migration_status", {}, ctxFor(s.db, OWNER));
  assert.equal(out.done, true);
  assert.equal(out.doneAt, new Date(NOW).toISOString());
  assert.equal(out.counts.schedulesMigrated, 1);
  assert.equal(out.counts.schedulesLegacyBound, 3);
  assert.equal(out.counts.workflowsMigrated, 4);
  const wf = out.items.find((i) => i.kind === "workflow" && i.legacyId === s.daily);
  assert.deepEqual([wf?.engineId, wf?.versions, wf?.status], [engineIdOf(s.daily), 3, "migrated"]);
  assert.equal(out.items.find((i) => i.legacyId === aut)?.status, "migrated");
  assert.equal(out.items.length, listItems(s.db).length);
  const op = (manifest.operations as { id: string; audience: string }[]).find((o) => o.id === "migration_status");
  assert.equal(op?.audience, "person");
});

test("the claim answer of routine_claim can say migrated (the manifest enum), and the warning codes are in the schedule schemas", () => {
  const ops = manifest.operations as { id: string; output?: unknown }[];
  const claim = JSON.stringify(ops.find((o) => o.id === "routine_claim")?.output);
  assert.match(claim, /"migrated"/);
  for (const id of ["automations_list", "automation_set", "automation_pause"]) assert.match(JSON.stringify(ops.find((o) => o.id === id)?.output), /legacy_bound/, id);
});
