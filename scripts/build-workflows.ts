// Bundles the Temporal workflow code ONCE at build time (v1: scripts/bundle-workflows.mjs). The worker then loads
// dist/engine/workflow-bundle.js instead of running webpack at start, which keeps boot fast and the memory of a small
// hosted instance low. Run after `tsc -p tsconfig.build.json` (it bundles the compiled dist/engine/workflow-entry.js).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";

const entry = fileURLToPath(new URL("../dist/engine/workflow-entry.js", import.meta.url));
const out = fileURLToPath(new URL("../dist/engine/workflow-bundle.js", import.meta.url));
const bundle = await bundleWorkflowCode({ workflowsPath: entry });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bundle.code);
console.log(`workflow bundle: ${bundle.code.length} bytes -> ${out}`);
