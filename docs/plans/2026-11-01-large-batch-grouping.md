# Large links-sheet batches stall at "Collecting files" - root cause and proper fix

## Context

USPA links sheet (25,476 rows, ~6,639 distinct photo links) never reaches step 3 ("Check what we found").
PR #141 (8ba33d1, live on catalog-worker-00062-wuz since 2026-10-31 18:53Z) fixed the GCS 429 errors while
reading links, and that part now works: batch efb800ee read 25,272 rows in 4.5 min with zero 429s, and the
7bdee361 retry did the same. Both batches then stalled again at the very last step.

### What actually happens (evidence, 2026-10-31)
1. Last collecting delivery marks the upload `collected`, then `finishIfLast -> groupBatch`
   (packages/core/src/catalog/ingest/index.ts:518-551, 945-1089) runs grouping in the same request.
2. That request ran the full 1,800 s and was killed (504): 7bdee361 started 18:59:52, efb800ee 19:09:50.
   `place-state.json` was never written, so it died inside groupBatch before the plan was saved.
3. Worker CPU fell to ~1 % while waiting; Cloud SQL `ila-pg` (2 vCPU) went to 50 % (one batch) then
   99 % (two batches) and stayed at 99 % after both requests were killed. Postgres keeps running the
   queries and Node keeps running the loop after Cloud Run drops the request ("zombie" runs): autovacuum
   shows catalog_products / aliases / events / batch_products being written every minute.
4. "Try again" returns `noop: upload already collected` in 47 ms: the lease is still held by the zombie
   attempt, so nothing restarts and the UI shows "nothing has moved for more than 10 minutes".

### Root cause (first principles)
- **Database work per product scales with the whole SKU table.** groupBatch loops over every product one
  at a time (index.ts:981-1020). For each, `resolveSkus` (sku-mapping.ts) tries up to 4 queries; when the
  indexed option_key step misses, step 3 (jsonb_each_text + regexp over every brand row) and step 4 (two
  regexp_replace over every brand row) are full scans that no index can serve. P products x full regex scans
  = hours of DB CPU. Test batches (200 products) hit step 1, so this was never exercised.
- **A step whose cost grows with batch size runs inside one request with no budget.** Collecting and placing
  are chunked (200 items / 800 photos per delivery) but grouping is not, and it writes no progress and does
  not renew its lease until the end.
- **A killed run is not recoverable.** The lease stays held by a dead attempt, Try again no-ops, and the
  batch is never marked failed. #141 noted this but left it out of scope.
- Why #141 did not catch it: it fixed the first wall (429s) and verified with unit tests plus a small live
  batch; the full 25k-row batch was never run to step 3 before calling it fixed.

Code trace (Explore agent) confirms: ~20-25 sequential round trips per product (resolveSkus 2-5 queries,
findOrCreateProduct one transaction of ~8 statements plus ~11 alias inserts, one batch_products insert), and
resolveSkus runs twice per product (overwrite-preview.ts:82-87 and the loop). This sheet most likely gives
P ~2,200 products (6,639 links / 3); a per-size column would give P ~25,000. Estimated 4-18 min at 2.2k and
40 min-3.5 h at 25k, all inside one request. PLACING_LEASE_MS is 20 min but the stall banner shows at 10 min,
and Try again (apps/web/lib/catalog/uploads.ts ingestBatch) clears placingClaim and can start a second
groupBatch next to the zombie one, doubling DB load.

## Plan

One worktree + branch `fix/large-batch-grouping`, one PR. Each step has a test that fails on today's code.

### 0. Stop the zombie runs now (ops, needs owner OK)
The owner deleted batches 7bdee361 / efb800ee, but ila-pg was still at 98-99 % CPU at 19:52Z: the running
loops never re-check the batch. Roll the worker to a fresh revision of the same image (8ba33d1) so the old
instances shut down and their Postgres sessions end. Check: ila-pg CPU back under ~10 %. The owner starts a
new USPA batch after the fix ships.

