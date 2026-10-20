# Database connection budget - learnings

Incident 2026-10-20. Settings: the budget block in `infra/deploy.sh`, `packages/core/src/db/budget.ts`,
the retrying pool in `packages/core/src/db/client.ts`, the preflight in `apps/worker/src/catalog-load.ts`.

## What happened (times UTC)
- 04:01 the spec 09 load test started (Cloud Run job `catalog-load`, 270 options). Its batch
  `1b83ac80-4751-4c75-92c6-2f93d405c8b2` had about 5,000 images to process through Cloud Tasks.
- The Tasks queue dispatched up to 20 tasks at once, so `catalog-worker` scaled to its maximum of
  10 instances, each with a pool of 2 connections (20), next to `catalog-web` (up to 3 x 3 = 9), the
  job's own pool (2) and the earlier `ila-web` and `ila-worker` apps on the same instance.
- 04:15 the load job execution died; the worker kept processing its batch.
- From 04:16 Postgres answered "remaining connection slots are reserved for roles with privileges of
  the pg_use_reserved_connections role" (SQLSTATE 53300). Every `/catalog/<id>` page failed, upload
  APIs returned 500, worker task handlers failed reading `catalog_chunks`, and Cloud Tasks got 429
  "no available instance".
- 04:23 mitigation: `gcloud run services update catalog-worker --region asia-south1 --max-instances=3`.
  Last database error 04:23:54; batch pages answered 200 again from 04:27. The batch kept running.

## Root cause
Nobody had added up the connections. `ila-pg` is a shared db-f1-micro with no `max_connections`
flag, so Postgres allows 25 connections, 3 of them reserved for superusers. The catalog alone could
open 10 x 2 + 3 x 3 + 2 x 2 = 33 at its worst case, more than the instance has.

## The arithmetic
| Item | Connections |
| --- | --- |
| max_connections (db-f1-micro default) | 25 |
| superuser_reserved_connections | -3 |
| ila-web and ila-worker (assumed when idle; not ours to cap) | -4 |
| Left for the catalog | 18 |
| catalog-worker: 4 instances x pool 2 (concurrency 2) | 8 |
| catalog-web: 3 instances x pool 2 | 6 |
| Jobs: at most 2 at a time x pool 1 (load, recheck, QA check, evals, migrate, smoke) | 2 |
| Catalog worst case | 16 (headroom 2) |

The Tasks queue's `max-concurrent-dispatches` equals worker instances x concurrency (8), so a large
batch waits in the queue instead of piling 429s onto a full worker and burning retry attempts.
`infra/deploy.sh` refuses to deploy a shape that does not fit and passes it to the worker and the
jobs as `DB_CONNECTION_BUDGET`. The load driver refuses to start when that budget does not fit, when
it is missing, or when any batch is still mid-pipeline.

A burst that still hits the limit (for example the ila apps using more than their assumed 4) now
degrades instead of crashing: the pool retries "too many connections" up to 5 times with a backoff
of about 3 seconds in all, then fails as before.

## Operator rules
- Load tests never run alongside gate runs, acceptance runs or another load. Wait until no batch is
  processing (the driver checks this too).
- Do not raise worker or web max instances or any `DB_POOL_MAX` without redoing the table above.
- To raise the budget: change the Cloud SQL tier (for example db-g1-small allows 50) or set the
  `max_connections` flag on `ila-pg`. Both restart the database and the instance is shared with the
  ila apps, so do it only in an agreed maintenance window, with the owner's approval. Then update
  `DB_MAX_CONNECTIONS` in `infra/deploy.sh` and redeploy.
- If it happens again: lower the worker's max instances first
  (`gcloud run services update catalog-worker --region asia-south1 --max-instances=3` with
  `CLOUDSDK_CORE_PROJECT=image-links-agent`); the next `infra/deploy.sh` restores the budgeted values.
