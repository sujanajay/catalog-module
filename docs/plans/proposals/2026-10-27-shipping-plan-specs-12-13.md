# Shipping plan for specs 12 and 13: six initiatives

Specs 12 (apparel shot set) and 13 (footwear and bag scene image) were each written as "one build". This document
proposes shipping them as six initiatives, in a fixed order, where each one ends with something Naaz sees in a
real batch. For each initiative it states what it builds, which switches and gates it needs, which history problems
it closes, and what it costs and returns per new style or SKU. It is a decision document for Sujan and Nitin.
**Nothing in this document changes a spec, the prototype, a business case, SPEC.md or the execution protocol.**
Where it and a spec disagree, the spec wins.

How to read the numbers: every figure carries a tag and a source. **M** = measured (counted from data or a bill),
**A** = assumed (a working figure not yet measured), **J** = judged (an estimate built on judgement, often a
revenue lift nobody has tested). Sources look like (S12 L1260) = spec 12, line 1260. Appendix B lists the files.
Two shortcuts keep the text readable: a count cited to the audit, the inventory count (INV), the meeting, a
business-case sample or a solutions file is M unless it carries another tag; and a figure in prose that repeats a
tagged table row carries that row's tag.

> **Bottom line**
>
> - **Six initiatives, in this order:** 1 See the gaps (apparel, report only) -> 2 Crops that complete the set ->
>   3 Made photos from the brand's own model photos -> 4 Scene image for every shoe and bag -> 5 Brand faces, flat
>   lay to on-model, kids -> 6 Already-live products, on request.
> - **Total yearly spend** on paid image calls through initiative 5: about 175-230 USD a year (A), rising to about
>   395-445 USD only if the audit's flat-lay-only share (11 of 66, M) holds for all inflow (A). Initiative 6 adds
>   about 230-270 USD once, only if every eligible live product were requested (A).
> - **About nine tenths of the judged value (92%, J) is on the table after initiative 4**, and initiatives 1 and 2
>   need no paid generation and no outside legal gate.
> - **Three things only Sujan can unblock:** (1) type the migration exception (one text covers both specs);
>   (2) get brands' written rights for generated images, including the lifestyle scope, US Polo first; (3) start the
>   commercially licensed face-model choice on day one. The legal confirmation on biometric and kids data is
>   recommended before initiative 5 goes live, not a blocker (S12 L2478-2480; S13 L1613-1615), but is worth
>   starting at the same time.

Words used here (defined once):

- **Report mode:** the system works out which shots each product has and lacks, and says so on the sheet and
  product page, but changes nothing on any listing. **Act mode:** it also fills the gaps.
- **Crop:** a rule-bound cut of the brand's own full-length photo (for example a head-and-shoulders shot), with no
  pixel changed. Costs no paid call.
- **Mode A:** a missing apparel shot is generated from the brand's own model photos of that product.
  **Mode B:** a flat-lay-only product is shown on the brand's own approved model, starting from one approved photo.
- **Fidelity gate:** the automatic checks (G1-G7) that a made photo shows the same product, logos and colour, and
  is modest and correctly framed. A photo that fails is never published; it is "Not made" with a plain reason.
- **Test run:** the internal all-brand run in the test area where a person checks every made photo
  ("review-all"). Live marketplaces never see it.
- **Cell:** one department x audience group (for example "women's dresses" or "kids sneakers"). A cell goes
  **automatic** (publishes on the gate plus a few spot checks) once it has enough clean labels; this is its
  **exit**. A bad spot check sends it back to review-all (**relapse**).
- **Composite (still life):** the brand's own product photo pasted unchanged into a generated scene, with no person.
- **Brand DNA:** the admin page holding each brand's logos, brand words, permissions, models and look.
- **Bench:** the ranked list of approved image generators, scored against each other on our own products.
- **Switch:** a setting that turns a feature on or off without new code (for example `SHOT_SET_MODE`).

## 1. The six initiatives, in order

Shared building blocks (migration 0005, the bench, the fidelity gate, Brand DNA, the eval programme) are built
once, inside the first initiative that cannot run without them.

### Initiative 1. See the gaps (apparel, report mode)

**What Naaz sees.** Every apparel batch's links sheet and product page say, per product and marketplace, which of
the five shots (front model, full length, close-up, back, head-and-shoulders) exist, which are missing, and which
on-model photo has the head cut. Nothing on any listing changes.

