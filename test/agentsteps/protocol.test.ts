// Agent steps (C367 WP3, ENGINE-BUILD §5): offer, due, claim, heartbeat, report against a fake Temporal activity client.
// Every rule has a quiet-on-good half and a fire-on-bad half.
import assert from "node:assert/strict";
import { test } from "node:test";
import type * as K from "#kit";
import * as steps from "../../src/agentsteps/store.ts";
import { CONTENT_ONLY_NOTE } from "../../src/agentsteps/types.ts";
import { manifest } from "../../src/app.ts";
import * as directory from "../../src/directory.ts";
import { OWNER } from "../helpers.ts";
import { BOUND_C, b64, FREE_A, FREE_B, GOOD_OUTPUT, refused, rig, SCHEMA, T0 } from "./support.ts";

const DUE = (r: ReturnType<typeof rig>, who = FREE_A) => r.run<K.StepsDueOutput>("steps_due", {}, who);

test("a Free agent is offered only its own steps, claims one, and gets the content-only answer", async () => {
  const r = rig();
  const mine = await r.offer();
  const theirs = await r.offer({ agentId: FREE_B.id });
  const due = await DUE(r);
  assert.deepEqual(due.steps, [{ stepRunId: mine.stepRunId, workflowTitle: "Daily email summary", deadline: new Date(T0 + 900_000).toISOString() }]);
  assert.deepEqual((await DUE(r, FREE_B)).steps.map((s) => s.stepRunId), [theirs.stepRunId]);

  const c = await r.run<K.StepClaimOutput>("step_claim", { stepRunId: mine.stepRunId });
  assert.equal(c.claimed, true);
  assert.equal(c.reason, null);
  const step = c.step;
  assert.ok(step);
  assert.equal(step.mode, "content");
  assert.equal(step.note, "Return the output only. Do not act.");
  assert.equal(step.note, CONTENT_ONLY_NOTE);
  assert.equal(step.instruction, mine.instruction);
  assert.deepEqual(step.inputs, mine.inputs);
  assert.deepEqual(step.outputSchema, SCHEMA);
  assert.equal(step.heartbeatSec, 60);
  assert.equal(step.attempt, 1);
  assert.equal(step.deadline, new Date(T0 + 900_000).toISOString());
  // the version's reviewed operations are guidance only
  assert.deepEqual(step.allowedHint, [{ product: "knowledge", operations: ["recall"], crud: ["read"] }]);
  // claiming counts as the first heartbeat to Temporal
  assert.equal(r.temporal.count("heartbeat"), 1);
  // a claimed step is no longer offered
  assert.deepEqual((await DUE(r)).steps, []);
});

test("another Free agent cannot claim, heartbeat or report a step that is not offered to it, and learns nothing", async () => {
  const r = rig();
  const o = await r.offer();
  const c = await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId }, FREE_B);
  assert.deepEqual([c.claimed, c.reason, c.step], [false, "not_found", null]);
  assert.equal(steps.getRow(r.db, o.stepRunId)?.status, "offered", "the step is untouched");
  assert.equal(r.temporal.count("heartbeat"), 0, "Temporal was not called");
  // and an unknown id looks the same
  const none = await r.run<K.StepClaimOutput>("step_claim", { stepRunId: "asr_nope" });
  assert.deepEqual([none.claimed, none.reason], [false, "not_found"]);
  // once A claimed it, B still cannot touch it
  await r.run("step_claim", { stepRunId: o.stepRunId });
  await assert.rejects(r.run("step_heartbeat", { stepRunId: o.stepRunId }, FREE_B), refused("not_found", 404));
  await assert.rejects(r.run("step_report", { stepRunId: o.stepRunId, status: "completed", output: GOOD_OUTPUT }, FREE_B), refused("not_found", 404));
  assert.equal(r.temporal.count("complete"), 0);
});

