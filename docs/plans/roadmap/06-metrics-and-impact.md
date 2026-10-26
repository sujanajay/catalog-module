# 06 - Metrics framework and impact model v2 (GCC catalog roadmap, agent F)

Date: 2026-10-26. Documents only; nothing was built or changed. One small read-only BigQuery query was run (Q1 below);
everything else is taken from the evidence files. No time or effort estimates.

**Labels.** Every number carries one label: **(exact)** = a direct count or sum from a source; **(approx)** = derived,
joined, annualised or rounded by hand; **(judgement)** = an assumption, not a measurement.

**Source codes.**

| Code | File or query |
|---|---|
| 01 | `docs/plans/roadmap/01-marketing-data.md` (ads, section numbers as `01 s2.6`) |
| 02 | `docs/plans/roadmap/02-catalog-liveness-data.md` |
| 03 | `docs/plans/roadmap/03-image-audit.md`; `03 csv` = its per-product file `audit_products.csv` (scratchpad of this session, `...\scratchpad\audit\audit_products.csv`), recounted here per brand |
| 04, 05 | `docs/plans/roadmap/04-india-learnings.md`, `05-build-vs-buy.md` |
| DD4 to DD7, DD9 | `docs/plans/deep-dives/04-...` to `07-...`, `09-business-impact.md` (section numbers as `DD9 s4`) |
| Q1 | New query, 2026-10-26: Amazon traffic report (`raw_gcc_table_cleaned.traffic_sales_amazon_3p_uae/ksa`, file_date 2026-07-26 to 2026-10-23) joined on `child_asin` = `fact_gcc.channel_listing_status_daily.portal_keys.asin` (snapshot 2026-10-24), sum of sessions, units and `ordered_product_sales` (AED / 3.6725, SAR / 3.75), grouped by brand and country |

Annualising a 90-day figure: x 365 / 90 = x 4.056 (approx).

## Summary

1. The old model (DD9) priced each initiative as revenue touched x a judged share with the problem x a judged lift. B1, the top item, was 9.2M x 1/3 x 3% = 92k USD a year; program base about 318k.
2. The audit confirms "1 in 3" by product count (45 of 141) but not by money: weighted by brand revenue it is 12.8%, because US Polo (6.08M of 8.52M) is almost clean on that rule. Like for like, B1 drops from 92k to 33k.
3. Splitting what each bucket can actually fix (B1 framing and order, B2 missing apparel shots, B4 lifestyle, B5 infographics) and using measured defect shares per brand, the v2 program base is about 269k USD a year of extra revenue (low about 1k, high up to about 0.84M; highs overlap).
4. The money still sits on US Polo footwear pages: B4 lifestyle (60k) and B5 infographics (57k) are the two largest rows, both gated by owner answers (rights, Noon and Namshi acceptance).
5. New levers from the evidence: content fixes on the weak-converting ad pool (5.0k USD a year saved at the same ad sales, base), recovering Noon content rejections (7.5k) and not-listed pairs (6.7k), and footwear missing views (13k).
6. Marketing efficiency effects are small next to revenue (each bucket saves under 2.5k USD a year of ad spend at its base lift), because a CVR lift of x% saves only x / (1 + x) of the spend it touches.
7. Run costs remain tiny (tens to hundreds of USD per bucket); review capacity and owner answers, not money, limit value.
8. The judged lifts are still the weakest input. Our own data shows no link between image count and CVR (01 s3), so count-driven lifts are cut (B2 base 5% to 3%).
9. A holdout on Namshi Sponsored Products ad CVR can detect about a 15% relative lift with about 42% of one 90-day window of Namshi softline clicks; Amazon can detect only lifts of about 25% or more.
10. Fix first: Noon Not Live (stale since 21 Aug), Namshi C-04b, Amazon C-08, Noon traffic (stopped 4 Feb), and a treatment log of which images went live where.

## How the old numbers were calculated

**The one formula.** DD9 sized every bucket the same way:

> extra revenue a year = revenue of the products the bucket changes (trailing 12 months)
> x share of those products that have the problem
> x conversion lift once fixed

Revenue was gross listing price x quantity from `fact_gcc.unified_sales`, about 9.2M USD softline including softline
channel rows with no brand (DD9 s4) (approx). The share and the lift were both judgement. Traffic was held constant and
stock and price were assumed never to block a sale.

**Worked example B1 (shot-list compliance).**
- Revenue touched: all softline, 9.2M (approx).
- Share with the problem: "1 in 3 options have a framing, size or missing-role defect" (judgement, unmeasured; DD9 sizing table).
- Lift: low 0%, base 3%, high 6% (judgement, anchored loosely on eBay 2014 and Profitero 2023, DD9 s4).
- Base: 9.2M x 1/3 x 3% = 92k USD a year. High: 9.2M x 1/3 x 6% = 184k.

**Worked example B2 (fill the shot list).**
- First version: 770 of 3,315 Trendyol options had fewer than 5 images (23%), so revenue touched was assumed proportional, 2.1M. 2.1M x 5% = 106k (DD9 s4).
- Corrected: the measured revenue of those under-5 options was 1.95M, but 1.46M of it was 77 US Polo footwear options that B2's apparel engine cannot fill. Apparel left: 0.47M. 0.47M x 5% = 23k (DD9 s4) (approx).

**Worked example B4 (footwear and bags lifestyle).**
- Revenue touched: footwear 6.86M (US Polo 5.91M, Campus 0.79M, Keds 0.16M; French Connection bags excluded because they already show the bag carried) (DD9 s7) (approx).
- Share with the problem: 100% (assumed every page lacks a lifestyle image) (judgement).
- Lift 1% (judgement, "one extra catchy image"). 6.86M x 1% = 69k.

