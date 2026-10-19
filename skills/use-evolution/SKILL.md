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
  - `pipeline` and `version` may be in the object (the RunReport shape) but are ignored.
  - Metrics on any other status are refused. Metrics sent again on a report that was already accepted are not stored.
  - **If a report with metrics is refused, send the same report again without metrics, so the run still ends.**
- Do one run per claim and then stop. Never start another run of the workflow on your own.

## Held calls
If a call answers `held`, the owner must approve it. Poll `evolution__tb_hold_status` with the `holdId`, then repeat the same call.
