# Styli enlargement cap removed - learnings

Owner decision 2026-10-22. Code: `packages/core/src/catalog/render.ts` (renderSource), `channels.ts`
(`MAX_UPSCALE`, `MIN_SOURCE_LONG_SIDE_PX`), the step 4 count `apps/web/lib/catalog/preview.ts`
(`plannedImages`), the worker's planned rows `apps/worker/src/catalog/chunk.ts`, the completeness eval
`packages/core/src/catalog/evals/completeness.ts`.

## What happened
- Batch b8a99c1b: 20 of 201 Styli images ended "Skipped for Styli: the photo is smaller than Styli
  needs." after step 4 had said they would be made. Every source was 1000 x 1000.
- The planning paths (wizard warning, step 4 count, worker pre-skip, completeness eval) judged only
  the source height against `styliMinSourceHeightPx` (741 px with the x2 upscaler). 1000 px passed.
- The render judged the enlargement the product needs: `minimumFit / 2 > 1.5` skipped. A product cut at
  the photo edge has margin 0 on its cut sides, so it fills the 2342 x 3123 canvas edge to edge and needs
  about 3.1x from a 1000 px photo. That is above 3.0 (1.5 x 2), so the render skipped what the plan made.

## Root cause
Two rules for one decision: a cheap height rule for planning and an exact enlargement rule at render.
They agree for uncut products and disagree for cut ones.

## Fix
The owner decided any enlargement is fine and a product cut at the edge is made. There is no Styli
size rule any more, so plan and render cannot disagree: the render never skips for size, and every
planning path counts every Styli pair. The only size floor is the global one
(`MIN_SOURCE_LONG_SIDE_PX = 500`, flag `small_source`, which holds the photo for a person, never a
skip). A large enlargement still carries the information flag `low_resolution` with the soft note; the
x2 upscaler makes the colour beyond 1.5x and Lanczos3 does the rest.

## Rule for next time
When a plan must predict a render outcome, the plan and the render call the same function. A cheaper
proxy (source height for enlargement) is a second rule that will drift.

Older batches keep their skipped rows; `STYLI_SKIP_NOTE` and `styliSkipText` stay only to show those.
`CHANNEL_RULES_VERSION` is not bumped: no image that was made changes, and the skipped rows were never
live, so the next delivery of those products makes them.
