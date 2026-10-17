# 00 Execution protocol

How a spec under `docs/specs/` is executed. The human opens one spec file and says "execute". From
then on the main session acts as the manager, delegates building to subagents, tests, merges,
deploys when the spec says so, and ends with one report that finishes "Ready for the next spec".
There are no questions to the human in between unless something truly blocks.

Source of truth: `docs/SPEC.md`. Repo rules: `CLAUDE.md`. This file restates the rules that matter
during execution so that nobody has to look elsewhere. Shared contracts (types, tables, paths,
routes, env vars) are defined in `02-scaffold-and-foundations.md`; roles and sign-in are defined in
`03-auth-and-roles.md`. Later specs restate what they use and say "defined in 02" or "defined in
03"; they never redefine it.

Words used below:
- Subagent: a separate agent started by the manager with its own instructions and context.
- Worktree: a second checkout of the same git repository in another folder, on its own branch,
  so two pieces of work never touch the same files at the same time.
- PR: a GitHub pull request, the only way code reaches `main`.
- CI: the GitHub Actions workflow `.github/workflows/ci.yml` that runs lint, typecheck and tests
  on every PR.
- Idempotent: safe to run twice; the second run changes nothing and reports what it skipped.

The repo has one product. Its home page is `/catalog` (the batch list); `/` redirects there.
There is nothing else to land on.

## 1. Roles

| Role | Who | Reads | Does |
|---|---|---|---|
| Human | the product owner (also the admin) | the final report | says "execute", approves the UI prototype (spec 01), creates what only a person can create (secret versions such as the OpenRouter key, Google shares), grants access when the report asks, adds operators in the People modal |
| Manager | the main session | the spec, `docs/SPEC.md`, `CLAUDE.md`, this file | worktree, task board, delegation, commits, PR, merge, deploy, smoke, report |
| Builder subagent | one per workstream named in the spec | its briefing (section 4) | builds one workstream in its own worktree, runs tiers 1 and 2, returns a summary plus test output |
| Integration subagent | one per spec | the spec, the builders' summaries | merges workstreams on the feature branch, runs every tier the spec names, fixes failures (at most three attempts per failure) |
| Review subagent | one per spec | the diff | `/code-review` on the diff, then `ce-simplify-code` on settled code |

The manager never builds features itself. Builders never deploy, never run `infra/deploy.sh`,
never touch `main`, never call OpenRouter live, never create or change GCP resources.

## 2. Preconditions (manager checks before anything else)

- [ ] The spec file exists, its number is the next one not yet merged, and the previous spec's
      "Ready for the next spec" report exists in the session or in `docs/solutions/`.
- [ ] `git -C "C:\Users\Sujan AH\Desktop\catalog-module" status --short` on `main` is clean and
      `main` is up to date with `origin/main`.
- [ ] `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test` pass on `main`
      (from spec 02 on; before 02 there is no code).
- [ ] `gcloud auth print-access-token` works (re-run `gcloud auth login` otherwise). Every gcloud
      call exports `CLOUDSDK_CORE_PROJECT=image-links-agent`; the global gcloud config is never
      changed, because the operator's default project is a different one.
- [ ] For specs with a tier 3 test: Docker Desktop is running.
- [ ] For specs that deploy `catalog-web` (03 and later): `iap.googleapis.com` is enabled and the
      IAP service agent exists (both ensured by `infra/bootstrap.sh`; no human step).
- [ ] For specs with a tier 4 test: the tester is signed in to the deployed URL with a Google
      account that has the operator or admin role; `apps/web/test/human/login.ts` saved
      `.playwright/auth-state.json`.

If a precondition fails, the manager fixes it when the fix is inside the repo; otherwise it stops
and reports (section 10).

## 3. Worktree and branch naming

- Feature branch: `feat/catalog-<nn>-<slug>` from `main`, where `<nn>` is the spec number and
  `<slug>` is the spec file name without the number, for example
  `feat/catalog-02-scaffold-and-foundations`. The full list is in `docs/specs/README.md`.
- Feature worktree: `C:\Users\Sujan AH\Desktop\catalog-module-wt\<nn>-<slug>`. Create it from the
  main checkout with
  `git worktree add -b feat/catalog-<nn>-<slug> "C:\Users\Sujan AH\Desktop\catalog-module-wt\<nn>-<slug>" main`.
- Builder worktrees (one per workstream that touches different files than the others): branch
  `feat/catalog-<nn>-<slug>--<workstream>` from the feature branch (two dashes, not a slash: git
  cannot hold a branch `X` and a branch `X/sub` at the same time), path
  `C:\Users\Sujan AH\Desktop\catalog-module-wt\<nn>-<slug>-<workstream>`. Workstreams that touch
  the same files run one after the other in the feature worktree instead.
