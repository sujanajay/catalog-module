# Initiative 06 - Richer footwear pages (B4 lifestyle image + B5 infographics)

Date: 2026-10-26. Detailed document for initiative 6 of `docs/plans/roadmap/07-roadmap.md`. Documents only; nothing was
built. The only paid action was the illustrative trial in "Example" (2 image calls, 0.21 USD). No time or effort
estimates (owner rule).

**Source codes** (same as 06 and 07). 01 marketing data, 02 liveness data, 03 image audit (`03 csv` = its per-product
file), 05 build vs buy, 06 metrics and impact model v2, 07 roadmap (all in `docs/plans/roadmap/`); DD4 = deep dive
`04-footwear-bags-lifestyle.md`, DD6 = `06-infographics-compositor.md`, DD8 = `08-brand-style-profile-model-registry.md`,
DD9 = `09-business-impact.md` (section numbers as `DD9 s7`); MT = the meeting transcript
`meetings_folder/Catalog-Module-Connect-GCC-14e47c7c-2580.md` (timestamps). **Labels:** (exact) = a count or sum from
data; (approx) = derived or rounded; (judged) = an assumption. Money is USD a year of extra revenue unless stated.
Engine names appear below as technical facts only; they never appear in operator or UI copy.

## Summary

1. US Polo footwear earns about 5.9M of about 9.2M USD softline revenue; 19 of 20 sampled US Polo shoe sets have no
   lifestyle scene and no feature picture (06 B4, B5).
2. Adds, never as image 1, one lifestyle shot (legs-only or carried, no face; real cut-out in a generated scene for kids
   and thin sets) and one infographic lettered by code from confirmed facts, in English and Arabic.
3. Base 116.9k USD a year (low 0, high 350.8k), 43% of the program base; year-one run cost about 985 USD (07).
4. Buy only the image generator behind our own gate; build the composite fallback and the compositor (05, DD4, DD6).
5. Trial: 2 US Polo sneakers, 0.206382 USD. Shape, colour and main logos held; one invented garbled label text, both
   framed above the knee, so the gate is needed. Last only because gated on US Polo rights and Noon / Namshi acceptance.

## Problem, with evidence and real examples

**What the business asked for.** In the 21 Oct meeting Naz showed a UAE marketplace page for the Birkenstock Arizona
Black as the reference: a clean product image with shadow, a model image, a lifestyle image, and infographics
(MT 20:10 to 21:57). She called the lifestyle image "more catchy ... it catches my attention" (MT 21:45, 21:57). DD6
read two infographic layouts from the recording: a feature-tiles image ("ARIZONA ... Premium", tiles labelled
"ADJUSTABLE STRAPS", frame 80) and a 3-panel use-case image ("ARIZONA BLACK: YOUR EVERYDAY ESSENTIAL", panels "URBAN
EXPLORATION / RELAXED WEEKEND / CASUAL WORKDAY", frame 98) (DD6 F1). Which site that page is cannot be read from the
recording (DD6 Q1). On supply she said lifestyle images are "Generally ... not there. 99%" and arrive late only for
kids and Campus (MT 23:44). Today she makes them by hand in ChatGPT, 5 to 6 a day (DD4 F3, F8 O6).

**What our pages show (measured).**

| Evidence | Number | Source |
|---|---|---|
| US Polo share of softline revenue | footwear 5.911M of about 9.2M (US Polo 6.08M of 8.52M attributed); 69% of live-listing revenue | 06 "What changes from DD9" 1; 02 via 07 |
| Footwear sets with no lifestyle scene | US Polo 19 of 20, Campus 4 of 15, Keds 7 of 7 | 03 csv via 06 B4 |
| Pages with no infographic | US Polo 19 of 20; other brands 0 seen, except Cardio Bunny's generated sets | 03 csv via 06 B5 |
| Real-world lifestyle scenes on live Trendyol sets | 1 of 48 sampled (US Polo 0 of 8, Keds 0 of 8) | DD4 F2 |
| US Polo images per Trendyol listing | 4.82 to 5.93 on average (549 options) | DD4 F2 |
| Lifestyle allowed as image 1 on any channel with a public rule | none (Noon: "Lifestyle images are not permitted for the primary images"; Amazon: main shows one left shoe, no model) | DD4 F5 |
| Text on non-main images | Amazon.ae allows it on alternates; Noon mentions "adding text" but also "Only photographs are permitted ... illustrations are not allowed" | DD6 F4 |
| The module today | Holds any lifestyle photo as `leftover_background` and flags any text as `text_or_watermark`; it cannot publish either | DD4 F5; DD6 F4 |

**Real US Polo pages.**
- `LEAN GLB 6FX MEN OD WHITE`, the top softline option by ad spend: 2,232 USD in 90 days, 11,219 clicks, CVR 0.88%
  against US Polo's 1.80%, ROAS 2.18 against 4.67 (01 s2.5, s2.4). It is a target for initiative 3 first (view
  completeness, size run, price); this initiative adds the lifestyle and feature images to the same page.
