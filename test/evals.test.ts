// C250 Release B: the cycle eval gates (src/evals.ts) quiet-on-good and fire-on-bad for every metric and the verdict,
// and the T1 runner (eval/run.ts): green on the committed corpus, red on a broken detector or a wrong expectation.
// The corpus itself is never edited here: the fire cases mutate a threshold or an expected list in memory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CycleCase, type Detect, type DetectorCase, detectorKeys, exitCode, loadCases, runAll, runCycleSuite, runDetectorSuite } from "../eval/run.ts";
import { buildGroups, parseDoneIssues } from "../src/detector.ts";
import { APP_VERSION, type CycleStats, cycleEval, type EvalResult, THRESHOLDS, type Thresholds, verdictOf } from "../src/evals.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const TS = "2026-10-18T00:00:00.000Z";

function stats(completed: number, failed = 0, uncertain = 0, extra: Partial<CycleStats> & { missed?: number; policyStale?: number } = {}): CycleStats {
  const terminal = completed + failed + uncertain;
  const missed = extra.missed ?? 0;
  const r = (x: number, d: number) => (d ? Math.round((x / d) * 1e6) / 1e6 : null);
  return {
    workflowId: "wfl_01J0000000000000000000000W",
    version: 1,
    counts: { completed, failed, uncertain, missed, policyStale: extra.policyStale ?? 0 },
    completedRatio: r(completed, terminal),
    uncertainRatio: r(uncertain, terminal),
    missedRatio: r(missed, missed + terminal),
    duplicateClaims: extra.duplicateClaims ?? 0,
    ...(extra.version ? { version: extra.version } : {}),
  };
}
const metric = (results: EvalResult[], m: string) => results.find((r) => r.metric === m);
const run = (c: CycleStats, parent: CycleStats | null = null) => cycleEval(c, parent, THRESHOLDS, { ts: TS });

test("thresholds have one source: eval/thresholds.json, as the spec sets them", () => {
  const file = JSON.parse(readFileSync(join(root, "eval", "thresholds.json"), "utf8")) as Thresholds;
  assert.deepEqual(THRESHOLDS, file);
  assert.equal(THRESHOLDS.cycle.duplicate_claims.max, 0);
  assert.deepEqual(THRESHOLDS.cycle.uncertain_ratio, { max: 0.05, minSample: 5 });
  assert.deepEqual(THRESHOLDS.cycle.completed_ratio, { min: 0.8, minSample: 5 });
  assert.deepEqual(THRESHOLDS.cycle.completed_ratio_drop, { max: 0.1, minSample: 5 });
  assert.deepEqual(THRESHOLDS.cycle.missed_ratio, { max: 0.2, minSample: 5 });
  assert.deepEqual([THRESHOLDS.detector.precision, THRESHOLDS.detector.recall], [1, 1], "the measured baseline (G6 floors 0.9 / 0.8)");
});

test("every result is a tealbrick.eval/1 line of the cycle", () => {
  const [first] = run(stats(10));
  assert.deepEqual(Object.keys(first as object).sort(), ["app", "baseline", "metric", "pass", "suite", "threshold", "tier", "ts", "value", "version"]);
  assert.equal(first?.app, "evolution");
  assert.equal(first?.version, APP_VERSION);
  assert.equal(first?.suite, "cycle:wfl_01J0000000000000000000000W@v1");
  assert.equal(first?.tier, "T2");
  assert.equal(first?.ts, TS);
});

test("duplicate_claims: quiet at 0, fires at 1 even with one run (no minimum sample)", () => {
  assert.equal(metric(run(stats(10)), "duplicate_claims")?.pass, true);
  const bad = run(stats(1, 0, 0, { duplicateClaims: 1 }));
  assert.deepEqual([metric(bad, "duplicate_claims")?.value, metric(bad, "duplicate_claims")?.pass], [1, false]);
  assert.equal(verdictOf(bad), "fail");
});

