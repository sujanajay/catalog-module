# Focus 02 - Generated apparel shots: 5.2 missing roles (mode A) and 5.3 flat lay to on-model (mode B)

> **Bottom line.** **What:** where a crop cannot fill a missing apparel photo, an AI image generator makes it from the
> brand's own photos (5.2), or puts a flat-lay garment on the brand's real model, Vero Moda first (5.3). **Why:**
> about 15.8k USD a year base (8.6k + 7.3k, judged); the most countable effect is new listings on Styli and
> Centrepoint. **Blocks it:** the SPEC
> bans generation and cropping; no generator yes, vendor data position, gate bars or modesty policy yet; 5.3 also
> needs model rights and the model registry. **Sign:** the generation package (decision 2), the modesty policy and,
> for 5.3, the registry and which brand sites the rights cover.

Date: 2026-10-26. Status: for business approval. Documents only; nothing is built. Every number is copied from
the sources in section 12 with a pointer; nothing here is a new estimate. No time or effort figures (owner rule,
08 L7-9). Path prefix for every pointer: `docs/plans/` unless it says `docs/SPEC.md`.

**Short source names.** 08 = `roadmap/08-reprioritization-proposal.md` (primary). I5 =
`roadmap/initiatives/05-complete-apparel-shot-sets.md`. 07 = `roadmap/07-roadmap.md`. 06 =
`roadmap/06-metrics-and-impact.md`. DD2, DD3, DD8 = `deep-dives/02-`, `03-`, `08-`. IM = the program doc
`2026-10-21-catalog-connect-gcc-intent-map.md`. SPEC = `docs/SPEC.md`.

**Words used (defined once).**
- **Role:** one required kind of photo. Styli and Centrepoint ask for five: FM front cut at mid-thigh, FL full
  length head to toe, FC fabric close-up, BH back cut at the hips, HS head and shoulders (I5 L14-15).
- **Generated shot:** a new photo made by an image generator (an AI model that draws images) from the brand's own
  photos (I5 L17-18). **Crop / derived shot:** a new photo cut from a larger brand photo, no pixels changed (I5 L16).
- **Mode A:** generate a missing role from the product's existing on-model photos. **Mode B:** put a flat-lay
  garment (photographed lying flat, no person) on one of the brand's real models (I5 L18-19).
- **Fidelity gate:** six measured automatic checks every generated shot must pass, or it is held (I5 L166-177).
- **Review-all:** a person sees every generated image before it publishes (08 L27-28).
- **SPEC amendment:** a change to `docs/SPEC.md`, the rules file for the catalog module; only the owner can make it
  (08 L24-26).
- **Anchor:** in mode B, the first full-length shot a person approves; the other roles are made from it (DD3 L173).
- **Registry (DD8):** a record of the brand's real models, the written rights behind them and approved photo packs
  (DD8 L175-215).

## 1. In one paragraph

Some apparel cannot get a full photo set by cropping: the photos are too small, or there is no full-length view, or
there is no model photo at all. 5.2 (mode A) generates only the missing role from the product's own photos (I5
L120-121; 08 L316). 5.3 (mode B) puts a flat-lay garment on the brand's registered real model, Vero Moda first (08
L317; I5 L155-160). Every generated shot passes the six-check gate and a person approves it before it can publish
(I5 L168-181).

**Before / after (real audit examples, I5 L72-80, L206-228).**

| Product | Before | After (planned) |
|---|---|---|
| Vero Moda `vero-moda/Z5C2F10C8828D6C235D33Z`, 800x1096 photos | Has FM, FL, BH, FC; HS missing. A crop would be about 400 px, below every proposed crop size bar (F01 s6) | 5.2 generates HS from all 5 brand photos. In the trial it was **held** by the gate (head too close to the top edge), which is the gate doing its job |
| Vero Moda / Only `vm-ol/5715946612846`, 2 flat lays | No model photo; can never list on Styli or Centrepoint by cropping | 5.3 generates a full-length anchor on the brand model; a person approves it; then FM, BH, HS are made; FC is a crop of the flat lay. In the trial the anchor was **held** for a colour shift |

## 2. Business impact (only figures in the docs)

