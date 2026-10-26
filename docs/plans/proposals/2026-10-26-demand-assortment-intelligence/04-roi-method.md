# 04 - ROI method and results: demand, assortment and NPD intelligence (Mizan)

Date: 2026-10-26. Audience: CFO and leadership. Companion workbook: `04-roi-model.xlsx` (every number below is a
live formula there; change an input on the `Inputs` sheet and every sheet recalculates). Money is USD.
"k" means thousands.

## The answer in five lines

- **Base case: about USD 184k a year of benefit at full adoption, against about USD 250k a year of cost at full
  team size.** Over 3 years the base case NPV is about **-USD 296k** (ROI multiple 0.49x) and it **does not pay
  back within 36 months**.
- Lower stock also frees about **USD 353k of cash once** (base). Counting that cash, the base case is close to
  break-even (NPV about -USD 13k).
- **High case pays:** USD 525k a year, NPV +USD 339k, ROI 1.59x. **Low case does not:** USD 54k a year, NPV
  -USD 638k.
- The product needs about **USD 376k a year** of benefit at full adoption to break even on Option D's cost, about
  twice our base estimate. The biggest single swing is how much markdown and clearance loss it removes.
- **Stage-gating caps the downside.** Funding only Phases 0 and 1 puts about **USD 84k at risk** before the
  Gate 1 go / no-go. The case for Phase 2 money should be decided on Gate 1 evidence, not on this model.

## 1. Method in plain language

1. **Start from what we measured.** The baseline is `03-baseline-metrics.md`: GCC gross revenue USD 13.39M a
   year (softline USD 8.46M), stock USD 6.48M at selling price, a stock-out signal of USD 6,666 a day of softline
   demand on empty shelves, USD 682k of Namshi size or fit returns, and 40% sell-through.
2. **Apply improvement ranges from outside evidence.** The ranges are from `02b-gcc-context-and-benchmarks.md`
   section B3 (low / base / high). Base: forecast error -20%, lost sales -20%, inventory -10%, markdown cost -10%,
   sell-through +3 points, total sales lift capped at +3%.
3. **Turn each improvement into money, one lever at a time:**
   - **(a) Recovered lost sales.** The stock-out signal is an upper bound, so we count only part of it as real
     lost demand (base 40%; low uses 03's own lower anchor, 21%). Hardline has no stock-out data, so we assume
     half the softline intensity. We take 20% of that lost demand back, cap it at a 3% sales lift, strip VAT,
     remove returns, and keep only the contribution margin (gross margin 40% less 15% variable selling cost =
     25%).
   - **(b) Working capital.** Stock is valued at cost (selling price ex VAT x 60%). A 10% cut frees cash once;
     the yearly benefit counted is only the cost of capital on that cash (12%). The one-off cash is shown
     separately and never added to the yearly benefit.
   - **(c) Markdown and ageing write-down avoided.** We assume markdown and clearance loss borne by Opptra is 10%
     of net revenue ex VAT (02b and 05 use 15-25% of gross sales; we stay lower because marketplaces fund part
     of promotions). A cross-check from 03 supports the size: stock over 180 days (USD 2.69M at selling price)
     cleared at 40% off is about USD 0.98M, close to the USD 1.09M assumed. Base cut 10%.
   - **(d) Size curves.** Better size splits in buys cut size or fit returns by 3% (base). Each avoided return
     saves handling cost (15%) and half become kept sales at contribution margin.
   - **(e) Planner time.** 4 planners at USD 55k, 30% of their time on manual forecasting, 25% of that saved.
     This is capacity, not a headcount cut.
   - **(f) NPD upside.** Shown separately and **excluded from every total**: there is no published evidence that
     competitor insight raises new-style hit rates (02b).
4. **Do not double count.** Fewer stock-outs and less stock trade off (02b B2), so levers a, b and c are cut by
   an overlap haircut (base 20%).
5. **Ramp up.** A pilot comes first, so year 1 earns 30% of the full benefit, year 2 70%, year 3 100% (base;
   same ramp as 05).
6. **Costs** are 05's recommended Option D (hybrid, staged): USD 191.6k, 238.4k and 250.2k (USD 680.2k over 3
   years), rebuilt phase by phase from 05 section 4.5. We add business time that 05 does not cost (about USD
   17k a year). Low case uses the top of 05's cost range (x1.22).
