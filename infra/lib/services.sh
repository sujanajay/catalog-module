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
#   SVC_MAX            the service-level max instances (gcloud --max), the same value as the revision's
#                      --max-instances; the gate sets it once the revision serves (the lower of the two wins)
#   SVC_PROBE          array: the probe command; the gate appends the candidate's tag URL and runs it under timeout
#   SVC_PROBE_TIMEOUT  seconds before the probe is killed and counts as failed
#   SVC_DEPLOY         1 to deploy; 0 to reuse the live service as it is (the preview never changes catalog-matting);
#                      skip when this run does not use the service at all (catalog-upscale unless UPSCALE_SERVICE=dedicated
#                      or UPSCALE_MEASURE=1); SVC_SKIP_REASON says why
#   SVC_SHIFT          1 to move traffic to a passing candidate; 0 to leave it a no-traffic candidate (preview GPU)
#   SVC_TAG            optional: the candidate tag (default candidate)
#   SVC_QUOTA_OPTIONAL 1 when a quota refusal on first creation only warns (the GPU service; the worker then uses CPU)
# Every service here can take --no-traffic, so every one goes through the candidate tag.
# The registry functions are pure bash (they read deploy.sh's variables and call nothing), so
# infra/tests/gate.test.mjs runs them offline; only the probes below call gcloud, each as its own process.

# The web goes before the worker (spec 18 final check 2026-10-30): a worker that holds photos for a failed enlargement
# must never be live behind a web that lets "Use as is" stage them without the plain warning (the warning is enforced
# by the web's decision API). The new web works with the old worker: it only adds what the old worker never writes
# (Try again needs a failed enlargement row, which only the new worker makes). If the web gate fails, the worker is
# not deployed either.
# Spec 18 GPU upscaler (2026-10-30): catalog-upscale-gpu goes right after catalog-upscale, so the worker env knows both
# upscalers' URLs before the web and the worker are deployed.
SERVICES=(catalog-matting catalog-upscale catalog-upscale-gpu catalog-matting-gpu catalog-web catalog-worker)
# The Cloud Run request timeout of the matting services (CPU and GPU). Spec 18 H3: with UPSCALE_SERVICE=cpu or gpu the
# worker's enlarge task calls /upscale there and learns it as UPSCALE_TIMEOUT_S (infra/deploy.sh).
MATTING_TIMEOUT_S=300
# Spec 18 gate (plan 7.2): the calls of the same 800x1200 image the catalog-upscale probe sends at once per model, each
# with its sha256 and instance id; the gate needs at least 2 instances among them.
UPSCALE_DETERMINISM_CALLS=12

# The region of a service by name, also for deploy.sh --rollback (which sets nothing else).
service_region() {
  case "$1" in
    catalog-matting-gpu) echo "${GPU_REGION:-asia-southeast1}" ;;
    # Spec 18 GPU upscaler: its own region (owner 2026-10-30), from the UPSCALE_GPU_REGION row of infra/lib/shape.sh.
    catalog-upscale-gpu) echo "${UPSCALE_GPU_REGION:-asia-south2}" ;;
    *) echo "${REGION:-asia-south1}" ;;
  esac
}

# Spec 18 H1: 0 when this run only measures catalog-upscale (UPSCALE_MEASURE=1, not the preview). Every other service
# is then reused as it is (SVC_DEPLOY=0), and deploy.sh stops after the catalog-upscale gate, so the worker's env is
# never rebuilt and a measure rung never needs a new worker image.
upscale_measure_run() { [ "${UPSCALE_MEASURE:-0}" = 1 ] && [ "${CATALOG_PREVIEW:-0}" != 1 ]; }

# The cut-out models the probes measure: the shape's GPU_MATTE_MODELS (infra/lib/shape.sh), all four by default.
probe_models() { echo "${GPU_MATTE_MODELS:-birefnet-general,birefnet-general-lite,birefnet-hrsod,bria-rmbg}"; }

