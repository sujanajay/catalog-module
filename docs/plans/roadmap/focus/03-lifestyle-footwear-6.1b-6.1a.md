# Focus 03 - Lifestyle image for footwear: 6.1b (US Polo) and 6.1a (pilot brands)

> **Bottom line.** **What:** one AI-generated, legs-only scene photo per shoe style-colour, always the last image.
> **Why:** the biggest item of the seven: 6.1b US Polo 52.2k USD a year base, 6.1a other brands 3.4k (both judged).
> **Blocks it:** the generation package (SPEC amendments, generator yes, vendor position, gate bars), the gate built
> under 5.2, photo roles, and each brand's written rights confirmation. **Sign:** the package, the brand asks (send
> now, free), and the content rules in section 5. Whichever brand confirms first goes first.

Date: 2026-10-26. Business-approval doc. Documents only; nothing is built and nothing was run for this file. Every
figure is copied from the source docs with a pointer `[code Lnn]`; the codes are listed in section 12. No new
estimate is made anywhere. No time or effort figures appear (owner rule, [P08 L7-9]).

**Words used here (defined once).**
- **Style-colour:** one product design in one colour (for example a sneaker in navy). One lifestyle image is made per style-colour.
- **Lifestyle image:** a photo of the shoe in a real-world scene. Here it is always **legs-only**: the frame shows
  the shoes on someone's legs, ends at or below the knee and never shows a face [I06 L102-104].
- **Packshot:** the brand's plain studio photo of the product on a white or grey background.
- **Generator:** the paid image service that draws the new scene from the brand's packshots. It is described here by
  role only; its name never appears in docs for operators or in the UI [AGENTS.md; I06 L13].
- **Gate (fidelity gate):** automatic checks plus a person's review that make sure a generated image did not change
  the product, its colour or its logo [P08 L27-28].
- **Review-all:** a person sees every generated image before it publishes [P08 L28].
- **SPEC amendment:** a change to `docs/SPEC.md`, the rules document of the catalog module. Only the owner can change
  it [P08 L24-26].
- **Holdout:** fix half of a matched set of products, leave the other half, compare sales conversion [P08 L29].
- **Composite:** the brand's own cut-out photo pasted by code onto a generated background, so the product pixels are
  untouched [I06 L105-108].

---

## 1. In one paragraph

We are about to add **one generated, legs-only lifestyle photo per footwear style-colour, always placed as the last
image in the gallery and never as image 1**. 6.1b does this for US Polo, the brand that earns about 5.9M of about
9.2M USD softline revenue but has no lifestyle scene on 19 of 20 sampled shoe pages [P08 L343]. 6.1a does exactly
the same for other brands (Campus and Keds first, then Puma and bags) as soon as one of them confirms rights in
writing [P08 L345]. Nothing can be built until the owner approves the "generation package" and the brand confirms
its rights [P08 L101, L456, L460].

