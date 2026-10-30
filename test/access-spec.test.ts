// C380 B7: tb.access/1 against the byte copies of the spec schemas and fixtures (test/contracts, see PROVENANCE.md).
//   - the copies are the bytes of the spec tag (sha256 below);
//   - the manifest embeds the four schemas as the op input and output;
//   - the spec's valid documents pass, its invalid ones fail, for the input and the output of both ops;
//   - the 6-case caller vector and the digest fixture give the answers of src/access.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { canonicalize, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Caller, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { guardFleet, itemDigest, revokeAccess } from "../src/access.ts";
import { manifest } from "../src/app.ts";
import * as store from "../src/store.ts";
import { migratedDb } from "./helpers.ts";

const dir = new URL("./contracts/", import.meta.url);
const raw = (f: string): string => readFileSync(new URL(f, dir), "utf8");
const json = <T>(f: string): T => JSON.parse(raw(f)) as T;
const sha = (f: string): string => createHash("sha256").update(readFileSync(new URL(f, dir))).digest("hex");

const FILES: Record<string, string> = {
  "list_in.1.schema.json": "83f1c2f7c2c399d8e11a93418e469d01c777af5f6c8bfe7cd2643539f3a04fe5",
  "list_out.1.schema.json": "571feb6b833d392f8eec3212b21d53aa7e529dfb65a34f8a54b89d07160c7f48",
  "revoke_in.1.schema.json": "edbe7c6b94ffb74e4dff0c3f986ccaa29e83d8d6fd1fa9f1e2986d2802e60c51",
  "revoke_out.1.schema.json": "b36b1c6474fc858daf93e2a4d9605067113937b984e8b26833fa13eae314d919",
  "list_in.1.json": "dc1745d9a0bd6d83fdd672fbc14e119f9637b19537162e77455b246676535c85",
  "list_out.1.json": "efc7e1389eb7a7eac55e3149c2ac111959a5664ebaccf630a0155668c70b5c49",
  "revoke_in.1.json": "5cab7e5c4b15ddf172aac5a4dab0f55a1028eeaa4ac491a712c4b88f6221783d",
  "revoke_out.1.json": "76ed608d69f86c43d217ce18516ffe7b233d20f5971a962e862184a62b296281",
  "digest.1.json": "e4db19dd894802348b9e87c2251d85383fb2e4f47e90b26dde76c42e17b42daa",
  "revoke_bind.1.json": "18fda3ce054445dd43498e1a7fab663a44a5ca73fb44bb51c6b4fda3572e1a68",
  "caller_vector.1.json": "faf832b1a3fa7e122f252677e9a946be11668cacd23ce0f765fcaa57ebe5cd49",
};

type Schema = Parameters<typeof validateAgainstSchema>[0];
interface Fixtures {
  valid: unknown[];
  invalid: { why: string; doc: unknown }[];
}
const ops = manifest.operations as unknown as { id: string; input: unknown; output: unknown }[];
const op = (id: string) => ops.find((o) => o.id === id) as { id: string; input: unknown; output: unknown };

test("the copies are the bytes of the spec tag (sha256)", () => {
  for (const [name, h] of Object.entries(FILES)) assert.equal(sha(`access.${name}`), h, name);
});

test("the manifest embeds the spec schemas as the op input and output", () => {
  assert.deepEqual(op("access_list").input, json("access.list_in.1.schema.json"));
  assert.deepEqual(op("access_list").output, json("access.list_out.1.schema.json"));
  assert.deepEqual(op("access_revoke").input, json("access.revoke_in.1.schema.json"));
  assert.deepEqual(op("access_revoke").output, json("access.revoke_out.1.schema.json"));
});

for (const [name, file, which, id] of [
  ["list input", "access.list_in.1.json", "input", "access_list"],
  ["list output", "access.list_out.1.json", "output", "access_list"],
  ["revoke input", "access.revoke_in.1.json", "input", "access_revoke"],
  ["revoke output", "access.revoke_out.1.json", "output", "access_revoke"],
] as const) {
  test(`${name}: every valid fixture passes and every invalid one fails the manifest schema`, () => {
    const fx = json<Fixtures>(file);
    const schema = op(id)[which] as Schema;
    assert.ok(fx.valid.length > 0 && fx.invalid.length > 0);
    for (const [i, d] of fx.valid.entries()) {
      const r = validateAgainstSchema(schema, d as never);
      assert.equal(r.ok, true, `valid #${i}: ${JSON.stringify(r).slice(0, 300)}`);
    }
    for (const x of fx.invalid) assert.equal(validateAgainstSchema(schema, x.doc as never).ok, false, `invalid: ${x.why}`);
  });
}

