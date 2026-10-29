# 06 - Product design: Mizan (working name), demand, assortment and NPD intelligence for Opptra GCC

Date: 2026-10-26. Status: proposal for approval. Nothing is built, bought or scraped.
Audience: Opptra leadership and the GCC business team (Nitin Kiran - NPD and catalog; Ashish and Mahesh -
replenishment and demand planning).

Companion files in this folder: `02-market-scan.md` (vendors and prices), `02b-gcc-context-and-benchmarks.md`
(GCC market and ROI ranges), `03-baseline-metrics.md` (today's numbers, read from BigQuery on 2026-10-26),
`05-build-vs-buy.md` (options, cost, recommendation).

How numbers are labelled: each number carries a source tag in square brackets (full list in section 19) or the
word ASSUMPTION. Stage-gate thresholds are proposals and are marked "target". Numbers inside the screen
wireframes in section 7 are placeholders, not data. Where [03] and DD9 differ, [03] is used. For example, [03]
puts softline revenue at USD 8.46M, while DD9's USD 9.2M also counts sales on softline channels that have no
brand attached.

---

## 0. The proposal in one page

- **What.** A stand-alone internal product, working name **Mizan**, that tells each Opptra GCC brand team what
  to buy, how much, in which sizes, for which marketplace and warehouse, and when. It handles Ramadan, Eid and
  White Friday, and brands that have only a few months of sales. It also shows how our products compare with
  competitors on price, rank, reviews and attributes, so NPD can "copy with pride" [BRIEF].
- **Why now.**
  - Stock decisions today use a trailing rate of sale that "lags the season everywhere" [DD10]. Yet Opptra's
    own peaks are large: White Friday 2025 lifted daily revenue about 50-64%, and Ramadan 2025 about 50% for
    USPA [03]. Ramadan 1448 is expected to start about 8 Feb 2027 [02].
  - Stock is short and long at the same time. 48% of selling softline SKU-locations have under 14 days of
    cover while 19% have over 120 days [03]. Up to 41% of stock value is over 180 days old (an upper bound)
    [03].
  - On 15 Oct 2026, at a 60-day cover target, 23,535 of 28,428 required units could not be filled by moving
    stock [CR-STATUS].
  - Size or fit returns on Namshi are USD 0.68M [DD9], [03].
  - Hardline is 37% of GCC revenue and Channel Replenishment does not cover it [03], [CR-E2E].
  - Nobody owns NPD data [DD10].
- **How.** Three modules on one data layer: M1 Demand Planner, M2 Assortment and Buy Planner, M3 NPD and
  Competitor Insight. It reuses Channel Replenishment v2, Scout, the catalog module's read-only exports (B6,
  B7a) and the BigQuery warehouse. It buys raw competitor data instead of building scrapers.
- **How it is staged.** It starts as an extension of Channel Replenishment, as DD10 recommended. It pilots on
  USPA, Cardio Bunny and one hardline brand through Ramadan and Eid 2027. It becomes its own product at
  Gate 2 (about Jan 2028), and only if measured exit criteria are met (section 11).
- **Cost and value.** Recommended Option D in `05-build-vs-buy.md`: about USD 0.68M over 3 years with an
  India-based team (ASSUMPTION rates). Money is released per stage: Phase 0 about USD 13k, Phase 1 about
  USD 63k, Phase 2 about USD 155k ([05] section 4). The ROI model [04] puts the benefit at about USD 184k a
  year at full adoption in the base case (low 54k, high 525k), about USD 0.37M over 3 years after the ramp-up.
  At today's revenue the base case does not pay back in 3 years (NPV -USD 296k; high case +USD 339k), plus a
  one-off cash release of about USD 353k from lower stock. That is why money is released stage by stage and
  Gate 1 includes a money and scale test (G1.8).
- **Ask.** Approve Phase 0 (6 weeks). Separately, approve one step that pays off whatever is decided: start
  keeping a daily stock history now.

---

## 1. Problem statement with evidence

In one sentence: Opptra buys and places stock for 18 brands with sales in the last 12 months (9 softline,
9 hardline; USD 13.4M gross) [03], across 7 main marketplaces [BRIEF] and 6 stock locations [CR-E2E], using
recent sales only. Meanwhile GCC demand is driven by moving events, most brands have less than a year of
history, and NPD has no data at all. The results are stock that is short in one place and stale in another,
broken size runs, fit returns, and buys that are not planned from a forecast.

| # | Problem | Evidence | Source |
|---|---|---|---|
| 1 | Replenishment looks backward | Channel Replenishment v2 sets stock from a trailing rate of sale over a 14 to 60 day window per location. Its own investigation says "The trailing 60-day window lags the season everywhere". No seasonality, no cold start | [CR-E2E], [DD10], [BRIEF] |
| 2 | The GCC calendar moves | Ramadan moves about 10-11 days earlier each year; Ramadan 1448 is expected to start about 8 Feb 2027. The November sale has different names and dates per marketplace (White Friday on Amazon.ae, Yellow Friday on noon) | [02] |
| 3 | Events are large, and differ year to year | Opptra's own data: White Friday 2025 +50% to +64% daily revenue against the surrounding 4 weeks; Ramadan 2025 +50% for USPA; the two peak Ramadan 2026 weeks +35% to +60% over February, then a fall in Eid week; 11.11 2025 softline +98% against the 4 weeks before. Public data: Ramadan apparel transactions +76% to +78%; Saudi Founding Day +44% | [03], [02b] A3 |
| 4 | History is short and full of launches | Only USPA and Nautica cover two Ramadans; 15 of 18 brands started selling on or after 29 Oct 2025, 10 of them in 2026; Cardio Bunny launched mid-March 2026. Growth is mostly new channels (Namshi KSA from Sep 2025, Noon KSA from Oct 2025) and brand launches. USPA units in the last 6 months are flat (-1%) against the 6 before, while Q3 2026 is +188% on Q3 2025 | [03] |
| 5 | Stock is short and long at the same time | Softline replenishment run of 2026-10-25: 48% of selling SKU-locations have under 14 days of cover, 19% over 120 days; 16,146 SKU-locations hold stock with no sale in the window | [03] |
| 6 | Demand is lost where stock is not | Stock-out proxy: USD 1.4k to 6.7k of softline demand a day sits on SKU-locations with zero stock (lower anchor to upper bound); 63% of it is on SKUs that have stock in another location, so it is mostly a placement problem | [03] |
| 7 | Moving stock cannot close the whole gap, so buys must | 15 Oct 2026, 60-day cover target: required 28,428 units, moved 4,893, unfilled 23,535. No forecast, open-to-buy or assortment table exists in the warehouse | [CR-STATUS], [DD10] |
| 8 | Stock is ageing | About 66% of stock value is over 90 days since receipt and 41% over 180 days, on USD 6.5M at selling price. This is an upper bound: USPA's proxy overstates age | [03] |
| 9 | Size runs break | USPA UAE: 424 options, 246 with 3 or more sizes in stock, so 42% are "cut". Namshi emails a daily "Assortment Cut Size" report | [CUT] |
| 10 | Fit drives returns | 13% of softline gross value comes back as returns. Namshi size or fit returns: 17,678 order lines, USD 0.68M, 71% of returns that carry a reason | [03], [DD9] |
| 11 | Listings are uneven across channels | About 663 apparel options are absent from Centrepoint and 893 from Styli | [DD9] |
| 12 | No stock history | `unified_inventory` keeps only the latest snapshot; "There is no stock history anywhere". Replen's per-run stock lines expire after 31 days. The Cut Size table keeps option-level stock by pool for 400 days, from 2026-10-01 only | [CR-E2E] 19.11 and 9.2 |
| 13 | Planning inputs are missing | No usable GCC supplier lead time (purchase orders are raised when goods arrive); `inventory_ageing` and the lead-time tables hold India only; GCC AOP targets exist for June to August 2026 only; unit cost cannot be read from receipts | [03] |
| 14 | NPD has no owner and no data | No competitor or review-text table exists; Scout watches own listings only; its reviews entity is parked; no BlissClub or Lululemon rows exist. None of the 91 Cardio Bunny Namshi listings seen by Scout has a rating or review | [DD10], [SCOUT], [03] |
| 15 | Master data gaps | `sub_category` is null in the SKU master; 816 in-stock SKUs are missing from `master_sl` | [BRIEF], [CUT-UP] |
| 16 | Concentration | USPA is 72% of softline and 46% of GCC revenue; footwear is about 82% of attributed softline revenue | [03], [DD9] |
| 17 | Hardlines are not covered | Hardline is USD 4.93M, 37% of GCC revenue. Channel Replenishment v2 scope is "Softlines only"; the older reorder-point tables were superseded in Sep 2026 | [03], [CR-E2E], [DD10] |
| 18 | The public promise is ahead of the product | opptra.com says AI helps "anticipate demand" and offers "Revenue and volume forecasting", but no forecast table exists | [DD10] |
| 19 | No ready-made fit in the market | No vendor publicly lists connectors for Noon, Namshi, 6thStreet, Styli, Centrepoint and Trendyol GCC together. The suites with size curves and open-to-buy are built for store networks with long histories | [02] |

