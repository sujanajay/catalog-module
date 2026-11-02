# M10 - Learning engine

Requirements, 2026-11-02. Follows `00-template.md`. Plain words; jargon defined once. Words defined in `M4-measurement.md` (option, style, listing, treatment, control, lift, MDE, confounder, pre-registration) are used here with the same meaning. Numbers: (exact) from a query, (sim) from the power simulation, (judgement) an assumption.

New words:
- **Change type**: a named kind of content change that can happen to many listings ("add missing apparel shots by crops", "Arabic title added", "converting search term added to title"). Learning happens per change type, never per listing.
- **Scope**: the cell a learning applies to: change type x channel x category (and later brand, price band, audience).
- **Prior**: what we believe about a lift before a new test; **posterior**: what we believe after. Both are ranges, not numbers.
- **Shrinkage** (partial pooling): a noisy estimate for one cell is pulled toward the average of similar cells, more strongly when the cell has little data. It is how a few hundred options per cell can say anything at all.
- **Hypothesis**: a guess about what might lift sales, with an expected size and a source. Hypotheses are not learnings; they wait in a queue to be tested.
- **Promotion**: deciding that a change type is good enough in a scope to apply to the whole catalog in that scope.

## 1. Purpose

M10 turns M4's readouts into a growing, honest body of knowledge about what content sells per channel x category, decides with stated confidence what to scale and what to stop, and carries winners across content types (a search term that converts flows into the title, backend terms and the infographic). Outcome metric: revenue share of the catalog covered by a measured learning, and the standard error per change type falling wave by wave. Intents served: I038 (learn per channel x category x product with controls), I039 (cross-pollination), I028 (ROI on every module), I012 (self-learning, self-evolving), I004, I024.

## 2. Scope

**In (P1, inside the 12-week window):** the change-type library (every content change classified so effects pool across listings); budget and priority (where to spend effort: top 10% of options earn 86% of revenue, approx; measurement works only on Namshi and Noon).

**In (P2, after the first readout):** pooled estimates across brands, categories and channels (the hierarchical model); cross-pollination; recommendations to admins with confidence bounds; the hypothesis queue fed by leading indicators and predictive models.

