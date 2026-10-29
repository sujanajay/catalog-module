# DD8: Brand style profile and model registry for GCC softline brands

Date: 2026-10-22. Deep dive DD8 of the Catalog Connect GCC program (foundation for bucket B3, flat lay to on-model, and B9).
This is an investigation only. Nothing here is built, and no GCP resource was touched.

Words used in this document:
- **Brand model**: a real person who appears in a brand's own product photos.
- **AI model**: a machine learning model (matting, judge, image generator). AI model ids never appear in any UI copy proposed here.
- **PDP**: a product detail page on a website.
- **Reference pack**: the small set of approved photos of one brand model (or one synthetic model) that the generator is conditioned on.
- **Role codes** follow DD0: FM front mid-thigh, FL full-length, FC fabric close-up, BH back at hips, HS head-and-shoulders.

## Summary

1. Real brand models can be harvested for most softline brands. Vero Moda, French Connection (US site), Nautica, US Polo Assn and Puma apparel are good sources; Penti and Cardio Bunny are partial because of GCC modesty; Campus and Keds footwear have almost no on-model photos (69 PDPs sampled across 9 brands, table F1).
2. Every good site has full-body, face-visible shots on a white or light-grey studio. Backs and head-and-shoulders shots are rarer, so a reference pack for one brand model is assembled across many products, never from one page.
3. Only Puma (ae.puma.com, sa.puma.com) and a USPA Kuwait store are GCC sites. The others are global, US or India sites, so the owner must confirm which sites the written rights cover.
4. Harvest method: a small dedicated harvester inside catalog-module, run as a Cloud Run job, with 4 readers (Shopify product feed, image sitemap, brand JSON API, page HTML). It covers all 9 brands for a compute cost of cents. Apify and Scout are kept only as fallbacks for a blocked site.
5. Schema: brand_rights, brand_source_site, model_asset (each photo tagged), reference_model (one grouped person with a versioned reference pack, real or synthetic) and brand_style_profile (versioned and owner-approved). model_policy gains style_profile_id and reference_model_id.
6. Synthetic fallback rule: used only when a brand and gender has no approved real reference pack. The synthetic model is generated once as a model sheet, approved, versioned, and never re-prompted per product.
7. From catalog-service, port the visual_schema pattern (structured, versioned, compiled into a brief and a checklist) and the identity plate idea. Do not port the free-text Brand DNA or its per-job AI compression.
8. Risks: USPA in Opptra's warehouse is footwear only, so the USPA fill-to-5 pilot has no apparel to test on (DD0 open item 15). Cardio Bunny's robots.txt bans AI and scraper bots. GCC modesty rules out most Penti and Cardio Bunny photos.
9. Approval asked: the schema, the harvest method, and "real brand models first, synthetic fallback" as the operating rule.

## Findings

### F1. Harvest feasibility per brand (read-only sampling, 2026-10-22)

Method:
- Public pages only. No logins, no paid APIs.
- 5 to 8 apparel or footwear PDPs per brand. At most 6 full-resolution samples per brand were saved to the session scratchpad (dd8-samples/<brand>/) and viewed.
- Counts were made by eye from contact sheets. Treat the view, face and model counts as approximate; the PDP and image totals are exact for the sample.
- "Full-body" means head to feet in frame. "Back" counts back views at any crop.

