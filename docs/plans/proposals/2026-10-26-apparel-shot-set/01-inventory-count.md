# 01 - Inventory count for the apparel shot set and footwear scene cases

Status: measured, read-only, 26 Oct 2026.

Read-only count, run 26 Oct 2026. Sources: BigQuery `opptra-datawarehouse` (SELECT only) and GCS listings of
`image-links-agent-assets` and `image-links-agent-public` (`catalog/` prefix). The catalog Postgres was not queried (see B).
Counts are exact for the rule stated; "option" = style-colour from `master_sl.option_id_style_color` (Campus with the size code stripped).

| Segment | A/C options in master | Images per option on Trendyol 1 / 2 / 3 / 4 / 5+ (not on Trendyol) | B cut / flat (sample only) | C kids | D live and stocked, any channel | E new options May-Oct 2026 |
|---|---:|---|---|---:|---:|---:|
| French Connection apparel | 729 | 0 / 2 / 88 / 135 / 418 (86) | head cut 4/17, product cut on main 6/141 all brands | 0 | 624 | 379 |
| Penti | 615 | 2 / 8 / 35 / 126 / 441 (3) | head cut 2/8 apparel | 12 | 521 | 324 |
| Vero Moda apparel | 107 (master undercounts; Trendyol shows 308 VM options) | 10 / 1 / 0 / 13 / 79 (4) | head cut 3/12, flat-only 3/12 | 0 | 97 | 15 |
| Cardio Bunny | 119 | 1 / 1 / 10 / 21 / 86 (0) | head cut 4/15 | 0 | 117 | 83 |
| Nautica | 159 | 0 / 0 / 3 / 28 / 110 (18) | not sampled | 0 | 45 | 40 |
| Puma apparel | 84 | 0 / 25 / 2 / 5 / 51 (1) | not sampled | 8 | 50 | 1 |
| Footwear: US Polo / Campus / Keds / Puma | 529 / 406 / 105 / 106 | 1-image 0 / 0 / 0 / 0; 5+ 452 / 364 / 97 / 102 | n/a | 49 / 6 / 0 / 33 | 458 / 381 / 105 / 31 | 182 / 177 / 20 / 7 |
| Bags: FC / Vero Moda | 63 / 13 | FC 0 / 0 / 4 / 2 / 57 (0); VM 3 / 4 / 0 / 0 / 1 (5) | n/a | 0 | 58 / 8 | 4 / 8 |
| Only, Anta | not in master_sl | Only on Trendyol: 28 options, 0 / 0 / 1 / 1 / 26 | Anta flat apparel (audit) | - | not in liveness | not measurable |
| **Totals** | apparel 1,813; footwear and bags 1,222 | apparel 1-image 13, 2-image 37 | B not measurable at scale | 108 | apparel 1,454; footwear and bags 1,041 | apparel 842; footwear and bags 398 |

Real vs kept: A, C (counts, images, kids), D and E are real counts. B (cuts, views, flat-only) and the C on-model / worn view are
not measurable from any source I could read; the sample figures from the image audit are kept.

## Data dates and shared caveats

| Source | Date of data |
|---|---|
| `raw_gcc_dimensions.master_sl` | loaded 2026-10-26 07:31 UTC (`createdDate` is the load time, the same on every row) |
| `gcc_channel_reports.product_list_trendyol_3p_uae` / `_ksa` | file_date 2026-10-26, both countries |
| `fact_gcc.catalog_liveness_daily` | as_of_date 2026-10-26, all 8 channel-countries connected |
| `raw_gcc_table_cleaned.catalog_live_noon_3p_uae` / `_ksa` | 2026-02-25 to 2026-10-25 |
| `raw_gcc_table_cleaned.inward_grn_unicommerce_*` (5 facilities) | 2026-04-06 to 2026-10-25 |
| `inventory_styli_3p_ksa` / `inventory_centrepoint_1p` | 2026-09-15 to 2026-10-22 / 2026-08-21 only |
| GCS listings | 2026-10-26 |

