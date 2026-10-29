# Focus 04 - 6.2 Real product composited into a generated scene

> **Bottom line.** **What:** paste the brand's own cut-out shoe or bag into an AI-drawn scene, so product pixels stay
> identical; the only scene route for kids, and the fallback when a full lifestyle image fails. **Why:** 4.2k USD a
> year base (judged) plus a safety net for 6.1a / 6.1b. **Blocks it:** the same generation package as lifestyle
> (generation, lifestyle and cropping amendments, generator yes, vendor position, review exit numbers), photo roles,
> and brand confirmation. **Sign:** the package, build the composite in house, kids get composite only, and whether
> composites stay in full review.

Date: 2026-10-26. Business-approval doc. Documents only; nothing is built, no query and no paid call was run for it.
Framing: we are about to build this; here is everything needed to approve it. Every claim carries a source code
(key in section 12). No time, duration or effort appears here (owner rule, 08 L7-9).

**Words used here (defined once).**

- **Composite:** the brand's real product pixels are cut out and placed into a generated scene, so the product cannot
  change (DD4 L19).
- **Cut-out (matte):** the product separated from its background by the module's own cut-out step (DD4 L217).
- **Paste-back:** after the generator draws the scene, code pastes the real cut-out back on top at the same place, so
  every product pixel is the brand's original (DD4 L162, L177).
- **Still life:** the product alone in a scene, no person (DD4 L17).
- **Style-colour:** one design in one colour; one image is made per style-colour, never per size (DD4 L18).
- **Generator:** the image model we would buy as a swappable engine; it returns pixels only, everything else is ours
  (05 L168-170). Named here by role only.
- **Gate checks G1 to G4:** the automatic checks that a generated image did not change the product: G1 identity, G2
  logo and text, G3 colour, G4 texture and print (DD2 L141-144).
- **Review-all:** a person sees every generated image before it publishes (08 L27-28).
- **SPEC amendment:** a change to `docs/SPEC.md`, the rules of the catalog module; only the owner can make it (08 L24-26).

## 1. In one paragraph

6.2 gives a footwear or bag page one extra scene image without any risk to the product: the brand's own cut-out is
placed on a scene the generator draws, then pasted back by code so the product pixels stay identical (08 L344; DD4 F6
L177 measured 0 difference on every opaque product pixel). It is the only path for kids' products (never a generated
child) and for bags with too few photos, and the fallback when a fully generated lifestyle image (6.1a, 6.1b) fails
its checks (DD4 R1-R2 L244-254). **Before:** a typical US Polo set shows packshots only, for example `SMITH GLB 4PR`
with side, pair, top, back and sole views and no scene (I06 L55-56; DD4 L84). **After:** the same gallery plus one
still life as the last image, for example the pair on a concrete ledge or steps (the sneaker still-life row, DD4 L112),
where the shoe is the brand's own photo, pixel for pixel. The trial made still lifes this way on a ledge, a cafe
floor, a running track and a marble table (DD4 L177).

## 2. Business impact (only figures already in the docs)

| Figure | Value | Source |
|---|---|---|
| Revenue, low / base / high, USD a year | 0 / 4.2k / 12.5k | 08 L344 |
| Base as listed in Wave D (row D4) | 4.16k | 08 L459 |
| Spend avoided (agency generation we would otherwise pay), once | 0.5k to 0.8k | 08 L344, L459 |
| Cash saved today | none: the agency does not make these images now | I06 L245-247 |
| Ad money saved for 6.2 alone | not sized in the docs | - |
| Share of the generation package (decision 2) that 6.2 is part of | package unlocks 75.6k across 6.1b, 5.2, 5.3, 6.2, 6.1a | 08 L101, L531 |

Confidence: every lift in initiative 6 is judged, and our own data shows no gain from image count alone (08 L72-73;
I06 L63-67). The split formula behind the 4.2k is said to live in the agent split files (08 L11-15); those files are
not in this worktree, so the 4.2k cannot be traced further here.

