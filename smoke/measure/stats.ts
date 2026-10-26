// WP1 measurement: every INTERVAL_S seconds append one CSV row per container (podman stats + cgroup memory + the Temporal
// database size and workflow counts). Run on the host: node smoke/measure/stats.ts <out.csv> <container> [<container>...]
//   INTERVAL_S (300)  SAMPLES (289 = 24 h + 1 sample)  TEMPORAL_CONTAINER (the first container that runs `temporal`; default evo-wp1-temporal)
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

const [out, ...containers] = process.argv.slice(2);
if (!out || containers.length === 0) {
  console.error("usage: node stats.ts <out.csv> <container> [<container>...]");
  process.exit(2);
}
const intervalS = Number(process.env.INTERVAL_S ?? "300");
const samples = Number(process.env.SAMPLES ?? "289");
const temporalContainer = process.env.TEMPORAL_CONTAINER ?? "evo-wp1-temporal";
const header = "ts,container,state,oom_killed,restarts,cpu_pct,podman_mem,podman_mem_pct,pids,net_io,block_io,cg_current_mb,cg_peak_mb,cg_anon_mb,cg_file_mb,db_bytes,wf_total,wf_running";

function sh(args: string[]): string {
  try {
    return execFileSync("podman", args, { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
const mb = (bytes: string): string => (bytes === "" || Number.isNaN(Number(bytes)) ? "" : (Number(bytes) / 1048576).toFixed(1));

function row(name: string): string {
  const ts = new Date().toISOString();
  const inspect = sh(["inspect", "--format", "{{.State.Status}},{{.State.OOMKilled}},{{.RestartCount}}", name]) || ",,";
  let stats: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(sh(["stats", "--no-stream", "--format", "json", name]) || "[]");
    if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object") stats = parsed[0] as Record<string, string>;
  } catch {
    // container gone: empty cells
  }
  const cg = (file: string) => sh(["exec", name, "cat", `/sys/fs/cgroup/${file}`]);
  const stat = cg("memory.stat");
  const field = (key: string) => stat.split("\n").find((l) => l.startsWith(`${key} `))?.split(" ")[1] ?? "";
  let db = "";
  let total = "";
  let running = "";
  if (name === temporalContainer) {
    db = sh(["exec", name, "stat", "-c", "%s", "/data/temporal.db"]);
    const count = (query: string) => /Total: (\d+)/.exec(sh(["exec", name, "temporal", "workflow", "count", "--address", "127.0.0.1:7233", "--namespace", "evolution", ...(query ? ["--query", query] : [])]))?.[1] ?? "";
    total = count("");
    running = count('ExecutionStatus="Running"');
  }
  const cells = [ts, name, inspect, (stats.cpu_percent ?? "").replace("%", ""), (stats.mem_usage ?? "").replace(/,/g, ";"), (stats.mem_percent ?? "").replace("%", ""), stats.pids ?? "", (stats.net_io ?? "").replace(/,/g, ";"), (stats.block_io ?? "").replace(/,/g, ";"), mb(cg("memory.current")), mb(cg("memory.peak")), mb(field("anon")), mb(field("file")), db, total, running];
  return cells.join(",");
}

if (!existsSync(out)) appendFileSync(out, `${header}\n`);
for (let i = 0; i < samples; i++) {
  const started = Date.now();
  for (const c of containers) appendFileSync(out, `${row(c)}\n`);
  const wait = intervalS * 1000 - (Date.now() - started);
  if (i < samples - 1 && wait > 0) await new Promise((r) => setTimeout(r, wait));
}
