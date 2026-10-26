// Entry of the Temporal workflow bundle (scripts/build-workflows.ts bundles dist/engine/workflow-entry.js once at build time).
// Only workflow code may be reachable from here: no Node API, no SDK, no validator.
export { evolutionRun } from "./workflow.ts";