test("a Bound agent, or an agent of the wrong mode, gets nothing", async () => {
  const r = rig();
  const o = await r.offer();
  // a Bound agent with another id sees nothing
  assert.deepEqual((await DUE(r, BOUND_C)).steps, []);
  assert.equal((await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId }, BOUND_C)).reason, "not_found");
  // the same agent id, seen in mode bound now (it was changed after the offer): R1a needs the modes to match
  const rebound = { ...FREE_A, mode: "bound" as const };
  assert.deepEqual((await DUE(r, rebound)).steps, []);
  const c = await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId }, rebound);
  assert.deepEqual([c.claimed, c.reason], [false, "mode_mismatch"]);
  await assert.rejects(r.run("step_heartbeat", { stepRunId: o.stepRunId }, rebound), refused("mode_mismatch", 409));
  // a caller that is no agent
  assert.deepEqual((await DUE(r, OWNER)).steps, []);
  assert.equal(steps.getRow(r.db, o.stepRunId)?.status, "offered");
  // good half: the Free agent itself still claims it
  assert.equal((await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId })).claimed, true);
});

test("an offer to a Bound agent, to an unknown agent or to a removed agent is refused at the engine", async () => {
  const r = rig();
  await assert.rejects(r.offer({ agentId: BOUND_C.id }), refused("agent_not_free", 422));
  await assert.rejects(r.offer({ agentId: "agt_01J00000000000000000000099" }), refused("agent_not_free", 422));
  directory.markRemoved(r.db, FREE_B.id);
  await assert.rejects(r.offer({ agentId: FREE_B.id }), refused("agent_not_free", 422));
  assert.equal(r.db.prepare("SELECT count(*) AS n FROM agent_step_runs").get()?.n, 0, "nothing stored");
});

test("a paused or removed agent is offered and given nothing; resumed, it gets the step again", async () => {
  const r = rig();
  const o = await r.offer();
  directory.recordAgent(r.db, { id: FREE_A.id as `agt_${string}`, name: FREE_A.name, mode: "free", status: "paused" }, T0);
  assert.deepEqual((await DUE(r)).steps, []);
  const c = await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId });
  assert.deepEqual([c.claimed, c.reason], [false, "agent_unavailable"]);
  directory.markRemoved(r.db, FREE_A.id);
  assert.deepEqual((await DUE(r)).steps, []);
  assert.equal((await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId })).reason, "agent_unavailable");
  assert.equal(steps.getRow(r.db, o.stepRunId)?.status, "offered");
  directory.recordAgent(r.db, { id: FREE_A.id as `agt_${string}`, name: FREE_A.name, mode: "free", status: "active" }, T0);
  assert.equal((await DUE(r)).steps.length, 1);
  assert.equal((await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId })).claimed, true);
});

test("a double claim is refused: only one succeeds, the other answers already_claimed", async () => {
  const r = rig();
  const o = await r.offer();
  const [first, second] = await Promise.all([r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId }), r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId })]);
  assert.deepEqual([first.claimed, second.claimed].sort(), [false, true]);
  assert.equal([first, second].find((x) => !x.claimed)?.reason, "already_claimed");
  assert.equal([first, second].find((x) => !x.claimed)?.step, null, "the loser gets no instruction or inputs");
  assert.equal(r.db.prepare("SELECT count(*) AS n FROM agent_step_events WHERE kind = 'claimed'").get()?.n, 1);
  assert.equal(r.temporal.count("heartbeat"), 1, "one claim, one heartbeat");
  // later, too
  assert.equal((await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId })).reason, "already_claimed");
});

