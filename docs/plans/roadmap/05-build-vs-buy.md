# 05 Build vs buy: Photoroom and alternatives

Agent E of the GCC catalog roadmap proposal. Documents only; nothing was built, no paid call was made, no account was
created. Vendor facts were read on 2026-10-26 (pages cited inline). Costs are compared on price, fit and control only;
there are no build-time or effort estimates (owner rule).

## Summary

1. What works today stays ours: cut-out, per-channel render for 9 channels, shadows, upscaler, compliance, the judge
   with auto-repair, evals, publish, links sheet and the cost ledger are live and cost about USD 0.004 to 0.012 per
   style-colour for all channels. Buying the same from Photoroom would cost about USD 1,600 to 14,000 a year at our
   volume and would add pixel-regenerating steps our fidelity rules forbid. Do not re-buy it.
2. The open gaps are generation (fill missing shots, flat lay to on-model, lifestyle) and infographics. No vendor,
   Photoroom included, does the five-role set with one consistent model, our channel rules, or Arabic text from our facts.
3. Photoroom is a good engine but a poor platform for us: Virtual Model is 1K on self-serve (2K and 4K need Enterprise,
   whose minimum is 200,000 images a year, about 60 times our generation need); servers are US only; self-serve plans
   train on images unless opted out; no SLA below Enterprise; JPEG export is fixed at quality 80.
4. Recommendation: hybrid. Keep the platform (channel rules, QA gate, evals, review, publish, ledger). Buy generation as
   a swappable engine behind it: Nano Banana 2 through OpenRouter first (DD3), with FASHN Product-to-Model and Photoroom
   Virtual Model as named second engines to trial on the same gate. Keep Photoroom Basic (USD 0.02 a photo) as an
   optional cut-out fallback, not a replacement. Avoid remove.bg (standalone service closes 1 December 2026).

## What we have today

Read from `docs/SPEC.md`, `docs/PROGRESS.md` (sessions 5 to 7), specs 10 and 11, and `packages/core/src/catalog`.
Live build D7 `62c886c` (2026-10-22). Paths are relative to the repo `catalog-module`.

