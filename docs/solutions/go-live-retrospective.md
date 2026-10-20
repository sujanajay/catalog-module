# Go-live retrospective (2026-10-19 to 2026-10-20)

Why things that worked earlier kept breaking during the expedited go-live, what we are doing
wrong at the root, and what to change. Written from `docs/PROGRESS.md` and
`docs/plans/2026-10-21-go-live-resume.md` (branch `docs/go-live-progress`), the expedited plan,
`docs/specs/00-execution-protocol.md`, PRs #11 to #44, `.github/workflows/ci.yml`,
`infra/deploy.sh`, `infra/deploy-preview.sh`, the test layout and the Cloud Run error logs of
2026-10-20 (read only).

Short answer: most things did not "break again". The code did what it was tested to do, but it was
tested on made-up images and on the happy path, and the first time it met real photos, a real
network or a real load was on the one live site, with the owner using it. Every incident was then
fixed for the exact case that showed it, not for its whole class, so the next case of the same
class surfaced in the next round.

## (a) The failures

Time costs are wall-clock estimates from PROGRESS.md timestamps; one deploy is 40 to 60 minutes.

| # | What broke | Real root cause | Code or process | Caught by | What would have caught it earlier | Cost |
|---|---|---|---|---|---|---|
| 1 | Render defects, round after round: shadows as grey blocks (gate 1), cut edges floating above a white pad band (gates 1, 2, 3, 3b), close-ups whose product vanished in the cut-out (gate 2), skin lost under a trim close-up (gate 3), bags off-centre (gate 2) | Render and matte guard rules were built and unit-tested on synthetic `sharp` images (16 test files create images in code; no real photo is in the repo). Real-photo checks (tier 3) are excluded from `pnpm test` and the full run was skipped. Each fix PR proved itself on the photos that found it (#27, #29, #38, #41, #43 all show real before/after) but those photos lived in session scratchpads and were never kept as a regression set, so the next variant of the same class (cut edge in a band of the background colour, cut on both ends of an axis) appeared at the next gate | Process (test strategy), then code | Human quality gates on the live site, after a deploy | A committed real-photo regression set run in CI, grown by every gate finding | 4 gate rounds, 9 fix PRs (#24, #27, #29, #37, #38, #39, #41, #42, #43), 4 deploys: roughly 10 to 12 hours. Two bad close-ups went live because the judge passed them |
| 2 | First eval job died after 2 h 20 min on one `socket hang up` reading one golden photo; no partial report | Long job with no retry on storage reads and no checkpoint. The retry helper existed since PR #25 but was applied only to Cloud Tasks `createTask` | Code | The run itself (log: `catalog-output-evals` 03:56 UTC `FetchError ... vero_moda/Z17C8FD7F6E2BF0DECC04Z_2.jpg`) | A rule that every network call goes through `retryTransient` and every job longer than 10 minutes writes progress | 2 h 20 min plus PR #44 |
| 3 | Load driver died on one failed poll (`catalog-load-dn5rd`, 04:15:11 UTC), its cleanup skipped, batch `1b83ac80` left rendering | One failed `catalog_batches` query ended the whole pass (exit 1). The failed query was a symptom of failure 4 | Code | The run itself | Same retry rule; a load driver that treats DB errors as data, not as fatal | 15 min run lost, leftover test batch, fix stream still open |
| 4 | The live site went down for the owner (about 04:15 to 04:24 UTC) while quality gate 3b was in flight | Shared Cloud SQL `ila-pg` is `db-f1-micro` with no `max_connections` override (Cloud SQL default for this tier is 25, a few of them reserved). Worst-case catalog demand alone: worker 10 instances x `DB_POOL_MAX` 2 = 20, web 3 x 3 = 9, plus every job at 2, plus `ila-web` and `ila-worker`. The 270-option load test scaled the worker up and used every slot. Logs: 30 web errors `53300 remaining connection slots are reserved` from 04:17:15 to 04:21:53, worker `Failed query` and `ingest task failed` errors to 04:23:54 | Process (load test on the shared live stack while it was in use) and infra (no connection budget) | The owner | A connection budget checked in `deploy.sh`; a rule that load tests never share time or a database with users | About 10 min outage, a disturbed gate run, the owner's trust |
| 5 | Deploy `fixes1` of `a9dde84` failed at the smoke with "Image not found" | The manager pulled PR #43 into the main checkout while `deploy.sh` was running; `infra/catalog-test-jobs.sh` re-reads `git rev-parse --short HEAD`, so it looked for an image tag that was never built | Process (manager mistake), helped by a script that re-reads mutable state | The deploy | Deploying from a dedicated, pinned worktree; scripts take the tag once and pass it down | One deploy cycle, about 30 to 40 min |
| 6a | Judge false holds: multipack singles, packshot vs worn, size charts, a sole view called "different product"; 30% of products held at gate 2 | Judge prompt ignored the view role and product type; verdict was a mean of scores; no second opinion | Code (prompt design), tested only with a mocked judge | Quality gates 1 and 2 | A small labelled real set run against the live judge before merge (spec 07 had a `catalog-qa-check` job for this; it skips the hard-case set) | PRs #32, #34, #37; part of the gate rounds |
| 6b | Ingest hand-off `14 UNAVAILABLE: read ECONNRESET`, batch stuck at "Collecting files 0 of ?" | Cloud Tasks gRPC client does not retry `CreateTask`; the batch was marked collecting before the hand-off | Code | e2e flow 4 | Same retry rule | PR #25 plus a re-run |
| 6c | "Detect automatically" stored the literal `auto` as the product type, so the classifier never ran and model photos got synthesised shadows | Untested path between wizard and pipeline; unit tests passed a concrete type | Code | The owner's output-quality investigation | One real end-to-end batch per wizard option in the smoke | PR #24 and the shadow rework that followed |
| 6d | Cost line showed USD 0.00 after real spend; compute spend not counted | 2-decimal rounding of about USD 0.0008; `COMPUTE_USD_PER_VCPU_SECOND` unset | Code and config | e2e flow 6 | A smoke assertion that a batch with judge calls shows non-zero cost | PRs #28, #31 |
| 6e | Smoke failures at the 07 deploy: redelivered shots staged under the wrong prefix, stale public cache read back twice | Real public bucket cache behaviour never exercised before deploy | Code | The tier 5 smoke (it worked as designed) | Nothing cheaper; this is the smoke doing its job | 3 extra deploy attempts, PRs #17, #20, #21, #22 |
| 6f | 06 deploy stopped at the smoke; later a deploy stopped on an expired gcloud login | Manager's uncommitted PROGRESS.md in the main checkout; login expiry not checked before a long run | Process (manager) | `deploy.sh` dirty-tree guard (failed safely) | Same pinned deploy worktree; a pre-flight `gcloud auth print-access-token` (already in protocol section 2) | About 20 min and one blocked wait for the owner |

What worked and should be kept: the tier 5 smoke stopped three real bugs before they reached the
site; the dirty-tree guard failed safe; every fix PR from #27 on showed real-photo before/after
evidence; PR #43 compared all 110 gate-3 sources main vs branch by sha256, which is the right
habit; nothing destructive happened to data or GCP resources.

## (b) What we are fundamentally doing wrong

### 1. Real photos are tested by people on the live site, not by machines before merge

- `pnpm test` (what CI runs) has 99 test files; the image tests draw shapes with `sharp`. The five
  `*.real.test.ts` files are excluded from CI and skip unless `REAL_DATA=1`.
- The expedited plan told builders "Skip edge-case and exhaustive tests. Add only the tier 1 tests
  the spec names" and recorded "Full 3,910-photo tier 3 runs are skipped" and "Docker is not
  required". Codex's spec 05 Cloud Build verification had in fact ended FAILURE and was accepted.
- The smoke runs one product per brand for two brands (French Connection and `test_brand` reusing
  Anta). It has no Penti, no Vero Moda grey background, no close-up, no size chart, and a mocked
  judge, so it cannot see any defect class the gates found.
- The cut-edge class needed four fixes (#27, #38, #41, #43). Each was right for its trigger
  photos; none was re-checked against all earlier trigger photos because they were not kept.
- The real-photo evidence that would form a regression set sits in OS temp scratchpads
  (`qa-gate-2/`, `qa-gate-3/`, `shadow-fix/`, `closeup-fix/`). The resume file warns they "may be
  cleaned by the OS later".

### 2. One environment does everything

The live site is also the test bench, the gate, the load target and the owner's demo. All of them
share one `db-f1-micro` Cloud SQL instance with the older `ila-*` apps, and nobody wrote down how
many connections each part may use. `infra/deploy-preview.sh` exists but no preview service exists
in the project today, so it has never been used during go-live. Even if it had been, it shares the
same Cloud SQL instance, database, buckets, matting services and product locks (see section c3),
so it would have kept unmerged code off the owner's screen but would not have stopped failure 4.

### 3. Network and database calls assume the happy path

`retryTransient` (`packages/core/src/retry.ts`) is used in exactly two places: Cloud Tasks
`createTask` (added after failure 6b) and the eval suite's storage reads (added after failure 2).
The shared storage wrapper, the database layer, the load driver and the job polls have no retry.
`isTransientError` does not recognise Postgres `53300` (too many connections) or `57P01`
(connection terminated). Each incident was fixed where it happened, not as a class, which is why
the same kind of failure came back in a new place.

### 4. Long runs are all-or-nothing and run on top of each other

The eval job ran 2 h 20 min with no checkpoint; the load job had a 24-hour timeout and died on one
query; the load test was started while gate 3b was rendering on the same worker and database. No
rule said which heavy runs may overlap or that the owner must be told.

### 5. The manager's own operating habits

The main checkout was used both for `git pull` and as the deploy source (failures 5 and 6f); the
first manager session ran out of context mid-go-live and needed a hand-off file; the order of the
next steps (deploy, gate, evals, load) was fixed but not their overlap. To be fair, these mistakes
cost about two hours in total; points 1 to 4 cost far more.

## (c) Changes

Each item is small on purpose. Owner approval is needed where marked.

### c1. Process rules

1. No load test, fault injection or eval run on the shared stack while anyone (owner, gate,
   e2e) is using it. Announce the window; check the batch list shows no batch in progress;
   run load only after the connection budget (c3.2) allows it.
2. Never deploy from the main checkout. Deploy from a pinned worktree:
   `git worktree add --detach "C:\Users\Sujan AH\Desktop\catalog-module-wt\deploy-<sha>" <sha>`,
   run `bash infra/deploy.sh` there, remove the worktree after. The main checkout can then be
   pulled at any time.
3. Every fix PR re-runs the gate case that found it, plus every earlier case of the same defect
   class, before merge, and the PR body shows the numbers. After deploy, the gate re-runs only
   those cases first (a 10-minute check), then the full gate.
4. Every network or database call that is safe to repeat goes through `retryTransient`; every job
   that can run longer than 10 minutes writes progress and a partial report, and can resume.
5. Real-photo findings are saved, not left in a scratchpad: every gate defect adds its source
   photo, the matte and the expected measurement to the regression set (c2.1) in the fix PR.
6. Heavy runs are serial: deploy, then gate, then evals, then load. Never two at once.
7. Speed-to-launch reductions must name what replaces the dropped check. "Tier 3 skipped" was
   replaced by human gates on production, which is the most expensive place to find a defect.

### c2. Test changes

1. Real-photo regression set in CI. Commit about 30 real sources with their stored mattes
   (a few MB, taken from the gate evidence before the OS cleans it) under
   `packages/core/test/regression/`, with expected measurements per channel. A vitest file renders
   each with the stored matte (no matting service needed, so CI can run it) and asserts the
   defect classes found: cut edge flush (band 0 px), no shadow block (no straight shadow edge,
   no grey step above 6 levels), close-up product kept (matte guard), skin kept, grey background
   clean, bag centred, size chart left out. Start with the gate 1-3 cases; owner to confirm the
   photos may sit in the private repo.
2. A fast golden check in the deploy smoke: a 10 to 15 product subset of the spec 10 golden set
   (one per defect class and brand, including Penti and Vero Moda), run with the spec 10 checkers
   on the just-built image, blocking the service update. The full 90-product eval stays a separate
   run.
3. Smoke covers more than one product per brand and every wizard option that changes the
   pipeline (at least "Detect automatically", which hid the `auto` bug).
4. The smoke asserts a non-zero cost line when the judge was called (mocked cost).
5. A small labelled real judge set (multipack, packshot vs worn, chart, sole view, planted wrong
   item) run with `LIVE_SMOKE=1` before merging any judge prompt change.

### c3. Infrastructure changes

1. What the preview path does today: `infra/deploy-preview.sh` sets `CATALOG_PREVIEW=1` and runs
   `deploy.sh`, which builds only the worker and web images (`infra/cloudbuild-preview.yaml`),
   skips migrate, still runs the smoke, deploys `catalog-worker-preview` and
   `catalog-web-preview` with the queue `catalog-preview`, reuses the live matting services and
   skips the jobs. Its header comment ("from the unmerged 06 branch") is stale. It shares
   `ila-pg`, the `catalog` database, both buckets and the product locks with live.
   Would it have protected the owner? For the gate runs, partly: unmerged render code could have
   been gated on preview while the owner kept the last good build. For the outage, no: the load
   and the owner's site would still compete for the same connection slots.
   Proposal: use the preview path for every gate run of unmerged fixes (no new resource), and
   give load tests their own database capacity (c3.3).
2. Connection budget written in `deploy.sh`: a short block that computes
   `worker max-instances x worker DB_POOL_MAX + web max-instances x web DB_POOL_MAX + jobs x 2 +
   ila apps` and stops the deploy if it exceeds `max_connections` minus reserved slots. Today it
   does not fit (20 + 9 already exceeds the default of 25). Options, owner to choose: lower worker
   `--max-instances` to 6 and web `DB_POOL_MAX` to 2 (fits, lower peak throughput), or raise
   `max_connections` with a database flag (needs a short restart of `ila-pg`, shared with the
   `ila-*` apps), or move up one tier (cost).
3. Load tests on their own capacity: either a temporary Cloud SQL instance created by an
   idempotent `infra/*.sh` for the load window and stopped afterwards (owner approval: cost and
   the no-always-on rule), or load only in an announced quiet window under the budget above.
4. Database errors `53300`, `57P01`, `08006` and `ECONNREFUSED` count as transient in
   `isTransientError`, and the database client retries acquiring a connection with backoff.
5. Scripts read the git tag once: `deploy.sh` passes `TAG` to `catalog-test-jobs.sh` and
   `catalog-smoke-linux.sh` instead of each calling `git rev-parse` again.

## (d) Next 24 hours vs later

Next 24 hours:
1. Copy the gate evidence (gate 2, gate 3, shadow-fix, closeup-fix source photos and mattes) from
   the OS temp scratchpads to `gs://image-links-agent-assets/catalog-test/regression/` before
   it is lost.
2. Finish quality gate 3b on `f3d30b1` and re-check every earlier cut-edge, close-up and skin
   case on it (rule c1.3), before any new render change.
3. Do not re-run the load test until the connection budget (c3.2) is agreed; land the load driver
   poll retry with `53300` treated as transient (c3.4).
4. Deploy only from a pinned worktree (c1.2); pass the tag down to the smoke scripts (c3.5).
5. Run the full eval (`run`, `run --live`, `run --write-policy`) only when no gate or load is
   running (c1.6).

Later (this week):
1. Real-photo regression set in CI (c2.1) and the fast golden subset in the smoke (c2.2).
2. Smoke with more products per brand and the wizard options (c2.3, c2.4).
3. Retry sweep: storage wrapper, database client, matting and OpenRouter callers, job polls (c1.4).
4. Preview path for gate runs (c3.1) with its stale comment fixed; decision on load capacity (c3.3).
5. Restore the full tier 3 run as a nightly job with a spend cap, not a skipped step.

## Proposed text for AGENTS.md and 00-execution-protocol.md (owner decides; not applied)

Add to `AGENTS.md` under "Working rules for this repo":

```
- Never deploy from the main checkout. Deploy from a pinned worktree
  (git worktree add --detach catalog-module-wt\deploy-<sha> <sha>); never pull or switch the main
  checkout while a deploy runs.
- No load test, fault injection or long eval on the shared stack while anyone is using the live
  site. Heavy runs are serial: deploy, gate, evals, load. Announce the window to the owner.
- Cloud SQL ila-pg is shared and small: every change to max-instances or DB_POOL_MAX must keep the
  connection budget in infra/deploy.sh within max_connections.
- Every network or database call that is safe to repeat uses retryTransient; every job longer than
  10 minutes writes progress and a partial report and can resume.
- A fix PR for a defect found on real photos adds those photos to the regression set and re-runs
  every earlier case of the same defect class before merge.
```

Add to `docs/specs/00-execution-protocol.md`:

In section 6, after the tier table rules:

```
- Real-photo regression set: packages/core/test/regression/ holds real sources with stored mattes
  and expected measurements. It runs in pnpm test (CI). Every defect found by a quality gate, an
  e2e flow or the owner adds its case here in the fix PR.
- Tier 5 also runs a fast golden subset (one product per defect class and brand) with the spec 10
  checkers on the just-built image; any failure blocks the service update. The smoke covers more
  than one product per brand and every wizard option that changes the pipeline.
- Reduced testing must name what replaces each dropped check, in PROGRESS.md Assumptions.
```

In section 9, step 4, replace "from the main checkout on main, git pull" with:

```
4. If the spec says deploy: create a pinned worktree at the merged commit
   (git worktree add --detach "C:\Users\Sujan AH\Desktop\catalog-module-wt\deploy-<sha>" <sha>),
   run bash infra/bootstrap.sh and bash infra/deploy.sh from it, and remove it afterwards. The main
   checkout is never moved during a deploy. Gate runs of unmerged fixes use infra/deploy-preview.sh.
```

In section 11, add:

```
- A load, fault or long eval run would overlap with a gate, an e2e run or the owner's use of the
  live site, or would exceed the Cloud SQL connection budget.
```

In section 12, add:

```
13. A fix is not done until the case that found it, and every earlier case of the same class,
    pass again on the deployed build.
14. Heavy runs never overlap; the owner is told before any run that loads the shared stack.
```
