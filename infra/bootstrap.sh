#!/usr/bin/env bash
# Bootstrap the catalog-* GCP resources (spec 02 "Infra: infra/bootstrap.sh").
# Check-then-create and re-runnable: every step looks for the resource first and prints SKIP when it
# exists. Never deletes anything. Never prints, logs or stores the database password. Shared
# resources of the earlier app (ila-vpc, ila-subnet, ila-pg, Artifact Registry repo apps, bucket
# image-links-agent-assets, secret openrouter-api-key) are only checked, never created or changed,
# except the catalog/ lifecycle rule and CORS on the assets bucket (spec step 5).
#
# Usage (Git Bash, from the repo root): bash infra/bootstrap.sh
# Exit codes: 0 done; 1 error; 2 finished but something needs a human (printed at the end).
set -euo pipefail

PROJECT=image-links-agent
REGION=asia-south1
# The operator's default gcloud project is a different one; pin this project for every gcloud call
# in this script without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
# NOTE (Git Bash on Windows): do NOT export MSYS_NO_PATHCONV=1 here; it breaks the gcloud bash
# launcher. No argument below starts with "/", so MSYS path conversion is harmless.

cd "$(dirname "$0")/.."

# --- Builder constants -------------------------------------------------------
SCHEDULER_TZ=Asia/Kolkata
SYNC_MASTER_CRON="30 2 * * *"   # nightly at 02:30 IST
SWEEP_CRON="*/10 * * * *"       # every 10 minutes (spec 15: lost chunk tasks come back within 30 min)

# Shared (checked only).
VPC=ila-vpc
SUBNET=ila-subnet
SQL_INSTANCE=ila-pg
REPO=apps
ASSETS_BUCKET=gs://image-links-agent-assets
OPENROUTER_SECRET=openrouter-api-key

# New catalog resources.
DB_NAME=catalog
DB_USER=catalog_app
DB_SECRET=catalog-db-password
PUBLIC_BUCKET=gs://image-links-agent-public
QUEUE=catalog
# New-batch setup (ingest) runs on its own queue so it never waits behind batch processing.
INGEST_QUEUE=catalog-ingest
BQ_PROJECT=opptra-datawarehouse
# The datasets the master sync reads (packages/core/src/catalog/master-sync.ts).
BQ_DATASETS=(raw_gcc_dimensions fact_gcc)

log()    { printf '[bootstrap] %s\n' "$*"; }
skip()   { printf '[bootstrap] SKIP   %s\n' "$*"; }
create() { printf '[bootstrap] CREATE %s\n' "$*"; }
update() { printf '[bootstrap] UPDATE %s\n' "$*"; }
warn()   { printf '[bootstrap] WARN   %s\n' "$*" >&2; }
die()    { printf '[bootstrap] ERROR  %s\n' "$*" >&2; exit 1; }

# Things a human must do; printed at the end and turned into exit code 2.
TODO=()
needs_human() { TODO+=("$*"); warn "$*"; }

# gcloud on Windows emits CRLF; strip CR from anything we parse.
gcv() { gcloud "$@" | tr -d '\r'; }

# Retry a command a few times (IAM on freshly created SAs can lag a few seconds).
retry() {
  local n=0 max=6
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge "$max" ]; then return 1; fi
    # stderr, so a retried command's output can be captured: current=$(retry gcv ...).
    log "retry $n/$max in $((n * 5))s: $*" >&2
    sleep $((n * 5))
  done
}

# json_key_matches <json> <file> <key>: compares key <key> of the JSON text <json> (gcloud output) with the JSON in
# <file> as a set: object key order, array order (lifecycle rules, matchesPrefix) and whitespace are ignored.
# Exit 0 when equal; 1 when they differ, with both sides printed in canonical form so an UPDATE says what differed;
# 2 when either side is not JSON. The gcloud output reaches node through the environment, not a pipe or an argument.
json_key_matches() {
  JSON_CURRENT=$1 node -e '
    const fs = require("fs");
    const canon = (v) => Array.isArray(v) ? v.map(canon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
    let cur, want;
    try {
      cur = (JSON.parse(process.env.JSON_CURRENT.replace(/^\uFEFF/, "").trim() || "null") ?? {})[process.argv[2]] ?? null;
      want = JSON.parse(fs.readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""));
    } catch (e) {
      console.error(`[bootstrap]        cannot compare: ${e.message}`);
      process.exit(2);
    }
    const [a, b] = [JSON.stringify(canon(cur)), JSON.stringify(canon(want))];
    if (a === b) process.exit(0);
    console.log(`[bootstrap]        live: ${a}`);
    console.log(`[bootstrap]        file: ${b}`);
    process.exit(1);
  ' "$2" "$3"
}

