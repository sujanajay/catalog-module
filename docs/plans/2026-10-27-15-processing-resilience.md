# 15 Processing resilience (release E)

Written 2026-10-27 for the `feat/catalog-15-processing-resilience` branch (worktree
`catalog-module\.claude\worktrees\agent-aa78ae94976652973`), stacked on `feat/catalog-14b-intake-inputs` (PR #102).
Spec: `docs/specs/15-processing-resilience.md`. Approved by the owner on 2026-10-27, migration 0004 included.
Ships migration `0004_chunk_leases` (additive columns, guarded, safe with chunks in flight) through the
`catalog-migrate` job, then deploys `catalog-worker` and `catalog-web`, then re-runs `infra/bootstrap.sh`
(sweep every 10 min) and `infra/monitoring.sh` (alert 10). Background: `docs/solutions/chunk-leases.md`.

## Checklist

- [x] Spec committed with a README row
- [x] Core and DB: migration 0004 with backfill, dispatch window, recovery rules, task ids with steps, progress text (E2-E5, E7)
- [x] Worker: time budget with hand-off, heartbeat lease, step tokens, stall rule, window on finish, sweep (E1-E5, E7)
- [x] Acceptance tests E1-E5, E7, E8 (`resilience.test.ts`, 50-seed crash property)
- [x] Web: Start and resume dispatch the window; wizard routes test uses the new task id
- [x] Infra: chunk size 10, window 8, optional budget, 10-minute sweep with check-then-update, metric and alert 10, infra tests
- [x] Docs: chunk leases note, monitoring docs and operator guide list ten alerts
- [ ] Review and simplify, gates green (lint, typecheck, unit tests, intake browser scenarios)
- [ ] Alerting price confirmed before `monitoring.sh` runs on the live project
- [ ] PR opened (after PR #102 merges, or stacked on it)
- [ ] CI green
- [ ] Merged
- [ ] Deployed (`catalog-migrate` for 0004, then `catalog-worker`, then `catalog-web`; bootstrap and monitoring re-run; tier 5 smoke green)
- [ ] Live verified (spec section 10: no 504 on chunk tasks, `chunk delivery` lines with hand-offs, legacy copies drained as 200)
