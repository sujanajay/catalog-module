#!/usr/bin/env bash
# Spec 18 GPU upscaler: ask for 6 RTX PRO 6000 GPUs (without zonal redundancy) for Cloud Run in asia-south2, the
# region of catalog-upscale-gpu (owner approved quota requests 2026-10-30). The quota is counted in milli GPU, so 6
# GPUs is 6000. Idempotent: an existing preference with the same id is checked, never changed. Once Google grants it,
# raise UPSCALE_GPU_QUOTA (infra/lib/shape.sh) and then UPSCALE_GPU_MAX_INSTANCES.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
preference=catalog-run-rtx6000-asia-south2
quota_id=NvidiaRtxPro6000GpuAllocNoZonalRedundancyPerProjectRegion
# Parse the actual list response locally: the provider does not reliably filter name.
preferences=$(gcloud beta quotas preferences list --project=image-links-agent \
  --format='json(name,service,quotaId,dimensions,quotaConfig,reconciling)')
existing=$(printf '%s' "$preferences" | PREF="$preference" node -e '
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
    if (name.endsWith("/quotaPreferences/" + process.env.PREF)) matches.push(preference);
  }
  if (matches.length > 1) throw new Error("Duplicate GPU quota preference identity");
  if (matches.length === 1) process.stdout.write(JSON.stringify(matches[0]));
')
if [[ -z "$existing" ]]; then
  gcloud beta quotas preferences create --project=image-links-agent --service=run.googleapis.com \
    --quota-id="$quota_id" --preferred-value=6000 --dimensions=region=asia-south2 \
    --preference-id="$preference" --email="$(gcloud config get-value account 2>/dev/null)" \
    --justification='Cloud Run GPU service for AI image enlargement in a product catalog pipeline: up to 6 RTX PRO 6000 instances, min instances 0, scales to zero when idle.' \
    --format='json(name,dimensions,quotaConfig,reconciling)'
else
  printf '%s' "$existing" | QUOTA_ID="$quota_id" node -e '
    const fs = require("node:fs");
    const preference = JSON.parse(fs.readFileSync(0, "utf8"));
    const mismatches = [];
    if (preference.service !== "run.googleapis.com") mismatches.push("service");
    if (preference.quotaId !== process.env.QUOTA_ID) mismatches.push("quotaId");
    if (![6000, "6000"].includes(preference.quotaConfig?.preferredValue)) mismatches.push("quotaConfig.preferredValue");
    const dimensions = preference.dimensions ?? {};
    if (dimensions.region !== "asia-south2" || Object.keys(dimensions).length !== 1) mismatches.push("dimensions");
    if (mismatches.length) {
      console.error("Existing quota preference differs from the fixed six-GPU request: " + mismatches.join(", "));
      process.exit(1);
    }
  '
  printf '%s\n' "$existing"
fi
