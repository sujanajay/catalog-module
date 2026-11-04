# M3 Images - requirements (draft for review)

Follows `00-template.md`. Feature ids `M3-F1` to `M3-F11` are the rows of the M3 table in `../module-map.md`, in table
order. Reuses the still-valid detail of old initiatives 02 (crops), 03 (made photos), 04 (scenes), 05 (faces) and 07
(infographics); every per-product review card, "Needs me" tab, named reviewer and spot-check card is cut and replaced
by the M7 sampled audit.

## 1. Purpose

- **Why:** 98% of audited apparel lacks the five-shot set, 23% of on-model products have a cut head, 28% of hero
  photos are under 1,000 px, and images are the first holdout's treatment. M3 completes and cleans each product's
  gallery to each channel's rules, first from the brand's own pixels (crops, cleanup, renders), then, where nothing
  else works, with bought generation.
- **Outcome metric:** apparel options on Namshi and Noon meeting the channel shot set (baseline about 2%, target above
  80%), at a cost per product the M6 meter confirms.
- **Intents:** I011 (ship the critical slice first), I002 (reuse what exists), I003 (fallbacks everywhere), I025 (cost and time),
  I021 (settings), I014 (human only where needed), I037 (images are one part of content).

## 2. Scope

**In (P0):** crops that complete the set, published on Namshi and Noon only (M3-F1); background removal and
upscaling on our own GPUs with vendor overflow (M3-F2); channel renders driven by M5 rules with the 240+ grey
background and white Amazon image 1 (M3-F3); the image set policy per channel x category applied at publish (M3-F4).

**Out:** pass or fail of generated images (M7); reading photos (M2); rules themselves (M5); listing files and upload
(M9); scenes, faces, infographics, A+ and video (M11).

**Later:** generated missing shots (M3-F5, P1) behind one bought-generation interface; the AI-image flag (M3-F6, P1);
ghost mannequin and flat lay to on-model (M3-F7, P2); try-on and model swap (M3-F8, P2); colour variants (M3-F9,
Later). Skipped: shopper try-on widgets (M3-F10) and digital twins or 3D (M3-F11).

## 3. Contracts

### 3.1 Reads
- **M0:** product, option, channel keys, source photos as content versions, the holdout control flag (M4 writes it).
- **M2:** `PhotoReading` (role, view, head state, cut sides, measured size and background, duplicates),
  `ProductReading` (taxonomy node, audience, length, pack), `GapReport` (missing roles with `fixable_by`).
- **M5:** per channel: canvas, margins, anchor, background, image-1 background, DPI, format, byte limit, image count
  limits, required roles in order, head-cut rule, crop size bars, crops allowed, generated images allowed.
- **M7:** routing for `image.matte`, `image.upscale`, `image.make.*`; the verdict on every generated image; the audit
  sample's results (a failed audit pulls an image).
- **M12:** brand switches (generation on, hosted services allowed, kids on model, intimates on model) and the
  per-brand likeness flag (owner only, Q15).

### 3.2 Writes (to M0)
- Every output as a content version: role, source kind (`brand`, `crop`, `upscaled`, `generated`, `vendor`), parent
  photo, derivation record (crop box and rule version, or generation request fingerprint and vendor trace id),
  render key, channel, position, hash.
- Slot rows per product x channel x role: state (`filled`, `missing`, `cut`, `planned`, `making`, `ready`, `live`,
  `not_made`), reason code, attempts.
- Events: `crop.made`, `render.done`, `image.generated`, `slot.not_made`, `publish.plan` (the ordered list per
  channel, with retire list), `image.pulled` (an audit failure or a channel stance change removed it).

### 3.3 Shapes (sketch)

```
CropRequest  { parent_sha, role, channel_bars{channel: px}, rule_version }
CropResult   { ok, box{x,y,w,h}, height_px, reason?: logo|no_whole_head|too_small|child|no_parent|no_view }
RenderRequest{ photo_sha (or crop/generated version id), channel, position, rules_version }
ImageMake    { capability: reference_edit|tryon|model_swap|ghost_to_model|background|scene,
               references[{sha, view, role}], target_role, sentences[] (code-owned), size: 2K|4K, aspect: 3:4,
               brand_id, cap_usd }
ImageMakeResult { ok, image_bytes?, width, height, vendor_route, cost_usd, seconds, refusal?: moderation|other }
```

Queue: `images.plan` per product after `analyze.product`; `images.crop`, `images.matte`, `images.upscale`,
`images.render` per photo x channel (existing pipeline tasks, idempotent on render key); `images.make` per slot (P1).

### 3.4 Contract needs from M0
1. Content version rows with parent links (crop and generated outputs point at their parents).
2. The holdout control flag readable at plan time and again at publish time; a control option is never planned for a
   new image and never republished.
