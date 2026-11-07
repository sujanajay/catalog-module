# Mizan: demand, assortment and NPD intelligence for Opptra GCC - investment proposal

Date: 2026-10-26. Status: for decision. Nothing has been built, bought or scraped.
Audience: Opptra leadership and the GCC business team (Nitin Kiran - NPD and catalog; Ashish and Mahesh -
Channel Replenishment; Finance).
"Mizan" (Arabic for "balance") is a working name only, pending trademark and connotation checks.

How to read the numbers: money is in US dollars (USD); "k" means thousands and "M" millions. Every number has a
source tag in square brackets, listed in the appendix. [calc] marks a number worked out for this proposal from
the ROI workbook (`04-roi-model.xlsx`); the method is in Appendix B. ASSUMPTION marks an estimate that still
needs Finance or business confirmation.

---

## 1. Executive summary

**The ask.** Fund a pilot of about **USD 84k** (Phases 0 and 1, November 2026 to April 2027) on three brands
through Ramadan and Eid 2027 [04]. Decide on the full product only at Gate 1 in May 2027, using measured
results from the pilot and a revenue test.

**The problem.** Opptra plans GCC stock from recent sales only. The GCC calendar moves every year and most of
our brands have less than a year of history. The results show up in our own data [03]:
- Stock is short and long at the same time: 48% of selling softline SKU-locations have under 14 days of cover,
  while 19% have over 120 days.
- Up to 41% of stock value is over 180 days old (an upper bound).
- Up to USD 6.7k a day of softline demand lands on SKU-locations with no stock.
- On Namshi, USD 682k of sales a year come back as size or fit returns.

**The product.** Mizan is a planning layer with three modules on one data layer [06]:
- **M1 Demand Planner:** event-aware forecasts for Ramadan, Eid and White Friday that still work for new brands.
- **M2 Assortment and Buy Planner:** size curves, open to buy and ageing risk.
- **M3 NPD and Competitor Insight:** competitor price, rank and review themes, so NPD can "copy with pride".

It reuses Channel Replenishment, Scout and the BigQuery warehouse. It buys raw competitor data instead of
building scrapers.

**The numbers.** At today's revenue (USD 13.4M gross a year), the full product does not pay back in
3 years in the base case [04]:

| 3-year view, full product (Option D, USD 0.68M) | Low | Base | High |
|---|---|---|---|
| Annual benefit at full adoption | 54k | 184k | 525k |
| 3-year NPV (net present value, at 12%) | -638k | **-296k** | +339k |
| One-time cash freed from lower stock (shown separately) | 191k | 353k | 486k |
| Annual benefit needed to break even | 558k | 376k | 331k |

The base case needs about twice today's benefit to break even within 3 years. That happens at about **USD 29M
of gross GCC revenue a year**, 2.15 times the last 12 months [calc]. How soon Opptra gets there depends on growth
(section 6.3) [calc]:

