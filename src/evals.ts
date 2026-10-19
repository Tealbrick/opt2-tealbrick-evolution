// Evals per cycle (C250 Release B, G6 §4.3 / §6.0): pure functions, no database. One cycle = one workflow version from
// its promotion to the next promotion of the same workflow (src/cycles.ts computes its numbers from the run rows).
// Every result is one tealbrick.eval/1 line {app, version, suite, tier, metric, value, threshold, baseline, pass, ts}.
//   gate metrics: duplicate_claims, uncertain_ratio, completed_ratio, completed_ratio_drop (regression vs the parent)
//   info metrics: missed_ratio (pass computed, not part of the verdict), policy_stale_runs (no threshold)
// Below a metric's minimum sample, pass is null (not enough data) and the value is still reported. Verdict: fail when a
// gate metric fails, pass when every gate metric passes, else insufficient. The thresholds have ONE source:
// eval/thresholds.json (also read by eval/run.ts).
import { readFileSync } from "node:fs";

export type Verdict = "pass" | "fail" | "insufficient";
export type Tier = "T1" | "T2" | "T3";
export interface EvalResult {
  app: "evolution";
  version: string;
  suite: string;
  tier: Tier;
  metric: string;
  value: number | null;
  threshold: number | null;
  baseline: number | null;
  pass: boolean | null;
  ts: string;
}

interface Limit {
  min?: number;
  max?: number;
  minSample?: number;
}
export interface Thresholds {
  detector: { precision: number; recall: number; baseline?: { precision: number; recall: number } };
  cycle: {
    duplicate_claims: Limit;
    uncertain_ratio: Limit;
    completed_ratio: Limit;
    completed_ratio_drop: Limit;
    missed_ratio: Limit;
    policy_stale_runs: Limit;
  };
}

/** What an eval needs of a cycle (src/cycles.ts `Cycle` has these fields and more). */
export interface CycleStats {
  workflowId: string;
  version: number;
  counts: { completed: number; failed: number; uncertain: number; missed: number; policyStale: number };
  completedRatio: number | null;
  uncertainRatio: number | null;
  missedRatio: number | null;
  duplicateClaims: number;
}

export const THRESHOLDS = JSON.parse(readFileSync(new URL("../eval/thresholds.json", import.meta.url), "utf8")) as Thresholds;
/** The app version every eval line carries (the manifest is the only source). */
export const APP_VERSION = String((JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as { version: string }).version);

/** Metrics that decide the cycle verdict; the others are information. */
export const GATE_METRICS: ReadonlySet<string> = new Set(["duplicate_claims", "uncertain_ratio", "completed_ratio", "completed_ratio_drop"]);

export const terminalRuns = (c: CycleStats): number => c.counts.completed + c.counts.failed + c.counts.uncertain;
const n = (v: number | undefined): number | null => (typeof v === "number" ? v : null);

/** The eval of one cycle against its parent (the previous version's cycle, or null for version 1). Version 1 has no
 *  regression metric: there is nothing to regress from, so completed_ratio_drop is left out (not "insufficient"). */
export function cycleEval(c: CycleStats, parent: CycleStats | null, t: Thresholds = THRESHOLDS, meta: { appVersion?: string; ts?: string } = {}): EvalResult[] {
  const base = { app: "evolution" as const, version: meta.appVersion ?? APP_VERSION, suite: `cycle:${c.workflowId}@v${c.version}`, tier: "T2" as const, ts: meta.ts ?? new Date().toISOString() };
  const L = t.cycle;
  const terminal = terminalRuns(c);
  const enough = (l: Limit, sample: number) => sample >= (l.minSample ?? 0);
  const out: EvalResult[] = [];
  const push = (metric: string, value: number | null, threshold: number | null, baseline: number | null, pass: boolean | null) =>
    out.push({ ...base, metric, value, threshold, baseline, pass });

  const dupMax = n(L.duplicate_claims.max) ?? 0;
  push("duplicate_claims", c.duplicateClaims, dupMax, parent ? parent.duplicateClaims : null, c.duplicateClaims <= dupMax);

  const uMax = n(L.uncertain_ratio.max);
  push("uncertain_ratio", c.uncertainRatio, uMax, parent?.uncertainRatio ?? null, uMax !== null && c.uncertainRatio !== null && enough(L.uncertain_ratio, terminal) ? c.uncertainRatio <= uMax : null);

  const cMin = n(L.completed_ratio.min);
  push("completed_ratio", c.completedRatio, cMin, parent?.completedRatio ?? null, cMin !== null && c.completedRatio !== null && enough(L.completed_ratio, terminal) ? c.completedRatio >= cMin : null);

  if (parent) {
    const dMax = n(L.completed_ratio_drop.max);
    const drop = parent.completedRatio !== null && c.completedRatio !== null ? round(parent.completedRatio - c.completedRatio) : null;
    const both = enough(L.completed_ratio_drop, terminal) && enough(L.completed_ratio_drop, terminalRuns(parent));
    push("completed_ratio_drop", drop, dMax, parent.completedRatio, dMax !== null && drop !== null && both ? drop <= dMax : null);
  }

  const mMax = n(L.missed_ratio.max);
  push("missed_ratio", c.missedRatio, mMax, parent?.missedRatio ?? null, mMax !== null && c.missedRatio !== null && enough(L.missed_ratio, c.counts.missed + terminal) ? c.missedRatio <= mMax : null);

  push("policy_stale_runs", c.counts.policyStale, null, parent ? parent.counts.policyStale : null, null);
  return out;
}

/** fail if a gate metric fails; pass if every gate metric passes; else insufficient (some gate lacks data). */
export function verdictOf(results: readonly EvalResult[]): Verdict {
  const gates = results.filter((r) => GATE_METRICS.has(r.metric));
  if (gates.some((r) => r.pass === false)) return "fail";
  return gates.length > 0 && gates.every((r) => r.pass === true) ? "pass" : "insufficient";
}

/** Ratios and differences to 6 decimals, so a stored eval reads 0.1 instead of 0.09999999999999998. */
export function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
