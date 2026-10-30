# Evolving Workflows (Tealbrick mini app): architecture

State: verified against the repo on 2026-10-18. Claims cite paths in this repo. Anything not verified is marked UNVERIFIED. For the whole system see `engineering/ARCHITECTURE.md` and `engineering/SYSTEM-OVERVIEW.md` in the private repo `Tealbrick/opt2-tealbrick-docs`.

## Common app pattern (verified for all seven apps)

- **Runtime**: Node 24, TypeScript run through `tsc` to `dist/`, UI built by `scripts/build-ui.ts` (no bundler; content-hashed `assets-<hash>/`). The app is started by `startApp` from `@opt2-tealbrick/miniapp-sdk` (`src/main.ts`).
- **Dockerfile**: two stages on `node:24-slim` pinned by digest, `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm run build && pnpm prune --prod`, the manifest also copied to `/opt/tb/tealbrick.manifest.json` (the `tb-exec` default), `USER node`, no `VOLUME`. The SDK drops root to uid 1000 itself when the platform starts the container as root (Railway volumes are root-owned).
- **Data**: one SQLite file `TB_DATA_DIR/app.db` owned by the SDK. App tables use their own prefix; SDK tables use `tb_*`. On Railway there is ONE volume per service: the backup directory is `<data mount>/backup`, so the volume size is data plus backup (C28).
- **Migrations**: `migrations/NNNN_name.sql` (or `.ts` exporting `up(db)`). The SDK enforces forward-only: gap-free from 0001, one transaction each, sha256 recorded in `tb_migrations`. A changed, missing, misnamed or `down` migration stops the app with `migration_invalid`.
- **Backups and restore**: SDK cron runner writes `tb-backup-<UTC>.tar.gz`; export `tealbrick.export/1` never carries the instance key, KEK, keys, secrets or sessions. Restore at next boot with `TB_RESTORE_FROM`.
- **Authorization**: the bridge gates (`gate()`); the SDK decides (`authorize()`): run, hold or refuse. Holds and receipts live in the app's own `tb_receipts` table. Raw call input is never stored, only a digest.
- **Manifest** `tealbrick.manifest.json` is the only source for operations, scopes, settings, hooks, companions, skills, runtime hints, backups and UI paths. Schema `tealbrick.miniapp/2`, `sdkMajor 1`, `source.license Apache-2.0`. Agent ops become MCP tools `<product>__<op>`. Person ops are owner UI only.
- **Generated**: `gen/` (openapi, kit, docs, railway) is produced by `tb-gen` and is not committed. The typed client kit is built into `dist/kit` and imported as `#kit` in apps that have one.
- **Standard UI pages** (from the kit `AppShell`): Holds, Receipts, Agents and scopes, Keys (where the app has keys), Backups and export.
- **Licence files**: `LICENSE` (Apache-2.0), `NOTICE`, `THIRD_PARTY_NOTICES.md`. The brand mark and app art are Tealbrick artwork and are not Apache-licensed.
- **Private by design**: no public address. Only the bridge is public.

## Evolving Workflows: what it does

