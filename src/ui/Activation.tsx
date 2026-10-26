// Activation review (C367 WP3, ENGINE-BUILD §4): before a version runs on the engine, the owner sees which operations, which
// access (CRUD) and which scopes it uses, with the honest label, and then chooses Activate. The engine refuses any call
// outside this list (not_in_workflow). Deactivate stops new runs of the workflow.
import { Button, EmptyState, Field, NativeSelect, Notice, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { engine, type ValidateOut } from "./engine-ops.ts";
import { errorText, type Out, person } from "./ops.ts";
import { Issues, UsageTable } from "./Usage.tsx";

type Wf = Out<"workflows_list">["workflows"][number];

export function Activation() {
  const [workflows, setWorkflows] = useState<Wf[] | null>(null);
  const [versions, setVersions] = useState<number[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [review, setReview] = useState<ValidateOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    person("workflows_list", {})
      .then((r) => {
        setWorkflows(r.workflows);
        setError(null);
      })
      .catch((e) => setError(`Workflows could not be loaded. ${errorText(e)}`));
  }, []);

  const pickWorkflow = (id: string) => {
    setWorkflowId(id);
    setVersion(null);
    setReview(null);
    setDone(null);
    setVersions([]);
    if (!id) return;
    person("workflow_versions", { workflowId: id })
      .then((r) => {
        const all = r.versions.map((v) => v.version).sort((a, b) => b - a);
        setVersions(all);
        setVersion(all[0] ?? null);
      })
      .catch((e) => setError(`Versions could not be loaded. ${errorText(e)}`));
  };

  const load = useCallback(async (id: string, v: number) => {
    setReview(null);
    setError(null);
    try {
      setReview(await engine("workflow_contract_validate", { workflowId: id, version: v }));
    } catch (e) {
      setError(`The engine could not review this version. ${errorText(e)}`);
    }
  }, []);
  useEffect(() => {
    if (workflowId && version !== null) void load(workflowId, version);
  }, [workflowId, version, load]);

  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      setDone(await fn());
      if (workflowId && version !== null) await load(workflowId, version);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const isActive = review !== null && version !== null && review.activeVersion === version;
  return (
    <section className="app-page" aria-label="Activation">
      <div className="page-head">
        <div className="tb-stack head-text">
          <h1>Activation</h1>
          <p className="tb-lede">A workflow version runs on the engine only after you activate it. Check what it uses first: the apps, the operations, the kind of access and the scopes.</p>
        </div>
      </div>
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {workflows !== null && workflows.length === 0 ? (
        <EmptyState title="No promoted workflows yet.">Promote a draft first. Then review and activate it here.</EmptyState>
      ) : (
        <div className="toolbar">
          <Field label="Workflow">
            <NativeSelect value={workflowId} onChange={(e) => pickWorkflow(e.target.value)} options={[{ value: "", label: "Choose a workflow" }, ...(workflows ?? []).map((w) => ({ value: w.id, label: w.title }))]} />
          </Field>
          <Field label="Version">
            <NativeSelect value={version === null ? "" : String(version)} disabled={versions.length === 0} onChange={(e) => setVersion(Number(e.target.value))} options={versions.map((v) => ({ value: String(v), label: `version ${v}` }))} />
          </Field>
        </div>
      )}
      {workflowId && version !== null ? (
        <article className="tb-card detail" aria-label={`Review of version ${version}`}>
          <div className="detail-head">
            <h2>Version {version}</h2>
            {review ? <Tag status={isActive ? "live" : "idle"}>{isActive ? "active on the engine" : review.activeVersion === null ? "not active" : `version ${review.activeVersion} is active`}</Tag> : null}
          </div>
          {review === null ? (
            error ? null : (
              <p className="tb-soft" role="status">
                Reviewing.
              </p>
            )
          ) : (
            <>
              <Issues errors={review.errors} warnings={review.warnings} />
              <UsageTable rows={review.usage} />
              {done ? (
                <Notice tone="live" role="status">
                  {done}
                </Notice>
              ) : null}
              <div className="tb-ctas">
                <Button
                  variant="primary"
                  disabled={busy || !review.ok || isActive}
                  onClick={() =>
                    void act(async () => {
                      await engine("workflow_activate", { workflowId, version });
                      return `Version ${version} is active.`;
                    })
                  }
                >
                  {`Activate version ${version}`}
                </Button>
                <Button
                  disabled={busy || review.activeVersion === null}
                  onClick={() =>
                    void act(async () => {
                      await engine("workflow_deactivate", { workflowId });
                      return "The workflow is deactivated. No new run starts.";
                    })
                  }
                >
                  Deactivate
                </Button>
              </div>
              {!review.ok ? <p className="tb-hint">The engine refused this version. Fix the problems and promote a new version.</p> : null}
            </>
          )}
        </article>
      ) : null}
    </section>
  );
}
