// C380 B7 dev.2: acting tickets for durable work done for an agent (src/acting.ts; DESIGN-ACTING-AGENT.md section 3, SDK 0.1.45).
// Every guard has a quiet-on-good and a fire-on-bad half.
//   routine_claim: with the bridge cap `acting_agents` the ticket is minted BEFORE the claim; no ticket, no claim (503).
//                  The run's Task Board calls carry it; it is dropped when the issue is closed. Without the cap: today's path.
//   step_claim:    the same, filed under the run; every later `app` step of the run carries it (test/acting-engine.test.ts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type Caller, type CompanionResult, type Db, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import * as acting from "../src/acting.ts";
import { handlers, migrationsDir } from "../src/app.ts";
import * as directory from "../src/directory.ts";
import * as r from "../src/routines.ts";
import * as store from "../src/store.ts";
import { AGENT_A, AGENT_B, call, migratedDb, ticketOf } from "./helpers.ts";

const H = handlers as unknown as Parameters<typeof call>[0];
const FREE_A: Caller = { ...AGENT_A, mode: "free" };
const FREE_B: Caller = { ...AGENT_B, mode: "free" };
const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

interface Sent {
  op: string;
  input: Record<string, unknown>;
  opts: { idempotencyKey?: string; acting?: { job: string; tickets: string[] } } | undefined;
}
interface Fake {
  ctx: (who: Caller) => OpContext;
  sent: Sent[];
  minted: { job: string; agent: string }[];
}
/** a handler context: the bridge caps, the ticket call, and a callApp that records its options */
function fake(db: Db, opts: { caps?: string[]; mint?: (job: string, who: Caller) => string[] | Error } = {}): Fake {
  const sent: Sent[] = [];
  const minted: Fake["minted"] = [];
  const callApp = async (_p: string, op: string, input: unknown, o?: Sent["opts"]): Promise<CompanionResult> => {
    sent.push({ op, input: input as Record<string, unknown>, opts: o });
    return { status: "ok", output: { id: "iss_1" } } as unknown as CompanionResult;
  };
  return {
    sent,
    minted,
    ctx: (who) =>
      ({
        db,
        caller: who,
        callApp,
        log: { info() {}, warn() {}, error() {}, debug() {} },
        bridgeCaps: () => opts.caps ?? [],
        actingTickets: async (job: string) => {
          minted.push({ job, agent: who.id });
          const out = opts.mint ? opts.mint(job, who) : [ticketOf(who.id)];
          if (out instanceof Error) throw out;
          return out;
        },
      }) as unknown as OpContext,
  };
}

const D0 = Date.now() - 60_000;
function directoryOf(db: Db): void {
  directory.recordDirectory(
    db,
    [FREE_A, FREE_B].map((c) => ({ id: c.id as `agt_${string}`, name: c.name, mode: "free" as const, status: "active" as const })),
    D0,
  );
}
function dueFor(db: Db, who: Caller): string {
  const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "Morning rollup", summary: "", instruction: "Roll up.", trigger: "08:00", steps: [], allowed: [{ product: "kanban", operations: ["issues_list"], crud: ["read" as const] }] } }, D0);
  const wf = store.promote(db, d.id, d.revision, D0).workflow.id;
  r.setAutomation(db, { workflowId: wf, agentId: who.id, targetMode: "free", cron: "* * * * *" }, D0);
  const job = r.dueJobs(db, who.id, Date.now(), "free")[0];
  assert.ok(job, "one occurrence is due");
  return job.occurrence;
}
const rows = (db: Db, job?: string) => db.prepare(job ? "SELECT job, agent_id, ticket FROM acting_tickets WHERE job = ?" : "SELECT job, agent_id, ticket FROM acting_tickets").all(...(job ? [job] : []));
const refusal = (code: string, status: number) => (e: unknown) => e instanceof TbError && e.code === code && e.httpStatus === status;

