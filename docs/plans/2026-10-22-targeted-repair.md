# PR 3: repair picks the fix from the failure, per channel

Written 2026-10-22 for the `feat/targeted-repair` branch (worktree `..\catalog-module-wt\89-targeted-repair`).
`docs/SPEC.md`, `docs/specs/07-qa-attention-and-skus.md` section 4.6a and `docs/specs/05-matting-and-render.md` still
apply; this plan changes 07 section 4.6a (the ladder) and nothing else in the specs. Read `CLAUDE.md` and `AGENTS.md`
first; every rule there holds.

## 0. The owner's requirement (authoritative)

Repairs must not be a default list applied blindly. For each output (channel x photo) the system reads what failed
(rule code, measured values, judge flag and evidence) and what the image is, applies the right fix for that failure on
that channel, re-checks, and leaves an image out only when the source is genuinely unfixable, with a plain-language
reason naming the rule (never a raw rule id, never a model id). Fixes happen in the first run of the batch. A fix
applies only to the failing channel; the other channels' images stay unchanged.

## 1. Today, and why it falls short

- `runLadder` (`packages/core/src/catalog/auto-resolve.ts:73-88`) walks one fixed list, shadow off, second matte,
  pass-through (only for `product_removed`), 5% smaller fit, whatever the failure was. A `bytes` failure (file over
  2 MB) gets the same three re-renders as a halo, none of which can shrink a file.
- `resolvePhoto` (`apps/worker/src/catalog/auto-resolve.ts:114-117`) applies the winning step to every channel of the
  photo, including channels that passed. A Styli margin fix re-makes Noon and Amazon too.
- `shadow_off` (`apps/worker/src/catalog/auto-resolve.ts:97`) only turns off a shadow we added
  (`shadow_synthesised`). A shadow kept from the source (`shadowLayer`, `shadow.ts:148-160`) is never a repair
  candidate, though it is the usual cause of `inside_safe_box` on Styli and of the judge's `leftover_background` on
  dark floors.
- The compliance check (`compliance.ts:19-61`) measures the seen product box, the safe box and the anchor error, then
  throws the numbers away: only `"code: sentence"` strings reach `compliance.failures`. A later fix cannot compute
  anything from them.
- The dropped copy (`qa-stage.ts:272`) builds `flagDetails(lead, ctx)` without `ctx.failures`, so a dropped
  `failed_compliance` photo reads "did not meet Noon's rules." and names no rule; the attention card
  (`attention.ts:40`) passes `o.reason`, which holds the raw `"inside_safe_box: ..."` strings.

## 2. Inventory of failure signals

Per output (channel x photo). "Stored" says what lands in `catalog_outputs` today.

| Signal | Where it is found | Measurement available at that point | Stored today |
|---|---|---|---|
| `magic`, `extension`, `trendyol_name`, `format`, `density`, `dims` (compliance) | render, `checkOutput` | the encoder's own settings; a plan/size mismatch | failure string only |
| `bytes` (file over 2 MB after the quality loop 90 to 70) | render | `bytes`, final `quality` | `bytes`, `quality`, failure string |
| `background` (exposed background or margin band the wrong colour) | render | which band/margin pixels differ, whether a shadow layer was drawn and of which kind (kept, synthesised, none) | failure string only |
| `inside_safe_box` (seen product or shadow outside the margins) | render | seen box (x0..x1, y0..y1), safe box, per-side overflow in px, shadow kind, cut sides | failure string only; `placedX/Y`, `scale`, `canvasW/H` |
| `styli_anchor` (Styli: lowest row not on the guide, or not centred) | render, Styli only | exact `dx`, `dy` to the guide, from the same seen+silhouette box the check uses (PR 2 makes placement and check share this definition) | failure string only |
| `noon_wide` (wide shot inside the 5% side margins) | render, Noon only | seen x0/x1 against 5% and 95% of the width | failure string only |
| "No product was found in this photo." (empty matte) | render, status `failed` | matte bbox null | `reason` |
| Styli low-resolution skip | render | `minimumFit` | `reason`, flag `low_resolution`; PR 1 removes the cap, so the skip goes away |
| `cut_in_source` band note (cut side not flush) | render | floating sides, blocked sides | `reason` note |
| `matte_check` failed, `second_matte`, `padded_matte`, `matte_passthrough` passed/failed | matte stage, `resolveMatte` | `checkMatteIntegrity` detail (worst cell loss, overall loss, hand share, background chunk, opaque share), `busyBorderReading` | `compliance.auto_actions[].detail` (technical) |
| busy background hold (`leftover_background` code-detected) | matte stage | reading share, edge density, tones, or pass-through product loss | `auto_actions`, `busyBackgroundHold` |
| `fallback_matte` (service down after one retry) | matte stage | `matte_retry` action | flag, `auto_actions` |
| `chart_image`, corrupt file (`UnsupportedSourceError`) | matte stage | glyph counts; decode error | status `skipped` / `failed`, `reason` |
| `halo` (judge `edge_quality` under the line) | QA stage | score, evidence sentence, judged channel | `qa_scores.evidence`, scores |
| `leftover_background` (judge `background_clean`) | QA stage | score, evidence sentence; the output's shadow kind (new, section 4) | `qa_scores` |
| `product_removed` (judge `product_intact`) | QA stage | score, evidence | `qa_scores` |
| `placement` (judge; code decides placement since the Styli check, evals/attention.ts:133) | QA stage | none | flag |
| `complete_product` / `source_cut` (photo cut at its own frame) | QA stage | `judgedCut` relaxed detector finds a new side or not | flag, `flush_cut` action |
| `different_product`, `collage`, `text_or_watermark`, `orientation`, `chart_image` | QA stage | evidence sentence; `orientation` gives no angle | `qa_scores` |
| `qa_unavailable`, `qa_cap` | QA stage | none (no verdict) | flag, `reason` |

