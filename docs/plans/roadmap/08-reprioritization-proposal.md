# 08 - Re-prioritization proposal: sub-initiatives, waves and the decisions that unlock them

Date: 2026-10-26. Documents only; nothing was built, no query and no paid call was run for this file. It pools the
sub-initiatives of all six initiatives and re-ranks them from first principles. It changes nothing in 00 to 07; the
repo changes it would imply are listed in section 4 for the owner to accept or reject.

**Binding rule (owner).** No time, duration or effort of any kind appears here, not even effort classes, and nothing
is ordered by how easy it is. Order comes only from three things: the impact (value) a piece brings, the pain it
removes, and what it depends on or is blocked by.

**Sources.** The three split files written for this proposal (agent A: initiatives 01 and 02; agent B: 03 and 04;
agent C: 05 and 06), which in turn cite `initiatives/01` to `06`, `06-metrics-and-impact.md` (06), `07-roadmap.md`
(07), the deep dives DD0 to DD10, and `docs/SPEC.md` "Non-goals". Every value below is copied from those files
unchanged; where a value is a split of an 06 row, the split formula is in the split files and the totals reconcile
in section 3.

**Words used here (defined once).**

- **Base / low / high:** the impact model's best judged, worst and best case of extra revenue, in USD a year (06).
Base is an estimate, not a measurement; every lift is judged.
- **Cash saved:** money we pay today that stops. **Spend avoided:** money we would otherwise pay but do not pay today
(agency generation prices). **Ad money saved:** ad spend saved at the same ad sales. These three are never added to
revenue or to each other.
- **SPEC amendment:** a change to `docs/SPEC.md`, the rules document that says what the catalog module may and may
not do. Its "Non-goals" list today forbids cropping, image generation, lifestyle backgrounds and template features.
Only the owner can amend it.
- **Fidelity gate:** the automatic checks plus a person's review that make sure a generated image did not change the
product, colour or logo. "Review-all" means a person sees every generated image before it publishes.
- **Holdout:** fix half of a matched set of products, leave the other half, compare conversion.
- **Treatment log:** a record of which image went live where and when, so a change can be tied to sales.
- **Re-submission:** uploading a changed image to a marketplace portal; a new image at the same link is not picked up
until it is re-submitted.
- **Callout (infographic):** the brand's photo with 2 to 4 labelled pointers naming product features, drawn by code.
- **p2p:** `sku_master_p2p`, Opptra's own product master with confirmed features for some brands.
- **Liveness:** share of stocked listings that are live on a channel.

**Lanes (who does the work).** **Dev** = catalog module dev team. **Data** = data team that owns the gcc-dashboard
pipelines. **Ops** = Naz and ops (incl. Vishnu, Siva, Tarannum, sheet owners, channel managers). **Mkt** = marketing
and the ad agencies. **Owner** = owner decisions (Sujan, Nitin). Outside parties (brands, marketplaces, vendors, the
Scout team) are named where they answer.

---

## 1. One-page summary

### Why not 05 and 06 first?

You are right that 05 (complete apparel shot sets, 50.6k base) and 06 (richer footwear pages, 116.9k base) carry the
most value: together 167.5k, 62% of the 269.4k base. They sit last in 07 for one reason that is not about value: 07
ranks "can start now" above value, and **SPEC.md forbids every part of 05 and 06 today** ("No cropping of any kind",
"No generative edits or paid image APIs", "No lifestyle-background option", no template features). Lifting that ban
is your own decision, and all four amendments are already drafted (DD2 R4, DD4 R7, DD6 R8).

Looked at piece by piece, 05 and 06 are not one block. They split into four very different kinds of blocker:

| Part of 05 and 06 | Base | What actually blocks it | Does it need the generator, gate or brand rights? |
|---|---|---|---|
| 5.0 Styli and Centrepoint eligibility | 2.3k | nothing; the asks can go now | no |
| 5.1a crops for conversion | 17.8k | your cropping SPEC amendment, plus photo roles (2.6) | no |
| 5.1b crops to complete the Styli / Centrepoint set | 14.7k | as 5.1a, plus written channel specs and larger brand masters | no |
| 6.3 and 6.4 callouts on p2p facts | 12.2k | your infographics amendment, Noon and Namshi written acceptance, an Arabic reviewer, lettering confirmation | no |
| 6.5 callouts on proposed facts | 44.9k | all of 6.3 and 6.4, plus the fact sheet (initiative 4) and Naz's confirmation | no |
| 5.2, 5.3, 6.1a, 6.1b, 6.2 generated images | 75.6k | generation and lifestyle amendments, generator yes, vendor data position, gate bars, brand rights | yes |

So the honest answer is: **move parts of 05 and 06 up, not all of them.**

- **About 47k of base (5.0, 5.1a, 5.1b, 6.3, 6.4) needs no generator, no gate and no brand rights,** only your SPEC
amendments and some outside asks (for callouts, Noon and Namshi acceptance). That is more than initiatives 2 and 3
together (21.5k + 13.0k). 5.1a alone (17.8k) is the largest revenue item that your own decisions can unlock.
- **The generated part (75.6k, including US Polo lifestyle at 52.2k) truly waits** on the generator, the gate and
brand rights. It cannot go first, but every question it waits on can be asked now, at no cost.
- **Confidence is the other reason.** Every 05 and 06 lift is judged; our own data shows no gain from image count
alone (01 s3); the 1% lifts of B4 and B5 cannot be measured directly on any channel (06). Callouts are worth about 0
unless Noon and Namshi accept them. Initiatives 1 to 3 hold the measured problems and the only places a holdout can
see an effect, which is why the measuring pieces still start first.

### The new sequence, in four waves

Waves are grouped by what unblocks them, not by size or ease. Inside each wave, items are ordered by impact and pain.

