# M7 Quality gate and benchmark harness - requirements (draft for review, 2026-11-02)

Follows `00-template.md`. Feature ids `M7-F1` to `M7-F9` are the rows of the M7 table in `../module-map.md`, in table
order. Method: the Harvey Labs talk (`.runs/2026-11-02-harvey-method.md`): benchmark first, planted-defect evals that
grade themselves, one staged gate for any model, then swap, then route, then train. Detail reused from old initiatives
03, 04, 05 and 07 (checks G1-G7, scene and infographic checks, planted defects, frozen split); every review card is cut.

## 1. Purpose

- **Why:** buying analysis and generation is only safe if we check what comes back, and the market moves monthly. M7
  holds our golden sets, one interface with fallbacks for every bought capability, a harness that scores any new model
  or vendor on quality, cost and speed and promotes it automatically when it wins, and a small sampled human audit that
  keeps the numbers honest.
- **Outcome metric:** product-truth defects reaching channels per 1,000 images (target 0 on hard blocks), audit fail
  rate per cell, and time to promote a better vendor (target under a week, no engineer).
- **Intents:** I012 (self-learning as new models arrive), I018 (measured analyzer), I002 and I003 (reuse and
  fallbacks), I014 and I032 (human only where needed), I016 (the Harvey method), I013 (open and closed source), I037
  (bilingual).

## 2. Scope

**In (P0):** golden sets v1 with a scoring runner (M7-F1); one vendor interface with ranked routes, fallbacks and a
kill-the-primary test (M7-F2); the 2-5% sampled audit with automatic relapse (M7-F3).

**Out:** reading images (M2), making images (M3), channel rules (M5), the sales experiments themselves (M4), cost
reconciliation (M6, which M7 reads).

**Later:** fidelity checks for generated images (M7-F4), planted-defect tests (M7-F5), the staged gate with automatic
promotion (M7-F6), vendor bake-offs for every buy decision (M7-F7), blocking human calls (M7-F8) and the bilingual
check (M7-F9), all P1. Post-training our own models is not planned; it is considered only if routing shows a gap that
no bought model closes (Harvey step 3).

## 3. Contracts

### 3.1 Reads
- **M0:** content versions (any output and its parents), source kinds, live state, the holdout flag.
- **M2:** readings (for scoring against labels and for audit priority: `conflict`, `unknown`, `reading.degraded`).
- **M3:** outputs to check and audit; slot states.
- **M4:** live secondary signals (ad click rate, conversion) for the last gate stage.
- **M6:** cost per call and per route; latency per call.
- **M9:** channel rejections (each becomes a candidate golden case).

### 3.2 Writes
- `GoldenCase` (set, split `tuning` or `frozen`, item reference by fingerprint, labels, labeller, version).
- `Candidate` (capability, vendor, model, prompt or parameter version, licence, data-use terms, region, state:
  `registered`, `benchmarked`, `shadow`, `canary`, `serving`, `retired`, `off`).
- `HarnessRun` (candidate, golden set version, per-field or per-check scores with confidence intervals, cost per
  correct answer or per accepted image, p50 and p95 seconds, refusal and error rates, verdict).
- `Route` table per capability (ordered; the live routing every module calls through).
- `AuditItem` (sampled output, cell, reason sampled, answer, auditor, time) and `CellState` (rate, state, counts).
- `CheckResult` per generated image (P1): each check's number, bar, pass or fail, versions.
- Events: `route.changed` (with the run that justified it), `cell.relapsed`, `audit.failed` (M3 pulls the image at the
  next publish), `golden.case_added`.

### 3.3 Interface shape (every bought or own capability)

```
call(capability, input, ctx{brand, category, channel, batch, cap_usd}) -> {ok, output, route_id, cost_usd, seconds,
                                                                          refusal?, error?}
capabilities (P0): vision.read, judge.render, image.matte, image.upscale, ocr.read, people.detect
capabilities (P1): judge.fidelity, image.make.reference_edit|tryon|model_swap|ghost_to_model|background|scene,
                   text.write (M8), text.translate (M8)
Route { capability, rank, adapter, model, params_version, price, rate_limit, region, licence, no_training_terms,
        state, circuit{failures, opened_at} }
```

### 3.4 Contract needs from M0
1. Fingerprints for every output and parent, so a golden case or audit item points at exact bytes.
2. (Owned by M7, not M0.) The `pulled` mark lives on M7's `AuditItem`; M3 reads it at the next publish and the removal
   reaches M0 as a normal `removed` change event with reason `operator` (audit) and the audit item id, which M9's watch
   then verifies.
