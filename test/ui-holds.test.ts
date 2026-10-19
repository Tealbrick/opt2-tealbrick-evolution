// The standard Holds page (src/ui/standard.tsx) against the real SDK client and a stub server:
// RUL-01 (a failed decision shows a message), RUL-14 (a failed load is an error, not an empty list), C8 (one call at a
// time per hold). Also the Schedules Edit dialog and the Cycles page (0.3.0, C250 Release B). The page is compiled with the build tsconfig into dist/ui-test (JSX needs a compile) and rendered in
// happy-dom.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

type Standard = typeof import("../src/ui/standard.tsx");
type SchedulesUi = typeof import("../src/ui/Schedules.tsx");
type CyclesUi = typeof import("../src/ui/Cycles.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test");

// ── DOM ────────────────────────────────────────────────────────────────────
const win = new Window({ url: "http://localhost/a/kanban/", width: 1280, height: 860 });
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

// ── stub server (the standard ops under /a/kanban/tb/v1/) ───────────────────
const ULID = "01HZX3K8Q2V4N6P8R0S2T4V6W8";
type StubHold = { id: string; caller: { type: "agent"; id: string; name: string }; op: string; holdFamily: string | null; heldBy: string | null; summary: string; view?: string; status: "held" };
const hold = (n: number, caller: string, op: string, summary: string, extra: Partial<StubHold> = {}): StubHold => ({
  id: `hld_${ULID.slice(0, 25)}${n}`,
  caller: { type: "agent", id: `agt_${n}`, name: caller },
  op,
  holdFamily: null,
  heldBy: null,
  summary,
  status: "held",
  ...extra,
});
const A = hold(1, "Research partner", "issue_delete", "Delete issue “Old price list”", { holdFamily: "delete", view: "issue: Old price list\nproject: Launch" });
const B = hold(2, "Front desk", "issue_move", "Move “Draft letters” to Done");

interface Stub {
  holds: StubHold[];
  calls: { op: string; input: unknown }[];
  /** per-op override: return an error envelope (status, code) or a promise to hold the answer */
  fail: Record<string, { status: number; code: string } | undefined>;
  gate: Record<string, Promise<void> | undefined>;
  networkDown: boolean;
  cycles: Record<string, unknown>[];
  /** the lessons cycle_get answers (C288 R8) */
  lessons: { occurrence: string; reportedAt: string; text: string }[];
}
const stub: Stub = { holds: [], calls: [], fail: {}, gate: {}, networkDown: false, cycles: [], lessons: [] };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (stub.networkDown) throw new TypeError("fetch failed");
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/kanban/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
  stub.calls.push({ op, input: body.input });
  await stub.gate[op];
  const failure = stub.fail[op];
  if (failure) return json(failure.status, { error: { code: failure.code, message: `raw upstream text for ${failure.code}`, requestId: "req_1" } });
  if (op === "automation_set") return json(200, { status: "ok", output: {} });
  if (op === "cycles_list") return json(200, { status: "ok", output: { cycles: stub.cycles } });
  if (op === "cycle_get") {
    const { workflowId, version } = body.input as { workflowId: string; version: number };
    return json(200, { status: "ok", output: { cycle: stub.cycles.find((c) => c.workflowId === workflowId && c.version === version), evals: [], lessons: stub.lessons } });
  }
  if (op === "cycle_eval_run") {
    const { workflowId, version } = body.input as { workflowId: string; version: number };
    const stored = { id: "evr_01HZX3K8Q2V4N6P8R0S2T4V6W8", verdict: "pass", trigger: "owner", createdAt: "2026-10-18T09:00:00.000Z" };
    stub.cycles = stub.cycles.map((c) => (c.workflowId === workflowId && c.version === version ? { ...c, evalStored: stored } : c));
    return json(200, { status: "ok", output: { ...stored, workflowId, version, results: [], appVersion: "0.2.13" } });
  }
  if (op === "tb.holds_list") return json(200, { status: "ok", output: { items: stub.holds, nextCursor: null } });
  if (op === "tb.holds_decide") {
    const id = (body.input as { holdId: string }).holdId;
    stub.holds = stub.holds.filter((h) => h.id !== id);
    return json(200, { status: "ok", output: {} });
  }
  return json(404, { error: { code: "not_found", message: op } });
}) as typeof fetch;

