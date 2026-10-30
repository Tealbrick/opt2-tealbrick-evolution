// The catalog of target operations the validator and the engine read (see scripts/sync-target-ops.ts).
//
// GAP (reported to the Evolution lead): the SDK and the spec give an app no way to read an INSTALLED target manifest. An app
// sees only the product names of its companion grants (`ctx.companionTargets()`). So the engine ships a snapshot of the
// target manifests (`target-ops.json`, stamped with the version of each app) and accepts an injected catalog in tests.
// Draft-time checks use this snapshot; the bridge still enforces the real manifest at call time.

import type { TargetApp, TargetCatalog, TargetOp } from "./catalog-rules.ts";
import data from "./target-ops.json" with { type: "json" };

export type { TargetApp, TargetCatalog, TargetOp };

let injected: TargetCatalog | null = null;

/** Tests: use this catalog instead of the bundled snapshot (null restores the snapshot). */
export function injectCatalog(c: TargetCatalog | null): void {
  injected = c;
}

export function bundledCatalog(): TargetCatalog {
  return data.apps as unknown as TargetCatalog;
}

export function currentCatalog(): TargetCatalog {
  return injected ?? bundledCatalog();
}

export function findOp(catalog: TargetCatalog, product: string, op: string): TargetOp | null {
  return catalog[product]?.operations.find((o) => o.id === op) ?? null;
}