### 1. Resolve SKUs in memory, once per batch (removes the full table scans)
- packages/core/src/catalog/sku-mapping.ts: add `loadSkuResolver(db, brandSlug)`. It reads the brand's
  sku_map rows once and builds Maps for option_key, ean, normalised channel ids (RESOLVE_CHANNEL_KEYS),
  stripped product code and full product code. It returns `resolve(input)` with the same 5-step order and
  the same result (first hit by opptra_sku, all SKUs of the option sorted). Reuse normalizeKey and
  stripSizeSegment so the JS side does exactly what the SQL regexps do.
- Keep `resolveSkus(db, input)` as a thin wrapper (load + resolve) for the single-product callers.
- groupBatch (ingest/index.ts:983) and buildOverwritePreview (overwrite-preview.ts:82-87) take the resolver,
  built once per groupBatch, so there are zero SKU queries per product.
- Test: an equivalence test that runs old SQL resolveSkus against the new resolver on a seeded sku_map
  covering all 5 steps (option key, ean, channel id, size-stripped code, manual, unresolved).

### 2. Make the product step chunked and resumable, like collecting and placing
- Split groupBatch into: (a) assemble + match + overwrite preview, saved to `group-state.json`;
  (b) a "products" phase that handles PRODUCT_BUDGET_ITEMS products per delivery (builder constant, sized
  so a delivery takes under about 3 min) and stops early on a time budget like INGEST_TIME_BUDGET_MS;
  (c) the existing shot list + placeBatch.
- Each products chunk writes progress (`phase: "grouping"`, done/total) and renews the lease through
  leaseWrites, then queues the next chunk with a named task (same pattern as placeTaskId / resumeAttempt),
  so a retried delivery never runs a chunk twice and nothing runs past the request deadline.
- Each chunk first checks that the batch still exists and is `ingesting` (the lease write does this too), so a
  deleted or cancelled batch stops within one chunk instead of running on in the background.
- removeDraftRows runs only on the first chunk of a run. The per-product writes stay idempotent
  (findOrCreateProduct + onConflictDoNothing), so a repeated chunk is safe.
- Test: with budget 2, a 7-product batch goes through 4 product deliveries and then placing; the lease is
  renewed each chunk; a duplicate delivery of a chunk is a no-op; cancel between chunks removes the rows.

### 3. A dead run is recoverable and visible
- Try again on a batch whose lease is still live and was renewed recently must not start a second
  groupBatch. It only takes over a lapsed lease (placingLeaseFree / placingLeaseResumable). With step 2,
  progress is written every chunk, so the 10-min stall banner only shows when work has truly stopped.