What it costs us today: the ROI model [04] applies the [02b] B3 ranges to [03]'s baseline. Across all GCC
brands the base-case improvement is worth about USD 184k a year at full adoption (low 54k, high 525k), plus a
one-off cash release of about USD 353k from lower stock. About two thirds of that benefit sits with softline
brands and one third with hardline brands [04]. The largest single lever is markdown and write-down avoided,
whose size Finance has not yet confirmed.

---

## 2. Product name

| Name | Meaning | For | Against |
|---|---|---|---|
| **Mizan** | Arabic for "balance" or "scales" | Rooted in the GCC; short; says what the product does: balance stock with demand. Works for partners as "Mizan by Opptra" | Common word used by other companies; needs a trademark check and a connotation check with the GCC team |
| Foresight | Seeing ahead | Plain English; obvious meaning | Generic; many products use it |
| Souq Signal | Signals from the market | Points at GCC marketplaces | Sounds like a data feed, not a planning tool |

**Pick: Mizan** as the working name, until the trademark and connotation checks are done. Fallback: Foresight.
Datasets and code use neutral names (`demand_intel_*`), so a rename costs nothing.

---

## 3. Vision and one-line pitch

- **Vision.** Every unit Opptra buys or moves in the GCC is in the right size, at the right marketplace
  warehouse, before customers want it. Every new product is chosen with evidence from GCC customers and
  competitors.
- **One-line pitch.** "Mizan tells each Opptra brand team what to buy, how much, in which sizes, for which
  marketplace and when, including for Ramadan and White Friday and for brands that launched last month."
- **For brand partners (later, section 16).** "Your GCC demand, sizes and competitors, read for you every
  week."

---

## 4. Personas and jobs to be done

A "job to be done" is written as: when (situation), I want (capability), so I can (outcome).

| Persona | Who | Job to be done | Today | Modules |
|---|---|---|---|---|
| Brand manager | Owns one brand's GCC sales and annual operating plan (AOP) | When I plan next season with the brand principal, I want a demand outlook by channel, country and event, so I can commit to a buy that hits AOP without leftover stock | AOP targets in the Internal Brand Dashboard [DD10]; spreadsheets (ASSUMPTION) | M1, M2 |
| Demand planner | Ashish, Mahesh | When Replenishment proposes moves, I want it to know Ramadan is three weeks away, so I send enough stock to Noon FBN KSA in time. When a new style lands, I want a starting forecast | Channel Replenishment v2 and Cut Size [CR-STATUS], [CUT] | M1, M2 |
| Buyer or merchandiser | Places orders with principals; decides listings | When I place an order, I want the size split per country and channel and the open-to-buy left, so I do not overbuy sizes that sell slowly or come back | Not found in any system [DD10] | M2 |
| NPD lead | Nitin Kiran | When we choose new styles for Cardio Bunny, I want to see what customers praise and complain about in BlissClub and Lululemon products and which attributes the winners share, so we copy with pride instead of guessing | No data [DD10] | M3 |
| Leadership | Opptra leadership | Each quarter I want to see whether stock is working harder (sell-through, aged stock, stockouts), and whether this product has earned its next stage of funding | No scorecard | Scorecard |

Secondary users: Finance (signs off open-to-buy), the catalog team (reads fit findings for size charts and
content; read only), and brand principals (partner views from Phase 3).

---

## 5. Product principles

1. **Decisions, not dashboards.** Every screen ends in a decision: move, buy, size split, markdown, list or
   drop, or an NPD brief.
2. **Explain every number** in plain words, for example "Ramadan uplift x1.5, learned from USPA 2025 and 2026".
3. **People approve.** In Phases 0 to 2 the product never executes moves, purchase orders or price changes by
   itself.
4. **Never worse than today.** If a forecast is missing, stale, or worse than today's method in testing, the
   product falls back to today's method and says so.
5. **Read only on other teams' systems.** It reads Replenishment, Scout and the catalog exports and writes only
   its own tables. Replenishment never needs it to run.
6. **Built for the GCC.** Hijri events, marketplace-specific sale events, UAE vs KSA, Noon FBN.
7. **Works with short history** by borrowing patterns from similar products and brands (section 9).
8. **No model names in the product.** Model ids and AI vendor names never appear in UI copy. No personal data is
   stored: no reviewer names, no order numbers (same rule as [DD7] R6).
9. **All brands from day 1 in the design**, softline and hardline, even though the pilot has three.

---

## 6. Modules

### 6.1 M1 Demand Planner

Purpose: an event-aware forecast that copes with short history and feeds Replenishment.

| Feature | What it does |
|---|---|
| F1.1 Event calendar | Hijri events (Ramadan, Eid al-Fitr, Eid al-Adha) computed from the Umm al-Qura calendar and confirmed by a planner when the moon sighting is announced [02]. Marketplace events per platform (White Friday on Amazon.ae, Yellow Friday on noon, 11.11, Namshi sales) [02], [02b]. Saudi Founding Day (22 Feb), Saudi National Day (23 Sep), back to school (UAE and KSA start at different times), KSA government payday on the 27th [02b]. Promotion participation per listing, when known |
| F1.2 Clean demand history | Net kept units (sales minus returns), as [02b] A5 recommends. Days when a SKU was out of stock are marked from the daily stock history and not read as zero demand. Namshi-fulfilled sales count at Noon FBN, the same rule Replenishment uses [CR-E2E] |
| F1.3 Event uplift | How much each event lifts demand, learned per brand where history exists (USPA, Nautica) and borrowed from department, category and all-Opptra levels where it does not. Starting values: Opptra's measured peaks (White Friday 2025 about x1.5 to x1.64; Ramadan 2025 about x1.5 for USPA; 11.11 2025 about x1.6 to x2.0 for softline [03]) and the published range of about 1.3x-1.8x [02b] A3. Learned weekly inside each event, because Ramadan builds to a late peak and drops in Eid week [03] |
| F1.4 Near-term forecast | Option (style-colour) x location x week, 16 weeks ahead (ASSUMPTION horizon), with a likely value (P50) and a safe-high value (P80). Hardlines at SKU level |
| F1.5 Season forecast | Brand x category x channel x country x month, 6-12 months ahead (ASSUMPTION horizon), for buys. Feeds M2 and is reconciled with AOP |
| F1.6 Cold start | A forecast for a new style or brand from look-alikes (section 9.3) |
| F1.7 Forward rate of sale for Replenishment | Expected units per day over each location's target cover window. Replenishment can use it instead of the trailing rate, brand by brand, once the brand opts in |
| F1.8 Decision deadlines | "Last day to move" per lane and "last day to order" per brand before each event, from lane transfer times and supplier lead times. Both have to be collected first: the Noon FBN UAE to KSA transfer time is unknown [CR-E2E], and no usable GCC supplier lead time exists because purchase orders are raised when goods arrive [03] |
| F1.9 Overrides and accuracy | Planners override with a reason. An accuracy tracker scores both the model and the overrides |

- **Inputs:** `fact_gcc.unified_sales_tertiary_v2` (sales, returns), daily stock history (new),
  `fact_gcc.channel_replen_by_sku` (positions, rate of sale, days of cover), Scout `opptra_core.listing_observation`
  (price, deal price, rank, rating), catalog B6 attributes, `brand_intelligence.aop_monthly_target` (GCC
  targets for June to August 2026 only so far [03]), supplier lead times collected from the brand and buying
  teams (the warehouse lead-time tables hold India only [03]), and the event calendar. Forecasts are in units;
  revenue is derived, because the revenue measure changed on 2026-08-01 and USD per unit jumped 13% to 22% for
  four brands overnight [03].
- **Outputs:** near-term and season forecasts, event uplift table, forward rate of sale for Replenishment,
  decision deadlines, accuracy log.
- **Decisions it drives:** how much stock to pre-position at Noon FBN and our own warehouses before an event,
  and by when; reorder quantities; target cover per event; how deep to launch a new style.

### 6.2 M2 Assortment and Buy Planner

Purpose: turn demand into the right buy, in the right sizes, for the right channels, and catch stock that is
going stale.

| Feature | What it does |
|---|---|
| F2.1 Size curves | Share of demand by size per brand x category x channel x country. Built from net kept units on in-stock days only, with a pooled fallback for thin data. Adjusted with return reasons by size ("too small" shifts the curve). Cut Size health shown alongside [CUT] |
| F2.2 Open to buy (OTB) | Per brand x month: OTB = planned sales + planned closing stock + planned markdowns - opening stock - stock on order. Shown in units and at retail value first, and at cost once Finance provides unit costs (receipt values do not give a usable unit cost today [03]). Planned sales come from the M1 season forecast, compared with AOP where a target exists [03] |
| F2.3 Buy proposals | Style-level quantities with size split and UAE/KSA and channel split, with an "order by" date from supplier lead times collected from the brand and buying teams [03] |
| F2.4 Ageing and markdown risk | For each option, weeks needed to sell current stock at forecast vs weeks left in the season or before an ageing limit. Age is built first in, first out from GCC receipts, as [03] did, because `brand_intelligence.inventory_ageing` holds India only [03]. Shows value at risk and a suggested action: move channel, nominate for a marketplace event, mark down, or return to principal where the contract allows |
| F2.5 List and drop per channel | Which options to list on which marketplace (for example selling on Namshi KSA but not listed on Trendyol) and which to drop or move. Uses channel sell-through, returns and listing coverage; known gaps include 663 options absent from Centrepoint and 893 from Styli [DD9] |
| F2.6 Hardline reorder plan | Reorder point and quantity per SKU x location from the M1 forecast and lead times. Needed because Replenishment v2 is softlines only [CR-E2E] |

