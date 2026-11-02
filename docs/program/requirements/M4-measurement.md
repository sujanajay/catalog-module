# M4 - Measurement and experiments

Requirements, 2026-11-02. Follows `00-template.md`. Plain words; jargon is defined the first time it appears. Numbers marked (exact) come from a query in the evidence reports, (sim) from the power simulation in the outcome baseline, (judgement) are assumptions.

Words used in this file:
- **Option**: one style-colour (for example "LEAN GLB 6FX MEN OD WHITE"). The thing a shopper sees as one product page on Namshi or Noon. Sizes sit under it.
- **Style**: all colour options of one design. Colour siblings often share a page, a swatch strip and shoppers, so they are treated as one unit here.
- **Listing**: one option on one channel-country (Namshi UAE, Namshi KSA, Noon UAE, Noon KSA, ...).
- **Treatment**: a content change we made on purpose (for example "complete the apparel shot set with crops").
- **Control**: a listing we deliberately left as it was, so we have something to compare against.
- **Holdout**: the set of controls kept untouched for the whole test.
- **Lift**: the relative change in the outcome caused by the treatment, in percent.
- **MDE** (minimum detectable effect): the smallest true lift a test can find 80% of the time. Smaller effects can be real and still invisible to the test.
- **Confounder**: something other than the treatment that moves sales (price, ads, stock, season) and could be mistaken for the treatment's effect.
- **Pre-registration**: writing down the question, the metric, the sample and the analysis before the test starts, so the answer cannot be bent afterwards.

## 1. Purpose

M4 turns "we believe better content sells" into evidence: it runs and reads out controlled tests of content changes on marketplaces that give us no built-in testing, no traffic data for most channels and no seller API. Outcome metric: weekly ordered units per listing, with a truthful uncertainty band, delivered at the pre-registered dates (8 and 12 weeks for the first holdout). Intents served: I004 (causal, pooled conversion measurement with controls), I024 (organic conversion as north star, tracked per channel), I028 (every module tied to ROI), I038 (learning per channel x category), I045 (works without SP-API), I013 (open-source estimators).

## 2. Scope

**In (P0, first slice):** the outcome data layer (a weekly panel of sales, ads, stock, price and promotions per listing from BigQuery); the first randomized holdout on Namshi and Noon (about 700 vs 700 options, start 10-17 Nov, readouts at 8 and 12 weeks); the experiment registry with pre-registration and an MDE for every experiment; the guardrails (blind arms, event calendar, do-not-touch flags, change watch).

**In (P1, inside the 12-week window):** the estimator package (ANCOVA with pre-period adjustment, Poisson with fixed effects, staggered difference-in-differences, randomization inference, placebo suite, synthetic control as a cross-check); country-split and wave designs; faster secondary signals (ad click rate, ad conversion, returns share, Noon conversion if its traffic feed is restored); the outcome dashboard per channel.

**Out:** anything that moves money or content on its own (that is M10 and M9); ad bid changes; price tests; per-SKU "did this product's new image work" answers (statistically impossible on these channels, see section 8); measurement on Styli, Centrepoint, 6th Street, Shein, VogaCloset and Trendyol UAE beyond listing acceptance and liveness (7 to 124 units a week per channel-country, exact).

**Later:** bought public market covariates (competitor price, our search rank, review growth) at about USD 1,200-1,500 a month (judgement); calibration against Amazon Manage Your Experiments if Brand Registry access ever exists on amazon.ae or .sa; India channels on the same core.

## 3. Contracts

### Reads

| From | Entity or table | Grain | Used for |
|---|---|---|---|
| Warehouse `fact_gcc.unified_sales_tertiary_v2` | order line events (`event_type` sale or reversal) | line | ordered units, net units, revenue USD |
| Warehouse `gcc_marketing.ads_daily`, `raw_amazon_adservice.*`, `raw_noon_admanager.*` | day x channel SKU | day | ad impressions, clicks, spend, ad units |
| Warehouse `fact_gcc.brep_lost_sales_daily`, `cut_size_option_daily`, `catalog_liveness_daily` | size x channel-country x day | day | stocked size-days, broken size runs, live state |
| Warehouse `raw_gcc_table_cleaned.catalog_live_noon_3p_*`, `gcc_channel_reports.catalog_live_namshi_3p_*`, `opptra_core.listing_observation` | partner SKU x day | day | active price, discount, deal tag |
| Warehouse `gcc_marketing.sku_option`, `raw_gcc_dimensions.master_sl` | SKU to option | - | keys; `master_sl` has no style id (checked 2026-11-02) |
| M0 catalog graph | `listing` (option x channel x country with channel keys), `content_version`, `treatment_event`, `style` | event | which content was live where, from when |
| M9 live content watch | `live_observation` (gallery count, image hashes, title hash per listing per scrape) | scrape | verifying a treatment went live; catching outside edits |
| M5 rules | event calendar is admin data here, not in M5 | - | - |

### Writes

| To | Entity or table | Grain | Consumers |
|---|---|---|---|
| BigQuery `catalog_os.outcome_panel_weekly` | listing x week | week | M4 estimators, M10, dashboard |
| BigQuery `catalog_os.event_calendar` | channel-country x date range x event | - | estimators |
| Postgres (module db) + BigQuery export `catalog_os.experiment` | one row per experiment with the frozen pre-registration | - | M10, dashboard, audit |
| `catalog_os.experiment_assignment` | style x experiment: arm, stratum, pair id, assignment hash | - | M0 (control flag), M3, M9, M10 |
| `catalog_os.experiment_readout` | experiment x readout date x metric: estimate, interval, p-value, n, compliance | - | M10, dashboard |
| M0 `listing.guard` | do-not-touch flag with experiment id and until-date | - | M1, M3, M8, M9, M10 (all must refuse to publish to a guarded listing) |

### API and queue shapes

