// The seam between the engine (WP2) and the agent-step runtime (WP3). FIXED interface (ENGINE-WP-COMMON): change it only via
// the Evolution lead. WP2's `ai` activity with `by.agent` calls `port.offer(...)` and then completes asynchronously
// (CompleteAsyncError). WP3 stores the offer (`agent_step_runs`), serves steps_due / step_claim / step_heartbeat / step_report
// and completes the Temporal activity with `client.activity.complete(taskToken, output)` / `.fail(...)` / `.heartbeat(...)`.
import type { Json } from "./json.ts";

export interface AgentStepOffer {
  stepRunId: string;
  workflowId: string;
  version: number;
  runId: string;
  stepId: string;
  agentId: string;
  instruction: string;
  inputs: Record<string, unknown>;
  outputSchema: object;
  timeoutSec: number;
  heartbeatSec: number;
  attempt: number;
  /** base64 of the Temporal activity task token */
  taskToken: string;
}

export interface AgentStepPort {
  offer(o: AgentStepOffer): Promise<void>;
  cancel(stepRunId: string): Promise<void>;
}

/** What the engine uses when WP3 has not registered a port (the app boots, the step fails with a clear code). */
export const unavailablePort: AgentStepPort = {
  async offer() {
    throw new Error("agent_port_unavailable");
  },
  async cancel() {},
};

let port: AgentStepPort = unavailablePort;

/** WP3 calls this once at start-up (or a test installs a fake). */
export function registerAgentPort(p: AgentStepPort): void {
  port = p;
}
export function currentAgentPort(): AgentStepPort {
  return port;
}
export function resetAgentPort(): void {
  port = unavailablePort;
}

/** The model-role call of an `ai` step with `by.role` (M2: `modelRole(role)` from the SDK, then the provider call). */
export interface ModelRequest {
  role: string;
  instruction: string;
  inputs: Json;
  outputSchema: Json;
  maxTokens: number;
  timeoutSec: number;
  signal?: AbortSignal;
}
export interface ModelResponse {
  output: Json;
  tokensIn?: number;
  tokensOut?: number;
}
export interface ModelPort {
  run(req: ModelRequest): Promise<ModelResponse>;
}
/** M1: a role call is not implemented (M2). The step fails with `not_implemented`, which onFail handles. */
export const notImplementedModels: ModelPort = {
  async run() {
    throw new Error("not_implemented");
  },
};
let models: ModelPort = notImplementedModels;
export function registerModelPort(p: ModelPort): void {
  models = p;
}
export function currentModelPort(): ModelPort {
  return models;
}
export function resetModelPort(): void {
  models = notImplementedModels;
}
