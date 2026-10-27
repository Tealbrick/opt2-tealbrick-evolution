// Problems next to the field they are about (C367 D9 GUI pass). The live check and the engine both name a JSON pointer into
// the contract ("/steps/2/input/to", "/triggers/0/timezone"). The editor puts every issue in a context; each field says which
// pointer it edits (`at`) and shows the problems at that pointer or below it, under itself. A step or trigger card shows the
// problems that no field of it shows. The summary list above the editor links each problem to its field (`showIssue`).
import { Field } from "@opt2-tealbrick/ui";
import { createContext, type ReactNode, useContext } from "react";

export interface PointedIssue {
  /** JSON pointer into the contract ("" = the contract itself) */
  pointer: string;
  message: string;
  level: "error" | "warning";
}

const IssuesContext = createContext<readonly PointedIssue[]>([]);
export const IssuesProvider = IssuesContext.Provider;

/** True when `pointer` is `at` or below it ("/steps/1" covers "/steps/1/op", not "/steps/10"). */
export const covers = (at: string, pointer: string): boolean => pointer === at || pointer.startsWith(`${at}/`);

/** The issues at `at` or below it. */
export function useIssuesAt(at: string): PointedIssue[] {
  return useContext(IssuesContext).filter((i) => covers(at, i.pointer));
}

/** "to: must be an email" for an issue below the field, the plain message for one at the field. */
const textOf = (at: string, i: PointedIssue): string => (i.pointer === at ? i.message : `${i.pointer.slice(at.length + 1)}: ${i.message}`);

/** What a field shows: the errors as its error text, the notes after its hint. */
export function fieldText(at: string, issues: readonly PointedIssue[], hint?: ReactNode): { error?: string; hint?: ReactNode } {
  const errors = issues.filter((i) => i.level === "error").map((i) => textOf(at, i));
  const notes = issues.filter((i) => i.level === "warning").map((i) => `Note: ${textOf(at, i)}`);
  const hintText = notes.length ? (
    <>
      {hint ? <>{hint} </> : null}
      {notes.join(" ")}
    </>
  ) : (
    hint
  );
  return { ...(errors.length ? { error: errors.join(" ") } : {}), ...(hintText !== undefined ? { hint: hintText } : {}) };
}

/** A kit Field that knows the pointer it edits and shows the problems there. */
export function PField({ at, label, hint, children }: { at: string; label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const t = fieldText(at, useIssuesAt(at), hint);
  return (
    <div className="pfield" data-pointer={at}>
      <Field label={label} hint={t.hint} error={t.error}>
        {children}
      </Field>
    </div>
  );
}

/** The problems of a card (a step or a trigger at `at`) that none of its fields shows: those at the card itself, or under a key
 *  that has no field (`shown` = the keys its fields cover). */
export function CardIssues({ at, shown, hide }: { at: string; shown: { has(key: string): boolean }; hide?: RegExp }) {
  const left = useIssuesAt(at).filter((i) => {
    if (hide?.test(i.message)) return false;
    if (i.pointer === at) return true;
    const first = i.pointer.slice(at.length + 1).split("/")[0] ?? "";
    return !shown.has(first);
  });
  if (left.length === 0) return null;
  return (
    <ul className="plain issues card-issues" data-pointer={at}>
      {left.map((i, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list in the order the validator gave it
        <li key={n} className={i.level === "error" ? "issue issue-error" : "issue issue-warning"} role={i.level === "error" ? "alert" : undefined}>
          {i.level === "error" ? "Problem: " : "Note: "}
          {textOf(at, i)}
        </li>
      ))}
    </ul>
  );
}

/** Scroll to the field of a pointer (the nearest element that names it or a parent of it) and focus its control. */
export function showIssue(pointer: string): boolean {
  if (typeof document === "undefined") return false;
  let p = pointer;
  for (;;) {
    const el = [...document.querySelectorAll<HTMLElement>("[data-pointer]")].find((e) => e.dataset.pointer === p);
    if (el) {
      el.scrollIntoView?.({ block: "center" });
      el.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
      return true;
    }
    if (p === "") return false;
    p = p.slice(0, p.lastIndexOf("/"));
  }
}

const CASCADE = [/^must match "[^"]*" schema$/, /^must match exactly one schema in oneOf$/, /^must match a schema in anyOf$/];
const UNEVALUATED = /^must NOT have unevaluated properties$/;

/** The engine's schema messages as the owner reads them: the follow-on messages of a step-kind schema ("must match "then"
 *  schema", "must NOT have unevaluated properties") are dropped when a more precise problem at or under the same pointer
 *  says what is wrong; the common JSON Schema phrases are rewritten; a repeated problem is shown once. */
export function plainIssues<T extends { pointer?: string; path?: string; message: string }>(list: readonly T[]): T[] {
  const at = (i: T) => i.pointer ?? i.path ?? "";
  const noise = (m: string) => CASCADE.some((r) => r.test(m)) || UNEVALUATED.test(m);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const i of list) {
    if (noise(i.message) && list.some((o) => o !== i && !noise(o.message) && covers(at(i), at(o)))) continue;
    if (CASCADE.some((r) => r.test(i.message)) && list.some((o) => o !== i && UNEVALUATED.test(o.message) && at(o) === at(i))) continue;
    const message = rewrite(i.message);
    const key = `${at(i)}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...i, message });
  }
  return out;
}

function rewrite(m: string): string {
  let r = /^must NOT have fewer than (\d+) items?$/.exec(m);
  if (r) return r[1] === "1" ? "Add at least one item here (a step list needs at least one step)." : `Needs at least ${r[1]} items.`;
  r = /^must NOT have more than (\d+) items?$/.exec(m);
  if (r) return `At most ${r[1]} items.`;
  r = /^must have required property '([^']+)'$/.exec(m);
  if (r) return `${r[1]} is required.`;
  if (UNEVALUATED.test(m) || m === "must NOT have additional properties") return "This has a field that its kind does not take. Check the JSON view.";
  return m;
}
