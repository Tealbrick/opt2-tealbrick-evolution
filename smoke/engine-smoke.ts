// Engine service smoke (C367 WP1). Port of v1's temporal-external-mode.sh checklist (start the pinned image, reach it, run a
// workflow through a real worker, exercise a Schedule), without any Evolution code: @temporalio/client + worker with a trivial
// workflow only. A second part proves the backup -> restore round trip of the SQLite file with workflows in flight.
//
//   node smoke/engine-smoke.ts [smoke|roundtrip|all]          (default: all)
//   IMAGE          image to run (default localhost/evo-smoke-temporal:local; BUILD=1 builds it from the repo root first)
//   CONTAINER_CLI  podman | docker (default: podman if present, else docker)
//   KEEP=1         leave the container running at the end (prints its name); otherwise it is stopped (and removed: --rm)
// The container runs `run.sh` as uid 1000 with a fresh anonymous volume on /data, exactly as tb-exec starts it (tb-exec itself
// needs a bridge and is covered by the DEV deploy). Exit code 0 only if every check passed.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { Client, Connection, ScheduleNotFoundError, ScheduleOverlapPolicy, WorkflowNotFoundError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import type { helloWorkflow, rtGate, rtLong, rtTimer } from "./engine-smoke-workflows.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const mode = process.argv[2] ?? "all";
const image = process.env.IMAGE ?? "localhost/evo-smoke-temporal:local";
const cli = process.env.CONTAINER_CLI ?? (tryRun("podman", ["--version"]) ? "podman" : "docker");
const namespace = "evolution";
const taskQueue = "evo-smoke";

