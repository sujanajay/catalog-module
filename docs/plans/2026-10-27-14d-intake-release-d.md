# Plan: spec 14d, intake release D (the should set, without F14)

Date: 2026-10-27. Spec: `docs/specs/14d-intake-release-d.md` (parent `docs/specs/14-intake-resilience.md`).
Branch `feat/catalog-14d-intake-should`, stacked on `feat/catalog-14c-intake-resume` (PR C). Approval: the
owner approved the build and dropped F14 (the finished-collection email) on 2026-10-27; operators return to
the dashboard (Your unfinished batches).

## Checklist

- [x] Step 0: F14 removed from 14d, the parent (release table, terms, section 2 item 6, sections 4, 5, 6,
      7, 10, decision 5, 12), `docs/SPEC.md` and the `docs/specs/README.md` rows; dated note on the
      proposal; "Sujan AH" paths fixed in 14d and SPEC.md.
- [x] F7 part 2: `groupBatch` then chunked, resumable `placeBatch` with `place-state.json`; options-only
      regroup without collecting again.
- [x] F5 part 2: automatic link retry (`attempts`, `final`, backoff 2 s and 8 s, 20 s retry timeout,
      `LINK_MAX_ATTEMPTS` across runs) and the delivery time budget; "Transient problems were tried
      <attempts> times." on the card.
- [x] F10: `sameBatches` and `duplicatePhotos` in the overwrite preview; the two step 4 pairs, the batch
      name linking to the other batch; neither blocks Start.
- [x] F11 part 2: paged hand-off (`HAND_OFF_PAGE` 500) and `/tasks/catalog/ingest-more`, registered in the
      worker and in `TASK_ROUTES` (ingest queue).
- [x] F12: drafts expire after `DRAFT_EXPIRY_DAYS` (14, worker env via `infra/deploy.sh`); "Expired after
      <N> days with no activity" in `deriveBatchState`; one INFO line per ingest delivery.
- [x] `groupBatch` timing at 2,000 products measured (tier 2, PGlite) and reported.
- [ ] Code review and simplify passes.
- [ ] Gates: lint, typecheck, test, intake browser scenarios, web build.
- [ ] PR D opened (ship step, by the manager), merged by the owner.
- [ ] Deployed (worker with or before web); tier 5 smoke green.
- [ ] Live verification of 14d section 9 (Test Brand only, quiet check first) and cleanup.

## Decisions taken while building (owner not available)

1. "Untouched" means no write to the batch row for 14 days (`updated_at`); page reads never write it.
2. `<attempts>` on the card is the highest attempt count of a retried failed link.
3. Where the parent copy register and 14d differ, 14d's wording is used (the duplicate photo pair keeps
   "; <more>", written "; <n> more").
4. Options-only regroup covers identifier mode and precedence. A change of a sheet's columns or kind
   changes which links the sheet lists, so it still collects again (links already read are kept and
   placing skips unchanged photos). An options-only regroup does not fetch non-final links again; "Try
   the failed links again" does.
5. A placing continuation travels on the existing `/tasks/catalog/ingest` route with `place: "<cursor>"`
   and the claiming delivery's body, so the lease token is the same; continuations are named tasks
   (hashed), so a retried delivery never queues a chunk twice. A retried chunk re-runs with zero copies
   (sha256 skip) rather than reading a stored cursor.
6. `ingest-more` carries `after` (the last upload id handed) besides `{ batchId, run }`, so pages follow the
   upload id order and every upload is queued once.
