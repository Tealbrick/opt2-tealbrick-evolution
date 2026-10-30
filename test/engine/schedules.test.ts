// Schedules (ENGINE-BUILD §6) on a real local Temporal dev server: cron or interval + IANA time zone, overlap SKIP, catch-up
// window 1 h, pause / resume, run now, update, delete; the owner ops; the reconcile job. The time-skipping server has no
// schedules, so this file starts the local server (the test environment downloads it once).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TbError } from "@opt2-tealbrick/miniapp-sdk";
import { ScheduleOverlapPolicy } from "@temporalio/client";
import { manifest } from "../../src/app.ts";
import * as store from "../../src/engine/engine-store.ts";
import { engineHandlers } from "../../src/engine/ops.ts";
import { reconcile } from "../../src/engine/reconcile.ts";
import { everyMs, scheduleAction, scheduleIdOf, syncAndRecord, toScheduleSpec } from "../../src/engine/schedules.ts";
import { setTemporalClientForTests } from "../../src/engine/temporal.ts";
import { call, ctxFor, OWNER } from "../helpers.ts";
import { type Env, indexOf, read, scheduleListed, startEnv, waitFor, wf, workflowListed } from "./harness.ts";

let t: Env;
const H = engineHandlers(manifest as never) as unknown as Parameters<typeof call>[0];
const ctx = () => ctxFor(t.db, OWNER);
const op = <O>(id: string, input: unknown): Promise<O> => call<O>(H, id, input, ctx());
interface Sched {
  id: string;
  revision: number;
  paused: boolean;
  timezone: string;
  cron: string | null;
  every: string | null;
  temporalState: string;
  live: { state: string; paused: boolean | null; nextRunAt: string | null; timezone: string | null } | null;
}

before(async () => {
  t = await startEnv({ local: true });
  t.apps.on["knowledge.recall"] = () => ({});
});
after(async () => {
  await t.stop();
});

let n = 0;
function install(extra: Record<string, unknown> = {}, steps: unknown[] = [read("a")]): string {
  const id = `sched-flow-${++n}`;
  t.install(wf(steps, { id, ...extra }));
  return id;
}

test("mapping: cron or interval, always with the IANA time zone; overlap SKIP and the one-hour catch-up window in the policy", () => {
  assert.deepEqual(toScheduleSpec({ cron: "0 8 * * *", timezone: "Asia/Bangkok" }), { cronExpressions: ["0 8 * * *"], timezone: "Asia/Bangkok" });
  assert.deepEqual(toScheduleSpec({ every: "15m", timezone: "Europe/Prague" }), { intervals: [{ every: 900_000 }], timezone: "Europe/Prague" });
  assert.equal(everyMs("6h"), 21_600_000);
  assert.equal(everyMs("1d"), 86_400_000);
  assert.throws(() => everyMs("0m"));
  assert.throws(() => everyMs("5s"));
  assert.throws(() => toScheduleSpec({ timezone: "UTC" }));
  // the action carries the workflow id, the pin, the trigger and the input, NEVER the steps
  const row = { id: "sch_abc", workflowId: "daily-x", versionPin: null, kind: "schedule", spec: { cron: "0 8 * * *", timezone: "Asia/Bangkok" }, input: { account: "a" } } as unknown as store.ScheduleRow;
  const action = scheduleAction(row) as { workflowType: string; taskQueue: string; workflowId: string; args: unknown[] };
  assert.deepEqual([action.workflowType, action.taskQueue, action.workflowId], ["evolutionRun", "evolution", "evo:daily-x:sch_abc"]);
  assert.deepEqual(action.args, [{ workflowId: "daily-x", version: null, runId: "", trigger: { kind: "schedule", timezone: "Asia/Bangkok", input: { account: "a" }, scheduleId: "sch_abc" } }]);
  assert.doesNotMatch(JSON.stringify(action), /"steps"/);
  assert.equal(scheduleIdOf("sch_abc"), "evo-sched:sch_abc");
});

