# 11 Image enhancement

Catalog module, spec 11. Execute with `docs/specs/00-execution-protocol.md`. Source of truth:
`docs/SPEC.md` (channel table, image policy, models table, non-goals, decisions log). Depends on 05
(render, matting client, the GPU service), 06 (chunk stage, `render_key`, sheet notes), 07 (triage,
information flags, the banned-names test), 10 (the eval job, golden set, report). Branch
`feat/catalog-11-image-enhancement`. Deploys `catalog-matting-gpu`, `catalog-worker` and the deploy
env. Approved by the owner on 2026-10-20 16:40 UTC ("go with the best option, try it out, test it,
see which is best"); the approved scope is `docs/plans/2026-10-20-go-live-resume-3.md` step 8, items
a to e, restated here as workstreams A to E. Research: the bucket folder
`catalog-test/handoff/2026-10-20/evidence/session3/investigations/` (`image-enhancement.md`,
`enhancement-cost.md`).

## 1. Purpose

Most brand photos arrive at 800x1200 (Penti, Vero Moda, French Connection) or 800x800 (Anta). The
exact-size channels enlarge them past the 1.5x cap: Trendyol 1200x1800 needs 1.5x to 2.2x on 58 of 62
measured portrait photos (median 1.53x), Centrepoint 3000x3000 needs 2.5x or more on every photo. Today
the render enlarges with Lanczos3 alone, with no sharpening, and the review text for Trendyol says
"Trendyol wants at least 1800 px", which is false (Trendyol's minimum is 600x800; 1200x1800 is the
size we deliver). This spec, in order: (A) a conservative unsharp mask after any enlargement and
truthful copy, (B) a `/upscale` endpoint on the existing GPU service, (C) the render calling it behind
a flag when the enlargement exceeds the cap, (D) a fidelity gate that picks the upscaler, or none, by
numbers, and (E) the rollout. Nothing here regenerates product pixels: an upscaler is a deterministic
resampler that is measured against the original before it is allowed to run, and a Lanczos fallback
always exists.

Plain-language terms. Unsharp mask: a classical sharpening that raises contrast along edges that
already exist; it adds no detail. Upscaler: a model that enlarges a photo by a fixed factor (x2 here)
and is judged on how close its result stays to a real larger photo. Fidelity gate: shrink a large
photo, enlarge it back, compare with the original; the candidate must beat the classical method.

## 2. What the operator sees

Nothing new. No control, no setting, no model name anywhere. An enlarged output carries the
information note "Enlarged with a quality pass to meet this marketplace's size." in the sheet
`notes` column ("<Channel> img <n>: <sentence>", 06), the report and the product page; it never holds
a product and never creates an attention card on its own. The `low_resolution` sentences become
truthful (section 4.1). The spec 07 banned-names test keeps passing: no "esrgan", "swinir" or model id
in any page, toast, note, sheet, export or API response to the operator.

## 3. Scope

In scope: `packages/core/src/catalog/render.ts` (sharpening, the upscale branch), a new
`packages/core/src/catalog/upscale.ts` (client, constants), `channels.ts` (`CHANNEL_RULES_VERSION`),
`qa/reasons.ts`, `types.ts`, `qa/triage.ts` and `evals/attention.ts` (the flag sentence and lists),
`apps/worker/src/catalog/chunk.ts` and `deps.ts` (the env, the render key), `services/matting/app.py`
and its Dockerfile, requirements and README (`/upscale`, `/health`, the two ONNX models), the spec 10
job (`enhancement` check set), `infra/deploy.sh` (env pass-through, the smoke assertion), docs.

Out of scope: any change to `MAX_UPSCALE`, `STYLI_MIN_SOURCE_HEIGHT_PX` or the Styli skip (an OPEN
owner decision, section 10); x4 models; restoration models (denoise, deblur); any hosted or paid
image API (section 10); the judge prompt.

## 4. Contracts

### 4.1 Workstream A: sharpening after enlargement (`render.ts`, `channels.ts`, sentences)

- After any enlargement in the render (`plan.scale > 1` on either axis), apply a sharp unsharp mask to
  the RGB (not the alpha) with conservative parameters (sigma about 0.8 to 1.0, amount scaled with the
  enlargement, threshold small) so that it never invents detail; no sharpening at scale <= 1.
  Realisation: the cut-out is resized as RGBA with lanczos3 as today (step 6 of 05); the RGB planes are
  then sharpened with `sharp.sharpen({ sigma, m1, m2, x1, y2, y3 })` (sigma set means the accurate
  unsharp mask on the LAB L channel, so colours are not touched; `y2` and `y3` cap brightening and
  darkening so halos stay bounded) and re-joined with the untouched alpha plane. Builder constants in
  `upscale.ts`: `SHARPEN_SIGMA` (start 0.9), `SHARPEN_AMOUNT_PER_X` (the `m2` added per 1.0 of
  enlargement above 1, start 0.6, so 1.5x gives about 0.3 and 2.5x about 0.9; `m1` 0.2 flat,
  `x1` 2, `y2` 6, `y3` 10). The factor that drives the amount is the Lanczos factor actually applied
  to the RGB: `plan.scale` without an upscaler, `plan.scale / 2` after the x2 pass of workstream C; no
  sharpening when that factor is <= 1.
- The review text "Trendyol wants at least 1800 px" is replaced by truthful copy in all three places
  (`render.ts` `attention.why`, `qa/reasons.ts`, `types.ts` `REASONS.low_resolution`): on a fixed
  canvas (Trendyol, Centrepoint) `why = "The original is <w> x <h>. <Channel> images are delivered at
  <W> x <H>, so this one was enlarged and may look soft."` with the canvas size; on an adaptive canvas
  the existing sentence stays, `<min>` being the channel's listed minimum (Trendyol's minimum is
  600x800; we deliver 1200x1800). `what` is unchanged.
