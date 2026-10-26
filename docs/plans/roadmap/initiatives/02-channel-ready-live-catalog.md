# Initiative 02 - Channel-ready live catalog

Date: 2026-10-26. Part of the GCC catalog roadmap proposal (`docs/plans/roadmap/07-roadmap.md`, "Initiative 2").
Documents only: nothing was built, no image was rendered, no query or paid call was run. No time or effort
estimates. Buckets inside: B1 (shot roles and per-channel rules) and L2a (recover Noon content rejections).

**Source codes** (same as 07). 01 marketing data, 02 liveness data, 03 image audit, 05 build vs buy, 06 metrics and
impact model v2 (all in `docs/plans/roadmap/`); DD0, DD1, DD1a, DD9 = `docs/plans/deep-dives/00-...`, `01-...`,
`01a-...`, `09-...`; SPEC = `docs/SPEC.md` in the main repo; code paths are relative to the main repo
`catalog-module` on `main` at `db716b3` (read 2026-10-26). Money is USD a year of extra revenue unless stated.
Measured = a count or sum from data; judged = an assumption.

## Summary

1. Live pages carry the brand's photos as received: 0 of 37 checked Trendyol listings were repaired; head cuts and lifestyle-first galleries are live (03).
2. Our module already renders every photo to all 9 channels' canvas rules for about 0.012 USD per style-colour (05); what it lacks is shot roles, order, image caps and minimums, a cut-product rule for image 1, Noon's white first image outside fashion, and a visible "incomplete" status (DD1, DD1a).
3. This initiative adds those rules to the existing platform, then re-renders and re-submits the live back catalog: 3,141 style-colours, about 17,270 style-colour-channel pairs (DD9).
4. Order: apparel brands first (French Connection, Penti, Vero Moda, Cardio Bunny, Nautica; 1,912 style-colours), Noon and Namshi first, then footwear brands (1,229).
5. Value: low 0, base 21.5k, high 52.4k USD a year (B1 14.0k + L2a 7.5k at base), plus about 1.1k a year of agency image fees (06; 07).
6. Run cost: about 77 USD in year one (37 one-off re-run + up to 40 a year for new styles); base ROI about 280 USD of revenue per USD of run cost (07).
7. Build, not buy: the platform exists; buying the same layout from Photoroom would cost about 1,600 to 14,000 USD a year (05).
8. Nothing blocks the start; Noon recovery waits for the fresh Noon Not Live feed (C-02) from initiative 1.
9. Two findings in the deep dives are now stale on `main`: Styli no longer skips small photos (PR #91), and cut products are placed flush on every channel, image 1 included (see "Findings now stale").

## Problem, with evidence and real examples

### What the evidence shows

| # | Finding | Number | Source |
|---|---|---|---|
| 1 | Live photos are the brand photos, at most resized, padded or reordered | Trendyol UAE, 37 listings: 24 same photos resized or padded, 10 a brand background alternate, 2 another shoot, 1 wrong product, 0 re-shot or repaired | 03 "Live vs raw comparison" |
| 2 | Lifestyle image opens the gallery | 7 of 37 live Trendyol listings; Noon's front-first rule would reject that main image | 03 |
| 3 | Live galleries reordered against the brand's order | 22 of 37 | 03 |
| 4 | Amazon main-image rule (pure white, product not cut, no text, not a detail or lifestyle) fails | 44 of 141 (31%); French Connection 15 of 19, Vero Moda 10 of 15, Only 9 of 10, Cardio Bunny brand-sent 5 of 5; US Polo, Campus, Penti, Anta, Keds 0 | 03 "Defect rates per channel rule" |
| 5 | White first image fails, where applied (Amazon main, Shein, Noon outside fashion) | 39 of 141 (28%); apparel 28 of 66, footwear 9 of 64 | 03 |
| 6 | Cut product on the main image (named Noon rejection) | 6 of 141 (4%), all apparel (Only 4 of 10) | 03 |
| 7 | Wrong first image (Noon "incorrect sequencing") | 4 of 141 in raw folders; 7 of 37 live on Trendyol | 03 |
| 8 | Head cut on an on-model shot | 15 of 64 on-model products (23%) | 03 |
| 9 | Over a channel's image cap | Amazon 9: 2 of 141; Trendyol 8: 3 of 141 | 03 |
| 10 | Under a channel's minimum | VogaCloset 4: 21 of 141 (15%); Shein 2: 12 of 141 (9%) | 03 |
| 11 | Single image only | 12 of 141 (9%) | 03 |
| 12 | Sets mixing pixel sizes, padding or backgrounds | 51 of 141 (36%) | 03 |
| 13 | Noon held SKUs not live for "Content Issues" in its last file (21 Aug 2026) | 479 (264 UAE, 215 KSA); French Connection 365 (207 UAE, 158 KSA) | 02 "Image and content rejections" |
| 14 | Content rejections read as 0 in the live report | Because the Noon (C-02) and Namshi (C-04b) reason feeds are stale or not loaded, not because the problem is gone | 02 |
| 15 | The module tracks photo position, not role; no channel has a required shot list, image cap, minimum or head-cut rule in code; a 1-photo product gets status "ok" | Confirmed on `main` today: `SHEET_STATUSES` = ok, needs_attention, missing_images, not_in_sheet (`packages/core/src/catalog/types.ts:9`); judge views have no role names (`qa/judge.ts:181`) | DD1 Summary 1; DD1a "Differences that matter" 2 to 4 |
| 16 | Noon wants a pure white first image outside fashion; the module paints `#E0E0E0` on every Noon image | `channels.ts` Noon `background: GREY`, no `firstImageBackground` (only Amazon and Shein have white image 1) | DD1a "Differences that matter" 1; `channels.ts` |
| 17 | When no photo reaches a ticked channel, that channel's sheet columns disappear and the row stays "ok" | `sheet.ts` `sheetColumns` gives the channel 0 columns | DD1 F3 item 7; still true on `main` |

Rates are exact counts on the audit sample (5 to 20 products per brand, one reviewer, plus or minus about 3 products
per measure); reading them as catalogue rates is approximate (03 Gaps).

### Where the defect sits, by brand (B1 rule: cut main, head cut on the main, or wrong first image)

| Brand | Defect share (03 csv via 06) | 12-month revenue (06) | Revenue touched |
|---|---|---|---|
| French Connection | 7 of 19 | 0.72M | 0.265M |
| Penti | 4 of 15 | 0.40M | 0.107M |
| Vero Moda | 5 of 15 | 0.13M | 0.043M |
| Cardio Bunny | 4 of 15 | 0.10M | 0.027M |
| Nautica and Puma (not sampled; all-sample rate) | 24 of 141 | 0.14M | 0.024M |
| US Polo, Campus, Keds | 0 | 7.03M | 0 |
| **Total** | 24 of 141 (17%) | | **0.466M** |

Weighted by revenue, the B1 defect is about 12.8% of softline revenue under the lenient rule, not "1 in 3", because
US Polo (6.08M of 8.52M) is almost clean on it (06 Summary 2).

### Real examples (audit files)

All paths are under the audit scratchpad
`C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\8948687b-c329-4062-a372-8e34a714b089\scratchpad\audit\raw\`
(03 "Examples"; numbers are the audit's example numbers). Per-product rule results:
`...\scratchpad\audit\audit_products.csv`. No image was rendered for this document (no builds); each "after" is
what the proposed rules would do, described in words.

| Audit # | File(s) | Brand | Rule broken | Before (today) | After (this initiative) |
|---|---|---|---|---|---|
| 2 | `FrenchConnection\599A5\` (`599A540_D1.jpg`, `_D2.jpg`, `599A540_copy.jpg`, `_BACK_copy.jpg`, ...) | French Connection | Noon "cut or half product on main image" and "incorrect sequencing" | Files sort with a fabric close-up first; the close-up cuts the shorts; packshot and model come later. Output order equals upload order on every channel (DD1 F1), so the close-up becomes image 1 on Noon, Namshi, Amazon | Roles from the judge: close-up = FC, model front = FM or FL, back = BH, packshot = PK. Image 1 on every channel becomes the front; FC moves after BH. On Amazon image 1 is the front on pure white. The cut close-up is never image 1 |
| 3 | `Only\ZF387E332E81ABFF06903Z\ZF387E332E81ABFF06903Z_1.jpeg` | Only | Amazon main "not cut by the frame"; VogaCloset minimum 4; Shein minimum 2; Styli set | One flat packshot whose trousers touch the top and bottom edges. Since PR #91 the module fills the canvas flush with the cut product on every channel, image 1 included, and the sheet row says "ok" | Still published where the channel allows it, but marked "incomplete" with notes: "Noon and Amazon: the only photo shows the product cut at the edge; add an uncut front photo." "VogaCloset: 1 photo; VogaCloset needs at least 4." "Shein: 1 photo; Shein needs at least 2." Brand is asked for a full front |
| 4 | `CardioBunny\ZE28682BAD5330D6EAA88Z\..._1.jpeg` and `_5.jpeg` | Cardio Bunny | Styli / Centrepoint head cut; Noon front-first (live) | Main image cropped through the nose; image 5 is an infographic with text clipped at the edge ("MOVEMEI"); live on Trendyol with the gym lifestyle as image 1 | On Styli, Centrepoint (and the assumed channels) photo 1 is left out with a head-cut note; on Amazon a nose-to-upper-lip crop passes. Lifestyle moves to the last slot on every channel; image 1 is a front. The clipped infographic is flagged for review (text at the edge) |
| 6 | `VeroModa\10288257_Cloud-Dancer\` (14 images, several near-duplicates) | Vero Moda | Trendyol 8, Amazon 9, Shein and VogaCloset 10 maximum | All 14 images become outputs on every channel; the links sheet offers 14 columns and the channel silently drops the extras | Per channel, the first image of each required role in channel order, then extras up to the cap (Trendyol 8, Amazon 9, Shein 10, VogaCloset 10). The note names what was left out: "Trendyol: 6 extra photos not used (cap 8)." |
| 1 | `VeroModa\10352088_Chocolate-Torte\..._1.jpeg` to `_4` | Vero Moda | Amazon white main; Styli / Centrepoint background and 5-shot set | Flat trousers on solid black; images 3 and 4 duplicate 1 and 2; no model | Background is already replaced by the module (white image 1 on Amazon and Shein, `#E0E0E0` elsewhere). New: duplicates are flagged; "Styli: 1 of 5 required shots; missing front to mid-thigh, full length, back to the hips, head and shoulders" (filling them is initiative 5) |
| 7 | `CardioBunnyFlat\CB_HCB-726-532-01_CREAM.jpeg` (`cardio-bunny-sku-images`) | Cardio Bunny | Amazon white main; VogaCloset 4 and Shein 2 minimum; Styli 5-shot set | One 3000x4500 full-length photo per colour on light grey; sheet says "ok" | White image 1 on Amazon and Shein (module already does this); status "incomplete" with the count notes per channel, instead of a silent "ok" |
| 10 | Live Trendyol listing for `FrenchConnection\ZB8B3C9012AE815065B7BZ` vs `...\audit\live\FrenchConnection\ZB8B3C9012AE815065B7BZ\` | French Connection | Wrong product live | A short-sleeve camp-collar shirt is live where the master shows a long-sleeve olive shirt | Not fixable by re-rendering. Re-submitting the correct images for this barcode fixes it; the case goes to initiative 1's listing checks |

Footwear example (03 "Raw image findings", Keds row): Keds sets carry 8 to 9 images with a size chart on every
product, one with 9 images, over Trendyol's 8. After: Trendyol gets the 8 highest-priority roles and a note; the
size chart's slot follows the owner's cap priority (DD4 Q3, DD6 Q4).

## Who it serves

| Who | What changes for them |
|---|---|
| GCC catalog operations and the listing agency | Every ticked channel gets a set in that channel's order and count, or a plain note saying which shot is missing and what to ask for; no silent "ok" on a thin set |
| Brand managers (French Connection, Vero Moda, Only, Cardio Bunny, Penti first) | A precise ask per product ("add a back view cropped at the hips") instead of a generic complaint |
| Marketplace account teams (Noon, Namshi, Amazon) | Fewer content rejections and "Needs editing" holds; Noon rejections re-submitted |
| Shoppers on Noon, Namshi, Amazon, Trendyol | A front view first, no cut product or cut face on image 1, consistent galleries |
| Marketing and the ad agencies | Apparel ad pages fixed to the channel rule before more spend goes on them (initiative 3 uses this re-render for its apparel queue) |
| Nitin Kiran, Naz and the GCC business team | A channel-ready claim that is true per listing, and a measured before and after |

## Metrics it moves and today's baselines

| Metric | Baseline today | Source | Measurable today? |
|---|---|---|---|
| Amazon main-image rule pass | 69% (97 of 141) | 06 Catalog health; 03 | Sample only |
| Noon cut-main / sequencing pass | 96% / 97% | 06; 03 | Sample only |
| Noon / Shein white first image pass (where applied) | 72% (102 of 141) | 03 | Sample only |
| VogaCloset minimum 4 / Shein minimum 2 / Trendyol maximum 8 pass | 85% / 91% / 98% | 06; 03 | Sample only |
| Head cut on on-model products | 23% (15 of 64) | 03 | Sample only |
| Set consistency | 36% inconsistent (51 of 141) | 03 | Sample only |
| Noon content rejections | 479 SKUs on 21 Aug (264 UAE, 215 KSA); about 3.0% of Noon UAE and 3.9% of KSA stocked | 02; 06 | No (C-02 stale) |
| Namshi image rejections (`No valid image`, `QC failed`, `Content incomplete`) | Not measurable | 02 | No (C-04b not loaded) |
| Liveness Noon UAE / KSA | 98.0% / 86.6% (24 Oct) | 02 | Yes |
| Ad CVR, apparel brands (90 days) | French Connection 1.10%, Penti 2.59%, Cardio Bunny 2.57%, Vero Moda 1.45% | 01 s2.4 | Yes (Amazon, Noon, Namshi ads) |
| Products with a silent thin set ("ok" with fewer images than the channel needs) | Not counted today (no status exists) | DD1 F3 | No, until "incomplete" exists |
| Role accuracy of the judge | Never measured | DD1 F6 | No, until golden-set labels exist |

After the re-render, the module's own outputs can be checked on every published listing, not on samples; the
sample baselines above are the "before".

## Solution

### Build, buy or hybrid

**Build (already mostly built).** Cut-out, per-channel render for 9 channels, compliance, the judge with
auto-repair, publish and the cost ledger run at about 0.004 to 0.012 USD per style-colour. Doing the per-channel
layout through Photoroom Plus would cost about 6,240 to 14,040 USD a year (1,560 for cut-out plus shadow only), has
no Styli guides, no white-first rule and no channel caps, and would add pixel-regenerating steps our fidelity rules
forbid (05 Summary 1, "Photoroom at our volume", Capability table rows "Per-channel resize and margins" and "Channel
rules and compliance"). No vendor encodes GCC channel rules. Nothing in this initiative generates or crops pixels, so
no SPEC non-goal is touched (05 Risks; DD2 R4 is for initiative 5).

### What already exists (on `main`, `db716b3`)

| Capability | State | Where |
|---|---|---|
| Channel table, 9 channels: canvases, margins, anchors, background, DPI | Built, live; `CHANNEL_RULES_VERSION` "10" | `packages/core/src/catalog/channels.ts` |
| White image 1 for Amazon and Shein | Built (`firstImageBackground`, `backgroundFor`) | `channels.ts` lines 163, 178, 197 to 199 |
| Per-channel render, cut sides placed flush (cut-fill), head never trimmed on model photos (`protectTop`) | Built | `packages/core/src/catalog/render.ts` (`trimRules`, `shotGeometry`, `planCanvas`, `renderSource`) |
| Enlargement: x2 upscaler, then plain; `low_resolution` information note; no skip on any channel | Built (PR #91) | `render.ts` around line 554; `channels.ts` `MAX_UPSCALE` comment |
| Compliance checks: canvas, border band, margins, background, format, bytes, Styli guide | Built (PR #93 aligned Styli placement and check) | `packages/core/src/catalog/compliance.ts` |
| Judge per source photo, returns a `view` from 10 values; second model for second opinions | Built, live; no role, no head state | `packages/core/src/catalog/qa/judge.ts` (`VIEWS`), `qa/templates.ts`, `qa/policy.ts` |
| Repair chosen from the failure, per channel (shadow off, second matte, smaller fit, drop with note) | Built (PR #92) | `packages/core/src/catalog/auto-resolve.ts`, `apps/worker/src/catalog/auto-resolve.ts` |
| Publish: overwrite in place at fixed public links, verify, re-check; links sheet with notes and `change` column | Built, live | `pipeline/publish.ts`, `pipeline/verify.ts`, `recheck/**`, `sheet.ts`; SPEC "Product identity and overwrite" |
| Cost ledger per image and channel; Ops page | Built, live | `packages/core/src/cost-events.ts`, `catalog/cost-report.ts` |
| Golden-set evals (geometry, cut-out, shadow, cut-edge, completeness) | Built; no view or role expectations | `packages/core/src/catalog/evals/**` (spec 10) |

### Findings now stale (checked against `main`)

| Earlier finding | Where | State on `main` now |
|---|---|---|
| "Enlargement is capped at `MAX_UPSCALE` = 1.5"; "only Styli skips" low-resolution photos (`STYLI_SKIP_LOW_RESOLUTION`); the worker skips Styli rows below 1,482 / 741 px source height | DD1 F1, F5 floor model, F7 item 4 | **Stale.** PR #91 (`d8254a1`, owner decision 2026-10-22): no channel skips for size, Styli included. `MAX_UPSCALE` now only shrinks a variable canvas and sets the `low_resolution` note. The only size floor is the 500 px `small_source` hold (`channels.ts` `MIN_SOURCE_LONG_SIDE_PX`) |
| "Two Styli size rules" disagree (DD1 F3 item 9); "make the skip below 741 px visible as a missing-role note" (DD1 Recommendation 7, approval item c) | DD1 | **Stale.** There is no Styli skip left to report. Replace with a soft-image note on Styli and Centrepoint where a lot of enlargement remains (the existing `low_resolution` attention text) |
| 65% of audited products are "below Styli's 1,482 px floor" | 03 Summary 6 | Still true as a size fact, but it no longer causes a skip; those photos are now published enlarged with a note. Only the 741 px x2 floor (1 of 141) indicates likely visible softness |
| "The low-resolution skip is the silent failure" (all 638 Styli outputs skipped before the upscaler) | DD1 Summary 2 | **Partly stale.** The size skip is gone, but the silent column drop remains in `sheet.ts` `sheetColumns` for any other cause (size charts dropped, a photo dropped by repair, all photos held) |
| "We publish source-cut photos with a note on every channel, image 1 included" | DD1a gap 3 | **Still true and now stronger.** PR #91 "products cut at the edge are made": a cut product fills the canvas flush; a note appears only when a cut side cannot sit flush (`CUT_BAND_NOTE_START`). Nothing keeps a cut photo out of position 1 |
| Noon image 1 grey for all categories; Amazon sheet text "3:4 portrait" vs 1:1 canvas | DD1a gaps 1 and 9 | Still true (`channels.ts` lines 61 and 167) |
| No roles, caps, minimums, order or head rule in code; no "incomplete" status | DD1 F1, F3 | Still true |
| `docs/PROGRESS.md` | main repo | Has no entry for PRs #91 to #93 (its last session is 6); whether they are deployed is not recorded there |

### What changes

All changes follow DD1's Option B ("report, reorder and complete-or-explain") and DD1a's open items, inside the
existing render and sheet. Nothing new is generated or cropped.

1. **Shot role per photo** from the existing judge call: DD0's 8 roles (FM, FL, FC, BH, HS, PK, LO, LS), plus
   `other_angle`, `chart`, `not_sure`, `not_checked`; PK keeps the sub-views front, side, back, sole, top, inside,
   detail. The judge also returns `head` (`full`, `none`, `cut`) and `role_confidence`; below 0.7 the second model
   is asked once, then "not sure". Roles are judged for every photo even when `qaSampleRate` is below 1. The
   operator can override a role; the override wins (DD1 Recommendation 1, 2; "How confidence is handled").
2. **Required roles and order per channel** (DD1 "Per-channel rule table"): Styli and Centrepoint FM, FL, FC, BH,
   HS in that order; Amazon image 1 front, front and back mandatory; Noon image 1 a front view, then BH, FC, HS;
   Namshi, Trendyol, Shein, 6thStreet, VogaCloset follow the Styli order (assumed until the owner confirms). Full
   order on Styli and Centrepoint, image 1 only on the others (DD1 Recommendation 5). Category decides which roles
   are required (DD0 matrix): footwear and bags need PK with front or side first; bottoms, lingerie, swimwear, kids
   and multipacks report roles but never call one missing until DD0's open items are answered.
3. **Image caps and minimums** per channel: caps Amazon 9, Trendyol 8, Shein 10, VogaCloset 10; minimums VogaCloset
   4, Shein 2; Noon "at least 3" and Amazon "5 to 7" as recommended counts with a "will look thin" note (DD1a item
   2; DD1 F2). Extras beyond a cap are dropped by role priority and named in the note.
4. **Cut product never on image 1** on Noon and Amazon (DD1a item 6): if a photo is cut in the source
   (`cut_in_source` flag) and another front exists, the uncut front leads; if none exists, the product is
   "incomplete" with a note, and the cut photo stays an alternate.
5. **Head-cut rule per channel**: `cut` is left out on Styli and Centrepoint (assumed for the others) with a note;
   Amazon passes a nose-to-upper-lip crop; body crops never fail (DD1 "head-cut and body-crop rule").
6. **Noon white first image outside fashion**: add `firstImageBackground: "#FFFFFF"` per product department on Noon
   (and Namshi if confirmed), for the departments the owner names as non-fashion. Certain today: French Connection
   home fragrance (86 options, DD0 Summary 7). Open: footwear (1,744 options) and bags (76): our render currently
   turns the brands' white footwear mains (US Polo 20 of 20, Campus 15 of 15, Keds 7 of 7 white in raw, 03) into
   grey `#E0E0E0` on Noon, so if Noon counts footwear as non-fashion the module is creating the defect (DD1a item 1).
7. **"incomplete" status and missing-shot notes** instead of silent skips: a ticked channel always keeps its sheet
   columns; new columns "<Channel> shots" and "<Channel> missing"; status "incomplete" in the sheet and the Ready
   banner; non-Styli `low_resolution` shown in notes; the repair path's "drop with note" (PR #92) feeds the same
   missing-shot note (DD1 Recommendation 6 and "Proposed links sheet changes"). Copy is plain language, never names
   a model.
8. **Version bump**: `CHANNEL_RULES_VERSION` goes up so every render key changes and the back catalog re-renders
   once; fix the stale sheet texts (Amazon "3:4 portrait", Trendyol "3:4", Styli "1200x1600", Namshi "= Noon
   rules") (DD1a item 9).
9. **Release condition** (DD1 Recommendation 3): role and head labels added to the spec 10 golden set (French
   Connection, Penti, Vero Moda, Anta on-model photos); at least 95% correct per required role and 100% on
   `head` = `cut` before reordering, cap drops and "incomplete" go live. Below the bar, the module runs in Option A
   (roles and notes only, nothing reordered or dropped).
10. **Treatment record** for each re-published listing (role and position per image), written for initiative 1's
    treatment log (06 "What the catalog module must record").

## Back catalog plan

### How many listings

The live back catalog is 3,141 style-colours (3,754 options; about 17,270 style-colour-channel pairs on 9
channels) and about 14,600 source photos (DD9 s1; 05 "Volume used"). Presence per channel below is counted from
`master_sl` channel ids (DD9 s1, exact, 2026-10-22); Noon and Namshi count each option once across UAE and KSA.
A channel id means "listed", not "live"; the live, stocked count on the four connected channels is 46,249 EAN-pairs
(02).

| Brand | Style-colours | Options | Noon | Namshi | Trendyol | Amazon | Shein | Styli | Centrepoint | 6thStreet | VogaCloset |
|---|---|---|---|---|---|---|---|---|---|---|---|
| French Connection | 899 | 900 | 899 | 899 | 810 | 400 | 0 | 120 | 363 | 454 | 0 |
| Penti | 615 | 616 | 616 | 616 | 613 | 544 | 0 | 569 | 528 | 410 | 112 |
| Vero Moda | 120 | 121 | 102 | 103 | 99 | 28 | 0 | 96 | 91 | 92 | 0 |
| Cardio Bunny | 119 | 119 | 119 | 119 | 119 | 94 | 0 | 119 | 92 | 92 | 0 |
| Nautica | 159 | 159 | 156 | 156 | 141 | 31 | 0 | 0 | 0 | 79 | 0 |
| US Polo | 529 | 529 | 529 | 529 | 529 | 448 | 397 | 430 | 466 | 461 | 56 |
| Campus | 405 | 1,013 | 1,013 | 1,013 | 696 | 820 | 800 | 741 | 0 | 632 | 219 |
| Keds | 105 | 106 | 106 | 106 | 105 | 72 | 0 | 105 | 0 | 105 | 0 |
| Puma | 190 | 190 | 0 | 0 | 188 | 0 | 0 | 0 | 97 | 0 | 0 |
| **Total** | **3,141** | **3,754** | **3,540** | **3,541** | **3,300** | **2,437** | **1,197** | **2,180** | **1,637** | **2,325** | **387** |

(French Connection UK, 1 option with no channel id, is left out. Campus's 1,013 option ids are 405 style-colours,
DD9 s1.)

### In what order

The order follows where the measured defect and the rejections are, then dependency. Every wave re-renders all of
the brand's photos once (the rules version bump makes every render key new), then re-submits channel by channel.

| Wave | Scope | Style-colours | Why first or later | Channel order inside the wave |
|---|---|---|---|---|
| 0. Gate | Golden-set role and head labels; release bar met (DD1 R3) | 0 | Wrong roles become visible errors; the bar decides Option B vs Option A | n/a |
| 1a. Holdout pilot | Matched pairs of French Connection, Penti, Vero Moda and Cardio Bunny options with 200+ clicks on Namshi (06 "Cells" 1); only the treated half is re-submitted | subset of wave 1 | Namshi is the largest softline revenue and ad channel (76,271 USD spend in 90 days, 01 s2.2); the only place a lift can be measured; needs initiative 1's treatment log and a bid freeze | Namshi only |
| 1b. Apparel brands | French Connection, Penti, Vero Moda, Cardio Bunny, Nautica | 1,912 | All 0.466M of B1 revenue touched; 365 of 479 Noon rejections are French Connection; all Amazon main fails sit here | Noon (rejections; re-submit once C-02 is fresh), Namshi (rest, after the pilot's control period), Amazon and Shein (white main, cut main), Trendyol (cap 8, lifestyle-first live), then Styli, Centrepoint, 6thStreet, VogaCloset (role order, head cuts, notes) |
| 2. Footwear brands | US Polo, Campus, Keds, Puma | 1,229 | B1 defect share 0, so little revenue in this initiative; but caps (Keds 9 images), padded 600x800 portraits in square sets (US Polo 7 of 20, Campus 11 of 15), side-first order, and the Noon white-main question apply; it is the base for initiative 3's footwear queue | Noon (if footwear is non-fashion: white image 1), Namshi, Amazon, Trendyol, then the rest |
| Ongoing | New styles (about 3,350 a year, 05) | n/a | Same rules from day one | As ticked |

Besides French Connection's 365, the Noon rejection list holds Campus 44, Penti 26, Nautica 22, US Polo 10 and 12
other SKUs across UAE and KSA (02); those are re-submitted with their brand's wave once C-02 confirms they are still
rejected.

### How they are re-published

1. **Render and publish** run as normal catalog batches per brand, overwriting in place at the same public links
   (SPEC "Product identity and overwrite"; `pipeline/publish.ts`). The worker only touches objects under the prefix
   of the product it holds the lock for, on the channels of the batch (AGENTS.md). Heavy runs follow the house rule:
   no back-catalog batch while the owner or operators are using the site, and the owner is asked before each wave.
2. **Re-submission to the marketplaces is needed.** Marketplaces copy the image at listing time, so a new image at
   the same link is not seen until the image columns are re-submitted for products whose `change` is `updated`,
   `shots_removed` or `reordered` (SPEC line 393 to 395). The links sheet per brand and channel is the hand-off; the
   agency or the channel team uploads it through each portal's bulk content update. Where a channel will not
   re-fetch an unchanged URL, the "fresh links" export or a manual re-upload applies (SPEC open item 4).
3. **Noon content rejections (L2a)**: once initiative 1 restores C-02, the current rejected list is matched to the
   re-rendered products and re-submitted first; the next C-02 file shows which came back live.
4. **Incomplete products** are still published with what passes; their notes go to the brand as a photo request
   list per brand (missing roles, cut fronts, too few images).
5. **Every re-published listing** writes its roles and positions to the treatment log (initiative 1), so the
   holdout and the liveness report can see the change.

## Cost and ROI

All figures are consistent with 07 "Initiative 2" and 06 "Summary table"; people time and margin are excluded (06
Assumptions row 11).

### Revenue (USD a year)

| Lever | Formula | Low | Base | High |
|---|---|---|---|---|
| B1 framing and order | revenue touched 0.466M (table above) x lift 0 / 3% / 6% (judged, DD9 unchanged) | 0 | 14.0k | 28.0k |
| L2a Noon content rejections | 479 SKUs x 31.2 USD (French Connection revenue per live EAN-pair, 302,849 / 9,697) = 15.0k if all recovered; recovered share 0 / 50% (judged); high at Noon country means 264 x 33.9 + 215 x 72.1 = 8.9k + 15.5k | 0 | 7.5k | 24.4k |
| **Total** | B1 + L2a | **0** | **21.5k** | **52.4k** |

Other money, not added to revenue:
- Agency image fees: about 1.1k USD a year (INR 93,800 at a 50% image share of INR 60 per style; range about 0.6k to
  1.6k at 30 / 70); about 1.0k once for the current catalogue (INR 88,000) (DD9 s6).
- Ad money saved at the base lift: 22.2k touched x 0.03 / 1.03 = 0.6k (1.3k high); counted once in initiative 3,
  not here (06 Overlaps).
- The Amazon main-image rule fails 31% of products, but on brands with small Amazon sales: French Connection 1,391
  USD in 90 days x 4.056 x 79% fail = about 4.5k touched, under 0.3k uplift; not a row (06 B1).

### Run cost (USD)

| Item | Formula | Low | Base | High |
|---|---|---|---|---|
| One-off re-run of the back catalog | 3,141 style-colours x 0.0119 USD per style (5 photos, all channels, upscaler; 05) | 37 | 37 | 37 |
| New styles a year | about 3,350 styles x 0.0036 to 0.0119 (05) | 12 | 40 | 40 |
| Role tagging | inside the existing judge call (DD1 R2); second opinions only below 0.7 confidence (not sized, small) | 0 | 0 | not sized |
| **Year one** | one-off + a year | **49** | **77** | **77** |

07 uses 77 USD for year one (the upper end of the recurring range); this document keeps that figure.

### ROI

| Case | Formula | USD of revenue per USD of year-one run cost |
|---|---|---|
| Low | 0 / 77 | 0 (run cost covered by the 1.1k agency fees saved) |
| Base | 21.5k / 77 | about 280 |
| High | 52.4k / 77 | about 680 |

These ratios show that run cost does not limit this initiative; they are not profit figures. The real costs are
review, golden-set labelling and the re-submission work in the portals, which are people time and excluded by rule.

## Risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| 1 | The lift is judged (3% base); our own data shows no CVR link to image count (CVR ratio 0.954, 01 s3) | B1 could be worth near 0 | Holdout pilot on Namshi; report the measured lift; a 3% lift is below what the holdout can detect (15% per cell, 06), so the cell reads only a large effect |
| 2 | Judge assigns wrong roles or misses head cuts | Wrong order, wrong drops, false "incomplete" | Release bar 95% per role, 100% on head cuts (DD1 R3); Option A fallback; operator override |
| 3 | 7 of 9 channels publish no image rules; the Namshi, Trendyol, Shein, 6thStreet, VogaCloset rules are assumed (DD1a Summary) | Re-render to a wrong rule; new rejections | Ask account managers for portal exports (DD1a item 5); initiative 1's reason feeds show rejections by reason |
| 4 | Re-submission triggers a fresh portal review and listings drop out while under review (not measured) | Temporary liveness loss | Pilot one brand on one channel first; watch liveness with initiative 1's feed-health flag |
| 5 | Head-cut exclusion and caps leave a channel under its minimum | A product that met the count now fails it | "incomplete" note and brand request; owner decides cap priority (DD4 Q3, DD6 Q4) |
| 6 | Noon's fashion definition unknown (DD1a item 1) | Footwear on Noon either stays grey (risk of "Needs editing") or turns white without need | Owner answer before wave 2; home fragrance first |
| 7 | Since PR #91, very small photos are published enlarged on Styli and Centrepoint instead of skipped | Soft images go live on the two most demanding channels | Soft-image note; ask brands for masters (Penti 1440x2160 copies exist, DD1 Summary 5); initiative 5 stage A |
| 8 | Noon list is from 21 Aug and includes unstocked SKUs | L2a could be smaller or larger | Recover only after C-02 is fresh (06 Assumptions row 9) |
| 9 | Audit samples are small (5 to 20 products per brand) | Brand defect shares move | Replace with role tags on every re-rendered listing |
| 10 | Wrong product live (FC `ZB8B3C9012AE815065B7BZ`) and duplicate folders with no recorded original (03) | Re-rendering the wrong source | Use the newest brand copy per product; listing mismatch goes to initiative 1 |
| 11 | Reordering changes output numbering vs upload numbering (DD1 Option B "Against") | Operators and the agency expect upload order | Sheet "shots" column names each image's role; SPEC update approved before release |

## How we measure success

| Measure | Target or reading | How |
|---|---|---|
| Rule pass on published outputs (white main, cut main, image 1 front, caps, minimums or an "incomplete" note) | 100% of outputs either pass or carry a note; no silent "ok" | Module compliance on every output, not samples |
| Role accuracy on the golden set | at least 95% per required role, 100% on head cuts | spec 10 eval with new expectations |
| Noon content rejections | Fall from 479 (21 Aug) on the first fresh C-02 files after re-submission | Initiative 1 feeds |
| Namshi image rejections | First baseline once C-04b loads, then trend | Initiative 1 |
| Liveness Noon UAE / KSA | No drop during re-submission; recovery of rejected SKUs (264 SKUs is about 3.0 points of Noon UAE, 06) | `fact_gcc.catalog_liveness_daily` with the feed-health flag |
| Ad CVR on the Namshi holdout cell | Measured difference in differences; detects about 15% relative lift with about 42% of one 90-day window of clicks (06) | 06 "Measurement plan", cell 1 |
| Count of "incomplete" products and the brand requests they produce | Reported per brand; falls as brands send photos or initiative 5 fills shots | Links sheet and product records |

## Dependencies

- **Initiative 1**: fresh Noon Not Live (C-02) for L2a; Namshi C-04b for image rejections; the treatment log and
  bid freeze for the holdout; the feed-health flag so re-submission dips are not read as delistings.
- **DD0 taxonomy approval**: the category decides required roles and the Noon fashion rule.
- **DD1 approval items (a) and (b)**: role taxonomy, per-channel rule table, head-cut statement. Item (c) is
  reworded: the Styli skip no longer exists (PR #91).
- **DD1a owner items 1, 2, 4, 6**: Noon fashion definition, caps and minimums, Centrepoint spec, cut main out of
  position 1.
- **A re-submission route**: who uploads the links sheets in each portal (agency or channel team).
- **Downstream**: initiative 3 uses this re-render for its apparel fixes; initiative 5 needs the roles and
  required-role lists; initiative 6 needs caps and last-slot placement (07 Dependencies).

## Owner questions

1. Do you approve DD1's role taxonomy and per-channel rule table, with the assumed rules for Namshi, Trendyol, Shein,
   6thStreet and VogaCloset as the starting rule until a portal export says otherwise?
2. Which product types does Noon count as "fashion"? Should non-fashion items (home fragrance for sure; footwear and
   bags if Noon says so) get a pure white image 1 on Noon, and on Namshi?
3. Should the links sheet stop at each channel's cap (Amazon 9, Trendyol 8, Shein 10, VogaCloset 10) and mark
   "incomplete" under a minimum (VogaCloset 4, Shein 2)? At the cap, which roles win (size chart, close-up, extra
   angles)?
4. Should a photo cut in the source be kept out of position 1 on Noon and Amazon (still an alternate)?
5. Centrepoint: Landmark's 3:4 studio spec (2342x3123, as Styli) or the square 3000x3000 in our code?
6. Who re-submits the re-rendered image columns in each portal, and does any channel re-review a listing (and take
   it offline) when its images change?
7. May wave 1 start with the Namshi holdout pilot (matched pairs, half re-submitted), with a bid and budget freeze
   agreed with the agencies, before the rest of Namshi?
8. Do you or Naz have seller-portal access to export the image-rule pages of Amazon.ae and .sa, Namshi, Trendyol,
   Shein, 6thStreet and VogaCloset?
9. Should DD1 approval item (c) be closed as superseded by your 2026-10-22 decision (no Styli enlargement cap), with
   a soft-image note on Styli and Centrepoint in its place?

Status: done
