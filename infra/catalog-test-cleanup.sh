#!/usr/bin/env bash
# Execute the predeployed cleanup job. Credentials remain in its Cloud Run secret mounts.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
if (( $# == 0 )); then
  echo "Supply the explicit catalog-test batch UUIDs to clean." >&2
  exit 2
fi
for batch_id in "$@"; do
  if [[ ! "$batch_id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then
    echo "Every cleanup argument must be a batch UUID." >&2
    exit 2
  fi
done
batch_ids=$(IFS=,; printf '%s' "$*")
flags_file=$(mktemp)
trap 'rm -f -- "$flags_file"' EXIT
printf '{"--args":["dist/catalog-smoke.js","--cleanup-batches","%s"]}\n' "$batch_ids" > "$flags_file"
gcloud run jobs execute catalog-test-cleanup --flags-file="$flags_file" \
  --region=asia-south1 --project=image-links-agent --quiet --wait
