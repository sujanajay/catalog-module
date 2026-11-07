# 02 - Catalog liveness data map and live catalog performance

Agent B of the GCC catalog roadmap proposal. Documents only; nothing was built or changed. Every query was a
read-only SELECT on BigQuery `opptra-datawarehouse` (run 26 Oct 2026). Each number is marked **(exact)** when it is
a direct count or sum from the source, and **(approx)** when it depends on a join, a window choice or a proxy.

## Summary

1. The liveness report is a daily BigQuery table, `fact_gcc.catalog_liveness_daily`, built by the Cloud Run job `catalog-liveness-job` at 13:15 and 14:30 IST. It covers only 4 channels x 2 countries: Noon, Namshi, Trendyol and Amazon, in UAE and KSA. Styli, Centrepoint, 6thStreet, VogaCloset and Shein are not covered.
2. History is short: good runs exist only from 17 Oct to 25 Oct 2026, 9 days (exact).
3. Live rate on 24 Oct, the last day all 8 channel-countries were connected: 92.7% of stocked in-scope pairs (46,249 of 49,888) (exact). It was 95.5% on 17 Oct (exact). Most of the drop is in KSA and Amazon UAE, and the report gives no reason for it (see 3).
4. 62% of not-live pairs (2,243 of 3,639) have the reason "Reasons not connected yet" (exact). The reason reports for Noon (C-02, stale since 21 Aug), Namshi (C-04b) and Amazon (C-08) are not connected yet.
5. Image or content rejections: **zero in the live report today** (exact). The Content bucket is empty because those reason feeds are missing, not because the problem is gone. The last Noon not-live file (21 Aug) showed 264 UAE and 215 KSA SKUs with "Content Issues" (exact).
6. 71.4% of live, stocked softline options (style-colour x channel-country) sold zero units in 90 days (exact count, approx window). The top 10% of options bring in 86.2% of trailing 12-month revenue (approx).
7. Traffic and conversion data exist only for Amazon (daily, to 23 Oct). Noon traffic stopped on 4 Feb 2026, and Namshi and Trendyol have no traffic table. Namshi carries the most softline revenue.
8. Content-fix targets: 187 live Amazon softline ASINs (exact under the stated rule) get high traffic but convert at less than half the channel rate, almost all USPA. On Noon and Namshi, the only available proxy is 1,237 options with zero sales and 20 or more units held (exact under the stated rule).
9. Trendyol listings with 3 or fewer images sold about one third as many units per listing as listings with 4 or more images (approx; the brand mix differs between the groups).

## Source map

All paths are in `C:\Users\Sujan Ajay\Desktop\gcc-dashboard` unless the path says otherwise.

### Code and docs

| What | Path |
|---|---|
| Page, end-to-end flow, runbook | `docs/catalog/LIVENESS_README.md` |
| Rules (universe, live, 8 reason buckets) | `docs/catalog/liveness/03_catalog_liveness_SPEC.md` sections 4.1 to 4.7; `06_channel_reports_ingestion_SPEC.md` |
| Columns read and written | `docs/catalog/READ_CONTRACT.md` section 5 |
| Job (step 0 loader, step 1 canonical build, step 2 liveness table) | `pipeline/catalog_liveness/` (`main.py`, `feeds_loader.py`, `canonical.py`, `liveness.py`, `reasons.py`, `stock.py`, `scope.py`, `metrics.py`, `config.py`) |
| Reason map, as data | `pipeline/catalog_liveness/reasons.py`; API copy `backend/queries/catalog_liveness_reasons.py` |
| API (read only, cached per run) | `backend/api/routers/catalog_liveness.py`, `backend/api/services/catalog_liveness_service.py`, `backend/queries/catalog_liveness_queries.py`, `backend/api/schemas/catalog_liveness.py`, xlsx export `backend/api/services/catalog_liveness_xlsx.py` |
| Scope (brand x channel-country In/Out) | Cloud SQL `gcc_catalog.catalog_liveness_scope`, `backend/api/services/catalog_settings.py`, `catalog_store.py` |
| Separate Catalog page: items missing a Noon Child Zsku (not liveness) | `backend/api/routers/catalog.py`, `backend/api/services/catalog_service.py`, `backend/api/schemas/catalog.py` (master_sl vs the GCC Softline sheet, column P) |
| Sales logic the dashboard uses | `backend/queries/tertiary_queries.py` (net = not cancelled and not returned; GMV = `revenue_local_excl_vat / fx_usd`) |