- Segments: FC bags = category `Handbag`, or `Default` + female + name containing BAG. FC candles, diffusers, jewellery and hair
  accessories (107 options) are excluded. Puma apparel = category `Apparel`; everything else Puma is footwear.
- `master_sl` has blank option ids on 953 SKUs: Vero Moda 528 (88 product names, all on Trendyol UAE), French Connection UK 200,
  Penti 141, French Connection 57, Campus 25, Keds 2. They are not counted as options. Vero Moda is therefore undercounted in master.
- Only and Anta are not in `master_sl` and not in the liveness scope. Only appears on Trendyol (28 options) and in GRN (60 SKUs).
  18 of the 28 Only Trendyol options have barcodes in `master_sl` under another brand (Vero Moda rows).
- Kids rule: gender Kids / BOY / GIRL, or name or option id matching `JR`, `PS`, `INF`, `INFANT`, `KID(S)`, `BOY(S)`, `GIRL(S)`, `YOUTH` as a word, or `-K-`.

## Base query (prefix to every query marked "base +")

```sql
WITH ms AS (
  SELECT ean, product_code, UPPER(TRIM(brand)) AS b, category_name, gender, name,
    option_id_style_color AS option_id, styli_ae_ksa, styli_sku, centerpoint_ae_ksa
  FROM `opptra-datawarehouse.raw_gcc_dimensions.master_sl`
  WHERE option_id_style_color IS NOT NULL AND TRIM(option_id_style_color) != ''
),
sku AS (
  SELECT *,
    CASE
      WHEN b = 'FRENCH CONNECTION' AND (category_name = 'Handbag'
        OR (category_name = 'Default' AND LOWER(gender) = 'female' AND REGEXP_CONTAINS(UPPER(name), r'\bBAG'))) THEN 'FC bags'
      WHEN b = 'FRENCH CONNECTION' AND category_name = 'Default' AND gender IN ('Unisex', 'Female', 'female') THEN 'FC home and jewellery (excluded)'
      WHEN b = 'FRENCH CONNECTION' THEN 'French Connection apparel'
      WHEN b = 'PENTI' THEN 'Penti'
      WHEN b = 'VERO MODA' AND category_name = 'Bags' THEN 'Vero Moda bags'
      WHEN b = 'VERO MODA' THEN 'Vero Moda apparel'
      WHEN b = 'CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN b = 'NAUTICA' THEN 'Nautica'
      WHEN b = 'PUMA' AND category_name = 'Apparel' THEN 'Puma apparel'
      WHEN b = 'PUMA' THEN 'Puma footwear'
      WHEN b = 'U.S. POLO ASSN.' THEN 'US Polo'
      WHEN b = 'CAMPUS' THEN 'Campus'
      WHEN b = 'KEDS' THEN 'Keds'
      ELSE b END AS seg,
    -- Campus option ids carry a size code (S1704-01-G8 BLK OD); strip it to get the style-colour
    IF(b = 'CAMPUS', REGEXP_REPLACE(option_id, r'^(\S+-\d+)-[A-Z]{1,2}\d{1,2}(\s)', r'\1\2'), option_id) AS sc,
    (LOWER(gender) IN ('kids', 'boy', 'girl')
      OR REGEXP_CONTAINS(UPPER(CONCAT(name, ' ', option_id)), r'\bJR\b|\bPS\b|\bINF\b|\bINFANT|\bKIDS?\b|\bBOYS?\b|\bGIRLS?\b|\bYOUTH\b|-K-')) AS is_kids
  FROM ms
),
opt AS (
  SELECT seg, sc, LOGICAL_OR(is_kids) AS kids,
    LOGICAL_OR(TRIM(IFNULL(styli_ae_ksa, '')) NOT IN ('', '-', 'NA', '#N/A', '0') OR TRIM(IFNULL(styli_sku, '')) NOT IN ('', '-', 'NA', '#N/A', '0')) AS has_styli,
    LOGICAL_OR(TRIM(IFNULL(centerpoint_ae_ksa, '')) NOT IN ('', '-', 'NA', '#N/A', '0')) AS has_cp
  FROM sku GROUP BY 1, 2
)
```

