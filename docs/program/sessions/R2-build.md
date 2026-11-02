# R2 build session: Complete and measured

Self-contained execution brief for a fresh Claude Code session. You are the manager: you coordinate, subagents do the
work. Planning documents are the source of truth; this brief tells you the order and the rules.

## 1. Goal

Ship release R2 (`docs/program/roadmap.md` section 6): every Namshi and Noon apparel option gets its channel's full shot
set from the brand's own photos, checked by a measured quality gate and a sampled audit, verified live by our own scrape,
inside a frozen, pre-registered holdout whose readout runs itself. The release is done only when its exit outcome is
measured (section 8).

No timelines: do not write dates, weeks or durations into any plan or doc. Order by dependency only. The holdout's
readout points are defined inside `requirements/M4-measurement.md` ("after N weeks of data"); that is statistics, not a
schedule. Calendar dates still written in M4 are superseded by the pre-registration one-pager that `M4-S4` produces.

## 2. Read first (in this order)

1. `docs/program/roadmap.md` sections 1 to 4 and 6.
2. `docs/program/requirements/00-template.md` (settled decisions).
3. Per slice, its module doc's feature section and "Build slices" table: `M0-catalog-graph.md` (F3, F4),
   `M2-analyze.md` (F1, F2), `M3-images.md` (F1, F4), `M4-measurement.md` (F1 to F5, F8, Appendix A),
   `M5-channel-rules.md` (F2, F3), `M7-quality-benchmark.md` (F1, F3), `M9-publish-monitor.md` (F1),
   `M1-intake.md` (F6), `M6-reliability-cost.md` (F3 to F7), `M12-admin-self-serve.md` (F2), `UX-design-system.md` (UX8).
4. `docs/program/owner-questions.md`.
5. The R1 exit report (`C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\*-r1-exit.md`) for the baseline numbers.
6. Repo rules: `AGENTS.md`, `docs/SPEC.md`, `docs/solutions/`.

## 3. Requirements status

Build-ready. The P0 features are written in full. Medium-depth (P1) slices in R2: `M4-S6`, `M4-S7` (with M4 Appendix A),
`M1-S7` (new, from `M1-F6`), `M6-S7b` (new, from `M6-F4` to `M6-F7`), `M12-S7`, `UX8`. Each has an acceptance test; the
worker builds to it and stops to report if a requirement is missing. You decide technical gaps and record them in the
module doc's "Integration decisions" in the same PR; business, money, legal and marketplace questions go to Sujan.

New slice ids defined here:
- `M1-S7` Already-live re-run: a "Re-run products" entry that takes pasted identifiers or an M0 filter, uses current
  source versions from M0, creates a normal batch (auto-start, digest) and skips frozen controls. Depends on `M0-S3`
  (R1) and `M0-S7`. Test: paste 50 live identifiers; a batch runs on their current photos and the digest shows what
  changed; a control identifier in the list is skipped with one digest line.
