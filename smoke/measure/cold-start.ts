// WP1 measurement: cold start of the service image on a COPY of the live database. At each offset (hours after this script
// starts) it takes a consistent dump from the running measurement container with temporal-dump, starts a throwaway container
// on a host directory holding that copy, and times `podman run` -> gRPC answers. The live container is only read.
//   node smoke/measure/cold-start.ts <out.csv> <work-dir> <hours,hours,...>
//   TEMPORAL_CONTAINER (evo-wp1-temporal)  IMAGE (localhost/evo-wp1-temporal:1.9.1)
import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const [out, workDir, offsets] = process.argv.slice(2);
if (!out || !workDir || !offsets) {
  console.error("usage: node cold-start.ts <out.csv> <work-dir> <hours,hours,...>");
  process.exit(2);
}
const live = process.env.TEMPORAL_CONTAINER ?? "evo-wp1-temporal";
const image = process.env.IMAGE ?? "localhost/evo-wp1-temporal:1.9.1";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const podman = (args: string[], stdio: "pipe" | number = "pipe") => execFileSync("podman", args, { encoding: "utf8", stdio: ["ignore", stdio, "pipe"] });

if (!existsSync(out)) appendFileSync(out, "ts,after_hours,db_bytes,wf_total,run_to_grpc_s\n");
mkdirSync(workDir, { recursive: true });
const t0 = Date.now();
for (const h of offsets.split(",").map(Number)) {
  const wait = t0 + h * 3_600_000 - Date.now();
  if (wait > 0) await sleep(wait);
  const dir = resolve(workDir, `cold-${h}h`);
  mkdirSync(dir, { recursive: true });
  const dump = join(dir, "temporal.db");
  const fd = openSync(dump, "w");
  try {
    execFileSync("podman", ["exec", live, "/opt/temporal/temporal-dump"], { stdio: ["ignore", fd, "inherit"] });
  } finally {
    closeSync(fd);
  }
  const name = `evo-wp1-cold-${h}h`;
  const started = process.hrtime.bigint();
  podman(["run", "-d", "--rm", "--name", name, "--user", "root", "-e", "HOME=/tmp", "-v", `${dir}:/data:Z`, "--entrypoint", "/opt/temporal/run.sh", "--memory", "768m", "--cpus", "0.5", image]);
  let seconds = Number.NaN;
  for (let i = 0; i < 600; i++) {
    try {
      podman(["exec", name, "temporal", "operator", "cluster", "health", "--address", "127.0.0.1:7233"]);
      seconds = Number(process.hrtime.bigint() - started) / 1e9;
      break;
    } catch {
      await sleep(100);
    }
  }
  let total = "";
  try {
    total = /Total: (\d+)/.exec(podman(["exec", name, "temporal", "workflow", "count", "--address", "127.0.0.1:7233", "--namespace", "evolution"]))?.[1] ?? "";
  } catch {
    // leave empty
  }
  try {
    podman(["stop", "-t", "10", name]);
  } catch {
    // already gone
  }
  appendFileSync(out, `${new Date().toISOString()},${h},${statSync(dump).size},${total},${seconds.toFixed(2)}\n`);
}
