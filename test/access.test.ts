// C380 B7: tb.access/1 on Evolving Workflows (src/access.ts). Every guard has a quiet-on-good and a fire-on-bad test with the
// exact code and status. The shape of access_list / access_revoke is checked against the manifest schemas (the `call` helper);
// the shared fixtures of spec 0.1.89 are checked in test/access-spec.test.ts once that spec is on dist.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Caller, Db, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import type { AccessItem, ListOut, RevokeOut } from "../src/access.ts";
import * as access from "../src/access.ts";
import { handlers, manifest } from "../src/app.ts";
import type { WorkflowContract } from "../src/engine/contract.ts";
import * as engineStore from "../src/engine/engine-store.ts";
import * as r from "../src/routines.ts";
import * as store from "../src/store.ts";
import { AGENT_A, AGENT_B, call, ctxFor, migratedDb, OWNER } from "./helpers.ts";

const H = handlers as unknown as Parameters<typeof call>[0];
/** a right-to-left override, built here so that no format character sits in the source */
const BIDI = String.fromCharCode(0x202e);
const T0 = Date.parse("2026-10-30T16:00:00Z");
const A = AGENT_A.id as string;
const B = AGENT_B.id as string;
const C = "agt_01J0000000000000000000000C";

const FLEET: Caller = { type: "app", id: "ins_01J000000000000000000000FL" as Caller["id"], name: "Governance", mode: null, product: "fleet", listed: true } as Caller;
const asApp = (over: Record<string, unknown>): Caller => ({ ...FLEET, ...over }) as Caller;

/** a context with a fake slice: `stopped` agents are paused or not in the slice; every other agent runs */
function ctxWith(db: Db, caller: Caller, stopped: readonly string[] = []): OpContext {
  const c = ctxFor(db, caller) as unknown as Record<string, unknown>;
  c.paused = (agent?: string | null) => ({ workspace: false, instance: false, agent: agent != null && stopped.includes(agent) });
  c.log = { info() {}, warn() {}, error() {}, debug() {} };
  return c as unknown as OpContext;
}
const list = (db: Db, input: Record<string, unknown>, caller: Caller = FLEET) => call<ListOut>(H, "access_list", { v: 1, ...input }, ctxWith(db, caller));
const revoke = (db: Db, input: Record<string, unknown>, stopped: readonly string[], caller: Caller = FLEET) => call<RevokeOut>(H, "access_revoke", { v: 1, plan: "pln_01", attempt: 1, ...input }, ctxWith(db, caller, stopped));
const refusal = (code: string, status: number) => (e: unknown) => (e as { code?: string; httpStatus?: number }).code === code && (e as { httpStatus?: number }).httpStatus === status;

function workflow(db: Db, title = "Morning rollup"): string {
  const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title, summary: "", instruction: "Roll up.", trigger: "08:00", steps: [], allowed: [{ product: "kanban", operations: ["issues_list"], crud: ["read" as const] }] } }, T0);
  return store.promote(db, d.id, d.revision, T0).workflow.id;
}
const schedule = (db: Db, agent: string, wf: string = workflow(db), extra: Partial<r.AutomationInput> = {}) => r.setAutomation(db, { workflowId: wf, agentId: agent, targetMode: "bound", cron: "0 8 * * *", ...extra }, T0);

function contract(id: string, version: number, agents: string[], title = "Engine flow"): WorkflowContract {
  return {
    format: "tealbrick.workflow/1",
    id,
    version,
    title,
    triggers: [{ kind: "manual" }],
    steps: agents.map((agent, i) => ({ id: `step${i + 1}`, type: "ai" as const, by: { agent }, instruction: "Do it.", outputSchema: { type: "object" } })),
  };
}
function activate(db: Db, c: WorkflowContract): void {
  engineStore.saveDefinition(db, c, T0);
  engineStore.activate(db, c.id, c.version, [], T0);
}
function engineSchedule(db: Db, workflowId: string, extra: Partial<engineStore.ScheduleRow> = {}): engineStore.ScheduleRow {
  return engineStore.insertSchedule(db, { id: engineStore.newScheduleId(T0), workflowId, versionPin: null, kind: "schedule", spec: { cron: "0 8 * * *", timezone: "UTC" }, input: {}, poll: null, overlap: "skip", paused: false, ...extra }, T0);
}
const subjectId = (i: AccessItem | undefined): string | null => (i?.subject.kind === "agent" ? i.subject.id : null);
const enabledOf = (db: Db, id: string): number => Number(db.prepare("SELECT enabled FROM automations WHERE id = ?").get(id)?.enabled);

