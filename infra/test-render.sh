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
# Full mode requires explicit budget approval under execution protocol section 11.
if [[ "$FULL_RENDER" == 1 ]]; then build_timeout=86400s; test_timeout=23h; else build_timeout=1200s; test_timeout=15m; fi
[[ "$INPUT_PREFIX" =~ ^gs://image-links-agent-assets/catalog-test/([a-z0-9][a-z0-9-]{7,79})/inputs/$ ]] || { echo 'Invalid private input prefix' >&2; exit 2; }
run=${BASH_REMATCH[1]}
[[ "$ARTIFACT_PREFIX" == "gs://image-links-agent-assets/catalog-test/$run/artifacts/" ]] || { echo 'Artifact prefix must match the same run' >&2; exit 2; }
[[ "$MATTING_IMAGE" =~ ^asia-south1-docker.pkg.dev/image-links-agent/apps/matting:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$ ]] || { echo 'Invalid private CPU image tag' >&2; exit 2; }
gcloud builds submit --project=image-links-agent --region=asia-south1 --async \
  --config=services/matting/cloudbuild-render-test.yaml --timeout="$build_timeout" \
  --substitutions="_INPUT_PREFIX=$INPUT_PREFIX,_MATTING_IMAGE=$MATTING_IMAGE,_ARTIFACT_PREFIX=$ARTIFACT_PREFIX,_FULL_RENDER=$FULL_RENDER,_TEST_TIMEOUT=$test_timeout,_BUILD_TIMEOUT=$build_timeout" .