// ── React ──────────────────────────────────────────────────────────────────
const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { TbProvider } = await import("@opt2-tealbrick/miniapp-sdk/client");

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => new Promise((r) => setTimeout(r, 0)));
}
async function mount(el: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const r = createRoot(host);
  await act(async () => r.render(h(TbProvider, { product: "kanban" }, el)));
  await flush();
  return {
    host,
    unmount: async () => {
      await act(async () => r.unmount());
      host.remove();
    },
  };
}
const click = (el: Element) => act(async () => (el as HTMLElement).click());
const button = (host: Element, text: string, n = 0) => {
  const found = [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text)[n];
  assert.ok(found, `button "${text}"`);
  return found as HTMLButtonElement;
};
const rows = (host: Element) => [...host.querySelectorAll(".item")];
const alerts = (host: Element) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent ?? "");

let std: Standard;
let sched: SchedulesUi;
let cyc: CyclesUi;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  std = (await import(pathToFileURL(join(outDir, "ui", "standard.js")).href)) as Standard;
  sched = (await import(pathToFileURL(join(outDir, "ui", "Schedules.js")).href)) as SchedulesUi;
  cyc = (await import(pathToFileURL(join(outDir, "ui", "Cycles.js")).href)) as CyclesUi;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

const reset = (holds: StubHold[]) => {
  stub.holds = [...holds];
  stub.calls = [];
  stub.fail = {};
  stub.gate = {};
  stub.networkDown = false;
  stub.cycles = [];
  stub.lessons = [];
};

