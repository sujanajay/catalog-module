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
- `progress.ts` per-set records under `catalog-test/evals/<run>/sets/`, resume and `--sets` selection, the
  retrying storage wrapper for the eval path (section 13).
- `sheet-notes.ts` reads the `notes` column of a links workbook.
- `synthetic.ts` synthetic products through the real `renderSource` for the checker tests.
- `apps/worker/src/catalog-output-evals.ts` commands `build-golden`, `upload`, `run`, `check-folder`.
- `infra/catalog-output-evals.sh` `deploy | upload | run [--live] [flags]` (flags, including `--resume` and
  `--sets`, pass through to the CLI); `infra/deploy.sh` deploys the job.
- `packages/core/test-fixtures/catalog/evals/golden-build.json` (how the set is drawn) and
  `golden-manifest.json` (the pinned set).

## 4. Image checks: geometry (`geometry.*`)

Measured on the staged JPEG of every made output, against the channel table. The expected product
mask is the pipeline's own matte projected onto the canvas exactly as the render projects it (cut
to the bbox, lanczos3 to the recorded placement), so the suite knows where the product should be.
The measured product is the set of pixels visibly where the plan put them ("visible product"): inside
the half-coverage mask (projected alpha 128 or more) and matching the source resampled there within
24 per channel, or clearly not canvas background (delta over 24) within 4 px of the mask; a contact
shadow touching the sole is not product. A white sole on a white canvas therefore counts as present
when the source is white there too, and a vanished coloured part does not.
Where the recorded scale leaves no room for the whole bbox on an axis (spec 05 cut fill), the suite
computes the crop itself from the recorded placement and the rule (overflow off that axis's cut
sides only, split evenly when both are cut), never by calling the render's own crop function, so
a render that trims an uncut outline fails `extent` and `pixels_copied`.

| Check | Measured | Bar |
|---|---|---|
| `format` | magic bytes, format, chroma subsampling, colour space, ICC, alpha, bytes, DPI | `FF D8 FF`, jpeg, 4:4:4, srgb, profile present, no alpha, <= 2,000,000 bytes, density equals the channel DPI |
| `canvas` | width x height | fixed channels exact; adaptive channels between minimum and target, target aspect within 1 px, even pixels, equal to the recorded placement |
| `edges` | every pixel of all four edges | background within 8 per channel (JPEG error on a flat colour is under 4), except product pixels touching a zero-margin side; lone ringing pixels (regions under 4 px) ignored |
| `border_band` | every pixel of the 2% border band | same rule as `edges` |
| `outside_product` | non-background pixels (delta > 12) farther than 4 px from the product mask, in regions of at least 12 px, shadow-like darkening excluded where a shadow is allowed | 0 |
| `inside_safe_box` | pixels in the required margins (delta > 24, or > 12 beyond the ring), regions of at least 12 px | 0 |
| `extent` | box of the visible product against the box of the half-coverage mask | each side within 4 px plus one source pixel at the output scale (`4 + ceil(scale)`) |
| `margins` | planned product box against the channel margins | every required margin kept within 1 px |
| `centred` | horizontal centre of the visible product | within 4 px plus half a source pixel (`4 + ceil(scale / 2)`) of the canvas centre (unless the product spans the safe box); not run when the source is cut at the left or right (placed flush by rule, CHANNEL_RULES_VERSION 7) |
| `anchor` | vertical centre (centre channels) or lowest product row (Styli: canvas height minus 450) | within `4 + ceil(scale / 2)` px; not run when the source is cut at the top or bottom |
| `noon_wide` | narrower side margin of a wide Noon shot | at least 5% of the width; not run when the source is cut at the left or right |
| `pixels_copied` | the output's opaque product pixels (alpha 250+) averaged back onto the source grid (every canvas pixel into the source pixel it was resampled from) against the source pixel itself, so the resampling kernel does not enter the number (section 15c) | mean per-channel difference <= 8 and at most 1% of source pixels differ by more than 48 |
| `uniform_scale` | Styli scale spread across a product's non-detail angles | <= 0.5% |

## 5. Image checks: shadow (`shadow.*`)

A shadow is any canvas pixel outside the product (and its 3 px ring) darker than the background by
more than 8 luma, in regions of at least 12 px (ringing specks are not shadow). The band is the spec
05 band (the product box extended 10% of its height above its bottom, 25% below and 10% of its width
each side) widened to the render's own synthesised feather (three sigmas of its horizontal blur,
two depths below the contact line): silhouette plus feather.

