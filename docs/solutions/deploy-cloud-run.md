# Deploying to Cloud Run - learnings

Lifted from the earlier image-links-agent app (2026-10-02) and adapted to the `catalog-*` services.
Script: `infra/deploy.sh`.

## Next.js standalone misses @google-cloud/tasks runtime files
Symptom (earlier app): enqueueing from the web service on Cloud Run returned 500; logs showed
`Cannot find module .../@google-cloud/tasks/build/esm/src/v2/cloud_tasks_client_config.json`.
Cause: the Tasks client (via google-gax) loads its client config and proto JSON by dynamic path, so
Next's output file tracing does not copy them into `.next/standalone`. Local `next dev` and unit tests
do not catch it. Fix: `outputFileTracingIncludes` in `apps/web/next.config.ts` for
`@google-cloud/tasks/build/**/*.json` and `google-gax/build/protos/**`. Verify with
`docker run ... node -e "new CloudTasksClient(...).initialize()"` inside the built image.
The worker is unaffected because it ships real node_modules via `pnpm deploy --prod`.

## Redeploy and "Setting IAM Policy"
`gcloud run deploy --no-allow-unauthenticated` re-applies service-level IAM on every deploy.
deploy.sh passes `--no-allow-unauthenticated` only when the service does not exist yet and
`--invoker-iam-check` afterwards (keeps the service private without touching IAM). Both
`catalog-worker` and `catalog-web` use this `auth_flag` pattern.

## The real cause of the earlier "hang": an interactive prompt
`gcloud run deploy --iap` needs `cloudresourcemanager.googleapis.com`; when it is disabled gcloud asks
"Would you like to enable and retry? (y/N)", which a non-interactive script waits on forever.
Fixes kept here: bootstrap.sh enables the API, and every deploy in deploy.sh passes `--quiet` so a
prompt fails fast instead of hanging.

## Cloud Run IAM at project level
The operator roles (roles/editor + projectIamAdmin + serviceAccountAdmin) may not allow
resource-level IAM on Cloud Run services. Grants that would normally sit on a service are made at
project level instead (for example `roles/run.invoker` for `catalog-worker@`, used for matting and
Cloud Scheduler calls). From 03, the `domain:opptra.com` IAP access grant is tried at resource level
first and falls back to project level with a WARN line.

## Windows / Git Bash
- Run the scripts from Git Bash: `bash infra/deploy.sh` in the repo root.
- `docker run -w /app/...` gets path-mangled by MSYS; prefix with `MSYS_NO_PATHCONV=1` for docker
  only. Setting it globally breaks the gcloud bash launcher.
- gcloud output has CRLF; scripts strip `\r` (`gcv()`) before comparing.
- deploy.sh writes the narrowed CORS file to a temp path and passes it through `cygpath -m` so both
  node and gcloud (Windows programs) can open it.

## Node 22, not Node 20
Spec 02 says Node 20; the images (`node:22-slim`), esbuild `target: node22`, `engines.node >=22` and
CI use Node 22 instead (approved by the owner on 2026-10-17: Node 20 is end of life). `undici`
(used by `safeFetch` to pin the checked address) needs Node 22.19 or newer.

## DB_HOST is the private IP
deploy.sh reads the address of type `PRIVATE` from `gcloud sql instances describe ila-pg`
(`ipAddresses.filter("type:PRIVATE")`), not `ipAddresses[0]`: with a public IP enabled the first
entry is the public one, which the services cannot reach with `--vpc-egress=private-ranges-only`.

## Rollback
deploy.sh tags images with the git short SHA. To roll back, check out the previous commit and run
`SKIP_BUILD=1 bash infra/deploy.sh`.