command -v node >/dev/null || die "node is required (used to compare JSON configs)"
command -v openssl >/dev/null || die "openssl is required (Git for Windows ships it)"
command -v curl >/dev/null || die "curl is required (Git for Windows ships it)"

PN=$(gcv projects describe "$PROJECT" --format='value(projectNumber)')
[ -n "$PN" ] || die "cannot read project $PROJECT; run gcloud auth login"
WEB=catalog-web@$PROJECT.iam.gserviceaccount.com
WORKER=catalog-worker@$PROJECT.iam.gserviceaccount.com
MATTING=catalog-matting@$PROJECT.iam.gserviceaccount.com
BUILD_SA=$PN-compute@developer.gserviceaccount.com   # Cloud Build default SA in this project
IAP_AGENT=service-$PN@gcp-sa-iap.iam.gserviceaccount.com
WORKER_URL=https://catalog-worker-$PN.$REGION.run.app
log "project $PROJECT (number $PN), region $REGION"

# --- 1. APIs ------------------------------------------------------------------
REQUIRED_APIS=(
  run.googleapis.com cloudtasks.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com
  artifactregistry.googleapis.com cloudbuild.googleapis.com storage.googleapis.com iam.googleapis.com
  iamcredentials.googleapis.com logging.googleapis.com cloudresourcemanager.googleapis.com
  iap.googleapis.com sheets.googleapis.com drive.googleapis.com bigquery.googleapis.com
  cloudscheduler.googleapis.com compute.googleapis.com
)
ENABLED=$(gcv services list --enabled --project="$PROJECT" --format='value(config.name)')
MISSING=()
for api in "${REQUIRED_APIS[@]}"; do
  if ! grep -qx "$api" <<<"$ENABLED"; then MISSING+=("$api"); fi
done
if [ "${#MISSING[@]}" -gt 0 ]; then
  create "APIs: ${MISSING[*]}"
  gcloud services enable "${MISSING[@]}" --project="$PROJECT"
else
  skip "all required APIs enabled"
fi

# --- Shared resources: check only ----------------------------------------------
require_shared() { # description, command...
  local what="$1"; shift
  if "$@" >/dev/null 2>&1; then
    skip "shared $what (exists, reused)"
  else
    die "shared $what is missing. This script never creates shared resources; restore it first."
  fi
}
require_shared "VPC $VPC" gcloud compute networks describe "$VPC" --project="$PROJECT"
require_shared "subnet $SUBNET" gcloud compute networks subnets describe "$SUBNET" --region="$REGION" --project="$PROJECT"
require_shared "Cloud SQL instance $SQL_INSTANCE" gcloud sql instances describe "$SQL_INSTANCE" --project="$PROJECT"
require_shared "Artifact Registry repo $REPO" gcloud artifacts repositories describe "$REPO" --location="$REGION" --project="$PROJECT"
require_shared "bucket $ASSETS_BUCKET" gcloud storage buckets describe "$ASSETS_BUCKET" --project="$PROJECT"
require_shared "secret $OPENROUTER_SECRET" gcloud secrets describe "$OPENROUTER_SECRET" --project="$PROJECT"

# --- 2. Database and user ---------------------------------------------------------
if gcloud sql databases describe "$DB_NAME" --instance="$SQL_INSTANCE" --project="$PROJECT" >/dev/null 2>&1; then
  skip "database $DB_NAME on $SQL_INSTANCE"
else
  create "database $DB_NAME on $SQL_INSTANCE"
  gcloud sql databases create "$DB_NAME" --instance="$SQL_INSTANCE" --project="$PROJECT" >/dev/null
fi

