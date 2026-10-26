// WP1 measurement: trivial activities for the load worker. Every execution is counted per (workflow id, activity name), so a
// repeat execution of the same activity of the same run shows up as a duplicate (the backup -> restore proof reads it).
import { Context } from "@temporalio/activity";

export interface StepInput {
  name: string;
  /** milliseconds the activity "works" */
  workMs: number;
}

export const executions = new Map<string, number>();

export function duplicateCount(): number {
  let dup = 0;
  for (const n of executions.values()) if (n > 1) dup += n - 1;
  return dup;
}

export async function step(input: StepInput): Promise<string> {
  const info = Context.current().info;
  const key = `${info.workflowExecution?.workflowId ?? "unknown"}:${input.name}`;
  executions.set(key, (executions.get(key) ?? 0) + 1);
  await new Promise((resolve) => setTimeout(resolve, input.workMs));
  return `${input.name}:${info.attempt}`;
}
