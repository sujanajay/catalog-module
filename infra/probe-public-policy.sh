#!/usr/bin/env bash
# Diagnose the existing caller's policy authority without changing IAM or organization policy.
# The only resource change is enabling the diagnostic API if it is not already enabled.
# Usage from the repo root: bash infra/probe-public-policy.sh > policy-authority.json
# Diagnostic progress goes to stderr; stdout is the unmodified troubleshooter JSON response.
set -euo pipefail

PROJECT=image-links-agent
PROJECT_NUMBER=847405579637
PRINCIPAL=sujan@opptra.com
API=policytroubleshooter.googleapis.com
export CLOUDSDK_CORE_PROJECT="$PROJECT"

gcv() { gcloud "$@" | tr -d '\r'; }
log() { printf '[public-policy-probe] %s\n' "$*" >&2; }

enabled="$(gcv services list --enabled --filter="config.name=$API" \
  --format='value(config.name)' --project="$PROJECT" --quiet)"
if [[ "$enabled" == "$API" ]]; then
  log "SKIP $API already enabled"
elif [[ -z "$enabled" ]]; then
  log "ENABLE $API for the read-only permission diagnostic"
  gcloud services enable "$API" --project="$PROJECT" --quiet >&2
else
  log "ERROR unexpected service-list result; no changes made"
  exit 1
fi

# Limit Git Bash path-conversion exclusion to this API resource name. Disabling all
# MSYS conversion would break the Windows gcloud launcher itself.
MSYS2_ARG_CONV_EXCL='//cloudresourcemanager.googleapis.com/*' \
  gcloud policy-troubleshoot iam \
  "//cloudresourcemanager.googleapis.com/projects/$PROJECT_NUMBER" \
  --principal-email="$PRINCIPAL" \
  --permission=orgpolicy.policy.set \
  --project="$PROJECT" --format=json --quiet
