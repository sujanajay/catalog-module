#!/usr/bin/env bash
# One-off test pool. No VPC peering, IAM changes, updates, or deletes.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
pool=catalog-test-render05
region=us-central1
resource="projects/image-links-agent/locations/$region/workerPools/$pool"
# A failed list is an access/API error, not permission to try creation.
# gcloud 589 prints short names from list and a full-name filter does not match, so list all
# and compare basenames (docs/solutions/gcloud-list-names.md).
existing=$(gcloud builds worker-pools list --project=image-links-agent --region="$region" --format='value(name)' | tr -d '\r' | sed 's#.*/##')
if ! grep -qxF "$pool" <<<"$existing"; then
  gcloud builds worker-pools create "$pool" --project=image-links-agent --region="$region" \
    --worker-machine-type=e2-standard-8 --worker-disk-size=100GB
fi
config=$(gcloud builds worker-pools describe "$pool" --project=image-links-agent --region="$region" \
  --format='csv[no-heading](state,privatePoolV1Config.workerConfig.machineType,privatePoolV1Config.workerConfig.diskSizeGb,privatePoolV1Config.networkConfig.peeredNetwork,privatePoolV1Config.networkConfig.egressOption,privatePoolV1Config.privateServiceConnect.networkAttachment)')
case "$config" in
  RUNNING,e2-standard-8,100,,PUBLIC_EGRESS,|RUNNING,e2-standard-8,100,,EGRESS_OPTION_UNSPECIFIED,|RUNNING,e2-standard-8,100,,,)
    echo "Verified test pool: $resource" ;;
  *) echo 'Existing test pool differs or is not RUNNING; no changes made.' >&2; exit 2 ;;
esac
