// Suggestions page: review what agents (and the Task Board detector) suggest; decide; start a draft from an approved one.
import { accessFilter, appName, Button, Chip, ChipGroup, Dialog, EmptyState, Field, ListFilter, Notice, type Status, Swatch, Tag, TextInput, useAccessFilter } from "@opt2-tealbrick/ui";
import { useCallback, useEffect, useState } from "react";
import { FILTER_FROM, filterKey } from "./filtering.ts";
import { day, errorText, type Out, person, stamp } from "./ops.ts";

type SuggestionStatus = "open" | "approved" | "rejected" | "archived";
type Filter = SuggestionStatus | "all";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "open", label: "To review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "archived", label: "Archived" },
  { value: "all", label: "All" },
];
const STATUS: Record<SuggestionStatus, { status: Status; label: string }> = {
  open: { status: "busy", label: "To review" },
  approved: { status: "live", label: "Approved" },
  rejected: { status: "needs-you", label: "Rejected" },
  archived: { status: "default", label: "Archived" },
};
/** `review_suggestions` answers the newest 100 by default and 200 at most, no cursor. The status chips are the server's; the text filter reads the loaded rows. */
const SUGGESTIONS_FIRST = 100;
const SUGGESTIONS_MOST = 200;
const opsOf = (ops: { product: string; operation: string }[]) => ops.map((o) => `${o.product}.${o.operation}`).join(", ");

export function Suggestions({
  names,
  onDraft,
  onOpenCount,
}: {
  names: (id: string | null) => string;
  onDraft: (draftId: string) => void;
  /** the number of suggestions waiting for review, for the nav count */
  onOpenCount: (n: number) => void;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useAccessFilter(filterKey("suggestions"));
  const [limit, setLimit] = useState(SUGGESTIONS_FIRST);
  const [loadingMore, setLoadingMore] = useState(false);
  const [rows, setRows] = useState<Out<"review_suggestions">["suggestions"] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanStatus, setScanStatus] = useState<Out<"detector_status"> | null>(null);

  const load = useCallback(async () => {
    try {
      const out = await person("review_suggestions", filter === "all" ? { limit } : { status: filter, limit });
      setRows(out.suggestions);
      if (filter === "open") onOpenCount(out.suggestions.length);
      setScanStatus(await person("detector_status", {}));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoadingMore(false);
    }
  }, [filter, limit, onOpenCount]);
  useEffect(() => {
    void load();
  }, [load]);

  const textFilter = accessFilter(query);
  const loaded = rows ?? [];
  const shownRows = loaded.filter((s) => textFilter.test([s.title, s.source === "detector" ? "Task Board detector" : "agent", s.agentId ? names(s.agentId) : "", STATUS[s.status].label, day(s.createdAt)].join(" ")));
  const more = loaded.length >= limit;
  const filterOn = query.trim() !== "";
  // suggestions that wait for a review and the filter hides: the owner is told, so none is forgotten
  const hiddenOpen = loaded.filter((s) => s.status === "open").length - shownRows.filter((s) => s.status === "open").length;
  const showBar = rows !== null && (loaded.length >= FILTER_FROM || more || filterOn);
  const showOlder = () => {
    setLoadingMore(true);
    setLimit(SUGGESTIONS_MOST);
  };

  const scan = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await person("detector_scan", {});
      setNotice(
        r.kanban === "ok"
          ? `Task Board scan: ${r.issuesSeen} done issues read, ${r.created.length} new suggestion(s), ${r.updated.length} updated.`
          : (r.message ?? "Task Board is not available."),
      );
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="app-page" aria-label="Suggestions">
      <div className="page-head">
        <h1>Suggestions</h1>
      </div>
      <div className="toolbar">
        <ChipGroup label="Status">
          {FILTERS.map((f) => (
            <Chip key={f.value} pressed={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label}
            </Chip>
          ))}
        </ChipGroup>
        <Button onClick={() => void scan()} disabled={busy}>
          {busy ? "Scanning" : "Scan Task Board"}
        </Button>
      </div>
      <p className="tb-hint">
        {scanStatus?.lastScanAt
          ? `Task Board last read ${stamp(scanStatus.lastScanAt)} (${scanStatus.trigger === "owner" ? "by you" : "in the background"}): ${
              scanStatus.kanban === "ok" ? `${scanStatus.issuesSeen} done issues, ${scanStatus.created} new suggestion(s)` : (scanStatus.message ?? "not available")
            }. Evolving Workflows reads Task Board every ${scanStatus.intervalMinutes} minutes.`
          : scanStatus
            ? `Evolving Workflows reads Task Board every ${scanStatus.intervalMinutes} minutes; no scan yet.`
            : null}{" "}
        It suggests work that one agent finished at least three times, but only in the projects you share with it in Task Board (shared projects, or projects you grant to Evolving Workflows on the Task Board scopes page).
      </p>
      {error ? (
        <Notice tone="needs-you" role="alert">
          {error}
        </Notice>
      ) : null}
      {notice ? <Notice role="status">{notice}</Notice> : null}
      {rows === null ? (
        error ? null : (
          <p className="tb-soft" role="status">
            Loading suggestions.
          </p>
        )
      ) : rows.length === 0 ? (
        <EmptyState title="No suggestions here." />
      ) : (
        <>
          {showBar ? (
            <ListFilter
              label="Filter the suggestions"
              value={query}
              onChange={setQuery}
              filter={textFilter}
              placeholder="Title, agent, or a regex"
              noun={{ one: "suggestion", many: "suggestions" }}
              shown={shownRows.length}
              total={loaded.length}
              more={more}
              onClear={() => setQuery("")}
              onLoadMore={limit < SUGGESTIONS_MOST ? showOlder : undefined}
              loadingMore={loadingMore}
              hidden={hiddenOpen}
              hiddenNoun={{ one: "suggestion that waits for your review", many: "suggestions that wait for your review" }}
            />
          ) : null}
        <div className="ruled">
          {shownRows.map((s) => (
            <div className="item" key={s.id}>
              <Swatch open={s.source === "detector"} />
              <h3>
                {s.title} <Tag status={STATUS[s.status].status}>{STATUS[s.status].label}</Tag> <Tag>{s.source === "detector" ? "Task Board detector" : "agent"}</Tag>
              </h3>
              <span className="meta">{[s.agentId ? names(s.agentId) : null, `${s.evidenceCount} evidence`, day(s.createdAt)].filter(Boolean).join(" · ")}</span>
              <div className="side">
                <Button size="sm" onClick={() => setSelected(s.id)} aria-label={`Review ${s.title}`}>
                  Review
                </Button>
              </div>
            </div>
          ))}
        </div>
        </>
      )}
      {selected ? <Detail id={selected} names={names} onClose={() => setSelected(null)} onChanged={load} onDraft={onDraft} /> : null}
    </section>
  );
}

