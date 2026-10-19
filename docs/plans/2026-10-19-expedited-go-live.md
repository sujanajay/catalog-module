# Expedited go-live plan (specs 05-09)

Date: 2026-10-19.

This file supersedes the earlier local plan for specs 05-09; the numbered specs in `docs/specs/`
stay the source of truth for what to build. Status lives in `docs/PROGRESS.md`.

## Context

Another coding agent (Codex) left specs 05, 06 and 07 half-done: 05 and 06 are code complete on
draft PRs #11 and #12 but were never run in the cloud, and 07 is about one third done with
uncommitted work spread over two branches. The owner wants the catalog module live now, with
reduced testing. All implementation, testing and fixing is done by Opus 5.5 subagents; the main
session is the manager and only coordinates. Decisions of 2026-10-19: the run is full end to end,
including merging PRs after CI is green and deploying with `infra/deploy.sh`; specs 05-07 go
first, then specs 08 and 09 follow in the same run. Further decisions of 2026-10-19: PRs are
merged when CI is green and `infra/deploy.sh` deploys (unchanged); the smoke runs on the
just-built image through the remote job; a dummy test brand `test_brand` is added; a quality gate
on about 50 real photos runs after the 07 deploy, before e2e; the full 3,910-photo tier 3 run is
restored as the last step.

## Execution plan

### Audit of 2026-10-19

| Spec | Branch state | Verdict |
|---|---|---|
| 05 matting and render | `feat/catalog-05-matting-and-render`, 34 commits, all builder branches merged, local = origin, draft PR #11 | Code complete. Open: our own lint/typecheck/test run; Codex rewrote parts of the spec text (timeout 180 s, canvas formula, shadow alpha threshold, compliance edge rule, one resident model session) to match the code; a full 3,910-photo verification run was claimed on Cloud Build but the build id is not found. |
| 06 pipeline and UI | `feat/catalog-06-pipeline-and-ui`, 57 commits on top of 05, draft PR #12, local = origin, all 13 builder/codex branches merged | Code complete: pipeline stages, publish, finalize and sheets, wizard, batch/product/brand pages, 15 routes, Playwright human spec, `deploy.sh` for all services, `pnpm catalog:smoke`. Gates green (lint, typecheck, 602/602 tests). Never run in the cloud: deploy.sh end to end, per-brand smoke, Playwright on a deployed URL. The smoke runs the pipeline in-process and needs a real database, GCS and `REAL_DATA_DIR`; `deploy.sh` has a `CATALOG_REMOTE_SMOKE=1` path that runs the Cloud Run job `catalog-test-smoke`, but that job needs the worker image of the current commit, which deploy.sh builds only after the smoke gate. Smoke fixtures appear staged at `gs://image-links-agent-assets/catalog-test/smoke/`. |
| 07 QA, attention, SKUs | `feat/catalog-07-qa-attention-and-skus`, 2 commits on top of 06, pushed by Part A | About one third done. Committed: judge, classifier, policy, caps, cost, decisions in `packages/core`. WIP (committed by Part A) on `codex/spec07-web` (five routes, web lib, attention helpers) and `codex/spec07-worker` (qa-stage, pipeline edits). Not written anywhere: ReplaceModal, SkuMapModal, EvalLabelBar, CostLine, the `AttentionList` screen, `catalog-qa-check` job and `infra/catalog-qa-check.sh`, `deploy.sh` env for OpenRouter and caps, Playwright steps 7-10. Bugs: per-batch `options.qaCapUsd` never applied; `estimateCost` compute part silently 0; `ensureDefaultPolicies` ignores its `health` argument. |

Access and infra:
- Public read on `gs://image-links-agent-public`: `allUsers` has `roles/storage.objectViewer`;
  effective org policy `storage.publicAccessPrevention` is `enforce: false`. The first real
  publish proves it (anonymous GET must return 200).
- `openrouter-api-key` has an enabled version. GPU: 1 L4 in asia-southeast1,
  `catalog-matting-gpu` deployed. BigQuery warehouse still read through the mirror (works).
- Codex's spend estimate: USD 91.92 of a USD 100 cap for 05-07. The owner accepts further spend
  for go-live; the e2e run uses one small batch.