# The password is generated in memory, piped into Secret Manager on stdin and sent to the Cloud SQL
# Admin API on curl's stdin; it is never echoed, logged, written to disk or put on a command line.
SECRET_EXISTS=0
gcloud secrets describe "$DB_SECRET" --project="$PROJECT" >/dev/null 2>&1 && SECRET_EXISTS=1
USER_EXISTS=0
SQL_USERS=$(gcv sql users list --instance="$SQL_INSTANCE" --project="$PROJECT" --format='value(name)')
grep -qx "$DB_USER" <<<"$SQL_USERS" && USER_EXISTS=1

if [ "$USER_EXISTS" = 1 ] && [ "$SECRET_EXISTS" = 1 ]; then
  skip "SQL user $DB_USER and secret $DB_SECRET"
elif [ "$USER_EXISTS" = 1 ]; then
  die "SQL user $DB_USER exists but secret $DB_SECRET does not; refusing to reset the password automatically."
else
  DBPASS=$(openssl rand -base64 24 | tr -d '/+=\n')
  [ "${#DBPASS}" -ge 24 ] || die "password generation failed"
  if [ "$SECRET_EXISTS" = 1 ]; then
    create "new version of secret $DB_SECRET (user $DB_USER missing)"
    printf %s "$DBPASS" | gcloud secrets versions add "$DB_SECRET" --project="$PROJECT" --data-file=- >/dev/null
  else
    create "secret $DB_SECRET"
    printf %s "$DBPASS" | gcloud secrets create "$DB_SECRET" --project="$PROJECT" \
      --replication-policy=automatic --data-file=- >/dev/null
  fi
  create "SQL user $DB_USER on $SQL_INSTANCE"
  # Not `gcloud sql users create --password=...`: gcloud writes every flag value to its debug log
  # on disk, and a flag is visible in the process list. curl reads its token, headers and body from
  # stdin (-K -) instead, so the password is never on a command line or in a log.
  TOKEN=$(gcv auth print-access-token)
  OP=$(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\ndata = "{\\"name\\": \\"%s\\", \\"password\\": \\"%s\\"}"\n' \
      "$TOKEN" "$DB_USER" "$DBPASS" \
    | curl -sS --fail -X POST -K - \
      "https://sqladmin.googleapis.com/sql/v1beta4/projects/$PROJECT/instances/$SQL_INSTANCE/users" \
    | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).name || "")') \
    || die "could not create SQL user $DB_USER (Cloud SQL Admin API users.insert failed)"
  unset DBPASS TOKEN
  [ -n "$OP" ] || die "Cloud SQL did not return an operation for creating $DB_USER"
  gcloud sql operations wait "$OP" --project="$PROJECT" >/dev/null
fi

# --- IAM helpers ---------------------------------------------------------------------
PROJECT_POLICY=""
load_project_policy() {
  PROJECT_POLICY=$(gcv projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members)')
}

project_binding() { # member role
  local member="$1" role="$2"
  [ -n "$PROJECT_POLICY" ] || load_project_policy
  if grep -qxF "$role,$member" <<<"$PROJECT_POLICY"; then
    skip "project binding $role -> $member"
  else
    create "project binding $role -> $member"
    retry gcloud projects add-iam-policy-binding "$PROJECT" --member="$member" \
      --role="$role" --condition=None >/dev/null
    load_project_policy
  fi
}

sa_binding() { # target-sa member role [no-fallback] ; falls back to project level if denied, unless no-fallback
  local target="$1" member="$2" role="$3" fallback="${4:-}" policy
  policy=$(gcv iam service-accounts get-iam-policy "$target" --project="$PROJECT" \
    --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members)' 2>/dev/null || true)
  if grep -qxF "$role,$member" <<<"$policy"; then
    skip "SA binding on $target: $role -> $member"
    return 0
  fi
  [ -n "$PROJECT_POLICY" ] || load_project_policy
  if grep -qxF "$role,$member" <<<"$PROJECT_POLICY"; then
    skip "SA binding on $target: $role -> $member (granted at project level earlier)"
    return 0
  fi
  create "SA binding on $target: $role -> $member"
  if ! retry gcloud iam service-accounts add-iam-policy-binding "$target" --project="$PROJECT" \
      --member="$member" --role="$role" >/dev/null; then
    if [ "$fallback" = no-fallback ]; then
      needs_human "SA binding on $target: $role -> $member was denied; a project-level grant would reach every service account, so grant it on $target by hand"
      return 0
    fi
    warn "resource-level binding denied; falling back to project level for $role -> $member"
    project_binding "$member" "$role"
  fi
}

