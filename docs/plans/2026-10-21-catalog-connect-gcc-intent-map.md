# Catalog Module Connect GCC: intent map, prioritization and deep-dive program

Date: 2026-10-21. Owner: Sujan Ajay. Status: program approved; all deep dives written, awaiting Gate B answers.
This document is a plan and an investigation record. Nothing in it is implemented.
Implementation decisions are taken by the owner separately after reviewing the deep dives.

## 1. Why this exists

The meeting "Catalog Module Connect - GCC" (2026-10-21, 40 min; Sujan Ajay, Tarannum Naaz,
Nitin Kiran) raised many requests for extending the catalog module. Before building anything
the owner wants: the meeting understood end to end (video and transcript), intents grouped
into buckets and prioritized, a clear line between the catalog module and separate products,
alignment with Opptra's vision and GCC multi-brand reach, and one deep dive per in-scope
bucket. Evidence sources: transcript, 131 video frames, catalog-module repo, catalog-service
repo, opptra-scrapers repo, Opptra public site, BigQuery warehouse metadata.

## 2. What the meeting said (verified against the video)

- Naz runs GCC cataloging through an agency at 60 INR per style (all platforms plus template
  filling) and ChatGPT by hand (5 to 6 images a day). She wants the tool now.
- Yesterday's GTPlayer output on Noon and Centrepoint was called "head cut off". The frames
  show the model cut at the legs with head margin; the defect is inherited from the source.
  The links sheet notes show "Skipped for Styli: the photo is smaller than Styli needs",
  a silent low-resolution skip nobody mentioned aloud.
- Apparel needs 5 images with a model on Centrepoint and Styli. The Styli / Landmark email
  (Raymond Lim, Imaging Executive - Studio) defines the exact sequence on a white or light
  grey studio background, same model and lighting: (1) front cropped mid-thigh, (2)
  full-length head to toe, (3) fabric texture close-up without the model, (4) back cropped
  at the hips, (5) head-and-shoulders close-up. Body crops are fine; only head cuts fail.
  Namshi, Noon and Trendyol accept 1 image but 5 is "good catalog".
- For flat lays Naz picks a model from the brand's own website (Vero Moda example) and
  swaps the garment. US Polo has 2,700 options with only 3 images each.
- Footwear wish list (Birkenstock Arizona on a UAE marketplace as the reference): packshot
  with shadow, legs-only model, lifestyle scene by subcategory, callout infographic.
  Lifestyle is missing 99% of the time. Subcategory lives in the Namshi full-listing sheet.
- Nitin: buy before build ("copy with pride"), reviews-driven infographics, competitor review
  benchmarking for new product development (Cardio Bunny vs BlissClub and Lululemon).

## 3. Intent buckets

| # | Bucket | Job to be done | Scope now |
|---|---|---|---|
| B1 | Shot-list compliance for existing on-model photos | Every softline product gets each channel's required shot set, or a precise reason why not | IN |
| B2 | Fill the shot list: derive first, generate second | A product with 3 of 5 roles gets the other 2 (crops first, generated views second) | IN |
| B3 | Flat lay to on-model with the brand's real models | Flat-lay brands get the 5-shot on-model set with a consistent model | IN |
| B4 | Footwear and bags lifestyle with scene rules | One lifestyle image where none exists, scene by subcategory | re-opened 2026-10-22 (DD4) |
| B5 | Infographics and callouts | Feature callouts and use-case panels from attributes, text rendered in code | re-opened 2026-10-22 (DD6) |
| B6 | Attributes backbone and GCC listing fill | Typed fact sheet per product; fill Noon, Namshi, Styli, Centrepoint templates | re-opened 2026-10-22 (DD5) |
| B7 | Review-driven enhancement (inside the product) and NPD inputs (separate) | What customers say feeds content fixes; NPD insight is a separate product | re-opened 2026-10-22 (B7a in DD7, B7b in DD10) |
| B8 | Forecasting and product selection | Demand planning; outside this team | re-opened 2026-10-22 as a boundary memo (DD10) |
| B9 | Cross-cutting: brand style profile and model registry, fidelity gate, cost model | Works for 33+ brands and 6 categories without code per brand | IN (as B3 foundation) |

## 4. Product boundary

One platform: the catalog module at https://catalog-web-847405579637.asia-south1.run.app/catalog.
Nothing is served from studio.opptra.com. Relevant catalog-service pieces are lifted into
catalog-module as patterns and re-tested for GCC, not imported as code. Intelligence used to
enhance images stays inside the product. Only forecasting and new-product selection may be a
separate product.

