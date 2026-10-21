# 05 Matting and render

Execute with `docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`. Depends on 02
(channels, naming, storage, schema) and 04 (`catalog-local collect`, manifests). The pipeline that
calls this code in production, and the UI, ship in 06.

## Goal

Turn one raw source image into a compliant JPEG for every selected channel without ever regenerating
product pixels: decode once, matte once (the `catalog-matting` service, or a flood-fill fallback),
keep the original soft shadow where the source background is uniform, choose the canvas adaptively
between the sheet's minimum and target, fit without cropping, composite over the channel colour,
encode under 2,000,000 bytes, and prove compliance by code. Ship the `catalog-matting` Cloud Run
service (CPU, matting and HEIC conversion) and its GPU twin `catalog-matting-gpu`, the `render` and
`--upload` modes of `catalog-local`, and a contact sheet for a human check.

Plain-language terms. Matte: a greyscale picture that says, pixel by pixel, how much of the photo is
product (255) and how much is background (0). Bounding box (bbox): the smallest rectangle around the
product pixels. Safe box: the part of the canvas the product may occupy after the channel's margins
are taken away. Compliance: a code check that the finished JPEG meets the channel's written rules.

## Scope and non-scope

In scope: `services/matting/` (Dockerfile with `cpu` and `gpu` targets, FastAPI app, models baked
in, `/matte`, `/convert`, `/health`), the two Cloud Run services `catalog-matting` (asia-south1) and
`catalog-matting-gpu` (asia-southeast1), `packages/core/src/catalog/render.ts` and its helpers,
`shadow.ts` with the shadow decision rule, `compliance.ts`, the matting client with a circuit breaker
and per-model service choice, `catalog-local render` and `--upload`, infra for both services.

Out of scope: chunking, staging and worker routes that call these functions in production (06), the
QA judge and product-type classifier (07; this spec takes `productType` as an input and treats `auto`
as `other`), the bake-off and its custom sessions, edge-refinement and upscaling experiments (08),
tuning of the GPU service (09). No UI. Where an output goes (staging path, public path) is the
caller's decision: `renderSource` returns bytes.

## Files to add or change

```
services/matting/Dockerfile                     NEW  two targets: cpu (python:3.12-slim, onnxruntime CPU) and gpu (CUDA base, onnxruntime-gpu)
services/matting/app.py                         NEW  FastAPI: POST /matte, POST /convert, GET /health
services/matting/requirements-cpu.txt           NEW  rembg[cpu,cli], fastapi, uvicorn[standard], python-multipart, pillow, pillow-heif, numpy
services/matting/requirements-gpu.txt           NEW  rembg[gpu,cli] (onnxruntime-gpu), the same web and image packages
services/matting/README.md                      NEW  build and run locally; model list with licence per model; memory choice; the convert endpoint
services/matting/tests/test_app.py              NEW  pytest: health shape, matte on a synthetic image, convert on a small HEIC fixture, bad input
services/matting/tests/fixtures/small.heic      NEW  a tiny HEIC file for the convert test
cloudbuild.yaml                                 CHANGE images "matting" (target cpu) and "matting-gpu" (target gpu) from services/matting/Dockerfile
infra/bootstrap.sh                              CHANGE ensure_sa catalog-matting (02 may already have it; check-then-create), nothing else
infra/deploy.sh                                 CHANGE deploy catalog-matting and catalog-matting-gpu; pass MATTING_URL and MATTING_GPU_URL to the worker
packages/core/package.json                      add deps: sharp (02 lists it; confirm present)
packages/core/src/catalog/render.ts             NEW  prepare, bbox, planCanvas, planProduct, renderSource, renderAllChannels, renderKeyInputs
packages/core/src/catalog/matte.ts              NEW  MattingClient (OIDC, two services, send size per model, upscale, breaker, convert), alphaFromPng, floodFillMatte, matteFor
packages/core/src/catalog/shadow.ts             NEW  background uniformity, shadow decision rule, preserved darkening matte, synthesised contact shadow
packages/core/src/catalog/compliance.ts         NEW  checkOutput
packages/core/src/catalog/contact-sheet.ts      NEW  contactSheet(items, columns) -> jpeg
apps/worker/src/catalog-local.ts                CHANGE add render mode and --upload
apps/worker/build.mjs                           CHANGE add "sharp" to externals
apps/worker/Dockerfile                          CHANGE nothing expected (sharp ships linux-x64 glibc binaries for node:20-slim); verify in the image
```

## Contracts

### From 02 (used here, not redefined)

`ChannelId`, `ChannelSpec`, `Size`, `CHANNELS`, `channel()`, `backgroundFor()`, `JPEG_QUALITY_START`,
`JPEG_QUALITY_MIN`, `JPEG_QUALITY_STEP`, `MAX_OUTPUT_BYTES`, `MAX_UPSCALE`, `DETAIL_SHOT_BBOX_FRACTION`,
`MIN_SOURCE_LONG_SIDE_PX`, `STYLI_MIN_SOURCE_HEIGHT_PX`, `STYLI_SKIP_LOW_RESOLUTION`,
`CHANNEL_RULES_VERSION` and each channel's `uniformScaleDefault` from `catalog/channels.ts`;
`OutputFlag`, `ProductType`, `ResolvedPolicy` from `catalog/types.ts`; `publicObjectPath`,
`stagingPath`, `assertTestPrefix` from `catalog/naming.ts`; `uploadBuffer`, `headObject`, `readRange`,
`listObjects`, `deleteTestObjects` from `storage.ts`. Flags written here are from 02's `OUTPUT_FLAGS`
(`low_resolution`, `no_shadow_source`, `shadow_synthesised`, `passthrough`, `alpha_source`,
`unsupported`, `small_source`, `fallback_matte`, `failed_compliance`; `upscaled` and `transparent`
exist in 02 for 07 and 08 and are not set here). Outputs whose flags need a person become
`needs_attention` (02 `OUTPUT_STATUSES`) in 06; this spec only sets the flags and the sentences.
`model_policy.matte_target` (`cpu | gpu`, 02 schema) is written by 08's bake-off; this spec reads
nothing from `model_policy` and takes the model id as an argument.

### Render types (`render.ts`)

```ts
export interface Prepared {
  width: number; height: number;            // after EXIF orientation
  rgb: Buffer;                              // raw RGB, sRGB, 3 channels, row-major
  alphaSource: Buffer | null;               // raw 1-channel alpha when the source PNG had real transparency
  background: { uniform: boolean; color: [number, number, number]; stdev: number };   // from the border band (shadow.ts)
  flags: OutputFlag[];                      // small_source, alpha_source, passthrough candidates
  sourceMime: string;                       // the sniffed input type; image/heic when converted
}
export interface Matte { alpha: Buffer; width: number; height: number; model: string; ms: number; source: "model" | "alpha_source" | "floodfill"; target: "cpu" | "gpu" | null; sentLongSide: number | null }
export interface BBox { x: number; y: number; w: number; h: number }
export interface CanvasPlan { w: number; h: number; lowResolution: boolean; safeBox: BBox; scale: number; placedX: number; placedY: number; detailShot: boolean }
export interface RenderInput {
  prepared: Prepared; matte: Matte; channel: ChannelId; shotNumber: number;
  productType: ProductType;                 // "auto" is treated as "other" here; 07 detects the real type per product
  uniformScale?: number;                    // per-product scale from planProduct; applied when the channel's uniformScaleDefault is true
  identifier?: string;                      // compatible optional context for identifier-specific failure sentences
  publicObjectPath?: string;                // compatible optional context for path compliance; callers use the naming helper
}
export interface RenderOutput {
  jpeg: Buffer | null;                      // null when status is "skipped" or "failed"
  status: "ok" | "skipped" | "failed";
  plan: CanvasPlan; quality: number; bytes: number; flags: OutputFlag[]; notes: string[];
  attention: { why: string; what: string } | null;   // the two sentences 06 shows on the attention card
  compliance: { ok: boolean; failures: string[] };
}
export interface RenderKeyInputs { sourceSha256: string; channel: ChannelId; rulesVersion: string; policyId: string; policyUpdatedAt: string; n: number }

export async function prepare(buf: Buffer, originalName: string, convert: (buf: Buffer) => Promise<Buffer>): Promise<Prepared>;
export function bbox(alpha: Buffer, width: number, height: number, threshold?: number): BBox | null;   // threshold default ALPHA_BBOX_THRESHOLD
export function planCanvas(spec: ChannelSpec, box: BBox, source: Size, opts: { uniformScale?: number }): CanvasPlan;
export function planProduct(spec: ChannelSpec, shots: { box: BBox; source: Size }[]): { uniformScale: number };
export async function renderSource(input: RenderInput): Promise<RenderOutput>;
export async function renderAllChannels(prepared: Prepared, matte: Matte, channels: ChannelId[], ctx: Omit<RenderInput, "prepared" | "matte" | "channel">): Promise<Record<ChannelId, RenderOutput>>;
export function renderKeyInputs(i: RenderKeyInputs): string;   // "<sha256>|<channel>|<CHANNEL_RULES_VERSION>|<policyId>+<updatedAt>|<n>", the string 06 hashes into render_key
export const ALPHA_BBOX_THRESHOLD: number;   // builder constant, see "Builder constants"
```

