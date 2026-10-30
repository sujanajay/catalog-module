# When a done batch is finalized again (spec 18 H4)

## The contract
A finalize writes the links sheet, the report and the batch counts, then marks the batch done. After that:

- **A repeat is a no-op.** A repeated finalize task for a done batch answers `already_done` and writes nothing, so
  the numbers written after done (the load driver's independent re-check, `recheckOk`) are never overwritten on a
  repeat.
- **Counts are rewritten only on an explicit reopen.** One fresh sheet (`links-v<k+1>`) and fresh counts are
  written when, and only when, one of three things asks for it after done:
  1. an operator decision (a held product's "Use as is", "Remove this photo" or replacement publishes with a
     `trigger`);
  2. Add SKU ids (`apps/web/lib/catalog/sku-map.ts`);
  3. a late delivery that changed a product's content (`publishProduct` returns `changed`: not `unchanged`,
     not `failed`). Spec 18 "Try again" on a held photo goes this way: `retryEnlargement` queues the photo's failed
     enlargements again with a parked one-photo render chunk; when the enlargement is done the chunk is enqueued
     directly (the batch is not processing), renders, is judged and publishes with `changed`, which re-opens the
     batch.

## One representation of a request
A request is the stored `counts.finalizePending` flag, written by `enqueueFinalize`
(`packages/core/src/catalog/finalize-request.ts`). The task body is only `{batchId}`; finalize decides from the
flag, never from the body. Both the worker and the web's Add SKU ids route ask through `enqueueFinalize`, so both
get its dedupe (a pending request with a recent enqueue time queues nothing more) and its failed-batch guard. A
done batch takes a new request only with `reopen: true`.

## State rule
`finalizePending` stays true for the whole claimed run, from the claim until the done write sets it false. A
publish or sweep that runs meanwhile sees a request already on its way and queues no second finalize.

If a re-open's enqueue fails, the flag stays true and the earlier enqueue time is put back (absent or expired), so
the sweep's "done + pending + expired" clause sends it again. A non-reopen request whose enqueue fails is dropped
and its caller retries.

## A done batch that is not ready
- **A chunk of the batch is running** (a replacement photo, a Try again): the request stays pending and is re-queued
  with a 30 s delay. When every unfinished chunk is parked on an enlargement (a wait of hours, not seconds), the
  re-queue is every 10 minutes instead (`apps/worker/src/catalog/finalize.ts`), so a done batch waiting on an
  enlargement makes 6 finalize tasks an hour, not 120.
- **Only a product publish blocks**: the flag is cleared, a WARNING names the products, and nothing is re-queued.
  The publish that lands asks again.
- **A product a later batch published** (its `lastBatchId` is another batch and this batch holds no lock on it)
  does not block. It keeps its old links in the re-issued sheet, and a WARNING names it.