Target shape (words): identity and policy from catalog-module; a per-brand style profile
and model registry (real brand models harvested from the brand's own site under Opptra's
written rights, synthetic only as fallback); a shot-role model on source images and
per-channel required-role lists; a generation stage (plan, derive by crop and upscale,
generate, verify with a gating fidelity check, then the normal render, compliance, QA and
publish path with a generated flag). SPEC.md non-goals on generation, lifestyle backgrounds
and cropping need owner amendment before any build; the deep dives draft the wording.

## 5. Prioritization (in scope)

| Release | Meaningful whole for Naz | Depends on |
|---|---|---|
| V1 = B1, no generation | Every softline product gets a channel-ready required-role set on all 9 channels, or a precise reason why not. Shot-role classification by the judge, per-channel required roles, head-cut vs body-crop rule, role columns and missing-roles notes in the links sheet, decision on the x2 upscaler to un-skip low-resolution sources | DD0, DD1 |
| V2 = B2 | Fill the shot list by derivation (fabric and head-and-shoulders crops from the full-length shot) plus the fidelity gate for generators and the frontier-model bake-off | DD2, DD3 |
| V3 = B3, gated | Generated views (back, full-length) from existing on-model shots, then flat lay to on-model with the brand's real models, one brand first, every generated shot reviewed until the gate holds | DD3, DD8 |

Corrections to the original sketch: "fix cuts on existing model shots" is mostly not a
problem (body crops pass); the real blockers are the silent low-resolution skip and the
absence of shot roles, on every channel and every softline brand. Fill-to-5 and flat lay to
on-model are one engine with two conditioning modes; only the derived-crop half is
separable and ships first.

Owner rules: no time or effort estimates anywhere; data-derived estimates only where
approximate is acceptable, exact where it matters; trials of frontier image models use the
OpenRouter key from the repo .env, stay small and never exceed limits (cap 50 USD total);
no implementation; the only critical thing is that the core product works as expected with
no failures, neither over- nor under-engineered.

## 6. Deep-dive program

Each deep dive writes docs/plans/deep-dives/<nn>-<slug>.md: findings, options, trade-offs
(build vs buy on cost and fit, open vs closed models, ready-made API or MCP plug-ins),
repo evidence with file paths, exact costs where they matter, a recommendation, and an
explicit approval question for the owner. Default subagent Opus 5.5; Fable 5.1 for DD2,
DD3, DD9 and gate verdicts.

| DD | Topic | Status |
|---|---|---|
| DD0 | Softline category taxonomy and product classification | done 2026-10-22, awaiting owner answer (deep-dives/00-softline-taxonomy.md) |
| DD1 | Shot roles and channel compliance, all 9 channels x all softline brands | done 2026-10-22, awaiting owner answer (deep-dives/01-shot-roles-channel-compliance.md; external check in 01a) |
| DD2 | Derived shots and the generated-image fidelity gate ("spec 12") | done 2026-10-22, awaiting owner answer (deep-dives/02-derived-shots-fidelity-gate.md) |
| DD3 | On-model generation bake-off: frontier image models, VTO vendors, ready-made plug-ins | done 2026-10-22, awaiting owner answer (deep-dives/03-on-model-generation-bake-off.md); trial spend 5.39 USD of 50 |
| DD8 | Brand style profile and model registry for GCC softline brands | done 2026-10-22, awaiting owner answer (deep-dives/08-brand-style-profile-model-registry.md) |
| DD1a | Channel image guidelines, external vs internal, 9 channels, UAE and KSA | done 2026-10-22, awaiting owner answer (deep-dives/01a-channel-guidelines-external-vs-internal.md) |
| DD9 | Business impact, data-derived | done 2026-10-22, refreshed with DD3 prices, then extended to B1 to B8 with one ranking and corrected B1 to B3 numbers; awaiting owner answer (deep-dives/09-business-impact.md) |
| DD4 | Footwear and bags lifestyle with scene rules (B4) | done 2026-10-22, awaiting owner answer (deep-dives/04-footwear-bags-lifestyle.md); trial spend 1.80 USD |
| DD5 | Attributes backbone and GCC listing fill (B6) | done 2026-10-22, awaiting owner answer (deep-dives/05-attributes-listing-fill.md) |
| DD6 | Infographics and callouts compositor (B5) | done 2026-10-22, awaiting owner answer (deep-dives/06-infographics-compositor.md); trial spend 0.45 USD |
| DD7 | Review ingestion and review-driven enhancement (B7a) | done 2026-10-22, awaiting owner answer (deep-dives/07-review-ingestion-enhancement.md) |
| DD10 | Boundary memo: forecasting and product selection (B8) and NPD insight (B7b) | done 2026-10-22, awaiting owner answer (deep-dives/10-boundary-forecasting-npd.md) |