`render_key` (02 and 06): `sha256(source sha256 | channel | CHANNEL_RULES_VERSION | policy id +
updated_at | n)`. This spec exposes the exact input string through `renderKeyInputs` so 06 computes
the key the same way everywhere and a live output with the same key is `unchanged` at zero cost.
Any change to the maths in this file that alters output bytes must bump `CHANNEL_RULES_VERSION`.

### sharp calls (confirmed in current docs; builders re-confirm before coding)

- Decode: `sharp(buf, { pages: 1, failOn: "warning", autoOrient: true })` (constructor option
  `pages` takes the first frame of gif, webp and tiff; `failOn` levels `none|truncated|error|warning`;
  `autoOrient` applies the EXIF Orientation tag, `.rotate()` with no angle does the same).
- Colour: `.toColourspace("srgb")` for CMYK and other spaces; `metadata()` exposes `width`,
  `height`, `hasAlpha`, `hasProfile`, `orientation`, `density`, `pages`, `space`, `format`,
  `chromaSubsampling`.
- Pixels: `.ensureAlpha()` then `.raw().toBuffer({ resolveWithObject: true })` gives `{ data, info:
  { width, height, channels } }`; `.extractChannel(3)` on an RGBA image gives the alpha plane;
  `.stats()` gives per-channel `mean`, `stdev`, `min`, `max`.
- Resize: `.resize(w, h, { fit: "inside", kernel: "lanczos3" })`; the product cut-out is resized as
  RGBA raw input `sharp(rgba, { raw: { width, height, channels: 4 } })`.
- Canvas: `sharp({ create: { width, height, channels: 3, background } })`.
- Composite: `.composite([{ input, left, top, blend: "over" | "multiply" }])` (the overlay must not
  exceed the canvas).
- Pad: `.extend({ top, bottom, left, right, background })` is an alternative for the pure padding
  case; `composite` is required where a shadow layer is present.
- Encode: `.jpeg({ quality, chromaSubsampling: "4:4:4" })`, `.withDensity(dpi)` for the JFIF DPI,
  `.withIccProfile("srgb")` for the embedded profile; `.blur(sigma)` for the matte upscale.

### Pipeline, step by step

1. prepare(buf, originalName, convert)
   - Sniff the type (`file-type`, as in 04). `heic`/`heif` -> `convert(buf)` first: the
     `MattingClient.convert` call to `POST /convert` returns a PNG at source resolution with EXIF
     orientation already applied; the PNG is then decoded like any other input and `sourceMime` is
     `image/heic`. A HEIC source is never `unsupported`.
   - BMP, unknown formats and decode errors -> `flags: ["unsupported"]` and a thrown
     `UnsupportedSourceError` with the sentence "<name> is a BMP file. Save it as JPEG or PNG and add
     it again." (BMP) or "<name> is corrupt (cannot be decoded)." (others); the caller marks the
     source `unsupported`, never the batch.
   - `autoOrient`, `toColourspace("srgb")`, `ensureAlpha()`, raw RGBA; split into `rgb` and, if
     `hasAlpha` and any alpha < 255, `alphaSource` (flag `alpha_source`).
   - Long side < `MIN_SOURCE_LONG_SIDE_PX` (500) -> flag `small_source` (an attention item in 06).
   - Background analysis (shadow.ts): sample the border band (outer 2% of width and height, at least
     4 px); `uniform = stdev of each channel in the band below BG_UNIFORM_STDEV`; `color` = the
     per-channel median of the band.
2. matte(prepared) via `matte.ts` (below): returns `Matte` at source resolution.
3. bbox(alpha) = tight box of alpha > `ALPHA_BBOX_THRESHOLD`; null when empty (then the output is
   `failed` with "No product was found in this photo.").
