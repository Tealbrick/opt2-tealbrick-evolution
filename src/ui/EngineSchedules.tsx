// Engine schedules (C367 WP3, ENGINE-BUILD §6): Temporal Schedules that start a workflow run. A schedule is a cron or an
// interval in an IANA time zone, with overlap skip (or buffer one). The owner can Run now, Pause, Edit and Delete.
// These are not the 0.3.x schedules above them (a Bound or Free agent that claims a run): the engine starts these itself.
import { Button, Dialog, EmptyState, Field, NativeSelect, Notice, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JsonObject } from "../engine/json.ts";
import type { WorkflowContract } from "./engine-contract.ts";
import { type EngineSchedule, engine } from "./engine-ops.ts";
import { MigratedBadge, useMigration } from "./Migration.tsx";
import { errorText, TIME_ZONES, zoned } from "./ops.ts";
import { missingInputs, ValuesForm } from "./SchemaForm.tsx";

/** A saved workflow the schedule can run: one entry per workflow id, titled by its newest version, with its active version
 *  (`workflow_contracts_list`; only an active workflow can be scheduled). */
type Workflow = { id: string; title: string; activeVersion: number | null };
// the unit letters of `every` ("15m", "6h", "1d")
const UNITS = [
  { value: "m", label: "minutes" },
  { value: "h", label: "hours" },
  { value: "d", label: "days" },
] as const;
const EVERY = /^[1-9][0-9]{0,3}[mhd]$/;
const CRON5 = /^\S+(\s+\S+){4}$/;

export function EngineSchedules({ onOpenRuns, onOpenRun }: { onOpenRuns?: () => void; onOpenRun?: (runId: string) => void }) {
  const [rows, setRows] = useState<EngineSchedule[] | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // the run that "Run now" started (its id comes back from the engine): the notice offers to open it
  const [noticeRun, setNoticeRun] = useState<string | null>(null);
  const [editing, setEditing] = useState<EngineSchedule | "new" | null>(null);
  const migration = useMigration();
  const busy = useRef(new Set<string>()); // C8: one call at a time per schedule, even for two clicks before React re-renders
  const [working, setWorking] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRows((await engine("schedules_list", {})).schedules);
      setError(null);
    } catch (e) {
      setError(`Engine schedules could not be loaded. ${errorText(e)}`);
    }
  }, []);
  useEffect(() => {
    void load();
    engine("workflow_contracts_list", {})
      .then((r) => {
        setWorkflows(workflowsOf(r.contracts));
      })
      .catch(() => {});
  }, [load]);

  const titleOf = (workflowId: string) => workflows.find((w) => w.id === workflowId)?.title ?? workflowId;
  const act = async (id: string, fn: () => Promise<void>) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    setWorking(id);
    try {
      await fn();
      setError(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      busy.current.delete(id);
      setWorking(null);
    }
  };

  return (
    <section className="tb-stack" aria-label="Engine schedules">
      <div className="page-head">
        <div className="tb-stack head-text">
          <h2 className="tb-h2">Engine schedules</h2>
          <p className="tb-lede">The engine starts these by itself, in the time zone you choose. If a run is still going when the next one is due, the next one is skipped.</p>
        </div>
        <Button variant="primary" onClick={() => setEditing("new")}>
          New engine schedule
        </Button>
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
      {notice ? (
        <Notice tone="live" role="status">
          <span className="tb-row">
            <span>{notice}</span>
            {noticeRun && onOpenRun ? (
              <Button size="sm" onClick={() => onOpenRun(noticeRun)}>
                Open the run
              </Button>
            ) : null}
            {onOpenRuns ? (
              <Button size="sm" onClick={onOpenRuns}>
                See runs
              </Button>
            ) : null}
            <Button size="sm" onClick={() => setNotice(null)}>
              Dismiss
            </Button>
          </span>
        </Notice>
      ) : null}
      {rows === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading engine schedules.
          </p>
        )
      ) : rows.length === 0 ? (
        <EmptyState title="No engine schedules yet.">Activate a workflow, then schedule it here.</EmptyState>
      ) : (
        <div className="cards">
          {rows.map((s) => (
            <article key={s.id} className="tb-card">
              <div className="card-head">
                <h3>
                  {titleOf(s.workflowId)} <Tag status={s.paused ? "idle" : "live"}>{s.paused ? "paused" : "active"}</Tag>
                  {migration.isMigratedSchedule(s.id) ? <MigratedBadge title="A 0.3.x schedule became this one. The old schedule is paused and kept for a rollback." /> : null}
                </h3>
                <div className="tb-ctas">
                  <Button
                    size="sm"
                    disabled={working === s.id}
                    onClick={() =>
                      void act(s.id, async () => {
                        const r = await engine("schedule_run_now", { id: s.id });
                        setNoticeRun(r.triggered ? r.runId : null);
                        // a poll schedule starts a run only when its read found a change; the run row exists a moment after the start
                        setNotice(r.triggered ? `Run ${r.runId} started.${s.kind === "poll" ? " A poll leaves no run when nothing changed." : ""}` : "The engine did not start a run. Try again in a moment.");
                      })
                    }
                  >
                    Run now
                  </Button>
                  <Button size="sm" disabled={working === s.id} onClick={() => void act(s.id, async () => void (await engine("schedule_pause", { id: s.id, revision: s.revision, paused: !s.paused })))}>
                    {s.paused ? "Resume" : "Pause"}
                  </Button>
                  <Button size="sm" onClick={() => setEditing(s)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="danger" disabled={working === s.id} onClick={() => void act(s.id, async () => void (await engine("schedule_delete", { id: s.id, revision: s.revision })))}>
                    Delete
                  </Button>
                </div>
              </div>
              <p className="tb-hint">
                {s.kind === "poll" ? "polls " : ""}
                {s.cron ? `cron ${s.cron}` : `every ${everyText(s.every)}`} · {s.timezone} · {s.versionPin ? `pinned v${s.versionPin}` : "active version"} · {s.overlap === "skip" ? "skips a run that would overlap" : "keeps one waiting run"}
              </p>
              <p className="tb-hint">
                {s.paused ? "Paused." : s.live?.nextRunAt ? `Next run ${zoned(s.live.nextRunAt, s.timezone)} (${s.timezone}).` : "No next run."}
                {s.live?.lastRunAt ? ` Last run ${zoned(s.live.lastRunAt, s.timezone)}.` : ""}
              </p>
              {syncNote(s) ? <p className="tb-hint">{syncNote(s)}</p> : null}
            </article>
          ))}
        </div>
      )}
      {editing ? (
        <ScheduleDialog
          schedule={editing === "new" ? null : editing}
          workflows={workflows}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      ) : null}
    </section>
  );
}

