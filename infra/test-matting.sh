#!/usr/bin/env bash
# Build both images and verify real CPU inference in an ephemeral Cloud Build VM.
# Does not deploy services. All published images carry the current commit tag.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
cd "$(dirname "$0")/.."
TAG=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "ERROR: commit service changes before submitting a tagged build" >&2
  exit 1
fi
AR=asia-south1-docker.pkg.dev/image-links-agent/apps
gcloud builds submit --project=image-links-agent --config=services/matting/cloudbuild-test.yaml \
  --substitutions="_AR=$AR,_TAG=$TAG" .