function Detail({
  id,
  names,
  onClose,
  onChanged,
  onDraft,
}: {
  id: string;
  names: (id: string | null) => string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onDraft: (id: string) => void;
}) {
  const [d, setD] = useState<Out<"review_suggestion"> | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const reload = useCallback(async () => setD(await person("review_suggestion", { id })), [id]);
  useEffect(() => {
    reload().catch((e) => setError(errorText(e)));
  }, [reload]);

  const s = d?.suggestion;
  const run = async (fn: () => Promise<void>) => {
    setWorking(true);
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(false);
    }
  };
  const decide = (decision: "approve" | "reject" | "archive") =>
    run(async () => {
      await person("suggestion_decide", { id, decision, ...(note.trim() ? { note: note.trim() } : {}) });
      await reload();
      await onChanged();
    });
  const draft = () =>
    run(async () => {
      const created = await person("draft_create", { suggestionId: id });
      onDraft(created.id);
    });

  return (
    <Dialog
      open
      size="lg"
      kicker="Suggestion"
      title={s?.title ?? "Suggestion"}
      onClose={onClose}
      busy={working}
      footer={
        s ? (
          <>
            {s.status !== "archived" ? (
              <Button disabled={working} onClick={() => void decide("archive")}>
                Archive
              </Button>
            ) : null}
            {s.status === "open" || s.status === "approved" ? (
              <Button disabled={working} onClick={() => void decide("reject")}>
                Reject
              </Button>
            ) : null}
            {s.status !== "approved" && s.status !== "archived" ? (
              <Button variant="primary" disabled={working} onClick={() => void decide("approve")}>
                Approve
              </Button>
            ) : null}
            {s.status === "approved" ? (
              <Button variant="primary" disabled={working} onClick={() => void draft()}>
                Start a draft
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      {!d || !s ? (
        error ? (
          <Notice tone="needs-you" role="alert">
            {error}
          </Notice>
        ) : (
          <p className="tb-soft" role="status">
            Loading.
          </p>
        )
      ) : (
        <div className="detail">
          <div className="toolbar">
            <Tag status={STATUS[s.status].status}>{STATUS[s.status].label}</Tag>
            <span className="tb-hint">
              Suggested by {s.createdBy.type === "agent" ? names(s.createdBy.id) : s.createdBy.name}
              {s.agentId && s.agentId !== s.createdBy.id ? ` about the work of ${names(s.agentId)}` : ""}.
            </span>
          </div>
          {s.summary ? <p className="tb-soft">{s.summary}</p> : null}
          <section className="tb-stack">
            <h3>Evidence</h3>
            <ul className="plain">
              {s.evidence.map((e) => (
                <li key={`${e.kind}:${e.ref}`}>
                  {e.kind === "kanban_issue" ? "Task Board issue" : `Receipt in ${e.product ? appName(e.product) : "an app"}`} <code className="code-ops">{e.ref}</code>
                  {e.title ? `, ${e.title}` : ""}
                  {e.note ? <span className="tb-hint"> ({e.note})</span> : null}
                </li>
              ))}
            </ul>
          </section>
          {s.steps.length ? (
            <section className="tb-stack">
              <h3>Proposed steps</h3>
              <ol className="steps-list">
                {s.steps.map((st) => (
                  <li key={st.id}>
                    <b>{st.title}</b>
                    <span>
                      {st.instruction}
                      {st.ops.length ? <span className="code-ops"> ({opsOf(st.ops)})</span> : null}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          <Field label="Note (optional)">
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
          {error ? (
            <Notice tone="needs-you" role="alert">
              {error}
            </Notice>
          ) : null}
          {d.drafts.length ? <p className="tb-hint">Drafts from this suggestion: {d.drafts.map((x) => `${x.title} (${x.state === "promoted" ? "promoted" : "editing"})`).join(", ")}</p> : null}
          <details className="history">
            <summary>History</summary>
            <ul className="tb-list">
              {d.events.map((e) => (
                <li key={`${e.at}${e.type}`}>
                  {stamp(e.at)}: {e.type} by {e.actor.type === "agent" ? names(e.actor.id) : e.actor.name}
                  {e.note ? `, ${e.note}` : ""}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </Dialog>
  );
}
