// The one-time move of 0.3.x agent workflows to the engine (C367 M3, ENGINE-BUILD §8). Called from `onStart` after the SQL
// migrations. Idempotent and resumable: the marker row `m3_from_0_3` says it is done (then it is a no-op); until then each
// start looks at every workflow and schedule again and does only what is not done.
//
//   workflow   every promoted version becomes a contract version (`contractOf`): one `ai` step by an agent card
//   schedule   Free target -> an engine schedule (same cron, time zone UTC, pinned to the migrated version); the 0.3.x schedule
//              is PAUSED, not deleted (rollback). Bound target -> stays on routines_*, recorded `legacy_bound`.
// Never touched: routine_runs (Cycles keeps them as legacy runs), workflows, workflow_versions, and every field of a
// schedule except `enabled`. Needs no Temporal: it writes the app's own rows; the engine's reconcile job creates the Temporal
// Schedule from the row. While the engine is off (no TEMPORAL_ADDRESS) schedules wait (`deferred`): pausing the old one
// then would stop the work.
import { nextCronTime } from "@opt2-tealbrick/manifest";
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import { validateContract } from "../engine/contract.ts";
import * as engine from "../engine/engine-store.ts";
import * as routines from "../routines.ts";
import * as store from "../store.ts";
import { contractOf, engineIdOf, MAX_INSTRUCTION, type Target } from "./contract.ts";
import { type Counts, countsOf, getItem, type Item, listItems, marker, putItem, writeMarker } from "./state.ts";

export interface MigrateOptions {
  /** TEMPORAL_ADDRESS is set: the engine will create the Temporal Schedules */
  engineConfigured: boolean;
  now?: number;
}
export type MigrateResult = { ran: false; reason: "already_done" } | { ran: true; counts: Counts; complete: boolean };

interface Automation {
  id: string;
  workflowId: string;
  versionPin: number | null;
  agentId: string;
  mode: "bound" | "free";
  cron: string;
  enabled: boolean;
  revision: number;
}

