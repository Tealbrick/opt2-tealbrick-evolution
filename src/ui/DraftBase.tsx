// A draft of an existing workflow, against the version that is active now: the same "allows more than" rule the
// Workflows page uses (`widens`), and a warning when the active version moved after the draft was based on it (C288 R10).
import { Notice } from "@opt2-tealbrick/ui";
import { useEffect, useState } from "react";
import { type Out, person } from "./ops.ts";

export type Allowed = Out<"workflow_versions">["versions"][number]["allowed"];

/** Same rule as the server's diff (src/model.ts diffSnapshots `widensAccess`): an operation or an access kind was added. */
export function widens(from: Allowed, to: Allowed): boolean {
  const ops = (a: Allowed) => new Set(a.flatMap((x) => x.operations.map((o) => `${x.product}.${o}`)));
  const crud = (a: Allowed) => new Set(a.flatMap((x) => x.crud.map((c) => `${x.product}:${c}`)));
  const opsFrom = ops(from);
  const crudFrom = crud(from);
  return [...ops(to)].some((k) => !opsFrom.has(k)) || [...crud(to)].some((k) => !crudFrom.has(k));
}

export function DraftBase({ workflowId, allowed, baseVersion }: { workflowId: string | null; allowed: Allowed; baseVersion: number | null }) {
  const [data, setData] = useState<Out<"workflow_versions"> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!workflowId) return;
    setFailed(false);
    person("workflow_versions", { workflowId })
      .then(setData)
      .catch(() => setFailed(true));
  }, [workflowId]);
  if (!workflowId) return null;
  if (failed) return <p className="tb-hint">The active version of this workflow could not be loaded, so this draft was not compared with it.</p>;
  if (!data) return null;
  const active = data.workflow.activeVersion;
  const current = data.versions.find((v) => v.version === active);
  return (
    <>
      {current && widens(current.allowed, allowed) ? (
        <Notice tone="needs-you" role="status">
          <strong>This draft allows more than v{active}, the active version.</strong> An existing Bound agent keeps its old operation list until you change its policy in Portal.
        </Notice>
      ) : null}
      {baseVersion !== null && active > baseVersion ? (
        <Notice tone="needs-you" role="status">
          <strong>
            This draft is based on v{baseVersion}; v{active} is now active.
          </strong>{" "}
          Check what changed before you promote.
        </Notice>
      ) : null}
    </>
  );
}