- Builders commit on their branch with conventional messages. The integration subagent merges them
  into the feature branch with `git merge --no-ff`. Nothing is force-pushed, ever.
- After the PR merges, the manager removes the worktrees with `git worktree remove <path>` and
  deletes the merged local branches. Remote branches are deleted by the PR merge.

## 4. Subagent briefing template

Every builder receives exactly this, filled in. It is the only context the builder has.

```
You are building workstream <letter> "<name>" of docs/specs/<nn>-<slug>.md.
Worktree: <absolute path>. Branch: <branch>. Do not leave this worktree.
Read first, in full: the spec section "<section title>", docs/SPEC.md, CLAUDE.md.
Files you own (create or change only these): <list>.
Contracts you must satisfy verbatim (types, signatures, routes, columns, env vars): <paste from the spec>.
Before you use any library, framework, API or SDK, fetch its current docs through Context7 and follow them.
Tests you must add and pass: <tier 1 and tier 2 items for this workstream>.
Run before you finish: pnpm lint && pnpm typecheck && pnpm test (from the repo root of your worktree).
Rules: never commit to main; Supabase is read only; never delete GCP resources; secrets only through
Secret Manager env mounts, never printed or logged, never `gcloud secrets versions access`; test
cleanup only under catalog-test/; conventional commit messages; no em dashes in any text you write
(use "-"); never add your agent name as a co-author; models are never shown to the operator.
Return: a summary of what you built, the exact test command output, anything you could not do and why.
```

The integration and review subagents get the same header plus their task from section 7.

## 5. Task board

The manager keeps a task board in the session (not a file) with one row per workstream, the
integration step, the review step, PR, merge, deploy, smoke and report. Each row has a state:
`todo | running | done | blocked`. The board is pasted into the final report.

## 6. Test tiers and when they run

| Tier | Name | Command | Runs where | Required by |
|---|---|---|---|---|
| 1 | Unit (vitest) | `pnpm test` | builder worktree, feature branch, CI | every spec from 02 |
| 2 | Integration (PGlite + fakes) | `pnpm test` (same run) | builder worktree, feature branch, CI | every spec that touches the database or the worker |
| 3 | Real-data pipeline | `REAL_DATA=1 pnpm test:real` | integration subagent; local Docker for `catalog-worker` and `catalog-matting` | specs 02 to 09 as each names it |
| 4 | Human-like browser | Playwright `apps/web/test/human/catalog.human.spec.ts` against the deployed URL | manager after deploy | specs 06, 07, 09 |
| 5 | Per-brand smoke | `pnpm catalog:smoke` (spec 06 defines it) | inside `infra/deploy.sh`, before the image build, on every deploy | specs 06 to 09 |
| 6 | Load | `pnpm catalog:load` (spec 09 defines it) | integration subagent | spec 09 |

Rules:
- Tiers 1 and 2 run on every builder branch, on the feature branch and in CI
  (`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`).
  PGlite is an in-process Postgres used so tests need no database server.
- Tier 3 tests are files named `*.real.test.ts`, excluded from `pnpm test`, included by
  `pnpm test:real` (`vitest run --config vitest.real.config.ts`), and skip themselves unless
  `REAL_DATA=1`. They copy inputs to `gs://image-links-agent-assets/catalog-test/<run-id>/...`,
  write public test objects only under `catalog-test/`, and delete their objects at the end, even
  on failure (`finally`). They never write outside `catalog-test/`. Source data sets are read only
  (local folders and Supabase links listed in the spec).
- Tier 4: `apps/web/test/human/login.ts` opens `WEB_URL` in a headed browser; the tester signs in
  with Google; the script saves `context.storageState({ path: ".playwright/auth-state.json" })`.
  `catalog.human.spec.ts` uses that state with `recordVideo`. The saved state expires with the
  session; re-run `login.ts` when the test is redirected to Google's sign-in page. The video is turned into a
  GIF for the hand-over (spec 09 collects it). The Chrome extension may be used for exploratory
  runs; it never replaces the recorded run.
- Tier 5 blocks deploy: `infra/deploy.sh` runs `pnpm catalog:smoke` before `gcloud builds submit`
  and stops on any `failed_compliance`, so a failing smoke never reaches Cloud Run. The smoke runs
  one product per brand through all nine channels twice; the second pass alters one photo and
  drops one shot and asserts the same URLs, new generations, the removed link gone and the untouched
  channel unchanged. If a deployed service misbehaves after a deploy, roll back by redeploying the
  previous commit's images with `SKIP_BUILD=1 bash infra/deploy.sh` from a checkout of that commit
  (deploy.sh tags images by git short SHA).
- Live OpenRouter calls happen only in the Cloud Run jobs that mount the key and only when
  `LIVE_SMOKE=1` is set: `catalog-qa-check` (spec 07) and `catalog-eval` (spec 08). Every other
  test, including the local tier 5 smoke, mocks OpenRouter.

