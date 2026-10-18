#!/usr/bin/env bash
# One fixed eight-CPU quota request for the approved test pool; does not start a build.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
preference=catalog-test-render05-us-central1
existing=$(gcloud beta quotas preferences list --project=image-links-agent --filter="name:$preference" --format='value(name)')
if [[ -z "$existing" ]]; then
  gcloud beta quotas preferences create --project=image-links-agent --service=cloudbuild.googleapis.com \
    --quota-id=OngoingPrivatePoolBuildCPUsPerProjectPerRegionPerBuildOrigin \
    --preferred-value=8 --dimensions=region=us-central1,build_origin=default \
    --preference-id="$preference" --email="$(gcloud config get-value account 2>/dev/null)" \
    --justification='One 8 CPU private test worker for a bounded catalog image verification run. No concurrent workers; scales to zero.' \
    --format='json(name,dimensions,quotaConfig,reconciling)'
else
  gcloud beta quotas preferences describe "$preference" --project=image-links-agent \
    --format='json(name,dimensions,quotaConfig,reconciling)'
fi