- **Inputs:** M1 forecasts, stock history and positions, GCC receipts for ageing
  (`raw_gcc_table_cleaned.itd_grn_fin` and Unicommerce vendor receipts [03]), supplier lead times (to
  collect), AOP, returns by size, unit cost (to come from Finance [03]), channel listing ids (`master_sl`
  channel columns [SPEC]).
- **Outputs:** size curve table, OTB table, buy proposals, markdown risk list, channel assortment
  recommendations, hardline reorder list, and XLSX exports for principals.
- **Decisions it drives:** buy commitments with principals and their size split; markdown and event
  nominations; which options to list where; hardline purchase orders.

### 6.3 M3 NPD and Competitor Insight

Purpose: evidence for what to make or source next, and how to size and price it.

| Feature | What it does |
|---|---|
| F3.1 Competitor sets | The NPD owner defines who we compare against, per brand and category, for example Cardio Bunny women's leggings vs BlissClub and Lululemon [BRIEF] |
| F3.2 Price and promotion ladder | Competitor price, deal price and discount depth over time on shared marketplaces |
| F3.3 Rank and visibility | Best-seller rank (and later search position) for own and competitor listings. Scout already collects rank for own listings [SCOUT]; competitors come from bought feeds [02] |
| F3.4 Review themes compared | Themes from review text (fit, fabric, see-through, waistband, sizing, durability and so on) by brand, with share of mentions and example quotes, in Arabic and English. Uses the shared, versioned theme list from B7a [DD7] |
| F3.5 Attribute gap matrix | Attributes common in competitor best sellers but missing from ours (fabric, inseam, compression, pockets, modest-fit length). Ours come from B6, theirs from listing text |
| F3.6 Size and fit insight | Return reasons by style and size on Namshi ("too small", "too big") [DD9], plus fit themes from reviews. Proposes size-chart notes and size-curve changes; the catalog team reads it for content fixes |
| F3.7 "Copy with pride" board | Shortlist of competitor winners with evidence (rank, rating, review themes, price) and the attributes to adopt, turned into a one-page brief for the brand principal or sourcing |
| F3.8 Launch read | For new styles, compares the first 8 weeks of sales with the cold-start forecast and the NPD brief, so the team learns what worked. This supports small first buys followed by repeats of the winners, the pattern Shein describes [02b] B1 |

- **Inputs:** Scout `listing_observation` (own listings), bought competitor feeds (Apify, Bright Data or
  Oxylabs for listings and reviews; NoonSeller Data API for noon sales estimates; Helium 10 for Amazon) [02],
  `opptra_core.review_observation` from the shared B7a ingestion layer for competitor listing ids the NPD owner
  registers [DD7], B6 attributes, return reasons.
- **Outputs:** competitor price and rank tables, review theme comparison, attribute gap table, NPD briefs,
  launch reads.
- **Decisions it drives:** which styles and attributes to request or develop; price position; size chart
  fixes; launch depth (with M1 cold start).
- **Cardio Bunny's own customer voice today:** none of its 91 Namshi listings seen by Scout has a rating or
  review. Its only signal is return reasons (USD 14k of size or fit returns on Namshi). Cardio Bunny's TTM is
  USD 93k, 86% of it on Namshi [03]. A spot check of a few pages should confirm that the zero is real and not a
  scrape gap [03].
- **Where competitors sell (to confirm):** BlissClub appears to be India-only (own site, Myntra, Amazon.in),
  where Scout has Myntra and Amazon India adapters. Lululemon sells in the GCC through Majid Al Futtaim stores
  and its regional site, which would need a brand-site source [DD10], [02b] A4.

### 6.4 How the modules connect

```
 M3 NPD brief --> M1 cold-start launch quantity --> M2 size split --> M2 buy within OTB
                                                                          |
   M3 launch read, fit insight  <-- sales, returns, reviews <-- M1 forward rate into Replenishment (moves)
```

Why one product and not three tools: all three modules need the same product identity, attributes, sales,
stock and competitor data, and each decision feeds the next. Three separate tools would build the same data
plumbing three times.

---

## 7. Key screens (text wireframes)

All numbers in these wireframes are placeholders (ASSUMPTION), not data. Event dates shown are from [02] and
[02b].

**S1. Home - "This week"** (planners and brand managers)

```
+--------------------------------------------------------------------------------+
| Mizan   Brand [All v]  Country [UAE | KSA]  Channel [All v]    Week of 1 Feb   |
+--------------------------------------------------------------------------------+
| COMING UP                                                                      |
|  Ramadan (estimated start 8 Feb)   in 1 week   expected demand x1.5 (USPA)     |
|  Last day to send stock to Noon FBN KSA for Ramadan: 25 Jan (passed) [why?]    |
|  Saudi Founding Day (22 Feb)       in 3 weeks  expected demand x1.2            |
+--------------------------+----------------------------+------------------------+
| STOCK AT RISK (4 weeks)  | AGEING AND MARKDOWN RISK   | COMPETITORS            |
|  38 options run short    |  USD 120k at high risk     |  BlissClub leggings    |
|  at Noon FBN KSA         |  12 options over 180 days  |  price -20% this week  |
|  [Open list]             |  [Open list]               |  [Open benchmark]      |
+--------------------------+----------------------------+------------------------+
| MY DECISIONS THIS WEEK                                                         |
|  [ ] Approve Ramadan forward demand for Replenishment (USPA, Cardio Bunny)     |
|  [ ] Review 6 overrides that missed last week                                  |
|  [ ] Size split for Cardio Bunny buy (order by 10 Feb)                         |
+--------------------------------------------------------------------------------+
| Forecast accuracy, last 4 weeks: 78% (today's method 70%)    Data as of 07:30  |
+--------------------------------------------------------------------------------+
```

**S2. Event calendar and uplift**

```
+--------------------------------------------------------------------------------+
| Events            Country [UAE | KSA]            [+ Add marketplace event]     |
+--------------------------------------------------------------------------------+
| Event               Dates            Source           Uplift  Learned from     |
| Ramadan             8 Feb (est.)     Umm al-Qura      x1.5    USPA, Nautica    |
| Eid al-Fitr         end of Ramadan   Umm al-Qura      x1.7    USPA, Nautica    |
| Founding Day (KSA)  22 Feb           Fixed            x1.2    starting value   |
| Yellow Friday       noon dates       Planner entry    x1.6    USPA 2024, 2025  |
| White Friday        Amazon dates     Planner entry    x1.4    hardline pilot   |
| Payday (KSA)        27th monthly     Fixed            x1.05   starting value   |
+--------------------------------------------------------------------------------+
| Selected: Ramadan - USPA footwear - Namshi KSA                                 |
|   Week:  -2    -1    W1    W2    W3    W4    Eid   +1                         |
|   x:     1.1   1.3   1.4   1.6   1.7   1.9   1.2   0.8   (shaded = range)      |
|   Why: two past Ramadans for USPA; KSA peaks later than UAE                    |
|   [Accept]  [Adjust with reason]                                               |
+--------------------------------------------------------------------------------+
```

**S3. Forecast detail** (one option at one location)

```
+--------------------------------------------------------------------------------+
| USPA - men's sneaker - style 6F-XXXX white - Noon FBN KSA                      |
+--------------------------------------------------------------------------------+
| units/week |                    ####                                           |
|            |             ###  ######  ##                                       |
|            |  ##  ##  ## ############ #####  ##                                |
|            +------------------------------------------------                   |
|              Dec     Jan    [ Ramadan ]  Eid    Apr                            |
|   ---- actual    ==== likely (P50)    .... safe-high (P80)                     |
+--------------------------------------------------------------------------------+
| Next 60 days: likely 240 units, safe-high 300 | Replen trailing rate 2.1/day   |
| Forward rate for Replenishment: 4.0/day    [Send to Replen: ON for USPA]       |
| Stock: on hand 90, in transit 40 -> short by about 110 before Ramadan           |
| Why: base 2.1/day (in-stock days only) x Ramadan x1.6 x trend 1.1               |
| [Override: units ___  reason: promo / listing issue / principal delay / other] |
+--------------------------------------------------------------------------------+
```

**S4. New style forecast (cold start)**

```
+--------------------------------------------------------------------------------+
| New style: Cardio Bunny high-rise legging, black    Launch: Namshi KSA, 1 Mar  |
+--------------------------------------------------------------------------------+
| Look-alikes used (same category, price band, fabric, fit)        match         |
|  1. Cardio Bunny 7/8 legging, navy     first 8 weeks: 64 units     86%         |
|  2. Cardio Bunny flare legging, black  first 8 weeks: 51 units     81%         |
|  3. Penti legging, black               first 8 weeks: 88 units     62%         |
|  Principal's global rank for this style: top 10% (file shared by principal)   |
+--------------------------------------------------------------------------------+
| First 8 weeks: likely 70 units (range 45-100)   Ramadan in window: yes, x1.4   |
| Suggested launch depth: 90 units   Size split: XS 10  S 25  M 30  L 18  XL 7   |
| [Use in buy plan]   [Change look-alikes]                                       |
+--------------------------------------------------------------------------------+
```

**S5. Buy plan and open to buy**

