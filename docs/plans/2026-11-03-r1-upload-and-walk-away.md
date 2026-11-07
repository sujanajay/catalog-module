# R1 progress: Upload and walk away

Progress file for release R1 (`docs/program/roadmap.md` section 5), run from `docs/program/sessions/R1-build.md`.
This is the only place R1 status lives. Updated at milestones only: PR opened, merged, deployed.

Status values: todo, building, in review, PR open, merged, deployed.

Last updated 2026-11-07, with main at b4dcbf8. R1 is not complete: see Exit proof below.
Deploy sha is the first recorded successful deploy that contained the slice.

## Slices

| Done | Lane | Slice | Starts when | Status | Branch | PR | Deploy sha |
|---|---|---|---|---|---|---|---|
| [x] | A | M0-S1 graph tables (migration 0009) | now | deployed | feat/m0-s1-graph-tables | #145 | 4ff1e82 |
| [x] | A | M0-S2 | M0-S1 merged | deployed | feat/m0-s2 | #153 | b5f9fe0 |
| [x] | A | M0-S3 | M0-S1, M0-S2, M10-S1a, M12-S1, M1-S3 merged | deployed | feat/m0-s3 | #171 | b5f9fe0 |
| [x] | A | M0-S4 (named exception: new job and infra script) | M0-S1 merged | deployed | feat/m0-s4 | #157 | b5f9fe0 |
| [x] | B1 | M12-S1 | M0-S1 merged | deployed | feat/m12-s1 | #156 | b5f9fe0 |
| [x] | B2 | M10-S1a | now (merges after M0-S1) | deployed | feat/m10-s1a | #160 | b5f9fe0 |
| [x] | C | M2-S1 | now | deployed | feat/m2-s1 | #146 | 4ff1e82 |
| [x] | D | M5-S1 | M2-S1 merged | deployed | feat/m5-s1 | #155 | b5f9fe0 |
| [x] | D | M5-S2 | M5-S1 merged | deployed | feat/m5-s2 | #163 | b5f9fe0 |
| [x] | D | M5-S3 | M5-S2, M3-S1, M6-S4 merged | deployed | feat/m5-s3 | #174 | b5f9fe0 |
| [x] | E | M7-S2 | now | deployed | feat/m7-s2-judge-fallback | #149 | 4ff1e82 |
| [x] | F | M3-S5 | M7-S2 merged | deployed | feat/m3-s5 | #158 | b5f9fe0 |
| [x] | F | M3-S1 | M5-S1, M0-S1 merged | deployed | feat/m3-s1 | #166 | b5f9fe0 |
| [x] | G | M1-S1 | now | deployed (Supabase folder paste needed the secret mount from #152, live at b5f9fe0) | feat/m1-s1 | #148 | 4ff1e82 |
| [x] | G | M1-S3 | M1-S1 done (one writer per module) | deployed | feat/m1-s3 | #154 | b5f9fe0 |
| [x] | G | M1-S2 (paired with UX3) | M1-S1 merged | deployed | feat/ux3-m1-s2 | #165 | b5f9fe0 |
| [x] | G | M1-S5 (paired with UX4) | M1-S3 merged | deployed | feat/m1-s5-ux4 | #178 | b5f9fe0 |
| [x] | G | M1-S4 | M1-S3 merged | deployed | feat/m1-s4 | #161 | b5f9fe0 |
| [x] | G | M1-S4b (upscaler outage deadline, split from M1-S4) | M1-S4, M6-S6, M12-S1 merged | deployed | feat/m1-s4b | #172 | b5f9fe0 |
| [x] | G | M1-S6 | M1-S2 merged | deployed | feat/m1-s6 | #169 | b5f9fe0 |
| [x] | H | M6-S4 with M6-S1 (named exception) | now | deployed (preview acceptance passed) | feat/m6-s4-s1-deploy-safe-cost-ledger | #147 | 4ff1e82 |
| [x] | H | M6-S6 | after M6-S1 in the lane | deployed | feat/m6-s6 | #159 | b5f9fe0 |
| [x] | H | M6-S2 | M6-S1 merged | deployed | feat/m6-s2 | #173 | b5f9fe0 |
| [x] | H | M6-S5 | M6-S4 merged | deployed | feat/m6-s5 | #177 | b5f9fe0 |
| [x] | H | M6-S7a (tiered tests, M6-F8) | M6-S4 merged | merged (CI only, nothing to deploy; only tier T1 is built, T2 and T3 are not) | feat/m6-s7a | #164 | none |
| [x] | K | UX2 | now | deployed | feat/ux2 | #151 | b5f9fe0 |
| [x] | K | UX1 | UX2 merged | deployed | feat/ux1 | #170 | b5f9fe0 |
| [x] | K | UX3 (with M1-S2) | with M1-S2 | deployed | feat/ux3-m1-s2 | #165 | b5f9fe0 |
| [x] | K | UX4 (with M1-S5) | with M1-S5 | deployed | feat/m1-s5-ux4 | #178 | b5f9fe0 |

## Other merged PRs

| PRs | What | Status | Deploy sha |
|---|---|---|---|
| #152, #162, #167, #168, #176, #179, #180, #181 | Infra, CI and test fixes found while building the slices | deployed | b5f9fe0 |
| #150, #175 | Docs only | merged | none |
| #182, #183, #184, #185 | Fixes from exit run 1: whole-brand folder read, judge kill switch job, link role and change events, full cost | deployed | 5f207bc |
| #186, #187, #188, #189 | Fixes from exit run 2: one unexplained probe 502, same-bytes shot clashes and left-out products shown, traffic shift records, cut-out agreement | deployed | f2c090a |
| #190, #191 | Judge catches real defects with an exam; apparel shadows and floor patches. Merged 2026-11-07 | merged. Deploy of b4dcbf8 started 2026-11-07 about 10:10 IST, result not recorded here yet | |

## Gates and owner actions

| Done | Item | Status |
|---|---|---|
| [ ] | G1 production deploy: typed approval naming the sha, per deploy | per deploy |
| [ ] | G5 marketplace-facing change: channel manager approves first upload of new-background renders, per channel | open. Runs 1 and 2 each had a check with named exclusions (run 2: 102 outputs with visible defects). Run 3 is the next evidence |
| [x] | Owner: read-only `ila-pg` user | done, owner confirmed 2026-11-05 |
| [x] | Owner: OpenRouter key with no daily cap | done, owner confirmed 2026-11-05 |

## Release exit

| Done | Step | Status |
|---|---|---|
| [x] | "Before" numbers from the live tool (touches per 1,000 SKUs, time to first links, cost per product) | done in run 1, `.runs/2026-11-05-r1-before-numbers.md` |
| [ ] | Real Vero Moda or French Connection apparel batch on the five slice channels, hands-off | two runs done with open items, run 3 planned |
| [ ] | Roadmap section 5 items 1 to 8 measured, pass or fail with the number | measured twice, not all pass. See Exit proof |
| [ ] | Exit report `.runs/<date>-r1-exit.md` | reports for runs 1 and 2 exist. Final report waits for run 3 |
| [ ] | R1 shipped | todo |

## Exit proof

Numbers are from `.runs/2026-11-05-r1-exit.md` (run 1) and `.runs/2026-11-06-r1-exit-2.md` (run 2). "Not proven" counts as a fail.

- Run 1, 2026-11-05, production at b5f9fe0: the two smaller Vero Moda folders, 141 products, 317 photos, 6 channels, done 25.6 min after start.
- Run 2, 2026-11-06, production at 5f207bc: the whole Vero Moda folder, 477 folders, 2,039 photos, 6 channels, done 38.1 min after start.

| # | Exit item | Run 1 | Run 2 |
|---|---|---|---|
| 1 | Links for all products, provisional flagged, no clicks after upload, one digest, no orphan drafts | PASS: 141 of 141 products, 1,902 of 1,902 links, 57 provisional, 0 touches | FAIL: 386 of 477 folders got links, 91 products and 552 photos silently left out. All else passed for the 386 |
| 2 | Batch started during a deploy finishes; success and incidents recorded | Not proven: recording passed, the deploy changed nothing | Not proven after 2 attempts: recording passed, no traffic moved during a started batch |
| 3 | Killing the primary judge still completes the batch | Not proven: the kill was not run, no command existed | PASS: 8,947 of 8,947 judgements by route 2, 0 unavailable, 0 held |
| 4 | Cost per product within 10% of monitoring | FAIL: ledger 0.0204 against 0.0514 USD (-60%) | FAIL as shown that day: 0.0262 against 0.0403 USD (-35%, not final). Run 1's batch after the fix: 0.0508 against 0.0514 USD (-1.1%) |
| 5 | Every link has a version row, in BigQuery; every change event has reason and type | PARTIAL: 1,902 of 1,902 versions, role always unknown, 0 events | PASS: 8,533 of 8,533 versions, 8,533 events, 0 gaps in BigQuery |
| 6 | Backgrounds 240+, Amazon image 1 white, rules pinned, setting change only affects the next batch | PASS, rules pin by tests only: 0 breaches in 2,027 outputs, Amazon 141 of 141 | PASS on rules: 8,533 of 8,533, Amazon 384 of 384. 102 outputs have visible defects. Pin and settings not re-run |
| 7 | Copy-only change green under 10 min; render change tiers under 15 | PASS for T1: median 6.9 min for copy, 6.4 for render. T2 and T3 not built | PASS for T1, reused: median 6 min, two runs at 15 min |
| 8 | Baseline numbers recorded | PASS | PASS |

### Run 3: planned, not run

Steps from `.runs/2026-11-07-r1-fast-runbook.md`. No result is recorded here. Each deploy needs its own typed approval.

1. Merge #190 and #191, then deploy that commit (b4dcbf8, started 2026-11-07).
2. Merge this docs change, which gives a later commit for a second deploy, and prebuild its image.
3. Check the first deploy finished, including the new judge exam. If the exam failed, stop.
4. Optional: one recut call for the 17 photos on the proof list, just before the first paste.
5. Paste the main Vero Moda folder as batch V1, on six channels, then touch nothing more.
6. Start the second deploy 3 minutes after that paste, so the worker's traffic moves at about 24 minutes, inside the started batch.
7. Paste French Connection about 25 minutes after the V1 paste.
8. When V1 is done, paste the two smaller Vero Moda folders as batch V2. They share 4 products with V1, so they cannot run beside it.
9. Check item 2 as soon as V1 ends: a worker traffic move inside the batch's run, outputs published after it, status done, 0 duplicates. The overlap flag alone is not enough, since a web move also sets it.
10. Last, with nothing else running, run the judge kill drill for item 3 on a small separate batch. That batch cannot count as G5 evidence.
11. Read item 4 after the daily cost reconcile on 2026-11-08 at 06:00Z, then write the final exit report.