**Why these were low confidence.**
1. The share with the problem was a guess. "1 in 3" for B1 and "100% lacking lifestyle" for B4 were not measured.
2. The lifts were guesses. Public studies measure going from 0 to 2 images, where gains are largest; our pages already have 4 to 6 images (DD9 s4). Nothing public isolates lifestyle, infographic, Arabic text or review fixes on a GCC marketplace.
3. Our own data could not link page content to sales: the Trendyol image-to-sales join covered 13% of orders (DD9 s4).
4. Revenue is gross listing price, not margin, and assumes no stock or price limit, while 49% of pool stock sits on live options that sold nothing in 90 days (02).
5. The highs overlap on the same US Polo pages and do not add up.

**What the new evidence changes.** The audit (03) measures the share with the problem per brand and per channel rule.
The ads data (01) gives spend, CTR, CVR and ROAS per option, so a lift can be expressed as ad money saved. The liveness
data (02) gives revenue per live listing and the not-live counts, so a liveness effect can be sized. The lifts remain
judgement until the holdout in the measurement plan runs.

## Metrics tree with baselines

Three layers. Catalog health is what the catalog team controls directly; storefront is what shoppers do; money is the
outcome. Each lower layer is explained by the one above it.

```
Money:        revenue, sell-through, zero-sales live share, ROAS / ACoS, cost per listing
                 ^
Storefront:   impressions -> CTR -> PDP conversion -> returns (fit returns)
                 ^
Catalog health: liveness rate, rejections by reason, time to live, compliance per channel rule, image completeness per role
```

### Catalog health

| Metric | Definition | Formula | Data source (table) | Baseline today | Measurable today? | Missing to measure it |
|---|---|---|---|---|---|---|
| Liveness rate | Share of stocked, in-scope listings (EAN x channel-country) that are live | stocked AND live / stocked AND live known | `fact_gcc.catalog_liveness_daily` | 92.7% on 24 Oct (46,249 / 49,888) (exact, 02); 95.5% on 17 Oct (exact) | Yes, 4 channels x 2 countries | Styli, Centrepoint, 6thStreet, VogaCloset, Shein feeds; Amazon uses the Active Listings fallback, which overstates live (02) |
| Liveness by channel-country | Same, per channel-country | as above | same | Noon UAE 98.0, Noon KSA 86.6, Namshi UAE 97.9, Namshi KSA 86.8, Trendyol UAE 96.9, KSA 90.5, Amazon UAE 86.1, KSA 92.0 (exact, 02) | Yes | A feed-health flag to tell feed jumps from real delistings (02 gap 6) |
| Reason coverage | Share of not-live pairs with a known reason | not-live pairs not in "Unknown" / not-live pairs | same | 38% (1,396 / 3,639) (exact, 02) | Yes | Reason feeds C-02, C-04b, C-08 |
| Rejection rate by reason (content) | Content-bucket not-live pairs over stocked pairs, per channel-country | content pairs / stocked pairs | same; history in raw `catalog_non_live_noon_3p_*` | 0 in the report (feeds missing) (exact). Last Noon file, 21 Aug: 264 UAE and 215 KSA SKUs with "Content Issues" (exact, 02), about 3.0% of Noon UAE stocked (264 / 8,774) and 3.9% of KSA (215 / 5,480) (approx: Aug SKUs, Oct stocked base, stocked or not) | No | Noon C-02 refreshed; Namshi C-04b loaded (holds `No valid image`, `QC failed`, `Content incomplete`) |
| Not-listed rate | Stocked pairs not on the portal | "Not listed" pairs / stocked pairs | same | 865 pairs, 1.7% of stocked (865 / 49,888) (exact count, approx share; 02) | Yes | Sub-reason quality (sheet code vs item master) |
| Time to live | Days from first seen (item master or stock) to first portal-live | first live date - first seen date | `catalog_liveness_daily` (history), master_sl | Not measurable (9 days of history, no created date in live feeds) (02) | No | 400-day history building up; Noon Child Zsku tracker in Cloud SQL `gcc_catalog` as a proxy (not queried) |
| Compliance rate per channel rule | Share of products whose images pass a channel's written rule | passing products / products checked | Audit sample (03); the catalog module's own compliance checks for its outputs (`compliance.ts`, 05) | Amazon main rule 69% pass (97 / 141); Noon cut main 96%; Noon sequencing 97%; Styli/Centrepoint 5-shot set 2% of apparel (1 / 66); VogaCloset min 4: 85%; Shein min 2: 91%; Trendyol max 8: 98% (exact on sample, 03) | Only on samples and on module outputs | A per-channel export of live images (Noon, Namshi, Amazon content exports) or a scheduled live-page check |
| Image completeness per role | Share of products that have each required shot role | products with role / products in department | Audit sample (03); module records once roles are tagged (DD1) | Apparel missing: head-and-shoulders 57 / 66, close-up 31, front mid 25, back 19, full length 14. Footwear missing: back 20 / 64, sole 14, top 14, pair 6 (exact on sample, 03) | Only on samples | Role tags per live listing |
| Image depth (proxy) | Average images per live listing; share with 3 or fewer | count of non-blank image slots | Trendyol product list | 5.74 images; 7.2% with 3 or fewer (744 / 10,348) (exact, 02) | Trendyol only | Image counts for Noon, Namshi, Amazon |
| Set consistency | Share of sets mixing pixel sizes, padding or backgrounds | inconsistent sets / sets | Audit sample | 36% (51 / 141) (exact, 03) | Sample only | As above |
| Completeness score (proposed headline) | Per channel: required roles present, mandatory attributes filled, English and Arabic present, no open rejection (IDQ idea, 04) | elements present / elements required | Would combine module role tags, B6 fact sheet, reason feeds | Not defined yet | No | B6 fact sheet, role tags, reason feeds |

### Storefront

