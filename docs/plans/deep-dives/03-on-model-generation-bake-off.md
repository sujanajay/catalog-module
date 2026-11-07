# DD3: On-model generation bake-off (frontier image models, VTO vendors, ready-made plug-ins)

Date: 2026-10-22. Deep dive DD3 of the Catalog Connect GCC program (B2 generative half and B3).
Program: docs/plans/2026-10-21-catalog-connect-gcc-intent-map.md (sections 2 to 5, 7). Builds on
docs/plans/deep-dives/00-softline-taxonomy.md (handling matrix) and
docs/plans/deep-dives/02-derived-shots-fidelity-gate.md (checks G1 to G6).
Investigation only. Nothing here is built. Trial scripts and images live in the session scratchpad
`C:\Users\SUJANA~1\AppData\Local\Temp\claude\c--Users-Sujan-Ajay-Desktop-catalog-module\8948687b-c329-4062-a372-8e34a714b089\scratchpad\dd3\`
(`inputs/`, `outputs/`, `meta/` with `runs.jsonl` per request, `scripts/`). Model ids appear here as
technical facts only; none may reach UI copy.

## Summary

1. 61 image models are reachable through OpenRouter's Image API today (12 of them also through chat completions). The useful multi-reference editors cost 0.014 to 0.24 USD per image; the per-image price, not the model, is the small number in this program.
2. Trials: 60 billed images (8 models, 12 golden products from Vero Moda, French Connection and Penti; U.S. Polo has no apparel in the warehouse). Spend 5.39 USD by per-response cost, 5.25 USD by the account counter. Cap 50, stop line 40: far under.
3. Both conditioning modes work on the Google models and GPT Image 2: mode A (existing on-model shots to the missing role) and mode B (flat lay plus a brand model from another product, chained from a full-length anchor) gave the same person, the right garment and a clean studio background on every attempt.
4. What fails, and would be held by DD2's gate: prints are re-drawn by every model (cat graphic changed on 7 of 7, text kept on 7 of 7); a hem label was moved to the back by 3 models; GPT Image 2 cuts the top of the head on 4 of 12 close framings; Seedream ignores crop bands and once changed the floor; FLUX 3 klein changed the model's hair colour.
5. Resolution: Google 2K is 1792x2400 (below the Styli floor 2342x3123, cleared by the existing x2 upscaler); Google 4K is 3584x4800 native at 0.152 USD (Nano Banana 2) or 0.244 USD (Nano Banana Pro). Fixed seeds do not reproduce an image.
6. VTO SaaS (FASHN, Photoroom, Vertex VTO, BFL VTO) solves only the garment swap at 0.06 to 0.23 USD, mostly at 1 MP, and no vendor produces the five-role set with one model. Open weights that fit one L4 and allow commercial use (FASHN VTON 1.5 at 576x864, FLUX.2 klein 4B, Qwen-Image-Edit 2511 in fp8) are below the closed models on identity and detail in public comparisons and were not trialled.
7. Recommendation: buy Nano Banana 2 through OpenRouter's Image API as the single generator for both modes (Nano Banana Pro as the escalation step of the regeneration ladder), one request shape for every vendor, roles named by ordinal in the prompt, the planner chains every role from an approved full-length anchor. DD9 should use 0.10 USD per generated image at 2K, 0.15 at 4K, and 0.20 per accepted image once the ladder is counted.
8. Unproven: exit numbers on 300 labelled shots (DD2), prints and logos through the gate (expect many `texture_changed` holds), bottoms and dresses roles (DD0 open items), swimwear and lingerie (not probed), Nano Banana 2.1 (provider quota error on all 9 attempts).

## Candidates

Prices are list prices read on 2026-10-22 from the OpenRouter endpoints API (`GET /api/v1/images/models/{id}/endpoints`, saved in `meta/images_endpoints.json`) or from the vendor page named in the row. "Observed" is the `usage.cost` OpenRouter returned on a trial request at 3:4 with 2 to 3 reference images. Token-priced models are converted with the image token counts OpenRouter reported.

### Through OpenRouter (image in, image out)

| Model (OpenRouter id) | Refs max | Output tiers | Price per image (USD) | Observed | Data retention |
|---|---|---|---|---|---|
| google/gemini-3.1-flash-image (Nano Banana 2) | 14 | 512, 1K, 2K, 4K; 2K = 1792x2400, 4K = 3584x4800 at 3:4 | 0.00006 per output token: 1K 0.067, 2K 0.101, 4K 0.151 | 0.102 (2K), 0.152 (4K) | Google AI Studio or Vertex endpoint; paid tier not used for training, abuse logging "for a limited period" (ai.google.dev/gemini-api/terms) |
| google/gemini-3-pro-image (Nano Banana Pro) | 14 | 1K, 2K, 4K | 0.00012 per token: 1K and 2K 0.134, 4K 0.240 | 0.137 (2K), 0.244 (4K) | as above |
| google/gemini-3.1-flash-lite-image (Nano Banana 2 Lite) | 14 | 1K only (896x1200) | 0.00003 per token: 0.034 | 0.034 | as above |
| google/gemini-nano-banana-2.1 | 14 | 1K, 2K, 4K | 0.00003 per token: 1K 0.034, 2K 0.050, 4K 0.076 | not obtained: HTTP 429 "exceeded your current quota" from Google AI Studio on 9 of 9 requests, unbilled | as above |
| google/gemini-2.5-flash-image | 3 | 1024 px | 0.039 | not run | shutdown announced 2026-10-02 on the Gemini pricing page |
| openai/gpt-image-2 | 16 | any WxH, quality low to max | 0.00003 per output token plus 0.000008 per input image token: 1536x2048 medium 0.093 to 0.105 | 0.093 to 0.105 | OpenAI API: not used for training by default, abuse logs up to 30 days, ZDR by approval, UAE regional processing on approval (developers.openai.com/api/docs/guides/your-data); moderated endpoint |
| openai/gpt-image-1, gpt-image-1-mini | 16 | 1024x1536 max | 0.00004 and 0.000008 per output token (vendor table: 1024x1536 medium 0.063 and 0.015) | not run | as above |
| openai/gpt-5.4-image-2, gpt-5-image, gpt-5-image-mini | 16 | chat route, same image engines | 0.00003, 0.00004, 0.000008 per output token plus text tokens | not run | as above |
| bytedance-seed/seedream-4.5 | 14 | 1K, 2K, 4K; 2K = 1664x2218 | 0.040 flat | 0.040 | ByteDance "Seed" endpoint; retention not published |
| bytedance-seed/seedream-5-0-pro, 5-0-lite, 5-0-flash | 14 | 1K to 4K | 0.045 (0.090 high resolution) plus 0.003 per input image; 0.035; 0.018 | not run | as above |
| qwen/qwen-image-3 | 3 | 1K (768x1024), 2K | 0.030 plus 0.003 per input image | 0.036 | Alibaba Cloud International (Singapore); retention not published |
| qwen/qwen-image-3-pro; qwen-image-2.1-pro, 2.1-turbo | 3; 4 | 1K, 2K | 0.040 (1K) 0.075 (2K); 0.046; 0.0184 | not run | as above |
| black-forest-labs/flux.2-pro | 8 | 1024x1376 at 3:4 | 0.03 per megapixel (billed 0.075 with 2 refs) | 0.075 | BFL; API outputs carry commercial rights (help.bfl.ai) |
| black-forest-labs/flux-3-image-klein | 10 | 768 to 4K; 2K = 1776x2368 | 0.008, 0.009, 0.011, 0.014, 0.036 | 0.014 | as above |
| black-forest-labs/flux-3-image | 10 | 768 to 4K | 0.041, 0.048, 0.070, 0.100, 0.607 (4K) | not run | as above |
| black-forest-labs/flux.2-flex, flux.2-max, flux.2-klein-4b | 8, 8, 4 | per megapixel | 0.06, 0.07, 0.014 per MP | not run | as above |
| tencent/hy-image-v3.5-preview | 20 | 1K to 4K | 0.0000016 per token | not run | Tencent Cloud; licence excludes EU and UK, not GCC |
| x-ai/grok-imagine-image-2.0 | 3 | 1K, 2K | 0.04 to 0.08 plus 0.01 per input image | not run | xAI |
| microsoft/mai-image-2.6, 2.6-flash, 2.5-pro | 5, 5, 1 | not stated | 0.000038, 0.000019, 0.000108 per output token | not run | Azure |
| sourceful/riverflow-v2.5-pro, v2-pro | 10 | 1K to 4K | 0.13 to 0.17; 0.15 to 0.33 plus 0.20 per reference | not run | not garment aware |
| krea/k3-edit, krea-2-* | 8; 1 | 1K, 2K | no price published on the endpoint | not run | |
| recraft/* (17 ids) | 0 to 10 style refs | not stated | 0.007 to 0.30 | not run | style and vector models, no garment plus person mode |

Request shape (all of the above): `POST https://openrouter.ai/api/v1/images` with `model`, `prompt`, `aspect_ratio` (`3:4`), `resolution` (`1K`, `2K`, `4K`) or explicit `size` (`1536x2048`), `quality` (OpenAI only), `seed`, `n`, `session_id`, `user`, `input_references[]` as `{type:"image_url", image_url:{url:"data:image/jpeg;base64,..."}}` (max 16, provider clamps lower). Response: `data[0].b64_json`, `data[0].media_type`, `usage.cost` in USD, `usage.completion_tokens_details.image_tokens`. The Google models also answer on `POST /chat/completions` with `modalities:["image","text"]` and `image_config:{aspect_ratio}` (catalog-service's `generate_gemini_image` shape), returning `choices[0].message.images[0].image_url.url`.

