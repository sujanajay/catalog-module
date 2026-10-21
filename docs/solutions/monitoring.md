# Monitoring, alert emails and cost tracking - learnings

Built in session 7 (2026-10-22). Design: owner-approved plan of 2026-10-21; SPEC R16a holds the
attribution rule. Settings and code: `infra/monitoring.sh` and `infra/monitoring/*.json` (metrics,
policies, dashboard), the price block in `infra/deploy.sh`, `packages/core/src/log.ts` (log helper),
`packages/core/src/cost-events.ts` (ledger writes), `packages/core/src/catalog/cost-report.ts`
(attribution queries), the admin Ops page `/catalog/ops`. Operator view: section 16 of
`docs/handover/catalog-for-the-operator.md`. Runbook entry: "Monitoring and alert emails" in
`docs/handover/go-live-runbook.md`.

## Why no vendor
Everything is Google Cloud plus our own Postgres. No third-party SDK, script or account.
- No ready-made tool gives cost per batch, brand, channel or image. Google's billing export splits
  only by service, label and day, and Cloud Run labels are fixed per revision, not per batch. So
  that part has to be recorded by our own code (the ledger below).
- Structured logs, Error Reporting, log-based metrics, email alerts and dashboards are free from
  Google Cloud at this scale and can be made with gcloud scripts (the repo's infra/*.sh rule).
- Sentry and PostHog duplicate Error Reporting and need another login.
- Langfuse would duplicate our ledger. LangSmith has a small free tier and is aimed at LangChain
  users. Helicone is in maintenance mode (acquired March 2026).
- OpenTelemetry and Cloud Trace are left out: with batchId on every log line, Logs Explorer filtered
  by label tells a batch's story in order.
- Accepted gap: errors that happen only in the operator's browser are not captured.
- If judge replies ever need to be read: OpenRouter Broadcast to a Langfuse Hobby project is a
  30-minute zero-code option (set in the OpenRouter account, no code change). Not set up now.

## Log contract
Every line is one JSON object on stdout with `message` (never `event` or `msg`), `severity` and
`logging.googleapis.com/labels: { app: "catalog", batchId }`. ERROR lines with an Error carry
`stack_trace` and the Error Reporting `@type`, so Error Reporting groups them. Message texts are
kept as they were, so older filters still match. The alert filters match these exactly:

| message | severity | fields |
|---|---|---|
| `chunk failed` | ERROR when terminal (5th attempt), else WARNING | batchId, chunkId, stage, attempt, error |
| `batch failed` | ERROR (at the three places a batch is set failed) | batchId, reason |
| `batch swept: no progress for 2 hours` | WARNING | batchId |
| `catalog_qa: quality check unavailable` | WARNING | batchId |
| `matting_breaker` | WARNING when open, INFO otherwise | state, service (no batchId: the breaker is shared by the whole process) |
| `spend cap hit` | WARNING | batchId, reason "$X of $Y" |

Success lines at INFO: `batch started`, `chunk delivered`, `product published`, `batch finalized`.
The worker sends `x-catalog-batch` and `x-catalog-product` headers on each matting call, and the
Python matting service logs JSON with those ids.

## Metrics and the nine alert policies
Log-based metrics (on `cloud_run_revision`): `catalog/chunk_failed_terminal`,
`catalog/batch_failed`, `catalog/qa_unavailable`, `catalog/matting_breaker_open`,
`catalog/spend_cap_hit`.

All policies email the channel `catalog-email-tech` (sujan@opptra.com) and auto-close after 1 hour.

| # | policy | fires when |
|---|---|---|
| 1 | A chunk gave up | chunk_failed_terminal > 0 in 5 min |
| 2 | A batch failed or was swept | batch_failed > 0 in 5 min |
| 3 | Quality checks unavailable | qa_unavailable >= 10 in 10 min |
| 4 | Cut-out service breaker open | matting_breaker_open > 0 in 5 min |
| 5 | Spending limit paused quality checks | spend_cap_hit > 0 in 5 min |
| 6 | Worker errors | catalog-worker 5xx responses other than 503 > 5 a minute for 5 min |
| 7 | Queue stuck | Cloud Tasks queue `catalog` depth > 50 for 30 min |
| 8 | Database connections high | Cloud SQL `ila-pg` backends > 20 for 5 min (the limit is 25) |
| 9 | Error in the logs | any ERROR line from a catalog-* service in 5 min, except the messages policies 1 to 5 cover |

Policy 9 excludes the messages of policies 1 to 5 so one failure sends one email, not two. Policy 5
is a failure-type event (held products result), not a spending warning. 503 is left out of
policy 6 because the worker returns 503 on purpose to make Cloud Tasks retry (lost claim, retry).

`infra/monitoring.sh` is check-then-create: the second run prints SKIP for everything. It only
creates monitoring objects, never deletes. `deploy.sh` calls it at the end; the preview deploy
skips it.

## The ledger and the attribution rule
Table `catalog_cost_events`, one row per priced or timed event (matte call, render, upscale call,
judge or classifier call, publish, and one compute row per chunk delivery). It is additive: the
caps still read `spend_days` and `catalog_batches.cost`, and there is no backfill. Rows are written
inside the existing claim transactions, in a savepoint: if the insert fails it logs ERROR and the
batch carries on. A lost claim writes nothing.

Attribution rule (SPEC R16a), applied when reading, not stored:
- render, upscale and publish rows are direct per channel;
- matte, classify and judge rows belong to the source image and split evenly across that image's
  non-skipped outputs;
- the per-chunk worker compute row splits evenly across the chunk's non-skipped outputs;
- per-image cost = its direct rows plus its shares.

Render rows carry ms only (usd 0), because worker time is already priced once by the compute row.
Publish rows are ms only. Ledger total = qaUsd + computeUsd + the matting service USD.

## Prices
`PRICE_MATTE_CPU_USD_PER_SECOND` and `PRICE_MATTE_GPU_USD_PER_SECOND` price matte and upscale calls
by service seconds on the CPU or GPU service. They are env vars set in `infra/deploy.sh` next to
`COMPUTE_USD_PER_VCPU_SECOND`. The values were checked against cloud.google.com/run/pricing by the
ledger workstream; see the comment in `infra/deploy.sh` for the numbers and the date they were
checked. Re-check them there when Google changes its prices.

## Cloud Run labels
`deploy.sh` adds `app=catalog,component=worker|web|matte|matte-gpu` to every service and job, so
Google's billing page can show the catalog's share by component. Labels count from the next
revision only: billing before the first labelled deploy is not split. If the ledger's numbers ever
look wrong, the labelled billing page is the check.

## No spending warnings (owner decision, 2026-10-21)
No monthly budget alert, no "batch getting expensive" email or banner, no budget of any kind. Cost
is for seeing, not for alerting: the breakdown is on the Ops page and the batch page keeps its cost line. The existing daily cap
(`DAILY_SPEND_CAP_USD`) and per-batch cap stay as they are.

## Rollback
`gcloud run services update-traffic catalog-worker --to-revisions=<previous>=100
--region=asia-south1`, and the same for `catalog-web`. The ledger table can stay. Steps in the
runbook entry.