### Tables and files that feed the liveness report

| Layer | Source | Notes |
|---|---|---|
| Portal reports | Noon Live `raw_gcc_tables.catalog_live_noon_3p_*` (C-01); Noon Not Live `catalog_non_live_noon_3p_*` (C-02, **stale since 21 Aug 2026**) | Noon live = in the latest Live export |
| | Namshi `raw_gcc_table_cleaned.catalog_live_namshi_3p_*` / `catalog_non_live_namshi_3p_*` (C-03/C-04, latest day only, copied daily into `gcc_channel_reports`); Namshi Catalog Live Status C-04b (GCS landing file, **not loaded yet**, no table) | Namshi live = `live_status = 'LIVE'`; reasons come only from C-04b |
| | Trendyol `raw_gcc_table_cleaned.product_list_trendyol_3p_*` (C-05, copied daily into `gcc_channel_reports.product_list_trendyol_3p_*`) | Trendyol live = `Status` blank. Also has `image_1` to `image_8`, `status_description` |
| | Amazon Active Listings `raw_gcc_tables.active_listings_amazon_3p_*` (C-06, since 14 Oct 2026); All Listings C-08 (GCS, not validated) | Intended rule: C-08 `status = 'Active'`. **In use: the fallback "in the Active Listings report", which overstates live** |
| Canonical (step 1) | `fact_gcc.channel_listing_rows_daily`, `channel_listing_status_daily`, `channel_listing_exceptions_daily`, `channel_feed_status_daily` | One status row per EAN x channel-country per snapshot; `portal_reasons`, `portal_keys` (sku_child, zsku, partner_sku, seller_sku, asin) |
| Stock | `raw_gcc_table_cleaned.inventory_noon_3p_*` (FBN), `inventory_unicommerce_*` (own warehouses ML, Freezone), `inventory_amazon_3p_*` (FBA), `fact_gcc.unified_inventory`, `unified_channel_inventory` | "Stocked": Noon and Namshi = FBN + own warehouse of that country; Trendyol and Amazon = own warehouse only |
| Listed and brand | GCC Softline Google Sheet, tab `Naaz update` (read only); `raw_gcc_dimensions.master_sl` | Listed = a real channel code in the sheet, or live |
| Output | `fact_gcc.catalog_liveness_daily` (partition `as_of_date`, kept 400 days) and `fact_gcc.catalog_liveness_run` (one row per run, with checks) | |

### Key facts about the report

- **Grain:** one row per softline EAN (size level) x 8 channel-countries. The page counts **pairs**, meaning one EAN on one channel-country. The universe is the softline EANs in the sheet, master_sl or the stock files: 18,195 SKUs on 25 Oct (exact).
- **Headline metric:** Live % = stocked AND live / stocked AND live is known, in scope only. A channel-country whose feed is more than 2 days late is "not connected", and its `live` is NULL.
- **Refresh:** daily at 13:15 and 14:30 IST. Each run replaces that day's partition. A failed hard check (for example a stock swing above 30%) keeps the last good day.
- **Scope:** 10 softline brands are In everywhere, except Puma, which is In only on Trendyol UAE and KSA.
- **The 8 reason buckets** (only for in scope, stocked and not live): Stock not on channel, Stranded at channel, Not listed (sub-reasons: Code in sheet but not on portal, Code only in item master, No channel code), Price, Listing blocked, Content (Noon `Content issues`; Namshi `Content incomplete`, `QC failed`, `No valid image`), Data / item master, Unknown (includes "Reasons not connected yet").
- **History:** runs from 17 Oct 2026 only. The canonical status table goes back to 15 Oct for Trendyol. Older not-live history exists only in the raw Noon not-live tables (25 Feb to 21 Aug 2026, 128 UAE and 125 KSA file days (exact)).

## Liveness facts

### Latest snapshot by channel-country (in scope, stocked pairs)

24 Oct 2026 is the last day with all 8 connected. On 25 Oct, Trendyol was not connected because its last file is 22 Oct.