// ── the guard: one quiet-on-good, one fire-on-bad per caller case (the shared 6-case vector) ──

test("guard: the verified, listed Governance app passes both ops (quiet on good)", async () => {
  const db = migratedDb();
  assert.equal((await list(db, { subjects: [{ kind: "all" }] })).v, 1);
  const rv = await revoke(db, { subject: { kind: "agent", id: A }, items: [{ id: "routine:aut_gone", digest: `sha256:${"0".repeat(64)}` }] }, [A]);
  assert.equal(rv.results[0]?.outcome, "already_gone");
});

test("guard: every other caller is refused with the exact code and status, for both ops (fire on bad)", async () => {
  const db = migratedDb();
  const cases: [string, Caller, string][] = [
    ["an agent", AGENT_A, "no_access"],
    ["the owner", OWNER, "no_access"],
    ["an app with no verified product", asApp({ product: undefined }), "caller_unverified"],
    ["an app with an empty product", asApp({ product: "" }), "caller_unverified"],
    ["another app (kanban)", asApp({ product: "kanban" }), "no_access"],
    ["the Governance app, not in the current slice", asApp({ listed: false }), "caller_unverified"],
    ["the Governance app, no listed flag (older SDK)", asApp({ listed: undefined }), "caller_unverified"],
  ];
  for (const [name, who, code] of cases) {
    await assert.rejects(() => list(db, { subjects: [{ kind: "all" }] }, who), refusal(code, 403), `access_list: ${name}`);
    await assert.rejects(() => revoke(db, { subject: { kind: "agent", id: A }, items: [{ id: "routine:x", digest: `sha256:${"0".repeat(64)}` }] }, [A], who), refusal(code, 403), `access_revoke: ${name}`);
  }
});

test("manifest: both ops are LAST, agent-only, listed by workflow, and no other part of the manifest points at them", () => {
  const ops = manifest.operations as { id: string; audience: string; listing?: string; crud: string[]; effect: string; idempotency: string; receipt: boolean }[];
  const tail = ops.slice(-2);
  assert.deepEqual(tail.map((o) => o.id), ["access_list", "access_revoke"]);
  assert.deepEqual(tail.map((o) => [o.audience, o.listing]), [["agent", "workflow"], ["agent", "workflow"]]);
  assert.deepEqual([tail[0]?.crud, tail[0]?.effect, tail[0]?.idempotency, tail[0]?.receipt], [["read"], "read", "none", false]);
  assert.deepEqual([tail[1]?.crud, tail[1]?.effect, tail[1]?.idempotency, tail[1]?.receipt], [["update"], "write", "required", true]);
  assert.equal(ops.filter((o) => o.listing !== undefined).length, 2);
  assert.equal(JSON.stringify(manifest.companions).includes("access_"), false);
});

// ── access_list ──

