// WP1 measurement: about 100 workflow runs per hour (plus a 5-minute Schedule) through a trivial worker, against one
// Temporal address. Prints one JSON line per minute (counters, duplicate activity executions, own RSS) and a final line.
//   TEMPORAL_ADDRESS (default 127.0.0.1:7233)  NAMESPACE (evolution)  TASK_QUEUE (evo-wp1-load)
//   RATE_PER_HOUR (100)  DURATION_HOURS (25; 0 = until stopped)  SCHEDULE_EVERY_MIN (5; 0 = no Schedule)
import { fileURLToPath } from "node:url";
import { Client, Connection, ScheduleOverlapPolicy } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./load-activities.ts";
import type { loadRun } from "./load-workflows.ts";

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const namespace = process.env.NAMESPACE ?? "evolution";
const taskQueue = process.env.TASK_QUEUE ?? "evo-wp1-load";
const ratePerHour = Number(process.env.RATE_PER_HOUR ?? "100");
const durationHours = Number(process.env.DURATION_HOURS ?? "25");
const scheduleEveryMin = Number(process.env.SCHEDULE_EVERY_MIN ?? "5");

const counters = { started: 0, completed: 0, failed: 0, approvalsSent: 0 };
const timers = new Set<NodeJS.Timeout>();
const inflight = new Set<Promise<void>>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function connectWithRetry(): Promise<{ client: Client; native: NativeConnection }> {
  for (let i = 0; ; i++) {
    try {
      const connection = await Connection.connect({ address });
      const native = await NativeConnection.connect({ address });
      return { client: new Client({ connection, namespace }), native };
    } catch (e) {
      if (i > 120) throw e;
      await sleep(2000);
    }
  }
}

async function main(): Promise<void> {
  const { client, native } = await connectWithRetry();
  const worker = await Worker.create({
    connection: native,
    namespace,
    taskQueue,
    workflowsPath: fileURLToPath(new URL("./load-workflows.ts", import.meta.url)),
    activities,
  });
  const workerDone = worker.run();
  const t0 = Date.now();
  const deadline = durationHours > 0 ? t0 + durationHours * 3_600_000 : Number.POSITIVE_INFINITY;
  console.log(JSON.stringify({ event: "start", address, namespace, taskQueue, ratePerHour, durationHours, scheduleEveryMin }));

  if (scheduleEveryMin > 0) {
    const scheduleId = `${taskQueue}-schedule`;
    try {
      await client.schedule.getHandle(scheduleId).delete();
    } catch {
      // not there yet
    }
    await client.schedule.create({
      scheduleId,
      spec: { intervals: [{ every: `${scheduleEveryMin}m` }] },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
      action: { type: "startWorkflow", workflowType: "loadRun", taskQueue, args: [{ kind: "short" }], workflowId: `${taskQueue}-sched-run` },
    });
  }

  const reporter = setInterval(() => {
    console.log(JSON.stringify({ event: "tick", minutes: Math.round((Date.now() - t0) / 60000), ...counters, activityExecutions: activities.executions.size, duplicateExecutions: activities.duplicateCount(), rssMb: Math.round(process.memoryUsage().rss / 1048576) }));
  }, 60_000);

  let seq = 0;
  const meanGapMs = 3_600_000 / ratePerHour;
  while (Date.now() < deadline) {
    const kind: "short" | "approval" = Math.random() < 0.1 ? "approval" : "short";
    const workflowId = `${taskQueue}-run-${++seq}`;
    try {
      const handle = await client.workflow.start<typeof loadRun>("loadRun", { taskQueue, workflowId, args: [{ kind }] });
      counters.started++;
      const p = handle.result().then(
        () => {
          counters.completed++;
        },
        () => {
          counters.failed++;
        },
      );
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
      if (kind === "approval") {
        const t = setTimeout(
          () => {
            timers.delete(t);
            client.workflow
              .getHandle(workflowId)
              .signal("approve")
              .then(() => {
                counters.approvalsSent++;
              })
              .catch(() => {});
          },
          60_000 + Math.random() * 9 * 60_000,
        );
        timers.add(t);
      }
    } catch (e) {
      counters.failed++;
      console.log(JSON.stringify({ event: "start_failed", workflowId, message: e instanceof Error ? e.message : String(e) }));
    }
    await sleep(meanGapMs * (0.5 + Math.random()));
  }

  // drain: the longest wait is the 15-minute approval timeout
  const drainUntil = Date.now() + 20 * 60_000;
  while (inflight.size > 0 && Date.now() < drainUntil) await sleep(5000);
  clearInterval(reporter);
  for (const t of timers) clearTimeout(t);
  if (scheduleEveryMin > 0) await client.schedule.getHandle(`${taskQueue}-schedule`).delete().catch(() => {});
  console.log(JSON.stringify({ event: "final", hours: (Date.now() - t0) / 3_600_000, ...counters, activityExecutions: activities.executions.size, duplicateExecutions: activities.duplicateCount(), stillRunning: inflight.size }));
  worker.shutdown();
  await workerDone;
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