```
+--------------------------------------------------------------------------------+
| Open to buy    Brand [Cardio Bunny v]   Season [SS27 v]   Currency [USD]       |
+--------------------------------------------------------------------------------+
| Month  Plan sales  AOP   Closing stock  Markdowns  Opening stock  On order  OTB |
| Feb      40k       38k       55k           2k          60k          20k    17k |
| Mar      52k       45k       50k           3k          55k          10k    40k |
| Apr      30k       32k       45k           4k          50k           0     29k |
+--------------------------------------------------------------------------------+
| Buy proposals (within OTB)                                                     |
| Style               Units  Size split            UAE/KSA  Order by  Status     |
| High-rise legging    900   XS10 S25 M30 L18 XL7   40/60   12 Dec    Draft      |
| Sports bra           600   S30 M40 L30            35/65   12 Dec    Draft      |
| [Approve]   [Export for principal (XLSX)]                                      |
+--------------------------------------------------------------------------------+
```

**S6. Size curves**

```
+--------------------------------------------------------------------------------+
| Size curve   USPA men's footwear     Compare [Namshi KSA] vs [Noon UAE]        |
+--------------------------------------------------------------------------------+
| Size                 40    41    42    43    44    45                          |
| Namshi KSA demand    8%   16%   24%   26%   17%    9%                          |
| Noon UAE demand     10%   19%   26%   23%   15%    7%                          |
| Noon UAE stock mix   6%   12%   30%   30%   15%    7%   -> short on 40 and 41  |
| "Too small" returns: high on size 42 -> suggest "runs small" size-chart note   |
| Options missing sizes (under 3 in stock), Noon and Namshi pool: 42% [Cut Size] |
+--------------------------------------------------------------------------------+
```

**S7. Stock health: markdown risk, ageing, list and drop**

```
+--------------------------------------------------------------------------------+
| Stock health    Brand [All v]   Country [KSA]                                  |
| [Markdown risk]  [Ageing]  [List and drop]                                     |
+--------------------------------------------------------------------------------+
| Option              Age   Stock  Weeks to sell  Weeks left  Risk  Suggestion   |
| FC tote, tan        210d   340       38             10      High  11.11 sale   |
| Penti swimsuit, red  95d   220       22              6      High  Trendyol KSA |
+--------------------------------------------------------------------------------+
| List and drop                                                                  |
|  Selling on Namshi KSA, not listed on Trendyol: 48 options      [Review]       |
|  In stock on Styli, no sale in 8 weeks: 31 options              [Review]       |
+--------------------------------------------------------------------------------+
```

**S8. Competitor benchmark**

```
+--------------------------------------------------------------------------------+
| Benchmark: women's leggings - Cardio Bunny vs BlissClub vs Lululemon           |
| Sources: Namshi, noon, Amazon.ae/.sa; BlissClub via Myntra and Amazon.in       |
+--------------------------------------------------------------------------------+
|                    Cardio Bunny    BlissClub      Lululemon                    |
| Price band (USD)   35-55           15-30          90-130                       |
| Rating (reviews)   4.1 (210)       4.3 (12,400)   4.5 (3,100)                  |
| Most praised       colour          pockets        fabric feel                  |
| Most criticised    runs small      pilling        price                        |
| "Runs small"       31% of reviews  12%            8%                           |
+--------------------------------------------------------------------------------+
| Themes, share of reviews:  fit | fabric | squat-proof | waistband | pockets    |
| [bars per brand]                                                               |
| [Read example reviews - Arabic and English - no reviewer names]                |
+--------------------------------------------------------------------------------+
```

**S9. Copy with pride (attribute gap and shortlist)**

```
+--------------------------------------------------------------------------------+
| Copy with pride    Category: women's leggings                                  |
+--------------------------------------------------------------------------------+
| Attribute            Top 10 competitor sellers   Our range (12)   Gap          |
| Side pockets               7 of 10                  1 of 12        Big         |
| 7/8 length                 6 of 10                  5 of 12        Small       |
| High waist                 9 of 10                  8 of 12        None        |
| Longer, modest top         4 of 10                  0 of 12        Big (KSA)   |
+--------------------------------------------------------------------------------+
| Shortlist                                                                      |
|  1. Pocket legging: competitor rank top 20, rating 4.5, "pockets" praised in   |
|     22% of reviews                                         [Make brief]        |
| Briefs: Draft / Sent to principal / Accepted / Launched -> [Launch read]       |
+--------------------------------------------------------------------------------+
```

**S10. Fit and returns**

```
+--------------------------------------------------------------------------------+
| Fit and returns    Namshi    Brand [USPA v]                                    |
+--------------------------------------------------------------------------------+
| Style          Sold   Returned for size  Too small  Too big  Suggestion        |
| Sneaker XXXX   1,200        9%             80%        20%    "Runs small" note |
| Polo shirt XX    800        6%             30%        70%    Check size chart  |
| [Share with catalog team]   [Adjust size curve]                                |
+--------------------------------------------------------------------------------+
```

**S11. Leadership scorecard**

```
+--------------------------------------------------------------------------------+
| Scorecard    Quarter [Q2 2027]    Scope [Pilot: USPA, Cardio Bunny, hardline]  |
+--------------------------------------------------------------------------------+
| North star: sell-through at planned price     52% (baseline 49%)  target +3 pts|
| Forecast error vs today's method              -18%                target -15%  |
| Options with 3+ sizes (Noon and Namshi pool)  64% (was 58%)                    |
| Aged stock over 180 days (value)              -8%                              |
| Size or fit returns share (Namshi)            -2%                              |
| Planner use: weeks reviewed                   11 of 12                         |
| Run cost this month                           USD 1.1k (budget 1.5k)           |
| Gate 1: 5 of 7 criteria met                   [Open gate checklist]            |
+--------------------------------------------------------------------------------+
```

---

## 8. Data architecture

### 8.1 Sources (all read only)

| Source | Owner | Tables or feed | Used for |
|---|---|---|---|
| Sales | Warehouse | `fact_gcc.unified_sales_tertiary_v2` (402,386 rows, since 2024-10-29, 23 brands, 14 channels, 12,569 SKUs [DD10]; 18 brands with revenue in the last 12 months [03]) | Demand history, returns, return reasons |
| Stock now | Warehouse | `fact_gcc.unified_inventory` (latest snapshot only) [CR-E2E] | Daily stock history (new job, 8.4) |
| Replenishment | gcc-dashboard team | `fact_gcc.channel_replen_by_sku`, `crv2_stock_lines`, `crv2_sales_lines` (31-day retention), `channel_replen_run` [CR-E2E] | Positions, rate of sale, days of cover, required and unfilled units, cleaned stock lines |
| Size health | gcc-dashboard team | `fact_gcc.cut_size_option_daily` (400-day retention, from 2026-10-01) [CR-E2E] | Size completeness history |
| AOP | Warehouse | `brand_intelligence.aop_monthly_target` (GCC targets for June to August 2026 only so far) [03] | Plan vs forecast |
| Receipts | Warehouse | `raw_gcc_table_cleaned.itd_grn_fin` and Unicommerce vendor receipts [03] | First-in-first-out stock age. `brand_intelligence.inventory_ageing` and `brand_inbound_lead_time_sku` hold India only and are not used [03] |
| Supplier lead times, unit cost | Brand, buying and Finance teams | New planner-maintained tables (no usable source in the warehouse [03]) | Order-by dates; OTB at cost |
| Product master | Warehouse | `raw_gcc_dimensions.master_sl`, `dimensions.unified_sku_master_gcc`, UDF `fact_gcc.family_of_gcc_brand` [SPEC], [CR-E2E] | Identity, option, size, softline or hardline, channel ids |
| Own listings | Scout (opptra-scrapers) | `opptra_core.listing_observation` (1,142,054 rows; GCC since 2026-08; own brands only) [DD10] | Price, deal price, rating, review count, best-seller rank |
| Attributes | Catalog module (B6) | Read-only identity and attributes view (planned) [DD10] | Look-alikes, attribute gaps |
| Reviews | Shared B7a ingestion layer | `opptra_core.review_observation` (planned) for registered listing ids [DD7] | Review themes (own and competitor) |
| Competitor data | Bought feeds | Apify, Bright Data or Oxylabs; NoonSeller Data API; Helium 10 [02] | Competitor price, rank, reviews, noon sales estimates |
| Events | Mizan | Computed Hijri dates plus planner entries | Event calendar |
| Principal data | Brand principals | Files shared under contract (to ask) | Global style ranks and size curves for cold start |

The warehouse is in BigQuery `opptra-datawarehouse`, location `asia-south1` [SPEC]. Mizan's datasets sit in the
same location.

### 8.2 Layers and datasets

```
 SOURCES (read only)                 MIZAN DATASETS                         WHO READS THE OUTPUT
 -------------------                 --------------                         --------------------
 Warehouse sales, stock,             demand_intel_raw                       Mizan screens S1-S11
 Replen tables, ageing, AOP,  ---->    bought feeds as delivered,           XLSX exports (planners,
 lead times, product master            principal files                        brand principals)
 Scout listing_observation   ---->        |
 Catalog B6 view             ---->   demand_intel_core                      Channel Replenishment:
 B7a review_observation      ---->     products, locations, events,  ---->    reads forward_ros for
 Bought competitor feeds     ---->     net sales daily, stock daily,          opted-in brands only
 Event calendar              ---->     listings daily, competitors,
                                       review themes                        Catalog team: reads the
                                          |                                   fit report (people, not
                                     demand_intel_ml                          the catalog software)
                                       features, backtests, model versions
                                          |
                                     demand_intel_out
                                       forecasts, event uplift, forward_ros,
                                       size curves, OTB, buy proposals,
                                       markdown risk, channel assortment,
                                       competitor benchmark, attribute gap,
                                       NPD briefs, accuracy log
                                     App state: overrides, approvals, comments
```

