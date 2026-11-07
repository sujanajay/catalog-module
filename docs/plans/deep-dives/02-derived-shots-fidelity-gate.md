# DD2: Derived shots and the generated-image fidelity gate (working name "spec 12", bucket B2)

Date: 2026-10-22. Program: docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md (sections 2 to 5, 7).
Investigation only. Nothing here is implemented; SPEC.md is not edited (the wording in R4 is a draft for the owner).

## Summary

- Sampled 24 apparel options (110 images, all 1200x1800 as Trendyol serves them) from French Connection, Penti and Vero Moda. Roles 1, 4 and 5 are present or crop-derivable on 23 of 24; role 3 (fabric without the model) exists on only 3 of 24 and is absent in any form on 7; role 2 (head to toe) is missing on 5 of 24 (all Penti) and cannot be derived. The back view is almost never the gap (1 of 24).
- U.S. Polo in the warehouse is footwear only (master_sl 529 options, 2,974 SKUs; Trendyol 547 options, 501 sneakers, 5.9 images per option). The "2,700 options with 3 images" apparel line is not in any warehouse table; it must be sampled from the brand's files before it is the pilot.
- Crop derivation clears Styli (741 px source height with the x2 upscaler) only from a mid-thigh or hips framing on a 1200x1800 source. From a head-to-toe shot the head-and-shoulders crop is about 450 px and fails; on 800x1200 originals (the golden set) every derived crop fails Styli. Larger brand masters are the lever, not a generator.
- The gate for generated shots: six measured checks (garment identity by DINOv2 plus judge, logo and text by OCR string equality with no invented text, CIEDE2000 on the garment mask, LPIPS and texture energy on matched patches, model and scene consistency, crop geometry), every check gating, typed hold flags, review-all until exit numbers hold on at least 300 human-labelled shots.
- catalog-service's verifier is advisory by constant (VERIFY_RETRY_ENABLED = False, MIN_CONFIDENCE 80 only paints a badge). Port its typed mismatch kinds, role-labelled image prompt and fail-closed plate chaining; replace its "claims" axis with measured checks and make the result a hold.
- Build on what exists (tesseract.js, LPIPS endpoint, CIEDE2000 code, the two-model judge, Apache-2.0 DINOv2 as one more matting-service endpoint). Closed OCR APIs (Google Vision USD 1.50 per 1,000, AWS Rekognition USD 1.00 per 1,000) add little and break the "no paid image API without a yes" decision.
- Approval needed on: the derivation rules, the initial gate bars and exit numbers, and the SPEC.md wording.

## Findings

### F1. What roles exist per option (data evidence)

Sources and query shape (all read only, BigQuery project opptra-datawarehouse):

- `raw_gcc_dimensions.master_sl`: `GROUP BY brand` over `option_id_style_color`, `image_url`. One `image_url` per SKU, so it gives no per-option image count. Brands and distinct image URLs: Campus 1,013 options / 408 URLs; French Connection 900 / 710; U.S. POLO ASSN. 529 / 528; Penti 428 + PENTI 188 / 454 + 188; Vero Moda 121 / 120 (679 of 1,207 SKUs carry a URL).
- `gcc_channel_reports.product_list_trendyol_3p_uae` (111,314 rows; latest `file_date` 2026-10-21): per option (`brand, model_code, product_color`), `MAX` over rows of the count of non-empty `image_1..image_8`. This is the only per-option image-count source in the warehouse.

| Brand (Trendyol UAE) | Options | 1 img | 2 | 3 | 4 | 5+ | Mean | Options with 3 or fewer |
|---|---|---|---|---|---|---|---|---|
| French Connection | 824 | 0 | 43 | 112 | 147 | 522 | 5.06 | 155 (18.8%) |
| Penti | 690 | 6 | 18 | 60 | 180 | 426 | 4.72 | 84 (12.2%) |
| U.S. Polo Assn. | 547 | 0 | 1 | 1 | 80 | 465 | 5.87 | 2 (0.4%) |
| Vero Moda | 306 | 64 | 20 | 3 | 26 | 193 | 4.08 | 87 (28.4%) |