test("a report with output that breaks the schema is 422 with a pointer; the step stays claimed and can be reported again", async () => {
  const r = rig();
  const o = await r.offer();
  await r.run("step_claim", { stepRunId: o.stepRunId });
  await assert.rejects(r.run("step_report", { stepRunId: o.stepRunId, status: "completed", output: { bullets: "not an array", needsReply: [] } }), (e) => {
    const t = e as { code?: string; httpStatus?: number; details?: { pointer?: string } };
    return t.code === "output_invalid" && t.httpStatus === 422 && t.details?.pointer === "/output/bullets";
  });
  await assert.rejects(r.run("step_report", { stepRunId: o.stepRunId, status: "completed", output: { bullets: [] } }), (e) => {
    const t = e as { details?: { pointer?: string } };
    return typeof t.details?.pointer === "string" && t.details.pointer.startsWith("/output");
  });
  await assert.rejects(r.run("step_report", { stepRunId: o.stepRunId, status: "completed", output: { ...GOOD_OUTPUT, extra: 1 } }), refused("output_invalid", 422));
  await assert.rejects(r.run("step_report", { stepRunId: o.stepRunId, status: "completed" }), (e) => (e as { details?: { pointer?: string } }).details?.pointer === "/output");
  const row = steps.getRow(r.db, o.stepRunId);
  assert.equal(row?.status, "claimed");
  assert.equal(row?.invalidReports, 4);
  assert.equal(r.temporal.count("complete"), 0, "nothing reached Temporal");
  // good half: a valid report now completes it
  const ok = await r.run<K.StepReportOutput>("step_report", { stepRunId: o.stepRunId, status: "completed", output: GOOD_OUTPUT, summary: "Done." });
  assert.equal(ok.status, "completed");
  assert.equal(r.temporal.count("complete"), 1);
});

test("a valid report completes the Temporal activity with the output, and Evolution keeps only its size and hash", async () => {
  const r = rig();
  const o = await r.offer();
  await r.run("step_claim", { stepRunId: o.stepRunId });
  r.clock.t += 5_000;
  const out = { bullets: ["secret-body-1"], needsReply: ["secret-body-2"] };
  const rep = await r.run<K.StepReportOutput>("step_report", { stepRunId: o.stepRunId, status: "completed", output: out, summary: "Two lines.", metrics: { emails: 12, needs_reply: 1 } });
  assert.deepEqual([rep.status, rep.attempt, rep.summary, rep.finishedAt], ["completed", 1, "Two lines.", new Date(T0 + 5_000).toISOString()]);
  assert.equal(rep.outputBytes, Buffer.byteLength(JSON.stringify(out)));
  const done = r.temporal.calls.find((c) => c.kind === "complete");
  assert.equal(done?.token, "tok-1");
  assert.deepEqual(done?.arg, out);
  // the row: ended, inputs and task token gone, the output body nowhere
  const raw = r.db.prepare("SELECT * FROM agent_step_runs WHERE step_run_id = ?").get(o.stepRunId) as Record<string, unknown>;
  assert.equal(raw.inputs_json, null);
  assert.equal(raw.task_token, null);
  assert.equal(raw.status, "completed");
  assert.match(String(raw.output_sha256), /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify([raw, r.db.prepare("SELECT * FROM agent_step_events").all()]).includes("secret-body"), false, "no output body in any table");
  assert.equal(JSON.stringify(raw).includes("a@example.com"), false, "no input body once the step has ended");
  // the same report again changes nothing and calls Temporal no more
  const again = await r.run<K.StepReportOutput>("step_report", { stepRunId: o.stepRunId, status: "completed", output: out });
  assert.deepEqual(again, rep);
  assert.equal(r.temporal.count("complete"), 1);
  // a different ending of an ended step is refused
  await assert.rejects(r.run("step_report", { stepRunId: o.stepRunId, status: "failed" }), refused("step_finished", 409));
});

