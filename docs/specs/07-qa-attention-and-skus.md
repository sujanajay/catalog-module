# 07 QA, attention and SKU ids

Catalog module, spec 07 of 09. Execute with `docs/specs/00-execution-protocol.md`. Source of
truth: `docs/SPEC.md`. Depends on 06: the pipeline, the publish stage, the batch page, the
attention tab shell, the product and brand pages and the routes named here exist after 06. Visual
contract: `01-ui-prototype.md` v2, the sections for the attention tab (product cards, the three
buttons, toasts, resolved card), the Replace modal, the "Add Opptra SKU ids" modal and the cost
line. `CONTRACTS.md` names win over any older draft.

Contracts from earlier specs used here and not redefined:
- Defined in 02: `OUTPUT_FLAGS`, `DECISIONS` (`use_as_is | remove | replaced`), `QA_MODES`,
  `POLICY_SOURCES`, `EVAL_LABELS`, `PRODUCT_TYPES`, `ResolvedPolicy`, `BatchOptions.policy |
  qaCapUsd | evalSet`, `BatchCounts`, `BatchCost`, `flagReason`; the tables `model_policy`,
  `catalog_eval_labels`, `catalog_chunks.stage = qa`, `catalog_chunks.source_image_ids`,
  `catalog_source_images.replaces_id | is_current | superseded_at`, `catalog_outputs.decision |
  decided_by | decided_at | qa_scores | qa_model`, `catalog_product_aliases`,
  `catalog_product_events`, `sku_map.source`, `spend_days` (no migration ships here);
  `normalizeKey`, `publicObjectPath`, `uploadPath`, `productPrefix`; `signedPutUrl`,
  `setCustomTime`, `deletePublicObject`; `enqueueTask`; `parseManualMapping`, `resolveSkus`;
  `recordCost`, `checkCaps`, `dailyCapFromEnv`; `callLlmJson`, `imageParts`, `textPart`,
  `LlmResponseError`, `LlmJsonError`, `LLM_MAX_TOKENS`, `chatCompletion` (`packages/core/src/llm/`).
- Defined in 03: `requireRole`, `currentUser`, `ForbiddenError` and its sentence.
- Defined in 04: `readSheetTable`.
- Defined in 05: `MattingClient.health()` (`models: [{ id, inputSize, target }]`, `default`), the
  per-model send size, the shadow rule and its flags (`no_shadow_source`, `shadow_synthesised`).
- Defined in 06: the chunk handler and its stage sequence, `publishProduct` and its gate,
  `planPublish`, `renderKey`, finalize and `report-v<k>.json`, `deriveBatchState`,
  `AttentionProduct`, `AttentionPhoto`, `GET /api/catalog/batches/[id]/attention`, the attention
  shell components, `SheetPreview`, the cost card, `deps.resolvePolicy` (placeholder replaced here),
  `estimateCost` stub (replaced here), `catalog.human.spec.ts` steps 1 to 6.

## 1. Goal

Every made image is looked at by a vision QA judge on its staged bytes before it goes live; images
that pass go straight to the sheet with no human step. Only products with a problem appear under
"Needs attention", grouped by product, showing only the problem photos, each with a plain-language
reason and three ways to fix it: "Use as is", "Remove this photo", "Replace photo N". Missing Opptra
SKU ids can be added from a mapping sheet without re-processing. The same screen can label a golden
set for 08. Every batch shows its cost in INR per style next to the agency reference INR 60.
Models are chosen automatically per brand and product type and never shown.

## 2. Scope

In scope
- QA judge with seven dimensions, thresholds, verdict rule and reasons; product-type classifier
  per product on shot 1; QA as the third chunk stage (`matte` -> `render` -> `qa`) before publish.