test("schedule_set: Temporal gets the cron, the time zone, overlap SKIP and a one-hour catch-up window; 08:00 in Bangkok is 01:00 UTC", { timeout: 180_000 }, async () => {
  const id = install();
  const s = await op<Sched>("schedule_set", { workflowId: id, cron: "0 8 * * *", timezone: "Asia/Bangkok" });
  assert.equal(s.temporalState, "synced");
  assert.equal(s.live?.state, "ok");
  assert.equal(s.live?.timezone, "Asia/Bangkok");
  assert.match(s.live?.nextRunAt ?? "", /T01:00:00\.000Z$/);
  const d = await t.client.schedule.getHandle(scheduleIdOf(s.id)).describe();
  assert.equal(d.policies.overlap, ScheduleOverlapPolicy.SKIP);
  assert.equal(d.policies.catchupWindow, 3_600_000);
  assert.equal(d.state.paused, false);
  assert.equal(d.spec.timezone, "Asia/Bangkok");
  // another zone shifts the instant
  const u = await op<Sched>("schedule_set", { id: s.id, revision: s.revision, workflowId: id, cron: "0 8 * * *", timezone: "Europe/Prague" });
  assert.match(u.live?.nextRunAt ?? "", /T0[67]:00:00\.000Z$/);
  assert.equal(u.revision, s.revision + 1);
  assert.equal(u.live?.timezone, "Europe/Prague");
  assert.equal((await t.client.schedule.getHandle(scheduleIdOf(s.id)).describe()).spec.timezone, "Europe/Prague");
  // a stale revision is a conflict, a wrong zone or cron a validation error
  await assert.rejects(op("schedule_set", { id: s.id, revision: s.revision, workflowId: id, cron: "0 9 * * *", timezone: "UTC" }), (e: unknown) => e instanceof TbError && e.code === "revision_conflict" && e.httpStatus === 409);
  await assert.rejects(op("schedule_set", { workflowId: id, cron: "0 8 * * *", timezone: "Mars/Base" }), (e: unknown) => e instanceof TbError && e.code === "validation_failed");
  await assert.rejects(op("schedule_set", { workflowId: id, cron: "61 8 * * *", timezone: "UTC" }), (e: unknown) => e instanceof TbError && e.code === "validation_failed");
  await assert.rejects(op("schedule_set", { workflowId: id, cron: "0 8 * * *", every: "5m", timezone: "UTC" }), (e: unknown) => e instanceof TbError && e.code === "validation_failed");
  await assert.rejects(op("schedule_set", { workflowId: "never-installed", cron: "0 8 * * *", timezone: "UTC" }), (e: unknown) => e instanceof TbError && e.code === "not_activated" && e.httpStatus === 409);
});

test("schedule_set takes the schedule from the contract's trigger and the input defaults; the input must fit the workflow inputs", { timeout: 180_000 }, async () => {
  const id = install({ inputs: { type: "object", required: ["account"], properties: { account: { type: "string" } } }, triggers: [{ kind: "schedule", every: "6h", timezone: "Asia/Bangkok", input: { account: "acc1" } }] });
  const s = await op<Sched & { input: Record<string, unknown> }>("schedule_set", { workflowId: id });
  assert.equal(s.every, "6h");
  assert.equal(s.timezone, "Asia/Bangkok");
  assert.deepEqual(s.input, { account: "acc1" });
  await assert.rejects(op("schedule_set", { workflowId: id, input: { account: 5 } }), (e: unknown) => e instanceof TbError && e.code === "validation_failed");
});