3. The source kind and route id on every output version (which vendor and model made it), kept out of operator text.

## 4. Features

### M7-F1 Golden sets (P0)

#### 4.1.1 User story
As the program owner, I want a fixed, labelled set of our own products that every model, prompt and vendor is scored
on, so decisions about quality are numbers on our data, not vendor claims.

#### 4.1.2 Functional requirements

The sets:
- **M7-F1-R1 Analyzer set (GS-A).** The 300 rows of `.runs/2026-11-02-golden-sample.csv`: 240 GCC softline options over
  14 brand x department cells (rare cases over-represented), 40 GCC hardline, 20 India pilot. Every photo of each
  product is fetched from its Supabase folder (`parent_zsku`) or, failing that, its Trendyol listing (99 rows have no
  usable hero URL; 8% of master links are dead). Expected size about 1,500 to 1,800 photos.
- **M7-F1-R2 Photo labels:** shot role, view, head state and head-cut position, product-cut sides, person present,
  child present, text overlay kind, background class, collage, lifestyle, wrong item. **Product labels:** taxonomy node,
  audience (with kids age band), garment length, pack type, primary colour name. **P1 attribute labels** for the apparel
  subset: sleeve length, neckline, length, fit, pattern, closure, material where visible.
- **M7-F1-R3 Render and matting regression set (GS-B):** keep `packages/core/test-fixtures/catalog/evals/golden-manifest.json`
  (photos pinned by sha256, tags such as white_on_white, thin_straps, transparent, cut_edge) and its derived hard cases
  (`downscale_450`, `cut_bottom_15`, planted wrong item) from `packages/core/src/catalog/evals/golden.ts`.
- **M7-F1-R4 Crop set (GS-C):** the head test photos (full length cut at forehead = cut; at shoulders = none; between
  nose and upper lip = cut) plus at least 10 products per garment type (tops, knitwear, outerwear with long coats,
  dresses with at least 5 midi or maxi, bottoms, sports tops with sports bras, sports bottoms, lingerie, nightwear,
  swimwear, multipacks, kids per age band, printed, embellished, one-photo products), drawn from GS-A where possible.
- **M7-F1-R5 Generation set (GS-E, P1):** every generated image with a final decision (audit answer or channel
  rejection), plus the planted-defect set of M7-F5.

Labelling plan (one-off, people):
- **M7-F1-R6** Wave 1: 100 GCC apparel and footwear products (the cells Namshi and Noon decisions need) in week one;
  wave 2: the other 140 softline; wave 3: hardline and India when those verticals start. Fields stay `shadow` in M2
  until their wave is labelled.
