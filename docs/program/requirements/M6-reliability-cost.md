# M6 Cost, capacity and reliability - requirements (2026-11-02)

Status: draft for Sujan's review. Planning only; no code changed, nothing run against production. Follows
`00-template.md`. Feature ids and priorities come from `../module-map.md` section M6 and slices S4 and S5. Two of
Sujan's explicit asks (quota asks, tiered tests) are P1 in the map; they are written closer to full depth here because
he asked for them by name.

Words used here (defined once):
- **Billing export**: Google Cloud's daily copy of the bill into a BigQuery table, line by line, with labels. Being
  enabled now (intent I046).
- **Billable instance time**: the seconds Cloud Run charges for, including start-up, waiting and the idle tail after
  the last request (about 15 minutes on instance-billed GPU services). This is what the bill counts, not the seconds a
  model was busy.
- **Ledger**: our own per-event cost table, `catalog_cost_events`.
- **Idle pool**: billed cost that no batch event explains (start-ups, idle tails, waiting).
- **Reconciliation**: comparing the ledger with the bill every day and showing the gap.
- **Revision**: one deployed version of a Cloud Run service. **Traffic shift**: moving requests from the old revision
  to the new one. **Drain**: letting the old revision finish what it is doing before it stops.
- **Expand and contract migration**: change the database in two steps, first add (old and new code both work), and
  only a release later remove what the old code needed.
- **Incident**: anything that stopped or slowed a batch without the operator causing it (a stall, a dropped task, a
  timeout, an outage).
- **Tiered tests**: fast checks first, slower and costlier checks only when the change needs them.

## 1. Purpose

- **Why:** the cost ledger says USD 0.004 per product against USD 0.08-0.15 measured on the GPU default (about 60x
  low; 67x on load 5), a deploy took about 2.5 hours (31 Oct, 01:49 to 04:15 UTC) and batches are kept away from
  deploys, quotas cap throughput, a load test once took the live site down (20 Oct), and changes take hours to verify.
- **Outcome metrics:** cost per product within 10% of the GCP bill; zero batches failed by a deploy; 99% of batches
  reach "links ready" with no person; a typical change verified in under 15 minutes.
- **Intents:** I015, I025, I029 (live-tool audit findings), I034, I035, I036, I046.

## 2. Scope

**In (first slice):** the true cost meter (every attempt logged, daily reconciliation with monitoring now and the
billing export when it exists, idle as its own line), batches that survive deploys (and shorter deploys), batch success
and incident tracking.

**In (P1, inside the 12 weeks):** idle control, retry and checkpoint as a rule, quota and machine sizes, separate
load-test capacity, tiered tests.

**Out:** product features, pricing to customers (M12), vendor contracts (M7 bake-offs pick vendors; M6 meters them).

**Later:** full blue-green across GPU services (module map disagreement 7: not a week-one item), multi-region
failover, per-customer billing.

## 3. Contracts

**Reads from M0:** batch, option and content version ids (to price cost per version and per option); the change log
cursor is not needed.

**Writes for others:** `catalog_cost_events` rows (extended), daily cost tables, batch outcomes and incidents. M1 shows
the batch's true cost and success in its digest; M12's Ops page shows the rest; M0 contamination incidents (an outside
change on an experiment listing) are written to the same incident table.

**API and table shapes.**
- `recordCost(event)` in `packages/core/src/catalog/cost.ts` (exists as the ledger writer) gains `content_version_id`,
  `attempt_outcome` covering every failure, and `component` (the Cloud Run service or job name).
- New tables (section 7.1): `catalog_cost_days`, `catalog_cost_allocations`, `catalog_vendor_invoices`,
  `catalog_batch_outcomes`, `catalog_incidents`.
- `GET /api/catalog/ops/cost?from&to` and `GET /api/catalog/ops/reliability?from&to` for the Ops page.
- Labels on every Cloud Run service and job: `app=catalog`, `component=<name>`, `env=live|preview|test` (services are
  labelled today; jobs are not).

**Contract needs from M0:** `content_version_id` on outputs (M0-F2) so cost per version is a join, and option ids on
products (M0-F1) so cost per option is a join. Nothing else.

## 4. Features

### M6-F1 True cost meter (P0)

**User story.** As Sujan, I want one number for what a product really costs (GCP plus vendors, including idle and
failures), that matches the Google bill, per batch, per brand and per day.

**What exists.** `catalog_cost_events` records priced events (judge calls, matte and upscale calls, render compute)
with `outcome`, `estimated` and `attempt`; `catalog_batches.cost` and `spend_days` hold totals; `cost-report.ts` feeds
the Ops page. The cost report (2026-11-02) lists why it is low: it prices service-reported inference seconds, not
billable time; failed calls are missing; worker waiting is not counted; jobs, web, Cloud SQL, storage and egress are
not metered; rates are list prices.

**Functional requirements.**
- M6-F1-R1: Every paid attempt writes a ledger row, including failures, 429 and 5xx retries, timeouts, duplicate
  deliveries, fallbacks and calls whose delivery was killed (the enlargement `call_started_at` pattern of spec 18 3.10
  is applied to every paid call).
- M6-F1-R2: The worker records its own request wall time per delivery as `kind = compute`, `stage` of the work, so
  waiting on matting or upscaling is in the ledger (load 5: ledger 24,945 vCPU-s against 181,000 billable worker
  seconds).
- M6-F1-R3: Jobs (load, invariants, recheck, evals, smoke, cleanup, backfill, export) write one ledger row per run
  with their billable seconds, `batch_id` when they belong to one, else `component` only.
- M6-F1-R4: A daily reconciliation job (`catalog-cost-reconcile`, Cloud Run job) computes per day and per component:
  - **billed** cost: from the billing export when it exists (rows with `labels app=catalog`, grouped by `component`
    label, net of credits); before that from Cloud Monitoring `billable_instance_time` times the list price per
    component, marked `source = monitoring`, `estimated = true` (the method of the cost report);
  - **attributed** cost: the ledger's rows for that component and day;
  - **idle pool** = billed minus attributed (never negative; a negative gap is an alert, it means the ledger
    over-counts).
- M6-F1-R5: The idle pool is spread over the day's batches in proportion to their attributed busy seconds on that
  component, written to `catalog_cost_allocations`. A day with billed cost and no batch shows the whole amount as
  "idle, no batch" (for example a GPU idle tail after a test).
