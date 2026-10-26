// Workflow editor (C367 WP3): a typed step list with a form per step kind, the canonical-shape view, the JSON of the
// contract, and a live validateContract() result. Owner only. The contract is held in this page (and in the browser tab's
// session storage so a reload keeps it): saving it into a draft is the engine's (WP2), so for now it leaves as JSON.
import type { UseAgents } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Field, NativeSelect, Notice, Tabs, Tag, TextInput } from "@opt2-tealbrick/ui";
import { useMemo, useRef, useState } from "react";
import { newContract, type Trigger, validateContract, type WorkflowContract } from "./engine-contract.ts";
import { engine, type ValidateOut } from "./engine-ops.ts";
import { SAMPLES } from "./engine-samples.ts";
import { errorText, TIME_ZONES } from "./ops.ts";
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

export function Editor({ agents }: { agents: UseAgents["agents"] }) {
  const [contract, setContractState] = useState<WorkflowContract>(remembered);
  const [tab, setTab] = useState<Tab>("steps");
  const [sample, setSample] = useState(SAMPLES[0]?.id ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [server, setServer] = useState<{ busy: boolean; result: ValidateOut | null; error: string | null }>({ busy: false, result: null, error: null });
  const file = useRef<HTMLInputElement>(null);
  const setContract = (c: WorkflowContract) => {
    setContractState(c);
    remember(c);
    setServer((s) => (s.result ? { ...s, result: null } : s)); // an edit makes the last server answer stale
  };
  const live = useMemo(() => validateContract(contract), [contract]);
  const taken = useMemo(() => idsOf(Array.isArray(contract.steps) ? contract.steps : []), [contract]);
  const set = <K extends keyof WorkflowContract>(k: K, v: WorkflowContract[K]) => setContract({ ...contract, [k]: v });

  const check = async () => {
    setServer({ busy: true, result: null, error: null });
    try {
      setServer({ busy: false, result: await engine("workflow_contract_validate", { contract }), error: null });
    } catch (e) {
      setServer({ busy: false, result: null, error: `The engine could not check this contract. ${errorText(e)}` });
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
    <section className="app-page" aria-label="Workflow editor">
      <div className="page-head">
        <div className="tb-stack head-text">
          <h1>Workflow editor</h1>
          <p className="tb-lede">
            A workflow is a list of typed steps in one shape: an event starts it, the engine shapes data, reads from apps, may ask a model or an agent for content, and then runs the result action itself.
          </p>
        </div>
      </div>
      <Notice role="status">Your work stays in this browser tab. Copy or download the JSON to keep it. Saving it as a draft comes with the engine.</Notice>
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
        <Button onClick={() => void copy()}>Copy JSON</Button>
        <Button onClick={download}>Download</Button>
      </div>
      {note ? (
        <Notice role="status">
          <span className="tb-row">
            <span>{note}</span>
            <Button size="sm" onClick={() => setNote(null)}>
              Dismiss
            </Button>
          </span>
        </Notice>
      ) : null}

      <section className="tb-stack validation" aria-label="Contract check" aria-live="polite">
        <div className="tb-row">
          {live.ok ? <Tag status="live">valid</Tag> : <Tag status="needs-you">{live.errors.length === 1 ? "1 problem" : `${live.errors.length} problems`}</Tag>}
          {live.warnings.length ? <Tag status="idle">{live.warnings.length === 1 ? "1 note" : `${live.warnings.length} notes`}</Tag> : null}
          <span className="tb-soft">Checked as you type: shape, ids, refs, bounds. Whether an app accepts the inputs is checked against the installed apps.</span>
        </div>
        <Issues errors={live.errors} warnings={live.warnings} />
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
            <div className="two">
              <Field label="Workflow id" hint="Lower case letters, digits, hyphens.">
                <TextInput value={contract.id ?? ""} onChange={(e) => set("id", e.target.value)} />
              </Field>
              <Field label="Contract version" hint="Whole number from 1.">
                <TextInput inputMode="numeric" value={String(contract.version ?? "")} onChange={(e) => set("version", Number(e.target.value) as number)} />
              </Field>
            </div>
            <Field label="Title">
              <TextInput value={contract.title ?? ""} onChange={(e) => set("title", e.target.value)} />
            </Field>
            <Field label="Summary">
              <TextInput value={contract.summary ?? ""} onChange={(e) => set("summary", e.target.value)} />
            </Field>
            <JsonField label="Inputs (JSON Schema)" hint="What a run needs, for example the account to read. Optional." value={contract.inputs} onChange={(v) => set("inputs", v as WorkflowContract["inputs"])} rows={4} />
            <Triggers triggers={Array.isArray(contract.triggers) ? contract.triggers : []} onChange={(t) => set("triggers", t)} />
            <h2 className="tb-h3">Steps</h2>
            <StepList steps={Array.isArray(contract.steps) ? contract.steps : []} onChange={(s) => set("steps", s)} taken={taken} agents={agents} />
            <RefMap label="Outputs" hint="Name → ref. What the run hands back." value={contract.outputs} onChange={(o) => set("outputs", o)} nameLabel="Output" />
            <Field label="Metrics" hint="Names of numbers this workflow reports, comma separated (at most 20).">
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
            </Field>
          </>
        ) : null}
        {tab === "shape" ? <ShapeView contract={contract} /> : null}
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
            <Issues errors={server.result.errors} warnings={server.result.warnings} />
            <UsageTable rows={server.result.usage} />
          </div>
        ) : null}
      </section>
    </section>
  );
}

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
    <section className="tb-stack" aria-label="Triggers">
      <h2 className="tb-h3">Triggers</h2>
      <ol className="plain">
        {triggers.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: triggers have no id; they are edited in place
          <li key={i} className="tb-card step-card">
            <div className="card-head">
              <h4>
                Trigger {i + 1} <Tag>{t.kind}</Tag>
              </h4>
              <Button size="sm" variant="danger" aria-label={`Delete trigger ${i + 1}`} onClick={() => onChange(triggers.filter((_, j) => j !== i))}>
                Delete
              </Button>
            </div>
            {t.kind === "schedule" ? (
              <div className="three">
                <Field label={`When (trigger ${i + 1})`}>
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
                </Field>
                <Field label={t.cron !== undefined ? `Cron (trigger ${i + 1})` : `Every (trigger ${i + 1})`} hint={t.cron !== undefined ? "minute hour day month weekday" : "for example 15m, 6h, 1d"}>
                  <TextInput className="mono" value={t.cron ?? t.every ?? ""} onChange={(e) => put(i, t.cron !== undefined ? { ...t, cron: e.target.value } : { ...t, every: e.target.value })} />
                </Field>
                <Field label={`Time zone (trigger ${i + 1})`}>
                  <NativeSelect value={t.timezone} onChange={(e) => put(i, { ...t, timezone: e.target.value })} options={(TIME_ZONES.includes(t.timezone) ? TIME_ZONES : [t.timezone, ...TIME_ZONES]).map((z) => ({ value: z, label: z }))} />
                </Field>
              </div>
            ) : null}
            {t.kind === "poll" ? (
              <div className="tb-stack">
                <div className="three">
                  <Field label={`App (trigger ${i + 1})`}>
                    <TextInput value={t.product} onChange={(e) => put(i, { ...t, product: e.target.value })} />
                  </Field>
                  <Field label={`Operation (trigger ${i + 1})`}>
                    <TextInput value={t.op} onChange={(e) => put(i, { ...t, op: e.target.value })} />
                  </Field>
                  <Field label={`Every (trigger ${i + 1})`}>
                    <TextInput value={t.every} onChange={(e) => put(i, { ...t, every: e.target.value })} />
                  </Field>
                </div>
                <Field label={`Cursor path (trigger ${i + 1})`} hint="A JSON pointer into the answer that says what is new, for example /result/historyId.">
                  <TextInput className="mono" value={t.cursorPath} onChange={(e) => put(i, { ...t, cursorPath: e.target.value })} />
                </Field>
                <JsonField label={`Input (trigger ${i + 1})`} value={t.input} onChange={(v) => put(i, { ...t, input: (v ?? {}) as Record<string, unknown> })} rows={4} />
              </div>
            ) : null}
            {t.kind === "event" ? (
              <div className="tb-stack">
                <div className="two">
                  <Field label={`App (trigger ${i + 1})`}>
                    <TextInput value={t.product} onChange={(e) => put(i, { ...t, product: e.target.value })} />
                  </Field>
                  <Field label={`Event type (trigger ${i + 1})`}>
                    <TextInput value={t.type} onChange={(e) => put(i, { ...t, type: e.target.value })} />
                  </Field>
                </div>
                <JsonField label={`Filter (trigger ${i + 1})`} value={t.filter} onChange={(v) => put(i, { ...t, filter: v as Record<string, unknown> | undefined })} rows={3} />
              </div>
            ) : null}
            {t.kind === "manual" ? <p className="tb-hint">The owner starts a run with Run now.</p> : null}
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
