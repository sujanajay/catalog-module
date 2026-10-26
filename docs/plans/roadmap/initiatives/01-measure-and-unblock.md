# Initiative 01 - Measure and unblock

Date: 2026-10-26. Documents only; nothing was built or changed. No time or effort estimates (owner rule).
Part of the GCC catalog roadmap: order, money and merges come from `../07-roadmap.md` ("Initiative 1 - Measure and
unblock"); this file adds the detail behind that section.

**Source codes** (same as 07). 01 marketing data, 02 liveness data, 03 image audit, 04 India learnings, 05 build vs
buy, 06 metrics and impact model v2, 07 roadmap (all in `docs/plans/roadmap/`); DD1, DD9 = `docs/plans/deep-dives/`.
**GD** = the gcc-dashboard repo (`C:\Users\Sujan Ajay\Desktop\gcc-dashboard`, read only): GD-06 =
`docs/catalog/liveness/06_channel_reports_ingestion_SPEC.md`, GD-DEC = `docs/catalog/liveness/DECISIONS.md`,
GD-CFG = `pipeline/catalog_liveness/config.py`, GD-LIN = `docs/gcc-system-map/appendix/A_pipeline_lineage.md`.
**CM** = this repo (catalog module), `packages/core/src/db/schema.ts`. **Q-A** = one new read-only BigQuery query
run for this file (2026-10-26, `opptra-datawarehouse`, explicit columns, no PII): `gcc_marketing.ads_daily`
2026-07-26 to 2026-10-23 joined to `raw_gcc_dimensions.master_sl` (softline) and `gcc_marketing.sku_option`
(option), weak rule of 01 s2.6. It re-creates 01's weak pool closely, not exactly (231 options and 29,944 USD
against 01's 236 and 30,513, because brand names are cleaned more simply; 236 stays the reference, and initiative
3's Q-W reproduces it exactly), and adds the clicks and ad units the
sample sizes need. Q-A numbers are labelled approx.

**Labels.** Measured = a count or sum from data; judged = an assumption; derived = arithmetic on measured numbers.

## Summary

1. 62% of not-live pairs (2,243 of 3,639) have no reason: the Noon (stale since 21 Aug), Namshi and Amazon
   rejection feeds are missing (02). Noon traffic stopped 4 Feb; Namshi and Trendyol have none.
2. Nobody records which images went live where, so no content change can be tied to sales (join coverage 13%, DD9).
3. We restore the feeds in the existing gcc-dashboard jobs, add a feed-health flag and time to live, log image
   role, position and test arm per listing in the catalog module, and run a holdout test.
4. Direct value: part of the 865 not-listed pairs, base 6.7k USD a year (low 0, high 13.4k), run cost about 0 (07).
   Main value: the other 262.7k of judged base becomes measured or is dropped.
5. Holdout: Namshi ads detect a 15% lift at about 89,700 clicks per arm (about 1,470 control ad units); the 187
   Amazon pages need about 16,000 sessions per arm to see a quarter of their gap closed.
6. Build on what we run; Amazon's free experiment tool is an optional add-on.

## Problem, with evidence and real examples

### P1. Rejection reasons are missing, so content problems read as zero

- 62% of not-live pairs (2,243 of 3,639) on 24 Oct carry "Reasons not connected yet": Noon 902, Namshi 721,
  Amazon 620, Trendyol 0 (02 "Not-live reasons ranked"). Reason coverage is 38% (1,396 of 3,639) (02 Metrics).
- The Content bucket shows 0 pairs on every day from 17 to 25 Oct because the reason feeds are missing, not because
  content is fine (02 "Image and content rejections").
- The three feeds and their state today (GD-06 section 2 table; GD-CFG):

| Feed | Source export | Who makes the file | Table | State |
|---|---|---|---|---|
| C-02 Noon Not Live | Noon partner portal, Catalog Export, Live Status "Not Live", AE and SA | "nobody since 21 Aug"; vendor job of `marketplace-opptra@ceegees.in` stopped; an Increff account also makes Not Live exports on the portal that never land | `raw_gcc_tables.catalog_non_live_noon_3p_uae` / `_ksa` | exists, last file 2026-08-21 |
| C-04b Namshi Catalog Live Status | namshi-catalog.noon.partners, Exports, "Product Live Status Reports", "Catalog Live Status", OFFLINE, per source warehouse | one manual export on 16 Oct; Vishnu daily is decided (INV9-4) | written by the temporary loader to `gcc_channel_reports.catalog_live_checks_namshi_3p_uae` / `_ksa`; no data-team table yet (upstream request U-1 open) | not in `VALIDATED_REPORTS` (GD-CFG); 02 found no loaded rows |
| C-08 Amazon All Listings | SP-API `GET_MERCHANT_LISTINGS_ALL_DATA`, accounts "Exporio AE" and the KSA seller account | manual pull on 16 Oct; Siva's API job daily is decided (INV9-5) | loader to `gcc_channel_reports.all_listings_amazon_3p_uae` / `_ksa`; no raw table yet (U-1 open) | not validated; Amazon live uses the C-06 Active Listings fallback |

- **Example, Noon.** The last Noon Not Live file (21 Aug) held 264 UAE and 215 KSA SKUs not live for "Content
  Issues", 365 of them French Connection (207 UAE, 158 KSA) (02). Nobody knows today's list. At 31.2 USD a year per
  live French Connection listing, 365 SKUs are 11.4k USD a year if all came back (06 Worked example 3).
- **Example, Namshi.** C-04b is the only source of Namshi's `No valid image`, `QC failed` and `Content incomplete`
  reasons (02; GD-06 section 6.4). The one manual C-04b file of 16 Oct already answered a live question: 53 UAE SKUs
  were offline while holding stock, all with a non-stock reason (GD-06 AT-08).
- **Example, Amazon.** C-06 holds Active and Inactive listings, about 4x the live count (GD-06 C-06). On 16 Oct the
  UAE All Listings file had 17,646 rows: 3,653 Active, 11,527 Inactive, 2,466 Incomplete (GD-06 C-08). The page
  labels Amazon live "fallback, overstates live" until C-08 is validated (GD-DEC D-03).

### P2. A feed change looks the same as a mass delisting

- Noon KSA (24 Oct) and Namshi KSA (23 Oct) each dropped about 11 points in one day, while "Reasons not connected yet"
  rose from about 135 to 170 pairs to about 721 to 735. Amazon UAE dropped 10 points on 21 Oct (137 to 750 pairs)
  and partly recovered on 24 Oct (02 "Trend").
- **Example.** Namshi KSA fell from 97.8% live on 17 Oct to 86.8% on 24 Oct, with all 721 not-live pairs unexplained
  (02 "Latest snapshot"; "Not-live reasons ranked"). At about 126 USD a year per live Namshi pair (06 Money table),
  721 real delistings would matter; a changed file would not. Today the report cannot tell which (07 Example).
- `fact_gcc.channel_feed_status_daily` already records per report and day: rows, 7-day median rows, header check,
  freshness (fresh, stale, missing, suspect, never), connected and validated (GD-06 section 6.5). It flags a missing
  or odd-sized file. It does not flag a jump in unexplained pairs on a day the file itself looks normal.

### P3. Traffic and conversion data are missing where most money is

| Channel | Table | State (source) |
|---|---|---|
| Amazon UAE / KSA | `raw_gcc_table_cleaned.traffic_sales_amazon_3p_uae` / `_ksa` | daily to 23 Oct 2026; join only by `child_asin` (02 "Traffic and conversion") |
| Noon UAE / KSA | `raw_gcc_table_cleaned.traffic_sales_noon_3p_uae` / `_ksa` | data from 2 Jan to 4 Feb 2026 only (02); the tables were last modified on 24 Jul 2026 IST with 27,685 UAE and 24,539 KSA rows (GD `docs/channel-replenishment/investigations/2026-10-05_replen_observations/sql/sku_result_29.tsv`) |
| Namshi | none | the ingestion lineage lists a raw `traffic_sales` report type for Namshi (GD-LIN, Namshi row) but no table exists (02) |
| Trendyol | none; product list `product_list_trendyol_3p_*` (C-05) stopped after 22 Oct | 02 Gaps 7; Trendyol campaign data `campaign_trendyol_3p_*` ends 2026-06-05 (01 Gaps 1) |

- Namshi is the largest softline revenue channel (12-month GMV on live options: Namshi KSA 1,044,043 USD, Namshi UAE
  639,445 USD, 02) and the largest ad channel (76,271 USD spend in 90 days, 01 s2.2), yet has no page-level traffic.
- **Example.** In the last Noon traffic window (2 Jan to 4 Feb 2026) US Polo had 139,665 UAE and 181,862 KSA visitors
  at 1.36% and 0.87% conversion (02). There is no newer Noon number, so a Noon page fix cannot be measured on organic
  traffic.

### P4. Nobody records which images went live where

- The catalog module stores every rendered image per product, channel and position: `catalog_outputs` holds
  `channel`, `n` (position), `is_live`, `published_at`, `superseded_at`, `public_url`, `compliance` and `qa_scores`
  (CM `catalogOutputs`). It does not store the shot role, a generated flag, the country, or the date the image was
  uploaded to the marketplace. "Published" means the public link is ready, not that the portal shows it.
- The warehouse has no image fields for Noon, Namshi or Amazon (01 Gaps 2). The earlier Trendyol image-to-sales join
  matched 1,512 of 11,443 order lines (13%) (DD9 s4).
- Every lift in the roadmap is therefore judged (06 "Assumptions and confidence" row 5), and our own data shows no
  link between image count and conversion (CVR ratio 0.954, 9 of 18 cells each way, 01 s3).

### P5. Time to live and the not-listed queue

- Time to live is not measurable: liveness history starts 17 Oct 2026 and the live feeds carry no created date (02
  Metrics; Gaps 4).
- 865 stocked pairs are not on the portal: Noon 1, Namshi 179, Trendyol 141, Amazon 544, 1.7% of 49,888 stocked
  (02 "Not-live reasons ranked"; 06 Catalog health). Each already has a sub-reason (code in sheet but not on portal,
  code only in item master, no channel code) (GD-DEC G3-4, G4-9), but nobody owns the list.

## Who it serves

| Who | What they get |
|---|---|
| GCC business team (Nitin Kiran, Naz) | One trusted liveness number with reasons, and measured instead of judged lifts before funding initiatives 4 to 6 |
| Catalog team (Tarannum and the sheet owners of tab `Naaz update`) | A daily work list: content rejections by SKU and reason, not-listed pairs routed by sub-reason |
| Brand and channel managers | Which listings each marketplace rejects and why, per brand |
| Marketing team and the ad agencies | A clean test of whether better pages raise ad conversion, with spend held steady |
| Catalog module operators | Proof that what they publish goes live and what it does |
| Initiatives 2 to 6 | Rejection feeds to re-submit against (2), the treatment log and holdout cells (3, 5, 6), the completeness score (4) |

## Metrics it moves, and today's baselines

| Metric | Definition | Baseline today (source) | Target (judged) |
|---|---|---|---|
| Reason coverage | not-live pairs with a known reason / not-live pairs | 38% (1,396 of 3,639) on 24 Oct (02 Metrics) | 90% or more |
| Content rejection rate | Content-bucket pairs / stocked pairs, per channel-country | 0 in the report (feeds missing); Noon last file 264 UAE and 215 KSA SKUs, about 3.0% and 3.9% of stocked (06 Catalog health) | measured daily for Noon, Namshi, Amazon |
| Namshi image rejections | pairs with `No valid image` / stocked | not measurable (02) | measured daily |
| Not-listed rate | "Not listed" pairs / stocked pairs | 865, 1.7% of 49,888 (06 Catalog health) | every pair decided: listed or marked deliberately out of scope |
| Liveness rate | stocked AND live / stocked AND live known | 92.7% on 24 Oct (46,249 of 49,888); 95.5% on 17 Oct (02) | not a target here; made trustworthy (Amazon on C-08, feed-health flag) |
| Unexplained one-day moves | one-day liveness moves over 5 points with no label | 3 in 9 days (Noon KSA, Namshi KSA, Amazon UAE) (02 "Trend") | 0 unlabelled |
| Traffic coverage | channels with page traffic in the warehouse | Amazon only; Noon stale since 4 Feb (02) | Amazon, Noon; Namshi if the portal exports it |
| Time to live | first live snapshot date - first seen date | not measurable (02) | reported for every EAN first seen after 17 Oct 2026 |
| Content-to-sales join coverage | treated options matched to ads and sales rows | 13% (DD9 s4) | 95% or more of options in the treatment log |
| Live listings with role tags | live listings whose images carry a role and position | 0; only the 141-product audit sample (03; 06 Catalog health) | every listing the module publishes |
| Completeness score per channel | required roles present, attributes filled, English and Arabic present, no open rejection | not defined (06 Catalog health) | defined and reported per brand and channel |
| Measured lifts | revenue rows of 06 whose lift comes from a test | 0 of 11 base rows (06 Summary table) | at least the Phase 1 cells (B1, L1, Amazon) |

## Solution

**Choice: build, on what already exists.** No vendor sells GCC rejection feeds or our treatment log (05 Capability
table; 07). The feeds load into the gcc-dashboard liveness and marketing jobs that already run; the treatment log
lives in the catalog module. One optional "buy": Amazon's free Manage Your Experiments tool (04, "Amazon's free
tools") could A/B test main images on Amazon if the brand's Brand Registry access is available to us (owner question 9).
It does not cover Noon or Namshi, so the holdout below stays ours.

### What already exists

| Piece | Where | What it gives |
|---|---|---|
| Liveness job | Cloud Run job `catalog-liveness-job`, code `pipeline/catalog_liveness/` (`main.py`, `feeds_loader.py`, `canonical.py`, `reasons.py`, `liveness.py`, `metrics.py`, `config.py`), runs 13:15 and 14:30 IST (02 Source map; GD-DEC D-06) | step 0 temporary loader for C-04b and C-08 from `gs://opptra-datawarehouse-prod/Region/GCC/Channel/...` (fallback `-dev`); step 1 canonical tables; step 2 liveness |
| Reason parsing | `canonical.py` already parses C-04b `notes` (JSON parsed twice) and maps failed checks to reasons in the decided precedence (INV9-10); C-08 `status` to Amazon reasons; C-02 `offer_status_reason` | the code path is ready; the files are not |
| Canonical tables | `fact_gcc.channel_listing_rows_daily`, `channel_listing_status_daily` (`portal_reasons`, `portal_keys`), `channel_listing_exceptions_daily`, `channel_feed_status_daily` (02; GD-06 section 6) | one status row per EAN x channel-country per snapshot; per-report freshness |
| Liveness output | `fact_gcc.catalog_liveness_daily` (partition `as_of_date`, kept 400 days), `fact_gcc.catalog_liveness_run` (02) | live, reason bucket and sub-reason per pair |
| Marketing job | Cloud Run job `python -m marketing_ads` (`pipeline/marketing_ads/`), 10:30 and 13:30 IST, loads finance's `gs://cwn_output/GCC/Marketing/Cleaned/GCC_Marketing_<date>.csv` into `gcc_marketing.ads_daily`, rebuilds `gcc_marketing.sku_option` (01 s1.3) | ad clicks, units, spend, sales per day x channel-country x channel SKU; option map (97.7% of softline spend, 01 s2.7) |
| Stock and size guards | `fact_gcc.cut_size_option_daily`, `fact_gcc.unified_inventory`, `unified_channel_inventory` (01 s1.2) | broken size run and stock per option, for holdout eligibility |
| Sales | `fact_gcc.unified_sales_tertiary_v2` (net), `fact_gcc.unified_sales` (gross, `return_reason`) (02; 06) | units, GMV, Namshi return reasons |
| Catalog module records | Cloud SQL tables `catalog_outputs` (channel, position `n`, `is_live`, `published_at`, `superseded_at`, `public_url`, `compliance`), `catalog_products` (`option_id_style_color`, `opptra_sku_ids`), `sku_map` (`channel_ids` per channel key, `ean`), `catalog_product_events`, `catalog_batches` (`channels`, `created_at`) (CM) | which image sits at which position for which product and channel, and when it was made public |
| Noon listing tracker | Cloud SQL `gcc_catalog`, Child Zsku tracker ("Missing since", "Done on") (02 Gaps 9) | a time-to-list proxy for Noon (not queried) |

### What this initiative adds

**1. Restore and validate the three reason feeds** (06 "Data feeds to fix first" rows 1 to 3). Order and owners:

| Step | Feed | Who | Done when |
|---|---|---|---|
| 1a | C-02 Noon Not Live, AE and SA, file names `{ae,sa}_noon_catalog_not_live_DD_MM_YYYY.csv` in `Region/GCC/Channel/Noon/Report_type/catalog_non_live/Country/{UAE,KSA}/` (folder, ingestion config and cleanup already exist) | Vishnu now (GD-DEC D-01), or the `ceegees.in` vendor job (owner unknown, GD-06 OQ-1), or the Increff account's exports landed in the same folder | acceptance test AT-03: daily file both countries, every `offer_status_reason` in the 6.4 list, rows within 50% to 150% of 7,928 UAE / 11,703 KSA (GD-06 section 10) |
| 1b | C-04b Namshi Catalog Live Status, 2 to 4 files a day (source AE and SA) | Vishnu (download), data-processing owners for the `catalog_live_checks` ingestion config (U-1), Sujan for first-run sign-off | page check passes (`max(row_nr)` equals portal Total Rows); the source-AE `partner_sku` set equals C-04 AE that day; Namshi KSA reasons stop showing as Unknown (GD-DEC G4-10) |
| 1c | C-08 Amazon All Listings, daily | Siva (SP-API job), data-processing owners for `all_listings` (U-1), Sujan sign-off, Ashish confirms the live rule (GD-DEC D-03) | C-08 added to `VALIDATED_REPORTS` in `config.py`; Amazon live switches from C-06 to `status = 'Active'`; C-06 retired (INV9-5) |

**2. Restore traffic and add a feed-health flag** (06 rows 4 to 7).
- Noon traffic: restart the Noon `traffic_sales` download into the existing landing folder so
  `traffic_sales_noon_3p_*` fills again; key `sku` (child ZSKU) and `partner_sku` (02). Owner: whoever made the Noon
  files until 4 Feb (vendor job or Vishnu; owner question 4).
- Namshi traffic: ask Namshi's account manager whether the partner portal exports page views or conversion per SKU;
  if yes, it lands under the `traffic_sales` report type the lineage already lists for Namshi (GD-LIN). If no, record
  the "no" and keep Namshi measured on ads only (06 row 5).
- Trendyol: restart C-05 (stopped after 22 Oct; Vishnu) and ask whether the Trendyol partner portal has a product
  traffic export (owner question 6).
- Feed-health flag: in the liveness job's soft checks (`metrics.py`, spec 4.9) label every channel-country day where
  liveness moves more than 5 points (judged threshold), with one of: `feed_change` (row count, header or key-match
  rate of the live-defining report moved, from `channel_feed_status_daily` and `channel_listing_exceptions_daily`),
  `reason_feed_missing` (the pairs went to Unknown) or `real_change` (pairs moved into a known reason). The page shows
  the label beside the move.

**3. Record image role, position and test arm per listing: the treatment log** (06 "What the catalog module must
record").
- Per published image, add to the module record: the shot role (from initiative 2's role tagging, DD1
  Recommendation; until then the position and source image hash only), a generated flag (false for every image today),
  and the channel rules version (already in `CHANNEL_RULES_VERSION`, used in the render key).
- Per option x channel x country, add: the date the catalog team or agency uploaded the set to the portal (entered
  per batch and channel, since the module does not upload), the holdout cell and arm, and a hold flag that stops
  the module publishing new images for a control option until its cell finishes.
- A daily export of this log to BigQuery keyed on `option_id_style_color`, EAN, channel and country, so it joins
  `ads_daily` (via `sku_option`), `catalog_liveness_daily` and the sales tables. Today the module worker only reads
  BigQuery (`roles/bigquery.dataViewer` on `raw_gcc_dimensions`, `dimensions`, `fact_gcc`, `docs/SPEC.md`), so the
  export needs one write grant on one dataset (owner question 11).
- Confirm "went live": the pair's first live snapshot in `catalog_liveness_daily` after the upload date. Where a feed
  carries image links (Trendyol `image_1` to `image_8`, Amazon `image_url` for the main image, GD-CFG), also check
  that the image changed; Noon and Namshi feeds carry no image column (GD-CFG C-01, C-03 columns), so a scheduled
  check of the live page or the agency's upload confirmation is the evidence there.

**4. Define the per-channel completeness score** (04 "Borrow list"; 06 Catalog health). Elements per channel: the
channel's required roles present (role tags from step 3 and initiative 2), mandatory attributes filled (initiative
4's fact sheet; until then reported as "not yet measured"), English and Arabic present (Namshi C-04b carries
`title_en` and `title_ar` for offline rows, GD-CFG), and no open rejection (steps 1a to 1c). Score = elements present
/ elements required, reported per brand and channel-country in the liveness page.

**5. Time to live.** Definition: first `as_of_date` the pair is live in `catalog_liveness_daily` minus the first date
the EAN is seen in the sheet, `master_sl` or stock. Stages, each from a source that exists: item seen; images ready
(`catalog_batches.created_at` and `catalog_outputs.published_at`, CM); listed (channel code in the sheet, GD-CFG
`SHEET_COLUMNS`); live (liveness). Partial creation dates also exist in the feeds: Namshi C-03 `created_at` and
Amazon C-06 / C-08 `open_date` (GD-CFG contracts), and the Noon Child Zsku tracker. History builds up from 17 Oct
2026 (02 Gaps 4), so the metric covers EANs first seen after that date.

**6. Work the not-listed queue.** The 865 pairs (Noon 1, Namshi 179, Trendyol 141, Amazon 544) are routed by
sub-reason, the same way portal exceptions are already routed by `fix_where` (GD-06 section 6.6): "Code only in item
master" and "No channel code" to the sheet owners (Tarannum); "Code in sheet but not on portal" to the channel owner. Deliberately-off clusters
(for example Nautica or French Connection on Amazon) become scope rows, which is pending Ashish and Tarannum (GD-DEC
R5 / G4-3). Each pair ends as listed or marked out of scope.

## Holdout test design

Goal: replace the judged lifts (B1, L1, Amazon gallery fixes first; B4 and B5 later) with measured ones, one cell per
lever (06 "Holdout test design").

**Unit.** One style-colour option (all its sizes) on one channel-country (06). If Noon or Namshi show one gallery to
both UAE and KSA for the same partner SKU, both countries take the same arm and country becomes a stratum (owner
question 10). Noon and Namshi share stock pools, so arms are compared within a channel-country, never across channels.

**Assignment.** Strata: brand x channel-country x price tercile x past click band (06). Inside each stratum, pair
options by clicks in the pre-period and assign one of each pair to treatment by a recorded random seed. The arm is
written to the treatment log before any image changes. Balance check before launch: the pre-period CVR difference
between arms must not be significant (an A/A check on data already in `ads_daily`, which holds Namshi and Noon from
1 Jan 2026, 01 s1.4).

**Eligibility** (06 "Eligibility guards"): live and stocked; no broken size run in `fact_gcc.cut_size_option_daily`;
no price, bid or budget change during the test (freeze agreed with the agencies); at least 200 clicks in the
previous 90 days for ad cells.

**Channels and cells, Phase 1** (07 "Phased view"):

| Cell | What is treated | Channel | Primary metric |
|---|---|---|---|
| 1. B1 | re-render and reorder to the channel rule; French Connection, Penti, Vero Moda, Cardio Bunny | Namshi Sponsored Products | ad CVR |
| 2. L1 | gallery fixes on the content-linked weak pool (from the 236 options, 01 s2.6) | Namshi and Noon ads, one stratified estimate | ad CVR |
| 3. Amazon | gallery fixes on the 187 high-traffic, low-conversion ASINs (deduplicated to options) | Amazon UAE and KSA | unit session % |

B4 (lifestyle) and B5 (infographic) cells on US Polo footwear wait for brand rights and Noon / Namshi acceptance
(07). A Noon organic cell waits for Noon traffic (step 2).

**Sample size reasoning.** Two-sided 5% test, 80% power: n per arm = 7.84 x [p1(1 - p1) + p2(1 - p2)] / (p2 - p1)^2,
then x2 for clustering by option (judged) (06 "Sample size").

| Cell, baseline (source) | Lift to detect | Per arm, after x2 | Control-arm ad units or orders at the threshold (derived) | Volume in the last 90-day window (source) |
|---|---|---|---|---|
| Namshi ads, all softline, CVR 1.64% (06) | 15% | 89,700 clicks | about 1,470 | 426,623 Namshi softline clicks (01 s2.2); 377,023 on options with 200+ clicks (Q-A) |
| Cell 1 B1, four apparel brands on Namshi, CVR 1.81% (2,810 ad units / 155,399 clicks, 01 s2.4) | 20% | 46,700 clicks | about 845 | 155,399 clicks |
| Cell 1 B1, same | 15% | 81,200 clicks | about 1,470 | needs more than one window's 155,399 clicks |
| Cell 2 L1, weak pool, CVR 0.78% (1,420 / 182,444 all channels; 1,033 / 133,009 Namshi; Q-A) | 25% | 71,700 clicks | about 560 | 182,444 clicks all channels; 133,009 Namshi |
| Cell 2 L1, content-linked part only (about 44.6% of weak spend, 06 L1) | about 40% | 29,900 clicks | about 230 | about 81,000 clicks (derived: 182,444 x 44.6%, assumes clicks follow spend) |
| Cell 3 Amazon 187 ASINs, unit session 0.13% (52 units / 39,727 sessions, measured in initiative 3 Q-A; 02's rounded missed units imply 51) | from 0.13% to 0.34%, a quarter of the gap to the country rate of 0.99% | 16,000 sessions | about 21 orders | 39,727 sessions (UAE 15,805, KSA 23,922) |
| Amazon US Polo, all ASINs, unit session 0.99% (06) | 25% | 56,300 sessions | about 560 | 109,737 sessions (06 Q1) |

Readings:
- Namshi detects about 15% per cell on the whole softline pool (07 Summary 7). The B1 cell is smaller (four
  brands), so it is sized for 20%; 15% would need more clicks than one window gives.
- L1 can see a 25% lift only when Namshi and Noon are pooled; its judged base of 10% cannot be measured directly.
  The pool sits at least 30% below brand CVR by construction (01 s2.6 rule), so a fix that closes part of that
  gap is a large relative lift.
- Small lifts (1% to 3%, as in B4, B5, B6, L4) cannot be measured on any channel (06); those rows stay judged
  unless a cell shows a larger effect.

**Duration, as a traffic and order threshold, not calendar time.** A cell stops when both arms have reached the
"per arm" clicks or sessions in the table and the control arm has at least the ad units or orders shown. It is then
read once, at the end of that analysis week, with no earlier peeking at the primary metric. The pre-period is the
same volume of clicks per arm taken from history before treatment.

**Success metric.** Primary: ad CVR (ad units / ad clicks, sum then divide) on Namshi and Noon; unit session % on
Amazon (06). Analysis: difference in differences per option-week (treated vs control, before vs after), standard
errors clustered by option (06). Success = the 95% interval of the relative lift is above 0. If the interval
includes 0, the matching 06 row keeps at most the interval's upper bound, or is dropped (07 Risk 1).

**Guardrails** (thresholds judged):

| Guardrail | Source | Rule |
|---|---|---|
| Freeze holds | `ads_daily` spend and CPC per option-day; price from the channel feeds | a pair where either option changed bid, budget or price leaves the analysis; if more than 20% of pairs leave, the cell is void |
| Stock and size run | `cut_size_option_daily`, `unified_inventory` | days with a broken size run or no stock leave the analysis for both members of the pair |
| Click split | `ads_daily` | arms within 45% to 55% of a cell's clicks; outside that, check the assignment |
| CTR | `ads_daily` | treated CTR not lower than control by more than the lift the cell can detect (the main image changes CTR) |
| ROAS and ACoS | `ads_daily` | reported beside CVR so a budget change is not read as a catalog effect (01 s4) |
| New rejections | C-02, C-04b, C-08 via `catalog_liveness_daily` | any treated listing that goes not live for a content reason is reverted and reported |
| Fit returns | `fact_gcc.unified_sales` `return_reason`, Namshi | reported per arm; a rise in the treated arm is flagged |

## Cost and ROI

All money is USD a year; formulas and shares follow 06 "L2b" and 07 "Initiative 1".

**Revenue (L2b, recovered not-listed pairs).**
- If all recovered, at channel means: Noon 1 x 47.5 + Namshi 179 x 126.1 + Trendyol 141 x 14.75 + Amazon 544 x
  3.78 = 48 + 22,572 + 2,080 + 2,056 = 26.8k (06 "L2b"; revenue per live pair from 06 Money table).
- Recovered share 0 / 25% / 50% (judged): **low 0, base 6.7k, high 13.4k** (07).
- Means overstate a random listing: the top 10% of option-pairs carry 86.2% of revenue (02).

**Not claimed.** If all 2,243 unexplained pairs were real delistings they would be worth about 136k at channel means
(06 L3 row); they are probably mostly feed artefacts (02), so nothing is counted. Restoring C-02 is also what lets
initiative 2 recover Noon content rejections (L2a, base 7.5k), counted there, not here (07).

**Run cost.** About 0: the feeds load inside the existing `catalog-liveness-job` and `marketing_ads` jobs, the
treatment log is rows in the catalog module's existing Cloud SQL database, and there is no generation (07 "Total
budget"; 06 L3 row). People time is excluded by rule (06 Assumptions row 11).

**ROI.** Not meaningful as a ratio at about 0 run cost (07). The value is information: the holdout decides how much
of the other 262.7k of judged base (269.4k - 6.7k, 06 Summary table) is real. For example, a B1 cell that shows no
lift removes 14.0k from the base; an L1 cell that shows one confirms the 5.0k of ad money (06 Summary table).

**Cost of holding out.** While a cell runs, its control half does not get the fix. Forgone value = cell base value x
50% x the share of a year the cell runs. At base that is at most 7.0k a year for B1 (14.0k x 50%) and 2.5k for L1
(5.0k x 50%), pro rata for the length of the test (derived from 06).

## Risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| 1 | Feed owners do not restart the downloads (C-02 has had no owner since 21 Aug; C-04b and C-08 are decided but not yet daily) | Reason coverage stays at 38%; initiative 2 cannot re-submit Noon rejections | Named owner per feed (GD-06 section 9); acceptance tests AT-03 and first-run sign-off; the morning alert already lists failed checks (GD-06 section 8) |
| 2 | Upstream ingestion config for `catalog_live_checks` and `all_listings` stays open (U-1) | The temporary loader stays in our job longer | The loader already covers both (GD-06 section 1.1); switch off per report when the data team's table lands |
| 3 | Namshi has no traffic export | Namshi measured on ads only, no organic conversion | Ads cells already carry the most volume (01 s2.2); record the answer and move on |
| 4 | Treatment log is incomplete because portal uploads are done outside the module | Wrong "went live" dates; diluted lifts | Upload date entered per batch and channel; liveness and image-link checks confirm it |
| 5 | Agencies change bids or budgets on test options | Lift mixed with spend changes | Written freeze; pairs that break it leave the analysis; void rule at 20% |
| 6 | Weak-pool and Amazon cells are chosen for low conversion, so they drift up on their own (regression to the mean) | A before-after reading would overstate the fix | The control arm takes the same drift; only the difference in differences is reported |
| 7 | Cells are too small for the lifts the model assumes (1% to 10%) | Many rows stay judged | Report detectable effects up front (table above); pool strata where the metric is the same |
| 8 | Feed-health threshold mislabels moves | False alarms or missed delistings | Label from the feed's own row and key-match changes, not from liveness alone; review labels with the catalog team |
| 9 | Option key gaps: 4,925 live EAN-pairs (about 11%) have no `option_id_style_color` (02 Gaps 8) | Some listings cannot be assigned or joined | They count as their own option (02 method); ask the sheet owners to fill the key for test brands |
| 10 | Amazon live count drops sharply when C-08 replaces the fallback | Looks like a crash on the page | Announce the rule change; show the old and new rule side by side for the switch-over runs |

## How we measure success

1. Reason coverage rises from 38% to 90% or more of not-live pairs, and the Content bucket shows real Noon and Namshi
   rejections by SKU (source: `catalog_liveness_daily`).
2. C-02, C-04b and C-08 show `freshness = fresh` and `validated = TRUE` in `channel_feed_status_daily` on every run
   after sign-off; Amazon live runs on C-08.
3. `traffic_sales_noon_3p_*` holds rows dated after 4 Feb 2026; Namshi has a traffic export or a recorded "no".
4. Every liveness move above the threshold carries a label; no unlabelled moves.
5. Every image the module publishes after the change has role (once initiative 2 tags it), position, generated
   flag, upload date and arm in the treatment log, and 95% or more of treated options join to `ads_daily` and sales.
6. Time to live is reported for EANs first seen after 17 Oct 2026; the completeness score is reported per brand and
   channel-country.
7. Each of the 865 not-listed pairs is either listed or marked out of scope; recovered pairs and their revenue are
   counted from `catalog_liveness_daily` and `unified_sales_tertiary_v2`, replacing the judged 25%.
8. The Phase 1 cells reach their thresholds and report a measured lift with a 95% interval; each matching 06 row is
   updated or dropped.

## Dependencies

- Inside the program: none to start (07). Role values for the treatment log come from initiative 2's role tagging
  (DD1); until then the log carries position and source image hash. Cells 1 to 3 need initiative 2 and 3's fixes to
  exist before treatment.
- Outside the program:
  - Vishnu: C-02 (now, D-01), C-04b daily, Trendyol C-05 restart.
  - Siva: C-08 in the daily SP-API job.
  - Data-processing owners (Rama): ingestion config for `catalog_live_checks` and `all_listings` (U-1); the vendor
    owner for Noon C-01 / C-02 (`ceegees.in`).
  - Ashish: confirm the Amazon live rule (D-03) and which clusters are deliberately out of scope (R5).
  - Tarannum: sheet fixes for not-listed pairs and the option key for test brands.
  - Namshi account manager: traffic export.
  - Ad agencies and the marketing team: bid, budget and price freeze for test options.
  - Warehouse owners: one write grant for the treatment log export.

## Owner questions

1. Who loads Noon Not Live (C-02) from now on: Vishnu (D-01), the `ceegees.in` vendor job, or the Increff account's
   existing exports landed in the same folder?
2. Siva: is C-08 now in the daily API job for both accounts? Ashish: is `status = 'Active'` the Amazon live rule (D-03)?
3. Data-processing owners: when the `catalog_live_checks` and `all_listings` ingestion config lands (U-1), can it keep
   history (`DELETE_AND_INSERT` by `file_date`) as GD-06 asks?
4. Who made the Noon traffic files until 4 Feb 2026, and can they restart? Why were the tables last modified on
   24 Jul 2026 with data only to 4 Feb?
5. Does Namshi's partner portal export page views or conversion per SKU? The ingestion already lists a Namshi
   `traffic_sales` report type with no table.
6. Trendyol: who restarts the product list after 22 Oct, and does the partner portal have a product traffic export?
7. Does GCC adopt one completeness score per channel as the headline catalog metric (04 Q4)?
8. Will the ad agencies freeze bids, budgets and prices on test options, and who signs for each agency?
9. Do we have Brand Registry access for US Polo on Amazon.ae and Amazon.sa (for Amazon's free Manage Your Experiments)?
10. Do Noon and Namshi show one gallery for a partner SKU in both UAE and KSA? This decides the test unit.
11. Where should the treatment log live in the warehouse, and who grants the catalog module write access to that one
    dataset?
12. Who enters the portal upload date per batch and channel: the catalog team or the agency?
13. Which not-listed clusters are deliberate (for example Nautica or French Connection on Amazon) (GD-DEC R5)?

Status: done
