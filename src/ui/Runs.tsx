// Runs (C367 WP3, ENGINE-BUILD §7): the engine's run index. A list on the left, the run on the right as a step timeline: status,
// attempt and timing of each step, a link to the hold a step waits on, and a marker for an agent step that waits for its agent
// card (which card was offered the step, who claimed it, who timed out). Owner only (C88): the inputs and outputs of a step
// are shown when the engine gives them, and never to an agent.
import type { UseAgents } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Chip, ChipGroup, EmptyState, Notice, type Status, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { AGENT_STEP_LABEL, type EngineRun, type EngineRunStatus, type EngineRunStep, type EngineStepStatus, engine } from "./engine-ops.ts";
import { errorText, type Out, person, spanText, stamp } from "./ops.ts";

type AgentStep = Out<"agent_steps_list">["steps"][number];

export const RUN_STATUS: Record<EngineRunStatus, { status: Status; label: string }> = {
  running: { status: "busy", label: "running" },
  waiting: { status: "needs-you", label: "waiting" },
  completed: { status: "live", label: "completed" },
  failed: { status: "needs-you", label: "failed" },
  cancelled: { status: "idle", label: "cancelled" },
  timed_out: { status: "needs-you", label: "timed out" },
};
const STEP_STATUS: Record<EngineStepStatus, { status: Status; label: string }> = {
  pending: { status: "idle", label: "not started" },
  running: { status: "busy", label: "running" },
  sleeping: { status: "busy", label: "waiting (timer)" },
  completed: { status: "live", label: "completed" },
  failed: { status: "needs-you", label: "failed" },
  skipped: { status: "idle", label: "skipped" },
  waiting_hold: { status: "needs-you", label: "waiting for your approval" },
  waiting_approval: { status: "needs-you", label: "waiting for your answer" },
  waiting_agent: { status: "busy", label: "waiting for an agent" },
};
type Filter = "all" | "active" | "attention" | "done";
const FILTERS: { id: Filter; label: string; has: (s: EngineRunStatus) => boolean }[] = [
  { id: "all", label: "All", has: () => true },
  { id: "active", label: "Running", has: (s) => s === "running" || s === "waiting" },
  { id: "attention", label: "Needs attention", has: (s) => s === "failed" || s === "timed_out" || s === "waiting" },
  { id: "done", label: "Completed", has: (s) => s === "completed" },
];

export function Runs({ agents, openId, holdHref }: { agents: UseAgents["agents"]; openId?: string | null; holdHref: (holdId: string) => string }) {
  const [runs, setRuns] = useState<EngineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(openId ?? null);
  const load = useCallback(async () => {
    try {
      setRuns((await engine("engine_runs_list", { limit: 100 })).runs);
      setError(null);
    } catch (e) {
      setError(`Runs could not be loaded. ${errorText(e)}`);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (openId) setOpen(openId);
  }, [openId]);
  const accepts = FILTERS.find((f) => f.id === filter)?.has ?? (() => true);
  const shown = (runs ?? []).filter((r) => accepts(r.status));
  const current = open ?? shown[0]?.runId ?? null;
  return (
    <section className="app-page" aria-label="Runs">
      <div className="page-head">
        <div className="tb-stack head-text">
          <h1>Runs</h1>
          <p className="tb-lede">Every run of the engine, newest first. Open one to see its steps, what each step waits for, and how long it took.</p>
        </div>
        <Button onClick={() => void load()}>Refresh</Button>
      </div>
      {error ? (
        <Notice tone="needs-you" role="alert">
          <span className="tb-row">
            <span>{error}</span>
            <Button size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </span>
        </Notice>
      ) : null}
      {runs === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading runs.
          </p>
        )
      ) : runs.length === 0 ? (
        <EmptyState title="No runs yet.">Use Run now on an engine schedule, or wait for a trigger.</EmptyState>
      ) : (
        <>
          <ChipGroup label="Show runs">
            {FILTERS.map((f) => (
              <Chip key={f.id} pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
              </Chip>
            ))}
          </ChipGroup>
          <div className="two-pane">
            <nav className="pane-list" aria-label="Runs">
              {shown.length === 0 ? <p className="tb-soft">No run matches.</p> : null}
              {shown.map((r) => (
                <button key={r.runId} type="button" className="pane-item" aria-current={current === r.runId} onClick={() => setOpen(r.runId)}>
                  <span className="tb-ink">
                    {r.workflowTitle} <span className="tb-soft">v{r.version}</span>
                    <br />
                    <span className="tb-soft">{stamp(r.startedAt)}</span>
                  </span>
                  <Tag status={RUN_STATUS[r.status].status}>{RUN_STATUS[r.status].label}</Tag>
                </button>
              ))}
            </nav>
            {current ? <RunDetail key={current} runId={current} agents={agents} holdHref={holdHref} /> : <p className="tb-soft">Choose a run.</p>}
          </div>
        </>
      )}
    </section>
  );
}

const nameOf = (agents: UseAgents["agents"], id: string | null): string => (id ? (agents.find((a) => a.id === id)?.name ?? id) : "an agent");