/** One entry per workflow id: the newest version's title and the active version (null = none is active). */
export function workflowsOf(contracts: readonly { workflowId: string; version: number; title: string; state: string | null }[]): Workflow[] {
  const seen = new Map<string, Workflow>();
  for (const c of [...contracts].sort((a, b) => b.version - a.version)) {
    const w = seen.get(c.workflowId) ?? { id: c.workflowId, title: c.title, activeVersion: null };
    if (c.state === "active") w.activeVersion = c.version;
    seen.set(c.workflowId, w);
  }
  return [...seen.values()];
}

/** "15m" → ["15", "m"]; anything else starts at 15 minutes. */
export function splitEvery(every: string | null): [string, string] {
  const m = every ? /^([1-9][0-9]{0,3})([mhd])$/.exec(every) : null;
  return m ? [m[1] as string, m[2] as string] : ["15", "m"];
}

/** "15m" → "15 min" */
export function everyText(every: string | null): string {
  const [n, u] = splitEvery(every);
  return u === "d" ? (n === "1" ? "1 day" : `${n} days`) : u === "h" ? `${n} h` : `${n} min`;
}

/** What the owner should know when Temporal does not yet match the saved schedule (it is created again when it can be). */
function syncNote(s: EngineSchedule): string | null {
  if (s.temporalState === "pending") return "Saved. The engine creates it as soon as Temporal answers.";
  if (s.temporalState === "error") return `The engine could not apply this schedule.${s.temporalError ? ` ${s.temporalError}` : ""}`;
  if (s.live?.state === "missing") return "Temporal does not know this schedule. The engine will create it again.";
  if (s.live?.state === "unreachable") return "Temporal cannot be reached, so the next run time is not known now.";
  return null;
}

