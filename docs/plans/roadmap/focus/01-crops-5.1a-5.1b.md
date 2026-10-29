# Focus 01 - Crops: 5.1a (crops for conversion) and 5.1b (crops completing the Styli and Centrepoint set)

> **Bottom line.** **What:** cut missing apparel photos (front, back, close-up, head and shoulders) out of bigger
> brand photos we already hold, no pixel changed, no AI. **Why:** 65 of 66 sampled products lack the five-photo set;
> 32.5k USD a year base (17.8k + 14.7k), cash cost about 0. **Blocks it:** the SPEC bans all cropping, and photo roles
> (2.6) are not built; 5.1b also needs Styli / Centrepoint specs and bigger masters. **Sign:** the cropping amendment
> (with the three fixes in section 6), the crop size bar, and the role rules. Note: the old Styli size floor was
> removed on 2026-10-22; section 6 says what that makes uncertain.

Date: 2026-10-26. Approval doc, documents only: nothing is built, no query and no paid call was run for it.
We are about to build this; this page holds everything needed to approve it. Every claim has a source in
section 12. Short codes: **08** = `roadmap/08-reprioritization-proposal.md` (primary source), **I5** =
`roadmap/initiatives/05-complete-apparel-shot-sets.md`, **DD2** = `deep-dives/02-derived-shots-fidelity-gate.md`,
**07** = `roadmap/07-roadmap.md`, **06** = `roadmap/06-metrics-and-impact.md`, **SPEC** = `docs/SPEC.md`.

**Words used (defined once).**
- **Role:** one required kind of photo. Styli and Centrepoint ask for five: **FM** front cropped mid-thigh, **FL**
  full length head to toe, **FC** fabric close-up, **BH** back cropped at the hips, **HS** head and shoulders [S1].
- **Derived shot (crop):** a new photo cut out of a larger brand photo of the same product, with no pixel changed.
  It is not a generated image [S1].
- **Crop size bar:** the smallest height a crop must have before we make it for a channel. DD2 proposes one per
  channel [S5]. It is a quality bar for crops only, not a SPEC rule: since 2026-10-22 main's SPEC has no channel
  size floors; its only floor is global: a source photo whose long side is under 500 px is held for a person [S44].
- **Master:** the brand's original, full-size photo file. **SPEC amendment:** an owner-approved change to
  `docs/SPEC.md`, the rule book of what the catalog module may do [S20].
- **Base / low / high:** extra revenue in USD a year: base is the best judged case, low the worst, high the best.
  Base is an estimate, not a measurement [S21].

## 1. In one paragraph

Almost none of our apparel has the full set of photos that shoppers and channels expect: 65 of 66 sampled products
lack the five-role set, and head and shoulders alone is missing on 57 of 66 [S2]. Many of those missing photos are
already hidden inside a bigger photo we hold. 5.1a cuts a missing front, close-up or head-and-shoulders out of a
larger photo of the same product, pixels unchanged, to help shoppers decide (conversion) [S3]. 5.1b uses the same
crops, from larger masters, to complete the five-role set so the product can be listed on Styli and Centrepoint at
all [S4]. No image generator, fidelity gate or brand rights are needed [S6].

**Before / after (real trial, nothing published) [S7]:**
- Before: Vero Moda / Only product `vm-ol/5715945917041` had four of the five roles; head and shoulders was missing.
  Its master is about 5000x6700 px.
- After: a head-and-shoulders crop, 1561x2082 px, cut from the full-length photo, pixels unchanged, cost 0. It clears
  Styli and Centrepoint without enlargement. The product goes from 4 to 5 roles.
- Where it does not work: Vero Moda `Z5C2F10C8828D6C235D33Z` has only 800x1096 photos; the crop would be about
  400 px tall, under every proposed crop size bar, so it is not made [S7].

## 2. Business impact (only figures already in the docs)

| Item | Low / base / high, USD a year | Cash or spend avoided | Source |
|---|---|---|---|
| 5.1a crops for conversion | 0 / 17.8k / 59.5k | 0 | [S3] |
| 5.1b crops completing the Styli / Centrepoint set | 0 / 14.7k / 28.8k | 0 | [S4] |
| Both, unlocked by the cropping amendment | 32.5k base (plus 0.97k ad money saved via the 3E crop route) | | [S8] |
| 3E hero shots by crop (rides on the same amendment) | revenue 0 here; ad money 0 / 0.97k / 2.13k | | [S9] |

