// The engine pages of the owner UI (C367 WP3): workflow editor, canonical-shape view, activation review, engine schedules,
// runs with the agent-step history, and engine runs next to legacy runs in Cycles. The pages are compiled with the build
// tsconfig into dist/ui-test-engine (a folder of its own, so this file can run beside test/ui-holds.test.ts) and rendered in
// happy-dom against the real SDK client and a stub server. The stub answers with the shapes of WP2's ops (the generated kit types in src/ui/engine-ops.ts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { DAILY_EMAIL_SUMMARY, INBOUND_EMAIL_ADVISOR } from "../src/ui/engine-samples.ts";

type EditorUi = typeof import("../src/ui/Editor.tsx");
type ShapeUi = typeof import("../src/ui/Shape.tsx");
type ActivationUi = typeof import("../src/ui/Activation.tsx");
type EngineSchedulesUi = typeof import("../src/ui/EngineSchedules.tsx");
type RunsUi = typeof import("../src/ui/Runs.tsx");
type EngineCyclesUi = typeof import("../src/ui/EngineCycles.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-engine");

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/a/evolution/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "HTMLElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

// ── stub server ────────────────────────────────────────────────────────────
type Handler = (input: Record<string, unknown>) => unknown;
const stub = { calls: [] as { op: string; input: Record<string, unknown> }[], handlers: {} as Record<string, Handler>, fail: {} as Record<string, { status: number; code: string } | undefined> };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/evolution/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
  stub.calls.push({ op, input: body.input ?? {} });
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  const handler = stub.handlers[op];
  if (!handler) return json(404, { error: { code: "not_found", message: op } });
  return json(200, { status: "ok", output: handler(body.input ?? {}) });
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
const open: { unmount: () => Promise<void> }[] = [];
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "evolution" }, el)));
  await flush();
  let gone = false;
  const m = {
    host,
    unmount: async () => {
      if (gone) return;
      gone = true;
      await act(async () => r.unmount());
      host.remove();
    },
  };
  open.push(m);
  return m;
}
// a test that fails before its own unmount must not leave a page (and its refresh timer) running
afterEach(async () => {
  for (const m of open.splice(0)) await m.unmount();
});
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const button = (host: Element, text: string, n = 0) => {
  const found = [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text)[n];
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
/** a button that is named by its aria-label (Up, Down and Delete say which step they act on) */
const named = (host: Element, label: string) => {
  const found = host.querySelector(`button[aria-label="${label}"]`);
  assert.ok(found, `button named "${label}"`);
  return found as HTMLButtonElement;
};
const tab = (host: Element, text: string) => {
  const found = [...host.querySelectorAll('[role="tab"]')].find((b) => b.textContent?.trim() === text);
  assert.ok(found, `tab "${text}"`);
  return found as HTMLElement;
};
/** the control that a Field labelled `label` wraps (the kit wires it by aria-labelledby) */
const control = <T extends Element = HTMLInputElement>(host: ParentNode, label: string): T => {
  const found = [...host.querySelectorAll("[aria-labelledby]")].find((c) => document.getElementById(c.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === label);
  assert.ok(found, `field "${label}"`);
  return found as unknown as T;
};
const setValue = (el: Element, value: string, event: "input" | "change" = "input") =>
  act(async () => {
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    set?.call(el, value);
    el.dispatchEvent(new win.Event(event, { bubbles: true }) as unknown as Event);
  });
const choose = (el: Element, value: string) => setValue(el, value, "change");
const alerts = (host: Element) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");
/** the visible text of an element: neighbouring elements are one space apart, neighbouring text nodes touch */
const text = (el: Element | null): string => {
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) out.push(n.textContent ?? "");
    else {
      out.push(" ");
      for (const c of Array.from(n.childNodes)) walk(c);
      out.push(" ");
    }
  };
  if (el) walk(el);
  return out.join("").replace(/\s+/g, " ").trim();
};
const callsOf = (op: string) => stub.calls.filter((c) => c.op === op).map((c) => c.input);

let editor: EditorUi;
let shape: ShapeUi;
let activation: ActivationUi;
let schedules: EngineSchedulesUi;
let runs: RunsUi;
let cycles: EngineCyclesUi;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  const at = (f: string) => import(pathToFileURL(join(outDir, "ui", f)).href);
  editor = (await at("Editor.js")) as EditorUi;
  shape = (await at("Shape.js")) as ShapeUi;
  activation = (await at("Activation.js")) as ActivationUi;
  schedules = (await at("EngineSchedules.js")) as EngineSchedulesUi;
  runs = (await at("Runs.js")) as RunsUi;
  cycles = (await at("EngineCycles.js")) as EngineCyclesUi;
});

after(() => win.close());

const reset = () => {
  stub.calls = [];
  // the editor lists the saved contract versions as it opens
  stub.handlers = { workflow_contracts_list: () => ({ contracts: [] }) };
  stub.fail = {};
  win.sessionStorage.clear();
};

// agents as the directory lists them (UseAgents["agents"])
const POLLY = { id: "agt_01M5BDHMN8ZQJPS4YQ4EWH8W85", name: "Polly", mode: "free", status: "active" };
const BEA = { id: "agt_01M5BDHMN8ZQJPS4YQ4EWH8W86", name: "Bea", mode: "bound", status: "active" };
const AGENTS = [POLLY, BEA] as never;

const USAGE = [
  { product: "connect", op: "gmail_fetch_emails", crud: ["read"], effect: "read", scope: "account sales", held: false },
  { product: "connect", op: "gmail_create_email_draft", crud: ["create"], effect: "write", scope: "account sales", held: true },
];
const validateOk = () => ({ ok: true, errors: [], warnings: [], uses: [], stepTypes: {}, usage: USAGE, activeVersion: null });