function ScheduleDialog({ schedule: s, workflows, onClose, onSaved }: { schedule: EngineSchedule | null; workflows: Workflow[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [every0, unit0] = splitEvery(s?.every ?? null);
  const [form, setForm] = useState({
    workflowId: s?.workflowId ?? "",
    pin: s?.versionPin ? String(s.versionPin) : "",
    kind: (s?.kind ?? "schedule") as "schedule" | "poll",
    mode: s ? (s.cron ? "cron" : "every") : "cron",
    cron: s?.cron ?? "0 8 * * *",
    every: every0,
    unit: unit0,
    timezone: s?.timezone ?? "UTC",
    overlap: s?.overlap ?? "skip",
  });
  const [inputs, setInputs] = useState<JsonObject>((s?.input ?? {}) as JsonObject);
  // the contract of the version the schedule runs: its triggers fill the form, its inputs schema types the inputs
  const [contract, setContract] = useState<WorkflowContract | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const active = workflows.filter((w) => w.activeVersion !== null);
  const chosen = workflows.find((w) => w.id === form.workflowId);
  const runVersion = form.pin.trim() !== "" && Number.isInteger(Number(form.pin)) ? Number(form.pin) : (chosen?.activeVersion ?? null);
  useEffect(() => {
    if (!form.workflowId || runVersion === null) {
      setContract(null);
      return;
    }
    let gone = false;
    engine("workflow_contract_get", { workflowId: form.workflowId, version: runVersion })
      .then((r) => {
        if (gone) return;
        const c = r.contract as unknown as WorkflowContract;
        setContract(c);
        if (s) return; // an existing schedule keeps what it has
        const triggers = Array.isArray(c.triggers) ? c.triggers : [];
        const sched = triggers.find((t) => t.kind === "schedule");
        const poll = triggers.find((t) => t.kind === "poll");
        setForm((f) => {
          if (sched?.kind === "schedule") {
            const [n, u] = splitEvery(sched.every ?? null);
            return { ...f, kind: "schedule", mode: sched.cron ? "cron" : "every", cron: sched.cron ?? f.cron, every: n, unit: u, timezone: sched.timezone || f.timezone };
          }
          if (poll?.kind === "poll") {
            const [n, u] = splitEvery(poll.every);
            return { ...f, kind: "poll", mode: "every", every: n, unit: u };
          }
          return f;
        });
      })
      .catch(() => !gone && setContract(null));
    return () => {
      gone = true;
    };
  }, [form.workflowId, runVersion, s]);
  const hasPoll = (contract?.triggers ?? []).some((t) => t.kind === "poll");
  const everyValue = `${Number(form.every)}${form.unit}`;
  const missing = contract ? missingInputs(contract.inputs, inputs) : [];
  const problem = !form.workflowId
    ? "Choose a workflow."
    : chosen && chosen.activeVersion === null
      ? "This workflow has no active version. Activate one on the Activation page first."
      : form.kind === "poll" && contract && !hasPoll
        ? "This version has no poll trigger. Add one in the editor, or use a schedule."
        : form.kind === "schedule" && form.mode === "cron" && !CRON5.test(form.cron.trim())
          ? "A cron has 5 fields: minute hour day month weekday."
          : (form.kind === "poll" || form.mode === "every") && !EVERY.test(everyValue)
            ? "An interval is a whole number from 1 to 9999 of minutes, hours or days."
            : form.pin.trim() !== "" && !(Number.isInteger(Number(form.pin)) && Number(form.pin) >= 1)
              ? "A pinned version is a whole number from 1."
              : missing.length
                ? `Fill in ${missing.join(", ")}: every run of this schedule needs it.`
                : null;
  const save = async () => {
    setWorking(true);
    try {
      await engine("schedule_set", {
        ...(s ? { id: s.id, revision: s.revision } : {}),
        workflowId: form.workflowId,
        versionPin: form.pin.trim() === "" ? null : Number(form.pin),
        kind: form.kind,
        ...(form.kind === "schedule" && form.mode === "cron" ? { cron: form.cron.trim().replace(/\s+/g, " ") } : { every: everyValue }),
        timezone: form.timezone,
        overlap: form.overlap,
        input: inputs,
      });
      await onSaved();
    } catch (e) {
      setError(errorText(e));
      setWorking(false);
    }
  };
  return (
    <Dialog
      open
      kicker="Engine schedule"
      title={s ? `Edit ${workflows.find((w) => w.id === s.workflowId)?.title ?? s.workflowId}` : "New engine schedule"}
      onClose={onClose}
      busy={working}
      footer={
        <Button variant="primary" disabled={working || problem !== null} onClick={() => void save()}>
          {s ? "Save" : "Create schedule"}
        </Button>
      }
    >
      <div className="tb-stack">
        {!s && active.length === 0 ? <Notice tone="needs-you">No workflow is active yet. Save one in the editor and activate it on the Activation page; then it can be scheduled here.</Notice> : null}
        <Field label="Workflow" hint="Only active workflows run. The schedule takes its cron, interval and time zone from the workflow's trigger; you can change them.">
          <NativeSelect
            value={form.workflowId}
            disabled={Boolean(s)}
            onChange={(e) => setForm({ ...form, workflowId: e.target.value })}
            options={[{ value: "", label: "Choose a workflow" }, ...workflows.filter((w) => w.activeVersion !== null || w.id === form.workflowId).map((w) => ({ value: w.id, label: w.activeVersion !== null ? `${w.title} (version ${w.activeVersion} active)` : `${w.title} (not active)` }))]}
          />
        </Field>
        <Field label="Starts by">
          <NativeSelect
            value={form.kind}
            disabled={Boolean(s)}
            onChange={(e) => setForm({ ...form, kind: e.target.value as "schedule" | "poll", ...(e.target.value === "poll" ? { mode: "every" } : {}) })}
            options={[
              { value: "schedule", label: "Time: a cron or an interval" },
              { value: "poll", label: "Poll: read the app, run when something is new", disabled: contract !== null && !hasPoll },
            ]}
          />
        </Field>
        <Field label="Pinned version" hint="Leave empty to follow the active version.">
          <TextInput inputMode="numeric" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} />
        </Field>
        {form.kind === "schedule" ? (
          <Field label="Repeat">
            <NativeSelect
              value={form.mode}
              onChange={(e) => setForm({ ...form, mode: e.target.value })}
              options={[
                { value: "cron", label: "On a cron" },
                { value: "every", label: "Every so often" },
              ]}
            />
          </Field>
        ) : null}
        {form.kind === "schedule" && form.mode === "cron" ? (
          <Field label="Cron" hint="minute hour day month weekday, for example 0 8 * * 1-5. It runs in the time zone below.">
            <TextInput className="mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} maxLength={120} />
          </Field>
        ) : (
          <div className="two">
            <Field label="Every">
              <TextInput inputMode="numeric" value={form.every} onChange={(e) => setForm({ ...form, every: e.target.value })} />
            </Field>
            <Field label="Unit">
              <NativeSelect value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} options={UNITS.map((u) => ({ value: u.value, label: u.label }))} />
            </Field>
          </div>
        )}
        <Field label="Time zone" hint="An IANA name. Daylight saving follows the zone.">
          <NativeSelect value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} options={(TIME_ZONES.includes(form.timezone) ? TIME_ZONES : [form.timezone, ...TIME_ZONES]).map((z) => ({ value: z, label: z }))} />
        </Field>
        <Field label="If a run is still going">
          <NativeSelect
            value={form.overlap}
            onChange={(e) => setForm({ ...form, overlap: e.target.value as "skip" | "buffer_one" })}
            options={[
              { value: "skip", label: "Skip the new run" },
              { value: "buffer_one", label: "Keep one new run waiting" },
            ]}
          />
        </Field>
        {contract ? <ValuesForm label="Inputs for each run" schema={contract.inputs} value={inputs} onChange={setInputs} /> : null}
        {problem && (form.workflowId || s) ? <p className="tb-hint">{problem}</p> : null}
        {error ? (
          <Notice tone="needs-you" role="alert">
            {error}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
}
