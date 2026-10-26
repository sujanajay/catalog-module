# Initiative 04 - Product facts, listings and customer voice

Date: 2026-10-26. Part of the GCC catalog roadmap proposal (`docs/plans/roadmap/07-roadmap.md`, initiative 4).
Documents only; nothing was built, no paid call was made. Buckets inside: **B6** (product fact sheet and channel
listing templates) and **B7a** (reviews and returns feeding content fixes). Phase 2 (stage A, B6) and Phase 3
(stage B, B7a) in 07's dependency order. No time or effort estimates (owner rule).

**Source codes** (same as 07). 01 to 07 = `docs/plans/roadmap/0x-*.md`; DD5, DD7, DD9 = `docs/plans/deep-dives/05-`,
`07-`, `09-`; IM = the intent map. **Q-R1, Q-R2** = two new read-only BigQuery queries run for this document
on 2026-10-26 (shapes at the end). Labels: **measured** = a count or sum from data; **judged** = an assumption.

Words used here:
- **Fact sheet**: one typed record per product (brand + style + colour) holding what is true about it (material,
  care, fit, sizes, origin), with the source of every value (DD5).
- **Listing template**: the spreadsheet a marketplace asks a seller to fill to create listings.
- **Fit return**: an order line returned with a reason of size or fit ("too small", "too big", "unsuitable size").
- **Theme**: a short typed reason customers give in reviews, for example "runs small" (DD7).
- **Golden set**: a fixed, hand-labelled sample used to prove quality before a step is trusted.

## Summary

1. Our GCC listings are filled by an agency from brand sheets; no warehouse source holds a single Arabic word, and
   structured facts from data exist for only 58% of style-colours (1,812 of 3,141); French Connection, Puma and
   Nautica have none.
2. Size and fit is 71% of Namshi return reasons (17,678 lines, 0.68M USD gross a year), and nobody reads reviews.
3. Build one versioned fact sheet per product in catalog-module, fill the Noon, Namshi, Styli and Centrepoint
   templates from it by code, write English and Arabic copy only from facts, and replace the agency channel by
   channel once a native Arabic reader has passed the golden set.
4. Then turn reviews and fit returns into typed fix proposals ("check the size chart", "add a back view") in a
   "What customers say" list; a review never becomes a fact.
5. Value (06, unchanged): **low 0, base 60.7k, high 241k USD a year**, plus about 1.0k a year of agency template-filling fees saved (the template share of the INR 60 per style).
   Year-one run cost about **804 USD**; base ROI about 75 USD of revenue per USD.
6. Ownership: we recommend the GCC catalog module owns all GCC listing content (Noon, Namshi, Styli, Centrepoint,
   and Amazon.ae / .sa when it is taken on); India's catalog-service keeps India channels; both share a pattern
   library, not code.

## Problem, with evidence and real examples

### 1. Facts are missing from our own data, and there is no Arabic at all

- `dimensions.sku_master_p2p`, Opptra's maintained GCC product master, holds material, care, fit and size system,
  but the catalog module has never read it. Joined on EAN it covers 2,419 of 3,748 options (65%): material 2,195,
  care 2,334, fit only 1,311 (35%) (DD5 F1, measured).
- French Connection (899 options), Puma (190) and Nautica (159), 1,248 options in all, are absent from it entirely
  (DD5 F1). At style-colour level, facts from data exist for 1,812 of 3,141 (58%); 1,329 need a brand-manager sheet
  or stay "needs info" (DD9 s9, measured).
- `master_sl` gives identity only: its `description` column holds the per-size product code (for example
  `529A7_WHITE_OD_L/12`), not a description (DD5 F1).
- Arabic: 0 Arabic characters in master_sl, sku_master_p2p (whose "local" fields are English) and Trendyol UAE and
  KSA titles and descriptions (DD5 F2, measured). Noon says on UAE and KSA that English is mandatory, Arabic is
  optional but advised, "We are not providing translations", and an English-only listing may show only on the
  English site (DD5 F2, Noon seller help page). Whether today's agency-filled listings carry Arabic has never been
  checked (DD9 s9).
- Fact quality is mixed free text where it exists: material "MEMORY INSOLE" (a feature, not a material), the same
  care sentence on 2,520 US Polo shoes, fit spelled "regular_classic_fit", "Regular Fit", "Relaxed" (DD5 F1).

### 2. Templates are filled by hand, outside any system

