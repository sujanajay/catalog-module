# Shipping plan for the catalog initiatives: nine initiatives

**This file supersedes `2026-10-27-shipping-plan-specs-12-13.md`, which is kept for history.** The old plan
shipped specs 12 and 13 as six initiatives in a fixed order. On 27 Oct Ashish asked for infographics, product
facts with per-channel words, and filled listing files (Oct27 L42-102), and on 28 Oct Sujan decided four things:
scene images only for products someone selects, infographic text drawn by code, the head-cut reading of the
garbled Hindi stretch as "low priority, need basis", and docs in two PRs. Three new specs (18, 19, 20) and
amendments to spec 13 followed. This plan adds initiatives 7, 8 and 9, carries 1 to 6 forward with those
amendments, and drops the fixed order: Sujan orders the work; only hard dependencies are stated here.

It is a decision document for Sujan and Nitin. **Nothing in this document changes a spec, the prototype, a
business case, SPEC.md or the execution protocol.** Where it and a spec disagree, the spec wins.

How to read the numbers: every figure carries a tag and a source. **M** = measured (counted from data or a bill),
**A** = assumed (a working figure not yet measured), **J** = judged (an estimate built on judgement, often a
revenue lift nobody has tested). Sources look like (S12 s2.4) = spec 12, section 2.4, or (BC-A L292) = the
apparel business case, line 292. Specs are cited by section, never by line, because specs 12 and 13 changed on
28 Oct and specs 18 to 20 are still being edited; re-derive any line by its heading. Appendix B lists the files.
Two shortcuts keep the text readable: a count cited to the audit, the inventory count (INV), a meeting, a
business-case sample or a solutions file is M unless it carries another tag; and a figure in prose that repeats a
tagged table row carries that row's tag.

> **Bottom line**
>
> - **Nine initiatives, no priority order implied.** 1 See the gaps, 2 Crops that complete the set, 3 Made photos
>   from the brand's own model photos, 4 Scene image for selected shoes and bags, 5 Brand faces, flat lay to
>   on-model, kids, 6 Already-live products on request, 7 Infographic images, 8 Product facts from photos and
>   brand data, 9 Listing template files per channel. **Sujan orders them.** Ashish's priority call on 27 Oct was
>   lifestyle (scene) images P1, including a handbag carried by a model, new photos P2, brand faces P3 and
>   infographic last (Oct27 L126-148). The only order this plan imposes is the hard dependencies in Appendix A:
>   1 before everything; 2 before 3; 3 before 4 and 5; 4 before 5; 8 before 9.
> - **Total yearly spend** on paid calls through all nine: about 185-280 USD a year (A), rising to about 405-495
>   USD only if the audit's flat-lay-only share (11 of 66, M) holds for all inflow (A). Initiative 4's part
>   (120-160) is now a ceiling, reached only if every new shoe and bag is ticked for a scene image (S13 s9.3).
>   Initiatives 7 and 9 add no paid call of any kind (S18 s3.8, S20 s10). Initiative 8 adds one judge call per
>   product: 2,500 new products x 0.0004-0.0012 USD = 1-3 USD a year (worst 19.50), plus 9-29 USD a year of
>   weekly evals, so about 10-50 USD a year (A, S19 s8). Initiative 6 adds about 230-270 USD once, only if every
>   eligible live product were requested (A).
> - **About nine tenths of the judged value (92%, J) is on the table after initiatives 1 to 4**, if every eligible
>   shoe and bag is ticked. Initiatives 7 to 9 are valued as agency and designer work avoided, not as revenue,
>   and that value is judged and not counted in USD (Section 2).
> - **What only Sujan can unblock:** G0b (type the approval that adds migrations 0007, 0008 and 0009 to the
>   protocol's granted list, for 7, 8 and 9); G4 (brands' written rights for generated images, with the
>   lifestyle scope, US Polo first); G5 (a commercially licensed face model, start on day one); G9 to G12 (ask
>   the channel managers now for text-on-image rules, listing templates and attribute lists; get brand product
>   sheets; agree the highlights sheet columns with Naaz and Taranum). G9, G10 and G11 wait on people outside
>   the team, so the asks should go out now, before anyone builds 7, 8 or 9.

Words used here (defined once):

- **Report mode:** the system works out which shots each product has and lacks, and says so on the sheet and
  product page, but changes nothing on any listing. **Act mode:** it also fills the gaps.
- **Crop:** a rule-bound cut of the brand's own full-length photo (for example a head-and-shoulders shot), with no
  pixel changed. Costs no paid call.
- **Mode A:** a missing apparel shot is generated from the brand's own model photos of that product.
  **Mode B:** a flat-lay-only product is shown on the brand's own approved model, starting from one approved photo.
- **Fidelity gate:** the automatic checks (G1-G7) that a made photo shows the same product, logos and colour, and
  is modest and correctly framed. A photo that fails is never published; it is "Not made" with a plain reason.
  (These check names G1-G7 are not the gates G0-G12 of Section 5; the text always says "check" or "gate".)
- **Test run:** the internal run in the test area where a person checks every made image ("review-all"). Live
  marketplaces never see it.
- **Cell:** one department x audience group (for example "women's dresses" or "kids sneakers"). A cell goes
  **automatic** (publishes on the checks plus a few spot checks) once it has enough clean labels; this is its
  **exit**. A bad spot check sends it back to review-all (**relapse**).
- **Composite (still life):** the brand's own product photo pasted unchanged into a generated scene, with no person.
- **Scene choice:** the per-product answer to "make a scene image?", `none` by default (S13 s0.2). **Scene kinds
  4a, 4b, 4c:** still life, worn footwear (legs or feet only), carried bag (no face, no head); also the rollout
  order (S13 s9.0).
- **Scene hint:** a value picked from a short fixed list per subcategory (office, street, beach), never typed text.
- **Infographic:** one extra image with the brand's product photo, a text panel and up to three highlights.
  **Highlights sheet:** the business's sheet of products and highlights (S18 s2.1). **Composed:** built by code
  from brand pixels and sheet text, with no image model.
- **Fact:** one attribute of a product (pattern, sleeve length, material) with its value, source, confidence and
  evidence. **Trusted:** an attribute whose photo facts met the owner's precision bar on the labelled set
  (S19 s7.3).
- **Template:** a marketplace's own listing file for one category. **Fill:** one filled copy per batch and
  channel. **Golden fill:** Naaz fills the same file by hand and the two are compared cell by cell (S20 s6.2).
- **Brand DNA:** the admin page holding each brand's logos, brand words, permissions, models, look and (from 7)
  brand voice.
- **Bench:** the ranked list of approved image generators, scored against each other on our own products.
- **Switch:** a setting that turns a feature on or off without new code (for example `SHOT_SET_MODE`).
- **Gate:** an owner or outside-party action that must happen before a step; listed in Section 5.

## 1. The nine initiatives

Shared building blocks (migration 0005, the bench, the fidelity gate, Brand DNA, the eval programme) are built
once, inside the first initiative that cannot run without them. Initiative 7 can build a small Brand DNA shell
itself if initiative 3 has not shipped (S18 s0.4).

| # | Initiative | Spec | Migration | Paid calls | Hard prerequisite |
|---|---|---|---|---|---|
| 1 | See the gaps | 12 | 0005 | judge only | G0, G1 |
| 2 | Crops that complete the set | 12 | (in 0005) | none | 1 |
| 3 | Made photos, mode A | 12 | (in 0005) | image generation | 2 |
| 4 | Scene image for selected shoes and bags | 13 | 0006 | image generation | 2, 3 |
| 5 | Brand faces, flat lay to on-model, kids | 12, 13 | (in 0005, 0006) | image generation | 3, 4 |
| 6 | Already live, on request | 12, 13 | none | as 2-4 | 2-4 automatic in the cells touched |
| 7 | Infographic images | 18 | 0007 | none | 1, G0b (card shell from 2, or G-lite) |
| 8 | Product facts | 19 | 0008 | one judge call per product | 1, G0b |
| 9 | Listing template files | 20 | 0009 | none | 1, 8, G0b, G10 |

Migration numbers follow the protocol's rule: each is numbered after the latest one on `origin/main` at merge
time, so a spec that merges early may take a lower number than its name; the report says which (00 s11).

### Initiative 1. See the gaps (apparel, report mode)

**What Naaz sees.** Every apparel batch's links sheet and product page say, per product and marketplace, which of
the five shots (front model, full length, close-up, back, head-and-shoulders) exist, which are missing, and which
on-model photo has the head cut. Nothing on any listing changes.

- **Builds:** spec 12 section 1 (the whole additive migration `0005_shot_set.sql`; bench and Brand DNA tables
  land empty), 2.1-2.3 (shot roles, head-cut, garment-type ladder), sheet columns from 8.4, shot-type evals, Ops
  panel "Shots each marketplace asks for". Workstreams A, B, H (sheet), K (Products tab), J (role evals).
  Detection stores department, audience and garment length on the product; spec 19 later mirrors them as the
  first facts without writing them back (S19 s0.3), and specs 13, 18 and 20 read them.
- **Switch and rollout:** `SHOT_SET_MODE=report`, the default (S12 s2.4). Live for all brands once the role evals
  pass: at least 95% correct per role on at least 20 photos, kids 100%, head-cut 100% (S12 s2.2).
- **Prototype lit:** Needs me "Questions for you", Products tab status, links sheet shot and "What is missing"
  columns, Ops "Shots each marketplace asks for". Test guide A6, A7, D30, F38.
- **History closed:** the one-reviewer audit (65 of 66 apparel lack the five-shot set, audit L20; head cut 13 of
  66 for Styli and Centrepoint, audit L167; both M) becomes a measured count on every product of every batch.
  Naaz's "we are only having three images ... I would require five images" (Oct21 L117) gets a per-product answer
  before listing. Sujan to Ashish on 27 Oct: "without this as a foundation, whatever you try to do further, it is
  meaningless" (Oct27 L85); Ashish accepted the "input gap plus product analyzer" as required (Oct27 L122-125).