test("uncertain_ratio: quiet at 0.05, fires above it, null below 5 terminal runs", () => {
  assert.equal(metric(run(stats(19, 0, 1)), "uncertain_ratio")?.pass, true);
  assert.equal(metric(run(stats(9, 0, 1)), "uncertain_ratio")?.pass, false);
  const few = metric(run(stats(3, 0, 1)), "uncertain_ratio");
  assert.deepEqual([few?.value, few?.pass], [0.25, null], "value reported, not judged");
});

test("completed_ratio: quiet at 0.80, fires below it, null below 5 terminal runs", () => {
  assert.equal(metric(run(stats(8, 2)), "completed_ratio")?.pass, true);
  assert.equal(metric(run(stats(7, 3)), "completed_ratio")?.pass, false);
  assert.equal(metric(run(stats(1, 3)), "completed_ratio")?.pass, null);
  const none = metric(run(stats(0)), "completed_ratio");
  assert.deepEqual([none?.value, none?.pass], [null, null]);
});

test("completed_ratio_drop: quiet within 10 points, fires over it, null when either cycle is below the sample, absent for v1", () => {
  const parent = stats(10);
  const ok = metric(run(stats(9, 1, 0, { version: 2 }), parent), "completed_ratio_drop");
  assert.deepEqual([ok?.value, ok?.threshold, ok?.baseline, ok?.pass], [0.1, 0.1, 1, true]);
  const bad = run(stats(17, 3, 0, { version: 2 }), parent);
  assert.deepEqual([metric(bad, "completed_ratio_drop")?.value, metric(bad, "completed_ratio_drop")?.pass], [0.15, false]);
  assert.equal(metric(bad, "completed_ratio")?.pass, true, "0.85 alone would pass: the regression gate catches it");
  assert.equal(verdictOf(bad), "fail");
  assert.equal(metric(run(stats(10, 0, 0, { version: 2 }), stats(4)), "completed_ratio_drop")?.pass, null, "parent below the sample");
  assert.equal(metric(run(stats(4, 0, 0, { version: 2 }), parent), "completed_ratio_drop")?.pass, null, "child below the sample");
  assert.equal(metric(run(stats(10)), "completed_ratio_drop"), undefined, "version 1 has nothing to regress from");
});

test("missed_ratio: computed (quiet at 0.20, fires above) but never decides the verdict", () => {
  const ok = run(stats(8, 0, 0, { missed: 2 }));
  assert.equal(metric(ok, "missed_ratio")?.pass, true);
  const bad = run(stats(10, 0, 0, { missed: 5 }));
  assert.deepEqual([metric(bad, "missed_ratio")?.value, metric(bad, "missed_ratio")?.pass], [0.333333, false]);
  assert.equal(verdictOf(bad), "pass", "information only");
  assert.equal(metric(run(stats(2, 0, 0, { missed: 2 })), "missed_ratio")?.pass, null, "below 5");
});

test("policy_stale_runs: information, no threshold, never a verdict", () => {
  const r = metric(run(stats(10, 0, 0, { policyStale: 3 })), "policy_stale_runs");
  assert.deepEqual([r?.value, r?.threshold, r?.pass], [3, null, null]);
  assert.equal(verdictOf(run(stats(10, 0, 0, { policyStale: 3 }))), "pass");
});

test("the minimum sample is inclusive: exactly 5 terminal runs are judged, 4 are not (fires on a > mutation)", () => {
  const five = run(stats(4, 1));
  assert.deepEqual([metric(five, "completed_ratio")?.pass, metric(five, "uncertain_ratio")?.pass], [true, true]);
  assert.equal(verdictOf(five), "pass");
  const four = run(stats(3, 1));
  assert.deepEqual([metric(four, "completed_ratio")?.pass, metric(four, "uncertain_ratio")?.pass], [null, null]);
  assert.equal(verdictOf(four), "insufficient");
  const drop = metric(run(stats(4, 1, 0, { version: 2 }), stats(5)), "completed_ratio_drop");
  assert.deepEqual([drop?.value, drop?.pass], [0.2, false], "judged with exactly 5 in both");
  assert.equal(metric(run(stats(4, 1, 0, { version: 2 }), stats(4)), "completed_ratio_drop")?.pass, null, "4 in the parent");
  assert.equal(metric(run(stats(5, 0, 0, { missed: 0 })), "missed_ratio")?.pass, true);
  assert.equal(metric(run(stats(3, 0, 0, { missed: 1 })), "missed_ratio")?.pass, null);
});