- The agency fills 9,280 template pairs (Noon 2,929, Namshi 2,930, Styli 1,784, Centrepoint 1,637). Its INR 60 per
  style covers resizing existing images with the image links, and filling these templates; the split between the
  two is unknown, and it never includes image generation (owner, 2026-10-26; DD9 s9; DD9 s6; IM s2). Initiative 2
  replaces the resizing part; this initiative replaces the template part.
- Only Trendyol and Amazon publish template specs. Noon's field list and enums are inside its logged-in template
  download; Namshi, Styli and Centrepoint publish nothing (DD5 F3). The real blank templates must come from the
  owner's seller accounts.
- No tool on the market fills these four templates with Arabic and fashion attributes: Unicommerce states Namshi
  catalog sync is manual; ChannelEngine is order and stock plumbing; PIMs have no GCC connector (DD5 F7).
- Noon held 479 SKUs not live for "Content Issues" in its last file (264 UAE, 215 KSA, 21 Aug 2026), 365 of them
  French Connection, the brand with no structured facts (02; 07 initiative 2). Image fixes are counted in
  initiative 2; the text half of those rejections is what this initiative removes.

### 3. Customers tell us what is wrong, and nothing listens

- Namshi softline: 24,755 of 161,309 order lines carry a return reason (15.3%); size or fit is 17,678 lines, 71% of
  reasons, 0.68M USD gross a year; "item not as described" 1,025 lines, 32k USD (DD9 s4, measured). Noon's
  `return_reason` is blank on all but 62 lines.
- Direction differs by brand (Q-R1, measured, Namshi, ordered 22 Oct 2025 to 21 Oct 2026; a recount with a looser
  filter than DD9, so totals differ slightly from 17,678):

| Brand | Size or fit return lines | All order lines | Share | "Too small" | "Too big" | Reading |
|---|---|---|---|---|---|---|
| French Connection | 2,962 | 13,285 | 22.3% | 879 | 1,659 | returned as too big about 2 to 1 |
| Campus | 1,404 | 10,121 | 13.9% | 691 | 239 | returned as too small about 3 to 1 |
| US Polo | 8,263 | 85,981 | 9.6% | 1,919 | 2,631 | leans too big |
| Nautica | 762 | not queried | - | 199 | 417 | leans too big |

- Review text is reachable without login on Namshi (full JSON list), Trendyol (inline) and Amazon.ae (top 6 plus
  Amazon's "Customers say" summary). Noon exposes counts only; its review endpoint returned "Access Denied" twice
  (DD7 F1). Scout sees about 46,900 ratings on our softline options; 420 Noon.ae and 444 Noon.sa options have 10 or
  more ratings; the own-listing text corpus is roughly 11,000 reviews (DD7 F2, approximate).
- 3 of 23 sampled reviews were Arabic, all on Namshi, one a size complaint ("I asked for size 41, size 43 came"),
  which is a fulfilment error, not a fit theme (DD7 F1). Any theme step must read both languages and separate the two.
- Nobody reads reviews systematically today (DD9 s10).

### Real example A - a product whose listing has no facts behind it, and a fit-return pattern

French Connection `GENEVIEVE ARIETTE MIDI DRESS`, option `71YOH WHITE/BLACK OD` (Q-R2, measured):
- On Namshi, 118 order lines in 12 months; **51 returned for size or fit (43%)**: 29 "too big", 19 "too small".
- French Connection has 0 rows in sku_master_p2p, so there is no fit, composition, care or origin for this dress in
  any structured source; master_sl gives its name, colour, sizes and a product code; the only prose is a Trendyol
  listing description written by whoever listed it (DD5 F1: 793 of 899 French Connection options have one).
- Its sister style `CAMBRIA COTTON BELTED DRESS` (`71YPR LINEN WHITE OD`) shows the same direction: 39 of 106 lines
  returned for size or fit, 28 "too big", 11 "too small" (Q-R2).
- What this initiative does: the fact sheet marks fit, composition and origin `missing` and asks for the brand
  sheet; the size system per channel is filled from master_sl sizes and a code table; the fit-return theme raises a
  "check the size chart / confirm 'runs large'" proposal. The size note is published only after the brand or
  operator confirms it (DD7 guard rail 1). We did not open the live Namshi page, so whether it carries a size note
  today is not verified.

### Real example B - a shoe that runs small

Campus `PAT` `S2691-04-L7 BLK/PEACH OD`: on Namshi, 105 order lines, **36 returned for size or fit (34%), 28 "too
small" against 4 "too big"** (Q-R2). Campus facts do exist in sku_master_p2p (fit filled for 583 of 1,012 options,
DD5 F1), so here the fix is the size guidance, not a missing master: a "check size chart / choose one size up once
the brand confirms" proposal on Namshi and Noon.