| Metric | Definition | Formula | Data source | Baseline today | Measurable today? | Missing |
|---|---|---|---|---|---|---|
| Impressions (ads) | Sponsored listing views | SUM(`impressionsviews`) | `gcc_marketing.ads_daily` | Softline 90 days about 49.8M (667,325 clicks / 1.34%) (approx, from 01 s2.2) | Yes, Amazon, Noon, Namshi | Organic impressions on any channel; ads for Trendyol, Styli, Centrepoint, 6thStreet, VogaCloset, Shein |
| Sessions / visitors (organic PDP) | Product page visits | SUM(`sessions_total`) or Noon visitors | `traffic_sales_amazon_3p_*`; `traffic_sales_noon_3p_*` | Amazon live softline 90 days: UAE 69,224, KSA 78,396 (approx join, 02). Noon: stale (2 Jan to 4 Feb 2026) | Amazon only | Noon traffic restored; Namshi and Trendyol have no traffic table |
| CTR (ads) | Clicks per impression | clicks / impressions | `ads_daily` | Softline 90 days 1.34% (exact, 01 s2.2); Namshi KSA 1.71%, UAE 1.44%, Noon KSA 1.54%, UAE 1.59%, Amazon KSA 0.57%, UAE 0.50% | Yes | Main-image label per ad to attribute CTR to the image |
| PDP conversion | Units per page visit | units / sessions (Amazon unit session %); units / visitors (Noon) | Amazon and Noon traffic tables | Amazon softline UAE 1.19%, KSA 0.85% (approx join, 02); USPA UAE 1.16%, KSA 0.82%. Noon (stale) USPA UAE 1.36%, KSA 0.87% (exact sums, 02) | Amazon only | Noon traffic; Namshi any conversion data |
| Ad CVR (PDP proxy) | Ad units per ad click | ad units / clicks | `ads_daily` | Softline 90 days 1.64% (exact, 01 s2.2); USPA 1.80%, CAMPUS 1.09%, FC 1.10%, Penti 2.59%, CB 2.57%, Keds 0.78%, VM 1.45% (exact, 01 s2.4) | Yes, Amazon, Noon, Namshi | Controls for stock (cut-size), price and targeting |
| Return rate and fit returns | Returned lines with a reason over order lines; fit share of reasons | lines with return reason / lines; fit lines / lines with reason | `fact_gcc.unified_sales` `return_reason` (DD9 `ret.sql`) | Namshi softline: 24,755 of 161,309 lines carry a reason (15.3%) (exact counts, approx rate); size or fit 17,678 lines (11.0% of lines, 71% of reasons), 0.68M USD gross (DD9 s4) | Namshi only | Noon `return_reason` is blank on all but 62 lines |

### Money

| Metric | Definition | Formula | Data source | Baseline today | Measurable today? | Missing |
|---|---|---|---|---|---|---|
| Revenue | Trailing 12-month softline sales | SUM(qty x price / fx) | `fact_gcc.unified_sales` (DD9, gross listing price) or `unified_sales_tertiary_v2` (02, net) | About 9.2M USD gross, all channels (approx, DD9 s4); about 7.0M net 3P on the 4 liveness channels; 2.50M on listings live and stocked today (approx, 02) | Yes | Audited revenue; the two tables differ in measure |
| Revenue per live listing | 12-month revenue of live stocked listings / live listings | GMV / live pairs | `catalog_liveness_daily` + `unified_sales_tertiary_v2` | All: 54.1 USD per EAN-pair (2,503,600 / 46,249); Namshi 126.1, Noon 47.5, Trendyol 14.75, Amazon 3.78 (approx, derived from 02) | Yes | Median is 0 (revenue is concentrated), so means overstate a random listing |
| Sell-through | Units sold over units available in a period | units sold / (units sold + units on hand at end) | `unified_sales_tertiary_v2` + `unified_inventory` | No baseline in the evidence. Proxy: 49% of pool units (116,909 / 238,776) sit on live options with 0 sales in 90 days (approx, 02) | Yes, not computed | One query; pooled Noon/Namshi stock must be counted once |
| Zero-sales live share | Live stocked options with 0 net units in 90 days | zero-sale option-pairs / live option-pairs | liveness + sales v2 | 71.4% of option-pairs (13,687 / 19,169); 78.3% of EAN-pairs (approx, 02) | Yes | 11% of live EAN-pairs have no option id |
| Revenue concentration | 12-month GMV share of the top 10% of live option-pairs | top-decile GMV / all GMV | same | 86.2% (approx, 02) | Yes | none |
| ROAS / ACoS | Ad sales per ad dollar, and its inverse | ad sales / spend; spend / ad sales | `ads_daily` | Softline 90 days ROAS 3.39, ACoS 29.5%; 12 months 3.68, 27.1% (exact, 01 s2.2) | Yes | Ad sales are portal-attributed and probably include VAT |
| Weak-pool share of spend | Spend on options with 200+ clicks and CVR under 70% of brand CVR | weak spend / softline spend | `ads_daily` | 27.3% (30,513 / 111,752), ROAS 1.75 vs 4.25 (exact, 01 s2.6) | Yes | none |
| Cost per listing | Run cost to produce a channel-ready image set | ledger cost / style-colour | Module cost ledger (`cost-events.ts`, Ops page) | Module: 0.0036 USD per product on 4 channels; 0.0119 USD per style on 5 photos, all channels, with upscaler (exact, 05). Agency INR 60 per style (about 0.71 USD), images plus templates (meeting, DD9 s3). Generation 0.20 USD per accepted image (DD3 via DD9) | Module yes; agency no | Agency invoice and its image/template split (DD5 Q6) |

## Impact model v2

### What changes from DD9