- `POST /experiments` registers a draft: `{name, hypothesis, change_type_id, channels[], unit:"style", primary_metric, pre_weeks, post_weeks, readout_dates[], eligibility{}, strata[], alpha, power}`. Returns `experiment_id`, status `draft`.
- `POST /experiments/{id}/assign` runs eligibility and randomization, writes assignments, returns pool sizes, balance table and the simulated MDE. Status `assigned`.
- `POST /experiments/{id}/freeze` locks the pre-registration (hash of the registry row plus the analysis code commit), writes guards into M0, exports the blind lists. Status `running`. No field except `notes` may change after freeze.
- `POST /treatments` (called by M0 on publish): `{experiment_id?, listing_id, style_id, change_type_id, content_version_before, content_version_after, intended_live_at, actor, reason}`. M4 does not accept a treatment on a guarded listing; it returns 409 with the guard.
- Queue events consumed: `content.published`, `content.verified_live` (from M9 scrape), `listing.changed_externally` (from M9 scrape; the main contamination alarm), `warehouse.panel_ready` (daily).
- Queue events produced: `experiment.frozen`, `experiment.safety_check`, `experiment.readout_ready`, `experiment.contamination`.

### Contract needs from M0

1. A canonical **style id** per option, with the rule that made it (brand sheet style code where present, else a name-and-colour heuristic with a confidence). The warehouse has none: in `unified_sales_tertiary_v2` the `style_id` column equals the option (1 option per style on every channel, exact, query of 2026-11-02). A heuristic over `master_sl` shows the siblings are real: U.S. Polo 1.9 options per style and 80% of selling options have a sibling; Nautica 61%; French Connection 26%; Penti, Keds, Vero Moda, Cardio Bunny 2-25% (approx, 12 weeks of Namshi and Noon sales).
2. `treatment_event` with `change_type_id` from day one (the M10 taxonomy v0, ten rows is enough), `content_version_before` and `after`, `source` per image (brand, crop, upscaled, generated, vendor), `intended_live_at`, and a pointer to the `verified_live_at` observation.
3. A `guard` on `listing` that every publishing path checks before writing.
4. A `change_reason` on every content version even before M0's P1 "change reasons" feature: at least `experiment`, `rule`, `operator`, `learning`, `external`.
5. Daily export of all of the above to BigQuery `catalog_os.*` next to `fact_gcc` (M0's own P0 feature).

## 4. Features

### M4-F1 Outcome data layer (P0)

**User story.** As the measurement owner, I want one weekly table per listing with units, revenue, ads, stock, price, promotions and the content version that was live, so that every estimator and dashboard reads the same truth and nobody re-derives sales in a notebook.

**Functional requirements.**
- M4-F1-R1: `catalog_os.outcome_panel_weekly` has one row per option x channel x country x ISO week (Monday start) for every option that was live or stocked at any time in the week, including zero-sales weeks, for Namshi, Noon, Trendyol and Amazon in UAE and KSA. Test: row count equals the number of distinct listing-weeks in the liveness and stock tables for the same window.
- M4-F1-R2: columns, with the source for each: `ordered_units` (sum of `ordered_units` where `event_type='sale'`), `net_units` (final status not cancelled or returned), `revenue_usd`, `ad_impressions`, `ad_clicks`, `ad_spend_usd`, `ad_units`, `stocked_size_days`, `sizes_live`, `broken_size_flag`, `live_days`, `price_active_median`, `discount_pct_median`, `deal_flag_days`, `event_flags` (array from the calendar), `content_version_id` (the version verified live for most of the week), `gallery_count_observed`, `first_live_week`. Each column has a documented null meaning ("not measured on this channel" versus "zero").
- M4-F1-R3: history back to 2026-05-11 (25 weeks) for sales and ads, so every experiment has an 8-week pre-period; stock from 2026-08-04, Noon price from 2026-02-25, Namshi price from 2026-10-14 (all exact). Missing confounders are null, not zero.
- M4-F1-R4: the panel is rebuilt daily by a scheduled job after the warehouse rebuild (09:35 UTC) and carries `as_of`; the last 7 days are marked `may_restate` because portals restate sales.
- M4-F1-R5: a freshness and sanity check runs with every rebuild: each source table's max date, week totals within 30% of the previous week unless an event flag explains it, and join coverage (share of sales rows that found an option) at or above 97% for softline. A failed check keeps the last good panel and raises `warehouse.panel_stale`.
- M4-F1-R6: `catalog_os.event_calendar` is admin-editable: channel-country, start, end, event name (White Friday, 11.11, 12.12, Ramadan, Eid, platform sale, feed outage), severity. The first load holds the 2026-27 GCC calendar.
- M4-F1-R7: the panel is read-only for everyone but the rebuild job. No module writes outcomes by hand.

**Non-functional.** Rebuild under 15 minutes; BigQuery cost under USD 5 a month (the panel is under 1 GB); the panel exists and is queryable even when the module's Postgres is down. Scale target: 50,000 listings x 104 weeks.

**Configuration (no deploy).** Channels in scope, the week start day, the restatement window, the eligibility thresholds used downstream, the event calendar, the check thresholds.

**Inputs and outputs.** In: the warehouse tables and M0's export. Out: the two BigQuery tables and the `warehouse.panel_ready` event.

**Human in the loop.** None in steady state. The data owner reviews the first panel against the outcome baseline numbers (Namshi KSA 24,684 units in 12 weeks, Noon UAE 4,953, exact) once; after that only failed checks page a person.

**Edge cases and failure modes.** Options with no option id (935 SKUs, exact) are carried on their SKU and flagged `no_option_id`. Noon and Namshi share stock pools per country: `stocked_size_days` is per channel-country as `brep` reports it, not de-duplicated. The Trendyol feed stopped after 22 Oct once; a stale source nulls its columns and flags the week. A deploy mid-rebuild: the job writes to a staging table and swaps atomically.

**Buy or build.** Build as SQL on BigQuery (keep the existing warehouse pipelines; reuse the panel definition already exported read-only in the outcome baseline, `scratchpad\power.py`). No vendor sells a panel from our own sales; digital shelf tools use their own scraped data.

**Acceptance tests.** (1) Run the rebuild; query the 12 weeks to 1 Nov; totals per channel-country match the outcome baseline table within 1%. (2) Pull one option's weeks and compare by hand against the raw sales, ads and stock tables. (3) Break the Noon price feed in staging; the rebuild nulls price for that week and raises the flag. (4) Add a calendar row for White Friday; the panel shows the flag on the right weeks.

**Open questions.** (a) Count units by `ordered_date` or by `original_ordered_date`? Default: `ordered_date`, as the baseline did. (b) Revenue basis incl. or excl. VAT? Default: `revenue_usd` as stored (excl. VAT), and ad sales left as the portal reports them (probably incl. VAT), with a note on the dashboard.

### M4-F2 Randomized holdout (P0)

**User story.** As the owner, I want half of the eligible Namshi and Noon options to get the new content and half to stay as they are, chosen by a coin flip inside matched pairs, so that in 12 weeks I know whether the content moved sales or whether it was the season, the ads or the price.

**Functional requirements.**
- M4-F2-R1 (unit): the unit of assignment is the **style** (all colour options of a design) on **all** of its Namshi and Noon listings in UAE and KSA at once. Reasons: colour siblings share pages, swatches and shoppers, so treating one colour and holding out another would leak the effect between arms; the same option's content is shared across UAE and KSA on these channels (to be confirmed by M9's scrape, open question c); Noon and Namshi share a stock pool per country. Outcomes are still measured per listing-week and the standard errors are clustered by style.
- M4-F2-R2 (eligibility, evaluated on the day of assignment from the panel): apparel department; live and stocked at least 4 days in at least 80% of the last 12 weeks on at least one in-scope listing; not a broken size run in the last 4 weeks; not flagged for clearance or delisting by the merchandising sheet; gallery on the channel below the channel's shot-set rule as observed by M9's scrape or by M0 records (the treatment must actually change something); no open content rejection. Expected pool: about 1,400 apparel options before the gallery filter (sim), which the crops-first treatment keeps almost whole (98% lack the five-shot set, exact on the audit sample).
- M4-F2-R3 (strata and pairs): strata = brand x department x channel presence (Namshi only, Noon only, both) x pre-period units band (8-week ordered units across in-scope listings: 0, 0-1, 1-4, 4+ per week). Inside each stratum, styles are sorted by pre-period log units and paired; one of each pair is treated by a seeded random draw. Odd styles in a stratum form a triple with 2:1 or 1:2 at random. The seed, the sort key and the pair ids are stored.
- M4-F2-R4 (freeze): after `freeze`, assignments cannot change. A style that later fails eligibility (goes out of stock, is delisted) stays in its arm and in the analysis (intention-to-treat, "ITT": we analyse by what we assigned, not by what happened, because what happened may itself be an effect of the treatment).
- M4-F2-R5 (guards): every control style gets a `guard` in M0 on all its in-scope listings until the experiment's `guard_until` (readout date plus 2 weeks). Any publish attempt to a guarded listing is refused by M0 and logged as `experiment.contamination`. Treated styles get a guard against *further* content changes other than the registered treatment for the same period, so the arm stays a single, nameable change.
- M4-F2-R6 (balance): after assignment, a balance table is produced: per arm, pre-period units, ad clicks, ad spend, stocked days, price, gallery count, brand mix, with standardized differences. Any absolute standardized difference above 0.1 on a pre-registered covariate triggers a re-draw with a new seed (at most 5 draws, all logged) before freeze, never after.
- M4-F2-R7 (treatment definition for experiment 1, as settled at gate 1): "complete the channel's apparel shot set by crops of the brand's own photos, rendered to the channel's rules; no generated images". Each treated listing's `treatment_event` carries the roles added and the source per image, so that a later split (crop-filled versus generated) is possible without a new experiment.
- M4-F2-R8 (pure holdout after readout): at the 12-week readout, 80% of control styles are released to treatment as wave 2 (which gives the staggered design its second wave for free), and 20% (about 140 styles) remain a never-treated holdout for 12 more months to measure long-run and cannibalisation effects. Admin-configurable share.
- M4-F2-R9 (compliance): the share of treated listings verified live by M9's scrape is reported daily. Target: 90% verified within 14 days of `intended_live_at`. Below 70% at the week-2 safety check, the owner is told and the readout dates may be moved once, before any outcome is looked at (the move is logged in the registry).