- **M7-F1-R7** Method: the current model pre-labels; a person corrects in the labelling screen (the existing eval
  labelling page, `apps/web/components/catalog/EvalLabelBar.tsx` and `apps/web/app/api/catalog/batches/[id]/eval-labels`,
  extended with the R2 fields). To measure anchoring on pre-labels, 30 products are labelled blind (no pre-label).
  20% of products get a second labeller; agreement (Krippendorff's alpha, a standard agreement score where 1 is perfect)
  must be at least 0.67 per field, else the field's label guide is rewritten and the field relabelled.
- **M7-F1-R8** Split: by hash of product id, 80% `tuning` and 20% `frozen`, assigned once, forever. Prompts, floors and
  routes may be tuned only on `tuning`; every promotion bar must hold on `frozen`. No learning code reads `frozen`; a
  test checks this.
- **M7-F1-R9** Growth: every audit failure, channel rejection and operator correction becomes a candidate case, labelled
  by the audit answer, and joins a split by the same hash. Sets are versioned; a run names the version it used.

The scoring runner (needed in P0 to release M2 fields):
- **M7-F1-R10** Extend the `catalog-eval` job (`apps/worker/src/catalog-eval.ts`, `infra/catalog-eval.sh`) with a
  `score` command: run a candidate route over a set and split, compare with labels, and write a `HarnessRun`: per field
  accuracy, precision and recall, F1, calibration (accuracy at each confidence band), coverage (share answered, not
  `unknown`), per-cell results, cost per correct answer, p50 and p95 seconds, refusals.
- **M7-F1-R11** Confidence intervals by bootstrap (resampling products 1,000 times) on every reported number, so two
  candidates are compared on intervals, not points.
- **M7-F1-R12** Live calls only in the eval job with a budget (`EVAL_BUDGET_USD`, existing pattern) and only on the
  test area and the private bucket; never against the live site while users are active.
- **M7-F1-R13** The report is a page and a JSON file, no model names on operator pages (engineering pages may show them).

#### 4.1.3 Non-functional
A full GS-A run under 60 minutes; cost of one analyzer run under USD 5 (about 1,800 photos at today's judge prices);
nightly replay without new vendor calls on cached answers; labels never leave our storage.

#### 4.1.4 Configuration
Set versions, split seed (fixed), per-field bars (a bar change is a threshold change and needs one admin approval),
`EVAL_BUDGET_USD`.

#### 4.1.5 Inputs and outputs
In: golden sample CSV, photos, labels, a candidate route. Out: `GoldenCase` rows, `HarnessRun` rows, report.

#### 4.1.6 Human-in-the-loop rule
Labelling is the one-off human job: about 1,800 photos at about 15 s each plus product fields is roughly 8 to 10 person
hours for waves 1 and 2 (judgement). After that, people add cases only through the audit (M7-F3). It never becomes a
per-SKU queue.

#### 4.1.7 Edge cases and failure modes
1. Photo not fetchable (dead link, Google Drive): the case is kept without that photo and marked; the set reports
   coverage.
2. Labellers disagree on a field: both labels kept; the field's alpha is reported; the case counts only once agreed.
3. Wrong product in a folder: labelled `wrong_item` and kept (it is a useful case).
4. Share-link query strings in the CSV: treated as internal; never published.

#### 4.1.8 Buy or build
Build (nobody shares a fashion marketplace golden set). Labelling by Opptra's catalog team; a labelling vendor only if
wave 2 slips by more than a week.

#### 4.1.9 Acceptance tests
1. The per-field report runs on wave 1 and shows accuracy with intervals for every M2 decision field (slice S8).
2. A test proves no code path that tunes floors or prompts reads the `frozen` split.
3. An audit failure added on Monday appears as a golden case in Tuesday's run.

#### 4.1.10 Open questions
1. Who labels: default the catalog team (two people, 20% overlap), Sujan approves the label guide once.
2. Wave 1 size: default 100 products, matching the module map's risk note ("start with 100").

### M7-F2 Vendor interface and fallbacks (P0)

#### 4.2.1 User story
As the operator, I want a batch to finish even when a vendor is down, slow or refuses, so I never babysit a batch
because of someone else's outage.

#### 4.2.2 Functional requirements
- **M7-F2-R1** Every bought or own capability is called through one interface (3.3). No module calls a vendor SDK
  directly. Today's pieces are folded in: the judge back-off and second model (`packages/core/src/catalog/qa/judge.ts`,
  `classify.ts`), the per-category model policy (`qa/policy.ts`, `model_policy`), the matting and upscale clients.
- **M7-F2-R2** Each capability has at least two ranked routes and a final fallback, of different providers where the
  capability is bought. Seed chains:

| Capability | Route 1 | Route 2 | Fallback | If all fail |
|---|---|---|---|---|
| `vision.read` (M2) | Gemini Flash-Lite class via OpenRouter | Claude Haiku class via OpenRouter | OpenAI vision or Qwen3-VL via OpenRouter; transport fallback Gemini direct on Vertex | fields `unknown`, reading degraded, product continues |
| `judge.render` (render QA today) | Gemini Flash-Lite class | Claude Haiku class | third provider | existing triage rules |
| `judge.fidelity` (P1) | two judges of different providers, both must answer | third provider replaces a missing one | none | check unavailable = fail, image not made |
| `image.matte` | own GPU model 1 (`birefnet-general`) | own GPU model 2 | Photoroom Basic (off by default) | slot delivered provisional by M1-F3's rule table (pass-through render), improved later; batch continues |
| `image.upscale` | own GPU SwinIR x2 or x4 | CPU upscaler (admin switch only) | vendor upscale (off by default) | `enlargement_failed`: plain render delivered provisional where the channel minimum allows (M1-F3), else slot empty with a reason |
| `ocr.read`, `people.detect` | own model on worker or GPU | second own model | vision model answer, field set `shadow` | field `unknown` |
| `image.make.reference_edit` (P1) | Gemini image on Vertex | OpenAI image | FLUX, then Photoroom (hosted, brand switch) | slot `not_made` |
| `image.make.tryon`, `model_swap` (P2) | Vertex virtual try-on | FASHN | Photoroom | slot `not_made` |

- **M7-F2-R3** Behaviour per call: retries with back-off on rate limits and server errors (existing delays about 5, 15,
  45 s with jitter, or Retry-After); a circuit breaker per route (opens after 5 failures in 2 minutes, probes again after
  60 s); then the next route. A refusal (moderation) moves to the next route for that item only. A route that returns
  the wrong size or no image counts as a failure.
- **M7-F2-R4** For checks (judges, fidelity, OCR used as a gate), "check unavailable" is never a pass. For checks on
  new pixels (generated images, `judge.fidelity`) it is a fail: the image is not made. For `judge.render` on renders of
  the brand's own photos it means "unchecked": the render is delivered provisional, the check is queued for later, and
  the audit sample is doubled for that batch (M1-F3-R1 `unchecked` row). No output waits for a person either way.
- **M7-F2-R5** Kill-the-primary: an admin switch per capability turns route 1 off. CI runs the full pipeline on a test
  batch with every route 1 off; a monthly drill does it on a real test batch.
- **M7-F2-R6** Every call is recorded with route, cost, seconds and outcome for M6 and the harness. Route ids and model
  names never reach operator text.
- **M7-F2-R7** A route records its licence, data-use terms (written no-training position before any brand photo is
  sent), region and price. A route without a no-training position cannot be `serving` for capabilities that send brand
  photos.

#### 4.2.3 Non-functional
Fallback adds under 2 s when route 1 fails fast; a whole-vendor outage costs at most the circuit-open window per batch;
throughput 2,000 products an hour with the shared rate limits (about 3.9 judge calls a second at that rate, cost report).

#### 4.2.4 Configuration
Route order and state per capability (changed by the harness or an admin, logged with the run that justified it);
circuit thresholds; overflow switches and daily caps.

#### 4.2.5 Inputs and outputs
In: capability, input, context. Out: output, route used, cost, time, refusal or error.

#### 4.2.6 Human-in-the-loop rule
None. Admins may switch a route off at any time; switching one on into `serving` goes through the staged gate (M7-F6).

#### 4.2.7 Edge cases and failure modes
1. OpenRouter itself down: transport fallback to the vendor's own endpoint (Vertex for Gemini).
2. All judges down: renders follow the existing triage (no silent pass); generated images are not made.
3. Lingerie refusals on one vendor: the next route answers; refusal rate per route is a harness metric.
4. A vendor silently changes a model behind the same name: the nightly replay on cached cases detects a score move of
   more than 3 points against the 7-day median and opens an alert.

#### 4.2.8 Buy or build
Build the interface (thin, ours). Routers such as OpenRouter or fal.ai are routes, not the interface, so we can leave
them.

#### 4.2.9 Acceptance tests
1. With `vision.read` route 1 killed, a 50-product test batch completes and every reading names route 2 (slice S8).
2. With the matting GPU stopped, the batch completes on model 2, or delivers the affected slots provisional and improves
   them when the service returns; no product is held.
3. No source file outside the adapters imports a vendor SDK (lint rule).

#### 4.2.10 Open questions
1. Route 3 for `vision.read`: default whichever of OpenAI vision and Qwen3-VL scores better on wave 1.
2. Direct Vertex contracts: default use the existing Google Cloud project billing; no new contract in P0.
3. Operator surface for the kill switch (M7-S2 left it as core functions only; R1 exit item 3). Resolved 2026-11-05:
   the Cloud Run job `catalog-route-switch` (`infra/catalog-route-switch.sh`, logic in
   `apps/worker/src/route-switch.ts`). `set <route id> off|serving "<reason>"` changes one route and writes a
   `vendor_route_changes` row with the reason and the operator's gcloud account; turning off the last serving route
   of a capability needs `--force`. `drill <capability> <minutes> "<reason>" [batch id] [--route=<id>]` turns off
   the route the batch asks first (its pinned policy judge for `judge.render`, the classifier model for
   `vision.read`), prints it and the route serving instead, and restores it when the batch finishes or the minutes
   run out (1 to 360). The drill is recorded on the route (`vendor_routes.drill_id`, `restore_state`, `restore_at`,
   migration 0027): the router reads an expired drill as restored and writes the restore (`drill-expiry` in the
   change log), so a stopped job never leaves the route off past its expiry. Only that drill or its expiry ends it:
   a late job never ends a newer drill, a rank, cap or position change keeps it, a manual state change ends it, and
   an expired drill nobody restored is restored before the next drill starts. A drill is refused while another runs
   on the capability or when no other serving route would be left. `show [capability]` prints the table. Every
   command prints the routes before and after. An admin page stays with M12.

### M7-F3 Audit sampling (P0)

#### 4.3.1 User story
As the program owner, I want a small random check of what went live, so we know the true defect rate without
reviewing every product, and bad cells fix themselves.

#### 4.3.2 Functional requirements
- **M7-F3-R1** The audit runs after links are out; it never holds a product. Sampling is deterministic by hash of
  product id and batch id (reuse `sampledForQa` in `qa/policy.ts`), within 1 point of the set rate over 10,000 ids.
- **M7-F3-R2** A cell is brand x taxonomy department x content kind (render, crop, generated) x channel. The standing
  rate is 3% (inside the settled 2-5%); a new cell starts at 10% for its first 200 items; the floor is 2%.
- **M7-F3-R3** Two parts: a random part (the only one used to estimate defect rates) and a priority part on top
  (M2 `conflict` and `unknown` products, a new route's outputs, items near a check bar), capped at 2% extra.
- **M7-F3-R4** Answers (one tap each): "Good"; "Product looks different (colour, logo, shape)"; "Cut or framed wrong
  (head, product, logo)"; "Not modest, or shows a child"; "Wrong shot or wrong product"; "Background or edges wrong".
  The first five map to product truth, framing, modesty, analyzer and matting causes.
- **M7-F3-R5** On a fail: the item is marked `pulled` and M3 removes or replaces it at the next publish; the case is
  added to the right golden set; the cell's rate goes to 10% until 100 clean answers; two fails of the same cause in a
  cell within 7 days pause that content kind in that cell (crops or generation stop there; brand photos continue) and
  alert the ops page.
- **M7-F3-R6** A cell's defect rate is reported with its interval. A cell may drop to 2% only after 300 clean audited
  items; it never drops below 2%.
- **M7-F3-R7** Audits never expire into a pass. If audits fall more than 7 days behind, the ops page alerts; nothing is
  blocked except opening new generation cells (which need their first 20 audited items).

#### 4.3.3 Non-functional
About 5 s per item; at 2,000 products a batch and 3%, about 60 galleries, roughly 10 minutes of one person's time.

#### 4.3.4 Configuration
Rates (standing, new cell, floor, priority cap), clean counts for drop and return, pause rule. Lowering a rate is a
threshold change (one admin approval); raising it is free.

#### 4.3.5 Inputs and outputs
In: published outputs with their parents. Out: `AuditItem`, `CellState`, `audit.failed`, golden cases.

#### 4.3.6 Human-in-the-loop rule
This is the human loop, permanent at 2-5%: a catalog team member checks product truth, framing, modesty and the
analyzer on a random sample. It shrinks per cell with clean history but never below 2%.

#### 4.3.7 Edge cases and failure modes
1. An auditor answers "Good" too fast (under 1 s): flagged; 10% of each auditor's items are re-shown to a second auditor.
2. A pulled image whose replacement cannot be made: the brand photo set stays; the gap returns to the digest.
3. A holdout treatment image fails audit: pulled like any other; M4 logs it as a treatment change.

#### 4.3.8 Buy or build
Build (nobody samples; vendors review every item or none).

#### 4.3.9 Acceptance tests
1. After a real 200-product batch, the audit screen holds the sampled items; answering "Cut or framed wrong" on a crop
   removes it at the next publish and adds a golden case (slice S8).
2. Sampling over 10,000 synthetic ids lands within 1 point of the set rate.
3. Two head-cut fails in one crop cell pause crops there; brand photos still publish.

#### 4.3.10 Open questions
1. Standing rate: default 3%.
2. Who audits: default the same catalog team member daily, 10-15 minutes.

### M7-F4 Fidelity check (P1)
- **Story:** as the owner, I want every generated image proved to show the same product as the brand photos before it
  goes live, so a bought generator can never change colour, logo, shape or print unseen.
- **Key requirements:** checks per generated image against every input photo of the same view, using a garment mask:
  G1 same garment (picture similarity at least 0.85 same view, 0.70 cross view, both judges yes); G2 logo and text by
  OCR (each string at least 90% similar, logo shape at least 0.70, zero invented strings), G2b logo match against the
  brand's approved logos, G2c brand-word near-miss ("U.S. POLO ASSM." fails); G3 colour (Delta E average at most 3.0,
  each main colour at most 5.0); G4 texture and print (perceptual difference at most 0.35 per 256 px patch, texture
  ratio 0.7 to 1.4); G5 model and scene (same person, skin area at most the reference's plus 2 points, skin colour at
  most 3.0, anatomy); G6 geometry (head margin 5%, 3:4 within 1%, long side at least 90% of the request); G7 a
  reported problem is gone. Composites (still life) prove product pixels unchanged (difference 0). Every judge question
  goes to both judges; a disagreement is a fail; confidence under 0.7 is a fail. Hard blocks no person can override:
  wrong garment, logo changed, text invented, pieces mismatch, model identity, skin exceeds, child person, AI tag
  missing. Bars are starting values, then set from labels on `tuning` and proved on `frozen`. Pay-per-pass contracts
  (Photoroom Guarantee, FASHN) are preferred where offered.
- **Acceptance test:** on GS-E, zero G1, G2 or hard-block false passes, false passes at most 2%, false holds at most
  15%, overall and per cell.
- **Buy or build:** build our own checks (Photoroom's Fidelity Layer is enterprise-only and not per marketplace); buy
  the judges and the measuring models (similarity, perceptual difference, body parsing) with commercial licences.

### M7-F5 Planted-defect tests (P1)
- **Story:** as the owner, I want known defects injected into real products so the checks grade themselves.
- **Key requirements:** deterministic planted cases made from golden photos (extending `evals/golden.ts`): wrong
  garment; moved, altered or invented logo or text; colour shift of Delta E 5 or more; mirrored back; extra or missing
  limbs; more skin than the reference; a person in a kids image; a missing pack piece; a changed embellishment; text in a
  print that tells the judge to answer yes; a missing AI tag; a head cut at the top edge; an undersized output; a brand
  word one letter off; a banned word (from M5); an Arabic and English mismatch (with M8); for scenes, a face, a flag, a
  readable sign, one altered pixel after paste-back. Bar: 100% caught, each by its expected check (caught by another
  check counts and is reported). Run nightly and on every route, prompt or bar change.
- **Acceptance test:** the nightly report shows 100% caught; removing one check makes the run fail.
- **Buy or build:** build.

### M7-F6 Staged gate with automatic promotion (P1)
- **Story:** as the owner, I want any new model, vendor or prompt to be scored and, if it wins, to serve automatically,
  so the system improves itself as the market improves.
- **Key requirements:**
  - Anyone (an admin, or a scheduled scan of vendor model lists) registers a `Candidate` with an adapter config; no code
    change for a new model on an existing adapter.
  - Stage 1 benchmark: the harness scores it on `tuning` and `frozen` for quality, cost per correct answer (or per
    accepted image) and p95 seconds.
  - Promotion rule (automatic): on `frozen`, zero regressions on hard-block metrics (kids, head cut, product truth,
    modesty), no released field worse by more than 1 point, and either better on the capability's main metric (the
    lower end of its 95% interval above the incumbent) or no worse within 1 point and at least 20% cheaper or faster.
  - Stage 2 product test: a full test batch on the test account passes every pipeline check.
  - Stage 3 shadow: on 200 live items over at least 3 days the candidate runs beside the incumbent with no effect on
    output; agreement and cost are compared.
  - Stage 4 canary: 10% of a cell's traffic for 7 days; the audit fail rate must not exceed the incumbent's by more than
    1 point. For routes that change main-image pixels, M4's ad click rate is watched as a guardrail.
  - Stage 5 serving: route rank updated automatically, `route.changed` logged with the runs. Automatic rollback if the
    audit fail rate rises 2 points or any hard-block miss is found.
  - The only human step: a promotion that needs a threshold or bar change waits for one admin approval.
  - Order of work (Harvey): swap a model where a cheaper one passes, then route per field and category (the cheapest
    route that clears each field's bar), then consider training only if a gap remains.
  - Overfitting guard: `frozen` is never tuned on; live audit and M4 signals are the final judges.
- **Acceptance test:** register a second vision model as a candidate; with no engineer, it is benchmarked, shadowed,
  canaried and promoted (or rejected with the reason) within a week; a forced regression rolls back automatically.
- **Buy or build:** build (seed: `eval/policy-writer.ts` already writes bake-off winners into `model_policy`).

### M7-F7 Vendor bake-offs (P1)
- **Story:** as the owner, I want each bought capability scored against two or more vendors before it serves.
- **Key requirements:** the harness runs every candidate for a capability on the same sets; the report adds per-vendor
  first-attempt pass rate, refusals, output size compliance (3 of 3 at the requested size; one engine returned 896x1200
  on a 2K request), USD per accepted output, seconds per output, licence and no-training terms (I013 licence check
  included). Generation candidates seeded: Gemini image, Vertex try-on, FASHN, OpenAI image, FLUX, Photoroom; analysis
  candidates add Vue.ai, Rubick and Streamoid after their demos.
- **Acceptance test:** each P1 capability has a scored decision on file before its first live call.
- **Buy or build:** build (vendors self-report).

### M7-F8 Blocking human calls (P1)
- **Story:** as the owner, I want a person to decide only modesty, kids and likeness rights, everything else automatic.
- **Key requirements:** the decisions that stop and wait for a person are few and mostly per brand, not per item: a
  brand's rights row for likeness and model photos; approval of a brand's kids model; turning on "intimates on model"
  or "kids on model" for a brand; and a per-brand modesty profile. Per item, an uncertain modesty or kids result is
  never sent to a person: the image is simply not made and the brand set stays. Target under 1 blocking call per
  1,000 products after the first month.
- **Acceptance test:** a month of batches shows only brand-level calls on the calls list and zero per-product cards.
- **Buy or build:** build.

### M7-F9 Bilingual consistency check (P1)
- **Story:** as the owner, I want English and Arabic versions of a listing to state the same facts.
- **Key requirements:** extract facts (colour, material, size, count, claims) from both texts with a text model and
  compare; any mismatch blocks that text from publishing and triggers a rewrite in M8; planted mismatches in M7-F5.
- **Acceptance test:** 100% of planted Arabic and English mismatches caught; zero mismatches reach Noon in the audit.
- **Buy or build:** build the check, buy the text model (M8 routes).

## 5. Operator experience
- **Operator:** sees nothing of M7 except that batches finish. A degraded vendor shows one digest line: "One photo
  service was slow today; we used the backup. Nothing for you to do."
- **Auditor screen ("Today's check"):** one item at a time: the published image large, its source photo beside it,
  the channel name, and the six answers as buttons with number keys. Header copy: "18 images to check today, about 2
  minutes." After a fail: "Thanks. It will be replaced at the next upload, and we will check more like it."
- **Admin ("Quality" page):** per capability: the serving route as "engine 1" or "engine 2", its last scores, cost and
  speed, candidates in progress with their stage, and route history; per cell: audit rate, fail rate with interval,
  state (new, standing, paused). Every automatic change shows "changed by the quality gate on <date>, because <run>".
- **Labelling screen (one-off):** the existing eval page with the R2 fields as one-tap choices and the pre-label shown
  (except on the blind subset).

## 6. Measurement

| Metric | Baseline | Target | Source |
|---|---|---|---|
| Golden label coverage | 0 labelled products (300-row sample drawn) | wave 1: 100 products in week one; 300 by week four | `GoldenCase` |
| Label agreement (alpha) per field | none | at least 0.67 | 20% overlap |
| Batches completed with every route 1 killed | never tested | 100% in CI and the monthly drill | harness and M6 |
| Audit fail rate per cell (random part) | unknown | crops under 1%; renders under 2%; generated under 2% with zero hard blocks | `AuditItem` |
| Product-truth defects reaching channels per 1,000 images | unknown | 0 on hard blocks | audit plus M9 rejections |
| Planted defects caught (P1) | none | 100% | nightly run |
| False passes and false holds on generated images (P1) | none | at most 2% and at most 15% | GS-E |
| Time to promote a better route (P1) | weeks of engineer work | under 7 days, no engineer | `route.changed` |
| Cost per correct analyzer answer | not measured | falls quarter on quarter | `HarnessRun` |

## 7. Build slices

| # | Slice | Depends on | Acceptance test |
|---|---|---|---|
| M7-S1 | Golden set v1: fetch photos for the 300 rows (Supabase, then Trendyol), labelling screen fields, wave 1 of 100, frozen split | M2-S1 taxonomy | 100 products labelled with 20% overlap; split test passes |
| M7-S2 | Vendor interface, route table, circuit breaker, kill switch; fold in judge, classifier, matting and upscale clients | none | 4.2.9 tests 1 and 3 |
| M7-S3 | Scoring runner (`catalog-eval score`): per field accuracy, calibration, coverage, cost, latency, intervals | M7-S1, M7-S2 | 4.1.9 test 1 |
| M7-S4 | Audit sampler, auditor screen, pull-on-fail, cell states, relapse | M0-S1, M3-S3 | 4.3.9 tests 1 to 3 |
| M7-S5 (P1) | Staged gate and automatic promotion, rollback | M7-S3, M7-S4 | M7-F6 acceptance test |
| M7-S6 (P1) | Fidelity checks G1-G7 and measuring services | M7-S2, GS-E | M7-F4 acceptance test |
| M7-S7 (P1) | Planted-defect generator and nightly run | M7-S6 | M7-F5 acceptance test |
| M7-S8 (P1) | Bake-off report fields, licence and terms checks | M7-S5 | M7-F7 acceptance test |
| M7-S9 (P1) | Blocking calls list (brand-level) and bilingual check | M12 brand DNA, M8 | M7-F8 and F9 tests |

## 8. Risks and open questions

| Risk | Effect | Mitigation |
|---|---|---|
| Labelling slips | M2 fields stay `shadow`; slice S8 late | Wave 1 of 100; model pre-labels; a labelling vendor if wave 2 slips a week |
| Pre-labels anchor labellers | Inflated accuracy | 30-product blind subset; compare blind and assisted accuracy |
| Overfitting to our own set | Offline wins that do not hold live | Frozen split, growth from live failures, canary on audit, M4 guardrail |
| Auditors rubber-stamp | Defect rate looks better than it is | Speed flag; 10% re-shown to a second auditor; planted items inside the audit (P1) |
| Judges share blind spots | Both pass a bad image | Two providers; measured checks (similarity, OCR, Delta E, skin area) are never left to judges alone |
| Vendor changes a model silently | Quality drifts | Nightly replay with drift alert; route version pinned where the vendor allows |
| Automatic promotion moves cost up | Budget surprise | Promotion rule includes cost; M6 daily cap applies to every route |
| Eval spend | Unplanned cost | `EVAL_BUDGET_USD` per run; cached replays nightly; live runs only on change |

Open questions are listed per feature, each with a default.

## 9. Integration decisions (2026-11-02)

| # | Decision | Why |
|---|---|---|
| D1 | "All routes failed" never holds an output: renders of brand photos are delivered provisional (M1-F3); only new pixels fail closed (F2 table, F2-R4) | M7's "output held" and "check unavailable = fail" contradicted M1-F3-R1 and gate 1 |
| D2 | The `pulled` mark lives in M7; removal reaches M0 as a `removed` event | M0 does not hold module states |
| D3 | M7 owns the route table for every capability, including the ranking M12's Services page edits; M6 only meters cost | M12 wrote rankings to M6; M11 named "the M6 vendor interface" |
| D4 | One audit rule everywhere: standing 3%, new cell 10% for 200 items, relapse to 10% until 100 clean answers, floor 2%. M8's "audit 20%" relapse is replaced by this rule | M8-F1 used 20%, M7 used 10% |
| D5 | The text auditor view of M8 is a mode of the M7 auditor screen ("Today's check"), not a second screen | Both modules specified an auditor screen |
| D6 | "One admin approval" means the owner role until M12 roles exist | Same rule in M2, M5, M7, M12 |
| D7 | Open questions answered: route 3 for `vision.read` is whichever of OpenAI vision and Qwen3-VL scores better on wave 1; Vertex calls use the existing project billing, no new contract in P0; standing audit rate 3% | Technical defaults |
| D8 | Kept for the owner: who labels and audits (people), the bake-off budget and no-training terms before any paid generation call (`../owner-questions.md`) | People and money |
| D9 | Owner decision (Sujan, 2026-11-03): OpenRouter's provider data policy is the written no-training position (M7-F2-R7) for the OpenRouter `judge.render` and `vision.read` routes, so they are seeded `serving`. Recorded as data in each route's no-training terms: "OpenRouter provider data policy (https://openrouter.ai/docs/guides/privacy/data-collection); owner decision 2026-11-03". Routes from other vendors still need their own position | OpenRouter does not route to providers that train on or log prompts unless the account opts in ([data collection](https://openrouter.ai/docs/guides/privacy/data-collection), [provider logging](https://openrouter.ai/docs/guides/privacy/provider-logging)); the code check of R7 stays |