service_catalog_matting() {
  # Spec 16 3.2.4: one resident cut-out model, and /upscale served (UPSCALE_CPU=1). The upscaler loads only when a
  # call comes, and calls come only when the worker's UPSCALE_URL names this service (UPSCALE_SERVICE=cpu), or from
  # the preview stack and the fidelity gate, so serving it costs nothing otherwise.
  SVC_NAME=catalog-matting
  SVC_REGION=$(service_region "$SVC_NAME")
  SVC_IMAGE=$AR/matting:$TAG
  local concurrency=1
  SVC_ARGS=(--service-account="$MATTING_SA" --cpu=4 --memory=16Gi --concurrency="$concurrency" --min-instances=0
    --max-instances="$MATTING_CPU_MAX_INSTANCES" --timeout="$MATTING_TIMEOUT_S" --labels=app=catalog,component=matte)
  SVC_MAX=$MATTING_CPU_MAX_INSTANCES
  SVC_ENV="MAX_RESIDENT_SESSIONS=1,UPSCALE_CPU=1"
  # Sized to the service: one CPU cut-out takes 25 to 71 s (measured on a candidate 2026-10-28; the full probe of
  # 4 models x 6 calls plus the switching order took 21 min). So the default model, which the service loads at
  # start, gets 1 warm call and 1 round at the service's concurrency: 2 calls of at most about 45 s (its p95 was
  # 42 s), plus the job deploy and start and the candidate's cold start, about 3 minutes in all. 420 s leaves room
  # for a slow cold start without hiding a hang. The full measurement of every model is the GPU service's probe.
  # birefnet-general is the service's DEFAULT_MATTE_MODEL (services/matting/app.py; SVC_ENV does not change it).
  SVC_PROBE_TIMEOUT=420
  SVC_PROBE=(bash infra/lib/services.sh probe-matting "$SVC_PROBE_TIMEOUT" birefnet-general "$concurrency" 1)
  # Reuse 05's existing CPU matting service; never change it from an unmerged preview or a measure run.
  SVC_DEPLOY=1; [ "${CATALOG_PREVIEW:-0}" = 1 ] && SVC_DEPLOY=0
  if upscale_measure_run; then SVC_DEPLOY=0; fi
  SVC_SHIFT=1
  SVC_QUOTA_OPTIONAL=0
}

# The upscalers the catalog-upscale probes call, one after the other: deploy.sh's UPSCALE_MODEL (enlargements up to
# 2x) and UPSCALE_MODEL_X4 (above 2x); off still probes the default of each, so the gate always times x4 on Cloud Run
# and checks that it reruns byte-identically at the shape's threads (spec 18 quality).
# The x4 seconds for an x2 p95: times UPSCALE_X4_TIME_RATIO (infra/lib/shape.sh), rounded up.
upscale_x4_seconds() { awk -v p="$1" -v r="${UPSCALE_X4_TIME_RATIO:-1}" 'BEGIN{v = p * r; c = int(v); if (c < v) c++; print c}'; }

probe_upscale_model() {
  local x2=${UPSCALE_MODEL:-swinir-x2} x4=${UPSCALE_MODEL_X4:-swinir-x4}
  [ "$x2" = off ] && x2=swinir-x2
  [ "$x4" = off ] && x4=swinir-x4
  echo "$x2,$x4"
}

