// Runs (C367 WP3, ENGINE-BUILD §7): the engine's run index. A list on the left, the run on the right as a step timeline: status,
// attempt and timing of each step, a link to the hold a step waits on, and a marker for an agent step that waits for its agent
// card (which card was offered the step, who claimed it, who timed out). Owner only (C88): the inputs and outputs of a step
// are shown when the engine gives them, and never to an agent.
import type { UseAgents } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Chip, ChipGroup, CopyBlock, EmptyState, Notice, type Status, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { AGENT_STEP_LABEL, type EngineRun, type EngineRunStatus, type EngineRunStep, type EngineStepStatus, engine } from "./engine-ops.ts";
import { MigratedBadge, useMigration } from "./Migration.tsx";
import { errorText, type Out, person, spanText, stamp } from "./ops.ts";

type AgentStep = Out<"agent_steps_list">["steps"][number];

/** The runner config of a Free agent that answers workflow steps (ENGINE-BUILD §5: the routines mode of `tealbrick agent serve`
 *  with the step ops as due / claim / report). KNOWN GAP (C367 M3, checked against opt2-tealbrick-cli serve.ts pollRoutine): the
 *  CLI claims with `{occurrence}` and reports `{occurrence, status, summary}` whatever `id` says, and reads the claim answer's
 *  `job`; step_claim takes `{stepRunId}` and answers `step`, step_report takes `{stepRunId, status, output}`. Until the CLI
 *  has a steps mode (or sends the id under the name the op takes), this config is the shape to aim at, not one that runs. */
export const STEPS_SERVE_CONFIG = {
  format: "tealbrick.agent-serve/1",
  harness: { kind: "claude", modelKeyEnv: "ANTHROPIC_API_KEY" },
  pollSeconds: 60,
  inboxes: [],
  routines: [{ due: "evolution__steps_due", claim: "evolution__step_claim", report: "evolution__step_report", items: "steps", id: "stepRunId" }],
};

export const RUN_STATUS: Record<EngineRunStatus, { status: Status; label: string }> = {
  running: { status: "busy", label: "running" },
  completed: { status: "live", label: "completed" },
  failed: { status: "needs-you", label: "failed" },
  cancelled: { status: "idle", label: "cancelled" },
  timed_out: { status: "needs-you", label: "timed out" },
  terminated: { status: "idle", label: "stopped" },
  skipped: { status: "idle", label: "skipped" },
};
// the statuses the engine index stores for a step (WP2); an unknown one is shown as its own name
const STEP_STATUS: Record<EngineStepStatus, { status: Status; label: string }> = {
  running: { status: "busy", label: "running" },
  completed: { status: "live", label: "completed" },
  failed: { status: "needs-you", label: "failed" },
  skipped: { status: "idle", label: "skipped" },
  waiting_hold: { status: "needs-you", label: "waiting for your approval" },
  waiting_owner: { status: "needs-you", label: "waiting for your answer" },
  waiting_agent: { status: "busy", label: "waiting for an agent" },
};
const stepStatus = (s: string): { status: Status; label: string } => (s in STEP_STATUS ? STEP_STATUS[s as EngineStepStatus] : { status: "idle", label: s.replaceAll("_", " ") });
type Filter = "all" | "active" | "attention" | "done";
const FILTERS: { id: Filter; label: string; has: (s: EngineRunStatus) => boolean }[] = [
  { id: "all", label: "All", has: () => true },
  { id: "active", label: "Running", has: (s) => s === "running" },
  { id: "attention", label: "Needs attention", has: (s) => s === "failed" || s === "timed_out" },
  { id: "done", label: "Completed", has: (s) => s === "completed" },
];

