#!/usr/bin/env bash
# Mandatory Linux smoke gate for hosts without a working Linux Docker runtime.
# Prepare via catalog-test-jobs.sh after building the exact committed test images.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
cd "$(dirname "$0")/.."
TAG=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain)" ] || { echo "Commit source changes before preparing or running commit-tagged verification jobs." >&2; exit 1; }
job=$(gcloud run jobs describe catalog-test-smoke --region=asia-south1 --format=json)
node --input-type=commonjs - "$TAG" "$job" <<'NODE'
const assert=require('node:assert/strict');
const [tag,json]=process.argv.slice(2),job=JSON.parse(json),spec=job.spec.template.spec,task=spec.template.spec;
assert.equal(task.containers.length,1);
assert.equal(task.containers[0].image,`asia-south1-docker.pkg.dev/image-links-agent/apps/worker:${tag}`,'Smoke job must use the exact current commit image.');
assert.equal(spec.taskCount,1);assert.equal(spec.parallelism,1);assert.equal(task.maxRetries,0);assert.equal(Number(task.timeoutSeconds),1500);
assert.equal(task.serviceAccountName,'catalog-worker@image-links-agent.iam.gserviceaccount.com');
assert.deepEqual(task.containers[0].command,['/bin/sh']);
assert.deepEqual(task.containers[0].args,['-ec','mkdir -p /tmp/catalog-data; tar -xf /catalog-input/anta.tar -C /tmp/catalog-data; tar -xf /catalog-input/french-connection.tar -C /tmp/catalog-data; exec node dist/catalog-smoke.js'],'The job must run the actual smoke entry.');
NODE
gcloud run jobs execute catalog-test-smoke --region=asia-south1 --quiet --wait
