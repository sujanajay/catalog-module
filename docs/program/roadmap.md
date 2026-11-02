# Catalog OS release plan

Status: draft for Sujan. Planning only: nothing here has been built or deployed.

Inputs: `module-map.md`, `brief-v1.md`, `intents.json`, `requirements/00-template.md` (settled decisions),
`requirements/M0` to `M12`, `requirements/UX-design-system.md`, `owner-questions.md` (owner answers recorded there).
Session briefs that turn this plan into work: `sessions/README.md`.

## 1. How to read this

- **No timelines.** This plan has no dates, weeks or durations. Releases are ordered by value and by true dependency
  only. The one exception is statistics: an experiment readout is due "after N weeks of data", and that is written only
  inside `requirements/M4-measurement.md`. Durations that describe how the product behaves (for example "contamination
  detected within 7 days", "export freshness under 24 hours") are requirements, not schedule, and stay.
- **Release.** A bundle of features from several modules that goes out together because only together is it meaningful
  to the operator or the business. Each release below has its value in one line, its features (module and feature id,
  plus slice ids), what it depends on, its exit outcome (measured on real data, not "slices merged") and its human gates.
- **Slice.** One piece of work for one worker in one worktree, ending in one PR. Slice ids come from each module's
  "Build slices" table (for example `M0-S2`). New ids added by this plan are marked "new".
- **Depends on** lists only true dependencies: the release cannot pass its exit test without the other work merged.
- **Build-ready** means the requirements are deep enough for a build session: P0 features are written in full; P1 at
  medium depth; P2 and Later briefly. A release that is not build-ready gets a requirements session first.
- Old dates still written in documents this pass did not edit (for example parts of `M4-measurement.md`, `M10-learning.md`
  and `module-map.md`) are superseded by this plan. Ordering comes from here.

## 2. Releases at a glance

| Release | Name | Value in one line | Depends on | Requirements |
|---|---|---|---|---|
| R1 | Upload and walk away | An operator drops any batch and walks away; every product gets links and one digest, through deploys and vendor failures, with the true cost shown and every output recorded | none | Build-ready: `sessions/R1-build.md` |
| R2 | Complete and measured | Every Namshi and Noon apparel option gets its channel's full shot set from the brand's own photos, checked by a measured gate, verified live, inside a frozen holdout whose readout runs itself | R1 | Build-ready: `sessions/R2-build.md` |
| R3 | Made where nothing else works | Where no crop can fill a required shot, a bought generator makes it from the brand's own models, our fidelity checks gate it, and any new vendor is scored and promoted without code | R1, R2 | Needs requirements: `sessions/R3-requirements.md` |
| R4 | Every listing has words | Grounded English and native Arabic text, attributes and filled listing files per channel, with rejections turned into fixes and rules | R1, R2 | Needs requirements: `sessions/R4-requirements.md` |
| R5 | Learn what sells | Effects pooled across brands tell us what to scale and what to stop, and a winning search term updates every place it belongs in one change | R2, R4 | Needs requirements: `sessions/R5-requirements.md` |
| R6 | Rich media | Infographics (English and Arabic), still-life and worn scenes, on-model faces, A+ and video, each by policy and each measured | R3, R4, R5 | Needs requirements: `sessions/R6-requirements.md` |
| R7 | Self-serve | A second organisation signs up, adds a brand and gets links, text and files with no engineer | R1 to R4 | Needs requirements: `sessions/R7-requirements.md` |

R3 and R4 do not depend on each other and can be built side by side. R5 needs the first holdout readout (from R2) and
the text from R4.

### Changes to the suggested shape, and why

1. **The readout machinery is in R2, not R5.** The estimator library (`M4-S6`) and the readout job and page (`M4-S7`)
   need only the outcome panel. If they sat in R5 the first holdout readout would wait for text (R4). R2 ships them and
   tests them on injected and A/A data; the readout then runs itself when M4's pre-registered data window closes. That
   readout is an event, not a release.
2. **The vendor interface (`M7-S2`) and matting behind it (`M3-S5`) moved into R1.** "Walk away" fails if one vendor
   outage stops a batch (I003). The interface has no dependency, and R2's analyzer call (`M2-S4`) needs it.
3. **The likeness flag is a setting in R3; the full rights record moved to R6.** Sujan confirmed Opptra holds likeness
   rights (Q15). R3 needs only a per-brand flag that the owner sets, which the R1 settings store already supports. The
   full rights record with lifestyle scope, kids and expiry (`M12-S6`) is only needed for scene ceilings in R6.
4. **Brand DNA (`M12-S5`) is in R4.** Its first real user is brand voice and banned words for text (M8, M7-F9). Putting
   it in R3 would have made R4 wait for R3.
5. **The settings UI (`M12-S2`, `M12-S3`, `UX5`, `UX6`) is in R3.** R3 adds the first risky switches (generation on,
   vendor routes, spend caps, the likeness flag); they need history, preview and revert. Owner approvals for many people
   (`M12-S4`) wait for roles in R7.
6. **The M6 P1 slice `M6-S7` is split.** Tiered tests (new `M6-S7a`) are in R1 as asked. Retry and checkpoint, idle
   control, the remaining quota and the separate load-test capacity (new `M6-S7b`) are in R2, because the treatment batch
   is the first large run and must not fail.
7. **The conflict register and rule editor (`M5-S4`, `M5-S5`) are in R2.** R1 needs only rules as data and the snapshot
   with the background change. The editor matters when the shot-set policy and crop switches reach marketplaces in R2.
8. **"Already-live products on request" (`M1-F6`) is in R2.** The holdout treatment re-processes about 700 live options;
   that is this path. R1 batches touch only newly uploaded products, so R1 cannot change a future control's content.
9. **Rejection learning stays with listing files in R4.** Files go out and rejections come back; one without the other
   teaches nothing.

## 3. Rules that apply to every release

### 3.1 One writer per module, one worker per slice
- At any time a module has at most one slice in progress. The next slice of that module starts from the merged result.
- Named exceptions (they touch only new files or a separate service, so they cannot clash with the module's main writer):
  - `M2-S3` (people detector in `services/matting`), in parallel with the other M2 slices;
  - `M0-S4` (BigQuery export job and `infra/` script), in parallel with `M0-S2` and `M0-S3`;
  - `M6-S4` (deploy safety in `infra/` and `.github/workflows/ci.yml`), in parallel with `M6-S1`.

### 3.2 Migrations
- One migration per slice at most. The number is taken at merge time: rebase on main, take the next free number in
  `packages/core/drizzle`, regenerate `meta/_journal.json` and the snapshot, re-run CI. `M0-S1` is `0009`; any other
  number written in a requirements doc is indicative only.
- Two open PRs with migrations are allowed; the second to merge renumbers. The migration lint from `M6-S4` checks that
  every migration is additive (no drop, no rename, no type change) so that a batch survives the deploy.

### 3.3 Hot files (shared by several modules)
A slice that edits one of these says so in its PR title, and only one open PR at a time may edit each one. The others
rebase after it merges.

| Hot file | Slices that edit it |
|---|---|
| `packages/core/src/db/schema.ts`, `packages/core/drizzle/meta/*` | every slice with a migration (M0-S1, M1-S3, M1-S5, M2-S1, M4-S1/S3, M5-S1, M6-S1, M6-S6, M7-S1/S2/S4, M9-S1, M10-S1a, M12-S1, and later ones) |
| `packages/core/src/catalog/types.ts` (ChannelId, OUTPUT_FLAGS) | M5-S1, M3-S1, M3-S4, M3-S8 |
| `packages/core/src/catalog/channels.ts`, `compliance.ts` | M5-S3, M3-S1 |
| `packages/core/src/catalog/render.ts` | M3-S1, M0-S7 (guard in the render key), M3-S2 |
| `packages/core/src/pipeline/publish.ts`, `report.ts` | M0-S3, M1-S3, M1-S5, M3-S3 |
| `apps/worker/src/catalog/finalize.ts` | M0-S3, M1-S3, M1-S5, M8-S1, M9-S4 |
| `apps/web/components/catalog/CatalogWizard.tsx` | M1-S1, M1-S2, UX3 |
| `apps/web/app/catalog/ops/page.tsx` | M6-S2, M6-S6, M9-S2, M12-S7 |
| `packages/core/src/qa/judge.ts`, `qa/classify.ts`, `cost.ts` | M7-S2, M2-S4, M6-S1 |
| `infra/deploy.sh`, `infra/lib/*.sh` | M6-S4, M6-S5, M0-S4 (new script only) |
| `.github/workflows/ci.yml` | M6-S4, M6-S7a, UX2 |

### 3.4 Models
- **Sonnet:** collection and reading work (scraper field checks, reading vendor docs and websites, gathering channel
  templates, hand counts, summarising logs, read-only queries).
- **Opus:** all building, all reviews, all planning by default.
- **Fable:** only for critical design, and only when Sujan asks for it. Places where it would be worth asking: the M0
  contract freeze review before `M0-S1` merges (R1), the M4 pre-registration review before the freeze (R2), the M10
  pooled model design (`M10-S5`, R5).

### 3.5 Review and ship (every PR)
1. The worker builds, runs the slice's acceptance test and the repo tests, and commits on its feature branch.
2. A fresh reviewer with clean context (`ce-code-review`, which has not seen the worker's reasoning) reviews the diff
   against the slice's requirement text. Findings are fixed in the same branch.
3. Ship with `ce-commit-push-pr` (the repo has no no-mistakes gate). CI must be green.
4. Sujan merges every PR. Nobody else merges until Sujan says Phase 2 of the merge rules has started.
5. A production deploy needs Sujan's typed approval naming the commit; the manager runs `bash infra/deploy.sh` itself.
6. Every subagent writes its full report to `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<date>-<slug>.md` and
   replies in at most 120 words.

## 4. Human gates

| Gate | Where | Who | What is approved |
|---|---|---|---|
| G1 Production deploy | every deploy, every release | Sujan, by typed approval naming the sha | That commit goes live |
| G2 Holdout pre-registration and freeze | R2, before the treatment batch; again for every new registered experiment | Sujan (measurement owner, Q8) | The one-pager from `M4-S4`: pool, pairs, MDE, primary metric, readout points. After the freeze the arms cannot change |
| G3 Treatment go/no-go | R2, after the treatment batch passes the release gate | Sujan | The channel team uploads the treatment; if the upload cannot start inside the pre-registered window, Sujan decides here whether to re-register |
| G4 Paid vendor contract | R3 (generation, overflow matting), R4 (text model or text vendor), R5 (bought market data), R6 (scene and video vendors) | Sujan | Any paid call beyond trials; every vendor's terms must say it does not train on our images (Q13 default) |
| G5 Marketplace-facing change | the first file of a new kind per channel | Sujan, with the channel manager | R1 first upload with the new background; R2 first treatment upload; R3 first generated image; R4 first AI text and first listing file; R6 first infographic, scene, A+ and video |
| G6 Rule conflicts | before the module that needs them | Sujan | Image-side highs (Q6) and text conflicts C01, C03, C04 (Q11): the recommended answers apply (owner answers) |
| G7 Promotion | R5, each "Scale" card from M10 | Sujan | A winning change becomes the default, with a 10% permanent holdout |
| G8 Per-brand likeness flag | R3 and R6 | Sujan (owner only) | Turning on generated people for a brand (Q15) |

## 5. R1 Upload and walk away

**Value.** An operator drops any batch and walks away; every product gets links and one digest, through deploys and
vendor failures, with the true cost shown and every output recorded in the graph.

**Features.**

| Module | Feature | Slices |
|---|---|---|
| M0 Catalog graph | M0-F1 Product and listing graph (keys, style key F1-R8) | M0-S1, M0-S2 |
| M0 | M0-F2 Content versions, and the change log with change reasons (F3-R9) | M0-S3 |
| M0 | M0-F5 Daily export to BigQuery | M0-S4 |
| M10 Learning | M10-F1 Change-type table v0 (only the piece every producer stamps) | M10-S1a |
| M12 Admin | M12-F1 Settings store with snapshot at batch start, owner allow-list, plain admin list page | M12-S1 |
| M1 Intake | M1-F1 Any-shape upload; M1-F2 Self-advancing wizard; M1-F3 Auto-decide with provisional links; M1-F4 One digest; M1-F5 Resumable drafts | M1-S1 to M1-S6 |
| M2 Analyze | Taxonomy, attribute and shot-role tables as data (enabler for M5) | M2-S1 |
| M5 Channel rules | M5-F1 Rules as data; M5-F4 Rule checks in pipelines, with the batch snapshot and the C10 background change | M5-S1, M5-S2, M5-S3 |
| M3 Images | M3-F3 Channel renders from rules (240+ grey, white Amazon image 1); M3-F2 matting and upscaling behind the M7 interface | M3-S1, M3-S5 |
| M7 Quality | M7-F2 Vendor interface and fallbacks | M7-S2 |
| M6 Reliability and cost | M6-F1 True cost meter v1; M6-F2 Batches survive deploys (zero-downtime deploys) and shorter deploys; M6-F3 Batch success tracking; M6-F8 Tiered tests | M6-S1, M6-S2, M6-S4, M6-S5, M6-S6, M6-S7a (new) |
| UX | Tokens, copy lint, DropZone page, digest tab and email | UX1, UX2, UX3, UX4 |

**Depends on.** Nothing. Owner actions that improve it but do not block it: read-only `ila-pg` user (cost and
reliability numbers), OpenRouter paid key with no daily cap.

**Exit outcome (measured on an operator proof run: a real Vero Moda or French Connection apparel batch to links on the
five slice channels).**
1. Links for 100% of products, provisional ones flagged; zero required clicks after the upload; one digest; zero
   orphaned drafts.
2. A batch started during a deploy finishes cleanly; batch success rate and incidents recorded per batch.
3. Killing the primary judge still completes the batch.
4. Cost per product within 10% of monitoring-derived spend.
5. Every link in the batch has a version row with role, source, hash, channel and publish time, visible in BigQuery at
   the next export; every change event carries a reason and a change type.
6. Noon, Namshi and Trendyol backgrounds at 240+, Amazon image 1 white; a batch started before a rules publish keeps its
   pinned version; an admin setting changed mid-batch affects only the next batch.
7. A copy-only change is green in CI in under 10 minutes; a render change runs its tiers in under 15.
8. Baseline numbers recorded for R2's comparison: touches per 1,000 SKUs, time to first links, cost per product.

**Human gates.** G1 for each deploy; G5 for the first upload of renders with the new background per channel.

## 6. R2 Complete and measured

**Value.** Every Namshi and Noon apparel option gets its channel's full shot set from the brand's own photos, checked by
a measured quality gate and a sampled audit, verified live by our own scrape, inside a frozen, pre-registered holdout
whose readout runs itself.

**Features.**

| Module | Feature | Slices |
|---|---|---|
| M2 Analyze | M2-F1 Decision-grade image analyzer (measurements, people detector, one vision call, ladders, release states); M2-F2 Gap report | M2-S2 to M2-S7 |
| M3 Images | M3-F1 Crops that complete the set; M3-F4 Image set policy and channel switches | M3-S2, M3-S3, M3-S4 |
| M7 Quality | M7-F1 Golden sets (wave 1) and the scoring runner; M7-F3 Audit sampling | M7-S1, M7-S3, M7-S4 |
| M5 Channel rules | M5-F2 Conflict register; M5-F3 Admin rule editor | M5-S4, M5-S5 |
| M0 Catalog graph | M0-F3 Treatment log and live verification (assignment write path and guard; live verifier); M0-F4 Backfill | M0-S7, M0-S6, M0-S5 |
| M9 Publish and monitor | M9-F1 Live content watch (own scrape of Noon and Namshi, UAE and KSA; gallery states; contamination alert) | M9-S1, M9-S2 |
| M4 Measurement | M4-F1 Outcome panel and event calendar; M4-F2 Randomized holdout; M4-F3 Registry and pre-registration; M4-F4 Guardrails; M4-F5 Estimators v1; readout job and page (F3-R5/R6, F8) | M4-S1 to M4-S7 |
| M1 Intake | M1-F6 Already-live products on request (the treatment batch path) | M1-S7 (new) |
| M6 Reliability and cost | M6-F4 Idle control; M6-F5 Retry and checkpoint; M6-F6 the remaining memory and vCPU quota and the shape raise; M6-F7 Separate load-test capacity (temporary Cloud SQL, Q16); billing reconciliation when the export is on | M6-S7b (new), M6-S3 |
| M12 Admin | M12-F2 Ops page additions (audits, live check, incidents) | M12-S7 |
| UX | Results page (ExperimentCard, EstimateBar, TrendLine) | UX8 |

**Depends on.** R1: graph tables, keys and write path (`M0-S1` to `M0-S3`), rules snapshot (`M5-S1` to `M5-S3`), render
from rules (`M3-S1`), vendor interface (`M7-S2`), auto-decide and digest (`M1-S3`, `M1-S5`), deploy safety (`M6-S4`),
settings store (`M12-S1`), change types (`M10-S1a`). Owner inputs, all answered: labellers and an auditor (Q1), legal OK
to scrape our own listings (Q2), Sujan as measurement owner (Q8), the channel team's upload and the blind-arms letter
(Q10). `M6-S3` waits only for the billing export and is not in the exit test.

**Exit outcome (measured).**
1. Treated Namshi and Noon options reach five-shot compliance above 80%.
2. The experiment is frozen with its MDE in the registry before the first treated publish; zero control options
   published to (refusals logged by the guard).
3. At least 90% of treated listings verified live within 14 days of the upload (scrape plus Trendyol feed).
4. Per-attribute accuracy report with intervals on golden wave 1; fields below their bar stay `shadow` and are not used.
5. Gap report counts match a hand count on the golden sample; audit sampling runs at 3% with cell states.
6. A hand-edited control is flagged as contaminated within 7 days.
7. The estimator recovers an injected +20% within 2 points; the A/A false positive rate is about 5%; the readout job
   refuses to run before its pre-registered point.
8. A 200-product preview batch with 5% injected storage and database resets succeeds; a load run on separate capacity
   leaves live latency unchanged.
9. After numbers against the R1 baseline: touches per 1,000 SKUs, time to first links, cost per product.

**Human gates.** G2 freeze; G3 treatment go/no-go; G5 first treatment upload on Namshi and on Noon; G1 for each deploy.

**After R2: the readout.** The readout publishes itself at the points M4 pre-registered. The expected result is a bounded
null ("below X%"); that still passes. Sujan reads it; it feeds R5.

## 7. R3 Made where nothing else works

**Value.** Where no crop can fill a required shot, a bought generator makes it from the brand's own models, our own
fidelity checks gate it, and any new vendor or model is scored and promoted without code.

**Features.**

| Module | Feature | Slices |
|---|---|---|
| M3 Images | M3-F5 Generated missing shots (mode A); M3-F6 AI-image source flag; M3-F7 Ghost mannequin and flat lay to on-model; M3-F8 Try-on and model swap | M3-S6, M3-S7, M3-S8; new slices for F7 and F8 |
| M7 Quality | M7-F4 Fidelity check; M7-F5 Planted-defect tests; M7-F6 Staged gate with automatic promotion; M7-F7 Vendor bake-offs; M7-F8 Blocking human calls | M7-S5, M7-S6, M7-S7, M7-S8, M7-S9a (new split) |
| M12 Admin | Per-brand likeness flag (owner only, Q15) in the settings store; M12-F1 Settings UI with preview by replay | flag in M12-S1 data; M12-S2, M12-S3 |
| UX | NeedsYouCard and "make it a rule"; settings components | UX5, UX6 |

**Depends on.** R1 (`M7-S2` interface, M6 cost meter and caps, `M12-S1`), R2 (`M7-S1`, `M7-S3`, `M7-S4` golden set,
scoring and audit; `M3-S3` slot planner; M2 analyzer). Owner inputs: Q13 (bake-off budget, no-training clause; default
applies), Q14 (answered 2026-11-03: Noon and Namshi accept AI-made images, so their `generated_allowed` is on; Styli and
Centrepoint never take crops), Q15 (answered: likeness rights held; per-brand flag).

**Exit outcome (measured).**
1. On the M7 generation golden set the chosen route catches every planted defect with zero product-truth false passes.
2. A real batch with generation on for one brand: every generated image flagged and checked, cost within the cap;
   killing the first vendor completes through the second.
3. A new vendor plugged in produces a scored comparison without a code change (I012).
4. Zero generated images on a channel whose `generated_allowed` is off; zero generated people for a brand whose
   likeness flag is off; zero stored face embeddings or biometric templates (tested by inspection of storage and logs).
5. Required-role completion on the channels that allow generation rises above the R2 crop-only level.

**Human gates.** G4 for each paid generation and overflow contract; G8 per brand; G5 for the first generated image per
channel; G1.

**Requirements status.** P1 and P2 at medium or brief depth. Needs `sessions/R3-requirements.md`.

## 8. R4 Every listing has words

**Value.** Grounded English and native Arabic titles, bullets, descriptions, attributes and filled listing files per
channel, with every rejection turned into a fix and a rule.

**Features.**

| Module | Feature | Slices |
|---|---|---|
| M8 Text | M8-F1 Titles, bullets and descriptions; M8-F2 Arabic and bilingual text; M8-F3 Keywords from paid search terms; M8-F4 Size charts; text sheet and settings | M8-S0 (prototype and buy or build memo), M8-S1 to M8-S5 |
| M2 Analyze | M2-F3 Product facts; M2-F4 Category and taxonomy mapping; M2-F5 Listing quality score per marketplace | new slices |
| M5 Channel rules | M5-F5 Channel gaps workflow; M5-F6 Claims and banned words; M5-F7 Brand consistency rules; M5-F8 Arabic and right-to-left rules | M5-S6 |
| M7 Quality | M7-F9 Bilingual consistency check | M7-S9b (new split) |
| M9 Publish and monitor | M9-F2 Listing files per channel; M9-F3 Liveness and rejection feedback; M9-F4 Rejection learning | M9-S3 to M9-S6 |
| M0 Catalog graph | M0-F7 Variants and size runs; M0-F8 Brand master and channel overlay | new slices |
| M12 Admin | M12-F3 Brand DNA (look, logos, voice, add-a-brand) | M12-S5 |
| UX | Product page (ChannelGallery, BilingualText, ChannelPreview, ImageCompare) | UX7 |

**Depends on.** R1 (`M5-S2` evaluate, `M0-F2` versions, M7 interface), R2 (M2 analyzer, M7 golden set and audit, M4
control flags, `M5-S5` editor). The buy or build decision for M8 and M9 rests on the Streamoid and Rubick website
teardown (`C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-03-streamoid-rubick.md`) plus our own prototype
(`M8-S0`); no vendor demo (Q4). Owner inputs, answered: Arabic readers (Q9), C01, C03 and C04 (Q11 defaults), text cost
ceiling USD 0.25 per product (Q12). Default applies: data team owns the stale Noon not-live feed (Q3).

**Exit outcome (measured).**
1. English text live on Noon, Namshi, Trendyol and Amazon.ae for options outside the experiment (or inside a newly
   registered one), passing M5 checks and the M7 audit at 3% sampling with under 10% failures.
2. Arabic on Noon: two native raters give a mean of 4.2 or more on the calibration set with zero factual mismatches.
3. Noon and Namshi listing files filled for a real batch with zero wrong cells against the golden fill; the first portal
   upload of each accepted, or its exact rejection recorded and fixed.
4. Reason coverage of not-live listings moves from 38% toward 90%; repeat rejections of a cause fall after its rule is
   active.
5. Text cost per product within the USD 0.25 ceiling, shown in the cost meter.

**Human gates.** G5 for the first AI text and first listing file per channel; G4 if a text vendor or paid language model
is chosen; G2 for any text experiment on treated or control listings; G1.

**Requirements status.** All P1 at medium depth; M2-F3 to F5 and M0-F7, F8 have no slices yet. Needs
`sessions/R4-requirements.md`.

## 9. R5 Learn what sells

**Value.** Effects pooled across brands tell us what to scale and what to stop, with bounds, and a winning search term
updates title, backend terms and (later) the infographic in one measured change.

**Features.**

| Module | Feature | Slices |
|---|---|---|
| M10 Learning | M10-F1 Change-type classifier; M10-F2 Budget and priority; leading indicators; traits model; M10-F3 Pooled estimates; M10-F5 Recommendations with promotion; M10-F4 Cross-pollination | M10-S1b, M10-S2 to M10-S7 |
| M4 Measurement | M4-F5 (staggered DiD, synthetic control), M4-F6 Country-split and staggered designs; M4-F7 Secondary signals; M4-F8 Channel outcomes view (F8-R4; the readout page itself is in R2); M4-F9 Public market covariates (buy); M4-F10 Calibration against Amazon MYE | M4-S8, M4-S9; new slices for F9, F10 |
| M8 Text | M8-F5 Arabic keyword research | new slice |
| M9 Publish and monitor | M9-F6 Re-enrichment after go-live (how winners reach live listings) | new slice |
| M2 Analyze | M2-F7 Market and category census (bought data, covariates) | new slice |

**Depends on.** R2 (the first holdout readout, M4 registry, outcome panel), R4 (M8 titles and backend terms, the
search-term job `M8-S3`, the keyword winner interface), R1 (change types). Slices with only R2 dependencies
(`M10-S1b`, `M10-S2`, `M10-S3`, `M4-S8`, `M4-S9`) can be built while R3 and R4 are built; the release goes out together.

**Exit outcome (measured).** Pooled model recovers injected cell effects on simulated data and placebo cells centre on
zero; at least one promotion made through G7 with its 10% holdout registered in M4; a winning term on Noon becomes one
change set across title and backend terms, logged with its parent signal and measured as a change type; the priority
plan shows the revenue share covered by experiments.

**Human gates.** G7 for each promotion; G2 for each new experiment; G4 for bought market data; G1.

**Requirements status.** P1 and P2; M10 Appendix B holds method detail but no slice-level spec for several items. Needs
`sessions/R5-requirements.md`.

## 10. R6 Rich media

**Value.** Infographics in English and Arabic, still-life and worn scenes, on-model faces from the brand's own models,
A+ and listing video, each chosen by policy (never per product) and each measured through M4.

**Features.**

| Module | Feature | Slices |
|---|---|---|
| M11 Rich media | M11-F1 Infographics, English and Arabic (slot layer, composer, RTL, highlight picker, channel acceptance pilot, registration) | M11-S1 to M11-S6 |
| M11 | M11-F2 Lifestyle scenes for shoes and bags (still life, then worn and carried) | M11-S7, M11-S8 |
| M11 | M11-F3 Brand faces and kids (no stored biometric data; Q18 resolved by design) | M11-S10 |
| M11 | M11-F4 A+ content (Amazon.ae and Amazon.sa by download pack); M11-F5 Listing video (stills to motion) | M11-S9 |
| M12 Admin | Rights record with lifestyle scope, kids and expiry; ceilings enforced in M11 | M12-S6 |

**Depends on.** R3 (`image.make`, fidelity, AI flag, likeness flag), R4 (M8 English and Arabic text, M7-F9 bilingual,
M5 Arabic rules, Brand DNA look), R5 (`M10-S7` for the infographic in the cross-pollination change set). Owner input:
channel managers' answers on overlays (C19) and video (Q14; default applies: no overlays on Noon and Namshi until
answered).

**Exit outcome (measured).** Infographics live on every channel whose overlay rule is "documented"; acceptance rate per
asset type and channel recorded; each asset type registered in M4 before its first treated publish; zero face outputs
for a brand whose likeness flag is off; zero stored face embeddings or biometric templates.

**Human gates.** G5 per asset type and channel; G4 for scene and video vendors; G8 per brand; G2 per asset type; G1.

**Requirements status.** P2 and Later, written briefly. Needs `sessions/R6-requirements.md`.

## 11. R7 Self-serve

**Value.** A second organisation signs up, adds a brand, drops a folder and gets links, text, files and a digest with no
engineer; its data is invisible to Opptra users and it is billed per product processed.

**Features.**

| Module | Feature | Slices |
|---|---|---|
| M12 Admin | M12-F4 Roles and permissions; owner approvals; template mapping in the add-channel flow; M12-F5 Multi-tenant and self-serve (sign-up, billing, data separation); M12-F6 Onboarding hook; M12-F7 Agent and MCP access | M12-S4, M12-S8, M12-S9; new slices for F5 to F7 |
| M1 Intake | M1-F7 Product from photos or a web page | new slice |
| UX | Notification centre; accessibility and mobile pass | UX9, UX10 |

**Depends on.** R1 to R4 (an outside brand needs upload to links, quality, text and files). `org_id` already exists on
new tables (M0, M12 D6). Owner inputs, answered with the defaults (Q19): pricing per product processed; data in the
region of the customer's main market.

**Exit outcome (measured).** A test organisation signs up, adds a brand, drops a folder and receives links and a digest
with no engineer involved; its data is invisible to Opptra users (tested); its cost is billed per product processed; a
scoped operator cannot change another brand's setting.

**Human gates.** G1; Sujan approves the first outside customer.

**Requirements status.** Later, written briefly. Needs `sessions/R7-requirements.md`.

## 12. Not in a release yet

| Feature | Why it waits |
|---|---|
| M3-F9 Colour variants from one shot (Later) | Needs M3-F5 to prove fidelity and a channel stance on generated images; revisit after R3 |
| M8-F7 Answer-engine copy (Later) | No GCC channel asks for it today |
| M9-F5 Marketplace APIs where allowed (P2) | Needs Trendyol API credentials (Q14) and an owner decision on any write API |
| M2-F6 Web research for missing attributes (P2) | Revisit when R4 shows which attributes stay missing |

Skipped features stay as listed in `module-map.md` (try-on widgets, digital twins, ad-creative video, price and stock
sync, Google and Meta feeds, Amazon keyword database, per-SKU approvals, GDSN).

## 13. Risk register

| # | Risk | Likelihood | Effect | Mitigation | Owner |
|---|---|---|---|---|---|
| K1 | Holdout pool or pairs not ready when the treatment batch is | Medium | Treatment slips into a noisier season | Critical path (`M0-S2`, `M9-S1`, `M4-S2` to `M4-S4`) starts first in R2; fallback pool uses Trendyol counts; G3 can re-register | Manager |
| K2 | Saudi pages block the scraper | Medium | KSA gallery counts and live checks missing | Plain fetches first; Saudi proxy up to USD 100 a month (Q5 default); Trendyol and M0 records as fallback | Manager |
| K3 | Channel team cannot upload the treatment when it is ready | Medium | The clock starts late | Upload pack ready at G3; re-registration decided at G3 | Sujan |
| K4 | Golden labels slower than the build | Medium | The release gate cannot pass; analyzer fields stay `shadow` | Start with 100 labels; `M2-S7` lets fields go live one by one | Sujan |
| K5 | Many parallel lanes collide on `schema.ts` and `finalize.ts` | High | Rebase churn, broken migrations | Merge-time numbering; merge order in the build briefs; one open PR per hot file | Manager |
| K6 | A deploy during the holdout breaks a batch or changes a treated listing | Low | Biased estimate or outage | `M6-S4` first; the guard refuses writes to frozen listings; deploys need G1 | Manager |
| K7 | Ads or merchandising teams edit controls | Medium | Contamination | Blind-arms letter (Q10); M0 detects, M9 alerts, M4 accounts within 7 days | Sujan |
| K8 | Readout is a null | High (expected) | Disappointment | The brief sets a bounded null as the expectation; value also counted in touches, time and cost | Sujan |
| K9 | Streamoid or Rubick are better at text or files | Medium | Building M8 and M9 wastes effort | Website teardown plus our prototype decide before `M8-S1` (Q4) | Sujan |
| K10 | Shared `ila-pg` has no connection budget | Medium | Outage during a batch or deploy | Budget in `deploy.sh` (`M6-S4`); load tests on a temporary Cloud SQL instance (Q16) | Manager |
| K11 | Regional memory and vCPU quota cap throughput at scale | Medium | Slow catalog-wide runs | GPU quota is granted (6 RTX PRO 6000 in asia-south2, 3 L4 in asia-southeast1); use current capacity; file the memory and vCPU asks (`M6-S7b`) | Sujan |
| K12 | Noon or Namshi refuse generated images or overlays | Medium | Rejections | Crops first; channel-manager confirmation before G5; rules stay "assumed" until confirmed | Sujan |
| K13 | Overfitting to our own benchmark | Medium | Offline wins that do not convert | M4 live readouts are the final gate for promotion | Manager |
| K14 | Too many workers for the manager's context | Medium | Slower coordination | Cap at six lanes if needed; reports to `.runs` | Manager |
| K15 | Generated people drift from the brand's real model | Medium | Off-brand or misleading images | Brand's own model photos as generation inputs; in-memory similarity check (nothing stored); sampled human audit at the higher rate | Manager |

## 14. Integration decisions carried forward

The consistency review fixed about 25 inconsistencies directly in the module docs. Each module doc has a section 9 (UX:
section 17) "Integration decisions". The ones that shape this plan:
- Style key, change reason, change types and the settings store were P1 but needed by P0 work; they are in R1
  (`M0-F1-R8`, `M0-F3-R9`, `M10-S1a`, `M12-S1`).
- One matcher and one pHash setting (6, uncertain 7-12) in M0; M9 owns gallery states only.
- One taxonomy (M2); M5 references it. One audit rule (M7: 3% sampling; a cell fails at 10% over 200 audits; after a
  failure, 10% sampling until 100 clean; floor 2%).
- No module "holds" output: when a check is unavailable, output is delivered as provisional and flagged.
- M0 makes no outbound calls; M4, M9 and M10 read M0 by cursor.
- Route rankings live in M7; spend caps in M6.
- Migration numbers are taken at merge time.
- New in this pass: no stored face embeddings or biometric templates anywhere (Q18); per-brand likeness flag (Q15);
  buy or build for M8 and M9 from the website teardown plus our prototype, no demos (Q4); India out of scope (Q17).

## 15. Out of scope for now: India

Sujan has put India out of scope (Q17). None of the following is in any release. The module docs keep their India text so
it can be picked up again; until then it is not built, labelled or tested.
- The Cortina curtains pilot (old Stage 3) and its IDQ before-and-after measure.
- Channels Amazon.in, Flipkart and Myntra: their M5 rules and categories, M9 templates and error reports, and the
  Amazon.in SP-API token.
- `M8-S6` India English text and `M8-F6` Hindi and regional text.
- M2 home seed for curtains and the single-front-image curtain shot set in M3.
- A+ for Amazon.in through SP-API (`M11-F4` is GCC download pack only in R6).
- The 20 India rows of the M7 golden set (not labelled for now).
- India data residency for self-serve (`M12` R4).