interface Check {
  name: string;
  ok: boolean;
  ms: number;
  detail?: unknown;
}
const checks: Check[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function tryRun(bin: string, args: string[]): boolean {
  try {
    execFileSync(bin, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function out(args: string[]): string {
  return execFileSync(cli, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function check<T>(name: string, fn: () => Promise<T>, detail?: (v: T) => unknown): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const v = await fn();
    checks.push({ name, ok: true, ms: Date.now() - t0, ...(detail ? { detail: detail(v) } : {}) });
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
    return v;
  } catch (e) {
    checks.push({ name, ok: false, ms: Date.now() - t0, detail: e instanceof Error ? e.message : String(e) });
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}
function expect(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

// ---------- container ----------
interface Svc {
  name: string;
  address: string;
}
async function startService(label: string): Promise<Svc> {
  const name = `evo-smoke-${label}-${process.pid}`;
  out(["run", "-d", "--rm", "--name", name, "--user", "1000:1000", "-e", "HOME=/tmp", "-v", "/data", "-p", "127.0.0.1::7233", "--entrypoint", "/opt/temporal/run.sh", image]);
  const mapped = out(["port", name, "7233/tcp"]).split("\n")[0] ?? "";
  const port = /:(\d+)$/.exec(mapped)?.[1];
  if (!port) throw new Error(`no host port for ${name}: ${mapped}`);
  return { name, address: `127.0.0.1:${port}` };
}
function stopService(svc: Svc): void {
  try {
    out(["stop", "-t", "10", svc.name]);
  } catch {
    // already gone
  }
}
async function waitServing(address: string, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000;
  for (let last = ""; Date.now() < until; await sleep(250)) {
    try {
      const c = await Connection.connect({ address, connectTimeout: 1500 });
      await c.withDeadline(Date.now() + 1500, () => c.workflowService.getSystemInfo({}));
      await c.close();
      return;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      if (Date.now() + 250 >= until) throw new Error(`not serving after ${seconds} s: ${last}`);
    }
  }
}

// ---------- inline worker ----------
const executions = new Map<string, number>();
const stepActivity = async (input: { name: string; ms?: number }): Promise<string> => {
  const id = Context.current().info.workflowExecution?.workflowId ?? "?";
  const key = `${id}/${input.name}`;
  executions.set(key, (executions.get(key) ?? 0) + 1);
  if (input.ms) await sleep(input.ms);
  return input.name;
};
const runsOf = (workflowId: string, name: string) => executions.get(`${workflowId}/${name}`) ?? 0;

async function withWorker<T>(address: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const native = await NativeConnection.connect({ address });
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });
  const worker = await Worker.create({
    connection: native,
    namespace,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("./engine-smoke-workflows.ts", import.meta.url)),
    activities: { step: stepActivity },
  });
  const running = worker.run();
  try {
    return await fn(client);
  } finally {
    worker.shutdown();
    await running;
    await connection.close();
    await native.close();
  }
}

// ---------- part 1: smoke ----------
async function smoke(): Promise<void> {
  const svc = await startService("smoke");
  try {
    const started = Date.now();
    await check("service answers gRPC on 7233", () => waitServing(svc.address, 90), () => ({ seconds: (Date.now() - started) / 1000 }));
    await check("schema equals the pinned CLI's (schema.sha256)", async () => {
      const want = readFileSync(join(root, "services/temporal/schema.sha256"), "utf8").split(/\s+/)[0];
      const have = out(["exec", svc.name, "/opt/temporal/schema-hash", "/data/temporal.db"]);
      expect(have === want, `schema hash ${have} != ${want}`);
    });
    await check("namespace evolution exists with 14 days retention", async () => {
      const c = await Connection.connect({ address: svc.address });
      try {
        let days = 0;
        for (let i = 0; i < 40 && days !== 14; i++) {
          const d = await c.workflowService.describeNamespace({ namespace });
          days = Number(d.config?.workflowExecutionRetentionTtl?.seconds ?? 0) / 86400;
          if (days !== 14) await sleep(1000);
        }
        expect(days === 14, `retention is ${days} days`);
      } finally {
        await c.close();
      }
    });
    await withWorker(svc.address, async (client) => {
      await check("workflow runs through a real worker", async () => {
        const r = await client.workflow.execute<typeof helloWorkflow>("helloWorkflow", { taskQueue, workflowId: "smoke-hello", args: ["plain"] });
        expect(r === "hello-plain", `result ${r}`);
      });
      await check("history and visibility list the run", async () => {
        const handle = client.workflow.getHandle("smoke-hello");
        const desc = await handle.describe();
        expect(desc.status.name === "COMPLETED", `status ${desc.status.name}`);
        let found = false;
        for (let i = 0; i < 20 && !found; i++) {
          for await (const w of client.workflow.list({ query: 'WorkflowId = "smoke-hello"' })) found = w.workflowId === "smoke-hello";
          if (!found) await sleep(500);
        }
        expect(found, "visibility did not list smoke-hello");
      });
      await schedule(client);
    });
    await check("server log is quiet (warn level: no ERROR lines)", async () => {
      const log = out(["logs", svc.name]);
      const errors = log.split("\n").filter((l) => /level=ERROR/.test(l));
      expect(errors.length === 0, `${errors.length} ERROR lines, first: ${errors[0]?.slice(0, 300)}`);
    });
  } finally {
    if (process.env.KEEP === "1") console.log(`kept ${svc.name} at ${svc.address}`);
    else stopService(svc);
  }
}

async function schedule(client: Client): Promise<void> {
  const scheduleId = "smoke-schedule";
  const handle = client.schedule.getHandle(scheduleId);
  const actions = async () => Number((await handle.describe()).info.numActionsTaken);
  const until = async (what: string, ok: () => Promise<boolean>, seconds: number) => {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      if (await ok()) return;
      await sleep(500);
    }
    throw new Error(`${what}: not within ${seconds} s`);
  };
  await check("schedule: create (every 2 s, skip overlap) and it fires by itself", async () => {
    await client.schedule.create({
      scheduleId,
      spec: { intervals: [{ every: "2s" }] },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
      action: { type: "startWorkflow", workflowType: "helloWorkflow", taskQueue, args: ["schedule"], workflowId: "smoke-sched-run" },
    });
    await until("first automatic action", async () => (await actions()) >= 1, 30);
  });
  await check("schedule: trigger runs once more", async () => {
    const before = await actions();
    await handle.trigger(ScheduleOverlapPolicy.ALLOW_ALL);
    await until("triggered action", async () => (await actions()) > before, 20);
    const recent = (await handle.describe()).info.recentActions.at(-1);
    const wfId = recent?.action.type === "startWorkflow" ? recent.action.workflow.workflowId : undefined;
    expect(typeof wfId === "string" && wfId.startsWith("smoke-sched-run"), `recent action ${wfId}`);
    const r = await client.workflow.getHandle(wfId as string).result();
    expect(r === "hello-schedule", `scheduled run result ${r}`);
  });
  await check("schedule: pause stops new runs, unpause resumes them", async () => {
    await handle.pause("smoke pause");
    await sleep(2500); // let a run that was already due settle
    const d = await handle.describe();
    expect(d.state.paused === true && d.state.note === "smoke pause", `state ${JSON.stringify(d.state)}`);
    const frozen = await actions();
    await sleep(7000);
    expect((await actions()) === frozen, "an action ran while paused");
    await handle.unpause("smoke resume");
    expect((await handle.describe()).state.paused === false, "still paused after unpause");
    await until("action after unpause", async () => (await actions()) > frozen, 20);
  });
  await check("schedule: delete removes it", async () => {
    await handle.delete();
    let gone = false;
    try {
      await handle.describe();
    } catch (e) {
      gone = e instanceof ScheduleNotFoundError;
    }
    expect(gone, "describe still answers after delete");
  });
}

// ---------- part 2: backup -> restore round trip ----------
function sh(svc: Svc, script: string): string {
  return out(["exec", svc.name, "sh", "-c", script]);
}
function pipeExec(svc: Svc, args: string[], stdin: number | "ignore", stdout: number | "inherit"): Promise<number> {
  return new Promise((resolve, reject) => {
    const p: ChildProcess = spawn(cli, ["exec", ...(stdin === "ignore" ? [] : ["-i"]), svc.name, ...args], { stdio: [stdin, stdout, "inherit"] });
    p.once("error", reject);
    p.once("exit", (code) => resolve(code ?? 1));
  });
}

async function roundtrip(): Promise<void> {
  const svc = await startService("roundtrip");
  const dir = mkdtempSync(join(tmpdir(), "evo-smoke-rt-"));
  const dumpFile = join(dir, "temporal.sqlite");
  try {
    await check("roundtrip: service answers", () => waitServing(svc.address, 90));
    await withWorker(svc.address, async (client) => {
      const ids = { gate: "rt-gate", timer: "rt-timer", long: "rt-long" };
      await check("roundtrip: start three workflows (waiting on a signal, on a 40 s timer, in a 12 s activity)", async () => {
        await client.workflow.start<typeof rtGate>("rtGate", { taskQueue, workflowId: ids.gate });
        await client.workflow.start<typeof rtTimer>("rtTimer", { taskQueue, workflowId: ids.timer });
        await client.workflow.start<typeof rtLong>("rtLong", { taskQueue, workflowId: ids.long });
        const end = Date.now() + 20_000;
        while (Date.now() < end && !(runsOf(ids.gate, "A") === 1 && runsOf(ids.timer, "A") === 1 && runsOf(ids.long, "A") === 1)) await sleep(200);
        expect(runsOf(ids.gate, "A") === 1 && runsOf(ids.timer, "A") === 1 && runsOf(ids.long, "A") === 1, "activities A did not start");
      });
      let dumpMs = 0;
      await check("roundtrip: dump with temporal-dump while the server runs", async () => {
        const t0 = Date.now();
        const fd = openSync(dumpFile, "w");
        const code = await pipeExec(svc, ["/opt/temporal/temporal-dump"], "ignore", fd);
        closeSync(fd);
        dumpMs = Date.now() - t0;
        expect(code === 0, `temporal-dump exit ${code}`);
        expect(statSync(dumpFile).size > 100_000, "dump is too small");
      }, () => ({ bytes: statSync(dumpFile).size, ms: dumpMs }));
      await check("roundtrip: a workflow started after the dump (must vanish on restore)", async () => {
        await client.workflow.start<typeof rtGate>("rtGate", { taskQueue, workflowId: "rt-after-dump" });
      });
      await check("roundtrip: a copy with another schema is refused and the server keeps running", async () => {
        sh(svc, "sqlite3 /tmp/bad.sqlite 'create table t(a);'");
        let refused = false;
        try {
          out(["exec", svc.name, "sh", "-c", "/opt/temporal/temporal-restore < /tmp/bad.sqlite"]);
        } catch {
          refused = true;
        }
        expect(refused, "temporal-restore accepted a foreign schema");
        const c = await Connection.connect({ address: svc.address });
        try {
          await c.withDeadline(Date.now() + 3000, () => c.workflowService.getSystemInfo({}));
        } finally {
          await c.close();
        }
        expect(await client.workflow.getHandle("rt-after-dump").describe().then(() => true, () => false), "the live state changed after a refused restore");
      });
      let restoreMs = 0;
      await check("roundtrip: restore with temporal-restore (stops the server, swaps the file, restarts)", async () => {
        const t0 = Date.now();
        const fd = openSync(dumpFile, "r");
        const code = await pipeExec(svc, ["/opt/temporal/temporal-restore"], fd, "inherit");
        closeSync(fd);
        restoreMs = Date.now() - t0;
        expect(code === 0, `temporal-restore exit ${code}`);
        sh(svc, "test -s /data/restore/previous.sqlite");
      }, () => ({ ms: restoreMs }));
      await check("roundtrip: the state is the dump's (the later workflow is gone, the three are back)", async () => {
        const gone = await client.workflow.getHandle("rt-after-dump").describe().then(() => false, (e: unknown) => e instanceof WorkflowNotFoundError);
        expect(gone, "rt-after-dump survived the restore");
        for (const id of Object.values(ids)) {
          const d = await client.workflow.getHandle(id).describe();
          expect(d.status.name === "RUNNING", `${id} is ${d.status.name}`);
        }
      });
      await check("roundtrip: all three finish after the restore, and no activity that finished before the dump runs again", async () => {
        const gate = client.workflow.getHandle(ids.gate);
        await gate.signal("proceed");
        const results = await Promise.all(Object.values(ids).map((id) => client.workflow.getHandle(id).result()));
        expect(results.every((r) => r === "done"), `results ${JSON.stringify(results)}`);
        const gateRuns = ["A", "B", "C"].map((n) => runsOf(ids.gate, n));
        const timerRuns = ["A", "B"].map((n) => runsOf(ids.timer, n));
        expect(JSON.stringify(gateRuns) === "[1,1,1]", `gate activity runs A,B,C = ${gateRuns}`);
        expect(JSON.stringify(timerRuns) === "[1,1]", `timer activity runs A,B = ${timerRuns}`);
      }, () => ({ gate: ["A", "B", "C"].map((n) => runsOf(ids.gate, n)), timer: ["A", "B"].map((n) => runsOf(ids.timer, n)) }));
      // The activity that was running while the dump was taken: Temporal gives at-least-once for it. Report, do not fail.
      checks.push({ name: "roundtrip: observation, activity in flight at the dump (rt-long A, B)", ok: true, ms: 0, detail: { A: runsOf(ids.long, "A"), B: runsOf(ids.long, "B"), note: "1 = completed once; 2 = re-dispatched after the restore (at-least-once)" } });
      console.log(`info rt-long runs: A=${runsOf(ids.long, "A")} B=${runsOf(ids.long, "B")}`);
    });
  } finally {
    if (process.env.KEEP === "1") console.log(`kept ${svc.name} at ${svc.address}`);
    else stopService(svc);
  }
}

if (!["smoke", "roundtrip", "all"].includes(mode)) {
  console.error("usage: node smoke/engine-smoke.ts [smoke|roundtrip|all]");
  process.exit(2);
}
if (process.env.BUILD === "1") {
  console.log(`building ${image} with ${cli}`);
  execFileSync(cli, ["build", "-t", image, "-f", "services/temporal/Dockerfile", "."], { cwd: root, stdio: "inherit" });
}
if (mode === "smoke" || mode === "all") await smoke();
if (mode === "roundtrip" || mode === "all") await roundtrip();
const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ image, cli, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