## Who it serves

| Who | What changes for them |
|---|---|
| Shoppers on Noon, Namshi, Styli, Centrepoint | Complete attributes for filters (size, material, fit), Arabic text where today there may be none, size guidance that matches how the product really fits |
| Naz and the GCC catalog operators | One "Product details" view per product with the source of each value and a yellow "check this"; one filled template per channel to download; "Ready" or "Needs info" with a plain reason; a "What customers say" list with buttons (add to next batch, check fact, send to brand team, dismiss) (DD5 R4; DD7 R4) |
| GCC brand managers | A clear ask: the facts their sheet must supply (material, care, fit, origin), and fit themes to confirm or reject |
| GCC business team (Nitin Kiran) | Less dependence on the agency's turnaround, a measured fit-return line, and the facts that initiative 6's infographics need |
| Other teams | B7b NPD (Nitin's team) reuses the shared review ingestion by listing id; B8 forecasting reads the identity and attributes export (DD9 s11; DD10). India's catalog team shares the pattern library (see Ownership) |

## Metrics it moves, and today's baselines

| Metric | Definition | Baseline today (source) | Measurable today? |
|---|---|---|---|
| Style-colours with facts from data | fact sheet has material, care and origin `confirmed` | 58% (1,812 of 3,141) (DD9 s9) | Yes, by query |
| Fit field filled | options with a fit value in any structured source | 35% (1,311 of 3,748) (DD5 F1) | Yes |
| Listings with Arabic text from our sources | listings whose Arabic title and description come from the module | 0 (DD5 F2) | Yes (zero) |
| Template pairs filled by the agency | Noon, Namshi, Styli, Centrepoint pairs not filled by the module | 9,280 (DD9 s9) | Yes |
| Template cells filled, per channel | filled cells / required cells, from the module's gap report | not defined until templates arrive | No |
| Namshi fit returns | size or fit return lines / order lines | 11.0% of lines, 71% of reasons, 0.68M USD gross a year (06 Storefront) | Yes, Namshi only |
| Namshi "not as described" returns | same, that reason | 1,025 lines, 32k USD (DD9 s4) | Yes |
| Noon content rejections | Noon "Content Issues" SKUs | 479 on 21 Aug (264 UAE, 215 KSA) (02); shared with initiative 2 | No, until C-02 is fresh (initiative 1) |
| Products with an open review theme | products with a theme over threshold and no decision | not measured; about 420 to 450 Noon options are the pool (DD9 s10) | No, until ingestion exists |
| Completeness score | per channel: roles present, attributes filled, English and Arabic present, no open rejection | not defined yet (06 Catalog health); attributes and Arabic parts come from this initiative | No |
| Time to live | first seen to first live | not measurable (02) | No |
| Conversion on Noon pages with fixes | Noon visitor conversion | US Polo UAE 1.36%, KSA 0.87% (stale, Jan to Feb 2026) (02) | Only after Noon traffic is restored (initiative 1) |

## Solution

### Recommendation: hybrid, mostly build

Build the fact sheet, template fill, checks, review-theme flow and operator screens inside catalog-module. Buy text
generation per call through the existing OpenRouter layer (about 0.064 USD per option, DD5 Summary 8). Build review
ingestion as a Scout `reviews` entity (another team's repo, opptra-scrapers); buy one capped Apify actor for Noon
reviews only if Scout cannot reach Noon (USD 10 per 1,000 results) (DD7 R2). This matches 05's rule: keep our
platform, buy engines.

Why not buy: no tool fills the four templates with Arabic and fashion attributes (DD5 F7). A PIM costs about
9,900 (Pimcore Professional) to 45,000 (Akeneo, third-party figure) USD a year, adds a second system beside
catalog-module with the identity duplicated, and still needs every template mapped and Arabic written by us. Managed
copy (Streamoid 50 USD per 1,000 styles; Describely 0.75 USD per product) has its own fact model, so initiative 6
and B7a cannot build on it (DD5 Options B to D). Review-analytics vendors are quote-only, keep themes outside the
module and have no route to shot roles or fact checks (DD7 Options D).

### Stage A - B6 fact sheet and channel listing templates (Phase 2)

1. **Fact sheet** (DD5 R1, proposed schema): one versioned record per `catalog_products` row, zod-validated, a new
   `catalog_fact_sheets` table; every field carries value, source, exact reference, raw text, status (`confirmed`,
   `proposed`, `conflict`, `missing`) and read date. A source change writes a new version; nothing is overwritten.
2. **Per-field precedence** (replaces the earlier "Namshi sheet first"): operator edit, brand-manager sheet,
   sku_master_p2p, Namshi full-listing sheet, channel listings in the warehouse, master_sl, then vision on the photos
   for visual attributes only, always `proposed`. Composition, care, origin, price and sizes are never produced by a
   model; two data sources that disagree mark the field `conflict` (DD5 "Source precedence").
3. **Template registry and fill engine** (DD5 R2): one versioned registry entry per channel template; rule types
   SKIP, CONSTANT, FACT, ENUM, COPY, IMAGE, MANUAL; list values read from the template's own valid-value sheets,
   never from memory; required flags never dropped; typed gaps each with one plain sentence. Write-back keeps the
   module's rule from `fillProductListWorkbook`: write only data cells, never touch other sheets or the input file.
   Noon's template is `.xlsm`; macro and data-validation round trips with exceljs must be checked against current
   docs (Context7) and a real-template test before build.
4. **English and Arabic copy** (DD5 R3): generated from one fact sheet version only; Arabic written from the facts,
   not translated, with a code glossary; code checks for script ratio, every number present in the facts, no
   material or claim absent from the facts, channel length limits, banned characters. A failed check is a gap, not
   a silent retry. Model tier chosen automatically by policy, never shown to the operator.
5. **Arabic checked by a native speaker**: a native reader labels a golden set of 50 options across the 9 brands
   (fluency, accuracy against facts, register); until it passes, every Arabic copy shows "Arabic text waiting for
   review" (DD5 R3).
6. **Agency replaced channel by channel** (DD5 R5): Namshi and Noon first (about 95% of softline revenue), then
   Styli and Centrepoint. A channel switches only after its real blank template is in hand and a side-by-side on the
   agency's filled sheets shows equal or better cell coverage and no wrong facts. Until then the agency keeps that
   channel. French Connection, Puma and Nautica are filled from a brand-manager sheet or stay "Needs info".
7. **Borrow from India** (04 Borrow list): the playbook's category attribute lists (minus MRP, HSN, BIS, INR size
   charts; plus Arabic names, GCC size systems, modest-wear flags), the content QA checklist as code checks, the
   size-chart error table, and the escalation rule "missing more than 30% of mandatory attributes".

### Stage B - B7a reviews and returns feeding content fixes (Phase 3)

1. **Ingestion (shared layer, Scout)**: a logged-out `reviews` entity for Namshi, Trendyol, Amazon.ae / .sa guest
   pages and Noon if Scout's proxies reach it, writing `opptra_core.review_observation` by MERGE, triggered by
   Scout's rating-count deltas; no reviewer names, no order numbers (DD7 R2).
2. **In catalog-module**: a scheduled Cloud Run job (min instances 0) reads reviews of our own products only, tags
   them on a low tier into a closed theme list (fit runs small or large, colour differs from photo, material doubt,
   wanted view missing, size chart confusion, durability, delivery), keeps a tag only if its quoted span is found
   verbatim, and counts a theme only with at least 3 reviews and 10% of the listing's text reviews (DD7 Flow).
3. **Code maps each theme to a typed fix**: a fact to check (size system, size chart, colour), a missing shot role
   for initiative 2 or 5, a callout order for initiative 6, or "send to brand team". A model may write the sentence
   Naz reads; it may not choose the fix type (DD7 Flow 5).
4. **Fit returns as a second signal** (this document's addition, inside DD7's scope): Namshi `return_reason` lines
   per option (Q-R1, Q-R2 pattern) feed the same `fit_runs_small` / `fit_runs_large` theme, so products with no
   reviews but many fit returns, like example A, still get a proposal. Thresholds tuned on the golden set.
5. **"What customers say"**: a tab on the brand page and a panel on the product page, one card per product with an
   open fix, for example "Namshi: 29 of 51 size returns say too big. Check the size chart, or add 'runs large'
   once the brand confirms." No model names, no reviewer names (DD7 R4).
6. **Guard rails** (DD7): a review never becomes a fact, only a "check this"; complaints never become callouts;
   competitor reviews are never stored or shown; the theme step is measured on a 200-review Arabic and English
   golden set before anything is shown.

### What exists today

| Piece | catalog-module (GCC, live) | catalog-service (India, read only) |
|---|---|---|
| Product identity, brand-scoped, with GCC channel ids | Yes: `catalog_products`, `sku_map`, `sku-mapping.ts` with Noon, Namshi, Styli, Amazon UAE / KSA ids (DD5 F6) | No brand column on SKUs; global lookups (DD5 F5) |
| Workbook fill without damage | Yes: `fillProductListWorkbook` (`packages/core/src/catalog/sheet.ts` line 226) | Yes: openpyxl write-back into a blank template |
| Template parsing, rule types, typed gaps | No | Yes: 6 rule types, 11 typed gap reasons, valid values read from the template (`server/entities/catalog/attribute_enums.py`) |
| Marketplaces configured | n/a | Amazon, Flipkart, Myntra only (`server/utils/marketplace_listing_workbooks.json`); a test asserts "Noon" cannot be resolved (`server/tests/test_listing_marketplace.py`), at commit `1f95291` (24 Sep 2026) |
| Typed fact sheet | No | No (a header-keyed JSON bag) |
| Arabic | No | No (generated text prompt says "Amazon" for every marketplace, `server/pipelines/listing/ai_text.py` line 18) |
| Reads sku_master_p2p | No (master-sync reads master_sl only) | No |
| Text model layer with spend caps, model policy never shown | Yes: `llm.ts`, `openrouter.ts`, `model_policy`, `spend_days` (`SPEND_ENGINES` = `catalog_qa`, `catalog_compute`) | Yes, without length checks or validators |
| Database locks, migrations, versioned outputs | Yes (drizzle, `lock_batch_id`) | No: in-memory locks (`_running_fills_lock`), hand-run SQL, overwritten outputs |
| Review, theme or voice-of-customer code | No (fact sheet reserves `voiceOfCustomer`) | No |
| Attention-card UX to reuse | Yes: `AttentionList.tsx`, `AttentionProductCard.tsx` (batch-scoped today) | n/a |

Verdict (DD5 R6): lift catalog-service's patterns (rule types, typed gaps with a message test, staged dependent
lists, valid values from the template, constrained list choice, "blank beats guess"), rebuild the rest in
TypeScript on catalog-module's identity, locks and migrations. Do not import Python code.

