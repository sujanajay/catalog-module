# Spec 17 3.2.1: the service registry. infra/deploy.sh deploys these Cloud Run services in this order, each behind
# deploy_service (infra/lib/gate.sh). Adding a service is adding one name to SERVICES, one service_<name> function
# and one probe; deploy_service does not change, and deploy.sh changes only when another service must read the new
# one's URL (as the worker reads the matting URLs).
#
# A service_<name> function (dashes become underscores) is called right before that service is deployed, so it can
# use what earlier services produced (the worker's MATTING_URL comes from the matting gates). It sets:
#   SVC_NAME           the Cloud Run service (the preview stack swaps in its own names)
#   SVC_REGION         its region
#   SVC_IMAGE          the image to deploy
#   SVC_ARGS           array: every other gcloud run deploy flag (service account, shape, network, secrets, labels)
#   SVC_ENV            the --set-env-vars value (compared with the live revision for SKIP)
#   SVC_PROBE          array: the probe command; the gate appends the candidate's tag URL and runs it under timeout
#   SVC_PROBE_TIMEOUT  seconds before the probe is killed and counts as failed
#   SVC_DEPLOY         1 to deploy; 0 to reuse the live service as it is (the preview never changes catalog-matting)
#   SVC_SHIFT          1 to move traffic to a passing candidate; 0 to leave it a no-traffic candidate (preview GPU)
#   SVC_TAG            optional: the candidate tag (default candidate)
#   SVC_QUOTA_OPTIONAL 1 when a quota refusal on first creation only warns (the GPU service; the worker then uses CPU)
# Every service here can take --no-traffic, so every one goes through the candidate tag.
# The registry functions are pure bash (they read deploy.sh's variables and call nothing), so
# infra/tests/gate.test.mjs runs them offline; only the probes below call gcloud, each as its own process.

SERVICES=(catalog-matting catalog-matting-gpu catalog-worker catalog-web)

# The region of a service by name, also for deploy.sh --rollback (which sets nothing else).
service_region() {
  case "$1" in
    catalog-matting-gpu) echo "${GPU_REGION:-asia-southeast1}" ;;
    *) echo "${REGION:-asia-south1}" ;;
  esac
}

# The cut-out models the probes measure: the shape's GPU_MATTE_MODELS (infra/lib/shape.sh), all four by default.
probe_models() { echo "${GPU_MATTE_MODELS:-birefnet-general,birefnet-general-lite,birefnet-hrsod,bria-rmbg}"; }

service_catalog_matting() {
  # Spec 16 3.2.4: one resident cut-out model, and /upscale served (UPSCALE_CPU=1). The upscaler loads only when a
  # call comes, and calls come only when the worker's UPSCALE_URL names this service (UPSCALE_SERVICE=cpu), or from
  # the preview stack and the fidelity gate, so serving it costs nothing otherwise.
  SVC_NAME=catalog-matting
  SVC_REGION=$(service_region "$SVC_NAME")
  SVC_IMAGE=$AR/matting:$TAG
  SVC_ARGS=(--service-account="$MATTING_SA" --cpu=4 --memory=16Gi --concurrency=1 --min-instances=0
    --max-instances="$MATTING_CPU_MAX_INSTANCES" --timeout=300 --labels=app=catalog,component=matte)
  SVC_ENV="MAX_RESIDENT_SESSIONS=1,UPSCALE_CPU=1"
  SVC_PROBE=(bash infra/lib/services.sh probe-matting "$(probe_models)" 1)
  SVC_PROBE_TIMEOUT=300
  # Reuse 05's existing CPU matting service; never change it from an unmerged preview.
  SVC_DEPLOY=1; [ "${CATALOG_PREVIEW:-0}" = 1 ] && SVC_DEPLOY=0
  SVC_SHIFT=1
  SVC_QUOTA_OPTIONAL=0
}

service_catalog_matting_gpu() {
  # Spec 16 3.1: resident cut-out models and the CUDA arena cap per model. Spec 17 3.3.2: the cuDNN and lock-scope
  # knobs reach the service only when set, so one knob moves per candidate.
  SVC_NAME=catalog-matting-gpu
  SVC_REGION=$(service_region "$SVC_NAME")
  SVC_IMAGE=$AR/matting-gpu:$TAG
  SVC_ARGS=(--service-account="$MATTING_SA" --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy --no-cpu-throttling
    --cpu="$GPU_CPU" --memory="$GPU_MEMORY" --concurrency="$GPU_CONCURRENCY" --min-instances=0
    --max-instances="$GPU_MAX_INSTANCES" --timeout=300 --labels=app=catalog,component=matte-gpu)
  SVC_ENV="MAX_RESIDENT_SESSIONS=$MAX_RESIDENT_SESSIONS"
  local knob
  for knob in GPU_MEM_LIMIT_BYTES CUDNN_CONV_ALGO_SEARCH CUDNN_CONV_USE_MAX_WORKSPACE INFERENCE_LOCK_SCOPE; do
    if [ -n "${!knob:-}" ]; then SVC_ENV+=",$knob=${!knob}"; fi
  done
  # 600 s: a cold L4 start plus loading every model once.
  SVC_PROBE=(bash infra/lib/services.sh probe-matting "$(probe_models)" "$GPU_CONCURRENCY")
  SVC_PROBE_TIMEOUT=600
  SVC_DEPLOY=1
  # Spec 17 3.2.5: the preview deploys the GPU service as a no-traffic candidate and never shifts traffic.
  # Its own per-commit tag, so the URL the preview worker calls stays on this revision whatever deploys next.
  SVC_SHIFT=1; [ "${CATALOG_PREVIEW:-0}" = 1 ] && { SVC_SHIFT=0; SVC_TAG=preview-$TAG; }
  SVC_QUOTA_OPTIONAL=1
}

