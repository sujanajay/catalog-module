#!/usr/bin/env bash
# One fixed eight-CPU quota request for the approved test pool; does not start a build.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
preference=catalog-test-render05-us-central1
# Parse the actual list response locally: the provider does not reliably filter name.
preferences=$(gcloud beta quotas preferences list --project=image-links-agent \
  --format='json(name,service,quotaId,dimensions,quotaConfig,reconciling)')
existing=$(printf '%s' "$preferences" | node -e '
  const fs = require("node:fs");
  const preferences = JSON.parse(fs.readFileSync(0, "utf8"));
  if (!Array.isArray(preferences)) throw new Error("Quota preference list must be an array");
  const names = new Set();
  const matches = [];
  for (const preference of preferences) {
    const name = preference?.name;
    if (typeof name !== "string" || !/^projects\/(image-links-agent|847405579637)\/locations\/global\/quotaPreferences\/[^/]+$/.test(name) || names.has(name)) {
      throw new Error("Malformed or duplicate quota preference identity");
    }
    names.add(name);
    if (name.endsWith("/quotaPreferences/catalog-test-render05-us-central1")) matches.push(preference);
  }
  if (matches.length > 1) throw new Error("Duplicate test quota preference identity");
  if (matches.length === 1) process.stdout.write(JSON.stringify(matches[0]));
')
if [[ -z "$existing" ]]; then
  gcloud beta quotas preferences create --project=image-links-agent --service=cloudbuild.googleapis.com \
    --quota-id=OngoingPrivatePoolBuildCPUsPerProjectPerRegionPerBuildOrigin \
    --preferred-value=8 --dimensions=region=us-central1,build_origin=default \
    --preference-id="$preference" --email="$(gcloud config get-value account 2>/dev/null)" \
    --justification='One 8 CPU private test worker for a bounded catalog image verification run. No concurrent workers; scales to zero.' \
    --format='json(name,dimensions,quotaConfig,reconciling)'
else
  description=$existing
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
