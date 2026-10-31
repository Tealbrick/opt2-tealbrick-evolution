// The filter of the long lists of the owner UI (C382 batch 4): Runs, Suggestions, Workflows, Cycles (and engine versions),
// engine schedules and 0.3.x agent schedules. A filter never hides that it is on, a paged list says that the text filter
// read only the loaded rows (and keeps Show older in reach), suggestions that wait for a review and the filter hides are
// counted. The pages are compiled with the build tsconfig into a folder of their own and rendered in happy-dom against a stub server.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import type { ReactElement } from "react";

type RunsUi = typeof import("../src/ui/Runs.tsx");
type SuggestionsUi = typeof import("../src/ui/Suggestions.tsx");
type WorkflowsUi = typeof import("../src/ui/Workflows.tsx");
type CyclesUi = typeof import("../src/ui/Cycles.tsx");
type EngineCyclesUi = typeof import("../src/ui/EngineCycles.tsx");
type EngineSchedulesUi = typeof import("../src/ui/EngineSchedules.tsx");
type SchedulesUi = typeof import("../src/ui/Schedules.tsx");

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist", "ui-test-lists-filter");

const win = new Window({ url: "http://localhost/a/evolution/", width: 1280, height: 860 });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "navigator", "location", "history", "sessionStorage", "localStorage", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLDialogElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "MutationObserver"]) {
  const v = (win as unknown as Record<string, unknown>)[k];
  if (v === undefined) continue;
  try {
    g[k] = v;
  } catch {
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
}
g.IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (input: Record<string, unknown>) => unknown | Promise<unknown>;
const stub = { calls: [] as { op: string; input: Record<string, unknown> }[], handlers: {} as Record<string, Handler> };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const path = url.pathname.replace("/a/evolution/tb/v1/", "");
  if (path === "session") return json(200, { principal: { type: "person", id: "per_1", instance: "ins_1" }, csrf: "csrf-token", idempotencyRequired: [] });
  const op = /^ops\/(.+)$/.exec(path)?.[1];
  if (!op) return json(404, { error: { code: "not_found", message: "not found" } });
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: Record<string, unknown> };
  stub.calls.push({ op, input: body.input ?? {} });
  const handler = stub.handlers[op];
  if (!handler) return json(404, { error: { code: "not_found", message: op } });
  return json(200, { status: "ok", output: await handler(body.input ?? {}) });
}) as typeof fetch;

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
afterEach(async () => {
  for (const m of open.splice(0)) await m.unmount();
});
const click = async (el: Element) => {
  await act(async () => (el as HTMLElement).click());
  await flush();
};
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  });
};
const buttons = (host: Element, label: string) => [...host.querySelectorAll("button")].filter((b) => b.textContent?.trim() === label);
const input = (host: Element) => host.querySelector("input") as HTMLInputElement;
const text = (host: Element) => (host.textContent ?? "").replace(/\s+/g, " ");
const alertText = (host: Element) => [...host.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(" ");
const KEY = "tb-filter:evolution:";
const remember = (screen: string, v: string) => localStorage.setItem(`${KEY}${screen}`, v);
const callsOf = (op: string) => stub.calls.filter((c) => c.op === op).map((c) => c.input);

const reset = () => {
  localStorage.clear();
  stub.calls = [];
  stub.handlers = {
    migration_status: () => ({ done: true, doneAt: "2026-10-26T10:00:00.000Z", counts: { workflowsMigrated: 0, workflowsFailed: 0, schedulesMigrated: 0, schedulesLegacyBound: 0, schedulesSkipped: 0, schedulesFailed: 0, deferred: 0 }, items: [] }),
    workflow_contracts_list: () => ({ contracts: [] }),
    engine_runs_list: () => ({ runs: [] }),
    schedules_list: () => ({ schedules: [], temporalConnected: true }),
    automations_list: () => ({ automations: [], kanbanLinked: false }),
    workflows_list: () => ({ workflows: [] }),
    cycles_list: () => ({ cycles: [] }),
    detector_status: () => ({ lastScanAt: null, intervalMinutes: 30 }),
  };
};

let runs: RunsUi;
let sugg: SuggestionsUi;
let wfs: WorkflowsUi;
let cyc: CyclesUi;
let engineCyc: EngineCyclesUi;
let engineSched: EngineSchedulesUi;
let sched: SchedulesUi;
before(() => {
  const tsc = spawnSync(join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json", "--outDir", outDir], { cwd: root, encoding: "utf8" });
  assert.equal(tsc.status, 0, `${tsc.stdout}${tsc.stderr}`);
});
before(async () => {
  const at = (f: string) => import(pathToFileURL(join(outDir, "ui", f)).href);
  runs = (await at("Runs.js")) as RunsUi;
  sugg = (await at("Suggestions.js")) as SuggestionsUi;
  wfs = (await at("Workflows.js")) as WorkflowsUi;
  cyc = (await at("Cycles.js")) as CyclesUi;
  engineCyc = (await at("EngineCycles.js")) as EngineCyclesUi;
  engineSched = (await at("EngineSchedules.js")) as EngineSchedulesUi;
  sched = (await at("Schedules.js")) as SchedulesUi;
});
after(() => rmSync(outDir, { recursive: true, force: true }));

// ── Runs ────────────────────────────────────────────────────────────────────
const run = (n: number, workflowId = "wf-a", status = "completed") => ({
  workflowId,
  runId: `run_${workflowId}_${n}`,
  version: 1,
  scheduleId: null,
  temporalWorkflowId: `evo:${workflowId}:${n}`,
  temporalRunId: null,
  triggerKind: "schedule",
  status,
  startedAt: new Date(Date.UTC(2026, 9, 26, 5, 0) - n * 60_000).toISOString(),
  endedAt: new Date(Date.UTC(2026, 9, 26, 5, 1) - n * 60_000).toISOString(),
  durationMs: 60_000,
  errorCode: null,
  errorStep: null,
  skippedReason: null,
  stepsDone: 1,
  stepsFailed: 0,
  heldWaits: 0,
  heldWaitMs: 0,
  modelTokens: 0,
  outputBytes: null,
  source: "activity",
});
const TITLES = [
  { workflowId: "wf-a", version: 1, title: "Alpha digest", createdAt: "2026-10-01T00:00:00.000Z", state: "active" },
  { workflowId: "wf-b", version: 1, title: "Beta report", createdAt: "2026-10-01T00:00:00.000Z", state: "active" },
];
const mountRuns = () => mount(h(runs.Runs, { agents: [] as never, openId: null, holdHref: (id: string) => `./holds/${id}` }));
const runDetail = () => ({ run: run(0), steps: [], outputs: null });

describe("Runs filter", () => {
  const setup = (rows: ReturnType<typeof run>[]) => {
    reset();
    stub.handlers.workflow_contracts_list = () => ({ contracts: TITLES });
    stub.handlers.engine_runs_list = (i) => ({ runs: rows.filter((r) => !i.workflowId || r.workflowId === i.workflowId).slice(0, Number(i.limit ?? 100)) });
    stub.handlers.engine_run_get = runDetail;
    stub.handlers.agent_steps_list = () => ({ steps: [] });
  };

  it("a short list shows no filter bar", async () => {
    setup([run(1), run(2), run(3)]);
    const m = await mountRuns();
    assert.equal(m.host.querySelectorAll(".pane-item").length, 3);
    assert.equal(input(m.host), null);
  });

  it("a long list: text filter shows N of M and Clear brings every run back", async () => {
    setup(Array.from({ length: 10 }, (_, i) => run(i, i % 2 ? "wf-a" : "wf-b", i === 4 ? "failed" : "completed")));
    const m = await mountRuns();
    assert.equal(m.host.querySelectorAll(".pane-item").length, 10);
    await type(input(m.host), "failed");
    assert.equal(m.host.querySelectorAll(".pane-item").length, 1);
    assert.match(text(m.host), /Showing 1 of 10 runs\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll(".pane-item").length, 10);
    assert.equal(input(m.host).value, "");
    assert.equal(buttons(m.host, "Clear filter").length, 0);
  });

  it("a remembered filter is on after a reload: the bar shows the text and N of M even for a short list", async () => {
    setup([run(1), run(2), run(3, "wf-b")]);
    remember("runs", "Beta");
    const m = await mountRuns();
    assert.equal(input(m.host).value, "Beta");
    assert.equal(m.host.querySelectorAll(".pane-item").length, 1);
    assert.match(text(m.host), /Showing 1 of 3 runs\./);
  });

  it("a paged list: no match says the filter read only the loaded runs, Show older is in reach and then reads more", async () => {
    setup(Array.from({ length: 150 }, (_, i) => run(i, "wf-a")).concat(run(999, "wf-a", "failed")));
    remember("runs", "failed");
    const m = await mountRuns();
    assert.equal(m.host.querySelectorAll(".pane-item").length, 0);
    assert.match(text(m.host), /No loaded run matches\./);
    assert.match(text(m.host), /The filter searches only the 100 runs loaded so far\./);
    assert.match(text(m.host), /Showing 0 of 100 loaded runs\./);
    assert.ok(buttons(m.host, "Show older").length >= 1, "Show older is in reach");
    await click(buttons(m.host, "Show older")[0] as Element);
    assert.deepEqual(callsOf("engine_runs_list").at(-1), { limit: 200 });
    assert.equal(m.host.querySelectorAll(".pane-item").length, 1, "the older run is found");
    assert.match(text(m.host), /Showing 1 of 151 runs\./);
    assert.doesNotMatch(text(m.host), /loaded so far/, "everything the engine holds is loaded");
  });

  it("a paged list with no filter on still has a Show older button", async () => {
    setup(Array.from({ length: 150 }, (_, i) => run(i, "wf-a")));
    const m = await mountRuns();
    assert.equal(m.host.querySelectorAll(".pane-item").length, 100);
    await click(buttons(m.host, "Show older")[0] as Element);
    assert.equal(m.host.querySelectorAll(".pane-item").length, 150);
    assert.equal(buttons(m.host, "Show older").length, 0);
  });

  it("a complete list with no match says all runs were searched", async () => {
    setup([run(1), run(2), run(3)]);
    remember("runs", "zzz");
    const m = await mountRuns();
    assert.match(text(m.host), /No run matches\. The filter searched all 3 runs\./);
    assert.doesNotMatch(text(m.host), /Show older/);
  });

  it("the workflow is the server's filter: the call carries workflowId and the count is not a search of loaded rows", async () => {
    setup(Array.from({ length: 120 }, (_, i) => run(i, i < 20 ? "wf-b" : "wf-a")));
    remember("runs:workflow", "wf-b");
    const m = await mountRuns();
    assert.deepEqual(callsOf("engine_runs_list")[0], { limit: 100, workflowId: "wf-b" });
    assert.equal(m.host.querySelectorAll(".pane-item").length, 20);
    assert.match(text(m.host), /Showing 20 of 20 runs\./);
    assert.doesNotMatch(text(m.host), /loaded so far/);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(localStorage.getItem(`${KEY}runs:workflow`), "");
    assert.deepEqual(callsOf("engine_runs_list").at(-1), { limit: 100 });
  });

  it("choosing workflow A and then B quickly ends on B's runs even when A answers last (no Loading forever)", async () => {
    setup(Array.from({ length: 10 }, (_, i) => run(i, i < 5 ? "wf-a" : "wf-b")));
    const all = Array.from({ length: 10 }, (_, i) => run(i, i < 5 ? "wf-a" : "wf-b"));
    stub.handlers.engine_runs_list = async (i) => {
      if (i.workflowId === "wf-a") await new Promise((r) => setTimeout(r, 120));
      return { runs: all.filter((r) => !i.workflowId || r.workflowId === i.workflowId) };
    };
    const m = await mountRuns();
    const pick = async (label: string) => {
      const trigger = m.host.querySelector('[role="combobox"][aria-label="Workflow"]') as Element;
      await click(trigger);
      const opt = [...m.host.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(label));
      assert.ok(opt, `option ${label}`);
      await click(opt);
    };
    await pick("Alpha digest");
    await pick("Beta report");
    await act(async () => new Promise((r) => setTimeout(r, 250)));
    await flush();
    assert.equal(m.host.querySelectorAll(".pane-item").length, 5);
    assert.ok([...m.host.querySelectorAll(".pane-item")].every((b) => /Beta report/.test(b.textContent ?? "")), "B's runs, not A's");
    assert.doesNotMatch(text(m.host), /Loading\./);
  });

  it("the status chip is a filter too: the bar counts it and Clear resets it", async () => {
    setup(Array.from({ length: 9 }, (_, i) => run(i, "wf-a", i === 2 ? "failed" : "completed")));
    const m = await mountRuns();
    await click(buttons(m.host, "Needs attention")[0] as Element);
    assert.match(text(m.host), /Showing 1 of 9 runs\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll(".pane-item").length, 9);
  });
});

// ── Suggestions ─────────────────────────────────────────────────────────────
const suggestion = (n: number, status = "open") => ({
  id: `sug_${n}`,
  title: `Suggestion number ${n}`,
  source: n % 2 ? "detector" : "agent",
  status,
  agentId: null,
  evidenceCount: 3,
  createdAt: "2026-10-20T08:00:00.000Z",
});
const mountSuggestions = () => mount(h(sugg.Suggestions, { names: (id: string | null) => id ?? "", onDraft: () => {}, onOpenCount: () => {} }));

describe("Suggestions filter", () => {
  const setup = (rows: ReturnType<typeof suggestion>[]) => {
    reset();
    stub.handlers.review_suggestions = (i) => ({ suggestions: rows.filter((s) => !i.status || s.status === i.status).slice(0, Number(i.limit ?? 100)) });
  };

  it("a short list shows no filter bar", async () => {
    setup([suggestion(1), suggestion(2)]);
    const m = await mountSuggestions();
    assert.equal(m.host.querySelectorAll(".item").length, 2);
    assert.equal(m.host.querySelector("input"), null);
  });

  it("a long list: the filter shows N of M, counts the suggestions that wait for a review and it hides, keeps Review per row, Clear restores", async () => {
    setup(Array.from({ length: 10 }, (_, i) => suggestion(i)));
    const m = await mountSuggestions();
    assert.equal(m.host.querySelectorAll(".item").length, 10);
    assert.doesNotMatch(text(m.host), /hidden by the filter/);
    await type(input(m.host), "number 7");
    assert.equal(m.host.querySelectorAll(".item").length, 1);
    assert.match(text(m.host), /Showing 1 of 10 suggestions\./);
    assert.match(alertText(m.host), /9 suggestions that wait for your review are hidden by the filter\./);
    assert.equal(buttons(m.host.querySelector(".item") as Element, "Review").length, 1, "Review stays per row");
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll(".item").length, 10);
    assert.doesNotMatch(text(m.host), /hidden by the filter/);
  });

  it("a remembered filter shows after a reload with its count", async () => {
    setup([suggestion(1), suggestion(2), suggestion(3)]);
    remember("suggestions", "number 2");
    const m = await mountSuggestions();
    assert.equal(input(m.host).value, "number 2");
    assert.match(text(m.host), /Showing 1 of 3 suggestions\./);
    assert.match(alertText(m.host), /2 suggestions that wait for your review are hidden by the filter\./);
  });

  it("a paged list: no match says only the loaded suggestions were read and Show older reads more", async () => {
    setup(Array.from({ length: 150 }, (_, i) => suggestion(i)).concat(suggestion(999)));
    remember("suggestions", "number 999");
    const m = await mountSuggestions();
    assert.equal(m.host.querySelectorAll(".item").length, 0);
    assert.match(text(m.host), /No loaded suggestion matches\./);
    assert.match(text(m.host), /The filter searches only the 100 suggestions loaded so far\./);
    assert.match(alertText(m.host), /100 suggestions that wait for your review are hidden by the filter\./);
    await click(buttons(m.host, "Show older")[0] as Element);
    assert.deepEqual(callsOf("review_suggestions").at(-1), { status: "open", limit: 200 });
    assert.equal(m.host.querySelectorAll(".item").length, 1);
    assert.doesNotMatch(text(m.host), /loaded so far/);
  });

  it("choosing a status chip and then another quickly ends on the last one even when the first answers last", async () => {
    const rows = [...Array.from({ length: 3 }, (_, i) => suggestion(i, "rejected")), ...Array.from({ length: 2 }, (_, i) => suggestion(10 + i, "approved"))];
    reset();
    stub.handlers.review_suggestions = async (i) => {
      if (i.status === "rejected") await new Promise((r) => setTimeout(r, 120));
      return { suggestions: rows.filter((s) => !i.status || s.status === i.status) };
    };
    const m = await mountSuggestions();
    await click(buttons(m.host, "Rejected")[0] as Element);
    await click(buttons(m.host, "Approved")[0] as Element);
    await act(async () => new Promise((r) => setTimeout(r, 250)));
    await flush();
    assert.equal(m.host.querySelectorAll(".item").length, 2);
    assert.ok([...m.host.querySelectorAll(".item")].every((x) => /Approved/.test(x.textContent ?? "")), "the approved suggestions, not the rejected ones");
  });

  it("a paged list with no filter on still has a Show older button", async () => {
    setup(Array.from({ length: 150 }, (_, i) => suggestion(i)));
    const m = await mountSuggestions();
    assert.equal(m.host.querySelectorAll(".item").length, 100);
    await click(buttons(m.host, "Show older")[0] as Element);
    assert.equal(m.host.querySelectorAll(".item").length, 150);
    assert.equal(buttons(m.host, "Show older").length, 0);
  });

  it("a complete list with no match says all suggestions were searched", async () => {
    setup([suggestion(1), suggestion(2)]);
    remember("suggestions", "zzz");
    const m = await mountSuggestions();
    assert.match(text(m.host), /No suggestion matches\. The filter searched all 2 suggestions\./);
  });
});

// ── Workflows ───────────────────────────────────────────────────────────────
const workflow = (n: number) => ({ id: `wf-${n}`, title: `Workflow ${n}`, summary: `Summary ${n}`, activeVersion: 1, draftId: `drf_${n}`, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" });

describe("Workflows filter", () => {
  const setup = (n: number) => {
    reset();
    stub.handlers.workflows_list = () => ({ workflows: Array.from({ length: n }, (_, i) => workflow(i)) });
    stub.handlers.workflow_versions = (i) => ({ workflow: workflow(Number(String(i.workflowId).slice(3))), versions: [] });
  };
  const items = (host: Element) => host.querySelectorAll("nav.pane-list .pane-item");

  it("a short list shows no filter bar", async () => {
    setup(3);
    const m = await mount(h(wfs.Workflows, { openId: null, stills: "" }));
    assert.equal(items(m.host).length, 3);
    assert.equal(input(m.host), null);
  });

  it("a long list: filter shows N of M, Clear restores, a remembered filter shows after a reload", async () => {
    setup(10);
    const m = await mount(h(wfs.Workflows, { openId: null, stills: "" }));
    await type(input(m.host), "Workflow 3");
    assert.equal(items(m.host).length, 1);
    assert.match(text(m.host), /Showing 1 of 10 workflows\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(items(m.host).length, 10);
    await m.unmount();
    remember("workflows", "Workflow 4");
    const again = await mount(h(wfs.Workflows, { openId: null, stills: "" }));
    assert.equal(input(again.host).value, "Workflow 4");
    assert.match(text(again.host), /Showing 1 of 10 workflows\./);
  });

  it("no match: the notice says all workflows were searched (the list is not paged)", async () => {
    setup(10);
    remember("workflows", "zzz");
    const m = await mount(h(wfs.Workflows, { openId: null, stills: "" }));
    assert.match(text(m.host), /No workflow matches\. The filter searched all 10 workflows\./);
    assert.doesNotMatch(text(m.host), /loaded so far/);
  });
});

// ── Cycles ──────────────────────────────────────────────────────────────────
const cycle = (n: number) => ({
  declaredMetrics: null,
  workflowId: `wf-${n}`,
  workflowTitle: `Cycle workflow ${n}`,
  version: 1,
  parentVersion: null,
  promotedAt: "2026-10-01T08:00:00.000Z",
  retiredAt: null,
  active: true,
  suggestionId: null,
  evidenceCount: 0,
  approvalDelayMs: null,
  draftRevisions: 1,
  widensAccess: false,
  counts: { total: 10, completed: 10, failed: 0, uncertain: 0, missed: 0, policyStale: 0, open: 0 },
  completedRatio: 1,
  uncertainRatio: 0,
  failedRatio: 0,
  missedRatio: 0,
  claimLatencyP50Ms: 1,
  durationP50Ms: 1,
  kanbanClosedRatio: 1,
  duplicateClaims: 0,
  last10: ["completed"],
  runMetrics: { runs: 0, okRuns: 0, okRatio: null, minutesMedian: null, minutesMean: null, retriesTotal: 0, questionsToMartinTotal: 0, lessonCount: 0, namedMetrics: [] },
  evalLive: { verdict: "pass", results: [] },
  evalStored: null,
});
const rowsOf = (host: Element) => host.querySelectorAll("table.cycles tbody > tr:not(.cycle-detail)");

describe("Cycles filter", () => {
  const setup = (n: number) => {
    reset();
    stub.handlers.cycles_list = () => ({ cycles: Array.from({ length: n }, (_, i) => cycle(i)) });
  };

  it("a short table shows no filter bar", async () => {
    setup(3);
    const m = await mount(h(cyc.Cycles, {}));
    assert.equal(rowsOf(m.host).length, 3);
    assert.equal(input(m.host), null);
  });

  it("a long table: filter shows N of M, Clear restores, remembered after a reload, no match says all were searched", async () => {
    setup(10);
    const m = await mount(h(cyc.Cycles, {}));
    await type(input(m.host), "workflow 5");
    assert.equal(rowsOf(m.host).length, 1);
    assert.match(text(m.host), /Showing 1 of 10 workflows\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(rowsOf(m.host).length, 10);
    await m.unmount();
    remember("cycles", "zzz");
    const again = await mount(h(cyc.Cycles, {}));
    assert.equal(input(again.host).value, "zzz");
    assert.match(text(again.host), /No workflow matches\. The filter searched all 10 workflows\./);
  });
});

describe("Engine versions table filter", () => {
  it("a long table is filtered with N of M, and says the rows come from the newest engine runs when the engine gave the most it gives", async () => {
    reset();
    stub.handlers.engine_runs_list = () => ({ runs: Array.from({ length: 10 }, (_, i) => run(i, `wf-${i}`)) });
    const m = await mount(h(engineCyc.EngineCycles, { cycles: [] }));
    assert.equal(m.host.querySelectorAll("tbody tr").length, 10);
    await type(input(m.host), "wf-3");
    assert.equal(m.host.querySelectorAll("tbody tr").length, 1);
    assert.match(text(m.host), /Showing 1 of 10 versions\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll("tbody tr").length, 10);
    await m.unmount();
    stub.handlers.engine_runs_list = () => ({ runs: Array.from({ length: 200 }, (_, i) => run(i, `wf-${i % 12}`)) });
    remember("cycles:engine", "zzz");
    const full = await mount(h(engineCyc.EngineCycles, { cycles: [] }));
    assert.match(text(full.host), /The filter searches only the 12 versions this page holds\./);
  });
});

// ── Schedules ───────────────────────────────────────────────────────────────
const engineSchedule = (n: number) => ({
  id: `sch_${n}`,
  workflowId: `wf-${n}`,
  versionPin: null,
  kind: "schedule",
  cron: "0 8 * * *",
  every: null,
  timezone: "UTC",
  input: {},
  poll: null,
  overlap: "skip",
  paused: false,
  revision: 1,
  cursor: null,
  cursorAt: null,
  temporalState: "synced",
  temporalError: null,
  createdAt: "2026-10-20T01:00:00.000Z",
  updatedAt: "2026-10-25T01:00:00.000Z",
  live: null,
});
const automation = (n: number) => ({
  id: `aut_${n}`,
  workflowId: `wf-${n}`,
  workflowTitle: `Agent schedule ${n}`,
  versionPin: null,
  policyVersion: 1,
  agentId: "agt_1",
  targetMode: "bound",
  cron: "0 8 * * *",
  enabled: true,
  misfireGraceSec: 120,
  kanbanProject: null,
  revision: 1,
  nextDueAt: "2026-10-13T08:00:00.000Z",
  effectiveNextDueAt: "2026-10-13T08:00:00.000Z",
  missedSince: null,
  createdAt: "2026-10-12T06:00:00.000Z",
  updatedAt: "2026-10-12T06:00:00.000Z",
  warnings: [],
});

describe("Schedules filter", () => {
  it("engine schedules: a short list shows no bar; a long list filters with N of M; Clear restores; remembered after a reload", async () => {
    reset();
    stub.handlers.schedules_list = () => ({ schedules: Array.from({ length: 3 }, (_, i) => engineSchedule(i)), temporalConnected: true });
    const small = await mount(h(engineSched.EngineSchedules, {}));
    assert.equal(input(small.host), null);
    await small.unmount();
    stub.handlers.schedules_list = () => ({ schedules: Array.from({ length: 10 }, (_, i) => engineSchedule(i)), temporalConnected: true });
    const m = await mount(h(engineSched.EngineSchedules, {}));
    assert.equal(m.host.querySelectorAll("article").length, 10);
    await type(input(m.host), "wf-7");
    assert.equal(m.host.querySelectorAll("article").length, 1);
    assert.match(text(m.host), /Showing 1 of 10 schedules\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll("article").length, 10);
    await m.unmount();
    remember("schedules:engine", "zzz");
    const again = await mount(h(engineSched.EngineSchedules, {}));
    assert.equal(input(again.host).value, "zzz");
    assert.match(text(again.host), /No schedule matches\. The filter searched all 10 schedules\./);
  });

  it("agent schedules: a long list filters with N of M, Clear restores, remembered after a reload, no match says all were searched", async () => {
    reset();
    stub.handlers.automations_list = () => ({ automations: Array.from({ length: 10 }, (_, i) => automation(i)), kanbanLinked: false });
    stub.handlers.workflows_list = () => ({ workflows: [] });
    const m = await mount(h(sched.Schedules, { agents: [] as never, agentsLoading: false }));
    assert.equal(m.host.querySelectorAll("article").length, 10);
    await type(input(m.host), "schedule 4");
    assert.equal(m.host.querySelectorAll("article").length, 1);
    assert.match(text(m.host), /Showing 1 of 10 schedules\./);
    await click(buttons(m.host, "Clear filter")[0] as Element);
    assert.equal(m.host.querySelectorAll("article").length, 10);
    await m.unmount();
    remember("schedules", "zzz");
    const again = await mount(h(sched.Schedules, { agents: [] as never, agentsLoading: false }));
    assert.equal(input(again.host).value, "zzz");
    assert.match(text(again.host), /No schedule matches\. The filter searched all 10 schedules\./);
  });
});