### Closed image APIs direct from the vendor (not trialled; list prices)

| Vendor, model | Conditioning | Max output | Price per image (USD) | Terms and retention |
|---|---|---|---|---|
| OpenAI gpt-image-2 direct | multi-image edits | up to 8.3 MP, above 2560x1440 "experimental" | 1024x1536: low 0.005, medium 0.041, high 0.165; token rates 8 per M image in, 30 per M image out; Batch halves | as the OpenRouter row |
| Google Gemini API, Nano Banana 2 / Pro / 2.1 / Lite | up to 14 refs (objects 10, characters 4) | 4K | 2: 0.067 (1K) 0.101 (2K) 0.151 (4K); Pro: 0.134 (1K, 2K) 0.240 (4K); 2.1: 0.0336, 0.0504, 0.113; Lite 0.0336 (ai.google.dev/gemini-api/docs/pricing) | Gemini API paid terms |
| Google Vertex Virtual Try-On (virtual-try-on-001) | person image plus 1 or more product images, up to 4 samples | same size as the person image | 0.06 per output image (from a search extract of the Vertex pricing page; page did not load, re-check in console) | Vertex: no training on customer data; ZDR available |
| Black Forest Labs FLUX VTO v2 | person plus one garment plus prompt | follows the person image, up to 4 MP | v1 "from 0.0475"; v2 not priced on the page | commercial rights on API outputs; EU and US endpoints only |
| BFL FLUX 3 Image Klein direct | multi-reference | 4K | 0.008 to 0.036 (docs.bfl.ai/quick_start/pricing) | as above |
| ByteDance Seedream direct (BytePlus ModelArk) | multi-reference | 2K | official page empty; fal lists 4.5 at 0.04 and 5.0 Pro at 0.135 | not verified |
| Alibaba Qwen-Image 3.0 pro (Model Studio, Singapore) | image to image | 2048x2048 | billing page 404 | not verified |
| Ideogram 4.5 | up to 4 reference images on Precise edit | input size | 1 cent per credit, per-model table not readable | consumer FAQ allows commercial use |
| Recraft V4 | 1 to 10 style refs | not stated | from 0.035 | style model |
| Stability AI | structure, sketch, style control | 4 MP upscalers | 0.03 to 0.08 | no garment plus person mode |
| Runway (aggregator) | gpt_image_2, gemini image, nano_banana_2.1 | 4K | 0.01 per credit: nano_banana_2.1 0.04/0.06/0.12, gemini pro 0.20 (1K, 2K) 0.40 (4K) | alternative route to the same models |
| Adobe Firefly Services, Image 5 | composite, custom models | native 4 MP, upscale 2x to 6x | enterprise contract, no public price | IP indemnification for eligible enterprise customers |