test("routine_claim with the cap: the ticket is minted for the occurrence, filed, and sent with the run's issue call; the report closes the issue with it and drops it", async () => {
  const db = migratedDb();
  directoryOf(db);
  const occ = dueFor(db, FREE_A);
  const f = fake(db, { caps: [acting.CAP_ACTING] });
  const job = acting.jobOfOccurrence(occ);
  const claim = await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, f.ctx(FREE_A));
  assert.equal(claim.claimed, true);
  assert.deepEqual(f.minted, [{ job, agent: FREE_A.id }]);
  assert.equal(rows(db, job).length, 1, "one ticket row for the job");
  const create = f.sent.find((s) => s.op === "issue_create");
  assert.equal(create?.opts?.acting?.job, job);
  assert.deepEqual(create?.opts?.acting?.tickets, [String(rows(db, job)[0]?.ticket)]);
  assert.equal(create?.opts?.idempotencyKey, `evolution-run:${occ}`, "the call's own options stay");
  await call(H, "routine_report", { occurrence: occ, status: "completed", summary: "Done." }, f.ctx(FREE_A));
  const complete = f.sent.find((s) => s.op === "issue_complete");
  assert.equal(complete?.opts?.acting?.job, job, "the closing call carries the run's ticket too");
  assert.equal(rows(db).length, 0, "the ticket is dropped when the issue is closed");
});

test("routine_claim without the cap (an older bridge): nothing is minted, filed or sent, the claim works as before", async () => {
  const db = migratedDb();
  directoryOf(db);
  const occ = dueFor(db, FREE_A);
  const f = fake(db, { caps: [] });
  const claim = await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, f.ctx(FREE_A));
  assert.equal(claim.claimed, true);
  assert.deepEqual(f.minted, []);
  assert.equal(rows(db).length, 0);
  assert.ok(f.sent.length > 0 && f.sent.every((s) => s.opts?.acting === undefined));
});

test("routine_claim with the cap and no ticket from the bridge: 503 acting_unavailable, nothing claimed, filed or sent (the agent asks again)", async () => {
  for (const mint of [() => new TbError("bridge_error", "down", 502), () => [], () => ["not-a-ticket"], () => [ticketOf("agt_not_an_agent_id")]]) {
    const db = migratedDb();
    directoryOf(db);
    const occ = dueFor(db, FREE_A);
    const f = fake(db, { caps: [acting.CAP_ACTING], mint });
    await assert.rejects(() => call(H, "routine_claim", { occurrence: occ }, f.ctx(FREE_A)), refusal("acting_unavailable", 503));
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM routine_runs").get()?.n), 0, "no claim");
    assert.equal(rows(db).length, 0);
    assert.deepEqual(f.sent, []);
    // the agent asks again and the bridge answers: the same occurrence is claimed once
    const ok = fake(db, { caps: [acting.CAP_ACTING] });
    assert.equal((await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, ok.ctx(FREE_A))).claimed, true);
  }
});

test("routine_claim: an occurrence that is not claimable (another agent's, or taken) files no ticket", async () => {
  const db = migratedDb();
  directoryOf(db);
  const occ = dueFor(db, FREE_A);
  const f = fake(db, { caps: [acting.CAP_ACTING] });
  const other = await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, f.ctx(FREE_B));
  assert.equal(other.claimed, false);
  assert.equal(rows(db).length, 0, "the ticket minted for the refused claim is not kept");
  assert.equal((await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, f.ctx(FREE_A))).claimed, true);
  assert.deepEqual(rows(db).map((x) => x.agent_id), [FREE_A.id]);
  const again = await call<K.RoutineClaimOutput>(H, "routine_claim", { occurrence: occ }, f.ctx(FREE_A));
  assert.equal(again.claimed, false);
  assert.equal(rows(db).length, 1, "still one row for the job");
});