test("caller vector: the guard gives each case its exact answer (allow, or code and status)", () => {
  const v = json<{ cases: { name: string; caller: Record<string, unknown>; allow: boolean; code?: string; status?: number }[] }>("access.caller_vector.1.json");
  assert.equal(v.cases.length, 6);
  for (const c of v.cases) {
    const ctx = { caller: c.caller as unknown as Caller } as OpContext;
    if (c.allow) assert.doesNotThrow(() => guardFleet(ctx), c.name);
    else assert.throws(() => guardFleet(ctx), (e: unknown) => (e as { code?: string }).code === c.code && (e as { httpStatus?: number }).httpStatus === c.status, c.name);
  }
});

test("digest fixture: the JCS form and the digest are the spec's; equal items give one digest, a different one gives another", () => {
  const d = json<{ target: string; jcs: string; digest: string; equal: { item: Parameters<typeof itemDigest>[0] }[]; different: { item: Parameters<typeof itemDigest>[0] }[] }>("access.digest.1.json");
  assert.equal(d.target, "evolution");
  for (const e of d.equal) assert.equal(itemDigest(e.item), d.digest);
  const base = d.equal[0]?.item as Parameters<typeof itemDigest>[0];
  assert.equal(canonicalize({ v: 1, target: d.target, id: base.id, kind: base.kind, subject: base.subject, resource: base.resource, level: base.level } as never), d.jcs);
  for (const x of d.different) assert.notEqual(itemDigest(x.item), d.digest);
});

test("revoke bind fixture: the row is loaded, the digest recomputed from it, the subject compared, and the running check reads the row's holder", () => {
  interface Bind {
    row: { id: string; subject: { id: string }; digest: string };
    cases: { name: string; request: { subject: { kind: "agent"; id: string }; digest: string }; agents: Record<string, "active" | "paused">; outcome: string; code?: string }[];
  }
  const f = json<Bind>("access.revoke_bind.1.json");
  const aut = f.row.id.slice("routine:".length);
  for (const c of f.cases) {
    const db = migratedDb();
    // the row of the fixture: aut_1, held by the fixture's agent (the id of the fixture is stored as is)
    const d = store.createDraft(db, { suggestionId: null, templateId: null, snapshot: { title: "W", summary: "", instruction: "Do.", trigger: "08:00", steps: [], allowed: [{ product: "kanban", operations: ["issues_list"], crud: ["read" as const] }] } }, 1);
    const wf = store.promote(db, d.id, d.revision, 1).workflow.id;
    db.prepare("INSERT INTO automations (id, workflow_id, version_pin, policy_version, agent_id, cron, enabled, misfire_grace_sec, kanban_project, revision, next_due_at, created_at, updated_at) VALUES (?, ?, NULL, 1, ?, '0 8 * * *', 1, 120, NULL, 1, 1, 1, 1)").run(aut, wf, f.row.subject.id);
    const ctx = {
      caller: { type: "app", product: "fleet", listed: true },
      db,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      // the signed slice: an agent that is not listed counts as stopped (SDK trust.paused)
      paused: (agent: string) => ({ workspace: false, instance: false, agent: c.agents[agent] !== "active" }),
    } as unknown as OpContext;
    const out = revokeAccess(db, ctx, { v: 1, plan: "pln_1", attempt: 1, subject: c.request.subject, items: [{ id: f.row.id, digest: c.request.digest }] });
    assert.equal(out.results[0]?.outcome, c.outcome, c.name);
    if (c.code) assert.equal(out.results[0]?.code, c.code, c.name);
    assert.equal(Number(db.prepare("SELECT enabled FROM automations WHERE id = ?").get(aut)?.enabled), c.outcome === "revoked" ? 0 : 1, `${c.name}: the row`);
  }
});