test("status failed fails the Temporal activity; the retry offers the step again as the next attempt", async () => {
  const r = rig();
  const o = await r.offer();
  await r.run("step_claim", { stepRunId: o.stepRunId });
  const rep = await r.run<K.StepReportOutput>("step_report", { stepRunId: o.stepRunId, status: "failed", summary: "The mailbox was empty." });
  assert.equal(rep.status, "failed");
  const f = r.temporal.calls.find((c) => c.kind === "fail");
  assert.equal(f?.token, "tok-1");
  const err = f?.arg as Error | undefined;
  assert.deepEqual([err?.message, err?.name], ["The mailbox was empty.", "AgentStepFailed"]);
  assert.equal(r.temporal.count("complete"), 0);
  // Temporal retries: the engine offers attempt 2 of the SAME step with a new token
  r.temporal.open.add("tok-retry");
  await r.port.offer({ ...o, attempt: 2, taskToken: b64("tok-retry") });
  const row = steps.getRow(r.db, o.stepRunId);
  assert.deepEqual([row?.status, row?.attempt, row?.claimedBy, row?.invalidReports], ["offered", 2, null, 0]);
  assert.equal((await DUE(r)).steps.length, 1);
  const c = await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId });
  assert.equal(c.step?.attempt, 2);
  assert.equal(r.temporal.calls.at(-1)?.token, "tok-retry", "the new attempt uses the new token");
  // the owner sees both attempts
  const list = await r.run<K.AgentStepsListOutput>("agent_steps_list", {}, OWNER);
  assert.deepEqual(list.steps[0]?.events.map((e) => `${e.attempt}:${e.kind}`), ["1:offered", "1:claimed", "1:failed", "2:offered", "2:claimed"]);
});

test("a heartbeat keeps the step alive; three missed heartbeats time it out and later calls are refused", async () => {
  const r = rig();
  const o = await r.offer();
  await assert.rejects(r.run("step_heartbeat", { stepRunId: o.stepRunId }), refused("not_claimed", 409));
  await r.run("step_claim", { stepRunId: o.stepRunId });
  // quiet on good: a beat every 100 s (inside 3 x 60 s) keeps it open well past one window
  for (let i = 0; i < 4; i++) {
    r.clock.t += 100_000;
    const hb = await r.run<K.StepHeartbeatOutput>("step_heartbeat", { stepRunId: o.stepRunId });
    assert.equal(hb.status, "claimed");
    assert.equal(hb.heartbeatBy, new Date(r.clock.t + 180_000).toISOString());
    assert.equal(hb.deadline, new Date(T0 + 900_000).toISOString());
  }
  assert.equal(r.temporal.count("heartbeat"), 5, "claim + 4 beats");
  // fire on bad: 181 s of silence
  r.clock.t += 181_000;
  await assert.rejects(r.run("step_heartbeat", { stepRunId: o.stepRunId }), refused("step_timed_out", 409));
  assert.equal(steps.getRow(r.db, o.stepRunId)?.status, "timed_out");
  assert.equal(r.temporal.count("heartbeat"), 5, "refused before Temporal is asked");
  // report after the timeout: refused, Temporal not asked to complete
  await assert.rejects(r.run("step_report", { stepRunId: o.stepRunId, status: "completed", output: GOOD_OUTPUT }), refused("step_timed_out", 409));
  assert.equal(r.temporal.count("complete"), 0);
  assert.equal((await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId })).reason, "timed_out");
  const ev = steps.eventsOf(r.db, o.stepRunId);
  assert.equal(ev.at(-1)?.kind, "timed_out");
  assert.match(ev.at(-1)?.detail ?? "", /No heartbeat for 3 x 60 s/);
});

test("the deadline times out an offered step that nobody claimed, and a claimed one that beats on time", async () => {
  const r = rig();
  const idle = await r.offer();
  const busy = await r.offer();
  await r.run("step_claim", { stepRunId: busy.stepRunId });
  for (let i = 0; i < 10; i++) {
    r.clock.t += 100_000;
    if (r.clock.t > T0 + 900_000) break;
    await r.run("step_heartbeat", { stepRunId: busy.stepRunId });
  }
  r.clock.t = T0 + 900_001;
  assert.deepEqual((await DUE(r)).steps, [], "an overdue offer is not offered");
  assert.equal(steps.getRow(r.db, idle.stepRunId)?.status, "timed_out");
  await assert.rejects(r.run("step_heartbeat", { stepRunId: busy.stepRunId }), refused("step_timed_out", 409));
  assert.equal((await r.run<K.StepClaimOutput>("step_claim", { stepRunId: idle.stepRunId })).reason, "timed_out");
});

