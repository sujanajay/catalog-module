# 03 Baseline metrics: demand, assortment and stock across Opptra GCC brands

Date: 2026-10-26. Proposal: demand forecasting, assortment planning and new product (NPD) insight for all Opptra
GCC brands. This is a read-only baseline. All numbers were read from BigQuery project `opptra-datawarehouse` on
2026-10-26 with SELECT queries that return aggregates only. No customer name, phone, email or address column was
read. Every query is in the appendix.

Trailing twelve months (TTM) means 2025-10-22 to 2026-10-21, the same window as DD9
(`docs/plans/deep-dives/09-business-impact.md`), so the softline numbers can be compared with it.

## Headline points

- GCC brands sold **USD 13.4M gross** (incl VAT) and **314k units** in the TTM. Softline (9 brands) is USD 8.46M,
  which matches DD9's USD 8.5M attributed softline base (DD9 reaches USD 9.2M only by adding sales with no brand on
  softline channels). Hardline (9 brands) is USD 4.93M. After cancellations and returns, net is USD 12.0M.
- **U.S. Polo Assn. is 46% of GCC revenue and 72% of softline.** Nutricook and GTPlayer are the next two.
- **History is short.** Only U.S. Polo Assn. and Nautica cover two Ramadans. 15 of 18 brands started selling
  on or after 29 October 2025, and 10 of them in 2026. Any forecasting product must work with 3 to 12 months of history per brand
  (a "cold start" problem), and borrow seasonality from the brands that have more.
- **Seasonal peaks are clear where data allows.** White Friday 2025 lifted daily revenue about **+50% to +64%**
  against the surrounding 4 weeks. Ramadan 2025 lifted it about **+50%** (U.S. Polo Assn.). Ramadan 2026 is weaker
  on a whole-month average (softline +5% to +17%) because the month before had its own late-January spike, but the
  two peak Ramadan weeks (2 to 15 March 2026) ran about +35% to +60% above the February weeks, then fell in Eid week.
- **Growth is mostly channel and brand launches, not like-for-like demand.** Namshi KSA (from September 2025) and
  Noon KSA (from October 2025) doubled U.S. Polo Assn. volume: Q3 2026 units are +188% on Q3 2025, while the
  last 6 months against the 6 before are flat in units (-1%).
- **Stock is both short and long at the same time (softline replenishment run of 2026-10-25).** 48% of the
  SKU-location pairs that sold in the look-back window have under 14 days of cover (most of them zero), while 19%
  have over 120 days. 16,146 SKU-location pairs hold stock with no sales in the window.
- **Stock-out proxy: about USD 6.7k a day of softline demand** sits on SKU-locations with zero stock but a positive
  rate of sale (upper bound, see definitions). 63% of it is on SKUs that have stock in another location, so it is a
  placement problem more than a buying problem. Only USD 1.4k a day comes from SKU-locations selling 0.2 units a
  day or more.
- **Ageing (proxy) is heavy:** about **66% of stock value is over 90 days** since receipt and **41% over 180 days**,
  on USD 6.5M of stock valued at selling price. French Connection (85% over 180 days) and U.S. Polo Assn. (68%) carry
  most of it. The proxy overstates age for U.S. Polo Assn. (see caveats).
- **Returns:** 13% of softline gross value comes back as returns (cancellations excluded). On Namshi, size or fit
  returns are **USD 682k** in the TTM, matching DD9's USD 0.68M.
- **Lead time cannot be measured for the GCC today.** Purchase orders in the GCC warehouse systems are raised on
  arrival (median 1 day from PO to receipt), and the lead time tables in `brand_intelligence` cover India only.
- **AOP:** for June to August 2026, the GCC brands earned 1.12 times the AOP target in gross revenue and 1.01 times
  in net revenue. The target's revenue basis is not stated in the table.
- **Cardio Bunny** (launched March 2026): USD 93k TTM, 86% on Namshi; sweatshirts, T-shirts and leggings are 63% of
  revenue; about 7.4k units in stock, which is about 7 months of cover at the last 90 days' pace; 29% 90-day
  sell-through; none of its 91 Namshi listings seen by Scout has a rating or review.

## Summary table (per brand and GCC total)

Gross revenue and units are TTM sale events in `fact_gcc.unified_sales_tertiary_v2`. Stock is the latest snapshot of
every `fact_gcc.unified_inventory` source (own warehouses, Noon FBN, Amazon FBA, Centrepoint), valued at the SKU's
TTM average selling price. "Cycles covered" lists events with at least 28 days of data before them: R25 Ramadan
2025, WF25 White Friday 2025, R26 Ramadan 2026; "(part)" means the brand started selling less than 28 days before.

| Brand | Seg | Months of data | Cycles covered | TTM gross USD | TTM units | Net USD (after cancels, returns) | Return rate (value) | Units L6M vs P6M | Units Q3 YoY | SKUs sold TTM | Active SKUs 90d | Styles sold TTM | Stock units | Stock value at ASP | Sell-through 90d | Stock > 90 days (value share) | Stock > 180 days (value share) | Namshi size/fit returns USD | AOP Jun-Aug gross vs target |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| U.S. Polo Assn. | Soft | 25 | R25, WF25, R26 | 6.12M | 152,999 | 5.32M | 11% | -1% | +188% | 2835 | 2186 | 524 | 40,264 | 1.65M | 52% | 80% | 68% | 388k | 1.77 |
| French Connection | Soft | 17 | WF25, R26 | 681k | 18,187 | 467k | 28% | +62% | n/a | 2256 | 1605 | 743 | 20,418 | 789k | 22% | 88% | 85% | 127k | 3.26 |
| Campus | Soft | 13 | WF25(part), R26 | 668k | 25,998 | 542k | 15% | +93% | n/a | 1714 | 1442 | 1009 | 16,330 | 430k | 40% | 43% | 26% | 68k | 1.19 |
| Penti | Soft | 12 | WF25(part), R26 | 403k | 23,279 | 363k | 7% | +14% | n/a | 2280 | 1587 | 573 | 16,729 | 343k | 29% | 88% | 14% | 19k | 0.78 |
| Keds | Soft | 9 | R26(part) | 138k | 3,267 | 96k | 27% | launch ramp | n/a | 601 | 530 | 103 | 12,359 | 500k | 12% | 25% | 20% | 30k | 2.3 |
| Vero Moda | Soft | 9 | none | 138k | 4,469 | 89k | 33% | launch ramp | n/a | 517 | 464 | 100 | 6,749 | 197k | 29% | 15% | 15% | 24k | 1.59 |
| Puma | Soft | 10 | R26 | 109k | 3,198 | 99k | 8% | launch ramp | n/a | 745 | 404 | 176 | 4,018 | 154k | 32% | 48% | 48% | n/a | 2.17 |
| Nautica | Soft | 22 | R25, WF25, R26 | 108k | 6,938 | 86k | 18% | +61% | -1% | 746 | 308 | 151 | 143 | 2k | 86% | 100% | 100% | 14k | 1.25 |
| Cardio Bunny | Soft | 8 | none | 93k | 4,540 | 72k | 20% | launch ramp | n/a | 466 | 440 | 119 | 7,752 | 161k | 29% | 100% | 20% | 14k | 1.62 |
| Nutricook | Hard | 10 | R26(part) | 1.87M | 34,370 | 1.87M | 0% | launch ramp | n/a | 46 | 46 | n/a | 7,010 | 534k | 70% | 47% | 31% | n/a | 0.82 (Nutri) |
| GTPlayer | Hard | 12 | WF25(part), R26 | 1.52M | 12,398 | 1.51M | 0% | +27% | n/a | 22 | 22 | n/a | 1,901 | 278k | 56% | 7% | 3% | n/a | 0.98 |
| NutriBullet | Hard | 9 | R26(part) | 574k | 9,299 | 574k | -0% | launch ramp | n/a | 21 | 21 | n/a | 5,811 | 353k | 36% | 100% | 62% | n/a | 0.82 (Nutri) |
| Carote | Hard | 9 | R26(part) | 572k | 7,485 | 557k | 2% | launch ramp | n/a | 40 | 40 | n/a | 5,946 | 644k | 34% | 98% | 11% | n/a | 0.78 |
| Bergner | Hard | 10 | R26(part) | 259k | 5,708 | 255k | 1% | launch ramp | n/a | 79 | 75 | n/a | 6,825 | 333k | 17% | 11% | 4% | n/a | 0.56 |
| Dowinx | Hard | 11 | WF25(part), R26 | 108k | 978 | 108k | -0% | -95% | n/a | 10 | 5 | n/a | 0 | 0 | 100% | - | - | n/a | - |
| Tower | Hard | 5 | none | 17k | 817 | 17k | 2% | launch ramp | n/a | 15 | 15 | n/a | 1,863 | 51k | 28% | 100% | 0% | n/a | 0.51 |
| Qubo | Hard | 6 | none | 8k | 114 | 8k | -0% | launch ramp | n/a | 4 | 2 | n/a | 807 | 47k | 1% | 63% | 63% | n/a | 0.13 |
| Nuwey | Hard | 3 | none | 2k | 79 | 2k | -0% | launch ramp | n/a | 1 | 1 | n/a | 149 | 7k | 35% | 1% | 0% | n/a | - |
| **Softline total** | | | | **8.46M** | 242,875 | 7.14M | 13% | +25% | +337% | 12,160 | 8,966 | 3,498 | 124,762 | 4.23M | 38% | 68% | 52% | 682k | |
| **Hardline total** | | | | **4.93M** | 71,248 | 4.91M | 0% | +192% | n/a | 238 | 227 | 0 | 30,312 | 2.25M | 48% | 62% | 23% | n/a | |
| **GCC total** | | | | **13.39M** | 314,123 | 12.04M | 8% | +49% | +482% | 12,398 | 9,193 | 3,498 | 155,074 | 6.48M | 40% | 66% | 42% | 682k | |

Reading notes:
- "Units L6M vs P6M" compares 2026-04-22 to 2026-10-21 against 2025-10-22 to 2026-04-21. The earlier half holds White
  Friday and Ramadan, so this understates underlying growth for seasonal brands. "launch ramp" means the brand had
  no full earlier half.
- "Units Q3 YoY" compares July to September 2026 with July to September 2025. Only U.S. Polo Assn. and Nautica have
  both quarters at a settled level.
- Growth on the total rows includes brand launches and new channels, so it describes the business, not
  like-for-like demand.
- Hardline return rates near 0% are a data gap, not a fact: most hardline revenue is Amazon and Noon 1P sell-out and
  manual hardline sales files, which carry no returns.
- Sell-through 90d = units sold in the last 90 days / (units sold in the last 90 days + units on hand now).
- AOP for Nutricook and NutriBullet is one combined "Nutri" target.

## Definitions

- **Gross revenue (USD)**: `revenue_usd` on rows with `event_type = 'sale'` in `unified_sales_tertiary_v2`. It equals
  local revenue including VAT divided by the table's FX (AED 3.672, SAR 3.75). It is what the customer paid at
  order, before cancellations and returns. DD9 used `order_quantity x listing_unit_price` in `unified_sales` with
  B2B, FBN-transfer, SOR, CUSTOM and IWIT rows removed; the tertiary table already holds only customer (tertiary)
  sales, so no extra exclusion is needed, and the softline totals agree (8.46M here against 8.5M in DD9).
- **Net revenue**: gross plus the negative `reversal` rows (cancellations and returns).
- **Return rate (value)**: returned reversal value / gross value, same window.
- **Brand**: `mapped_brand`, or `source_brand` when blank, with spellings merged (USPA and U.S. POLO ASSN.;
  CAMPUS and Campus; PENTI and Penti; NAUTICA, PUMA, Vero_Moda). 18 brands carry revenue, plus Only (USD 865).
  Softline: U.S. Polo Assn., French Connection, Campus, Penti, Keds, Vero Moda, Puma, Nautica, Cardio Bunny.
  Hardline: Nutricook, GTPlayer, NutriBullet, Carote, Bergner, Dowinx, Tower, Qubo, Nuwey.
- **Months of data**: calendar months from the brand's first to last sale with revenue.
- **Growth**: unit growth, not revenue growth, because the revenue measure changed on 2026-08-01 (caveat 3).
- **Seasonal uplift**: average gross revenue per day inside the event window against the 28 days before and the 28
  days after. Windows: Ramadan 2025 = 1 to 29 March 2025; Ramadan 2026 = 18 February to 19 March 2026; White
  Friday 2025 = 20 November to 2 December 2025; 11.11 2025 = 9 to 12 November 2025 (added for context). Dates are
  the calendar event dates; each marketplace's sale dates differ by a few days.
