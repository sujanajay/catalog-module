# R5 requirements session: Learn what sells

Self-contained brief for a fresh Claude Code session. Planning only: change no product code.

## 1. Goal

Bring every R5 feature (`docs/program/roadmap.md` section 9) to build-ready depth and write the R5 build brief. R5's
value: effects pooled across brands tell us what to scale and what to stop, with bounds, and a winning search term
updates title, backend terms and (later) the infographic in one measured change.

No timelines anywhere: no dates, weeks, durations or "by X". Readout timing is written only inside M4 as "after N weeks
of data". Durations that describe product behaviour are allowed.

## 2. When to open this session

After the R4 requirements PR is merged (R5 depends on the keyword winner interface and the search-term job that R4
fixes). It can run while R1 or R2 is being built. If the first holdout readout already exists, read it; it is not
required.

## 3. Setup and read first

- Worktree from latest `main`: `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\<nn>-r5-requirements`, branch
  `docs/r5-requirements`.
- Read: `roadmap.md` (1 to 4, 6, 9, 13), `owner-questions.md`, `requirements/00-template.md`;
  `M10-learning.md` (all, including Appendix B), `M4-measurement.md` (F5 to F10, Appendix A), `M8-text-attributes.md`
  (section 3.2 keyword winner interface, F3, F5), `M9-publish-monitor.md` (F6), `M2-analyze.md` (F7), `M0-catalog-graph.md`
  (change log, change sets, cursor reads), `UX-design-system.md` (5.6 experiment readout, UX8).
- P0 depth example: `M4-measurement.md` M4-F2 and M4-F3.
- Evidence: `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\2026-11-02-competitors-measurement.md`,
  `2026-11-02-outcome-baseline.md`, `2026-11-02-data-census.md`; any readout report in `.runs`.

## 4. What to produce

1. **Upgrade to P0 depth** (template section 4) for: M10-F1 (classifier `M10-S1b`), M10-F2, M10-F3, M10-F4, M10-F5,
   the leading indicators and traits model (`M10-S3`, `M10-S4`); M4-F5 (staggered DiD, synthetic control), M4-F6, M4-F7,
   M4-F8, M4-F9, M4-F10; M8-F5; M9-F6; M2-F7.
2. **Build slices** with ids, true dependencies, acceptance tests and migrations. Add slices for M4-F9 and M4-F10
   (`M4-S10`, `M4-S11`), M8-F5 (`M8-S7`), M9-F6 (`M9-S7`), M2-F7 (`M2-S11` or the next free id after R4).
3. **Operator experience and measurement**: the recommendations page, the priority plan, the "Scale" and "Stop" cards,
   copy for bounded nulls.
4. **Integration decisions** in each touched module's section 9.
5. **New owner questions** with defaults: at least the bought market data vendor and monthly budget (M4-F9, gate G4),
   and whether any brand has Amazon Brand Registry on Amazon.ae for MYE calibration (M4-F10).
6. **`docs/program/sessions/R5-build.md`** in the shape of `R1-build.md` (lanes, true dependencies, parallel slices, hot
   files and merge order, one writer per module, model per step, clean-context review, `/ce-commit-push-pr`, Sujan
   merges, report line, acceptance tests, release exit, gates G7 and G2, done check). Mark which slices need only R2 and
   can be built while R3 and R4 are built.
7. In `roadmap.md` section 9, set "Requirements status" to build-ready and list new slice ids; add the R5 build session's
   first message to `sessions/README.md`.

## 5. Decisions already settled (do not reopen)

- The pooled model is a two-stage meta-analytic model over M4's per-stratum estimates (M10 Appendix B.1), calibrated on
  placebo readouts.
- Promotions go through gate G7 and keep a 10% permanent holdout registered in M4. M4 live readouts are the final gate
  (risk K13).
- The keyword signal is paid search-term data (Amazon Ads, Noon ads); organic keyword winners cannot be found at GCC
  volumes. M8-S3 owns the search-term job; M10 reads it.
- Leading indicators and traits are hypotheses with source badges and ranges; they never appear as effects in the grid.
- M10 reads M0 by cursor; M0 makes no outbound calls. The `learning.keyword_winner` topic is a worker task queue.
- Change sets are M0's `change_set_id`; a cross-pollinated change is logged with its parent signal and measured as a
  change type.

## 6. Questions to resolve in this session

1. Classifier rules and the backfill check (95% classified; 48 of 50 agree with a hand check).
2. Priority score formula and the measurability gate; how cost classes from M6 enter.
3. Pooled model priors, shrinkage display, and the placebo calibration test design. Offer Sujan a Fable review here
   (only if he asks).
4. Decision rules for "Scale", "Stop" and "Keep testing", with bounds; how a promotion is rolled back.
5. Re-enrichment (M9-F6): which listings are re-processed when a rule changes or a winner is found, without touching
   frozen controls; the "Fixes" file path.
6. Country-split eligibility (shared-content channels refused) and staggered rollout waves.
7. Bought market data: candidate vendors (Actowiz, DataWeBot, Bright Data, 42Signals), coverage and terms (collection by
   Sonnet; check current pages).

## 7. How to work

- You are the manager. Collection (vendor pages, current code, Context7 for statistics libraries): Sonnet. Writing:
  Opus. Fable only if Sujan asks.
- Clean-context review: `ce-doc-review` in a fresh subagent; fix findings.
- Every subagent brief ends with: "Write the full report to
  `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<yyyy-mm-dd>-<slug>.md` in the main checkout and reply in at most 120
  words (outcome, branch/PR, tests, blockers, report path)."
- Ship the docs with `/ce-commit-push-pr`. Sujan merges.

## 8. Done check

- Every feature in section 4.1 has every P0 subsection; every slice has an id, dependencies and a test.
- `sessions/R5-build.md` exists and is executable by a fresh session.
- No dates, weeks or "by X" outside M4's "after N weeks of data" (grep before committing).
- `ce-doc-review` findings fixed; PR open; report written to `.runs`.
