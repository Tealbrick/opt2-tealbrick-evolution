// `model_role_optional` (spec MODEL_ROLE_ATTENTION): an OPTIONAL model role is unset and the app runs with less. The SDK raises
// only `model_role_missing` for REQUIRED roles (and needs_keys); it never raises `model_role_optional` by itself, the APP reports it.
// Core's update gate needs readiness `ok` to stay `ok`, so Evolving Workflows raises it ONLY when it matters: an ACTIVE workflow
// version uses that role in an `ai` step and the role is not bound. An install that never uses a role is not degraded by it.
import type { Db } from "@opt2-tealbrick/miniapp-sdk";
import type { AppAttention } from "@opt2-tealbrick/spec/sdk";
import { walkSteps } from "./contract.ts";
import * as store from "./engine-store.ts";
import { MODEL_ROLES_CAP } from "./models.ts";

export const MODEL_ROLE_OPTIONAL = "model_role_optional";
export const REFRESH_MS = 60_000;

/** role -> the titles of the ACTIVE workflow versions whose `ai` steps use it by role (agent cards need no model role). */
export function usedRoles(db: Db): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db.prepare("SELECT workflow_id, version FROM engine_activations WHERE state = 'active' ORDER BY workflow_id").all();
  for (const r of rows) {
    const def = store.getDefinition(db, String(r.workflow_id), Number(r.version));
    if (!def) continue;
    walkSteps(def.contract.steps, (s) => {
      if (s.type !== "ai" || !("role" in s.by)) return;
      const list = out.get(s.by.role) ?? [];
      if (!list.includes(def.title)) list.push(def.title);
      out.set(s.by.role, list);
    });
  }
  return out;
}

export interface RoleAttentionDeps {
  db: Db;
  /** the SDK's `modelRole` (null = unset); a throw (paused, role not declared) says nothing about the owner's setup */
  modelRole: (role: string) => Promise<unknown | null>;
  /** `ctx.bridgeCaps()` */
  bridgeCaps: () => readonly string[];
  /** the status push, when the answer changes */
  onChange?: () => void;
  ttlMs?: number;
  now?: () => number;
}

export interface RoleAttention {
  /** synchronous, from the last refresh (the SDK reads attention() with a 1 s timeout); a stale answer starts a refresh */
  attention(): AppAttention | null;
  refresh(): Promise<void>;
  /** refreshes every `ttlMs`; returns the stop function */
  watch(): () => void;
}

const reasonOf = (role: string, titles: string[]): string => {
  const names = titles.slice(0, 2).join(", ") + (titles.length > 2 ? ` and ${titles.length - 2} more` : "");
  return `${titles.length > 1 ? "Workflows" : "Workflow"} ${names} ${titles.length > 1 ? "use" : "uses"} the model role ${role}, which is not set. Set it on the Keys and models page.`.slice(0, 200);
};

export function createRoleAttention(deps: RoleAttentionDeps): RoleAttention {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? REFRESH_MS;
  let unbound: Map<string, string[]> = new Map();
  let checkedAt = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  const signature = (): string => JSON.stringify([...unbound.entries()].sort());

  const refresh = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const before = signature();
        const next = new Map<string, string[]>();
        const capped = deps.bridgeCaps().includes(MODEL_ROLES_CAP);
        for (const [role, titles] of usedRoles(deps.db)) {
          if (!capped) {
            next.set(role, titles); // a bridge without model roles binds nothing
            continue;
          }
          try {
            if ((await deps.modelRole(role)) === null) next.set(role, titles);
          } catch {
            // paused, or a role the manifest does not declare: not a statement about the owner's setup
          }
        }
        unbound = next;
        checkedAt = now();
        if (signature() !== before) deps.onChange?.();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  };

  return {
    refresh,
    attention() {
      if (now() - checkedAt >= ttl) void refresh().catch(() => undefined);
      const first = [...unbound.entries()].sort(([a], [b]) => (a < b ? -1 : 1))[0];
      return first ? { code: MODEL_ROLE_OPTIONAL, reason: reasonOf(first[0], first[1]) } : null;
    },
    watch() {
      void refresh().catch(() => undefined);
      const timer = setInterval(() => void refresh().catch(() => undefined), ttl);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}

let shared: RoleAttention | null = null;
let stopWatch: (() => void) | null = null;

/** onStart: begin to watch. */
export function startRoleAttention(deps: RoleAttentionDeps): void {
  stopRoleAttention();
  shared = createRoleAttention(deps);
  stopWatch = shared.watch();
}
export function stopRoleAttention(): void {
  stopWatch?.();
  stopWatch = null;
  shared = null;
}
/** For `defineApp({attention})`. */
export function roleAttention(): AppAttention | null {
  return shared?.attention() ?? null;
}
/** After an activation or a deactivation: look again now. */
export function refreshRoleAttention(): Promise<void> {
  return shared ? shared.refresh() : Promise.resolve();
}