| Growth a year, in units | Years to reach about USD 29M | 3-year NPV, base | 5-year NPV, base |
|---|---|---|---|
| 10% (the ROI model's cap) | about 8 | -261k | -281k |
| 30% | about 3 | -185k | +20k |
| 50% | about 2 | -100k | +441k |

Actual growth has been far faster than 10%. GCC units were up 49% in the last 6 months against the 6 before, and
the current unit run rate is already about 1.2 times the last 12 months [03], [calc]. But almost all of that came
from new brands and channels. Like-for-like demand is flat: U.S. Polo Assn. units are -1% over the same
comparison [03]. So the case for the full product rests on Opptra's launch pipeline, not on demand from today's
brands. Scale at Gate 1 only if the money and scale test (G1.8) passes: the money levers run at or above the
base rates, and the benefit projected on the revenue run rate clears USD 376k a year, through higher rates,
more revenue, or both.

**Why fund a pilot anyway.**
- **The pilot caps the downside at about USD 84k** [04]. Funding the full product up front has an expected NPV of
  -437k; the stage-gated route has -185k. Stage-gating is worth about +252k [04]. (Both figures assume a 50%
  chance of passing Gate 1 and the base case after it; see section 6.4.)
- **The pilot is the same size as the cheapest option.** "Mizan Lite", an extension of Channel Replenishment, costs
  USD 69k in year 1 [05]. The pilot gives that plus a test of buy planning, a hardline brand and competitor
  insight.
- **The strategic value is not in the ROI,** and it is shown separately (section 6.6):
  - The product covers all brands, including hardline, which Replenishment does not cover today.
  - It supports the brand-partner pitch. opptra.com promises "Revenue and volume forecasting", but there is no
    forecast table behind that claim [DD10].
  - It gives NPD evidence for Cardio Bunny against BlissClub and Lululemon.

**Decisions requested** (section 10): the pilot budget, an executive sponsor, the B8 and B7b ownership, the pilot
brands, Increff and Toolio demos, a legal review of data sourcing, and Finance confirmation of margin and markdown
spend.

---

## 2. The problem, with evidence

Opptra operates 18 brands with sales in the last 12 months: 9 softline (clothing and footwear) and 9 hardline
(kitchen and home goods). Together they sold USD 13.39M gross including VAT (314k units) in the 12 months to
21 October 2026. Softline is USD 8.46M and hardline USD 4.93M (37%). After cancellations and returns, net revenue
is USD 12.04M. U.S. Polo Assn. (USPA) alone is 46% of GCC revenue [03].

Stock moves today come from Channel Replenishment v2. It sets stock levels from a "trailing rate of sale": the
average daily sales over the last 14 to 60 days. Its own investigation says this window "lags the season
everywhere" [06]. It covers softline only [06].

| # | What goes wrong | Evidence from our data | Source |
|---|---|---|---|
| 1 | **Events are large and the trailing rate misses them** | White Friday 2025 lifted daily revenue +50% to +64% against the surrounding 4 weeks. Ramadan 2025 lifted USPA about +50%. The two peak Ramadan 2026 weeks ran +35% to +60% above February, then fell in Eid week. Ramadan moves about 11 days earlier each year; Ramadan 2027 is expected to start about 8 Feb 2027 | [03], [02] |
| 2 | **History is short** | Only USPA and Nautica cover two Ramadans. 15 of 18 brands started selling on or after 29 Oct 2025, and 10 of them in 2026. Any forecast must work with 3 to 12 months of history (the "cold start" problem) | [03] |
| 3 | **Growth hides the pattern** | Most growth comes from new channels and brand launches. USPA Q3 2026 units are +188% on Q3 2025 (mostly the KSA launch), but flat (-1%) over the last 6 months against the 6 before | [03] |
| 4 | **Stock is short and long at once** | Softline replenishment run of 25 Oct 2026: 48% of selling SKU-locations under 14 days of cover, 19% over 120 days; 16,146 SKU-locations hold stock with no sale in the window | [03] |
| 5 | **Demand is lost where stock is not** | USD 1.4k to 6.7k a day of softline demand sits on SKU-locations with zero stock. This is a proxy (an indirect signal), not measured lost sales. 63% of it is on SKUs that have stock in another location, so much of it is a placement problem | [03] |
| 6 | **Moving stock cannot close the gap** | 15 Oct 2026 run at a 60-day cover target: 28,428 units required, 4,893 moved, 23,535 unfilled. The rest needs better buying, and no forecast or open-to-buy table exists | [06] |
| 7 | **Stock is ageing** | About 66% of the USD 6.5M of stock (at selling price) is over 90 days since receipt and 41% over 180 days. This is an upper bound; the proxy overstates USPA's age | [03] |
| 8 | **Fit drives returns** | 13% of softline gross value is returned. Namshi size or fit returns are USD 682k a year, 71% of returns that carry a reason | [03] |
| 9 | **Size runs break** | USPA UAE: 42% of options are "cut" (fewer than 3 sizes in stock) | [06] |
| 10 | **Planning inputs are missing** | No usable GCC supplier lead time (purchase orders are raised when goods arrive); unit cost cannot be read from receipts; GCC targets (AOP, the annual operating plan) exist for June to August 2026 only; there is no stock history anywhere | [03], [06] |
| 11 | **NPD has no data** | No competitor or review table exists. None of the 91 Cardio Bunny Namshi listings that Scout (Opptra's own listing scraper) sees has a rating or review | [03], [DD10] |
| 12 | **Hardline is not covered** | Hardline is 37% of revenue; Channel Replenishment is "Softlines only" | [03], [06] |

**Data quality warnings found while measuring** [03]:
- The replenishment tables store each SKU three times per run, so anyone who sums them directly triples the stock.
- The revenue measure changed on 1 Aug 2026, so USD per unit jumped 13% to 22% overnight for four brands. Growth
  is therefore measured in units.

---

## 3. What Mizan is

Mizan tells each brand team what to buy, how much, in which sizes, for which marketplace and warehouse, and
when. It handles Ramadan and White Friday, and brands that launched last month [06].

### 3.1 The three modules

| Module | What it does | Who uses it | What they get |
|---|---|---|---|
| **M1 Demand Planner** | Event calendar for Hijri (Islamic calendar) events, marketplace sales, Founding Day and payday. Each event gets an "uplift": how much it lifts demand, learned per brand where history exists and borrowed from similar products where it does not. 16-week forecasts by option and location, with a likely value and a safe-high value. Cold-start forecasts for new styles from look-alikes. A "forward rate of sale" that Replenishment can use instead of the trailing rate, brand by brand | Ashish, Mahesh (demand planners); brand managers | Stock at Noon FBN (Fulfilled by Noon, noon's own warehouses) and our own warehouses before the event, not after it. "Last day to move" dates |
| **M2 Assortment and Buy Planner** | Size curves (share of demand by size) per channel and country, adjusted by return reasons. Open to buy (OTB): what is left to spend per brand and month after planned sales, closing stock, markdowns and stock on order. Buy proposals with size and UAE/KSA split. Ageing and markdown risk. List-and-drop per channel. A hardline reorder plan | Buyers, brand managers, Finance | Buys that hit AOP without leftover sizes; early warning on stock going stale; hardline covered for the first time |
| **M3 NPD and Competitor Insight** | Competitor sets chosen by the NPD owner. Price and promotion ladder, rank, and review themes in Arabic and English. An attribute gap matrix (what competitor best sellers have that ours lack). A "copy with pride" board that turns this into a one-page brief. A read of each launch's first 8 weeks | Nitin Kiran (NPD lead) | Evidence for what to make or source next, how to size it and where to price it |

The modules feed each other. An NPD brief sets a cold-start launch quantity. That quantity gets a size split and
then a buy within OTB. Sales, returns and reviews then flow back into the next brief [06]. All three need the
same product, sales, stock and competitor data, so one data layer serves them all instead of three tools
building it three times.

### 3.2 Rules the product follows [06]

- **Decisions, not dashboards.** Every screen ends in a decision: move, buy, size split, markdown, list, or brief.
- **Explain every number**, for example "Ramadan uplift x1.5, learned from USPA 2025 and 2026".
- **People approve.** In Phases 0 to 2 it never executes a move, purchase order or price change by itself.
- **Never worse than today.** If a forecast is missing, stale or loses to today's method, the product falls back
  to today's method and says so.
- **Read only on other teams' systems.** Replenishment never depends on Mizan to run.
- **No personal data.** No reviewer names and no order numbers.

---

## 4. How it helps

### 4.1 A day in the life, per persona

All screen numbers below are placeholders from the design wireframes [06], not data.

**Ashish or Mahesh, demand planners, Monday morning.**
- *Today:* they download the Replenishment proposal, which uses the last 14 to 60 days of sales. In early February
  that window holds no Ramadan, so it under-sends to Noon FBN KSA.
- *With Mizan:* the home screen shows "Ramadan in 1 week, expected demand x1.5 (USPA)" and "38 options run short
  at Noon FBN KSA". They approve the Ramadan forward rate for USPA and Cardio Bunny, review the overrides that
  missed last week, and the Replenishment run uses the new rate. If Mizan is down, Replenishment runs as today.

**A brand manager, planning next season with the principal.**
- *Today:* AOP targets sit in the Internal Brand Dashboard, and the plan lives in spreadsheets.
- *With Mizan:* they see a season forecast by channel, country and event, reconciled with AOP, and an OTB per
  month. They export a buy proposal with sizes and the UAE/KSA split as an XLSX for the principal.

**A buyer, placing an order.**
- *Today:* no system holds a size split per country or channel [DD10].
- *With Mizan:* the size curve screen shows, for example, that Noon UAE stock is short on sizes 40 and 41
  against demand, and that "too small" returns are high on size 42. The buy holds more of the short sizes, and
  the catalog team gets a "runs small" note for the size chart.

**Nitin Kiran, NPD lead, monthly NPD review.**
- *Today:* no competitor data, and no reviews on our own Cardio Bunny listings.
- *With Mizan:* a benchmark of Cardio Bunny leggings against BlissClub and Lululemon on price band, rating, most
  praised and most criticised themes, and attribute gaps such as side pockets or a longer, modest top. He picks a
  shortlist and sends a brief to the principal.

**Leadership and Finance, quarterly.**
- *With Mizan:* a scorecard shows the north star metric (sell-through at planned price), forecast error against
  today's method, size availability, aged stock, run cost, and how many gate criteria are met.
- They release the next stage's money only against that scorecard.

### 4.2 Worked example: Cardio Bunny

Cardio Bunny is a women's activewear brand that launched on Namshi in mid-March 2026 [03].

**Where it stands today** [03]:
- USD 93k gross in its first 7 months, 86% of it on Namshi. Sweatshirts, T-shirts and leggings are 63% of revenue.
- 7,404 units in stock, about 217 days (7 months) of cover at the last 90 days' pace. 90-day sell-through
  (units sold divided by units sold plus units on hand) is 29%.
- Stock and demand do not match by category:
  - Tops sell through at 48% and leggings at 41%. They are out of stock in 31 of 59 and 33 of 72 selling
    SKU-locations.
  - Sweatshirts hold the most stock (2,715 units) at 26% sell-through, going into the cooler months.
- No Namshi listing has a rating or review. The only customer signal is USD 14k of size or fit returns.
- It has never had a full Ramadan, so it has no event history of its own.

**What the pilot would do** [06]:
1. **M1, cold start and Ramadan.**
   - Cardio Bunny borrows its Ramadan 2027 uplift from women's apparel across Opptra brands, from our measured
     peaks, and from the published range of about 1.3x to 1.8x [02b].
   - New styles get a first-8-week forecast from look-alikes.
   - The test: is first-8-week error at least 10% lower than a category-average rule (Gate 1, G1.2)?
2. **M2, stock and sizes.**
   - The ageing list flags the sweatshirt stock for a marketplace event or a channel move.
   - Tops and leggings get a deeper repeat buy, with a size split adjusted by "too small" or "too big" returns.
3. **M3, competitor insight.**
   - A capped, bought scrape of competitor reviews costs about USD 500 [05]. It runs only after a legal check.
   - Where competitors sell, and what that means for the benchmark:
     - BlissClub appears to sell only in India (own site, Myntra, Amazon.in), with no GCC launch found [02b].
       Scout already has Myntra and Amazon India adapters [06], so its reviews can come from tools we own. It is a
       reference for design and value pricing, not a shelf competitor.
     - Lululemon sells in the GCC through Majid Al Futtaim, which has 9 KSA stores, and through its regional site
       [02b]. It is the premium reference. Its site needs a legal check before any collection.
     - Neither is confirmed on Namshi, where 86% of Cardio Bunny's sales happen [03]. So in Phase 0 Nitin also
       names two or three women's activewear brands that sit next to Cardio Bunny on Namshi and noon. Those are
       the direct comparison.
   - The test: at least 300 competitor reviews analysed, and at least one product or size decision taken from them
     and confirmed by Nitin (G1.5).
   - The most urgent Cardio Bunny decision does not need competitor data. Sweatshirts are overstocked while tops
     and leggings are out of stock in about half their selling SKU-locations [03]. That is a buy-mix decision
     from our own data, and M2 covers it.

**What it is worth in money:** about USD 2.4k a year at full adoption, 1.3% of the total benefit [04]. Cardio
Bunny alone would never justify the product. It is in the pilot because it is the hardest forecasting case (new
brand, no event history) and the clearest NPD case. The money sits with USPA (40% of the benefit), other softline
brands (25%) and hardline brands (34%) [04].

---

## 5. Market and build vs buy

### 5.1 What the market offers [02]

- **Enterprise suites** (RELEX, Blue Yonder, o9) are quote-only. Third-party estimates put them around six figures
  a year. Their GCC clients are mostly grocery and large store retailers.
- **Mid-market fashion tools.**
  - **Increff** has the best GCC fashion fit: a March 2026 case study with a UAE, Oman and Bahrain fashion group,
    and a past Namshi tie-up.
  - **Toolio** has the closest planning model (OTB and assortment) but no marketplace connectors.
  - **Nextail** starts at about EUR 60k a year and takes 12 to 16 weeks to implement.
- **Cheap replenishment tools** (Inventory Planner, Prediko, Netstock) assume Shopify, Amazon or an ERP as the
  source of truth.
- **No vendor publicly offers connectors for Noon, Namshi, 6thStreet, Styli, Centrepoint and Trendyol GCC
  together.** None documents how it forecasts moving Hijri events with under 12 months of history.
- **Data is cheap.** Listing and review scrapes cost about USD 0.25 to 1.50 per 1,000 records. The NoonSeller
  Data API costs USD 199 per category per month.
- **Peers:** GCC mall retailers buy enterprise suites for store networks. Multi-brand aggregators whose sales sit
  on marketplaces built their forecasting in-house: GlobalBees, Thrasio and Mensa. Opptra looks more like the
  aggregators.

### 5.2 "Copy with pride": buy what exists, build only the gap

This follows Nitin's rule: buy before build.
- **Buy:** all raw competitor data (scrapes, the NoonSeller API, Helium 10 for Amazon). Also buy one planning
  module if a vendor passes our demo.
- **Build:** only what no vendor offers:
  - the GCC multi-marketplace data layer
  - Hijri-event forecasting with short history
  - allocation across Noon FBN and our own warehouses
  - Arabic review themes for our own competitor sets
- **Test the buy option properly.** Demo Increff and Toolio in Phase 0 on our own data. Each vendor gets five
  scenarios, for example a USPA Ramadan forecast by warehouse and a Cardio Bunny new-style forecast [05].
  Switch M1 or M2 to the vendor if it:
  - beats our pilot model's forecast error on USPA Ramadan data
  - takes Noon, Namshi and FBN data through a file feed we can keep running
  - handles short history
  - quotes USD 50k a year or less for all brands (ASSUMPTION threshold) [05].
- **Test the buy option for M3 too.** Before building review themes, Nitin sees one NPD or review analytics tool
  in Phase 0 (Stylumia, or a Revuze-class review tool at about USD 1.0k to 4.1k a month) [05], [02]. Buy it if
  it covers Arabic reviews on GCC marketplaces for our competitor sets. Build only if no tool does.

### 5.3 The options [05]

| Option | What it is | 3-year cost (TCO) | Weighted score (of 5) |
|---|---|---|---|
| A. Extend Replenishment only | Seasonal uplift and a cold-start rule on Replenishment, plus daily stock history | 0.14M (range 0.11-0.17M) | 3.70 |
| B. Build a stand-alone product in-house | Everything built, including our own scrapers | 0.89M (0.71-1.07M) | 3.40 |
| C. Buy an enterprise suite | Increff, Toolio or RELEX class for M1 and M2, plus a review analytics tool | 0.81M (0.51-1.12M) | 2.40 |
| D. Hybrid, staged (Mizan) | Buy the data, build the GCC-specific parts on Replenishment, Scout and BigQuery | 0.68M (0.54-0.83M) | 4.15 |

TCO (total cost of ownership) is with an India-based build team (ASSUMPTION rates). A GCC-based team would take D
to about USD 1.55M [05]. The score weights fit, time to value, cost, control, data ownership, scale and risk. If
cost is weighted above fit, A wins narrowly [05].

On the ROI model's value basis, D's base case is -USD 312k (undiscounted value minus cost) and A's is -USD 27k
[05, corrected]. These leave out business time; with it, D is -USD 362k undiscounted [04]. B and C are worse than D. No option pays back at today's revenue in the base case. A loses the
least because it spends the least.

### 5.4 Mizan Lite (Option A+) against the full product

Mizan Lite has two parts:
- Option A from 05: a seasonal event uplift and a cold-start rule inside Channel Replenishment, plus the daily
  stock history.
- A one-off, capped, bought competitor scrape for NPD, about USD 500 [05], [06].

The sources support it as a stand-alone choice: it is the path DD10 recommended, and it is the "stop" level in
06's Gate 1 rule.

| | Mizan Lite (A+) | Full Mizan (D) |
|---|---|---|
| What it covers | Softline stock moves only; event uplift; cold start; stock history; one NPD read for Cardio Bunny | All three modules; softline and hardline; buys, sizes, OTB; ongoing NPD insight; partner-ready |
| 3-year cost | 137.9k [05] | 680.2k [05], plus about 49.5k of business time [04] |
| Year 1 cost | 69.4k [05] | 191.6k [05]; 83.8k at risk before Gate 1 [04] |
| Run cost after year 1 | 34.3k a year [05] | 238-250k a year [05] |
| Annual benefit at full use, base | about 55k (low 16k, high 158k) [calc] | 184k (low 54k, high 525k) [04] |
| 3-year NPV, base (high) | about -29k (+162k) [calc] | -296k (+339k) [04] |
| Annual benefit needed to break even | about 74k [calc] | 376k [04] |
| Strategic value | Low: no hardline, no buy planning, no partner offer | High: see section 6.6 |
| Main risk | Leaves 37% of revenue (hardline) and all buying decisions untouched | Cost runs ahead of revenue scale |

The A+ benefit uses 05's assumption that A reaches 30% of D's value, because it covers stock moves only. That
assumption is applied to 04's benefit. It excludes business time (D's figures include it), so it flatters A+
slightly. Treat it as a rough guide, not a workbook result.

**When each is right:**
- **Mizan Lite** fits in either case:
  - Gate 1 shows the money levers at or below the base rates.
  - GCC revenue stays near today's level.
  In both cases the full product cannot earn its cost, and A+ keeps the cheap wins (event uplift, stock history)
  for about USD 34k a year.
- **Full Mizan** is right when Gate 1 is met *and* the scale test in section 6.3 is met. The scale test is passed
  when either:
  - measured lever rates are well above base, or
  - revenue is on a path to about USD 29M (at 30% a year, about 3 years away; section 6.3).
  It is also right if leadership values the strategic benefits enough to fund the gap.
- **The pilot covers both.** Phases 0 and 1 (83.8k) cost about the same as A+'s first year (69.4k). They build A+
  as a by-product, so stopping at Gate 1 leaves Opptra with Mizan Lite at no extra build cost. Keeping it running
  costs about USD 34k a year.

---

## 6. ROI

All figures in this section come from `04-roi-model.xlsx` and `04-roi-method.md` [04] unless tagged otherwise.
The workbook was recalculated and matched an independent model to the cent [04].

### 6.1 How the benefit is counted

The model starts from measured baselines [03] and applies improvement ranges from outside evidence [02b]. Base
case: forecast error -20%, lost sales -20%, inventory -10%, markdown cost -10%, sales lift capped at +3%. Each
improvement is turned into money one lever at a time:

| Lever (base, full adoption) | USD a year | How |
|---|---|---|
| (a) Recovered lost sales | 51k | 40% of the stock-out proxy treated as real lost demand, 20% of that recovered, valued at a 25% contribution margin (40% gross margin less 15% selling cost, ASSUMPTION), ex VAT and net of returns |
| (b) Carrying cost saved on lower stock | 42k | 10% less stock at cost, times a 12% cost of capital |
| (c) Markdown and write-down avoided | 109k | Markdown and clearance loss assumed at 10% of net revenue ex VAT, cut by 10% |
| (d) Fewer size or fit returns | 5k | 3% fewer of the USD 682k Namshi size or fit returns |
| (e) Planner time | 17k | 4 planners, 30% of time on manual forecasting, 25% saved. Capacity, not a headcount cut |
| Overlap haircut | -41k | 20% off a+b+c, because fewer stock-outs and less stock trade off |
| **Total** | **184k** | Excludes the NPD upside (24k a year) and the one-time cash release |

The markdown assumption (10% of net revenue ex VAT, about 8% of gross) is half what earlier drafts used (20% of
gross). The model checks it against our own aged stock: stock over 180 days cleared at 40% off is about
USD 0.98M, close to the USD 1.09M assumed [04]. This is the single most important number for Finance to confirm.

Adoption ramps up: 30% of the full benefit in year 1, 70% in year 2, 100% in year 3.

### 6.2 Scenarios

| USD | Low | Base | High |
|---|---|---|---|
| Annual benefit, full adoption | 54k | 184k | 525k |
| Benefit Y1 / Y2 / Y3 | 13k / 30k / 46k | 55k / 129k / 184k | 210k / 447k / 525k |
| Cost Y1 / Y2 / Y3 | 254k / 311k / 325k | 208k / 255k / 267k | 208k / 255k / 267k |
| **3-year NPV** | **-638k** | **-296k** | **+339k** |
| ROI multiple (present value of benefits / costs) | 0.10x | 0.49x | 1.59x |
| Payback | Not in 36 months | Not in 36 months | Year 2 in practice |
| One-time cash released from stock | 191k | 353k | 486k |
| 3-year NPV including that cash | -509k | -13k | +739k |

Costs are 05's Option D (USD 680.2k over 3 years) plus about USD 17k a year of business time that 05 did not
count. The low case also assumes costs at the top of 05's range.

How to read this:
- The base case covers about half its cost.
- The one-time cash release brings the base case close to break-even. But that cash depends on actually holding
  10% less stock at the same availability.
- The high case pays.

### 6.3 Break-even revenue: the scale test

D's cost is built for all brands and does not grow much with revenue. Most of the benefit grows with revenue
(levers a to d). So the same product pays at a larger scale. Holding the base-case rates and the cost fixed
[calc]:

| | Value |
|---|---|
| Annual benefit needed at full adoption (base) | 376k [04] |
| GCC gross revenue at which the base case breaks even | **about USD 28.7M a year** (2.15x today's 13.4M) |
| Same, as a monthly run rate | about USD 2.4M a month, against about USD 1.2-1.4M a month in June, July and September 2026 [03] |
| Revenue at which the high case breaks even | about USD 8.2M, below today's revenue |
| Growth needed to break even within the first 3 years | about 71% a year |
| Revenue at which a full year's benefit covers a full year's running cost (about 267k) | about USD 20M a year (1.49x) |

The USD 28.7M bar is for the full 3 years, including the slow ramp-up years. Once the product is running at full
adoption, its yearly benefit covers its yearly cost from about USD 20M of revenue.

**What the growth trend shows** (units, because USD per unit jumped on 1 Aug 2026 when the revenue measure
changed [03]):
- In early 2025 the business was mostly U.S. Polo Assn. at about USD 40k to 60k a week, roughly USD 0.2M a month.
  By mid-2026 it ran at USD 1.2M to 1.4M a month [03].
- GCC units: +482% in Q3 2026 against Q3 2025, and +49% in the last 6 months against the 6 before. Softline:
  +25% on the same comparison [03]. These are 6-month changes. As yearly rates they would be about +122% (GCC)
  and +56% (softline) [calc]. The earlier half also holds White Friday and Ramadan, so they understate the trend.
- The last 6 months (about 188k units) already run at about 1.2 times the 12-month total of 314k units [calc].
- Almost all of it is new brands and channels. U.S. Polo Assn., the only like-for-like measure, is -1% [03].

So growth will continue only if Opptra keeps launching brands. For scale: 30% a year adds about USD 4M of
revenue in year 2, about two launches the size of Nutricook (USD 1.87M in its first 10 months) [03], [calc].

**Break-even under three growth rates** (base-case lever rates; Option D cost plus business time, held at the
year 3 level of about 267k a year after year 3; year 1 at the last 12 months' revenue, as in the 04 Growth
sheet) [calc]:

| Growth a year, in units | Revenue in year 3 | Reaches about USD 28.7M | First year that benefit covers cost | 3-year NPV | 5-year NPV | Running total turns positive |
|---|---|---|---|---|---|---|
| 0% (flat) | 13.4M | Never | Never | -296k | -395k | Never |
| 10% (04 model cap) | 16.2M | After about 8 years | Year 6 | -261k | -281k | Not within 7 years |
| 30% | 22.6M | After about 3 years | Year 3 | -185k | +20k | Year 5 |
| 50% | 30.1M | After about 2 years | Year 3 | -100k | +441k | Year 4 |

If year 1 starts from the current run rate (1.2x) instead, every row improves. At 10% the 5-year NPV is -168k;
at 30% it is +192k; at 50% it is +696k [calc].

How to read this:
- **Plan on 10%.** The proposal does not need faster growth to justify the pilot, and like-for-like demand is
  flat. At 10% the full product does not pay back within 5 years in the base case.
- **30% is not a stretch against the trend.** It is well below the yearly rate implied by the last 6 months. But it
  depends on the launch pipeline, which this proposal cannot confirm. At 30% the full product pays back in about
  5 years.
- **The 5-year figures are optimistic in one way.** They hold cost flat while revenue grows 2 to 5 times. More
  brands mean more data feeds and more analyst time, so cost would rise somewhat.
- New brands bring the benefit only if they have similar stock and markdown patterns to today's brands.

**What this means for Gate 1:** the full product is worth funding when the *projected* benefit clears
**USD 376k a year**. The projection uses pilot-measured lever rates on the revenue run rate at the time. Either
route can get there:
- the rates come in near the high case (markdown cut near 20%, more of the stock-out signal real), or
- revenue is heading towards about USD 29M, for example growing about 30% a year or more with a named launch
  pipeline behind it.

A cheaper Phase 2 and 3 team lowers the bar.

### 6.4 Stage-gated cash at risk

| Stage-gated scenario (base inputs) | USD |
|---|---|
| Phase 0 | 12.9k |
| Phase 1 | 62.7k |
| Business time over those 6 months | 8.3k |
| **Cash at risk before the Gate 1 go / no-go** | **83.8k** |
| NPV if Gate 1 fails and work stops | -74.9k |
| Expected NPV, stage-gated (assuming a 50% chance of passing) | -185.2k |
| Expected NPV if all 3 years were funded up front | -437.2k |
| Value of stage-gating | +252.0k |

The "funded up front" figure assumes Opptra would keep paying for all 3 years even after a failed pilot, so it
overstates the gain from gating. The plain point is simpler: the most the pilot can lose is about USD 84k.

In the model, passing Gate 1 means getting the base case, which is still negative (-296k). So **Gate 1 must
test money, not only forecast accuracy**. That is the scale test in 6.3, and it is added to the Gate 1 criteria in
section 7.

### 6.5 What would make it fail

The top five drivers of NPV, in order [04]:
1. Markdown reduction (swing 202k)
2. Cost (127k)
3. How big Opptra-funded markdowns really are (121k)
4. Adoption (88k)
5. Lost-sales reduction (63k)

How each of these could happen:
- **Markdown savings do not appear.** If marketplaces fund most discounts, Opptra's own markdown cost is small and
  the largest lever shrinks. Finance must measure Opptra-funded markdown and clearance loss before the pilot.
- **The stock-out signal is mostly noise.** 63% of it sits on SKUs with stock elsewhere [03].
- **Supply cannot react.** GCC supplier lead times are unknown [03]. A better forecast helps only where buys and
  moves can still change.
- **Planners do not use it.** Each 10 points of adoption is worth about USD 18k a year.
- **Costs run high,** for example to a GCC-based team (about USD 1.55M over 3 years [05]).
- **Stock falls but stock-outs rise.** A guardrail metric catches this: stock value per USD of sales must not
  rise, and availability must not fall [06].

### 6.6 Strategic value (NOT in the ROI)

None of these benefits is counted in any number above:
1. **It scales to every brand.** The design covers softline and hardline from day 1. Hardline brands carry 34% of
   the modelled benefit [04], and Replenishment does not cover them today [06]. New brands join without new
   build.
2. **The brand-partner pitch.** opptra.com says AI helps "anticipate demand" and offers "Revenue and volume
   forecasting", but no forecast table exists [DD10]. Mizan makes the claim provable. Later, partners could get:
   - a pre-signing "GCC opportunity read" for a new brand
   - season buy recommendations
   - a quarterly "voice of the GCC customer"
   - a read-only view of their own brand [06]
   The value of a partner who signs because of this is not modelled, because there is no basis for a number.
3. **NPD insight.** It gives evidence for Cardio Bunny's range against BlissClub and Lululemon. KSA women's weekly
   exercise rose from under 16% (2018) to above 40% (2022) [02b]. The model shows a possible USD 24k a year from
   better new-style hit rates, but excludes it, because no published study shows the effect [04], [02b].

---

## 7. Roadmap and gates

Dates assume approval by 6 Nov 2026 [06].

| Phase | Dates | What happens | Shape | Cost [05] |
|---|---|---|---|---|
| 0 Prove the basics | 9 Nov - 18 Dec 2026 (6 weeks) | Start daily stock history; backtest today's method; Increff and Toolio demos; legal review; Finance inputs; quick wins | Inside gcc-dashboard (the Replenishment team's app), own datasets | 12.9k |
| 1 Pilot | 21 Dec 2026 - 30 Apr 2027 | USPA, Cardio Bunny and one hardline brand through Ramadan and Eid 2027, with a holdout test | Extension of Channel Replenishment | 62.7k |
| **Gate 1** | Early May 2027 | Scale, hold at Mizan Lite, or stop | | |
| 2 Scale | May - Dec 2027 | All brands; one full buy cycle on M2; M3 monthly; tested on back to school, 11.11 and White Friday 2027 | Still an extension, built to separate | about 155k |
| **Gate 2** | Jan 2028 | Graduate to its own product, or stay an extension | | |
| 3 Own product and partner offer | From Jan 2028 | Own PM and budget line; partner views | Stand-alone product | 240-250k a year |
| **Gate 3** | End of 2028 | Offer to brand partners at scale | | |

**Phase 0 quick wins** [06]:
- A White Friday 2026 uplift table for the planners from the +50% to +64% we already measured. This works only if
  approved by about 6 Nov.
- A Ramadan 2027 uplift table for the pilot brands by 18 Dec 2026.
- The capped Cardio Bunny competitor read, after legal sign-off.

**How the pilot measures real lift.** It uses holdouts, not before-and-after, because growth and seasonality move
everything at once [04]:
- USPA options are split into matched pairs. One of each pair follows Mizan and the other follows today's method,
  on the same marketplaces in the same weeks.
- Pilot brands are also compared with non-pilot softline brands (French Connection, Campus, Penti), as a second
  check.
- The split is frozen before the start, and every override is logged with a reason.
- The hardline brand needs its own measure. Replenishment does not run for hardline, so there is no hardline
  stock-out signal today [03]. The daily stock history started in Phase 0 must therefore include the hardline
  stock that the warehouse already holds (for example Amazon and our own warehouses). The hardline result is then read from forecast error and
  stock-out days against today's method. Hardline carries 34% of the modelled benefit [04], so this matters.

**Gate exit criteria** (summary of [06] section 11; targets are proposals):
- **Gate 0:**
  - stock history running 21 days with no gap
  - today's method backtested
  - the vendor demos done and the build-or-buy call for M2 recorded
  - a data sourcing policy drafted
  - owners named
  - Replenishment owners agree to the forward-rate opt-in
  - supplier lead times and a unit-cost source agreed
- **Gate 1:**
  - forecast error (WMAPE, total error divided by total sales) at least 15% lower than today's method over
    Ramadan and Eid
  - Cardio Bunny cold start better than a category rule
  - USPA size availability up 5 points
  - forward rate switched on for at least 2 of the 3 pilot brands
  - one NPD decision taken from the benchmark
  - run cost under USD 1.5k a month
  - legal sign-off
  - **added by this proposal (G1.8): the money and scale test.** Treated against holdout, the stock-out proxy and
    aged-stock value fall at or above the base rates (20% and 10%). The benefit projected from the measured rates
    on the revenue run rate at the time clears USD 376k a year (section 6.3).
- **Gate 1 outcomes:**

  | Result | Decision |
  |---|---|
  | Accuracy gain under 5% | Stop model work; keep Mizan Lite |
  | Accuracy passes, adoption fails | Hold Phase 2 money for one cycle |
  | Accuracy passes, the money and scale test fails | Hold at Mizan Lite run cost (about USD 34k a year); repeat the scale test after White Friday 2027 |
  | Everything passes | Fund Phase 2 |

- **Gate 2:**
  - forecasts cover 90% of revenue
  - forecast error 15% lower at scale over White Friday 2027
  - on brands that used M2: sell-through +2 points, aged stock -10%, markdown spend -5%
  - adoption across all softline brands
  - 12 months of history for brands with 80% of revenue

### 7.1 Where this departs from DD10, and why

DD10 recommended three things [DD10]:
- Forecasting (B8) goes inside Channel Replenishment, starting with a seasonal uplift.
- NPD insight (B7b) becomes a small separate product owned by Nitin's team.
- A new separate forecasting product is "premature with under 12 months of history for most brands".

**This proposal agrees with DD10 for Phases 0 and 1:**
- The uplift feeds Replenishment.
- Ashish and Mahesh are the business owners for forecasting.
- The Cardio Bunny competitor read sits with Nitin.
- The gcc-dashboard team builds it with its existing release process.

**What this means for the Channel Replenishment team (Ashish and Mahesh):**
- Replenishment stays the system that proposes stock moves. Mizan does not replace it or run moves.
- The one change inside Replenishment is an optional input: a forward rate per brand, used only where Ashish or
  Mahesh switch it on, with today's trailing rate as the automatic fallback.
- The gcc-dashboard team builds that change through its normal release process. Mizan only reads
  Replenishment's tables.
- Mizan adds what Replenishment does not do today: hardline, buys, size curves and NPD. These sit beside
  Replenishment, not inside it.
- Their time: 2 to 3 hours a week each (section 8). Their opt-in is a Gate 0 criterion.

**It departs in two places:**
1. **It is built to separate from day 1.** It has its own datasets, jobs and module code, so graduating later is
   a change of owner, not a rewrite.
2. **It can graduate to its own product at Gate 2 (about Jan 2028)**, if the Gate 2 criteria are met.

The reasons [06]:
- Buying, sizes and NPD are not replenishment problems.
- Hardline is 37% of revenue and Replenishment is softline only.
- One data layer serves all three modules.
- The partner offer needs a product with its own identity.
- By 2028 most revenue will have 12 months or more of history, which answers DD10's main objection.

If Gate 2 is not met, the outcome is exactly DD10's recommendation.

---

## 8. Team and cost

Team per phase (FTE means full-time equivalent; India-based build team, ASSUMPTION rates) [06], [05]:

| Role | Phase 0 | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|---|
| Product owner / PM (Sujan through Gate 2; a dedicated PM from Phase 3) | 0.5 | 0.5 | 0.75 | 1.0 |
| Senior data scientist (hire or contract; the critical path) | 0.5 | 1.0 | 1.0 | 1.0 |
| Data scientist (mid) | - | - | 0.5 | 0.5 |
| Data engineer (gcc-dashboard team first) | 1.0 | 1.0 | 1.0 | 1.0 |
| Full-stack engineer | - | 0.5 | 0.75 | 0.5 |
| Planning / NPD analyst | - | 0.5 | 1.0 | 1.0 |
| Partner success | - | - | - | 0.5 (year 3, only if Gate 3 is in sight) |
| **Total FTE** | **2.0** | **3.5** | **5.0** | **5.0-5.5** |

Business time is about 12 hours a week in total, about USD 17k a year, which the ROI counts [04]:
- Ashish and Mahesh: 2-3 hours a week each
- Nitin: 2 hours a week
- pilot brand managers: 2 hours a week each

Cost of Option D by year [05]:

| USD k | Year 1 | Year 2 | Year 3 | 3 years |
|---|---|---|---|---|
| People | 169.9 | 207.4 | 219.0 | 596.4 |
| Cloud run cost (GCP) | 4.7 | 7.0 | 7.2 | 18.9 |
| Data and licences (scrapes, NoonSeller, Helium 10, AI text tagging, one-off scrape) | 17.0 | 24.0 | 24.0 | 65.0 |
| **Total** | **191.6** | **238.4** | **250.2** | **680.2** |

That is about 1.9% of net GCC revenue a year. If a planning vendor passes the Phase 0 demo, buying M2 adds about
USD 40-80k a year and saves about USD 25k a year of build (ASSUMPTION) [05].

The critical hire is a senior data scientist, in place by 21 Dec 2026. Without one, the pilot misses Ramadan 2027
and Gate 1 slips to after White Friday 2027 [05].

---

## 9. Risks

| Risk | Likelihood / impact | Mitigation | Owner |
|---|---|---|---|
| The money does not show up even if forecasts improve (markdowns mostly marketplace-funded; stock-out signal mostly noise) | Medium / High | Finance measures Opptra-funded markdown before the pilot; holdout test; G1.8 money test before Phase 2 | Finance, product owner |
| Revenue does not reach the scale where the full product pays (growth so far is launches; like-for-like is flat) | High / High | Stage funding; stay at Mizan Lite until the scale test passes; check the scale test against the brand launch pipeline, not the past trend alone | Executive sponsor |
| Short history gives poor forecasts | High / High | Borrow patterns across products and brands; ask principals for global data; show ranges; fall back to today's method | Data scientist |
| Growth mistaken for seasonality | High / Medium | Model launch ramps separately; forecast in units because the revenue measure changed on 1 Aug 2026 [03] | Data scientist |
| No stock history, so stock-out days look like zero demand | High / High | Start the daily stock history in Phase 0, whatever else is decided | Data engineer |
| Senior data scientist not hired in time (key-person risk) | Medium / High | Decide hire or contract now; pair with the data engineer; plain documentation | Executive sponsor |
| Scraping legality (cardiobunny.com blocks scrapers; marketplace seller terms) | Medium / High | Signed data sourcing policy; prefer licensed feeds; public pages only; no personal data | Legal |
| Low adoption or low trust by planners | Medium / High | Build into Replenishment and Cut Size habits; explain every number; adoption is a gate criterion | Product owner, Ashish, Mahesh |
| Missing inputs: supplier lead times, unit cost | High / High | Collect in Phase 0 (G0.7); vendors would need them too | Buying team, Finance |
| One brand dominates results (USPA 46% of revenue) | High / Medium | Report accuracy per brand; gate criteria for Cardio Bunny and the hardline brand | Product owner |
| Bought data feeds break | Medium / Medium | Two providers; field checks; "as of" dates; spend caps | Data engineer |
| Data quality traps (tripled replenishment rows, revenue measure change) | High / Medium | Dedupe rules and unit-based growth, as [03] did | Data engineer |

---

## 10. Decisions requested

| # | Decision | Recommended answer | Owner | By |
|---|---|---|---|---|
| 1 | **Pilot budget** | Approve up to USD 84k for Phases 0 and 1: Phase 0 (12.9k) now, Phase 1 (62.7k) released at Gate 0, plus about 8.3k of business time. No Phase 2 money until Gate 1, including the new money and scale test (G1.8) | Leadership; CFO | 6 Nov 2026 |
| 2 | **Executive sponsor** | Name one sponsor for gate decisions and cross-team priority calls | Leadership | 6 Nov 2026 |
| 3 | **B8 and B7b ownership** | Confirm DD10's boundary for Phases 0-1. B8 (forecasting) is an extension of Channel Replenishment: Ashish and Mahesh are business owners and the gcc-dashboard team builds it. B7b (NPD insight) is owned by Nitin's team. The catalog team only supplies read-only attributes and listing ids. Revisit at Gate 2 | Leadership with Ashish, Mahesh, Nitin | 6 Nov 2026 |
| 4 | **Pilot brands** | USPA, Cardio Bunny, and GTPlayer as the hardline brand (longest hardline history, 12 months, USD 1.52M). Alternative: Nutricook (largest, USD 1.87M, 10 months) [06], [03] | Ashish and Mahesh with brand managers | Gate 0 (18 Dec 2026) |
| 5 | **Vendor demos** | Demo Increff and Toolio in Phase 0 on an anonymised data pack (no customer data), with 05's five scenarios and question list. Record the build-or-buy call for M2 | Product owner (Sujan), with Ashish and Mahesh; Nitin for any NPD tools | 18 Dec 2026 |
| 6 | **Data sourcing legal review** | Approve the capped one-off Cardio Bunny scrape (about USD 500) only after a legal check. Write a data sourcing policy covering marketplace seller terms, robots.txt (cardiobunny.com blocks scrapers), the Lululemon regional site, and no personal data | Legal; Nitin as requester | Policy drafted by Gate 0; signed by Gate 1 |
| 7 | **Finance inputs** | Confirm gross margin (40% assumed), Opptra-funded markdown and clearance spend (10% of net ex VAT assumed), return handling cost (15% assumed), cost of capital (12% assumed), and a source for unit cost. These move the ROI more than any benchmark [04] | Finance (CFO) | Gate 0 (18 Dec 2026) |
| 8 | **Senior data scientist** | Hire or contract, in place by 21 Dec 2026 | Executive sponsor, HR | 21 Dec 2026 |
| 9 | **Daily stock history** | Start now, whatever else is decided. Every option needs it, and none exists today | gcc-dashboard team (Sujan) | Phase 0 start |
| 10 | **Supplier lead times** | Collect for the three pilot brands from the buying team | Buying team | Gate 0 |

---

## 11. Appendix

### A. Source documents

| Tag | File | What it holds |
|---|---|---|
| [02] | [02-market-scan.md](02-market-scan.md) | 13 planning vendors, 9 NPD and trend vendors, marketplace tools, scraping prices, GCC and aggregator peers |
| [02b] | [02b-gcc-context-and-benchmarks.md](02b-gcc-context-and-benchmarks.md) | GCC market, seasonality, activewear, returns; ROI improvement ranges (B3) |
| [03] | [03-baseline-metrics.md](03-baseline-metrics.md) | Today's numbers from BigQuery: revenue, events, cover, stock-outs, ageing, returns, Cardio Bunny |
| [04] | [04-roi-method.md](04-roi-method.md) and [04-roi-model.xlsx](04-roi-model.xlsx) | ROI method, assumptions, scenarios, growth, sensitivity, per-brand split, stage-gated block |
| [05] | [05-build-vs-buy.md](05-build-vs-buy.md) | Options A-D, scoring, 3-year TCO, vendor demo script and questions. Section 5 corrected on 2026-10-26 to match [04] |
| [06] | [06-product-design.md](06-product-design.md) | Mizan design: personas, modules, wireframes, data architecture, AI approach, roadmap and gates, team, risks, metrics, partner offer |
| [DD10] | [../../deep-dives/10-boundary-forecasting-npd.md](../../deep-dives/10-boundary-forecasting-npd.md) | Boundary memo for B8 and B7b |
| [calc] | This proposal, Appendix B | Break-even revenue, growth scenarios (10%, 30%, 50%), unit run rate, Mizan Lite figures |

### B. How the [calc] numbers were worked out

- **Break-even revenue.** We used the [04] workbook's own formulas (the independent Python copy that matches it
  to the cent).
  - We scaled every revenue-linked input by one factor: gross, net, softline and hardline revenue, stock, the
    stock-out proxy, size or fit returns, and aged stock.
  - Costs and planner time stayed fixed, with base-case rates and ramps.
  - The base-case 3-year NPV reaches zero at a factor of 2.146, which is USD 28.7M gross and an annual benefit of
    USD 376k at full adoption. For the high case the factor is 0.611 (USD 8.2M).
- **Growth path.** Year 1 is at today's revenue, then revenue grows at g a year (the Growth sheet's convention).
  - NPV reaches zero at g of about 71%.
  - At g = 10% the NPV is -261k, which matches the Growth sheet. At g = 30% it is -185k; at 50%, -100k.
  - Years to reach 2.146x are ln(2.146) / ln(1 + g).
  - 5-year NPV and the running total extend the same path. Years 4 and 5 are at full adoption, and cost stays
    at the year 3 level (250.2k from 05 plus 16.5k of business time). The "current run rate" variant starts
    year 1 at 1.197x.
  - The running-cost break-even (about USD 20M) is the scale at which full-adoption benefit equals the year 3
    cost: a factor of 1.49.
