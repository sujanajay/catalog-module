# 07 - GCC catalog roadmap: initiatives, priority, budget and ROI (agent G)

Date: 2026-10-26. Documents only; nothing was built, and no query or paid call was run for this file (the two
small paid trials are in initiatives 5 and 6; see "Total budget"). This file synthesises the
evidence files 01 to 06 and the deep dives. No time or effort estimates: phases are ordered by dependency only.

**Source codes** (same as 06). 01 marketing data, 02 liveness data, 03 image audit, 04 India learnings, 05 build vs
buy, 06 metrics and impact model v2 (all in `docs/plans/roadmap/`); DD0 to DD10 = `docs/plans/deep-dives/`; IM = the
program doc `docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md`. Section names follow each file's headings.

**Labels.** Money is USD a year of extra revenue unless stated. Every revenue number comes from the impact model v2
(06, "Summary table" and "Formulas, step by step"). Measured = a count or sum from data; judged = an assumption.
The defect shares are measured on samples; every lift is judged (06 "Assumptions and confidence" row 5).

## Summary

1. Six initiatives, in this order: (1) Measure and unblock, (2) Channel-ready live catalog, (3) Fix the pages we pay
   to advertise, (4) Product facts, listings and customer-voice fixes, (5) Complete apparel shot sets, (6) Richer
   footwear pages.
2. Together they are the whole impact model v2: base about 269k USD a year (low about 1k, high about 841k; highs
   overlap), on a softline base of about 9.2M (06 Summary table; DD9 s4). No initiative counts a defect twice.
3. Year-one run cost for all six is about 2.0k USD: about 1.5k one-off generation and backfill, about 0.5k to 0.7k a
   year after (06 Summary table; DD9 sizing table). Run cost is not the constraint; owner answers, review capacity
   and proof are.
4. What can start now, with no pending owner answer: initiatives 1, 2 and 3. Their base is 41.2k USD a year.
   The rest (228k base) waits on business decisions: templates and an Arabic reviewer (4), SPEC amendments and the
   generation gate (5), brand rights for generated and lettered images and Noon / Namshi acceptance (6).
5. Initiative 6 holds 43% of the base (116.9k of 269.4k) and is ranked last only because it is gated. If US Polo's
   written rights and Noon / Namshi acceptance come back yes, it moves up to start right after initiative 2 and the
   generation gate (built under initiative 5); the infographic half still needs initiative 4 stage A's fact sheet.
6. Build vs buy: keep our platform (channel rules, render, checks, review, publish, cost ledger; about 12 to 40 USD a
   year) and buy only image generation as a swappable engine behind our own quality gate (05 Recommendation).
7. Proof: a holdout test on Namshi Sponsored Products (the largest softline ad channel) can detect a 15% relative
   conversion lift per test cell; Amazon only 25% or more. Small base lifts (1% to 3%) cannot be measured directly
   (06 Measurement plan). Initiative 1 builds the treatment log and feeds that make the test possible.

## How the order was decided

Four tests, applied in this order of weight:

| Test | What it asks | Effect on the order |
|---|---|---|
| Dependency | Does another initiative need this first? | Measurement and channel roles (1, 2) come before everything that adds images; facts (4) before infographics (6) |
| Can start now | Does it wait on an owner answer, a SPEC amendment or a brand right? | 1, 2, 3 start now; 4 needs templates and a reviewer; 5 needs SPEC and gate approval; 6 needs rights and channel acceptance |
| Confidence | Is the problem measured, and can the lift be measured? | 3 has the most measured problem (spend, CVR, sessions) and the only places a holdout can see an effect |
| Value | Base revenue a year (06) | 6 is largest, then 4 and 5; value breaks ties inside a phase |

Merges and splits (each traced to 06 "What changes from DD9" and "Overlaps"):
- **B1 and L2a merged** into initiative 2: fixing content to the channel rules is what recovers Noon content
  rejections, so they are one piece of work with one cost.
- **Reason feeds, traffic feeds, image-role tracking, the treatment log, the holdout and L2b merged** into
  initiative 1: all are "see what is live, why not, and whether a fix worked".
- **L1 (weak ad pool), the 187 Amazon ASINs and L4 (footwear missing views) merged** into initiative 3: the same
  target list, and the footwear part of the weak pool is exactly the missing-view defect (06 L1 formula uses the
  footwear missing-view share).
- **B6 and B7a merged** into initiative 4: B7a's checks and size fixes need the B6 fact sheet (DD9 Ranking), and
  71% of Namshi return reasons are size or fit (06 Storefront table).
- **B2, B2e and B3 merged** into initiative 5: fill-to-5 and flat lay to on-model are one engine with two
  conditioning modes (IM s5); B2e is the listing effect of the same fill on Styli and Centrepoint.
- **B4 and B5 merged** into initiative 6: both add a gallery image to the same US Polo footwear pages, both wait on
  the same rights answer, and the image caps force a choice between them (06 Overlaps; DD6 Q4).
- **B7b and B8 stay outside** this team (DD10 Recommendation) and are not in the roadmap.

### How the initiatives connect to the four business outcomes

| Initiative | Conversion | Sell-through (zero-sales live share) | Marketing efficiency (ROAS) | Liveness |
|---|---|---|---|---|
| 1 Measure and unblock | measures it | measures it | measures it | direct (not-listed recovery, reasons) |
| 2 Channel-ready live catalog | direct | indirect | indirect | direct (content rejections) |
| 3 Fix the pages we pay to advertise | direct | indirect | direct (the only counted ad saving) | none |
| 4 Facts, listings, customer voice | direct (and fewer fit returns) | indirect | indirect | direct (template rejections, speed to list) |
| 5 Complete apparel shot sets | direct | indirect | indirect | direct (Styli and Centrepoint eligibility) |
| 6 Richer footwear pages | direct | indirect | indirect | none |

