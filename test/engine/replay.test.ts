// CI replays the STORED histories (ENGINE-BUILD §2) against the current interpreter before a tag: a change to the workflow
// code that would break a run in flight fails here. A change of behaviour must be wrapped in patched(); then record a new
// history (test/engine/record-histories.ts) and keep the old files, which must keep replaying.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { workflowBundle } from "./harness.ts";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const histories = readdirSync(dir).filter((f) => f.startsWith("history-") && f.endsWith(".json"));

test("there are stored histories to replay (a deleted fixture must not turn this test off)", () => {
  assert.ok(histories.includes("history-example-a.json") && histories.includes("history-composite.json"), histories.join(","));
});

for (const f of histories) {
  test(`replay: ${f} runs through the current interpreter without a determinism error`, async () => {
    const json = JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as unknown;
    await Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, json, `replay-${f}`);
  });

  test(`fire on bad: ${f} with a changed command order fails the replay`, async () => {
    // the history says the first activity was appStep; make it a different activity type: the interpreter would schedule appStep
    const text = readFileSync(`${dir}${f}`, "utf8").replace(/"activityType":\s*\{\s*"name":\s*"appStep"\s*\}/, '"activityType":{"name":"aiStep"}');
    assert.ok(text.includes('"aiStep"'), "the fixture has an appStep to change");
    await assert.rejects(Worker.runReplayHistory({ workflowBundle: await workflowBundle() }, JSON.parse(text) as unknown, `bad-${f}`), /Nondeterminism|determinis|does not match/i);
  });
}