secret_binding() { # secret member role ; falls back to project level if denied
  local secret="$1" member="$2" role="$3" policy
  policy=$(gcv secrets get-iam-policy "$secret" --project="$PROJECT" \
    --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members)' 2>/dev/null || true)
  if grep -qxF "$role,$member" <<<"$policy"; then
    skip "secret binding on $secret: $role -> $member"
    return 0
  fi
  [ -n "$PROJECT_POLICY" ] || load_project_policy
  if grep -qxF "$role,$member" <<<"$PROJECT_POLICY"; then
    skip "secret binding on $secret: $role -> $member (granted at project level earlier)"
    return 0
  fi
  create "secret binding on $secret: $role -> $member"
  if ! retry gcloud secrets add-iam-policy-binding "$secret" --project="$PROJECT" \
      --member="$member" --role="$role" >/dev/null; then
    warn "resource-level binding denied; falling back to project level for $role -> $member"
    project_binding "$member" "$role"
  fi
}

bucket_has_binding() { # bucket member role
  local policy
  policy=$(gcv storage buckets get-iam-policy "$1" --project="$PROJECT" --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members)')
  grep -qxF "$3,$2" <<<"$policy"
}

# Bucket roles are never widened to project level (that would give catalog-web@ write access to the
# public bucket); a denial prints the exact command for the operator instead.
bucket_binding() { # bucket member role
  local bucket="$1" member="$2" role="$3"
  if bucket_has_binding "$bucket" "$member" "$role"; then
    skip "bucket binding on $bucket: $role -> $member"
    return 0
  fi
  create "bucket binding on $bucket: $role -> $member"
  if ! retry gcloud storage buckets add-iam-policy-binding "$bucket" --project="$PROJECT" \
      --member="$member" --role="$role" >/dev/null; then
    needs_human "bucket binding denied. Run: gcloud storage buckets add-iam-policy-binding $bucket --project=$PROJECT --member=$member --role=$role"
  fi
}

# Lifecycle from a JSON file; SKIP when the bucket already has that configuration (the same rule set). The describe
# is retried (a transient network or token hiccup); one that still fails, or output that is not JSON, stops the run
# instead of rewriting the lifecycle: before 2026-10-29 both counted as a difference (docs/solutions/infra-bootstrap.md).
ensure_lifecycle() { # bucket file
  local bucket="$1" file="$2" current detail status=0
  current=$(retry gcv storage buckets describe "$bucket" --project="$PROJECT" --format='json(lifecycle_config)') \
    || die "cannot read the lifecycle of $bucket (gcloud storage buckets describe failed); nothing was changed"
  detail=$(json_key_matches "$current" "$file" lifecycle_config) || status=$?
  case "$status" in
    0) skip "lifecycle on $bucket ($file)" ;;
    1)
      update "lifecycle on $bucket from $file"
      printf '%s\n' "$detail"
      gcloud storage buckets update "$bucket" --project="$PROJECT" --lifecycle-file="$file" >/dev/null ;;
    *) die "cannot compare the lifecycle of $bucket with $file (not JSON); nothing was changed" ;;
  esac
}

# CORS from infra/cors.json only when the bucket has none: deploy.sh narrows the origin to the web
# URL after the first deploy, and a re-run must not widen it again.
ensure_cors() { # bucket
  local bucket="$1" current
  current=$(gcv storage buckets describe "$bucket" --project="$PROJECT" --format='value(cors_config)')
  if [ -n "$current" ]; then
    skip "CORS on $bucket (already set)"
  else
    create "CORS on $bucket from infra/cors.json"
    gcloud storage buckets update "$bucket" --project="$PROJECT" --cors-file=infra/cors.json >/dev/null
  fi
}

