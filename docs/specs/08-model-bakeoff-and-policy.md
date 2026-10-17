# 08 Model bake-off and policy

Catalog module, spec 08 of 09. Execute with `docs/specs/00-execution-protocol.md`. Source of
truth: `docs/SPEC.md` (sections "Models, bake-off and automatic model policy", "Testing and
guardrails", "Brand master and Opptra SKU id mapping"). Depends on 05 (the CPU and GPU matting
services with the rembg built-ins baked in, per-model send size, shadow rule), 06 (pipeline,
`is_test` batches, publish stage) and 07 (QA judge, attention screen, eval-mode labelling,
`resolvePolicy`, the first default policy rows). Branch `feat/catalog-08-model-bakeoff-and-policy`.
Deploys the Cloud Run job `catalog-eval` and the rebuilt matting images.

A "bake-off" is a side-by-side trial: every candidate model runs on the same images, and the
results are measured against human labels so the best candidate per brand and product type can be
chosen by numbers, not by taste.

Contracts from earlier specs used here, not redefined:
- `model_policy` (including `matte_target` enum `cpu | gpu`), `catalog_eval_labels`,
  `catalog_eval_judgements` tables; `ResolvedPolicy`, `POLICY_SOURCES` (`bakeoff | default |
  pending | manual`), `QA_MODES` (`per_source | per_output`), `EVAL_LABELS` (`pass | flag`),
  `ProductType`, `BatchCounts.policyFallback`, the output flags `transparent`, `upscaled`,
  `shadow_synthesised` (defined in 02; no migration ships here).
- `BigQueryLike`, `MASTER_SL_SQL` (02 master sync); `safeFetch` (02); `assertTestPrefix`,
  `deleteTestObjects` (02).
- `catalog-local` manifests (defined in 04).
- `MattingClient.health()`, the two services `catalog-matting` (CPU, asia-south1) and
  `catalog-matting-gpu` (one L4, asia-southeast1, optional), `/health` listing
  `models: [{ id, inputSize: number | "native", target: "cpu" | "gpu" }]` and `default`, the
  worker's rule "send a model to the service that lists it, preferring gpu", `MATTING_URL`,
  `MATTING_GPU_URL`, `MATTE_MODELS`, the session registry in `services/matting/app.py`, the shadow
  decision rule (defined in 05).
- `is_test` batches and the publish stage (defined in 06).
- `judgeOutput`, `resolvePolicy`, eval-mode labelling through the attention screen,
  `QA_DEFAULT_THRESHOLD = 75`, `QA_DEFAULT_FLOOR = 60`, `CATALOG_QA_DEFAULT_MODEL`
  (`google/gemini-2.5-flash-lite`), the `source = "default"` policy rows per product type
  (defined in 07, table restated in section 4.6 here).

## 1. Goal

Prove which cut-out model (the "matte" model, which separates the product from its background) and
which QA judge (the vision model that checks an output) work best for each brand and product
category on real images, write the result into `model_policy`, and have every new batch apply it
automatically. The operator never chooses or sees a model.

Gates, per category: auto-pass precision at least 97% (of the outputs the judge passed, at least
97 in 100 are ones a human also passed) and flag recall at least 90% (of the outputs a human
flagged, the judge also flagged at least 90 in 100). Cost per style+colour is reported next to the
agency reference of INR 60.

## 2. Scope

In scope
- Golden set assembly for every brand from the sources in section 4.2, with a manifest and hard
  cases; human labels through 07's eval mode on the attention screen.
- `catalog-eval` CLI: `assemble`, `run`, `judges`, `experiment`, `contact-sheet`, `labels export`,
  `score`, `policy write`, `report`.
- The custom matting candidates that rembg does not ship as built-ins (workstream W0), added to
  the matting image as sessions: `birefnet-hr-matting`, `birefnet-dynamic-matting`, `birefnet-hr`,
  `ben2-base`, `inspyrenet-base`, `rmbg-1.4`. Candidates with a 2048 px input run on
  `catalog-matting-gpu` only.
- The matting bake-off (section 4.4): seven primary candidates on every golden set, three
  secondary candidates on the hard-cases set and one apparel set, two refinement experiments on
  hard cases only, and the `sr_pass` upscaler experiment. If a candidate cannot be exported or
  loaded, the report says so and the bake-off runs on the rest; a candidate is never dropped
  silently.
- The judge bake-off over the six judge candidates in section 4.5, with two optional extra judges
  at the end if none meets the gates.
- `model_policy` rows per (brand, category) with `matte_target`, applied at batch start by 07's
  `resolvePolicy`; re-evaluation triggers.
- Licence registry per model in `services/matting/README.md` and in the bake-off report (section
  4.10; a record, not a decision input: the owner has closed the licence question).
- Cloud Run job `catalog-eval` to run the CLI where the OpenRouter secret and Cloud SQL are
  reachable.
- The rule and its test: no model name reaches the operator.

