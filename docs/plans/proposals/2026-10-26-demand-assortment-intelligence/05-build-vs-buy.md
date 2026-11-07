# 05 - Build vs buy: demand, assortment and NPD intelligence

Date: 2026-10-26. Status: proposal for approval. Nothing is built, bought or scraped.
Audience: Opptra leadership and the GCC business team (Nitin Kiran; Ashish and Mahesh).
Product being decided: the three-module product described in `06-product-design.md` (working name Mizan):
M1 Demand Planner, M2 Assortment and Buy Planner, M3 NPD and Competitor Insight.

How numbers are labelled: each number carries a source tag in square brackets (list in section 8) or the word
ASSUMPTION. Cost and value figures are in thousands of US dollars ("USD k") unless stated. Revenue, stock and
history numbers come from `03-baseline-metrics.md` (read from BigQuery on 2026-10-26). DD9 and DD10 are used
where [03] is silent.

---

## 0. The answer in short

- **Recommendation: Option D, hybrid, in stages.** Buy the raw data (listing and review scrapes, noon sales
  estimates, Amazon research tools). Build the GCC multi-marketplace data layer, the event-aware forecasting,
  the buy planning and the NPD insight on top of what Opptra already runs (Channel Replenishment v2, Scout,
  BigQuery, the catalog module's read-only exports).
- **Stage it the way DD10 recommended.** Phases 0 and 1 are an extension of Channel Replenishment; in practice
  this is Option A plus a separable data layer. The product graduates to its own product only at Gate 2 (about
  Jan 2028), if measured criteria are met (`06-product-design.md` section 11).
- **Keep "buy a suite" alive until evidence says no.** In Phase 0, demo Increff and Toolio against our own data.
  Switch M2 (or more) to a bought tool if a vendor meets the conditions in section 6.
- **3-year total cost of ownership (TCO), base case, India-based team (ASSUMPTION):** A about USD 0.14M,
  B about USD 0.89M, C about USD 0.81M (range 0.51-1.12M), D about USD 0.68M (range 0.54-0.83M).
- **Weighted score (section 3):** D 4.15, A 3.70, B 3.40, C 2.40 (out of 5).
- **Indicative 3-year value minus cost, base case (section 5, on the [04] ROI model's value basis):** A -0.03M,
  D -0.31M, B -0.57M, C -0.59M. No option pays back within 3 years at today's revenue in the base case. D has
  the highest ceiling (+0.50M in the high case). The [04] model puts D's base-case 3-year NPV at -USD 296k and
  its low case at -USD 638k. This is why the money is released stage by stage, against gate evidence.

---

## 1. What is being decided

Opptra needs three capabilities that no single vendor offers for its setup [02]:

1. Event-aware forecasting with short history: Hijri events that move about 11 days a year [02], marketplace
   events with different names per platform [02], and only USPA and Nautica with two seasonal cycles [DD10].
2. Assortment and buy planning across marketplace warehouses: 6 stock locations including Noon FBN [CR-E2E],
   size curves per channel and country, open to buy (OTB), ageing and markdown risk.
3. NPD and competitor insight: competitor price, rank, reviews (Arabic and English) and attribute gaps, for
   example Cardio Bunny vs BlissClub and Lululemon [BRIEF], [DD10].

The facts that shape the choice:
- 18 brands had sales in the last 12 months: USD 13.4M gross, USD 12.0M net. Hardline is USD 4.93M (37%),
  and 15 of the 18 brands started selling on or after 29 Oct 2025 [03].
- No vendor publicly lists connectors for Noon, Namshi, 6thStreet, Styli, Centrepoint and Trendyol GCC
  together; every tool reviewed assumes Shopify, Amazon, an ERP or POS as the source of truth [02].
- Suites that do size curves and OTB well are priced and designed for store networks with long histories [02].
- Data collection is cheap and commoditised: about USD 0.25-1.50 per 1,000 records [02].
- Opptra already runs the core of a demand-driven planning product: Channel Replenishment v2, 4 runs a day,
  13,501 SKUs per target on 15 Oct 2026 [CR-STATUS], softline only [CR-E2E].
- Multi-brand aggregators whose data lives in marketplaces (GlobalBees, Thrasio, Mensa) built forecasting
  in-house; large GCC store retailers bought enterprise suites [02].

---

## 2. The options

| Option | What it is | What it delivers | What it does not deliver |
|---|---|---|---|
| **A. Extend Replenishment only** | Add a seasonal uplift and a simple cold-start rule to Channel Replenishment's rate of sale, plus the daily stock history. Built by the gcc-dashboard team. This is DD10's recommendation for B8 [DD10] | Event-aware stock moves for softlines; fast; cheap. Fits the evidence that 63% of the softline stock-out proxy sits on SKUs with stock in another location [03] | No OTB, no buy proposals, no size curves beyond Cut Size, no hardlines (Replen is softline only [CR-E2E]; hardline is 37% of GCC revenue [03]), no NPD (left to a one-off scrape), no partner offer |
| **B. Build a stand-alone product in-house** | A new product built from scratch, including our own competitor scrapers (extending Scout to competitor and brand sites and reviews) and our own review analytics | All three modules, full control | Slow to first value; carries scraper upkeep and legal exposure in-house; Scout's GCC adapters are still STAGED and its reviews entity is parked [SCOUT], [DD10] |
| **C. Buy an enterprise suite** | A planning suite of the Increff, Toolio or RELEX class for M1 and M2, plus a separate review or competitor analytics tool for M3. Opptra builds the data feeds into them | Mature planning screens (OTB, size curves, allocation) | No GCC marketplace connectors [02]; store-allocation logic does not map cleanly to marketplace warehouses [02]; short-history handling unpublished [02]; Hijri cold start unproven; licence grows with brands; data and logic sit with the vendor |
| **D. Hybrid (recommended)** | Buy data feeds (Apify, Bright Data or Oxylabs; NoonSeller Data API; Helium 10) and optionally one planning module if a demo proves it. Build the GCC multi-marketplace layer, event forecasting, buy planning and NPD insight, reusing Replen, Scout, B6 and B7a | All three modules, GCC-specific, owned data and logic, partner-ready | Needs a data science hire; depends on outside feeds; needs legal sign-off on data sourcing |

---

## 3. Scoring matrix

Scores are 1 (poor) to 5 (best). They are our judgement on the evidence cited, not measured facts.

| Criterion | Weight | A | B | C | D | Why |
|---|---|---|---|---|---|---|
| Fit to Opptra's needs (GCC marketplaces, Hijri events, short history, softline and hardline, NPD) | 25% | 2 | 4 | 2 | 5 | A covers part of M1 only. C lacks GCC connectors and short-history proof [02]. B fits but spends effort on scrapers. D targets exactly the gaps no vendor fills [02] section 8 |
| Time to value | 15% | 5 | 2 | 3 | 4 | A: weeks. D: quick wins in Phase 0, pilot value in Ramadan 2027. C: 12-16 week implementations (Nextail [02]) after feeds are built. B: everything built first (ASSUMPTION 9-12 months) |
| 3-year TCO | 15% | 5 | 2 | 2 | 3 | Section 4 |
| Control (roadmap, logic, explainability) | 10% | 5 | 5 | 2 | 4 | D depends on outside feeds; C on the vendor's roadmap |
| Data ownership | 10% | 5 | 5 | 2 | 4 | D owns derived data and models; raw feeds are licensed. C keeps data and logic in the vendor's system |
| Scales to all brands (and to partners) | 15% | 2 | 4 | 3 | 5 | A is softline and replenishment-only. C licences usually grow with data volume and modules [02]. D is designed for all brands and partner views |
| Risk (delivery, legal, vendor) | 10% | 4 | 2 | 3 | 3 | A is low delivery risk. B carries scraper and legal risk in-house. C carries fit and lock-in risk. D carries hire and feed risk |
| **Weighted score** | 100% | **3.70** | **3.40** | **2.40** | **4.15** | |

Sensitivity (how the answer moves if leadership weighs things differently):

| Weighting | A | B | C | D | Winner |
|---|---|---|---|---|---|
| As above | 3.70 | 3.40 | 2.40 | 4.15 | D |
| Cost-heavy (TCO 30%, fit 15%, data 5%, others as above) | 4.00 | 3.05 | 2.40 | 3.90 | A, narrowly |
| Fit-heavy (fit 35%, time 10%, TCO 10%, others as above) | 3.40 | 3.60 | 2.35 | 4.30 | D |

Reading: D wins unless cost outweighs fit. If cost comes first, A wins narrowly. The staged plan covers both,
because D's first two phases are A-sized.

---

## 4. Three-year total cost of ownership

### 4.1 Assumptions

| Item | Value | Basis |
|---|---|---|
| Exchange rate | USD 1 = INR 84 | Ratio used in [DD9] (INR 2,700 = USD 32; INR 10,200 = USD 121) |
| Loaded cost | Salary (CTC) x 1.2 for benefits, equipment, tools and office | ASSUMPTION |
| Year 1 | Nov 2026 to Oct 2027, starting with Phase 0 on 9 Nov 2026 | ASSUMPTION; phases in `06-product-design.md` section 11 |
| Team location | India (Bengaluru market rates) for build roles; GCC business owners are existing staff and not costed | ASSUMPTION |

People rates (ASSUMPTION; replace with HR bands):

| Role | India CTC (INR lakh a year) | India loaded (USD k a year) | GCC (Dubai) loaded (USD k a year) |
|---|---|---|---|
| Product manager (senior) | 40 | 57 | 135 |
| Senior data scientist | 40 | 57 | 135 |
| Data scientist (mid) | 25 | 36 | 90 |
| Data engineer | 28 | 40 | 100 |
| Full-stack engineer | 22 | 31 | 80 |
| Planning or NPD analyst | 15 | 21 | 55 |
| Scraper or data-ops engineer | 18 | 26 | 65 |

GCP run cost (ASSUMPTION): BigQuery, Cloud Run jobs and Cloud Scheduler, the same stack Replenishment runs 4
times a day [CR-STATUS]. Data volumes are small: 402,386 sales rows and 1,142,054 listing rows [DD10].
Monthly cost: Phase 0 USD 200, Phase 1 USD 300, Phase 2 USD 500, Phase 3 USD 600 (Option D). Options A and C
add about USD 100-170 a month. Option B adds its own scraping compute.

Data and licences (sources as marked):

| Item | Price | Volume assumed | Monthly cost |
|---|---|---|---|
| Listing scrapes (Apify, Bright Data, Oxylabs) | USD 0.80-1.50 per 1,000 records [02] | Pilot: 2,000 competitor listings daily on 4 marketplaces, about 240,000 records a month, plus about 30,000 reviews at USD 1.50-3 per 1,000 [02] (ASSUMPTION volume) | about USD 400 |
| Same, at scale | [02] rough cost illustration: 5,000 listings daily on 4 marketplaces is USD 500-900, plus 100,000 reviews is USD 150-300 | From Phase 2 | about USD 900 |
| NoonSeller Data API | USD 199 per category per month [02] | 2 categories in the pilot, 4 from Phase 2 (ASSUMPTION) | USD 398, then USD 796 |
| Helium 10 or Jungle Scout (Amazon.ae) | Plan prices not captured [02] | One plan (ASSUMPTION) | USD 150-200 (ASSUMPTION) |
| AI text model for review themes | About USD 0.013-0.021 per 1,000 reviews at a low-cost tier [DD7] | Includes headroom for summaries (ASSUMPTION) | USD 50-100 (ASSUMPTION) |
| One-off Cardio Bunny scrape | USD 1.50-7.50 per 1,000 reviews [DD10] | Capped (ASSUMPTION) | USD 500 once |
| Planning suite licence (Option C) | Quote only for Increff and Toolio [02]. Anchors: Nextail from EUR 60,000 a year (Capterra), Blue Yonder about USD 100,000 a year per module (FarEye, a competitor source), Onebeat USD 8,000 a month lowest tier, RELEX USD 16,500-74,400 first year for 10 users including onboarding (ITQlick) [02] | Base USD 90k a year, growing 20% a year as brands and SKUs are added (ASSUMPTION; vendors price by modules and data volume [02]). Range USD 40-150k | - |
| Suite implementation (Option C) | RELEX onboarding USD 10,000-50,000 (ITQlick); Blue Yonder implementation can match the licence (FarEye) [02] | Base USD 60k once; range USD 20-100k (ASSUMPTION) | - |
| Review or competitor analytics (Option C) | Revuze USD 1,000 / 2,200 / 4,100 a month (PricingSaaS); Capterra USD 30,000 [02] | Base USD 30k a year; range USD 12-49k (ASSUMPTION) | - |
| Residential proxies (Option B) | Scout already uses proxy files for some sites [SCOUT] | USD 400 a month (ASSUMPTION) | USD 400 |

### 4.2 Option A - extend Replenishment only

FTE: year 1 PM 0.2, senior data scientist 0.5, data engineer 0.5, full-stack 0.25. Years 2 and 3: PM 0.1, senior
data scientist 0.25, data engineer 0.25, full-stack 0.1 (ASSUMPTION).

| USD k | Year 1 | Year 2 | Year 3 | 3 years |
|---|---|---|---|---|
| People | 67.7 | 33.1 | 33.1 | 133.8 |
| GCP | 1.2 | 1.2 | 1.2 | 3.6 |
| Data and licences | 0.5 | 0 | 0 | 0.5 |
| **Total** | **69.4** | **34.3** | **34.3** | **137.9** |

Range (people plus or minus 20%): about USD 111-165k.

### 4.3 Option B - build a stand-alone product in-house

FTE: years 1 and 2 PM 1, senior data scientist 1, data scientist 1, data engineer 1.5, full-stack 1, scraper
engineer 1, analyst 1. Year 3: data engineer 1, the rest the same (ASSUMPTION).

| USD k | Year 1 | Year 2 | Year 3 | 3 years |
|---|---|---|---|---|
| People | 288.0 | 288.0 | 268.0 | 844.0 |
| GCP (including own scraping compute) | 6.0 | 9.0 | 10.8 | 25.8 |
| Data and licences (proxies USD 4.8k, AI text USD 1k a year) | 5.8 | 5.8 | 5.8 | 17.4 |
| **Total** | **299.8** | **302.8** | **284.6** | **887.2** |

Range (people plus or minus 20%, data 0.7x to 1.5x): about USD 713k-1,065k. First full release after about
9-12 months (ASSUMPTION).

### 4.4 Option C - buy an enterprise suite

FTE for Opptra's side: year 1 PM 0.5, data engineer 1 (building the marketplace feed into the vendor), analyst
or tool admin 1, senior data scientist 0.5 (gaps the vendor does not cover: cold start, Hijri events,
marketplace warehouses). Years 2 and 3: PM 0.25, data engineer 0.75, analyst 1, senior data scientist 0.5
(ASSUMPTION).

| USD k | Year 1 | Year 2 | Year 3 | 3 years |
|---|---|---|---|---|
| Planning suite licence | 90.0 | 108.0 | 129.6 | 327.6 |
| Implementation | 60.0 | 0 | 0 | 60.0 |
| Review or competitor analytics licence | 30.0 | 30.0 | 30.0 | 90.0 |
| Competitor data feeds | 6.0 | 6.0 | 6.0 | 18.0 |
| People | 118.0 | 93.8 | 93.8 | 305.5 |
| GCP | 2.0 | 2.0 | 2.0 | 6.0 |
| **Total** | **306.0** | **239.8** | **261.4** | **807.1** |

Range: low about USD 506k (licence USD 40k flat, implementation USD 20k, analytics USD 12k a year); high about
USD 1,123k (licence USD 150k growing 20% a year, implementation USD 100k, analytics USD 49k a year). Channel
Replenishment still has to be kept running alongside the suite in every case, as in every other option.

### 4.5 Option D - hybrid (recommended)

FTE by phase (from `06-product-design.md` section 12; ASSUMPTION):

| Phase | Months | PM | Senior DS | DS (mid) | Data eng. | Full-stack | Analyst | People cost a year (USD k) |
|---|---|---|---|---|---|---|---|---|
| 0 | 1.5 | 0.5 | 0.5 | - | 1.0 | - | - | 97.0 |
| 1 | 4.5 | 0.5 | 1.0 | - | 1.0 | 0.5 | 0.5 | 151.5 |
| 2 | 8 | 0.75 | 1.0 | 0.5 | 1.0 | 0.75 | 1.0 | 202.0 |
| 3 | ongoing | 1.0 | 1.0 | 0.5 | 1.0 | 0.5 | 1.0 (+0.5 partner success in year 3) | 208.5 (219.0 in year 3) |

| USD k | Year 1 | Year 2 | Year 3 | 3 years |
|---|---|---|---|---|
| People | 169.9 | 207.4 | 219.0 | 596.4 |
| GCP | 4.7 | 7.0 | 7.2 | 18.9 |
| Data and licences (scrapes, NoonSeller, Helium 10, AI text, one-off scrape) | 17.0 | 24.0 | 24.0 | 65.0 |
| **Total** | **191.6** | **238.4** | **250.2** | **680.2** |

How year 1 is built: Phase 0 (people 12.1, GCP 0.3, data 0.5) + Phase 1 (people 56.8, GCP 1.35, data 4.5 at
about USD 1.0k a month) + the first 6 months of Phase 2 (people 101.0, GCP 3.0, data 12.0 at about USD 2.0k a
month).

Funding per stage: Phase 0 about USD 13k; Phase 1 about USD 63k; Phase 2 about USD 155k; Phase 3 about
USD 240k a year (USD 250k with partner success).

Range (people plus or minus 20%, data 0.7x to 1.5x): about USD 541-832k.

Optional add-on: if a planning vendor passes the Phase 0 demo, buying M2 adds about USD 40-80k a year
(ASSUMPTION; one module, below a full suite) and saves about 0.5 FTE of build (about USD 25k a year).

### 4.6 Summary

| USD k, 3 years | A | B | C | D |
|---|---|---|---|---|
| People | 133.8 | 844.0 | 305.5 | 596.4 |
| GCP | 3.6 | 25.8 | 6.0 | 18.9 |
| Licences, implementation and data | 0.5 | 17.4 | 495.6 | 65.0 |
| **Total, base** | **137.9** | **887.2** | **807.1** | **680.2** |
| Range | 111-165 | 713-1,065 | 506-1,123 | 541-832 |
| Cost per year as a share of TTM GCC net revenue (USD 12.0M [03]) | about 0.4% | about 2.5% | about 2.2% | about 1.9% |

GCC-based team instead of India (ASSUMPTION rates in 4.1): D's people cost rises to about USD 1.46M and its
3-year total to about USD 1.55M. Option B rises to about USD 2.1M, about 2.4 times its India cost.

---

## 5. Value at stake against cost (indicative)

This is a planning estimate, not a forecast. The annual benefit comes from the ROI model in
`04-roi-method.md` and `04-roi-model.xlsx` [04], which applies the [02b] B3 improvement ranges to the measured
baseline in [03]. The full method and every assumption are in [04]; this section only compares the options on
that basis.

Annual benefit for Option D at full adoption, on today's revenue (USD 13.39M gross, USD 12.04M net [03]) [04]:

| Lever | Low | Base | High |
|---|---|---|---|
| (a) Recovered lost sales | 11k | 51k | 139k |
| (b) Carrying saving on lower stock | 19k | 42k | 73k |
| (c) Markdown and write-down avoided | 33k | 109k | 328k |
| (d) Fewer size or fit returns | 0 | 5k | 13k |
| (e) Planner time | 10k | 17k | 26k |
| Less overlap haircut | -19k | -41k | -54k |
| **Annual benefit** | **54k** | **184k** | **525k** |

Key bases in [04] (ASSUMPTION unless marked): markdown and clearance loss borne by Opptra is 10% of net revenue
ex VAT (low 6%, high 15%), about 8% of gross, cross-checked against [03]'s aged stock; contribution margin on
recovered sales is 25% ex VAT and net of returns; today's revenue is held flat (no growth path); a 20% overlap
haircut stops levers a, b and c being double counted [02b] B2. The NPD upside (24k a year base) and the one-off
cash released from lower stock (353k base) are shown separately in [04] and are not counted here.

Realisation ramp for D: [04]'s scenario ramps (base 30%, 70%, 100%; low 25%, 55%, 85%; high 40%, 85%, 100%).
For the other options (ASSUMPTION, unchanged from the earlier draft): A reaches 30% of D's value with the same
ramp, because it covers moves only. B reaches D's ceiling but starts later (10%, 60%, 100%). C reaches 70% of
D's ceiling because of fit gaps and starts later (15%, 60%, 90%).

| USD k, 3 years, undiscounted | A | B | C | D |
|---|---|---|---|---|
| Value, low | 27 | 91 | 62 | 89 |
| Value, base | 111 | 313 | 213 | 368 |
| Value, high | 355 | 893 | 607 | 1,182 |
| TCO, base (section 4) | 138 | 887 | 807 | 680 |
| **Value minus cost, base** | **-27** | **-574** | **-594** | **-312** |
| Value minus cost, low / high | -111 / +217 | -796 / +6 | -745 / -200 | -592 / +502 |

For D, the [04] model gives the discounted view (12% a year, with about USD 17k a year of business time added
and low-case costs at the top of the range in 4.5): 3-year NPV -USD 296k base, -USD 638k low, +USD 339k high.
Break-even needs about USD 376k a year of benefit at full adoption, about twice the base case.

Reading:
- No option pays back within 3 years at today's revenue in the base case. A loses least because it spends
  least. D has by far the highest ceiling. In the high case D and A pay, B roughly breaks even and C does not.
- D carries a large downside, which is why it is funded stage by stage. Gate 1 must test the money levers
  (markdown, stock-outs) and revenue scale, not accuracy alone (`00-proposal.md` section 6.3).
- A is a sound minimum: low cost, low ceiling. D's Phases 0 and 1 cost about the same as A's first year and
  build A along the way.
- Value not counted here: the brand-partner pitch (`06-product-design.md` section 16), coverage of future
  brands, and NPD hits.

---

## 6. Recommendation and conditions

**Recommend Option D (hybrid), staged.** Start as an extension of Channel Replenishment in Phases 0 and 1, then
graduate to a stand-alone product at Gate 2, only if its exit criteria are met (`06-product-design.md`
sections 11 and 13).

Conditions:
1. **Fund by stage.** Approve Phase 0 now (about USD 13k). Phase 1 at Gate 0, Phase 2 at Gate 1, Phase 3 at
   Gate 2, each against its written exit criteria.
2. **Start the daily stock history now.** It is needed in every option, and there is no stock history anywhere
   today [CR-E2E].
3. **Test the buy option properly in Phase 0.** Run the demos in section 7 using our own data, then record the
   decision.
4. **Legal sign-off before any competitor data collection** beyond the capped one-off Cardio Bunny scrape. Prefer
   licensed feeds; respect robots.txt (cardiobunny.com blocks scrapers [BRIEF]); check marketplace seller terms
   [02]; collect no personal data.
5. **Named owners and their time.** Executive sponsor; product owner; Ashish and Mahesh for M1 and M2; Nitin for
   M3 (`06-product-design.md` section 13).
6. **A senior data scientist in place by Phase 1 (21 Dec 2026).** Otherwise the pilot misses Ramadan 2027 and
   Gate 1 moves to after White Friday 2027.
7. **India-based build team.** If the team will be GCC-based, re-approve with a 3-year cost of about USD 1.55M.
8. **Catalog B6 attributes by Phase 2,** or accept look-alikes based on category, price band and colour only.
9. **Supplier lead times and unit cost collected in Phase 0** from the buying team and Finance. Neither is
   usable in the warehouse today: GCC purchase orders are raised when goods arrive, and receipt values do not
   give a unit cost [03]. Without them, buy "order by" dates and OTB at cost cannot be produced. Vendors would
   need the same inputs, so this condition applies to every option.

What would change the answer:
- **Switch M1 or M2 to buying (towards C)** if, in Phase 0 or 1, a vendor:
  - beats our pilot model's forecast error (WMAPE) in a backtest on our USPA Ramadan data,
  - takes Noon, Namshi and FBN data through a file contract we can keep running,
  - shows it handles short history, and
  - quotes USD 50k a year or less for all brands (ASSUMPTION threshold).
  We would keep the data layer and M3 in-house.
- **Stop at A** if Gate 1 shows less than a 5% accuracy gain, or if leadership weighs cost above fit (section 3
  sensitivity).
- **Move data collection in-house (towards B for data only)** if bought feeds fail coverage or legal checks and
  Scout's GCC adapters leave STAGED status [SCOUT].

---

## 7. Vendor demos and the questions to ask

### 7.1 Who to see in Phase 0

| Vendor | Why | Priority |
|---|---|---|
| Increff | Strongest GCC fashion track record among mid-market tools; GCC case study (2026); India-built pricing likely lower [02] | Must |
| Toolio | Closest off-the-shelf planning model for OTB and assortment at mid-market scale; BigQuery integration named [02] | Must |
| Plott Data (managed feed) | Covers noon, Namshi and Trendyol as a managed feed [02] | Must (data) |
| NoonSeller Data API | Cheap noon UAE and KSA sales estimates and competitor tracking; trial before buying [02] | Must (data) |
| Stylumia | Apparel demand sensing, India-built, reported UAE presence [02] | Optional (M3) |
| DataWeave or EDITED | Price and assortment intelligence; GCC coverage unconfirmed [02] | Optional (M3) |
| RELEX | Only to calibrate the enterprise end; GCC clients are grocery and large retail [02] | Optional |

Before the demos: sign NDAs and share an anonymised data pack (USPA daily sales by option and channel for two
years, Cardio Bunny since launch, stock positions from Replenishment, the event calendar). The pack must
contain no customer names, addresses or order numbers.

### 7.2 Demo script (the same five scenarios for every planning vendor)

1. USPA men's footwear: forecast Ramadan and Eid 2027 by marketplace warehouse, using two past cycles.
2. Cardio Bunny: forecast a new legging style with no history, launching on Namshi KSA.
3. Size curve for the same category on Namshi KSA vs Noon UAE, using return reasons by size.
4. OTB for one brand for three months, reconciled with our AOP.
5. Stock split between UAE Freezone, UAE Mainland, KSA Salasa and Noon FBN UAE and KSA under our lane rules.

### 7.3 Questions for planning vendors

Fit and data:
1. Which of these do you connect to today: noon (including FBN stock), Namshi, Amazon.ae and .sa, Trendyol GCC,
   6thStreet, Styli, Centrepoint? For the rest, what file format do you need, and who maintains it?
2. Can we load our own warehouse tables from BigQuery and get results back into BigQuery?
3. Do you handle softline and hardline in one tool?

Forecasting:
4. What is the minimum history for a usable forecast? Show a live customer with less than 12 months.
5. How do you forecast a new style or a new brand with no history?
6. How do you model events that move every year (Ramadan, Eid) and platform-specific events (White Friday vs
   Yellow Friday, 11.11)? Can we load our own event calendar?
7. Will you run a backtest on our data before we sign, scored by WMAPE against our current method (trailing
   rate of sale)?
8. Can planners see why a forecast is what it is, and override it with a reason?

Allocation, sizes and buying:
9. Can you allocate across marketplace fulfilment centres (Noon FBN) and our own warehouses with our lanes and
   rules, or only to stores?
10. Size curves per channel and country? Can return reasons by size feed them?
11. How do OTB and buy proposals work for a brand operator buying from principals with long lead times?

Commercial:
12. What is the price at our size? We have 18 brands with sales and about 12,400 SKUs sold in the last 12
    months [03], 6 stock locations, 7 main channels [BRIEF] and USD 13.4M gross revenue a year [03]. What is
    the price per module?
13. How does the price change as we add brands and SKUs? Can we start with one module for three brands?
14. Implementation time, the effort needed from us, and the cost?
15. Contract length, renewal increases, and exit terms?

Security, ownership and exit:
16. Where is our data stored, and who can see it? What security certifications do you hold?
17. On exit, do we get our data, forecasts and settings back, in what format, and how fast?
18. Can our brand partners have read-only access to their own brand under our licence?

References:
19. Can we speak to a GCC fashion customer (for example the customer in your 2026 Middle East case study [02])?
20. Can we speak to a customer who sells mainly through marketplaces rather than stores?

### 7.4 Questions for data vendors (scrapes, managed feeds, review analytics)

1. Coverage by marketplace and country: noon, Namshi, Amazon.ae and .sa, Trendyol, 6thStreet, Styli,
   Centrepoint, Ounass, and brand sites (for example Lululemon's regional site). Include BlissClub's Indian
   channels (Myntra, Amazon.in).
2. Fields: price, deal price, stock signal, best-seller rank, search rank, rating, review count, review text.
   Do you cover Arabic reviews?
3. Frequency, back history available, and how you match the same product across marketplaces.
4. Legal basis: do you respect robots.txt and site terms? Do you indemnify the buyer? How do you handle
   personal data in reviews?
5. Delivery: direct to BigQuery or cloud storage, the schema, and change notices when fields change.
6. Reliability: how fast you fix a breakage when a site changes, and whether that is in the contract.
7. Price per 1,000 records or per category, minimums, and monthly caps.
8. For review analytics (Revuze class): Arabic accuracy, a custom theme list, and price at about 100,000 reviews
   a month (ASSUMPTION volume).

---

## 8. Sources

| Tag | Source |
|---|---|
| [BRIEF] | Facts stated in the proposal brief of 2026-10-26 (from the requester) |
| [02] | `docs/plans/proposals/2026-10-26-demand-assortment-intelligence/02-market-scan.md` (vendor prices and fit; scraping prices; aggregator pattern) |
| [02b] | `docs/plans/proposals/2026-10-26-demand-assortment-intelligence/02b-gcc-context-and-benchmarks.md` (B2 and B3 value ranges) |
| [04] | `docs/plans/proposals/2026-10-26-demand-assortment-intelligence/04-roi-method.md` and `04-roi-model.xlsx` (annual benefit, NPV, break-even) |
| [03] | `docs/plans/proposals/2026-10-26-demand-assortment-intelligence/03-baseline-metrics.md` (TTM revenue, brand count, stock-out proxy, lead time and cost gaps; read from BigQuery on 2026-10-26) |
| [DD7] | `docs/plans/deep-dives/07-review-ingestion-enhancement.md` (theme tagging cost; B7b consumption) |
| [DD9] | `docs/plans/deep-dives/09-business-impact.md` (softline revenue base; INR to USD ratio; returns) |
| [DD10] | `docs/plans/deep-dives/10-boundary-forecasting-npd.md` (history depth, warehouse tables, ownership options, one-off scrape price) |
| [CR-STATUS] | `C:\Users\Sujan Ajay\Desktop\gcc-dashboard\docs\channel-replenishment\STATUS.md` |
| [CR-E2E] | `C:\Users\Sujan Ajay\Desktop\gcc-dashboard\docs\channel-replenishment\Channel_Replenishment_v2_End_to_End.md` |
| [SCOUT] | `C:\Users\Sujan Ajay\Desktop\opptra-scrapers\adapters\__init__.py` and `engine\contracts.py` |

Paths without a drive letter are relative to `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\01-intent-map`.

---

## Change note (2026-10-26)

Sections 0 and 5 were corrected to match the ROI model in `04-roi-method.md` and `04-roi-model.xlsx`. The
earlier draft showed a base-case value minus cost of +USD 183k for D (A +121k, B -128k, C -299k). It assumed
markdown spend of 20% of gross sales, about twice the [04] base of 10% of net revenue ex VAT, which [03]'s aged
stock supports. It also grew revenue to USD 12M, 15M and 18M and used a 30% contribution on gross revenue. The
value table now uses [04]'s annual benefit on today's revenue. Costs (section 4), scores (section 3) and the
recommendation to stage Option D are unchanged; the Gate 1 condition is tightened in `00-proposal.md` section 7.