| Item | 5.2 Generated missing roles | 5.3 Flat lay to on-model | Source |
|---|---|---|---|
| Extra revenue, USD a year (low / base / high) | 0 / 8.6k (8.55k) / 23.2k | 0.9k / 7.3k (7.27k) / 16.0k | 08 L316-317, L457-458 |
| Agency spend avoided, once (not cash paid today) | 1.30k to 2.09k (net 1.26k to 2.04k) | 179 to 286 (net 149 to 256) | 08 L316-317; I5 L280-281 |
| Ad money saved | not sized in the docs for 5.2 alone | B3 row: 0.3k (0.7k high), comparison only, never added | I5 L253-254 |
| Cash saved | 0 (initiative 05 has no cash line) | 0 | 08 L307 |

- Together 5.2 and 5.3 are about 15.8k of the 75.6k base that waits on the generation package (08 L63, L101).
- Every lift is judged, not measured (08 L19-20). Our own data shows no conversion gain from image count alone (I5
  L56-58). A holdout (a test that compares fixed and unfixed products) detects about a 15% lift, not 3%, so the
  conversion part may never be provable (I5 L310, L323-324).
- The strongest, most countable effect is new listings on Styli and Centrepoint: about 663 apparel options absent
  from Centrepoint and 893 from Styli (I5 L44-45, L320-322).
- See section 11 Q8: the 7.3k for 5.3 is larger than the B3 row (3.1k base) it comes from (06 L146).

## 3. Scope

| | 5.2 (mode A) | 5.3 (mode B) | Source |
|---|---|---|---|
| Brands | Apparel: French Connection, Penti, Vero Moda, Cardio Bunny; later Only, Anta. Not US Polo (footwear only) | Vero Moda first. Mode B is mainly for Vero Moda, French Connection, Nautica, Cardio Bunny, Penti sleepwear, Puma apparel | I5 L89-93; 07 L388-390; DD8 L64 (F1 notes) |
| Channels | Each channel ticked in a batch; the role-set gap and listing effect are on Styli and Centrepoint | Same | I5 L115-117, L84-85 |
| Roles | Only the role the channel needs and the photos do not give; often HS; FL on Penti (cannot be cropped) | FL anchor first, then FM, BH, HS; FC is a crop of the flat lay | I5 L48-50, L155-160 |
| Volume (06 counts) | About 1,050 options x 5/24 = 219 images | About 30 options x 5 shots | I5 L260-261, L183 |
| Volume (DD9 counts) | 160 | 121 style-colours, 605 images | I5 L263, L283 |
| Excluded until policy | Penti intimates, swimwear, lingerie | Same, plus any brand with no approved model | I5 L306; DD8 L168-173 |

Apparel with no model photo: 11 of 66 sampled (17%); Vero Moda 3 of 12 (25%) (I5 L46-47). The first backlog is about
369 generated images, enough to reach the gate's 300-shot exit inside this initiative (I5 L182-184).

## 4. Absolute blockers (must be true before work starts)

| # | Blocker | Owner | How to unblock | 5.2 | 5.3 |
|---|---|---|---|---|---|
| 1 | Generation SPEC amendment. SPEC bans "generative edits or paid image APIs" and says "no paid image API without a separate owner yes" | Owner | Approve DD2 R4 wording (and the registry wording in DD8 L281 for 5.3) | yes | yes |
| 2 | Cropping SPEC amendment. SPEC bans "cropping of any kind" and R11; mode B's FC is a crop and the planner crops before it generates | Owner | Approve DD2 R4 second bullet and the R11 / Styli line edits | yes (planner) | yes |
| 3 | Generator yes, recorded in writing (Gate C) | Owner | Answer DD3's approval question | yes | yes |
| 4 | Written vendor no-training / data position (brand photos leave our cloud) | Vendor writes; owner asks | Request it before any live run | yes | yes |
| 5 | Gate bars, exit numbers and a named second rater | Owner | Answer DD2 approval (b); name the second rater | yes | yes |
| 6 | Modesty policy for GCC (swimwear, lingerie, intimates; accessories kept from the model photo) | Owner | Answer I5 Q7 | yes | yes |
| 7 | Written real-model rights covering the brand's sites (Vero Moda first) | Owner, brand | Confirm which sites the rights cover (veromoda.com and others) | no | yes |
| 8 | DD8 registry built and a Vero Moda model pack approved | Owner approves schema; Dev builds; Naz approves pack | Answer DD8 approval question | no | yes |
| 9 | Colour check fair to mode B (on-body shading vs flat-lit flat lay) | Dev, from labelled mode B shots | Include mode B shots in the labelled set before fixing the colour bar | no | yes |
| 10 | Shot roles recorded per photo (initiative 2, item 2.6) | Owner (role taxonomy), Dev | Decision 6 in 08 | yes | yes |