## A. Apparel: options, images per option, single-image options, Styli / Centrepoint absence

**A1. Options and kids (base +).** Result in the summary table. Campus gives 406 and footwear plus bags 1,222, the same as DD4.

```sql
SELECT seg, COUNT(*) AS options, COUNTIF(kids) AS kids_options,
  COUNTIF(NOT has_styli) AS no_styli_code, COUNTIF(NOT has_cp) AS no_centrepoint_code,
  COUNTIF(NOT has_styli AND NOT has_cp) AS neither
FROM opt GROUP BY seg ORDER BY seg
```

**A2. Images per option from Trendyol (base +).** Image count = non-blank `image_1..image_8` on the latest file per country; an
option takes the maximum over its SKUs and both countries. Caveat: this is what Trendyol shows (capped at 8), not what the brand
sent; options not on Trendyol have no count. 0-image options: none.

```sql
, ty AS (
  SELECT barcode, brand AS ty_brand, model_code, product_color,
    (SELECT COUNTIF(TRIM(IFNULL(x, '')) != '') FROM UNNEST([image_1, image_2, image_3, image_4, image_5, image_6, image_7, image_8]) x) AS n_img
  FROM `opptra-datawarehouse.gcc_channel_reports.product_list_trendyol_3p_uae`
  WHERE file_date = (SELECT MAX(file_date) FROM `opptra-datawarehouse.gcc_channel_reports.product_list_trendyol_3p_uae`)
  UNION ALL
  SELECT barcode, brand, model_code, product_color,
    (SELECT COUNTIF(TRIM(IFNULL(x, '')) != '') FROM UNNEST([image_1, image_2, image_3, image_4, image_5, image_6, image_7, image_8]) x)
  FROM `opptra-datawarehouse.gcc_channel_reports.product_list_trendyol_3p_ksa`
  WHERE file_date = (SELECT MAX(file_date) FROM `opptra-datawarehouse.gcc_channel_reports.product_list_trendyol_3p_ksa`)
),
opt_img AS (
  SELECT s.seg, s.sc, MAX(ty.n_img) AS n_img
  FROM sku s LEFT JOIN ty ON ty.barcode = s.ean
  GROUP BY 1, 2
)
SELECT seg, COUNT(*) AS options, COUNTIF(n_img IS NULL) AS not_on_trendyol,
  COUNTIF(n_img = 0) AS img0, COUNTIF(n_img = 1) AS img1, COUNTIF(n_img = 2) AS img2, COUNTIF(n_img = 3) AS img3,
  COUNTIF(n_img = 4) AS img4, COUNTIF(n_img >= 5) AS img5plus, ROUND(AVG(n_img), 2) AS avg_img
FROM opt_img GROUP BY seg ORDER BY seg
```

Average images per option on Trendyol: FC apparel 5.06, Penti 5.67, VM apparel 5.11, Cardio Bunny 5.41, Nautica 5.38, Puma
apparel 4.42, US Polo 5.95, Campus 7.09, Keds 7.7, Puma footwear 6.5, FC bags 7.51, VM bags 2.0.

**A3. Same count by Trendyol brand (standalone).** Option = `model_code` + `product_color`. Use this for Vero Moda and Only,
which master undercounts or lacks. It counts more Penti and FC options than master because Trendyol's model grain is finer.