- `M6-S7b` Reliability at volume: `M6-F5` retry and checkpoint (fault-proxy test), `M6-F4` idle control (two batches,
  one warm window), `M6-F7` separate load-test capacity (a temporary Cloud SQL instance in project `image-links-agent`,
  created and deleted by an idempotent `infra/` script, under USD 50 per test; Sujan approved this in Q16, and the delete
  covers only that named instance), and `M6-F6` capacity: GPU quota is granted (6 RTX PRO 6000 in asia-south2, 3 L4 in
  asia-southeast1); use current capacity (about 5 RTX instances fit today's asia-south2 memory quota); prepare the text
  of the remaining memory and vCPU quota asks for Sujan to file; raise service maxima only through a gated deploy.

## 4. Setup

- Start from latest `main` with R1 merged. Create `docs/plans/<yyyy-mm-dd>-r2-complete-and-measured.md` with one
  checklist line per slice, each gate, the treatment batch and the exit report. Update it at milestones only.
- One worktree per slice: `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\<nn>-<slug>`; one feature branch per slice.

## 5. Build slices in order

One writer per module. The holdout critical path is marked with a star; start those first.

| Lane | Module (one writer) | Slices in order | A slice starts when | Hot files |
|---|---|---|---|---|
| I | M4 | *M4-S1, *M4-S2, *M4-S3, *M4-S4, then gate G2, then M4-S5, M4-S6, M4-S7 (with UX8) | S1: now. S2: S1 and M9-S1 merged (fallback: Trendyol counts and M0 records). S3: S2 and M0-S7 merged. S4: S3 merged. S5: S3 and M9-S2 merged. S6: S1 merged. S7: S6 merged | schema.ts (S1, S3) |
| J | M9 | *M9-S1, then M9-S2 | S1: now (legal OK, Q2). S2: S1 and M0-S6 merged | schema.ts (S1); ops/page.tsx (S2) |
| A | M0 | *M0-S7, then M0-S6, then M0-S5 | S7: now. S6: now after S7 (needs R1's S1, S3, S4). S5: after S6 | render.ts (S7, guard in the render key) |
| C | M2 | M2-S2, M2-S4, M2-S5, M2-S6, M2-S7. `M2-S3` runs beside it (named exception, `services/matting`) | S2, S3: now. S4: S2 merged (needs R1's M7-S2). S5: S2, S3, S4 merged. S6: S5 merged. S7: S6, M7-S1 and M7-S3 merged | qa/classify.ts (S4) |
| E | M7 | M7-S1 (labelling by the catalog team runs alongside), M7-S3, M7-S4 | S1: now. S3: S1 merged. S4: S1 and M3-S3 merged | schema.ts (S1, S4) |
| F | M3 | M3-S2, M3-S3, M3-S4 | S2: M2-S3 and M0-S7 merged. S3: S2 and M2-S6 merged. S4: S3 merged | render.ts (S2); publish.ts, report.ts (S3); types.ts (S4) |
| D | M5 | M5-S4, then M5-S5 | now | none beyond its own screens |
| G | M1 | M1-S7 (new) | M0-S7 merged | none listed |
| H | M6 | M6-S7b (new), and M6-S3 when the billing export is on | now | infra (S7b, new scripts); cost.ts |
| L | M12 | M12-S7 | M7-S4 merged (R1's M6-S2 already in) | ops/page.tsx |

**Can start now, in parallel:** M4-S1, M9-S1, M0-S7, M2-S2 with M2-S3, M7-S1, M5-S4, M6-S7b. If you run only six
workers, start M4-S1, M9-S1, M0-S7, M2-S2, M2-S3, M7-S1, then the rest.

**Merge order on hot files (the later PR rebases):**
- `render.ts`: M0-S7, then M3-S2.
- `ops/page.tsx`: M9-S2, then M12-S7.
- `schema.ts`: at most two open migration PRs; numbers taken at merge time.
- `publish.ts`, `report.ts`: only M3-S3 in R2.

## 6. The treatment launch (in order, after the slices it needs)

1. `M4-S4` prints the pre-registration one-pager (pool, pairs, MDE, primary metric, readout points). Offer Sujan a Fable
   review of it (only if he asks; on a usage limit use `kit:opus-planner`).
2. **G2:** Sujan approves and the experiment freezes. From here nothing edits a treated or control listing outside the
   experiment (`M0-F3-R7`); every publishing slice runs through the guard.
3. Sujan sends the blind-arms letter to the ads and merchandising agencies (Q10).
4. Run the treatment batch through `M1-S7` on the treatment arm only. It must pass the release gate: M2 fields used are
   `live` (M2-S7), M7 audit sampling running (M7-S4), M5 checks passing.
5. **G3:** Sujan approves go. **G5:** first treatment upload on Namshi and on Noon, approved with the channel manager.
6. The channel team bulk-uploads and clicks "I uploaded this file". Live watch (`M9-S1`, `M9-S2`, `M0-S6`) verifies.
7. Guardrails (`M4-S5`) run from here. The readout job (`M4-S7`) refuses to run before its pre-registered point and runs
   itself after it.

## 7. How every slice runs

| Step | Who | Model |
|---|---|---|
| Collection: scraper field checks on Noon and Namshi pages (UAE, KSA), hand counts for the gap report check, golden-set photo gathering lists, read-only warehouse queries, Context7 lookups | `kit:researcher` or a general agent | Sonnet |
| Build the slice, run its acceptance test and the repo tests, commit | `kit:worker` | Opus |
| Clean-context review of the diff against the slice text | `ce-code-review` in a fresh subagent | Opus |
| Fix findings; ship with `/ce-commit-push-pr` (the repo has no no-mistakes gate) | the worker | Opus |
| Watch CI, deploys, the scrape job and the treatment upload verification | `kit:watcher` | its default |
| Critical design review | only if Sujan asks (the M4 pre-registration review) | Fable |

Rules: Sujan merges every PR; you never merge. Production deploys need Sujan's typed approval naming the sha (G1); you
run `bash infra/deploy.sh`. Never run load tests or evals on the shared stack while people use it: use `M6-S7b`'s
temporary capacity. Context7 before any external library. Additive migrations only. After two failed attempts, stop and
report.

Every subagent brief ends with:
"Write the full report to `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<yyyy-mm-dd>-<slug>.md` in the main checkout
and reply in at most 120 words (outcome, branch/PR, tests, blockers, report path)."

## 8. Acceptance tests and release exit

Slice tests (from the module tables) that decide the release:

| Slice | Acceptance test |
|---|---|
| M4-S1 | Totals match the outcome baseline within 1%; a broken source nulls and flags |
| M4-S2 | Pool report lists about 1,400 apparel options as styles with a confidence per style key |
| M4-S3 | Arms reproduce from a seed; standardised difference under 0.1 on every covariate; publish to a control refused |
| M4-S4 | MDE stored in the registry; one-pager printed; Sujan approves (G2) |
| M4-S5 | A hand-edited control appears as contaminated within 7 days |
| M4-S6 | Injected +20% recovered within 2 points; A/A false positive rate about 5% |
| M4-S7 | Readout refuses before its point; the page passes the two-minute reading test |
| M9-S1 | Gallery count per option for Noon and Namshi UAE and KSA for at least 90% of the pool |
| M9-S2 | M9-F1 tests 1 and 2 |
| M0-S7 | A publish to a control option is refused; a treated listing accepts only its own experiment's versions |
| M0-S6 | F3 tests 1 and 3: a Trendyol render matched live within a day; an outside edit becomes `observed_other` |
| M0-S5 | F4 acceptance test |
| M2-S2 to M2-S7 | As listed in M2 section 7; M2-S6: gap report counts match a hand count on the golden sample |
| M3-S2 | Crop unit suite; identical bytes on rerun |
| M3-S3 | Random plans never remove an image before its replacement is ready |
| M3-S4 | 4.1.9 test 1 on a real batch |
| M7-S1 | 100 products labelled with 20% overlap; split test passes |
| M7-S3 | Per-attribute accuracy report with intervals on golden wave 1 |
| M7-S4 | 4.3.9 tests 1 to 3 |
| M5-S4, M5-S5 | M5-F2 tests; M5-F3 tests run by a non-engineer admin |
| M1-S7, M6-S7b | As defined in section 3 |
| M12-S7, UX8 | M12 section 4 F2 test; UX T7 |

**Release exit:** measure every item of `roadmap.md` section 6 (items 1 to 9) and write
`C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<yyyy-mm-dd>-r2-exit.md` with numbers and evidence.

## 9. Human gates in R2

| Gate | When | Who |
|---|---|---|
| G1 Production deploy | every deploy | Sujan, typed approval naming the sha |
| G2 Pre-registration and freeze | after `M4-S4`, before the treatment batch | Sujan (measurement owner, Q8) |
| G3 Treatment go/no-go | after the treatment batch passes the release gate | Sujan |
| G5 Marketplace-facing change | first treatment upload on Namshi and on Noon | Sujan with the channel manager |
| Owner actions | Supabase read access (golden photos, backfill), billing export (`M6-S3`), memory and vCPU quota asks | Sujan; work proceeds on fallbacks |

## 10. Done check

- Every slice merged by Sujan and deployed through G1; the experiment frozen through G2 and the treatment live through
  G3 and G5.
- The R2 exit report shows all nine items measured.
- Plan checklist ticked; R2 marked shipped in the progress file.
- Handoff with `ce-handoff` at the release milestone and before any long wait for data
  (`~/ai-personal/handoffs/<repo>/r2.md`); give Sujan the resume line.
- Offer once to run `ce-compound` if the release produced durable reasoning.