## 7. Integration and review steps

Integration subagent:
1. Merge every workstream branch into the feature branch (`--no-ff`), resolve conflicts.
2. `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test`.
3. Run the tier 3 tests the spec names. Start local services with Docker as the spec describes.
4. Fix what fails. At most three attempts per failure; after the third, stop and report the failure
   with the exact output to the manager, who stops and reports to the human.
5. Return the test outputs verbatim (trimmed to the summary lines plus any failure).

Review subagent:
1. Run `/code-review` on `git diff main...HEAD` in the feature worktree.
2. Fix every finding that is a bug, a contract violation or a missing test. Note findings skipped
   and why.
3. Run `ce-simplify-code` on the settled code. Re-run tiers 1 and 2.

## 8. PR body template

```
## <nn> <spec title>

Spec: docs/specs/<nn>-<slug>.md. Source of truth: docs/SPEC.md.

### What shipped
- <one line per workstream>

### Contracts added or changed
- <types, routes, env vars, tables, object paths; "none" if none; a change to a 02 or 03 contract is listed here and was proposed in the report first>

### Test evidence
- Tier 1+2: `pnpm test` -> <N passed, 0 failed> (CI run <link>)
- Tier 3: `REAL_DATA=1 pnpm test:real` -> <sets used, outputs count, compliance 100%, cleanup confirmed>
- Tier 4: <video or GIF path | "not required by this spec">
- Tier 5: <smoke report link | "not required by this spec">
- Tier 6: <load report | "not required by this spec">

### Excluded or deferred
- <anything the spec asked for that is not in this PR, and why>

### Infra
- bootstrap.sh second run: <all SKIP, exit 0 | not touched>
- deploy: <yes/no>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Commit messages are conventional (`feat(catalog): ...`, `fix(web): ...`, `chore(infra): ...`,
`docs(specs): ...`), end with the attribution line the session reminder gives, and never add an
agent name as co-author.

## 9. Merge, deploy, smoke, learnings

1. Push the feature branch; open the PR with `gh pr create` using the template above.
2. Wait for CI green (`gh pr checks --watch`). Never merge red. Never bypass hooks or signing.
3. Merge with `gh pr merge --squash --delete-branch` (squash keeps one conventional commit per spec).
4. If the spec says deploy: from the main checkout on `main`, `git pull`, then
   `bash infra/bootstrap.sh` (must end with all SKIP on a second run) and `bash infra/deploy.sh`.
   deploy.sh is the only place that deploys; builders never run it. Services are `catalog-web`,
   `catalog-worker`, `catalog-matting`; jobs are `catalog-migrate`, `catalog-qa-check`,
   `catalog-eval`. deploy.sh prints `WEB_URL`.
5. Tier 5 runs inside deploy.sh (from spec 06 on). Read the smoke report it prints. If deploy.sh
   stopped on a `failed_compliance`, nothing was deployed: fix, re-run the gates, deploy again.
6. If anything non-obvious happened (a permission that had to be granted at project level, a flag
   that behaved differently, a Windows path issue, a restore of a previous object generation),
   write it to `docs/solutions/<topic>.md` in a follow-up `docs:` PR. Never edit CHANGELOG or
   auto-generated files.
7. Remove worktrees and merged local branches.

## 10. "Ready for the next spec" report template

One message to the human, no questions:

```
Spec <nn> <title>: merged (PR #<n>) and <deployed to <WEB_URL> | not deployed (spec does not deploy)>.

What shipped
- <bullets>

Test evidence
- Tier 1+2: <counts>
- Tier 3: <sets, counts, compliance %, cleanup>
- Tier 4: <video or GIF path | n/a>
- Tier 5: <per-brand smoke summary | n/a>
- Tier 6: <load summary | n/a>

Excluded and why
- <bullets or "nothing">

Contract changes proposed (02 or 03)
- <bullets or "none">

Learnings written
- <docs/solutions/... or "none needed">

Task board
<the board from section 5>

Ready for the next spec: <nn+1> <title>.
```

Spec 09 ends with `Programme complete; no next spec.` instead of the last line.

If something blocks: replace the last line with `Blocked: <exact thing needed>` and list what the
human must do (for example add a secret version, grant a role, share a Google Sheet, provide a
data set). Nothing else is asked.

## 11. Blocking rules (stop and report instead of guessing)

- A gate still fails after three fix attempts.
- Access is missing: a GCP permission, a BigQuery dataset, a Google Sheet or Drive folder share,
  a data set path that does not exist.
- A secret version that only the human can create (for example the OpenRouter key; bootstrap
  creates containers and never the values). Sign-in needs none: IAP uses the Google-managed OAuth
  client (03).
- An infra step would delete or overwrite a GCP resource, or would change the operator's global
  gcloud config.
- A spec contract cannot be met without changing a contract from 02 or 03 (02 defines the shared
  types, tables, paths, routes and helpers; 03 defines roles and sign-in; 04 to 09 consume them).
  A change to a contract defined in 02 or 03 is proposed in the report, never made silently, and
  no spec other than 02 and 03 ships a migration.
- A real-data test would write outside `catalog-test/` or would modify a Supabase object.
- A public object write or delete would fall outside the prefix of the product the worker holds
  the lock for (`assertWithinProduct` throws; the task fails loudly and is reported).
- Cost: a tier 3, 5 or 6 run would exceed the daily QA cap (`DAILY_SPEND_CAP_USD`) or would need
  always-on resources.

## 12. Process behaviours to keep

These are habits learned on earlier real deliveries. The manager, the subagents and the operator
guidance (spec 09 hand-over note) all follow them.

1. Never hand over a preview as a deliverable. Step 4 "Start" is a check; the links sheet of a
   batch that says "Ready to download" or "Needs attention (N products)" is the deliverable.
2. State in words how products were told apart (the identifier mode and rule, for example
   "grouped by file name before the last _number") before processing starts and again in the
   hand-over message for the sheet.
3. The finished sheet is re-checked independently: a fresh process reads the sheet file, fetches
   every link with plain GETs and reports "Independent re-check: N of N OK" next to the pipeline's
   "Links verified: N of N". A human reads both numbers before sharing the sheet.
4. When a sheet is shared, list the products with numbering gaps and the products flagged for text
   or watermarks, by identifier.
5. When a product was overwritten, re-filed under another identifier, or had shots removed, tell
   whoever holds an earlier sheet for that brand.
6. A vision spot-check that a brand folder looks consistent is a hint, not proof that the folder
   belongs to that brand; the batch's brand is what the operator chose.
7. Count products as unique identifiers, never as files. A product with five photos is one product.
8. Before a large run, confirm the grouping with the requester on a sample of one or two rows of
   the grouping table.
9. Every new matching or grouping rule learned on a real batch is written into `docs/solutions/`
   and `docs/SPEC.md` before the job is called done.
10. Never report a result until the final count is in; partial counts are progress, not results.
11. Compare `sha256` of the photos before deciding that a re-delivery is "the same photos";
    identical names are not proof.
12. Before a re-delivery, produce a sheet of the previous live links on request (the brand sheet
    from the brand page), so the holder of the earlier links can compare.

## 13. Repo rules restated (from CLAUDE.md)

- `docs/SPEC.md` is the source of truth; plans in `docs/plans/`, learnings in `docs/solutions/`,
  executable specs in `docs/specs/`.
- GCP project `image-links-agent`, region `asia-south1`. gcloud only; every infra change goes in
  `infra/*.sh`, idempotent (check-then-create), re-runnable. Scripts export
  `CLOUDSDK_CORE_PROJECT=image-links-agent`.
- Shared resources from the earlier app (VPC `ila-vpc`, subnet `ila-subnet`, Cloud SQL `ila-pg`,
  bucket `image-links-agent-assets`, Artifact Registry repo `apps`, secret `openrouter-api-key`)
  are reused and never deleted. The earlier `ila-web` and `ila-worker` services are not touched.
- Never print, read or log secret values. Secrets come from Secret Manager env mounts only. Never
  run `gcloud secrets versions access`.
- Operator IAM is roles/editor + projectIamAdmin + serviceAccountAdmin. Resource-level IAM on Cloud
  Run services may be denied; grant at project level and note it in `docs/solutions/`.
- No deletes of GCP resources without asking.
- Supabase is only ever read.
- Live OpenRouter calls only in jobs gated by `LIVE_SMOKE=1`; all other tests mock OpenRouter.
- Keep costs low: Cloud Run min-instances 0, Cloud SQL db-f1-micro, no always-on resources.
- Subagents for independent workstreams; one git worktree per workstream; merge via PR.
- Never commit to `main` directly. Conventional commits. No em dashes anywhere; use "-".
- Test cleanup only under `catalog-test/`.
- Scoped overwrite: the worker overwrites and deletes only objects under the prefix of the product
  it holds the lock for, and only in the channels of the running batch; never another product's
  objects, never raw, never exports, never outside `catalog/` and `catalog-test/`. Enforced by
  `assertWithinProduct` in code, by a unit test, and by bucket versioning with a 30-day retention
  of previous versions (at most three per path) as the safety net. A batch is an event: it never
  edits itself after it finishes and its sheets and reports are kept; the product's current state
  is the truth, and a later batch for the same product replaces its public images in place at the
  same links.
- Before using an external library, framework, API or SDK, fetch its current docs through Context7.
- Models are chosen automatically per brand and category and never shown to the operator.