7. **Results.** NPV discounts each year's net at 12%. Payback is the first month the running total of benefit
   minus cost turns positive. ROI multiple is the present value of benefits divided by the present value of
   costs.
8. **Checks.** The workbook was recalculated with a formula engine (pycel; LibreOffice is not installed on this
   machine) and every result matched an independent Python model to the cent. The implied sell-through gain
   from levers a and b is +3.0 points in the base case, which matches the 02b benchmark of +3 points.

## 2. Every assumption and its source

Type: DATA = measured in 03; BENCHMARK = range from 02b B3; ASSUMPTION = our estimate, needs Finance or business
confirmation.

| Input | Low | Base | High | Type | Source |
|---|---|---|---|---|---|
| GCC gross revenue, incl VAT | | 13.39M | | DATA | 03 summary table |
| Softline / hardline gross revenue | | 8.46M / 4.93M | | DATA | 03 summary table |
| GCC net revenue after cancellations and returns | | 12.04M (10% lower than gross) | | DATA | 03 summary table |
| Stock at selling price, incl VAT | | 6.48M (155,074 units) | | DATA | 03 summary table |
| Sell-through, last 90 days | | 40% | | DATA | 03 summary table |
| Stock over 180 days, value (upper bound) | | 2.69M | | DATA | 03 ageing table, caveat 5 |
| Stock-out signal, softline, a day | | 6,666 (lower anchor 1,376) | | DATA | 03 stock-out table, caveat 7 |
| Namshi size or fit returns | | 682k | | DATA | 03 returns section |
| Unit growth: softline / GCC / USPA, last 6 months vs previous 6 | | +25% / +49% / -1% | | DATA | 03 summary table |
| Blended VAT | | 10% | | ASSUMPTION | UAE 5%, KSA 15%; country mix not in 03 |
| Gross margin (ex VAT) | 35% | 40% | 45% | ASSUMPTION | No usable unit cost in the warehouse (03 caveat 6) |
| Variable selling cost on extra sales | | 15% | | ASSUMPTION | Marketplace commission share and fulfilment |
| Cost of capital | 10% | 12% | 15% | ASSUMPTION | Finance to confirm |
| Discount rate for NPV | | 12% | | ASSUMPTION | Equal to cost of capital |
| Markdown and write-down cost, % of net ex VAT | 6% | 10% | 15% | ASSUMPTION | 02b / 05 use 15-25% of gross; cross-checked with 03 aged stock |
| Clearance discount on aged stock (check only) | | 40% | | ASSUMPTION | Used only in the cross-check |
| Return handling cost per returned USD | | 15% | | ASSUMPTION | No GCC figure published (02b A5) |
| Avoided returns that become kept sales | | 50% | | ASSUMPTION | |
| Hardline stock-out intensity vs softline | | 50% | | ASSUMPTION | Replen run is softline only (03 caveat 9) |
| Planners, cost, manual share | | 4 FTE, 55k, 30% | | ASSUMPTION | 06 personas; 05 4.1 GCC analyst rate |
| New-style revenue share; uplift per hit-rate point | | 30%; 1% | | ASSUMPTION | NPD upside only |
| Growth cap | | 10% a year | | ASSUMPTION | Observed growth is mostly launches (03 caveat 2) |
| Cost multiplier on 05 cost | 1.22 | 1.00 | 1.00 | ASSUMPTION | Low = top of 05 range (832k / 680k) |
| Adoption ramp, Y1 / Y2 / Y3 | 25 / 55 / 85% | 30 / 70 / 100% | 40 / 85 / 100% | ASSUMPTION | 05 section 5; pilot Dec 2026 - Apr 2027 |
| Overlap haircut on a+b+c | 30% | 20% | 10% | ASSUMPTION | 02b B2 point 5 |
| Business time (not in 05) | | 12 h a week, about 17k a year | | ASSUMPTION | 06 section 12 hours |
| Probability Gate 1 passes | | 50% | | ASSUMPTION | Stage-gated block only |
| Forecast error reduction (pilot KPI, not valued) | 10% | 20% | 30% | BENCHMARK | 02b B3 |
| Lost-sales reduction | 10% | 20% | 30% | BENCHMARK | 02b B3 |
| Real share of the stock-out signal | 21% | 40% | 60% | ASSUMPTION | Low = 03 lower anchor / upper bound |
| Sales-lift cap | 1% | 3% | 5% | BENCHMARK | 02b B3 (Zara field experiment) |
| Inventory reduction | 5% | 10% | 15% | BENCHMARK | 02b B3 |
| Markdown cost reduction | 5% | 10% | 20% | BENCHMARK | 02b B3 |
| Sell-through gain (cross-check, not valued) | +1 | +3 | +5 points | BENCHMARK | 02b B3 |
| Size or fit return reduction | 0% | 3% | 7% | BENCHMARK | 02b B3; 06 section 15 |
| Planner time saved | 15% | 25% | 40% | ASSUMPTION | No benchmark |
| NPD hit rate (upside only) | 0 | +5 | +10 points | BENCHMARK | 02b B3, no published evidence |