1. **Share with the problem is measured per brand** from the audit (03, 03 csv), then weighted by each brand's revenue (DD9 s4). Brand revenue used (12 months, gross, USD): US Polo 6.08M (footwear 5.91M), Campus 0.79M, French Connection 0.72M (apparel 0.53M, bags 0.19M), Penti 0.40M, Keds 0.16M, Vero Moda 0.13M, Nautica 0.12M, Cardio Bunny 0.10M, Puma 0.02M; total 8.52M attributed (approx). Nautica and Puma were not sampled, so the all-sample rate is used for them (approx).
2. **Each bucket keeps only the defect it can fix**, so the same product defect is not paid twice: B1 = framing and order (cut main, head cut on the main, wrong first image); B2 = missing apparel shots; B3 = apparel with no model shot; B4 = no lifestyle scene; B5 = no infographic; L4 = missing footwear views.
3. **Lifts stay judgement but are re-anchored.** Our own stratified test found no CVR gain for options with 7 to 8 images over fewer (CVR ratio 0.954, 9 of 18 cells each way) (exact, 01 s3). That argues against lifts driven by image count, so B2's base is cut from 5% to 3%. Public anchors for content lifts: eBay 2014 (multiple views +65%, from 0 to 2 images, DD9 s4); Amazon's own claim of up to 8% for standard A+ content and 20% for premium, and Epinium's 3% to 10% CVR for standard A+ (cited in 04, vendor claims, not studies). None measures our case.
4. **Marketing efficiency effect** is added per bucket. ACoS = CPC / (CVR x ad price), so at the same CPC and price a CVR lift of x raises ROAS by x and lowers spend needed for the same ad sales by x / (1 + x) (01 s4). Spend touched = each brand's 12-month softline ad spend (01 s2.4: US Polo 195,439; Campus 53,297; Penti 29,267; FC 20,307; Keds 15,937; Vero Moda 13,894; Cardio Bunny 8,636) x the bucket's defect share (approx). Shown as money saved at the same ad sales.
5. **Liveness effect** = listings recovered x revenue per live listing (02).

**Do not add the money-saved column to the revenue column.** Ad-attributed sales (about 1.24M of the roughly 9.2M softline revenue, 13.5%) (approx, bases differ: 01 s2.2 vs DD9) are inside the revenue lift. Take the lift on those sales either as extra revenue at the same spend or as spend saved, not both.

### Summary table (USD a year)

| Bucket or lever | Revenue touched (from data) | Measured defect share (source) | Lift low / base / high (source) | Revenue uplift low / base / high | Ad money saved at base (high) | Liveness effect | Run cost (source) | Base revenue per USD of first-year run cost |
|---|---|---|---|---|---|---|---|---|
| B1 compliance and live back catalog (framing and order) | 0.466M (approx) | 17% of products (24 / 141); 0% US Polo, Campus, Keds (03 csv) | 0 / 3% / 6% (judgement, DD9 unchanged) | 0 / 14.0k / 28.0k | 0.6k (1.3k) | via L2a (shared with B6) | about 77 USD year 1: one re-run of 3,141 style-colours at 0.0119 = 37, plus 12 to 40 a year for new styles (05); saves INR 93,800 (1.1k USD) a year of agency fees (DD9 s6) | about 180 |
| B2 fill apparel shots (conversion) | 0.752M (approx) | 60% of sampled apparel (44 / 73) lack front + back + close-up (03 csv) | 0 / 3% / 10% (judgement, cut from 2/5/15 because of 01 s3) | 0 / 22.5k / 75.2k | 1.1k (3.5k) | none | about 44 USD: about 1,050 options x 5/24 generated x 0.20 (approx, DD9 s3 ratios) | about 510 |
| B2e Styli / Centrepoint eligibility | about 663 apparel options absent from Centrepoint at about 115 USD per listed option, about 893 absent from Styli at about 25 (DD9 s4) | 98% of apparel lack the 5-shot set (65 / 66) (exact, 03) | 0 / 25% / 50% of absent options start selling (judgement, DD9) | 0 / 25k / 49k | n/a (no ads data on these channels) | this row is a listing effect | shares B2 cost | n/a |
| B3 flat lay to model (Vero Moda) | 0.031M (approx) | 25% of sampled Vero Moda apparel (3 / 12) have no model shot (03 csv); all brands 17% (11 / 66) (03) | 3% / 10% / 25% (judgement, DD9) | 0.9k / 3.1k / 7.8k | 0.3k (0.7k) | none | about 30 USD (about 30 options x 1.00 per 5-shot set, DD9 s3); 121 USD at DD9's full count | about 100 |
| B4 lifestyle, footwear | 5.98M (approx) | No lifestyle scene: US Polo 19 / 20, Campus 4 / 15, Keds 7 / 7 (03 csv) | 0 / 1% / 3% (judgement, DD9) | 0 / 59.8k / 179.5k | 2.1k (6.3k) | none | 244 USD once + about 260 a year (DD4, DD9 s7) | about 120 |
| B5 infographics | 5.71M with proposed features (1.22M confirmable only) (approx) | No infographic: US Polo 19 / 20; Cardio Bunny sets 1 / 15; other brands 0 seen (03 csv, 03) | 0 / 1% / 3% (judgement, DD9) | 0 / 57.1k / 171.3k (12.2k base on confirmable features only) | 2.3k (6.8k) | none | up to about 481 USD once (DD6, DD9 s8) | about 120 |
| B6 listing facts and templates | 7.33M (DD9 s9) | Unmeasured: no Arabic text in any warehouse source (DD5); facts from data for 58% of style-colours (DD9 s9) | 0 / 0.5% / 2% (judgement, DD9) | 0 / 36.7k / 165k | 1.4k (5.6k) | via L2b | 240 USD once + about 214 a year (DD5, DD9 s9); saves INR 82,400 (1.0k USD) a year of agency fees | about 80 |
| B7a review-driven fixes | 1.8M Noon (assumed 80% of Noon softline, DD9 s10) + Namshi fit returns 0.68M (exact, DD9 s4) | Fit is 71% of Namshi return reasons (DD9 s4) | DD9 unchanged: 2% of fit returns + 5% of "not as described" + 0.5% conversion (judgement) | 0 / 24k / 76k | 0.5% x 98.7k Noon spend = 0.5k (2.0k) | none | up to about 350 USD year 1 (DD7, DD9 s10) | about 70 |
| L1 content fixes on the weak ad pool (new) | 55.2k USD a year of ad spend on weak options with a measured content defect; 96.5k of ad sales on it (approx) | 44.6% of weak-pool spend sits on brands' defect shares (13,602 / 30,513) (approx, 01 s2.6 x 03) | 0 / 10% / 25% CVR (judgement; 04 public A+ claims 3% to 20%; the pool is at least 43% below brand CVR) | Extra ad sales at the same spend 0 / 9.7k / 24.1k: overlaps B1 to B5, not added | **5.0k (11.0k)** counted once here | none | inside B1 to B5 costs | n/a (cost saving) |
| L2a recover Noon content rejections (new) | 479 SKUs (264 UAE, 215 KSA) not live for "Content Issues" on 21 Aug (exact, 02) | 100% of these SKUs have the problem by definition | Recovered share 0 / 50% / 100% (judgement) | 0 / 7.5k / 24.4k | none | 479 x 31.2 USD (French Connection revenue per live EAN-pair) = 15.0k if all recovered; high uses Noon country means 24.4k (approx) | inside B1 and B6; needs C-02 refreshed | n/a |
| L2b recover not-listed pairs (new) | 865 pairs: Noon 1, Namshi 179, Trendyol 141, Amazon 544 (exact, 02) | all not listed by definition; part may be intended (judgement) | Recovered share 0 / 25% / 50% (judgement) | 0 / 6.7k / 13.4k | none | at channel means = 26.8k if all recovered (approx) | people time only (excluded) | n/a |
| L3 reason feeds and Noon traffic (enabler, new) | 2,243 not-live pairs with "Reasons not connected yet" (exact, 02) | unknown until feeds land | none claimed | 0 direct | none | 136k at channel means if all were real delistings (approx); probably mostly feed artefacts (02) | inside existing gcc-dashboard jobs | n/a |
| L4 footwear missing views (new) | 2.59M (approx) | Missing one of the 5 core views: US Polo 7 / 20, Campus 10 / 15, Keds 0 / 7 (exact, 03) | 0 / 0.5% / 2% (judgement, kept low because 01 s3 finds no image-count effect for these brands) | 0 / 13.0k / 51.9k | 0.6k (2.4k) (approx) | none | about 91 USD (about 455 style-colours x 1 view x 0.20) (approx) | about 140 |
| **Program v2** | | | | **about 1k / 269k / 841k** (highs overlap) | L1 5.0k (bucket ad columns overlap L1 and each other) | L2 inside the revenue row | about 2.0k USD year 1 in total (77 + 44 + 30 + 504 + 481 + 454 + 350 + 91) | |