- `CHANNEL_RULES_VERSION` bumped from `"7"` to `"8"` (sharpening changes output bytes).
- Spec 10 evals stay green: `pixels_copied` (mean per-channel difference <= 8, at most 1% of pixels
  over 48) is measured against the source resampled to the product box, and a conservative mask stays
  inside it; the builder proves it in tier 1 on the suite's synthetic products and the manager
  confirms it on the gate set (section 6).

### 4.2 Workstream B: upscaler service (`services/matting/app.py`, GPU image)

- `POST /upscale?model=<id>&scale=2` on the matting service (same FastAPI app as `/matte`,
  `services/matting/app.py`, deployed as `catalog-matting-gpu`; the CPU service answers 503 for it).
  Request body: raw image bytes (image/jpeg or image/png), like `/matte` (the multipart field `file`,
  as `/matte` reads it today). Response: 200 `image/jpeg` (quality 95, 4:4:4), the RGB image enlarged
  by exactly `scale` (2), headers `X-Upscale-Model` and `X-Upscale-Ms`. Errors: 400 bad image or
  unknown model (JSON `{error}`), 503 JSON `{error}` when the model is unavailable, 413 over 40 MB.
  `scale` other than 2 is 400.
- `GET /health` adds `"upscale": { "models": [ {id, available, scale} ], "default": "<id or null>" }`
  (the CPU service lists `models: []`, `default: null`).
- Model ids: `"realesrgan-x2plus"` (Real-ESRGAN x2plus as ONNX on the existing onnxruntime-gpu,
  BSD-3) and `"swinir-x2"` (SwinIR lightweight x2, ONNX, Apache-2.0) as the alternative for the
  fidelity gate. Env `UPSCALE_MODELS` default `realesrgan-x2plus,swinir-x2`, `DEFAULT_UPSCALE_MODEL`
  default `realesrgan-x2plus`; both ignored on the CPU target.
- Models load lazily on first request and stay resident (a separate session from the single resident
  matte session; the builder measures that both fit the 16 GiB and the CUDA arena, as 05 did for model
  switching); deterministic output (fixed shapes padded to a multiple of 8, `cudnn_conv_algo_search`
  HEURISTIC, no stochastic op; the same bytes in give the same bytes out, asserted in tier 1 and in the
  gate). Inference under `INFERENCE_LOCK` like `/matte`. Inputs over `UPSCALE_TILE_PX` (builder
  constant, start 1024 on the long side) are tiled with a 16 px overlap and blended, so a 2048 px source
  does not exhaust memory; the gate's halo and texture checks catch a visible seam.
- Alpha is never sent to the service: the worker sends RGB only; a PNG with alpha is converted to RGB
  on receipt.
- ONNX exports are baked into the GPU image under `/models/upscale/<id>.onnx` (no downloads at run
  time, as for the matte models); the export script, the source weights' URLs, their sha256 and the
  licences are recorded in `services/matting/README.md`. `UPSCALE_MODEL_VERSIONS` in `upscale.ts`
  (core) maps each id to the first 8 hex of its ONNX sha256; it is the "version" of section 4.3 and
  is bumped whenever an export changes.
