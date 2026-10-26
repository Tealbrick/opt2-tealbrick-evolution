// The two lines that join the agent steps to the engine (C367 M1), called once from `onStart` in src/app.ts and by the
// integration test: the engine's `ai` activity offers a step through the registered port (stored in agent_step_runs), and
// step_report / step_heartbeat complete or keep alive the Temporal activity with the engine's own client.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { registerAgentPort } from "../engine/agent-port.ts";
import { getTemporal } from "../engine/temporal.ts";
import { completionFromTemporal, setCompletionProvider } from "./completion.ts";
import { createAgentStepPort } from "./port.ts";

export function wireAgentSteps(db: Db): void {
  registerAgentPort(createAgentStepPort(db));
  setCompletionProvider(completionFromTemporal(getTemporal));
}
