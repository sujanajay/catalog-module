# 14c Intake release C: resume and progress

Written 2026-10-27 for the `feat/catalog-14c-intake-resume` branch (worktree
`..\catalog-module-wt\14a-intake-truth`), stacked on `feat/catalog-14b-intake-inputs` (PR #102).
Spec: `docs/specs/14c-intake-release-c.md` (parent `docs/specs/14-intake-resilience.md`).
Approved by the owner on 2026-10-27. No migration: deploys `catalog-worker` first, then `catalog-web`.

## Checklist

- [x] Build, c1: BatchCounts intake fields, merge-only counts writes and lease helpers in core, intake state words and time
- [x] Build, c2: worker phase, rate and placing lease, sha256 skip in placeRaw, cancel guards (F6, F7 part 1, F4 part 2)
- [x] Build, c3: Your unfinished batches, Cancel, Fix and continue, phase progress on the web (F4 part 2, F8)
- [x] Build, c4: platform errors for non-JSON answers (F11 part 1)
- [x] Integrate: browser scenarios 3 and 5 in their release C form, scenario 7 (phone)
- [x] Review: one run per lease attempt, so a duplicate delivery never runs placing twice; durable Fix and continue reason (`counts.fixReason`)
- [x] Simplify, render test timeouts, gates green (lint, typecheck, unit tests, all seven browser scenarios, web build)
- [ ] Owner approves the new sentence "Added, not collected yet" for the copy register
- [ ] PR opened (after PR #102 merges, or stacked on it)
- [ ] CI green
- [ ] Merged
- [ ] Deployed (`catalog-worker`, then `catalog-web`; tier 5 smoke green)
- [ ] Live verified (spec section 9 steps 1, 2 and 4)
- [ ] Live step 3: cancel the BHPC test drafts 574f2025 and 09dd86f2 (after the owner tells the operator)
