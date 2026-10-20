#!/usr/bin/env bash
# Order: preflight checks, build the images on Cloud Build, run DB migrations as the catalog-migrate
# Cloud Run job (additive; also seeds the first admin and the test brand test_brand), run the tier 5
# per-brand smoke on the just-built worker image as the Cloud Run job catalog-test-smoke, then
# deploy catalog-matting (CPU and GPU), catalog-worker and catalog-web (all private), IAP access,
# CORS, the catalog-qa-check, catalog-eval, catalog-load and catalog-recheck jobs (same worker
# image, deployed but not executed), and print the URLs. A failing smoke (any failed_compliance or
# overwrite assertion) stops the script before any service is updated. Migrations run before the
# smoke because the new image's smoke needs the migrated schema and the seeded test brand.
# Idempotent; re-run to ship a commit.
# Run infra/bootstrap.sh first.
#
# Usage (Git Bash, from the repo root): bash infra/deploy.sh
# Env overrides: SKIP_BUILD=1 (reuse the images tagged with the current commit; also the rollback
# path: check out an older commit and run SKIP_BUILD=1 bash infra/deploy.sh).
# CATALOG_LOCAL_SMOKE=1 runs the smoke in-process on this machine instead of the Cloud Run job
# (needs database and GCS access and REAL_DATA_DIR).
set -euo pipefail

PROJECT=image-links-agent
REGION=asia-south1
GPU_REGION=asia-southeast1
# Pin this project for every gcloud call without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
cd "$(dirname "$0")/.."

gcv() { gcloud "$@" | tr -d '\r'; }

TAG=$(git rev-parse --short HEAD)
AR=$REGION-docker.pkg.dev/$PROJECT/apps
WEB_SERVICE=catalog-web
WORKER_SERVICE=catalog-worker
QUEUE=catalog
BUILD_CONFIG=cloudbuild.yaml
CHUNK_IMAGES=${CATALOG_CHUNK_IMAGES:-25}
[[ "$CHUNK_IMAGES" =~ ^[1-9][0-9]*$ ]] || { echo "CATALOG_CHUNK_IMAGES must be a positive integer" >&2; exit 1; }
if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then
  WEB_SERVICE=catalog-web-preview
  WORKER_SERVICE=catalog-worker-preview
  QUEUE=catalog-preview
  BUILD_CONFIG=infra/cloudbuild-preview.yaml
fi
PN=$(gcv projects describe "$PROJECT" --format='value(projectNumber)')
WEB_SA=catalog-web@$PROJECT.iam.gserviceaccount.com
WORKER_SA=catalog-worker@$PROJECT.iam.gserviceaccount.com
MATTING_SA=catalog-matting@$PROJECT.iam.gserviceaccount.com
# Deterministic Cloud Run URLs; WORKER_URL is both the Cloud Tasks target and the OIDC audience.
WORKER_URL=https://$WORKER_SERVICE-$PN.$REGION.run.app
WEB_URL=https://$WEB_SERVICE-$PN.$REGION.run.app
CANONICAL_WEB_URL=https://catalog-web-$PN.$REGION.run.app
ASSETS_BUCKET=gs://image-links-agent-assets
# The private IP: services reach it through ila-vpc with --vpc-egress=private-ranges-only.
DB_HOST=$(gcv sql instances describe ila-pg --format='value(ipAddresses.filter("type:PRIVATE").extract(ipAddress).flatten())')

[ -n "$DB_HOST" ] || { echo "ila-pg has no private IP; run infra/bootstrap.sh first" >&2; exit 1; }
gcloud secrets describe catalog-db-password >/dev/null 2>&1 || { echo "secret catalog-db-password missing; run infra/bootstrap.sh first" >&2; exit 1; }
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: commit source changes before deploying; image tag $TAG must identify the source being built" >&2
  exit 1
fi

