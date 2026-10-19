#!/usr/bin/env bash
# Spec 09: the Cloud Run jobs catalog-load (tier 6 load driver, dist/catalog-load.js) and
# catalog-recheck (independent re-check, dist/catalog-recheck.js). Both run the worker image of the
# current commit on the same network, service account and DB secret as catalog-migrate. Neither job
# mounts the OpenRouter key or ever calls OpenRouter (the deployed worker's QA stage does, under its
# caps). The load job may run three passes of up to 4 hours each, hence its 24-hour task timeout.
# Test data only: catalog-load makes test_brand test batches under catalog-test/ and cleans
# them up; both write their evidence under gs://image-links-agent-assets/catalog-test/.
#
# Usage (Git Bash, from the repo root):
#   bash infra/catalog-scale-jobs.sh deploy               # called by infra/deploy.sh (Jobs step); needs
#                                                         # SCALE_JOB_IMAGE, SCALE_JOB_ENV, SCALE_JOB_SECRETS
#   bash infra/catalog-scale-jobs.sh load [options] [passes]
#                                                         # default 270 options, passes a+reupload+b
#   bash infra/catalog-scale-jobs.sh recheck batch <batchId>
#   bash infra/catalog-scale-jobs.sh recheck brand <slug>
# PowerShell equivalent (from the repo root):
#   & "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe" infra/catalog-scale-jobs.sh load 270
# Secret values are never read or printed: the jobs get them as Secret Manager env mounts.
set -euo pipefail

PROJECT=image-links-agent
REGION=asia-south1
LOAD_JOB=catalog-load
RECHECK_JOB=catalog-recheck
# Pin this project for every gcloud call without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
cd "$(dirname "$0")/.."

WORKER_SA=catalog-worker@$PROJECT.iam.gserviceaccount.com
ASSETS_BUCKET=image-links-agent-assets
INPUT_PREFIX=catalog-test/render-05-1792340617303-555901/inputs
NET=(--region="$REGION" --network=ila-vpc --subnet=ila-subnet --vpc-egress=private-ranges-only)

gcv() { gcloud "$@" | tr -d '\r'; }
job_exists() {
  [ -n "$(gcv run jobs list --region="$REGION" --filter="metadata.name=$1" --format='value(metadata.name)')" ]
}

# deploy_job <job> <evidence prefix> <timeout s> <with input: 0|1> <command> <args>
deploy_job() {
  local job=$1 evidence=$2 timeout=$3 with_input=$4 command=$5 args=$6
  # Volumes are added by flag; on an update clear them first so a re-run never duplicates them.
  local volume_flags=()
  if job_exists "$job"; then
    echo "==> $job: UPDATE to $SCALE_JOB_IMAGE"
    volume_flags+=(--clear-volumes --clear-volume-mounts)
  else
    echo "==> $job: CREATE from $SCALE_JOB_IMAGE"
  fi
  if [ "$with_input" = 1 ]; then
    volume_flags+=(--add-volume="name=input,type=cloud-storage,bucket=$ASSETS_BUCKET,readonly=true,mount-options=only-dir=$INPUT_PREFIX;uid=1000;gid=1000")
    volume_flags+=(--add-volume-mount="volume=input,mount-path=/catalog-input")
  fi
  volume_flags+=(--add-volume="name=evidence,type=cloud-storage,bucket=$ASSETS_BUCKET,mount-options=only-dir=$evidence;uid=1000;gid=1000")
  volume_flags+=(--add-volume-mount="volume=evidence,mount-path=/catalog-evidence")

  # MSYS2_ARG_CONV_EXCL: Git Bash rewrites "/..." values inside these flags into Windows paths
  # (see the web deploy in infra/deploy.sh). Excluding only these flags keeps the conversion the
  # gcloud launcher itself needs (MSYS_NO_PATHCONV=1 would break it).
  MSYS2_ARG_CONV_EXCL='--command=;--args=;--set-env-vars=;--add-volume=;--add-volume-mount=' \
  gcloud run jobs deploy "$job" --quiet --image="$SCALE_JOB_IMAGE" \
    --service-account="$WORKER_SA" --max-retries=0 --task-timeout="$timeout" --cpu=2 --memory=4Gi "${NET[@]}" \
    "${volume_flags[@]}" --command="$command" --args="$args" \
    --set-secrets="$SCALE_JOB_SECRETS" --set-env-vars="$SCALE_JOB_ENV,CATALOG_REAL_OUT=/catalog-evidence,REAL_DATA_DIR=/tmp/catalog-data,REAL_DATA=1"
}

