// Drafts page: start a draft (template or blank), edit steps / allowed operations / trigger, promote to a version.
import { Button, Chip, ChipGroup, EmptyState, Field, Ink, Notice, Select, Tag, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import type * as K from "#kit";
import { ALLOWLIST_TEXT, errorText, type Out, person } from "./ops.ts";
import { ImportReportView, importedFrom } from "./Pipeline.tsx";

type Draft = Out<"draft_get">;
type Crud = "create" | "read" | "update" | "delete";
const CRUD: Crud[] = ["create", "read", "update", "delete"];

/** "kanban.issue_create, knowledge.remember" ⇄ ops */
const opsText = (ops: { product: string; operation: string }[]) => ops.map((o) => `${o.product}.${o.operation}`).join(", ");
function parseOps(text: string): { product: string; operation: string }[] {
  return text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => {
      const [product = "", operation = ""] = t.split(".");
      return { product, operation };
    });
}

export function Drafts({ openId, onPromoted }: { openId: string | null; onPromoted: (workflowId: string) => void }) {
  const [rows, setRows] = useState<Out<"drafts_list">["drafts"] | null>(null);
  const [templates, setTemplates] = useState<Out<"templates_list">["templates"]>([]);
  const [selected, setSelected] = useState<string | null>(openId);
  const [template, setTemplate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importFor, setImportFor] = useState("");
  const [workflows, setWorkflows] = useState<Out<"workflows_list">["workflows"]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const load = useCallback(async () => {
    try {
      setRows((await person("drafts_list", {})).drafts);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
    person("templates_list", {})
      .then((t) => {
        setTemplates(t.templates);
        setTemplateError(null);
      })
      .catch((e) => setTemplateError(`Templates could not be loaded. ${errorText(e)}`));
  }, [load]);
  useEffect(() => setSelected(openId), [openId]);

  const create = async () => {
    try {
      const d = await person("draft_create", template ? { templateId: template } : {});
      await load();
      setSelected(d.id);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const current = selected ?? rows?.[0]?.id ?? null;

  const openImport = () => {
    setImportOpen(true);
    person("workflows_list", {})
      .then((r) => setWorkflows(r.workflows))
      .catch(() => setWorkflows([])); // only the optional "new version of" choice is lost
  };
  const doImport = async () => {
    if (importing) return;
    let contract: unknown;
    try {
      contract = JSON.parse(importText);
    } catch {
      setImportError("This is not valid JSON. Paste the whole contract file.");
      return;
    }
    if (typeof contract !== "object" || contract === null || Array.isArray(contract)) {
      setImportError("A pipeline contract is one JSON object. Paste the whole contract file.");
      return;
    }
    setImporting(true);
    try {
      const r = await person("pipeline_import", { contract, ...(importFor ? { asDraftOf: importFor } : {}) } as K.PipelineImportInput);
      await load();
      setSelected(r.draft.id);
      setImportText("");
      setImportFor("");
      setImportOpen(false);
      setImportError(null);
    } catch (e) {
      setImportError(errorText(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <section className="app-page" aria-label="Drafts">
      <div className="page-head">
        <h1>Drafts</h1>
      </div>
      <p className="tb-soft page-desc">A draft is the workflow text you review: an instruction for the Bound agent, the steps, the trigger and the operations it may call.</p>
      <div className="toolbar">
        <Field label="Start from">
          <Select
            value={template}
            onValueChange={setTemplate}
            options={[{ value: "", label: "Blank draft" }, ...templates.map((t) => ({ value: t.id, label: `Template: ${t.title}` }))]}
          />
        </Field>
        <Button onClick={() => void create()}>New draft</Button>
        <Button onClick={() => (importOpen ? setImportOpen(false) : openImport())}>Import pipeline contract</Button>
      </div>
      {importOpen ? (
        <section className="tb-card tb-stack import-box" aria-label="Import a pipeline contract">
          <h2>Import a pipeline contract</h2>
          <p className="tb-soft">
            Paste the contract JSON (tealbrick.agents/pipeline-contract/0.1). Evolution makes a draft from it. It does not create a schedule. Tools that are not Teal Brick operations are
            listed in the report and are not enforced.
          </p>
          <Field label="Contract JSON">
            <Textarea rows={8} value={importText} onChange={(e) => setImportText(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Add to" hint="Choose a workflow to make the draft its next version. It must come from the same pipeline id.">
            <Select value={importFor} onValueChange={setImportFor} options={[{ value: "", label: "A new workflow" }, ...workflows.map((w) => ({ value: w.id, label: `New version of: ${w.title}` }))]} />
          </Field>
          {importError ? (
            <Notice tone="needs-you" role="alert">
              {importError}
            </Notice>
          ) : null}
          <div className="tb-ctas">
            <Button variant="primary" onClick={() => void doImport()} disabled={importing || !importText.trim()}>
              Import
            </Button>
            <Button onClick={() => setImportOpen(false)}>Cancel</Button>
          </div>
        </section>
      ) : null}
      {templateError ? (
        <Notice tone="needs-you" role="alert">
          {templateError}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {rows === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading drafts.
          </p>
        )
      ) : rows.length === 0 ? (
        <EmptyState title="No drafts yet.">Approve a suggestion or start from a template.</EmptyState>
      ) : (
        <div className="two-pane">
          <nav className="pane-list" aria-label="Drafts">
            {rows.map((r) => (
              <button type="button" key={r.id} className="pane-item tb-focusable" aria-current={current === r.id ? "true" : undefined} onClick={() => setSelected(r.id)}>
                <Ink>{r.title}</Ink>
                <Tag status={r.state === "promoted" ? "live" : "busy"}>{r.state === "promoted" ? "Promoted" : "Editing"}</Tag>
              </button>
            ))}
          </nav>
          {current ? <Editor key={current} id={current} onSaved={load} onPromoted={onPromoted} /> : null}
        </div>
      )}
    </section>
  );
}

function Editor({ id, onSaved, onPromoted }: { id: string; onSaved: () => Promise<void>; onPromoted: (workflowId: string) => void }) {
  const [d, setD] = useState<Draft | null>(null);
  const [form, setForm] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => {
    person("draft_get", { id })
      .then((x) => {
        setD(x);
        setForm(structuredClone(x));
      })
      .catch((e) => setError(errorText(e)));
  }, [id]);
  if (!d || !form)
    return error ? (
      <Notice tone="needs-you" role="alert">
        {error}
      </Notice>
    ) : (
      <p className="tb-soft" role="status">
        Loading.
      </p>
    );
  const set = (patch: Partial<Draft>) => setForm({ ...form, ...patch });
  const dirty = JSON.stringify(form) !== JSON.stringify(d);

  const save = async (): Promise<Draft | null> => {
    try {
      const next = await person("draft_update", {
        id,
        revision: d.revision,
        title: form.title,
        summary: form.summary,
        instruction: form.instruction,
        trigger: form.trigger,
        steps: form.steps.map((s) => ({ id: s.id, title: s.title || "Untitled step", instruction: s.instruction, ops: s.ops.filter((o) => o.product && o.operation) })),
        allowed: form.allowed.filter((a) => a.product && a.operations.length).map((a) => ({ ...a, crud: a.crud.length ? a.crud : ["read"] })),
      });
      const saved = { ...next, pipeline: d.pipeline }; // draft_update does not carry the import; it does not change
      setD(saved);
      setForm(structuredClone(saved));
      setError(null);
      await onSaved();
      return saved;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  };
  const promote = async () => {
    const cur = dirty ? await save() : d;
    if (!cur) return;
    try {
      const r = await person("workflow_promote", { draftId: id, revision: cur.revision });
      setInfo(`Promoted: ${r.workflow.title}, version ${r.version.version}.`);
      await onSaved();
      onPromoted(r.workflow.id);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const setStep = (i: number, patch: Partial<Draft["steps"][number]>) => set({ steps: form.steps.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const setAllowed = (i: number, patch: Partial<Draft["allowed"][number]>) => set({ allowed: form.allowed.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  return (
    <article className="tb-card detail">
      <div className="detail-head">
        <h2>{form.title || "Untitled draft"}</h2>
        <span className="tb-hint">Revision {d.revision}</span>
      </div>
      {d.pipeline ? (
        <div className="tb-stack">
          <Notice role="status">{importedFrom(d.pipeline.id, d.pipeline.version)}.</Notice>
          <ImportReportView report={d.pipeline.report} />
        </div>
      ) : null}
      <Field label="Title">
        <TextInput value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} />
      </Field>
      <Field label="Summary">
        <TextInput value={form.summary} onChange={(e) => set({ summary: e.target.value })} maxLength={2000} />
      </Field>
      <Field label="Instruction for the Bound agent" hint="What the agent does on each run. It reads this with workflow_get.">
        <Textarea rows={4} value={form.instruction} onChange={(e) => set({ instruction: e.target.value })} maxLength={8000} />
      </Field>
      <Field label="Trigger" hint="When it should run, in words. After promotion, set the real schedule on the Schedules page.">
        <TextInput value={form.trigger} onChange={(e) => set({ trigger: e.target.value })} maxLength={500} />
      </Field>

      <section className="tb-section">
        <h3>Steps</h3>
        {form.steps.length ? (
          <ol className="edit-list">
            {form.steps.map((s, i) => (
              <li key={s.id}>
                <div className="edit-head">
                  <span>Step {i + 1}</span>
                  <Button size="sm" aria-label={`Remove step ${i + 1}`} onClick={() => set({ steps: form.steps.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
                <Field label="Title">
                  <TextInput value={s.title} onChange={(e) => setStep(i, { title: e.target.value })} />
                </Field>
                <Field label="Instruction">
                  <TextInput value={s.instruction} onChange={(e) => setStep(i, { instruction: e.target.value })} />
                </Field>
                <Field label="Operations" hint="For example kanban.issue_create, knowledge.remember">
                  <TextInput defaultValue={opsText(s.ops)} onBlur={(e) => setStep(i, { ops: parseOps(e.target.value) })} />
                </Field>
              </li>
            ))}
          </ol>
        ) : null}
        <div>
          <Button size="sm" onClick={() => set({ steps: [...form.steps, { id: `s${Date.now().toString(36)}`, title: "", instruction: "", ops: [] }] })}>
            Add step
          </Button>
        </div>
      </section>

      <section className="tb-section">
        <h3>Allowed operations</h3>
        <Notice role="status">{ALLOWLIST_TEXT}</Notice>
        {form.allowed.length ? (
          <ul className="edit-list">
            {form.allowed.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id until saved; the product field itself is edited
              <li key={i}>
                <div className="edit-head">
                  <span>{a.product || "New app"}</span>
                  <Button size="sm" aria-label={`Remove ${a.product || "this app"}`} onClick={() => set({ allowed: form.allowed.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
                <div className="two">
                  <Field label="App (product id)" hint="For example kanban">
                    <TextInput value={a.product} onChange={(e) => setAllowed(i, { product: e.target.value })} />
                  </Field>
                  <Field label="Operations" hint="For example issue_create, issues_list">
                    <TextInput defaultValue={a.operations.join(", ")} onBlur={(e) => setAllowed(i, { operations: e.target.value.split(/[\s,]+/).filter(Boolean) })} />
                  </Field>
                </div>
                <ChipGroup label={`Access the agent needs in ${a.product || "this app"}`}>
                  {CRUD.map((c) => (
                    <Chip
                      key={c}
                      pressed={a.crud.includes(c)}
                      onClick={() => setAllowed(i, { crud: a.crud.includes(c) ? a.crud.filter((k) => k !== c) : CRUD.filter((k) => k === c || a.crud.includes(k)) })}
                    >
                      {c}
                    </Chip>
                  ))}
                </ChipGroup>
              </li>
            ))}
          </ul>
        ) : null}
        <div>
          <Button size="sm" onClick={() => set({ allowed: [...form.allowed, { product: "", operations: [], crud: ["read"] }] })}>
            Add app
          </Button>
        </div>
      </section>

      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {info ? <Notice tone="live">{info}</Notice> : null}
      <div className="tb-ctas">
        <Button onClick={() => void save()} disabled={!dirty}>
          Save
        </Button>
        <Button variant="primary" onClick={() => void promote()} disabled={!dirty && d.state === "promoted"}>
          {d.workflowId ? "Promote as next version" : "Promote to workflow"}
        </Button>
      </div>
    </article>
  );
}