- **Gates before start:** G0 (done in Step 0, PR #111), G1 channel rule table (Section 5).

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
  C, D, H, K, G (swap part), J. The spec names this split itself: cropping alone lets workstreams A to D, H, J, K
  ship with `generate` off (S12 s0.4). The card shell built here is the one initiative 7 reuses.
- **Business priority: low, per Ashish.** On head cuts he said "Not a huge problem. I mean it's a need basis kind
  of issue" and "French Connection is not a Focus brand right now" (Oct27 L106). His framing as a Styli and
  Centrepoint 1:1 dimension issue (Oct27 L104) sits in a garbled Hindi stretch and is unverified (Sujan's
  decision 1, 2026-10-28); the channel table has Centrepoint 1:1 and Styli 2:3. Crops still fill the fourth and
  fifth image Ashish ranked P2 (Oct27 L136) at no cost, which is why the initiative stays.
- **Switch and rollout:** `SHOT_SET_MODE=act`, generate off. Deployed off -> internal all-brand test run (every
  swap answered) -> live -> automatic after 100 approved swaps in a row across all brands (S12 s7.4); then 1 in 20
  products with swaps gets a spot check (S12 s7.5). No crop is ever cut from a photo of a child (S12 s4).
  Head-cut swap rows stay per-channel data, so Sujan can switch a channel off without a deploy.
- **Prototype lit:** Extra shots card at 0 USD, Needs me spot checks (keys Y N J K), spot card "All good /
  Something is wrong / Replace photo n", product page "Upload photos" and "Show how this product was worked out",
  Ops "Photo swaps" with Pause. Test guide A1, A3, A4, A5, A8, B10, B18, B20, D29.
- **History closed:** head cuts live unchanged (15 of 64 on-model products, audit L22; "about 9 in 10 live
  listings carry the brand photos as received", audit L148); Sujan's "if the input image is having like a cut ...
  we are not able to solve it" (Oct21 L109); the operator guide line "The tool never crops" retires (operator
  guide L93); Shein minimum of 2 failing 12 of 141 (audit L172); part of VogaCloset minimum of 4 failing 21 of
  141 (audit L171); head-and-shoulders missing on 57 of 66 (audit L120).
- **Gates:** G2 cropping approvals A1-A4 (S12 s13); test-run reviewers named, with a second person for the 20%
  overlap (S12 s0.4, s10.1); G8 Styli and Centrepoint written position on crops (soft: crop rows per channel are
  data the owner can switch off).

**ROI per new apparel option.** Crops cost nothing, and they carry about two thirds of spec 12's whole judged
value (J), so this is the cheapest value in the programme, whatever its place in Sujan's order.

| Line | Arithmetic | Value |
|---|---|---|
| Crop cost | | 0 USD (M, S12 s4) |
| Crops a year | 1,520 / 1,684 | about 0.9 per new option (A, BC-A L410) |
| Options crops alone complete | 1,015 missing - 211 needing a made shot | about 800 a year (A, BC-A L409, L411) |
| Agency spend avoided | 800 x 5.95-9.52 USD | 4.8k-7.7k USD a year (M quote, J applicability, BC-A L294) |
| Judged revenue | 17.8k conversion + 14.7k Styli/Centrepoint sets | 32.5k USD a year (J, BC-A L518-519) |
| Share of spec 12 base | 32.5k / 48.4k | about two thirds (J, BC-A L522) |

### Initiative 3. Made photos, mode A (apparel generation from the brand's own model photos)

**What Naaz sees.** A missing adult apparel shot that no crop can fill is generated from the brand's own photos,
checked by the fidelity gate, shown on the spot card, fixable with "Fix and try again", and published with a hidden
"AI-made" tag and a sheet column. Step 4 shows "About X USD, never more than <cap>".

- **Builds:** spec 12 1.5 bench, 5 generator (one interface, AI tag, caps, standing bake-off), 6 checks G1-G4,
  G6, G7 and OCR (G5 face identity by two judges only until initiative 5), 7 review in full including 7.6 fixes
  and per-cell exit, 9.2/9.6/9.7 Brand DNA shell with Logos, Brand words and Brand permissions (no Models tab, no
  mode B, no kids), 11.5 nightly evals, 11.6 Phase 0 signals, 12 scorecard. Workstreams E, F, G, I (shell), J, K.
  If initiative 7 shipped first with its I-lite shell, this initiative adds its tabs to that same page.
- **Shared foundation for spec 13 is built here once:** bench with scene uses, caps check with an optional cap,
  AI-tag helper, check framework, fix panel, eval programme, judge "pair" view (S12 s13). Spec 13 stops if any of
  these is missing on main (S13 s0.3).
- **Switches and rollout:** `generate_enabled` per brand, per-engine bench approval, cap = estimate x 1.5 rounded
  up, at least 1 USD, plus a fix allowance (S12 s1.5), hosted services off. Deployed off -> Vero Moda technical
  test -> all-brand test run -> scorecard -> owner yes -> live -> automatic per cell (at least 300 labels over at
  least 3 brands, false passes at most 2%, S12 s7.4). Face-showing roles stay checked by a person until a licensed
  face model exists (S12 s0.4); back, fabric and close-up roles can go automatic.
- **Prototype lit:** full spot card, Fix panel with reasons and round history, AI-made column, More options
  "Do not make new photos", Brand DNA Logos and Brand words, Brand permissions, Ops "Made photos" with Pause and
  "Test run labels per cell". Test guide A2, A9, B11, B12, B13, B14, B16, B17, B19, B21, F32, F36.
- **History closed:** front-model and back gaps crops cannot fill (25 and 19 of 66, audit L120); Ashish's "we
  want the fourth and fifth image just to make sure that we go live on styling and center point" (Oct27 L136) and
  "This is a problem" (Oct27 L110); Naaz's unchecked chat-tool images ("five images to six images per day",
  Oct21 L166) replaced for apparel by a checked, tagged, capped flow; redrawn prints (7 of 7 trials, BC-A L210)
  caught by G2 and OCR; provider refusals on lingerie become "Not made" with a plain reason, not a silent hold.
- **Gates:** G3 generation approvals A5-A8 (S12 s13) and the SPEC rule "No paid image API without a separate
  owner yes" (SPEC L53-54); vendor no-training positions (BC-A L617). G7 channel AI-disclosure rules: ask now,
  not a blocker; the spec's default is the XMP marker on every channel until one asks for more (S12 s13).

**ROI per new apparel option.** About one new option in eight (A) needs a made shot, at about 0.20 USD each (A),
so the whole year costs about the price of four to seven agency jobs (A).

| Line | Arithmetic | Value |
|---|---|---|
| Cost per accepted shot | about 2 attempts | 0.20 USD (A, S12 s0.1); worst 0.34 (A, S12 s5.2) |
| Shots a year | 211 / 1,684 | about 1 in 8 options (A, BC-A L411) |
| Yearly spend | 211 x 0.20 | about 42 USD (A); about 0.025 USD averaged over all inflow (A) |
| Agency spend avoided | 211 x 5.95-9.52 | 1.3k-2.0k USD a year (M quote, J applicability) |
| Judged revenue | | 8.6k USD a year (J, BC-A L520) |

BC-A L422 gives 1.3k-2.1k for the generated part because it adds the 7.5 mode B options.

### Initiative 4. Scene image for selected shoes and bags (spec 13, no faces)