- **SKU**: one sellable size (Opptra SKU). **Option**: one style in one colour. **Style**: `style_id` in the sales
  table (for Campus this is close to an option, see DD9 note on Campus). **Active SKU**: sold at least once in the
  last 90 days (2026-07-24 to 2026-10-21).
- **New style launched**: a style (softline) or SKU (hardline) counted in the month of its first sale in the data.
  Months marked * fall in the brand's first 60 days of data, where everything looks new.
- **Stock value at ASP**: units on hand x the SKU's TTM average selling price in USD (incl VAT); brand average when
  the SKU did not sell. It is a retail value, not cost. Cost could not be used (caveat 6).
- **Ageing (proxy, first in first out)**: units on hand for each SKU are matched to that SKU's most recent vendor
  receipts into the GCC (`raw_gcc_table_cleaned.itd_grn_fin` plus vendor receipts in the four Unicommerce warehouses),
  newest first. A unit's age is days from that receipt to 2026-10-22. Units with no receipt left to match are "age
  unknown". `brand_intelligence.inventory_ageing` holds India only, so it could not be used.
- **Days of cover**: from the latest successful replenishment run (`channel_replen_by_sku`, run
  crv2-20261025-9590e389, as of 2026-10-25): on hand / rate of sale for each selling location (UAE mainland, KSA
  Salasa, Noon FBN UAE, Noon FBN KSA). Rate of sale is the run's own (units sold over a 14 to 60 day window). Only
  location pairs with a positive rate of sale are in the distribution. The run covers softline only.
- **Stock-out proxy**: share of SKU-location pairs with zero stock and a positive rate of sale; implied lost sales per
  day = rate of sale x average selling price, summed. **This is a proxy, not measured lost sales**: some demand moves
  to another location or a substitute, the rate of sale may come from a short promotion, and a location may be out
  on purpose.
- **Size or fit returns**: DD9's method unchanged: Namshi order lines in `fact_gcc.unified_sales`, softline EANs only,
  B2B, FBN, SOR, CUSTOM and IWIT rows excluded, `return_reason` matching size, fit, small, large, big, tight or loose,
  valued at `order_quantity x listing_unit_price`.

## Monthly revenue trend (USD thousands, gross)

October 2026 is 1 to 21 October only (partial month).

| Brand (USD k, gross) | 2025-11 | 2025-12 | 2026-01 | 2026-02 | 2026-03 | 2026-04 | 2026-05 | 2026-06 | 2026-07 | 2026-08 | 2026-09 | 2026-10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| U.S. Polo Assn. | 688 | 527 | 569 | 425 | 523 | 368 | 385 | 355 | 575 | 911 | 441 | 187 |
| French Connection | 36 | 41 | 44 | 42 | 54 | 34 | 63 | 62 | 76 | 96 | 74 | 53 |
| Campus | 33 | 40 | 32 | 31 | 58 | 57 | 55 | 36 | 78 | 122 | 84 | 40 |
| Penti | 20 | 24 | 13 | 31 | 79 | 33 | 33 | 28 | 33 | 45 | 40 | 24 |
| Keds | 0 | 0 | 0 | 3 | 13 | 12 | 20 | 15 | 13 | 25 | 26 | 12 |
| Vero Moda | 0 | 0 | 0 | 0 | 4 | 18 | 17 | 13 | 12 | 23 | 25 | 25 |
| Puma | 0 | 0 | 3 | 14 | 5 | 3 | 1 | 7 | 1 | 37 | 34 | 5 |
| Nautica | 8 | 10 | 20 | 5 | 11 | 8 | 24 | 6 | 4 | 5 | 3 | 2 |
| Cardio Bunny | 0 | 0 | 0 | 0 | 1 | 2 | 7 | 12 | 15 | 14 | 23 | 18 |
| Nutricook | 0 | 0 | 2 | 150 | 168 | 155 | 229 | 253 | 199 | 249 | 331 | 138 |
| GTPlayer | 125 | 62 | 86 | 136 | 160 | 131 | 157 | 181 | 201 | 145 | 97 | 37 |
| NutriBullet | 0 | 0 | 0 | 30 | 54 | 64 | 71 | 103 | 67 | 72 | 85 | 28 |
| Carote | 0 | 0 | 0 | 10 | 40 | 58 | 89 | 71 | 47 | 82 | 97 | 77 |
| Bergner | 0 | 0 | 2 | 28 | 29 | 27 | 42 | 42 | 21 | 24 | 25 | 19 |
| Dowinx | 47 | 16 | 11 | 13 | 14 | 2 | 0 | 1 | 1 | 0 | 2 | 0 |
| Tower | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 3 | 5 | 6 | 3 |
| Qubo | 0 | 0 | 0 | 0 | 0 | 4 | 3 | 1 | 0 | 0 | 0 | 0 |
| Nuwey | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 1 |
| Softline total | 784 | 641 | 681 | 551 | 748 | 536 | 605 | 535 | 808 | 1,277 | 751 | 365 |
| Hardline total | 172 | 78 | 102 | 367 | 466 | 441 | 590 | 652 | 539 | 578 | 644 | 304 |
| GCC total | 957 | 720 | 783 | 919 | 1,213 | 976 | 1,195 | 1,187 | 1,348 | 1,857 | 1,399 | 671 |

What the trend shows:
- U.S. Polo Assn. steps up in November 2025 (Namshi KSA and Noon KSA ramping, plus White Friday), peaks again in
  March (Ramadan) and August 2026. The August peak is partly a measurement change: on 2026-08-01 the sales source
  switched from the 3PL feed (`itd_sale`) to channel feeds, and average selling price per unit jumped 13% to 22% for
  U.S. Polo Assn., French Connection, Campus and Penti overnight while daily units stayed level (caveat 3).
- Hardline revenue starts in November 2025 (GTPlayer, Dowinx) and grows from February 2026 as Nutricook,
  NutriBullet, Carote and Bergner launch.
- Softline months since April 2026 are mostly growth from new brands (Keds, Vero Moda, Puma, Cardio Bunny) and new
  styles, not from the core brands.

Weekly view (gross USD, selected weeks, from query S3b): U.S. Polo Assn. ran about USD 40k to 60k a week in early
2025, peaked at USD 91k in the last Ramadan week of 2025 (24 March), stepped to about USD 120k to 160k a week from
late October 2025, peaked at USD 243k in White Friday week (24 November 2025), USD 228k in the week of 26 January
2026, USD 156k in the second-to-last Ramadan week (9 March 2026), and fell to USD 81k in Eid week (16 March 2026).

## Seasonal peaks and uplift

| Event | Brand | Data before event | Event avg USD/day | 28 days before, USD/day | 28 days after, USD/day | Uplift vs before | Uplift vs average of before and after |
|---|---|---|---|---|---|---|---|
| 11.11 2025 | Hardline total | no (launched 2025-11-01) | 9,872 | 1,392 | 4,257 | +609% | +250% |
| 11.11 2025 | GCC total | yes | 42,297 | 17,737 | 29,392 | +138% | +79% |
| 11.11 2025 | Softline total | yes | 32,425 | 16,345 | 25,135 | +98% | +56% |
| 11.11 2025 | Campus | no (launched 2025-10-29) | 1,386 | 212 | 1,329 | +554% | +80% |
| 11.11 2025 | Dowinx | no (launched 2025-11-01) | 2,670 | 449 | 1,117 | +495% | +241% |
| 11.11 2025 | French Connection | yes | 1,206 | 864 | 1,280 | +40% | +12% |
| 11.11 2025 | GTPlayer | no (launched 2025-11-01) | 7,202 | 943 | 3,140 | +664% | +253% |
| 11.11 2025 | Nautica | yes | 345 | 208 | 298 | +66% | +36% |
| 11.11 2025 | Penti | no (launched 2025-11-01) | 877 | 52 | 874 | +1587% | +89% |
| 11.11 2025 | U.S. Polo Assn. | yes | 28,611 | 15,009 | 21,354 | +91% | +57% |
| Ramadan 2025 | GCC total | yes | 10,406 | 6,848 | 7,270 | +52% | +47% |
| Ramadan 2025 | Softline total | yes | 10,406 | 6,848 | 7,270 | +52% | +47% |
| Ramadan 2025 | Nautica | yes | 383 | 148 | 173 | +159% | +139% |
| Ramadan 2025 | U.S. Polo Assn. | yes | 10,023 | 6,700 | 7,097 | +50% | +45% |
| Ramadan 2026 | Hardline total | yes | 14,592 | 9,286 | 14,358 | +57% | +23% |
| Ramadan 2026 | Softline total | yes | 24,451 | 23,390 | 18,514 | +5% | +17% |
| Ramadan 2026 | GCC total | yes | 39,043 | 32,676 | 32,872 | +19% | +19% |
| Ramadan 2026 | Bergner | no (launched 2026-01-25) | 1,040 | 610 | 982 | +70% | +31% |
| Ramadan 2026 | Campus | yes | 1,595 | 990 | 2,044 | +61% | +5% |
| Ramadan 2026 | Cardio Bunny | no (launched 2026-03-16) | 1 | 0 | 38 | n/a | n/a |
| Ramadan 2026 | Carote | no (launched 2026-02-01) | 946 | 141 | 1,498 | +571% | +15% |
| Ramadan 2026 | Dowinx | yes | 511 | 437 | 151 | +17% | +74% |
| Ramadan 2026 | French Connection | yes | 1,813 | 1,472 | 1,304 | +23% | +31% |
| Ramadan 2026 | GTPlayer | yes | 4,824 | 4,345 | 4,636 | +11% | +7% |
| Ramadan 2026 | Keds | no (launched 2026-02-13) | 341 | 11 | 384 | n/a | +73% |
| Ramadan 2026 | Nautica | yes | 317 | 703 | 274 | -55% | -35% |
| Ramadan 2026 | NutriBullet | no (launched 2026-02-01) | 1,452 | 606 | 2,166 | +140% | +5% |
| Ramadan 2026 | Nutricook | no (launched 2026-01-27) | 5,813 | 3,147 | 4,853 | +85% | +45% |
| Ramadan 2026 | Penti | yes | 2,605 | 568 | 1,446 | +359% | +159% |
| Ramadan 2026 | Puma | yes | 260 | 372 | 134 | -30% | +3% |
| Ramadan 2026 | Qubo | no (launched 2026-03-15) | 5 | 0 | 72 | n/a | n/a |
| Ramadan 2026 | U.S. Polo Assn. | yes | 17,469 | 19,275 | 12,522 | -9% | +10% |
| Ramadan 2026 | Vero Moda | no (launched 2026-02-25) | 50 | 0 | 368 | n/a | -73% |
| White Friday 2025 | GCC total | yes | 38,528 | 24,542 | 22,529 | +57% | +64% |
| White Friday 2025 | Hardline total | no (launched 2025-11-01) | 6,268 | 3,556 | 2,412 | +76% | +110% |
| White Friday 2025 | Softline total | yes | 32,260 | 20,986 | 20,116 | +54% | +57% |
| White Friday 2025 | Campus | no (launched 2025-10-29) | 1,376 | 676 | 1,255 | +104% | +43% |
| White Friday 2025 | Dowinx | no (launched 2025-11-01) | 1,552 | 1,035 | 508 | +50% | +101% |
| White Friday 2025 | French Connection | yes | 1,421 | 993 | 1,325 | +43% | +23% |
| White Friday 2025 | GTPlayer | no (launched 2025-11-01) | 4,716 | 2,521 | 1,904 | +87% | +113% |
| White Friday 2025 | Nautica | yes | 357 | 200 | 319 | +78% | +38% |
| White Friday 2025 | Penti | no (launched 2025-11-01) | 933 | 345 | 760 | +170% | +69% |
| White Friday 2025 | U.S. Polo Assn. | yes | 28,173 | 18,771 | 16,458 | +50% | +60% |

Reading: White Friday is the most reliable peak in the data (+50% to +60% for U.S. Polo Assn. and softline,
both against the 4 weeks before and the average of before and after). Ramadan behaves differently across the
two years: in 2025 the lift built through the month to a peak in the last week; in 2026 the month average is close
to the month before because late January 2026 had its own spike, and the Eid week drop pulls the average down.
For launch-period brands the "before" number is near zero, so their uplift numbers are not meaningful.

## Assortment: catalogue size, active SKUs and new styles

