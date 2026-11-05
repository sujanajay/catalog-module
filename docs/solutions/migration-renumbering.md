# Parallel migration numbering: renumber at merge (R1, 2026-11-04)

## The problem
Every PR that changes the schema runs `drizzle-kit generate`, which takes the next free number on the main the branch
started from. With several schema PRs open at once, they claim the same numbers (in the first R1 merge train,
seven PRs were renumbered, for example #161 from 0019 to 0015 and #160 from 0021 to 0019). drizzle runs migrations
in journal order and skips an entry whose `when` is not later than the one before it, so a careless renumber can
silently skip a migration in production. Evidence: `.runs/2026-11-04-merge-train.md`.

## The rule
Keep the branch's number while the PR is open. Renumber at merge time, onto the end of the main it is about to land
on. Do it in the merge-main-into-PR step of the merge train (`parallel-prs-merge-train.md`):
1. Save the branch's hand-written SQL somewhere outside the repo.
2. Take main's `packages/core/drizzle/meta/_journal.json` and main's snapshots; `git rm` the branch's SQL and snapshot.
3. In `packages/core`: `pnpm exec drizzle-kit generate --name <slug>`. This writes the next number, a journal entry
   with a fresh `when`, and a snapshot whose `prevId` is main's last snapshot id.
4. Check that the new snapshot's tables equal the branch's old snapshot for the branch's own tables.
5. Put the hand SQL back under the new file name and update its header comment.
6. Update every reference to the old number: `schema.ts` comments, docs, and the per-migration test. Rename
   `migration-00NN.test.ts` to the new number and fix any constants in it.
7. In `migration-lint.test.ts`, add the new tag to the run-order assertions.

## What the checks catch
- `node packages/core/scripts/check-migrations.mjs` (CI lint job) and `lintJournal` in `migration-lint.test.ts`:
  journal `idx` runs 0..n-1, `when` strictly increases, each tag's number is above the previous one, every journal
  entry has a `.sql` file, and every `.sql` file is in the journal.
- `migration-lint.test.ts` "every journal entry has a snapshot whose prevId is the previous entry's snapshot id":
  a renumber that kept the branch's old snapshot (two snapshots with the same parent) fails with the snapshot name
  and the expected `prevId`. Without this, the next `drizzle-kit generate` diffs against the wrong schema.

## What no check catches
Stale references to the old number in docs and comments, and a hand SQL header that still names the old number.
Grep for the old number after step 6.