# --- 2. Build ------------------------------------------------------------------------
echo "==> build $TAG"
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  IMAGES=(worker web)
  if [ "${CATALOG_PREVIEW:-0}" != 1 ]; then IMAGES+=(matting matting-gpu); fi
  BUILD_NEEDED=0
  for image in "${IMAGES[@]}"; do
    if IMAGE_CHECK=$(gcloud artifacts docker images describe "$AR/$image:$TAG" 2>&1); then
      :
    elif grep -qiE 'NOT_FOUND|not found|does not exist' <<<"$IMAGE_CHECK"; then
      BUILD_NEEDED=1
    else
      printf '%s\n' "$IMAGE_CHECK" >&2
      echo "ERROR: cannot check existing images; stopping before a paid build" >&2
      exit 1
    fi
  done
  if [ "$BUILD_NEEDED" = 1 ]; then
    gcloud builds submit --config "$BUILD_CONFIG" --substitutions="_AR=$AR,_TAG=$TAG" .
  else
    echo "==> build: SKIP (images for $TAG already exist)"
  fi
else
  echo "SKIP_BUILD=1: reusing worker, web, matting and matting-gpu images tagged $TAG"
fi

# --- 3. Environment ------------------------------------------------------------------
ENV_VARS="GCP_PROJECT=$PROJECT,REGION=$REGION,BUCKET=image-links-agent-assets,PUBLIC_BUCKET=image-links-agent-public"
ENV_VARS+=",DB_HOST=$DB_HOST,DB_NAME=catalog,DB_USER=catalog_app"
ENV_VARS+=",TASKS_QUEUE=$QUEUE,WORKER_URL=$WORKER_URL,WORKER_SA_EMAIL=$WORKER_SA"
ENV_VARS+=",TASKS_INGEST_QUEUE=$QUEUE-ingest"
# BQ_PROJECT is where the sync's query jobs run and its unqualified table and UDF names resolve.
# image-links-agent is a temporary mirror of the warehouse masters (infra/bq-mirror.sh) until a
# warehouse admin grants catalog-worker@ access to opptra-datawarehouse; then set this default back
# to opptra-datawarehouse and redeploy. See docs/solutions/infra-bootstrap.md.
BQ_PROJECT=${BQ_PROJECT:-image-links-agent}
# --- Database connection budget (docs/solutions/db-connection-budget.md) ----------------------
# ila-pg is a shared db-f1-micro with no max_connections flag: Postgres allows 25 connections, 3 of
# them reserved for superusers (superuser_reserved_connections), so ordinary roles get 22. The
# earlier ila-web and ila-worker apps use the same instance; we assume 4 for them when idle (their
# pools are not ours to cap). That leaves 18 for the catalog, counted at the worst case (every
# service at max instances, every pool full):
#   worker 4 instances x pool 2 = 8   (concurrency 2, so one connection per in-flight task)
#   web    3 instances x pool 2 = 6   (queries are short; extra requests wait for a pooled client)
#   jobs   2 at a time x pool 1 = 2   (load, recheck, QA check, evals, migrate, smoke)
#   total                       = 16, headroom 2 of 18.
# 2026-10-20 incident: worker 10 x 2 + web 3 x 3 + jobs 2 x 2 = 33 > 18, every page failed.
# The Tasks queue dispatches at most worker instances x concurrency = 8 at once so a large batch
# queues tasks instead of hitting 429 "no available instance" and burning retry attempts.
# Raise the budget only after a tier or max_connections change in a maintenance window, then
# change DB_MAX_CONNECTIONS here; the check below refuses a shape that does not fit.
DB_MAX_CONNECTIONS=25
DB_RESERVED_CONNECTIONS=3
ILA_DB_SHARE=4
WORKER_MAX_INSTANCES=4
WORKER_CONCURRENCY=2
WORKER_DB_POOL_MAX=2
WEB_MAX_INSTANCES=3
WEB_DB_POOL_MAX=2
MAX_CONCURRENT_JOBS=2
JOB_DB_POOL_MAX=1
# The worker's slots are split between the two queues so they never exceed its capacity: the
# ingest queue (new-batch setup) keeps INGEST_MAX_DISPATCHES slots free of batch processing.
INGEST_MAX_DISPATCHES=2
TASKS_MAX_DISPATCHES=$((WORKER_MAX_INSTANCES * WORKER_CONCURRENCY - INGEST_MAX_DISPATCHES))
CATALOG_DB_LIMIT=$((DB_MAX_CONNECTIONS - DB_RESERVED_CONNECTIONS - ILA_DB_SHARE))
CATALOG_DB_TOTAL=$((WORKER_MAX_INSTANCES * WORKER_DB_POOL_MAX + WEB_MAX_INSTANCES * WEB_DB_POOL_MAX + MAX_CONCURRENT_JOBS * JOB_DB_POOL_MAX))
if [ "$CATALOG_DB_TOTAL" -gt "$CATALOG_DB_LIMIT" ]; then
  echo "ERROR: catalog connections $CATALOG_DB_TOTAL exceed the budget $CATALOG_DB_LIMIT; see docs/solutions/db-connection-budget.md" >&2
  exit 1