- **Builds:** spec 12 section 1 (the whole additive migration 0005; bench and Brand DNA tables land empty),
  2.1-2.3 (shot roles, head-cut, garment-type ladder), sheet columns from 8.4, shot-type evals, Ops panel "Shots
  each marketplace asks for". Workstreams A, B, H (sheet), K (Products tab), J (role evals).
- **Switch and rollout:** `SHOT_SET_MODE=report`, the default (S12 L664-669). Live for all brands once the role
  evals pass: at least 95% correct per role on at least 20 photos, kids 100%, head-cut 100% (S12 L655-659).
- **Prototype lit:** Needs me "Questions for you", Products tab status, links sheet shot and "What is missing"
  columns, Ops "Shots each marketplace asks for" (PROTO L1511). Test guide A6, A7, D30, F38.
- **History closed:** the one-reviewer audit (65 of 66 apparel lack the five-shot set, audit L20; head cut 13 of
  66 for Styli and Centrepoint, audit L167; both M) becomes a measured count on every product of every batch.
  Naaz's "we are only having three images ... I would require five images" (meeting L117) gets a per-product
  answer before listing.
- **Gates before start:** G0 migration exception, G1 channel rule table (Section 5).

**ROI per new apparel option.** For about half a cent to one cent a product (A), every later number in this plan
stops resting on a 66-product sample (M) and becomes a measured rate within the first week of batches.

| Line | Arithmetic | Value |
|---|---|---|
| Platform cost per option | | 0.004-0.012 USD (A, BC-A L292) |
| A year of new options | 842 in six months, doubled | 1,684 (M base, A doubling, BC-A L397) |
| Yearly spend | 1,684 x 0.004-0.012 | about 7-20 USD (A) |
| Images added | | none |

### Initiative 2. Crops that complete the set (apparel, act mode, generation off)

**What Naaz sees.** Head-cut photos are replaced by crops in the same publish (never removed without a
replacement); missing head-and-shoulders, close-up and back slots are filled by crops of the brand's own photos at
zero cost. Step 4 shows the "Extra shots" card, "Needs me" shows spot-check cards, "Upload photos" on a product page
opens a one-product batch, and the links sheet gains versions and "To re-submit".

- **Builds:** spec 12 2.4 operator flow, 3 planner, 4 crop engine, 8 publish (remove-and-replace), 7.1-7.5 card
  shell, one person per photo, crop exit, 1-in-20 spot checks, relapse, admin pause. Not 7.6 fixes. Workstreams
  C, D, H, K, G (swap part), J. The spec names this split itself: "Cropping alone lets workstreams A to D, H, J, K
  ship with `generate` off" (S12 L139-140).
- **Switch and rollout:** `SHOT_SET_MODE=act`, generate off. Deployed off -> internal all-brand test run (every
  swap answered) -> live -> automatic after 100 approved swaps in a row across all brands (S12 L1538); then 1 in 20
  products with swaps gets a spot check (S12 L1567-1570). No crop is ever cut from a photo of a child (S12 L1151).
- **Prototype lit:** Extra shots card at 0 USD, Needs me spot checks (keys Y N J K), spot card "All good /
  Something is wrong / Replace photo n", product page "Upload photos" and "Show how this product was worked out",
  Ops "Photo swaps" with Pause. Test guide A1, A3, A4, A5, A8, B10, B18, B20, D29.
