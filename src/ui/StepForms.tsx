// The typed step list of the workflow editor: one form per step kind (app, ai, transform, approval, timer, condition, loop,
// parallel), nested lists for the kinds that hold steps, and the small controls they share. Every control edits a plain
// value and hands the new value up; nothing is saved here (src/ui/Editor.tsx holds the contract).
import type { UseAgents } from "@opt2-tealbrick/miniapp-sdk/client";
import { Button, Field, NativeSelect, Select, Tag, Textarea, TextInput } from "@opt2-tealbrick/ui";
import { useEffect, useRef, useState } from "react";
import type { Json, JsonObject } from "../engine/json.ts";
import { type AiStep, type ApprovalStep, type AppStep, allSteps, STAGES, STEP_KINDS, type Step, type StepKind, type TimerStep, type TransformStep, type WorkflowStep } from "./engine-contract.ts";

// ── shared controls ──

/** A JSON value edited as text. The value goes up only while the text parses; a parse error is shown under the field. */
const jsonText = (v: unknown): string => (v === undefined ? "" : JSON.stringify(v, null, 2));
export function JsonField({ label, hint, value, onChange, rows = 5 }: { label: string; hint?: string; value: unknown; onChange: (v: unknown) => void; rows?: number }) {
  const text = jsonText;
  const [draft, setDraft] = useState(text(value));
  const [error, setError] = useState<string | null>(null);
  const last = useRef(JSON.stringify(value));
  useEffect(() => {
    const now = JSON.stringify(value);
    if (now !== last.current) {
      last.current = now;
      setDraft(text(value));
      setError(null);
    }
  }, [value]);
  return (
    <Field label={label} hint={hint} error={error ?? undefined}>
      <Textarea
        className="mono"
        rows={rows}
        value={draft}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          try {
            const v = e.target.value.trim() === "" ? undefined : JSON.parse(e.target.value);
            last.current = JSON.stringify(v);
            setError(null);
            onChange(v);
          } catch (x) {
            setError(`Not valid JSON yet: ${(x as Error).message.slice(0, 120)}`);
          }
        }}
      />
    </Field>
  );
}

/** A map of name → Json (ai inputs, pick, merge): rows of refs while every value is a string, else the JSON text (nothing is lost). */
export function JsonRefMap({ label, hint, value, onChange, nameLabel = "Name", refLabel = "Ref" }: { label: string; hint?: string; value: Record<string, Json> | undefined; onChange: (v: Record<string, Json>) => void; nameLabel?: string; refLabel?: string }) {
  const onlyRefs = Object.values(value ?? {}).every((v) => typeof v === "string");
  if (onlyRefs) return <RefMap label={label} hint={hint} value={value as Record<string, string> | undefined} onChange={onChange} nameLabel={nameLabel} refLabel={refLabel} />;
  return <JsonField label={label} hint={hint} value={value} onChange={(v) => onChange((v ?? {}) as Record<string, Json>)} rows={5} />;
}