test("tickets: one row per job and agent (a newer one replaces), at most 4 agents are sent, expired rows stay for the run that needs them and go long after", () => {
  const db = migratedDb();
  const now = Date.now();
  const agents = ["A", "B", "C", "D", "E"].map((c) => `agt_01J000000000000000000000${c}0`.slice(0, 30));
  for (const [i, a] of agents.entries()) acting.store(db, "job1", [ticketOf(a)], now + i);
  acting.store(db, "job1", [ticketOf(agents[0] as string)], now + 10); // replaces the first one, which becomes the newest
  assert.equal(rows(db, "job1").length, 5);
  const env = acting.envelopeFor(db, "job1", now + 20);
  assert.equal(env?.tickets.length, 4);
  assert.equal(env?.job, "job1");
  assert.equal(acting.envelopeFor(db, "nothing", now), null);
  // expired: not sent, still counted as "has tickets" (the run must fail, never go on unattributed), purged by the next store
  acting.store(db, "old", [ticketOf(agents[0] as string, Math.floor(now / 1000) - 10)], now - 100_000);
  assert.equal(acting.envelopeFor(db, "old", now), null);
  assert.equal(acting.hasTickets(db, "old"), true);
  acting.store(db, "job2", [ticketOf(agents[1] as string)], now);
  assert.equal(acting.hasTickets(db, "old"), true, "a ticket that just expired stays: a run that still needs it must stop on it");
  acting.store(db, "ancient", [ticketOf(agents[0] as string, Math.floor(now / 1000) - 61 * 86400)], now - 100 * 86400_000);
  acting.store(db, "job3", [ticketOf(agents[1] as string)], now);
  assert.equal(acting.hasTickets(db, "ancient"), false, "a row far past its expiry is cleaned up by the next claim");
  acting.drop(db, "job1");
  assert.equal(rows(db, "job1").length, 0);
});

test("job ids: a legal id is kept, anything else is hashed to a legal one, and the same input gives the same job", () => {
  assert.equal(acting.jobOfRun("flow-a", "run_1"), "run.flow-a.run_1");
  const odd = acting.jobOfRun("flow-a", `run ${"x".repeat(200)}`);
  assert.match(odd, /^h\.[0-9a-f]{40}$/);
  assert.equal(odd, acting.jobOfRun("flow-a", `run ${"x".repeat(200)}`));
  assert.match(acting.jobOfOccurrence("a".repeat(64)), /^rt\.a{64}$/);
});

test("a ticket is read for filing only: a payload that is not the bridge's shape is refused by mint (503), a plain callApp is untouched without an envelope", async () => {
  const db = migratedDb();
  const f = fake(db, { caps: [acting.CAP_ACTING], mint: () => [`${b64({})}.${b64({ sub: "tb:ins:ins_1", exp: 1 })}.s`] });
  await assert.rejects(() => acting.mint(f.ctx(FREE_A), "job"), refusal("acting_unavailable", 503));
  const calls: unknown[] = [];
  const record = async (p: string, o: string, i: unknown, opts?: Record<string, unknown>): Promise<void> => void calls.push([p, o, i, opts]);
  const plain = acting.withActing(record, null);
  await plain("kanban", "issues_list", {}, { idempotencyKey: "k" });
  assert.deepEqual(calls, [["kanban", "issues_list", {}, { idempotencyKey: "k" }]]);
  const wrapped = acting.withActing(record, { job: "j", tickets: ["t"] });
  await wrapped("kanban", "issues_list", {}, { idempotencyKey: "k" });
  assert.deepEqual(calls[1], ["kanban", "issues_list", {}, { idempotencyKey: "k", acting: { job: "j", tickets: ["t"] } }]);
});

