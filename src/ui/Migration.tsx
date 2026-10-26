// The move from 0.3.x (C367 M3): the "Migrated from 0.3" badge and the summary on the Workflows page. The move is done by the
// app at start (src/migrate/run.ts); this only shows what it did, from `migration_status`. Owner only.
import { Button, Notice, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { errorText, type Out, person } from "./ops.ts";

export type MigrationStatus = Out<"migration_status">;
export type MigrationItem = MigrationStatus["items"][number];

export const BADGE_TEXT = "Migrated from 0.3";

export interface Migration {
  status: MigrationStatus | null;
  error: string | null;
  reload: () => void;
  /** the engine workflow id of a legacy workflow that moved, or null */
  engineWorkflowOf: (legacyWorkflowId: string) => string | null;
  /** the legacy workflow of an engine workflow that came from 0.3.x, or null */
  legacyWorkflowOf: (engineWorkflowId: string) => string | null;
  /** an engine schedule that a 0.3.x schedule became */
  isMigratedSchedule: (engineScheduleId: string) => boolean;
}

export function useMigration(): Migration {
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    person("migration_status", {})
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(reload, [reload]);
  const items = status?.items ?? [];
  const wf = items.filter((i) => i.kind === "workflow" && i.status === "migrated" && i.engineId);
  return {
    status,
    error,
    reload,
    engineWorkflowOf: (id) => wf.find((i) => i.legacyId === id)?.engineId ?? null,
    legacyWorkflowOf: (id) => wf.find((i) => i.engineId === id)?.legacyId ?? null,
    isMigratedSchedule: (id) => items.some((i) => i.kind === "schedule" && i.status === "migrated" && i.engineId === id),
  };
}

export function MigratedBadge({ title }: { title?: string }) {
  return (
    <Tag status="default" title={title ?? "This came from a 0.3.x workflow or schedule."}>
      {BADGE_TEXT}
    </Tag>
  );
}

const REASON_LABEL: Record<MigrationItem["status"], string> = { migrated: "moved", legacy_bound: "stays on 0.3.x", skipped: "skipped", failed: "failed", deferred: "waits for the engine" };

/** Counts of what moved, what stayed and why, with each skipped or failed item named. */
export function MigrationSummary({ migration, titleOf }: { migration: Migration; titleOf: (legacyId: string, kind: MigrationItem["kind"]) => string }) {
  const { status, error } = migration;
  if (error)
    return (
      <Notice tone="needs-you" role="alert">
        <span className="tb-row">
          <span>{`The move from 0.3 could not be read. ${error}`}</span>
          <Button size="sm" onClick={migration.reload}>
            Try again
          </Button>
        </span>
      </Notice>
    );
  if (!status || status.items.length === 0) return null;
  const c = status.counts;
  const problems = status.items.filter((i) => i.status === "failed" || i.status === "skipped" || i.status === "deferred" || (i.status === "migrated" && i.reason));
  return (
    <section className="tb-card tb-stack migration" aria-label="Move from 0.3">
      <div className="card-head">
        <h2 className="tb-h3">Move from 0.3</h2>
        <Tag status={status.done ? "live" : "busy"}>{status.done ? "done" : "not finished"}</Tag>
      </div>
      <p className="tb-hint">
        The workflows and schedules of 0.3.x were moved to the engine once, when this version started. Nothing of the old data was deleted: a schedule that moved is paused, and its runs stay in Cycles as legacy runs.
      </p>
      <dl className="kv">
        <dt>Workflows moved</dt>
        <dd>{c.workflowsMigrated}</dd>
        <dt>Schedules moved</dt>
        <dd>{c.schedulesMigrated}</dd>
        <dt>Stay on 0.3.x (Bound agent)</dt>
        <dd>{c.schedulesLegacyBound}</dd>
        <dt>Skipped</dt>
        <dd>{c.schedulesSkipped}</dd>
        <dt>Failed</dt>
        <dd>{c.workflowsFailed + c.schedulesFailed}</dd>
        {c.deferred ? (
          <>
            <dt>Waiting for the engine</dt>
            <dd>{c.deferred}</dd>
          </>
        ) : null}
      </dl>
      {c.schedulesLegacyBound ? <p className="tb-hint">A Bound agent keeps its schedule on the 0.3.x runner, because workflow steps go to Free agents only. That runner is deprecated and stays for one more release.</p> : null}
      {problems.length ? (
        <ul className="plain migration-problems" aria-label="Items that need a look">
          {problems.map((i) => (
            <li key={`${i.kind}-${i.legacyId}`}>
              <Tag status={i.status === "failed" ? "needs-you" : "idle"}>{i.status === "migrated" ? "partly moved" : REASON_LABEL[i.status]}</Tag> {i.kind === "workflow" ? "Workflow" : "Schedule"} <b>{titleOf(i.legacyId, i.kind)}</b>
              {i.reason ? `: ${i.reason}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