### VTO and fashion-model SaaS with an API (not trialled; list prices)

| Vendor | Conditioning | Output | Price per image (USD) | Own brand model allowed | Notes |
|---|---|---|---|---|---|
| FASHN Try-On Max (tryon-max) | product image plus model image plus prompt, 1 to 4 outputs, seed | 1K, 2K, 4K | 0.075 per credit on demand; balanced 2K = 3 credits = 0.225; 0.146 at the 1,249 per month tier | yes (model_image) | commercial licence; CDN outputs deleted after 3 days; no training unless opted in; no multi-view, consistency by seed only |
| FASHN Try-On v1.6 | model plus garment, category, flat-lay or on-model flag | 864x1296 | 0.075 | yes | also on fal at 0.075 |
| FASHN Product-to-Model, Model-Swap, Model-Create | flat lay plus optional face reference (+3 credits) | 1K to 4K | credit table plus 3 | face reference | closest packaged match to mode B, one view at a time |
| Photoroom Image Editing API (Plus) | virtualModel with a custom model image, scene, pose, up to 4 extra product images, ghost mannequin | about 1K, 2K, 4K by quality | 0.10 | yes (imageUrl) | Shopify app exists; terms not on page |
| Pixelcut Try-On API | garment plus person | not stated | 0.10 (10 credits) | yes | may not be used to create training data |
| Kling Kolors VTO (via fal) | person plus garment | 768x1024 | 0.07 | yes | marked "no longer supported" on fal |
| Leffa (via fal) | person plus garment | 768x1024 | 0.10 | yes | MIT weights, see open table |
| Botika | synthetic models only | 2K, 4K | about 0.92 per photo derived from plan | no | web and Shopify app, no public API |
| Vue.ai, Veesual, Lalaland (Browzwear), ZMO, Huhu, Caspa, Flair, Claid | enterprise or app plans | varies | not public or not image-priced | varies | no GCC marketplace reference found for any vendor |

