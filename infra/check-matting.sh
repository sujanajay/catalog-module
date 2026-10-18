#!/usr/bin/env bash
# Verify private deployed services from a bounded job using the worker identity.
# Usage (Git Bash, repository root): bash infra/check-matting.sh
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
cd "$(dirname "$0")/.."
TEMP_DIR=$(mktemp -d)
trap 'rm -f "$TEMP_DIR/worker.json" "$TEMP_DIR/cpu.json" "$TEMP_DIR/gpu.json" "$TEMP_DIR/flags.json"; rmdir "$TEMP_DIR"' EXIT
native_path() { cygpath -m "$1" 2>/dev/null || printf '%s\n' "$1"; }
gcloud run services describe catalog-worker --region=asia-south1 --format='json(spec.template.spec.containers[0].env)' > "$TEMP_DIR/worker.json"
gcloud run services describe catalog-matting --region=asia-south1 --format='json(status.url,status.latestReadyRevisionName,status.latestCreatedRevisionName,spec.template.spec.containers[0].image)' > "$TEMP_DIR/cpu.json"
# Decide from the worker configuration, never from a stale GPU service left after a failed deploy.
HAS_GPU=$(node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log((v.spec?.template?.spec?.containers?.[0]?.env??[]).some(e=>e.name==="MATTING_GPU_URL"&&e.value)?"1":"0")' "$(native_path "$TEMP_DIR/worker.json")")
if [ "${HAS_GPU//$'\r'/}" = 1 ]; then
  gcloud run services describe catalog-matting-gpu --region=asia-southeast1 --format='json(status.url,status.latestReadyRevisionName,status.latestCreatedRevisionName,spec.template.spec.containers[0].image)' > "$TEMP_DIR/gpu.json"
else
  printf 'null\n' > "$TEMP_DIR/gpu.json"
fi
node - "$(native_path "$TEMP_DIR")" <<'NODE'
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));
const worker = read('worker');
const env = Object.fromEntries((worker.spec?.template?.spec?.containers?.[0]?.env ?? []).filter(e => e.value !== undefined).map(e => [e.name, e.value]));
function service(name, configured, target) {
  const data = read(name);
  const url = data?.status?.url;
  const image = data?.spec?.template?.spec?.containers?.[0]?.image;
  if (!url || url !== configured || !/^https:\/\/[a-z0-9.-]+\.run\.app$/.test(url)) throw Error(target + ' worker URL does not match canonical service');
  if (!data.status.latestReadyRevisionName || data.status.latestReadyRevisionName !== data.status.latestCreatedRevisionName) throw Error(target + ' latest service revision is not ready');
  const expected = 'asia-south1-docker.pkg.dev/image-links-agent/apps/' + (target === 'cpu' ? 'matting' : 'matting-gpu') + ':';
  if (!image?.startsWith(expected) || !/^[a-f0-9]{7,40}$/.test(image.slice(expected.length))) throw Error(target + ' service image must have a commit tag');
  return {url, image, version: image.slice(expected.length)};
}
const cpu = service('cpu', env.MATTING_URL, 'cpu');
const gpu = env.MATTING_GPU_URL ? service('gpu', env.MATTING_GPU_URL, 'gpu') : null;
if (gpu && gpu.version !== cpu.version) throw Error('CPU and GPU deployment versions differ');
const variables = { MATTING_URL: cpu.url, CPU_VERSION: cpu.version };
if (gpu) Object.assign(variables, { MATTING_GPU_URL: gpu.url, GPU_VERSION: gpu.version });
const flags = {
  '--image': cpu.image, '--command': ['python'],
  '--args': ['-c', fs.readFileSync('services/matting/tests/cloudrun_check.py', 'utf8')],
  '--region': 'asia-south1', '--service-account': 'catalog-worker@image-links-agent.iam.gserviceaccount.com',
  '--tasks': 1, '--parallelism': 1, '--max-retries': 0, '--task-timeout': '600s',
  '--cpu': '1', '--memory': '512Mi', '--set-env-vars': variables, '--clear-secrets': true,
};
fs.writeFileSync(path.join(dir, 'flags.json'), JSON.stringify(flags));
NODE
gcloud run jobs deploy catalog-check-matting --quiet --flags-file="$(native_path "$TEMP_DIR/flags.json")"
gcloud run jobs execute catalog-check-matting --region=asia-south1 --wait