The output's own flags say how it carries its shadow: `shadow_synthesised` (the spec 05 contact
shadow, whose shape the bars below describe), neither flag (the photo's own shadow, kept by the render
and scaled with the product: it has the photographer's shape, so it is compared with the source instead),
or `no_shadow_source` (nothing drawn; any darkening is then judged with the synthesised bars).

| Check | Applies to | Bar |
|---|---|---|
| `forbidden` | apparel on a model, flat lays, in `no_shadow_source` or `shadow_synthesised` mode (SPEC.md: a photographic shadow measured on a uniform background is preserved for every type, only synthesis is forbidden on apparel, so an apparel output in kept mode is judged like footwear below and `forbidden` is not run on it) | 0 pixels darker than the background by more than 12 in regions of 24 px or more, and mean darkening of the band under the product <= 1.5 luma |
| `footprint` | shadow-allowed types | every shadow pixel inside the band, within the render's feather of the product mask and in the lower half of the product (silhouette plus feather) |
| `darkness` | shadow-allowed types | darkest shadow pixel <= 65% of the background luma for a synthesised shadow (spec 05 clamp 0.6 plus JPEG); <= 70% for a kept shadow (the clamp plus the product's own fade composited over it) |
| `kept_matches_source` | kept photographic shadows | the output's darkness map equals the darkness the render's own rule keeps from the source (spec 05 `preservedDarkness`: the source's darkness outside the opaque matte, in the band, connected to the contact line, continued past the band with its fade; the plain source darkness where no uniform border lets that rule run), compared on the source grid: every canvas pixel inside the spec 05 band and past the render's fade at the margins, the border band and the photo's frame is averaged into the source pixel it was resampled from, source pixels within 3 px of the product are left out, and the expectation is read at the best offset of a plus or minus 1 source px registration search; mean absolute difference <= 4 luma over the source pixels where either shows a shadow (the bar is re-read on run 4, section 15c); not run under 64 such pixels |
| `hard_edge_horizontal`, `hard_edge_vertical` | synthesised shadows | no run of adjacent-row (or column) steps larger than 16 luma longer than 5% of the product width (or height), never longer than 6 px below that |
| `monotone` | synthesised shadows | mean darkness per distance from the silhouette never rises by more than 2 luma per pixel nor by more than 8 in total, measured 5 to 48 px out |
| `synthesised_on_model` | per output | no apparel-on-model output carries `shadow_synthesised` |

The render on `main` fades a synthesised shadow out before the border band; the unit test
`image-checks.test.ts` keeps a tall product that fills a zero-margin canvas as a passing case so a
future hard clip at the band is caught.

## 6. Image checks: cut-out integrity (`cutout.*`)

The matte is compared with an independent estimate of the product taken from the source's own
colours: pixels farther than 30 per channel from the source's border colour, minus the source's
own cast shadow (grey darkening no darker than 55% of the background luma anywhere; in the lower
40% of the silhouette any unmatted darkening up to chroma 72, where a contact shadow is dark and
picks up colour from the sole), minus the floor reflection (in that lower zone, an unmatted darker
pixel under the matte's lowest row of its column, at most 1.5% of the frame height below it and
never under 8 px, that is lighter than the product's lowest three matted rows there and no more than
12 chroma more saturated: a faded mirror of the product, not a lost part; a dropped sole sliver is
darker or more saturated and still counts), minus specks under 0.02% of the frame. The "source
background colour" is a model per row (`backgroundModel`): prepare's border colour when the border is
uniform, else the per-row median of the 2% border band over the plain rows (per-row interquartile range
of the band pixels under 16; a row the product crosses, or a texture with a steady median, is not plain)
fitted linearly top to bottom, accepted when at least 95% of the rows are plain and the 95th percentile
of their residuals is under 8 levels; it covers a smooth studio gradient and a flat border a cut
product's legs cross, which prepare calls "not uniform"). A border that fits neither (a lifestyle
photo, a full-bleed close-up) leaves these checks "not run" and listed. `edge_softness` needs only the
matte and runs whenever the silhouette has an edge (at least 2% of the frame perimeter; a full-bleed
close-up whose silhouette is the frame is not run). On a pass-through (`matte_passthrough`,
`passthrough`) the photo is kept whole by rule, so `background_kept`, `halo` and `fringe` are not run;
`fringe` is also not run without a background model. On an expected hold (the manifest expects the
photo held and it is) `background_kept` and `fringe` are not run: the output is never published.
White on near-white: when more than 10% of the matte's opaque interior (alpha 255, eroded 3 px) inside
the estimate's convex span lies within the foreground delta (30) of the background colour, the estimate
cannot tell the product from its background, so `background_kept` and `fringe` are not run and listed
as "white on near-white" (section 15c).

| Check | Measured | Bar |
|---|---|---|
| `pixels_lost` | share of estimated product pixels the matte drops, per cell of a 6x6 grid over the product (cells with 200+ pixels) and overall | worst cell <= 1%, overall <= 0.3% |
| `thin_parts` | share of thin pixels lost (what a radius-2 opening removes: straps, laces, hair, heels), when at least 100 exist | <= 10% |
| `background_kept` | matte pixels (alpha > 10) that are source-background coloured (within 10 of the background model), outside the colour estimate dilated 3 px, outside the estimate's convex span grown by 4% of its box, and where the source is flat (luma range under 6 over a 5 px window); a white hem or the rows below the arms of a white dress are woven and inside the span, a kept chunk beside or below the product is flat and outside it | <= 1% of the matte |
| `holes` | connected interior regions (estimate eroded 3 px) the matte drops, each >= 0.05% of the product | 0 |
| `see_through` | share of the interior (the estimate eroded 3 px, which holds no thin structure) with alpha under 200 | <= 0.2% for footwear; <= 1.5% for apparel on a model, flat lays, bags and hardline (section 15c) |
| `edge_softness` | soft alpha pixels (10 to 245) within 8 px of the silhouette, per pixel of silhouette length (a sheer garment's interior is fabric, not edge) | <= 3 px for footwear; <= 4.5 px for apparel on a model, flat lays, bags and hardline (section 15c) |
| `halo` | share of the 3 px ring around the product on the canvas that is not canvas background; where a shadow is allowed (section 5, including a kept shadow on apparel), achromatic darkening (chroma under 24, the ringing a coloured edge lends a shadow) inside the band and up to 10% of the product height above it is the kept shadow and is excluded, a coloured ring or any ring higher up the silhouette counts; not run on a pass-through | <= 2% |
| `fringe` | share of soft-edge pixels (alpha 10 to 200) carrying the source background colour (the row's colour of the background model), when the source has a background model, the output is not a pass-through and the source and canvas backgrounds differ by more than 20 along the product | <= 1% |

White-on-white and dark-on-dark products carry little colour evidence; for them `pixels_lost` is
weaker and the model bake-off (section 12) adds the other models' majority as a second reference.

## 7. Image checks: cut sources (`cut_edge.*`)

A source is cut on a side when at least 2% of that edge's pixels carry product (matte alpha > 10).
The render's cut sides decide the placement (`trim`, the fill rule, the safe box); `flush_<side>` and
`no_line_<side>` are judged on the cut sides of the placed crop (`placedCutSides`): a side the crop was
trimmed on stays cut (the product continues beyond the crop), and another cut side counts only while the
matte along the box's edge line, within the crop's span on the other axis, still holds a straight run of
product at least 2% of the frame edge (never under 8 px). The fill trim can take the rows that touched a
perpendicular edge off the crop (a collar at the left edge below a 32% bottom trim, a wedge at the bottom
inside the trimmed columns, a brief touching the right only in the trimmed bottom third); the output then
rightly shows a margin there and it is not a band. The crop offset comes from the canvas (`matchCropSplit`),
so an uneven or anchored trim is read as the render made it, never assumed centred. A held output
(`needs_attention`, `failed`) is not placed for a channel: it waits fitted and centred, its `flush_*` is not
run, and `not_held` says whether the hold is expected.

| Check | Bar |
|---|---|
| `flush_<side>` | the visible product (section 4: inside the half-coverage mask and matching the source there, or clearly foreground next to it, so a white hem on a white canvas counts) ends within 1 px of the canvas edge on the cut side (the render drops that side's margin, so a cut side is always flush). A band the render left on purpose passes as information (unit `px, fitted by rule`, the gap recorded) when the output's notes carry the spec 05 band note naming that side and the suite's own rule agrees: the axis is cut on both ends and filling it would trim more than a third of the other axis or trim an uncut side (computed from the boxes alone), or the note says a logo, text or a buckle near another edge stopped the fill (trimRoom, which the suite cannot see). A band without the note (the render claims flush), or noted where the rule allowed the fill, fails |
| `trim` | from the recorded scale alone, the share of the product box the placement leaves no room for, per axis (runs on every output; an uncut product trimmed at all fails) | trimmed only on an axis with a cut side, only when the other axis is cut on both ends and fills the canvas, and at most a third (spec 05 `CUT_FILL_MAX_TRIM`, stated independently as `MAX_TRIM_SHARE`) |
| `no_line_<side>` | nothing beyond the cut side is drawn (regions of 12 px or more, delta > 12), and at most 1% of the silhouette's last 12 rows or columns before the cut are a gap: canvas background (delta <= 8) where the source resampled there is something else (delta > 24), so a white shoe or the photo's own white corner is not a gap, counted in regions of 12 px or more inside the half-coverage mask eroded by one source pixel at the output scale (`ceil(scale)`), so the ring the matte's soft edge leaves along every silhouette edge is not a gap and a real gap or floating line still is (no gap, no floating line) |
| `flagged` | the output carries the information flag `cut_in_source` |
| `not_held` | status is not `needs_attention` or `failed`; not run when the manifest expects the photo to be held (the cut is not what holds it) |

## 8. Completeness (`completeness.*`)

For every golden source and ticked channel: exactly one output row (`one_output`); verified, live,
with generation, bytes and crc32c (`live`); the public object exists with the recorded size,
generation and `image/jpeg` (`public_object`); the staged file exists with the same size
(`staged_file`); the sheet cell carries the live link (`sheet_cell`). A skip is allowed only for Styli
when the source height is under `STYLI_MIN_SOURCE_HEIGHT_PX` (1482), with the exact note "Skipped
for Styli: the photo is smaller than Styli needs." and the note in the row's `notes` (`skip_allowed`).
No stray rows or cells (`no_extra_outputs`, `no_extra_cells`). A photo the manifest expects the
pipeline to hold (code-detected expectations such as the 450 px copies; judge-detected ones, and for a
planted product only the planted shot, on a live run) is not required to be live, linked or in a sheet
cell: it must be not live with no link (`held_unpublished`; whether it was held with the right flags
is `attention.expected`'s call) and it is left out of the verified and link counts. A hold is per
product (SPEC.md: `pending_attention` stages every shot of the product), so every other shot of a
product with an expected-hold shot is expected staged with no link as well (`held_unpublished`, named
as a sibling of the held shot) and leaves the counts with it. A Styli skip under the minimum stays a
skip on a held product: the pipeline counts it as skipped and the sheet row carries the note. Counts: planned
equals sources x channels (`counts_planned`), verified equals planned minus skipped minus expected
holds (`counts_verified`), and "Links verified" equals "Independent re-check" equals the links in the
sheet (`recheck_equals_verified`).

Amazon and Shein: the spec makes one output per shot on every channel; only the canvas colour
differs (image 1 pure white, the rest light grey). Three inputs give three Amazon images and three
Shein images. The suite asserts this per shot (`amazon_shot`, `shein_shot`), so a product with
three photos and one Amazon link is a failure with the missing shot named.

## 9. Attention and judge behaviour (`attention.*`)

| Check | Bar |
|---|---|
| `not_held` | a product the manifest does not expect to need attention goes straight to the sheet |
| `expected` | a product the manifest expects to hold (for example a 450 px source, or one shot with a per-shot expectation) is held with exactly the expected flags; information flags (`low_resolution`, `no_shadow_source`, `shadow_synthesised`, `passthrough`, `matte_passthrough`, `alpha_source`, `qa_sampled_out`, `cut_in_source`, `numbering_gap`) ride along; judge-detected expectations are asserted only on a live run, and a judge-only flag (`complete_product`, `different_product`, `halo`, `text_or_watermark`, `collage`, `orientation`) listed on a code-detected expectation is neither required nor unexpected on a mocked run (the candle Z011CB57531CA8FA0CBDDZ n=1: held by code for `leftover_background`, by the judge for `text_or_watermark`) |
| `planted_caught`, `planted_rate` | every planted wrong item (a photo of another product, ideally another brand, appended as the last shot) is held as `different_product` on that shot only; 100% caught (live run). The planted shot runs no image check: it is a photo of another product, often another type, processed under the host's rules (`runImageChecks` records every check on it as not run, with the number it measured) |
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
(`altered_new_generation`, `untouched_unchanged`), none of the dropped shot's live rows from before
the delivery survives on a selected channel (`removed_not_live`: measured against those rows, not one
per selected channel, since Styli may have skipped the shot) and its link returns 404 after the cache
window (`removed_gone`), Amazon is listed as not refreshed
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
- Per-shot expectations (`overrides.<identifier>.shots.<n>`): `ZEE79259BBFD83FFA1DB0Z` shot 5 is a
  lifestyle photo on a tennis court (non-uniform background, eval run 2 defect A1: published as a broken
  pass-through, headless on the square canvases). It expects a hold for `leftover_background` with the
  reason "background could not be removed", detected by code; the product's expectation is its first shot
  that expects a hold. An entry's `expect.reason` documents why and is never asserted.
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
see-through + 0.02 x edge softness + 10 x consensus loss + 10 x consensus extra; an unbounded
weighted sum, lower is better, never clamped: 10 x a consensus loss of 10% alone is 1, and clamping
hid the margin on eval run 2), then speed. The report shows the per-type table with the margin
(runner-up composite minus winner) and the hard-case fail rate. Policy rows for (brand, category) and (`*`, category) with at least 10 sources are planned
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
  `--skip-overwrite` bound a run; `--sets anta.footwear,penti.apparel_flat` runs only the named
  (brand, category) sets.
- Output: `catalog-test/evals/<run>/report.json` and `report.html` (every failing image with its
  original, its output and the number that failed), and the one line
  `Output-quality eval: N of M checks passed, K products need attention (target 0)`. Exit code 1 on
  any failed check, any unexpected attention product or any failed set. Each set's test batches,
  products and objects are cleaned up as soon as the set ends, before the next one starts (spend rows
  kept); the same cleanup runs before a set, so a crashed earlier attempt of the run leaves nothing
  locked.
- Durable progress and resume. The run id (`evals-<timestamp>-<6 hex>`) is the first line of the
  job log. The job processes one (brand, category) set at a time (its batch, the row and image
  checks, the overwrite contract on the first set with a three-shot product, the bake-off trials of
  its sources, cleanup) and then writes `catalog-test/evals/<run>/sets/<brand>.<category>.json` with
  everything the report needs from that set (check results, contact-sheet thumbnails, attention rows,
  bake-off trials, which batches it made). A failure inside a set is recorded as a `failed` record
  with the error and the job goes on with the next set; the report is still written from the sets it
  has and the exit code is 1. `run --resume <run>` loads the records, skips the sets recorded as
  done, re-runs the failed or missing ones and writes the report from all of them. The report's
  `sets` table (JSON and HTML) lists every set with its status, its error and whether the overwrite
  contract ran on it.
- Evidence retention. The set's cleanup deletes every output, so before it runs the job copies the
  full-size staged output of every image with a failing check (at most 200 per set, the rest noted in
  the job log) to `catalog-test/evals/<run>/evidence/<set>/<identifier>__<channel>__<n>.jpg` and
  records that path on the thumb row of the set record; the HTML report prints it under the thumbs.
  Writes stay under `catalog-test/`.
- Retries. Every storage read and write of the eval path (golden sources, raw photos, mattes, staged
  outputs, public heads, set records, the report) goes through `retryTransient` with five attempts
  (1 s, 2 s, 4 s, 8 s between them) on socket resets, hang-ups, timeouts, 429 and 5xx. The storage
  module itself also retries whole-object downloads and listings (four attempts), so the pipeline
  handlers the job runs inline (ingest, matte) get the same protection. The GCS client's own retry
  does not cover a download stream the server drops mid-read (the `socket hang up` that ended the
  first job run), which is why the wrapping sits on our side.

## 14. Test plan

Tier 1 (`pnpm test`): the eval-path storage wrapper retries a read that hangs up twice and gives up
after the fifth attempt; a set record round-trips with its thumbnails; resume skips done sets, re-runs
failed ones and honours `--sets`; the storage module retries a download whose socket hangs up.
Every image check passes on a synthetic footwear product on every channel
(flat lay on Styli) and on a model photo; every check has a case that fails it (format, edges, band,
stray blob, margin intrusion, shifted extent, off-centre, Styli float, redrawn pixels, forbidden
shadow, shadow block, slab, rising gradient, out-of-band shadow, lost strap, lost region, hole, kept
background, halo, fringe, cut flush and guide, missing flag, held, floating line, a cut-fill trim beyond
a third or on an uncut side, a fitted cut top with a band beside it); one regression case per gate-3
defect class (a 150 px band beside a cut edge fails `flush`, a rectangular block fails `hard_edge` on
a synthesised shadow and `kept_matches_source` on a kept one, a 20% product loss and a dropped sole
sliver fail `pixels_lost`, a grey halo above the shadow band fails `halo`) next to the cases that must
pass (a white product on a white canvas, a kept photographic shadow, a floor reflection, a white hem on
a cut side, a pass-through); the evidence copy is capped at 200 per set under `catalog-test/`; the row checks on
synthetic rows (completeness, attention including planted items and judge false positives,
consistency, placement, product type, flag rows, overwrite, identical); the golden builder on a
temporary folder (auto tags, derived cases, planted copies, sha256 pinning, round trip); the
bake-off ranking, margin and policy rows; the report summary and HTML.

Tier 3: the job itself (`bash infra/catalog-output-evals.sh run`), which is the deliverable of this
spec; the manager runs it after deploy and attaches the report.

## 15. Threshold calibration (eval run 2, `evals-20261020111831-8d62d7`, anta.footwear: 87 photos, 696 outputs, mocked judge)

Every bar below was set from the measured distribution of that run plus a look at the thumbs or the
golden sources; the deployed build was `dda56bc`. A check must still fail on the gate-3 defects
(cut-edge bands, rectangular shadow blocks, a vanished product, halos), which the regression tests of
section 14 pin.

| Check | Run 2 distribution (old bar) | Cause | New bar and why |
|---|---|---|---|
| `geometry.extent` | 388 of 696 fail; uncut kept-shadow outputs p50 6, p90 21, max 68 px; cut sources p50 2, max 8 (bar 4) | the bare alpha box (alpha > 10) includes the matte's soft edge, invisible at delta > 24 and 4 to 10 px wide at 3.75 to 5x; white soles and uppers are invisible against a white canvas (the 49 to 68 px cases) | visible product (source match or clearly foreground) against the half-coverage box, tolerance 4 px plus one source pixel at the scale |
| `geometry.anchor`, `centred` | anchor 197 fails: cut sources p50 40, max 402 px (flush placement by rule); uncut p50 2.5, p90 9, max 30, moved by half the extent deficit | same as extent, plus cut axes | not run on a cut axis; tolerance 4 px plus half a source pixel |
| `geometry.noon_wide` | 6 fails, all wide shots cut left or right placed flush (0 px side) | flush placement by rule | not run on a cut side |
| `shadow.hard_edge_horizontal` | 246 fails, all 376 kept shadows (p50 162, max 753 px); synthesised 0 of 185 | a studio contact shadow has a crisp line under the sole, scaled 1.4 to 5x | synthesised shadows only; kept shadows get `kept_matches_source` (mean difference <= 4 luma; the synthetic kept shadow measures 0.5, worst 2) |
| `shadow.monotone` | 129 kept (photographer's shape) + 8 synthesised with steps under 1.5 and totals 4.1 to 4.7 (bar 4); synthesised step p95 1.1, max 1.5 | the total of positive rises over 44 bins accumulates JPEG noise | synthesised only; step 2, total 8 (a 0.8 luma per px rise still totals 32) |
| `shadow.darkness` | 38 fails, all kept: p50 0.63, p90 0.65, max 0.67 (bar 0.65); synthesised p90 0.23, max 0.24 | the product's own fade (alpha under 10) composited over the 0.6 clamp | kept 0.70, synthesised 0.65 (a black slab at 0.8 still fails) |
| `cutout.halo` | 174 fails, all kept shadows: p50 1.3%, p90 5.9%, max 9.2%; others max 0.05% | the kept shadow runs up the sides and in front of the shoe above the band line, inside the 3 px ring | achromatic darkening (chroma under 24) excluded inside the band plus 10% of the product height above it; a grey halo above that or a coloured ring still fails |
| `cutout.background_kept` | 168 fails: p50 0.13%, p90 0.69%, p95 0.86%, max 1.48% (a 450 px copy); pass-through 1.34% (bar 0.5%, estimate dilated 2 px) | the matte's soft fringe (alpha 10 to 60) 2 to 3 px beyond the colour estimate, invisible on the canvas | 1% with the estimate dilated 3 px; not run on a pass-through; a 90 px strip of kept background measures over 15% |
| `cutout.fringe` | 16 fails: 8 on the pass-through photo (12 to 17%), 8 on a close-up without a uniform border (2.7%) | a pass-through keeps the photo by rule; without a uniform border the "source background colour" is not one | not run on a pass-through and without a uniform border; bar unchanged |
| `cutout.pixels_lost` | 32 fails: 8 real (bd-112625546-12 n=5, the lime midsole sliver, 25.8%), 24 on bd-112621603-1 n=4 and 5 and bd-112545581-15 (3.7 to 5.5% of the bottom-middle cell) | a faded pink floor reflection 1 to 7 px under the sole with chroma up to 92 (above the 72 of the zone rule) is called product | floor-reflection rule in the estimate (thin, lighter, no more saturated than the product above); the sliver (chroma 100 to 150 under a black outsole) still counts; bars unchanged |
| `cut_edge.no_line_*` | 70 fails: white shoes cut at the frame 1.1 to 1.9%, close-ups with the photo's white corner 25 to 34% (bar 1%); the "beyond the edge" half never fired | the gap counted the product's own white as background | a gap pixel must differ from the source resampled there by more than 24; the silhouette is the half-coverage mask |
| `cut_edge.flush_bottom` | 10 fails on the two gate-3 close-ups, 29 to 73 px, only on channels that fill the height and trim the width; 0 px on the square canvases; anchor off by exactly half the gap; `trim` and `pixels_copied` pass | not a crop offset: once the width is trimmed off the cut sides, the crop's last rows are the photo's own white, invisible against the white canvas | measured on the visible product, which keeps white rows that match the source; a 150 px band still fails |
| `geometry.pixels_copied` | 2 fails, 8.4 on bd-162637307S-2 n=4 noon and namshi (bar 8), a knit close-up cut on four sides with an uneven split | the split search sampled 40 x 40 nearest-neighbour points with a 1 luma tie, which aliases on a fine texture | 96 x 96 bilinear samples, tie 0.5; bar unchanged |
| `completeness.*` on the expected hold | 28 fails on bd-112621603-1-downscale450 (held as expected) and the batch counts | the checker required every source to be live | expected holds must be unpublished and are left out of the counts |
| `overwrite.removed_not_live` | 1 fail: 7 removed rows against 8 selected channels | Styli skipped every Anta source | measured against the removed shot's live rows before the delivery |
| bake-off composite | birefnet-general-lite clamped at 1.0000 (10 x 9.9% consensus loss alone is 0.99) | the clamp | unclamped (ranking unchanged: general 0.9325, lite 1.4469, margin 0.5144 over 40 sources, against the 0.0675 the clamp showed) |

Contracts changed by this calibration: `OutputContext` gains `half` and `sourceRgb`; `CompletenessInput`
gains `heldExpected`; `ReportThumb` gains `evidence`; new check ids `shadow.kept_matches_source` and
`completeness.held_unpublished`; `overwrite.removed_not_live` measures `k of n`; `ModelScore.composite`
is unbounded; `progress.ts` exports `EVIDENCE_CAP_PER_SET`, `evidencePath`, `EvidenceBudget`.

### 15b. Apparel calibration (eval run 2, french_connection.apparel_model: 144 photos, 1136 outputs with image checks, mocked judge)

The same run's apparel-on-model set, re-read under the PR #61 rules. Every bar below was set from the
measured distribution plus the thumbs and the golden sources; the gate cases of section 14 still fail.

| Check | Run 2 distribution (old bar) | Cause | New bar and why |
|---|---|---|---|
| `cut_edge.no_line_*` | about 470 fails on about 354 outputs over 40+ photos, gap share 1 to 3.6% (bottom p50 1.8%, top p50 2.7%), identical across channels for a photo (Z496A6D49F492382B0B59Z n=1 2.1% on centrepoint and trendyol at scales 3.75 and 1.5), highest where the strip holds many silhouette edges (Z2392E34E478442A647DBZ n=5 top 3.6%), zero on a full-width close-up; anta 1.1 to 1.9% on cut white shoes | the half-coverage mask and the rendered alpha differ by up to one source pixel along every silhouette edge, so a one-source-pixel ring of canvas background sits inside the half mask; with the source studio grey and the canvas colour more than 24 apart the source-match rule does not absorb it | gap pixels counted only inside the half mask eroded by `ceil(scale)` and in regions of 12 px or more; bar 1% unchanged (a floating line 12 rows deep still measures over 60%) |
| `cut_edge.not_held` | 8 fails, all on the expected hold Z023DBEC95DCF485E9E6EZ-downscale450 (a cut 450 px copy) | the check ignored the manifest's expectation | not run when the manifest expects the photo to be held |
| `cutout.edge_softness` | 40 of 88 measured fail, 3.19 to 3.48 px (bar 3): matted outputs p50 2.98, p90 3.48, max 3.48; anta kept p50 2.56, p90 2.69, max 2.82; bake-off trials p50 3.19, p90 3.91, max 4.42 | fabric edges (fuzz, flat-lay seams) and a white box on white are softer than a shoe outline in every model and look sharp on the canvas | 3.5 px for apparel on a model, flat lays, bags and hardline; footwear keeps 3 px. The apparel bake-off ranking hinges on this bar: at 3.0 birefnet-general-lite wins (0.492 over birefnet-general 0.571); at 3.5 the top three are at 0 fails and bria-rmbg wins on composite (0.230 vs 0.492, margin 0.26), losing nothing the others keep |
| `cutout.halo` | 2 fails on the pass-through ZEE79259BBFD83FFA1DB0Z n=5 (2.16%) measuring the photo's own background | a pass-through keeps the photo by rule | not run on a pass-through, as `background_kept` and `fringe` already were |
| `cut_edge.flush_left`, `flush_right`, `flush_top` | 15 + 15 fails on 2:3 close-ups cut on three or four sides placed on the three square canvases (Z24C7404AA36DACC958B4Z n=2 and 5, ZB8B3C9012AE815065B7BZ n=5, Z03E68A3989163039BCFEZ n=3, Z8A70D494DBDD6A6A1C5EZ n=4, 173 to 384 px) and 5 `flush_top` fails on the logo-safe fallback (Z2392E34E478442A647DBZ n=5 trendyol 203 px, ZFAC5C5271DD3A9B41C32Z n=5 72 px, ZEE79259BBFD83FFA1DB0Z n=5 90 px), every one carrying the spec 05 band note | filling the width of a square canvas with a 2:3 photo trims a third of the height, which spec 05 refuses; the logo-safe fallback fits on purpose | decision (a), taken by the manager on the owner's behalf: a band the render fitted on purpose passes as information when the output carries the band note naming the side and the suite's own rule agrees (fill refused by the third, by an uncut side, or by a logo per the note); the render claiming flush without the note, or noting a band where the rule allowed the fill, fails. Apparel sets carry far more full-bleed close-ups than footwear (88 four-side-cut outputs here, 16 on anta) |
| `shadow.forbidden`, `geometry.outside_product`, `cutout.halo` | 8 + 8 + 8 fails on the planted shoe Z023DBEC95DCF485E9E6EZ-planted n=4 (an Anta photo under an apparel product): the render kept its photographic contact shadow (no `no_shadow_source`), 18k to 114k shadow pixels, halo 35 to 38% | the owner's bar in section 5 ("a model photo gets no shadow at all") and SPEC.md's shadow rule (a measurable source shadow is preserved for every type; only synthesis is forbidden on apparel) disagreed; no real French Connection photo carries a source shadow (1144 `no_shadow_source`) | decision (b): the suite follows SPEC.md. An apparel output in kept mode is judged like footwear (`footprint`, `darkness` at the kept bar, `kept_matches_source`), `forbidden` is not run on it, and `outside_product` and `halo` exclude the kept shadow in its band as they do for footwear; `forbidden` still fails any darkening on an apparel output that says `no_shadow_source` or `shadow_synthesised`, and `shadow.synthesised_on_model` still fails the flag |
| `cutout.pixels_lost`, `thin_parts`, `background_kept`, `edge_softness`, `fringe` coverage | run on 88 of 1136 outputs (11 photos, 7.7%): prepare called the border of 131 photos "not uniform" (stdev 10 to 74) | not a gradient: the French Connection borders are white (100 of the 132 fits are flat 255; the rest drop at most 9 levels top to bottom) and the product crosses the 2% band (78 cut photos, feet near the bottom), which lifts the band's standard deviation past 8 | the background model (section 6): per-row median of the band over the plain rows (interquartile range under 16) fitted linearly, accepted when at least 95% of the rows are plain and their residual at the 95th percentile is under 8 levels. On the run 2 sources the model fits 118 of 160 photos (11 uniform, 107 fitted); the colour checks would run on 880 of 1136 outputs (77.5%, from 7.7%: 110 of 142 photos, from 11). The 42 photos without a model stay not run: the lifestyle photo, the text banner, the bag and hardline close-ups, the full-bleed close-ups, and products crossing a side band for more than 5% of the rows (a cream blouse cut at the right, the candles), where a median-only fit would have called the product its own background and failed `background_kept` on it. `edge_softness` now runs on every matte |
| `attention.expected` on an expected hold of a cut photo | would fail with "Unexpected flags: cut_in_source" under the PR #61 checkers | `cut_in_source` and `numbering_gap` were not in the suite's information flags | both are information flags (SPEC.md, spec 10 section 7), as in the pipeline's own triage |
| golden manifest | ZEE79259BBFD83FFA1DB0Z n=5 (lifestyle photo, defect A1) expected no attention and went to the sheet as a broken pass-through | the manifest was wrong | per-shot expectation: held for `leftover_background` ("background could not be removed"), detected by code, once the render holds such photos (parallel render PR). Until that PR lands the suite reports the miss as `completeness.held_unpublished` and `attention.expected` fails on this product, which is the intent |

Not changed: `geometry.extent` on hair tops and hands (9 to 16 px, about 20 predicted fails, watched on run 3), the real defects A1 (lifestyle pass-through) and A2 (candle kept-background blob, Z15276411CE85C2E728DEZ n=4, now measurable by `background_kept` with the background model) stay failures for the render owner.

Contracts changed: `OutputSubject` gains `reason` (the render's notes, where the band note lives; the worker fills it from `catalog_outputs.reason`); `Expectation` gains `reason`; `MatteInput` gains `productType` (the bake-off passes the set's category); `GoldenOverride` gains `shots`; `context.ts` exports `shadowMode`, `shadowAllowedFor`, `APPAREL_TYPES`; `image.ts` exports `backgroundModel`, `GRADED_RESIDUAL_MAX`; `cutout.ts` exports `edgeSoftnessBar`, `EDGE_SOFTNESS_MAX_PX_SOFT_TYPES`; `cut-edge.ts` exports `cutBandNote`, `NO_LINE_STRIP_PX`, `NO_LINE_GAP_MAX`.

### 15c. Run 3 calibration (eval run 3, mocked judge, build `cbe378d`: `evals-20261020175606-9d3801` french_connection.apparel_model 144 photos, 1136 outputs; `evals-20261020175611-f6093d` anta.footwear 87 photos, 696 outputs, and penti.apparel_flat 10 photos, 72 outputs)

The suite after sections 15 and 15b, re-read on the first run that measured every apparel matte and
the first real kept shadows. Footwear bars stay separate from the apparel bars throughout. Every
change below is a suite rule or a bar; the real output defects of the run (the Z5A0B7DE13FC67EDEAC9DZ
false hold, PR #68; the lime midsole sliver bd-112625546-12 n=5) stay failures for the render owner.

| Check | Run 3 distribution (old rule) | Cause | New rule and why |
|---|---|---|---|
| `completeness.live`, `public_object`, `sheet_cell`, `amazon_shot`, `shein_shot`, `counts_verified`, `recheck_equals_verified` | 40 fails on ZEE79259BBFD83FFA1DB0Z n=1/2/3/4/6 (staged), 5 + 5 on the Amazon and Shein shots, and the two batch counts | a hold is per product (SPEC.md `pending_attention` stages every shot), so the siblings of an expected hold are expected staged, not live | every shot of a product that holds an expected-hold shot counts as held (`held_unpublished`, named as a sibling); the counts subtract the product's shots, not the held shot alone |
| `completeness.counts_verified` (anta) | 1 fail: "688 verified, 87 skipped" against 86 expected skips | the held photo's Styli row is a skip (too small for Styli), not a hold; the pipeline counts it as skipped and the sheet row carries the note | a Styli skip under the minimum keeps precedence over the hold (want = skip before held) |
| `cut_edge.flush_left`, `flush_right` on a held output | 14 fails on the expected hold ZEE79259BBFD83FFA1DB0Z n=5 (46 to 500 px, whole photo fitted and centred while it waits) | a held photo is not placed for a channel | `flush_*` not run when the output's status is `needs_attention` or `failed`; the photo is judged after Use as is |
| `cut_edge.flush_*` on a trimmed crop | 3 fails on Z03E68A3989163039BCFEZ n=3 (164, 96, 96 px): the 32% bottom trim removed the collar rows that touched the left edge; 10 fails of 10 to 72 px on the anta four-side close-ups bd-152637502S-3 n=4 and bd-162637307S-2 n=4 on the channels that trim the width (the source touches the bottom only with a wedge inside the trimmed columns: fit at 2.255 with 300/304 px trimmed, a 72 px band predicted at 68); 3 fails of 36 and 91 px on the penti briefs ZC467A7AF2809283D3CC1Z n=5, cut at the right only in the bottom third and placed on the square canvases with the whole 600 px trim taken off the bottom | the check compared with the canvas edge although the rows that touched the cut side were trimmed off the crop; the render is correct, the output rightly shows a margin there | the cut sides are re-derived from the placed `sourceCrop` against the source frame (`placedCutSides`): a side trimmed by the crop stays cut, another side counts only while the matte along the box edge within the crop's span holds a straight run of at least 2% of the edge; the crop offset is the one read from the canvas (never a centred assumption) |
| `cutout.edge_softness` | french_connection: 576 of 1136 fail at 3.5 once every matte is measured (per photo p50 3.51, p75 3.80, p90 4.18, max 8.82); penti flat lays: 32 fails at 3.56 to 4.13 on lace and scalloped trims (every model measures the same photo 3.2 to 4.4; hrsod's blurred matte 6.5); anta: 8 fails at 3.84 on the planted apparel photo at the footwear bar | the 3.5 bar was set on the 88 uniform-background outputs of run 2; model photos at 3.9 to 4.3 (Z8B237082C47318367E4EZ n=2, ZAA7E76B0731DA9A33A14Z n=6, the planted striped shirt) are crisp on the canvas; the sheer blouse Z2392E34E478442A647DBZ n=1 to 5 (4.7 to 8.8) counted its own fabric (alpha under 245 across the whole chiffon) as edge; a full-bleed close-up (Z5A0B7DE13FC67EDEAC9DZ n=4, 6.87) has almost no silhouette | soft pixels counted only within 8 source px of the silhouette; bar 4.5 px for apparel on a model, flat lays, bags and hardline (footwear keeps 3; the penti analysis asked for 4.5 on flat lays alone, the 1136-output distribution sets it for every soft type); not run when the silhouette edge is under 2% of the frame perimeter; a 12 px blurred halo still measures about 7.8. Expected residue: the hair photos ZEE n=1/2/3, Z018DB67F18ED22618F47Z n=3, Z496A6D49F492382B0B59Z n=5 (about 5 photos, 40 outputs), to be read on run 4 |
| `cutout.see_through` | 112 fails at 0.2% on 14 photos, all under 1.4% (sheer chiffon 0.6 to 1.4%, hair 0.3 to 1.3%, white shirts on white 0.6%), none visible on the canvas | the bar was set on footwear | 1.5% for the soft types (footwear keeps 0.2%); a 3% translucent patch inside a body still fails. The interior (estimate eroded 3 px) holds no thin structure, so hair and straps never count |
| `cutout.background_kept` on white garments | 40 fails of 1.07 to 3.63% on the white dress ZB5301181BC52714C5361Z n=2/5, the pale trousers Z7716BC1981657243C91EZ n=2, Z8224D7B79607CEF4F291Z n=2 and the white skirt ZA716110F0007AFE88545Z n=4 | the borders fit at 255 and the hem corners and the rows below the arms have no colour evidence on either side | a matching pixel also needs a flat source there (luma range under 6 over 5 px) and must lie outside the estimate's convex span grown by 4% of its box; the candle chunk of run 2 (1.99% of the frame, a solid blob below the base) and a 90 px strip beside the product are flat and outside the span and still measure over the bar. Alternative if run 4 finds the rule unstable: bar 4% on sources tagged `white_on_white` |
| `cutout.background_kept`, `fringe` white on near-white | penti: 23.8% kept background and 9% fringe on the white bra set Z2E78B7B99B8F4B17BE38Z n=2 over a flat 245 grey; all four bake-off models measure 0.24 on the source and the matte is complete | with a foreground delta of 30 the estimate cannot tell a 245 to 252 product from a 245 background, so the number measures the product's colour, not the matte | not run when more than 10% of the matte's opaque interior inside the estimate's span lies within the foreground delta of the background colour, listed as "white on near-white" |
| `cutout.background_kept`, `fringe` on an expected hold | anta: 1.22% on the held 450 px copy bd-112621603-1-downscale450 (a 3 px fringe on a 450 px perimeter) | the output is never published | not run on an expected hold (the manifest expects it and the output is held) |
| `cutout.halo`, `shadow.footprint`, `edge_softness` on a planted photo | 16 fails on the Anta shoe planted under Z023DBEC95DCF485E9E6EZ n=4 (halo 18.5 to 23.8%, footprint 2125 to 20036 px: a kept cast shadow longer than the band reach on a footwear photo under apparel rules); 8 on the French Connection model photo planted under bd-152638122-2 n=6 at the footwear softness bar | the planted item exists to test the judge, not the render | no image check is judged on a planted shot: every check is measured and recorded as not run (`attention.planted_caught` judges the photo on a live run) |
| `shadow.kept_matches_source` | anta: 170 of 376 kept shadows (32 of 47 photos): p50 3.7, p75 11.6, p90 20, max 66.9 against a bar of 4 set on the synthetic shadow; the same matte measured 6.3 to 31.8 across channels (bd-122545519-5 n=4) while its darkness maps equal the source on every channel; a raised toe's detached shadow, dropped by the render's contact-line rule, measured 52 to 67 (bd-112635512-4 n=1) | a 1 source px contact line scaled 1.6 to 4.8x is a 200 luma step and one pixel of registration costs about 3 luma of mean; the suite expected the whole source darkness while the render keeps only the components connected to the contact line | the expectation is the render's own `preservedDarkness` (contact-line components plus the fade past the band), compared on the source grid (the output's darkness averaged over the canvas pixels of each source pixel) at the best of a plus or minus 1 source px registration search, outside a 3 source px product ring; the bar stays at 4 until run 4 measures the new metric on real photos (not re-derivable from the run 3 records) |
| `cutout.pixels_lost`, `thin_parts` floor reflection | anta: the same 24 fails as run 2 (3.15 to 5.53%, bd-112621603-1 n=4/5, bd-112545581-15 n=2; thin_parts 11.5% on n=5) on a pink 1 to 2 px mirror of a red sole edge under a grey row, identical to four decimals across all four bake-off models | the reflection was compared with the mean of the lowest three matted rows, which is darker and less saturated than the sole edge it mirrors | the reflection's chroma is compared with the highest chroma of the lowest six matted rows of the column and "lighter" against the darkest of them; the lime sliver (chroma 100 to 150 under a black outsole) still counts |
| `geometry.pixels_copied` | anta: 8.4 on the knit close-up bd-162637307S-2 n=4 noon and namshi at 1.85x, unchanged by the 96 x 96 split search, with a 2 luma fit error in an independent alignment | the lanczos output against the suite's bilinear resample of a fine texture, not an offset | the output's product pixels are averaged back onto the source grid and compared with the source pixel itself; bar unchanged |
| golden manifest | Z011CB57531CA8FA0CBDDZ n=1 (lifestyle candle, set french_connection.other) expected `text_or_watermark` by the judge only; PR #68 shows the render holds it as busy background under every policy (6.6 to 12.7% scenery) | the manifest did not expect the code hold, so `attention.expected` would call `leftover_background` an unexpected flag | per-shot expectation: flags `leftover_background` and `text_or_watermark`, detector code, with its reason; the judge-only flag is asserted live only (section 9) |

Offline re-evaluation of the three run 3 records under these rules (bars and row-level rules re-derived
from the recorded numbers; the rules that need the images are listed as such): french_connection 1123
fails to 346 (128 of them need the images: the 8 px softness reach on the sheer blouse and the
white-garment `background_kept`), of which 346 minus those are the false hold's 64 + 16 + 8 + 2 rows;
anta 255 to 228 (all 228 need the images: the kept-shadow metric, the reflection rule, `pixels_copied`,
and the 24 rows of the real sliver); penti 51 to 16 (all 16 need the images: white on near-white).

Contracts changed: `OutputSubject` gains `planted` (the worker fills it from the manifest entry);
`MatteMetrics` gains `noColourEvidence`; `context.ts` exports `placedCutSides`, `PLACED_CUT_MIN_SHARE`,
`PLACED_CUT_MIN_PX`; `cutout.ts` exports `seeThroughBar`, `SEE_THROUGH_MAX_SOFT_TYPES`, `SOFT_TYPES`,
`EDGE_SOFTNESS_REACH_PX`, `EDGE_SOFTNESS_MIN_EDGE_SHARE`, `BACKGROUND_KEPT_FLAT_RANGE`,
`BACKGROUND_KEPT_FLAT_PX`, `BACKGROUND_KEPT_SPAN_GROW`, `REFLECTION_ROWS`, `NO_COLOUR_EVIDENCE_MAX_SHARE`,
`flatAt`, `convexSpan`; `shadow.ts` exports `expectedKeptDarkness`, `KEPT_REGISTRATION_PX`,
`KEPT_RING_SOURCE_PX`; `attention.ts` exports `JUDGE_ONLY_FLAGS`.

## 16. Done criteria

- `pnpm lint && pnpm typecheck && pnpm test` green; the worker builds with the new entry.
- The golden manifest is committed with at least 60 products and 250 photos across footwear,
  apparel on model, flat lays, bags and hardline, with the hard cases of section 11.
- `check-folder` on the render-investigation evidence reports the shadow blocks and the
  forbidden shadows under models as failing checks with their numbers.
- The job deploys from `infra/deploy.sh`, runs end to end on the golden set, writes the report under
  `catalog-test/evals/<run>/`, prints the summary line, exits non-zero on any failure, and cleans up.
- A run that stops in one set keeps the finished sets' records and `run --resume <run>` finishes
  the report without re-running them.