- 5.1a is "the largest revenue item that your own decisions can unlock" [S10].
- Confidence: every lift is judged. Our own data shows no conversion gain from image count alone (options with 7 to
  8 images convert no better, CVR ratio 0.954), so the conversion lift was cut to 3% base; a Namshi holdout can
  detect about 15%, not 3% [S11]. The stronger case is listing eligibility (5.1b), which is directly countable [S12].
- How 17.8k and 14.7k were split from 06 rows B2 (22.5k) and B2e (25k) [S13]: the split formulas live in the split
  files 08 cites [S14]; those files are not in this worktree. Not re-derived here.
- Profit, margin and people time: not sized in the docs (excluded by rule) [S15].

## 3. Scope

| | 5.1a | 5.1b |
|---|---|---|
| Brands | French Connection, Penti, Vero Moda, Cardio Bunny; later Only and Anta [S16]. Not US Polo (footwear only) [S16] | Same apparel brands, where masters of 2,400 px or more arrive [S4][S17] |
| Channels | Every ticked channel whose proposed crop size bar the crop clears: Noon and Namshi 482 px, Amazon 667 px, Styli 741 px (with the x2 upscaler), Centrepoint 2,000 px [S5]. These values come from the old size rules; see section 6 | Styli and Centrepoint [S4] |
| Roles made by crop | FM, BH, HS, and FC from a flat lay or a no-skin fabric area [S5]. FL can never be cut [S18] | All five, where the source allows [S4] |
| Volume (sample-based) | 44 of 73 sampled lack a front, back or close-up [S3]; about 1,050 options (1,746 apparel options x 44/73) [S19] | About 663 options absent from Centrepoint and 893 from Styli [S12]. 08 also cites "92 of 141 have an image below 1,482 px" [S4], a count against the old Styli floor that was removed on 2026-10-22 (section 6) |

Out of scope: anything generated (5.2, 5.3), products with no model photo (11 of 66), and full length missing on
Penti (5 of 24), which cropping cannot fix [S18][S22].

## 4. Absolute blockers (must be true before work starts)

| # | Blocker | Owner | How to unblock | Blocks 5.1a / 5.1b |
|---|---|---|---|---|
| 1 | Cropping SPEC amendment approved (decision 9, question 10). SPEC forbids every crop today | Owner (Sujan, Nitin) | Say yes to DD2 R4's cropping wording, updated per section 6 | Both [S8][S23][S24] |
| 2 | Role taxonomy, channel rule table, caps and minimums, "cut product never image 1" approved (decision 6, question 6) | Owner | Say yes to I2 Q1, Q3, Q4 and DD0 with the SPEC output-order update | Both [S25][S26] |
| 3 | 2.6 shot roles built and shown: each photo gets a role and head state; 95% role accuracy, 100% on head cut | Dev; Ops labels the golden set | Build after blocker 2; name golden-set labellers | Both [S27] |
| 4 | 5.1a delivered | Dev | Finish 5.1a | 5.1b only [S4] |
| 5 | Styli and Centrepoint written image specs (from 5.0), incl. whether Styli accepts an on-model fabric crop and an upscaled image | Outside (channels); Ops channel managers ask | Send the asks now; asking is not blocked | 5.1b only [S28][S29][S30] |
| 6 | Brand masters of 2,400 px or more on the long side (how much this blocks depends on the crop size bar the owner sets, section 6) | Outside (brands); owner OKs the ask | Ask French Connection, Penti, Vero Moda, Cardio Bunny, Only, Anta | 5.1b only [S28][S31] |
| 7 | A listing route for Styli and Centrepoint (listing templates, agency or initiative 4) | Dev, brand and channel managers | Listed in 08's 5.1b row; see contradiction C4 | 5.1b only [S4][S32] |

## 5. Decisions the business must sign

- [ ] Yes / no: approve the cropping SPEC amendment (DD2 R4, updated as in section 6) [S24][S33].
- [ ] Yes / no: approve the crop rules in DD2 R1 (head whole, FC only from a flat lay or no-skin area, nothing below
  the crop size bar, every crop flagged and checked like any output) [S34].
- [ ] Choose: the crop size bar per channel. Keep DD2's values (Styli 741 px with the upscaler, Centrepoint 2,000,
  Amazon 667, Noon and Namshi 482) or set new ones, now that the SPEC has no Styli floor [S5][S44].
- [ ] Yes / no: approve the role taxonomy, rule table, caps and minimums and "cut product never image 1" [S26].
- [ ] Yes / no: move 5.1a from Phase 2 into Wave B (start as soon as blockers 1 to 3 hold) [S35].
- [ ] Yes / no: may we ask the six apparel brands for masters of 2,400 px or more [S31]?
- [ ] Yes / no: name who asks Styli and Centrepoint for written specs (5.0, Ops channel managers) [S29][S30].
- [ ] Yes / no: report 5.1b by listings and sales on Styli and Centrepoint, and drop the conversion row if no
  holdout cell shows an effect [S36].