test("a heartbeat after Temporal timed the activity out is refused and the table follows Temporal", async () => {
  const r = rig();
  const o = await r.offer();
  await r.run("step_claim", { stepRunId: o.stepRunId });
  r.temporal.open.clear(); // Temporal's own clock ended it; our clock has not yet
  await assert.rejects(r.run("step_heartbeat", { stepRunId: o.stepRunId }), refused("step_timed_out", 409));
  assert.equal(steps.getRow(r.db, o.stepRunId)?.status, "timed_out");
  assert.match(steps.eventsOf(r.db, o.stepRunId).at(-1)?.detail ?? "", /no longer has this step open/);
});

test("a cancel request from the workflow reaches the agent at its next heartbeat or report", async () => {
  const r = rig();
  const a = await r.offer();
  await r.run("step_claim", { stepRunId: a.stepRunId });
  r.temporal.cancelRequested.add("tok-1");
  await assert.rejects(r.run("step_heartbeat", { stepRunId: a.stepRunId }), refused("step_cancelled", 409));
  assert.equal(steps.getRow(r.db, a.stepRunId)?.status, "cancelled");
  // the engine cancels another one through the port
  const b = await r.offer();
  await r.run("step_claim", { stepRunId: b.stepRunId });
  await r.port.cancel(b.stepRunId);
  await assert.rejects(r.run("step_heartbeat", { stepRunId: b.stepRunId }), refused("step_cancelled", 409));
  await assert.rejects(r.run("step_report", { stepRunId: b.stepRunId, status: "completed", output: GOOD_OUTPUT }), refused("step_cancelled", 409));
  // cancel is idempotent and ignores what it does not know
  await r.port.cancel(b.stepRunId);
  await r.port.cancel("asr_unknown");
  // an offered step that is cancelled is no longer offered
  const c = await r.offer();
  await r.port.cancel(c.stepRunId);
  assert.deepEqual((await DUE(r)).steps, []);
  assert.equal((await r.run<K.StepClaimOutput>("step_claim", { stepRunId: c.stepRunId })).reason, "cancelled");
});

test("a claim for an activity that Temporal no longer has is refused, and the step ends", async () => {
  const r = rig();
  const o = await r.offer();
  r.temporal.open.clear();
  const c = await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId });
  assert.deepEqual([c.claimed, c.reason, c.step], [false, "timed_out", null]);
  assert.equal(steps.getRow(r.db, o.stepRunId)?.status, "timed_out");
});

test("Temporal being down is a 503 that leaves the step as it is, so the agent can report again", async () => {
  const r = rig();
  const o = await r.offer();
  await r.run("step_claim", { stepRunId: o.stepRunId });
  r.temporal.down = true;
  await assert.rejects(r.run("step_report", { stepRunId: o.stepRunId, status: "completed", output: GOOD_OUTPUT }), refused("engine_unavailable", 503));
  await assert.rejects(r.run("step_heartbeat", { stepRunId: o.stepRunId }), refused("engine_unavailable", 503));
  assert.equal(steps.getRow(r.db, o.stepRunId)?.status, "claimed");
  r.temporal.down = false;
  assert.equal((await r.run<K.StepReportOutput>("step_report", { stepRunId: o.stepRunId, status: "completed", output: GOOD_OUTPUT })).status, "completed");
  // a claim while Temporal is down still claims (the heartbeat at claim is best effort)
  const p = await r.offer();
  r.temporal.down = true;
  assert.equal((await r.run<K.StepClaimOutput>("step_claim", { stepRunId: p.stepRunId })).claimed, true);
});

