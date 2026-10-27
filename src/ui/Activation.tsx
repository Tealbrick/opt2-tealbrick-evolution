// Activation review (C367 WP3, ENGINE-BUILD §4): before a version runs on the engine, the owner sees which operations, which
// access (CRUD) and which scopes it uses, with the honest label, and then chooses Activate. The engine refuses any call
// outside this list (not_in_workflow). Deactivate stops new runs of the workflow.
import { Button, EmptyState, Field, NativeSelect, Notice, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JsonObject } from "../engine/json.ts";
import type { Trigger, WorkflowContract } from "./engine-contract.ts";
import { type ContractVersion, engine, type ValidateOut } from "./engine-ops.ts";
import { errorText } from "./ops.ts";
import { missingInputs, ValuesForm } from "./SchemaForm.tsx";
import { triggerText } from "./Shape.tsx";
import { Issues, UsageTable } from "./Usage.tsx";

/** Where the owner goes from here: the run just started, the schedules, or the editor. */
export interface ActivationLinks {
  onOpenRun?: (runId: string) => void;
  onSchedules?: () => void;
  onEditor?: () => void;
  /** open this saved version in the editor (as the next version) */
  onEditVersion?: (workflowId: string, version: number) => void;
}

/** The placeholder agent of a workflow moved from 0.3.x (= UNASSIGNED_AGENT of src/migrate/contract.ts; test/ui-engine.test.ts checks it). */
export const UNASSIGNED_AGENT = "agt_unassigned";

/** The ai steps that still name the placeholder agent (the engine refuses to activate such a version: agent_unassigned). */
export function unassignedSteps(steps: unknown): string[] {
  const out: string[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const s of list as Record<string, unknown>[]) {
      if (!s || typeof s !== "object") continue;
      const by = s.by as { agent?: unknown } | undefined;
      if (s.type === "ai" && by?.agent === UNASSIGNED_AGENT && typeof s.id === "string") out.push(s.id);
      walk(s.then);
      walk(s.else);
      walk(s.steps);
      if (s.branches && typeof s.branches === "object") for (const b of Object.values(s.branches as Record<string, unknown>)) walk(b);
    }
  };
  walk(steps);
  return out;
}

/** The stored contract versions of the engine (`workflow_contracts_list`), newest first. */
export function Activation({ open = null, onOpenRun, onSchedules, onEditor, onEditVersion }: { open?: { workflowId: string; version: number } | null } & ActivationLinks) {
  const [unassigned, setUnassigned] = useState<string[]>([]);
  const [contracts, setContracts] = useState<ContractVersion[] | null>(null);
  const [workflowId, setWorkflowId] = useState(open?.workflowId ?? "");
  const [version, setVersion] = useState<number | null>(open?.version ?? null);
  const [review, setReview] = useState<ValidateOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    engine("workflow_contracts_list", {})
      .then((r) => {
        setContracts(r.contracts);
        setError(null);
        // nothing chosen yet: open the newest saved version, so the page never starts empty when there is something to review
        const newest = [...r.contracts].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.version - a.version)[0];
        if (newest) {
          setWorkflowId((w) => w || newest.workflowId);
          setVersion((v) => v ?? newest.version);
        }
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
    // the same workflow again changes nothing (clearing the review here would leave it at "Reviewing.": the load below would not run again)
    if (id === workflowId) return;
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
  useEffect(() => {
    setUnassigned([]);
    if (!workflowId || version === null) return;
    engine("workflow_contract_get", { workflowId, version })
      .then((r) => setUnassigned(unassignedSteps((r.contract as { steps?: unknown }).steps)))
      .catch(() => {});
  }, [workflowId, version]);

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
        <EmptyState title="No saved workflow versions yet.">
          Save a version in the editor first, or load one of the two examples there. Then review and activate it here.
          {onEditor ? (
            <div>
              <Button variant="primary" onClick={onEditor}>
                Open the editor
              </Button>
            </div>
          ) : null}
        </EmptyState>
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
              {unassigned.length ? (
                <Notice tone="needs-you" role="alert">
                  <span className="tb-row">
                    <span>{`This workflow came from 0.3.x and step ${unassigned.join(", ")} has no agent yet. Choose the Free agent in the editor and save it as a new version; then activate that version.`}</span>
                    {onEditVersion ? (
                      <Button size="sm" variant="primary" onClick={() => onEditVersion(workflowId, version)}>
                        Choose the agent in the editor
                      </Button>
                    ) : null}
                  </span>
                </Notice>
              ) : null}
              <UsageTable rows={review.usage} />
              {done ? (
                <Notice tone="live" role="status">
                  {done}
                </Notice>
              ) : null}
              <div className="tb-ctas">
                <Button
                  variant="primary"
                  disabled={busy || !review.ok || isActive || unassigned.length > 0}
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
              {isActive ? <NextSteps workflowId={workflowId} version={version} onOpenRun={onOpenRun} onSchedules={onSchedules} /> : null}
            </>
          )}
        </article>
      ) : null}
    </section>
  );
}

