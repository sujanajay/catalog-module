# 01 - Marketing data map and analysis (GCC catalog roadmap, agent A)

Documents only. Nothing was built or changed. All queries were read-only jobs in `opptra-datawarehouse`, run on 2026-10-26.
Every number is marked **(exact)** when it comes straight from a query below, or **(approx)** when it is derived or rounded by hand.
Money is USD at the dashboard's fixed rates (AED / 3.672, SAR / 3.75). "Ad sales" are the portal's attributed sales and probably include VAT (dashboard spec 6.3).

## Summary

1. The marketing report reads one table, `opptra-datawarehouse.gcc_marketing.ads_daily`, a daily full replace of finance's CSV `gs://cwn_output/GCC/Marketing/Cleaned/GCC_Marketing_<date>.csv`. It covers only **Amazon, Noon and Namshi** in UAE and KSA. Trendyol, Styli, Centrepoint, 6thStreet, VogaCloset and Shein have no ads data in it.
2. Grain: day x channel x country x 1P/3P x campaign type x campaign x channel SKU (ASIN / Noon SKU / Namshi SKU), with an internal SKU. Data runs from 2025-05-06 (Amazon UAE) and 2026-01-01 (Noon, Namshi) to 2026-10-23 (exact).
3. Last 90 days (2026-07-26 to 2026-10-23), all brands: $220,889 spend, CTR 1.27%, CVR 2.39%, ROAS 5.12, ACoS 19.5% (exact). Softline only: $111,752 spend, CTR 1.34%, CVR 1.64%, ROAS 3.39, ACoS 29.5% (exact).
4. Softline ad money sits on Namshi ($76,271 in 90 days, 68%) and Noon ($25,648, 23%); Amazon softline is small ($9,833) (exact / approx shares).
5. USPA is the biggest softline advertiser ($55,280 in 90 days, ROAS 4.67). CAMPUS (ROAS 1.65, ACoS 60.7%), Keds (1.68), French Connection (2.64), Penti (2.19), Cardio Bunny (2.25) and Vero Moda (2.70) run at ACoS of 37-61% (exact).
6. 27.3% of softline 90-day spend ($30,513) goes to 236 options with at least 200 clicks whose CVR is below 70% of their brand's CVR. That pool returns ROAS 1.75 against 4.25 for the other well-clicked options (exact). This is the pool a catalog fix could target.
7. Joins are strong: 99.9% of softline spend joins to `master_sl`, 97.7% to a style-colour option, and 99.0% to a Trendyol image count (exact).
8. Signal: within the same brand, channel and price band, options with 7-8 Trendyol images do **not** convert or click better than options with fewer (CVR ratio 0.95, CTR ratio 1.05, 9 of 18 cells each way; 300 vs 301 options). No supported effect. The image-count proxy is weak (Trendyol image count, not the image count on Namshi/Noon/Amazon) and on-model vs packshot is not in any table.
9. A catalog initiative can plausibly move CTR on sponsored listings (main image), CVR (gallery, title, attributes) and so ROAS / ACoS. Baselines per channel and brand are in section 5.
10. Gaps: no ads data for 7 of 10 channels, no image-level attributes, organic traffic for softline only on Amazon (USPA, Campus and the smaller brands; see Gap 3, corrected in review), and Noon traffic stops in Feb 2026.

## 1. Source map

### 1.1 Files read (gcc-dashboard repo, read only)

| What | Path (under `C:\Users\Sujan Ajay\Desktop\gcc-dashboard`) |
|---|---|
| Requirements spec (data contract section 5, metric dictionary section 6) | `docs/marketing/MARKETING_DASHBOARD_SPEC.md` |
| Loader job (the pipeline) | `pipeline/marketing_ads/` (`README.md`, `main.py`, `load.py`, `checks.py`, `config.py`, `sku_option.py`) |
| API endpoints | `backend/api/routers/marketing.py` (prefix `/api/gcc/marketing`: `/config`, `/bootstrap`, `/brands`, `/brand/{brand}/skus`, `/periods`, `/brand/{brand}/skus/periods`, `/trend`, `/actions`, `/export`) |
| Queries and brand cleaning | `backend/api/services/marketing_service.py`, `backend/queries/brand_sql.py` |
| Ratio formulas, growth, periods | `backend/api/services/marketing_metrics.py` (`with_ratios` lines 410-422, `drr` 512, `direct_growth` 548), `backend/api/services/marketing_periods.py` |
| Downloads | `backend/api/services/marketing_files.py` |
| Response shapes | `backend/api/schemas/marketing.py` |
| Repo overview | `README.md` (line 117: Marketing job runs at 10:30 and 13:30 IST) |

### 1.2 Tables that feed the Marketing report

