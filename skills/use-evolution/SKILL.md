---
name: use-evolution
description: When and how to suggest a workflow for repeated work, and how a Bound agent reads its workflow.
---
# Using Evolution

{{agent.name}}, Evolution turns work you repeat into a workflow that the owner reviews. Nothing you suggest runs by itself.

## Suggest a workflow when you repeat work
- Suggest when you did the same kind of task three or more times, for example the same weekly report or the same triage.
- Call `evolution__suggestion_create` with a short `title`, a `summary` of what repeats, and `evidence`:
  - `{"kind": "kanban_issue", "ref": "<issue id>"}` for each Kanban issue of that work, or
  - `{"kind": "receipt", "ref": "<call id>", "product": "<app>"}` for calls you made.
- Add `steps` if you can: a title, a short instruction, and the operations each step used (`{"product": "kanban", "operation": "issue_create"}`).
- Always send an idempotency key with `suggestion_create`; the same key returns the first result.
- Do not suggest one-off work, and do not put secrets or personal data in a suggestion.
- Evolution also finds repeated work on the Kanban board by itself (every 15 minutes), but only in the projects the owner shares with Evolution. Log your work on the board so it can be found. Such suggestions show you issue ids only; the owner sees the details.
- Check the owner's decision with `evolution__suggestions_list` or `evolution__suggestion_get`. You see only your own suggestions.

## If you are a Bound agent
- Your scheduled runs come from your own runner (`tealbrick agent serve` in routines mode). It calls `evolution__routines_due`, claims one run with `evolution__routine_claim`, gives you the reviewed workflow, and reports the result with `evolution__routine_report`. Do not claim or report runs yourself while the runner is active.
- Read your workflow with `evolution__workflow_get` (the id is in your purpose text and in each run).
- You may call only the operations the workflow allows. The bridge refuses every other operation.
- The steps are the owner's reviewed guidance. Follow them. Each run already has a Kanban issue assigned to you (`kanbanIssueId` in the run); add comments there if you can, and Evolution closes it when the run is reported.
- Report metrics with the report that ends the run. `evolution__routine_report` takes an optional `metrics` object, only together with status `completed` or `failed`:
  - `ok` (true or false, required): did the run reach its goal; `minutes` (required, 0 to 10080): how long it took.
  - `retries` and `questions_to_martin` (whole numbers, 0 to 1000), if you know them.
  - `lessons` (at most 20 short texts, 1 to 280 characters each, each with real words or symbols): what to do differently next time. Only the owner reads them. Write plain notes, no secrets, no personal data.
  - `metrics` (an object of name to number: at most 20 names per report and 20 different names per workflow version; each value from -1e12 to 1e12): the numbers your pipeline contract declares. Send only the names your pipeline contract declares (a name the owner did not declare is refused with `metric_not_declared`, and a contract that declares none accepts none), and leave out a number you could not measure. A name is lower case letters, digits and underscore, 2 to 41 characters, starting with a letter.
  - `pipeline`, `version` and `issue` may be in the object (the RunReport shape) but are ignored. Evolution bounds them (`pipeline` and `issue` at most 64 characters, `version` 1 to 100000) and the named values (|v| at most 1e12); Henry's runtime keeps ids short, so keep to these limits.
  - Metrics on any other status are refused. Metrics sent again on a report that was already accepted are not stored.
  - **If a report with metrics is refused, send the same report again without metrics, so the run still ends.**
- Do one run per claim and then stop. Never start another run of the workflow on your own.

## If you are a Free agent with a schedule
- An owner can schedule a workflow for you without a recipe (R1a). You get and claim only runs of schedules that name you, with the same runner and the same three operations. You cannot see or claim another agent's runs.
- You run with your own access. The operation list in `evolution__workflow_get` is guidance, not a limit: stay inside it. Its notice says: "Runs with <your name>'s own access. The operation list is guidance until per-run narrowing (C288 R2–R4)."
- If the owner's setup moved your schedule to the engine (C367), `evolution__routines_due` gives you nothing and a claim answers `migrated`: take the work as workflow steps (`evolution__steps_due`, see below). A Bound agent keeps `routines_due`.
- A claim can answer `mode_mismatch` (the schedule is for the other agent mode), `not_bound` (you have no Free schedule) or `agent_unavailable` (you are paused or removed). Do not retry; tell the owner.

## If you are offered a workflow step (Free agent)
- A workflow can ask you for one piece of CONTENT as one of its steps. Your runner (`tealbrick agent serve`, steps mode) calls `evolution__steps_due`, claims one step with `evolution__step_claim`, and gives you its instruction, its typed `inputs` and its `outputSchema`.
- Return the output only. Do not act. The answer says `mode: "content"` and "Return the output only. Do not act." The engine runs every action itself after it has your output. Do not send, create, change or delete anything because of a step.
- Work in a fresh session. Use only the `inputs` you were given, and your own access only to read what the instruction asks for.
- Send `evolution__step_heartbeat` at least every `heartbeatSec` seconds while you work. A refusal (`step_timed_out`, `step_cancelled`) means stop at once.
- Report with `evolution__step_report`: status `completed` with `output` that matches `outputSchema` exactly (check it first), or status `failed` with a short `summary` of why. If the output does not match, you get `422 output_invalid` with a pointer to the field; the step stays yours until it times out, so fix it and report again once. Do not loop.
- Claim answers: `already_claimed`, `finished`, `timed_out`, `cancelled`, `not_found`, `mode_mismatch` (steps are for Free agents), `agent_unavailable` (you are paused or removed). Do not retry; tell the owner if it repeats.

## Held calls
If a call answers `held`, the owner must approve it. Poll `evolution__tb_hold_status` with the `holdId`, then repeat the same call.