### Rules for every subagent
- Model: Opus 5.5 for every subagent, no exceptions.
- Briefing: 00-execution-protocol section 4 template, plus: "Speed to launch. Skip edge-case and
  exhaustive tests. Add only the tier 1 tests the spec names for your files. Where the spec is
  unclear choose the simplest reasonable option and list it under Assumptions." Return summaries
  only (what changed, files touched, test result line, open issues, assumptions), under 400 words.
- Builders never deploy, never touch `main`, never call OpenRouter live, never touch GCP.
- One worktree per workstream under `<repo parent>\catalog-module-wt\<nn>-<slug>` (00 section
  3). Merge via PR with squash. Conventional commits, no co-author line, no em dashes.
- The manager reads only summaries and `docs/PROGRESS.md`; it updates PROGRESS.md after every
  item and commits it with the next PR.

### Step 1: spec 05 to main (parallel with steps 2 and 3)
Subagent "05-gates" (worktree on `feat/catalog-05-matting-and-render`):
`pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`; fix failures (max
3 attempts each). Spend at most 10 minutes looking for Codex's full-data evidence (Cloud Run job
outputs under `catalog-test/`, `docs/solutions/catalog-05-acceptance.md`); if not found, record
"not found, accepted under reduced testing". Accept the spec-text changes; list them.
Manager: `gh pr ready 11`, `gh pr checks 11 --watch`, `gh pr merge 11 --squash --delete-branch`.
No deploy yet (06 deploys all services together).

### Step 2: spec 06 to main (rebase depends on step 1)
Subagent "06-gates" (worktree on `feat/catalog-06-pipeline-and-ui`):
- Reorder `infra/deploy.sh` (done): build images, migrate (the smoke needs the new schema and
  the seeded test brand), run the remote smoke (`catalog-test-smoke` job on the just-built
  worker image; `CATALOG_LOCAL_SMOKE=1` runs it in-process instead), then update matting, worker
  and web; any `failed_compliance` still blocks the service update. The smoke reaches the
  deployed matting service, makes no OpenRouter call, unpacks its fixtures from
  `gs://image-links-agent-assets/catalog-test/render-05-1792340617303-555901/inputs/*.tar`, writes
  evidence under `catalog-test/smoke/linux-<run>/`, and reports brands without fixtures as skipped.
- Test brand (done): slug `test_brand`, "Test Brand", softline, source manual, seeded
  idempotently at the end of the migrate job with 5 manual `sku_map` rows; every `test_brand`
  batch is forced to `is_test = true`, so its objects only land under `catalog-test/` and it never
  appears in real brand reports. The smoke runs it on the first Anta product with 3+ shots.
- After PR #11 merges: `git merge main`, re-run the four gates, push.
Manager: `gh pr ready 12`, CI, squash-merge; then from the main checkout `git pull`,
`bash infra/bootstrap.sh` (expect all SKIP), `bash infra/deploy.sh` in the background, tracked
with `gcloud run services list` polls. Record `WEB_URL` and revisions in PROGRESS.md.

### Step 3: finish spec 07 (three builders start at once, in parallel with steps 1 and 2)
Base: `feat/catalog-07-qa-attention-and-skus`. Builder worktrees:
- "07-worker" on `codex/spec07-worker` (renamed `feat/catalog-07-qa-attention-and-skus--worker`):
  finish the QA stage and publish gate (spec 07 W2), fix `caps.ts` so `options.qaCapUsd` is
  applied, make `estimateCost` use a documented default instead of 0, fix `ensureDefaultPolicies`
  to honour `health`, add `apps/worker/src/catalog-qa-check.ts` plus its esbuild entry.
- "07-web" on `codex/spec07-web` (renamed `...--web`): finish the five routes and libs, build
  `AttentionList`, `ReplaceModal`, `SkuMapModal`, `EvalLabelBar`, `CostLine` with the exact copy
  from specs 01 and 07, wire them into the batch page.