- [ ] Yes / no: name who re-submits changed images in each portal (question 11) [S37].

## 6. How it will be built

**Steps.**
1. Roles first: 2.6 records a role per photo; today the pipeline stores no shot role, no derivation record and no
   generator record, only the judge's `view` inside its scores [S27][S38].
2. Planner, for each product, ticked channel and missing role: use an existing photo; else derive by crop; else
   "Not made" with a plain sentence on the links sheet, for example "Not made: the photo is too small to cut a head
   and shoulders from it" (generation is a later, separate step) [S39].
3. Crop rules: cut only from the same product with the head whole; cut line inside the role's band (FM mid-thigh,
   BH hips, HS below the bust), never through a logo, text or buckle; at least 5% margin above the head; BH only
   from a back photo, never a mirrored front [S5][S34].
4. Size check: make the crop only if its height clears the crop size bar the owner approves; no soft, enlarged
   crop [S5].
5. Record and check: each crop carries a `derived` flag, its parent photo and crop box, and passes every existing
   check (pixels copied, cut-out, compliance, the judge) [S5].
6. 5.1b: rerun the same planner on larger masters, aimed at the five Styli / Centrepoint roles [S4][S17].

**Reused:** the existing render, cut-out, compliance checks, judge and x2 upscaler; crop cost sits inside the
existing render cost [S5][S40]. **New:** role records (2.6), the planner, crop rules, the derivation record and the
"Not made" sentences [S41]. Order follows the India lesson: derive crops first, generate second [S42]. The Dev lane
order is 2.6, then 2.7 (channel rule release), then 5.1a [S43].

**SPEC amendments needed** (line numbers: this worktree / main) [S23][S24]:

| SPEC line today | Change (DD2 R4 draft) |
|---|---|
| L64 / L75 Styli: "Never crop." | End with "Never crop at render time; role derivation only under spec 12." |
| L121 / L131 R11 "Never cut any part of the product or model; pad instead of crop." | Add: a role derivation is a new source made by a rule-bound cut (head and logos whole), not a render-time crop |
| L841 / L858 Non-goal "No cropping of any kind" | Replace with "No cropping of a brand's photo except role derivation under spec 12" plus its conditions |
| L276 / L293 "Fit, never crop" (render rule) | Not named in DD2 R4; check it stays true because a crop is a new source, not a render step |

Three fixes to the draft before signing:
1. Drop "without enlargement beyond the existing cap": the owner removed the Styli enlargement cap on 2026-10-22
   (main SPEC L55-59) [S44][S45].
2. Write the crop size bar into the amendment itself. The draft says a crop must clear "the channel's size floor",
   but main's SPEC no longer has channel floors, only the 500 px global one [S44][S45].
3. Split the cropping text from the generation text: DD2 R4 replaces both non-goals in one edit, while 07 and I5
   stage them separately [S24][S33][S46].

**What the 2026-10-22 SPEC change makes uncertain (flagged, not re-sized).** Main's SPEC (PR #91) dropped the Styli
enlargement cap and its 741 px (with upscaler) / 1,482 px (without) floors. Any enlargement is now allowed on Styli,
and a soft photo gets a `low_resolution` note instead of being skipped [S44].
- **The 741 px Styli figure** in this doc is now only DD2's proposed quality bar for crops. Whether to keep it is an
  owner choice (section 5) [S5].
- **5.1b's "92 of 141 below 1,482 px"** was counted against the removed floor [S4][S55]. Under main's SPEC those photos
  are made on Styli with a soft-image note, not skipped. So "too small for Styli" is a weaker reason for 5.1b. The
  missing-roles reason (65 of 66 lack the five-role set) is unchanged [S2].
- **The 14.7k base was not re-sized.** It is a split of 06 rows B2 and B2e [S13]. The B2e formula uses absent options
  x value per option x a judged share, not the 92-of-141 count [S56]; the split itself cannot be checked (section 2).
  How the SPEC change affects 14.7k is unknown.
- **Whether Styli accepts enlarged, soft images** is still unknown: Styli rejections carry no size-versus-softness
  information [S57]. Asking Styli in writing (blocker 5) matters more now.
- **Bigger masters (blocker 6)** still help crop quality and Centrepoint's 2,000 px. Whether they still block 5.1b
  depends on the crop size bar chosen.

## 7. Dependencies on other initiatives