### Open weights that fit one L4 (24 GB) and allow commercial use

| Model | Licence | VRAM | Output | Conditioning | Note |
|---|---|---|---|---|---|
| FASHN VTON v1.5 | Apache-2.0 (parser separate) | about 8 GB bf16 | 576x864 fixed | person plus garment (flat lay or on-model), mask free | the only permissive purpose-built VTO that fits; needs a 4x upscale to reach Styli |
| Leffa | MIT (training data has its own terms) | not stated | not stated | person plus garment plus pose | base checkpoint undocumented |
| FLUX.2 klein 4B | Apache-2.0 | about 13 GB | 1 MP class | up to 4 references, no mask | general editor; community try-on workflows report weak results when arms or hair cover the garment |
| Qwen-Image-Edit-2511 | Apache-2.0 | fp8 or GGUF only on 24 GB | 1 MP class | 1 to 3 inputs, no mask | try-on via LoRA; heavier than dedicated VTO |
| HiDream-O1-Image | MIT | 17 to 20 GB bf16 | up to 2048x2048 | 2 or more references | no fashion numbers published |
| OmniGen2 | Apache-2.0 | about 17 GB | 1024x1024 | multi-image in-context editing | hosted on fal at 0.15 per MP |
| Not usable commercially: IDM-VTON, CatVTON, OOTDiffusion, FitDiT, StableVITON, MV-VTON, PromptDresser (CC BY-NC-SA 4.0); RefTon, OmniTry, DreamFit-FLUX, Any2AnyTryon (FLUX.1 dev non-commercial base); FLUX.2 klein 9B and FLUX.2 dev (FLUX non-commercial); Qwen-Image-2.1 (research licence); HunyuanImage 3.0 (80B, does not fit) | | | | | |