- `resolvePolicy` with the first default policy per product type written as `model_policy` rows
  with `source = "default"` (08's bake-off overwrites them); `qaMode` and sampling knobs.
- Spend attribution to `spend_days` engine `catalog_qa`; per-batch and daily caps.
- Attention tab actions and the decision scope rule; the Replace flow; the resolved card; toasts.
- "Add SKU ids" modal and route; aliases and manual `sku_map` rows.
- Eval-mode labelling into `catalog_eval_labels`.
- Cost line in INR; `estimateCost` for the wizard's step 4 line (06).
- Playwright steps 7 to 10; the tier 3 QA job `catalog-qa-check`.

Out of scope
- Choosing models from measurements, gates, the bake-off, `matte_target` tuning (08). The judge
  and matte models come from `model_policy` rows when they exist, else the defaults in 4.4.
- Load, tuning, hand-over docs (09).
No model name appears in any page, toast, API response or export; model ids live in
`model_policy`, `catalog_batches.options.policy`, `catalog_source_images.matte_model`,
`catalog_outputs.qa_model`, `catalog_eval_judgements.judge_model` and logs only.

## 3. Files

Add
- `packages/core/src/catalog/qa/judge.ts` `judgeOutput`, `normalizeScores`, `verdictFor`.
- `packages/core/src/catalog/qa/templates.ts` `CATALOG_QA_TEMPLATE`, `PRODUCT_TYPE_TEMPLATE`
  (code constants rendered with a small `renderTemplate(template, vars)`; not editable in the UI).
- `packages/core/src/catalog/qa/reasons.ts` flag and dimension to sentence mapping,
  `problemLine`, `shortClause`.
- `packages/core/src/catalog/qa/classify.ts` `classifyProductType`.
- `packages/core/src/catalog/qa/policy.ts` `resolvePolicy`, `ensureDefaultPolicies`,
  `DEFAULT_POLICIES`, `strictestChannel`.
- `packages/core/src/catalog/qa/caps.ts` `checkCatalogCaps`.
- `packages/core/src/catalog/qa/*.test.ts`.
- `packages/core/src/catalog/attention.ts` `listAttention` (builds `AttentionProduct[]` for 06's
  route with this spec's reasons and problem lines).
- `packages/core/src/catalog/decisions.ts` `applyDecision`, `decisionScope`, `startReplacement`,
  `completeReplacement`, `applySkuMap` (pure DB functions used by the web routes).
- `packages/core/src/catalog/cost.ts` `costLine`, `estimateCost`.
- `apps/worker/src/catalog/qa-stage.ts` chunk stage `qa`.
- `apps/web/app/api/catalog/outputs/[id]/decision/route.ts`
- `apps/web/app/api/catalog/outputs/[id]/replacement/route.ts` and `.../replacement/complete/route.ts`
- `apps/web/app/api/catalog/batches/[id]/sku-map/route.ts`
- `apps/web/app/api/catalog/batches/[id]/eval-labels/route.ts` (`GET`, `POST`)
- `apps/web/components/catalog/AttentionList.tsx` and `AttentionProductCard.tsx` (replace 06's
  shells), `ReplaceModal.tsx`, `SkuMapModal.tsx`, `EvalLabelBar.tsx`, `CostLine.tsx`.
- `apps/web/lib/catalog/decisions.ts`, `sku-map.ts`, `eval.ts`, `cost.ts`.
- `apps/worker/src/catalog-qa-check.ts` (new esbuild entry) and `infra/catalog-qa-check.sh`: the
  tier 3 live QA run as Cloud Run job `catalog-qa-check` (section 7).

Change
- `apps/worker/src/catalog/chunk.ts`: stage sequence `matte` -> `render` -> `qa`; the classifier
  at the start of `matte` for products without `product_type`; per-product policy.
- `apps/worker/src/catalog/deps.ts`: real `resolvePolicy`, OpenRouter `fetch`.
- `apps/worker/src/catalog/publish.ts` (06): the gate counts decisions (5).
- `apps/worker/src/catalog/finalize.ts` (06): cost fields `qaUsd`, `qaCalls`, `identifiers`,
  `usdPerIdentifier`, `inrPerIdentifier`; the banner sentence for `qa_cap`.
- `packages/core/src/catalog/pipeline/status.ts` (06): "Quality check running" line.
- `apps/web/components/catalog/SheetPreview.tsx`: enable "Add SKU ids".
- `apps/web/app/catalog/[id]/page.tsx`: cost line card; eval mode.
- `apps/web/components/catalog/WizardStep4.tsx` (06): the estimate line reads `estimateCost`.
- `apps/web/test/human/catalog.human.spec.ts`: steps 7 to 10.
- `infra/deploy.sh`: `CATALOG_QA_DEFAULT_MODEL`, `DAILY_SPEND_CAP_USD`, `INR_PER_USD`,
  `OPENROUTER_API_KEY` secret mount for the worker.
No schema change. If a column is missing the manager stops and reports a contract change (00).

## 4. Contracts

### 4.0 Judge v2 amendment (supersedes the conflicting lines of 4.1, 4.2 and 4.4)

Live batch b489e466 held two of 12 products wrongly or inconsistently: a sole view flagged
`different_product` against the side view, and one real shadow-block defect held on Centrepoint
only while six other channels passed (the mean of all scores, and `placement_ok` asked of a judge
that cannot see the other angles). The judge now works like this:

- Prompt (`CATALOG_QA_TEMPLATE`): image 1 is the source photo, image 2 the output rendered from it,
  image 3 photo 1 of the same product id for reference; the product type is given. The judge names
  the `view` first (front, side, back, sole, top, inside, detail, on-model, flat), is told that other
  angles, soles, insides, close-ups and on-model shots of the same item are expected, and answers
  `wrong_item` true only for a clearly different item (another category, or a colourway or design
  no angle explains), false when unsure. It scores `complete_product`, `no_text_or_watermark`,
  `orientation_ok` and `is_collage` on image 1 and `edge_quality`, `background_clean` on image 2
  against image 1, with one `evidence` sentence per failing check. Placement is not asked; code
  checks it exactly (05). Reply keys: `view`, `wrong_item`, the five scores, `is_collage`, `evidence`.
- Verdict (`judge.ts`): every dimension against its own line from the policy, no mean
  (`dimensionThresholds`: output dimensions use `threshold`, photo dimensions and `same_product`
  use `floor`). `same_product` is 0 only when `wrong_item` is confirmed by `policy.qaModelSecond`
  (asked only when the first judge says `wrong_item`); otherwise 100. `overall` is the weakest
  dimension and informational only.
- QA stage (`qa-stage.ts`): photo dimensions apply to every channel of the photo. When an output
  dimension fails on the judged channel, the photo's other channels are re-checked and every channel
  takes the strictest score, so one defect gives one consistent result.
- Automatic actions (`qa/triage.ts` `triageProduct`). Hard holds: a different item confirmed by
  both judges, a collage, a corrupt file, photo 1 with a problem, every photo of a channel with a
  problem. Also held because no verdict exists or the image cannot go live: `qa_cap`,
  `qa_unavailable`, and an image not made or failing the channel rules when it cannot be dropped.
  Any other problem: dropped with a note (status `skipped`, reason ends "Left out automatically
  because this product has enough other good photos.") when the photo is not photo 1 and at least
  two good photos remain on that channel, else kept with a note (status `staged`, "Kept with this
  note because this product has too few other good photos."). Note-only information flags since
  v2: `complete_product` and `transparent`, besides `low_resolution` and the 4.6 list
  (`INFORMATION_FLAGS`, shared by attention, decisions and triage). No flag was added.
- Re-render extension point: `CatalogDeps.repairOwnDefects` (`RepairOwnDefects` in `qa/triage.ts`)
  is called once per product after judging and before triage with every undecided output carrying
  `halo` or `leftover_background`; it re-renders and re-judges, writes the rows, and the stage
  re-reads them, so a fixed output counts as good. Absent, nothing is repaired.
- Report: every judged output in `report-v<k>.json` carries `qa` (scores, thresholds, view, evidence
  with the model that gave each sentence, every judgement including re-checks and the second
  opinion, `autoAction`, `holdCause`, `finalStatus`), and the batch carries `qa.attentionRate`
  (held products over products, target 0). Model ids stay out of operator copy.

### 4.1 Dimensions, thresholds, verdict, flags

Dimensions (0 to 100 each, coerced and clamped by `normalizeScores`; a missing dimension becomes 0
with a reason): `complete_product`, `same_product`, `edge_quality`, `background_clean`,
`no_text_or_watermark`, `orientation_ok`, `placement_ok`. `overall` is recomputed in code as the
equal-weight mean of the seven; the model's own overall is ignored.

Verdict (`pass | flag`, `verdictFor`): `pass` when `overall >= threshold` and `complete_product >=
floor` and `same_product >= floor`; otherwise `flag`. The two floors exist because a cut-off
product or a different product is wrong whatever the rest looks like. `threshold` and `floor` come
from the resolved policy; the built-in values are `QA_DEFAULT_THRESHOLD = 75` and `QA_DEFAULT_FLOOR
= 60` (builder constants named in `judge.ts`; 08 tunes them per brand and product type).

Flag mapping to `OUTPUT_FLAGS` for each dimension under the threshold: `complete_product` ->
`complete_product`, `same_product` -> `different_product`, `edge_quality` -> `halo`,
`background_clean` -> `leftover_background`, `no_text_or_watermark` -> `text_or_watermark`,
`orientation_ok` -> `orientation`, `placement_ok` -> `placement`; the judge's `is_collage: true`
adds `collage`. A `flag` verdict sets the output `needs_attention` with `reason` = the first
sentence of 4.6 (lowest dimension first) and the flags above; `pass` leaves the output `staged`.
Flags from 05 and 06 keep their own sentences (4.6).

### 4.2 Judge call (`judgeOutput`)

`judgeOutput(input, deps) -> { scores, verdict, reasons, isCollage, usage, costUsd, model }` where
input is `{ output: Buffer, original: Buffer, shotOne?: Buffer, channel, anchor: "centre" |
"bottom-centre", productType, identifier, n, model, threshold, floor }`. The output bytes are the
staged object (never the public one). Messages: system = rendered `CATALOG_QA_TEMPLATE`; user =
`textPart("Image 1: the original photo")`, image, `textPart("Image 2: the image we made for
<Channel label>")`, image, and when `n > 1` `textPart("Image 3: photo 1 of the same product
(<identifier>)")`, image, then the instruction to return only the JSON object. Images are sent at
1536 px on the long side as data URLs through `imageParts`. Call through `callLlmJson(messages,
validate, { temperature: 0, maxTokens: LLM_MAX_TOKENS, model }, deps)` (OpenRouter chat
completions with image parts and `usage.cost`; confirmed in current docs; builders re-confirm before
coding). The validator requires at least one numeric dimension. `costUsd` is `usage.cost` when
present, else `QA_USD_PER_CHECK_ESTIMATE` with a log line (never 0 for a billed completion;
`qaCallCost` in `cost.ts`). A thrown `LlmResponseError` or `LlmJsonError` after the built-in
retry marks the output `needs_attention` with flag `qa_unavailable` and its sentence; it never
fails the batch. Cost per check is about USD 0.0004 (Flash-Lite, Haiku 5.5, Qwen 30B-A3B) to
0.0013 (2.5 Flash, 3.5 Flash-Lite).

`CATALOG_QA_TEMPLATE` tells the judge, in this order: the product pixels were copied, never
redrawn, so it judges cut-out quality and composition, not photo quality; the seven dimensions with
one line each (complete_product: no part of the product or model is cut by the frame; same_product:
image 2 shows the same product as image 1 and, when present, image 3; edge_quality: clean edges, no
halo, no eroded fringe, no missing straps, laces, mesh or hair; background_clean: only the flat
background colour remains, no leftover scene, props or stray shadow blobs; no_text_or_watermark:
no text, logo overlay, watermark or several photos in one, including small AI-tool marks such as a
sparkle or star icon in a corner; orientation_ok: upright as a shopper expects; placement_ok: the
product sits where `<anchor>` says, with the same placement as other angles); the JSON shape
`{complete_product, same_product, edge_quality, background_clean, no_text_or_watermark,
orientation_ok, placement_ok, is_collage: boolean, reasons: string[]}` (`is_collage` is a flag, not
a score); and that `reasons` must be short plain sentences a non-technical person understands, one
per failing dimension, naming the thing seen ("the model's hand", "a logo in the corner").

### 4.3 Product-type classifier (`classifyProductType`)

`classifyProductType(image, deps) -> { type, confidence, usage, costUsd }` with `type` in
`footwear | apparel_model | apparel_flat | bag_accessory | other` (`PRODUCT_TYPES` without
`auto`); `PRODUCT_TYPE_TEMPLATE` describes them as footwear, apparel on a model, apparel laid
flat, bag or accessory, other. Same `callLlmJson` pattern, temperature 0, the cheapest judge
(`CATALOG_QA_DEFAULT_MODEL`, 4.4). Runs once per product at the start of the `matte` stage on shot
1 (lowest `n`) when `catalog_batches.product_type = "auto"` and `catalog_products.product_type` is
empty; a forced batch type is copied to every product; a product that already has a type keeps it.
The result drives the per-product policy (4.4) and 05's render options (shadow rule, detail-shot
heuristics). A failed classification stores `other` with flag `type_unknown` and the report lists
it; the operator can start a new batch with the type chosen by hand. Unknown labels map to `other`.

### 4.4 Policy and defaults (`policy.ts`)

`resolvePolicy(db, brandSlug, category) -> ResolvedPolicy` looks up `model_policy` rows in this
order: (brand, category), (brand, `*`), (`*`, category), (`*`, `*`), then the built-in table below
with `source = "default"`. `category` is the product type from 4.3; `*` is the batch-level call 06
makes before types are known. The first time a batch starts for a category with no (`*`, category)
row, `ensureDefaultPolicies(db, health)` inserts the built-in row for that category with
`source = "default"` (check-then-insert; 08's bake-off overwrites these rows with `source =
"bakeoff"`). The built-in table (`DEFAULT_POLICIES`; model ids are engineering text):

| Product type | Matte (first) | Matte (second) | Shadow mode | Judge (first, second) |
|---|---|---|---|---|
| footwear | `birefnet-general` | `bria-rmbg` | preserve else synthesise (upright) | `google/gemini-2.5-flash-lite`, `anthropic/claude-haiku-5.5` |
| apparel_model | `birefnet-hr-matting` | `birefnet-dynamic-matting` | preserve only | same |
| apparel_flat | `bria-rmbg` | `birefnet-general` | preserve only | same |
| bag_accessory | `birefnet-general` | `birefnet-hr-matting` | preserve else synthesise (upright) | same |
| other | `bria-rmbg` | `birefnet-dynamic-matting` | preserve else synthesise (upright); glass and transparent packaging routed to `birefnet-hr-matting` with flag `transparent` | same |

Columns: `matte_model` = first matte, `qa_model` = first judge, `threshold` 75, `floor` 60,
`qa_mode` `per_source`, `qa_sample_rate` 1, `matte_model_second` = second matte, `shadow_mode`
(`preserve_only | preserve_else_synthesise`), `qa_model_second` = second judge (columns defined in
02; `ResolvedPolicy` carries them as `matteModelSecond`, `shadowMode`, `qaModelSecond`). The send size is not stored: 05 reads it per model from the matting
service's `/health`. The second matte model is used when the first is not listed by any matting
service; the second judge when the first returns `qa_unavailable` twice in a row for a batch. When a
model in the row is not listed by `MattingClient.health()` on either service, the worker falls back
to the service's `default`, sets `counts.policyFallback = true` and logs it; nothing is shown to the
operator.

`qaMode`:
- `per_source` (default): judge one output per source image, the output for the strictest batch
  channel (`strictestChannel`: Styli if ticked, else the ticked channel with the largest target
  canvas, ties by `CHANNEL_ORDER`); the verdict, scores and reasons are copied to every channel's
  output of that source, except that a failing `placement_ok` flags only the judged channel's
  output.
- `per_output`: judge every output.
`qaSampleRate` below 1 judges that fraction of sources (deterministic hash of identifier) and copies
nothing to the rest; unjudged outputs get flag `qa_sampled_out` (information). It stays 1 until 08
lowers it for a (brand, category) with gate evidence.

The batch-level policy (06 5.2) stays on `options.policy` so a batch never changes judge midway;
the per-product policy is resolved once per product when its type is known and recorded through
`catalog_source_images.matte_model` and `catalog_outputs.qa_model`. `renderKey` (06) uses the
policy applied to that source. Nothing from any policy is rendered in the UI or written to any
export; the eval harness in 08 reads it from the database.

### 4.5 Spend and caps (`caps.ts`)

Every judge and classifier call records `recordCost(db, { brandSlug, batchId, engine:
"catalog_qa", costUsd })` and adds to `catalog_batches.cost.qaUsd`, `cost.qaCalls`,
`cost.qaPromptTokens` and `cost.qaCompletionTokens` (from OpenRouter's `usage`). Compute stays
on `catalog_compute` (06). `checkCatalogCaps(db, { batchId, env, now })` mirrors `checkCaps`: the
daily cap is `DAILY_SPEND_CAP_USD` (default 10) over all engines and brands for the UTC day; the
per-batch cap is `catalog_batches.options.qaCapUsd` (null = none). When a cap is hit, QA for the
remaining sources of the batch is skipped, their outputs become `needs_attention` with flag `qa_cap`
and reason "Quality check paused: the spending limit was reached. Look at this image yourself, or
raise the limit and start a new batch.", the chunk still completes, and the batch banner adds "The
quality check stopped early because the spending limit was reached." Nothing is dropped silently.

### 4.6 Reasons (`reasons.ts`), v2 wording

Each flag has a bold "why" sentence and a "what to do" line. `<k>` is the number of batch channels,
`<channels>` their labels.

| Flag | Why (bold) | What to do |
|---|---|---|
| `complete_product` | "Part of the product or model looks cut at the frame edge in the original photo." | "We never crop, so the made image shows the same thing. "Use as is" keeps it; "Replace photo <n>" swaps the photo for all <k> marketplaces." |
| `different_product` | "This photo does not match photo 1 of the same identifier." | "If the file was named wrongly, remove it; the rest of the product is unaffected." |
| `halo` | "The edge of the product looks rough or shows a halo, often white on white." | "Compare the two images. The product itself is never redrawn; only the background changes. "Use as is" keeps it." |
| `leftover_background` | "Some of the original background is still visible around the product." | "Compare the two images. "Use as is" keeps it; "Replace photo <n>" swaps the photo." |
| `text_or_watermark` | "The photo carries text, a watermark or a logo overlay. Marketplaces reject these." | "Remove it, or replace it with a clean photo." |
| `collage` | "This image combines several photos in one. Marketplaces reject these." | "Remove it, or replace it with the single photos." |
| `orientation` | "The product looks rotated or upside down." | "If the original is like this, replace it with a corrected photo." |
| `placement` | "On Styli the product does not sit at the bottom centre inside the guides like the other angles." | "Check the other angles of this product. This affects Styli only; "Remove this photo" removes it for Styli, "Replace photo <n>" swaps the photo." |
| `low_resolution` (information) | "The original is <w> x <h>. <Channel> wants at least <min> px, so this one may look soft." | "It will upload, but ask the brand for a larger photo if you can. The other marketplaces are fine with it." |
| `small_source` | "The original is only <w> x <h>, under 500 px on its long side." | "It is too small to look good anywhere. Remove it or replace it with a larger photo." |
| `failed` output (corrupt or render error) | "The file is corrupt and could not be decoded." (or the stored error sentence) | "Nothing was made for any marketplace from this photo. Remove it or replace it." |
| `failed_compliance` | "The image we made did not meet <Channel>'s rules: <failures>." | "This should not happen. Remove it or replace it, and the technical team will look at the report." |
| `fallback_matte` | "The background was removed with the simple method because the cut-out service was unavailable." | "Check the edges. "Use as is" keeps it." |
| `transparent` | "This product looks transparent or glass; the cut-out may need a look." | "Compare the two images. "Use as is" keeps it." |
| `upscaled` (experiment only) | "This image was enlarged by an experimental step." | "Check logos, text and fabric texture against the original." |
| `qa_unavailable` | "The quality check could not read this image." | "Please look at it yourself. "Use as is" keeps it." |
| `qa_cap` | "Quality check paused: the spending limit was reached." | "Look at this image yourself, or raise the limit and start a new batch." |
| `type_unknown` (product, Details tab) | "We could not tell what kind of product this is, so the general treatment was used." | "If the images look wrong, start a new batch with the product type chosen by hand." |

Information flags (`low_resolution`, `no_shadow_source`, `shadow_synthesised`, `passthrough`,
`alpha_source`, `qa_sampled_out`) never hold the publish gate and never create an attention item
on their own; their sentences go to the sheet `notes` ("<Channel> img <n>: <sentence>"), the report
and the product page, and appear on an attention card only when the same photo has another
problem. Styli outputs skipped under `STYLI_SKIP_LOW_RESOLUTION` carry 05's note "Skipped for
Styli: the photo is smaller than Styli needs." and need no decision. All sentences go to the
attention card, `report-v<k>.json` and the sheet's `notes`.

Problem line (`problemLine(photos)`): one clause per problem photo, "Photo <n>: <clause>" when the
judge returned a reason sentence for that dimension (its sentence, lower-cased first letter, so
"Photo 2: the model's hand looks cut at the frame edge."), else "Photo <n> <short clause>" from
`shortClause(flag)`: `complete_product` "looks cut at the frame edge"; `different_product` "looks
like a different product from the others"; corrupt or failed "could not be read"; `low_resolution`
"is too small for <Channel>"; `text_or_watermark` "carries text or a watermark"; `collage`
"combines several photos"; `halo` "has a rough edge"; `leftover_background` "still shows some
background"; `orientation` "looks rotated"; `placement` "sits differently from the other angles on
Styli"; `fallback_matte` "was cut out with the simple method"; `transparent` "looks transparent or
glass"; `qa_unavailable` "could not be checked"; `qa_cap` "was not checked because the spending
limit was reached"; `failed_compliance` "did not meet <Channel>'s rules". Clauses are joined with
"; " and the line ends with ".", giving the v2 lines "Photo 4 is too small for Styli; photo 5 could
not be read." and "Photo 3 looks like a different product from the others."

### 4.7 Attention model and decisions

`listAttention(db, batchId)` returns 06's `AttentionProduct[]` for products of the batch with at
least one undecided output in `needs_attention` or `failed`, ordered by identifier. One
`AttentionPhoto` per problem: shot-level problems (every flag except `placement`,
`failed_compliance` and `low_resolution`) produce one photo per shot, showing the judged channel's
output as "made for <Channel>" (or "Could not be made"); channel-specific problems produce one
photo per (shot, channel). `why` and `whatToDo` from 4.6, `problemLine` from the photos,
`liveObjectExists` true when a live output exists for that (product, channel, n) on any batch
channel. Decided photos are not listed; a product with no undecided photo is not listed, and the
tab label "Needs attention (N products)" counts the listed products.

`POST /api/catalog/outputs/[id]/decision` (operator) body `{ decision: "use_as_is" | "remove" }`:
- Scope rule (`decisionScope`): a decision on a photo applies to that photo's outputs on every
  channel of the batch, except channel-specific flags (placement on Styli, `failed_compliance`,
  the Styli low-resolution skip), which apply to that channel's output only. Concretely: if the
  output's flags are all channel-specific, the scope is that output; otherwise the scope is every
  undecided `needs_attention` or `failed` output of the same source image in this batch. The
  response lists the output ids affected.
- `use_as_is`: each output in scope gets `decision = use_as_is`, `decided_by` = the signed-in
  email, `decided_at`, status `staged` (eligible for publish; flags and reason kept, the sheet note
  becomes "kept as is by <email>: <sentence>"). A `failed` output cannot be used as is (400 "Nothing
  was made from this photo. Remove it or replace it."). Toast "Kept in the sheet".
- `remove`: each output in scope gets `decision = remove`, status `skipped`, reason "Removed by
  <email>"; event `removed_photo` on the product with the shot and channels. When
  `liveObjectExists`, the card shows "This removes the live image for this photo on <channels>."
  with "Remove anyway" and Cancel before the call, and publish deletes the live object on the
  batch's channels (06 `planPublish` includes `remove` decisions in its delete list; scoped by
  `deletePublicObject`). Toast "Removed. The sheet cell is empty with a note."
- Only outputs in `needs_attention` or `failed` without a decision accept one; a second call
  answers 409 "Already decided."
- After writing, the route enqueues `/tasks/catalog/publish` for the product (`trigger` = the
  decision id) and, through publish, finalize; `counts.needsAttention` and `attentionProducts` are
  recomputed by finalize. The card row dims and its buttons disable at once; when the product has
  no undecided photo left the card becomes the resolved card: pill "Resolved", identifier, "Sheet
  updated." and the tab count drops. Viewers never see the buttons; the route answers 403 with the
  03 sentence.

### 4.8 Replacement flow

"Replace photo <n>" is a one-shot overwrite of one shot of one product across the batch's channels.
- `POST /api/catalog/outputs/[id]/replacement` (operator) body `{ name, size, mime }` returns one
  signed PUT URL (`signedPutUrl`, default TTL) under `uploadPath(prefix, "replacements-<uuid>",
  name)`; the modal PUTs the file directly.
- `POST .../replacement/complete` (`completeReplacement`): `headObject` confirms the object; a new
  `catalog_source_images` row is inserted for the same `product_id` and `n` with `replaces_id` = the
  current source id, `sha256`, `is_current = false` until the shot publishes (06 step 8 then makes
  it current, sets `superseded_at` on the old version and `setCustomTime` on its raw object),
  `batch_id` = this batch, raw copied to `rawPath`; every output of the old source in this batch
  gets `decision = replaced`, status
  `skipped`, reason "Replaced by a new photo"; event `replacement_uploaded` (actor = the email,
  details: n, old and new sha256); a chunk is created with `product_ids = [product]`,
  `source_image_ids = [new source]`, stage `matte`, and enqueued.
- The one-source chunk runs `matte` -> `render` -> `qa` like any other, then publish for that
  product: the new outputs are copied with `ifGenerationMatch` = the live generation of that (shot,
  channel), verified, and set live; the product's other outputs are already live and are not
  touched (same URLs, new generations for this shot only); on publish the old outputs are
  superseded, event `overwritten`, `change = updated`. If the product was still held, the gate
  re-evaluates with the new outputs.
- Channels the product has live from earlier batches but which this batch did not select are not
  re-rendered; the report's `notRefreshedChannels` says so, so the operator can run those channels
  in a new batch if they want the replacement there too.
- Modal copy (v2): title "Replace photo <n> of <identifier>", help "Drop the new photo. We will make
  it for <channels> again and update the sheet. Nothing else changes.", drop zone "Drop one photo"
  showing the expected file name `<identifier>_<n>.jpg`, buttons Cancel and Upload, toast
  "Replacement queued. Usually done in a minute." The card row shows "Replacement in progress" until
  the new outputs are terminal; then it resolves or shows the new problem.

### 4.9 Add SKU ids

Modal (Links sheet tab, operator): title "Add Opptra SKU ids", help "Upload a sheet with two
columns: identifier and opptra_sku_id. We fill the gaps and make a new links sheet. Nothing is
re-processed.", drop zone "Drop the mapping sheet (xlsx or csv)", the information line "<n>
identifiers have no Opptra SKU id yet in this batch." (plain help text, not a warning style),
buttons Cancel and Apply, toast "<n> ids added. New links sheet ready."

`POST /api/catalog/batches/[id]/sku-map` (operator; multipart, one xlsx or csv read with
`readSheetTable`, rows through `parseManualMapping`):
- Columns detected by header after normalisation: identifier (`identifier`, `option`, `style`,
  `option_id_style_color`, `sku` accepted as the key heading) and `opptra_sku_id` (`opptra_sku_id`,
  `product_code`, `unicommerce`); one id per row or several `;`-separated.
- Keys through `normalizeKey`; a row matches a product of this batch when its key equals a
  `catalog_product_aliases.alias_key` of the batch's brand.
- For each matched product: append new ids to `opptra_sku_ids` (deduplicated); insert an alias
  with `kind = opptra_sku` for every new id (event `alias_added` per alias) and one `sku_ids_added`
  event per product (actor = the email, details: the ids).
- Upsert `sku_map` rows with `opptra_sku` = the id, `source = "manual"`, `brand_slug`, `brand` =
  the batch's `brand_name`, `line` from `brand_master`, `option_key` = the normalised identifier,
  so future batches resolve it automatically; 02's sync overwrites such a row when the warehouse
  later carries the same SKU.
- Response `{ added, matched, unmatched: string[] }`; the modal lists "<n> rows did not match any
  identifier in this batch: <list>".
- Enqueues finalize at once; `counts.skuResolved` recomputed; the Links sheet tab shows "New links
  sheet ready" with the new `links-v<k>` download once finalize finishes. Nothing moves in storage
  and no link changes.

### 4.10 Eval mode and labels

A batch with `options.evalSet` set (created by 08's `catalog-eval`, always `is_test = true`) shows
the attention tab in eval mode: every output is listed (paged, 50 per page, filters by channel and
by verdict), each card has "Pass" and "Flag" plus reason chips "Cut off", "Different product",
"Edge", "Background", "Text or watermark", "Rotated", "Placement" and a free-text note. Clicking
writes a row to `catalog_eval_labels` (`batch_id`, `output_id`, `source_image_id`, `set_name` =
`options.evalSet`, `identifier`, `channel`, `labeler` = the signed-in email, `label` `pass|flag`,
`reasons`, `note`, `judge_verdict`, `judge_scores`). Labels never change output status, the publish
gate or the sheet. `POST /api/catalog/batches/[id]/eval-labels` body `{ outputId, label, reasons,
note }` (operator); `GET` returns the batch's labels as JSON for 08's harness (operator). The
operator labels the Styli and Noon sets through this screen; the product owner labels the rest.

### 4.11 Cost line and estimate (`cost.ts`)

`costLine(batch, env)`: `usd = cost.qaUsd + cost.computeUsd`; `identifiers` = products of the batch
whose `change` is not `unchanged` and that have at least one output not `skipped` (unchanged
products cost nothing and are excluded from the denominator); `usdPerIdentifier = usd /
identifiers`; `inrPerIdentifier = usdPerIdentifier * INR_PER_USD`. Display on the batch page card
"Cost so far": "INR <x> per style so far · INR <y> for this batch · agency reference INR 60 per
style" (INR two decimals, USD four, so a sub-cent spend never reads 0.00; `inrAmount`, `usdAmount`). When
`INR_PER_USD` is not set: "USD <x> per style so far · USD <y> for this batch · Cost in rupees is not
configured yet · agency reference INR 60 per style". Finalize writes `cost.identifiers`, `cost.usdPerIdentifier`,
`cost.inrPerIdentifier` into the batch and the report. The product page shows the lifetime sum
across batches (06 page; data from `spend_days` by `batch_id`). The brand page shows the brand's
total from `spend_days` by `brand_slug`.

`estimateCost(counts, env) -> { usd, inr, images, qaChecks } | null` for 06's step 4 line: `images`
= outputs planned (photos times channels minus Styli skips minus unchanged pairs); `qaChecks` =
sources (per_source) or outputs (per_output) times `qaSampleRate`, plus one classifier call per
product without a type; `usd = qaChecks * QA_USD_PER_CHECK_ESTIMATE + images *
COMPUTE_SECONDS_PER_OUTPUT_ESTIMATE * 2 * COMPUTE_USD_PER_VCPU_SECOND` (the two estimate
constants are builder constants, start at 0.0013 and 1.5 s, tuned by 09's load test); `inr = usd *
INR_PER_USD`; returns null when `INR_PER_USD` is unset. Rendered as "Estimated cost: about INR <x>
(<n> images, <m> quality checks)".

### 4.12 Env vars added by this spec (CONTRACTS section 13)

- `OPENROUTER_API_KEY` (secret `openrouter-api-key`), worker and jobs.
- `CATALOG_QA_DEFAULT_MODEL` default `google/gemini-2.5-flash-lite` (worker); the second judge is
  `anthropic/claude-haiku-5.5` (in `DEFAULT_POLICIES`, not an env var).
- `DAILY_SPEND_CAP_USD` default `10` (worker).
- `INR_PER_USD` optional (web and worker); set by the operator in `infra/deploy.sh`.
- `LIVE_SMOKE` gates the live judge calls of the tier 3 job and the smoke.

## 5. Pipeline changes

Chunk stage sequence becomes `matte` -> `render` -> `qa` -> publish, one delivery per stage, same
idempotency as 06. The `qa` stage judges only outputs with status `staged` and `qa_scores` null,
reading the staged bytes (never the public object), checks caps before each call, and writes
`qa_scores`, `qa_model`, verdict, flags, reason and status per output (`per_source` copying per
4.4). Batch status is `qa` when every chunk is past `render` and at least one is in `qa`; a chunk
enqueues publish for its products after `qa`, not after `render`. `deriveBatchState` keeps the
processing banner through `qa` ("<made> of <m> images made" counts staged, flagged, failed and
skipped alike) and adds the second line "Quality check running" while status is `qa`.

The classifier runs at the start of `matte` for each product in the chunk that has no
`product_type`; its cost goes to `catalog_qa`. The per-product policy is then resolved and the
matte model chosen per product (4.4). The publish gate (06 5.5 step 2) counts decisions: an output
is decided when it is `staged` (QA pass or `use_as_is`), `skipped` (Styli skip, `remove`,
`replaced`), and undecided when it is `pending`, or `needs_attention` or `failed` without a
decision. Decisions and completed replacements enqueue publish for the product; finalize re-runs
after each publish that changed anything (`links-v<k>` increments). The attention route reads
`listAttention`.

## 6. Build order (subagent workstreams)

Worktrees `C:\Users\Sujan AH\Desktop\catalog-module-wt\07-<workstream>`. Context7 before use:
OpenRouter chat completions (image parts, `usage.cost`), Next.js multipart route handling,
Playwright file chooser and download APIs (call shapes confirmed in current docs; builders
re-confirm before coding).
- W1 judge, classifier, policy, caps (`07-qa`): `templates.ts`, `judge.ts`, `classify.ts`,
  `reasons.ts`, `policy.ts`, `caps.ts`, `cost.ts`, unit tests with a fake OpenRouter `fetch`.
- W2 worker QA stage and publish gate (`07-worker`): `qa-stage.ts`, `chunk.ts` sequence and
  classifier call, per-product policy, `publish.ts` gate, `finalize.ts` cost fields and the cap
  banner, `status.ts`, PGlite tests. Builds against W1's signatures (fixed in 4.2 to 4.5), not its
  implementation; a stub until merge.
- W3 attention, replacement and SKU web (`07-web`): `attention.ts`, `decisions.ts`, the routes,
  `AttentionList`, `AttentionProductCard`, `ReplaceModal`, `SkuMapModal`, `EvalLabelBar`,
  `CostLine`, the step 4 estimate wiring, route tests including the role checks.
- W4 tests (`07-tests`, after W1 to W3 merge): Playwright steps 7 to 10; `catalog-qa-check.ts` and
  `infra/catalog-qa-check.sh`; the no-model-name grep test extended.

## 7. Test plan

Tier 1 unit: `normalizeScores` (clamp, missing dimension to 0 with reason); `verdictFor` (overall
74 fails; overall 90 with `complete_product` 59 fails; 75/60/60 passes); dimension to flag mapping
and `is_collage`; `reasons.ts` returns one why and what-to-do pair per flag in the 4.6 wording and
`problemLine` reproduces the three v2 lines; `decisionScope` (shot-level flag -> every channel's
output of the source; `placement` -> the Styli output only); `per_source` copying (placement
failure flags only the judged channel); `strictestChannel`; sample-rate hashing deterministic;
`resolvePolicy` order and `ensureDefaultPolicies` writes one row per category once; `costLine` in
INR, the no-rate fallback and the exclusion of `unchanged` products; `estimateCost` arithmetic and
null without `INR_PER_USD`; SKU mapping key normalisation and `;` splitting; `classify` maps unknown
labels to `other`; the template contains the sparkle or star icon line.

Tier 2 integration (PGlite, fake OpenRouter via injected `fetch` returning canned JSON, fake
storage, fake session for roles): the `qa` stage judges once per source in `per_source` mode and
writes to every channel's output; a malformed judge reply triggers the built-in retry then
`qa_unavailable`; the daily cap hit mid-chunk yields `qa_cap` outputs, a finished chunk and the
banner sentence; `spend_days` has `catalog_qa` and `catalog_compute` rows keyed by `brand_slug` and
`batch_id`; `use_as_is` releases the publish gate and the product goes live on the next publish;
`remove` on a shot with a live object deletes that object at publish only on the batch's channels
and never another product's object or another channel (count `deletePublicObject` calls and their
paths); a replacement creates source version 2 with `replaces_id`, supersedes the old source,
skips the old outputs with `decision = replaced`, creates a one-source chunk, and re-publishes only
that shot (same object path, new generation, other shots' generations unchanged); SKU mapping adds
ids, aliases, manual `sku_map` rows, lists unmatched and bumps the export to `links-v<k+1>`; labels
are written and never change status or the sheet; every operator route in this spec answers 403
with the 03 sentence for a viewer and 200 for an operator.

Tier 3 live QA (`catalog-qa-check`, gated by `LIVE_SMOKE=1` exactly like the smoke; run as the
Cloud Run job `catalog-qa-check` from the worker image, created and executed by
`infra/catalog-qa-check.sh` with the OpenRouter secret mounted from Secret Manager): the Anta set
(630 images, 800x800) and 200 French Connection images from `new_resources_3\French Connection
Final` (800x1200 on white) plus the hard cases available (white on white, transparent PNG, 500 px,
collage, watermark, mixed product, a glass or transparent product) through Noon and Styli as
`catalog-test` batches; the job prints pass and flag counts per dimension, the cost (budget computed
from the count and the per-model price read from the OpenRouter endpoint listing, enforced before
each batch), and writes a contact-sheet HTML of every flagged output next to its original for a
human look under `catalog-test/qa-check/<run>/`; cleanup deletes the test objects and rows.
Supabase links read only.

Tier 4 human-like browser test, steps 7 to 10 added to `catalog.human.spec.ts` (same login state
and video as 06): 7 open "Needs attention", click "Use as is" on the first photo, expect toast
"Kept in the sheet" and, once the product has no undecided photo, the resolved card and the tab
count dropping by one; 8 click "Remove this photo" on the next photo (confirm "Remove anyway" when
the warning shows), expect "Removed. The sheet cell is empty with a note."; 9 open "Links sheet",
click "Add SKU ids", `locator.setInputFiles` a two-column csv for two identifiers, Apply, expect
"<n> ids added. New links sheet ready."; 10 `page.waitForEvent("download")` on "Download links
sheet (Excel)", `saveAs`, open with the 02 reader, assert the two identifiers carry their ids and
the removed cell is empty with its note in `notes`. Cleanup of the test batch at the end. Video
saved.

Tier 5 per-brand smoke: unchanged command (`pnpm catalog:smoke`). The QA stage runs with the judge
mocked (canned pass verdicts, outputs flagged `qa_sampled_out`) unless `LIVE_SMOKE=1`, in which
case the smoke runs as the `catalog-qa-check` job instead; the report shows the QA verdict per
output in both cases and says which mode ran.

CI gate: `pnpm lint && pnpm typecheck && pnpm test`.

## 8. Done criteria

- Every output in a finished batch has `qa_scores` or a `qa_*` flag explaining why not.
- The attention tab shows only products with a problem, grouped by product, only the problem
  photos, each with the bold why and the what-to-do line in the 4.6 wording; all three actions work
  on the deployed URL for an operator and are absent for a viewer; a decision updates the sheet
  within one publish and finalize cycle without a page reload.
- "Remove this photo" on a live shot warns first and the live object is gone on the batch's
  channels after publish; "Replace photo N" re-publishes that shot only at the same URL.
- "Add SKU ids" fills gaps, inserts aliases, produces `links-v<k+1>`, and manual rows appear in
  `sku_map` with `source = "manual"`.
- Eval mode writes labels; labels never alter the sheet.
- The batch page shows the INR per style line against INR 60; the wizard's step 4 shows the
  estimate line when `INR_PER_USD` is set.
- No model name in any page, API response, toast or export (grep test over rendered HTML and JSON
  for every candidate id and the substrings `gemini`, `claude`, `qwen`, `birefnet`, `rmbg`, `bria`,
  `inspyre`, `ben_custom`).
- Playwright steps 1 to 10 pass on the deployed URL.

## 9. Merge, deploy, report

Per `00-execution-protocol.md`: PR from `feat/catalog-07-qa-attention-and-skus`, gates, review and
simplify, merge, `bash infra/deploy.sh` (with `INR_PER_USD` set by the operator if known),
per-brand smoke, learnings if any, single report with the tier 3 pass and flag counts per
dimension, cost figures, Playwright video, exclusions, and "Ready for the next spec: 08 Model
bake-off and policy".
