// Workflow editor (C367 WP3, aligned in M1): a typed step list with a form per step kind, the canonical-shape view, the JSON
// of the contract, and a live check. Owner only. Save stores an immutable contract version in the engine
// (`workflow_contract_save`); "Saved versions" lists them (`workflow_contracts_list`) and opens one (`workflow_contract_get`).
// The working copy is also kept in the browser tab's session storage so a reload keeps it.
import type { UseAgents } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Field, NativeSelect, Notice, Tabs, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JsonObject } from "../engine/json.ts";
import { liveCheck, newContract, type Trigger, type WorkflowContract } from "./engine-contract.ts";
import { type ContractVersion, engine, type ValidateOut } from "./engine-ops.ts";
import { SAMPLES } from "./engine-samples.ts";
import { CardIssues, IssuesProvider, PField, type PointedIssue, plainIssues, showIssue } from "./FieldIssues.tsx";
import { errorText, TIME_ZONES } from "./ops.ts";
import { SchemaFields } from "./SchemaForm.tsx";
import { ShapeView } from "./Shape.tsx";
import { idsOf, JsonField, RefMap, StepList } from "./StepForms.tsx";
import { Issues, UsageTable } from "./Usage.tsx";

const KEY = "evolution.editor.contract";
function remembered(): WorkflowContract {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as WorkflowContract;
    }
  } catch {
    /* session storage may be blocked: start empty */
  }
  return newContract();
}
function remember(c: WorkflowContract): void {
  try {
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(c));
  } catch {
    /* a convenience only */
  }
}

type Tab = "steps" | "shape" | "json";