// ───────────────────────────────────────────────────────────────────────────
describe("Workflow editor", () => {
  it("quiet: a new workflow is valid; the example loads, validates live and draws the six lanes in order", async () => {
    reset();
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    assert.equal(m.host.querySelector("h1")?.textContent, "Workflow editor");
    assert.match(text(m.host.querySelector(".validation")), /valid/);
    await click(button(m.host, "Load example"));
    assert.equal(control<HTMLInputElement>(m.host, "Title").value, "Summarize my daily emails");
    assert.match(text(m.host.querySelector(".validation")), /valid/);
    assert.equal(m.host.querySelectorAll(".issue-error").length, 0);
    await click(tab(m.host, "Shape"));
    const lanes = [...m.host.querySelectorAll(".lanes > .lane")].map((l) => l.getAttribute("data-stage"));
    assert.deepEqual(lanes, ["event", "process", "enrichment", "concat", "intelligence", "result"]);
    const lane = (s: string) => text(m.host.querySelector(`.lane[data-stage="${s}"]`));
    assert.match(lane("event"), /schedule 0 8 \* \* \* \(Asia\/Bangkok\)/);
    assert.match(lane("enrichment"), /fetch/);
    assert.match(lane("process"), /slim/);
    assert.match(lane("concat"), /body/);
    assert.match(lane("intelligence"), /summary.*role summarize/);
    assert.match(lane("result"), /draft.*connect\.tools/);
    await click(tab(m.host, "JSON"));
    assert.match((m.host.querySelector("textarea") as HTMLTextAreaElement).value, /"format": "tealbrick.workflow\/1"/);
    await m.unmount();
  });

  it("fire: a broken field shows the problem with its pointer, and fixing it clears it", async () => {
    reset();
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    await click(button(m.host, "Load example"));
    await setValue(control(m.host, "Title"), "");
    assert.match(text(m.host.querySelector(".validation")), /1 problem/);
    assert.match(text(m.host.querySelector(".issue-error")), /\/title.*title is required/);
    await setValue(control(m.host, "Title"), "Back again");
    assert.equal(m.host.querySelectorAll(".issue-error").length, 0);
    // a second step with the same id
    await setValue(control(m.host, "Id of slim"), "fetch");
    assert.match(text(m.host.querySelector(".validation")), /used twice/);
    assert.match(text(m.host.querySelector(".issue-error")), /\/steps\/1\/id/);
    await m.unmount();
  });

  it("a step is added from its kind's form; an empty ai step is a problem until it has an instruction", async () => {
    reset();
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    await choose(control<HTMLSelectElement>(m.host, "New step kind (Steps)"), "ai");
    await click(button(m.host, "Add step"));
    assert.ok(m.host.querySelector('.step-card[data-kind="ai"]'), "the ai card");
    assert.match(text(m.host.querySelector(".validation")), /problem/);
    assert.match(text(m.host.querySelector(".validation")), /\/steps\/0\/instruction/);
    // the ai form has what the kind needs
    for (const label of ["Done by (ai1)", "Model role of ai1", "Instruction of ai1", "Output schema of ai1", "Timeout (s) of ai1"]) control(m.host, label);
    await setValue(control(m.host, "Instruction of ai1"), "Summarize the emails.");
    assert.doesNotMatch(text(m.host.querySelector(".validation")), /instruction/);
    assert.match(text(m.host.querySelector(".validation")), /valid/);
    // the same step switches from a model role to an agent card by changing `by` only
    await choose(control<HTMLSelectElement>(m.host, "Done by (ai1)"), "agent");
    await click(tab(m.host, "JSON"));
    const contract = JSON.parse((m.host.querySelector("textarea") as HTMLTextAreaElement).value) as { steps: { by: object; instruction: string }[] };
    assert.deepEqual(contract.steps[0]?.by, { agent: POLLY.id }, "the first Free agent, never the Bound one");
    assert.equal(contract.steps[0]?.instruction, "Summarize the emails.");
    await click(tab(m.host, "Shape"));
    assert.match(text(m.host.querySelector('.lane[data-stage="intelligence"]')), /agent agt_01M5BDHMN8ZQJPS4YQ4EWH8W85/);
    await m.unmount();
  });

  it("a parallel step holds nested lists; steps move and delete", async () => {
    reset();
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    await choose(control<HTMLSelectElement>(m.host, "New step kind (Steps)"), "parallel");
    await click(button(m.host, "Add step"));
    assert.ok(control(m.host, "New step kind (parallel1 branch a)"), "branch a has its own list");
    await choose(control<HTMLSelectElement>(m.host, "New step kind (parallel1 branch a)"), "timer");
    await click(button(m.host, "Add step", 0));
    assert.ok(m.host.querySelector('.step-card[data-kind="timer"]'));
    await click(button(m.host, "Add branch to parallel1"));
    assert.ok(control(m.host, "New step kind (parallel1 branch branch3)"));
    // two top-level steps, then move the second up
    await choose(control<HTMLSelectElement>(m.host, "New step kind (Steps)"), "app");
    const adds = [...m.host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === "Add step");
    await click(adds[adds.length - 1] as Element); // the list of the page itself comes last
    const ids = () => [...m.host.querySelectorAll('section[aria-label="Steps"] > ol > li > .card-head code')].map((c) => c.textContent);
    assert.deepEqual(ids().slice(0, 2), ["parallel1", "app1"]);
    await click(named(m.host, "Move app1 up"));
    assert.deepEqual(ids().slice(0, 2), ["app1", "parallel1"]);
    await click(named(m.host, "Delete app1"));
    assert.ok(!ids().includes("app1"));
    await m.unmount();
  });

  it("the JSON tab: broken text is an error and changes nothing; valid text applies", async () => {
    reset();
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    await click(button(m.host, "Load example"));
    await click(tab(m.host, "JSON"));
    const box = () => m.host.querySelector("textarea") as HTMLTextAreaElement;
    await setValue(box(), '{ "format": ');
    assert.match(text(m.host), /Not valid JSON yet/);
    await click(tab(m.host, "Steps"));
    assert.equal(control<HTMLInputElement>(m.host, "Title").value, "Summarize my daily emails", "the contract did not change");
    await click(tab(m.host, "JSON"));
    await setValue(box(), JSON.stringify({ ...DAILY_EMAIL_SUMMARY, title: "From the JSON tab" }));
    await click(tab(m.host, "Steps"));
    assert.equal(control<HTMLInputElement>(m.host, "Title").value, "From the JSON tab");
    await m.unmount();
  });

  it("the work survives a reload of the page within the tab", async () => {
    reset();
    let m = await mount(h(editor.Editor, { agents: AGENTS }));
    await click(button(m.host, "Load example"));
    await setValue(control(m.host, "Title"), "Kept");
    await m.unmount();
    m = await mount(h(editor.Editor, { agents: AGENTS }));
    assert.equal(control<HTMLInputElement>(m.host, "Title").value, "Kept");
    await m.unmount();
  });

  it("Check with the engine sends the contract and shows what the engine says and what the workflow uses; it waits while the contract is broken", async () => {
    reset();
    stub.handlers.workflow_contract_validate = validateOk;
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    await click(button(m.host, "Load example"));
    await click(button(m.host, "Check with the engine"));
    const [sent] = callsOf("workflow_contract_validate");
    assert.equal((sent?.contract as { id: string } | undefined)?.id, "daily-email-summary");
    assert.match(text(m.host.querySelector('[aria-label="Check against installed apps"]')), /accepted by the engine/);
    assert.equal(m.host.querySelectorAll('table[aria-label="Operations this version uses"] tbody tr').length, 2);
    assert.match(text(m.host), /enforced by the engine until per-workflow grants/);
    // an edit makes the last answer stale
    await setValue(control(m.host, "Summary"), "changed");
    assert.doesNotMatch(text(m.host), /accepted by the engine/);
    // the engine says no
    stub.handlers.workflow_contract_validate = () => ({ ok: false, errors: [{ severity: "error", code: "input_invalid", path: "/steps/0/input", pointer: "/steps/0/input", message: "arguments.query is not allowed by gmail_fetch_emails" }], warnings: [], uses: [], stepTypes: {}, usage: [], activeVersion: null });
    await click(button(m.host, "Check with the engine"));
    assert.match(text(m.host), /refused by the engine/);
    assert.match(text(m.host), /arguments\.query is not allowed/);
    // and the button waits while the local check has problems
    await setValue(control(m.host, "Title"), "");
    assert.ok(button(m.host, "Check with the engine").disabled);
    assert.match(text(m.host), /Fix the problems above first/);
    await m.unmount();
  });

  it("Check with the engine: a failed call is a plain alert, never the raw upstream text", async () => {
    reset();
    stub.fail.workflow_contract_validate = { status: 500, code: "internal_error" };
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    await click(button(m.host, "Load example"));
    await click(button(m.host, "Check with the engine"));
    assert.match(alerts(m.host)[0] ?? "", /could not check this contract/);
    stub.fail.workflow_contract_validate = { status: 401, code: "session_required" };
    await click(button(m.host, "Check with the engine"));
    assert.match(alerts(m.host)[0] ?? "", /signed out/);
    assert.doesNotMatch(alerts(m.host)[0] ?? "", /raw upstream/, "a signed-out session is the shared sentence");
    await m.unmount();
  });
});