describe("Holds page", () => {
  it("lists held calls: caller, summary, op tag, view, Approve (primary) and Deny", async () => {
    reset([A, B]);
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits for your approval." }));
    assert.equal(m.host.querySelector("h1")?.textContent, "Holds");
    assert.equal(rows(m.host).length, 2);
    const first = rows(m.host)[0] as Element;
    assert.equal(first.querySelector("h3")?.textContent, "Research partner");
    assert.match(first.textContent ?? "", /Delete issue “Old price list”/);
    assert.match(first.querySelector(".tb-tag.needs-you")?.textContent ?? "", /issue_delete/);
    assert.match(first.querySelector("pre.view")?.textContent ?? "", /project: Launch/);
    assert.ok(button(first, "Approve").className.includes("primary"));
    assert.ok(!button(first, "Deny").className.includes("primary"));
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("RUL-01 fires: a failed decision shows a plain message in an alert and keeps the row", async () => {
    reset([A, B]);
    stub.fail["tb.holds_decide"] = { status: 409, code: "hold_expired" };
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits." }));
    await click(button(rows(m.host)[0] as Element, "Approve"));
    await flush();
    const [message] = alerts(m.host);
    assert.match(message ?? "", /expired before you decided/);
    assert.doesNotMatch(message ?? "", /raw upstream/, "never the raw upstream text");
    assert.equal(rows(m.host).length, 2, "the list is reloaded and still has both (stub keeps them)");
    assert.ok(!button(rows(m.host)[0] as Element, "Approve").disabled, "buttons are back after the call");
    await m.unmount();
  });

  it("RUL-01 fires for a network error and a signed-out session", async () => {
    reset([A]);
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits." }));
    stub.fail["tb.holds_decide"] = { status: 401, code: "session_required" };
    await click(button(m.host, "Deny"));
    await flush();
    assert.match(alerts(m.host)[0] ?? "", /signed out/);
    stub.fail["tb.holds_decide"] = undefined;
    stub.networkDown = true;
    await click(button(m.host, "Deny"));
    await flush();
    assert.ok(alerts(m.host).some((a) => /reach the app/.test(a)));
    await m.unmount();
  });

  it("RUL-01 quiet: a decision that goes through removes the row and shows no alert", async () => {
    reset([A, B]);
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits." }));
    await click(button(rows(m.host)[0] as Element, "Approve"));
    await flush();
    assert.deepEqual(stub.calls.filter((c) => c.op === "tb.holds_decide").map((c) => c.input), [{ holdId: A.id, decision: "approve" }]);
    assert.equal(rows(m.host).length, 1);
    assert.equal(rows(m.host)[0]?.querySelector("h3")?.textContent, "Front desk");
    assert.deepEqual(alerts(m.host), []);
    await click(button(m.host, "Deny"));
    await flush();
    assert.equal(rows(m.host).length, 0);
    assert.equal(m.host.querySelector(".tb-empty h3")?.textContent, "Nothing waits.", "the app's own empty sentence");
    await m.unmount();
  });

  it("C8: while a decision runs its buttons are disabled and a second click sends nothing", async () => {
    reset([A, B]);
    let release = () => {};
    stub.gate["tb.holds_decide"] = new Promise<void>((r) => {
      release = r;
    });
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits." }));
    const approve = button(rows(m.host)[0] as Element, "Approve");
    await act(async () => {
      approve.click(); // two clicks before React re-renders: the second must be ignored
      approve.click();
    });
    assert.ok(approve.disabled && button(rows(m.host)[0] as Element, "Deny").disabled, "both buttons of that hold are disabled");
    assert.ok(!button(rows(m.host)[1] as Element, "Approve").disabled, "other holds are not blocked");
    assert.equal(stub.calls.filter((c) => c.op === "tb.holds_decide").length, 1);
    release();
    await flush();
    assert.equal(rows(m.host).length, 1);
    await m.unmount();
  });

  it("RUL-14: a failed load is an error with Try again, not an empty state; Try again loads", async () => {
    reset([A]);
    stub.fail["tb.holds_list"] = { status: 500, code: "internal_error" };
    const m = await mount(h(std.HoldsPage, { empty: "Nothing waits." }));
    assert.match(alerts(m.host)[0] ?? "", /Something went wrong/);
    assert.equal(m.host.querySelector(".tb-empty"), null, "no false empty state");
    stub.fail["tb.holds_list"] = undefined;
    await click(button(m.host, "Try again"));
    await flush();
    assert.deepEqual(alerts(m.host), []);
    assert.equal(rows(m.host).length, 1);
    await m.unmount();
  });

  it("deep link: only the named hold; a gone hold says so", async () => {
    reset([A, B]);
    let m = await mount(h(std.HoldsPage, { empty: "Nothing waits.", only: B.id }));
    assert.equal(rows(m.host).length, 1);
    assert.equal(rows(m.host)[0]?.querySelector("h3")?.textContent, "Front desk");
    await m.unmount();
    m = await mount(h(std.HoldsPage, { empty: "Nothing waits.", only: `hld_${ULID.slice(0, 25)}9` }));
    assert.equal(m.host.querySelector(".tb-empty h3")?.textContent, "This approval is no longer waiting.");
    await m.unmount();
  });
});

describe("helpers", () => {
  it("decideOrError returns the message, or null when it went through", async () => {
    const expired = async () => {
      throw Object.assign(new Error("raw"), { code: "hold_expired" });
    };
    assert.match((await std.decideOrError(expired, "hld_1", "approve")) ?? "", /expired/);
    assert.equal(await std.decideOrError(async () => {}, "hld_1", "deny"), null);
    assert.equal(std.errorMessage("not an Error"), "Something went wrong. Try again in a moment.");
  });

  it("portalHref: only an https tealbrick.com origin is the Portal link; anything else is the app's own launch page", () => {
    sessionStorage.clear();
    for (const referrer of ["", "https://evil.example/page", "http://dev.tealbrick.com/", "https://tealbrick.com.evil.example/", "https://eviltealbrick.com/", "https://portal.tealbrick.com@evil.example/", "not a url"])
      assert.equal(std.portalHref(referrer), "./", `not used: ${referrer}`);
    assert.equal(std.portalHref("https://dev.tealbrick.com/canvas?x=1"), "https://dev.tealbrick.com/");
    assert.equal(std.portalHref("https://tealbrick.com/"), "https://tealbrick.com/");
    // remembered for a reload without a referrer; a foreign value in storage is ignored
    sessionStorage.setItem("tb.portalOrigin", "https://dev.tealbrick.com");
    assert.equal(std.portalHref(""), "https://dev.tealbrick.com/");
    sessionStorage.setItem("tb.portalOrigin", "https://evil.example");
    assert.equal(std.portalHref(""), "./");
    sessionStorage.clear();
  });

  it("the router maps paths to pages under the base and finds a /holds/<id> deep link", () => {
    const routes = std.standardRoutes("board");
    const base = "/a/kanban/";
    assert.deepEqual(routes, { board: "", holds: "holds", receipts: "receipts", agents: "configure", backups: "backups" });
    assert.equal(std.pageOf(routes, base, "/a/kanban/", "board"), "board");
    assert.equal(std.pageOf(routes, base, "/a/kanban/configure/", "board"), "agents");
    assert.equal(std.pageOf(routes, base, "/a/kanban/receipts", "board"), "receipts");
    assert.equal(std.pageOf(routes, base, "/a/kanban/nope", "board"), "board");
    assert.equal(std.pageOf(std.standardRoutes(), base, "/a/kanban/", "holds"), "holds");
    assert.equal(std.pageOf(routes, base, `/a/kanban/holds/hld_${ULID}`, "board"), "holds");
    assert.equal(std.holdOf(`/a/kanban/holds/hld_${ULID}/`), `hld_${ULID}`);
    assert.equal(std.holdOf("/a/kanban/holds/hld_short"), null);
  });
});

describe("Schedules: Edit (C250 review S2: the warnings ask for Edit)", () => {
  const automation = {
    id: "aut_01HZX3K8Q2V4N6P8R0S2T4V6W8",
    workflowId: "wfl_01HZX3K8Q2V4N6P8R0S2T4V6W8",
    workflowTitle: "Morning rollup",
    versionPin: null,
    policyVersion: 1,
    agentId: "agt_01HZX3K8Q2V4N6P8R0S2T4V6W8",
    cron: "0 8 * * *",
    enabled: true,
    misfireGraceSec: 120,
    kanbanProject: null,
    revision: 3,
    nextDueAt: "2026-10-13T08:00:00.000Z",
    effectiveNextDueAt: "2026-10-13T08:00:00.000Z",
    missedSince: null,
    createdAt: "2026-10-12T06:00:00.000Z",
    updatedAt: "2026-10-12T06:00:00.000Z",
    warnings: [],
  };
  it("Save sends every field unchanged except what the owner edited (pin, enabled, grace, policyVersion kept)", async () => {
    reset([]);
    let saved = 0;
    const m = await mount(
      h(sched.EditSchedule, { automation, activeVersion: 2, kanbanLinked: true, onClose: () => {}, onSaved: async () => void saved++ }),
    );
    const input = [...document.querySelectorAll("input")].find((i) => i.value === "") as HTMLInputElement;
    assert.ok(input, "the empty project field");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      set?.call(input, "prj_shared");
      input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
    await click(button(document.body, "Save"));
    await flush();
    const call = stub.calls.find((c) => c.op === "automation_set");
    assert.deepEqual(call?.input, {
      id: automation.id,
      revision: 3,
      workflowId: automation.workflowId,
      agentId: automation.agentId,
      versionPin: null,
      enabled: true,
      misfireGraceSec: 120,
      cron: "0 8 * * *",
      policyVersion: 1,
      kanbanProject: "prj_shared",
    });
    assert.equal(saved, 1);
    await m.unmount();
  });
});

describe("Cycles page (C250 Release B)", () => {
  const WF = "wfl_01HZX3K8Q2V4N6P8R0S2T4V6W8";
  const WF2 = "wfl_01HZX3K8Q2V4N6P8R0S2T4V6W9";
  const cycle = (workflowId: string, title: string, version: number, extra: Record<string, unknown> = {}) => ({
    workflowId,
    workflowTitle: title,
    version,
    parentVersion: version > 1 ? version - 1 : null,
    promotedAt: `2026-10-0${version}T08:00:00.000Z`,
    retiredAt: null,
    active: true,
    suggestionId: null,
    evidenceCount: 0,
    approvalDelayMs: null,
    draftRevisions: version,
    widensAccess: false,
    counts: { total: 10, completed: 10, failed: 0, uncertain: 0, missed: 0, policyStale: 0, open: 0 },
    completedRatio: 1,
    uncertainRatio: 0,
    failedRatio: 0,
    missedRatio: 0,
    claimLatencyP50Ms: 30000,
    durationP50Ms: 60000,
    kanbanClosedRatio: 1,
    duplicateClaims: 0,
    last10: ["completed", "failed", "missed"],
    runMetrics: { runs: 0, okRuns: 0, okRatio: null, minutesMedian: null, minutesMean: null, retriesTotal: 0, questionsToMartinTotal: 0, lessonCount: 0, namedMetrics: [] },
    evalLive: { verdict: "pass", results: [] },
    evalStored: null,
    ...extra,
  });
  const LIST = () => [
    cycle(WF, "Morning rollup", 2, { widensAccess: true, completedRatio: 1, runMetrics: { runs: 8, okRuns: 6, okRatio: 0.75, minutesMedian: 12, minutesMean: 14.5, retriesTotal: 3, questionsToMartinTotal: 1, lessonCount: 2, namedMetrics: [] } }),
    cycle(WF, "Morning rollup", 1, { active: false, runMetrics: { runs: 5, okRuns: 3, okRatio: 0.6, minutesMedian: 20, minutesMean: 22, retriesTotal: 0, questionsToMartinTotal: 0, lessonCount: 0, namedMetrics: [] }, retiredAt: "2026-10-02T08:00:00.000Z", completedRatio: 0.8, approvalDelayMs: 7_200_000, evalStored: { id: "evr_1", verdict: "fail", trigger: "promotion", createdAt: "2026-10-02T08:00:00.000Z" }, evalLive: { verdict: "fail", results: [] } }),
    cycle(WF2, "Invoice run", 1, { completedRatio: null, last10: [], evalLive: { verdict: "insufficient", results: [] }, counts: { total: 0, completed: 0, failed: 0, uncertain: 0, missed: 0, policyStale: 0, open: 0 } }),
  ];
  const cycleOf = (runs: number) => ({
    version: 1,
    runMetrics: { runs, okRuns: runs, okRatio: runs ? 1 : null, minutesMedian: runs ? 5 : null, minutesMean: runs ? 5 : null, retriesTotal: 0, questionsToMartinTotal: 0, lessonCount: 0, namedMetrics: [] },
  });
  const tableRows = (host: Element) => [...host.querySelectorAll("tbody > tr:not(.cycle-detail)")];

  it("quiet: one row per workflow (its active cycle) with ticks, completed ratio, trend and the live verdict", async () => {
    reset([]);
    stub.cycles = LIST();
    const m = await mount(h(cyc.Cycles, {}));
    assert.equal(m.host.querySelector("h1")?.textContent, "Cycles");
    const rws = tableRows(m.host);
    assert.equal(rws.length, 2, "retired cycles are not rows");
    const [first, second] = rws as [Element, Element];
    assert.match(first.textContent ?? "", /Morning rollup/);
    assert.match(first.textContent ?? "", /v2/);
    assert.equal(first.querySelectorAll(".ticks .tb-tag").length, 3);
    assert.match(first.querySelector(".ticks")?.getAttribute("aria-label") ?? "", /completed, failed, missed/);
    assert.match(first.textContent ?? "", /100%/);
    assert.equal(first.querySelector(".trend")?.getAttribute("aria-label"), "up from the previous version");
    assert.equal(first.querySelector("td:nth-child(5) .tb-tag.live")?.textContent, "pass");
    assert.match(second.textContent ?? "", /No runs yet/);
    assert.equal(second.querySelector(".trend")?.getAttribute("aria-label"), "no previous version to compare");
    assert.match(second.textContent ?? "", /not enough runs/);
    assert.deepEqual(alerts(m.host), []);
    assert.equal(m.host.querySelector(".tb-empty"), null);
    await m.unmount();
  });

  it("a row opens the version timeline; Store eval now stores the active cycle's eval once and reloads", async () => {
    reset([]);
    stub.cycles = LIST();
    let release = () => {};
    stub.gate.cycle_eval_run = new Promise<void>((r) => {
      release = r;
    });
    const m = await mount(h(cyc.Cycles, {}));
    await click(button(m.host, "Show versions"));
    const items = [...m.host.querySelectorAll(".timeline > li")];
    assert.deepEqual(items.map((li) => li.querySelector("strong")?.textContent), ["Version 2", "Version 1"], "newest first");
    assert.match(items[0]?.textContent ?? "", /wider access/);
    assert.doesNotMatch(items[1]?.textContent ?? "", /wider access/);
    assert.match(items[1]?.textContent ?? "", /at close: fail/);
    assert.match(items[1]?.textContent ?? "", /approved 2 h after the suggestion/);
    assert.match(items[0]?.textContent ?? "", /10 runs: 10 completed/);
    const store = button(m.host, "Store eval now");
    await act(async () => {
      store.click(); // C8: a second click before React re-renders sends nothing
      store.click();
    });
    assert.ok(store.disabled);
    release();
    await flush();
    assert.deepEqual(stub.calls.filter((c) => c.op === "cycle_eval_run").map((c) => c.input), [{ workflowId: WF, version: 2 }]);
    assert.equal(stub.calls.filter((c) => c.op === "cycles_list").length, 2, "reloaded after storing");
    assert.match(m.host.querySelector(".timeline > li")?.textContent ?? "", /stored: pass/);
    assert.deepEqual(alerts(m.host), []);
    await click(button(m.host, "Hide versions"));
    assert.equal(m.host.querySelector(".timeline"), null);
    await m.unmount();
  });

  it("fires: a failed Store eval now shows a plain message and keeps the button usable", async () => {
    reset([]);
    stub.cycles = LIST();
    stub.fail.cycle_eval_run = { status: 404, code: "not_found" };
    const m = await mount(h(cyc.Cycles, {}));
    await click(button(m.host, "Show versions"));
    await click(button(m.host, "Store eval now"));
    await flush();
    assert.match(alerts(m.host)[0] ?? "", /The eval could not be stored/);
    assert.ok(!button(m.host, "Store eval now").disabled);
    await m.unmount();
  });

  it("C288 R8 quiet: each version says what the runners reported and how it compares with the previous version; no report says so", async () => {
    reset([]);
    stub.cycles = LIST();
    const m = await mount(h(cyc.Cycles, {}));
    await click(button(m.host, "Show versions"));
    const [v2, v1] = [...m.host.querySelectorAll(".timeline > li")];
    assert.match(v2?.textContent ?? "", /8 run reports with metrics: 75% reported as done well, typical time 12 min, average 14.5 min · 3 retries, 1 question to you, 2 lessons/);
    assert.match(v2?.textContent ?? "", /Compared with version 1: share reported as done well up 15 points, typical time 8 min shorter\./);
    assert.match(v1?.textContent ?? "", /5 run reports with metrics: 60% reported as done well, typical time 20 min/);
    assert.doesNotMatch(v1?.textContent ?? "", /Compared with/, "version 1 has no parent");
    assert.equal(cyc.compareText({ runMetrics: LIST()[1]?.runMetrics as never }, { version: 1, runMetrics: LIST()[0]?.runMetrics as never }), "Compared with version 1: share reported as done well down 15 points, typical time 8 min longer.");
    const TOO_FEW = "Too few reports to compare yet (needs 5 per version).";
    assert.equal(cyc.compareText(cycleOf(0), cycleOf(5)), TOO_FEW, "no numbers when one version has no reports");
    assert.equal(cyc.compareText(cycleOf(4), cycleOf(9)), TOO_FEW, "4 reports are under the floor");
    assert.equal(cyc.compareText(cycleOf(9), cycleOf(4)), TOO_FEW);
    assert.match(cyc.compareText(cycleOf(5), cycleOf(5)) ?? "", /^Compared with version 1: share reported as done well the same, typical time the same\.$/, "exactly 5 in both compares");
    assert.equal(cyc.compareText(cycleOf(0), cycleOf(0)), null, "nothing reported anywhere: nothing to say");
    assert.equal(cyc.compareText(cycleOf(9), null), null, "version 1 has no parent");
    assert.equal(cyc.metricsText(cycleOf(0).runMetrics), "No run reports with metrics yet.");
    assert.equal(cyc.minutesText(150), "2.5 h");
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("named metrics: each version lists them by name (underscores read as spaces) and compares typical values by name once both versions have 5 reports of that name", async () => {
    reset([]);
    const named = (name: string, reports: number, median: number) => ({ name, reports, median, mean: median + 0.5, min: median - 1, max: median + 4 });
    const list = LIST();
    (list[0] as { runMetrics: { namedMetrics: unknown[] } }).runMetrics.namedMetrics = [named("candidates_seen", 8, 15), named("shortlist_size", 8, 4), named("new_this_week", 2, 1)];
    (list[1] as { runMetrics: { namedMetrics: unknown[] } }).runMetrics.namedMetrics = [named("candidates_seen", 5, 12), named("shortlist_size", 3, 3)];
    stub.cycles = list;
    const m = await mount(h(cyc.Cycles, {}));
    await click(button(m.host, "Show versions"));
    const [v2, v1] = [...m.host.querySelectorAll(".timeline > li")];
    const text2 = v2?.textContent ?? "";
    assert.match(text2, /candidates seen: 8 reports, typical 15, average 15\.5, lowest 14, highest 19/);
    assert.match(text2, /candidates seen: typical 12 → 15/);
    assert.match(text2, /shortlist size: too few reports to compare yet \(needs 5 per version\)/);
    assert.match(text2, /new this week: too few reports to compare yet/, "a name only the new version has");
    assert.doesNotMatch(text2, /candidates_seen/, "never the raw name");
    assert.match(v1?.textContent ?? "", /candidates seen: 5 reports, typical 12/);
    assert.doesNotMatch(v1?.querySelector('[aria-label^="Named metrics compared"]')?.textContent ?? "", /./, "version 1 has no parent to compare with");
    assert.deepEqual(cyc.namedCompare(cycleOf(9), null), []);
    assert.equal(cyc.humanName("questions_to_martin"), "questions to martin");
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("C288 R8: Show lessons reads the lessons of that version (owner op) and shows them as plain text", async () => {
    reset([]);
    stub.cycles = LIST();
    stub.lessons = [
      { occurrence: "a".repeat(64), reportedAt: "2026-10-09T08:00:00.000Z", text: "Check the <b>calendar</b> first" },
      { occurrence: "b".repeat(64), reportedAt: "2026-10-08T08:00:00.000Z", text: "Ask once" },
    ];
    const m = await mount(h(cyc.Cycles, {}));
    await click(button(m.host, "Show versions"));
    assert.equal(m.host.querySelectorAll(".lessons").length, 0, "nothing is read before the owner asks");
    assert.equal(stub.calls.filter((c) => c.op === "cycle_get").length, 0);
    assert.equal([...m.host.querySelectorAll("button")].filter((b) => /Show lessons/.test(b.textContent ?? "")).length, 1, "only the version with lessons has the button");
    await click(button(m.host, "Show lessons (2)"));
    await flush();
    assert.deepEqual(stub.calls.filter((c) => c.op === "cycle_get").map((c) => c.input), [{ workflowId: WF, version: 2 }]);
    const items = [...m.host.querySelectorAll(".lessons > li")];
    assert.deepEqual(items.map((li) => li.textContent), ["Check the <b>calendar</b> first", "Ask once"]);
    assert.equal(m.host.querySelector(".lessons b"), null, "agent text is never markup");
    assert.match(m.host.textContent ?? "", /written by agents and shown to you only/);
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("C288 R8 fires: lessons that cannot be loaded show a plain message and the button stays", async () => {
    reset([]);
    stub.cycles = LIST();
    stub.fail.cycle_get = { status: 500, code: "internal_error" };
    const m = await mount(h(cyc.Cycles, {}));
    await click(button(m.host, "Show versions"));
    await click(button(m.host, "Show lessons (2)"));
    await flush();
    assert.match(alerts(m.host)[0] ?? "", /The lessons could not be loaded/);
    assert.ok(!button(m.host, "Show lessons (2)").disabled);
    await m.unmount();
  });

  it("RUL-14: a failed load is an error with Try again, not the empty state; Try again loads", async () => {
    reset([]);
    stub.cycles = LIST();
    stub.fail.cycles_list = { status: 500, code: "internal_error" };
    const m = await mount(h(cyc.Cycles, {}));
    assert.match(alerts(m.host)[0] ?? "", /Cycles could not be loaded/);
    assert.equal(m.host.querySelector(".tb-empty"), null, "no false empty state");
    stub.fail.cycles_list = undefined;
    await click(button(m.host, "Try again"));
    await flush();
    assert.deepEqual(alerts(m.host), []);
    assert.equal(tableRows(m.host).length, 2);
    await m.unmount();
  });

  it("empty: no promoted workflow says so", async () => {
    reset([]);
    const m = await mount(h(cyc.Cycles, {}));
    assert.equal(m.host.querySelector(".tb-empty h3")?.textContent, "No promoted workflows yet.");
    assert.deepEqual(alerts(m.host), []);
    await m.unmount();
  });

  it("trend, percent and duration helpers", () => {
    assert.equal(cyc.trendOf({ completedRatio: 0.9 }, { completedRatio: 0.8 }), "up");
    assert.equal(cyc.trendOf({ completedRatio: 0.7 }, { completedRatio: 0.8 }), "down");
    assert.equal(cyc.trendOf({ completedRatio: 0.8 }, { completedRatio: 0.8 }), "same");
    assert.equal(cyc.trendOf({ completedRatio: 0.8 }, null), "none");
    assert.equal(cyc.trendOf({ completedRatio: null }, { completedRatio: 0.8 }), "none");
    assert.equal(cyc.pct(0.666667), "67%");
    assert.equal(cyc.pct(null), "–");
    assert.deepEqual([cyc.duration(45 * 60_000), cyc.duration(5 * 3_600_000), cyc.duration(3 * 86_400_000)], ["45 min", "5 h", "3 days"]);
  });
});