### 8.3 Main tables and their grain

| Dataset | Table | One row per |
|---|---|---|
| core | `dim_product` | SKU, with option, brand, family (softline or hardline), category, sub-category (from B6 when available), price band |
| core | `dim_location` | One of the 6 stock locations, with country and the channels it serves [CR-E2E] |
| core | `dim_event_calendar` | Event x country x platform x date, with source (computed, planner, fixed) |
| core | `fact_sales_net_daily` | SKU x location x day: units sold, units returned, net kept units, revenue, credited location |
| core | `fact_stock_daily` | SKU x location x day: sellable on hand, in transit, in-stock flag (NEW; the history starts on the day the job starts) |
| core | `fact_stock_age` | SKU x location x as-of: units by age bucket, first in first out from GCC receipts (method as in [03]) |
| core | `dim_supplier_lead_time`, `dim_unit_cost` | Brand x origin (lead time) and SKU (cost), planner- and Finance-maintained (NEW; no source today [03]) |
| core | `fact_listing_daily` | Listing x platform x day: price, deal price, rank, rating, review count (own and competitor) |
| core | `fact_review_theme` | Review x theme (pointer to `review_observation`; no reviewer names) |
| out | `forecast_option_loc_week` | Option or SKU x location x week x run: P50, P80, method, model version |
| out | `forecast_season` | Brand x category x channel x country x month x run |
| out | `event_uplift` | Event x level (brand, department, category, all) x country: multiplier, range, source |
| out | `forward_ros` | SKU x location x as-of: forward rate per day, window days, fallback flag |
| out | `size_curve` | Brand x category x channel x country x size: share, confidence |
| out | `otb_brand_month` | Brand x month: plan sales, closing stock, markdowns, opening stock, on order, OTB |
| out | `buy_proposal` | Style x size x country x channel: units, order-by date, status |
| out | `markdown_risk` | Option x location x as-of: weeks to sell, weeks left, value at risk, suggestion |
| out | `channel_assortment` | Option x channel: list, keep, drop or move, with reason |
| out | `competitor_benchmark`, `attribute_gap`, `npd_brief` | Competitor set x period; attribute x category; brief |
| out | `accuracy_log` | Forecast run x level: error (WMAPE), bias, today's method error for comparison |

### 8.4 Jobs (same pattern as Replenishment: Python plus BigQuery Cloud Run jobs on a schedule [BRIEF])

| Job | When (ASSUMPTION) | Does |
|---|---|---|
| `stock_snapshot_daily` | Once a day, after the last Replenishment run (Replen runs at 09:30, 11:30, 13:30 and 15:30 IST [CR-STATUS]) | Appends that day's cleaned stock lines (sellable only, Noon EAN remap applied [CR-E2E]) to `fact_stock_daily`, with no expiry. Start this in Phase 0, whatever else is decided |
| `forecast_nightly` | Nightly, after the sales refresh | Near-term forecast, forward rate, decision deadlines, accuracy log |
| `season_weekly` | Weekly | Season forecast, OTB, buy proposals, size curves, markdown risk |
| `competitor_feed` | Daily or weekly per competitor set | Loads bought feeds into raw, then core |
| `review_themes` | Daily | Tags new competitor reviews with the shared theme list |

### 8.5 Contracts with other products

- **Channel Replenishment.** Mizan reads Replen's tables. Replen reads only `demand_intel_out.forward_ros`,
  only for brands switched on, and falls back to its own trailing rate when the row is missing or older than
  2 days (ASSUMPTION rule). This needs a small Replen spec change (v1.6) agreed with Ashish and Mahesh. Replen
  keeps the lanes, allocation, ASN sheets and Cut Size; Mizan never writes to Replen's tables.
- **Scout.** Mizan reads `listing_observation`. Competitor listings come from bought feeds in Phases 0-2,
  because Scout's GCC adapters are STAGED and its reviews and search entities are parked [SCOUT], [DD10]. If
  Scout's owners agree later, Mizan registers competitor listing ids in Scout's schedule instead of buying.
- **Catalog module.** Mizan reads the B6 identity and attributes view and the B7a `review_observation` table
  for listing ids it registers [DD7], [DD10]. The catalog module never reads Mizan, never stores competitor
  reviews and never shows NPD output [DD10]. Model ids and per-brand model choices stay inside the catalog
  module [DD10].
- **What Mizan writes:** only its own `demand_intel_*` datasets, its app state (overrides, approvals,
  comments), and XLSX exports. Nothing else.

---

## 9. AI and machine learning approach, in plain words

### 9.1 The basic forecast recipe

Think of a forecast as three numbers multiplied together:

1. **A normal week ("base").** Average net units per day over recent days *when the item was in stock*. If a
   size was out of stock for 10 days, those zero days do not count as "no demand". This is why the daily stock
   history matters.
2. **The event effect ("uplift").** How much higher sales run in each week around an event than in a normal
   week, for example x1.6 in the third week of Ramadan.
3. **The trend.** Growth from more listings, new channels and more marketing. It is measured from listing
   counts and stock breadth, so growth is not mistaken for seasonality. This matters because most of
   Opptra's growth comes from new channels and brand launches, not like-for-like demand [03]. Launch ramps are
   modelled separately from events, as [03] advises.

This recipe is simple, explainable, and a big step up from a plain trailing rate.

### 9.2 Short history: borrowing strength

When a product has little history, its estimate leans on its group: similar styles in the same brand, then the
same category across brands, then all of Opptra. As its own sales build up, the weight moves to its own data by
itself. Statisticians call this **hierarchical pooling** (or shrinkage). Example: Cardio Bunny has not had a full
Ramadan in its own data (it started 2026-03-16 [DD10]), so its Ramadan uplift starts from women's apparel across
Opptra brands, from Opptra's measured peaks [03] and from the published range of about 1.3x-1.8x [02b]. It is
updated after Ramadan 2027.

Two more sources of signal:
- **Brand principals' data.** Opptra operates brands for their owners. We ask principals for sales by style and
  size in their other markets and use them as a *relative* signal ("this style ranks in the top 10% globally"),
  not as GCC volumes.
- **Marketplace signals.** Price, discount and best-seller rank from Scout and the bought feeds show demand
  shifts before our own sales do.

### 9.3 New products (cold start)

For a new style, Mizan finds the 5 to 20 most similar existing options (same category and sub-category, price
band, colour family, fabric and fit from B6) on the same channel (ASSUMPTION range). It takes their sales curve
over their first 8 to 12 weeks, scales it to the brand's current level, and applies any event in the launch
window. If nothing similar exists, it uses the category's average launch curve and marks the forecast "low
confidence".

### 9.4 A challenger model

Once the pilot has enough data, a machine-learning model is trained across all products at once, using event
weeks, price and discount, sizes in stock, rank, channel, category and attributes. It replaces the simple recipe
for a brand only if it beats it in testing by at least 5% (ASSUMPTION threshold). This is called
**champion and challenger**: the current best method stays in charge until something beats it fairly.

### 9.5 How good is it? Measuring before trusting

- **Backtest:** pretend it is a past date, forecast, and compare with what actually happened. Every model and
  every override is scored this way, every week.
- **WMAPE (weighted mean absolute percentage error):** total forecast error divided by total actual sales. Lower
  is better, and it is weighted so best sellers count more than slow items.
- **Bias:** whether the forecast tends to be too high (overbuying) or too low (stockouts).
- **Today's method is always the comparison:** the trailing rate of sale times days, as Replen does now.

### 9.6 Size curves, OTB and markdown risk

- **Size curves** count net kept units by size, only on days when that size was in stock, then smooth towards
  the department's curve where data is thin. Return reasons shift the curve (many "too small" returns on
  size 42 suggests customers should order a size up and the buy should hold more of the next size).
- **OTB** is arithmetic, not AI (formula in F2.2).
- **Markdown risk** starts as a rule: weeks needed to sell current stock at forecast, compared with weeks left
  in the season or before the ageing limit. A learned model can come later, once markdown outcomes are
  recorded.

### 9.7 Reviews and attributes (AI text model)

An AI text model reads each competitor review in Arabic or English and tags it with themes from the fixed,
versioned theme list shared with B7a [DD7]. It also pulls attributes (fabric, length, pockets) out of
competitor listing text. Quality is checked against a labelled sample before results are shown; DD7 plans a
200-review Arabic and English labelled sample for the same purpose [DD7]. Cost is small: DD7 estimates about
USD 0.013-0.021 per 1,000 reviews for theme tagging at a low-cost tier [DD7]. Model names never appear in the
product.

### 9.8 Fallbacks

