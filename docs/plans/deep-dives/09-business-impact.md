# DD9: Business impact of B1 to B3, data-derived

Date: 2026-10-22. Program: Catalog Connect GCC (docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md).
This is an investigation, not a spec. Nothing here is implemented. All warehouse numbers were read from
BigQuery project opptra-datawarehouse on 2026-10-22 (read only); every number states its query shape.
Revenue is gross listing price times quantity at fixed rates (AED 3.6725, SAR 3.75 per USD) unless stated.
Rupees at INR 84 per USD, the default in infra/deploy.sh.

## Summary

- Addressable: 3,754 softline options (16,358 SKUs) across 10 brands in master_sl, listed as about
  20,500 option-channel pairs on 9 channels. Apparel (the 5-shot rule applies) is about 2,170 options.
- B2 backlog is real but smaller than the meeting implied: 770 of 3,315 options matched on Trendyol
  show fewer than 5 images (258 fewer than 4). US Polo has 529 options and 2,974 SKUs; "2,700 options
  with 3 images" is the SKU count, and USPA already averages 5.3 to 5.9 listing images on Trendyol.
- Direct cost saving is small in dollars: agency at INR 60 per style versus about INR 1 to 4 per style in
  the catalog module is roughly INR 2.2 lakh (USD 2.6k) for the whole catalogue once, and about INR 1.9
  lakh (USD 2.3k) a year at the planned inflow. The money is in revenue and channel eligibility, not cost.
- Revenue uplift, base case about USD 0.21M a year on a softline base of about USD 9.2M trailing 12
  months (low USD 0.05M, high USD 0.59M). Confidence is low: the warehouse cannot link image count to
  sales (only 13% of Trendyol orders join to the listing report) and no public study isolates 3 vs 5 images.
- Ranking by expected dollars: B2 (USD 0.11M base) > B1 (USD 0.09M base) > B3 (USD 0.01M base, Vero
  Moda only; grows only if more flat-lay brands are found). B1 remains the prerequisite for both.
- Biggest value not in the money model: the manual route makes about 1,300 images a year; the B2 backlog
  alone is 1,540 images, so without the module most of it never gets done.

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

Apparel versus footwear (approximate, from master_sl.category_name, which is inconsistent and is DD0's
job to clean): apparel about 2,170 options (FC 844, Penti 616, USPA 240, Nautica 159, CB 119, VM 108,
Puma 84); footwear about 1,512 (Campus 1,012, USPA 290, Keds 105, Puma 105); bags 69 (FC 56, VM 13).
The 5-on-model-shot rule on Styli and Centrepoint applies to the apparel set.

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

Reading: B2's "3 of 5 roles" population is 770 options with fewer than 5 listing images (apparel share
about 700; Campus and Keds are footwear and complete). Caveats: (a) a listing image count is a proxy for
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
10,536 SKUs), Locked, Price missing. No image or content reason exists anywhere. Proxy for the Styli and
Centrepoint block: apparel options present on Trendyol but absent on the channel in master_sl:
Centrepoint about 530 apparel options absent (2,170 apparel minus 1,637 present, and 1,637 includes some
footwear), Styli about 1,330 absent (apparel 2,170 minus Styli apparel presence of about 840 after removing
Campus 741, Keds 105 and other footwear). These are upper bounds; absence can also be commercial choice.

### 3. Cost today versus the catalog module

Agency: INR 60 per style, all platforms plus listing-template filling (meeting, 2026-10-21). No agency
invoice or cost table exists in the warehouse (confirmed: no dataset or table name matches agency, vendor
cost or studio). Manual route: ChatGPT by hand at 5 to 6 images a day (meeting), about 1,300 images a year
at 240 working days.

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
- Generated images (B2 second path, B3): placeholder below until DD3 reports exact generator prices; the
  brief's working range is INR 3 to 12 per image plus verification, INR 15 to 60 per 5-shot style.

| Route | Per style | Source |
|---|---|---|
| Agency | INR 60 (includes template filling, which the module does not do; B6 deferred) | meeting |
| Manual ChatGPT | not priced; throughput 5 to 6 images a day | meeting |
| Catalog module, existing photos (B1) | INR 1 to 4 | cost.ts, SPEC |
| Catalog module, derived crops (B2 derive) | about INR 0 extra | cost.ts |
| Generated 2 views (B2 generate) | INR 6 to 24 plus verification, PLACEHOLDER: refresh from DD3 | brief |
| Generated 5-shot set (B3) | INR 15 to 60 plus verification, PLACEHOLDER: refresh from DD3 | brief |

