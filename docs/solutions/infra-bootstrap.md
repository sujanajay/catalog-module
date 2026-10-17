# Infra bootstrap - learnings

Lifted from the earlier image-links-agent app and adapted to the `catalog-*` resources.
Script: `infra/bootstrap.sh` (idempotent, check-then-create, never deletes). Run it with
`bash infra/bootstrap.sh` from Git Bash in the repo root. It pins
`CLOUDSDK_CORE_PROJECT=image-links-agent`; it never runs `gcloud config set`.

## Shared resources are checked, never created
`ila-vpc`, `ila-subnet`, Cloud SQL `ila-pg`, Artifact Registry `apps`, bucket
`gs://image-links-agent-assets` and secret `openrouter-api-key` belong to the earlier app. The script
only describes them and stops with a clear message if one is missing. On the shared assets bucket it
sets only the catalog lifecycle rule (scoped to `catalog/` and `catalog-test/`) and CORS when none is
set; the bucket had neither before this module (checked 2026-10-17).

## Output and exit codes
Every step prints `SKIP` (exists) or `CREATE` / `UPDATE`. A second run prints only SKIP lines.
Exit 0 = done; 1 = error; 2 = finished, but something needs a human (listed at the end, for example
an org policy or BigQuery rights in another project).

## Non-obvious things
- **gcloud output on Windows is CRLF.** `value(...)` output ends in `\r`, so `grep -x` never matched.
  Every parsed gcloud output goes through `gcv() { gcloud "$@" | tr -d '\r'; }`.
- **Do not set `MSYS_NO_PATHCONV=1`** globally in Git Bash: it breaks the gcloud bash launcher
  (python.exe receives `C:\c\Users\...\gcloud.py`). No argument in the script starts with `/`, so
  MSYS path conversion is harmless.
- `gcloud beta services identity create` is idempotent but always prints "created"; the script only
  calls it when the IAP service agent is not already in the project IAM policy.
- IAM existence checks use `get-iam-policy --flatten=bindings[].members
  --format='csv[no-heading](bindings.role,bindings.members)'` and an exact line match, rather than
  `--filter` on member strings with `:`/`@`.
- Lifecycle configs are compared as JSON (key order ignored, via node) against the file, so a re-run
  is SKIP and an edited file is applied as UPDATE. `gcloud storage buckets describe
  --format='json(lifecycle_config)'` prints `null` when the bucket has no lifecycle.
- GCS lifecycle conditions match only by prefix (`matchesPrefix`) or suffix (`matchesSuffix`), never by
  a folder in the middle of the name. Rules for `/uploads/`, `/derived/` and `/staging/` under
  `catalog/<brand>/<batch>/` therefore cannot be written as conditions; `lifecycle-assets.json` only
  carries the `daysSinceCustomTime: 180` rule (superseded raw, whose `customTime` the publish step sets).
  Consequence: batch uploads, derived mattes and staging JPEGs in the private bucket are never removed
  automatically (the spec's 180-day and 30-day rules are not applied). Storage grows with every batch
  until a later spec adds a sweep-based cleanup or moves scratch data under a prefix a rule can match.
- DB password: generated with `openssl rand`, piped to `gcloud secrets create --data-file=-`, and
  the SQL user is created through the Cloud SQL Admin API (`users.insert`) with curl reading its token,
  headers and body from stdin (`curl -K -`). Never pass a secret as a gcloud flag: gcloud writes every
  flag value to its debug log (`%APPDATA%\gcloud\logs\<date>\*.log`, "Running [...] with arguments"),
  and a flag is visible in the process list. The first bootstrap run (2026-10-17) still used
  `gcloud sql users create --password`, so that day's log held the `catalog_app` password. That
  password was rotated the same day: secret `catalog-db-password` version 2 holds the current value,
  so the logged value is dead. Still delete that log file (and the earlier app's 2026-10-02 log, which
  holds `ila_app`'s), and disable version 1 of the secret once nothing reads it. If the secret exists
  but the user does not, a new secret version is added and the user is created. If the user exists
  but the secret does not, the script stops rather than resetting the password.
- An expired gcloud login makes `add-iam-policy-binding` print a reauth error; re-run
  `gcloud auth login` and verify with `gcloud projects get-iam-policy`.

## IAM: resource level first, project level as fallback
- Service-account bindings (`roles/iam.serviceAccountTokenCreator` for `catalog-web@` on itself,
  `roles/iam.serviceAccountUser` on `catalog-worker@`) and secret bindings
  (`roles/secretmanager.secretAccessor` on `catalog-db-password`, and on `openrouter-api-key` for the
  worker) are tried at resource level and fall back to project level with a WARN line. Secrets are
  bound per secret because this project also holds other apps' secrets.
- **Secret access fell back to project level (2026-10-17).** `gcloud secrets add-iam-policy-binding`
  on `catalog-db-password` was denied (the operator lacks `secretmanager.secrets.setIamPolicy`), so
  `catalog-web@` and `catalog-worker@` hold `roles/secretmanager.secretAccessor` at project level.
  Both can therefore read every secret in the project, including `openrouter-api-key` and the earlier
  app's secrets (the worker's `openrouter-api-key` binding is SKIP for that reason). To narrow it, an
  admin with Secret Manager IAM rights grants the role per secret and removes the project binding.
- Bucket bindings are never widened to project level: that would give `catalog-web@` write access to
  the public bucket. A denial prints the exact command and the script exits 2.
- `catalog-worker@` gets `roles/storage.objectUser` on the public bucket (overwrite and scoped delete
  need `storage.objects.delete`); if that role is unavailable it falls back to
  `roles/storage.objectAdmin` on that bucket only, with a WARN line.
- The Cloud Build default SA in this project is the compute SA
  (`<project-number>-compute@developer.gserviceaccount.com`); it already had builder, Artifact
  Registry writer, log writer and object viewer from the earlier app.

## Known blockers (checked read-only on 2026-10-17)
- **Public read on `gs://image-links-agent-public`.** The effective org policy
  `constraints/iam.allowedPolicyMemberDomains` allows only the Opptra customer id, so the
  `allUsers -> roles/storage.objectViewer` binding is expected to be refused. The script prints the
  policy name and exits 2; an org policy admin must allow `allUsers` for this project (or this
  bucket), then re-run. `constraints/storage.publicAccessPrevention` is not enforced.
- **BigQuery in `opptra-datawarehouse`.** Granting `roles/bigquery.jobUser` there needs IAM rights in
  that project. When a grant cannot be applied, the script prints the exact commands and exits 2;
  an admin of that project runs them, then re-runs the script.

## BigQuery dataset grants
- `bq add-iam-policy-binding` does not support datasets (tables and views only). Dataset access is
  granted with the DCL statement
  ``GRANT `roles/bigquery.dataViewer` ON SCHEMA `opptra-datawarehouse`.<dataset> TO "serviceAccount:..."``, run with `bq query --project_id=image-links-agent
  --location=asia-south1 --nouse_legacy_sql`. The query job runs in this project; the statement needs
  `bigquery.datasets.update` on the target dataset. The check reads `bq show --format=prettyjson`,
  where the grant appears as a `READER` access entry.
- In Git Bash on Windows the `bq` launcher can pick a python it cannot start
  (`python3.11: command not found`). The script then sets `CLOUDSDK_BQ_PYTHON` to the Cloud SDK's
  bundled `platform/bundledpython/python.exe`, for `bq` only and only in its own shell; gcloud config is
  never changed.