- **Unit run rate.** From [03]: 314,123 units in 12 months, and +49% for the last 6 months against the 6 before.
  So the last 6 months are 314,123 x 1.49 / 2.49, about 188k units, and twice that is 1.2 times the 12-month
  total. A 6-month change of +49% is about +122% as a yearly rate (1.49 squared), and +25% is about +56%.
- **Mizan Lite (A+).** Benefit is 30% of [04]'s annual benefit (05's assumption for Option A), with [04]'s ramps.
  Cost is 05's Option A (69.4k, 34.3k, 34.3k). Discounting is at 12%, with no business time added.

### C. Glossary

| Term | Meaning |
|---|---|
| AOP | Annual operating plan: revenue targets per brand and month |
| Cold start | Forecasting a product or brand with no sales history |
| FBN | Fulfilled by Noon: stock held in noon's own warehouses |
| Holdout | A matched group that keeps today's method, so the difference shows the real effect |
| NPD | New product development |
| NPV | Net present value: future benefits minus costs, discounted to today's money (12% a year here) |
| OTB | Open to buy: what is left to spend in a period after planned sales, stock and orders |
| Sell-through | Units sold divided by units sold plus units on hand |
| Size curve | Share of demand by size |
| TCO | Total cost of ownership over 3 years |
| Uplift | How much an event lifts demand over a normal week (x1.5 = 50% more) |
| WMAPE | Weighted mean absolute percentage error: total forecast error divided by total actual sales |