3. Stable made-photo numbers: brand photos 1 to 100, made photos 101 upward, kept forever (stable public links).
4. A source-kind field that the publish file and M4 can split effects on (crop versus generated versus brand).

## 4. Features

### M3-F1 Crops that complete the set (P0)

#### 4.1.1 User story
As the operator, I want missing shots such as head-and-shoulders and back-to-the-hips cut from the brand's own larger
photos by fixed rules, and published on Namshi and Noon, so the gallery is complete without a photoshoot, a vendor or
my review.

#### 4.1.2 Functional requirements
- **M3-F1-R1** Crops are deterministic code with no network call: the output is the parent's own pixels as a lossless
  file plus the same box cut from the parent's cut-out (no new matting call). Rule version is stored. Cost 0 USD.
- **M3-F1-R2** Crops are published only on channels whose M5 setting `crops_allowed` is on. Seed: Namshi and Noon on;
  Styli, Centrepoint, 6th Street, VogaCloset, Trendyol, Shein and Amazon off until each channel's stance is recorded.
  A crop made for Namshi or Noon is never sent to another channel. The gap report shows the other channels' gaps as
  `crops_off_channel`.
- **M3-F1-R3** Parent table (which photo a crop may come from): FM from FL; BH only from BH, BL or another full back
  photo, never a mirrored front; HS from FM first, then other fronts, then FL; FW from FL or a front that shows waist to
  hem; BW from BL or a back that shows waist to hem; DT from FW, FL or flat, around the waistband, closure or pocket; FC
  from a flat (on-model areas only after a body-parts mask exists); BL, PK, FB and flat are never cropped. The parent's
  head state must be `full` for FM and HS.
- **M3-F1-R4** Bands, measured on the parent silhouette (outline of model and garment from the cut-out) from the top of
  the head: FM 62% to 72% for short and knee-length garments, 74% to 82% for long ones (midi, maxi, long coats); BH 48% to
  58%; HS 26% to 34%; FW and BW top line 36% to 46% (4% above the waistband once a garment mask exists), down to the feet,
  no head in frame; DT a 3:4 area at least 30% of garment width; FC a near-square 3:4 area at least 35% of garment width
  on the largest garment area, no detail crossing its edge.
- **M3-F1-R5** The cut line moves inside the band to the nearest row where no logo, text or detail area crosses it
  (OCR and logo areas from M2); if none exists the crop fails `logo`. Never cut through the head, a logo or any text.
- **M3-F1-R6** Head margin: at least 5% of crop height above the top of the head; a head touching the parent's top edge
  fails `no_whole_head`. Width: silhouette extent plus 4% each side, kept inside the frame, then padded (never cut
  further) to 3:4 when the frame allows.
- **M3-F1-R7** Size: the crop height must clear the channel's crop size bar (seed: Noon and Namshi 482 px). Below it the
  crop fails `too_small`; there is never a soft enlarged crop. One crop serves every channel that needs the role; the
  largest bar among them picks the parent.
- **M3-F1-R8** Never crop a photo of a child (kids audience with a person present): reason `child`; the close-up then
  comes from a flat lay only. Never crop outside the product's own storage prefix.