test("migration 0014 on the data of 0.4.2 (0001-0013 with schedules, workflow versions and engine rows): two new empty tables, every existing row unchanged", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort();
  assert.equal(files.at(-1), "0014_acting_tickets.sql");
  for (const f of files.slice(0, -1)) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  // the live shape: a legacy workflow with a schedule and a run, an engine definition with an activation and a run
  raw.prepare("INSERT INTO drafts (id, title, summary, instruction, trigger_text, steps, allowed, revision, state, created_at, updated_at) VALUES ('d1', 'Jarvis', '', 'Do.', '08:00', '[]', '[]', 1, 'promoted', 1, 1)").run();
  raw.prepare("INSERT INTO workflows (id, title, summary, active_version, draft_id, created_at, updated_at) VALUES ('wf1', 'Jarvis', '', 1, 'd1', 1, 1)").run();
  raw.prepare("INSERT INTO automations (id, workflow_id, version_pin, policy_version, agent_id, cron, enabled, misfire_grace_sec, kanban_project, revision, next_due_at, created_at, updated_at) VALUES ('aut_1', 'wf1', NULL, 1, ?, '0 8 * * *', 1, 120, NULL, 1, 1, 1, 1)").run(FREE_A.id);
  raw.prepare("INSERT INTO engine_definitions (workflow_id, version, title, contract, digest, created_at) VALUES ('flow-j', 1, 'Flow', '{}', 'sha256:x', 1)").run();
  raw.prepare("INSERT INTO engine_activations (workflow_id, version, state, uses, activated_at, ended_at) VALUES ('flow-j', 1, 'active', '[]', 1, NULL)").run();
  const tables = (): string[] => raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => String(r.name));
  const counts = (): Record<string, number> => Object.fromEntries(tables().filter((n) => !n.startsWith("acting_")).map((n) => [n, Number(raw.prepare(`SELECT count(*) AS c FROM "${n}"`).get()?.c)]));
  const before = counts();
  const tablesBefore = tables();
  const digest = String(raw.prepare("SELECT group_concat(id || agent_id || cron || enabled || revision, '|') AS x FROM automations").get()?.x);
  raw.exec(readFileSync(join(migrationsDir, "0014_acting_tickets.sql"), "utf8"));
  assert.deepEqual(tables().filter((n) => !tablesBefore.includes(n)).sort(), ["acting_links", "acting_tickets"]);
  assert.deepEqual(counts(), before, "no existing table changed in size");
  assert.equal(String(raw.prepare("SELECT group_concat(id || agent_id || cron || enabled || revision, '|') AS x FROM automations").get()?.x), digest);
  for (const n of ["acting_tickets", "acting_links"]) assert.equal(Number(raw.prepare(`SELECT count(*) AS c FROM ${n}`).get()?.c), 0);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
});

test("run trees: a child run shares the job of its root run (3 levels at most); a run with no link is its own root", () => {
  const db = migratedDb();
  assert.equal(acting.rootJobOf(db, "flow-a", "r1"), acting.jobOfRun("flow-a", "r1"));
  acting.link(db, { workflowId: "flow-b", runId: "r1-b" }, { workflowId: "flow-a", runId: "r1" });
  acting.link(db, { workflowId: "flow-c", runId: "r1-c" }, { workflowId: "flow-b", runId: "r1-b" });
  assert.equal(acting.rootJobOf(db, "flow-c", "r1-c"), acting.jobOfRun("flow-a", "r1"));
  assert.equal(acting.rootJobOf(db, "flow-b", "r1-b"), acting.jobOfRun("flow-a", "r1"));
  acting.link(db, { workflowId: "flow-d", runId: "r1-d" }, { workflowId: "flow-c", runId: "r1-c" });
  acting.link(db, { workflowId: "flow-e", runId: "r1-e" }, { workflowId: "flow-d", runId: "r1-d" });
  assert.equal(acting.rootJobOf(db, "flow-e", "r1-e"), acting.jobOfRun("flow-b", "r1-b"), "a chain longer than the nesting limit stops at the limit");
  acting.unlink(db, { workflowId: "flow-c", runId: "r1-c" });
  assert.equal(acting.rootJobOf(db, "flow-c", "r1-c"), acting.jobOfRun("flow-c", "r1-c"));
});
