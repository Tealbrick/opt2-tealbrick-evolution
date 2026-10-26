// `model_role_optional` only when it matters (gate-safe): an ACTIVE workflow version uses the role in an `ai` step and it is not bound.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_ROLE_ATTENTION } from "@opt2-tealbrick/manifest";
import { manifest } from "../../src/app.ts";
import * as store from "../../src/engine/engine-store.ts";
import { createRoleAttention, MODEL_ROLE_OPTIONAL, usedRoles } from "../../src/engine/role-attention.ts";
import { validateContract } from "../../src/engine/validate.ts";
import { migratedDb } from "../helpers.ts";
import { wf } from "./harness.ts";

const ai = (id: string, by: unknown) => ({ id, type: "ai", by, instruction: "x", outputSchema: { type: "object" } });
function install(db: ReturnType<typeof migratedDb>, id: string, title: string, steps: unknown[], version = 1): void {
  const c = wf(steps, { id, title, version });
  store.saveDefinition(db, c, Date.now());
  store.activate(db, id, version, validateContract(c, { companions: null }).uses, Date.now());
}
const caps = ["model_roles"];
/** attention() starts a background refresh when stale (ttl 0): join it, then look at the current state */
const settle = async (x: { refresh(): Promise<void> }) => {
  await x.refresh();
  await x.refresh();
};

test("the code is the spec's code, and the manifest declares the roles as OPTIONAL (the SDK raises only model_role_missing for required ones, never this one)", () => {
  assert.ok((MODEL_ROLE_ATTENTION as readonly string[]).includes(MODEL_ROLE_OPTIONAL));
  const roles = (manifest as unknown as { settings: { modelRoles: { role: string; required: boolean; usedBy: string[] }[] } }).settings.modelRoles;
  assert.ok(roles.length > 0);
  for (const r of roles) assert.deepEqual([r.required, r.usedBy], [false, ["app"]], r.role);
});

test("quiet on good: no workflow, an unused role, an agent-card step, a bound role, a deactivated or replaced version raise NOTHING", async () => {
  const db = migratedDb();
  let bound = false;
  const a = createRoleAttention({ db, modelRole: async () => (bound ? { provider: "x" } : null), bridgeCaps: () => caps, ttlMs: 0 });
  await settle(a);
  assert.equal(a.attention(), null, "no workflow: an unbound role is no business of the gate");
  install(db, "agent-only", "Agent only", [ai("a", { agent: "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85" })]);
  await settle(a);
  assert.equal(a.attention(), null, "an agent card needs no model role");
  install(db, "role-flow", "Role flow", [ai("m", { role: "summarize" })]);
  bound = true;
  await settle(a);
  assert.equal(a.attention(), null, "bound");
  bound = false;
  store.deactivate(db, "role-flow", Date.now());
  await settle(a);
  assert.equal(a.attention(), null, "deactivated");
  install(db, "swap-flow", "Swap", [ai("m", { role: "reasoning" })], 1);
  install(db, "swap-flow", "Swap", [{ id: "t", type: "transform", template: "x" }], 2);
  await settle(a);
  assert.equal(a.attention(), null, "v1 uses the role but v2 (active) does not; v1 is superseded");
  assert.deepEqual([...usedRoles(db).keys()], [], "only ACTIVE versions count");
});

test("fire on bad: an ACTIVE workflow uses a role that is not bound -> model_role_optional naming the workflow; it clears when the role is bound or the workflow is deactivated", async () => {
  const db = migratedDb();
  let bound = false;
  let changes = 0;
  const a = createRoleAttention({ db, modelRole: async () => (bound ? { provider: "x" } : null), bridgeCaps: () => caps, ttlMs: 0, onChange: () => changes++ });
  install(db, "daily-summary", "Daily email summary", [ai("m", { role: "summarize" })]);
  await settle(a);
  const att = a.attention();
  assert.equal(att?.code, MODEL_ROLE_OPTIONAL);
  assert.match(att?.reason ?? "", /Workflow Daily email summary uses the model role summarize, which is not set/);
  assert.match(att?.code ?? "", /^[a-z][a-z0-9_]{0,39}$/);
  assert.ok((att?.reason.length ?? 999) <= 200);
  assert.equal(changes, 1, "the status push is told");
  install(db, "second-flow", "Second flow", [ai("m", { role: "summarize" })]);
  await settle(a);
  assert.match(a.attention()?.reason ?? "", /Workflows (Daily email summary, Second flow|Second flow, Daily email summary) use the model role summarize/);
  bound = true;
  await settle(a);
  assert.equal(a.attention(), null, "bound: cleared");
  bound = false;
  await settle(a);
  assert.equal(a.attention()?.code, MODEL_ROLE_OPTIONAL);
  store.deactivate(db, "daily-summary", Date.now());
  store.deactivate(db, "second-flow", Date.now());
  await settle(a);
  assert.equal(a.attention(), null, "no active workflow uses it any more: cleared");
});

test("a bridge without the model_roles cap binds nothing: raised for an active role step; a modelRole that throws (paused, role not declared) says nothing", async () => {
  const db = migratedDb();
  install(db, "role-flow", "Role flow", [ai("m", { role: "utility" })]);
  let called = 0;
  const noCap = createRoleAttention({
    db,
    modelRole: async () => {
      called++;
      return { provider: "x" };
    },
    bridgeCaps: () => [],
    ttlMs: 0,
  });
  await settle(noCap);
  assert.equal(noCap.attention()?.code, MODEL_ROLE_OPTIONAL);
  assert.equal(called, 0, "no cap: the bridge is not asked");
  const throwing = createRoleAttention({
    db,
    modelRole: async () => {
      throw Object.assign(new Error("paused"), { code: "paused" });
    },
    bridgeCaps: () => caps,
    ttlMs: 0,
  });
  await settle(throwing);
  assert.equal(throwing.attention(), null);
});

test("the answer is synchronous from the cache (the SDK reads attention() with a 1 s timeout) and refreshes in the background when stale", async () => {
  const db = migratedDb();
  install(db, "role-flow", "Role flow", [ai("m", { role: "utility" })]);
  let asked = 0;
  const a = createRoleAttention({
    db,
    modelRole: async () => {
      asked++;
      return null;
    },
    bridgeCaps: () => caps,
    ttlMs: 60_000,
  });
  assert.equal(a.attention(), null, "nothing known yet");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked, 1, "the first call started a refresh");
  assert.equal(a.attention()?.code, MODEL_ROLE_OPTIONAL);
  assert.equal(asked, 1, "fresh: no new question");
});