test("list: schedules, active workflow steps and schedules of workflows, each tied to an agent and sorted by id", async () => {
  const db = migratedDb();
  const aut = schedule(db, A);
  activate(db, contract("flow-a", 1, [A, B]));
  const es = engineSchedule(db, "flow-a");
  const out = await list(db, { subjects: [{ kind: "all" }] });
  assert.deepEqual(
    out.items.map((i) => i.id),
    [`routine:${aut.id}`, `schedule_of_workflow:${es.id}:${A}`, `schedule_of_workflow:${es.id}:${B}`, "workflow_agent_step:flow-a:step1", "workflow_agent_step:flow-a:step2"].sort(),
  );
  const byId = Object.fromEntries(out.items.map((i) => [i.id, i]));
  const routine = byId[`routine:${aut.id}`] as AccessItem;
  assert.deepEqual([routine.kind, routine.subject, routine.resource, routine.direction, routine.level, routine.state, routine.revocable], ["routine", { kind: "agent", id: A }, aut.id, "held_by", "use", "scheduled", true]);
  assert.equal(subjectId(byId["workflow_agent_step:flow-a:step2"]), B);
  for (const i of out.items.filter((x) => x.kind !== "routine")) assert.equal(i.revocable, false, i.id);
  for (const i of out.items) assert.match(i.digest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(out.items.every((i) => i.label.length <= 120 && !/[<>\p{Cc}]/u.test(i.label)));
});

test("list: only the asked agents; a person, an unlinked subject or an unknown agent has no item", async () => {
  const db = migratedDb();
  schedule(db, A);
  schedule(db, B);
  const only = (await list(db, { subjects: [{ kind: "agent", id: A }] })).items;
  assert.deepEqual(only.map((i) => i.subject), [{ kind: "agent", id: A }]);
  assert.equal((await list(db, { subjects: [{ kind: "agent", id: C }] })).items.length, 0);
  assert.equal((await list(db, { subjects: [{ kind: "person", id: "per_1", handles: ["a@example.com"] }, { kind: "unlinked" }] })).items.length, 0);
  assert.equal((await list(db, { subjects: [{ kind: "all" }] })).items.length, 2);
});

test("list: `all` must be the only subject (422 validation_failed)", async () => {
  const db = migratedDb();
  await assert.rejects(() => list(db, { subjects: [{ kind: "all" }, { kind: "agent", id: A }] }), refusal("validation_failed", 422));
});

test("list: a deleted schedule, a superseded version and a deactivated workflow are not listed; a paused schedule stays as paused", async () => {
  const db = migratedDb();
  const gone = schedule(db, A);
  r.deleteAutomation(db, gone.id, gone.revision, T0);
  const kept = schedule(db, A);
  r.pauseAutomation(db, kept.id, kept.revision, true, T0);
  activate(db, contract("flow-old", 1, [A]));
  activate(db, contract("flow-old", 2, [B]));
  activate(db, contract("flow-off", 1, [A]));
  engineStore.deactivate(db, "flow-off", T0);
  const out = (await list(db, { subjects: [{ kind: "all" }] })).items;
  assert.deepEqual(out.map((i) => i.id), [`routine:${kept.id}`, "workflow_agent_step:flow-old:step1"].sort());
  assert.equal(out.find((i) => i.id === `routine:${kept.id}`)?.state, "paused");
  assert.equal(subjectId(out.find((i) => i.id === "workflow_agent_step:flow-old:step1")), B);
});

test("list: the placeholder agent of a moved 0.3.x workflow and a step done by a role are not items", async () => {
  const db = migratedDb();
  const c = contract("flow-moved", 1, ["agt_unassigned"]);
  c.steps.push({ id: "viaRole", type: "ai", by: { role: "writer" }, instruction: "Write.", outputSchema: { type: "object" } });
  activate(db, c);
  assert.equal((await list(db, { subjects: [{ kind: "all" }] })).items.length, 0);
});

test("list: schedules of workflows follow the pin; a schedule pinned to a version that is not active is dormant, a paused one paused", async () => {
  const db = migratedDb();
  activate(db, contract("flow-p", 1, [A]));
  activate(db, contract("flow-p", 2, [B]));
  const live = engineSchedule(db, "flow-p");
  const pinned = engineSchedule(db, "flow-p", { versionPin: 1 });
  const paused = engineSchedule(db, "flow-p", { paused: true });
  const none = engineSchedule(db, "flow-nothing");
  const items = (await list(db, { subjects: [{ kind: "all" }] })).items.filter((i) => i.kind === "schedule_of_workflow");
  const row = (id: string) => items.find((i) => i.resource === id);
  assert.deepEqual([row(live.id)?.state, subjectId(row(live.id))], ["scheduled", B]);
  assert.deepEqual([row(pinned.id)?.state, subjectId(row(pinned.id))], ["dormant", A]);
  assert.equal(row(paused.id)?.state, "paused");
  assert.equal(row(none.id), undefined);
});

test("list: paging by cursor returns every item once, in order; a bad cursor is 422; sweepId is echoed", async () => {
  const db = migratedDb();
  for (let i = 0; i < 5; i++) schedule(db, A);
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const p: ListOut = await list(db, { subjects: [{ kind: "all" }], limit: 2, sweepId: "swp_1", ...(cursor ? { cursor } : {}) });
    assert.equal(p.sweepId, "swp_1");
    assert.ok(p.items.length <= 2);
    seen.push(...p.items.map((i) => i.id));
    cursor = p.nextCursor ?? undefined;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, 5);
  assert.deepEqual(seen, [...seen].sort());
  await assert.rejects(() => list(db, { subjects: [{ kind: "all" }], cursor: "not-a-cursor" }), refusal("validation_failed", 422));
});

test("list: notShown names the held calls, so complete is false even on the last page (a stated limit, not an error)", async () => {
  const db = migratedDb();
  const out = await list(db, { subjects: [{ kind: "all" }] });
  assert.equal(out.nextCursor, null);
  assert.deepEqual(out.notShown.map((n) => n.kind), ["held_call"]);
  assert.equal(out.complete, false);
});

