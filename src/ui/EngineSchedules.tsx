// Engine schedules (C367 WP3, ENGINE-BUILD §6): Temporal Schedules that start a workflow run. A schedule is a cron or an
// interval in an IANA time zone, with overlap skip (or buffer one). The owner can Run now, Pause, Edit and Delete.
// These are not the 0.3.x schedules above them (a Bound or Free agent that claims a run): the engine starts these itself.
import { Button, Dialog, EmptyState, Field, NativeSelect, Notice, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { type EngineSchedule, engine } from "./engine-ops.ts";
import { errorText, everyText, type Out, person, TIME_ZONES, zoned } from "./ops.ts";

type Workflow = Out<"workflows_list">["workflows"][number];
const UNITS = [
  { value: "60", label: "minutes" },
  { value: "3600", label: "hours" },
  { value: "86400", label: "days" },
] as const;
const CRON5 = /^\S+(\s+\S+){4}$/;

export function EngineSchedules({ onOpenRun }: { onOpenRun?: (runId: string) => void }) {
  const [rows, setRows] = useState<EngineSchedule[] | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; runId: string | null } | null>(null);
  const [editing, setEditing] = useState<EngineSchedule | "new" | null>(null);
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
    person("workflows_list", {})
      .then((r) => setWorkflows(r.workflows))
      .catch(() => {});
  }, [load]);

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
            <span>{notice.text}</span>
            {notice.runId && onOpenRun ? (
              <Button size="sm" onClick={() => onOpenRun(notice.runId as string)}>
                Open run
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
                  {s.workflowTitle} <Tag status={s.paused ? "idle" : "live"}>{s.paused ? "paused" : "active"}</Tag>
                </h3>
                <div className="tb-ctas">
                  <Button
                    size="sm"
                    disabled={working === s.id}
                    onClick={() =>
                      void act(s.id, async () => {
                        const r = await engine("schedule_run_now", { id: s.id });
                        setNotice({ text: `Started run ${r.runId}.`, runId: r.runId });
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
                {s.cron ? `cron ${s.cron}` : `every ${everyText(s.everySec ?? 0)}`} · {s.timezone} · {s.version ? `pinned v${s.version}` : "active version"} · {s.overlap === "skip" ? "skips a run that would overlap" : "keeps one waiting run"}
              </p>
              <p className="tb-hint">
                {s.paused ? "Paused." : s.nextRunAt ? `Next run ${zoned(s.nextRunAt, s.timezone)} (${s.timezone}).` : "No next run."}
                {s.lastRunAt ? ` Last run ${zoned(s.lastRunAt, s.timezone)}${s.lastRunStatus ? `, ${s.lastRunStatus.replace("_", " ")}` : ""}.` : ""}
              </p>
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

/** Seconds → [value, unit seconds] in the largest unit that divides it. */
export function splitEvery(sec: number): [string, string] {
  for (const u of [86_400, 3_600, 60]) if (sec % u === 0) return [String(sec / u), String(u)];
  return [String(Math.max(1, Math.round(sec / 60))), "60"];
}

function ScheduleDialog({ schedule: s, workflows, onClose, onSaved }: { schedule: EngineSchedule | null; workflows: Workflow[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [every0, unit0] = splitEvery(s?.everySec ?? 900);
  const [form, setForm] = useState({
    workflowId: s?.workflowId ?? "",
    pin: s?.version ? String(s.version) : "",
    mode: s ? (s.cron ? "cron" : "every") : "cron",
    cron: s?.cron ?? "0 8 * * *",
    every: every0,
    unit: unit0,
    timezone: s?.timezone ?? "UTC",
    overlap: s?.overlap ?? "skip",
  });
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const everySec = Number(form.every) * Number(form.unit);
  const problem =
    !form.workflowId
      ? "Choose a workflow."
      : form.mode === "cron" && !CRON5.test(form.cron.trim())
        ? "A cron has 5 fields: minute hour day month weekday."
        : form.mode === "every" && !(Number.isInteger(everySec) && everySec >= 60)
          ? "An interval is a whole number of minutes, at least 1."
          : form.pin.trim() !== "" && !(Number.isInteger(Number(form.pin)) && Number(form.pin) >= 1)
            ? "A pinned version is a whole number from 1."
            : null;
  const save = async () => {
    setWorking(true);
    try {
      await engine("schedule_set", {
        ...(s ? { id: s.id, revision: s.revision } : {}),
        workflowId: form.workflowId,
        version: form.pin.trim() === "" ? null : Number(form.pin),
        ...(form.mode === "cron" ? { cron: form.cron.trim().replace(/\s+/g, " ") } : { everySec }),
        timezone: form.timezone,
        overlap: form.overlap,
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
      title={s ? `Edit ${s.workflowTitle}` : "New engine schedule"}
      onClose={onClose}
      busy={working}
      footer={
        <Button variant="primary" disabled={working || problem !== null} onClick={() => void save()}>
          {s ? "Save" : "Create schedule"}
        </Button>
      }
    >
      <div className="tb-stack">
        <Field label="Workflow">
          <NativeSelect value={form.workflowId} onChange={(e) => setForm({ ...form, workflowId: e.target.value })} options={[{ value: "", label: "Choose a workflow" }, ...workflows.map((w) => ({ value: w.id, label: w.title }))]} />
        </Field>
        <Field label="Pinned version" hint="Leave empty to follow the active version.">
          <TextInput inputMode="numeric" value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value })} />
        </Field>
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
        {form.mode === "cron" ? (
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
