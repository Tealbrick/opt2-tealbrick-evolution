// The payload codec (C371, review F1 + F9): everything Temporal stores or sees is sealed with a key only the app holds.
// Unit tests of the codec and the key ring, then the wire: histories, a plaintext start, a forged completion, a database file.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@temporalio/client";
import type { Payload } from "@temporalio/common";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import type { AgentStepOffer } from "../../src/engine/agent-port.ts";
import { createSealCodec, KEY_ID_FIELD, type KeyRing, keyIdOf, SEALED_ENCODING, SealError } from "../../src/engine/codec.ts";
import { readStepIo } from "../../src/engine/history.ts";
import { loadKeyRing, retireKey, rotateKey, SECRET_NAME } from "../../src/engine/keystore.ts";
import { read, startEnv, waitFor, wf, workflowTaskFailures } from "./harness.ts";

const MARKER = "ZEBRA-MARKER-9137-QUOKKA";
const ringOf = (...keys: Buffer[]): KeyRing => ({ current: keyIdOf(keys[0] as Buffer), keys: Object.fromEntries(keys.map((k) => [keyIdOf(k), k])) });
const json = (v: unknown): Payload => ({ metadata: { encoding: Buffer.from("json/plain") }, data: Buffer.from(JSON.stringify(v)) });
const memorySecrets = () => {
  const m = new Map<string, string>();
  return { m, get: async (n: string) => m.get(n) ?? null, put: async (n: string, v: string) => void m.set(n, v) };
};
const refused = (p: Promise<unknown>, code: SealError["code"]) => assert.rejects(p, (e: unknown) => e instanceof SealError && e.code === code);

test("a sealed round trip returns the payload exactly; the sealed bytes hold no plaintext and say which key sealed them", async () => {
  const ring = ringOf(randomBytes(32));
  const codec = createSealCodec(() => ring);
  const original = json({ note: MARKER, n: 1 });
  const [sealed] = await codec.encode([original]);
  assert.equal(Buffer.from(sealed?.metadata?.encoding ?? []).toString(), SEALED_ENCODING);
  assert.match(Buffer.from(sealed?.metadata?.[KEY_ID_FIELD] ?? []).toString(), /^[0-9a-f]{12}$/);
  assert.equal(Buffer.from(sealed?.data ?? []).includes(MARKER), false);
  assert.equal(Buffer.from(sealed?.data ?? []).toString("base64").includes(Buffer.from(MARKER).toString("base64").slice(0, 12)), false);
  const [back] = await codec.decode([sealed as Payload]);
  assert.equal(Buffer.from(back?.data ?? []).toString(), JSON.stringify({ note: MARKER, n: 1 }));
  assert.equal(Buffer.from(back?.metadata?.encoding ?? []).toString(), "json/plain");
  // a payload with no data (a void result) round-trips too, and two seals of one payload differ (random iv)
  const [nul] = await codec.decode(await codec.encode([{ metadata: { encoding: Buffer.from("binary/null") } }]));
  assert.equal(nul?.data ?? null, null);
  assert.notDeepEqual((await codec.encode([original]))[0]?.data, (await codec.encode([original]))[0]?.data);
});