| Brand | Catalogue SKUs (unified_sku_master_gcc) | Options in master_sl (softline) | SKUs / options in P2P item master | SKUs sold TTM | Active SKUs (sold in last 90 days) | Styles sold TTM |
|---|---|---|---|---|---|---|
| U.S. Polo Assn. | 2974 | 529 | 13259 / 3068 | 2835 | 2186 | 524 |
| French Connection | 2577 | 899 | - / - | 2256 | 1605 | 743 |
| Campus | 1791 | 1012 | 1952 / 479 | 1714 | 1442 | 1009 |
| Penti | 3149 | 615 | 3282 / 664 | 2280 | 1587 | 573 |
| Keds | 671 | 105 | 641 / 77 | 601 | 530 | 103 |
| Vero Moda | 569 | 120 | 1891 / 399 | 517 | 464 | 100 |
| Puma | 823 | 190 | - / - | 745 | 404 | 176 |
| Nautica | 832 | 159 | - / - | 746 | 308 | 151 |
| Cardio Bunny | 513 | 119 | 724 / 179 | 466 | 440 | 119 |
| Nutricook | 57 | - | - / - | 46 | 46 | n/a |
| GTPlayer | 20 | - | 28 / 3 | 22 | 22 | n/a |
| NutriBullet | 21 | - | - / - | 21 | 21 | n/a |
| Carote | 40 | - | 40 / 0 | 40 | 40 | n/a |
| Bergner | 81 | - | 129 / 0 | 79 | 75 | n/a |
| Dowinx | 10 | - | - / - | 10 | 5 | n/a |
| Tower | 35 | - | 15 / 0 | 15 | 15 | n/a |
| Qubo | 4 | - | 4 / 0 | 4 | 2 | n/a |
| Nuwey | 1 | - | - / - | 1 | 1 | n/a |

Notes: the P2P item master (`sku_master_p2p`, GCC legal entities, latest snapshot) counts every code set up,
including future and discontinued items; U.S. Polo Assn.'s 13,259 SKUs and 3,068 options there are far more than the
2,974 SKUs and 529 options in the softline master (`master_sl`). French Connection, Puma, Nautica, Nutricook,
NutriBullet and Dowinx are not in P2P yet. For Campus, `style_id` counts (1,009) are option-level; DD9 found 405
true style-colours.

New styles (softline) or SKUs (hardline) by month of first sale:

| Brand | Counted as | 2025-11 | 2025-12 | 2026-01 | 2026-02 | 2026-03 | 2026-04 | 2026-05 | 2026-06 | 2026-07 | 2026-08 | 2026-09 | 2026-10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| U.S. Polo Assn. | styles | 53 | 2 | 0 | 103 | 24 | 4 | 13 | 28 | 38 | 2 | 2 | 0 |
| French Connection | styles | 60 | 62 | 57 | 38 | 69 | 22 | 49 | 28 | 11 | 16 | 111 | 73 |
| Campus | styles | 466* | 168* | 92 | 46 | 24 | 7 | 3 | 3 | 104 | 55 | 9 | 0 |
| Penti | styles | 168* | 16* | 2 | 63 | 35 | 4 | 6 | 34 | 109 | 93 | 39 | 22 |
| Keds | styles | 0 | 0 | 0 | 27* | 38* | 3* | 12 | 4 | 4 | 3 | 3 | 1 |
| Vero Moda | styles | 0 | 0 | 0 | 1* | 42* | 29* | 5 | 3 | 3 | 12 | 0 | 0 |
| Puma | styles | 0 | 0 | 30* | 67* | 11 | 3 | 0 | 13 | 1 | 34 | 8 | 2 |
| Nautica | styles | 1 | 1 | 3 | 0 | 0 | 3 | 0 | 0 | 0 | 2 | 1 | 0 |
| Cardio Bunny | styles | 0 | 0 | 0 | 0 | 10* | 13* | 26 | 28 | 22 | 10 | 1 | 1 |
| Nutricook | SKUs | 0 | 0 | 3* | 25* | 4* | 3 | 7 | 0 | 0 | 5 | 0 | 0 |
| GTPlayer | SKUs | 9* | 0 | 1 | 3 | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 5 |
| NutriBullet | SKUs | 0 | 0 | 0 | 17* | 4* | 0 | 0 | 0 | 0 | 1 | 0 | 0 |
| Carote | SKUs | 0 | 0 | 0 | 25* | 2* | 2 | 0 | 0 | 8 | 2 | 0 | 0 |
| Bergner | SKUs | 0 | 0 | 16* | 35* | 1* | 0 | 23 | 2 | 0 | 1 | 0 | 1 |
| Dowinx | SKUs | 10* | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Tower | SKUs | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 5* | 10* | 0 | 0 | 0 |
| Qubo | SKUs | 0 | 0 | 0 | 0 | 2* | 2* | 0 | 0 | 0 | 0 | 0 | 0 |
| Nuwey | SKUs | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1* | 0 | 0 |

Reading: French Connection adds 40 to 110 styles in most months; Penti and Campus add in waves (June to August
2026); U.S. Polo Assn. adds in drops (103 in February 2026). This is the signal an NPD product would learn from:
how a new style sells in its first 4 to 8 weeks against older styles of the same brand and category.

## Stock, cover and stock-outs (softline replenishment run, 2026-10-25)

The run's table stores each SKU three times per run; one copy is kept (query R1 and R2).

| Brand | SKUs in run | Selling SKU-lanes | Cover under 14 days | Cover over 120 days | Lanes with stock and no sales in window | Stock-out lanes (zero stock, sales in window) | Stock-out share | Lost units per day (proxy) | Lost USD per day (proxy) | Lost USD a year if it persisted | Stock units (replen) | Units on SKUs with no sale in 90 days |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| U.S. Polo Assn. | 2370 | 3374 | 49% | 22% | 2138 | 1529 | 45% | 93 | 3,276 | 1.20M | 32,670 | 19% |
| French Connection | 2922 | 1359 | 40% | 24% | 3778 | 532 | 39% | 24 | 879 | 321k | 20,026 | 36% |
| Campus | 1596 | 2154 | 41% | 21% | 2151 | 850 | 40% | 33 | 786 | 287k | 16,318 | 14% |
| Penti | 2484 | 1783 | 49% | 16% | 3620 | 829 | 46% | 32 | 545 | 199k | 15,778 | 38% |
| Keds | 1055 | 623 | 59% | 7% | 1370 | 360 | 58% | 11 | 336 | 123k | 12,359 | 77% |
| Vero Moda | 1986 | 568 | 65% | 6% | 1835 | 369 | 65% | 12 | 217 | 79k | 7,023 | 84% |
| Puma | 475 | 307 | 73% | 10% | 289 | 215 | 70% | 11 | 400 | 146k | 1,217 | 38% |
| Nautica | 274 | 250 | 89% | 2% | 47 | 212 | 85% | 7 | 54 | 20k | 143 | 22% |
| Cardio Bunny | 505 | 680 | 30% | 31% | 918 | 180 | 26% | 10 | 172 | 63k | 7,404 | 15% |
| Softline total | 13667 | 11098 | 48% | 19% | 16146 | 5076 | 46% | 233 | 6,666 | 2.43M | 112,938 | 34% |

Split of the stock-out proxy (query R1b), USD a day: U.S. Polo Assn. 3,276 (of which 2,179 on SKUs with stock in
another location; 1,112 from locations selling 0.2 units a day or more), French Connection 879 (442; 90), Campus 786
(602; 27), Penti 545 (341; 17), Puma 400 (145; 94), Keds 336 (269; 0), Vero Moda 217 (98; 0), Cardio Bunny 172
(117; 28), Nautica 54 (6; 8). Softline total 6,666 (4,198; 1,376).

The softline replenishment run holds 112.9k units; `unified_inventory` holds 124.8k softline units because it
also counts Centrepoint and Amazon stock, which the run does not plan.

## Ageing (proxy, first in first out)

| Brand | Stock units | 0-90 days | 91-180 days | Over 180 days | Age unknown | Value at ASP | Value over 90 days | Value over 180 days | Value age unknown |
|---|---|---|---|---|---|---|---|---|---|
| U.S. Polo Assn. | 40,264 | 0 | 4,522 | 27,006 | 8,736 | 1.66M | 1.33M (80%) | 1.13M (68%) | 324k (20%) |
| French Connection | 20,418 | 1,745 | 671 | 17,541 | 461 | 755k | 667k (88%) | 642k (85%) | 17k (2%) |
| Campus | 16,330 | 8,353 | 2,758 | 4,665 | 554 | 429k | 184k (43%) | 114k (26%) | 14k (3%) |
| Penti | 16,729 | 2,005 | 11,861 | 2,748 | 115 | 339k | 297k (88%) | 48k (14%) | 2k (1%) |
| Keds | 12,359 | 774 | 570 | 2,520 | 8,495 | 523k | 132k (25%) | 107k (20%) | 360k (69%) |
| Vero Moda | 6,749 | 2,169 | 0 | 1,314 | 3,266 | 198k | 30k (15%) | 30k (15%) | 101k (51%) |
| Puma | 4,018 | 0 | 0 | 1,960 | 2,058 | 151k | 73k (48%) | 73k (48%) | 78k (52%) |
| Nautica | 143 | 0 | 0 | 143 | 0 | 2k | 2k (100%) | 2k (100%) | 0 (0%) |
| Cardio Bunny | 7,752 | 0 | 6,247 | 1,471 | 34 | 161k | 161k (100%) | 32k (20%) | 769 (0%) |
| Nutricook | 7,010 | 1,217 | 964 | 3,484 | 1,345 | 543k | 254k (47%) | 169k (31%) | 79k (14%) |
| GTPlayer | 1,901 | 1,722 | 89 | 57 | 33 | 274k | 20k (7%) | 9k (3%) | 4k (1%) |
| NutriBullet | 5,811 | 0 | 2,402 | 3,409 | 0 | 353k | 353k (100%) | 221k (62%) | 0 (0%) |
| Carote | 5,946 | 118 | 4,588 | 1,240 | 0 | 644k | 631k (98%) | 72k (11%) | 0 (0%) |
| Bergner | 6,825 | 5,911 | 741 | 173 | 0 | 302k | 34k (11%) | 11k (4%) | 0 (0%) |
| Tower | 1,863 | 5 | 1,858 | 0 | 0 | 51k | 51k (100%) | 0 (0%) | 0 (0%) |
| Qubo | 807 | 210 | 0 | 597 | 0 | 47k | 30k (63%) | 30k (63%) | 0 (0%) |
| Nuwey | 149 | 0 | 1 | 0 | 148 | 7k | 46 (1%) | 0 (0%) | 7k (99%) |
| GCC total | 155,757 | 24,229 | 37,272 | 68,328 | 25,928 | 6.49M | 4.25M (66%) | 2.69M (41%) | 1.04M (16%) |

## Returns

- Return rate by value (TTM, all channels, from the summary table): softline 13%; Vero Moda 33%, French Connection
  28%, Keds 27%, Cardio Bunny 20%, Nautica 18%, Campus 15%, U.S. Polo Assn. 11%, Puma 8%, Penti 7%.
- Namshi return reasons (DD9 method, query RT1): 161,309 softline order lines worth USD 6.01M; 24,755 lines carry a
  reason (USD 946k); 17,678 of them are size or fit (USD 682k, 71% of lines with a reason). By brand, size or fit
  USD: U.S. Polo Assn. 388k, French Connection 127k, Campus 68k, Keds 30k, Vero Moda 24k, Penti 19k, Cardio Bunny
  14k, Nautica 14k. Noon carries almost no reasons (DD9).

## Lead time

No usable GCC lead time exists in the warehouse today:
- `brand_intelligence.brand_inbound_lead_time_sku` and its stats view, and the copies in `internal_brand_dashboard`,
  hold India purchase orders only (BSB, Cortina, Hasbro, UCB, Belkin, Hamleys, Miniso), median 3 to 24 days from PO
  approval to first receipt.
- GCC warehouse receipts (Unicommerce, June to October 2026, 86 vendor POs) show a median of 1 day and a 90th
  percentile of 7 days from PO date to first receipt (query L1). The PO is raised when goods arrive, so this is
  paperwork time, not supplier lead time. `itd_grn_fin` shows the same (0 to 4 days on average).
- Forecasting will need supplier lead times from the brand or buying team (ex-factory, transit, customs), per brand
  and origin. This is a data gap to close before replenishment advice can be time-phased.

## AOP target against actual

`brand_intelligence.aop_monthly_target` has GCC targets for June and July 2026 (market GCC) and August 2026 (UAE and
KSA split) only. Totals June to August 2026 (query T1):