| Brand | Site sampled | Platform and access | PDPs | Images | On-model | Full-body | Back | Face visible | Background | Max resolution | Distinct models (est.) | GCC modesty | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Vero Moda | veromoda.com/en-gb (Bestseller global) | Custom headless app; curl 200; robots allows /; per-locale product sitemaps list every PDP and all its image URLs | 8 | 41 | 31 | 13 (every PDP has one) | 8 | 16 | Seamless light grey or white studio on 7 of 8 PDPs; 1 PDP on a concrete floor | 4100x5500 to 5350x7133 originals | 5 to 7 | 4 of 8 PDPs questionable (spaghetti straps, deep V, sleeveless, shorts styling) | Good |
| US Polo Assn | uspoloassn.com (4) and uspoloassn.in (4) | Shopify; /products.json open on both | 8 | 55 | 48 | 9 | 8 | 38 | US: very light grey, consistent. India: coloured backdrop that changes per product | 1200x1560 (US), 1500x1940 (India) | 8 to 9 | Mostly fine; 1 women's top styled with above-knee shorts | Good, but few full-body shots |
| US Polo Assn (GCC) | uspoloassn.com.kw | Shopify; /products.json open; operator not confirmed (licensee style codes) | 4 | 21 | 18 | 3 | 3 | 12 | White or light grey, very consistent | 2004x3006 | 2 | Fine | Good, rights holder unknown |
| French Connection | usa.frenchconnection.com | Shopify; /products.json open. The main site frenchconnection.com returns 403 behind a Cloudflare challenge | 7 | 40 | 40 | 28 (4 per PDP: front, back, side, second front) | 7 (plus 7 side) | 24 | Uniform light grey, very consistent | 2250x3000 | 4 to 5 | 5 of 7 PDPs questionable (straps, mini dress, sleeveless tank styling) | Good (US site) |
| Penti | penti.com/en | SAP Commerce or Intershop (not confirmed); curl 200; robots allows /p/; sitemap 200; predictable CDN names (_front, _view1 to _view5) | 7 | 31 | 23 | 6 (pyjamas only) | 7 | 10 | White or light grey for pyjamas and bikinis; warm off-white for bras | 1200x1800 native | about 7 | All 15 bra and bikini on-model shots unsuitable; about 7 of 23 on-model shots are GCC-safe | Partial (sleepwear only) |
| Nautica | nautica.com (US) | Salesforce Commerce Cloud behind Akamai. Plain curl 403; curl with full browser headers 200; Python urllib blocked (TLS fingerprinting likely). Image sitemap present | 7 | 28 | 28 | 11 | 7 | 18 | Warm off-white seamless, very consistent | 5000x5000 square | about 7 (4 men, 3 women) | Women's dresses above the knee (about 8 images); men's fine | Good, access needs care |
| Cardio Bunny | cardiobunny.com (Polish brand, one catalogue in 11 locales) | IdoSell; curl 200; sitemap.xml.gz. robots.txt sets Crawl-delay 1 and disallows ClaudeBot, GPTBot, anthropic-ai, img2dataset, Scrapy and ApifyBot | 7 | 36 | 36 | 15 | 12 | 16 | Light grey seamless, consistent | 933x1400 (older), 2078x3000 (newer) | 5 to 6 | About 25 of 36 show bare midriff, bra tops or sheer panels | Good quality, low GCC fit |
| Puma | ae.puma.com/ae/en (GCC site; sa.puma.com also exists) | Salesforce Commerce Cloud likely; curl 200; 4 product sitemaps with 1,643 PDPs and image tags. Image names mark on-model shots (mod01 to mod05) | 7 (3 apparel, 4 shoes) | 42 | 12 | 5 | 2 | 8 | Light grey (apparel); blue-grey gradient (shoes) | 2000x2000 | 1 per PDP | 1 cropped top | Good for apparel, partial for footwear |
| Campus | campusshoes.com | Shopify; /products.json open | 7 (5 shoes, 2 tees) | 48 | 13 (tees only) | 3 | 2 | On both tees | Light grey (apparel) | 2160x2880 (apparel), 1080x1440 (shoes) | 2 | Women's tee styled with bike shorts | Scarce for footwear, good for apparel |
| Keds | keds.com (US, run by Designer Brands) | Angular single-page app; open JSON API (api.keds.com item assets); product sitemap with 343 products | 7 | 38 | 1 (seated, face not shown) | 0 | 0 | 0 | White packshots; one editorial beige | 2000x2000 | 1 | Bare legs in several shots | Scarce |

Wider counts beyond the PDP sample:
- Puma AE sitemap (products with any on-model image name): adult apparel 794 of 841 (94%), kids apparel 108 of 114, adult shoes 178 of 374 (48%), kids shoes 22 of 83. Shoe model shots are full-body or legs-only on an editorial gradient; none are on white.
- Campus: first and last image of 24 further products (22 footwear) showed no on-foot shots.
- Keds: secondary images of 40 further products via the API showed about 8 with people (2 legs-only, about 4 seated, 2 top-down on foot), each a different model, at most 1 per product.

