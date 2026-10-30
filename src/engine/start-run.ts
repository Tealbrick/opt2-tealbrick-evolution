// Starts one run of a workflow now (manual trigger or a test). A Schedule starts runs by itself (schedules.ts).
import { ulid } from "@opt2-tealbrick/manifest";
import type { Json } from "./json.ts";
import { executionCeilingMs, type RunInput, TASK_QUEUE, WORKFLOW_TYPE } from "./run-types.ts";
import { getTemporal } from "./temporal.ts";

export interface StartRunInput {
  workflowId: string;
  version?: number | null;
  input?: Record<string, Json>;
  runId?: string;
  /** maxRunMinutes of the contract: the run gets a hard Temporal ceiling (F2) */
  maxRunMinutes?: number;
}

export const newRunId = (now: number = Date.now()): string => ulid(now);

/** Workflow id `evo:<workflowId>:<runId>` (ENGINE-BUILD §2). */
export async function startRun(a: StartRunInput): Promise<{ runId: string; temporalWorkflowId: string }> {
  const t = await getTemporal();
  if (!t.connected) throw new Error("temporal_unavailable");
  const runId = a.runId ?? newRunId();
  const args: RunInput = { workflowId: a.workflowId, version: a.version ?? null, runId, trigger: { kind: "manual", input: a.input ?? {} } };
  const temporalWorkflowId = `evo:${a.workflowId}:${runId}`;
  await t.client.workflow.start(WORKFLOW_TYPE, { taskQueue: TASK_QUEUE, workflowId: temporalWorkflowId, args: [args], workflowExecutionTimeout: executionCeilingMs(a.maxRunMinutes) });
  return { runId, temporalWorkflowId };
}