export function Runs({ agents, openId, holdHref, onActivation }: { agents: UseAgents["agents"]; openId?: string | null; holdHref: (holdId: string) => string; onActivation?: () => void }) {
  const [runs, setRuns] = useState<EngineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(openId ?? null);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const migration = useMigration();
  const load = useCallback(async () => {
    engine("workflow_contracts_list", {})
      .then((r) => setTitles(new Map([...r.contracts].sort((a, b) => a.version - b.version).map((c) => [c.workflowId, c.title]))))
      .catch(() => {}); // the id is shown instead of a title
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
  // a run that is still running changes: keep the list current while one is shown as running
  const anyRunning = (runs ?? []).some((r) => r.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [anyRunning, load]);
  const accepts = FILTERS.find((f) => f.id === filter)?.has ?? (() => true);
  const shown = (runs ?? []).filter((r) => accepts(r.status));
  const current = open ?? shown[0]?.runId ?? null;
  const currentRun = (runs ?? []).find((r) => r.runId === current);
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
      ) : runs.length === 0 && !open ? (
        <EmptyState title="No runs yet.">
          Activate a workflow and use Run now on the Activation page, or create a schedule; its runs show here.
          {onActivation ? (
            <div>
              <Button variant="primary" onClick={onActivation}>
                Go to Activation
              </Button>
            </div>
          ) : null}
        </EmptyState>
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
                    {titles.get(r.workflowId) ?? r.workflowId} <span className="tb-soft">{r.version ? `v${r.version}` : ""}</span>
                    {migration.legacyWorkflowOf(r.workflowId) ? <MigratedBadge /> : null}
                    <br />
                    <span className="tb-soft">{stamp(r.startedAt)}</span>
                  </span>
                  <Tag status={RUN_STATUS[r.status].status}>{RUN_STATUS[r.status].label}</Tag>
                </button>
              ))}
            </nav>
            {current ? <RunDetail key={current} runId={current} title={currentRun ? titles.get(currentRun.workflowId) : undefined} migrated={currentRun ? migration.legacyWorkflowOf(currentRun.workflowId) !== null : false} agents={agents} holdHref={holdHref} fresh={current === openId} /> : <p className="tb-soft">Choose a run.</p>}
          </div>
        </>
      )}
      <details className="history">
        <summary>Runner configuration for an agent that answers workflow steps</summary>
        <div className="tb-stack">
          <p className="tb-hint">
            A workflow can ask a Free agent for content as one of its steps. The agent's own runner (<code className="code-ops">tealbrick agent serve</code>) asks for offered steps, claims one, works on it in a fresh session, keeps it alive with
            <code className="code-ops"> evolution__step_heartbeat</code> and reports the typed output. It returns the output only: the engine runs every action itself.
          </p>
          <CopyBlock text={JSON.stringify(STEPS_SERVE_CONFIG, null, 2)} label="step runner configuration" />
          <Notice role="status">
            Today <code className="code-ops">tealbrick agent serve</code> cannot claim or report steps with this configuration: it sends the id as <code className="code-ops">occurrence</code> and reads the answer as <code className="code-ops">job</code>, while the step operations take{" "}
            <code className="code-ops">stepRunId</code> and answer <code className="code-ops">step</code>. A Free agent with a Claude Code or Hermes skill can call the step operations directly. Bound agents keep the 0.3.x runner.
          </Notice>
        </div>
      </details>
    </section>
  );
}

const nameOf = (agents: UseAgents["agents"], id: string | null): string => (id ? (agents.find((a) => a.id === id)?.name ?? id) : "an agent");

