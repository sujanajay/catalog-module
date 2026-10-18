#!/usr/bin/env bash
# Build the images on Cloud Build, run DB migrations as the catalog-migrate Cloud Run job, then
# deploy catalog-worker and catalog-web (both private). Idempotent; re-run to ship a new commit.
# Run infra/bootstrap.sh first.
#
# Usage (Git Bash, from the repo root): bash infra/deploy.sh
# Env overrides: SKIP_BUILD=1 (reuse the images tagged with the current commit; also the rollback
# path: check out an older commit and run SKIP_BUILD=1 bash infra/deploy.sh).
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

# --- 1. Smoke gate (tier 5, from 06 on) --------------------------------------------
# Runs before the build; a failing smoke (any failed_compliance) stops the deploy.
echo "==> smoke"
if [ "${CATALOG_REMOTE_SMOKE:-0}" = 1 ]; then
  bash infra/catalog-smoke-linux.sh
else
  pnpm --filter @catalog/worker build
  pnpm catalog:smoke
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
# BQ_PROJECT is where the sync's query jobs run and its unqualified table and UDF names resolve.
# image-links-agent is a temporary mirror of the warehouse masters (infra/bq-mirror.sh) until a
# warehouse admin grants catalog-worker@ access to opptra-datawarehouse; then set this default back
# to opptra-datawarehouse and redeploy. See docs/solutions/infra-bootstrap.md.
BQ_PROJECT=${BQ_PROJECT:-image-links-agent}
WORKER_ENV="$ENV_VARS,DB_POOL_MAX=2,BQ_PROJECT=$BQ_PROJECT,BQ_LOCATION=asia-south1,CATALOG_CHUNK_IMAGES=$CHUNK_IMAGES"
if [ -n "${COMPUTE_USD_PER_VCPU_SECOND:-}" ]; then
  WORKER_ENV+=",COMPUTE_USD_PER_VCPU_SECOND=$COMPUTE_USD_PER_VCPU_SECOND"
fi
WEB_ENV="$ENV_VARS,DB_POOL_MAX=3,SHARE_SA_EMAIL=$WEB_SA,CATALOG_CHUNK_IMAGES=$CHUNK_IMAGES"
# 03: the web verifies the IAP JWT against this exact audience and accepts only this domain.
IAP_AUDIENCE=/projects/$PN/locations/$REGION/services/$WEB_SERVICE
WEB_ENV+=",IAP_AUDIENCE=$IAP_AUDIENCE,ALLOWED_HOSTED_DOMAIN=opptra.com"
# The migrate job seeds this person as the first admin (idempotent; never undoes a later role change).
MIGRATE_ENV="$WORKER_ENV,SEED_ADMIN_EMAIL=${SEED_ADMIN_EMAIL:-sujan@opptra.com}"
SECRETS=DB_PASSWORD=catalog-db-password:latest
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

# --- 5. Worker -----------------------------------------------------------------------
echo "==> worker"
if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then
  PREVIEW_QUEUES=$(gcv tasks queues list --location="$REGION" --filter="name:/$QUEUE" --format='value(name)')
  if grep -qxF "projects/$PROJECT/locations/$REGION/queues/$QUEUE" <<<"$PREVIEW_QUEUES"; then
    echo "==> tasks queue $QUEUE: SKIP"
  else
    gcloud tasks queues create "$QUEUE" --location="$REGION" \
      --max-concurrent-dispatches=20 --max-attempts=5 --min-backoff=10s >/dev/null
  fi
fi
gcloud run deploy "$WORKER_SERVICE" --quiet --image="$AR/worker:$TAG" --service-account="$WORKER_SA" \
  "$(auth_flag "$WORKER_SERVICE")" --cpu=2 --memory=2Gi --concurrency=2 \
  --min-instances=0 --max-instances=10 --timeout=900 "${NET[@]}" \
  --set-secrets="$SECRETS" --set-env-vars="$WORKER_ENV"

# --- 6. Web --------------------------------------------------------------------------
# Private (only IAP's service agent may invoke it; never --allow-unauthenticated) and behind IAP with
# the Google-managed OAuth client: no OAuth client, consent screen or secret of ours.
# MSYS2_ARG_CONV_EXCL: Git Bash would rewrite the "/projects/..." audience inside --set-env-vars into a
# Windows path (C:/.../Git/projects/...). Excluding only that flag keeps the conversion the gcloud
# launcher itself needs (MSYS_NO_PATHCONV=1 would break it).
echo "==> web"
MSYS2_ARG_CONV_EXCL='--set-env-vars=' \
gcloud run deploy "$WEB_SERVICE" --quiet --image="$AR/web:$TAG" --service-account="$WEB_SA" \
  "$(auth_flag "$WEB_SERVICE")" --iap --cpu=1 --memory=1Gi \
  --min-instances=0 --max-instances=3 --timeout=300 "${NET[@]}" \
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

# --- 8. URLs ---------------------------------------------------------------------------
echo "WEB_URL=$WEB_URL"
echo "WORKER_URL=$WORKER_URL"
echo "MATTING_URL=$MATTING_URL"
echo "MATTING_GPU_URL=${MATTING_GPU_URL:-not configured}"