### Ready-made plug-ins and MCP servers

- fal.ai official MCP (`mcp.fal.ai`): search, schema, pricing and run for every fal model (FASHN, Leffa, Kling VTO, FLUX VTO at 0.0375 first MP). Pay per run. A route to VTO vendors without a vendor SDK.
- Replicate and ComfyUI: community MCP servers only (deepfates/mcp-replicate, miller-joe/comfyui-mcp and others); ComfyUI nodes exist for every open VTO model and inherit its licence.
- OpenTryOn (tryonlabs) wraps Leffa, CatVTON and the FLUX, Vertex, FASHN and Kling VTO APIs in one Python SDK, but the repo is CC BY-NC 4.0.
- No official MCP server exists for OpenAI Images, Gemini image models, FASHN or Photoroom; no OpenRouter image MCP was found. Shopify apps (Botika, Huhu, Tryonora on FASHN, Photoroom) do not fit a Cloud Run pipeline.
- Context7 was not available in this session; every API fact above comes from the vendor's own documentation page named in the row or from the OpenRouter API responses saved in `meta/`.

## Trials

### Golden set

12 options from `gcc_channel_reports.product_list_trendyol_3p_uae` (latest file_date per option, 3 or more images, modest categories), 60 source images, all 1200x1800 as Trendyol serves them, in `inputs/` (manifest `meta/golden_manifest.json`, contact sheets `meta/sheet_*.jpg`):
Vero Moda vm01 jeans, vm02 lace tee, vm03 chiffon midi dress, vm04 long-sleeve scoop top, vm05 lace balloon pant; French Connection fc01 tie shirt, fc02 rib midi dress, fc03 men's seersucker tee, fc04 cardigan; Penti pt01 printed pyjama top, pt02 camisole and shorts set, pt03 pyjama set, plus pt04 (Trendyol category "Swimsuits", in fact a beach cover-up) for the refusal probe. U.S. Polo Assn. in the warehouse is footwear only (DD2), so no USPA apparel is in the set.

### Tasks

