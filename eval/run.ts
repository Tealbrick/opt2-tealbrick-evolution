// T1 evals (G6 §6.0, C250 Release B): deterministic, no model, synthetic public-safe fixtures. Runs both suites through
// the REAL src code and prints one tealbrick.eval/1 line (JSON) per metric to stdout:
//   detector: eval/cases/detector/*.json → parseDoneIssues + buildGroups + the N filter, exactly as src/scan.ts does;
//             EVERY case must match (knownMiss cases excepted: reported, never passed); precision and recall over the
//             other cases vs eval/thresholds.json (detector.precision / detector.recall, the measured 1.0 / 1.0)
//   cycles:   eval/cases/cycles/*.json (run histories) → runStats (src/cycles.ts) + cycleEval + verdictOf (src/evals.ts);
//             every expected verdict and metric value must match
// Exit 1 on any failure. Usage: node eval/run.ts [--out <file>] [--cases <dir>] [--thresholds <file>]
// tealbrick-ci.json preReleaseChecks runs it on every pipeline (ci-v9.6+).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type LedgerRun, runStats } from "../src/cycles.ts";
import { buildGroups, parseDoneIssues } from "../src/detector.ts";
import { APP_VERSION, type CycleStats, cycleEval, type EvalResult, round, type Thresholds, verdictOf } from "../src/evals.ts";
import type { RunStatus } from "../src/routines.ts";

export interface DetectorCase {
  name: string;
  note?: string;
  /** an E5 target the detector does not reach yet: expected is the gold, the case never counts as a pass */
  knownMiss?: boolean;
  minRepeats: number;
  covered: string[];
  output: unknown;
  expected: string[];
}
export interface RunSpec {
  status: RunStatus;
  count?: number;
  dueAt?: string;
  automationId?: string;
  /** claimed / dispatched only: older than the timeout (counted uncertain) */
  stale?: boolean;
  kanban?: "none" | "pending" | "done" | "failed";
}
export interface CycleCase {
  name: string;
  note?: string;
  now: string;
  parent: RunSpec[] | null;
  runs: RunSpec[];
  expected: { verdict: string; metrics: Record<string, { value: number | null; pass: boolean | null }> };
}
export interface SuiteResult {
  lines: EvalResult[];
  failures: string[];
  /** per-case detector differences (stderr only: precision and recall decide) */
  notes: string[];
}

const root = fileURLToPath(new URL("..", import.meta.url));
export const CASES_DIR = join(root, "eval", "cases");
export const THRESHOLDS_FILE = join(root, "eval", "thresholds.json");

export function loadCases<T>(dir: string): T[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as T);
}

/** The keys the detector suggests for one case: the scan's own steps (src/scan.ts scanOnce), without the database. */
export function detectorKeys(c: DetectorCase): string[] {
  return buildGroups(parseDoneIssues(c.output), new Set(c.covered))
    .filter((g) => g.issues.length >= c.minRepeats)
    .map((g) => g.key)
    .sort();
}

/** The detector under test: case → suggested group keys. Tests pass a broken one to prove the gate fires. */
export type Detect = (c: DetectorCase) => string[];

/** Every case must match exactly (ANY difference fails the run), except `knownMiss` cases: their expected list is the
 *  gold the detector should reach (E5); they are reported as known misses, never counted as passes, and kept out of
 *  precision and recall. Precision and recall over the other cases are reported against thresholds.json too. */
export function runDetectorSuite(
  cases: readonly DetectorCase[],
  t: Thresholds,
  ts: string,
  detect: Detect = detectorKeys,
): SuiteResult & { tp: number; fp: number; fn: number; knownMisses: string[] } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const failures: string[] = [];
  const notes: string[] = [];
  const knownMisses: string[] = [];
  for (const c of cases) {
    const got = new Set(detect(c));
    const want = new Set(c.expected);
    const extra = [...got].filter((k) => !want.has(k));
    const missing = [...want].filter((k) => !got.has(k));
    const diff = `unexpected ${JSON.stringify(extra)}, missing ${JSON.stringify(missing)}`;
    if (c.knownMiss) {
      knownMisses.push(c.name);
      notes.push(extra.length || missing.length ? `known miss "${c.name}": ${diff}` : `known miss "${c.name}" now matches its gold: drop knownMiss`);
      continue;
    }
    tp += [...got].filter((k) => want.has(k)).length;
    fp += extra.length;
    fn += missing.length;
    if (extra.length || missing.length) failures.push(`detector case "${c.name}": ${diff}`);
  }
  const precision = tp + fp === 0 ? 1 : round(tp / (tp + fp));
  const recall = tp + fn === 0 ? 1 : round(tp / (tp + fn));
  const line = (metric: string, value: number, threshold: number | null, baseline: number | null): EvalResult => ({
    app: "evolution",
    version: APP_VERSION,
    suite: "detector",
    tier: "T1",
    metric,
    value,
    threshold,
    baseline,
    pass: threshold === null ? null : value >= threshold,
    ts,
  });
  const lines = [
    line("precision", precision, t.detector.precision, t.detector.baseline?.precision ?? null),
    line("recall", recall, t.detector.recall, t.detector.baseline?.recall ?? null),
    line("known_misses", knownMisses.length, null, null),
  ];
  for (const l of lines) if (l.pass === false) failures.push(`detector ${l.metric} ${l.value} < ${l.threshold}`);
  return { lines, failures, notes, tp, fp, fn, knownMisses };
}