## 12. Open questions from the 2026-10-26 review

These came out of the review and need an owner's answer. They are not fixed in the text above.
1. **Launch pipeline (Leadership, Finance).** What new brands and channels does the 2027 plan assume? The 30% and
   50% scenarios in section 6.3 depend on it. Should G1.8 use a Finance-agreed revenue path instead of only the
   run rate at Gate 1?
2. **Growth label in the workbook (ROI owner).** The 04 Growth sheet calls the +25% softline figure "growth" and
   compares it with a yearly cap, but it is a 6-month change. The cap of 10% applies either way, so no result
   changes. The label could be clarified in the next workbook revision.
3. **Hardline pilot measure (Ashish, Mahesh, data engineer).** Which hardline stock feeds go into the daily stock
   history, and what is the hardline money test at Gate 1? Section 7 sets the principle but not the metric.
4. **Direct Cardio Bunny competitors (Nitin).** Which two or three brands sit next to Cardio Bunny on Namshi and
   noon? BlissClub and Lululemon are references, not confirmed shelf competitors.
5. **M3 buy test (Nitin).** Is Nitin willing to run one NPD or review tool demo in Phase 0 (section 5.2)? It is
   not yet in 06's Gate 0 criteria.
6. **Mizan Lite comparison.** The A+ figures leave out business time and use 05's rough 30% value share. A
   like-for-like A+ line in the workbook would make the comparison exact.
7. **Cost growth with scale.** The 5-year figures hold cost flat while revenue doubles or more. 05 could add a
   cost line that grows with the number of brands.