- **M3-F1-R9** A crop goes through the normal render, compliance check and judge like any brand photo, flagged
  `derived`. A crop that fails a check is never held: the slot tries the next parent, then the next ladder step, then
  `not_made` with a plain sentence (old initiative 02 sentences kept, for example "Noon: head and shoulders not made:
  no photo shows the whole head to cut it from.").
- **M3-F1-R10** Slot ladder, first that works wins: (1) an existing uncut brand photo of the role, including a reorder
  to position 1; (2) a crop; (3) a generated shot (M3-F5, P1, off in P0); (4) `not_made`. The old photo is never touched
  by a `not_made` slot.
- **M3-F1-R11** Carry-forward: a later batch of the same product re-inserts each earlier crop when its parent is still
  present; the crop is recomputed and must give the same box and file, else it becomes a new crop under the same
  number. If an uncut brand photo of that role arrives later, the crop is removed in the same publish that makes the
  brand photo live.
- **M3-F1-R12** Crops carry no AI flag (no new pixels). The source kind `crop` is recorded so M4 can split crop effects
  from brand photos.
- **M3-F1-R13** Holdout guard: a crop is planned and published only for options that are not holdout controls. A test
  proves a control option cannot receive a crop.

#### 4.1.3 Non-functional
Under 1 s CPU per crop; 0 USD vendor cost; at 2,000 products an hour, about 1.5 crops per new apparel option (old
initiative estimate) fits the existing worker. Deterministic: the same parent and rule version give identical bytes.

#### 4.1.4 Configuration (admin, no deploy)
Per channel `crops_allowed` and crop size bars (M5); band edges per role (data, with a rule version bump); the audit
rate for crops (M7). Changing a band is a rule change and is logged with a reason.

#### 4.1.5 Inputs and outputs
In: `PhotoReading`, `GapReport`, the parent's cut-out, M5 channel rows. Out: crop content versions, slot states,
`crop.made` events, digest counts.

#### 4.1.6 Human-in-the-loop rule
No per-crop review. Crops are covered by the M7 sampled audit: the crop cell starts at a 10% audit rate for its first
200 crops and drops to the standing 3% when the audit fail rate on head or logo cuts is under 1%; any audited head or
logo cut sends the cell back to 10%, pulls that crop at the next publish, and adds the photo to the regression set. A
person never approves a crop before it goes live.

#### 4.1.7 Edge cases and failure modes
1. Only a cut photo exists for a role a channel does not ask for: kept, moved after the required shots (`cut_kept`).
2. A cut photo that is wrong only as image 1: moved to a later position, not removed.
3. Copy failure during publish: the cut photo stays live; removals run only after every copy is verified and only if
   the replacement is in this publish or already live; otherwise the code refuses.
4. One-photo products: only crops inside that photo; no back roles (`no_view`).
5. 1,000 px brand masters: crops cannot fix them (`too_small`); the gap stays visible.
6. Head-state reading `unknown`: no FM or HS crop from that parent.
7. Newer delivery while older slots wait: older slots become `superseded`; the new batch re-plans.

#### 4.1.8 Buy or build
Build (keep the spec 12 design). Nobody sells crops to marketplace shot sets; generic tools only resize.

#### 4.1.9 Acceptance tests
1. Run a real Vero Moda or French Connection apparel batch to Namshi and Noon. Every missing HS, BH and FM that a parent
   can give is filled by a crop; no crop cuts a head, a logo or text (checked on the 10% audit sample); the Styli and
   Centrepoint outputs contain no crop (owner 2026-11-03: those channels never accept crops).
2. A unit suite over random plans proves: a cut photo is retired only by the publish that copies its replacement after
   verification; a slot never ends with fewer live photos; `not_made` never touches the old photo; a control option
   never gets a crop.
3. Re-running the same batch produces the same crop bytes and no duplicate outputs.

#### 4.1.10 Open questions
1. Styli and Centrepoint crops: answered, never (owner 2026-11-03).
2. HS crops of an approved kids model: default never.
3. Noon and Namshi crop size bar of 482 px: default keep; raise to 1,000 px if the audit shows soft crops.

### M3-F2 Background removal and upscaling (P0)

#### 4.2.1 User story
As the operator, I want clean cut-outs and sharp enlargements on our own GPUs at a fraction of vendor prices, with a
vendor taking over only when our service cannot, so batches never stop and stay cheap.

#### 4.2.2 Functional requirements
- **M3-F2-R1** Keep the matting service (`services/matting`, `/matte`) and the per-category model policy
  (`packages/core/src/catalog/qa/policy.ts`, `model_policy` table): first model, second model, then the service default.
- **M3-F2-R2** Keep the upscaler (`/upscale`, SwinIR x2 up to 2.0x, x4 above, `packages/core/src/catalog/upscale.ts`,
  `enlarge.ts`): every enlargement above 1.0x uses the upscaler; AI output is never sharpened.
- **M3-F2-R3** Both are capabilities behind the M7 vendor interface (`image.matte`, `image.upscale`) with a fallback
  chain: own GPU model 1 > own GPU model 2 > vendor overflow (off by default, switched on per capability by an admin
  with a daily cap). The CPU upscaler is not a default fallback (it costs USD 0.010 per call, 2.6x the GPU).
- **M3-F2-R4** Vendor overflow runs only when the GPU service is unavailable after its retries, or its queue would push
  the batch past its deadline. Every overflow call is logged with cost and reason.
- **M3-F2-R5** Matte guard and pass-through rules stay (`matte-guard.ts`): a close-up kept whole is never re-cut.
- **M3-F2-R6** Licence check: each served model has a recorded licence. `bria-rmbg` (CC BY-NC 4.0) is allowed for this
  internal tool (spec 08) and is replaced before any outside-brand self-serve (M12).

#### 4.2.3 Non-functional
GPU matting about USD 0.0018 per call, GPU upscale about USD 0.0039 per enlargement (measured, cost report); vendor
overflow USD 0.02-0.10 per call. Target: under 1% of calls on overflow in a normal week. The idle share (about 60%) is
M6's lever, not M3's.

#### 4.2.4 Configuration
Model order per category (`model_policy`); overflow on or off per capability; overflow daily cap; upscale thresholds.

#### 4.2.5 Inputs and outputs
In: photo bytes. Out: alpha mask; upscaled image; cost rows.

#### 4.2.6 Human-in-the-loop rule
None. The audit includes "edge or background left over" answers that feed the matting regression set.

#### 4.2.7 Edge cases and failure modes
White-on-white, transparent, reflective and thin-strap products (existing golden tags); cold starts (existing tests);
a vendor returning a different size (refused by the adapter); a GPU quota ceiling (L4 at 3, RTX at 4 instances).

#### 4.2.8 Buy or build
Keep our own (5-25x cheaper). Overflow vendor order: `image.matte` Photoroom Basic (USD 0.02) then a second vendor
chosen by bake-off; `image.upscale` a vendor upscale API (Photoroom or Claid, chosen by bake-off). Each overflow vendor
enters only after a bake-off on the existing matting golden set (`packages/core/test-fixtures/catalog/evals`).

#### 4.2.9 Acceptance tests
1. Stop the GPU matting service during a 50-product test batch with overflow off: the batch uses model 2, or delivers
   the affected slots as provisional pass-through renders under M1's auto-decide rules (never a held product), records
   the reason, and improves them at the same URL when the service returns.
2. With overflow on (test account, capped at USD 1), the same stop completes the batch through the vendor and the cost
   meter shows the overflow line.
3. The matting regression set shows no new defects against the last release.

#### 4.2.10 Open questions
1. Overflow vendor contracts: default none signed in P0 (no paid calls without Sujan's yes); the adapter ships switched
   off.

### M3-F3 Channel renders from rules (P0)

#### 4.3.1 User story
As an admin, I want each channel's canvas, margins, background and file format to come from the rules table, so a rule
change reaches the next batch with no code change.

#### 4.3.2 Functional requirements
- **M3-F3-R1** The render (`packages/core/src/catalog/render.ts`, `compliance.ts`) reads canvas, margins, anchor,
  background, image-1 background, DPI, format and byte limit from M5 rows instead of the constants in `channels.ts`.
  The constants become the seed rows.
- **M3-F3-R2** Background (settled): a neutral light grey at 240 or above on every channel (seed `#F0F0F0`,
  admin-editable, must stay at 240 or above on each RGB channel), and pure white `#FFFFFF` for Amazon image 1. Today's
  code renders `#E0E0E0` (224), which breaks the rule; the seed change fixes it. Shein image 1 white stays as an M5 row
  with its evidence grade (see open question 1).
- **M3-F3-R3** A render key includes the rules version, so a rule change re-renders only products in the next batch,
  never live products outside a batch. Controls in the holdout are never re-rendered or republished.
- **M3-F3-R4** Every output passes the compliance check for its channel (existing checks: canvas, margins, file type,
  size, name, DPI) plus the background lightness check.
- **M3-F3-R5** Pad, never cut, at render time (approved rule R11 from the old specs). Crops happen only in M3-F1 before
  the render.

#### 4.3.3 Non-functional
Render cost unchanged (worker CPU); a rules change takes effect on the next batch within a minute of saving.

#### 4.3.4 Configuration
All channel render values in M5 (canvas, margins, background, image-1 background, DPI, byte limit).

#### 4.3.5 Inputs and outputs
In: cut-out, photo or crop, channel row. Out: rendered output with render key; compliance result.

#### 4.3.6 Human-in-the-loop rule
None. A changed background colour is a rule change (admin, logged).

#### 4.3.7 Edge cases and failure modes
Square footwear on a 2:3 canvas looks small (audit): keep today's fit rules; Noon side margins only when the product is
wider than tall (existing). A rules version bump re-renders every product in the next batch, which can mean a large
re-upload on Trendyol: the digest shows the count before publish.

#### 4.3.8 Buy or build
Keep and build (generic resize tools do not know Noon or Namshi rules).

#### 4.3.9 Acceptance tests
1. An admin changes the Noon background in the rules editor; the next batch's Noon outputs use it and pass compliance;
   no live product outside the batch changes.
2. Every Amazon image 1 in a real batch is pure white; every other output's background reads 240 or above.
3. Amazon main-image rule pass rate on the golden set rises from 69% (baseline).

#### 4.3.10 Open questions
1. Shein image 1 white: default keep (current code), as an M5 row with evidence `assumed`.
2. Exact grey: default `#F0F0F0`; brand-specific grey only if a brand asks.

### M3-F4 Image set policy per channel x category (P0)

#### 4.4.1 User story
As an admin, I want each channel's required roles, order and counts per category stored as data, so the publish order
follows the channel without code.

#### 4.4.2 Functional requirements
- **M3-F4-R1** The policy rows live in M5 (seed tables from old initiatives 01 and 02). Namshi and Noon default row:
  image 1 FM or FL, then BH, FC, HS (Noon count and order confirmed; Namshi assumed). Bottoms: image 1 FW or FL, then BW,
  FC, DT. Lingerie and swimwear: on-model required (C14, owner 2026-11-03); when the brand has no on-model photo, flat,
  FB, FC fill the set and the gap is counted. Kids: flat, FB, FC on every channel; no person needed. A real brand photo of a child may fill
  slots after the flat where the channel allows it (Noon, Namshi, Styli, Centrepoint; Amazon slots 2+, image 1 flat);
  never kids underwear or swimwear on a child (owner 2026-11-03). Multipack: PK then the first three shots of the single-piece row. Footwear, bags, accessories: flat or
  side first. Amazon: image 1 FM or FL on model, then FC, BH, head-cut rule `amazon_nose_lip`.
- **M3-F4-R2** Publish order per channel: the required roles in order, each filled by the first usable photo of that
  role (brand before crop, then lowest number), then every other photo by number, duplicates last. Position 1 is never a
  cut photo when an uncut photo of the image-1 type exists.
- **M3-F4-R3** Counts: never exceed the channel maximum (Trendyol 8, Amazon 9, Shein and VogaCloset 10). At the cap,
  drop in this order: duplicates, `other`, extra lifestyle, extra detail. Brand photos of a required role are never
  dropped.
- **M3-F4-R4** Change values per publish (kept from old initiative 02): failed, shots_removed, new, cut_replaced,
  role_added, reordered, updated, unchanged. M0 records them for M4 and M10.

#### 4.4.3 Non-functional
Pure computation; under 50 ms per product x channel.

#### 4.4.4 Configuration
Rows in M5 (admin editor); evidence grade per row (documented, reported, assumed, playbook); a row with `assumed`
evidence warns, it does not block.

#### 4.4.5 Inputs and outputs
In: slots, readings, M5 rows. Out: `publish.plan` per channel.

#### 4.4.6 Human-in-the-loop rule
None per product; policy edits by admins.

#### 4.4.7 Edge cases and failure modes
No policy row: default row; `unknown` taxonomy: default row, crops only; uncertain taxonomy: strictest plan (M2).

#### 4.4.8 Buy or build
Build (nobody has GCC shot policies as data).

#### 4.4.9 Acceptance tests
1. An admin edits Noon's role order in the rules editor; the next batch follows it (slice S6).
2. On the golden set, no Namshi or Noon plan puts a cut or lifestyle photo first when an uncut front exists.

#### 4.4.10 Open questions
1. Namshi order: default copy Noon until Namshi confirms.

### M3-F5 Generated missing shots, mode A (P1)
- **Story:** as the operator, I want a missing apparel shot that no crop can fill made from the brand's own photos of
  the same product, checked by M7, so the set completes where a crop cannot.
- **Key requirements:**
  - One interface `image.make` (M7-F2) with capabilities `reference_edit`, `tryon`, `model_swap`, `ghost_to_model`,
    `background`, `scene`. Each adapter fails clearly when no image comes back, checks the size (at most 40 MB, at least
    the requested size within 10%), and keeps the vendor name only in the technical and cost record.
  - Fallback chains (seed order; the harness re-ranks): `reference_edit` Gemini image on Vertex > OpenAI image > FLUX
    (Kontext-class editing) > Photoroom (hosted, last, only when the brand allows hosted services); `tryon` and
    `model_swap` Vertex virtual try-on > FASHN (failed outputs not charged) > Photoroom virtual try-on; `ghost_to_model`
    Photoroom Plus > FASHN > Gemini image; `background` and `scene` (M11, Later) Photoroom > Gemini image > FLUX.
  - Runs only when all hold: brand generation on (off by default), the brand's **likeness flag** (M12-F3-R5) is on
    (mode A redraws the brand's own model, so it is a likeness use; Opptra holds likeness rights for brand models (owner
    answer Q15), and the owner sets the flag per brand, so the person step is per brand, never per product), the
    channel's `generated_allowed` on (seed on for Noon and Namshi, which accept AI-made images (owner 2026-11-03);
    off elsewhere until recorded), the role is
    required and no crop can fill it, at least one usable photo shows that view, not kids, not `unknown` taxonomy, and
    the caps allow it.
  - References: every usable photo of the product (no size charts, collages, made photos or Brand DNA logos), full
    resolution, in the order on-model fronts, backs, sides, details, fabric, flat front, flat back, pack. When the
    likeness flag is on, the references may also include the brand's model reference photos (the model pack, M12-F3-R7),
    taken from the brand's own photos or the brand's website. The output may show the exact model or a lookalike of the
    brand's model; never a child lookalike (kids only as the brand's own kids model, M11).
  - Identity consistency without biometric data (owner decision Q18): no face embeddings or biometric templates are
    stored anywhere (database, files, logs, caches or exports). Consistency comes from (a) the brand's model reference
    photos as generation inputs, (b) a visual similarity check between the output and the reference, computed in memory
    for that attempt and discarded (only the pass or fail and the score number are kept with the attempt), and (c) the
    M7 sampled human audit at the higher rate for people (1 in 10 adults).
  - Prompts are code-owned sentences only (old initiative 03): same person, same lighting, plain background in the
    channel's grey; forbid adding, moving or restyling any logo, label, print, embellishment or text; no more skin than
    the references; nothing added the references do not show. Text inside a photo is never an instruction. Operator
    text never reaches a generator.
  - Attempts: entry 1, entry 1 with stronger wording, entry 2; each attempt checked by M7 before the next; after the
    last, `not_made` (`failed_checks`). Batch cap = planned shots x USD 0.20 x 1.5, rounded up, at least USD 1. Measured
    trial prices: USD 0.101 and 0.137 per 2K image; about USD 0.20 per accepted image.
  - A generated image that passes M7 is published with the AI flag (M3-F6). In a new cell (brand x category x
    capability) it publishes only after the cell passes the M7 bake-off and its first 20 audited images; until then the
    product keeps its brand and crop set (no per-SKU queue: the cell, not the product, waits).
  - Never a synthetic child; kids only on an approved kids model of the brand (M11).