service_catalog_upscale() {
  # Spec 18 H2: the dedicated CPU enlargement service. The catalog-matting image with only the upscaler loaded
  # (PRELOAD_MATTE=0; UPSCALE_CPU=1 here is the service's switch that lets it upscale on CPU, not the shape's vCPU
  # count), sized by the UPSCALE_* rows of infra/lib/shape.sh, which refuse a shape that has not been measured.
  SVC_NAME=catalog-upscale
  SVC_REGION=$(service_region "$SVC_NAME")
  SVC_IMAGE=$AR/matting:$TAG
  SVC_ARGS=(--service-account="$MATTING_SA" --cpu="$UPSCALE_CPU_VCPU" --memory="$UPSCALE_MEMORY" --concurrency="$UPSCALE_CONCURRENCY"
    --min-instances=0 --max-instances="$UPSCALE_MAX_INSTANCES" --timeout="$UPSCALE_TIMEOUT_S" --labels=app=catalog,component=upscale)
  SVC_MAX=$UPSCALE_MAX_INSTANCES
  SVC_ENV="MAX_RESIDENT_SESSIONS=1,UPSCALE_CPU=1,PRELOAD_MATTE=0,ORT_INTRA_OP_THREADS=$UPSCALE_THREADS,UPSCALE_MAX_PIXELS=$UPSCALE_MAX_PIXELS,UPSCALE_MAX_PIXELS_X4=$UPSCALE_MAX_PIXELS_X4"
  SVC_QUOTA_OPTIONAL=0
  SVC_SKIP_REASON=""
  local size p95 budget=0 first=${UPSCALE_SIZES%%,*}
  if upscale_measure_run; then
    # Spec 18 H1, the ladder: a no-traffic candidate per shape, its own tag so every rung keeps its URL for
    # infra/check-matting.sh --probe-upscale. The gate only shows it answers: one warm call and one call of the first
    # probe size, each within the service timeout, plus about 5 minutes for the probe job and the cold start.
    # Rung 1 of a brand-new service serves the service URL (Cloud Run cannot create with --no-traffic); nothing calls
    # it, since the worker's UPSCALE_URL is not changed by a measure run.
    SVC_DEPLOY=1; SVC_SHIFT=0
    SVC_TAG=measure-${UPSCALE_CPU_VCPU}c-${UPSCALE_THREADS}t-${UPSCALE_CONCURRENCY}r
    SVC_PROBE_TIMEOUT=$((300 + 4 * UPSCALE_TIMEOUT_S))
    SVC_PROBE=(bash infra/lib/services.sh probe-upscale "$SVC_PROBE_TIMEOUT" "$(probe_upscale_model)" "$first" 1 1 "$UPSCALE_TIMEOUT_S" 0 0 0 0)
    return 0
  fi
  if [ "${UPSCALE_SERVICE:-cpu}" != dedicated ]; then
    SVC_DEPLOY=skip; SVC_SHIFT=0; SVC_PROBE=(); SVC_PROBE_TIMEOUT=0
    SVC_SKIP_REASON="UPSCALE_SERVICE=${UPSCALE_SERVICE:-cpu}; the worker does not call it"
    return 0
  fi
  # Sized from the measured table (shape_check has refused a shape without a p95 for every size): per model (x2 and
  # x4) and size a warm call and one round at the shape's concurrency, 2 x p95 each, plus 300 s for the probe job and
  # the cold start. The table holds x2 p95s; the x4 budget is the x2 p95 times UPSCALE_X4_TIME_RATIO (infra/lib/shape.sh,
  # 1.3, the slowest x4/x2 pair measured on 2026-10-29), rounded up.
  for size in ${UPSCALE_SIZES//,/ }; do
    p95=$(upscale_p95 "$size")
    p95=${p95:-$UPSCALE_TIMEOUT_S}
    budget=$((budget + 4 * p95 + 4 * $(upscale_x4_seconds "$p95")))
  done
  # Spec 18 gate (plan 7.2): the cold start, timed first (up to 3 tries of a 5 s hold and a /health wait of at most
  # 2 x UPSCALE_COLD_START_S, then the hold calls finish, one 800x1200 x2 call), and the determinism round: per model
  # up to 3 rounds of UPSCALE_DETERMINISM_CALLS calls of 800x1200 at once, each round a cold start plus one p95 per 4
  # calls (the plan's round assumes at least 4 instances; fewer than that queue as 429s, which are retried).
  local cold=${UPSCALE_COLD_START_S:-120} calls=$UPSCALE_DETERMINISM_CALLS p95_det waves
  p95_det=$(upscale_p95 800x1200); p95_det=${p95_det:-$UPSCALE_TIMEOUT_S}
  waves=$(((calls + 3) / 4))
  budget=$((budget + 3 * (5 + 2 * cold) + p95_det))
  budget=$((budget + 3 * (2 * cold + waves * p95_det + waves * $(upscale_x4_seconds "$p95_det"))))
  SVC_PROBE_TIMEOUT=$((300 + budget))
  # The cap timeout check (2026-10-31, replaces the x4/x2 ratio of two single calls): the gate fails when a model's
  # pixel cap (UPSCALE_MAX_PIXELS for x2, UPSCALE_MAX_PIXELS_X4 for x4) does not fit UPSCALE_TIMEOUT_S twice over at
  # that model's slowest measured p95 per MP, over the rounds and the determinism calls (cloudrun_check.py
  # cap_timeout_check). 0 (no x4 model) checks nothing for x4.
  local x4_cap=0
  [ "${UPSCALE_MODEL_X4:-swinir-x4}" = off ] || x4_cap=$UPSCALE_MAX_PIXELS_X4
  SVC_PROBE=(bash infra/lib/services.sh probe-upscale "$SVC_PROBE_TIMEOUT" "$(probe_upscale_model)" "$UPSCALE_SIZES" "$UPSCALE_CONCURRENCY" 1
    "$UPSCALE_TIMEOUT_S" "$UPSCALE_MAX_PIXELS" "$x4_cap" "$calls" "$cold")
  SVC_DEPLOY=1; SVC_SHIFT=1
  # Like catalog-matting: the preview reuses the live service and never changes it.
  [ "${CATALOG_PREVIEW:-0}" = 1 ] && SVC_DEPLOY=0
  return 0
}

# Spec 18 GPU upscaler: the seconds the GPU determinism round keeps sending (cloudrun_check.py --determinism-seconds)
# until a second instance answers. A round of 12 GPU calls ends in about 10 s; a fresh GPU instance took 42 to 92 s
# to answer on 2026-10-30, so 600 s leaves room for Cloud Run to start one under the load.
UPSCALE_GPU_DETERMINISM_SECONDS=600

service_catalog_upscale_gpu() {
  # Spec 18 GPU upscaler (owner 2026-10-30): the dedicated GPU enlargement service in its own region. The matting-gpu
  # image with only the upscaler loaded (PRELOAD_MATTE=0; the GPU image serves /upscale on CUDA), sized by the
  # UPSCALE_GPU_* rows of infra/lib/shape.sh, which refuse an unmeasured shape. The same pixel caps as catalog-upscale,
  # so a photo's route (whole or tiles) never depends on which upscaler makes it. The worker invokes it through its
  # project-level run.invoker grant (infra/bootstrap.sh), which covers every region.
  SVC_NAME=catalog-upscale-gpu
  SVC_REGION=$(service_region "$SVC_NAME")
  SVC_IMAGE=$AR/matting-gpu:$TAG
  SVC_ARGS=(--service-account="$MATTING_SA" --gpu=1 --gpu-type="$UPSCALE_GPU_TYPE" --no-gpu-zonal-redundancy --no-cpu-throttling
    --cpu="$UPSCALE_GPU_CPU" --memory="$UPSCALE_GPU_MEMORY" --concurrency="$UPSCALE_GPU_CONCURRENCY" --min-instances=0
    --max-instances="$UPSCALE_GPU_MAX_INSTANCES" --timeout="$UPSCALE_GPU_TIMEOUT_S" --labels=app=catalog,component=upscale-gpu)
  SVC_MAX=$UPSCALE_GPU_MAX_INSTANCES
  SVC_ENV="MAX_RESIDENT_SESSIONS=1,PRELOAD_MATTE=0,UPSCALE_MAX_PIXELS=$UPSCALE_MAX_PIXELS,UPSCALE_MAX_PIXELS_X4=$UPSCALE_MAX_PIXELS_X4"
  SVC_SKIP_REASON=""
  # A quota refusal on first creation only warns while the CPU upscaler takes the new batches (the worker then gets no
  # GPU URL); with UPSCALE_TARGET=gpu it stops the deploy.
  SVC_QUOTA_OPTIONAL=1; [ "${UPSCALE_TARGET:-gpu}" = gpu ] && SVC_QUOTA_OPTIONAL=0
  if [ "${UPSCALE_GPU_SERVICE:-0}" != 1 ] || upscale_measure_run; then
    SVC_DEPLOY=skip; SVC_SHIFT=0; SVC_PROBE=(); SVC_PROBE_TIMEOUT=0
    SVC_SKIP_REASON="UPSCALE_GPU_SERVICE=${UPSCALE_GPU_SERVICE:-0}"
    if upscale_measure_run; then SVC_SKIP_REASON="a measure run changes only catalog-upscale"; fi
    return 0
  fi
  # The gate (plan 7.2 as for catalog-upscale): both models, both sizes, a warm call and 3 rounds at the shape's
  # concurrency (each call 2 x p95 at most, x4 at UPSCALE_GPU_X4_TIME_RATIO x it), the x4 timeout check, and the
  # determinism round of UPSCALE_DETERMINISM_CALLS calls of 800x1200 per model across at least 2 instances, kept going
  # for up to UPSCALE_GPU_DETERMINISM_SECONDS. No cold-start limit: the probe's way of timing one (a long call holds
  # the warm instance while /health waits for a new one) cannot work when a call takes a second, so the cold start is
  # measured by hand on a scaled-to-zero service and recorded as UPSCALE_GPU_COLD_START_S (services/matting/README.md).
  local size p95 x4 budget=0 cold=$UPSCALE_GPU_COLD_START_S x4_cap=0
  [ "${UPSCALE_MODEL_X4:-swinir-x4}" = off ] || x4_cap=$UPSCALE_MAX_PIXELS_X4
  for size in ${UPSCALE_SIZES//,/ }; do
    p95=$(upscale_gpu_p95 "$size"); p95=${p95:-$UPSCALE_GPU_TIMEOUT_S}
    x4=$(UPSCALE_X4_TIME_RATIO=$UPSCALE_GPU_X4_TIME_RATIO upscale_x4_seconds "$p95")
    budget=$((budget + 4 * 2 * (p95 + x4)))
  done
  # The first call of each model may meet a cold start and the model's load.
  budget=$((budget + 2 * 2 * cold))
  budget=$((budget + 2 * (UPSCALE_GPU_DETERMINISM_SECONDS + 2 * cold)))
  SVC_PROBE_TIMEOUT=$((300 + budget))
  SVC_PROBE=(env "UPSCALE_DETERMINISM_SECONDS=$UPSCALE_GPU_DETERMINISM_SECONDS" bash infra/lib/services.sh probe-upscale "$SVC_PROBE_TIMEOUT"
    "$(probe_upscale_model)" "$UPSCALE_SIZES" "$UPSCALE_GPU_CONCURRENCY" 3 "$UPSCALE_GPU_TIMEOUT_S" "$UPSCALE_MAX_PIXELS" "$x4_cap" "$UPSCALE_DETERMINISM_CALLS" 0)
  SVC_DEPLOY=1; SVC_SHIFT=1
  # The preview reuses the live service and never changes it, like catalog-upscale.
  [ "${CATALOG_PREVIEW:-0}" = 1 ] && SVC_DEPLOY=0
  return 0
}

service_catalog_matting_gpu() {
  # Spec 16 3.1: resident cut-out models and the CUDA arena cap per model. Spec 17 3.3.2: the cuDNN and lock-scope
  # knobs reach the service only when set, so one knob moves per candidate.
  SVC_NAME=catalog-matting-gpu
  SVC_REGION=$(service_region "$SVC_NAME")
  SVC_IMAGE=$AR/matting-gpu:$TAG
  SVC_ARGS=(--service-account="$MATTING_SA" --gpu=1 --gpu-type=nvidia-l4 --no-gpu-zonal-redundancy --no-cpu-throttling
    --cpu="$GPU_CPU" --memory="$GPU_MEMORY" --concurrency="$GPU_CONCURRENCY" --min-instances=0
    --max-instances="$GPU_MAX_INSTANCES" --timeout="$MATTING_TIMEOUT_S" --labels=app=catalog,component=matte-gpu)
  SVC_MAX=$GPU_MAX_INSTANCES
  SVC_ENV="MAX_RESIDENT_SESSIONS=$MAX_RESIDENT_SESSIONS"
  local knob
  for knob in GPU_MEM_LIMIT_BYTES CUDNN_CONV_ALGO_SEARCH CUDNN_CONV_USE_MAX_WORKSPACE INFERENCE_LOCK_SCOPE; do
    if [ -n "${!knob:-}" ]; then SVC_ENV+=",$knob=${!knob}"; fi
  done
  # The full probe of spec 17 3.3.1 (every served model, 5 rounds at the shape's concurrency, the switching order):
  # this is where the GPU shape is measured. 600 s (3.2.2): a cold L4 start plus loading every model once. Not yet
  # measured on a candidate (the first gated deploy stopped before this service); about 30 calls of 1 to 2 s plus
  # up to 9 loads on one resident session should take 3 to 6 minutes. Set from the first probe's time if it is not.
  SVC_PROBE_TIMEOUT=600
  SVC_PROBE=(bash infra/lib/services.sh probe-matting "$SVC_PROBE_TIMEOUT" "$(probe_models)" "$GPU_CONCURRENCY" 5)
  SVC_DEPLOY=1; if upscale_measure_run; then SVC_DEPLOY=0; fi
  # Spec 17 3.2.5: the preview deploys the GPU service as a no-traffic candidate and never shifts traffic.
  # Its own per-commit tag, so the URL the preview worker calls stays on this revision whatever deploys next.
  SVC_SHIFT=1; [ "${CATALOG_PREVIEW:-0}" = 1 ] && { SVC_SHIFT=0; SVC_TAG=preview-$TAG; }
  SVC_QUOTA_OPTIONAL=1
}

# The worker's Cloud Run request timeout: the longest dispatch deadline of its tasks, the enlarge task's 1800 s
# (ENLARGE_DISPATCH_DEADLINE_SEC in packages/core/src/tasks.ts; every other task has 900 s and its own time budget).
WORKER_TIMEOUT_S=1800

service_catalog_worker() {
  SVC_NAME=$WORKER_SERVICE
  SVC_REGION=$(service_region "$SVC_NAME")
  SVC_IMAGE=$AR/worker:$TAG
  SVC_ARGS=(--service-account="$WORKER_SA" --cpu="$WORKER_CPU" --memory="$WORKER_MEMORY"
    --concurrency="$WORKER_CONCURRENCY" --min-instances=0 --max-instances="$WORKER_MAX_INSTANCES" --timeout="$WORKER_TIMEOUT_S"
    "${NET[@]}" --set-secrets="$WORKER_SECRETS" --labels=app=catalog,component=worker)
  SVC_MAX=$WORKER_MAX_INSTANCES
  SVC_ENV=$WORKER_ENV
  # The smoke runs on the matting candidates of this deploy (their tag URLs) and names the worker candidate.
  SVC_PROBE=(env "SMOKE_MATTING_URL=${MATTING_PROBE_URL:-}" "SMOKE_MATTING_GPU_URL=${MATTING_GPU_PROBE_URL:-}"
    bash infra/lib/services.sh probe-worker)
  # Spec 3.2.2 says 300 s for non-GPU services, but the tier 5 smoke inside this probe takes about 10 minutes
  # (2026-10-21: 10.5 min) and is bounded by its own job timeout of 1500 s (3.2.4). 300 s for /health plus 1500 s.
  SVC_PROBE_TIMEOUT=1800
  SVC_DEPLOY=1; if upscale_measure_run; then SVC_DEPLOY=0; fi
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
  SVC_MAX=$WEB_MAX_INSTANCES
  SVC_ENV=$WEB_ENV
  # Through IAP as the smoke's identity (the worker's service account, which the catalog-test-smoke job runs as).
  SVC_PROBE=(env "WEB_PROBE_SA=$WORKER_SA" bash infra/lib/services.sh probe-web)
  SVC_PROBE_TIMEOUT=300
  SVC_DEPLOY=1; if upscale_measure_run; then SVC_DEPLOY=0; fi
  SVC_SHIFT=1
  SVC_QUOTA_OPTIONAL=0
}

# Spec 18 H1: what a measure run (UPSCALE_MEASURE=1) prints after the catalog-upscale gate, before deploy.sh stops.
# Reads the gate's results (GATE_TAG_URL, GATE_PREVIOUS, GATE_CHANGED) and the UPSCALE_* shape.
upscale_measure_summary() {
  echo "==> measure mode: only catalog-upscale changed. catalog-matting, catalog-matting-gpu, catalog-worker and catalog-web"
  echo "    were not touched and the worker's env was not rebuilt, so a measure rung never needs a new worker image."
  if [ "$GATE_CHANGED" = 1 ] && [ -z "$GATE_PREVIOUS" ]; then
    echo "NOTE: catalog-upscale was created by this rung, so this first revision serves the service URL (Cloud Run cannot"
    echo "      create a service with --no-traffic). Nothing calls it: the worker's UPSCALE_URL is unchanged."
  fi
  echo "UPSCALE_CANDIDATE_URL=$GATE_TAG_URL"
  echo "==> measure it: bash infra/check-matting.sh --probe-upscale $GATE_TAG_URL --model=$(probe_upscale_model) --sizes=$UPSCALE_SIZES --concurrency=$UPSCALE_CONCURRENCY --rounds=3 --timeout=$UPSCALE_TIMEOUT_S"
}

# ---- Probes. Each runs as its own process (bash infra/lib/services.sh probe-<kind> ... <url>), exits non-zero on
# any failure and never prints a token. ----

# GET <url> with a bearer token (default: the operator's identity token, which plain Cloud Run IAM accepts); fails on
# anything but a final 200 on the same host. Redirects are followed (the web home page redirects to /catalog; curl
# keeps the token only on the same host), but a final page on another host fails: an IAP 302 to Google's sign-in page
# would otherwise end in a 200 there. Retries cover a cold start. The header goes to curl on stdin (-K -), so the token
# is never on a command line.
probe_get() {
  local url=$1 token=${2:-} out code final host
  if [ -z "$token" ]; then
    token=$(gcloud auth print-identity-token | tr -d '\r') || { echo "probe: no identity token (gcloud auth login)" >&2; return 1; }
  fi
  # The token is written into a curl config line, so it must be a plain token (no quote, backslash or space).
  [[ "$token" =~ ^[A-Za-z0-9._~+/=-]+$ ]] || { echo "probe: the token is not a plain bearer token" >&2; return 1; }
  out=$(printf 'header = "Authorization: Bearer %s"\n' "$token" \
    | curl -sS -K - -L --max-redirs 5 -o /dev/null -w '%{http_code} %{url_effective}' --max-time 60 --retry 5 --retry-delay 5 --retry-all-errors \
      "$url") || out=000
  code=${out%% *}; final=${out#* }
  host=${url#https://}; host=${host%%/*}
  echo "probe: GET $url -> $code"
  [ "$code" = 200 ] || return 1
  case "$final" in
    "https://$host" | "https://$host/"*) ;;
    *) echo "probe: GET $url ended on another host (${final%%\?*}), not on the service" >&2; return 1 ;;
  esac
}

# A token IAP accepts. catalog-web uses IAP's Google-managed OAuth client, so IAP refuses the operator's own tokens
# (the gcloud identity token is minted for gcloud's OAuth client, which is not on IAP's programmatic allowlist; both it
# and the user access token got 401 on 2026-10-28). It accepts a service account's OAuth access token with the openid
# and email scopes when that account holds roles/iap.httpsResourceAccessor (docs.cloud.google.com/iap/docs/
# authentication-howto, "Authenticate a service account"). An access token has no audience, so the candidate tag URL
# works as well as the service URL. infra/bootstrap.sh grants both sides: the accessor role to the service account and
# Service Account Token Creator on it to the operator who runs the deploy. See docs/solutions/catalog-iap.md.
# The token comes from the IAM Credentials API (generateAccessToken) with exactly those two scopes: the installed
# gcloud (SDK 579) has no --scopes flag on print-access-token, and its impersonated tokens carry its own scope list.
# Both tokens travel on curl's stdin (-K -), never on a command line, and are never printed; on failure only the HTTP
# status of the IAM Credentials call is shown (403: the Token Creator grant is missing; 401: log in again).
iap_token() {
  local sa=$1 caller out token code
  caller=$(gcloud auth print-access-token | tr -d '\r') || caller=
  [ -n "$caller" ] || { echo "probe: no access token (gcloud auth login)" >&2; return 1; }
  out=$(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$caller" \
    | curl -sS -K - -X POST --max-time 30 -w '\n%{http_code}' \
      --data '{"scope":["openid","https://www.googleapis.com/auth/userinfo.email"],"lifetime":"900s"}' \
      "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/$sa:generateAccessToken" 2>/dev/null) || out=$'\n000'
  code=${out##*$'\n'}
  token=$(printf '%s' "${out%$'\n'*}" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).accessToken||"")}catch{}})') || token=
  if [ "$code" != 200 ] || [ -z "$token" ]; then
    echo "probe: cannot mint an IAP token as $sa (IAM Credentials HTTP $code; 403 means the operator lacks roles/iam.serviceAccountTokenCreator on it: run bash infra/bootstrap.sh; 401 means gcloud auth login)" >&2
    return 1
  fi
  printf '%s' "$token"
}

