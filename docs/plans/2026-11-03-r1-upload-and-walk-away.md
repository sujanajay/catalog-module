# R1 progress: Upload and walk away

Progress file for release R1 (`docs/program/roadmap.md` section 5), run from `docs/program/sessions/R1-build.md`.
This is the only place R1 status lives. Updated at milestones only: PR opened, merged, deployed.

Status values: todo, building, in review, PR open, merged, deployed.

## Slices

| Done | Lane | Slice | Starts when | Status | Branch | PR | Deploy sha |
|---|---|---|---|---|---|---|---|
| [ ] | A | M0-S1 graph tables (migration 0009) | now | building | feat/m0-s1-graph-tables | | |
| [ ] | A | M0-S2 | M0-S1 merged | todo | | | |
| [ ] | A | M0-S3 | M0-S1, M0-S2, M10-S1a, M12-S1, M1-S3 merged | todo | | | |
| [ ] | A | M0-S4 (named exception: new job and infra script) | M0-S1 merged | todo | | | |
| [ ] | B1 | M12-S1 | M0-S1 merged | todo | | | |
| [ ] | B2 | M10-S1a | now (merges after M0-S1) | todo | | | |
| [ ] | C | M2-S1 | now | building | feat/m2-s1 | | |
| [ ] | D | M5-S1 | M2-S1 merged | todo | | | |
| [ ] | D | M5-S2 | M5-S1 merged | todo | | | |
| [ ] | D | M5-S3 | M5-S2, M3-S1, M6-S4 merged | todo | | | |
| [ ] | E | M7-S2 | now | todo | | | |
| [ ] | F | M3-S5 | M7-S2 merged | todo | | | |
| [ ] | F | M3-S1 | M5-S1, M0-S1 merged | todo | | | |
| [ ] | G | M1-S1 | now | building | feat/m1-s1 | | |
| [ ] | G | M1-S3 | M1-S1 done (one writer per module) | todo | | | |
| [ ] | G | M1-S2 (paired with UX3) | M1-S1 merged | todo | | | |
| [ ] | G | M1-S5 (paired with UX4) | M1-S3 merged | todo | | | |
| [ ] | G | M1-S4 | M1-S3 merged | todo | | | |
| [ ] | G | M1-S6 | M1-S2 merged | todo | | | |
| [ ] | H | M6-S4 with M6-S1 (named exception) | now | building | feat/m6-s4-s1 | | |
| [ ] | H | M6-S6 | after M6-S1 in the lane | todo | | | |
| [ ] | H | M6-S2 | M6-S1 merged | todo | | | |
| [ ] | H | M6-S5 | M6-S4 merged | todo | | | |
| [ ] | H | M6-S7a (tiered tests, M6-F8) | M6-S4 merged | todo | | | |
| [ ] | K | UX2 | now | todo | | | |
| [ ] | K | UX1 | UX2 merged | todo | | | |
| [ ] | K | UX3 (with M1-S2) | with M1-S2 | todo | | | |
| [ ] | K | UX4 (with M1-S5) | with M1-S5 | todo | | | |

## Gates and owner actions

| Done | Item | Status |
|---|---|---|
| [ ] | G1 production deploy: typed approval naming the sha, per deploy | per slice above |
| [ ] | G5 marketplace-facing change: channel manager approves first upload of new-background renders, per channel | todo |
| [ ] | Owner: read-only `ila-pg` user | asked |
| [ ] | Owner: OpenRouter key with no daily cap | asked |

## Release exit

| Done | Step | Status |
|---|---|---|
| [ ] | "Before" numbers from the live tool (touches per 1,000 SKUs, time to first links, cost per product) | todo |
| [ ] | Real Vero Moda or French Connection apparel batch on the five slice channels, hands-off | todo |
| [ ] | Roadmap section 5 items 1 to 8 measured, pass or fail with the number | todo |
| [ ] | Exit report `.runs/<date>-r1-exit.md` | todo |
| [ ] | R1 shipped | todo |