test("fire on bad: decode REFUSES a payload that is not sealed, a changed byte, a wrong key, an unknown key id, a re-labelled key id, a truncated payload", async () => {
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const ring1 = ringOf(k1);
  const codec = createSealCodec(() => ring1);
  await refused(codec.decode([json({ forged: true })]), "payload_not_sealed");
  await refused(codec.decode([{ metadata: { encoding: Buffer.from("binary/null") } }]), "payload_not_sealed");
  const [sealed] = (await codec.encode([json({ a: 1 })])) as [Payload];
  const flipped = Buffer.from(sealed.data ?? []);
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
  await refused(codec.decode([{ ...sealed, data: flipped }]), "payload_corrupt");
  const ring2 = ringOf(k2);
  await refused(createSealCodec(() => ring2).decode([sealed]), "payload_key_unknown");
  // another key under the SAME id: the tag fails
  const forgedRing: KeyRing = { current: keyIdOf(k1), keys: { [keyIdOf(k1)]: k2 } };
  await refused(createSealCodec(() => forgedRing).decode([sealed]), "payload_corrupt");
  // the id is bound into the tag: relabel the payload with the id of another key of the ring
  const both = ringOf(k1, k2);
  const relabelled = { ...sealed, metadata: { ...sealed.metadata, [KEY_ID_FIELD]: Buffer.from(keyIdOf(k2)) } };
  await refused(createSealCodec(() => both).decode([relabelled]), "payload_corrupt");
  await refused(codec.decode([{ ...sealed, data: Buffer.from(sealed.data ?? []).subarray(0, 20) }]), "payload_corrupt");
  // an attacker who only knows the protocol cannot seal: a payload "sealed" with a key of its own is refused
  const theirs = ringOf(randomBytes(32));
  const attacker = createSealCodec(() => theirs);
  await refused(codec.decode(await attacker.encode([json({ forged: true })])), "payload_key_unknown");
});

test("key ring: the first start makes ONE key and keeps it in the secret store; the next start reads the same ring; a bad stored value is never replaced", async () => {
  const secrets = memorySecrets();
  const a = await loadKeyRing(secrets);
  assert.equal(Object.keys(a.keys).length, 1);
  assert.equal(a.keys[a.current]?.length, 32);
  assert.ok(secrets.m.has(SECRET_NAME));
  const b = await loadKeyRing(secrets);
  assert.equal(b.current, a.current);
  assert.deepEqual(b.keys[b.current], a.keys[a.current]);
  secrets.m.set(SECRET_NAME, "garbage");
  await assert.rejects(loadKeyRing(secrets), /not a valid key ring/);
  assert.equal(secrets.m.get(SECRET_NAME), "garbage", "a stored value is not overwritten: that would orphan the history");
  secrets.m.set(SECRET_NAME, JSON.stringify({ current: "x", keys: { x: Buffer.from("short").toString("base64") } }));
  await assert.rejects(loadKeyRing(secrets), /not a valid key ring/);
});

test("rotation: a new key seals new payloads, the old key still opens old ones; after the old key is retired old payloads are refused; the current key cannot be retired", async () => {
  const secrets = memorySecrets();
  const ring = await loadKeyRing(secrets);
  const codec = createSealCodec(() => ring);
  const oldKid = ring.current;
  const [old] = (await codec.encode([json({ n: "old" })])) as [Payload];
  await rotateKey(secrets, ring);
  assert.notEqual(ring.current, oldKid);
  const [fresh] = (await codec.encode([json({ n: "new" })])) as [Payload];
  assert.equal(Buffer.from(fresh.metadata?.[KEY_ID_FIELD] ?? []).toString(), ring.current, "new writes use the new key");
  assert.equal(Buffer.from(old.metadata?.[KEY_ID_FIELD] ?? []).toString(), oldKid);
  for (const p of [old, fresh]) assert.ok((await codec.decode([p]))[0]?.data, "both open");
  // the ring in the secret store has both; a restart reads both
  const reread = await loadKeyRing(secrets);
  assert.deepEqual(Object.keys(reread.keys).sort(), Object.keys(ring.keys).sort());
  await assert.rejects(retireKey(secrets, ring, ring.current), /current key cannot be retired/);
  await retireKey(secrets, ring, oldKid);
  await refused(codec.decode([old]), "payload_key_unknown");
  assert.ok((await codec.decode([fresh]))[0]?.data);
  assert.deepEqual(Object.keys((await loadKeyRing(secrets)).keys), [ring.current]);
});

// ───────────────────────────── on the wire ─────────────────────────────

async function failureOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

