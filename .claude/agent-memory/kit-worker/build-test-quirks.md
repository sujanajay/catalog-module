---
name: build-test-quirks
description: catalog-module build and test quirks in isolated worktrees - shell refusals, vitest scoping, flaky heavy tests, migration counters
metadata:
  type: project
---

- Bash refuses compound or heredoc commands in isolated worktrees: write a script with Write, then run `python <script>` or `bash <script>`; use Edit for multi-line edits.
- Root `npx vitest run <path>` does not pick up apps/web tests ("no tests"); run them from apps/web (`cd apps/web && npx vitest run test/...`).
- The full `pnpm test` can time out the sharp-heavy render tests (catalog-local-render, render.test) under parallel load; they pass alone. Run long suites in the background.
- Adding a drizzle migration breaks tests that count migrations (people.test.ts, migration-0003.test.ts); they now read meta/_journal.json, keep it that way.
- Web route tests mock `@catalog/core/tasks`; use `vi.mock(import(...), async (original) => ({...await original(), enqueueTask}))` so new exports exist.
- PGlite test DB is shared within a test file: a sweep in one test also recovers other tests' batches, so filter queues by chunk id.

**Why:** each of these cost a fix cycle on spec 15 (2026-10-27).
**How to apply:** check this list before running gates or adding migrations in this repo.