By category: French Connection options with 3 or fewer images are mostly non-apparel (Room Spray 24 of 26, Odor Remover 13 of 19, Earrings 11 of 11); apparel categories sit at 5 to 5.5 images. Penti Pajama Sets: 196 options, 30 with 3 or fewer. Vero Moda Shirts: 24 options, 12 with 3 or fewer; Trousers 30, 12. U.S. Polo Assn. on Trendyol is Sneakers 501, Sandals 12, Home Slippers 12, Sports Slippers 11, Mules 10: no apparel. In master_sl U.S. POLO ASSN. categories are Default 240, Shoes 235, SLIPPERS 21, BOOTS 10, Women's Sneaker 10, Kids Shoes 10 (options). The 2,974 SKU count is the closest number to the "2,700" said in the meeting; the apparel line is not in the warehouse.

Catalog module data: GCS `gs://image-links-agent-assets/catalog/` holds batches for campus, gtplayer, keds, nuwey and penti (one penti product prefix with raw, derived, staging, exports, uploads). The spec 10 golden set under `catalog-test/evals/golden/sources/` (file names `<identifier>_<n>.<ext>`): vero_moda 77 files, 21 products (1 shot: 3, 2 shots: 5, 4: 2, 5: 10, 6+: 1); french_connection 160 files, 35 products (1: 4, 2: 1, 3: 8, 4: 2, 5: 4, 6+: 16); penti 75 files, 16 products (3: 1, 4: 8, 5: 3, 6+: 4). Golden originals are 800x1096 (Vero Moda) and 800x1200 (French Connection, Penti) per docs/specs/10-output-quality-evals.md section 11.

What the pipeline records today (packages/core/src/db/schema.ts): `catalog_source_images` has `n`, `sha256`, `width`, `height`, `flags`, matte fields; `catalog_outputs` has `source_image_id`, `channel`, `n`, canvas and placement, `render_key`, `compliance` jsonb, `qa_scores`, `flags`, `decision`. There is no shot role, no derivation record and no generator record. The judge returns a `view` (packages/core/src/catalog/qa/judge.ts `VIEWS`: front, side, back, sole, top, inside, detail, on-model, flat, chart) that is stored only inside `qa_scores`; it is the closest thing to a role today and DD1 owns the role model.

### F2. Sample classification by eye (24 options, 110 images)

Method: 8 random options per brand (FARM_FINGERPRINT order) with at least 3 images from the Trendyol UAE table, images 1 to 5 downloaded to the session scratchpad, read as six contact sheets. Every image is 1200x1800 (Trendyol re-encodes; these are not the brand masters). Roles per the Styli email: R1 front cropped mid-thigh, R2 full length head to toe, R3 fabric close-up without the model, R4 back cropped at the hips, R5 head and shoulders.

| Role | Present as shot | Derivable by crop (from which) | Not derivable or not applicable |
|---|---|---|---|
| R1 front mid-thigh | 15 | 8 (from a head-to-toe front with the head whole) | 1 (Penti briefs: intimates, no face by design) |
| R2 head to toe | 19 | 0 | 5 (Penti 12, 13, 14, 15, 16: tight crops, no full body anywhere) |
| R3 fabric, no model | 3 (FC 5, Penti 10, VM 17) | 4 from a flat lay (VM 19, 21, 22, 24); 10 more have an on-model fabric close-up with no face (acceptance by Styli unknown) | 7 with no fabric close-up of any kind (FC 2, 3, 7, 8; VM 20, 23; Penti 14) |
| R4 back at hips | 12 | 11 (from a head-to-toe back) | 1 (VM 19: three-quarter back only) |
| R5 head and shoulders | 5 with the face whole (FC 7, Penti 11, 13, VM 20, 23); 5 more cut at the nose (Penti 10, 16, VM 18, 22, 24) | 13 (from R1 or R2 with the head whole) | 1 (Penti 14) |