test("pause and resume, run now, delete; the list shows the live state", { timeout: 180_000 }, async () => {
  const id = install();
  const s = await op<Sched>("schedule_set", { workflowId: id, cron: "0 3 * * *", timezone: "UTC" });
  const p = await op<Sched>("schedule_pause", { id: s.id, revision: s.revision, paused: true });
  assert.equal(p.paused, true);
  assert.equal(p.live?.paused, true);
  assert.equal((await t.client.schedule.getHandle(scheduleIdOf(s.id)).describe()).state.paused, true);
  const r = await op<Sched>("schedule_pause", { id: s.id, revision: p.revision, paused: false });
  assert.equal(r.live?.paused, false);
  await assert.rejects(op("schedule_pause", { id: s.id, revision: s.revision, paused: true }), (e: unknown) => e instanceof TbError && e.code === "revision_conflict");

  t.apps.calls.length = 0;
  const run = await op<{ triggered: boolean; runId: string; workflowId: string }>("schedule_run_now", { id: s.id });
  assert.equal(run.triggered, true);
  assert.equal(run.workflowId, id);
  assert.match(run.runId, new RegExp(`^${s.id}-rn[0-9a-f]{20}$`), "F-G6: the answer names the run that was started");
  await waitFor("the run of the schedule is completed in the index", () => t.db.prepare("SELECT status FROM engine_runs WHERE workflow_id = ? AND status = 'completed'").get(id) !== undefined);
  const row = t.db.prepare("SELECT * FROM engine_runs WHERE workflow_id = ?").get(id) as Record<string, unknown>;
  assert.equal(row.status, "completed");
  assert.equal(row.run_id, run.runId, "the index row is the run the answer named");
  assert.equal(row.schedule_id, s.id);
  assert.equal(row.trigger_kind, "schedule");
  assert.equal(row.temporal_workflow_id, `evo:${id}:${run.runId}`);
  assert.match(t.apps.calls[0]?.key ?? "", new RegExp(`^wfrun:${id}:${s.id}-`));

  // a run now is started directly, so the list takes its last run from the run index
  await waitFor("schedules_list shows the live state ok and the run (lastRunAt)", async () => {
    const list = await op<{ schedules: Sched[]; temporalConnected: boolean }>("schedules_list", { workflowId: id });
    assert.equal(list.temporalConnected, true);
    assert.equal(list.schedules[0]?.live?.state, "ok");
    assert.ok((list.schedules[0]?.live as unknown as { lastRunAt: string } | null)?.lastRunAt, "the run is in the schedule's recent actions");
  });

  await assert.rejects(op("schedule_delete", { id: s.id, revision: s.revision }), (e: unknown) => e instanceof TbError && e.code === "revision_conflict");
  const del = await op<{ deleted: boolean }>("schedule_delete", { id: s.id, revision: r.revision });
  assert.equal(del.deleted, true);
  assert.equal(store.getSchedule(t.db, s.id), null);
  await assert.rejects(t.client.schedule.getHandle(scheduleIdOf(s.id)).describe(), /not found|NotFound/i);
  await assert.rejects(op("schedule_run_now", { id: s.id }), (e: unknown) => e instanceof TbError && e.code === "not_found");
});

test("a poll schedule is built from the contract's poll trigger: the run stops early when the cursor did not change", { timeout: 180_000 }, async () => {
  const id = install({ triggers: [{ kind: "poll", product: "knowledge", op: "recall", input: { query: "inbox" }, cursorPath: "/cursor", every: "5m" }] });
  const s = await op<Sched & { kind: string; poll: { cursorPath: string } | null }>("schedule_set", { workflowId: id, kind: "poll", timezone: "UTC" });
  assert.equal(s.kind, "poll");
  assert.equal(s.every, "5m");
  assert.equal(s.poll?.cursorPath, "/cursor");
  t.apps.on["knowledge.recall"] = () => ({ cursor: "c1" });
  const first = await op<{ runId: string }>("schedule_run_now", { id: s.id });
  await waitFor("the first poll run is in the index", () => (t.db.prepare("SELECT count(*) AS c FROM engine_runs WHERE workflow_id = ?").get(id)?.c as number) === 1);
  await t.client.workflow.getHandle(`evo:${id}:${first.runId}`).result();
  const before = t.apps.calls.filter((c) => c.op === "recall" && (c.input as { query: string }).query === "inbox").length;
  const second = await op<{ runId: string }>("schedule_run_now", { id: s.id });
  assert.notEqual(second.runId, first.runId);
  const res = (await t.client.workflow.getHandle(`evo:${id}:${second.runId}`).result()) as { status: string };
  assert.ok(t.apps.calls.filter((c) => c.op === "recall" && (c.input as { query: string }).query === "inbox").length > before, "the second poll ran (the recall call arrived)");
  assert.equal(res.status, "skipped");
  assert.equal(t.db.prepare("SELECT count(*) AS c FROM engine_runs WHERE workflow_id = ?").get(id)?.c, 1, "the second poll saw the same cursor: no run");
  assert.equal(store.getSchedule(t.db, s.id)?.cursor, "c1");
  t.apps.on["knowledge.recall"] = () => ({});
  await assert.rejects(op("schedule_set", { workflowId: install(), kind: "poll", timezone: "UTC" }), (e: unknown) => e instanceof TbError && e.code === "validation_failed", "a workflow without a poll trigger has no poll schedule");
});