Primary websites and GCC presence:
- Vero Moda: veromoda.com is the richest. It is multi-brand (Topshop and Mama-licious products appear under its URLs), so a brand filter is needed. veromoda.in (Shopify) is worse: mostly kids' wear in the newest 250 products, coloured backdrops, 1080x1440. No GCC own site.
- US Polo Assn: uspoloassn.com (US, apparel and accessories) and uspoloassn.in (Arvind, the India licensee, mostly apparel). uspoloassn.com.kw is the only GCC store found. uspoloassn.ae and uspa.com/sa look like brand-information pages; where their shop buttons lead was not confirmed.
- French Connection: frenchconnection.com is blocked to scripts; usa.frenchconnection.com is open. No GCC own site.
- Penti: penti.com (and penti.com.ro). In GCC it sells only through Namshi (third party).
- Nautica: nautica.com. India sells through Flipkart, UAE through Namshi and a Dubai Mall store. No GCC own site.
- Cardio Bunny: cardiobunny.com only.
- Puma: ae.puma.com and sa.puma.com are GCC sites. All Puma regions share one image store (images.puma.com), so GCC and global images are the same files.
- Campus: campusshoes.com. Keds: keds.com. Neither has a GCC site.

What this means for B3:
- In Opptra's GCC range (DD0 F3), Campus, Keds and USPA are footwear only, and Puma is 105 footwear and 83 apparel options. On-model generation (B3) is mainly for Vero Moda, French Connection, Nautica, Cardio Bunny, Penti sleepwear and Puma apparel.
- USPA pilot mismatch: the brief names USPA for fill-to-5, but master_sl holds only USPA footwear (529 options). USPA apparel imagery is plentiful on its sites, but there are no USPA apparel products in the warehouse to fill. DD0 open item 15 must be answered first.
- Reference packs need a full-length front with the face visible (FL), a back (BH), a head-and-shoulders shot (HS) and ideally a mid-thigh front (FM) of the same person. One PDP rarely has all four. French Connection (4 full-body per PDP with back and side) and Nautica come closest. Vero Moda, USPA and Puma need packs assembled across products.
- GCC modesty is a property of each photo, not of the brand. A brand model can be suitable in a long-sleeve top and unsuitable in a strappy dress. The generated outfit takes its coverage from the garment being placed, so the reference pack should use covered poses (sleeves, knee or longer) where possible.
- Resolution is enough for reference use on every good site (1200x1560 and up). Cardio Bunny's older 933x1400 images are below the threshold proposed below.

Not verified: image rights or terms pages (the owner states there is no constraint and Opptra holds written rights), the French Connection UK imagery, Penti's platform, Keds videos, and the Puma India site's coverage.

### F2. Repo evidence: catalog-module today

- `packages/core/src/db/schema.ts`:
  - `model_policy` (lines 189 to 219) is keyed by `(brand_slug, category)` with a unique index. `category` is a PRODUCT_TYPE or `*`. It holds matte and QA AI model choices, thresholds, `shadow_mode`, `eval_batch_ids` and `gates`. It has no style or person-model reference.
  - `brand_master` (lines 146 to 161) holds name, slug, line and source only. There is no brand asset, style or rights data anywhere in the schema.
  - `catalog_source_images` (lines 365 to 402) already has the pattern a registry asset row needs: `sha256`, `raw_uri` in the private bucket, `width`, `height`, `flags`, versioning by `is_current` and `replaces_id`.
- `packages/core/src/catalog/qa/policy.ts`: `resolvePolicy` falls back in the order (brand, category), (brand, *), (*, category), (*, *), then the built-in default. `ensureDefaultPolicies` is check-then-insert. New columns plug into the same fallback with no new lookup.
- `packages/core/src/safe-url.ts` and `packages/core/src/catalog/ingest/url-list.ts`: `safeFetch` is GET only, SSRF safe, capped at 40 MB, and follows redirects by hand. A harvester can reuse it.
- `packages/core/src/catalog/qa/classify.ts` and `templates.ts`: the existing vision judge returns a per-photo `view` (front, side, back, detail, on-model, flat, and more). It is the natural tagger for registry assets, with new fields for role, face, full-body and modesty.
- `packages/core/src/catalog/cost.ts` (lines 20 to 33): Cloud Run prices recorded from cloud.google.com/run/pricing on 2026-10-20. asia-south1 is Tier 1. Instance-based billing (which Cloud Run jobs use) is USD 0.000018 per vCPU-second and USD 0.000002 per GiB-second.
- `infra/catalog-eval.sh`: the existing Cloud Run jobs pattern (check-then-deploy, `gcloud run jobs execute --wait`). A harvest job would follow it.
- `packages/core/src/catalog/channels.ts`: the largest targets are Styli 2342x3123 and Centrepoint 3000x3000. These apply to generated outputs, not to references.
- `docs/SPEC.md` line 436: "Generative edits, paid image APIs: not used (product pixels must not change)". B3 needs an owner amendment before any build (Gate C). Draft wording for the registry part is under Recommendation R6.
- `AGENTS.md`: the worker writes public objects only under `catalog/` and `catalog-test/` for the product it holds the lock for. Harvested reference photos are not outputs, so they must live only in the private bucket and never under the public prefixes.