Flow: suggestion (from an agent or from the Kanban detector) to owner review to draft to promoted version to diff to `recipe_export` (`tealbrick.recipe/1`: create a Bound agent whose allow-list is the workflow's operations, with edges to each product) to schedule (five-field cron, UTC) to the Bound agent's own runner polling `routines_due`, `routine_claim`, `routine_report`. The allow-list is enforced by the bridge. The steps are reviewed guidance only. A schedule can instead target an existing Free agent (C364a R1a, `automations.target_mode`): it claims its own runs with its own grant, the operation list is guidance only for it, and no recipe is applied, so the `policy_stale` gate does not apply.

Cycles (0.3.0, C250 Release B, E1): one cycle = one workflow version, from its promotion to the next promotion of the same workflow. The ledger is computed on read (`src/cycles.ts`) from versions, drafts, suggestions and run rows; the eval of a cycle (`src/evals.ts`: gates duplicate claims, uncertain ratio, completed ratio, completed-ratio drop against the parent; thresholds in `eval/thresholds.json`) is live, and stored in `eval_runs` when the next version is promoted (same transaction) or when the owner asks (`cycle_eval_run`).

Known edge cases of the ledger (accepted for 0.3.0):
- A duplicate claim whose two runs belong to different versions (a schedule edit across a promotion) is counted in neither cycle: `duplicateClaims` counts (schedule, due time) pairs inside one cycle.
- 0.2.x `missed` rows have no version; they go to the version active at their due time, also for a PINNED schedule (whose real version was the pin). From 0.3.0 missed rows store their version.
- `cycles_list` answers at most 500 cycles (newest promotion first); older cycles are left out of the list (`cycle_get` still reads them).
- `durationP50Ms` uses `reported_at` (set by the runner's terminal report, never by the sweep; the Task Board close moves only `updated_at`). Rows from before 0.3.0 have none and are left out, so early cycles show few or no durations.
- `workflowTitle` may come from a Kanban-derived suggestion title (C88): owner-only, like `workflows_list`. The ledger has no Kanban evidence titles.
- The closing eval at promotion is best effort (savepoint): if it fails, the promotion stands and the cycle has no stored closing eval.

Run metrics (C288 R8): `routine_report` may carry the `RunReport` metrics with the terminal report; they are stored with it in `run_metrics` (the named per-pipeline numbers in `run_metric_values`) and rolled up per cycle (also by name) (`runMetrics` in `src/cycles.ts`). The lessons are free text from agents (C88 / L12): only `cycle_get` (person op) returns them.

Pipeline contract (C288 R10): `pipeline_import` maps a `tealbrick.agents/pipeline-contract/0.1` object to an ordinary draft (`src/pipeline.ts`): the `mcp__tealbrick__<product>__<operation>` tools become step ops and allowed operations, every other tool is reported as not mapped with a reason (`tb` and owner-only `evolution` operations too), the trigger is reported as a schedule hint (no schedule is created), and everything else is kept as data. The contract is stored as imported beside the draft (`pipeline_sources`) and frozen per promoted version (`workflow_version_pipelines`); it is not in the Snapshot, so versions, diffs and `workflow_get` do not change. `pipeline_export` rebuilds a valid contract from a version and its stored contract (an unchanged import round-trips except `status`). Validation is the SDK validator against the vendored schema (`contracts/`). Bounds and the report size are checked before the draft is created. `asDraftOf` a never-imported workflow needs `confirmReplace`. `routine_report` refuses a named metric that the contract of the run's version does not declare (`metric_not_declared`; versions that were not imported accept any patterned name). Person ops only; no agent op returns the stored contract (C88 / L12); agents read only the title, summary and steps the owner promoted.

Run semantics: the primary key of `routine_runs` is the occurrence (sha256 of automation id, revision and due time), so claims are at most once. A misfire grace of 120 s collapses missed periods into one `missed` row (no catch-up burst). `claimed` over 10 minutes or `dispatched` over 30 minutes without a report becomes `uncertain` and is never re-offered. Nothing starts runs on a timer. The runner is external: `tealbrick agent serve` in routines mode. A caller sees and claims only schedules where the schedule agent is the caller AND the schedule mode is the caller mode (`mode_mismatch` otherwise); a Free agent never reaches another agent's runs. A paused or removed agent (the agent directory in `agent_names`, kept from `agentAdded` / `agentsChanged` / `agentRemoved`; `src/directory.ts`) gets no job and cannot claim; the SDK refuses it first, the handler checks again.

## Workflow engine (C367, WP2)

State: written 2026-10-26 on branch `feat/c367-wp2-engine`; verified by `test/engine/`.

- **Moving parts**: contract + validator (`src/engine/contract*.ts`, `validate.ts`, `expr.ts`, `transform.ts`, `schema-types.ts`), the interpreter workflow (`workflow.ts`, bundled once into `dist/engine/workflow-bundle.js`), the activities (`activities.ts`: they call `ctx.callApp`, write the run index and enforce the activated op list), the Temporal bootstrap (`temporal.ts`: `getTemporal()` and the worker started from `onStart`, stopped in `onStop`), schedules (`schedules.ts`), the reconcile job (`reconcile.ts`), the owner ops (`ops.ts`) and the lifecycle (`engine.ts`).
- **Data**: migration 0009 adds `engine_definitions` (immutable contract versions), `engine_activations` (the op list the owner activated; at most one `active` version per workflow), `engine_schedules`, `engine_runs`, `engine_steps`. Temporal history is the truth for progress; the index holds no body of another app's data.
- **Target catalog**: the SDK gives an app no way to read an installed target manifest, so `src/engine/target-ops.json` is a stamped snapshot of the agent ops of Task Board, Knowledge, Inbox, Rules and Connect. The bridge still enforces the real manifest at call time.
- **Honest label**: the bridge limits Evolving Workflows as a whole; each workflow's limit is enforced by the engine until per-workflow grants (P1).
- **M1 wiring** (`onStart` in `src/app.ts`): `wireAgentSteps(db)` (the agent port and the Temporal completion client, `src/agentsteps/wire.ts`), `startEngine(...)` (worker + reconcile job), `startEngineHealthWatch(...)`; `defineApp({attention})` returns `engineAttention()` (WP1: degraded while Temporal is unreachable, never in `/tb/v1/health`). `test/integration-agent-steps.test.ts` runs an `ai` step with `by.agent` through the real interpreter, port, store and ops.

### Engine M2: waits, model roles, history, security (C367)

- **Result action through Connect (C366b)**: an `app` step on `connect.tools` runs a named tool. Connect checks each call: the account must be shared with this exact instance; a write tool needs the owner's separate write share and a companion grant with create and update; an outward tool also needs a grant that holds its family, so it runs only on an owner approval; delete and money tools are refused. Connect's hold card names the workflow, version, run and step from the call context, and that text binds the approval to this run. `connect_access` (person op, activation review) asks Connect's `tool_shares_mine`, which authorizes nothing and is also the requires line: an older Connect refuses the update up front.
- **Held app step**: the bridge answers `held`; the interpreter waits durably (`sleep` 30 s, 60 s, 120 s, 240 s, then 5 min) and asks `tb.hold_status` when the bridge declares the cap `app_hold_status` (`ctx.bridgeCaps()`), else it reads the pending list `tb.holds_pending` (the wildcard companion, read only, owner consent). Approved (or left the list) -> the SAME call (same input, same key) is repeated once; a second `held` is `held_again`; denied, expired or unknown ends the step (`hold_denied`, `hold_expired`, `hold_gone`) and `onFail` decides. `tb.hold_status` is NOT in the manifest (the Core pin comes first).
- **Approval step** and **`onFail: "ask"`**: `inbox_ask` (key `wfrun:...`, an app caller) then `inbox_status` on the same backoff. Only `answered` + `approve` is an approval. `ask` after a failed step: Approve = retry, Clarify = skip, Deny or no answer = stop; at most 5 questions per step; failures no answer can fix (`not_in_workflow`, ...) are not asked. The time the owner takes does not count against `maxRunMinutes`.
- **Model role step** (`models.ts`): `modelRole(role)` of the SDK, then one provider call (OpenAI-compatible, Anthropic, Google): temperature 0, at most 4000 output tokens, no tools, the reply validated against `outputSchema` with ONE repair retry, tokens recorded in `engine_steps` / `engine_runs.model_tokens`, `limits.maxModelTokens` enforced between steps. No binding, no `model_roles` cap, or a role that is not a text role fails the step (`model_role_unavailable`, `model_role_unsupported`). The manifest declares four OPTIONAL roles (`settings.modelRoles`: reasoning, utility, summarize, dreaming). The SDK raises only `model_role_missing` for REQUIRED roles and never `model_role_optional` by itself; the app raises `model_role_optional` (`src/engine/role-attention.ts`) ONLY when an ACTIVE workflow version uses an unbound role in an `ai` step, naming the workflow, so an install that does not use a role is not degraded by it (Core's update gate needs readiness `ok`).
- **Call context**: behind the cap `app_call_context` every call also sends `{evolution.workflow, evolution.version, evolution.run, evolution.step}`; without the cap only the idempotency key.
- **Run detail**: `engine_run_get` reads each step's input and output from the Temporal history, only for the owner (C88); app.db keeps sizes.
- **Gate-safe attention**: `temporal_unreachable` (WP1) is raised only after the probe has failed continuously for 90 s and never before 120 s after `onStart` (Core starts companions without waiting for their health, and the update gate compares readiness after the update). The engine fault outranks a model-role code (the SDK keeps one attention slot).
- **Security review fixes (M1)**: values over 1.5 MB fail the step (`input_too_large`) and a run has a hard Temporal ceiling; a replaced version starts no new run (runs in flight finish, each call checked against that version's own activation); every step kind checks the activation; a workflow step needs the child ACTIVE and the child's ops are listed in the parent's activation (`via`); child run ids stay unique; schedules are checked again when a newer version is activated (stale = paused with a reason); a poll cursor moves only when its run completed (`0012_engine_m2.sql`).

#### Payload codec (C371)

Every Temporal payload (workflow arguments, activity inputs and results, memo) is sealed with AES-256-GCM in the app (`codec.ts`) before it leaves the process, with a key that only the app holds. Decode REFUSES a payload that is not sealed: a neighbour on the private network cannot read a history, cannot inject a forged step result (a plain start or a plain completion fails at the worker; the run takes nothing from it), and the data of other apps stays sealed in the Temporal database and in its backups. The client, the worker and the history reads of the run detail share the one codec (`temporal.ts`).

- **Where the key lives**: the key ring `engine-payload-keys` is in the SDK secret store, sealed under `TB_KEK` (excluded from export, sealed inside backups; `keystore.ts`). It is NEVER in the env, the image, the volume or the backup of the `temporal` service (`test/engine/codec.test.ts` checks the manifest entry and the service files).
- **Key rotation**: every sealed payload carries a key id in its metadata (`encryption-key-id`, also bound into the GCM tag). The ring holds the current key and the older ones. `rotateKey` adds a new key and makes it current; new writes use it; decode opens payloads of every key still in the ring, so history written before the rotation stays readable. `retireKey` removes an old key after the Temporal retention window (5 days, 120 h; `KEY_RETIRE_AFTER_HOURS` = retention + 1 day margin = 144 h) has passed; a payload still sealed with a retired key is refused, so a run that still needs it fails. There is no owner op for rotation yet: it is a deliberate maintenance step (release note).
- **Key loss**: if the ring is lost (the secret store is wiped and there is no backup), it costs RUN PROGRESS ONLY. In-flight runs and the history in Temporal become unreadable and fail (the reconcile job closes their index rows). Workflow definitions, versions, activations, schedule metadata and the run index in `app.db` survive; schedules keep firing once a new key exists (the engine makes a new ring at the next start when none exists, and the old Temporal history stays unreadable). A stored value that is not a valid ring is never replaced silently: the engine stops with an error instead of orphaning history.
- **Limits**: failure messages in the history carry a code and a status, never the text of another app. M1 runs in flight on a workspace are not readable after the codec ships: terminate them.

## Operations (from `tealbrick.manifest.json`)

52 operations: the 32 of 0.3.0, the 14 owner ops of the engine (WP2; M2 adds `workflow_run_now`), the 4 agent ops and `agent_steps_list` (WP3), `migration_status` (M3).
- Agent write: `suggestion_create` (idempotency required), `routine_claim`, `routine_report`, `step_claim`, `step_report` (C367 WP3), `step_heartbeat`. Agent read: `suggestions_list`, `suggestion_get`, `workflow_get`, `routines_due`, `steps_due`.
- Person read (agent steps): `agent_steps_list`.
- Person read (15): `review_suggestions`, `review_suggestion`, `detector_status`, `templates_list`, `drafts_list`, `draft_get`, `workflows_list`, `workflow_versions`, `workflow_diff`, `recipe_export`, `automations_list`, `runs_list`, `cycles_list`, `cycle_get`, `pipeline_export`.
- Person write (9): `suggestion_decide`, `detector_scan`, `draft_create`, `draft_update`, `workflow_promote`, `automation_set`, `automation_pause`, `cycle_eval_run` (idempotency required), `pipeline_import` (idempotency required). Person destructive (held): `automation_delete`.

## Scopes, hooks and companions

- **Scopes:** None. `needsAgentDirectory: true` (keeps agent names).
- **Hooks:** None.
- **Companion grants it asks for:** `kanban`: `issues_list`, `issue_create`, `issue_complete`, `issue_block`. The detector reads done issues (limit 200) only in projects shared with Evolution (C87). Each claimed run becomes a Kanban issue assigned to the Bound agent (template `evolution:<workflow id>`), closed on report. A down Kanban never fails a claim or report (`kanbanSync: failed`).

## Settings, keys and environment

None. No keys. Default agent harness choice in the UI is "Other agent (MCP)".

## Data

- **Stored:** Migrations 0001 to 0008 (0008 adds `automations.target_mode`, 'bound' on every old row, and `agent_names.mode`, `status`, `in_directory` (C364a R1a); 0004 rebuilds `routine_runs` with the `policy_stale` status, rows unchanged; 0005 adds `eval_runs` and the nullable `routine_runs.reported_at`, null on old rows; 0007 adds `pipeline_sources` and `workflow_version_pipelines` (C288 R10: the typed pipeline contract as imported, per draft, and frozen per promoted version; no existing table changes; person ops only read it); 0006 adds `run_metrics` (C288 R8: one row per run with the metrics of its terminal `routine_report`; no existing table changes); `test/upgrade.test.ts`, `scripts/upgrade-check.ts`): `suggestions`, `suggestion_events`, `detector_covered`, `drafts`, `workflows`, `workflow_versions` (immutable snapshots), `agent_names`, `automations`, `routine_runs`, `detector_state`, `eval_runs` (stored cycle evals: verdict and `tealbrick.eval/1` results, no Kanban titles), `run_metrics` (ok, minutes, retries, questions to the owner, lessons: free text from agents, read by person ops only). The cycle ledger is not stored: it is computed on read. Kanban issue titles are stored as suggestion evidence and shown to the owner only (a workflow title made from a detector suggestion can carry one; `cycles_list` shows it to the owner only).
- **Never stored:** Anything from Kanban beyond the evidence the owner reviews.

## External calls and background work

- **External:** None (only the Kanban companion).
- **Background:** The Kanban detector: first scan 60 s after start, then every 15 minutes (`DETECTOR_REFRESH_MS`), and on demand.
- **CI evals (T1):** `eval/run.ts` (`tealbrick-ci.json` `preReleaseChecks`): the detector corpus (every case must match; in the 3 known-miss cases only missing gold groups are tolerated, a full match fails; precision and recall 1.0, the measured baseline) and the cycle gate corpus, synthetic fixtures only, no model.

## Agent steps (C367 WP3)

An `ai` step with `by: {agent}` runs as an async Temporal activity (ENGINE-BUILD §5). `src/agentsteps/` is the app side:

- **Port.** The engine's activity calls `AgentStepPort.offer` with the step, the typed inputs, the output schema, the timeouts and the base64 task token, then ends with `CompleteAsyncError`. `offer` stores the step for one Free agent (`agent_not_free` otherwise) and is idempotent per attempt; a higher attempt re-offers the same `stepRunId` (Temporal retry). `cancel` ends an open step.
- **Ops.** `steps_due`, `step_claim`, `step_heartbeat`, `step_report` for the agent (`src/agentsteps/ops.ts`), `agent_steps_list` for the owner. R1a rules (agent = caller, mode = caller mode, available in the directory) as in `src/routines.ts`. The claim is one conditional `UPDATE ... WHERE status = 'offered'`: at most once.
- **Completion.** `step_report` validates the output with the JSON Schema validator of `@opt2-tealbrick/manifest`, then calls `activity.complete(taskToken, output)`; `failed` calls `activity.fail`; `step_heartbeat` and the claim call `activity.heartbeat`. Errors are sorted by name: `ActivityNotFoundError` (Temporal no longer has it: the step becomes `timed_out`), `ActivityCancelledError` (`cancelled`), anything else is `503 engine_unavailable` and changes nothing. `completionFromTemporal(getTemporal)` hands the engine's client in as the three calls (`ActivityCompletion`); a `failed` report becomes an `ApplicationFailure` typed `AgentStepFailed`, so the run shows that code. The seam types `AgentStepOffer` and `AgentStepPort` are WP2's (`src/engine/agent-port.ts`).
- **Time.** Deadline = offered + `timeoutSec`; the heartbeat window = 3 x `heartbeatSec` from the claim or the last heartbeat (`heartbeatSec` 0 = no window, only the deadline). `sweep` ends expired steps as `timed_out` (it runs in every agent op and in the owner list). Temporal wins: a step that Temporal ended is ended here on the next contact.
- **Data.** `agent_step_runs` keeps the open step's inputs, then NULL; the output body is never stored (size and sha256 only); `agent_step_events` has one row per offered, claimed, completed, failed, timed_out and cancelled, per attempt.
- **Gap, stated:** the agent acts with its own grant during its turn, so "content only" is the instruction and the engine's check, not a hard limit until the C288 run token.

## Move from 0.3.x (C367 M3)

`src/migrate/` runs once from `onStart` (database rows only, so before the engine starts; the reconcile job creates the Temporal Schedules from the rows). It saves each promoted version as a contract (`saveDefinition`, same digest = no change), activates what a moved schedule needs (no operations), inserts the engine schedule (`insertSchedule`, `temporal_state` pending) and pauses the 0.3.x schedule (`pauseAutomation`), per workflow in one transaction. `migration_items` records what became of each workflow and schedule (migrated, legacy_bound, skipped, failed, deferred) and `migration_marker` that the move is done. The compatibility layer is in `src/routines.ts`: `legacy_bound` and `migrated` warnings, and the claim reason `migrated`. The 0.3.x tables are never changed except `automations.enabled` (and the revision, stamp and next due time that follow from it) of a moved schedule; `routine_runs` never. The migration module imports the engine only through `engine-store.ts` and `contract.ts`.

## Person UI

Suggestions, Drafts, Workflows, Editor, Activation, Schedules, Runs, Cycles, Holds, Agents and scopes (`src/ui/App.tsx`). The largest UI of the small apps. The engine pages (C367 WP3): `Editor.tsx` with `StepForms.tsx` (a form per step kind), `Shape.tsx` (the canonical shape in six lanes), `Usage.tsx` (the check results and the operations a version uses, with the honest grant label), `Activation.tsx`, `EngineSchedules.tsx` (inside Schedules), `Runs.tsx` (list, step timeline, agent-step history) and `EngineCycles.tsx` (inside Cycles). `engine-ops.ts` names the engine ops' shapes from the generated kit; `engine-contract.ts` re-exports WP2's contract types and limits and adds the editor's quick check (WP2's `validateContract()` imports `@opt2-tealbrick/manifest`, which uses `node:crypto`, so the browser bundle cannot take it; the server runs it). The editor saves with `workflow_contract_save`, lists with `workflow_contracts_list` and opens with `workflow_contract_get`.

## Requirements and runtime hints

Kanban is a soft dependency for the detector (suggestions from agents work without it) and is needed for run issues. A Bound agent and its runner must exist for schedules to do anything.

Port 8080. 0.5 cpu, 768 MB (C367 WP1; was 0.25 cpu / 256 MB). Data 1 GB plus backup 2 GB. Backup cron `30 2 * * *`, retain 7. The `temporal` companion service (below): limit 1 cpu, 1024 MB, data 5 GB.

## Pinned packages

miniapp-sdk 0.1.40, spec 0.1.64, manifest 0.1.31, conformance 0.1.30, ui 0.2.4 (M2 moved from 0.1.31 / 0.1.47 / 0.1.25 / 0.1.22 for `modelRole()` and `ctx.bridgeCaps()`). Cron maths come from `@opt2-tealbrick/manifest` (`cronDue`, `nextCronTime`).

All `@opt2-tealbrick/*` pins use dist-host tarball URLs. Upgrade safety (SDK 0.1.25 and later: pre-update snapshot, migration lock, failed mode) is in every release since 0.2.12 (stable since 2026-10-18). A failed update is rolled back by Core with the SDK pre-update snapshot; there are no down migrations.

## Temporal service (companion `temporal`, C367 WP1)

The workflow engine runs on Temporal in the single-binary shape: one companion service, `temporal`, built from `services/temporal/Dockerfile`
(`runtime.services[]`, always on, `startOrder` 0, private network only, no UI, no public route). The app reaches it through the env
`TEMPORAL_ADDRESS={{services.temporal.host}}:7233`; the engine namespace is `evolution`.

- **Image:** `node:24.22.1-bookworm-slim` by digest, the Temporal CLI 1.9.1 (server 1.32.0; MIT; downloaded by URL with a pinned sha256 per
  architecture), `sqlite3`, and the tb-exec layer (`services/temporal/tb-exec`, integrity-pinned lock, `npm ci --ignore-scripts`; keep its
  miniapp-sdk version equal to the app's). tb-exec claims the service, then runs `services/temporal/run.sh` as uid 1000 (`dropPrivileges`).
- **Server:** `temporal server start-dev --headless --ip 0.0.0.0 --port 7233 --db-filename /data/temporal.db --namespace evolution --log-level warn`.
  The state is one SQLite file on the 5 GB volume `temporal_data`. Health is a TCP check on 7233. `run.sh` raises the `evolution` namespace retention
  from the dev default of 24 h to 5 days (`TEMPORAL_RETENTION`, default `120h`) once the server answers. The dev server also opens a metrics port and
  the internal service ports on random numbers; only 7233 is declared, and nothing is routed to the service from outside the private network.
  There is no authentication on 7233: the private network is the boundary (the same as v1).
- **Schema (the self-migration finding):** `start-dev` never migrates an existing SQLite file. It creates the schema once in an empty file and then
  only opens it. A newer CLI on an older file starts, but features that need newer tables fail later (measured: a file made by CLI 1.5.1 and opened
  by 1.9.1 starts, and `DescribeSchedule` then fails with `no such table: current_chasm_executions`). There is no flag to turn anything on or off.
  So the E3 rule "no self-migration at start" holds, and the version is pinned by the image. The risk is the other way round: a CLI bump needs an explicit
  schema step. Guard: `services/temporal/schema.sha256` is the hash (`services/temporal/schema-hash`) of the table, index, view and trigger
  definitions of a fresh database of the pinned CLI. `run.sh` refuses to start (exit 78, `temporal_schema_mismatch` in the log, health stays red) on a
  file with another hash, and `temporal-restore` refuses a copy with another hash. A CLI bump is its own Evolution release: new version and two sha256
  in the Dockerfile, a new `schema.sha256`, the versioned SQL of the new server release applied by an explicit step after the pre-update snapshot, a test.
- **Backup (`backup.dump` / `backup.restore`, extension `sqlite`):** `temporal-dump` writes a consistent copy with the SQLite online backup
  (`sqlite3 ... .backup`) to a temporary file on the volume, checks it (`quick_check`) and streams it to stdout. `temporal-restore` stores the copy as
  `/data/restore/pending.sqlite`, checks it (`integrity_check`, schema hash), stops the server, and waits until `run.sh` has moved the old file to
  `/data/restore/previous.sqlite`, put the copy in place and started the server again. SDK limits: tb-exec caps a restore body at 512 MB, and Core
  offers no snapshot restore for an app with companions (update-safety), so a bad release is fixed forward.
- **App side:** `src/engine/health.ts` probes `TEMPORAL_ADDRESS` with a TCP connect (cached 10 s, one probe at a time, bounded below the SDK's 1 s
  attention timeout). When the engine does not answer, `defineApp({attention})` reports `temporal_unreachable` (readiness `degraded`, the app still
  serves). It is never part of `GET /tb/v1/health`, so the E3 upgrade gate does not depend on the engine.
- **Size and resources (interim values):** SQLite does not shrink after retention deletes rows: the file stays at its high-water mark. At the measured
  2.78 MB/h (about 100 runs per hour) a 5-day (120 h) window is about 330 MB, below the 512 MB restore cap of tb-exec. The `temporal` service has a LIMIT of 1 cpu
  and 1024 MB (measured over 11.7 h at ~100 runs/h: anon RAM max 153 MB, cgroup peak 206 MB, CPU at most 1.7 % of one core). The limit is a ceiling, not a
  reservation: a small workspace uses what it needs. It is set well above the measured use on purpose, because an app update cannot raise it later (below).
  The key ring retires an old payload key `KEY_RETIRE_AFTER_HOURS` (retention + 1 day) after the rotation; a test keeps it above the retention in `run.sh`.
- **Raising the limits (the 1024 MB / 1 cpu values are a default starting limit):** Core applies a service's `resources` only when it creates the
  service (`serviceInstanceLimitsUpdate` in portal-core `src/providers/railway.ts`, `deploy`; a refused call is logged as advisory and the deploy goes on).
  `update` (an app update with a new manifest value) does not touch the limits, so a changed `memoryMb` or `cpu` in a later release does NOT reach an existing
  workspace, and a limit the owner sets by hand stays. Today the path to more room is the resource limit of the `temporal` service in the Railway project
  of the workspace (the owner's own Railway), then a restart of the service. The manifest value only decides new workspaces. No Portal GUI or CLI control exists for this yet.
  The tb-exec restore cap (512 MB) is a constant of the SDK (`RESTORE_MAX_BYTES`, `exec/servers.ts`); an app cannot raise it. Both are open items for Core and the SDK.
- **Near-limit signal:** the app cannot read the memory or disk of the `temporal` service. `src/engine/load.ts` counts the kept workflow executions every
  10 minutes (one visibility count), estimates the database at about 30 KB per run, and `attention()` reports `temporal_near_restore_cap` from 80 % of the 512 MB cap
  (after `temporal_unreachable`, before a model-role code). The estimate is a lower bound (the file keeps its high-water mark). There is no memory signal; it needs a stats route in tb-exec or a metrics port read.
- **Proof:** `smoke/engine-smoke.ts` (start the image, gRPC reachability, schema hash, retention, a workflow through an inline worker, a Schedule:
  create, fire, trigger, pause, unpause, delete; and the dump -> restore round trip with three workflows in flight) and `smoke/measure/` (24 h
  RAM/CPU run with about 100 runs per hour, cold start on a copy of the live file). They need a container CLI and are run by hand (podman on neuu), not in CI.

## Access list and acting tickets (C380 B7)

- `access_list` and `access_revoke` (`src/access.ts`, `tb.access/1`, spec 0.1.89) are for the Governance app only: a verified, listed caller with product `fleet`, else `no_access` or `caller_unverified`. Kinds: `routine` (a schedule that runs for an agent; the only one that can be paused, and only when the signed slice shows the agent paused or removed), `workflow_agent_step` and `schedule_of_workflow` (list only). Nothing is deleted, Temporal is not called. Schemas and fixtures: `test/contracts` (byte copies of the spec).
- Acting tickets (`src/acting.ts`, table `acting_tickets`, bridge cap `acting_agents`, DESIGN-ACTING-AGENT.md): `routine_claim` and `step_claim` ask the bridge for a ticket while the agent's own call is open, BEFORE the claim writes anything (no ticket, no claim: 503). A routine's Task Board calls carry it (job `rt.<occurrence>`); every later `app` step of an engine run carries the tickets of the agents whose steps it claimed (job `run.<workflow>.<run>` of the ROOT run: a child run, a `workflow` step, shares it through `acting_links`; at most 4 agents, a fifth claim is refused with `acting_agents_full`). A ticket only makes a call stricter: Rules may deny or hold on the agent, an allow never reads it. Tickets live in `app.db` only, never in a Temporal payload, log or answer (C371), and are dropped when the issue is closed or the run ends. A ticket the bridge refuses, or an expired one (30 days; a run can wait longer for the owner), fails the step `acting_ticket_invalid` and no call goes out unattributed; the step then follows its `onFail` policy. `bridge_cap_missing` (a stale slice) is waited out by the step retry. Without the cap (older bridge) nothing is minted or sent.

## Known gaps

- Pins `@opt2-tealbrick/spec` 0.1.64 directly (the version miniapp-sdk 0.1.40 uses; `src/recipe.ts` and the UI import `spec/routes`).