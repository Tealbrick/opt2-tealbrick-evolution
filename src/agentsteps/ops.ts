// The agent-step ops (ENGINE-BUILD §5): four agent ops (verified caller only, C237/C240) and one owner op for the step
// timeline. `agentStepHandlers(deps)` returns the handler map that src/app.ts spreads into its own; `deps.completion` is the
// way to the Temporal activity client (./completion.ts), `deps.now` the clock (tests).
//   steps_due       the caller's OFFERED steps (R1a: own agent + own mode + available)
//   step_claim      at most once; answers the instruction, typed inputs, output schema and the content-only note;
//                   it also counts as the first heartbeat, so Temporal's window starts at the claim
//   step_heartbeat  → client.activity.heartbeat(taskToken)
//   step_report     completed: the output is checked against the step's outputSchema (422 + pointer, the step stays claimed),
//                   then client.activity.complete; failed: client.activity.fail (the step's retry decides a re-offer)
// Temporal wins: when it says the activity is gone or cancelled, the table follows and the caller gets the refusal.
import { type HandlerSpec, type OpContext, TbError } from "@opt2-tealbrick/miniapp-sdk";
import type * as K from "#kit";
import { OP } from "#kit";
import * as acting from "../acting.ts";
import { type CompletionProvider, classify, tokenOf } from "./completion.ts";
import * as store from "./store.ts";

export interface AgentStepDeps {
  completion: CompletionProvider;
  now?: () => number;
}

function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  const run = spec.run;
  return {
    ...spec,
    run: async (input: I, ctx: OpContext) => {
      try {
        return await run(input, ctx);
      } catch (e) {
        throw e instanceof store.AgentStepError ? new TbError(e.code, e.message, e.httpStatus, e.details) : e;
      }
    },
  } as unknown as HandlerSpec;
}

