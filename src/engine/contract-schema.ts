// biome-ignore-all lint/suspicious/noThenProperty: JSON Schema keywords if/then
// JSON Schema (draft 2020-12) of `tealbrick.workflow/1` (ENGINE-BUILD §2). This is the STRUCTURE; validateContract() adds the
// checks a schema cannot make (refs, types between steps, the target catalog, grants). Data only: no imports.
import type { Json } from "./json.ts";

export const CONTRACT_FORMAT = "tealbrick.workflow/1";

export const LIMITS = {
  maxSteps: 200,
  maxLoop: 200,
  /** a top-level loop above this many items continues as new, so the history stays small */
  loopContinueAsNew: 100,
  maxParallel: 8,
  maxSubWorkflowDepth: 3,
  maxNesting: 6,
  maxMetrics: 20,
  maxRunMinutes: 10080,
  defaultRunMinutes: 60,
  maxTimerSec: 31_536_000,
};

export const STAGES = ["process", "enrichment", "concat", "intelligence", "result"] as const;
export const ON_FAIL = ["stop", "continue", "ask"] as const;
export const STEP_TYPES = ["app", "ai", "approval", "transform", "timer", "condition", "loop", "parallel", "workflow"] as const;
export const NORMALISE_OP_NAMES = ["trim", "lowercase", "uppercase", "collapse_spaces", "date", "phone"] as const;

const ID: Json = { type: "string", pattern: "^[a-z][a-z0-9_-]{0,31}$" };
const REF: Json = { type: "string", minLength: 2, maxLength: 300 };
const RETRY: Json = {
  type: "object",
  additionalProperties: false,
  description: "max = attempts in total (1 = no retry); backoffSec = first wait, doubled each time.",
  properties: { max: { type: "integer", minimum: 1, maximum: 10 }, backoffSec: { type: "integer", minimum: 1, maximum: 3600 } },
};
const OUTPUT_SCHEMA: Json = { type: "object", description: "JSON Schema of the step output." };

const common: { [k: string]: Json } = {
  id: ID,
  type: { enum: [...STEP_TYPES] },
  stage: { enum: [...STAGES], description: "Optional label: where the step sits in event -> process -> enrichment -> concat -> intelligence -> result." },
  title: { type: "string", minLength: 1, maxLength: 120 },
};

/** One variant per step type. `unevaluatedProperties: false` on the step makes a misspelt field an error. */
const variant = (type: string, props: Record<string, Json>, required: string[]): Json => ({
  if: { properties: { type: { const: type } }, required: ["type"] },
  then: { properties: props, required },
});

const stepRef: Json = { $ref: "#/$defs/step" };
const stepList: Json = { type: "array", minItems: 1, maxItems: 200, items: stepRef };

