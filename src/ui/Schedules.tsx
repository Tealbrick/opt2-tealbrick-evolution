// Schedules page (step B): run a promoted workflow on a cron schedule by one Bound agent, or (R1a) by an existing Free agent; pause, resume, delete;
// run history. Evolving Workflows never starts the agent: the agent's own `tealbrick agent serve` (routines mode) claims runs.
import type { UseAgents } from "@opt2-tealbrick/miniapp-sdk/client";
import { accessFilter, Button, CopyBlock, Dialog, EmptyState, Field, ListFilter, Notice, Select, type Status, Table, Tag, TextInput, useAccessFilter } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { EngineSchedules } from "./EngineSchedules.tsx";
import { FILTER_FROM, filterKey } from "./filtering.ts";
import { errorText, freeTargetText, type Out, person, utcDue, utcStamp } from "./ops.ts";

type Automation = Out<"automations_list">["automations"][number];
type Run = Out<"runs_list">["runs"][number];
export const STATUS: Record<Run["status"], Status> = { completed: "live", claimed: "busy", dispatched: "busy", failed: "needs-you", missed: "needs-you", uncertain: "needs-you", policy_stale: "needs-you" };
const SERVE_CONFIG = {
  format: "tealbrick.agent-serve/1",
  harness: { kind: "claude", modelKeyEnv: "ANTHROPIC_API_KEY" },
  pollSeconds: 60,
  inboxes: [],
  routines: [{ due: "evolution__routines_due", claim: "evolution__routine_claim", report: "evolution__routine_report", items: "jobs", id: "occurrence" }],
};