**Before / after (a real US Polo page).** Today the typical US Polo set `ZEB6895448883067F310CZ` (SMITH GLB 4PR,
men's sneaker) has 6 images: side on white, then pair, pair, top, back, sole on light grey. All views are there, but
there is no scene [I06 L55-56]. After: the same 6 brand photos stay in the same order, and a 7th image is added at the
end: the sneaker worn, legs-only, for example seated on a concrete ledge or in a plaza (the scene for sneakers), no
face, legs covered in a modest way [I06 L100-104, L116-118].

## 2. Business impact (only figures from the docs)

| Item | 6.1b US Polo | 6.1a pilot brands | Source |
|---|---|---|---|
| Extra revenue a year, low / base / high (USD) | 0 / 52.2k / 156.7k | 0 / 3.4k / 10.3k | [P08 L343, L345] |
| Wave D exact base | 52.21k | 3.43k | [P08 L456, L460] |
| Spend avoided, once (agency price we would otherwise pay) | 2.9k to 4.7k | 3.8k to 6.1k | [P08 L343, L345] |
| Cash saved today | none (the agency does not make these images now) | none | [I06 L245-247] |
| Pain removed | US Polo 19 of 20 sets have no scene; 55,280 USD of ads land on packshot-only pages | Keds 0 of 7 with a scene; Naz makes these by hand with no check or record | [P08 L343, L345] |

- **What the base is.** Both lines are part of the B4 lifestyle row: 59.8k base, built as revenue touched (5.98M)
  x share of pages without a scene x a **judged** 1% lift [M06 L147; I06 L201-204]. "Judged" means an assumption,
  not a measurement.
- **Confidence.** Our own data finds no sales gain from image count alone, and a 1% lift cannot be measured directly
  on any channel [P08 L72-73; I06 L63-66]. The holdout in section 10 decides whether the row stays.
- **Biggest swing.** If the studio on-legs shots already in 7 of 20 US Polo sets count as "lifestyle already
  present", B4 falls from 59.8k to 41.9k [I06 L60-61, L220]. How that drop splits between 6.1b and 6.1a is
  **not sized in the docs**.
- **Ad money.** At a 1% lift B4 would save 2.1k of ad spend, shown for comparison only; ad money is counted once, in
  initiative 3 [I06 L212-213].
- **Capacity.** Naz makes 5 to 6 such images a day by hand; the 1,222 lifestyle backlog is about 94% of a year of
  that manual route [I06 L35, L251-252].

## 3. Scope

| | 6.1b | 6.1a |
|---|---|---|
| Brands | US Polo footwear | Campus, Keds first; then Puma and bags (French Connection, Vero Moda) [P08 L345] |
| Volume (style-colours in the 1,222 backlog) | US Polo 529 | Campus 406, Keds 105, Puma 106; bags: French Connection 63, Vero Moda 13 [I06 L98-99] |
| Today's baseline | 1 of 20 sampled sets has a scene [I06 L83] | Campus 11 of 15, Keds 0 of 7 [I06 L83] |

- **Kids.** 85 of the 1,222 are kids' products; they never get a generated child, only the composite still life
  [I06 L99, L105; DD4 L244]. The per-brand split of the 85 is **not given in the docs**.
- **Not made when** a lifestyle or worn photo already exists, the subcategory is unknown, the brand profile switches
  it off, sources are too small, or every ticked channel is at its cap with no named swap; a real photo that arrives
  later replaces the generated one [DD4 L242-250].
- **Channels.** One 2K 3:4 frame, cropped by code for Noon, Namshi, Trendyol, Styli, 6thStreet, VogaCloset, Amazon,
  Shein and Centrepoint [DD4 L264]. Always last; never image 1 [DD4 L266]. No channel with a public rule allows
  lifestyle as image 1 [I06 L46]. Lifestyle rules for 6thStreet, Styli, Centrepoint, Shein and VogaCloset are not
  public [DD4 L306].
- **Image caps.** Trendyol 8, Amazon 9, Shein and VogaCloset 10: at the cap the lifestyle image replaces the size
  chart only if the owner says so; otherwise it is not sent and the links sheet says why [DD4 L266].
- **Roles (who does the work).** Dev (catalog module team), Naz (review-all and approval), owner (decisions and
  brand asks) [P08 L343, L345, L473]. Data runs the lifestyle holdout cells; Mkt holds the bid, budget and price
  freeze for them [P08 L472, L474].

## 4. Absolute blockers (must be true before work starts)

| # | Blocker | Owner | How to unblock | Blocks 6.1b / 6.1a |
|---|---|---|---|---|
| 1 | Generation and lifestyle SPEC amendments (SPEC forbids generation, lifestyle backgrounds and cropping today) | Owner | Approve the drafted wording in DD2 R4 and DD4 R7 | both [P08 L101; SPEC L837-841] |
| 2 | A written "yes" to the paid generator | Owner | Record a yes per paid generator before any build (Gate C) | both [P08 L101; PROG L139; SPEC L55] |
| 3 | Gate bars, exit numbers and a named second rater | Owner | Approve DD2's bars and exit numbers; name the second rater | both [P08 L101, L531; DD2 L170] |
| 4 | Vendor written no-training position (brand photos leave our cloud) | Vendor writes it; owner asks | Written statement per vendor before any live run | both [P08 L101; I06 L269, L306] |
| 5 | US Polo written confirmation that rights cover generated images | US Polo; owner asks | Written scope; a covering `brand_rights` row, without which nothing publishes | 6.1b only [P08 L100, L456; I06 L260] |
| 6 | Pilot brand written confirmation (Campus or Keds; then Puma, French Connection, Vero Moda) | That brand; owner asks | Same as row 5, per brand | 6.1a only [P08 L345, L460; DD4 L305] |
| 7 | Initiative 5's generation gate built and labelled, and the generator in the engine slot | Dev (after rows 1 to 4) | Build DD2's checks G1 to G6; lifestyle reuses them | both [I06 L298; DD4 L291] |
| 8 | Initiative 2's shot roles per photo, caps and last-slot placement | Owner (decision 6), then Dev | Approve role taxonomy and rule table; build 2.6 roles | both [I06 L296; P08 L105, L211; DD4 L289-290] |

Rows 1 to 4 together are **decision 2, the generation package** (75.6k of base cannot move without it) [P08 L101].

## 5. Decisions the business must sign

- [ ] Yes / no: approve the generation package: generation and lifestyle SPEC amendments, the generator, gate bars,
  second rater; the vendor gives a written no-training position [P08 L531].
- [ ] Yes / no: approve DD4's basis for the lifestyle spec: one image per adult footwear and bag style-colour,
  legs-only or carried, no face; composite fallback; the "do not generate" rules; gate plus four scene checks with
  review-all until 100 labelled images pass; one frame cropped per channel, last, never image 1; 0.20 USD per
  accepted image; the SPEC wording in R7 [DD4 L298].
- [ ] Yes / no: ask US Polo now to confirm in writing that existing rights cover generated images [P08 L530, L349].
- [ ] Yes / no: ask Campus, Keds, Puma, French Connection and Vero Moda at the same time [P08 L349; DD4 L305].
- [ ] Yes / no: studio on-legs shots and Campus's styled studio sets count as "lifestyle already present"
  [I06 L316-317; DD4 L302].
- [ ] Yes / no: at the Trendyol (8) and Amazon (9) caps, the lifestyle image may replace the size chart [DD4 L303].
- [ ] Yes / no: every generated image carries an embedded "AI-generated" metadata tag by default [DD4 L304].
- [ ] Yes / no: for women's styles with legs fully covered, a frame starting above the knee is acceptable [I06 L326-327].
- [ ] Yes / no: a bid, budget and price freeze for the lifestyle holdout products, agreed with the agencies
  [I06 L279; P08 L474, L548].

## 6. How it will be built

**Steps (per style-colour)** [I06 L100-118; DD4 L252-266]:
1. Pick 3 to 4 of the brand's own packshots (side first, then pair, top, heel; size charts and infographics left out).
2. Pick the scene from the subcategory: sneakers on a concrete ledge or plaza, running shoes on a waterfront path,
   loafers on a cafe terrace or lobby, slides on a pool deck. No landmarks, signs, other brands, alcohol, religious
   buildings or flags; women's legs covered to the ankle.
3. The generator draws one 2K 3:4 frame (1792x2400) from those packshots.
4. The gate checks it. On two failed attempts plus a failed try on the stronger fallback engine, switch to the
   composite (brand cut-out in a generated scene); if that also fails, hold with a reason [DD4 L253].
5. Crop by code for each channel around the product, place it last, flag it `generated`, record the cost.

**Gate and review** [DD4 L257-262; DD2 L170]:
- DD2's product checks G1 to G6 (shape, logo and text, colour, texture, consistency, crop) on the shoe region.
- Four scene checks: S1 framing by code (no face, frame top at or below the knee), S2 modesty, S3 scene safety,
  S4 product inside the centre square so every channel crop keeps it whole.
- Review-all by Naz until at least 100 labelled lifestyle images across at least 3 brands meet DD2's exit numbers
  (2% or fewer false passes, none on product identity or logos). After that, passing images publish without review
  [I06 L285-287].

**Reused from the module today:** the matte (cut-out), sole-strip recovery and contact shadow for the composite
[I06 L148]; the gate from initiative 5 [I06 L298]; channel crops, encoders, the links sheet and the cost ledger
[DD4 L225-228; I06 L238-239]. The generator returns pixels only; placement, size, background and encoding stay ours
[I06 L154-155].

**New:** the four scene checks and the scene table in the brand style profile; a full-frame render mode for
lifestyle; an exception so today's `leftover_background` hold does not fire on a lifestyle output; slot handling at
caps [DD4 L225-228]; the `brand_rights` record [I06 L299; DD8 L285].

**SPEC amendments needed** (owner edits SPEC.md):

| SPEC today | Change | Draft |
|---|---|---|
| "No generative edits or paid image APIs" [SPEC L837] | Allow generated images under spec 12, owner-approved generator, gated, flagged | [DD2 L161] |
| "No lifestyle-background option" [SPEC L840] | One lifestyle image per footwear or bag style-colour, rules as in section 6 | [DD4 L270-276] |
| "No cropping of any kind" [SPEC L841, L64] | Cropping amendment, plus: a generated lifestyle frame is cropped per channel around the product | [DD4 L278; P08 L510] |
| "No cap on images per product or per channel" [SPEC L841, L64] | Must change too, to allow caps | [P08 L512-513] |
| "No paid image API without a separate owner yes" [SPEC L55] | The generator yes (blocker 2) is that separate yes | [PROG L139] |

## 7. Dependencies and order

- **6.1a is not after 6.1b.** It is the same build with a different brand's confirmation. Whichever brand confirms
  in writing first goes first. If Campus or Keds confirms before US Polo, 6.1a runs first, because its reviewed
  images become the labels the gate needs (100 labelled images across at least 3 brands) before 6.1b can leave
  review-all [P08 L355-357, L460; DD4 L262].
- **Both wait on decision 2,** the generation package [P08 L101, L531].
- **Initiative 06 waits on initiative 5's gate** (built and labelled, generator in the slot) and **initiative 2's
  roles** (without roles, "already has a lifestyle photo" cannot be read, and the image cannot be placed last by role)
  [I06 L296-298; DD4 L289-291].
- **Not needed:** lifestyle does not wait on Noon and Namshi acceptance or the fact sheet; those gate the callouts
  [P08 L335].
- **6.2 composite as the fallback.** Inside 6.1a and 6.1b, the composite is the fallback for kids, bags with fewer
  than 3 views, embellished products and anything that fails the gate twice [I06 L105-108]. As its own line (6.2,
  4.2k base) it gives kids' pages and thin sets a scene with the product pixels identical, and it skips gate checks
  G1 to G4. It still needs the lifestyle and generation amendments, the generator yes, the vendor position and brand
  confirmation, so it is **not** a way around the generation package [P08 L344, L459].
- **What can start now at no cost:** sending the brand rights asks [P08 L70-71, L145, L349].
- **Older order replaced:** 07 put the whole of initiative 6 in Phase 3 as "lifestyle, then infographics" and asked
  US Polo first, then the other brands [R07 L511, L580-581]. 08 moves callouts ahead of lifestyle and sends all
  asks now [P08 L144-145, L349]. This doc follows 08.

## 8. Risks and mitigations

| Risk | Effect | Mitigation |
|---|---|---|
| Rights: US Polo has no written rights on file for generated images | About 99k of initiative 06's 116.9k base moves on US Polo's single answer | Ask first; nothing publishes without a `brand_rights` row [I06 L225, L260]. The owner states Opptra already holds written rights, so this may be a confirmation, not a negotiation [P08 L117; DD8 L70]; which brand sites the rights cover is open [DD8 L17] |
| Brand trust: generator redraws small text and logos | Wrong brand marks on a live page. Trial: a garbled tongue label on 1 of 2 US Polo sneakers | Logo and text check (G2); review-all until exit; composite fallback [I06 L179, L263] |
| Framing and modesty prompts followed loosely | Trial: 2 of 2 framed above the knee | S1 framing checked by code with a face detector; S2, S3; hold on fail [I06 L181, L264] |
| Quality gate not yet built | Without the gate, full generation stays review-all forever | Initiative 5 builds and labels it; only the composite could leave review on code checks alone [DD4 L291] |
| Lift may be zero | Revenue scales with a judged lift | Holdout cell 3; cut the row if it shows nothing [I06 L262, L276-282] |
| Image caps (Trendyol 8, Amazon 9) | About 470 Trendyol pairs need a size-chart swap or are skipped | Caps in initiative 2; owner sets priority [I06 L265] |
| Generated-image labels (Amazon synthetic-performer tag; Shein bans AI images that misrepresent items) | Rejections or policy exposure | Owner decides on labels; AI-generated metadata tag by default if agreed [I06 L266] |
| Brand photos leave our cloud for the generator | Data and contract exposure | Written no-training position per vendor before any live run [I06 L269] |
| Pages blocked by stock, size or price (71.4% of live stocked options sold nothing in 90 days) | Images earn nothing there | Target only live, stocked pages with no price or size reason [I06 L271] |

## 9. Cost and budget (only as stated)

- **Per image:** 0.1032 USD per full-generation attempt, 0.1015 per composite attempt, about 0.20 per accepted image
  (about 2 attempts) [DD4 L268].
- **Backlog (all of B4, 1,222 style-colours, 6.1a, 6.1b and 6.2 together):** 244.40 USD once at 0.20 per accepted
  image (126.11 if every image passes first time) [DD4 L268; I06 L231].
- **New styles:** about 260 USD a year for about 1,300 new footwear and bag styles [I06 L232].
- The split of these costs between 6.1b and 6.1a is **not given in the docs**.
- **Pacing:** the default daily spend cap of 10 USD paces a backfill unless the owner raises it [I06 L239].
- **Trial spend so far:** 0.206382 USD (2 US Polo sneakers) [I06 L169-170]; DD4's trial 1.80 USD [DD4 L308].
- **Agency comparison (not cash saved):** INR 500 to 800 per style-colour, 7.3k to 11.6k USD once for the backlog
  [I06 L246-249].

## 10. Definition of done and the success metric

**Done** when, for each brand that confirmed rights:
- every eligible live style-colour carries one lifestyle image as the last image on each channel where it fits the
  cap, flagged `generated`, logged in the treatment log [I06 L283-284; DD4 L262, L266];
- the quality gate has exited: at least 100 labelled lifestyle images across at least 3 brands meet DD2's exit
  numbers [I06 L285-287];
- zero channel rejections caused by the added image, read from the Noon and Namshi reason feeds [I06 L288-289];
- accepted-image cost near 0.20 USD in the cost ledger [I06 L290].

**Proof of progress:** 6.1b coverage rising from 1 of 20; 6.1a Campus and Keds coverage and labelled images toward
100 [P08 L343, L345].

**Success metric:** holdout cell 3 on US Polo footwear, lifestyle as the last image on Namshi and Noon, unit =
style-colour on one channel-country; primary metric ad conversion rate (CVR) on Namshi and Noon, Amazon unit session
% where sessions exist. Namshi can detect about a 15% relative lift per cell; a 1% lift is not detectable, so success
is a measured lift large enough to see, and the row is cut if the cell shows nothing [I06 L276-282].

## 11. Open owner questions

1. Will US Polo confirm in writing that existing rights cover generated images of its products? [P08 L530]
2. Do you approve the generation package, and will the vendor give a written no-training position? [P08 L531]
3. Does each pilot brand (Campus, Keds, Puma, French Connection, Vero Moda) allow generated lifestyle images under
   Opptra's written rights? [DD4 L305]
4. Which brand sites do your written rights cover? [DD8 L17, L285]
5. Who is the second rater beside Naz? [P08 L101]
6. Do studio worn shots count as lifestyle already present? [DD4 L302]
7. At the caps, may the lifestyle image replace the size chart? [DD4 L303]
8. Must generated images carry a label or an "AI-generated" metadata tag? [DD4 L304]
9. Can Naz ask the account managers for lifestyle rules on 6thStreet, Styli, Centrepoint, Shein and VogaCloset? [DD4 L306]
10. Is a frame above the knee acceptable for women's styles with legs fully covered? [I06 L326-327]
11. Will the agencies agree a bid, budget and price freeze for the holdout products? [P08 L548]

## 12. Sources

All paths relative to the worktree `docs/`.

| Code | Path | Lines used |
|---|---|---|
| P08 | plans/roadmap/08-reprioritization-proposal.md (primary) | 7-9, 24-29, 56-63, 70-73, 100-101, 105, 117, 145, 211, 335, 343-345, 349, 355-357, 456-460, 472-474, 510-513, 530-531, 548 |
| I06 | plans/roadmap/initiatives/06-richer-footwear-pages.md | 13, 35, 46, 55-61, 63-66, 83, 96-118, 148, 154-155, 169-181, 201-204, 212-213, 220, 225, 231-239, 245-252, 256-272, 276-290, 292-307, 309-327 |
| DD4 | plans/deep-dives/04-footwear-bags-lifestyle.md | 225-228, 240-268 (R1 to R6), 270-278 (R7), 280-294 (Depends on), 296-306 (Approval question, Q1 to Q6), 308 |
| DD2 | plans/deep-dives/02-derived-shots-fidelity-gate.md | 161 (R4 SPEC wording), 170 (gate bars and exit numbers) |
| DD8 | plans/deep-dives/08-brand-style-profile-model-registry.md | 17, 70, 285 |
| R07 | plans/roadmap/07-roadmap.md | 438-503 (initiative 6), 505-511 (phased view), 573-591 (decisions 3, 4, 5, 10) |
| M06 | plans/roadmap/06-metrics-and-impact.md | 147 (row B4), 324 (assumption 12) |
| PROG | plans/2026-10-21-catalog-connect-gcc-intent-map.md | 134-141 (8. Approval gates; Gate C L139, Gate D L140-141) |
| SPEC | SPEC.md (this branch) | 55, 64, 835-849 (Non-goals; L837, L840, L841). Main has moved them: L54, L75, L852-866 (L854, L857, L858) |

Status: draft for owner approval
