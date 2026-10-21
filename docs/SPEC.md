# Catalog module - specification

## What this document is

This is the source of truth for the `catalog-module` repository; `CLAUDE.md` points here. It condenses
every product and engineering decision. The executable specs live in `docs/specs/` (00 to 09); each is
self-contained and carries the column, route and test detail for its slice. Where this document and a
spec disagree, this document wins and the spec is corrected. The clickable prototype
`docs/prototype/catalog-prototype.html` (version 2, https://claude.ai/artifact/HL7t82VTQ1bRchziPwLySr)
is the UI contract: every screen, state and sentence the operator sees comes from it, plus the additions
listed under "UI" below. Names used in more than one place (tables, routes, enums, functions, env vars)
are written exactly as in the specs; no synonyms.

Glossary (plain words for terms used throughout):
- Product: one style+colour of one brand, never a size. Known by its identifier (`ABC123` in `ABC123_1.jpg`).
- Opptra SKU id: the warehouse product code, one per size, so a product usually has several. May not exist yet.
- Channel: a marketplace with its own image rules (Noon, Namshi, Trendyol, Styli, Centrepoint, 6thStreet,
  VogaCloset, Amazon, Shein).
- Output: one finished image for one channel and one shot. Public link: its `https://storage.googleapis.com/...`
  address. Overwrite in place: new bytes at the same address. Generation: the number GCS gives every write
  of an object; with bucket versioning on, the previous write is kept for a while as a noncurrent version.

## Goal

Turn a brand's raw product photos into marketplace-ready images for every channel the operator ticks and
return one sheet of public links. One brand per batch, hardline and softline. Nine channels. The product
owns its images: its links are fixed the first time it is processed, and a later upload of the same
product replaces the pictures behind those links. Everything runs in GCP project `image-links-agent`,
region `asia-south1`. The operator is non-technical: the UI shows no model names and no technical
configuration. Access is by Google sign-in with three roles (admin, operator, viewer).

## Decisions log

- Fresh repository `catalog-module` (pnpm monorepo: `@catalog/core`, `@catalog/web`, `@catalog/worker`,
  Python `services/matting`). Code from the earlier app is lifted and adapted, never imported as a package.
- Same GCP project `image-links-agent`, `asia-south1`; shared resources (`ila-pg`, `ila-vpc`, Artifact
  Registry `apps`, bucket `image-links-agent-assets`, secret `openrouter-api-key`) are reused, never deleted.
- Google sign-in through Cloud Run IAP (`gcloud run deploy --iap`, Google-managed OAuth client, so no
  console step and no OAuth client of ours) with `domain:opptra.com` granted `roles/iap.httpsResourceAccessor`;
  the app verifies the IAP JWT and applies roles `admin | operator | viewer` from its `users` table.
  `sujan@opptra.com` is seeded as admin; every other `@opptra.com` account becomes a viewer on first
  sign-in; admins promote people in the People modal. The owner adds the operator (Naaz) himself.
- Closed by the owner: Styli rejections carry no size-versus-softness information; the rule is to follow
  the Styli guideline sheet (no Styli-only `MAX_UPSCALE`; `sr_pass` stays an optional bake-off
  experiment). Licence: any open-weight model may be used for this internal tool regardless of
  non-commercial terms, so NC models (`bria-rmbg` and others) are full candidates and may become
  policy defaults; the licence table stays as a record.
- Image enhancement (approved 2026-10-20, spec 11): a conservative unsharp mask after any enlargement
  in the render, and an upscaler (x2, deterministic, on the GPU service) allowed in the default path
  behind the flag `UPSCALE_MODEL`, chosen by the fidelity gate of spec 11 and used only when the
  enlargement exceeds `UPSCALE_MIN_SCALE` (1.5); its outputs carry the information flag `upscaled`,
  never a hold. Decided by the owner 2026-10-21: the upscaler is on by default (`swinir-x2`, deploy.sh;
  `UPSCALE_MODEL=off` turns it off) for every channel wherever a photo is enlarged beyond 1.5x, and the
  x2 upscale un-skips Styli: Styli judges the size after the upscale, so its source floor is 741 px with
  the upscaler (1,482 px without). No paid image API without a separate owner yes.
- Product identity and overwrite: the product (brand + style+colour identifier) owns its public images.
  Opptra SKU ids are attributes, never part of a link. A re-upload overwrites in place and deletes the
  shots the new upload no longer has. Batches are events; product state is the truth. Marketplaces keep
  their own copy and must be re-synced after a change.
- Prototype v2 is the UI contract. Copy, states and vocabulary are taken from it; the added pages
  (product page, brand page, overwrite preview, "Not refreshed" line) follow the same style.
- Follow the channel guideline sheet exactly; where it is silent nothing is added. Light grey `#E0E0E0`
  everywhere; Amazon and Shein image 1 pure white. Styli: every Styli image on the 2342x3123 canvas
  with Styli's guides. Never crop. No cap on images per product or per channel; the input decides.
- Channels are chosen each time; nothing is pre-ticked and no defaults are stored.
- Output files are `.jpg` everywhere: every public object path and every link in a sheet ends in
  lowercase `.jpg`. `publicObjectPath` is the only function that builds a public path; a unit test
  asserts the suffix and the re-check asserts it too.
- HEIC/HEIF photos are supported, never "unsupported": `catalog-matting` converts them with `pillow-heif`
  (`POST /convert`) before the worker decodes them. `unsupported` is kept for BMP and other formats that
  cannot be decoded.
- A filled copy of an uploaded product-list workbook is a deliverable alongside the links sheet: every
  sheet, column and value kept, `link_status` and the channel link columns appended on the right.
- No language model takes part in grouping, counting, column detection, SKU resolution or link
  construction; those are deterministic code with unit tests. Models are used only for the QA judge and
  the product-type classifier.
- Supabase is only ever read. Test cleanup only under `catalog-test/`. No GCP deletes without asking.
- Models are chosen automatically per brand and category by a bake-off and are never shown to the operator.
- Testing is extensive: real images of every brand, end to end, and human-like browser runs on the
  deployed URL; guardrails so nothing fails or breaks silently.
- Delivery model: numbered specs executed in order by a manager agent that delegates to subagents, one
  worktree per workstream, merge via PR, deploy, report "Ready for the next spec". No human input in between.

## Requirements register

Ingestion
- R1 One brand per batch, chosen first from the full Opptra brand list (hardline and softline).
- R2 Inputs: a folder or zip of images, a sheet of image links, or both. Links are downloaded first.
  Sources are flexible: local folders, zips, Google Sheets, Drive folders, sheets with URLs, pasted lists.
- R3 Group by identifier from the filename stem `<identifier>_<n>` (also `-<n>`, `_0<n>`); a shot number
  has at most three digits, so a trailing number of four or more digits is part of the identifier; shot
  `n` is the position of the file in the product's upload, counted 1..k in the order of the file-name
  numbers, so a gap never leaves a blank cell and is noted as `numbering_gap`; any number of shots per
  product. Identifier = one style+colour, never a size (a sheet with separate style and colour-code
  columns gives the composite `<style>_<colour code>`); Styli uses the option ID.
- R3a Optional product list (item master or option list): every row gets
  `link_status = ok | missing_images | not_in_sheet`.
- R4 Opptra SKU ids are optional attributes of the product. They may arrive at ingest (warehouse
  masters), later (nightly sync, a mapping sheet, a product list) or never. Raw images carry no SKU id.
  A missing SKU id is never a warning.
- R5 Report every product without images, every image without a product row, duplicates, unsupported
  and failed files. Nothing is dropped silently.
- R5a Link-sheet inputs are often earlier deliveries pointing at Supabase; those stay readable.

Channel rules
- R6 Follow the guideline sheet exactly per channel; where it is silent nothing is added.
- R7 Light grey `#E0E0E0` background on every channel; Amazon and Shein image 1 pure white `#FFFFFF`.
- R8 Styli: 2342x3123 canvas, guides top 450, bottom 450, left 150, right 150 px, product bottom-centre,
  identical placement on all angles, no white borders or gaps on detail shots, no mixed products.
  Low-resolution sources are skipped for Styli by agreement with Styli and listed in the sheet notes.
  The agreement applies to the size after the x2 upscaler when it is on (owner 2026-10-21): a photo is
  skipped only when even its x2 image would need more than 1.5x (source under 741 px high; 1,482 px
  without the upscaler, `styliMinSourceHeightPx`).
- R9 Trendyol: HTTPS link, no spaces in the filename. Edited images are platform-exclusive.
- R10 Channels are chosen per batch; nothing is pre-ticked and no defaults are stored. The grouping
  P1 (Namshi, Noon, Trendyol, Amazon) / P2 (Styli, 6thStreet, Centrepoint, VogaCloset, Shein) is
  information only.
- R10a Links are self-describing: brand, product, channel and shot are in the path. No batch id.

Image policy
- R11 Never cut any part of the product or model; pad instead of crop.
- R11a Styli placement is consistent across the angles of one product.
- R12 JPEG, sRGB, DPI and 2 MB per the sheet; low-resolution sources are reported, not hidden.
- R12a Output size adapts between the sheet's minimum and target instead of blind upscaling
  (real inputs can be 800x800).
- R12b Rules are platform requirements, not product requirements; hardlines follow the same sheet.

Output
- R13 One sheet per batch: `brand`, `identifier`, `option_id_style_color`, `opptra_sku_ids`, then per
  selected channel a merged header over `Image 1..N`; public clickable links; only selected channels;
  tail columns `status`, `notes`, `change`, `changed_at`.
- R14 A product's links are fixed on first delivery:
  `catalog/<brand>/<path_key>/<channel>/<path_key>_<n>.jpg`. A later upload of the same product writes
  new bytes at the same links and deletes the product's own objects that the new upload no longer has;
  it never touches another product's objects or channels the batch did not select. Links already pasted
  into marketplace templates keep resolving; the marketplace's own copy must be re-synced by the operator.
- R14a Opptra SKU ids are attributes of the product (several per style+colour, optional at ingest, may
  arrive later, may change). They go into the sheet and never into a path; when they arrive nothing moves.

Scale, operations, cost, people
- R15 Thousands of images per batch in about 2 hours, in parallel.
- R15a Volumes: 2,700 USPA options now, about 3,350 more soon (BHPC 250, Anta 140, Cardio Bunny 49,
  Keds 56, USPA footwear 30, Vero Moda 120, ...), 3-5 images each, about 4 channels: about 6,050
  options, 24,000 sources, 100,000 outputs.
- R16 Model and compute cost recorded per batch and attributed to the brand; benchmark INR 60 per
  style+colour.
- R16a Cost is attributed to channels and images by one rule. Render, upscale and publish cost is
  direct per channel. Cut-out (matte), product-type check (classify) and quality check (judge) cost
  belongs to the source image and splits evenly across that image's non-skipped outputs. Worker
  compute per chunk splits evenly across the chunk's non-skipped outputs. Per-image cost = its direct
  rows plus its shares. The ledger table `catalog_cost_events` records every priced or timed event;
  the rule is applied when reading, not stored. The per-channel and per-image breakdown is shown on
  the admin Ops page (`/catalog/ops`); the batch page keeps its cost line. There are no spending
  alerts, and the daily and per-batch caps are unchanged.
- R17 UI for a non-technical operator; no model or technical configuration exposed; what a person can
  do is decided by their role.
- R18 Everything in GCP, per brand, raw and transformed.
- R19 Prove it works before relying on it; keep measuring.
- R20 Every attention reason has a manual-fix route in the UI: "Use as is", "Remove this photo",
  "Replace photo N".
- R21 Zero review by default: images that pass go straight into the sheet. Only products with a
  problem appear under "Needs attention", grouped by product, showing only the problem photos.
- R22 Roles: anyone with an `@opptra.com` Google account can view; operators create batches and resolve
  attention items; admins manage people.
- R23 A filled copy of an uploaded product-list workbook is part of the deliverables.
- R24 The finished sheet passes an independent re-check before the batch is shown as Ready.

## Channel specification (exactly the sheet; data lives in `packages/core/src/catalog/channels.ts`)

| id | min canvas | target canvas | margins | anchor | background | dpi | sheet text and notes |
|---|---|---|---|---|---|---|---|
| noon | 660x900 | 1080x1480 | top 10%, bottom 10%, side 5% (horizontal shots) | centre | `#E0E0E0` | 72 | "660x900 (min) -> 1080x1480+, >=72 PPI, <=2 MB, 0.73 (3:4)" |
| namshi | 660x900 | 1080x1480 | top 10%, bottom 10% | centre | `#E0E0E0` | 72 | "= Noon rules" |
| trendyol | 600x800 | 1200x1800 | none in sheet | centre | `#E0E0E0` | 96 | "600x800 @72 (min) -> 1200x1800 @96, <=2 MB, 3:4, HTTPS, no spaces"; accepted files are 1200x1800 |
| styli | 2342x3123 | 2342x3123 | guides top 450, bottom 450, left 150, right 150 px | bottom-centre | `#E0E0E0` | 300 | sheet "1200x1600 -> 2000x2667"; email canvas applies to every Styli image [U] |
| centrepoint | 3000x3000 | 3000x3000 | none in sheet | centre | `#E0E0E0` | 300 | "3000x3000, >=300 PPI, 1:1" |
| sixthstreet | 1200x1600 | 2000x2667 | none in sheet | centre | `#E0E0E0` | 300 | "1200x1600 -> 2000x2667, 3:4" |
| vogacloset | 1200x1600 | 2000x2667 | none in sheet | centre | `#E0E0E0` | 300 | same as 6thStreet |
| amazon | 1000x1000 | 2000x2000 | none in sheet | centre | img 1 `#FFFFFF`, rest `#E0E0E0` | 300 | "1000x1000 -> 2000x2000, 3:4 portrait, first image pure white" |
| shein | 1000x1000 | 2000x2000 | none in sheet | centre | img 1 `#FFFFFF`, rest `#E0E0E0` | 300 | "exactly Amazon" |

"None in sheet" = margin 0: the product is fitted to the full canvas on its limiting dimension and
centred. Noon's "(horizontal shots)": the 5% side margin is the minimum when the product is wider than
tall. Common: JPEG 4:4:4, sRGB with ICC, quality 90 stepping down to 70 until <= 2,000,000 bytes, EXIF
applied then stripped, JFIF density set. Adaptive canvas: the largest size between min and target that
keeps upscaling <= 1.5x; below that, the min canvas with a `low_resolution` flag; Styli (fixed canvas)
flags, and the constant `STYLI_SKIP_LOW_RESOLUTION = true` (an agreement with Styli, always applied,
not an operator option) excludes such images from the sheet with a note; with the upscaler on, Styli
judges the enlargement left after the x2 upscale (`fit(min) / 2 > 1.5` skips), and a photo let through
is still made if the upscale call then fails, flagged `low_resolution` with the soft note. Any enlargement (scale > 1)
is followed by a conservative unsharp mask on the RGB only (spec 11); an enlargement past
`UPSCALE_MIN_SCALE` (1.5) goes through the x2 upscaler when `UPSCALE_MODEL` is set, Lanczos otherwise
(spec 11; `render_key` carries the upscaler id and version).

Spec 05 clarifications approved by the owner: adaptive canvases retain the target aspect and meet
both listed minimum dimensions, even when the minimum has a different aspect (Trendyol's effective
minimum is 600x900). The channel table stays unchanged. Fixed canvases retain exact dimensions,
including Styli's 3123 px height. Background compliance checks exposed border background and all
required margins; foreground is allowed at zero-margin edges under the full-canvas fit rule.

Constants: `JPEG_QUALITY_START = 90`, `JPEG_QUALITY_MIN = 70`, `JPEG_QUALITY_STEP = 5` (builder
constant), `MAX_OUTPUT_BYTES = 2_000_000`, `MAX_UPSCALE = 1.5`, `DETAIL_SHOT_BBOX_FRACTION = 0.85`,
`MIN_SOURCE_LONG_SIDE_PX = 500`, `STYLI_MIN_SOURCE_HEIGHT_PX = 1482`, `CHANNEL_RULES_VERSION` (bumped on
any rule change; part of `render_key`). Labels: Noon, Namshi, Trendyol, Styli, Centrepoint, 6thStreet,
VogaCloset, Shein, Amazon. Groups P1 and P2 are information only; nothing pre-ticked, no stored defaults.

## Ingestion sources

One drop zone plus one text box ("Or paste a link"). The system detects what it got and shows the
grouping in "Check what we found" before anything is processed. Every source becomes `catalog_products` +
`catalog_source_images` pointing at `raw/` objects in the private bucket. Adapters live in
`packages/core/src/catalog/ingest/*.ts` behind one interface `collect(input) -> SourceItem[]`.

| Source | Operator action | System | Identifier / order |
|---|---|---|---|
| Local folder or files | drag the folder or select files (relative paths kept) | direct-to-GCS signed PUT per file, parallel, progress | filename stem; subfolder name when files are `1.jpg, 2.jpg`; Rectangle/Square folder adds `_rect`/`_square` |
| Zip(s), hundreds of MB | drag | signed PUT; worker expands by GCS range reads; nested folders walked; `__MACOSX`, dotfiles skipped | same |
| Links sheet (xlsx/csv) | drag | parsed on the worker; identifier column and URL columns detected (URL = http(s) in at least half the cells or header says url/link/image); override in "Check what we found" | identifier column; URL column order = shot order; cells split on `,`/`;` |
| Google Sheet link | paste URL | sheet shared with `catalog-web@image-links-agent.iam.gserviceaccount.com` (shown with a Copy button and an instant access check); Sheets API; else drop the xlsx | same as links sheet |
| Google Drive folder link | paste URL | folder shared with the same address; Drive API lists recursively and streams to `raw/`; if Workspace policy blocks it the wizard asks for a zip | same as folder |
| Pasted image URLs | paste one per line, optionally `identifier<TAB>url` | SSRF-safe fetch (Supabase, `sceimage.blob.core.windows.net`, any https; manual redirects; 40 MB cap) | pasted identifier, else URL filename stem |
| Product list (xlsx/csv) | drag, mark as "product list" in "Check what we found" | parsed; identifier (and EAN) column detected or chosen | gives `link_status` and SKU mapping keys |
| WeTransfer, email attachments, Dropbox | manual download and drop (no API, or not needed now) | | |

Rules for all sources:
- Shot names: `parseShotName` reads the number after the last `_` or `-` (`_<n>`, `-<n>` and `_0<n>` all
  at once; there is no separator setting). A shot number has at most three digits; a trailing number of
  four or more digits is part of the identifier (`ONLY-SHOES_Autumnwinter_5079628_15380145.jpg` is shot 1
  of that whole stem). A product whose single file carries no shot number gets `n = 1`; several unnumbered
  files are rejected with "Files for <identifier> have no shot numbers: <names>. Rename them
  `<identifier>_1.jpg`, `<identifier>_2.jpg`."
- Numbering rule (decided here): shot `n` is the position of the file in the product's upload, counted
  1..k in the order of the numbers in the file names (`_1`, `_2`, `_4` become positions 1, 2, 3); object
  paths and the sheet use positions, so there is never a blank cell for a gap; a gap flags `numbering_gap`
  and the row's `notes` says "Shot numbers <list> are missing in the upload; images shifted left in this
  row."; the original file name is kept in `original_name`. The order files arrived in, or their order in
  a zip or folder listing, never affects shot order.
- Telling products apart is chosen in "Check what we found" (`identifierMode`: by file name before the
  last number, recommended; by folder name; by the identifier column in the sheet) with three example
  rows, and step 4 announces it in words ("Grouped by file name (`<identifier>_<n>`)", "Grouped by folder
  name", "Grouped by the sheet column `<header>`", "Grouped by style and colour code (`<style>` +
  `<colour>`)", "Matched by style and colour code found inside the file names"). A parent or grandparent
  folder whose lowercase name starts with `rect` adds `_rect`; one starting with `sq` adds `_square`.
- Precedence when both uploaded photos and links exist: the operator picks `uploads_then_links`
  (recommended), `links_only` or `uploads_only`; by default uploaded bytes win over sheet URLs for the
  same `(identifier, n)`.
- Sheets: headers are compared after lowercasing and removing everything that is not a letter or digit;
  the header row is the first row where at least half the cells are text and two match known headings
  (title rows above it are ignored). An EAN, barcode, GTIN or UPC column is never the identifier (it is
  kept as `eanColumn` for SKU mapping). When no identifier column matches but a style column and a
  colour-code column exist, the identifier is the composite `<style>_<colour code>`; a colour-name column
  is display only. Detection never guesses: when no column can be identified the upload is marked
  "cannot read" with "Could not tell which column holds the identifier." and Continue stays disabled
  until the operator picks one. Each sheet shows "Sheet `<name>`: identifier column `<header>`, <m> image
  columns, read as <links sheet | product list>" with Change; the identifier column, the image columns
  and the sheet kind are real controls, and saving re-runs grouping from `raw/` without re-downloading.
  When the same normalised identifier appears on several rows, the first row is used and step 4 warns
  "<k> identifiers appear more than once in `<sheet>`; the first row of each is used." A URL that does
  not return an image is reported by row and column; the product keeps its other shots.
- Product lists: a row matches `<id>_rect` and `<id>_square` by its base identifier (the row is `ok` when
  at least one shape has images; both shapes share the row's SKU ids). Size-level item masters
  (`<style>/<size>/<unit>`, `<style>-<size>`) match colourway identifiers by removing the trailing size
  segment, the way the `product_code` rule does; the preview says "<k> size rows matched <m> products."
  and every per-size Opptra SKU id found goes into `opptra_sku_ids`. A composite style+colour key matches
  a file stem when both tokens appear as whole `_`-separated segments of it. `missing_images` rows carry
  no links; `not_in_sheet` rows carry their links and the status word. The uploaded workbook is kept
  verbatim under `uploads/`; its match column and sheet names are recorded in `catalog_uploads.detected`
  so finalize can write the filled copy.
- Files: a duplicate `(identifier, n)` leaves that product out until one file is renamed ("<k> products
  have two files for the same shot number: <ids>."); HEIC/HEIF files are normal images (`image/heic`,
  converted by `catalog-matting`); BMP and corrupt files are listed with plain reasons ("<name> is a BMP
  file. Save it as JPEG or PNG and add it again."); more than one top-level folder with images warns
  "Your upload has <k> top-level folders (<names>). Everything in them will be filed under <brand>. If
  these are different brands, make one batch per brand." Every source is copied to
  `raw/<path_key>/<path_key>_<n>.<ext>` with its `sha256`; large collections run on the worker and
  self-continue ("Collecting files 48 of 310").
- No language model takes part in grouping, counting, column detection, SKU resolution or link
  construction; all of it is deterministic code with unit tests.
- The one share address `SHARE_SA_EMAIL` is shown only when a Google link is pasted; the worker reads what
  was shared as `catalog-worker@` (spec 04 says how one address is enough).

## Image policy and edge cases

- Fit, never crop: `scale = min(boxW/bboxW, boxH/bboxH)` into the safe box (canvas minus the sheet's
  margins, or the whole canvas); centre, or bottom-centre for Styli. Per-product uniform scale
  (`uniformScaleDefault` true for Styli) so angles line up; detail shots (bbox > 85% of the source frame)
  fill the safe box instead. One exception: a photo already cut in the source on both ends of one axis
  (top and bottom, or left and right) fills that axis so no band sits beside a cut edge; any overflow
  is trimmed off the other axis's already-cut sides only, never an uncut outline, and by at most a
  third of the product box plus 1% slack for the matte's soft edge (spec 05 step 4). A trim never cuts
  through a compact high-contrast feature that is whole in the source (a logo, text, a buckle): it stops
  short of it and the rest comes off the opposite cut side; where that cannot fill the axis the product is
  fitted and the sheet notes the band on that channel instead of claiming the cut edge sits flush.
- Backgrounds: one alpha matte per source; output = product RGBA over the target colour; product pixels
  are copied, never regenerated. Shadows follow the decision rule under "Models and model policy":
  preserve the original shadow as a darkening matte when it can be measured on a uniform background;
  otherwise synthesise a soft contact shadow for footwear, bags and hardline in an upright pose
  (`shadow_synthesised`, info) and never for apparel; `no_shadow_source` when nothing can be done.
  Already-compliant sources are re-encoded only (`passthrough`).
- Sources: jpeg, png (alpha respected), webp, tiff, gif/avif first frame; HEIC/HEIF converted to PNG by
  `catalog-matting` `POST /convert` (`pillow-heif`) in `prepare()` before sharp decodes it, never
  `unsupported`; BMP and other undecodable formats `unsupported` ("<name> is a BMP file. Save it as JPEG
  or PNG and add it again."); CMYK/ICC to sRGB; EXIF orientation applied; under 500 px long side flagged
  `small_source`; transparent PNGs use their alpha (`alpha_source`).
- QA-detected: watermarks, text or collages (`text_or_watermark`, `collage`, including small AI-tool
  marks such as a sparkle icon in a corner), wrong product in a set (`different_product`), cut body
  parts (`complete_product`), `halo`, `leftover_background`, `orientation`, `placement`, part of the
  product removed by the cut-out (`product_removed`, re-made like the other defects we produce), and size
  charts or text-only images (`chart_image`, left out with a note, never held).
- Matte-detected: a photo on a busy background no cut-out kept (`leftover_background` found by code at the
  matte stage, not by the judge; a hard hold:
  "The background could not be removed from this photo. Use it as is, replace it, or remove it."; the
  made picture is the whole photo as it is without the brand's canvas strips, never trimmed; a
  frame-filling close-up whose cut-outs all dropped the product is not a busy background).
- Other flags: `transparent` (attention: "This product looks transparent or glass; the cut-out may need
  a look."), `upscaled` (info, spec 11: "Enlarged with a quality pass to meet this marketplace's
  size."; never a hold),
  `shadow_synthesised` (info), `fallback_matte`, `low_resolution`, `small_source`, `duplicate_shot`,
  `numbering_gap`, `failed_compliance`, `qa_unavailable`, `qa_cap`, `qa_sampled_out`, `type_unknown`.
- Gaps in the file-name numbers close up into positions 1..k (the numbering rule above), flagged
  `numbering_gap` with the note "Shot numbers <list> are missing in the upload; images shifted left in
  this row." 50 or 100 shots per product simply widen the sheet.
  Path sanitisation (`sanitizeSegment`): spaces to `_`; letters, digits, `-`, `_`, `.` kept; case kept;
  the original identifier verbatim in the sheet.
- Product type: detected per product by default (`auto`: shot 1 classified as footwear, apparel on a
  model, apparel laid flat, bag or accessory, other) or forced for the batch; it drives the shadow band
  and detail-shot heuristics and the model policy row. A folder can mix types. Hardlines follow the same rules.
- Every case yields a flag (`OUTPUT_FLAGS`) with a plain-English reason on the "Needs attention" card and
  in the sheet's `notes`.

## Product identity and overwrite

- A product is brand + `product_key = normalizeKey(identifier)` (uppercase; spaces, `_` and `-` removed), so
  `ABC-123`, `abc_123` and `ABC123` are one product. `path_key = sanitizeSegment(identifier)` as first seen
  is fixed for life and is the path segment. `identifier` (verbatim, latest seen) is what the sheet shows.
  Unique per `(brand_slug, is_test, product_key)`; the same identifier in two brands is two products.
- Aliases (`catalog_product_aliases`, kinds `identifier | opptra_sku | option_id | channel_id | manual`):
  every known Opptra SKU id, option id and channel id is an alias, so a later upload named by SKU id lands
  on the same product. Matching at ingest: alias hit -> existing; `resolveSkus` option_key alias hit ->
  existing; else new (`path_key` set now and never again). Two spellings of one product in one batch are
  rejected in the preview ("ABC-123 and ABC123 are the same product. Keep one.").
- Opptra SKU ids are attributes (`opptra_sku_ids`): filled by `sku-mapping.ts` at ingest, the nightly sync
  (warehouse rows win), the "Add SKU ids" sheet or a product list. When they arrive: same path, same links,
  event `sku_ids_added`, sheet regenerated. Nothing is moved or renamed in either bucket.
- Public path `catalog/<brand_slug>/<path_key>/<channel>/<path_key>_<n>.jpg` (test: `catalog-test/...`),
  for example `https://storage.googleapis.com/image-links-agent-public/catalog/uspa/ABC123/noon/ABC123_2.jpg`.
  No batch id, no version suffix, no SKU id; always lowercase `.jpg`, built only by `publicObjectPath`.
  Shot `n` is the position in the upload; a reorder changes which photo sits at `_1`.
- Source versions: `catalog_source_images` rows per (product, n, version) with `sha256`, `batch_id`
  (brought by), `raw_uri`; exactly one `is_current` per (product, n); older versions keep their batch's `raw/`
  and get `customTime` set when superseded. Outputs: one `is_live` row per (product, channel, n) with the
  GCS `generation`; superseded rows keep `superseded_at` and `superseded_by_output_id`.
- Batches are events: a batch records which products and channels it touched, its counts, cost, report and
  sheet, and never edits itself after it finishes. `catalog_batch_products` holds the per-batch facts
  (`link_status`, `change`, flags, notes).
- Publish sequence per product (route `/tasks/catalog/publish`, idempotent): (1) render every (shot,
  channel) to `staging/` in the private bucket; compliance and QA run on the staged bytes; outputs whose
  `render_key` equals the live output's are marked `unchanged` and not rendered. (2) Gate: the product goes
  live only when every planned output is decided (`staged` pass, `use_as_is`, or `remove`), so a listing
  is never half new; products publish one by one. (3) Swap: `stageCopyToPublic` per object with
  `ifGenerationMatch` = live generation or 0 (a mismatch fails that output with "Changed by another run.
  Start the batch again for this product."). (4) Verify on the new bytes: public GET returns 200,
  `image/jpeg` (media type only; a `; charset` suffix is ignored), `content-length` = staged size, first
  bytes `FF D8 FF`, `x-goog-generation` = the copied generation; a failed check is retried once within
  the same delivery (copy again, GET again) and only the second failure marks the output `failed` with
  "Uploaded file could not be read back from the public link"; only after a pass `is_live = true`,
  `published_at`, `published_by`, previous row `superseded_at`. Every storage write, copy, delete and
  verify GET retries on 429, 5xx and network errors up to 3 times with backoff (1 s, 2 s, 4 s; builder
  constants); an output whose public object already verifies is never re-written.
  (5) Scoped deletes with `deletePublicObject` (`assertWithinProduct` first, `ifGenerationMatch`) of this
  product's shots no longer present, on the batch's channels only. (6) Event `created | overwritten |
  shots_removed | unchanged | reordered | channel_added`; `change` updated; finalize enqueued. Retry treats
  an object that already has the staged `crc32c` as copied and an already-gone delete target as done.
- `render_key = sha256(source sha256 | channel | CHANNEL_RULES_VERSION | policy id + updated_at | n)`.
  Same key as the live output -> `unchanged`, zero cost, nothing written; re-uploading identical photos
  is a no-op that still regenerates the sheet.
- Channels not selected are untouched. Batch page and report: "Not refreshed in this batch: <channels>
  (last delivered in batch <name>)".
- Locks: one product is held by at most one unfinished batch (`lock_batch_id`, set for all products in one
  transaction at Start, released at `done` or `failed`). Step 4 names busy products ("ABC123 and 4 others
  are still being processed in batch <name>. Wait for it to finish or remove them from this upload.").
  The sweeper (`/tasks/catalog/sweep`, Cloud Scheduler `catalog-sweep`) marks a batch with no chunk
  progress for 2 hours as `failed` and releases its locks. `ifGenerationMatch` is the second guard.
- Cache: `Cache-Control: public, max-age=300`, so GCS, Google's front end and browsers show a re-upload
  within five minutes. Marketplaces copy the image at listing time: after a re-upload the operator
  re-submits the image columns for products whose `change` is `updated`, `shots_removed` or `reordered`.
- Sheet = view of product state. Batch sheet (`links-v<k>.xlsx|csv`, `report-v<k>.json` under the batch's
  `exports/`): batch products x batch channels in the order ticked, live links at finalize, tail columns
  `change` (`new | updated | unchanged | shots_removed | reordered | pending_attention | failed`) and `changed_at`.
  A product waiting for attention shows its previous live links with status `needs_attention`. Brand
  sheet on demand (brand page) for any products and every live channel, under `<root>/<brand>/exports/`.
- Sheet writer rules (`sheet.ts`): `brand`, `identifier`, `option_id_style_color` and `opptra_sku_ids` are
  text cells (`numFmt "@"`) so a 13-digit identifier displays in full; both header rows bold and the sheet
  frozen below them; each column as wide as its longest value, capped at 60 characters, link columns at
  least 40; rows in natural sort order of `identifier`, so the same input always gives the same order;
  every link cell is a hyperlink whose text equals its address; `missing_images` rows carry no links,
  `not_in_sheet` rows carry their links and the status word; the CSV is the same grid flattened and
  `compareXlsxCsv` confirms the two match (`exportsMatch` in `report.json`) or finalize fails loudly.
- Filled product-list workbook (R23): when a product-list xlsx was uploaded, finalize also writes
  `<prefix>/exports/<original-stem>-filled-v<k>.xlsx` (and one csv per sheet) with
  `fillProductListWorkbook`: every sheet, column and value of the supplied file kept; `link_status` and,
  per selected channel, `<Channel> Image 1..N` appended on the right; per-size rows repeat their
  colourway's links; one row per `not_in_sheet` product appended at the bottom with its identifier in
  the match column; identifier cells as text; the upload under `uploads/` is never modified;
  `report.json` records `exports.filledProductList`.
- Independent re-check in finalize (R24): after writing `links-v<k>.xlsx`, finalize runs the re-check
  library (`packages/core/src/catalog/recheck/`) on the file it just wrote with a fresh reader and plain
  GETs, no database: every link returns 200 and `image/jpeg` at its recorded generation, ends in `.jpg`,
  is unique, one row per product. The result goes to `report.json` (`recheck: { ok, total, failures[] }`)
  and `counts.recheckOk`, `counts.recheckTotal`; the batch page shows "Independent re-check: <ok> of
  <total> OK" next to "Links verified: <verified> of <planned>", and "Ready" appears only when verified
  equals planned minus skipped and `recheckOk` equals `recheckTotal`.
- Audit: `catalog_product_events` (kinds `created, overwritten, shots_removed, channel_added, unchanged,
  reordered, sku_ids_added, alias_added, removed_photo, replacement_uploaded, restored, removed`) with
  `actor`, batch, channels, shot numbers, generations and hashes; shown on the product page and in `report-v<k>.json`.
- Edge cases: fewer shots -> deleted on the selected channels (previewed, noted, reported); more shots ->
  added; different order -> `reordered`; renamed identifier -> new product unless an alias exists (the
  preview hints when the photos match an existing product); one-channel re-upload -> only that channel
  refreshed; wrong-brand upload -> "Remove product" on the wrong brand's product page, then upload again;
  batch fails after some products published -> those stay live and consistent, the rest are reported.
- What the operator is told (hand-over and batch page): a product's links stay the same for life;
  uploading a product again replaces the pictures behind its links and removes photos that are not in the
  new upload; the previous pictures are kept 30 days as a safety net; only ticked channels are refreshed;
  a re-upload is checked before it goes live and the old pictures stay until every photo is decided;
  uploading the same photos again does nothing and costs nothing; one batch at a time per product; photo
  order matters (`_1` is image 1); a renamed identifier is a new product unless an alias is added first;
  marketplaces keep their own copy, so re-submit changed products there; submit marketplace templates
  only from a batch that says "Ready to download". The process behaviours the operator keeps (state how
  identifiers were read when handing over a sheet; read "Links verified" and "Independent re-check" before
  sharing; count products as identifiers, never files; confirm the grouping on one or two rows before a
  large run; list numbering gaps and watermark flags when a sheet is shared; tell holders of an earlier
  sheet about overwrites and removed shots) are listed in spec 00 and the hand-over note.

## Models and model policy

| Job | Candidates tested | Runs where | Licence / cost |
|---|---|---|---|
| Product matting, primary (every golden set) | `birefnet-general`, `birefnet-general-lite`, `bria-rmbg` (RMBG-2.0, rembg built-in), `birefnet-hr-matting` (BiRefNet HR-matting at 2048, custom ONNX), `birefnet-dynamic-matting` (native resolution rounded to a multiple of 32), `ben2-base` (BEN2 base through rembg's `ben_custom` session with our ONNX export; the id is ours), `inspyrenet-base` (InSPyReNet, `transparent-background` package) | `catalog-matting` (Cloud Run CPU, asia-south1: Python 3.12, FastAPI, onnxruntime CPU, 4 vCPU, 16 GiB or lazy-load with an LRU of two sessions, concurrency 1, min 0, max 20) and `catalog-matting-gpu` (asia-southeast1, one NVIDIA L4, zonal redundancy off, 4 vCPU / 16 GiB, concurrency 1, min 0, max 3); the worker picks the service by model id from each `/health` (`models: [{ id, inputSize, target }]`), preferring gpu; both measured in tier 3 (`x-ms`, both columns in the report) | MIT for the BiRefNet family, BEN2 base and InSPyReNet; CC BY-NC 4.0 for RMBG-2.0 (a permissive fallback is measured in the same bake-off). CPU: 4 to 8 s per image for general-lite, 10 to 20 s for general (tier 3); 24,000 sources about USD 23 (lite at 6 s) to USD 58 (general at 15 s); HR-matting at 2048 on CPU about 400 hours and USD 230, far past the 2-hour target. L4: general about 0.4 s, 2.7 hours, USD 3; HR-matting about 1.6 s, 11 hours, USD 13 |
| Product matting, secondary (hard-cases set and one apparel set) | `birefnet-hr` (BiRefNet HR general), `birefnet-hrsod`, `rmbg-1.4` (fast CPU floor) | same | MIT; NC for RMBG-1.4 |
| Matting refinement experiments (hard cases only, spec 08) | ViTMatte-small trimap refinement (trimap = winner mask eroded and dilated 8 to 16 px at 1536; measured by the human edge-flag rate); SAM 2.1 box prompt for `mixed_product` and `collage` cases (box from the winner mask's largest component or from the judge; compares `different_product` recall). Dropped: MODNet, MatteFormer, SAM 3, IC-Light V2, SUPIR, SeedVR2, 4x-UltraSharp | GPU service | MIT (ViTMatte, SAM 2) |
| Output QA judge and product-type classifier | `google/gemini-2.5-flash-lite` (default, `CATALOG_QA_DEFAULT_MODEL`), `anthropic/claude-haiku-5.5` (second judge), `google/gemini-2.5-flash`, `google/gemini-3.5-flash-lite`, `qwen/qwen3-vl-30b-a3b-instruct`, `qwen/qwen3-vl-8b-instruct` (the six of `CATALOG_QA_CANDIDATES`); `google/gemini-3-flash-preview` and `openai/gpt-5.4-mini` only if none meets the gates | `catalog-worker` via `callLlmJson` (`packages/core/src/llm/llm.ts`, OpenRouter); the classifier uses the cheapest judge | API; about USD 0.0004 (Flash-Lite, Haiku 5.5, Qwen 30B-A3B) to 0.0013 (2.5 Flash, 3.5 Flash-Lite) per check; `EVAL_BUDGET_USD` estimates use per-model OpenRouter prices, not one constant; self-hosting a judge is not worth it |
| Resize / pad / composite / encode | sharp (libvips) only; Lanczos resize, then a conservative unsharp mask on the RGB after any enlargement (spec 11) | `catalog-worker` | Apache-2.0; about 0.5 s per output |
| Upscaling (spec 11, `POST /upscale` on the GPU service, behind `UPSCALE_MODEL`) | `realesrgan-x2plus` (Real-ESRGAN x2plus, ONNX) and `swinir-x2` (SwinIR lightweight x2, ONNX); RGB through the model at x2, alpha through Lanczos, then Lanczos to the exact factor; used only past `UPSCALE_MIN_SCALE`; outputs flagged `upscaled` (info); the winner is chosen by the spec 11 fidelity gate (SSIM, LPIPS, CIEDE2000, text, texture, halo, determinism against the original) and the judge question "are logos, text and fabric texture unchanged from the original" is information | GPU service | BSD-3 (Real-ESRGAN), Apache-2.0 (SwinIR) |
| Generative edits, paid image APIs | not used (product pixels must not change); IC-Light only as a low-priority experiment on the shadow layer alone with a colour-delta guard | | |

Throughput: 20 CPU instances at 6 s give 12,000 images per hour (4,800 at 15 s); one L4 at 0.4 s gives
9,000 per hour, three give 27,000. Every model's licence is recorded in `services/matting/README.md` and
in the bake-off report as a record. The owner has decided that any open-weight model may be used for
this internal tool regardless of non-commercial terms, so NC models are full candidates and may be policy
defaults; the winner is chosen on quality alone (spec 08 section 4.10).

Send size per model (`SEND_LONG_SIDE_PX`, read from `/health` `inputSize`): 1024 for every rembg
built-in (rembg resizes BiRefNet and RMBG sessions to 1024 internally, so a larger send buys nothing),
2048 for `birefnet-hr-matting` and `birefnet-hr`, native (rounded to a multiple of 32, 256 to 2304) for
the dynamic models; the matte is upscaled to source size with a sigma 1 blur. Every `remove()` call
passes an explicit `session=` (rembg's own default is the NC `bria-rmbg`). `MATTE_MODELS` default
`birefnet-general,birefnet-general-lite,birefnet-hrsod,bria-rmbg`; `DEFAULT_MATTE_MODEL` `birefnet-general`.

First default policy per product type (`model_policy` rows with `source = default`, written by spec 07
and overwritten by the bake-off in spec 08):

| Product type | Matte (first) | Matte (second) | Send size | Shadow | Judge |
|---|---|---|---|---|---|
| footwear | `birefnet-general` | `bria-rmbg` | 1024 | preserve if uniform background and a shadow band under the bbox; else synthesise a soft contact shadow (upright); never where the channel forbids shadows (Amazon/Shein shot 1 border band enforced by compliance) | `google/gemini-2.5-flash-lite`, second `anthropic/claude-haiku-5.5` |
| apparel_model | `birefnet-hr-matting` (2048) | `birefnet-dynamic-matting` | 2048 or native | preserve only; never synthesise | same |
| apparel_flat | `bria-rmbg` | `birefnet-general` | 1024 | preserve if present; never synthesise | same |
| bag_accessory | `birefnet-general` | `birefnet-hr-matting` | 1024 (2048 for the second) | preserve else synthesise (upright) | same |
| other (hardline) | `bria-rmbg` | `birefnet-dynamic-matting` | 1024 or native | preserve else synthesise (upright); glass and transparent packaging routed to `birefnet-hr-matting` with flag `transparent` for attention | same |

Shadow decision rule (per source after matting; spec 05): (1) `alpha_source`: no shadow information;
synthesise only if the policy says synthesise and the channel allows a shadow, else none, flag
`no_shadow_source`. (2) Uniform background with mean darkness in the shadow band above
`SHADOW_MIN_DARKNESS` (builder constant, start 0.04) and touching the bbox bottom: preserve the original
shadow as a darkening matte, clamped to `SHADOW_MAX_DARKNESS` (start 0.6) and limited to the connected
component touching the bbox bottom. Qualify that component using negligible-alpha background only,
then extend it underneath connected partially transparent edges without joining unrelated background
components. Opaque alpha-255 pixels exclude shadow; foreground RGB and alpha stay unchanged.
This keeps a continuous contact shadow without introducing a bright fringe or treating a partial
apparel edge as a native floor shadow. (3) Otherwise footwear, bag_accessory or other in an upright pose:
synthesise a deterministic contact shadow from the silhouette (each column of the bottom 20% of mask rows
weighted by how close it comes to the contact line, feathered sideways and given a soft vertical
falloff about 12% of the product's smaller side deep, intensity `SHADOW_SYNTH_INTENSITY_GREY` 0.25 on grey
and `SHADOW_SYNTH_INTENSITY_WHITE` 0.15 on white; parameters named so presets can change later), flag
`shadow_synthesised` (info). (4) apparel_model and apparel_flat: never synthesise. (5) IC-Light is not in
the default path; Depth Anything is a spec 08 experiment. Compliance's `background` check still enforces
the border band, so a shadow reaching a margin fails by code. Every shadow, kept or made, eases to zero
before required margins, the border band and the source frame, and a kept shadow fades out past its
measuring band; no shadow ever ends on a straight cut.

Bake-off (spec 08): every candidate runs on the golden set for every brand and category; outputs are
scored by the compliance checks, by each QA judge and by human labels. The result is the `model_policy`
table (brand, category -> `matte_model`, `matte_target` (cpu | gpu), `qa_model`, `threshold`, `floor`,
`qa_mode`, `qa_sample_rate`, `source`), chosen by the harness, stored in Cloud SQL, resolved into
`catalog_batches.options.policy` at Start, and re-evaluated when a new brand or category appears (the
default rows above apply until then, counted as `policyFallback`). Gate numbers: auto-pass precision
>= 97%, flag recall >= 90% per category. The operator never sees a model name; model ids live only in
`model_policy`, `options.policy`, `matte_model`, `qa_model`, `judge_model` and logs, and the
no-model-names test also forbids `rmbg`, `bria`, `inspyre`, `ben_custom`, `esrgan` and `swinir` in UI
text. Cost per style+colour is reported next to INR 60.

`catalog-matting` and `catalog-matting-gpu` contract (one code base, `services/matting/Dockerfile`
targets `cpu` and `gpu`; `cloudbuild.yaml` builds images `matting` and `matting-gpu`): `POST /matte`
(multipart image, `model` query) returns a PNG alpha matte at the resolution it received plus headers
`x-model`, `x-ms`; `POST /convert` (multipart `file`) turns a HEIC/HEIF file into `image/png` at source
resolution with EXIF orientation applied, headers `x-ms`, `x-input-format` (`pillow-heif`; pytest covers
it on a small HEIC fixture); `GET /health` lists `models: [{ id, inputSize: number | "native", target:
"cpu" | "gpu" }]` and `default`. Both run as `catalog-matting@` with OIDC (audiences `MATTING_URL` for
CPU and `MATTING_GPU_URL` for GPU, caller `catalog-worker@`). `MATTING_GPU_URL` is optional: when unset
every model runs on CPU and 2048 px candidates are reported "not run: no GPU service". The worker sends
each image at the model's `inputSize` and upscales the matte to source size with the sigma 1 blur.
Cross-region egress is about 1 MB per image, cents per batch. No GCE VM. A circuit
breaker (`MATTING_BREAKER_FAILURES`, `MATTING_BREAKER_COOLDOWN_MS`, `MATTING_TIMEOUT_MS`) switches to the
flood-fill fallback with flag `fallback_matte` and status `needs_attention` instead of failing the batch.

## Roles and access (defined in spec 03)

- Sign-in: Cloud Run IAP on `catalog-web` (`--iap`, private service, Google-managed OAuth client; the
  IAP service agent holds `roles/run.invoker`, `domain:opptra.com` holds `roles/iap.httpsResourceAccessor`,
  all granted by `bootstrap.sh` and `deploy.sh`, no console step). Google's own sign-in page; accounts
  outside Opptra get IAP's "You don't have access" page. The app verifies the `x-goog-iap-jwt-assertion`
  JWT (`google-auth-library`, issuer `https://cloud.google.com/iap`, audience
  `/projects/<project-number>/locations/asia-south1/services/catalog-web`) in `apps/web/lib/iap.ts`
  and checks the email ends in `@opptra.com`; the plain email header is never trusted. No sign-in page,
  no middleware, no auth cookie or secret of ours. "Sign out" goes to `/?gcp-iap-mode=CLEAR_LOGIN_COOKIE`.
  Env `IAP_AUDIENCE`, `ALLOWED_HOSTED_DOMAIN`; local dev `SKIP_IAP=1` with `DEV_USER_EMAIL`.
- Table `users(email pk, role admin|operator|viewer, added_by, created_at, updated_at)`. Seed
  `sujan@opptra.com` as `admin` (`added_by = "seed"`, `SEED_ADMIN_EMAIL`). First sign-in of any other
  verified `@opptra.com` account inserts `viewer` (`added_by = "sign-in"`). Removing a person deletes the
  row; they are a viewer again on their next sign-in.
- `ROLES = ["admin","operator","viewer"]`, order admin > operator > viewer. `currentUser()` looks the role
  up on every call so a change applies at once; `requireRole(min)` throws `ForbiddenError` (HTTP 403,
  "You can view this but not change it. Ask an admin for the operator role.").

| Action | viewer | operator | admin |
|---|---|---|---|
| open batch list, batch page, sheet preview, attention tab, product and brand pages, downloads | yes | yes | yes |
| New batch, wizard, Start, Start again | no | yes | yes |
| Use as is / Remove this photo / Replace photo N | no | yes | yes |
| Add SKU ids, Add alias, Remove product, brand sheet export | no | yes | yes |
| People modal: add person, remove person, set role | no | no | yes |
| Preview as viewer | yes (no-op) | yes | yes |

- Worker and matting stay OIDC service-to-service (`apps/worker/src/auth.ts`; worker audience
  `WORKER_URL`, caller `catalog-worker@`; matting audience `MATTING_URL`). `actor` in events and the
  `created_by`, `published_by`, `decided_by`, `labeler` columns hold the signed-in email, or `system`
  for the sync and the sweeper.

## UI (prototype v2 is the contract; spec 01 transcribes it)

- Nav: "Opptra" logo and "Catalog images" only. User button "<email> · <Role> ▾" with "People" (admins)
  and "Sign out". Batch list columns Brand, Batch, Channels, Products, State, Created; states "Needs
  attention (N products)", "Processing 1,240 of 4,800", "Ready to download", "Collecting files 48 of 310",
  "Could not start". Footer: "A product's links stay the same for life. Uploading a product again replaces
  the pictures behind its links. Marketplaces keep their own copy, so re-submit changed products there."
- Wizard (`/catalog/new`, four steps on one page): "Brand and files" (brand select grouped Softline /
  Hardline from `brand_master`, help "Brand not in the list? Email sujan@opptra.com."; "Batch name
  (optional)"; "What kind of products?" with "Detect automatically (recommended)"; drop zone; "Or paste a
  link"; share box only for Google links with Copy and "Viewer is enough; we only read. We never change
  your files."; pills "Access confirmed", "No access yet", "<n> image links"). "Check what we found"
  (cards "How should we tell products apart?", precedence card shown only when both kinds exist, "Photo
  formats" with "<n> HEIC (iPhone format, converted automatically)" + "No action needed.", one sheet
  card per sheet upload with the identifier-column picker, the image-columns picker and the sheet kind
  (links sheet | product list) behind Change, "Could not tell which column holds the identifier." with
  Continue disabled until a column is chosen, "Google access" with "Check again").
  "Where will these images go?" (channel cards, "Usually listed first" / "Also available", one-line rule
  per channel in plain words, Continue disabled until one is ticked). "Start" (KPIs "products found",
  "photos", "marketplaces", "images will be made"; "Estimated cost: about INR <x> (<n> images, <m>
  quality checks)" or "not available" when `INR_PER_USD` is unset; warning list without any SKU warning:
  products with no photos, "<k> files could not be read." with names and reasons, Styli low-resolution
  skips, "<k> products have photos but are not in your product list", "<k> products have two files for
  the same shot number", multiple top-level folders, duplicate identifier rows, "<k> size rows matched
  <m> products."; overwrite preview "<n> products are new", "<m> products already exist and will be
  overwritten", per product the shots to be removed and the rename hint; busy products; the
  announcement line "Grouped by ..."; "How we grouped your photos" table whose rows expand to the file
  names in shot order with sizes; note "Once you start, you cannot add more photos to this batch. Make a
  new batch for anything else."; button "Start processing", refused with "Files changed since the
  preview. Open step 4 again." when an upload completed after the last preview; toast "Batch started. We
  will show progress here."). Step 4 is a check, not a result; no question is ever asked after Start.
- Batch page (`/catalog/[id]`): tabs Overview, "Needs attention (N products)" (hidden when 0), Links
  sheet, Details. Overview: state banner, KPIs, "How this works", "Cost so far" ("INR 3.80 per style so far
  · agency reference INR 60 per style"), "Not refreshed in this batch" line, downloads "Download links
  sheet (Excel)", "Download CSV" and "Download filled product list" when a product-list workbook was
  uploaded, "Start again" on a failed batch. The "Ready" banner appears only when links verified equals
  links planned minus skipped and the independent re-check is <total> of <total> OK. Links sheet:
  preview table with merged channel headers and "Opptra SKU ids are filled in automatically when they
  exist." Details: "For the technical team" with batch id, "Links verified: <verified> of <planned>",
  "Independent re-check: <ok> of <total> OK", `gs://image-links-agent-assets/catalog/<brand>/<batchId>/raw/`,
  `https://storage.googleapis.com/image-links-agent-public/catalog/<brand>/<pathKey>/<channel>/`,
  `report.json`, and "<n> image(s) could not be made." with "Replace it from the Needs attention tab."
- Needs attention tab: lead "Everything else is done and in the sheet. Only the products below have a
  problem, and only the photos with a problem are shown. Your decision is applied to the links sheet
  straight away." Product card: identifier, "<k> of <total> photos need a decision", problem line; per
  photo the original and the image made for <channel> (or "Could not be made"), the bold reason, what to
  do, buttons "Use as is" (green), "Remove this photo", "Replace photo <n>". A remove on a shot that is
  live from an earlier batch says first "This removes the live image for this photo on <channels>."
  Toasts "Kept in the sheet", "Removed. The sheet cell is empty with a note.", "Replacement queued.
  Usually done in a minute."; resolved card: pill "Resolved", identifier, "Sheet updated." Replace modal
  "Replace photo <n> of <identifier>": "Drop the new photo. We will make it for <channels> again and
  update the sheet. Nothing else changes."
- Product page (`/catalog/products/[brand]/[key]`): live images per channel, Opptra SKU ids, aliases,
  events newest first, "Download links", "Add alias", "Remove product" with a typed confirmation (deletes
  only this product's public objects; event `removed`). Brand page (`/catalog/brands/[slug]`): product
  search, "Download links for selected products", cost per brand.
- People modal: "People"; help "Anyone with an @opptra.com Google account can sign in and view. Admins
  decide who can create batches and resolve attention items."; rows email + role select (Admin /
  Operator / Viewer); add row "name@opptra.com" + role + "Add person"; toast "<email> added as <Role>.";
  switch "Preview as viewer" ("Hides New batch and the action buttons, as a viewer sees them.").
- Copy rules: every message is a sentence with an action; no model names, thresholds or technical
  settings anywhere in the UI; marketplace names use the labels above; numbers formatted with thousands
  separators; the only technical strings are on the Details tab.

## Testing and guardrails

Real test data is read-only at the source, copied under `gs://image-links-agent-assets/catalog-test/<run-id>/`
and deleted by the test itself in `finally`:
- Supabase public links from the earlier delivery sheets (`opptra-image-links/new_resources_3/*.xlsx`,
  `new_resources_4/*.xlsx`): Anta, Campus, ONLY, Cardio Bunny, Keds, USPA, Vero Moda, French Connection, Penti.
- Local sets: `C:\Users\Sujan AH\Desktop\opptra-image-links\new_resources_3\French Connection Final`
  (3,280 apparel, 800x1200, white) and `new_resources_4\Images` (630 Anta footwear, 800x800, pure white);
  the operator's USPA footwear sets (Styli-rejected and accepted) for the golden set when provided.
- Golden set `eval/<set>/` with manifest and human labels (`catalog_eval_labels`), covering every brand
  in the warehouse plus the readiness-sheet brands, and hard cases (white on white, dark shadow, mesh,
  transparent PNG, 500 px, HEIC, collage, watermark, mixed product). Eval batches are test batches.

Test tiers (spec 00 defines them; each spec names which apply; all run before merge):
1. Unit (vitest): pure functions with sharp-generated images; determinism asserted; `assertWithinProduct`
   and `assertTestPrefix` have their own tests; `publicObjectPath` suffix; `parseShotName` three-digit
   cap and position renumbering; composite key detection; header-row discovery under a title row;
   refusal with `identifierColumn -1`; duplicate identifier rows; `_rect`/`_square` and size-level
   matching; a 13-digit identifier read back as the same string; `compareXlsxCsv`; the verify retry;
   a HEIC fixture grouped as a normal image.
2. Integration (PGlite + fake storage, matting and LLM): ingest, chunking, idempotent resume, locks,
   publish retry, one failure never blocks the rest.
3. Real-data (`REAL_DATA=1 pnpm test:real`, only `**/*.real.test.ts`): worker and matting run locally in
   Docker against the real sets; outputs under `catalog-test/`; compliance must pass 100%; the overwrite
   contract is asserted (same URLs, new generation, 404 on a removed link, `change` values, events).
4. Human-like browser (Playwright on the deployed `WEB_URL`): `apps/web/test/human/login.ts` opens the
   site headed, the tester signs in on Google's IAP page once and the session is saved with
   `context.storageState({ path: ".playwright/auth-state.json" })`; `catalog.human.spec.ts` uses that
   state with `recordVideo`. Script: create a batch for USPA with a zip and a pasted Supabase link list,
   tick Noon and Styli, start, wait, open "Needs attention", "Use as is" on one photo, "Remove this photo"
   on one, download the xlsx and the filled product list, open three links, upload a mapping sheet;
   read "Links verified" and "Independent re-check" on Details; re-upload the same zip (every
   product `unchanged`, no new generations); re-upload with one photo changed and one removed, see the
   new picture at the same link, get 404 on the removed one, read the `change` column; add an operator
   in People; "Preview as viewer". The recording goes into the hand-over.
5. Per-brand smoke (`pnpm catalog:smoke`, inside `deploy.sh` before the build): one product per brand
   through all nine channels, run twice (the second pass alters one photo and drops one shot; same URLs,
   new generations, removed link gone, untouched channel's generation unchanged); a report with
   thumbnails; any `failed_compliance` blocks deploy.
6. Load (`pnpm catalog:load`, spec 09): the 2,700-option batch and the 100,000-output total against the
   2-hour target.

Guardrails built into the product:
- Scoped overwrite and delete: the worker overwrites and deletes only objects under the prefix of the
  product it holds the lock for, and only on the channels of the running batch; never another product's
  objects, never raw, never exports, never outside `catalog/` and `catalog-test/`. Enforced by
  `assertWithinProduct` in code with a unit test, and by one product lock per unfinished batch. Test
  cleanup (`deleteTestObjects`, the only bulk delete) is restricted to `catalog-test/` by code and by a
  bucket IAM condition.
- Safety net: versioning on the public bucket; noncurrent versions kept 30 days (at most three per
  path) then removed by lifecycle; a wrong overwrite is restored by copying the previous generation back
  (event `restored`; documented in `docs/solutions/`). Current raw files are never removed: lifecycle on
  `raw/` runs on `customTime`, set only when a source is superseded.
- Verify-then-live on the new bytes: staged in the private bucket, compliance and QA (or an operator
  decision) for every planned output, swap per object with `ifGenerationMatch`, then a public GET must
  return 200, `image/jpeg`, the staged length, `FF D8 FF` and the copied generation before a link
  reaches the sheet; a failed check is retried once before the output is `failed`. Until then the
  product's previous images stay live.
- Independent re-check, twice: finalize runs the re-check library on the sheet it just wrote (fresh
  reader, plain GETs, no database) and a batch is "Ready" only when "Links verified" and "Independent
  re-check" are both complete; the CLI (`pnpm catalog:recheck`, `--batch`, `--sheet`, `--csv`,
  `--sample`) repeats it from outside: every link returns its recorded generation, ends in `.jpg`, is
  unique, is a hyperlink cell whose text equals its address, one row per product, xlsx and csv equal.
- Process behaviours kept by the manager agent and the operator (listed in spec 00): never hand over a
  preview as a deliverable; state the grouping rule in words; read both counts before sharing; report
  gaps, watermarks, overwrites and removed shots to whoever holds a sheet; count products as identifiers,
  never files; compare `sha256` before calling a re-delivery "the same photos"; write every new matching
  rule learned on a real batch into `docs/solutions/` and this document before the job is called done.
- Idempotent, resumable tasks; per-output status; Cloud Tasks retries with backoff (5 attempts); the
  matting circuit breaker with the flood-fill fallback flagged `needs_attention`; QA spend caps per batch
  (`qaCapUsd`) and per day (`DAILY_SPEND_CAP_USD`, `spend_days`, `checkCaps`); identical photos skipped
  by `render_key` at zero cost.
- Supabase is only ever read. Live OpenRouter calls only in the smoke test (`LIVE_SMOKE=1`); every other
  test mocks the LLM.
- Every error state is a sentence with an action; no silent drops; the report lists everything that did
  not ship, every removed link and every channel not refreshed.
- CI gate on every PR (`.github/workflows/ci.yml`): `pnpm lint && pnpm typecheck && pnpm test`;
  `infra/bootstrap.sh` idempotent on a second run; `GET /health` on worker and matting report versions
  and routes.

## Brand master and Opptra SKU id mapping

Source: BigQuery project `opptra-datawarehouse` (`BQ_PROJECT`), location `asia-south1`. UDFs
`fact_gcc.alias_gcc_brand` (every POLO/USPA spelling -> `USPA`; FCUK -> French Connection; fixed casing
for the rest) and `fact_gcc.family_of_gcc_brand` (softline: USPA, Campus, Penti, French Connection,
Nautica, Vero Moda, Keds, Cardio Bunny, Puma; everything else hardline: Bergner, Carote, Nutricook,
NutriBullet, GTPlayer, Tower, Dowinx, Qubo, Nuwey). USPA is one brand; apparel vs footwear is the product
type. Softline master `raw_gcc_dimensions.master_sl` (16,612 rows): `product_code` (the Opptra SKU, per
size), `option_id_style_color`, `ean`, `color`, `size`, `brand`, `image_url`, channel ids (`namshi_ae/sa`,
`child_zsku`, `noon_ae/sa`, `trendyol`, `centerpoint_ae_ksa`, `6th_street_ae/sa`, `styli_ae_ksa`,
`styli_sku`, `amazon`, `voga_closet`, `shein`). Hardline master `raw_gcc_dimensions.sku_master_sheet_hl`
(335 rows): `sku`, `ean`, `brand`, `amazon_uae_ksa_asin`, Noon, Trendyol, Styli ids. Unicommerce item
master `raw_gcc_dimensions.sku_master` (16,812 rows). Long-format lookup `dimensions.unified_sku_master_gcc`.
`raw_gcc_dimensions.channel_sku_mapping_gcc` carries `segment` Hardline/Softline.

How it is used:
- Nightly and on-demand sync (worker route `/tasks/catalog/sync-master`, Cloud Scheduler
  `catalog-sync-master`, `@google-cloud/bigquery`) into the Cloud SQL tables `brand_master` and `sku_map`
  (`source = warehouse`). Brands not yet in the warehouse (BHPC, Anta, Samsco, ONLY) are added by the
  admin as manual `brand_master` rows (`source = manual`) and reconciled by slug when their masters
  appear; the UI has no way to create a brand, the wizard says "Brand not in the list? Email sujan@opptra.com."
- Resolution at ingest (`sku-mapping.ts`, `resolveSkus`) on normalised keys (`normalizeKey`): option_key
  (style+colour) -> EAN (from identifier or product list) -> channel id (Styli option id, Namshi ZSKU, Noon
  seller SKU, ASIN) -> `product_code` minus size suffix -> manual mapping sheet ("Add SKU ids"). A
  style+colour maps to several per-size SKUs; the sheet gets `option_id_style_color` and `opptra_sku_ids`
  (`;`-separated). Every resolved id becomes an alias (`catalog_product_aliases`). Unresolved identifiers
  are counted (`skuResolved`) and listed in the report, never shown as a warning.
- When the sync fills or corrects ids later: product row and aliases updated, event `sku_ids_added`,
  finalize enqueued for the latest batch of each touched product so a fresh `links-v<k>` appears with the
  same links. An id that moves to another option in the warehouse is removed from the old product and reported.
- IAM: `catalog-worker@` gets `roles/bigquery.dataViewer` on `raw_gcc_dimensions`, `dimensions`, `fact_gcc`
  and `roles/bigquery.jobUser` on `opptra-datawarehouse` (check-then-create in `bootstrap.sh`; prints the
  commands if the operator lacks rights there).
- Two warehouse inconsistencies are reported, not fixed here: the v2 sales procedure reads Noon HL
  columns under old names; the docs name `rohan_master_sheet_hl` while code uses `sku_master_sheet_hl`.

## Architecture and storage layout

```
Operator (Google sign-in, roles) -> catalog-web (wizard, batch pages, attention tab, product and brand pages, People, downloads, signed uploads, Sheets/Drive access checks)
  -> Cloud SQL ila-pg, database catalog (users, brand_master, sku_map, model_policy, catalog_*, spend_days)
  -> private bucket image-links-agent-assets: catalog/<brand>/<batchId>/{uploads,raw,derived,staging,exports}/, catalog/<brand>/exports/, eval/, catalog-test/
  -> Cloud Tasks queue catalog -> catalog-worker (ingest, matte, render, compliance, QA, stage, publish, verify, finalize, sync-master, sweep)
       -> catalog-matting (Cloud Run CPU, asia-south1, MATTING_URL) and catalog-matting-gpu (Cloud Run L4, asia-southeast1, MATTING_GPU_URL) ; -> OpenRouter (QA only)
       -> public bucket image-links-agent-public (versioned): catalog/<brand>/<path_key>/<channel>/<path_key>_<n>.jpg
```

Storage rules: public objects are keyed by product, channel and shot and overwritten in place by a later
batch for the same product; `Cache-Control: public, max-age=300`; versioning on with
`infra/lifecycle-public.json` (noncurrent versions deleted after 30 days; at most three older versions
per path). Private objects stay under their batch (`infra/lifecycle-assets.json`): `uploads/` and
`derived/` deleted after 180 days; `raw/` deleted 180 days after `customTime` (current raw has none and is
never removed); `staging/` deleted after 30 days; `exports/` kept. `catalog-test/` mirrors both layouts
and is the only prefix tests may delete. `infra/cors.json` allows browser PUTs on the assets bucket.

Worker (`apps/worker`, Node 20, esbuild): route table in `server.ts` with `GET /health` and the six task
routes `/tasks/catalog/{sync-master,sweep,ingest,chunk,publish,finalize}` (`TaskRoute` in
`packages/core/src/tasks.ts`; `enqueueTask(route, body, { delaySec?, taskId? })`; OIDC; `HandleResult`:
200 done, 503 retry, 500 unexpected). Chunks (`catalog_chunks`) of whole products, about
`CATALOG_CHUNK_IMAGES = 25` images, stages `matte -> render -> qa`; one decode per source shared by all
channels; outputs with a matching `render_key` skipped; publish per product; matting through `MATTING_URL`
(CPU) and the optional `MATTING_GPU_URL` (GPU), the service chosen per model id. Sizing `--cpu=2 --memory=2Gi
--concurrency=2 --min-instances=0 --max-instances=10 --timeout=900`, `DB_POOL_MAX=2`; queue
`--max-concurrent-dispatches=20 --max-attempts=5 --min-backoff=10s`. esbuild entries `index`, `migrate`,
`catalog-local`, `catalog-smoke`, `catalog-eval`, `catalog-load`, `catalog-recheck`, `catalog-qa-check`.

Web (`apps/web`, Next.js 15, React 19, behind IAP): pages `/catalog`, `/catalog/new`,
`/catalog/[id]`, `/catalog/brands/[slug]`, `/catalog/products/[brand]/[key]`; API under `/api/catalog/*`
(batches, uploads, links, ingest, detected, preview, start, export, attention, outputs decision and
replacement, sku-map, eval-labels, brand products and export, product aliases and delete) and `/api/people`;
every route checks the role; errors are sentences with an action through `apps/web/lib/errors.ts`.
`DB_POOL_MAX=3`. `catalog-web@` never writes to the public bucket.

Infra (`infra/bootstrap.sh`, `infra/deploy.sh`, idempotent, `export CLOUDSDK_CORE_PROJECT=image-links-agent`):
reused shared resources `ila-vpc`, `ila-subnet`, Cloud SQL `ila-pg` (db-f1-micro, private IP), Artifact
Registry `apps`, bucket `image-links-agent-assets`, secret `openrouter-api-key`; the earlier `ila-web` and
`ila-worker` services are left alone. New: database `catalog` and user `catalog_app` (secret
`catalog-db-password`); IAP: API enabled, IAP service agent created, `roles/run.invoker` for the agent at
project level (no OAuth client, brand or auth secret; nothing printed); public bucket with uniform access,
`allUsers` -> `roles/storage.objectViewer`,
versioning; queue `catalog`; service accounts `catalog-web@`, `catalog-worker@`, `catalog-matting@`;
Scheduler jobs `catalog-sync-master` (nightly) and `catalog-sweep` (every 30 minutes, builder constant);
APIs Sheets, Drive, BigQuery, Scheduler plus the Cloud Run, Tasks, SQL, Secret Manager, Artifact Registry
and Cloud Build set. Cloud Run: `catalog-web` (private, `--iap`; `deploy.sh` grants `domain:opptra.com`
`roles/iap.httpsResourceAccessor` at resource level, or at project level with a WARN if denied, and sets
`IAP_AUDIENCE`), `catalog-worker`
(private), `catalog-matting` (private, asia-south1, `--cpu=4 --concurrency=1 --min-instances=0
--max-instances=20 --timeout=300`, 16 GiB or lazy-load with an LRU of two sessions; the builder decides
and records it in the README), `catalog-matting-gpu` (private, asia-southeast1, `--gpu=1
--gpu-type=nvidia-l4 --no-gpu-zonal-redundancy --cpu=4 --memory=16Gi --concurrency=1 --min-instances=0
--max-instances=3`; flags confirmed against the Cloud Run GPU docs before use; the default quota is 3 L4s);
jobs `catalog-migrate`, `catalog-qa-check`, `catalog-eval`. Images `web`, `worker`, `matting`,
`matting-gpu`. IAM: `catalog-worker@`
`roles/storage.objectUser` on the public bucket (fallback `roles/storage.objectAdmin` on that bucket only)
and `roles/storage.objectAdmin` on the assets bucket; `catalog-web@` `roles/storage.objectViewer` on the
public bucket, `roles/storage.objectAdmin` on the assets bucket and `roles/iam.serviceAccountTokenCreator`
on itself; both `roles/cloudsql.client`, `roles/secretmanager.secretAccessor`, `roles/cloudtasks.enqueuer`;
`catalog-worker@` `roles/run.invoker` at project level. Image tag = git short SHA; `SKIP_BUILD=1` reuses it.
Costs stay low: min-instances 0 everywhere, GPU service min-instances 0 and max 3, db-f1-micro, no
always-on resources.

## Data model (Drizzle, `packages/core/src/db/schema.ts`; migrations `0000_init.sql` from spec 02 and `0001_users.sql` from spec 03, the only specs that ship migrations)

- `users`: email, role, added_by (spec 03).
- `brand_master`: name, slug, line `softline | hardline`, source `warehouse | manual`, synced_at.
- `sku_map`: opptra_sku, brand, brand_slug, line, option_key, option_id_style_color, ean, color, size,
  channel_ids, image_url, source, synced_at.
- `model_policy`: brand_slug (`*` any), category, matte_model, matte_target `cpu | gpu`, qa_model,
  threshold, floor, qa_mode, qa_sample_rate, source, eval_batch_ids, gates; unique (brand_slug, category).
- `catalog_batches`: brand, name, status `BATCH_STATUSES`, is_test, product_type, channels, options
  (`BatchOptions`), counts (`BatchCounts`, including `recheckOk`, `recheckTotal`), cost (`BatchCost`),
  report and sheet URIs, error, created_by, timestamps.
- `catalog_uploads`: batch, kind `UPLOAD_KINDS`, name, relative_path, gcs_uri, source_url, size, mime,
  status `pending | uploaded | collected | failed`, detected, error.
- `catalog_products`: brand_slug, is_test, product_key, path_key, identifier, option_id_style_color,
  opptra_sku_ids, sku_method, product_type, lock_batch_id, last_batch_id; unique (brand_slug, is_test, product_key).
- `catalog_batch_products`: batch x product with link_status, change `CHANGE_KINDS`, flags, notes.
- `catalog_product_aliases`: brand_slug, is_test, alias_key, product, kind `ALIAS_KINDS`; unique (brand_slug, is_test, alias_key).
- `catalog_product_events`: product, batch, kind `EVENT_KINDS`, actor, details, at.
- `catalog_source_images`: product, batch (brought by), n, sha256, is_current, superseded_at, replaces_id,
  original_name, upload, raw_uri, mime, width, height, bytes, matte_uri, matte_model, matte_ms, flags,
  status `pending | prepared | matted | failed | unsupported`, error.
- `catalog_outputs`: batch, product, source_image, channel, n, canvas and placement, bytes, quality,
  render_key, staging_uri, object_path, public_url, generation, crc32c, is_live, compliance, qa_scores,
  qa_model, status `OUTPUT_STATUSES`, flags, reason, decision `DECISIONS`, decided_by, decided_at,
  published_at, published_by, superseded_at, superseded_by_output_id, attempt, error; partial unique
  (product, channel, n) where is_live.
- `catalog_chunks`: batch, index, stage `matte | render | qa`, product_ids, source_image_ids, status
  `queued | running | done | failed`, attempt, task_name, timestamps, error.
- `catalog_eval_labels`: batch, output, source_image, set_name, identifier, channel, labeler, label
  `EVAL_LABELS`, reasons, note, judge_verdict, judge_scores.
- `catalog_eval_judgements`: batch, output, judge_model, scores, verdict, reasons, cost_usd, ms; unique (output, judge_model).
- `spend_days`: day, brand_slug, engine `catalog_qa | catalog_compute`, batch, cost_usd, calls.

## Programme done

- All specs merged and deployed; an operator can run a batch for any brand from the UI without help; the
  human-like browser test passes on the deployed URL and its recording is in the hand-over.
- Google sign-in works for `@opptra.com` with no console step; the owner (admin) has added the operator
  (Naaz) as `operator` in the People modal himself; viewers see everything and can change nothing.
- Every output in the links sheet is verified live and compliant; every batch shown as Ready has "Links
  verified" and "Independent re-check" complete; a filled product list is delivered whenever a workbook
  was uploaded; nothing is dropped silently; the report lists every exception, every removed link and
  every channel not refreshed.
- The bake-off report exists; `model_policy` covers every brand and category seen; the gate numbers are
  met; the operator never sees a model name.
- Cost per style+colour is shown per batch against INR 60.
- The re-check by live generation (`pnpm catalog:recheck`) passes for every live output.
- This document, `docs/solutions/`, the README and the plain-language hand-over note for the operator
  (`docs/handover/`) are in `main`.

## Non-goals

- No generative edits or paid image APIs; product pixels are never regenerated. The only upscaler in
  the default path is the deterministic x2 model behind `UPSCALE_MODEL` that passed the spec 11
  fidelity gate; its outputs are flagged `upscaled` (info).
- No lifestyle-background option and no "four options" variant; only what the sheet specifies.
- No cropping of any kind; no cap on images per product or per channel.
- No stored channel defaults; channels are chosen fresh every batch.
- No writes to Supabase, ever.
- No deletion outside a product's own prefix on the batch's channels and `catalog-test/`; no deletion of
  raw, exports or `eval/`.
- No model names or technical settings in the operator UI.
- No sign-in library, OAuth client or auth cookie of ours; access is Google sign-in through Cloud Run IAP,
  roles come from the `users` table.
- No photo-shoot, template, gallery or prompt features from the earlier app.

## Open points (defaults apply; none block)

1. Styli "same placement on all angles": the same scale across a product's shots is assumed
   (`uniformScaleDefault` true for styli).
2. Brands not yet in the warehouse (BHPC, Anta, Samsco, ONLY) use manual `brand_master` rows and the
   manual mapping sheet until their masters exist.
3. Google Workspace policy on sharing Sheets and Drive folders with a service account: detected at run
   time; the fallback is a file drop.
4. Whether a public GCS object URL serves the object with an unknown query parameter
   (`...ABC123_2.jpg?v=3`): verified at build time; if yes a "fresh links" export is offered for
   marketplaces that will not re-fetch an unchanged URL; if not, the operator re-uploads that image in
   the seller portal by hand.
5. Whether `roles/storage.objectUser` is available in the organisation; fallback
   `roles/storage.objectAdmin` on the public bucket for `catalog-worker@` only.
6. Whether `catalog-worker@` can read what the operator shared with `catalog-web@`; spec 04 settles how
   one shared address is enough, with a documented fallback if not.
7. Whether `roles/iap.httpsResourceAccessor` can be granted at the `catalog-web` resource level with the
   operator's roles; fallback is the project-level grant for `domain:opptra.com` (spec 03), which also
   opens the earlier `ila-web` to every Opptra account and is noted in `docs/solutions/catalog-iap.md`.
8. Whether an x2 upscale may un-skip Styli for 800x1200 sources (spec 11): OPEN, asked in the status
   when the fidelity gate is done; until then `STYLI_SKIP_LOW_RESOLUTION` and the 1,482 px minimum
   stand.

Closed by the owner (recorded in the decisions log): the Styli size-versus-softness question (follow the
guideline sheet; no Styli-only `MAX_UPSCALE`) and the licence posture (NC models are full candidates).
