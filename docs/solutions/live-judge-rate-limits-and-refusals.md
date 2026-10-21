# Live judge: rate limits and content refusals - learnings

## What the live runs showed (session 5, 2026-10-21, build D2 `13fe10d`)
- Load run `load-4aefdc91-e578-4440-b5ed-3c858ada2a67` (270 products, 4 marketplaces): 55 of
  1,583 judge calls failed, 54 with HTTP 429 (rate limit, about 3.5% of calls) and 1 with HTTP 503.
  Most were retried and passed. 9 checks ended "quality check unavailable" and held their photo:
  4 after two 429s, and 5 because the reply was empty: the provider refused the request as
  prohibited content (lingerie-type product photos).
- Live eval run (`evals-20261021064827-249242`, `evals-20261021064827-239f4a`): 11 of the 13 held
  products across the 8 sets were rate-limit holds (finding J1), not image defects. The judge then
  retried once after 2 s and held the photo as `qa_unavailable`.
- A false hold costs the operator a card to open and a "Use as is" click; it never publishes a
  wrong image, but at scale it turns a busy minute at the provider into many attention cards.

## What D3 changed (PR #76 `dea81bc`, deployed 2026-10-21 11:17 UTC)
- On HTTP 429 and 5xx the judge backs off 5, 15 and 45 s before giving up on the first model.
- It then falls through to the second judge model with the same sheet and prompt.
- Only when both fail is the photo held with "The quality check could not read this image."

## What is still open
- Content refusals: an empty or refused reply is not a 429 or 5xx, so the D3 fallback does not
  cover it; those photos are still held. Fix: treat an empty or refused reply like a failure and
  fall through to the second judge model before holding (deferred row in `docs/PROGRESS.md`).
- The D3 back-off has not yet been measured under load; the next load run should count 429s,
  fall-throughs and holds separately.
- Rate limits depend on the provider account and time of day; keep large runs alone on the stack
  and do not run two live-judge jobs in parallel without checking the limit first.

## Related
- `docs/PROGRESS.md` rows "spec 10 eval suite, session 5 live run with policy write",
  "09 load test, session 5" and "deferred after go-live (session 5)".
