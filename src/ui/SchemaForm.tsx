// A JSON Schema of an object (workflow inputs, the typed output of an ai step) as a form: one row per field with its name,
// kind and whether it is required. A schema the form cannot show without losing something (nested objects, $ref, oneOf ...)
// opens as JSON; the JSON view is always there as the advanced view. Also the matching value form: the inputs of a run or a
// schedule, typed from the workflow's inputs schema (C367 D9 GUI pass: no raw JSON where a form is expected).
import { Button, Field, NativeSelect, TextInput } from "@opt2-tealbrick/ui";
import { useState } from "react";
import type { Json, JsonObject } from "../engine/json.ts";
import { PField, useIssuesAt } from "./FieldIssues.tsx";
import { JsonField, seg } from "./StepForms.tsx";

export type FieldKind = "text" | "email" | "number" | "integer" | "yes/no" | "list of text" | "one of";
export const FIELD_KINDS: readonly FieldKind[] = ["text", "email", "number", "integer", "yes/no", "list of text", "one of"];

export interface SchemaRow {
  name: string;
  kind: FieldKind;
  required: boolean;
  description: string;
  /** "one of": the allowed texts */
  choices: string[];
  /** keywords the row keeps but does not edit (maxItems, minLength ...) */
  extra: JsonObject;
}

const isObj = (v: unknown): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);
const OWN = new Set(["type", "format", "description", "enum", "items"]);
/** keywords a row may carry without the form losing them (they are kept as they are) */
const KEPT = new Set(["minLength", "maxLength", "pattern", "minimum", "maximum", "maxItems", "minItems", "uniqueItems", "default", "title", "examples"]);

/** The kind of one property schema, or null when the form cannot show it. */
export function kindOf(p: unknown): FieldKind | null {
  if (!isObj(p)) return null;
  for (const k of Object.keys(p)) if (!OWN.has(k) && !KEPT.has(k)) return null;
  if (Array.isArray(p.enum)) return p.enum.every((x) => typeof x === "string") && (p.type === undefined || p.type === "string") ? "one of" : null;
  if (p.type === "string") return p.format === undefined ? "text" : p.format === "email" ? "email" : null;
  if (p.format !== undefined) return null;
  if (p.type === "number") return "number";
  if (p.type === "integer") return "integer";
  if (p.type === "boolean") return "yes/no";
  if (p.type === "array") return isObj(p.items) && p.items.type === "string" && Object.keys(p.items).length === 1 ? "list of text" : null;
  return null;
}

/** The rows of an object schema, or null when the form cannot show it without losing something. */
export function rowsOf(schema: unknown): SchemaRow[] | null {
  if (schema === undefined) return [];
  if (!isObj(schema)) return null;
  for (const k of Object.keys(schema)) if (!["type", "properties", "required", "additionalProperties", "description"].includes(k)) return null;
  if (schema.type !== undefined && schema.type !== "object") return null;
  const props = schema.properties ?? {};
  if (!isObj(props)) return null;
  const required = Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : [];
  const rows: SchemaRow[] = [];
  for (const [name, p] of Object.entries(props)) {
    const kind = kindOf(p);
    if (kind === null || !isObj(p)) return null;
    const extra = Object.fromEntries(Object.entries(p).filter(([k]) => KEPT.has(k)));
    rows.push({ name, kind, required: required.includes(name), description: typeof p.description === "string" ? p.description : "", choices: Array.isArray(p.enum) ? (p.enum as string[]) : [], extra });
  }
  return rows;
}

function baseOf(r: SchemaRow): JsonObject {
  switch (r.kind) {
      case "text":
        return { type: "string" };
      case "email":
        return { type: "string", format: "email" };
      case "number":
        return { type: "number" };
      case "integer":
        return { type: "integer" };
      case "yes/no":
        return { type: "boolean" };
      case "list of text":
        return { type: "array", items: { type: "string" } };
      case "one of":
        return { enum: r.choices };
    }
}
function propOf(r: SchemaRow): JsonObject {
  const base = baseOf(r);
  return { ...base, ...r.extra, ...(r.description ? { description: r.description } : {}) };
}