- "07-infra-tests" on the feature branch: `infra/deploy.sh` env (`OPENROUTER_API_KEY` secret
  mount on the jobs only, `CATALOG_QA_DEFAULT_MODEL`, `DAILY_SPEND_CAP_USD`, `INR_PER_USD`),
  `infra/catalog-qa-check.sh` (idempotent job), Playwright steps 7-10 in
  `apps/web/test/human/catalog.human.spec.ts`, the no-model-name grep test.
Then "07-integration": merge the three branches (`--no-ff`), merge `main` after 06 lands, run
the four gates, fix (max 3 attempts), push, open the PR with the 00 section 8 template. Then
"07-review": `/code-review` on the diff, fix bugs and contract violations only, re-run gates.
Manager: CI, squash-merge, `bash infra/deploy.sh` (smoke gate included), record revisions.

### Step 3b: quality gate (after the 07 deploy, before e2e)
Subagent "quality-gate": a `test_brand` batch of about 50 real Anta and French Connection photos,
all channels, on the deployed stack. Checks: anonymous GET 200 + JPEG, per-channel dimensions and
margins, compliance 100%, sheet rows = objects, verified = re-check, and visual inspection of at
least 10 rendered outputs. Any defect is fixed (fix PR, merge, redeploy) before e2e starts.

### Step 4: one round of end-to-end testing as a real user (after the 07 deploy)
Subagent "e2e" with Playwright or the Chrome extension on `WEB_URL`, signed in as the owner.
Flows in order, each must pass:
1. Sign-in through IAP lands on `/catalog`; a viewer-only account is read-only (login/auth).
2. Core journey: new batch, one brand, upload 3-5 real Anta photos, two channels, confirm the
   grouping on step 4, start, wait for "Ready to download" or "Needs attention".
3. Public links: open two delivered URLs with no credentials, expect 200 and a JPEG; the sheet
   downloads; "Independent re-check: N of N OK" is shown.
4. User-data writes and deletes: re-upload the same product with one photo changed and one
   dropped; same links, new generations, removed link gone (overwrite contract).
5. Needs attention: one held product; "Use as is" and "Remove this photo" both work.
6. Money flow: the INR cost line shows on the batch page; the deployed env has
   `DAILY_SPEND_CAP_USD` set (read the service env, do not spend to prove it).
Fix what breaks (fix PR, merge, redeploy), re-run only the affected flow, stop. Test batches
use `is_test` or a `catalog-test` product id prefix; no deletes outside `catalog-test/`.

### Step 5: specs 08 and 09 (same run, reduced)
08: build `catalog-eval` and the policy writer; bake-off only the primary matting candidates on
one golden set per brand that has real photos (Anta, French Connection); judge bake-off limited
to the default judge plus two candidates; write `model_policy` rows. 09: build `catalog-recheck`,
the fault proxy and load driver; load test at one tenth scale (270 options); hand-over note and
GIF. Every reduction is logged under Assumptions in PROGRESS.md.

### Step 6: full tier 3 run (last step)
The full 3,910-photo real-data run on `test_brand`, as a Cloud Run job against the deployed stack.
Report compliance % and defect count; cleanup under `catalog-test/` only. The run stops at
`DAILY_SPEND_CAP_USD`; partial counts are reported as progress.

### Parallelism map
```
t0  05-gates ------\                       07-worker ----\
    06-gates --------+                     07-web -------+--> 07-integration -> 07-review
                     |                     07-infra-tests/           |
t1  merge #11 -> 06 merge main -> merge #12 -> deploy ------> merge 07 -> deploy -> quality gate -> e2e
t2                                                                                      08 -> 09 -> full tier 3
```

### Verification (reduced, non-negotiable items kept)
CI green on every PR; `infra/deploy.sh` completes with the smoke passing and `WEB_URL` printed;
the six step-4 flows pass on the live URL with video or screenshots listed in PROGRESS.md;
anonymous GET on a delivered link returns 200; the quality gate passes with visual inspection.
Skipped on purpose: exhaustive edge cases, full-scale fault injection, the full bake-off matrix.

### Known risks
Org policy may still block anonymous reads in a way read-only checks did not show (step 4 item 3
is the proof; if it fails, stop and report the denied action). Codex's spec-05 text changes are
accepted unreviewed. Live judge calls spend money; the cap stays at the spec default. Docker is
optional; anything needing a local container runs against the deployed service or is skipped.