Other observations: 4 of 110 images are head-to-toe shots with the head cut at the frame edge (FC 5 image 1; FC 8 images 1, 2, 3), the defect type Styli rejects; about 20 are deliberate body crops without a face (detail shots), which Styli accepts. Vero Moda ships a flat lay as the last image on 5 of 8 options, which makes R3 a crop and also gives a clean garment reference for any generator. Penti intimates and pyjamas carry a size chart as an image (Penti 14 image 3), already handled by the judge's `chart` view.

Reading: for these three brands fill-to-5 is mostly R3 and R5, both crops when the resolution allows; R2 is the generative gap and it sits on Penti-type tight crops; R4 (back) is almost never missing. The owner's hypothesis holds for R3 and R5; the "back view needs new pixels" half is rarely exercised on this sample, and the real generative case is "full length from a crop", the hardest one.

### F3. Derivation arithmetic (repo evidence: packages/core/src/catalog/channels.ts, render.ts, upscale.ts)

Rules that apply to a derived crop exactly as to any source: `planCanvas` fits the product box into the channel's safe box; `lowResolution = fit(min) > MAX_UPSCALE` (1.5), a flag on every channel; only Styli skips, and since the owner decision of 2026-10-21 Styli divides the needed fit by `UPSCALE_FACTOR` (2) when the upscaler is configured (`styliMinSourceHeightPx(2)` = ceil(1482 / 2) = 741). The upscaler runs once per source photo (`sourceX2`), so a derived crop cut from the same `Prepared.rgb` buffer reuses the x2 image at no extra GPU call. A crop whose box fills more than 85% of its frame is a `detailShot` and is exempt from Styli's uniform scale across angles (`DETAIL_SHOT_BBOX_FRACTION`), which is right for R3 and R5.

Source crop height a portrait (3:4) crop needs so that height binds and no flag or skip is raised:

| Channel | Canvas and safe box used | Flag-free source height | With the x2 upscaler |
|---|---|---|---|
| Styli | 2342x3123 fixed; margins 450 top and bottom, 150 sides; safe 2042x2223 | 2223 / 1.5 = 1,482 px | skip line 741 px (flag stays) |
| Centrepoint | 3000x3000 fixed, no margins | 3000 / 1.5 = 2,000 px | flag unchanged; visible quality floor 1,000 px (x2 then 1.5x) |
| Trendyol | 1200x1800 fixed | 1,200 px | quality floor 600 px |
| Noon, Namshi | effective minimum 660x904 (fraction 0.6111 of 1080x1480), 10% top and bottom: safe height 722 | 722 / 1.5 = 482 px (790 px for the full 1080x1480) | not triggered under 1.5x |
| Amazon, Shein | effective minimum 1000x1000 | 667 px (1,334 px for 2000x2000) | as above |
| 6thStreet, VogaCloset | effective minimum 1200x1600 | 1,067 px (1,778 px for 2000x2667) | as above |

Crop heights the sample gives (body fills about 90% of the frame in a head-to-toe shot: 1,620 px at 1200x1800, 1,080 px at 800x1200):

| Derived role, source role | Share of body | Source px at 1200x1800 | At 800x1200 | Styli 741 | Noon 482 | Amazon 667 |
|---|---|---|---|---|---|---|
| R5 from R2 (head to below the bust) | 28% | about 450 | about 300 | fail, fail | fail, fail | fail, fail |
| R5 from R1 (R1 frames head to mid-thigh, 55% of the body) | 28 / 55 | about 825 | about 550 | pass, fail | pass, pass | pass, fail |
| R4 from a head-to-toe back (head to hips) | 50% | about 810 | about 540 | pass, fail | pass, pass | pass, fail |
| R1 from R2 (head to mid-thigh) | 60% | about 970 | about 650 | pass, fail | pass, pass | pass, borderline |
| R3 from a flat lay (one third of the garment) | n/a | about 480 | about 320 | fail unless the crop is at least 741 px (41% of the frame) | borderline | fail |

Centrepoint and 6thStreet flag every crop in the table as `low_resolution` (information; Centrepoint already flags a whole 1200x1800 photo: 3000 / 1620 = 1.85 > 1.5). Trendyol delivers every crop at 1200x1800 with the flag.

