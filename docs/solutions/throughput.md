# Throughput within today's quotas (spec 16)

Written 2026-10-27 while building spec 16 F1 and F2. Update it with the measured numbers after the 200-product
speed test.

## What limits a big batch

The GPU cut-out on 3 L4 (the quota in asia-southeast1; no quota forms, owner decision 2026-10-27) at about 3.4
photos a second once the GPUs do only cut-outs. Next in line are the AI checks (about 5 photos a second with 40
calls in flight). Everything else (worker CPU, database, publish, GCS) has more room.

## Levers and where they live

- Resident models and the lock: `services/matting/app.py` (`MAX_RESIDENT_SESSIONS`, `GPU_MEM_LIMIT_BYTES`,
  `LockedRun`). On 2026-10-20 model reloads were 71% of GPU time; 3 resident models remove them after warm-up.
- The upscaler off the GPU: the worker's `UPSCALE_URL` names the CPU cut-out service (deploy knob
  `UPSCALE_SERVICE=cpu`). The CPU service always serves `/upscale` (`UPSCALE_CPU=1`); the upscaler loads only when
  called. CPU-made images carry the upscaler id `<model>+cpu`, so their render_key ends in `:cpu`; `renderKeys`
  accepts the GPU and CPU keys of the same model, so switching services re-makes nothing by itself.
- Feeding the GPU: `MattingClient` rotates over several GPU services (`MATTING_GPU_URLS`), keeps at most
  `MATTE_INFLIGHT_PER_INSTANCE` calls in flight per GPU service, and waits 1 to 3 s after a 429 (every instance
  busy) instead of falling to the CPU service at once; the third 429 in a row counts one breaker failure.
- The shape: `infra/lib/shape.sh` holds every number with today's value as default and the refusals (connection
  budget, what ila-pg allows now, queue slots, the 190 of 200 vCPU line in asia-south1, the L4 quota and shape).
  `infra/tests/shape.test.mjs` runs it offline.
- The defaults (`SHAPE_DEFAULTS`) must equal the live production shape. On 2026-10-28 they still held the pre-F2
  shape, so a plain `bash infra/deploy.sh` cut catalog-bulk from 36 slots to 1 and catalog-ingest from 4 to 2 before
  its first gate. Now a shape change is a change to that table in the PR that deploys it, and a rollback of the
  shape is explicit env (the pre-F2 line in shape.sh), no longer a run with no env. Queue slots change only after
  the worker gate (`infra/lib/queues.sh`), so a deploy that stops at a gate leaves the live queues as they were.
- The database tier: `infra/sql-tier.sh`, check-then-change, `CONFIRM_RESTART=1` required. Default max_connections
  by tier (Cloud SQL flags doc, read 2026-10-27): db-f1-micro 25, db-g1-small 50, 3.75 to <6 GB 100, 6 to <7.5 GB
  200, 7.5 to <15 GB 400. deploy.sh reads the live tier (or a `max_connections` flag) and refuses a
  `DB_MAX_CONNECTIONS` above it.

- Photos at once and stage fairness (F3): `chunk.ts` works on `CATALOG_PHOTO_CONCURRENCY` photos of a product at
  once (`eachLimit` in `packages/core/src/concurrency.ts`); a bulk batch (`isBulkBatch` in `dispatch.ts`: 100+
  products or a Test Brand load batch) sends chunk and publish tasks to `catalog-bulk` and gets
  `CATALOG_BULK_WINDOW`; the AI checks are paced by `LLM_INFLIGHT_PER_INSTANCE` (`llm/limiter.ts`, halve on 429).
- The local scale test (F4): `apps/worker/src/catalog/scale.test.ts`. The model (`scale-model.ts`) gives 200
  products about 10 min, 2,000 about 54 min and 7,000 about 2 h 59 min at the F2 shape, limited by the GPU at about
  210 to 220 photos a minute. Run the real-handler part at full size with `SCALE_PRODUCTS=2000`.

## Gotchas

- In the GPU service, a request that already holds a session evicted by another request finishes with it, so for a
  moment one more session than `MAX_RESIDENT_SESSIONS` is alive. With `GPU_MEM_LIMIT_BYTES` at 6 GiB and 3 resident,
  that stays under the L4's 24 GB; if `session_ready` lines show memory errors, drop to 2 resident.
- Only 429 is "busy". A 503 from the matting service is a real fault and still counts at once.
- Cloud Run L4: at least 4 CPU and 16 GiB, 8 CPU and 32 GiB recommended; RTX PRO 6000 needs at least 20 CPU and
  80 GiB (Cloud Run GPU docs, read 2026-10-27).
- The cost ledger's `upscale_call` rows are priced by the upscaler id (`isCpuUpscalerId`): CPU rate and engine `cpu`
  for `<model>+cpu`, else the GPU rate.
- Photos at once (`CATALOG_PHOTO_CONCURRENCY`) need the bigger tier first: the worker pool doubles (shape.sh), and
  the budget check refuses it on db-f1-micro.
- A delivery's DB writes take turns (`serialLock` in `chunk.ts`); never call `underClaim` from inside another
  `underClaim` write, it would wait for itself. Never use `deps.db` inside an `underClaim` callback either: with a
  full pool that is a deadlock (PGlite in the scale test hangs on it, which is how you would notice).
- Cloud Run queues a request for up to 3.5 x the start time (or 10 s) before a 429 when every instance is busy, so
  with a GPU start of about 2 minutes a busy GPU service makes callers wait rather than fall back to the CPU.
- The PowerShell `bash` on this machine is WSL without a distribution; run the infra tests with `node`, which finds
  Git Bash through `packages/core/src/git-bash.ts`.
