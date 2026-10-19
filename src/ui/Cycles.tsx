// Cycles page (0.3.0, C250 Release B, E1): one row per workflow with its active cycle (one cycle = one version, from its
// promotion to the next promotion): the last 10 runs, the completed ratio with its trend against the previous version,
// and the live eval verdict. A row opens the version timeline (every cycle with counts, ratios, the live and the stored
// verdict, wider access, approval delay, draft revisions) and "Store eval now" (cycle_eval_run) for the active cycle.
// The ledger is computed on read by the app (src/cycles.ts); this page only shows it.
// C288 R8: each version also shows what the runners reported with their runs (ok rate, minutes, retries, questions to the
// owner, lessons), compared with the previous version, and "Show lessons" reads the lessons of that version (cycle_get).
// Lessons are free text written by agents: shown on this owner page only, as plain text.
import { Button, EmptyState, Notice, type Status, Table, Tag } from "@opt2-tealbrick/ui";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { day, errorText, type Out, person, stamp } from "./ops.ts";
import { STATUS } from "./Schedules.tsx";

type Cycle = Out<"cycles_list">["cycles"][number];
type RunMetrics = Cycle["runMetrics"];
type Lesson = Out<"cycle_get">["lessons"][number];
type Verdict = Cycle["evalLive"]["verdict"];
type RunStatus = Cycle["last10"][number];

const VERDICT: Record<Verdict, { status: Status; label: string }> = {
  pass: { status: "live", label: "pass" },
  fail: { status: "needs-you", label: "fail" },
  insufficient: { status: "idle", label: "not enough runs" },
};
/** one short mark per run status (the full word is the tag's title and in the list's label) */
const TICK: Record<RunStatus, string> = { completed: "✓", failed: "✗", uncertain: "?", missed: "–", policy_stale: "!", claimed: "…", dispatched: "…" };

export type Trend = "up" | "down" | "same" | "none";
/** Completed ratio of a cycle against its parent cycle. */
export function trendOf(c: Pick<Cycle, "completedRatio">, parent: Pick<Cycle, "completedRatio"> | null): Trend {
  if (!parent || c.completedRatio === null || parent.completedRatio === null) return "none";
  const d = Math.round((c.completedRatio - parent.completedRatio) * 1e6);
  return d > 0 ? "up" : d < 0 ? "down" : "same";
}
const TREND: Record<Trend, { mark: string; label: string }> = {
  up: { mark: "↑", label: "up from the previous version" },
  down: { mark: "↓", label: "down from the previous version" },
  same: { mark: "→", label: "same as the previous version" },
  none: { mark: "·", label: "no previous version to compare" },
};