### Ownership versus the India program - recommendation

**The overlap.** India's Catalog v2 deck (slide 7) lists GCC channels inside the India program, with targets Amazon
28 Aug, Noon 18 Sep, Namshi end of Sep (04 Summary 5; `catalog_initiative_india/Catalog v2.md`). The GCC intent map
says "one platform: the catalog module". Two teams could build listing fill for the same channels (07 Risk 11).

**What the code shows (read only, catalog-service `1f95291`, 24 Sep 2026).** After the Noon target date, the India
engine resolves only Amazon, Flipkart and Myntra; "Noon" is a tested error; there is no Namshi, Styli or
Centrepoint layout, no Arabic, no GCC size systems and no brand-scoped GCC identity. The GCC module already holds
the GCC identity and channel ids, the live image links per channel, and the cost ledger.

**Recommendation.**
1. **One owner per channel-country.** The GCC catalog module owns listing content (facts, templates, English and
   Arabic copy, review-driven fixes) for every GCC channel: Noon, Namshi, Styli, Centrepoint now; Trendyol,
   6thStreet, VogaCloset, Shein and Amazon.ae / .sa when taken on. India's catalog-service owns India channels
   (Amazon.in, Flipkart, Myntra, quick commerce).
2. **Amazon.ae / .sa is GCC, but not first.** GCC Amazon softline is small (13k USD attributed, DD9 s4) and Amazon
   publishes its schema by API, so it comes after the four template channels. If India's Amazon engine is reused
   there, it reads the GCC fact sheet as its input; it does not keep a second GCC product record.