| If this happens | Mizan does this |
|---|---|
| The forecast job fails, or its output is older than 2 days (ASSUMPTION) | Replenishment uses its trailing rate (today's behaviour). Screens show "forecast stale" |
| The model did worse than today's method for a brand over the last 8 weeks (ASSUMPTION window) | That brand switches back to today's method automatically and is flagged for review |
| No look-alikes found for a new style | Category average launch curve, marked "low confidence" |
| B6 attributes are not available | Look-alikes use category, price band and colour only |
| `sub_category` is null [BRIEF] | Sub-category inferred from the product title by the AI text model, checked by a planner, until B6 and DD0 fill it |
| A competitor feed breaks | Last known data with its "as of" date; switch to the second provider |
| Review tagging fails its quality check | Show ratings and keyword counts only |
| An event date is not yet confirmed (moon sighting) | Use the computed date with a plus or minus 1 day window |
| A day of stock history is missing | Fill from the days around it and flag it |

---

## 10. MVP scope vs later

| Area | MVP (Phase 1 pilot: USPA, Cardio Bunny, one hardline brand) | Later (Phase 2 and after) |
|---|---|---|
| Data | Daily stock history; event calendar; net sales view; pilot feature tables | All brands; principal data feeds; search rank |
| M1 | Event uplift plus base forecast, option x location x week, 16 weeks; cold start for Cardio Bunny; forward rate into Replen (opt-in); accuracy log | Season forecast for all brands; challenger model; lane lead times and decision deadlines for every lane |
| M2 | Size curves by channel and country (pilot softline brands); simple OTB per brand x month; ageing and markdown risk list; hardline reorder list for the pilot hardline brand | Buy proposals with size split for all brands; list and drop per channel; markdown timing; scenario planning ("what if Ramadan moves 1 day") |
| M3 | One Cardio Bunny benchmark (BlissClub, Lululemon where reachable) from a bought, capped scrape and the B7a layer if ready; Namshi fit and returns insight for pilot brands | Daily competitor price and rank at scale; attribute gap matrix across categories; copy-with-pride board and briefs; launch reads |
| Screens | S1, S2, S3, S4, S6, S10, plus a simple S5 and S11, inside gcc-dashboard behind the existing workflow preview switch and sign-in [CR-STATUS] | All screens; partner views (section 16) |

**Out of scope for this product:** pricing and repricing engine; image or content generation and publishing
(catalog module); executing moves, ASNs or purchase orders (Replenishment and ERP); marketing spend; B2B,
wholesale and 1P demand (Replen's sales scope excludes these [DD9], [CR-E2E]); offline store allocation.

---

## 11. Phased roadmap with stage gates

Dates assume approval by 6 Nov 2026 (ASSUMPTION). Each gate has measurable exit criteria. Leadership releases the
next stage's money only when they are met. Costs are Option D figures from [05] section 4 (ASSUMPTION rates).

| Phase | Dates | Goal | Shape | Cost (ASSUMPTION) |
|---|---|---|---|---|
| 0 Prove the basics | 9 Nov - 18 Dec 2026 (6 weeks) | Start stock history, measure the baseline, demo vendors, legal review, quick wins | Inside gcc-dashboard, own datasets | about USD 13k |
| 1 Pilot | 21 Dec 2026 - 30 Apr 2027 (about 4.5 months) | Three pilot brands through Ramadan and Eid 2027 (Ramadan expected to start about 8 Feb 2027 [02]) | Extension of Channel Replenishment | about USD 63k |
| Gate 1 | Early May 2027 | Decide: scale, hold or stop | | |
| 2 Scale | May - Dec 2027 (8 months) | All brands; M2 used for a buy cycle; M3 monthly; tested on back to school, 11.11 and White Friday 2027 | Still an extension, built to separate | about USD 155k |
| Gate 2 | Jan 2028 | Decide: graduate to own product | | |
| 3 Own product and partner offer | From Jan 2028 | Own product, own PM; partner views | Stand-alone product | about USD 240-250k a year |
| Gate 3 | End of 2028 | Decide: offer to brand partners at scale | | |

### Quick wins in Phase 0

- **White Friday 2026 uplift table** for USPA, Nautica and the softline brands that saw White Friday 2025,
  using the uplifts [03] already measured (+50% to +64%). It goes to the planners as a manual input to
  Replenishment. Only if approved by about 6 Nov, because the 2025 event ran from 22 to 29 Nov [02].
- **Ramadan 2027 uplift table** for the pilot brands by 18 Dec 2026, so stock moves for Ramadan can use it even
  before the Phase 1 build is live.
- **Cardio Bunny one-off competitor read** from a capped, bought scrape, the cheapest test DD10 proposed
  (USD 1.50 to 7.50 per 1,000 reviews [DD10]; cap USD 500, ASSUMPTION). Only with the owner's yes and after a
  legal check.

### Gate 0 exit criteria (end of Phase 0)

| # | Criterion | Measure |
|---|---|---|
| G0.1 | Stock history is running | `stock_snapshot_daily` has run for at least 21 days in a row with no gap |
| G0.2 | Baseline measured | The baseline exists [03]. Add a backtest of today's method's error (WMAPE) on Ramadan 2026 and White Friday 2025 for USPA and the pilot hardline brand |
| G0.3 | Buy option tested | Demos with Increff and Toolio and a trial with one data vendor, with written answers to the question list in [05] section 7; the build-or-buy call for M2 recorded |
| G0.4 | Data sourcing policy | Policy drafted and legal review started; no collection beyond the approved one-off |
| G0.5 | Owners named | Product owner; M1 and M2 business owner (Ashish or Mahesh); M3 business owner (Nitin); hardline pilot brand chosen |
| G0.6 | Replenishment change agreed | Replen owners agree in principle to the forward-rate opt-in (spec v1.6) |
| G0.7 | Missing planning inputs | Supplier lead times for the 3 pilot brands collected from the brand and buying teams; a unit-cost source agreed with Finance (neither is usable in the warehouse today [03]) |

### Gate 1 exit criteria (after Ramadan and Eid 2027, pilot brands)

| # | Criterion | Target (proposal; [02b] B3 base is a 20% lower forecast error) |
|---|---|---|
| G1.1 | Forecast accuracy | WMAPE at option x location x week, 4 weeks ahead, at least 15% lower than today's method over the Ramadan and Eid window, and at least 10% lower over the whole pilot |
| G1.2 | Cold start | Cardio Bunny new styles: first-8-week error at least 10% lower than a category-average rule |
| G1.3 | Availability | USPA options with 3 or more sizes in the Noon and Namshi pool during Ramadan at least 5 points higher than in the 4 weeks before the pilot started, and better than non-pilot brands over the same weeks (Cut Size history [CR-E2E]) |
| G1.4 | Adoption | Forward rate switched on in Replenishment for at least 2 of the 3 pilot brands; weekly exception list reviewed in at least 80% of weeks; every override has a reason |
| G1.5 | NPD value | One Cardio Bunny benchmark delivered with at least 300 competitor reviews analysed (ASSUMPTION threshold), and at least one product or size decision taken from it, confirmed by Nitin |
| G1.6 | Data and cost | No more than 2 missing days of stock history in 120; run cost (GCP plus data) under USD 1.5k a month |
| G1.7 | Legal | Data sourcing policy signed off |
| G1.8 | Money and scale | Against the holdout, the stock-out proxy and aged-stock value fall at or above the [04] base rates (20% and 10%), and the annual benefit projected from the measured rates on the revenue run rate of the time is at least USD 376k, the [04] break-even for Option D's 3-year cost (`00-proposal.md` section 6.3) |

**Hold or stop rule at Gate 1:** if G1.1 shows less than 5% improvement, stop the model work, keep the event
calendar and stock history inside Replenishment (the Option A level in [05]) and keep the small M3 under Nitin.
If G1.1 passes but adoption (G1.4) fails, hold Phase 2 money for one cycle and fix the workflow first. If
G1.1 passes but G1.8 fails, hold at the Option A level (about USD 34k a year [05]) and repeat the G1.8 test after
White Friday 2027.

### Gate 2 exit criteria (after White Friday 2027): graduate to own product

| # | Criterion | Target (proposal) |
|---|---|---|
| G2.1 | Coverage | Forecasts for brands making at least 90% of GCC revenue, softline and hardline, at all 6 locations |
| G2.2 | Accuracy at scale | WMAPE at least 15% lower than today's method across covered brands over White Friday 2027 |
| G2.3 | Business result | On brands that used M2 for a full buy cycle: sell-through at planned price +2 points or more against their previous comparable season; aged stock (over 180 days) value down 10%; markdown spend as a share of gross sales down 5% relative. These sit between the conservative and base ranges in [02b] B3 |
| G2.4 | Adoption | OTB and size split approved in the product for at least one buy cycle for all softline brands; M3 used monthly (at least 3 NPD briefs) |
| G2.5 | Graduation triggers | At least 12 months of history for brands with at least 80% of revenue; backlog requests from at least 3 user groups (planning, buying, NPD) that no longer fit the gcc-dashboard roadmap |

### Gate 3 exit criteria (end of 2028): offer to brand partners

| # | Criterion | Target (proposal) |
|---|---|---|
| G3.1 | Partner use | At least 2 brand partners use partner views monthly |
| G3.2 | Contracts | Data-sharing clauses signed in at least 2 partner contracts |
| G3.3 | Partner value | Partners cite Mizan output in at least 2 quarterly business reviews |
| G3.4 | Commercial model | Bundled vs paid add-on decided (section 16) |
| G3.5 | Safety | No incident of one partner seeing another's data |

---

## 12. Team needed per phase (Option D)

FTE means full-time equivalent (1.0 = one person full time). People are India-based (ASSUMPTION; cost rates in
[05] section 4). Business time is not costed.

| Role | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Notes |
|---|---|---|---|---|---|
| Product owner / PM | 0.5 | 0.5 | 0.75 | 1.0 | Sujan as product owner through Gate 2; a dedicated PM from Phase 3 |
| Senior data scientist | 0.5 | 1.0 | 1.0 | 1.0 | Hire or contract before Phase 1; the critical path |
| Data scientist (mid) | - | - | 0.5 | 0.5 | Size curves, markdown risk, NPD analytics |
| Data engineer | 1.0 | 1.0 | 1.0 | 1.0 | gcc-dashboard team first; stock history, feeds, tables |
| Full-stack engineer | - | 0.5 | 0.75 | 0.5 | Screens in the gcc-dashboard shell (React and FastAPI [BRIEF]) |
| Planning / NPD analyst | - | 0.5 | 1.0 | 1.0 | Event calendar upkeep, competitor sets, briefs |
| Partner success | - | - | - | 0.5 (year 3) | Only if Gate 3 is in sight |
| **Total FTE** | **2.0** | **3.5** | **5.0** | **5.0-5.5** | |
| Business time (not costed) | Ashish and Mahesh 2-3 h a week each; Nitin 2 h a week; pilot brand managers 2 h a week (ASSUMPTION) | same | same, plus Finance for OTB | same | |

---

## 13. Operating model and ownership

### 13.1 Who owns what

| Role | Who | Responsible for |
|---|---|---|
| Executive sponsor | To be named by leadership | Gate decisions, funding, priority calls across teams |
| Product owner | Sujan (GCC tech and product) through Gate 2; dedicated PM from Phase 3 | Roadmap, backlog, gate evidence, contracts with Replen, Scout and catalog |
| Business owner, M1 and M2 | Ashish and Mahesh (replenishment and demand planning) | Accept forecasts and the forward rate in Replenishment, event calendar, OTB process |
| Business owner, M3 | Nitin Kiran (NPD and catalog) | Competitor sets, theme review, briefs, launch decisions |
| Engineering | gcc-dashboard team (Sujan, Vijay PK) plus the data scientist | Build and run; same release process as Replenishment |
| Data stewards | Master data owners; buying team; Finance | Fix master gaps (816 missing SKUs [CUT-UP]; null `sub_category` [BRIEF]); keep supplier lead times and unit costs up to date (no usable source today [03]) |
| Legal | Opptra legal | Data sourcing policy, marketplace terms, partner data clauses |
| Finance | Opptra finance | OTB sign-off; value tracking at each gate |

### 13.2 Relationship with Channel Replenishment

- **Replenishment stays the execution engine** for stock moves: lanes, allocation, ASN sheets, Cut Size. It
  stays owned by the gcc-dashboard team with Ashish and Mahesh as business owners [DD10].
- **Mizan is the planning layer**: demand, events, buys, sizes, assortment and NPD. It publishes forecasts;
  Replenishment chooses, brand by brand, to use the forward rate.
- **Replenishment never depends on Mizan to run.** If Mizan is down, Replen behaves exactly as today.

### 13.3 Resolving DD10's recommendation by staging

DD10 recommended: forecasting (B8) goes inside Channel Replenishment, starting with a seasonal uplift on the
existing rate of sale; NPD insight (B7b) becomes a small separate product owned by Nitin's team; and a new
separate product for forecasting is "premature with under 12 months of history for most brands" [DD10].

This plan agrees with DD10 for now and sets out when that changes:
- **Phases 0 and 1 follow DD10's path.** The seasonal uplift feeds Replenishment. Cardio Bunny competitor
  insight starts with a one-off bought scrape under Nitin. The team and release process are gcc-dashboard's.
- **The difference: it is built to separate from day 1.** It has its own datasets (`demand_intel_*`), its own
  jobs and its own module code, so graduating later is a change of ownership, not a rewrite.
- **It graduates at Gate 2**, and only if G2.5 is met. The reasons to graduate then:
  1. M2 (buying, sizes, OTB) and M3 (NPD) are not replenishment problems.
  2. The product must cover all brands including hardlines, and Replenishment is softline only [CR-E2E].
  3. One data layer serves all three modules.
  4. The brand-partner offer needs a product with its own identity.
  5. By then most revenue will have 12 months or more of history, which answers DD10's main objection.
- **If Gate 2 is not met,** Mizan stays an extension of Replenishment and M3 stays a small product under Nitin,
  which is exactly DD10's recommendation.
- **What graduation changes:** a dedicated PM and budget line, its own backlog and release cycle, and its own
  name in the partner pitch. The screens can stay in the gcc-dashboard shell, with shared sign-in and roles
  [CR-STATUS], or move to a separate app. Decide this at Gate 2.

### 13.4 Working rhythm

- Weekly (Monday): demand review. Planners clear the exception list, approve forward rates and log overrides.
- Monthly: OTB review with brand managers and Finance; NPD review with Nitin.
- Quarterly: gate or health review with the executive sponsor using the scorecard (S11).

---

## 14. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|
| Short history gives poor forecasts | High | High | Borrow strength across products and brands (9.2); start uplifts from published ranges [02b]; ask principals for data; show ranges, not single numbers; champion and challenger; fall back to today's method; Gate 1 measures it before money scales | Data scientist |
| Growth is mistaken for seasonality | High | Medium | Separate trend and launch-ramp terms based on listing counts and stock breadth (9.1); backtest across the growth period; forecast in units because the revenue measure changed on 2026-08-01 [03] | Data scientist |
| Out-of-stock days hide demand | High | High | Start the daily stock history in Phase 0 (there is none today [CR-E2E]); use in-stock days only | Data engineer |
| Scraping legality and robots.txt | Medium | High | Written data sourcing policy signed by legal; prefer licensed feeds where the vendor carries compliance; collect only public pages; respect robots.txt (cardiobunny.com blocks scrapers [BRIEF], so ask the principal for data instead); check each marketplace's seller terms before collecting where Opptra also sells [02]; no logins; no personal data; takedown process | Legal, product owner |
| Bought feeds break or are abandoned | Medium | Medium | Community scrapers have small user bases (26 monthly users on the noon actor [02]); use two providers; contract tests on field completeness; show "as of" dates; monthly spending caps | Data engineer |
| Low adoption by planners | Medium | High | Build into their current tools and habits (Replen download, Cut Size); weekly review ritual; overrides with reasons; adoption is a gate criterion (G1.4) | Product owner, Ashish, Mahesh |
| Low trust in the model | Medium | High | Explain every number in plain words; publish accuracy against today's method every week; score overrides too; humans approve; no auto-execution in Phases 0-2 | Product owner |
| Master data gaps | High | Medium | Depend on B6 and DD0 for attributes and sub-category; meanwhile infer sub-category from titles with checks; raise the 816 missing SKUs with master owners [CUT-UP] | Data stewards |
| Planning inputs missing (supplier lead time, unit cost, GCC ageing, AOP history) | High | High | Collect lead times and unit cost in Phase 0 (G0.7); build ageing from receipts as [03] did; treat AOP as a check, not an input, until more months exist [03] | Product owner, Finance, buying team |
| One brand dominates the results | High | Medium | USPA is 72% of softline and 46% of GCC revenue [03]; report accuracy per brand; gate criteria for Cardio Bunny and the hardline brand too | Product owner |
| Marketplaces control promotions and prices | High | Medium | Record marketplace event dates and promotion participation as inputs; markdown suggestions are nominations, not price changes | Planners |
| Supply cannot react (long principal lead times) | Medium | Medium | Season forecast 6-12 months ahead; "order by" dates once supplier lead times are collected (none usable today [03]); value counted only where buys can change | Brand managers |
| Key-person risk (one data scientist) | Medium | High | Plain documentation in the repo; pair with the data engineer; shared code patterns with Replenishment | Product owner |
| Scope creep and overlap with catalog or Replen | Medium | Medium | Read-only contracts (8.5); out-of-scope list (section 10); DD10 boundary | Product owner |
| Cost overrun | Low | Medium | Stage funding; run cost is a gate criterion (G1.6) | Executive sponsor |
| Partner data leaks across brands (Phase 3) | Low | High | Separate partner views by brand; aggregated benchmarks only; contract clauses; access logs | Product owner, Legal |

---

## 15. Success metrics

**North star: sell-through at planned price.** Units sold at or above the planned selling price, divided by
units available in the period, per brand and season. It rises when we stock out less (more sold) and when we
overbuy less (fewer markdowns), so it captures both halves of the job. Target: +3 points over 2 seasons on brands
using the product ([02b] B3 base; conservative +1, high +5). Today's 90-day sell-through at all prices is 38%
for softline, 48% for hardline and 40% for the GCC [03]. The "at planned price" split needs a planned price per
style, which does not exist yet; Phase 1 sets it for the pilot brands.

| Type | Metric | Target (proposal) | Source of target |
|---|---|---|---|
| Input | Forecast error (WMAPE) vs today's method | 20% lower (gate floor 15%) | [02b] B3 |
| Input | Options with 3 or more sizes in stock, Noon and Namshi pool | +5 points on pilot brands | ASSUMPTION; baseline from Cut Size [CUT] |
| Input | Stock-out proxy (demand on zero-stock SKU-locations, USD a day) and stockout days on the top 20% of options | 20% lower; baseline USD 1.4k-6.7k a day softline [03] | [02b] B3 lost-sales base |
| Input | Share of selling SKU-locations under 14 days of cover / over 120 days | Both lower; baseline 48% / 19% [03] | ASSUMPTION |
| Input | Markdown spend as a share of gross sales | 10% lower relative; baseline not yet measured | [02b] B3 |
| Input | Aged stock over 180 days, by value | 10% lower; baseline up to 41% of stock value [03] | ASSUMPTION, close to the [02b] inventory range |
| Input | Size or fit returns share on Namshi | 3% lower relative | [02b] B3 return-rate base |
| Input | New styles reaching target sell-through in 8 weeks | +5 points, to be proven by an A/B test on one brand | [02b] B3 (no published evidence; option value) |
| Adoption | Share of pilot replen and buy decisions made with Mizan open | 80% | ASSUMPTION |
| Adoption | Weekly active planners and brand managers | All pilot owners, every week | ASSUMPTION |
| Trust | Model error vs override error | Overrides beat the model less than half the time | ASSUMPTION |
| Guardrail | Total inventory value per USD of sales | Must not rise; availability is not bought with extra stock | [02b] B2 (levers trade off) |
| Guardrail | Replenishment run success | Unchanged; Mizan never blocks Replen | [CR-STATUS] |
| Guardrail | Run cost (GCP plus data) | Under USD 1.5k a month in pilot; under USD 2.6k a month at scale | [05] section 4 |
| Guardrail | Personal data stored; data sourcing breaches | Zero | Section 5 |

---

## 16. Offering it to brand partners

Opptra is a brand operator. Partners choose an operator that can show it understands GCC demand. opptra.com
already claims demand anticipation and "Revenue and volume forecasting" [DD10]. Mizan makes that claim
provable.

What partners could get (Phase 3, after Gate 2):
1. **Pre-signing "GCC opportunity read" for a prospective brand.** A look-alike demand estimate, size curves by
   country, an event plan and a competitor price map. This is a sales tool for Opptra's business development.
2. **Season buy recommendation shared with the principal.** Quantities, size split and event timing, which makes
   the principal's production planning easier.
3. **Quarterly "voice of the GCC customer".** Review themes, fit issues and attribute gaps against competitors.
   This feeds the principal's product development (copy with pride, done by the brand owner).
4. **Read-only partner view.** Their own brand's demand, stock health and competitor position.

Commercial options (decide at Gate 3):
- Included in Opptra's operating fee as a differentiator (default).
- A paid analytics add-on for larger partners.
- A data exchange: the principal shares global style and size data, and Opptra shares GCC insight in return.
  This also improves cold-start forecasts (9.2).

Guardrails: one partner never sees another partner's data; competitor data is shown only as public or
aggregated benchmarks; partner data clauses in contracts; access logs.

---

## 17. Decisions and open questions for leadership

1. Name an executive sponsor.
2. Approve Phase 0 (about USD 13k) and the daily stock history job now.
3. Pick the hardline pilot brand. Hardline brands per the brand family function: Bergner, Carote, Nutricook,
   NutriBullet, GTPlayer, Tower, Dowinx, Qubo, Nuwey [SPEC]. Suggestion: GTPlayer, which has the longest
   hardline history (12 months, part of White Friday 2025 and Ramadan 2026, USD 1.52M TTM). The alternative is
   Nutricook, the largest hardline brand (USD 1.87M TTM, 10 months) [03].
4. Hire or contract the senior data scientist. Without one in place by Phase 1, the pilot misses Ramadan 2027
   and Gate 1 moves to after White Friday 2027.
5. Will brand principals share global style and size data? This needs one conversation per principal.
6. Lane transfer times, especially Noon FBN UAE to KSA (unknown today [CR-E2E]), and supplier lead times per
   brand and origin (none usable in the warehouse [03]).
7. Unit cost, contribution margin and markdown spend per brand, for OTB at cost and for the value model.
   [03] could not measure them, because receipt values do not give a usable unit cost.
8. Legal: marketplace seller terms on data collection; the Lululemon regional site's terms and robots.txt.
9. Who builds the Scout `reviews` entity and `review_observation` table (DD7 question 1 [DD7]).
10. When the catalog B6 attributes view will be available.
11. Confirm the working name "Mizan" after trademark and connotation checks.

---

## 18. Glossary

| Term | Meaning |
|---|---|
| AOP | Annual operating plan: revenue targets per brand, month and channel |
| Backtest | Testing a forecast on past dates and comparing it with what actually happened |
| Champion and challenger | Keep the current best method until a new one beats it in fair tests |
| Cold start | Forecasting something with no sales history yet (a new style or brand) |
| Cut (size) | An option with fewer than 3 sizes in stock, so it sells poorly [CUT] |
| Days of cover (DoC) | How many days current stock lasts at the current rate of sale |
| FBN | Fulfilled by Noon: stock held in noon's own warehouses |
| Hierarchical pooling | Letting a product with little data borrow from its group (brand, category, all) |
| Look-alike | An existing product similar enough to estimate a new one from |
| NPD | New product development |
| OTB (open to buy) | Money or units still available to buy in a period after planned sales, planned closing stock, markdowns, opening stock and orders already placed |
| P50, P80 | Likely value (half the time actual is higher) and safe-high value (actual is higher only 1 time in 5) |
| Rate of sale (ROS) | Units sold per day |
| Sell-through | Units sold divided by units available in the period |
| Size curve | Share of demand by size |
| WMAPE | Weighted mean absolute percentage error: total forecast error divided by total actual sales |

---

## 19. Sources

| Tag | Source |
|---|---|
| [BRIEF] | Facts stated in the proposal brief of 2026-10-26 (from the requester): softline about USD 9.2M TTM, 9 softline and 7 hardline brands, channels, 6 locations, Replen v2 behaviour, Scout status, gaps, user asks |
| [02] | `docs/plans/proposals/2026-10-26-demand-assortment-intelligence/02-market-scan.md` |
| [02b] | `docs/plans/proposals/2026-10-26-demand-assortment-intelligence/02b-gcc-context-and-benchmarks.md` |
| [03] | `docs/plans/proposals/2026-10-26-demand-assortment-intelligence/03-baseline-metrics.md` (read from BigQuery on 2026-10-26: TTM revenue by brand, history depth, measured event uplifts, cover, stock-out proxy, ageing proxy, returns, lead time and AOP gaps, Cardio Bunny deep cut) |
| [04] | `docs/plans/proposals/2026-10-26-demand-assortment-intelligence/04-roi-method.md` and `04-roi-model.xlsx` |
| [05] | `docs/plans/proposals/2026-10-26-demand-assortment-intelligence/05-build-vs-buy.md` |
| [DD7] | `docs/plans/deep-dives/07-review-ingestion-enhancement.md` (B7b section and cost table) |
| [DD9] | `docs/plans/deep-dives/09-business-impact.md` (section 4 revenue base and returns; section 11 B7b and B8) |
| [DD10] | `docs/plans/deep-dives/10-boundary-forecasting-npd.md` |
| [SPEC] | `docs/SPEC.md`, "Brand master and Opptra SKU id mapping" (brand families, `master_sl`, warehouse location) |
| [CR-STATUS] | `C:\Users\Sujan Ajay\Desktop\gcc-dashboard\docs\channel-replenishment\STATUS.md` (last checked 15 Oct 2026; schedule, latest run totals, workflow preview switch) |
| [CR-E2E] | `C:\Users\Sujan Ajay\Desktop\gcc-dashboard\docs\channel-replenishment\Channel_Replenishment_v2_End_to_End.md` (scope "Softlines only", 6 locations and 10 lanes, 14-60 day window, retention 31 and 400 days, section 19.11 "no stock history anywhere") |
| [CUT] | `C:\Users\Sujan Ajay\Desktop\gcc-dashboard\docs\channel-replenishment\cut-size\REQUIREMENTS.md` (USPA AE 424 options, 246 with 3 or more sizes) |
| [CUT-UP] | `C:\Users\Sujan Ajay\Desktop\gcc-dashboard\docs\channel-replenishment\cut-size\UPSTREAM_REQUESTS.md` (816 in-stock SKUs missing from `master_sl`) |
| [SCOUT] | `C:\Users\Sujan Ajay\Desktop\opptra-scrapers\adapters\__init__.py` (GCC adapters marked STAGED; product entity only) and `engine\contracts.py` (`reviews` and `search` entities declared) |

Paths without a drive letter are relative to `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\01-intent-map`.

---

## Change note (2026-10-26)

Section 0 ("Cost and value") and the cost paragraph after the section 1 table were corrected to match the ROI
model in `04-roi-method.md` and `04-roi-model.xlsx`. The earlier text quoted about USD 0.86M of value over 3 years
(base) and USD 0.17-0.29M a year on softline, taken from the first draft of [05] section 5. That draft assumed
markdown spend of 20% of gross sales, about twice the [04] base, and a revenue path of USD 12M, 15M and 18M.
Gate 1 gained criterion G1.8 (money and scale test) because, in [04], passing Gate 1 on accuracy alone still
leads to a negative base case. [04] was added to the sources.