test("digest: the same item active then paused is equal; another agent, resource or kind is not", () => {
  const db = migratedDb();
  const aut = schedule(db, A);
  const before = access.allItems(db).find((i) => i.id === `routine:${aut.id}`) as AccessItem;
  r.pauseAutomation(db, aut.id, aut.revision, true, T0);
  const after = access.allItems(db).find((i) => i.id === `routine:${aut.id}`) as AccessItem;
  assert.equal(before.state, "scheduled");
  assert.equal(after.state, "paused");
  assert.equal(after.digest, before.digest);
  assert.notEqual(access.itemDigest({ ...before, subject: { kind: "agent", id: B } }), before.digest);
  assert.notEqual(access.itemDigest({ ...before, resource: "aut_other" }), before.digest);
});

test("text: owner text is plain (no markup, no control or bidi characters) and at most 120 characters", () => {
  assert.equal(access.plain(`a${BIDI}b\u0007c <b>d</b>\n\te`), "a b c bd/b e");
  assert.equal(access.plain("x".repeat(500)).length, 120);
  const db = migratedDb();
  schedule(db, A, workflow(db, `Rollup <script>alert(1)</script>${BIDI}${"y".repeat(300)}`));
  const label = access.allItems(db)[0]?.label as string;
  assert.ok(label.length <= 120 && !/[<>\p{Cf}]/u.test(label));
});

// ── access_revoke ──

const item = (i: AccessItem) => ({ id: i.id, digest: i.digest });
const subjectA = { kind: "agent", id: A };

test("revoke: a routine of a stopped agent is paused (nothing else changes), and the same request again is already_gone", async () => {
  const db = migratedDb();
  const mine = schedule(db, A);
  const other = schedule(db, B);
  const wfCount = Number(db.prepare("SELECT count(*) AS n FROM workflows").get()?.n);
  const [it] = (await list(db, { subjects: [{ kind: "agent", id: A }] })).items;
  const out = await revoke(db, { subject: subjectA, items: [item(it as never)] }, [A]);
  assert.deepEqual(out.results, [{ id: `routine:${mine.id}`, outcome: "revoked" }]);
  assert.equal(enabledOf(db, mine.id), 0);
  assert.equal(enabledOf(db, other.id), 1);
  const row = db.prepare("SELECT cron, revision, agent_id, deleted_at FROM automations WHERE id = ?").get(mine.id);
  assert.deepEqual([row?.cron, Number(row?.revision), row?.agent_id, row?.deleted_at], ["0 8 * * *", mine.revision + 1, A, null]);
  assert.equal(Number(db.prepare("SELECT count(*) AS n FROM workflows").get()?.n), wfCount);
  const again = await revoke(db, { subject: subjectA, items: [item(it as never)] }, [A]);
  assert.deepEqual(again.results.map((x) => x.outcome), ["already_gone"]);
  assert.equal(Number(db.prepare("SELECT revision FROM automations WHERE id = ?").get(mine.id)?.revision), mine.revision + 1, "no second change");
});

test("revoke: an agent that runs in the signed slice is never touched (not_revocable / agent_running); an agent not in the slice counts as stopped", async () => {
  const db = migratedDb();
  const mine = schedule(db, A);
  const [it] = (await list(db, { subjects: [{ kind: "agent", id: A }] })).items;
  const running = await revoke(db, { subject: subjectA, items: [item(it as never)] }, []);
  assert.deepEqual(running.results.map((x) => [x.outcome, x.code]), [["not_revocable", "agent_running"]]);
  assert.equal(enabledOf(db, mine.id), 1);
  // the other agent is the one stopped: still no effect on A
  const wrong = await revoke(db, { subject: subjectA, items: [item(it as never)] }, [B]);
  assert.equal(wrong.results[0]?.outcome, "not_revocable");
  assert.equal(enabledOf(db, mine.id), 1);
  // a context without the slice view fails closed
  const bare = ctxFor(db, FLEET) as unknown as Record<string, unknown>;
  bare.log = { info() {}, warn() {}, error() {}, debug() {} };
  const res = access.revokeAccess(db, bare as unknown as OpContext, { v: 1, plan: "p", attempt: 1, subject: { kind: "agent", id: A }, items: [item(it as never)] });
  assert.equal(res.results[0]?.code, "agent_running");
  assert.equal(enabledOf(db, mine.id), 1);
  // stopped: pause
  assert.equal((await revoke(db, { subject: subjectA, items: [item(it as never)] }, [A])).results[0]?.outcome, "revoked");
});

