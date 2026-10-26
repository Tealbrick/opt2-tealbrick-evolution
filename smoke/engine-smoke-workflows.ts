// Workflow code of the WP1 smoke (bundled by the inline worker of engine-smoke.ts). Trivial on purpose: the smoke proves the
// service image and its persistence, not the Evolution interpreter (that is WP2).
import { condition, defineSignal, proxyActivities, setHandler, sleep } from "@temporalio/workflow";

interface Acts {
  step(input: { name: string; ms?: number }): Promise<string>;
}
const { step } = proxyActivities<Acts>({ startToCloseTimeout: "60 seconds", retry: { maximumAttempts: 3 } });

export const proceed = defineSignal("proceed");

/** one activity; used by the plain run and by every Schedule run */
export async function helloWorkflow(who: string): Promise<string> {
  return step({ name: `hello-${who}` });
}

/** A, then waits for the signal `proceed`, then B and C. In flight (waiting) while the backup is taken. */
export async function rtGate(): Promise<string> {
  let go = false;
  setHandler(proceed, () => {
    go = true;
  });
  await step({ name: "A" });
  await condition(() => go);
  await step({ name: "B" });
  await step({ name: "C" });
  return "done";
}

/** A, a 40 s timer, then B. The timer is pending while the backup is taken and restored. */
export async function rtTimer(): Promise<string> {
  await step({ name: "A" });
  await sleep("40 seconds");
  await step({ name: "B" });
  return "done";
}

/** a 12 s activity A that runs while the backup is taken, then B */
export async function rtLong(): Promise<string> {
  await step({ name: "A", ms: 12_000 });
  await step({ name: "B" });
  return "done";
}