```sql
WITH ty AS (
  SELECT 'UAE' AS c, file_date, barcode, brand, model_code, product_color,
    (SELECT COUNTIF(TRIM(IFNULL(x, '')) != '') FROM UNNEST([image_1, image_2, image_3, image_4, image_5, image_6, image_7, image_8]) x) AS n_img
  FROM `opptra-datawarehouse.gcc_channel_reports.product_list_trendyol_3p_uae`
  WHERE file_date = (SELECT MAX(file_date) FROM `opptra-datawarehouse.gcc_channel_reports.product_list_trendyol_3p_uae`)
  UNION ALL
  SELECT 'KSA', file_date, barcode, brand, model_code, product_color,
    (SELECT COUNTIF(TRIM(IFNULL(x, '')) != '') FROM UNNEST([image_1, image_2, image_3, image_4, image_5, image_6, image_7, image_8]) x)
  FROM `opptra-datawarehouse.gcc_channel_reports.product_list_trendyol_3p_ksa`
  WHERE file_date = (SELECT MAX(file_date) FROM `opptra-datawarehouse.gcc_channel_reports.product_list_trendyol_3p_ksa`)
),
o AS (
  SELECT UPPER(brand) AS brand, CONCAT(model_code, '|', product_color) AS opt, MAX(n_img) AS n_img,
    LOGICAL_OR(barcode IN (SELECT ean FROM `opptra-datawarehouse.raw_gcc_dimensions.master_sl`)) AS in_master
  FROM ty GROUP BY 1, 2
)
SELECT brand, (SELECT STRING_AGG(DISTINCT CONCAT(c, ' ', CAST(file_date AS STRING))) FROM ty) AS files,
  COUNT(*) AS options, COUNTIF(in_master) AS in_master,
  COUNTIF(n_img = 1) AS img1, COUNTIF(n_img = 2) AS img2, COUNTIF(n_img = 3) AS img3, COUNTIF(n_img = 4) AS img4, COUNTIF(n_img >= 5) AS img5plus
FROM o GROUP BY brand ORDER BY options DESC
```

| Trendyol brand | Options | 1 | 2 | 3 | 4 | 5+ |
|---|---:|---:|---:|---:|---:|---:|
| Penti | 842 | 4 | 13 | 47 | 182 | 596 |
| French Connection (incl. bags, home) | 826 | 0 | 43 | 109 | 152 | 522 |
| Vero Moda | 308 | **64** | 20 | 3 | 25 | 196 |
| Puma (apparel and footwear) | 226 | 0 | 30 | 3 | 12 | 181 |
| Nautica | 223 | 1 | 0 | 4 | 38 | 180 |
| Cardio Bunny | 181 | 1 | 1 | 17 | 42 | 120 |
| Only | 28 | 0 | 0 | 1 | 1 | 26 |

So single-image apparel options are **13 by master option** or **70 by Trendyol option** (64 of them Vero Moda, mostly the
VM rows with a blank master option id). Raw bucket cross-check: not useful (see B); the Supabase raw folders are not counted here
and the audit's bucket inventory stands (e.g. `penti-sku-images` 557 folders, median 5 images, 1-7).

**A4. Absent from Styli and Centrepoint (base +).** "Absent" = no channel code on any SKU of the option in `master_sl`
(`styli_ae_ksa` / `styli_sku`, `centerpoint_ae_ksa`). Cross-check with channel stock files: Styli 3P stock holds only US Polo and
Campus EANs, and Centrepoint has one file (21 Aug), so stock cannot confirm apparel presence. No Styli or Centrepoint liveness feed exists.

