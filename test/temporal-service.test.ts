// C367 WP1: the `temporal` companion. (1) static checks: manifest block, CI image list, Dockerfile pins; (2) the shell scripts
// (run.sh supervisor, temporal-dump, temporal-restore) against a fake `temporal` binary and a node:sqlite based `sqlite3` double,
// so they run in the CI node image, which has no sqlite3. The real binary and the real sqlite3 are covered by
// smoke/engine-smoke.ts on the built image.
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateAppFiles, validateManifest } from "@opt2-tealbrick/manifest";
import { KEY_RETIRE_AFTER_HOURS, TEMPORAL_RETENTION_HOURS } from "../src/engine/keystore.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const svcDir = join(root, "services/temporal");
const fixtures = join(root, "test/fixtures/temporal-service");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const json = (rel: string) => JSON.parse(read(rel)) as Record<string, unknown>;

// ---------- static checks ----------

/** Problems in a Dockerfile text: a FROM without a sha256 digest, a VOLUME, an npm/pnpm install without the frozen/no-scripts flags. */
export function dockerfileProblems(text: string): string[] {
  const out: string[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (/^FROM\s/i.test(t) && !/@sha256:[0-9a-f]{64}(\s|$)/.test(t)) out.push(`line ${i + 1}: FROM without a sha256 digest`);
    if (/^VOLUME(\s|\[|$)/i.test(t)) out.push(`line ${i + 1}: VOLUME`);
    if (/\bnpm\s+(install|i)\b/.test(t) && !/npm\s+(install|i)\s+-g\s/.test(t)) out.push(`line ${i + 1}: npm install`);
    if (/\bnpm\s+ci\b/.test(t) && !/--ignore-scripts/.test(t)) out.push(`line ${i + 1}: npm ci without --ignore-scripts`);
    if (/\bpnpm\s+(install|i|add)\b/.test(t) && !(/--frozen-lockfile/.test(t) && /--ignore-scripts/.test(t))) out.push(`line ${i + 1}: pnpm install not frozen or with scripts`);
  });
  return out;
}

test("the temporal Dockerfile: bases by digest, pinned CLI with sha256 per architecture, no VOLUME, frozen installs", () => {
  const df = read("services/temporal/Dockerfile");
  assert.deepEqual(dockerfileProblems(df), []);
  const version = /ARG TEMPORAL_CLI_VERSION=(\d+\.\d+\.\d+)\s/.exec(df)?.[1];
  assert.ok(version, "a pinned CLI version");
  for (const arch of ["AMD64", "ARM64"]) assert.match(df, new RegExp(`ARG TEMPORAL_CLI_SHA256_${arch}=[0-9a-f]{64}\\s`), `sha256 for ${arch}`);
  assert.match(df, /sha256sum -c/, "the download is verified");
  assert.match(read("services/temporal/schema.sha256"), new RegExp(`temporal-cli-${version.replaceAll(".", "\\.")} `), "schema.sha256 names the pinned CLI version");
  assert.match(read("services/temporal/schema.sha256"), /^[0-9a-f]{64} /, "a sha256 first");
  // every COPY source exists in the build context (the repository root)
  for (const m of df.matchAll(/^COPY\s+(?!--from)(.+)\s+\S+$/gm)) {
    for (const src of (m[1] ?? "").split(/\s+/).filter(Boolean)) assert.ok(existsSync(join(root, src)), `COPY source ${src} exists`);
  }
  // the start command of the server is the one in ENGINE-BUILD section 1
  assert.match(read("services/temporal/run.sh"), /temporal server start-dev --headless --ip 0\.0\.0\.0 --port 7233 --db-filename "\$DB" --namespace "\$NAMESPACE" --log-level warn/);
  assert.match(read("services/temporal/run.sh"), /^NAMESPACE=evolution$/m);
});

test("the Dockerfile checker fires on a floating tag, a VOLUME and an unfrozen install", () => {
  const bad = ["FROM node:24-slim", "VOLUME /data", "RUN npm ci --prefix /x", "RUN pnpm install", "RUN npm install left-pad"].join("\n");
  const found = dockerfileProblems(bad);
  assert.equal(found.length, 5, found.join("; "));
});