| Wave | Unblocked by | Base revenue a year | High | Other money |
|---|---|---|---|---|
| **A** | nothing; can start now | 7.9k | 15.8k | 1.51k ad money saved |
| **B** | the owner's own decisions (SPEC amendments, rule tables, naming who does what) | 53.9k | 147.9k | 0.97k ad money; 1.12k cash a year; 1.05k cash once |
| **C** | outside answers (brand rights and files, Noon and Namshi acceptance, templates, Arabic reviewer, channel specs) | 132.1k | 459.6k | 2.55k ad money; 1.01k cash a year; 0.89k cash once |
| **D** | the generator yes and the fidelity gate holding | 75.6k | 218.7k | spend avoided 7.7k to 13.2k once (plus 3H's 2.7k to 4.3k) |
| **Total** | | **269.5k** (06: 269.4k, +0.1k rounding) | about 842k (06: about 841k) | ad 5.0k; cash 2.1k a year |

The headline: **your own decisions alone (Wave B) unlock 53.9k**, more than the 41.2k that 07 says "can start now",
and nobody outside has to answer. Wave A is small (7.9k) because almost every piece, including most of initiative 2,
waits on at least one of your decisions.

### The decisions that unlock the most value

"Unlocks" means the value cannot move without this decision; most items need more than one decision, so these
amounts overlap and do not add up.

| # | Decision | Whose | Base that cannot move without it | Sub-initiatives |
|---|---|---|---|---|
| 1 | US Polo written scope of rights (generated images and lettered images) | outside (US Polo), owner asks | **95.3k** | 6.1b 52.2k, 6.5 US Polo part 37.1k, 6.4 6.0k |
| 2 | Generation package: generation and lifestyle SPEC amendments, generator yes, gate bars and second rater, vendor no-training position | owner (vendor writes its position) | **75.6k** | 6.1b, 5.2, 5.3, 6.2, 6.1a |
| 3 | A native Arabic reviewer named | outside / owner | **67.7k** | 6.3 to 6.5 glossary 57.1k, 4K 9.0k, 4J 1.6k |
| 4 | Infographics SPEC amendment | owner | **57.1k** | 6.3, 6.4, 6.5 (6.6) |
| 5 | Noon and Namshi written acceptance of a callout image | outside (marketplaces) | **57.1k** | 6.3, 6.4, 6.5 (about 0 without it) |
| 6 | Photo roles and channel rule table (role taxonomy, caps and minimums, cut product never image 1, SPEC update for output order) | owner | **53.9k** | 2.10 to 2.13, 2.15, 2.16, 2.19 (21.4k), 5.1a, 5.1b (32.5k) |
| 7 | Facts, listing copy and reviews SPEC amendment (G2), with the p2p read grant (G5) | owner | **47.3k** (and the fact sheet that 6.5 uses) | 4F, 4G, 4J, 4K |
| 8 | GCC listing ownership (G1) and real blank templates (G3) | owner (G1); outside (G3) | **36.7k** (+0.64k cash a year) | 4F, 4G (4H cash) |
| 9 | Cropping SPEC amendment | owner | **32.5k** | 5.1a 17.8k, 5.1b 14.7k (3E crop route 0.97k ad money) |
| 10 | Who re-submits changed images in each portal (I2 Q6) | owner | **21.4k** | every brand wave and Noon recovery in 02 |

Three combinations are worth naming:

- **Owner-only bundle (decisions 6, 9 and 10, plus naming the Noon C-02 person and who confirms size notes):** unlocks
all of Wave B, 53.9k, with no outside answer.
- **One conversation with US Polo** can carry 105.7k: the rights scope (95.3k) and the missing footwear view files
for 3F (10.35k). DD8 F1 records your statement that Opptra already holds written rights, so this may be a
confirmation of scope, not a negotiation.
- **The callout bundle (decisions 3, 4, 5 plus brand lettering confirmation and the fact sheet)** unlocks 57.1k with
no generator and no gate.

### First picks per lane, and why

| Lane | First pick | Why this one |
|---|---|---|
| Ops | **1.1** Namshi not-listed queue (179 pairs) | 5.6k base, the largest value that starts with no answer; stocked stock is simply not listed. Next: **5.0** Styli and Centrepoint asks (2.3k, and it opens 5.1b's 14.7k), **3B** top-20 live-page check. |
| Data | **4B step 1** fit-return watchlist, then **3A** ranked target queue with the guard | Size or fit is 71% of Namshi return reasons (0.68M USD gross a year) and nobody acts on it; the watchlist feeds 4B's 13.6k. 3A decides where 03's 13.0k and 5.0k ad money land and filters out pages that cannot sell. Then **1.5** feed-health flag before any re-submission wave. |
| Dev | **1.9** treatment log rows | No lift in the 269.4k can be proved without it (content-to-sales join is 13% today). Next: **2.4** ticked channel never vanishes, **2.3** correct sheet rule texts. Once decision 6 lands: **2.6** roles shown, which gates 53.9k. |
| Mkt | the bid, budget and price freeze for holdout products (I1 Q8), once the owner says yes | Mkt has no Wave A item; without the freeze, 1.12, 1.13 and 3I cannot read a real lift. Mkt already gains 3D's ad money (1.51k) from Wave A. |
| Owner | **decision 6** (roles and rule table) with **decision 10** (re-submission person), then **decision 9** (cropping) | Together they gate 39.2k of revenue that needs nobody outside (02's 21.4k plus 5.1a's 17.8k). In parallel, send the outside asks now: US Polo scope (95.3k), Noon and Namshi acceptance (57.1k), Arabic reviewer (67.7k), templates (36.7k). Asking is not blocked. |

### What changes versus the current 07 order

1. **Order by sub-initiative, not by whole initiative.** 07 runs initiative 1, then 2, then 3, and so on. This

   proposal pools 68 sub-initiatives and orders them by what unblocks them, then by value and pain.
2. **07's "1, 2 and 3 can start now (41.2k)" is corrected.** Only 7.9k (plus 1.51k ad money) starts with no answer.

   Initiative 2's 21.4k waits on your rule decisions (I2 Q1, Q3, Q4, Q6, Q10), the same kind of blocker as the
    cropping amendment; initiative 3's 13.0k needs brand files from US Polo and Campus.
3. **5.0 moves to Wave A; 5.1a (17.8k) moves from Phase 2 to Wave B,** beside initiative 2's brand waves and ahead of

   all but the gates.
4. **4B (13.6k) moves up:** the watchlist starts now; publishing needs only your decision on who confirms a note.
5. **Callouts (6.3 to 6.5) split from lifestyle and move ahead of it** (Wave C, not Wave D). Their asks start now.
6. **The asks for Wave D start now,** not after Phase 2: US Polo scope, vendor no-training position, gate bars.
7. **What stays last:** generated images (5.2, 5.3, 6.1a, 6.1b, 6.2, 3H), 75.6k. The gate's exit numbers are the

   condition to stop reviewing every image, not to start publishing under review-all (DD2 R3, DD4 R3).
8. **Optional pieces are named:** items with 0 counted value that gate nothing (1.16, 1.17, 2.2, 2.17, 6.6 and

   similar) sit at the end of each mini-roadmap.

---

## 2. Initiatives and their sub-initiatives

Each table follows the same columns. "Impact" is revenue low / base / high (USD a year) unless marked. "Wave" is
where the sub-initiative sits in section 3. Mini-roadmaps are ordered by impact, pain and dependency only; items
marked **Optional** carry no counted value and gate nothing.

### Initiative 01 - Measure and unblock

Totals: revenue 0 / 6.7k / 13.4k (all from L2b, recovered not-listed pairs). Cash 0. Spend avoided 0. Run cost
about 0. All other 01 pieces carry 0 counted value: their value is information, deciding how much of the other 262.7k
of judged base is real.

| Sub-initiative | What it does | Pain removed, for whom | Impact | Cash / spend avoided | Depends on / blocked by | Lane | Wave | Proof of progress |
|---|---|---|---|---|---|---|---|---|
| 1.1 Namshi not-listed queue (179 pairs) | Routes each stocked Namshi pair missing from the portal by its sub-reason until listed or out of scope | Business loses sales on stocked stock; Naz has no owned list | 0 / 5.6k / 11.3k | 0 | Nothing blocks the start; out-of-scope clusters need Ashish and Tarannum (I1 Q13) | Ops | A | Namshi "Not listed" falls from 179 |
| 1.2 Noon Not Live feed restored (C-02) | A named person lands the Noon Not Live export into the existing ingestion | Nobody sees Noon content rejections (last file 21 Aug, 479 SKUs) | 0 counted; unblocks 7.5k in 02 | 0 | I1 Q1 (who: Vishnu, vendor job, or Increff) | Ops, Data | B | C-02 fresh and validated; Noon pairs in the Content bucket |
| 1.3 Namshi Catalog Live Status validated (C-04b) | The decided Namshi download runs and C-04b joins the validated reports | Namshi KSA fell from 97.8% to 86.8% live with 721 pairs unexplained | 0 counted | 0 | Vishnu download (decided); Sujan signs off the first result | Ops, Data | A | Namshi not-live pairs carry reasons; coverage rises from 38% |
| 1.4 Amazon All Listings validated, live rule switched (C-08) | Amazon live uses `status = 'Active'` instead of a fallback that overstates live about 4x | Inflated Amazon live number; 620 pairs without reasons | 0 counted | 0 | Siva's job (I1 Q2); Ashish confirms the rule (D-03) | Ops, Data | B | C-08 validated; old and new shown side by side, then C-06 retired |
| 1.5 Feed-health flag | Labels every move above 5 points as `feed_change`, `reason_feed_missing` or `real_change` | False alarms for Naz and business; re-submission dips read as delistings | 0 counted | 0 | Nothing blocks the start; full labels after 1.2 to 1.4 | Data | A | Zero unlabelled moves above 5 points |
| 1.6 Trendyol product list restarted (C-05) | Restarts the Trendyol list that stopped after 22 Oct | Trendyol counts go stale silently | 0 counted; needed for 1.8 | 0 | Vishnu (I1 Q6) | Ops, Data | B | Rows dated after 22 Oct |
| 1.7 Amazon and Noon not-listed queue (545 pairs) | Same routing as 1.1; deliberately-off clusters become scope rows | As 1.1; much of Amazon may be deliberate | 0 / 0.53k / 1.05k | 0 | Ashish and Tarannum name deliberate clusters (I1 Q13, R5); cleaner after 1.4 | Ops | B | Every pair listed or out of scope |
| 1.8 Trendyol not-listed queue (141 pairs) | Same routing for Trendyol | As 1.1 | 0 / 0.52k / 1.04k | 0 | 1.6 | Ops | B | Each pair listed or out of scope |
| 1.9 Treatment log rows in the module | Stores per image position, source hash, generated flag, rules version, upload date, holdout arm, hold flag | No content change can be tied to sales (join 13%) | 0 counted; precondition for every measured lift | 0 | Building is not blocked; filling the upload date needs I1 Q12 (who enters it); roles from 2.6 | Dev (Ops enters dates) | A | Per product and channel: which image, when uploaded, which arm |
| 1.10 Treatment log exported to BigQuery, "went live" confirmed | Exports the log and joins it to liveness, ads and sales | Data team and business get content-to-sales joins | 0 counted | 0 | 1.9; write grant on one dataset (I1 Q11); 1.2 to 1.4 for "went live" | Dev, Data | B | 95% or more of treated options join to ads and sales |
| 1.11 Holdout design and A/A check | Strata, matched pairs, recorded seed, pre-period balance check | A test the business can trust before images change | 0 counted | 0 | Nothing blocks the design; test unit needs I1 Q10 | Data | A | Published assignment table; passed A/A check |
| 1.12 Holdout cell 1: B1 on Namshi | Runs and reads the B1 re-render cell | Nobody knows if B1's 14.0k is real | 0 counted; confirms or removes 14.0k (holding out costs up to 7.0k a year pro rata) | 0 | 1.9, 1.11, 2.9; freeze (I1 Q8) | Data, Mkt, Dev | B | Measured lift with a 95% interval; 06 row B1 updated |
| 1.13 Holdout cells 2 and 3: weak ad pool and 187 Amazon ASINs | Same method for 03's fixes | 03's lifts are judged | 0 counted; tests 5.0k ad money and 13.7k Amazon | 0 | 1.9 to 1.11; 03 fixes; freeze | Data, Mkt | B | Measured lifts per cell |
| 1.14 Noon traffic restored | Restarts the Noon traffic download (stopped 4 Feb 2026) | A Noon page fix cannot be measured | 0 counted | 0 | I1 Q4 (who made the files) | Ops, Data | B | Rows after 4 Feb 2026 |
| 1.15 Namshi and Trendyol traffic asked | Asks both portals for per-SKU traffic; lands it or records "no" | Namshi, the largest ad channel, has no page traffic | 0 counted | 0 | Namshi account manager (I1 Q5); Trendyol (I1 Q6) | Ops, Data | C | A traffic table or a recorded "no" |
| 1.16 Time to live report | First live date minus first seen date per new EAN | Nobody sees how long a product takes to go live | 0 counted | 0 | Nothing for the three-stage version | Data | A | Time to live per channel-country |
| 1.17 Per-channel completeness score | Elements present over elements required per brand and channel | No single catalog health number | 0 counted | 0 | Owner adopts it (I1 Q7); roles (2.6); attributes (04); 1.2 to 1.4 | Data, Dev | B | Score per brand and channel |

**Mini-roadmap 01**

1. **1.1** Namshi not-listed (5.6k, Wave A).
2. **1.9** treatment log and **1.11** holdout design (Wave A; every measured lift depends on them), **1.3** Namshi

   reasons and **1.5** feed-health flag (Wave A; 1.5 must be live before any re-submission wave).
3. **1.2** Noon C-02 (Wave B; unblocks 7.5k in 02), then **1.4** Amazon C-08.
4. **1.7** Amazon and Noon not-listed (0.53k), **1.6** then **1.8** Trendyol (0.52k).
5. **1.10** export, then **1.12** B1 cell (after 2.9) and **1.13** cells 2 and 3 (after 03 fixes).
6. **1.14** Noon traffic, **1.15** traffic asks.
7. **Optional:** **1.16** time to live, **1.17** completeness score.

### Initiative 02 - Channel-ready live catalog

Totals: revenue 0 / 21.5k / 52.4k (B1 13.97k + L2a 7.47k = 21.44k, rounded to 21.5k in 07; high 52.35k). Cash saved
about 1.12k a year (0.64k to 1.60k) plus 1.05k once. Spend avoided 0. Run cost 37 one-off plus 12 to 40 a year.

| Sub-initiative | What it does | Pain removed, for whom | Impact | Cash / spend avoided | Depends on / blocked by | Lane | Wave | Proof of progress |
|---|---|---|---|---|---|---|---|---|
| 2.1 Resizing and links for new styles off the agency (V1) | The module, which already does this for 9 channels, makes resized images and links sheets | Business pays the agency for work the platform does | 0 | Cash 0.64k / 1.12k / 1.60k a year | Owner OK and INR 60 breakdown (I2 Q10); who uploads (I2 Q6) | Ops (Dev on call) | B | Agency resizing line stops on the invoice |
| 2.2 Channel rule evidence pack | Saves the portals' image-rule pages into `docs/` | 7 of 9 channels' rules are assumed; risk of new rejections | 0 counted | 0 | Portal access (I2 Q8); Centrepoint answer (I2 Q5) | Ops | B | Each DD1a rule row "verified" or "different" |
| 2.3 Correct links-sheet rule texts | Fixes header texts that disagree with the code (Amazon, Trendyol, Styli, Namshi) | Naz and agency read wrong rules | 0 counted | 0 | Nothing (Centrepoint text after I2 Q5) | Dev | A | Every header matches the canvas |
| 2.4 A ticked channel never disappears | Keeps a ticked channel's columns with a note when no photo reached it | Silent failure: a channel got nothing | 0 counted | 0 | Nothing | Dev | A | Empty columns with a note |
| 2.5 "incomplete" status and image-count notes | Flags products under a minimum or over a cap, plain notes | A 1-photo product reads "ok"; extra images dropped silently | 0 counted | 0 | Owner yes on caps and minimums (I2 Q3); SPEC says "no cap on images" today | Dev | B | Incomplete count per brand; photo request list |
| 2.6 Shot roles and head state shown | The judge returns each photo's role, head state and confidence; sheet shows shots and missing | Nobody can see a close-up leading or a cut face except by eye | 0 counted; **gates 53.9k** (all of B1, L2a, 5.1a, 5.1b) | 0 | Role taxonomy and rule table (I2 Q1), DD0 taxonomy; golden-set labellers | Dev (Ops labels) | B | Role accuracy 95% per required role, 100% on head cut |
| 2.7 Channel rule release, rules version 10 to 11 | Orders by role per channel, cut product never image 1 on Noon and Amazon, caps by role priority | Shoppers see close-ups first; Noon rejects sequencing and cut mains | 0 counted; gates 21.4k | 0 | 2.6; I2 Q1, Q3, Q4; SPEC update for output order | Dev | B | Golden set passes under version 11 |
| 2.8 Re-submission route agreed and tested | Names who uploads in each portal; tests one product per portal | Without it no wave reaches shoppers | 0 counted; gates 21.4k | 0 | I2 Q6 (who; does any channel take a listing offline) | Ops | B | One product per portal live with the new image, no liveness drop |
| 2.9 Namshi holdout pilot (treated half) | Re-renders and re-submits only the treated half of the matched options | Lets the business measure B1 | 0 counted (inside 2.10 to 2.12) | 0 | 2.7, 2.8, 1.9, 1.11, I2 Q7, freeze (I1 Q8) | Dev, Ops, Mkt | B | Treated options live with arms logged |
| 2.10 French Connection wave (899) | Re-renders and re-submits all French Connection under version 11 | Most defects: 7 of 19 B1, 15 of 19 non-white mains | 0 / 7.96k / 15.92k | Cash 300 once | 2.7, 2.8; Namshi part after 2.9 | Dev, Ops | B | Sheets at version 11; pages show front first |
| 2.11 Penti wave (615) | Same for Penti (use the 1440x2160 masters) | As 2.10 | 0 / 3.20k / 6.40k | Cash 205 once | 2.7, 2.8 | Dev, Ops | B | Sheets at version 11 |
| 2.12 Vero Moda and Cardio Bunny wave (239) | Same | As 2.10 | 0 / 2.10k / 4.20k | Cash 80 once | 2.7, 2.8 | Dev, Ops | B | Duplicates and head cuts named |
| 2.13 Nautica wave (159) | Same | As 2.10 | 0 / 0.61k / 1.23k | Cash 53 once | 2.7, 2.8 | Dev, Ops | B | Sheets at version 11 |
| 2.14 Noon rejection triage list | Matches each fresh C-02 rejection to its product and wave | Naz gets a work list, not a stale file | 0 counted (inside 2.15, 2.16) | 0 | 1.2 | Data or Dev | B | List of rejected SKUs with product, reason, wave |
| 2.15a Noon French Connection rejections back live (365) | Re-submits them in the French Connection wave | Stocked listings stay off Noon | 0 / 5.69k / 18.59k | 0 | 2.14, 2.10 | Ops, Data | B | Next C-02 shows them live |
| 2.15b Noon other apparel rejections (60) | Same for Penti, Nautica, others | As 2.15a | 0 / 0.94k / 3.06k | 0 | 2.14, 2.11, 2.13 | Ops, Data | B | As 2.15a |
| 2.16 Noon footwear rejections (54) | Same for Campus and US Polo | As 2.15a | 0 / 0.84k / 2.75k | 0 | 2.14, 2.19; 2.18 if the reason is the grey main | Ops, Data | B | SKUs leave the C-02 list |
| 2.17 Noon white image 1 for home fragrance | Pure white first image for 86 non-fashion options | Noon flags grey non-fashion mains | 0 counted | 0 | A department signal (DD0 taxonomy) | Dev | B | Candle and spray mains white on Noon |
| 2.18 Noon white image 1 for footwear and bags | Same rule if Noon counts them as non-fashion | The module may turn white shoe mains grey and create the defect | 0 counted | 0 | Noon's fashion definition (I2 Q2); 2.17 | Dev, Ops asks Noon | C | White mains, or a recorded "footwear is fashion" |
| 2.19 Footwear wave (1,229) | Re-renders US Polo, Campus, Keds, Puma under version 11 | Inconsistent footwear galleries | 0 / 0.10k / 0.20k | Cash 409 once (612 if Campus billed per option) | 2.7, 2.8; Noon part on 2.18 | Dev, Ops | B | Footwear sheets at version 11 |

**Mini-roadmap 02**

1. **Gates for the 21.4k, side by side:** **2.6** roles shown and **2.8** re-submission route, then **2.7** rule

   release.
2. **2.1** resizing off the agency (the only recurring cash line in 02; needs only the owner OK and an uploader).
3. **2.9** Namshi pilot, then **2.10** French Connection (7.96k) with **2.14** and **2.15a** (5.69k): together

   13.6k, the largest block.
4. **2.11** Penti (3.20k), **2.12** Vero Moda and Cardio Bunny (2.10k), **2.15b** (0.94k), **2.16** (0.84k),

   **2.13** Nautica (0.61k), **2.19** footwear (0.10k plus 409 cash once).
5. Sheet honesty, no image change: **2.4**, **2.3** (Wave A), **2.5**.
6. **2.18** Noon footwear white main (needs Noon's answer).
7. **Optional:** **2.2** evidence pack, **2.17** home fragrance white main.

### Initiative 03 - Fix the pages we pay to advertise

Totals: revenue 0 / 13.0k / 51.9k (L4, footwear missing views). Ad money saved 0 / 5.0k / 11.0k (L1), shown beside
revenue, never added. Cash 0. Spend avoided 2.7k to 4.3k once (3H). Run cost up to 91 one-off.

| Sub-initiative | What it does | Pain removed, for whom | Impact | Cash / spend avoided | Depends on / blocked by | Lane | Wave | Proof of progress |
|---|---|---|---|---|---|---|---|---|
| 3F US Polo missing footwear views (7 of 20 sets) | Fills missing side, pair, top, sole or back views, first from US Polo's files | Shoppers cannot see the whole shoe on the highest-revenue brand | 0 / 10.35k / 41.38k; ad 0 / 1.49k / 3.27k | Spend avoided inside 3H | 3A; owner Q2 (send the ask); US Polo's files; the rest via 3H | Ops (brand team) | C | US Polo completeness rises from 13 of 20 |
| 3G Campus missing footwear views (10 of 15 sets) | Same for Campus | Worst ROAS of the advertised brands (1.65) | 0 / 2.63k / 10.50k; ad 0 / 1.06k / 2.32k | inside 3H | 3A; owner Q2; Campus's files; 3H for the rest | Ops (brand team) | C | Campus completeness rises from 5 of 15 |
| 3D Apparel and bag reorder and re-render on weak-pool targets | Re-runs hand-picked targets with the right photo first and the product filling the frame | Marketing pays for clicks landing on close-ups (FC weak spend 40.2%) | Revenue 0 here (in B1); ad 0 / 1.51k / 3.32k | 0 | 3A, 3B; the platform re-renders today | Ops (Dev on call) | A | 20 target pages show the right first image |
| 3E Apparel missing hero shots on weak-pool targets | Gives targets a garment-hero shot from brand files or a crop | Trousers fill a T-shirt ad; cut faces | Revenue 0 here (in B2); ad 0 / 0.97k / 2.13k | 0 | 3A, 3B; crop route: cropping amendment and 2.6 (B); brand route: owner Q2 and brand files (C) | Dev (crops), Ops (asks) | B | Front hero as image 1 or 2 |
| 3H Generated footwear views brands cannot supply | Generates the missing view behind the gate, with approval | Views stay missing forever if brands do not answer | Carries (1 - s) of 3F and 3G; no extra value | Spend avoided 2.7k to 4.3k once | 3F, 3G answers; generator and gate; generation amendment; US Polo and Campus rights; vendor position | Dev | D | Generated views live with a generated flag |
| 3A Ranked target queue with the guard | One list of 351 products ranked by wasted spend and missed units, each with a live, stock, size and price guard | No ordered list; fixes land on pages that cannot sell (71.4% sold nothing) | 0 counted; decides where 03 works | 0 | Nothing; routing guard failures needs owner Q4 | Data | A | List refreshes; drop-out rate reported |
| 3B Top-20 live-page check on Namshi and Noon | Opens each target page on the ad channel and records defect and fix | Fixes planned on a stand-in channel | 0 counted | 0 | Nothing | Ops | A | 20-row sheet linked to 3A |
| 3C Amazon title and size-chart corrections (US Polo) | Model names from `master_sl.name` instead of internal numbers; size charts | 828 sessions and 0 units on TETSY | 0 counted (13.7k cross-check not claimed) | 0 | Owner Q3 (who owns Amazon titles; 07 decision 7) | Ops | B | Share of 187 ASINs with the model name |
| 3I Holdout cells 2 and 5 | Pairs targets, fixes one, compares CVR and unit session % | Every 03 lift is judged | 0 counted; decides if L1 and L4 stay | 0 | Freeze (owner Q1); treatment log; 3C to 3G fixes | Data, Mkt | B | Cell readout against 0.77% CVR and 0.13% unit session |

If brands supply a share s of the missing views, 3F and 3G keep value x s in Wave C and 3H carries value x (1 - s)
in Wave D. The total does not change; s is unknown until US Polo and Campus answer.

**Mini-roadmap 03**

1. **3A** queue and guard, **3B** top-20 check (Wave A; nothing blocks).
2. **3D** apparel reorder on hand-picked targets (Wave A; 1.51k ad money).
3. **3F** US Polo views (10.35k) and **3G** Campus views (2.63k) through the brand route, once you say "ask".
4. **3E** hero shots (crop route after the cropping amendment; brand route after the ask).
5. **3C** titles once the Amazon owner is named; **3I** cells once fixes and the freeze are in place.
6. **3H** generated views (Wave D).

### Initiative 04 - Product facts, listings and customer voice

Totals: revenue 0 / 60.7k / 241k in 06 and 07 (exact sub-split 60.9k / 241.6k; B7a is 24.2k exact, shown as 24k).
Cash saved about 1.0k a year plus 0.9k once (0 if the agency keeps templates). Spend avoided 0. Run cost about 804.

Gates (decisions, not sub-initiatives): **G1** GCC module owns GCC listing content (04 Q1); **G2** SPEC amendment for
facts, listing copy and reviews (04 Q11); **G3** real blank templates and agency-filled examples (04 Q2); **G4**
native Arabic reviewer (04 Q3); **G5** p2p owner and read grant (04 Q5); **G6** who confirms a "runs large / small"
note (04 Q9); **G7** who builds the Scout reviews entity, Apify account with a cap (04 Q8).

| Sub-initiative | What it does | Pain removed, for whom | Impact | Cash / spend avoided | Depends on / blocked by | Lane | Wave | Proof of progress |
|---|---|---|---|---|---|---|---|---|
| 4F Namshi template fill replaces the agency | The module fills Namshi's real template; switches after a side-by-side | Naz depends on agency turnaround for the largest channel; shoppers miss filters | 0 / 26.70k / 106.7k | Cash 0.32k a year (0.28k once) | G1, G2, G3; 4C; 4E | Dev, Ops | C | Side-by-side passed; agency pairs 2,930 to 0 |
| 4B Fit-return size guidance | Step 1: watchlist from Namshi return reasons. Step 2: size-chart check or "runs large / small" note after brand confirms | Size or fit is 71% of Namshi returns (0.68M gross a year); nobody acts | 0 / 13.6k / 34.0k | 0 | Step 1: nothing (Wave A). Step 2: G6 (Wave B) | Data (list), Ops and brand managers (publish) | A, then B | Watchlist; fit-return share treated vs matched |
| 4G Noon template fill replaces the agency | Same on Noon's `.xlsm` templates, English and Arabic | As 4F, plus the text half of Noon content issues | 0 / 9.99k / 39.9k | Cash 0.32k a year (0.28k once) | G1, G2, G3; 4C; 4E; real-template round trip | Dev, Ops | C | Agency pairs 2,929 to 0 |
| 4K Noon review text into the theme flow | Brings Noon reviews in through Scout, or one capped actor | Noon holds most ratings; its review endpoint is closed | 0 / 9.0k / 36.0k | 0 | G7; 4J | Scout team or Dev | C | Noon reviews in `review_observation`; Noon cards shown |
| 4D Brand sheets for French Connection, Puma, Nautica | Asks the three brands for material, care, fit, origin | French Connection has 0 master rows and 365 of 479 Noon rejections | 0 / 0 / 18.6k | 0 | Owner Q4 for the ask; brand sheets; loading needs 4C | Ops (brand teams) | C | French Connection facts confirmed above 0 |
| 4J Review themes to fix cards | Tags reviews into closed themes mapped to typed fixes; one card per product for Naz | Nobody reads reviews; the 3.4-star MEDI page has no route to a fix | 0 / 1.6k / 6.4k | 0 | G2, G4; 4I; 4C | Dev, Arabic reviewer | C | Theme precision at the owner's bar |
| 4H Styli and Centrepoint template fill | Adds both templates to the 4F / 4G registry | Last 3,421 agency template pairs | 0 counted | Cash 0.37k a year (0.33k once) | G1, G2, G3; 4F engine | Dev, Ops | C | Styli 1,784 and Centrepoint 1,637 pairs to 0 |
| 4A Listing reality check | Samples live Noon and Namshi pages for Arabic and attribute fill | B6's 36.7k could be near 0 if the agency already does it well | 0 counted; confirms or cuts B6 | 0 | Owner Q7 (permission) | Ops or Data | B | "x of N listings carry Arabic; y% attributes filled" |
| 4C Fact sheet from company data | Reads `sku_master_p2p` and unused `master_sl` columns into a versioned fact sheet | Facts for 58% of style-colours sit unused | 0 counted; gates 4F, 4G, 4J and the facts behind 6.3 to 6.5 | 0 | G2, G5; DD0 taxonomy | Dev, Data | B | Confirmed material, care, origin; 0 wrong on a 50-option sample |
| 4E English and Arabic copy from facts | Title, description, highlights from one fact version, checked by code; Arabic "waiting for review" | 0 Arabic characters in any source; Noon does not translate | 0 counted (inside 4F, 4G) | 0 | G1, G2; 4C; G4 for Arabic | Dev, Arabic reviewer | B (English), C (Arabic) | Listings with our Arabic rise from 0 |
| 4I Review ingestion for Namshi, Trendyol, Amazon | A Scout `reviews` entity writing `review_observation` | No review store exists | 0 counted (value in 4J, 4K) | 0 | G7; Scout's own Phase 1 exit | Scout team | B | Rows on 3 channels |

**Mini-roadmap 04**

1. **4B step 1** watchlist (Wave A), then **4B step 2** publishing (13.6k, needs G6).
2. **4A** reality check (needs only the OK in Q7): it decides whether 36.7k is real before the listing line runs.
3. **4C** fact sheet (after G2, G5), **4E** English copy.
4. **4F** Namshi (26.70k), then **4G** Noon (9.99k), Arabic in 4E after G4; then **4H** (cash).
5. **4I** ingestion (G7), **4J** themes (1.6k, after G4), **4K** Noon reviews (9.0k).
6. **4D** brand sheets (high case only; also feeds 6.5): the ask can go once you say so.

### Initiative 05 - Complete apparel shot sets

Totals: revenue 0.9k / 50.6k / 132.0k (B2, B2e, B3). Cash 0. Spend avoided 1.5k to 2.4k once (generated parts only;
crops are not generation). Run cost 74. **No US Polo dependency** (US Polo is footwear only) and **no Noon / Namshi
callout dependency.**

| Sub-initiative | What it does | Pain removed, for whom | Impact | Cash / spend avoided | Depends on / blocked by | Lane | Wave | Proof of progress |
|---|---|---|---|---|---|---|---|---|
| 5.0 Channel eligibility | Gets Styli's and Centrepoint's written image rules; sends what already qualifies | About 663 options absent from Centrepoint, 893 from Styli; nobody knows if images are the reason | 0 / 2.3k / 4.5k | 0 | Nothing in SPEC; channel asks; a listing route (agency or 4) | Ops (channel managers) | A | Written specs; options newly live |
| 5.1a Crop-derived shots for conversion | Cuts a missing front, close-up or head-and-shoulders out of a larger photo of the same product, pixels unchanged | 44 of 73 sampled lack a front, back or close-up | 0 / 17.8k / 59.5k | 0 | Cropping SPEC amendment; 2.6 roles. Not the generator, gate, rights or vendor | Dev | B | Share of products with each role, made by crop |
| 5.1b Crops completing the five-role set for Styli and Centrepoint | Same crops aimed at listing, using larger masters | The listing gap on Styli and Centrepoint; 92 of 141 have an image below 1,482 px | 0 / 14.7k / 28.8k | 0 | 5.1a; 5.0's written specs; larger brand masters (I5 Q3); listing templates | Dev, brand managers, channel managers | C | Options with all five roles by crop; newly live |
| 5.2 Generated missing roles (mode A) | Generates a missing role from the product's own photos, gated, reviewed | Products too small to crop or with no full-length view (all Penti) | 0 / 8.6k / 23.2k | Spend avoided 1.30k to 2.09k once (net 1.26k to 2.04k) | Generation amendment; generator yes; vendor position; gate bars and second rater; modesty policy | Dev, Naz and second rater | D | Accepted shots per batch; false-pass and false-hold rates |
| 5.3 Flat lay to on-model (mode B), Vero Moda first | Puts a flat-lay garment on the brand's registered real model | 11 of 66 have no model photo at all; can never list by cropping | 0.9k / 7.3k / 16.0k | Spend avoided 179 to 286 once (net 149 to 256) | All of 5.2; real-model rights; DD8 registry; colour check | Dev, owner (rights), Naz | D | Approved anchors; Vero Moda products from 0 to a full set |

05 check: 2.3 + 17.8 + 14.7 + 8.6 + 7.3 shows 50.7 on the rounded parts; the unrounded parts sum to 50.60.

**Mini-roadmap 05**

1. **5.0** eligibility asks and listing what already qualifies; master requests to brands (Wave A).
2. **5.1a** crops for conversion (17.8k; after the cropping amendment and 2.6).
3. **5.1b** crops for the Styli / Centrepoint set (14.7k; after 5.0's answers and masters).
4. **5.2** generated roles under review-all (8.6k; Wave D).
5. **5.3** flat lay to on-model (7.3k; after 5.2 plus model rights).

Steps 1 to 3 carry 34.8k of 05's 50.6k (69%) without the generator, the gate or any rights.

### Initiative 06 - Richer footwear pages

Totals: revenue 0 / 116.9k / 350.8k (B4 lifestyle 59.8k + B5 callouts 57.1k). Cash 0. Spend avoided 7.3k to 11.6k once
on the lifestyle backlog. Run cost about 985. Two lines with different blockers: **callouts** (no generator, no gate)
and **lifestyle** (generator and gate). Lifestyle does **not** wait on Noon / Namshi acceptance or the fact sheet.

| Sub-initiative | What it does | Pain removed, for whom | Impact | Cash / spend avoided | Depends on / blocked by | Lane | Wave | Proof of progress |
|---|---|---|---|---|---|---|---|---|
| 6.3 Callouts from confirmed p2p facts, brands other than US Polo | Draws a callout image in code (English with Arabic) from 412 style-colours' confirmed features | Campus, Keds, Cardio Bunny, Penti pages have no feature picture; Naz asked for this | 0 / 6.2k / 18.5k | 0 | Infographics amendment; Noon and Namshi acceptance (about 0 without); Arabic glossary reviewer; brand lettering confirmation; p2p facts (4C slice). Not the generator or gate | Dev, Ops (asks), Arabic reviewer | C | Live on Amazon and Trendyol as proof; 0 wrong words on 100 labelled |
| 6.4 Callouts from confirmed p2p facts, US Polo | Same for 55 US Polo style-colours | 19 of 20 US Polo pages carry no infographic | 0 / 6.0k / 18.1k | 0 | All of 6.3 plus US Polo lettering confirmation | As 6.3 | C | Coverage from 1 of 20 |
| 6.5 Callouts on features read from Trendyol, after Naz confirms | Extends callouts to 1,093 more style-colours | Most of the gap, above all US Polo (421) | 0 / 44.9k / 134.7k (US Polo 37.1k, others 7.8k) | 0 | All of 6.3 and 6.4; fact sheet (4C) and Naz's confirmation; 4D sheets | Ops (Naz confirms), Dev | C | Confirmed features; coverage across 1,560 eligible |
| 6.6 Use-case panels | Three scenes with a heading each | Matches the Birkenstock layout Naz showed | 0 counted (only in the high case, not separable) | Note only: 6.3k to 10.1k once if generated (not counted) | As 6.3; generated scenes also need 6.1 | Dev, Naz | C | Panels live on allowed channels |
| 6.1b Lifestyle image last, US Polo footwear | One generated legs-only lifestyle photo per style-colour, always last | US Polo earns about 5.9M of 9.2M softline; 19 of 20 have no scene; 55,280 USD of ads land on packshot-only pages | 0 / 52.2k / 156.7k | Spend avoided 2.9k to 4.7k once | Generation and lifestyle amendments; generator yes; vendor position; review-all; US Polo written confirmation | Dev, Naz, owner | D | Coverage from 1 of 20; holdout cell 3 |
| 6.2 Real product composited into a generated scene | Pastes the brand's own cut-out onto a generated scene; product pixels identical | Kids' pages (85) and thin sets get a scene with no risk to the product | 0 / 4.2k / 12.5k | Spend avoided 0.5k to 0.8k once | Lifestyle and generation amendments; generator yes; vendor position; brand confirmation. Skips gate checks G1 to G4 | Dev, Naz | D | Kids' style-colours with a scene |
| 6.1a Lifestyle pilot on brands other than US Polo (Campus, Keds; then Puma, bags) | Same lifestyle photo for brands whose rights are confirmed first | Keds 0 of 7 with a scene; Naz makes these by hand with no check or record | 0 / 3.4k / 10.3k | Spend avoided 3.8k to 6.1k once | As 6.1b with the pilot brand's confirmation instead of US Polo's | Dev, Naz, owner | D | Campus and Keds coverage; labelled images toward 100 |

**Mini-roadmap 06**

1. **Asks, no build (Wave A work for Owner and Ops):** US Polo, Campus, Keds written scope (generated and lettered);

   Noon and Namshi acceptance; Arabic reviewer; studio on-legs question; cap priority on Trendyol and Amazon.
2. **Callout line (Wave C):** **6.3** then **6.4** (12.2k; fewest blockers, and the base every other callout

   builds on), then **6.5** (44.9k).
3. **Lifestyle line (Wave D):** **6.1b** US Polo (52.2k); **6.1a** goes first wherever a non-US Polo brand confirms

   before US Polo, because its reviews become the labels 6.1b needs; **6.2** composite (4.2k).
4. **Optional:** **6.6** panels.

---

## 3. Cross-initiative sequence

Order inside each wave: first the gates whose value lands in that wave, then the items carrying value (by base, with
pain as tie-break), then gates for later waves, then proof and optional items. "Value" is base revenue a year;
other money is in brackets.

### Wave A - can start now (no owner answer needed)

| # | Sub-initiative | Base | Other money | Lane |
|---|---|---|---|---|
| A1 | 1.1 Namshi not-listed queue | 5.64k | | Ops |
| A2 | 5.0 Styli and Centrepoint eligibility | 2.27k | | Ops |
| A3 | 3D Apparel reorder on hand-picked targets | 0 | 1.51k ad money | Ops (Dev on call) |
| A4 | 4B step 1 Fit-return watchlist (feeds 13.6k in B) | 0 | | Data |
| A5 | 3A Ranked target queue with the guard (gates 03) | 0 | | Data |
| A6 | 3B Top-20 live-page check | 0 | | Ops |
| A7 | 1.9 Treatment log rows | 0 | | Dev |
| A8 | 1.11 Holdout design and A/A check | 0 | | Data |
| A9 | 1.5 Feed-health flag | 0 | | Data |
| A10 | 1.3 Namshi reasons validated (C-04b) | 0 | | Ops, Data |
| A11 | 2.4 Ticked channel never disappears | 0 | | Dev |
| A12 | 2.3 Correct sheet rule texts | 0 | | Dev |
| A13 | 1.16 Time to live report (optional) | 0 | | Data |
| | All outside asks for Waves C and D (sending them is not blocked) | 0 | | Owner, Ops |
| | **Wave A total** | **7.9k** (high 15.8k) | 1.51k ad money | |

### Wave B - unlocked by the owner's own decisions

| # | Sub-initiative | Base | Other money | Decision that unlocks it | Lane |
|---|---|---|---|---|---|
| B1 | 2.6 Shot roles shown (gates 53.9k) | 0 | | Role taxonomy, rule table (I2 Q1, DD0) | Dev |
| B2 | 2.8 Re-submission route (gates 21.4k) | 0 | | Who re-submits (I2 Q6) | Ops |
| B3 | 2.7 Channel rule release (gates 21.4k) | 0 | | I2 Q1, Q3, Q4; SPEC output-order update | Dev |
| B4 | 5.1a Crops for conversion | 17.81k | | Cropping SPEC amendment | Dev |
| B5 | 4B step 2 Publish size notes | 13.6k | | Who confirms a note (G6) | Ops, brand managers |
| B6 | 2.1 Resizing off the agency | 0 | 1.12k cash a year | Owner OK, INR 60 breakdown (I2 Q10) | Ops |
| B7 | 1.2 Noon C-02 restored (gates 7.5k) | 0 | | Who lands the export (I1 Q1) | Ops, Data |
| B8 | 2.9 Namshi holdout pilot | 0 | | Freeze (I1 Q8), I2 Q7 | Dev, Ops, Mkt |
| B9 | 2.10 French Connection wave | 7.96k | 300 cash once | via B1 to B3 | Dev, Ops |
| B10 | 2.14 Noon triage, 2.15a French Connection Noon rejections | 5.69k | | via B7, B9 | Data, Ops |
| B11 | 2.11 Penti wave | 3.20k | 205 cash once | via B1 to B3 | Dev, Ops |
| B12 | 2.12 Vero Moda and Cardio Bunny wave | 2.10k | 80 cash once | via B1 to B3 | Dev, Ops |
| B13 | 3E Hero shots (crop route) | 0 | 0.97k ad money | Cropping amendment | Dev |
| B14 | 2.15b Noon other apparel rejections | 0.94k | | via B7, B11, B16 | Ops, Data |
| B15 | 2.16 Noon footwear rejections | 0.84k | | via B7, B18 (Noon part may need 2.18) | Ops, Data |
| B16 | 2.13 Nautica wave | 0.61k | 53 cash once | via B1 to B3 | Dev, Ops |
| B17 | 1.7 Amazon and Noon not-listed | 0.53k | | Deliberate clusters named (I1 Q13, R5) | Ops |
| B18 | 1.6 then 1.8 Trendyol list and not-listed | 0.52k | | Who restarts the list (I1 Q6) | Ops, Data |
| B19 | 2.19 Footwear wave | 0.10k | 409 cash once | via B1 to B3 | Dev, Ops |
| B20 | 4C Fact sheet (gates 4F, 4G, 4J and facts for 6.3 to 6.5) | 0 | | G2 facts amendment, G5 p2p grant, DD0 | Dev, Data |
| B21 | 4E English copy (Arabic in C) | 0 | | G1, G2 | Dev |
| B22 | 4I Review ingestion (gates 4J, 4K) | 0 | | G7 | Scout team |
| B23 | 4A Listing reality check (confirms or cuts 36.7k) | 0 | | Permission (04 Q7) | Ops or Data |
| B24 | 1.12 Holdout cell 1 (confirms or removes 14.0k) | 0 | | Freeze (I1 Q8) | Data, Mkt |
| B25 | 3I Holdout cells 2 and 5 | 0 | | Freeze (03 Q1) | Data, Mkt |
| B26 | 1.10 Treatment log export | 0 | | Write grant (I1 Q11) | Dev, Data |
| B27 | 1.4 Amazon C-08 and live rule | 0 | | Who runs the job (I1 Q2), live rule (D-03) | Ops, Data |
| B28 | 1.13 Holdout cells 2 and 3 (01 side) | 0 | | Freeze | Data, Mkt |
| B29 | 2.5 "incomplete" status | 0 | | Caps and minimums (I2 Q3) | Dev |
| B30 | 3C Amazon titles (US Polo) | 0 | | Who owns Amazon titles (03 Q3) | Ops |
| B31 | 1.14 Noon traffic restored | 0 | | Who made the files (I1 Q4) | Ops, Data |
| B32 | 2.2 Evidence pack (optional) | 0 | | Portal access (I2 Q8) | Ops |
| B33 | 2.17 Home fragrance white main (optional) | 0 | | DD0 taxonomy | Dev |
| B34 | 1.17 Completeness score (optional) | 0 | | Owner adopts it (I1 Q7) | Data, Dev |
| | **Wave B total** | **53.9k** (high 147.9k) | 0.97k ad; 1.12k cash a year; 1.05k cash once | | |

### Wave C - unlocked by outside answers

| # | Sub-initiative | Base | Other money | Outside answer | Lane |
|---|---|---|---|---|---|
| C1 | 6.3 Callouts, p2p facts, other brands | 6.17k | | Noon and Namshi acceptance; Arabic reviewer; brand lettering confirmation (plus infographics amendment) | Dev, Ops |
| C2 | 6.4 Callouts, p2p facts, US Polo | 6.03k | | As C1 plus US Polo lettering | Dev, Ops |
| C3 | 6.5 Callouts on proposed facts | 44.9k | | As C1 and C2; 4D sheets; Naz confirms facts | Ops, Dev |
| C4 | 4F Namshi template fill | 26.70k | 0.32k cash a year | Real templates (G3); plus G1, G2 | Dev, Ops |
| C5 | 4G Noon template fill | 9.99k | 0.32k cash a year | As C4 | Dev, Ops |
| C6 | 4H Styli and Centrepoint template fill | 0 | 0.37k cash a year | As C4 | Dev, Ops |
| C7 | 5.1b Crops for the Styli / Centrepoint set | 14.69k | | Written channel specs; larger brand masters | Dev, Ops |
| C8 | 3F US Polo footwear views | 10.35k | 1.49k ad money | US Polo's files (ask needs owner Q2) | Ops |
| C9 | 3G Campus footwear views | 2.63k | 1.06k ad money | Campus's files (ask needs owner Q2) | Ops |
| C10 | 4J Review themes | 1.6k | | Arabic reviewer (G4) | Dev |
| C11 | 4K Noon reviews | 9.0k | | via 4J; Scout or Apify (G7) | Scout team or Dev |
| C12 | 4D Brand sheets FC, Puma, Nautica | 0 (high 18.6k) | | The three brands | Ops |
| C13 | 2.18 Noon white main for footwear | 0 | | Noon's fashion definition | Dev, Ops |
| C14 | 1.15 Namshi and Trendyol traffic | 0 | | Namshi and Trendyol | Ops, Data |
| C15 | 6.6 Use-case panels (optional) | 0 | | As C1 | Dev |
| | **Wave C total** | **132.1k** (high 459.6k) | 2.55k ad; 1.01k cash a year; 0.89k cash once | | |

Order note: the callout line (C1 to C3, 57.1k) comes first because it is the largest line in the wave; inside it, 6.3
and 6.4 run before 6.5 by dependency. The listing line (C4 to C6, 36.7k) is second; 4K follows 4J by dependency.

### Wave D - needs the generator yes and the fidelity gate holding

| # | Sub-initiative | Base | Spend avoided (once) | Also needs | Lane |
|---|---|---|---|---|---|
| D1 | 6.1b Lifestyle, US Polo | 52.21k | 2.9k to 4.7k | US Polo written confirmation | Dev, Naz, owner |
| D2 | 5.2 Generated missing roles | 8.55k | 1.30k to 2.09k | Modesty policy | Dev, Naz, second rater |
| D3 | 5.3 Flat lay to on-model | 7.27k | 179 to 286 | 5.2; real-model rights; DD8 registry | Dev, owner, Naz |
| D4 | 6.2 Composite still life | 4.16k | 0.5k to 0.8k | Brand confirmation; skips gate checks G1 to G4 | Dev, Naz |
| D5 | 6.1a Lifestyle pilot, other brands (goes first if its brand confirms before US Polo) | 3.43k | 3.8k to 6.1k | Pilot brand confirmation | Dev, Naz, owner |
| D6 | 3H Generated footwear views | carries (1 - s) of 3F and 3G | 2.7k to 4.3k | 3F and 3G answers; rights | Dev |
| | **Wave D total** | **75.6k** (high 218.7k) | 7.7k to 13.2k (plus 3H) | | |

### Parallel lanes

None of these lanes waits for another lane to start; arrows show order inside a lane.

| Lane | Wave A | Wave B | Wave C | Wave D |
|---|---|---|---|---|
| Owner | send all outside asks | roles and rule table, re-submission person, cropping amendment, G6, C-02 person, G1, G2, G5, G7, freeze OK, agency OK | infographics amendment (owner's own, needed with C answers) | generation and lifestyle amendments, generator yes, gate bars |
| Dev | 1.9 -> 2.4 -> 2.3 | 2.6 -> 2.7 -> 5.1a; waves 2.9 to 2.13, 2.19; 4C -> 4E; 1.10; 2.5 | 6.3 -> 6.4 -> 6.5; 4F -> 4G -> 4H; 5.1b; 4J | 6.1b / 6.1a, 5.2 -> 5.3, 6.2, 3H |
| Data | 4B step 1, 3A, 1.11, 1.5, 1.3, 1.16 | 1.2 acceptance -> 2.14; 1.4; 1.10 joins; 1.12, 3I, 1.13 | 1.15 landing | holdout cells for lifestyle and callouts |
| Ops | 1.1, 5.0 asks, 3B, 3D, 1.3 download | 2.8, 2.1, wave uploads, 2.15, 2.16, 1.7, 1.6 -> 1.8, 4B publish, 4A, 3C | 3F, 3G brand asks; 4D; Noon and Namshi asks; side-by-sides; Naz confirms facts for 6.5 | review-all, anchor approval |
| Mkt | (gains 3D ad money) | freeze for 2.9, 1.12, 1.13, 3I | | freeze for lifestyle and callout cells |
| Scout team | | 4I | 4K | |

### Reconciliation to 269.4k

- Wave totals: A 7.92k + B 53.90k + C 132.09k + D 75.62k = **269.53k**, shown as 269.5k.
- By initiative (sub-split sums): 01 6.69k, 02 21.44k, 03 12.98k, 04 60.89k, 05 50.60k, 06 116.90k = 269.50k.
- 06 and 07 show **269.4k** (6.7 + 21.5 + 13.0 + 60.7 + 50.6 + 116.9). The 0.1k gap is rounding: B7a is 24.2k exact
but 24k in 06 and 07 (+0.2k), offset by 02 (21.44k vs 21.5k), 03 (12.98k vs 13.0k) and 01 (6.69k vs 6.7k). No value
was added, removed or re-estimated.
- High: about 842k here against about 841k in 06 (04's exact 241.6k vs 241k). Highs overlap and are not additive in
practice (06). Low: 0.9k (5.3 only), 06's "about 1k".
- Ad money saved 1.51k + 0.97k + 2.55k = 5.03k (06: 5.0k). Cash a year 1.12k + 1.01k = 2.13k (07: about 2.1k).
Cash once 1.05k + 0.89k = 1.94k (07: about 2.0k).

---

## 4. Repo changes this would imply, if the owner agrees

Listed only; none is made by this proposal.

1. **07-roadmap.md:** replace "How the order was decided" and the "Phased view" with the four waves; correct

   Summary point 4 ("1, 2 and 3 can start now, 41.2k") to the Wave A / Wave B split; add the decisions-by-value table;
    point to this file.
2. **00-one-pager.md:** re-order "What we propose" around waves; replace "Steps 1 to 3 can start now (41k)"; split

   "What we need from the business" into the owner's own decisions and outside asks, ranked by value.
3. **initiatives/05 and 06:** split into numbered versions the way 02 was split (05: 5.0, 5.1a, 5.1b, 5.2, 5.3; 06:

   callout line 6.3 to 6.6 and lifestyle line 6.1a, 6.1b, 6.2), each with its own blockers and proof.
4. **initiatives/01, 03, 04:** add the sub-initiative tables and mini-roadmaps with the IDs used here (1.1 to 1.17;

   3A to 3I; 4A to 4K and gates G1 to G7); 02 gets the 2.1 to 2.19 IDs mapped onto its V1 to V4.
5. **SPEC amendment drafts, as separate documents for the owner to approve (SPEC.md itself only changes on the

   owner's yes):** cropping (DD2 R4); generation and the one lifestyle image (DD2 R4, DD4 R7); infographics (DD6
    R8); facts, listing copy and reviews (DD5 R7, DD7 R6); output order differing from upload order (I2 Risk 11).
    Note: SPEC.md's non-goal "no cap on images per product or per channel" conflicts with the caps in 2.5 and 2.7 and
    would need the same amendment.
6. **06-metrics-and-impact.md:** add the per-sub-initiative splits (formulas from the split files) as an appendix or

   a pointer, so each sub-value is traceable.
7. **Program doc and plan checklist in** `docs/plans/`**:** update the order and the owner question register to the

   ranking in section 5.

---

## 5. Owner questions, ranked by the value they unlock

"Value" is the base that cannot move without the answer. Most sub-initiatives need several answers, so the column
overlaps and does not add up to 269.4k. "Whose" says whether the answer is yours alone or needs someone outside.

| Rank | Question | Whose | Base it unlocks | Sub-initiatives | Also needed |
|---|---|---|---|---|---|
| 1 | Will US Polo confirm in writing that existing rights cover generated and lettered images of its products? | outside (owner asks) | 95.3k | 6.1b, 6.4, 6.5 US Polo part | Rows 2, 3, 4, 5 |
| 2 | Do you approve the generation package: generation and lifestyle SPEC amendments, the generator, gate bars and a second rater; and will the vendor give a written no-training position? | owner (vendor position outside) | 75.6k | 6.1b, 5.2, 5.3, 6.2, 6.1a (and 3H) | Brand confirmations |
| 3 | Who is the native Arabic reviewer for the glossary and golden sets? | outside / owner | 67.7k | 6.3, 6.4, 6.5, 4J, 4K | Rows 4, 5 |
| 4 | Do you approve the infographics SPEC amendment (DD6 R8)? | owner | 57.1k | 6.3, 6.4, 6.5 | Rows 3, 5 |
| 5 | Will Noon and Namshi confirm in writing that a callout image is accepted as an additional image? | outside | 57.1k | 6.3, 6.4, 6.5 | Rows 3, 4 |
| 6 | Do you approve the role taxonomy, the channel rule table, caps and minimums, and "cut product never image 1" (I2 Q1, Q3, Q4, DD0), with the SPEC update for output order? | owner | 53.9k | 2.6, 2.7, all brand waves, Noon recovery, 5.1a, 5.1b | Row 10 |
| 7 | Do you approve the facts, listing copy and reviews SPEC amendment (G2), and who grants the p2p read (G5)? | owner | 47.3k (and the fact sheet behind 6.5) | 4C, 4F, 4G, 4J, 4K | Rows 8, 9 |
| 8 | Does the GCC module own GCC listing content, with India keeping India channels (G1)? | owner | 36.7k (+1.01k cash a year) | 4F, 4G, 4H, 4E | Rows 7, 9 |
| 9 | Can we get real blank templates and agency-filled examples per channel (G3)? | outside | 36.7k | 4F, 4G, 4H | Rows 7, 8 |
| 10 | Do you approve the cropping SPEC amendment (DD2 R4)? | owner | 32.5k (+0.97k ad money) | 5.1a, 5.1b, 3E | Row 6 |
| 11 | Who re-submits changed images in each portal, and does any channel take a listing offline for re-review (I2 Q6)? | owner | 21.4k | 2.8 and every wave | Row 6 |
| 12 | Will Styli and Centrepoint give their written image specs, and will brands send masters of 2,400 px or more? | outside | 14.7k (and confirms 5.0's 2.3k) | 5.1b, 5.0 | Row 10 |
| 13 | Who confirms a "runs large / small" note before it publishes (G6)? | owner | 13.6k | 4B | none |
| 14 | Do we ask US Polo and Campus for the missing footwear views now, and who sends it (03 Q2)? | owner, then outside | 13.0k (+2.55k ad money) | 3F, 3G | Brand files |
| 15 | Who builds the Scout reviews entity, and may we use one capped Apify account (G7)? | owner | 10.6k | 4I, 4J, 4K | Row 3 |
| 16 | Who lands the Noon Not Live export (I1 Q1)? | owner | 7.5k | 1.2, 2.14, 2.15, 2.16 | Rows 6, 11 |
| 17 | Do you approve moving resizing and links off the agency, and what is the INR 60 split (I2 Q10)? | owner | 1.12k cash a year | 2.1 | Uploader (row 11) |
| 18 | Which Amazon and Noon clusters are deliberately off (I1 Q13, R5); who restarts the Trendyol list (I1 Q6)? | owner | 1.05k | 1.7, 1.6, 1.8 | none |
| 19 | Proof and visibility questions with 0 counted value but deciding whether the judged base is real: the bid, budget and price freeze (I1 Q8, 03 Q1); the BigQuery write grant (I1 Q11); who enters upload dates (I1 Q12); the test unit (I1 Q10); permission for the listing reality check (04 Q7); who owns Amazon titles (03 Q3); who acts on guard failures (03 Q4); Noon's fashion definition (I2 Q2); the completeness KPI (I1 Q7) | owner (Noon outside) | 0 counted; decides how much of 262.7k judged base is real | 1.10 to 1.13, 2.9, 3I, 4A, 3C, 3A routing, 2.18, 1.17 | none |

Status: proposal, awaiting owner review
