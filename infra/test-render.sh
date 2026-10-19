#!/usr/bin/env bash
# Test-only Linux verification; never deploys services.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
cd "$(dirname "$0")/.."
: "${INPUT_PREFIX:?Set the private run inputs/ prefix}"
: "${ARTIFACT_PREFIX:?Set the matching run artifacts/ prefix}"
: "${MATTING_IMAGE:?Set the verified private CPU image tag}"
FULL_RENDER=${FULL_RENDER:-0}
[[ "$FULL_RENDER" =~ ^[01]$ ]] || { echo 'FULL_RENDER must be 0 or 1' >&2; exit 2; }
TEST_WORKER_POOL=${TEST_WORKER_POOL:-}
region=global
pool_mode=default
render_cpus=12
compute_rate=0.0624
config=services/matting/cloudbuild-render-test.yaml
pool_args=()
if [[ -n "$TEST_WORKER_POOL" ]]; then
  expected_pool=projects/image-links-agent/locations/us-central1/workerPools/catalog-test-render05
  [[ "$TEST_WORKER_POOL" == catalog-test-render05 || "$TEST_WORKER_POOL" == "$expected_pool" ]] || { echo 'Invalid test worker pool' >&2; exit 2; }
  region=us-central1
  pool_mode=private
  render_cpus=4
  compute_rate=0.024
  pool_args=(--worker-pool="$expected_pool")
  # Pool sizing belongs to the pool. Omit default sizing rather than rely on precedence.
  config=$(mktemp)
  trap 'rm -f "$config"' EXIT
  sed '/^  machineType: E2_HIGHCPU_32$/d; /^  diskSizeGb: 100$/d' services/matting/cloudbuild-render-test.yaml > "$config"
fi
# Full mode requires explicit budget approval under execution protocol section 11.
if [[ "$FULL_RENDER" == 1 ]]; then
  if [[ "$pool_mode" == private ]]; then build_timeout=86400s; test_timeout=23h; else build_timeout=75600s; test_timeout=20h; fi
else
  build_timeout=1200s; test_timeout=15m
fi
[[ "$INPUT_PREFIX" =~ ^gs://image-links-agent-assets/catalog-test/([a-z0-9][a-z0-9-]{7,79})/inputs/$ ]] || { echo 'Invalid private input prefix' >&2; exit 2; }
run=${BASH_REMATCH[1]}
[[ "$ARTIFACT_PREFIX" == "gs://image-links-agent-assets/catalog-test/$run/artifacts/" ]] || { echo 'Artifact prefix must match the same run' >&2; exit 2; }
[[ "$MATTING_IMAGE" =~ ^asia-south1-docker.pkg.dev/image-links-agent/apps/matting:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]] || { echo 'Invalid private CPU image tag' >&2; exit 2; }
gcloud builds submit --project=image-links-agent --region="$region" --async "${pool_args[@]}" \
  --config="$config" --timeout="$build_timeout" \
  --substitutions="_INPUT_PREFIX=$INPUT_PREFIX,_MATTING_IMAGE=$MATTING_IMAGE,_ARTIFACT_PREFIX=$ARTIFACT_PREFIX,_FULL_RENDER=$FULL_RENDER,_TEST_TIMEOUT=$test_timeout,_BUILD_TIMEOUT=$build_timeout,_POOL_MODE=$pool_mode,_RENDER_CPUS=$render_cpus,_COMPUTE_RATE=$compute_rate" .
