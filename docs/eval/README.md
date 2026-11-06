# Running a bake-off (spec 08)

A bake-off runs every candidate cut-out model and judge on the same golden set, compares them with
human labels and writes the winners into `model_policy`. The operator never sees a model name.

Everything runs as the Cloud Run job `catalog-eval` (deployed by `infra/deploy.sh`), through
`infra/catalog-eval.sh exec <cli args>` from the repo root in Git Bash. All artifacts stay under
`gs://image-links-agent-assets/catalog-test/eval/<set>/`. Only `exec --live` sets `LIVE_SMOKE=1`.

Arguments: `gcloud run jobs execute --args` refuses any value that appears twice (also through
`--flags-file`), so the script folds each `--flag value` pair into `--flag=value` before calling gcloud,
and the CLI reads both forms. `exec assemble --set anta --brand anta --sample 1 --seed 1` is sent as
`assemble|--set=anta|--brand=anta|--sample=1|--seed=1`. A flag given twice is refused before gcloud
runs. `apps/worker/src/catalog-eval-sh.test.ts` checks this against a fake gcloud.

1. Assemble a golden set (real photos, sampled per product). The brand must be in the brand master
   (`run` needs it); assemble checks that first and writes nothing otherwise:
   `bash infra/catalog-eval.sh exec assemble --set anta --brand anta --sample 10 --seed 1`
   `bash infra/catalog-eval.sh exec assemble --set french-connection --brand french_connection --sample 10 --seed 1`
2. Run one eval batch per matting candidate (`primary` = the primary list, or a model id):
   `bash infra/catalog-eval.sh exec run --set anta --matte primary --channels noon,styli`
   Candidates the services cannot serve are printed as "not run: ..." with the reason.
3. Label: open each printed `/catalog/<batchId>` page; eval mode shows every output with Pass / Flag.
4. Judge (live, costs credit; set the budget from the printed estimate):
   `EVAL_BUDGET_USD=2 bash infra/catalog-eval.sh exec --live judges --batch <id> --models anthropic/claude-haiku-5.5,google/gemini-3.8-flash`
5. Look: `contact-sheet --batch <id>` prints a signed URL. Signing needs
   `roles/iam.serviceAccountTokenCreator` for `catalog-worker@` on itself (granted by
   `infra/bootstrap.sh`). The originals and staged cut-outs are in the private bucket, so the sheet
   needs signed URLs; published outputs already use their public URL. `report` writes its HTML and
   JSON before signing, so a signing failure only loses the printed link (the job then exits 1).
6. Score and write: `score --set anta --batches <ids>`, `policy write --set anta --batches <ids> --dry-run`,
   then without `--dry-run`, then `report --set anta --batches <ids>`.
7. Clean up the eval batches (golden set sources stay): `cleanup --batches <ids>`.
   To remove a whole set folder (`catalog-test/eval/<set>/`, for example one left behind when
   `run` could not start), clean up its batches first, then `cleanup --set <set>`.

Reading the report: per (brand, category) and judge it shows precision (judge passed and a human
passed, over judge passed; gate 97%), recall (human flagged and the judge flagged, over human flagged;
gate 90%), every `n`, the swept threshold, cost and ms per check; per matte model the compliance rate,
human edge flags, judge edge disagreements and ms per image on CPU and L4. A gate with no labels is
`no_labels`; a policy row with `gates.met = false` keeps QA per output until the next bake-off.

## The judge exam (M1 D43)

`bash infra/catalog-output-evals.sh exam` runs the live judge (`LIVE_SMOKE=1`) on a fixed set: 18 known defects and 155 known-good
outputs, pinned by sha256 in `packages/core/test-fixtures/catalog/evals/judge-exam-set.json`, the images under
`catalog-test/evals/judge-exam/v1/`. Each judge a verdict can come from sits it: the first with its second opinion, and the fallback
with the first switched off. It writes `report.json` and `verdict.txt` under `catalog-test/evals/<run>/judge-exam/` and exits 1 when a
bar in `JUDGE_EXAM_BARS` fails. `proof` runs it first, and `infra/deploy.sh` runs it after a production deploy, where a failure stops
the release. It costs about USD 1.1 and takes about 10 minutes. It
only reads the pinned images and writes under `catalog-test/`, but it shares the model provider's rate limit with a running batch.

A rule for every proof, eval and exit report: name the judge model that produced each result. "The judge passed it" without the model
is not evidence: the old first judge passed all 14 known defects in the 2026-11-06 comparison. `proof`, `catalog-output-evals` and `catalog-qa-check` print and
store the tally per model.