Sources: rows 1-6 08 L101, L316, L531; SPEC L55, L837-841 (main L54, L854-858); IM L139. Row 2 DD2 L157-164; I5 L333; DD3 L173.
Row 7-9 08 L317, L458; I5 L307, L236-238; DD8 L285. Row 10 I5 L336; 08 L105, L211.

## 5. Decisions the business must sign

- [ ] Yes / No: approve the generation package (generation SPEC amendment, generator, gate bars, second rater,
  vendor no-training position) (08 L531, decision 2).
- [ ] Yes / No: approve the DD2 R4 SPEC wording, including the cropping part (DD2 L157-166).
- [ ] Yes / No: approve one bought, swappable generator for both modes, with a stronger escalation step, at 0.10 USD
  per generated image and 0.20 per accepted image (DD3 L180).
- [ ] Yes / No: approve the gate's initial bars and the exit from review-all: at least 300 labelled shots, 2% or
  fewer false passes, none on garment identity or logos (DD2 L170).
- [ ] Name: the second rater (I5 Q2, L349-350).
- [ ] Yes / No: brand photos may go to the generator vendor, only after a written no-training position (I5 Q5, L355).
- [ ] Yes / No: exclude swimwear, lingerie and intimates (Penti) from generation (I5 Q7, L357).
- [ ] Yes / No: a generated shot may keep accessories the reference model wears (I5 Q7, L357-358).
- [ ] Yes / No and list: which brand sites the written rights cover for real-model references, Vero Moda first
  (I5 Q6, L356; DD8 L285).
- [ ] Yes / No: approve the DD8 registry, the harvester, and "real brand models first, synthetic only as fallback"
  (DD8 L285).
- [ ] Yes / No: accept that 5.2 and 5.3 value is reported by listings and sales on Styli and Centrepoint, and that a
  conversion claim is dropped if no holdout cell shows an effect (I5 Q8, L359-360).

## 6. How it will be built

**The planner, per product and channel** (I5 L113-123): for each missing role take the first path that works: (1)
an existing photo, (2) a crop, (3) generate (mode A; or mode B for flat-only products), (4) "Not made" with a plain
reason on the links sheet, for example "No approved brand model for Vero Moda women yet".

**Generator, described by role only.** One bought image generator through the image API gateway the module already
uses, swappable. A stronger escalation generator is the last rung of the retry ladder. A flat-lay-to-model
specialist is the second choice, and a virtual-model service third only if it beats both on our gate (I5 L147-149,
L192; DD3 L171). Generator ids live in policy and logs, never in operator copy (07 L396-397; AGENTS.md).

**5.2 mode A steps** (I5 L153-155; DD3 L172): references are every brand photo of the same product that shows the
garment; the missing role is described in the role's framing band; the prompt forbids adding, moving or restyling
any logo, label, print or text, and forbids more skin than the references.

**5.3 mode B steps** (I5 L156-160; DD3 L173; DD8 L166-173):
1. Pick the brand's approved model: real model from the brand's site first, brand-supplied second, approved
   synthetic model sheet only as fallback. No approved model means no generation offered.
2. Generate FL from the flat lay(s) plus one model photo.
3. A person approves FL as the anchor. The anchor is the one shot a person always sees before the set is made.
4. Generate FM, BH, HS with the anchor as a third reference; FC is cropped from the flat lay.

**Gate checks (all six must pass, no averaging)** (I5 L168-177; DD2 L137-148):

| Check | What it tests | Initial bar |
|---|---|---|
| G1 garment identity | Same garment as the brand photo; two AI judges agree | similarity 0.85 same view, 0.70 cross view |
| G2 logo and text | Same text read on output; no invented text | every region; zero invented |
| G3 colour | Colour difference on the 3 main garment colours | mean 3.0 or less, each 5.0 or less |
| G4 texture and print | Fabric patches look the same | per patch bar 0.35 or less |
| G5 model and scene | Same person, lighting, background, anatomy; no face data stored | all pass |
| G6 crop geometry | Head whole with 5% margin, cut in the role band, 3:4 frame | pass |

Failing shots retry up to two more times, then the hold stands (DD2 L148; DD3 L171).

**Human review** (I5 L179-184; DD2 L150-155): every generated shot is held for a person (decisions `use_as_is` or
`remove`) until, on at least 300 labelled shots over 3+ brands and all five roles: false passes 2% or less with zero
on G1 and G2, false holds 15% or less, planted defects caught 100%, rater agreement 0.67 or more. Two raters label
blind; a third settles disagreements. After exit, 10% sampled review per batch; over 2% false passes sends the brand
back to review-all.