- M6-F1-R6: Shared costs not labelled by service: Cloud SQL `ila-pg` is split by an admin-set share (default: the
  catalog's share of the connection budget, 104 of 393); GCS storage and egress by bucket labels; Artifact Registry and
  Cloud Build as "platform" lines. Each appears as its own line, not hidden in per-product cost.
- M6-F1-R7: Vendors off the GCP bill (OpenRouter today; Photoroom, FASHN and others later) use the vendor's reported
  cost per call; an admin enters the monthly invoice total in `catalog_vendor_invoices` and the gap is shown like the
  GCP gap.
- M6-F1-R8: The billing export lands with a delay. The reconciliation runs for day D at D+1 06:00 UTC (provisional)
  and re-runs at D+3 (final); the Ops page marks provisional days.
- M6-F1-R9: True cost per product for a batch = (attributed + allocated idle + its share of shared lines) divided by
  products with links; shown next to the marginal cost (attributed only). The M1 digest and the batch page show the
  true number.
- M6-F1-R10: A daily check: ledger plus idle plus shared lines equals billed within 1% (arithmetic check), and the
  monitoring estimate is within 10% of the export once both exist (method check). Either failing raises an alert.
- M6-F1-R11: Rates in code (`DEFAULT_PRICE_*` in `cost.ts`, `COMPUTE_USD_PER_VCPU_SECOND` in `deploy.sh`) stay only
  for the live estimate and the wizard estimate; reported cost comes from reconciliation. When the export shows a
  different effective rate (discounts, credits), the estimate rates are updated from it monthly (admin setting, not a
  deploy).

**Non-functional.** Reconciliation job under 10 minutes a day, 1 database connection, BigQuery query cost under USD 1 a
month. Ledger writes add under 2 ms per call. Accuracy target: true cost within 10% of billing per day and per month
(I025); arithmetic closure within 1%.

**Admin configuration.** Shared-cost split rules (Cloud SQL share, platform lines), reconciliation schedule, alert
thresholds, vendor invoice entry, estimate rates.

**Inputs and outputs.** In: ledger, billing export (`gcp_billing_export_resource_v1_<account>` style detailed table;
the exact name and columns are confirmed against Google's documentation when the export exists), Cloud Monitoring
`billable_instance_time`, vendor invoices. Out: `catalog_cost_days`, `catalog_cost_allocations`, true cost per batch,
product and brand, the Ops cost card.

**Human in the loop.** A billing admin enables the export once (asked in gate 1, decision 3). An admin enters vendor
invoices monthly until vendors offer a usage API. Nothing per batch.

**Edge cases and failure modes.**
- Export not enabled yet: monitoring method, labelled estimated (about plus or minus 30% per the cost report until the
  per-product counts come from the database).
- A service without labels: its billed cost shows as "unlabelled" and raises an alert; `deploy.sh` refuses to deploy a
  service or job without `app` and `component` labels.
- Preview and load-test stacks: labelled `env=preview` or `env=test` and reported apart, never in operator cost.
- Credits or refunds arrive late: the D+3 re-run picks them up; later corrections show as a month-level line.
- The shared `ila-pg` changes tier: the share setting is reviewed (alert when the instance's billed cost changes by more
  than 20%).

**Buy or build.** Build. Nobody gives one cost across vendors and own GPUs; FinOps tools (for example Google's own cost
reports) show cost by service, not by batch or product. Google's billing export is the bought part (free).

**Acceptance tests.**
1. For one real batch day after the export exists: the Ops page's billed total for `app=catalog` equals a hand query
   of the billing export for that day within 1%, and the batch's true cost per product is within 10% of (that day's
   billed catalog cost divided by products made that day) when only that batch ran.
2. Kill the upscaler mid-batch: the failed calls appear in the ledger with `outcome = failed`, and the day's idle line
   is shown separately.
3. Before the export exists: the same page shows the monitoring estimate marked "estimated", within 10% of a hand
   calculation from `billable_instance_time` (the cost report method).

**Open questions.**
- Q: How to split `ila-pg`? Default: by connection budget share (catalog 104 of 393), reviewed when the tier changes.
- Q: Show INR as well? Default: yes, at the admin-set rate (`INR_PER_USD` exists).

### M6-F2 Batches survive deploys (P0)

**User story.** As an operator, I want to start or keep running a batch at any time, including while a deploy runs,
and never lose it or see the site go down. As the team, we want a typical deploy to take minutes, not hours.

**What exists.** Every service deploys through `deploy_service` (`infra/lib/gate.sh`, spec 17): a no-traffic candidate,
a probe on its tag URL, then a traffic shift to exactly that revision; a failing probe leaves traffic where it was;
rollback in seconds; unchanged services SKIP. Queues never lose slots before the new worker is live
(`infra/lib/queues.sh`). Chunk queues retry 429 and 503 for 30 minutes, enlarge lanes retry without limit, chunk leases
recover lost work in minutes (spec 15, spec 17 G4). The connection budget is checked in `deploy.sh`. Gaps: the ingest
queue still gives up after 5 attempts (7bdee361 was left "ingesting"), the deploy runs the long CPU-upscale and GPU
probes even when only web or worker code changed (31 Oct: the CPU upscale gate alone took about 35 minutes), the
migration step has no written rule that it must work with the previous release's code, the worker has no defined
behaviour on shutdown, the protocol keeps heavy runs and deploys apart by people, and logins expired twice
mid-deploy.

**Functional requirements.**
- M6-F2-R1 (database): every migration is additive and works with both the live code and the new code (expand and
  contract). A CI check fails any migration that drops, renames or retypes a column or table, adds `NOT NULL` without a
  default, or adds a CHECK that existing rows may break, unless the file is marked `-- contract: <release>` and the
  previous release no longer reads the object.
- M6-F2-R2 (tasks): every task body carries a version number; the worker accepts the current and the previous
  version, and ignores fields it does not know. A test runs the previous release's task bodies against the new
  handlers.
- M6-F2-R3 (shutdown): on SIGTERM the worker stops claiming new chunks, finishes or checkpoints the photo in hand,
  releases or lets lapse its leases, and returns before the shutdown grace ends. A delivery cut off by shutdown is
  re-sent by the queue and resumed from the checkpoint; it never counts as a failed attempt.
- M6-F2-R4 (queues): no queue drops a task because of a deploy. The ingest queue moves to the same rule as the enlarge
  lanes: unlimited attempts with the handler deciding when a row is terminal (it counts real failures on the upload
  row), backoff 10 s to 15 min. The sweep re-sends an intake task when an upload has been `ingesting` with no progress
  for 30 minutes.
- M6-F2-R5 (overlap budget): during a traffic shift the old and new worker revisions can both hold connections. The
  connection budget in `deploy.sh` counts the candidate's probe instances and the old revision's instances together,
  and refuses a shape that does not fit.
- M6-F2-R6 (web): the web keeps serving through a deploy (traffic shift is atomic); the new web works with the old
  worker and the old web with the new worker (one release apart), which the gate already orders (web before worker).
  Browser polls that hit a moved route get a JSON error the wizard retries, never a crash page.
- M6-F2-R7 (shorter deploys): a probe runs only for a service whose image digest or deploy flags changed (extend the
  existing SKIP to the probe step); the matting, upscale and GPU probes run in parallel when more than one changed; the
  worker smoke runs on the new worker against the live matting services when those did not change. Target: a web or
  worker-only change deploys in under 30 minutes end to end; a full deploy with GPU changes under 75 minutes.
- M6-F2-R8 (pre-flight): `deploy.sh` checks the gcloud login has at least 3 hours left (and the Cloud Build and job
  identities work) before building, and stops with the login command otherwise (two deploys stopped on an expired
  login, 30 and 31 Oct).
- M6-F2-R9 (pinned source): deploys run from a pinned worktree at the merged commit (retrospective c1.2), and every
  script takes the image tag once (c3.5); `deploy.sh` refuses a dirty tree (exists).
- M6-F2-R10 (no human quiet window): the rule "do not deploy while a batch runs" is retired once R1-R5 pass their
  acceptance test; the deploy prints the batches in flight and proceeds.
- M6-F2-R11 (mid-batch shape changes): a deploy never lowers max instances or queue slots below what in-flight batches
  were dispatched against until those batches finish; a lower shape is applied when the stack is idle (the deploy
  waits up to 30 minutes, then applies with a warning).

**Non-functional.** Zero failed or duplicated outputs caused by a deploy; batch delay from a deploy under 5 minutes; no
user-visible error page during a deploy; rollback under 1 minute per service (exists).

**Admin configuration.** None at runtime; deploy shape stays in `infra/lib/shape.sh` (structure, not business
settings). The "wait for idle before lowering shape" timeout is an env value.

**Inputs and outputs.** In: commits on main. Out: live revisions, a deploy report with duration per step, in-flight
batches before and after.

**Human in the loop.** Sujan approves production deploys (manager rules). Nobody watches batches during a deploy.

**Edge cases and failure modes.**
- A migration that cannot be made additive (rare): two releases, expand first, contract later; the CI check forces it.
- A GPU service change during a batch: the candidate is probed with no traffic; the old revision keeps serving; the
  worker's matting client already retries busy answers.
- Cold start of a new GPU revision after the shift: the enlarge lanes answer 503 without counting (spec 18 3.8), so
  tasks wait instead of failing.
- A deploy fails half way: earlier services are live, later ones untouched (exists); in-flight batches continue on the
  mix because of the one-release compatibility rule.
- Old instances killed before finishing (Cloud Run's shutdown grace is short): R3 checkpoints and leases cover it.

**Buy or build.** Build (our scripts). Cloud Run gives revisions, tags and traffic shifts; no product is needed.

**Acceptance tests.**
1. On the preview stack, start a 200-product batch, then deploy a worker-only change and a web change while it runs.
   The batch finishes with the same output count and hashes as a run without a deploy, no output failed or duplicated,
   no task dropped, its success record says `deploy_overlap = true`, and the web never returned an error page to a
   Playwright session polling the batch page.
2. Repeat with a matting GPU change: same result.
3. A worker-only change deploys to live in under 30 minutes, measured from `deploy.sh` start to `DEPLOY_OK`.
4. CI rejects a test migration that drops a column without the contract marker.

**Open questions.**
- Q: Keep the human quiet-window rule until the test passes on live? Default: yes; retire it after one live deploy with a
  real batch in flight passes acceptance test 1's checks.

### M6-F3 Batch success tracking (P0)

**User story.** As Sujan, I want every batch to record whether it reached "links ready" without a person and without an
incident, so reliability is a number, not a feeling.

**Functional requirements.**
- M6-F3-R1: At finalize, each batch writes one `catalog_batch_outcomes` row: `success` (links ready, no operator touch
  after upload, no incident), `links_ready_at`, `first_links_at`, `duration`, `touches` (count of operator writes after
  upload: decisions, retries, Fix and continue, reopen, cancel), `incidents` (count), `deploy_overlap` (bool),
  `products`, `products_with_links`, `true_cost_usd` (from F1, filled when reconciled).
- M6-F3-R2: Incidents are written to `catalog_incidents` by the code that sees them: the sweep (no progress, failed
  batch), invariants (any ERROR), queue give-ups, Cloud Run 5xx bursts linked to a batch window, deploy refusals,
  contamination from M0, and alerts from `infra/monitoring.sh`. Each has `kind`, `severity`, `batch_id` (if any),
  `started_at`, `resolved_at`, `cause` (free text plus a code), `repeat_of` (the earlier incident of the same kind).
- M6-F3-R3: Touches are counted by the API layer (every operator POST on a batch or output after the batch's first
  upload), not by guessing from logs.
- M6-F3-R4: Test and load batches are recorded with `is_test` and excluded from the success rate.
- M6-F3-R5: The Ops page shows the 7-day and 30-day success rate, incidents by kind, repeat incidents, and the slowest
  batches. A success rate under target for a day raises an alert.
- M6-F3-R6: Worker ingest and chunk deliveries log one INFO line per outcome with batch and upload ids (the 574f2025
  investigation found successful ingest logged nothing).

**Non-functional.** Under 50 ms added to finalize; incidents written within 5 minutes of detection.

**Admin configuration.** Success target (default 99%), which incident kinds count against success.

**Human in the loop.** None; the manager reads the weekly number.

**Edge cases.** A batch cancelled by the operator: recorded, `success = false`, cause `cancelled`, excluded from the
rate only when cancelled within 10 minutes of start (a mistake, not a failure). A batch extended by a follow-up: each
batch has its own row; the parent links to the child.

**Buy or build.** Build (internal).

**Acceptance tests.**
1. Run three real batches: one clean, one where the operator presses Try again once, one where the upscaler is stopped
   for 20 minutes. The Ops page shows success, touches 1, and one incident with cause and resolution time.
2. The 7-day success rate on the Ops page equals a hand count from `catalog_batch_outcomes`.

**Open questions.**
- Q: Does a provisional link count against success? Default: no (it is by design); an exception (no link at all) does
  not either, but both are shown.

### M6-F4 Idle control (P1)

**Story.** As the cost owner, I want GPU warm windows shared by many products, because idle is the biggest cost (about
60% of GPU matting seconds; each cold cycle costs about USD 0.31 on L4 and USD 0.96 on RTX PRO 6000).
**Key requirements.** Batches dispatched in bursts per lane so one warm window covers them; an optional min-instances
of 1 only during a batch window, and only when gaps are under 15 minutes; no CPU upscaler fallback by default (GPU
default since 31 Oct; the CPU lane stays for rollback); test whether a smaller RTX shape fits the model (CPU and memory
are 59% of its per-second price). Metric: idle share of GPU seconds (baseline about 60%; target under 30%).
**Acceptance test.** Two 200-product batches started 10 minutes apart show one warm window per GPU service, and the
reconciled idle line for the day is under 30% of GPU cost.
**Buy or build.** Build (dispatch and shape settings).

### M6-F5 Retry and checkpoint as a rule (P1)

**Story.** As the team, we want every network and database call retried and every long job resumable, so the same kind
of incident never comes back in a new place (retrospective b3, b4).
**Key requirements.** Every network and database call that is safe to repeat goes through `retryTransient`
(`packages/core/src/retry.ts`); `isTransientError` covers Postgres `53300`, `57P01`, `08006`, `ECONNREFUSED`, GCS 429
and 503; a lint rule flags direct calls to the storage, database and HTTP clients outside the wrappers; every job or
delivery that can run over 10 minutes writes progress and resumes (the 30-minute grouping timeout of 7bdee361 was this
class). Metric: repeat incidents of the same kind (from F3).
**Acceptance test.** The fault proxy (`apps/worker/src/fault-proxy.ts`) injecting 5% resets on storage and database
calls during a 200-product preview batch leaves the batch successful.
**Buy or build.** Build.

### M6-F6 Quota and machine sizes (P1, explicit ask)

**Story.** As Sujan, I want the exact quota requests to file so 2,000 SKUs an hour is possible, and to know which one
matters first.

**Key requirements.** File these asks (from the 2026-11-02 cost and quota report; sizing per product: 9.35
enlargements, 4.7 photos, about 42 outputs, about 125 worker vCPU-seconds):

| Quota | Region | Now | Ask | Why |
|---|---|---|---|---|
| Cloud Run memory allocation | asia-south2 | 400 GiB | 800 GiB | 8 RTX instances x 80 GiB; today only 5 fit |
| RTX PRO 6000 GPU (no zonal redundancy) | asia-south2 | shown as "6000" (unit to confirm) | 8 GPUs | 5.2 enlargements per second at 2,000 SKUs/h needs 6 |
| NVIDIA L4 (no zonal redundancy) | asia-southeast1 | 3 | 8 | 2.6 cut-outs per second needs about 4, plus warm-up |
| Cloud Run CPU allocation | asia-south1 | 400 vCPU | 600 vCPU | worker 32 x 4 plus fallbacks, preview and the ila and npd apps; deploys were refused at 374 of 376 |
| Instances per project | project | 100 | 200 | the sum of service max in asia-south1 is already about 106 |
| Cloud Run CPU allocation | asia-south2 | 200 vCPU | keep (240 for 10 instances) | 8 x 20 = 160 |
| OpenRouter account | n/a | unknown | confirm paid key and no daily cap | about 3.9 judge calls per second at 2,000 SKUs/h |

After grants: raise the GPU upscaler max from 4 to 8, the `catalog-enlarge-bulk` queue to 7 per second and 32
concurrent (the `shape.sh` rule), and the L4 matting max to 8, through a normal gated deploy. Order of value: RTX plus
asia-south2 memory first (enlargement is the limiting stage), then L4, then asia-south1 CPU and instances. The script
`infra/request-gpu-upscale-quota.sh` exists and has not been run (31 Oct report).
**Metric.** Throughput at 2,000 SKUs per hour (baseline: 28.9 source photos per minute steady on 29 Oct, before the GPU
upscaler).
**Acceptance test.** A load run in a separate capacity window (F7) reaches 2,000 SKUs per hour for 30 minutes with no
quota refusal and no 429 burst above the queue's retry budget.
**Buy or build.** Process (quota requests) plus shape changes.
**Human in the loop.** A project owner files the requests (Sujan or the GCP admin); the manager prepares the text.

### M6-F7 Separate load-test capacity (P1)

**Story.** As an operator, I never want a test to slow or break the live site (20 Oct outage, about 10 minutes, from a
load test on the shared database).
**Key requirements.** Load tests, fault injection and long evals never run on the shared stack while anyone uses it;
they run on the preview stack (`infra/deploy-preview.sh`) with its own database capacity (a temporary Cloud SQL
instance created and stopped by an idempotent `infra/` script, owner-approved for cost) or, failing that, in an
announced quiet window under the connection budget; the load driver refuses to start when a non-test batch is in
progress. Metric: outages caused by tests (baseline 1; target 0).
**Acceptance test.** Starting the load driver while a real batch runs is refused with a clear message; the same load on
the preview stack leaves live latency unchanged.
**Buy or build.** Process plus a small script.

### M6-F8 Tiered tests (P1, explicit ask)

**Story.** As Sujan, I want a typical change verified in under 15 minutes instead of hours, without losing the checks
that matter.

**Key requirements.** Five tiers, each with a time budget, and a rule for which tiers a change needs:

| Tier | What | When | Budget |
|---|---|---|---|
| T0 | Lint, typecheck, unit tests related to changed files (`vitest related`), on the builder's machine | every change, before a commit | under 3 minutes |
| T1 | CI: lint, typecheck, all unit tests in parallel shards balanced by file time (6 since S7a-1), the real-Postgres tests (S7a-3), infra and matting tests, intake browser scenarios (`.github/workflows/ci.yml` today) | every PR | under 10 minutes wall |
| T2 | Real-photo regression set in CI (about 30 real sources with stored mattes, `packages/core/test/regression/`, retrospective c2.1) | PRs touching render, matte, shadow, crop, QA | under 5 minutes, parallel with T1 |
| T3 | Preview-stack batch: a 20-product golden subset on the built images (spec 10 checkers) | PRs touching the pipeline, before deploy | under 15 minutes |
| T4 | Deploy gates and the per-brand smoke (exists) | every deploy, only for changed services (F2-R7) | under 30 minutes for web or worker |
| T5 | Full evals, the 300-product golden set (M7), load tests | nightly or before a release, on separate capacity (F7) | spend cap per run |

Path rules in one file (for example `docs/specs/test-tiers.json`) say which paths need T2 and T3; CI reads it to
skip what a change cannot affect, and always runs T1. A PR template line states the tiers run. Retire nothing without
naming what replaces it (retrospective c1.7). Metric: typical change verified in under 15 minutes (median PR from push
to green T1 and any needed T2), measured from CI run times.
**Acceptance test.** A copy-only web change is green in under 10 minutes; a render change runs T1 and T2 in under 15
minutes and T3 on preview in under 15 more.
**Buy or build.** Build (CI configuration and the regression set). Vitest sharding and `related` are already available
in the tool we use.
**Open question.** Current T1 wall time is not recorded in the evidence; the first slice measures it (default target
stays 10 minutes).

## 5. Operator experience

Operators see M6 only through calm screens:
- **During a deploy:** nothing. No banner, no pause. The batch page keeps updating.
- **Batch page and digest:** "Cost: USD 0.11 per product (true cost, matched to the Google bill on 4 Nov)" or, before
  reconciliation, "Cost so far: about USD 0.11 per product (estimate)".
- **If something stalls:** the batch recovers by itself; the operator sees "Taking longer than usual; it will carry on
  by itself" only after 10 minutes without progress, never a button they must press.

**Ops page (`/catalog/ops`, admins):** three cards.
- **Cost:** billed, attributed, idle and shared lines per day and component; true cost per product per batch and brand;
  the gap check (green within 10%); vendor invoice gaps.
- **Reliability:** 7 and 30-day batch success rate, incidents by kind and repeats, deploys with batches in flight and
  their result.
- **Capacity:** quota use per region against limits, throughput of the last batches, idle share of GPU seconds.

## 6. Measurement

| Metric | Baseline | Target | Data source |
|---|---|---|---|
| Gap between our cost and the bill | about 60x low (67x on load 5; ledger USD 0.0042 vs about USD 0.28 per product) | within 10% per day and month | `catalog_cost_days` vs billing export |
| True cost per product (GPU default) | estimated USD 0.08-0.15 | measured, then reduced by idle control | reconciliation |
| Batches failed by a deploy | batches kept away from deploys by people | 0 | `catalog_batch_outcomes.deploy_overlap` with `success` |
| Deploy duration, web or worker change | about 2.5 h for the 31 Oct full release | under 30 min | deploy report |
| Batch success rate (links ready, no person, no incident) | not tracked | 99% | `catalog_batch_outcomes` |
| Repeat incidents of the same kind | not tracked | falling month on month | `catalog_incidents.repeat_of` |
| Idle share of GPU seconds | about 60% | under 30% | reconciliation |
| Throughput | 28.9 source photos per minute steady (29 Oct, CPU upscaler) | 2,000 SKUs per hour | load run on separate capacity |
| Typical change verified | hours | under 15 min | CI run times |
| Outages caused by tests | 1 (20 Oct) | 0 | incidents |

## 7. Build slices

| # | Slice | Depends on | Acceptance test |
|---|---|---|---|
| M6-S1 | Ledger completeness: every attempt, worker wall time, job rows, labels on jobs, `deploy.sh` label refusal | none | F1 test 2 |
| M6-S2 | Reconciliation v1 from Cloud Monitoring, idle and shared lines, allocations, Ops cost card | M6-S1 | F1 test 3 (module map S5 first half) |
| M6-S3 | Reconciliation from the billing export (switch source, D+1 and D+3 runs, vendor invoices) | M6-S2; billing export enabled | F1 test 1 |
| M6-S4 | Deploy safety: migration lint in CI, task body versions, worker SIGTERM drain, ingest queue unlimited attempts and sweep re-send, overlap budget, login pre-flight | none | F2 tests 1, 2 and 4 on preview |
| M6-S5 | Shorter deploys: probe SKIP per changed service, parallel probes, smoke on live matting when unchanged, mid-batch shape rule | M6-S4 | F2 test 3 |
| M6-S6 | Batch outcomes, incidents (no stall or outage incidents: deferred to M1-S4b, S6-20), touch counter, ingest INFO lines, Ops reliability card | none (M1 digest reads it later) | F3 tests 1-2 |
| M6-S7 | P1: idle control, retry sweep, quota requests and shape raise, separate load capacity, tiered tests | S1-S6 as listed per feature | the P1 acceptance tests |

S1, S4 and S6 can start in parallel. S3 waits only for the billing export.

### 7.1 Database migrations (additive only)

One migration after M0's `0009` and M1's, for example `0011_cost_reliability.sql`, with the `lock_timeout` and
`IF NOT EXISTS` pattern of `0008_batch_indexes.sql`:

| Change | Kind | Notes |
|---|---|---|
| `ALTER TABLE catalog_cost_events ADD COLUMN component text`, `content_version_id uuid`, `billable_ms integer` | additive, nullable | old rows stay valid |
| Extend `COST_KINDS` with `job` and `wait`, `COST_OUTCOMES` with `timeout`, `killed`, `duplicate` | CHECK constraint replaced by a wider one | widening only: drop and re-add the CHECK with a superset in one transaction; old code never writes the new values |
| `CREATE TABLE catalog_cost_days` | new | day, component, region, env, source (billing, monitoring), billed_usd, credits_usd, attributed_usd, idle_usd, shared_usd, provisional, computed_at; unique `(day, component, env, source)` |
| `CREATE TABLE catalog_cost_allocations` | new | day, batch_id, component, attributed_usd, idle_usd, shared_usd; unique `(day, batch_id, component)` |
| `CREATE TABLE catalog_vendor_invoices` | new | vendor, month, amount_usd, entered_by, entered_at |
| `CREATE TABLE catalog_batch_outcomes` | new | primary key `batch_id`; fields in F3-R1 |
| `CREATE TABLE catalog_incidents` | new | fields in F3-R2; indexes on `(kind, started_at)`, `batch_id` |

Reused unchanged: `spend_days`, `catalog_batches.cost` (they stay for the live estimate and the cost line until the
reconciled number replaces the display), the invariants job, the sweep.

## 8. Risks and open questions

| Risk or question | Effect | Mitigation or default |
|---|---|---|
| Billing export delayed or not granted | Cost stays an estimate (about plus or minus 30%) | Monitoring reconciliation now (S2); S3 switches when the export lands |
| Export naming and columns differ from what we expect | S3 rework | Confirm against Google's documentation and the real table before S3 starts |
| Shared `ila-pg` cost split is a judgement | Per-product cost moves with the rule | Show it as its own line; admin setting |
| Cloud Run shutdown grace is short | Lost work on shift | Checkpoints and leases already recover; R3 makes it clean, acceptance test proves it |
| Quota requests refused or slow | 2,000 SKUs per hour not reached | Order asks by value; CPU matting overflow in asia-south1; bought cut-outs only as overflow |
| asia-south1 vCPU at 374 of 376 | Deploy refusals | 600 vCPU ask; lower CPU upscaler max now that GPU is default |
| Retiring the quiet-window rule too early | A deploy hurts a real batch | Retire only after acceptance test 1 passes on live with a real batch |
| Tiered tests skip a needed check | A defect reaches the live site | T1 always runs; path rules reviewed when a defect slips; the regression set grows with every finding |
| Open: CI wall time today | | Measure in the first slice |
| Open: smaller RTX shape | | Test in M6-F4 before raising the GPU max |

## 9. Integration decisions (2026-11-02)

| # | Decision | Why |
|---|---|---|
| D1 | Build order inside M6 (one writer per module): S4 deploy safety first (it protects every other slice's deploys), then S1, S6, S2, S5, S3 | Batches must survive deploys before many workers start deploying |
| D2 | M6 owns cost and incidents; vendor routes and their ranking belong to M7 (M12 writes them through M7) | M12 said M6 holds the service ranking; M7-F2 owns the route table |
| D3 | Open questions answered: `ila-pg` split by connection budget share; show INR as well; keep the human quiet window until one live deploy with a real batch passes F2 test 1; provisional links do not count against batch success; measure CI wall time in S4 | Technical defaults |
| D4 | Kept for the owner: filing the quota requests, confirming the OpenRouter paid key, the billing export, and approving a temporary Cloud SQL instance for load tests (`../owner-questions.md`) | Money and project-owner actions |
| D5 | (2026-11-05, R1 exit item 4) Idle instance time is given to batches by the minute, not by the day: each minute of billed instance time not explained by the ledger goes to the batches whose work ran from 15 minutes before to 5 minutes after it, by their busy ms; the digest, batch page and report.json show one figure per product with links: the whole cost ledger of the batch until the daily cost check adds idle and shared lines, marked not final until that check is final. Details in section 13 (C1 to C5) | The day rule charged a morning deploy probe's GPU time to the afternoon's batches (+36% on batch 216e5b7d), and the digest showed 17% of real spend |
| D6 | (2026-11-06, R1 exit findings 3 and 4) Traffic moves are recorded in `catalog_traffic_shifts`; `deploy_overlap` reads them for all six services, and the daily cost check keeps a deploy's no-traffic candidates off batches. Details in section 13 (C6 to C8) | `deploy_overlap` read false on two batches that had traffic moves around them, and forced deploys' probes added about USD 3.3 (+20%) to batch 84a5a30a |

## 10. M6-S6 build decisions (2026-11-04)

Technical gaps found while building M6-S6, decided by the builder (no business or money effect).

| # | Decision | Why |
|---|---|---|
| S6-1 | Migration `0020_batch_outcomes_incidents.sql` adds `catalog_batch_outcomes`, `catalog_incidents`, plus two small tables the requirements did not name: `catalog_batch_touches` (one row per touch) and `catalog_revisions` (one row per deployed worker or web revision). Renumbered to 0020 at merge, after the R1 slices 0013-0019 | Touches are written by the web before an outcome row exists, so an append-only log is simpler and race-free; `deploy_overlap` needs a record of when each revision first started |
| S6-2 | A touch is an operator write that means a person stepped in: a photo decision, Try again on a photo, a replacement photo, Try again on collecting, Try the failed links again, Fix and continue, Cancel, Add SKU ids. The wizard's own path (create, add inputs, Continue, review, Start) is not a touch. A test holds every operator write route to one of the two lists | F3-R3 says "every operator POST after upload"; counting Start or the review steps would make every batch a failure today |
| S6-3 | **Removed by S6-20 (stall part).** Incidents are found by the sweep every 10 minutes: a stall (no progress for 10 minutes, 30 while collecting; cause `enlarge_wait`, `ingest_stalled` or `no_progress`), a failed batch, a chunk that gave up, and each ERROR invariant per batch. Stalls and invariants stay open until a sweep finds them cleared (the resolution time); a failed batch or chunk is a one-off event written already resolved | One writer that reads state is simpler than instrumenting every failure path, and meets "within 5 minutes of detection" |
| S6-4 | Not written yet: 5xx bursts, deploy refusals, monitoring alerts and M0 contamination. Their kinds exist in the table; their writers come with M6-S5 (deploy) and M0, and alerts with M6-S2's daily job | They need a writer outside the worker (bash, Cloud Monitoring) |
| S6-5 | **Removed by S6-20 (stall part).** Progress for a stall = the latest of the batch row, its chunks (start, finish, photo progress) and its enlargements that settled. A queued enlargement retried by a busy upscaler is not progress | Otherwise an upscaler outage would never show as a stall (F3 acceptance test 1) |
| S6-6 | (Superseded by C6, 2026-11-06.) `deploy_overlap` is true when a worker or web revision first started between the batch's start and its end. GPU and matting services are not registered yet (M6-S5 can add them from `deploy.sh`) | The worker and web register themselves at start-up; no Cloud Run API call is needed |
| S6-7 | The outcome row is written at finalize and rewritten by every sweep for batches that ended in the last 24 hours (also failed and cancelled ones). `links_ready_at` keeps the first done time. A cancelled draft never handed on (an expired draft) gets no row | Late touches and incidents are counted; the 24-hour window bounds the work |
| S6-8 | The success target (99%) is a constant for now; the card marks a rate under it. The daily "under target" alert comes with M6-S2's daily reconciliation job | M12 admin settings do not exist yet; a daily job is the natural home for a daily alert |
| S6-9 | A batch extended by a follow-up: there is no follow-up link between batches in the data yet, so each batch has its own row and no parent column was added | Add the column when M1 adds follow-up batches |
| S6-10 | F3-R6: ingest deliveries already logged one INFO line per outcome (spec 14d F12); the chunk handler's early answers (stopped, already done, not found) and the ingest-more no-op now log one too | The 574f2025 gap was closed earlier; these were the remaining silent outcomes |
| S6-11 | **Removed by S6-20 (stall part).** Review P1-1: a parked chunk (queued, waiting on the enlarge lane) is not progress, because every failing enlarge delivery stamps it (refreshLaneProgress). A parked batch counts the latest settled enlargement of any running batch (the lane), so a batch queued behind a moving lane is not a stall, while an upscaler outage opens one. The stall still opens during an outage when M1-S4 adds its 6 h provisional deadline, as long as that deadline does not stamp chunk or batch progress | Reproduces F3 acceptance test 1 with the live lane behaviour (apps/worker reliability-stall.test.ts) |
| S6-12 | **Removed by S6-20 (stall part).** Review P2-2: finalize counts as progress (`finalizeEnqueuedAt`), and a live finalize claim (`finalizeClaimUntil` in the future) is never a stall | A long finalize of a large batch writes no chunk rows |
| S6-13 | Review P2-1: a batch that never started (no `startedAt`) is kept as a row but excluded from the rate; a cancelled one with no start and no ingest run gets no row | Only batches the system worked on can succeed or fail |
| S6-14 | Review P2-3: Continue on the ingest route is a touch only when it restarts a stalled collect (Try again); Back then Continue while collecting is not. Try the failed links again stays a touch: the operator is fixing links the system could not read | Matches S6-2: the wizard path is not a touch |
| S6-15 | Review P2-4 and P2-5: the Ops card lists recent batches (touches, incidents, a plain reason, test and not-counted marks). The admin JSON route sends `Cache-Control: no-store`; without `from`/`to` it serves the page's cached read, a custom window is read fresh and not kept | A custom window per request would push the page's reads out of the small cache |
| S6-16 | Noted, not changed: a touch is not idempotent (a double click counts twice; either way the batch is not a success), and a web revision that starts mid-batch marks `deploy_overlap` although the web does not run batches. The sweep rewrites only outcome rows whose batch, touches or incidents changed | Neither changes a success; the overlap is the safe direction |
| S6-17 | **Removed by S6-20 (stall part).** Review 2 P1-R: after Start, stall progress is work only: the batch start, chunk start and finish, unparked photo progress, an enlargement asked for (created) or settled, and finalize. The batch row's `updated_at` counts only while collecting (and for a row with no other signal at all). The progress counts write (refreshBatchProgress) keeps `updated_at`, as finalize.ts does, so a hung upscaler's counted failures no longer look like progress | A counted timeout refreshed the counts on every delivery and suppressed or flapped the stall (reliability-stall.test.ts drives it) |
| S6-18 | **Removed by S6-20 (stall part).** Review 2 P2-A: a parked batch borrows progress only from settled enlargements on its own lane (operator or bulk, isBulkBatch) and the same upscaler service (CPU `+cpu` ids or GPU) as one of its waiting rows | A GPU outage was hidden while CPU rows or the other lane moved |
| S6-19 | Review 2 P3: the release-overlap line leaves out excluded batches; a quick cancel after Start reads "cancelled right after Start, not counted" | Matches the rate |
| S6-20 | **Deferral (owner decision 2026-11-04, "Split it out").** M6-S6 ships without stall and outage incident detection: no `syncStalls`, no `stall` incident kind (removed from `catalog_incidents.kind`), and `refreshBatchProgress` writes `updated_at` as on main. The incidents it keeps: a failed batch, a chunk that gave up, an ERROR invariant. Stall and upscaler outage incidents move to the M1-S4b outage slice, driven by its single health ledger per upscaler service (`.runs/2026-11-04-outage-deadline-plan.md`). The stall part of F3 acceptance test 1 (an upscaler stopped for 20 minutes) moves with them | Review 3 found a P1: finalize re-sends (`finalizeEnqueuedAt`, re-sent by the sweep every 10 minutes) counted as progress, so a 90-minute outage opened no stall. Each round fixed one progress signal and found another; a health ledger answers "is the service down" directly instead of inferring it from batch rows |
| S6-21 | Built in M1-S4b (M1 decisions D13, D23): incident kind `upscaler_outage`, written only by the sweep's outage pass from the upscaler health ledger (`catalog_upscaler_health`): `service_down` (no batch, severity error) while a service has given no proof of health for 10 minutes, `enlarge_wait` (per batch, severity warning) while a batch's photos wait on that service, both resolved by the first sweep that finds the service answering or the batch no longer waiting, and `outage_deadline` (per batch, written already resolved) when the deadline delivers a batch's photos without enlargement. They count against the batch's success like any incident. F3 acceptance test 1's stall part (the upscaler stopped for 20 minutes) is covered by `enlarge_wait` (apps/worker outage-deadline.test.ts) | One signal answers "is the service down" for both the deadline and the incidents, so they always agree |

## 11. M6-S7a build decisions (2026-11-04)

Section 10 is M6-S6's (PR #159); this section is numbered 11 so the two merge in either order.

| # | Decision | Why |
|---|---|---|
| S7a-1 | T1 runs the unit tests in 6 shards, balanced by each file's measured seconds (`.github/ci/shards.mjs` with `.github/ci/test-timings.json`; refresh with `node .github/ci/timings.mjs <run-id>`), instead of 4 shards from vitest's `--shard` (an equal count of files per shard). Every file `vitest list --filesOnly` prints goes to exactly one shard, a new file included (it counts as the median) | On 2026-11-03/04 the shards took 3.0 to 7.7 min because the heaviest files landed together; the planner puts the slowest shard at about 6 min of tests at worst on the measured (busy-shard) seconds. The repository is public, so the two extra runners cost no Actions minutes |
| S7a-2 | `image-checks.test.ts` (59 tests, 6.5 min in one shard) is three files by describe group; the tests are unchanged | One file runs in one worker, so it was the floor of any shard plan |
| S7a-3 | M0 decision D11: a "real Postgres tests" job runs every test file that reads `TEST_PG_URL` against a `postgres:16` service (the ila-pg version); the unit shards run the same files on PGlite. The job fails when it finds no such file | Picks up the files M0-S2 and M10-S1a add without another ci.yml edit |
| S7a-4 | T2 (real-photo regression set) and T3 (preview batch) are named in `docs/specs/test-tiers.json` with their paths and marked not built. CI lists the tiers a PR needs in the run summary; the PR template asks which ran | T2 needs about 30 real brand photos and their mattes, which cannot live in this public repository, and CI has no GCP access to read them from a bucket: where they live and whether CI gets a read-only GCP identity is the owner's call. T3 deploys to preview, which waits for a typed approval per deploy. Until then a render PR names the unit tests it ran and T3 runs by hand |
| S7a-5 | T0 is `pnpm t0`: eslint on the changed files, the typecheck, and `vitest related --run` for the changed source files | The F8 T0 row; one command a builder runs before a commit |
| S7a-6 | The intake flake (scenario 5 "leave and return", the `/harness/queue` call after `page.reload()`) is left to PR #137 (`keepAliveTimeout: 0` in the test harness, root-caused there) | One file outside ci.yml; folding it in would duplicate a reviewed fix |

## 12. M6-S2 build decisions (2026-11-05)

Technical gaps found while building M6-S2 (reconciliation v1 from Cloud Monitoring), decided by the builder. No money or
business effect: every number is shown as an estimate, and the admin can change the two shared-line settings.

| # | Decision | Why |
|---|---|---|
| S2-1 | Migration `0023_cost_reconciliation.sql` adds `catalog_cost_days` and `catalog_cost_allocations` only. `catalog_vendor_invoices` waits for M6-S3 (vendor invoices are in its slice row). Columns beyond section 7.1: `kind` (service, job, shared, vendor), `billable_seconds`, `estimated`, `detail` (how a line was priced) on the day rows; `source` and `busy_ms` on allocations. `env` takes `unlabelled` as well | A person checking a day by hand needs the seconds and rates; the allocation keeps the busy seconds it was split by |
| S2-2 | Billed (monitoring) = `run.googleapis.com/container/billable_instance_time` per service or job and UTC day (one aligned point, `ALIGN_SUM`), times the list price of the resource's current shape read from the Cloud Run Admin API v2 (CPU, memory, GPU type, request-based when `cpuIdle` and no GPU). The rate card (`CPU_MEMORY_RATES`, `GPU_RATES` in `catalog/cost-reconcile.ts`) holds only rates checked against the billing export's effective rate for 2026-11-03; any other shape is billed 0 with an `unpriced` alert, never guessed | Monitoring time series carry no user labels for Cloud Run (checked live), so the labels and shape come from the Admin API; reading the shape live keeps a changed shape from mispricing silently (the ledger's own worker rate still assumes 2 vCPU) |
| S2-3 | Component and env come from the resource's `component` and `env` labels; a catalog resource (name `catalog-*` or `app=catalog`) without them is its own line with env `unlabelled` and an alert. Other apps in the project (competitor-pricing, gcc-asn-bot) are left out | `catalog-test-cleanup` and `catalog-test-real` have no labels today (2026-11-05); M6-S1's refusal covers new deploys only |
| S2-4 | Ledger rows written before M6-S1 (no `component`) are given one by the same rules as `costComponent` with the live services of that time (judge: OpenRouter, GPU cut-out: catalog-matting-gpu, CPU upscale: catalog-upscale, else catalog-worker) | A backfill of the last weeks would otherwise show every old row as an over-count |
| S2-5 | The shared Cloud SQL line uses two admin settings (`cost.database_usd_per_day`, default USD 3.96: the billing export's full day 2026-11-03 for ila-pg, vCPU + RAM + storage; `cost.database_catalog_share_percent`, default 26.5 = 104 of 393 connections, decision D3). The catalog's share is spread over the day's batches by their recorded cost. Storage, egress, Artifact Registry and Cloud Build lines wait for M6-S3 | Cloud Monitoring has no price signal for Cloud SQL, Artifact Registry or Cloud Build, and the buckets are shared with the earlier app with no per-prefix metric; the bill has them exactly |
| S2-6 | Vendors off the GCP bill (OpenRouter, an overflow adapter) are a `vendor` line billed as the ledger recorded them (the vendor's reported cost per call) until invoices arrive with M6-S3 | R7 |
| S2-7 | Each run re-computes the last 3 complete UTC days (D-1 and D-2 provisional, D-3 final) and replaces their rows in one transaction per day; `COST_RECONCILE_DAYS` (1 to 42) backfills, and setup runs 14 days once | The R8 shape works for monitoring too and catches ledger rows that land late; monitoring keeps six weeks |
| S2-8 | Alerts (R10 and decision S6-8): a ledger above the billed amount by more than 1% and USD 0.01, an unlabelled or unpriced resource, and the 7-day batch success rate under 99%. Each is written once as an `alert` incident keyed by check, day and component (shown under Reliability as "Daily check"); the sweep's `daily_check_alert` invariant carries it to email (policy 16) and `cost_reconcile_stale` (30 h without new rows) to policy 17 | Log-based alerts read Cloud Run services only, never jobs (jobs fail on purpose in tests), so the email goes through the sweep's invariant line like M0-S4's export freshness |
| S2-9 | Allocation: a component's idle is split over that day's batches by their busy seconds on it (`coalesce(billable_ms, ms)`), by recorded cost when no row has seconds; idle on a component no batch used that day stays "idle, no batch". `catalog_batch_outcomes.true_cost_usd` is the sum of a batch's allocations over every reconciled day | R5, R9 |
| S2-10 | Ops cost card: per day (billed, recorded by batches, idle, idle with no batch, shared, outside Google Cloud, total, the R10 check), per part over 30 days, preview, test and unlabelled reported apart, true and recorded-only cost per product per batch and per brand. Parts are named in plain words; no service, vendor or model name is shown. `GET /api/catalog/ops/cost?from&to` (UTC days) serves the same JSON to admins, no-store | Section 5 and the owner's rule that model ids never appear in UI copy |
| S2-11 | The job's service account gets `roles/monitoring.viewer` and `roles/run.viewer` on the project (read only), set by `infra/catalog-cost-reconcile.sh`; the job runs at 1 vCPU / 1 GiB, 06:00 UTC | AGENTS.md: grant at project level |
| S2-12 | Method check measured on 2026-11-03 (monitoring estimate against the billing export, by resource): catalog Cloud Run total USD 20.45 against USD 21.63 (-5.4%); live only USD 16.85 against USD 17.98 (-6.3%). The gap is request-based CPU start-up boost (catalog-matting -42%, catalog-upscale -17%: the bill's CPU seconds exceed instance time x vCPU) and the one-minute minimum of short jobs (catalog-recheck, catalog-migrate). GPU services -4% to -5%, the preview worker -0.3%. M6-S3 replaces the source with the bill | Records how far the estimate is from the bill before S3, inside the 10% of R10 overall |
| S2-13 | Review fix (PR #173): the ledger is priced against instance time. Within each component, in every stretch of time where the summed rate of overlapping ledger rows is above one instance's list price (the GPU upscaler serves 4 calls at once, each recorded at the full instance rate), each row is scaled down in proportion; rows priced at a part of an instance keep their cost while they fit in one. With several instances running this under-counts, which shows as idle, never as a false ledger_over alert. The ledger rows themselves are unchanged (M6-S1) | R10 compares the ledger with the bill; overlapping full-rate calls counted 4x instance time |
| S2-14 | Review fix: a ledger row covers [at - busy ms, at] and counts on each UTC day by the part that ran in it (rows ending up to a day after the day are read), as Monitoring splits instance time by the minute | Work crossing midnight UTC no longer raises a false ledger_over |
| S2-15 | Review fix: a run writes all its days, allocations and alerts in one transaction at the end, so the newest computed_at is always a finished run. A run that fails records a `run_failed` alert (once per UTC day, emailed through daily_check_alert) and exits non-zero. `cost_reconcile_stale` also fires when no run has ever finished while the cost ledger is older than 30 hours. True cost is also rewritten for batches whose allocations moved off a re-computed day | A part-way failure was silent |

## 13. R1 exit item 4 cost accuracy decisions (2026-11-05)

R1 exit item 4 ("cost per product within 10% of monitoring-derived spend") failed on the proof batch 216e5b7d (Vero
Moda, 141 products): monitoring-derived USD 0.0514 per product, ledger 0.0204 (-60%), digest 0.0088 (-83%)
(`.runs/2026-11-05-r1-exit-cost.md`). The ledger records call time only, while the GPU services bill every second an
instance is up (3.5x to 4x their call time), and the digest read `batch.cost` (judge and chunk compute only).

| # | Decision | Why |
|---|---|---|
| C1 | The reconciliation reads `billable_instance_time` per minute (alignment 60 s, the day's total unchanged). Per component and minute, idle = billed minus the ledger's work in that minute (after the S2-13 instance cap), never negative. A minute's idle goes to the batches with work on that component from 15 minutes before the minute to 5 minutes after it, in proportion to their busy ms; ledger work with no batch (sweeps, jobs) takes its share as "idle, no batch", and a minute with no work in that window is idle with no batch. The minutes are scaled to the day line's idle so the day still closes (R10). The window crosses midnight UTC: the ledger is read from 15 minutes before the day, so idle just after midnight goes to the work before it and idle just before the next midnight to work just after it. Work is kept per component as fixed arrays (one value per minute per batch), never per ledger row, so a day of 500,000 rows grows the heap by about 170 MB in 1.5 s (`cost-idle-minutes.test.ts`). A sample without minutes falls back to S2-9's day rule (`allocateIdle` in `catalog/cost-reconcile.ts`) | Cloud Run keeps an idle instance up to 15 minutes after its last request (10 for GPU services) and bills instance-based services for all of it (cloud.google.com/run/docs/about-instance-autoscaling); a GPU instance starts a minute or more before its first call is served. Replayed on 2026-11-05 13:00-17:00 (the live minutes and ledger rows, read only, committed as `catalog/fixtures/cost-replay-2026-11-05.json` and run through `reconcileDay` by `cost-replay.test.ts`): batch 216e5b7d gets USD 7.163 = 0.0508 per product, -1.1% against the monitoring-derived 0.0514. The day rule gives it 9.876 = 0.0700 (+36%), because the deploy probes' GPU time from 13:00 to 14:57 lands on the afternoon's two batches |
| C2 | No new instance-seconds meter in the worker or the GPU services | Cloud Monitoring already measures billable instance time per minute for every service and job, which is what the bill charges; a second meter would have to model scale-down and could drift from it |
| C3 | One cost figure on every operator surface: `batchCostFigure` (`catalog/cost-report.ts`) feeds the digest (stored at finalize, put in live by the digest tab and the digest API), the batch page cost line and the report.json download. Denominator: products with a published link (the R1 measure's and the Ops card's; a digest passes its own `productsWithLinks`, the same products, so the digest page reads no outputs). Basis `recorded` (the whole cost ledger, every row, failed attempts and every compute row; "Cost so far (not final) ... Idle machine time is added by the daily cost check", "per style so far") until the batch has an outcome row and the daily check has a day row for the day its idle tail ends (last ledger row + 15 minutes, not `ended_at`, so a failed batch the sweep touched days later still switches). Then the sum of its allocations (attributed + idle + shared): `provisional` while any of those days is provisional ("Cost (not final) ... and can still change for two days", "per style (not final)"), `true` once all are final ("Cost: ... This includes idle machine time and the shared database"). `batch.cost` (judge and chunk compute only) is kept for the wizard estimate, the live counters and evals, and no longer sent to the browser or the batch API | `batch.cost` left out the GPU calls (1.318 of 2.880 on 216e5b7d), the other compute rows and failed deliveries; three denominators and an early "true" label made the figure jump for reasons other than cost (review of PR #185) |
| C4 | No new column: the outcome's `true_cost_usd` stays the reconciliation's sum, and the recorded figure is read live from the ledger (indexed by batch). A `recorded_cost_usd` column was tried and dropped in review: nothing needed it stored | One source per figure; no migration |
| C5 | Comparing with the monitoring-derived figure, the shared Cloud SQL line is left out: monitoring cannot see it, and `true_cost_usd` includes it as its own line (about USD 1.05 a day split over the day's batches) | Like for like: R1 exit item 4 measures the instance-time method; R9's true cost adds the shared line on top |
| C6 | `deploy_overlap` is true when traffic moved on any of the six services (catalog-web, catalog-worker, catalog-matting, catalog-upscale, catalog-upscale-gpu, catalog-matting-gpu) after the batch's start and up to its end. The deploy gate records each move, forced deploys and `--rollback` included (`gate_record_shift`, `infra/lib/gate.sh`): one row in `catalog_traffic_shifts` with the time taken on the deploying machine when the shift returned, written by one `--async` execution of the job `catalog-traffic-shift`, which `deploy.sh` keeps on the commit's image after the migration. A shift that lands after the batch's outcome row marks that row too. A network error on the start is retried with the same time. A record that could not be started, or whose execution failed, warns and is listed in a loud block at the end of the deploy (failed deploys too) with its repair, and never fails a deploy (`gate_shift_report`). Cloud Audit Logs repair it, with the real time, on any commit and for a replaced revision or a hand move too: the end of each deploy (one `SHIFT_SYNC=1` execution of the job) and each daily cost check run `syncTrafficShifts`, which records every move after the seed that has no record within 10 minutes. A revision serving now that neither a record nor the audit log can date gets a window (`shifted_until`) from the service's last record to now, and a batch inside it reads `deploy_overlap` true: it may have overlapped, and a false would be a guess. A later audit entry replaces the window, though an outcome already marked stays true until something rewrites it. The job's service account gets `roles/logging.viewer` (deploy.sh, read only). If the audit log cannot be read, the deploy warns and the daily check raises `traffic_shift_missing`, and a replaced revision with a lost record reads false until it can be read. Printed and documented rollback lines go through `bash infra/deploy.sh --rollback`, since a bare `update-traffic` moves traffic with no record. No backfill: earlier rows keep their value until something rewrites them. `catalog_revisions` is still written but no longer read | The revision registry saw a revision when its first instance started (a candidate's probe), and only for web and worker, so a batch started between candidate and shift read false. The laptop cannot reach the private database, and a job needs no new route, IAM or API: the reader is one indexed query next to the outcome |
| C7 | The reconciliation reads `billable_instance_time` per revision (`resource.label.revision_name`) and adds it up per service, so a day's billed lines do not change. A revision's minutes before its first recorded shift, or all its minutes if it never shifted, stay on the day's bill and in the line's idle (R10 still closes; the Ops card shows them as idle, no batch) but go to no batch; the line's `detail` holds them as `noTrafficSeconds`. A revision that has served keeps counting after traffic moves on, since its idle tail follows its last work. Time counts as serving when nothing says otherwise: before the service's first record, for a sample with no revision, for a revision the Cloud Run list shows serving now (a shift whose record was lost), and for an unrecorded revision that did a batch's work (`findLostRecords`: it billed in a minute with ledger work on that service while no revision known to serve billed in that minute or next to it; a true candidate runs beside the serving revision and never matches). Those last two raise the alert `traffic_shift_missing` on the day. The daily check fills records from the audit log before it reads the days (see C6), so the fail-safe matters only when that read fails or lags; then a lost revision whose work all ends inside the old revision's idle tail is not detected, and the failed read's alert is what says so. On a preview day a candidate called by the preview worker could raise it falsely; the cost then errs towards the batch, never away from it | Candidate time is caused by the deploy, whichever batch happens to run next to it. Replay of 2026-11-06 through `reconcileDay` (the live per-revision minutes and 18,444 ledger rows, read only): batch 84a5a30a gets USD 15.46 against the monitoring-derived 15.54 (-0.6%), and 18.73 (+20.5%) when read per service. A lost shift record of a replaced revision would otherwise move its batches' idle to idle, no batch (review of PR #188: USD 1.275 to 0 in the test), which is why cost falls back rather than relying on the record alone |
| C8 | Migration `0028_traffic_shifts` seeds the shifts of 2026-11-05 14:29Z to 2026-11-06 05:48Z from Cloud Audit Logs (`ReplaceService`, revision at 100%), so the reconciliation of 2026-11-06 knows which revisions served. The seed changes no outcome row. Any deploy before this release's own deploy shifts traffic without a record, so this release ships first or together with the others | Without it the day's revisions have no history and the rule in C7 would not apply to batch 84a5a30a, whose reconciliation runs on 2026-11-07 |
