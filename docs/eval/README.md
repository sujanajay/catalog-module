# Running a bake-off (spec 08)

A bake-off runs every candidate cut-out model and judge on the same golden set, compares them with
human labels and writes the winners into `model_policy`. The operator never sees a model name.

Everything runs as the Cloud Run job `catalog-eval` (deployed by `infra/deploy.sh`), through
`infra/catalog-eval.sh exec <cli args>` from the repo root in Git Bash. All artifacts stay under
`gs://image-links-agent-assets/catalog-test/eval/<set>/`. Only `exec --live` sets `LIVE_SMOKE=1`.

1. Assemble a golden set (real photos, sampled per product):
   `bash infra/catalog-eval.sh exec assemble --set anta --brand anta --sample 10 --seed 1`
   `bash infra/catalog-eval.sh exec assemble --set french-connection --brand french_connection --sample 10 --seed 1`
2. Run one eval batch per matting candidate (`primary` = the primary list, or a model id):
   `bash infra/catalog-eval.sh exec run --set anta --matte primary --channels noon,styli`
   Candidates the services cannot serve are printed as "not run: ..." with the reason.
3. Label: open each printed `/catalog/<batchId>` page; eval mode shows every output with Pass / Flag.
4. Judge (live, costs credit; set the budget from the printed estimate):
   `EVAL_BUDGET_USD=2 bash infra/catalog-eval.sh exec --live judges --batch <id> --models google/gemini-2.5-flash-lite,anthropic/claude-haiku-5.5,qwen/qwen3-vl-30b-a3b-instruct`
5. Look: `contact-sheet --batch <id>` prints a signed URL.
6. Score and write: `score --set anta --batches <ids>`, `policy write --set anta --batches <ids> --dry-run`,
   then without `--dry-run`, then `report --set anta --batches <ids>`.
7. Clean up the eval batches (golden set sources stay): `cleanup --batches <ids>`.

Reading the report: per (brand, category) and judge it shows precision (judge passed and a human
passed, over judge passed; gate 97%), recall (human flagged and the judge flagged, over human flagged;
gate 90%), every `n`, the swept threshold, cost and ms per check; per matte model the compliance rate,
human edge flags, judge edge disagreements and ms per image on CPU and L4. A gate with no labels is
`no_labels`; a policy row with `gates.met = false` keeps QA per output until the next bake-off.