- **Acceptance test:** on the M7 generation golden set, the chosen route passes every planted defect and shows zero
  product-truth false passes; a real batch with generation on for one brand completes with every generated image
  flagged, every one checked, and the cost within the cap; killing the first vendor completes through the second.
- **Buy or build:** buy (six or more vendors at cents per image), build the planner, prompts, caps and checks.

### M3-F6 AI-image source flag (P1)
- **Story:** as an admin, I need every generated image marked so disclosure rules can be met and effects split.
- **Key requirements:** every rendered output of a generated image carries the IPTC digital source type "trained
  algorithmic media" in XMP with the description "AI-generated product image"; the compliance check reads it back and
  a missing tag blocks the output (`ai_tag_missing`, re-run by the system); M0 source kind `generated`; a per-channel
  sheet column "<Channel> AI-made" where a channel asks; Amazon's "contains synthetic performer" keyword off by default;
  a bulk pull-back that removes every generated image of a brand or channel in one publish when a channel stance changes.
- **Acceptance test:** zero generated images without the tag in a 100-image batch; a pull-back on Noon removes every
  generated Noon image at the next publish and leaves brand photos and crops untouched.
- **Buy or build:** build (a field and a metadata helper).

### M3-F7 Ghost mannequin and flat lay to on-model (P2)
Turns mannequin or flat photos into on-model shots for brands that send only flats (Cardio Bunny one photo per colour,
Anta flat apparel). Buy through `image.make` `ghost_to_model` (Photoroom Plus, FASHN, Gemini image); needs the brand's
likeness flag on (Q15) and the M7 fidelity check. Release R3 in `../roadmap.md`. Measured by fidelity pass rate and acceptance.