Sell-through has no baseline in the evidence; the proxy is the zero-sales live share, 71.4% of live stocked
option-pairs (13,687 of 19,169), and 49% of pool units sit on them (02 "Zero sales in 90 days"; 06 Money table).
No initiative claims a sell-through number; content can only help where stock and price are not the blocker
(02 "Proposed rule for the roadmap").

---

## Initiative 1 - Measure and unblock

**Problem and evidence.**
- 62% of not-live pairs (2,243 of 3,639) have no reason, because the Noon (C-02, stale since 21 Aug 2026), Namshi
  (C-04b, not loaded) and Amazon (C-08, not validated) reason feeds are missing (02 Summary 4).
- Image or content rejections read as zero in the live report because those feeds are missing, not because the
  problem is gone (02 "Image and content rejections").
- Noon traffic stopped on 4 Feb 2026; Namshi, the largest softline revenue channel, has no traffic or conversion
  data; Trendyol's product list stopped after 22 Oct (02 Gaps 5, 7).
- Noon KSA and Namshi KSA each dropped about 11 points in one day, with "Reasons not connected yet" rising to about
  721 to 735 pairs; the report cannot tell a feed change from a real delisting (02 "Trend").
- The warehouse cannot join page content to sales: the earlier Trendyol image-to-sales join covered 13% of orders
  (06 "Why these were low confidence" item 3). Nobody records which images went live where.

**What it does.**
1. Restores and validates the reason feeds in order: Noon Not Live (C-02), Namshi Catalog Live Status (C-04b),
   Amazon All Listings (C-08) (06 "Data feeds to fix first" rows 1 to 3).
2. Restores Noon traffic, asks Namshi for a traffic or conversion export, restores the Trendyol feed, and adds a
   feed-health flag to liveness so feed jumps are not read as delistings (06 rows 4 to 7).