- `TETSY GLB 6FX MEN OD NAVY` on Amazon UAE: 481 sessions and 0 units in 90 days (02 via 07 Initiative 3).
- Audit sample, typical US Polo set: `ZEB6895448883067F310CZ` (SMITH GLB 4PR, men's sneaker): 6 images, side on white,
  then pair, pair, top, back, sole on light grey. Complete views, no scene, no feature picture (03 csv).
- The one exception: `Z3FE9377898FABAEF0839Z` carries a 600x800 infographic with callout text on a pink background and
  a street lifestyle shot, padded into a 1600x1600 set (03 Examples 9). So the brand has made such images for a few
  styles, unevenly sized and not to any channel rule.
- 7 of 20 US Polo sets add a 600x800 studio on-legs shot with a white padding border (03 "Raw image findings"). Whether
  that counts as lifestyle is owner question 3 below; it changes the base (see "Cost and ROI").

**Why it matters.** The pages that earn the most are the plainest. US Polo spent 55,280 USD on softline ads in 90
days, 32,978 of it on Namshi (01 s2.4), and those clicks land on packshot-only pages. Whether the right extra images
lift conversion is not yet measured: our own data finds no gain from image count alone (CVR ratio 0.954, 9 of 18
cells each way, 01 s3), so this initiative is about the kind of image, and it carries a judged lift until the holdout
in "How we measure success" runs.

## Who it serves

| Who | What they get |
|---|---|
| Shoppers on Noon, Namshi, Amazon, Trendyol | A worn view of the shoe and its features in English and Arabic, after the brand's own photos |
| Naz and the GCC catalog team | The images she now makes by hand at 5 to 6 a day, made for the 1,222-style backlog with a review card instead of a chat window (DD4 F8 O6; DD9 s7) |
| GCC business team and US Polo brand managers | Richer pages on the brand that carries most revenue, with every word traced to a confirmed fact |
| Ad agencies | Better landing pages for the US Polo spend; measured through the Namshi holdout |
| Marketplace account teams | Images that follow each channel's slot and cap rules, so none is rejected or silently dropped |

## Metrics it moves and today's baselines

| Metric | Baseline today | Source | Measurable today? |
|---|---|---|---|
| Footwear pages with a lifestyle image | US Polo 1 of 20, Campus 11 of 15, Keds 0 of 7 (sample) | 03 csv via 07 | Sample only; role tags per live listing come with initiative 1 |
| Pages with an infographic | US Polo 1 of 20 (sample) | 06 | Sample only |
| US Polo ad CVR / CTR (90 days) | 1.80% / 1.35%; Namshi 2.01% / 1.65%; Noon 1.66% / 1.52% | 01 s2.4 | Yes |
| US Polo Amazon unit session % | UAE 1.16%, KSA 0.82% | 02 via 06 | Yes |
| Softline ad ROAS (90 days) | 3.39; US Polo 4.67 | 01 s2.2, s2.4 | Yes |
| Style-colours with 2 or more confirmable features (infographic eligible) | 467 of 3,141 from Opptra's own master; 1,560 if Trendyol-derived features are confirmed | DD9 s8 | Yes (approx keyword method) |
| Added images rejected by a channel | unknown (Noon and Namshi reason feeds missing) | 02; 07 Initiative 1 | No, until C-02 and C-04b load |
| Images per accepted lifestyle image (attempts) | 0.20 USD per accepted image assumes about 2 attempts | DD4 R6 | From the cost ledger once live |

Business outcomes (07 table): conversion direct; sell-through and marketing efficiency indirect; liveness none.

## Solution

### Stage A - lifestyle image (B4)

- **Scope.** One lifestyle image per adult footwear and bag style-colour: 1,222 targets (US Polo 529, Campus 406, Puma
  106, Keds 105 footwear; French Connection 63 and Vero Moda 13 bags; 85 of them kids) (DD4 Summary 1).
- **Method.** Full generation from 3 to 4 of the brand's own packshots (side first, then pair, top, heel; size charts
  and infographics excluded) with the scene keyed on subcategory: sneakers seated on a concrete ledge or in a plaza,
  running shoes on a waterfront path, loafers on a cafe terrace or lobby, slides on a pool deck, bags carried shoulder
  to hip (DD4 F4, R2). Legs-only frames end at or below the knee, no faces, modest styling (women's legs covered to
  the ankle), no landmarks, signs, other brands, alcohol, religious buildings or flags (DD4 F4).
