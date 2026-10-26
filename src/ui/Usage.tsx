// What a workflow version uses: ops, CRUD and scopes, with the honest grant label (ENGINE-BUILD §4). Used by the editor's
// "Check against installed apps" and by the activation review.
import { Notice, Table, Tag } from "@opt2-tealbrick/ui";
import type { Issue } from "./engine-contract.ts";
import { GRANT_LABEL, type UsageRow } from "./engine-ops.ts";

export function Issues({ errors, warnings }: { errors: Issue[]; warnings: Issue[] }) {
  if (errors.length === 0 && warnings.length === 0) return null;
  return (
    <ul className="plain issues">
      {errors.map((e, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list in the order the validator gave it
        <li key={`e${i}`} className="issue issue-error">
          <Tag status="needs-you">problem</Tag> <code className="code-ops">{e.pointer || "/"}</code> {e.message}
        </li>
      ))}
      {warnings.map((w, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a read-only list in the order the validator gave it
        <li key={`w${i}`} className="issue issue-warning">
          <Tag status="idle">note</Tag> <code className="code-ops">{w.pointer || "/"}</code> {w.message}
        </li>
      ))}
    </ul>
  );
}

const EFFECT: Record<UsageRow["effect"], "default" | "needs-you"> = { read: "default", write: "default", outward: "needs-you", money: "needs-you" };

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
              <tr key={`${r.product}.${r.op}.${r.scope ?? ""}`}>
                <td>{r.product}</td>
                <td>
                  <code className="code-ops">{r.op}</code>
                </td>
                <td>
                  <Tag status={EFFECT[r.effect]}>{r.crud.join(", ")}</Tag>
                </td>
                <td>{r.scope ?? "–"}</td>
                <td>{r.held ? "Owner approves each call" : "–"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
