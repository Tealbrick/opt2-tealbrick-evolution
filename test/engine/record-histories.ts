// biome-ignore-all lint/suspicious/noThenProperty: a condition step of the workflow contract has a `then` field
// Records the histories that test/engine/replay.test.ts replays. Run it ONLY when the interpreter changes ON PURPOSE and the
// change is guarded by patched(): the OLD histories must keep replaying, so add new files and keep the old ones.
//   node test/engine/record-histories.ts <name>     (names: example-a, composite)
import { readFileSync, writeFileSync } from "node:fs";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import type { WorkflowContract } from "../../src/engine/contract.ts";
import type { Json } from "../../src/engine/json.ts";
import { read, startEnv, wf } from "./harness.ts";

const name = process.argv[2];
const t = await startEnv({
  codec: false,
  models: {
    async run() {
      return { output: { bullets: ["one", "two"], needsReply: ["Bob"] }, tokensIn: 10, tokensOut: 5 };
    },
  } as never,
});
try {
  let c: WorkflowContract;
  let input: Record<string, Json> = {};
  if (name === "example-a") {
    c = JSON.parse(readFileSync(new URL("./fixtures/example-a.json", import.meta.url), "utf8")) as WorkflowContract;
    input = { account: "acc1", me: "me@x.org" };
    t.apps.on["connect.tools"] = (i) => ((i as { tool: string }).tool === "gmail_fetch_emails" ? { result: { messages: [{ from: "a@x.org", subject: "Hi", snippet: "hello" }] } } : { result: { id: "draft_1" } });
  } else if (name === "composite") {
    c = wf(
      [
        { id: "cond", type: "condition", if: { "==": ["$trigger.input.go", true] }, then: [{ ...read("yes", { input: { query: "yes" } }), outputSchema: { type: "object" } }], else: [] },
        { id: "lp", type: "loop", forEach: "$trigger.input.xs", max: 10, steps: [{ ...read("one", { input: { query: "{{ $loop.item }}" } }), outputSchema: { type: "object" } }] },
        { id: "par", type: "parallel", branches: { a: [{ id: "ta", type: "transform", template: "a" }], b: [{ id: "nap", type: "timer", seconds: 60 }, { id: "tb", type: "transform", template: "b" }] } },
        { id: "tf", type: "transform", sort: { from: "$steps.lp.output.items", by: "q", order: "desc" } },
      ],
      { id: "composite-flow", inputs: { type: "object", properties: { go: { type: "boolean" }, xs: { type: "array", items: { type: "string" } } } } },
    );
    input = { go: true, xs: ["p", "q", "r"] };
    t.apps.on["knowledge.recall"] = (i) => ({ q: (i as { query: string }).query });
  } else throw new Error("usage: node test/engine/record-histories.ts example-a|composite");
  t.install(c);
  const runId = "run_hist";
  await t.run({ workflowId: c.id, runId, trigger: { kind: "manual", input } });
  const history = await t.client.workflow.getHandle(`evo:${c.id}:${runId}`).fetchHistory();
  const out = new URL(`./fixtures/history-${name}.json`, import.meta.url);
  writeFileSync(out, `${historyToJSON(history)}\n`);
  console.log(`wrote ${out.pathname} (${history.events?.length} events)`);
} finally {
  await t.stop();
}