| Channel-country | Stocked | Live | Not live | Live % 24 Oct | Live % 25 Oct | Live % 17 Oct |
|---|---:|---:|---:|---:|---:|---:|
| Noon UAE | 8,774 | 8,600 | 174 | 98.0 | 97.5 | 97.7 |
| Noon KSA | 5,480 | 4,745 | 735 | 86.6 | 86.8 | 97.7 |
| Namshi UAE | 8,774 | 8,589 | 185 | 97.9 | 98.0 | 98.3 |
| Namshi KSA | 5,480 | 4,759 | 721 | 86.8 | 86.2 | 97.8 |
| Trendyol UAE | 6,588 | 6,387 | 201 | 96.9 | not connected | 96.8 |
| Trendyol KSA | 4,291 | 3,885 | 406 | 90.5 | not connected | 87.4 |
| Amazon UAE | 6,429 | 5,538 | 891 | 86.1 | 86.2 | 91.5 |
| Amazon KSA | 4,072 | 3,746 | 326 | 92.0 | 92.0 | 91.8 |
| **All** | **49,888** | **46,249** | **3,639** | **92.7** | 92.1 (ex Trendyol) | 95.5 |

All numbers in this table are exact.

### By brand, 24 Oct (live / stocked, exact)

| Brand | Live % | Noon UAE | Noon KSA | Namshi UAE | Namshi KSA | Trendyol UAE | Trendyol KSA | Amazon UAE | Amazon KSA |
|---|---:|---|---|---|---|---|---|---|---|
| French Connection | 94.0 | 2388/2429 | 598/620 | 2382/2429 | 598/620 | 1885/1909 | 189/200 | 1621/1909 | **36/200** |
| Penti | 95.2 | 1588/1606 | 1267/1344 | 1583/1606 | 1269/1344 | 1122/1134 | 780/845 | 944/1134 | 830/845 |
| USPA | 91.9 | 1295/1333 | 1067/1298 | 1304/1333 | 1078/1298 | 999/1039 | 933/1022 | 983/1039 | 961/1022 |
| Campus | 90.3 | 1153/1167 | 870/1130 | 1153/1167 | 871/1130 | 847/853 | 938/1086 | 778/853 | 1038/1086 |
| Vero Moda | 95.1 | 1182/1190 | 238/280 | 1175/1190 | 238/280 | 503/525 | 190/193 | 465/525 | 172/193 |
| Keds | 87.1 | 497/516 | 390/477 | 497/516 | 390/477 | 434/475 | 384/419 | **288/475** | 409/419 |
| Cardio Bunny | 96.6 | 435/444 | 307/320 | 433/444 | 307/320 | 375/421 | 299/304 | 421/421 | 300/304 |
| Puma (Trendyol only) | 87.0 | - | - | - | - | 157/159 | 172/219 | - | - |
| Nautica | 66.4 | 48/75 | 8/11 | 48/75 | 8/11 | 65/73 | 0/3 | 38/73 | 0/3 |

### Not-live reasons ranked (24 Oct, 3,639 pairs, exact)

| Bucket | Reason | Pairs | Noon | Namshi | Trendyol | Amazon |
|---|---|---:|---:|---:|---:|---:|
| Unknown | Reasons not connected yet | 2,243 | 902 | 721 | 0 | 620 |
| Not listed | Not listed | 865 | 1 | 179 | 141 | 544 |
| Stock not on channel | Stock not on portal | 234 | 0 | 0 | 234 | 0 |
| Price | Price issue / Price error | 139 | 0 | 0 | 139 | 0 |
| Data / item master | Live under twin barcode | 72 | 0 | 0 | 19 | 53 |
| Listing blocked | Locked, Duplicate listing, Brand issue, Blacklisted | 74 | 0 | 0 | 74 | 0 |
| Data / item master | Not in item master | 12 | 6 | 6 | 0 | 0 |
| Content | (any) | **0** | 0 | 0 | 0 | 0 |

Only Trendyol has real portal reasons today. Noon and Namshi not-live pairs fall into "Reasons not connected yet" when the pair is on the portal or has a sheet code.

### Image and content rejections

- **Live report:** 0 pairs in the Content bucket on every day from 17 to 25 Oct (exact). The canonical status table has no image-related portal reason since 15 Oct (exact). Its only values are Trendyol stock, lock, price, duplicate, brand and blacklist reasons, plus Namshi "No portal reason".
- **Trendyol:** no image-related status in `status_description` (15 to 22 Oct). The only text statuses are stock, price, "Multiple Product Sales" (147 row-days) and "Faulty Brand" (126 row-days) (exact).
- **Noon historical (raw `catalog_non_live_noon_3p_*`, `offer_status_reason`):** "Content Issues" alone or combined with other reasons. Noon does not split images from title, brand or category, so these are content and possibly image problems:

| Noon file, 21 Aug 2026 (last file) | UAE content-issue SKUs | KSA content-issue SKUs |
|---|---:|---:|
| French Connection | 207 | 158 |
| Campus | 22 | 22 |
| Penti | 13 | 13 |
| Nautica | 11 | 11 |
| USPA | 5 | 5 |
| French Connection UK, GTPlayer, Bergner | 6 | 6 |
| **Total** | **264** | **215** |

All exact, counted as distinct `partner_sku` among not-live rows, whether stocked or not.

- **Noon monthly average of content-issue SKUs per file (exact averages):** 0 in Feb and Mar, about 39 in Apr, then about 290 to 380 per country from May to Aug. The reason first appears in the Noon file in April, so the earlier zero may be a report change rather than no issues.
- **Namshi:** `No valid image`, `QC failed` and `Content incomplete` exist only in C-04b, which is not loaded. **Namshi image rejections are not measurable today.**

### Trend (17 to 25 Oct)

- Overall live rate went from 95.5% to 92.7% (exact).
- Noon KSA (24 Oct) and Namshi KSA (23 Oct) each dropped about 11 points in one day. In both, "Reasons not connected yet" rose from about 135-170 to about 721-735 pairs (exact). Amazon UAE dropped 10 points on 21 Oct ("Reasons not connected yet" 137 to 750 (exact)) and partly recovered on 24 Oct.
- These look like feed or matching changes, not real delistings, but the report cannot tell the two apart without the reason feeds. This is a gap in itself.
- Trendyol was not connected on 25 Oct because its files stop at 22 Oct.

## Live listing performance

**Method:** the live set is `catalog_liveness_daily` on 24 Oct, in scope, live and stocked, joined on EAN + channel + country to `fact_gcc.unified_sales_tertiary_v2`.
- Sales filters: 3P only, the 4 liveness channels, net of cancelled and returned (the dashboard rule), GMV in USD.
- Windows: trailing 12 months is 20 Oct 2025 to 19 Oct 2026; 90 days is 22 Jul to 19 Oct 2026. 19 Oct is the common latest date across channels; Namshi data ends 19-20 Oct.
- v2 holds channel orders only. B2B and warehouse transfers sit in `raw_gcc_table_cleaned.sales_b2b_unicommerce_*` and are not in v2 (checked: no B2B or transfer channel appears in v2).
- Option = `master_sl.option_id_style_color`. EANs with no option count as their own option: 4,925 of 46,249 EAN-pairs (exact).
- **Join coverage:** 98.6 to 100% of 12-month softline revenue on these channels matches a liveness EAN (approx; USPA 100.0, French Connection 99.9, Penti 99.5, Campus 98.6, Vero Moda 78.4). The non-matching revenue on Amazon and Noon is hardline (GTPlayer, Carote, Bergner, Dowinx), which is out of scope.
- **Revenue held by today's live listings:** live stocked listings carry $2.50M of the roughly $7.0M trailing 12-month softline 3P revenue on these 4 channels (approx). The rest was sold on pairs that are not live or not stocked today.

### Zero sales in 90 days and revenue concentration (per channel-country)

| Channel-country | Live stocked EANs | EANs with 0 units in 90 days | Options | Options with 0 units in 90 days | Top 10% options' share of 12-month GMV | 12-month GMV on live options (USD) |
|---|---:|---:|---:|---:|---:|---:|
| Namshi KSA | 4,759 | 48.2% | 1,772 | 30.2% | 75.0% | 1,044,043 |
| Namshi UAE | 8,589 | 61.4% | 3,774 | 55.5% | 66.8% | 639,445 |
| Noon KSA | 4,745 | 74.5% | 1,771 | 62.1% | 83.8% | 342,267 |
| Noon UAE | 8,600 | 86.7% | 3,774 | 81.3% | 90.8% | 291,208 |
| Trendyol KSA | 3,885 | 75.0% | 1,542 | 64.1% | 79.4% | 126,951 |
| Trendyol UAE | 6,387 | 94.1% | 2,696 | 90.9% | 98.2% | 24,585 |
| Amazon UAE | 5,538 | 95.4% | 2,389 | 92.8% | 100.0% | 18,225 |
| Amazon KSA | 3,746 | 91.7% | 1,451 | 85.1% | 87.1% | 16,875 |
| **All** | **46,249** | **78.3%** | **19,169** | **71.4%** | **86.2%** (top 10% across all option-pairs) | **2,503,600** |