test("tb-exec in the temporal image uses the same miniapp-sdk version as the app", () => {
  const app = (json("package.json").dependencies as Record<string, string>)["@opt2-tealbrick/miniapp-sdk"];
  const tb = (json("services/temporal/tb-exec/package.json").dependencies as Record<string, string>)["@opt2-tealbrick/miniapp-sdk"];
  assert.equal(tb, app);
  const lock = read("services/temporal/tb-exec/package-lock.json");
  assert.match(lock, /"integrity": "sha512-/, "the lock carries integrity");
});

test("the manifest declares the temporal service, its env on the app, and validates (M-RT-*)", async () => {
  const m = json("tealbrick.manifest.json");
  const v = validateManifest(m);
  assert.ok(v.ok, v.ok ? "" : JSON.stringify(v.errors));
  // only the build paths (M-RT-9): validateAppFiles also judges the skill file, which this WP does not own
  const files = await validateAppFiles(v.manifest, root);
  const buildErrors = files.ok ? [] : files.errors.filter((e) => e.rule === "M-RT-9");
  assert.deepEqual(buildErrors, [], "build paths exist (M-RT-9)");
  const rt = m.runtime as { resources: { memoryMb: number }; env: { name: string; value: string }[]; services: Record<string, unknown>[] };
  assert.ok(rt.resources.memoryMb >= 768, "the app has 768 MB for the Temporal worker");
  assert.deepEqual(rt.env, [{ name: "TEMPORAL_ADDRESS", value: "{{services.temporal.host}}:7233" }]);
  const svc = rt.services.find((s) => s.id === "temporal");
  assert.ok(svc, "service temporal");
  assert.equal(svc.port, 7233);
  assert.deepEqual(svc.resources, { cpu: 1, memoryMb: 1024 });
  assert.deepEqual(svc.volumes, [{ id: "temporal_data", mountPath: "/data", sizeGb: 5, purpose: "data" }]);
  assert.deepEqual(svc.health, { kind: "tcp" });
  assert.equal(svc.startOrder, 0);
  assert.equal(svc.when, undefined, "always on (ENGINE-BUILD section 1)");
  assert.equal(svc.dropPrivileges, true);
  assert.deepEqual(svc.backup, { dump: ["/opt/temporal/temporal-dump"], restore: ["/opt/temporal/temporal-restore"], extension: "sqlite" });
  assert.equal((svc.build as { dockerfile: string }).dockerfile, "services/temporal/Dockerfile");
  assert.equal((svc.helper ?? null), null, "no helper: the engine is reached on 7233 only");
});

test("tealbrick-ci.json lists the temporal service image next to the app image", () => {
  const ci = json("tealbrick-ci.json") as { images: Record<string, string>[] };
  const img = ci.images.find((i) => i.kind === "service");
  assert.deepEqual(img, { name: "opt2-tealbrick-evolution-temporal", product: "evolution", kind: "service", service: "temporal", context: ".", dockerfile: "services/temporal/Dockerfile", upgradeFrom: ">=0.3.0 <0.4.2" });
  assert.ok(ci.images.some((i) => i.kind === "app" && i.product === img?.product));
});

// ---------- the shell scripts ----------

const FAKE_SCHEMA = "CREATE TABLE good (a TEXT); CREATE TABLE namespaces (n TEXT);";
const FOREIGN_SCHEMA = "CREATE TABLE other (b TEXT);";

interface Sandbox {
  dir: string;
  data: string;
  env: Record<string, string>;
  log: string;
  dbPath: string;
  schemaHash(file: string): string;
}

function mkbin(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const tools = join(fixtures, "tools.ts");
  writeFileSync(join(bin, "sqlite3"), `#!/bin/sh\nNODE_NO_WARNINGS=1 exec node "${tools}" sqlite3 "$@"\n`);
  writeFileSync(join(bin, "sha256sum"), `#!/bin/sh\nNODE_NO_WARNINGS=1 exec node "${tools}" sha256sum "$@"\n`);
  writeFileSync(join(bin, "temporal"), readFileSync(join(fixtures, "fake-temporal.sh")));
  for (const f of ["sqlite3", "sha256sum", "temporal"]) chmodSync(join(bin, f), 0o755);
  return bin;
}

function sandbox(t: { after(fn: () => void): void }): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "evo-temporal-svc-"));
  // a killed fake server leaves a `sleep` / a log write behind for a moment: rm races it (ENOTEMPTY) on a loaded runner, so retry
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const bin = mkbin(dir);
  const data = join(dir, "data");
  mkdirSync(data);
  const log = join(dir, "fake.log");
  writeFileSync(log, "");
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: dir,
    TEMPORAL_DATA_DIR: data,
    TEMPORAL_PIDFILE: join(dir, "server.pid"),
    TEMPORAL_SCHEMA_SHA256_FILE: join(dir, "schema.sha256"),
    TEMPORAL_SCHEMA_HASH_CMD: join(svcDir, "schema-hash"),
    TEMPORAL_RETENTION: "120h",
    FAKE_LOG: log,
    FAKE_SCHEMA_SQL: FAKE_SCHEMA,
  };
  const schemaHash = (file: string) => {
    const r = spawnSync(join(svcDir, "schema-hash"), [file], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  // the "pinned" schema is the fake CLI's fresh database
  const fresh = join(dir, "fresh.db");
  spawnSync("sqlite3", [fresh, FAKE_SCHEMA], { env, encoding: "utf8" });
  writeFileSync(env.TEMPORAL_SCHEMA_SHA256_FILE as string, `${schemaHash(fresh)}  fake\n`);
  return { dir, data, env, log, dbPath: join(data, "temporal.db"), schemaHash };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return;
    await sleep(50);
  }
  assert.fail(`timeout: ${what}`);
}
const logLines = (s: Sandbox) => readFileSync(s.log, "utf8").split("\n").filter(Boolean);
const starts = (s: Sandbox) => logLines(s).filter((l) => l.startsWith("start "));