# --- 3. IAP (sign-in for catalog-web, used from 03) -----------------------------------
# `identity create` is idempotent; it is only called when the agent is not yet in the project policy.
load_project_policy
if grep -qF "serviceAccount:$IAP_AGENT" <<<"$PROJECT_POLICY"; then
  skip "IAP service agent $IAP_AGENT"
else
  create "IAP service agent"
  gcloud beta services identity create --service=iap.googleapis.com --project="$PROJECT" >/dev/null
fi
project_binding "serviceAccount:$IAP_AGENT" roles/run.invoker

# --- 4. Public bucket ----------------------------------------------------------------
if gcloud storage buckets describe "$PUBLIC_BUCKET" --project="$PROJECT" >/dev/null 2>&1; then
  skip "bucket $PUBLIC_BUCKET"
else
  create "bucket $PUBLIC_BUCKET"
  gcloud storage buckets create "$PUBLIC_BUCKET" --project="$PROJECT" --location="$REGION" \
    --uniform-bucket-level-access --no-public-access-prevention >/dev/null
fi

if bucket_has_binding "$PUBLIC_BUCKET" allUsers roles/storage.objectViewer; then
  skip "public read (allUsers -> roles/storage.objectViewer) on $PUBLIC_BUCKET"
else
  create "public read (allUsers -> roles/storage.objectViewer) on $PUBLIC_BUCKET"
  if ! out=$(gcloud storage buckets add-iam-policy-binding "$PUBLIC_BUCKET" --project="$PROJECT" \
      --member=allUsers --role=roles/storage.objectViewer 2>&1 >/dev/null); then
    policy=$(grep -o 'constraints/[A-Za-z0-9_.]*' <<<"$out" | head -1 || true)
    if [ -z "$policy" ] && grep -qiE 'permitted customer|organization policy|org policy' <<<"$out"; then
      policy=constraints/iam.allowedPolicyMemberDomains
    fi
    if [ -n "$policy" ]; then
      needs_human "public read on $PUBLIC_BUCKET is blocked by org policy $policy. An org policy admin must allow allUsers for project $PROJECT, then re-run this script."
    else
      printf '%s\n' "$out" >&2
      die "could not grant public read on $PUBLIC_BUCKET"
    fi
  fi
fi

if [ "$(gcv storage buckets describe "$PUBLIC_BUCKET" --project="$PROJECT" --format='value(versioning_enabled)')" = "True" ]; then
  skip "versioning on $PUBLIC_BUCKET"
else
  update "versioning on $PUBLIC_BUCKET"
  gcloud storage buckets update "$PUBLIC_BUCKET" --project="$PROJECT" --versioning >/dev/null
fi
ensure_lifecycle "$PUBLIC_BUCKET" infra/lifecycle-public.json

# --- 5. Assets bucket (shared): catalog/ lifecycle and CORS ---------------------------
ensure_lifecycle "$ASSETS_BUCKET" infra/lifecycle-assets.json
ensure_cors "$ASSETS_BUCKET"

# --- 6. Cloud Tasks queue ---------------------------------------------------------------
if gcloud tasks queues describe "$QUEUE" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  skip "tasks queue $QUEUE"
else
  create "tasks queue $QUEUE"
  # Spec 17 G4: the chunk retry of CHUNK_QUEUE_RETRY in infra/lib/queues.sh (deploy.sh also applies it to an existing queue).
  gcloud tasks queues create "$QUEUE" --project="$PROJECT" --location="$REGION" \
    --max-concurrent-dispatches=20 --max-attempts=-1 --max-retry-duration=1800s --min-backoff=10s --max-backoff=60s --max-doublings=3 >/dev/null
fi
if gcloud tasks queues describe "$INGEST_QUEUE" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  skip "tasks queue $INGEST_QUEUE"
else
  create "tasks queue $INGEST_QUEUE"
  gcloud tasks queues create "$INGEST_QUEUE" --project="$PROJECT" --location="$REGION" \
    --max-concurrent-dispatches=2 --max-attempts=5 --min-backoff=10s >/dev/null
fi