Counts are exact for the stated windows; shares and GMV are approx (they depend on the join and windows).

### By brand (option x channel-country, all 8 together)

| Brand | Option-pairs | 0 units in 90 days | 12-month GMV (USD) |
|---|---:|---:|---:|
| USPA | 3,710 | 57.8% | 1,716,270 |
| French Connection | 3,484 | 74.2% | 302,849 |
| Campus | 3,679 | 60.8% | 237,826 |
| Penti | 3,208 | 72.7% | 103,242 |
| Keds | 745 | 68.1% | 55,043 |
| Cardio Bunny | 775 | 69.9% | 49,165 |
| Vero Moda | 3,289 | **95.0%** | 20,323 |
| Puma | 108 | 63.9% | 16,942 |
| Nautica | 143 | 82.5% | 1,939 |

Approx (same method as above). USPA alone is 69% of the live-listing revenue.

### Stock sitting on live listings that do not sell

Live stocked options with 0 units in 90 days hold 116,909 of 238,776 pool units, 49% (approx; Noon and Namshi share one pool per country, so units are counted once per channel and overlap). Options with 0 sales and 20 or more units held: 1,492 overall. By channel-country: Noon UAE 587, Noon KSA 291, Namshi UAE 249, Namshi KSA 110, Amazon KSA 84, Trendyol KSA 70, Trendyol UAE 57, Amazon UAE 44 (exact under this rule).

### Traffic and conversion

| Channel | Table | Coverage | Join key to EAN |
|---|---|---|---|
| Amazon UAE / KSA | `raw_gcc_table_cleaned.traffic_sales_amazon_3p_*` | daily files, UAE 1 Jan to 23 Oct 2026 (296 days), KSA 7 Feb to 23 Oct 2026 (259 days) (exact) | `child_asin` only (the `sku` column is empty) -> `channel_listing_status_daily.portal_keys.asin` |
| Noon UAE / KSA | `raw_gcc_table_cleaned.traffic_sales_noon_3p_*` | **2 Jan to 4 Feb 2026 only** (30 UAE / 25 KSA days); stopped since (exact) | `sku` (Noon child zsku), `partner_sku`, brand in the row |
| Namshi | none found (the lineage map mentions a raw `traffic_sales`, but no table exists in `raw_gcc_tables` or `raw_gcc_table_cleaned`) | - | - |
| Trendyol, Styli, others | none | - | - |

**Amazon, live softline ASINs, 26 Jul to 23 Oct 2026** (unit session % = units / sessions; exact sums, approx join):

| Country | Brand | ASINs | Sessions | Units | Unit session % |
|---|---|---:|---:|---:|---:|
| UAE | USPA | 1,531 | 56,151 | 652 | 1.16 |
| UAE | Campus | 887 | 7,379 | 82 | 1.11 |
| UAE | French Connection | 448 | 2,663 | 39 | 1.46 |
| UAE | Keds | 193 | 1,388 | 13 | 0.94 |
| UAE | Penti | 222 | 1,192 | 25 | 2.10 |
| UAE | Nautica | 36 | 363 | 17 | 4.68 |
| KSA | USPA | 993 | 53,586 | 438 | 0.82 |
| KSA | Campus | 824 | 22,646 | 216 | 0.95 |
| KSA | French Connection | 19 | 856 | 4 | 0.47 |
| KSA | Keds | 106 | 840 | 3 | 0.36 |
| KSA | Penti | 90 | 426 | 6 | 1.41 |

- Vero Moda and Cardio Bunny have under 60 sessions each.
- Distribution: the median ASIN converts at 0% in every brand, because most ASINs get a handful of sessions and no order.
- Hardline ASINs, for comparison: UAE 2.17%, KSA 0.61%.

**Noon, 2 Jan to 4 Feb 2026** (stale; visitors and gross units from the Noon traffic report, exact sums):

| Country | Brand | SKUs | Visitors | Units | Conversion % | Median, SKUs with 50+ visitors |
|---|---|---:|---:|---:|---:|---:|
| UAE | USPA | 1,316 | 139,665 | 1,897 | 1.36 | 1.57 |
| UAE | Campus | 797 | 15,150 | 183 | 1.21 | 1.54 |
| UAE | Penti | 451 | 3,207 | 101 | 3.15 | 3.23 |
| KSA | USPA | 1,079 | 181,862 | 1,575 | 0.87 | 1.34 |
| KSA | Campus | 704 | 29,093 | 236 | 0.81 | 1.37 |