- No logging of image bytes; errors carry no inference internals (as `/matte`).

### 4.3 Workstream C: render integration (`upscale.ts`, `render.ts`, `chunk.ts`, `deps.ts`)

- Worker env `UPSCALE_MODEL` (model id; unset = off, the default) and `UPSCALE_MIN_SCALE` (default
  1.5). When a photo must be enlarged by more than `UPSCALE_MIN_SCALE` on a channel (today only the
  exact-size channels such as Trendyol 1200x1800 from 800x1200 sources; variable-size canvases are
  capped at 1.5x so they never trigger it, except the case where even the minimum canvas needs more,
  which already carries `low_resolution` and follows the same rule), the render upscales the RGB
  through `/upscale` on the GPU service (x2, then Lanczos to the final size), the alpha with Lanczos,
  then sharpening (4.1, amount from `plan.scale / 2`); output carries the information flag `upscaled`
  (never a hold); `render_key` includes the upscaler id and version so re-renders stay identical; any
  failure, timeout or 503 falls back to Lanczos + sharpening with a logged warning and no flag; the
  sheet note sentence for `upscaled` is model-free ("Enlarged with a quality pass to meet this
  marketplace's size.").
- Once per photo, not per channel: `renderAllChannels` asks for the x2 RGB of the whole source
  (`prepared.rgb` as PNG, orientation already applied, never the alpha) only when at least one selected
  channel's plan needs it, and reuses it for every channel of that photo. The cut-out is then
  `extract`ed from the x2 image at doubled `sourceCrop` coordinates and resized to `product.w x
  product.h` with lanczos3; the alpha is cut from `matte.alpha` and resized with lanczos3 as today;
  the two are joined before compositing. Everything after (shadow, composite, encode, compliance) is
  unchanged. A `passthrough` output is never upscaled.

```ts
// packages/core/src/catalog/upscale.ts
export const UPSCALE_MODEL = process.env.UPSCALE_MODEL || null;            // unset = off
export const UPSCALE_MIN_SCALE = Number(process.env.UPSCALE_MIN_SCALE ?? 1.5);
export const UPSCALE_TIMEOUT_MS = Number(process.env.UPSCALE_TIMEOUT_MS ?? 60_000);
export const UPSCALE_MODEL_VERSIONS: Record<string, string>;              // id -> first 8 hex of the ONNX sha256
export interface Upscaled { rgb: Buffer; width: number; height: number; model: string; version: string; ms: number }
export interface UpscaleClient { upscale(rgb: Buffer, width: number, height: number): Promise<Upscaled | null> }  // null = fall back
export function needsUpscale(plan: CanvasPlan): boolean;                   // plan.scale > UPSCALE_MIN_SCALE and not a passthrough
export function upscalerKey(): string;                                     // "" when off, else `|up:<id>@<version>`
```

- `MattingClient` gains `upscale(rgb, width, height, model)`: picks the service whose `/health`
  `upscale.models` lists the model as `available` (the GPU service), posts the PNG, returns the decoded
  RGB of the JPEG response with the headers; a transport error, 5xx, 503, timeout (`UPSCALE_TIMEOUT_MS`)
  or an unlisted model returns `null` and logs `{ event: "upscale_fallback", batchId, model, reason }`.
  Upscale failures never count towards the matting breakers; a separate counter skips the upscaler
  for `BREAKER_COOLDOWN_MS` after `BREAKER_FAILURES` consecutive failures (so a dead GPU service does
  not add a timeout to every photo), closed again on the next success. `MATTING_GPU_URL` unset, or
  `UPSCALE_MODEL` unset, means `needsUpscale` is never consulted and the client is not called.
- `render_key` (06, `pipeline/publish.ts` `renderKey`): `policyKey` becomes
  `default|<matteModel><upscalerKey()>`, so it is unchanged while the flag is off (live outputs stay
  `unchanged` at zero cost) and changes exactly once when the upscaler is turned on or its export
  changes. `renderKeyInputs` (05) is unchanged in shape.
- Flags and sentences: `upscaled` moves from the attention list to the information lists in
  `qa/triage.ts` `INFORMATION_FLAGS`, `evals/attention.ts` `INFORMATION_FLAGS` and spec 07's list;
  `types.ts` `REASONS.upscaled` and `qa/reasons.ts` become the one sentence above (no "what to do"
  sentence: nothing to do). `RenderOutput` gains the compatible optional field
  `upscale: { model: string; version: string; ms: number } | null` for the report and the eval job;
  `catalog-local render` prints it in `report.json` (`outputs[].upscale`) and the summary
  `upscaledCount` and `msUpscaleAvg`. Model ids stay in logs, `report.json` and the eval report only.

### 4.4 Workstream D: fidelity gate (the spec 10 check set `enhancement`)

A new `CheckGroup` `enhancement` in `packages/core/src/catalog/evals/` (`enhancement.ts`), run by the
spec 10 job as `node apps/worker/dist/catalog-output-evals.js enhancement [--candidates
realesrgan-x2plus,swinir-x2] [--limit <photos>] [--resume <run>]` and `bash
infra/catalog-output-evals.sh enhancement`. It writes `catalog-test/evals/<run>/enhancement/report.json`,
`report.html` (every photo: original crop, the three restorations, the numbers) and the summary line
`Enhancement gate: <candidate> passes N of N photos (winner: <id or none>)`; exit 1 when no candidate
passes. Model ids appear in the JSON and HTML report and the job log only.

- Set: golden photos of 1,600 px or more on the longer side, pinned by sha256 in `golden-manifest.json`
  (tag `px1600`); when the pinned set holds fewer than 40 such photos, `build-golden` draws more from
  the owner's folders with `minLongSide: 1600` in `golden-build.json` (read only; uploaded under
  `catalog-test/evals/golden/enhancement/sources/`). Target 60 photos across footwear, apparel on a
  model, flat lays, bags and hardline, with at least 15 carrying a logo or label text
  (`detailFeatures`, 05) and 15 with visible fabric texture (knit, denim, lace: `wide_product` or
  `apparel_*` tags).