test("without an engine wired the default completion answers 503", async () => {
  const { defaultCompletion, setCompletionProvider } = await import("../../src/agentsteps/completion.ts");
  setCompletionProvider(null);
  await assert.rejects(defaultCompletion(), refused("engine_unavailable", 503));
  setCompletionProvider(async () => ({ complete: async () => {}, fail: async () => {}, heartbeat: async () => {} }));
  assert.ok(await defaultCompletion());
  setCompletionProvider(null);
});

test("the offer is checked at the engine: shape, size, schema, identity, attempts", async () => {
  const r = rig();
  await assert.rejects(r.offer({ outputSchema: { type: "array" } }), (e) => (e as { details?: { pointer?: string } }).details?.pointer === "/outputSchema/type");
  await assert.rejects(r.offer({ outputSchema: { type: "object", properties: { a: { type: "no-such-type" } } } }), refused("validation_failed", 422));
  await assert.rejects(r.offer({ heartbeatSec: 0 }), refused("validation_failed", 422));
  await assert.rejects(r.offer({ heartbeatSec: 120, timeoutSec: 60 }), refused("validation_failed", 422));
  await assert.rejects(r.offer({ stepRunId: "has space" }), refused("validation_failed", 422));
  await assert.rejects(r.offer({ taskToken: "not base64!" }), refused("validation_failed", 422));
  await assert.rejects(r.offer({ instruction: "" }), refused("validation_failed", 422));
  await assert.rejects(r.offer({ inputs: { big: "x".repeat(steps.MAX_INPUTS_BYTES) } }), refused("validation_failed", 422));
  // idempotent per attempt: the same offer twice is one step; a stale attempt is ignored
  const o = await r.offer();
  await r.port.offer({ ...o, taskToken: b64("tok-again") });
  assert.equal(r.db.prepare("SELECT count(*) AS n FROM agent_step_runs WHERE step_run_id = ?").get(o.stepRunId)?.n, 1);
  assert.equal(r.db.prepare("SELECT count(*) AS n FROM agent_step_events WHERE step_run_id = ? AND kind = 'offered'").get(o.stepRunId)?.n, 1);
  assert.equal(steps.getRow(r.db, o.stepRunId)?.taskToken, b64("tok-again"), "an unclaimed step takes the newer token");
  await r.port.offer({ ...o, attempt: 2, taskToken: b64("tok-2") });
  await r.port.offer({ ...o, attempt: 1, taskToken: b64("tok-stale") });
  assert.deepEqual([steps.getRow(r.db, o.stepRunId)?.attempt, steps.getRow(r.db, o.stepRunId)?.taskToken], [2, b64("tok-2")]);
  // the same id for another run is a conflict
  await assert.rejects(r.port.offer({ ...o, runId: "run_other", attempt: 3 }), refused("conflict", 409));
  // a re-offer replaces an attempt that is still open
  const open = await r.offer();
  await r.run("step_claim", { stepRunId: open.stepRunId });
  await r.port.offer({ ...open, attempt: 2, taskToken: b64("tok-next") });
  assert.deepEqual(steps.eventsOf(r.db, open.stepRunId).map((e) => `${e.attempt}:${e.kind}`), ["1:offered", "1:claimed", "1:cancelled", "2:offered"]);
});

test("the report refuses an output over the size limit, and a metrics block is stored for the owner only", async () => {
  const r = rig();
  const o = await r.offer({ outputSchema: { type: "object", properties: { text: { type: "string" } } } });
  await r.run("step_claim", { stepRunId: o.stepRunId });
  await assert.rejects(r.run("step_report", { stepRunId: o.stepRunId, status: "completed", output: { text: "x".repeat(steps.MAX_OUTPUT_BYTES) } }), refused("output_invalid", 422));
  await r.run("step_report", { stepRunId: o.stepRunId, status: "completed", output: { text: "ok" }, summary: "  fine  ", metrics: { tokens_used: 1200 } });
  const list = await r.run<K.AgentStepsListOutput>("agent_steps_list", { runId: o.runId }, OWNER);
  assert.equal(list.steps.length, 1);
  assert.deepEqual([list.steps[0]?.summary, list.steps[0]?.metrics, list.steps[0]?.claimedBy], ["fine", { tokens_used: 1200 }, FREE_A.id]);
  // the agent's own answer never shows metrics or other steps
  const rep = await r.run<Record<string, unknown>>("step_report", { stepRunId: o.stepRunId, status: "completed", output: { text: "ok" } });
  assert.equal("metrics" in rep, false);
});