Program total, base: 14.0 + 22.5 + 25 + 3.1 + 59.8 + 57.1 + 36.7 + 24 + 7.5 + 6.7 + 13.0 = 269.4k USD a year (approx).
DD9 base for the same buckets was about 318k. The fall comes from B1 (92k to 14k) and B3 (13k to 3k); the new levers add back about 27k.

### Formulas, step by step

**B1 compliance and live back catalog.**
- Defect share per brand = framing defect on the main image, or Noon "cut main", or wrong first image (03 csv): FC 7/19, Penti 4/15, VM 5/15, CB 4/15, US Polo 0/20, Campus 0/15, Keds 0/7, all 24/141.
- Revenue touched = 0.72M x 7/19 + 0.40M x 4/15 + 0.13M x 5/15 + 0.10M x 4/15 + 0.14M (Nautica, Puma) x 24/141 = 0.265 + 0.107 + 0.043 + 0.027 + 0.024 = 0.466M.
- Base = 0.466M x 3% = 14.0k. High = 0.466M x 6% = 28.0k.
- Like-for-like check against DD9 (same lenient rule DD9 guessed, 03 per brand: US Polo 1/20, FC 13/19, Penti 6/15, VM 6/15, CB 6/15, Campus 0, Keds 0, others 45/141): 6.08 x 0.05 + 0.72 x 0.684 + 0.40 x 0.40 + 0.13 x 0.40 + 0.10 x 0.40 + 0.14 x 0.319 = 1.09M, 12.8% of 8.52M. 1.09M x 3% = 33k (vs DD9's 92k). The 33k includes missing shots, which v2 moves to B2 and L4.
- Ad spend touched = 20,307 x 7/19 + 29,267 x 4/15 + 13,894 x 5/15 + 8,636 x 4/15 = 22.2k. Saved = 22.2k x 0.03 / 1.03 = 0.6k.
- Amazon main-image rule: 31% of products fail (03), but the failing brands (FC, VM, Only, CB brand photos) have small Amazon sales: FC Amazon 1,391 USD in 90 days (Q1) x 4.056 x 79% fail = about 4.5k touched, under 0.3k uplift. Not worth a row.

**B2 fill apparel shots.**
- Defect share = apparel missing a front (FM or FL), a back or a close-up (03 csv): FC 12/17, Penti 7/15, VM 7/12, CB 5/15, all apparel 44/73.
- Revenue touched = 0.528M x 12/17 + 0.403M x 7/15 + 0.125M x 7/12 + 0.097M x 5/15 + 0.142M x 44/73 = 0.373 + 0.188 + 0.073 + 0.032 + 0.086 = 0.752M. (DD9 used 0.47M from Trendyol image counts; the audit counts roles, not images.)
- Base = 0.752M x 3% = 22.5k; high = x 10% = 75.2k.
- Ad spend touched = 20,307 x 12/17 + 29,267 x 7/15 + 13,894 x 7/12 + 8,636 x 5/15 = 39.0k. Saved at 3% = 39.0k x 0.03 / 1.03 = 1.1k.
- Cost: 1,746 apparel options (DD9 s1) x 44/73 = about 1,050 options; head-to-toe generated for 5 in 24 (DD2 via DD9) = 219 images x 0.20 = 44 USD.

**B2e Styli / Centrepoint eligibility.** Unchanged from DD9: 663 x 115 x 25% + 893 x 25 x 25% = 19.1k + 5.6k = about 25k base (judgement on the 25%). The audit now shows the cause is real: 65 of 66 apparel products lack the 5-shot set (03).

**B3 flat lay to model.** 0.125M x 3/12 = 0.031M. Base = 0.031M x 10% = 3.1k. DD9 applied the lift to all Vero Moda revenue (126k), but the audit finds a model in 9 of 12 sampled Vero Moda apparel sets. master_sl undercounts Vero Moda (121 options vs 306 on Trendyol, DD9 s2), so the revenue could be higher.

**B4 lifestyle.**
- Defect share = footwear with no lifestyle scene (role LS) (03 csv): US Polo 19/20, Campus 4/15, Keds 7/7.
- Revenue touched = 5.911M x 19/20 + 0.788M x 4/15 + 0.159M x 7/7 = 5.616 + 0.210 + 0.159 = 5.98M.
- Base = 5.98M x 1% = 59.8k; high = x 3% = 179.5k.
- If on-legs studio shots count as "lifestyle present" (DD4 Q2; 7 of 20 US Polo sets have one, 03): 5.911 x 13/20 + 0.210 + 0.159 x 6/7 = 4.19M, base 41.9k.
- Ad spend touched = 195,439 x 0.95 + 53,297 x 4/15 + 15,937 = 215.8k. Saved at 1% = 215.8k x 0.01 / 1.01 = 2.1k.

**B5 infographics.**
- Revenue touched = DD9's 6.02M (Noon and Namshi, features incl. proposed) less pages that already carry one: US Polo 4.54M x 19/20 + Cardio Bunny 0.088M x 1/15 + others 1.39M x 1 = 5.71M (approx).
- Base = 5.71M x 1% = 57.1k (12.2k on confirmable features only: 1.22M x 1%). High = x 3% = 171.3k.
- Ad spend touched = brand spend x share of style-colours with features (DD9 s8) x missing share = about 233k. Saved at 1% = 2.3k.
- Gated: worth about 0 if Noon and Namshi do not accept infographics in writing (DD6 Q2).

**B6 listing facts and templates.** Unchanged from DD9: 7.33M x 0.5% = 36.7k. Ad spend touched = (Namshi 196,122 + Noon 123,373) x 89% (p2p brands share, DD9 s9) = 284k; saved at 0.5% = 1.4k. The audit does not measure text, so the defect share is still unmeasured.

**B7a review-driven fixes.** Unchanged from DD9: 2% x 0.68M + 5% x 32k + 0.5% x 1.8M = 13.6k + 1.6k + 9k = about 24k.

**L1 content fixes on the weak ad pool.**
- Pool: 236 options, 30,513 USD spend in 90 days, ROAS 1.75 vs 4.25 for other well-clicked options (exact, 01 s2.6).
- Content-linked share = brand weak spend x brand defect share (apparel brands: lenient rule; footwear brands: missing core view; 03): US Polo 11,521 x 7/20 + Campus 4,290 x 10/15 + FC 5,486 x 13/19 + Penti 3,238 x 6/15 + CB 2,634 x 6/15 + Keds 1,825 x 0 + VM 1,518 x 6/15 = 4,032 + 2,860 + 3,754 + 1,295 + 1,054 + 0 + 607 = 13,602 in 90 days (44.6%).
- A year: 13,602 x 4.056 = 55.2k spend; ad sales 55.2k x 1.75 = 96.5k.
- Base +10% CVR: spend saved at the same ad sales = 55.2k x 0.10 / 1.10 = 5.0k; or extra ad sales at the same spend = 96.5k x 10% = 9.7k (inside the bucket revenue rows; not added).
- Benchmark only, not a catalog effect: the pool's gap to ROAS 4.25 is worth 30,513 x (4.25 - 1.75) = 76k of ad sales in 90 days. Pausing or cutting bids on unfixed weak options is a marketing action and is outside this model.

**L2a recover Noon content rejections.** French Connection live revenue per EAN-pair = 302,849 / 9,697 live EAN-pairs = 31.2 USD (02, approx). 479 x 31.2 = 15.0k if all recovered; base 50% = 7.5k. High at Noon country means: 264 x 33.9 (291,208 / 8,600) + 215 x 72.1 (342,267 / 4,745) = 8.9k + 15.5k = 24.4k. The Aug list is stale and includes unstocked SKUs, so this needs C-02 refreshed before it is trusted.

**L2b recover not-listed pairs.** At channel means: Noon 1 x 47.5 + Namshi 179 x 126.1 + Trendyol 141 x 14.75 + Amazon 544 x 3.78 = 48 + 22,572 + 2,080 + 2,056 = 26.8k; base 25% = 6.7k. Means overstate a random listing (top 10% of option-pairs carry 86.2% of revenue, 02).

**L4 footwear missing views.** 5.911M x 7/20 + 0.788M x 10/15 = 2.069 + 0.525 = 2.59M; base 0.5% = 13.0k. No bucket fills footwear views today (B2's engine is apparel only, DD9); it would use the B4 generator or a re-shoot.

### Overlaps (what not to add)

| Overlap | Why | Treatment |
|---|---|---|
| B1 and B2 on the same apparel product | A product can have a framing defect and missing shots | Small: both lifts apply to their own defect; combined lift on such products is below the sum (judgement) |
| B4, B5 and L4 on US Polo pages | All add gallery images to the same footwear pages; Trendyol (8) and Amazon (9) caps force a choice (DD4) | Highs not additive; a holdout should test them in separate cells |
| L1 and every bucket's ad column | The weak pool is a subset of the options B1 to B5 touch | Count ad money saved once, in L1; the per-bucket ad column is for comparison only |
| Revenue rows and ad money saved | Ad sales are part of revenue | Take the ad-driven part (about 13.5%) as revenue or as spend saved, not both |
| L2 and the B buckets | Recovered listings later also get B lifts | B lifts apply only to revenue live today |
| B6 and L2b | Template filling speeds listing | L2b counted separately; B6's lift only on live revenue |
| B7a and B6 | Size facts and size-guidance fixes overlap | DD9 treatment kept |

## Worked examples

**Example 1 - US Polo pages on Amazon with high traffic and low conversion.**
- The brief's idea "US Polo main images cut at the frame on Amazon" is not supported: no US Polo product failed the Amazon main-image rule in the audit (0 of 20), and product cut on the main image is 6 of 141 overall, none US Polo (exact, 03). The real Amazon gap is conversion.
- 187 live softline ASINs, almost all US Polo, get high traffic but convert below half the country rate: UAE 72 ASINs, 15,805 sessions; KSA 115 ASINs, 23,922 sessions in 90 days (exact under the rule, 02).
- Missed units at the country rate: UAE 162, KSA 178 in 90 days (approx, 02).
- US Polo average price on Amazon: UAE 36.79 USD, KSA 42.23 USD (Q1: UAE 23,984 USD / 652 units; KSA 18,495 / 438) (exact sums, approx join; ordered sales are gross, before cancellations and returns).
- Ceiling a year = (162 x 36.79 + 178 x 42.23) x 4.056 = (5,960 + 7,517) x 4.056 = 54.7k USD.
- Closing a quarter of the gap (base, judgement) = 13.7k USD a year; low 10% = 5.5k; high 50% = 27.3k.
- What to fix: the gallery (7 of 20 US Polo sets miss a core view and 7 of 20 mix a padded 600x800 portrait into a square set, 03), plus checks that size runs and price are not the blocker. These pages are the best place for the first Amazon holdout because sessions are measured.
- Caution: the net sales table puts Amazon softline on live listings at about 35k USD in 12 months (02), while Q1's gross ordered sales are 51.5k in 90 days. The two measures disagree; this example uses Q1's price only.

**Example 2 - French Connection weak-converting ads on Namshi.**
- French Connection: 40 weak options, 5,486 USD spend in 90 days, ROAS 1.36 against 3.83 for its other well-clicked options; 40.2% of its spend is weak (exact, 01 s2.6).
- Its images: 13 of 19 fail the minimum standard, 15 of 19 main images are not white, 4 of 17 apparel sets have head cuts, and its raw folders open with a close-up (exact, 03). Noon rejected 207 UAE and 158 KSA French Connection SKUs for "Content Issues" on 21 Aug (exact, 02).
- A year: 5,486 x 4.056 = 22.2k spend; ad sales 22.2k x 1.36 = 30.3k.
- After fixing order, background and framing to the channel rule at +10% CVR (judgement): either 30.3k x 10% = 3.0k USD more ad sales at the same spend, or 22.2k x 0.10 / 1.10 = 2.0k USD less spend for the same ad sales.
- Across the whole content-linked pool (L1): 5.0k USD a year saved at the same ad sales (base).
- Reading: the ad saving is modest. The stronger message for the pitch is that 27.3% of softline ad money buys clicks that do not convert, and the catalog can fix the listings before more money is spent on them.

**Example 3 - French Connection listings Noon rejected for content.**
- 365 French Connection SKUs (207 UAE, 158 KSA) were not live on Noon for "Content Issues" on 21 Aug; with other brands, 479 (exact, 02).
- French Connection earns about 31.2 USD a year per live listing (302,849 USD / 9,697 live EAN-pairs) (approx, 02).
- If B1 and B6 fix the content and Noon takes them live: 365 x 31.2 = 11.4k USD a year for French Connection; 479 x 31.2 = 15.0k for all; base 50% recovered = 7.5k.
- Liveness effect: 264 SKUs is about 3.0 points of Noon UAE's stocked base (264 / 8,774) (approx).
- Blocker: the Noon Not Live file has been stale since 21 Aug, so today's list is unknown. Refreshing it is the first data fix.

## Measurement plan

### Holdout test design

**Goal.** Replace the judged lifts (B1, B2, B4, B5, L1) with measured ones, one cell per lever.

**Where.**
- Namshi Sponsored Products: the largest softline ad channel (76,271 USD spend and 426,623 clicks in 90 days, exact, 01 s2.2) and the largest revenue channel. Measure ad CVR, CTR, ROAS. No organic traffic data.
- Noon: ads data now; organic visitor conversion once the traffic feed is restored.
- Amazon: the only channel with measured sessions and unit session %; use for the 187 high-traffic, low-conversion ASINs (example 1).

**Unit and assignment.**
- Unit = style-colour option on one channel-country (all its sizes together). Noon and Namshi share stock pools, so treat and compare within the same channel-country, never across channels.
- Strata: brand x channel-country x price tercile (Trendyol list price, 01 s3) x past 90-day click band. Inside each stratum, pair options by clicks and randomise one of each pair to treatment.
- Eligibility guards: live, stocked, no broken size run (`fact_gcc.cut_size_option_daily`), no price change and no bid or budget change during the test (agree a freeze with the agencies), at least 200 clicks in the previous 90 days for ad cells.

**Cells.**
1. B1: re-render and reorder to the channel rule (French Connection, Penti, Vero Moda, Cardio Bunny on Namshi).
2. L1: the content-linked weak pool (from the 236 options).
3. B4: lifestyle as the last image on US Polo footwear (Namshi and Noon), after rights are confirmed.
4. B5: callout infographic on US Polo and Campus, only after Noon and Namshi accept in writing.
5. Amazon: gallery fixes on the 187 ASINs, measured by unit session %.

**Metrics.** Primary: ad CVR (ad units / ad clicks, sum then divide) on Namshi and Noon; unit session % on Amazon. Secondary: CTR, ROAS, net units per option-day, Namshi fit returns, and liveness and rejections for the treated listings. Analysis: difference in differences per option-week (treated vs control, before vs after), standard errors clustered by option.

**Sample size (approx).** Two-sided 5% test, 80% power: n per arm = 7.84 x [p1(1 - p1) + p2(1 - p2)] / (p2 - p1)^2.

| Channel, baseline | Relative lift to detect | Clicks or sessions per arm | x2 for clustering (judgement) | Share of one 90-day window |
|---|---|---|---|---|
| Namshi ads, CVR 1.64% | 10% | 98,700 clicks | 197,300 | about 92% of Namshi softline clicks (both arms 394,600 / 426,623) |
| Namshi ads, CVR 1.64% | 15% | 44,900 clicks | 89,700 | about 42% (179,500 / 426,623) |
| Namshi ads, CVR 1.64% | 20% | 25,800 clicks | 51,600 | about 24% |
| Amazon US Polo, unit session 0.99% (1,090 / 109,737, Q1) | 25% | 28,200 sessions | 56,300 | about all 90-day US Polo sessions (112,600 / 109,737) |

Reading: Namshi can detect about a 15% lift per cell with less than half of one 90-day window of softline clicks; a 10% lift needs nearly all of it, so run one or two cells at a time. Amazon can detect only large effects (25% or more), which fits the 187 ASINs whose gap is over 50%. Small base lifts (1% to 3%) cannot be measured directly on any channel; they stay judgement unless a cell shows a larger effect.

**What the catalog module must record.** A treatment log: option, channel-country, date published, which images (role, generated flag, position). Without it the warehouse cannot join content to sales (DD9 s4 found 13% join coverage).

### Data feeds to fix first

| Order | Feed | Why it matters | State today (source) |
|---|---|---|---|
| 1 | Noon Not Live report (C-02) | Content rejections (L2a), reason coverage, rejection rate | Stale since 21 Aug 2026 (02) |
| 2 | Namshi Catalog Live Status (C-04b) | The only source of `No valid image`, `QC failed`, `Content incomplete`; Namshi is the largest revenue channel | GCS landing file, not loaded (02) |
| 3 | Amazon All Listings (C-08) | Removes the Active Listings fallback that overstates live | Not validated (02) |
| 4 | Noon traffic (`traffic_sales_noon_3p_*`) | Organic conversion for the Noon holdout | Stopped 4 Feb 2026 (02) |
| 5 | Namshi traffic or conversion export | No traffic table exists; ask Namshi's partner portal | None (02) |
| 6 | Feed-health flag on liveness | Tells feed jumps (for example Noon KSA 86.6% after 97.7%) from real delistings | Missing (02 gap 6) |
| 7 | Trendyol product list | Liveness and image counts | Stopped after 22 Oct (02) |
| 8 | Image role and position per live listing | Compliance and completeness metrics on live pages, not samples | Only the audit sample (03) and module outputs |
| 9 | master_sl price (`mrp`) and option id | Price bands and option-level joins | `mrp` blank on most rows; 11% of live EAN-pairs lack an option id (01, 02) |

## Assumptions and confidence

| # | Assumption | Effect if wrong | Confidence |
|---|---|---|---|
| 1 | Audit brand rates (5 to 20 products per brand, random within folders, one reviewer, plus or minus about 3 products per measure) stand for each brand's revenue | Brand defect shares move; US Polo's near-zero B1 share decides most of the B1 drop | Medium for direction, low per brand (03) |
| 2 | Raw-folder defects are what is live: 65% of 37 Trendyol UAE listings show the same photos, none repaired (03) | If Noon and Namshi teams fix images on upload, defect shares are lower there | Medium (Trendyol only checked) |
| 3 | Nautica and Puma take the all-sample rates (not sampled) | Small: 0.14M of revenue | Low |
| 4 | Defect shares by product count apply to revenue within a brand | Best sellers may be cleaner or dirtier than the average | Low |
| 5 | Lifts are judgement (B1 3%, B2 3%, B3 10%, B4 1%, B5 1%, B6 0.5%, L1 10%, L4 0.5%) | Every revenue row scales with its lift | Low; replace with the holdout |
| 6 | Revenue bases differ: DD9 gross listing price for revenue touched; 02 net GMV for revenue per live listing; 01 ad sales probably incl. VAT | Mixed rows are approximate; ROAS and revenue are not on one basis | Medium |
| 7 | Ad spend touched is brand spend x defect share (spend spread evenly within a brand) | Agencies concentrate spend on sellers (01 s3), so this may over or understate | Low |
| 8 | Revenue per live listing uses means; the median listing sells nothing (02) | L2 values are ceilings at the base shares | Low |
| 9 | The Noon content list (21 Aug) still holds and its SKUs are stockable | L2a could be smaller or larger today | Low until C-02 is refreshed |
| 10 | Run costs from 05, DD4 to DD7, DD9 (generation 0.20 USD per accepted image) | Rows stay tiny next to revenue; review time is excluded by rule | Medium |
| 11 | ROI ignores margin and people time | ROI ratios overstate; they only show that run cost is not the constraint | Low as a profit measure |
| 12 | Gated values: B4 and B5 need US Polo rights (DD4 Q5, DD6 Q5, DD8); B5 needs Noon and Namshi acceptance (DD6 Q2); B4 falls about 30% (from 59.8k to 41.9k) if on-legs shots count as lifestyle (DD4 Q2) | 117k of the 269k base sits behind these answers | n/a (owner answers) |
| 13 | Q1 ordered sales are gross; Amazon net revenue on live listings is far lower (35k in 12 months, 02) | Example 1 could be overstated by the gross-to-net gap | Low |

Status: done
