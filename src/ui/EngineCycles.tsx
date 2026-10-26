// Cycles, engine side (C367 WP3, ENGINE-BUILD §7): the runs of the engine next to the legacy runs of the same workflow version
// (the 0.3.x routine runs that the cycle ledger above counts). One row per workflow version that has runs of either kind.
// The gates stay the ones above; this table only puts the two kinds of run side by side so a version can be compared whole.
import { Button, Notice, type Status, Table, Tag } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { type EngineRun, type EngineRunStatus, engine } from "./engine-ops.ts";
import { useMigration } from "./Migration.tsx";
import { errorText, type Out } from "./ops.ts";

type Cycle = Out<"cycles_list">["cycles"][number];

export interface Side {
  workflowId: string;
  workflowTitle: string;
  version: number;
  legacy: { total: number; completed: number };
  engine: { total: number; completed: number; failed: number; open: number; tokens: number; last10: EngineRunStatus[] };
}

const key = (workflowId: string, version: number) => `${workflowId}@${version}`;
const FAILED = new Set<EngineRunStatus>(["failed", "timed_out"]);
const OPEN = new Set<EngineRunStatus>(["running"]);

/** Engine runs and legacy cycle counts per workflow version, newest workflow version first. Pure: the page and the tests use it. */
/** `legacyOf`: the 0.3.x workflow an engine workflow came from (C367 M3), so the runs of the moved workflow join its legacy runs in one row. */
export function sideBySide(runs: readonly EngineRun[], cycles: readonly Cycle[], legacyOf: (engineWorkflowId: string) => string | null = () => null): Side[] {
  const rows = new Map<string, Side>();
  const titles = new Map(cycles.map((c) => [c.workflowId, c.workflowTitle]));
  const row = (workflowId: string, workflowTitle: string, version: number): Side => {
    const k = key(workflowId, version);
    let r = rows.get(k);
    if (!r) {
      r = { workflowId, workflowTitle, version, legacy: { total: 0, completed: 0 }, engine: { total: 0, completed: 0, failed: 0, open: 0, tokens: 0, last10: [] } };
      rows.set(k, r);
    }
    return r;
  };
  for (const c of cycles) {
    if (c.counts.total === 0) continue;
    const r = row(c.workflowId, c.workflowTitle, c.version);
    r.legacy = { total: c.counts.total, completed: c.counts.completed };
  }
  // newest first, so the first ten seen per version are its last ten
  for (const run of [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))) {
    // a run whose version the index does not know sits under version 0 (shown as a dash)
    const wf = legacyOf(run.workflowId) ?? run.workflowId;
    const e = row(wf, titles.get(wf) ?? wf, run.version ?? 0).engine;
    e.total++;
    if (run.status === "completed") e.completed++;
    if (FAILED.has(run.status)) e.failed++;
    if (OPEN.has(run.status)) e.open++;
    e.tokens += run.modelTokens ?? 0;
    if (e.last10.length < 10) e.last10.push(run.status);
  }
  return [...rows.values()].sort((a, b) => a.workflowTitle.localeCompare(b.workflowTitle) || b.version - a.version);
}

const TICK: Record<EngineRunStatus, { mark: string; status: Status }> = {
  completed: { mark: "✓", status: "live" },
  failed: { mark: "✗", status: "needs-you" },
  timed_out: { mark: "?", status: "needs-you" },
  running: { mark: "…", status: "busy" },
  cancelled: { mark: "–", status: "idle" },
  terminated: { mark: "–", status: "idle" },
  skipped: { mark: "·", status: "idle" },
};
const pct = (n: number, of: number): string => (of === 0 ? "–" : `${Math.round((n / of) * 100)}%`);

export function EngineCycles({ cycles }: { cycles: readonly Cycle[] }) {
  const [runs, setRuns] = useState<EngineRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const migration = useMigration();
  const load = useCallback(async () => {
    try {
      setRuns((await engine("engine_runs_list", { limit: 200 })).runs);
      setError(null);
    } catch (e) {
      setError(`Engine runs could not be loaded. ${errorText(e)}`);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // only versions the engine has run: a legacy-only version is already a row of the cycle table above
  const rows = runs ? sideBySide(runs, cycles, migration.legacyWorkflowOf).filter((r) => r.engine.total > 0) : [];
  return (
    <section className="tb-stack" aria-label="Engine runs next to legacy runs">
      <h2 className="tb-h2">Engine runs and legacy runs</h2>
      <p className="tb-hint">Legacy runs are the 0.3.x runs that an agent claims. Engine runs are started by the engine. A version can have both while you move over.</p>
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
      {runs === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading engine runs.
          </p>
        )
      ) : rows.length === 0 ? (
        <p className="tb-soft">No engine runs yet. The legacy runs of every version are counted in the table above.</p>
      ) : (
        <Table aria-label="Engine runs and legacy runs per version">
          <thead>
            <tr>
              <th scope="col">Workflow</th>
              <th scope="col">Version</th>
              <th scope="col">Legacy runs</th>
              <th scope="col">Engine runs</th>
              <th scope="col">Engine completed</th>
              <th scope="col">Engine failed</th>
              <th scope="col">Still going</th>
              <th scope="col">Last 10 engine runs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={key(r.workflowId, r.version)}>
                <td>{r.workflowTitle}</td>
                <td className="num">{r.version ? `v${r.version}` : "–"}</td>
                <td className="num">{r.legacy.total ? `${r.legacy.total} (${pct(r.legacy.completed, r.legacy.total)} completed)` : "–"}</td>
                <td className="num">{r.engine.total || "–"}</td>
                <td className="num">{pct(r.engine.completed, r.engine.total)}</td>
                <td className="num">{r.engine.failed || "–"}</td>
                <td className="num">{r.engine.open || "–"}</td>
                <td>
                  {r.engine.last10.length === 0 ? (
                    <span className="tb-soft">No engine runs yet</span>
                  ) : (
                    <span className="ticks" role="img" aria-label={`Last ${r.engine.last10.length} engine runs, newest first: ${r.engine.last10.join(", ").replaceAll("_", " ")}`}>
                      {r.engine.last10.map((s, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of at most 10 statuses, never reordered
                        <Tag key={i} status={TICK[s].status} title={s.replace("_", " ")}>
                          {TICK[s].mark}
                        </Tag>
                      ))}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