Annual cost saved, exact option counts, agency as the comparator (INR 60 minus INR 2 module cost):
- B1, whole current catalogue once: 3,754 options x INR 58 = INR 217,700 (USD 2.6k). Ongoing at the
  SPEC R15a planned inflow of about 3,350 options: INR 194,300 (USD 2.3k) a year. If the agency is still
  paid for template filling, the saving is a fraction of this (B6 deferred).
- B2, 770 options x 2 images: the agency does not generate views, so the comparator is the manual route.
  1,540 images is more than a full year of the manual route's output; crop derivation costs about nothing
  and generation INR 4,600 to 18,500 for the backlog (placeholder prices). The saving is capacity, not cash.
- B3, Vero Moda 121 options x 5 images = 605 images (half a year of the manual route); module cost
  INR 1,800 to 7,300 (placeholder prices).
- Program: cash saving about USD 2.5k to 5k a year. Too small to rank on; rank on revenue and eligibility.

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
- Nothing public isolates on-model versus flat lay for fashion with a measured lift.

Uplift model. Applied to the revenue of the options each bucket changes, as a conversion lift with traffic
held constant (image quality also lifts click-through from search, which is ignored, so the model is
conservative on that axis and optimistic in assuming no stock or price constraint):

| Bucket | Revenue touched (USD, trailing 12 months) | Lift low / base / high | Uplift low / base / high (USD a year) |
|---|---|---|---|
| B1 shot-list compliance | all softline, about 9.2M; the lift is assumed only on the share with a framing, size or missing-role defect today, taken as 1 in 3 options (unverified) | 0% / 3% / 6% on that third | 0 / 92k / 184k |
| B2 fill to 5 | 23% of options have fewer than 5 images (770 of 3,315); revenue share assumed proportional, 2.1M | 2% / 5% / 15% | 42k / 106k / 318k |
| B2 eligibility upside | about 530 apparel options not on Centrepoint; Centrepoint earns about USD 115 per listed softline option a year (190k / 1,637); Styli about USD 25 per option | 0% / 25% / 50% of those options start selling at today's per-option rate | 0 / 15k / 30k (counted inside B2 high only) |
| B3 flat lay to on-model, Vero Moda | 126k (VM across channels) | 3% / 10% / 25% | 4k / 13k / 32k |
| Program | | | about 46k / 211k / 564k |

Confidence: low for every row. The base lifts sit at the low end of what public studies claim, because
those studies measure 0 to 2 images, where the gain is largest, and our backlog is 3 to 4 images going
to 5.

## Sizing table

| Bucket | Addressable (exact) | Cost saved a year | Revenue uplift low / base / high (USD a year) | Key assumptions | Confidence |
|---|---|---|---|---|---|
| B1 shot-list compliance | 3,754 options, 16,358 SKUs, about 20,500 option-channel pairs on 9 channels; apparel about 2,170 options | INR 2.2 lakh once for the catalogue, INR 1.9 lakh (USD 2.3k) a year at 3,350 new options; less if the agency still fills templates | 0 / 92k / 184k | one third of options have a defect B1 fixes; 3% conversion lift on them; traffic constant | low |
| B2 fill the shot list | 770 options with fewer than 5 images (258 with fewer than 4), about 700 apparel; 1,540 images; about 530 apparel options absent from Centrepoint | manual route replaced: 1,540 images is more than a year of manual output; generation INR 4.6k to 18.5k for the backlog (PLACEHOLDER until DD3) | 42k / 106k / 318k (high includes 30k eligibility) | image count is a proxy for role coverage; revenue share proportional to option share; 5% lift base | low |
| B3 flat lay to on-model | Vero Moda 121 master options (306 on Trendyol), 605 images; other flat-lay brands unknown | 605 manual images avoided; generation INR 1.8k to 7.3k (PLACEHOLDER until DD3) | 4k / 13k / 32k | 10% lift base on VM revenue of 126k; no public evidence for on-model vs flat lay | low |
| PLACEHOLDER: DD3 exact generator prices | to be filled: INR per generated image, per verified 5-shot set, per 2-view fill, and the bake-off winner's price | recompute B2 and B3 cost rows | unchanged | | |
| Program B1 to B3 | 3,754 options; 770 need fill; 121 need on-model | about USD 2.5k to 5k a year cash, plus the manual route's whole capacity | 46k / 211k / 564k | as above | low |