## 3. Headline results

| USD | Low | Base | High |
|---|---|---|---|
| Annual benefit, full adoption, today's revenue | 54k | **184k** | 525k |
| of which (a) recovered lost sales | 11k | 51k | 139k |
| of which (b) carrying saving on lower stock | 19k | 42k | 73k |
| of which (c) markdown and write-down avoided | 33k | 109k | 328k |
| of which (d) fewer size or fit returns | 0 | 5k | 13k |
| of which (e) planner time | 10k | 17k | 26k |
| less overlap haircut | -19k | -41k | -54k |
| Benefit Y1 / Y2 / Y3 | 13k / 30k / 46k | 55k / 129k / 184k | 210k / 447k / 525k |
| Cost Y1 / Y2 / Y3 | 254k / 311k / 325k | 208k / 255k / 267k | 208k / 255k / 267k |
| **3-year NPV (excl one-off cash)** | **-638k** | **-296k** | **+339k** |
| ROI multiple (PV benefits / PV costs) | 0.10x | 0.49x | 1.59x |
| Payback | not in 36 months | not in 36 months | year 1 (see note) |
| One-off cash released from stock | 191k | 353k | 486k |
| 3-year NPV incl the one-off cash | -509k | -13k | +739k |
| Break-even annual benefit needed | 558k | 376k | 331k |
| NPD upside a year (excluded) | 0 | 24k | 58k |

Note on the high case payback: year 1 benefit (210k) just covers year 1 cost (208k), so the even monthly spread
shows payback in month 1. In practice the pilot months will be cash negative and payback lands in year 2.

