// Smoke test: the app boots on the SDK (manifest, handler set and migrations accepted), serves the derived routes,
// and refuses agent calls in app-alone mode. Agent calls through a bridge are covered by `pnpm conformance`.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { manifestDigest, validateManifest } from "@opt2-tealbrick/manifest";
import { defineApp, startApp } from "@opt2-tealbrick/miniapp-sdk";
import { MANIFEST_DIGEST, OP, PERSON_OPS } from "#kit";
import { definition, handlers, manifest } from "../src/app.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
  });
}

test("manifest validates", () => {
  const v = validateManifest(manifest);
  assert.equal(v.ok, true, v.ok ? "" : JSON.stringify(v.errors));
});

test("the generated kit matches the manifest and every operation has exactly one handler", () => {
  assert.equal(MANIFEST_DIGEST, manifestDigest(manifest), "kit is stale: run node --run kit");
  const ids = manifest.operations.map((o) => o.id).sort();
  assert.deepEqual(Object.values(OP).sort(), ids);
  assert.deepEqual(Object.keys(handlers).sort(), ids);
});

test("agents suggest, read, and claim/report their runs; deciding, editing, promoting, exporting and scheduling are owner-only person ops", () => {
  const agentOps = manifest.operations.filter((o) => o.audience === "agent").map((o) => o.id);
  assert.deepEqual(agentOps.sort(), ["routine_claim", "routine_report", "routines_due", "step_claim", "step_heartbeat", "step_report", "steps_due", "suggestion_create", "suggestion_get", "suggestions_list", "workflow_get"]);
  assert.equal(manifest.operations.find((o) => o.id === "routines_due")?.effect, "read", "the poll target changes nothing");
  for (const id of ["suggestion_decide", "draft_create", "draft_update", "workflow_promote", "recipe_export", "workflow_diff", "detector_scan", "automation_set", "automation_pause", "automation_delete", "cycles_list", "cycle_get", "cycle_eval_run"])
    assert.ok((PERSON_OPS as readonly string[]).includes(id), `${id} is a person op`);
  // the cycle ledger (C250 Release B): reads are read/["read"]; storing an eval is a create with a required key
  for (const id of ["cycles_list", "cycle_get"]) assert.deepEqual([manifest.operations.find((o) => o.id === id)?.effect, manifest.operations.find((o) => o.id === id)?.crud], ["read", ["read"]], id);
  const evalRun = manifest.operations.find((o) => o.id === "cycle_eval_run");
  assert.deepEqual([evalRun?.effect, evalRun?.crud, evalRun?.idempotency], ["write", ["create"], "required"]);
  const create = manifest.operations.find((o) => o.id === "suggestion_create");
  assert.equal(create?.idempotency, "required");
  // C367: the superset companion block (ENGINE-BUILD §4); the detector and the run issues still need these four Task Board ops
  const kanban = manifest.companions?.find((c) => c.product === "kanban");
  for (const id of ["issues_list", "issue_create", "issue_complete", "issue_block"]) assert.ok(kanban?.operations.includes(id), `kanban.${id}`);
  assert.deepEqual(manifest.companions?.map((c) => c.product), ["kanban", "knowledge", "inbox", "rules", "connect"]);
});

test("boots on the SDK, serves derived routes, refuses agent calls without a bridge", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), `${manifest.id}-test-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const local = { ...manifest, runtime: { ...manifest.runtime, port } };
  const running = await startApp(defineApp({ ...definition, manifest: local }), { TB_DATA_DIR: dir, TB_STANDALONE: "1", TB_LOG_LEVEL: "error", TB_DATA_EPHEMERAL: "1" });
  try {
    const base = `http://127.0.0.1:${port}`;
    const health = (await (await fetch(`${base}/tb/v1/health`)).json()) as { status: string; manifestDigest: string };
    assert.equal(health.status, "ok");
    assert.equal(health.manifestDigest, manifestDigest(local));
    const openapi = (await (await fetch(`${base}/tb/v1/openapi.json`)).json()) as { paths: Record<string, unknown> };
    for (const op of manifest.operations) assert.ok(Object.keys(openapi.paths).some((p) => p.endsWith(`/${op.id}`)), `openapi lists ${op.id}`);
    const refused = await fetch(`${base}/tb/v1/ops/suggestions_list`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: {} }) });
    assert.equal(refused.status, 503);
  } finally {
    await running.stop();
  }
});