fi
echo "==> connection budget: catalog $CATALOG_DB_TOTAL of $CATALOG_DB_LIMIT"
# Semicolons, not commas: the value travels inside --set-env-vars. The load driver re-checks it.
DB_CONNECTION_BUDGET="max=$DB_MAX_CONNECTIONS;reserved=$DB_RESERVED_CONNECTIONS;ila=$ILA_DB_SHARE"
DB_CONNECTION_BUDGET+=";worker=${WORKER_MAX_INSTANCES}x$WORKER_DB_POOL_MAX;web=${WEB_MAX_INSTANCES}x$WEB_DB_POOL_MAX;jobs=${MAX_CONCURRENT_JOBS}x$JOB_DB_POOL_MAX"
WORKER_ENV="$ENV_VARS,DB_POOL_MAX=$WORKER_DB_POOL_MAX,BQ_PROJECT=$BQ_PROJECT,BQ_LOCATION=asia-south1,CATALOG_CHUNK_IMAGES=$CHUNK_IMAGES"
WORKER_ENV+=",DB_CONNECTION_BUDGET=$DB_CONNECTION_BUDGET"
# Jobs get the worker environment with the job pool size (budget above).
job_env() { printf '%s' "${WORKER_ENV/DB_POOL_MAX=$WORKER_DB_POOL_MAX,/DB_POOL_MAX=$JOB_DB_POOL_MAX,}"; }
# Compute spend: the worker records cost.computeUsd = vCPU-seconds * COMPUTE_USD_PER_VCPU_SECOND
# (spend is 0 when unset) and the wizard estimate prices compute with the same figure. Override
# from the shell like INR_PER_USD. Keep it equal to DEFAULT_COMPUTE_USD_PER_VCPU_SECOND in
# packages/core/src/catalog/cost.ts. Source: cloud.google.com/run/pricing, read 2026-10-20.
# asia-south1 is Tier 1; the worker uses request-based billing (no --no-cpu-throttling), so CPU is
# USD 0.000024 per vCPU-second and memory USD 0.0000025 per GiB-second. The worker shape is
# --cpu=2 --memory=2Gi, 1 GiB per vCPU: 0.000024 + 1 * 0.0000025 = 0.0000265 per vCPU-second
# (free tier and the per-request fee ignored). Re-check if the worker's shape or billing changes.
COMPUTE_USD_PER_VCPU_SECOND=${COMPUTE_USD_PER_VCPU_SECOND:-0.0000265}
[[ "$COMPUTE_USD_PER_VCPU_SECOND" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "COMPUTE_USD_PER_VCPU_SECOND must be a number such as 0.0000265" >&2; exit 1; }
WORKER_ENV+=",COMPUTE_USD_PER_VCPU_SECOND=$COMPUTE_USD_PER_VCPU_SECOND"
# 07: the QA judge and its spend caps. Override from the shell like BQ_PROJECT, e.g.
# INR_PER_USD=83.5 bash infra/deploy.sh. CATALOG_QA_DEFAULT_MODEL is engineering config only; it is
# never shown to the operator. It has no leading "/", so Git Bash leaves it alone.
# INR_PER_USD defaults to 84 (spec 07 4.11 states no rate) so the cost line and the wizard estimate
# show rupees; update when the rate moves.
CATALOG_QA_DEFAULT_MODEL=${CATALOG_QA_DEFAULT_MODEL:-google/gemini-2.5-flash-lite}
DAILY_SPEND_CAP_USD=${DAILY_SPEND_CAP_USD:-10}
INR_PER_USD=${INR_PER_USD:-84}
[[ "$CATALOG_QA_DEFAULT_MODEL" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+$ ]] || { echo "CATALOG_QA_DEFAULT_MODEL must look like provider/model" >&2; exit 1; }
[[ "$DAILY_SPEND_CAP_USD" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "DAILY_SPEND_CAP_USD must be a non-negative number" >&2; exit 1; }
[[ "$INR_PER_USD" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "INR_PER_USD must be a number such as 84" >&2; exit 1; }
WORKER_ENV+=",CATALOG_QA_DEFAULT_MODEL=$CATALOG_QA_DEFAULT_MODEL,DAILY_SPEND_CAP_USD=$DAILY_SPEND_CAP_USD"
WEB_ENV="$ENV_VARS,DB_POOL_MAX=$WEB_DB_POOL_MAX,SHARE_SA_EMAIL=$WEB_SA,CATALOG_CHUNK_IMAGES=$CHUNK_IMAGES"
# INR_PER_USD reaches the web (cost line, wizard estimate), the worker (finalize) and, through
# WORKER_ENV, the Cloud Run jobs (07 4.11). COMPUTE_USD_PER_VCPU_SECOND reaches the worker and the
# jobs through WORKER_ENV (above) and the web here, so the estimate and recorded spend agree.
WORKER_ENV+=",INR_PER_USD=$INR_PER_USD"
WEB_ENV+=",INR_PER_USD=$INR_PER_USD,COMPUTE_USD_PER_VCPU_SECOND=$COMPUTE_USD_PER_VCPU_SECOND"
# Spec 11: the GPU upscaler in the render. UPSCALE_MODEL names the model the GPU matting service runs at
# POST /upscale (realesrgan-x2plus or swinir-x2); unset or empty (the default) is off, and every render keeps
# the plain Lanczos path. UPSCALE_MIN_SCALE is the enlargement above which it is used (default 1.5, the
# variable canvases' cap). Engineering config only, never shown to the operator. Override from the shell
# like INR_PER_USD, e.g. UPSCALE_MODEL=realesrgan-x2plus bash infra/deploy.sh. UPSCALE_MODEL is written only
# when set (--set-env-vars replaces the worker environment, so a redeploy without it turns the upscaler off).
UPSCALE_MODEL=${UPSCALE_MODEL:-}
UPSCALE_MIN_SCALE=${UPSCALE_MIN_SCALE:-1.5}
[[ "$UPSCALE_MODEL" =~ ^[A-Za-z0-9._-]*$ ]] || { echo "UPSCALE_MODEL must be a model id such as realesrgan-x2plus, or empty" >&2; exit 1; }
[[ "$UPSCALE_MIN_SCALE" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "UPSCALE_MIN_SCALE must be a number such as 1.5" >&2; exit 1; }
WORKER_ENV+=",UPSCALE_MIN_SCALE=$UPSCALE_MIN_SCALE"
# UPSCALE_MODEL itself is added after the GPU matting step below, and only when that step yields MATTING_GPU_URL.
# 03: the web verifies the IAP JWT against this exact audience and accepts only this domain.
IAP_AUDIENCE=/projects/$PN/locations/$REGION/services/$WEB_SERVICE
WEB_ENV+=",IAP_AUDIENCE=$IAP_AUDIENCE,ALLOWED_HOSTED_DOMAIN=opptra.com"
# The migrate job seeds this person as the first admin (idempotent; never undoes a later role change).
MIGRATE_ENV="$(job_env),SEED_ADMIN_EMAIL=${SEED_ADMIN_EMAIL:-sujan@opptra.com}"
SECRETS=DB_PASSWORD=catalog-db-password:latest
# 07 sections 3 and 4.12: the OpenRouter key is mounted from Secret Manager on catalog-worker (the
# qa stage runs inside the worker pipeline) and on the Cloud Run jobs (catalog-qa-check, and
# catalog-eval in 08), never on catalog-web. Its value is never read or printed here. The smoke and
# the tests always use the mocked judge; the jobs call OpenRouter only when LIVE_SMOKE=1.
OPENROUTER_SECRET_REF=OPENROUTER_API_KEY=openrouter-api-key:latest
WORKER_SECRETS="$SECRETS,$OPENROUTER_SECRET_REF"
JOB_SECRETS="$SECRETS,$OPENROUTER_SECRET_REF"
NET=(--region="$REGION" --network=ila-vpc --subnet=ila-subnet --vpc-egress=private-ranges-only)

# --- 4. Migrations -------------------------------------------------------------------
echo "==> migrate"
if [ "${CATALOG_PREVIEW:-0}" != 1 ]; then
  MIGRATION_JOB=$(gcv run jobs list --region="$REGION" --filter='metadata.name=catalog-migrate' --format=json)
  if node -e '
    const jobs = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const job = jobs[0];
    process.exit(job?.spec?.template?.spec?.template?.spec?.containers?.[0]?.image === process.argv[1] &&
      job?.status?.latestCreatedExecution?.completionStatus === "EXECUTION_SUCCEEDED" ? 0 : 1);
  ' "$AR/worker:$TAG" <<<"$MIGRATION_JOB"; then
    echo "==> migrate: SKIP (this image already migrated successfully)"
  else
    gcloud run jobs deploy catalog-migrate --quiet --image="$AR/worker:$TAG" --command=node --args=dist/migrate.js \
      --service-account="$WORKER_SA" --max-retries=0 --task-timeout=600 "${NET[@]}" \
      --set-secrets="$SECRETS" --set-env-vars="$MIGRATE_ENV"
    gcloud run jobs execute catalog-migrate --region="$REGION" --wait
  fi
else
  echo "==> migrate: SKIP (preview uses the existing schema)"
fi

# --- 5. Smoke gate (tier 5, from 06 on) --------------------------------------------
# Runs on the just-built worker image before any service is updated; a non-zero exit stops the
# deploy. The job never calls OpenRouter and writes only under catalog-test/.
echo "==> smoke"
if [ "${CATALOG_LOCAL_SMOKE:-0}" = 1 ]; then
  pnpm --filter @catalog/worker build
  pnpm catalog:smoke
else
  SMOKE_RUN=$(node -e 'console.log(require("crypto").randomUUID())')
  CATALOG_TEST_RUN=$SMOKE_RUN CATALOG_TEST_JOBS=smoke bash infra/catalog-test-jobs.sh
  bash infra/catalog-smoke-linux.sh
  echo "==> smoke: passed (evidence: $ASSETS_BUCKET/catalog-test/smoke/linux-$SMOKE_RUN/smoke/)"
fi

# --no-allow-unauthenticated re-sets service IAM on every deploy; pass it only when creating the
# service and --invoker-iam-check afterwards (keeps it private without touching IAM).
# See docs/solutions/deploy-cloud-run.md.
auth_flag() {
  if gcloud run services describe "$1" --region="${2:-$REGION}" --format='value(metadata.name)' >/dev/null 2>&1; then
    echo "--invoker-iam-check"
  else
    echo "--no-allow-unauthenticated"
  fi
}

echo "==> matting CPU"
if [ "${CATALOG_PREVIEW:-0}" != 1 ]; then
  gcloud run deploy catalog-matting --quiet --image="$AR/matting:$TAG" \
    --service-account="$MATTING_SA" --region="$REGION" "$(auth_flag catalog-matting "$REGION")" \
    --cpu=4 --memory=16Gi --concurrency=1 --min-instances=0 --max-instances=20 --timeout=300
fi
MATTING_URL=$(gcv run services describe catalog-matting --region="$REGION" --format='value(status.url)')
[ -n "$MATTING_URL" ] || { echo "ERROR: CPU matting service has no URL" >&2; exit 1; }
WORKER_ENV+=",MATTING_URL=$MATTING_URL"

echo "==> matting GPU"
# A failed update can leave an older service running. Only this successful deployment supplies
# its URL; --set-env-vars below replaces the worker environment, clearing any stale GPU URL.
MATTING_GPU_URL=""
if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then
  # Reuse 05's existing matting endpoints; never change them from an unmerged preview.
  MATTING_GPU_URL=$(gcv run services describe catalog-worker --region="$REGION" \
    --format='value(spec.template.spec.containers[0].env.filter(name=MATTING_GPU_URL).value)')
  if [ -n "$MATTING_GPU_URL" ]; then WORKER_ENV+=",MATTING_GPU_URL=$MATTING_GPU_URL"; fi
elif GPU_ERR=$(gcloud run deploy catalog-matting-gpu --quiet --image="$AR/matting-gpu:$TAG" \
  --service-account="$MATTING_SA" --region="$GPU_REGION" "$(auth_flag catalog-matting-gpu "$GPU_REGION")" \
  --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy --no-cpu-throttling \
  --cpu=4 --memory=16Gi --concurrency=1 --min-instances=0 --max-instances=3 --timeout=300 2>&1); then
  MATTING_GPU_URL=$(gcv run services describe catalog-matting-gpu --region="$GPU_REGION" --format='value(status.url)')
  [ -n "$MATTING_GPU_URL" ] || { echo "ERROR: GPU matting service has no URL" >&2; exit 1; }
  WORKER_ENV+=",MATTING_GPU_URL=$MATTING_GPU_URL"
elif grep -qiE 'quota|RESOURCE_EXHAUSTED' <<<"$GPU_ERR"; then
  printf '%s\n' "$GPU_ERR" >&2
  echo "WARN: GPU quota refused; worker will use CPU. Request NVIDIA L4 (no zonal redundancy) quota in $GPU_REGION for project $PROJECT at https://console.cloud.google.com/iam-admin/quotas?project=$PROJECT" >&2
else
  printf '%s\n' "$GPU_ERR" >&2
  echo "ERROR: GPU deployment failed for a reason other than quota; stopping" >&2
  exit 1
fi
# Spec 11 4.5: the upscaler runs on the GPU service only, so the flag reaches the worker only with a GPU URL.
if [ -n "$UPSCALE_MODEL" ] && [ -z "$MATTING_GPU_URL" ]; then
  echo "WARN: UPSCALE_MODEL=$UPSCALE_MODEL ignored: no GPU matting service URL; the render keeps the plain path" >&2
  UPSCALE_MODEL=""
fi
if [ -n "$UPSCALE_MODEL" ]; then WORKER_ENV+=",UPSCALE_MODEL=$UPSCALE_MODEL"; fi

# --- 6. Worker -----------------------------------------------------------------------
echo "==> worker"
# Check-then-create the queues the env points at: the ingest queue always, so a deploy never sends
# ingest tasks to a missing queue, and the main queue on preview (bootstrap.sh makes it otherwise).
ENSURE_QUEUES="$QUEUE-ingest:$INGEST_MAX_DISPATCHES"
[ "${CATALOG_PREVIEW:-0}" = 1 ] && ENSURE_QUEUES="$QUEUE:$TASKS_MAX_DISPATCHES $ENSURE_QUEUES"
# gcloud 589 prints short queue names from list while older releases print the full
# projects/.../queues/<name>; compare basenames so both match (docs/solutions/gcloud-list-names.md).
EXISTING_QUEUES=$(gcv tasks queues list --location="$REGION" --format='value(name)' | sed 's#.*/##')
for Q in $ENSURE_QUEUES; do
  if grep -qxF "${Q%%:*}" <<<"$EXISTING_QUEUES"; then
    # Idempotent: keep the parallelism within the worker's capacity (connection budget above).
    gcloud tasks queues update "${Q%%:*}" --location="$REGION" --max-concurrent-dispatches="${Q##*:}" >/dev/null
    echo "==> tasks queue ${Q%%:*}: exists, max-concurrent-dispatches ${Q##*:}"
  else
    gcloud tasks queues create "${Q%%:*}" --location="$REGION" \
      --max-concurrent-dispatches="${Q##*:}" --max-attempts=5 --min-backoff=10s >/dev/null
  fi
done
gcloud run deploy "$WORKER_SERVICE" --quiet --image="$AR/worker:$TAG" --service-account="$WORKER_SA" \
  "$(auth_flag "$WORKER_SERVICE")" --cpu=2 --memory=2Gi --concurrency="$WORKER_CONCURRENCY" \
  --min-instances=0 --max-instances="$WORKER_MAX_INSTANCES" --timeout=900 "${NET[@]}" \
  --set-secrets="$WORKER_SECRETS" --set-env-vars="$WORKER_ENV"
if [ "${CATALOG_PREVIEW:-0}" != 1 ]; then
  # Idempotent: keep the queue's parallelism equal to the worker's capacity (connection budget above).
  gcloud tasks queues update "$QUEUE" --location="$REGION" --max-concurrent-dispatches="$TASKS_MAX_DISPATCHES" >/dev/null
  echo "==> tasks queue $QUEUE: max-concurrent-dispatches $TASKS_MAX_DISPATCHES"
fi

# --- 7. Web --------------------------------------------------------------------------
# Private (only IAP's service agent may invoke it; never --allow-unauthenticated) and behind IAP with
# the Google-managed OAuth client: no OAuth client, consent screen or secret of ours.
# MSYS2_ARG_CONV_EXCL: Git Bash would rewrite the "/projects/..." audience inside --set-env-vars into a
# Windows path (C:/.../Git/projects/...). Excluding only that flag keeps the conversion the gcloud
# launcher itself needs (MSYS_NO_PATHCONV=1 would break it).
echo "==> web"
MSYS2_ARG_CONV_EXCL='--set-env-vars=' \
gcloud run deploy "$WEB_SERVICE" --quiet --image="$AR/web:$TAG" --service-account="$WEB_SA" \
  "$(auth_flag "$WEB_SERVICE")" --iap --cpu=1 --memory=1Gi \
  --min-instances=0 --max-instances="$WEB_MAX_INSTANCES" --timeout=300 "${NET[@]}" \
  --set-secrets="$SECRETS" --set-env-vars="$WEB_ENV"

IAP_ENABLED=$(gcv run services describe "$WEB_SERVICE" --region="$REGION" \
  --format='value(metadata.annotations."run.googleapis.com/iap-enabled")')
if [ "$IAP_ENABLED" = true ]; then
  echo "==> IAP on $WEB_SERVICE: enabled"
else
  echo "ERROR: $WEB_SERVICE has run.googleapis.com/iap-enabled='$IAP_ENABLED', expected true" >&2
  exit 1
fi

# Who may sign in: every account of the Opptra Workspace domain. Resource level first
# (check-then-create); if the operator's roles deny it, project level with a WARN.
# See docs/solutions/catalog-iap.md.
IAP_MEMBER=domain:opptra.com
IAP_ROLE=roles/iap.httpsResourceAccessor
IAP_RESOURCE=(--resource-type=cloud-run --service="$WEB_SERVICE" --region="$REGION")
IAP_PROJECT_WARN="WARN: $IAP_ROLE for $IAP_MEMBER is granted at project level; this also lets every Opptra account open the earlier ila-web. See docs/solutions/catalog-iap.md."
IAP_POLICY=$(gcv iap web get-iam-policy "${IAP_RESOURCE[@]}" --flatten='bindings[].members' \
  --format='csv[no-heading](bindings.role,bindings.members)' 2>/dev/null || true)
# Read only when the resource-level check misses (the common re-run skips this gcloud call).
project_has_iap_binding() {
  local policy
  policy=$(gcv projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members)') || exit 1
  grep -qxF "$IAP_ROLE,$IAP_MEMBER" <<<"$policy"
}
if grep -qxF "$IAP_ROLE,$IAP_MEMBER" <<<"$IAP_POLICY"; then
  echo "==> IAP access: SKIP ($IAP_MEMBER holds $IAP_ROLE on $WEB_SERVICE)"
elif project_has_iap_binding; then
  echo "==> IAP access: SKIP ($IAP_MEMBER holds $IAP_ROLE at project level from an earlier run)"
  echo "$IAP_PROJECT_WARN" >&2
else
  echo "==> IAP access: CREATE $IAP_ROLE -> $IAP_MEMBER on $WEB_SERVICE"
  # Only a permission denial falls back to the wider project-level grant; any other failure (network,
  # quota, a bad flag) stops the deploy instead of silently widening access to ila-web.
  if ! IAP_ERR=$(gcloud iap web add-iam-policy-binding "${IAP_RESOURCE[@]}" --quiet \
      --member="$IAP_MEMBER" --role="$IAP_ROLE" --condition=None 2>&1 >/dev/null); then
    if ! grep -qiE 'PERMISSION_DENIED|does not have .*permission|permission denied' <<<"$IAP_ERR"; then
      echo "$IAP_ERR" >&2
      echo "ERROR: the resource-level IAP binding failed for a reason other than a permission denial" >&2
      exit 1
    fi
    echo "==> IAP access: resource-level binding denied; CREATE at project level instead"
    gcloud projects add-iam-policy-binding "$PROJECT" --quiet --condition=None \
      --member="$IAP_MEMBER" --role="$IAP_ROLE" >/dev/null
    echo "$IAP_PROJECT_WARN" >&2
  fi
fi

CURRENT_CORS=$(gcv storage buckets describe "$ASSETS_BUCKET" --format='json(cors_config)')
if node -e '
  const cur = (JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "null") ?? {}).cors_config ?? [];
  process.exit(cur.length > 0 && cur.every((r) => !r.origin?.includes("*") &&
    process.argv.slice(1).every((origin) => r.origin?.includes(origin))) ? 0 : 1);
' "$CANONICAL_WEB_URL" "$WEB_URL" <<<"$CURRENT_CORS"; then
  echo "==> CORS on $ASSETS_BUCKET: SKIP (catalog origins are present)"
else
  echo "==> CORS on $ASSETS_BUCKET: ADD catalog origins, preserving existing sites"
  CORS_FILE=$(mktemp)
  trap 'rm -f "$CORS_FILE"' EXIT
  node -e '
    const fs = require("fs");
    const current = (JSON.parse(fs.readFileSync(0, "utf8")).cors_config ?? []);
    const rules = current.length ? current : JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[4], JSON.stringify(rules.map((r) => ({ ...r,
      origin: [...new Set([...(r.origin ?? []).filter((o) => o !== "*"), process.argv[2], process.argv[3]])]
    }))));
  ' infra/cors.json "$CANONICAL_WEB_URL" "$WEB_URL" "$(cygpath -m "$CORS_FILE" 2>/dev/null || echo "$CORS_FILE")" <<<"$CURRENT_CORS"
  gcloud storage buckets update "$ASSETS_BUCKET" --cors-file="$(cygpath -m "$CORS_FILE" 2>/dev/null || echo "$CORS_FILE")" >/dev/null
fi

# --- 8. Jobs -------------------------------------------------------------------------
# 07: the tier 3 live QA job. Deployed (check-then-create/update) but never executed here; run it
# with "bash infra/catalog-qa-check.sh run" (sets LIVE_SMOKE=1 for that execution only).
echo "==> jobs"
if [ "${CATALOG_PREVIEW:-0}" != 1 ]; then
  QA_JOB_IMAGE="$AR/worker:$TAG" QA_JOB_ENV="$(job_env)" QA_JOB_SECRETS="$JOB_SECRETS" \
    bash infra/catalog-qa-check.sh deploy
  # 08: the bake-off CLI job (same image; WORKER_ENV carries MATTING_URL and MATTING_GPU_URL).
  # Deployed, never executed here; run it with "bash infra/catalog-eval.sh exec ...".
  EVAL_JOB_IMAGE="$AR/worker:$TAG" EVAL_JOB_ENV="$(job_env)" EVAL_JOB_SECRETS="$JOB_SECRETS" \
    bash infra/catalog-eval.sh deploy
  # 09: the load driver and the independent re-check (DB secret only, never the OpenRouter key).
  # Deployed here, never executed here: bash infra/catalog-scale-jobs.sh load | recheck ...
  SCALE_JOB_IMAGE="$AR/worker:$TAG" SCALE_JOB_ENV="$(job_env)" SCALE_JOB_SECRETS="$SECRETS" \
    bash infra/catalog-scale-jobs.sh deploy
  # 10: the output-quality eval suite (same image, OpenRouter key for the judge, LIVE_SMOKE only per
  # execution). Deployed here, never executed here: bash infra/catalog-output-evals.sh run [--live]
  EVALS_JOB_IMAGE="$AR/worker:$TAG" EVALS_JOB_ENV="$(job_env)" EVALS_JOB_SECRETS="$JOB_SECRETS"     bash infra/catalog-output-evals.sh deploy
else
  echo "==> jobs: SKIP (preview never changes the shared jobs)"
fi

# --- 9. URLs ---------------------------------------------------------------------------
echo "WEB_URL=$WEB_URL"
echo "WORKER_URL=$WORKER_URL"
echo "MATTING_URL=$MATTING_URL"
echo "MATTING_GPU_URL=${MATTING_GPU_URL:-not configured}"
echo "UPSCALE_MODEL=${UPSCALE_MODEL:-off}"