export function Schedules({ agents, agentsLoading, onOpenRuns, onOpenRun }: { agents: UseAgents["agents"]; agentsLoading: boolean; onOpenRuns?: () => void; onOpenRun?: (runId: string) => void }) {
  const [rows, setRows] = useState<Automation[] | null>(null);
  // null = not known yet (list not loaded): the New schedule form waits, so it never offers "no project" by mistake
  const [kanbanLinked, setKanbanLinked] = useState<boolean | null>(null);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [workflows, setWorkflows] = useState<Out<"workflows_list">["workflows"]>([]);
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [workflowsError, setWorkflowsError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    try {
      const r = await person("automations_list", {});
      setRows(r.automations);
      setKanbanLinked(r.kanbanLinked);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    person("workflows_list", {})
      .then((w) => {
        setWorkflows(w.workflows);
        setWorkflowsError(null);
      })
      .catch((e) => setWorkflowsError(`Workflows could not be loaded, so a new schedule can’t pick one. ${errorText(e)}`));
  }, [load]);
  const bound = agents.filter((a) => a.mode === "bound");
  const free = agents.filter((a) => a.mode === "free");
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const openId = open === undefined ? (rows?.[0]?.id ?? null) : open;
  const [query, setQuery] = useAccessFilter(filterKey("schedules"));
  const textFilter = accessFilter(query);
  const loaded = rows ?? [];
  const shownRows = loaded.filter((a) => textFilter.test([a.workflowTitle, a.workflowId, name(a.agentId), a.enabled ? "active" : "paused", a.cron].join(" ")));
  const showBar = rows !== null && (loaded.length >= FILTER_FROM || query.trim() !== "");

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="app-page" aria-label="Schedules">
      <div className="page-head">
        <div className="tb-stack head-text">
          <h1>Schedules</h1>
          <p className="tb-lede">What starts workflows by themselves. Engine schedules come first; the 0.3.x agent schedules below them are the older path.</p>
        </div>
      </div>
      <EngineSchedules onOpenRuns={onOpenRuns} onOpenRun={onOpenRun} />
      <div className="page-head legacy-head">
        <div className="tb-stack head-text">
          <h2 className="tb-h2">0.3.x agent schedules</h2>
          <p className="tb-lede">A schedule runs a promoted workflow with one Bound agent, or with an existing Free agent that keeps its own access. Every run is a Task Board issue assigned to the agent. Times are UTC.</p>
        </div>
        <Button onClick={() => setCreating(true)}>New agent schedule</Button>
      </div>
      {workflowsError ? (
        <Notice tone="needs-you" role="alert">
          {workflowsError}
        </Notice>
      ) : null}
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
      {rows === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading schedules.
          </p>
        )
      ) : rows.length === 0 ? (
        <EmptyState title="No agent schedules.">For a new workflow, use an engine schedule above. This older path needs a promoted draft and a Bound agent or a Free agent.</EmptyState>
      ) : (
        <>
        {showBar ? (
          <ListFilter label="Filter the agent schedules" value={query} onChange={setQuery} filter={textFilter} placeholder="Workflow, agent, or a regex" noun={{ one: "schedule", many: "schedules" }} shown={shownRows.length} total={loaded.length} onClear={() => setQuery("")} />
        ) : null}
        <div className="cards">
          {shownRows.map((a) => (
            <article key={a.id} className="tb-card">
              <div className="card-head">
                <h3>
                  {a.workflowTitle} <Tag status={a.enabled ? "live" : "idle"}>{a.enabled ? "active" : "paused"}</Tag>
                </h3>
                <div className="tb-ctas">
                  <Button size="sm" aria-expanded={openId === a.id} onClick={() => setOpen(openId === a.id ? null : a.id)}>
                    {openId === a.id ? "Hide runs" : "Show runs"}
                  </Button>
                  <Button size="sm" onClick={() => setEditing(a)}>
                    Edit
                  </Button>
                  <Button size="sm" onClick={() => void act(() => person("automation_pause", { id: a.id, revision: a.revision, paused: a.enabled }))}>
                    {a.enabled ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void act(() => person("automation_delete", { id: a.id, revision: a.revision }))}>
                    Delete
                  </Button>
                </div>
              </div>
              <p className="tb-hint">
                {name(a.agentId)}
                {a.targetMode === "free" ? " (Free agent)" : ""} · {a.cron} · next {utcStamp(a.effectiveNextDueAt)} · {a.versionPin ? `pinned v${a.versionPin}` : "active version"} · Task Board{" "}
                {a.kanbanProject ?? "own project of Evolving Workflows"}
              </p>
              {a.missedSince ? (
                <Notice tone="needs-you">
                  <strong>Runs were missed since {utcStamp(a.missedSince)}:</strong> the agent’s runner did not claim them in time. Check that tealbrick agent serve is running.
                </Notice>
              ) : null}
              {a.warnings.map((w) => (
                <Notice key={w.code} tone="needs-you">
                  {w.message}
                </Notice>
              ))}
              {a.targetMode === "free" ? <Notice role="status">{freeTargetText(name(a.agentId))}</Notice> : null}
              {openId === a.id ? <Runs id={a.id} /> : null}
            </article>
          ))}
        </div>
        </>
      )}
      <details className="history">
        <summary>Runner configuration for the Bound agent’s machine</summary>
        <div className="tb-stack">
          <p className="tb-hint">
            Evolving Workflows does not start the agent: the agent’s own runner (<code className="code-ops">tealbrick agent serve</code> in routines mode) asks for due runs and claims each one once.
          </p>
          <p className="tb-soft">Save as a file and start the runner with it on the machine where the Bound agent is connected (tealbrick agent serve).</p>
          <CopyBlock text={JSON.stringify(SERVE_CONFIG, null, 2)} label="runner configuration" />
        </div>
      </details>
      {editing ? (
        <EditSchedule
          automation={editing}
          agentName={name(editing.agentId)}
          activeVersion={workflows.find((w) => w.id === editing.workflowId)?.activeVersion ?? editing.policyVersion}
          kanbanLinked={kanbanLinked === true}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      ) : null}
      {creating ? (
        <NewSchedule
          workflows={workflows}
          bound={bound}
          free={free}
          agentsLoading={agentsLoading}
          kanbanLinked={kanbanLinked}
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false);
            await load();
          }}
        />
      ) : null}
    </section>
  );
}

