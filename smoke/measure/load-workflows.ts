// WP1 measurement: the trivial workflows of the load run. Shapes follow what an Evolution run does: app steps (activities),
// a timer, and for one run in ten an approval wait (signal or timeout).
import { condition, defineSignal, proxyActivities, setHandler, sleep } from "@temporalio/workflow";
import type * as activities from "./load-activities.ts";

const { step } = proxyActivities<typeof activities>({ startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 3 } });

export const approve = defineSignal("approve");

export interface LoadRunInput {
  kind: "short" | "approval";
}

export async function loadRun(input: LoadRunInput): Promise<string> {
  let approved = false;
  setHandler(approve, () => {
    approved = true;
  });
  await step({ name: "read", workMs: 50 });
  if (input.kind === "approval") {
    const answered = await condition(() => approved, "15 minutes");
    await step({ name: answered ? "write" : "expire", workMs: 100 });
    return answered ? "approved" : "expired";
  }
  await sleep("5 seconds");
  await step({ name: "transform", workMs: 20 });
  await step({ name: "write", workMs: 100 });
  return "done";
}