### M3-F8 Try-on and model swap: 2D garment to on-model (P2)
Puts the garment on the brand's own model, the exact model or a lookalike (Vertex virtual try-on, FASHN, Photoroom).
Gated by the brand's likeness flag, set by the owner (Q15). Human step: the owner sets the flag per brand (settled HITL
rule). Release R3. How one on-model image is made (owner asked this be a requirement, 2026-11-03):
- M3-F8-R1. Inputs: the garment photo (flat, ghost or packshot; cut out by our GPUs) and 2 to 4 photos from the brand's
  model pack (M12-F3-R7): front face and full body, taken from the brand's own photos or website. The model pack photos
  are stored as ordinary brand assets, deletable per model and per brand (M11 deletion rules).
- M3-F8-R2. The `image.make` capability `tryon` or `model_swap` receives garment plus pack photos and the code-owned
  prompt (M3-F5 prompt rules); the vendor chain follows M3-F5.
- M3-F8-R3. M7 checks every output: product fidelity against the garment photo (colour, logo, print, shape), the
  channel rules, modesty, and identity (a visual similarity score between the output and the pack, computed in memory
  for that attempt; only pass or fail and the score are kept). Fail means the next attempt; after the last, `not_made`.
- M3-F8-R4. A person audits a sample (1 in 10 adults, M7). Kids are never generated (M3-F5).
- M3-F8-R5. No face embeddings or identity vectors are stored (Q18). If the R3 bake-off shows that reference photos alone
  cannot hold the same face across a brand's images (identity pass rate below the M7 bar), the R3 requirements session
  proposes the stronger option, a per-model custom model ("digital twin", trained on the pack), for the owner to decide.
  The owner has said the data law is not a blocker (2026-11-03).