**Reused vs new** (I5 L188-194, L335-340):
- Reused: colour, texture and text measures and the two-model judge that already exist; the x2 upscaler (live); the
  existing key and spend caps; the cost ledger.
- New: the planner and role records; one image-generation call (the current client only does chat, DD3 L175)
  behind the LIVE_SMOKE gate; one garment-similarity measure; the review card; the `generated` flag and `gen_key`
  record; for 5.3, the DD8 registry tables and harvester.

**SPEC amendments** (DD2 L157-166; DD8 L281):
- Replace the "No generative edits" and "No cropping of any kind" non-goals (SPEC L837, L841; main L854, L858) with the DD2 R4 wording.
- Amend R11 (SPEC L121; main L131) and the Styli "Never crop" line (SPEC L64; main L75).
- Add: no face recognition and no stored face embeddings.
- For 5.3, add the DD8 registry wording: model photos only from sites with a recorded written grant, stored
  privately, never published.

## 7. Dependencies on other initiatives

| Depends on | Why | Source |
|---|---|---|
| 2.6 shot roles shown (initiative 2) | The planner must know which role is missing | I5 L336; 08 L211 |
| 1.9 treatment log (initiative 1) | Ties each published image to sales | I5 L337; 08 L177 |
| 5.1a crops (cropping amendment) | Crop first, generate only where crops fail; keeps review small | I5 L119-121, L311; 08 L326 |
| 5.0 / 5.1b Styli and Centrepoint written specs | Whether they accept generated or upscaled 2K shots decides the listing value | I5 L309, L342 |
| 6.1a / 6.1b lifestyle | Share the generation package and gate; Wave D together | 08 L101, L456-460 |
| 5.3 depends on 5.2 | 5.3 needs all of 5.2 plus rights, registry, colour check | 08 L317, L458 |

## 8. Risks and mitigations

| Risk | Evidence | Mitigation | Source |
|---|---|---|---|
| Garment changed subtly (brand trust, returns) | Mode B trial colour 7.68 vs bar 5.0; both trial shots looked right but were caught by measures | G1 and G3 with two judges; review-all until exit | I5 L304, L231-235 |
| Prints and logos redrawn | Prints redrawn on 7 of 7; letter spacing changed | G2 and G4; start with plain garments; printed items stay crop-only until bars come from labels | I5 L305 |
| Modesty (GCC) | Swimwear and lingerie not probed; most Penti and Cardio Bunny photos ruled out | Prompt forbids more skin; review-all; exclusions until owner policy | I5 L306 |
| Rights to a real person's likeness | Only Puma and a USPA Kuwait store are GCC sites; Cardio Bunny bans AI bots | Written rights per brand and site before any mode B run; synthetic fallback approved and versioned | I5 L307; DD8 L17, L22 |
| Brand photos leave our cloud | Generators are US or Google hosted; abuse logs kept "for a limited period" | Written vendor data position first | I5 L308 |
| Channels refuse generated shots | Styli and Centrepoint acceptance unknown | Ask both in writing first; 4K for Styli if needed | I5 L309 |
| Quality gate not yet proven | Exit numbers unmeasured; colour bar unfair to mode B | Labelled set includes mode B; final bars from labels | DD3 L176; I5 L236-238 |
| Review capacity | About 1,300 manual images a year vs about 3,400 backlog | Crop first; batch per brand; exit only by DD2 numbers | I5 L311 |
| Value not provable | No image-count effect; holdout detects about 15% | Report listings and sales; drop conversion row if no effect | I5 L310 |

## 9. Cost and budget (as stated in the docs)

| Item | 5.2 | 5.3 | Source |
|---|---|---|---|
| Run cost, one-off (06 counts) | 44 USD (219 images x 0.20) | 30 USD (about 30 sets x 1.00) | I5 L260-261 |
| Run cost at DD9 counts | 32 USD | 121 USD (605 images x 0.20) | I5 L263 |
| Per image | 0.10 USD generated, 0.20 per accepted (two attempts on average) | mode B about 0.80 per product (DD3) or 1.00 per 5-shot set (06) | DD3 L174; I5 L106, L261 |
| Gate compute | under 1 USD for 369 shots (shared) | | I5 L265 |
| Vendor trial before buying | up to 7.50 USD (specialist minimum pack) | | I5 L267 |
| Recurring for new styles | not sized in the docs | | I5 L266 |
| People time (review) | excluded by rule | | I5 L269 |