function automationsOf(db: Db, workflowId: string): Automation[] {
  return db
    .prepare("SELECT * FROM automations WHERE workflow_id = ? AND deleted_at IS NULL ORDER BY created_at, id")
    .all(workflowId)
    .map((r) => ({
      id: String(r.id),
      workflowId: String(r.workflow_id),
      versionPin: r.version_pin === null ? null : Number(r.version_pin),
      agentId: String(r.agent_id),
      mode: r.target_mode === "free" ? "free" : "bound",
      cron: String(r.cron),
      enabled: Number(r.enabled) === 1,
      revision: Number(r.revision),
    }));
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Looks at every workflow and schedule once more and does what is not done. Safe to call at every start. */
export function migrate(db: Db, opts: MigrateOptions): MigrateResult {
  if (marker(db)) return { ran: false, reason: "already_done" };
  const now = opts.now ?? Date.now();
  for (const wf of store.listWorkflows(db)) {
    try {
      moveWorkflow(db, wf, opts, now);
    } catch (e) {
      // a surprise (not a refusal below) must not stop the others; nothing of this workflow was kept (one transaction)
      putItem(db, { kind: "workflow", legacyId: wf.id, engineId: null, status: "failed", reason: errText(e), versions: null }, now);
    }
  }
  const items = listItems(db);
  const counts = countsOf(items);
  const complete = counts.deferred === 0;
  if (complete) writeMarker(db, counts, now);
  return { ran: true, counts, complete };
}

function moveWorkflow(db: Db, wf: store.Workflow, opts: MigrateOptions, now: number): void {
  const schedules = automationsOf(db, wf.id);
  // Agent steps go to Free agents only. The first Free schedule names the agent; a Free schedule of ANOTHER agent cannot share
  // the contract (one agent per step), so it stays on routines_*.
  const free = schedules.filter((s) => s.mode === "free");
  const primary = free[0] ?? null;
  const target: Target = { agentId: primary?.agentId ?? null, cron: primary?.cron ?? null };
  const engineId = engineIdOf(wf.id);

  db.transaction(() => {
    // ── 1. the versions ──
    const problems: string[] = [];
    let saved = 0;
    for (const v of store.listVersions(db, wf.id)) {
      const c = contractOf(wf.id, v, target);
      const step = c.steps[0];
      if (step?.type === "ai" && step.instruction.length > MAX_INSTRUCTION) {
        problems.push(`v${v.version}: the instruction and steps are ${step.instruction.length} characters, the engine allows ${MAX_INSTRUCTION}`);
        continue;
      }
      const check = validateContract(c);
      if (!check.ok) {
        problems.push(`v${v.version}: ${check.errors[0]?.message ?? "not valid"}`);
        continue;
      }
      try {
        engine.saveDefinition(db, c, now);
        saved++;
      } catch (e) {
        problems.push(`v${v.version}: ${errText(e)}`);
      }
    }
    const status = saved > 0 ? "migrated" : "failed";
    putItem(db, { kind: "workflow", legacyId: wf.id, engineId: saved > 0 ? engineId : null, status, reason: problems.length ? problems.join("; ").slice(0, 400) : null, versions: saved }, now);

    // ── 2. the schedules ──
    for (const s of schedules) {
      const prior = getItem(db, "schedule", s.id);
      if (prior && (prior.status === "migrated" || prior.status === "legacy_bound")) continue;
      if (s.mode === "bound") {
        putItem(db, { kind: "schedule", legacyId: s.id, engineId: null, status: "legacy_bound", reason: "A Bound agent keeps its schedule on routines_*: agent steps go to Free agents only.", versions: null }, now);
        continue;
      }
      if (s.agentId !== target.agentId) {
        putItem(db, { kind: "schedule", legacyId: s.id, engineId: null, status: "skipped", reason: "other_agent: a workflow has one agent in the engine; this schedule names another Free agent and stays on routines_*.", versions: null }, now);
        continue;
      }
      if (saved === 0) {
        putItem(db, { kind: "schedule", legacyId: s.id, engineId: null, status: "failed", reason: `The workflow could not be moved (${problems[0] ?? "no version"}), so the schedule stays on routines_*.`, versions: null }, now);
        continue;
      }
      if (!opts.engineConfigured) {
        putItem(db, { kind: "schedule", legacyId: s.id, engineId: null, status: "deferred", reason: "engine_off: the workflow engine (Temporal) is not configured; the schedule moves when it is.", versions: null }, now);
        continue;
      }
      moveSchedule(db, wf, s, engineId, now);
    }
  });
}

function moveSchedule(db: Db, wf: store.Workflow, s: Automation, engineWorkflowId: string, now: number): void {
  const pin = s.versionPin ?? wf.activeVersion;
  try {
    nextCronTime(s.cron, now, { tz: "UTC" });
  } catch (e) {
    putItem(db, { kind: "schedule", legacyId: s.id, engineId: null, status: "failed", reason: `The cron "${s.cron}" is not accepted by the engine: ${errText(e)}`, versions: null }, now);
    return;
  }
  if (!engine.getDefinition(db, engineWorkflowId, pin)) {
    putItem(db, { kind: "schedule", legacyId: s.id, engineId: null, status: "failed", reason: `Version ${pin} of the workflow was not moved, so the schedule stays on routines_*.`, versions: null }, now);
    return;
  }
  // An agent step calls no app, so there is nothing for the owner to approve: the versions the schedules need are activated
  // with no operations. (The agent acts with its own grant; that is stated on every agent step.)
  if (pin !== wf.activeVersion) engine.activate(db, engineWorkflowId, pin, [], now);
  if (engine.getDefinition(db, engineWorkflowId, wf.activeVersion)) engine.activate(db, engineWorkflowId, wf.activeVersion, [], now);
  const id = engine.newScheduleId(now);
  const row = engine.insertSchedule(db, { id, workflowId: engineWorkflowId, versionPin: pin, kind: "schedule", spec: { cron: s.cron, timezone: "UTC" }, input: {}, poll: null, overlap: "skip", paused: !s.enabled }, now);
  // rollback stays possible: the 0.3.x schedule is paused, never deleted; its runs and history stay
  if (s.enabled) routines.pauseAutomation(db, s.id, s.revision, true, now);
  putItem(db, { kind: "schedule", legacyId: s.id, engineId: row.id, status: "migrated", reason: null, versions: null }, now);
}

export type { Item };