test("wire: the Temporal history holds no plaintext of the workflow input, the activity inputs or results; the owner's run detail still opens it", async () => {
  const t = await startEnv();
  try {
    t.apps.on["knowledge.recall"] = () => ({ results: [{ title: `result ${MARKER}` }] });
    t.install(wf([{ ...read("find", { input: { query: `q ${MARKER}` } }), outputSchema: { type: "object" } }], { id: "seal-flow", inputs: { type: "object", properties: { x: { type: "string" } } } }));
    await t.run({ workflowId: "seal-flow", runId: "run_seal", trigger: { kind: "manual", input: { x: MARKER } } });
    const h = await t.client.workflow.getHandle("evo:seal-flow:run_seal").fetchHistory();
    const raw = historyToJSON(h);
    assert.ok(raw.length > 1000);
    for (const probe of [MARKER, Buffer.from(MARKER).toString("base64"), Buffer.from(`"x":"${MARKER}`).toString("base64").slice(0, 16)]) assert.equal(raw.includes(probe), false, `no ${probe.slice(0, 20)} in the history`);
    assert.equal(raw.includes("binary/encrypted") || raw.includes(Buffer.from("binary/encrypted").toString("base64")), true, "payloads say they are sealed");
    const io = await readStepIo(t.client, "evo:seal-flow:run_seal");
    assert.deepEqual(io?.find?.input, { query: `q ${MARKER}` });
    assert.deepEqual(io?.find?.output, { results: [{ title: `result ${MARKER}` }] });
  } finally {
    await t.stop();
  }
});

test("wire: a start with a PLAIN payload (a neighbour on the private network) is refused by the worker: no step runs, nothing reaches another app", async () => {
  const t = await startEnv();
  try {
    t.apps.on["knowledge.recall"] = () => ({});
    t.install(wf([read("a")], { id: "plain-flow" }));
    const plain = new Client({ connection: t.client.connection, namespace: t.client.options.namespace });
    const h = await plain.workflow.start("evolutionRun", { taskQueue: "evolution", workflowId: "evo:plain-flow:run_plain", args: [{ workflowId: "plain-flow", version: null, runId: "run_plain", trigger: { kind: "manual", input: {} } }] });
    // a positive signal instead of a sleep: the worker took the task, could not open the plain payload and FAILED the workflow task
    await waitFor("the worker refuses the plain start (a failed workflow task in the history)", async () => (await workflowTaskFailures(t.client, "evo:plain-flow:run_plain")) >= 1);
    assert.equal(t.apps.calls.length, 0, "no activity ran");
    assert.equal(t.db.prepare("SELECT count(*) AS c FROM engine_runs").get()?.c, 0);
    assert.equal((await h.describe()).status.name, "RUNNING", "the plaintext start never became a run");
    await h.terminate("test");
  } finally {
    await t.stop();
  }
});

test("wire: a FORGED completion of an agent step (a plain result from someone who cannot seal) is refused: the forged output is never used", async () => {
  const offers: AgentStepOffer[] = [];
  const t = await startEnv({ agentPort: { offer: async (o) => void offers.push(o), cancel: async () => {} } });
  try {
    t.apps.on["kanban.issue_create"] = () => ({ issue: { id: "should-not-run" } });
    t.install(wf([{ id: "ask", type: "ai", by: { agent: "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85" }, instruction: "x", outputSchema: { type: "object" }, timeoutSec: 600 }, { id: "make", type: "app", product: "kanban", op: "issue_create", input: { title: "{{ $steps.ask.output.title }}" } }], { id: "forge-flow" }));
    const pending = t.run({ workflowId: "forge-flow", runId: "run_forge" });
    pending.catch(() => undefined);
    await waitFor("the agent step is offered", () => offers.length === 1);
    const plain = new Client({ connection: t.client.connection, namespace: t.client.options.namespace });
    await plain.activity.complete(Buffer.from((offers[0] as AgentStepOffer).taskToken, "base64"), { title: "FORGED OUTPUT" });
    // a positive signal instead of a sleep: the worker got the forged result, could not open it and FAILED the workflow task
    await waitFor("the worker refuses the forged completion (a failed workflow task in the history)", async () => (await workflowTaskFailures(t.client, "evo:forge-flow:run_forge")) >= 1);
    assert.equal(t.apps.calls.length, 0, "the forged output reached no app");
    assert.equal(t.db.prepare("SELECT status FROM engine_runs WHERE run_id = 'run_forge'").get()?.status, "running", "the run did not take the forged output");
    const d = await t.client.workflow.getHandle("evo:forge-flow:run_forge").describe();
    assert.equal(d.status.name, "RUNNING");
    await t.client.workflow.getHandle("evo:forge-flow:run_forge").terminate("test");
    assert.ok(await failureOf(pending));
  } finally {
    await t.stop();
  }
});

