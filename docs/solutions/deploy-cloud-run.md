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
`--invoker-iam-check` afterwards (keeps the service private without touching IAM). Every service
in the registry gets this through the deploy gate (`gate_deploy_args` in `infra/lib/gate.sh`).

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
first and falls back to project level with a WARN line. Spec 17 G1 (2026-10-28): `catalog-web@` gets
`roles/run.viewer` at project level (infra/bootstrap.sh, `project_binding`), read only, so the Ops page
can read Cloud Run service status and show the GPU candidate revision.

## Windows / Git Bash
- Run the scripts from Git Bash: `bash infra/deploy.sh` in the repo root.
- `docker run -w /app/...` gets path-mangled by MSYS; prefix with `MSYS_NO_PATHCONV=1` for docker
  only. Setting it globally breaks the gcloud bash launcher.
- gcloud output has CRLF; scripts strip `\r` (`gcv()`) before comparing.
- deploy.sh writes the narrowed CORS file to a temp path and passes it through `cygpath -m` so both
  node and gcloud (Windows programs) can open it.

## Cloud Run reserves /healthz
Symptom (spec 02 deploy, 2026-10-17): `GET $WORKER_URL/healthz` with a valid identity token returned
404 with Google's own HTML page (`Error 404 (Not Found)!!1`), and `gcloud logging read` showed no
request for that path on the `catalog-worker` revision. Cause: Cloud Run's Google Front End reserves
`/healthz` and answers it before the container. Unit tests and local runs do not catch it. Fix: every
health route on Cloud Run (worker, web, matting) is `/health`. Verify after a deploy with
`curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$WORKER_URL/health"` (200 with
`{ ok, version, routes }`; 403 without the token).

## Node 22, not Node 20
Spec 02 says Node 20; the images (`node:22-slim`), esbuild `target: node22`, `engines.node >=22` and
CI use Node 22 instead (approved by the owner on 2026-10-17: Node 20 is end of life). `undici`
(used by `safeFetch` to pin the checked address) needs Node 22.19 or newer.
The current Google Cloud client libraries also declare `engines.node >=22`
(`@google-cloud/storage` 8.x, `@google-cloud/bigquery` 9.x, `@google-cloud/tasks` 7.x,
`google-auth-library` 11.x, `google-gax` 6.x), so a Node 20 image is not an option for any service
that uses them.

## DB_HOST is the private IP
deploy.sh reads the address of type `PRIVATE` from `gcloud sql instances describe ila-pg`
(`ipAddresses.filter("type:PRIVATE")`), not `ipAddresses[0]`: with a public IP enabled the first
entry is the public one, which the services cannot reach with `--vpc-egress=private-ranges-only`.

## The deploy gate (spec 17 G2, 2026-10-28)
Why: on 2026-10-27 the smoke ran before any service was updated and copied the matting URLs from the
old worker, so it tested the old GPU revision; the broken GPU shape reached production traffic, and
the next deploy's smoke waited on the broken service for up to 3600 s, so the rollback had to bypass
deploy.sh. A lesson in a document is not a guard; these are the guards.

- Registry: `infra/lib/services.sh` lists the services in deploy order (`catalog-matting`,
  `catalog-matting-gpu`, `catalog-worker`, `catalog-web`). Each has one `service_<name>` function
  (region, image, flags, env, probe, probe timeout) and one probe. Adding a service is one name in
  `SERVICES`, one function and one probe; deploy.sh changes only when another service must read
  the new one's URL (as the worker reads the matting URLs).
- Gate: `deploy_service <name>` in `infra/lib/gate.sh` deploys a no-traffic revision tagged
  `candidate`, reads its tag URL from `status.traffic[].url` where `tag=candidate`, runs the probe
  against that URL under a hard timeout (GPU 600 s, worker 1800 s, others 300 s), and only then
  tags the outgoing revision `previous` and moves all traffic to exactly the probed revision
  (`--to-revisions <candidate>=100`, never `--to-latest`, which could hand traffic to a revision
  created meanwhile that no probe saw), printing `==> <name>: live (<revision>)`. On a failed
  probe the traffic stays where it was, the probe output is printed with the line
  `gcloud run services update-traffic <name> --to-revisions <previous>=100`, and deploy.sh stops;
  later services are not touched, and services this run already moved are listed with their
  `--rollback` commands.
- Probes: matting services run `infra/check-matting.sh --probe` (spec 17 G3) sized per service in
  the registry (`infra/lib/services.sh`): catalog-matting runs its default model with 1 warm call and
  1 round at concurrency 1 within 420 s (one CPU cut-out takes 25 to 71 s, measured 2026-10-28; the full
  probe took 21 min there); catalog-matting-gpu runs every served model, 5 rounds at the shape's
  concurrency, within 600 s (not yet timed on a candidate). The probe job's own task timeout equals the
  gate's, so a killed gate never leaves the job running. The worker probe is `/health` on the tag URL, then the tier 5 smoke with
  the matting and worker tag URLs (`infra/catalog-test-jobs.sh` takes `MATTING_URL`,
  `MATTING_GPU_URL` and `WORKER_URL` from the environment when set); the web probe is `/health`
  and `/` with the operator's identity token through IAP. `/` redirects to `/catalog`, so probes
  follow same-host redirects and need a final 200.
