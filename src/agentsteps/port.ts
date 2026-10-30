// The `AgentStepPort` the engine's `ai` activity calls (ENGINE-WP-COMMON): `offer` stores the step for its agent,
// `cancel` ends it when the workflow no longer waits for it. WP2 builds the port with the app database:
//   const port = createAgentStepPort(ctx.db)   // in onStart, next to the worker
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import * as store from "./store.ts";
import type { AgentStepOffer, AgentStepPort } from "./types.ts";

export function createAgentStepPort(db: Db, now: () => number = Date.now): AgentStepPort {
  return {
    async offer(o: AgentStepOffer): Promise<void> {
      store.offer(db, o, now());
    },
    async cancel(stepRunId: string): Promise<void> {
      store.cancel(db, stepRunId, now());
    },
  };
}
