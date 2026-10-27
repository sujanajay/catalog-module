# Chunk leases, steps and the dispatch window (spec 15)

## The problem it solved
Batch 09dd86f2 (2026-10-26) stalled for hours. A 25-photo chunk took longer than the 900 s Cloud Tasks
dispatch deadline. Cloud Run answered 504 but kept running the request. Cloud Tasks retried, and every
retry or recovery copy that arrived after a 960 s claim saw the chunk as abandoned and stole it. The old
holder's next write failed, so no delivery ever finished, and the queue filled with copies of the same chunks.

## How a delivery works now
- **Time budget.** A delivery starts no new photo after `CHUNK_TIME_BUDGET_MS` (480 s, which is also the cap;
  `CATALOG_CHUNK_TIME_BUDGET_MS` may only lower it). The slowest measured photo is about 400 s, so the worst case
  is about 880 s, inside the 900 s deadline. The budget applies only after the first photo, so every delivery
  makes progress. When the budget stops a stage, the chunk is **handed off**: status `queued`, `step + 1`, and
  one new task `chunk-<id>-<stage>-<step>` with `fromProduct`, so a stage resumes at the product where it stopped
  (QA triage runs once per product).
- **Lease and heartbeat.** A claim sets `lease_until = now + 120 s`. A heartbeat renews it every 30 s until the
  request deadline, then stops. A dead or cut-off holder loses the chunk within 120 s, not 960 s. Every write
  under the claim renews the lease with `UPDATE ... RETURNING`; a holder that finds another owner answers
  200 `lost` and drops its work (no retry; the new owner has it).
- **Step tokens.** `catalog_chunks.step` grows by one at every hand-off, advance and recovery. The task id and
  body carry `{chunkId, stage, step}`. A task whose stage or step does not match the row answers 200 `stale` and
  changes nothing. A same-step copy while the lease is live answers 503 `busy` (Cloud Tasks retries it
  later), and after 3 retries 200 `duplicate`. So at most one live task exists per chunk, and Cloud Tasks
  name dedup (24 h) makes a re-sent id a no-op.
- **Window.** At most `CATALOG_CHUNK_WINDOW` (8) chunks per batch are dispatched at once
  (`dispatched_at` set and not done). Start dispatches the first 8; each finished chunk dispatches the next under
  a batch row lock with `FOR UPDATE SKIP LOCKED`. A failed enqueue resets `dispatched_at`, so the sweep or the
  next finish picks it up. A small batch is no longer stuck behind a big one on the shared queue.
- **Stall rule.** Three deliveries in a row that finish no photo (errors and crashes count) fail the chunk with
  "Processing stopped: no photo finished in three tries in a row."

## The sweep (every 10 min)
`recoverBatchChunks` touches only dead chunks:
- running with a lapsed lease: back to queued, next step, one task (`reason: lease_lapsed`);
- queued and dispatched more than 30 min ago with no claim: next step, one task (`reason: task_lost`).
A waiting task or a live lease is never touched. The 2 h "no progress" batch failure is unchanged.

## Why there is no queue purge at rollout
Migration 0004 marks every existing row `step_known = false` with `dispatched_at` set. An old body
`{chunkId}` may claim only such a legacy row (or a row an old web inserted with `dispatched_at` null).
Once claimed, the row has a known step, and every other old copy answers 200 `stale`.
`leaseLapsed` ignores a `lease_until` that is not after `started_at`, so a claim made by old code keeps its
960 s rule and is never stolen early. The old copies drain by themselves as 200s, and purging the shared
queue would also drop live ingest and finalize tasks.

## Rollout order and mixed versions
The migration is additive and guarded (`DO $$ IF NOT EXISTS`, `SET LOCAL lock_timeout = '10s'`), so an old
worker keeps working on the new schema. If the web, worker or sweep is still old, a chunk it starts is
recovered by the new sweep within 10 to 30 min.

## Watch in the logs
- `chunk delivery` (INFO, one per delivery): `outcome`, `photos`, `ms`, `msPerStep`.
- `chunk recovered` (sweep), `chunk dispatch failed` (WARNING), `chunk failed` (ERROR, alert 1).
- Alert 10 "a chunk task ran out of time": any 504 on `/tasks/catalog/chunk` means the budget is wrong.