/** The problems of the live check and of the last engine check, each at its JSON pointer (the engine gives `path` and `pointer`). */
export function pointedIssues(live: { errors: readonly { pointer: string; message: string }[]; warnings: readonly { pointer: string; message: string }[] }, server: ValidateOut | null): PointedIssue[] {
  const at = (i: { pointer?: string; path?: string }) => i.pointer ?? i.path ?? "";
  const all: PointedIssue[] = [...live.errors.map((i) => ({ pointer: i.pointer, message: i.message, level: "error" as const })), ...live.warnings.map((i) => ({ pointer: i.pointer, message: i.message, level: "warning" as const }))];
  if (server) for (const [list, level] of [[server.errors, "error"], [server.warnings, "warning"]] as const) for (const i of plainIssues(list)) all.push({ pointer: at(i), message: i.message, level });
  // the same problem from both checks is shown once
  const seen = new Set<string>();
  return all.filter((i) => {
    const k = `${i.level}|${i.pointer}|${i.message.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `onSaved`: go on to review and activate the version just saved (App opens the Activation page on it). */
/** `openSaved`: a saved version to open on arrival (Activation and Move from 0.3 send the owner here to change one). */
export function Editor({ agents, onSaved, openSaved = null }: { agents: UseAgents["agents"]; onSaved?: (workflowId: string, version: number) => void; openSaved?: { workflowId: string; version: number } | null }) {
  const [contract, setContractState] = useState<WorkflowContract>(remembered);
  const [tab, setTab] = useState<Tab>("steps");
  const [sample, setSample] = useState(SAMPLES[0]?.id ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [server, setServer] = useState<{ busy: boolean; result: ValidateOut | null; error: string | null }>({ busy: false, result: null, error: null });
  const [lastSaved, setLastSaved] = useState<{ workflowId: string; version: number } | null>(null);
  const [saved, setSaved] = useState<{ busy: boolean; list: ContractVersion[] | null; error: string | null }>({ busy: false, list: null, error: null });
  const file = useRef<HTMLInputElement>(null);
  const loadSaved = useCallback(async () => {
    try {
      setSaved((s) => ({ ...s, list: null, error: null }));
      const r = await engine("workflow_contracts_list", {});
      setSaved((s) => ({ ...s, list: r.contracts }));
    } catch (e) {
      setSaved((s) => ({ ...s, list: [], error: `Saved versions could not be loaded. ${errorText(e)}` }));
    }
  }, []);
  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);
  const wanted = openSaved ? `${openSaved.workflowId}@${openSaved.version}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: open once per requested version, not on every render of `open`
  useEffect(() => {
    if (openSaved) void open(openSaved.workflowId, openSaved.version);
  }, [wanted]);
  const setContract = (c: WorkflowContract) => {
    setContractState(c);
    remember(c);
    setServer((s) => (s.result ? { ...s, result: null } : s)); // an edit makes the last server answer stale
  };
  const live = useMemo(() => liveCheck(contract), [contract]);
  const issues = useMemo(() => pointedIssues(live, server.result), [live, server.result]);
  // a problem's Show button: the fields are on the Steps tab
  const goTo = (pointer: string) => {
    setTab("steps");
    setTimeout(() => showIssue(pointer), 0);
  };
  const taken = useMemo(() => idsOf(Array.isArray(contract.steps) ? contract.steps : []), [contract]);
  const set = <K extends keyof WorkflowContract>(k: K, v: WorkflowContract[K]) => setContract({ ...contract, [k]: v });

  const check = async () => {
    setServer({ busy: true, result: null, error: null });
    try {
      setServer({ busy: false, result: await engine("workflow_contract_validate", { contract: contract as unknown as Record<string, unknown> }), error: null });
    } catch (e) {
      setServer({ busy: false, result: null, error: `The engine could not check this contract. ${errorText(e)}` });
    }
  };
  // Save = a new immutable version in the engine (it does not run until you activate it on the Activation page)
  const save = async () => {
    setSaved((s) => ({ ...s, busy: true, error: null }));
    try {
      const r = await engine("workflow_contract_save", { contract: contract as unknown as Record<string, unknown> });
      setNote(r.created ? `Saved as version ${r.version} of ${r.workflowId}. A saved version never changes. Next: review what it uses and activate it.` : `Version ${r.version} of ${r.workflowId} was saved before with exactly this content. Nothing changed.`);
      setLastSaved({ workflowId: r.workflowId, version: r.version });
      await loadSaved();
      setSaved((s) => ({ ...s, busy: false }));
    } catch (e) {
      setSaved((s) => ({ ...s, busy: false, error: `Not saved. ${errorText(e)}` }));
      // a refused save names its problems like the engine check: show them next to their fields
      const details = (e as { details?: { errors?: ValidateOut["errors"]; warnings?: ValidateOut["warnings"] } } | null)?.details;
      if (details && Array.isArray(details.errors)) setServer({ busy: false, error: null, result: { ok: false, errors: details.errors, warnings: Array.isArray(details.warnings) ? details.warnings : [], usage: [], activeVersion: null } as unknown as ValidateOut });
    }
  };
  const open = async (workflowId: string, version: number) => {
    setSaved((s) => ({ ...s, busy: true, error: null }));
    try {
      const r = await engine("workflow_contract_get", { workflowId, version });
      const all = await engine("workflow_contracts_list", { workflowId }).catch(() => ({ contracts: [] as ContractVersion[] }));
      const next = Math.max(r.version, ...all.contracts.map((c) => c.version)) + 1;
      // a saved version never changes: the copy opens as the next version, ready to edit and save
      setContract({ ...(r.contract as unknown as WorkflowContract), version: next });
      setNote(`Opened version ${r.version} of ${r.workflowId} as version ${next}. Change it and save: version ${r.version} stays as it is.`);
      setSaved((s) => ({ ...s, busy: false }));
    } catch (e) {
      setSaved((s) => ({ ...s, busy: false, error: `Version ${version} could not be opened. ${errorText(e)}` }));
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(contract, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${contract.id || "workflow"}.workflow.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(contract, null, 2));
      setNote("The JSON is on your clipboard.");
    } catch {
      setNote("Copy did not work here. Use the JSON tab to select the text.");
    }
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const v = JSON.parse(await f.text()) as unknown;
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      setContract(v as WorkflowContract);
      setNote(`Loaded ${f.name}.`);
    } catch {
      setNote(`${f.name} is not a JSON contract. Nothing changed.`);
    }
  };

  return (
    <IssuesProvider value={issues}>
    <section className="app-page" aria-label="Workflow editor">
      <div className="page-head">
        <div className="tb-stack head-text">
          <h1>Workflow editor</h1>
          <p className="tb-lede">
            A workflow is a list of typed steps in one shape: an event starts it, the engine shapes data, reads from apps, may ask a model or an agent for content, and then runs the result action itself.
          </p>
        </div>
      </div>
      <Notice role="status">Save stores this contract as a version in the engine. A saved version never changes; to change one, raise the contract version and save again. Until you save, your work stays in this browser tab.</Notice>
      <div className="toolbar">
        <Field label="Start from">
          <NativeSelect value={sample} onChange={(e) => setSample(e.target.value)} options={SAMPLES.map((s) => ({ value: s.id, label: s.label }))} />
        </Field>
        <Button
          onClick={() => {
            const s = SAMPLES.find((x) => x.id === sample);
            if (s) setContract(structuredClone(s.contract));
          }}
        >
          Load example
        </Button>
        <Button onClick={() => setContract(newContract())}>New workflow</Button>
        <Button onClick={() => file.current?.click()}>Import JSON</Button>
        <input ref={file} type="file" accept="application/json,.json" hidden aria-label="Contract file" onChange={(e) => void importFile(e.target.files?.[0])} />
        <Button variant="primary" disabled={saved.busy || !live.ok} onClick={() => void save()}>
          {saved.busy ? "Working…" : "Save version"}
        </Button>
        <Button onClick={() => void copy()}>Copy JSON</Button>
        <Button onClick={download}>Download</Button>
      </div>
      {note ? (
        <Notice role="status">
          <span className="tb-row">
            <span>{note}</span>
            {lastSaved && onSaved ? (
              <Button size="sm" variant="primary" onClick={() => onSaved(lastSaved.workflowId, lastSaved.version)}>
                {`Review and activate version ${lastSaved.version}`}
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => {
                setNote(null);
                setLastSaved(null);
              }}
            >
              Dismiss
            </Button>
          </span>
        </Notice>
      ) : null}

      {saved.error ? (
        <Notice tone="needs-you" role="alert">
          {saved.error}
        </Notice>
      ) : null}
      {saved.list && saved.list.length > 0 ? (
        <section className="tb-stack" aria-label="Saved versions">
          <h2 className="tb-h3">Saved versions</h2>
          <ul className="plain">
            {saved.list.map((c) => (
              <li key={`${c.workflowId}@${c.version}`} className="tb-row">
                <span>
                  {c.title} <code className="code-ops">{c.workflowId}</code> version {c.version}
                </span>
                {c.state ? <Tag status={c.state === "active" ? "live" : "idle"}>{c.state}</Tag> : null}
                <Button size="sm" disabled={saved.busy} onClick={() => void open(c.workflowId, c.version)}>
                  {`Open ${c.workflowId} version ${c.version}`}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="tb-stack validation" aria-label="Contract check" aria-live="polite">
        <div className="tb-row">
          {live.ok ? <Tag status="live">valid</Tag> : <Tag status="needs-you">{live.errors.length === 1 ? "1 problem" : `${live.errors.length} problems`}</Tag>}
          {live.warnings.length ? <Tag status="idle">{live.warnings.length === 1 ? "1 note" : `${live.warnings.length} notes`}</Tag> : null}
          <span className="tb-soft">Checked as you type: shape, ids, refs, bounds. Whether an app accepts the inputs is checked by the engine against the installed apps.</span>
        </div>
        <Issues errors={live.errors} warnings={live.warnings} onShow={goTo} />
        {live.errors.length ? <p className="tb-hint">Each problem is also shown next to its field. Show takes you there.</p> : null}
      </section>

      <Tabs
        label="Editor views"
        value={tab}
        onChange={setTab}
        panelId="editor"
        tabs={[
          { value: "steps", label: "Steps" },
          { value: "shape", label: "Shape" },
          { value: "json", label: "JSON" },
        ]}
      />
      <div id={`editor-${tab}`} role="tabpanel" className="tb-stack">
        {tab === "steps" ? (
          <>
            <CardIssues at="" shown={CONTRACT_KEYS} />
            <div className="two">
              <PField at="/id" label="Workflow id" hint="3 to 40 characters: lower case letters, digits, hyphens. It never changes.">
                <TextInput value={contract.id ?? ""} onChange={(e) => set("id", e.target.value)} />
              </PField>
              <PField at="/version" label="Contract version" hint="Whole number from 1. Raise it to save a changed workflow.">
                <TextInput inputMode="numeric" value={String(contract.version ?? "")} onChange={(e) => set("version", Number(e.target.value) as number)} />
              </PField>
            </div>
            <PField at="/title" label="Title">
              <TextInput value={contract.title ?? ""} onChange={(e) => set("title", e.target.value)} />
            </PField>
            <PField at="/summary" label="Summary">
              <TextInput value={contract.summary ?? ""} onChange={(e) => set("summary", e.target.value)} />
            </PField>
            <SchemaFields at="/inputs" label="Inputs" hint="What a run needs, for example the account to read. Steps use them as $input.<name>. Optional." value={contract.inputs} onChange={(v) => set("inputs", v)} nameLabel="Input" optional />
            <Triggers triggers={Array.isArray(contract.triggers) ? contract.triggers : []} onChange={(t) => set("triggers", t)} />
            <h2 className="tb-h3">Steps</h2>
            <StepList steps={Array.isArray(contract.steps) ? contract.steps : []} onChange={(s) => set("steps", s)} taken={taken} agents={agents} />
            <RefMap at="/outputs" label="Outputs" hint="Name → ref. What the run hands back." value={contract.outputs} onChange={(o) => set("outputs", o)} nameLabel="Output" />
            <PField at="/metrics" label="Metrics" hint="Names of numbers this workflow reports, comma separated (at most 20).">
              <TextInput
                value={(contract.metrics ?? []).join(", ")}
                onChange={(e) =>
                  set(
                    "metrics",
                    e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  )
                }
              />
            </PField>
          </>
        ) : null}
        {tab === "shape" ? <ShapeView contract={contract} agents={agents} /> : null}
        {tab === "json" ? <JsonField label="Contract JSON" hint="Edit the whole contract. It applies while the text is valid JSON." value={contract} onChange={(v) => v && typeof v === "object" && !Array.isArray(v) && setContract(v as WorkflowContract)} rows={28} /> : null}
      </div>

      <section className="tb-stack" aria-label="Check against installed apps">
        <h2 className="tb-h3">Check against installed apps</h2>
        <p className="tb-hint">The engine checks each app step's input against the op's input schema, that the op is open to agents, and what it needs.</p>
        <div>
          <Button variant="primary" disabled={server.busy || !live.ok} onClick={() => void check()}>
            {server.busy ? "Checking…" : "Check with the engine"}
          </Button>
        </div>
        {!live.ok ? <p className="tb-hint">Fix the problems above first.</p> : null}
        {server.error ? (
          <Notice tone="needs-you" role="alert">
            {server.error}
          </Notice>
        ) : null}
        {server.result ? (
          <div className="tb-stack" role="status">
            <Tag status={server.result.ok ? "live" : "needs-you"}>{server.result.ok ? "accepted by the engine" : "refused by the engine"}</Tag>
            <Issues errors={server.result.errors} warnings={server.result.warnings} onShow={goTo} />
            <UsageTable rows={server.result.usage} />
          </div>
        ) : null}
      </section>
    </section>
    </IssuesProvider>
  );
}

/** The keys of the contract that a field of the editor shows (a problem under any other key is listed above the fields). */
const CONTRACT_KEYS: ReadonlySet<string> = new Set(["id", "version", "title", "summary", "inputs", "triggers", "steps", "outputs", "metrics"]);

/** The honest line for an event trigger (ENGINE-BUILD §2: push needs P2). */
export const EVENT_TRIGGER_TEXT = "Event triggers need app event subscriptions, which Teal Brick does not have yet. Until then this trigger does not start runs. Use a poll trigger for now: it checks the app every few minutes and runs the same steps.";

/** The keys of a trigger that a field of its card shows. */
const TRIGGER_KEYS: ReadonlySet<string> = new Set(["cron", "every", "timezone", "product", "op", "cursorPath", "input", "type", "filter"]);
/** Below /triggers, every numbered trigger has its own card. */
const NUMBERED = { has: (key: string) => /^[0-9]+$/.test(key) };

function Triggers({ triggers, onChange }: { triggers: Trigger[]; onChange: (t: Trigger[]) => void }) {
  const [kind, setKind] = useState<Trigger["kind"]>("schedule");
  const put = (i: number, t: Trigger) => onChange(triggers.map((x, j) => (j === i ? t : x)));
  const fresh = (k: Trigger["kind"]): Trigger => {
    switch (k) {
      case "schedule":
        return { kind: "schedule", cron: "0 8 * * *", timezone: "UTC" };
      case "manual":
        return { kind: "manual" };
      case "poll":
        return { kind: "poll", product: "", op: "", input: {}, cursorPath: "/", every: "5m" };
      case "event":
        return { kind: "event", product: "", type: "" };
    }
  };
  return (
    <section className="tb-stack" aria-label="Triggers" data-pointer="/triggers">
      <h2 className="tb-h3">Triggers</h2>
      <p className="tb-hint">What starts a run: a schedule, you (Run now), a poll of an app, or an app event.</p>
      <CardIssues at="/triggers" shown={NUMBERED} />
      {triggers.length === 0 ? <p className="tb-soft">No trigger yet. Add one below: manual is the simplest (you start each run).</p> : null}
      <ol className="plain">
        {triggers.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: triggers have no id; they are edited in place
          <li key={i} className="tb-card step-card" data-pointer={`/triggers/${i}`}>
            <div className="card-head">
              <h4>
                Trigger {i + 1} <Tag>{t.kind}</Tag>
              </h4>
              <Button size="sm" variant="danger" aria-label={`Delete trigger ${i + 1}`} onClick={() => onChange(triggers.filter((_, j) => j !== i))}>
                Delete
              </Button>
            </div>
            {/* an event trigger shows the honest sentence itself, so the checks' notes about it are not repeated in the card */}
            <CardIssues at={`/triggers/${i}`} shown={TRIGGER_KEYS} {...(t.kind === "event" ? { hide: /event subscriptions/i } : {})} />
            {t.kind === "schedule" ? (
              <div className="three">
                <PField at={`/triggers/${i}/${t.cron !== undefined ? "cron" : "every"}`} label={`When (trigger ${i + 1})`}>
                  <NativeSelect
                    value={t.cron !== undefined ? "cron" : "every"}
                    onChange={(e) => {
                      const { cron: _c, every: _e, ...rest } = t;
                      put(i, e.target.value === "cron" ? { ...rest, cron: "0 8 * * *" } : { ...rest, every: "15m" });
                    }}
                    options={[
                      { value: "cron", label: "cron" },
                      { value: "every", label: "every" },
                    ]}
                  />
                </PField>
                <Field label={t.cron !== undefined ? `Cron (trigger ${i + 1})` : `Every (trigger ${i + 1})`} hint={t.cron !== undefined ? "minute hour day month weekday, for example 0 8 * * 1-5" : "for example 15m, 6h, 1d"}>
                  <TextInput className="mono" value={t.cron ?? t.every ?? ""} onChange={(e) => put(i, t.cron !== undefined ? { ...t, cron: e.target.value } : { ...t, every: e.target.value })} />
                </Field>
                <PField at={`/triggers/${i}/timezone`} label={`Time zone (trigger ${i + 1})`} hint="An IANA zone. Daylight saving follows the zone.">
                  <NativeSelect value={t.timezone ?? ""} onChange={(e) => put(i, { ...t, timezone: e.target.value })} options={(TIME_ZONES.includes(t.timezone) ? TIME_ZONES : [t.timezone ?? "", ...TIME_ZONES]).map((z) => ({ value: z, label: z || "(choose a time zone)" }))} />
                </PField>
              </div>
            ) : null}
            {t.kind === "schedule" ? <p className="tb-hint">After you activate the workflow, create its schedule on the Schedules page: it starts with this cron and time zone.</p> : null}
            {t.kind === "poll" ? (
              <div className="tb-stack">
                <div className="three">
                  <PField at={`/triggers/${i}/product`} label={`App (trigger ${i + 1})`} hint="The app to read, for example connect.">
                    <TextInput value={t.product} onChange={(e) => put(i, { ...t, product: e.target.value })} />
                  </PField>
                  <PField at={`/triggers/${i}/op`} label={`Operation (trigger ${i + 1})`} hint="A read operation of that app.">
                    <TextInput value={t.op} onChange={(e) => put(i, { ...t, op: e.target.value })} />
                  </PField>
                  <PField at={`/triggers/${i}/every`} label={`Every (trigger ${i + 1})`} hint="for example 5m, 1h">
                    <TextInput value={t.every} onChange={(e) => put(i, { ...t, every: e.target.value })} />
                  </PField>
                </div>
                <PField at={`/triggers/${i}/cursorPath`} label={`Cursor path (trigger ${i + 1})`} hint="A JSON pointer into the answer that says what is new, for example /result/historyId. A run starts only when it changes.">
                  <TextInput className="mono" value={t.cursorPath} onChange={(e) => put(i, { ...t, cursorPath: e.target.value })} />
                </PField>
                <JsonField at={`/triggers/${i}/input`} label={`Input (trigger ${i + 1})`} hint="What the poll sends to the operation." value={t.input} onChange={(v) => put(i, { ...t, input: (v ?? {}) as JsonObject })} rows={4} />
                <p className="tb-hint">After you activate the workflow, create its poll on the Schedules page (kind: poll).</p>
              </div>
            ) : null}
            {t.kind === "event" ? (
              <div className="tb-stack">
                <Notice tone="needs-you" role="status">
                  <span className="tb-row">
                    <span>{EVENT_TRIGGER_TEXT}</span>
                    {triggers.some((x) => x.kind === "poll") ? null : (
                      <Button size="sm" onClick={() => onChange([...triggers, { kind: "poll", product: t.product, op: "", input: {}, cursorPath: "/", every: "5m" }])}>
                        {`Add a poll trigger for ${t.product || "this app"}`}
                      </Button>
                    )}
                  </span>
                </Notice>
                <div className="two">
                  <PField at={`/triggers/${i}/product`} label={`App (trigger ${i + 1})`}>
                    <TextInput value={t.product} onChange={(e) => put(i, { ...t, product: e.target.value })} />
                  </PField>
                  <PField at={`/triggers/${i}/type`} label={`Event type (trigger ${i + 1})`}>
                    <TextInput value={t.type} onChange={(e) => put(i, { ...t, type: e.target.value })} />
                  </PField>
                </div>
                <JsonField at={`/triggers/${i}/filter`} label={`Filter (trigger ${i + 1})`} value={t.filter} onChange={(v) => put(i, { ...t, filter: v as JsonObject | undefined })} rows={3} />
              </div>
            ) : null}
            {t.kind === "manual" ? <p className="tb-hint">You start a run with Run now on the Activation page, after you activate the workflow.</p> : null}
          </li>
        ))}
      </ol>
      <div className="toolbar">
        <Field label="New trigger kind">
          <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as Trigger["kind"])} options={(["schedule", "manual", "poll", "event"] as const).map((k) => ({ value: k, label: k }))} />
        </Field>
        <Button onClick={() => onChange([...triggers, fresh(kind)])}>Add trigger</Button>
      </div>
    </section>
  );
}