| Table | Role | Grain |
|---|---|---|
| `opptra-datawarehouse.gcc_marketing.ads_daily` | All ad metrics. 30 columns: `date, region, country, country_code, channel, channel_name, channel_type, campaign_type, campaign_id, campaign_name, channel_sku_code, internal_sku_code, brand_raw, impressionsviews, ad_clicksgvs, ad_units_sold, atc, ad_spend, ad_sales, currency, ctr, cvr, roas, acos, fx_per_usd, ad_spend_usd, ad_sales_usd, source_file, load_run_id, loaded_at`. Partitioned by month on `date`, clustered by channel, country, brand, internal SKU | One row per file row, no dedupe. Logical key day x channel x country x 1P/3P x campaign type x campaign id x channel SKU (duplicates are summed) |
| `gcc_marketing.ads_load_log` | One row per run; freshness banner and coverage per channel x country | Run |
| `gcc_marketing.sku_option` | Softline SKU to style-colour option map, built by the Cut Size code | Master SKU |
| `raw_gcc_dimensions.sku_master_sheet_hl`, `raw_gcc_dimensions.master_sl` | Brand lookup on `internal_sku_code` (hardline first, then softline, then the file's brand), wrapped in `fact_gcc.alias_gcc_brand` | SKU |
| `fact_gcc.unified_sales_tertiary_v2` | Total Units and Total Sale (for TACOS, Ad Sale %), clamped to days that have ads data | Order line |
| Inventory tab union (`fact_gcc.unified_inventory` + `unified_channel_inventory`) and `fact_gcc.cut_size_option_daily` | Current stock and broken-size status for product rows and the Actions list | SKU x location |

### 1.3 Pipeline and refresh

- Source: finance's full CSV in `gs://cwn_output/GCC/Marketing/Cleaned/` (project `fintech-469706`). The file named D lands on D+1 at about 07:03 Gulf time and holds data to D-1. The `CM_` files in the same folder are never used.
- Job: Cloud Run job running `python -m marketing_ads`, scheduled by Cloud Scheduler at 10:30 and 13:30 IST (`marketing-ads-1030`, `marketing-ads-1330`). Steps: probe the newest file name (up to 7 days back), skip if the MD5 is unchanged, header check, typed staging table, checks C1-C10, atomic swap into `ads_daily` (`WRITE_TRUNCATE`), rebuild `sku_option`, append a log row.
- Latest loads (exact, from `ads_load_log`): `GCC_Marketing_2026-10-24.csv` loaded 2026-10-25 05:01 UTC, 2,020,132 rows, dates 2025-05-06 to 2026-10-23; the 13:30 run logged `skipped_unchanged`.
- Restatement: portals change the last few days; the daily full replace absorbs it. The dashboard labels each channel's last 6 days "may still change".

### 1.4 Channels and date range available (exact, query 3.0)

| Channel | Country | First date | Last date | Rows | Spend since 2025-01-01 (USD) |
|---|---|---|---|---|---|
| Amazon | KSA | 2025-05-21 | 2026-10-23 | 280,562 | 185,869 |
| Amazon | UAE | 2025-05-06 | 2026-10-23 | 213,011 | 89,233 |
| Namshi | KSA | 2026-01-01 | 2026-10-23 | 226,511 | 109,152 |
| Namshi | UAE | 2026-01-01 | 2026-10-23 | 274,042 | 86,975 |
| Noon | KSA | 2026-01-01 | 2026-10-23 | 446,380 | 146,281 |
| Noon | UAE | 2026-01-01 | 2026-10-23 | 579,626 | 99,328 |

So the "trailing 12 months" window (2025-10-24 to 2026-10-23) is a full 12 months only for Amazon; Noon and Namshi have about 10 months (approx).

Campaign types: Amazon has Sponsored Products, Brands and Display; Noon has Products and Brands; Namshi has Products only. Amazon reports ATC only for Brands and Display, so ATC is not usable for Amazon Sponsored Products.

### 1.5 Metrics the dashboard computes (spec 6.1, code `marketing_metrics.py`)

All ratios are "sum then divide" over the selection; ratios are never averaged. The file's own `ctr`, `cvr`, `roas`, `acos` columns are audit-only and never used.

| Metric | Formula |
|---|---|
| Impression | SUM(`impressionsviews`) |
| Clicks | SUM(`ad_clicksgvs`) |
| CTR | Clicks / Impression |
| ATC | SUM(`atc`) |
| Ad Units | SUM(`ad_units_sold`) |
| Ad Spend (USD) | SUM(`ad_spend_usd`) |
| Ad Sale (USD) | SUM(`ad_sales_usd`) |
| CVR | Ad Units / Clicks |
| ROAS | Ad Sale / Ad Spend |
| ACoS | Ad Spend / Ad Sale |
| CPC | Ad Spend / Clicks |
| Ad ASP | Ad Sale / Ad Units |
| Total Units, Total Sale | Sales tab net units and net GMV excl. VAT, clamped to days with ads data |
| Total ASP | Total Sale / Total Units |
| TACoS | Ad Spend / Total Sale |
| Ad Sale % | (Ad Sale / 1.05 for UAE or / 1.15 for KSA) / Total Sale |
| % of brand CVR, Weak flag | row CVR / brand CVR; "CVR below 70%" when at least 20 clicks and CVR < 0.70 x brand CVR |
| Growth | Counts: daily run rate over covered days per channel x country; ratios: relative change |

## 2. Facts

Common shape of every query below (exact SQL kept in the run scratchpad; the shape is enough to re-run):

```sql
-- brand as the dashboard does it (simplified: no Nutri split, no GTPlayer rename)
WITH hl AS (SELECT UPPER(TRIM(sku)) k, first non-blank brand by source_row_number FROM raw_gcc_dimensions.sku_master_sheet_hl),
     sl AS (SELECT UPPER(TRIM(product_code)) k, brand, category_name FROM raw_gcc_dimensions.master_sl),
     so AS (SELECT sku_key, option_id FROM gcc_marketing.sku_option WHERE option_id IS NOT NULL)
SELECT ..., fact_gcc.alias_gcc_brand(COALESCE(hl.brand, sl.brand, brand_raw)) AS brand,
       fact_gcc.family_of_gcc_brand(<brand>) AS family,           -- softline / hardline
       SUM(ad_clicksgvs)/SUM(impressionsviews) AS ctr, SUM(ad_units_sold)/SUM(ad_clicksgvs) AS cvr,
       SUM(ad_sales_usd)/SUM(ad_spend_usd) AS roas, SUM(ad_spend_usd)/SUM(ad_sales_usd) AS acos
FROM gcc_marketing.ads_daily d LEFT JOIN hl/sl/so ON key = UPPER(TRIM(d.internal_sku_code))
WHERE d.date BETWEEN '2025-10-24' AND '2026-10-23'   -- 12m; 90d = from '2026-07-26'
GROUP BY ...
```

Product key: softline = style-colour `option_id` (fallback internal SKU); hardline = internal SKU (fallback channel SKU).

### 2.1 Channel x country, all brands (exact)

Query: common shape, `GROUP BY ROLLUP(window, channel_name, country_code)`.

| Window | Channel | Country | Spend | Impressions | Clicks | CTR | Ad units | CVR | Ad sales | ROAS | ACoS | CPC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 90d | All | All | $220,889 | 81.0M | 1,031,362 | 1.27% | 24,665 | 2.39% | $1,130,955 | 5.12 | 19.5% | $0.214 |
| 90d | Amazon | KSA | $63,385 | 28.4M | 233,544 | 0.82% | 10,021 | 4.29% | $498,006 | 7.86 | 12.7% | $0.271 |
| 90d | Amazon | UAE | $14,981 | 6.94M | 45,034 | 0.65% | 1,223 | 2.72% | $79,463 | 5.30 | 18.9% | $0.333 |
| 90d | Namshi | KSA | $42,995 | 16.1M | 276,345 | 1.71% | 4,137 | 1.50% | $157,085 | 3.65 | 27.4% | $0.156 |
| 90d | Namshi | UAE | $33,276 | 10.4M | 150,278 | 1.44% | 3,236 | 2.15% | $96,221 | 2.89 | 34.6% | $0.221 |
| 90d | Noon | KSA | $44,985 | 13.0M | 232,054 | 1.78% | 4,063 | 1.75% | $207,367 | 4.61 | 21.7% | $0.194 |
| 90d | Noon | UAE | $21,266 | 6.06M | 94,107 | 1.55% | 1,985 | 2.11% | $92,812 | 4.36 | 22.9% | $0.226 |
| 12m | All | All | $700,141 | 260.5M | 2,912,819 | 1.12% | 69,961 | 2.40% | $3,592,716 | 5.13 | 19.5% | $0.240 |
| 12m | Amazon | KSA | $178,924 | 70.7M | 542,368 | 0.77% | 23,916 | 4.41% | $1,316,372 | 7.36 | 13.6% | $0.330 |
| 12m | Amazon | UAE | $79,480 | 24.0M | 162,199 | 0.68% | 6,516 | 4.02% | $482,089 | 6.07 | 16.5% | $0.490 |
| 12m | Namshi | KSA | $109,152 | 37.9M | 670,447 | 1.77% | 9,870 | 1.47% | $409,788 | 3.75 | 26.6% | $0.163 |
| 12m | Namshi | UAE | $86,975 | 31.0M | 413,878 | 1.34% | 8,916 | 2.15% | $293,555 | 3.38 | 29.6% | $0.210 |
| 12m | Noon | KSA | $146,281 | 59.2M | 723,887 | 1.22% | 11,568 | 1.60% | $612,012 | 4.18 | 23.9% | $0.202 |
| 12m | Noon | UAE | $99,328 | 37.7M | 400,040 | 1.06% | 9,175 | 2.29% | $478,900 | 4.82 | 20.7% | $0.248 |

Amazon is dominated by hardline (Nutricook, GTPlayer, Carote, NutriBullet, Bergner), which explains its high CVR and ROAS.

### 2.2 Channel x country, softline brands only (exact)

Query: common shape, `WHERE family = 'softline'`, `GROUP BY ROLLUP(window, channel, country)`.

| Window | Channel | Country | Spend | Clicks | CTR | Ad units | CVR | Ad sales | ROAS | ACoS | CPC |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 90d | All | All | $111,752 | 667,325 | 1.34% | 10,977 | 1.64% | $379,155 | 3.39 | 29.5% | $0.167 |
| 90d | Amazon | KSA | $4,808 | 40,818 | 0.57% | 433 | 1.06% | $15,536 | 3.23 | 30.9% | $0.118 |
| 90d | Amazon | UAE | $5,025 | 23,120 | 0.50% | 405 | 1.75% | $13,888 | 2.76 | 36.2% | $0.217 |
| 90d | Namshi | KSA | $42,995 | 276,345 | 1.71% | 4,137 | 1.50% | $157,085 | 3.65 | 27.4% | $0.156 |
| 90d | Namshi | UAE | $33,276 | 150,278 | 1.44% | 3,236 | 2.15% | $96,221 | 2.89 | 34.6% | $0.221 |
| 90d | Noon | KSA | $15,204 | 106,940 | 1.54% | 1,385 | 1.30% | $52,186 | 3.43 | 29.1% | $0.142 |
| 90d | Noon | UAE | $10,444 | 69,824 | 1.59% | 1,381 | 1.98% | $44,238 | 4.24 | 23.6% | $0.150 |
| 12m | All | All | $336,776 | 1,922,068 | 1.26% | 32,176 | 1.67% | $1,240,907 | 3.68 | 27.1% | $0.175 |
| 12m | Amazon | All | $17,281 | 89,549 | 0.47% | 1,154 | 1.29% | $40,063 | 2.32 | 43.1% | $0.193 |
| 12m | Namshi | All | $196,122 | 1,084,273 | 1.57% | 18,786 | 1.73% | $703,343 | 3.59 | 27.9% | $0.181 |
| 12m | Noon | All | $123,373 | 748,246 | 1.16% | 12,236 | 1.64% | $497,502 | 4.03 | 24.8% | $0.165 |

### 2.3 Channel x campaign type, last 90 days (exact)

| Channel | Campaign type | Spend | CTR | CVR | ROAS |
|---|---|---|---|---|---|
| Amazon | Sponsored Products | $71,158 | 0.85% | 4.04% | 7.32 |
| Amazon | Sponsored Brands | $4,239 | 0.57% | 3.14% | 6.04 |
| Amazon | Sponsored Display | $2,945 | 0.36% | 4.95% | 10.35 |
| Namshi | Sponsored Products | $76,271 | 1.61% | 1.73% | 3.32 |
| Noon | Sponsored Products | $65,107 | 1.78% | 1.86% | 4.50 |
| Noon | Sponsored Brands | $1,144 | 0.61% | 1.64% | 6.31 |

96% of 90-day spend is Sponsored Products (approx), the ad format whose creative is the listing's main image and title.

### 2.4 Brand x channel (exact; brands with at least $500 spend)

Query: common shape, `GROUP BY ROLLUP(window, brand, channel)`. Brand rows ("All") are the sum over channels.

**Last 90 days**

| Brand | Channel | Spend | Clicks | CTR | Ad units | CVR | Ad sales | ROAS | ACoS |
|---|---|---|---|---|---|---|---|---|---|
| USPA | All | $55,280 | 354,037 | 1.35% | 6,390 | 1.80% | $258,378 | 4.67 | 21.4% |
| USPA | Amazon | $5,344 | 44,455 | 0.65% | 607 | 1.37% | $23,564 | 4.41 | 22.7% |
| USPA | Namshi | $32,978 | 188,255 | 1.65% | 3,775 | 2.01% | $155,373 | 4.71 | 21.2% |
| USPA | Noon | $16,958 | 121,327 | 1.52% | 2,008 | 1.66% | $79,441 | 4.68 | 21.3% |
| CAMPUS | All | $16,866 | 96,228 | 1.17% | 1,050 | 1.09% | $27,794 | 1.65 | 60.7% |
| CAMPUS | Amazon | $2,166 | 13,684 | 0.42% | 164 | 1.20% | $4,081 | 1.88 | 53.1% |
| CAMPUS | Namshi | $9,941 | 55,068 | 1.59% | 560 | 1.02% | $15,362 | 1.55 | 64.7% |
| CAMPUS | Noon | $4,759 | 27,476 | 1.85% | 326 | 1.19% | $8,351 | 1.75 | 57.0% |
| French Connection | All | $13,657 | 76,258 | 1.31% | 838 | 1.10% | $35,991 | 2.64 | 37.9% |
| French Connection | Amazon | $1,136 | 2,851 | 0.30% | 33 | 1.16% | $1,098 | 0.97 | 103.4% |
| French Connection | Namshi | $12,102 | 69,510 | 1.52% | 792 | 1.14% | $34,236 | 2.83 | 35.3% |
| Penti | All | $9,607 | 47,587 | 1.57% | 1,231 | 2.59% | $21,007 | 2.19 | 45.7% |
| Penti | Amazon | $822 | 1,471 | 0.40% | 27 | 1.84% | $431 | 0.52 | 190.9% |
| Penti | Namshi | $6,301 | 30,750 | 1.71% | 910 | 2.96% | $15,357 | 2.44 | 41.0% |
| Penti | Noon | $2,483 | 15,366 | 1.78% | 294 | 1.91% | $5,219 | 2.10 | 47.6% |
| CARDIO BUNNY | All | $6,092 | 30,191 | 1.60% | 776 | 2.57% | $13,695 | 2.25 | 44.5% |
| CARDIO BUNNY | Namshi | $5,950 | 28,928 | 1.63% | 741 | 2.56% | $13,167 | 2.21 | 45.2% |
| Keds | All | $5,300 | 32,747 | 1.15% | 254 | 0.78% | $8,913 | 1.68 | 59.5% |
| Keds | Namshi | $4,487 | 27,901 | 1.30% | 228 | 0.82% | $7,995 | 1.78 | 56.1% |
| Vero Moda | All | $4,950 | 30,277 | 1.74% | 438 | 1.45% | $13,377 | 2.70 | 37.0% |
| Vero Moda | Namshi | $4,512 | 26,211 | 1.86% | 367 | 1.40% | $11,816 | 2.62 | 38.2% |
| Nutricook (hardline) | All | $44,066 | 154,531 | 1.20% | 8,389 | 5.43% | $356,859 | 8.10 | 12.3% |
| Carote (hardline) | All | $22,112 | 82,077 | 1.67% | 1,237 | 1.51% | $117,086 | 5.30 | 18.9% |
| NutriBullet (hardline) | All | $14,647 | 50,929 | 1.18% | 1,919 | 3.77% | $112,772 | 7.70 | 13.0% |
| GTPlayer (hardline) | All | $13,647 | 26,732 | 0.99% | 874 | 3.27% | $112,328 | 8.23 | 12.1% |
| Bergner (hardline) | All | $6,982 | 25,240 | 1.15% | 525 | 2.08% | $24,271 | 3.48 | 28.8% |
| Tower (hardline) | All | $4,173 | 13,854 | 0.49% | 373 | 2.69% | $7,487 | 1.79 | 55.7% |
| Unmapped | All | $2,909 | 9,997 | 0.76% | 347 | 3.47% | $20,030 | 6.89 | 14.5% |

**Trailing 12 months (brand totals; channel splits in the run file)**

| Brand | Spend | CTR | CVR | ROAS | ACoS | Main channels (spend) |
|---|---|---|---|---|---|---|
| USPA | $195,439 | 1.32% | 1.92% | 4.94 | 20.2% | Namshi $97,911, Noon $88,802, Amazon $8,726 |
| CAMPUS | $53,297 | 1.28% | 1.07% | 1.63 | 61.5% | Namshi $27,687, Noon $21,300, Amazon $4,309 |
| Penti | $29,267 | 1.41% | 2.49% | 2.41 | 41.5% | Namshi $19,350, Noon $8,392 |
| French Connection | $20,307 | 1.23% | 1.05% | 2.36 | 42.4% | Namshi $17,746 |
| Keds | $15,937 | 0.64% | 0.55% | 1.53 | 65.5% | Namshi $12,113, Noon $3,290 |
| Vero Moda | $13,894 | 1.80% | 0.87% | 1.96 | 51.0% | Namshi $13,165 |
| CARDIO BUNNY | $8,636 | 1.47% | 2.23% | 2.12 | 47.1% | Namshi $8,149 |
| Nutricook (hardline) | $113,529 | 1.08% | 5.16% | 7.96 | 12.6% | Amazon $80,288 |
| GTPlayer (hardline) | $107,579 | 0.51% | 3.67% | 6.17 | 16.2% | Amazon $69,861 |
| Carote (hardline) | $49,429 | 1.34% | 1.89% | 5.21 | 19.2% | Amazon $28,690 |

Brands in the brief with no ad spend in the file: **Nautica** (12,140 rows from 2026-10-04, $0.00 spend) and **Puma** (no rows) (exact).

### 2.5 Top 50 products by spend, last 90 days (exact)

Query: common shape, group by product key, `ORDER BY spend DESC LIMIT 50`, plus cumulative share of all 90-day spend. The top 50 hold 37.0% of spend. 37 of the 50 are hardline; the 13 softline ones are all USPA. Category comes from `master_sl.category_name` (hardline SKUs are not in `master_sl`, so category is blank). `master_sl.mrp` is blank for these rows, so price comes from Trendyol (section 2.6).

| # | Brand | Product | Channels | Spend | Clicks | CTR | Units | CVR | ROAS |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Nutricook | NC-AFE150 | Amazon, Noon | $3,882 | 9,246 | 1.07% | 432 | 4.67% | 4.73 |
| 2 | Nutricook | NC-SP204K | Amazon, Noon | $3,644 | 12,131 | 1.08% | 504 | 4.15% | 11.79 |
| 3 | Nutricook | NC-SPEK6 | Amazon, Noon | $3,402 | 13,196 | 1.62% | 558 | 4.23% | 11.12 |
| 4 | Nutricook | NC-EC360 | Amazon, Noon | $3,221 | 17,214 | 1.24% | 1,513 | 8.79% | 7.55 |
| 5 | Nutricook | NC-AFM033K | Amazon, Noon | $3,132 | 6,447 | 1.54% | 169 | 2.62% | 2.03 |
| 6 | Unmapped | (no SKU, Amazon Sponsored Brands) | Amazon | $2,835 | 9,532 | 0.74% | 339 | 3.56% | 6.98 |
| 7 | GTPlayer | GT800A-BLACK | Amazon, Noon | $2,642 | 4,676 | 1.04% | 235 | 5.03% | 9.89 |
| 8 | NutriBullet | NBR-1212M | Amazon, Noon | $2,554 | 7,226 | 1.15% | 339 | 4.69% | 8.84 |
| 9 | NutriBullet | MB4-0612M | Amazon, Noon | $2,503 | 10,842 | 1.63% | 457 | 4.22% | 5.40 |
| 10 | Nutricook | NC-AFS200 | Amazon, Noon | $2,363 | 6,693 | 0.95% | 226 | 3.38% | 6.50 |
| 11 | Nutricook | NC-SP320-ON | Amazon, Noon | $2,271 | 5,151 | 1.35% | 126 | 2.45% | 4.79 |
| 12 | USPA | LEAN GLB 6FX MEN OD WHITE | Amazon, Namshi, Noon | $2,232 | 11,219 | 2.19% | 99 | 0.88% | 2.18 |
| 13 | Carote | A10205-6 | Amazon, Noon | $2,119 | 6,218 | 1.66% | 155 | 2.49% | 7.55 |
| 14 | GTPlayer | GT205-BLACK | Amazon, Noon | $1,804 | 3,586 | 1.91% | 127 | 3.54% | 11.93 |
| 15 | Carote | A10204-4 | Amazon, Noon | $1,775 | 6,025 | 1.73% | 131 | 2.17% | 7.19 |
| 16 | Nutricook | NC-SP150 | Amazon, Noon | $1,775 | 8,765 | 1.29% | 436 | 4.97% | 11.91 |
| 17 | NutriBullet | NBR-0612 | Amazon, Noon | $1,766 | 5,263 | 1.37% | 210 | 3.99% | 7.66 |
| 18 | USPA | 5M OLIGAR GLB 5FX OD NAVY | Namshi, Noon | $1,746 | 8,432 | 2.17% | 152 | 1.80% | 2.80 |
| 19 | Nutricook | NC-HB150BG | Amazon, Noon | $1,714 | 2,900 | 1.16% | 166 | 5.72% | 3.44 |
| 20 | Nutricook | NC-HB100 | Amazon, Noon | $1,657 | 5,984 | 1.30% | 252 | 4.21% | 7.34 |
| 21 | Carote | A09035 | Amazon, Noon | $1,656 | 4,503 | 1.59% | 101 | 2.24% | 7.13 |
| 22 | Carote | A10486-1 | Amazon, Noon | $1,540 | 6,642 | 1.76% | 56 | 0.84% | 5.00 |
| 23 | Nutricook | NC-IFC150ME | Amazon, Noon | $1,422 | 3,304 | 1.53% | 146 | 4.42% | 3.87 |
| 24 | Carote | A06790 | Amazon, Noon | $1,387 | 5,392 | 1.89% | 50 | 0.93% | 5.90 |
| 25 | Carote | A14321 | Amazon, Noon | $1,310 | 6,064 | 2.09% | 71 | 1.17% | 6.38 |
| 26 | Nutricook | NC-FRS330K | Amazon, Noon | $1,284 | 4,467 | 1.02% | 46 | 1.03% | 9.34 |
| 27 | USPA | 5M HARISON GLB 5FX OD WHITE | Amazon, Namshi, Noon | $1,273 | 7,840 | 2.08% | 162 | 2.07% | 4.30 |
| 28 | USPA | NASTA GLB 6FX MEN OD WHITE | Amazon, Namshi, Noon | $1,234 | 7,276 | 2.17% | 193 | 2.65% | 5.91 |
| 29 | USPA | EMORA GLB 5FX OD WHITE | Amazon, Namshi, Noon | $1,219 | 7,460 | 1.65% | 134 | 1.80% | 4.07 |
| 30 | NutriBullet | NBC-0910B | Amazon, Noon | $1,217 | 4,040 | 0.79% | 83 | 2.05% | 6.11 |
| 31 | USPA | 6M FRANCO WMN LT GLB 6FX WOMEN OD WHITE | Namshi, Noon | $1,200 | 7,370 | 1.83% | 105 | 1.42% | 4.03 |
| 32 | Nutricook | EC207ME-K | Amazon, Noon | $1,166 | 5,713 | 1.21% | 673 | 11.78% | 10.01 |
| 33 | USPA | SORLEY GLB 6FX WOMEN OD WHITE | Amazon, Namshi, Noon | $1,088 | 6,144 | 4.03% | 149 | 2.43% | 6.59 |
| 34 | USPA | 5F PUKE JR GLB 5PR WHITE OD | Amazon, Namshi, Noon | $1,077 | 6,583 | 1.73% | 108 | 1.64% | 3.09 |
| 35 | GTPlayer | LUFT310-2024 | Amazon, Noon | $1,074 | 2,247 | 0.76% | 37 | 1.65% | 4.92 |
| 36 | GTPlayer | GT890MF | Amazon, Noon | $1,048 | 2,012 | 1.21% | 40 | 1.99% | 5.56 |
| 37 | Nutricook | NC-SP208K | Amazon, Noon | $1,011 | 3,436 | 0.77% | 195 | 5.68% | 18.11 |
| 38 | Carote | A08623 | Amazon | $998 | 2,307 | 1.11% | 36 | 1.56% | 5.50 |
| 39 | Nutricook | NC-SP210L | Amazon, Noon | $964 | 3,471 | 0.99% | 128 | 3.69% | 13.96 |
| 40 | NutriBullet | MB4-1012M | Amazon, Noon | $960 | 4,385 | 1.83% | 137 | 3.12% | 5.13 |
| 41 | USPA | TARLI GLB 6FX MEN OD GREY | Amazon, Namshi, Noon | $934 | 5,405 | 1.91% | 113 | 2.09% | 4.41 |
| 42 | Nutricook | NC-CH1200 | Amazon, Noon | $920 | 3,073 | 2.28% | 155 | 5.04% | 4.53 |
| 43 | GTPlayer | GT205-BEIGE | Amazon, Noon | $903 | 1,700 | 1.62% | 37 | 2.18% | 6.57 |
| 44 | GTPlayer | GT800A-WHITE | Amazon, Noon | $866 | 2,077 | 2.26% | 63 | 3.03% | 8.61 |
| 45 | GTPlayer | GT800A-WT-WOD-NMF | Amazon, Noon | $864 | 1,810 | 1.45% | 41 | 2.27% | 5.26 |
| 46 | Carote | A08285 | Amazon, Noon | $846 | 2,802 | 1.14% | 49 | 1.75% | 6.37 |
| 47 | Bergner | BGIN-6830 | Amazon, Noon | $829 | 2,343 | 1.82% | 28 | 1.20% | 3.80 |
| 48 | Nutricook | NC-CH2000 | Amazon, Noon | $808 | 3,770 | 0.94% | 179 | 4.75% | 7.68 |
| 49 | GTPlayer | LR002-GREEN | Amazon, Noon | $793 | 1,490 | 0.87% | 56 | 3.76% | 8.61 |
| 50 | USPA | EMORA GLB 5FX OD BEIGE | Amazon, Namshi, Noon | $785 | 4,572 | 1.51% | 102 | 2.23% | 4.70 |

**Top 20 softline options by spend, last 90 days (exact)**, with Trendyol image count and Trendyol UAE list price (AED). These 20 hold 17.4% of softline spend.

| Brand | Option | Category | Images | Price AED | Spend | Clicks | CTR | CVR | ROAS |
|---|---|---|---|---|---|---|---|---|---|
| USPA | LEAN GLB 6FX MEN OD WHITE | Default | 7 | 469 | $2,232 | 11,219 | 2.19% | 0.88% | 2.18 |
| USPA | 5M OLIGAR GLB 5FX OD NAVY | Shoes | 7 | 329 | $1,746 | 8,432 | 2.17% | 1.80% | 2.80 |
| USPA | 5M HARISON GLB 5FX OD WHITE | Shoes | 7 | 299 | $1,273 | 7,840 | 2.08% | 2.07% | 4.30 |
| USPA | NASTA GLB 6FX MEN OD WHITE | Default | 7 | 349 | $1,234 | 7,276 | 2.17% | 2.65% | 5.91 |
| USPA | EMORA GLB 5FX OD WHITE | Default | 6 | 379 | $1,219 | 7,460 | 1.65% | 1.80% | 4.07 |
| USPA | 6M FRANCO WMN LT GLB 6FX WOMEN OD WHITE | Shoes | 7 | 329 | $1,200 | 7,370 | 1.83% | 1.42% | 4.03 |
| USPA | SORLEY GLB 6FX WOMEN OD WHITE | Default | 6 | 449 | $1,088 | 6,144 | 4.03% | 2.43% | 6.59 |
| USPA | 5F PUKE JR GLB 5PR WHITE OD | Kids Shoes | 5 | 269 | $1,077 | 6,583 | 1.73% | 1.64% | 3.09 |
| USPA | TARLI GLB 6FX MEN OD GREY | Default | 5 | 499 | $934 | 5,405 | 1.91% | 2.09% | 4.41 |
| USPA | EMORA GLB 5FX OD BEIGE | Default | 6 | 379 | $785 | 4,572 | 1.51% | 2.23% | 4.70 |
| USPA | 5M JOHNNY GLB 5FX OD WHITE | Shoes | 6 | 379 | $781 | 4,246 | 2.00% | 1.04% | 2.48 |
| USPA | 6M ZELDA GLB 6FX WOMEN OD WHITE | Shoes | 7 | 399 | $766 | 5,216 | 1.57% | 2.66% | 9.18 |
| USPA | 5F DOLLY GLB 5PR BEIGE OD | Women's Sneaker | 5 | 329 | $722 | 3,938 | 1.46% | 2.08% | 3.36 |
| USPA | LEE GLB 6FX MEN OD WHITE | Default | 4 | 349 | $696 | 3,933 | 1.81% | 1.55% | 3.95 |
| USPA | SONTE GLB 6FX MEN OD WHITE | Default | 7 | 349 | $674 | 4,557 | 1.55% | 2.26% | 5.51 |
| CAMPUS | 22G-677 NORTH_NAVY-WHT | Footwear | 5 | 199 | $660 | 3,721 | 2.62% | 0.73% | 0.99 |
| USPA | TERRA GLB 5PR WOMEN OD WHITE | Default | 5 | 329 | $610 | 4,219 | 1.49% | 2.73% | 6.76 |
| USPA | FRANCO GLB 6FX MEN OD WHITE | Default | 7 | 349 | $600 | 3,516 | 1.57% | 2.16% | 4.88 |
| CARDIO BUNNY | HCB-226-007-0 OFF White OD | T-shirt | 4 | 129 | $598 | 3,261 | 2.62% | 1.38% | 1.19 |
| French Connection | FC225B21 Blue OD | Handbag | 8 | 350 | $569 | 3,646 | 2.79% | 0.33% | 1.15 |

Note: many USPA options carry category "Default" in `master_sl`, so category is not reliable for USPA.

### 2.6 Best and worst converters (exact)

Query: product key level, last 90 days, `WHERE clicks >= 200`, ranked by CVR. 877 products qualify (all families).

- **Best 15**: 11 are Nutricook appliances (CVR 7.7% to 20.5%, for example NC-AFL100 20.50%, EC207ME-S 19.65%, NC-EC360 8.79% on 17,214 clicks) and 4 are Penti multipacks priced 79-99 AED (PLI14NVC26IY MIX OD 11.37%, PLWJ4DGY26IY 8.46%, PL4LI4ED25SK 8.15%, PLPEP1YY26IY 7.73%; 5-8 Trendyol images).
- **Worst 15**: all have 0 ad units on 270-595 clicks. Softline: French Connection 719G0 BERRY RED (559 clicks, 8 images, 490 AED), FC225B01 Beige handbag (595 clicks, 8 images), 779A2 NAVY (408, 8 images), 77DZ7 (270, 3 images), 75DZR (388, 4 images); CAMPUS S1644-02 (271, 7 images); Penti PNMXTR3F26IY (345, 5 images), PHH1G0X225IY (495, 5 images); USPA MEDI GLB KHAKI (379, 5 images). Hardline: Carote Noon-only Z-codes (high CTR 3.1-4.1%, 0 units), Carote A13624, Bergner BGIN-1313.

**Weak-converter pool, softline, last 90 days (exact).** Query: option level, brand CVR = brand units / brand clicks; "weak" = at least 200 clicks and CVR < 0.70 x brand CVR (the dashboard's own weak rule, with a higher click floor).

| Brand | Softline spend | Options with 200+ clicks | Weak options | Spend on weak | Weak share of spend | ROAS weak | ROAS other 200+ click options | Options with 0 units (200+ clicks) |
|---|---|---|---|---|---|---|---|---|
| All softline | $111,752 | 703 | 236 | $30,513 | 27.3% | 1.75 | 4.25 | 16 ($801) |
| USPA | $55,280 | 289 | 80 | $11,521 | 20.8% | 2.56 | 5.28 | 1 |
| CAMPUS | $16,866 | 130 | 38 | $4,290 | 25.4% | 0.87 | 1.99 | 3 |
| French Connection | $13,657 | 85 | 40 | $5,486 | 40.2% | 1.36 | 3.83 | 7 |
| Penti | $9,607 | 71 | 30 | $3,238 | 33.7% | 1.31 | 2.69 | 3 |
| CARDIO BUNNY | $6,092 | 40 | 16 | $2,634 | 43.2% | 1.48 | 2.70 | 0 |
| Keds | $5,300 | 44 | 16 | $1,825 | 34.4% | 0.98 | 2.15 | 2 |
| Vero Moda | $4,950 | 44 | 16 | $1,518 | 30.7% | 1.72 | 2.96 | 0 |

### 2.7 Join coverage (exact)

| Join | Result (last 90 days) |
|---|---|
| Ad rows to `master_sl` (on `internal_sku_code` = `product_code`) | Softline: $111,617 of $111,752 spend (99.9%), 6,922 SKUs. Hardline: 0 (hardline is not in `master_sl`, by design) |
| Ad rows to `sku_option` (style-colour option) | Softline: $109,184 of $111,752 (97.7%), 2,042 options |
| Advertised softline options to Trendyol image counts (`master_sl.ean` = Trendyol `barcode`, latest UAE file 2026-10-22 and latest KSA file, max of `image_1..image_8` non-blank) | 2,032 of 2,257 options (90.0%), $110,644 of $111,752 spend (99.0%); 693 of 703 options with 200+ clicks |
| Image count spread (joined options) | Mean 5.91 images; range 1-8 (Trendyol has 8 slots). By brand: Keds 7.72 (min 6), CAMPUS 7.08 (min 4), USPA 5.96, Penti 5.61, Cardio Bunny 5.40, Vero Moda 5.08, French Connection 5.05 |
| Price | `master_sl.mrp` is blank on the sampled rows; Trendyol UAE `original_list_price` (AED) used as the price band source |

## 3. Signal analysis

**Question.** Within the same brand and price band, do options with more images have higher CTR or CVR? Are on-model images better than packshots?

**Method (query shape).** Option level, softline, last 90 days. Join image count from Trendyol (section 2.7). Price band = tercile of Trendyol UAE list price within each brand (`NTILE(3) OVER (PARTITION BY brand ORDER BY price)`). Keep options with at least 200 clicks. Two cuts:

1. Brand x price band x image bucket (1-4, 5-6, 7-8), pooled CTR and CVR (sum then divide), all channels together.
2. Stratified: brand x channel x price band cells, "high" = 7-8 images vs "low" = 1-6 images, only cells with at least 3 options on each side. Compare CVR and CTR inside each cell, then a click-weighted geometric mean of the high / low ratio across cells.

**Result (exact).**

| Measure | Value |
|---|---|
| Cells compared (brand x channel x band) | 18 |
| Options (high / low) | 300 / 301 |
| Cells where high-image options have better CVR | 9 of 18 |
| Cells where high-image options have better CTR | 8 of 18 |
| Click-weighted CVR ratio, high vs low | 0.954 |
| Click-weighted CTR ratio, high vs low | 1.047 |

Selected cells (CVR high / low): USPA Namshi band 2: 2.42% / 2.08% (26 vs 24 options); USPA Noon band 3: 1.24% / 1.53% (23 vs 19); French Connection Namshi band 3: 0.65% / 0.94% (26 vs 20); CAMPUS Namshi band 2: 0.98% / 0.87% (27 vs 5); Penti Namshi band 1: 6.67% / 3.10% (5 vs 13). The cut-1 table (brand x band x bucket) shows the same mixed picture: no brand has a consistent rise in CVR from 1-4 to 7-8 images.

**What the data supports.** No measurable link between image count and CTR or CVR in this data. Half the cells go each way and the pooled ratios are close to 1. This is a null result, not proof of no effect.

**Why the test is weak (confounders and limits).**

- **Wrong channel for the image count.** The count is from Trendyol listings; the ads run on Namshi, Noon and Amazon, where the gallery can differ. This is the main reason the result says little.
- **Little variance.** Most options have 5-8 images; Keds and CAMPUS almost all have 7-8. Few options are truly image-poor.
- **CTR is driven by the main image, not the count.** Sponsored-listing CTR depends on the first image, price, badge and placement, which this data does not hold.
- **CVR has other strong drivers:** size availability (broken size runs), stock, price and discount depth, ratings, delivery promise, and ad targeting (keyword vs auto). None are controlled here, though the dashboard already has cut-size and stock data that could be added.
- **Selection:** agencies push budget toward options that already sell, so heavily advertised options are not a random sample.
- **On-model vs packshot:** no table classifies images by type. Not testable today without labelling images (for example from the catalog module's own output or a vision pass on Trendyol image URLs).

**Better test designs** (for the roadmap, not done here): (a) before / after on options whose images the catalog module replaces, compared with matched untouched options of the same brand, channel and price band (difference in differences on CTR and CVR per week); (b) get the image count and type per channel listing (Namshi / Noon / Amazon content exports) instead of the Trendyol proxy; (c) use organic page CVR where it exists (Amazon unit session percentage, Noon visitor conversion) so ad targeting is not mixed in.

## 4. Metrics a catalog initiative can move, with baselines

How the levers connect: ACoS = CPC / (CVR x Ad ASP). At a constant CPC and price, a relative CVR gain of x% lowers ACoS by x / (1 + x) (for example +10% CVR gives about -9% ACoS) and raises ROAS by x%. A higher CTR at the same bid usually lowers CPC on auction platforms and adds clicks for the same impressions.

| Metric | Catalog lever | Plausibility | Notes |
|---|---|---|---|
| CTR on Sponsored Products | Main image (clean, on-brand, correct crop), title | Plausible | 96% of spend is Sponsored Products, whose creative is the main image and title |
| CVR (ad units / clicks) | Gallery depth and quality, on-model views, size and fit info, attributes | Plausible | Also driven by size runs, stock and price; measure with controls |
| ROAS, ACoS | Follows from CTR (via CPC) and CVR | Plausible as an outcome | Report together with CVR so a budget change is not taken for a catalog effect |
| CPC | Indirect, through a higher CTR | Weaker | Bids and competition dominate |
| TACoS, Ad Sale % | Indirect | Weak | Mixes organic sales; better as a business-level outcome |

**Baselines, softline, last 90 days (exact, from 2.2 and 2.4)**

| Scope | CTR | CVR | ROAS | ACoS | CPC | Spend |
|---|---|---|---|---|---|---|
| All softline | 1.34% | 1.64% | 3.39 | 29.5% | $0.167 | $111,752 |
| Namshi KSA | 1.71% | 1.50% | 3.65 | 27.4% | $0.156 | $42,995 |
| Namshi UAE | 1.44% | 2.15% | 2.89 | 34.6% | $0.221 | $33,276 |
| Noon KSA | 1.54% | 1.30% | 3.43 | 29.1% | $0.142 | $15,204 |
| Noon UAE | 1.59% | 1.98% | 4.24 | 23.6% | $0.150 | $10,444 |
| Amazon KSA | 0.57% | 1.06% | 3.23 | 30.9% | $0.118 | $4,808 |
| Amazon UAE | 0.50% | 1.75% | 2.76 | 36.2% | $0.217 | $5,025 |
| USPA | 1.35% | 1.80% | 4.67 | 21.4% | $0.156 (approx) | $55,280 |
| CAMPUS | 1.17% | 1.09% | 1.65 | 60.7% | $0.175 (approx) | $16,866 |
| French Connection | 1.31% | 1.10% | 2.64 | 37.9% | $0.179 (approx) | $13,657 |
| Penti | 1.57% | 2.59% | 2.19 | 45.7% | $0.202 (approx) | $9,607 |
| CARDIO BUNNY | 1.60% | 2.57% | 2.25 | 44.5% | $0.202 (approx) | $6,092 |
| Keds | 1.15% | 0.78% | 1.68 | 59.5% | $0.162 (approx) | $5,300 |
| Vero Moda | 1.74% | 1.45% | 2.70 | 37.0% | $0.163 (approx) | $4,950 |

(Brand CPC = spend / clicks from 2.4, computed by hand, so approx.)

**Organic baseline where available (exact sums, approx join).** Amazon 3P Business Report (`raw_gcc_table_cleaned.traffic_sales_amazon_3p_ksa/uae`), 2026-07-26 to 2026-10-23. Corrected in review (2026-10-26): the first version joined `child_asin` to `master_sl` and reported "only CAMPUS appears" with CAMPUS KSA 243,007 and UAE 130,788 sessions; that join did not reproduce. Joined on the listing ASIN key instead (`child_asin` = `fact_gcc.channel_listing_status_daily.portal_keys.asin`, snapshot 2026-10-24, as in 02 and 06 Q1), every sampled softline brand appears: USPA KSA 53,851 sessions, 438 units (0.81%), UAE 56,151, 652 (1.16%); CAMPUS KSA 22,621, 216 (0.95%), UAE 7,249, 80 (1.10%); French Connection, Keds, Penti, Nautica, Vero Moda and Cardio Bunny small (under 3,000 sessions each per country). CAMPUS Amazon ad clicks in the same window were 13,684 against about 29,900 sessions, so roughly half of CAMPUS Amazon traffic is organic, and page CVR is a cleaner catalog metric there than ad CVR (approx).

**Best first targets (from the data, approx):** the weak-converter pool (236 options, $30,513 of 90-day spend, ROAS 1.75) and the high-spend USPA options with below-brand CVR (for example LEAN GLB WHITE: $2,232 spend, CVR 0.88% vs USPA 1.80%). French Connection, Cardio Bunny and Keds have the largest weak shares (34-43% of their spend).

## 5. Gaps

1. **Channels without ads data in the report:** Trendyol, Styli, Centrepoint, 6thStreet, VogaCloset, Shein. Trendyol campaign data exists separately in `raw_gcc_table_cleaned.campaign_trendyol_3p_ksa/uae` (547 and 631 rows, model-code level, dates 2025-05-15 to 2026-06-05, nothing after June 2026) and is not in `ads_daily`.
2. **No image attributes anywhere:** no image count per channel listing for Namshi / Noon / Amazon, and no on-model vs packshot label. The only image counts are Trendyol's 8 slots.
3. **Organic traffic is thin:** only the Amazon 3P Business Report is current (UAE from 2026-01, KSA from 2026-02, to 2026-10-23); joined on the listing ASIN key it covers USPA, Campus and the smaller softline brands (02 "Traffic and conversion"). The first version of this file said "only CAMPUS" from a `master_sl` join; that was wrong and is corrected above. Noon traffic tables (`traffic_sales_noon_3p_ksa/uae`) stop in Jan-Feb 2026. Namshi has none.
4. **Price:** `master_sl.mrp` is blank on the rows checked; Trendyol list price was used as a proxy.
5. **Category:** many USPA options have category "Default" in `master_sl`.
6. **Window:** Noon and Namshi ads data start 2026-01-01, so "12 months" is about 10 months for them.
7. **Attribution and VAT:** ad sales are portal-attributed (window and rules differ by portal) and probably include VAT, so ROAS / ACoS are not fully comparable across channels.
8. **Brand cleaning simplified:** the queries use the dashboard's brand order (hardline master, `master_sl`, file brand, then `alias_gcc_brand`) but skip the Nutri split and GTPlayer rename, so hardline brand rows can differ slightly from the live dashboard. Softline brands are unaffected.
9. **Nautica and Puma** have no ad spend in the file.
10. **No numbers were matched against the live dashboard** in a browser; parity rests on using the same table and formulas.

Status: done