Out of scope
- Generative edits of product pixels (SUPIR, SeedVR2, IC-Light on the foreground) and paid image
  APIs: the plan rules them out because product pixels must not change. Photoroom stays a noted
  fallback only (no HEIC on its editing API, 5,000 px and 30 MB caps, no batch endpoint, JPEG
  quality 80; its `x-uncertainty-score` would be a useful attention signal).
- Changing the judge prompt or its scoring dimensions beyond the one added question for
  `sr_pass` (07 owns the prompt; findings go to the report).
- Any UI beyond what 07 built. Eval labelling reuses the attention screen in eval mode.
- More GPU capacity than the three L4s of `catalog-matting-gpu` (05); 09 notes any quota request.

## 3. Files

Add
- `packages/core/src/catalog/eval/manifest.ts` manifest types, read and write.
- `packages/core/src/catalog/eval/assemble.ts` source collection for the golden set.
- `packages/core/src/catalog/eval/run.ts` creates eval batches with a forced policy.
- `packages/core/src/catalog/eval/judges.ts` runs every judge on a run's outputs.
- `packages/core/src/catalog/eval/experiments.ts` the `sr_pass`, `trimap` and `box_prompt`
  experiments as extra passes over a run's staged cut-outs.
- `packages/core/src/catalog/eval/score.ts` metrics, gates, winner selection (pure functions).
- `packages/core/src/catalog/eval/policy-writer.ts` `model_policy` upsert.
- `packages/core/src/catalog/eval/report.ts` HTML and JSON report, contact sheets, licence table.
- `packages/core/src/catalog/eval/*.test.ts`.
- `apps/worker/src/catalog-eval.ts` the CLI entry, an esbuild entry in `apps/worker/build.mjs`
  like `catalog-local` (04); root `package.json` script `catalog:eval` runs
  `node apps/worker/dist/catalog-eval.js`; the Cloud Run job runs the same file.
- `services/matting/sessions/birefnet_custom.py` (`birefnet-hr-matting`,
  `birefnet-dynamic-matting`, `birefnet-hr` from our ONNX exports),
  `services/matting/sessions/ben2.py` (rembg's `ben_custom` session with our ONNX export passed by
  `model_path`), `services/matting/sessions/inspyrenet.py` (the `transparent-background` package),
  `services/matting/sessions/rmbg14.py`; `services/matting/Dockerfile` bakes the ONNX files into
  both targets; `services/matting/README.md` records, per model, where the export came from, how it
  was produced, its `inputSize`, its `target` and its licence.
- `apps/web/test/no-model-names.test.ts` (section 4.8).
- `docs/eval/README.md` how to run a bake-off and read the report (short).
No schema change: `catalog_eval_judgements`, `catalog_eval_labels` and `model_policy` (with
`matte_target`) are in 02's migration `0000_init.sql`.

Change
- `packages/core/src/catalog/qa/policy.ts` (07): pending-row creation on fallback (section 4.7).
- `apps/worker/src/catalog/finalize.ts` (06): the `counts.policyFallback` sentence in the report
  and on the Details tab.
- `services/matting/app.py` (05): load the custom sessions when their ids are in `MATTE_MODELS`;
  every `remove()` call passes an explicit `session=` (05's rule; rembg's own default is
  `bria-rmbg`, which must never be relied on).
- `infra/deploy.sh`: deploy the `catalog-eval` job (image `${AR}/worker:${TAG}`, command
  `node dist/catalog-eval.js`, same secrets, service account `catalog-worker@` and VPC flags as
  `catalog-migrate`, `--task-timeout=3600`, env `MATTING_URL` and `MATTING_GPU_URL`).
- `infra/bootstrap.sh`: nothing new unless an IAM binding is missing for the job (same service
  account as the worker).

## 4. Contracts

### 4.1 Golden set layout (`eval/` prefix of the private bucket `gs://image-links-agent-assets`)

```
eval/<set>/manifest.json
eval/<set>/sources/<brandSlug>/<identifier>_<n>.<ext>
eval/<set>/labels/labels-<runId>.csv            exported from catalog_eval_labels
eval/<set>/reports/bakeoff-<runId>.html|json    section 4.6
eval/<set>/reports/contact-<batchId>.html
eval/<set>/reports/experiment-<name>-<batchId>.html
```