function NewSchedule({
  workflows,
  bound,
  free,
  agentsLoading,
  kanbanLinked,
  onClose,
  onCreated,
}: {
  workflows: Out<"workflows_list">["workflows"];
  bound: UseAgents["agents"];
  free: UseAgents["agents"];
  agentsLoading: boolean;
  kanbanLinked: boolean | null;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) {
  const [form, setForm] = useState<{ workflowId: string; targetMode: "bound" | "free"; agentId: string; cron: string; kanbanProject: string }>({
    workflowId: "",
    targetMode: "bound",
    agentId: "",
    cron: "0 8 * * 1-5",
    kanbanProject: "",
  });
  const isFree = form.targetMode === "free";
  const choices = isFree ? free : bound;
  const chosen = choices.find((a) => a.id === form.agentId);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const create = async () => {
    setWorking(true);
    try {
      await person("automation_set", {
        workflowId: form.workflowId,
        agentId: form.agentId,
        ...(isFree ? { targetMode: "free" as const } : {}),
        cron: form.cron,
        ...(form.kanbanProject.trim() ? { kanbanProject: form.kanbanProject.trim() } : {}),
      });
      await onCreated();
    } catch (e) {
      setError(errorText(e));
      setWorking(false);
    }
  };
  return (
    <Dialog
      open
      kicker="Schedule"
      title="New schedule"
      onClose={onClose}
      busy={working}
      footer={
        <Button variant="primary" disabled={working || kanbanLinked === null || !form.workflowId || !form.agentId || (kanbanLinked && !form.kanbanProject.trim())} onClick={() => void create()}>
          Create schedule
        </Button>
      }
    >
      <div className="tb-stack">
        <Field label="Workflow">
          <Select
            value={form.workflowId}
            onValueChange={(workflowId) => setForm({ ...form, workflowId })}
            placeholder="Choose a workflow"
            options={workflows.map((w) => ({ value: w.id, label: `${w.title} (v${w.activeVersion})` }))}
          />
        </Field>
        <Field label="Agent type" hint="A Bound agent holds the recipe of the workflow: only its operations. A Free agent keeps its own access.">
          <Select
            value={form.targetMode}
            onValueChange={(targetMode) => setForm({ ...form, targetMode: targetMode === "free" ? "free" : "bound", agentId: "" })}
            options={[
              { value: "bound", label: "Bound agent" },
              { value: "free", label: "Free agent" },
            ]}
          />
        </Field>
        <Field
          label={isFree ? "Free agent" : "Bound agent"}
          hint={choices.length || agentsLoading ? undefined : isFree ? "No Free agent in this workspace." : "No Bound agent yet: apply a workflow’s recipe in Portal first."}
        >
          <Select value={form.agentId} onValueChange={(agentId) => setForm({ ...form, agentId })} placeholder="Choose an agent" options={choices.map((a) => ({ value: a.id, label: a.name }))} />
        </Field>
        {isFree ? <Notice role="status">{freeTargetText(chosen?.name ?? "the agent")}</Notice> : null}
        <Field label="Cron (UTC)" hint="minute hour day month weekday, for example 0 8 * * 1-5">
          <TextInput value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} maxLength={120} />
        </Field>
        <Field
          label="Task Board project for run issues"
          hint={
            kanbanLinked === null
              ? "Loading the schedules first: then this page knows if Task Board is connected."
              : kanbanLinked
                ? "Required. Use a project you share with the Bound agent in Task Board (its id), so the agent can read and comment on its runs."
                : "Task Board is not connected. If you connect it later, use a project you share with the Bound agent (its id)."
          }
        >
          <TextInput value={form.kanbanProject} onChange={(e) => setForm({ ...form, kanbanProject: e.target.value })} maxLength={64} />
        </Field>
        {error ? (
          <Notice tone="needs-you" role="alert">
            {error}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Edit: the project, the cron and "Recipe applied" (policyVersion) — what the warnings ask the owner to change. Every
 *  other field is sent unchanged, so an edit never clears the policy gate by itself. */
export function EditSchedule({
  automation: a,
  agentName = a.agentId,
  activeVersion,
  kanbanLinked,
  onClose,
  onSaved,
}: {
  automation: Automation;
  /** the agent's display name (the notice for a Free target names it) */
  agentName?: string;
  activeVersion: number;
  kanbanLinked: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({ cron: a.cron, kanbanProject: a.kanbanProject ?? "", policyVersion: String(a.policyVersion) });
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const project = form.kanbanProject.trim();
  const save = async () => {
    setWorking(true);
    try {
      await person("automation_set", {
        id: a.id,
        revision: a.revision,
        workflowId: a.workflowId,
        agentId: a.agentId,
        versionPin: a.versionPin,
        enabled: a.enabled,
        misfireGraceSec: a.misfireGraceSec,
        cron: form.cron,
        // a Free target has no applied recipe: policyVersion stays out (422 policy_version_not_applicable)
        ...(a.targetMode === "free" ? {} : { policyVersion: Number(form.policyVersion) }),
        kanbanProject: project || null,
      });
      await onSaved();
    } catch (e) {
      setError(errorText(e));
      setWorking(false);
    }
  };
  // the newest version, read when the dialog opens (a version promoted after the page loaded is offered too)
  const [latest, setLatest] = useState(activeVersion);
  useEffect(() => {
    person("workflow_versions", { workflowId: a.workflowId })
      .then((r) => setLatest(r.workflow.activeVersion))
      .catch(() => {});
  }, [a.workflowId]);
  const versions = Array.from({ length: Math.max(latest, activeVersion, a.policyVersion) }, (_, i) => String(i + 1));
  return (
    <Dialog
      open
      kicker="Schedule"
      title={`Edit ${a.workflowTitle}`}
      onClose={onClose}
      busy={working}
      footer={
        <Button variant="primary" disabled={working || (kanbanLinked && !project && a.kanbanProject !== null)} onClick={() => void save()}>
          Save
        </Button>
      }
    >
      <div className="tb-stack">
        <Field label="Cron (UTC)" hint="minute hour day month weekday, for example 0 8 * * 1-5">
          <TextInput value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} maxLength={120} />
        </Field>
        <Field label="Task Board project for run issues" hint="Use a project you share with the agent in Task Board (its id).">
          <TextInput value={form.kanbanProject} onChange={(e) => setForm({ ...form, kanbanProject: e.target.value })} maxLength={64} />
        </Field>
        {a.targetMode === "free" ? <Notice role="status">{freeTargetText(agentName)}</Notice> : null}
        {a.versionPin === null && a.targetMode !== "free" ? (
          <Field label="Recipe applied" hint="The workflow version whose recipe you applied to the agent in Portal. Choose a newer version only after you applied its recipe.">
            <Select value={form.policyVersion} onValueChange={(policyVersion) => setForm({ ...form, policyVersion })} options={versions.map((v) => ({ value: v, label: `version ${v}` }))} />
          </Field>
        ) : null}
        {error ? (
          <Notice tone="needs-you" role="alert">
            {error}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
}

function Runs({ id }: { id: string }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    person("runs_list", { automationId: id, limit: 50 })
      .then((r) => setRuns(r.runs))
      .catch((e) => setError(`Runs could not be loaded. ${errorText(e)}`));
  }, [id]);
  useEffect(load, [load]);
  if (error)
    return (
      <Notice tone="needs-you" role="alert">
        <span className="tb-row">
          <span>{error}</span>
          <Button size="sm" onClick={load}>
            Try again
          </Button>
        </span>
      </Notice>
    );
  if (!runs)
    return (
      <p className="tb-soft" role="status">
        Loading runs.
      </p>
    );
  if (runs.length === 0) return <p className="tb-soft">No runs yet.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <th scope="col">Due</th>
          <th scope="col">Status</th>
          <th scope="col">Version</th>
          <th scope="col">Task Board</th>
          <th scope="col">Summary</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.occurrence}>
            <td className="num">{utcDue(r.dueAt)}</td>
            <td>
              <Tag status={STATUS[r.status]}>{r.status}</Tag>
            </td>
            <td>{r.workflowVersion ? `v${r.workflowVersion}` : ""}</td>
            <td>{r.kanbanIssueId ? <code className="code-ops">{r.kanbanIssueId}</code> : r.kanbanSync === "failed" ? "not recorded" : ""}</td>
            <td>{r.summary ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
