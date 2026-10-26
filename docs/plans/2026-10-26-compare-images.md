# Compare images: inputs next to outputs, per channel, for every batch

Written 2026-10-26 for the `feat/compare-images` branch (worktree `..\catalog-module-wt	-compare-images`), from main d82cc36.
Approved plan, copied from the planning session.

## Checklist

- [x] 0. Sync main, create the branch and worktree
- [x] 1. Data function `batchCompare` in `apps/web/lib/catalog/compare.ts`, shared row and URL rules with `evalOutputs`
- [x] 2. "Compare images" tab on the batch page, with filters, paging and the large viewer
- [x] 3. Product page: originals beside live outputs, and the "Batches that touched this product" list
- [x] 4. Copy rules: no model ids, no em dashes, plain words
- [x] 5. Docs: SPEC section and the docs/solutions note on staging copies
- [x] Verification: unit tests, typecheck, lint, screenshots (component harness; no local DB run, see .runs/2026-10-26-compare-images.md)
- [ ] PR opened
- [ ] PR merged

## Context
Today the only way to judge a batch's work is to open links one by one (the Sheet tab has text links, the Details tab prints bucket folders). The dashboard shows an original next to its output in two places only: the "Needs attention" tab (problem photos only, one channel per photo) and the labelling list on test batches. The product page shows live outputs only, with no originals.

Goal: for any batch, past or future, see every input photo next to what was made for each channel, at a glance, without leaving the dashboard.

## First-principles findings (what makes this possible)
- **Every output already knows its input.** `catalog_outputs.source_image_id` points to `catalog_source_images`, and each output row carries `batch_id`, `channel` and `n` (shot position) ([schema.ts](packages/core/src/db/schema.ts) ~L365-460).
- **Each batch's files are kept on disk in that batch's own folder.** The input is `raw_uri` and the output made in that batch is `staging_uri`, both in the private bucket. Neither expires today (see docs/solutions/infra-bootstrap.md), so **all past batches can be shown, with no backfill job**.
- **The public link is not history.** `public_url` always shows the newest version (it is overwritten in place, and old versions expire in 30 days). Use it only as a fallback when `is_live` is true and there is no staging copy.
- **Unchanged shots** in a re-run get no new output row (`apps/worker/src/catalog/chunk.ts:146` skips them when the render key matches). In the comparison they should appear with the output from the earlier batch, labelled "Unchanged, made in an earlier batch".
- **Check results are already stored per output**: `status`, `flags`, `reason`, `qa_scores.verdict`, and `compliance.auto_actions` (repairs). The comparison can show a small pass, flag or repaired badge, with the reason text from the existing `flagDetails`.
- **Reusable code:** `evalOutputs` ([apps/web/lib/catalog/eval.ts](apps/web/lib/catalog/eval.ts)) already returns original, output, verdict and reasons with filters and 50-per-page paging. The `.ir` original/output layout and the `.ph` "Could not be made" placeholder live in [pages.css](apps/web/components/catalog/pages.css). `signedUrl` is in [storage.ts](packages/core/src/storage.ts) L211, and the native `<dialog>` modal pattern is in `ReplaceModal.tsx`.

## Plan
0. **Sync first.** Local main is 7 commits behind GitHub (cost ledger, Ops page, spend cap removal, #90-#99). Two of them touch the batch page and `DetailsTab`. Pull main, then create branch `feat/compare-images` in its own worktree.

1. **Data function `batchCompare(batchId, {page, channel, status, q})`** in `apps/web/lib/catalog/compare.ts`:
   - **Rows:** one row per (product, photo n), built from the batch's products and their source images for this batch.
   - **Columns:** one cell per batch channel. Each cell holds the output URL, the status badge, the reason, and an "unchanged" marker.
   - **Output choice for a cell:** this batch's output for that (source image, channel). If there is none, the same source image's output from an earlier batch, marked unchanged. Otherwise the "Could not be made" or "Skipped" state.
   - **URLs:**
     - the input is `signedUrl(rawUri)`;
     - the output is `signedUrl(stagingUri)`, falling back to `publicUrl` when the output is live;
     - signing uses a short TTL (about 1 hour), like `preview.ts` (900s).
   - **Filtering and paging happen in SQL**, not in memory, because production batches are much bigger than test sets. 25 photo rows per page.
   - **Shared with `evalOutputs`:** pull its row-shaping and URL-choice logic into this module so both use the same rules. Keep the eval list's look and behaviour the same.

2. **New "Compare images" tab** on [apps/web/app/catalog/[id]/page.tsx](apps/web/app/catalog/[id]/page.tsx) via `BatchTabs`, for every batch (live and test, past and new):
   - **Grid:** an Original column, then one column per channel (for example Original | Styli | Amazon). The product identifier and photo number sit at the left.
   - **Filters** in a GET form, using the same searchParams pattern as `EvalList`: channel, status (All / Passed / Needs attention / Failed / Repaired / Unchanged), and product search. Previous/Next links.
   - **Click any image** to open a large viewer (`<dialog>`) with the original and the chosen channel output side by side at full height. It has channel switch buttons, previous and next with arrow keys, the reason text, and "Open full size" links. The viewer is a client component; the grid stays server-rendered.
   - **Viewer role can see it.** It has no actions, so no `ActionOnly` is needed.

3. **Product page** ([apps/web/app/catalog/products/[brand]/[key]/page.tsx](apps/web/app/catalog/products/[brand]/[key]/page.tsx), [ProductImages.tsx](apps/web/components/catalog/ProductImages.tsx)):
   - **Originals:** extend `getProduct` to also load current source images (`is_current=true`), then show each photo's original beside its live outputs per channel, using the same grid component.
   - **History:** add a "Batches that touched this product" list (date, batch name, change type), each linking to `/catalog/<batchId>?tab=compare&q=<identifier>`.

4. **Copy and rules:** no model ids anywhere (the existing `no-model-names.test.ts` covers this), no em dashes, plain words.

5. **Docs:** add a short section to docs/SPEC.md describing the Compare tab. Add a note in docs/solutions/ explaining that staging copies are the durable per-batch history and must not get a delete lifecycle rule, since this view depends on them.

## Out of scope (suggest later)
- Showing the cut-out (matte) as a third column.
- Bulk download of a comparison sheet.

## Verification
- **Unit tests** (vitest, like `apps/web/test/catalog-*.test.ts`) for `batchCompare`:
  - output choice: this batch, then an earlier batch as unchanged, then could not be made;
  - each filter;
  - paging;
  - public-URL fallback;
  - a test that the eval list still returns the same shape.
- `npm test` and typecheck pass for web, core and worker.
- **Local run with `SKIP_IAP=1`** against a recent real batch and an old one:
  - the Compare tab shows originals and every channel;
  - filters and paging work;
  - the viewer opens, and arrow keys and channel switch work;
  - the product page shows originals, live outputs and the batch history links.
- **Screenshots of both pages** shared with you before shipping.
- **Ship** via the normal ship step (PR). You merge.
