// Model roles an `ai` step may name (`ai.by.role`). Mirror of MODEL_ROLES in `@opt2-tealbrick/spec/models` (spec 0.1.63 and
// later). This repo pins spec 0.1.47, which has no `./models` export, so the list is copied here and a test pins it.
// GAP: replace this file by `import { MODEL_ROLES } from "@opt2-tealbrick/spec/models"` when the spec pin moves.
export const MODEL_ROLES = ["embeddings", "rerank", "reasoning", "utility", "dreaming", "summarize", "vision", "transcribe"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
