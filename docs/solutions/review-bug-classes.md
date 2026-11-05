# Bug classes the R1 clean-context reviews caught (2026-11-05)

Every R1 slice got a review by a fresh agent that had not built it. These are the defect classes those reviews found
that CI did not. Each one passed all tests, because the tests did not set up the second actor, the second version or
the second day. Use this list when building or reviewing a slice in these areas, and add the named test with the fix.
When this was written, all four PRs were still open: #172 and #173 had review-fix commits, and the fixes for #169
and #171 were pending.

## 1. An idempotency key must include the version when a row can be republished
- Seen: PR #171 (M0-S3). The publish event key was `publish:<output id>:<listing id>`. An improvement (M1-S4) or a
  "Try again" re-makes the same output row with new bytes. The second publish used the same key with a new
  `toVersionId`, threw `IdempotencyConflictError` and rolled back the publish transaction after the public copy had
  already changed. Every retry hit the same key, so the product's publish was stuck for good.
- Rule: if a row can be written again with different content, the key names the content version
  (`publish:<output id>:<content version id>:<listing id>`), not only the row.
- Test: publish, re-make the same row with new bytes, publish again; both events exist and the second names the new
  version. Evidence: `.runs/2026-11-05-m0-s3-review.md` (P1-1).

## 2. A user edit never clears a live lease
- Seen: PR #169 (M1-S6). `draftForChange` cleared `placingClaim` when the operator edited a batch while it was
  grouping. The new run claimed the free lease while the old step was still running between its lease checks, so two
  batch-wide steps wrote at once and rows from a removed input could survive and be published.
- Rule: only a stall (no renewal within the stall window) frees a lease. An edit while a lease is live either waits
  (refuse with a short 409 and retry) or lets the holder see the change through its own close path.
- Test: an edit lands while a batch-wide step holds the lease and is in flight (not with the queue paused).
  Evidence: `.runs/2026-11-05-m1-s6-review.md` (P1-1). See also `chunk-leases.md`.

## 3. A follow-up batch appends; it never replaces live public photos
- Seen: PR #169 (M1-S6). "Add more photos" numbered the new shots from 1 per product and auto-started. Publish then
  replaced the parent's live shots 1-2 on every channel and removed shots 3-5, with no person seeing the overwrite
  preview.
- Rule: a follow-up numbers shots after the product's highest live shot, and any auto-start holds when the preview
  would replace or remove live shots.
- Test: a parent with 5 live shots plus a follow-up of 2 shots ends with 7 live shots and no removals.
  Evidence: `.runs/2026-11-05-m1-s6-review.md` (P1-2).

## 4. Background probes must not keep paid GPUs warm, and every external probe has a timeout
- Seen: PR #172 (M1-S4b). The sweep (every 10 min) kept probing an upscaler in outage even when no photo waited on
  it. Each probe hit the min-instances-0 RTX PRO 6000 service; with Cloud Run's idle window of about 15 min, that keeps
  one GPU instance alive indefinitely. The same probe had no `timeoutMs`, so a hung service blocked every sweep for
  the full 240 s GPU timeout before recovery and finalize ran.
- Rule: a background job calls a scale-to-zero paid service only when real work waits on it, or within a bounded
  window. Every probe passes a timeout sized for "is it up", not for real work, and a slow pass never runs before
  the sweep's recovery duties.
- Test: with nothing waiting, the sweep makes no probe; a hung probe returns within its timeout.
  Evidence: `.runs/2026-11-05-m1-s4b-review.md` (P2-1, P2-2).

## 5. A cost ledger shares instance time between concurrent calls and uses the bill's day boundaries
- Seen: PR #173 (M6-S2). Each upscale call row was priced at the full instance rate for its duration, but the GPU
  service runs 4 calls at once per instance, so a busy day books up to 4x the billed instance time and fires false
  `ledger_over` alerts. Rows were dated by their end time, so work crossing midnight UTC was booked in full on the
  end day.
- Rule: for a multi-call instance, divide by the calls in flight or cap overlapping rows at instance time. Split
  work at the day boundary the bill uses. The billing export's `usage_start_time` is UTC while the console and
  invoice day is US Pacific; group the export by `DATE(usage_start_time, "UTC")` so it matches UTC ledger rows.
- Test: 4 overlapping calls on one instance book no more than the instance's billed seconds; a job from 23:45 to
  00:15 UTC is split across the two days. Evidence: `.runs/2026-11-05-m6-s2-review.md` (P2-1, P2-3, P3-9).
