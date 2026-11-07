#!/usr/bin/env bash
# Spec 10: the Cloud Run job catalog-output-evals runs the output-quality eval suite
# (dist/catalog-output-evals.js) from the worker image of the current commit, on the same network,
# service account and DB secret as catalog-migrate, plus the OpenRouter key mounted from Secret
# Manager for the judge. LIVE_SMOKE is never part of the job definition: a plain execution uses the
# mocked judge; only "run --live" sets LIVE_SMOKE=1, for that one execution. Everything the job
# writes stays under catalog-test/ (test batches, catalog-test/evals/<run>/report.html and .json).
#
# Usage (Git Bash, from the repo root):
#   bash infra/catalog-output-evals.sh deploy            # called by infra/deploy.sh (Jobs step); needs
#                                                        # EVALS_JOB_IMAGE, EVALS_JOB_ENV, EVALS_JOB_SECRETS
#   bash infra/catalog-output-evals.sh upload            # pin and copy the golden photos (local, needs the owner's folders)
#   bash infra/catalog-output-evals.sh run [--live] [cli flags...]
#                                                        # one execution; --live adds the live judge (spends credit)
#   bash infra/catalog-output-evals.sh run --write-policy  # also writes the cut-out model winners to model_policy
#   bash infra/catalog-output-evals.sh run --resume <run>  # continue a run that stopped: the run id is the first
#                                                        # line of its job log ("Run id: evals-..."); sets already
#                                                        # recorded under catalog-test/evals/<run>/sets/ are skipped
#   bash infra/catalog-output-evals.sh run --sets anta.footwear,penti.apparel_flat   # only these brand.category sets
#   bash infra/catalog-output-evals.sh exam              # M1 D43: the judge exam: the live judges on the pinned defects and clean images.
#                                                        # Always LIVE_SMOKE=1 for that one execution (about $1.50). Exit 0: passed. Exit 1: a judge
#                                                        # failed a bar. Exit 3: it could not run, which is no judge result. Non-zero under its
#                                                        # bars. infra/deploy.sh runs it as its last step; proof runs it first.
#   bash infra/catalog-output-evals.sh proof [--limit n] # M1 D40: the matte agreement on the 19 real photos and 8 controls.
#                                                        # Always LIVE_SMOKE=1 for that one execution (spends credit); run
#                                                        # with "run --live" for the golden set. Writes only under catalog-test/.
#   bash infra/catalog-output-evals.sh recut --batch <id> --photos <identifier_n,...>
#                                                        # M1 D42: cuts delivered photos out again, through the worker. This
#                                                        # replaces live images, so run it only when told to.
# PowerShell equivalent (from the repo root):
#   & "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe" infra/catalog-output-evals.sh run
# Secret values are never read or printed.
set -euo pipefail

PROJECT=image-links-agent
REGION=asia-south1
JOB=catalog-output-evals
# Pin this project for every gcloud call without touching global gcloud config.
export CLOUDSDK_CORE_PROJECT=$PROJECT
cd "$(dirname "$0")/.."
# M6-S1: labels app=catalog, component=<job name>, env (infra/lib/labels.sh); a job without them is never deployed.
# shellcheck source=lib/labels.sh
source infra/lib/labels.sh
JOB_LABELS=$(catalog_labels "$JOB" test)
# cli_args: the --args value for "gcloud run jobs execute" (unique tokens, "^|^" separator).
source infra/lib/cli-args.sh
# gcloud_retry, gcloud_job_run: a network drop during the wait is not a result.
# shellcheck source=lib/gcloud-retry.sh
source infra/lib/gcloud-retry.sh

WORKER_SA=catalog-worker@$PROJECT.iam.gserviceaccount.com
ASSETS_BUCKET=image-links-agent-assets
NET=(--region="$REGION" --network=ila-vpc --subnet=ila-subnet --vpc-egress=private-ranges-only)