service_catalog_worker() {
  SVC_NAME=$WORKER_SERVICE
  SVC_REGION=$(service_region "$SVC_NAME")
  SVC_IMAGE=$AR/worker:$TAG
  SVC_ARGS=(--service-account="$WORKER_SA" --cpu="$WORKER_CPU" --memory="$WORKER_MEMORY"
    --concurrency="$WORKER_CONCURRENCY" --min-instances=0 --max-instances="$WORKER_MAX_INSTANCES" --timeout=900
    "${NET[@]}" --set-secrets="$WORKER_SECRETS" --labels=app=catalog,component=worker)
  SVC_ENV=$WORKER_ENV
  # The smoke runs on the matting candidates of this deploy (their tag URLs) and names the worker candidate.
  SVC_PROBE=(env "SMOKE_MATTING_URL=${MATTING_PROBE_URL:-}" "SMOKE_MATTING_GPU_URL=${MATTING_GPU_PROBE_URL:-}"
    bash infra/lib/services.sh probe-worker)
  # Spec 3.2.2 says 300 s for non-GPU services, but the tier 5 smoke inside this probe takes about 10 minutes
  # (2026-10-21: 10.5 min) and is bounded by its own job timeout of 1500 s (3.2.4). 300 s for /health plus 1500 s.
  SVC_PROBE_TIMEOUT=1800
  SVC_DEPLOY=1
  SVC_SHIFT=1
  SVC_QUOTA_OPTIONAL=0
}

service_catalog_web() {
  SVC_NAME=$WEB_SERVICE
  SVC_REGION=$(service_region "$SVC_NAME")
  SVC_IMAGE=$AR/web:$TAG
  # Private (only IAP's service agent may invoke it; never --allow-unauthenticated) and behind IAP with the
  # Google-managed OAuth client: no OAuth client, consent screen or secret of ours.
  SVC_ARGS=(--service-account="$WEB_SA" --iap --cpu=1 --memory=1Gi --min-instances=0
    --max-instances="$WEB_MAX_INSTANCES" --timeout=300 "${NET[@]}" --set-secrets="$SECRETS"
    --labels=app=catalog,component=web)
  SVC_ENV=$WEB_ENV
  SVC_PROBE=(bash infra/lib/services.sh probe-web)
  SVC_PROBE_TIMEOUT=300
  SVC_DEPLOY=1
  SVC_SHIFT=1
  SVC_QUOTA_OPTIONAL=0
}

# ---- Probes. Each runs as its own process (bash infra/lib/services.sh probe-<kind> ... <url>), exits non-zero on
# any failure and never prints a token. ----

# GET <url><path> with the operator's identity token; fails on anything but 200. Retries cover a cold start.
probe_get() {
  local url=$1 code token
  token=$(gcloud auth print-identity-token | tr -d '\r') || { echo "probe: no identity token (gcloud auth login)" >&2; return 1; }
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 60 --retry 5 --retry-delay 5 --retry-all-errors \
    -H "Authorization: Bearer $token" "$url") || code=000
  echo "probe: GET $url -> $code"
  [ "$code" = 200 ]
}

# Spec 17 3.3.1 (G3): the matting probe measures the candidate with the shape's models and concurrency.
probe_matting() {
  local models=$1 concurrency=$2 url=$3
  bash infra/check-matting.sh --probe "$url" --models "$models" --concurrency "$concurrency"
}

# /health on the worker candidate, then the tier 5 smoke against the candidates of this deploy.
probe_worker() {
  local url=$1 run
  probe_get "$url/health" || return 1
  if [ "${CATALOG_LOCAL_SMOKE:-0}" = 1 ]; then
    pnpm --filter @catalog/worker build && pnpm catalog:smoke
    return
  fi
  run=$(node -e 'console.log(require("crypto").randomUUID())')
  CATALOG_TEST_RUN=$run CATALOG_TEST_JOBS=smoke MATTING_URL=$SMOKE_MATTING_URL MATTING_GPU_URL=$SMOKE_MATTING_GPU_URL \
    WORKER_URL=$url bash infra/catalog-test-jobs.sh || return 1
  bash infra/catalog-smoke-linux.sh || return 1
  echo "probe: smoke passed (evidence: gs://image-links-agent-assets/catalog-test/smoke/linux-$run/smoke/)"
}

# /health and the home page through IAP with the operator's identity.
probe_web() {
  local url=$1
  probe_get "$url/health" && probe_get "$url/"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  export CLOUDSDK_CORE_PROJECT=image-links-agent
  cd "$(dirname "$0")/../.."
  case "${1:-}" in
    probe-matting) probe_matting "$2" "$3" "$4" ;;
    probe-worker) probe_worker "$2" ;;
    probe-web) probe_web "$2" ;;
    *) echo "usage: bash infra/lib/services.sh probe-matting <models> <concurrency> <url> | probe-worker <url> | probe-web <url>" >&2; exit 2 ;;
  esac
fi