| AOP brand | Target USD | Actual gross USD | Actual net USD | Gross / target | Net / target |
|---|---|---|---|---|---|
| Nutri | 1,155,000 | 943,911 | 943,884 | 0.82 | 0.82 |
| USPA | 1,039,001 | 1,840,798 | 1,583,538 | 1.77 | 1.52 |
| GTPlayer | 540,595 | 527,781 | 523,172 | 0.98 | 0.97 |
| Carote | 255,000 | 199,849 | 195,704 | 0.78 | 0.77 |
| Alchemy | 200,000 | - | - | - | - |
| Campus | 199,000 | 236,896 | 192,643 | 1.19 | 0.97 |
| Bergner | 153,000 | 85,908 | 84,409 | 0.56 | 0.55 |
| Penti | 137,000 | 106,235 | 96,565 | 0.78 | 0.7 |
| French Connection | 71,600 | 233,739 | 174,805 | 3.26 | 2.44 |
| SAMACO | 50,000 | - | - | - | - |
| Vero Moda | 30,000 | 47,800 | 33,913 | 1.59 | 1.13 |
| Cardio Bunny | 25,750 | 41,614 | 32,113 | 1.62 | 1.25 |
| Keds | 23,000 | 52,926 | 37,769 | 2.3 | 1.64 |
| Puma | 20,500 | 44,521 | 40,405 | 2.17 | 1.97 |
| Tower | 15,500 | 7,970 | 7,692 | 0.51 | 0.5 |
| Nautica | 12,000 | 14,978 | 11,161 | 1.25 | 0.93 |
| Qubo | 8,000 | 1,041 | 1,041 | 0.13 | 0.13 |
| Dowinx | 0 | 1,705 | 1,705 | - | - |
| Flexispot | 0 | - | - | - | - |
| Anta | 0 | - | - | - | - |
| Nuwey | - | 688 | 688 | - | - |
| Total | 3,934,946 | 4,391,923 | 3,964,770 | 1.12 | 1.01 |

The target's basis (gross or net, with or without VAT, tertiary or secondary sales) is not stated in the table, so
the ratio is indicative only. Alchemy, SAMACO, Flexispot and Anta have targets but no GCC sales rows yet.

## Cardio Bunny deep cut

Launched on Namshi in mid-March 2026, so the TTM is about 7 months. TTM gross USD 92.6k, 4,540 units, 466 SKUs and 119
styles sold, return rate 20% of value.

Category mix (TTM gross, query CB1):

| Category | Gross USD | Share | Units | Return rate (value) | SKUs sold | Styles |
|---|---|---|---|---|---|---|
| Sweatshirt | 20,888 | 23% | 1,013 | 26% | 162 | 41 |
| T-shirt | 19,746 | 21% | 1,356 | 14% | 147 | 35 |
| Leggings | 17,441 | 19% | 697 | 21% | 40 | 12 |
| Sweatpants | 10,229 | 11% | 334 | 22% | 24 | 6 |
| Tops | 9,591 | 10% | 489 | 20% | 30 | 8 |
| Sports shorts | 9,253 | 10% | 392 | 19% | 42 | 11 |
| Sports bra | 2,947 | 3% | 164 | 21% | 13 | 4 |
| Jacket | 1,160 | 1% | 35 | 26% | 4 | 1 |
| Skirt | 1,105 | 1% | 42 | 13% | 4 | 1 |
| Total | 92,552 | 100% | 4,540 | 20% | 466 | 119 |

Channel mix: Namshi 86% (USD 79.9k), Styli 8% (7.1k), Noon 3% (2.9k), the rest Centrepoint, 6thStreet, Amazon and
Trendyol.

Stock, sell-through and age by category (replenishment run 2026-10-25 plus first-in-first-out age, query CB2):

| Category | SKUs | Units on hand | Units sold last 90 days | Sell-through 90d | Units on SKUs with no sale in 90 days | Stock-out SKU-locations / selling SKU-locations | Units over 90 days | Units over 180 days |
|---|---|---|---|---|---|---|---|---|
| Sweatshirt | 188 | 2,715 | 939 | 26% | 534 | 31 / 179 | 2,711 | 363 |
| T-shirt | 160 | 2,231 | 973 | 30% | 329 | 57 / 238 | 2,230 | 135 |
| Sports shorts | 43 | 884 | 223 | 20% | 33 | 13 / 63 | 884 | 230 |
| Leggings | 42 | 584 | 402 | 41% | 77 | 33 / 72 | 584 | 171 |
| Tops | 30 | 294 | 271 | 48% | 4 | 31 / 59 | 294 | 251 |
| Sweatpants | 21 | 265 | 123 | 32% | 23 | 9 / 38 | 265 | 73 |
| Sports bra | 13 | 227 | 100 | 31% | 98 | 4 / 15 | 227 | 94 |
| Jacket | 4 | 110 | 23 | 17% | 0 | 1 / 8 | 110 | 0 |
| Skirt | 4 | 94 | 22 | 19% | 0 | 0 / 8 | 94 | 0 |
| Total | 505 | 7,404 | 3,076 | 29% | 1,098 | 180 / 680 | 7,399 | 1,317 |

Reading:
- At the last 90 days' pace (about 34 units a day) the 7,404 units are about 217 days (7 months) of cover. Stock
  value is about USD 132k at selling price (USD 98k on the 383 SKUs that have a selling price of their own).
- Tops and leggings sell through fastest (48% and 41%) and run out most often (31 of 59 and 33 of 72 selling
  SKU-locations at zero). Sweatshirts hold the most stock (2,715 units) at 26% sell-through going into the cooler
  months, which is the season sweatshirts should sell in.
- All stock arrived between February and July 2026, so almost every unit is over 90 days since receipt; 18% is over
  180 days (the first shipments).

Scout rating and review coverage on Namshi (latest observation per listing, last 30 days, query CB3):

| Brand | Listings seen | With a rating | With any review | Average rating | Total reviews |
|---|---|---|---|---|---|
| Cardio Bunny | 91 (54 AE, 37 SA) | 0 (0%) | 0 (0%) | - | 0 |
| U.S. Polo Assn. | 7,012 | 3,079 (44%) | 3,079 (44%) | 4.78 | 10,034 |
| Penti | 217 | 37 (17%) | 37 (17%) | 4.81 | 44 |
| Campus | 544 | 82 (15%) | 82 (15%) | 4.87 | 96 |
| French Connection | 457 | 24 (5%) | 24 (5%) | 4.96 | 26 |
| Vero Moda | 350 | 7 (2%) | 7 (2%) | 5.00 | 7 |
| Keds | 83 | 0 (0%) | 0 (0%) | - | 0 |

Scout sees 91 Cardio Bunny Namshi listings against 119 options in the master. None carries a rating or a review, so
review text cannot yet feed NPD insight for Cardio Bunny; return reasons (USD 14k size or fit on Namshi) are the
only customer voice in the data. Scout's Noon pages carry no brand field, so Noon coverage could not be measured.

## Caveats

1. **Short and uneven history.** U.S. Polo Assn. data starts 2024-10-29; most other brands start between June 2025
   and August 2026. Seasonality for most brands is one cycle or none. A forecasting product must pool seasonality
   across brands and categories rather than learn it brand by brand.
2. **Growth curve against seasonality.** Most visible growth comes from new channels (Namshi KSA September 2025, Noon
   KSA October 2025, Styli and Centrepoint pipelines in 2026), brand launches and new styles. These steps sit on top
   of Ramadan and White Friday peaks and are easy to mistake for seasonal lift or for demand growth. Year-on-year
   comparisons are valid only for U.S. Polo Assn. and Nautica, and even U.S. Polo Assn.'s +188% Q3 unit growth is
   mostly the KSA launch. Any baseline forecast must model launch ramps separately from seasonality.
3. **Revenue measure changed on 2026-08-01.** Sales before that date for the softline brands come from the 3PL feed
   (`itd_sale`); from that date they come from the channel feeds. Units per day are continuous across the switch but
   USD per unit jumps 13% to 22% for U.S. Polo Assn., French Connection, Campus and Penti. Revenue growth across that
   date is overstated; this document uses units for growth.
4. **Sales data lag.** Namshi rows end on 2026-10-19 and some channels on 2026-10-21, so the last days of the TTM and
   October 2026 are slightly low.
5. **Ageing is a proxy.** It assumes first in first out and relies on receipt SKU codes matching stock SKU codes.
   U.S. Polo Assn. receipts from its new supplier (about 12k units, June to September 2026) use different SKU codes
   from the stock, so U.S. Polo Assn. stock looks older than it is (0 units under 90 days is not credible). Keds,
   Vero Moda and Puma have 50% to 70% of value with unknown age. Treat the GCC total (66% over 90 days, 41% over 180
   days) as an upper bound.
6. **Stock value is at selling price incl VAT, not cost.** GRN values in `itd_grn_fin` do not give a usable unit cost
   (they convert to well under USD 1 a unit). The replenishment table's own `stock_value` field sums to AED 7.36M
   (about USD 2.0M) for softline against USD 3.3M at selling price; its basis is not documented.
7. **Stock-out proxy is an upper bound.** It counts every SKU-location with any sale in the run's window. 63% of the
   value sits on SKUs with stock elsewhere, where some demand is served from another location. Restricting to
   locations selling at least 0.2 units a day gives USD 1.4k a day, a sensible lower anchor.
8. **Hardline returns and cancellations are under-reported** (1P sell-out and manual files carry none), so the GCC
   net revenue is overstated on the hardline side.
9. **The replenishment run covers softline only.** Hardline cover and stock-outs are not in it; hardline stock comes
   only from `unified_inventory`.
10. **Lead time and GCC ageing tables named in the brief hold India data only** (`inventory_ageing`,
    `brand_inbound_lead_time_sku`, `_stats`). GCC equivalents had to be built from raw receipts (ageing) or are not
    possible (lead time).
11. **AOP coverage is three months** (June to August 2026), with an unstated revenue basis.
12. **Scout's Namshi feed starts 2026-08-21**, and a zero rating count could be a scrape gap rather than a true
    absence; Keds also shows zero. A spot check of a few Cardio Bunny pages would settle it.

## Appendix: SQL

All queries ran with `bq query --use_legacy_sql=false --project_id=opptra-datawarehouse
--maximum_bytes_billed=2000000000` and `CLOUDSDK_CORE_PROJECT=opptra-datawarehouse` set per command. Queries are
shown in full, including the shared brand-name block.

### S1. Brand summary (TTM, history, growth, SKU counts)

```sql
-- S1 brand summary from unified_sales_tertiary_v2
WITH base AS (
  SELECT
    CASE
      WHEN UPPER(b) LIKE '%POLO%' OR UPPER(b)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(b) LIKE 'PENTI%' THEN 'Penti'
      WHEN UPPER(b) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(b) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(b) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook'
      WHEN UPPER(b)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(b)='GTPLAYER' THEN 'GTPlayer'
      WHEN UPPER(b)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(REPLACE(b,'_',' '))='VERO MODA' THEN 'Vero Moda'
      ELSE INITCAP(b) END AS brand,
    s.*
  FROM (SELECT COALESCE(NULLIF(TRIM(mapped_brand),''), source_brand) b, * FROM `opptra-datawarehouse.fact_gcc.unified_sales_tertiary_v2`) s
),
f AS (SELECT brand, MIN(ordered_date) first_sale, MAX(ordered_date) last_sale FROM base WHERE event_type='sale' AND revenue_usd>0 GROUP BY 1)
SELECT b.brand, f.first_sale, f.last_sale,
  DATE_DIFF(f.last_sale, f.first_sale, MONTH)+1 months_hist,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2025-10-22' AND '2026-10-21', revenue_usd,0))) ttm_gross_usd,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2025-10-22' AND '2026-10-21', ordered_units,0))) ttm_units,
  ROUND(SUM(IF(ordered_date BETWEEN '2025-10-22' AND '2026-10-21', revenue_usd,0))) ttm_net_usd,
  ROUND(-SUM(IF(event_type='reversal' AND final_status='returned' AND ordered_date BETWEEN '2025-10-22' AND '2026-10-21', revenue_usd,0))) ttm_returned_usd,
  ROUND(-SUM(IF(event_type='reversal' AND final_status='cancelled' AND ordered_date BETWEEN '2025-10-22' AND '2026-10-21', revenue_usd,0))) ttm_cancelled_usd,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2026-04-22' AND '2026-10-21', revenue_usd,0))) l6m_usd,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2025-10-22' AND '2026-04-21', revenue_usd,0))) p6m_usd,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2026-07-01' AND '2026-09-30', revenue_usd,0))) q3_26,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2025-07-01' AND '2025-09-30', revenue_usd,0))) q3_25,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2024-10-29' AND '2025-10-21', revenue_usd,0))) prior_ttm_usd,
  COUNT(DISTINCT IF(event_type='sale' AND ordered_date BETWEEN '2025-10-22' AND '2026-10-21', mapped_opptra_sku, NULL)) skus_sold_ttm,
  COUNT(DISTINCT IF(event_type='sale' AND ordered_date BETWEEN '2026-07-24' AND '2026-10-21', mapped_opptra_sku, NULL)) skus_sold_90d,
  COUNT(DISTINCT IF(event_type='sale' AND ordered_date BETWEEN '2025-10-22' AND '2026-10-21', style_id, NULL)) styles_sold_ttm,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2026-07-24' AND '2026-10-21', ordered_units,0))) units_90d,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2026-04-22' AND '2026-10-21', ordered_units,0))) l6m_units,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2025-10-22' AND '2026-04-21', ordered_units,0))) p6m_units,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2026-07-01' AND '2026-09-30', ordered_units,0))) q3_26_units,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2025-07-01' AND '2025-09-30', ordered_units,0))) q3_25_units,
  ROUND(SUM(IF(event_type='sale' AND ordered_date BETWEEN '2024-10-29' AND '2025-10-21', ordered_units,0))) prior_ttm_units
FROM base b JOIN f USING (brand)
GROUP BY 1,2,3 ORDER BY ttm_gross_usd DESC
```

