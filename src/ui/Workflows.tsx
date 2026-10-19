// Workflows page: permanent workflows, their versions, the diff between two versions, and the Bound-agent recipe.
import { HARNESS_OPTION_IDS, type HarnessOptionId } from "@opt2-tealbrick/spec/routes";
import { AppIcon, appArt, appName, Button, CopyBlock, EmptyState, Field, Ink, Notice, Select, Tag, TextInput } from "@opt2-tealbrick/ui";
import { Fragment, useCallback, useEffect, useState } from "react";
import { ALLOWLIST_TEXT, day, errorText, type Out, person } from "./ops.ts";
import { downloadJson, importedFrom } from "./Pipeline.tsx";

/** EVO-01: one label per spec harness option id (HARNESS_OPTION_IDS); a new id fails the typecheck until it has a label. */
const HARNESS_LABELS: Record<HarnessOptionId, string> = {
  "generic-mcp": "Other agent (MCP)",
  "claude-desktop": "Claude Desktop",
  "claude-code": "Claude Code",
  "codex-desktop": "Codex",
  eve: "Eve agent",
  "tbd-default": "Tealbrick desktop app",
  "tealbrick-cli": "Tealbrick command line",
};
/** Option order of the approved mockup (C185); an id missing here goes last. The default stays "generic-mcp". */
const HARNESS_ORDER: readonly HarnessOptionId[] = ["claude-desktop", "claude-code", "codex-desktop", "eve", "generic-mcp", "tbd-default", "tealbrick-cli"];
const rank = (id: HarnessOptionId) => (HARNESS_ORDER.includes(id) ? HARNESS_ORDER.indexOf(id) : HARNESS_ORDER.length);
const HARNESSES = [...HARNESS_OPTION_IDS].sort((a, b) => rank(a) - rank(b)).map((value) => ({ value, label: HARNESS_LABELS[value] }));
type Allowed = Out<"workflow_versions">["versions"][number]["allowed"];
/** Same rule as the server's diff (src/model.ts diffSnapshots `widensAccess`): an operation or an access kind was added. */
function widens(from: Allowed, to: Allowed): boolean {
  const ops = (a: Allowed) => new Set(a.flatMap((x) => x.operations.map((o) => `${x.product}.${o}`)));
  const crud = (a: Allowed) => new Set(a.flatMap((x) => x.crud.map((c) => `${x.product}:${c}`)));
  const opsFrom = ops(from);
  const crudFrom = crud(from);
  return [...ops(to)].some((k) => !opsFrom.has(k)) || [...crud(to)].some((k) => !crudFrom.has(k));
}
const opsOf = (ops: { product: string; operation: string }[]) => ops.map((o) => `${o.product}.${o.operation}`).join(", ");

export function Workflows({ openId, stills }: { openId: string | null; stills: string }) {
  const [rows, setRows] = useState<Out<"workflows_list">["workflows"] | null>(null);
  const [selected, setSelected] = useState<string | null>(openId);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    person("workflows_list", {})
      .then((r) => {
        setRows(r.workflows);
        setError(null);
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => setSelected(openId), [openId]);
  const current = selected ?? rows?.[0]?.id ?? null;
  return (
    <section className="app-page" aria-label="Workflows">
      <div className="page-head">
        <div className="tb-stack head-text">
          <h1>Workflows</h1>
          <p className="tb-lede">A workflow is a promoted draft. Each promotion is a new version; old versions stay readable.</p>
        </div>
      </div>
      {error ? (
        <Notice tone="needs-you" role="alert">
          <span className="tb-row">
            <span>{error}</span>
            <Button size="sm" onClick={load}>
              Try again
            </Button>
          </span>
        </Notice>
      ) : null}
      {rows === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading workflows.
          </p>
        )
      ) : rows.length === 0 ? (
        <EmptyState title="No workflows yet.">Promote a draft first.</EmptyState>
      ) : (
        <div className="two-pane">
          <nav className="pane-list" aria-label="Workflows">
            {rows.map((w) => (
              <button type="button" key={w.id} className="pane-item tb-focusable" aria-current={current === w.id ? "true" : undefined} onClick={() => setSelected(w.id)}>
                <Ink>{w.title}</Ink>
                <Tag status="live">{`v${w.activeVersion}`}</Tag>
              </button>
            ))}
          </nav>
          {current ? <Detail key={current} id={current} stills={stills} /> : null}
        </div>
      )}
    </section>
  );
}