### F3. Repo evidence: catalog-service (read only)

- `server/entities/catalog/brand.py`: `brand.brand_dna` is one non-null free-text column. It has no version, no history (only `updated_at`), no images and no rights reference.
- `server/pipelines/generation/inputs.py` (`_load_brand_dna`, around line 74): loads the DNA per job and fails the job if it is empty.
- `server/pipelines/generation/common_image.py`: compresses the full DNA once per image job with an AI call (`_COMPRESS_MAX_TOKENS = 500`) into fonts and colours only. Its prompt explicitly drops "photography style", moods and avoid lists. A regex fallback runs if the call fails. The result feeds `brand_look` in slot briefs (`gallery.py` line 1452), which is used for overlay typography.
- `server/pipelines/generation/visual_schema.py` and `visual_schemas/curtains.json`, `bedsheets.json`: hand-authored, versioned (`"version": 1`) JSON per category. Each one maps product data columns to geometry and appearance roles, compiles them into fixed scene sentences and a verifier checklist, and returns None (no change in behaviour) when no schema matches.
- `server/pipelines/generation/context.py` and `gallery.py` (`identity_plate_prompt`, around line 1312): an "identity plate" is generated first as the canonical product image and then used as the truth for every slot render.
- `server/pipelines/generation/verify.py`: the verifier is advisory ("quality (advisory) ... shown, never retries").
- There is no concept of a person model, model consistency across images, or GCC modesty anywhere in catalog-service.

### F4. Repo evidence: opptra-scrapers (Scout, read only)

- `engine/fetch.py`: curl_cffi with TLS/JA3 impersonation, proxy rotation, bot-wall detection and backoff, with sticky proven exits per channel (built for Noon and Namshi Akamai).
- `engine/power_fetch.py`: a ladder of HTTP, then browser, then ScraperAPI (paid credits, capped at 5 concurrent requests).
- `engine/universal.py`: "any URL to record", but the record is price-oriented (title, MRP, deal price, availability). It returns no image gallery.
- `adapters/namshi_common.py` (example adapter): parses JSON-LD and React server data for price, stock and delivery fields of one marketplace.
- `marketplaces/_ENGINE_CONTRACT.md`: one atom `scrape(marketplace, entity, id_or_url, fields) -> Record`, with BigQuery sinks and job stores.
- `engine/image_export.py`: zips gallery URLs from scrape records (`IMAGE_DOWNLOAD_CAP = 2000`). It is the only image path, and it downloads; it does not tag or store per image.
- Fit: Scout is Python and lives in another repo and runtime, with marketplace-specific records. Its strength (anti-bot fetching) is needed on only 2 of the sampled sites (Nautica's Akamai, French Connection UK's Cloudflare), and French Connection has an open US site.

### F5. Managed services and feed formats (vendor pages read 2026-10-22)

Context7 was not available in this session. The vendor pages below were read directly. The recommended option adds no new external library (it uses undici, sharp and zod, which are already in `packages/core/package.json`).