function runSh(s: Sandbox): { child: ChildProcess; out: () => string; exited: Promise<number> } {
  const child = spawn("sh", [join(svcDir, "run.sh")], { env: s.env, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout?.on("data", (d: Buffer) => {
    text += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    text += d.toString();
  });
  const exited = new Promise<number>((resolve) => child.once("exit", (code, sig) => resolve(code ?? (sig ? 128 : 1))));
  return { child, out: () => text, exited };
}

function rows(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare("SELECT a FROM good ORDER BY a").all().map((r) => String(r.a));
  } finally {
    db.close();
  }
}
function seed(file: string, schema: string, values: string[]): void {
  const db = new DatabaseSync(file);
  db.exec(schema);
  for (const v of values) db.prepare("INSERT INTO good (a) VALUES (?)").run(v);
  db.close();
}

test("retention: run.sh default equals the keystore constant, and a key is retired only after the window", () => {
  const m = /RETENTION=\$\{TEMPORAL_RETENTION:-(\d+)h\}/.exec(read("services/temporal/run.sh"));
  assert.ok(m, "run.sh has a default retention in hours");
  const hours = Number(m[1]);
  assert.equal(hours, TEMPORAL_RETENTION_HOURS, "run.sh default retention equals TEMPORAL_RETENTION_HOURS in src/engine/keystore.ts");
  assert.ok(KEY_RETIRE_AFTER_HOURS > hours, "the key retire window is longer than the retention (margin), else a run could still need a retired key");
});

test("run.sh: starts the pinned server command, raises the retention, and a stop signal ends it cleanly", async (t) => {
  const s = sandbox(t);
  const r = runSh(s);
  await until("server started", () => starts(s).length === 1);
  assert.equal(starts(s)[0], `start server start-dev --headless --ip 0.0.0.0 --port 7233 --db-filename ${s.dbPath} --namespace evolution --log-level warn`);
  await until("retention set", () => logLines(s).some((l) => l.includes("operator namespace update") && l.includes("--namespace evolution") && l.includes("--retention 120h")));
  assert.ok(existsSync(s.env.TEMPORAL_PIDFILE as string), "pid file for temporal-restore");
  r.child.kill("SIGTERM");
  assert.equal(await r.exited, 0);
  assert.ok(!existsSync(s.env.TEMPORAL_PIDFILE as string), "pid file removed");
  assert.equal(starts(s).length, 1, "no restart after a stop signal");
});

test("run.sh: a database with another schema is not started (exit 78, temporal_schema_mismatch)", async (t) => {
  const s = sandbox(t);
  const db = new DatabaseSync(s.dbPath);
  db.exec(FOREIGN_SCHEMA);
  db.close();
  const r = runSh(s);
  assert.equal(await r.exited, 78);
  assert.match(r.out(), /temporal_schema_mismatch/);
  assert.equal(starts(s).length, 0, "the server never started");
});

test("run.sh: quiet on good: a database with the pinned schema starts and keeps its rows", async (t) => {
  const s = sandbox(t);
  seed(s.dbPath, FAKE_SCHEMA, ["kept"]);
  const r = runSh(s);
  await until("server started", () => starts(s).length === 1);
  assert.deepEqual(rows(s.dbPath), ["kept"]);
  r.child.kill("SIGTERM");
  assert.equal(await r.exited, 0);
});

test("run.sh: a server that dies on its own ends the supervisor with its exit code (the container restarts)", async (t) => {
  const s = sandbox(t);
  const r = runSh(s);
  await until("server started", () => starts(s).length === 1);
  const pid = Number(readFileSync(s.env.TEMPORAL_PIDFILE as string, "utf8").trim());
  process.kill(pid, "SIGKILL");
  assert.equal(await r.exited, 137);
});

test("temporal-dump: a consistent copy on stdout, checked, no temporary files left", (t) => {
  const s = sandbox(t);
  seed(s.dbPath, FAKE_SCHEMA, ["one", "two"]);
  const r = spawnSync("sh", [join(svcDir, "temporal-dump")], { env: s.env, maxBuffer: 1 << 26 });
  assert.equal(r.status, 0, String(r.stderr));
  const copy = join(s.dir, "copy.sqlite");
  writeFileSync(copy, r.stdout);
  assert.deepEqual(rows(copy), ["one", "two"]);
  assert.deepEqual(readdirSync(s.data).filter((f) => f.startsWith(".dump.")), []);
  const missing = spawnSync("sh", [join(svcDir, "temporal-dump")], { env: { ...s.env, TEMPORAL_DATA_DIR: join(s.dir, "nowhere") }, encoding: "utf8" });
  assert.notEqual(missing.status, 0, "fires when there is no database");
});

async function restore(s: Sandbox, copy: Buffer): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("sh", [join(svcDir, "temporal-restore")], { env: s.env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    p.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    p.once("exit", (status) => resolve({ status, stderr }));
    p.stdin?.end(copy);
  });
}

