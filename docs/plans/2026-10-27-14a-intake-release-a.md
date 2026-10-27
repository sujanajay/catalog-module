# 14a Intake release A: truth and way back

Written 2026-10-27 for the `feat/catalog-14a-intake-truth` branch (worktree
`..\catalog-module-wt\14a-intake-truth`), branched from `docs/intake-resilience` at 08ddcb0.
Spec: `docs/specs/14a-intake-release-a.md` (parent `docs/specs/14-intake-resilience.md`).
Approved by the owner on 2026-10-27 (parent section 11, decision 4). Deploys `catalog-web` only.

## Checklist

- [x] Setup: worktree and branch, owner decisions recorded in `docs/SPEC.md`, this plan, baseline typecheck and tests
- [x] Build, workstream A: core and wizard (sheet upload never crashes step 2, batch id in the address bar, `/catalog/new?batch=`, polled counts on steps 2 and 3)
- [x] Build, workstream B: pages and copy (error page under `/catalog`, truthful draft and failed screens, "Continue setting up", brand page sentence, copy register)
- [x] Build, workstream C: fixtures and browser harness (shared fixtures and harness from parent section 8)
- [x] Integrate and gates: typecheck, lint, unit tests, browser harness, copy checks (no model ids, no em dashes)
- [x] Review
- [ ] PR opened
- [ ] CI green
- [ ] Merged
- [ ] Deployed (`catalog-web`)
- [ ] Live verified
- [ ] Report