export function RunDetail({ runId, agents, holdHref }: { runId: string; agents: UseAgents["agents"]; holdHref: (holdId: string) => string }) {
  const [data, setData] = useState<{ run: EngineRun; steps: EngineRunStep[] } | null>(null);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await engine("engine_run_get", { runId }));
      setError(null);
    } catch (e) {
      setError(`The run could not be loaded. ${errorText(e)}`);
    }
    try {
      setAgentSteps((await person("agent_steps_list", { runId, limit: 200 })).steps);
      setAgentError(null);
    } catch (e) {
      setAgentError(`The agent steps of this run could not be loaded. ${errorText(e)}`);
    }
  }, [runId]);
  useEffect(() => {
    void load();
  }, [load]);
  const live = data?.run.status === "running" || data?.run.status === "waiting";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [live, load]);

  if (error)
    return (
      <Notice tone="needs-you" role="alert">
        <span className="tb-row">
          <span>{error}</span>
          <Button size="sm" onClick={() => void load()}>
            Try again
          </Button>
        </span>
      </Notice>
    );
  if (!data)
    return (
      <p className="tb-soft" role="status">
        Loading the run.
      </p>
    );
  const { run, steps } = data;
  return (
    <article className="tb-card detail" aria-label={`Run ${run.runId}`}>
      <div className="detail-head">
        <h2>{run.workflowTitle}</h2>
        <Tag status={RUN_STATUS[run.status].status}>{RUN_STATUS[run.status].label}</Tag>
      </div>
      <p className="tb-hint">
        Version {run.version} · started by {run.trigger} {stamp(run.startedAt)}
        {run.endedAt ? ` · ended ${stamp(run.endedAt)} (${spanText(run.startedAt, run.endedAt)})` : ` · running for ${spanText(run.startedAt, null)}`} · {run.stepsDone}
        {run.stepsTotal ? ` of ${run.stepsTotal}` : ""} steps done{run.modelTokens ? ` · ${run.modelTokens} model tokens` : ""}
      </p>
      {run.error ? (
        <Notice tone="needs-you" role="alert">
          {run.error}
        </Notice>
      ) : null}
      {agentError ? (
        <Notice tone="needs-you" role="alert">
          {agentError}
        </Notice>
      ) : null}
      {steps.length === 0 ? (
        <p className="tb-soft">No step has started yet.</p>
      ) : (
        <ol className="timeline" aria-label="Step timeline">
          {steps.map((s, i) => {
            const st = STEP_STATUS[s.status];
            const agent = s.stepRunId ? agentSteps.find((a) => a.stepRunId === s.stepRunId) : undefined;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: loop iterations repeat a step id, so the position is the identity
              <li key={`${s.stepId}-${i}`}>
                <div className="timeline-head">
                  <b>{s.title ?? s.stepId}</b>
                  <Tag>{s.kind}</Tag>
                  <Tag status={st.status}>{st.label}</Tag>
                  {s.attempt > 1 ? <span className="tb-soft">attempt {s.attempt}</span> : null}
                  {s.startedAt ? (
                    <span className="tb-soft">
                      {stamp(s.startedAt)}
                      {s.endedAt ? `, took ${spanText(s.startedAt, s.endedAt)}` : ""}
                    </span>
                  ) : null}
                </div>
                {s.holdId ? (
                  <p className="tb-hint">
                    This call is held: it runs once you approve it. <a href={holdHref(s.holdId)}>Open the approval</a>
                  </p>
                ) : null}
                {s.status === "waiting_agent" || s.agentId ? (
                  <div className="agent-wait" data-step={s.stepId}>
                    {s.status === "waiting_agent" ? <Tag status="busy">{`waiting for ${nameOf(agents, agent?.claimedBy ?? s.agentId)}`}</Tag> : null}
                    <AgentHistory agents={agents} step={agent} fallbackAgent={s.agentId} />
                  </div>
                ) : null}
                {s.error ? <p className="tb-hint">{s.error}</p> : null}
                {s.input !== undefined || s.output !== undefined ? (
                  <details className="history">
                    <summary>Input and output (owner only)</summary>
                    <pre className="view">{JSON.stringify({ input: s.input, output: s.output }, null, 2)}</pre>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      {steps.some((s) => s.kind === "ai" && s.agentId) ? <p className="tb-hint">{AGENT_STEP_LABEL}</p> : null}
    </article>
  );
}

const KIND_TEXT: Record<AgentStep["events"][number]["kind"], string> = {
  offered: "offered",
  claimed: "claimed",
  completed: "answered",
  failed: "reported failed",
  timed_out: "timed out",
  cancelled: "cancelled",
};

/** Which card was offered the step, who claimed it, and where it timed out, attempt by attempt. */
export function AgentHistory({ agents, step, fallbackAgent }: { agents: UseAgents["agents"]; step: AgentStep | undefined; fallbackAgent: string | null }) {
  if (!step) return fallbackAgent ? <span className="tb-soft">Offered to {nameOf(agents, fallbackAgent)}.</span> : null;
  const attempts = [...new Set(step.events.map((e) => e.attempt))];
  return (
    <ul className="plain agent-history" aria-label={`History of the agent step ${step.stepId}`}>
      {attempts.map((n) => (
        <li key={n}>
          <span className="tb-soft">Attempt {n}: </span>
          {step.events
            .filter((e) => e.attempt === n)
            .map((e) => `${KIND_TEXT[e.kind]} ${e.kind === "offered" || e.kind === "claimed" ? `by ${nameOf(agents, e.agentId)} ` : ""}${stamp(e.at)}${e.detail ? ` (${e.detail})` : ""}`)
            .join(" · ")}
        </li>
      ))}
      {step.invalidReports > 0 ? <li className="tb-soft">{step.invalidReports} answer(s) did not match the output schema.</li> : null}
    </ul>
  );
}