export function agentStepHandlers(deps: AgentStepDeps) {
  const clock = deps.now ?? Date.now;

  /** Temporal rejected a call on a step: sort the error. gone / cancelled end the step here too and become the refusal. */
  function fromTemporal(ctx: OpContext, stepRunId: string, e: unknown): never {
    if (e instanceof store.AgentStepError) throw e;
    const kind = classify(e);
    if (kind === "gone") {
      store.markGone(ctx.db, stepRunId, "timed_out", "The engine no longer has this step open (it timed out or ended there).", clock());
      throw store.refusal("timed_out");
    }
    if (kind === "cancelled") {
      store.markGone(ctx.db, stepRunId, "cancelled", "The workflow asked to cancel this step.", clock());
      throw store.refusal("cancelled");
    }
    ctx.log.warn("agent step: the workflow engine did not answer", { stepRunId, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
    throw new store.AgentStepError("engine_unavailable", "The workflow engine did not answer. Your step is unchanged: try again in a moment.", 503);
  }

  return {
    [OP.stepsDue]: op<K.StepsDueInput, K.StepsDueOutput>({
      // Like routines_due: no receipt. Claims nothing.
      async run(_input, ctx) {
        return { steps: store.dueSteps(ctx.db, ctx.caller, clock()) };
      },
    }),
    [OP.stepClaim]: op<K.StepClaimInput, K.StepClaimOutput>({
      redact: (input, output) => `Claim step ${input.stepRunId.slice(0, 40)}: ${output ? (output.claimed ? "claimed" : output.reason) : "?"}`,
      async run(input, ctx) {
        // C380 dev.2: with the bridge cap `acting_agents`, the ticket of this agent's call is minted BEFORE the claim writes anything
        // (no ticket, no claim: 503, the agent asks again), and filed under the ROOT run of the tree, so that every later `app` step of
        // the run (and of its child runs) carries it. Only the agent the step is offered to gets one. A repeated claim of the same agent
        // mints again when the first ticket never reached the table. Without the cap: today's path.
        const peek = store.getRow(ctx.db, input.stepRunId);
        const mine = peek !== null && peek.agentId === ctx.caller.id && (peek.status === "offered" || peek.status === "claimed");
        const job = mine && peek ? acting.rootJobOf(ctx.db, peek.workflowId, peek.runId) : null;
        const needs = job !== null && acting.hasActingCap(ctx) && (peek?.status === "offered" || !acting.agentsOf(ctx.db, job).includes(ctx.caller.id));
        if (needs && job) {
          const held = acting.agentsOf(ctx.db, job);
          if (!held.includes(ctx.caller.id) && held.length >= acting.MAX_ACTING_AGENTS) throw new store.AgentStepError("acting_agents_full", "A run can have steps of 4 different agents at most. This step is not claimed.", 409);
        }
        const tickets = needs && job ? await acting.mint(ctx, job) : null;
        const r = store.claim(ctx.db, ctx.caller, input.stepRunId, clock());
        if (r.claimed && job && tickets) acting.store(ctx.db, job, tickets, clock());
        if (!r.claimed) return { claimed: false, reason: r.reason as NonNullable<K.StepClaimOutput["reason"]>, step: null };
        // The same agent asking again after a lost answer gets the same payload: a read, nothing to tell Temporal.
        if (r.replay) return { claimed: true, reason: null, step: r.step as unknown as NonNullable<K.StepClaimOutput["step"]> };
        // The claim is the first heartbeat. If Temporal no longer has the activity, the step is not claimable after all.
        try {
          await (await deps.completion()).heartbeat(tokenOf(r.row.taskToken));
        } catch (e) {
          if (e instanceof store.AgentStepError) ctx.log.warn("agent step: claimed without a heartbeat to the engine", { stepRunId: input.stepRunId, code: e.code });
          else {
            const kind = classify(e);
            if (kind !== "transient") {
              store.markGone(ctx.db, input.stepRunId, kind === "gone" ? "timed_out" : "cancelled", kind === "gone" ? "The engine no longer had this step open at the claim." : "The workflow asked to cancel this step.", clock());
              return { claimed: false, reason: kind === "gone" ? "timed_out" : "cancelled", step: null };
            }
            ctx.log.warn("agent step: claimed without a heartbeat to the engine", { stepRunId: input.stepRunId });
          }
        }
        return { claimed: true, reason: null, step: r.step as unknown as NonNullable<K.StepClaimOutput["step"]> };
      },
    }),
    [OP.stepHeartbeat]: op<K.StepHeartbeatInput, K.StepHeartbeatOutput>({
      async run(input, ctx) {
        const row = store.openClaimed(ctx.db, ctx.caller, input.stepRunId, clock());
        try {
          await (await deps.completion()).heartbeat(tokenOf(row.taskToken));
        } catch (e) {
          fromTemporal(ctx, input.stepRunId, e);
        }
        const r = store.beat(ctx.db, input.stepRunId, clock());
        return { stepRunId: r.stepRunId, status: "claimed", deadline: new Date(r.deadlineAt).toISOString(), heartbeatBy: store.heartbeatBy(r), heartbeatSec: r.heartbeatSec };
      },
    }),
    [OP.stepReport]: op<K.StepReportInput, K.StepReportOutput>({
      // never the summary or the numbers themselves: the agent wrote them (C88 / L12)
      redact: (input, output) => `Step ${input.stepRunId.slice(0, 40)}: ${input.status}${output ? ` (${output.status})` : ""}${input.metrics ? " (with metrics)" : ""}`,
      async run(input, ctx) {
        const view = (r: store.StepRow): K.StepReportOutput => ({
          stepRunId: r.stepRunId,
          status: r.status,
          attempt: r.attempt,
          outputBytes: r.outputBytes,
          summary: r.summary,
          finishedAt: r.finishedAt === null ? null : new Date(r.finishedAt).toISOString(),
        });
        let row: store.StepRow;
        try {
          row = store.openClaimed(ctx.db, ctx.caller, input.stepRunId, clock());
        } catch (e) {
          // Repeating the report that ended the step changes nothing and answers the stored state.
          if (e instanceof store.AgentStepError && e.code === "step_finished") {
            const done = store.getRow(ctx.db, input.stepRunId);
            if (done && done.claimedBy === ctx.caller.id && done.status === input.status) return view(done);
          }
          throw e;
        }
        const token = tokenOf(row.taskToken);
        const report: store.ReportInput = { status: input.status, output: input.output, summary: input.summary, metrics: input.metrics };
        if (input.status === "completed") {
          const checked = store.checkOutput(ctx.db, row, input.output, clock());
          try {
            await (await deps.completion()).complete(token, input.output);
          } catch (e) {
            fromTemporal(ctx, input.stepRunId, e);
          }
          return view(store.finish(ctx.db, input.stepRunId, "completed", report, checked, clock()));
        }
        const error = Object.assign(new Error(input.summary?.trim() || "The agent reported that it could not produce the output."), { name: "AgentStepFailed" });
        try {
          await (await deps.completion()).fail(token, error);
        } catch (e) {
          fromTemporal(ctx, input.stepRunId, e);
        }
        return view(store.finish(ctx.db, input.stepRunId, "failed", report, null, clock()));
      },
    }),
    [OP.agentStepsList]: op<K.AgentStepsListInput, K.AgentStepsListOutput>({
      // Owner only (person op): the summaries and numbers are free text from agents (C88 / L12).
      async run(input, ctx) {
        return { steps: store.listSteps(ctx.db, { runId: input.runId, workflowId: input.workflowId, limit: input.limit ?? 50 }, clock()) };
      },
    }),
  };
}