- Apify (apify.com/pricing):
  - Plans: Free USD 0 (USD 5 usage credit), Starter USD 19 a month, Scale USD 199, Business USD 999. Annual billing is USD 17, 179 and 899.
  - Compute unit (CU, Apify's billing unit for RAM used over runtime): USD 0.20 on Free and Starter, 0.16 on Scale, 0.13 on Business.
  - Residential proxy: USD 8, 7.5 or 7 per GB.
  - Unused credit does not roll over.
  - Approximate actor costs from Apify's own page: plain HTTP crawler about USD 0.2 per 1,000 pages; headless browser USD 0.5 to 5 per 1,000 pages.
  - apify/e-commerce-scraping-tool: "from USD 1.00 per 1,000 product details". It returns one `image` field, may be the main image only, and does not name Salesforce Commerce Cloud.
  - Shopify actors are community-built with very few users: jupri/shopify-scraper USD 5.00, scrapyx USD 1.75, foo121 USD 1.00 per 1,000 results.
  - apify/website-content-crawler strips images by default.
  - Storage and transfer rates were seen only in search snapshots (for example, external transfer USD 0.20 per GB on Starter) and are not confirmed live.
- Firecrawl (firecrawl.dev/pricing): Free 1,000 credits; Hobby USD 16 a month annual for 5,000 credits; Standard USD 83 a month annual for 100,000 credits. A page costs 1 credit, or 5 credits with JSON extraction. That is about USD 0.83 per 1,000 pages, or USD 4.15 with extraction, on Standard.
- Shopify `/products.json` is not an official API. A Shopify staff forum reply says it defaults to 30 products, `limit` is capped at 250, and pagination is not supported. In practice `?page=N` works (verified live on uspoloassn.com and campusshoes.com). Each image entry has `src`, `width`, `height`, `position` and `variant_ids`, but no alt text. The documented alternative is `/products/{handle}.js` (Ajax API), which returns image URLs only.
- Image sitemaps (`image:loc` tags) were confirmed on Vero Moda, Nautica and Puma AE. The Keds item asset API is public but undocumented.

## Options

### O1. Where reference models come from

| Option | What | For | Against |
|---|---|---|---|
| A. Real brand models from the brand's own site, synthetic fallback (owner rule) | Harvest, tag, group and approve a reference pack per brand and gender | Matches each brand's real look; Naz already works this way by hand; the owner holds written rights | Needs rights tracking, a harvest and a grouping step; coverage is uneven (F1); modesty filtering per photo |
| B. Brand-supplied asset pack (DAM export) under the same rights | Ask each brand for its model shoot files | Best resolution and complete angles; no scraping | Depends on each brand responding; not the owner's default. Kept as a second source kind for A, not a replacement |
| C. Synthetic consistent model for every brand | One fixed generated model per brand and gender | No harvest, no rights per photo, full modesty control | Overrides the owner's binding rule; loses the brand's real look |
| D. No registry: pick a reference per product (today's manual way) | The operator chooses a brand photo each time | Nothing to build | A different person per product; no provenance; cannot run at 3,748 options |

### O2. How to harvest

Volume used for the cost lines: every PDP on the sampled sites is in the low thousands per brand. For example, Puma AE has 1,643 PDPs, Keds 343 products and USPA about 3,000 products. Image tagging by the judge costs the same whichever way is chosen, so it is left out of this comparison. It runs under the existing spend caps.

| Option | Fit | Exact unit prices | Cost per 1,000 PDPs |
|---|---|---|---|
| (a) Scout kernel (opptra-scrapers) | Strong anti-bot fetching (curl_cffi, proxies, ScraperAPI). But its adapters, record schema (prices) and sinks (BigQuery) are for marketplace PDPs; no adapter fits a brand site; it is Python in another repo, so data and provenance cross a repo boundary into catalog-module | No licence cost. Proxy pool and ScraperAPI credits on the backstop tier (ScraperAPI plan prices not checked here) | Near zero on open sites; ScraperAPI credits only on blocked ones |
| (b) Apify (managed) | Generic actors do not return full galleries with per-image size (the e-commerce tool returns one image; the content crawler strips images). Shopify actors are small community builds. Cardio Bunny's robots.txt names ApifyBot. Adds a vendor, an API token and a data copy outside GCP | Starter USD 19 a month, or the Free USD 5 credit; USD 0.20 per compute unit; residential proxy USD 8 per GB; e-commerce tool from USD 1.00 per 1,000; Shopify actors USD 1.00 to 5.00 per 1,000 | About USD 0.2 (HTTP) to USD 0.5 to 5 (browser), plus proxy if needed; USD 1 to 5 with a pay-per-result actor |
| (b2) Firecrawl (managed) | Page-to-markdown or JSON; images are not first-class; same vendor and data concerns as Apify | Standard USD 83 a month annual for 100,000 credits | About USD 0.83 (USD 4.15 with JSON extraction) |
| (c) Dedicated harvester in catalog-module | A Cloud Run job in the existing jobs pattern. 4 small readers cover all 9 brands: Shopify feed (USPA, French Connection US, Campus), image sitemap (Vero Moda, Nautica, Puma), brand JSON API (Keds) and page HTML or JSON-LD (Penti, Cardio Bunny). It reuses safeFetch, sharp, the judge, the spend caps, the private bucket and the same database, so rights and provenance stay in one place | Cloud Run jobs, Tier 1 asia-south1: USD 0.000018 per vCPU-second plus USD 0.000002 per GiB-second (cost.ts). A 1 vCPU, 1 GiB job costs USD 0.00002 per second of runtime. No vendor fee | At an assumed 1 vCPU-second per page, USD 0.02. Cloud Storage for a few GB of references is negligible (the exact asia-south1 rate was not re-read in this deep dive) |

Trade-off: cost is negligible for every option, so fit decides. Option (c) is the only one where the harvested photo, its rights record, its tags and its approval live together. Nautica's TLS fingerprint check may also block Node's fetch, as it blocked Python urllib (not tested). If it does, the options are: use the image sitemap (served from the same host, and may be blocked too), ask Nautica for an asset pack (source kind B), or call Scout's fetch as an escalation for that one site.

### O3. Grouping photos into one brand model

| Option | For | Against |
|---|---|---|
| Operator groups by hand on a contact sheet | Exact; no new data type | Slow per brand at catalogue scale |
| AI judge suggests groups (pairwise "same person?" on candidate shots, within one brand), operator confirms | Uses the existing judge and spend caps; stores only labels, no biometric data | AI cost per pair; suggestions can be wrong, so confirmation stays mandatory |
| Face embeddings and clustering | Fast and automatic | Stores biometric data per person. The widely used open face-recognition weights (InsightFace) are published for non-commercial research use (not re-verified here). It is a new library and a new data class |

### O4. Style profile format

| Option | For | Against |
|---|---|---|
| Free text per brand (catalog-service brand_dna) | Easy to write | Not versioned; needs an AI call to read; cannot be checked by code; the existing compression drops photography fields |
| Structured, versioned JSON validated by zod, compiled into a generation brief and a gate checklist (catalog-service visual_schema pattern) | Deterministic, testable, diffable between versions, the same answer every run; the checklist feeds the fidelity gate | Needs a schema and an approval step per version |

## Recommendation

### R1. Operating rule

Real brand models first, synthetic only as a fallback. In order of preference, per brand and gender:
1. An approved real reference pack from the brand's own site (`source_kind = site_harvest`).
2. An approved real pack the brand supplied (`brand_supplied`).
3. An approved synthetic model sheet (`synthetic`).

If none exists, generation is not offered for that product. The product gets a plain reason ("No approved brand model for Vero Moda women yet") instead of a silent default.

### R2. Schema (Postgres in the existing drizzle schema; all new tables)

**brand_rights**: one row per written grant.
- Fields: `id`, `brand_slug`, `grantor` (the brand or the licensee entity that signed), `document_ref` (a reference to the signed document in the private bucket or a contract id; never its text), `sites` (list of domains covered), `allows_reference_use` and `allows_generated_likeness` (whether images of their models may condition new generated images), `valid_from`, `valid_to`, `recorded_by`, `created_at`.
- No asset can be marked usable without a covering rights row.

**brand_source_site**: where to harvest.
- Fields: `id`, `brand_slug`, `base_url`, `locale`, `reader` (`shopify_feed | image_sitemap | brand_api | page_html`), `brand_filter` (for multi-brand sites such as veromoda.com), `rights_id`, `enabled`, `last_probe` (jsonb: status, robots summary, blocked yes or no), `last_harvest_at`.

**model_asset**: one row per harvested or supplied photo.
- Source fields: `id`, `brand_slug`, `source_kind` (`site_harvest | brand_supplied | synthetic`), `site_id`, `page_url`, `image_url`, `rights_id`.
- File fields: `sha256` (unique per brand), `raw_uri` (private bucket `image-links-agent-assets` under `models/<brand_slug>/<sha256>.<ext>`; never public), `width`, `height`, `garment_category` (DD0 taxonomy key, from the page), `gender`, `age`.
- Tags from the judge: `view` (front, back, side, three_quarter, detail), `role` (FM, FL, FC, BH, HS, other), `full_body`, `head_in_frame`, `feet_in_frame`, `face_visible`, `background_class` (white, light_grey, coloured, editorial), `background_rgb` (measured from pixels by code, not by AI), `lighting_class`.
- Suitability: `gcc_suitability` (`ok | review | unsuitable`) with reasons (for example sleeveless, above_knee, midriff, sheer, lingerie). `usable` with reasons (below 1500 px on the long side, editorial background, no rights).
- Tracking: `tagger_version`, `operator_override` (jsonb), `reference_model_id` (nullable), `status` (`new | tagged | rejected | grouped`), `harvested_at`.

**reference_model**: one person, real or synthetic.
- Fields: `id`, `brand_slug`, `label` (shown to the operator as "Vero Moda model A"; never a person's name or an AI model id), `kind` (`real | synthetic`), `gender`, `age` (adult only until DD0 open item 7 is answered), `version`, `status` (`candidate | approved | retired`), `pack` (jsonb: asset ids per role, with at least FL front with face, HS, BH, and FM if available), `gcc_ok`, `approved_by`, `approved_at`.
- `synthetic_spec` (jsonb, synthetic only): the generator name and version as recorded internally, the input sheet asset ids, a prompt hash and a seed if the generator supports one.
- Unique `(brand_slug, label, version)`. A new version is a new row; an approved pack is never edited in place.

**brand_style_profile**: versioned and approved.
- Fields: `id`, `brand_slug`, `version`, `status` (`draft | approved | retired`), `body` (jsonb, zod-validated), `evidence_asset_ids`, `approved_by`, `approved_at`. Unique `(brand_slug, version)`, with at most one approved row per brand.
- `body` holds:
  - `models`: the reference_model id per gender (and per age later).
  - `demographics`: the gender and adult age band per line, describing the brand's own range, not a target.
  - `pose_set`: per DD0 category, the ordered role list (default FM, FL, FC, BH, HS) with crop rules: head margin, mid-thigh line, hip line, and "body crops pass, head cuts fail".
  - `background`: the target hex (white or a light grey taken from measured pixels), the tolerance, and the floor shadow (yes or no).
  - `lighting`: a soft even studio key, plus a class measured from the evidence.
  - `styling`: the default bottoms and shoes per category when a top is generated (for example, full-length trousers and plain shoes), chosen from GCC-safe evidence.
  - `modesty`: the minimum coverage per market (UAE, KSA), including sleeves, hemline, neckline, midriff and sheer panels. It is applied to the styling that is generated around the garment, never to the garment itself.
  - `logo_rules`: logos on the garment are preserved as in the source; no logo is added; no text is painted by the generator.
- At job time the profile compiles in code into (1) a fixed generation brief and (2) a checklist for the DD2 fidelity gate (background colour within tolerance, crop lines, same person as the pack, modesty items). This is the visual_schema pattern.

**model_policy** (existing): add two nullable columns.
- `style_profile_id`: pins an approved profile version. If null, the brand's single approved profile is used.
- `reference_model_id`: overrides the profile's per-gender choice for that (brand, category) row.
- Both resolve through the existing `resolvePolicy` fallback order, so `(brand, apparel_flat)` and `(brand, apparel_model)` rows can differ.

**Generated outputs** (planned generation stage):
- Each generated shot records `generated = true`, `style_profile_id` and version, `reference_model_id` and version, and the pack asset ids used. A later profile change never rewrites history; a re-run makes new outputs.

### R3. Harvest method

Option (c), a dedicated harvester in catalog-module:
- It runs as a Cloud Run job (`catalog-harvest`, min instances 0, deployed by an idempotent `infra/catalog-harvest.sh` in the `catalog-eval.sh` pattern).
- One run per `brand_source_site`. It lists products through the site's reader and keeps apparel PDPs that match the brand filter.
- It downloads each image once through `safeFetch` into the private bucket (deduplicated by sha256). Reads are polite: concurrency 1 to 2, and robots crawl-delay honoured.
- The judge then tags each image under the existing spend caps.
- It writes only to `model_asset`. It never touches `catalog/` or `catalog-test/` public objects.

A blocked site is handled in order:
1. A sibling site of the same brand that the rights cover (French Connection US instead of UK).
2. A brand-supplied pack.
3. Scout's fetch as an escalation for that one site.

Apify is not recommended. It adds a vendor and a data copy outside GCP for no saving, and its generic actors do not return full galleries with sizes.

### R4. Synthetic fallback rule

When it applies:
- Only when, for a brand and gender, harvesting produced no reference model whose pack has an FL front with the face visible, an HS and a BH, each at least 1500 px on the long side, on a white or light-grey background, rights-covered and GCC ok.
- Or when the owner retires every real model for that brand and gender.
- Expected today: Keds, Campus footwear (if legs-only is ever approved), and possibly Cardio Bunny if modest covered shots prove too few.

How it is fixed:
1. The generator chosen by DD3 produces one model sheet (FL front, FM, BH, HS) from the approved style profile's demographics, background and lighting.
2. The operator approves it.
3. It is stored as `reference_model` with `kind = synthetic`, version 1, with its sheet images as `model_asset` rows (`source_kind = synthetic`).

After that:
- Every product generation conditions on the sheet images, never on a text description alone, so the same person appears across products.
- A new version is made only by an explicit owner action; old outputs keep their recorded version.
- Real and synthetic models are never mixed within one product's shot set.
- When a real pack is later approved for that brand and gender, the profile switches to it for new generations only.

### R5. Onboarding a new brand (what data, what checks)

1. **Rights.** Record `brand_rights` (grantor, document reference, sites, both use flags). Check: a rights row covers every site to be harvested, and `allows_generated_likeness` is yes. Otherwise stop.
2. **Sites.** Add `brand_source_site` rows and run a probe: the reader is detected, status 200 on a sample, robots summary, and blocked yes or no. Check: one open, rights-covered site per brand, or a brand-supplied pack.
3. **Harvest and tag.** Run the job and review the counts per role, full-body, face, background and GCC suitability, the same columns as table F1. Check: usable assets exist for FL, HS and BH per gender sold.
4. **Group.** Accept or fix the judge's suggested person groups on a contact sheet. Check: every candidate reference model has 2 or more photos per pack role where available.
5. **Choose reference models.** Pick one per gender sold (adults only for now) and assemble its pack. Check: the pack is complete, at least 1500 px, white or light-grey background, `gcc_ok`, and a covered pose where possible.
6. **Draft the style profile.** Code measures the background colour, crop lines and margins from the evidence; the judge drafts the text fields; the owner approves v1. Check: zod validation passes and the profile compiles into a brief and a checklist.
7. **Policy.** Set `style_profile_id` on the brand's apparel rows in `model_policy`.
8. **Pilot.** Generate a small set with every shot reviewed (Gate D) until the DD2 fidelity gate numbers hold for that brand.
9. **Refresh.** Harvests can be re-run on demand. New assets never change an approved pack; only an approval creates a new version.

Pilot order this implies:
- Vero Moda women (flat-lay pilot). Its source is strong (13 full-body shots in 8 PDPs, 5 to 7 models, very high resolution), but it must be filtered to covered styles.
- USPA fill-to-5 only after DD0 item 15 confirms an apparel range. Its imagery is plentiful, with the Kuwait store the cleanest if the rights cover it.

### R6. What to port from catalog-service, and draft SPEC wording

Port as patterns, re-tested, never as imported code:
- The visual_schema pattern: a structured, versioned file, compiled deterministically into a brief and a verifier checklist, with "no schema, no change". It becomes brand_style_profile, with "no approved profile, no generation offered".
- The identity plate idea: one canonical truth image set reused for every slot. It becomes the reference pack for the person; the product's own source photos remain the garment truth.

Do not port:
- Free-text `brand_dna` and its per-job AI compression. It is not versioned, not testable, varies run to run, costs an AI call per job, and deliberately drops the photography fields this program needs.
- Fonts and colours, which belong to B5 infographics (deferred).
- The advisory-only verifier. The GCC gate must block (Gate D).
- Model-painted text.
- The India category schemas (curtains, bedsheets).
- catalog-service's known defects: no brand scoping, overwritten versions.

Draft SPEC.md amendment (for the owner at Gate C, registry part only): "Reference images of brand models are harvested only from sites covered by a recorded written grant, stored only in the private bucket under models/, tagged and approved per brand before use, and never published. Generated on-model shots name the approved style profile and reference model version they used. A synthetic model is used only when no approved real reference model exists for that brand and gender."

## Approval question

Do you approve (1) the registry and style profile schema in R2 (brand_rights, brand_source_site, model_asset, reference_model and a versioned brand_style_profile, plus style_profile_id and reference_model_id on model_policy), (2) a dedicated harvester inside catalog-module as the harvest method (R3), with Scout only as an escalation for a blocked site and no Apify, and (3) "real brand models from the brand's own site first, synthetic model only as the fallback in R4" as the operating rule, and will you confirm which sites your written rights cover (in particular veromoda.com, usa.frenchconnection.com, uspoloassn.com.kw and cardiobunny.com)?

Status: done, awaiting owner answer
