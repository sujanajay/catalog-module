# 14b Intake release B: inputs that can be fixed

Written 2026-10-27 for the `feat/catalog-14b-intake-inputs` branch (worktree
`..\catalog-module-wt\14a-intake-truth`), stacked on `feat/catalog-14a-intake-truth` (PR #101).
Spec: `docs/specs/14b-intake-release-b.md` (parent `docs/specs/14-intake-resilience.md`).
Approved by the owner on 2026-10-27. Ships migration `0003_intake_states` (widened CHECK constraints
only) through the `catalog-migrate` job, then deploys `catalog-web` and `catalog-worker`.

## Checklist

- [x] Build, b1: migration 0003, removed inputs ignored everywhere, pasted grids with a readback (F2)
- [x] Build, b2: step 1 input list with Remove, replace in place, Retry of a cut-off upload (F3)
- [x] Build, b3: link failures by row and column, temporary or permanent, Try the failed links again (F5)
- [x] Integrate: browser harness with a fake image host for POST /links, scenarios 2, 3 and 4
- [x] Review and simplify, gates green (lint, typecheck, unit tests, all six browser scenarios, web build)
- [ ] PR opened (after PR #101 merges, or stacked on it)
- [ ] CI green
- [ ] Merged
- [ ] Deployed (`catalog-migrate` job for 0003, then `catalog-web` and `catalog-worker`; tier 5 smoke green)
- [ ] Live verified
