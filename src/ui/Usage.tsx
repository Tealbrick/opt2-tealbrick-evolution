// What a workflow version uses: ops, CRUD and scopes, with the honest grant label (ENGINE-BUILD §4). Used by the editor's
// "Check against installed apps" and by the activation review.
import { Button, Notice, Table, Tag } from "@opt2-tealbrick/ui";
import { GRANT_LABEL, type UsageRow } from "./engine-ops.ts";
import { plainIssues } from "./FieldIssues.tsx";

/** A problem or note: the live check gives a `pointer`, the engine gives a `path` (the same JSON pointer) and also `pointer`. */
export interface IssueView {
  pointer?: string;
  path?: string;
  message: string;
}

/** `onShow`: a Show button per problem that takes the owner to its field (the editor). */
export function Issues({ errors, warnings, onShow }: { errors: readonly IssueView[]; warnings: readonly IssueView[]; onShow?: (pointer: string) => void }) {
  if (errors.length === 0 && warnings.length === 0) return null;
  const shownErrors = plainIssues(errors);
  const shownWarnings = plainIssues(warnings);
  return (
    <ul className="plain issues">
      {shownErrors.map((e, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list in the order the validator gave it
        <li key={`e${i}`} className="issue issue-error">
          <Tag status="needs-you">problem</Tag> <code className="code-ops">{e.pointer || e.path || "/"}</code> {e.message}
          {onShow ? <ShowButton pointer={e.pointer ?? e.path ?? ""} onShow={onShow} /> : null}
        </li>
      ))}
      {shownWarnings.map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list in the order the validator gave it
        <li key={`w${i}`} className="issue issue-warning">
          <Tag status="idle">note</Tag> <code className="code-ops">{w.pointer || w.path || "/"}</code> {w.message}
          {onShow ? <ShowButton pointer={w.pointer ?? w.path ?? ""} onShow={onShow} /> : null}
        </li>
      ))}
    </ul>
  );
}

function ShowButton({ pointer, onShow }: { pointer: string; onShow: (pointer: string) => void }) {
  return (
    <>
      {" "}
      <Button size="sm" aria-label={`Show ${pointer || "/"}`} onClick={() => onShow(pointer)}>
        Show
      </Button>
    </>
  );
}

// the engine reports the effect as a string; anything but a plain read or write needs the owner's eye
const EFFECT: Record<string, "default" | "needs-you"> = { read: "default", write: "default" };

/** F-P5: Connect `tools` is scoped by account: until the owner shares the account with this app, the step fails with scope_denied. */
export const CONNECT_SHARE = "On Connect's accounts page, share the account this step uses with Evolving Workflows.";
const usesConnectTools = (r: UsageRow): boolean => r.product === "connect" && r.op === "tools" && !r.via;

export function UsageTable({ rows }: { rows: UsageRow[] }) {
  return (
    <div className="tb-stack">
      <Notice role="status">{GRANT_LABEL}</Notice>
      {rows.length === 0 ? (
        <p className="tb-soft">This version calls no app: it is fully deterministic or only shapes data.</p>
      ) : (
        <Table aria-label="Operations this version uses">
          <thead>
            <tr>
              <th scope="col">App</th>
              <th scope="col">Operation</th>
              <th scope="col">Access</th>
              <th scope="col">Scope</th>
              <th scope="col">Held</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.product}.${r.op}.${r.scope ?? ""}.${r.tools?.join(",") ?? ""}`}>
                <td>{r.product}</td>
                <td>
                  <code className="code-ops">{r.op}</code>
                  {r.tools?.length ? <span className="tb-soft"> ({r.tools.join(", ")})</span> : null}
                </td>
                <td>
                  <Tag status={EFFECT[r.effect] ?? "needs-you"}>{r.crud.join(", ")}</Tag>
                </td>
                <td>{r.scope ?? "–"}</td>
                <td>{r.held ? "Owner approves each call" : "–"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {rows.some((r) => r.tools?.length) ? <p className="tb-hint">For an operation that calls tools by name (Connect tools), the engine refuses any tool not named here. Connect lets a workflow call only the read tools of an account you shared with it; it refuses a tool that sends or changes something.</p> : null}
      {rows.filter(usesConnectTools).map((r) => (
        <Notice key={`${r.product}.${r.op}.share`} tone="needs-you" role="status">
          {`${r.tools?.length ? `${r.tools.join(", ")}: ` : ""}${CONNECT_SHARE}`}
        </Notice>
      ))}
    </div>
  );
}
