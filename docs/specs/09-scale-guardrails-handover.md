# 09 Scale, guardrails and hand-over

Catalog module, spec 09 of 09. Execute with `docs/specs/00-execution-protocol.md`. Source of
truth: `docs/SPEC.md` (sections "Testing and guardrails", "Product identity and overwrite",
"Architecture, storage, data model, services", "Definition of done for the programme"). Depends on
06 (pipeline, publish stage, exports, human-like test), 07 (QA, attention, caps) and 08 (policy and
the bake-off report); everything named here exists after them. Branch
`feat/catalog-09-scale-guardrails-handover`. Deploys the final knob values.

Contracts from earlier specs used here, not redefined:
- `is_test` batches, `rootPrefix`, `batchPrefix`, `productPrefix`, `publicObjectPath`,
  `assertWithinProduct`, `assertTestPrefix`, `deleteTestObjects`, `headObject`,
  `stageCopyToPublic`, `deletePublicObject`, `CHANNEL_IDS`, the channel rules in `channels.ts`,
  the sheet readers, `compareXlsxCsv`, `safeFetch`, `/tasks/catalog/sweep` (defined in 02).
- Roles, the People modal, `requireRole` and its 403 sentence (defined in 03).
- `signedPutUrl` upload planning and the ingest route (defined in 04).
- `MATTING_BREAKER_FAILURES`, `MATTING_BREAKER_COOLDOWN_MS`, `MATTING_TIMEOUT_MS`, the breaker
  states `closed | open | half-open`, the flood-fill fallback and flag `fallback_matte`; the two
  matting services `catalog-matting` (CPU, asia-south1) and `catalog-matting-gpu` (one L4,
  asia-southeast1, optional), `MATTING_URL`, `MATTING_GPU_URL`, `DEFAULT_MATTE_MODEL`, and the
  rule "send a model to the service that lists it, preferring gpu" (defined in 05).
- The publish stage (stage, verify, swap, delete; idempotent retry by `crc32c`), the verify
  sentence, `catalog_chunks` timestamps, `report-v<k>.json`, `counts.recheckOk` and
  `counts.recheckTotal`, the re-check library in `packages/core/src/catalog/recheck/`, the
  Playwright spec `apps/web/test/human/catalog.human.spec.ts`, `pnpm catalog:smoke` (defined in 06).
- `qa_cap`, `qa_unavailable`, `DAILY_SPEND_CAP_USD`, `options.qaCapUsd`, `checkCaps` (defined in 07).
- `pnpm catalog:eval`, the bake-off report and `model_policy` sources (defined in 08).

## 1. Goal

Show that the module handles the real volumes within the target time, that every guardrail holds
when things break (including the overwrite path), that every delivered link resolves to the live
generation we recorded, and that a non-technical operator can run it alone. Finish the
documentation: `docs/SPEC.md` as built, learnings in `docs/solutions/`, README, the operator's
access through the People modal, and the hand-over note with the recording of the human-like run.

## 2. Scope

In scope
- Load test: the 2,700-option batch and the 100,000-output total against the 2-hour target, plus a
  re-upload pass that measures publish throughput and proves the overwrite contract at scale;
  tuning knobs and the values finally set in `infra/deploy.sh` and `infra/bootstrap.sh`.
- Fault injection: matting down, slow and recovering; worker killed mid-chunk; GCS errors; Cloud
  Tasks redelivery; QA daily and per-batch caps; OpenRouter down; broken source link; plus the
  overwrite-path scenarios `publish_precondition_mismatch`, `publish_partial_crash`,
  `delete_scope_violation`, `restore_previous_generation` and `lock_sweeper`. Evidence that
  nothing fails or breaks silently.
- Independent URL re-check by live generation: CLI and sheet-level modes over the library 06 built.
- The recording of the human-like run as a GIF.
- `docs/SPEC.md` as-built pass, `docs/solutions/` learnings, README catalog section.
- The operator's access: the owner adds Naaz as `operator` in the People modal himself (not a
  blocker for this spec).
- The hand-over note in plain language.

Out of scope
- New features. Anything discovered here that needs product work is listed in the report as a
  follow-up, not built.
- More GPU capacity than the three L4s of `catalog-matting-gpu` (05): a quota request is noted in
  the report if the timing needs it; not requested here.