- SKIP: a service whose live revision has the same image digest and the same plain env values is
  not redeployed. The env carries `DEPLOY_ARGS_SHA`, a hash of every other deploy flag, so a change
  to concurrency, CPU or instances alone is still deployed. The worker's env carries
  `SMOKED_MATTING_REVISIONS=<cpu>/<gpu>`, the matting revisions its smoke ran against, so a new
  matting revision always re-runs the smoke, also on a re-run after a failed smoke (a flag such as
  "matting changed in this run" would be 0 on that re-run and SKIP the worker untested).
  `GATE_FORCE=1 bash infra/deploy.sh` deploys and probes every service anyway.
- Traffic is pinned to a named revision, so a hand-made `gcloud run services update` on a gated
  service creates a revision that takes no traffic. Ship changes through deploy.sh (or follow a
  hand update with `update-traffic --to-revisions <new>=100` after checking it).
- Queue slots for the worker are set right after the worker gate passes, so a later web failure
  never leaves them on the old values.
- The smoke never hangs on a broken cut-out service: `SMOKE_CUTOUT_READY_MS` (default 300000) is a
  hard ceiling on the readiness wait, past it the smoke fails with "the cut-out service did not
  become ready", and the smoke job's own timeout is 1500 s (was 3600 s).
- Preview: `CATALOG_PREVIEW=1` builds the GPU image too and deploys it as a no-traffic candidate of
  `catalog-matting-gpu` (probed, never shifted) under its own tag `preview-<sha>`, so a later deploy
  that moves `candidate` never changes what the preview worker calls; the preview worker calls that
  tag URL.
  A preview that needs the GPU image builds with `cloudbuild.yaml` instead of
  `infra/cloudbuild-preview.yaml`.
- GPU knobs (spec 17 3.3.2): `CUDNN_CONV_ALGO_SEARCH`, `CUDNN_CONV_USE_MAX_WORKSPACE` and
  `INFERENCE_LOCK_SCOPE` reach `catalog-matting-gpu` only when set (unset: not passed, the service
  default), so a candidate rung can move one knob per deploy. `infra/lib/shape.sh` (G3) defaults
  `INFERENCE_LOCK_SCOPE` to `global`, so that one is always passed.
- Jobs step: besides the QA, eval, scale and output-eval jobs, deploy.sh prepares the
  `catalog-invariants` job (spec 17 G1) through `CATALOG_TEST_JOBS=invariants infra/catalog-test-jobs.sh`,
  with the worker image and the live worker's service account, env and VPC. Deployed, never executed.
- Offline proof: `node infra/tests/gate.test.mjs` (fake gcloud). CI runs every `infra/tests/*.test.mjs`.

Cloud Run facts used (docs.cloud.google.com/run/docs/rollouts-rollbacks-traffic-migration, read
2026-10-28): `gcloud run deploy --no-traffic --tag <tag>` gives the new revision its own URL
`https://<tag>---<service>-<hash>.a.run.app` without serving traffic; a tag names one revision, so
the next `--tag candidate` moves it and at most one candidate exists; `update-traffic
--to-revisions <rev>=100` routes at once without new health checks. `--no-traffic` cannot be used
when the service does not exist yet, so the gate creates a new service without it (there is nothing
older to protect).

Open on the first gated deploy (not verifiable offline): catalog-web now has `GET /health`
(`{ok: true}`, no database call), but IAP must still accept the operator's identity token on the tag URL;
the matting probes run `infra/check-matting.sh --probe <tag URL> --models <m> --concurrency <n>
--rounds <k>` as a Cloud Run job. 2026-10-28: the first gated deploy measured the CPU probe (four models,
5 rounds) at 21 min against 300 s, so it was resized as above; a timeout fails safe (traffic stays). 2026-10-28, third gated deploy: the worker smoke got 401 from Cloud Run (in 0 s, no request reached
the container) on every call to the matting tag URLs, because the ID token's audience was the tag URL. Cloud Run
checks `aud` against the service URL, also for a tag URL, so every TS caller now derives the audience with
`cloudRunAudience(url)` (packages/core/src/cloud-run.ts: `https://<tag>---<host>` becomes `https://<host>`), the same
rule as the Python probe's `audience_for`. Note: a service has two URLs (`<service>-<project number>.<region>.run.app`
and `<service>-<hash>-<region code>.a.run.app`; not verified whether Cloud Run accepts both as `aud`), and the worker's own check
(apps/worker/src/auth.ts) compares with the service URL of its own WORKER_URL (number form), so a task enqueued with a hash-form tag WORKER_URL
could pass Cloud Run and still get the worker's 401. The smoke runs its tasks inline, so it is not affected.

## Rollback
One service, seconds, no build and no smoke: `bash infra/deploy.sh --rollback <service> [revision]`
moves all traffic to the given revision, by default the one the gate tagged `previous` when it last
moved traffic (the revision that served before; never a candidate that failed its probe). Without
that tag it refuses and asks for a revision name. It runs
`gcloud run services update-traffic <service> --to-revisions <revision>=100`.

Code: deploy.sh tags images with the git short SHA. To roll back, check out the previous source and
run `SKIP_BUILD=1 bash infra/deploy.sh` (safe now: the gate never hangs on a broken live service).