test("revoke: a changed item answers changed (the agent changed, the digest or the subject differs) and nothing is paused", async () => {
  const db = migratedDb();
  const mine = schedule(db, A);
  const [it] = (await list(db, { subjects: [{ kind: "agent", id: A }] })).items;
  // the owner gave the schedule to B after the list was read
  r.setAutomation(db, { id: mine.id, revision: mine.revision, workflowId: mine.workflowId, policyVersion: mine.policyVersion, agentId: B, targetMode: "bound", cron: mine.cron }, T0);
  const moved = await revoke(db, { subject: subjectA, items: [item(it as never)] }, [A, B]);
  assert.deepEqual(moved.results.map((x) => [x.outcome, x.code]), [["changed", "digest_changed"]]);
  assert.equal(enabledOf(db, mine.id), 1);
  // a digest that is not the item's, and a subject that is not the holder
  const [now] = (await list(db, { subjects: [{ kind: "agent", id: B }] })).items;
  const badDigest = await revoke(db, { subject: { kind: "agent", id: B }, items: [{ id: (now as never as { id: string }).id, digest: `sha256:${"1".repeat(64)}` }] }, [A, B]);
  assert.equal(badDigest.results[0]?.outcome, "changed");
  const wrongSubject = await revoke(db, { subject: subjectA, items: [item(now as never)] }, [A, B]);
  assert.equal(wrongSubject.results[0]?.outcome, "changed");
  assert.equal(enabledOf(db, mine.id), 1);
});

test("revoke: workflow steps, schedules of workflows, unknown kinds and a person subject are not_revocable; nothing is deleted or paused", async () => {
  const db = migratedDb();
  activate(db, contract("flow-r", 1, [A]));
  const es = engineSchedule(db, "flow-r");
  const mine = schedule(db, A);
  const items = (await list(db, { subjects: [{ kind: "agent", id: A }] })).items.filter((i) => i.kind !== "routine");
  const out = await revoke(db, { subject: subjectA, items: [...items.map(item), { id: "bogus:1", digest: `sha256:${"2".repeat(64)}` }] }, [A]);
  assert.deepEqual(out.results.map((x) => [x.outcome, x.code]), [...items.map(() => ["not_revocable", "manual"]), ["not_revocable", "unknown_kind"]]);
  const person = await revoke(db, { subject: { kind: "person", id: "per_1" }, items: [{ id: `routine:${mine.id}`, digest: `sha256:${"3".repeat(64)}` }] }, [A]);
  assert.deepEqual(person.results.map((x) => [x.outcome, x.code]), [["not_revocable", "subject_not_supported"]]);
  assert.equal(enabledOf(db, mine.id), 1);
  assert.equal(engineStore.getSchedule(db, es.id)?.paused, false);
  assert.equal(engineStore.activeActivation(db, "flow-r")?.version, 1);
});

test("revoke: a deleted or already paused schedule is already_gone; a batch is judged item by item", async () => {
  const db = migratedDb();
  const gone = schedule(db, A);
  const paused = schedule(db, A);
  const live = schedule(db, A);
  const listed = (await list(db, { subjects: [{ kind: "agent", id: A }] })).items;
  const of = (id: string) => item(listed.find((i) => i.resource === id) as never);
  r.deleteAutomation(db, gone.id, gone.revision, T0);
  r.pauseAutomation(db, paused.id, paused.revision, true, T0);
  const out = await revoke(db, { subject: subjectA, items: [of(gone.id), of(paused.id), of(live.id)] }, [A]);
  assert.deepEqual(out.results.map((x) => x.outcome), ["already_gone", "already_gone", "revoked"]);
  assert.equal(enabledOf(db, live.id), 0);
});

test("revoke: a schedule whose workflow cannot be edited any more is still paused (the stop does not depend on the workflow)", async () => {
  const db = migratedDb();
  const mine = schedule(db, A);
  const [it] = (await list(db, { subjects: [{ kind: "agent", id: A }] })).items;
  // the cron no longer fires (pauseAutomation would refuse: never fires in the next 5 years)
  db.prepare("UPDATE automations SET cron = '0 0 31 2 *' WHERE id = ?").run(mine.id);
  const out = await revoke(db, { subject: subjectA, items: [item(it as never)] }, [A]);
  assert.equal(out.results[0]?.outcome, "revoked");
  assert.equal(enabledOf(db, mine.id), 0);
});

test("revoke: the same item twice in one request is 422; the batch limit is the manifest's (1..10)", async () => {
  const db = migratedDb();
  const d = { id: "routine:aut_x", digest: `sha256:${"4".repeat(64)}` };
  await assert.rejects(() => revoke(db, { subject: subjectA, items: [d, d] }, [A]), refusal("validation_failed", 422));
  const op = (manifest.operations as unknown as { id: string; input: { properties: { items: { minItems: number; maxItems: number } } } }[]).find((o) => o.id === "access_revoke");
  assert.deepEqual([op?.input.properties.items.minItems, op?.input.properties.items.maxItems], [1, 10]);
});
