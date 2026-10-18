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

Flow: suggestion (from an agent or from the Kanban detector) to owner review to draft to promoted version to diff to `recipe_export` (`tealbrick.recipe/1`: create a Bound agent whose allow-list is the workflow's operations, with edges to each product) to schedule (five-field cron, UTC) to the Bound agent's own runner polling `routines_due`, `routine_claim`, `routine_report`. The allow-list is enforced by the bridge. The steps are reviewed guidance only.

Cycles (0.3.0, C250 Release B, E1): one cycle = one workflow version, from its promotion to the next promotion of the same workflow. The ledger is computed on read (`src/cycles.ts`) from versions, drafts, suggestions and run rows; the eval of a cycle (`src/evals.ts`: gates duplicate claims, uncertain ratio, completed ratio, completed-ratio drop against the parent; thresholds in `eval/thresholds.json`) is live, and stored in `eval_runs` when the next version is promoted (same transaction) or when the owner asks (`cycle_eval_run`).

Known edge cases of the ledger (accepted for 0.3.0):
- A duplicate claim whose two runs belong to different versions (a schedule edit across a promotion) is counted in neither cycle: `duplicateClaims` counts (schedule, due time) pairs inside one cycle.
- 0.2.x `missed` rows have no version; they go to the version active at their due time, also for a PINNED schedule (whose real version was the pin). From 0.3.0 missed rows store their version.
- `cycles_list` answers at most 500 cycles (newest promotion first); older cycles are left out of the list (`cycle_get` still reads them).
- `durationP50Ms` leaves out runs whose Task Board close was synced (the sync moves updated_at).
- `workflowTitle` may come from a Kanban-derived suggestion title (C88): owner-only, like `workflows_list`. The ledger has no Kanban evidence titles.
- The closing eval at promotion is best effort (savepoint): if it fails, the promotion stands and the cycle has no stored closing eval.

Run semantics: the primary key of `routine_runs` is the occurrence (sha256 of automation id, revision and due time), so claims are at most once. A misfire grace of 120 s collapses missed periods into one `missed` row (no catch-up burst). `claimed` over 10 minutes or `dispatched` over 30 minutes without a report becomes `uncertain` and is never re-offered. Nothing starts runs on a timer. The runner is external: `tealbrick agent serve` in routines mode.

## Operations (from `tealbrick.manifest.json`)

30 operations.
- Agent write: `suggestion_create` (idempotency required), `routine_claim`, `routine_report`. Agent read: `suggestions_list`, `suggestion_get`, `workflow_get`, `routines_due`.
- Person read (14): `review_suggestions`, `review_suggestion`, `detector_status`, `templates_list`, `drafts_list`, `draft_get`, `workflows_list`, `workflow_versions`, `workflow_diff`, `recipe_export`, `automations_list`, `runs_list`, `cycles_list`, `cycle_get`.
- Person write (8): `suggestion_decide`, `detector_scan`, `draft_create`, `draft_update`, `workflow_promote`, `automation_set`, `automation_pause`, `cycle_eval_run` (idempotency required). Person destructive (held): `automation_delete`.

## Scopes, hooks and companions

- **Scopes:** None. `needsAgentDirectory: true` (keeps agent names).
- **Hooks:** None.
- **Companion grants it asks for:** `kanban`: `issues_list`, `issue_create`, `issue_complete`, `issue_block`. The detector reads done issues (limit 200) only in projects shared with Evolution (C87). Each claimed run becomes a Kanban issue assigned to the Bound agent (template `evolution:<workflow id>`), closed on report. A down Kanban never fails a claim or report (`kanbanSync: failed`).

## Settings, keys and environment

None. No keys. Default agent harness choice in the UI is "Other agent (MCP)".

## Data

- **Stored:** Migrations 0001 to 0005 (0004 rebuilds `routine_runs` with the `policy_stale` status, rows unchanged; 0005 adds `eval_runs`; `test/upgrade.test.ts`, `scripts/upgrade-check.ts`): `suggestions`, `suggestion_events`, `detector_covered`, `drafts`, `workflows`, `workflow_versions` (immutable snapshots), `agent_names`, `automations`, `routine_runs`, `detector_state`, `eval_runs` (stored cycle evals: verdict and `tealbrick.eval/1` results, no Kanban titles). The cycle ledger is not stored: it is computed on read. Kanban issue titles are stored as suggestion evidence and shown to the owner only (a workflow title made from a detector suggestion can carry one; `cycles_list` shows it to the owner only).
- **Never stored:** Anything from Kanban beyond the evidence the owner reviews.

## External calls and background work

- **External:** None (only the Kanban companion).
- **Background:** The Kanban detector: first scan 60 s after start, then every 15 minutes (`DETECTOR_REFRESH_MS`), and on demand.
- **CI evals (T1):** `eval/run.ts` (`tealbrick-ci.json` `preReleaseChecks`): the detector corpus (every case must match; known misses reported; precision and recall 1.0, the measured baseline) and the cycle gate corpus, synthetic fixtures only, no model.

## Person UI

Suggestions, Drafts, Workflows, Schedules, Cycles, Holds, Agents and scopes (`src/ui/App.tsx`). The largest UI of the small apps.

## Requirements and runtime hints

Kanban is a soft dependency for the detector (suggestions from agents work without it) and is needed for run issues. A Bound agent and its runner must exist for schedules to do anything.

Port 8080. 0.25 cpu, 256 MB. Data 1 GB plus backup 2 GB. Backup cron `30 2 * * *`, retain 7.

## Pinned packages

miniapp-sdk 0.1.31, spec 0.1.47, manifest 0.1.25, conformance 0.1.22, ui 0.2.4. Cron maths come from `@opt2-tealbrick/manifest` (`cronDue`, `nextCronTime`).

All `@opt2-tealbrick/*` pins use dist-host tarball URLs. Upgrade safety (SDK 0.1.25 and later: pre-update snapshot, migration lock, failed mode) is in every release since 0.2.12 (stable since 2026-10-18). A failed update is rolled back by Core with the SDK pre-update snapshot; there are no down migrations.

## Known gaps

- Pins `@opt2-tealbrick/spec` 0.1.47 directly (the version miniapp-sdk 0.1.31 uses; `src/recipe.ts` and the UI import `spec/routes`).