3. Records image role and position per published listing and a treatment log (option, channel-country, date, each
   image's role, generated flag and position) in the catalog module (06 "What the catalog module must record").
4. Defines one per-channel completeness score (roles present, attributes filled, English and Arabic present, no
   open rejection), the IDQ idea adapted to GCC (04 "Borrow list"; 06 Catalog health table).
5. Runs the holdout test design in 06 "Measurement plan" (Namshi ads cells, Amazon session cells).
6. Works the not-listed queue: 865 stocked pairs not on the portal (Noon 1, Namshi 179, Trendyol 141, Amazon 544)
   (02 "Not-live reasons ranked").

**Build vs buy.** Build. The feeds load into the existing gcc-dashboard liveness and marketing jobs; the treatment
log lives in the catalog module. No vendor sells GCC reason feeds or our treatment log (05 Capability table: cost
tracking and publish are ours).

**Metrics it moves, with baseline.**

| Metric | Baseline (source) |
|---|---|
| Reason coverage | 38% (1,396 of 3,639 not-live pairs) (02 Metrics) |
| Content rejection rate | unmeasurable; last Noon file 264 UAE and 215 KSA SKUs with "Content Issues" (02) |
| Not-listed rate | 865 pairs, 1.7% of 49,888 stocked (06 Catalog health) |
| Liveness rate | 92.7% on 24 Oct (46,249 of 49,888) (02) |
| Time to live | not measurable today (02) |
| Content-to-sales join coverage | 13% (DD9 s4) |

**Impact (L2b only; the rest is an enabler).** Formula (06 "L2b"): at channel means, Noon 1 x 47.5 + Namshi 179 x
126.1 + Trendyol 141 x 14.75 + Amazon 544 x 3.78 = 26.8k if all recovered. Recovered share 0 / 25% / 50%
(judged): **low 0, base 6.7k, high 13.4k**. Means overstate a random listing (top 10% of option-pairs carry 86.2% of
revenue, 02). The larger value of this initiative is that it turns every judged lift below into a measured one.

**Run cost.** Inside existing gcc-dashboard jobs (06 L3 row); no generation cost. People time is excluded by rule.

**ROI.** Not meaningful as a ratio (near-zero run cost). It is the precondition for proving the other 263k.

**Dependencies.** None inside the program. The holdout needs the treatment log and an agreed freeze on bids,
budgets and prices for test options (06 "Eligibility guards").

**Pending owner answers.** None block the start. Asks: who loads the three reason feeds and restores Noon traffic
(gcc-dashboard), whether Namshi's partner portal can export traffic (06 row 5), whether GCC adopts one completeness
KPI (04 Q4), and a bid and budget freeze agreed with the ad agencies for test cells.

**Example.** On 24 Oct, Namshi KSA had 721 not-live pairs, all "Reasons not connected yet" (02 "Not-live reasons
ranked", Namshi column), after Namshi KSA fell from 97.8% live on 17 Oct to 86.8% (02 "Latest snapshot"). Today
nobody can say whether 721 listings were delisted (a live Namshi pair earns about 126 USD a year on average,
06 Money table) or a file changed. C-04b would answer it, and it is also the only source of Namshi's
"No valid image" and "QC failed" rejections (02).

---

## Initiative 2 - Channel-ready live catalog

**Problem and evidence.**
- Images go live as the brand sent them: on Trendyol UAE, 24 of 37 checked listings show the same photos only
  resized or padded, 10 a brand background alternate, and 0 were re-shot or repaired; head cuts and lifestyle-first
  ordering are live (03 "Live vs raw comparison").
- 7 of 37 live Trendyol listings open with a lifestyle image, which Noon's front-first rule rejects (03).
- Main-image defects sit in the apparel brands: Amazon main rule fails 79% of French Connection (15 of 19), 10 of 15
  Vero Moda, 5 of 5 brand-sent Cardio Bunny; US Polo, Campus, Penti and Keds 0 (03 "Defect rates per channel rule").
- 36% of sets mix pixel sizes, padding or backgrounds (51 of 141) (03 Summary 7).
- Noon held 479 SKUs not live for "Content Issues" in its last file (264 UAE, 215 KSA), 365 of them French
  Connection (02 "Image and content rejections").
- The module tracks photo position, not role; no channel has a required shot list, image cap or head-cut rule in
  code; a product with 1 photo gets status "ok" (DD1 Summary 1; DD1a "Differences that matter" 2 to 4).
- Checked on `main` (initiative 2 "Findings now stale"): since PR #91 no channel skips small photos, Styli included
  (they are enlarged and carry a soft-image note), and a product cut at the edge fills the canvas flush on every
  channel, image 1 included; nothing keeps it out of position 1 yet.
- Our render paints every Noon image grey (`#E0E0E0`), so the brands' white footwear mains (US Polo 20 of 20, Campus
  15 of 15, Keds 7 of 7 white in raw, 03) go live grey on Noon; if Noon counts footwear as non-fashion, the module
  creates that defect (initiative 2 "What changes" 6; DD1a item 1).

**What it does.** Re-renders the live back catalog (3,141 style-colours) to each channel's written rule with the
platform that is already live (05 "What we have today"), adding what DD1 recommends: a shot role per photo from
the existing judge call, a required-role list and order per channel, image caps and minimums, the head-cut versus
body-crop rule per channel, cut products kept out of position 1 on Noon and Amazon, a white Noon image 1 for
the departments the owner names as non-fashion, the "incomplete" status and plain-language missing-role notes in
the links sheet (DD1 Recommendation 1 to 6 and 8). DD1 Recommendation 7 (report the Styli small-photo skip) is
superseded: PR #91 removed the skip, so a soft-image note replaces it. Re-submits Noon content rejections once C-02 is
fresh. Release condition: role accuracy at least 95% per required role and 100% on head cuts on the golden set
before "incomplete" goes live (DD1 Recommendation 3).

**Build vs buy.** Build (already built). Cut-out, per-channel render for 9 channels, compliance, the judge and
auto-repair, publish and the ledger cost about 0.004 to 0.012 USD per style-colour; doing the same through
Photoroom would cost about 1,600 to 14,000 USD a year and break our fidelity rules (05 Summary 1).

**Metrics it moves, with baseline.**

| Metric | Baseline (source) |
|---|---|
| Amazon main-image rule pass | 69% (97 of 141) (06 Catalog health) |
| Noon cut main / sequencing pass | 96% / 97% (06) |
| Set consistency | 36% inconsistent (51 of 141) (03) |
| Noon content rejections | 479 SKUs on 21 Aug (02) |
| Liveness Noon UAE / KSA | 98.0% / 86.6% (02) |
| Ad CVR, apparel brands (90 days) | FC 1.10%, Penti 2.59%, Cardio Bunny 2.57%, Vero Moda 1.45% (01 s2.4) |

**Impact (B1 + L2a).**
- B1 (06 "B1"): revenue touched = 0.72M x 7/19 + 0.40M x 4/15 + 0.13M x 5/15 + 0.10M x 4/15 + 0.14M x 24/141 =
  0.466M; lift 0 / 3% / 6% (judged) = 0 / 14.0k / 28.0k.
- L2a (06 "L2a"): 479 x 31.2 USD (French Connection revenue per live EAN-pair) = 15.0k if all recovered; recovered
  share 0 / 50% / 100% (judged); high at Noon country means = 24.4k. So 0 / 7.5k / 24.4k.
- **Total: low 0, base 21.5k, high 52.4k.** Plus about 1.1k USD a year of agency fees saved (INR 93,800 at a 50%
  image share; DD9 s6). Ad money saved at base 0.6k is counted once in initiative 3, not here (06 Overlaps).
- Why B1 fell from DD9's 92k: weighted by brand revenue the defect share is 12.8%, not one in three, because US Polo
  (6.08M of 8.52M) is almost clean on that rule (06 Summary 2).

**Run cost.** About 77 USD in year one: one re-run of 3,141 style-colours at 0.0119 = 37 USD one-off, plus 12 to 40
USD a year for new styles (06 Summary table; 05).

**ROI.** 21.5k / 77 = about 280 USD of base revenue per USD of year-one run cost (people time and margin excluded).

**Dependencies.** None for the re-render; Noon recovery needs the fresh C-02 feed from initiative 1.

**Pending owner answers.** None block the start. Refinements (DD1a "Open items" 1, 2, 4, 6): which product types
Noon counts as fashion for the white first image; approval of per-channel caps and minimums; whether Centrepoint
follows the Landmark 3:4 spec or 3000x3000; keeping a cut photo out of position 1 on Noon and Amazon. DD1 approval
items (a) and (b) (role taxonomy, per-channel rule table); item (c) to be closed as superseded by PR #91.

**Example.** French Connection: 13 of 19 sampled products fail the minimum standard, 15 of 19 main images are not
white, 4 of 17 apparel sets have head cuts, and its raw folders open with a close-up (06 Worked example 2; 03).
Noon held 365 French Connection SKUs (207 UAE, 158 KSA) for content (02). French Connection earns about 31.2 USD a
year per live listing, so 365 x 31.2 = 11.4k a year if all came back live (06 Worked example 3).

---

## Initiative 3 - Fix the pages we pay to advertise

**Problem and evidence.**
- 27.3% of softline ad spend in 90 days (30,513 of 111,752 USD) goes to 236 options with at least 200 clicks whose
  conversion is below 70% of their brand's; that pool returns ROAS 1.75 against 4.25 for the other well-clicked
  options (01 s2.6). ROAS = ad sales per ad dollar.
- 44.6% of that weak spend (13,602 USD in 90 days) sits on products with a measured content defect: apparel
  framing or missing shots, footwear missing a core view (06 "L1").
- 187 live Amazon softline ASINs, almost all US Polo, get high traffic but convert below half the country rate:
  UAE 72 ASINs with 15,805 sessions, KSA 115 with 23,922 sessions in 90 days; missed units about 162 and 178
  (02 "Target list logic").
- Footwear missing one of the 5 core views (side, pair, top, sole, back): US Polo 7 of 20, Campus 10 of 15
  (03 "Defect rates per channel rule"). No bucket fills footwear views today (06 "L4").
- The US Polo "main image cut on Amazon" idea is not supported: 0 of 20 US Polo products fail the Amazon main rule.
  The Amazon gap is conversion, not the main image (06 Worked example 1).

**What it does.** Turns the two measured lists (236 weak ad options; 187 Amazon ASINs, deduplicated to option
level) into the first work queue. For each option: check that stock, size run and price are not the blocker
(02 guard; `fact_gcc.cut_size_option_daily`), then fix the gallery: re-render and reorder apparel with initiative
2; fill missing footwear views first by asking the brand for the view (US Polo and Campus folders hold 3 to 8
images, 03 "Bucket inventory"), then with the bought generator once initiative 5's gate is approved. These options
are the first holdout cells (06 "Cells" 2 and 5). Pausing or cutting bids on unfixed weak options is a marketing
action and stays outside this initiative (06 L1).

**Build vs buy.** Build the target lists (queries on existing tables) and the fixes on our platform. Buy only the
generator, and only for footwear views a brand cannot supply.

**Metrics it moves, with baseline.**

| Metric | Baseline (source) |
|---|---|
| Weak-pool share of softline ad spend | 27.3%, ROAS 1.75 vs 4.25 (01 s2.6) |
| Softline ad CVR / ROAS (90 days) | 1.64% / 3.39 (01 s2.2) |
| Amazon unit session %, softline | UAE 1.19%, KSA 0.85% (02) |
| High-traffic low-conversion ASINs | 187 (UAE 72, KSA 115) (02) |
| Footwear core-view completeness | US Polo 13 of 20, Campus 5 of 15 complete (03) |

**Impact.**
- Revenue, L4 footwear missing views (06 "L4"): 5.911M x 7/20 + 0.788M x 10/15 = 2.59M touched; lift 0 / 0.5% / 2%
  (judged, kept low because 01 s3 finds no image-count effect) = **low 0, base 13.0k, high 51.9k**.
- Ad money saved, L1 (06 "L1"): 13,602 x 4.056 = 55.2k USD a year of content-linked weak spend; at +10% CVR
  (judged), 55.2k x 0.10 / 1.10 = **5.0k saved at the same ad sales** (low 0, high 11.0k). This is the only ad
  saving counted in the roadmap. It is another reading of part of the same lift, so it is shown beside the
  revenue, not added to it (06 "Do not add the money-saved column").
- Cross-check, not added: the 187 Amazon ASINs have a ceiling of (162 x 36.79 + 178 x 42.23) x 4.056 = 54.7k a
  year; closing a quarter of the gap (judged) = 13.7k (low 5.5k, high 27.3k). It overlaps L4 and initiative 6 on
  the same US Polo pages, and uses gross ordered sales, which disagree with the net table (06 Worked example 1).

**Run cost.** About 91 USD one-off if all missing footwear views are generated (about 455 style-colours x 1 view x
0.20 USD per accepted image); 0 where brands supply the view (06 "L4"). Apparel fixes are inside initiative 2's cost.

**ROI.** 13.0k / 91 = about 140 USD of base revenue per USD (06 Summary table), plus 5.0k of ad money at the
same ad sales.

**Dependencies.** Initiative 1 (treatment log, holdout guards); initiative 2 (roles, order, re-render) for apparel;
initiative 5's approved gate and generator for generated footwear views; initiative 4 stage A for fact and title
corrections beyond the model name (initiative 3 "Dependencies"). Model-name title fixes on the target pages run in
Phase 1, subject to the GCC listing-ownership decision (Decision 7).

**Pending owner answers.** None for the lists or the apparel fixes. For generated footwear views: US Polo and
Campus rights for generated images of their products (DD8; DD4 Q5) and the vendor data position (05 Q2). A bid and
budget freeze for test cells, agreed with the agencies (06 eligibility guards).

**Example.** US Polo `LEAN GLB 6FX MEN OD WHITE`, the top softline option by ad spend: 2,232 USD in 90 days,
11,219 clicks, CVR 0.88% against US Polo's 1.80%, ROAS 2.18 against US Polo's 4.67 (01 s2.5 and s2.4). On Amazon
UAE, US Polo `TETSY GLB 6FX MEN OD NAVY` had 481 sessions and 0 units in 90 days (02 "Target list logic"). Both are
first checked for size run and price, then the gallery is fixed: 7 of 20 sampled US Polo sets miss a core view and
7 of 20 mix a padded 600x800 portrait into a square set (03).

---

## Initiative 4 - Product facts, listings and customer-voice fixes

**Problem and evidence.**
- No warehouse source holds any Arabic text (0 Arabic characters in Trendyol titles or descriptions; p2p "local"
  fields are English) (DD5 Summary 3).
- A structured attribute source exists but is unused: `dimensions.sku_master_p2p` covers 2,419 of 3,748 options;
  French Connection, Puma and Nautica (1,248 options) are absent (DD5 Summary 1). Facts from data exist for 58% of
  style-colours (1,812 of 3,141) (DD9 sizing table).
- The agency fills 9,280 template pairs (Noon 2,929, Namshi 2,930, Styli 1,784, Centrepoint 1,637) at INR 60 per
  style for images plus templates, split unknown (DD9 sizing table; IM s2).
- On Namshi, 15.3% of softline order lines carry a return reason; size or fit is 71% of those reasons, 17,678 lines
  and 0.68M USD gross a year (06 Storefront table).
- Review text is reachable without login on Namshi, Trendyol and Amazon.ae; about 420 Noon.ae and 444 Noon.sa
  options have 10 or more ratings (DD7 Summary 1, 4).

**What it does.** Stage A (B6): one versioned fact sheet per product filled by code from sources in a per-field
precedence (operator, brand-manager sheet, sku_master_p2p, Namshi sheet, channel listings, master_sl, then vision
for visual attributes only); a template registry that fills Noon, Namshi, Styli and Centrepoint sheets; English and
Arabic copy generated from the fact sheet only, checked by code, Arabic reviewed by a native reader on a golden set
(DD5 Recommendation). Stage B (B7a): reviews of our own products tagged into a closed theme list, each theme mapped
to a typed fix proposal (a size note, a missing back view, a fact to check); a review never becomes a fact, only a
request to check one (DD7 Summary 7). Borrow the India playbook's attribute lists, QA checklists and 30%-missing
escalation rule, reconciled with GCC rules (04 "Borrow list").

**Build vs buy.** Build the fact sheet, template fill and checks: no ready tool fills Noon, Namshi, Styli and
Centrepoint templates with Arabic and fashion attributes (DD5 Summary 5). Buy text generation per call (about
0.064 USD per option, DD5 Summary 8). For reviews: build ingestion as a Scout entity, buy one capped managed actor
for Noon only if Scout cannot reach it (USD 10 per 1,000 results) (DD7 Summary 2, 7).

**Metrics it moves, with baseline.**

| Metric | Baseline (source) |
|---|---|
| Style-colours with facts from data | 58% (1,812 of 3,141) (DD9) |
| Listings with Arabic text from our sources | 0 (DD5) |
| Namshi fit returns | 11.0% of lines, 71% of reasons, 0.68M USD gross a year (06) |
| Template pairs filled by the agency | 9,280 (DD9) |
| Completeness score | not defined yet (06 Catalog health) |

**Impact (B6 + B7a, unchanged from DD9; 06 rows).**
- B6: 7.33M (Noon and Namshi revenue of p2p-covered brands) x 0 / 0.5% / 2% (judged) = 0 / 36.7k / 165k.
- B7a: 2% x 0.68M (fit returns avoided) + 5% x 32k ("not as described") + 0.5% x 1.8M (Noon conversion) =
  13.6k + 1.6k + 9k = 24k base; 0 / 24k / 76k.
- **Total: low 0, base 60.7k, high 241k.** Plus about 1.0k USD a year of agency template fees saved (INR 82,400 at
  a 50% template share; DD9 s9). The defect share for B6 is unmeasured (the audit does not measure text), so this
  is the least measured row (06 "B6").

**Run cost.** B6: 240 USD one-off for the catalogue plus about 214 USD a year (DD5; DD9 s9). B7a: up to about 350
USD in year one with the Noon actor, then 100 to 160 USD a year (under 20 without the actor) (DD9 sizing table).
Year one about 804 USD.

**ROI.** 60.7k / 804 = about 75 USD of base revenue per USD of year-one run cost.

**Dependencies.** DD0 taxonomy; read access to `sku_master_p2p`; Scout review ingestion (another team's repo) for
stage B. Initiative 6's infographics cannot draw a single fact without stage A (DD9 "Depends on").

**Pending owner answers.** The real blank templates for Noon (English + Arabic), Namshi, Styli and Centrepoint, and
agency-filled examples (DD5 Q4); brand-manager sheets for French Connection, Puma, Nautica (DD5 Q2); ownership of
sku_master_p2p (DD5 Q3); a native Arabic reviewer (DD5 Q5); the agency invoice split (DD5 Q6); who owns GCC listing
fill, given India's Catalog v2 lists Amazon, Noon and Namshi (04 Q1); Scout as owner of review ingestion and the
capped Noon actor (DD7 Q1, Q2).

**Example.** Namshi softline: 24,755 of 161,309 order lines carry a return reason, and 17,678 of them say size or
fit, 0.68M USD gross a year (06 Storefront table). A fact sheet with the right size system per channel plus a size
note driven by review themes, avoiding 2% of those returns, is 13.6k USD a year (06 "B7a").

---

## Initiative 5 - Complete apparel shot sets

**Problem and evidence.**
- 65 of 66 sampled apparel products (98%) lack the Styli / Centrepoint 5-shot set (front mid-thigh, full length,
  fabric close-up, back to hips, head and shoulders); 60 of 66 still fail without the close-up; head-and-shoulders
  is missing on 57 of 66 (03 Summary 3).
- About 663 apparel options are absent from Centrepoint and 893 from Styli (DD9 sizing table, proxied by missing
  channel ids).
- 60% of sampled apparel (44 of 73) lack front + back + close-up (06 "B2").
- 25% of sampled Vero Moda apparel (3 of 12) have no model shot; 17% across brands (11 of 66) (06 "B3").
- Roles 1, 4 and 5 are present or crop-derivable on 23 of 24 sampled options; full length is missing on 5 of 24
  (all Penti) and cannot be derived (DD2 Summary).

**What it does.** Derive first, generate second (IM s5; DD2 R1). Stage A: cut fabric and head-and-shoulders crops
from existing shots only where the crop clears the channel's floor; ask brands for masters at 2,400 px or more
(Penti's warehouse holds 1440x2160 copies of 800x1200 uploads, DD1 Summary 5). Stage B: generate missing views from
the brand's own shots (mode A), then flat lay to on-model with the brand's real models (mode B, Vero Moda first),
every output through the six-check fidelity gate (garment identity, logo and text, colour, texture, model
consistency, crop geometry), all reviewed until exit numbers hold on 300 labelled shots (DD2 R2, R3; DD3
Recommendation; DD8 R1).

**Build vs buy.** Build the planner, derivation, gate, review and publish. Buy generation as a swappable engine:
Nano Banana 2 through OpenRouter first (60-image trial cost 5.39 USD), FASHN Product-to-Model second for flat lay to
model, Photoroom Virtual Model third only if it beats both on our gate (05 Recommendation; DD3 Spend). Engine ids
stay in policy and logs, never in operator copy.

**Metrics it moves, with baseline.**

| Metric | Baseline (source) |
|---|---|
| Styli / Centrepoint 5-shot set present | 2% of apparel (1 of 66) (06 Catalog health) |
| Apparel missing head-and-shoulders / close-up / front mid / back / full length | 57 / 31 / 25 / 19 / 14 of 66 (06) |
| Apparel options absent from Centrepoint / Styli | about 663 / 893 (DD9) |
| Ad CVR, apparel brands | FC 1.10%, Vero Moda 1.45% (01 s2.4) |

**Impact (B2 + B2e + B3; 06 rows).**
- B2: 0.528M x 12/17 + 0.403M x 7/15 + 0.125M x 7/12 + 0.097M x 5/15 + 0.142M x 44/73 = 0.752M touched; lift
  0 / 3% / 10% (judged, cut because 01 s3 finds no image-count effect) = 0 / 22.5k / 75.2k.
- B2e: 663 x 115 x 25% + 893 x 25 x 25% = 19.1k + 5.6k = about 25k base (share of absent options that start
  selling 0 / 25% / 50%, judged) = 0 / 25k / 49k.
- B3: 0.125M x 3/12 = 0.031M touched; lift 3% / 10% / 25% (judged) = 0.9k / 3.1k / 7.8k.
- **Total: low 0.9k, base 50.6k, high 132.0k.**

**Run cost.** About 74 USD one-off: B2 about 1,050 options x 5/24 generated x 0.20 USD = 44; B3 about 30 options x
1.00 USD per 5-shot set = 30 (06 Summary table). At DD9's full counts: 32 + 121 = 153 USD. Recurring for new
styles: not sized in the evidence; small at 0.20 USD per accepted image.

**ROI.** 50.6k / 74 = about 680 USD of base revenue per USD (the B2e half is a listing effect with no ad data).

**Dependencies.** Initiative 2 (roles per photo, required-role lists); DD2 gate built and labelled; DD3 generator;
DD8 brand style profile and model registry for mode B.

**Pending owner answers.** SPEC amendments for cropping and for generation (DD2 R4; SPEC non-goals forbid both today,
05 Risks); DD2 gate bars and exit numbers; whether Styli accepts an on-model fabric crop and an upscaled 2K image
(DD2 R1; DD3 Recommendation 6); the vendor data position for brand photos sent to a US or Google-hosted service
(05 Q2); written rights per brand site for real-model references (DD8); Centrepoint's spec (DD1a Q4).

**Example.** Of 66 sampled apparel products only one has the full Styli / Centrepoint set (03). Applied to the
663 apparel options absent from Centrepoint, where a listed option earns about 115 USD a year, one in four starting
to sell is 663 x 115 x 25% = 19.1k USD a year (06 "B2e"; DD9 s4).

---

## Initiative 6 - Richer footwear pages

**Problem and evidence.**
- US Polo footwear is about 5.9M of the roughly 9.2M softline revenue; US Polo is 69% of live-listing revenue
  (DD9 Summary; 02 "By brand").
- No lifestyle scene: US Polo 19 of 20, Campus 4 of 15, Keds 7 of 7 sampled sets (06 "B4"). Naz's "lifestyle missing
  99%" holds for real-world scenes (1 of 48 Trendyol sets) (DD4 Summary 3).
- No infographic: US Polo 19 of 20; other brands 0 seen except Cardio Bunny's generated sets (06 "B5").
- Every channel with a public rule allows lifestyle only as an additional image, never image 1; Trendyol caps at 8
  and Keds and Campus already carry 7.0 to 7.8 images there (DD4 Summary 4).
- Noon's page both mentions "adding text" and says "only photographs are permitted ... illustrations are not
  allowed" (DD6 Summary 5).

**What it does.** Stage A (B4): one lifestyle image per adult footwear and bag style-colour (1,222 target), worn
legs-only or carried, no face, scene by subcategory, placed last on every channel; a composite still life of the
brand's own cut-out pixels for kids and bags with fewer than 3 photos; do-not-generate rules where a lifestyle or
worn photo already exists (DD4 R1 to R5). Stage B (B5): feature callouts and use-case panels drawn in code, text only
from confirmed fact-sheet features and a bilingual glossary, Arabic shaped and checked, never image 1, only on
channels marked allowed (DD6 Recommendation).

**Build vs buy.** B4: buy the generator (same engine slot as initiative 5), build the gate, scene checks and the
composite fallback (DD4 R2, R3; 05 Capability table). B5: build the compositor on sharp, which already shapes Arabic
correctly; do not buy a template API, and do not let a model paint text (painted controls invented a claim and
misplaced pointers) (DD6 Summary 4, 7, 8).

**Metrics it moves, with baseline.**

| Metric | Baseline (source) |
|---|---|
| Footwear pages with a lifestyle image | US Polo 1 of 20, Campus 11 of 15, Keds 0 of 7 (03 csv via 06) |
| Pages with an infographic | US Polo 1 of 20 (06) |
| US Polo ad CVR / CTR (90 days) | 1.80% / 1.35% (01 s2.4) |
| US Polo Amazon unit session % | UAE 1.16%, KSA 0.82% (02) |

**Impact (B4 + B5; 06 rows).**
- B4: 5.911M x 19/20 + 0.788M x 4/15 + 0.159M x 7/7 = 5.98M touched; lift 0 / 1% / 3% (judged) = 0 / 59.8k / 179.5k.
  If studio on-legs shots count as lifestyle already present (DD4 Q2), base falls to 41.9k.
- B5: 5.71M touched (Noon and Namshi, pages without one) x 0 / 1% / 3% (judged) = 0 / 57.1k / 171.3k. On confirmable
  features only: 1.22M x 1% = 12.2k. Worth about 0 if Noon and Namshi do not accept infographics in writing.
- **Total: low 0, base 116.9k, high 350.8k** (highs overlap with initiative 3's L4 on the same pages; not additive).

**Run cost.** B4: 244.40 USD one-off for the 1,222 backlog at 0.20 USD per accepted image, plus about 260 USD a year
for new styles (DD4 R6; DD9 s7). B5: up to about 481 USD one-off (5 to 17 USD callouts, up to 30 brand-photo panels,
up to 435 generated footwear panels) (DD9 sizing table). Year one about 985 USD.

**ROI.** 116.9k / 985 = about 120 USD of base revenue per USD of year-one run cost.

**Dependencies.** Initiative 2 (roles, caps, last-slot placement); initiative 4 stage A (features for callouts);
initiative 5's gate and generator; DD8 style profile (scenes, fonts).

**Pending owner answers (these decide the value).** US Polo and other brands' written rights for generated
lifestyle images and lettered infographics (DD4 Q5, DD6 Q5, DD8); Noon and Namshi written acceptance of a
text-and-photo infographic (DD6 Q2); whether studio worn shots count as lifestyle (DD4 Q2); at the image cap, the
priority among size chart, lifestyle, callout and panels (DD4 Q3, DD6 Q4); labelling of generated images (DD4 Q4);
bilingual or per-locale infographics (DD6 Q3); Arabic glossary reviewer (DD6 Q6). 117k of the 269k base sits
behind these answers (06 Assumptions row 12).

**Example.** The 1,222 lifestyle targets are US Polo 529, Campus 406, Puma 106, Keds 105 footwear style-colours and
French Connection 63 and Vero Moda 13 bags, 85 of them kids (DD4 Summary 1). In the trial, 6 of 6 footwear products
kept the shoe, its colour and its logo positions in a worn legs-only shot (DD4 Summary 6). The whole backlog costs
244.40 USD once (DD4 R6).

---

## Phased view (by dependency only)

| Phase | What runs | Why it is in this phase (the dependency) | Base value unlocked |
|---|---|---|---|
| **Phase 1** | 1 Measure and unblock (all); 2 Channel-ready live catalog (all); 3 Fix the pages we pay to advertise (lists, guards, apparel fixes, brand-supplied footwear views, first holdout cells) | No pending owner answer blocks them; the platform is live; the holdout needs the treatment log from 1 and the fixes from 2 and 3 | 41.2k (6.7 + 21.5 + 13.0; the part of L4 that brands cannot supply waits for the Phase 3 generator) plus 5.0k ad money |
| **Phase 2** | 4 stage A (fact sheet, templates, English and Arabic copy); 5 stage A (derived crops, larger brand masters); the generation gate built and labelled; vendor sandbox trials on our golden set | Needs owner inputs (templates, Arabic reviewer, SPEC amendment for cropping, gate approval, vendor data position) and initiative 2's roles | 36.7k (B6) plus the derived part of 50.6k |
| **Phase 3** | 5 stage B (generated views, flat lay to on-model); 6 (lifestyle, then infographics); 4 stage B (review-driven fixes); generated footwear views for 3 | Needs the gate's exit numbers, the generation SPEC amendment, brand rights, channel acceptance, the fact sheet (for infographics) and Scout review ingestion | the rest of 50.6k, 116.9k, 24k |

Holdout cells follow the phases: B1 re-render and the weak pool on Namshi, and the 187 ASINs on Amazon in Phase 1;
lifestyle and infographic cells on US Polo footwear only after rights and acceptance (06 "Cells").

## Total budget

No build effort is estimated (owner rule). Run costs are generation, model calls and compute, from the ledger and
list prices; people time and margin are excluded (06 Assumptions row 11).

| Initiative | One-off (backfill and generation) | Recurring a year | Year-one total | Base revenue a year | Base revenue per USD |
|---|---|---|---|---|---|
| 1 Measure and unblock | 0 (inside existing jobs) | 0 | about 0 | 6.7k | n/a |
| 2 Channel-ready live catalog | 37 | 12 to 40 | 77 | 21.5k | about 280 |
| 3 Fix the pages we pay to advertise | up to 91 (generated views) | not sized | 91 | 13.0k (+5.0k ad money) | about 140 |
| 4 Facts, listings, customer voice | 240 (B6) + up to 350 (B7a year one) | 214 (B6) + 100 to 160 (B7a) | 804 | 60.7k | about 75 |
| 5 Complete apparel shot sets | 74 (153 at DD9 counts) | not sized, small | 74 | 50.6k | about 680 |
| 6 Richer footwear pages | 244 (B4) + up to 481 (B5) | about 260 (B4) | 985 | 116.9k | about 120 |
| **Program** | **about 1.5k** | **about 0.5k to 0.7k** | **about 2.0k** (06: 77 + 44 + 30 + 504 + 481 + 454 + 350 + 91 = 2,031) | **269.4k** (low about 1k, high about 841k) | **about 130** |

Other money lines:
- Agency fees saved: about 2.1k USD a year (B1 1.1k + B6 1.0k), at an assumed 50 / 50 split of the INR 60 per style
  (range 30 / 70); about the size of the whole run cost (DD9 Summary).
- Platform kept: about 12 to 40 USD a year for all channels at about 3,350 new styles a year (05 "What we have today").
- Vendor trials before any buy: Photoroom sandbox free (1,000 watermarked calls a month), FASHN minimum pack 7.50 USD
  (05 Q3). Earlier trials spent 5.39 USD (DD3), 1.80 USD (DD4) and 0.45 USD (DD6).
- Trial spend to date (measured, per-response `usage.cost`): the earlier program spent 7.64 USD (the three trials above); this proposal added
  0.206434 USD (initiative 5 example) and 0.206382 USD (initiative 6 example), a cumulative 8.05 USD of the 50 USD
  trial cap.
- Capacity, not cash, is the constraint: the manual route makes about 1,300 images a year; the open backlog is about
  3,400 images (B2, B3, B4), about 4,900 with infographics (DD9 Summary).

Program ROI: 269.4k / 2,031 = about 130 USD of base revenue per USD of year-one run cost. At the low case (about
1k) the run cost is roughly covered by the 2.1k of agency fees saved. These ratios show that run cost does not
limit the program; they are not profit figures.

## Risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| 1 | Every lift is judged; our own data shows no link between image count and CVR (CVR ratio 0.954, 9 of 18 cells each way) (01 s3) | Every revenue row scales with its lift; small lifts (1% to 3%) cannot be measured directly on any channel (06) | Initiative 1 first; holdout per cell; report measured lifts and drop rows that show nothing |
| 2 | Concentration on US Polo footwear (about 64% of softline revenue, DD9 Ranking) | 117k of the base hangs on one brand's rights answer (06 row 12) | Ask for written rights early; initiatives 1 to 5 carry 152.5k without it |
| 3 | Content is not the blocker on many pages: 71.4% of live stocked options sold nothing in 90 days; 49% of pool stock sits on them (02) | Fixes on pages blocked by stock, size run or price earn nothing | Guard in initiative 3: target only live, stocked pages with no price or stock reason |
| 4 | Feed artefacts read as delistings (02 "Trend") | Wrong targets and false liveness alarms | Feed-health flag in initiative 1 before any liveness metric drives work |
| 5 | Generated images redraw prints and logos (prints re-drawn on 7 of 7 in DD3) | Many holds on printed garments; review load | Our gate decides, never the vendor; review-all until exit numbers (DD2) |
| 6 | Brand photos leave GCP (vendors US-hosted; Photoroom training statements conflict) (05 Risks) | Data and contract exposure | Written no-training position per vendor before any live run (05 Q2) |
| 7 | Vendor change (remove.bg standalone closes 1 December 2026; Photoroom cut its rate limit to 60 a minute) (05 Risks) | Lost engine | Swappable engine slot; composite fallback (DD4) |
| 8 | Channel rules unpublished for 7 of 9 channels (DD1a Summary) | Rejections from rules we cannot see | Initiative 1 reason feeds; ask account managers for portal exports (DD1a Q5) |
| 9 | Image caps (Trendyol 8, Amazon 9) force a choice among size chart, lifestyle, callout, panels | Silent drops or lost value | Caps encoded in initiative 2; owner sets the priority (DD4 Q3, DD6 Q4) |
| 10 | Audit samples are small (5 to 20 products per brand, one reviewer, plus or minus about 3 products) (03 Gaps) | Brand defect shares move | Treat as direction; replace with role tags on live listings (initiative 1) |
| 11 | Ownership overlap with India's Catalog v2 on Amazon, Noon, Namshi (04 Summary 5) | Two teams build listing fill | Owner decides who owns GCC listing fill before initiative 4 |
| 12 | Revenue bases differ (gross listing price vs net GMV vs ad sales with VAT) (06 row 6) | Mixed rows are approximate | Report measured outcomes from the holdout on one basis |

## Decisions the owner must take

1. **The order and the merges** in this file, replacing the intent map's V1 B1, V2 B2, V3 B3 and DD9's order.
2. **Build vs buy:** keep the platform, buy only generation as a swappable engine (05 Q1); written vendor data
   positions (05 Q2); the free sandbox and 7.50 USD FASHN trial on our golden set (05 Q3).
3. **SPEC amendments, staged:** cropping for derived shots (DD2 R4) in Phase 2; generated shots and the one lifestyle
   image (DD2 R4, DD4 R7) in Phase 3.
4. **Brand rights:** written rights from US Polo first, then Campus, Keds, Puma, French Connection, Vero Moda, for
   generated images, lettered infographics and real-model references (DD4 Q5, DD6 Q5, DD8).
5. **Channel acceptance:** written confirmation from Noon and Namshi that a text-and-photo infographic is accepted as
   an additional image, and whether generated images must be labelled (DD6 Q2, DD4 Q4).
6. **Inputs for listings:** real blank templates, brand-manager sheets, a native Arabic reviewer, the agency invoice
   split (DD5 Q2, Q4, Q5, Q6).
7. **Ownership:** GCC listing fill versus India Catalog v2 (04 Q1); Scout as owner of review ingestion (DD7 Q1);
   who restores the reason and traffic feeds in gcc-dashboard.
8. **Proof:** a bid, budget and price freeze for holdout options, agreed with the ad agencies (06).
9. **One completeness KPI** per channel as the roadmap's headline catalog metric (04 Q4).
10. **Channel rule refinements:** Noon's fashion definition, caps and minimums, Centrepoint spec, cut main out of
    position 1, lifestyle definition, cap priority (DD1a items 1, 2, 4, 6; DD4 Q2, Q3; DD6 Q4).

## Initiative list for detailed documents

| # | Slug | Initiative | Buckets inside |
|---|---|---|---|
| 01 | `01-measure-and-unblock` | Measure and unblock | reason feeds, traffic feeds, feed-health flag, image-role tracking, treatment log, completeness score, holdout, L2b |
| 02 | `02-channel-ready-live-catalog` | Channel-ready live catalog | B1, L2a |
| 03 | `03-fix-the-pages-we-pay-to-advertise` | Fix the pages we pay to advertise | L1, 187 Amazon ASINs, L4 |
| 04 | `04-product-facts-listings-customer-voice` | Product facts, listings and customer-voice fixes | B6, B7a |
| 05 | `05-complete-apparel-shot-sets` | Complete apparel shot sets | B2, B2e, B3 |
| 06 | `06-richer-footwear-pages` | Richer footwear pages | B4, B5 |

Status: done