function Detail({ id, stills }: { id: string; stills: string }) {
  const [data, setData] = useState<Out<"workflow_versions"> | null>(null);
  const [shown, setShown] = useState<number>(0);
  const [from, setFrom] = useState(1);
  const [to, setTo] = useState(1);
  const [diff, setDiff] = useState<Out<"workflow_diff"> | null>(null);
  const [agentName, setAgentName] = useState("");
  const [harness, setHarness] = useState("generic-mcp");
  const [recipe, setRecipe] = useState<Out<"recipe_export"> | null>(null);
  const [pipelineNote, setPipelineNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await person("workflow_versions", { workflowId: id });
    setData(r);
    const last = r.workflow.activeVersion;
    setShown(last);
    setTo(last);
    setFrom(Math.max(1, last - 1));
    setAgentName(`${r.workflow.title} (Bound)`);
  }, [id]);
  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, [load]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the note belongs to the version that was exported
  useEffect(() => setPipelineNote(null), [shown]);
  if (!data)
    return error ? (
      <Notice tone="needs-you" role="alert">
        {error}
      </Notice>
    ) : (
      <p className="tb-soft" role="status">
        Loading.
      </p>
    );
  const v = data.versions.find((x) => x.version === shown) ?? data.versions.at(-1);
  if (!v) return null;
  const options = data.versions.map((x) => ({ value: String(x.version), label: `v${x.version} (${day(x.promotedAt)})` }));

  const compare = async () => {
    try {
      setDiff(await person("workflow_diff", { workflowId: id, from, to }));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const exportRecipe = async () => {
    try {
      setRecipe(await person("recipe_export", { workflowId: id, version: v.version, harnessOptionId: harness, ...(agentName.trim() ? { agentName: agentName.trim() } : {}) }));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const download = () => {
    if (!recipe) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(recipe.recipe, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `bound-agent-${id}-v${v.version}.recipe.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportPipeline = async () => {
    try {
      const r = await person("pipeline_export", { workflowId: id, version: v.version });
      downloadJson(r.filename, r.contract);
      setPipelineNote(r.omitted.length ? `${r.notice} Not in the file, because no step uses ${r.omitted.length === 1 ? "it" : "them"}: ${r.omitted.join(", ")}.` : r.notice);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const fromPipeline = data.pipelines.find((p) => p.version === v.version);
  const previous = data.versions.find((x) => x.version === v.version - 1);
  const widened = previous ? widens(previous.allowed, v.allowed) : false;
  const changes = diff
    ? diff.fields.length + diff.steps.added.length + diff.steps.removed.length + diff.steps.changed.length + diff.operations.added.length + diff.operations.removed.length
    : 0;

  return (
    <article className="tb-card detail">
      <div className="detail-head">
        <h2>{data.workflow.title}</h2>
        <Field label="Version">
          <Select value={String(v.version)} onValueChange={(x) => setShown(Number(x))} options={options} />
        </Field>
      </div>
      <p className="tb-soft">{v.instruction}</p>
      <p className="tb-hint">Trigger: {v.trigger || "none set"}. Schedule runs on the Schedules page.</p>
      {v.steps.length ? (
        <ol className="steps-list">
          {v.steps.map((s) => (
            <li key={s.id}>
              <b>{s.title}</b>
              <span>
                {s.instruction}
                {s.ops.length ? <span className="code-ops"> ({opsOf(s.ops)})</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      <section className="tb-stack ops-block">
        <h3>Allowed operations</h3>
        <Notice role="status">{ALLOWLIST_TEXT}</Notice>
        <dl className="kv">
          {v.allowed.map((a) => (
            <Fragment key={a.product}>
              <dt>
                <AppIcon art={appArt(a.product, stills)} name={appName(a.product)} size={24} />
                {appName(a.product)}
              </dt>
              <dd className="code-ops">
                {a.operations.join(", ")} ({a.crud.join(", ")})
              </dd>
            </Fragment>
          ))}
        </dl>
      </section>
      {widened ? (
        <Notice tone="needs-you">
          <strong>This version allows more than the previous one.</strong> An existing Bound agent keeps its old operation list until you change its policy in Portal.
        </Notice>
      ) : null}

      {data.versions.length > 1 ? (
        <section className="tb-section">
          <h3>Compare versions</h3>
          <div className="toolbar">
            <Select aria-label="From version" value={String(from)} onValueChange={(x) => setFrom(Number(x))} options={options} />
            <Select aria-label="To version" value={String(to)} onValueChange={(x) => setTo(Number(x))} options={options} />
            <Button onClick={() => void compare()}>Compare</Button>
          </div>
          {diff ? (
            <div className="tb-stack diff">
              {diff.widensAccess ? (
                <Notice tone="needs-you">
                  <strong>This version allows more than the previous one.</strong> {diff.notice}
                </Notice>
              ) : null}
              <ul className="plain">
                {diff.fields.map((f) => (
                  <li key={f.field}>
                    {f.field} changed: <del>{f.from || "(empty)"}</del> to <ins>{f.to || "(empty)"}</ins>
                  </li>
                ))}
                {diff.steps.added.map((s) => (
                  <li key={`a${s}`}>Step added: {s}</li>
                ))}
                {diff.steps.removed.map((s) => (
                  <li key={`r${s}`}>Step removed: {s}</li>
                ))}
                {diff.steps.changed.map((s) => (
                  <li key={`c${s.id}`}>
                    Step changed: {s.title} ({s.fields.join(", ")})
                  </li>
                ))}
                {diff.operations.added.map((o) => (
                  <li key={`oa${o}`}>Operation added: {o}</li>
                ))}
                {diff.operations.removed.map((o) => (
                  <li key={`or${o}`}>Operation removed: {o}</li>
                ))}
              </ul>
              {changes === 0 ? <p className="tb-soft">No differences.</p> : null}
              {diff.widensAccess ? null : <p className="tb-hint">{diff.notice}</p>}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="tb-section">
        <h3>Bound agent recipe (version {v.version})</h3>
        <p className="tb-soft">
          The recipe creates a new agent in Portal, sets it Bound with the operations above, and connects it to each app. You import it in Portal and apply it with one
          confirmation.
        </p>
        <div className="two">
          <Field label="Agent name">
            <TextInput value={agentName} onChange={(e) => setAgentName(e.target.value)} maxLength={64} />
          </Field>
          <Field label="Runs in">
            <Select value={harness} onValueChange={setHarness} options={HARNESSES} />
          </Field>
        </div>
        <div className="tb-ctas">
          <Button variant="primary" onClick={() => void exportRecipe()}>
            Export recipe
          </Button>
          {recipe ? <Button onClick={download}>Download .json</Button> : null}
        </div>
        {recipe ? (
          <>
            <Notice role="status">{recipe.notice}</Notice>
            <CopyBlock text={JSON.stringify(recipe.recipe, null, 2)} label="recipe" />
          </>
        ) : null}
      </section>
      <section className="tb-section">
        <h3>Pipeline contract (version {v.version})</h3>
        <p className="tb-soft">
          {fromPipeline
            ? `${importedFrom(fromPipeline.id, fromPipeline.pipelineVersion)}. Export gives you the contract back with the changes you made here.`
            : "This version was not imported from a pipeline contract. Export builds a contract from it and fills what Evolution does not know with defaults."}
        </p>
        <div className="tb-ctas">
          <Button onClick={() => void exportPipeline()}>Export pipeline contract</Button>
        </div>
        {pipelineNote ? <Notice role="status">{pipelineNote}</Notice> : null}
      </section>
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
    </article>
  );
}