### S2. Monthly gross revenue by brand

```sql
-- S2 monthly gross revenue (sale events, USD incl VAT) per brand, last 13 calendar months, plus an all-brand row per month.
-- Softline and hardline totals in the document are sums of the brand rows.
WITH base AS (
  SELECT
    CASE
      WHEN UPPER(b) LIKE '%POLO%' OR UPPER(b)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(b) LIKE 'PENTI%' THEN 'Penti'
      WHEN UPPER(b) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(b) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(b) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook'
      WHEN UPPER(b)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(b)='GTPLAYER' THEN 'GTPlayer'
      WHEN UPPER(b)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(REPLACE(b,'_',' '))='VERO MODA' THEN 'Vero Moda'
      ELSE INITCAP(b) END AS brand,
    s.*
  FROM (SELECT COALESCE(NULLIF(TRIM(mapped_brand),''), source_brand) b, * FROM `opptra-datawarehouse.fact_gcc.unified_sales_tertiary_v2`) s
),
seg AS (SELECT *, IF(brand IN ('U.S. Polo Assn.','French Connection','Campus','Penti','Keds','Vero Moda','Puma','Nautica','Cardio Bunny','Only'),'Softline','Hardline') segment FROM base)
SELECT brand, segment, FORMAT_DATE('%Y-%m', ordered_date) month, ROUND(SUM(revenue_usd)) gross_usd, ROUND(SUM(ordered_units)) units
FROM seg WHERE event_type='sale' AND ordered_date BETWEEN '2025-10-01' AND '2026-10-21'
GROUP BY GROUPING SETS ((segment, brand, month), (month)) ORDER BY 1,2,3
```

### S3. Seasonal event uplift

```sql
-- S3 seasonal event uplift: average daily gross revenue in the event window vs the 28 days before and the 28 days after
WITH base AS (
  SELECT
    CASE
      WHEN UPPER(b) LIKE '%POLO%' OR UPPER(b)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(b) LIKE 'PENTI%' THEN 'Penti'
      WHEN UPPER(b) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(b) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(b) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook'
      WHEN UPPER(b)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(b)='GTPLAYER' THEN 'GTPlayer'
      WHEN UPPER(b)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(REPLACE(b,'_',' '))='VERO MODA' THEN 'Vero Moda'
      ELSE INITCAP(b) END AS brand,
    s.*
  FROM (SELECT COALESCE(NULLIF(TRIM(mapped_brand),''), source_brand) b, * FROM `opptra-datawarehouse.fact_gcc.unified_sales_tertiary_v2`) s
),
seg AS (SELECT *, IF(brand IN ('U.S. Polo Assn.','French Connection','Campus','Penti','Keds','Vero Moda','Puma','Nautica','Cardio Bunny','Only'),'Softline','Hardline') segment FROM base),
ev AS (
  SELECT 'Ramadan 2025' ev, DATE '2025-03-01' s, DATE '2025-03-29' e UNION ALL
  SELECT 'Ramadan 2026', DATE '2026-02-18', DATE '2026-03-19' UNION ALL
  SELECT 'White Friday 2025', DATE '2025-11-20', DATE '2025-12-02' UNION ALL
  SELECT '11.11 2025', DATE '2025-11-09', DATE '2025-11-12'
),
d0 AS (SELECT brand br, segment sg, ordered_date, SUM(revenue_usd) usd FROM seg WHERE event_type='sale' GROUP BY GROUPING SETS ((segment, brand, ordered_date), (segment, ordered_date), (ordered_date))),
d AS (SELECT IFNULL(br,'ALL') brand, IFNULL(sg,'ALL') segment, ordered_date, usd FROM d0),
fs AS (SELECT brand, segment, MIN(ordered_date) first_sale FROM d WHERE usd>0 GROUP BY 1,2)
SELECT ev.ev AS event_name, d.brand, d.segment, fs.first_sale,
  ROUND(SUM(IF(d.ordered_date BETWEEN ev.s AND ev.e, usd,0))/(DATE_DIFF(ev.e,ev.s,DAY)+1)) ev_daily,
  ROUND(SUM(IF(d.ordered_date BETWEEN DATE_SUB(ev.s, INTERVAL 28 DAY) AND DATE_SUB(ev.s, INTERVAL 1 DAY), usd,0))/28) pre_daily,
  ROUND(SUM(IF(d.ordered_date BETWEEN DATE_ADD(ev.e, INTERVAL 1 DAY) AND DATE_ADD(ev.e, INTERVAL 28 DAY), usd,0))/28) post_daily,
  ROUND(SUM(IF(d.ordered_date BETWEEN ev.s AND ev.e, usd,0))) ev_total,
  fs.first_sale <= DATE_SUB(ev.s, INTERVAL 28 DAY) covered
FROM ev CROSS JOIN d JOIN fs USING (brand, segment)
WHERE d.ordered_date BETWEEN DATE_SUB(ev.s, INTERVAL 28 DAY) AND DATE_ADD(ev.e, INTERVAL 28 DAY)
GROUP BY event_name, d.brand, d.segment, fs.first_sale, ev.s, ev.e ORDER BY 1,2
```

### S3b. Weekly revenue series

```sql
-- S3b weekly gross revenue (weeks start Monday) for USPA, softline, hardline and all, to see peak shape
WITH base AS (
  SELECT
    CASE
      WHEN UPPER(b) LIKE '%POLO%' OR UPPER(b)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(b) LIKE 'PENTI%' THEN 'Penti'
      WHEN UPPER(b) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(b) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(b) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook'
      WHEN UPPER(b)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(b)='GTPLAYER' THEN 'GTPlayer'
      WHEN UPPER(b)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(REPLACE(b,'_',' '))='VERO MODA' THEN 'Vero Moda'
      ELSE INITCAP(b) END AS brand,
    s.*
  FROM (SELECT COALESCE(NULLIF(TRIM(mapped_brand),''), source_brand) b, * FROM `opptra-datawarehouse.fact_gcc.unified_sales_tertiary_v2`) s
),
seg AS (SELECT *, IF(brand IN ('U.S. Polo Assn.','French Connection','Campus','Penti','Keds','Vero Moda','Puma','Nautica','Cardio Bunny','Only'),'Softline','Hardline') segment FROM base)
SELECT DATE_TRUNC(ordered_date, WEEK(MONDAY)) wk,
  ROUND(SUM(IF(brand='U.S. Polo Assn.', revenue_usd, 0))) uspa,
  ROUND(SUM(IF(segment='Softline', revenue_usd, 0))) softline,
  ROUND(SUM(IF(segment='Hardline', revenue_usd, 0))) hardline,
  ROUND(SUM(revenue_usd)) all_brands
FROM seg WHERE event_type='sale' AND ordered_date BETWEEN '2025-01-06' AND '2026-10-18'
GROUP BY 1 ORDER BY 1
```

### S4. New styles or SKUs by month of first sale

```sql
-- S4 new styles (softline style_id) or new SKUs (hardline, no style_id) by month of first sale
WITH base AS (
  SELECT
    CASE
      WHEN UPPER(b) LIKE '%POLO%' OR UPPER(b)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(b) LIKE 'PENTI%' THEN 'Penti'
      WHEN UPPER(b) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(b) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(b) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook'
      WHEN UPPER(b)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(b)='GTPLAYER' THEN 'GTPlayer'
      WHEN UPPER(b)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(REPLACE(b,'_',' '))='VERO MODA' THEN 'Vero Moda'
      ELSE INITCAP(b) END AS brand,
    s.*
  FROM (SELECT COALESCE(NULLIF(TRIM(mapped_brand),''), source_brand) b, * FROM `opptra-datawarehouse.fact_gcc.unified_sales_tertiary_v2`) s
),
seg AS (SELECT *, IF(brand IN ('U.S. Polo Assn.','French Connection','Campus','Penti','Keds','Vero Moda','Puma','Nautica','Cardio Bunny','Only'),'Softline','Hardline') segment FROM base),
k AS (SELECT brand, segment, COALESCE(style_id, mapped_opptra_sku) k, MIN(ordered_date) first_sale FROM seg WHERE event_type='sale' AND revenue_usd>0 GROUP BY 1,2,3),
bf AS (SELECT brand, MIN(first_sale) brand_first FROM k GROUP BY 1)
SELECT brand, segment, FORMAT_DATE('%Y-%m', first_sale) month, COUNT(*) new_keys, DATE_DIFF(first_sale, brand_first, DAY) < 60 AS in_first_60_days
FROM k JOIN bf USING (brand) WHERE first_sale >= '2025-10-01'
GROUP BY 1,2,3,5 ORDER BY 1,3
```

### C1. Catalogue size

```sql
-- C1 catalogue size per brand: SKUs and options in the P2P item master (GCC entities, latest snapshot),
-- internal SKU codes differ per legal entity, so the largest entity count is used; softline options in master_sl, and distinct Opptra SKUs in unified_sku_master_gcc
WITH nb AS (SELECT 1),
p2p0 AS (
  SELECT CASE WHEN UPPER(brand_name) LIKE '%POLO%' OR UPPER(brand_name)='USPA' THEN 'U.S. Polo Assn.' WHEN UPPER(brand_name)='NUTRI' THEN 'Nutri (Nutricook + NutriBullet)' ELSE INITCAP(brand_name) END brand,
    entity_name, COUNT(DISTINCT internal_sku) p2p_skus, COUNT(DISTINCT NULLIF(option_id,'')) p2p_options
  FROM `opptra-datawarehouse.dimensions.sku_master_p2p`
  WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM `opptra-datawarehouse.dimensions.sku_master_p2p`)
    AND entity_name IN ('Company Oppdoor','Oppdoor General Trading LLC.','Oppdoor Solutions FZE')
  GROUP BY 1,2),
p2p AS (SELECT brand, MAX(p2p_skus) p2p_skus, MAX(p2p_options) p2p_options FROM p2p0 GROUP BY 1),
msl AS (
  SELECT CASE WHEN UPPER(brand) LIKE 'PENTI%' THEN 'Penti' WHEN UPPER(brand) LIKE 'NAUTICA%' THEN 'Nautica' WHEN UPPER(brand) LIKE '%POLO%' THEN 'U.S. Polo Assn.'
      WHEN UPPER(brand) = 'FRENCH CONNECTION UK' THEN 'French Connection' ELSE INITCAP(brand) END brand,
    COUNT(DISTINCT ean) msl_skus, COUNT(DISTINCT NULLIF(TRIM(option_id_style_color),'')) msl_options
  FROM `opptra-datawarehouse.raw_gcc_dimensions.master_sl` GROUP BY 1),
usm AS (
  SELECT CASE WHEN UPPER(brand) LIKE '%POLO%' OR UPPER(brand)='USPA' THEN 'U.S. Polo Assn.' WHEN UPPER(brand) LIKE 'PENTI%' THEN 'Penti' WHEN UPPER(brand) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(brand) LIKE 'FRENCH CONNECTION%' THEN 'French Connection' WHEN UPPER(brand) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook' ELSE INITCAP(brand) END brand,
    COUNT(DISTINCT opptra_sku) usm_skus
  FROM `opptra-datawarehouse.dimensions.unified_sku_master_gcc` GROUP BY 1)
SELECT COALESCE(p2p.brand, msl.brand, usm.brand) brand, p2p_skus, p2p_options, msl_skus, msl_options, usm_skus
FROM p2p FULL JOIN msl USING (brand) FULL JOIN usm USING (brand) ORDER BY usm_skus DESC
```