test("verdict: pass when every gate passes, fail on any gate failure, insufficient when a gate lacks data", () => {
  assert.equal(verdictOf(run(stats(10))), "pass");
  assert.equal(verdictOf(run(stats(9, 1, 0, { version: 2 }), stats(10))), "pass");
  assert.equal(verdictOf(run(stats(7, 3))), "fail");
  assert.equal(verdictOf(run(stats(9, 0, 1))), "fail");
  assert.equal(verdictOf(run(stats(4))), "insufficient");
  assert.equal(verdictOf(run(stats(0))), "insufficient");
  assert.equal(verdictOf(run(stats(10, 0, 0, { version: 2 }), stats(2))), "insufficient", "regression check needs data in the parent too");
  assert.equal(verdictOf(run(stats(2, 0, 0, { duplicateClaims: 1 }))), "fail", "a failed gate wins over missing data");
  assert.equal(verdictOf([]), "insufficient");
});

test("a mutated threshold changes the verdict (the gate reads the thresholds, not constants)", () => {
  const strict = structuredClone(THRESHOLDS);
  strict.cycle.completed_ratio.min = 0.95;
  assert.equal(verdictOf(cycleEval(stats(9, 1), null, strict, { ts: TS })), "fail");
  assert.equal(verdictOf(cycleEval(stats(9, 1), null, THRESHOLDS, { ts: TS })), "pass");
});

// ── T1 runner ──

const detectorCases = () => loadCases<DetectorCase>(join(root, "eval", "cases", "detector"));
const cycleCases = () => loadCases<CycleCase>(join(root, "eval", "cases", "cycles"));

test("corpus: at least 30 detector and 10 cycle cases, synthetic ids only", () => {
  const d = detectorCases();
  const c = cycleCases();
  assert.ok(d.length >= 30, `${d.length} detector cases`);
  assert.ok(c.length >= 10, `${c.length} cycle cases`);
  const text = JSON.stringify([d, c]);
  for (const m of text.matchAll(/\b(agt|per|iss|aut|wfl)_[0-9A-Za-z]+/g)) assert.match(m[0], /^[a-z]{3}_01J0+[0-9A-Z]?$|^iss_01J\d+$/, `synthetic id: ${m[0]}`);
  const known = d.filter((x) => x.knownMiss);
  assert.equal(known.length, 3, "the near-duplicate E5 targets");
  assert.ok(known.every((x) => x.expected.length > 0 && x.note?.includes("E5 target")), "a known miss carries its gold group");
  const positive = d.filter((x) => !x.knownMiss).reduce((n, x) => n + x.expected.length, 0);
  assert.ok(positive >= 25, `${positive} must-suggest groups`);
});

test("runner quiet: the committed corpus passes both suites with the committed thresholds", () => {
  const r = runAll({ ts: TS });
  assert.deepEqual(r.failures, []);
  const p = r.lines.find((l) => l.suite === "detector" && l.metric === "precision");
  const rc = r.lines.find((l) => l.suite === "detector" && l.metric === "recall");
  assert.ok(p?.pass && rc?.pass);
  assert.equal(r.lines.filter((l) => l.suite === "cycles").length, cycleCases().length);
});

// ── broken detectors (in memory; the corpus is never edited): each must make the run exit 1 ──