3. **Share a pattern library, not code or data.** One versioned set: attribute lists per category, QA checklist
   rules, typed gap reasons with their sentences, the review theme list, and rejection-to-rule mappings. Each team
   implements it in its own stack (04 Question 10; IM rule "lift patterns, not code").
4. **India's GCC targets are withdrawn or redirected** to "consume the GCC fact sheet export", the same read-only
   export B7b and B8 use (DD9 s11).
5. **The owner confirms this in writing before stage A starts**, with Nitin Kiran and the India program lead,
   because it is the only decision in this initiative that changes another team's plan.

Why this split: GCC listings need things India does not (Arabic, GCC size systems, modest-wear flags, Noon's
"noon Size", Landmark curation), the GCC module already owns the GCC identity and images, and one record per product
avoids the two-masters problem the catalog-service brand-scoping defect would create.

## Cost and ROI

All revenue rows are 06's impact model v2, unchanged; costs from DD5, DD7 and DD9; consistent with 07's budget table.
Money is USD a year of extra revenue unless stated; gross listing price, not margin; people time excluded.

### Revenue

| Row | Formula | Low | Base | High |
|---|---|---|---|---|
| B6 facts and templates | Noon and Namshi revenue of p2p-covered brands 7.33M x lift 0 / 0.5% (judged); high on all Noon and Namshi softline 8.26M x 2% | 0 | 36.7k | 165k |
| B7a fit returns avoided | 0.68M x 0 / 2% / 5% (judged) | 0 | 13.6k | 34.0k |
| B7a "not as described" avoided | 32k x 0 / 5% / 20% (judged) | 0 | 1.6k | 6.4k |
| B7a conversion on fixed Noon pages | 1.8M (assumed 80% of Noon softline) x 0 / 0.5% / 2% (judged) | 0 | 9.0k | 36.0k |
| **Total** | | **0** | **60.7k** | **241k** |