# --- 7. Service accounts -----------------------------------------------------------------
ensure_sa() { # name display-name
  local email="$1@$PROJECT.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "$email" --project="$PROJECT" >/dev/null 2>&1; then
    skip "service account $email"
  else
    create "service account $email"
    gcloud iam service-accounts create "$1" --project="$PROJECT" --display-name="$2" >/dev/null
  fi
}
ensure_sa catalog-web "Catalog web"
ensure_sa catalog-worker "Catalog worker"
ensure_sa catalog-matting "Catalog matting"

# --- 8. IAM -------------------------------------------------------------------------------
# Public bucket: the worker overwrites and deletes (needs storage.objects.delete); the web only reads.
if bucket_has_binding "$PUBLIC_BUCKET" "serviceAccount:$WORKER" roles/storage.objectUser; then
  skip "bucket binding on $PUBLIC_BUCKET: roles/storage.objectUser -> serviceAccount:$WORKER"
elif bucket_has_binding "$PUBLIC_BUCKET" "serviceAccount:$WORKER" roles/storage.objectAdmin; then
  skip "bucket binding on $PUBLIC_BUCKET: roles/storage.objectAdmin -> serviceAccount:$WORKER (fallback from an earlier run)"
else
  create "bucket binding on $PUBLIC_BUCKET: roles/storage.objectUser -> serviceAccount:$WORKER"
  if ! retry gcloud storage buckets add-iam-policy-binding "$PUBLIC_BUCKET" --project="$PROJECT" \
      --member="serviceAccount:$WORKER" --role=roles/storage.objectUser >/dev/null; then
    warn "roles/storage.objectUser not available; falling back to roles/storage.objectAdmin on $PUBLIC_BUCKET only"
    bucket_binding "$PUBLIC_BUCKET" "serviceAccount:$WORKER" roles/storage.objectAdmin
  fi
fi
bucket_binding "$PUBLIC_BUCKET" "serviceAccount:$WEB" roles/storage.objectViewer
bucket_binding "$ASSETS_BUCKET" "serviceAccount:$WEB" roles/storage.objectAdmin
bucket_binding "$ASSETS_BUCKET" "serviceAccount:$WORKER" roles/storage.objectAdmin

for SA in "$WEB" "$WORKER"; do
  project_binding "serviceAccount:$SA" roles/cloudsql.client
  project_binding "serviceAccount:$SA" roles/cloudtasks.enqueuer
  # Secret access per secret, not project-wide: this project holds other apps' secrets.
  secret_binding "$DB_SECRET" "serviceAccount:$SA" roles/secretmanager.secretAccessor
done
secret_binding "$OPENROUTER_SECRET" "serviceAccount:$WORKER" roles/secretmanager.secretAccessor
# Spec 18 H2: project level, so this one grant also lets the worker (and the probe job catalog-check-matting, which
# runs as catalog-worker@) invoke catalog-upscale, including its candidate tag URLs, without a resource-level binding
# on a service that does not exist yet when bootstrap runs (resource-level IAM on Cloud Run may be denied, AGENTS.md;
# docs/solutions/infra-bootstrap.md). Check-then-create through project_binding.
project_binding "serviceAccount:$WORKER" roles/run.invoker
# Spec 17 G1: the Ops page reads Cloud Run service status (the GPU candidate revision). Project level, because
# resource-level IAM on Cloud Run services may be denied (AGENTS.md). Read only.
project_binding "serviceAccount:$WEB" roles/run.viewer