| Depends on | Why | Source |
|---|---|---|
| 2.6 shot roles (initiative 2) | The planner must know which role is missing; gates 5.1a and 5.1b | [S27] |
| 2.7 channel rule release | Comes before 5.1a in the Dev lane | [S43] |
| 5.0 Styli and Centrepoint eligibility (Wave A) | Written specs that 5.1b needs; opens 5.1b's 14.7k | [S28][S47] |
| 1.9 treatment log (initiative 1) | No lift can be proved without it; content-to-sales join is 13% today | [S48] |
| 2.8 re-submission route | A new image at the same link is not picked up until re-submitted | [S37][S49] |
| Not needed | Generator, fidelity gate, brand rights, vendor position, US Polo, Noon / Namshi callout acceptance | [S3][S6][S50] |

## 8. Risks and mitigations

| Risk | Evidence | Mitigation | Source |
|---|---|---|---|
| Photos too small to crop | On 800x1200 originals every derived crop fails DD2's Styli crop bar | Ask for 2,400 px masters; "Not made" with a sentence, never a soft crop | [S18][S34] |
| Channels do not accept crops | Styli's view on an on-model fabric crop and Centrepoint's spec are unknown | Ask both in writing first | [S29] |
| Conversion lift may be near zero | No image-count effect in our data; holdout detects about 15%, not 3% | Report 5.1b by listings; drop the conversion row if no cell shows an effect | [S11][S36] |
| Wrong role or cut head | Nobody can see a cut face today except by eye | 2.6 at 100% on head cut; cut product never image 1 | [S27][S26] |
| Small audit sample | 66 apparel products, one reviewer, about plus or minus 3 | Replace with role tags on every product | [S51] |
| Styli / Centrepoint sales not visible | Not in the liveness feed today | Needs their listing data | [S12] |

## 9. Cost and budget (only as stated in the docs)

- 5.1a and 5.1b: cash 0 [S3][S4]. Derived crops: about 0, inside the existing render cost of about 0.0119 USD per
  style on all channels [S40].
- Initiative 05's 74 USD run cost and 1.5k to 2.4k USD spend avoided are for generated parts only; crops are not
  generation and are not counted [S52].
- A separate crop budget: not sized in the docs.

## 10. Definition of done and success metric

- **5.1a done:** crops made by the rules above for every product and ticked channel where a source clears the
  approved crop size bar;
  every crop flagged `derived` with parent and crop box and passing all existing checks; every gap left shows a
  "Not made" sentence [S5][S39]. **Metric:** share of products with each role, made by crop [S3].
- **5.1b done:** **metric:** options with all five roles by crop, and options newly live on Styli and Centrepoint
  [S4], out of about 663 and 893, against about 115 and 25 USD per listed option a year [S12].
- **Baseline:** five-role set on 2% of sampled apparel (1 of 66) [S53]. Conversion is read on a Namshi apparel
  holdout [S11].

## 11. Open owner questions

