# Parallel PRs: green alone, broken together (R1 merge trains, 2026-11-04)

## What happened
R1 built many slices in parallel, one PR each. Several pairs passed CI on their own and broke once both were on main:
- #157 (M0-S4) added export tests that insert change events with `title_rewrite`. #160 (M10-S1a) added a foreign key
  from change events to a seeded list of change types that does not contain that id. `export.test.ts` then failed
  with 23503 in 7 tests. Fixed with the seeded id `title_rewritten_en`.
- #159 (M6-S6) added `catalog-touches.test.ts`, which lists every operator write route and classifies each as a
  touch or not. #165 (UX3) added three write routes. The list check failed until they were classified.
- #154 (M1-S3) + #166 (M3-S1): `auto-decide.test.ts` built deps without `channelRules` and returned 503 everywhere.
  Caught locally after merging main into #166.

None reached main, but only because the coordinator merged main into each PR and re-ran CI by habit. With no
"up to date" rule, merging #165 on its earlier green run would have turned main red.
Evidence: `.runs/2026-11-04-merge-train.md`, `.runs/2026-11-04-merge-train-2.md`, `.runs/2026-11-04-ci-failure-audit.md`.

## Why it happens
A PR's CI tests the PR on the main it branched from, not on the main it lands on. Two kinds of change make the gap
bite: a constraint added by one PR (a foreign key, a CHECK, a seeded list) against fixtures written by another, and a
test that enumerates something (routes, tables, migrations) against a PR that adds one more of it.

## What holds it now
- Branch protection on main: the 10 CI checks are required and branches must be up to date (`strict: true`). See
  `ci-flaky-tests.md` for the check command.
- The merge train, per PR in merge order:
  1. In the PR's worktree: `git fetch origin` and `git merge origin/main --no-edit` (never a force push).
  2. Resolve conflicts. Renumber a migration if main took its number (`migration-renumbering.md`).
  3. Locally: `pnpm -s lint`, `pnpm -s typecheck`, and the tests the merge touched. After a migration that adds a
     foreign key or constraint, run the tests of every module that writes that table. After adding a route or table,
     run any test that enumerates them.
  4. Push, wait for all 10 checks on the new head, then
     `gh pr merge <n> --squash --match-head-commit <sha>`. `--match-head-commit` refuses the merge if anything was
     pushed after the green run.
  5. The next PR in the train starts from step 1 against the new main.
- Read check results from the check-runs API or `gh run view`; `gh pr checks` lagged behind a finished run once.
- After every conflict resolution, grep the merged docs for `<<<<<<<` and `>>>>>>>`. In the first train, marker lines
  from `git checkout -m` were merged into two docs and needed a cleanup commit.
- Each merge after another costs a full CI run (about 6 to 7 min wall time). That is the price of a red-free main.
