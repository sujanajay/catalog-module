#!/usr/bin/env bash
# Runtime check of the deployed matting services, run as the Cloud Run job catalog-check-matting.
#   bash infra/check-matting.sh
#       checks the CPU and GPU services the worker uses (OIDC, /health, /convert, /matte).
#   bash infra/check-matting.sh --probe <url> [--models a,b] [--concurrency n] [--rounds k] [--run name]
#       spec 17 3.3.1: measures one service URL (usually the GPU candidate's tag URL) with
#       services/matting/tests/cloudrun_check.py --probe: per model a warm 1024 px call, then n calls at once for
#       k rounds, then the switching order. Prints the table and writes the JSON report to
#       gs://image-links-agent-assets/catalog-test/probe/<execution>/. Fails on any non-200 or a reload.
#   bash infra/check-matting.sh --probe-upscale <url> [--model swinir-x2] [--sizes 800x1200,1600x1600]
#                               [--concurrency n] [--rounds k] [--timeout s] [--run name]
#       spec 18 H1: times POST /upscale on one service URL (usually a catalog-upscale candidate's tag URL) with
#       cloudrun_check.py --probe-upscale: per size a warm call, then n calls at once for k rounds. Prints
#       size | vCPU | threads | tile | conc | p50 s | p95 s | max s | non-200 | output sha256 and writes
#       gs://image-links-agent-assets/catalog-test/probe/<execution>/upscale.json. --timeout is the per-call client
#       timeout (default 900 s). Fails on any non-200, a wrong size or differing output for the same input.
set -euo pipefail
export CLOUDSDK_CORE_PROJECT=image-links-agent
cd "$(dirname "$0")/.."
# The probe's arguments for the job's --args. gcloud treats --args as a set: it refuses any item that appears twice,
# also in a --flags-file list (UpdateAction in googlecloudsdk/calliope/arg_parsers.py), so "--concurrency 1 --rounds 1"
# failed the deploy gate on 2026-10-28 with '"1" cannot be specified multiple times'. Each option therefore travels
# as one "--option=value" item (argparse in cloudrun_check.py reads it the same way), each option at most once, and
# the URL once: every item is unique by construction. Anything else is refused here, before any gcloud call.
PROBE_ARGS=()
# A probe run by hand ends after an hour (the upscale probe, slower per call, after two); the gate sets its own.
DEFAULT_TASK_TIMEOUT=3600
if [ "${1:-}" = "--probe" ] || [ "${1:-}" = "--probe-upscale" ]; then
  mode=$1; shift
  if [ "$mode" = --probe ]; then
    allowed=" --models --concurrency --rounds --run "
    usage="usage: $0 --probe <url> [--models a,b] [--concurrency n] [--rounds k] [--run name]"
  else
    allowed=" --model --sizes --concurrency --rounds --timeout --run "
    usage="usage: $0 --probe-upscale <url> [--model id] [--sizes WxH,WxH] [--concurrency n] [--rounds k] [--timeout s] [--run name]"
    DEFAULT_TASK_TIMEOUT=7200
  fi
  [ $# -ge 1 ] || { echo "$usage" >&2; exit 2; }
  url="" seen=" " options=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --*=*) name=${1%%=*} value=${1#*=}; shift ;;
      --*)
        name=$1
        [[ $allowed == *" $name "* ]] || { echo "ERROR: unknown probe option $1" >&2; echo "$usage" >&2; exit 2; }
        [ $# -ge 2 ] && [[ $2 != --* ]] || { echo "ERROR: $1 needs a value" >&2; echo "$usage" >&2; exit 2; }
        value=$2; shift 2 ;;
      -*) echo "ERROR: unknown probe option $1" >&2; echo "$usage" >&2; exit 2 ;;
      *) [ -z "$url" ] || { echo "ERROR: one probe URL only (got $url and $1)" >&2; exit 2; }
         url=$1; shift; continue ;;
    esac
    [[ $allowed == *" $name "* ]] || { echo "ERROR: unknown probe option $name" >&2; echo "$usage" >&2; exit 2; }
    [[ $seen != *" $name "* ]] || { echo "ERROR: the probe option $name is given twice" >&2; exit 2; }
    seen+="$name "
    options+=("$name=$value")
  done
  [ -n "$url" ] || { echo "$usage" >&2; exit 2; }
  # The upscale probe's sizes and per-call timeout are checked here too (as cloudrun_check.py does), so a typo fails in
  # a second instead of after the job deploy and a cold start.
  for option in ${options[@]+"${options[@]}"}; do
    case "$option" in
      --sizes=*)
        [[ "${option#--sizes=}" =~ ^[1-9][0-9]*[xX][1-9][0-9]*(,[1-9][0-9]*[xX][1-9][0-9]*)*$ ]] \
          || { echo "ERROR: --sizes must list sizes such as 800x1200,1600x1600, got '${option#--sizes=}'" >&2; exit 2; } ;;
      --timeout=*)
        value=${option#--timeout=}
        [[ "$value" =~ ^[1-9][0-9]*$ ]] && [ "$value" -ge 30 ] && [ "$value" -le 3600 ] \
          || { echo "ERROR: --timeout must be a whole number of seconds from 30 to 3600, got '$value'" >&2; exit 2; } ;;
    esac
  done
  PROBE_ARGS=("$mode" "$url" ${options[@]+"${options[@]}"})
  # The upscale probe always writes its JSON report (catalog-test/probe/<execution>/upscale.json).
  if [ "$mode" = --probe-upscale ]; then PROBE_ARGS+=(--bucket=image-links-agent-assets); fi
fi
TEMP_DIR=$(mktemp -d)
trap 'rm -f "$TEMP_DIR/worker.json" "$TEMP_DIR/cpu.json" "$TEMP_DIR/gpu.json" "$TEMP_DIR/flags.json" "$TEMP_DIR/probe.json"; rmdir "$TEMP_DIR"' EXIT
native_path() { cygpath -m "$1" 2>/dev/null || printf '%s\n' "$1"; }
# The probe's arguments as JSON for the job's --args (an empty list for the runtime check).
node -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- ${PROBE_ARGS[@]+"${PROBE_ARGS[@]}"} > "$TEMP_DIR/probe.json"
gcloud run services describe catalog-worker --region=asia-south1 --format='json(spec.template.spec.containers[0].env)' > "$TEMP_DIR/worker.json"
gcloud run services describe catalog-matting --region=asia-south1 --format='json(status.url,status.latestReadyRevisionName,status.latestCreatedRevisionName,spec.template.spec.containers[0].image)' > "$TEMP_DIR/cpu.json"
HAS_GPU=$(node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log((v.spec?.template?.spec?.containers?.[0]?.env??[]).some(e=>e.name==="MATTING_GPU_URL"&&e.value)?"1":"0")' "$(native_path "$TEMP_DIR/worker.json")")
if [ "${HAS_GPU//$'\r'/}" = 1 ]; then
  gcloud run services describe catalog-matting-gpu --region=asia-southeast1 --format='json(status.url,status.latestReadyRevisionName,status.latestCreatedRevisionName,spec.template.spec.containers[0].image)' > "$TEMP_DIR/gpu.json"
else
  printf 'null\n' > "$TEMP_DIR/gpu.json"
fi
DEFAULT_TASK_TIMEOUT=$DEFAULT_TASK_TIMEOUT node - "$(native_path "$TEMP_DIR")" <<'NODE'
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const read = name => JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));
const worker = read('worker');
const env = Object.fromEntries((worker.spec?.template?.spec?.containers?.[0]?.env ?? []).filter(e => e.value !== undefined).map(e => [e.name, e.value]));
function service(target, configured) {
  const data = read(target);
  const url = data?.status?.url;
  const image = data?.spec?.template?.spec?.containers?.[0]?.image;
  if (!url || url !== configured || !/^https:\/\/[a-z0-9.-]+\.run\.app$/.test(url)) throw Error(target + ' worker URL does not match canonical service');
  if (!data.status.latestReadyRevisionName || data.status.latestReadyRevisionName !== data.status.latestCreatedRevisionName) throw Error(target + ' latest service revision is not ready');
  const expected = 'asia-south1-docker.pkg.dev/image-links-agent/apps/' + (target === 'cpu' ? 'matting' : 'matting-gpu') + ':';
  if (!image?.startsWith(expected) || !/^[a-f0-9]{7,40}$/.test(image.slice(expected.length))) throw Error(target + ' service image must have a commit tag');
  return {url, image, version: image.slice(expected.length)};
}
const probe = read('probe');
// A probe run by the deploy gate ends when the gate gives up (PROBE_TASK_TIMEOUT, seconds); by hand, DEFAULT_TASK_TIMEOUT.
const taskTimeout = process.env.PROBE_TASK_TIMEOUT || process.env.DEFAULT_TASK_TIMEOUT;
if (!/^[1-9][0-9]*$/.test(taskTimeout)) throw Error('PROBE_TASK_TIMEOUT must be a number of seconds');
const cpu = service('cpu', env.MATTING_URL);
// The probe takes the CPU image only to run the job; the GPU revision it measures may be a newer candidate.
const gpu = env.MATTING_GPU_URL && !probe.length ? service('gpu', env.MATTING_GPU_URL) : null;
if (gpu && gpu.version !== cpu.version) throw Error('CPU and GPU deployment versions differ');
const variables = { MATTING_URL: cpu.url, CPU_VERSION: cpu.version };
if (gpu) Object.assign(variables, { MATTING_GPU_URL: gpu.url, GPU_VERSION: gpu.version });
const flags = {
  '--image': cpu.image, '--command': ['python'],
  '--args': ['-c', fs.readFileSync('services/matting/tests/cloudrun_check.py', 'utf8'), ...probe],
  '--region': 'asia-south1', '--service-account': 'catalog-worker@image-links-agent.iam.gserviceaccount.com',
  '--tasks': 1, '--parallelism': 1, '--max-retries': 0, '--task-timeout': probe.length ? taskTimeout + 's' : '600s',
  '--cpu': '1', '--memory': '512Mi', '--set-env-vars': variables, '--clear-secrets': true, '--labels': { app: 'catalog', component: 'job' },
};
fs.writeFileSync(path.join(dir, 'flags.json'), JSON.stringify(flags));
NODE
gcloud run jobs deploy catalog-check-matting --quiet --flags-file="$(native_path "$TEMP_DIR/flags.json")"
gcloud run jobs execute catalog-check-matting --region=asia-south1 --wait