**On a grown revenue base** (growth = the lower of observed softline unit growth, +25%, and a 10% cap; year 1
kept at today's base): base NPV improves to -261k (ROI 0.55x), high to +447k, low stays at -631k. Even 10% growth
a year does not close the base-case gap. Note that +25% is a 6-month change (last 6 months against the 6 before),
about +56% as a yearly rate; the 10% cap applies either way, so no result changes. `00-proposal.md` section 6.3
runs the base case at 10%, 30% and 50% a year: 3-year NPV -261k, -185k and -100k; 5-year NPV -281k, +20k and
+441k.

**Per brand (base, full adoption):** U.S. Polo Assn. 40% of the benefit, other softline brands 25%, hardline
brands 34%, Cardio Bunny 1.3% (about USD 2.4k a year). The value sits across the whole portfolio, mostly in
USPA and the large hardline brands; Cardio Bunny on its own would never justify the product.

**Top 5 drivers of NPV** (one at a time, others at base; Sensitivity sheet): markdown cost reduction (swing
202k), cost multiplier (127k), markdown cost share (121k), adoption ramp (88k), lost-sales reduction (63k).

### Stage-gated scenario (base inputs)

Leadership funds only Phases 0 and 1 until Gate 1 is met (06 section 11).

| | USD |
|---|---|
| Phase 0 (05) | 12.9k |
| Phase 1 (05) | 62.7k |
| Business time over those 6 months | 8.3k |
| **Cash at risk before the Gate 1 go / no-go** | **83.8k** |
| NPV if Gate 1 fails and work stops | -74.9k |
| NPV if Gate 1 passes and Phases 2-3 go ahead (base) | -295.6k |
| Expected NPV, stage-gated (50% pass) | -185.2k |
| Expected NPV if all 3 years were funded up front | -437.2k |
| Value of stage-gating | +252.0k |

Read this carefully: in the base case, passing Gate 1 on accuracy alone is not enough, because the base-case
benefit is below cost. Gate 1 should also require evidence that the money levers (markdown, stock-outs) are
running at or above the base rates, or a cheaper Phase 2-3 team.

### How this compares with 05

05 says the conservative case does not pay back in 3 years (about -USD 0.25M). **Confirmed, and worse here:**
-USD 638k NPV. 05's base case (+USD 183k value minus cost) does **not** hold in this model; our base is -USD 296k
NPV (-USD 362k undiscounted). The reasons:

1. **Markdown base.** 05 assumes markdowns are 20% of gross sales; we use 10% of net revenue ex VAT (about 8% of
   gross), which the 03 aged-stock check supports. This alone is most of the gap.
2. **Revenue base.** 05 grows in-scope revenue to 12M, 15M and 18M (about 22% a year). We use today's measured
   13.4M, and at most 10% growth in the Growth sheet, because 03 shows growth is mostly launches.
3. **Margin and netting.** 05 uses 30% contribution on gross revenue. We use 25% on revenue ex VAT and net of the
   10% cancellations and returns.
4. **Extra conservatism.** We apply a 20% overlap haircut and add about 17k a year of business time.

The writer of 05 and 06 should reconcile the "about USD 0.86M value over 3 years" figure in 06 section 0 with
this model (our base is about USD 0.37M undiscounted).

## 4. What would make the case fail

- **Markdown savings do not appear.** If marketplaces fund most discounts, Opptra's own markdown cost is small
  and lever c (the largest) shrinks. Finance should measure Opptra-funded markdown and clearance loss first.
- **The stock-out signal is mostly noise.** 63% of it is on SKUs with stock elsewhere (03). If most of that
  demand is served by another location, lever a falls towards the low case.
- **Supply cannot react.** Principal lead times are unknown for the GCC (03). Better forecasts help only where
  buys and moves can still change.
- **Planners do not use it** (ramp stays low). Each 10 points of adoption is worth about 18k a year.
- **Costs run to the top of 05's range**, or the team is GCC-based (05: about USD 1.55M over 3 years).
- **Inventory is cut but stock-outs rise**, which the guardrail in 06 section 15 (inventory per USD of sales must
  not rise, availability must not fall) is there to catch.

What would make it work: markdown savings near the high case (-20%), revenue growth well above 10% a year (at
about 30% the base case pays back in about 5 years), or a leaner Phase 2-3 team. Break-even needs about 376k a year at full adoption.

## 5. How a pilot proves it

The pilot (Phase 1, 21 Dec 2026 - 30 Apr 2027) runs on USPA, Cardio Bunny and one hardline brand through Ramadan
and Eid 2027 (06 section 11).

**Design: holdouts, not before-and-after.** Growth and seasonality move everything at once (03 caveat 2), so a
before-and-after comparison would flatter the product.

- **Within a brand:** split USPA options into matched pairs by category, price band and past sales; one of each
  pair follows Mizan's forecast and moves, the other follows today's method. Same marketplaces, same weeks.
- **Across brands:** compare pilot brands with non-pilot softline brands (French Connection, Campus, Penti) over
  the same weeks, as a second check.
- **Locations:** where practical, hold out one location pair (for example Noon FBN KSA) per brand.
- Freeze the split before the pilot starts and record every override with a reason.

**Metrics to watch (treated vs holdout):**

| Metric | Proves lever | Base target |
|---|---|---|
| Forecast error (WMAPE), 4 weeks ahead | Model quality (Gate 1) | 20% lower; floor 15% |
| Stock-out USD a day on selling SKU-locations | a | 20% lower |
| Options with 3+ sizes in stock, Noon and Namshi | a, d | +5 points |
| Stock value per USD of sales (guardrail) | b | Must not rise; 10% lower over 2 seasons |
| Opptra-funded markdown and clearance loss, share of net sales | c | 10% lower |
| Stock over 180 days, value | c | 10% lower |
| Size or fit returns share on Namshi | d | 3% lower |
| Sell-through at planned price | a, b, c together | +3 points over 2 seasons |
| Planner hours on manual forecasting (time log) | e | 25% lower |
| New styles reaching target sell-through in 8 weeks (A/B on Cardio Bunny) | f (upside) | +5 points |

**Before the pilot starts (Phase 0):** confirm gross margin, Opptra-funded markdown spend and return handling
cost with Finance, and start the daily stock history. Those three numbers move this model more than any
benchmark.
