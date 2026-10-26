import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import type { notImplementedModels } from "../../src/engine/agent-port.ts";
import type { WorkflowContract } from "../../src/engine/contract.ts";
import { type Env, startEnv } from "./harness.ts";

const exampleA = JSON.parse(readFileSync(new URL("./fixtures/example-a.json", import.meta.url), "utf8")) as WorkflowContract;
let t: Env;
before(async () => {
  t = await startEnv({ models: { async run(req) { return { output: { bullets: ["one", "two"], needsReply: ["Bob"] }, tokensIn: 10, tokensOut: 5 }; } } as typeof notImplementedModels });
});
after(async () => {
  await t.stop();
});

test("example A runs end to end with a fake callApp and a fake summarize step", async () => {
  t.install(exampleA);
  t.apps.on["connect.tools"] = (input) => {
    const i = input as { tool: string };
    if (i.tool === "gmail_fetch_emails") return { result: { messages: [{ from: "a@x.org", subject: "Hi", snippet: "hello", extra: 1 }] } };
    return { result: { id: "draft_1" } };
  };
  const res = await t.run({ workflowId: "daily-email-summary", trigger: { kind: "manual", input: { account: "acc1", me: "me@x.org" } } });
  assert.equal(res.status, "completed");
  assert.deepEqual(res.outputs, { draftId: "draft_1" });
  console.log(JSON.stringify(t.apps.calls, null, 1));
});