export const CONTRACT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://spec.opt2.tealbrick.com/workflow/1.schema.json",
  title: "tealbrick.workflow/1",
  type: "object",
  additionalProperties: false,
  required: ["format", "id", "version", "title", "triggers", "steps"],
  properties: {
    format: { const: CONTRACT_FORMAT },
    id: { type: "string", pattern: "^[a-z][a-z0-9-]{2,39}$" },
    version: { type: "integer", minimum: 1, maximum: 100000 },
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", maxLength: 2000 },
    inputs: { type: "object", description: "JSON Schema (type object) of the workflow input. $input.<path> reads it." },
    triggers: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        required: ["kind"],
        properties: { kind: { enum: ["schedule", "manual", "poll", "event"] } },
        allOf: [
          {
            if: { properties: { kind: { const: "schedule" } } },
            then: {
              properties: {
                kind: true,
                cron: { type: "string", minLength: 9, maxLength: 120, description: "five fields" },
                every: { type: "string", pattern: "^[1-9][0-9]{0,3}[mhd]$", description: "an interval such as 15m, 6h, 1d" },
                timezone: { type: "string", minLength: 1, maxLength: 64, description: "IANA time zone name" },
                input: { type: "object" },
              },
              required: ["timezone"],
              unevaluatedProperties: false,
            },
          },
          { if: { properties: { kind: { const: "manual" } } }, then: { properties: { kind: true, inputs: { type: "object" } }, unevaluatedProperties: false } },
          {
            if: { properties: { kind: { const: "poll" } } },
            then: {
              properties: {
                kind: true,
                product: { type: "string", pattern: "^[a-z][a-z0-9-]{0,39}$" },
                op: { type: "string", pattern: "^[a-z][a-z0-9_]{1,47}$" },
                input: { type: "object" },
                cursorPath: { type: "string", pattern: "^(/[^/]+)+$", description: "JSON pointer into the op output; the run starts only when it changed" },
                every: { type: "string", pattern: "^[1-9][0-9]{0,3}[mhd]$" },
              },
              required: ["product", "op", "cursorPath", "every"],
              unevaluatedProperties: false,
            },
          },
          {
            if: { properties: { kind: { const: "event" } } },
            then: {
              properties: {
                kind: true,
                product: { type: "string", pattern: "^[a-z][a-z0-9-]{0,39}$" },
                type: { type: "string", minLength: 1, maxLength: 100 },
                filter: { type: "object" },
              },
              required: ["product", "type"],
              unevaluatedProperties: false,
            },
          },
        ],
      },
    },
    steps: { type: "array", minItems: 1, maxItems: LIMITS.maxSteps, items: stepRef },
    outputs: { type: "object", maxProperties: 50, propertyNames: { pattern: "^[a-z][a-zA-Z0-9_]{0,39}$" }, additionalProperties: REF },
    metrics: { type: "array", maxItems: LIMITS.maxMetrics, uniqueItems: true, items: { type: "string", pattern: "^[a-z][a-z0-9_]{0,39}$" } },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxSteps: { type: "integer", minimum: 1, maximum: LIMITS.maxSteps },
        maxRunMinutes: { type: "integer", minimum: 1, maximum: LIMITS.maxRunMinutes },
        maxModelTokens: { type: "integer", minimum: 1, maximum: 1_000_000 },
      },
    },
  },
  $defs: {
    step: {
      type: "object",
      required: ["id", "type"],
      properties: common,
      allOf: [
        variant(
          "app",
          {
            ...common,
            product: { type: "string", pattern: "^[a-z][a-z0-9-]{0,39}$" },
            op: { type: "string", pattern: "^[a-z][a-z0-9_]{1,47}$" },
            input: { type: "object" },
            retry: RETRY,
            timeoutSec: { type: "integer", minimum: 1, maximum: 3600 },
            onFail: { enum: [...ON_FAIL] },
            outputSchema: OUTPUT_SCHEMA,
          },
          ["product", "op"],
        ),
        variant(
          "ai",
          {
            ...common,
            by: {
              oneOf: [
                { type: "object", additionalProperties: false, required: ["role"], properties: { role: { type: "string", minLength: 1, maxLength: 32 } } },
                { type: "object", additionalProperties: false, required: ["agent"], properties: { agent: { type: "string", pattern: "^agt_[0-9A-Za-z]{1,60}$" } } },
              ],
            },
            instruction: { type: "string", minLength: 1, maxLength: 8000 },
            inputs: { type: "object", maxProperties: 20 },
            outputSchema: OUTPUT_SCHEMA,
            timeoutSec: { type: "integer", minimum: 10, maximum: 86400 },
            heartbeatSec: { type: "integer", minimum: 0, maximum: 600 },
            retry: RETRY,
            maxTokens: { type: "integer", minimum: 1, maximum: 4000 },
            onFail: { enum: [...ON_FAIL] },
          },
          ["by", "instruction", "outputSchema"],
        ),
        variant(
          "approval",
          {
            ...common,
            title: { type: "string", minLength: 1, maxLength: 200 },
            context: { type: "string", maxLength: 8000 },
            timeoutSec: { type: "integer", minimum: 60, maximum: 2_592_000 },
            onDeny: { enum: ["stop", "continue"] },
          },
          ["title"],
        ),
        variant(
          "transform",
          {
            ...common,
            pick: { type: "object" },
            merge: { type: ["array", "object"] },
            rename: { type: "object", additionalProperties: false, required: ["from", "map"], properties: { from: REF, map: { type: "object", additionalProperties: { type: "string", minLength: 1 } } } },
            concat: { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", minItems: 1, maxItems: 20 }, separator: { type: "string", maxLength: 40 } } },
            template: { type: "string", maxLength: 20000 },
            map: { type: "object", additionalProperties: false, required: ["forEach", "template"], properties: { forEach: REF, template: {} } },
            filter: { type: "object", additionalProperties: false, required: ["from", "where"], properties: { from: REF, where: {} } },
            dedupe: { type: "object", additionalProperties: false, required: ["from"], properties: { from: REF, by: { type: "string", maxLength: 100 } } },
            sort: { type: "object", additionalProperties: false, required: ["from"], properties: { from: REF, by: { type: "string", maxLength: 100 }, order: { enum: ["asc", "desc"] } } },
            normalise: {
              type: "object",
              additionalProperties: false,
              required: ["from", "ops"],
              properties: { from: REF, fields: { type: "array", maxItems: 20, items: { type: "string", maxLength: 100 } }, ops: { type: "array", minItems: 1, maxItems: 6, items: { enum: [...NORMALISE_OP_NAMES] } } },
            },
            outputSchema: OUTPUT_SCHEMA,
          },
          [],
        ),
        variant("timer", { ...common, seconds: { type: "integer", minimum: 1, maximum: LIMITS.maxTimerSec }, until: REF }, []),
        variant("condition", { ...common, if: {}, then: stepList, else: { type: "array", maxItems: 200, items: stepRef } }, ["if", "then"]),
        variant("loop", { ...common, forEach: REF, max: { type: "integer", minimum: 1, maximum: LIMITS.maxLoop }, steps: stepList, onFail: { enum: [...ON_FAIL] } }, ["forEach", "max", "steps"]),
        variant(
          "parallel",
          {
            ...common,
            branches: { type: "object", minProperties: 1, maxProperties: LIMITS.maxParallel, propertyNames: { pattern: "^[a-z][a-z0-9_-]{0,31}$" }, additionalProperties: stepList },
          },
          ["branches"],
        ),
        variant(
          "workflow",
          {
            ...common,
            workflow: { type: "string", pattern: "^[a-z][a-z0-9-]{2,39}$" },
            version: { type: "integer", minimum: 1, maximum: 100000 },
            input: { type: "object" },
            onFail: { enum: [...ON_FAIL] },
          },
          ["workflow"],
        ),
      ],
      unevaluatedProperties: false,
    },
  },
} as unknown as { [k: string]: Json };