Conclusions: (1) R5 and R4 derive cleanly from the mid-thigh and hips framings, not from the head-to-toe shot, on 1200x1800 sources; (2) on the 800x1200 originals in the golden set no derived crop clears Styli, so B2 depends on getting the brand masters (studio masters are normally 2,000 px and above; a 2,400 px tall master makes R5 from R2 about 900 px and passes everything but Centrepoint flag-free); (3) a fabric close-up that is a real magnification needs the largest source of all, and the flat lay is the right parent; (4) the crop never changes a pixel, so the spec 10 `geometry.pixels_copied` and `cutout.*` checks already prove fidelity for derived outputs; what is new is a crop rule, a role record and a resolution floor per derived role.

Crop rule (deterministic, for R1, R4, R5 and an R3 cut from a flat lay): the cut line sits in the role's band (R1 mid-thigh, R4 hips, R5 below the bust) measured on the matte silhouette, never through a `detailFeatures` region (logo, text, buckle; the `trimRoom` logic in render.ts already computes this), the head box whole with a margin of at least 5% of the crop height above it (the "only head cuts fail" rule), left and right at the silhouette plus the channel's margin, and the derived output carries the information flag `derived` and its parent `source_image_id` plus the crop box in `compliance` (no schema change for the box; a `role` column on `catalog_source_images` and on `catalog_outputs` is needed, DD1's model).

### F4. The fidelity gate for generated shots (repo evidence: docs/specs/10 and 11, judge.ts, auto-resolve.ts)

What exists and is reusable:

- Spec 11 section 4.4 fidelity gate (`packages/core/src/catalog/evals/enhancement.ts`): SSIM, LPIPS (`POST /measure/lpips` on the matting service, AlexNet-linear, BSD-2), CIEDE2000 mean on the product area, OCR on `detailFeatures` regions with tesseract.js (Apache-2.0) at source confidence 60 or more, Laplacian texture energy ratio per 16 px cell, halo band, determinism. It compares a restoration with its own original, pixel aligned; a generated shot has no aligned original, so each check needs a matching step or a reference-free form.
- Spec 10 harness: golden manifest pinned by sha256, planted defects (`planted_caught` 100%), `attention.*` bars (false-hold rate 0, judge false positive 0), eval labels (`catalog_eval_labels`, `catalog_eval_judgements` with `judge_model` and `verdict` pass or flag), calibration sections 15a to 15e that set bars from measured runs. The same calibration discipline applies here: initial bars below, final bars from the labelled set.
- Judge v2 (judge.ts): per-dimension pass lines (no mean), photo dimensions at the floor, output dimensions at the threshold, `wrong_item` and located leftover need two models to agree, `view` per image, evidence sentences, flags by severity, `qa_unavailable` on failure. Auto-resolve (auto-resolve.ts): bounded ladder of re-renders before a hold, at most one re-judge per step, actions recorded in `compliance.auto_actions`.
- Attention flow (spec 07 section 4.7): one card per problem, `use_as_is` or `remove`, scope per photo or per channel, decisions recorded with the email, publish only after decision. Cost of one judge check measured at USD 0.00014 (packages/core/src/catalog/cost.ts, batch b489e466, 52 calls), fallback list price up to USD 0.0013.

What the literature says (web, 2025 to 2026): paired metrics (SSIM, LPIPS, DISTS) need a ground truth of the same view; FID and KID are set-level and "fail to reflect garment texture preservation" (VTBench, arXiv 2505.19571); LPIPS-type scores are "insensitive to localized failures such as a distorted logo" (OpenVTON-Bench, arXiv 2601.22725), so logo preservation is rated as its own dimension (dimension-wise garment fidelity assessment, DAT) and VTBench measures text on garments with OCR (PP-OCRv3 term and edit-distance similarity, its "Font Texture Similarity"). Try-off and try-on papers that must choose one perceptual score prefer DISTS over SSIM for garments (TryOffDiff, DualFit). Practical reading: the gate needs a localized text and logo check, a masked identity check, a colour check, and a human protocol; a single global score is not a gate.

Comparison with catalog-service (C:\Users\Sujan Ajay\Desktop\catalog-service\server\pipelines\generation\verify.py and gallery.py):

| catalog-service today | Port | Change |
|---|---|---|
| Three axes: identity (hard), claims (hard), quality (advisory); `ship_score = min(identity, claims)`; `MIN_CONFIDENCE_PERCENT = 80` | the hard versus advisory split and the "min, never a mean" rule (the judge already does this) | claims (overlay text versus the product card) has no object in catalog-module: text on images is forbidden, so the second hard axis becomes measured text and logo preservation (G2) and invented text is a hard fail |
| Typed mismatches `kind in {contradiction, invented, identity, quality, duplicate}` with `source_field`, `catalog`, `observed` | the typed structure, stored as evidence beside the flag (the judge's `evidence` map today is free text) | kinds become `wrong_garment`, `logo_changed`, `text_invented`, `colour_shift`, `texture_changed`, `model_mismatch`, `anatomy`, `crop_rule`; each names the measure and the number |
| Advisory by constant: `VERIFY_RETRY_ENABLED = False`; `below_threshold()` only drives a badge and an optional one-shot re-render | the one-shot retry idea, as a bounded ladder | gating: any hard fail holds the output; nothing below the bar is ever published without a person; the retry is at most two regeneration attempts, recorded like `auto_actions` |
| Role-labelled attachments ("GENERATED IMAGE", "SOURCE PHOTO n of N", "CANONICAL PRODUCT"), "prefer a miss over a silent ship", never read overlay text on source photos | all of it, into the generated-shot judge template | sources are the brand's own photos of the same option, labelled by role (front, back, flat lay) |
| `plate_chain_ok`: fail closed before a generated plate becomes the reference for later slots | the same fail-closed rule for the first generated shot of a product when later shots condition on it | the reference stays the brand's photo wherever one exists; a generated shot is never the only reference |
| Model-painted overlay text, no brand scoping, overwritten versions (known defects in the program doc) | nothing | catalog-module's identity, locks, versions and publish contract apply unchanged |

### F5. Costs and licences that matter

- Open: DINOv2 (Apache-2.0 after the CC-BY-NC start; DINOv3 is a custom commercial licence with redistribution terms, not needed), tesseract.js (Apache-2.0, already in the evals), PaddleOCR PP-OCRv5 ONNX (Apache-2.0, 7.5 MB latin recognition, 81 MB server recognition), LPIPS weights (BSD-2, deployed), DISTS (upstream licence not confirmed in this session; torchmetrics carries an implementation), CIEDE2000 (code exists in enhancement.ts).
- Closed OCR: Google Cloud Vision Text Detection and Document Text Detection USD 1.50 per 1,000 units after the first 1,000 units per month (official pricing page); AWS Rekognition DetectText USD 1.00 per 1,000 images after 1,000 free per month (official pricing page; images leave GCP).
- Judge calls: USD 0.00014 measured per check; three checks per generated shot (identity, model and scene consistency, anatomy) are about USD 0.0004 per shot, USD 0.004 at the list fallback. GPU measures (embedding, LPIPS, OCR) on the L4 at USD 0.00034884 per second (spec 11 section 7): about one second per shot.
- Generators (DD3 owns the bake-off): Vertex `virtual-try-on-001` and `imagen-product-recontext-preview-06-30` exist (1024x1024, 1:1, up to 4 images per request, access by form); their per-image prices were not reachable on the official pricing page in this session and are not quoted here.
- Context7 was not available in this session; licences and prices above come from the official pages and model cards. Spec 12 must re-check each library's current docs with Context7 before any code, per the repo rule.

## Options

| Option | Fit | Cost | Trade-offs |
|---|---|---|---|
| O1 Build on what exists: tesseract.js, `/measure/lpips`, CIEDE2000, the two-model judge, plus DINOv2 ViT-B/14 as an ONNX endpoint on the matting service (`/measure/embed`) | highest: same harness, same flags, photos stay in the project | GPU about one second per shot; judge about USD 0.0004 per shot | one more model to export and version (the `UPSCALE_MODEL_VERSIONS` pattern); tesseract is weak on stylised logos, so a template-match fallback and a PaddleOCR upgrade path are kept |
| O2 Closed OCR or vision APIs (Google Vision, AWS Rekognition) | medium: better on dense or curved text, no evidence of better logo handling | USD 1.50 or USD 1.00 per 1,000 images; negligible in money | breaks the recorded decision "no paid image API without a separate owner yes"; Rekognition takes photos out of GCP; no gain on the identity, colour and texture checks |
| O3 Judge-only gate (the catalog-service shape) | lowest build, familiar | judge calls only | the literature and catalog-service's own experience say a VLM score misses localized logo and text damage unless a measured check sits beside it; it stays one voice, not the gate |
| O4 Research evaluators (VTBench, DAT) as code | poor: research code, unsupported | free | borrow the ideas (OCR-based text similarity, logo as its own dimension, per-dimension human ratings), not the code |
| O5 Ready-made plug-ins or MCP servers for similarity or OCR | none found that gives a gating-grade garment identity check; generic image-similarity endpoints exist | per call | no provenance of the model or its version, which the render_key discipline needs; not recommended for the gate |

Open versus closed: every measure in O1 is open weight with a pinned export hash, so a gate result is reproducible and explainable on the card (the sentence names the measure, never the model). Closed tooling is only worth it if the labelled set shows tesseract failing on more than a fifth of the logo regions; then PaddleOCR (open) is tried before any paid API.

## Recommendation

### R1. Derivation rules (deterministic path, ships first)

1. Roles 1, 4 and 5 are made by crop and the existing render only, from a source of the same option whose head is whole; role 5 from the mid-thigh or hips framing when one exists, from the head-to-toe shot only when the crop still clears the channel (F3 table); role 4 from the back shot only (never a mirrored front).
2. Role 3 is a crop of a flat lay or of a fabric region with no skin, hair or face in it; whether Styli accepts an on-model fabric crop is asked of Styli once, in writing, before the rule is widened.
3. A derived output is made only where its crop height clears the channel's floor (Styli 741 px with the upscaler, otherwise the channel's flag-free height); below that it is not made and the links sheet says "Not made: the photo is too small to cut a <role> from it", never a soft, enlarged crop.
4. The crop never cuts through a head, a `detailFeatures` region or a logo; the cut line sits in the role's band; the output carries the information flag `derived`, its parent and crop box, and passes every existing check (`pixels_copied`, cut-out, compliance, the judge) like any output.
5. Brand masters are requested at 2,400 px on the long side or more for every brand entering B2 (DD8 records this per brand); 800x1200 inputs are declined for derivation with the sentence above.

### R2. Gate bars for generated shots (initial; final bars come from the labelled set, as spec 10 section 15 did)

| Check | Measure | Initial pass bar | On fail |
|---|---|---|---|
| G1 garment identity | DINOv2 cosine between the garment-mask crops of the generated shot and the brand's photo of the same view; judge "same garment" with two-model agreement | same view 0.85 or more; cross view (back from front) 0.70 or more and both judges agree | hold `wrong_garment` |
| G2 logo and text | OCR on every source `detailFeatures` region with confidence 60 or more; the same string must be read on the generated shot (whitespace normalised, Levenshtein ratio 0.90 or more); no string on the generated shot that no source carries; logos without text by normalised cross-correlation 0.70 or more after a scale search | every region passes; zero invented strings | hold `logo_changed` or `text_invented` |
| G3 colour | CIEDE2000 between the three dominant Lab colours of the garment mask (weighted by area), generated versus source | mean 3.0 or less, each dominant colour 5.0 or less | hold `colour_shift` |
| G4 texture and print | LPIPS on three feature-matched 256 px garment patches (same view); Laplacian energy ratio on the garment mask | LPIPS 0.35 or less per patch; energy ratio median 0.7 to 1.4; cross view by judge pattern continuity | hold `texture_changed` |
| G5 model and scene consistency | across the five shots of a product: background within the compliance tolerance; skin tone CIEDE2000 on a face and neck mask 3.0 or less to shot 1; judge pairwise "same person, same lighting"; judge anatomy check (hands, limbs) | all pass; no face embeddings stored or compared across products | hold `model_mismatch` or `anatomy` |
| G6 crop geometry | head box whole with 5% margin, cut line in the role's band, 3:4 frame | pass | hold `crop_rule` |

Verdict: every check passes, or the output is held; no mean, no override by a high score elsewhere. Regeneration ladder: at most two more attempts (new seed, then stronger reference weighting), each re-gated, recorded in `compliance.auto_actions`; then the hold stands. Every generated output carries the information flag `generated` and a `gen_key` (generator id and export version, prompt hash, reference shas) with the same role as `render_key`; the generator id never reaches operator copy.

### R3. Human-label protocol and the exit from review-all

- Every generated shot is held for a person until Gate D (program section 8); the card shows the five shots of the product with the brand's sources, the role and the check that failed, and the decisions stay `use_as_is` or `remove`.
- Labels: two raters (the operator and one trained reviewer), independent, blind to the generator, per shot six yes or no questions (same garment; logo and text intact; colour the same; print and texture the same; same model, lighting and background; anatomy and crop acceptable) and one publish yes or no; a third person adjudicates disagreements; stored in `catalog_eval_labels` beside the gate numbers.
- Agreement: Krippendorff's alpha per question 0.67 or more on the pilot before any bar is finalised (0.80 the target); below that the question is reworded, not the bar.
- Exit numbers (owner Gate D): on at least 300 labelled generated shots over at least three brands and all five roles, gate false passes (human reject, gate pass) 2% or less with zero on G1 and G2; false holds 15% or less; planted defects (wrong garment, altered logo, colour shift of 5 or more) caught 100%. After exit, 10% sampled review per batch with the same numbers; a batch over 2% false passes returns the brand to review-all.

### R4. SPEC.md amendment wording (draft; the owner edits SPEC.md)

Replace the two non-goal bullets "No generative edits or paid image APIs; product pixels are never regenerated..." and "No cropping of any kind; no cap on images per product or per channel." with:

> - Product pixels in the default path are never regenerated. Two exceptions, each behind its own flag and spec: (a) the deterministic x2 upscaler behind `UPSCALE_MODEL` that passed the spec 11 fidelity gate (outputs flagged `upscaled`, information); (b) generated on-model shots under spec 12, made only for a role the channel requires and the brand's photos do not provide, only by a generator the owner has approved in writing, only from the brand's own photos of the same option as reference, always gated by the spec 12 fidelity checks (any failed check holds the output) and flagged `generated`; generated outputs stay in review-all until the spec 12 exit numbers are met and recorded here.
> - No cropping of a brand's photo except role derivation under spec 12: roles a channel requires (front cropped mid-thigh, back cropped at the hips, head and shoulders, fabric close-up) may be cut from a larger photo of the same option when the cut keeps the head and every logo or text whole, sits in the role's band and clears the channel's size floor without enlargement beyond the existing cap; derived outputs are flagged `derived` and pass every check a source output passes. Nothing else is cropped; no cap on images per product or per channel.

Amend R11 to: "R11 Never cut any part of the product or model when rendering a photo; pad instead of crop. A spec 12 role derivation is a new source made by a rule-bound cut (head and logos whole), not a render-time crop." Amend the line "Styli: every Styli image on the 2342x3123 canvas with Styli's guides. Never crop." to end "Never crop at render time; role derivation only under spec 12."

Add to Non-goals: "No face recognition and no stored face embeddings; model consistency is judged per product and never matched across products or brands."

## Approval question

Do you approve, as the basis for spec 12: (a) the derivation rules in R1 (crops only from a source with the head whole, role 3 from a flat lay or a no-skin fabric region, nothing below the channel floor, every derived output flagged and checked like a source output), (b) the initial gate bars in R2 and the exit numbers in R3 (review-all until 300 labelled shots show 2% or fewer false passes with none on garment identity or logos), and (c) the SPEC.md wording in R4?

Status: done, awaiting owner answer