4. planCanvas(spec, box, source):
   - Safe box of a canvas `C`: subtract margins (fraction of `C`, or px) from each side; for Noon the
     side margin applies only when `box.w > box.h`.
   - `sFit(C) = min(safe.w / box.w, safe.h / box.h)`.
   - Detail shot: `box.w / source.w > DETAIL_SHOT_BBOX_FRACTION (0.85)` or the same for height ->
     `detailShot = true`; the product fills the safe box (`scale = sFit(C)`), uniform scale is not
     applied.
   - Fixed canvas (styli, centrepoint): `C = target`; `lowResolution = sFit(C) > MAX_UPSCALE (1.5)`.
   - Otherwise adaptive: keep the target aspect. The listed minimum and target do not always share
     an aspect, so first find the smallest target-proportioned canvas meeting both minimum dimensions
     (for example Trendyol becomes 600x900). Choose the largest canvas up to target whose fit scale
     is at most 1.5; if the effective minimum already exceeds that scale, use it and set
     `lowResolution`. Round adaptive dimensions to even pixels within the one-pixel aspect tolerance
     without falling below either minimum. Fixed canvases retain their exact dimensions, including
     Styli's 3123 px height. This correction was approved by the owner during spec 05 planning.
   - `scale = uniformScale ?? sFit(C)`, but never above `sFit(C)` (a uniform scale larger than the
     fit of this shot would crop, which is forbidden; in that case the shot uses `sFit(C)` and gets
     the note "Could not keep the same size as the other angles without cutting; fitted instead").
   - Placement: `centre` puts the scaled box at the centre of the safe box; `bottom-centre` (styli)
     aligns the scaled box's bottom to the safe box bottom (canvas height minus 450) and centres
     horizontally.
   - planProduct: `uniformScale = min over shots of sFit(C_shot)` using each shot's own canvas; the
     caller passes it when `spec.uniformScaleDefault` is true (styli) and the shot is not a detail
     shot. There is no batch option for this; the channel table decides.
   - One canvas per product and channel: planProduct also returns `canvas`, the largest canvas the
     formula gives any of the product's shots on that channel (never above the target); every shot
     of the product on that channel is rendered on it. `lowResolution` stays per shot.
   - Trendyol: SPEC.md says accepted files are 1200x1800, so Trendyol is a fixed canvas: always
     1200x1800, the product fitted even beyond 1.5x; `low_resolution` is then information only.
   - Cut in source (`shotGeometry`, with the source pixels): first the pad band per side, the
     outermost frame lines that are uniform and the colour of the outermost line (any colour: white,
     light grey); a band deeper than the thin border (3% of the frame) counts only when it ends on
     the real photo's edge (the photo background inside is another colour, or a thin side band shows
     the photo's corner exactly there), or when the product is already cut by this rule on a
     perpendicular side (the photo is a crop and the band is its padding: a model cut at the waist
     and thighs inside a white band, also cut at the left edge), up to 15% of the frame. A cut found
     through that perpendicular rule never unlocks another side. The product must reach the band's
     inner edge (allowing the matte's soft fade, 1% of the long side). Then two signals on the
     outermost product line: a straight edge (positions whose silhouette starts on that line within
     2 px and turns opaque, alpha >= 250, behind it; one run at least 2% of the side long) AND a
     truncated silhouette (the edge holds at least 60% of the silhouette width 10 lines further in).
     Without a photo edge the edge must also span 20% of the box side (the lowest flat shoe sole of
     a standing model measures 10-17%). A foot or a rounded hem narrows towards its edge and fails;
     two legs cut at the knee pass. When the judge saw the cut (07 `flush_cut`) the share is 40%
     and a deep band of the photo's own colour counts too. The box is trimmed to the cut line, the cut side's margin becomes 0 and the
     product is anchored to that canvas edge; other margins are unchanged. A product cut on both
     ends of one axis (top and bottom, or left and right) fills that axis, so neither cut edge has a
     band beside it (`cutFillScale`): where that makes it overflow the other axis, the overflow comes
     off that axis's cut sides only (split evenly when both are cut, `cutFillCrop`), never off an
     uncut outline, and by at most a third of the product box plus 1% (`CUT_FILL_MAX_TRIM`, the widest
     canvas mismatch: a square photo on the 2:3 Trendyol canvas; `CUT_FILL_TRIM_SLACK`: the matte's
     soft edge makes a square full-bleed box 797 x 796). A trim never cuts through a logo
     (`trimRoom`): on a grid of 512 cells over the product box, luminance edges of at least 40 levels
     inside the opaque matte join (2 cells) into clusters; a cluster that is compact (4% to 40% of the
     box on each axis, at most 4:1), dense (edges in 15% of its box) and sharp (a quarter of its edges
     60 levels or more) and is whole in the source (not within 2% of a box edge) is a logo, text or a
     buckle (`detailFeatures`). A cut side's trim stops 2% of the box short of it and the rest comes
     off the opposite cut side. Two sides are never trimmed by rule (`trimRules`, eval run 2, French
     Connection ZEE79259BBFD83FFA1DB0Z shot 5, heads cut off on the square canvases): on a model photo
     (`apparel_model`) the top cut side (the head or face) has room 0, so the whole trim comes off the
     bottom or the product is fitted; a pass-through or whole-photo matte (model `passthrough`) keeps
     the photo's own frame, nothing in it tells a product edge from a background edge, so no side is
     trimmed and it is fitted with the band note. The product canvas (`planProduct`) uses the same
     rule. A full-bleed photo (cut on all four sides) fills the safe box. Where
     the other axis has no cut side, or the trim would pass a third, or the cut sides' room cannot
     take it, the product is fitted (bottom wins when top and bottom are both cut; centred when left
     and right are both cut) and the output carries a note naming the cut side that does not reach
     the edge (and the logo it keeps whole); the sheet's flush cut note leaves that photo out and
     carries the channel note instead. Flag `cut_in_source`
     (information: sheet notes and report, never holds the product). Compliance accepts the flush
     edge on the cut side only (`inside_safe_box`, `styli_anchor`, `noon_wide`). Headroom on
     zero-margin channels stays 0: SPEC.md states no minimum headroom.
5. Shadow decision rule (shadow.ts), evaluated per source after matting, in this order:
   1. `matte.source === "alpha_source"`: the file carries no shadow information. Synthesise (rule 3)
      only when the product type is one that synthesises and the channel allows a shadow on that
      shot; else no shadow and flag `no_shadow_source`.
   2. Preserve (first choice, pixel-safe): when `prepared.background.uniform` and the darkness matte
      in the shadow band has a mean darkness above `SHADOW_MIN_DARKNESS` (builder constant, start
      0.04) and the dark region touches the bbox bottom. Darkness per pixel with alpha at or below
      `ALPHA_BBOX_THRESHOLD` (10, the same measured silhouette threshold used by bbox) is
      `d = max(0, (L_bg - L_px) / L_bg)` with `L` the luma (0.2126 R + 0.7152 G + 0.0722 B) and
      `L_bg` the background luma; zero outside the band. Shadow band: `footwear`, `bag_accessory`
      and `other` -> from the bbox bottom minus 10% of bbox height to the bbox bottom plus 25% of
      bbox height, full bbox width plus 10% each side; `apparel_model` and `apparel_flat` -> the
      whole canvas (soft shadows under a model are kept wherever they are). Two guards: `d` is
      clamped to `SHADOW_MAX_DARKNESS` (start 0.6) so a dark sweep cannot produce a black slab, and
      only the connected component of the dark region that touches the bbox bottom is kept, so stray
      gradients and vignettes are dropped. The layer is a 1-channel image `255 - round(255 * d)`,
      scaled and placed with the product, composited with `blend: "multiply"` over the background
      before the product goes on `over`. For the footwear, bag and other band, the qualified component
      continues past the band through connected background and fades to zero over 10% of bbox height,
      so a real shadow never stops on the band's straight edge. First qualify the shadow using only the connected
      background component at or below `ALPHA_BBOX_THRESHOLD`; partial product pixels must never
      create a preserved shadow on their own. After qualification, extend that component into
      connected partial-alpha pixels, without bridging into other background components. Exclude
      opaque alpha-255 pixels from measurement and the projected shadow. Original foreground RGB
      and alpha are unchanged: normal `over` compositing lets the verified background shadow show
      through a partial edge, while opaque product colors remain exact. Hard exclusion at alpha 0
      and then 10 both left a visible bright fringe in the real Anta preflight. Required margins
      remain unchanged.
   3. Synthesise: when rule 2 does not hold, the product type is `footwear`, `bag_accessory` or
      `other` (and `auto`, treated as `other`) and the pose is upright (bbox taller than wide, or
      footwear): a deterministic contact shadow from the silhouette: each column of the bottom 20% of
      mask rows is weighted by how close the silhouette comes to the contact line in it (alpha times
      `(1 - gap / zone)^2`), so feet and soles cast it and hems hovering above the floor barely do;
      the footprint is feathered sideways (sigma the larger of 2.5% of product width and half the
      depth) and given a Gaussian vertical falloff around the contact line, depth about 12% of the
      product's smaller side (soft preset); multiply at `SHADOW_SYNTH_INTENSITY_GREY` (start
      0.25) on grey canvases and `SHADOW_SYNTH_INTENSITY_WHITE` (start 0.15) on white. Parameters
      are named (softness, intensity, spread, direction, pose) so a hard or floating preset is a
      parameter change later. Flag `shadow_synthesised` (info). No model takes part; depth-based
      shadows are an 08 experiment.
   4. `apparel_model` and `apparel_flat`: never synthesise; preserve when rule 2 holds; else none
      with flag `no_shadow_source`.
   5. Relighting models are not in the default path (the available version regenerates foreground
      pixels, which is forbidden); 08 may test one on the shadow layer alone, behind a colour-delta
      guard.
   Every shadow layer, kept or made, is multiplied by a smooth window (`SHADOW_PRESET.fade`, 3% of the
   canvas's smaller side) that reaches zero at required margins, the border band and, for a kept
   shadow, the projected source frame, so margins stay exact and no shadow ends on a straight cut.
   Compliance's `background` check enforces exposed background in the border band and all required
   margins. Foreground may touch an edge whose channel margin is zero; it is not a background
   failure. Shadows may not contaminate required margins or exposed border background. This resolves
   the conflict with the full-canvas fit rule and was approved by the owner during spec 05 planning.
6. Composite: canvas `C` filled with `backgroundFor(channel, shotNumber)`; shadow multiply (if any);
   product RGBA = `rgb` with `matte.alpha` as alpha, cut to the bbox, resized by `scale` with
   lanczos3, placed at `(placedX, placedY)`, `blend: "over"`.
7. Passthrough: if the source is already a JPEG whose dimensions equal `C`, whose border band equals
   the channel colour within `BG_TOLERANCE`, with no alpha and bbox inside the safe box, the source is
   re-encoded only (no matte, no composite), flag `passthrough`.
8. Encode: quality `JPEG_QUALITY_START` (90), `chromaSubsampling: "4:4:4"`, density `spec.dpi`, sRGB
   ICC; if `bytes > MAX_OUTPUT_BYTES` (2,000,000) step the quality down by `JPEG_QUALITY_STEP` to the
   floor `JPEG_QUALITY_MIN` (70); still too large -> output `failed` with "Could not get
   <identifier>_<n> for <channel> under 2 MB." The output is a new canvas, so no source EXIF
   survives; orientation was applied in step 1.
9. Compliance (below) runs on the encoded bytes; `failed_compliance` is a hard failure for that output
   only.
10. Low resolution: `lowResolution` adds flag `low_resolution` and the attention sentences
    `why = "The original is <w> x <h>. <Channel> wants at least <min> px, so this one may look soft."`
    and `what = "It will upload, but ask the brand for a larger photo if you can. The other
    marketplaces are fine with it."` where `<Channel>` is the channel label (02) and `<min>` is the
    channel's minimum height for portrait channels and minimum width for square ones. For styli,
    `STYLI_SKIP_LOW_RESOLUTION` (02, a constant, always true) makes the output `skipped` with the note
    "Skipped for Styli: the photo is smaller than Styli needs." and no JPEG; the sheet cell stays
    empty with that note (06). This is the agreement with Styli; there is no option to turn it off.

Where the bytes go: `renderSource` returns `jpeg`. In production 06 writes it to
`stagingPath(prefix, pathKey, channel, n)` (02) and later copies it to
`publicObjectPath(brandSlug, pathKey, channel, n, isTest)`; `catalog-local render` writes it to disk
and, with `--upload`, under a `catalog-test/` prefix. Nothing in this spec writes to the public bucket.
Output paths carry no version suffix of any kind.

### Matting client and fallbacks (`matte.ts`)

```ts
export interface MattingService { baseUrl: string; target: "cpu" | "gpu" }
export interface ModelInfo { id: string; inputSize: number | "native"; target: "cpu" | "gpu" }
export interface MattingClientOptions { services: MattingService[]; fetch?: typeof fetch; idToken?: (audience: string) => Promise<string>; model?: string; timeoutMs?: number }
export class MattingClient {
  constructor(opts: MattingClientOptions);          // services from MATTING_URL (cpu) and, when set, MATTING_GPU_URL (gpu)
  /** Picks the service that lists `model` in its /health (gpu preferred), sends a PNG downscaled to that model's inputSize on the long side, returns the matte upscaled to (width, height) with a 1 px blur. */
  matte(prepared: Prepared, model?: string): Promise<Matte>;
  /** POST /convert on the CPU service: HEIC/HEIF bytes in, PNG at source resolution out (orientation applied). Not behind the breaker: a failure throws and the source is marked unsupported with its sentence. */
  convert(buf: Buffer): Promise<Buffer>;
  readonly breaker: { state: "closed" | "open" | "half-open"; failures: number; openedAt: number | null };   // one breaker per service
  /** Merged view of every service's /health, cached for HEALTH_TTL_MS (builder constant). `default` is the CPU service's default model. */
  health(): Promise<{ ok: boolean; models: ModelInfo[]; default: string; versions: Record<"cpu" | "gpu", string | null> }>;
  /** The long side to send for a model: its inputSize, or for "native" the source long side rounded to a multiple of 32 and clamped to 256..2304. */
  sendLongSide(model: string, source: Size): number;
}
/** Breaker and timeout constants, read once from env with these defaults; 09 tunes them under fault injection. */
export const BREAKER_FAILURES = Number(process.env.MATTING_BREAKER_FAILURES ?? 5);        // consecutive failures that open the breaker
export const BREAKER_COOLDOWN_MS = Number(process.env.MATTING_BREAKER_COOLDOWN_MS ?? 60_000); // open -> half-open after this
export const MATTING_TIMEOUT_MS = Number(process.env.MATTING_TIMEOUT_MS ?? 180_000);         // per call; a timeout counts as a failure
export function alphaFromPng(png: Buffer): Promise<{ alpha: Buffer; width: number; height: number }>;
export function floodFillMatte(prepared: Prepared): Matte;   // source "floodfill"
export async function matteFor(prepared: Prepared, client: MattingClient | null, model?: string): Promise<Matte>;
```

Compatible implementation additions: `MattingClientOptions.batchId` optionally supplies the batch
id for transition logs. `breaker` remains the CPU-service view; `breakers` exposes the separate
CPU/GPU views. `CanvasPlan.sourceBox` and `productBox` optionally carry source and placed geometry.
`checkOutput` accepts an optional foreground mask in canvas coordinates; `renderSource` supplies
that mask so exposed background inside an irregular product's bounding rectangle is checked too.
Existing required arguments and the shared contracts from specs 02 and 03 are unchanged.

Send size per model (this replaces any fixed 1536 px rule): the client reads `inputSize` from
`/health`. It is 1024 for every rembg built-in (rembg resizes the BiRefNet and RMBG sessions to 1024
internally, so a larger send buys nothing), 2048 for `birefnet-hr-matting` and `birefnet-hr` (08's
custom sessions), and `native` for the dynamic models, which means the source long side rounded to a
multiple of 32 and clamped to 256..2304. The matte comes back at the sent size and is upscaled to
the source size (below). `Matte.sentLongSide` and `Matte.target` are recorded for the report.

Which service: the worker sends a model to the service whose `/health` lists it, preferring `gpu`
when both do. When `MATTING_GPU_URL` is unset every model runs on the CPU service and any model only
the GPU image carries is reported "not run: no GPU service" (08's harness reads this). The worker
refuses to matte when `MATTING_URL` is unset (a clear startup error, not a silent fallback).

`matteFor` order: `alphaSource` present -> `{ source: "alpha_source" }`; else the chosen service with
breaker closed or half-open -> model; on a transport error, 5xx or timeout that service's breaker
counts a failure and after `BREAKER_FAILURES` consecutive failures opens for `BREAKER_COOLDOWN_MS`;
while the GPU breaker is open the CPU service is tried for models it also lists; while the service
for a model is open `floodFillMatte` is used and the output gets `fallback_matte` (an attention item
in 06); one success in half-open closes it. Breakers are per worker instance; 09 verifies them under
fault injection. Every transition is logged with the batch id and the service. This `MattingClient`
is the only matting client and the only breaker in the codebase; 06 wires it into the worker and adds
nothing of its own.

OIDC: `new GoogleAuth().getIdTokenClient(audience)` from `google-auth-library` (already a worker
dependency); the audience is the service's own URL (`MATTING_URL` or `MATTING_GPU_URL`); the caller
is `catalog-worker@`, which holds `roles/run.invoker` at project level (02 bootstrap); the client adds
the bearer header. Local Docker runs the service without auth: Cloud Run enforces auth at the edge and
the local container has no edge, so the local client simply sends no token when a service URL starts
with `http://localhost`.

Upscale: `sharp(alpha, { raw: { width: sentW, height: sentH, channels: 1 } }).resize(width, height,
{ kernel: "lanczos3" }).blur(1)`; the result is clamped to 0..255. ("1 px guided blur" is realised
as a sigma 1 blur on the upscaled alpha; edge refinement such as a trimap pass is an 08 experiment on
the hard-cases set, measured by the human edge-flag rate.)

Flood fill: only meaningful when `background.uniform`; seeds at the four corners and every border
pixel within `BG_TOLERANCE` of the background colour; 4-connected fill over pixels within
`FLOODFILL_TOLERANCE` of the seed colour; filled pixels -> alpha 0, others 255; the edge is softened
with `blur(1)`. Non-uniform background with an open breaker -> output `failed` for now with the
reason "Background removal was unavailable and this photo's background is not plain. Start the
batch again later, or replace the photo." and no render; 06 turns it into an attention item with
"Replace photo <n>".

### Cut-out integrity guard (`matte-guard.ts`, added 2026-10-20)

Quality gate 2 found close-ups that fill the frame (a leather bag, a knit polo, a lace trim on fabric)
cut down to the logo, label or clasp on them: a salient-object model treats a frame-filling texture
as background. The earlier investigation sampled only shoes and full-length models. The spec 10
checker could not see it either: `cutout.pixels_lost` is "not run" when the source border is not
uniform, which is exactly the close-up case. The worker therefore checks every model matte at run
time, before anything is rendered.

- Product estimate from the source alone. Uniform canvas strips (rows or columns that are 97% the
  border colour, a photo pasted on a plain canvas) are trimmed. Background is every smooth region (5x5
  range at most `SMOOTH_WINDOW_RANGE` 18) connected to the photo's own border band, plus smooth pixels
  in the colours that region holds; so a studio wall, the floor and cast shadows are background even
  when they differ from the canvas. Leather grain, knit, lace and embroidery are never smooth. When
  under 10% of the photo's border band is smooth, the photo is frame-filling and everything inside the
  strips is product. Product = the spec 10 colour estimate minus that background (grown 2 px).
- Check (`checkMatteIntegrity`): share of the estimate's interior (3 px in) the matte drops (alpha at
  most 10), per cell of a 6x6 grid and overall. Bars `GUARD_CELL_LOSS_MAX` 0.2 and
  `GUARD_OVERALL_LOSS_MAX` 0.04: far above the spec 10 golden bars (1% and 0.3%), because this guard
  only has to catch a matte that removes the product; measured on 82 real photos, destroyed close-ups
  lose 60 to 95%, good mattes under 9% in their worst cell except two model close-ups (skin removed
  inside a neckline, a wall corner the flood did not reach), which then take the ladder. A strongly
  coloured product pixel (chroma at least 72, the spec 10 cast-shadow allowance, so neither backdrop
  nor shadow) that the matte drops more than 1 px away from what it kept counts as lost even inside
  the 3 px edge band (`GUARD_COLOURED_CHROMA_MIN`): a thin coloured part such as a midsole sliver
  along a dark outsole is all edge band (eval run 2, Anta bd-112625546-12 shot 5: 17% measured
  before, 41% with the rule; good mattes on 129 real photos at most 10.7%). Also rejected: a hand-held product whose
  holding hand (skin reaching the border band, bordering the kept product, not the background colour)
  was dropped over more than 2% of the kept product (`HAND_NOTCH_MAX_SHARE`; not applied to apparel,
  where the skin is the model's). Also rejected: a matte that keeps a chunk of the backdrop
  (`keptBackground`, eval run 2, French Connection candle Z15276411CE85C2E728DEZ shot 4): a connected
  kept region (alpha over 128) whose source pixels are the border colour itself (within 6 levels per
  channel, so a pale product part with any shading of its own does not count), touching what the
  matte dropped (within 4 px), lying wholly in the lower half of the kept product (a halo ring around
  the whole silhouette is the judge's `halo`), covering more than 0.3%
  of the frame and more than 2% of the kept product (`KEPT_BACKGROUND_*`); not on a frame-filling
  photo. The ladder then continues as for a dropped product.
- Ladder when the first matte fails, first pass wins, each step in `compliance.auto_actions` with
  trigger `product_removed`: `matte_check` (the failed first matte), (a) `second_matte` the policy's
  second model, (b) `padded_matte` the photo framed in a white border of 20% of its long side
  (`MattingClient.matte(p, model, { padFraction })`, mask cropped back) with the first, then the second
  model, (c) `matte_passthrough` the whole frame: alpha 255 except the source background reached from
  the frame edge (`passthroughBackground`: the border colour, pixel-exact, within 16 levels per
  channel, plus any smooth backdrop of another colour covering at least 1% of the frame that no matte
  kept as skin or a garment panel; a smaller plain region at the frame edge, such as a light strap,
  stays product), holes filled, components under 25% of the largest dropped, edge softened inward
  only. Model
  steps are skipped when this delivery has no time left for a matting call; the pass-through always
  completes. A pass-through adds the information flag `matte_passthrough` ("This photo is a close-up
  that fills the frame, so the whole photo was kept as it is instead of being cut out. Nothing to
  do."), never holds, gets no synthesised shadow, is placed by the cut-in-source rules (sides that
  reach the frame sit flush) and is never trimmed (`trimRules`).
- A pass-through replaces a plain studio backdrop only (`isBusyBackground`, eval run 2, French
  Connection ZEE79259BBFD83FFA1DB0Z shot 5: models on a tennis court published with ragged court,
  net and racket remnants). In the border band, the pixels kept by the pass-through although every
  model matte tried dropped them, and that are no skin or garment panel a matte cut through, are read
  (`busyBorderReading`): their share of the band, their edge density (share of them whose luma steps
  by more than 20 levels per pixel) and their tones (the fewest 16-level RGB colour buckets holding
  90% of them). They are scenery when they show strong structure (edge density at least 0.40, or at
  least 45 tones: a net, a racket, a hedge, people) or a plain area in several tones (edge density
  under 0.05 and at least 8 tones: a wall over a table). Anything else is one material or one plain
  colour, never scenery: the fine grain of a frame-filling close-up whose every matte dropped the
  leather, knit, zip or clasp itself (out-of-focus leather reads as smooth, so such a close-up can miss
  the frame-filling test), or a plain one-colour backdrop the pass-through keeps whole. The background
  is busy when more than 5% of the band (`BUSY_BORDER_MAX_SHARE`) is such pixels, they read as scenery
  and the photo is not frame-filling. Measured (share, edge density, tones): the court photo 33%,
  0.51, 55 to 60 and the lifestyle candle Z011CB57531CA8FA0CBDDZ shot 1 7 to 13%, 0.00 to 0.01, 11 to
  31 are busy; the gate 3f bag close-ups Z02B2EE44E3A08044B816Z shots 3 and 6 (5.4%, 0.25, 24 and
  15.5%, 0.20, 30), the leather close-up Z5A0B7DE13FC67EDEAC9DZ shot 5 (17%, 0.13, 9) and the bag
  held against a plain dress, Z02B2EE44E3A08044B816Z shot 1 (11%, 0.00, 4), pass through; every
  plain-backdrop pass-through of the gate and golden sets keeps 0%. The `matte_passthrough` record
  carries the reading ("N% of the border band no cut-out kept, edge density D, T tones"), so a hold
  can be read from the report. On a busy background the step is recorded `matte_passthrough: failed`
  ("busy background"), the matte is the whole photo as it is inside any uniform canvas strips the
  brand pasted it on (every pixel of the photo opaque, the strips transparent as the pass-through
  drops them; model `passthrough`, so never trimmed)
  and the photo carries `leftover_background`, code-detected (the same flag the judge raises for a
  leftover background; the step is recorded with trigger `leftover_background`, which is how
  `busyBackgroundHold` in auto-resolve.ts tells the two apart): rendered and staged as `needs_attention`,
  never re-made by the repair loop, a hard
  hold in triage (07, hold cause `unusable`), card sentence "The background could not be removed from
  this photo. Use it as is, replace it, or remove it." "Use as is" publishes the whole photo, fitted
  with the band note on each channel where a cut side does not sit flush (so the sheet's flush note
  leaves it out), never framed in the source's white strips. The judge-triggered pass-through step (07 auto-resolve) is skipped on a busy
  background ("busy background"), so the photo keeps `product_removed` and triage drops or holds it.
- The judge's `product_removed` (07 4.0a) names the same failure after the render: its ladder (07
  auto-resolve) adds the same pass-through step after the second matte, for that trigger only.
- No synthesised contact shadow for a product held in a hand (`heldInHand`, kept or dropped hand):
  it does not rest on a floor.
- Size charts and text-only photos (07 4.0a, flag `chart_image`) are not cut out: a photo the
  classifier calls a chart (the next photo then decides the product type), or that `detectTextImage`
  finds (a light page, at least 60% plain, 60 or more dark glyph marks on 6 or more lines, nothing
  larger than 6% of the frame), is left out on every channel with the `chart_image` note before any
  matting. A sweep of 5,362 brand photos found the 13 Penti size charts and no product photo.
  A chart with a tinted header band or tinted table cells (the Penti bra chart, where the band and
  the grid lines make one mark over 6%) is read a second time with each flat tinted rectangle in a
  large mark (one of its 3 most common smooth colours, at least half of its box filled, straight
  sides, at least 10% of the frame wide and 2% high) as a second page colour; it counts only when
  the tables holding those rectangles carry 60 glyphs on 6 lines themselves and every rule above
  still passes.

### Compliance (`compliance.ts`)

```ts
export interface ComplianceInput { jpeg: Buffer; channel: ChannelId; shotNumber: number; plan: CanvasPlan; identifier: string; n: number; publicObjectPath: string }
export async function checkOutput(input: ComplianceInput): Promise<{ ok: boolean; failures: string[] }>;
export const BG_TOLERANCE: number;   // builder constant derived by test, see below
```

Checks (each failure is a short code plus a sentence):
- `magic`: bytes start `FF D8 FF`.
- `format`: `metadata().format === "jpeg"`, `chromaSubsampling === "4:4:4"`, `space === "srgb"`,
  `hasProfile === true`, `hasAlpha === false`.
- `dims`: width and height equal `plan.w`, `plan.h`; for adaptive channels also `min <= C <= target`
  and the aspect equals the target aspect within 1 px; for fixed channels `C === target`.
- `density`: `metadata().density === spec.dpi`.
- `bytes`: `<= MAX_OUTPUT_BYTES`.
- `background`: exposed background in the border band (same band as prepare) and the whole required
  margin area equal `backgroundFor(channel, shotNumber)` within `BG_TOLERANCE` per channel. Foreground
  at zero-margin edges is allowed, consistent with the source-of-truth full-canvas fit rule. Amazon
  and Shein shot 1 exposed background must be `#FFFFFF`.
- `inside_safe_box`: no pixel differing from the background by more than `BG_TOLERANCE` lies outside
  the safe box (product never touches a margin; with margin 0 the product may touch the edge).
- `styli_anchor`: for styli, the lowest non-background row is `3123 - 450` within 1 px and the
  product is horizontally centred within 1 px of `(2342 - box.w) / 2`.
- `trendyol_name`: `publicObjectPath` has no spaces (checked for every channel; required by Trendyol).
- `extension`: `publicObjectPath` ends in lowercase `.jpg` (the channel sheets say JPEG/JPG; 02's
  `publicObjectPath` is the only function that builds a public path and this check guards it).
- `noon_wide`: for noon, when `plan` says the box is wider than tall, the side margins are at least
  5% of the width.

### Contact sheet (`contact-sheet.ts`)

`contactSheet(items: { label: string; jpeg: Buffer }[], columns: number): Promise<Buffer>` lays out
thumbnails (long side 240 px) with the label drawn with sharp's `text` input, for the human check in
the tier 3 run. Not used in production.

### `catalog-matting` and `catalog-matting-gpu` services (`services/matting/`)

One Dockerfile, two targets. Outline:
```
# ---- shared ----
FROM python:3.12-slim AS base-cpu
FROM nvidia/cuda:12.x-cudnn-runtime-ubuntu22.04 AS base-gpu      # exact tag chosen against the onnxruntime-gpu CUDA matrix; python 3.12 installed
# ---- cpu target ----
FROM base-cpu AS cpu
ARG GIT_SHA=dev
ENV REMBG_HOME=/models U2NET_HOME=/models PIP_NO_CACHE_DIR=1 OMP_NUM_THREADS=4 GIT_SHA=$GIT_SHA MATTE_TARGET=cpu
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements-cpu.txt .
RUN pip install -r requirements-cpu.txt         # rembg[cpu,cli], fastapi, uvicorn[standard], python-multipart, pillow, pillow-heif, numpy
RUN rembg d birefnet-general birefnet-general-lite birefnet-hrsod bria-rmbg   # bake the models in; no downloads at runtime
COPY app.py .
RUN useradd -m app && chown -R app /models /app
USER app
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
# ---- gpu target ----
FROM base-gpu AS gpu
...same steps with requirements-gpu.txt (rembg[gpu,cli], onnxruntime-gpu) and MATTE_TARGET=gpu
```

The builder verifies that the `rembg d` subcommand exists in the installed version before the
Dockerfile relies on it; if it does not, the ONNX files are downloaded by URL from the release assets
listed in the rembg README and placed under `/models` with the names rembg expects. The baked CPU
image is about 4 GB; the cold start is measured and written in the README.

rembg facts (confirmed in current docs; builders re-confirm before coding): install with `pip install
"rembg[cpu,cli]"` (the `cli` extra gives the `rembg d <models>` download subcommand; `rembg[gpu]`
pulls `onnxruntime-gpu`); `new_session(model_name, sess_opts)` returns a reusable session;
`remove(data, session=..., only_mask=True)` returns the mask; the model directory is `REMBG_HOME`
(`U2NET_HOME` is the legacy name and still honoured); `OMP_NUM_THREADS` bounds the CPU threads;
`rembg.sessions.sessions_names` lists the supported ids, and the built-ins include
`birefnet-general`, `birefnet-general-lite`, `birefnet-hrsod` and `bria-rmbg` (RMBG-2.0, which is
rembg's current default session). There is no built-in "HR-matting", "dynamic-matting" or BEN2
model. Therefore:

- Model ids served by this spec: `birefnet-general` (default), `birefnet-general-lite`,
  `birefnet-hrsod`, `bria-rmbg`. Every `remove()` call passes an explicit `session=`; the code never
  relies on rembg's default, which is a 1 GB model under a non-commercial licence.
- The further candidates are not rembg built-ins and arrive in 08 as custom `BaseSession` subclasses
  loading an ONNX export baked into the image: BiRefNet HR-matting (Hugging Face
  `ZhengPeng7/BiRefNet_HR-matting`, id `birefnet-hr-matting`, 2048), BiRefNet dynamic-matting (id
  `birefnet-dynamic-matting`, native size), BiRefNet HR general (id `birefnet-hr`), and BEN2 base,
  where `ben2-base` is our id for a rembg `ben_custom` session pointed at our ONNX export by
  `model_path`. `/health` lists whatever is loaded so 08's harness can tell.
- Licences are recorded per model in `services/matting/README.md` (BiRefNet family and BEN2 base
  MIT; RMBG-2.0 CC BY-NC 4.0, gated on Hugging Face with the ONNX hosted by rembg) and repeated in
  08's bake-off report as a record. The owner has closed the licence question (08 section 4.10):
  non-commercial models are full candidates for this internal tool and may be policy defaults.
- Model ids appear in this engineering text, in `model_policy` and in logs only; never in UI copy.

Memory: actual build `2c0b868c-a590-4e8a-b187-e288f89ef079` showed that four eager sessions
used 4,622,376 KiB while idle, but consecutive general/lite inference exceeded 16 GiB. CPU therefore
keeps one resident session, evicts it before a model switch, disables CPU arena and memory-pattern
retention, and serializes loading and inference. All four baked models remain advertised. CPU
stays at 16 GiB pending measured peak memory from general/lite/general switching. The deployed GPU
benchmark later failed on its first lite request after 100 general requests: the CUDA arena could
not allocate another 822,083,584 bytes. GPU therefore also keeps one resident session, releases it
before loading a replacement, and verifies CUDA on every new session. Post-fix real GPU switching
and the complete benchmark must pass before release. The README records measurements and `deploy.sh` carries the matching `--memory`.

`app.py`:
- On start: `SESSIONS = { name: new_session(name, sess_opts) for name in MATTE_MODELS.split(",") }`
  (both targets instead preload only the default and replace their single resident session on demand)
  with `sess_opts.intra_op_num_threads = 4`; env `MATTE_MODELS` default
  `birefnet-general,birefnet-general-lite,birefnet-hrsod,bria-rmbg`, `DEFAULT_MATTE_MODEL` default
  `birefnet-general`, `MATTE_TARGET` `cpu | gpu` (set by the image); `INPUT_SIZES` maps each id to
  its `inputSize` (1024 for the four built-ins; 08 adds 2048 and `native` entries); `from pillow_heif
  import register_heif_opener; register_heif_opener()` so `Image.open` reads HEIC and HEIF.
- `POST /matte?model=<id>`: multipart field `file` (PNG or JPEG at the model's input size, any size
  accepted up to `MAX_INPUT_BYTES` 40 MB); unknown model -> 400 `{"error": "unknown model <id>",
  "models": [...]}`; decode with Pillow, `remove(img, session=SESSIONS[model], only_mask=True)`,
  encode the mask as 8-bit greyscale PNG at the received resolution; response `image/png` with
  headers `x-model: <id>`, `x-ms: <int milliseconds>`, `x-input-size: <w>x<h>`; errors 500 with a
  JSON body.
- `POST /convert`: multipart field `file` (HEIC or HEIF, up to `MAX_INPUT_BYTES`); `Image.open`
  through pillow-heif, `ImageOps.exif_transpose` so the EXIF orientation is applied, encode as PNG at
  source resolution (RGB, or RGBA when the file has alpha); response `image/png` with headers
  `x-ms: <int milliseconds>`, `x-input-format: <heic|heif>`; a file Pillow cannot open -> 400
  `{"error": "not a HEIC or HEIF file"}`.
- `GET /health`: `{"ok": true, "models": [{"id": "<id>", "inputSize": 1024 | 2048 | "native",
  "target": "cpu" | "gpu"}], "default": "<id>", "version": GIT_SHA}`.
- No batching, no persistence, no logging of image bytes.

Deploy (`infra/deploy.sh`, owned by this spec; 06 only adds worker env vars), both private with the
same `auth_flag` pattern the web and worker use (OIDC callers only), no secrets, no VPC flags,
service account `catalog-matting@image-links-agent.iam.gserviceaccount.com` for both:
- `gcloud run deploy catalog-matting --image=$AR/matting:$TAG --region=asia-south1 --cpu=4
  --memory=16Gi --concurrency=1 --min-instances=0 --max-instances=20
  --timeout=300`.
- `gcloud run deploy catalog-matting-gpu --image=$AR/matting-gpu:$TAG --region=asia-southeast1
  --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy --cpu=4 --memory=16Gi --concurrency=1
  --min-instances=0 --max-instances=3 --timeout=300` (GPU flags confirmed with Context7 against the
  current Cloud Run GPU docs before use; the default quota is 3 L4s; asia-south1 GPUs are
  invitation-only, which is why the GPU twin lives in asia-southeast1; cross-region egress of about
  1 MB per image is cents per batch). If the GPU deploy is refused for quota, deploy.sh prints the
  quota request and continues; the worker then runs everything on CPU.
- Worker env `MATTING_URL=https://catalog-matting-<project-number>.asia-south1.run.app` and
  `MATTING_GPU_URL=https://catalog-matting-gpu-<project-number>.asia-southeast1.run.app` (unset when
  the GPU service is not deployed).
`--concurrency=1` is a builder constant (one matte at a time per instance) that 09 may raise.
`bootstrap.sh` gets `ensure_sa catalog-matting "Catalog matting"` if 02 did not already create it;
`catalog-worker@` already holds `roles/run.invoker` at project level, which covers both services. No
GCE VM anywhere. `cloudbuild.yaml` gets two steps, `matting` (`--target cpu`, image
`${_AR}/matting:${_TAG}`) and `matting-gpu` (`--target gpu`, image `${_AR}/matting-gpu:${_TAG}`),
both from `services/matting/Dockerfile` with `--build-arg GIT_SHA=${_TAG}` so `/health` reports the
git short SHA.

Expected speed and cost, measured in tier 3 and written in the report: CPU about 4 to 8 s per image
for `birefnet-general-lite` and 10 to 20 s for `birefnet-general`; 20 CPU instances at 6 s give about
12,000 images per hour (4,800 at 15 s); one L4 at about 0.4 s gives about 9,000 per hour, three give
27,000. For 24,000 sources: CPU about USD 23 (lite) to USD 58 (general); a 2048 px model on CPU would
take about 400 instance-hours (USD 230), far past the 2-hour target, and on an L4 about 11 hours
(USD 13). These are planning figures; the measured `x-ms` columns from both services replace them.

### `catalog-local` render mode

```
node dist/catalog-local.js render --manifest <out>/manifest.json --channels noon,styli,... [--matting http://localhost:8080] [--matting-gpu <url>] [--model birefnet-general] [--product-type footwear] --out <dir> [--limit N] [--upload gs://image-links-agent-assets/catalog-test/<run-id>/]
```

Reads the manifest written by `catalog-local collect` (04), runs `prepare` (with `convert` for any
HEIC), `matteFor`, `planProduct`, `renderAllChannels` and `checkOutput` for every shot, writes
`<out>/<channel>/<identifier>_<n>.jpg`, `<out>/report.json` (`{ outputs: [{ identifier, n, channel,
status, plan, bytes, quality, flags, compliance, matte: { model, target, sentLongSide, ms } }],
summary: { outputs, compliant, skipped, failed, flagsByKind, msMatteAvgByTarget: { cpu, gpu },
msRenderAvg } }`) and `<out>/contact-sheet.jpg`. With `--upload`, each
output is also written under the given prefix (must start with `catalog-test/`; `assertTestPrefix`
enforces it and the command refuses anything else) so the real-data test can check public-URL style
paths without touching the public bucket. `--limit` is for development loops only.

### Env vars (from the consolidated table in 02; this spec adds these rows)

| Name | Default | Used by |
|---|---|---|
| `MATTING_URL` | none (worker refuses to matte without it; local `http://localhost:8080`) | worker, catalog-local |
| `MATTING_GPU_URL` | unset (optional; every model runs on CPU when unset) | worker, catalog-local |
| `MATTE_MODELS` | `birefnet-general,birefnet-general-lite,birefnet-hrsod,bria-rmbg` | matting |
| `DEFAULT_MATTE_MODEL` | `birefnet-general` | matting only; the worker takes `default` from `/health` or a `model_policy` row (07) |
| `MATTE_TARGET` | `cpu` (set to `gpu` in the gpu image) | matting; reported in `/health` |
| `MATTING_BREAKER_FAILURES` | `5` | worker (`BREAKER_FAILURES`) |
| `MATTING_BREAKER_COOLDOWN_MS` | `60000` | worker (`BREAKER_COOLDOWN_MS`) |
| `MATTING_TIMEOUT_MS` | `180000` | worker (`MATTING_TIMEOUT_MS`) |

### Builder constants (not in the sheet; set once, named, tested)

Image constants, tuned in 08 on the golden set: `ALPHA_BBOX_THRESHOLD`, `BG_UNIFORM_STDEV`,
`BG_TOLERANCE`, `FLOODFILL_TOLERANCE`, the shadow band percentages (10% above, 25% below, 10% each
side as written above), `SHADOW_MIN_DARKNESS` (0.04), `SHADOW_MAX_DARKNESS` (0.6),
`SHADOW_SYNTH_INTENSITY_GREY` (0.25), `SHADOW_SYNTH_INTENSITY_WHITE` (0.15), the synthesised shadow
presets (softness, intensity, spread, direction, pose), `MAX_INPUT_BYTES` (40 MB, matching 04's fetch
cap), `HEALTH_TTL_MS`. The send size is not a constant: it comes from `/health` per model.
Operational constants, tuned in 09 under fault injection and load: `BREAKER_FAILURES`,
`BREAKER_COOLDOWN_MS`, `MATTING_TIMEOUT_MS`, service `--concurrency`, the CPU service's memory
choice. Each lives in one place with a comment, and `BG_TOLERANCE` is derived by a unit test that encodes a flat
`#E0E0E0` and `#FFFFFF` canvas at quality 70 with 4:4:4 and measures the maximum per-channel
round-trip error; the constant must be at least that error and the test fails if it is not.

## Build order and workstreams

Workstream A "matting-service" (worktree `catalog-module-wt/05-matting-service`):
`services/matting/*`, `cloudbuild.yaml`, deploy and bootstrap changes for both services. Python
only. Builds the CPU image locally (`docker build --target cpu -t catalog-matting services/matting`),
builds the GPU target at least once in Cloud Build, and runs `pytest`.

Workstream B "render-core" (worktree `catalog-module-wt/05-render-core`): `render.ts`, `shadow.ts`
(decision rule, preserve, synthesise), `compliance.ts`, `contact-sheet.ts`, with a fake matte
(synthetic alpha) and a fake `convert`. Depends on 02 only.

Workstream C "matte-client-cli" (worktree `catalog-module-wt/05-matte-client-cli`): `matte.ts`
(client over two services, send size per model, convert, breakers, flood fill, upscale),
`catalog-local render` and `--upload`, `build.mjs`. Uses fake HTTP servers in tests.

Integration: merge A, B, C; start the CPU container locally; deploy both services; run tier 3 against
the local CPU container and the deployed GPU service; produce the contact sheets.

## Test plan

Tier 1 (unit, vitest, sharp-generated images; deterministic byte-for-byte on repeat):
- `prepare`: EXIF-rotated JPEG comes out upright; CMYK JPEG -> srgb; PNG with alpha -> `alphaSource`
  and flag; 2-frame GIF -> first frame; AVIF fixture decodes; 400 px image -> `small_source`; a HEIC
  fixture goes through the injected `convert` (a fake returning a PNG) and comes out as a normal
  `Prepared` with `sourceMime = image/heic`; a BMP -> `UnsupportedSourceError` with the BMP sentence.
- `bbox`: synthetic alpha shapes; empty alpha -> null.
- `planCanvas`: for every channel, a tall box, a wide box and a detail box; checks `C` within
  min..target, aspect kept, `lowResolution` when `sFit(min) > 1.5`, Noon side margin only when wide,
  Styli bottom anchor and guides, uniform scale never exceeding the per-shot fit.
- `planProduct`: three shots -> the minimum fit; a detail shot excluded; applied only for channels
  with `uniformScaleDefault`.
- `shadow` decision rule: a synthetic grey ellipse under a rectangle on a uniform white -> preserved
  layer non-zero only in the band and never under the product, no flag; the same with a faint
  ellipse below `SHADOW_MIN_DARKNESS` and product type `footwear` -> synthesised layer with
  `shadow_synthesised`, its intensity at `SHADOW_SYNTH_INTENSITY_GREY` on `#E0E0E0` and
  `SHADOW_SYNTH_INTENSITY_WHITE` on white; a near-black sweep -> darkness clamped to
  `SHADOW_MAX_DARKNESS`; a vignette in a corner not touching the bbox bottom -> dropped; the same
  faint case with `apparel_model` -> no layer and `no_shadow_source`; an `alpha_source` matte with
  `footwear` -> synthesised, with `apparel_flat` -> none; a non-uniform background with `other` ->
  synthesised; a synthesised shadow never reaches the border band (compliance `background` passes).
- `renderSource` then `checkOutput`: every channel, shots 1 and 2, passes with `ok: true`; a
  deliberately wrong canvas colour fails `background`; a shifted placement fails `inside_safe_box`
  or `styli_anchor`; a 4:2:0 encode fails `format`; a path ending in `.jpeg` or `.JPG` fails
  `extension`; a 2.5 MB synthetic noise image steps quality down and either passes or fails `bytes`
  with the sentence; a small source on styli is `skipped` with the Styli note and no JPEG; the same
  source on noon is `ok` with `low_resolution` and the two attention sentences with the right
  numbers.
- `renderKeyInputs`: the exact string for a known input; a bumped `CHANNEL_RULES_VERSION` changes it.
- `passthrough`: an already compliant JPEG is re-encoded only (flag present, pixels unchanged
  within `BG_TOLERANCE`).
- `BG_TOLERANCE` derivation test as described.
- `matte.ts`: two fake servers with different `/health` model lists; a model listed by both goes to
  the gpu one; a model listed only by cpu goes there; a model listed by neither throws a clear error;
  `sendLongSide` gives 1024 for a built-in, 2048 for an HR id, and for `native` the rounded and
  clamped source side (checks at 300 px, 1000 px, 5000 px); the request body's long side equals
  `sendLongSide`; upscale returns the source size; each service's breaker opens after
  `BREAKER_FAILURES`, the cpu service is tried while the gpu breaker is open, flood fill with
  `fallback_matte` when the chosen service is open, half-open after the cooldown, closed on success;
  `convert` posts to the cpu `/convert` and returns the body, and its failure does not count towards
  any breaker; `floodFillMatte` on a synthetic product-on-white gives alpha 0 at the corners and 255
  inside the product.
- `compliance.ts`: each failure code reachable by one synthetic case.

Tier 2: not applicable (no DB in this spec); the worker integration is in 06.

Python (`services/matting/tests/test_app.py`, run in the builder worktree and in the Docker build):
- `/health` returns the shape above with the four models, each with `inputSize` 1024 and the
  image's `target`, plus `default` and `version`; `/matte` on a synthetic 256 px product-on-white PNG
  returns a PNG of the same size with mask values 0 at the corners and 255 at the centre, headers
  present; a test asserts (by inspecting the call) that `remove()` received an explicit `session`;
  unknown model -> 400; non-image -> 400; `/convert` on `fixtures/small.heic` returns a PNG of the
  file's dimensions with `x-input-format: heic`; `/convert` on a JPEG -> 400.

Tier 3 (`REAL_DATA=1 pnpm test:real`, `packages/core/src/catalog/render.real.test.ts`; requires the
CPU container running at `MATTING_URL=http://localhost:8080`, built from the branch, and, when
deployed, `MATTING_GPU_URL` pointing at `catalog-matting-gpu`; inputs come from 04's `catalog-local
collect`):
- Anta: `catalog-local collect` on `C:\Users\Sujan AH\Desktop\opptra-image-links\new_resources_4\Images`
  (630 footwear, 800x800 on pure white) then `render` for all nine channels with
  `--product-type footwear`; asserts every non-skipped output `compliance.ok` (100%), every Amazon
  and Shein shot 1 white, every Styli output `skipped` with the Styli note (800 px sources cannot
  reach 2342 px within 1.5x), adaptive canvases for the other channels within min..target, and the
  contact sheet written. Shadow assertion (conditional, because the Anta set is pure white and may
  carry no cast shadow): a preserved shadow layer is present for every footwear source whose band
  darkness exceeds `SHADOW_MIN_DARKNESS`; every other source carries `no_shadow_source` or
  `shadow_synthesised`.
- Both services measured: a sample of 100 Anta sources is matted with `birefnet-general` and
  `birefnet-general-lite` on the CPU container and, when `MATTING_GPU_URL` is set, on the GPU
  service; the report prints `x-ms` averages per model and per target as two columns, and the
  speed figures above are replaced by these in the PR.
- French Connection: `new_resources_3\French Connection Final` (3,280 apparel, 800x1200 on white)
  with `--product-type apparel_model`; same assertions; additionally no output has a product pixel
  outside the safe box and Noon side margins behave for the wide shots if any.
- Both runs use `--upload gs://image-links-agent-assets/catalog-test/<run-id>/` for a sample of the
  outputs (the test chooses the sample; the full set stays on disk), then verify each uploaded object
  with HEAD (`image/jpeg`, matching size), `FF D8 FF` on a range read and a path ending in `.jpg`,
  then delete the prefix in `finally` and assert `listObjects` is empty.
- The report's `msMatteAvgByTarget` and `msRenderAvg` are printed and pasted in the PR (planning
  figures: 4 to 8 s per image for `birefnet-general-lite` and 10 to 20 s for `birefnet-general` on
  CPU, about 0.4 s on an L4, about 0.5 s per rendered output; the measured numbers win).
- Human check: the integrator opens both contact sheets and confirms in the PR body that products
  are whole, centred (or bottom-anchored for Styli), on the right grey, with no visible halo on the
  white-on-white French Connection garments. Any doubt is listed, not hidden.

Tier 5 is not yet available; the smoke script arrives in 06.

## Done criteria

- Both images build (`cpu` and `gpu` targets); the CPU image passes pytest, runs locally and on Cloud
  Run as `catalog-matting` with min-instances 0; `catalog-matting-gpu` is deployed in asia-southeast1
  (or the quota request is recorded); `/health` on each lists its models with `inputSize` and
  `target`; `/convert` turns a HEIC into a PNG; the worker can call both with OIDC as
  `catalog-worker@` (verified once from the deployed worker's logs or a Cloud Run job).
- Every `remove()` call passes an explicit session; the send size comes from `/health` per model.
- `renderSource` + `checkOutput` produce 100% compliant outputs on both real sets for all nine
  channels, with the flags described, Styli skips applied, the shadow decision rule applied with its
  flags, and the contact sheets were viewed.
- The breakers and flood-fill fallback are unit tested; no path can fail a whole batch because a
  matting service is down.
- Model licences are listed per model in `services/matting/README.md`.
- `catalog-local render` and `--upload` work; `--upload` refuses any prefix outside `catalog-test/`.
- No product pixel is ever regenerated; no crop path exists in the code: a grep for `fit: "cover"` in
  `render.ts` finds nothing, and the only `extract(` call is the cut of the matted product to its own
  bounding box (step 6), which by construction contains every product pixel.
- `renderKeyInputs` exists and 06 can compute `render_key` from it; `extension` is a compliance check.
- `pnpm lint && pnpm typecheck && pnpm test` green; CI green; `bootstrap.sh` second run all SKIP.

## Merge, deploy, report

Follow `00-execution-protocol.md`. This spec deploys `catalog-matting`, `catalog-matting-gpu` and
the worker (new env vars) with `infra/deploy.sh`. The report includes the two compliance summaries,
the Styli skip counts, the shadow flag counts, the matte times per model on CPU and GPU as two
columns, the render times, the memory choice for the CPU service, the contact sheet paths, and the
note that `birefnet-hr-matting`, `birefnet-dynamic-matting`, `birefnet-hr` and `ben2-base` (our id
for a `ben_custom` session with our ONNX) are built in spec 08 as custom sessions. Report ends with
"Ready for the next spec: 06 Pipeline and UI".