**Non-functional.** Assignment of 2,000 styles runs in under a minute and is reproducible from the seed. The eligibility query and the balance table are stored with the experiment so the pool can be rebuilt a year later.

**Configuration.** Eligibility thresholds, strata definitions, band edges, balance tolerance, guard period, the released share after readout, the compliance thresholds.

**Inputs and outputs.** In: the panel, M0 listings and styles, M9 gallery observations. Out: `experiment_assignment`, M0 guards, two CSV exports (treated list for the channel upload team; the full arm list only for the measurement owner).

**Human in the loop.** The owner approves the pre-registration before freeze (one click after reading a one-page summary). The channel team uploads the treated content in bulk in week one (no Namshi or Noon API). Nobody picks or swaps individual options; swaps are refused by design. The owner approval stays permanent for new experiments that change spend or brand-truth content; after three clean experiments of a change type, new waves of that type freeze on a 48-hour silence rule (the owner is told and can object).

**Edge cases and failure modes.** A style with listings on only one channel is still one unit (its stratum records that). A style whose colours are split across departments is assigned by its majority department. A control style that the channel team edits anyway: the `listing.changed_externally` event marks it `contaminated`; it stays in the ITT analysis and a sensitivity analysis drops contaminated pairs. The channel rejects a treated upload (Noon "Content Issues"): the listing stays treated in ITT; compliance falls; the rejection reason is logged for M9. White Friday falls inside the window: the concurrent control absorbs the level shift, the event flag lets the estimator test for an interaction, and the readout reports effects with and without the event weeks. The upload is late by two weeks: the clock starts at the median `verified_live_at`, decided at the safety check, before any outcome is seen.

**Buy or build.** Build (a Python job: pandas plus numpy; no vendor randomizes marketplace listings). Considered: GrowthBook and Eppo (open-source experiment platforms) are built for user-level web tests, not paired style clusters on count panels; their CUPED and sequential code is worth reading, not running.

**Acceptance tests.** (1) Run assignment on the real pool; the result has about 700 vs 700 options, a balance table with no covariate above 0.1, an MDE in the registry, and a seed that reproduces the same arms when re-run. (2) Try to publish a crop to a control listing through M3's normal path: M0 refuses and the contamination log shows it. (3) Re-run assignment after freeze: refused. (4) Two weeks after upload, the compliance view shows the verified-live share from M9's scrape.

**Open questions.** (a) Treat both UAE and KSA together or split countries? Default: together (content is shared, see c). (b) Include footwear? Default: no for experiment 1 (the treatment is apparel shots; footwear becomes experiment 2 once M3 fills footwear views). (c) Is content shared across countries on Namshi and Noon? Default: assume yes; M9's first scrape confirms within week one, and if not, the country becomes a stratum. (d) Pair on units or on a blend of units and ad clicks? Default: units (the primary metric), with ad clicks checked in balance.