- Any change to the overwrite sequence itself (06 owns it; a guardrail that does not hold is a bug
  fixed under this spec and re-run).

## 3. Files

Add
- `apps/worker/src/catalog-load.ts` load test driver (`pnpm catalog:load`), an esbuild entry in
  `apps/worker/build.mjs` like `catalog-local` (04).
- `apps/worker/src/catalog-recheck.ts` URL re-check CLI (`pnpm catalog:recheck`), same pattern.
- `apps/worker/src/fault-proxy.ts` local HTTP proxy that injects failures.
- `packages/core/src/catalog/load/*.ts` pure parts of the load test (replication naming, timing
  math, result classification) with `*.test.ts`.
- `packages/core/src/catalog/recheck/*.ts` additions: sheet-level checks (row count, uniqueness,
  hyperlink cells, `.jpg` suffix), the `--brand` reader, the contact sheet writer, with `*.test.ts`.
  The core checker (plain GET, header and byte checks) already exists from 06.
- `docs/handover/catalog-for-the-operator.md` plain-language hand-over.
- `docs/handover/catalog-walkthrough.gif` the recording (under 16 MB, kept in the repo so the
  note can embed it; if larger, stored at `gs://image-links-agent-assets/handover/` and linked).
- `docs/solutions/catalog-scale.md`, `docs/solutions/catalog-guardrails.md`,
  `docs/solutions/catalog-restore.md`, and one file per non-obvious finding from 06 to 08 not yet
  written.
- `docs/plans/catalog-load-report.md` the load test figures and the knob values chosen.

Change
- `infra/deploy.sh`: final knob values (section 4.3), `COMPUTE_USD_PER_VCPU_SECOND` passthrough.
- `infra/bootstrap.sh`: queue `catalog` settings if the load test changes them (check-then-update).
- `docs/SPEC.md`: as-built pass (section 4.6).
- `README.md`: catalog section (section 4.7).
- root `package.json`: `catalog:load`, `catalog:recheck` scripts.

## 4. Contracts

### 4.1 Load test (`catalog-load.ts`)

Three passes, all as test batches (`is_test = true`, objects under `catalog-test/` in both
buckets, products in the `is_test` namespace), on the deployed services, brand USPA, real pixels:

- Run A, "the 2,700-option batch": 2,700 options with 3 to 5 shots each, four channels (Namshi,
  Noon, Trendyol, Amazon, the P1 group). Sources: the real local sets (French Connection Final,
  3,280 images at 800x1200; Anta Images, 630 images at 800x800) and the live Supabase links from
  the delivery sheets, replicated under generated identifiers `LT<k>_<identifier>` until 2,700
  options exist. The driver uploads them as several zips through the real signed-PUT route (04),
  so the browser upload path is loaded too.
- Re-upload pass: after Run A is `done` and analysed, the driver builds a second zip for a sample
  of 300 of Run A's products (builder constant) in which one photo per product is altered (one
  pixel row changed, so `sha256` differs) and one shot is dropped, and starts a new batch on the
  same four channels. This measures publish throughput (products published per minute, time from
  `qa` done to `is_live`) and proves the overwrite contract at scale: same URLs, new generations
  for the altered shot, `unchanged` for the untouched shots, 404 on the dropped shot, `change`
  column `updated` or `shots_removed`, one `overwritten` or `shots_removed` event per product, no
  object outside the product prefixes touched.
- Run B, "the 100,000-output total": the same 2,700 options through all nine channels; at about 4
  shots per option this is about 97,000 outputs, the plan's 100,000-output scale in one run. The
  four P1 channels are `unchanged` for untouched products (zero cost), so Run B also measures how
  cheap a repeat is. Run B starts only after the re-upload pass has been analysed.

Target: Run A completes (status `done`) within 2 hours of "Start processing". The re-upload pass
and Run B are measured against the same target; the plan's target is per batch.

Budget check from the plan's numbers, used to set expectations before the run and to spot a
bottleneck after it. Matting depends on which service the policy sends each model to (05):