/** The object schema of the rows (keeps `additionalProperties` and the description of the schema it came from). */
export function schemaOf(rows: readonly SchemaRow[], prior?: unknown): JsonObject {
  const keep = isObj(prior) ? Object.fromEntries(Object.entries(prior).filter(([k]) => k === "additionalProperties" || k === "description")) : {};
  return { type: "object", ...keep, required: rows.filter((r) => r.required).map((r) => r.name), properties: Object.fromEntries(rows.map((r) => [r.name, propOf(r)])) };
}

/** An object schema edited as rows, with the JSON view as the advanced view (and the only view for a schema the rows cannot show). */
export function SchemaFields({ at, label, hint, value, onChange, nameLabel = "Field", optional = false }: { at: string; label: string; hint?: string; value: unknown; onChange: (v: JsonObject | undefined) => void; nameLabel?: string; optional?: boolean }) {
  const rows = rowsOf(value);
  const [json, setJson] = useState(false);
  const own = useIssuesAt(at).filter((i) => i.pointer === at || i.pointer === `${at}/required` || i.pointer === `${at}/type`);
  if (rows === null || json)
    return (
      <div className="tb-stack">
        <JsonField at={at} label={label} hint={rows === null ? `${hint ? `${hint} ` : ""}This schema uses more than the simple form shows, so it opens as JSON.` : hint} value={value} onChange={(v) => onChange(v === undefined ? undefined : (v as JsonObject))} rows={8} />
        {rows !== null ? (
          <div>
            <Button size="sm" onClick={() => setJson(false)}>
              {`Edit ${label.toLowerCase()} as a form`}
            </Button>
          </div>
        ) : null}
      </div>
    );
  const put = (next: SchemaRow[]) => onChange(optional && next.length === 0 ? undefined : schemaOf(next, value));
  const row = (i: number, patch: Partial<SchemaRow>) => put(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="tb-stack refmap schema-form" data-pointer={at}>
      <legend className="tb-label">{label}</legend>
      {hint ? <p className="tb-hint">{hint}</p> : null}
      {own.map((i, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list in the order the validator gave it
        <p key={n} className={i.level === "error" ? "tb-error" : "tb-hint"} role={i.level === "error" ? "alert" : undefined}>
          {i.level === "error" ? i.message : `Note: ${i.message}`}
        </p>
      ))}
      {rows.length === 0 ? <p className="tb-soft">{`No ${nameLabel.toLowerCase()}s yet.`}</p> : null}
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the name is the thing being edited, so it cannot be the key
        <div key={i} className="schema-row">
          <PField at={`${at}/properties/${seg(r.name)}`} label={`${nameLabel} ${i + 1} name`}>
            <TextInput value={r.name} onChange={(e) => row(i, { name: e.target.value })} />
          </PField>
          <Field label={`${nameLabel} ${i + 1} kind`}>
            <NativeSelect value={r.kind} onChange={(e) => row(i, { kind: e.target.value as FieldKind, extra: {}, choices: e.target.value === "one of" && r.choices.length === 0 ? ["a", "b"] : r.choices })} options={FIELD_KINDS.map((k) => ({ value: k, label: k }))} />
          </Field>
          <Field label={`${nameLabel} ${i + 1} required`}>
            <NativeSelect
              value={r.required ? "yes" : "no"}
              onChange={(e) => row(i, { required: e.target.value === "yes" })}
              options={[
                { value: "yes", label: "required" },
                { value: "no", label: "optional" },
              ]}
            />
          </Field>
          {r.kind === "one of" ? (
            <Field label={`${nameLabel} ${i + 1} choices`} hint="Comma separated.">
              <TextInput
                value={r.choices.join(", ")}
                onChange={(e) =>
                  row(i, {
                    choices: e.target.value
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
          ) : (
            <Field label={`${nameLabel} ${i + 1} description`} hint="Optional.">
              <TextInput value={r.description} onChange={(e) => row(i, { description: e.target.value })} />
            </Field>
          )}
          <Button size="sm" aria-label={`Remove ${nameLabel.toLowerCase()} ${i + 1}`} onClick={() => put(rows.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <div className="tb-ctas">
        <Button
          size="sm"
          onClick={() => {
            let n = rows.length + 1;
            while (rows.some((r) => r.name === `field${n}`)) n++;
            put([...rows, { name: `field${n}`, kind: "text", required: true, description: "", choices: [], extra: {} }]);
          }}
        >
          {`Add ${nameLabel.toLowerCase()}`}
        </Button>
        <Button size="sm" onClick={() => setJson(true)}>
          {`Edit ${label.toLowerCase()} as JSON`}
        </Button>
      </div>
    </fieldset>
  );
}

// ── values typed by a schema (run inputs, schedule inputs) ──

/** The value of one field as the form edits it (text), and back. */
function toText(v: Json | undefined, kind: FieldKind): string {
  if (v === undefined || v === null) return "";
  if (kind === "list of text") return Array.isArray(v) ? v.join(", ") : String(v);
  return typeof v === "string" ? v : JSON.stringify(v);
}
function fromText(s: string, kind: FieldKind): Json | undefined {
  if (s.trim() === "") return undefined;
  switch (kind) {
    case "number":
    case "integer":
      return Number.isNaN(Number(s)) ? s : Number(s);
    case "yes/no":
      return s === "yes";
    case "list of text":
      return s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    default:
      return s;
  }
}

/** The inputs of a run or a schedule as a form typed from the workflow's inputs schema (JSON when the schema is not simple). */
export function ValuesForm({ schema, value, onChange, label = "Inputs" }: { schema: unknown; value: JsonObject; onChange: (v: JsonObject) => void; label?: string }) {
  const rows = rowsOf(schema);
  if (rows === null) return <JsonField label={label} hint="The workflow's inputs schema is not a simple list of fields, so the inputs are JSON." value={value} onChange={(v) => onChange((isObj(v) ? v : {}) as JsonObject)} rows={6} />;
  if (rows.length === 0) return <p className="tb-hint">This workflow takes no inputs.</p>;
  const set = (name: string, v: Json | undefined) => {
    const { [name]: _old, ...rest } = value;
    onChange(v === undefined ? rest : { ...rest, [name]: v });
  };
  return (
    <fieldset className="tb-stack refmap">
      <legend className="tb-label">{label}</legend>
      {rows.map((r) =>
        r.kind === "yes/no" || r.kind === "one of" ? (
          <Field key={r.name} label={`${r.name}${r.required ? "" : " (optional)"}`} hint={r.description || undefined}>
            <NativeSelect
              value={r.kind === "yes/no" ? (value[r.name] === true ? "yes" : value[r.name] === false ? "no" : "") : toText(value[r.name], r.kind)}
              onChange={(e) => set(r.name, r.kind === "yes/no" ? (e.target.value === "" ? undefined : e.target.value === "yes") : e.target.value || undefined)}
              options={[{ value: "", label: "(not set)" }, ...(r.kind === "yes/no" ? ["yes", "no"] : r.choices).map((c) => ({ value: c, label: c }))]}
            />
          </Field>
        ) : (
          <Field key={r.name} label={`${r.name}${r.required ? "" : " (optional)"}`} hint={r.description || (r.kind === "list of text" ? "Comma separated." : undefined)}>
            <TextInput type={r.kind === "email" ? "email" : "text"} inputMode={r.kind === "number" || r.kind === "integer" ? "decimal" : undefined} value={toText(value[r.name], r.kind)} onChange={(e) => set(r.name, fromText(e.target.value, r.kind))} />
          </Field>
        ),
      )}
    </fieldset>
  );
}

/** The required inputs that have no value yet (the run or schedule button stays off until they are given). */
export function missingInputs(schema: unknown, value: JsonObject): string[] {
  const rows = rowsOf(schema);
  if (rows === null) return [];
  return rows.filter((r) => r.required && (value[r.name] === undefined || value[r.name] === "")).map((r) => r.name);
}