Trial spend so far: DD3 bake-off 5.39 USD of a 50 USD cap; I5 example 0.2064 USD of a 3 USD cap (DD3 L153; I5
L212-213). Spend per batch stays under the existing cap (I5 L325).

## 10. Definition of done and success metric

**Done for 5.2:** generated roles publish only through the gate and review; accepted shots per batch and false-pass
and false-hold rates are reported (08 L316); exit from review-all happens only on the DD2 numbers (I5 L318-319).
**Done for 5.3:** approved anchors exist; Vero Moda products go from 0 to a full set (08 L317).

**Success metrics** (I5 L314-326):
- Share of apparel with the five-shot set, from 2% (1 of 66), split by crop vs generated, with "not made" reasons.
- Options newly live on Centrepoint and Styli out of about 663 and 893, and their sales vs 115 and 25 USD per option.
- Gate quality on 300+ labelled shots at the DD2 bars.
- Cost per accepted image in the ledger vs 0.20 USD.
- Every published image in the treatment log with role, `generated` flag and position.

## 11. Open owner questions

1. Generation package yes (08 L531)? Cropping amendment yes (I5 Q1, L348)?
2. Gate bars, exit numbers, and who is the second rater (I5 Q2, L349-350)?
3. May brand photos go to the vendor, with a written no-training position first (I5 Q5, L355)?
4. Which brand sites do the written rights cover, starting with Vero Moda (I5 Q6, L356; DD8 L285)?
5. Modesty: exclude swimwear, lingerie, intimates; may accessories from the reference model stay (I5 Q7, L357-358)?
6. Who asks Styli about upscaled 2K and generated shots, and Centrepoint for its spec (I5 Q4, L353-354)?
7. Report value by listings and sales, dropping conversion if no effect (I5 Q8, L359-360)?
8. Source gap to resolve: 5.3's 7.3k base (08 L317) vs B3's 3.1k base (06 L146; I5 L250). 08 says splits live in
   "split files" (08 L11-15) that are not in this repo, so the extra 4.2k cannot be traced here.
9. Mode B is not covered by the DD2 R4 wording as drafted: it allows generation "only from the brand's own photos of
   the same option" (DD2 L161), but mode B also uses a model photo wearing a different garment (DD3 L173). Does the
   DD8 registry wording (DD8 L281) close this, or does R4 need a mode B clause?

## 12. Sources

| Claim area | Path and lines |
|---|---|
| Blocker table, generated row 75.6k | roadmap/08-reprioritization-proposal.md L56-63 |
| Decision 2 generation package | roadmap/08-reprioritization-proposal.md L101, L531 |
| 5.2 and 5.3 rows, initiative 05 totals | roadmap/08-reprioritization-proposal.md L305-329 |
| Wave D rows D2, D3; lanes | roadmap/08-reprioritization-proposal.md L452-462, L470-473 |
| Words, judged lifts | roadmap/08-reprioritization-proposal.md L17-35 |
| Roles, modes, evidence, examples | roadmap/initiatives/05-complete-apparel-shot-sets.md L14-21, L39-58, L72-93 |
| Planner, generator choice, gate, review | roadmap/initiatives/05-complete-apparel-shot-sets.md L113-194 |
| Trial example | roadmap/initiatives/05-complete-apparel-shot-sets.md L196-240 |
| Revenue, run cost, agency cost | roadmap/initiatives/05-complete-apparel-shot-sets.md L244-298 |
| Risks, measures, dependencies, owner questions | roadmap/initiatives/05-complete-apparel-shot-sets.md L300-360 |
| Gate bars, review protocol, SPEC wording, approval | deep-dives/02-derived-shots-fidelity-gate.md L137-170 |
| Generator recommendation, costs, unproven items, approval | deep-dives/03-on-model-generation-bake-off.md L153, L169-178 |
| Real-model rule, schema, SPEC wording, approval | deep-dives/08-brand-style-profile-model-registry.md L13-23, L37, L64, L70, L164-215, L281-285 |
| Initiative 5 summary, owner decisions | roadmap/07-roadmap.md L373-419, L573-593 |
| B2, B2e, B3 rows | roadmap/06-metrics-and-impact.md L143-146 |
| Gates C and D | 2026-10-21-catalog-connect-gcc-intent-map.md L134-141 |
| SPEC bans | docs/SPEC.md L55, L64, L121, L835-841 (main: L54, L75, L131, L852-858) |
