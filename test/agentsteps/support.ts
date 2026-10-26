// Shared set-up of the agent-step tests: the agent directory, one promoted workflow, a fake Temporal activity client and a clock.

import { validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Caller, Db } from "@opt2-tealbrick/miniapp-sdk";
import { agentStepHandlers } from "../../src/agentsteps/ops.ts";
import { createAgentStepPort } from "../../src/agentsteps/port.ts";
import type { ActivityCompletion, AgentStepOffer, AgentStepPort } from "../../src/agentsteps/types.ts";
import { manifest } from "../../src/app.ts";
import * as directory from "../../src/directory.ts";
import * as store from "../../src/store.ts";
import { AGENT_A, AGENT_B, call, ctxFor, migratedDb } from "../helpers.ts";

export const FREE_A: Caller = { ...AGENT_A, mode: "free" };
export const FREE_B: Caller = { ...AGENT_B, mode: "free" };
export const BOUND_C: Caller = { type: "agent", id: "agt_01J0000000000000000000000C" as Caller["id"], name: "Agent C", mode: "bound" };
export const T0 = Date.parse("2026-10-26T08:00:00Z");

export const SCHEMA = {
  type: "object",
  required: ["bullets", "needsReply"],
  additionalProperties: false,
  properties: { bullets: { type: "array", items: { type: "string" }, maxItems: 5 }, needsReply: { type: "array", items: { type: "string" } } },
};
export const GOOD_OUTPUT = { bullets: ["a", "b"], needsReply: ["x"] };

export const b64 = (s: string) => Buffer.from(s).toString("base64");

/** A Temporal activity client that knows which task tokens are open, like the server does. */
export class FakeTemporal implements ActivityCompletion {
  calls: { kind: "complete" | "fail" | "heartbeat"; token: string; arg?: unknown }[] = [];
  open = new Set<string>();
  cancelRequested = new Set<string>();
  /** a transient failure (network) for the next calls */
  down = false;
  private check(kind: "complete" | "fail" | "heartbeat", token: Uint8Array, arg?: unknown): string {
    const t = Buffer.from(token).toString("utf8");
    this.calls.push({ kind, token: t, arg });
    if (this.down) throw new Error("14 UNAVAILABLE: connection refused");
    if (!this.open.has(t)) throw Object.assign(new Error("Not found"), { name: "ActivityNotFoundError" });
    if (kind === "heartbeat" && this.cancelRequested.has(t)) throw Object.assign(new Error("cancel requested"), { name: "ActivityCancelledError" });
    return t;
  }
  async heartbeat(token: Uint8Array, details?: unknown): Promise<void> {
    this.check("heartbeat", token, details);
  }
  async complete(token: Uint8Array, result: unknown): Promise<void> {
    this.open.delete(this.check("complete", token, result));
  }
  async fail(token: Uint8Array, error: Error): Promise<void> {
    this.open.delete(this.check("fail", token, error));
  }
  count(kind: "complete" | "fail" | "heartbeat"): number {
    return this.calls.filter((c) => c.kind === kind).length;
  }
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const withLog = (ctx: ReturnType<typeof ctxFor>): ReturnType<typeof ctxFor> => ({ ...ctx, log: quiet }) as ReturnType<typeof ctxFor>;

export interface Rig {
  db: Db;
  temporal: FakeTemporal;
  clock: { t: number };
  H: Parameters<typeof call>[0];
  port: AgentStepPort;
  workflowId: string;
  /** offers a step to `agent` (default Free A) and opens its fake Temporal activity */
  offer(extra?: Partial<AgentStepOffer>): Promise<AgentStepOffer>;
  as(caller: Caller): ReturnType<typeof ctxFor>;
  run<O>(id: string, input: unknown, caller?: Caller): Promise<O>;
}

export function rig(opts: { status?: "active" | "paused" } = {}): Rig {
  const db = migratedDb();
  const temporal = new FakeTemporal();
  const clock = { t: T0 };
  directory.recordDirectory(
    db,
    [FREE_A, FREE_B, BOUND_C].map((c) => ({ id: c.id as `agt_${string}`, name: c.name, mode: c.mode as "free" | "bound", status: opts.status ?? "active" })),
    T0,
  );
  const allowed = [{ product: "knowledge", operations: ["recall"], crud: ["read" as const] }];
  const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "Daily email summary", summary: "", instruction: "Summarise.", trigger: "08:00", steps: [], allowed } }, T0);
  const workflowId = store.promote(db, d.id, d.revision, T0).workflow.id;
  const H = agentStepHandlers({ completion: async () => temporal, now: () => clock.t }) as unknown as Parameters<typeof call>[0];
  const port = createAgentStepPort(db, () => clock.t);
  let n = 0;
  const r: Rig = {
    db,
    temporal,
    clock,
    H,
    port,
    workflowId,
    async offer(extra = {}) {
      n++;
      const o: AgentStepOffer = {
        stepRunId: `asr_${n}`,
        workflowId,
        version: 1,
        runId: `run_${n}`,
        stepId: "summary",
        agentId: FREE_A.id,
        instruction: "Summarize these emails for the owner.",
        inputs: { emails: [{ from: "a@example.com", subject: "hello" }] },
        outputSchema: SCHEMA,
        timeoutSec: 900,
        heartbeatSec: 60,
        attempt: 1,
        taskToken: b64(`tok-${n}`),
        ...extra,
      };
      temporal.open.add(Buffer.from(o.taskToken, "base64").toString("utf8"));
      await port.offer(o);
      return o;
    },
    as: (caller) => withLog(ctxFor(db, caller)),
    async run(id, input, caller = FREE_A) {
      // the SDK checks the input against the manifest first: a test input the manifest refuses is a test bug
      const op = (manifest.operations as { id: string; input?: unknown }[]).find((o) => o.id === id);
      const v = validateAgainstSchema(op?.input as never, JSON.parse(JSON.stringify(input)) as never);
      if (!v.ok) throw new Error(`${id} input fails the manifest schema: ${JSON.stringify(v.errors)}`);
      return call(H, id, input, withLog(ctxFor(db, caller)));
    },
  };
  return r;
}

/** `then` for a promise that must be refused with this code and status */
export const refused = (code: string, status: number) => (e: unknown) => {
  const t = e as { code?: string; httpStatus?: number };
  return t.code === code && t.httpStatus === status;
};
