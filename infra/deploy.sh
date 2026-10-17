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
# Pin this project for every gcloud call without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
cd "$(dirname "$0")/.."

gcv() { gcloud "$@" | tr -d '\r'; }

TAG=$(git rev-parse --short HEAD)
AR=$REGION-docker.pkg.dev/$PROJECT/apps
PN=$(gcv projects describe "$PROJECT" --format='value(projectNumber)')
WEB_SA=catalog-web@$PROJECT.iam.gserviceaccount.com
WORKER_SA=catalog-worker@$PROJECT.iam.gserviceaccount.com
# Deterministic Cloud Run URLs; WORKER_URL is both the Cloud Tasks target and the OIDC audience.
WORKER_URL=https://catalog-worker-$PN.$REGION.run.app
WEB_URL=https://catalog-web-$PN.$REGION.run.app
ASSETS_BUCKET=gs://image-links-agent-assets
# The private IP: services reach it through ila-vpc with --vpc-egress=private-ranges-only.
DB_HOST=$(gcv sql instances describe ila-pg --format='value(ipAddresses.filter("type:PRIVATE").extract(ipAddress).flatten())')

[ -n "$DB_HOST" ] || { echo "ila-pg has no private IP; run infra/bootstrap.sh first" >&2; exit 1; }
gcloud secrets describe catalog-db-password >/dev/null 2>&1 || { echo "secret catalog-db-password missing; run infra/bootstrap.sh first" >&2; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "WARNING: uncommitted changes; the image tag $TAG will not match the working tree" >&2
fi

# --- 1. Smoke gate (tier 5, from 06 on) --------------------------------------------
# Runs before the build; a failing smoke (any failed_compliance) stops the deploy.
if [ -f apps/worker/src/catalog-smoke.ts ]; then
  echo "==> smoke"
  pnpm --filter @catalog/worker build
  pnpm catalog:smoke
else
  echo "==> smoke: SKIP (the catalog-smoke entry arrives with spec 06)"
fi

# --- 2. Build ------------------------------------------------------------------------
echo "==> build $TAG"
if [ "${SKIP_BUILD:-0}" != 1 ]; then
  gcloud builds submit --config cloudbuild.yaml --substitutions="_AR=$AR,_TAG=$TAG" .
else
  echo "SKIP_BUILD=1: reusing $AR/worker:$TAG and $AR/web:$TAG"
fi

# --- 3. Environment ------------------------------------------------------------------
ENV_VARS="GCP_PROJECT=$PROJECT,REGION=$REGION,BUCKET=image-links-agent-assets,PUBLIC_BUCKET=image-links-agent-public"
ENV_VARS+=",DB_HOST=$DB_HOST,DB_NAME=catalog,DB_USER=catalog_app"
ENV_VARS+=",TASKS_QUEUE=catalog,WORKER_URL=$WORKER_URL,WORKER_SA_EMAIL=$WORKER_SA"
WORKER_ENV="$ENV_VARS,DB_POOL_MAX=2,BQ_PROJECT=opptra-datawarehouse,BQ_LOCATION=asia-south1"
WEB_ENV="$ENV_VARS,DB_POOL_MAX=3,SHARE_SA_EMAIL=$WEB_SA"
# 03: the web verifies the IAP JWT against this exact audience and accepts only this domain.
IAP_AUDIENCE=/projects/$PN/locations/$REGION/services/catalog-web
WEB_ENV+=",IAP_AUDIENCE=$IAP_AUDIENCE,ALLOWED_HOSTED_DOMAIN=opptra.com"
# The migrate job seeds this person as the first admin (idempotent; never undoes a later role change).
MIGRATE_ENV="$WORKER_ENV,SEED_ADMIN_EMAIL=${SEED_ADMIN_EMAIL:-sujan@opptra.com}"
# 05 adds MATTING_URL (and MATTING_GPU_URL) to the worker; 07 adds
# OPENROUTER_API_KEY=openrouter-api-key:latest to the worker's secrets.
SECRETS=DB_PASSWORD=catalog-db-password:latest
NET=(--region="$REGION" --network=ila-vpc --subnet=ila-subnet --vpc-egress=private-ranges-only)

# --- 4. Migrations -------------------------------------------------------------------
echo "==> migrate"
gcloud run jobs deploy catalog-migrate --quiet --image="$AR/worker:$TAG" --command=node --args=dist/migrate.js \
  --service-account="$WORKER_SA" --max-retries=0 --task-timeout=600 "${NET[@]}" \
  --set-secrets="$SECRETS" --set-env-vars="$MIGRATE_ENV"
gcloud run jobs execute catalog-migrate --region="$REGION" --wait

# --no-allow-unauthenticated re-sets service IAM on every deploy; pass it only when creating the
# service and --invoker-iam-check afterwards (keeps it private without touching IAM).
# See docs/solutions/deploy-cloud-run.md.
auth_flag() {
  if gcloud run services describe "$1" --region="$REGION" --format='value(metadata.name)' >/dev/null 2>&1; then
    echo "--invoker-iam-check"
  else
    echo "--no-allow-unauthenticated"
  fi
}

# --- 5. Worker -----------------------------------------------------------------------
echo "==> worker"
gcloud run deploy catalog-worker --quiet --image="$AR/worker:$TAG" --service-account="$WORKER_SA" \
  "$(auth_flag catalog-worker)" --cpu=2 --memory=2Gi --concurrency=2 \
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
gcloud run deploy catalog-web --quiet --image="$AR/web:$TAG" --service-account="$WEB_SA" \
  "$(auth_flag catalog-web)" --iap --cpu=1 --memory=1Gi \
  --min-instances=0 --max-instances=3 --timeout=300 "${NET[@]}" \
  --set-secrets="$SECRETS" --set-env-vars="$WEB_ENV"

IAP_ENABLED=$(gcv run services describe catalog-web --region="$REGION" \
  --format='value(metadata.annotations."run.googleapis.com/iap-enabled")')
if [ "$IAP_ENABLED" = true ]; then
  echo "==> IAP on catalog-web: enabled"
else
  echo "ERROR: catalog-web has run.googleapis.com/iap-enabled='$IAP_ENABLED', expected true" >&2
  exit 1
fi

# Who may sign in: every account of the Opptra Workspace domain. Resource level first
# (check-then-create); if the operator's roles deny it, project level with a WARN.
# See docs/solutions/catalog-iap.md.
IAP_MEMBER=domain:opptra.com
IAP_ROLE=roles/iap.httpsResourceAccessor
IAP_RESOURCE=(--resource-type=cloud-run --service=catalog-web --region="$REGION")
IAP_PROJECT_WARN="WARN: $IAP_ROLE for $IAP_MEMBER is granted at project level; this also lets every Opptra account open the earlier ila-web. See docs/solutions/catalog-iap.md."
IAP_POLICY=$(gcv iap web get-iam-policy "${IAP_RESOURCE[@]}" --flatten='bindings[].members' \
  --format='csv[no-heading](bindings.role,bindings.members)' 2>/dev/null || true)
PROJECT_POLICY=$(gcv projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
  --format='csv[no-heading](bindings.role,bindings.members)')
if grep -qxF "$IAP_ROLE,$IAP_MEMBER" <<<"$IAP_POLICY"; then
  echo "==> IAP access: SKIP ($IAP_MEMBER holds $IAP_ROLE on catalog-web)"
elif grep -qxF "$IAP_ROLE,$IAP_MEMBER" <<<"$PROJECT_POLICY"; then
  echo "==> IAP access: SKIP ($IAP_MEMBER holds $IAP_ROLE at project level from an earlier run)"
  echo "$IAP_PROJECT_WARN" >&2
else
  echo "==> IAP access: CREATE $IAP_ROLE -> $IAP_MEMBER on catalog-web"
  if ! gcloud iap web add-iam-policy-binding "${IAP_RESOURCE[@]}" --quiet \
      --member="$IAP_MEMBER" --role="$IAP_ROLE" --condition=None >/dev/null; then
    echo "==> IAP access: resource-level binding denied; CREATE at project level instead"
    gcloud projects add-iam-policy-binding "$PROJECT" --quiet --condition=None \
      --member="$IAP_MEMBER" --role="$IAP_ROLE" >/dev/null
    echo "$IAP_PROJECT_WARN" >&2
  fi
fi

# --- 7. Matting services: added by 05 ------------------------------------------------

# --- Assets bucket CORS: origin narrowed from "*" to the web URL after the first deploy ----
CURRENT_CORS=$(gcv storage buckets describe "$ASSETS_BUCKET" --format='json(cors_config)')
if node -e '
  const cur = (JSON.parse(require("fs").readFileSync(0, "utf8").trim() || "null") ?? {}).cors_config ?? [];
  process.exit(cur.length > 0 && cur.every((r) => (r.origin || []).length === 1 && r.origin[0] === process.argv[1]) ? 0 : 1);
' "$WEB_URL" <<<"$CURRENT_CORS"; then
  echo "==> CORS on $ASSETS_BUCKET: SKIP (origin is $WEB_URL)"
else
  echo "==> CORS on $ASSETS_BUCKET: UPDATE origin to $WEB_URL"
  CORS_FILE=$(mktemp)
  trap 'rm -f "$CORS_FILE"' EXIT
  node -e '
    const fs = require("fs");
    const rules = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).map((r) => ({ ...r, origin: [process.argv[2]] }));
    fs.writeFileSync(process.argv[3], JSON.stringify(rules));
  ' infra/cors.json "$WEB_URL" "$(cygpath -m "$CORS_FILE" 2>/dev/null || echo "$CORS_FILE")"
  gcloud storage buckets update "$ASSETS_BUCKET" --cors-file="$(cygpath -m "$CORS_FILE" 2>/dev/null || echo "$CORS_FILE")" >/dev/null
fi

# --- 8. URLs ---------------------------------------------------------------------------
echo "web:    $WEB_URL"
echo "worker: $WORKER_URL"