## 3. Failure to repair mapping

Scope: `output` = the failing channel only; `photo` = the shared cut-out (every channel of the photo is re-rendered
and re-checked afterwards, each with its own render-level fixes so far). Re-judge: only when the trigger came from
the judge; at most one per step, at most `MAX_REJUDGES_PER_PHOTO` (3) per photo per run. "Computed" means the fix
takes its numbers from the measurement, not from a guess.

| Signal | Targeted repair (in order) | Scope | Preconditions | Re-judge | Genuinely unfixable: what the operator reads |
|---|---|---|---|---|---|
| `styli_anchor` | `reshift`: re-render with `anchorShift = -measured delta` (computed, exact, clamped inside the canvas; only on axes with no cut side) | output | Styli; the delta is non-zero on a shiftable axis | no | "The product could not be placed on the Styli bottom guide." |
| `inside_safe_box` | 1. if a shadow was drawn: `shadow_off` (synthesised) or `source_shadow_off` (kept); 2. `refit`: fitScale = min(safe.w / seen.w, safe.h / seen.h) x (1 - `REFIT_SLACK` 0.01) (computed), floor `REFIT_MIN_SCALE` 0.6 | output | 1 only when `measured.shadow` is not `none`; 2 whenever the seen box is larger than the safe box | no | "The product reaches into the margins Noon requires and could not be fitted inside them." |
| `noon_wide` | `refit`: fitScale = 0.9 x canvas width / seen width x (1 - slack) (computed) | output | Noon, wide shot, no cut side on that axis | no | "A wide shot needs 5% side margins on Noon and this one could not be fitted inside them." |
| `background` | 1. shadow off (kind-aware, as above); 2. `refit` by the band depth (seen box must clear the border band: computed from `borderBand`) | output | 1 when a shadow was drawn; 2 otherwise | no | "The background around the product is not the exact colour Noon requires." |
| `bytes` | `reencode`: the quality loop continues below 70 down to `JPEG_QUALITY_REPAIR_MIN` 50 (same pixels, smaller file) | output | file over 2 MB at quality 70 | no | "The image could not be saved under 2 MB for Centrepoint." |
| `dims`, `density`, `format`, `magic`, `extension`, `trendyol_name` | `re_render`: one plain re-render with the same inputs (guards a transient encoder fault); these are our encoder's own settings, so a second identical failure is a code fault, not a source problem | output | once | no | "The file format or size is not what Trendyol accepts. The technical team will look at the report." (held, never dropped silently) |
| `halo` (judge) | 1. `second_matte` (policy's second model); 2. nothing else: the product's pixels are never redrawn (R11), so no erosion or edge repaint | photo | second model exists, differs, is served; the source is not transparent | yes, once per step | existing `halo` copy plus the tried sentence: "We tried a second cut-out and could not fix it." |
| `leftover_background` (judge) | 1. shadow off (kind-aware: the dark patch beside a product is most often a kept source shadow or a contact shadow we added); 2. `second_matte` | 1 output (every channel carrying the flag, which is every channel of the photo since output dimensions are shared), 2 photo | 1 when the judged channel's render drew a shadow | yes, once per step | existing copy plus the tried sentence |
| `product_removed` (judge) | 1. `second_matte`; 2. `matte_passthrough` (whole frame kept, matte-guard rules: not on a busy background, not when the backdrop matches the product) | photo | as today (`auto-resolve.ts:98-102`) | yes, once per step | existing copy ("We tried to make it again and could not keep the whole product.") |
| `placement` (judge) | `reshift` by the compliance measurement when the check reports a delta, else `re_render`; both output-scoped | output | flag present | yes, once | existing `placement` copy |
| `complete_product` with a judge-seen cut | `flush_cut` (unchanged) | photo | relaxed detector finds a new side | no | note only, never a hold (unchanged) |
| matte stage: integrity failed | `resolveMatte` ladder (unchanged: second, padded first, padded second, pass-through, hold) | photo | as today | no | busy background: existing hard-hold copy |
| `fallback_matte` | `matte_retry` (unchanged) | photo | time left in the delivery | no | existing copy |
| `orientation`, `text_or_watermark`, `collage`, `different_product`, `chart_image`, `small_source`, `low_resolution`, corrupt | none: the source itself. `orientation` is not auto-rotated: the judge gives no angle, EXIF orientation is already applied in `prepare()`, and a wrong guess would publish a product on its side | - | - | - | existing copy (triage: note, drop or hold) |
| `qa_unavailable`, `qa_cap` | none: there is no verdict to repair against | - | - | - | existing copy |

Bounds per run: at most `MAX_REPAIRS_PER_OUTPUT` (3) re-renders per output from render-level fixes, at most one
matte change per photo per trigger, at most 3 re-judges per photo. A render-level fix on one channel never touches
another channel's bytes, row or flags.

Styli and R11a (one uniform scale across the angles of a product): a `refit` on one Styli angle breaks the shared
scale. Choice taken: allow it and append the renderer's existing note "Could not keep the same size as the other
angles without cutting; fitted instead" (render.ts:560), which the renderer already uses for a detail shot that
cannot keep the uniform scale. The alternative, re-rendering every Styli angle of the product at the new scale, would
touch outputs that passed, which the owner's rule forbids. Recorded as a choice in the PR body.

## 4. Control flow

### 4.1 Diagnosis feeds repair

`packages/core/src/catalog/auto-resolve.ts` gets a pure planner:

```
diagnoseOutput(input: {
  channel; trigger: OutputFlag[];            // failed_compliance and/or the judge's own-defect flags
  failures: string[];                        // compliance codes ("code: sentence")
  measured: Measured | null;                 // compliance.measured (section 4.4)
  shadow: "kept" | "synthesised" | "none";   // what the last render drew
  cut: CutEdges; tried: AutoActionKind[];    // steps already taken for this trigger
  secondMatte: boolean;                      // a second model is available for this photo
}): Repair[]
```

A `Repair` is `{ step: AutoActionKind; scope: "output" | "photo"; variant: RenderVariant; why: string }` where
`RenderVariant` holds exactly the render options the step turns: `synthesiseShadow`, `keepSourceShadow`, `matte`
(`first` | `second` | `passthrough`), `fitScale`, `anchorShift`, `jpegQualityMin`. The planner is a table of the
section 3 rows; it never returns a step already in `tried`, and it returns the repairs for every failure of the output
at once, cheapest first (shift, re-encode, shadow off, refit, then a matte change).

The worker (`apps/worker/src/catalog/auto-resolve.ts` `resolvePhoto`) runs, per photo:

1. For each failing output, keep a per-output `RenderVariant` (starts at the first render's: shadow rule, first
   matte, fit 1).
2. Loop (bounded by `MAX_REPAIRS_PER_OUTPUT`): take the next output-scoped repair the planner gives for that output's
   current failures; merge it into its variant; re-render that channel only; re-run the diagnosis on the new
   result. Stop when the output passes compliance (and, for a judge trigger, when the re-judge passes) or when the
   planner has nothing left.
3. When a failing output's next repair is photo-scoped (a matte change), make the matte once, then re-render every
   channel of the photo with that matte and each channel's own current variant, re-diagnose each, and continue the
   per-output loop for any that still fail. Channels that pass keep the new image (the cut-out changed under them:
   the owner's "re-check rather than assume"). A channel the new matte breaks and that no render-level fix repairs
   keeps its first image and a `failed` record saying so.
4. Re-judge: only for judge triggers; once per photo-scoped step and once after the last output-scoped fix, on the
   strictest failing channel (as today, `strictestChannel`). The verdict applies to every channel of the photo, as
   the first judging did.
5. Write: every re-made output gets its new bytes, plan, flags, `compliance` (with `measured`) and the appended
   `auto_actions`. Outputs that were not re-made get only the `auto_actions` record (so the report shows what was
   tried and why they were left alone). A winning second or pass-through matte becomes the photo's stored matte
   (unchanged, `auto-resolve.ts:119-128`).

### 4.2 Per-channel isolation

- Render-only steps (`shadow_off`, `source_shadow_off`, `refit`, `reshift`, `reencode`, `re_render`) carry
  `channels: [that channel]` in the record and touch that row only.
- Matte steps carry every channel of the photo in `channels` and the record says per channel whether it kept the
  new image, was fixed further, or kept its first image.
- The `apply` record disappears; its meaning ("the winner on every channel") no longer exists.

### 4.3 Bounded attempts and cost

- Render-level fixes cost CPU only. Bound: 3 per output per run; in practice one (the computed fix) or two (shadow
  off then refit).
- Re-judges are LLM calls: at most one per step, at most 3 per photo per run; the judge caps apply to every re-judge
  (`stopOn`, `CatalogQaCapError`), and a cap ends the loop with the photo keeping its flags, as today.
- A second matte is one matting call per photo, as today.

### 4.4 Storing the measurement

`checkOutput` returns `{ ok, failures, measured }` with
`measured = { canvas: {w,h}, safe: BBox, seen: BBox | null, outside: {top,bottom,left,right} (px past the safe box, 0 when inside), anchorDelta: {dx,dy} | null (Styli), bandBreach: boolean, bytes, quality }`.
`renderSource` adds `shadow: "kept" | "synthesised" | "none"` and `cut` to it. The whole object goes into the
existing `compliance` jsonb column next to `ok`, `failures` and `auto_actions` (no schema change). The report
(`report.ts:165` `autoActions`) already serialises `compliance.auto_actions`; the technical detail of each repair goes
into `detail` ("styli_anchor: dy -7, dx +2 -> reshift"). Operators never see `detail` or `measured`.

### 4.5 Photo 1 holds the whole product

Unchanged: `publish.ts:105-109` holds the product while any output is not staged/skipped/verified, and triage holds
photo 1 with a problem (`triage.ts:80`). The repair loop runs before triage in both stages, so photo 1 gets every
targeted fix first; what reaches triage is only what the loop could not fix.

### 4.6 Idempotency and retries in chunk processing

- Render stage: `chunk.ts:262` already skips a photo whose outputs carry an action with trigger `failed_compliance`;
  a redelivered chunk does not repair twice. Kept.
- QA stage: `qa-stage.ts:219` filters the same way on the judge triggers. Kept.
- A delivery killed mid-loop leaves rows with the new bytes or the old, each consistent with its own record, because
  every write is one `underClaim` transaction per output (as today). The next delivery sees the action records and
  does not repeat them.

### 4.7 Operator copy

- `qa/reasons.ts` gets `plainFailures(failures, channelLabel)`: one plain sentence per compliance code (section 3's
  last column) and `triedSentence(actions)`: "We tried: shadow removed, a smaller fit." from the steps taken, in
  plain words (`STEP_WORDS`: `shadow_off` "shadow removed", `source_shadow_off` "the photo's shadow removed", `refit`
  "a smaller fit", `reshift` "moved onto the guide", `reencode` "saved smaller", `second_matte` "a second cut-out",
  `matte_passthrough` "the whole photo kept", `re_render` "made again").
- `flagDetails("failed_compliance", {failures})` is called with `failures = plainFailures(...)` from `applyTriage`
  (`qa-stage.ts:272`) and from `attention.ts:40` (instead of `o.reason`). The raw `"code: sentence"` strings stay in
  `compliance.failures` for the report and leave `reason`.
- The dropped and held copy for our own defects ends with the tried sentence when any repair ran.
- No rule ids, no model ids: `MODEL_TEXT` in qa-stage.ts already filters judge sentences; the new sentences are
  constants.

## 5. File-by-file change list

Core (`packages/core/src/catalog/`):
- `compliance.ts:18-61`: return `measured` (section 4.4); `anchorDelta` computed from the same `px0..py1` box the
  `styli_anchor` rule uses (lines 54-57); `outside` from the seen box against `safe`; `bandBreach` from the band loop.
- `render.ts:17-21` `RenderInput`: add `keepSourceShadow?: boolean` (false skips `preservedDarkness`, the kept shadow),
  `anchorShift?: {dx, dy}` (added after `visibleAnchorShift`, line 593-596, clamped), `jpegQualityMin?: number`
  (the quality loop at 607-612 runs down to it). `RenderOutput.compliance` carries `measured` with `shadow` and `cut`.
  `shadowLayer` call (599): pass `keepSourceShadow`; report `shadow` kind from its flags.
- `auto-resolve.ts`: replace `LADDER_STEPS`, `stepApplies`, `stepVariant`, `runLadder` with `diagnoseOutput`,
  `RenderVariant`, `Repair`, `STEP_WORDS`, `MAX_REPAIRS_PER_OUTPUT`, `MAX_REJUDGES_PER_PHOTO`, `REFIT_SLACK`,
  `REFIT_MIN_SCALE`, `JPEG_QUALITY_REPAIR_MIN`. `AutoActionKind` gains `source_shadow_off`, `refit`, `reshift`,
  `reencode`, `re_render`; `apply` stays in the type for old rows. `LadderStopped`, `AutoAction`, `autoActionsOf`,
  `withAutoActions`, `busyBackgroundHold`, `judgeSawSourceCut`, `ownDefects`, the flag sets: unchanged.
- `qa/reasons.ts`: `plainFailures`, `triedSentence`, `STEP_WORDS`.
- `channels.ts`: `CHANNEL_RULES_VERSION` unchanged (the first render's bytes do not change; only repaired outputs do).

Worker (`apps/worker/src/catalog/`):
- `auto-resolve.ts:56-137` `resolvePhoto`: the loop of section 4.1 (reuse `storedMatte`, `secondMatte`,
  `passthroughFor`, `render`, `writeRender`, `recordActions`, `ok`, `codes`). `flushCutPhoto`, `stopOn`: unchanged.
- `chunk.ts:258-271`: unchanged call; the comment changes.
- `qa-stage.ts:188-241` `repairOwnDefects`: unchanged except the comment; `applyTriage` (272): `failures:
  plainFailures(...)` in `ctx`, tried sentence appended for own defects.
- `packages/core/src/catalog/attention.ts:40`: `failures: plainFailures(...)`.

Docs: `docs/specs/07-qa-attention-and-skus.md` 4.6a rewritten (diagnosis, per channel, bounds, copy);
`docs/SPEC.md` decisions log entry.

### Test plan (unit, mocked judge, no live OpenRouter)
- `compliance.test.ts` (new, core): a Styli render 7 px above the guide reports `anchorDelta {dx:0, dy:7}` and
  `styli_anchor`; a product over the Noon margin reports `outside.right > 0`; a 2.1 MB JPEG reports `bytes`.
- `auto-resolve.test.ts` (core, new cases): the planner maps each code to its step, respects `tried`, orders
  cheapest first, never repeats, and returns nothing for `dims` after one `re_render`.
- `apps/worker/src/catalog/auto-resolve.test.ts` (existing world: real render, mocked judge and cut-outs):
  - the leftover-background shadow case ends with `shadow_off:passed` on `noon` only (no `apply`);
  - the halo case ends with `second_matte:passed` with `channels: [amazon, noon]`, both re-checked;
  - the checker (ringing past the margin) case ends with `refit:passed` on the failing channel, with the computed
    scale under 1 and no judge call before the first judging;
  - new: two channels, one failing `inside_safe_box` on Styli only: Noon's row (`bytes`, `crc32c`, `updatedAt`
    bytes identical) is untouched, Styli is repaired;
  - new: a Styli output 1 row above the guide (forced through a test-only `anchorShift` on the first render) is
    repaired by `reshift` with the exact delta;
  - new: a dropped `failed_compliance` photo's `reason` names the rule in plain words and no code.
- `pnpm typecheck`, `pnpm test`, `pnpm lint`.

### Migration, rollout, risks
- No schema change; `compliance.measured` is additive. Old rows without it diagnose from `failures` codes only
  (no computed fix, the planner falls back to `refit` with the old 0.95).
- Rollout: deploy with main; no env change. The report's `autoActions` gain new step names; the evals that read
  `auto_actions` (`evals/attention.ts`) key on flags, not steps.
- Risks: a computed `refit` that over-shrinks (bounded by `REFIT_MIN_SCALE` and the slack); a `reshift` fighting
  PR 2's shared definition (both read the same box, so the delta is zero after PR 2 and the step is a safety net);
  `source_shadow_off` changes the look of a channel against its siblings (recorded in `detail`; the alternative,
  a held product, is worse by the owner's rule).

## 6. Choices taken (the owner may overrule)

1. Styli refit on one angle: allowed, with the existing uniform-scale note, instead of re-making the passing angles.
2. `orientation` is never auto-rotated (no angle from the judge; EXIF already applied).
3. `halo` gets one repair (the second cut-out) and no edge erosion, because R11 forbids removing product pixels.
4. Encoder-setting failures (`dims`, `format`, ...) are held for the technical team after one re-render, never
   dropped, because a drop would hide a code fault.