```sql
, st AS (SELECT DISTINCT sku AS ean FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inventory_styli_3p_ksa`),
cp AS (SELECT DISTINCT barcode AS ean FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inventory_centrepoint_1p`),
j AS (
  SELECT s.seg, s.sc, LOGICAL_OR(s.ean IN (SELECT ean FROM st)) AS in_styli_inv, LOGICAL_OR(s.ean IN (SELECT ean FROM cp)) AS in_cp_inv
  FROM sku s GROUP BY 1, 2
)
SELECT j.seg, COUNT(*) AS options,
  COUNTIF(NOT o.has_styli) AS no_styli_code, COUNTIF(NOT j.in_styli_inv) AS not_in_styli_inventory,
  COUNTIF(NOT o.has_styli AND NOT j.in_styli_inv) AS styli_absent_both,
  COUNTIF(NOT o.has_cp) AS no_cp_code, COUNTIF(NOT j.in_cp_inv) AS not_in_cp_inventory,
  COUNTIF(NOT o.has_cp AND NOT j.in_cp_inv) AS cp_absent_both
FROM j JOIN opt o USING (seg, sc) GROUP BY 1 ORDER BY 1
```

| Segment | Options | No Styli code | No Centrepoint code | Neither |
|---|---:|---:|---:|---:|
| French Connection apparel | 729 | 665 | 366 | 366 |
| Penti | 615 | 46 | 87 | 5 |
| Vero Moda apparel | 107 | 12 | 16 | 6 |
| Cardio Bunny | 119 | 0 | 27 | 0 |
| Nautica | 159 | 159 | 159 | 159 |
| Puma apparel | 84 | 84 | 37 | 37 |
| **Apparel total** | 1,813 | **966** | **692** | 573 |
| US Polo / Campus / Keds / Puma footwear | 529 / 406 / 105 / 106 | 99 / 62 / 0 / 106 | 63 / 406 / 105 / 56 | 13 / 62 / 0 / 56 |

These replace the documented proxy (Styli 893, Centrepoint 663, DD9 L173-175) with the same method on today's master. DD9
excluded Puma apparel; without Puma apparel today's figures are Styli 882 and Centrepoint 655. Caveat: a blank
code means "not set up in the sheet", not proven "not live".

## B. Cut-at-edge inventory and view roles: not measurable

- The catalog Postgres (`ila-pg`, database `catalog`) has a private IP only (`ipv4Enabled: false`, VPC `ila-vpc`) and built-in
  password users (`catalog_app`, `ila_app`, `postgres`); no IAM database login. Any read needs the DB password from Secret
  Manager, so it was skipped as briefed. `cut_in_source` flags, `qa_scores.view` and flat-only counts were not read.
- Even with Postgres, the base is tiny. The module's raw prefix holds 104 product folders in 10 batches; 92 of them are the same
  46 Cardio Bunny `HCB-*` products run twice under the `nautica/` and `puma/` prefixes (load and acceptance runs), and the rest are
  1-2 products per brand. Command: `gcloud storage ls -r "gs://image-links-agent-assets/catalog/**"` (3,907 objects) and the
  same for `gs://image-links-agent-public/catalog/**` (2,503 objects).
- Kept from the image audit (`roadmap/03-image-audit.md`, sample of 141 products, 26 Oct): product cut by the frame on the main
  image 6/141; head cut on an on-model shot 15/64 on-model products of all categories, 13/66 in apparel (03 L167: Cardio Bunny sets
  4/15, FC 4/17, VM 3/12, Penti 2/8); apparel with no model shot 11/66
  (VM 3/12; Only 3/4 apparel single flat packshots; Anta apparel flat only). Role gaps in 66 apparel: HS missing 57, FC 31, FM 25, BH 19, FL 14.

## Kids counting rule

- Rule (in the base query, `is_kids`): gender Kids / BOY / GIRL, or name or option id containing `JR`, `PS`, `INF`, `INFANT`,
  `KID(S)`, `BOY(S)`, `GIRL(S)` or `YOUTH` as a word, or `-K-`. An option is kids when any of its SKUs matches.
- The total of 108 includes 20 apparel kids (Penti 12, Puma apparel 8).
- Footwear and bags: 88 here (US Polo 49, Puma 33, Campus 6) against the documented 85 (US Polo 49, Puma 31, Campus 5; DD4 L69).

## C. Footwear and bags

Style-colours, images per style-colour and kids are in the summary table (queries A1, A2). Rules and caveats:
- US Polo kids 49 and Puma kids 33 match or are close to DD4 (49, 31); Campus kids 6 (DD4 5). Puma "PS" (pre-school) and "Jr"
  drive most Puma kids; the rule may also catch an adult name containing BOY or GIRL as a word.
- Not on Trendyol (no image count): Campus 41, Keds 8, Puma footwear 1, VM bags 5, US Polo 0, FC bags 0.
- On-model / worn / lifestyle view: **not measurable** (no `qa_scores.view`; Trendyol gives counts, not roles). Kept from DD4:
  Puma 5/8 and FC bags 7/8 already show the product worn or carried; Campus 11/15 mix in a lifestyle shot (audit; styled studio sets, no person; see DD4 F2).

## D. Live and stocked by channel (base +)

Latest connected `as_of_date` per channel-country (all 2026-10-26). An option counts when any of its EANs is live (or live and
stocked) in either country.

```sql
, lv AS (
  SELECT l.as_of_date, l.ean, l.channel, l.channel_country, l.live, l.stocked
  FROM `opptra-datawarehouse.fact_gcc.catalog_liveness_daily` l
  JOIN (SELECT channel_country, MAX(as_of_date) AS d FROM `opptra-datawarehouse.fact_gcc.catalog_liveness_daily`
        WHERE connected GROUP BY 1) m
    ON m.channel_country = l.channel_country AND m.d = l.as_of_date
),
j AS (
  SELECT s.seg, s.sc, lv.channel, LOGICAL_OR(IFNULL(lv.live, FALSE)) AS live, LOGICAL_OR(IFNULL(lv.live, FALSE) AND IFNULL(lv.stocked, FALSE)) AS live_stocked
  FROM sku s JOIN lv ON lv.ean = s.ean GROUP BY 1, 2, 3
)
SELECT seg, channel, COUNTIF(live) AS options_live, COUNTIF(live_stocked) AS options_live_and_stocked,
  (SELECT STRING_AGG(DISTINCT CONCAT(channel_country, ' ', CAST(as_of_date AS STRING)) ORDER BY CONCAT(channel_country, ' ', CAST(as_of_date AS STRING))) FROM lv) AS dates
FROM j GROUP BY 1, 2 ORDER BY 1, 2
```

The "any channel" column uses the same `lv` with `FROM sku s LEFT JOIN lv ON lv.ean = s.ean GROUP BY 1, 2` and no channel split.

| Segment (live / live and stocked) | Noon | Namshi | Trendyol | Amazon | Any channel |
|---|---|---|---|---|---|
| French Connection apparel | 619 / 619 | 619 / 619 | 536 / 536 | 652 / 470 | 712 / 624 |
| Penti | 512 / 511 | 512 / 511 | 386 / 386 | 615 / 378 | 615 / 521 |
| Vero Moda apparel | 91 / 91 | 91 / 91 | 69 / 69 | 77 / 58 | 99 / 97 |
| Cardio Bunny | 116 / 116 | 116 / 116 | 113 / 113 | 119 / 114 | 119 / 117 |
| Nautica | 33 / 32 | 33 / 32 | 41 / 41 | 40 / 22 | 62 / 45 |
| Puma apparel | 0 / 0 | 0 / 0 | 50 / 50 | 0 / 0 | 50 / 50 |
| US Polo | 428 / 427 | 430 / 429 | 411 / 411 | 455 / 392 | 494 / 458 |
| Campus | 358 / 358 | 358 / 358 | 321 / 321 | 377 / 343 | 397 / 381 |
| Keds | 105 / 105 | 105 / 105 | 94 / 94 | 105 / 99 | 105 / 105 |
| Puma footwear | 0 / 0 | 0 / 0 | 32 / 31 | 0 / 0 | 32 / 31 |
| FC bags | 55 / 55 | 55 / 55 | 58 / 58 | 7 / 6 | 59 / 58 |
| Vero Moda bags | 8 / 8 | 8 / 8 | 3 / 3 | 2 / 1 | 8 / 8 |

Caveats: Amazon "live" uses the Active Listings fallback and overstates (doc 02). Puma is in liveness scope only on Trendyol.
Noon and Namshi agree at option level here although they differ slightly at EAN level (doc 02). Styli, Centrepoint, 6thStreet,
VogaCloset and Shein have no liveness feed, so pages there cannot be counted.

## E. Inflow: new options per month (base +)

`master_sl.createdDate` is a load timestamp, so it cannot date options. Proxy: first date an option's `product_code` appears in
the Noon live export (UAE or KSA, from 25 Feb) or in a Unicommerce GRN (goods received, from 6 Apr).

```sql
, seen AS (
  SELECT partner_sku AS pc, MIN(file_date) AS d FROM `opptra-datawarehouse.raw_gcc_table_cleaned.catalog_live_noon_3p_uae` GROUP BY 1
  UNION ALL SELECT partner_sku, MIN(file_date) FROM `opptra-datawarehouse.raw_gcc_table_cleaned.catalog_live_noon_3p_ksa` GROUP BY 1
  UNION ALL SELECT item_skucode, MIN(grn_date_date) FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_fze_uae` GROUP BY 1
  UNION ALL SELECT item_skucode, MIN(grn_date_date) FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_rfs_uae` GROUP BY 1
  UNION ALL SELECT item_skucode, MIN(grn_date_date) FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_sls_ksa` GROUP BY 1
  UNION ALL SELECT item_skucode, MIN(grn_date_date) FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_stl_ksa` GROUP BY 1
  UNION ALL SELECT item_skucode, MIN(grn_date_date) FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_virtual_uae` GROUP BY 1
),
first_opt AS (
  SELECT s.seg, s.sc, MIN(seen.d) AS first_seen
  FROM sku s LEFT JOIN seen ON seen.pc = s.product_code GROUP BY 1, 2
)
SELECT seg, COUNT(*) AS options, COUNTIF(first_seen IS NULL) AS never_seen,
  COUNTIF(first_seen < '2026-05-01') AS seen_before_may,
  COUNTIF(DATE_TRUNC(first_seen, MONTH) = '2026-05-01') AS m2026_05,
  COUNTIF(DATE_TRUNC(first_seen, MONTH) = '2026-06-01') AS m2026_06,
  COUNTIF(DATE_TRUNC(first_seen, MONTH) = '2026-07-01') AS m2026_07,
  COUNTIF(DATE_TRUNC(first_seen, MONTH) = '2026-08-01') AS m2026_08,
  COUNTIF(DATE_TRUNC(first_seen, MONTH) = '2026-09-01') AS m2026_09,
  COUNTIF(DATE_TRUNC(first_seen, MONTH) = '2026-10-01') AS m2026_10_to_25