gcv() { gcloud "$@" | tr -d '\r'; }
job_exists() {
  [ -n "$(gcv run jobs list --region="$REGION" --filter="metadata.name=$JOB" --format='value(metadata.name)')" ]
}

deploy() {
  : "${EVALS_JOB_IMAGE:?EVALS_JOB_IMAGE missing: deploy through bash infra/deploy.sh}"
  : "${EVALS_JOB_ENV:?EVALS_JOB_ENV missing: deploy through bash infra/deploy.sh}"
  : "${EVALS_JOB_SECRETS:?EVALS_JOB_SECRETS missing: deploy through bash infra/deploy.sh}"
  case ",$EVALS_JOB_ENV," in *,LIVE_SMOKE=*) echo "ERROR: LIVE_SMOKE must not be part of the job definition" >&2; exit 1 ;; esac
  case ",$EVALS_JOB_SECRETS," in *,OPENROUTER_API_KEY=openrouter-api-key:*) ;; *) echo "ERROR: EVALS_JOB_SECRETS must mount openrouter-api-key" >&2; exit 1 ;; esac

  # The evidence volume lets the job keep a local copy of the report next to the bucket upload.
  local volume_flags=()
  if job_exists; then
    echo "==> $JOB: UPDATE to $EVALS_JOB_IMAGE"
    volume_flags+=(--clear-volumes --clear-volume-mounts)
  else
    echo "==> $JOB: CREATE from $EVALS_JOB_IMAGE"
  fi
  volume_flags+=(--add-volume="name=evidence,type=cloud-storage,bucket=$ASSETS_BUCKET,mount-options=only-dir=catalog-test/evals;uid=1000;gid=1000")
  volume_flags+=(--add-volume-mount="volume=evidence,mount-path=/catalog-evidence")

  # The command is the CLI itself, so "gcloud run jobs execute --args=..." passes only the CLI words.
  # MSYS2_ARG_CONV_EXCL: Git Bash would rewrite "/..." values inside these flags into Windows paths.
  catalog_labels_check "$JOB" "$JOB_LABELS" || exit 1
  MSYS2_ARG_CONV_EXCL='--command=;--args=;--set-env-vars=;--add-volume=;--add-volume-mount=' \
  gcloud run jobs deploy "$JOB" --quiet --image="$EVALS_JOB_IMAGE" \
    --service-account="$WORKER_SA" --labels="$JOB_LABELS" --max-retries=0 --task-timeout=14400 --cpu=2 --memory=4Gi "${NET[@]}" \
    "${volume_flags[@]}" \
    --command=node,dist/catalog-output-evals.js --args=help \
    --set-secrets="$EVALS_JOB_SECRETS" --set-env-vars="$EVALS_JOB_ENV,CATALOG_REAL_OUT=/catalog-evidence/local,REAL_DATA=1"
}

upload() {
  [ -f apps/worker/dist/catalog-output-evals.js ] || { echo "ERROR: build the worker first (pnpm --filter @catalog/worker build)" >&2; exit 1; }
  # The CLI reads the bucket from BUCKET, like the deployed services; default to the assets bucket.
  export BUCKET=${BUCKET:-$ASSETS_BUCKET}
  echo "==> golden set: pin and copy the owner's photos under gs://$BUCKET/catalog-test/evals/golden/"
  node apps/worker/dist/catalog-output-evals.js upload "$@"
}