test("wire: a Temporal database file (the backup of the temporal service) has no plaintext of the data; the same run WITHOUT the codec does (the control)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "evolution-codec-"));
  const bytesOf = (file: string): Buffer => Buffer.concat([file, `${file}-wal`, `${file}-shm`].map((f) => (existsSync(f) ? readFileSync(f) : Buffer.alloc(0))));
  const runOnce = async (codec: boolean, file: string): Promise<void> => {
    const t = await startEnv({ local: true, dbFilename: file, codec });
    try {
      t.apps.on["knowledge.recall"] = () => ({ results: [{ title: `result ${MARKER}` }] });
      t.install(wf([{ ...read("find", { input: { query: `q ${MARKER}` } }), outputSchema: { type: "object" } }], { id: "backup-flow", inputs: { type: "object", properties: { x: { type: "string" } } } }));
      await t.run({ workflowId: "backup-flow", runId: "run_bk", trigger: { kind: "manual", input: { x: MARKER } } });
    } finally {
      await t.stop();
    }
  };
  const sealedFile = join(dir, "sealed.db");
  const plainFile = join(dir, "plain.db");
  await runOnce(true, sealedFile);
  await runOnce(false, plainFile);
  const plain = bytesOf(plainFile);
  assert.ok(plain.length > 10_000, "the control database exists");
  assert.equal(plain.includes(MARKER), true, "CONTROL: without the codec the marker is in the database file");
  const sealed = bytesOf(sealedFile);
  assert.ok(sealed.length > 10_000);
  assert.equal(sealed.includes(MARKER), false, "with the codec the database file has no plaintext of the marker");
  assert.equal(sealed.includes(Buffer.from(MARKER).toString("base64")), false);
});

test("the temporal service carries NO key material: its manifest entry, its env, its image files and its backup scripts never name the payload key", () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("tealbrick.manifest.json", root), "utf8")) as { runtime: { services?: { id: string; env?: Record<string, string> }[] } };
  const svc = manifest.runtime.services?.find((x) => x.id === "temporal");
  assert.ok(svc, "the temporal service is declared");
  const text = JSON.stringify(svc);
  assert.doesNotMatch(text, /payload|codec|kek|secret|engine-payload-keys|encryption/i);
  for (const [name, value] of Object.entries(svc.env ?? {})) {
    assert.doesNotMatch(name, /KEY|SECRET|CODEC|KEK|TOKEN|PASSWORD/i, `env ${name}`);
    assert.match(value, /^[{}A-Za-z0-9_.:/\- ]*$/, `env ${name} is a template or a plain setting`);
  }
  // the app's env (given to the app only) does not carry the key either: it lives in the SDK secret store, sealed under TB_KEK
  assert.doesNotMatch(JSON.stringify(manifest.runtime), /engine-payload-keys|PAYLOAD_KEY|CODEC_KEY/i);
  for (const f of ["Dockerfile", "run.sh", "temporal-dump", "temporal-restore"]) assert.doesNotMatch(readFileSync(new URL(`services/temporal/${f}`, root), "utf8"), /engine-payload-keys|payload key|codec|encryption-key/i, f);
  // and the key ring is never written to app.db tables or the export: the secret store only
  assert.equal(SECRET_NAME, "engine-payload-keys");
});