test("the owner list never carries inputs or output, filters by run and workflow, and shows an overdue step as timed out", async () => {
  const r = rig();
  const a = await r.offer();
  const b = await r.offer();
  await r.run("step_claim", { stepRunId: a.stepRunId });
  const all = await r.run<K.AgentStepsListOutput>("agent_steps_list", {}, OWNER);
  assert.equal(all.steps.length, 2);
  assert.equal(JSON.stringify(all).includes("a@example.com"), false, "no inputs");
  assert.equal(JSON.stringify(all).includes(a.instruction), false, "no instruction either: the owner reads that in the workflow");
  assert.deepEqual((await r.run<K.AgentStepsListOutput>("agent_steps_list", { runId: b.runId }, OWNER)).steps.map((s) => s.stepRunId), [b.stepRunId]);
  assert.equal((await r.run<K.AgentStepsListOutput>("agent_steps_list", { workflowId: r.workflowId }, OWNER)).steps.length, 2);
  assert.equal((await r.run<K.AgentStepsListOutput>("agent_steps_list", { workflowId: "wfl_none" }, OWNER)).steps.length, 0);
  r.clock.t = T0 + 901_000;
  assert.deepEqual((await r.run<K.AgentStepsListOutput>("agent_steps_list", {}, OWNER)).steps.map((s) => s.status), ["timed_out", "timed_out"]);
});

test("a step of a workflow that Evolution does not store as a version has an empty allowedHint and its id as the title", async () => {
  const r = rig();
  const o = await r.offer({ workflowId: "wfl_engineonly", version: 7 });
  assert.equal((await DUE(r)).steps[0]?.workflowTitle, "wfl_engineonly");
  const c = await r.run<K.StepClaimOutput>("step_claim", { stepRunId: o.stepRunId });
  assert.deepEqual(c.step?.allowedHint, []);
});

test("the manifest: four agent ops and one person op, wired in app.ts", async () => {
  const ops = manifest.operations as { id: string; audience: string; effect: string; idempotency: string }[];
  const by = (id: string) => ops.find((o) => o.id === id);
  for (const id of ["steps_due", "step_claim", "step_heartbeat", "step_report"]) assert.equal(by(id)?.audience, "agent", id);
  assert.equal(by("agent_steps_list")?.audience, "person");
  assert.equal(by("steps_due")?.effect, "read");
  // the SDK keeps a (sealed) copy of the answer to a call with an idempotency key: the claim answer holds the step's inputs, which can be other apps' data
  assert.equal(by("step_claim")?.idempotency, "none");
  assert.equal(by("step_report")?.idempotency, "supported", "the report's answer has no body, so a repeat may replay it");
  const { handlers } = await import("../../src/app.ts");
  for (const id of ["steps_due", "step_claim", "step_heartbeat", "step_report", "agent_steps_list"]) assert.ok(id in handlers, id);
  // the wired default has no engine yet (TEMP until WP2 lands): a report is a 503, never a crash
  const r = rig();
  r.clock.t = Date.now(); // the wired handlers use the real clock
  const o = await r.offer();
  const wired = handlers as unknown as Record<string, { run: (i: unknown, c: unknown) => Promise<unknown> }>;
  await wired.step_claim?.run({ stepRunId: o.stepRunId }, r.as(FREE_A));
  await assert.rejects(wired.step_report?.run({ stepRunId: o.stepRunId, status: "completed", output: GOOD_OUTPUT }, r.as(FREE_A)) as Promise<unknown>, refused("engine_unavailable", 503));
});
