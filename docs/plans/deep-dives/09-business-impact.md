# DD9: Business impact of B1 to B8, data-derived

Date: 2026-10-22 (first version B1 to B3; refreshed the same day for B4 to B8). Program: Catalog Connect GCC
(docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md).
This is an investigation, not a spec. Nothing here is implemented. All warehouse numbers were read from
BigQuery project opptra-datawarehouse on 2026-10-22 (read only, metadata and small aggregates, no PII column
selected); every number states its query shape. The refresh queries are kept in the session scratchpad
`C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\d63636f6-cfe2-4e73-8088-d201473357ee\scratchpad\dd9\`
(`feat3.sql`, `b5ch.sql`, `b4ch.sql`, `b2rev.sql`, `rev2.sql`, `ret.sql`, `live.sql`).
Revenue is gross listing price times quantity at fixed rates (AED 3.6725, SAR 3.75 per USD) unless stated.
Rupees at INR 84 per USD, the default in infra/deploy.sh. No model or image spend was made for this refresh.

Words used here:
- **Option**: one row key `option_id_style_color` in master_sl. **Style-colour**: one design in one colour.
  They are the same thing for every brand except Campus, whose 1,012 option ids are 405 style-colours (DD4).
  The agency charges per style; the refresh counts style-colours where money per style is computed.
- **Revenue touched**: trailing 12 months gross revenue of the products a bucket changes.
- **Lift**: the assumed percentage change in that revenue. Low / base / high are judgment, not measurement.

## Summary

- Ranking across B1 to B8 by base-case revenue a year: B1 (USD 92k) > B4 footwear and bags lifestyle
  (USD 69k) > B5 infographics (USD 60k) > B6 attributes and listing fill (USD 37k plus about USD 1.0k a year
  cash) > B7a review-driven fixes (USD 24k) > B2 fill the shot list (USD 23k, corrected down) > B3 flat lay
  to on-model (USD 13k). B7b and B8 are outside the catalog team (DD10) and are not ranked. Confidence is low
  on every revenue row; differences between neighbours are inside the uncertainty.
- Program base about USD 0.32M a year of extra revenue on a softline base of about USD 9.2M (low about
  USD 0.01M, high up to about USD 0.97M; the highs overlap on the same USPA pages and do not add up).
- US Polo Assn. drives most of it: USD 5.9M of the softline revenue, all of it footwear (master_sl has no USPA
  apparel). Any bucket that improves USPA footwear pages (B1, B4, B5) dominates the money.
- Correction to B1 to B3: master_sl USPA is footwear, not part apparel, and 77 of the under-5-image options
  are USPA footwear carrying USD 1.46M of the USD 1.95M "under 5 images" revenue. B2's apparel engine cannot
  fill footwear views, so B2's revenue touched drops from USD 2.1M (assumed) to USD 0.47M (measured), and its
  base from USD 106k to USD 23k. B1 to B3 together: base USD 211k becomes USD 128k.
- Correction to the cash line: the agency's INR 60 covers images and template filling, and nobody has the
  split (DD5 owner question 6). With an assumed 50 / 50 split (range 30 / 70 either way), B1 saves about
  INR 94k (USD 1.1k) a year and B6 about INR 82k (USD 1.0k) a year; together about INR 1.8 lakh (USD 2.1k),
  close to the first version's B1-only figure, which assumed the whole INR 60 goes away.
- Run costs stay small next to the revenue: one-off backlogs B2 USD 32, B3 USD 121, B4 USD 244, B5 up to
  about USD 481, B6 USD 240, B7a up to about USD 190 (Noon actor fallback only).
- The real constraint is still capacity: the manual route makes about 1,300 images a year; the open
  backlogs are 1,540 (B2) + 605 (B3) + 1,222 (B4) images, plus 1,560 callout and up to 1,061 footwear panel
  images (B5).
- New source sized for B5: 467 style-colours have 2 or more feature claims in Opptra's own master
  (sku_master_p2p); 1,560 have them once Trendyol listing text is counted (proposed facts that Naz must
  confirm). The first figure is what may be drawn without a person confirming anything.

## Findings

### 1. Addressable softline options and SKUs

Source: raw_gcc_dimensions.master_sl (16,612 rows, createdDate 2026-10-21 07:34). Query shape:
`SELECT brand, COUNT(DISTINCT ean), COUNT(DISTINCT option_id_style_color), COUNT(DISTINCT IF(TRIM(<channel col>)<>'', option_id_style_color, NULL)) ... GROUP BY brand`.
Channel columns hold the channel's own id (Styli 10-digit ids, Centrepoint 9-digit, Amazon ASIN, Noon SKU),
blank when not listed; a non-blank id is read as "present on that channel".

| Brand | SKUs (EAN) | Options | Noon | Namshi | Trendyol | Centrepoint | 6thStreet | Styli | Amazon | VogaCloset | Shein |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Campus | 1,792 | 1,013 | 1,013 | 1,013 | 696 | 0 | 632 | 741 | 820 | 219 | 800 |
| French Connection | 3,889 | 900 | 899 | 899 | 810 | 363 | 454 | 120 | 400 | 0 | 0 |
| U.S. Polo Assn. | 2,974 | 529 | 529 | 529 | 529 | 466 | 461 | 430 | 448 | 56 | 397 |
| Penti (two spellings) | 3,290 | 616 | 616 | 616 | 613 | 528 | 410 | 569 | 544 | 112 | 0 |
| Puma | 972 | 190 | 0 | 0 | 188 | 97 | 0 | 0 | 0 | 0 | 0 |
| Nautica (two spellings) | 848 | 159 | 156 | 156 | 141 | 0 | 79 | 0 | 31 | 0 | 0 |
| Vero Moda | 1,207 | 121 | 102 | 103 | 99 | 91 | 92 | 96 | 28 | 0 | 0 |
| Cardio Bunny | 513 | 119 | 119 | 119 | 119 | 92 | 92 | 119 | 94 | 0 | 0 |
| Keds | 673 | 106 | 106 | 106 | 105 | 0 | 105 | 105 | 72 | 0 | 0 |
| French Connection UK | 200 | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Total | 16,358 | 3,754 | 3,540 | 3,541 | 3,300 | 1,637 | 2,325 | 2,180 | 2,437 | 387 | 1,197 |

Option-channel pairs: 20,544 (Noon and Namshi counted once each; counting AE and SA separately gives
about 27,600). The known figures in the brief (FC 900, Campus 1,013, Penti 616, USPA 529, Puma 190, Nautica
159, VM 121, CB 119, Keds 106) are confirmed exactly. "French Connection UK" is 200 SKUs with a blank
option id and is excluded from option counts.

Corrected in the refresh (DD0, DD4, DD5 evidence): (a) Campus's 1,013 option ids are 405 style-colours
(`COUNT(DISTINCT name || colour)` = 405, distinct image URLs 407; DD4 counted 406). Counted in style-colours
the catalogue is 3,141 (not 3,754) and the option-channel pairs about 17,270 (not 20,544). The agency bills
per style, so cash figures below use 3,141. (b) The first version's apparel split (apparel about 2,170,
including USPA 240) was wrong: every USPA option in master_sl is footwear (DD4 F1, DD5 "USPA stays
footwear only"). DD0's classification is the one to use: 1,746 apparel, 1,744 footwear option ids (1,146
footwear style-colours), 76 bags, 25 accessories, 86 home fragrance, 71 unknown. The 5-on-model-shot rule on
Styli and Centrepoint applies to the 1,746 apparel options.

Channel SKU coverage, source dimensions.unified_sku_master_gcc (90,400 rows). Query shape:
`SELECT channel, COUNT(*), COUNT(DISTINCT channel_sku), COUNT(DISTINCT IF(in_master_sheet_sl, opptra_sku, NULL)) ... GROUP BY channel`.
Rows per channel: Namshi 26,106, 6thStreet 15,150, Noon 13,575, Styli 11,461, Trendyol 10,888, Centrepoint
6,606, Amazon 6,400. Distinct softline Opptra SKUs: Noon 12,894, Namshi 13,053, Trendyol 10,646, 6thStreet
7,571, Centrepoint 6,606, Styli 5,316, Amazon 5,262. The brief's figures (Noon 14.7k, Namshi 14.7k,
Trendyol 14.4k, 6thStreet 9.4k, Amazon 9.1k, Styli 8.9k, Centrepoint 8.5k) are higher than any count this
table gives today; they were probably taken from an older snapshot or counted rows across countries.
Treat the brief's channel SKU figures as unverified; the ones above are exact as of 2026-10-22.

### 2. Options lacking required roles

Trendyol is the only channel whose listing report carries image URLs (image_1 to image_8). Source:
gcc_channel_reports.product_list_trendyol_3p_uae and _ksa, file_date 2026-10-21. Query shape: count
non-blank image_n per row, take MAX per (brand, model_code, product_color), aggregate per brand.

| Brand | Trendyol options UAE / KSA | Avg images UAE / KSA | Fewer than 5 (UAE / KSA) | Fewer than 4 (UAE / KSA) | 1 or fewer (UAE / KSA) |
|---|---|---|---|---|---|
| French Connection | 824 / 826 | 5.06 / 5.06 | 302 / 304 | 155 / 152 | 0 / 0 |
| Penti | 690 / 647 | 4.72 / 5.53 | 264 / 209 | 84 / 63 | 6 / 6 |
| U.S. Polo Assn. | 547 / 546 | 5.87 / 5.30 | 82 / 175 | 2 / 6 | 0 / 0 |
| Campus | 380 / 380 | 7.07 / 6.56 | 1 / 1 | 0 / 0 | 0 / 0 |
| Vero Moda | 306 / 307 | 4.08 / 4.19 | 113 / 112 | 87 / 90 | 64 / 66 |
| Nautica | 208 / 211 | 4.41 / 5.84 | 105 / 46 | 15 / 6 | 0 / 1 |
| Puma | 189 / 206 | 5.46 / 5.51 | 42 / 43 | 28 / 28 | 0 / 1 |
| Keds | 169 / 110 | 7.83 / 7.32 | 0 / 0 | 0 / 0 | 0 / 0 |
| Cardio Bunny | 135 / 135 | 5.53 / 5.53 | 34 / 34 | 13 / 13 | 1 / 1 |

The brief's figures (FC 155/824, VM 87/306, Penti 84/690 with fewer than 4; 4.1 to 7.8 images per option)
are confirmed exactly on UAE.

Mapped back to master_sl options by barcode = EAN (query shape: join product_list barcode to master_sl ean,
MAX images per option across both countries): 3,315 of 3,754 master options are on Trendyol.

| Brand | Master options | Matched on Trendyol | Fewer than 5 | Fewer than 4 | Fewer than 3 |
|---|---|---|---|---|---|
| Campus | 1,013 | 705 | 1 | 0 | 0 |
| French Connection | 900 | 811 | 300 | 151 | 43 |
| U.S. Polo Assn. | 529 | 529 | 77 | 1 | 0 |
| Penti (both) | 616 | 613 | 171 | 45 | 10 |
| Puma | 190 | 188 | 36 | 28 | 26 |
| Nautica | 159 | 141 | 31 | 3 | 0 |
| Vero Moda | 121 | 112 | 31 | 18 | 18 |
| Cardio Bunny | 119 | 119 | 33 | 12 | 2 |
| Keds | 106 | 97 | 0 | 0 | 0 |
| Total | 3,754 | 3,315 | 770 | 258 | 99 |

Reading: B2's "3 of 5 roles" population is 770 options with fewer than 5 listing images. Corrected in the
refresh: the first version called about 700 of these apparel; with USPA footwear removed the apparel share
is about 500 to 560 (on the 2026-10-21 file alone, which gives 680 under-5 options in all: FC 236 after
removing bags and home items, Penti 171, CB 33, Nautica 31, VM 24, plus Puma's apparel part of its 36), and
the 77 USPA options are footwear. Caveats: (a) a listing image count is a proxy for
on-model role coverage, not the same thing: a product can have 6 images and still lack the back view, and
the sixth image may be a flat lay or a swatch; (b) Vero Moda has 306 options on Trendyol but 121 in
master_sl, so master_sl undercounts Vero Moda (reconcile in DD0); (c) Trendyol is the channel with the
loosest requirement (1 image), so what Opptra uploaded there is the best view of what source photos exist.

USPA reconciliation: master_sl has 529 USPA options and 2,974 SKUs. The meeting's "2,700 options with 3
images each" matches the SKU count, not options. On Trendyol USPA averages 5.3 to 5.9 listing images and
only 1 to 6 options have fewer than 4. Either the "3 images" refers to Opptra's own source photos per
product (which the catalog module's product table would show, not the warehouse) or the figure is stale.
The SPEC (R15a) also records "2,700 USPA options now, 3 to 5 images each". Verify from the catalog
module's own product records before planning B2 volume around USPA; the warehouse does not support it.

Other channels: no image counts exist for Noon, Namshi, Styli, Centrepoint, 6thStreet, VogaCloset or
Shein in any warehouse table (checked gcc_channel_reports, raw_gcc_table_cleaned catalog_live_* and
active_listings_*, which carry prices, stock and status only; Amazon active_listings has one image_url).
Proxy used: the Trendyol count above, applied to the same option on every channel.

Blocked on Centrepoint and Styli for lack of 5 shots: fact_gcc.channel_listing_status_daily and
catalog_liveness_daily (snapshot 2026-10-21) cover Amazon, Namshi, Noon and Trendyol only; Styli and
Centrepoint have no listing status feed. Reason buckets present (query shape: `SELECT channel_country,
reason_bucket, COUNT(DISTINCT ean) ... WHERE as_of_date = MAX`) are Not listed, Unknown, Data / item
master, Stock not on channel, Price, Listing blocked; Trendyol portal reasons are Out of stock (9,559 to
10,536 SKUs), Locked, Price missing. No image or content reason exists anywhere.

Proxy for the Styli and Centrepoint block, corrected in the refresh. The first version used 2,170 apparel
options and estimated about 530 apparel options absent from Centrepoint and about 1,330 absent from Styli.
Recounted per option on the apparel brands (query shape in `b2rev.sql`: master_sl options of French
Connection, Penti, Nautica, Cardio Bunny, Vero Moda and Puma, excluding footwear, bag and home-item names,
with a blank `centerpoint_ae_ksa` or `styli_ae_ksa`): absent from Centrepoint FC 377, Penti 87, Nautica 159,
VM 16, CB 24 = 663, plus part of Puma's apparel (about 660 to 750); absent from Styli FC 676, Penti 46,
Nautica 159, VM 12, CB 0 = 893, plus Puma's apparel (about 900 to 980). These are upper bounds; absence can
also be commercial choice.

### 3. Cost today versus the catalog module

Agency: INR 60 per style, all platforms plus listing-template filling (meeting, 2026-10-21). No agency
invoice or cost table exists in the warehouse (confirmed: no dataset or table name matches agency, vendor
cost or studio). DD5 did not find how the INR 60 splits between images and templates (DD5 "Exact costs":
"the template share of the 60 is unknown"; owner question 6). Manual route: ChatGPT by hand at 5 to 6 images
a day (meeting), about 1,300 images a year at 240 working days.

Catalog module cost per style, from the repo's cost accounting (packages/core/src/catalog/cost.ts, SPEC
section "Cost so far", infra/deploy.sh):
- Quality check: measured USD 0.00014 per check on 2026-10-20 (batch b489e466, 52 calls); the wizard
  estimate doubles it to USD 0.0003.
- Compute: 4.3 vCPU-seconds per output (same batch, 2,023 vCPU-seconds for 468 outputs) at USD 0.0000265
  per vCPU-second (Cloud Run Tier 1, request-based), USD 0.000114 per output.
- Per style: 3 sources on 4 channels (12 outputs, one check per output) about USD 0.003 = INR 0.26;
  5 sources on all 9 channels (45 outputs) about USD 0.011 = INR 0.96. The x2 upscaler now on by default
  adds GPU seconds per source; the SPEC's matting benchmark (L4, 24,000 sources for USD 3) suggests well
  under INR 0.5 per style. The UI's illustrative line reads "INR 3.80 per style so far". Working figure:
  INR 1 to 4 per style, exact per batch in the batch page cost line.
- Derived crops (B2 first path): same compute path, effectively INR 0 extra.
- Generated images (B2 second path, B3), prices from DD3 (single generator through OpenRouter's Image
  API): USD 0.10 per image at 2K, USD 0.15 at 4K, USD 0.20 per accepted image once regeneration retries
  are counted (INR 8.4, 12.6 and 16.8). Fidelity checks on top use existing free tooling. The accepted-image
  price is the one used below. (DD3 also quotes "mode B about 0.80 per product (four roles)"; this document
  keeps 5 x 0.20 = USD 1.00 per 5-shot set as the upper figure.)
- Which B2 roles need generation (DD2 sample of 24 options): role 3 fabric close-up missing in 7 of 24
  and role 2 head-to-toe missing in 5 of 24. Fabric is derived by crop (about INR 0); head-to-toe cannot be
  cropped from a shorter shot and is generated, so B2 generates on average 5/24 = 0.21 images per option.

| Route | Per style | Source |
|---|---|---|
| Agency | INR 60 (includes template filling; split unknown, see section 6) | meeting |
| Manual ChatGPT | not priced; throughput 5 to 6 images a day | meeting |
| Catalog module, existing photos (B1) | INR 1 to 4 | cost.ts, SPEC |
| Catalog module, derived crops (B2 derive) | about INR 0 extra | cost.ts |
| Generated head-to-toe (B2 generate, the 5 in 24 options that need it) | INR 16.8 per accepted image; INR 3.5 per option averaged over the B2 population, plus INR 1 to 4 module cost | DD3, DD2 |
| Generated 5-shot set (B3) | 5 x USD 0.20 = USD 1.00 = INR 84 per style (INR 42 at 2K list price, INR 63 at 4K, before retries), plus INR 1 to 4 module cost | DD3 |
| Lifestyle image (B4) | USD 0.20 per accepted image = INR 16.8 per footwear or bag style-colour | DD4 R6 |
| Infographics (B5) | callout USD 0.0108 (INR 0.9); panels from brand photos USD 0.0079 (INR 0.7); footwear panels with 2 generated scenes about USD 0.41 (INR 34) | DD6 |
| Fact sheet and listing copy (B6) | copy about USD 0.064 (INR 5.4) per option, English mid tier plus Arabic high tier; template filling itself is code | DD5 |
| Review themes and fix proposals (B7a) | tagging about USD 0.02 per 1,000 reviews; fix proposals about USD 0.011 per product with new reviews; Noon actor fallback USD 10 per 1,000 results | DD7 |

Annual cost saved, B1 to B3, agency as the comparator:
- B1, first version: 3,754 options x (INR 60 minus INR 2) = INR 217,700 (USD 2.6k) once, INR 194,300
  (USD 2.3k) a year at the SPEC R15a planned inflow of about 3,350 options. Corrected in the refresh: that
  assumed the whole INR 60 disappears when B1 ships, but B1 replaces only the image part, and the
  catalogue is 3,141 style-colours. With the image share at 50% (range 30% to 70%, section 6): INR 30 minus
  INR 2 = INR 28 per style; INR 88,000 (USD 1.0k) once for the catalogue and INR 93,800 (USD 1.1k) a year at
  3,350 a year (range INR 53,600 to 134,000, USD 0.6k to 1.6k).
- B2, 770 options x 2 images: the agency does not generate views, so the comparator is the manual route.
  1,540 images is more than a full year of the manual route's output; crop derivation costs about nothing
  (about 225 fabric crops at 7/24) and generation about 160 head-to-toe images at 5/24, USD 32 = INR 2,700
  for the backlog at USD 0.20 per accepted image. The saving is capacity, not cash. (Unchanged; if the 77
  USPA footwear options are left to B4, the apparel backlog is about 1,390 images and USD 29.)
- B3, Vero Moda 121 options x 5 images = 605 images (half a year of the manual route); generation USD 121
  = INR 10,200 (INR 25,700 if the 306 Trendyol options are the true count). At INR 84 per style a generated
  5-shot set costs more than the agency's INR 60, but the agency does not produce on-model shots from flat
  lays at all, so there is no like-for-like saving; the comparison is against a studio shoot or nothing.
- B1 to B3 cash, corrected: about USD 1.0k to 1.1k a year (B1 only). Too small to rank on; rank on revenue
  and eligibility.

### 4. Revenue base and uplift

Softline revenue base, trailing 12 months (2025-10-22 to 2026-10-21), source fact_gcc.unified_sales.
Query shape: `SUM(SAFE_CAST(order_quantity AS FLOAT64) * listing_unit_price / fx)` grouped by a channel
bucket derived from channel_name and by brand, where brand is brand_name or, when blank, the brand of the
EAN in master_sl or of channel_sku in unified_sku_master_gcc; rows from sales_b2b_unicommerce source tables
and channel names containing B2B, FBN, SOR, CUSTOM or IWIT excluded (these are warehouse transfers and
wholesale, which inflated Noon to USD 13.5M before exclusion). PII columns never selected.

| Channel | Softline attributed USD | Unattributed USD (brand unknown) | Note |
|---|---|---|---|
| Namshi | 6,062,000 | 441,000 | softline channel, so about 6.5M softline |
| Noon | 2,202,000 | 100,000 | USPA 1.90M, Campus 0.20M |
| 6thStreet | 131,000 | 15,000 | |
| Trendyol | 56,000 | 337,000 | unattributed is mixed hard and soft |
| Centrepoint | 43,000 | 143,000 | mixed |
| Styli | 17,000 | 38,000 | softline channel |
| Amazon | 13,000 | 206,000 | Amazon is almost all hardlines |
| Softline total | about 8.5M attributed, about 9.2M including softline-channel unattributed | | |

By brand (attributed, all channels): USPA 6.08M, French Connection 0.72M, Campus 0.79M, Penti 0.40M,
Keds 0.16M, Vero Moda 0.13M, Nautica 0.12M, Cardio Bunny 0.10M, Puma 0.02M. The brief's revenue-to-date
figures (Namshi KSA 3.03M, Namshi UAE 2.35M and so on, hardlines included) are of the same order; they are
not reproduced exactly because unified_sales mixes two source generations and the measure (gross listing
price here) differs. Both are usable for sizing; neither is audited revenue.

New in the refresh, revenue by department (query shape in `rev2.sql`: the same filters, each sales row
mapped to a master_sl option through barcode_ean or channel_sku, department from the option: Campus, Keds
and USPA footwear by brand, Puma footwear and FC / VM bags by name keywords):

| Brand | Footwear USD | Bags USD | Apparel and other USD |
|---|---|---|---|
| U.S. Polo Assn. | 5,911,000 (plus 153,000 on rows not matched to master_sl) | 0 | 0 |
| Campus | 788,000 | 0 | 0 |
| Keds | 159,000 | 0 | 0 |
| Puma | about 0 (94 rows, no price) | 0 | 22,000 |
| French Connection | 0 | 191,000 | 528,000 |
| Vero Moda | 0 | about 400 | 125,000 |
| Penti | 0 | 0 | 403,000 |
| Nautica | 0 | 0 | 120,000 |
| Cardio Bunny | 0 (4,000 on rows named like footwear; ignored) | 0 | 97,000 |
| Total | about 6.86M | about 0.19M | about 1.30M |

Reading: about 82% of attributed softline revenue is footwear, almost all USPA; apparel is about USD 1.3M.

Conversion evidence from our own data:
- Amazon PDP conversion (raw_gcc_table_cleaned.traffic_sales_amazon_3p_uae and _ksa, file_date from
  2026-07-23, unit_session_percentage = units_ordered / sessions_total, brand via unified_sku_master_gcc
  on sku or child_asin): USPA 1.16% UAE (56.7k sessions) and 0.82% KSA (52.0k); French Connection 1.56%
  UAE and 1.43% KSA (under 2k sessions each); Campus 1.37% UAE and 1.01% KSA. Softline on Amazon is tiny
  in revenue, so this is a conversion reference, not a base to apply uplift to.
- Noon PDP conversion (traffic_sales_noon_3p_uae and _ksa, only 2026-01-02 to 2026-02-04 exists): USPA
  1.36% UAE (140k visitors) and 0.87% KSA (182k); Campus 1.21% and 0.81%; Penti 3.15% UAE; French
  Connection 1.67% UAE and 1.08% KSA.
- Ads CVR (gcc_marketing.ads_daily, date from 2026-07-23, ad_units_sold / ad_clicks): Namshi USPA 2.03%,
  FC 1.10%, Campus 1.02%, Penti 2.96%, Cardio Bunny 2.57%, Keds 0.84%, Vero Moda 1.42%; Noon USPA 1.76%,
  Penti 1.73%, Vero Moda 1.72%, FC 0.39%; Amazon USPA 1.38%.
- Image count versus sales on Trendyol: attempted (join product_list barcode to unified_sales
  barcode_ean, Trendyol orders from 2026-04-24, units per option by image bucket within brand and price
  quartile). Only 1,512 of 11,443 Trendyol order lines join (13%; channel_sku matches neither barcode nor
  supplier_stock_code for most rows), and Trendyol softline sales are thin (56k USD attributed), so the
  result is not usable. Directional only: Penti units per option 0.75 (under 4 images), 0.80 (4), 0.89
  (5 plus); Vero Moda 0.01, 0.08, 0.11; the other brands show zero joined sales. Stock differs across
  buckets, so even the direction is confounded. No PDP conversion exists for Namshi, Styli, Centrepoint,
  Trendyol, 6thStreet, VogaCloset or Shein.
- New in the refresh, returns (query shape in `ret.sql`: same filters, softline EANs only, `return_reason`
  grouped by keyword; no PII column read): Namshi carries reasons on 24,755 of 161,309 softline order lines.
  Size or fit is 17,678 lines (USD 0.68M gross, 71% of lines with a reason: "size doesn't fit (too small)",
  "too big", "unsuitable size"); "item not as described" 1,025 lines (USD 32k); quality or damage 2,233
  (USD 83k). Noon's return_reason is blank on all but 62 lines.

Public evidence (web, read 2026-10-22):
- eBay Research Labs (Di, Sundaresan, Piramuthu, "Is a picture really worth a thousand words? On the role
  of images in e-commerce", WSDM 2014), reported second hand by Pixelz
  (https://www.pixelz.com/blog/more-product-images-lead-to-more-sales/, post updated September 2025):
  one image doubled conversion versus none, two doubled it again, multiple views in a slideshow +65%,
  larger photos doubled conversion. Gains beyond two images are smaller. Different marketplace and era.
- Profitero, "The impact of improving content" ROI report (March 2023,
  https://www.profitero.com/reports/impact-of-improving-content): 8,500 PDP changes on 4,000 products on
  Amazon.com and .co.uk, compares sales lift from adding images in the 1 to 4 range versus 5 to 8; the
  public page names the comparison but withholds the percentages. Closest large-sample study to our case.
- Vendor blogs (imagepulser, Westwilscot, threekit, 2020 to 2025) quote 19% to 34% higher conversion for
  listings with 4 to 7 plus images; one admits its dataset is illustrative. Not used for the numbers.
- Nothing public isolates on-model versus flat lay for fashion with a measured lift. Nothing public found
  in this program isolates the lift of a lifestyle image, an infographic, Arabic listing text or
  review-driven size guidance on a GCC marketplace; the B4 to B7a lifts below are judgment only.

Uplift model. Applied to the revenue of the options each bucket changes, as a conversion lift with traffic
held constant (image quality also lifts click-through from search, which is ignored, so the model is
conservative on that axis and optimistic in assuming no stock or price constraint):

| Bucket | Revenue touched (USD, trailing 12 months) | Lift low / base / high | Uplift low / base / high (USD a year) |
|---|---|---|---|
| B1 shot-list compliance | all softline, about 9.2M; the lift is assumed only on the share with a framing, size or missing-role defect today, taken as 1 in 3 options (unverified) | 0% / 3% / 6% on that third | 0 / 92k / 184k |
| B2 fill to 5, first version | 23% of options have fewer than 5 images (770 of 3,315); revenue share assumed proportional, 2.1M | 2% / 5% / 15% | 42k / 106k / 318k (superseded) |
| B2 fill to 5, corrected | measured revenue of under-5 options (file_date 2026-10-21, `b2rev.sql`): 1.95M, of which USPA footwear 1.46M (77 options, not fillable by B2's apparel engine); apparel 0.47M (FC 243k, Penti 147k, CB 31k, Nautica 24k, VM 23k) | 2% / 5% / 15% on 0.47M | 9k / 23k / 70k |
| B2 eligibility upside, corrected | about 663 apparel options not on Centrepoint (first version about 530); Centrepoint earns about USD 115 per listed softline option a year (190k / 1,637); about 893 not on Styli (first version about 1,330) at about USD 25 per option | 0% / 25% / 50% of those options start selling at today's per-option rate | 0 / 25k / 49k (counted inside B2 high only) |
| B3 flat lay to on-model, Vero Moda | 126k (VM across channels) | 3% / 10% / 25% | 4k / 13k / 32k |
| B1 to B3, first version | | | about 46k / 211k / 564k (superseded) |
| B1 to B3, corrected | | | about 13k / 128k / 336k |
| B4 to B7a | see sections 7 to 10 | | |

Confidence: low for every row. The base lifts sit at the low end of what public studies claim, because
those studies measure 0 to 2 images, where the gain is largest, and our backlog is 3 to 4 images going
to 5.

### 5. What changed for B1 to B3 in the refresh, and why

| Item | First version | Refreshed | Evidence |
|---|---|---|---|
| USPA department | 240 apparel, 290 footwear | 529 footwear, 0 apparel | DD4 F1, DD5 (USPA footwear only), revenue by department above |
| Apparel options | about 2,170 | 1,746 (DD0) | DD0 summary item 7 |
| Catalogue for per-style cash | 3,754 options | 3,141 style-colours (Campus 1,013 option ids = 405 style-colours) | DD4 F1, `COUNT(DISTINCT name, colour)` |
| B1 cash saving | INR 1.9 lakh (USD 2.3k) a year | INR 93,800 (USD 1.1k) a year at a 50% image share; range USD 0.6k to 1.6k | section 6 |
| B2 revenue touched | 2.1M (proportional assumption) | 0.47M apparel (measured); 1.46M of the under-5 revenue is 77 USPA footwear options | `b2rev.sql` |
| B2 uplift | 42k / 106k / 318k | 9k / 23k / 120k (70k plus 49k eligibility) | as above |
| Centrepoint / Styli absent apparel | about 530 / 1,330 | about 663 / 893 (plus Puma apparel) | `b2rev.sql` |
| B1 to B3 total | 46k / 211k / 564k | 13k / 128k / 336k | |
| Ranking | B2 > B1 > B3 | B1 > B2 > B3 (and B4, B5, B6 rank between B1 and B2) | section "Ranking" |
| Unchanged | B1 revenue model, B3 numbers, DD3 prices, the 770 / 258 / 99 counts, the USPA "2,700" reading | | |

### 6. The agency's INR 60: how it splits (explicit assumption)

DD5 searched and did not find the split: no invoice in the warehouse or repo, and the meeting gives one
figure "all platforms plus template filling". Owner question 6 in DD5 is still open. This refresh therefore
treats the split as an assumption:
- Base: 50% images (INR 30), 50% listing templates including Arabic text (INR 30).
- Range: images 30% to 70% (INR 18 to 42), templates the rest (INR 42 to 18).
- Why 50 / 50 as base: the agency's image work is resizing and re-backgrounding the brand's own photos for
  each channel (what B1 automates); its template work is filling 4 channel templates per style with
  attributes and copy in two languages (what B6 automates). Neither side is obviously the larger; the
  range covers both readings.
- Unit: per style. Whether the agency bills Campus per style-colour (405) or per option id (1,013) is not
  known; per style-colour is used, which is the lower figure.

| Saving a year at 3,350 new styles (SPEC R15a inflow) | Images share 30% | Base 50% | Images share 70% |
|---|---|---|---|
| B1 replaces images (INR share minus INR 2 module cost) | INR 53,600 (USD 0.6k) | INR 93,800 (USD 1.1k) | INR 134,000 (USD 1.6k) |
| B6 replaces templates (INR share minus INR 5.4 copy cost) | INR 122,600 (USD 1.5k) | INR 82,400 (USD 1.0k) | INR 42,200 (USD 0.5k) |
| Both (INR 60 minus INR 7.4) | INR 176,200 (USD 2.1k) | INR 176,200 (USD 2.1k) | INR 176,200 (USD 2.1k) |

For the current catalogue once (3,141 style-colours): B1 INR 88,000 (USD 1.0k) and B6 INR 77,300
(USD 0.9k) at the base split; both INR 165,200 (USD 2.0k). The total is insensitive to the split; only the
attribution between B1 and B6 moves. If the 3,350 inflow figure is counted in option ids rather than
style-colours, all yearly figures here are overstated by up to about a fifth.

### 7. B4: footwear and bags lifestyle image

Addressable (exact where stated). DD4 F1 counts 1,222 style-colours: footwear 1,146 (USPA 529, Campus 406,
Puma 106, Keds 105) and bags 76 (French Connection 63, Vero Moda 13); 85 are kids (still life only). Per
channel, recounted in this refresh from master_sl channel columns (query `b4ch.sql`; Puma footwear and
bags found by Trendyol category or name keyword, so 1,220 here against DD4's 1,222; the 2 difference is
classification noise):

| Brand | Style-colours | Noon | Namshi | Trendyol | Centrepoint | 6thStreet | Styli | Amazon | VogaCloset | Shein |
|---|---|---|---|---|---|---|---|---|---|---|
| U.S. Polo Assn. (footwear) | 529 | 529 | 529 | 529 | 466 | 461 | 430 | 448 | 56 | 397 |
| Campus (footwear) | 405 | 405 | 405 | 366 | 0 | 338 | 345 | 366 | 87 | 345 |
| Keds (footwear) | 105 | 105 | 105 | 104 | 0 | 105 | 105 | 72 | 0 | 0 |
| Puma (footwear) | 104 | 0 | 0 | 104 | 50 | 0 | 0 | 0 | 0 | 0 |
| French Connection (bags) | 64 | 64 | 64 | 63 | 0 | 54 | 56 | 5 | 0 | 0 |
| Vero Moda (bags) | 13 | 1 | 1 | 1 | 0 | 0 | 1 | 1 | 0 | 0 |
| Total | 1,220 | 1,104 | 1,104 | 1,167 | 516 | 958 | 937 | 892 | 143 | 742 |

Style-colour-channel pairs: 7,563. Channels where a lifestyle image is allowed by a public rule: Noon (as
an additional image) and Amazon (alternate, never MAIN); Namshi assumed equal to Noon; the others are
unknown (DD4 F5). Trendyol caps a listing at 8 images and Campus and Keds already carry 7.0 to 7.8 there, so
about 470 Trendyol pairs need the size-chart swap (DD4 Q3) or are skipped.

Who already has a lifestyle-like photo (DD4 F2 sample of 48): USPA 0 of 8 and Keds 0 of 8 (fully
addressable); Campus 8 of 8 have a styled studio set (addressable only if the owner says that does not
count, DD4 Q2); Puma 5 of 8 and French Connection bags 7 of 8 already show the product worn or carried.

Cost saved per year versus today: none in cash. The agency does not make lifestyle images; the manual route
does (Naz with ChatGPT), at 5 to 6 a day. The backlog of 1,222 images is about 94% of a year of the manual
route's output. The saving is capacity.

Run cost (DD4 R6): USD 0.20 per accepted image, USD 244.40 once for the 1,222 backlog (USD 126.11 if every
image passed at the first attempt); fewer once kids, unknown subcategory and capped products drop out.
Ongoing: new footwear and bag styles are about 39% of the catalogue (1,222 of 3,141), so about 1,300 a year
at the 3,350 inflow, about USD 260 a year (approximate).

Revenue uplift. Revenue touched: footwear and bags USD 7.05M (USPA 5.91M, Campus 0.79M, Keds 0.16M, FC bags
0.19M; Puma footwear has no priced sales rows). Almost all of it sells on Namshi and Noon, where a lifestyle
image is allowed as the last image.

| Case | Revenue touched | Lift | Uplift (USD a year) | Assumption |
|---|---|---|---|---|
| Low | 7.05M | 0% | 0 | a lifestyle image as image 6 to 9 changes nothing; gains beyond two images are small (eBay 2014) |
| Base | 6.86M (FC bags excluded: already carried) | 1% | 69k | one extra "catchy" image (Naz's word) on pages that today have packshots only |
| High | 7.05M | 3% | 212k | lifestyle images also lift ad CVR and repeat views; Campus counts as missing (Q2) |

If the owner rules Campus's styled studio sets as "lifestyle present" (DD4 Q2), base drops by about 8k to
61k. Confidence: low. The lever is large only because USPA's footwear revenue is large.

What blocks value (owner answers pending, DD4): Q2 (do worn studio photos and Campus sets count), Q3 (may
lifestyle replace the size chart at the Trendyol and Amazon caps), Q4 (does Noon's "only photographs" or
Amazon's synthetic-performer rule refuse or require labels on generated images), Q5 (each brand's written
rights for generated lifestyle imagery), Q6 (lifestyle rules for 6thStreet, Styli, Centrepoint, Shein,
VogaCloset). Also: DD2's gate and the 100-image review-all exit before anything publishes without a person.

### 8. B5: infographics (feature callouts and use-case panels)

The question DD6 could not answer: how many products have at least 2 confirmed features (DD6's rule "fewer
than 2 confirmed, glossary-covered features gets no callout image"). Sized now, approximately.

Method (query `feat3.sql`, `b5ch.sql`). For each master_sl style-colour, text from two sources was searched
for 30 feature keys with fixed patterns (memory foam, lace-up, slip-on, cushioned, lightweight, breathable or
mesh, stretch, quick-dry or wicking, high waist, compression or shaping, squat-proof, padded, wireless,
push-up, adjustable, pockets, elastic or drawstring waist, grip or EVA sole, waterproof, strap closure,
platform, seamless, zip, hooded, removable insole, organic or recycled, UV protection, lined, reversible,
multipack):
- Source 1, Opptra's own master `dimensions.sku_master_p2p` (latest snapshot, joined on EAN =
  global_identifier_number): `product_name_en`, `material_composition` (where DD5 found misfiled features such
  as "MEMORY INSOLE") and `product_desc_en` with the brand-wide boilerplate sentences removed ("Campus
  Sneakers Combine ...", "Designed With Comfort And Style In Mind ...", "U.S. Polo Assn. Sneakers Blend ...").
  A data source, so a feature found here can be `confirmed` under DD5's precedence.
- Source 2, Trendyol listing name and description (UAE and KSA, barcode = EAN). DD5 marks facts extracted
  from it `proposed`: never drawn until Naz confirms them.
- No key reached 92% of any brand's options in a way that looked like boilerplate (the highest, USPA lace-up
  91%, is real: USPA is mostly lace-up sneakers). Patterns are approximate: a keyword is not a reviewed
  glossary entry, and some hits ("lace-up", "EVA") are weak callouts.

| Brand | Style-colours | 2+ features in p2p (confirmable now) | 2+ features with Trendyol text (proposed included) | Revenue of the first set (USD) | Revenue of the second set (USD) |
|---|---|---|---|---|---|
| U.S. Polo Assn. | 529 | 55 | 421 | 661,000 | 4,558,000 |
| Campus | 405 | 270 | 368 | 499,000 | 732,000 |
| Penti | 615 | 8 | 339 | 12,000 | 311,000 |
| French Connection | 899 | 0 (not in p2p) | 143 | 0 | 239,000 |
| Keds | 105 | 60 | 93 | 106,000 | 147,000 |
| Cardio Bunny | 119 | 74 | 97 | 60,000 | 88,000 |
| Puma | 190 | 0 (not in p2p) | 55 | 0 | 0 |
| Vero Moda | 120 | 0 | 26 | 0 | 31,000 |
| Nautica | 159 | 0 (not in p2p) | 18 | 0 | 6,000 |
| Total | 3,141 | 467 | 1,560 | 1.34M | 6.11M |

Per channel (style-colours with 2+ features, confirmable / with proposed): Noon 467 / 1,500, Namshi 467 /
1,500, Trendyol 456 / 1,544, Amazon 388 / 1,185. Channels that accept an infographic today (DD6 R6): Amazon
and Trendyol yes; Noon and Namshi yes pending written confirmation (DD6 Q2); 6thStreet, Styli, Centrepoint,
Shein and VogaCloset not sent until confirmed. Revenue of the 1,560 set by channel: Noon and Namshi 6.02M,
Amazon and Trendyol 0.05M. So almost all of B5's value hangs on Noon and Namshi saying yes.

Cost saved per year versus today: none in cash. The agency does not make infographics; Naz does a few by
hand with ChatGPT. Capacity: 1,560 callout images plus panels is more than a year of the manual route.

Run cost (DD6 prices, now on sized counts): callouts 467 x USD 0.0108 = USD 5.04 (confirmable set) to
1,560 x 0.0108 = USD 16.85; panels from brand photos at most USD 29.61 (all 3,748 options, upper bound);
footwear panels with 2 generated scenes at most 1,061 adult footwear style-colours x 0.41 = USD 435.01.
Upper bound for the catalogue about USD 481 once; new styles add the same per product.

Revenue uplift:

| Case | Revenue touched | Lift | Uplift (USD a year) | Assumption |
|---|---|---|---|---|
| Low | 0.05M (Amazon and Trendyol only; Noon and Namshi say no) | 0% to 1% | 0 to 1k, shown as 0 | an extra non-primary image with text changes little |
| Base | 6.02M (Noon and Namshi accept; Naz confirms the Trendyol-derived features) | 1% | 60k | callouts shorten the path to the features shoppers look for; one of 6 to 9 images |
| Base, confirmable features only | 1.31M on Noon and Namshi | 1% | 13k | if Naz does not confirm proposed features, or DD5's brand sheets do not arrive |
| High | 6.11M | 3% | 183k | callouts and panels also lift ad CVR; footwear panels add scenes |

Confidence: low. USPA is 4.54M of the 6.02M, and its strongest keys are "lace-up" and "cushioned", which are
weak selling points; the real figure depends on the reviewed glossary.

What blocks value (owner answers pending, DD6): Q2 (Noon and Namshi written acceptance; without it B5 is
worth about nothing), Q3 (bilingual or separate Arabic images), Q4 (priority at the Trendyol and Amazon caps,
shared with B4), Q5 (brand rights to letter product images), Q6 (Arabic glossary reviewer). And from DD5:
brand-manager sheets for French Connection, Puma and Nautica (1,248 options absent from sku_master_p2p).

### 9. B6: attributes backbone (fact sheet) and GCC listing fill

Addressable. All 3,141 style-colours (3,748 options) get a fact sheet. Template fill targets Noon, Namshi,
Styli and Centrepoint (DD5 R5). Style-colours per target channel (query `b5ch.sql`):

| Brand | Style-colours | Noon | Namshi | Styli | Centrepoint | Facts in sku_master_p2p (style-colours) |
|---|---|---|---|---|---|---|
| French Connection | 899 | 898 | 898 | 120 | 363 | 0 (brand sheet needed) |
| Penti | 615 | 615 | 615 | 569 | 528 | 615 |
| U.S. Polo Assn. | 529 | 529 | 529 | 430 | 466 | 529 |
| Campus | 405 | 405 | 405 | 345 | 0 | 405 |
| Puma | 190 | 0 | 0 | 0 | 97 | 0 (brand sheet needed) |
| Nautica | 159 | 156 | 156 | 0 | 0 | 0 (brand sheet needed) |
| Vero Moda | 120 | 102 | 103 | 96 | 91 | 39 |
| Cardio Bunny | 119 | 119 | 119 | 119 | 92 | 119 |
| Keds | 105 | 105 | 105 | 105 | 0 | 105 |
| Total | 3,141 | 2,929 | 2,930 | 1,784 | 1,637 | 1,812 (58%) |

Template pairs: 9,280. Facts from data today: 1,812 style-colours (58%); 1,329 need a brand-manager sheet
for material, care and origin or stay "Needs info" (DD5 R5). New source confirmed this refresh:
sku_master_p2p's latest snapshot now holds 37 brands across Opptra (not only the 8 DD5 saw in one entity);
product descriptions are filled for USPA, Penti, Campus, Cardio Bunny and Keds, but mostly as one
brand-wide sentence plus the product name (Campus, Penti, USPA), so it gives facts, not copy.

Cost saved per year versus today: the template half of the agency's INR 60 (section 6). Base INR 30 minus
INR 5.4 copy = INR 24.6 per style: INR 82,400 (USD 1.0k) a year at 3,350 new styles, range INR 42,200 to
122,600 (USD 0.5k to 1.5k); INR 77,300 (USD 0.9k) once for the current catalogue. On a low text tier for
both languages (DD5: USD 0.002 per option) the copy cost is almost zero and the saving rises by about
INR 18,000 a year; DD5 recommends the higher tier for Arabic until the golden set passes.

Run cost (DD5): copy about USD 0.064 per option, USD 240 for 3,748 options (USD 201 counted in 3,141
style-colours); vision proposals about USD 0.001 per option; filling is code. Ongoing about USD 214 a year
at 3,350 new styles.

Revenue uplift. Mechanisms, none measured: (1) complete attributes feed channel filters (size, material,
fit) on Namshi and Noon; (2) Noon shows an English-only listing possibly only on its English site (Noon
seller help page, DD5 F2), so Arabic text matters where the agency did not supply it; nobody has checked
whether today's listings carry Arabic (owner question); (3) new styles go live without waiting for the
agency's turnaround (not measurable: no turnaround data). Revenue touched: Noon and Namshi softline 8.26M,
of which 89% is from brands sku_master_p2p covers.

| Case | Revenue touched | Lift | Uplift (USD a year) | Assumption |
|---|---|---|---|---|
| Low | 8.26M | 0% | 0 | the module only matches the agency's output |
| Base | 7.33M (brands with facts in p2p, Noon and Namshi) | 0.5% | 37k | more complete attributes than the agency, better filter visibility |
| High | 8.26M | 2% | 165k | today's listings lack Arabic or key attributes on many styles, and the module fills them |

Confidence: low for revenue, medium for cash and run cost. B6 is also the foundation B5 (features) and B7a
(fact checks) build on, and it is the only obligation the catalog team keeps toward B7b and B8 (the
read-only identity and attributes export, DD10).

What blocks value (owner answers pending, DD5): the real blank templates (Noon per fashion product type,
Namshi, Styli, Centrepoint) and agency-filled examples (Q4); brand-manager sheets for FC, Puma, Nautica (Q2);
ownership of and read access to sku_master_p2p (Q3, Q8); an Arabic reviewer (Q5); the INR 60 split (Q6).

### 10. B7a: review ingestion and review-driven content fixes

Addressable (DD7 F2, Scout `opptra_core.listing_observation`, latest per listing, joined to master_sl):

| Platform | Our options Scout sees | With a rating | With 10 or more ratings | Rated under 4.0 | Sum of rating counts |
|---|---|---|---|---|---|
| Noon.ae | 896 | 714 | 420 | 93 | 19,021 |
| Noon.sa | 868 | 747 | 444 | 94 | 19,553 |
| Namshi.ae | 2,255 | 463 | 13 | 7 | 1,042 |
| Namshi.sa | 1,287 | 351 | 12 | 7 | 906 |
| Amazon.ae | 456 | 142 | 31 | 40 | 838 |
| Amazon.sa | 20 | 12 | 8 | 4 | 5,565 |

By brand: USPA carries most of it (Noon.ae 15,419 ratings over 528 options), then Campus (Noon.ae 3,488);
Cardio Bunny, Keds and Vero Moda have almost nothing. About 27,000 unique ratings and roughly 11,000 text
reviews (DD7, approximate). Trendyol is in scope but Scout has no adapter, so it is not counted. Styli,
6thStreet and Centrepoint expose no review text (out of scope). A theme counts only with at least 3 reviews
and 10% of a listing's reviews, so fixes concentrate on the roughly 420 to 450 options with 10 or more Noon
ratings.

Cost saved per year versus today: none in cash; nobody reads reviews systematically today.

Run cost (DD7): Scout reviews entity, no licence cost. Noon fallback actor (only if Scout's proxies cannot
reach Noon): about USD 190 for a first pull (upper bound), then about USD 94 to 144 a year (USD 7.80 to 12.00
a month). Theme tagging about USD 0.02 per 1,000 reviews (USD 0.14 to 0.23 for the whole corpus once); fix
proposals about USD 0.011 per product with new reviews, about USD 8 for the 750 options with Noon ratings.
First year at most about USD 350; after that about USD 100 to 160 a year, or under USD 20 if Scout reaches
Noon.

Revenue uplift. Two levers: (1) fewer size and "not as described" returns once size charts, size guidance
and colour-accurate shots are fixed; Namshi records USD 0.68M of size or fit returns and USD 32k of "not as
described" a year (section 4); Noon records no reasons; (2) conversion on the products whose pages are fixed,
mostly USPA on Noon; revenue touched assumed at 80% of Noon softline (about 1.8M), because the options with
10 or more ratings are the best sellers (assumption, not measured).

| Case | Returns avoided (gross USD) | Conversion on fixed pages | Uplift (USD a year) | Assumption |
|---|---|---|---|---|
| Low | 0 | 0% | 0 | fixes are too few or too late to matter |
| Base | 2% of fit returns + 5% of "not as described" = 15k | 0.5% of 1.8M = 9k | 24k | size-chart and size-guidance fixes on the ~450 reviewed options, carried to the same products on Namshi |
| High | 5% + 20% = 40k | 2% of 1.8M = 36k | 76k | fit themes are common and the brand confirms "choose one size up" callouts |

Returns avoided are counted at gross listing price, as everywhere in this document, not at margin.
Confidence: low.

What blocks value (owner answers pending, DD7): who builds the Scout reviews entity (Q1; Scout parks reviews
until its Phase 1 exit); the Apify account and cap for the Noon fallback (Q2); the 200-review Arabic and
English golden set labeller (Q5); a brand contact for durability complaints (Q6); a regular Scout schedule
for review-bearing listings (Q7). The theme step shows nothing until its golden set passes.

### 11. B7b and B8: context only, outside the catalog team (DD10)

DD10 recommends both OUT of this team. They are sized here only as context and are not in the ranking.

| Bucket (outside) | Owner proposed by DD10 | What the data shows | Cost to test | Value |
|---|---|---|---|---|
| B8 forecasting and product selection | Channel Replenishment in gcc-dashboard (Ashish, Mahesh) | Stock caps every catalog bucket: on the latest catalog_liveness_daily snapshot, of 16,095 softline SKUs, 8,173 are stocked for Noon UAE (51%) and 5,525 for Noon KSA (34%), the same pools as Namshi; only USPA and Nautica have two seasonal cycles of sales history (DD10) | Inside an existing product; no new tool | Not sized by the catalog team. Any image or content lift above applies only to in-stock sizes, so B8's lever on the same revenue is probably larger than any catalog bucket, but it is another team's to size |
| B7b NPD competitor insight | A small separate product owned by Nitin Kiran's team | Cardio Bunny, the brand in the meeting's example, sells about USD 0.10M a year (attributed, all channels); no competitor reviews exist in any table; BlissClub and Lululemon need new adapters (DD10) | One-off Amazon review scrape at USD 1.50 to 7.50 per 1,000 reviews (DD10) | Not sizable: it depends on product decisions not yet made. It reuses B7a's ingestion layer at no extra catalog cost |

The catalog team's only obligations to these: the read-only identity and attributes export (B6) and a review
ingestion layer that accepts any listing id (B7a).

## Sizing table

| Bucket | Addressable (exact unless marked) | Cost saved a year | Run cost | Revenue uplift low / base / high (USD a year) | Key assumptions | Confidence |
|---|---|---|---|---|---|---|
| B1 shot-list compliance | 3,141 style-colours (3,754 options), 16,358 SKUs, about 17,270 style-colour-channel pairs on 9 channels; apparel 1,746 options | INR 93,800 (USD 1.1k) at a 50% image share, range USD 0.6k to 1.6k (corrected from USD 2.3k) | INR 1 to 4 per style | 0 / 92k / 184k | one third of options have a defect B1 fixes; 3% conversion lift on them; traffic constant | low |
| B2 fill the shot list | 770 options with fewer than 5 images (258 with fewer than 4), about 500 to 560 apparel; 1,540 images; about 663 apparel options absent from Centrepoint, 893 from Styli | manual route replaced: 1,540 images is more than a year of manual output | USD 32 backlog (USD 0.20 per accepted image), crops about 0; INR 3.5 per option on average | 9k / 23k / 120k (corrected from 42k / 106k / 318k; high includes 49k eligibility) | apparel revenue of under-5 options 0.47M measured; 5% lift base; DD2's 24-option sample sets the 5/24 generation share | low |
| B3 flat lay to on-model | Vero Moda 121 master options (306 on Trendyol), 605 images; other flat-lay brands unknown | 605 manual images avoided | USD 121 for 121 options (USD 306 for 306) | 4k / 13k / 32k | 10% lift base on VM revenue of 126k; no public evidence for on-model vs flat lay | low |
| B4 footwear and bags lifestyle | 1,222 style-colours (USPA 529, Campus 406, Puma 106, Keds 105, FC bags 63, VM bags 13; 85 kids); about 7,560 style-colour-channel pairs | manual route: 1,222 images is about 94% of a year of manual output; no agency cash | USD 244.40 once; about USD 260 a year for new styles | 0 / 69k / 212k | 1% lift base on footwear revenue 6.86M; lifestyle as the last image only; USPA and Keds have no lifestyle today | low |
| B5 infographics | 467 style-colours with 2+ features in sku_master_p2p; 1,560 with Trendyol-derived (proposed) features; Noon 467 / 1,500, Namshi 467 / 1,500, Trendyol 456 / 1,544, Amazon 388 / 1,185 | manual route; no agency cash | USD 5 to 17 callouts, at most USD 30 brand-photo panels, at most USD 435 footwear generated panels | 0 / 60k / 183k (13k base on confirmable features only) | Noon and Namshi accept infographics; Naz confirms proposed features; 1% lift base | low |
| B6 attributes and listing fill | 3,141 style-colours; 9,280 template pairs on Noon 2,929, Namshi 2,930, Styli 1,784, Centrepoint 1,637; facts from data for 1,812 (58%) | INR 82,400 (USD 1.0k) a year at a 50% template share, range USD 0.5k to 1.5k | USD 240 once for the catalogue; about USD 214 a year | 0 / 37k / 165k | 0.5% lift base on Noon and Namshi revenue of p2p-covered brands; the agency split | low (revenue), medium (cash, run cost) |
| B7a review-driven fixes | 714 / 747 options rated on Noon.ae / .sa (420 / 444 with 10+ ratings), 463 / 351 on Namshi, 142 / 12 on Amazon; about 11,000 text reviews (approximate) | none in cash | at most about USD 350 first year with the Noon actor, then USD 100 to 160 a year (under USD 20 without the actor) | 0 / 24k / 76k | Namshi fit returns USD 0.68M a year; 2% of them avoided base; 0.5% conversion on 1.8M | low |
| B7b NPD insight (outside, context) | Cardio Bunny about USD 0.10M revenue; no competitor data | n/a | one-off scrape USD 1.50 to 7.50 per 1,000 reviews | not sized | DD10: separate product | n/a |
| B8 forecasting (outside, context) | 16,095 softline SKUs; 51% stocked for Noon UAE, 34% for Noon KSA | n/a | inside Channel Replenishment | not sized | DD10: gcc-dashboard | n/a |
| DD3 generator prices (refreshed 2026-10-22) | USD 0.10 per image at 2K, 0.15 at 4K, 0.20 per accepted image with retries; one generator through OpenRouter's Image API; fidelity checks on free tooling | used in B2, B3, B4, B5 | | unchanged | retry rate as measured in DD3 | medium |
| Program B1 to B7a | 3,141 style-colours; 770 need fill; 121 need on-model; 1,222 need lifestyle; 467 to 1,560 can carry callouts; 9,280 template pairs; about 450 options have enough reviews | about USD 2.1k a year cash (B1 plus B6, whole INR 60 replaced), plus the manual route's whole capacity many times over | about USD 1.3k once in total (B2 32, B3 121, B4 244, B5 up to 481, B6 240, B7a up to 190); then about USD 0.6k to 0.7k a year | about 13k / 318k / 972k (highs overlap; not additive) | as above | low |

## Ranking across B1 to B8

By base-case dollars, with what each depends on. Values in USD a year.

| Rank | Bucket | Revenue base (low to high) | Cash a year | Confidence | Depends on (inside the program) | Pending owner answers that decide the value |
|---|---|---|---|---|---|---|
| 1 | B1 shot-list compliance | 92k (0 to 184k) | 1.1k (0.6k to 1.6k) | low | DD0, DD1, DD1a | none that block; the 1-in-3 defect share is unverified |
| 2 | B4 footwear and bags lifestyle | 69k (0 to 212k) | 0 | low | B1 roles (LS placed last), DD2 gate, DD3 generator, DD8 scene profile | DD4 Q2, Q3, Q4, Q5 |
| 3 | B5 infographics | 60k (0 to 183k); 13k without confirmed proposed features | 0 | low | B6 fact sheet (features), B1 roles (slot), B4 scenes for footwear panels, DD8 fonts | DD6 Q2 (Noon and Namshi acceptance) above all; DD5 brand sheets |
| 4 | B6 attributes and listing fill | 37k (0 to 165k) | 1.0k (0.5k to 1.5k) | low (revenue), medium (cash) | DD0 taxonomy, sku_master_p2p access | DD5 Q4 templates, Q2 brand sheets, Q5 Arabic reviewer, Q6 split |
| 5 | B7a review-driven fixes | 24k (0 to 76k) | 0 | low | B6 fact sheet (checks), B1 roles (shot fixes), B5 (callout order), Scout | DD7 Q1 Scout ownership, Q2 Apify, Q5 golden set |
| 6 | B2 fill the shot list | 23k (9k to 120k), corrected | 0 | low | B1, DD2, DD3 | DD2 gate approval; Centrepoint and Styli eligibility rules |
| 7 | B3 flat lay to on-model | 13k (4k to 32k) | 0 | low | B1, B2 engine, DD3, DD8 registry and rights | DD8 written rights per brand site |
| - | B7b NPD insight | not ranked, outside | - | - | B7a ingestion layer | DD10 approval; Nitin's team as owner |
| - | B8 forecasting | not ranked, outside | - | - | B6 export | DD10 approval; Channel Replenishment owners |

Reading:
- Ranks 2 to 7 sit within one uncertainty band of each other; rank 1 is first mostly because it touches all
  revenue and is the prerequisite for every other image bucket.
- Order by dependency, which is what a release plan needs: B1 first (roles and placement for everything
  after it); B6's fact sheet early, because B5 and B7a cannot work without it and it carries the only cash
  saving besides B1; B4 next (largest generation value, needs only B1 roles and the DD2 gate); then B5;
  then B2 and B7a; B3 last. This differs from the intent map's V1 B1, V2 B2, V3 B3, which was set on the
  first version of this document; whether to re-order is the owner's call (approval question b).
- Concentration risk: USPA footwear is about 64% of all softline revenue and most of the B1, B4 and B5
  value. One question decides a lot: will USPA's brand rights (DD8, DD4 Q5) cover generated lifestyle images
  and lettered infographics?

## Assumptions and confidence

1. master_sl is the option universe (3,754 options, 3,141 style-colours). It undercounts Vero Moda (121
   versus 306 on Trendyol) and its category names are inconsistent; departments follow DD0 and DD4. Medium.
2. Trendyol listing image count equals on-model role coverage on every channel. It is the only measurable
   proxy; it overstates coverage when extra images are swatches or flat lays, and understates it where
   Opptra uploaded fewer images than it holds. Low to medium.
3. The USPA "2,700 options with 3 images" is read as 2,974 SKUs; USPA listing images average above 5.
   Check the catalog module's own product records for source photo counts. Medium.
4. Styli and Centrepoint blocks are proxied by absence from master_sl channel ids; no listing status feed
   exists for either channel. Low.
5. Costs: agency INR 60 is the meeting figure, unverified by any invoice; its split between images and
   templates is assumed 50 / 50 (range 30 / 70) because DD5 found no split; module cost from measured batch
   b489e466 and list prices; generator prices from DD3 (USD 0.20 per accepted image, retries included);
   B4, B5, B6 and B7a run costs from DD4, DD6, DD5 and DD7. Cost figures medium; the split, low.
6. Revenue base: gross listing price, trailing 12 months, warehouse transfers excluded; about 1.3M USD of
   softline-channel rows carry no brand. Department split by option, with keyword rules for Puma and bags.
   Medium for the total, low per brand on Trendyol, Centrepoint, Styli.
7. Uplift lifts are judgment anchored on eBay 2014 and Profitero 2023 for B1 to B3, and on no public
   measurement at all for B4 to B7a; nothing in our data confirms them. The Trendyol image-to-sales join
   covers 13% of orders and is unusable. Low. The way to raise confidence is a holdout per bucket: ship the
   change to half of a matched set on Namshi and Noon and compare ads CVR, PDP conversion and returns where
   they exist (Noon traffic data would need to be re-enabled; it stops at 2026-02-04).
8. B5 feature counts come from 30 keyword patterns on p2p and Trendyol text; they approximate DD5's
   `features[]` and DD6's glossary, which do not exist yet. Medium for the order of magnitude, low per brand.
9. B7a revenue touched assumes the options with 10 or more Noon ratings carry 80% of Noon softline revenue;
   not measured. Low.
10. The SPEC R15a inflow of about 3,350 a year is read as style-colours; if it is option ids, yearly cash
    figures are overstated by up to about a fifth. Medium.
11. Exchange rates fixed at AED 3.6725 and SAR 3.75 per USD, INR 84 per USD.

## Depends on earlier DD answers

Gate B is assumed open with every earlier recommendation approved. If the owner answers differently:

| Earlier answer | If approved (assumed) | If not, what changes here |
|---|---|---|
| DD0 taxonomy and departments | Apparel 1,746, footwear 1,146 style-colours, bags 76; B4 scenes by subcategory | Department counts revert to keyword guesses; B2 and B4 populations move by tens of options, not the ranking |
| DD1 / DD1a roles, order and caps | B4 and B5 images placed last, never image 1, with cap handling | Without caps encoded, B4 and B5 images are silently dropped at Trendyol 8 and Amazon 9; about 470 Trendyol pairs for Campus and Keds lose B4 value |
| DD2 gate | Generated images publish after the exit numbers hold | B2 generation, B3, B4 full generation and B5 footwear panels stay review-all; value arrives only as fast as review allows; B4 falls back to composite still lifes |
| DD3 generator price | USD 0.20 per accepted image | B2, B3, B4, B5 run costs scale with the price; revenue rows unchanged |
| DD4 B4 scope and rules | 1,222 style-colours, kids still life only | If Campus styled sets count as lifestyle (Q2), B4 base drops to about 61k; if generated children are allowed, 85 more worn shots, no material revenue change |
| DD5 fact sheet, precedence, build inside | B6 cash and revenue as sized; B5 can draw p2p features | Without the fact sheet, B5 draws nothing (0 value) and B7a fact checks become notes; if the agency keeps templates, B6 cash is 0 |
| DD6 compositor and channel list | B5 on Amazon and Trendyol now, Noon and Namshi once confirmed | If generated panel scenes are rejected, footwear gets callouts only (panels are not sized separately, so the base changes little); run cost drops by up to USD 435 |
| DD7 Scout ingestion, Noon fallback | B7a as sized | Without Noon text (no actor, Scout blocked), B7a covers Namshi, Amazon and Trendyol only: about 60 options with 10 or more ratings; the conversion part (9k base) mostly goes, leaving the returns part (under 15k base) |
| DD8 style profile and rights | B3, B4 scenes and B5 fonts per brand | Without written rights for a brand, its B3 and B4 generation and B5 lettering stop; for USPA that removes most of B4 and B5 value |
| DD10 boundary | B7b and B8 outside, not ranked | If the catalog team takes them, they need their own sizing; nothing in this document covers forecasting value |

## One-page summary for Nitin

What we sized: seven pieces of catalog work for the nine GCC softline brands, plus two that belong to other
teams. B1 makes sure every product has the exact photo set each marketplace asks for, from the photos we
already have. B2 fills gaps when an apparel product has three of the five required model shots. B3 turns
flat-lay photos into model photos using the brand's own models (Vero Moda first). B4 adds one lifestyle
photo (shoe worn, bag carried) to footwear and bags. B5 adds a picture with the product's features labelled
in English and Arabic. B6 keeps one record of each product's facts and fills the marketplace listing sheets
the agency fills today. B7a reads customer reviews of our own products and turns them into fixes, such as a
size note or a missing back view. B7b (competitor insight for new products) and B8 (forecasting) are
recommended for other teams.

How big the catalogue is: about 3,140 styles (16,358 sizes) on nine marketplaces. Namshi and Noon carry
about 95% of softline revenue (about USD 9.2M in the last twelve months). One thing stands out: US Polo
footwear alone is about USD 5.9M of that. Whatever makes US Polo shoe pages better is where most of the
money is.

What changed since the first version: US Polo turned out to be footwear only, so the "fill the gaps" work
(B2), which is about apparel model shots, touches much less revenue than we first thought (about USD 0.5M,
not USD 2.1M). Its expected value fell from about USD 0.11M to about USD 0.02M a year.

What each is worth, best estimate a year of extra revenue (range in brackets):
- B1 photo set compliance: USD 92k (0 to 184k), the foundation for everything else.
- B4 lifestyle for footwear and bags: USD 69k (0 to 212k).
- B5 feature pictures: USD 60k (0 to 183k), but only if Noon and Namshi confirm in writing that they accept
  them; otherwise close to zero.
- B6 product facts and listing sheets: USD 37k (0 to 165k), plus about USD 1k a year less agency spend.
- B7a review-driven fixes: USD 24k (0 to 76k), mostly fewer size returns on Namshi, where size problems are
  71% of returns with a reason (USD 0.68M a year).
- B2 fill the gaps: USD 23k (9k to 120k). B3 flat lay to model: USD 13k (4k to 32k).
- Together about USD 0.3M a year (range about USD 0.01M to 0.97M; the high ends overlap). These are
  judgments, not measurements: no study measures our exact cases, and our warehouse cannot yet link page
  content to sales.

What it costs: running all of it on today's backlog costs about USD 1.3k once and well under USD 1k a year
after that. Cash saved is small, about USD 2k a year, when both the photo work and the listing sheets move
off the agency (we do not know how the agency's INR 60 per style splits between the two). The bigger point
is capacity: making images by hand gives about 1,300 a year, and the open backlog is about 3,400 images
(B2, B3, B4), about 4,900 counting the feature pictures.

Recommended order: B1 first; B6 early because B5 and B7a depend on it; then B4, B5, B2, B7a and B3. To firm
up the numbers: a controlled test per bucket, the change on half of a matched set of styles on Namshi and
Noon, comparing conversion and returns.

## Approval question

Do you confirm (a) the working assumptions behind the refreshed numbers: master_sl as the option universe
counted in style-colours (3,141, with Campus as 405), Trendyol image count as the proxy for role coverage,
the agency's INR 60 split 50 / 50 between images and templates (range 30 / 70) until an invoice says
otherwise, and the corrections to B1 to B3 in section 5; (b) the ranking B1, B4, B5, B6, B7a, B2, B3 by
base-case dollars, with B7b and B8 left outside the catalog team, and a dependency order of B1, then B6,
then B4, B5, B2, B7a and B3 in place of the intent map's V1 B1, V2 B2, V3 B3; and (c) that the dependent
specs size against these counts?

Open items only the owner can answer:
- How the agency's INR 60 per style splits between images and template filling, and whether Campus is billed
  per style-colour (405) or per option id (1,013) (DD5 Q6).
- Whether the SPEC R15a inflow of about 3,350 a year counts style-colours or option ids.
- Noon and Namshi written acceptance of infographics (DD6 Q2); B5 is worth almost nothing without it.
- Whether worn studio photos and Campus's styled sets count as "lifestyle present" (DD4 Q2), and whether
  lifestyle and callout images may replace the size chart at the Trendyol and Amazon caps (DD4 Q3, DD6 Q4).
- Whether US Polo's written rights cover generated lifestyle images and lettered infographics (DD4 Q5,
  DD6 Q5, DD8); most of the B4 and B5 value is US Polo.
- Whether today's Noon and Namshi listings carry Arabic titles and descriptions (the largest unknown in B6's
  revenue case).
- Who builds the Scout reviews entity and whether an Apify Noon fallback with a cap is allowed (DD7 Q1, Q2).
- Whether to run a holdout test per bucket on Namshi and Noon to replace these judgments with measurements.

Status: refreshed 2026-10-22 for B1 to B8, awaiting owner answer