/** name → ref rows (ai inputs, pick, merge, outputs). */
export function RefMap({ label, hint, value, onChange, nameLabel = "Name", refLabel = "Ref" }: { label: string; hint?: string; value: Record<string, string> | undefined; onChange: (v: Record<string, string>) => void; nameLabel?: string; refLabel?: string }) {
  const rows = Object.entries(value ?? {});
  const set = (next: [string, string][]) => onChange(Object.fromEntries(next));
  return (
    <fieldset className="tb-stack refmap">
      <legend className="tb-label">{label}</legend>
      {hint ? <p className="tb-hint">{hint}</p> : null}
      {rows.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the name is the thing being edited, so it cannot be the key
        <div key={i} className="two">
          <Field label={`${nameLabel} ${i + 1}`}>
            <TextInput value={k} onChange={(e) => set(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          </Field>
          <Field label={`${refLabel} ${i + 1}`}>
            <TextInput value={v} className="mono" onChange={(e) => set(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} />
          </Field>
          <Button size="sm" aria-label={`Remove ${nameLabel.toLowerCase()} ${i + 1}`} onClick={() => set(rows.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <div>
        <Button size="sm" onClick={() => set([...rows, [`name${rows.length + 1}`, "$input."]])}>
          Add {nameLabel.toLowerCase()}
        </Button>
      </div>
    </fieldset>
  );
}

const num = (s: string): number | undefined => (s.trim() === "" || Number.isNaN(Number(s)) ? undefined : Number(s));

function NumberField({ label, hint, value, onChange }: { label: string; hint?: string; value: number | undefined; onChange: (v: number | undefined) => void }) {
  return (
    <Field label={label} hint={hint}>
      <TextInput inputMode="numeric" value={value === undefined ? "" : String(value)} onChange={(e) => onChange(num(e.target.value))} />
    </Field>
  );
}

// ── new steps ──

export function newStep(kind: StepKind, taken: ReadonlySet<string>): Step {
  let n = 1;
  while (taken.has(`${kind}${n}`)) n++;
  const id = `${kind}${n}`;
  switch (kind) {
    case "app":
      return { id, type: "app", product: "", op: "", input: {} };
    case "ai":
      return { id, type: "ai", by: { role: "summarize" }, instruction: "", inputs: {}, outputSchema: { type: "object", required: [], properties: {} } };
    case "transform":
      return { id, type: "transform", pick: {} };
    case "approval":
      return { id, type: "approval", title: "", timeoutSec: 86_400, onDeny: "stop" };
    case "timer":
      return { id, type: "timer", seconds: 60 };
    case "condition":
      // biome-ignore lint/suspicious/noThenProperty: the condition step of the contract names its branch "then" (ENGINE-BUILD §3)
      return { id, type: "condition", if: { "==": ["$input.x", true] }, then: [], else: [] };
    case "loop":
      return { id, type: "loop", forEach: "$input.items", max: 50, steps: [] };
    case "parallel":
      return { id, type: "parallel", branches: { a: [], b: [] } };
    case "workflow":
      return { id, type: "workflow", workflow: "" };
  }
}

/** Every id in the contract, so a new step never repeats one. */
export const idsOf = (steps: readonly Step[]): Set<string> => new Set(allSteps(steps).map((x) => x.step.id));

// ── the list ──

export function StepList({ steps, onChange, taken, agents, label = "Steps" }: { steps: Step[]; onChange: (s: Step[]) => void; taken: Set<string>; agents: UseAgents["agents"]; label?: string }) {
  const [kind, setKind] = useState<StepKind>("app");
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j] as Step, next[i] as Step];
    onChange(next);
  };
  return (
    <section className="tb-stack step-list" aria-label={label}>
      {steps.length === 0 ? <p className="tb-soft">No steps here yet.</p> : null}
      <ol className="plain">
        {steps.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the id is the thing being edited, so the position is the identity
          <li key={i} className="tb-card step-card" data-kind={s.type}>
            <div className="card-head">
              <h4>
                <code className="code-ops">{s.id}</code> <Tag>{s.type}</Tag>
              </h4>
              <div className="tb-ctas">
                <Button size="sm" aria-label={`Move ${s.id} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  Up
                </Button>
                <Button size="sm" aria-label={`Move ${s.id} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>
                  Down
                </Button>
                <Button size="sm" variant="danger" aria-label={`Delete ${s.id}`} onClick={() => onChange(steps.filter((_, j) => j !== i))}>
                  Delete
                </Button>
              </div>
            </div>
            <StepCommon step={s} onChange={(next) => onChange(steps.map((x, j) => (j === i ? next : x)))} />
            <StepFields step={s} onChange={(next) => onChange(steps.map((x, j) => (j === i ? next : x)))} taken={taken} agents={agents} />
          </li>
        ))}
      </ol>
      <div className="toolbar">
        <Field label={`New step kind (${label})`}>
          <NativeSelect value={kind} onChange={(e) => setKind(e.target.value as StepKind)} options={STEP_KINDS.map((k) => ({ value: k, label: k }))} />
        </Field>
        <Button
          onClick={() => {
            const s = newStep(kind, taken);
            taken.add(s.id);
            onChange([...steps, s]);
          }}
        >
          Add step
        </Button>
      </div>
    </section>
  );
}

function StepCommon({ step, onChange }: { step: Step; onChange: (s: Step) => void }) {
  return (
    <div className="three">
      <Field label={`Id of ${step.id}`} hint="Lower case letters, digits, underscore, hyphen.">
        <TextInput value={step.id} onChange={(e) => onChange({ ...step, id: e.target.value })} />
      </Field>
      <Field label={`Stage of ${step.id}`} hint="Where it sits in the shape.">
        <NativeSelect
          value={step.stage ?? ""}
          onChange={(e) => {
            const { stage: _drop, ...rest } = step;
            onChange((e.target.value ? { ...rest, stage: e.target.value as (typeof STAGES)[number] } : rest) as Step);
          }}
          options={[{ value: "", label: "(by kind)" }, ...STAGES.map((s) => ({ value: s, label: s }))]}
        />
      </Field>
      <Field label={`Title of ${step.id}`} hint="Optional.">
        <TextInput value={step.type === "approval" ? "" : (step.title ?? "")} disabled={step.type === "approval"} onChange={(e) => onChange({ ...step, title: e.target.value || undefined } as Step)} />
      </Field>
    </div>
  );
}

function StepFields({ step, onChange, taken, agents }: { step: Step; onChange: (s: Step) => void; taken: Set<string>; agents: UseAgents["agents"] }) {
  switch (step.type) {
    case "app":
      return <AppFields step={step} onChange={onChange} />;
    case "ai":
      return <AiFields step={step} onChange={onChange} agents={agents} />;
    case "transform":
      return <TransformFields step={step} onChange={onChange} />;
    case "approval":
      return <ApprovalFields step={step} onChange={onChange} />;
    case "timer":
      return <TimerFields step={step} onChange={onChange} />;
    case "workflow":
      return <WorkflowFields step={step} onChange={onChange} />;
    case "condition":
      return (
        <div className="tb-stack">
          <JsonField label={`Condition of ${step.id}`} hint='A small expression, for example {"==": ["$steps.x.output.ok", true]}. No code.' value={step.if} onChange={(v) => onChange({ ...step, if: (v ?? null) as Json })} rows={3} />
          <StepList steps={step.then ?? []} onChange={(then) => onChange({ ...step, then })} taken={taken} agents={agents} label={`${step.id} then`} />
          <StepList steps={step.else ?? []} onChange={(els) => onChange({ ...step, else: els })} taken={taken} agents={agents} label={`${step.id} else`} />
        </div>
      );
    case "loop":
      return (
        <div className="tb-stack">
          <div className="two">
            <Field label={`For each in ${step.id}`} hint="A ref to a list.">
              <TextInput className="mono" value={step.forEach ?? ""} onChange={(e) => onChange({ ...step, forEach: e.target.value })} />
            </Field>
            <NumberField label={`Max items of ${step.id}`} hint="Required, 1 to 200." value={step.max} onChange={(max) => onChange({ ...step, max: max as number })} />
          </div>
          <StepList steps={step.steps ?? []} onChange={(steps) => onChange({ ...step, steps })} taken={taken} agents={agents} label={`${step.id} each`} />
        </div>
      );
    case "parallel": {
      const names = Object.keys(step.branches ?? {});
      return (
        <div className="tb-stack">
          {names.map((name) => (
            <section key={name} className="tb-stack branch">
              <div className="card-head">
                <h5>Branch {name}</h5>
                <Button
                  size="sm"
                  variant="danger"
                  aria-label={`Remove branch ${name} of ${step.id}`}
                  onClick={() => {
                    const { [name]: _gone, ...rest } = step.branches;
                    onChange({ ...step, branches: rest });
                  }}
                >
                  Remove branch
                </Button>
              </div>
              <StepList steps={step.branches[name] ?? []} onChange={(list) => onChange({ ...step, branches: { ...step.branches, [name]: list } })} taken={taken} agents={agents} label={`${step.id} branch ${name}`} />
            </section>
          ))}
          <div>
            <Button size="sm" disabled={names.length >= 8} onClick={() => onChange({ ...step, branches: { ...step.branches, [`branch${names.length + 1}`]: [] } })}>
              Add branch to {step.id}
            </Button>
          </div>
        </div>
      );
    }
  }
}

function AppFields({ step, onChange }: { step: AppStep; onChange: (s: Step) => void }) {
  return (
    <div className="tb-stack">
      <div className="three">
        <Field label={`App of ${step.id}`} hint="The product id, for example connect.">
          <TextInput value={step.product ?? ""} onChange={(e) => onChange({ ...step, product: e.target.value })} />
        </Field>
        <Field label={`Operation of ${step.id}`} hint="An agent operation of that app.">
          <TextInput value={step.op ?? ""} onChange={(e) => onChange({ ...step, op: e.target.value })} />
        </Field>
        <Field label={`On failure of ${step.id}`}>
          <NativeSelect
            value={step.onFail ?? "stop"}
            onChange={(e) => onChange({ ...step, onFail: e.target.value as AppStep["onFail"] })}
            options={[
              { value: "stop", label: "stop the run" },
              { value: "continue", label: "continue" },
              { value: "ask", label: "ask me" },
            ]}
          />
        </Field>
      </div>
      <JsonField label={`Input of ${step.id}`} hint="Checked against the op's input schema of the installed app. Refs: $input.x, $steps.id.output.x, {{ ref }}." value={step.input ?? {}} onChange={(v) => onChange({ ...step, input: (v ?? {}) as JsonObject })} />
      <JsonField label={`Output schema of ${step.id}`} hint="Only for an op whose answer the app does not describe (Connect tools). Optional." value={step.outputSchema} onChange={(v) => onChange({ ...step, outputSchema: v as AppStep["outputSchema"] })} rows={4} />
      <div className="two">
        <NumberField label={`Attempts of ${step.id}`} hint="1 to 10. 1 = no retry. An op without idempotency is never retried." value={step.retry?.max} onChange={(max) => onChange({ ...step, retry: { ...step.retry, max } })} />
        <NumberField label={`Timeout (s) of ${step.id}`} value={step.timeoutSec} onChange={(timeoutSec) => onChange({ ...step, timeoutSec })} />
      </div>
    </div>
  );
}

function AiFields({ step, onChange, agents }: { step: AiStep; onChange: (s: Step) => void; agents: UseAgents["agents"] }) {
  const agentMode = step.by && "agent" in step.by;
  const free = agents.filter((a) => a.mode === "free");
  const chosen = agentMode ? (step.by as { agent: string }).agent : "";
  return (
    <div className="tb-stack">
      <div className="two">
        <Field label={`Done by (${step.id})`} hint="A model role calls a model with no tools. An agent card is any agent: it returns content only.">
          <NativeSelect
            value={agentMode ? "agent" : "role"}
            onChange={(e) => onChange({ ...step, by: e.target.value === "agent" ? { agent: free[0]?.id ?? "" } : { role: "summarize" } })}
            options={[
              { value: "role", label: "Model role" },
              { value: "agent", label: "Agent card" },
            ]}
          />
        </Field>
        {agentMode ? (
          free.length ? (
            <Field label={`Agent of ${step.id}`} hint="A Free agent: it works with its own access.">
              <Select
                value={chosen}
                onValueChange={(agent) => onChange({ ...step, by: { agent } })}
                placeholder="Choose an agent"
                options={[...(chosen && !free.some((a) => a.id === chosen) ? [{ value: chosen, label: `${chosen} (not a Free agent here)` }] : []), ...free.map((a) => ({ value: a.id, label: a.name }))]}
              />
            </Field>
          ) : (
            <Field label={`Agent id of ${step.id}`} hint="No Free agent is listed in this workspace. Enter an agent id (agt_…).">
              <TextInput className="mono" value={chosen} onChange={(e) => onChange({ ...step, by: { agent: e.target.value } })} />
            </Field>
          )
        ) : (
          <Field label={`Model role of ${step.id}`} hint="For example utility, summarize, reasoning.">
            <TextInput value={(step.by as { role: string }).role ?? ""} onChange={(e) => onChange({ ...step, by: { role: e.target.value } })} />
          </Field>
        )}
      </div>
      <Field label={`Instruction of ${step.id}`} hint="Say what content to produce. Never ask it to act: the engine runs every action itself.">
        <Textarea rows={4} value={step.instruction ?? ""} onChange={(e) => onChange({ ...step, instruction: e.target.value })} />
      </Field>
      <JsonRefMap label={`Inputs of ${step.id}`} hint="Name → ref. The step gets exactly these." value={step.inputs} onChange={(inputs) => onChange({ ...step, inputs })} nameLabel="Input" />
      <JsonField label={`Output schema of ${step.id}`} hint='Required. A JSON Schema with "type": "object". The output is checked against it.' value={step.outputSchema} onChange={(v) => onChange({ ...step, outputSchema: (v ?? {}) as AiStep["outputSchema"] })} rows={8} />
      <div className="two">
        <NumberField label={`Timeout (s) of ${step.id}`} hint="10 to 86400. For an agent step this is how long the agent has." value={step.timeoutSec} onChange={(timeoutSec) => onChange({ ...step, timeoutSec })} />
        <NumberField label={`Attempts of ${step.id}`} hint="1 to 10. An agent step is offered again on each new attempt." value={step.retry?.max} onChange={(max) => onChange({ ...step, retry: { ...step.retry, max } })} />
      </div>
      <div className="two">
        {agentMode ? <NumberField label={`Heartbeat (s) of ${step.id}`} hint="0 to 600. 0 = the agent sends none; only the timeout applies." value={step.heartbeatSec} onChange={(heartbeatSec) => onChange({ ...step, heartbeatSec })} /> : null}
        <Field label={`On failure of ${step.id}`}>
          <NativeSelect
            value={step.onFail ?? "stop"}
            onChange={(e) => onChange({ ...step, onFail: e.target.value as AiStep["onFail"] })}
            options={[
              { value: "stop", label: "stop the run" },
              { value: "continue", label: "continue" },
              { value: "ask", label: "ask me" },
            ]}
          />
        </Field>
      </div>
    </div>
  );
}

// the operations of src/engine/transform.ts (WP2)
const TRANSFORM_OPS = ["pick", "rename", "merge", "concat", "template", "map", "filter", "dedupe", "sort", "normalise"] as const;
type TransformOp = (typeof TRANSFORM_OPS)[number];
const NORMALISE_OPS = ["trim", "lowercase", "uppercase", "collapse_spaces", "date", "phone"] as const;
type NormaliseOpName = (typeof NORMALISE_OPS)[number];

function TransformFields({ step, onChange }: { step: TransformStep; onChange: (s: Step) => void }) {
  const op: TransformOp = TRANSFORM_OPS.find((k) => step[k] !== undefined) ?? "pick";
  const base = { id: step.id, type: "transform" as const, ...(step.stage ? { stage: step.stage } : {}), ...(step.title ? { title: step.title } : {}), ...(step.outputSchema ? { outputSchema: step.outputSchema } : {}) };
  const start = (k: TransformOp): TransformStep => {
    switch (k) {
      case "pick":
        return { ...base, pick: {} };
      case "rename":
        return { ...base, rename: { from: "$input.item", map: {} } };
      case "merge":
        return { ...base, merge: {} };
      case "concat":
        return { ...base, concat: { items: ["$input.a", "$input.b"], separator: "\n" } };
      case "map":
        return { ...base, map: { forEach: "$input.items", template: {} } };
      case "filter":
        return { ...base, filter: { from: "$input.items", where: { "==": ["$item.ok", true] } } };
      case "template":
        return { ...base, template: "" };
      case "dedupe":
        return { ...base, dedupe: { from: "$input.items", by: "id" } };
      case "sort":
        return { ...base, sort: { from: "$input.items", by: "id", order: "asc" } };
      case "normalise":
        return { ...base, normalise: { from: "$input.value", ops: ["trim"] } };
    }
  };
  const put = <K extends TransformOp>(k: K, v: NonNullable<TransformStep[K]>) => onChange({ ...step, [k]: v } as TransformStep);
  const from = (k: "filter" | "dedupe" | "sort" | "normalise" | "rename", label: string) => {
    const cur = step[k] as { from: string } | undefined;
    return (
      <Field label={label}>
        <TextInput className="mono" value={cur?.from ?? ""} onChange={(e) => put(k, { ...(cur as object), from: e.target.value } as never)} />
      </Field>
    );
  };
  return (
    <div className="tb-stack">
      <Field label={`Operation of ${step.id}`} hint="No AI and no I/O: deterministic shaping of data.">
        <NativeSelect value={op} onChange={(e) => onChange(start(e.target.value as TransformOp))} options={TRANSFORM_OPS.map((k) => ({ value: k, label: k }))} />
      </Field>
      {op === "pick" ? <JsonRefMap label={`Pick in ${step.id}`} value={step.pick} onChange={(pick) => put("pick", pick)} nameLabel="Field" /> : null}
      {op === "merge" ? (
        Array.isArray(step.merge) ? (
          <JsonField label={`Merge in ${step.id}`} hint="A list of refs; later ones win." value={step.merge} onChange={(v) => put("merge", (Array.isArray(v) ? v : []) as Json[])} rows={3} />
        ) : (
          <JsonRefMap label={`Merge in ${step.id}`} value={step.merge} onChange={(merge) => put("merge", merge)} nameLabel="Field" />
        )
      ) : null}
      {op === "rename" && step.rename ? (
        <>
          {from("rename", `Rename the object at (${step.id})`)}
          <RefMap label={`Names in ${step.id}`} hint="Old name → new name." value={step.rename.map} onChange={(map) => put("rename", { ...(step.rename as NonNullable<TransformStep["rename"]>), map })} nameLabel="Field" refLabel="New name" />
        </>
      ) : null}
      {op === "concat" && step.concat ? (
        <>
          <JsonField label={`Items of ${step.id}`} hint="A list of refs or text to join." value={step.concat.items} onChange={(v) => put("concat", { ...(step.concat as NonNullable<TransformStep["concat"]>), items: (Array.isArray(v) ? v : []) as Json[] })} rows={4} />
          <Field label={`Separator of ${step.id}`}>
            <TextInput value={step.concat.separator ?? ""} onChange={(e) => put("concat", { ...(step.concat as NonNullable<TransformStep["concat"]>), separator: e.target.value })} />
          </Field>
        </>
      ) : null}
      {op === "map" && step.map ? (
        <>
          <Field label={`For each in ${step.id}`}>
            <TextInput className="mono" value={step.map.forEach ?? ""} onChange={(e) => put("map", { ...(step.map as NonNullable<TransformStep["map"]>), forEach: e.target.value })} />
          </Field>
          <JsonField label={`Template of ${step.id}`} hint="What each item becomes. Use {{ $item.field }}." value={step.map.template} onChange={(template) => put("map", { ...(step.map as NonNullable<TransformStep["map"]>), template: (template ?? null) as Json })} />
        </>
      ) : null}
      {op === "filter" && step.filter ? (
        <>
          {from("filter", `List to filter (${step.id})`)}
          <JsonField label={`Keep when (${step.id})`} hint="A small expression on $item." value={step.filter.where} onChange={(where) => put("filter", { ...(step.filter as NonNullable<TransformStep["filter"]>), where: (where ?? null) as Json })} rows={3} />
        </>
      ) : null}
      {op === "template" ? (
        <Field label={`Text template of ${step.id}`} hint="Use {{ ref }}.">
          <Textarea rows={4} value={step.template ?? ""} onChange={(e) => onChange({ ...step, template: e.target.value })} />
        </Field>
      ) : null}
      {op === "dedupe" && step.dedupe ? (
        <div className="two">
          {from("dedupe", `List to dedupe (${step.id})`)}
          <Field label={`Key of ${step.id}`} hint="Optional field that decides what is a duplicate.">
            <TextInput value={step.dedupe.by ?? ""} onChange={(e) => put("dedupe", { ...(step.dedupe as NonNullable<TransformStep["dedupe"]>), by: e.target.value || undefined })} />
          </Field>
        </div>
      ) : null}
      {op === "sort" && step.sort ? (
        <div className="three">
          {from("sort", `List to sort (${step.id})`)}
          <Field label={`Sort by (${step.id})`}>
            <TextInput value={step.sort.by ?? ""} onChange={(e) => put("sort", { ...(step.sort as NonNullable<TransformStep["sort"]>), by: e.target.value || undefined })} />
          </Field>
          <Field label={`Order of ${step.id}`}>
            <NativeSelect
              value={step.sort.order ?? "asc"}
              onChange={(e) => put("sort", { ...(step.sort as NonNullable<TransformStep["sort"]>), order: e.target.value as "asc" | "desc" })}
              options={[
                { value: "asc", label: "ascending" },
                { value: "desc", label: "descending" },
              ]}
            />
          </Field>
        </div>
      ) : null}
      {op === "normalise" && step.normalise ? (
        <div className="three">
          {from("normalise", `Value to normalise (${step.id})`)}
          <Field label={`Fields of ${step.id}`} hint="Optional: only these fields of an object (comma separated).">
            <TextInput
              value={(step.normalise.fields ?? []).join(", ")}
              onChange={(e) => {
                const fields = e.target.value
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean);
                const { fields: _f, ...rest } = step.normalise as NonNullable<TransformStep["normalise"]>;
                put("normalise", fields.length ? { ...rest, fields } : rest);
              }}
            />
          </Field>
          <Field label={`Operations of ${step.id}`} hint={`${NORMALISE_OPS.join(", ")} (comma separated).`}>
            <TextInput
              value={(step.normalise.ops ?? []).join(", ")}
              onChange={(e) =>
                put("normalise", {
                  ...(step.normalise as NonNullable<TransformStep["normalise"]>),
                  ops: e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter((x): x is NormaliseOpName => (NORMALISE_OPS as readonly string[]).includes(x)),
                })
              }
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function ApprovalFields({ step, onChange }: { step: ApprovalStep; onChange: (s: Step) => void }) {
  return (
    <div className="tb-stack">
      <Field label={`Question of ${step.id}`} hint="The title you see in Inbox.">
        <TextInput value={step.title ?? ""} onChange={(e) => onChange({ ...step, title: e.target.value })} />
      </Field>
      <Field label={`Context of ${step.id}`} hint="What the owner needs to decide. Use {{ ref }}.">
        <Textarea rows={3} value={step.context ?? ""} onChange={(e) => onChange({ ...step, context: e.target.value || undefined })} />
      </Field>
      <div className="two">
        <NumberField label={`Wait up to (s) for ${step.id}`} value={step.timeoutSec} onChange={(timeoutSec) => onChange({ ...step, timeoutSec })} />
        <Field label={`If denied (${step.id})`}>
          <NativeSelect
            value={step.onDeny ?? "stop"}
            onChange={(e) => onChange({ ...step, onDeny: e.target.value as ApprovalStep["onDeny"] })}
            options={[
              { value: "stop", label: "stop the run" },
              { value: "continue", label: "continue" },
            ]}
          />
        </Field>
      </div>
    </div>
  );
}

function TimerFields({ step, onChange }: { step: TimerStep; onChange: (s: Step) => void }) {
  const until = step.until !== undefined;
  const { seconds: _s, until: _u, ...rest } = step;
  return (
    <div className="two">
      <Field label={`Wait for (${step.id})`}>
        <NativeSelect
          value={until ? "until" : "seconds"}
          onChange={(e) => onChange(e.target.value === "until" ? { ...rest, until: "$input." } : { ...rest, seconds: 60 })}
          options={[
            { value: "seconds", label: "a number of seconds" },
            { value: "until", label: "until a time (ref)" },
          ]}
        />
      </Field>
      {until ? (
        <Field label={`Until (${step.id})`} hint="A ref to a time.">
          <TextInput className="mono" value={step.until ?? ""} onChange={(e) => onChange({ ...rest, until: e.target.value })} />
        </Field>
      ) : (
        <NumberField label={`Seconds of ${step.id}`} value={step.seconds} onChange={(seconds) => onChange({ ...rest, seconds })} />
      )}
    </div>
  );
}

function WorkflowFields({ step, onChange }: { step: WorkflowStep; onChange: (s: Step) => void }) {
  return (
    <div className="tb-stack">
      <div className="three">
        <Field label={`Workflow of ${step.id}`} hint="The id of a saved workflow. It runs as one step (at most 3 levels deep).">
          <TextInput value={step.workflow ?? ""} onChange={(e) => onChange({ ...step, workflow: e.target.value })} />
        </Field>
        <NumberField label={`Version of ${step.id}`} hint="Optional. Empty = the active version." value={step.version} onChange={(version) => onChange({ ...step, version })} />
        <Field label={`On failure of ${step.id}`}>
          <NativeSelect
            value={step.onFail ?? "stop"}
            onChange={(e) => onChange({ ...step, onFail: e.target.value as WorkflowStep["onFail"] })}
            options={[
              { value: "stop", label: "stop the run" },
              { value: "continue", label: "continue" },
              { value: "ask", label: "ask me" },
            ]}
          />
        </Field>
      </div>
      <JsonField label={`Input of ${step.id}`} hint="What the saved workflow gets. Refs work here too." value={step.input ?? {}} onChange={(v) => onChange({ ...step, input: (v ?? {}) as JsonObject })} rows={4} />
    </div>
  );
}
