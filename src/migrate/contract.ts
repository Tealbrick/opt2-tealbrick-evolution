// A 0.3.x agent workflow version as an engine contract (C367 M3, ENGINE-BUILD §8): ONE `ai` step done by an agent card. The
// 0.3.x agent read the owner-reviewed instruction and steps and did the work with its own tools, then reported a summary;
// the same text is now the step's instruction, and the typed output is that summary. Pure: no database, no Temporal.

import type { JsonSchemaObject, WorkflowContract } from "../engine/contract.ts";
import type { Snapshot } from "../model.ts";
import type { Version } from "../store.ts";

/** The agent id a contract carries when no schedule names one. It is a valid id that no agent has: the owner chooses the agent
 *  in the editor, then saves and activates the new version. The engine refuses to offer a step to it (`agent_not_free`). */
export const UNASSIGNED_AGENT = "agt_unassigned";
export const STEP_ID = "agent_work";
/** 0.3.x: a dispatched run without a report after 30 minutes is uncertain (src/routines.ts DISPATCHED_TIMEOUT_MS). */
export const TIMEOUT_SEC = 1800;
export const MAX_INSTRUCTION = 8000;

export const OUTPUT_SCHEMA: JsonSchemaObject = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };

/** `wfl_01HZX…` -> `wfl-01hzx…`: the engine's workflow ids are lower case with hyphens (`^[a-z][a-z0-9-]{2,39}$`). */
export const engineIdOf = (legacyWorkflowId: string): string => legacyWorkflowId.toLowerCase().replaceAll("_", "-");

/** The instruction of the step: the version's instruction, its trigger text, its reviewed steps with their operations. */
export function instructionOf(v: Pick<Snapshot, "instruction" | "trigger" | "steps">): string {
  const parts: string[] = [];
  if (v.instruction.trim()) parts.push(v.instruction.trim());
  if (v.trigger.trim()) parts.push(`When: ${v.trigger.trim()}`);
  if (v.steps.length)
    parts.push(
      `Reviewed steps:\n${v.steps
        .map((s, i) => `${i + 1}. ${s.title}${s.instruction.trim() ? `: ${s.instruction.trim()}` : ""}${s.ops.length ? ` (operations: ${s.ops.map((o) => `${o.product}.${o.operation}`).join(", ")})` : ""}`)
        .join("\n")}`,
    );
  parts.push('Return {"summary": ...}: one short text that says what you did.');
  return parts.join("\n\n");
}

export interface Target {
  /** the agent card, or null: no schedule names a Free agent */
  agentId: string | null;
  /** the cron (UTC, 5 fields) of the first migrated schedule, for the contract's schedule trigger; null: none */
  cron: string | null;
}

export function contractOf(legacyWorkflowId: string, v: Version, target: Target): WorkflowContract {
  const unassigned = target.agentId === null;
  const note = `Moved from the 0.3.x workflow ${legacyWorkflowId}.${unassigned ? " No Free agent is scheduled for it: choose the agent in the editor, save a new version, then activate it." : ""}`;
  const summary = `${note} ${v.summary}`.trim().slice(0, 2000);
  return {
    format: "tealbrick.workflow/1",
    id: engineIdOf(legacyWorkflowId),
    version: v.version,
    title: v.title.slice(0, 200) || "Workflow",
    summary,
    triggers: [...(target.cron ? [{ kind: "schedule" as const, cron: target.cron, timezone: "UTC" }] : []), { kind: "manual" as const }],
    steps: [
      {
        id: STEP_ID,
        stage: "intelligence",
        type: "ai",
        by: { agent: target.agentId ?? UNASSIGNED_AGENT },
        instruction: instructionOf(v),
        inputs: {},
        outputSchema: structuredClone(OUTPUT_SCHEMA),
        timeoutSec: TIMEOUT_SEC,
        heartbeatSec: 0,
      },
    ],
  };
}