test("workflow_deactivate pauses the schedules of the workflow", { timeout: 180_000 }, async () => {
  const id = install();
  const s = await op<Sched>("schedule_set", { workflowId: id, cron: "0 3 * * *", timezone: "UTC" });
  const d = await op<{ schedulesPaused: number; deactivatedVersions: number[] }>("workflow_deactivate", { workflowId: id });
  assert.deepEqual([d.schedulesPaused, d.deactivatedVersions], [1, [1]]);
  assert.equal((await t.client.schedule.getHandle(scheduleIdOf(s.id)).describe()).state.paused, true);
  assert.equal(store.getSchedule(t.db, s.id)?.paused, true);
  await assert.rejects(op("schedule_run_now", { id: s.id }), (e: unknown) => e instanceof TbError && e.code === "not_activated");
});

test("Temporal down: the owner ops still save the row (pending), the list says unreachable, and the reconcile job creates the schedule later", { timeout: 180_000 }, async () => {
  const id = install();
  setTemporalClientForTests(null);
  const prevAddress = process.env.TEMPORAL_ADDRESS;
  delete process.env.TEMPORAL_ADDRESS;
  let s: Sched;
  try {
    s = await op<Sched>("schedule_set", { workflowId: id, cron: "0 4 * * *", timezone: "UTC" });
    assert.equal(s.temporalState, "pending");
    assert.equal(s.live?.state, "unreachable");
    const list = await op<{ temporalConnected: boolean }>("schedules_list", {});
    assert.equal(list.temporalConnected, false);
    await assert.rejects(op("schedule_run_now", { id: s.id }), (e: unknown) => e instanceof TbError && e.code === "temporal_unavailable" && e.httpStatus === 503);
    await assert.rejects(op("schedule_delete", { id: s.id, revision: s.revision }), (e: unknown) => e instanceof TbError && e.code === "temporal_unavailable");
  } finally {
    setTemporalClientForTests(t.env.client);
    if (prevAddress !== undefined) process.env.TEMPORAL_ADDRESS = prevAddress;
  }
  const r = await reconcile(t.db, t.client);
  assert.ok(r.schedulesCreated >= 1);
  assert.equal(store.getSchedule(t.db, s.id)?.temporalState, "synced");
  assert.equal((await t.client.schedule.getHandle(scheduleIdOf(s.id)).describe()).spec.timezone, "UTC");
});