- **History closed:** head cuts live unchanged (15 of 64 on-model products, audit L22; "about 9 in 10 live
  listings carry the brand photos as received", audit L148); Sujan's "if the input image is having like a cut ...
  we are not able to solve it" (meeting L109); the operator guide line "The tool never crops" retires
  (operator guide L93); Shein minimum of 2 failing 12 of 141 (audit L172); part of VogaCloset minimum of 4 failing
  21 of 141 (audit L171); head-and-shoulders missing on 57 of 66 (audit L120).
- **Gates:** G2 cropping approvals A1-A4 (S12 L2383); test-run reviewers named, with a second person for the 20%
  overlap (S12 L146-147, L1940-1942); G8 Styli and Centrepoint written position on crops (soft: crop rows per channel are data the
  owner can switch off).

**ROI per new apparel option.** Crops cost nothing, and they carry about two thirds of spec 12's whole judged
value (J), so this is the cheapest value in the programme.

| Line | Arithmetic | Value |
|---|---|---|
| Crop cost | | 0 USD (M, S12 L1176-1177) |
| Crops a year | 1,520 / 1,684 | about 0.9 per new option (A, BC-A L410) |
| Options crops alone complete | 1,015 missing - 211 needing a made shot | about 800 a year (A, BC-A L409, L411) |
| Agency spend avoided | 800 x 5.95-9.52 USD | 4.8k-7.7k USD a year (M quote, J applicability, BC-A L294) |
| Judged revenue | 17.8k conversion + 14.7k Styli/Centrepoint sets | 32.5k USD a year (J, BC-A L518-519) |
| Share of spec 12 base | 32.5k / 48.4k | about two thirds (J, BC-A L522) |

### Initiative 3. Made photos, mode A (apparel generation from the brand's own model photos)

**What Naaz sees.** A missing adult apparel shot that no crop can fill is generated from the brand's own photos,
checked by the fidelity gate, shown on the spot card, fixable with "Fix and try again", and published with a hidden
"AI-made" tag and a sheet column. Step 4 shows "About X USD, never more than <cap>".

- **Builds:** spec 12 1.5 bench, 5 generator (one interface, AI tag, caps, standing bake-off), 6 gate G1-G4, G6,
  G7 and OCR (G5 face identity by two judges only until initiative 5), 7 review in full including 7.6 fixes and
  per-cell exit, 9.2/9.6/9.7 Brand DNA shell with Logos, Brand words and Brand permissions (no Models tab, no mode
  B, no kids), 11.5 nightly evals, 11.6 Phase 0 signals, 12 scorecard. Workstreams E, F, G, I (shell), J, K.
- **Shared foundation for spec 13 is built here once:** bench with scene uses, caps check with an optional cap,
  AI-tag helper, gate framework, fix panel, eval programme, judge "pair" view (S12 L2393-2404). Spec 13 stops if
  any of these is missing on main (S13 L95).
- **Switches and rollout:** `generate_enabled` per brand, per-engine bench approval, cap = estimate x 1.5 rounded
  up, at least 1 USD, plus a fix allowance (S12 L373-378), hosted services off. Deployed off -> Vero Moda technical
  test -> all-brand test run -> scorecard -> owner yes -> live -> automatic per cell (at least 300 labels over at
  least 3 brands, false passes at most 2%, S12 L1537). Face-showing roles stay checked by a person until a licensed
  face model exists (S12 L151-154); back, fabric and close-up roles can go automatic.
- **Prototype lit:** full spot card, Fix panel with reasons and round history, AI-made column, More options
  "Do not make new photos", Brand DNA Logos and Brand words, Brand permissions, Ops "Made photos" with Pause and
  "Test run labels per cell". Test guide A2, A9, B11, B12, B13, B14, B16, B17, B19, B21, F32, F36.
- **History closed:** front-model and back gaps crops cannot fill (25 and 19 of 66, audit L120); Naaz's unchecked
  chat-tool images ("five images to six images per day", meeting L166) replaced for apparel by a checked, tagged,
  capped flow; redrawn prints (7 of 7 trials, BC-A L210) caught by G2 and OCR; provider refusals on lingerie become
  "Not made" with a plain reason rather than a silent hold.
- **Gates:** G3 generation approvals A5-A8 (S12 L2383) and the SPEC rule "No paid image API without a separate
  owner yes" (SPEC L53-54); vendor no-training positions (BC-A L617). G7 channel AI-disclosure rules: ask now,
  but not a blocker; the spec's default is the XMP marker on every channel until one asks for more (S12 L2483-2484).

**ROI per new apparel option.** About one new option in eight (A) needs a made shot, at about 0.20 USD each (A),
so the whole year costs about the price of four to seven agency jobs (A).

| Line | Arithmetic | Value |
|---|---|---|
| Cost per accepted shot | about 2 attempts | 0.20 USD (A, S12 L62-63); worst 0.34 (A, S12 L1260) |
| Shots a year | 211 / 1,684 | about 1 in 8 options (A, BC-A L411) |
| Yearly spend | 211 x 0.20 | about 42 USD (A); about 0.025 USD averaged over all inflow (A) |
| Agency spend avoided | 211 x 5.95-9.52 | 1.3k-2.0k USD a year (M quote, J applicability) |

BC-A L422 gives 1.3k-2.1k for the generated part because it adds the 7.5 mode B options.
| Judged revenue | | 8.6k USD a year (J, BC-A L520) |

### Initiative 4. Scene image for every shoe and bag (spec 13, no faces)

**What Naaz sees.** Every new footwear or bag style-colour leaves its batch with one scene image, placed last,
never image 1. Step 4 shows a "Scene images" card with "Make them / Still life only / Not this time"; the scene spot
card shows the core box and the per-marketplace crop lines; Brand DNA gains Scenes and Kids look; Ops gains
"Scene worn" and "Scene still life".

- **Builds:** spec 13 workstreams A-F in full with the spec's own defaults: no face for any audience (S13 L230) and
  kids shown legs or feet only (S13 L226-229). Face routing waits for initiative 5. It runs as two steps under the
  same switch: **4a, the still-life test run first** (composite: product pixels pasted back unchanged, so G1-G4 are
  skipped by construction, S13 L800-801), then **4b, the worn or carried legs-only route**. The "first, then"
  order is this plan's; the spec runs both routes inside one all-brand test run (S13 L1218-1219).
- **Dependencies:** initiatives 2 and 3 merged; spec 13 workstream A depends on "spec 12 merged" (S13 L163).
  Spec 13's own migration is covered by the same exception text (S12 L163-165).
- **Switches and rollout:** `SCENE_ENABLED` off at deploy (S13 L1200); per-brand `lifestyle_scope` none /
  still_life / worn_or_carried (S13 L245) stages go-live by data; cap 0.81 USD per eligible product (S13 L681);
  stop rules (S13 L1283-1285). Deployed off -> all-brand test run with US Polo as technical test (S13 L1220-1221)
  -> live per brand -> automatic per cell (at least 150 labels over at least 3 brands for worn, at least 10 per cell
  and 30 for kids cells; still life exits on its own 20, S13 L1135-1142). Kids spot checks 1 in 4 (S13 L1186).
- **Prototype lit:** Scene images card, scene choice, scene spot card with scene reasons, Scenes and Kids look tabs,
  scene scope on Brand permissions, Ops scene cards and per brand and marketplace panels. Test guide C22-C28 (C28:
  Campus with no permission).
- **History closed:** Naaz on footwear lifestyle: "Generally it is not there. 99%" (meeting L143); US Polo 19 of
  20 and Keds 7 of 7 sampled pages with no scene (S13 L24); 55,280 USD (M) of US Polo ads landing on packshot-only pages
  (BC-B L16); Naaz's hand-made scene images (BC-B L50-51); Vero Moda bags with 1-2 images (7 of 8, BC-B L290) gain
  one more.
- **Gates:** G4 brand written rights with lifestyle scope (none on record today; US Polo unconfirmed, BC-B L378);
  per-brand profile approval; the 150-label exit bar, still the writer's proposal and not an owner decision
  (cross-check L124).

**ROI per new style-colour.** About 0.20 USD (A) buys one scene image, against a judged 52-75 USD a year of
revenue per style-colour (J): the largest single judged value in the programme for about 120-160 USD of yearly
spend (A).

| Line | Arithmetic | Value |
|---|---|---|
| Cost per attempt | | 0.1032 USD (M, S13 L661) |
| Cost per accepted image | still life / worn | about 0.15 (A, midpoint) / 0.20 (A, S13 L662) |
| Scene cap | ladder 0.76 + fix 0.05 | 0.81 USD per eligible product (S13 L681) |
| Style-colours a year | 398 in six months, doubled | about 800 (M base, A doubling, S13 L22, L674) |
| Yearly spend | 800 x 0.15-0.20 | about 120-160 USD (A; 160 at S13 L674); ceiling 608 at the 0.76 ladder cap (A) |
| Agency spend avoided | 800 x 5.95-9.52 | 4.8k-7.6k USD a year (M quote, J applicability, BC-B L213, L337) |
| Judged revenue | at a 1% lift | 41.9k (still life counts) to 59.8k (any scene) USD a year (J, BC-B L364, L370) |
| Per style-colour | 41.9k-59.8k / 800 | about 52-75 USD a year (J) |

### Initiative 5. Brand faces: own model, flat lay to on-model, kids

**What Naaz sees.** Flat-lay-only brands (Cardio Bunny, Only, Anta) get the garment on the brand's own approved
model from one anchor photo (mode B); face-showing roles can go automatic; kids apparel and kids or registered-adult
faces in scenes become possible; Brand DNA gains the Models tab (Women / Men / Kids), the harvester and Delete.

- **Builds:** spec 12 section 9 in full (harvester, measured face identity G5, biometric handling, delete), mode B
  rows in sections 3 and 5, mode A on a kids model (S12 L2470-2471); spec 13 face routing (person per audience,
  G5/G6 on scenes, registered-face and kids-face cells).
- **Dependencies:** initiatives 3 and 4.
- **Gates:** G5 a commercially licensed face-embedding model (the library named earlier, InsightFace, publishes its
  recognition weights for non-commercial use only, S12 L1848-1849) and a human-parsing model licence (S12 L2472);
  one approved reference model per brand, gender and audience (S12 L148-150); likeness rights. G6, the legal
  confirmation on biometric and kids data, is recommended before go-live, not a blocker (S12 L2478-2480; S13
  L1613-1615); the kids age band already has a spec default (S12 L2485-2486). This initiative carries the
  face-licence gate and the legal confirmation, which is why it is fifth, not third. Both should start on day one.
- **Prototype lit:** Models tab, anchor approval, Look tab, Kids look models, Delete. Test guide B15, F33, F34, F35.
- **History closed:** Cardio Bunny sends one 3000x4500 photo per colour and fails every minimum (5 of 5, audit
  L100); Only 3 of 4 apparel a single flat packshot (audit L98); Anta flat-only apparel (audit L101); 11 of 66
  apparel with no model photo at all (audit L117); Naaz: "for garments, 100 model is required" (meeting L65).

**ROI per flat-lay-only product.** About 0.80 USD (A) turns a product that cannot list on Styli or Centrepoint
into one with a full on-model set, but the two volume estimates differ by a factor of more than thirty (A) until
initiative 1 counts it.

| Line | Arithmetic | Value |
|---|---|---|
| Cost per flat-lay-only product | 4 generated shots x 0.20 | about 0.80 USD (A, S12 L63-64) |
| Volume, business case | 7.5 Vero Moda options x 4 | 30 photos a year (A, BC-A L412) |
| Volume, audit share | 1,684 x 11/66 | about 280 options a year (A, audit L117) |
| Yearly spend | 30 x 0.20, or 280 x 0.80 | about 6 to 224 USD (A) |
| Judged revenue | | 7.3k USD a year (J, BC-A L521) |
| Face-model licence | | not yet in any business case |

### Initiative 6. Already live, on request

**What Naaz sees.** A Home "Products already live" card; she picks live products and gets the same shot-set or
scene run. A scene is retired when a real lifestyle photo arrives. Never bulk, never automatic.

- **Builds:** spec 12 10.4, spec 13 9.4 and the 7 retirement rule. Mostly operational; small code in K and H.
- **Dependencies:** initiatives 2-4 automatic in the cells a request touches; a pull-back path for generated
  images (BC-A L630) before any request over about 50 products (J); the owner's "inflow first, no backfill" stands.
- **Prototype lit:** product page "Upload photos" for a live product. Test guide E31.

**ROI.** A budgeted option, not a yearly line: listing the unlisted options is a merchandising act outside both specs.

| Line | Value |
|---|---|
| Apparel, every eligible live option | 336-536 images, 67-107 USD once (A, BC-A L496-502) |
| Scenes, every eligible live style-colour | 807 images, 161.40 USD once (A, BC-B L322) |
| Options without a Styli / Centrepoint code | 966 / 692 (M, INV L198) |

## 2. Cumulative value curve (base case, USD a year)

| After | Yearly spend | Agency spend avoided | Judged revenue, base | Share of 90.3k | Share of 108.2k |
|---|---|---|---|---|---|
| 1 See the gaps | ~7-20 | 0 | 0 | 0% | 0% |
| 2 Crops | ~7-20 | 4.8k-7.7k | 32.5k | 36% | 30% |
| 3 Made photos, mode A | ~50-60 | 6.0k-9.7k | 41.1k | 46% | 38% |
| 4 Scene images | ~170-220 | 10.8k-17.3k | 83.0k (100.9k if any scene counts) | 92% | 93% |
| 5 Faces and mode B | ~175-230 (~395-445 at audit share) | 10.8k-17.4k | 90.3k (108.2k) | 100% | 100% |
| 6 On request | +230-270 once | not claimed | not claimed | | |

All spend is A, all agency figures M quote with J applicability, all revenue J. After initiative 3 the agency figure
is every option missing a shot, 1,015 x 5.95-9.52 (BC-A L306). Initiative 5 adds 7.5 mode B options x 5.95-9.52
(about 0.04k-0.07k; 1.7k-2.7k at the audit share). The base total of 90.3k is spec 12's 48.4k (BC-A L522) plus
spec 13's 41.9k (BC-B L370-372), the figure that matches spec 13's scope; 108.2k uses spec 13's 59.8k (BC-B L364).
Check calls on crops are not costed in either business case and are left out.

**Plain reading.** Yearly spend stays in the low hundreds of dollars through initiative 5. About nine tenths of
the judged value is on the table after initiative 4, whichever scene figure is used. The order puts the zero-spend,
zero-legal-risk work first, and the two biggest jumps come from crops (initiative 2) and scenes (initiative 4).

## 3. History scenarios and what closes them

The rows marked NOT addressed are here so nobody is oversold.

| Scenario (source) | Closed by |
|---|---|
| US Polo apparel arrives with 3 images, needs 5 (meeting L117) | 2 + 3 |
| 65 of 66 apparel lack the five-shot set (audit L20) | 2 + 3 |
| Head cuts live, 15 of 64 on-model (audit L22, L144) | 2 |
| Cardio Bunny one photo per colour, fails every minimum (audit L100) | 5, only if the photo is a usable flat lay |
| Only / Anta single flat packshot (audit L98, L101) | 5 for the model shot; Anta's 800 px size NOT addressed |
| Penti 3 or fewer images, 4 of 15 (audit L95) | 2 + 3 |
| VogaCloset minimum 4 failing 21 of 141 (audit L171) | 2 + 3 for apparel; footwear partial (a scene adds one image) |
| Shein minimum 2 failing 12 of 141 (audit L172) | 2 |
| Noon rejects a cut main image, 6 of 141 (audit L161) | 1 detects, 2 replaces |
| Footwear lifestyle missing "99%" (meeting L143) | 4 |
| US Polo 19 of 20 pages with no scene (S13 L24) | 4, subject to written rights |
| Vero Moda bags with 1-2 images (BC-B L290) | 4 partial (still under VogaCloset's 4) |
| Naaz's chat-tool images, 5-6 a day, unchecked (meeting L166) | 3 + 4 |
| Styli small-source skips, 20 of 201 at 1000 px (note 1) | NOT addressed; crops of small sources are smaller |
| Lingerie refusals by the judge (note 2) | NOT addressed; may be worse on Penti (615 options, INV L16) |
| Multipack and size-chart false holds, 30% at gate 2 (note 3) | partial, via role labels in 1 |
| 966 apparel options with no Styli code (INV L198) | NOT addressed; listing them is a merchandising act |

Notes: (1) styli-no-enlargement-cap L9-10; (2) live-judge-rate-limits-and-refusals L4-8; (3) go-live-retrospective
L27. All counts in this table are M.

## 4. The five numbers the story leans on, and what firms each one up

1. **0.20 USD per accepted generated image (A)** (S12 L62-63; S13 L662). Firmed by the bench bake-off and the
   first test runs (attempts per accepted image; a brand stops above 0.40, S13 L1285).
2. **1,015 options a year missing a shot, 211 for mode A, 30 photos for mode B (A)** (BC-A L409-412), all from a
   66-product sample checked by one reviewer (BC-A L70-71). Firmed by initiative 1 in report mode within its first
   week of batches (the master list holds 1,813 apparel options, 1,454 of them live and stocked; M, INV L24).
3. **A 1% footwear lift worth 59.8k (J)** (BC-B L364). Our own data shows no image-count effect. Only a
   scene-versus-none test on sponsored US Polo pages (click-through) could firm it. It stays judged.
4. **17.8k + 14.7k crop value (J)** (BC-A L518-519). It depends on someone listing the no-code options once the set
   is complete. Firmed by counting options that gain a Styli or Centrepoint code within 90 days of completion.
5. **5.95-9.52 USD agency price "avoided" (M quote, J applicability)** (BC-A L294). Nobody buys this today. The
   honest framing is capacity we would otherwise not have, against Naaz's 5-6 images a day (meeting L166).

**Counter-evidence, stated plainly.**

- Options with 7-8 Trendyol images do not convert better than those with fewer (conversion ratio 0.95, click ratio
  1.05; M, marketing-data L16).
- 71.4% of live stocked options sold nothing in 90 days (M, BC-B L390).
- The "1 in 3" hold rate is 12.8% once weighted by revenue, because US Polo is nearly clean (M, metrics-impact
  L25). So apparel value sits on French Connection and Penti, not on the biggest brand.
- A holdout can detect about a 15% lift, not 3% (A, BC-A L540-541); the footwear case rests on a judged 1% lift
  (BC-B L364). After the test runs, cost, acceptance and review load become measured; revenue stays judged.

## 5. Gate pack (G0-G8)

Owner and outside-party actions. Several depend on people outside the team, so they should start now, in
parallel with the build, not when the initiative that needs them begins. G6, G7 and G8 are not blockers: the
spec has a default for each, and they are listed so the asks go out early.

| Gate | What | Owner | For | Lead time note |
|---|---|---|---|---|
| [ ] G0 | Migration exception typed, own docs PR; one text for both specs (note 1) | Sujan | 1 | Inside the team; first |
| [ ] G1 | Channel rule table approved, assumed rows marked (S12 1.4) | Sujan | 1 | Inside the team |
| [ ] G2 | Cropping approvals A1-A4 (S12 L2383) | Sujan | 2 | Inside the team |
| [ ] G8 | Styli and Centrepoint written position on crops and enlarged images (note 2) | Channels | 2 | Soft; ask now |
| [ ] G3 | A5-A8, bench approvals, vendor no-training positions, reviewers (note 3) | Sujan, vendors | 3 | Outside party |
| [ ] G7 | AI-disclosure rule per marketplace (note 4) | Channels | 3, 4 | Not a blocker; ask now |
| [ ] G4 | Brand written rights incl. lifestyle scope; US Polo first (note 5) | Sujan, brands | 4, 5 | None on record today |
| [ ] G5 | Licensed face model and human-parsing licence (S12 L2470-2472) | Sujan, vendors | 5 | Longest; start day one |
| [ ] G6 | Legal confirmation on biometric and kids data (note 6) | Sujan, legal | 5 go-live | Not a blocker; start day one |

Notes: (1) S12 L155-165. (2) BC-A L623. (3) S12 L2383; vendor positions BC-A L617; test-run reviewers with a
second person for the 20% overlap, S12 L146-147. (4) Amazon synthetic-performer keyword, Noon "only photographs"
(BC-B L384); spec default is the XMP marker on every channel until one asks for more (S12 L2483-2484).
(5) BC-A L618-619; BC-B L378. (6) Recommended before go-live, not a blocker (S12 L2478-2480; S13 L1613-1615);
the kids age band already has a spec default (S12 L2485-2486).

## 6. Rejected alternatives

- **One build per spec.** No operator-visible result for months, and the outside-party gates (G3 vendor
  positions, G4 brand rights, G5 face-model licence) would block the zero-cost crop win.
  The spec already splits the approvals into A1-A4 and A5-A8 (S12 L2383).
- **Still-life scenes first.** Best value per effort on paper (about 800 a year (A), product pixels unchanged), but spec
  13 forbids building on a partial set of spec 12 contracts (S13 L95, L163). **Settled:** the still-life route runs
  as the first test run inside initiative 4 (step 4a).
- **Generation before crops.** Crops cost nothing, need no legal gate, carry about two thirds of spec 12's judged
  value, and train the review loop at no spend.
- **Faces inside initiative 3.** The face-model licence and the legal confirmation on biometric and kids data are
  outside the team's control; putting them in 3 would hold back every non-face made photo.

## 7. Open risks to the order

- Styli's position on crops could make initiative 2's main marketplace value theoretical; 1000 px masters (M) stay
  a floor problem that crops cannot fix (styli-no-enlargement-cap L9-10).
- Fidelity: if most cells never leave review-all, the load shifts to Naaz well beyond the spec's target of 0-3
  answers per 16-product batch (A, S12 L2330).
- No brand written rights exist today; without US Polo's, initiative 4's biggest brand runs as "no permission,
  nothing made".
- A marketplace could refuse generated images after initiatives 3-4 ship; no bulk pull-back path exists yet
  (BC-A L630).
- Three back-to-back test runs (initiatives 2, 3, 4) stack review-all phases on one operator.
- The kids footwear "legs only" reading is still open with the owner (cross-check L115-118); if it means "no child
  pixels at all", kids footwear becomes still-life only.

## Appendix A. For the build team

### Dependency diagram

```
G0, G1 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6
G2 ------------^
G3 -----------------^
G4 ----------------------^----^
G5 ---------------------------^
```

Read: an arrow into a number means that gate must be closed before that initiative starts. G2 points at 2, G3 at
3, G4 at 4 and 5, G5 at 5. G6, G7 and G8 are asked early but are not blockers (Section 5), so their arrows are soft.

### Parallel worktrees and merge order

- **Inside 1:** schema first and alone (workstream A), then roles, flow, sheet and evals in parallel, plus the
  Brand DNA page shell (depends on the schema only).
- **Inside 2:** planner, crop, publish, flow and review shell in parallel, plus spec 13's data layer and the
  `/measure/people` checks (independent of spec 12 beyond the schema).
- **Inside 3:** generator, gate, review fixes and rollout, plus spec 13's routes and render built against the bench
  type contract and merged after spec 12 workstreams E, F and H.
- **Rule:** spec 12's owner of a shared file merges first; spec 13 branches rebase on it.

### Hot files (expect conflicts; one owner at a time)

- Chunk dispatch
- Classify
- Render, publish and links sheet
- The GPU service app
- Wizard step 4
- The attention ("Needs me") card
- The Ops page

## Appendix B. Sources

Worktree root: `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\02-shot-set-and-scene` (WT). Main checkout:
`C:\Users\Sujan Ajay\Desktop\catalog-module` (MAIN).

| Short name | File |
|---|---|
| S12 | WT `docs/specs/12-apparel-shot-set.md` |
| S13 | WT `docs/specs/13-footwear-scene-image.md` |
| BC-A | WT `docs/plans/proposals/2026-10-26-apparel-shot-set/00-business-case.md` |
| INV | WT `docs/plans/proposals/2026-10-26-apparel-shot-set/01-inventory-count.md` |
| BC-B | WT `docs/plans/proposals/2026-10-26-footwear-scene-image/00-business-case.md` |
| PROTO | WT `docs/prototype/shot-set-and-scene-prototype.html` (test guide L1627-1672) |
| SPEC | WT `docs/SPEC.md` |
| cross-check | WT `.runs/2026-10-27-cross-check.md` |
| audit | MAIN `.runs/2026-10-26-image-audit.md` |
| marketing-data | MAIN `.runs/2026-10-26-marketing-data.md` |
| metrics-impact | MAIN `.runs/2026-10-26-metrics-impact.md` |
| meeting | MAIN `meetings_folder/Catalog-Module-Connect-GCC-14e47c7c-2580.md` (21 Oct 2026) |
| operator guide | MAIN `docs/handover/catalog-for-the-operator.md` |
| styli-no-enlargement-cap | MAIN `docs/solutions/styli-no-enlargement-cap.md` |
| live-judge-rate-limits-and-refusals | MAIN `docs/solutions/live-judge-rate-limits-and-refusals.md` |
| go-live-retrospective | MAIN `docs/solutions/go-live-retrospective.md` |

**The business cases predate the 2026-10-27 spec revisions; the spec wins where they disagree.** The four
disagreements:

1. **Reviewers:** the business cases have two raters on every photo (BC-A L334; BC-B L233); the specs have one
   person per photo, a 20% overlap only in the test run, and live automatic with spot checks (S12 L52-56; S13 L522).
2. **Crop exit:** BC-A has 50 approved swaps in a row (BC-A L625); spec 12 has 100 in a row across all brands
   (S12 L1538).
3. **Kids:** BC-A says no child is ever generated (BC-A L133); the specs allow kids with an approved kids reference
   model of the brand, never a synthetic child (S12 L283-287; S13 L49-53).
4. **Scene cap:** BC-B uses 0.76 USD per eligible product (BC-B L234); spec 13 uses 0.81, the 0.76 ladder plus a
   0.05 fix allowance (S13 L681).