type Raw = Record<string, unknown>;
/** applies `f` to every issue object of a kanban.issues_list output ({issues} or {items}) */
function mapIssues(output: unknown, f: (i: Raw) => Raw): unknown {
  if (!output || typeof output !== "object") return output;
  const o = output as { issues?: unknown; items?: unknown };
  const map = (l: unknown) => (Array.isArray(l) ? l.map((i) => (i && typeof i === "object" && !Array.isArray(i) ? f(i as Raw) : i)) : l);
  return { ...o, ...(o.issues !== undefined ? { issues: map(o.issues) } : {}), ...(o.items !== undefined ? { items: map(o.items) } : {}) };
}
const BROKEN: Record<string, { detect: Detect; fails: string }> = {
  "status not done counted": { detect: (c) => detectorKeys({ ...c, output: mapIssues(c.output, (i) => ({ ...i, status: "done" })) }), fails: "status not done is skipped" },
  "covered issues ignored": { detect: (c) => detectorKeys({ ...c, covered: [] }), fails: "covered issues: all covered" },
  "any flat assignee is an agent (owner / person ids too)": {
    detect: (c) => detectorKeys({ ...c, output: mapIssues(c.output, (i) => (typeof i.assignee === "string" ? { ...i, assignee: { kind: "agent", id: i.assignee } } : i)) }),
    fails: "a flat assignee that is not an agent id",
  },
  "no number normalisation": {
    // numbers no longer collapse to #: digits become letters before the real normalisation
    detect: (c) =>
      buildGroups(
        parseDoneIssues(c.output).map((i) => ({ ...i, title: i.title.replace(/\d/g, (x) => String.fromCharCode(97 + Number(x))) })),
        new Set(c.covered),
      )
        .filter((g) => g.issues.length >= c.minRepeats)
        .map((g) => g.key),
    fails: "numbered titles",
  },
};
for (const [name, b] of Object.entries(BROKEN))
  test(`runner fires on a broken detector: ${name}`, () => {
    const r = runAll({ ts: TS, detect: b.detect });
    assert.equal(exitCode(r), 1);
    assert.ok(
      r.failures.some((f) => f.startsWith(`detector case "${b.fails}"`)),
      `names the case: ${r.failures.join(" | ")}`,
    );
  });

test("runner quiet: the real detector exits 0; known misses are reported, never counted as passes", () => {
  const r = runAll({ ts: TS });
  assert.equal(exitCode(r), 0);
  assert.equal(r.lines.find((l) => l.metric === "known_misses")?.value, 3);
  assert.equal(r.notes.filter((n) => n.startsWith("known miss")).length, 3);
  const d = runDetectorSuite(detectorCases(), THRESHOLDS, TS);
  assert.equal(d.tp, detectorCases().filter((c) => !c.knownMiss).reduce((n, c) => n + c.expected.length, 0), "known-miss gold is not in tp");
});

const KNOWN_MISSES = ["near-duplicate: word order", "near-duplicate: plural and article", "near-duplicate: typo"];

test("known misses are pinned: exactly these three cases carry knownMiss", () => {
  assert.deepEqual(
    detectorCases()
      .filter((c) => c.knownMiss)
      .map((c) => c.name),
    KNOWN_MISSES,
  );
});

test("runner fires: a known miss that fully matches its gold fails (remove knownMiss to lock in E5 progress)", () => {
  const gold: Detect = (c) => (c.name === KNOWN_MISSES[0] ? c.expected : detectorKeys(c));
  const r = runAll({ ts: TS, detect: gold });
  assert.equal(exitCode(r), 1);
  assert.deepEqual(r.failures, [`detector case "${KNOWN_MISSES[0]}": known miss now passes: remove knownMiss`]);
});

