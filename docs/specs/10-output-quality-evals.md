# 10 Output-quality evals

Catalog module, spec 10. Execute with `docs/specs/00-execution-protocol.md`. Source of truth:
`docs/SPEC.md` (the channel table, the image policy, the shadow decision rule, the publish and
overwrite contract). Depends on 05 (render, compliance, matting client), 06 (pipeline handlers,
sheet, re-check), 07 (judge, attention, decisions), 08 (eval manifest helpers, policy writer).
Branch `feat/output-quality-evals`. Deploys the Cloud Run job `catalog-output-evals`.

## 1. Goal

The product will make more than 100,000 marketplace images. A defective image that reaches a
marketplace is the worst outcome; a product that "needs attention" is a failure of ours, not an
acceptable state. This spec defines an evaluation suite whose bar is "a senior marketplace content
reviewer would accept every image without comment", measured by code on a fixed golden set, run
repeatably against the real pipeline, with a report that shows every failing image and the number
that failed it. It also decides, per product type, which cut-out model the pipeline uses: every
deployed matting model is scored on the golden categories with the same cut-out bars and the
winner goes to `model_policy` through spec 08's policy writer.

Plain-language terms. Golden set: a fixed list of real photos, pinned by their sha256, that every
run measures. Check: one measurement with a stated bar; it passes, fails or is "not run" when its
inputs do not apply. Attention rate: products with an undecided held or failed output at the end of
a batch, divided by products in the batch. False-hold rate: holds a person would resolve with "Use as
is" divided by all holds (in the suite, a hold whose output passes every deterministic check).

## 2. Scope

In scope: `packages/core/src/catalog/evals/**` (checkers, golden manifest, report, matte bake-off),
`apps/worker/src/catalog-output-evals.ts` (the job and the local modes), `infra/catalog-output-evals.sh`,
the deploy step, the golden manifest under `packages/core/test-fixtures/catalog/evals/`.

Out of scope: changing the render, the compliance check, the channel table or the classifier. The
suite tests them from the outside; findings go to the render owner as failing checks with numbers.

## 3. Files

- `packages/core/src/catalog/evals/types.ts` `CheckResult`, `OutputSubject`, `Expectation`.
- `image.ts` raster helpers (delta, dilate, erode, components, distance, specks).
- `context.ts` the per-output context: decoded canvas, projected alpha, boxes, cut sides.
- `geometry.ts`, `shadow.ts`, `cutout.ts`, `cut-edge.ts` the image checkers (sections 4 to 7).
- `completeness.ts`, `attention.ts`, `overwrite.ts` the row checkers (sections 8 to 10).
- `golden.ts` manifest build, derived and planted cases, sha256 pinning (section 11).
- `matte-bakeoff.ts` model scoring, ranking, policy rows (section 12).
- `report.ts` JSON report, HTML contact sheet, the summary line.
- `sheet-notes.ts` reads the `notes` column of a links workbook.
- `synthetic.ts` synthetic products through the real `renderSource` for the checker tests.
- `apps/worker/src/catalog-output-evals.ts` commands `build-golden`, `upload`, `run`, `check-folder`.
- `infra/catalog-output-evals.sh` `deploy | upload | run [--live] [flags]`; `infra/deploy.sh` deploys the job.
- `packages/core/test-fixtures/catalog/evals/golden-build.json` (how the set is drawn) and
  `golden-manifest.json` (the pinned set).

## 4. Image checks: geometry (`geometry.*`)

Measured on the staged JPEG of every made output, against the channel table. The expected product
mask is the pipeline's own matte projected onto the canvas exactly as the render projects it (cut
to the bbox, lanczos3 to the recorded placement), so the suite knows where the product should be.

