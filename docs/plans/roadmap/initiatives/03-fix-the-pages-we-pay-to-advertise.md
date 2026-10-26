# Initiative 03 - Fix the pages we pay to advertise

Date: 2026-10-26. Documents only; nothing was built or changed. No time or effort estimates (owner rule).
Part of the GCC catalog roadmap: order, money and merges come from `../07-roadmap.md` ("Initiative 3 - Fix the
pages we pay to advertise"); this file adds the detail behind that section. It covers L1 (weak ad pool), the 187
Amazon ASINs and L4 (footwear missing views), merged as in 07 "How the order was decided".

**Source codes** (same as 07). 01 marketing data, 02 liveness data, 03 image audit, 04 India learnings, 05 build vs
buy, 06 metrics and impact model v2, 07 roadmap (all in `docs/plans/roadmap/`); DD = `docs/plans/deep-dives/`.
New in this file, all read only, run 2026-10-26:
- **Q-W** - the 01 s2.6 weak-pool query re-run at option level with a per-option "wasted spend" column and the
  top channel-country per option (`gcc_marketing.ads_daily`, dates 2026-07-26 to 2026-10-23, softline, brand logic
  as 01 s2). It reproduces 01 exactly: 236 options, 30,513 USD, ROAS 1.75.
- **Q-A** - the 02 "Target list logic" query (Amazon traffic 2026-07-26 to 2026-10-23, live on 24 Oct) grouped to
  option level. It reproduces 02 exactly: 187 ASINs (UAE 72, KSA 115), 15,805 and 23,922 sessions.
- **Q-T** - latest Trendyol UAE image URLs (`gcc_channel_reports.product_list_trendyol_3p_uae`, file 2026-10-22)
  for 11 target options, joined on `master_sl.ean`; images downloaded from the public Trendyol CDN.
- **P-A** - three public Amazon.ae product pages fetched read only (B0GP736DYD, B0GPR4L73H, B0GP72Y4X7).
No PII column was read, no paid call was made. Query files and contact sheets are in this session's scratchpad
(`...\scratchpad\init03\`).

**Labels.** (exact) = a direct count or sum; (approx) = derived, joined, annualised or rounded; (judged) = an
assumption. Annualising a 90-day figure: x 365 / 90 = x 4.056 (06).

## Summary

1. 27.3% of softline ad spend (30,513 USD in 90 days) goes to 236 products converting below 70% of their brand: ROAS 1.75 vs 4.25.
2. 187 live Amazon ASINs (141 products, 114 US Polo) had 39,727 sessions in 90 days and sold 52 units.
3. Fix those pages first: +10% conversion = +10% ROAS, or 9% less spend for the same sales.
4. "Fix" = channel-rule render, right photo first, missing views filled, product as hero, broken titles corrected.
5. A guard runs first: stock, size run, price and rating must not be the real blocker.
6. Live check of 7 targets: 4 have clear content defects; 3 US Polo galleries are complete (titles are not).
7. Revenue (L4): low 0 / base 13.0k / high 51.9k USD a year. Ad money saved, separate: 0 / 5.0k / 11.0k.
8. Run cost up to 91 USD one-off; about 140 USD of base revenue per USD.
9. Hybrid: build lists and fixes on our platform; buy only a generator for views brands cannot supply.
10. Proof: holdout cells on Namshi and Noon ad CVR and Amazon unit session %.

## Problem, with evidence and real examples

### P1. A quarter of softline ad money lands on pages that do not convert

- Softline, last 90 days: 111,752 USD spend, CVR 1.64%, ROAS 3.39 (exact, 01 s2.2).
- Weak pool = options with at least 200 clicks and CVR below 70% of their brand's CVR (the dashboard's own weak
  rule with a higher click floor): 236 options, 30,513 USD (27.3%), ROAS 1.75 against 4.25 for the other 467
  well-clicked options (exact, 01 s2.6; reproduced by Q-W).
- The pool's clicks: 185,023; units: 1,432; CVR 0.77% (exact, Q-W). The softline average is 1.64%.
- Where the money sits (Q-W, top channel-country per option): Namshi is the main channel for 173 of the 236
  options (24,964 USD), Noon for 56 (5,157 USD), Amazon for 7 (395 USD) (exact).
- By brand (exact, 01 s2.6): US Polo 11,521 USD weak (20.8% of its spend), French Connection 5,486 (40.2%), Campus
  4,290 (25.4%), Penti 3,238 (33.7%), Cardio Bunny 2,634 (43.2%), Keds 1,825 (34.4%), Vero Moda 1,518 (30.7%).
- **Wasted spend** (new, Q-W): spend x (1 - option CVR / brand CVR), the part of the spend that bought clicks the
  same orders would not have needed at the brand's normal conversion. Pool total 16,148 USD in 90 days (approx),
  about 65.5k a year (x 4.056). This ranks the target list; it is not a saving claim (the claim is 06 L1 below).
- 44.6% of the weak spend (13,602 USD in 90 days) sits on brands' measured content-defect shares: apparel framing
  or missing shots, footwear missing a core view (approx, 06 "L1").

### P2. High-traffic Amazon pages almost never sell

- Rule (02): live softline ASIN, at least 100 sessions in 90 days (above the country's 75th percentile), unit
  session % below half the country rate (UAE 1.19%, KSA 0.85%).
- 187 ASINs: UAE 72 with 15,805 sessions, KSA 115 with 23,922 sessions; missed units about 162 and 178 (02).
- Units actually sold: 26 in UAE (0.16% of sessions) and 26 in KSA (0.11%) (exact sums, Q-A).
- At option level the 187 ASINs are 141 products: US Polo 114, Campus 25, French Connection 2 (exact, Q-A; sizes
  of one style-colour have separate ASINs). 26 of the 141 are also in the weak ad pool, so the combined queue is
  236 + 141 - 26 = 351 products (approx, option-key match).
- Top examples (Q-A): US Polo `MEDI GLB 6FX MEN OD KHAKI`, Amazon UAE, 5 ASINs, 1,443 sessions, 2 units; US Polo
  `TETSY GLB 6FX MEN OD NAVY`, Amazon UAE, 828 sessions, 0 units; US Polo `6M PERRY S GLB 6FX MEN OD BLUE`, Amazon
  KSA, 1,045 sessions, 1 unit.
- Amazon softline revenue is small (about 35k USD net in 12 months on live listings, 02), so this list matters
  most as the place where conversion is measured per page view, not as a revenue pool.

### P3. Footwear pages miss core views, and nothing fills them today

- Footwear missing one of the 5 core views (side, pair, top, sole, back): US Polo 7 of 20, Campus 10 of 15 (no
  back view), Keds 0 of 7 (exact on sample, 03).
- Campus sets also mix a padded 600x800 lifestyle into square sets (11 of 15); US Polo mix a padded 600x800
  portrait into 7 of 20 sets (03).
- No bucket fills footwear views today; the apparel generator does not apply (06 "L4").

### P4. The tempting explanation for US Polo is wrong

- "US Polo main images are cut at the frame on Amazon" is not supported: 0 of 20 US Polo products fail the Amazon
  main rule (03; 06 Worked example 1). The live check below confirms clean, white Amazon main images.
- So US Polo's gap is conversion with mostly complete galleries; price, sizes, ratings and titles must be checked
  before the gallery is blamed (P5 and "Live page check").

### P5. Content is not the only blocker

- 71.4% of live, stocked options sold nothing in 90 days, and 49% of pool stock sits on them (02).
- 01 s3 finds no link between image count and CVR (ratio 0.954, 9 of 18 cells each way). More photos alone are
  not the fix; the right photo in the right place might be.
- Hence the guard in this initiative: a page is a content target only when it is live, stocked, has an unbroken
  size run and no price or stock reason (02 "Proposed rule"; `fact_gcc.cut_size_option_daily`).

### Live page check (3 to 5 targets, done for 7)

Method: Trendyol UAE images from Q-T (Trendyol serves 1200x1800; the ads run on Namshi and Noon, whose galleries
were not opened, so Trendyol stands in for "brand files as received", which 03 found true for about 9 in 10
listings). For the US Polo Amazon targets, the real Amazon.ae pages (P-A). Background = median of a 2% border strip.

| Product (brand, ad or traffic channel) | What the live page shows | What is wrong | Fix |
|---|---|---|---|
| US Polo `LEAN GLB 6FX MEN OD WHITE`, Namshi KSA (top target, 2,232 USD, CVR 0.88% vs brand 1.80%) | Trendyol: 6 views (side, inside side, back, angle, top, sole) on light grey #F6F6F6, plus a generic US Polo size chart. Amazon UAE B0GPR4L73H: white main plus 5 views, 182 AED (220 struck), title "U.S. POLO ASSN. Men's 102065909 Low-Top Sneakers, White, 42" | Gallery complete. The shoe fills only the middle third of the 2:3 canvas (square photo padded). Amazon title carries an internal number, not the model name. Trendyol list price 469 AED, the highest of the top US Polo options (01 s2.5) | Guard first: price and size run. Then re-render so the shoe fills the frame; correct the Amazon title. Not a missing-view case |
| US Polo `TETSY GLB 6FX MEN OD NAVY`, Amazon UAE (828 sessions, 0 units) | Amazon B0GP736DYD: white, tightly cropped main (1500x580), then side, angle, top, back, sole on #F6F6F6; 126 AED; 4.5 stars on 2 reviews; title "Men's 102065916 Low-Top Sneakers, Navy, 42". Trendyol: same 6 views plus size chart | Gallery complete; no size chart and no on-foot shot on Amazon; title is a code, not "Tetsy". A page with 0 sales on 828 visits is unlikely to be explained by photos alone | Guard (size run, buy box, delivery); title correction; add the size chart image on Amazon |
| US Polo `MEDI GLB 6FX MEN OD KHAKI`, Amazon UAE (1,443 sessions, 2 units) | Amazon B0GP72Y4X7: white main plus 5 views, 148 AED, 3.4 stars on 3 reviews; title "Men's 102063983 Low-Top Sneakers, Khaki, 44" | Gallery complete; the low rating is a product-voice signal, not a photo one; title is a code | Route the rating to initiative 4 (review themes); title correction; no generation |
| French Connection `FC225B21 Blue OD` handbag, Namshi UAE (569 USD, CVR 0.33% vs brand 1.10%) | Trendyol: 8 images; image 1 a model wearing the bag (bag small in frame), images 2 to 6 close-ups, the clean packshots last (7, 8) and small in frame | Order: the product shot that shows the whole bag is last. Amazon and Noon want the product, whole, first (03 "Defect rates per channel rule"; 03 found FC bags open on a model) | Reorder: packshot first and re-rendered to fill the frame; keep one worn shot; drop one of the near-duplicate close-ups (Trendyol cap 8) |
| Cardio Bunny `HCB-226-007-0 OFF White OD` T-shirt, Namshi KSA (598 USD, ROAS 1.19) | Trendyol: 4 images, all on light grey #F1F1F1: three full-length model shots where the trousers take most of the frame, one close-up cut at the mouth | The T-shirt is not the hero: no front mid-thigh shot, no packshot; close-up crosses the face (a head cut under DD1's rule); only 4 images | Apparel fix with initiative 2: derive a front mid-thigh crop where resolution allows, keep full length second; generated views wait for initiative 5's gate |
| Campus `22G-677 NORTH_NAVY-WHT`, Namshi KSA (660 USD, ROAS 0.99) | Trendyol: side, angle, back angle on white, a pink skateboard lifestyle, a size chart | Missing top, sole and pair views (the L4 defect, matching Campus 10 of 15 in 03) | Ask Campus for top, sole and pair views; generate only if they cannot supply and rights allow |
| Keds `KW-BLISAL-5 White`, Namshi KSA (566 USD, CVR 0.45% vs brand 0.78%) | Trendyol: 8 images (at the cap): side on white, a seated lifestyle with the face hidden, angle, sole, top, inside side, a callout infographic, a size chart | Views complete; the shoe fills about a third of the width on the main image (03 saw this on Keds); lifestyle is image 2 | Re-render the main so the shoe fills the frame; lifestyle moved later; no new image (cap) |

What the check says (approx, 7 pages, one reviewer):
- Real, fixable content defects on 4 of 7: order (FC bag), product not the hero plus head cut (Cardio Bunny),
  missing views (Campus), product small in the main frame (Keds, and US Polo on Trendyol's 2:3 canvas).
- The 3 US Polo galleries are complete on Amazon and Trendyol. Their titles show an internal number in place of
  the model name on all 3 Amazon pages (exact on P-A), and one has a 3.4-star rating. For these, title, price,
  sizes and rating are the first suspects, not photos.
- This matches the money model: L4 counts only the 7 of 20 US Polo pages that miss a view (06), not every US Polo
  page.

## Who it serves

| Who | What they get |
|---|---|
| Naz (Tarannum Naaz) and the GCC catalog team | One ranked work queue of advertised and high-traffic pages, each with its guard result, the defect found and the fix to make, instead of fixing the whole catalogue in no order |
| GCC marketing team and the ad agencies | Fewer ad dollars on pages that do not convert; a list of options to hold steady during the test; a measured answer to "does fixing the page lift ROAS?" |
| Nitin Kiran and the GCC business team | The one initiative where the content effect can be seen in ad and session data within one 90-day window, so it is the first proof for the rest of the roadmap |
| Brand teams (US Polo, Campus first) | A short, specific request for missing views and correct model names, per product |

## Metrics it moves, and today's baselines

| Metric | Definition | Baseline (source) |
|---|---|---|
| Weak-pool share of softline ad spend | spend on 200+ click options with CVR < 70% of brand / softline spend | 27.3% (30,513 / 111,752 USD, 90 days), ROAS 1.75 vs 4.25 (01 s2.6) |
| Weak-pool CVR | ad units / ad clicks on the pool | 0.77% (1,432 / 185,023) (Q-W) |
| Wasted spend in the pool | sum of spend x (1 - CVR / brand CVR) | 16,148 USD in 90 days (approx, Q-W) |
| Top-20 target CVR and ROAS | as above, on the 20 options below | CVR 0.78% (448 / 57,597); ROAS about 1.63 (spend-weighted, approx) (Q-W) |
| Softline ad CVR / ROAS | all softline, 90 days | 1.64% / 3.39 (01 s2.2) |
| Amazon unit session %, softline | units / sessions, live ASINs, 90 days | UAE 1.19%, KSA 0.85% (02) |
| Unit session % on the 187 ASINs | units / sessions | 0.13% (52 / 39,727) (Q-A) |
| High-traffic low-conversion ASINs | 02 rule | 187 (UAE 72, KSA 115) (02) |
| Footwear core-view completeness | all 5 views present | US Polo 13 of 20, Campus 5 of 15, Keds 7 of 7 (03) |
| Amazon titles with the model name | titles naming the style, not an internal number | 0 of 3 checked US Polo targets (P-A); not measured at scale |

Secondary (from 06 "Metrics"): CTR, net units per option-day, liveness and rejections of treated listings.

## Target list

Top 20 products in the weak ad pool by wasted spend, last 90 days (exact sums from Q-W; wasted spend approx).
Spend, clicks, CVR and ROAS are for the product across all its ad channels; "Main channel" is the channel-country
with the most spend and that channel's share. "Channel SKU" is the ad file's `channel_sku_code` there (for Namshi,
our parent ZSKU). Brand CVR is the brand's softline ad CVR (01 s2.4).

| # | Brand | Product (style-colour) | Main channel (its spend) | Channel SKU | Spend USD | Clicks | CVR (brand) | ROAS | Wasted USD |
|---|---|---|---|---|---|---|---|---|---|
| 1 | US Polo | LEAN GLB 6FX MEN OD WHITE | Namshi KSA (1,548) | Z9BB4482C194A00460BDCZ | 2,232 | 11,219 | 0.88% (1.80%) | 2.18 | 1,141 |
| 2 | French Connection | FC225B21 Blue OD | Namshi UAE (303) | Z6ACD5E50B3A831DD2636Z | 569 | 3,646 | 0.33% (1.10%) | 1.15 | 399 |
| 3 | US Polo | 5M JOHNNY GLB 5FX OD WHITE | Namshi KSA (681) | Z5827DC8965ABC90EEA18Z | 781 | 4,246 | 1.04% (1.80%) | 2.48 | 333 |
| 4 | French Connection | 71YNV BUTTER YELLOW OD | Namshi KSA (364) | ZBE7CA57CA2F995033B94Z | 394 | 2,472 | 0.28% (1.10%) | 0.92 | 293 |
| 5 | Cardio Bunny | HCB-226-007-0 OFF White OD | Namshi KSA (444) | Z57541EAF995B08F661FEZ | 598 | 3,261 | 1.38% (2.57%) | 1.19 | 277 |
| 6 | Penti | PN5VD1T526IY BLUE OD | Namshi KSA (364) | ZD142D0E84DE8E5581F26Z | 471 | 2,763 | 1.23% (2.59%) | 1.98 | 247 |
| 7 | Campus | S3025-01 | Namshi KSA (351) | ZF100258ABAC6FAECABB4Z | 366 | 1,852 | 0.38% (1.09%) | 0.72 | 239 |
| 8 | Keds | KW-BLISAL-5 White | Namshi KSA (481) | ZD6CEFFD924D01020E01FZ | 566 | 3,544 | 0.45% (0.78%) | 1.17 | 237 |
| 9 | US Polo | 6P KENA JR GLB 6FX GIRL OD POWDER | Namshi KSA (237) | Z70884A3F077C2D1D605FZ | 304 | 1,854 | 0.49% (1.80%) | 1.25 | 223 |
| 10 | Campus | 22G-677 NORTH_NAVY-WHT | Namshi KSA (468) | ZFD1C2DE6EBC54D67A78EZ | 660 | 3,721 | 0.73% (1.09%) | 0.99 | 221 |
| 11 | French Connection | FC225B15 Black OD | Namshi KSA (281) | ZD9EA81FBB54054DE34EFZ | 494 | 3,200 | 0.63% (1.10%) | 2.52 | 213 |
| 12 | Penti | PN2O6LZK25SK LIGHT BLUE OD | Namshi KSA (163) | ZE23313A779C8C96C3EC2Z | 320 | 1,676 | 0.89% (2.59%) | 0.74 | 209 |
| 13 | French Connection | FC225B01 Pink OD | Namshi KSA (270) | ZED5ADB3899B1740E3A2CZ | 309 | 2,174 | 0.37% (1.10%) | 1.53 | 206 |
| 14 | US Polo | KARES GLB 5FX OD WHITE | Namshi KSA (101) | Z4A4181796742506098EFZ | 248 | 1,867 | 0.59% (1.80%) | 2.13 | 167 |
| 15 | Vero Moda | VM_10356039_WINTER_PEAR_OD_L | Namshi UAE (172) | Z1AF5AA9DC9167FCD56A9Z | 209 | 1,023 | 0.29% (1.45%) | 0.92 | 167 |
| 16 | Campus | 22G-13365 NECTER_Blk-DGry | Namshi KSA (253) | ZC98E2E3FBB61878BA247Z | 294 | 1,447 | 0.48% (1.09%) | 0.66 | 164 |
| 17 | Penti | PLRLQCDZ20SK SKIN OD | Namshi KSA (153) | Z2CCBF057AA42A79A234FZ | 534 | 3,229 | 1.80% (2.59%) | 1.89 | 163 |
| 18 | US Polo | 5M PALOMA GLB 5FX OD WHITE | Namshi UAE (149) | Z1C4958679B3C9CFEF1ABZ | 332 | 1,933 | 0.93% (1.80%) | 2.64 | 161 |
| 19 | French Connection | 71ZCN BLUE MULTI OD | Namshi KSA (179) | Z51B88C401528FFA5310DZ | 214 | 1,218 | 0.33% (1.10%) | 0.83 | 150 |
| 20 | Campus | NT-558-K-BLK-GOLDEN | Namshi KSA (188) | ZCFA0742B1E6B89D3EF75Z | 202 | 1,252 | 0.32% (1.09%) | 0.38 | 143 |
| | **Top 20** | | Namshi main channel for all 20 | | **10,097** | **57,597** | **0.78%** | **about 1.63** | **5,353** |

Reading:
- The top 20 hold 33% of the pool's spend (10,097 of 30,513) and 33% of its wasted spend (5,353 of 16,148) (approx).
- They span all seven advertised softline brands: US Polo 5, French Connection 5, Campus 4, Penti 3, Cardio Bunny,
  Keds, Vero Moda 1 each. Five are in the live check above (rows 1, 2, 5, 8, 10). Row 4's dress showed 4 clean
  model shots on Trendyol and no obvious photo defect, so it goes to the guard first.
- Products 3 (`5M JOHNNY`) and 18 (`5M PALOMA`) and the top product 1 (`LEAN`) are also in the 187 Amazon list.
- Amazon queue (Q-A, by missed units): `MEDI GLB 6FX MEN OD KHAKI` (UAE, 1,443 sessions, 2 units), `TETSY GLB 6FX
  MEN OD NAVY` (UAE, 828, 0), `6M PERRY S GLB 6FX MEN OD BLUE` (KSA, 1,045, 1), `KARES GLB 5FX OD NAVY` (UAE, 657,
  0), `FRANK GLB 6FX MEN OD WHITE` (UAE, 641, 1); full list of 141 in Q-A's output.

## Solution

**Approach: hybrid.** Build the lists, the guard and the fixes on our own platform; buy only image generation, and
only for footwear views a brand cannot supply (07; 05 Recommendation).

### What already exists

- **The weak rule and the data.** The marketing dashboard already computes "% of brand CVR" and flags "CVR below
  70%" (at 20 clicks), and its Actions list joins current stock and broken-size status from
  `fact_gcc.cut_size_option_daily` (01 s1.2, s1.5). Q-W and Q-A are small queries on the same tables.
- **The render platform.** The catalog module already cuts out, renders for 9 channels, checks compliance, runs a
  judge with auto-repair, publishes and logs cost (about 0.004 to 0.012 USD per style-colour) (05; 07 Initiative 2).
- **Initiative 2's additions** (roles per photo, required-role lists and order per channel, caps, head-cut rule,
  cut product out of position 1) are what fix apparel order and framing here (DD1 Recommendation).

### What this initiative adds

1. **One target queue**: the 236 weak ad options and the 141 options behind the 187 ASINs, merged to 351 products
   (approx), ranked by wasted spend (ads) and missed units x price (Amazon). Refreshed from the same tables.
2. **The guard, per product**: live and stocked on the channel; unbroken size run; no price change or price reason;
   rating and review count noted (a low rating routes to initiative 4's review themes, not to a photo fix). Products
   that fail the guard leave the content queue with the reason shown.
3. **The fix, per page.** What "fix" means:

| Part of the page | Apparel | Footwear | Bags |
|---|---|---|---|
| Images (render) | Re-render to the channel rule: background, canvas, product filling the frame, no head cut on the main | Square shots re-rendered so the shoe fills the 2:3 or 3:4 frame; padded 600x800 extras made consistent | Packshot re-rendered to fill the frame |
| Order | Front view first (Noon "front first"); lifestyle never first | Side view first; on-foot and lifestyle last | Whole-bag packshot first; worn shot second |
| Missing roles | Front mid-thigh, back, close-up where derivable from existing shots; generated only after initiative 5's gate | The 5 core views (side, pair, top, sole, back): first ask the brand (US Polo and Campus folders hold 3 to 8 images, 03), then generate with approval | Packshot if missing |
| Title and facts (where relevant) | Model name and colour in the title where the brand data has them; facts from initiative 4 | Same; for example the 3 US Polo Amazon titles that show "102065916" in place of "Tetsy" | Same |
| Size chart | Added where the channel allows and the cap leaves room | Added on Amazon where missing (TETSY has one on Trendyol, none on Amazon) | n/a |

4. **Treatment log entries** for every fixed page (option, channel-country, date, roles, positions, generated flag),
   which initiative 1 defines, so the holdout can read before and after.
5. **First holdout cells**: cell 2 (L1 weak pool, Namshi and Noon) and cell 5 (Amazon 187 ASINs) (06 "Cells").

Out of scope: pausing or cutting bids on unfixed weak options (a marketing action, 06 L1); rewriting all titles and
attributes (initiative 4); lifestyle and infographic images (initiative 6).

Phasing (07 "Phased view"): lists, guard, apparel fixes, brand-supplied footwear views, title corrections and the
first holdout cells start in Phase 1; generated footwear views wait for initiative 5's gate in Phase 3.

## Cost and ROI

All money is USD a year unless stated, from 06 and consistent with 07. People time and margin are excluded (06
Assumptions row 11).

### Revenue: L4 footwear missing views (06 "L4")

```
revenue touched = US Polo footwear 5.911M x 7/20 + Campus 0.788M x 10/15
                = 2.069M + 0.525M = 2.59M
extra revenue   = 2.59M x lift
```

| Case | Lift (judged) | Extra revenue a year |
|---|---|---|
| Low | 0% | 0 |
| Base | 0.5% | 13.0k |
| High | 2% | 51.9k |

The lift is kept low because 01 s3 finds no image-count effect for these brands. The apparel fixes in this
initiative are counted in initiative 2 (B1) and 5 (B2), not here.

### Ad money saved, shown separately (06 "L1")

```
content-linked weak spend (90 days) = US Polo 11,521 x 7/20 + Campus 4,290 x 10/15 + FC 5,486 x 13/19
    + Penti 3,238 x 6/15 + Cardio Bunny 2,634 x 6/15 + Keds 1,825 x 0 + Vero Moda 1,518 x 6/15 = 13,602
a year = 13,602 x 4.056 = 55.2k
spend saved at the same ad sales = 55.2k x x / (1 + x), where x = CVR lift
```

| Case | CVR lift on fixed pages (judged) | Ad money saved a year |
|---|---|---|
| Low | 0% | 0 |
| Base | 10% | 55.2k x 0.10 / 1.10 = 5.0k |
| High | 25% | 55.2k x 0.25 / 1.25 = 11.0k |

Why it works, in plain words: ACoS = cost per click / (CVR x price) (01 s4). If the same clicks turn into 10% more
orders, every ad dollar brings 10% more sales; or the agencies can buy 9% fewer clicks for the same sales.

**Do not add this to the revenue line.** It is another reading of part of the same lift: take the ad-driven part
as extra sales at the same spend (9.7k at base, 55.2k x 1.75 x 10%) or as spend saved (5.0k), not both (06 "Do not
add the money-saved column"). It is the only ad saving counted in the roadmap (07).

### Cross-check, not added: the 187 Amazon ASINs (06 Worked example 1)

```
ceiling a year = (162 missed units UAE x 36.79 USD + 178 KSA x 42.23 USD) x 4.056 = 54.7k
```
Closing a quarter of the gap (judged) = 13.7k (low 10% = 5.5k, high 50% = 27.3k). It overlaps L4 and initiative 6
on the same US Polo pages and uses gross ordered sales, which disagree with the net table (06), so it is a check on
L4's size, not extra money.

### Run cost and ROI

| Item | Cost | Source |
|---|---|---|
| Generated footwear views | up to about 91 USD one-off: about 455 style-colours x 1 view x 0.20 USD per accepted image | 06 "L4" |
| Brand-supplied views | 0 | 06 "L4" |
| Apparel re-render and reorder | inside initiative 2's 77 USD | 07 |
| Target list, guard, title list | queries on existing tables; no generation cost | this file |
| Recurring | not sized | 07 Total budget |

| Case | Year-one run cost | Base revenue per USD of run cost |
|---|---|---|
| Low | 0 (all views brand-supplied) to 91 | 0 |
| Base | 91 | 13.0k / 91 = about 140 (plus 5.0k ad money) |
| High | 91 | 51.9k / 91 = about 570 |

These ratios show run cost does not limit this initiative; they are not profit figures (07).

## Risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| 1 | Content is not the blocker on many targets: the 3 US Polo galleries checked are complete; 71.4% of live stocked options sell nothing (02) | Fixes earn nothing on those pages; L4 overstated if the 7 of 20 defect share is high | Guard before any fix; route price, size and rating causes to their owners; report the guard's drop-out rate |
| 2 | Every lift is judged (L4 0.5%, L1 10%); 01 s3 finds no image-count effect | Money rows scale with the lift | Holdout cells; drop L4 if the cell shows nothing |
| 3 | Agencies change bids, budgets or targeting during the test (01 s3: spend follows sellers) | ROAS moves for reasons unrelated to the page | Written bid and budget freeze for test options; read CVR, which bids move less than spend |
| 4 | Small samples: audit brand rates rest on 5 to 20 products, one reviewer, plus or minus about 3 (03); the live check is 7 pages | Defect shares and the list of fix types move | Treat as direction; role tags on live listings (initiative 1) replace samples |
| 5 | Trendyol stands in for Namshi and Noon galleries (no Namshi content export) | A Namshi page may differ from what was checked | Open the Namshi and Noon pages for each target before fixing; ask Namshi for a content export (initiative 1) |
| 6 | Overlap with initiatives 2, 4, 5, 6 on the same pages | Double counting, or two teams editing one page | Money counted once as in 06 "Overlaps"; one treatment log; one owner per page |
| 7 | Image caps (Trendyol 8, Amazon 9): Keds already at 8 | Adding a view drops another image | Caps from initiative 2; owner sets the priority (DD4 Q3) |
| 8 | Generated footwear views without brand rights | Brand or channel objection | Brand-supplied first; generation only with written rights and initiative 5's gate |
| 9 | The ad saving is small (5.0k base) | Over-selling it hurts trust | Lead with the 27.3% fact and the measured CVR change, not the saving (06 Worked example 2) |

## How we measure success

**Design: holdout, difference in differences** (06 "Measurement plan"). Unit = style-colour on one channel-country.
Pair targets by brand, channel-country, price tercile and past clicks; fix one of each pair, leave the other;
compare change in CVR before and after, treated against control, by option-week, errors clustered by option.
Eligibility: live, stocked, unbroken size run, no price, bid or budget change during the test.

| Cell | Where | Primary metric | Baseline | What we can detect (approx) |
|---|---|---|---|---|
| 2 - L1 weak pool | Namshi and Noon Sponsored Products, the 236 options (Namshi main channel for 173, at least 96,914 Namshi clicks in 90 days, Q-W) | Ad CVR (ad units / ad clicks) | 0.77% (Q-W) | With the pool's 185,023 clicks in one 90-day window split in two, about a 20% relative lift or more (n per arm = 7.84 x [p1(1-p1) + p2(1-p2)] / (p2 - p1)^2, x2 for clustering, 06). The judged 10% is below that; reaching brand CVR is at least +43% by the pool's definition, so a fix that closes half of that gap is visible |
| 5 - Amazon | The 141 options behind the 187 ASINs | Unit session % | 0.13% (52 / 39,727, Q-A) | Closing a quarter of the gap (about 85 more units, to about 0.35%) needs about 32,000 sessions across both arms, inside one 90-day window (39,727). A 25% relative lift on 0.13% is not detectable |

Secondary: CTR, ROAS, net units per option-day, liveness and rejections of treated listings.

**Success looks like** (proposed, owner to confirm):
- Treated weak options show a CVR gain over controls that is statistically clear in cell 2 or cell 5.
- Weak-pool share of softline ad spend falls from 27.3% and the pool's ROAS rises from 1.75, with agencies' bids
  held, read on the dashboard's own weak rule.
- Every fixed page has a treatment log entry and a guard result; the share dropped by the guard is reported.
- If a cell shows nothing, L4 and L1 are cut to 0 in the model and the roadmap says so.

## Dependencies

| Needs | From | Why |
|---|---|---|
| Treatment log, holdout guards, bid freeze process | Initiative 1 | Without them the before and after cannot be read (06: 13% join coverage today) |
| Roles, required order per channel, caps, re-render | Initiative 2 | The apparel fixes and the reorder |
| Approved generation gate and generator | Initiative 5 | Generated footwear views (Phase 3) |
| Facts and title source | Initiative 4 stage A | Title and fact corrections beyond the model name |
| Rights for generated images of their products | US Polo, Campus (DD8; DD4 Q5) | Generated views only |
| Read access to `cut_size_option_daily`, ads and Amazon traffic tables | gcc-dashboard (already readable) | The guard and the lists |

## Owner questions

1. Will the agencies freeze bids, budgets and targeting on the test options and their controls for one 90-day
   window? (06 eligibility guards)
2. Do we ask US Polo and Campus for missing views and correct model names now, before generation is approved?
   Who sends the request?
3. Who owns Amazon titles: this team or India's Catalog v2, which lists Amazon, Noon and Namshi? (04 Q1) The three
   US Polo titles checked show an internal number in place of the model name.
4. When the guard finds a price, size or rating cause, who acts on it (commercial, supply, brand)?
5. Should the marketing team pause or lower bids on weak options that fail the guard, while content work runs on
   the rest? This stays a marketing decision (06 L1).
6. Can Namshi export the live gallery and title per SKU (initiative 1), so targets are checked on the ad channel
   itself rather than on Trendyol?
7. Written rights from US Polo and Campus for generated views of their products, and the vendor data position
   (05 Q2), before any generated view goes live.

Status: done
