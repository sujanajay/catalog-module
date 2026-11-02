# Catalog OS build roadmap

Date: 2026-11-02. Status: draft for Sujan. Planning only: nothing here has been built or deployed.

Inputs: `module-map.md`, `brief-v1.md`, `intents.json`, `requirements/00-template.md` (settled decisions),
`requirements/M0` to `M12`, `requirements/UX-design-system.md`, plan `../plans/2026-11-02-catalog-os.md`.
Owner questions that block dates are in `owner-questions.md`.

## 1. How to read this

- A **slice** is one piece of work for one worker in one worktree, ending in one PR. Slice ids are the ones in each
  module's "Build slices" table (for example `M0-S2`).
- **Depends on** lists only true dependencies: the slice cannot pass its acceptance test without the other slice merged.
  "Nice to have first" is not listed.
- **Lane** groups slices that can run at the same time. Two slices in the same lane never touch the same hot file,
  except where a row says "rebase after".
- A stage ends only when its **exit criteria** are measured on real data, not when the slices are merged.
- Stages map to the plan: Stage 1 is plan Phase 3 (first slice), Stages 2 to 5 are plan Phase 4.

| Stage | Name | Dates | Exit outcome in one line |
|---|---|---|---|
| 1 | GCC fashion first slice and holdout launch | 3 to 20 Nov 2026 | An operator drops a folder and gets links for every product with no clicks; the holdout is frozen and the treatment is live |
| 2 | The 12-week GCC window | 21 Nov 2026 to 16 Feb 2027 | Week-8 and week-12 readouts published with intervals; text and listing files live for GCC; zero contamination |
| 3 | India Cortina pilot | about 5 Jan to 28 Feb 2027 (overlaps Stage 2) | Cortina curtains go from drop to Amazon.in and Myntra ready files with IDQ measured before and after |
| 4 | Catalog-wide text, A+ and video | March to May 2027 | Every live option has channel text; infographics and A+ on accepted channels; each measured through M4 |
| 5 | Self-serve | from June 2027 | A second organisation runs a batch end to end with no engineer |

## 2. Rules that apply to every stage