Sets: one per brand, named by brand slug (`uspa`, `french-connection`, `anta`, ...), plus
`hard-cases`. Category is per product (02's `ProductType` without `auto`: `footwear |
apparel_model | apparel_flat | bag_accessory | other`), set by 07's classifier at run time and
overridable in the manifest (`category_override`) by the human.

Golden set objects under `eval/` are never deleted (they are not under `catalog-test/`, and
`deleteTestObjects` refuses them through `assertTestPrefix`). Eval batches are test batches: they
run with `is_test = true`, so their products live in the `is_test` namespace, their public outputs
land under `catalog-test/` in the public bucket and their staging and raw objects under
`catalog-test/` in the private bucket. They never collide with real products and are cleaned by
the CLI.

Manifest entry:
```
{ identifier, n, brand, category_override?,
  source: { kind: "supabase_sheet" | "local_folder" | "master_image_url" | "operator_set" | "hard_case", ref },
  sha256, width, height, mime, hard_case_tags: string[] }
```
Hard-case tags (from the plan): `white_on_white`, `dark_shadow`, `mesh`, `transparent_png`,
`px500`, `heic`, `collage`, `watermark`, `mixed_product`.

### 4.2 Sources (CONTRACTS section 15 real data sets; read only at the source)

- Supabase public links from `C:\Users\Sujan AH\Desktop\opptra-image-links\new_resources_3\*.xlsx`
  and `new_resources_4\*.xlsx`: Anta, Campus, ONLY, Cardio Bunny, Keds, USPA, Vero Moda, French
  Connection, Penti. Downloaded with 02's `safeFetch` (the SSRF-safe fetch with its size cap),
  copied to `eval/`. Supabase is only ever read.
- Local: `C:\Users\Sujan AH\Desktop\opptra-image-links\new_resources_3\French Connection Final`
  (3,280 apparel images on white, 800x1200) and `new_resources_4\Images` (630 Anta footwear images,
  800x800, pure white). For these two large sets `assemble` takes a seeded random sample
  (`--sample <n> --seed <k>`, both recorded in the manifest) so the human labelling load is decided
  by the human, not the tool; every other source is taken whole.
- The operator's USPA footwear sets: the Styli-rejected and the accepted versions, tagged
  `operator_set` with `ref` = `rejected` or `accepted`, when provided. The two ids re-requested in
  high resolution (7055653305 and 7055653602) are included when received.
- Softline brands without a delivery sheet (Nautica, Puma, and any other `master_sl` brand): the
  `image_url` column of `raw_gcc_dimensions.master_sl` through 02's `BigQueryLike.query({ query,
  location, params })` (the same client and call shape `master-sync.ts` uses), one URL per option.
- Hardline brands (Bergner, Carote, Nutricook, NutriBullet, GTPlayer, Tower, Dowinx, Qubo, Nuwey)
  and brands with no images yet (BHPC, Samsco): the manifest records `no_sources_yet`; the report
  lists them under "Brands waiting for sample images"; their batches use the category default
  (section 4.7) until images arrive.
- Hard cases: assembled from the above by tag (white garments on white, dark shadows under
  footwear, mesh uppers, any transparent PNG, any source under 500 px, one HEIC, one collage, one
  watermarked image, one mixed-product set), each confirmed by a human when tagging.

### 4.3 CLI

`pnpm catalog:eval <command>` = `node apps/worker/dist/catalog-eval.js <command>`. Runs as the
Cloud Run job or locally with Docker.

| Command | Does |
|---|---|
| `assemble --set <s> [--sheets <glob>] [--folder <path>] [--master <brand>] [--sample <n> --seed <k>]` | Builds or extends `eval/<s>/` and the manifest. Idempotent on sha256. Prints counts per brand and tag. |
| `run --set <s> --matte <model> --channels <list> [--qa-model <model>] [--qa-mode per_output]` | Creates an eval batch (`is_test = true`, `options.evalSet = s`, `options.policy` forced to the given models with `source = "manual"`, `qaMode` `per_output`, threshold and floor at 07's defaults 75 and 60, `matteTarget` from the service that lists the model) and enqueues it through the normal pipeline on the deployed worker, including the publish stage under `catalog-test/`. One run per matting candidate. Refuses with "not run: no GPU service" when the model is listed only by the GPU service and `MATTING_GPU_URL` is unset. Prints the batch id. |
| `judges --batch <id> --models <a,b,...>` | For every output of the batch, calls each judge (07 `judgeOutput`) and stores a row in `catalog_eval_judgements` (unique per output and judge model). Estimates cost first from each model's price in the OpenRouter endpoint listing (never one constant) times calls and refuses above `EVAL_BUDGET_USD`. Resumable: skips existing rows. |
| `experiment --name sr_pass\|trimap\|box_prompt --batch <id> [--tags <list>]` | Runs the named refinement pass (section 4.4) over the staged cut-outs of the batch, re-composites and re-judges the affected outputs into a side table, writes `experiment-<name>-<batchId>.html`. `sr_pass` refuses without `MATTING_GPU_URL`. |
| `contact-sheet --batch <id>` | HTML with, per output: original, output, every judge's verdict and the human label if any; grouped by identifier; written to `eval/<s>/reports/contact-<batchId>.html`; prints a signed URL. |
| `labels export --set <s>` | Writes `catalog_eval_labels` for the set's batches to `eval/<s>/labels/labels-<runId>.csv`. |
| `score --set <s> --batches <ids> [--live]` | Computes section 4.5 and prints the tables. `--live` adds the false-flag drift view from section 4.7. |
| `policy write --set <s> --batches <ids> [--dry-run]` | Upserts `model_policy` from the winners (section 4.6). `--dry-run` prints the rows. |
| `report --set <s> --batches <ids>` | Writes `bakeoff-<runId>.html` and `.json` (section 4.6). |

Live judge calls happen only in `judges` and `experiment`, gated like the smoke test
(`LIVE_SMOKE=1` must be set, the same rule as `CLAUDE.md`) and run as the Cloud Run job:
`gcloud run jobs execute catalog-eval --region=asia-south1 --args="judges,--batch,<id>,--models,<list>"`.
`pnpm test` never calls OpenRouter.

### 4.4 Matting candidates and experiments

Primary (every golden set): `birefnet-general`, `birefnet-general-lite`, `bria-rmbg` (RMBG-2.0,
rembg built-in), `birefnet-hr-matting` (BiRefNet_HR-matting, 2048 px, custom ONNX),
`birefnet-dynamic-matting` (BiRefNet_dynamic-matting, native resolution rounded to a multiple of
32), `ben2-base` (BEN2 base through rembg's `ben_custom` session with our ONNX export by
`model_path`; `ben2-base` is our id, there is no rembg built-in of that name), `inspyrenet-base`
(InSPyReNet base through the `transparent-background` package).

Secondary (hard-cases set and one apparel set): `birefnet-hr` (BiRefNet_HR general, 2048 px),
`birefnet-hrsod`, `rmbg-1.4` (RMBG-1.4, the fast CPU floor).

Refinement experiments (hard cases only, through `experiment`):
- `trimap`: ViTMatte-small trimap refinement; the trimap is the winner's mask eroded and dilated
  8 to 16 px at 1536 px; measured by the human edge-flag rate against the unrefined winner.
- `box_prompt`: SAM 2.1 with a box prompt for the `mixed_product` and `collage` tags; the box
  comes from the winner mask's largest connected component or from the judge; measured by
  `different_product` recall.
- `sr_pass`: upscaler on the RGBA cut-out before compositing, GPU only. Real-ESRGAN x2plus first,
  then x4plus, then SwinIR-L real-world x4, each downscaled with Lanczos to the exact factor
  needed. Outputs carry flag `upscaled` (attention required) and are judged with the added
  question "are logos, text and fabric texture unchanged from the original". The owner decides per
  channel from the contact sheet. The default path keeps Lanczos only and `MAX_UPSCALE = 1.5` for
  every channel. Closed by the owner: Styli's rejections of the earlier set carry no information on
  size versus softness; the rule is simply to follow the Styli guideline sheet (`channels.ts`), so
  there is no Styli-only `MAX_UPSCALE` and nothing to ask the operator. The experiment stays
  optional: it runs when `MATTING_GPU_URL` is set and is skipped with "not run" otherwise.
- Low priority, only if time allows after the above: a depth map (Depth Anything V2 Small or
  DA3-SMALL, both Apache-2.0) to shape the synthesised contact shadow; IC-Light applied to the
  shadow layer alone with a colour-delta guard on the product pixels. Neither touches the default
  path.

Dropped, with reasons: MODNet and MatteFormer (superseded by the BiRefNet family), SAM 3 (SAM
License terms, see section 4.10), IC-Light V2 (no downloadable weights), SUPIR and SeedVR2
(generative restorers; product pixels must not change), 4x-UltraSharp (no advantage over
Real-ESRGAN or SwinIR; its licence is not the reason, see section 4.10).

Where each candidate runs: the CPU service `catalog-matting` lists the rembg built-ins
(`MATTE_MODELS` default `birefnet-general,birefnet-general-lite,birefnet-hrsod,bria-rmbg`) plus
the 1024 px and native custom sessions; `catalog-matting-gpu` lists everything including the 2048
px candidates (`birefnet-hr-matting`, `birefnet-hr`). The worker picks the service by id,
preferring gpu. When `MATTING_GPU_URL` is unset the 2048 px candidates are reported "not run: no
GPU service" and the bake-off continues on the rest.

Expected runtime and cost (from the plan's review, measured in tier 3): on CPU, 4 to 8 s per image
for `birefnet-general-lite` and 10 to 20 s for `birefnet-general`; for the plan's 24,000 sources
that is about USD 23 (lite at 6 s, 40 instance-hours) to USD 58 (general at 15 s);
`birefnet-hr-matting` at 2048 px on CPU would take about 400 hours and USD 230, far past the 2-hour
target. On one L4, `birefnet-general` at about 0.4 s takes about 2.7 hours and USD 3;
`birefnet-hr-matting` at about 1.6 s takes about 11 hours and USD 13. Throughput: 20 CPU instances
at 6 s give 12,000 images per hour (4,800 at 15 s); one L4 at 0.4 s gives 9,000 per hour, three
give 27,000. The report shows `matte_ms` on both services as two columns.

### 4.5 Judges, metrics and gates (`score.ts`, pure functions over rows)

Judge candidates: `google/gemini-2.5-flash-lite`, `google/gemini-2.5-flash`,
`google/gemini-3.5-flash-lite`, `qwen/qwen3-vl-30b-a3b-instruct`, `qwen/qwen3-vl-8b-instruct`,
`anthropic/claude-haiku-5.5`. Optional at the end, only if none meets both gates:
`google/gemini-3-flash-preview`, `openai/gpt-5.4-mini`. Dropped: `qwen/qwen3-vl-32b-instruct` (no
OpenRouter provider). Cost per check is about USD 0.0004 (Flash-Lite, Haiku 5.5, Qwen 30B-A3B) to
0.0013 (2.5 Flash, 3.5 Flash-Lite); `EVAL_BUDGET_USD` estimates use each model's price from the
OpenRouter endpoint listing. The product-type classifier (07) uses the same cheapest judge.
Self-hosting a judge is not worth it (break-even only above 2,000 checks per hour sustained).

Inputs: outputs with compliance results and `matte_ms` per matte model and target;
`catalog_eval_judgements` (output, judge model, scores, verdict, cost, ms); `catalog_eval_labels`
(output, label, reasons). An output has a human label when at least one label exists; the latest
label per labeler wins and disagreements between labelers are listed, not averaged.

Per (brand, category) and per judge:
- auto-pass precision = outputs the judge passed and the human also passed, divided by outputs
  the judge passed. Gate: >= 97%.
- flag recall = outputs the human flagged and the judge also flagged, divided by outputs the human
  flagged. Gate: >= 90%.
- `n_labelled`, `n_passed_by_judge`, `n_flagged_by_human` are printed next to every rate; a gate
  is reported `met`, `not_met`, or `no_labels` when `n_flagged_by_human` or `n_passed_by_judge` is
  zero. The report never hides a small `n`.
- cost per check (mean `cost_usd`) and ms per check.

Per matte model, target and (brand, category):
- compliance pass rate (must be 100%; anything else is a 05 bug, reported as such);
- human edge flags = labels with reason `Edge` or `Background`, divided by labelled outputs;
- judge edge agreement = mean `edge_quality` and `background_clean` from the chosen judge;
- ms per image (from `matte_ms`) per target, and the implied hours and USD for the plan's 24,000
  sources on CPU and on L4.

Threshold sweep: for each judge the harness evaluates every integer threshold from 60 (the floor)
to 100 with the floor fixed at 60, and records the lowest threshold that meets both gates; 75 is
kept when it qualifies.

### 4.6 Winner selection, `model_policy`, report

Per (brand, category):
- matte model = fewest human edge flags; tie broken by fewer judge edge disagreements, then by
  lower ms per image on the target that will serve it. A 2048 px winner is recorded with
  `matte_target = "gpu"`; a 1024 px or native winner with the target that measured faster.
- QA model = the judge meeting both gates at the default threshold 75; among several, the lowest
  cost per check; if none meets both at 75, the judge meeting both at the lowest swept threshold;
  if none meets both at any threshold, the judge with the highest recall at precision >= 97%,
  `qaMode = per_output`, and `gates.met = false` so the report and the next re-evaluation show it.
- `qaSampleRate` stays 1 in this spec. A later lower rate for a pair requires `gates.met = true`
  and a human approval recorded in the report.

`model_policy` columns are exactly 02's: `id`, `brand_slug` (slug or `*`), `category` (type or
`*`), `matte_model`, `matte_target`, `qa_model`, `threshold`, `floor`, `qa_mode`, `qa_sample_rate`,
`source` (`bakeoff | default | pending | manual`), `eval_batch_ids`, `gates` (`{precision, recall,
n_labelled, met}`), `created_at`, `updated_at`; unique (`brand_slug`, `category`).

Before the bake-off, 07 has written the first default rows (`brand_slug = "*"`, one per product
type, `source = "default"`), restated here so this spec's writers know what they overwrite:

| Product type | Matte (first) | Matte (second) | Send size | Shadow (05 rule) | Judge |
|---|---|---|---|---|---|
| footwear | `birefnet-general` | `bria-rmbg` | 1024 | preserve if uniform background and a shadow band under the bbox; else synthesise a soft contact shadow (upright); never where the channel forbids shadows | `google/gemini-2.5-flash-lite`, second `anthropic/claude-haiku-5.5` |
| apparel_model | `birefnet-hr-matting` (2048) | `birefnet-dynamic-matting` | 2048 or native | preserve only; never synthesise | same |
| apparel_flat | `bria-rmbg` | `birefnet-general` | 1024 | preserve if present; never synthesise | same |
| bag_accessory | `birefnet-general` | `birefnet-hr-matting` | 1024 (2048 for the second) | preserve else synthesise (upright) | same |
| other (hardline) | `bria-rmbg` | `birefnet-dynamic-matting` | 1024 or native | preserve else synthesise (upright); glass and transparent packaging routed to `birefnet-hr-matting` with flag `transparent` for attention | same |

`policy write` upserts: every (brand, category) with labels gets `source = "bakeoff"`; (`*`,
category) from all brands' rows pooled per category, replacing the `default` row for that type;
(`*`, `*`) from everything pooled. Rows with `source = "manual"` are never overwritten. A `pending`
row (section 4.7) is replaced by the bake-off row for its pair. The second-choice matte model is
not stored in `model_policy`; it is the next row in the report's ranking and is what the manager
switches to by hand if the first fails in production.

Report (`bakeoff-<runId>.html`, one page, plain tables, thumbnails only in the contact sheets):
candidates with their licence (section 4.10 table), target and `inputSize`; per (brand, category)
tables of precision, recall, n, cost, ms; matte table with CPU and L4 columns; experiment results;
chosen policy rows; brands waiting for images; candidates not run and why; labeler disagreements;
cost per style+colour for the eval runs (QA plus compute in USD and in INR when `INR_PER_USD` is
set) next to "agency reference INR 60 per style+colour"; the exact commands used. The per-style
denominator is products processed: `unchanged` products cost nothing and are excluded (the rule
from 06's cost reporting). The JSON twin carries the same data for 09.

### 4.7 Automatic application and re-evaluation

- Batch start (07 `resolvePolicy`) looks up (brand, category) -> (brand, `*`) -> (`*`, category)
  -> (`*`, `*`) -> code defaults. When the exact (brand, category) row is missing, the worker
  inserts a `model_policy` row with `source = "pending"` and the values it fell back to, sets
  `counts.policyFallback = true`, and the batch report and the Details tab show "This brand and
  product type have not been through the full model check yet; the general setting was used.
  Results are still verified image by image." No model name.
- The manager's post-deploy report and `catalog:eval score` list every `pending` row as a
  re-evaluation item: assemble sources for that brand, label, run, write policy.
- Attention decisions are live labels: "Use as is" on an output the judge flagged is a false
  flag. `catalog:eval score --live` reports, per (brand, category), the false-flag rate from
  `catalog_outputs.decision = "use_as_is"` on judge-flagged outputs and the judged count since the
  policy row was written, so drift is visible without a new golden set.
- A new id in either service's `/health` (read through `MattingClient.health()`), a target change
  for an id, or a changed judge list in `CATALOG_QA_CANDIDATES` is a re-evaluation trigger:
  `score` prints "candidates changed since the policy row was written" with the row's `updated_at`.

### 4.8 The operator never sees a model name

- Model ids appear only in: `model_policy`, `catalog_batches.options.policy`,
  `catalog_source_images.matte_model`, `catalog_outputs.qa_model`,
  `catalog_eval_judgements.judge_model` (the database columns 02 names), worker and matting logs,
  `services/matting/README.md`, and files under `eval/<set>/reports/`.
- Test `apps/web/test/no-model-names.test.ts` renders every catalog page (batch list, wizard, batch
  page with all four tabs, product page, brand page, People modal) and every API route under
  `/api/catalog` with a fixture batch whose policy holds every candidate id, generates the xlsx,
  csv, filled product list and `report.json` exports for it, and asserts that none of the ids, nor
  the substrings `birefnet`, `ben2`, `ben_custom`, `rmbg`, `bria`, `inspyre`, `esrgan`, `swinir`,
  `gemini`, `qwen`, `claude`, `openrouter`, `onnx`, appears in any HTML, JSON, toast text, xlsx
  cell, csv cell or `report.json` field. `sam` is not in the list (it is an ordinary substring).
- Attention cards and the Details tab use the sentences from 07 (including the `transparent` and
  `upscaled` sentences); the sentence in section 4.7 is the only text about policy the operator
  reads. The hand-over note (09) names no model.

### 4.9 Env vars

| Name | Default | Used by |
|---|---|---|
| `EVAL_BUDGET_USD` | none; required by `judges` and `experiment`, set per run | eval job |
| `CATALOG_QA_CANDIDATES` | `google/gemini-2.5-flash-lite,google/gemini-2.5-flash,google/gemini-3.5-flash-lite,qwen/qwen3-vl-30b-a3b-instruct,qwen/qwen3-vl-8b-instruct,anthropic/claude-haiku-5.5` | eval job, `score` |
| `LIVE_SMOKE` | unset; `1` gates live judge calls, as for the smoke test | eval job |
| `MATTING_GPU_URL` | unset (05); when unset, GPU-only candidates and `sr_pass` are "not run" | eval job, worker |

The job also receives `OPENROUTER_API_KEY` (secret `openrouter-api-key`), the `DB_*` set and
`BUCKET`, `PUBLIC_BUCKET`, `MATTING_URL`, `WORKER_URL` exactly as the worker does (02, 05, 07).

### 4.10 Licences

Licence per candidate, recorded in `services/matting/README.md` and in the bake-off report:

| Model | Licence |
|---|---|
| BiRefNet family (`birefnet-general`, `-general-lite`, `-hrsod`, `-hr`, `-hr-matting`, `-dynamic-matting`) | MIT |
| BEN2 base (`ben2-base`) | MIT |
| InSPyReNet (`inspyrenet-base`) | MIT |
| ViTMatte, SAM 2 (experiments) | MIT |
| RMBG-2.0 (`bria-rmbg`) | CC BY-NC 4.0 (gated on Hugging Face; rembg hosts the ONNX) |
| RMBG-1.4 (`rmbg-1.4`) | non-commercial |
| SAM 3 (dropped) | SAM License (not non-commercial: ITAR, military, sanctions, Meta may change terms, indemnity) |
| Depth Anything V2 Small, DA3-SMALL/BASE/METRIC-LARGE/MONO-LARGE | Apache-2.0 (V2 Base/Large/Giant and DA3 LARGE/GIANT/NESTED are CC BY-NC) |
| Real-ESRGAN | BSD-3 |
| SwinIR | Apache-2.0 |
| SeedVR2 (dropped, generative) | Apache-2.0 |

Owner's decision (closed): for this internal tool any open-weight model may be used regardless of
non-commercial terms. NC models (`bria-rmbg`, `rmbg-1.4`, the NC Depth Anything variants and any
other) are full candidates, are ranked on quality alone and may be written to `model_policy` as
defaults. No candidate is excluded, down-weighted or flagged for its licence, and no licence review
step remains in the build order, test plan, done criteria or report. The paragraph below is kept as
a record of the posture that was considered.

Licence posture (record only)

CC BY-NC 4.0 (RMBG-2.0, Depth Anything V2 Base/Large, DA3 Large/Giant, 4x-UltraSharp's NC-SA
variant) permits copying, adapting and using the work for any purpose that is not "primarily intended
for or directed towards commercial advantage or monetary compensation". The licence has no "internal
use" carve-out; what matters is the purpose of the use. Producing catalogue images that sell products
for Opptra's brands is a commercial purpose under the ordinary reading of that clause, even if the
model is never resold or exposed to customers, and BRIA's own card says commercial use requires an
agreement with BRIA. The FLUX Non-Commercial licence (FLUX.2 dev, klein 9B; not used in this
module) is written the same way: non-commercial purposes only, with a separate commercial licence
offered by Black Forest Labs. SUPIR requires written permission for commercial use. The SAM
License is not non-commercial; its restrictions are ITAR, military, sanctions and compliance, plus
Meta's right to change terms and an indemnity. Apache-2.0, MIT and BSD-3 (BiRefNet, BEN2 base,
InSPyReNet, ViTMatte, SAM 2, Depth Anything Small, Real-ESRGAN, SwinIR, SeedVR2) carry no such
restriction; the research note's point that BiRefNet's weights were trained on academic datasets
whose terms are unsettled applies to those too. Every NC slot in this review has a permissive
alternative measured in the same bake-off (BiRefNet general or HR-matting for RMBG-2.0; DA3-SMALL
for DA3-LARGE; Real-ESRGAN or SwinIR for UltraSharp), so the report can always name one. Nothing
here blocks a candidate; the licence is recorded per model in `services/matting/README.md` and in
the bake-off report.

## 5. Build order (subagent workstreams)

Worktrees follow 00 section 3: `C:\Users\Sujan AH\Desktop\catalog-module-wt\08-model-bakeoff-and-policy-<workstream>`.

- W0 custom matting sessions (`...-sessions`, Python): the BiRefNet custom sessions as subclasses
  of `rembg.sessions.base.BaseSession` overriding `predict`, `download_models` and `name`
  (confirmed in current docs; builders re-confirm before coding), registered so
  `rembg.sessions.sessions_names` and 05's `new_session(model_name, sess_opts)` path find them;
  `ben2-base` through rembg's `ben_custom` session with `model_path`; `inspyrenet-base` through
  `transparent-background`; `rmbg-1.4`; `remove(data, session=..., only_mask=True)` returns the
  mask for every id as for the built-ins. ONNX export steps, `inputSize`, `target` and licence per
  model recorded in `services/matting/README.md`; both Dockerfile targets and `app.py` changed;
  pytest cases for `/matte` with each new id and for `/health` listing `inputSize` and `target`.
  Both images are rebuilt and deployed by the manager before tier 3.
- W1 golden set (`...-assemble`): `manifest.ts`, `assemble.ts`, the `assemble` and `labels export`
  commands, BigQuery `image_url` source through 02's client, unit tests with fixtures.
- W2 runs, judges and experiments (`...-judges`): `run.ts` (service choice by id, "not run"
  rule), `judges.ts` (per-model prices), `experiments.ts`, `contact-sheet`, resumability tests on
  PGlite with a fake judge and a fake endpoint listing.
- W3 scoring and policy (`...-score`): `score.ts`, `policy-writer.ts` (`matte_target`, replacing
  `default` and `pending` rows, never `manual`), `report.ts` with the licence table, `policy.ts`
  pending rows, `--live` drift, unit tests on synthetic label and judgement tables (including a
  case where no judge meets the gates).
- W4 CLI entry, job and docs (`...-job`): `catalog-eval.ts`, the esbuild entry, the `catalog:eval`
  script, `deploy.sh` job, `docs/eval/README.md`, the no-model-names test.

W0 to W4 are independent; the integration subagent merges, then the manager runs the real bake-off
(section 6, tier 3) and attaches the report.

## 6. Test plan

Python (W0): `/health` on the CPU image lists the built-ins plus the 1024 px and native custom
ids with `inputSize` and `target`; the GPU image lists all ids including the two 2048 px ones;
`/matte?model=<id>` for each new id returns a mask of the received size on the synthetic
product-on-white image; an unknown id returns 400 with the 05 sentence; no `remove()` call relies
on rembg's default session.

Tier 1 unit: manifest round trip and sha256 idempotency; `score.ts` precision and recall on
hand-built tables (including `no_labels`, ties, the threshold sweep picking 75 when it qualifies,
and the "no judge meets gates" branch setting `per_output` and `met = false`); winner selection
tie-breaks and `matte_target` choice; policy upsert never overwrites `manual`, does replace
`default` and `pending`; fallback order in `resolvePolicy`; the budget estimate uses per-model
prices.

Tier 2 integration (PGlite, fake storage, fake matting with two fake services, fake judge): `run`
creates an `is_test` batch with the forced policy and enqueues chunks; `run` for a GPU-only id with
`MATTING_GPU_URL` unset prints "not run: no GPU service" and creates nothing; `judges` is resumable
(a second call makes no new calls); `experiment sr_pass` flags its outputs `upscaled` and adds the
extra question; `policy write` produces (brand, category), (`*`, category) and (`*`, `*`) rows; a
batch started for an unseen (brand, category) inserts a `pending` row, sets
`counts.policyFallback` and its report carries the fallback sentence; `score --live` counts a
`use_as_is` decision on a judge-flagged output as one false flag; the no-model-names test passes.

Tier 3 real data, the bake-off itself (the manager runs it; the PR carries the report):
1. `assemble` for every set in section 4.2; print the manifest counts per brand and tag.
2. Human labels: the operator labels the Styli and Noon views of the USPA, Anta and hard-cases
   sets through the attention screen in eval mode (07); Sujan labels the rest. `labels export`
   writes the CSVs.
3. `run` once per primary candidate on every set, once per secondary candidate on the hard-cases
   set and one apparel set, through all nine channels (`qaMode per_output`), on the deployed
   `catalog-worker`, `catalog-matting` and `catalog-matting-gpu`; a candidate that W0 could not load
   or that needs the GPU service when it is absent is listed as "not run" with the reason; record
   wall time and `matte_ms` per target.
4. `judges` with the six judge models on each run, `EVAL_BUDGET_USD` set from the printed
   estimate, `LIVE_SMOKE=1`, as the `catalog-eval` job. The two optional judges only if no judge
   meets both gates.
5. `experiment trimap` and `experiment box_prompt` on the hard-cases run of the winner;
   `experiment sr_pass` on one footwear set and the Styli-rejected set.
6. `contact-sheet` per run for a human look at every flagged output.
7. `score`, `policy write --dry-run`, review of the ranking, `policy write`, `report`.
8. Cleanup: eval batch objects under `catalog-test/` deleted by the CLI through
   `deleteTestObjects`; `eval/` kept.
Compliance must be 100% on every run; anything else is a 05 bug and stops the bake-off.

Tier 4: the human-like browser test defined in 06 re-runs unchanged after the policy is live.

Tier 5 per-brand smoke (`pnpm catalog:smoke`, inside `deploy.sh`): now one product per brand from
the golden set, with the policy applied; the smoke report shows the policy source per brand
(`bakeoff`, `default`, `pending`) without model names.

CI gate: `pnpm lint && pnpm typecheck && pnpm test`.

## 7. Done criteria

- The bake-off report exists in `eval/*/reports/` and is linked in the PR; it shows precision and
  recall per (brand, category) and per judge with `n`, the matte comparison with CPU and L4
  columns, every candidate's licence, the experiment results, and cost per style+colour next to
  INR 60.
- `model_policy` has a row for every (brand, category) seen in the golden set plus the fallback
  rows, each with `matte_target`; `gates.met` is true wherever labels exist in enough number for
  both gates to be computed, and the report explains every `met = false`.
- A new batch for a covered brand starts with its policy row (checked in `options.policy`); a
  batch for an unseen pair creates a `pending` row and shows the fallback sentence.
- The no-model-names test passes against every catalog page, route, toast and export with the
  full substring list.
- Both matting services list their ids with `inputSize` and `target`, or the report says which
  custom id could not be loaded and why; GPU-only candidates are either measured or "not run: no
  GPU service".
- The report carries the per-model licence table as a record; winners are chosen on quality alone
  (owner's decision, section 4.10).
- Brands waiting for sample images are listed in the report and in the manager's message.

## 8. Merge, deploy, report

Per `00-execution-protocol.md`: PR from `feat/catalog-08-model-bakeoff-and-policy`, gates, review
and simplify, merge, `bash infra/deploy.sh` (adds the `catalog-eval` job and both rebuilt matting
images), per-brand smoke, learnings (matting quality findings go to
`docs/solutions/catalog-matting-quality.md`), then the single report with the bake-off summary
table, the policy rows written, candidates not run, the experiment outcomes, pending pairs, brands
waiting for sample images, and "Ready for the next spec: 09 Scale, guardrails and hand-over".
