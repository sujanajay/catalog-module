## What changed for the operator or the system


## Tests

Tiers run (M6-F8, docs/specs/test-tiers.json; CI lists the tiers this change needs in the run summary):

- [ ] T0 `pnpm t0` before the commit (under 3 min)
- [ ] T1 CI green (every PR, under 10 min)
- [ ] T2 real-photo regression set, if render, matte, shadow, crop or QA changed (not built yet: name the unit tests run instead)
- [ ] T3 preview batch, if the pipeline changed (by hand with infra/deploy-preview.sh until automated)