Mode A (existing on-model shots, make the missing role):
A1 pt02 role 2 full length from front mid-thigh, head-and-shoulders and back (no full length exists); A2 fc03 role 4 back at hips from the front on-model shot plus the flat back; A3 pt01 role 5 head and shoulders from a three-quarter crop and a chest crop (print with text, the G2 case); A4 vm03 role 3 fabric close-up without the model from a skirt detail and the flat lay.
Mode B (flat lay plus the brand's model from another product, same model across the set, chained):
B1 vm04 flat lay plus vm02's model: role 2 first (anchor), then roles 1, 4, 5 with the anchor as a third reference; B2 fc03 flat front and back plus fc03's model: role 2, then roles 4 and 5. Role 3 in mode B is a crop of the flat lay (DD2 R1), so it was not generated.
Extras: 4K on B1 anchor (Nano Banana 2 and Pro); fixed seed twice on A3 (Nano Banana 2); refusal probe P1 (pt04 back view) on GPT Image 2 and Nano Banana 2. Second tier (Qwen Image 3, FLUX.2 pro, FLUX 3 klein): A2, A3, B1 anchor only. One prompt template for all models (`scripts/genjobs.js`), references named by ordinal in the prompt, every request through `POST /api/v1/images` (`scripts/run.js`), one image per request.

Judging: by eye on `meta/judge_*.jpg`, `meta/set_*.jpg`, `meta/crop_*.jpg` against DD2's six checks, plus CIEDE2000 between the mean garment colour of a fixed patch in the reference and in the output (`scripts/colour_check.py`, a crude patch measure, not the garment-mask measure DD2 specifies).

### Results per model

| Model | Mode A (A1 to A4) | Mode B (B1 4 shots, B2 3 shots) | Failures and where |
|---|---|---|---|
| Nano Banana 2 (2K, 15 images) | 4 of 4 usable framings; same person, garment and lighting; sheer chiffon rendered in A4 | 7 of 7 same person across the set, back view plausible, crop bands respected | print re-drawn (`nb2_A3_pt01_R5.png`: cat face and blanket pattern differ, text intact); hem label moved to the back (`nb2_B2_fc03_R4.png`, back flat lay has none); grey rib rendered darker (dE2000 3.9 on A3); fixed seed 12345 twice gives different pixels (`nb2_seedA/B_A3_pt01_R5.png`, mean abs diff 17.5 of 255) |
| Nano Banana Pro (2K, 12 images) | 4 of 4 usable; most faithful seersucker texture | 7 of 7 same person; sharpest 4K face (`nbpro_4K_B1_vm04_R2.jpg`) | print re-drawn with added rosy cheeks (`nbpro_A3_pt01_R5.png`); label moved to the back (`nbpro_B2_fc03_R4.png`); top of head touches or crosses the frame on role 5 (`nbpro_B2_fc03_R5.png`); grey rendered darker (dE2000 5.4 on A3, above DD2's 5.0 per-colour bar) |
| GPT Image 2 (1536x2048 medium, 12 images) | 4 of 4 garment-faithful; best colour (dE2000 0.5 to 1.7 on three tasks) | 7 of 7 same person | top of head cut on close framings (`gpt2_B1_vm04_R5.png`, `gpt2_B2_fc03_R5.png`, `gpt2_B1_vm04_R1.png` slight, `gpt2_P1_pt04_R4.png`): Styli's one hard rejection; invented a back drawstring on the cover-up (`gpt2_P1_pt04_R4.png`); print re-drawn (`gpt2_A3_pt01_R5.png`); output below 2K |
| Seedream 4.5 (2K, 11 images) | 4 produced; A1 added a beige floor (two-tone background, `seed45_A1_pt02_R2.jpg`); A3 face drifts | person roughly kept | ignores crop bands: role 4 delivered full length twice (`seed45_B1_vm04_R4.jpg`, `seed45_B2_fc03_R4.jpg`); role 5 head cut (`seed45_B2_fc03_R5.jpg`); hair and pose change on role 1 (`seed45_B1_vm04_R1.jpg`); print re-drawn |
| Qwen Image 3 (1K, 3 images) | A2 and A3 plausible but 768x1024 | B1 anchor plausible, model looks away | resolution far below the floor; max 3 references rules out the chained shape (flat lay, model, anchor, plus a back flat lay) |
| FLUX.2 pro (3 images) | A2 head cut at the top and a label added on the back (`flux2pro_A2_fc03_R4.jpg`); A3 head cut | B1 anchor: person less like the reference | 1024x1376 output; head cuts on 2 of 3 |
| FLUX 3 klein (2K, 3 images) | A2 back rendered as a plain performance tee (yoke seam and seersucker lost); A3 acceptable | B1: model's hair changed from blonde to brunette (`flux3k_B1_vm04_R2.jpg`) | identity failure at 0.014 per image |
| Nano Banana 2 Lite (1K, 1 image) | A3 smoke test good at 896x1200 (`smoke_lite_pt01_r5.jpg`) | not run | 1K only |
| Nano Banana 2.1 | 9 requests, all HTTP 429 quota errors from the single Google AI Studio endpoint, unbilled | | untested, re-check later |

Findings that hold across models:
- Garment identity (G1): same garment on every output from the four main models; silhouettes, necklines, sleeve lengths and the white lace trim on pt02 survive. Fine structure does not: every model re-draws a printed graphic from memory of the reference, close enough to fool a glance and not close enough for DD2's LPIPS patch bar. Logos and labels are at risk of being moved, not misspelled.
- Text (G2): "NOPE." and "NOT TODAY." read correctly on 7 of 7 outputs; letter spacing changes. OCR string equality would pass; the planted-defect test for moved logos must be in the gate's training set.
- Colour (G3): patch dE2000 0.5 to 2.7 on the sage tee across models; 1.7 to 5.4 on the light grey rib (lighting and shading dominate the patch; a garment-mask measure is needed before any bar is read from these numbers).
- Model consistency (G5): chaining from an approved full-length anchor kept the same person on 7 of 7 shots for Nano Banana 2, Nano Banana Pro and GPT Image 2 without a face embedding (DD2 non-goal respected). The first shot of a set is the one to review hardest; the rest inherit it.
- Crop geometry (G6): the Google models follow the role bands; GPT Image 2 and Seedream do not reliably, and head cuts appear on role 5 and role 1. The gate's head-box check is not optional.
- Modesty: no model refused or altered coverage on the camisole and shorts set or the cover-up; the "Swimsuits" item turned out to be a cover-up, so true swimwear and lingerie (DD0 open items 3 and 4) remain unprobed. GPT Image 2 is the only moderated endpoint in the set.
- Resolution: 2K Google output (1792x2400) needs the existing x2 upscaler for Styli; 4K (3584x4800) clears the floor natively at 1.5x (Nano Banana 2) or 1.8x (Pro) the 2K price. GPT Image 2 at 1536x2048 and every second-tier model need the upscaler.
- Determinism: a fixed seed does not reproduce an output on Nano Banana 2; `gen_key` must record the output sha, not the seed, as the identity of a generated image.
- Latency: 15 to 46 s per image across models (`runs.jsonl` `ms`).

## Spend

- Per-response `usage.cost` summed over `meta/runs.jsonl`: 60 billed images, 5.3888 USD (Nano Banana 2 1.5851, Nano Banana Pro 1.7608, GPT Image 2 1.1937, Seedream 4.5 0.4400, FLUX.2 pro 0.2250, Qwen Image 3 0.1080, FLUX 3 klein 0.0420, Nano Banana 2 Lite 0.0342). 9 failed requests (all Nano Banana 2.1 quota errors) were not billed.
- Account counters (`GET /api/v1/credits` and `GET /api/v1/key`, read before and after): total_usage 2121.5286 to 2126.7817 and key usage 32.7496 to 38.0027, both a delta of 5.2531 USD. The 0.1357 USD gap to the per-response sum is unexplained by the API; the higher figure is reported as the spend.
- Spend: 5.39 USD of the 50 USD cap. No other paid service was used.

## Options

Cost is per generated image at 3:4; fit is against the five-role set, the same model across shots, DD2's gate and the Cloud Run pipeline. No timelines by owner rule.

| Option | Cost per image (USD) | Fit | Verdict |
|---|---|---|---|
| O1 Buy a frontier editor through OpenRouter (Nano Banana 2, Pro as escalation; GPT Image 2 as a second opinion) | 0.10 (2K), 0.15 (4K); Pro 0.134 and 0.24; GPT Image 2 about 0.10 | Both modes, 14 references, one request shape, `usage.cost` per image, provider fallbacks, the key and spend caps already exist in the module; outputs need the upscaler at 2K; prints re-drawn, labels can move | Recommended |
| O2 Buy a VTO SaaS (FASHN Try-On Max, Photoroom, Vertex VTO, BFL VTO) | 0.06 to 0.225 | Garment swap only, one view per call, no five-role set, no cross-shot model consistency beyond a seed, mostly 1 MP; a second vendor account, key and data-processing review | Not for V3; FASHN Product-to-Model is the one to re-test if O1 fails the gate on garment identity |
| O3 Self-host open weights on the L4 (FASHN VTON 1.5; FLUX.2 klein 4B or Qwen-Image-Edit 2511 for views) | GPU time only, no vendor fee | VTO at 576x864 needs a 4x upscale; general editors are weaker on identity in public comparisons and in the FLUX 3 klein trial; a second GPU service to operate; commercial licences are clean only for the models listed | Not now; revisit if volume makes 0.10 per image matter (DD9) |
| O4 Build a generator (fine-tune or LoRA on brand data) | GPU training plus serving | Needs brand data rights and a labelled set that does not exist yet; against the owner decision to buy the generator | No |
| O5 Direct vendor APIs instead of OpenRouter (Gemini API, OpenAI Images) | same or lower list price (Gemini Batch halves it) | Two more keys and billing accounts; loses the single request shape and the per-request cost field; gains regional processing options (OpenAI UAE on approval) | Keep as a later switch; the planner's request shape should not depend on it |

Build in every option: the planner (roles, references, prompt template, chaining), the gate (DD2), review and publish. Buy only the generator.

## Recommendation

1. Generator: Nano Banana 2 (`google/gemini-3.1-flash-image`) through OpenRouter's Image API for both modes, at 2K with the existing x2 upscaler for Styli, 4K where a brand's channel set makes the extra 0.05 USD worth it. Regeneration ladder (DD2 R2): attempt 1 Nano Banana 2 new seed, attempt 2 Nano Banana 2 with stronger reference wording, attempt 3 Nano Banana Pro; then the hold stands. GPT Image 2 is not the default because of head cuts on close framings; Seedream, Qwen, FLUX are out for crop, identity or resolution reasons.
2. Conditioning, mode A: references are the brand's own shots of the same option, every one that shows the garment (front, back, detail, flat lay), roles named by ordinal in the prompt, the missing role described by DD2's band wording; the prompt forbids adding, moving or restyling any logo, label, print or text.
3. Conditioning, mode B: references are the flat lay(s) of the option plus one photo of the brand's registered model (DD8 registry, real model by default) wearing a different garment; the planner generates role 2 first, holds it for review as the anchor, then generates roles 1, 4 and 5 with the approved anchor as an extra reference; role 3 is a crop of the flat lay. The anchor is the one shot a person always sees before the set is made.
4. Per-image cost for DD9: 0.10 USD per generated image at 2K (0.15 at 4K), 0.20 USD per accepted image to cover the ladder at two attempts on average; mode A about 0.20 to 0.40 per product (one or two roles), mode B about 0.80 per product (four roles). Upscaler and gate compute are already in the module's GPU budget.
5. What the planner must send (request shape; compare catalog-service `server/core/clients/openrouter.py`): one `POST /api/v1/images` body per role: `model`, `prompt`, `aspect_ratio:"3:4"`, `resolution:"2K"|"4K"`, `input_references` as data URLs in a fixed order (sources, model reference, anchor), `session_id` = batch id and product id for spend grouping (catalog-service's `attribution_session_id` pattern), `user` = operator id. Read `usage.cost` into the `gen_key` record with the output sha, model id, prompt hash and reference shas (DD2). catalog-service keeps two shapes (chat plus `modalities` and `image_config.aspect_ratio` with a text label before each reference for Gemini; `/images` with `input_references` and no labels for GPT Image); the Images API gives one shape for every vendor and the trials show ordinal labels in the prompt are enough, so one shape is the recommendation. catalog-module's client (`packages/core/src/llm/openrouter.ts`) is chat-completions only and already parses `message.images`; the planner needs one new `createImage` call against `/images`, the same key handling and retry budgets, and the LIVE_SMOKE gate for live calls.
6. Unproven and owned by the next steps: the gate's exit numbers (DD2 R3, 300 labelled shots); prints, logos and labels through G2 and G4 (expect `texture_changed` holds on every printed garment until the bars are set from labels); bottoms and dresses role lists (DD0 items 1 and 2); swimwear and lingerie (DD0 items 3 and 4, not probed); Nano Banana 2.1 (quota error, cheaper if it works); Gemini API retention period ("limited period") versus a written data-processing position for brand photos; whether Styli accepts an upscaled 2K output or requires native 4K.

## Approval question

Do you approve taking Nano Banana 2 through OpenRouter's Image API (Nano Banana Pro as the third rung of the regeneration ladder) as the only generator into the gated V3, with mode A conditioned on the brand's own shots of the option and mode B conditioned on the flat lay plus the registered brand model and chained from a reviewed full-length anchor, at 0.10 USD per generated image (0.20 per accepted image) as the number DD9 uses?

Status: done, awaiting owner answer