### I1. Stock units and value, sell-through inputs

```sql
-- I1 current stock (latest snapshot of every unified_inventory source), value at the SKU's TTM average selling price,
-- and a 90-day sell-through proxy = units sold in the last 90 days / (units sold in the last 90 days + units on hand now)
WITH base AS (
  SELECT
    CASE
      WHEN UPPER(b) LIKE '%POLO%' OR UPPER(b)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(b) LIKE 'PENTI%' THEN 'Penti'
      WHEN UPPER(b) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(b) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(b) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook'
      WHEN UPPER(b)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(b)='GTPLAYER' THEN 'GTPlayer'
      WHEN UPPER(b)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(REPLACE(b,'_',' '))='VERO MODA' THEN 'Vero Moda'
      ELSE INITCAP(b) END AS brand,
    s.*
  FROM (SELECT COALESCE(NULLIF(TRIM(mapped_brand),''), source_brand) b, * FROM `opptra-datawarehouse.fact_gcc.unified_sales_tertiary_v2`) s
),
seg AS (SELECT *, IF(brand IN ('U.S. Polo Assn.','French Connection','Campus','Penti','Keds','Vero Moda','Puma','Nautica','Cardio Bunny','Only'),'Softline','Hardline') segment FROM base),
asp AS (
  SELECT mapped_opptra_sku sku, brand, SUM(revenue_usd)/NULLIF(SUM(ordered_units),0) asp_usd,
    SUM(IF(ordered_date BETWEEN '2026-07-24' AND '2026-10-21', ordered_units, 0)) u90
  FROM seg WHERE event_type='sale' AND ordered_date BETWEEN '2025-10-22' AND '2026-10-21' AND revenue_usd>0 GROUP BY 1,2
),
basp AS (SELECT brand, SUM(asp_usd*u90)/NULLIF(SUM(u90),0) b_asp, SUM(u90) b_u90 FROM asp GROUP BY 1),
inv0 AS (
  SELECT i.* FROM `opptra-datawarehouse.fact_gcc.unified_inventory` i
  JOIN (SELECT source_table, MAX(snapshot_date) mx FROM `opptra-datawarehouse.fact_gcc.unified_inventory` GROUP BY 1) m
    ON m.source_table=i.source_table AND m.mx=i.snapshot_date
  WHERE UPPER(IFNULL(i.brand,'')) NOT IN ('TEST','1','')
),
inv AS (
  SELECT CASE
      WHEN UPPER(brand) LIKE '%POLO%' OR UPPER(brand)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(brand) LIKE 'PENTI%' THEN 'Penti' WHEN UPPER(brand) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(brand) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(brand) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook' WHEN UPPER(brand)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(brand)='GTPLAYER' THEN 'GTPlayer' WHEN UPPER(brand)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(brand)='VERO MODA' THEN 'Vero Moda' ELSE INITCAP(brand) END brand_n,
    opptra_sku_child sku, inventory_holder, IFNULL(sellable_quantity,0) q
  FROM inv0
)
SELECT IFNULL(inv.brand_n,'ALL') brand,
  ROUND(SUM(q)) units_on_hand,
  ROUND(SUM(IF(inventory_holder='opptra', q, 0))) units_own_wh,
  ROUND(SUM(IF(inventory_holder<>'opptra', q, 0))) units_at_channel,
  ROUND(SUM(q*COALESCE(asp.asp_usd, basp.b_asp))) value_usd_at_asp,
  ROUND(SUM(IF(asp.sku IS NOT NULL, q, 0))/NULLIF(SUM(q),0),3) share_units_sku_matched,
  ANY_VALUE(basp.b_u90) units_sold_90d
FROM inv LEFT JOIN asp ON asp.sku=inv.sku AND asp.brand=inv.brand_n LEFT JOIN basp ON basp.brand=inv.brand_n
GROUP BY ROLLUP(inv.brand_n) ORDER BY value_usd_at_asp DESC
```

### A1. Ageing proxy (first in first out)

```sql
-- A1 GCC ageing proxy (first in, first out). Current units on hand per SKU (all unified_inventory sources, latest snapshot)
-- are assigned to that SKU's most recent vendor receipts into the GCC (itd_grn_fin plus vendor GRNs in the four Unicommerce warehouses), newest first.
-- Age of a unit = 2026-10-22 minus the receipt date it is assigned to. Units with no receipt left to assign are "age unknown".
WITH base AS (
  SELECT
    CASE
      WHEN UPPER(b) LIKE '%POLO%' OR UPPER(b)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(b) LIKE 'PENTI%' THEN 'Penti'
      WHEN UPPER(b) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(b) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(b) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook'
      WHEN UPPER(b)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(b)='GTPLAYER' THEN 'GTPlayer'
      WHEN UPPER(b)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(REPLACE(b,'_',' '))='VERO MODA' THEN 'Vero Moda'
      ELSE INITCAP(b) END AS brand,
    s.*
  FROM (SELECT COALESCE(NULLIF(TRIM(mapped_brand),''), source_brand) b, * FROM `opptra-datawarehouse.fact_gcc.unified_sales_tertiary_v2`) s
),
seg AS (SELECT *, IF(brand IN ('U.S. Polo Assn.','French Connection','Campus','Penti','Keds','Vero Moda','Puma','Nautica','Cardio Bunny','Only'),'Softline','Hardline') segment FROM base),
asp AS (
  SELECT mapped_opptra_sku sku, brand, SUM(revenue_usd)/NULLIF(SUM(ordered_units),0) asp_usd, SUM(ordered_units) u
  FROM seg WHERE event_type='sale' AND ordered_date BETWEEN '2025-10-22' AND '2026-10-21' AND revenue_usd>0 GROUP BY 1,2
),
basp AS (SELECT brand, SUM(asp_usd*u)/NULLIF(SUM(u),0) b_asp FROM asp GROUP BY 1),
inv0 AS (
  SELECT i.* FROM `opptra-datawarehouse.fact_gcc.unified_inventory` i
  JOIN (SELECT source_table, MAX(snapshot_date) mx FROM `opptra-datawarehouse.fact_gcc.unified_inventory` GROUP BY 1) m
    ON m.source_table=i.source_table AND m.mx=i.snapshot_date
  WHERE UPPER(IFNULL(i.brand,'')) NOT IN ('TEST','1','')
),
nb AS (SELECT b, CASE
      WHEN UPPER(b) LIKE '%POLO%' OR UPPER(b)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(b) LIKE 'PENTI%' THEN 'Penti' WHEN UPPER(b) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(b) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(b) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook' WHEN UPPER(b)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(b)='GTPLAYER' THEN 'GTPlayer' WHEN UPPER(b)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(b)='VERO MODA' THEN 'Vero Moda' ELSE INITCAP(b) END brand_n
  FROM (SELECT DISTINCT brand b FROM inv0 UNION DISTINCT SELECT DISTINCT brand FROM `opptra-datawarehouse.raw_gcc_table_cleaned.itd_grn_fin`)),
oh AS (SELECT nb.brand_n, opptra_sku_child sku, SUM(IFNULL(sellable_quantity,0)) q FROM inv0 JOIN nb ON nb.b=inv0.brand GROUP BY 1,2 HAVING q>0),
g AS (
  SELECT sku, grn_date, SUM(q) q, 0.0 unit_cost_aed FROM (
    SELECT item_skucode sku, grn_date, CAST(quantity_received AS FLOAT64) q
    FROM `opptra-datawarehouse.raw_gcc_table_cleaned.itd_grn_fin`
    UNION ALL
    SELECT item_skucode, grn_date_date, quantity_received FROM (
      SELECT item_skucode, grn_date_date, quantity_received, vendor_name FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_fze_uae`
      UNION ALL SELECT item_skucode, grn_date_date, quantity_received, vendor_name FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_rfs_uae`
      UNION ALL SELECT item_skucode, grn_date_date, quantity_received, vendor_name FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_sls_ksa`
      UNION ALL SELECT item_skucode, grn_date_date, quantity_received, vendor_name FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_stl_ksa`)
    -- vendor receipts only: transfers between Opptra entities, channel withdrawals and test rows are excluded
    WHERE NOT REGEXP_CONTAINS(LOWER(IFNULL(vendor_name,'')), r'oppdoor|noon|test|ninja|mamzorld|mumzworld|united electronics|rohan')
  ) WHERE q>0 GROUP BY 1,2
),
gc AS (SELECT g.*, SUM(q) OVER (PARTITION BY sku ORDER BY grn_date DESC ROWS UNBOUNDED PRECEDING) cum FROM g),
alloc AS (
  SELECT oh.brand_n, oh.sku, oh.q oh_q, gc.grn_date, gc.unit_cost_aed,
    GREATEST(LEAST(gc.q, oh.q - (gc.cum - gc.q)), 0) aq
  FROM oh LEFT JOIN gc ON gc.sku=oh.sku
),
sku_cost AS (SELECT DISTINCT sku FROM g),
per_sku AS (
  SELECT a.brand_n, a.sku, ANY_VALUE(oh_q) oh_q,
    SUM(IF(DATE_DIFF(DATE '2026-10-22', grn_date, DAY) <= 90, aq, 0)) q_le90,
    SUM(IF(DATE_DIFF(DATE '2026-10-22', grn_date, DAY) BETWEEN 91 AND 180, aq, 0)) q_91_180,
    SUM(IF(DATE_DIFF(DATE '2026-10-22', grn_date, DAY) > 180, aq, 0)) q_gt180,
    SUM(IFNULL(aq,0)) q_assigned
  FROM alloc a GROUP BY 1,2
)
SELECT IFNULL(p.brand_n,'ALL') brand,
  ROUND(SUM(oh_q)) units_on_hand,
  ROUND(SUM(q_le90)) units_0_90, ROUND(SUM(q_91_180)) units_91_180, ROUND(SUM(q_gt180)) units_gt180, ROUND(SUM(oh_q - q_assigned)) units_age_unknown,
  ROUND(SUM(oh_q * COALESCE(a.asp_usd, ba.b_asp))) value_usd,
  ROUND(SUM((q_91_180+q_gt180) * COALESCE(a.asp_usd, ba.b_asp))) value_gt90_usd,
  ROUND(SUM(q_gt180 * COALESCE(a.asp_usd, ba.b_asp))) value_gt180_usd,
  ROUND(SUM((oh_q - q_assigned) * COALESCE(a.asp_usd, ba.b_asp))) value_unknown_usd,
  ROUND(SUM(IF(sc.sku IS NOT NULL, oh_q, 0))/NULLIF(SUM(oh_q),0),3) share_units_with_receipts
FROM per_sku p LEFT JOIN sku_cost sc ON sc.sku=p.sku LEFT JOIN asp a ON a.sku=p.sku AND a.brand=p.brand_n LEFT JOIN basp ba ON ba.brand=p.brand_n
GROUP BY ROLLUP(p.brand_n) ORDER BY units_on_hand DESC
```

### R1. Days of cover and stock-out proxy