1. Cropping SPEC amendment yes / no (08 question 10) [S24]?
2. Role taxonomy and rule table yes / no (08 question 6) [S26]?
3. Will Styli and Centrepoint give written specs, and will brands send 2,400 px masters (08 question 12) [S28]?
4. Who asks Styli about an on-model fabric crop and an upscaled image, and Centrepoint for its spec (I5 Q4) [S29]?
5. Who re-submits changed images in each portal (08 question 11) [S37]?
6. Does 5.1b need listing templates (08's 5.1b row says yes; its Wave C row and question 12 do not) [S4][S32]?
7. Who labels the golden set for 2.6 [S27]?
8. Which crop size bar applies now that the SPEC has no Styli floor: DD2's values, or new ones [S5][S44]?

**Contradictions found between sources.**
- C1 Timing: I5 and 07 put the cropping amendment in Phase 2; 08 moves 5.1a to Wave B. 08 is still a proposal
  awaiting owner review [S35][S46][S54].
- C2 Draft SPEC wording is stale on enlargement: DD2 R4 says "without enlargement beyond the existing cap" and "the
  channel's size floor"; main SPEC removed the Styli cap and floors on 2026-10-22 [S44][S45].
- C3 DD2 R4 amends cropping and generation in one edit; 07 and I5 stage them separately [S24][S33][S46].
- C4 5.1b blockers: 08's 5.1b row lists listing templates; Wave C row C7 and question 12 list only specs and masters
  [S4][S28][S32].
- C5 SPEC line numbers in the deep dives (L64, L121) are this branch's older SPEC; main has moved them (L75, L131)
  [S23].
- C6 08's 5.1b row and I5 still cite the 1,482 px Styli floor (92 of 141); main SPEC removed it [S4][S44][S55].

## 12. Sources

| # | Claim | Path : line |
|---|---|---|
| S1 | Roles; derived shot defined | I5 L14-16 |
| S2 | 65 of 66 lack set; HS missing 57 of 66 | I5 L24-25, L42-43; 07 L376-378 |
| S3 | 5.1a row: what, value, cash 0, deps, metric | 08 L314; 08 L59 |
| S4 | 5.1b row: what, value, deps, metric | 08 L315; 08 L60 |
| S5 | Crop rules, floors, `derived` flag, checks | I5 L125-140 |
| S6 | No generator, gate or rights needed | 08 L56-63, L67-68 |
| S7 | Before / after example | I5 L74-75, L208-209, L227-228 |
| S8 | Decision 9: cropping unlocks 32.5k | 08 L108 |
| S9 | 3E crop route | 08 L253, L404 |
| S10 | Largest owner-unlockable item | 08 L69 |
| S11 | Judged lift; no image-count gain; holdout 15% | 08 L71-75; I5 L56-58, L323-324 |
| S12 | Eligibility countable; 663 / 893; per-option values; not in feed | I5 L58, L102-103, L320-322 |
| S13 | 06 rows B2 and B2e | 06 L144, L145 |
| S14 | Split files hold split formulas | 08 L11-15 |
| S15 | People time and margin excluded | I5 L269 |
| S16 | Brands served; not US Polo | I5 L89-93; 08 L308 |
| S17 | 2,400 px masters lever | I5 L141-143; DD2 L135 |
| S18 | FL cannot be cut (Penti 5 of 24); 800x1200 fails Styli | DD2 L8, L10 |
| S19 | About 1,050 options | I5 L260 |
| S20 | SPEC amendment defined | 08 L24-26 |
| S21 | Base / low / high defined | 08 L19-20 |
| S22 | 11 of 66 no model photo | I5 L46-47 |
| S23 | SPEC crop bans | SPEC (worktree) L64, L121, L276, L841; main L75, L131, L293, L858 |
| S24 | Cropping amendment draft; owner question 10 | DD2 L157-164; 08 L539 |
| S25 | Decision 6 | 08 L105 |
| S26 | Owner question 6 | 08 L535 |
| S27 | 2.6 roles, accuracy bars, labellers | 08 L211, L392 |
| S28 | Owner question 12; Wave C row C7 | 08 L541, L438 |
| S29 | Styli / Centrepoint acceptance risk and ask | I5 L309, L353-354 |
| S30 | 5.0 row (Ops, Wave A) | 08 L313 |
| S31 | Ask brands for masters (I5 Q3) | I5 L351-352 |
| S32 | 5.0 listing route | 08 L313 |
| S33 | 07 staged amendments | 07 L578-579 |
| S34 | DD2 R1 derivation rules; approval question | DD2 L129-135, L168-170 |
| S35 | 5.1a moves to Wave B; row B4 | 08 L140, L395 |
| S36 | Report B2e by listings; drop B2 row | I5 L359-360 |
| S37 | Owner question 11 (re-submission) | 08 L540, L109 |
| S38 | No role or derivation record today | DD2 L36 |
| S39 | Planner and "Not made" | I5 L113-123 |
| S40 | Crop cost inside render cost | I5 L264 |
| S41 | Build planner, crop rules, role records | I5 L190 |
| S42 | India: derive first, generate second | 04-india-learnings L194 |
| S43 | Dev lane order 2.6, 2.7, 5.1a | 08 L471 |
| S44 | Owner removed Styli enlargement cap and floors; only the 500 px global floor | SPEC (main) L55-59, L121-123; I5 L136-138 |
| S45 | Draft says "existing cap" | DD2 L162 |
| S46 | I5 Phase 2 for cropping | I5 L333, L344, L348 |
| S47 | 5.0 opens 5.1b's 14.7k | 08 L125 |
| S48 | Treatment log needed for any lift | 08 L127; I5 L337 |
| S49 | Re-submission defined | 08 L31-32 |
| S50 | No US Polo, no callout dependency | 08 L308-309 |
| S51 | Small sample risk | I5 L312 |
| S52 | Run cost and spend avoided are generation only | 08 L307-308; I5 L262, L286 |
| S53 | Baseline 2% (1 of 66) | I5 L99 |
| S54 | 08 status: proposal awaiting review | 08 L550 |
| S55 | 92 of 141 below Styli's 1,482 px floor | I5 L53; 08 L315 |
| S56 | B2e formula (absent options x value x share) | I5 L249; 06 L145 |
| S57 | Styli rejections carry no size-versus-softness information | SPEC (main) L43-44 |

Status: draft for owner approval