# Spec 17 3.3.1 (G3): the matting probe measures the candidate with the models, concurrency and rounds its registry
# row gives (sized per service). The probe job's task timeout is the gate's timeout, so a probe the gate gave up on
# never keeps running (and billing) on the candidate (2026-10-28: it ran on for 20 minutes).
probe_matting() {
  local timeout=$1 models=$2 concurrency=$3 rounds=$4 url=$5
  PROBE_TASK_TIMEOUT=$timeout bash infra/check-matting.sh --probe "$url" --models="$models" --concurrency="$concurrency" --rounds="$rounds"
}

# Spec 18 H1: the upscale probe (cloudrun_check.py --probe-upscale through infra/check-matting.sh) with the sizes,
# concurrency, rounds and per-call timeout the registry row gives; the job ends with the gate, as for probe_matting.
probe_upscale() {
  local timeout=$1 model=$2 sizes=$3 concurrency=$4 rounds=$5 call_timeout=$6 x2_max_pixels=$7 x4_max_pixels=$8 determinism_calls=$9
  local cold_start_max=${10} url=${11}
  local gate=()
  # Spec 18 gate (plan 7.2): the determinism round and the cold start, only when the registry row asks for them.
  [ "$determinism_calls" = 0 ] || gate+=(--determinism-calls="$determinism_calls")
  # Spec 18 GPU upscaler: the catalog-upscale-gpu row keeps its determinism round going (env, so the CPU rows keep
  # their arguments).
  [ "${UPSCALE_DETERMINISM_SECONDS:-0}" = 0 ] || gate+=(--determinism-seconds="$UPSCALE_DETERMINISM_SECONDS")
  [ "$cold_start_max" = 0 ] || gate+=(--cold-start-max="$cold_start_max")
  PROBE_TASK_TIMEOUT=$timeout bash infra/check-matting.sh --probe-upscale "$url" --model="$model" --sizes="$sizes" \
    --concurrency="$concurrency" --rounds="$rounds" --timeout="$call_timeout" --x2-max-pixels="$x2_max_pixels" --x4-max-pixels="$x4_max_pixels" ${gate[@]+"${gate[@]}"}
}