/** `fresh`: the run was started a moment ago (Run now), so a missing index row means "starting", not "gone". */
export function RunDetail({ runId, title, migrated = false, agents, holdHref, fresh = false }: { runId: string; title?: string; migrated?: boolean; agents: UseAgents["agents"]; holdHref: (holdId: string) => string; fresh?: boolean }) {
  const [data, setData] = useState<{ run: EngineRun; steps: EngineRunStep[]; outputs: Record<string, unknown> | null } | null>(null);
  const [agentSteps, setAgentSteps] = useState<AgentStep[]>([]);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(0);
  const load = useCallback(async () => {
    try {
      setData(await engine("engine_run_get", { runId }));
      setError(null);
      setStarting(0);
    } catch (e) {
      // a run started a moment ago is in the index once its first activity ran: ask again a few times before saying it is missing
      if (fresh && (e as { code?: unknown } | null)?.code === "not_found") {
        setStarting((n) => {
          if (n < 10) return n + 1;
          setError(`The run could not be loaded. ${errorText(e)}`);
          return n;
        });
        return;
      }
      setError(`The run could not be loaded. ${errorText(e)}`);
    }
    try {
      setAgentSteps((await person("agent_steps_list", { runId, limit: 200 })).steps);
      setAgentError(null);
    } catch (e) {
      setAgentError(`The agent steps of this run could not be loaded. ${errorText(e)}`);
    }
  }, [runId, fresh]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (starting === 0 || data) return;
    const t = setTimeout(() => void load(), 1_500);
    return () => clearTimeout(t);
  }, [starting, data, load]);
  const live = data?.run.status === "running";
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
        {starting ? "The run is starting." : "Loading the run."}
      </p>
    );
  const { run, steps, outputs } = data;
  return (
    <article className="tb-card detail" aria-label={`Run ${run.runId}`}>
      <div className="detail-head">
        <h2>{title ?? run.workflowId}</h2>
        {migrated ? <MigratedBadge /> : null}
        <Tag status={RUN_STATUS[run.status].status}>{RUN_STATUS[run.status].label}</Tag>
      </div>
      <p className="tb-hint">
        {run.version ? `Version ${run.version} · ` : ""}started by {run.triggerKind} {stamp(run.startedAt)}
        {run.endedAt ? ` · ended ${stamp(run.endedAt)} (${spanText(run.startedAt, run.endedAt)})` : ` · running for ${spanText(run.startedAt, null)}`} · {run.stepsDone} steps done
        {run.stepsFailed ? `, ${run.stepsFailed} failed` : ""}
        {run.modelTokens ? ` · ${run.modelTokens} model tokens` : ""}
      </p>
      {run.errorCode ? (
        <Notice tone="needs-you" role="alert">
          {`The run stopped${run.errorStep ? ` at step ${run.errorStep}` : ""}: ${run.errorCode.replaceAll("_", " ")}.`}
        </Notice>
      ) : null}
      {run.skippedReason ? <p className="tb-hint">{`Skipped: ${run.skippedReason.replaceAll("_", " ")}.`}</p> : null}
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
            const st = stepStatus(s.status);
            const agent = s.stepRunId ? agentSteps.find((a) => a.stepRunId === s.stepRunId) : undefined;
            return (
              <li key={s.stepKey || `${s.stepId}-${i}`}>
                <div className="timeline-head">
                  <b>{s.loopPath ? `${s.stepId} (loop ${s.loopPath})` : s.stepId}</b>
                  <Tag>{s.kind}</Tag>
                  <Tag status={st.status}>{st.label}</Tag>
                  {s.product && s.op ? <span className="tb-soft">{`${s.product}.${s.op}`}</span> : null}
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
                {s.errorCode ? <p className="tb-hint">{s.errorCode.replaceAll("_", " ")}</p> : null}
                {s.error ? <p className="tb-hint">{s.error}</p> : null}
                {s.holdOutcome ? <p className="tb-hint">{`Approval: ${s.holdOutcome.replaceAll("_", " ")}.`}</p> : null}
                <StepIo step={s} />
              </li>
            );
          })}
        </ol>
      )}
      {outputs ? (
        <details className="history">
          <summary>Result of the run (owner only)</summary>
          <pre className="view">{JSON.stringify(outputs, null, 2)}</pre>
        </details>
      ) : null}
      {steps.some((s) => s.kind === "ai" && s.agentId) ? <p className="tb-hint">{AGENT_STEP_LABEL}</p> : null}
    </article>
  );
}

/** What a step got and gave (C88: owner only; the engine reads it from the Temporal history, never from app.db). */
export function StepIo({ step }: { step: EngineRunStep }) {
  const has = (v: unknown) => v !== undefined && v !== null;
  if (!has(step.input) && !has(step.output)) return null;
  return (
    <details className="history step-io">
      <summary>{has(step.output) ? "Input and output (owner only)" : "Input (owner only)"}</summary>
      {has(step.input) ? (
        <>
          <p className="tb-label">Input</p>
          <pre className="view">{JSON.stringify(step.input, null, 2)}</pre>
        </>
      ) : null}
      {has(step.output) ? (
        <>
          <p className="tb-label">Output</p>
          <pre className="view">{JSON.stringify(step.output, null, 2)}</pre>
        </>
      ) : null}
    </details>
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