### M4-F3 Experiment registry and pre-registration (P0)

**User story.** As the owner, I want every experiment written down before it starts, with the question, the metric, the sample, the smallest lift it can see and the dates I will get an answer, so that nobody can change the question after seeing the data, including us.

**Functional requirements.**
- M4-F3-R1: a registry row has: name; one-sentence hypothesis; change type; channels and countries; unit; eligibility rule text and query hash; strata; sample per arm; pre and post weeks; primary metric (one only); secondary metrics (labelled exploratory); guardrail metrics (liveness, rejections, returns share); primary estimator and inference method; covariates allowed in the primary model (pre-period values only); exclusion rules decided in advance; readout dates; safety-check dates and what they may look at; stopping rules; the simulated MDE at each readout; expected effect and its source; the analysis code commit; the owner's approval and time; the freeze hash.
- M4-F3-R2: no experiment can enter `running` without a stored MDE computed by the simulation harness on the actual assigned pool with the primary estimator (placebo starts rotated over the pre-period, a known lift injected, as in the outcome baseline).
- M4-F3-R3: the registry prints a one-page pre-registration in plain words ("We are testing whether ... on ... We will know on <date>. We can detect a lift of X% or more. We expect 1-5%, so the likely answer is 'below X%'.") for the owner's approval, and the same page is what the dashboard shows at readout, with the results filled in.
- M4-F3-R4: after freeze, only `notes`, `status` and `compliance` fields change. Any other change creates a new experiment version with the reason, visible on the dashboard as "amended after start" in red.
- M4-F3-R5: the readout cannot run before the pre-registered date (the job refuses) except for the safety checks, which are restricted to compliance, balance drift, guardrail harms and data freshness, and never compute the effect.
- M4-F3-R6: every readout stores the exact query, the code commit, the data `as_of`, the estimate, the 90% and 95% intervals, the randomization p-value, n per arm, compliance, the placebo result and the event-study table, so it can be reproduced.
- M4-F3-R7: the registry holds non-randomized "observational studies" too (M10 will need them), with a flag that makes the dashboard label them "association, not a controlled test".

**Non-functional.** The registry is the system of record in the module's Postgres with a daily export to BigQuery; a row is under 50 KB; readout artefacts (tables, plots) go to a bucket with the experiment id in the path.

**Configuration.** Default alpha (5% two-sided), power (80%), interval level, the safety-check field whitelist, the plain-words template, the owner's approval rule.

**Inputs and outputs.** In: the draft from the API; the assignment and MDE. Out: the frozen row, the one-page summary, `experiment.frozen`.

**Human in the loop.** The owner approves before freeze. Nobody else edits a running experiment. After three clean experiments of a change type the approval becomes a 48-hour silence rule.

**Edge cases.** A feed outage inside the window: the exclusion rule "weeks where a source is stale for both arms are dropped" is already pre-registered, so dropping them is not a change. The owner wants a different metric after week 4: refused as an amendment to the primary, allowed as a new exploratory secondary, labelled as such.

**Buy or build.** Build (a table, an API and a template). Considered: OSF-style pre-registration forms (the AsPredicted template) as the wording model; nothing to buy.

**Acceptance tests.** (1) Register experiment 1 end to end; the one-pager prints with an MDE of about 18% at 12 weeks (sim; re-simulated on the real pool); the owner approves; freeze succeeds. (2) Try to change the primary metric after freeze: a new version is created and flagged red. (3) Run the readout job on day 20: refused; run the safety check: it returns compliance and balance only.

**Open questions.** (a) Store the registry in Postgres or only in BigQuery? Default: Postgres (transactions, API), exported daily. (b) Who besides the owner can approve? Default: nobody until M12 roles exist.

### M4-F4 Guardrails (P0)

**User story.** As the measurement owner, I want the ad agencies, the merchandising team and our own modules to be unable to tilt the test by accident, and to know within a day when something did.

**Functional requirements.**
- M4-F4-R1 (blind arms): the agencies and the channel team receive only the treated list they need to upload; nobody outside the measurement owner receives the control list or the pairs. The dashboard hides arm labels on per-listing views until readout.
- M4-F4-R2 (ad and price change log): weekly, the panel compares ad spend, ad clicks and active price between arms within strata; a standardized difference above 0.2 in post-period ad spend or price raises `experiment.contamination` with the affected brands, and the readout reports it. We cannot freeze bids (the agencies run them) but we can see and report any tilt.
- M4-F4-R3 (change watch): M9's scrape of our own Namshi and Noon listings runs at least weekly on every listing in a running experiment (daily for the first 3 weeks); any change in gallery count, image hashes or title on a control listing, or an unregistered change on a treated one, becomes `listing.changed_externally`, marks the style `contaminated` and is listed on the dashboard.
- M4-F4-R4 (event calendar): events are entered before the window starts; a readout that includes event weeks shows the effect with and without them.
- M4-F4-R5 (stock and liveness guardrails): the week-2 and week-4 safety checks compare liveness rate and content rejections between arms; a treated-arm drop in liveness of more than 3 points versus control pauses new uploads of that treatment type and tells the owner (the experiment itself continues).
- M4-F4-R6 (data settle): a readout runs only on data whose `as_of` is at least 7 days after the last week in the window, so restatements have landed.
- M4-F4-R7 (contamination accounting): the readout reports the number of contaminated styles per arm, the ITT estimate including them, and the sensitivity estimate dropping their pairs.

**Non-functional.** Alerts within 24 hours of the scrape; the scrape itself is M9's cost (about 1,400 listings weekly at low rate).

**Configuration.** Thresholds (0.2, 3 points, 7 days), scrape cadence, recipients of blind lists.

**Inputs and outputs.** In: the panel, M9 observations, the ads tables. Out: contamination events, the dashboard's "Protection" panel, the lists.

**Human in the loop.** The owner is the only holder of the full arm list. Agencies are asked once, in writing, to keep bids and budgets as they would have been; their compliance is observed, not enforced.

**Edge cases.** An agency raises bids on the whole brand (both arms): no tilt, nothing to do. An agency raises bids on sellers, which are more often treated if the treatment works: this is part of the treatment's total effect (see Appendix A.3 on indirect effects), reported as a secondary outcome "ad spend per listing", not removed. The channel re-indexes all galleries (a platform change): hits both arms; the week fixed effects absorb it.

