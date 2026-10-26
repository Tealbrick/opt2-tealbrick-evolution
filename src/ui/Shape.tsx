// The canonical-shape view (ENGINE-BUILD, Martin's shape): every workflow is drawn as
//   event → process → enrichment → concat → intelligence → result action
// Steps sit in the lane of their `stage` label; a step without a label sits where its kind says (marked "inferred"), and the
// flow-control steps (approval, timer, condition, loop) without a label sit in a lane of their own below. The intelligent
// lane is optional: a workflow without an `ai` step is fully deterministic, and the view says so.
import { Tag } from "@opt2-tealbrick/ui";
import { LANES, type Lane, type Placed, placeSteps, type Trigger, type WorkflowContract } from "./engine-contract.ts";

const LANE: Record<Lane, { title: string; text: string }> = {
  event: { title: "Event", text: "What starts a run." },
  process: { title: "Process", text: "Deterministic shaping: pick, merge, map, filter." },
  enrichment: { title: "Enrichment", text: "Reads from apps, in parallel where possible." },
  concat: { title: "Concat", text: "Put the pieces together for the intelligent step." },
  intelligence: { title: "Intelligence", text: "A model role or an agent card. Produces typed content only." },
  result: { title: "Result action", text: "A write that the ENGINE runs, with this workflow's own grant." },
};

export function triggerText(t: Trigger): string {
  switch (t.kind) {
    case "schedule":
      return `schedule ${t.cron ?? `every ${t.every ?? "?"}`} (${t.timezone || "no time zone"})`;
    case "manual":
      return "manual (Run now)";
    case "poll":
      return `poll ${t.product}.${t.op} every ${t.every}`;
    case "event":
      return `event ${t.type} from ${t.product}`;
  }
}

const KIND_LABEL = { app: "app", ai: "ai", transform: "transform", approval: "approval", timer: "timer", condition: "condition", loop: "loop", parallel: "parallel", workflow: "workflow" } as const;

function Chip({ p }: { p: Placed }) {
  const s = p.step;
  const who = s.type === "ai" ? ("role" in s.by ? `role ${s.by.role}` : `agent ${s.by.agent}`) : s.type === "app" ? `${s.product}.${s.op}` : s.type === "workflow" ? s.workflow : "";
  const where = p.within.join(" · ");
  return (
    <li className="lane-step" title={where || undefined}>
      <code className="code-ops">{s.id}</code> <Tag>{KIND_LABEL[s.type]}</Tag>
      {who ? <span className="tb-soft"> {who}</span> : null}
      {p.inferred && p.stage ? <span className="tb-soft"> (inferred)</span> : null}
      {where ? <span className="tb-soft"> in {where}</span> : null}
    </li>
  );
}

export function ShapeView({ contract }: { contract: WorkflowContract }) {
  const steps = Array.isArray(contract.steps) ? contract.steps : [];
  const placed = placeSteps(steps);
  const triggers = Array.isArray(contract.triggers) ? contract.triggers : [];
  const flow = placed.filter((p) => p.stage === null);
  const hasAi = placed.some((p) => p.step.type === "ai");
  return (
    <div className="tb-stack">
      <ol className="lanes" aria-label="Canonical shape: event, process, enrichment, concat, intelligence, result action">
        {LANES.map((stage) => {
          const here = stage === "event" ? [] : placed.filter((p) => p.stage === stage);
          return (
            <li key={stage} className="lane" data-stage={stage}>
              <h3>{LANE[stage].title}</h3>
              <p className="tb-hint">{LANE[stage].text}</p>
              <ul className="plain">
                {stage === "event"
                  ? triggers.map((t, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: triggers have no ids; the list is only read here
                      <li key={i} className="lane-step">
                        {triggerText(t)}
                      </li>
                    ))
                  : null}
                {here.map((p) => (
                  <Chip key={p.pointer} p={p} />
                ))}
                {stage === "intelligence" && !hasAi ? <li className="tb-soft">None: this workflow is fully deterministic.</li> : null}
                {stage !== "event" && stage !== "intelligence" && here.length === 0 ? <li className="tb-soft">–</li> : null}
                {stage === "event" && triggers.length === 0 ? <li className="tb-soft">No trigger yet.</li> : null}
              </ul>
            </li>
          );
        })}
      </ol>
      {flow.length ? (
        <section className="lane lane-flow" aria-label="Flow control">
          <h3>Flow control</h3>
          <p className="tb-hint">Waits and branches that have no stage label.</p>
          <ul className="plain">
            {flow.map((p) => (
              <Chip key={p.pointer} p={p} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
