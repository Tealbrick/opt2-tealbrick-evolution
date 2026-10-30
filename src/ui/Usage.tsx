// What a workflow version uses: ops, CRUD and scopes, with the honest grant label (ENGINE-BUILD §4). Used by the editor's
// "Check against installed apps" and by the activation review.
import { Button, Notice, Table, Tag } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";
import { type ConnectAccess, engine, GRANT_LABEL, type UsageRow } from "./engine-ops.ts";
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

/** What one tool class needs from the owner. The hold rule is Connect's own; this page only says it. */
const CONNECT_TOOL_NEEDS: Record<string, string> = {
  read: "reads; needs the account shared with this app.",
  write: "writes, for example a draft; needs the account shared for writes. It runs with no approval, unless a Rules hold asks you.",
  outward: "sends or posts; needs the account shared for writes, and the call must wait for your approval: use the tool's first-contact form, or hold outward calls from apps in the workspace policy. A Rules hold alone ends in a refusal, after you approve.",
  destructive: "deletes; a workflow cannot call this tool. Connect refuses it.",
  money: "moves money; a workflow cannot call this tool. Connect refuses it.",
};

/** The Connect part of the review: the class of each tool this version names, and the accounts shared with this app. */
function ConnectAccessNotes({ tools }: { tools: string[] }) {
  const [access, setAccess] = useState<ConnectAccess | null>(null);
  const key = tools.join(",");
  useEffect(() => {
    let live = true;
    engine("connect_access", { tools: key ? key.split(",") : [] })
      .then((r) => {
        if (live) setAccess(r);
      })
      .catch(() => {
        if (live) setAccess({ available: false, accounts: [], tools: [] });
      });
    return () => {
      live = false;
    };
  }, [key]);
  if (access === null) return null;
  if (!access.available) {
    return <Notice role="status">{CONNECT_SHARE}</Notice>;
  }
  return (
    <Notice tone="needs-you" role="status">
      <ul className="plain">
        {access.tools.map((t) => (
          <li key={t.tool}>
            <code className="code-ops">{t.tool}</code> {t.known ? (CONNECT_TOOL_NEEDS[t.effect ?? ""] ?? "needs your review.") : "is not a tool Connect knows now. Connect refuses an unknown tool."}
          </li>
        ))}
        <li>
          {access.accounts.length === 0
            ? "No Connect account is shared with this app yet. Share one on Connect's accounts page."
            : `Shared with this app: ${access.accounts.map((a) => `${a.label} (${a.writes ? "read and write" : "read only"})`).join(", ")}.`}
        </li>
      </ul>
    </Notice>
  );
}

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
      {rows.some((r) => r.tools?.length) ? <p className="tb-hint">For an operation that calls tools by name (Connect tools), the engine refuses any tool not named here, and Connect checks the class of every tool on each call.</p> : null}
      {rows.filter(usesConnectTools).map((r) => (
        <ConnectAccessNotes key={`${r.product}.${r.op}.share`} tools={r.tools ?? []} />
      ))}
    </div>
  );
}