test("temporal-restore: stops the server, the supervisor swaps the file (old one kept), the server restarts on the copy", async (t) => {
  const s = sandbox(t);
  seed(s.dbPath, FAKE_SCHEMA, ["live-1", "live-2"]);
  const copyPath = join(s.dir, "backup.sqlite");
  seed(copyPath, FAKE_SCHEMA, ["backup"]);
  const r = runSh(s);
  await until("server started", () => starts(s).length === 1);
  const res = await restore(s, readFileSync(copyPath));
  assert.equal(res.status, 0, res.stderr);
  assert.equal(starts(s).length, 2, "the server was restarted once");
  assert.deepEqual(rows(s.dbPath), ["backup"], "the copy is the live file");
  assert.deepEqual(rows(join(s.data, "restore", "previous.sqlite")), ["live-1", "live-2"], "the replaced file is kept");
  assert.ok(!existsSync(join(s.data, "restore", "pending.sqlite")));
  assert.match(r.out(), /restore_applied/);
  const pid = Number(readFileSync(s.env.TEMPORAL_PIDFILE as string, "utf8").trim());
  assert.doesNotThrow(() => process.kill(pid, 0), "the new server runs");
  r.child.kill("SIGTERM");
  assert.equal(await r.exited, 0);
});

test("temporal-restore: refuses a foreign schema, a corrupt file, and a stopped server; the live state stays", async (t) => {
  const s = sandbox(t);
  seed(s.dbPath, FAKE_SCHEMA, ["live"]);
  const foreign = join(s.dir, "foreign.sqlite");
  const db = new DatabaseSync(foreign);
  db.exec(FOREIGN_SCHEMA);
  db.close();
  // no server yet: refused first
  const early = await restore(s, readFileSync(foreign));
  assert.notEqual(early.status, 0);
  const r = runSh(s);
  await until("server started", () => starts(s).length === 1);
  const a = await restore(s, readFileSync(foreign));
  assert.notEqual(a.status, 0, "foreign schema refused");
  assert.match(a.stderr, /another Temporal schema/);
  const b = await restore(s, Buffer.from("this is not a database at all, just text".repeat(50)));
  assert.notEqual(b.status, 0, "corrupt file refused");
  assert.equal(starts(s).length, 1, "the server was never stopped by a refused restore");
  assert.deepEqual(rows(s.dbPath), ["live"]);
  assert.ok(!existsSync(join(s.data, "restore", "pending.sqlite")), "nothing pending");
  r.child.kill("SIGTERM");
  assert.equal(await r.exited, 0);
});

test("run.sh: a pending copy with another schema is moved aside, not applied (defence behind temporal-restore)", async (t) => {
  const s = sandbox(t);
  seed(s.dbPath, FAKE_SCHEMA, ["live"]);
  mkdirSync(join(s.data, "restore"));
  const db = new DatabaseSync(join(s.data, "restore", "pending.sqlite"));
  db.exec(FOREIGN_SCHEMA);
  db.close();
  const r = runSh(s);
  await until("server started", () => starts(s).length === 1);
  assert.deepEqual(rows(s.dbPath), ["live"]);
  assert.ok(existsSync(join(s.data, "restore", "rejected.sqlite")));
  assert.match(r.out(), /restore_rejected/);
  r.child.kill("SIGTERM");
  assert.equal(await r.exited, 0);
});
