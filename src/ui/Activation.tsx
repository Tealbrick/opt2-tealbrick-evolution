// Activation review (C367 WP3, ENGINE-BUILD §4): before a version runs on the engine, the owner sees which operations, which
// access (CRUD) and which scopes it uses, with the honest label, and then chooses Activate. The engine refuses any call
// outside this list (not_in_workflow). Deactivate stops new runs of the workflow.
import { Button, EmptyState, Field, NativeSelect, Notice, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ContractVersion, engine, type ValidateOut } from "./engine-ops.ts";
import { errorText } from "./ops.ts";
import { Issues, UsageTable } from "./Usage.tsx";

/** The stored contract versions of the engine (`workflow_contracts_list`), newest first. */
export function Activation() {
  const [contracts, setContracts] = useState<ContractVersion[] | null>(null);
  const [workflowId, setWorkflowId] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [review, setReview] = useState<ValidateOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    engine("workflow_contracts_list", {})
      .then((r) => {
        setContracts(r.contracts);
        setError(null);
      })
      .catch((e) => setError(`Saved workflows could not be loaded. ${errorText(e)}`));
  }, []);

  // one entry per workflow id, titled by its newest version
  const workflows = useMemo(() => {
    const seen = new Map<string, string>();
    for (const c of [...(contracts ?? [])].sort((a, b) => b.version - a.version)) if (!seen.has(c.workflowId)) seen.set(c.workflowId, c.title);
    return [...seen].map(([id, title]) => ({ id, title }));
  }, [contracts]);
  const versions = useMemo(
    () =>
      (contracts ?? [])
        .filter((c) => c.workflowId === workflowId)
        .map((c) => c.version)
        .sort((a, b) => b - a),
    [contracts, workflowId],
  );
  const stateOf = (v: number) => contracts?.find((c) => c.workflowId === workflowId && c.version === v)?.state ?? null;

  const pickWorkflow = (id: string) => {
    setWorkflowId(id);
    setReview(null);
    setDone(null);
    const all = (contracts ?? [])
      .filter((c) => c.workflowId === id)
      .map((c) => c.version)
      .sort((a, b) => b - a);
    setVersion(all[0] ?? null);
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
      setContracts((await engine("workflow_contracts_list", {})).contracts);
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
      {contracts !== null && contracts.length === 0 ? (
        <EmptyState title="No saved workflow versions yet.">Save a version in the editor first. Then review and activate it here.</EmptyState>
      ) : (
        <div className="toolbar">
          <Field label="Workflow">
            <NativeSelect value={workflowId} onChange={(e) => pickWorkflow(e.target.value)} options={[{ value: "", label: "Choose a workflow" }, ...workflows.map((w) => ({ value: w.id, label: w.title }))]} />
          </Field>
          <Field label="Version">
            <NativeSelect value={version === null ? "" : String(version)} disabled={versions.length === 0} onChange={(e) => setVersion(Number(e.target.value))} options={versions.map((v) => ({ value: String(v), label: `version ${v}${stateOf(v) ? ` (${stateOf(v)})` : ""}` }))} />
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
                      const r = await engine("workflow_activate", { workflowId, version });
                      return r.previousVersion === null ? `Version ${r.version} is active.` : `Version ${r.version} is active. Version ${r.previousVersion} no longer starts new runs.`;
                    })
                  }
                >
                  {`Activate version ${version}`}
                </Button>
                <Button
                  disabled={busy || review.activeVersion === null}
                  onClick={() =>
                    void act(async () => {
                      const r = await engine("workflow_deactivate", { workflowId });
                      return `The workflow is deactivated. No new run starts.${r.schedulesPaused ? ` ${r.schedulesPaused === 1 ? "1 schedule is" : `${r.schedulesPaused} schedules are`} paused.` : ""}`;
                    })
                  }
                >
                  Deactivate
                </Button>
              </div>
              {!review.ok ? <p className="tb-hint">The engine refused this version. A saved version never changes: fix the problems in the editor and save a new version.</p> : null}
            </>
          )}
        </article>
      ) : null}
    </section>
  );
}