**Out:** running experiments (M4), writing or publishing content (M3, M8, M9, M11), changing ad bids or prices (not Opptra's catalog business), anything that acts on a listing without a logged treatment and a change type.

**Later:** priors shared across customers once a second customer exists (the multi-brand data advantage, with each customer's raw data kept separate); learning on India channels; learnings used to weight M2's listing quality score.

## 3. Contracts

### Reads

| From | Entity | Used for |
|---|---|---|
| M4 | `experiment`, `experiment_assignment`, `experiment_readout` (per experiment and per stratum estimates with standard errors), `outcome_panel_weekly` | the data the pooled model fits on |
| M0 | `treatment_event`, `content_version` (diffs between versions), `style`, `listing`, `change_reason` | classifying changes; knowing what is live where |
| M2 | analyzer outputs per image and text (roles present, on-model, background, pixel size, text overlay, title length, attribute completeness) | traits for the predictive model and for classifying changes |
| Warehouse | `raw_amazon_adservice.search_term_daily`, `raw_gcc_tables.campaign_noon_3p_*_product_queries` (paid search terms with clicks and conversions), `ads_daily` | keyword winners for cross-pollination; leading indicators |
| M9 | `live_observation` (gallery, title, rank where scraped) | leading indicators; verifying propagated changes |
| M5 | channel rules (title limits, banned words, overlay acceptance) | a propagated change must pass the rules |
| M6 | cost per output type | break-even lifts |

### Writes

| To | Entity | Consumers |
|---|---|---|
| `catalog_os.change_type` | the taxonomy: id, name, content component (image, title, bullets, backend terms, attributes, Arabic, A+, video), action (add, replace, reorder, remove), scope keys, cost class, since version | M0 (every treatment carries one), M4, M9, dashboard |
| `catalog_os.change_classification` | content_version_before x after -> change_type_id(s), confidence, method (rule or model) | M4 (observational studies), dashboard |
| `catalog_os.effect_estimate` | scope x as_of: posterior mean, 90% interval, P(lift > 0), P(lift > break-even), n experiments, n listings, data sources, model version | M4 dashboard, recommendations, M2 quality score weights (later) |
| `catalog_os.hypothesis` | id, text, source (leading indicator, predictive model, operator, cross-pollination), expected lift and range, scope, evidence links, status (queued, registered, tested, parked) | M4 registry (when a hypothesis becomes an experiment) |
| `catalog_os.recommendation` | id, action (scale, stop, test next, park), scope, evidence, confidence label, break-even, expected yearly value with range, approver, status | admin UI, M9 re-enrichment (P2), M3/M8 defaults |
| `catalog_os.promotion` | change type x scope: promoted at, by, rule used, permanent holdout share, rollback condition | M3, M8, M9 (apply by default), M4 (holdout) |
| M4 registry | new experiments (drafts) created from the priority list | M4 |

### API and queue shapes

- `POST /change-types` and `GET /change-types`: admin edits the taxonomy; versions are kept.
- `POST /classify`: `{content_version_before, content_version_after}` -> change types with confidence. Called by M0 on every publish so the treatment log is classified at write time.
- `GET /effects?scope=...`: the current posterior for a scope, with the plain-words label.
- `POST /hypotheses`, `GET /hypotheses?status=queued&order=value`.
- `POST /recommendations/{id}/approve|reject` (owner); `promotion.created`, `promotion.revoked` events consumed by M3, M8, M9.
- Consumed events: `experiment.readout_ready` (refit), `content.published` (classify), `warehouse.panel_ready` (leading indicators refresh).

### Contract needs from M0

1. `change_type_id` on every `treatment_event` from day one (M10 supplies taxonomy v0 in week one: about ten rows, enough for images and the first text changes).
2. A content diff between two versions in a machine-readable form (which image roles added, removed, reordered; title before and after; attributes changed), so classification is a rule, not a guess.
3. `change_reason = learning` with the `recommendation_id` and `promotion_id` on every change M10 caused, so a promotion is itself measurable as a staggered rollout.
4. Enough history (M0's backfill) that the first classification run can label the changes already made by the live tool since October.

## 4. Features

### M10-F1 Change-type library (P1)

**Story.** As the measurement owner, I want every content change we make, or discover on a live page, to be named as one of a short list of change types, so that effects can be pooled across hundreds of listings instead of being lost per SKU.

**Key requirements.**
- M10-F1-R1: taxonomy v0 ships in the first slice as data (not code), with at least: `img_shotset_crops` (missing apparel roles filled by crops), `img_shotset_generated`, `img_main_replaced`, `img_reordered`, `img_background_fixed`, `img_upscaled`, `img_footwear_views_added`, `title_rewritten_en`, `title_arabic_added`, `bullets_added`, `attributes_completed`, `keyword_added_title`, `keyword_added_backend`, `infographic_added`, `size_chart_added`. Each has component, action, cost class (from M6), and the channels where it is possible.
- M10-F1-R2: classification of a version diff is rule-based first (roles added -> `img_shotset_*`, source per image decides crops versus generated; title text changed and length or language changed -> title types), with a confidence; diffs no rule covers go to a model classifier and, below a confidence threshold, to `unclassified` (never silently to the nearest type).
- M10-F1-R3: one publish may carry several change types; the log keeps all of them and marks the set as a "bundle". Bundles are measured as bundles; the engine never splits a bundle's effect by assumption.
- M10-F1-R4: change hygiene: for listings in any registered experiment, at most one change set per listing per 4 weeks (admin-configurable), enforced through M0's guard, so that effects stay attributable.
- M10-F1-R5: outside changes found by M9's scrape (a channel re-ordering a gallery, a brand team editing a title) are classified too, with `actor = external`, so they can be used as observational evidence and as contamination flags.
- M10-F1-R6: the share of changes classified (target 95%) and the share `unclassified` are on the dashboard; an admin can add a type and re-run classification on history.

**Acceptance test.** Backfill the live tool's October outputs and the holdout's uploads; at least 95% of version diffs get a change type with confidence above the threshold, and a sample of 50 checked by hand agrees on 48 or more.

**Buy or build.** Build (a table, rules, a small classifier later). Nobody sells a change-type taxonomy for marketplaces.

### M10-F2 Budget and priority (P1)

**Story.** As the owner, I want effort and experiments to go where the revenue sits and where measurement can work, with an explicit, visible rule, not a hunch.

**Key requirements.**
- M10-F2-R1: a priority score per candidate (change type x scope) = revenue touched in the scope (trailing 12 months, from the panel) x plausible lift (the current prior's mean, floored at 1%) minus yearly cost of applying it (M6 cost class x listings), divided by the time to a readout; shown with each input so a person can argue with it.
- M10-F2-R2: measurability gate: a candidate is "testable" only if the pool in the scope reaches a simulated MDE at or below 3 times the prior mean within 12 weeks on Namshi and Noon (or on Amazon with sessions); otherwise it is "apply-only" (done because cheap and rule-required, never claimed as lift) or "parked".
- M10-F2-R3: revenue concentration is explicit: the top 10% of options (about 86% of trailing revenue, approx) are always in the first wave of any change type that can touch them; the long tail enters later waves. Both arms still come from the same strata, so this does not bias the estimate.
- M10-F2-R4: a quarterly plan lists the next 3-5 experiments with their expected MDE, revenue touched and start dates; the owner approves the plan, not each experiment, once the registry runs them under M4's rules.
- M10-F2-R5: the metric "revenue share covered by a measured learning" is computed monthly: revenue of listings whose scope has an effect estimate with n experiments at or above 1 and a 90% interval narrower than 30 points, over all softline revenue.

**Acceptance test.** The first quarterly plan ranks footwear views (US Polo footwear, about USD 5.9M revenue touched, approx) and Noon text completeness above a Vero Moda flat-lay change, with the inputs visible, and shows the Styli and Centrepoint shot-set rollout as "apply-only".

**Buy or build.** Build (SQL plus a small scoring job). CommerceIQ and Publicis claim prioritisation without a published method; nothing to buy.

### M10-F3 Pooled estimates across brands (P2)

One model shares strength across change types, categories, channels and brands: each cell's estimate is pulled toward the average of similar cells in proportion to how noisy it is. Four waves of 1,200 listings take the MDE from about 14% to about 7% if the effect is shared (sim extrapolation, judgement). Design and the honesty rules in Appendix B.1. Output: `effect_estimate` per scope with P(lift > 0) and the plain-words label.

### M10-F4 Cross-pollination (P2)

A search term that converts in paid search becomes one change set that updates the title, backend terms and the infographic text where the channel allows, logged as a new treatment with its parent signal, and measured as a change type. Source is paid search-term data (Amazon Ads search terms, Noon product queries); organic sales cannot reveal keywords at GCC volumes. Mechanics and guard rules in Appendix B.3.

### M10-F5 Recommendations to admins (P2)

"Scale", "stop", "test next" and "park" cards with the evidence, the confidence label, the break-even lift and the expected yearly value as a range. Promotion rules and the human-in-the-loop line in Appendix B.2. Target metric: recommendations accepted, and the lift of promoted changes re-measured on their permanent holdout.

## 5. Operator experience

M10 has no operator in the batch sense; its readers are the owner and admins, and its "users" are other modules that apply promoted defaults.

**Screens.**
1. **What we know** (grid): rows are change types, columns are channel x category; each cell shows a label from a fixed five-word scale with the interval underneath: **Proven** (P(lift > break-even) at or above 0.9 and at least 2 waves), **Likely** (P(lift > 0) at or above 0.8), **Unclear** (anything else with data), **Likely not** (P(lift < break-even) at or above 0.8), **Harmful** (P(lift < 0) at or above 0.9 or a guardrail breach), **Not tested** (grey), **Not measurable here** (hatched: Styli, Centrepoint, Amazon softline). Hover shows n experiments, n listings, the last readout date and the shrinkage share ("72% of this number comes from the programme average").
2. **Hypotheses** (queue): each with its source badge ("from ad click rate", "from image traits model", "from a winning search term", "from an operator"), the expected lift as a range, revenue touched, the MDE a test would have, and a "Register in M4" button. Copy at the top: "These are guesses worth testing. None of them is a result."
3. **Recommendations** (cards): "Scale: apparel shot-set crops on Namshi and Noon. Likely (P(lift > 0) = 0.83). Best guess +3%, range -2% to +9%. Costs about USD 40 a year; break-even 0.01%. Applies to 1,900 listings. Keeps a 10% holdout. [Approve] [Hold]". Each card states what will change, where, and what would make us reverse it.
4. **Change types** (admin table) and **Coverage** (revenue share with a measured learning, by channel).

**Copy rules.** Same as M4: range first, best guess second; the shrinkage share is always visible on a cell; a hypothesis is never shown in the "What we know" grid.

## 6. Measurement

| Metric | Baseline | Target | Source |
|---|---|---|---|
| Share of content changes classified | 0 (no log exists) | 95% | `change_classification` |
| Revenue share covered by a measured learning | 0 | 30% of softline revenue by the end of wave 2 (Namshi and Noon apparel and footwear) | monthly job |
| Standard error per change type (log scale) | none | falls with each wave; about halves after 4 waves (sim extrapolation) | `effect_estimate` |
| Recommendations accepted | n/a | 70% of "Scale" and "Stop" cards acted on within 30 days | `recommendation` |
| Lift of promoted changes on their permanent holdout | n/a | interval consistent with the pre-promotion estimate; a contradiction triggers review | M4 readouts on promotions |
| Winners propagated (cross-pollination) | 0 | every winning term propagated within 2 weeks of detection where the channel allows | `treatment_event` with parent signal |

## 7. Build slices

| # | Slice | Depends on | Acceptance test |
|---|---|---|---|
| M10-S1 | Change-type taxonomy v0 as data plus the `POST /classify` rule classifier; M0 calls it on publish; backfill of October outputs (F1) | M0 content versions and diffs | 95% of backfilled diffs classified; 48 of 50 agree with a hand check |
| M10-S2 | Priority score, measurability gate and the first quarterly plan (F2) | M4 panel and MDE harness; M6 cost classes | Plan ranks as in the F2 acceptance test with inputs visible |
| M10-S3 | Leading indicators job and hypothesis queue (Appendix B.4): ad click rate screens, search-rank from M9 where scraped, winning-term detection | warehouse ads tables; M9 | Queue shows hypotheses with source badges and ranges; none appears in the grid |
| M10-S4 | Predictive traits model v1 (Appendix B.4): image and text traits -> units, within brand x channel x price band, labelled association | M2 analyzer outputs on live listings | Hold-out fit reported; top 10 trait hypotheses added to the queue with ranges |
| M10-S5 | Pooled model v1 (Appendix B.1): two-stage meta-analytic model over M4's per-stratum estimates, prior and posterior checks, calibration on placebo readouts (F3) | first M4 readout (week 8) | Recovers injected cell effects on simulated data; placebo cells centre on zero; grid shows labels and shrinkage share |
| M10-S6 | Decision rules and recommendations with promotion and permanent holdout (Appendix B.2, F5) | M10-S5; M4 registry | A "Scale" card creates a promotion with a 10% holdout registered in M4; M3 applies the default on the next batch |
| M10-S7 | Cross-pollination change set (Appendix B.3, F4) | M8 titles and backend terms; M5 rules; M11 infographics where accepted | A winning term on Noon becomes one change set across title and backend terms, logged with its parent signal and measured as a change type |

Order: S1 in the first slice week (it is the only M10 piece M4 needs on day one); S2 and S3 inside the 12-week window; S4 when M2 covers live listings; S5 and S6 after the week-8 readout; S7 after M8 ships text.

## 8. Risks and open questions

**Limits of what can be learned (added to M4's list).**
1. Cell-level truths are mostly borrowed. With about 2,100 options, a cell such as "shot-set crops x apparel x Namshi UAE" holds 200-400 treated options and an MDE of 25-45% (sim). The grid's cell number is the programme average plus a nudge; the shrinkage share says how much. Anyone wanting "the effect on Vero Moda tops on Noon KSA" gets the programme number with a wide band.
2. Small effects need many waves and a stable world. The path from 14% to 7% MDE assumes the effect does not change between November and next summer. Fashion, platform algorithms and Ramadan may break that.
3. Observational evidence (external changes, rollouts without holdouts, the predictive model) is biased in unknown directions: agencies push budget to sellers, better products get better photos. It ranks hypotheses; it never promotes a change on its own.
4. Keyword learning is limited to paid search terms on Amazon and Noon (Namshi has campaign-level ads only, exact). What converts in paid search may not be what shoppers type organically.
5. Transfer across content types is itself a hypothesis (I039). A term that wins in a title may do nothing on an infographic. Every propagation is logged and measured as its own change type; the first ones will not be powered on their own.
6. Priors from Opptra's nine softline brands may not transfer to a future customer's catalog. A new customer starts with wide priors, not our numbers.

**Risks.**

| Risk | Effect | Mitigation |
|---|---|---|
| Taxonomy drifts (types split, merged, renamed) and old effects no longer match | pooled history breaks | types are versioned; a merge keeps a mapping; effects are refit on the mapped history |
| The pooled model is trusted more than the data allows | overconfident promotions | prior predictive checks; placebo calibration every refit; shrinkage share on every cell; "Proven" needs 2 waves |
| Promotions change the catalog faster than M4 can measure | learning loop goes blind | one change set per listing per 4 weeks; every promotion keeps a 10% holdout; promotions are staggered so the DiD still works |
| Predictive model's associations get read as causes | bad hypotheses become defaults | hypotheses live in their own queue, never in the grid; the model's outputs carry the label in the data, not just the UI |
| Paid search-term data is thin (Noon KSA product rows: 57 SKUs daily, exact) | few keyword winners | fix the Noon KSA ad feed (data team); pool terms across the brand, not per option |
| M2 analyzer accuracy is uneven (vision models about 64% on free-form attributes) | noisy traits | only decision-grade attributes with measured accuracy on the golden set enter the model |

**Open questions (defaults in brackets).**
- Prior for a brand-new change type: flat or informed by the predictive model? [Sceptical normal centred on 0 with SD 0.10 on the log scale, that is "probably within -10% to +10%"; the predictive model may shift the centre by at most a quarter of its own estimate, and this is written in the pre-registration.]
- Promotion threshold: P(lift > break-even) 0.9 or 0.8? [0.9 for "Proven" and automatic application; 0.8 ("Likely") may be applied by default when the cost class is "negligible" and the owner approved that class once.]
- Who approves a promotion? [Owner for the first three of any change type and for anything that changes spend or brand-truth content; then a 48-hour silence rule.]
- Permanent holdout share on promotions? [10%, renewed every 12 months by re-drawing.]
- Should the grid show brands? [Not before wave 2; brand cells would be almost entirely borrowed.]

## Appendix B - Method design (requested detail)

### B.1 The pooled model (hierarchical Bayesian)

**Why.** One experiment cannot see a 1-5% effect. Many experiments on similar changes can, if we let them share strength without pretending they are identical. A hierarchical model does that: each cell has its own effect, but the effects are drawn from a common distribution whose spread is learned from the data. Cells with little data lean on the group; cells with a lot stand on their own.

**Shape (two-stage, buildable).**
1. Stage one is M4: for each experiment e and stratum s (brand x department x channel-country), the estimator gives a log-lift estimate y_es with a standard error se_es, from the randomized design. These are the only inputs that carry causal weight.
2. Stage two is a random-effects meta-analysis across cells: y_es ~ Normal(theta_es, se_es^2); theta_es = mu + a[change type] + b[category] + c[channel-country] + d[change type x category] + f[change type x channel] + g[brand] + u_e (an experiment effect for wave and season). Each group of effects has its own spread (standard deviation) with a half-normal prior, so the data decide how much pooling each dimension gets. mu has a sceptical prior: Normal(0, 0.10) on the log scale.
3. Observational estimates (external changes, rollouts without holdouts) enter, if at all, with their own bias term with a wide prior and a flag; by default they are not in the model that drives promotions.
4. Outputs per scope: posterior mean and 90% interval of the lift (exp(theta) - 1), P(lift > 0), P(lift > break-even), and the shrinkage share (1 minus the ratio of posterior variance to the stage-one variance).

**Honesty rules.** Prior predictive check before each refit (does the prior allow the effects we might see, without expecting miracles). Posterior predictive check (does the model reproduce the spread of observed estimates). Placebo calibration: feed the model the A/A estimates from every readout; the resulting cells must centre on zero with the stated coverage; if 90% intervals cover zero less than 85% of the time, the model is widened and the grid shows "recalibrated". Leave-one-experiment-out: a promotion must survive dropping any single experiment. Model code and version are stored with every `effect_estimate`.

**Tools.** PyMC or NumPyro in Python (the module's measurement service), or brms in R as the fallback. A fit over a few hundred cells takes minutes.

**What it is not.** It is not a replacement for randomization. If stage one is biased, stage two pools the bias. That is why observational inputs are gated.

### B.2 From learning to action: decision rules and the human line

**Promotion rule (automatic proposal, human approval at first).** A change type is proposed for promotion in a scope when all of the following hold:
1. P(lift > break-even lift) at or above 0.9 (break-even = yearly cost of applying it in the scope / yearly revenue touched, from M6 and the panel); for cost class "negligible" (crops, reorders, attribute fills) break-even is effectively 0 and the rule becomes P(lift > 0) at or above 0.9.
2. Evidence from at least two experiments (waves) or one experiment with a randomization p-value below 0.01 and a passed A/A.
3. No guardrail harm: liveness, content rejections and returns share not worse in the treated arm beyond the registered thresholds.
4. The change passes M7's quality gate and M5's rules in that scope (a learning never overrides a channel rule).
5. The scope's estimate is not more than 80% borrowed (shrinkage share under 0.8); otherwise the proposal is at the parent scope (for example "apparel on Namshi and Noon", not "Vero Moda tops on Noon KSA").

**What a promotion does.** It sets the change type as the default for new and re-processed listings in the scope (M3, M8 read `promotion`), rolls it out to the back catalog in waves through M9 (so it is a staggered experiment by construction), keeps a 10% permanent holdout drawn at random within the scope, and registers the rollout in M4 with a readout date. It never touches guarded listings of a running experiment.

**Demotion and rollback.** If, at two consecutive readouts on the permanent holdout, the 90% interval's upper bound is below break-even, the promotion is revoked: the default is removed for new listings; existing content stays (reverting has its own cost and would be a new change type). If P(lift < 0) reaches 0.9 or a guardrail breaches, the owner is told the same day and the default is removed immediately.

**"Likely" but not "Proven".** For cost class negligible, "Likely" changes may be applied by default once the owner has approved that cost class once; they stay in the "Likely" cell until a second wave, and are never shown as a result in ROI terms. For any other cost class, "Likely" produces a "test next" card, not a promotion.

**The human line.** The owner approves: the first three promotions of any change type; any promotion whose yearly cost exceeds a configurable amount (default USD 500) or that changes brand-truth content (colour, logo, shape, claims); any demotion. After three clean promotions of a type, new scopes of the same type promote on a 48-hour silence rule with a digest. The audit sample (M7) stays forever. Nobody approves per listing.

**Stop rule for learning itself.** A change type that stays "Unclear" after its learning budget (4 waves or 12 months) is parked with the sentence "not measurable at our volume; applied where cheap and rule-required, not claimed". That is a legitimate end and is reported as such.

### B.3 Cross-pollination mechanics

**Signal source.** Paid search-term reports: Amazon Ads `search_term_daily` (per advertised ASIN, 7-day attribution, dedupe on `tier` and run) and Noon `product_queries` (per campaign and SKU). Namshi has no term-level data (campaign level only, exact). Organic sales cannot reveal terms. Scraped search rank (M9, P1) adds visibility per tracked term.

**Winning term rule (per scope, per language).** Over a trailing 8-week window, a term is a candidate winner for a brand x category x channel-country when: at least 20 ad orders attributed to it; conversion (orders / clicks) at least 1.3 times the scope's median term conversion with a lower confidence bound above 1.0 (a Wilson interval, which keeps small counts honest); it is not already present in the listing's title or backend terms; it is not a competitor brand name, a banned word (M5) or a claim without approval. Terms are pooled at brand x category level, not per option, because per-option counts are tiny.

**Change set.** One winning term becomes one change set per listing: title (inserted within M5's length and ordering rules for the channel, English or Arabic by the term's language, never mixed), backend or search terms field, bullets where the term is a product fact, and the infographic text panel where the channel accepts overlays (M11, C19 still open). The change set is one treatment with change types `keyword_added_title`, `keyword_added_backend`, `infographic_text_updated` as a bundle, `parent_signal_id` pointing to the term and its stats, and `change_reason = learning`.

**Measurement.** Propagations are randomized where the pool allows (half of eligible listings get the term now, half in 8 weeks), measured by M4 as a staggered experiment with units as primary, ad click rate and ad conversion on the term as leading indicators. Where the pool is too small, they are applied as "apply-only" and pooled across terms as one change type over time.

**Guard rules.** Never propagate across languages; never override a channel rule; never more than one change set per listing per 4 weeks; never into a listing under an experiment guard; never a term that would make the title a keyword string (M5's readability rules apply). Visual winners (a trait the pooled model marks "Proven" for one category) become hypotheses for sibling categories in the queue, not automatic propagations.

### B.4 Leading indicators and predictive models (hypotheses, not claims)

**Leading indicators (fast, weak, specific).**
- Ad click rate per listing-week: responds within 2 weeks to a main-image change (MDE 30-45% with 100 options, sim). Used to screen main-image candidates and to rank hypotheses; never a result.
- Search rank for tracked terms (M9 scrape, P1): visibility proxy where no traffic exists; movement after a title or keyword change is a hint.
- Ad conversion per term: the basis of the winning-term rule above.
- Review count velocity and rating (scraped; coverage only 23-25% on Namshi, exact): weak, kept as context.

**Predictive traits model (association, labelled as such).** Inputs: M2's decision-grade traits per live listing (roles present, on-model versus packshot, background, pixel size, text overlay, image count, title length, attribute completeness, Arabic present), price band, brand, channel-country, category. Outcome: trailing 12-week units (or ad conversion where clicks exist). Model: regularised regression or gradient boosting with brand x channel x price band fixed effects, cross-validated, with the honest reminder from our own data that image count showed no association with conversion (CVR ratio 0.95, exact) and that selection (better products get better photos; agencies fund sellers) can produce or hide associations.

**How it is used.** (1) To rank hypotheses: a trait with a large, stable association and a cheap change type goes to the top of the queue with an expected lift range that is the association shrunk by half and widened. (2) To set a weakly informed prior for a new change type (at most a quarter of the association, see the open question). (3) Never to promote, never in the "What we know" grid, never in an ROI number. Every output row carries `evidence_class = association`.

**Self-evolving.** Each readout refits the pooled model and re-ranks the queue; a hypothesis that keeps being outranked is parked; a change type's prior tightens with every wave; the predictive model is retrained quarterly and its hit rate (how often its top hypotheses turned out "Likely" or better in a real test) is shown on the Hypotheses page, so the owner can see whether the guesser is worth listening to.

### B.5 ROI line

Every M10 action is tied to money through the same arithmetic: yearly value = revenue touched in the scope x posterior lift (as a range), minus yearly cost of applying (M6). Recommendations show the range, never the mean alone. The module's own ROI is the sum of promoted changes' value measured on their permanent holdouts, plus the spend stopped by "Likely not" and "Harmful" findings, both reported as ranges on the Coverage page.