- **Composite fallback.** For kids (never a generated child), bags with fewer than 3 views, embellished products, and
  any product that fails the gate twice plus once on the escalation engine: the brand's real cut-out placed into a
  generated scene and pasted back by code, so product pixels are identical (0 difference measured on every opaque
  product pixel) (DD4 F6, F7, R2).
- **Do not generate** when a lifestyle or worn photo already exists, the subcategory is unknown, the brand profile
  switches it off, sources are below the floor, or every ticked channel is at its cap with no named swap; retire the
  generated image when a real one arrives (DD4 R1).
- **Gate.** DD2's checks G1 to G6 on the product region plus four scene checks: S1 framing by code (no face, frame top
  at or below the knee), S2 modesty, S3 scene safety, S4 product inside the centre square so every channel crop keeps
  it. Every image flagged `generated`, review-all until 100 labelled lifestyle images across at least 3 brands meet
  DD2's exit numbers (DD4 R3).
- **Placement.** One 2K 3:4 frame (1792x2400), cropped per channel by code; always the last image, never image 1; at
  the Trendyol (8) and Amazon (9) caps it replaces the size chart only if the owner says so, otherwise it is not sent
  and the links sheet says why (DD4 R4, R5).

### Stage B - infographics (B5)

- **Two layouts**, both additional images only: (C) feature callouts, the brand's own hero photo with 2 to 4 pointer
  labels and up to 2 detail tiles; (P) use-case panels, a title and three scenes with a heading each, no body copy
  (DD6 R1). These are the two Birkenstock layouts from the meeting.
- **Words only from facts.** Callouts draw only `features[]` with status `confirmed` from initiative 4's fact sheet,
  through a reviewed bilingual glossary (for example `memory_foam_insole` gives "MEMORY FOAM INSOLE" and its Arabic
  label). Never prices, ratings, review words, taglines or seller marks. No image model writes any text (DD6 R2).
  Fewer than 2 confirmed features means no callout image and a typed reason (DD6 F2).
- **Rendering in code** on sharp, which already shapes Arabic correctly (joined letters, lam-alef, right-to-left, mixed
  lines); OFL fonts (Montserrat, IBM Plex Sans Arabic) by default; English with Arabic under it by default; Western
  digits; a glyph-coverage check because a missing glyph silently falls back to another font (DD6 F3, R3).
- **Pointers** placed by one vision call per photo, checked against the matte, draggable by Naz (6 of 6 trial points
  on the right part) (DD6 F5, R4). **Panel scenes** from the brand's own photos first; for US Polo footwear, where they
  do not exist, from Stage A's gated lifestyle frames (DD6 F6).
- **Checks** before publish: fact gate, glyph coverage, read-back (vision model for Arabic, since tesseract misread
  23 of 126 correct Arabic boxes), contrast, thumbnail legibility, safe areas, pointer inside the matte, panel gate
  result, compliance; review-all until 100 callout images show zero wrong words and claims and at least 95% of
  pointers are accepted without a drag (DD6 F9, R5).
- **Channels.** `infographicAllowed`: Amazon and Trendyol yes; Noon and Namshi yes only after written confirmation;
  6thStreet, Styli, Centrepoint, Shein, VogaCloset not sent until confirmed (DD6 R6). Amazon A+ is out of scope (DD6 R7).