describe("Workflow editor: save, list, open", () => {
  const VERSIONS = [
    { workflowId: "daily-email-summary", version: 2, title: "Summarize my daily emails", createdAt: "2026-10-26T04:00:00.000Z", state: "active" },
    { workflowId: "daily-email-summary", version: 1, title: "Summarize my daily emails", createdAt: "2026-10-25T04:00:00.000Z", state: "superseded" },
  ];

  it("quiet: Save sends the contract to workflow_contract_save and says the version is stored and not yet running; the list reloads", async () => {
    reset();
    let saved = false;
    stub.handlers.workflow_contracts_list = () => ({ contracts: saved ? VERSIONS : [] });
    stub.handlers.workflow_contract_save = (i) => {
      saved = true;
      return { workflowId: (i.contract as { id: string }).id, version: 2, digest: "sha256:abc", created: true, warnings: [] };
    };
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    await click(button(m.host, "Load example"));
    await click(button(m.host, "Save version"));
    const [sent] = callsOf("workflow_contract_save");
    assert.equal((sent?.contract as { id: string } | undefined)?.id, "daily-email-summary");
    assert.match(text(m.host), /Saved as version 2 of daily-email-summary\. A saved version never changes\. Activate it on the Activation page to run it\./);
    assert.equal(callsOf("workflow_promote").length + callsOf("draft_create").length, 0, "there is no engine draft and no promote");
    assert.match(text(m.host.querySelector('[aria-label="Saved versions"]')), /version 2.*active.*version 1.*superseded/);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("the same content saved again says nothing changed", async () => {
    reset();
    stub.handlers.workflow_contract_save = () => ({ workflowId: "daily-email-summary", version: 1, digest: "sha256:abc", created: false, warnings: [] });
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    await click(button(m.host, "Load example"));
    await click(button(m.host, "Save version"));
    assert.match(text(m.host), /was saved before with exactly this content\. Nothing changed\./);
    await m.unmount();
  });

  it("Open loads a saved version through workflow_contract_get into the editor", async () => {
    reset();
    stub.handlers.workflow_contracts_list = () => ({ contracts: VERSIONS });
    stub.handlers.workflow_contract_get = (i) => ({ workflowId: i.workflowId, version: i.version, title: "Opened one", digest: "sha256:abc", createdAt: "2026-10-26T04:00:00.000Z", contract: { ...DAILY_EMAIL_SUMMARY, title: "Opened one", version: i.version }, activation: null });
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    await click(button(m.host, "Open daily-email-summary version 1"));
    assert.deepEqual(callsOf("workflow_contract_get"), [{ workflowId: "daily-email-summary", version: 1 }]);
    assert.equal(control<HTMLInputElement>(m.host, "Title").value, "Opened one");
    assert.match(text(m.host), /Opened version 1 of daily-email-summary\. To change it, raise the contract version/);
    await m.unmount();
  });

  it("fire: a refused save (the version exists with other content) is a plain alert and the page keeps the work; a broken contract cannot be saved", async () => {
    reset();
    stub.fail.workflow_contract_save = { status: 409, code: "version_exists" };
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    await click(button(m.host, "Load example"));
    await click(button(m.host, "Save version"));
    assert.match(alerts(m.host)[0] ?? "", /Not saved\./);
    assert.doesNotMatch(text(m.host), /Saved as version/);
    assert.equal(control<HTMLInputElement>(m.host, "Title").value, "Summarize my daily emails");
    await setValue(control(m.host, "Title"), "");
    assert.ok(button(m.host, "Save version").disabled, "the live check has a problem");
    await m.unmount();
  });

  it("fire: a failed list of saved versions says so", async () => {
    reset();
    stub.fail.workflow_contracts_list = { status: 500, code: "internal_error" };
    const m = await mount(h(editor.Editor, { agents: AGENTS }));
    assert.match(alerts(m.host)[0] ?? "", /Saved versions could not be loaded/);
    await m.unmount();
  });
});

describe("Canonical-shape view", () => {
  it("a workflow without an ai step says it is deterministic; unlabelled flow control gets a lane of its own", async () => {
    reset();
    const noAi = { ...DAILY_EMAIL_SUMMARY, steps: DAILY_EMAIL_SUMMARY.steps.filter((s) => s.type !== "ai"), outputs: {} };
    let m = await mount(h(shape.ShapeView, { contract: noAi }));
    assert.match(text(m.host.querySelector('.lane[data-stage="intelligence"]')), /None: this workflow is fully deterministic/);
    assert.equal(m.host.querySelector(".lane-flow"), null, "no flow lane without flow steps");
    await m.unmount();
    m = await mount(h(shape.ShapeView, { contract: INBOUND_EMAIL_ADVISOR }));
    const flow = text(m.host.querySelector(".lane-flow"));
    assert.match(flow, /gate/);
    assert.match(flow, /review/);
    assert.doesNotMatch(text(m.host.querySelector('.lane[data-stage="intelligence"]')), /deterministic/);
    // the agent research step sits with the enrichment, inside its parallel branch
    assert.match(text(m.host.querySelector('.lane[data-stage="enrichment"]')), /sentiment.*agent agt_01M5BDHMN8ZQJPS4YQ4EWH8W85/);
    assert.match(text(m.host.querySelector('.lane[data-stage="event"]')), /event connect\.email\.received from connect.*poll connect\.tools every 5m/);
    await m.unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Activation review", () => {
  const WF = "daily-email-summary";
  const setup = (review: () => unknown = validateOk) => {
    reset();
    stub.handlers.workflow_contracts_list = () => ({
      contracts: [
        { workflowId: WF, version: 2, title: "Daily email summary", createdAt: "2026-10-26T04:00:00.000Z", state: null },
        { workflowId: WF, version: 1, title: "Daily email summary", createdAt: "2026-10-25T04:00:00.000Z", state: "superseded" },
      ],
    });
    stub.handlers.workflow_contract_validate = review;
    stub.handlers.workflow_activate = (i) => ({ workflowId: i.workflowId, version: i.version, activeVersion: i.version, previousVersion: i.version === 2 ? 1 : null, activatedAt: "2026-10-26T05:00:00.000Z", ops: [], usage: USAGE, crud: {}, scopes: [], warnings: [], notice: "The bridge limits Evolving Workflows as a whole." });
    stub.handlers.workflow_deactivate = (i) => ({ workflowId: i.workflowId, deactivatedVersions: [1], schedulesPaused: 1 });
  };
  const pick = async (host: Element) => {
    await choose(control<HTMLSelectElement>(host, "Workflow"), WF);
    await flush();
  };

  it("the version list says which versions are active or superseded (the engine's state)", async () => {
    setup();
    const m = await mount(h(activation.Activation, {}));
    await pick(m.host);
    const options = [...control<HTMLSelectElement>(m.host, "Version").querySelectorAll("option")].map((o) => o.textContent);
    assert.deepEqual(options, ["version 2", "version 1 (superseded)"]);
    assert.equal(callsOf("workflows_list").length + callsOf("workflow_versions").length, 0, "the engine's own list, not the 0.3.x store");
    await m.unmount();
  });

  it("quiet: choosing a workflow reviews its newest version: ops, access, scopes, the honest label; Activate sends workflow and version", async () => {
    setup();
    const m = await mount(h(activation.Activation, {}));
    assert.match(text(m.host.querySelector(".tb-empty") ?? m.host.querySelector("h1")), /Activation/);
    await pick(m.host);
    assert.deepEqual(callsOf("workflow_contract_validate"), [{ workflowId: WF, version: 2 }]);
    const rows = [...m.host.querySelectorAll("table tbody tr")].map((r) => text(r));
    assert.equal(rows.length, 2);
    assert.match(rows[0] ?? "", /connect gmail_fetch_emails read account sales/);
    assert.match(rows[1] ?? "", /gmail_create_email_draft create account sales Owner approves each call/);
    assert.match(text(m.host), /The bridge limits Evolving Workflows as a whole; each workflow's limit is enforced by the engine until per-workflow grants \(P1\)/);
    assert.deepEqual(alerts(m.host), []);
    await click(button(m.host, "Activate version 2"));
    assert.deepEqual(callsOf("workflow_activate"), [{ workflowId: WF, version: 2 }]);
    assert.match(text(m.host), /Version 2 is active\. Version 1 no longer starts new runs\./);
    await m.unmount();
  });

  it("the version select reviews another version; an active version cannot be activated again, and Deactivate sends the workflow", async () => {
    setup(() => ({ ...validateOk(), activeVersion: 1 }));
    const m = await mount(h(activation.Activation, {}));
    await pick(m.host);
    assert.match(text(m.host), /version 1 is active/);
    await choose(control<HTMLSelectElement>(m.host, "Version"), "1");
    await flush();
    assert.deepEqual(callsOf("workflow_contract_validate").at(-1), { workflowId: WF, version: 1 });
    assert.match(text(m.host), /active on the engine/);
    assert.ok(button(m.host, "Activate version 1").disabled, "already active");
    await click(button(m.host, "Deactivate"));
    assert.deepEqual(callsOf("workflow_deactivate"), [{ workflowId: WF }]);
    assert.match(text(m.host), /deactivated.*1 schedule is paused/);
    await m.unmount();
  });

  it("fire: a version the engine refuses lists the problems and cannot be activated", async () => {
    setup(() => ({ ok: false, errors: [{ severity: "error", code: "op_not_agent", path: "/steps/0/input", pointer: "/steps/0/input", message: "connect.tools is not open to agents" }], warnings: [], uses: [], stepTypes: {}, usage: [], activeVersion: null }));
    const m = await mount(h(activation.Activation, {}));
    await pick(m.host);
    assert.match(text(m.host), /connect\.tools is not open to agents/);
    assert.ok(button(m.host, "Activate version 2").disabled);
    assert.match(text(m.host), /The engine refused this version/);
    await m.unmount();
  });

  it("fire: a failed activation and a failed review show a plain alert", async () => {
    setup();
    const m = await mount(h(activation.Activation, {}));
    await pick(m.host);
    stub.fail.workflow_activate = { status: 409, code: "conflict" };
    await click(button(m.host, "Activate version 2"));
    assert.equal(alerts(m.host).length, 1);
    assert.match(alerts(m.host)[0] ?? "", /conflict/, "the app's own sentence");
    assert.doesNotMatch(text(m.host), /Version 2 is active/, "no false success");
    stub.fail.workflow_contract_validate = { status: 500, code: "internal_error" };
    await choose(control<HTMLSelectElement>(m.host, "Version"), "1");
    await flush();
    assert.match(alerts(m.host).join(" "), /could not review this version/);
    await m.unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Engine schedules", () => {
  const WF = "daily-email-summary";
  const sched = (extra: Record<string, unknown> = {}) => ({
    id: "sch_1",
    workflowId: WF,
    versionPin: null,
    kind: "schedule",
    cron: "0 8 * * *",
    every: null,
    timezone: "Asia/Bangkok",
    input: {},
    poll: null,
    overlap: "skip",
    paused: false,
    revision: 3,
    cursor: null,
    cursorAt: null,
    temporalState: "synced",
    temporalError: null,
    createdAt: "2026-10-20T01:00:00.000Z",
    updatedAt: "2026-10-25T01:00:00.000Z",
    live: { state: "ok", paused: false, nextRunAt: "2026-10-27T01:00:00.000Z", lastRunAt: "2026-10-26T01:00:00.000Z", lastRunWorkflowId: "evo:daily-email-summary:sch_1-20261026T010000Z", runningCount: 0, timezone: "Asia/Bangkok", note: null },
    ...extra,
  });
  const setup = (rows: Record<string, unknown>[]) => {
    reset();
    stub.handlers.schedules_list = () => ({ schedules: rows, temporalConnected: true });
    stub.handlers.workflow_contracts_list = () => ({ contracts: [{ workflowId: WF, version: 2, title: "Daily email summary", createdAt: "2026-10-26T04:00:00.000Z", state: "active" }] });
  };

  it("quiet: a schedule shows its cron, its time zone, and the next run in that zone", async () => {
    setup([sched()]);
    const m = await mount(h(schedules.EngineSchedules, {}));
    const card = text(m.host.querySelector("article"));
    assert.match(card, /Daily email summary active/);
    assert.match(card, /cron 0 8 \* \* \* · Asia\/Bangkok · active version · skips a run that would overlap/);
    assert.match(card, /Next run 27 Oct 2026, 08:00 \(Asia\/Bangkok\)\./, "01:00 UTC is 08:00 in Bangkok");
    assert.match(card, /Last run 26 Oct 2026, 08:00\./);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("an interval schedule says how often; a paused one says so and offers Resume", async () => {
    setup([sched({ cron: null, every: "15m", timezone: "UTC", paused: true, versionPin: 4, live: null })]);
    const m = await mount(h(schedules.EngineSchedules, {}));
    const card = text(m.host.querySelector("article"));
    assert.match(card, /every 15 min · UTC · pinned v4/);
    assert.match(card, /Paused\./);
    assert.ok(button(m.host, "Resume"));
    await m.unmount();
  });

  it("Run now says the run started (the engine gives no run id); Pause and Delete send the revision", async () => {
    setup([sched()]);
    stub.handlers.schedule_run_now = () => ({ id: "sch_1", triggered: true });
    stub.handlers.schedule_pause = () => sched({ paused: true, revision: 4 });
    stub.handlers.schedule_delete = () => ({ id: "sch_1", deleted: true });
    let seeRuns = 0;
    const m = await mount(h(schedules.EngineSchedules, { onOpenRuns: () => seeRuns++ }));
    await click(button(m.host, "Run now"));
    assert.deepEqual(callsOf("schedule_run_now"), [{ id: "sch_1" }]);
    assert.match(text(m.host), /Run started\./);
    assert.doesNotMatch(text(m.host), /evo:|run_/, "no run id is shown");
    await click(button(m.host, "See runs"));
    assert.equal(seeRuns, 1);
    await click(button(m.host, "Pause"));
    assert.deepEqual(callsOf("schedule_pause"), [{ id: "sch_1", revision: 3, paused: true }]);
    await click(button(m.host, "Delete"));
    assert.deepEqual(callsOf("schedule_delete"), [{ id: "sch_1", revision: 3 }]);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("Edit changes from a cron to an interval in another time zone and sends the revision; the schedule keeps its workflow", async () => {
    setup([sched()]);
    stub.handlers.schedule_set = () => sched();
    const m = await mount(h(schedules.EngineSchedules, {}));
    await click(button(m.host, "Edit"));
    await choose(control<HTMLSelectElement>(document.body, "Repeat"), "every");
    await setValue(control(document.body, "Every"), "2");
    await choose(control<HTMLSelectElement>(document.body, "Unit"), "h");
    await choose(control<HTMLSelectElement>(document.body, "Time zone"), "Europe/Berlin");
    await click(button(document.body, "Save"));
    assert.deepEqual(callsOf("schedule_set"), [{ id: "sch_1", revision: 3, workflowId: WF, versionPin: null, every: "2h", timezone: "Europe/Berlin", overlap: "skip" }]);
    await m.unmount();
  });

  it("New schedule: it waits for a workflow and a valid cron, then sends a cron in the chosen time zone", async () => {
    setup([]);
    stub.handlers.schedule_set = () => sched();
    const m = await mount(h(schedules.EngineSchedules, {}));
    assert.equal(m.host.querySelector(".tb-empty h3")?.textContent, "No engine schedules yet.");
    await click(button(m.host, "New engine schedule"));
    assert.ok(button(document.body, "Create schedule").disabled, "no workflow yet");
    await choose(control<HTMLSelectElement>(document.body, "Workflow"), WF);
    await setValue(control(document.body, "Cron"), "0 8 * *");
    assert.ok(button(document.body, "Create schedule").disabled, "four fields");
    assert.match(text(document.body), /A cron has 5 fields/);
    await setValue(control(document.body, "Cron"), "0  9 * * 1-5");
    await choose(control<HTMLSelectElement>(document.body, "Time zone"), "Asia/Tokyo");
    await choose(control<HTMLSelectElement>(document.body, "If a run is still going"), "buffer_one");
    await click(button(document.body, "Create schedule"));
    assert.deepEqual(callsOf("schedule_set"), [{ workflowId: WF, versionPin: null, cron: "0 9 * * 1-5", timezone: "Asia/Tokyo", overlap: "buffer_one" }]);
    await m.unmount();
  });

  it("a schedule that Temporal does not have yet, or cannot be reached for, says so; a run that did not start says so", async () => {
    setup([sched({ temporalState: "pending", live: null }), sched({ id: "sch_2", live: { state: "unreachable", paused: null, nextRunAt: null, lastRunAt: null, lastRunWorkflowId: null, runningCount: 0, timezone: null, note: null } })]);
    stub.handlers.schedule_run_now = () => ({ id: "sch_1", triggered: false });
    const m = await mount(h(schedules.EngineSchedules, {}));
    const cards = [...m.host.querySelectorAll("article")].map((a) => text(a));
    assert.match(cards[0] ?? "", /Saved\. The engine creates it as soon as Temporal answers\./);
    assert.match(cards[1] ?? "", /Temporal cannot be reached/);
    await click(button(m.host, "Run now"));
    assert.match(text(m.host), /did not start a run/);
    await m.unmount();
  });

  it("the time zone picker offers UTC first and the IANA names", async () => {
    setup([]);
    const m = await mount(h(schedules.EngineSchedules, {}));
    await click(button(m.host, "New engine schedule"));
    const zones = [...control<HTMLSelectElement>(document.body, "Time zone").querySelectorAll("option")].map((o) => o.value);
    assert.equal(zones[0], "UTC");
    assert.ok(zones.includes("Asia/Bangkok") && zones.includes("America/New_York"));
    await m.unmount();
  });

  it("fire: a failed load is an alert with Try again (not an empty state); a failed Run now says so and keeps the card", async () => {
    setup([sched()]);
    stub.fail.schedules_list = { status: 500, code: "internal_error" };
    const m = await mount(h(schedules.EngineSchedules, {}));
    assert.match(alerts(m.host)[0] ?? "", /Engine schedules could not be loaded/);
    assert.equal(m.host.querySelector(".tb-empty"), null);
    stub.fail.schedules_list = undefined;
    await click(button(m.host, "Try again"));
    assert.deepEqual(alerts(m.host), []);
    stub.handlers.schedule_run_now = () => ({ id: "sch_1", triggered: true });
    stub.fail.schedule_run_now = { status: 503, code: "engine_unavailable" };
    await click(button(m.host, "Run now"));
    assert.equal(alerts(m.host).length, 1);
    assert.match(alerts(m.host)[0] ?? "", /engine_unavailable/, "the app's own sentence");
    assert.doesNotMatch(text(m.host), /Run started/);
    assert.equal(m.host.querySelectorAll("article").length, 1);
    await m.unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Runs and run detail", () => {
  const HOLD = "hld_01HZX3K8Q2V4N6P8R0S2T4V6W8";
  const run = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    workflowId: "inbound-email-advisor",
    runId: id,
    version: 2,
    scheduleId: null,
    temporalWorkflowId: `evo:inbound-email-advisor:${id}`,
    temporalRunId: "tr_1",
    triggerKind: "poll",
    status,
    startedAt: "2026-10-26T05:00:00.000Z",
    endedAt: status === "running" ? null : "2026-10-26T05:03:20.000Z",
    durationMs: status === "running" ? null : 200_000,
    errorCode: null,
    errorStep: null,
    skippedReason: null,
    stepsDone: 3,
    stepsFailed: 0,
    heldWaits: 0,
    heldWaitMs: 0,
    modelTokens: 1200,
    outputBytes: null,
    source: "activity",
    ...extra,
  });
  const step = (stepId: string, kind: string, status: string, extra: Record<string, unknown> = {}) => ({
    stepKey: `${stepId}`,
    stepId,
    loopPath: null,
    kind,
    product: null,
    op: null,
    status,
    attempts: 1,
    attempt: 1,
    stage: null,
    startedAt: "2026-10-26T05:00:10.000Z",
    endedAt: "2026-10-26T05:00:40.000Z",
    durationMs: 30_000,
    holdId: null,
    holdStartedAt: null,
    holdEndedAt: null,
    holdOutcome: null,
    inBytes: null,
    outBytes: null,
    tokensIn: null,
    tokensOut: null,
    errorCode: null,
    stepRunId: null,
    agentId: null,
    ...extra,
  });
  const agentStep = (events: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
    stepRunId: "asr_1",
    workflowId: "inbound-email-advisor",
    workflowTitle: "Inbound email advisor",
    version: 2,
    runId: "r_wait",
    stepId: "sentiment",
    agentId: POLLY.id,
    status: "claimed",
    attempt: 2,
    offeredAt: "2026-10-26T05:01:00.000Z",
    deadlineAt: "2026-10-26T05:16:00.000Z",
    claimedBy: POLLY.id,
    claimedAt: "2026-10-26T05:09:00.000Z",
    heartbeatAt: "2026-10-26T05:10:00.000Z",
    finishedAt: null,
    heartbeatSec: 60,
    outputBytes: null,
    summary: null,
    metrics: null,
    invalidReports: 1,
    events,
    ...extra,
  });
  const EVENTS = [
    { attempt: 1, kind: "offered", agentId: POLLY.id, detail: null, at: "2026-10-26T05:01:00.000Z" },
    { attempt: 1, kind: "claimed", agentId: POLLY.id, detail: null, at: "2026-10-26T05:02:00.000Z" },
    { attempt: 1, kind: "timed_out", agentId: POLLY.id, detail: "No heartbeat for 3 x 60 s.", at: "2026-10-26T05:05:00.000Z" },
    { attempt: 2, kind: "offered", agentId: POLLY.id, detail: null, at: "2026-10-26T05:08:00.000Z" },
    { attempt: 2, kind: "claimed", agentId: POLLY.id, detail: null, at: "2026-10-26T05:09:00.000Z" },
  ];
  const setup = () => {
    reset();
    stub.handlers.workflow_contracts_list = () => ({ contracts: [{ workflowId: "inbound-email-advisor", version: 2, title: "Inbound email advisor", createdAt: "2026-10-26T04:00:00.000Z", state: "active" }] });
    stub.handlers.engine_runs_list = () => ({ runs: [run("r_wait", "running", { startedAt: "2026-10-26T06:00:00.000Z" }), run("r_ok", "completed"), run("r_bad", "failed", { errorCode: "not_in_workflow", errorStep: "fetch", stepsFailed: 1 })] });
    stub.handlers.engine_run_get = (i) => ({
      run: i.runId === "r_wait" ? run("r_wait", "running", { startedAt: "2026-10-26T06:00:00.000Z" }) : run(String(i.runId), "completed"),
      steps: [
        step("parse", "transform", "completed"),
        step("crm", "app", "waiting_hold", { holdId: HOLD, endedAt: null, product: "connect", op: "tools" }),
        step("sentiment", "ai", "waiting_agent", { stepRunId: "asr_1", agentId: POLLY.id, attempt: 2, attempts: 2, endedAt: null }),
        step("review", "approval", "waiting_owner", { startedAt: null, endedAt: null }),
        step("fetch", "app", "failed", { errorCode: "not_in_workflow" }),
        step("body", "transform", "completed", { loopPath: "2", outBytes: 40 }),
      ],
      outputs: i.runId === "r_ok" ? { draftId: "d_1" } : null,
    });
    stub.handlers.agent_steps_list = () => ({ steps: [agentStep(EVENTS)] });
  };
  const mountRuns = (open?: string) => mount(h(runs.Runs, { agents: AGENTS, openId: open ?? null, holdHref: (id: string) => `./holds/${id}` }));

  it("quiet: the list shows each run with its status; the first run opens as a step timeline", async () => {
    setup();
    const m = await mountRuns();
    const items = [...m.host.querySelectorAll(".pane-item")].map((b) => text(b));
    assert.equal(items.length, 3);
    assert.match(items[0] ?? "", /Inbound email advisor v2.*running/);
    assert.match(items[1] ?? "", /completed/);
    assert.match(items[2] ?? "", /failed/);
    assert.deepEqual(callsOf("engine_run_get"), [{ runId: "r_wait" }], "the first run is open");
    assert.deepEqual(callsOf("agent_steps_list"), [{ runId: "r_wait", limit: 200 }]);
    const lines = [...m.host.querySelectorAll(".timeline > li")].map((li) => text(li));
    assert.equal(lines.length, 6);
    assert.match(lines[0] ?? "", /parse transform completed.*took 30 s/);
    assert.match(lines[3] ?? "", /review approval waiting for your answer/);
    assert.match(lines[4] ?? "", /fetch app failed.*not in workflow/);
    assert.match(lines[5] ?? "", /body \(loop 2\) transform completed/);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("a held call links to its hold; a waiting agent step names the card and shows offered, claimed and timed out per attempt", async () => {
    setup();
    const m = await mountRuns();
    const crm = text([...m.host.querySelectorAll(".timeline > li")][1] ?? null);
    assert.match(crm, /waiting for your approval connect\.tools/);
    assert.equal([...m.host.querySelectorAll(".timeline a")].find((a) => /approval/.test(a.textContent ?? ""))?.getAttribute("href"), `./holds/${HOLD}`);
    const wait = m.host.querySelector('.agent-wait[data-step="sentiment"]');
    assert.ok(wait);
    assert.match(text(wait.querySelector(".tb-tag")), /waiting for Polly/);
    const history = [...wait.querySelectorAll(".agent-history li")].map((li) => text(li));
    assert.match(history[0] ?? "", /Attempt 1: offered by Polly .* · claimed by Polly .* · timed out .*No heartbeat for 3 x 60 s\./);
    assert.match(history[1] ?? "", /Attempt 2: offered by Polly .* · claimed by Polly/);
    assert.doesNotMatch(history[1] ?? "", /timed out/, "attempt 2 is still going");
    assert.match(history[2] ?? "", /1 answer\(s\) did not match the output schema/);
    assert.match(text(m.host.querySelector("article")), /only returns content/, "the honest agent-step label");
    await m.unmount();
  });

  it("the runner configuration for step-answering agents names the four step ops", async () => {
    setup();
    const m = await mountRuns();
    const block = text([...m.host.querySelectorAll("details")].find((d) => /Runner configuration/.test(d.textContent ?? "")) ?? null);
    assert.match(block, /Runner configuration for an agent that answers workflow steps/);
    assert.match(block, /evolution__steps_due/);
    assert.match(block, /evolution__step_claim/);
    assert.match(block, /evolution__step_report/);
    assert.match(block, /"id": "stepRunId"/);
    await m.unmount();
  });

  it("the result of a completed run is owner-only and shows only when the engine gives it; step bodies are not shown (the index keeps sizes)", async () => {
    setup();
    let m = await mountRuns("r_ok");
    const result = [...m.host.querySelectorAll("details")].find((d) => /Result of the run \(owner only\)/.test(d.textContent ?? ""));
    assert.ok(result);
    assert.match(result.querySelector("pre")?.textContent ?? "", /"draftId": "d_1"/);
    assert.equal(m.host.querySelectorAll(".timeline details").length, 0, "no input or output bodies on a step");
    await m.unmount();
    m = await mountRuns("r_wait");
    assert.ok(![...m.host.querySelectorAll("details")].some((d) => /Result of the run/.test(d.textContent ?? "")), "a running run has no result");
    await m.unmount();
  });

  it("a failed run says where and why in plain words", async () => {
    setup();
    stub.handlers.engine_run_get = () => ({ run: run("r_bad", "failed", { errorCode: "not_in_workflow", errorStep: "fetch", stepsFailed: 1 }), steps: [], outputs: null });
    const failed = await mountRuns("r_bad");
    assert.match(alerts(failed.host).join(" "), /The run stopped at step fetch: not in workflow\./);
    await failed.unmount();
  });

  it("another run opens on a click; the filter chips narrow the list", async () => {
    setup();
    const m = await mountRuns();
    await click([...m.host.querySelectorAll(".pane-item")][1] as Element);
    assert.deepEqual(callsOf("engine_run_get").at(-1), { runId: "r_ok" });
    await click(button(m.host, "Needs attention"));
    assert.deepEqual([...m.host.querySelectorAll(".pane-item")].map((b) => /failed/.test(text(b))), [true]);
    await click(button(m.host, "Completed"));
    assert.equal(m.host.querySelectorAll(".pane-item").length, 1);
    await click(button(m.host, "Running"));
    assert.equal(m.host.querySelectorAll(".pane-item").length, 1);
    await m.unmount();
  });

  it("a run that the Schedules page opens is the one shown", async () => {
    setup();
    const m = await mountRuns("r_bad");
    assert.deepEqual(callsOf("engine_run_get"), [{ runId: "r_bad" }]);
    await m.unmount();
  });

  it("fire: a failed list, a failed run and a failed agent-step load each say so; none is shown as empty", async () => {
    setup();
    stub.fail.engine_runs_list = { status: 500, code: "internal_error" };
    let m = await mountRuns();
    assert.match(alerts(m.host)[0] ?? "", /Runs could not be loaded/);
    assert.equal(m.host.querySelector(".tb-empty"), null);
    await m.unmount();
    setup();
    stub.fail.engine_run_get = { status: 404, code: "not_found" };
    m = await mountRuns();
    assert.match(alerts(m.host).join(" "), /The run could not be loaded/);
    await m.unmount();
    setup();
    stub.fail.agent_steps_list = { status: 500, code: "internal_error" };
    m = await mountRuns();
    assert.match(alerts(m.host).join(" "), /agent steps of this run could not be loaded/);
    assert.equal(m.host.querySelectorAll(".timeline > li").length, 6, "the timeline itself still shows");
    assert.match(text(m.host.querySelector('.agent-wait[data-step="sentiment"]')), /Offered to Polly/, "without the history it still says who was offered the step");
    await m.unmount();
  });

  it("no runs is an empty state, not an error", async () => {
    reset();
    stub.handlers.engine_runs_list = () => ({ runs: [] });
    const m = await mountRuns();
    assert.equal(m.host.querySelector(".tb-empty h3")?.textContent, "No runs yet.");
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("Cycles: engine runs next to legacy runs", () => {
  const cycle = (workflowId: string, workflowTitle: string, version: number, total: number, completed: number) => ({ workflowId, workflowTitle, version, counts: { total, completed } });
  const er = (workflowId: string, version: number, status: string, startedAt: string, modelTokens: number | null = null) => ({
    runId: `${workflowId}-${startedAt}`,
    workflowId,
    version,
    status,
    startedAt,
    modelTokens: modelTokens ?? 0,
  });

  it("sideBySide puts both kinds of run on one row per version, counts them, keeps the newest ten and sorts by workflow then newest version", () => {
    const rows = cycles.sideBySide(
      [
        er("wfl_a", 2, "completed", "2026-10-26T01:00:00Z", 100),
        er("wfl_a", 2, "failed", "2026-10-26T02:00:00Z"),
        er("wfl_a", 2, "running", "2026-10-26T03:00:00Z"),
        er("wfl_b", 1, "timed_out", "2026-10-26T04:00:00Z"),
        ...Array.from({ length: 12 }, (_, i) => er("wfl_a", 3, "completed", `2026-10-27T${String(i).padStart(2, "0")}:00:00Z`)),
      ] as never,
      [cycle("wfl_a", "Alpha", 2, 4, 3), cycle("wfl_a", "Alpha", 1, 2, 2), cycle("wfl_c", "Gamma", 1, 0, 0)] as never,
    );
    assert.deepEqual(
      rows.map((r) => `${r.workflowTitle} v${r.version}`),
      ["Alpha v3", "Alpha v2", "Alpha v1", "wfl_b v1"],
      "Gamma has no runs of either kind: no row; a workflow without a cycle shows its id",
    );
    const a2 = rows[1];
    assert.deepEqual([a2?.legacy, a2?.engine.total, a2?.engine.completed, a2?.engine.failed, a2?.engine.open, a2?.engine.tokens], [{ total: 4, completed: 3 }, 3, 1, 1, 1, 100]);
    assert.deepEqual(a2?.engine.last10, ["running", "failed", "completed"], "newest first");
    assert.equal(rows[0]?.engine.last10.length, 10);
    assert.deepEqual([rows[2]?.engine.total, rows[2]?.legacy.total], [0, 2], "legacy-only version");
    assert.equal(rows[3]?.engine.failed, 1, "timed out counts as failed");
  });

  it("the table shows legacy and engine counts side by side; a failed load is an alert", async () => {
    reset();
    stub.handlers.engine_runs_list = () => ({ runs: [er("wfl_a", 2, "completed", "2026-10-26T01:00:00Z"), er("wfl_a", 2, "failed", "2026-10-26T02:00:00Z")] });
    const m = await mount(h(cycles.EngineCycles, { cycles: [cycle("wfl_a", "Alpha", 2, 4, 3)] as never }));
    const row = text(m.host.querySelector("tbody tr"));
    assert.match(row, /Alpha v2 4 \(75% completed\) 2 50% 1 –/);
    assert.match(m.host.querySelector('[role="img"]')?.getAttribute("aria-label") ?? "", /Last 2 engine runs, newest first: failed, completed/);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
    stub.fail.engine_runs_list = { status: 500, code: "internal_error" };
    const bad = await mount(h(cycles.EngineCycles, { cycles: [] as never }));
    assert.match(alerts(bad.host)[0] ?? "", /Engine runs could not be loaded/);
    await bad.unmount();
  });

  it("a version with legacy runs only is not repeated here; no engine runs at all says so", async () => {
    reset();
    stub.handlers.engine_runs_list = () => ({ runs: [] });
    const m = await mount(h(cycles.EngineCycles, { cycles: [cycle("wfl_a", "Alpha", 2, 4, 3)] as never }));
    assert.match(text(m.host), /No engine runs yet/);
    assert.equal(m.host.querySelector("table"), null, "the legacy-only version is a row of the table above, not of this one");
    await m.unmount();
  });
});