test("runner fires: a wrong (extra) group in a known-miss case fails; only missing gold groups are tolerated", () => {
  const wrong: Detect = (c) => (c.name === KNOWN_MISSES[1] ? [...detectorKeys(c), "agt_01J0000000000000000000000B|title:send invoices to acme"] : detectorKeys(c));
  const r = runAll({ ts: TS, detect: wrong });
  assert.equal(exitCode(r), 1);
  assert.equal(r.failures.length, 1);
  assert.match(r.failures[0] ?? "", /near-duplicate: plural and article" \(known miss\): unexpected/);
  // quiet: the real detector (gold group missing, nothing wrong) is tolerated
  assert.deepEqual(runAll({ ts: TS }).failures, []);
});

test("runner fires: one false positive or one miss fails, though precision would stay above 0.9", () => {
  const extra: Detect = (c) => (c.name === "below N" ? [...detectorKeys(c), "agt_01J0000000000000000000000A|title:back up the wiki"] : detectorKeys(c));
  assert.equal(exitCode(runAll({ ts: TS, detect: extra })), 1);
  const miss: Detect = (c) => (c.name === "exactly N" ? [] : detectorKeys(c));
  assert.equal(exitCode(runAll({ ts: TS, detect: miss })), 1);
});

test("runner fires: a mutated detector threshold fails the suite", () => {
  const t = structuredClone(THRESHOLDS);
  t.detector.precision = 1.01;
  const r = runDetectorSuite(detectorCases(), t, TS);
  assert.deepEqual(r.failures, ["detector precision 1 < 1.01"]);
});

test("runner fires: a deliberately wrong expected list (a broken detector looks like this) fails precision and recall", () => {
  // every positive case expects keys the detector does not produce: its real keys count as false positives and the
  // wrong ones as misses, so precision and recall both collapse (the corpus files stay unchanged)
  const wrong = detectorCases().map((c) => ({ ...c, expected: c.expected.length ? c.expected.map((k) => `${k}-wrong`) : c.expected }));
  const r = runDetectorSuite(wrong, THRESHOLDS, TS);
  assert.equal(r.tp, 0);
  assert.equal(r.failures.filter((f) => f.startsWith("detector case")).length, wrong.filter((c) => c.expected.length && !c.knownMiss).length, "each wrong case is named");
  assert.ok(r.failures.some((f) => f.startsWith("detector precision")));
  assert.ok(r.failures.some((f) => f.startsWith("detector recall")));
});

test("runner fires: a cycle case with a wrong expected verdict or value fails", () => {
  const [first, second] = cycleCases() as [CycleCase, CycleCase];
  const r = runCycleSuite([{ ...first, expected: { ...first.expected, verdict: "fail" } }, { ...second, expected: { verdict: second.expected.verdict, metrics: { completed_ratio: { value: 0.5, pass: true } } } }], THRESHOLDS, TS);
  assert.equal(r.failures.length, 2);
  assert.deepEqual(
    r.lines.map((l) => l.pass),
    [false, false],
  );
});

test("the detector keys of the runner are the scan's: owner work and Evolution runs never, N respected", () => {
  const byName = new Map(detectorCases().map((c) => [c.name, c]));
  assert.deepEqual(detectorKeys(byName.get("owner-assigned work is never suggested") as DetectorCase), []);
  assert.deepEqual(detectorKeys(byName.get("runs of an Evolution workflow are never suggested (template)") as DetectorCase), []);
  const exact = byName.get("exactly N") as DetectorCase;
  assert.equal(detectorKeys(exact).length, 1);
  assert.deepEqual(detectorKeys({ ...exact, minRepeats: 4 }), []);
});

test("node eval/run.ts: exit 0 and tealbrick.eval/1 lines on the corpus; exit 1 with a mutated thresholds file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "evolution-eval-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, "eval-report.jsonl");
  const ok = spawnSync(process.execPath, ["eval/run.ts", "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const lines = readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l) as EvalResult);
  assert.deepEqual(lines.map((l) => l.metric).slice(0, 2), ["precision", "recall"]);
  assert.ok(lines.every((l) => l.app === "evolution" && typeof l.ts === "string" && "baseline" in l));

  const strict = structuredClone(THRESHOLDS);
  strict.detector.recall = 1.5;
  const file = join(dir, "thresholds.json");
  writeFileSync(file, JSON.stringify(strict));
  const bad = spawnSync(process.execPath, ["eval/run.ts", "--thresholds", file], { cwd: root, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /FAIL detector recall 1 < 1\.5/);
});