Ranking by base-case dollars: B2, then B1, then B3. B1 is the prerequisite (the roles must be known
before anything can be filled), so the build order V1 B1, V2 B2, V3 B3 in the intent map stands.

## Assumptions and confidence

1. master_sl is the option universe (3,754). It undercounts Vero Moda (121 versus 306 on Trendyol) and
   its category names are inconsistent; apparel versus footwear is approximate until DD0. Medium.
2. Trendyol listing image count equals on-model role coverage on every channel. It is the only measurable
   proxy; it overstates coverage when extra images are swatches or flat lays, and understates it where
   Opptra uploaded fewer images than it holds. Low to medium.
3. The USPA "2,700 options with 3 images" is read as 2,974 SKUs; USPA listing images average above 5.
   Check the catalog module's own product records for source photo counts. Medium.
4. Styli and Centrepoint blocks are proxied by absence from master_sl channel ids; no listing status feed
   exists for either channel. Low.
5. Costs: agency INR 60 is the meeting figure, unverified by any invoice; module cost from measured batch
   b489e466 and list prices; generator prices are placeholders from the brief until DD3. Cost figures
   medium, generator placeholders low.
6. Revenue base: gross listing price, trailing 12 months, warehouse transfers excluded; about 1.3M USD of
   softline-channel rows carry no brand. Medium for the total, low per brand on Trendyol, Centrepoint, Styli.
7. Uplift lifts are judgment anchored on eBay 2014 and Profitero 2023; nothing in our data confirms them.
   The Trendyol image-to-sales join covers 13% of orders and is unusable. Low. The only way to raise
   confidence is a holdout: ship 5-shot sets to half of the fewer-than-5 options on Namshi and Noon and
   compare ads CVR and PDP conversion where they exist (Noon traffic data would need to be re-enabled; it
   stops at 2026-02-04).
8. Exchange rates fixed at AED 3.6725 and SAR 3.75 per USD, INR 84 per USD.

## One-page summary for Nitin

What we sized: three pieces of work on product images for the nine GCC softline brands. B1 makes sure
every product has the exact photo set each marketplace asks for, from the photos we already have, or
tells us precisely why not. B2 fills the gaps when a product has three of the five required on-model
shots. B3 turns flat-lay photos into on-model photos using the brand's own models, starting with Vero Moda.

How big the catalogue is: 3,754 styles (16,358 sizes) listed on nine marketplaces, about 20,500
style-marketplace pairs. About 2,170 styles are apparel, where Styli and Centrepoint require five on-model
shots. Namshi and Noon carry about 95% of softline revenue (about USD 9.2M in the last twelve months).

What the data says about the gap: 770 styles (about one in four of those we can measure) have fewer than
five listing images; 258 have fewer than four. Vero Moda is the worst (about a third of its styles have
one image or none); French Connection and Penti have the largest counts. US Polo is in better shape than
the meeting suggested: it has 529 styles, not 2,700 (that is its size count), and most already carry five
or more images.

What it costs today and tomorrow: the agency charges INR 60 per style; the catalog module runs at about
INR 1 to 4 per style. Across the whole catalogue that is a saving of roughly INR 2 lakh once and about
INR 2 lakh a year, which is small. The real constraint is capacity: making images by hand yields about
1,300 images a year, and the B2 backlog alone is 1,540 images. Without the module, most of it will not
get done.

What it could be worth: our best estimate is about USD 0.2M a year of extra revenue (range USD 0.05M to
0.6M), mostly from better-converting pages on Namshi and Noon and from apparel becoming eligible on
Centrepoint and Styli. This is a judgment anchored on public studies, not a measurement; our warehouse
cannot yet link image counts to sales, and no public study measures exactly our case (going from three or
four images to five).

Ranking: B2 first on money (about USD 0.11M a year base), B1 second (about USD 0.09M) but it is the
foundation and ships first, B3 third (about USD 0.01M for Vero Moda alone; it grows only if more flat-lay
brands exist). Recommended next step to firm up the numbers: a controlled test, five-shot sets on half of
the under-imaged styles on Namshi and Noon, and compare conversion.

## Approval question

Do you confirm (a) the three working assumptions behind the numbers: master_sl as the option universe
(3,754), Trendyol image count as the proxy for role coverage on every channel, and the USPA figure read as
2,974 SKUs rather than 2,700 options; and (b) the ranking B2, then B1, then B3 by dollar impact with B1
built first as the prerequisite, so the dependent deep dives size against these counts?

Status: done, awaiting owner answer
