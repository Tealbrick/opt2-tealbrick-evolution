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
import { everyMs, scheduleAction, scheduleIdOf, toScheduleSpec } from "../../src/engine/schedules.ts";
import { setTemporalClientForTests } from "../../src/engine/temporal.ts";
import { call, ctxFor, OWNER } from "../helpers.ts";
import { type Env, indexOf, read, startEnv, wf } from "./harness.ts";

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
async function waitFor(cond: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > until) assert.fail("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
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

test("schedule_set: Temporal gets the cron, the time zone, overlap SKIP and a one-hour catch-up window; 08:00 in Bangkok is 01:00 UTC", async () => {
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

test("schedule_set takes the schedule from the contract's trigger and the input defaults; the input must fit the workflow inputs", async () => {
  const id = install({ inputs: { type: "object", required: ["account"], properties: { account: { type: "string" } } }, triggers: [{ kind: "schedule", every: "6h", timezone: "Asia/Bangkok", input: { account: "acc1" } }] });
  const s = await op<Sched & { input: Record<string, unknown> }>("schedule_set", { workflowId: id });
  assert.equal(s.every, "6h");
  assert.equal(s.timezone, "Asia/Bangkok");
  assert.deepEqual(s.input, { account: "acc1" });
  await assert.rejects(op("schedule_set", { workflowId: id, input: { account: 5 } }), (e: unknown) => e instanceof TbError && e.code === "validation_failed");
});

test("pause and resume, run now, delete; the list shows the live state", async () => {
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
  const run = await op<{ triggered: boolean }>("schedule_run_now", { id: s.id });
  assert.equal(run.triggered, true);
  await waitFor(() => (indexOf(t.db, id, "x").run ?? t.db.prepare("SELECT status FROM engine_runs WHERE workflow_id = ? AND status = 'completed'").get(id)) !== undefined);
  const row = t.db.prepare("SELECT * FROM engine_runs WHERE workflow_id = ?").get(id) as Record<string, unknown>;
  assert.equal(row.status, "completed");
  assert.equal(row.schedule_id, s.id);
  assert.equal(row.trigger_kind, "schedule");
  assert.match(String(row.temporal_workflow_id), new RegExp(`^evo:${id}:${s.id}-`), "the Schedule start id is evo:<workflow>:<schedule>-<time>");
  assert.match(String(row.run_id), new RegExp(`^${s.id}-`));
  assert.match(t.apps.calls[0]?.key ?? "", new RegExp(`^wfrun:${id}:${s.id}-`));

  const list = await op<{ schedules: Sched[]; temporalConnected: boolean }>("schedules_list", { workflowId: id });
  assert.equal(list.temporalConnected, true);
  assert.equal(list.schedules[0]?.live?.state, "ok");
  assert.ok((list.schedules[0]?.live as unknown as { lastRunAt: string } | null)?.lastRunAt, "the run is in the schedule's recent actions");

  await assert.rejects(op("schedule_delete", { id: s.id, revision: s.revision }), (e: unknown) => e instanceof TbError && e.code === "revision_conflict");
  const del = await op<{ deleted: boolean }>("schedule_delete", { id: s.id, revision: r.revision });
  assert.equal(del.deleted, true);
  assert.equal(store.getSchedule(t.db, s.id), null);
  await assert.rejects(t.client.schedule.getHandle(scheduleIdOf(s.id)).describe(), /not found|NotFound/i);
  await assert.rejects(op("schedule_run_now", { id: s.id }), (e: unknown) => e instanceof TbError && e.code === "not_found");
});

test("a poll schedule is built from the contract's poll trigger: the run stops early when the cursor did not change", async () => {
  const id = install({ triggers: [{ kind: "poll", product: "knowledge", op: "recall", input: { query: "inbox" }, cursorPath: "/cursor", every: "5m" }] });
  const s = await op<Sched & { kind: string; poll: { cursorPath: string } | null }>("schedule_set", { workflowId: id, kind: "poll", timezone: "UTC" });
  assert.equal(s.kind, "poll");
  assert.equal(s.every, "5m");
  assert.equal(s.poll?.cursorPath, "/cursor");
  t.apps.on["knowledge.recall"] = () => ({ cursor: "c1" });
  await op("schedule_run_now", { id: s.id });
  await waitFor(() => (t.db.prepare("SELECT count(*) AS c FROM engine_runs WHERE workflow_id = ?").get(id)?.c as number) === 1);
  await op("schedule_run_now", { id: s.id });
  await new Promise((r) => setTimeout(r, 1500));
  await waitFor(() => t.apps.calls.filter((c) => c.op === "recall" && (c.input as { query: string }).query === "inbox").length >= 2);
  assert.equal(t.db.prepare("SELECT count(*) AS c FROM engine_runs WHERE workflow_id = ?").get(id)?.c, 1, "the second poll saw the same cursor: no run");
  assert.equal(store.getSchedule(t.db, s.id)?.cursor, "c1");
  t.apps.on["knowledge.recall"] = () => ({});
  await assert.rejects(op("schedule_set", { workflowId: install(), kind: "poll", timezone: "UTC" }), (e: unknown) => e instanceof TbError && e.code === "validation_failed", "a workflow without a poll trigger has no poll schedule");
});

test("workflow_deactivate pauses the schedules of the workflow", async () => {
  const id = install();
  const s = await op<Sched>("schedule_set", { workflowId: id, cron: "0 3 * * *", timezone: "UTC" });
  const d = await op<{ schedulesPaused: number; deactivatedVersions: number[] }>("workflow_deactivate", { workflowId: id });
  assert.deepEqual([d.schedulesPaused, d.deactivatedVersions], [1, [1]]);
  assert.equal((await t.client.schedule.getHandle(scheduleIdOf(s.id)).describe()).state.paused, true);
  assert.equal(store.getSchedule(t.db, s.id)?.paused, true);
  await assert.rejects(op("schedule_run_now", { id: s.id }), (e: unknown) => e instanceof TbError && e.code === "not_activated");
});

test("Temporal down: the owner ops still save the row (pending), the list says unreachable, and the reconcile job creates the schedule later", async () => {
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

test("reconcile: Temporal wins. It closes runs the index still shows running, adds runs the index lacks, ignores skipped polls, deletes orphan schedules", async () => {
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

test("reconcile records the failure code of a run that failed in Temporal but never reached finishRun", async () => {
  const id = install({ inputs: { type: "object", properties: { at: { type: "string" } } } }, [{ id: "boom", type: "timer", until: "$trigger.input.at" }]);
  await assert.rejects(t.run({ workflowId: id, runId: "run_boom", trigger: { kind: "manual", input: { at: "never" } } }));
  t.db.prepare("UPDATE engine_runs SET status = 'running', ended_at = NULL, error_code = NULL WHERE workflow_id = ? AND run_id = ?").run(id, "run_boom");
  await reconcile(t.db, t.client);
  const run = indexOf(t.db, id, "run_boom").run;
  assert.deepEqual([run?.status, run?.error_code], ["failed", "timer_until_invalid"]);
});