| Check | Measured | Bar |
|---|---|---|
| `format` | magic bytes, format, chroma subsampling, colour space, ICC, alpha, bytes, DPI | `FF D8 FF`, jpeg, 4:4:4, srgb, profile present, no alpha, <= 2,000,000 bytes, density equals the channel DPI |
| `canvas` | width x height | fixed channels exact; adaptive channels between minimum and target, target aspect within 1 px, even pixels, equal to the recorded placement |
| `edges` | every pixel of all four edges | background within 8 per channel (JPEG error on a flat colour is under 4), except product pixels touching a zero-margin side; lone ringing pixels (regions under 4 px) ignored |
| `border_band` | every pixel of the 2% border band | same rule as `edges` |
| `outside_product` | non-background pixels (delta > 12) farther than 4 px from the product mask, in regions of at least 12 px, shadow-like darkening excluded where a shadow is allowed | 0 |
| `inside_safe_box` | pixels in the required margins (delta > 24, or > 12 beyond the ring), regions of at least 12 px | 0 |
| `extent` | measured product extent (delta > 24 inside the mask ring, contact shadow excluded) against the planned mask extent | each side within 4 px |
| `margins` | planned product box against the channel margins | every required margin kept within 1 px |
| `centred` | horizontal centre of the measured extent | within 4 px of the canvas centre (unless the product spans the safe box) |
| `anchor` | vertical centre (centre channels) or lowest product row (Styli: canvas height minus 450) | within 4 px |
| `noon_wide` | narrower side margin of a wide Noon shot | at least 5% of the width |
| `pixels_copied` | product pixels (alpha 250+) against the source resampled to the product box | mean per-channel difference <= 8 and at most 1% of pixels differ by more than 48 |
| `uniform_scale` | Styli scale spread across a product's non-detail angles | <= 0.5% |

## 5. Image checks: shadow (`shadow.*`)

A shadow is any canvas pixel outside the product (and its 3 px ring) darker than the background by
more than 8 luma, in regions of at least 12 px (ringing specks are not shadow). The spec 05 band is
the product box extended 10% of its height above its bottom, 25% below and 10% of its width each side.