## 3. Scope

- **Products:** kids' footwear, 85 style-colours: US Polo 49, Puma 31, Campus 5 (DD4 L69); bags with fewer than 3
  distinct views; embellished, transparent or mirror-like products such as the crystal clutch (DD4 R1.4 L246); and
  any adult footwear that fails the gate twice plus once on the escalation engine (DD4 R2 L253; I06 L105-108).
- **Brands:** US Polo, Puma, Campus (kids, DD4 L69); French Connection and Vero Moda (bags, DD4 L24, L86).
- **Channels:** wherever a lifestyle image is allowed, always as the last image and never image 1 (DD4 F5 L148, R5
  L266). One 2K 3:4 frame, cropped by code to each channel (DD4 R4 L264).
- **Roles:** Dev builds; Naz reviews (08 L344); the owner signs decisions; brands confirm rights (08 L344).
- **Volume:** 85 kids' style-colours are counted (08 L344; DD4 L69). The number of thin bag sets and of adult
  fallbacks is not sized in the docs.

## 4. Absolute blockers (must be true before work starts)

| # | Blocker | Owner | How to unblock |
|---|---|---|---|
| 1 | Generation SPEC amendment: SPEC forbids "generative edits or paid image APIs" (SPEC L837) and any paid image API needs a separate owner yes (SPEC L55) | Owner | Approve the drafted wording in DD2 R4 (DD2 L161; 08 L101, L510) |
| 2 | Lifestyle SPEC amendment: SPEC forbids a "lifestyle-background option" (SPEC L840) | Owner | Approve DD4 R7, which names "a still life of the brand's own cut-out pixels for kids and for products with too few photos" (DD4 L270-278) |
| 3 | Generator yes: the amendment allows only "a generator the owner has approved in writing" | Owner | Written yes to the default generator in the engine slot (DD4 L276; 08 L101; 05 L200) |
| 4 | Vendor no-training position: brand photos would leave GCP for a US or Google-hosted engine | Vendor writes; owner asks | Written no-training position before any live run (05 Q2 L202-203; I06 L269) |
| 5 | Brand confirmation for every brand in scope | Brands; owner asks | Written confirmation that Opptra's rights cover generated lifestyle imagery (08 L344; DD4 Q5 L305; I06 L301-303) |
| 6 | Cropping SPEC amendment: SPEC forbids "cropping of any kind" (SPEC L841); the scene frame is cropped per channel | Owner | Approve DD2 R4's cropping text plus DD4 R7's line "a generated lifestyle frame is cropped to each channel's aspect around the product" (DD4 L278; 08 L510; F01 s6) |
| 7 | Exit numbers for review-all and a named second rater (part of decision 2's gate bars). Composites skip G1 to G4 but stay in review-all until the exit numbers hold | Owner | Approve DD2's exit numbers; name the second rater (08 L101; DD4 R3 L262; see Q3) |
| 8 | Photo roles, per-channel caps and last-slot placement (initiative 2, decision 6) | Owner, then Dev | Approve the role taxonomy and rule table; build 2.6 roles. Without them "already has a lifestyle photo" cannot be read and the image can be dropped at caps (08 L105; DD4 L289-290) |

## 5. Decisions the business must sign

- [ ] Yes / no: approve the generation SPEC amendment (DD2 R4, DD2 L161).
- [ ] Yes / no: approve the lifestyle SPEC amendment, including the composite still life wording (DD4 R7 L276).
- [ ] Yes / no: approve the generator as a swappable engine behind our own gate (05 Q1 L200; 07 L576-577).
- [ ] **Build vs vendor** - yes / no: build the composite in house from the module's matte, sole-strip recovery and
  contact shadow, and do not buy a scene-around-product API now (Photoroom, Bria, Stability, Claid, Vertex); re-test
  Bria only if composite volume grows (I06 L147-148; DD4 F8 L212; 05 L133).
- [ ] Yes / no: brand photos may be sent to the engine vendor, with a written no-training position first (05 Q2).
- [ ] Yes / no: kids get a composite still life only, never a generated child (DD4 R1.2 L244; DD4 L288).
- [ ] Yes / no: composite outputs skip G1 to G4 and keep the scene checks S2 to S4 plus a realism question (DD4 R3 L262).
- [ ] Yes / no: composite outputs stay in review-all until 100 labelled lifestyle images across at least 3 brands meet
  DD2's exit numbers (DD4 R3 L262).
- [ ] Choose: at the Trendyol (8) and Amazon (9) caps, may the scene image replace the size chart, or is it not sent
  (DD4 Q3 L303; I06 Q4 L318)?
- [ ] Yes / no: every generated image carries an embedded "AI-generated" metadata tag by default (DD4 Q4 L304).
- [ ] Yes / no: is our own fallback enough, with no vendor SLA (05 Q5 L209)?

## 6. How it will be built

**Steps** (the trial's approach B, DD4 L162, made production-grade with the module's own parts, DD4 F9):

1. Pick the product by the rules: kids, bags under 3 views, embellished items, or an adult product that failed the
   generation ladder; skip if a real lifestyle or worn photo already exists, the subcategory is unknown, the brand
   profile switches it off, sources are below the module's size floor (`small_source`), or every ticked channel is at its cap (DD4 R1 L242-250).
2. Cut the product out with the module's matte and sole-strip recovery (DD4 L217).
3. Place the cut-out inside the centre square of a 3:4 canvas so every channel crop keeps it whole (DD4 R3 S4 L261).
4. Ask the generator to replace only the background with the still-life scene for that subcategory (sneaker: pair on
   a concrete ledge or steps; handbag: on a marble side table) and add a contact shadow (DD4 L162, F4 L110-123).
5. Paste the real cut-out back by code at the same place. This is mandatory: before paste-back the generator changed
   10% to 60% of product pixels by more than 24 of 255 (DD4 L179).
6. Checks, then crop per channel, place last, flag `generated`, record cost in the ledger (DD4 R3-R5; 05 L172).

**Which checks apply, and why G1 to G4 are skipped.** G1 to G4 compare a redrawn product with the brand's photo
(DD2 L141-144). In a composite the product pixels are the brand's own, proved by a code check of pixel equality on
the product mask, so those four checks have nothing to catch (DD4 F7 L193, R3 L262). What stays: S2 modesty, S3 scene
safety (no text, other brands, landmarks, alcohol, religious buildings, flags), S4 crop safety, and a judge question
on realism (scale, shadow, light) (DD4 R3 L259-262). S1 framing is about people and does not apply to a still life
(DD4 L258).

**Review:** every output flagged `generated` with a `gen_key`; review-all by Naz until the exit numbers hold (DD4 R3
L262; 08 L344, L473).

**Reused:** footwear and bag matte and shadow policy, sole-strip recovery, policy lookup, render, compliance, publish,
links sheet, the LLM client and the daily and per-batch spend caps (DD4 F9 L216-221).

**New:** a lifestyle role placed after every brand photo; a full-frame render mode that crops instead of padding,
with `compliance.ts` skipping the background and safe-box checks for this role only; the `leftover_background` hold
must not fire on it; scene table and checks as data in the brand style profile; slot handling at caps (DD4 L223-228).

**SPEC amendments:** DD2 R4 (generation exception, DD2 L161) and DD4 R7 (lifestyle image incl. composite still life,
plus a cropping-bullet line and a models-table row "composite fallback uses the module's own matte and contact
shadow", DD4 L270-278). They target SPEC L837, L840, L841 and L55.

## 7. Dependencies and relationship to 6.1a / 6.1b

- **Shared with 6.1a / 6.1b:** the same generator, scene table, slot rule, crop and review flow (DD4 R2-R5). 6.2 sits in
  Wave D with them (08 L459) and is listed after 6.1b and 6.1a in the lifestyle line (08 L355-357).
- **Fallback role:** adult footwear that fails full generation twice plus once on the escalation engine falls back to
  the composite; if that fails too, the product is held with a reason (DD4 R2 L253). In the engine slot it is option 4,
  "our own composite still life (DD4 fallback, pixels unchanged)" (05 L161).
- **What it cannot do:** no worn shot; a shoe cannot be pasted onto a generated foot convincingly (DD4 F7 L193). So it
  does not replace the catchy worn image Naz asked for (DD4 L235).
- **Inside the program:** shot roles, per-channel caps and last-slot placement from initiative 2; treatment log from
  initiative 1; brand style profile and `brand_rights` record from DD8 (I06 L294-299). Without roles the "already has
  a lifestyle photo" rule cannot be read; without caps the image can be silently dropped on Trendyol and Amazon
  (DD4 L289-290).

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Weaker realism: pale fringe at the base from a crude matte, product lit flatter than the scene (DD4 L177) | Production matte and contact shadow instead of the trial's flood fill (DD4 L162, L217); realism judge question (DD4 R3) |
| Matte fails on white marks on a light background (the US Polo monogram was left out of the trial for this reason, DD4 L162); 49 of 85 kids are US Polo (DD4 L69) | Production matte guard exists for this hard case (DD4 L162); hold with a reason on failure (DD4 R2) |
| Generator alters product pixels before paste-back (DD4 L179) | Paste-back is mandatory and checked by pixel equality (DD4 F7) |
| Brand rights not confirmed (I06 Risk 1 L260) | Nothing publishes without a covering `brand_rights` row (I06 L260) |
| Brand photos leave GCP (I06 Risk 10 L269) | Written no-training position per vendor (05 Q2) |
| Generated-image labels: Amazon may need a synthetic-performer tag; Noon says "only photographs are permitted" (DD4 F5 L148; I06 Risk 7 L266) | Owner answer on labels; metadata tag by default if agreed (DD4 Q4) |
| Image caps at Trendyol 8 and Amazon 9 (I06 Risk 6 L265) | Caps encoded in initiative 2; owner sets priority (DD4 R5) |
| Lift is judged, not measured (08 L72-73) | Coverage is the proof metric; no 6.2-specific holdout is in the docs (see section 10) |
| Vendor change (07 L566) | Swappable engine slot; composite is itself the fallback (07 L566; 05 L189) |

## 9. Cost and budget (only as stated in the docs)

- 0.1015 USD per composite attempt (DD4 R6 L268); about 0.10 to 0.20 USD per accepted composite (DD4 L235).
- Bria, if ever bought for the fallback, lists 0.032 USD per image (DD4 F8 L206, L237).
- A separate run-cost line for 6.2 is not sized in the docs; the lifestyle backlog of 1,222 style-colours at 244.40 USD
  once includes all lifestyle images (DD4 R6 L268; I06 L231), and initiative 6's year-one run cost is about 985 USD
  (I06 L236).
- The default daily spend cap of 10 USD paces a backfill unless the owner raises it (DD4 L220; I06 L239).

## 10. Definition of done and the success metric

- **Done:** kids' style-colours carry a scene image, which is 6.2's stated proof of progress (08 L344); every composite
  shows 0 difference on every opaque product pixel (DD4 F6 L177); each output flagged `generated`, placed last, never
  image 1 (DD4 R3, R5); review-all exit met on 100 labelled lifestyle images across at least 3 brands (DD4 R3 L262).
- **No harm:** zero channel rejections from the added images, read from the Noon and Namshi reason feeds once restored
  (I06 L288-289).
- **Success metric:** coverage of kids' style-colours with a scene (08 L344). A conversion lift for 6.2 is not
  separately tested: the lifestyle holdout cell is US Polo lifestyle on Namshi and Noon (06 L276; I06 L276-277).

## 11. Open owner questions

1. Approve the generation package: both SPEC amendments, the generator, gate bars and a second rater, plus the vendor's
   written no-training position (08 L531)?
2. Will US Polo, Puma, Campus, French Connection and Vero Moda confirm generated lifestyle imagery under Opptra's
   written rights (DD4 Q5 L305)? Note: 08's US Polo question lists 6.1b, 6.4, 6.5 but not 6.2 (08 L530), yet 49 of
   the 85 kids are US Polo (DD4 L69).
3. Do composite outputs stay in review-all, or may they leave review on code checks alone? DD4 R3 puts every
   lifestyle output in review-all (DD4 L262), while DD4 L291 says only the composite "could leave review on code
   checks alone" if the gate is not approved.
4. Do G5 and G6 apply to a composite? DD4 R3 names only S2 to S4 plus realism (DD4 L262); G5 and G6 are written for
   apparel on-model shots (DD2 L145-146).
5. Cap priority at Trendyol and Amazon (DD4 Q3); labels on generated images (DD4 Q4); is a vendor SLA needed (05 Q5)?
6. Do studio worn or carried photos count as "lifestyle already present" (DD4 Q2 L302)? It decides which products skip.

## 12. Sources

Key: **08** = `roadmap/08-reprioritization-proposal.md`; **I06** = `roadmap/initiatives/06-richer-footwear-pages.md`;
**DD4** = `deep-dives/04-footwear-bags-lifestyle.md`; **DD2** = `deep-dives/02-derived-shots-fidelity-gate.md`;
**05** = `roadmap/05-build-vs-buy.md`; **06** = `roadmap/06-metrics-and-impact.md`; **07** = `roadmap/07-roadmap.md`;
**SPEC** = `docs/SPEC.md` (worktree root). All other paths are under `docs/plans/`.

| Claim | Source |
|---|---|
| 6.2 definition, value 0 / 4.2k / 12.5k, spend avoided, deps, skips G1 to G4, lanes, proof | 08 L344 |
| Blocker class of the generated group | 08 L63 |
| Decision 2, generation package, 75.6k | 08 L101, L531 |
| Wave D row D4, 4.16k | 08 L459; heading L452 |
| Lifestyle line order | 08 L355-357 |
| US Polo rights question scope | 08 L100, L530 |
| Split-file provenance of values | 08 L11-15 |
| Composite fallback scope in initiative 6 | I06 L105-108, L20 |
| Build vs buy table | I06 L142-154 |
| Risks | I06 L256-272 |
| Dependencies and business gates | I06 L292-307 |
| Owner questions | I06 L309-328 |
| Run cost, daily cap | I06 L227-240 |
| Kids count by brand | DD4 L69 |
| Composite definition | DD4 L19 |
| Trial approach B and paste-back result | DD4 L162, L177, L179 |
| Method table (locked pixels, no worn shot) | DD4 F7 L189-196 |
| Generator options and build/buy reasoning | DD4 F8 L198-212 |
| Reused and new parts | DD4 F9 L214-228 |
| Options summary (composite 0.10 to 0.20) | DD4 L230-238 |
| Do-not-generate rules, method, gate, crop, slot, cost, SPEC draft | DD4 R1-R7 L242-278 |
| Depends-on table | DD4 L280-294 |
| Approval question (a): composite as fallback | DD4 L298 |
| Owner questions Q2 to Q5 | DD4 L302-305 |
| Gate checks G1 to G6, generation SPEC draft | DD2 L141-146, L161 |
| Engine slot, composite as option 4, slot rules | 05 L157-176 |
| Lifestyle scenes: hybrid with own composite | 05 L133 |
| Owner questions Q1, Q2, Q5 | 05 L200-209 |
| Vendor change risk; owner decisions on build vs buy and SPEC staging | 07 L566, L575-578 |
| Lifestyle holdout cell 3 | 06 L276 |
| SPEC bans | SPEC L55, L837, L840, L841 (this branch); main has moved them to L54, L854, L857, L858 |

Status: draft for owner approval