- B7a base = 13.6 + 1.6 + 9.0 = 24.2k, shown as 24k in 06 and 07; high = 34.0 + 6.4 + 36.0 = 76.4k, shown as 76k.
- Without Noon review text (no actor, Scout blocked), B7a covers about 60 options with 10 or more ratings; the
  conversion part mostly goes, leaving the returns part, under 15k base (DD9 "Depends on").
- Not added (06 Overlaps): ad money at the same ad sales, B6 1.4k and B7a 0.5k at base, is counted once in
  initiative 3 (L1). Noon content rejection recovery (L2a, 7.5k base) is counted in initiative 2; not-listed
  recovery (L2b, 6.7k base) in initiative 1. B6's lift applies only to revenue live today.

### Run cost

| Item | One-off | A year after | Source |
|---|---|---|---|
| B6 copy, English mid tier + Arabic high tier | 240 (3,748 options x 0.064) | 214 (3,350 new styles x 0.064) | DD5 Exact costs; DD9 s9 |
| B6 vision proposals | about 4 (0.001 per option) | about 3 | DD5 |
| B6 template fill, fact assembly, checks | 0 (code on the existing worker) | 0 | DD5 |
| B7a Noon actor fallback | up to about 190 first pull | 94 to 144 (7.80 to 12.00 a month) | DD7; DD9 s10 |
| B7a theme tagging and fix proposals | about 8 | small | DD7 F5 |
| B7a Scout reviews entity | 0 licence (Scout's jobs and proxies) | 0 licence | DD7 |
| **Year one** | | | **about 804** (B6 454 + B7a up to 350; 07 budget table) |

| Case | Year-one run cost | Basis |
|---|---|---|
| Low | about 40 | low text tier both languages (8 USD catalogue + about 7 a year, DD5), vision about 7, and Scout reaches Noon (B7a under 20, DD9 s10) |
| Base | about 804 | 07 figure (upper bounds for B7a) |
| High | about 804 | the base already uses DD7's upper bound; the main unknown is the share of Noon ratings with text |

### Cash saved

The agency's INR 60 per style covers resizing with links plus template filling, split unknown, never generation
(owner, 2026-10-26). Template share: base INR 30 of the INR 60 per style, minus INR 5.4 copy cost = INR 24.6 x 3,350
styles = INR 82,400, about **1.0k USD a year**; range 0.5k to 1.5k at a 30 / 70 to 70 / 30 split; INR 77,300 (0.9k)
once for the current catalogue (DD9 s6, s9). It is 0 if the agency keeps the templates. The breakdown of the INR 60
between resizing with links and template filling is unknown (DD5 Q6). This initiative generates no images, so the
agency's generation price (INR 500 to 800 per style-colour) does not apply here.

### ROI

| Case | Revenue | Year-one run cost | Revenue per USD of run cost |
|---|---|---|---|
| Low | 0 | about 40 to 804 | 0; cash saved (up to 1.0k) still covers the run cost |
| Base | 60.7k | 804 | about 75 (07) |
| High | 241k | 804 | about 300 |

Formula: base revenue a year / year-one run cost = 60,700 / 804 = 75.5. Ratios ignore margin and people time and
only show that run cost does not limit the initiative (06 Assumptions row 11). The base splits as 36.7k in Phase 2
(stage A) and 24k in Phase 3 (stage B) (07 Phased view).

## Risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| 1 | B6's defect share is unmeasured: the audit does not measure text (06 "B6"); nobody knows whether today's listings carry Arabic or key attributes | 36.7k base could be near 0 if the agency already does this well | Before build, pull agency-filled examples per channel (DD5 Q4) and check a sample of live Noon and Namshi pages for Arabic and attribute fill; the side-by-side in Stage A step 6 decides each channel |
| 2 | Arabic quality: a model writes fluent but wrong Arabic | Wrong claims on live pages; brand and channel complaints | Arabic from facts only; code checks; native-reader golden set before trust; "needs review" until it passes |
| 3 | No native Arabic reviewer is named (DD5 Q5) | Arabic never ships; B6 falls back to English-only fill | Owner names a reviewer inside Opptra or at a channel; English fill can still replace the agency where Arabic is optional |
| 4 | Ownership overlap with India (07 Risk 11) | Two teams build GCC listing fill; two product records | Written decision before stage A (Ownership recommendation) |
| 5 | Real templates not supplied (DD5 Q4) | Nothing can be filled; enums cannot be guessed | Channel by channel: start where a template arrives first |
| 6 | Template changes by channels; `.xlsm` round trip may lose macros or validations | Rejected uploads | Versioned registry; real-template round-trip test; fallback of editing sheet XML in a copy (DD5 R2) |
| 7 | sku_master_p2p ownership and access unknown; `catalog_approval_date` empty on every row (DD5 Q3, Q8) | Main structured source may change or be withdrawn | Owner confirms it as the GCC master; read-only grant to catalog-worker |
| 8 | Brands with no master (French Connection, Puma, Nautica: 1,248 options) | Many "Needs info" gaps on exactly the brand with most Noon content rejections | Ask for brand-manager sheets first for French Connection (DD5 Q2) |
| 9 | Noon reviews unreachable; Scout reviews parked until its Phase 1 exit (DD7 F3) | B7a shrinks to under 15k base | Capped Apify actor after a free-credit trial (DD7 Q2); fit returns as the second signal |
| 10 | A fit theme is wrong (for example a wrong-size-sent complaint read as "runs small") | A wrong size note raises returns | Fulfilment complaints separated; golden set with Arabic examples; size notes only after brand confirmation |
| 11 | Small lifts (0.5% to 2%) cannot be measured by the holdout (06 Measurement plan) | Revenue stays judged | Measure what can be measured: fit-return share per treated option on Namshi, template cells filled, Arabic present; report the revenue lift only if a cell shows it |
| 12 | Returns counted at gross listing price, not margin (DD9 s10) | Overstates money value | Report returns avoided as lines and units first, money second |

## How we measure success

Exit numbers before each step goes live (quality gates):
- **Facts**: on a 50-option sample per brand, 0 wrong values in fields marked `confirmed` (checked against the brand
  sheet or the physical sample); every `conflict` shown to the operator.
- **Arabic**: the native reader passes the 50-option golden set on fluency, accuracy against facts and register;
  then English and Arabic are sampled at a rate the owner sets.
- **Templates**: per channel, the side-by-side against agency-filled sheets shows equal or better required-cell
  coverage and 0 wrong facts; only then does that channel leave the agency.
- **Themes**: on the 200-review Arabic and English golden set, theme precision at a bar the owner approves
  (proposed: at least 90% on fit themes) before any card is shown.

Outcome measures, before and after (baseline from the metrics table):

| Measure | Baseline | Success looks like | How |
|---|---|---|---|
| Style-colours with facts `confirmed` | 58% | rises as brand sheets arrive; French Connection above 0 | Fact sheet status counts |
| Listings with Arabic from our sources | 0 | Noon and Namshi listings carry Arabic title and description after the golden set | Filled templates and copy status |
| Template pairs still at the agency | 9,280 | Namshi and Noon at 0 first, then Styli and Centrepoint | Registry per channel |
| Namshi fit returns on treated options | per option, 12 months before (for example 43% on `71YOH WHITE/BLACK OD`) | share falls on options with an accepted size fix against matched untreated options | Difference in differences per option on Namshi `return_reason` (06 holdout design, secondary metric "Namshi fit returns") |
| Noon content rejections | 479 (21 Aug) | text-related "Content Issues" fall after re-submission | Fresh C-02 feed (initiative 1) |
| Completeness score, attributes and Arabic parts | not defined | defined and reported per brand and channel | Initiative 1 score |
| Proposals decided | none | each open card accepted, dismissed or sent to the brand within the owner's agreed cycle | `catalog_review_fixes` status counts |

The judged revenue lift (0.5% B6, 0.5% Noon conversion) is too small for the holdout to detect (06: Namshi can see
about 15%); it stays judged unless a cell shows a larger effect. Fit returns are the B7a measure that data can
actually prove.

## Dependencies

| Depends on | Why | State |
|---|---|---|
| Initiative 1 (Measure and unblock) | Fresh Noon C-02 to see text rejections; completeness score; treatment log for before and after | Phase 1 |
| Initiative 2 (Channel-ready live catalog) | Shot roles per photo, used by the IMAGE rule and by "missing view" fixes | Phase 1 |
| DD0 taxonomy | Category keys and channel crosswalks for templates | Awaiting owner approval |
| Read access to `dimensions.sku_master_p2p` | Main structured source | Owner question (DD5 Q3, Q8) |
| Real blank templates and agency-filled examples | Nothing can be filled without them | Owner question (DD5 Q4) |
| Native Arabic reviewer | Arabic golden set | Owner question (DD5 Q5) |
| SPEC.md amendment | Listing fill and text generation are outside today's SPEC (models only for judge and classifier) | Draft in DD5 R7 and DD7 R6 |
| Scout `reviews` entity (opptra-scrapers, another team) | Stage B ingestion | Parked in Scout's plan (DD7 F3) |
| Initiative 5's gate | Only if a "missing view" fix is filled by generation | Phase 3 |
| What depends on this | Initiative 6's infographics cannot draw a single fact without stage A (features list); B7b and B8 read the fact sheet export | |

## Owner questions

1. **Ownership**: do you approve that the GCC catalog module owns listing content for all GCC channels, India's
   catalog-service keeps India channels, and the two share a pattern library only? Will you confirm it with the
   India program lead and withdraw or redirect Catalog v2's Noon and Namshi targets (04 Q1)?
2. **Templates**: can you supply the real blank templates for Noon (English + Arabic, one per fashion product type),
   Namshi, Styli and Centrepoint, plus a few agency-filled examples per channel (DD5 Q4)?
3. **Arabic reviewer**: who can label the 50-option Arabic golden set and the 200-review theme golden set (DD5 Q5;
   DD7 Q5)? Is Arabic required on our Namshi, Styli and Centrepoint accounts?
4. **Brand-manager sheets**: which brands have sheets with material, care, fit and origin, and can French
   Connection, Puma and Nautica supply one (DD5 Q2)?
5. **sku_master_p2p**: who owns it, is it the GCC product master, and may catalog-worker read it (DD5 Q3, Q8)?
6. **Agency**: what is the breakdown of the INR 60 per style between resizing with links and template filling
   (DD5 Q6), and is the agency told that templates move channel by channel after a side-by-side?
7. **Today's listings**: may we check a sample of live Noon and Namshi pages for Arabic text and attribute fill
   before build, to measure B6's defect share (DD9 s9)?
8. **Reviews**: who builds the Scout reviews entity (DD7 Q1); may one Apify account with a monthly cap be used for
   the Noon fallback (DD7 Q2); may review-bearing Noon and Namshi listings go on a regular Scout schedule (DD7 Q7)?
9. **Size notes**: who confirms a "runs large" or "runs small" note before it is published: the brand or Opptra's
   brand manager (04 Q9)? Who receives durability complaints (DD7 Q6)?
10. **Size systems**: which size systems and units does each template require (EU / UK / US, cm), and are model
    measurements known for Namshi (04 Q8; DD5 Q7)?
11. **SPEC**: do you approve the draft SPEC amendments for facts, listing copy and reviews (DD5 R7, DD7 R6) at
    Phase 2?

## Query shapes (read only, 2026-10-26)

Project `opptra-datawarehouse`; no PII column selected (customer columns never read).
- **Q-R1**: `fact_gcc.unified_sales`, `channel_name` like Namshi, excluding B2B, FBN, SOR, CUSTOM, IWIT; ordered
  2025-10-22 to 2026-10-21; non-empty `return_reason` grouped by `brand_name` and a keyword class (small, big or
  large, other size or fit); order-line totals per brand from the same filter without the reason condition.
- **Q-R2**: the same rows joined to `raw_gcc_dimensions.master_sl` on `barcode_ean` = `ean`, grouped by
  `option_id_style_color` with `name` and `color`; options with at least 100 order lines, French Connection and
  Campus, ranked by size-or-fit share.
- The recount includes rows with no brand and does not restrict to softline EANs, so its totals (18,195 size or fit
  lines) are a little above DD9's 17,678; 06's figure stays the baseline.

Status: done
