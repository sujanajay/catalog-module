# Compare images - learnings

Written 2026-10-26 with the Compare images tab (`apps/web/lib/catalog/compare.ts`, `batchCompare` and
`productCompare`; UI in `apps/web/components/catalog/Compare*.tsx`).

## Staging copies are the per-batch history: never give them a delete rule
- The Compare tab shows, for any past batch, the output made in that batch from its `staging_uri`
  (`catalog/<brand>/<batch>/staging/...` in the private bucket). The public link is not history: it is
  overwritten in place by every later batch, and its old versions expire.
- Today nothing deletes staging copies (infra-bootstrap.md: GCS lifecycle rules cannot match a folder in
  the middle of a name). Keep it that way. A lifecycle rule or a sweep that removes `/staging/` objects
  would leave every older batch's comparison blank ("Could not be made" placeholders where images were).
  A future storage cleanup must keep staging copies, or the Compare tab must first learn to say "no
  longer kept" for a removed copy.
- Raw uploads (`raw_uri`) are the originals in the same view; the same rule applies to them, except the
  superseded-raw `daysSinceCustomTime` rule that already exists (a superseded original after 180 days).

## Which output a cell shows
- Each batch writes its own `catalog_source_images` rows (unique on product, n, sha256, batch), even for a
  photo it was given again; ingest sets `replaces_id` to the previous current row. An operator
  replacement inside one batch also adds a row with `replaces_id` pointing at a row of the same batch:
  the comparison hides the replaced row and shows the replacement.
- A re-run with identical photos makes no output row when a live output has the same render key
  (`apps/worker/src/catalog/chunk.ts`, matte stage). So the fallback cannot join on `source_image_id`:
  it matches product, channel, shot and the source's `sha256`, takes the newest `verified` output from
  another batch made before this batch finished, and labels it unchanged. A later batch's output is
  never shown on an earlier batch.

## Cost of signing
- On Cloud Run each signed URL is an IAM signBlob call. The batch page loads the comparison only for
  `?tab=compare` (choosing the tab opens that link), so the default batch page and its auto-refresh do
  not sign 25 x (channels + 1) links on every render.