# /health on the worker candidate, then the tier 5 smoke against the candidates of this deploy.
probe_worker() {
  local url=$1 run
  probe_get "$url/health" || return 1
  if [ "${CATALOG_LOCAL_SMOKE:-0}" = 1 ]; then
    # Against this deploy's matting candidates too, not the URLs in the local environment.
    pnpm --filter @catalog/worker build \
      && MATTING_URL=$SMOKE_MATTING_URL MATTING_GPU_URL=$SMOKE_MATTING_GPU_URL WORKER_URL=$url pnpm catalog:smoke
    return
  fi
  run=$(node -e 'console.log(require("crypto").randomUUID())')
  CATALOG_TEST_RUN=$run CATALOG_TEST_JOBS=smoke MATTING_URL=$SMOKE_MATTING_URL MATTING_GPU_URL=$SMOKE_MATTING_GPU_URL \
    WORKER_URL=$url bash infra/catalog-test-jobs.sh || return 1
  bash infra/catalog-smoke-linux.sh || return 1
  echo "probe: smoke passed (evidence: gs://image-links-agent-assets/catalog-test/smoke/linux-$run/smoke/)"
}

# /health and the home page through IAP as WEB_PROBE_SA (spec 17 3.2.3: the existing smoke identity). The service
# account is outside the opptra.com domain, so the home page renders the app's refusal line with HTTP 200 (app/layout);
# the probe shows IAP lets the gate through and the server renders, not that a person may use the catalog.
probe_web() {
  local url=$1 token
  [ -n "${WEB_PROBE_SA:-}" ] || { echo "probe: WEB_PROBE_SA is not set" >&2; return 1; }
  token=$(iap_token "$WEB_PROBE_SA") || return 1
  probe_get "$url/health" "$token" && probe_get "$url/" "$token"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  export CLOUDSDK_CORE_PROJECT=image-links-agent
  cd "$(dirname "$0")/../.."
  case "${1:-}" in
    probe-matting) shift; probe_matting "$@" ;;
    probe-upscale) shift; probe_upscale "$@" ;;
    probe-worker) probe_worker "$2" ;;
    probe-web) probe_web "$2" ;;
    *) echo "usage: bash infra/lib/services.sh probe-matting <timeout s> <models> <concurrency> <rounds> <url> | probe-upscale <timeout s> <model> <sizes> <concurrency> <rounds> <call timeout s> <x4 time ratio, 0 for none> <determinism calls, 0 for none> <cold start limit s, 0 for none> <url> | probe-worker <url> | probe-web <url>" >&2; exit 2 ;;
  esac
fi