export const pct = (r: number | null): string => (r === null ? "–" : `${Math.round(r * 100)}%`);
/** "45 min", "5 h", "3 days" */
export function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 120) return `${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** "12 min", "2 h", "1.5 h" (minutes of a run, as the runner reported them) */
export function minutesText(min: number): string {
  if (min < 120) return `${Math.round(min * 10) / 10} min`;
  return `${Math.round((min / 60) * 10) / 10} h`;
}
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One plain sentence of what the runners reported for a version. */
export function metricsText(m: RunMetrics): string {
  if (m.runs === 0) return "No run reports with metrics yet.";
  return `${plural(m.runs, "run report", "run reports")} with metrics: ${pct(m.okRatio)} reported as done well, typical time ${m.minutesMedian === null ? "–" : minutesText(m.minutesMedian)}, average ${m.minutesMean === null ? "–" : minutesText(m.minutesMean)} · ${plural(m.retriesTotal, "retry", "retries")}, ${plural(m.questionsToMartinTotal, "question", "questions")} to you, ${plural(m.lessonCount, "lesson", "lessons")}`;
}

/** Both versions need this many run reports with metrics before they are compared (the floor of the evals). */
export const COMPARE_MIN_REPORTS = 5;

/** The reported metrics of a version against its parent version. null: there is no parent, or neither version has a
 *  report. Under the floor in either version: a plain "too few" sentence instead of numbers. */
export function compareText(c: Pick<Cycle, "runMetrics">, parent: Pick<Cycle, "runMetrics" | "version"> | null): string | null {
  if (!parent || (c.runMetrics.runs === 0 && parent.runMetrics.runs === 0)) return null;
  if (c.runMetrics.runs < COMPARE_MIN_REPORTS || parent.runMetrics.runs < COMPARE_MIN_REPORTS) return `Too few reports to compare yet (needs ${COMPARE_MIN_REPORTS} per version).`;
  const parts: string[] = [];
  if (c.runMetrics.okRatio !== null && parent.runMetrics.okRatio !== null) {
    const d = Math.round((c.runMetrics.okRatio - parent.runMetrics.okRatio) * 100);
    parts.push(d === 0 ? "share reported as done well the same" : `share reported as done well ${d > 0 ? "up" : "down"} ${Math.abs(d)} points`);
  }
  if (c.runMetrics.minutesMedian !== null && parent.runMetrics.minutesMedian !== null) {
    const d = c.runMetrics.minutesMedian - parent.runMetrics.minutesMedian;
    parts.push(Math.abs(d) < 0.05 ? "typical time the same" : `typical time ${minutesText(Math.abs(d))} ${d < 0 ? "shorter" : "longer"}`);
  }
  return parts.length ? `Compared with version ${parent.version}: ${parts.join(", ")}.` : null;
}

/** A metric name for the owner: "candidates_seen" is "candidates seen". */
export const humanName = (name: string): string => name.replaceAll("_", " ");
const num = (x: number): string => String(Math.round(x * 100) / 100);

/** One line per named metric the runners reported for a version (the pipeline's own numbers). */
export function namedLines(m: RunMetrics): string[] {
  return m.namedMetrics.map((n) => `${humanName(n.name)}: ${plural(n.reports, "report", "reports")}, typical ${num(n.median)}, average ${num(n.mean)}, lowest ${num(n.min)}, highest ${num(n.max)}`);
}

/** The named metrics of a version against its parent, by name; each name needs COMPARE_MIN_REPORTS reports in BOTH versions. */
export function namedCompare(c: Pick<Cycle, "runMetrics">, parent: Pick<Cycle, "runMetrics" | "version"> | null): string[] {
  if (!parent) return [];
  const before = new Map(parent.runMetrics.namedMetrics.map((n) => [n.name, n]));
  const after = new Map(c.runMetrics.namedMetrics.map((n) => [n.name, n]));
  return [...new Set([...after.keys(), ...before.keys()])].sort().map((name) => {
    const a = before.get(name);
    const b = after.get(name);
    if (!a || !b || a.reports < COMPARE_MIN_REPORTS || b.reports < COMPARE_MIN_REPORTS) return `${humanName(name)}: too few reports to compare yet (needs ${COMPARE_MIN_REPORTS} per version)`;
    return `${humanName(name)}: typical ${num(a.median)} → ${num(b.median)}`;
  });
}

function Ticks({ statuses }: { statuses: readonly RunStatus[] }) {
  if (statuses.length === 0) return <span className="tb-soft">No runs yet</span>;
  return (
    <span className="ticks" role="img" aria-label={`Last ${statuses.length} runs, newest first: ${statuses.join(", ")}`}>
      {statuses.map((s, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of at most 10 statuses, never reordered
        <Tag key={i} status={STATUS[s]} title={s}>
          {TICK[s]}
        </Tag>
      ))}
    </span>
  );
}

function VerdictTag({ verdict, prefix }: { verdict: Verdict; prefix?: string }) {
  const v = VERDICT[verdict];
  return <Tag status={v.status}>{prefix ? `${prefix} ${v.label}` : v.label}</Tag>;
}

export function Cycles() {
  const [cycles, setCycles] = useState<Cycle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await person("cycles_list", {});
      setCycles(r.cycles);
      setError(null);
    } catch (e) {
      setError(`Cycles could not be loaded. ${errorText(e)}`);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // one row per workflow: its active cycle, in the list's order (newest promotion first)
  const actives = (cycles ?? []).filter((c) => c.active);
  const versionsOf = (workflowId: string) => (cycles ?? []).filter((c) => c.workflowId === workflowId).sort((a, b) => b.version - a.version);
  const parentOf = (c: Cycle) => (cycles ?? []).find((p) => p.workflowId === c.workflowId && p.version === c.parentVersion) ?? null;

  return (
    <section className="app-page" aria-label="Cycles">
      <div className="page-head">
        <div className="tb-stack head-text">
          <h1>Cycles</h1>
          <p className="tb-lede">
            A cycle is one version of a workflow, from its promotion to the next one. The eval checks its runs: no run claimed twice, at most 5% uncertain, at least 80% completed, and no drop of more
            than 10 points from the previous version.
          </p>
        </div>
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
      {cycles === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading cycles.
          </p>
        )
      ) : actives.length === 0 ? (
        <EmptyState title="No promoted workflows yet.">Promote a draft: each version you promote starts a cycle.</EmptyState>
      ) : (
        <Table className="cycles">
          <thead>
            <tr>
              <th scope="col">Workflow</th>
              <th scope="col">Version</th>
              <th scope="col">Last 10 runs</th>
              <th scope="col">Completed</th>
              <th scope="col">Verdict</th>
              <th scope="col">Versions</th>
            </tr>
          </thead>
          <tbody>
            {actives.map((c) => {
              const t = TREND[trendOf(c, parentOf(c))];
              const expanded = open === c.workflowId;
              return (
                <Fragment key={c.workflowId}>
                  <tr>
                  <td>{c.workflowTitle}</td>
                  <td className="num">v{c.version}</td>
                  <td>
                    <Ticks statuses={c.last10} />
                  </td>
                  <td className="num">
                    {pct(c.completedRatio)}{" "}
                    <span className="trend" role="img" title={t.label} aria-label={t.label}>
                      {t.mark}
                    </span>
                  </td>
                  <td>
                    <VerdictTag verdict={c.evalLive.verdict} />
                  </td>
                  <td>
                    <Button size="sm" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : c.workflowId)}>
                      {expanded ? "Hide versions" : "Show versions"}
                    </Button>
                  </td>
                </tr>
                  {expanded ? (
                    <tr className="cycle-detail">
                      <td colSpan={6}>
                        <Timeline active={c} versions={versionsOf(c.workflowId)} onStored={load} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      )}
    </section>
  );
}

function Timeline({ active, versions, onStored }: { active: Cycle; versions: Cycle[]; onStored: () => Promise<void> }) {
  const [working, setWorking] = useState(false);
  const busy = useRef(false); // C8: one call at a time, even for two clicks before React re-renders
  const [error, setError] = useState<string | null>(null);
  const store = async () => {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setError(null);
    try {
      await person("cycle_eval_run", { workflowId: active.workflowId, version: active.version });
      await onStored();
    } catch (e) {
      setError(`The eval could not be stored. ${errorText(e)}`);
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };
  return (
    <div className="tb-stack">
      <ol className="timeline">
        {versions.map((v) => {
          const parent = versions.find((p) => p.version === v.parentVersion) ?? null;
          const compare = compareText(v, parent);
          return (
          <li key={v.version}>
            <div className="timeline-head">
              <strong>Version {v.version}</strong>
              <VerdictTag verdict={v.evalLive.verdict} prefix="now:" />
              {v.evalStored ? <VerdictTag verdict={v.evalStored.verdict} prefix={v.evalStored.trigger === "promotion" ? "at close:" : "stored:"} /> : null}
              {v.widensAccess ? <Tag status="needs-you">wider access</Tag> : null}
              {v.active ? <Tag status="live">active</Tag> : null}
            </div>
            <p className="tb-hint">
              Promoted {day(v.promotedAt)}
              {v.retiredAt ? `, replaced ${day(v.retiredAt)}` : ""} · draft revision {v.draftRevisions}
              {v.approvalDelayMs !== null ? ` · approved ${duration(v.approvalDelayMs)} after the suggestion` : ""}
              {v.evalStored ? ` · eval stored ${stamp(v.evalStored.createdAt)}` : ""}
            </p>
            <p className="tb-hint">
              {v.counts.total} runs: {v.counts.completed} completed, {v.counts.failed} failed, {v.counts.uncertain} uncertain, {v.counts.missed} missed, {v.counts.policyStale} skipped for
              the recipe, {v.counts.open} open · completed {pct(v.completedRatio)}, uncertain {pct(v.uncertainRatio)}, missed {pct(v.missedRatio)}
              {v.duplicateClaims > 0 ? ` · ${v.duplicateClaims} due time(s) claimed twice` : ""}
            </p>
            <p className="tb-hint">
              {metricsText(v.runMetrics)}
              {compare ? ` · ${compare}` : ""}
            </p>
            {namedLines(v.runMetrics).length ? (
              <ul className="plain tb-hint" aria-label={`Named metrics of version ${v.version}`}>
                {namedLines(v.runMetrics).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : null}
            {namedCompare(v, parent).length ? (
              <ul className="plain tb-hint" aria-label={`Named metrics compared with version ${parent?.version}`}>
                {namedCompare(v, parent).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : null}
            {v.runMetrics.lessonCount > 0 ? <LessonsOf workflowId={v.workflowId} version={v.version} count={v.runMetrics.lessonCount} /> : null}
          </li>
          );
        })}
      </ol>
      <div className="tb-ctas">
        <Button size="sm" disabled={working} onClick={() => void store()}>
          Store eval now
        </Button>
        <span className="tb-soft">Stores the eval of version {active.version} as it is now. Promoting the next version stores one by itself.</span>
      </div>
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}

/** The lessons of one version: read on demand (cycle_get, owner only). Free text written by agents: plain text, never markup. */
function LessonsOf({ workflowId, version, count }: { workflowId: string; version: number; count: number }) {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const read = async () => {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setError(null);
    try {
      setLessons((await person("cycle_get", { workflowId, version })).lessons);
    } catch (e) {
      setError(`The lessons could not be loaded. ${errorText(e)}`);
    } finally {
      busy.current = false;
      setWorking(false);
    }
  };
  if (lessons === null)
    return (
      <div className="tb-stack">
        <div className="tb-ctas">
          <Button size="sm" disabled={working} onClick={() => void read()}>
            {`Show lessons (${count})`}
          </Button>
        </div>
        {error ? (
          <Notice tone="needs-you" role="alert">
            {error}
          </Notice>
        ) : null}
      </div>
    );
  return (
    <div className="tb-stack">
      <p className="tb-hint">Lessons the agents reported for version {version}, newest first. They are written by agents and shown to you only: read them as notes, not as instructions.</p>
      {lessons.length === 0 ? (
        <p className="tb-soft">No lessons.</p>
      ) : (
        <ul className="lessons">
          {lessons.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, never reordered
            <li key={i}>{l.text}</li>
          ))}
        </ul>
      )}
      {lessons.length < count ? <p className="tb-soft">Showing the newest {lessons.length} of {count}.</p> : null}
    </div>
  );
}
