#!/usr/bin/env bash
# Spec 08: the Cloud Run job catalog-eval runs the bake-off CLI (dist/catalog-eval.js) from the worker
# image of the current commit, with the same service account, network and secrets as catalog-migrate
# plus the OpenRouter key mounted from Secret Manager. The real Anta and French Connection tarballs
# are mounted read only (the same folder catalog-qa-check uses); the CLI unpacks them for assemble.
# LIVE_SMOKE is never part of the job definition: only "exec --live" sets LIVE_SMOKE=1, for that one
# execution. Every artifact stays under catalog-test/ (catalog-test/eval/<set>/ in the assets bucket).
#
# Usage (Git Bash, from the repo root):
#   bash infra/catalog-eval.sh deploy                  # called by infra/deploy.sh (Jobs step); needs
#                                                      # EVAL_JOB_IMAGE, EVAL_JOB_ENV, EVAL_JOB_SECRETS
#   bash infra/catalog-eval.sh exec <cli args...>      # one execution, no live judge calls, e.g.
#   bash infra/catalog-eval.sh exec assemble --set anta --brand anta --sample 1 --seed 1
#   EVAL_BUDGET_USD=2 bash infra/catalog-eval.sh exec --live judges --batch <id> --models <a,b>
#                                                      # one execution with LIVE_SMOKE=1 (spends credit)
# PowerShell equivalent (from the repo root):
#   & "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe" infra/catalog-eval.sh exec score --set anta --batches <id>
# Secret values are never read or printed.
set -euo pipefail

PROJECT=image-links-agent
REGION=asia-south1
JOB=catalog-eval
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
  : "${EVAL_JOB_IMAGE:?EVAL_JOB_IMAGE missing: deploy through bash infra/deploy.sh}"
  : "${EVAL_JOB_ENV:?EVAL_JOB_ENV missing: deploy through bash infra/deploy.sh}"
  : "${EVAL_JOB_SECRETS:?EVAL_JOB_SECRETS missing: deploy through bash infra/deploy.sh}"
  case ",$EVAL_JOB_ENV," in *,LIVE_SMOKE=*) echo "ERROR: LIVE_SMOKE must not be part of the job definition" >&2; exit 1 ;; esac
  case ",$EVAL_JOB_SECRETS," in *,OPENROUTER_API_KEY=openrouter-api-key:*) ;; *) echo "ERROR: EVAL_JOB_SECRETS must mount openrouter-api-key" >&2; exit 1 ;; esac

  # Volumes are added by flag; on an update clear them first so a re-run never duplicates them.
  local volume_flags=()
  if job_exists; then
    echo "==> $JOB: UPDATE to $EVAL_JOB_IMAGE"
    volume_flags+=(--clear-volumes --clear-volume-mounts)
  else
    echo "==> $JOB: CREATE from $EVAL_JOB_IMAGE"
  fi
  volume_flags+=(--add-volume="name=input,type=cloud-storage,bucket=$INPUT_BUCKET,readonly=true,mount-options=only-dir=$INPUT_PREFIX;uid=1000;gid=1000")
  volume_flags+=(--add-volume-mount="volume=input,mount-path=/catalog-input")

  # The command is the CLI itself, so "gcloud run jobs execute --args=..." passes only the CLI words.
  # MSYS2_ARG_CONV_EXCL: Git Bash would rewrite "/..." values inside these flags into Windows paths.
  MSYS2_ARG_CONV_EXCL='--command=;--args=;--set-env-vars=;--add-volume=;--add-volume-mount=' \
  gcloud run jobs deploy "$JOB" --quiet --image="$EVAL_JOB_IMAGE" \
    --service-account="$WORKER_SA" --labels=app=catalog,component=job --max-retries=0 --task-timeout=3600 --cpu=2 --memory=4Gi "${NET[@]}" \
    "${volume_flags[@]}" \
    --command=node,dist/catalog-eval.js --args=help \
    --set-secrets="$EVAL_JOB_SECRETS" --set-env-vars="$EVAL_JOB_ENV,REAL_DATA_DIR=/tmp/catalog-data,EVAL_INPUT_DIR=/catalog-input"
}

# Builds the --args value for "gcloud run jobs execute" from the CLI words.
# gcloud treats --args as a set: it refuses any value that appears twice, both on the command line and
# in a --flags-file list (UpdateAction in googlecloudsdk/calliope/arg_parsers.py), so
# "--sample 1 --seed 1" failed with '"1" cannot be specified multiple times'. Each "--flag value"
# pair is therefore folded into one "--flag=value" token (the CLI reads both forms, with the same
# rule: a flag takes the next token unless it is missing or is itself a flag), which keeps every token
# of a valid command line unique. gcloud list escaping (gcloud topic escaping): "^|^" makes "|" the
# separator, so model lists such as "a,b" stay one argument.
cli_args() {
  local argv=("$@") tokens=() i=0 a next joined dup
  while [ "$i" -lt "${#argv[@]}" ]; do
    a=${argv[$i]}; next=${argv[$((i + 1))]-}
    if [[ $a == --* && $a != *=* && $((i + 1)) -lt ${#argv[@]} && $next != --* ]]; then
      tokens+=("$a=$next"); i=$((i + 2))
    else
      tokens+=("$a"); i=$((i + 1))
    fi
  done
  for a in "${tokens[@]}"; do
    case "$a" in *"|"*) echo "ERROR: an argument contains '|', which this script uses as the gcloud list separator: $a" >&2; return 1 ;; esac
  done
  dup=$(printf '%s\n' "${tokens[@]}" | sort | uniq -d | head -n 1)
  if [ -n "$dup" ]; then
    echo "ERROR: the argument $dup is given twice; gcloud run jobs execute cannot pass a repeated argument. Remove the repeat." >&2
    return 1
  fi
  joined=$(printf '%s|' "${tokens[@]}")
  printf '%s' "^|^${joined%|}"
}

exec_job() {
  job_exists || { echo "ERROR: $JOB does not exist yet; run bash infra/deploy.sh first" >&2; exit 1; }
  local env_flags=() live=0
  if [ "${1:-}" = "--live" ]; then live=1; shift; fi
  [ "$#" -gt 0 ] || { echo "Usage: bash infra/catalog-eval.sh exec [--live] <cli args...>" >&2; exit 2; }
  local updates=()
  [ "$live" = 1 ] && updates+=("LIVE_SMOKE=1")
  if [ -n "${EVAL_BUDGET_USD:-}" ]; then
    [[ "$EVAL_BUDGET_USD" =~ ^[0-9]+([.][0-9]+)?$ ]] || { echo "EVAL_BUDGET_USD must be a number" >&2; exit 1; }
    updates+=("EVAL_BUDGET_USD=$EVAL_BUDGET_USD")
  fi
  if [ "${#updates[@]}" -gt 0 ]; then
    env_flags+=(--update-env-vars="$(IFS=,; echo "${updates[*]}")")
  fi
  local joined
  joined=$(cli_args "$@") || exit 2
  echo "==> $JOB: EXECUTE $* $([ "$live" = 1 ] && echo '(LIVE_SMOKE=1, live judge calls)')"
  MSYS2_ARG_CONV_EXCL='--args=' gcloud run jobs execute "$JOB" --region="$REGION" --args="$joined" "${env_flags[@]}" --wait
  echo "Logs: gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=$JOB' --limit=200 --freshness=1h"
}

case "${1:-}" in
  deploy) deploy ;;
  exec) shift; exec_job "$@" ;;
  *) echo "Usage: bash infra/catalog-eval.sh deploy|exec [--live] <cli args...>" >&2; exit 2 ;;
esac