sa_binding "$WEB" "serviceAccount:$WEB" roles/iam.serviceAccountTokenCreator
# The catalog-eval job (contact-sheet, report) runs as catalog-worker@ and signs URLs through signBlob.
sa_binding "$WORKER" "serviceAccount:$WORKER" roles/iam.serviceAccountTokenCreator
sa_binding "$WORKER" "serviceAccount:$WEB" roles/iam.serviceAccountUser
sa_binding "$WORKER" "serviceAccount:$WORKER" roles/iam.serviceAccountUser
# Spec 17 3.2.3: deploy.sh's web gate probes the catalog-web candidate through IAP as the smoke's identity
# (catalog-worker@, which the catalog-test-smoke job runs as). IAP's Google-managed OAuth client refuses the operator's
# own tokens, so the probe mints an access token for catalog-worker@ (infra/lib/services.sh iap_token). Two grants:
# - catalog-worker@ may pass IAP. Project level: the resource-level IAP policy on catalog-web needs roles/iap.admin,
#   which the operator does not hold (docs/solutions/catalog-iap.md). It also covers the earlier ila-web, which the
#   worker never calls; the app still refuses the account (outside opptra.com).
# - The operator running bootstrap may mint tokens for catalog-worker@ only (never project level: that would reach
#   every service account in the project, including the earlier app's).
project_binding "serviceAccount:$WORKER" roles/iap.httpsResourceAccessor
OPERATOR=$(gcv config get-value account 2>/dev/null)
case "$OPERATOR" in
  "") needs_human "no active gcloud account; the web gate's token grant on $WORKER was not checked" ;;
  *.gserviceaccount.com) sa_binding "$WORKER" "serviceAccount:$OPERATOR" roles/iam.serviceAccountTokenCreator no-fallback ;;
  *) sa_binding "$WORKER" "user:$OPERATOR" roles/iam.serviceAccountTokenCreator no-fallback ;;
esac
# catalog-matting@ gets no bucket or database rights (it receives bytes and returns bytes).

# storage.objectViewer lets `gcloud builds submit` read the uploaded source.
for ROLE in roles/cloudbuild.builds.builder roles/artifactregistry.writer \
            roles/logging.logWriter roles/storage.objectViewer; do
  project_binding "serviceAccount:$BUILD_SA" "$ROLE"
done

# --- 9. BigQuery (cross-project, read only) -------------------------------------------------
BQ_MEMBER=serviceAccount:$WORKER
BQ_LOCATION=asia-south1
# Dataset grants use the GRANT DCL statement ('bq add-iam-policy-binding' does not support
# datasets). This script's own attempt runs the GRANT job in $PROJECT (the operator can create jobs
# here). The printed command for the warehouse admin runs it in $BQ_PROJECT instead: an admin there
# may have no role in $PROJECT, so a job in $PROJECT would fail for them.
bq_grant_sql() { # dataset
  local bt='`'
  printf 'GRANT %sroles/bigquery.dataViewer%s ON SCHEMA %s%s%s.%s TO "%s"' \
    "$bt" "$bt" "$bt" "$BQ_PROJECT" "$bt" "$1" "$BQ_MEMBER"
}
# Commands for the grants that could not be applied from here (printed at the end).
BQ_TODO=()
bq_print_commands() {
  needs_human "BigQuery access for $WORKER on $BQ_PROJECT could not be granted from here. Someone with admin rights on $BQ_PROJECT runs these (bash), then re-runs this script:"
  local c
  for c in "${BQ_TODO[@]}"; do needs_human "  $c"; done
}

# Git Bash on Windows: the bq launcher can pick a python it cannot start ("python3.11: command not
# found"). Fall back to the Cloud SDK's bundled python for bq only, in this shell; gcloud config is
# not touched.
if ! bq version >/dev/null 2>&1 && [ -z "${CLOUDSDK_BQ_PYTHON:-}" ] && BQ_BIN=$(command -v bq); then
  BUNDLED_PY="$(dirname "$BQ_BIN")/../platform/bundledpython/python.exe"
  if [ -x "$BUNDLED_PY" ] && CLOUDSDK_BQ_PYTHON="$BUNDLED_PY" bq version >/dev/null 2>&1; then
    export CLOUDSDK_BQ_PYTHON="$BUNDLED_PY"
    log "bq: using the Cloud SDK bundled python"
  fi
fi

BQ_JOBUSER_CMD="gcloud projects add-iam-policy-binding $BQ_PROJECT --member=$BQ_MEMBER --role=roles/bigquery.jobUser --condition=None"
if BQ_POLICY=$(gcv projects get-iam-policy "$BQ_PROJECT" --flatten='bindings[].members' \
    --format='csv[no-heading](bindings.role,bindings.members)' 2>/dev/null); then
  if grep -qxF "roles/bigquery.jobUser,$BQ_MEMBER" <<<"$BQ_POLICY"; then
    skip "project binding on $BQ_PROJECT: roles/bigquery.jobUser -> $BQ_MEMBER"
  else
    create "project binding on $BQ_PROJECT: roles/bigquery.jobUser -> $BQ_MEMBER"
    gcloud projects add-iam-policy-binding "$BQ_PROJECT" --member="$BQ_MEMBER" \
      --role=roles/bigquery.jobUser --condition=None >/dev/null 2>&1 || BQ_TODO+=("$BQ_JOBUSER_CMD")
  fi