**What Naaz sees.** On step 4, a "Scene images" card with a tick list of the batch's shoes and bags: a tick box,
a scene hint select, "Worn or carried / Still life" per row, "Tick all" and "Untick all". **Nothing is ticked by
default** (Sujan's decision 2, 2026-10-28). Each ticked product leaves the batch with one scene image, placed last,
never image 1. A `scene` column (yes, still_life, no) and an optional `scene_hint` column in the links sheet or
product list tick products too, and the product page has "Make a scene image". The scene spot card shows the core
box and the per-marketplace crop lines; Brand DNA gains Scenes (with "Scene hints per type" and "How it is
carried") and Kids look; Ops gains "Scene worn", "Scene still life" and "Scene images, bags carried".

- **Builds:** spec 13 workstreams A-F in full, migration `0006_scene.sql`, with the spec's defaults: no face for
  any audience in 4c, kids shown legs or feet only (S13 s0.1). Face routing waits for initiative 5. Amended on
  28 Oct: per-product scene choice, default `none` (S13 s1.3, s2.1, s2.5, s9.0); the per-batch choice becomes the
  tick list's default (`tickDefault`); the brand's `lifestyle_scope` stays the ceiling (S13 s1.2); carried bag as
  scene kind 4c with its own checks S5a to S5d, its own spot-check reason and a per-brand exit cell "bags carried"
  (S13 s5.8, s8.2); scene hints per subcategory as a fixed list with brand-approved subsets (S13 s1.1, s1.6).
- **Dependencies:** initiatives 2 and 3 merged; spec 13 needs spec 12 merged and its contracts on main (S13
  s0.5, s11.1). Spec 13's own migration is covered by the G0 text (granted in protocol s11).
- **Switches and rollout:** `SCENE_ENABLED` off at deploy; switching it on makes nothing by default (S13 s9.0).
  `SCENE_KINDS` names the live kinds: unset means `4a`, then `4a,4b`, then `4a,4b,4c`; a product whose kind is
  not live is lowered to a still life; each step is Sujan's word, after the previous kind's test-run cells are
  recorded (S13 s9.0). So 4a still life goes live first (composite: product pixels pasted back unchanged, checks
  G1-G4 skipped by construction, S13 s5.6), then 4b worn footwear, then 4c carried bags. Per-brand
  `lifestyle_scope` none / still_life / worn_or_carried stages go-live by data (S13 s1.2); cap 0.81 USD per ticked
  product (S13 s3.6); stop rules (S13 s9.5). Deployed off -> all-brand test run that ticks every sampled product
  explicitly, US Polo as technical test (S13 s9.1) -> live per brand -> automatic per cell (at least 150 labels
  over at least 3 brands for worn, at least 10 per cell and 30 for kids cells; still life exits on its own 20,
  S13 s8.2). Kids spot checks 1 in 4 (S13 s8.2).
- **Prototype screens to change** (S13 s12.3 Q19-Q21; the HTML is not yet edited): step 4 card gets the tick list
  and "Products you do not tick get no scene image."; More options becomes "Only the products I tick / Every
  product that can have one / A still life for every product that can have one"; "Check what we found" shows the
  `scene` and `scene_hint` columns; product page "Make a scene image" and "Scene image: not asked for"; carried-bag
  spot card with the ninth reason; Scenes tab hints and carrying; Ops "bags carried". Test guide C22, C23, C25,
  E31, F34 change; new items for "tick nothing", a `scene` sheet column and a carried-bag spot check. Already lit:
  Scene images card shell, scene spot card with scene reasons, Kids look tab, scene scope on Brand permissions,
  Ops scene cards. Test guide C28 (Campus with no permission) unchanged.
- **History closed:** Ashish: "this will be the lifestyle image for a footwear where I just want the feet, no face
  required" (Oct27 L40); "handbags is one we want to be solved asap" (Oct27 L114); "if it is a handbag lifestyle
  photo ... I have only handbag. So you will be able to generate a model", "Model holding the bag", "Then it's P1"
  (Oct27 L142-144). Naaz on footwear lifestyle: "Generally it is not there. 99%" (Oct21 L143); US Polo 19 of 20
  and Keds 7 of 7 sampled pages with no scene (S13 s0.1); 55,280 USD (M) of US Polo ads landing on packshot-only
  pages (BC-B L16); Naaz's hand-made scene images (BC-B L50-51); Vero Moda bags with 1-2 images (7 of 8, BC-B
  L290) gain one more.
- **Gates:** G4 brand written rights with lifestyle scope (none on record today; US Polo unconfirmed, BC-B L378);
  per-brand profile approval, including the brand's approved hints; the 150-label exit bar, still the writer's
  proposal and not an owner decision (cross-check L124).

**ROI per ticked style-colour.** About 0.20 USD (A) buys one scene image, against a judged 52-75 USD a year of
revenue per style-colour (J): the largest single judged value in the programme for at most 120-160 USD of yearly
spend (A). Both figures assume every eligible style-colour is ticked; the measured share ticked (Ops, S13 s11.2)
scales spend and value alike.

| Line | Arithmetic | Value |
|---|---|---|
| Cost per attempt | | 0.1032 USD (M, S13 s3.6) |
| Cost per accepted image | still life / worn | about 0.15 (A, midpoint) / 0.20 (A, S13 s3.6) |
| Scene cap | ladder 0.76 + fix 0.05 | 0.81 USD per ticked product (S13 s3.6, s12.4) |
| Style-colours a year | 398 in six months, doubled | about 800 (M base, A doubling, S13 s0.1, s9.3) |
| Yearly spend, ceiling | 800 x 0.15-0.20 | about 120-160 USD (A; 160 at S13 s9.3); 608 at the 0.76 ladder cap (A) |
| Agency spend avoided | 800 x 5.95-9.52 | 4.8k-7.6k USD a year (M quote, J applicability, BC-B L213, L337) |
| Judged revenue | at a 1% lift | 41.9k (still life counts) to 59.8k (any scene) USD a year (J, BC-B L364, L370) |
| Per style-colour | 41.9k-59.8k / 800 | about 52-75 USD a year (J) |

### Initiative 5. Brand faces: own model, flat lay to on-model, kids

**What Naaz sees.** Flat-lay-only brands (Cardio Bunny, Only, Anta) get the garment on the brand's own approved
model from one anchor photo (mode B); face-showing roles can go automatic; kids apparel and kids or registered-adult
faces in shoe scenes become possible; Brand DNA gains the Models tab (Women / Men / Kids), the harvester and Delete.
Carried bags (4c) stay faceless whatever this initiative adds (S13 s12.3 Q20).

- **Builds:** spec 12 section 9 in full (harvester, measured face identity G5, biometric handling, delete), mode B
  rows in sections 3 and 5, mode A on a kids model (S12 s13); spec 13 face routing (person per audience, G5/G6 on
  scenes, registered-face and kids-face cells).
- **Dependencies:** initiatives 3 and 4.
- **Gates:** G5 a commercially licensed face-embedding model (the library named earlier, InsightFace, publishes
  its recognition weights for non-commercial use only, S12 s9.4) and a human-parsing model licence (S12 s13); one
  approved reference model per brand, gender and audience (S12 s0.4); likeness rights. G6, the legal confirmation
  on biometric and kids data, is recommended before go-live, not a blocker (S12 s9.5; S13 s12.3 Q13); the kids
  age band already has a spec default (S12 s13). This initiative carries the face-licence gate and the legal
  confirmation, which is why it depends on 3 and 4. Both should start on day one.
- **Prototype lit:** Models tab, anchor approval, Look tab, Kids look models, Delete. Test guide B15, F33, F34, F35.
- **History closed:** Cardio Bunny sends one 3000x4500 photo per colour and fails every minimum (5 of 5, audit
  L100); Only 3 of 4 apparel a single flat packshot (audit L98); Anta flat-only apparel (audit L101); 11 of 66
  apparel with no model photo at all (audit L117); Naaz: "for garments, 100 model is required" (Oct21 L65).
  Ashish ranked it third and named it: "the third one is brand face. It's not own model" (Oct27 L138), and listed
  "flat lace lifestyle photo and new image generation" as the three needed now (Oct27 L120).

**ROI per flat-lay-only product.** About 0.80 USD (A) turns a product that cannot list on Styli or Centrepoint
into one with a full on-model set, but the two volume estimates differ by a factor of more than thirty (A) until
initiative 1 counts it.

| Line | Arithmetic | Value |
|---|---|---|
| Cost per flat-lay-only product | 4 generated shots x 0.20 | about 0.80 USD (A, S12 s0.1) |
| Volume, business case | 7.5 Vero Moda options x 4 | 30 photos a year (A, BC-A L412) |
| Volume, audit share | 1,684 x 11/66 | about 280 options a year (A, audit L117) |
| Yearly spend | 30 x 0.20, or 280 x 0.80 | about 6 to 224 USD (A) |
| Judged revenue | | 7.3k USD a year (J, BC-A L521) |
| Face-model licence | | not yet in any business case |

### Initiative 6. Already live, on request

**What Naaz sees.** A Home "Products already live" card and the product page buttons ("Upload photos", "Make a
scene image"); she picks live products one by one, or sends a links sheet or product list that names them (with
the `scene` column for scenes), and gets the same shot-set or scene run. A scene is retired when a real lifestyle
photo arrives. Never bulk, never automatic.

- **Builds:** spec 12 10.4, spec 13 9.4 and the 7.6 retirement rule. Mostly operational; small code in K and H.
  **Shared with initiative 7:** a batch that brings no new photo for a live product must carry the product's
  current sources into the batch, or the publish step deletes its live images. Spec 18 builds this as
  `infographic/carry.ts` and says initiative 6 shares it (S18 s2.4). Whichever of 6 and 7 ships first builds the
  carry function; the other reuses it. This sheet-driven request path is the input path of 7, which is why 6
  matters more than its own ROI suggests.
- **Dependencies:** initiatives 2-4 automatic in the cells a request touches; a pull-back path for generated
  images (BC-A L630) before any request over about 50 products (J); the owner's "inflow first, no backfill" stands.
- **Prototype lit:** product page "Upload photos" for a live product. Test guide E31 (gains the "Make a scene
  image" path, S13 s12.3).

**ROI.** A budgeted option, not a yearly line: listing the unlisted options is a merchandising act outside the
specs.

| Line | Value |
|---|---|
| Apparel, every eligible live option | 336-536 images, 67-107 USD once (A, BC-A L496-502) |
| Scenes, every eligible live style-colour | 807 images, 161.40 USD once (A, BC-B L322); a ceiling, only ticked ones are made |
| Facts, every live option re-read on request | 3,749 options x 0.0012 = about 4.50 USD once, worst 29.24 (A, S19 s8) |
| Options without a Styli / Centrepoint code | 966 / 692 (M, INV L198) |

### Initiative 7. Infographic images (spec 18)

**What Naaz sees.** The business sends a highlights sheet for the live products it picked by stock and visits:
identifier, optional image link, `highlight_1` to `highlight_3` (at most 40 characters each), optional layout and
channels. Step 2 says "read as highlights sheet" and lists every row left out with a sentence the business can act
on. Step 4 has one "Infographics" card with no input. Each product gets one extra image: its own product photo, a
text panel in the brand's colours and font, up to three highlights exactly as typed, the logo where the channel
allows it. It sits last, never image 1. The links sheet has a "<Channel> infographic" column; the product page has
an Infographic section; the spot card has an infographic variant with layout reasons and "Try another layout";
Brand DNA gains a "Brand voice" tab (keyword family, colours, font, logo placement, default layout).

- **Builds V1:** spec 18 workstreams A data and policy, B intake, C compose, D checks T1 to T9, E publish and
  sheet, F operator flow and review, H evals and Ops; I-lite (a Brand DNA shell with Logos and Brand voice only)
  if initiative 3 is not merged; G-lite (spec 12's card shell, nothing of 7.6) only if Sujan types yes and
  initiative 2 is not merged (S18 s0.4, s0.6). Migration `0007_infographic.sql`: highlight rows, infographics,
  brand voice, six new channel policy columns with seeds, a forbidden-words table (S18 s1).
- **The rules that matter** (S18 s0.1): text is composed by code (SVG through resvg-js and sharp, shipped fonts),
  never drawn by an image model (Sujan's decision 3, 2026-10-28); every word comes from the sheet, byte for byte,
  checked for length, price and forbidden words; no person in the base photo, so Amazon's synthetic-performer
  tag does not apply and kids products are allowed; the product mask is never covered, proved by code on every
  image; Noon and Namshi get a plain text band over the unchanged photo, no logo; a highlights batch carries the
  products' current photos unchanged and makes nothing else new, so zero paid calls.
- **V2** (S18 s10, specified, not built): callout pointers to detected parts (sole, upper, lining, strap, collar);
  lifestyle plus infographic on a spec 13 scene frame; an Arabic variant; product-page pick of base photo and
  layout; highlight suggestions from spec 19 facts (never auto-published); an optional generated background
  behind the band; infographics on new inflow when the brand's sheet carries highlights; on-model base photos for
  apparel.
- **Switches and rollout:** `INFOGRAPHIC_ENABLED` unset at deploy (a highlights sheet is detected but not used);
  per brand an approved, enabled Brand voice; per channel the `text_on_image` row (`not_allowed` stops a channel
  the same day, no deploy) (S18 s8.1). Test run on one brand Sujan picks, about 50 live products, every image
  labelled by one person; acceptance: T1, T2, T3 on 100%, zero "covers" answers, at most 10% "Try another
  layout", compose p95 under 3 s (S18 s8.2). Live per brand: "Checked by a person" until 50 clean in a row, then
  1 in 20 (S18 s6.4). Sheets over 200 rows split by the operator (S18 s8.3).
- **Prototype screens to add** (S18 s12.3; prototype v2 has none): step 2 "read as highlights sheet" and the
  rejected-row list; step 4 "Infographics" card with Details; the infographic spot card; Products tab statuses;
  product page Infographic section; Brand DNA "Brand voice" tab with the contrast line and preview; links sheet
  preview with "<Channel> infographic"; Ops "Infographics" block.
- **History closed:** Ashish: "Infographic is basically talking about the features" (Oct27 L42); "every shoe will
  have a different infographic criteria. For example, campus would have more of sports running ... U.S. polo will
  be more on lifestyle keywords" (Oct27 L50); "all the SKUs will not have infographic images" (Oct27 L55); "There
  will be parameter 1, parameter 2, parameter 3 ... highlight one, highlight two, highlight three" (Oct27 L57);
  "how do you want to take output?" (Oct27 L59), answered by the links sheet column and the product page; "I
  don't want to write a paragraph onto it" (Oct27 L63), answered by the 40-character rule. The audit: 15 of 141
  live products already carry brand-made infographics (audit L24, L115); a generated Cardio Bunny infographic is
  live with its text clipped ("MOVEMEI", audit L195), the case check T1 is built to catch; a US Polo infographic
  is a 600x800 padded image in a 1600x1600 set (audit L200). Sujan's own worry: "if you just give AI to generate,
  it'll generate some random things. It'll be incorrect" (Oct27 L54).
- **Gates:** G0b (0007 on the granted list; spec 18 is blocked until then), initiative 1 merged, G12 highlights
  sheet columns agreed with Naaz and Taranum, G9 text-on-image rows approved as data with assumed rows marked
  (soft), test-run brand and its sheet, font licences on file (S18 s0.4). Sujan's open questions with defaults:
  S18 s12.2 Q1 to Q16 (the Trendyol row, Amazon slot 7, scene versus infographic at a cap, G-lite, fonts, the
  logo amendment to spec 12 s9.6, on-model-only apparel, contrast floor, new products via a link).

**ROI per product picked.** Almost free to run. Value is designer or agency infographic work avoided and pages
completed for products the business has chosen; nobody has measured either.

| Line | Arithmetic | Value |
|---|---|---|
| Platform cost per channel image | 1.5 s vCPU x (0.000024 + 2 x 0.0000025) | about 0.00004 USD (A, S18 s3.8) |
| Per product, four channels | 4 x 0.00004 | about 0.0002 USD (A) |
| Per 1,000 products | | about 0.2 USD (A) |
| Paid calls | | none (S18 s0.1 rule 1, s11.1 item 15) |
| Products a year | picked by the business by stock and visits (Oct27 L55) | not known; no volume assumed |
| Review load | one person per image until 50 clean in a row per brand, then 1 in 20 | (S18 s6.4) |
| Agency or designer work avoided | | not quantified (J); 15 of 141 live products show the business buys or makes them today (audit L24) |
| Judged revenue | | not claimed |

### Initiative 8. Product facts from photos and brand data (spec 19)

**What Naaz sees.** The product page gains a "Facts" section: one line per attribute, grouped "From the photos"
and "From the brand", each with its source in words ("Seen in photo 2", "From the brand sheet, row 14"), a
"Check" pill while that attribute is not yet trusted, and "Confirm" and "Correct". "Unknown" is a valid answer.
The links sheet gains a "Facts" worksheet (and CSV); the brand page gains "Add brand product sheet"; Ops gains
"Facts coverage per brand".

- **Builds V1:** spec 19 workstreams A data and vocabulary, B extraction, C brand data, D resolve and export, E
  operator and admin UI, F evals and rollout. Migration `0008_product_facts.sql` (six tables, one of them the
  empty V2 mapping table). A canonical vocabulary per department group, versioned, as data, seeded from the India
  playbook with every value marked `seed` (S19 s2); one judge call per product for photo facts plus a code
  measurement of the colour from the cut-out (S19 s3); brand sheets read through the existing adapters for what
  a photo cannot show: material, the brand's exact colour name, care, origin, fit (S19 s4); the contract spec 20
  reads, `readProductFacts` with a `trusted` flag per fact (S19 s6.6).
- **The rule that matters:** the module never invents a fact. A photo fact comes from the photo with its
  evidence; a brand fact comes from the brand's sheet; a model is never asked for a brand fact and brand data is
  never sent to a model. A brand colour name never overrides the measured colour family; both are kept. Kids,
  modesty and every image decision are untouched (S19 s0.1, s3.8).
- **V2** (S19 s9, specified, not built): the per-channel vocabulary registry (channel x category x attribute x
  our value -> channel value), seeded from Amazon product type definitions, Trendyol's attribute values API and
  noon NIS dropdowns; admin upload of a channel's attribute sheet; a brand colour-name dictionary; a "needs
  confirmation" queue. A value is never mapped until it is seen in the channel's own list, so "half sleeve" is
  never auto-mapped (S19 s9.3).
- **Switches and rollout:** `FACTS_ENABLED` unset at deploy. Sujan approves vocabulary version 1; a labelled set
  of at least 200 photos from at least 60 products across every softline brand, labelled blind by two people with
  a third to settle (S19 s7.1); first eval run with both judges, about 0.14 USD; Sujan sets the per-attribute bars
  (proposed 95% for pattern, sleeve, colour family; 90% for neckline and closure, S19 s7.2); attributes that meet
  them become "Trusted". Internal test run per softline brand, then live: facts on every normal batch, no
  backfill. Live corrections over 10% of the last 100 answers send a trusted attribute back to "Check" (S19 s7.5,
  s10).
- **Prototype screens to add:** product page Facts section with Confirm and Correct and the evidence view; the
  links sheet "Facts" worksheet preview; brand page "Add brand product sheet"; Ops "Facts coverage per brand" and
  the vocabulary view. Prototype v2 has none of these.
- **History closed:** Ashish: "every brand has a different like definition of colors ... Campus puts black, Rani
  ... Salmon pink" and "if your model is self serve ... it can fill all the parameters on its own, that will
  better ... But again this is going to be again V2" (Oct27 L88); "Namshi ... can say a T shirt is a half sleeve T
  shirt ... While Noon can say it's a short sleeve T shirt" and "customer decision Tree CDT is different for each
  and every channel" (Oct27 L92-96), which is V2 here. Namshi rejections for "missing fashion attributes,
  incomplete material details" are seller-reported (R28 s3, [3P]).
- **Gates:** G0b (0008 on the granted list; blocked until then), initiative 1 merged, the per-attribute bars,
  vocabulary version 1 approved, labellers named, G11a brand product sheets (soft: without them brand attributes
  stay "Unknown"). V2 only: G11b (Amazon read-only call permission, Trendyol credentials, noon NIS templates,
  other channels' attribute lists) (S19 s0.4). Open questions with defaults: S19 s13.2 Q1 to Q12 (the "Half"
  seed reading, `sku_master_p2p`, ownership with India's catalog service, colour families, the brand page door).

**ROI per new product.** About a tenth of a cent per product. Value is attribute work the agency or Naaz does by
hand today and the input initiative 9 needs; it is not counted in USD.

| Line | Arithmetic | Value |
|---|---|---|
| One product, working / assumed multi-photo / worst | 1 call x 0.0004 / 0.0012; worst 0.0039 + 0.0039 | 0.0004 / 0.0012 / 0.0078 USD (A, S19 s8) |
| New products a year | 1,700 apparel + 800 footwear and bags | 2,500 (A, S19 s8) |
| Yearly spend, new products | 2,500 x 0.0004 / 0.0012 / 0.0078 | 1.00 / 3.00 / 19.50 USD (A) |
| Eval runs a year | 62 runs x 0.14 (worst 0.47) | 8.68 (29.14) USD (A) |
| Total a year | | about 10-50 USD (A) |
| Agency attribute work avoided | | not quantified (J) |
| Judged revenue | | not claimed |

### Initiative 9. Listing template files per channel (spec 20)

**What Naaz sees.** Next to the links sheet, one filled listing file per ticked channel that has an approved
template: the marketplace's own file, one row per product (parent and size rows where the template needs them),
image columns from the published links in that channel's order, identifiers from the masters, attributes from
trusted facts. Every cell the module cannot fill is blank and shaded and listed on a "Needs you" tab. She uploads
the file in the portal herself; the module never sends it. An admin page `/catalog/templates` holds the templates
with their versions and evidence; the batch page has "Make files again" after facts are corrected.

- **Builds V1:** spec 20 workstreams A data and registry, B parsers (noon NIS, Amazon flat file, generic, CSV), C
  fill and validation inside finalize, D admin and operator UI, E evals and docs. Migration
  `0009_listing_templates.sql` (registry, versions, fills, fill issues) (S20 s0.5, s2). Two channels whose templates
  are on record first; expected noon NIS and Namshi Excel, Amazon flat file third if its file arrives (S20 s0.1).
- **The rules that matter** (S20 s0.1): filled, never submitted (no marketplace write API, no portal action);
  no invented value; price, stock, offer, shipping and tax never filled; no AI call; no Arabic text written; a
  fill never fails finalize, so the links sheet stays the main deliverable.
- **V2** (S20 s7): the remaining channels as their templates arrive, each with its own golden fill; Amazon
  product type definitions read only; Trendyol attribute lists from its public API; per-channel character limits
  and a title formula seeded from the India playbook; a diff against the previous fill; Arabic columns noted.
- **Switches and rollout:** no env switch; a channel is filled only when an admin has approved its template, so
  templates are the switch (S20 s3.4). Internal phase on a `catalog-test` re-finalize of one real batch per
  channel; golden fill: Naaz fills the same template for one real batch of at least 20 products, compared cell by
  cell, **zero wrong values allowed**, blanks allowed (S20 s6.2); live per channel after its golden fill; the
  first real portal upload per channel is a checked step (S20 s6.3).
- **Prototype screens to add:** batch page download "Listing files" with the "cells need you" count and "Make
  files again"; the `/catalog/templates` admin page with its four-step add flow; the filled file's "Needs you" tab;
  Ops "Template fills". Prototype v2 has none of these.
- **History closed:** Naaz on the agency's per-style fee: "they are charging for this. All the platforms plus for
  cataloging templates, filling templates" (Oct21 L20); Ashish: "I have data I need to prepare different
  templates" (Oct27 L80) and "Then we will go to probably V3 that you know, output file for Namshi is already
  created with the links ... There is nothing that is required then" (Oct27 L98-100). "Sports/casual is in the
  Namshi catalog sheet" (Oct21 L153-155) is one of the files to obtain.
- **Gates:** G0b (0009 on the granted list), G10 templates on record per V1 channel with Sujan's choice of the two
  channels (hard per channel), spec 19 V1 and initiative 1 merged, Naaz as golden-fill partner (without her the
  spec merges but cannot leave the internal phase) (S20 s0.3). Open questions with defaults: S20 s11.2 Q1 to Q8
  (portals and an extra tab, Amazon `.xlsm`, noon's ".JPEG" wording, sizes from `sku_map`, the seller SKU column,
  who keeps templates current, what Ashish's templates are).

**ROI per batch.** Costs nothing beyond storage. Value is part of the agency's per-style fee, which covers both
images and template filling for all platforms (Oct21 L20); the template share is not known, so it is not counted.

| Line | Arithmetic | Value |
|---|---|---|
| AI and marketplace calls | | none (S20 s10) |
| Platform cost | one ExcelJS load and write per fill inside finalize | seconds of CPU, a few MB a batch (A, S20 s10) |
| Agency fee that includes template filling | per style, all platforms | 5.95-9.52 USD (M quote, BC-A L294; Oct21 L20) |
| Share of that fee for templates | | unknown; not counted (J) |
| Channels covered in V1 | noon and Namshi expected | 2 of 9 (S20 s0.1) |
| Judged revenue | | not claimed |

## 2. Cumulative value curve (base case, USD a year)

Rows follow the initiative numbers, not an order. Spend and value of each row assume its prerequisites are live.

| Initiatives live | Yearly spend | Agency spend avoided | Judged revenue, base | Share of 90.3k | Share of 108.2k |
|---|---|---|---|---|---|
| 1 See the gaps | ~7-20 | 0 | 0 | 0% | 0% |
| + 2 Crops | ~7-20 | 4.8k-7.7k | 32.5k | 36% | 30% |
| + 3 Made photos, mode A | ~50-60 | 6.0k-9.7k | 41.1k | 46% | 38% |
| + 4 Scene images (every eligible ticked) | ~170-220 | 10.8k-17.3k | 83.0k (100.9k if any scene counts) | 92% | 93% |
| + 5 Faces and mode B | ~175-230 (~395-445 at audit share) | 10.8k-17.4k | 90.3k (108.2k) | 100% | 100% |
| + 6 On request | +230-270 once | not claimed | not claimed | | |
| + 7 Infographics | +~0.2 per 1,000 products | designer or agency infographic work, not quantified (J) | not claimed | | |
| + 8 Product facts | +~10-50 | agency attribute work, not quantified (J) | not claimed | | |
| + 9 Listing files | +0 (storage only) | template share of 5.95-9.52 per style (Oct21 L20), not quantified (J) | not claimed | | |
| All nine | ~185-280 (~405-495 at audit share) | 10.8k-17.4k plus the unquantified J lines | 90.3k (108.2k) | 100% | 100% |

All spend is A, all agency figures M quote with J applicability, all revenue J. After initiative 3 the agency figure
is every option missing a shot, 1,015 x 5.95-9.52 (BC-A L306). Initiative 5 adds 7.5 mode B options x 5.95-9.52
(about 0.04k-0.07k; 1.7k-2.7k at the audit share). The base total of 90.3k is spec 12's 48.4k (BC-A L522) plus
spec 13's 41.9k (BC-B L370-372), the figure that matches spec 13's scope; 108.2k uses spec 13's 59.8k (BC-B L364).
Check calls on crops are not costed in either business case and are left out. The agency quote is one price per
style for image work and template filling together (Oct21 L19-21); counting it for initiatives 2 to 5 and again
for 9 would count some of it twice, which is why 7 to 9 add no USD.

**Plain reading.** Yearly spend stays in the low hundreds of dollars with all nine live. Initiative 4's spend and
value both shrink with the share of products ticked, because scene images are now off unless selected. About nine
tenths of the judged value is on the table after 1 to 4, whichever scene figure is used. Initiatives 7, 8 and 9
cost almost nothing to run; they are worth building for the agency and template work they take off Naaz, and for
answering Ashish's three asks, not for a revenue figure. The two biggest judged jumps come from crops (2) and
scenes (4).

## 3. History scenarios and what closes them

The rows marked NOT addressed are here so nobody is oversold.

| Scenario (source) | Closed by |
|---|---|
| US Polo apparel arrives with 3 images, needs 5 (Oct21 L117) | 2 + 3 |
| Fourth and fifth image to go live on Styli and Centrepoint (Oct27 L136) | 2 + 3 |
| 65 of 66 apparel lack the five-shot set (audit L20) | 2 + 3 |
| Head cuts live, 15 of 64 on-model (audit L22, L144) | 2 (low business priority, Oct27 L106) |
| Cardio Bunny one photo per colour, fails every minimum (audit L100) | 5, only if the photo is a usable flat lay |
| Only / Anta single flat packshot (audit L98, L101) | 5 for the model shot; Anta's 800 px size NOT addressed |
| Penti 3 or fewer images, 4 of 15 (audit L95) | 2 + 3 |
| VogaCloset minimum 4 failing 21 of 141 (audit L171) | 2 + 3 for apparel; footwear partial (a scene or an infographic adds one image) |
| Shein minimum 2 failing 12 of 141 (audit L172) | 2 |
| Noon rejects a cut main image, 6 of 141 (audit L161) | 1 detects, 2 replaces |
| Footwear lifestyle missing "99%" (Oct21 L143); feet only, no face (Oct27 L40) | 4, for ticked products |
| Handbag carried by a model, P1 (Oct27 L114, L142-144) | 4 (scene kind 4c, after 4a and 4b) |
| US Polo 19 of 20 pages with no scene (S13 s0.1) | 4, subject to written rights |
| Vero Moda bags with 1-2 images (BC-B L290) | 4 partial (still under VogaCloset's 4) |
| Naaz's chat-tool images, 5-6 a day, unchecked (Oct21 L166) | 3 + 4 |
| Infographics: 15 of 141 live products carry brand-made ones (audit L24, L115) | 7, for products the business picks |
| Cardio Bunny infographic live with clipped text "MOVEMEI" (audit L195) | 7 (check T1 refuses clipped text); the live one stays until someone removes it |
| US Polo 600x800 padded infographic in a 1600x1600 set (audit L200) | 7 partial: a new one is made at channel size; the brand's own stays unless removed |
| Agency paid per style to fill templates on all platforms (Oct21 L20-21) | 9 partial: two channels in V1; Styli, Centrepoint, 6th Street NOT addressed (no template) |
| Namshi rejections for missing fashion attributes and material (R28 s3, [3P]) | 8 for what photos show; material only with brand sheets (G11a); 9 fills the file |
| Brand colour names such as "Rani" and "Salmon pink" (Oct27 L88) | 8 V1 keeps the brand's name from its sheet beside the measured family; dictionary is V2 |
| "Half sleeve" on Namshi vs "short sleeve" on Noon (Oct27 L92-94) | NOT addressed in V1; 8 V2 maps only values seen in each channel's list |
| Styli small-source skips, 20 of 201 at 1000 px (note 1) | NOT addressed; crops of small sources are smaller |
| Lingerie refusals by the judge (note 2) | NOT addressed; may be worse on Penti (615 options, INV L16); 8 treats a refusal as "Unknown" |
| Multipack and size-chart false holds, 30% at gate 2 (note 3) | partial, via role labels in 1 |
| 966 apparel options with no Styli code (INV L198) | NOT addressed; listing them is a merchandising act |

Notes: (1) styli-no-enlargement-cap L9-10; (2) live-judge-rate-limits-and-refusals L4-8; (3) go-live-retrospective
L27. All counts in this table are M; the Namshi rejection row is seller-reported, not counted.

## 4. The seven numbers the story leans on, and what firms each one up

1. **0.20 USD per accepted generated image (A)** (S12 s0.1; S13 s3.6). Firmed by the bench bake-off and the first
   test runs (attempts per accepted image; a brand stops above 0.40, S13 s9.5).
2. **1,015 options a year missing a shot, 211 for mode A, 30 photos for mode B (A)** (BC-A L409-412), all from a
   66-product sample checked by one reviewer (BC-A L70-71). Firmed by initiative 1 in report mode within its first
   week of batches (the master list holds 1,813 apparel options, 1,454 of them live and stocked; M, INV L24).
3. **A 1% footwear lift worth 59.8k (J)** (BC-B L364). Our own data shows no image-count effect. Only a
   scene-versus-none test on sponsored US Polo pages (click-through) could firm it. It stays judged. Since only
   ticked products get a scene, the share ticked (Ops) now scales it.
4. **17.8k + 14.7k crop value (J)** (BC-A L518-519). It depends on someone listing the no-code options once the set
   is complete. Firmed by counting options that gain a Styli or Centrepoint code within 90 days of completion.
5. **5.95-9.52 USD agency price "avoided" (M quote, J applicability)** (BC-A L294). Nobody buys this today. The
   honest framing is capacity we would otherwise not have, against Naaz's 5-6 images a day (Oct21 L166). The same
   price also covers template filling (Oct21 L20), so it cannot be counted for both images and templates.
6. **The facts precision bar (proposed 95% for pattern, sleeve and colour family, 90% for neckline and closure)**
   (S19 s7.2). Nobody has measured how well a judge reads these attributes from our brands' photos. Firmed by the
   first eval run on the labelled set (at least 200 photos, 60 products, every softline brand, two labellers and
   a settler; S19 s7.1). Until an attribute meets its bar it shows "Check" and initiative 9 leaves its cells blank,
   so a low precision lowers 9's coverage, never its correctness.
7. **The template golden fill: zero wrong values (rule, not a measurement)** (S20 s6.2). How many cells the module
   can fill per channel (coverage) is not known for any channel. Firmed by Naaz's hand fill of one real batch of
   at least 20 products per V1 channel, compared cell by cell; the coverage per column becomes the measured value
   of initiative 9.

**Counter-evidence, stated plainly.**

- Options with 7-8 Trendyol images do not convert better than those with fewer (conversion ratio 0.95, click ratio
  1.05; M, marketing-data L16).
- 71.4% of live stocked options sold nothing in 90 days (M, BC-B L390).
- The "1 in 3" hold rate is 12.8% once weighted by revenue, because US Polo is nearly clean (M, metrics-impact
  L25). So apparel value sits on French Connection and Penti, not on the biggest brand, and Ashish said French
  Connection is not a focus brand now (Oct27 L106).
- A holdout can detect about a 15% lift, not 3% (A, BC-A L540-541); the footwear case rests on a judged 1% lift
  (BC-B L364). After the test runs, cost, acceptance and review load become measured; revenue stays judged.
- No source says infographics, facts or filled files lift sales on these channels; their case is time saved and
  Ashish's ask, nothing more.

## 5. Gate pack (G0-G12, plus G0b)

Owner and outside-party actions. Several depend on people outside the team, so they should start now, in
parallel with the build, not when the initiative that needs them begins. **G9, G10 and G11 depend on channel
managers and should be asked now.** G6, G7, G8, G9 and G11a are not blockers: the specs have a default for each,
and they are listed so the asks go out early.

| Gate | What | Owner | For | Lead time note |
|---|---|---|---|---|
| [x] G0 | Migration exception for `0005_shot_set.sql` and `0006_scene.sql` in protocol s11 (note 1) | Sujan | 1, 4 | Done in Step 0, PR #111; merge pending |
| [ ] G0b | Add spec 18 `0007_infographic.sql`, spec 19 `0008_product_facts.sql`, spec 20 `0009_listing_templates.sql` to the granted list (note 2) | Sujan | 7, 8, 9 | Inside the team; one typed line each, own docs PR |
| [ ] G1 | Channel rule table approved, assumed rows marked (S12 s1.4) | Sujan | 1 | Inside the team |
| [ ] G2 | Cropping approvals A1-A4 (S12 s13); test-run reviewers named | Sujan | 2 | Inside the team |
| [ ] G8 | Styli and Centrepoint written position on crops and enlarged images (note 3) | Channels | 2 | Soft; ask now |
| [ ] G3 | A5-A8, bench approvals, vendor no-training positions, reviewers (note 4) | Sujan, vendors | 3 | Outside party |
| [ ] G7 | AI-disclosure rule per marketplace (note 5) | Channels | 3, 4 | Not a blocker; ask now |
| [ ] G4 | Brand written rights incl. lifestyle scope; US Polo first (note 6) | Sujan, brands | 4, 5 | None on record today |
| [ ] G5 | Licensed face model and human-parsing licence (S12 s9.4, s13) | Sujan, vendors | 5 | Longest; start day one |
| [ ] G6 | Legal confirmation on biometric and kids data (note 7) | Sujan, legal | 5 go-live | Not a blocker; start day one |
| [ ] G9 | Text-on-image, slot and logo rows per marketplace approved as data, assumed rows marked; written rules asked from each channel manager (S18 s1.4) | Sujan, channel managers | 7 | Soft: seeds apply; ask now |
| [ ] G10 | Listing templates on record per channel, from the person named in S20 s12; Sujan's choice of the two V1 channels; Naaz as golden-fill partner | Channel managers, Naaz, Sujan | 9 | Hard per channel; ask now |
| [ ] G11a | Brand product sheets with material, care, origin, fit and colour names (Namshi catalog sheet, brand content files) | Brands, Naaz | 8 V1 | Soft: brand facts stay "Unknown" |
| [ ] G11b | Channel attribute lists (noon NIS dropdowns, Namshi, Styli, Centrepoint, 6th Street, Shein); Amazon read-only SP-API permission; Trendyol credentials | Channel managers | 8 V2, 9 V2 | Ask now; V2 waits |
| [ ] G12 | Highlights sheet columns agreed with Naaz and Taranum and typed by Sujan (S18 s2.1) | Sujan, Naaz, Taranum | 7 | Hard; inside the business |

Spec-level owner items that are not gates but are typed in the build prompts (Appendix C): the test-run brand and
its highlights sheet, the font list and G-lite answer (7); vocabulary version 1, the per-attribute bars and the
labellers (8); the "Half" sleeve seed reading (8); the scene exit bar of 150 labels and each `SCENE_KINDS` step (4).

Notes: (1) protocol s11 granted list, owner approval Sujan 2026-10-28; S12 s0.4. (2) S18 s0.4, S19 s0.4, S20
s0.3; each spec is `Blocked:` until its number is on the list; S19 s13.2 Q3 asked whether G11 should be split,
and this plan splits it into G11a (V1) and G11b (V2). (3) BC-A L623. (4) S12 s13; vendor positions BC-A L617;
test-run reviewers with a second person for the 20% overlap, S12 s0.4. (5) Amazon synthetic-performer keyword,
Noon "only photographs" (BC-B L384; R28 s1); spec default is the XMP marker on every channel until one asks for
more (S12 s13). (6) BC-A L618-619; BC-B L378. (7) Recommended before go-live, not a blocker (S12 s9.5; S13 s12.3
Q13); the kids age band already has a spec default (S12 s13).

**Who to ask, now** (R28 "Who to ask inside Opptra"; S20 s12): the Amazon AE/SA channel manager (image page,
clothing style guide, flat files per product type as `.xlsx`, permission for read-only SP-API calls); the noon
channel manager (NIS "With Instructions" templates per fashion family, stance on text bands); the Namshi,
Styli, Centrepoint, 6th Street, VogaCloset and Shein channel or account managers (image spec, line sheet or
template, attribute value lists, stance on text overlays and AI images); Naaz and Ashish (agency-filled files,
Ashish's templates, the Namshi catalog sheet).

## 6. Rejected alternatives

- **One build per spec.** No operator-visible result for months, and the outside-party gates (G3 vendor
  positions, G4 brand rights, G5 face-model licence) would block the zero-cost crop win.
  The spec already splits the approvals into A1-A4 and A5-A8 (S12 s13).
- **Still-life scenes before spec 12's contracts.** Best value per effort on paper (about 800 a year (A), product
  pixels unchanged), but spec 13 forbids building on a partial set of spec 12 contracts (S13 s0.3, s11.1).
  **Settled:** still life is scene kind 4a, the first kind to go live inside initiative 4 (S13 s9.0).
- **Generation before crops.** Crops cost nothing, need no legal gate, carry about two thirds of spec 12's judged
  value, and train the review loop at no spend.
- **Faces inside initiative 3.** The face-model licence and the legal confirmation on biometric and kids data are
  outside the team's control; putting them in 3 would hold back every non-face made photo.
- **The image model draws the infographic text.** Rejected (Sujan, 2026-10-28). The audit shows a generated
  infographic live with clipped text (audit L195); image models still misspell, invent facts and place text badly
  (R28 s4). Text is composed by code; a model may only supply a background, in V2 (S18 s10).
- **Scene images on by default for every eligible product.** Rejected (Sujan, 2026-10-28, decision 2). Ashish
  said lifestyle is made for the products the business selects; a default-on scene would spend and add images
  nobody asked for, and every one becomes a portal re-submission. Default is `none`; `tickDefault` can tick all
  for a batch on purpose (S13 s12.3 Q19).
- **One docs PR for everything.** Rejected (Sujan, 2026-10-28, decision 4). Step 0 (migration renumbering, the
  G0 text, the folder path) shipped alone as PR #111 so initiative 1 is not held behind specs 18 to 20; this
  plan and the three specs follow in the Phase B PR.
- **A listing file the module submits.** Rejected by the specs (S20 s0.1; spec 12's "no portal re-submission").
  Automated push needs its own owner decision and spec.

## 7. Open risks

- Styli's position on crops could make initiative 2's main marketplace value theoretical; 1000 px masters (M) stay
  a floor problem that crops cannot fix (styli-no-enlargement-cap L9-10).
- Fidelity: if most cells never leave review-all, the load shifts to Naaz well beyond the spec's target of 0-3
  answers per 16-product batch (A, S12 s10.3).
- No brand written rights exist today; without US Polo's, initiative 4's biggest brand runs as "no permission,
  nothing made".
- A marketplace could refuse generated images after initiatives 3-4 ship; no bulk pull-back path exists yet
  (BC-A L630). For infographics the module lists live ones per channel and removal from a portal stays manual
  (S18 s8.4 stop rule 4; S18 s12.2 Q16).
- Test runs stack on one operator: crops (2), made photos (3), scenes per kind 4a, 4b, 4c (4), infographics (7,
  every image labelled), the facts labelled set (8, two labellers and a settler) and the golden fills (9, Naaz by
  hand). Sujan's order decides how many overlap.
- The kids footwear "legs only" reading is still open with the owner (cross-check L115-118); if it means "no child
  pixels at all", kids footwear becomes still-life only.
- **Noon "only photographs" rule.** Noon's own page says "Only photographs are permitted, CAD drawings,
  thumbnails, or illustrations are not allowed" and bans "unwanted text" (R28 s1, [DOC]). Spec 18 starts Noon and
  Namshi as a plain text band over the unchanged photo, `assumed_allowed`; if the noon channel manager reads a
  band as an illustration, both channels go `not_allowed` the same day and lose infographics (S18 s1.4, s8.4).
  The same rule makes AI scene images on Noon a question for G7.
- **Templates not obtainable for managed channels.** Styli ("Styli lists, optimizes, and syncs your catalog"),
  Centrepoint and 6th Street publish no seller template (R28 s2; S20 s1). Initiative 9 cannot fill what nobody
  sends; if the key account managers hold no file, those channels stay manual, and Ashish's "nothing that is
  required then" (Oct27 L100) holds only for noon, Namshi and perhaps Amazon.
- **Facts precision below the bar on prints and kids.** Printed and embroidered garments, multipacks, layered
  on-model outfits and kids products are the cells the labelled set expects to fail most (S19 s7.1). If pattern
  or sleeve stays under its bar there, those attributes stay "Check", 9 leaves their cells blank, and Naaz fills
  them by hand as today. Provider refusals on lingerie and swimwear give "Unknown" (S19 s3.6).
- **Spec 17 collision on pipeline files.** Spec 17 (reliable throughput) has merged G1, G2, G3 and G4 (PRs #108,
  #109, #110, #112) and G5 is not started. It touches chunk dispatch, sweep, status, deploy and matting, the same
  files initiatives 1 to 4, 7 and 8 change. Every build rebases on the latest main before its PR; a spec 17
  stream in flight owns its files first.
- **Three new migrations need owner approval.** Specs 18, 19 and 20 are each `Blocked:` until G0b. Numbers are
  assigned at merge time, so if 7 merges before 4, spec 18's migration takes the number after the latest on main
  and the names in this plan shift; the granted list names them by spec to keep the approval valid.
- **Spec contradiction to settle before Phase B ships:** spec 18 s2.4 sets `options.scene.mode = 'off'` for a
  highlights batch, but spec 13 replaced `mode` with `tickDefault` on 28 Oct (S13 s1.3); with scenes off by
  default the intent holds, but the field name must match spec 13.

## Appendix A. For the build team

### Dependency diagram

```
 Step 0 (PR #111): G0 ----+
                  G1 -----+--> 1 See the gaps --+---------------------+----------------------+
                                  |             |                     |                      |
                        G2 ----> 2 Crops        |                     |                      |
                                  |             | (card shell from 2, | G0b, G11a (soft)     |
                        G3 ----> 3 Mode A       |  or G-lite on yes)  v                      |
                                  |  \          v                   8 Facts V1 -----------+  |
                                  |   \       7 Infographics          |                   |  |
                                  |    \        ^  ^                  | G11b              v  v
                        G4 ----> 4 Scenes       |  G0b, G12,          v           G0b, G10 -> 9 Listing files V1
                          (4a -> 4b -> 4c,      |  G9 (soft)        8 V2 (channel words)      |
                           SCENE_KINDS)         |                     |                       v
                                  |             +-- Brand DNA shell:  +-----(optional)----> 9 V2
                        G5 ----> 5 Faces             from 3, or I-lite
                                  ^                  built inside 7
                        G4 -------+

 6 On request: after 2-4 are automatic in the cells a request touches; shares the carry function with 7.
```

Read: an arrow into a number means that gate or initiative must be closed or merged before that initiative
starts. Hard: 1 before everything; 2 before 3; 3 before 4 and 5; 4 before 5; 1 before 7 and 8; 8 before 9.
Soft, with a named fallback: 7 waits for 2's card shell unless Sujan types yes to G-lite; 7 uses 3's Brand DNA
page or builds the I-lite shell itself. G6, G7, G8, G9 and G11a are asked early but are not blockers (Section 5),
so their arrows are soft. Nothing in the diagram is a priority; Sujan picks the next initiative among those whose
arrows are closed.

### Parallel worktrees and merge order

One worktree and feature branch per initiative, under `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\`, builder
sub-branches with `--` (00 execution protocol). Proposed names (the build session confirms them with
`git ls-tree` and the protocol's naming rule):

| # | Worktree | Branch |
|---|---|---|
| 1 | `12-1-see-the-gaps` | `feat/catalog-12-1-see-the-gaps` |
| 2 | `12-2-crops` | `feat/catalog-12-2-crops` |
| 3 | `12-3-mode-a` | `feat/catalog-12-3-mode-a` |
| 4 | `13-footwear-scene-image` | `feat/catalog-13-footwear-scene-image` |
| 5 | `12-5-brand-faces` | `feat/catalog-12-5-brand-faces` |
| 6 | `12-6-on-request` | `feat/catalog-12-6-on-request` |
| 7 | `18-infographic-image` | `feat/catalog-18-infographic-image` |
| 8 | `19-product-facts` | `feat/catalog-19-product-facts` |
| 9 | `20-listing-template-files` | `feat/catalog-20-listing-template-files` |

- **Can run at the same time** once 1 is merged: 2, 8, and 7 (7 with G-lite, or after 2). After 2: 3. After 8: 9.
  Two sessions in parallel is the practical limit for one reviewer of PRs (Sujan merges every PR).
- **Inside 1:** schema first and alone (workstream A), then roles, flow, sheet and evals in parallel, plus the
  Brand DNA page shell (depends on the schema only).
- **Inside 2:** planner, crop, publish, flow and review shell in parallel, plus spec 13's data layer and the
  `/measure/people` checks (independent of spec 12 beyond the schema).
- **Inside 3:** generator, gate, review fixes and rollout, plus spec 13's routes and render built against the bench
  type contract and merged after spec 12 workstreams E, F and H.
- **Inside 7:** A first; B, C and D in parallel against C's contract; E and F after; H last (S18 s0.6).
- **Inside 8:** A first; B and C in parallel; D after their contracts; E and F last (S19 s0.6).
- **Inside 9:** A first; B; C with spec 19's contract; D and E after (S20 s0.5).
- **Rule:** the owner of a shared file merges first; later branches rebase on it. Spec 12's owner goes before spec
  13; specs 12 and 13 before 18; spec 19 before 20.

### Hot files (expect conflicts; one owner at a time)

- Chunk dispatch (`apps/worker/src/catalog/chunk.ts`), also touched by spec 17
- Classify
- Render, publish and report (`render.ts`, `pipeline/publish.ts`, `pipeline/report.ts`)
- The links sheet writer (`sheet.ts`): new columns from 1, 4 and 7, the Facts worksheet from 8, the Details block
  from 9
- Finalize (`apps/worker/src/catalog/finalize.ts`): the Facts worksheet (8) and the template fill (9)
- Sheet detection (`ingest/detect-step.ts`): the `scene` columns (4), the highlights sheet kind (7), brand fact
  columns (8)
- Channel policy (`catalog_channel_policy`, its seed and admin `PUT` route): columns from 12, 13 and 18
- The GPU service app
- Wizard step 2 and step 4
- The attention ("Needs me") card and the spot card variants (2, 3, 4, 7)
- The brand page and the Brand DNA page (3, 4, 5, 7 Brand voice, 8 brand sheet door)
- The product page (1, 2, 4, 7, 8)
- The Ops page

## Appendix B. Sources

Worktree root: `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\02-shot-set-and-scene` (WT). Main checkout:
`C:\Users\Sujan Ajay\Desktop\catalog-module` (MAIN).

| Short name | File |
|---|---|
| S12 | WT `docs/specs/12-apparel-shot-set.md` |
| S13 | WT `docs/specs/13-footwear-scene-image.md` (amended 2026-10-28) |
| S18 | WT `docs/specs/18-infographic-image.md` |
| S19 | WT `docs/specs/19-product-facts-and-channel-vocabulary.md` |
| S20 | WT `docs/specs/20-listing-template-files.md` |
| R28 | WT `docs/plans/proposals/2026-10-28-marketplace-rules-research.md` (sections 1 image rules, 2 templates, 3 vocabularies, 4 approaches) |
| PLAN | `C:\Users\Sujan Ajay\.claude\plans\below-is-one-message-mossy-diffie.md` (approved plan, 2026-10-28) |
| old plan | WT `docs/plans/proposals/2026-10-27-shipping-plan-specs-12-13.md` (superseded) |
| BC-A | WT `docs/plans/proposals/2026-10-26-apparel-shot-set/00-business-case.md` |
| INV | WT `docs/plans/proposals/2026-10-26-apparel-shot-set/01-inventory-count.md` |
| BC-B | WT `docs/plans/proposals/2026-10-26-footwear-scene-image/00-business-case.md` |
| PROTO | WT `docs/prototype/shot-set-and-scene-prototype.html` (test guide at the `SCEN` list) |
| SPEC | WT `docs/SPEC.md` |
| protocol | WT `docs/specs/00-execution-protocol.md` (section 11, granted migrations) |
| cross-check | WT `.runs/2026-10-27-cross-check.md` |
| audit | MAIN `.runs/2026-10-26-image-audit.md` |
| marketing-data | MAIN `.runs/2026-10-26-marketing-data.md` |
| metrics-impact | MAIN `.runs/2026-10-26-metrics-impact.md` |
| Oct21 | MAIN `meetings_folder/Catalog-Module-Connect-GCC-14e47c7c-2580.md` (21 Oct 2026; "meeting" in the old plan) |
| Oct27 | MAIN `Ashish_New_Meeting/Ashish-Sujan-e91cba57-46f1.md` (Ashish and Sujan, 27 Oct 2026; lines 40-149 used) |
| operator guide | MAIN `docs/handover/catalog-for-the-operator.md` |
| styli-no-enlargement-cap | MAIN `docs/solutions/styli-no-enlargement-cap.md` |
| live-judge-rate-limits-and-refusals | MAIN `docs/solutions/live-judge-rate-limits-and-refusals.md` |
| go-live-retrospective | MAIN `docs/solutions/go-live-retrospective.md` |

**The business cases predate the 2026-10-27 and 2026-10-28 spec revisions; the spec wins where they disagree.**
The five disagreements:

1. **Reviewers:** the business cases have two raters on every photo (BC-A L334; BC-B L233); the specs have one
   person per photo, a 20% overlap only in the test run, and live automatic with spot checks (S12 s0.1; S13 s0.3).
2. **Crop exit:** BC-A has 50 approved swaps in a row (BC-A L625); spec 12 has 100 in a row across all brands
   (S12 s7.4).
3. **Kids:** BC-A says no child is ever generated (BC-A L133); the specs allow kids with an approved kids reference
   model of the brand, never a synthetic child (S12 s0.5; S13 s0.1).
4. **Scene cap:** BC-B uses 0.76 USD per eligible product (BC-B L234); spec 13 uses 0.81, the 0.76 ladder plus a
   0.05 fix allowance (S13 s3.6).
5. **Scene volume:** BC-B assumes every eligible style-colour gets a scene; since 2026-10-28 only selected ones do,
   so its spend and revenue are ceilings and the business case applies the measured share ticked (S13 s12.4).

## Appendix C. Paste-ready prompts

How to use: open a fresh Claude Code session in `C:\Users\Sujan Ajay\Desktop\catalog-module` and paste one block.
Fill every `<angle-bracket>` blank first, in your own words; a gate line you leave blank means "not approved",
and the session stops at that gate. Run them in the order you choose, within the dependencies of Appendix A. You
merge every PR yourself.

### Step 0 (done)

Step 0 is PR #111: docs only; migrations renumbered to 0005 (spec 12) and 0006 (spec 13), the protocol section 11
exception (gate G0), the user folder path fixed in AGENTS.md and the protocol. Nothing to paste; merge #111.

### Phase B (this PR)

```text
Ship the docs branch docs/catalog-initiatives-v2 (worktree
C:\Users\Sujan Ajay\Desktop\catalog-module-wt\02-shot-set-and-scene) as one docs-only PR with the ship step.
It holds specs 18, 19 and 20, the 2026-10-28 amendments to specs 12 and 13, the marketplace research,
docs/specs/README.md rows 18-20 and docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md.
Merged first: PR #111 (Step 0).
Follow docs/specs/00-execution-protocol.md, own worktree and feature branch, manager delegates to subagents.
Before shipping: fetch and rebase on origin/main; run ce-doc-review on specs 18, 19 and 20 and fix the
blocking findings; settle the spec contradiction in section 7 of the shipping plan; check for
em dashes, model ids and stale line citations.
Prototype: <update the screens listed in spec 13 section 12.3 and spec 18 section 12.3 in this PR / leave them
for a later docs PR>.
Scope: docs only. Never: change code, migrations or infra; edit the old shipping plan.
Done when: PR open, CI green, no blocking review finding left, the dependency diagram has no cycle.
Ask me before: any change to an owner decision recorded in the specs, any spec number change.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```

### Initiative 1. See the gaps

```text
Execute initiative 1 "See the gaps" from docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md.
It builds docs/specs/12-apparel-shot-set.md section 1 (the whole migration 0005_shot_set.sql; bench and Brand
DNA tables land empty), 2.1 to 2.3, the 8.4 sheet columns, the shot-type evals and the Ops panel "Shots each
marketplace asks for" (workstreams A, B, H sheet, K Products tab, J role evals).
Merged first: PR #111 (Step 0, gate G0) and the Phase B docs PR.
Follow docs/specs/00-execution-protocol.md, own worktree and feature branch, manager delegates to subagents.
My gate approvals:
- G1: I approve the channel rule table in spec 12 section 1.4 as data, assumed rows marked. Changes: <none, or
  channel and value>.
Scope: SHOT_SET_MODE=report only (the default). Detection keeps department, audience and garment length on the
product for specs 13, 18, 19 and 20. Off: crops, generation, scenes, infographics, facts.
Never: change a listing, call a paid image model, show a model id, write to Supabase.
Done when: PR open, CI green, role evals at least 95% per role on at least 20 photos, kids 100%, head cut 100%
(spec 12 section 2.2), and the spec 12 section 12.1 items for these sections ticked in the report.
Ask me before: the first eval run on real photos, any 02 contract change, the deploy.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```

### Initiative 2. Crops that complete the set

```text
Execute initiative 2 "Crops that complete the set" from
docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md. It builds docs/specs/12-apparel-shot-set.md
2.4 operator flow, 3 planner, 4 crop engine, 8 publish (remove and replace), 7.1 to 7.5 card shell, one person per
photo, crop exit, 1-in-20 spot checks, relapse and admin pause; not 7.6 (workstreams C, D, H, K, G swap part, J).
Merged first: initiative 1.
Follow docs/specs/00-execution-protocol.md, own worktree and feature branch, manager delegates to subagents.
My gate approvals:
- G2: I approve cropping approvals A1 to A4 in spec 12 section 13 <as written / with these changes: ...>.
- Test-run reviewers: <name>; second person for the 20% overlap: <name>.
- Channels where head-cut swaps start switched off: <none, or channel list>.
Scope: SHOT_SET_MODE=act with generate off. Business priority is low per Ashish (head cuts "need basis"), so keep
the card shell reusable for initiative 7. Never crop a photo of a child; never remove a head-cut photo without
its replacement in the same publish.
Never: a paid image call, a model id in copy, a crop outside the product's own prefix.
Done when: PR open, CI green, the spec 12 section 12.1 items for these sections ticked; the test-run plan written.
Ask me before: the deploy, the all-brand test run, switching any channel live.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```

### Initiative 3. Made photos, mode A

```text
Execute initiative 3 "Made photos, mode A" from docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md.
It builds docs/specs/12-apparel-shot-set.md 1.5 bench, 5 generator, 6 checks G1 to G4, G6, G7 and OCR (G5 by two
judges only), 7 in full including 7.6 fixes and per-cell exit, the 9.2, 9.6, 9.7 Brand DNA shell (Logos, Brand
words, Brand permissions; add to the page initiative 7 built if it exists), 11.5, 11.6 and the 12 scorecard.
Merged first: initiatives 1 and 2.
Follow docs/specs/00-execution-protocol.md, own worktree and feature branch, manager delegates to subagents.
My gate approvals:
- G3: I approve generation approvals A5 to A8 in spec 12 section 13. Bench engines approved: <list>. Vendor
  no-training positions on file: <links or "pending">.
- Paid image calls: yes for the test run up to <USD>; live only after I read the scorecard.
- Technical test brand: <Vero Moda or another>. Reviewers: <name>, overlap <name>.
- G7 is not a blocker: use the spec default, the hidden AI-made marker on every channel, until a marketplace asks for more.
Scope: generate_enabled per brand, cap = estimate x 1.5 rounded up plus the fix allowance, hosted services off,
face-showing roles checked by a person. Off: Models tab, mode B, kids, scenes.
Never: a model id in copy, a generated child, a call without the cap check.
Done when: PR open, CI green, the spec 12 section 12.1 items for these sections ticked, scorecard template ready.
Ask me before: any paid call, the test run, going live, any change to a cap.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```

### Initiative 4. Scene image for selected shoes and bags

```text
Execute initiative 4 "Scene image for selected shoes and bags" from
docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md. It builds docs/specs/13-footwear-scene-image.md
workstreams A to F with migration 0006_scene.sql, including the 2026-10-28 amendments: per-product scene choice,
default none (1.3, 2.1, 2.5, 9.0); scene kinds 4a, 4b, 4c with SCENE_KINDS; carried-bag checks S5a to S5d and the
"bags carried" exit cell (5.8, 8.2); scene hints per subcategory (1.1, 1.6).
Merged first: initiatives 1, 2 and 3.
Follow docs/specs/00-execution-protocol.md, own worktree and feature branch, manager delegates to subagents.
My gate approvals:
- G4: brands with written rights and their lifestyle scope: <brand: none / still_life / worn_or_carried, ...>.
- Scene profiles and hints approved for: <brands>. Exit bar: <150 labels as written / n>.
- Test-run spend: up to <USD>. Technical test brand: <US Polo or another>.
Scope: SCENE_ENABLED off at deploy; nothing ticked by default; SCENE_KINDS starts at 4a; no face in 4c; kids legs
or feet only; a scene image is never image 1. Off: face routing (initiative 5), infographics.
Never: a scene for a product nobody selected, a model id in copy, free-text scene descriptions.
Done when: PR open, CI green, the spec 13 section 11.1 items for the build ticked; the test-run plan written.
Ask me before: SCENE_ENABLED on, each SCENE_KINDS step, any paid call beyond the test-run budget.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```

### Initiative 5. Brand faces, flat lay to on-model, kids

```text
Execute initiative 5 "Brand faces, flat lay to on-model, kids" from
docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md. It builds docs/specs/12-apparel-shot-set.md
section 9 in full (harvester, face identity G5, biometric handling, delete), the mode B rows of sections 3 and 5,
mode A on a kids model, and the face routing of docs/specs/13-footwear-scene-image.md.
Merged first: initiatives 3 and 4.
Follow docs/specs/00-execution-protocol.md, own worktree and feature branch, manager delegates to subagents.
My gate approvals:
- G5: licensed face model: <name and licence link>; human-parsing licence: <name and link>.
- Reference models approved per brand, gender and audience: <list>.
- G6 legal confirmation on biometric and kids data: <received on date / go live without it>.
Scope: brand faces only ("brand face, not own model"); carried bags stay faceless; kids only on an approved kids
reference model of the brand.
Never: a synthetic child, a face stored without the spec 12 section 9.5 handling, a model id in copy.
Done when: PR open, CI green, the spec 12 and spec 13 acceptance items for these sections ticked.
Ask me before: the first harvest from a brand site, any kids generation, the test run, going live.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```

### Initiative 6. Already live, on request

```text
Execute initiative 6 "Already live, on request" from
docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md. It builds docs/specs/12-apparel-shot-set.md 10.4, docs/specs/13-footwear-scene-image.md 9.4 and the 7.6
retirement rule: the Home "Products already live" card, the product page buttons and a links sheet or product
list that names live products (with the scene column), carrying their current photos unchanged.
Merged first: initiatives 2, 3 and 4, automatic in the cells a request will touch.
Follow docs/specs/00-execution-protocol.md, own worktree and feature branch, manager delegates to subagents.
The carry function is shared with initiative 7 (docs/specs/18-infographic-image.md section 2.4): reuse it if 7 is
merged, otherwise build it at that path with that signature.
My gate approvals:
- Pull-back path for generated images: <built in this initiative / not needed yet; requests stay under 50>.
Scope: one product or a named list at a time; inflow first, no backfill.
Never: bulk or automatic requests, a change to a live image the request did not ask for.
Done when: PR open, CI green, one live product completed on request in a test batch with its sheet rows correct.
Ask me before: any request over 50 products, the deploy.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```

### Initiative 7. Infographic images

```text
Execute initiative 7 "Infographic images" from docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md.
It builds docs/specs/18-infographic-image.md V1: workstreams A to F and H, migration 0007_infographic.sql,
I-lite if initiative 3 is not merged, G-lite only if I say yes below.
Merged first: initiative 1 (and 2 for the card shell, unless G-lite).
Follow docs/specs/00-execution-protocol.md, own worktree and feature branch, manager delegates to subagents.
My gate approvals:
- G0b: I approve adding spec 18 0007_infographic.sql to the granted list in protocol section 11.
- G12: highlights sheet columns agreed with Naaz and Taranum: <as spec 18 section 2.1 / these columns: ...>.
- G9: text-on-image rows as seeded in spec 18 section 1.4, except: <none, or channel: not_allowed>.
- Card shell: <wait for initiative 2 / build G-lite>. Fonts: <the five in section 3.6 / changes>.
- Test-run brand: <brand>; its highlights sheet of about 50 live products comes from <who>.
Scope: text composed by code only, no paid call, never image 1, no person in the base photo, Noon and Namshi a
plain band with no logo, English only. V2 items of section 10 are off.
Never: an image model drawing text, a word not in the sheet, a price on an image, a model id in copy.
Done when: PR open, CI green, T1 and T2 at 100% on the 50-product layout set and every planted defect caught
(section 9.4), acceptance items 1 to 10 of section 11.1 ticked; the test-run plan written.
Ask me before: the first run on live product identifiers, INFOGRAPHIC_ENABLED on, any brand voice going live.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```

### Initiative 8. Product facts

```text
Execute initiative 8 "Product facts" from docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md.
It builds docs/specs/19-product-facts-and-channel-vocabulary.md V1: workstreams A to F, migration
0008_product_facts.sql, the Facts panel, the Facts worksheet and the 6.6 contract for spec 20.
Merged first: initiative 1.
Follow docs/specs/00-execution-protocol.md, own worktree and feature branch, manager delegates to subagents.
My gate approvals:
- G0b: I approve adding spec 19 0008_product_facts.sql to the granted list in protocol section 11.
- Vocabulary version 1: <approved as seeded in section 2 / with these changes: ...>. "Half" sleeve reads as
  <short / elbow>.
- Precision bars: <as section 7.2 / changes>. Labellers: <name>, <name>; settler: <name>.
- G11a brand product sheets: <brand: file or "none yet", ...>.
Scope: one facts call per product; photo facts only for what a photo shows; brand data for the rest; every fact
has a source; "Unknown" is valid; no channel mapping (V2 is off).
Never: a guessed material, care, origin or fit; brand data sent to a model; a change to any image or plan; kids
or modesty rules touched; a model id in copy.
Done when: PR open, CI green, the section 11 tier 1 and 2 cases pass, the Facts panel and worksheet shown on a
test batch, and the section 12.1 acceptance items for the build ticked.
Ask me before: the labelled-set eval run (about 0.14 USD), FACTS_ENABLED on live, any V2 work.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```

### Initiative 9. Listing template files

```text
Execute initiative 9 "Listing template files" from
docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md. It builds
docs/specs/20-listing-template-files.md V1: workstreams A to E, migration 0009_listing_templates.sql, the
/catalog/templates page, the fill inside finalize and the "Needs you" tab.
Merged first: initiatives 1 and 8 (spec 19 V1, with its 6.6 contract).
Follow docs/specs/00-execution-protocol.md, own worktree and feature branch, manager delegates to subagents.
My gate approvals:
- G0b: I approve adding spec 20 0009_listing_templates.sql to the granted list in protocol section 11.
- G10: V1 channels are <noon NIS and Namshi Excel / others>. Templates on record: <file name, channel, from whom>.
- Golden fill: Naaz hand-fills batch <batch> for <channel>, at least 20 products.
- Amazon: <wait for V2 / use the .xlsx flat file from the channel manager>.
Scope: fill, validate, download; blanks shaded and listed; price, stock, offer, shipping and tax never filled; no
AI call; no Arabic text. Use spec 19's merged names for facts.
Never: submit a file, call a marketplace write API, guess a value or a mapping, fail finalize.
Done when: PR open, CI green, the section 9 acceptance items for the build ticked, the golden fill for each V1
channel with zero wrong values.
Ask me before: the first portal upload per channel, adding a channel beyond V1, any V2 work.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```

### Deploy line (after you merge an initiative's PR)

```text
PR #<n> for initiative <k> is merged. Deploy and smoke test it per docs/specs/00-execution-protocol.md with the
switches in the state docs/plans/proposals/2026-10-28-shipping-plan-catalog-initiatives.md section 1 gives for
initiative <k> (everything off at deploy unless that section says otherwise). Report what is live.
If the session runs out of room, write a handoff with /ce-handoff and tell me the resume line.
```