test("reconcile: Temporal wins. It closes runs the index still shows running, adds runs the index lacks, ignores skipped polls, deletes orphan schedules", { timeout: 180_000 }, async () => {
  const id = install();
  // 1. a run that finished in Temporal while the index says running (the activity never wrote the end)
  const done = await t.run({ workflowId: id, runId: "run_rec1" });
  assert.equal(done.status, "completed");
  t.db.prepare("UPDATE engine_runs SET status = 'running', ended_at = NULL WHERE workflow_id = ? AND run_id = ?").run(id, "run_rec1");
  // 2. a run Temporal has and the index lacks
  await t.run({ workflowId: id, runId: "run_rec2" });
  t.db.prepare("DELETE FROM engine_runs WHERE workflow_id = ? AND run_id = ?").run(id, "run_rec2");
  // 3. a run in the index that Temporal has never heard of
  t.db.prepare("INSERT INTO engine_runs (workflow_id, run_id, version, temporal_workflow_id, trigger_kind, status, started_at, updated_at) VALUES (?, 'run_ghost', 1, ?, 'manual', 'running', 1, 1)").run(id, `evo:${id}:run_ghost`);
  // 4. a poll that found no change leaves no row and must not come back as one
  const pid = install({ triggers: [{ kind: "poll", product: "knowledge", op: "recall", input: { query: "inbox" }, cursorPath: "/cursor", every: "5m" }] });
  t.db.prepare("INSERT INTO engine_schedules (id, workflow_id, kind, spec, input, poll, paused, revision, cursor, created_at, updated_at) VALUES ('sch_rp', ?, 'poll', '{\"every\":\"5m\",\"timezone\":\"UTC\"}', '{}', ?, 0, 1, 'same', 1, 1)").run(pid, JSON.stringify({ product: "knowledge", op: "recall", input: { query: "inbox" }, cursorPath: "/cursor" }));
  t.apps.on["knowledge.recall"] = () => ({ cursor: "same" });
  const skipped = await t.run({ workflowId: pid, runId: "run_skip", trigger: { kind: "poll", scheduleId: "sch_rp", timezone: "UTC", input: {} } });
  assert.equal(skipped.status, "skipped");
  // 5. an orphan Temporal schedule
  await t.client.schedule.create({ scheduleId: "evo-sched:sch_orphan", spec: { intervals: [{ every: 3_600_000 }] }, action: { type: "startWorkflow", workflowType: "evolutionRun", taskQueue: "evolution", args: [] }, state: { paused: true } });
  t.apps.on["knowledge.recall"] = () => ({});
  // Visibility (schedule.list, workflow.list) is eventually consistent. reconcile() reads those lists, so a pass cannot see an
  // orphan or a run before the list shows it; it sees it on the next pass (every 10 min). The test therefore waits until the
  // lists show what it created and THEN asserts the pass deletes and adds it: honest about the list, no sleep. The "missed once,
  // caught on the next pass" behaviour has its own deterministic test below.
  await waitFor("the Temporal schedule list shows the orphan schedule", () => scheduleListed(t.client, "evo-sched:sch_orphan"));
  await waitFor("the Temporal workflow list shows run_rec2 (the run the index lacks)", () => workflowListed(t.client, `evo:${id}:run_rec2`));
  // run_skip was started last: visibility writes are queued in order, so every older workflow is listed too, and the second pass below cannot find a late one
  await waitFor("the Temporal workflow list shows run_skip (the poll that changed nothing, which must stay out of the index)", () => workflowListed(t.client, `evo:${pid}:run_skip`));

  const r = await reconcile(t.db, t.client, { boot: true });
  assert.ok(r.closed >= 1 && r.inserted >= 1 && r.lost === 1 && r.schedulesOrphaned >= 1, JSON.stringify(r));
  assert.equal(indexOf(t.db, id, "run_rec1").run?.status, "completed");
  assert.ok(indexOf(t.db, id, "run_rec1").run?.ended_at);
  const added = indexOf(t.db, id, "run_rec2").run;
  assert.deepEqual([added?.status, added?.source], ["completed", "reconcile"]);
  const ghost = indexOf(t.db, id, "run_ghost").run;
  assert.deepEqual([ghost?.status, ghost?.error_code], ["terminated", "temporal_lost"]);
  assert.equal(indexOf(t.db, pid, "run_skip").run, undefined, "a skipped poll stays out of the index");
  await assert.rejects(t.client.schedule.getHandle("evo-sched:sch_orphan").describe(), /not found|NotFound/i);
  // a second pass changes nothing
  const again = await reconcile(t.db, t.client);
  assert.deepEqual([again.closed, again.inserted, again.lost, again.schedulesOrphaned], [0, 0, 0, 0]);
});