### 2.1 One writer per module, one worker per slice
- At any time a module has at most one slice in progress. The next slice of that module starts from the merged result.
- Named exceptions (they touch only new files or a separate service, so they cannot clash with the module's main writer):
  - `M2-S3` (people detector in `services/matting`), in parallel with the other M2 slices;
  - `M0-S4` (BigQuery export job and `infra/` script), in parallel with `M0-S2`/`M0-S7`;
  - `M6-S4` (deploy safety in `infra/` and `.github/workflows/ci.yml`), in parallel with `M6-S1`.

### 2.2 Migrations
- One migration per slice at most. The number is taken at merge time: rebase on main, take the next free number in
  `packages/core/drizzle`, regenerate `meta/_journal.json` and the snapshot, re-run CI. `M0-S1` is `0009`; any other
  number written in a requirements doc is indicative only.
- Two open PRs with migrations are allowed; the second to merge renumbers. The migration lint from `M6-S4` checks that
  every migration is additive (no drop, no rename, no type change) so that a batch survives the deploy.

### 2.3 Hot files (shared by several modules)
A slice that edits one of these says so in its PR title, and only one open PR at a time may edit each one. The others
rebase after it merges.

| Hot file | Slices that edit it |
|---|---|
| `packages/core/src/db/schema.ts`, `packages/core/drizzle/meta/*` | every slice with a migration (M0-S1, M1-S3, M1-S5, M2-S1, M4-S1/S3, M5-S1, M6-S1, M6-S6, M7-S1/S2/S4, M9-S1, M10-S1a, M12-S1) |
| `packages/core/src/catalog/types.ts` (ChannelId, OUTPUT_FLAGS) | M5-S1, M3-S1, M3-S4 |
| `packages/core/src/catalog/channels.ts`, `compliance.ts` | M5-S3, M3-S1 |
| `packages/core/src/catalog/render.ts` | M3-S1, M3-S2, M0-S7 (guard in the render key) |
| `packages/core/src/pipeline/publish.ts`, `report.ts` | M0-S3, M1-S3, M1-S5, M3-S3 |
| `apps/worker/src/catalog/finalize.ts` | M0-S3, M1-S3, M1-S5, M9-S4 |
| `apps/web/components/catalog/CatalogWizard.tsx` | M1-S1, M1-S2, UX3 |
| `apps/web/app/catalog/ops/page.tsx` | M6-S2, M6-S6, M9-S2, M12-S7 |
| `packages/core/src/qa/judge.ts`, `qa/classify.ts`, `cost.ts` | M7-S2, M2-S4, M6-S1 |
| `infra/deploy.sh`, `infra/lib/*.sh` | M6-S4, M6-S5, M0-S4 (new script only) |
| `.github/workflows/ci.yml` | M6-S4, UX2 |

### 2.4 Models
- **Sonnet:** collection and reading work (scraper field checks, reading vendor docs, gathering channel templates,
  summarising logs, running read-only queries).
- **Opus:** all building, all reviews, all planning by default.
- **Fable:** only when Sujan asks for it. The three places where it would be worth asking: the M0 contract freeze
  review before `M0-S1` merges, the M4 pre-registration review before the freeze (about 12 Nov), and the M10 pooled
  model design (`M10-S5`, January).

### 2.5 Review and ship (every PR)
1. The worker builds, runs the slice's acceptance test and the repo tests, and commits on its feature branch.
2. A fresh reviewer with clean context (`ce-code-review`, which has not seen the worker's reasoning) reviews the diff
   against the slice's requirement text. Findings are fixed in the same branch.
3. Ship with `ce-commit-push-pr` (the repo has no no-mistakes gate). CI must be green.
4. Sujan merges. Nobody else merges until Sujan says Phase 2 of the merge rules has started.
5. A production deploy needs Sujan's typed approval naming the commit; the manager runs `bash infra/deploy.sh` itself.

## 3. Human gates

| Gate | When | Who | What is approved |
|---|---|---|---|
| G1 Production deploy | every deploy | Sujan, by typed approval naming the sha | That commit goes live |
| G2 Holdout pre-registration and freeze | about 12-13 Nov | Sujan, plus the measurement owner | The one-pager from `M4-S4`: pool, pairs, MDE, primary metric, readout dates. After the freeze the arms cannot change |
| G3 Treatment go/no-go | 16 Nov | Sujan | The treatment batch passed the release gate; the channel team uploads 17-19 Nov. If uploads cannot start by 20 Nov, Sujan decides here whether to defer the clock to 1 Dec |
| G4 Paid vendor contract | before any paid call beyond trials | Sujan | Generation vendors (M3-S6 onward), text vendor (Streamoid or Rubick), overflow matting, scraping proxy over the pre-approved limit, any vendor with a no-training clause to check |
| G5 Marketplace-facing change | before the first file of a new kind reaches a channel | Sujan, with the channel manager | First treatment upload, first generated image per channel, first AI text per channel, first infographic per channel, first listing file per channel, first Amazon.in A+ |
| G6 Rule conflicts | before the module that needs them | Sujan | C01, C03, C04 before M8-S1; image-side highs before M5-S3 |
| G7 Promotion | each "Scale" card from M10 | Sujan | A winning change becomes the default, with a 10% permanent holdout |

## 4. Fixed dates

| Date | Milestone | Source |
|---|---|---|
| Wed 4 Nov | Labellers named; golden set wave 1 starts | M7-S1 |
| Thu 5 Nov | Legal OK to scrape our own listings; scraper fields start | M9-S1 |
| Fri 6 Nov | Streamoid and Rubick demos booked; 30-product demo pack sent | M8-S0 |
| Fri 13 Nov | Holdout frozen (G2). Must be on or before this date | M4-S4 |
| Mon 16 Nov | Streamoid and Rubick demos done; buy or build memo. Treatment go/no-go (G3) | M8-S0, M4 |
| Tue 17 Nov | Treatment clock starts (window 10-17 Nov from the brief, latest end). Channel team uploads 17-19 Nov | M4 |
| Fri 27 Nov | Black Friday; White Friday sales run in the last week of Nov. Treatment must be live before | brief |
| Tue 12 Jan 2027 | Week-8 data ends | M4 |
| Tue 19 Jan 2027 | Week-8 readout run and published | M4-S7 |
| Tue 9 Feb 2027 | Week-12 data ends (Ramadan starts about 8 Feb) | M4 |
| Tue 16 Feb 2027 | Week-12 readout run and published | M4-S7 |

## 5. Stage 1: GCC fashion first slice and holdout launch (3 to 20 Nov)

Goal: the module map's S1 to S9. Channels in order: Namshi and Noon, Trendyol, Styli and Centrepoint, Amazon AE.

### 5.1 Dependency graph (true dependencies only)

```
M12-S1 settings ----------------------------------------------.
M10-S1a change types ----------.                               |
M0-S1 graph tables -----+-> M0-S2 keys+style key -> M0-S7 guard+assign -> M0-S3 write path -> M0-S6 verifier
                        |        |                     |              \-> M0-S5 backfill (Stage 2)
                        |        |                     |
M9-S1 own scrape -------)--------+-> M4-S2 pool -> M4-S3 pairs+freeze -> M4-S4 MDE+G2 -> [freeze 13 Nov] -> M4-S5 guardrails
M4-S1 outcome panel ----)-------------^                                                        ^
                        |                                                       M9-S2 states --'
M2-S1 taxonomy ---------+-> M5-S1 rules tables -> M5-S2 evaluate -> M5-S3 pipelines read snapshot
            |           |                                \-> M5-S4 conflicts -> M5-S5 editor
            +-> M7-S1 golden wave 1 --.
M7-S2 vendor interface -+-> M2-S4 one vision call -> M2-S5 ladders -> M2-S6 gap report -> M3-S3 slot planner
            |           +-> M3-S5 matte+upscale behind M7                      ^               -> M3-S4 switches
            +-> M7-S3 scoring -> M2-S7 release states                         |
M2-S2 measurements -----------------------------------------------------------'
M2-S3 people detector -> M3-S2 crop engine -> M3-S3
M5-S1 + M0-S1 -> M3-S1 render reads rules
M0-S1 + M3-S3 -> M7-S4 audit sampler
M1-S1 -> M1-S2 wizard ;  M1-S3 auto-decide -> M1-S4 improvement task ; M1-S3 -> M1-S5 digest ; M1-S2 -> M1-S6
M6-S1 ledger -> M6-S2 reconciliation ;  M6-S4 deploy safety -> M6-S5 ;  M6-S6 outcomes
everything above -> S9 operator proof run -> treatment batch -> G3 -> channel upload
```

### 5.2 Slices in order, by lane

Each lane is one worker at a time (one writer per module). Day numbers are working days from Tue 3 Nov.

| Lane | Order of slices | Hot files | Days |
|---|---|---|---|
| A Graph (M0) | M0-S1, then M0-S2, then M0-S7, then M0-S3, then M0-S6. `M0-S4` runs beside it as a named exception | schema.ts, drizzle meta, render.ts (S7), publish.ts and finalize.ts (S3) | 1 to 9 |
| B Settings and change types | M12-S1 and M10-S1a (two small PRs; both must merge before M0-S3 starts writing events) | schema.ts | 1 to 3 |
| C Analyze (M2) | M2-S1 first (day 1-2, it unblocks M5, M7-S1 and M3), then M2-S2, M2-S4, M2-S5, M2-S6, M2-S7. `M2-S3` runs beside it in `services/matting` | schema.ts (S1), qa/classify.ts (S4) | 1 to 9 |
| D Rules (M5) | M5-S1 (after M2-S1), M5-S2, M5-S3, M5-S4, M5-S5 | types.ts, channels.ts, compliance.ts | 2 to 9 |
| E Quality (M7) | M7-S2 (day 1, no deps), M7-S1 (after M2-S1; labelling by the catalog team runs in parallel), M7-S3, M7-S4 | qa/judge.ts, cost.ts, schema.ts | 1 to 9 |
| F Images (M3) | M3-S5 (after M7-S2), M3-S1 (after M5-S1), M3-S2 (after M2-S3), M3-S3 (after M2-S6), M3-S4 | render.ts, types.ts, publish.ts | 3 to 10 |
| G Intake (M1) | M1-S1, M1-S3, M1-S2, M1-S5, M1-S4, M1-S6 | CatalogWizard.tsx, finalize.ts, report.ts | 1 to 9 |
| H Reliability and cost (M6) | M6-S4 first (deploy safety protects every later deploy), then M6-S1 (in parallel as an exception), M6-S6, M6-S2, M6-S5 | infra/*, ci.yml, cost.ts, ops/page.tsx | 1 to 8 |
| I Measurement (M4) | M4-S1 (day 1), M4-S2 (after M0-S2 and M9-S1), M4-S3 (after M0-S7), M4-S4, then G2, then M4-S5 | schema.ts | 1 to 10 |
| J Publish and monitor (M9) | M9-S1 (after the legal OK on 5 Nov), M9-S2 (after M0-S6) | ops/page.tsx (S2) | 3 to 10 |
| K UX | UX2 (copy lint), UX1 (tokens), UX3 (with M1-S2), UX4 (with M1-S5) | ci.yml, CatalogWizard.tsx | 2 to 9 |
| L Text pre-work (M8) | M8-S0 throwaway prototype and demo pack (not merged into the product) | none | 3 to 10 |

Lanes running at the same time in week 1: A, B, C, D, E, G, H, I (8 workers), plus the `M0-S4`, `M2-S3` and
`M6-S1` exceptions. That is more than the five to six the module map assumed; if the manager can only run six, lanes K
and L wait, and lane G starts on day 2.

Ordering conflicts on hot files, decided:
- `schema.ts`: M0-S1 merges first (day 2). M2-S1, M10-S1a, M12-S1 and M6-S1 rebase after it and merge in that order.
- `finalize.ts` and `publish.ts`: M1-S3 merges before M0-S3; M0-S3 rebases. M1-S5 after M0-S3.
- `render.ts`: M3-S1, then M0-S7 adds the guard to the render key, then M3-S2.
- `CatalogWizard.tsx`: M1-S1, then M1-S2 with UX3 as one PR pair (UX3 rebases).

### 5.3 Acceptance test per slice
The test for each slice is the one named in its module's "Build slices" table. The tests that decide the stage:

| Slice | Acceptance test (from the module doc) |
|---|---|
| M0-S1 | Migration applies and rolls forward on a copy of production; every API function has a unit test on real Postgres |
| M0-S2 | F1 tests 1 and 4 on real BigQuery data (read-only): keys for every option, style key on every apparel option |
| M0-S7 | A publish to a control option is refused; a treated listing accepts only its own experiment's versions |
| M0-S3 | Every link in a finished preview batch has a version row with role, source, hash, channel, publish time |
| M0-S6 | F3 tests 1 and 3: a Trendyol render is matched live within a day; an outside edit becomes `observed_other` |
| M2-S6 | Gap report counts match a hand count on the golden sample |
| M3-S3 | Random plans never remove an image before its replacement is ready |
| M4-S3 | Arms reproduce from a seed; standardised difference under 0.1 on every covariate |
| M4-S4 | MDE stored in the registry; one-pager printed; Sujan approves (G2) |
| M5-S3 | Real test batch: Noon, Namshi and Trendyol backgrounds at 240+, Amazon image 1 white, C10 applied |
| M6-S4 | A batch started during a deploy on preview finishes cleanly |
| M7-S3 | Per-attribute accuracy report with intervals on golden wave 1 |
| M7-S2 | Killing the primary judge still completes a batch |
| M9-S1 | Gallery count per option for Noon and Namshi UAE and KSA, for at least 90% of the pool |
| M1-S3 | A real batch finishes with links for 100% of products, with provisional ones flagged |

### 5.4 Stage 1 exit criteria (measured)
Measured on the S9 operator proof run (a Vero Moda or French Connection apparel batch) and the holdout launch:
1. Links for 100% of products; zero required clicks after the upload; one digest.
2. A batch started during a deploy finishes; batch success recorded.
3. Cost per product within 10% of monitoring-derived spend.
4. Treated Namshi and Noon options reach five-shot compliance above 80%.
5. Experiment frozen with its MDE in the registry on or before 13 Nov; zero control options published to.
6. At least 90% of treated listings verified live within 14 days of the upload (scrape plus Trendyol feed).
7. Before and after numbers recorded: touches per 1,000 SKUs, time to first links, cost per product.

## 6. Stage 2: the 12-week GCC window (21 Nov to 16 Feb)

Nothing in this stage may edit a treated or control listing outside the experiment (`M0-F3-R7`). Every slice that
publishes runs through the guard.

| Order | Slices | Depends on | Notes |
|---|---|---|---|
| 1 | M0-S5 backfill; M6-S3 billing reconciliation (when the export is on); M6-S7 idle control and quotas | Stage 1 | Lane A and H |
| 2 | M4-S6 estimators (needed by week 6, about 29 Dec); M4-S9 secondary signals | M4-S1 | Lane I |
| 3 | M8-S1 English text, then M8-S2 Arabic, M8-S5 text sheet, M8-S3 search terms, M8-S4 size charts | demo decision (16 Nov), C01/C03/C04 decided (G6), M5-S2, M7-S2 | Lane L. Only on options outside the experiment, or as a new registered experiment |
| 4 | M9-S3 templates, M9-S4 fill, M9-S5 rejections, M9-S6 rejection learning | demo decision; M8-S1 for text | Lane J |
| 5 | M3-S6 generation adapters, M3-S7 mode A, M3-S8 AI tag | G4 paid vendor; likeness rights for worn shots; channel AI stance | Lane F |
| 6 | M7-S5 staged gate, M7-S6 fidelity, M7-S7 planted defects, M7-S8 bake-off fields, M7-S9 bilingual | M7-S3, M7-S4 | Lane E; M7-S6 must merge before M3-S7 publishes anything |
| 7 | M10-S1b classifier, M10-S3 leading indicators, M10-S2 priority plan | M0-S3, M0-S5, M4 panel | Lane B |
| 8 | M12-S2 settings UI, M12-S3 preview, M12-S5 Brand DNA, M12-S7 ops additions; UX5, UX6, UX7, UX8 | M12-S1 | Lane K |
| 9 | M4-S7 readout job and page; week-8 readout 19 Jan; week-12 readout 16 Feb; M10-S5 pooled model after week 8 | M4-S6 | Lane I and B |
| 10 | M5-S6 gaps, claims, brand and Arabic rules; M6-S5 shorter deploys | M5-S5 | Lane D |

Hot-file note: M8-S1 and M9-S4 both touch `finalize.ts`; M8-S1 first.

Stage 2 exit criteria (measured):
1. Week-8 and week-12 readouts published on time, with intervals, using the pre-registered estimator. The expected
   result is a bounded null (the brief's expectation); a null with tight bounds still passes this criterion.
2. Contamination: zero control listings changed by us; any outside change detected within 7 days.
3. English text live on Noon, Namshi, Trendyol and Amazon.ae for options outside the experiment, passing M5 checks
   and the M7 audit at 3% sampling with under 10% failures.
4. Listing files for Noon and Namshi filled with zero manual columns for a batch.
5. Cost reconciled against billing within 10%.

## 7. Stage 3: India Cortina pilot (about 5 Jan to 28 Feb 2027)

Starts when Sujan confirms India access (owner question, about 5 Jan). It runs beside Stage 2 because it touches
different channels and categories.

| Order | Slices | Depends on |
|---|---|---|
| 1 | M2 home seed for curtains (data rows in M2-S1 tables, no new code); M5 India rules (Amazon.in, Myntra, Flipkart) and the curtain category through the M5-S5 editor | Stage 1 M2 and M5 |
| 2 | M3 render for a single front image plus the curtain shot set (rule rows) | M5 India rules |
| 3 | M8-S6 India English text | M8-S1, M5 India rules |
| 4 | M9 templates for Amazon.in and Myntra (M9-S3 flow, no code); A+ through SP-API needs M11-S9, so A+ for Cortina is the first M11-S9 user in Stage 4 unless Sujan pulls it in | SP-API token |
| 5 | M4: IDQ before and after as the outcome; Cortina volume is too small for a randomised test, so it is a before-and-after measure, labelled as such | M4-S1 |

Stage 3 exit criteria (measured): a 50-product Cortina run goes from drop to Amazon.in and Myntra ready files with zero
manual columns; titles and bullets pass Amazon.in and Myntra rules; IDQ score measured before and after.

## 8. Stage 4: catalog-wide text, A+ and video (March to May 2027)

| Order | Slices | Depends on |
|---|---|---|
| 1 | M8 text for all live options, in waves by brand (a run of M8-S1/S2, no new slice) | Stage 2 text exit |
| 2 | M11-S1 slot layer, M11-S2 English infographics, M11-S6 registration | M5 rules, M12-S5 Brand DNA, M4 registry |
| 3 | M11-S5 channel acceptance pilot (G5 per channel) | M11-S2, channel managers |
| 4 | M11-S3 Arabic infographics, M11-S4 highlight picker | M8-S2, M7-S9 |
| 5 | M11-S9 video and A+ (Amazon.in A+ for Cortina first) | M5 video and A+ specs |
| 6 | M11-S7 still lifes, M11-S8 worn footwear and bags | M7-S6 fidelity, M12-S6 rights, G4 |
| 7 | M10-S4 traits model, M10-S6 decision rules and promotion, M10-S7 cross-pollination | M10-S5, M8-S3 |
| 8 | M11-S10 faces and kids, only after the PDPL legal route and likeness rights | owner question |

Stage 4 exit criteria (measured): 95% of live options have channel text passing M5; infographics live on every channel
whose overlay rule is "documented"; each new content type registered in M4 before its first treated publish; at least
one promotion made through G7 with its 10% holdout.

## 9. Stage 5: self-serve (from June 2027)

Slices: M12-S4 owner approvals, M12-S9 roles and brand scope, M12-S6 rights, M12-S8 template mapping, then M12-F5 to F7
(organisation sign-up, billing, data separation), UX9 notifications and UX10 accessibility and mobile.
Needs: pricing unit and data residency decided (owner questions); `org_id` already exists on new tables (M0, M12 D6).

Exit criteria (measured): a test organisation signs up, adds a brand, drops a folder and receives links and a digest
with no engineer involved; its data is invisible to Opptra users (tested); its cost is billed per the chosen unit.

## 10. Risk register

| # | Risk | Likelihood | Effect | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Holdout misses the 13 Nov freeze (keys, style key, scrape or pairs late) | Medium | Treatment slips past White Friday; window overlaps Ramadan more | Critical path in lane A and I starts day 1; fallback pool uses Trendyol counts; G3 can defer to 1 Dec | Manager |
| R2 | Legal does not clear scraping our own listings by 5 Nov | Medium | No Namshi/Noon gallery counts or live verification | Trendyol counts and M0 records as fallback for the pool; manual spot checks of 50 listings for verification | Sujan |
| R3 | Channel team cannot upload 17-19 Nov | Medium | Clock start slips | Upload pack ready 16 Nov; deferral decision at G3 | Sujan |
| R4 | Golden labels late (no labellers by 4 Nov) | Medium | M7 release gate cannot pass; analyzer fields stay `shadow`; treatment batch delayed | Start with 100 labels; M2-S7 lets fields go live one by one | Sujan |
| R5 | Eight parallel lanes collide on `schema.ts` and `finalize.ts` | High | Rebase churn, broken migrations | Merge-time numbering; merge order fixed in 5.2; one open PR per hot file | Manager |
| R6 | A deploy during the treatment window breaks a batch or changes a treated listing | Low | Biased estimate or outage | M6-S4 first; the guard refuses writes to frozen listings; deploys need G1 | Manager |
| R7 | Ads or merchandising teams edit controls | Medium | Contamination | Blind-arms letter; M0 detects, M9 alerts, M4 accounts within 7 days | Sujan |
| R8 | Readout is a null | High (expected) | Disappointment | The brief sets a bounded null as the expectation; value also counted in touches, time and cost | Sujan |
| R9 | Streamoid or Rubick are better at text or publish | Medium | Building M8/M9 wastes time | Demo by 16 Nov before M8-S1 starts; buy or partner if better | Sujan |
| R10 | Shared `ila-pg` has no connection budget | Medium | Outage during batch or deploy | Budget in `deploy.sh` (M6-S4); separate load-test capacity | Manager |
| R11 | GPU quota caps throughput at scale | Low | Slow catalog-wide waves | Quota requests filed; bursts | Manager |
| R12 | Noon or Namshi refuse generated images or overlays | Medium | Rejections | Crops first; channel-manager confirmation before G5; rules stay "assumed" until confirmed | Sujan |
| R13 | India access late (SP-API token, templates) | Medium | Stage 3 slips | Stage 3 is independent of Stage 2; starts when access lands | Sujan |
| R14 | Overfitting to our own benchmark | Medium | Offline wins that do not convert | M4 live readouts are the final gate for promotion | Manager |
| R15 | Too many workers for the manager's context | Medium | Slower coordination | Cap at six lanes if needed (5.2); reports to `.runs` | Manager |

## 11. Integration decisions recorded in this pass

The consistency review (2026-11-02) fixed about 25 inconsistencies directly in the module docs. Each module doc has a
section 9 (UX: section 17) "Integration decisions" listing what changed and why. The ones that shape this roadmap:
- Style key, change reason, change types and the settings store were P1 but needed by P0 work; they moved into Stage 1
  (`M0-F1-R8`, `M0-F3-R9`, `M10-S1a`, `M12-S1`).
- One matcher and one pHash setting (6, uncertain 7-12) in M0; M9 owns gallery states only.
- One taxonomy (M2); M5 references it. One audit rule (M7: 3% sampling; a cell fails at 10% over 200 audits; after a failure, 10% sampling until 100 clean; floor 2%).
- No module "holds" output: when a check is unavailable, output is delivered as provisional and flagged.
- M0 makes no outbound calls; M4, M9 and M10 read M0 by cursor.
- Route rankings live in M7; spend caps in M6.
- Migration numbers are taken at merge time.
