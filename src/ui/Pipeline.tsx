// Pipeline contract pieces of the owner UI (C288 R10): the import report in plain words, and the JSON download.
// Everything here shows data the owner pasted or that came from the owner's own contract; person ops only.
import { Notice } from "@opt2-tealbrick/ui";
import type { Out } from "./ops.ts";

type Report = Out<"pipeline_import">["report"];
export type PipelineInfo = NonNullable<Out<"draft_get">["pipeline"]>;

/** "Imported from pipeline contract p1-daily-tidbit v1" */
export const importedFrom = (id: string, version: number): string => `Imported from pipeline contract ${id} v${version}`;

/** The import report, in plain words. `report` is the one stored with the draft. */
export function ImportReportView({ report }: { report: Report }) {
  const tools = report.unmapped.tools;
  const hint = report.schedule_hint;
  const when = [hint.cron ? `cron ${hint.cron} (${hint.timezone ?? "no time zone"})` : null, hint.event ? `event ${hint.event}` : null, hint.once ? "one time" : null].filter(Boolean).join("; ");
  return (
    <section className="tb-stack import-report" aria-label="Import report">
      <h3>Import report</h3>
      <details>
        <summary>Mapped to this draft ({report.mapped.length})</summary>
        <ul className="plain">
          {report.mapped.map((m) => (
            <li key={`${m.from}>${m.to}`}>
              {m.from} to {m.to}
            </li>
          ))}
        </ul>
      </details>
      {tools.length ? (
        <Notice tone="needs-you" role="status">
          <strong>Not mapped: {tools.length === 1 ? "1 tool is" : `${tools.length} tools are`} not a Teal Brick operation.</strong> Evolution does not list or enforce {tools.length === 1 ? "it" : "them"}.
          <ul className="plain">
            {tools.map((t) => (
              <li key={`${t.step}:${t.tool}`}>
                Step {t.step}: {t.tool}
              </li>
            ))}
          </ul>
        </Notice>
      ) : (
        <p className="tb-soft">Not mapped: no tools. Every tool of the contract is a Teal Brick operation, or the contract names none.</p>
      )}
      <p className="tb-soft">
        Kept as data, not enforced:{" "}
        {report.kept_as_data.length ? report.kept_as_data.map((k) => (k.steps ? `${k.field} (steps ${k.steps.join(", ")})` : k.field)).join("; ") : "nothing"}.
      </p>
      <p className="tb-soft">
        Trigger: {when || "none"}. No schedule was created. {hint.cron ? "Create the schedule yourself on the Schedules page. Schedules run in UTC." : ""}
      </p>
      <p className="tb-soft">Metrics named by the contract: {report.metrics_keys.length ? report.metrics_keys.join(", ") : "none"}.</p>
      {report.notes.length ? (
        <ul className="plain">
          {report.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Save an object as a JSON file through the browser (the same way the recipe download works). */
export function downloadJson(fileName: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