B4 to B8 were re-opened by the owner on 2026-10-22 under the same rules, with Opus 5.5 for all
subagent work in that round. Because Gate B was still open, DD4 to DD7 and DD10 assume each
earlier deep dive's recommendation is approved and list what changes otherwise.

## 7. Evidence summary used by the deep dives

- catalog-module: deterministic pixel-preserving pipeline (ingest, matte, render, QA judge,
  publish, links sheet). No generation. Six product types only. No subcategory, attributes,
  shot role, brand asset registry or per-channel shot-list rules. Reusable: identity, render
  and compliance, publish contract, attention UX, policy table, LLM layer with spend caps,
  GPU service pattern, spec 10 and 11 eval harness and fidelity gate.
- catalog-service: India listing studio (curtains, bedsheets; Amazon, Flipkart, Myntra).
  Generative gallery planner and three-axis verifier (advisory, not gating), listing fill
  engine, Brand DNA text. Known defects: no brand scoping of SKUs, overwritten image
  versions, no claims or locks, synchronous 10-minute execution, model-painted overlay text.
- opptra-scrapers (Scout): marketplace PDP scraper, GCC adapters staged for Amazon.ae/.sa,
  Noon, Namshi; no review text, no brand-site adapters.
- Warehouse: master_sl (16,612 SKUs, 3,749 options, about 9 softline brands), channel SKU
  coverage, GCC revenue by channel, Trendyol per-option image counts, Amazon traffic and
  conversion, Scout ratings. No image counts for Noon, Namshi, Styli, Centrepoint,
  6thStreet, VogaCloset, Shein. No agency cost data.

## 8. Approval gates

- Gate A: this program (approved 2026-10-21).
- Gate B: each deep dive ends with its approval question; the owner answers before dependent
  work is specified.
- Gate C: before any build, the owner amends SPEC.md and records a yes per paid generator.
- Gate D: before any generator reaches the default path, bake-off and fidelity gate numbers
  are reviewed by the owner; generated shots stay in review-all until they hold.

## 9. Resume point (B1 to B8 deep dives complete 2026-10-22)

State: all deep dives written and committed on branch docs/catalog-connect-gcc-intent-map
(worktree C:\Users\Sujan Ajay\Desktop\catalog-module-wt\01-intent-map). Files:
docs/plans/deep-dives/00, 01, 01a, 02, 03, 04, 05, 06, 07, 08, 09, 10. Trial spend: DD3
5.39 USD, DD4 1.80 USD, DD6 0.45 USD; total 7.64 USD of the 50 USD cap. Nothing
implemented. No PR opened.

Next step is Gate B: the owner answers each deep dive's approval question (last section of
each file) and the open items in 00 (16 categories), 01a (unverified channel values),
08 (which brand sites the written rights cover), 04 to 07 (templates, channel acceptance of
lifestyle and infographic images, rights for generated and lettered images, Arabic review,
review scraping ownership) and 10 (owner of B8 and B7b). DD9 proposes a dependency order of
B1, B6, B4, B5, B2, B7a, B3 for the owner to confirm against the V1 to V3 sequence above. Only after those answers does any
dependent work get specified; implementation still requires Gate C (SPEC.md amendment and
a yes per paid generator).

## 10. Roadmap proposal (2026-10-26)

The deep dives were turned into a business proposal in docs/plans/roadmap/: evidence files
01 to 05 (marketing data, catalog liveness, raw and live image audit, India learnings, build
vs buy), 06 metrics and impact model v2, 07 roadmap, 00 one-pager, and six initiative
documents in initiatives/. Order: 01 measure and unblock, 02 channel-ready live catalog,
03 fix the pages we pay to advertise, 04 product facts, listings and customer voice,
05 complete apparel shot sets, 06 richer footwear pages. Base about 269k USD a year for
about 2k USD a year running cost; every revenue lift is still judged until the holdout test
runs. Cumulative trial spend 8.05 USD of the 50 USD cap. Next step: the owner reviews the
one-pager and takes the business asks it lists.