else
  BQ_TODO+=("$BQ_JOBUSER_CMD")
fi

# Dataset access: dataViewer appears as READER in the dataset's access list.
dataset_has_reader() { # dataset
  bq --project_id="$BQ_PROJECT" show --format=prettyjson "$BQ_PROJECT:$1" 2>/dev/null | tr -d '\r' | node -e '
    const ds = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const email = process.argv[1];
    const hit = (ds.access || []).some((a) =>
      (a.role === "READER" || a.role === "roles/bigquery.dataViewer") &&
      (a.userByEmail === email || a.iamMember === "serviceAccount:" + email));
    process.exit(hit ? 0 : 1);
  ' "$WORKER"
}
BQ_CLI_OK=0
bq version >/dev/null 2>&1 && BQ_CLI_OK=1
[ "$BQ_CLI_OK" = 1 ] || warn "bq does not start in this shell; dataset grants not checked"
for ds in "${BQ_DATASETS[@]}"; do
  grant_cmd="bq query --project_id=$BQ_PROJECT --location=$BQ_LOCATION --nouse_legacy_sql '$(bq_grant_sql "$ds")'"
  if [ "$BQ_CLI_OK" = 0 ]; then
    BQ_TODO+=("$grant_cmd")
  elif dataset_has_reader "$ds"; then
    skip "dataset access $BQ_PROJECT:$ds: roles/bigquery.dataViewer -> $BQ_MEMBER"
  else
    create "dataset access $BQ_PROJECT:$ds: roles/bigquery.dataViewer -> $BQ_MEMBER"
    if ! out=$(bq query --project_id="$PROJECT" --location="$BQ_LOCATION" --nouse_legacy_sql \
        "$(bq_grant_sql "$ds")" 2>&1); then
      printf '%s\n' "$out" | tr -d '\r' | tail -3 >&2
      BQ_TODO+=("$grant_cmd")
    fi
  fi
done
[ "${#BQ_TODO[@]}" = 0 ] || bq_print_commands

# --- 10. Cloud Scheduler -------------------------------------------------------------------
ensure_scheduler_job() { # name route cron
  local name="$1" route="$2" cron="$3" current
  if current=$(gcloud scheduler jobs describe "$name" --location="$REGION" --project="$PROJECT" --format='value(schedule)' 2>/dev/null | tr -d '\r'); then
    if [ "$current" = "$cron" ]; then
      skip "scheduler job $name"
    else
      update "scheduler job $name schedule ($current -> $cron)"
      gcloud scheduler jobs update http "$name" --project="$PROJECT" --location="$REGION" \
        --schedule="$cron" --time-zone="$SCHEDULER_TZ" >/dev/null
    fi
  else
    create "scheduler job $name ($cron $SCHEDULER_TZ -> $route)"
    gcloud scheduler jobs create http "$name" --project="$PROJECT" --location="$REGION" \
      --schedule="$cron" --time-zone="$SCHEDULER_TZ" \
      --uri="${WORKER_URL}${route}" --http-method=POST \
      --message-body='{}' --headers=Content-Type=application/json \
      --oidc-service-account-email="$WORKER" --oidc-token-audience="$WORKER_URL" \
      --attempt-deadline=600s >/dev/null
  fi
}
ensure_scheduler_job catalog-sync-master /tasks/catalog/sync-master "$SYNC_MASTER_CRON"
ensure_scheduler_job catalog-sweep /tasks/catalog/sweep "$SWEEP_CRON"

# --- 11. Summary ---------------------------------------------------------------------------
if [ "${#TODO[@]}" -gt 0 ]; then
  log "INCOMPLETE: everything else is done; these need a human, then re-run this script:"
  for t in "${TODO[@]}"; do log "  - $t"; done
  exit 2
fi
log "done. Worker URL (after deploy.sh): $WORKER_URL"
