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
| `pixels_copied` | product pixels (alpha 250+) against the source resampled to the product box | mean per-channel difference <= 8 and at most 1% of pixels differ by more than 48 |
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
| `forbidden` | apparel on a model, flat lays (the owner's bar: a model photo gets no shadow at all) | 0 pixels darker than the background by more than 12 in regions of 24 px or more, and mean darkening of the band under the product <= 1.5 luma |
| `footprint` | shadow-allowed types | every shadow pixel inside the band, within the render's feather of the product mask and in the lower half of the product (silhouette plus feather) |
| `darkness` | shadow-allowed types | darkest shadow pixel <= 65% of the background luma for a synthesised shadow (spec 05 clamp 0.6 plus JPEG); <= 70% for a kept shadow (the clamp plus the product's own fade composited over it) |
| `kept_matches_source` | kept photographic shadows | the output's darkness map equals the source's darkness (share below the source background luma, clamped at 0.6, outside the opaque matte) resampled to the placement: mean absolute difference <= 4 luma over the pixels where either shows a shadow, inside the spec 05 band, outside the 3 px ring and past the render's fade at the margins, the border band and the photo's frame; not run under 64 such pixels |
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
darker or more saturated and still counts), minus specks under 0.02% of the frame. Only sources with
a uniform border run these; others are "not run" and listed. On a pass-through
(`matte_passthrough`, `passthrough`) the photo is kept whole by rule, so `background_kept` and
`fringe` are not run; `fringe` is also not run without a uniform source border.

| Check | Measured | Bar |
|---|---|---|
| `pixels_lost` | share of estimated product pixels the matte drops, per cell of a 6x6 grid over the product (cells with 200+ pixels) and overall | worst cell <= 1%, overall <= 0.3% |
| `thin_parts` | share of thin pixels lost (what a radius-2 opening removes: straps, laces, hair, heels), when at least 100 exist | <= 10% |
| `background_kept` | matte pixels (alpha > 10) that are source-background coloured, outside the colour estimate dilated 3 px and outside the silhouette's span | <= 1% of the matte |
| `holes` | connected interior regions (estimate eroded 3 px) the matte drops, each >= 0.05% of the product | 0 |
| `see_through` | share of the interior with alpha under 200 | <= 0.2% |
| `edge_softness` | soft alpha pixels (10 to 245) per pixel of silhouette length | <= 3 px |
| `halo` | share of the 3 px ring around the product on the canvas that is not canvas background; where a shadow is allowed, achromatic darkening (chroma under 24, the ringing a coloured edge lends a shadow) inside the band and up to 10% of the product height above it is the kept shadow and is excluded, a coloured ring or any ring higher up the silhouette counts | <= 2% |
| `fringe` | share of soft-edge pixels (alpha 10 to 200) carrying the source background colour, when the source has a uniform border, the output is not a pass-through and the source and canvas backgrounds differ by more than 20 | <= 1% |

White-on-white and dark-on-dark products carry little colour evidence; for them `pixels_lost` is
weaker and the model bake-off (section 12) adds the other models' majority as a second reference.

## 7. Image checks: cut sources (`cut_edge.*`)

A source is cut on a side when at least 2% of that edge's pixels carry product (matte alpha > 10).

| Check | Bar |
|---|---|
| `flush_<side>` | the visible product (section 4: inside the half-coverage mask and matching the source there, or clearly foreground next to it, so a white hem on a white canvas counts) ends within 1 px of the canvas edge on the cut side (the render drops that side's margin, so a cut side is always flush; the render's "cannot reach that edge" fallback is a failure here, reported to the render owner) |
| `trim` | from the recorded scale alone, the share of the product box the placement leaves no room for, per axis (runs on every output; an uncut product trimmed at all fails) | trimmed only on an axis with a cut side, only when the other axis is cut on both ends and fills the canvas, and at most a third (spec 05 `CUT_FILL_MAX_TRIM`, stated independently as `MAX_TRIM_SHARE`) |
| `no_line_<side>` | nothing beyond the cut side is drawn (regions of 12 px or more, delta > 12), and at most 1% of the half-coverage silhouette's last 12 rows or columns before the cut are a gap: canvas background (delta <= 8) where the source resampled there is something else (delta > 24), so a white shoe or the photo's own white corner is not a gap (no gap, no floating line) |
| `flagged` | the output carries the information flag `cut_in_source` |
| `not_held` | status is not `needs_attention` or `failed` |

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
is `attention.expected`'s call) and it is left out of the verified and link counts. Counts: planned
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