- **Acceptance test:** for one brand with a model pack, 20 flat garments produce on-model images where every published
  image passes fidelity and identity, the audit sample agrees, and no face vector exists in any table, file or log.

### M3-F9 Colour variants from one shot (Later)
Makes other colourways from one photo (Photoroom colour replace). Needs the M7 colour check (Delta E against the brand's
colour swatch) and a channel stance on generated images. Not before M3-F5 proves fidelity.

### M3-F10 Shopper try-on widget (Skip)
The channel owns the shopper page, not us.

### M3-F11 Digital twins and 3D/CAD (Skip)
Needs brand programmes and rights we do not have.

## 5. Operator experience
- **No screen of its own.** The batch digest (M1) shows: "Shot sets completed by cutting from your own photos: Namshi
  380, Noon 376. Not made: 38 (no photo shows the whole head). Styli and Centrepoint gaps are reported, not filled,
  until they confirm cropped photos." One exceptions sheet lists every `not_made` with its sentence.
- **Product page (optional):** a crop shows "Cut from photo 3 to complete the head-and-shoulders shot." A generated image
  (P1) shows "Made from this product's own photos to complete the back-to-the-hips shot." No engine names.
- **Admin:** channel switches for crops and generated images, background colour, cap settings, overflow on or off, all
  on the M5 and M12 settings pages, each change logged with who and why.