| Matting path | Per image | Images per hour | Run A's 10,800 sources | Plan's 24,000 sources |
|---|---|---|---|---|
| CPU, 20 instances, `birefnet-general-lite` | 4 to 8 s (6 s used) | 12,000 | about 54 minutes | about 2 hours, about USD 23 |
| CPU, 20 instances, `birefnet-general` | 10 to 20 s (15 s used) | 4,800 | about 2.3 hours | about 5 hours, about USD 58 |
| CPU, `birefnet-hr-matting` at 2048 px | far slower | | not viable | about 400 hours, about USD 230 |
| One L4, `birefnet-general` | about 0.4 s | 9,000 (27,000 with three) | about 1.2 hours (24 minutes with three) | about 2.7 hours, about USD 3 |
| One L4, `birefnet-hr-matting` | about 1.6 s | 2,250 (6,750 with three) | about 4.8 hours (1.6 hours with three) | about 11 hours, about USD 13 |

These figures are the plan's estimates; tier 3 of 08 measured `matte_ms` on both services and the
load report replaces them with the measured values. Render is about 0.5 s per output on 10 worker
instances at concurrency 2, so Run A's 43,200 outputs take about 18 minutes and Run B's 97,200
about 41 minutes; publish is one server-side copy plus one GET per output, measured in the run; QA
judge latency per check is measured in the run (the plan gives cost, about USD 0.0004 to 0.0013
per check, not latency). If matting dominates, the knobs in section 4.3 apply: which model the
policy chose per category decides whether the CPU or the GPU path is the one to tune.