- When an ingest task runs out of attempts (the gap #141 left open), mark the batch failed with an operator
  sentence ("Collecting stopped part way. Press Try again.") instead of leaving only the stall banner.
- Tests in ingest.test.ts and apps/web catalog-wizard-routes tests.

### 4. Prove it at the real size before calling it fixed
- New scale test (core, local Postgres): a synthetic 25,476-row links sheet with 3 shared links per colour
  (about 2.2k products) and a sku_map the size of USPA's. groupBatch must finish with no delivery over the
  budget, and with zero sku_map queries per product (count queries through the test db).
- Second variant: per-size identifiers (about 25k products) must also finish in chunks.

### 5. Guards so this class of failure cannot come back silently
- Postgres `statement_timeout` (and `idle_in_transaction_session_timeout`) on the worker's db pool
  (packages/core/src/db/client.ts), sized well above the slowest legitimate query. A runaway query then
  errors and gets retried, instead of pinning ila-pg for hours after its request is gone.
- Monitoring policies in infra/monitoring/policies (same pattern as 11-silent-outputs / 12-slow-chunk):
  a worker request that hits the request timeout (504 on /tasks/catalog/*), and ila-pg CPU above 90 % for
  10 min. Applied with infra/monitoring.sh (idempotent).
- Audit (subagent, read-only first): every other batch-wide step (finalize, publish, exports, sweep,
  invariants, enlargement) for the same shape: work that grows with batch size, done in one request, with
  no budget or progress. Steps of that shape on the intake path get fixed in this PR; others are listed.
- docs/solutions/ entry (ce-compound): "every step that grows with batch size is chunked, budgeted and
  resumable; nothing does per-item queries that scan a table".

## How this runs (owner, 2026-11-01: "You have all permissions, approvals... Go ahead, merge, deploy")
- Manager only coordinates; subagents do the work, each in its own worktree, and each writes its report
  to .runs/2026-11-01-<slug>.md (copied from scratchpad if needed).
  1. Preflight (manager): gcloud token and ADC, gh auth, Playwright IAP state, disk space.
  2. Step 0 (manager): roll catalog-worker to a fresh revision of 8ba33d1; confirm ila-pg CPU drops.
  3. kit:worker A: steps 1-3 + 5 code (the fix) on fix/large-batch-grouping, tests that fail first.
     kit:worker B in parallel: the step 5 audit (read-only) and the step 4 scale test.
  4. Independent review: ce-code-review on the branch, by a subagent that gets the code, not my
     conclusions. Findings fixed by worker A.
  5. Ship: /ce-commit-push-pr (or /no-mistakes if the repo has that gate); kit:watcher on CI.
  6. Merge (owner approved), then the manager runs `bash infra/deploy.sh` at the merged sha (gate probes
     included); watcher on the deploy.
  7. Live proof: a fresh USPA batch from the same sheet reaches step 3 (verified in the browser and the
     logs, with ila-pg CPU watched). Only when the owner is not running other heavy work.
- After two failed attempts at any step: stop and report instead of trying random fixes.

### Out of scope (list as leftovers, not fixed here)
- matchProductList token rule is quadratic with a separate product list (product-list.ts:159).
- Possible per-size alias clash ("same product" refusal) when sizes are the grouping key; check it on the
  real USPA result first.
- catalog_source_images.sha256 has no index (seconds, not minutes).
- MaxListenersExceededWarning on PassThrough during collecting (warning only).

## Verification
1. `pnpm -r test`, lint and typecheck green; the new tests fail on origin/main and pass on the branch.
2. Scale test numbers in the PR body (per-delivery max time, total time, SKU queries per product).
3. After merge and deploy (owner approves the sha, and only while the owner is not running other work):
   the owner starts a fresh batch from the same USPA sheet. Watch the worker logs: product chunks with rising done/total, no 504s, and
   ila-pg CPU staying well below 100 %. Done means the batch reaches step 3 "Check what we found" with a
   grouping table, shown in the browser.

## Checklist (branch fix/large-batch-grouping)
- [x] 1. In-memory SKU resolver (loadSkuResolver), equivalence test against the old per-query resolveSkus
- [x] 2. Grouping in budgeted, resumable chunks (group-state.json, group-products-<n>.json, named tasks, progress and lease every 10 s, cancel stops a chunk)
- [x] 2. New intake phase `grouping` ("Sorting photos into products <n> of <total>")
- [x] 3. Try again clears only a lease nobody renewed for 10 minutes
- [x] 3. Ingest task out of attempts marks the batch failed with an operator sentence
- [x] 4. Scale test: 25,476-row sheet per colour (2,213 products, in CI) and per size (25,476 products, CATALOG_SCALE_FULL=1)
- [x] 5. Worker statement_timeout 5 min and idle_in_transaction_session_timeout 10 min
- [x] 5. Alert policies: worker task 504 (with log metric task_timeout), ila-pg CPU above 90 % for 10 min
- [x] Scope extension (audit 2026-11-01): migration 0008 indexes (photos by batch_id and sha256, chunks by status and task_name)
- [x] Scope extension: matchProductList token rule by segment index; step 4 poll (plannedImages lookup, one policy read per type, manifests read once per poll, IN lists chunked); step 2 example grouping linear
- [ ] Independent review, PR, CI (manager)
- [ ] Merge, deploy, apply monitoring (manager, owner approved)
- [ ] Live proof: a fresh USPA batch reaches step 3 (manager)