/** After activation: start a run now (the manual trigger) or create the schedule / poll of the contract's trigger, with the
 *  run inputs typed from the workflow's inputs schema. */
export function NextSteps({ workflowId, version, onOpenRun, onSchedules }: { workflowId: string; version: number } & ActivationLinks) {
  const [contract, setContract] = useState<WorkflowContract | null>(null);
  const [inputs, setInputs] = useState<JsonObject>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; runId?: string; schedules?: boolean } | null>(null);
  // the schedule kinds this workflow already has (a second click must not make a second schedule)
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  useEffect(() => {
    engine("schedules_list", { workflowId })
      .then((r) => setKinds(new Set(r.schedules.map((s) => s.kind))))
      .catch(() => {});
  }, [workflowId]);
  useEffect(() => {
    engine("workflow_contract_get", { workflowId, version })
      .then((r) => {
        const c = r.contract as unknown as WorkflowContract;
        setContract(c);
        // the defaults the contract gives a manual run
        const manual = (Array.isArray(c.triggers) ? c.triggers : []).find((t): t is Extract<Trigger, { kind: "manual" }> => t.kind === "manual");
        setInputs((manual?.inputs ?? {}) as JsonObject);
      })
      .catch((e) => setError(`The workflow could not be read. ${errorText(e)}`));
  }, [workflowId, version]);
  if (!contract) return error ? <Notice tone="needs-you" role="alert">{error}</Notice> : null;
  const triggers = Array.isArray(contract.triggers) ? contract.triggers : [];
  const timed = triggers.filter((t) => t.kind === "schedule" || t.kind === "poll");
  const missing = missingInputs(contract.inputs, inputs);
  const go = async (fn: () => Promise<{ text: string; runId?: string; schedules?: boolean }>) => {
    setBusy(true);
    setError(null);
    try {
      setDone(await fn());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tb-stack next-steps" aria-label="Run this workflow">
      <h3 className="tb-h3">Run it</h3>
      <p className="tb-hint">The active version is ready. Start a run now, or create the schedule its trigger describes. Runs use these inputs.</p>
      <ValuesForm label="Inputs for runs" schema={contract.inputs} value={inputs} onChange={setInputs} />
      {missing.length ? <p className="tb-hint">{`Fill in ${missing.join(", ")} first.`}</p> : null}
      <div className="tb-ctas">
        <Button
          variant="primary"
          disabled={busy || missing.length > 0}
          onClick={() =>
            void go(async () => {
              const r = await engine("workflow_run_now", { workflowId, inputs });
              return { text: `Run ${r.runId} started on version ${r.version}.`, runId: r.runId };
            })
          }
        >
          Run now
        </Button>
        {timed.map((t, i) =>
          kinds.has(t.kind === "poll" ? "poll" : "schedule") ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: triggers have no ids; the list is only read here
            <Tag key={i} status="live">
              {t.kind === "poll" ? "Its poll exists" : "Its schedule exists"}
            </Tag>
          ) : (
          <Button
            // biome-ignore lint/suspicious/noArrayIndexKey: triggers have no ids; the list is only read here
            key={i}
            disabled={busy || missing.length > 0}
            onClick={() =>
              void go(async () => {
                // the engine takes the cron or interval and the time zone from the trigger of the active version
                await engine("schedule_set", { workflowId, kind: t.kind === "poll" ? "poll" : "schedule", input: inputs });
                setKinds((k) => new Set([...k, t.kind === "poll" ? "poll" : "schedule"]));
                return { text: `Created: ${triggerText(t)}. The engine starts runs by itself from now on.`, schedules: true };
              })
            }
          >
            {t.kind === "poll" ? `Create the poll (every ${t.every})` : `Create the schedule (${t.cron ?? `every ${t.every}`}, ${t.timezone})`}
          </Button>
          ),
        )}
        {kinds.size && onSchedules ? (
          <Button size="sm" onClick={onSchedules}>
            See schedules
          </Button>
        ) : null}
      </div>
      {triggers.some((t) => t.kind === "event") ? <p className="tb-hint">The event trigger waits for app event subscriptions; the poll trigger runs the same steps until then.</p> : null}
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {done ? (
        <Notice tone="live" role="status">
          <span className="tb-row">
            <span>{done.text}</span>
            {done.runId && onOpenRun ? (
              <Button size="sm" onClick={() => onOpenRun(done.runId as string)}>
                Open the run
              </Button>
            ) : null}
            {done.schedules && onSchedules ? (
              <Button size="sm" onClick={onSchedules}>
                See schedules
              </Button>
            ) : null}
          </span>
        </Notice>
      ) : null}
    </section>
  );
}