const HOUR = 3_600_000;

/** Run specs → ledger rows: due times one hour apart from 1 Oct 2026 unless given; claims 30 s after due, 60 s long. */
export function expandRuns(specs: readonly RunSpec[], now: number): LedgerRun[] {
  const out: LedgerRun[] = [];
  let i = 0;
  for (const s of specs) {
    for (let k = 0; k < (s.count ?? 1); k++) {
      const dueAt = s.dueAt ? Date.parse(s.dueAt) : Date.parse("2026-10-01T08:00:00Z") + i * HOUR;
      i++;
      const claimed = s.status !== "missed" && s.status !== "policy_stale";
      const claimedAt = claimed ? dueAt + 30_000 : null;
      const open = s.status === "claimed" || s.status === "dispatched";
      const updatedAt = open ? (s.stale ? now - 2 * HOUR : now - 60_000) : claimedAt !== null ? claimedAt + 60_000 : dueAt;
      out.push({
        automationId: s.automationId ?? "aut_01J0000000000000000000000A",
        dueAt,
        status: s.status,
        workflowVersion: 1,
        claimedAt,
        updatedAt,
        kanbanIssueId: s.kanban && s.kanban !== "none" ? `iss_01J${String(i).padStart(23, "0")}` : null,
        kanbanSync: s.kanban ?? "none",
      });
    }
  }
  return out;
}

function statsOf(specs: readonly RunSpec[], now: number, version: number): CycleStats {
  return { workflowId: "wfl_01J0000000000000000000000W", version, ...runStats(expandRuns(specs, now), now) };
}

export function runCycleSuite(cases: readonly CycleCase[], t: Thresholds, ts: string): SuiteResult {
  const failures: string[] = [];
  const lines: EvalResult[] = [];
  for (const c of cases) {
    const now = Date.parse(c.now);
    const parent = c.parent ? statsOf(c.parent, now, 1) : null;
    const results = cycleEval(statsOf(c.runs, now, parent ? 2 : 1), parent, t, { ts });
    const problems: string[] = [];
    const verdict = verdictOf(results);
    if (verdict !== c.expected.verdict) problems.push(`verdict ${verdict}, expected ${c.expected.verdict}`);
    for (const [metric, want] of Object.entries(c.expected.metrics)) {
      const got = results.find((r) => r.metric === metric);
      if (!got) problems.push(`${metric} missing`);
      else if (got.value !== want.value || got.pass !== want.pass) problems.push(`${metric} = ${got.value} pass ${got.pass}, expected ${want.value} pass ${want.pass}`);
    }
    lines.push({ app: "evolution", version: APP_VERSION, suite: "cycles", tier: "T1", metric: `case:${c.name}`, value: problems.length ? 0 : 1, threshold: 1, baseline: null, pass: problems.length === 0, ts });
    if (problems.length) failures.push(`cycle case "${c.name}": ${problems.join("; ")}`);
  }
  return { lines, failures, notes: [] };
}

/** The process exit code of a run: 1 on any failure. */
export function exitCode(r: SuiteResult): 0 | 1 {
  return r.failures.length ? 1 : 0;
}

export function runAll(opts: { casesDir?: string; thresholds?: Thresholds; ts?: string; detect?: Detect } = {}): SuiteResult {
  const t = opts.thresholds ?? (JSON.parse(readFileSync(THRESHOLDS_FILE, "utf8")) as Thresholds);
  const dir = opts.casesDir ?? CASES_DIR;
  const ts = opts.ts ?? new Date().toISOString();
  const d = runDetectorSuite(loadCases<DetectorCase>(join(dir, "detector")), t, ts, opts.detect);
  const c = runCycleSuite(loadCases<CycleCase>(join(dir, "cycles")), t, ts);
  return { lines: [...d.lines, ...c.lines], failures: [...d.failures, ...c.failures], notes: [...d.notes, ...c.notes] };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 1 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const thresholdsFile = arg("--thresholds");
  const casesDir = arg("--cases");
  const outFile = arg("--out");
  const r = runAll({
    ...(casesDir ? { casesDir: resolve(casesDir) } : {}),
    ...(thresholdsFile ? { thresholds: JSON.parse(readFileSync(resolve(thresholdsFile), "utf8")) as Thresholds } : {}),
  });
  const text = r.lines.map((l) => JSON.stringify(l)).join("\n");
  console.log(text);
  if (outFile) writeFileSync(resolve(outFile), `${text}\n`);
  for (const n of r.notes) console.error(n);
  for (const f of r.failures) console.error(`FAIL ${f}`);
  console.error(r.failures.length ? `eval: ${r.failures.length} failure(s)` : `eval: pass (${r.lines.length} lines)`);
  process.exit(exitCode(r));
}
