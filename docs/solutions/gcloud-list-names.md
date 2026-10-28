# gcloud list prints short names on newer SDKs - learnings

## What differed
On Google Cloud SDK 589.0.0 (operator machine, Git Bash on Windows, 2026-10-20):
- `gcloud tasks queues list --location asia-south1 --format="value(name)"` prints short names
  (`catalog`, `catalog-ingest`, `generation`).
- `gcloud tasks queues describe catalog --location asia-south1 --format="value(name)"` and
  `list --format=json` still give the full `projects/image-links-agent/locations/asia-south1/queues/catalog`.
- `gcloud builds worker-pools list --format="value(name)"` also prints the short name, and
  `--filter="name=projects/.../workerPools/<pool>"` matches nothing (gcloud warns that full-name
  filter evaluation is changing).
The older SDK used in session 2 printed full names from list, so full-name greps worked there.

## Symptom
Deploy of `4f18be2` stopped at `==> worker` with
`ERROR: (gcloud.tasks.queues.create) ALREADY_EXISTS: Queue already exists`: the check grepped the
list output for the full name, missed, and tried to create an existing queue. Matting CPU and GPU
were updated; worker, web and jobs were not.

## Fix
Never compare `list` output against a full resource name. Strip each listed name to its basename
(`| sed 's#.*/##'`, after the CRLF strip) and compare with `grep -qxF "<short name>"`, which works
for both forms. A failed list still stops the script (`set -o pipefail`), so a permission error is
never mistaken for "missing". Applied in `infra/lib/queues.sh` (tasks queues) and
`infra/test-render-pool.sh` (worker pool). Checks that already use `describe`, or filter on a field
that is always short (`metadata.name` for Cloud Run jobs, `config.name` for services, Cloud SQL
user names), needed no change.

Offline proof: `node infra/tests/gcloud-list-names.test.mjs` (short, full and CRLF list output,
missing queue or pool, failing list).