- Procedure per photo: matte the original through the pipeline's `matteFor` (the product area is
  alpha >= 128, eroded 2 px for the colour and texture checks; the 3 px ring outside it is the edge
  band); shrink the RGB 2x with Lanczos3; restore to the original size with (1) Lanczos3 + the
  sharpening of 4.1 at 2x, (2) `realesrgan-x2plus` and (3) `swinir-x2` through the deployed
  `/upscale` (`MATTING_GPU_URL`), each exactly as the render would (x2, no residual Lanczos); compare
  each with the original on the product area.
- Checks (per candidate, per photo; the set passes when every photo passes):

| Check | Measured on the product area | Bar |
|---|---|---|
| `enhancement.ssim` | SSIM (8x8 windows, luma) of the candidate against the original | greater than (1) on the photo, and the candidate's mean over the set greater than (1)'s; a photo where it is lower by more than 0.02 fails |
| `enhancement.lpips` | LPIPS (AlexNet-linear, the official `lpips` weights as ONNX, BSD-2) through `POST /measure/lpips` on the matting service (multipart `a`, `b`; JSON `{ "lpips": <float> }`; CPU target allowed) | lower than (1) on the photo and on the set mean; a photo where it is higher by more than 0.03 fails |
| `enhancement.ciede2000` | mean CIEDE2000 between candidate and original, sRGB to Lab D65 | under 2 on every photo |
| `enhancement.text` | for each `detailFeatures` region of the original (logo, text, buckle; the region dilated 4 px): crop diff (mean absolute difference <= 6 levels, local SSIM >= 0.90) and OCR (tesseract.js, Apache-2.0, when the original's OCR confidence is 60 or more) string equal after whitespace normalisation | no region changed; not run when the photo has no region |
| `enhancement.texture` | local variance ratio candidate / original of the Laplacian energy over 16 px cells inside the eroded product, cells with original energy over a noise floor | median within 0.8 to 1.25 (no flattened or invented texture), at most 5% of cells outside 0.5 to 2.0 |
| `enhancement.halo` | in the 3 px ring at the cut-out edge: mean absolute difference to the original <= 8 and no overshoot above 24 levels in regions of 12 px or more; also the output of the real render on Trendyol from the shrunk photo, measured by spec 10 `cutout.halo` and `geometry.pixels_copied` | both pass |
| `enhancement.deterministic` | the same request sent twice | identical bytes |
| `enhancement.ops` (set level, information) | p50 and p95 seconds per photo on the L4 (`X-Upscale-Ms`), cold start (first call after the service scaled to zero), error rate over the run, the real share of photos that need it at `UPSCALE_MIN_SCALE` over the whole golden set and the selected channel sets (P1: Noon, Namshi, Trendyol, Amazon), the cost per product at those numbers (section 7) | recorded; error rate over 1% fails the candidate |

- Winner picked by these numbers: every check passes; among passers the lower LPIPS set mean, then
  the higher SSIM set mean, then the lower p50. If none passes, the flag stays off and Topaz Precision
  (closed source, non-generative, about USD 470 per 1,000 products, photos leave GCP) is only tested
  after the owner confirms that trade (section 10).
- The judge question "are logos, text and fabric texture unchanged from the original" (08, 10) is
  asked on the winner's Trendyol outputs of the set in the `run --live` of the next eval run, as
  information.

### 4.5 Workstream E: rollout

- Enable the winner through the deploy env for every channel whose target size needs it (automatic per
  selected channel, nothing for the operator to do): `infra/deploy.sh` passes `UPSCALE_MODEL` and
  `UPSCALE_MIN_SCALE` to the worker when `UPSCALE_MODEL` is set in the deploy environment and the GPU
  service deployed (`MATTING_GPU_URL` set); it prints `UPSCALE_MODEL=<id or off>` with the URLs. No
  per-channel switch exists: the scale rule decides, so Trendyol and Centrepoint take it on 800 px
  sources, Noon and Namshi never do.
- Gate batches re-run (resume 3 step 2, the four `-qg` batches on the live build); visual inspection
  of every upscaled output (contact sheet of every output carrying `upscaled`, read by a person, listed
  in PROGRESS.md with any doubt named, not hidden).
- Cost per product and per 1,000 recorded in PROGRESS.md (baseline USD 0.0049; Real-ESRGAN estimate
  +USD 0.0022) from the gate's measured seconds, the measured share of photos and the Cloud Run Tier 2
  unit prices in `enhancement-cost.md`; the hand-over note gets one operator sentence (the note's words
  of section 2, nothing technical).

### 4.6 Env vars (added rows to the 02 table)

| Name | Default | Used by |
|---|---|---|
| `UPSCALE_MODEL` | unset (off) | worker, catalog-local, deploy.sh pass-through |
| `UPSCALE_MIN_SCALE` | `1.5` | worker, catalog-local |
| `UPSCALE_TIMEOUT_MS` | `60000` | worker |
| `UPSCALE_MODELS` | `realesrgan-x2plus,swinir-x2` | matting (gpu target only) |
| `DEFAULT_UPSCALE_MODEL` | `realesrgan-x2plus` | matting (gpu target only) |

## 5. Workstreams and build order

| Workstream | Worktree | Files | Depends on |
|---|---|---|---|
| A sharpening | `catalog-module-wt/11-image-enhancement-a-sharpen` | `render.ts`, `upscale.ts` (constants only), `channels.ts`, `qa/reasons.ts`, `types.ts`, their tests | nothing; ships as its own small PR first (resume 3 step 8a), deployed, gate case: the Penti and Vero Moda 800x1200 sources on Trendyol |
| B upscaler service | `catalog-module-wt/11-image-enhancement-b-service` | `services/matting/**` (app, Dockerfile gpu target, requirements-gpu, README, tests, export script), `cloudbuild.yaml` if needed | nothing |
| C render integration | `catalog-module-wt/11-image-enhancement-c-render` | `upscale.ts`, `matte.ts` (`upscale` method), `render.ts` (the branch), `chunk.ts`, `deps.ts`, `pipeline/publish.ts` callers, `qa/triage.ts`, `evals/attention.ts`, `catalog-local.ts`, tests | A merged; B's contract (fake server in tests) |
| D fidelity gate | `catalog-module-wt/11-image-enhancement-d-gate` (Fable) | `evals/enhancement.ts`, `evals/golden.ts` (`px1600`, `minLongSide`), `catalog-output-evals.ts` (`enhancement` command), `infra/catalog-output-evals.sh`, `services/matting` `/measure/lpips` | B deployed for the run; builds against B's contract |
| E rollout | manager, from the main checkout | `infra/deploy.sh`, PROGRESS.md, hand-over note, SPEC.md decision | D's winner |

Builders follow the 00 section 4 brief. Before using sharp's `sharpen`, onnxruntime-gpu's CUDA
execution provider options, the Real-ESRGAN and SwinIR export paths, `lpips` or tesseract.js, the
builder fetches the current docs through Context7 and follows them. Integration merges A, B, C, D on
the feature branch; the review subagent runs `/code-review` and `ce-simplify-code`.

## 6. Tests per tier

Tier 1 (`pnpm test`, vitest; Python `pytest` in `services/matting/tests`):
- A: sharpened output differs from plain Lanczos only at scale > 1 (a synthetic product rendered on
  Trendyol from a 400x600 source differs; the same on Noon at scale < 1 is byte-identical to the
  pre-change render); byte-identical at scale <= 1 (a 1200x1800 source on Trendyol, scale 1);
  no change to alpha (the cut-out's alpha plane before and after sharpening equal byte for byte);
  bounded difference (no halo wider than 2 px at a hard edge on a synthetic test image: a black square
  on white enlarged 2x, the overshoot above 24 levels extends at most 2 px from the edge);
  `renderKeyInputs` changes with the bumped `CHANNEL_RULES_VERSION`; the truthful `low_resolution`
  sentences for Trendyol (fixed) and Noon (adaptive) with the right numbers in all three places; the
  spec 10 synthetic products still pass every image check (`image-checks.test.ts`).
- B (pytest): `/health` on the gpu target lists both upscale models with `available` and `scale: 2`
  and the default; on the cpu target `models: []`, `default: null` and `/upscale` 503; `/upscale`
  on a synthetic 64x96 PNG returns a 128x192 JPEG with both headers (the ONNX session mocked by a
  fake that doubles with nearest neighbour, so the test needs no GPU); unknown model 400; `scale=3`
  400; non-image 400; over 40 MB 413; a PNG with alpha is accepted and the response has no alpha;
  two identical requests give identical bytes; `/matte` behaviour unchanged (existing tests).
- C: `needsUpscale` true at 1.51 and false at 1.5 and for a passthrough; the render with a fake
  `UpscaleClient` (nearest-neighbour x2) on Trendyol from an 800x1200 synthetic: flag `upscaled`,
  `upscale.model` set, the alpha plane equal to the Lanczos-only render's alpha, compliance ok, the
  spec 10 checks pass; the client called once for a photo rendered on three channels; a client that
  returns `null`, throws, or times out: no flag, a warning logged, bytes equal to the Lanczos +
  sharpening render; `UPSCALE_MODEL` unset: the client is never called; `renderKey` equal with the flag
  off before and after this spec, different with it on, different again with another version;
  `upscaled` is in both `INFORMATION_FLAGS` sets and `holdsAtRender` is false for it; the sentence is
  the one of section 2; the spec 07 banned-names test (`apps/web/test/no-model-names.test.ts` and the
  page tests) passes with the new sentence and the new env names in the source tree.
- D: every `enhancement.*` check passes on a synthetic photo restored with an identity fake and fails
  on a planted defect (a shifted logo crop, a recoloured product, a flattened texture, a ring of
  overshoot at the edge, a second call returning different bytes); the LPIPS and OCR calls are fakes
  in tier 1; `build-golden` tags `px1600` and honours `minLongSide`; the report summary line and exit
  code.

Tier 2: the chunk stage with PGlite and a fake matting service that serves `/health` with the upscale
block: outputs of a photo that needs it carry `upscaled` and the note; `render_key` of an unchanged
photo is unchanged after a re-delivery with the same flag; the sheet `notes` column carries the
sentence once per channel and photo.

Tier 3: `REAL_DATA=1 pnpm test:real` on the render path with the local CPU container (no upscaler: the
fallback path) is unchanged and must stay green; the GPU endpoint is exercised by tier 4.

Tier 4 (the gate re-run): `bash infra/catalog-output-evals.sh enhancement` against the deployed GPU
service (the deliverable of workstream D), then the four gate batches of resume 3 step 2 through the
browser test with the winner enabled, plus the spec 10 `run --sets` of the affected sets (anta.footwear,
french_connection.apparel_model) which must stay green.

Tier 5 (inside `infra/deploy.sh`): the per-brand smoke, with `UPSCALE_MODEL` set, additionally asserts
that the Trendyol output of a smoke product whose source needs the enlargement carries `upscaled` with
the exact sentence in its note, that the second pass reports the untouched products `unchanged` (same
`render_key`), and that no model id appears in the sheet or the report; with the flag unset it asserts
no output carries `upscaled`.

## 7. Deploy

Yes: the `matting-gpu` image (B), the worker image (A, C, D) and `infra/deploy.sh` (E). Order: A's
PR merges and deploys first (its own smoke); then B, C, D merge as this spec's PR and deploy with the
flag OFF; then the gate runs (tier 4); then, when a candidate wins, the manager sets `UPSCALE_MODEL`
in the deploy environment and re-runs `bash infra/deploy.sh` (`SKIP_BUILD=1` is fine: only env
changes). Cloud Run shapes are unchanged (min-instances 0, one L4, concurrency 1, max 3); the upscaler
runs in the same instance as matting, so no new idle tail and no new quota. Cost rows: the measured
GPU seconds per photo x USD 0.00034884 per second plus the cross-region JPEG transfer (about 1.2 MB
per photo at USD 0.08 per GiB), against the baseline USD 0.0049 per product.

## 8. Report

The 00 section 10 report, plus: the gate table (per candidate: pass count, SSIM and LPIPS means
against the baseline, CIEDE2000 max, text regions checked, texture median, halo, determinism, p50,
p95, cold start, error rate, share of photos), the winner or "none passes, flag stays off", the
measured cost per product and per 1,000, the before and after of the Trendyol copy, the contact sheet
path of the visual inspection, the bump of `CHANNEL_RULES_VERSION`, and the OPEN owner question of
section 10 asked in the status. Ends with "Ready for the next spec" or, if the programme's step list
has no further spec, "Programme complete; no next spec."

## 9. Assumptions (stated, not asked)

1. "Raw image bytes, like /matte" means the image file as uploaded in the multipart field `file`, the
   way `app.py` reads `/matte` today; it does not mean raw pixel planes.
2. The "version" in `render_key` is the ONNX export's sha256 prefix (`UPSCALE_MODEL_VERSIONS`), not
   the service's `GIT_SHA`: a redeploy without a weight change must not re-render every live output.
3. The upscale runs once per photo on the whole source RGB and is shared by every channel of that
   photo; the per-channel cut and Lanczos happen on the x2 image. The research's cost model assumed
   exactly this (one call per photo, JPEG return, alpha on the worker).
4. An adaptive canvas pinned to its minimum (`low_resolution`, for example a small product in a square
   800x800 frame on Amazon) exceeds 1.5x too and triggers the upscaler by the same scale rule; the
   brief's "never" holds for every adaptive canvas that found a size within the cap.
5. The gate's x2 restoration is measured without a residual Lanczos step (shrink 2x, restore 2x) so
   that the candidates are compared on the model alone; the render's residual Lanczos and sharpening
   are measured by the spec 10 checks on the Trendyol render of the shrunk photo.
6. LPIPS runs on the matting service (`/measure/lpips`, CPU allowed) because the worker image carries
   no ONNX runtime; OCR runs in the job with tesseract.js. Both are eval-only paths.
7. The spec 10 golden set is mostly 800x1200; the gate set is drawn with `minLongSide: 1600` from the
   owner's folders and pinned like the rest. If fewer than 40 such photos exist anywhere, the gate
   runs on what exists and the report says so; the bar does not change.
8. SwinIR lightweight x2 is the alternative candidate (the resume allowed "SwinIR or HAT"; HAT has no
   x2 weights). A x4 model with a Lanczos downscale is not a candidate in this spec.
9. Upscale failures do not open the matting breakers; they have their own counter with the 05
   constants, so a GPU outage degrades to Lanczos quietly and never blocks matting.
10. The sharpening PR (A) is its own small PR and deploy before the rest, as the resume orders it;
    this spec's single PR then carries B, C and D. Both are run under the 00 protocol.

## 10. Owner decisions (recorded in `docs/SPEC.md` in this PR)

- Decided (2026-10-20): an upscaler is allowed in the default path behind the `UPSCALE_MODEL` flag,
  chosen by the fidelity gate of section 4.4; its outputs carry the information flag `upscaled`.
- OPEN: whether an x2 upscale may un-skip Styli (800x1200 sources would clear its 1,482 px minimum).
  Not assumed here; `STYLI_SKIP_LOW_RESOLUTION` and `STYLI_MIN_SOURCE_HEIGHT_PX` are unchanged. Asked
  in the status when the gate is done.
- No paid image API (Topaz, Claid, Stability, Vertex Imagen, any hosted upscaler) without a separate
  owner yes; brand photos do not leave the GCP project.