/** A client whose schedule LIST is served by `listing` (the real getHandle / create / describe stay consistent, as in Temporal). */
function withScheduleList(client: Env["client"], listing: () => AsyncIterable<{ scheduleId: string }>): Env["client"] {
  const schedule = new Proxy(client.schedule, {
    get(target, prop) {
      if (prop === "list") return listing;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return Object.create(client, { schedule: { value: schedule } }) as Env["client"];
}
const ORPHAN_ACTION = { type: "startWorkflow" as const, workflowType: "evolutionRun", taskQueue: "evolution", args: [] };

test("reconcile with a schedule list that lags (visibility): the orphan is missed ONCE without an error and deleted on the next pass", { timeout: 180_000 }, async () => {
  await t.client.schedule.create({ scheduleId: "evo-sched:sch_late", spec: { intervals: [{ every: 3_600_000 }] }, action: ORPHAN_ACTION, state: { paused: true } });
  const lagging = withScheduleList(t.client, async function* () {}); // the list does not show the new schedule yet
  const first = await reconcile(t.db, lagging);
  assert.equal(first.schedulesOrphaned, 0, "a list that does not show the orphan cannot delete it");
  assert.equal(first.errors, 0, "and that is not an error");
  assert.equal((await t.client.schedule.getHandle("evo-sched:sch_late").describe()).state.paused, true, "the orphan is still there");
  await waitFor("the Temporal schedule list shows the orphan schedule", () => scheduleListed(t.client, "evo-sched:sch_late"));
  const second = await reconcile(t.db, t.client);
  assert.equal(second.schedulesOrphaned, 1, "the next pass sees it and deletes it");
  await assert.rejects(t.client.schedule.getHandle("evo-sched:sch_late").describe(), /not found|NotFound/i);
});

test("reconcile never deletes a schedule whose row appeared while the pass was listing (schedule_set racing the pass)", { timeout: 180_000 }, async () => {
  const id = install();
  await t.client.schedule.create({ scheduleId: "evo-sched:sch_race", spec: { intervals: [{ every: 3_600_000 }] }, action: ORPHAN_ACTION, state: { paused: true } });
  const racing = withScheduleList(t.client, async function* () {
    // schedule_set inserts its row after the pass read the owned ids and before the list returns the new schedule
    t.db.prepare("INSERT INTO engine_schedules (id, workflow_id, kind, spec, input, poll, paused, revision, cursor, created_at, updated_at) VALUES ('sch_race', ?, 'schedule', '{\"cron\":\"0 3 * * *\",\"timezone\":\"UTC\"}', '{}', NULL, 1, 1, NULL, 1, 1)").run(id);
    yield { scheduleId: "evo-sched:sch_race" };
  });
  const r = await reconcile(t.db, racing);
  assert.equal(r.schedulesOrphaned, 0, "the row exists: not an orphan");
  assert.equal((await t.client.schedule.getHandle("evo-sched:sch_race").describe()).state.paused, true, "the schedule survived the pass");
  await t.client.schedule.getHandle("evo-sched:sch_race").delete(); // own clean-up; the row stays out of the way of later passes
  t.db.prepare("DELETE FROM engine_schedules WHERE id = 'sch_race'").run();
});

test("reconcile records the failure code of a run that failed in Temporal but never reached finishRun", { timeout: 180_000 }, async () => {
  const id = install({ inputs: { type: "object", properties: { at: { type: "string" } } } }, [{ id: "boom", type: "timer", until: "$trigger.input.at" }]);
  await assert.rejects(t.run({ workflowId: id, runId: "run_boom", trigger: { kind: "manual", input: { at: "never" } } }));
  t.db.prepare("UPDATE engine_runs SET status = 'running', ended_at = NULL, error_code = NULL WHERE workflow_id = ? AND run_id = ?").run(id, "run_boom");
  await reconcile(t.db, t.client);
  const run = indexOf(t.db, id, "run_boom").run;
  assert.deepEqual([run?.status, run?.error_code], ["failed", "timer_until_invalid"]);
});

// ───────────────────────────── review fixes F3, F6 ─────────────────────────────

test("F3: a schedule may pin the ACTIVE version only; a replaced version starts nothing, also from a schedule", { timeout: 180_000 }, async () => {
  const id = install();
  t.install(wf([read("a")], { id, version: 2, title: "v2" }));
  await assert.rejects(op("schedule_set", { workflowId: id, versionPin: 1, cron: "0 3 * * *", timezone: "UTC" }), (e: unknown) => e instanceof TbError && e.code === "not_activated" && e.httpStatus === 409);
  const pinned = await op<Sched>("schedule_set", { workflowId: id, versionPin: 2, cron: "0 3 * * *", timezone: "UTC" });
  assert.equal(pinned.live?.state, "ok");
  // a schedule row that still pins the old version (made before the fix, or a restore) fails its run, not silently
  const stale = await op<Sched>("schedule_set", { workflowId: id, cron: "0 4 * * *", timezone: "UTC" });
  t.db.prepare("UPDATE engine_schedules SET version_pin = 1 WHERE id = ?").run(stale.id);
  await syncAndRecord(t.db, t.client, store.getSchedule(t.db, stale.id) as store.ScheduleRow, Date.now());
  await op("schedule_run_now", { id: stale.id });
  let wid = "";
  await waitFor("the workflow list shows the run started by the stale schedule", async () => {
    for await (const w of t.client.workflow.list({ query: `WorkflowId STARTS_WITH "evo:${id}:${stale.id}"` })) wid = w.workflowId;
    return wid !== "";
  });
  const err = await t.client.workflow.getHandle(wid).result().then(
    () => null,
    (e: unknown) => e as { cause?: { type?: string } },
  );
  assert.equal(err?.cause?.type, "version_not_active", "the run of the replaced version is refused at its start");
  assert.equal(t.db.prepare("SELECT count(*) AS c FROM engine_runs WHERE workflow_id = ? AND schedule_id = ?").get(id, stale.id)?.c, 0);
});

test("F6: activating a newer version checks the schedules again: one that still fits follows it, one that does not is paused and stale with the reason; a pin on the old version is stale", { timeout: 180_000 }, async () => {
  const id = `f6-flow-${++n}`;
  t.install(wf([read("a")], { id, version: 1, inputs: { type: "object", properties: { account: { type: "string" } } }, triggers: [{ kind: "manual" }, { kind: "schedule", cron: "0 8 * * *", timezone: "UTC" }] }));
  const follows = await op<Sched & { input: Record<string, unknown> }>("schedule_set", { workflowId: id, input: { account: "acc1" } });
  const second = await op<Sched>("schedule_set", { workflowId: id, cron: "0 9 * * *", timezone: "UTC", input: { account: "acc2" } });
  const pinned = await op<Sched>("schedule_set", { workflowId: id, versionPin: 1, cron: "0 10 * * *", timezone: "UTC", input: { account: "acc3" } });
  // v2 changes the inputs: `region` is now required and the schedules do not give it; the account field keeps its type
  await call(H, "workflow_contract_save", { contract: wf([read("a")], { id, version: 2, inputs: { type: "object", required: ["region"], additionalProperties: false, properties: { account: { type: "string" }, region: { type: "string" } } }, triggers: [{ kind: "manual" }, { kind: "schedule", cron: "0 8 * * *", timezone: "UTC" }] }) }, ctx());
  const act = await op<{ staleSchedules: { id: string; reason: string }[] }>("workflow_activate", { workflowId: id, version: 2 });
  assert.deepEqual(act.staleSchedules.map((x) => x.id).sort(), [follows.id, second.id, pinned.id].sort());
  const reasonOf = (sid: string) => act.staleSchedules.find((x) => x.id === sid)?.reason ?? "";
  assert.match(reasonOf(follows.id), /region/);
  assert.match(reasonOf(pinned.id), /not the active version/);
  for (const s of [follows, second, pinned]) {
    const row = store.getSchedule(t.db, s.id);
    assert.equal(row?.paused, true, "a stale schedule is paused");
    assert.ok(row?.staleReason);
    assert.equal((await t.client.schedule.getHandle(scheduleIdOf(s.id)).describe()).state.paused, true, "also in Temporal");
  }
  const list = await op<{ schedules: (Sched & { stale: string | null })[] }>("schedules_list", { workflowId: id });
  assert.ok(list.schedules.every((s) => s.stale));
  // the owner edits it: it fits again, the stale flag goes (it stays paused until resumed)
  const fixed = await op<Sched & { stale: string | null }>("schedule_set", { id: follows.id, revision: store.getSchedule(t.db, follows.id)?.revision, workflowId: id, input: { account: "acc1", region: "eu" } });
  assert.equal(fixed.stale, null);
  assert.equal(fixed.paused, true);
  // v3 is compatible: a schedule that fits follows it and is NOT stale
  await call(H, "workflow_contract_save", { contract: wf([read("a")], { id, version: 3, inputs: { type: "object", additionalProperties: false, properties: { account: { type: "string" }, region: { type: "string" } } }, triggers: [{ kind: "manual" }, { kind: "schedule", cron: "0 8 * * *", timezone: "UTC" }] }) }, ctx());
  const act3 = await op<{ staleSchedules: { id: string }[] }>("workflow_activate", { workflowId: id, version: 3 });
  assert.ok(!act3.staleSchedules.some((x) => x.id === follows.id), "it still fits");
  assert.equal(store.getSchedule(t.db, follows.id)?.staleReason, null);
});
