# Evolving Workflows (Tealbrick mini app)

Evolution (product id `evolution`): the mini app that turns work your agents repeat into reviewed, versioned workflows, and exports a recipe that creates a Bound agent for a workflow. Workflows can run on a schedule through that Bound agent. Evolution never starts an agent and never calls a model. Built on the Miniapp SDK.

**Status:** stable 0.2.11; `main` is 0.2.12 (dev channel only; its qa1 soak is the gate for stable, C221). Visibility: public, Apache-2.0. Image: `ghcr.io/tealbrick/opt2-tealbrick-evolution` (publicly pullable; as of 2026-10-17 it holds the tags 0.2.12, its earlier dev pre-release 0.2.12-dev.1, and `sha-` tags; 0.2.11 and older were published under the former owner's GHCR namespace). Step A (0.1): suggestions, owner review, drafts, versions, diffs, recipe export, Task Board pattern detector. Step B (0.2): schedules and runs claimed at most once by the Bound agent's own runner (`tealbrick agent serve` in routines mode); every run is a Task Board issue assigned to the Bound agent. Release B (0.3.0, C250, on `main` before its version chore): the cycle ledger and an eval per cycle (Cycles page), T1 evals in CI (`eval/`).

- Repository: `Tealbrick/opt2-tealbrick-evolution` (GitHub organisation `Tealbrick`)
- Licence: Apache-2.0 for the app code (`LICENSE`, `NOTICE`); upstream licences are in `THIRD_PARTY_NOTICES.md`. The Tealbrick brand mark and app art are Tealbrick artwork and are not covered by the Apache-2.0 licence.

## No secrets policy

This repository is public. It must never contain secrets or personal data, and neither may its issues or pull requests:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them. CI holds no secrets.
- No personal names, private agent configurations or customer data.
- Every pull request, every push to `main` and every tag runs a secret scan (gitleaks, the `secret-scan` step in `.woodpecker/ci.yaml`). GitHub secret scanning and push protection are not enabled on this repository, so the CI scan is the guard. Optional local guard: `pre-commit install` (`.pre-commit-config.yaml` runs gitleaks).
- If a secret is committed anyway: rotate it first, then remove it from history.

## What it does

```
agent repeats work ──suggestion_create (evidence: Task Board issue ids / receipt call ids, steps)──┐
Task Board done issues ──detector (same template or title, one agent, N >= 3)──────────────────────┤
                                                                                                   ▼
owner (person ops): review → approve → draft (steps, allowed ops per product, trigger) → promote v1, v2 …
                    → diff versions → recipe_export (tealbrick.recipe/1) → owner imports + applies it in Portal
                    → a Bound agent whose grant allows only the workflow's operations
                    → schedule (cron, UTC) → the agent's runner: routines_due → routine_claim → one turn → routine_report
                    → every run = one Task Board issue assigned to the Bound agent (template evolution:<workflow id>)
```

The UI says it plainly: **the agent may call these operations** (the bridge blocks every other one); the steps are reviewed guidance, not an enforced program. The allow-list is enforced by the bridge. Temporal and the v1 step runner are not part of opt2.

30 operations:

| Operation | Audience | Purpose |
|---|---|---|
| `suggestion_create` | agent | suggest a workflow with evidence and optional steps (idempotency required) |
| `suggestions_list`, `suggestion_get` | agent | the caller's own suggestions and their status |
| `workflow_get` | agent | a promoted workflow version (what a Bound agent reads) with the allowlist notice |
| `review_suggestions`, `review_suggestion`, `suggestion_decide` | person | owner review: approve / reject / archive |
| `detector_scan`, `detector_status` | person | read done Task Board issues (companion `kanban.issues_list`) and suggest repeated work; last scan result |
| `templates_list`, `draft_create`, `drafts_list`, `draft_get`, `draft_update` | person | drafts from a suggestion, a seed template or blank; revisioned edits |
| `workflow_promote`, `workflows_list`, `workflow_versions`, `workflow_diff` | person | versions (immutable snapshots) and diffs |
| `recipe_export` | person | `agents.create` + `agents.policy_set` (bound, workflow ops) + `edges.create` per product |
| `routines_due` | agent | Bound caller's due runs, the runner's poll target (Free callers get none); claims nothing, only books missed and policy_stale periods |
| `routine_claim` | agent | `{occurrence}` → at most one claim ever succeeds; answers the reviewed workflow, or `claimed: false` + reason (`already_claimed`, `missed`, `not_due`, `paused`, `not_bound`, `version_missing`, `policy_stale`) |
| `routine_report` | agent | `dispatched` → `completed` / `failed` / `uncertain` (+ summary); closes the run's Task Board issue; optional `metrics` with the report that ends the run (see "Run metrics") |
| `automation_set`, `automation_pause`, `automations_list`, `runs_list` | person | schedules (cron, version pin or active, applied policy version, Task Board project, `warnings`) and run history; `automations_list` also answers `kanbanLinked` |
| `automation_delete` | person | deletes a schedule (destructive, held) |
| `cycles_list`, `cycle_get` | person | the cycle ledger (one cycle per workflow version) with the live eval and the run-metrics rollup `runMetrics`; `cycle_get` adds the stored evals and the lessons of that version |
| `cycle_eval_run` | person | stores the eval of one cycle now (trigger `owner`; idempotency required) |

### Schedules and runs (0.2)

- occurrence = sha256 of `[automationId, revision, dueAt]`; the primary key of the run row (`routine_runs`) makes a claim at-most-once (v1 routines model).
- Misfire grace (default 120 s, `cronDue`): a due time not claimed in time is recorded `missed` once, missed periods collapse into that record, and the next period runs; never a burst of catch-up runs.
- `claimed` over 10 minutes or `dispatched` over 30 minutes without a report → `uncertain`, never offered again (a late report still closes it).
- Following the active version: if it allows more than the version whose recipe the owner applied (`policyVersion`), the schedule shows a `policy_stale` warning, `routines_due` does not offer its due run, and its periods are skipped like claimed ones; the first one per schedule revision and version is recorded as a `policy_stale` run (`runs_list`; a claim answers `policy_stale`). After the owner applies the new recipe in Portal and sets "Recipe applied" (`policyVersion`) with Edit on the Schedules page, the next period runs; a period already skipped is not run again (a repeated claim of a skipped period without a row answers `not_due`). An edit that does not name `policyVersion` keeps it. One gate (`policyStale` in `src/routines.ts`) decides this for `routines_due` and `routine_claim` (0.2.13, C250).
- Task Board (companion `issue_create`, `issue_complete`, `issue_block`): one issue per claimed run, assigned to the Bound agent, template `evolution:<workflow id>`; the detector never suggests these. Task Board down → the run still runs (`kanbanSync: failed`).
- Run issue project: the schedule's `kanbanProject`. Use a Task Board project the owner SHARES with the Bound agent, so the agent can read and comment on its run issues (shared projects reach agents and Evolution). When Evolution can reach Task Board (its companion grant is in the workspace slice, `kanbanLinked`), a NEW schedule needs `kanbanProject` (`422 kanban_project_required`); an edit can keep an older schedule without one, never remove one, and such a schedule carries the `kanban_project_missing` warning. Without a project, run issues go to Evolution's own Task Board project, which the Bound agent cannot see (0.2.13, C250). Every recipe allows `kanban.issue_get` and `kanban.issue_comment_add` for this.
- Cron and the due / misfire rule: `nextCronTime` and `cronDue` from `@opt2-tealbrick/manifest` (5 fields, UTC; the one shared helper, no local copy). `routines_due` only books what the clock and the policy gate imply (`missed`, `policy_stale`); it never claims. Nothing starts runs on a timer; the runner is external.

### Cycles and evals (0.3.0, C250 Release B)

- A cycle is one workflow version, from its promotion until the next version of the same workflow is promoted (`retiredAt`; null = active). The ledger is computed on read from `workflow_versions`, `drafts`, `suggestions` and `routine_runs` (`src/cycles.ts`); nothing is copied. Owner only (person ops), no Task Board evidence titles, no cost fields (E2 later). `workflowTitle` is the workflow's title, which may come from a detector suggestion built from a Task Board title (C88): it is owner-only, like `workflows_list`.
- Per cycle: authoring (`parentVersion`, `suggestionId`, `evidenceCount`, `approvalDelayMs` = the FIRST approval event minus the suggestion's creation (a later archive does not change it), `draftRevisions`, `widensAccess` against the parent) and runs (`counts` total / completed / failed / uncertain / missed / policyStale / open, `completedRatio`, `uncertainRatio`, `failedRatio`, `missedRatio`, `claimLatencyP50Ms`, `durationP50Ms`, `kanbanClosedRatio`, `duplicateClaims`, `last10`). A run belongs to its `workflow_version`; a 0.2.x `missed` row without one belongs to the version active at its due time. From 0.3.0 a `missed` row stores its version (the pin, else the version active at the due time). Stale `claimed` / `dispatched` runs count as uncertain (the `runs_list` rule). Ratios use completed + failed + uncertain as the base (`missedRatio` adds missed); medians are nearest-rank (lower middle). `durationP50Ms` = `reported_at` minus `claimed_at` of completed / failed runs: `reported_at` (0.3.0, migration 0005) is set by the runner's terminal `routine_report`, never by the sweep, so a later Task Board close (which moves `updated_at`) does not count. Rows from before 0.3.0 have no `reported_at` and are left out.
- Eval (`src/evals.ts`, one `tealbrick.eval/1` result per metric, suite `cycle:<workflow id>@v<n>`, tier T2). Gates: `duplicate_claims` = 0, `uncertain_ratio` <= 0.05, `completed_ratio` >= 0.80, `completed_ratio_drop` (parent minus this) <= 0.10. Information: `missed_ratio` <= 0.20, `policy_stale_runs`. A ratio needs 5 terminal runs (the drop: 5 in both cycles), else `pass: null`. Verdict: `fail` if a gate fails, `pass` if every gate passes, else `insufficient`. Version 1 has no parent, so no drop metric. Thresholds: `eval/thresholds.json` (the one source).
- Stored evals (`eval_runs`, migration 0005): promoting version n+1 stores the closing eval of version n in the same transaction (trigger `promotion`), best effort: a nested transaction (savepoint), so a failing eval is logged (ids, the error message and a store code; no Task Board data) and rolled back alone and never fails the promotion; "Store eval now" on the Cycles page calls `cycle_eval_run` (trigger `owner`). The live eval of every cycle is computed on read.

### Run metrics (C288 R8)

- `routine_report` takes an OPTIONAL `metrics` object, the `RunReport` of the Henry contracts: `ok` (boolean, required), `minutes` (number 0..10080, required), `retries` and `questions_to_martin` (whole numbers 0..1000), `lessons` (at most 20 strings, each 1..280 characters counted as code points, stored trimmed, and each must show at least one letter, digit, punctuation or symbol: zero-width and filler characters alone are blank; the schema counts the raw length). Also `metrics`: the named per-pipeline numbers (RunReport.metrics, agent-stack 640a4aa): an object of name to number, at most 20 names, each name `^[a-z][a-z0-9_]{1,40}$`, finite numbers only (a pointer names the bad name: `/metrics/metrics/<name>`). This branch does not know which names a pipeline declares: any patterned name is stored. No other field. `pipeline` (string, at most 64), `version` (whole number, at least 1) and `issue` (the Task Board issue id of the run, string 1..64) are accepted for 1:1 compatibility with `RunReport` and are IGNORED: Henry's pipeline ids and contract version are not our workflow id and version, and the run row is the truth for both, and the run row's own `kanban_issue_id` is the truth for the issue. They are never stored or compared. A report without `metrics` works exactly as before (old runners keep working).
- Metrics are accepted only with the report that moves the run to `completed` or `failed` (a late report of a run the sweep made `uncertain` counts). On any other status: `422 metrics_need_terminal_status`. They are stored in the same transaction as the status change, once. A REPEAT of the current status is a no-op, as for every report: metrics that arrive on it (same or different) are not stored and never overwrite the stored ones; a run that finished without metrics stays without. A bad payload is still refused on a repeat. **If a report with metrics is refused, send the same report again without metrics, so the run still ends** (a refused report changes nothing). The answer to the agent is the run, as before: no op for agents returns metrics or lessons.
- Invalid shapes are refused by the manifest schema before the handler: the SDK answers `400 input_invalid` with the JSON pointer of each error (`/metrics/minutes`, `/metrics/lessons/2`, ...), as for every op. The handler repeats the bounds (`422 validation_failed` with a pointer; the lesson blank check is in the schema pattern too) so a direct call cannot store a value outside them. `ok` is not checked against the status: it is the runner's own word (a completed run can say `ok: false`).
- Stored in the new table `run_metrics` (migration 0006, one row per run, keyed by the occurrence); the named numbers go to the child table `run_metric_values` (occurrence, name, value; the same migration file, with CHECKs on the name, a finite value and at most 20 names per run). 0006 was extended in place, before any release (R8 is PR #14, no tag): no database has applied the first form. The run row stays the truth for the workflow and version. The rollup `runMetrics` of every cycle (`cycles_list`, `cycle_get`, the Cycles page): `runs` (with metrics), `okRuns`, `okRatio`, `minutesMedian` (nearest-rank, lower middle), `minutesMean`, `retriesTotal`, `questionsToMartinTotal` (a run that left a field out counts 0), `lessonCount`, and `namedMetrics`: one entry per name (sorted) with `reports`, `median` (nearest-rank, lower middle), `mean`, `min` and `max`, over the runs of that version that reported the name. The Cycles page lists them by name (underscores read as spaces) and compares the typical (median) value of a name with the previous version once BOTH versions have at least 5 reports of THAT name ("candidates seen: typical 12 → 15"); a name with fewer says "too few reports to compare yet". Two versions of one workflow are compared through `parentVersion`; the Timeline on the Cycles page says how the share reported as done well and the typical (median) time moved against the previous version, once BOTH versions have at least 5 run reports with metrics (the floor of the evals); before that it says "Too few reports to compare yet". There is no eval gate on these numbers.
- C88 / L12: `lessons` are free text from agents. Only the owner reads them: `cycle_get` (person op, newest first, at most 500; `runMetrics.lessonCount` is the full count) and "Show lessons" on the Cycles page (plain text, never markup). `test/run-metrics.test.ts` proves that no agent op returns metrics or lessons.

### T1 evals (`eval/`)

`node eval/run.ts [--out <file>]` runs two synthetic, public-safe suites through the real code and prints one `tealbrick.eval/1` line (JSON) per metric; exit 1 on any failure. CI runs it on every pipeline (`tealbrick-ci.json` `preReleaseChecks`, ci-v9.6+).

- `eval/cases/detector/*.json` (49 Task Board histories, 32 must-suggest groups): `parseDoneIssues` + `buildGroups` + the N filter, as the scan does. ANY case mismatch fails the run. Cases with `knownMiss: true` (3 near-duplicates: word order, plural, typo; pinned in a test) carry the gold group the detector should reach (E5 targets): only missing gold groups are tolerated (reported in the `known_misses` line, kept out of precision and recall); a wrong extra group fails, and a full match fails with "known miss now passes: remove knownMiss", so E5 progress is locked in. Precision and recall over the other cases must reach the measured baseline 1.0 / 1.0 (`thresholds.json`; G6 floors 0.9 / 0.8).
- `eval/cases/cycles/*.json` (20 run histories, incl. exactly 5 terminal runs: the minimum sample is inclusive): `runStats` + `cycleEval` + `verdictOf`; every expected verdict and metric value must match.
- `test/evals.test.ts` proves the runner exits 1 on a mutated threshold, a wrong expected list, one extra or one missing group, and four broken detectors (status filter, covered set, non-agent flat assignee, number normalisation); all in memory, the corpus is never edited to make a test pass.

### Task Board (soft dependency)

The manifest declares one companion product, `kanban`, with four operations: `issues_list` (read), `issue_create`, `issue_complete` and `issue_block`. The detector calls `issues_list` with `{"status": "done", "limit": 200}` and reads `issues[]` with `id`, `title`, `status`, `assignee {kind, id, name}` (only `kind: "agent"` counts) and `template`. Without Task Board the scan answers `unavailable` and Evolution works with agent suggestions alone (run issues are then not created). The scan runs in the background (first scan 60 s after start, then every 15 minutes) as an app-initiated companion call with Evolution's own grant, and on demand (`detector_scan`); `detector_status` shows the last result. What Evolution read with its own grant (Task Board titles and the text built from them) is shown only to the owner; agents see detector suggestions as fixed text plus issue ids. Evolution sees done work only in the projects the owner shares with it (shared projects, or projects granted to Evolution on the Task Board scopes page).

### Recipe

`recipe_export` emits a `tealbrick.recipe/1` (Portal API section 3) with no `ws` and no concrete Portal id (`$ref` to step 0's output). The Bound agent's allowlist always includes `evolution.workflow_get`. Apply it with `tealbrick recipe import <file>` and the review link, then one confirmation in the browser. The default agent harness choice in the UI is "Other agent (MCP)".

## Language

New code is TypeScript (Node 24+).

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | the only description of the app (ops, companion, agent directory, skill, backups, UI paths) |
| `src/app.ts` | `defineApp`: one typed handler per operation (`#kit` op ids and I/O types) |
| `src/store.ts` | suggestions, events, drafts, workflows, versions over the SDK `Db` |
| `src/model.ts` | pure rules: steps, allowlist, promotion checks, version diff |
| `src/detector.ts` | Task Board pattern detector (harvest of the v1 evaluator) |
| `src/scan.ts` | the detector's background refresh and on-demand scan |
| `src/recipe.ts` | Bound-agent recipe builder |
| `src/routines.ts` | schedules, due/claim/report, missed records, sweep (cron rule from the manifest package) |
| `src/cycles.ts` | cycle ledger computed on read (with the run-metrics rollup and lessons); stored evals (`eval_runs`) |
| `src/evals.ts` | pure eval of a cycle (gates, verdict); reads `eval/thresholds.json` |
| `eval/` | T1 evals: `run.ts`, `thresholds.json`, `cases/detector/`, `cases/cycles/` |
| `src/templates.ts` | seed workflow templates |
| `src/ui/` | owner UI in `<AppShell>`: Suggestions, Drafts, Workflows, Schedules, Cycles, Holds, Agents |
| `migrations/` | 6 forward-only migrations: `0001_init.sql` (0.1), `0002_routines.sql` (0.2), `0003_detector_state.sql`, `0004_policy_stale_runs.sql` (0.2.13: rebuilds `routine_runs` to allow `policy_stale`), `0005_eval_runs.sql` (0.3.0: stored cycle evals, `routine_runs.reported_at`), `0006_run_metrics.sql` (C288 R8: the table `run_metrics`, nothing else changes). Never edit a released file. |
| `scripts/upgrade-check.ts` | upgrade check on a COPY of a real 0.2.12, 0.2.13 or 0.3.0 `app.db`: applies the new migrations like the SDK and compares every row; prints counts only |
| `skills/use-evolution/SKILL.md` | agent skill: when to suggest, Bound-agent behaviour |
| `Dockerfile` | the one opt2 app Dockerfile pattern |
| `.woodpecker/ci.yaml`, `.github/workflows/opt2-release.yml` | the opt2 CI template ci-v9.9, generated from `Tealbrick/opt2-tealbrick-platform`; do not edit |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |
| `conformance.start.ts` | boots the app for `tb-conformance` |
| `test/` | model, detector, recipe, routine, cycle ledger, eval and flow checks, upgrade, UI checks |

Scaffolded with `create-tealbrick-miniapp`.

## Develop

```sh
corepack enable && pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck && pnpm lint && pnpm test
pnpm build            # kit, server to dist/, UI to dist/ui/assets-<hash>/
pnpm conformance      # SDK conformance suite against this app (not release evidence; QA is)
node eval/run.ts      # T1 evals (detector corpus, cycle gates); exit 1 on any failure
pnpm gen              # tb-gen: openapi, kit, docs, railway (gen/, not committed)
TB_STANDALONE=1 TB_DATA_DIR=.data TB_DATA_EPHEMERAL=1 pnpm start   # app-alone mode: person UI only (operations answer 503 no_bridge)
```

## Environment

The SDK reads only `TB_*` variables (SDK API section 13). The Dockerfile defaults `TB_DATA_DIR=/data` (the `data` volume mount) and `TB_BACKUP_DIR=/data/backup` (one volume per service). The deploy recipe sets the rest: `TB_INSTANCE_ID`, `TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`. Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`, `TB_STANDALONE`. The listen port is the manifest `runtime.port`. The app has no keys and no app-specific environment variables. `TB_DATA_EPHEMERAL=1` is for tests and local runs only; never set it in a deploy recipe.

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` on a green pipeline and push the tag. The GitHub Actions workflow builds and publishes the image and kit (release assets only from CI). Tags are immutable.
3. The platform signer indexes the release (`registry-sync` signs the index entry with the image digest and the manifest digest).
4. Core deploys the newest stable version when the owner installs or updates the app. An update that fails keeps the previous version serving.

Check `publisher` and `source.repo` in the manifest. The repository name must match the image name in `tealbrick-ci.json` (`opt2-tealbrick-evolution`).

## Dependency pins

`@opt2-tealbrick/*` dependencies are pinned as tarball URLs on the dist host (`Tealbrick/opt2-tealbrick-dist` releases). `pnpm-lock.yaml` carries the sha512 integrity of every such tarball. After changing one, run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): design of this app (operations, scopes, data, background work).
- [`CONTRIBUTING.md`](CONTRIBUTING.md): how to change it.
- Runtime contract: `docs/SDK-API.md` in `Tealbrick/opt2-tealbrick-specs`. UI kit: `Tealbrick/opt2-tealbrick-packages`.
- System documentation (overview, environments, runbooks) lives in the private repo Tealbrick/opt2-tealbrick-docs.