deploy() {
  : "${SCALE_JOB_IMAGE:?SCALE_JOB_IMAGE missing: deploy through bash infra/deploy.sh}"
  : "${SCALE_JOB_ENV:?SCALE_JOB_ENV missing: deploy through bash infra/deploy.sh}"
  : "${SCALE_JOB_SECRETS:?SCALE_JOB_SECRETS missing: deploy through bash infra/deploy.sh}"
  case ",$SCALE_JOB_ENV," in *,LIVE_SMOKE=*) echo "ERROR: LIVE_SMOKE must not be part of the job definition" >&2; exit 1 ;; esac
  case ",$SCALE_JOB_SECRETS," in *openrouter*) echo "ERROR: the scale jobs never mount the OpenRouter key" >&2; exit 1 ;; esac
  deploy_job "$LOAD_JOB" catalog-test/load 86400 1 /bin/sh \
    "-ec,mkdir -p /tmp/catalog-data; tar -xf /catalog-input/anta.tar -C /tmp/catalog-data; tar -xf /catalog-input/french-connection.tar -C /tmp/catalog-data; exec node dist/catalog-load.js"
  deploy_job "$RECHECK_JOB" catalog-test/recheck 3600 0 node dist/catalog-recheck.js
}

load() {
  local options=${1:-270} passes=${2:-a+reupload+b}
  [[ "$options" =~ ^[1-9][0-9]*$ ]] || { echo "ERROR: options must be a whole number (270 is one tenth, 2700 the full scale)" >&2; exit 2; }
  [[ "$passes" =~ ^(a|reupload|b)(\+(a|reupload|b))*$ ]] || { echo "ERROR: passes look like a+reupload+b" >&2; exit 2; }
  job_exists "$LOAD_JOB" || { echo "ERROR: $LOAD_JOB does not exist yet; run bash infra/deploy.sh first" >&2; exit 1; }
  echo "==> $LOAD_JOB: EXECUTE with $options options, passes $passes (test batches on the deployed stack)"
  gcloud run jobs execute "$LOAD_JOB" --region="$REGION" --update-env-vars="LOAD_OPTIONS=$options,LOAD_PASSES=$passes" --wait
  echo "Evidence: gs://$ASSETS_BUCKET/catalog-test/load/ (load-report.md and load-report.json per run)"
}

recheck() {
  local mode=${1:-} value=${2:-} var
  case "$mode" in
    batch) [[ "$value" =~ ^[a-f0-9-]{36}$ ]] || { echo "ERROR: supply a batch id" >&2; exit 2; }; var=RECHECK_BATCH ;;
    brand) [[ "$value" =~ ^[a-z0-9_-]+$ ]] || { echo "ERROR: supply a brand slug" >&2; exit 2; }; var=RECHECK_BRAND ;;
    *) echo "Usage: bash infra/catalog-scale-jobs.sh recheck batch <batchId> | recheck brand <slug>" >&2; exit 2 ;;
  esac
  job_exists "$RECHECK_JOB" || { echo "ERROR: $RECHECK_JOB does not exist yet; run bash infra/deploy.sh first" >&2; exit 1; }
  echo "==> $RECHECK_JOB: EXECUTE for $mode $value"
  gcloud run jobs execute "$RECHECK_JOB" --region="$REGION" --update-env-vars="$var=$value" --wait
  echo "Evidence: gs://$ASSETS_BUCKET/catalog-test/recheck/ (recheck-<timestamp>.csv; the summary line is in the job log)"
}

case "${1:-}" in
  deploy) deploy ;;
  load) shift; load "$@" ;;
  recheck) shift; recheck "$@" ;;
  *) echo "Usage: bash infra/catalog-scale-jobs.sh deploy | load [options] [passes] | recheck batch <id> | recheck brand <slug>" >&2; exit 2 ;;
esac
