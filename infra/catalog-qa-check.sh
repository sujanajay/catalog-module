#!/usr/bin/env bash
# Tier 3 live QA (spec 07 section 7): the Cloud Run job catalog-qa-check runs dist/catalog-qa-check.js
# from the worker image of the current commit, on the same network, service account and secret
# pattern as catalog-migrate, plus the OpenRouter key mounted from Secret Manager.
# LIVE_SMOKE is never part of the job definition, so a plain execution makes no live judge calls;
# only "run" below sets LIVE_SMOKE=1, for that one execution.
#
# Usage (Git Bash, from the repo root):
#   bash infra/catalog-qa-check.sh deploy   # called by infra/deploy.sh (step 7); needs QA_JOB_IMAGE,
#                                           # QA_JOB_ENV and QA_JOB_SECRETS from it
#   bash infra/catalog-qa-check.sh run      # execute once with LIVE_SMOKE=1 and wait (costs OpenRouter
#                                           # credit; the job enforces its own budget before each batch)
# PowerShell equivalent of "run" (from the repo root):
#   & "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe" infra/catalog-qa-check.sh run
#
# Inputs: the Anta and French Connection tarballs already in the assets bucket under catalog-test/
# (the same read-only folder the catalog-test-smoke job mounts), unpacked to REAL_DATA_DIR.
# Evidence and cleanup stay under catalog-test/qa-check/<run>/ (written by the job itself).
# Secret values are never read or printed: the job gets them as Secret Manager env mounts.
set -euo pipefail

PROJECT=image-links-agent
REGION=asia-south1
JOB=catalog-qa-check
# Pin this project for every gcloud call without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
cd "$(dirname "$0")/.."

WORKER_SA=catalog-worker@$PROJECT.iam.gserviceaccount.com
INPUT_BUCKET=image-links-agent-assets
INPUT_PREFIX=catalog-test/render-05-1792340617303-555901/inputs
NET=(--region="$REGION" --network=ila-vpc --subnet=ila-subnet --vpc-egress=private-ranges-only)

gcv() { gcloud "$@" | tr -d '\r'; }
job_exists() {
  [ -n "$(gcv run jobs list --region="$REGION" --filter="metadata.name=$JOB" --format='value(metadata.name)')" ]
}

deploy() {
  : "${QA_JOB_IMAGE:?QA_JOB_IMAGE missing: deploy through bash infra/deploy.sh}"
  : "${QA_JOB_ENV:?QA_JOB_ENV missing: deploy through bash infra/deploy.sh}"
  : "${QA_JOB_SECRETS:?QA_JOB_SECRETS missing: deploy through bash infra/deploy.sh}"
  case ",$QA_JOB_ENV," in *,LIVE_SMOKE=*) echo "ERROR: LIVE_SMOKE must not be part of the job definition" >&2; exit 1 ;; esac
  case ",$QA_JOB_SECRETS," in *,OPENROUTER_API_KEY=openrouter-api-key:*) ;; *) echo "ERROR: QA_JOB_SECRETS must mount openrouter-api-key" >&2; exit 1 ;; esac

  # Volumes are added by flag; on an update clear them first so a re-run never duplicates them.
  local volume_flags=()
  if job_exists; then
    echo "==> $JOB: UPDATE to $QA_JOB_IMAGE"
    volume_flags+=(--clear-volumes --clear-volume-mounts)
  else
    echo "==> $JOB: CREATE from $QA_JOB_IMAGE"
  fi
  volume_flags+=(--add-volume="name=input,type=cloud-storage,bucket=$INPUT_BUCKET,readonly=true,mount-options=only-dir=$INPUT_PREFIX;uid=1000;gid=1000")
  volume_flags+=(--add-volume-mount="volume=input,mount-path=/catalog-input")

  # MSYS2_ARG_CONV_EXCL: Git Bash rewrites "/..." values inside these flags into Windows paths
  # (see the web deploy in infra/deploy.sh). Excluding only these flags keeps the conversion the
  # gcloud launcher itself needs (MSYS_NO_PATHCONV=1 would break it).
  MSYS2_ARG_CONV_EXCL='--command=;--args=;--set-env-vars=;--add-volume=;--add-volume-mount=' \
  gcloud run jobs deploy "$JOB" --quiet --image="$QA_JOB_IMAGE" \
    --service-account="$WORKER_SA" --max-retries=0 --task-timeout=10800 --cpu=2 --memory=4Gi "${NET[@]}" \
    "${volume_flags[@]}" \
    --command=/bin/sh \
    --args=-ec,"mkdir -p /tmp/catalog-data; tar -xf /catalog-input/anta.tar -C /tmp/catalog-data; tar -xf /catalog-input/french-connection.tar -C /tmp/catalog-data; exec node dist/catalog-qa-check.js" \
    --set-secrets="$QA_JOB_SECRETS" --set-env-vars="$QA_JOB_ENV,REAL_DATA_DIR=/tmp/catalog-data,REAL_DATA=1"
}

run() {
  job_exists || { echo "ERROR: $JOB does not exist yet; run bash infra/deploy.sh first" >&2; exit 1; }
  echo "==> $JOB: EXECUTE with LIVE_SMOKE=1 (live judge calls, this execution only)"
  gcloud run jobs execute "$JOB" --region="$REGION" --update-env-vars=LIVE_SMOKE=1 --wait
  echo "Evidence: gs://image-links-agent-assets/catalog-test/qa-check/"
}

case "${1:-}" in
  deploy) deploy ;;
  run) run ;;
  *) echo "Usage: bash infra/catalog-qa-check.sh deploy|run" >&2; exit 2 ;;
esac
