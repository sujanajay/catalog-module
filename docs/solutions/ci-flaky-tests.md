# Flaky CI - root causes and the guards that hold them (R1, 2026-11-04/05)

An audit of every CI run from 2026-11-02 to 2026-11-04 (82 runs, 6 failed attempts) found one real flake, one
machine-dependent test, and three "green alone, broken together" breaks (those are in
`parallel-prs-merge-train.md`). No failure was infrastructure. Evidence: `.runs/2026-11-04-ci-failure-audit.md`,
`.runs/2026-11-05-ci-reliability.md` (PR #168), `.runs/2026-11-04-retry-links-tests.md` (PR #167).

## Root causes

| Cause | What it looked like | Fix | Guard now |
|---|---|---|---|
| A fixed sleep in a Playwright spec | Intake scenario 5 "leave and return" failed about 4% of runs and was the only red run on main. It slept 3.5 s assuming one page poll (every 2.5 s) had shown the last count. Under `next dev` on a loaded runner a poll took longer, so the test captured a stale count (80) while the DB said 120. | Read the count from the same API the page polls, then wait web-first for the page to show it (`expect(...).toContainText`). | ESLint `no-restricted-syntax` bans `*.waitForTimeout(...)` in `**/*.spec.{ts,tsx}` (`eslint.config.mjs`). Existing negative checks ("nothing happens for N ms") sit in `eslint-suppressions.json`; they can only pass falsely, never fail falsely. |
| Node's 5 s keep-alive in the test harness | `apiRequestContext.post: read ECONNRESET` on a harness call after an idle gap longer than 5 s. The server closed the idle socket just as the client reused it. Suspected from the error and the idle gap, not reproduced. | `server.keepAliveTimeout = 120_000; server.headersTimeout = 121_000` in `apps/web/test/catalog-intake.server.ts`. | None automatic. Any new test HTTP server (plain `createServer`) needs the same two lines. |
| Real backoff sleeps in unit tests | Three retry-links tests each took about 10 s of real `setTimeout` backoff ([2000, 8000] ms). Under parallel load plus PGlite start-up they passed the 30 s `testTimeout`. | Pass the existing `sleep` seam (`IngestDeps.sleep`), record the requested waits and assert them, so the backoff stays covered. | ESLint bans `new Promise(r => setTimeout(r, N))` with N > 50 in `**/*.test.{ts,tsx}`. |
| ICU names differ between machines | `expected '4 Nov 2026, 10:00 GMT+0' to be '... GMT'`. The runner's Node ICU printed `shortOffset` for Europe/London as "GMT+0"; the laptop printed "GMT". This was a real UI bug, not only a test bug. | `offsetLabel` normalises every ICU spelling, with a table test of the variants. | Runtime pinned (next row). Keep a table test whenever code formats Intl output. |
| Unpinned Node and TZ | `node-version: 22` floated the minor version and ICU; no `TZ` was set, so laptops and runners differed. | `.nvmrc` holds the exact version; every setup-node step uses `node-version-file: .nvmrc`; workflow-level `env: TZ: UTC`. | `.github/workflows/ci.yml`. Bump `.nvmrc` on purpose, never float it. |

## How to prove a flake is gone
`ci.yml` has a `workflow_dispatch` "browser repeat" job that runs one spec many times on a branch:
`gh workflow run CI --ref <branch> -f spec=catalog-intake.browser.spec.ts -f grep="5. leave and return" -f repeat=20`.
Scenario 5 passed 20 of 20 after the fix. Browser scenarios are too slow to warm up on the laptop (>600 s), so prove
them on GitHub.

## Branch protection (a GitHub setting, not in the repo)
Until R1, main had no protection at all (404 "Branch not protected"). It now requires the 10 CI checks (lint and
typecheck, unit shards 1-6, real Postgres, infra and matting, intake browser scenarios) and "require branches to be up
to date" (`strict: true`). Check it with
`gh api repos/sujanajay/catalog-module/branches/main/protection --jq .required_status_checks`.
If a job is renamed or the shard count changes, update the required list in the same PR, or every PR stays blocked
on a check that never reports.

## Not done (options if flakes return)
A GitHub merge queue, a changed-test flaky detector (repeat changed tests under load), and Playwright `retries: 1` with
flaky reporting. The audit's table in `.runs/2026-11-04-ci-failure-audit.md` has the tradeoffs.