French Connection, Nautica and Penti KSA have under 3,500 visitors each in the window.

### Trendyol image counts vs sales

Live stocked Trendyol listings on 22 Oct, image count = non-blank `image_1` to `image_8` in the Trendyol product list, units = net 3P units in 90 days.

| Group | Listings | Avg images | 3 or fewer images | 4-5 images | 6+ images | Units per listing (3 or fewer / 4-5 / 6+) |
|---|---:|---:|---:|---:|---:|---|
| All | 10,348 | 5.74 | 744 | 3,491 | 6,111 | 0.15 / 0.43 / 0.37 |
| KSA | 3,919 | 5.81 | 213 | 1,138 | 2,568 | 0.44 / 1.19 / 0.71 |
| UAE | 6,429 | 5.71 | 531 | 2,353 | 3,543 | 0.03 / 0.07 / 0.12 |

- Counts are exact. Units per listing are approx and confounded by brand: French Connection UAE (266) and Penti UAE (145) hold most of the 3-or-fewer group and sell little on Trendyol UAE anyway.
- Brands with the most thin listings (3 or fewer images): French Connection UAE 266 and KSA 54; Penti UAE 145 and KSA 55; Vero Moda UAE 50; Cardio Bunny 41 per country; Puma KSA 33 (exact).

## Target list logic (high traffic, low conversion)

**Rule used (Amazon, the only channel with current traffic):**
1. Take live softline ASINs (live on 24 Oct in `channel_listing_status_daily`) with sessions from 26 Jul to 23 Oct 2026.
2. High traffic = sessions at or above the larger of the country's 75th percentile and 100. The 75th percentile is 17 sessions in UAE and 38 in KSA, so 100 decides.
3. Low conversion = unit session % below half of the country's softline aggregate: 1.19% in UAE and 0.85% in KSA.
4. Rank by missed units = sessions x country aggregate rate - actual units.

| Country | ASINs with sessions | High traffic | High traffic and low conversion | Their sessions | Missed units (approx) |
|---|---:|---:|---:|---:|---:|
| UAE | 3,096 | 145 | 72 | 15,805 | 162 |
| KSA | 2,040 | 212 | 115 | 23,922 | 178 |

Counts are exact under this rule.

Top examples, all USPA: UAE `TETSY GLB 6FX MEN OD NAVY` (B0GP736DYD, 481 sessions, 0 units), `MEDI GLB 6FX MEN OD KHAKI` (several size ASINs, 289 to 472 sessions, 0 or 1 unit), `ANDREI GLB 6FX MEN OD WHITE` (615 sessions, 3 units), `CHAPPY GLB 5FX OD BLACK`, `KARES GLB 5FX OD NAVY`; KSA `4W FRANCO MEN OD WHITE` (844 sessions, 3 units), `6M TOMA GLB 6FX MEN OD NAVY` (421 sessions, 0 units). The same options repeat across sizes, so the real target count at option level is lower than the ASIN count. Amazon softline revenue is small (about $35k in 12 months on live listings, approx), so the absolute gain from these fixes is small.

**Proposed rule for the roadmap (all channels):**
- **Where traffic exists** (Amazon now; Noon if its traffic feed is restored), aggregate to option x channel-country. High traffic = top quartile of sessions or visitors and at least 100. Low conversion = below half of the brand x channel-country conversion. Rank by missed units x average selling price.
- **Where traffic does not exist** (Namshi, Trendyol, Noon today), use the proxy: live, stocked, 0 units in 90 days, 20 or more units held, and the same option selling on another channel. That gives 1,492 options overall (exact before the last condition, which was not applied). A second signal is thin content: Trendyol image count of 3 or fewer (744 listings), or Noon "Content Issues".
- Add a guard: a listing is a content target only when stock and price are not the blocker (live, stocked, no Price or Stock reason).

## Metrics and baselines