run() {
  job_exists || { echo "ERROR: $JOB does not exist yet; run bash infra/deploy.sh first" >&2; exit 1; }
  local live=0 env_flags=()
  if [ "${1:-}" = "--live" ]; then live=1; shift; fi
  [ "$live" = 1 ] && env_flags+=(--update-env-vars=LIVE_SMOKE=1)
  # Each "--flag value" travels as one "--flag=value" token: gcloud refuses a repeated value inside --args
  # ("--limit 3 --bakeoff-sample 3" gave '"3" cannot be specified multiple times'). The CLI reads both forms.
  local joined
  joined=$(cli_args run "$@") || exit 2
  echo "==> $JOB: EXECUTE run $* $([ "$live" = 1 ] && echo '(LIVE_SMOKE=1, live judge calls)')"
  MSYS2_ARG_CONV_EXCL='--args=' gcloud run jobs execute "$JOB" --region="$REGION" --args="$joined" "${env_flags[@]}" --wait
  echo "Report: gs://$ASSETS_BUCKET/catalog-test/evals/<run>/report.html; the run id and the summary line are in the job log:"
  echo "  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=$JOB AND (textPayload:\"Run id:\" OR textPayload:\"Output-quality eval\")' --limit=5 --freshness=6h"
  echo "If the execution stopped early: bash infra/catalog-output-evals.sh run --resume <run id>"
}

# One execution of a CLI command other than run; "--live" adds LIVE_SMOKE=1 to that execution only.
execute_cli() {
  job_exists || { echo "ERROR: $JOB does not exist yet; run bash infra/deploy.sh first" >&2; exit 1; }
  local env_flags=() joined
  if [ "$1" = "--live" ]; then env_flags+=(--update-env-vars=LIVE_SMOKE=1); shift; fi
  joined=$(cli_args "$@") || exit 2
  echo "==> $JOB: EXECUTE $* $([ ${#env_flags[@]} -gt 0 ] && echo '(LIVE_SMOKE=1, live judge calls)')"
  MSYS2_ARG_CONV_EXCL='--args=' gcloud run jobs execute "$JOB" --region="$REGION" --args="$joined" "${env_flags[@]}" --wait
}

# The judge exam, through the wrapper that judges from the execution's final state. Its exit code says which of three things happened.
exam() {
  local listed joined rc=0 out
  if ! listed=$(gcloud_retry gcloud run jobs list --region="$REGION" --filter="metadata.name=$JOB" --format='value(metadata.name)'); then
    echo "JUDGE EXAM COULD NOT RUN: could not read the job list; this is not a judge result." >&2; return 3
  fi
  [ -n "${listed//$'\r'/}" ] || { echo "JUDGE EXAM COULD NOT RUN: $JOB does not exist yet; run bash infra/deploy.sh first." >&2; return 3; }
  joined=$(cli_args exam) || return 3
  GCLOUD_JOB_EXECUTE_FLAGS=("--args=$joined" --update-env-vars=LIVE_SMOKE=1)
  out=$(mktemp) || { echo "JUDGE EXAM COULD NOT RUN: no temp file on this laptop (is the disk full?); this is not a judge result." >&2; return 3; }
  echo "==> $JOB: EXECUTE exam (LIVE_SMOKE=1, live judge calls)"
  MSYS2_ARG_CONV_EXCL='--args=' gcloud_job_run "$JOB" "$REGION" 0 | tee "$out" || rc=$?
  unset GCLOUD_JOB_EXECUTE_FLAGS
  if [ "$rc" = 0 ]; then
    rm -f "$out"
    echo "JUDGE EXAM PASSED: the judges met every bar. This counts as a pass for the deploy whose exam failed; no redeploy is needed."
    return 0
  fi
  if grep -q 'JUDGE EXAM FAIL:' "$out"; then rm -f "$out"; return 1; fi
  rm -f "$out"
  echo "JUDGE EXAM COULD NOT RUN: the execution gave no judge result (a network drop, a job failure or a log not readable yet). This is not a judge result." >&2
  return 3
}

case "${1:-}" in
  deploy) deploy ;;
  exam) shift; exam ;;
  proof) shift; execute_cli --live proof "$@" ;;
  recut) shift; execute_cli recut "$@" ;;
  upload) shift; upload "$@" ;;
  run) shift; run "$@" ;;
  *) echo "Usage: bash infra/catalog-output-evals.sh deploy | upload | run [--live] [cli flags...] | exam | proof [--limit n] | recut --batch <id> --photos <identifier_n,...>" >&2; exit 2 ;;
esac