- Key copy when something is pulled after an audit: "Photo 104 was removed from Noon at the last publish: the audit
  found the head cut. The brand's own photos are live."

## 6. Measurement

| Metric | Baseline | Target | Source |
|---|---|---|---|
| Apparel options meeting the channel shot set on Namshi and Noon | about 2% (Styli 5-shot set 1 of 66 audited; HS missing 57 of 66) | above 80% of treated options | M2 gap report after M3; M0 |
| Image 1 with a cut head on Namshi and Noon (treated options) | 23% of on-model products have a head cut | 0% | M2 readings on published plans; audit |
| Backgrounds at 240+ (non-image-1) and white Amazon image 1 | 0% at 240+ (code renders 224) | 100% of new outputs | compliance check |
| Amazon main-image rule pass | 69% | above 95% | compliance on the golden set |
| Crop audit fail rate (head, logo, wrong product) | none | under 1% | M7 audit |
| Cost per product for images | about USD 0.08-0.15 estimated | at or below today; crops add 0 USD | M6 cost meter |
| Overflow share of matting and upscale calls | 0% (no overflow) | under 1% weekly | M6 cost meter |
| Generated images published without M7 pass or AI tag (P1) | n/a | 0 | M0 and compliance |

## 7. Build slices

| # | Slice | Depends on | Acceptance test |
|---|---|---|---|
| M3-S1 | Render reads M5 rows; seed rows from `channels.ts`; background 240+ grey and white Amazon image 1; holdout guard in the render key | M5-S1, M0-S1 | 4.3.9 tests 1 and 2 |
| M3-S2 | Crop engine as a pure function (R1, R3-R8), rule version 2, with golden head-test photos | M2-S3 head state | Crop unit suite; identical bytes on rerun |
| M3-S3 | Slot planner and publish order (M3-F1 R9-R11, M3-F4) with the remove-and-replace invariants | M3-S2, M2-S6 | 4.1.9 test 2 on random plans |
| M3-S4 | Channel switches (`crops_allowed`, `generated_allowed`) and digest counts | M3-S3, M1 digest | 4.1.9 test 1 on a real batch |
| M3-S5 | Matting and upscale behind the M7 interface with overflow adapters shipped switched off | M7-S2 | 4.2.9 tests 1 and 2 |
| M3-S6 (P1) | `image.make` adapters (Gemini image on Vertex, OpenAI image, FLUX, Photoroom, FASHN, Vertex try-on) behind one interface, each with size and refusal handling, tested with recorded fixtures (no paid calls until approved) | M7-S2 | Contract tests per adapter; kill-the-primary test |
| M3-S7 (P1) | Mode A planner, prompts, attempts, caps | M3-S6, M7-F4 | M3-F5 acceptance test |
| M3-S8 (P1) | AI tag, sheet column, bulk pull-back | M3-S7 | M3-F6 acceptance test |

## 8. Risks and open questions

| Risk | Effect | Mitigation |
|---|---|---|
| Namshi or Noon reject cropped photos | Treatment pulled, holdout weakened | Crops are the brand's own pixels; bulk pull-back per channel; live content watch (M9) catches rejections |
| A rules version bump re-renders everything in a batch | Large re-upload load, possible contamination of controls | Render key per product; controls never re-rendered; the digest shows the count before publish |
| Crop head and logo errors at scale | Bad images live | Code head detector plus model second opinion; 10% audit on the first 200 crops; pull on fail |
| Generators redraw prints (7 of 7 in trials) | Product-truth defects | M7 fidelity checks gate every image; product truth is a human audit item |
| Vendor terms on training with our photos | Brand data reused | Written no-training position before any live call (old gate G3) |
| GPU quota ceilings | Throughput limit | Vendor overflow switched on per capability; quota asks (M6) |
| AI stance unknown on every channel | Generated images may never publish | Default off per channel; ask channel managers (M5 channel gaps workflow) |

Open questions are listed per feature, each with a default.

## 9. Integration decisions