| Metric | Definition | Baseline today | Source | Exact / approx |
|---|---|---|---|---|
| Liveness rate | stocked AND live / stocked AND live known, in scope | 92.7% on 24 Oct (46,249 / 49,888); 95.5% on 17 Oct | `catalog_liveness_daily` | exact |
| Liveness rate by channel-country | as above | Noon UAE 98.0, Noon KSA 86.6, Namshi UAE 97.9, Namshi KSA 86.8, Trendyol UAE 96.9, Trendyol KSA 90.5, Amazon UAE 86.1, Amazon KSA 92.0 | same | exact |
| Listed rate | stocked AND listed / stocked | for example Noon UAE 8,771 of 8,778 on 25 Oct; Amazon UAE 6,078 of 6,414 | same | exact |
| Not-live pairs by reason bucket | count per bucket | 3,639 total: Unknown 2,243, Not listed 865, Stock 234, Price 139, Listing blocked 74, Data 84, Content 0 | same | exact |
| Reason coverage | share of not-live pairs with a known reason (not Unknown) | 38% (1,396 / 3,639) | same | exact |
| Content / image rejection rate | Content-bucket pairs / stocked pairs | 0 in the report (feeds missing); Noon last known 264 UAE and 215 KSA SKUs (21 Aug) | report; raw Noon not-live | exact |
| Time to live | first portal-live date - EAN first seen (item master or stock) | **not measurable today** (9 days of history, no created date in the live feeds) | - | - |
| Zero-sales live share | live stocked options with 0 net units in 90 days | 71.4% of option-pairs (13,687 / 19,169); 78.3% of EAN-pairs | liveness + sales v2 | approx |
| Revenue concentration | 12-month GMV share of the top 10% of live option-pairs | 86.2% | same | approx |
| Stock on non-selling live listings | pool units on 0-sale live options / all | 49% (116,909 / 238,776) | same | approx |
| Sessions (Amazon softline, 90 days) | sum of `sessions_total` on live softline ASINs | UAE 69,224; KSA 78,396 | Amazon traffic | approx (join) |
| Conversion (Amazon softline, 90 days) | units / sessions | UAE 1.19%; KSA 0.85% | Amazon traffic | approx (join) |
| Conversion (Noon, Jan-Feb 2026) | units / visitors | USPA UAE 1.36%, KSA 0.87% | Noon traffic (stale) | exact sums |
| High-traffic low-conversion targets | rule above | Amazon 187 ASINs (UAE 72, KSA 115) | Amazon traffic | exact under rule |
| Image depth | average images per live Trendyol listing; share with 3 or fewer | 5.74; 7.2% (744 / 10,348) | Trendyol product list | exact |

## Gaps

1. **Reason feeds missing:** Noon Not Live (C-02, stale since 21 Aug), Namshi Catalog Live Status (C-04b, not loaded) and Amazon All Listings (C-08, not validated). Without them, 62% of not-live pairs have no reason and image rejections read as zero. This blocks any image-quality metric on Noon and Namshi.
2. **Amazon live overstates:** it uses the Active Listings fallback until C-08 is validated.
3. **Channel coverage:** liveness covers 4 channels. Styli (about $156k in 12 months), Centrepoint, 6thStreet, VogaCloset and Shein have no liveness feed. Amazon 1P is not in the liveness view (Amazon KSA 1P is about $2.3M across all brands).
4. **History is 9 days:** trends and time to live cannot be measured yet. The liveness partitions are kept 400 days, so history will build up. The raw Noon not-live tables give Feb to Aug 2026 for Noon only.
5. **Traffic:** Noon traffic stopped on 4 Feb 2026. Namshi, the largest softline revenue channel, has no traffic or conversion data at all, and neither does Trendyol. Amazon traffic has only `child_asin`, so the EAN join depends on the canonical ASIN key.
6. **Unexplained jumps:** sudden "Reasons not connected yet" jumps (Noon KSA, Namshi KSA, Amazon UAE) cannot be told apart from real delistings. The report needs a feed-health versus real-change flag before a roadmap metric relies on daily movement.
7. **Trendyol feed:** stopped after 22 Oct (not connected on 25 Oct).
8. **Option key:** 4,925 live EAN-pairs (about 11%) have no `option_id_style_color` in master_sl, which weakens option-level metrics.
9. **Untested Noon source:** the Child Zsku tracker in Cloud SQL `gcc_catalog` ("Missing since" and "Done on") could proxy time to list for Noon. It was not queried (outside BigQuery, outside this brief).
10. **Image and sales link is correlational:** brand mix is not controlled. A within-brand or before-and-after test is needed before claiming uplift.

Status: done