Measured and written to `docs/plans/catalog-load-report.md`: wall time per stage (collect, matte,
render, qa, publish, finalize) from `catalog_chunks` and `catalog_outputs.published_at`
timestamps; p50 and p95 `matte_ms` per image; p50 and p95 render ms per output; products published
per minute; Cloud Run instance counts over time (from Cloud Monitoring, read with
`gcloud monitoring` or the console, pasted as numbers); queue depth; `spend_days` cost for the day
split by `catalog_qa` and `catalog_compute`; cost per style+colour in INR against INR 60 with
`unchanged` products excluded from the denominator (06's rule); errors by reason; outputs by
status. Every output must be `verified`, `needs_attention`, `skipped` or `failed` with a reason,
or `unchanged` at the product level; the report lists every `failed`.

Cleanup: the driver deletes `catalog-test/uspa/<batchId>/` in the private bucket and
`catalog-test/uspa/<pathKey>/` for every product it created in the public bucket through
`deleteTestObjects`, then the batch, product, alias, event and output rows, after the report is
written. Nothing else is deleted.

### 4.2 Fault injection

Local stack (Docker `catalog-worker` and `catalog-matting`, real GCS under `catalog-test/`,
`TASKS_INLINE=1` with a small redelivery shim in the driver) with `fault-proxy.ts` in front of
matting, GCS and OpenRouter so failures can be switched on and off per scenario. Each scenario is
a named run (`pnpm catalog:load --scenario <name>`) of a 300-image test batch with an expected
outcome; the driver asserts the outcome from the database, `report.json` and `headObject` on the
public objects.

| Scenario | Injected | Expected |
|---|---|---|
| matting_down | proxy returns 503 for every `/matte` | breaker opens after `MATTING_BREAKER_FAILURES` (default 5) consecutive failures; remaining sources use flood-fill; every output of those sources `needs_attention` with flag `fallback_matte` and its 05 sentence; batch `done`; breaker transitions logged |
| matting_slow | proxy delays `/matte` past `MATTING_TIMEOUT_MS` (default 60 s) for a third of calls | timeouts counted as failures; affected sources fall back; others normal; no chunk `failed` |
| matting_recovers | 503 for longer than `MATTING_BREAKER_COOLDOWN_MS` (default 60 s), then healthy | breaker `half-open` trial succeeds and closes it; later sources use real mattes; the report shows both reasons |
| matting_gpu_down | proxy makes `MATTING_GPU_URL` unreachable while the policy names a model only the GPU service lists | those sources are matted on the CPU service with `DEFAULT_MATTE_MODEL` and flagged `fallback_matte` with its 05 sentence (attention, not failure); sources whose model the CPU service lists are unaffected; batch `done`; the report counts the fallbacks and the log names the unreachable service, never operator text |
| worker_killed | kill the worker container during a `render` stage, restart, redeliver | no duplicate public objects (object count equals live outputs); redelivery repeats no finished work; batch `done` |
| gcs_flaky | proxy returns 503 on 10% of copies and verify GETs | each retried inside the delivery (02's 3 retries with backoff); an output still failing is `failed` with the verify sentence and its previous live object stays live and recorded; others `verified`; no new object path is ever invented |
| verify_mismatch | proxy truncates one verify GET body | 06's one in-delivery retry (copy again, GET again), then that output `failed` with "Uploaded file could not be read back from the public link"; the previous row stays `is_live` and in the sheet; the product is listed in the report; nothing else affected |
| publish_precondition_mismatch | the driver overwrites one public object out of band between staging and swap (bumps its generation) | that output `failed` with "Changed by another run. Start the batch again for this product."; no other object of that product is swapped; the product's previous images stay live; the report spells out the live state |
| publish_partial_crash | proxy stalls the second copy of a product, the driver kills the worker, then redelivers | on retry an output whose public object already carries the staged `crc32c` is treated as copied, the rest are copied, all verified; no duplicate objects; one `overwritten` event; the mixed window (seconds between first and last copy) is measured and written to `docs/solutions/catalog-guardrails.md` |
| delete_scope_violation | the driver tampers one superseded row's `object_path` in the test database to point at another product's prefix | `assertWithinProduct` throws; nothing is deleted (`headObject` on the target still returns the same generation); the product's publish fails with a plain reason; one log line names the refused path |
| restore_previous_generation | after a successful overwrite, the manager runs the restore drill from `docs/solutions/catalog-restore.md` on one object | the previous generation is copied back as the new live generation (`bucket.file(path, { generation })` as source, `file.copy(dest, { preconditionOpts: { ifGenerationMatch } })`, confirmed in current docs; builders re-confirm before coding), re-verified by public GET, the output row updated with the new `generation` and `crc32c`, and a `restored` event logged with the manager's email as actor; the re-check passes afterwards |
| lock_sweeper | a batch is left with no chunk progress (proxy holds every `/matte` open) and the clock is advanced past 2 hours | `/tasks/catalog/sweep` marks the batch `failed` with a sentence, releases `lock_batch_id` on its products; a new batch for the same products can start |
| qa_daily_cap | `DAILY_SPEND_CAP_USD` set to a value already exceeded by a seeded `spend_days` row | every QA call skipped; outputs `needs_attention` with flag `qa_cap`; banner sentence present; batch `done` |
| qa_batch_cap | `options.qaCapUsd` tiny | QA stops mid-batch; the rest `qa_cap`; earlier outputs keep scores |
| openrouter_down | proxy returns 500 for chat completions | `callLlmJson` retry, then `qa_unavailable`; cost recorded 0; batch `done` |
| duplicate_delivery | the same chunk task posted twice at once | one effective processing; the second returns `noop` or waits; no duplicate objects |
| supabase_broken_link | one pasted URL returns 404 | that source `failed` with a plain reason; the product keeps its other shots; listed in the report |

Every scenario's outcome plus the log lines go into `docs/solutions/catalog-guardrails.md`.
Guardrails that do not hold are fixed in this spec (they are bugs in 05, 06 or 07 behaviour) and
re-run. The restore drill is written up in `docs/solutions/catalog-restore.md` as a numbered
procedure the manager can follow within the 30-day window of noncurrent versions.

### 4.3 Tuning knobs (all in `infra/deploy.sh` or `infra/bootstrap.sh`; env overrides allowed)

| Knob | Where | Starting value (CONTRACTS section 2) | Changed only if |
|---|---|---|---|
| worker `--max-instances` | deploy.sh | 10 | render or publish is the bottleneck in 4.1 |
| worker `--concurrency` | deploy.sh | 2 | memory headroom at 2Gi allows more |
| worker `--cpu` / `--memory` | deploy.sh | 2 / 2Gi | p95 render ms or out-of-memory says so |
| worker `--timeout` | deploy.sh | 900 | never raised; chunk size is lowered instead |
| matting `--max-instances` | deploy.sh | 20 | matte stage dominates and cost allows |
| matting `--cpu` / `--memory` | deploy.sh | 4 / 8Gi | model load fails or p95 `matte_ms` is far above 8 s |
| matting `--concurrency` | deploy.sh | 1 | CPU headroom at 4 vCPU allows more |
| `catalog-matting-gpu` `--max-instances` | deploy.sh (05) | 3 (the default L4 quota; `--gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy`, asia-southeast1) | GPU-path models dominate and a quota increase is granted; noted in the report, not requested here |
| `catalog-matting-gpu` `--cpu` / `--memory` | deploy.sh (05) | 4 / 16Gi | model load fails or p95 `matte_ms` on the L4 is far above the 08 figures |
| `MATTING_GPU_URL` | env (05) | set when the GPU service is deployed | unset only to run everything on CPU (GPU-only models then fall back, see matting_gpu_down) |
| queue `--max-concurrent-dispatches` | bootstrap.sh | 20 | instances sit idle |
| queue `--max-attempts` | bootstrap.sh | 5 | never lowered |
| queue `--min-backoff` | bootstrap.sh | 10s | redelivery storms in duplicate_delivery |
| `CATALOG_CHUNK_IMAGES` | env | 25 | task durations approach the 900 s timeout |
| `DB_POOL_MAX` | env | 2 (worker), 3 (web) | connection errors on db-f1-micro (10 instances times 2 plus web must stay under the instance's `max_connections`; raising `max_connections` is the alternative) |
| `MATTING_BREAKER_FAILURES` | env (05) | 5 | false opens in matting_slow |
| `MATTING_BREAKER_COOLDOWN_MS` | env (05) | 60000 | recovery too slow or too eager in matting_recovers |
| `MATTING_TIMEOUT_MS` | env (05) | 60000 | p95 `matte_ms` shows healthy calls being cut off |
| matting send size per model | `/health` `inputSize` (05) | 1024 for rembg built-ins, 2048 for the HR models, native for the dynamic models | never changed here; a different send size is a different candidate for 08 |

Final values are written into `deploy.sh` and listed in `docs/plans/catalog-load-report.md` with
the measurement that justified each change. Cost rules stay: min-instances 0 everywhere,
db-f1-micro, no always-on resources.

### 4.4 Independent URL re-check (`catalog-recheck.ts`)

`pnpm catalog:recheck --sheet <path.xlsx|.csv> [--csv <path.csv>] | --batch <id> | --brand <slug>`
with `[--out <report.csv>] [--sample <k>] [--concurrency <n>]`:
- Input: `--sheet` reads every link cell under the channel headers with 02's readers and needs no
  cloud credentials; `--batch` reads the batch's `is_live` outputs; `--brand` reads every `is_live`
  output of the brand. Bounded concurrency, default 16 (builder constant).
- Per URL, a plain `GET` from a fresh client (no storage library, no database): requires 200;
  `content-type` media type `image/jpeg` (a `; charset=...` suffix is ignored, any other type
  fails); body starting `FF D8 FF`; size at most 2,000,000 bytes; URL path ending in lowercase
  `.jpg`; `https` and no spaces; width and height decoded with sharp and compared to the channel's
  canvas rules from `channels.ts` (min to target range, Styli exactly 2342x3123, Centrepoint
  3000x3000, Amazon and Shein 2000x2000 or the 1000x1000 minimum); sRGB ICC presence and JFIF
  density per channel.
- For `--batch` and `--brand`: the response header `x-goog-generation` must equal the recorded
  `catalog_outputs.generation` of the live row. This is the contract: links resolve to the recorded
  live generation.
- Sheet-level checks: one row per product (row count equals `counts.products` for `--batch`, or
  the number of distinct identifiers for `--sheet`); every URL unique; for xlsx input every link
  cell is a hyperlink cell whose `hyperlink` equals its `text` (problem `not_a_hyperlink` otherwise);
  `--csv` compares the xlsx and the csv cell for cell through 02's `compareXlsxCsv`.
- Output: `recheck-<timestamp>.csv` with one row per link (`url, identifier, channel, n, status,
  http, bytes, width, height, generation, expected_generation, problem`) and the summary line
  `<ok> of <total> links OK`; for `--batch` the two numbers are written to `counts.recheckOk` and
  `counts.recheckTotal` and shown on the Details tab as "Independent re-check: <ok> of <total> OK".
  Exits non-zero when any link or sheet-level check fails.
- `--sample <k>` writes a contact sheet (HTML) of k random live links per channel with the original
  photo beside each output, to `<prefix>/exports/recheck-contact-<timestamp>.html`, and prints a
  signed URL; it is a human look, not a gate.
- Run on: the tier 3 sheets from 06 and 07, every per-brand smoke sheet, the eval sheets from 08,
  the load test sheets and the re-upload pass sheet. Results go into the load report.

### 4.5 The recording of the human-like run (GIF)

Re-run `catalog.human.spec.ts` on the deployed URL with Playwright `recordVideo`, using the
`storageState` saved by `apps/web/test/human/login.ts` after the tester signs in with Google
(confirmed in current docs; builders re-confirm before coding). Take the saved `.webm` and convert
it with ffmpeg to `docs/handover/catalog-walkthrough.gif` at a reduced frame rate and width so
the file stays small, for example:

```
ffmpeg -i run.webm -vf "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" catalog-walkthrough.gif
```

Adjust until under 16 MB. The GIF shows a real test batch for USPA from "New batch" to the
downloaded sheet, the attention actions ("Use as is", "Remove this photo", "Replace photo N"),
and the re-upload steps (same zip: everything `unchanged`; changed zip: the new picture behind the
same link, the removed link gone, the `change` column). No model names, no secrets, no session
cookies visible: the recording starts after sign-in.

### 4.6 `docs/SPEC.md` as-built pass

The whole of `docs/SPEC.md` is the catalog spec in this repo. Update it to what was built: the
nine channel rows exactly as `channels.ts` has them; the ingestion sources table; worker routes
and chunk stages (`matte`, `render`, `qa`) plus the publish and finalize routes; the roles and the
People modal; tables and the status words; the product identity and overwrite rules (staging,
`ifGenerationMatch`, verify by generation, scoped deletes, versioning, restore); QA dimensions, 75
and 60; `model_policy` and the gates 97% and 90%; the cost line against INR 60 with the
`unchanged` exclusion; the guardrails list with the fault-injection evidence; the test tiers with
their commands (`pnpm test`, `pnpm test:real`, `pnpm catalog:smoke`, `pnpm catalog:eval`,
`pnpm catalog:load`, `pnpm catalog:recheck`, the Playwright spec); the answer to the `?v=`
open point; the "Definition of done" list ticked with evidence links. Anything the spec promised
that was not built is removed from the main text and listed under a "Not built" section with the
reason; nothing is left described as if it existed.

### 4.7 README and `docs/solutions/` topics

README gains a "Catalog images" section: what it does in three sentences; how to sign in and who
grants roles; how to run a batch (pointer to the hand-over note); local development (Docker worker
and matting, `TASKS_INLINE=1`, `PUBLIC_BUCKET`, `MATTING_URL`); deploy (`bash infra/deploy.sh`, the
smoke gate, the eval job); costs (per style line, caps, `INR_PER_USD`,
`COMPUTE_USD_PER_VCPU_SECOND`); troubleshooting (the batch states and what each means; where
`report.json` is; the re-check script; the restore procedure; how to re-run the bake-off for a new
brand). No model names in the README's operator sections; the engineering sections may name the
candidates.

`docs/solutions/`: one file per non-obvious finding from 06 to 09 that is not already there, in
the house style (symptom, cause, fix, how verified). Expected topics: direct-to-GCS CORS and signed
PUT headers; Google sign-in session reuse for Playwright (`storageState`); Cloud Scheduler OIDC
against the worker; staging-then-swap with `ifGenerationMatch`, versioning and the restore
procedure (`catalog-restore.md`); breaker tuning; db-f1-micro connections; matting CPU timing;
warehouse sync findings. The two warehouse inconsistencies (the v2 sales procedure reads Noon HL
columns under old names; the docs name `rohan_master_sheet_hl` while code uses
`sku_master_sheet_hl`) are reported to the product owner in the final message, not fixed.

### 4.8 The operator's access and the hand-over note

Access. The owner (sujan@opptra.com, the seeded admin) adds the operator, Naaz, himself from the
People page: he enters her @opptra.com Google account, picks Operator and presses "Add person" (03).
Her account is not in this repo and the manager does not need it; this step is not a blocker and
the report simply reminds the owner of it. Nothing else is needed for her to sign in: IAP admits
every Opptra account (03). Verified by her signing in and seeing "New batch", or by the owner
checking her row says Operator.

Hand-over note: `docs/handover/catalog-for-the-operator.md`, plain language, no jargon, written for
someone who will use the tool unsupervised once the supervised period with Sujan ends. Sections,
in this order:
1. What the tool does (one paragraph): you upload product photos once; it makes the right size for
   each marketplace and gives you a sheet of links.
2. How to sign in: open the link; Google asks you to sign in; use your @opptra.com account. If you
   only see view access (no "New batch" button and the message "You can view this but not change
   it. Ask an admin for the operator role."), ask Sujan to make you an operator; nothing else is
   needed.
3. Naming photos before uploading: `ABC123_1.jpg, ABC123_2.jpg`; one product per identifier (the
   style and colour code), never a size; the number is the photo's position. iPhone HEIC photos
   are fine; they are converted automatically.
4. Sharing a Google Sheet or Drive folder: paste the link, then share it with the address shown on
   the screen (Viewer is enough; we only read).
5. The four steps of a new batch with the exact button names: "Brand and files", "Check what we
   found", "Where will these images go?", "Start" and the button "Start processing". Step 4 is a
   check, not a result: confirm the grouping on one or two rows with whoever asked for the images
   before a large run; "products found" counts identifiers, never files.
6. What each state means and what to do: "Collecting files N of N", "Processing N of N",
   "Needs attention (N products)", "Ready to download", "Could not start".
7. Resolving attention items: "Use as is" (the photo is fine, keep it in the sheet), "Remove this
   photo" (the sheet cell is emptied with a note; if the photo was already live its link stops
   working), "Replace photo N" (drop a better photo; it is made again for the same marketplaces),
   with the meaning of each problem sentence the card can show.
8. Adding SKU ids: upload the mapping sheet from the batch page; nothing else changes.
9. Where the links sheet is and how to paste it into marketplace templates: "Download links sheet
   (Excel)", "Download CSV", and "Download filled product list" when you uploaded a product list.
   Only download and share a sheet when the batch says "Ready to download" or "Needs attention".
   Before sharing, read the two numbers on the Details tab (Links verified N of N and Independent
   re-check N of N) and make sure both are complete. When you hand a sheet to someone, say how the
   identifiers were read (file name, folder or sheet column), and list the products with numbering
   gaps and the products flagged for text or watermarks, with their identifiers.
10. What a re-upload does: uploading a product again replaces the pictures behind the same links;
    the links themselves stay the same. Marketplaces keep their own copy, so after a re-upload
    re-submit the image columns for every product whose `change` column says `updated`,
    `shots_removed` or `reordered`. Tell whoever holds an earlier sheet when a product was
    overwritten, re-filed or had shots removed.
11. Photo order matters: the photo numbered `_1` is image 1 on every marketplace. Photos not in the
    new upload disappear from the links.
12. Renames and aliases: a renamed identifier is a new product with new links unless you add the
    old name as an alias on the product page first.
13. Submit marketplace templates only from a batch that says "Ready to download".
14. The cost line: "INR x per style so far · agency reference INR 60 per style" means what this
    batch has cost per product so far against what the agency charged.
15. When to call Sujan: "Processing" for longer than two hours; "Could not start" twice; a link that
    does not open; a picture that did not change after a re-upload.
16. The recording of the human-like run, embedded or linked.

Nothing about models, workers, buckets, generations or costs beyond the INR line. The "fresh
links" question is answered in the note according to the build-time result (section 4.6): if GCS
serves `...ABC123_2.jpg?v=3`, the note names the "fresh links" export; if not, the note says
"upload the picture by hand in the seller portal for that marketplace".

## 5. Build order (subagent workstreams)

Worktrees follow 00 section 3: `C:\Users\Sujan AH\Desktop\catalog-module-wt\09-scale-guardrails-handover-<workstream>`.
- W1 load driver (`...-load`): `catalog-load.ts` (replication, zips through the signed PUT route,
  the re-upload zip builder, polling, metrics from `catalog_chunks`, `catalog_outputs` and
  `spend_days`, report writer), unit tests for the pure parts. Context7 for `@google-cloud/storage`
  and any `gcloud monitoring` command used.
- W2 fault proxy and scenarios (`...-fault`): `fault-proxy.ts`, the scenario runner inside
  `catalog-load.ts` (`--scenario <name>`), the out-of-band generation bump, the tampered-row and
  kill helpers, assertions.
- W3 re-check (`...-recheck`): `catalog-recheck.ts`, the sheet-level checks and `--brand` mode in
  `packages/core/src/catalog/recheck/`, the contact sheet, tests.
- W4 docs (`...-docs`): `docs/SPEC.md` pass, README, solutions skeletons including
  `catalog-restore.md`, hand-over note skeleton (the GIF, the `?v=` answer and the measured numbers
  are filled in by the manager after W1 to W3 run).
W1 to W4 are independent. Then the manager runs: the fault scenarios (local), Run A, analysis, knob
changes if any (one PR per change, re-run), the re-upload pass, Run B, the re-check over all sheets,
the `?v=` check, the GIF, the operator's role in People, final docs.

## 6. Test plan

Tier 1 unit: replication naming (`LT<k>_<identifier>` keeps `_<n>` parseable through
`parseShotName`); timing math; re-check classification for every failure kind with canned
responses (including a wrong `x-goog-generation`, a `.JPG` suffix, a duplicate URL, a text cell
that is not a hyperlink); sheet header parsing for the merged channel headers; fault proxy rule
matching; the re-upload zip builder alters exactly one photo and drops exactly one shot.

Tier 2 integration (PGlite, fake storage, fake fetch): the scenario runner's assertions against a
snapshot of a known outcome; `catalog:recheck --batch` and `--brand` against PGlite rows, including
one row whose recorded generation differs from the fake response; `counts.recheckOk` written;
`assertWithinProduct` refuses the tampered path.

Tier 3 real data: all fault scenarios in section 4.2 on the local stack with real GCS under
`catalog-test/`, including the restore drill; every expected outcome met; cleanup after each.

Tier 4: the GIF run of the human-like test on the deployed URL, including the re-upload steps and
the filled product list download when a product list was used.

Tier 5: per-brand smoke (`pnpm catalog:smoke`) after the final deploy, with the knob values that
shipped; its second pass still proves the overwrite contract per brand.

Tier 6 load (`pnpm catalog:load`): Run A, the re-upload pass and Run B on the deployed services;
the report written; cleanup done; `catalog:recheck` over the load sheets and over every earlier
delivered sheet passes.

CI gate: `pnpm lint && pnpm typecheck && pnpm test`.

## 7. Done criteria

- Run A finished within 2 hours, or the report explains the gap and the knob or GPU change that
  closes it, with the figures.
- The re-upload pass figures recorded: publish throughput, same URLs, new generations only for
  altered shots, dropped shots gone, `change` values correct, events written.
- Run B figures recorded; all outputs accounted for by status and reason; nothing silent.
- Every fault scenario met its expected outcome, including the restore drill;
  `docs/solutions/catalog-guardrails.md` and `docs/solutions/catalog-restore.md` have the evidence.
- `catalog:recheck` passes on every sheet delivered since 06: every live link resolves to its
  recorded generation and every sheet-level check holds.
- `docs/handover/catalog-walkthrough.gif` exists and shows the whole human-like run including the
  re-upload steps.
- `docs/SPEC.md`, README, `docs/solutions/`, `docs/plans/catalog-load-report.md`,
  `docs/handover/catalog-for-the-operator.md` are in `main`.
- The operator can sign in with her @opptra.com Google account (IAP, no step needed) and the owner
  has given her the operator role from the People page; the hand-over note exists and names no
  model, worker or bucket.
- The `?v=` open point is answered in `docs/SPEC.md` and the hand-over note.
- The programme's definition of done holds: all specs merged and deployed; the operator can run a
  batch for any brand without help; the human-like test passes with its GIF; every sheet link
  verified live and compliant; the bake-off report exists and `model_policy` covers every brand and
  category seen; cost per style+colour shown against INR 60.

## 8. Merge, deploy, report

Per `00-execution-protocol.md`: PR from `feat/catalog-09-scale-guardrails-handover` (knob changes
as their own small PRs during the load work), gates, review and simplify, merge,
`bash infra/deploy.sh`, per-brand smoke, then the final report to the human: the load figures
against 2 hours, the re-upload pass figures, the fault matrix including the restore drill, the
re-check result over every sheet, the GIF, the docs links, the two warehouse inconsistencies (the
v2 sales procedure reading Noon HL columns under old names; docs naming `rohan_master_sheet_hl`
while code uses `sku_master_sheet_hl`), any brands still waiting for sample images, the `?v=`
answer, a note of the two questions the owner closed (Styli: follow the guideline sheet, no
Styli-only `MAX_UPSCALE`; licence: NC models are full candidates), a reminder that the owner adds
Naaz as Operator from the People page himself, and "programme complete; no next spec".
