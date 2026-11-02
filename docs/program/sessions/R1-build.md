# R1 build session: Upload and walk away

Self-contained execution brief for a fresh Claude Code session. You are the manager: you coordinate, subagents do the
work. Planning documents are the source of truth; this brief tells you the order and the rules.

## 1. Goal

Ship release R1 (`docs/program/roadmap.md` section 5): an operator drops any batch and walks away; every product gets
links and one digest, through deploys and vendor failures, with the true cost shown and every output recorded in the
catalog graph. The release is done only when its exit outcome is measured on a real batch (section 8), not when the PRs
are merged.

No timelines: do not write dates, weeks or durations into any plan or doc. Order by dependency only.

## 2. Read first (in this order)

1. `docs/program/roadmap.md` sections 1 to 5 (rules, hot files, gates, R1).
2. `docs/program/requirements/00-template.md` (settled decisions; do not reopen them).
3. For each slice you dispatch, its module doc: the feature section and the "Build slices" table:
   `requirements/M0-catalog-graph.md`, `M1-intake.md`, `M2-analyze.md` (M2-S1 only), `M3-images.md` (M3-F2, M3-F3),
   `M5-channel-rules.md` (F1, F4), `M6-reliability-cost.md` (F1, F2, F3, F8), `M7-quality-benchmark.md` (F2),
   `M10-learning.md` (M10-S1a), `M12-admin-self-serve.md` (M12-S1), `UX-design-system.md` (UX1 to UX4).
4. `docs/program/owner-questions.md` (what is answered; what is open).
5. Repo rules: `AGENTS.md`, `README.md`, `docs/SPEC.md`, `docs/solutions/`.

Do not read every module doc yourself. Give each worker its slice's doc sections; keep your context for coordination.

## 3. Requirements status

Build-ready. All R1 features are P0 written in full, except `M6-F8` tiered tests and `M12-S1` (P1, medium depth, with
acceptance tests and enough detail to build). If a worker finds a requirement missing or contradictory, it stops and
reports; you decide technical gaps and record them in the module doc's "Integration decisions" table in the same PR, or
ask Sujan if it is business, money, legal or a marketplace relationship.

## 4. Setup

- Start from latest `main`. If `docs/program/sessions/` is missing on `main`, stop: the planning branch
  `docs/catalog-os-reset` must be merged first (tell Sujan).
- Create the progress file `docs/plans/<yyyy-mm-dd>-r1-upload-and-walk-away.md` on its own branch: one checklist line
  per slice below plus the proof run and each gate. Update it at milestones only (PR opened, merged, deployed). This is
  the only place progress lives.
- One worktree per slice: `C:\Users\Sujan Ajay\Desktop\catalog-module-wt\<nn>-<slug>` (next free number), one feature
  branch per slice (`feat/m0-s1-graph-tables` style). Never commit to `main`.

## 5. Build slices in order

One writer per module: at most one slice per module in progress at any time. Lanes run in parallel.

| Lane | Module (one writer) | Slices in order | A slice starts when | Hot files touched |
|---|---|---|---|---|
| A | M0 | M0-S1, then M0-S2, then M0-S3. `M0-S4` runs beside S2 and S3 (named exception: new job and `infra/` script only) | S1: now. S2: S1 merged. S3: S1 and S2 merged, plus M10-S1a, M12-S1 and M1-S3 merged. S4: S1 merged | schema.ts and drizzle meta (S1); publish.ts, finalize.ts (S3); infra (S4, new file) |
| B1 | M12 | M12-S1 | M0-S1 merged (rebase on its migration) | schema.ts |
| B2 | M10 | M10-S1a | now (merge after M0-S1) | schema.ts |
| C | M2 | M2-S1 | now | schema.ts |
| D | M5 | M5-S1, then M5-S2, then M5-S3 | S1: M2-S1 merged. S2: S1 merged. S3: S2, M3-S1 and M6-S4 merged | types.ts (S1); channels.ts, compliance.ts (S3) |
| E | M7 | M7-S2 | now | qa/judge.ts, cost.ts, schema.ts |
| F | M3 | M3-S5, then M3-S1 | S5: M7-S2 merged. S1: M5-S1 and M0-S1 merged | render.ts, types.ts, channels.ts (S1) |
| G | M1 | M1-S1, then M1-S3, then M1-S2 (paired with UX3), then M1-S5 (paired with UX4), then M1-S4, then M1-S6 | S1, S3: now. S2: S1 merged (M0-S2 improves brand inference; falls back to the brand list until then). S5: S3 merged. S4: S3 merged. S6: S2 merged | CatalogWizard.tsx (S1, S2); finalize.ts, publish.ts, report.ts (S3, S5); schema.ts (S3, S5) |
| H | M6 | M6-S4 and M6-S1 together (named exception), then M6-S6, then M6-S2, then M6-S5, then M6-S7a (tiered tests, new id: `M6-F8` only) | S4, S1: now. S6: now (after S1 for the lane). S2: S1 merged. S5: S4 merged. S7a: S4 merged | infra/deploy.sh, ci.yml (S4, S5, S7a); cost.ts (S1); ops/page.tsx (S2, S6); schema.ts (S1, S6) |
| K | UX | UX2, then UX1, then UX3 (with M1-S2), then UX4 (with M1-S5) | UX2: now. UX1: UX2 merged. UX3, UX4: with their M1 pair | ci.yml (UX2), CatalogWizard.tsx (UX3) |

