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
  description=$(gcloud beta quotas preferences describe "$preference" --project=image-links-agent \
    --format='json(name,service,quotaId,dimensions,quotaConfig,reconciling)')
  printf '%s' "$description" | node -e '
    const fs = require("node:fs");
    const preference = JSON.parse(fs.readFileSync(0, "utf8"));
    const mismatches = [];
    if (preference.service !== "cloudbuild.googleapis.com") mismatches.push("service");
    if (preference.quotaId !== "OngoingPrivatePoolBuildCPUsPerProjectPerRegionPerBuildOrigin") mismatches.push("quotaId");
    if (![8, "8"].includes(preference.quotaConfig?.preferredValue)) mismatches.push("quotaConfig.preferredValue");
    const dimensions = preference.dimensions ?? {};
    if (dimensions.region !== "us-central1" || dimensions.build_origin !== "default" || Object.keys(dimensions).length !== 2) mismatches.push("dimensions");
    if (mismatches.length) {
      console.error("Existing quota preference differs from the fixed eight-CPU request: " + mismatches.join(", "));
      process.exit(1);
    }
  '
  printf '%s\n' "$description"
fi