| # | Decision | Why |
|---|---|---|
| D1 | No output is ever held: when matting or upscaling fails, the slot follows M1-F3's rule table (provisional render, improved later); edited 4.2.9 test 1 | M3 and M7 said "output held", which contradicts gate 1 (no per-SKU queue) and M1-F3 |
| D2 | Mode A generation also needs the brand's likeness flag on (replaces "a valid rights record with may generate the model's likeness") | It redraws the brand's own model; the owner holds likeness rights (Q15) and sets the flag per brand |
| D3 | Made-photo numbering (101 upward) and slot rows are M3's own tables, not M0 fields; M0 stores the position per version | Keeps M0's contract small |
| D4 | The holdout treatment (experiment 1) is M3-F1 crops on Namshi and Noon only, rendered with the 240 grey; slices M3-S1 to M3-S4 are on the holdout critical path | Gate 1 and M4-F2-R7 |
| D5 | Open questions answered: Styli and Centrepoint crops off until recorded; never HS crops of a kids model; keep the 482 px bar, raise to 1,000 px if audits show soft crops; Shein image 1 white stays an `assumed` M5 row (not a gate-1 rule); grey `#F0F0F0`; Namshi order copies Noon until confirmed; no overflow contract in P0 | Technical defaults or already settled |
| D6 | Kept for the owner: channel managers' written stance on crops (Styli, Centrepoint) and on generated images (all channels), and paid generation and overflow vendor contracts (`../owner-questions.md`) | Marketplace relationships and money |
| D7 | Owner answers: Q15 likeness rights held by Opptra, per-brand flag set by the owner, exact model or lookalike allowed (never for kids); Q18 no stored face embeddings or biometric templates, identity from reference inputs plus an in-memory similarity check and the sampled audit | Owner decisions recorded in `../owner-questions.md` |
| D8 | `image.matte` call order (M3-S5): the policy's models only, in policy order (M3-F2-R1), on the GPU services, then vendor overflow, then the same models on the CPU cut-out service, then the simple method (`fallback_matte`). A model the policy did not choose is never asked. Inside an own tier, a service-level failure (busy after its retries, no connection, breaker open) skips that tier's other models, so a busy GPU costs one model's busy retries (3 calls, 2 waits of 1 to 3 s) as before; a model-level failure (an answered 5xx, an unknown model) moves to the policy's next model on the same service. The CPU service is kept as an own route after the vendor | The CPU service is today's tested fallback at no vendor cost: with overflow off (the default) a GPU outage or a busy GPU behaves as before; with overflow on, 4.2.9 test 2 and R4 need the vendor to take over when the GPU is down, before the much slower CPU service. Review 2026-11-04 (P2-1, P2-2) |
| D9 | Our own matting and upscale routes carry the recorded no-training position "own service in project image-links-agent: no third party receives the photo", so they can be `serving` under M7-F2-R7 | The photo never leaves our project; R7's check stays in code and in the database for every vendor route |
| D10 | `image.upscale` routes are seeded (GPU x2 and x4 serving, CPU off as an admin switch, vendor off) and the vendor upscale adapter ships contract-tested, but the spec 18 enlargement lifecycle does not read the table yet; an upscale outage follows M1-F3's enlargement-failed row | A vendor enlargement needs its own upscaler identity in the batch's pinned route and render key (spec 18 I1, I9) or a re-render would mislabel it; that design belongs with the bake-off that picks the upscale vendor (4.2.8). 4.2.9 tests 1 and 2 are matting only |
| D11 | Overflow runs only when the own GPU routes failed (R4's first trigger); the "queue would pass the batch deadline" trigger waits for a measured queue signal. The daily cap is a column on the route (`daily_cap_usd`, null = never called). Before each vendor call, the gate reads today's (UTC) ledger rows of that engine and kind plus this process's reservations (one reservation at a time per process). Every vendor HTTP call is written to the ledger as soon as it ends (answered, refused, wrong size or timed out; a timeout is priced, as it may be billed), billed to the vendor's own component, and then its reservation is released. Overshoot bound: calls already in flight in other worker instances are not yet visible, so a day can pass the cap by at most (worker instances - 1) x in-flight photos per instance (`WORKER_CONCURRENCY` x `CATALOG_PHOTO_CONCURRENCY`) x the route's price; one instance alone never passes it | No queue-depth signal exists on the worker today; the ledger already records every overflow call with its cost (engine = adapter), which is also the cost meter's "cut-out overflow" line. Review 2026-11-04 (P2-4, P2-5) corrected the earlier "one call per worker" bound |
| D12 | M3-S5's part of 4.2.9 test 1 is the routing: model 2 on the GPU, the CPU route, or `fallback_matte` with the reason in the route log and ledger. Delivering a `fallback_matte` slot as provisional and improving it at the same URL are M1-S3 (rule table) and M1-S4 (improvement task) | Those slices own provisional delivery and same-URL republish (M1-F3-R1, R4); M3 must not build a second path. The route id per output reaches M0 with the content-version work (M7 3.4.3) |