**Can start now, in parallel:** M0-S1, M10-S1a, M2-S1, M7-S2, M1-S1, M6-S4 with M6-S1, UX2. If you can run only six
workers at once, start in this order of value: M0-S1, M6-S4, M1-S1 (then M1-S3), M2-S1, M7-S2, M6-S1; the rest join as
workers free up.

**Merge order on hot files (decided; the later PR rebases):**
- `schema.ts` and drizzle meta: M0-S1 merges first (it is migration `0009`). Then the others in the order they are
  ready; at most two open PRs with migrations, the second renumbers at merge time (roadmap 3.2).
- `finalize.ts`, `publish.ts`, `report.ts`: M1-S3, then M0-S3, then M1-S5.
- `types.ts`: M5-S1, then M3-S1. `channels.ts`, `compliance.ts`: M3-S1, then M5-S3.
- `render.ts`: M3-S1 (R2 continues with M0-S7, then M3-S2).
- `CatalogWizard.tsx`: M1-S1, then M1-S2 with UX3 as one PR pair (UX3 rebases).
- `qa/judge.ts`, `cost.ts`: M7-S2, then M6-S1.
- `ops/page.tsx`: one open PR at a time among M6-S2 and M6-S6.
- `infra/deploy.sh`: M6-S4, then M6-S5. `ci.yml`: M6-S4, then UX2, then M6-S7a.

## 6. How every slice runs

| Step | Who | Model |
|---|---|---|
| Collection: read-only BigQuery checks (key coverage for M0-S2), Cloud Monitoring numbers (M6-S2 baseline), current CI T1 wall time (M6-F8 open question), the "before" numbers for the proof run, current library docs via Context7 | `kit:researcher` or a general agent | Sonnet |
| Build the slice: code, tests, the slice's acceptance test, repo tests, commit on the feature branch | `kit:worker` | Opus |
| Review: a fresh reviewer with clean context reviews the diff against the slice's requirement text | `ce-code-review` in a new subagent that has not seen the worker's reasoning | Opus |
| Fix review findings in the same branch, re-run tests | the same `kit:worker` | Opus |
| Ship: push, PR, CI. The repo has no no-mistakes gate, so use `/ce-commit-push-pr` | the worker, at the ship step | Opus |
| Watch CI and deploys; report only changes and failures | `kit:watcher` | its default |
| Critical design review | only if Sujan asks: the M0 contract freeze review before `M0-S1` merges is the one place worth offering | Fable (`kit:fable-planner`); on a usage limit, rerun with `kit:opus-planner` |

Rules for every PR:
- Sujan merges every PR. You never merge.
- The worker looks up any external library, API or SDK in Context7 before coding against it.
- Migrations are additive only; number taken at merge time.
- No em dashes; conventional commits; no agent co-author.
- After two failed attempts at the same problem, the worker stops and reports; you tell Sujan and offer `fable-planner`.

Every subagent brief you write ends with this line:
"Write the full report to `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<yyyy-mm-dd>-<slug>.md` in the main checkout
and reply in at most 120 words (outcome, branch/PR, tests, blockers, report path)."

## 7. Acceptance test per slice

Each slice's test is the one in its module's "Build slices" table. The ones that decide the release:

| Slice | Acceptance test |
|---|---|
| M0-S1 | Migration applies on a copy of the live schema and re-runs harmlessly; contract tests pass on real Postgres, including idempotency and the control refusal |
| M0-S2 | F1 tests 1 and 4 on real BigQuery data (read-only): keys for every option, style key on every apparel option |
| M0-S3 | Every link in a finished preview batch has a version row with role, source, hash, channel, publish time; events carry reason and change type |
| M0-S4 | F5 acceptance tests: export idempotent, freshness alert fires |
| M10-S1a | Every type in F1-R1 exists with component, action and cost class; M0-S3's publish test writes `img_shotset_crops` |
| M12-S1 | A setting changed mid-batch does not affect that batch; the next batch uses it; every output records its version set |
| M2-S1 | A new taxonomy node and attribute are added in settings and read by a test without code change |
| M5-S1 | Seed twice: 555 rules, 30 conflicts, v1 and v2; parity with `channels.ts` for v1 |
| M5-S2 | Unit tests per operator; planted cases (163-character Noon title, open-conflict rule warns, playbook block warns) |
| M5-S3 | Real test batch: Noon, Namshi, Trendyol backgrounds at 240+, Amazon image 1 white; a batch started before a publish keeps its version |
| M3-S1 | M3 4.3.9 tests 1 and 2 |
| M3-S5 | M3 4.2.9 tests 1 and 2 (overflow adapters shipped switched off) |
| M7-S2 | Killing the primary judge still completes a batch (4.2.9 tests 1 and 3) |
| M1-S1 to M1-S6 | M1 F1 to F5 tests as listed per slice; M1-S3: a real batch finishes with links for 100% of products, provisional ones flagged |
| M6-S4 | A batch started during a deploy on preview finishes cleanly (F2 tests 1, 2, 4) |
| M6-S5 | F2 test 3 (shorter deploys) |
| M6-S1, M6-S2 | F1 tests 2 and 3 (ledger completeness; reconciliation within 10% of monitoring-derived spend) |
| M6-S6 | F3 tests 1 and 2 (batch outcomes, incidents) |
| M6-S7a | A copy-only web change is green in under 10 minutes; a render change runs T1 and T2 in under 15 and T3 on preview in under 15 more |
| UX1 to UX4 | UX section 15 tests (RTL screenshot, copy lint, T1 and T2 budgets, T3 five-second test) |

## 8. Release exit (the operator proof run)

When every slice is merged and deployed (gate G1 per deploy):
1. A collection subagent (Sonnet) records the "before" numbers from the live tool first: touches per 1,000 SKUs, time
   to first links, cost per product.
2. Run a real Vero Moda or French Connection apparel batch to links on the five slice channels the way an operator
   would: drop folders and an xlsx, then touch nothing.
3. Measure the R1 exit outcome (`roadmap.md` section 5, items 1 to 8). Each item is pass or fail with the number.
4. Write `C:\Users\Sujan Ajay\Desktop\catalog-module\.runs\<yyyy-mm-dd>-r1-exit.md` with the numbers and evidence, tick
   the plan checklist, and tell Sujan in plain words.

## 9. Human gates in R1

| Gate | When | What you do |
|---|---|---|
| G1 Production deploy | every deploy | Ask Sujan for typed approval naming the sha; then run `bash infra/deploy.sh` yourself; watch with `kit:watcher` |
| G5 Marketplace-facing change | before the first upload of renders with the new background (240+ grey, white Amazon image 1) per channel | Sujan, with the channel manager, approves; the channel team uploads |
| Owner actions | read-only `ila-pg` user; OpenRouter key with no daily cap | Remind Sujan once; work proceeds on monitoring estimates until granted |

No paid vendor contract (G4), holdout freeze (G2) or promotion (G7) happens in R1.

## 10. Done check

- Every slice in section 5 merged by Sujan, deployed through G1.
- The R1 exit report exists with all eight items measured and passing (or a named failure with Sujan's decision).
- The plan checklist is ticked and R1 is marked shipped there (the progress file, not the roadmap, holds status).
- Handoff written with `ce-handoff` at the release milestone (`~/ai-personal/handoffs/<repo>/r1.md`), and the one
  resume line given to Sujan.
- Offer once to run `ce-compound` if the release produced reasoning not recoverable from code, tests or docs.
