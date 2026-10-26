// WP1 measurement: summary of stats.csv (written by stats.ts) per container: samples, CPU and memory percentiles, peak memory,
// OOM kills / restarts, and for the Temporal container the database growth and workflow counts.
//   node smoke/measure/summarize.ts <stats.csv> [sinceIso]     (sinceIso: ignore earlier rows, e.g. the first-hour window start)
import { readFileSync } from "node:fs";

const [file, since] = process.argv.slice(2);
if (!file) {
  console.error("usage: node summarize.ts <stats.csv> [sinceIso]");
  process.exit(2);
}
const [head, ...lines] = readFileSync(file, "utf8").trim().split("\n");
const cols = (head ?? "").split(",");
const rows = lines
  .map((l) => {
    const cells = l.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""])) as Record<string, string>;
  })
  .filter((r) => !since || (r.ts ?? "") >= since);

const num = (r: Record<string, string>, k: string): number | null => {
  const v = r[k];
  return v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v);
};
const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? Number.NaN;
};
const fmt = (xs: number[]) => (xs.length === 0 ? "n/a" : `min ${Math.min(...xs).toFixed(1)}  p50 ${pct(xs, 50).toFixed(1)}  p95 ${pct(xs, 95).toFixed(1)}  max ${Math.max(...xs).toFixed(1)}`);

for (const name of [...new Set(rows.map((r) => r.container))]) {
  const rs = rows.filter((r) => r.container === name);
  const col = (k: string) => rs.map((r) => num(r, k)).filter((x): x is number => x !== null);
  const first = rs[0];
  const last = rs.at(-1);
  console.log(`\n${name}: ${rs.length} samples, ${first?.ts} .. ${last?.ts}`);
  console.log(`  states: ${[...new Set(rs.map((r) => r.state))].join(",")}  oom_killed any: ${rs.some((r) => r.oom_killed === "true")}  restarts max: ${Math.max(...col("restarts"), 0)}`);
  console.log(`  cpu %            ${fmt(col("cpu_pct"))}`);
  console.log(`  memory current MB ${fmt(col("cg_current_mb"))}`);
  console.log(`  memory anon MB    ${fmt(col("cg_anon_mb"))}`);
  console.log(`  memory file MB    ${fmt(col("cg_file_mb"))}`);
  console.log(`  memory peak MB    ${fmt(col("cg_peak_mb"))} (cgroup high-water mark)`);
  const db = rs.map((r) => ({ t: Date.parse(r.ts ?? ""), b: num(r, "db_bytes"), w: num(r, "wf_total") })).filter((x) => x.b !== null);
  const d0 = db[0];
  const d1 = db.at(-1);
  if (d0 && d1 && d1.t > d0.t) {
    const hours = (d1.t - d0.t) / 3_600_000;
    const perHour = ((d1.b ?? 0) - (d0.b ?? 0)) / hours;
    console.log(`  database: ${((d0.b ?? 0) / 1048576).toFixed(2)} MB -> ${((d1.b ?? 0) / 1048576).toFixed(2)} MB in ${hours.toFixed(1)} h = ${(perHour / 1048576).toFixed(3)} MB/h; at 14 days (336 h) ~ ${((perHour * 336) / 1048576).toFixed(0)} MB (restore limit 512 MB, volume 5 GB)`);
    console.log(`  workflows in the namespace: ${d0.w} -> ${d1.w}`);
  }
}