### Build vs buy

| Part | Decision | Why (source) |
|---|---|---|
| Image generator (worn scenes, panel scenes) | **Buy**, as a swappable engine through OpenRouter (DD3's choice, 0.1032 USD per 2K attempt), escalation engine for the ladder | Only full generation makes the worn shot Naz asked for; the alternative tested engine re-drew the US Polo monogram (DD4 F6, F8 O1, O5) |
| Scene-around-product APIs (Bria, Stability, Photoroom, Claid, Vertex) | **Do not buy now**; Bria (0.032 USD) is the one to re-test if composite volume grows | Still life only, a second vendor and data review for little gain (DD4 F8 O3, Options D) |
| Composite fallback | **Build** from the module's matte, sole-strip recovery and contact shadow | Product pixels locked by code (DD4 F9) |
| Gate, scene checks, slots, crops, publish, ledger | **Build / keep** | The vendor never judges its own output; channel rules are ours (05 Capability table) |
| Infographic compositor | **Build** on sharp; do not buy Bannerbear, Placid, Templated or Canva Autofill | Under 0.0001 USD per render vs 0.005 to 0.05 per image on plans; vendors need our photos and facts sent out, do not state Arabic shaping, and sit outside our checks (DD6 F7) |
| Model-painted infographics | **Reject** | Both painted controls invented an unsupported claim ("GRIP OUTSOLE"), redrew the shoe and misplaced pointers (DD6 F8) |
| Manual route (ChatGPT by hand) | **Retire for this work** | 5 to 6 a day does not reach 1,222 styles; no gate, no record (DD4 F8 O6) |

The generator returns pixels only; placement, size, background and encoding stay ours, so changing vendor never
changes channel compliance (05 "Rules for the engine slot").

## Example (what was tried, cost, result)

**What was tried.** Two US Polo sneakers from the audit sample (`us-polo-sku-images`, 1600x1600 brand packshots),
one lifestyle image each, one call each, using DD4's request shape (`POST /api/v1/images`, Nano Banana 2, 2K, 3:4,
4 reference photos, DD4's fidelity sentence, DD4 F4 scene and common rules). The request fields were re-checked
against OpenRouter's current docs through Context7 before the call.

| Product (audit folder) | References | Scene asked |
|---|---|---|
| RHODE GLB 5PR MEN OD_BEIGE (`Z02E9879874F6F1C69DCAZ`): cream sneaker, navy horsemen logo, brown accents, brown and navy midsole stripe, navy speckles | side, pair, top, back | Men, legs-only, seated on a concrete ledge in a plaza, navy chinos to the ankle, crop above the knees |
| HARLEY GLB 6FX (`ZA8DB1DEC68C4ED877273Z`): women's black sneaker, grey logo, white cupsole with a "USPA" side panel | side, pair, top, back | Women, legs-only, walking on a cafe terrace, wide-leg cream trousers to the ankle, crop at the knees |

**Cost (exact, per-response `usage.cost`).** RHODE 0.103193 USD, HARLEY 0.103189 USD, **total 0.206382 USD** of the
3 USD cap. Both 1792x2400, 22 to 26 s each. This matches DD4's 0.1032 per attempt. No other paid service was used.

**Result, judged by eye on side-by-side sheets and full-resolution crops against DD2 and DD4's checks.**

| Check | RHODE (men, beige) | HARLEY (women, black) |
|---|---|---|
| Shape and proportions | Kept (runner silhouette, wavy outsole) | Kept (cupsole, side insert geometry) |
| Colour | Kept (cream, brown, navy) | Kept (black, white, grey) |
| Main logo | Horsemen logo in the right place and colour | Horsemen logo kept; "USPA" side panel legible and exact; "USPA" tongue label kept |
| Small text | **Fail**: the tongue patch reads "U.S. POLO" over invented garbled letters ("AESSR"); the reference has a clean brand label | Pass |
| Other details | Stripe and speckles kept | Mesh collar, flecked laces and red heel tab kept |
| Framing (S1, frame top at or below the knee) | **Fail**: thighs, hands and a shirt hem are in frame; no face | **Borderline**: frame top at mid-thigh, legs fully covered, no face |
| Modesty and scene (S2, S3) | Pass (no signs, no landmarks) | Pass (cafe chairs, tiled wall, no text) |
| Verdict under the proposed gate | Hold (G2 small-text change; S1) | Pass on product; S1 would flag the crop unless the owner accepts covered thighs |

**What it shows.** The engine reproduced the shoe, its colours and its large marks on both products, which supports
DD4's 6 of 6. It still invented lettering on a small label and ignored the knee crop on both, exactly the two risks
DD4 named (G2 for small text, S1 framing checked by code, not trusted to the prompt). One of two would publish after
review; the other would be held and retried. That is consistent with the 0.20 USD per accepted image assumption
(about 2 attempts each). Two images are not a sample; they illustrate the gate, they do not measure it.

Files: inputs, outputs, sheets, zoomed crops, `meta/runs.jsonl` (no key) and scripts in
`C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\8948687b-c329-4062-a372-8e34a714b089\scratchpad\examples\06\`
(`outputs\LS_uspa_rhode.png`, `outputs\LS_uspa_harley.png`, `meta\judge_*.jpg`, `meta\zoom_*.jpg`).

## Cost and ROI

### Revenue (06 "Formulas, step by step"; 07 Initiative 6)

Formula for both rows: revenue touched x measured share without the image x judged lift.

**B4 lifestyle.**
- Revenue touched = 5.911M x 19/20 (US Polo) + 0.788M x 4/15 (Campus) + 0.159M x 7/7 (Keds) = 5.616 + 0.210 + 0.159
  = 5.98M (approx).
- Lift 0 / 1% / 3% (judged, DD9) = **low 0, base 59.8k, high 179.5k**.

**B5 infographics.**
- Revenue touched = Noon and Namshi revenue of style-colours with features (6.02M, DD9 s8) less pages that already
  carry one: US Polo 4.54M x 19/20 + Cardio Bunny 0.088M x 1/15 + others 1.39M = 5.71M (approx).
- Lift 0 / 1% / 3% (judged) = **low 0, base 57.1k, high 171.3k**. On confirmable features only: 1.22M x 1% = 12.2k.

**Initiative total: low 0, base 116.9k, high 350.8k USD a year.** Highs overlap with initiative 3's L4 on the same US
Polo pages and are not additive (06 Overlaps). Ad money: at a 1% lift, B4 would save 2.1k and B5 2.3k of spend at the
same ad sales, shown for comparison only; ad money is counted once, in initiative 3 (06 Summary table, Overlaps).

**Sensitivity to the gates** (derived here from the same formulas, approx):

| Owner answer | B4 base | B5 base | Initiative base |
|---|---|---|---|
| All yes (07 base) | 59.8k | 57.1k | 116.9k |
| Studio on-legs shots count as lifestyle (owner Q3) | 41.9k (06 B4) | 57.1k | 99.0k |
| Proposed features not confirmed, or brand sheets do not arrive | 59.8k | 12.2k | 72.0k |
| Noon and Namshi say no to infographics | 59.8k | about 0 (Amazon and Trendyol revenue of the set is 0.05M, DD9 s8) | about 59.8k |
| US Polo refuses generated and lettered images (other brands yes) | 0.369M x 1% = 3.7k | (5.71M - 4.54M x 19/20) x 1% = 1.40M x 1% = 14.0k | about 17.7k |

US Polo's single answer moves about 99k of the 116.9k base.

### Run cost (07 "Total budget"; DD4 R6; DD9 s7, s8)

| Item | Low | Base (07) | High | Basis |
|---|---|---|---|---|
| B4 backlog, 1,222 style-colours, one-off | 126.11 (every image passes at first attempt, 0.1032) | 244.40 (0.20 per accepted image) | 244.40 | DD4 R6 |
| B4 new styles, a year | about 260 | about 260 | about 260 | about 1,300 new footwear and bag styles a year x 0.20 (DD9 s7) |
| B5 callouts, one-off | 5.04 (467 confirmable x 0.0108) | inside 481 | 16.85 (1,560 x 0.0108) | DD9 s8 |
| B5 panels from brand photos, one-off | 0 | inside 481 | 29.61 (3,748 x 0.0079, upper bound) | DD6 costs |
| B5 footwear panels with 2 generated scenes, one-off | 0 (callouts only, DD6 option D) | inside 481 | 435.01 (1,061 adult footwear x 0.41) | DD6 costs |
| **Year one** | **about 391** (126 + 260 + 5) | **about 985** (244.40 + 260 + 481) | **about 985** | 07 |

Kids, unknown subcategory and capped products lower the B4 figure (DD4 R6). Per-call costs and engine ids go to the
cost ledger; the default daily spend cap (10 USD) paces a backfill unless the owner raises it (DD4 F9). People time
and margin are excluded by rule (06 Assumptions 11).

### ROI

- Base: 116.9k / 985 = about **120 USD of base revenue per USD** of year-one run cost (07).
- Low revenue case: 0 (if every lift is zero or the gates say no). Cash saved: none; the agency does not make these
  images (DD9 s7, s8). The saving is capacity: the 1,222 lifestyle backlog is about 94% of a year of the manual route
  (DD9 s7).
- High: 350.8k / 985 = about 356 per USD (highs overlap, so this is a ceiling).
- These ratios show that run cost does not limit the initiative; they are not profit figures (07).

## Risks

| # | Risk | Effect | Mitigation |
|---|---|---|---|
| 1 | Brand rights: US Polo has not given written rights for generated and lettered images (DD4 Q5, DD6 Q5) | About 99k of the 116.9k base | Ask US Polo first; nothing publishes without a covering `brand_rights` row (DD8 R2) |
| 2 | Channel acceptance: Noon's page mentions "adding text" but bans "illustrations"; Namshi publishes nothing (DD6 F4) | B5 is worth about 0 without Noon and Namshi | Written confirmation before any send; `infographicAllowed: unknown` means not sent |
| 3 | Every lift is judged, and our data shows no gain from image count alone (01 s3) | Revenue scales with the lift; a 1% lift cannot be measured directly on any channel (06) | Holdout cells for lifestyle and infographic; drop rows that show nothing |
| 4 | The generator redraws small text and logos (trial: garbled tongue label; DD4: monogram re-drawn by the second engine) | Wrong brand marks on a live page | G2 logo and text check; review-all until exit numbers; composite fallback |
| 5 | Framing and scene prompts are followed loosely (trial: 2 of 2 framed above the knee; DD4: men's slides, a real-looking skyline) | Modesty or landmark issues | S1 by code with a face detector; S2, S3 judge questions; hold on fail |
| 6 | Image caps: Trendyol 8, Amazon 9; Keds and Campus already carry 7.0 to 7.8 on Trendyol (DD4 F5) | About 470 Trendyol pairs need a size-chart swap or are skipped (DD9 s7) | Caps encoded in initiative 2; owner sets the priority among size chart, lifestyle, callout and panels |
| 7 | Generated-image labelling: Amazon may need a synthetic-performer tag; Shein bans AI imagery that misrepresents items (DD4 F5) | Rejections or policy exposure | Owner question on labels; embed an "AI-generated" metadata tag by default if the owner agrees |
| 8 | Wrong claims on an infographic | A false claim on a live page | Fact gate: confirmed features only, glossary only, no model writes text, read-back check (DD6 R2, F9) |
| 9 | Arabic quality | Wrong or awkward Arabic labels | One native review of a short glossary instead of per-product generation (DD6 F2) |
| 10 | Brand photos leave GCP for a US or Google-hosted engine (05 Risks) | Data and contract exposure | Written no-training position per vendor before any live run (05 Q2) |
| 11 | Overlap with initiative 3 (L4 missing views) on the same US Polo pages | Double counting; slot competition | Highs not added; separate holdout cells (06 Overlaps) |
| 12 | Content is not the blocker on many pages: 71.4% of live stocked options sold nothing in 90 days (02) | Images on pages blocked by stock, size run or price earn nothing | Target only live, stocked pages with no price or size-run reason (07 Risk 3) |
| 13 | SPEC non-goals forbid lifestyle backgrounds, generative edits, paid image APIs and template features (DD4 R7, DD6 R8) | Cannot build without amendments | Owner approves the drafted SPEC wording in DD4 R7 and DD6 R8 |

## How we measure success

1. **Proof of lift (06 Measurement plan, cells 3 and 4).** Holdout on US Polo footwear: lifestyle as the last image on
   Namshi and Noon (cell 3, after rights); a callout infographic on US Polo and Campus (cell 4, only after Noon and
   Namshi accept in writing). Unit = style-colour on one channel-country, paired by clicks within strata (brand,
   channel-country, price tercile, click band), with a freeze on bids, budgets and prices agreed with the agencies.
   Primary metric: ad CVR on Namshi and Noon; Amazon unit session % where sessions exist. Namshi can detect about a
   15% relative lift per cell with about 42% of one 90-day window of softline clicks; a 1% base lift is not detectable,
   so success is a measured lift large enough to see, and the row is cut if the cell shows nothing (06).
2. **Coverage.** Share of live US Polo footwear pages carrying a lifestyle image (from 1 of 20 sampled) and an
   infographic (from 1 of 20), read from the treatment log and role tags of initiative 1.
3. **Quality gate exit.** Lifestyle: 100 labelled images across at least 3 brands meeting DD2's exit numbers. Callouts:
   100 labelled images with zero wrong words and zero wrong claims, at least 95% of pointers accepted without a drag.
   After exit, passing outputs publish without review (DD4 R3, DD6 R5).
4. **No harm.** Zero channel rejections caused by the added images, read from the Noon (C-02) and Namshi (C-04b) reason
   feeds once restored; no rise in Namshi fit returns on treated options (06 secondary metrics).
5. **Cost.** Accepted-image cost near 0.20 USD for lifestyle and 0.0108 USD per callout image in the cost ledger.

## Dependencies and gates

**Inside the program (07).**
- Initiative 1: treatment log, role tags, reason feeds, the holdout.
- Initiative 2: shot roles per photo, per-channel caps, last-slot placement, the "incomplete" status.
- Initiative 4 stage A: the fact sheet with confirmed `features[]`; infographics cannot draw a single word without it.
- Initiative 5: the generation gate (DD2 G1 to G6) built and labelled, and the generator in the engine slot.
- DD8: brand style profile (scene table, modesty rules, fonts and colours) and the `brand_rights` record.

**Gates only the business can open.**
1. US Polo's written rights for generated lifestyle images and lettered infographics; then Campus, Keds, Puma, French
   Connection, Vero Moda (DD4 Q5, DD6 Q5, DD8).
2. Noon and Namshi written acceptance of a text-and-photo infographic as an additional image (DD6 Q2).
3. SPEC amendments for one lifestyle image (DD4 R7) and the infographics (DD6 R8).
4. Vendor data position for brand photos sent to the engine (05 Q2).
5. A native Arabic reviewer for the glossary (DD6 Q6).

## Owner questions

1. Will US Polo (and then Campus, Keds, Puma, French Connection, Vero Moda) give Opptra written rights to publish
   generated lifestyle images of their products and to letter their product images? Does any brand require its own
   typeface or forbid feature claims beyond its own sheet? (DD4 Q5, DD6 Q5)
2. Can Naz or the account managers get written confirmation that Noon and Namshi accept a text-and-photo infographic
   as an additional image, and the same for 6thStreet, Styli, Centrepoint, Shein and VogaCloset? (DD6 Q2; DD4 Q6)
3. Do studio worn shots (the 600x800 on-legs images in 7 of 20 US Polo sets) and Campus's styled studio sets count as
   "lifestyle already present"? (DD4 Q2; moves B4 base from 59.8k to 41.9k)
4. At the Trendyol (8) and Amazon (9) caps, what is the priority among the size chart, the lifestyle image, the callout
   image and the panels image? (DD4 Q3, DD6 Q4)
5. Must generated images carry a label, and should every generated image embed an "AI-generated" metadata tag by
   default? (DD4 Q4)
6. Bilingual infographics (English with Arabic under it) or separate English and Arabic images per locale? (DD6 Q3)
7. Who reviews the Arabic glossary? (DD6 Q6)
8. Which site is the Birkenstock Arizona reference page? If it is one of our nine channels, it is the best evidence
   that the channel accepts infographics. (DD6 Q1)
9. New from the trial: for women's styles with legs fully covered, is a frame that starts above the knee acceptable,
   or must every legs-only frame start at or below the knee as DD4 proposes?
10. Is Amazon A+ wanted later, and does Opptra hold Brand Registry access for any of the brands? (DD6 Q7)

Status: done