| Check | Applies to | Bar |
|---|---|---|
| `forbidden` | apparel on a model, flat lays (the owner's bar: a model photo gets no shadow at all) | 0 pixels darker than the background by more than 12 in regions of 24 px or more, and mean darkening of the band under the product <= 1.5 luma |
| `footprint` | shadow-allowed types | every shadow pixel inside the band |
| `darkness` | shadow-allowed types | darkest shadow pixel <= 65% of the background luma (spec 05 clamp 0.6 plus JPEG) |
| `hard_edge_horizontal`, `hard_edge_vertical` | shadow-allowed types | no run of adjacent-row (or column) steps larger than 16 luma longer than 5% of the product width (or height), never longer than 6 px below that |
| `monotone` | shadow-allowed types | mean darkness per distance from the silhouette never rises by more than 2 luma per pixel nor by more than 4 in total, measured 5 to 48 px out |
| `synthesised_on_model` | per output | no apparel-on-model output carries `shadow_synthesised` |

Pinned finding (unit test `image-checks.test.ts`): the current render cuts a synthesised shadow off
hard where the 2% border band or the Styli guide ends, so a product that fills a zero-margin canvas
or sits on the Styli guide shows a straight line. The suite reports it; the render should fade the
shadow out before the band instead.

## 6. Image checks: cut-out integrity (`cutout.*`)

The matte is compared with an independent estimate of the product taken from the source's own
colours: pixels farther than 30 per channel from the source's border colour, minus the source's
own cast shadow (grey darkening no darker than 55% of the background luma anywhere; in the lower
40% of the silhouette any unmatted darkening up to chroma 72, where a contact shadow is dark and
picks up colour from the sole), minus specks under 0.02% of the frame. Only sources with a uniform
border run these; others are "not run" and listed.

| Check | Measured | Bar |
|---|---|---|
| `pixels_lost` | share of estimated product pixels the matte drops, per cell of a 6x6 grid over the product (cells with 200+ pixels) and overall | worst cell <= 1%, overall <= 0.3% |
| `thin_parts` | share of thin pixels lost (what a radius-2 opening removes: straps, laces, hair, heels), when at least 100 exist | <= 10% |
| `background_kept` | matte pixels (alpha > 10) that are source-background coloured, outside the colour estimate dilated 2 px and outside the silhouette's span | <= 0.5% of the matte |
| `holes` | connected interior regions (estimate eroded 3 px) the matte drops, each >= 0.05% of the product | 0 |
| `see_through` | share of the interior with alpha under 200 | <= 0.2% |
| `edge_softness` | soft alpha pixels (10 to 245) per pixel of silhouette length | <= 3 px |
| `halo` | share of the 3 px ring around the product on the canvas that is not canvas background (shadow band excluded where a shadow is allowed) | <= 2% |
| `fringe` | share of soft-edge pixels (alpha 10 to 200) carrying the source background colour, when the source and canvas backgrounds differ by more than 20 | <= 1% |

White-on-white and dark-on-dark products carry little colour evidence; for them `pixels_lost` is
weaker and the model bake-off (section 12) adds the other models' majority as a second reference.

## 7. Image checks: cut sources (`cut_edge.*`)

A source is cut on a side when at least 2% of that edge's pixels carry product (matte alpha > 10).

| Check | Bar |
|---|---|
| `flush_<side>` | the measured product (clearly foreground pixels inside the mask) ends within 1 px of the canvas edge on a zero-margin side, or within 1 px of the guide on a margin side |
| `no_line_<side>` | nothing beyond the cut side is drawn (regions of 12 px or more, delta > 12), and at most 1% of the silhouette's last 12 rows or columns before the cut are background (no gap, no floating line) |
| `flagged` | the output carries the information flag for a cut source (`cut_source`; `source_cut` and `cut_at_edge` are accepted until the render fix lands) |
| `not_held` | status is not `needs_attention` or `failed` |

## 8. Completeness (`completeness.*`)

For every golden source and ticked channel: exactly one output row (`one_output`); verified, live,
with generation, bytes and crc32c (`live`); the public object exists with the recorded size,
generation and `image/jpeg` (`public_object`); the staged file exists with the same size
(`staged_file`); the sheet cell carries the live link (`sheet_cell`). A skip is allowed only for Styli
when the source height is under `STYLI_MIN_SOURCE_HEIGHT_PX` (1482), with the exact note "Skipped
for Styli: the photo is smaller than Styli needs." and the note in the row's `notes` (`skip_allowed`).
No stray rows or cells (`no_extra_outputs`, `no_extra_cells`). Counts: planned equals sources x
channels (`counts_planned`), verified equals planned minus skipped (`counts_verified`), and "Links
verified" equals "Independent re-check" equals the links in the sheet (`recheck_equals_verified`).

Amazon and Shein: the spec makes one output per shot on every channel; only the canvas colour
differs (image 1 pure white, the rest light grey). Three inputs give three Amazon images and three
Shein images. The suite asserts this per shot (`amazon_shot`, `shein_shot`), so a product with
three photos and one Amazon link is a failure with the missing shot named.

## 9. Attention and judge behaviour (`attention.*`)

| Check | Bar |
|---|---|
| `not_held` | a product the manifest does not expect to need attention goes straight to the sheet |
| `expected` | a product the manifest expects to hold (for example a 450 px source) is held with exactly the expected flags; judge-detected expectations are asserted only on a live run |
| `planted_caught`, `planted_rate` | every planted wrong item (a photo of another product, ideally another brand, appended as the last shot) is held as `different_product` on that shot only; 100% caught (live run) |
| `judge_false_positive` | the judge never flags an output every deterministic check passed (live run) |
| `judge_false_same_product` | a sole, back, inside, detail or on-model view of a golden product is never called a different product (live run) |
| `channel_consistent`, `channel_consistency` | a photo-level flag and its hold are the same on every channel of that photo (channel-specific flags: `placement`, `failed_compliance`, `low_resolution`, `passthrough`) |
| `placement_not_judged` | a `placement` flag exists only with a failed `styli_anchor` compliance check (code decides placement, never the model) |
| `product_type_set` | no product leaves the batch with type `auto` or null |
| `false_hold_rate` | holds whose output passes every deterministic check: 0 |

The report carries one row per flag raised, held or not: product, photo, channel, flag, dimension,
score, threshold, model (JSON only, never in operator copy), evidence sentence, automatic action,
final status, human label (decision). The summary carries the attention rate (target 0), the
false-hold rate (target 0) and the planted-caught count.

## 10. Overwrite contract (`overwrite.*`)

On the first golden group with a product of three shots: an identical re-upload keeps every
generation, costs no matte, render or copy, and marks every product `unchanged`
(`identical_generations`, `identical_zero_work`, `identical_change`). A delivery with one photo
altered by one pixel and one shot dropped, with Amazon unselected: every remaining link keeps its
address (`same_links`), only the altered shot gets a new generation and only on the selected channels
(`altered_new_generation`, `untouched_unchanged`), the dropped shot is not live and its link returns
404 after the cache window (`removed_not_live`, `removed_gone`), Amazon is listed as not refreshed
(`not_refreshed_listed`), the report lists the removed links (`removed_links_reported`), `change` is
`shots_removed` and `updated` and `unchanged` as expected, the `overwritten` and `shots_removed`
events exist, and the new sheet's independent re-check is complete (`recheck`).

## 11. Golden set

`golden-build.json` says how the set is drawn; `build-golden` pins it into `golden-manifest.json`
(sha256, bytes, size, brand, category, tags, expectation per photo); `upload` copies the pinned
photos under `catalog-test/evals/golden/sources/<brand>/<identifier>_<n>.<ext>` with the manifest.
The owner's folders are read only. Sources, seed 10:

- `var/qa-gate-input`: all 8 Anta footwear products (5 shots each) and 4 French Connection model
  products (3 shots each), the set the defects were found on.
- Anta `new_resources_4/Images` (800x800, pure white): 8 sampled products.
- Penti `drive-input/set1` (800x1200, white flat lays and tight model crops cut at the frame):
  14 sampled products plus the product with a shot-number gap; flat lays become `apparel_flat` by
  the `wide_product` rule on shot 1.
- Vero Moda `drive-input/set2` (800x1096, light-grey studio background, full-length models):
  14 sampled products plus the tights (transparent, thin), two single-shot products, three bags
  (`bag_accessory`, thin straps, reflective) and the two byte-identical products.
- French Connection `drive-input/set3` (800x1200, white cut-out backgrounds): 18 sampled products
  plus the `.webp`, the single-shot product, two products with shot gaps, the two products sharing a
  byte-identical shot, the text banner (`other`, expected `text_or_watermark` by the judge), a wallet
  (`bag_accessory`, reflective) and a gift set (`other`).
- Derived: a 450 px copy of an Anta and a French Connection photo (expected `small_source`, held),
  two model photos cut at 85% height (`cut_edge`, must not be held).
- Planted: a French Connection photo under an Anta product, an Anta photo under a French
  Connection product, a Vero Moda photo under a Penti product (expected `different_product`, live
  run).

Result: 90 products, 399 photos; tags from the bytes (`white_on_white`, `dark_product`,
`grey_background`, `wide_product`, `cut_edge`, `px500`, `many_shots`) and from the overrides
(`thin_straps`, `transparent`, `reflective`, `text_or_watermark`, `hardline`, `mixed_set`). The full
inventory (4,680 files) stays the pool for a full-scale run: raise `sampleProducts` in the build file.

## 12. Cut-out model bake-off

The owner's decision: the evals are the final call on which cut-out model is used, per product type
and situation; mixing models across types is fine and `bria-rmbg` is permitted. The `run` command
mattes a sample of each (brand, category) group's sources (default 40 per group, `--bakeoff-sample`)
with every model the matting services list, scores each matte with section 6's checks plus the
majority of the other models (`consensusLoss`: share of agreed product this matte drops;
`consensusExtra`: share of this matte no other model keeps), and ranks per scope by fewest failing
sources, then the composite (10 x region loss + 3 x thin loss + 10 x background kept + 5 x
see-through + 0.02 x edge softness + 10 x consensus loss + 10 x consensus extra), then speed. The
report shows the per-type table with the margin (runner-up composite minus winner) and the hard-case
fail rate. Policy rows for (brand, category) and (`*`, category) with at least 10 sources are planned
through spec 08's `writePolicyRows` (judge settings kept from the existing row); they are written only
with `--write-policy`, never silently. Model ids stay in the JSON report and the job log.

## 13. Commands

- Local, no GCP: `pnpm test` runs the checkers on synthetic products pushed through the real
  `renderSource`, with a failing case for every check; `node apps/worker/dist/catalog-output-evals.js
  check-folder --dir <root> --product-type <type> [--only ids]` runs the pure image checks on a
  folder of `raw/`, `mattes/` and `outputs/<product>/<channel>/` (the render-investigation layout).
- Golden set: `node apps/worker/dist/catalog-output-evals.js build-golden` (rebuild the manifest from
  the owner's folders; commit it), then `bash infra/catalog-output-evals.sh upload`.
- Against the deployed stack, after `bash infra/deploy.sh`:
  `bash infra/catalog-output-evals.sh run` (mocked judge), `bash infra/catalog-output-evals.sh run
  --live` (live judge, planted and judge checks asserted), `... run --write-policy` (also writes the
  bake-off winners to `model_policy`). Flags `--limit <products>`, `--brand <slug>`, `--skip-bakeoff`,
  `--skip-overwrite` bound a run.
- Output: `catalog-test/evals/<run>/report.json` and `report.html` (every failing image with its
  original, its output and the number that failed), and the one line
  `Output-quality eval: N of M checks passed, K products need attention (target 0)`. Exit code 1 on
  any failed check or any unexpected attention product. Test batches, products and objects are
  cleaned up in `finally` (spend rows kept).

## 14. Test plan

Tier 1 (`pnpm test`): every image check passes on a synthetic footwear product on every channel
(flat lay on Styli) and on a model photo; every check has a case that fails it (format, edges, band,
stray blob, margin intrusion, shifted extent, off-centre, Styli float, redrawn pixels, forbidden
shadow, shadow block, slab, rising gradient, out-of-band shadow, lost strap, lost region, hole, kept
background, halo, fringe, cut flush and guide, missing flag, held, floating line); the row checks on
synthetic rows (completeness, attention including planted items and judge false positives,
consistency, placement, product type, flag rows, overwrite, identical); the golden builder on a
temporary folder (auto tags, derived cases, planted copies, sha256 pinning, round trip); the
bake-off ranking, margin and policy rows; the report summary and HTML.

Tier 3: the job itself (`bash infra/catalog-output-evals.sh run`), which is the deliverable of this
spec; the manager runs it after deploy and attaches the report.

## 15. Done criteria

- `pnpm lint && pnpm typecheck && pnpm test` green; the worker builds with the new entry.
- The golden manifest is committed with at least 60 products and 250 photos across footwear,
  apparel on model, flat lays, bags and hardline, with the hard cases of section 11.
- `check-folder` on the render-investigation evidence reports the shadow blocks and the
  forbidden shadows under models as failing checks with their numbers.
- The job deploys from `infra/deploy.sh`, runs end to end on the golden set, writes the report under
  `catalog-test/evals/<run>/`, prints the summary line, exits non-zero on any failure, and cleans up.