| Capability | State | Where |
|---|---|---|
| Cut-out (matting) | Built, live. Local open-weight models (BiRefNet family, RMBG-2.0 with owner permission) on a CPU service and one L4 GPU service; per product type policy chosen by the bake-off; matte guard (translucent rejection, sole strip recovery, pass-through holds); flood-fill fallback behind a circuit breaker | `packages/core/src/catalog/matte.ts`, `matte-guard.ts`, `services/matting/app.py`, `evals/matte-bakeoff.ts` |
| Per-channel render | Built, live. 9 channels (Noon, Namshi, Trendyol, Styli, Centrepoint, 6thStreet, VogaCloset, Amazon, Shein), exact canvases, margins, Styli guides and bottom anchor, white image 1 for Amazon and Shein, flush placement for photos cut at the frame, JPEG 4:4:4 sRGB with ICC, quality 90 down to 70 under 2 MB, DPI | `render.ts`, `channels.ts` (`CHANNEL_RULES_VERSION`) |
| Shadows | Built. Preserve the photo's own shadow or synthesise a deterministic contact shadow; never on apparel; eases out before margins | `shadow.ts` |
| Enhancement and upscale | Built, live. Unsharp mask after any enlargement; x2 SwinIR on the GPU service past 1.5x, chosen by a fidelity gate (SSIM, LPIPS, CIEDE2000, text, texture, halo) | `enhance.ts`, `upscale.ts`, `apps/worker/src/catalog-enhancement-gate.ts` |
| Compliance checks | Built. Canvas, border band, margins, background, format, bytes | `compliance.ts` |
| Vision QA and auto-repair | Built, live. Two-model judge (role-aware, per-dimension thresholds, second opinion before any hold), triage to hard holds only, repair chosen from the failure per channel (shadow off, second matte, smaller fit, drop with note) | `qa/judge.ts`, `qa/triage.ts`, `auto-resolve.ts`, `apps/worker/src/catalog/auto-resolve.ts`, `targeted-repair.test.ts` (PR #92) |
| Output-quality evals | Built. Golden set pinned by sha256, geometry, cut-out, shadow, cut-edge, completeness, overwrite checks, matte bake-off writing `model_policy` | `evals/**`, `apps/worker/src/catalog-output-evals.ts` (spec 10) |
| Publish and links | Built, live. Overwrite in place at fixed public links, verify, re-check job, links workbook with per-image notes | `pipeline/publish.ts`, `pipeline/verify.ts`, `recheck/**`, `sheet.ts`, `ingest/links-sheet.ts` |
| Cost tracking | Built, live. Ledger row per matte, render, upscale, judge, publish and compute event, attributed per image and channel; Ops page | `packages/core/src/cost-events.ts`, `catalog/cost-report.ts`, `apps/web/app/catalog/ops/page.tsx` (on `origin/main`, PRs #90, #95) |
| Review UX | Built. Batch page, Needs attention cards with `use_as_is` or `remove`, product page, brand pages; no model names in UI | `apps/web/app/catalog/[id]/page.tsx`, `products/[brand]/[key]/page.tsx` |
| Re-crop, reframe, derived shots | Not built (SPEC non-goal "no cropping"); DD2 proposes rule-bound derivation | DD2 R1 |
| Generated shots (fill, flat lay to model, lifestyle) | Not built (SPEC non-goal "no generative edits or paid image APIs"); DD3 trialled 8 models, DD4 lifestyle | DD3, DD4 |
| Infographics with text | Not built; DD6 trialled sharp with Pango and HarfBuzz (Arabic shaping works) | DD6 |

Measured cost of what is built: USD 0.0036 (INR 0.30) per product on 4 channels in the 270-product load (session 5),
USD 0.0119 per style on a 5-photo product with the upscaler (session 6). At about 3,350 new styles a year that is about
USD 12 to 40 a year, plus the shared GPU service at min-instances 0. Throughput measured at about 110 published images
a minute (load 270).

Volume used below (assumption, from the load run): 4.66 source photos per style-colour, so about 15,600 new photos a
year and about 14,600 photos for one re-run of the 3,141 live style-colours; outputs are photos times channels ticked
(about 62,400 a year on 4 channels, 140,400 on all 9). Generation backlogs from DD9: B2 1,540, B3 605, B4 1,222 images
(3,367 in all), plus B5 infographics up to about 1,560 callouts.

## Vendor scan with prices

### Photoroom (Context7 `/websites/photoroom`, then vendor pages)

Products, one endpoint `POST/GET https://image-api.photoroom.com/v2/edit` (docs.photoroom.com/getting-started/api-reference-openapi):
- Basic plan (Remove Background API): background removal, crop or resize, colour backgrounds, despill, uncertainty
  score. No margins, padding or positioning on Basic.
- Plus plan (Image Editing API): everything in Basic plus AI Backgrounds, AI Shadows (new model `2026-04-15`, pose
  override flat lay or upright), AI Relighting, AI Expand, AI Uncrop, AI Text Removal, Ironing, Beautifier, Ghost
  Mannequin, Flat Lay, Virtual Model, Virtual Try-On, Product Staging, Edit with AI, padding, margin, `outputSize`,
  alignment, `ignorePaddingAndSnapOnCroppedSides` (snaps cut sides to the edge, like our flush rule), DPI 72 to 1200,
  templates (`templateId`), AI Upscale (preview, up to 4x; input limit 1 MP on `ai.fast`, 0.26 MP on `ai.slow`).
- Enterprise adds Image to Video, "Visual QA" (named on the pricing page, no public docs found), Enterprise Guarantee,
  volume pricing, CSM.
- Virtual Model: garment image plus up to several extra product images, custom model image, custom scene, 16 preset
  models, 23 scenes, 12 poses. Output 1K (1024 px) by default; 2K and 4K on Enterprise only
  (docs.photoroom.com/image-editing-api-plus-plan/virtual-model). No statement on cross-shot consistency or logo fidelity.
- Ghost Mannequin and Flat Lay: size presets named `*_HD` (pixel size not stated).
- No marketplace export presets in the API; Amazon rules appear only in marketing pages.

Prices (photoroom.com/api/pricing, read 2026-10-26): Basic USD 0.02 per image; Plus USD 0.10 per image; monthly plans
only, unused images do not roll over; Enterprise custom, annual commitment, 200,000-image minimum. Sandbox 1,000
watermarked Plus calls a month. DD3 and DD4 read the same USD 0.10 Plus price.

Limits: 60 images a minute default (raised from 500 to 60 for new users on 2025-05-19, changelog), more on Enterprise;
Image Editing input 30 MB and 5,000 px on the long side; Remove Background 50 MB and 6,000 px; JPEG export fixed at
quality 80 (we would request PNG and keep our encoder).

Data and terms: API images discarded after the call (FAQ and photoroom.com/platform/security). Training: the security
page says Enterprise contracts default to no training while self-serve API plans train unless opted out in settings;
the help article says API images are not used unless agreed (help.photoroom.com/en/articles/10067660). The two
statements differ, so a written position is needed. Infrastructure in the United States only, no regional residency.
SOC 2 Type 2 for the API (report April 2026). DPA for Enterprise only. No SLA or uptime figure published; one marketing
page claims 99%.

Photoroom at our volume:

| Way of using Photoroom | Calls a year | USD a year (new styles) | One-off re-run of live catalogue |
|---|---|---|---|
| Basic cut-out only, our render after | 15,600 | 312 | 293 |
| Plus once per photo (cut-out plus AI shadow or relight), our render after | 15,600 | 1,560 | 1,464 |
| Plus per channel output (Photoroom does the layout) | 62,400 (4 ch) to 140,400 (9 ch) | 6,240 to 14,040 | 5,860 to 13,180 |
| Virtual Model for the generation backlog at 1K, one attempt each | 3,367 | 337 once (674 with a 2-attempt ladder) | n/a |
| Ours today, all channels | n/a | about 12 to 40 | already paid |

### Alternatives

| Vendor | What fits us | Price (read 2026-10-26) | Limits and terms | Note |
|---|---|---|---|---|
| Claid.ai (claid.ai/api-pricing; not in Context7) | Background removal, upscale to 559 MP, shadow generation, generative resize (outpaint), AI fashion (on-model), AI backgrounds, light and colour, resize and crop | USD 59 per 1,000 credits (0.059 a credit). Background removal 2 credits (0.118), shadow 1 (0.059), AI fashion 2 (0.118), AI backgrounds 3 (0.177), upscale 1 to 11, resize free with another operation | 4 RPS / 120 RPM; "never use customer data for model training"; SOC 2 in progress; SLA on enterprise | Dearer than Photoroom for cut-outs; AI fashion one view per call |
| Pixelcut (pixelcut.ai/api) | Background removal, upscaler, generate background, try-on, outpaint | USD 0.01 a credit; background removal 5 credits (0.05); upscale, background, try-on, outpaint 10 credits (0.10) | Try-on outputs may not be used to create training data (DD3); rate limit not stated | Garment plus person swap only |
| Picsart (picsart.io/pricing) | Remove background, upscale, expand, filters, templates | Credit packs 1,000 for 7.50 to 20,000 for 100 (third-party snapshot of picsart.com/api-platform); per-call credits not readable without an account | Annual commitments for performance and support | Not fashion-specific |
| remove.bg (remove.bg/pricing) | Background removal only | Subscription 40 credits INR 599 a month; API pricing moved to Leonardo.ai | Standalone site closes 1 December 2026, moving into Canva; credits expire then | Do not adopt |
| Pebblely | Product scene backgrounds | Not published (DD4: secondary sources 0.05 to 0.20) | No API docs found | Still life only |
| FASHN (Context7 `/websites/fashn_ai`, fashn.ai/pricing) | Product-to-Model (flat lay or product to a person, face reference), Try-On Max, Model Swap, background remove (1 credit) | On demand USD 0.075 a credit; Tier II 249 a month (4,150 credits, top-up 0.060); Tier III 1,249 a month (25,594 credits, top-up 0.0488). Product-to-Model: fast 1/2/3, balanced 2/3/4, quality 3/4/5 credits at 1K/2K/4K, face reference +3; so 2K balanced 0.225 on demand | 50 runs a minute, 6 concurrent; outputs on CDN 3 days (60 min with base64); no training unless opted in; commercial licence | Best packaged match for flat lay to model; one view per call |
| Botika | Synthetic models | About 0.92 a photo derived from plan (DD3) | No public API; web and Shopify app | Does not fit a Cloud Run pipeline |
| Vue.ai, Lalaland, ZMO, Veesual, Huhu | On-model fashion | Not public (DD3; no prices found in this scan) | Enterprise or app plans | No GCC marketplace reference found (DD3) |
| OpenRouter image models (DD3, DD4) | Multi-reference editing for both generation modes and lifestyle | Nano Banana 2 USD 0.10 at 2K, 0.15 at 4K; Nano Banana Pro 0.134 and 0.24; about 0.20 per accepted image with the retry ladder | Existing key, spend caps and per-call `usage.cost`; Google 2K is 1792x2400 (cleared for Styli by our upscaler) | Trialled: 60 images, USD 5.39; prints re-drawn, so the gate holds them |

Public samples (brief item 5): not compared. Vendor galleries show hand-picked results without the source photo at full
size, so they cannot be measured with our checks; DD3's own 60 trial images remain the only like-for-like evidence. A
fair comparison is the owner question Q3 below (sandbox runs on our golden set, no paid call).

## Capability table

Price at our volume is per year for about 15,600 new photos (or the backlog where stated). "Control lost" is what we
give up if the vendor does it instead of our code.

| Capability | Built today | Vendor coverage | Quality risk with vendor | Price at our volume | Control we lose | Verdict |
|---|---|---|---|---|---|---|
| Cut-out | Yes: `matte.ts`, `matte-guard.ts`, `services/matting` | Photoroom Basic, Claid, Pixelcut, FASHN, Picsart | Low to medium; unknown on our hard cases (thin straps, soles, white on white); session 4 found our mattes clean and the damage came from the render | Ours tens of USD; Photoroom 312; Pixelcut 780; Claid 1,841 | Model choice per product type, guard rules, the eval bake-off | Keep. Optional Photoroom Basic as a third fallback model entered in the bake-off, also a hedge on the RMBG-2.0 non-commercial licence |
| Background | Yes: `render.ts`, flat colours per channel | All vendors (flat colour); AI backgrounds on Plus, Claid, Pixelcut | Low for flat colour; AI backgrounds change scenes, not allowed on main images | Flat colour costs us nothing | None worth paying for | Keep |
| Shadow | Yes: `shadow.ts` (preserve or deterministic synthesis) | Photoroom AI Shadows, Claid shadow | Medium: generative shadows can touch the product edge and margins; must pass our border-band and `pixels_copied` checks | Photoroom 1,560 (Plus per photo); Claid 920 | Deterministic, repeatable shadows; per-channel rules | Keep. Trial Photoroom AI Shadows only as an alternative shadow layer if the owner wants richer shadows |
| Per-channel resize and margins | Yes: `render.ts`, `channels.ts`, 9 channels | Photoroom Plus (`outputSize`, padding, margin, alignment); no channel presets | Medium: no Styli guides, no white-first rule, JPEG fixed at 80, no 2 MB loop | Photoroom 6,240 to 14,040 | Channel table, versioned rules, render key, overwrite in place | Keep |
| Upscale | Yes: `upscale.ts`, SwinIR x2 via fidelity gate, about USD 0.0003 a photo | Photoroom AI Upscale (preview, 1 MP input), Claid (to 559 MP), Pixelcut | Medium to high: generative upscalers can redraw logos and texture | Claid 920 to 10,000 depending on size; ours a few USD | Fidelity gate and determinism | Keep |
| Re-crop and reframe | No (non-goal; DD2 R1 proposes rule-bound crops) | Photoroom positioning, Uncrop and Expand (generative), Claid generative resize | High for Expand and Uncrop (new pixels at the edges) | Plus 0.10 a call | Head and logo safe rules, Styli floor | Build (deterministic crops in our render, DD2 R1); no vendor |
| Fill missing shots (B2) | No | Photoroom Virtual Model (1K), FASHN Model Swap or Product-to-Model, OpenRouter editors | High: prints re-drawn, labels move (DD3) | 1,540 images: about 308 at 0.20 accepted (OpenRouter); Photoroom 1K only | Engine internals only, if our gate decides | Hybrid: buy the engine, keep the planner and the gate |
| AI on-model | No | Photoroom Virtual Model, FASHN, Claid AI fashion, Pixelcut try-on, Botika | High, same as above; Photoroom 2K and 4K only on Enterprise | 0.10 to 0.225 an attempt | Same | Hybrid (same engine slot) |
| Flat lay to model (B3) | No | FASHN Product-to-Model (closest), Photoroom Virtual Model, Claid | High: identity, prints | 605 images: about 121 (OpenRouter) to 136 (FASHN 2K balanced, one attempt) | Same | Hybrid; FASHN is the second engine to trial |
| Lifestyle scenes (B4) | No | Photoroom AI Backgrounds or Virtual Model scenes, Claid AI backgrounds, Pebblely, OpenRouter | High for worn shots; composites keep pixels (DD4) | 1,222 images: about 244 (DD4) | Scene rules, kids rule, slot rules | Hybrid: OpenRouter engine plus our own composite fallback (DD4) |
| Infographics with text | No (DD6 trial on sharp) | Photoroom text layers and templates; Canva-type template APIs | High if a model paints text (DD6: invented claims); templates lack Arabic checks and our facts | Ours about 0.011 a product (DD6) | Facts-only text, Arabic shaping checks, channel slots | Build (DD6) |
| QA and fidelity evals | Yes: `qa/judge.ts`, `evals/**`; generation gate proposed (DD2) | Photoroom "Visual QA" (Enterprise, undocumented); none measure against our golden set | Vendor checking its own output is not independent | Ours about 0.0003 a check | Independence of the gate | Keep and extend (DD2 gate). Never buy the judge from the engine vendor |
| Channel rules and compliance | Yes: `channels.ts`, `compliance.ts` | None for GCC channels | n/a | n/a | n/a | Keep |
| Publish and links sheet | Yes: `pipeline/publish.ts`, `sheet.ts`, `recheck/**` | None (vendors return files or CDN links that expire, FASHN 3 days) | n/a | n/a | Fixed public links, overwrite in place | Keep |
| Cost tracking | Yes: `cost-events.ts`, `cost-report.ts`, Ops page | Vendor dashboards per account only | n/a | n/a | Per image and channel cost across engines | Keep; add a ledger engine row per vendor call |
| Review UX | Yes: batch, attention cards, product page | Photoroom web app batch (250 images), Claid web; not tied to our holds | n/a | n/a | Our hold reasons, decisions, operator copy without model names | Keep |

## Recommendation and integration shape

Answer to the owner's question: no, a ready solution like Photoroom is not the better choice for the platform at our
scale. Counting what is built as sunk, Photoroom would replace working parts that cost tens of dollars a year with a
service costing about USD 1,600 (cut-out plus shadow) to 14,000 (full per-channel layout) a year, while giving up the
channel rules, the deterministic pixel guarantee and the evals that decide quality today. Its strengths are real but
sit in the gaps where it is still not the best fit: Virtual Model is 1K unless we sign an Enterprise contract sized at
200,000 images a year (we need about 3,400 generated images once and a few hundred a year after), and no vendor makes
the five-role set with one model or knows Styli guides, Noon margins or Arabic. Yes, buy, but only the generation engine.

The shape (vendor as one engine behind our own rules, gate and publish):

```
brand photos -> ingest -> our planner (roles needed per channel, DD1/DD2)
   |-- existing photo covers the role --> our matte -> our render (channels.ts) --> compliance -> judge -> repair
   |-- role missing or lifestyle/infographic wanted:
         engine slot (one interface, one ledger engine per vendor):
            1. OpenRouter image API, Nano Banana 2 (default, DD3), Pro as the escalation step
            2. FASHN Product-to-Model (second engine to trial for flat lay to model)
            3. Photoroom Virtual Model (third, only if a trial on our gate beats 1 and 2)
            4. our own composite still life (DD4 fallback, pixels unchanged)
         --> our fidelity gate (DD2 G1 to G6, plus DD4 scene checks) --> our render for each channel
infographics --> our compositor on sharp (DD6), facts from our fact sheet
all outputs --> review (generated outputs reviewed until exit numbers) --> publish to fixed links --> links sheet
every call --> catalog_cost_events (engine, USD, image, channel)
```

Rules for the engine slot:
- The engine only returns pixels. Every placement, size, margin, background and encoding is ours, so changing vendor
  never changes channel compliance.
- The gate decides, per brand and category, which engine wins, exactly as the matte bake-off writes `model_policy`
  today. Engine ids live in policy and logs only; never in operator copy.
- No engine is allowed to touch a photo that already passes: regeneration only where a role is missing or the owner
  asked for lifestyle.
- Per-call cost and the engine id go to the ledger; the existing per-batch cap applies to every engine.
- Optional: enter Photoroom Basic (USD 0.02) in the next matte bake-off as one more cut-out candidate and as a licence
  hedge for RMBG-2.0. It is chosen only if it wins on the golden set.

## Risks

- Data leaving GCP: Photoroom runs in the US only and its self-serve training statement conflicts with its help page;
  FASHN keeps outputs on its CDN 3 days by default (60 minutes with base64); OpenRouter routes to Google. Brand photos
  need a written position per vendor before a live run (DD3 open item for Gemini retention too).
- Fidelity: every generative step (AI shadow, upscale, expand, virtual model) can redraw prints, logos and labels; DD3
  saw prints re-drawn on 7 of 7. The gate, not the vendor, is the control; expect many holds on printed garments.
- Resolution: 1K outputs (Photoroom Virtual Model self-serve, FASHN 1K) need more than 2x enlargement for Styli
  2342x3123 and Centrepoint 3000x3000; our upscaler covers x2 only, so 2K engines are the floor for those channels.
- Vendor change: remove.bg's closure (1 December 2026) shows how fast a supplier can move; Photoroom cut the default
  rate limit from 500 to 60 a minute in 2025. The engine slot must allow a swap without touching channel code.
- Rate limits: Photoroom 60 a minute, Claid 120 RPM, FASHN 50 a minute and 6 concurrent; fine for generation volumes,
  too low to put a vendor on the main per-channel path at load-test speeds (110 images a minute).
- SPEC conflict: SPEC non-goals forbid generative edits and paid image APIs; any engine needs the DD2 and DD4 SPEC
  amendments approved first.
- Price drift: all vendor prices are list prices read on one day; no volume quotes were requested.
- Brand rights: USPA carries most of the revenue (DD9); whether its rights allow generated images decides B4 and B5
  value more than any vendor choice.

## Owner questions

1. Do you accept the verdict "keep the platform, buy only the generation engine", with Photoroom as a candidate engine
   rather than the platform?
2. May brand photos be sent to US-hosted vendors (Photoroom, FASHN) and to Google through OpenRouter, and do you want a
   written no-training position from each before any live run?
3. May we run Photoroom's free sandbox (1,000 watermarked calls a month, no card) on our golden set to compare cut-out
   and Virtual Model quality, and FASHN's minimum on-demand pack (USD 7.50) for Product-to-Model, as part of the
   generation trial? This would be the first account sign-ups, so it needs your yes.
4. Should Photoroom Basic enter the next matte bake-off as a licence hedge for the non-commercial cut-out model, at
   about USD 300 a year if it wins?
5. Is a vendor SLA required for anything we buy, or is our own fallback (composite still life, hold with a reason)
   enough? Only Enterprise tiers offer one.

Status: done