FROM first_opt GROUP BY seg ORDER BY seg
```

| Segment | Before May | May | Jun | Jul | Aug | Sep | Oct (to 25th) | Never seen |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| French Connection apparel | 165 | 8 | 0 | 108 | 32 | 227 | 4 | 185 |
| Penti | 278 | 77 | 228 | 19 | 0 | 0 | 0 | 13 |
| Vero Moda apparel | 91 | 4 | 0 | 6 | 2 | 3 | 0 | 1 |
| Cardio Bunny | 36 | 57 | 0 | 26 | 0 | 0 | 0 | 0 |
| Nautica | 82 | 0 | 0 | 25 | 0 | 14 | 1 | 37 |
| Puma apparel | 73 | 0 | 0 | 0 | 0 | 1 | 0 | 10 |
| US Polo | 299 | 7 | 56 | 0 | 0 | 108 | 11 | 48 |
| Campus | 222 | 0 | 167 | 0 | 0 | 2 | 8 | 7 |
| Keds | 85 | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| Puma footwear | 67 | 0 | 0 | 0 | 0 | 7 | 0 | 32 |
| FC bags | 59 | 0 | 0 | 4 | 0 | 0 | 0 | 0 |
| Vero Moda bags | 0 | 1 | 0 | 0 | 0 | 7 | 0 | 5 |

Six-month inflow (May to 25 Oct): apparel 842 options, footwear and bags 398, 1,240 in total, arriving in seasonal
drops (FC Sep 227, Penti Jun 228, Campus Jun 167, US Polo Sep 108). Caveats: options received before 6 Apr and not on Noon before
May would show as new (the GRN history starts 6 Apr), so May and June may include older stock; Puma is not on Noon, so Puma dates
come from GRN only; "never seen" options (338 in these segments: apparel 246, footwear and bags 92) have no Noon or GRN record and are not dated. Only, sold but not in master,
is not counted (GRN shows 60 Only SKUs).
