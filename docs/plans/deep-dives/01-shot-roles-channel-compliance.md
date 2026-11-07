# DD1: Shot roles and channel compliance, all 9 channels x all softline brands

Date: 2026-10-22. Deep dive DD1 of the Catalog Connect GCC program (bucket B1, release V1). It builds on DD0 (`docs/plans/deep-dives/00-softline-taxonomy.md`).
Investigation only. Nothing here is built.

## Summary

1. Today the module tracks a photo's position (photo 1, 2, 3), not its role (front, back, close-up). No channel has a required shot list, an image count or a head-cut rule in code. A product with 1 photo, or with no Styli images at all, gets status "ok".
2. The low-resolution skip only happens on Styli. Before the upscaler went on, every one of 638 Styli outputs in 43 batches was skipped. When all of a product's Styli photos are skipped, the links sheet removes the Styli columns and only says so in "notes". That is the silent failure.
3. Since the x2 upscaler went on (5 batches, 39 Styli outputs), there have been 0 low-resolution skips. The other 8 channels never skip for size: they publish an enlarged image and the sheet does not say so.
4. Source sizes sampled from the warehouse (236 of 270 sampled images readable): 199 clear Styli with x2 (145 without) and 179 clear all 9 channels with x2 (105 without). 13 are under 500 px and are held. French Connection, Cardio Bunny and Nautica have the most small or broken image links.
5. The Penti photos uploaded so far are 800x1200, but the warehouse holds 1440x2160 copies of the same Penti products. So part of the small-photo problem is the files we are given, not the brand.
6. The QA judge already looks at every photo and names a "view". It can also name a role and whether the head is cut at no extra call, but no test measures how accurate it is today.
7. Public rules could be checked only for Amazon (style guide PDF) and Noon (help page). Namshi, Trendyol and Shein have only third-party sources; Centrepoint, 6thStreet, VogaCloset and Styli have nothing public. Amazon's guide asks for a crop between nose and upper lip, so the head-cut rule must be set per channel.
8. Recommendation: the judge assigns roles (DD0's 8 roles), each channel gets a required-role list, photos are put in the channel's order, and every ticked channel keeps its columns. A new status "incomplete" comes with plain-language notes on missing roles. The upscaler stays on everywhere, with a note where photos are still enlarged a lot.
9. Approval asked: the role taxonomy, the per-channel rules and the upscaler setting per channel.

## Findings

### F1. What the code encodes today, per channel (repo, source of truth for size, margins, background, DPI)

Source: `packages/core/src/catalog/channels.ts` (CHANNEL_RULES_VERSION "10"), `packages/core/src/catalog/compliance.ts`, `docs/SPEC.md` channel table (lines 160 to 175).

| Channel | Min canvas | Target canvas | Fixed | Margins | Anchor | Background | DPI |
|---|---|---|---|---|---|---|---|
| Amazon | 1000x1000 | 2000x2000 | no | none | centre | #E0E0E0, image 1 #FFFFFF | 300 |
| Noon | 660x900 | 1080x1480 | no | top 10%, bottom 10%, sides 5% only when wide | centre | #E0E0E0 | 72 |
| Namshi | 660x900 | 1080x1480 | no | top 10%, bottom 10% | centre | #E0E0E0 | 72 |
| Trendyol | 600x800 | 1200x1800 | yes | none | centre | #E0E0E0 | 96 |
| Styli | 2342x3123 | 2342x3123 | yes | 450 top, 450 bottom, 150 left, 150 right px | bottom-centre | #E0E0E0 | 300 |
| Centrepoint | 3000x3000 | 3000x3000 | yes | none | centre | #E0E0E0 | 300 |
| 6thStreet | 1200x1600 | 2000x2667 | no | none | centre | #E0E0E0 | 300 |
| VogaCloset | 1200x1600 | 2000x2667 | no | none | centre | #E0E0E0 | 300 |
| Shein | 1000x1000 | 2000x2000 | no | none | centre | #E0E0E0, image 1 #FFFFFF | 300 |

Every channel also has these rules in common:
- JPEG under 2 MB, sRGB with a colour profile, 4:4:4 sampling, lowercase `.jpg`, no spaces in the path.
- Enlargement is capped at `MAX_UPSCALE` = 1.5.
- Photos with a long side under `MIN_SOURCE_LONG_SIDE_PX` = 500 get `small_source` and are held (`ingest/image-check.ts`, `qa/triage.ts` RENDER_HOLD_FLAGS).

What happens to a small photo, from the code:
- `render.ts` `planCanvas`: `lowResolution` is true when the enlargement needed to fill the channel's smallest canvas is above 1.5.
- `render.ts` `renderSource`, around line 546: only Styli skips (`spec.id === "styli" && STYLI_SKIP_LOW_RESOLUTION`). The skip happens only when the enlargement left after the x2 upscaler is still above 1.5.
- Every other channel publishes the image with the information flag `low_resolution` and the "may look soft" sentence.
- `apps/worker/src/catalog/chunk.ts`, around line 147: the worker already skips Styli rows when they are created, on source height alone (`styliMinSourceHeightPx`: 1,482 px without the upscaler, 741 px with it).

Nowhere in the repo is there:
- an image count per channel;
- a required shot list or order;
- an on-model rule;
- a head-cut rule;
- a shot role.

Searched: `channels.ts`, `compliance.ts`, `types.ts`, `qa/*`, `sheet.ts`, `docs/SPEC.md`, `docs/specs/08-model-bakeoff-and-policy.md`. Output n always equals source n (`chunk.ts`, `publicObjectPath(..., source.n, ...)`), so a channel's image order is simply the upload order.

Head protection that does exist: `render.ts` `trimRules` sets `protectTop` for `apparel_model`. The render never trims the top of an on-model photo, so any head cut comes from the source photo, as the intent map (section 5) says.

### F2. Public channel rules, only for the four things the repo does not encode

All web sources were accessed on 2026-10-22. Login-only seller portals (Amazon .ae/.sa Seller Central help pages, Namshi, Trendyol partner, SHEIN Seller Hub) could not be read.

| Channel | Image count | Roles and order | On-model | Head cut | Source and status |
|---|---|---|---|---|---|
| Amazon (global clothing guide, not .ae/.sa specific) | 1 MAIN plus up to 8 alternates. Recommended "minimum of 5 and maximum 7" (summary slide says 4 to 7). Each colour needs its own MAIN | MAIN front, PT01 detail, PT02 back, PT03 styled, PT04/05 more detail. Front and back "mandatory". An off-figure alternate is recommended when the MAIN is on a model | Adult apparel MAIN on a standing model with shoes on (except swim and sleep). Kids items, multipacks and accessories (scarves, belts, hats, ties) off-figure. Kids underwear and swimwear never on kids | MAIN on-figure is cropped "between nose and upper lip". Full length for dresses and anything reaching the fingertips or lower; upper body for tops; waist down for trousers. The product itself must not be cut | "Selling Partner Style Guide: Clothing & Accessories", March 2022, https://m.media-amazon.com/images/G/65/SG3P/LISTING_GUIDES/Amazon_Fashion_Clothing_Image_Style_Guide.pdf (pages 5 to 41). Verified (primary). Footwear rules (single shoe facing left at 45 degrees): unverified, secondary only |
| Noon | "Minimum of 3 high-quality images" recommended; no maximum | Front, back, side, other angles, details, usage. The primary image is a front view with no packaging or swing tags and no multi-view. Lifestyle only as an additional image | Adult apparel recommended on a model, except swimwear and underwear. Kids apparel flat or on a hanger | Not addressed. Only "important parts of the product" must not be cropped | https://supportagent.noon.partners/portal/en/kb/articles/image-requirements-and-rejection-reasons-for-the-seller-sku-12-3-2024 (no page date; the URL carries 12-3-2024). Verified (primary) |
| Namshi | Not published | Secondary source: fashion front, back, side, detail and texture; footwear side, front, top, sole, detail | Secondary: model images recommended | Not published | https://streamoid.com/resources/guides/namshi-seller-guide. Unverified |
| Trendyol | Secondary: up to 8 recommended | Not published | Not published | Not published | https://birfatura.com/trendyol-urun-yukleme-nasil-yapilir-sartlari/. Unverified |
| Shein | Secondary: 1 cover plus 1 to 10 detail images | Not published | Secondary: models optional | Not published | https://www.upseller.com/es/blog-article-50 (2024-03-25). Unverified |
| Styli | 5 (owner's Styli / Landmark studio email, Raymond Lim) | 1 front cropped mid-thigh, 2 full length head to toe, 3 fabric close-up without model, 4 back cropped at the hips, 5 head and shoulders | Yes, same model and lighting, white or light grey | Body crops pass, head cuts fail | Owner's email (intent map section 2). Not public |
| Centrepoint | 5 with a model (meeting) | Same Landmark studio sequence as Styli (meeting) | Yes | As Styli | Meeting only. No public guide found |
| 6thStreet | Nothing public | Nothing public | Nothing public | Nothing public | None found |
| VogaCloset | Nothing public | Nothing public | Nothing public | Nothing public | None found (https://channelengine.com/en/marketplaces/vogacloset has no image rules) |

Sizes, margins, background and DPI are not re-checked here. The repo values in F1 are the internal truth; for the external check of each channel's published UAE and KSA requirements against `channels.ts` and `compliance.ts`, see 01a (`docs/plans/deep-dives/01a-channel-guidelines-external-vs-internal.md`).

### F3. Gaps between what the channels ask and what the code does

1. **Required roles.** No channel has a list of required roles (Styli and Centrepoint need 5 specific roles; Amazon needs front and back).
2. **Image counts.** No minimum or recommended count per channel. Noon recommends at least 3 and Amazon 5 to 7. A 1-photo product gets status "ok" everywhere.
3. **Order.** No order rule. Styli's order is fixed (FM, FL, FC, BH, HS), but outputs follow the upload order.
4. **Head cuts.** No head-cut check. The judge's `complete_product` score is about the product being cut at the frame edge. Its prompt says "an on-model shot that crops the model but shows the product, scores 100", so a head cut on an on-model photo scores 100 by design (`qa/templates.ts`).
5. **The head-cut rule differs by channel.** Styli fails a head cut; Amazon's MAIN expects a nose-to-upper-lip crop. One global rule would be wrong for one of them.
6. **On-model expectation.** No on-model rule per channel or category. DD0 F4 already found that `apparel_model` vs `apparel_flat` comes from photo 1 only.
7. **Silent column drop.** When no photo of the batch reaches a channel, `sheet.ts` `sheetColumns` gives that channel 0 columns and its columns disappear, while the row status stays "ok" (`SHEET_STATUSES` = ok, needs_attention, missing_images, not_in_sheet; none means "a ticked channel got fewer images than it needs"). Seen in batch 56bb7072, F4.
8. **Enlarged images are not in the sheet.** Images enlarged on non-Styli channels (`low_resolution`, an information flag in `qa/triage.ts`) are published and do not appear in the sheet notes. Batch 56bb7072 has 5 Centrepoint outputs flagged `low_resolution`; its notes mention only Styli.
9. **Two Styli size rules.** The worker's row-time skip uses source height. The render's skip uses the product box. An 800x1200 photo whose product fills only part of the frame passes the first test and can still be skipped by the second. The note is the same, so the operator sees no difference.
10. **Judge roles.** The judge's view names (front, side, back, sole, top, inside, detail, on-model, flat, chart) have no role names: no mid-thigh, full length, back at hips, head and shoulders or fabric close-up. "on-model" and "front" overlap. The view is stored in `catalog_outputs.qa_scores.view` (`apps/worker/src/catalog/qa-stage.ts` line 175). It is used only to drop size charts (`CHART_VIEW`). No spec 10 eval measures view accuracy (`packages/core/src/catalog/evals/` has no view expectation; `judge_false_same_product` only checks that a back or sole is not called a different product).
11. **Unjudged photos.** With `qaSampleRate` below 1, or when the spend cap is hit (`qa_cap`) or the judge is unavailable (`qa_unavailable`), a photo is never judged. Any role taken from the judge would then be missing without a reason.

### F4. Audit of skips and holds in batches to date (exact)

**Access.**
- **Cloud SQL ila-pg was not queried.** Its connection password exists only in Secret Manager, which the rules forbid reading.
- **Source used.** The batch reports and links sheets in GCS. Query shape: `gsutil ls gs://image-links-agent-assets/catalog/**/exports/*` and `catalog-test/**/exports/*/report-v*.json`.
- **Files read.** 5 operator batches in `catalog/` (15 files) and 43 test batches in `catalog-test/` (46 report files). Only each batch's latest export was counted (highest `counts.latestExport`).
- **Fields counted.** `products[].outputs[].{channel,status,reason}` per batch.
- **Not found.** The French Connection and Anta live batch the brief mentions is in neither prefix. Those brands exist only as spec 10 eval sets.

Operator batches (`catalog/` prefix, every batch to date):

| Batch | Brand | Last product change (UTC) | Channels | Products | Outputs | Styli skipped (low resolution) | Other skips | Held |
|---|---|---|---|---|---|---|---|---|
| 9591ba5e | Nuwey | 2026-10-20 15:14 | Noon, Styli, Centrepoint | 2 | 18 | 6 of 6 | 0 | 0 |
| 6b378318 | Keds | 2026-10-20 15:23 | Noon, Styli, Centrepoint | 2 | 18 | 6 of 6 | 0 | 0 |
| a29346ac | GTPlayer | 2026-10-20 17:58 | Noon, Styli, Centrepoint | 2 | 18 | 6 of 6 | 0 | 0 |
| 56bb7072 | Penti | 2026-10-21 13:39 | Noon, Styli, Centrepoint | 1 | 15 | 5 of 5 | 0 | 0 |
| 66392b5d | Campus | 2026-10-21 19:19 (upscaler on) | Noon, Styli, Centrepoint | 1 | 15 | 0 of 5 | 0 | 0 |

- **Totals:** 84 outputs, 23 Styli low-resolution skips and 0 holds.
- **Sources:** every one is 800x1200. Nuwey, Keds and GTPlayer carry the same identifiers (img_2, img_3), so 9 distinct photos by sha256 across the 5 batches.
- **What each sheet shows:**
  - **Nuwey, Keds and GTPlayer:** no Styli columns at all, status "ok", and the skip appears only in "notes" as "Styli img n: Skipped for Styli: the photo is smaller than Styli needs."
  - **Penti 56bb7072:** the same. It also has 5 Centrepoint outputs flagged `low_resolution`, which the sheet does not mention.

All 48 batches (operator plus test), split at deploy D4 (2026-10-21, upscaler on):

| Channel | Before upscaler on (43 batches, 5,729 outputs): verified / skipped / staged / held | Skip reasons | After (5 batches, 301 outputs): verified / skipped / staged / held | Skip reasons |
|---|---|---|---|---|
| Amazon | 568 / 15 / 32 / 10 | 14 size chart, 1 removed by operator | 21 / 4 / 4 / 0 | 4 size chart |
| Noon | 604 / 15 / 32 / 10 | 14 size chart, 1 removed by operator | 31 / 4 / 9 / 0 | 4 size chart |
| Namshi | 577 / 14 / 32 / 10 | 14 size chart | 21 / 4 / 4 / 0 | 4 size chart |
| Trendyol | 571 / 14 / 32 / 10 | 14 size chart | 21 / 4 / 4 / 0 | 4 size chart |
| Styli | 0 / 638 / 0 / 0 | 638 low resolution (100%) | 26 / 5 / 2 / 6 | 4 size chart, 1 failed compliance and dropped automatically |
| Centrepoint | 608 / 14 / 30 / 12 | 14 size chart | 31 / 4 / 9 / 0 | 4 size chart |
| 6thStreet | 571 / 14 / 32 / 10 | 14 size chart | 21 / 4 / 4 / 0 | 4 size chart |
| VogaCloset | 571 / 14 / 32 / 10 | 14 size chart | 21 / 4 / 4 / 0 | 4 size chart |
| Shein | 571 / 14 / 32 / 10 | 14 size chart | 21 / 4 / 4 / 0 | 4 size chart |

Low-resolution skips by brand (all before upscaler on): Test Brand 609, Nuwey 6, Keds 6, GTPlayer 6, Penti 5, Vero Moda 6 (a `catalog-test/` batch). Total 638.

Hold reasons before upscaler on (needs attention, the same 10 photos across 8 channels; Centrepoint has 2 more):

| Reason | Holds per channel |
|---|---|
| Different product from photo 1 | 5 |
| Background could not be removed | 3 |
| Product or model cut at the frame edge in the original | 1 |
| Rough edge or halo | 1 |
| Some original background still visible (Centrepoint only) | 2 |

After upscaler on, the only holds were 6 Styli outputs with `styli_anchor` (batch 29d25c7b 5 and 4a8c7912 1). PR #85 fixed them, and gate re-run 3j (3a7323c4) had 0 holds.

**What this shows:**
- The low-resolution skip affected only Styli and was total before the upscaler.
- No skip on any other channel ever came from resolution.
- No role or head rule ever held anything, because none exists.

Sources in these batches, from the batch reports' recorded raw sizes (112 distinct photos by sha256):

| Size | Photos |
|---|---|
| 800x1200 | 59 |
| 800x800 | 45 |
| 800x1096 | 7 |
| 800x1091 | 1 |

### F5. Source resolutions vs channel floors (exact on the stated sample)

How the warehouse sample was drawn (BigQuery):
- **Query shape:** `raw_gcc_dimensions.master_sl`, one `image_url` per option (`MIN(image_url)` grouped by upper-cased brand and `option_id_style_color`), then the first 30 options per brand by `FARM_FINGERPRINT(option)`.
- **Sample size:** 270 options (9 brands x 30).
- **Coverage:** master_sl carries exactly one image URL per SKU row (`MAX(ARRAY_LENGTH(SPLIT(image_url, ',')))` = 1), so this measures photo 1 only.
- **Measurement:** image dimensions read from the first bytes of each URL (JPEG SOF, PNG IHDR or WebP header). No images were stored.
- **Readable:** 236 of 270.
- **Unreadable (34):**
  - Nautica: 20 (18 URLs are literally "0", 1 returns 404, 1 is malformed);
  - French Connection: 9 ("0", "cancelled", a bare number, no host);
  - Cardio Bunny: 4 (the URL serves an HTML page);
  - Campus: 1 ("0").

Floor model, taken from `render.ts` `planCanvas` and `channels.ts`:
- **A photo clears a channel** when the enlargement needed to fit the safe box of the channel's smallest canvas is at most 1.5 (`MAX_UPSCALE`). With x2, a photo clears when the enlargement left after x2 is at most 1.5.
- **Styli uses the worker's exact rule:** height of at least 1,482 px, or 741 px with x2.
- **The whole photo is treated as the product box.** This is the best case, because a real product box is smaller than the frame. So these shares are upper bounds.

For a 2:3 portrait photo, the source height that clears each channel is:

| Channel | Safe box at smallest canvas | Height without upscaler | Height with x2 | Below the floor today |
|---|---|---|---|---|
| Amazon, Shein | 1000x1000 | 667 | 334 | Published, `low_resolution` information note |
| Noon, Namshi | 660x724 | 483 | 242 | Published, information note |
| Trendyol | 1200x1800 (fixed) | 1,200 | 600 | Published at 1200x1800, note |
| 6thStreet, VogaCloset | 1200x1600 | 1,067 | 534 | Published, information note |
| Styli | 2042x2223 (fixed) | 1,482 | 741 | Skipped |
| Centrepoint | 3000x3000 (fixed) | 2,000 | 1,000 | Published at 3000x3000, note |

In addition, every photo with a long side under 500 px is held on all channels (`small_source`).

Readable warehouse photos that clear each channel's floor. Each cell is "without upscaler / with x2". n is the number of readable photos.

| Brand | n | Amazon | Noon | Namshi | Trendyol | Styli | Centrepoint | 6thStreet | VogaCloset | Shein | All 9 | Under 500 px (held) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Campus | 29 | 26/29 | 29/29 | 29/29 | 26/29 | 24/26 | 2/26 | 26/29 | 26/29 | 26/29 | 2/26 | 1 |
| Cardio Bunny | 26 | 25/25 | 25/26 | 25/26 | 7/25 | 2/25 | 0/7 | 7/25 | 7/25 | 25/25 | 0/7 | 1 |
| French Connection | 21 | 10/14 | 14/17 | 14/17 | 6/12 | 6/6 | 3/6 | 6/14 | 6/14 | 10/14 | 3/6 | 7 |
| Keds | 30 | 28/28 | 28/28 | 28/28 | 28/28 | 28/28 | 28/28 | 28/28 | 28/28 | 28/28 | 28/28 | 2 |
| Nautica | 10 | 6/10 | 10/10 | 10/10 | 4/10 | 4/6 | 0/4 | 4/10 | 4/10 | 6/10 | 0/4 | 0 |
| Penti | 30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 0 |
| Puma | 30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 30/30 | 0 |
| USPA | 30 | 18/30 | 29/30 | 29/30 | 18/30 | 17/18 | 8/18 | 18/30 | 18/30 | 18/30 | 8/18 | 2 |
| Vero Moda | 30 | 30/30 | 30/30 | 30/30 | 4/30 | 4/30 | 4/30 | 4/30 | 4/30 | 30/30 | 4/30 | 0 |
| **Total** | **236** | **203/226** | **225/230** | **225/230** | **153/224** | **145/199** | **105/179** | **153/226** | **153/226** | **203/226** | **105/179** | **13** |

Typical sizes per brand (measured):

| Brand | Most common size | Count | Other sizes |
|---|---|---|---|
| Campus | 1500x1500 | 22 | |
| Cardio Bunny | 534x800 | 11 | 554x800 (5), 1280x905 (5) |
| French Connection | median height 599 px | | 187x250 (3), 95x149 (3), 1100x1500 (3) |
| Keds | 3000x3000 | 28 | 100x100 (2) |
| Nautica | 640x640 | 4 | 1080x1920 (3) |
| Penti | 1440x2160 or 1440x2158 | 25 | 3392x5056 (4) |
| Puma | 2000x2000 and 3000x3000 | 15 each | |
| USPA | 1200x1800 | 9 | 2000x3000 (4), 6240x3512 (4), five small landscape images under 620 px wide |
| Vero Moda | 768x1024 | 26 | |

Reading the numbers:
- **Brands that are fine:** Keds, Penti and Puma clear every channel without the upscaler, except the 2 Keds 100x100 thumbnails.
- **With x2:** Vero Moda (768x1024) goes from 4 to 30 on Styli and Trendyol, and from 4 to 30 on Centrepoint.
- **Brands that stay short even with x2:** Cardio Bunny (534x800) still misses Centrepoint, and Nautica's 640x640 images miss Styli and Centrepoint.
- **French Connection:** 7 of 21 readable photos are thumbnails under 500 px. This is the data problem behind "French Connection photos are too small".
- **Penti:** the 9 distinct Penti photos uploaded in operator batches are 800x1200, while master_sl's Penti images are 1440x2160. The same products exist at a size that clears every channel without the upscaler.
- **Limit of this sample:** only photo 1 per option. The other roles (back, close-up) are not in the warehouse.

### F6. What the existing judge could classify as a shot role

Repo:
- **`qa/templates.ts` `CATALOG_QA_TEMPLATE`:** the judge sees the source photo, the output, and photo 1 for reference. It returns `view` from 10 values and photo scores.
- **`qa/judge.ts`:** sends `qaImage` at up to 1536 px on the long side, which is enough to see a face, a hem and a fabric weave. It validates `view` against `VIEWS`.
- **`qa/classify.ts`:** classifies photo 1 only, into 6 product types. Confidence is ignored (DD0 F4).
- **`qa/policy.ts`:** the judge runs once per source photo (`qaMode` "per_source", `qaSampleRate` 1 by default). A second judge model already exists for back-off and second opinions.
- **`docs/specs/10-output-quality-evals.md`:** no golden expectation for view or role, so classification accuracy has never been measured.

What the judge could tell reliably and cheaply (reasoning from the prompt and the image it is given, not measured):

| Signal | Why it is likely reliable | Risk |
|---|---|---|
| On model vs no model (packshot, flat lay) | Already asked as "on-model" vs "flat"; obvious in the image | Mannequins and ghost mannequins |
| Front vs back | Already asked; faces and fastenings are visible | Back views with hair over the shoulders; plain tees |
| Close-up with no model (FC) | Already "detail"; texture fills the frame | Close-ups that still show part of the body |
| Head state: whole head, no head, head cut by the top edge | A face is the most salient object; code already detects a top cut (`cut_in_source`) | Hair cut above the hairline (see the rule below) |
| Crop level: head to toe, mid-thigh, hips, shoulders | Visible body landmarks | Long dresses and coats (DD0 open question 2) |
| Legs only, lifestyle scene | Visible | Lifestyle scenes are a non-uniform background and already hold for `leftover_background` |

### F7. Does the x2 upscaler clear Styli's floor with acceptable fidelity?

Evidence: `docs/specs/11-image-enhancement.md` sections 4.4 and 10; `docs/PROGRESS.md` rows "spec 11 image enhancement", "live check batch on D5" and "gate b1 re-run 3j on D6"; `docs/plans/2026-10-21-upscale-and-wait-copy-handoff.md`; `packages/core/src/catalog/upscale.ts`.

**Proven:**
1. Fidelity gate run `enh-20261020201359-43bfe5`. Each of 40 photos at 800x1200 was shrunk to 400x600 and restored x2, which is harder than real use. The x2 upscaler (spec 11 winner, `swinir-x2`) beat the Lanczos-plus-sharpening baseline on every measure:

   | Measure | x2 upscaler | Baseline |
   |---|---|---|
   | SSIM | 0.9318 | 0.8799 |
   | LPIPS stand-in | 0.0494 | 0.0780 |
   | Mean colour difference (dE) | 1.29 | 1.78 |
   | Halo | 2.69 | 5.68 |
   | Photos with texture flags | 22.5% | 60% |

   Text regions stayed within 0.007 SSIM. Results were deterministic, with 0 errors.
2. Live check batch a174ab4c: the five 800x1200 Penti photos on Styli. 15 of 15 made, 0 skipped. Outputs at 2342x3123 carry the "Enlarged with a quality pass to meet this marketplace's size." note. Visual judgement PASS: no halo, no colour shift, detail crisp, slight softness in the feet at about 1.9x.
3. Gate b1 re-run 3j (3a7323c4): 3 Penti products on 9 channels. 90 of 90 made outputs verified, 0 held, Styli filled for all 3 products, 59 outputs upscaled.
4. The two Styli size rules now agree on the threshold (`styliMinSourceHeightPx`, 741 px with x2).

**Not proven:**
1. **Absolute bars.** The gate's absolute bars were not met:
   - dE above 2 on 3 of 40 photos (2.05 to 2.66);
   - texture flags on 22.5%.

   The gate rule therefore said "off". The owner overrode it on 2026-10-21, and that override is the only reason it is on.
2. **Gate set.** The gate set had no photo above 1,200 px, so it never tested the real 1.5x to 2x range on large sources.
3. **Live checks.** They covered Penti only, with flat briefs and pyjamas. They did not cover fine knits, lace or denim (Vero Moda, Cardio Bunny, Nautica in F5), nor small landscape images (USPA).
4. **Centrepoint.** It is the channel that still enlarges most after x2. An 800x800 photo needs 3.75x: x2 from the upscaler, then 1.875x plain. No visual judgement exists for Centrepoint at that factor.
5. **Small photos.** Photos under 741 px tall are still skipped on Styli. That is correct, but the skip is still not visible enough to the operator (F3 items 7 and 8).

### F8. Links sheet today

- **Columns and statuses.** `packages/core/src/catalog/sheet.ts` writes:
  - fixed columns: brand, identifier, option_id_style_color, opptra_sku_ids;
  - per ticked channel, "<Channel> Image 1..N", where N is the most images any row has for that channel and 0 removes the channel;
  - then status, notes, change, changed_at.

  Statuses: ok, needs_attention, missing_images, not_in_sheet.
- **No roles.** The sheet has no role, count or completeness information.
- **Notes.** They list skips and held reasons as "Styli img n: <sentence>". They leave out information flags such as `low_resolution` on non-Styli channels.

## Per-channel rule table

Proposed V1 rules for softline apparel shown on a model (DD0 categories tops, knit_sweat, outerwear, dresses_jumpsuits and sleep_lounge).

Columns 2 to 4 are quoted from `channels.ts` (internal truth; see 01a for the external check). Columns 5 to 8 are proposals. "Assumed" means the channel publishes nothing and the rule follows Styli by analogy: assumed, owner to confirm.

Role codes (DD0):

| Code | Role |
|---|---|
| FM | front, cropped mid-thigh |
| FL | full length |
| FC | fabric close-up |
| BH | back, cropped at the hips |
| HS | head and shoulders |
| PK | packshot |
| LO | legs only |
| LS | lifestyle |

| Channel | Canvas (code) | Background (code) | Smallest source height for a 2:3 photo, without / with x2 (derived from code) | Required roles, in order | Count (min / recommended) | On-model rule | Head-cut rule | Status |
|---|---|---|---|---|---|---|---|---|
| Styli | 2342x3123 fixed, guides 450/450/150/150, bottom-centre, 300 DPI | #E0E0E0 | 1,482 / 741 (skip below) | FM, FL, FC, BH, HS | 5 / 5 | Same model and lighting; FC without the model | Head cut fails; body crops pass | Roles: owner's email. Sizes: see 01a |
| Centrepoint | 3000x3000 fixed, 300 DPI | #E0E0E0 | 2,000 / 1,000 (published, note) | FM, FL, FC, BH, HS | 5 / 5 | As Styli | As Styli | Roles: meeting (Landmark studio); assumed same order, owner to confirm. Sizes: see 01a |
| 6thStreet | 1200x1600 to 2000x2667, 300 DPI | #E0E0E0 | 1,067 / 534 | FM, FL, FC, BH, HS (assumed) | 1 / 5 (assumed) | On model for adult apparel (assumed) | As Styli (assumed) | Nothing public; assumed, owner to confirm |
| VogaCloset | as 6thStreet | #E0E0E0 | 1,067 / 534 | as 6thStreet (assumed) | 1 / 5 (assumed) | as 6thStreet (assumed) | As Styli (assumed) | Nothing public; assumed, owner to confirm |
| Noon | 660x900 to 1080x1480, margins 10/10 (5% sides when wide), 72 DPI | #E0E0E0 | 483 / 242 | Image 1 a front view (FM or FL). Recommended order FM or FL, BH, then FC, HS | 1 / 3 minimum recommended (public); 5 "good catalog" (owner) | Adult apparel on a model; kids, swimwear and underwear flat or hanger (public) | Not published; Styli rule assumed, owner to confirm | Count, order and on-model verified (primary); head rule assumed |
| Namshi | as Noon, margins 10/10, 72 DPI | #E0E0E0 | 483 / 242 | Image 1 a front view; then Styli order (assumed) | 1 / 5 (owner's meeting statement) | Model recommended (secondary) | Styli rule assumed | Unverified; assumed, owner to confirm |
| Trendyol | 1200x1800 fixed, 96 DPI | #E0E0E0 | 1,200 / 600 | Image 1 a front view; then Styli order (assumed) | 1 / 5 (owner); up to 8 (secondary) | Not published; Styli assumed | Styli rule assumed | Unverified; assumed, owner to confirm |
| Amazon (.ae/.sa) | 1000x1000 to 2000x2000 (1:1), 300 DPI | Image 1 #FFFFFF, others #E0E0E0 | 667 / 334 | Image 1 front on model (MAIN), then FC (detail), BH (back); front and back mandatory | 1 / 5 to 7 (public) | Adult apparel MAIN on a standing model; kids, multipacks and accessories off-figure (public) | Image 1 cropped between nose and upper lip, or the whole head shown; a cut above the nose fails (the latter assumed) | Roles, count, on-model and head rule verified on the global guide (primary); .ae/.sa pages need a seller login; sizes: see 01a |
| Shein | as Amazon (1:1), image 1 white | Image 1 #FFFFFF | 667 / 334 | Image 1 a front view; then Styli order (assumed) | 1 / 5 (assumed) | Models optional (secondary) | Styli rule assumed | Unverified; assumed, owner to confirm. Sizes: see 01a |

Other categories follow DD0's handling matrix:
- **Footwear and bags:** required role PK, with PK front or side first. LO and LS are optional and are never reported as missing in V1.
- **Lingerie, swimwear, bottoms, kids and multipacks:** DD0 open items 1 to 7. Until the owner answers, V1 reports their roles but never calls a role missing.

The head-cut and body-crop rule as a testable statement (V1):
- For every source photo the judge rates as on-model, it returns `head` as one of:
  - `full`: the whole head, including the top of the hair, is inside the frame;
  - `none`: no part of the face is in the frame, because the crop line is at or below the chin;
  - `cut`: part of the face is in the frame and the top edge of the frame crosses it between the hairline and the chin.
- On Styli, Centrepoint, and assumed for 6thStreet, VogaCloset, Noon, Namshi, Trendyol and Shein:
  - a photo with `head` = `cut` is not used for that channel and gets a missing-role note;
  - `full` and `none` pass. A body crop at the chest, waist, hips, thigh or knee is never a failure.
- On Amazon: `full` and `none` pass; `cut` passes only when the crop line lies between the tip of the nose and the upper lip.
- A cut through the hair above the hairline counts as `full` (assumed, owner to confirm).
- Test fixtures:
  - a full-length photo cropped at the forehead gives `cut` and is excluded on Styli;
  - the same photo cropped at the shoulders gives `none` and passes;
  - a photo cropped between nose and upper lip gives `cut`, fails on Styli and passes on Amazon;
  - the render never creates a cut, because `trimRules` `protectTop` keeps the top of on-model photos.

## Options

| Option | What it is | For | Against |
|---|---|---|---|
| A. Report only | The judge adds a role and the head state to each photo. Each channel gets a required-role list. The sheet shows roles and missing-role notes. Nothing is reordered or held | Least change; the operator sees everything; no false hold costs a photo | Styli's fixed order is still not met; it relies on the operator reading notes |
| B. Report, reorder and complete-or-explain (recommended) | A, plus, for each channel:<br>- the photos are placed in that channel's role order;<br>- a photo whose head is cut is left out on channels that fail head cuts;<br>- the channel's columns are always kept and a ticked channel is never dropped from the sheet;<br>- a new status "incomplete" (sheet and banner) is set when a ticked channel has fewer required roles than it needs.<br>The operator can correct a role, which overrides the judge. Images that are present are still published | Makes the V1 sentence true: every product is channel-ready or has a precise reason, with no silent path. Uses the existing judge call | Output numbering per channel no longer equals the upload number (sheet and paths follow the role order). Wrong roles become visible errors, so role accuracy must be measured first |
| C. Hard gate | B, but a channel that misses a required role publishes nothing for that product | Guarantees the channel never sees an incomplete set | Blocks most of today's catalog (no source has all 5 Styli roles until V2 and V3 fill them). Holds that cannot be fixed without new photos |
| D. Separate role classifier at ingest | One more vision call per photo at ingest, before matting | Roles known before the render, so the wizard can warn before Start | Pays a second call per photo for what the judge already sees; two classifiers can disagree |
| E. Operator-declared roles only | Roles from filename suffixes or a sheet column | Exact when supplied | Agencies do not name files consistently; roles would be missing for most uploads; silent when absent |

Upscaler options per channel:
1. Keep it on everywhere, with no note.
2. Turn it off. Styli would return to 100% skipped for 800x1200 sources.
3. Keep it on, with a note where the enlargement left after x2 is still above 1.5. Today that is only Centrepoint below 1,000 px of source height and Trendyol below 600 px.

How confidence is handled (B and C):
- The judge returns `role`, `role_confidence` (0 to 1) and `head`.
- **Below 0.7:** the second judge model, which already exists, is asked once. If it still falls below 0.7, the role is "not sure".
- **A role that is not sure** never fills a required role. The note says "check the shot type of photo n".
- **A photo the judge never saw** (sampled out, spend cap, judge unavailable) gets role "not checked", with a note. Roles must be judged for every photo even when `qaSampleRate` is below 1.

## Recommendation

**Option B, with the following parts.**

1. **Role taxonomy.**
   - DD0's 8 roles: FM, FL, FC, BH, HS, PK, LO, LS.
   - Four non-role values: `other_angle` (on-model side or three-quarter), `chart` (existing), `not_sure`, `not_checked`.
   - PK keeps the judge's existing sub-views: front, side, back, sole, top, inside, detail.
   - Roles describe the photo; DD0's category decides which roles are required.
2. **Where roles are decided.** In the existing judge call on the source photo (`qa/templates.ts`, `qa/judge.ts`), stored with the view in `qa_scores`.
   - No new call per photo.
   - Roles are judged for every photo regardless of `qaSampleRate`.
   - The operator can override a role per photo in the attention page; the override wins.
3. **Release condition for V1.** Role accuracy is measured before the "incomplete" status goes live:
   - add role and head expectations to the spec 10 golden set (French Connection, Penti, Vero Moda, Anta on-model photos);
   - the bar is at least 95% correct per required role and 100% on `head` = `cut` for the fixtures above. Missing that bar keeps Option A behaviour (notes only).
4. **Per-channel rules** as in the table above. Styli comes from the owner's email; Amazon and Noon are verified; the rest are marked assumed until the owner confirms.
5. **Ordering.** For each channel, the first photo of each required role goes into that channel's order, then any extra photos. This applies to Styli and Centrepoint in full, and only for image 1 on the others.
6. **No silent failure left:**
   - a ticked channel always keeps its sheet columns;
   - "incomplete" is a new sheet status and Ready-banner clause;
   - non-Styli `low_resolution` is shown in the notes;
   - the two Styli size tests (F3 item 9) are reported in the same words, with the size needed.
7. **Upscaler, per channel:**
   - **Keep on, with the existing "enlarged" note:** Amazon, Noon, Namshi, Trendyol, 6thStreet, VogaCloset and Shein. They rarely need it, and the gate shows it is better than plain enlargement.
   - **Keep on, with the existing "enlarged" note and the skip below 741 px made visible as a missing-role note:** Styli.
   - **On with a soft-image note:** Centrepoint. Add a note when more than 1.5x enlargement remains after x2, because no visual judgement exists for 3.75x.
   - **Follow-up checks:** a texture-heavy live check (Vero Moda, Cardio Bunny), and a Centrepoint check at 2.5x to 3.75x.
8. **Bigger sources.** When a product resolves to a master_sl option whose `image_url` is larger than the uploaded photo (Penti: 1440x2160 vs 800x1200), the note names it ("A larger photo of this product exists in the brand's master; use it for Styli and Centrepoint."). Fetching it automatically is a separate decision and is not part of V1.

Proposed links sheet changes (plain language, no model names):

**New columns.** Per ticked channel, after its "Image n" columns:
- **"<Channel> shots":** the role of each image in order, for example "1 front to mid-thigh, 2 full length, 3 fabric close-up, 4 back to the hips, 5 head and shoulders".
- **"<Channel> missing":** the roles still needed, or empty.

The status column gains "incomplete".

**Note wording.** Each note is one sentence or two, starts with the channel, and says what to do:

| Situation | Note wording |
|---|---|
| Missing roles | "Styli: 3 of 5 required shots. Missing: back view cropped at the hips, head-and-shoulders close-up. Add these photos to complete Styli." |
| All too small | "Styli: no images. All 5 photos are too small for Styli, even after enlarging (Styli needs photos at least 741 px tall; these are 600 px). Ask the brand for larger photos." |
| Head cut | "Centrepoint: photo 2 is not used because the model's face is cut at the top edge. Body crops are fine; only a cut through the face is not. Other marketplaces may still use it." |
| Fewer than recommended | "Noon: 1 photo. Noon recommends at least 3; the listing is accepted but will look thin." |
| Role not sure | "Photo 4: we could not tell which shot this is. Check it and set the shot type." |
| Roles not checked | "Shot types were not checked for photos 3 to 5 because the quality check was unavailable. Run the check again before uploading to Styli or Centrepoint." |
| Soft image | "Centrepoint: photos 1 to 5 were enlarged a lot to reach 3000 x 3000 and may look soft. Ask the brand for larger photos if you can." |
| Larger copy exists | "A larger photo of this product exists in the brand's master (1440 x 2160). Use it for Styli and Centrepoint." |

**Footwear and bags:** "Shots: packshot side, packshot pair, sole." They are never marked missing in V1.

No external library, API or SDK is recommended, so no Context7 lookup was needed.

## Approval question

Do you approve, for V1:
- **(a)** the role taxonomy: DD0's 8 roles plus other_angle, chart, not_sure and not_checked, decided in the existing quality check with your override on top;
- **(b)** the per-channel rule table above:
  - the Styli five-shot order for Styli and Centrepoint;
  - Amazon and Noon as published;
  - every "assumed" rule (6thStreet, VogaCloset, Namshi, Trendyol, Shein, and the head rule outside Styli and Amazon) as the starting rule until you correct it;
  - the head-cut statement, with Amazon allowed its nose-to-upper-lip crop;
- **(c)** the upscaler kept on for all 9 channels, with a soft-image note on Centrepoint where more than 1.5x enlargement remains after x2, and the Styli skip below 741 px shown as a missing-shot note?

Status: done, awaiting owner answer