```sql
-- R1 softline cover, stockout proxy and stock from the latest successful replen run (channel_replen_by_sku)
-- The table holds 3 identical rows per sku_key per run; one is kept.
WITH run AS (SELECT run_id, as_of FROM `opptra-datawarehouse.fact_gcc.channel_replen_run` WHERE status='success' ORDER BY finished_at DESC LIMIT 1),
r AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.sku_key ORDER BY c.row_order) rn
    FROM `opptra-datawarehouse.fact_gcc.channel_replen_by_sku` c JOIN run USING (run_id, as_of))
  WHERE rn=1
),
b AS (
  SELECT CASE WHEN UPPER(brand) LIKE '%POLO%' OR UPPER(brand)='USPA' THEN 'U.S. Polo Assn.' WHEN UPPER(brand) LIKE 'PENTI%' THEN 'Penti'
    WHEN UPPER(brand)='CARDIO BUNNY' THEN 'Cardio Bunny' WHEN UPPER(brand) LIKE 'FRENCH CONNECTION%' THEN 'French Connection' WHEN UPPER(brand)='VERO MODA' THEN 'Vero Moda' ELSE INITCAP(brand) END brand_n, r.*,
    COALESCE(asp, AVG(asp) OVER (PARTITION BY brand)) asp_f
  FROM r
),
lanes AS (
  SELECT brand_n, sku_key, asp_f, fz_on_hand, l.lane, l.oh, l.ros, l.inc
  FROM b, UNNEST([
    STRUCT('UAE_ML' AS lane, ml_on_hand AS oh, ml_ros AS ros, ml_incoming AS inc),
    STRUCT('KSA_SLS', sls_on_hand, sls_ros, sls_incoming),
    STRUCT('NOON_UAE', noon_uae_on_hand, noon_uae_ros, noon_uae_incoming),
    STRUCT('NOON_KSA', noon_ksa_on_hand, noon_ksa_ros, noon_ksa_incoming)]) l
)
SELECT IFNULL(brand_n,'ALL') brand,
  COUNT(DISTINCT sku_key) skus,
  COUNTIF(ros>0) lane_rows_selling,
  ROUND(COUNTIF(ros>0 AND oh/ros < 14)/NULLIF(COUNTIF(ros>0),0),3) share_doc_lt14,
  ROUND(COUNTIF(ros>0 AND oh/ros > 120)/NULLIF(COUNTIF(ros>0),0),3) share_doc_gt120,
  COUNTIF(oh>0 AND IFNULL(ros,0)=0) lane_rows_stock_no_sales,
  COUNTIF(ros>0 AND oh=0) stockout_rows,
  ROUND(COUNTIF(ros>0 AND oh=0)/NULLIF(COUNTIF(ros>0),0),3) stockout_share,
  ROUND(SUM(IF(ros>0 AND oh=0, ros,0)),1) lost_units_per_day,
  ROUND(SUM(IF(ros>0 AND oh=0, ros*asp_f,0))/3.6725) lost_usd_per_day,
  COUNTIF(ros>0 AND oh=0 AND fz_on_hand>0) stockout_rows_fz_has_stock,
  ROUND(SUM(IF(ros>0 AND oh=0 AND IFNULL(inc,0)=0, ros*asp_f,0))/3.6725) lost_usd_per_day_no_incoming
FROM lanes GROUP BY ROLLUP(brand_n) ORDER BY lost_usd_per_day DESC
```

### R1b. Stock-out proxy split

```sql
-- R1b split of the R1 stock-out proxy: lanes selling at least 0.2 units a day, and whether the SKU has stock anywhere else
-- R1 softline cover, stockout proxy and stock from the latest successful replen run (channel_replen_by_sku)
-- The table holds 3 identical rows per sku_key per run; one is kept.
WITH run AS (SELECT run_id, as_of FROM `opptra-datawarehouse.fact_gcc.channel_replen_run` WHERE status='success' ORDER BY finished_at DESC LIMIT 1),
r AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.sku_key ORDER BY c.row_order) rn
    FROM `opptra-datawarehouse.fact_gcc.channel_replen_by_sku` c JOIN run USING (run_id, as_of))
  WHERE rn=1
),
b AS (
  SELECT CASE WHEN UPPER(brand) LIKE '%POLO%' OR UPPER(brand)='USPA' THEN 'U.S. Polo Assn.' WHEN UPPER(brand) LIKE 'PENTI%' THEN 'Penti'
    WHEN UPPER(brand)='CARDIO BUNNY' THEN 'Cardio Bunny' WHEN UPPER(brand) LIKE 'FRENCH CONNECTION%' THEN 'French Connection' WHEN UPPER(brand)='VERO MODA' THEN 'Vero Moda' ELSE INITCAP(brand) END brand_n, r.*,
    COALESCE(asp, AVG(asp) OVER (PARTITION BY brand)) asp_f
  FROM r
),
lanes AS (
  SELECT brand_n, sku_key, asp_f, fz_on_hand, l.lane, l.oh, l.ros, l.inc,
    IFNULL(fz_on_hand,0)+IFNULL(ml_on_hand,0)+IFNULL(sls_on_hand,0)+IFNULL(stl_on_hand,0)+IFNULL(noon_uae_on_hand,0)+IFNULL(noon_ksa_on_hand,0) oh_all
  FROM b, UNNEST([
    STRUCT('UAE_ML' AS lane, ml_on_hand AS oh, ml_ros AS ros, ml_incoming AS inc),
    STRUCT('KSA_SLS', sls_on_hand, sls_ros, sls_incoming),
    STRUCT('NOON_UAE', noon_uae_on_hand, noon_uae_ros, noon_uae_incoming),
    STRUCT('NOON_KSA', noon_ksa_on_hand, noon_ksa_ros, noon_ksa_incoming)]) l
)
SELECT IFNULL(brand_n,'ALL') brand,
  COUNTIF(ros>0 AND oh=0) stockout_rows,
  ROUND(SUM(IF(ros>0 AND oh=0, ros*asp_f,0))/3.6725) lost_usd_day_all,
  COUNTIF(ros>=0.2 AND oh=0) stockout_rows_ros_ge_02,
  ROUND(SUM(IF(ros>=0.2 AND oh=0, ros*asp_f,0))/3.6725) lost_usd_day_ros_ge_02,
  ROUND(SUM(IF(ros>0 AND oh=0 AND oh_all=0, ros*asp_f,0))/3.6725) lost_usd_day_sku_out_everywhere,
  ROUND(SUM(IF(ros>0 AND oh=0 AND oh_all>0, ros*asp_f,0))/3.6725) lost_usd_day_stock_elsewhere
FROM lanes GROUP BY ROLLUP(brand_n) ORDER BY lost_usd_day_all DESC
```

### R2. Softline stock from the replenishment run

```sql
-- R2 softline stock units and value (at average selling price) by brand, latest replen run, all locations
WITH run AS (SELECT run_id, as_of FROM `opptra-datawarehouse.fact_gcc.channel_replen_run` WHERE status='success' ORDER BY finished_at DESC LIMIT 1),
r AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.sku_key ORDER BY c.row_order) rn
    FROM `opptra-datawarehouse.fact_gcc.channel_replen_by_sku` c JOIN run USING (run_id, as_of))
  WHERE rn=1
),
b AS (
  SELECT CASE WHEN UPPER(brand) LIKE '%POLO%' OR UPPER(brand)='USPA' THEN 'U.S. Polo Assn.' WHEN UPPER(brand) LIKE 'PENTI%' THEN 'Penti'
    WHEN UPPER(brand)='CARDIO BUNNY' THEN 'Cardio Bunny' WHEN UPPER(brand) LIKE 'FRENCH CONNECTION%' THEN 'French Connection' WHEN UPPER(brand)='VERO MODA' THEN 'Vero Moda' ELSE INITCAP(brand) END brand_n, r.*,
    COALESCE(asp, AVG(asp) OVER (PARTITION BY brand)) asp_f,
    IFNULL(fz_on_hand,0)+IFNULL(ml_on_hand,0)+IFNULL(sls_on_hand,0)+IFNULL(stl_on_hand,0)+IFNULL(noon_uae_on_hand,0)+IFNULL(noon_ksa_on_hand,0) oh_all
  FROM r
)
SELECT IFNULL(brand_n,'ALL') brand, ANY_VALUE(as_of) as_of, COUNT(*) skus, COUNTIF(oh_all>0) skus_in_stock, SUM(oh_all) units_on_hand,
  SUM(fz_on_hand) fz, SUM(ml_on_hand) ml, SUM(sls_on_hand) sls, SUM(noon_uae_on_hand) noon_uae, SUM(noon_ksa_on_hand) noon_ksa,
  ROUND(SUM(oh_all*asp_f)/3.6725) value_usd_at_asp, ROUND(SUM(stock_value)) stock_value_field, COUNTIF(asp IS NULL) skus_no_asp,
  SUM(IF(last_sold IS NULL OR last_sold < DATE_SUB(as_of, INTERVAL 90 DAY), oh_all, 0)) units_no_sale_90d,
  SUM(IF(first_sold IS NOT NULL AND first_sold < DATE_SUB(as_of, INTERVAL 180 DAY), oh_all, 0)) units_first_sold_gt180d
FROM b GROUP BY ROLLUP(brand_n) ORDER BY units_on_hand DESC
```

### RT1. Namshi return reasons by brand (DD9 method)

```sql
-- RT1 Namshi return reasons by brand, DD9 method (ret.sql) reused: fact_gcc.unified_sales, TTM 2025-10-22 to 2026-10-21,
-- B2B unicommerce source rows and channel names containing B2B, FBN, SOR, CUSTOM or IWIT excluded, softline EANs (master_sl) only.
-- Value = order_quantity x listing_unit_price at AED 3.6725 / SAR 3.75 per USD. No PII column is read.
WITH ms AS (
  SELECT ean, ANY_VALUE(CASE WHEN UPPER(brand) LIKE 'PENTI%' THEN 'Penti' WHEN UPPER(brand) LIKE 'NAUTICA%' THEN 'Nautica'
    WHEN UPPER(brand) LIKE '%POLO%' THEN 'U.S. Polo Assn.' WHEN UPPER(brand) LIKE 'FRENCH CONNECTION%' THEN 'French Connection' ELSE INITCAP(brand) END) brand
  FROM `opptra-datawarehouse.raw_gcc_dimensions.master_sl` WHERE TRIM(IFNULL(ean,''))<>'' GROUP BY ean),
usm AS (SELECT channel_sku, ANY_VALUE(ean) ean FROM `opptra-datawarehouse.dimensions.unified_sku_master_gcc` GROUP BY 1),
s AS (
  SELECT COALESCE(m1.brand, m2.brand) brand, LOWER(TRIM(IFNULL(us.return_reason,''))) rr,
    SAFE_CAST(us.order_quantity AS FLOAT64) * us.listing_unit_price / CASE us.currency WHEN 'AED' THEN 3.6725 WHEN 'SAR' THEN 3.75 WHEN 'USD' THEN 1 END usd
  FROM `opptra-datawarehouse.fact_gcc.unified_sales` us
  LEFT JOIN usm ON usm.channel_sku = us.channel_sku
  LEFT JOIN ms m1 ON m1.ean = us.barcode_ean
  LEFT JOIN ms m2 ON m2.ean = usm.ean
  WHERE DATE(SAFE_CAST(us.ordered_date AS TIMESTAMP)) BETWEEN '2025-10-22' AND '2026-10-21'
    AND NOT REGEXP_CONTAINS(LOWER(IFNULL(us.source_table,'')), r'b2b_unicommerce')
    AND NOT REGEXP_CONTAINS(UPPER(IFNULL(us.channel_name,'')), r'B2B|FBN|SOR|CUSTOM|IWIT')
    AND REGEXP_CONTAINS(UPPER(us.channel_name), 'NAMSHI')
    AND COALESCE(m1.brand, m2.brand) IS NOT NULL
)
SELECT IFNULL(brand,'ALL') brand, COUNT(*) lines, ROUND(SUM(usd)) gross_usd,
  COUNTIF(rr<>'') lines_with_reason, ROUND(SUM(IF(rr<>'', usd, 0))) usd_with_reason,
  COUNTIF(REGEXP_CONTAINS(rr, r'size|fit|small|large|big|tight|loose')) size_fit_lines,
  ROUND(SUM(IF(REGEXP_CONTAINS(rr, r'size|fit|small|large|big|tight|loose'), usd, 0))) size_fit_usd
FROM s GROUP BY ROLLUP(brand) ORDER BY gross_usd DESC
```

### L1. GCC PO-to-receipt time

```sql
-- L1 GCC inbound lead time proxy: PO date to first vendor GRN date, per PO, from the four Unicommerce warehouse GRN reports.
-- Vendor receipts only (inter-entity transfers, channel withdrawals and test rows excluded).
WITH g AS (
  SELECT item_type_brand brand, po_code, po_date_date po_d, grn_date_date grn_d, quantity_received q, vendor_name FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_fze_uae`
  UNION ALL SELECT item_type_brand, po_code, po_date_date, grn_date_date, quantity_received, vendor_name FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_rfs_uae`
  UNION ALL SELECT item_type_brand, po_code, po_date_date, grn_date_date, quantity_received, vendor_name FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_sls_ksa`
  UNION ALL SELECT item_type_brand, po_code, po_date_date, grn_date_date, quantity_received, vendor_name FROM `opptra-datawarehouse.raw_gcc_table_cleaned.inward_grn_unicommerce_stl_ksa`
),
po AS (
  SELECT CASE WHEN UPPER(brand) LIKE '%POLO%' OR UPPER(brand)='USPA' THEN 'U.S. Polo Assn.' WHEN UPPER(brand) LIKE 'PENTI%' THEN 'Penti' ELSE INITCAP(brand) END brand,
    po_code, MIN(po_d) po_d, MIN(grn_d) first_grn, SUM(q) q
  FROM g WHERE NOT REGEXP_CONTAINS(LOWER(IFNULL(vendor_name,'')), r'oppdoor|noon|test|ninja|mamzorld|mumzworld|united electronics|rohan') AND q>0
  GROUP BY 1,2
)
SELECT IFNULL(brand,'ALL') brand, COUNT(*) pos, MIN(po_d) first_po, MAX(first_grn) last_grn,
  APPROX_QUANTILES(DATE_DIFF(first_grn, po_d, DAY), 100)[OFFSET(50)] median_days,
  APPROX_QUANTILES(DATE_DIFF(first_grn, po_d, DAY), 100)[OFFSET(90)] p90_days,
  ROUND(AVG(DATE_DIFF(first_grn, po_d, DAY)),1) avg_days, MIN(DATE_DIFF(first_grn, po_d, DAY)) min_days, MAX(DATE_DIFF(first_grn, po_d, DAY)) max_days
