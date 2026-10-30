// Regenerates src/engine/target-ops.json: the operations of the apps that Evolving Workflows may call, as the engine's
// validator reads them. The SDK gives an app NO way to read an installed target manifest (it only knows the product names
// of its companion grants), so the engine ships this snapshot of the target manifests and stamps each app's version.
//   node scripts/sync-target-ops.ts kanban=<manifest.json> knowledge=<manifest.json> ... [--companions]
// `--companions` prints the superset companion block for tealbrick.manifest.json (ENGINE-BUILD §4, M1).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { companionBlock, type TargetApp, type TargetOp } from "../src/engine/catalog-rules.ts";

interface RawOp extends TargetOp {
  title?: string;
  description?: string;
}
const args = process.argv.slice(2);
const printCompanions = args.includes("--companions");
const apps: Record<string, TargetApp> = {};
for (const a of args.filter((x) => x.includes("="))) {
  const [product, file] = a.split("=") as [string, string];
  const m = JSON.parse(readFileSync(file, "utf8")) as { id: string; version: string; operations: RawOp[] };
  apps[product] = {
    id: product,
    version: m.version,
    operations: m.operations
      .filter((o) => o.audience === "agent")
      .map((o) => ({ id: o.id, audience: o.audience, crud: o.crud, effect: o.effect, ...(o.holdFamily ? { holdFamily: o.holdFamily } : {}), ...(o.scopeType ? { scopeType: o.scopeType } : {}), idempotency: o.idempotency, ...(o.input ? { input: o.input } : {}), ...(o.output ? { output: o.output } : {}), ...(o.dynamic ? { dynamic: o.dynamic } : {}) })),
  };
}
if (printCompanions) {
  console.log(JSON.stringify(companionBlock(apps), null, 2));
} else {
  const out = fileURLToPath(new URL("../src/engine/target-ops.json", import.meta.url));
  writeFileSync(out, `${JSON.stringify({ note: "Snapshot of the agent operations of the companion targets (scripts/sync-target-ops.ts). The SDK exposes no installed manifests.", apps }, null, 1)}\n`);
  console.log(`wrote ${out}: ${Object.entries(apps).map(([k, v]) => `${k} ${v.version} (${v.operations.length} ops)`).join(", ")}`);
}