**Buy or build.** Process plus build. Nothing to buy.

**Acceptance tests.** (1) Edit a control listing's title on Namshi by hand (one listing, with the channel team); within 7 days it appears as contaminated. (2) Raise Noon bids on 20 treated options in a staging copy of the ads table; the weekly check flags the brand. (3) The agencies' blind-list email contains no control option.

**Open questions.** (a) Daily or weekly scrape after week 3? Default: weekly, daily during any upload week.

### M4-F5 Estimators (P1)

**Story.** As the measurement owner, I want a tested library that turns the panel and an assignment into an effect with an honest interval, using methods anyone can check, and that fails loudly when its assumptions do not hold.

**Key requirements.**
- M4-F5-R1: implements, with one interface (`estimate(panel, assignment, spec) -> Readout`): (a) ANCOVA on log(units + 0.25) with the 8-week pre-period mean as a covariate and stratum fixed effects, the design the MDE table was simulated on; (b) Poisson pseudo-maximum-likelihood regression of weekly units on treated x post with listing fixed effects and week x channel-country fixed effects, which reads directly as a percent lift and handles zeros without the "+0.25" trick; (c) CUPED-style regression adjustment with several pre-period covariates (units, ad clicks, stocked days) and treatment-by-covariate interactions (the Lin 2013 form, which cannot hurt precision); (d) staggered difference-in-differences with not-yet-treated and never-treated controls (Callaway and Sant'Anna estimator, with a stacked-regression fallback), with an event-study plot and a pre-trend test; (e) synthetic control or Bayesian structural time series (CausalImpact style) for channel-level or country-split designs where units are few.
- M4-F5-R2: inference is by randomization test as the primary: re-draw the assignment 1,000 times within the stored pairs and strata, recompute the statistic, and report the share of draws at least as extreme as the observed one. Cluster-robust standard errors by style are reported next to it. Both must be in the readout.
- M4-F5-R3: the placebo suite runs with every readout: (a) an A/A test on the 8 pre-period weeks with the real assignment (must show no effect; if its p-value is below 0.05 the readout is marked "pre-period imbalance" and the estimate is shown in grey); (b) a known injected lift recovered within 2 points.
- M4-F5-R4: covariates in the primary model are pre-period values and the calendar only. Concurrent ad spend, price and stock are never covariates in the primary model, because the treatment can move them (a "bad control" would hide part of the effect). They appear as secondary outcomes and in sensitivity models that are labelled as such.
- M4-F5-R5: output shape: point estimate as percent lift, 90% and 95% intervals, randomization p-value, n per arm, clusters, weeks, compliance, contamination counts, the A/A result, per-week event-study estimates, per-stratum estimates (shrunk, see M10) and a plain-words sentence.
- M4-F5-R6: Namshi and Noon are stacked as four channel-countries with week x channel-country fixed effects; the primary estimate is the stacked one; per-channel-country estimates are secondary (their MDE is 23-29% each, sim).

**Acceptance test.** On the exported 25-week panel: (1) the harness recovers an injected +20% lift within 2 points for ANCOVA and Poisson; (2) placebo starts give a p-value below 0.05 about 5% of the time; (3) the staggered estimator on a fake three-wave rollout recovers the injected effect and the event-study plot shows no pre-trend; (4) the whole readout runs end to end in under 10 minutes on the real pool.

**Buy or build.** Build on open source, Python: statsmodels (GLM Poisson with fixed effects via `linearmodels` or absorbed dummies), `csdid` or the `differences` package for Callaway-Sant'Anna, `tfcausalimpact` or `pycausalimpact` for the structural time series, numpy for randomization inference. Fallback order if a package fails our checks: the R packages `did`, `fixest` and `CausalImpact` called from a container. Licences are checked in M7's bake-off list (I013).

### M4-F6 Country-split and staggered designs (P1)

**Story.** When style-level pairs are too few (a small brand, footwear, a text change on one channel), I want to change the UAE listing and hold KSA, or roll a change out in waves, and still get an estimate.

**Key requirements.**
- M4-F6-R1: country-split is available only on channels where M9's scrape confirms content is independent per country (Amazon .ae and .sa are; Namshi and Noon probably are not). The registry refuses a country-split on a shared-content channel.
- M4-F6-R2: wave rollouts register all waves at once (dates, pools) and keep a never-treated holdout of at least 20% for the full window; the estimator is the staggered DiD with the event study, and the readout shows the effect by wave and by weeks since treatment.
- M4-F6-R3: a rollout with no holdout is registered only as an observational study (synthetic control cross-check mandatory), labelled as such on the dashboard.

**Acceptance test.** Register a three-wave rollout of a title change on Amazon KSA versus UAE; the estimator runs and the readout shows by-wave estimates and the pre-trend check.

**Buy or build.** Build on the F5 library.

### M4-F7 Faster secondary signals (P1)

**Story.** I want earlier hints than 12 weeks where a faster signal exists, labelled as hints.

**Key requirements.**
- M4-F7-R1: ad click rate (clicks / impressions, sum then divide) per listing-week is a registered secondary metric for main-image changes only; MDE about 30-45% with 100 options over 4-12 weeks (sim). Its readout says "hint, main image only".
- M4-F7-R2: ad conversion (ad units / clicks) is reported but never primary (MDE 70-130%, sim).
- M4-F7-R3: returns share (Namshi size-and-fit reason share, net units / ordered units) is a guardrail and a secondary.
- M4-F7-R4: if the Noon traffic feed (`traffic_sales_noon_3p_*`, stopped 4 Feb 2026) is restored, conversion (units / visitors) becomes a registered secondary on Noon and the MDE is re-simulated; the registry has a slot for it.
- M4-F7-R5: Amazon unit-session rate is available for the Amazon designs in F6.

**Acceptance test.** Register a main-image experiment with ad click rate as secondary; the readout shows its estimate and interval with the "hint" label and the primary units estimate separately.

**Buy or build.** Build (panel columns plus F5).

### M4-F8 Outcome dashboard per channel (P1)

**Story.** As the owner, I want one page that shows what is running, what we learned and what we cannot know yet, with uncertainty on every number, that I can read in two minutes.

**Key requirements.** See section 5 for the screens. R1: every effect is shown as a range first and a best guess second, never the other way round. R2: every tile shows n, the MDE and the pre-registered date. R3: exploratory and observational results are visually separated and labelled. R4: per-channel organic units and ad metrics over time with the experiment windows and events marked.

**Acceptance test.** A person who has not seen the project reads the readout page and correctly answers: what was tested, what the answer is, how sure we are, and what is still unknown.

**Buy or build.** Build in the module's web app (`apps/web`); charts with an open-source library.

### M4-F9 Public market covariates (P2)

Buy competitor price, our search rank and review counts for our own and competing listings (Actowiz or DataWeBot for Noon and Namshi, Bright Data for Amazon; about USD 1,200-1,500 a month for 5,000 SKUs, judgement). Search rank is the only visibility proxy available on channels with no traffic data; it is used as a secondary outcome and a leading indicator, not as a covariate in the primary model. Legal review of terms before any market-scale scraping.

### M4-F10 Calibration against Amazon MYE (Later)

If Brand Registry access on amazon.ae or .sa ever exists, run Amazon's own randomized test on a few high-traffic ASINs and compare with our estimate for the same change. Availability on .ae and .sa is unverified and softline traffic (4 options over 100 sessions a week, exact) makes few ASINs eligible. Not a dependency for anything.

## 5. Operator experience

There is no operator work in M4. The people who see it are the owner (Sujan), the measurement owner, and the channel upload team (who only see a list).

**Screens.**

1. **Experiments** (list): cards with name, status (Draft, Assigned, Running, Readout due <date>, Read out, Amended), days to readout, compliance %, contamination count, and a "Protection" strip (blind lists sent, guards active, last scrape date). No effect numbers on running cards, by design.
2. **Pre-registration** (one page): the plain-words summary from F3 with an Approve button. Copy for the key line: "We can detect a lift of 18% or more. We expect 1-5%. The most likely answer is 'below 18%', which still tells us where not to spend."
3. **Readout** (one page, same layout as the pre-registration, filled in). Top sentence pattern: "Completing the apparel shot set changed weekly ordered units by between -6% and +14% (best guess +3%). We can rule out a lift above 14%. 1,380 listings, 12 weeks, 91% of treated listings verified live." Below: the event-study chart (effect per week with bands), the balance and contamination table, the A/A check, secondary metrics in a grey box labelled "exploratory", and "What this does not tell us" (per-SKU effects, effects below the MDE, effects on Styli or Centrepoint).
4. **Channel outcomes**: per channel-country, weekly organic units (total units minus ad units), ad clicks and spend, liveness, with experiment windows and calendar events shaded. A toggle "show arms" is disabled until readout.
5. **Protection**: contamination events with the listing, what changed, when, and the arm (visible to the measurement owner only).

**Copy rules.** Never a bare point estimate. Never "significant" without the interval. "We cannot tell" is a valid and expected result and is shown in neutral colour, not red.

## 6. Measurement

| Metric | Baseline | Target | Source |
|---|---|---|---|
| Panel freshness | none (no panel exists) | under 24 h after the warehouse rebuild, 95% of days | `catalog_os.outcome_panel_weekly.as_of` |
| Covariate coverage (share of listing-weeks with ads, stock and price present, Namshi and Noon) | ads 100%, stock since 4 Aug, Noon price 75% of days, Namshi price since 14 Oct (exact) | 95% for all three from December | panel nulls |
| Experiments without pre-registration | n/a | 0 | registry |
| MDE of experiment 1 | about 18% at 12 weeks (sim) | registry holds the re-simulated value; report it, do not target it | registry |
| Treated listings verified live within 14 days | none measured | 90% | M9 observations |
| Contamination incidents | unknown (no watch exists) | reported; under 5% of styles | contamination log |
| Placebo (A/A) pass | n/a | p-value above 0.05 at every readout | readout |
| Readouts delivered on the pre-registered date | n/a | 100% | registry |

M4 is also measured by what it saves: a bounded null at 12 weeks redirects spend to text (the brief's stated expectation), which is worth the cost of running the test many times over. The cost of holding out 700 options is at most 700 x 12 weeks x the true lift x about USD 5 of weekly revenue per option (judgement from 41,000 Namshi units and about USD 25 per unit): under USD 2,100 even at a 5% lift.

## 7. Build slices

Each slice is one worker in one worktree. S7 in the module map is split here.

| # | Slice | Depends on | Acceptance test |
|---|---|---|---|
| M4-S1 | Outcome panel and event calendar (F1): SQL, scheduled rebuild, checks, calendar table seeded with 2026-27 events | warehouse access; M0 export can land later (the `content_version_id` column is null until then) | Totals match the outcome baseline within 1%; a broken source nulls and flags |
| M4-S2 | Style key and candidate pool (F2 R1-R2): style heuristic agreed with M0, eligibility query, pool report | M4-S1; M9 gallery scrape for the gallery filter (fallback: Trendyol image counts and M0 records) | Pool report lists about 1,400 apparel options as styles with a confidence per style key |
| M4-S3 | Stratified pair randomization, balance, freeze, guards (F2 R3-R6, F3 R1-R4) | M4-S2; M0 `guard` field | Reproducible arms from a seed; balance under 0.1; publish to a control refused |
| M4-S4 | MDE harness and pre-registration one-pager (F3 R2-R3): port `power.py` into the module, run on the assigned pool for ANCOVA and Poisson | M4-S3 | MDE stored; one-pager printed; owner approves |
| M4-S5 | Guardrails (F4): blind-list export, weekly tilt check, contamination events from M9, safety-check job | M4-S3; M9 live content watch | Hand-edited control appears as contaminated within 7 days |
| M4-S6 | Estimator library v1 (F5 a, b, c, randomization inference, placebo suite) | M4-S1; needed by week 6 | Injected +20% recovered within 2 points; A/A false positive rate about 5% |
| M4-S7 | Readout job and readout page (F3 R5-R6, F8) | M4-S6; week 8 | Readout refuses before the date; page passes the two-minute reading test |
| M4-S8 | Staggered DiD, country-split, synthetic control cross-check (F5 d-e, F6) | M4-S6 | Three-wave fake rollout recovered; shared-content channel refused for country split |
| M4-S9 | Secondary signals and channel outcomes view (F7, F8 R4) | M4-S1, M4-S7 | Ad click rate readout labelled "hint"; channel view shows windows and events |

Order: S1 to S5 are P0 and must finish before 10-17 Nov (S1, S2, S3 in parallel with S5's M9 dependency; S4 last). S6 and S7 by week 8 of the holdout. S8 and S9 inside the 12-week window.

## 8. Risks and open questions

**What this module cannot learn, said plainly.**
1. One experiment sees lifts of about 18% or more. The expected effect is 1-5% (judgement). The honest result is most likely "below 18%", which is a bound, not a lift. Small effects become visible only by pooling several waves (about 7% MDE after four waves of 1,200 listings, sim extrapolation), which assumes the effect is the same across waves and seasons.
2. Per-SKU answers do not exist. No single option on any GCC channel can detect even a 50% lift in 12 weeks (sim). Anyone asking "did this product's new image work" gets "we cannot know; here is the group answer".
3. Per channel-country, the MDE is 23-29% (sim); per brand x channel cells, 25-45%. Cell estimates come from M10's pooling and are mostly the programme average dressed in the cell's name.
4. Namshi and Noon have no traffic data, so a unit lift cannot be split into "more visitors" (ranking) and "more buyers per visitor" (conversion). Search rank from a scrape (F9) is a proxy, not a measurement.
5. Styli, Centrepoint, 6th Street, Shein, VogaCloset, Trendyol UAE and Amazon are not measurable on sales (7-124 units a week per channel-country, exact). They get acceptance and liveness, not lift.
6. Keyword effects cannot be found from organic sales. Paid search-term data and ad click rate are the usable signals (M10).
7. Interference: a treated style can take sales from a control style of the same brand. That inflates the measured lift relative to a world where everything is treated. The 20% never-treated holdout and the brand-level totals are checks, not fixes. A design with varied treated shares per brand (to measure spillover) is possible in a later wave at a power cost.
8. The 12-week window includes White Friday; an effect found may be partly event-specific. Effects beyond 12 weeks (ranking compounding) are unknown until the long holdout reads out.
9. Observational studies (changes that were not randomized) are weaker and are always labelled so.

**Risks.**

| Risk | Effect | Mitigation |
|---|---|---|
| Style key heuristic is wrong (master has no style id; names are inconsistent, "Default" category for US Polo) | leakage between arms through colour siblings | M0 owns the key with a confidence; low-confidence styles are their own cluster; the channel team confirms sibling groups for the top 200 styles |
| Channel upload slips past 17 Nov into White Friday week | noisy start, delayed clock | the clock starts at median verified-live, set at the safety check; readout dates move once, logged |
| Namshi or Noon reject crops or re-order galleries | low compliance | ITT keeps the estimate honest; compliance is reported; crops-first avoids the AI-image stance |
| Agencies shift budget to treated sellers | total effect includes an ad path | reported as a secondary outcome; sensitivity model with ad spend labelled "bad control" |
| M9 scrape is blocked or slow | live verification and contamination watch fail | low-rate scrape of our own 1,400 listings; fall back to M0 records plus Trendyol fields; ask the channels for a content export |
| Warehouse restates or a feed dies mid-window (Trendyol did on 22 Oct) | missing weeks | panel checks, 7-day settle, pre-registered exclusion rule |
| Someone looks at the effect early and acts | peeking bias, the test is spent | the readout job refuses before the date; safety checks never compute the effect; arms hidden on the dashboard |
| The result is a bounded null and is read as "content does not matter" | wrong lesson | the one-pager says in advance what a null means and what it does not |

**Open questions (defaults in brackets).**
- Primary estimator: ANCOVA (simulated) or Poisson FE? [Poisson FE as primary once S4 shows its MDE is at or below ANCOVA's on the real pool; otherwise ANCOVA. Both always reported.]
- Country as one unit or split? [One unit, pending M9's shared-content check.]
- Footwear in experiment 1? [No; experiment 2.]
- Released share of controls after readout? [80%, keep 20% for 12 months.]
- Who may approve a pre-registration? [Sujan only, until M12 roles.]

## Appendix A - Method design (requested detail)

Written for the builder agents and for Sujan to check the reasoning. It does not add requirements; the requirements above point to it.

### A.1 Why randomize at all, and at the style level

On these marketplaces we cannot randomize shoppers (no page-level A/B exists outside Amazon Brand Registry). What we can randomize is **which listings get the change**. That is enough for a causal answer because the coin flip, not the merchandiser, decides who is treated, so treated and control groups are alike on average in everything, including the things we cannot see (platform ranking, agency attention, fashion cycles). Randomization does not need the confounders to be measured; measuring them only makes the estimate more precise and lets us check the coin flip worked (balance).

The unit is the style because of **interference**: if two colours of one design share a page and shoppers, treating one colour changes the other's sales too, and the "control" is no longer untouched. The query of 2026-11-02 shows this is not hypothetical (U.S. Polo: 80% of selling options have a colour sibling). Clustering by style costs some power (fewer independent units), but the apparel brands in the pool are mostly single-colour styles (74-98% by the colour heuristic), so the loss is small; S4 re-simulates it.

### A.2 Outcome and confounder model

Outcome rows are listing-weeks. The primary outcome is **ordered units** because it is the only outcome present on every channel and because conversion (units per visitor) does not exist on Namshi and Noon. Weekly, not daily, because daily units are almost all zero (median selling option: 0.33 units a week on Namshi, exact).

Confounders fall in three groups and are handled differently:
- **Time-varying, common to all listings** (season, White Friday, Ramadan, platform changes): absorbed by week x channel-country fixed effects (a separate baseline per week per channel-country) plus the concurrent control. Nothing to model.
- **Fixed per listing** (brand, price tier, category, page age): absorbed by listing fixed effects or by the pre-period covariate. Nothing to model.
- **Time-varying per listing** (stock, price, discount, ads): balanced by randomization in expectation. Pre-period values are used as covariates to shrink noise (CUPED). **Post-period values are not used in the primary model**, because the treatment can change them (an agency raises bids on a listing that started selling; a size sells out because the listing converts). Adjusting for them would remove part of the very effect we are measuring. They are reported as secondary outcomes ("did treatment change ad spend, stock-outs, price?") and in a labelled sensitivity model.

Stock has a special role: a listing with no stock cannot sell regardless of content. The eligibility rule (stocked 80% of weeks) removes most of this noise, and the baseline showed that restricting further does not help (MDE unchanged, sim). Stocked size-days stays a pre-period covariate and a post-period guardrail.

### A.3 Indirect effects

Sujan asked for indirect effects to be included. Three kinds, and what we do with each:
1. **Within the option across channels**: better Namshi content changes Noon sales of the same option (shared stock pool, shared shopper). Handled by treating all in-scope listings of a style at once and measuring the total.
2. **Through ads**: better content raises ad conversion, which lowers cost per sale, which makes agencies spend more, which raises sales further. This path is part of the treatment's real-world effect. The primary estimate (intention-to-treat on total units) includes it. We report ad spend, ad clicks and ad conversion as secondary outcomes so the owner can see how much of the lift ran through ads. A "direct effect holding ads fixed" is not identifiable without an ad experiment; we do not claim it.
3. **Across styles (cannibalisation)**: a treated style takes sales from control styles of the same brand. This biases the measured lift upward relative to treating everything. We report it as a limit, keep a never-treated 20% holdout, compare brand totals, and offer a saturation design (vary the treated share per brand x category cell at random) as a later wave if the first readout is positive enough to make the question matter.

### A.4 Estimators

- **ANCOVA** ("analysis of covariance"): regress the post-period average of log(units + 0.25) on the treatment flag and the pre-period average of the same, with stratum dummies. The pre-period covariate removes the part of the variation that is just "this listing always sells more", which is most of it. The MDE table in the outcome baseline was simulated on this design; its weakness is that log(units + 0.25) understates relative lift on slow sellers, which is why the MDE was calibrated by injecting a known lift.
- **Poisson with fixed effects**: model expected weekly units as exp(listing effect + week x channel-country effect + beta x treated x post). Beta reads as a percent lift (exp(beta) - 1), zeros are natural, and no constant is added to the data. It is a pseudo-likelihood: it does not assume units are Poisson, only that the mean is multiplicative, and the clustered standard errors are valid under the heavy over-dispersion we see (variance 7-17 times the mean, sim). This is the standard fix for the problems of log(1 + y) models.
- **CUPED-style adjustment**: "controlled-experiment using pre-experiment data" is the industry name for using the pre-period as a covariate; the ANCOVA above is one form. The library's general form regresses on several centred pre-period covariates and their interactions with the treatment, which is guaranteed not to make precision worse in large samples.
- **Staggered difference-in-differences** ("DiD": the change over time in treated units minus the change over time in controls, so that anything that moved both cancels out). With waves treated at different times, the naive two-way fixed-effects regression can be biased because already-treated units act as controls for later ones. The Callaway and Sant'Anna estimator avoids this by comparing each wave only with not-yet-treated and never-treated units, then averaging. The event-study plot (effect per week relative to treatment) is the main diagnostic: flat before treatment, then the effect. The wave-2 release of controls at week 12 (F2 R8) gives us this design without any extra cost.
- **Synthetic control or structural time series**: when the treated unit is one channel or one country, build a weighted mix of untreated series that tracked it before treatment and compare after. Only a cross-check here; it needs long clean pre-periods, which we barely have.
- **Randomization inference**: because we know exactly how the coin was flipped (pairs within strata), we can ask "if the treatment did nothing, how often would a re-flip produce an estimate this large?". No distributional assumption, exact under the null, robust to the heavy tails. This is the primary p-value.
- **Hierarchical Bayesian pooling** lives in M10 (section A of that file) and consumes the per-experiment and per-cell estimates and standard errors produced here.

### A.5 Power and the "below X%" rule

The MDE is a property of the design, not a target. For experiment 1: about 27% at 4 weeks, 20% at 8, 18% at 12 with 800 treated listings; 22%, 16%, 14% with 1,200 (sim). Options with higher baseline sales do not help enough to justify shrinking the pool (sim).

When the readout says "we cannot rule out zero, and we can rule out anything above X%":
1. Report the upper bound as the finding: "the lift, if any, is below X%".
2. Compute the **break-even lift** for the change type in that scope: yearly cost of applying it catalog-wide divided by yearly revenue it touches. For crops on apparel this is tiny (under USD 100 of compute on about USD 0.75M of revenue), so a bound of 14% does not stop a cheap change; it stops *claims* about it.
3. If the upper bound is below the break-even lift: stop applying, record a "no" for this scope.
4. If the bound is above break-even and the best guess is positive: keep applying by default (it is cheap), keep the never-treated holdout, and let the next wave add to the pool. Four waves of 1,200 listings bring the pooled MDE to about 7% (sim extrapolation), which is in the range of the expected effect.
5. Set a learning budget per change type (default: 4 waves or 12 months). After that, the change type is "parked: not measurable at our volume", which is a valid end state and is shown as such.
6. Prefer the next experiment where the expected value of knowing is largest: large revenue touched, cheap to apply, plausible effect size relative to the MDE. M10 owns that ranking.

### A.6 Guardrails against fooling ourselves

- **Pre-registration with a frozen hash** (F3): the question, the metric, the pool and the code are fixed before data.
- **One primary metric**; secondaries are exploratory and labelled. Across many cells and change types, M10's partial pooling shrinks lucky cells toward the average, which is the multiplicity correction we rely on; for any per-cell confirmatory claim we also apply a false discovery rate control at 10% (Benjamini-Hochberg).
- **No peeking**: readouts only on the registered dates; safety checks cannot compute the effect; arms are hidden. If an interim look is ever wanted, it must be registered up front with an alpha-spending rule (O'Brien-Fleming), which makes early looks very conservative.
- **Placebo and A/A tests** at every readout; a failed A/A greys out the result.
- **Novelty and season**: the event-study shows whether an effect fades (weeks 1-4 versus 9-12); readouts with and without event weeks.
- **Winner's curse**: the number shown as "the effect" is the shrunk estimate from M10 once pooling exists, never the raw cell maximum.
- **Restatement and freshness**: 7-day settle, panel checks.
- **Blind arms and change watch** (F4).
- **Reproducibility**: every readout stores query, code commit, data `as_of`.

### A.7 What a 12-week timeline looks like

Week 0 (by 17 Nov): panel, pool, assignment, pre-registration approved, guards on, blind lists out, upload starts. Weeks 1-3: daily scrape for live verification; week-2 safety check (compliance, balance drift, guardrail harms). Week 4: safety check. Week 8: first readout (MDE about 20%). Week 12: second readout (MDE about 18%), release 80% of controls as wave 2, keep 20% for 12 months. Week 13-14: M10 updates priors; next experiment registered (footwear views, or text on Noon).