FROM po GROUP BY ROLLUP(brand) ORDER BY pos DESC
```

### L2. India inbound lead time table

```sql
-- L2 India-side inbound lead time (brand PO approved to first GRN) for brands also sold in the GCC; source brand_inbound_lead_time_sku
SELECT brand, region, COUNT(DISTINCT p2p_po_code) pos, COUNT(*) po_sku_rows,
  APPROX_QUANTILES(lead_days_first, 100)[OFFSET(50)] median_first, APPROX_QUANTILES(lead_days_first, 100)[OFFSET(90)] p90_first,
  ROUND(AVG(lead_days_weighted),1) avg_weighted, MIN(order_date) mn, MAX(order_date) mx
FROM `opptra-datawarehouse.internal_brand_dashboard.brand_inbound_lead_time_sku`
WHERE lead_days_first IS NOT NULL GROUP BY 1,2 ORDER BY pos DESC
```

### T1. AOP target against actual

```sql
-- T1 AOP monthly target (GCC rows, all markets summed) vs actual gross and net revenue from unified_sales_tertiary_v2.
-- AOP brand "Nutri" is compared with Nutricook + NutriBullet; "USPA" with U.S. Polo Assn.
WITH base AS (
  SELECT
    CASE
      WHEN UPPER(b) LIKE '%POLO%' OR UPPER(b)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(b) LIKE 'PENTI%' THEN 'Penti'
      WHEN UPPER(b) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(b) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(b) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook'
      WHEN UPPER(b)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(b)='GTPLAYER' THEN 'GTPlayer'
      WHEN UPPER(b)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(REPLACE(b,'_',' '))='VERO MODA' THEN 'Vero Moda'
      ELSE INITCAP(b) END AS brand,
    s.*
  FROM (SELECT COALESCE(NULLIF(TRIM(mapped_brand),''), source_brand) b, * FROM `opptra-datawarehouse.fact_gcc.unified_sales_tertiary_v2`) s
),
seg AS (SELECT *, IF(brand IN ('U.S. Polo Assn.','French Connection','Campus','Penti','Keds','Vero Moda','Puma','Nautica','Cardio Bunny','Only'),'Softline','Hardline') segment FROM base),
act AS (
  SELECT CASE WHEN brand IN ('Nutricook','NutriBullet') THEN 'Nutri' WHEN brand='U.S. Polo Assn.' THEN 'USPA' ELSE brand END aop_brand,
    DATE_TRUNC(ordered_date, MONTH) m,
    SUM(IF(event_type='sale', revenue_usd, 0)) gross, SUM(revenue_usd) net
  FROM seg WHERE ordered_date BETWEEN '2026-06-01' AND '2026-08-31' GROUP BY 1,2
),
aop AS (SELECT brand aop_brand, month_start m, SUM(target_usd) target FROM `opptra-datawarehouse.brand_intelligence.aop_monthly_target` WHERE geo='GCC' GROUP BY 1,2),
j AS (SELECT COALESCE(aop.aop_brand, act.aop_brand) b, aop.target, act.gross, act.net FROM aop FULL JOIN act USING (aop_brand, m))
SELECT IFNULL(b,'ALL') brand, ROUND(SUM(target)) target_jun_aug, ROUND(SUM(gross)) gross_jun_aug, ROUND(SUM(net)) net_jun_aug,
  ROUND(SUM(gross)/NULLIF(SUM(target),0),2) gross_vs_target, ROUND(SUM(net)/NULLIF(SUM(target),0),2) net_vs_target
FROM j GROUP BY ROLLUP(b) ORDER BY target_jun_aug DESC
```

### CB1. Cardio Bunny category and channel mix

```sql
-- CB1 Cardio Bunny category and channel mix, TTM 2025-10-22 to 2026-10-21 (gross sale events, USD incl VAT)
WITH base AS (
  SELECT
    CASE
      WHEN UPPER(b) LIKE '%POLO%' OR UPPER(b)='USPA' THEN 'U.S. Polo Assn.'
      WHEN UPPER(b) LIKE 'PENTI%' THEN 'Penti'
      WHEN UPPER(b) LIKE 'NAUTICA%' THEN 'Nautica'
      WHEN UPPER(b) LIKE 'FRENCH CONNECTION%' THEN 'French Connection'
      WHEN UPPER(b) IN ('NUTRICOOK','NUTRI') THEN 'Nutricook'
      WHEN UPPER(b)='NUTRIBULLET' THEN 'NutriBullet'
      WHEN UPPER(b)='GTPLAYER' THEN 'GTPlayer'
      WHEN UPPER(b)='CARDIO BUNNY' THEN 'Cardio Bunny'
      WHEN UPPER(REPLACE(b,'_',' '))='VERO MODA' THEN 'Vero Moda'
      ELSE INITCAP(b) END AS brand,
    s.*
  FROM (SELECT COALESCE(NULLIF(TRIM(mapped_brand),''), source_brand) b, * FROM `opptra-datawarehouse.fact_gcc.unified_sales_tertiary_v2`) s
),
seg AS (SELECT *, IF(brand IN ('U.S. Polo Assn.','French Connection','Campus','Penti','Keds','Vero Moda','Puma','Nautica','Cardio Bunny','Only'),'Softline','Hardline') segment FROM base)
SELECT IFNULL(mapped_category,'(blank)') category, channel,
  ROUND(SUM(IF(event_type='sale', revenue_usd, 0))) gross_usd, ROUND(SUM(IF(event_type='sale', ordered_units, 0))) units,
  ROUND(-SUM(IF(event_type='reversal' AND final_status='returned', revenue_usd, 0))) returned_usd,
  COUNT(DISTINCT IF(event_type='sale', mapped_opptra_sku, NULL)) skus, COUNT(DISTINCT IF(event_type='sale', style_id, NULL)) styles
FROM seg WHERE brand='Cardio Bunny' AND ordered_date BETWEEN '2025-10-22' AND '2026-10-21'
GROUP BY ROLLUP(category, channel) ORDER BY 1, 3 DESC
```

### CB2. Cardio Bunny stock, sell-through and age by category

```sql
-- CB2 Cardio Bunny by category: stock (latest replen run, one row per sku_key), 90-day units sold (tertiary), 90-day sell-through proxy,
-- cover, stock-outs and first-in-first-out age of stock (same method as A1)
WITH run AS (SELECT run_id, as_of FROM `opptra-datawarehouse.fact_gcc.channel_replen_run` WHERE status='success' ORDER BY finished_at DESC LIMIT 1),
r AS (
  SELECT * EXCEPT(rn) FROM (
    SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c.sku_key ORDER BY c.row_order) rn
    FROM `opptra-datawarehouse.fact_gcc.channel_replen_by_sku` c JOIN run USING (run_id, as_of)
    WHERE UPPER(c.brand)='CARDIO BUNNY')
  WHERE rn=1
),
rs AS (
  SELECT sku, IFNULL(category,'(blank)') category, asp,
    IFNULL(fz_on_hand,0)+IFNULL(ml_on_hand,0)+IFNULL(sls_on_hand,0)+IFNULL(stl_on_hand,0)+IFNULL(noon_uae_on_hand,0)+IFNULL(noon_ksa_on_hand,0) oh,
    [STRUCT(ml_on_hand AS oh, ml_ros AS ros), STRUCT(sls_on_hand, sls_ros), STRUCT(noon_uae_on_hand, noon_uae_ros), STRUCT(noon_ksa_on_hand, noon_ksa_ros)] lanes,
    last_sold, as_of
  FROM r
),
sold AS (
  SELECT mapped_opptra_sku sku, SUM(ordered_units) u90
  FROM `opptra-datawarehouse.fact_gcc.unified_sales_tertiary_v2`
  WHERE event_type='sale' AND UPPER(mapped_brand)='CARDIO BUNNY' AND ordered_date BETWEEN '2026-07-24' AND '2026-10-21' GROUP BY 1
),
g AS (
  SELECT item_skucode sku, grn_date, SUM(CAST(quantity_received AS FLOAT64)) q
  FROM `opptra-datawarehouse.raw_gcc_table_cleaned.itd_grn_fin` WHERE UPPER(brand)='CARDIO BUNNY' AND CAST(quantity_received AS FLOAT64)>0 GROUP BY 1,2
),
gc AS (SELECT g.*, SUM(q) OVER (PARTITION BY sku ORDER BY grn_date DESC ROWS UNBOUNDED PRECEDING) cum FROM g),
age AS (
  SELECT rs.sku,
    SUM(IF(DATE_DIFF(rs.as_of, gc.grn_date, DAY) > 90, GREATEST(LEAST(gc.q, rs.oh - (gc.cum - gc.q)), 0), 0)) q_gt90,
    SUM(IF(DATE_DIFF(rs.as_of, gc.grn_date, DAY) > 180, GREATEST(LEAST(gc.q, rs.oh - (gc.cum - gc.q)), 0), 0)) q_gt180
  FROM rs LEFT JOIN gc ON gc.sku=rs.sku GROUP BY 1
)
SELECT IFNULL(category,'ALL') category, COUNT(*) skus, SUM(oh) units_on_hand, ROUND(SUM(oh*asp)/3.6725) value_usd_at_asp,
  SUM(IFNULL(sold.u90,0)) units_sold_90d,
  ROUND(SUM(IFNULL(sold.u90,0))/NULLIF(SUM(IFNULL(sold.u90,0))+SUM(oh),0),3) sell_through_90d,
  SUM(IF(last_sold IS NULL OR last_sold < DATE_SUB(as_of, INTERVAL 90 DAY), oh, 0)) units_no_sale_90d,
  SUM((SELECT COUNTIF(l.ros>0 AND l.oh=0) FROM UNNEST(lanes) l)) stockout_lane_rows,
  SUM((SELECT COUNTIF(l.ros>0) FROM UNNEST(lanes) l)) selling_lane_rows,
  ROUND(SUM(age.q_gt90)) units_gt90d, ROUND(SUM(age.q_gt180)) units_gt180d
FROM rs LEFT JOIN sold USING (sku) LEFT JOIN age USING (sku)
GROUP BY ROLLUP(category) ORDER BY units_on_hand DESC
```

### CB3. Scout rating and review coverage on Namshi

```sql
-- CB3 Scout (opptra_core.listing_observation) rating and review coverage on Namshi, latest observation per listing in the last 30 days
WITH o AS (
  SELECT platform, marketplace_listing_id, brand, rating, review_count, availability_status,
    ROW_NUMBER() OVER (PARTITION BY platform, marketplace_listing_id ORDER BY scraped_at DESC) rn
  FROM `opptra-datawarehouse.opptra_core.listing_observation`
  WHERE platform IN ('Namshi.ae','Namshi.sa') AND scrape_date >= DATE_SUB(DATE '2026-10-26', INTERVAL 30 DAY)
)
SELECT IFNULL(brand,'ALL') brand, IFNULL(platform,'both') platform, COUNT(*) listings,
  COUNTIF(rating IS NOT NULL AND rating>0) with_rating, ROUND(COUNTIF(rating IS NOT NULL AND rating>0)/COUNT(*),3) share_rated,
  COUNTIF(review_count>0) with_reviews, ROUND(COUNTIF(review_count>0)/COUNT(*),3) share_reviewed,
  ROUND(AVG(IF(rating>0, rating, NULL)),2) avg_rating, SUM(review_count) total_reviews,
  APPROX_QUANTILES(IF(review_count>0, review_count, NULL), 2)[OFFSET(1)] median_reviews_when_any
FROM o WHERE rn=1 GROUP BY ROLLUP(brand, platform) ORDER BY 1,2
```

