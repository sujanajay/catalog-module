# Spec 16 3.2: the shape of the catalog services as env, with today's live shape as defaults, and the checks that
# refuse a shape that does not fit before anything is changed. Sourced by infra/deploy.sh (and infra/sql-tier.sh
# for tier_max_connections). Pure bash and arithmetic, no gcloud, so infra/tests/shape.test.mjs runs it offline.

# The defaults: today's live production shape, one row per env name. `bash infra/deploy.sh` with no env re-applies
# exactly this, so it must always equal what runs (2026-10-28: a run with older, smaller defaults cut catalog-bulk
# from 36 slots to 1 before its first gate). A shape change ships by changing its row here in the PR that deploys
# it; env is for trying a shape, and an env name that is set (even to "") wins over its row.
# Spec 17 section 8: spec 16's F2 for the worker and the queues (docs/specs/16-throughput.md section 8) and the
# pre-F2 GPU (4 vCPU, 16Gi, concurrency 1, 1 resident, no cap; F2's GPU values were rolled back on 2026-10-27), as
# read from the live services on 2026-10-28.
# The shape before F2, for a rollback: WORKER_MAX_INSTANCES=4 WORKER_CPU=2 WORKER_MEMORY=2Gi TASKS_MAX_DISPATCHES=6
#   BULK_MAX_DISPATCHES=0 INGEST_MAX_DISPATCHES=2 DB_MAX_CONNECTIONS=25 MATTING_CPU_MAX_INSTANCES=20
#   UPSCALE_SERVICE=gpu CATALOG_PHOTO_CONCURRENCY=1 CATALOG_BULK_WINDOW=8 LLM_INFLIGHT_PER_INSTANCE=
SHAPE_DEFAULTS=(
  # What Postgres allows on ila-pg: the default of its tier db-custom-2-7680 (ila-pg sets no max_connections flag).
  # Lower it, and deploy, before infra/sql-tier.sh moves to a smaller tier (docs/solutions/db-connection-budget.md).
  DB_MAX_CONNECTIONS=400
  WORKER_MAX_INSTANCES=24
  WORKER_CPU=4
  WORKER_MEMORY=4Gi
  WORKER_CONCURRENCY=2
  # Queue slots, main + bulk + ingest = the worker's 24 x 2. The ingest queue (new-batch setup) keeps its slots free
  # of batch processing; the bulk queue (spec 16, big batches) is created only when BULK_MAX_DISPATCHES > 0.
  TASKS_MAX_DISPATCHES=8
  BULK_MAX_DISPATCHES=36
  INGEST_MAX_DISPATCHES=4
  # CPU cut-out service catalog-matting (asia-south1, 4 vCPU each).
  MATTING_CPU_MAX_INSTANCES=16
  # GPU cut-out service catalog-matting-gpu (asia-southeast1, one L4 each; the L4 quota there is 3).
  GPU_MAX_INSTANCES=3
  GPU_CPU=4
  GPU_MEMORY=16Gi
  GPU_CONCURRENCY=1
  MAX_RESIDENT_SESSIONS=1
  GPU_MEM_LIMIT_BYTES=
  # Spec 17 3.3.2 knobs of the GPU service; empty keeps ONNX Runtime's defaults, global keeps one run at a time.
  CUDNN_CONV_ALGO_SEARCH=
  CUDNN_CONV_USE_MAX_WORKSPACE=
  INFERENCE_LOCK_SCOPE=global
  # The cut-out models the GPU service serves (its MATTE_MODELS; unset there means all four).
  GPU_MATTE_MODELS=birefnet-general,birefnet-general-lite,birefnet-hrsod,bria-rmbg
  # Which service upscales: gpu (spec 11), cpu (spec 16: the CPU cut-out service catalog-matting) or dedicated
  # (spec 18: catalog-upscale, sized by the UPSCALE_* rows below). cpu is what runs today; dedicated is refused until
  # the render calls catalog-upscale through the enlarge stage (spec 18 H3 sets ENLARGE_CLIENT_WIRED=1 in
  # shape_defaults; until then the matting client refuses a dedicated UPSCALE_URL and every enlargement would fall back
  # to Lanczos) and until the measured table below has rows for its shape.
  UPSCALE_SERVICE=cpu
  # Spec 18: the dedicated CPU enlargement service catalog-upscale (asia-south1, the catalog-matting image, only the
  # upscaler loaded). Deployed only with UPSCALE_SERVICE=dedicated or UPSCALE_MEASURE=1. UPSCALE_THREADS is its ONNX
  # Runtime intra-op thread count; UPSCALE_TIMEOUT_S its Cloud Run request timeout (the client waits 30 s longer).
  # The asia-south1 CPU quota (190 of 200) holds today's 171 vCPU plus at most 16 more: the ladder runs with
  # UPSCALE_MAX_INSTANCES at most 4 at 4 vCPU or at most 2 at 8 vCPU (16 x 4 = 64 gives 235 and is refused), and the
  # final dedicated shape lowers MATTING_CPU_MAX_INSTANCES from 16 to 4 (123 + 16 x 4 = 187).
  UPSCALE_CPU_VCPU=4
  UPSCALE_MEMORY=16Gi
  UPSCALE_CONCURRENCY=1
  UPSCALE_MAX_INSTANCES=16
  UPSCALE_THREADS=4
  UPSCALE_TIMEOUT_S=840
  # The upscalers stay resident once used, so with UPSCALE_SERVICE=gpu both count on top of the cut-outs.
  GPU_UPSCALE_MODELS=realesrgan-x2plus,swinir-x2
  # CUDA context and library handles outside the model arenas (spec 17 3.3.3).
  GPU_CUDA_OVERHEAD_MIB=2048
  MATTE_INFLIGHT_PER_INSTANCE=4
  # Spec 16 F3, read by the worker (and the bulk values by the web).
  CATALOG_PHOTO_CONCURRENCY=4
  CATALOG_BULK_WINDOW=30
  BULK_BATCH_PRODUCTS=100
  # AI check pacing per worker instance (spec 16 F3); "" means no cap.
  LLM_INFLIGHT_PER_INSTANCE=6
)
# The preview stack (CATALOG_PREVIEW=1, infra/deploy-preview.sh) runs the same per-instance shape on fewer worker
# instances and without a bulk queue, so a branch never takes the production worker's share of the asia-south1 CPU
# quota and never creates catalog-preview-bulk. These rows come first; the rest come from SHAPE_DEFAULTS.
PREVIEW_SHAPE_DEFAULTS=(
  WORKER_MAX_INSTANCES=4
  TASKS_MAX_DISPATCHES=6
  BULK_MAX_DISPATCHES=0
  INGEST_MAX_DISPATCHES=2
)

# shape_fill NAME=value ...: gives each NAME that is unset its value; a NAME that is set (also to "") keeps its own.
shape_fill() {
  local row name
  for row in "$@"; do
    name=${row%%=*}
    [ -n "${!name+x}" ] || printf -v "$name" '%s' "${row#*=}"
  done
}

# The default max_connections of a Cloud SQL for PostgreSQL tier (docs.cloud.google.com/sql/docs/postgres/flags,
# read 2026-10-27): tiny 25, small 50, then by memory: 3.75 to <6 GB 100, 6 to <7.5 GB 200, 7.5 to <15 GB 400,
# 15 to <30 GB 500, 30 to <60 GB 600, 60 to <120 GB 800, 120 GB and more 1,000. Prints nothing for an unknown tier.
tier_max_connections() {
  local tier=$1 mib
  case "$tier" in
    db-f1-micro) echo 25 ;;
    db-g1-small) echo 50 ;;
    db-custom-*-*)
      mib=${tier##*-}
      [[ "$mib" =~ ^[0-9]+$ ]] || return 0
      if [ "$mib" -ge 122880 ]; then echo 1000
      elif [ "$mib" -ge 61440 ]; then echo 800
      elif [ "$mib" -ge 30720 ]; then echo 600
      elif [ "$mib" -ge 15360 ]; then echo 500
      elif [ "$mib" -ge 7680 ]; then echo 400
      elif [ "$mib" -ge 6144 ]; then echo 200
      elif [ "$mib" -ge 3840 ]; then echo 100
      else echo 25
      fi ;;
  esac
}

shape_defaults() {
  if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then shape_fill "${PREVIEW_SHAPE_DEFAULTS[@]}"; fi
  shape_fill "${SHAPE_DEFAULTS[@]}"
  # Database connection budget (docs/solutions/db-connection-budget.md): Postgres keeps 3 for superusers, and the
  # earlier ila apps are assumed to hold 4.
  DB_RESERVED_CONNECTIONS=3
  ILA_DB_SHARE=4
  WEB_MAX_INSTANCES=3
  WEB_CPU=1
  WEB_DB_POOL_MAX=2
  MAX_CONCURRENT_JOBS=2
  JOB_DB_POOL_MAX=1
  # vCPU kept for the Cloud Run jobs (load, recheck, QA check, evals, migrate, smoke) in the CPU quota check.
  JOBS_CPU_BUDGET=8
  MATTING_CPU_VCPU=4
  GPU_QUOTA=3
  # Spec 17 3.3.3: measured GPU memory in MiB, one row per model (GPU_MODEL_PEAK_MIB_ + the id in capitals with "_"
  # for "-"), copied from the one-resident probe table in services/matting/README.md "Measured on L4"
  # (infra/check-matting.sh --probe; card-wide, so each includes the CUDA context once, on top of
  # GPU_CUDA_OVERHEAD_MIB: conservative) together with its date. Empty = not measured yet. A new model is a new row.
  # Like the shape rows, a name that is set (also to "") wins, so "" marks a model as unmeasured.
  # 2026-10-28, L4 1024 px, one resident (the larger of rung 1, default cuDNN, and rung 2, HEURISTIC with no maximum
  # workspace; the knob moved no memory). The upscalers were not measured (UPSCALE_SERVICE=cpu).
  GPU_MEASURED_ON=${GPU_MEASURED_ON-2026-10-28}
  GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL=${GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL-13704}
  GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL_LITE=${GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL_LITE-10842}
  GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD=${GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD-13696}
  GPU_MODEL_PEAK_MIB_BRIA_RMBG=${GPU_MODEL_PEAK_MIB_BRIA_RMBG-12424}
  GPU_MODEL_PEAK_MIB_REALESRGAN_X2PLUS=${GPU_MODEL_PEAK_MIB_REALESRGAN_X2PLUS-}
  GPU_MODEL_PEAK_MIB_SWINIR_X2=${GPU_MODEL_PEAK_MIB_SWINIR_X2-}
  # What one L4 offers (24 GB, about 22.5 GB usable).
  GPU_USABLE_MIB=22528
  # Spec 18 H1: UPSCALE_MEASURE=1 deploys only catalog-upscale, as a candidate of the UPSCALE_* shape (tag
  # measure-<cpu>c-<threads>t-<concurrency>r) for infra/check-matting.sh --probe-upscale, without asking for a measured
  # row. No other service, image, migration or worker env changes, so a measure rung never needs a new worker image.
  # Rung 1 of a brand-new catalog-upscale serves the service URL (Cloud Run cannot create a service with --no-traffic);
  # later rungs are no-traffic candidates. Not a shape row: a mode for one run.
  UPSCALE_MEASURE=${UPSCALE_MEASURE:-0}
  # Spec 18 H3: 1 once the render calls catalog-upscale through the enlarge stage (packages/core/src/catalog/enlarge.ts).
  # A fact of the code, not a shape choice, so env cannot set it; the H3 PR changes this line.
  ENLARGE_CLIENT_WIRED=0
  # The photo sizes the probe measures (width x height); the largest by pixels sets the timeout check.
  UPSCALE_SIZES=${UPSCALE_SIZES-800x1200,1600x1600}
  # Spec 18 H1: measured p95 in whole seconds (rounded up) of one POST /upscale (swinir-x2) per photo size, one row
  # per catalog-upscale shape: UPSCALE_P95_S_<UPSCALE_CPU_VCPU>C_<UPSCALE_THREADS>T_<UPSCALE_CONCURRENCY>CONC_<size>, copied
  # from the probe table in services/matting/README.md "Measured on CPU" with UPSCALE_MEASURED_ON, the probe's date.
  # Empty = not measured yet. Like the GPU peaks, a name that is set (also to "") wins. The ladder (4 vCPU / 4 threads,
  # 8 / 8, concurrency 1 and 2, both sizes) fills these rows in the PR that makes catalog-upscale live.
  UPSCALE_MEASURED_ON=${UPSCALE_MEASURED_ON-}
  UPSCALE_P95_S_4C_4T_1CONC_800x1200=${UPSCALE_P95_S_4C_4T_1CONC_800x1200-}
  UPSCALE_P95_S_4C_4T_1CONC_1600x1600=${UPSCALE_P95_S_4C_4T_1CONC_1600x1600-}
  UPSCALE_P95_S_4C_4T_2CONC_800x1200=${UPSCALE_P95_S_4C_4T_2CONC_800x1200-}
  UPSCALE_P95_S_4C_4T_2CONC_1600x1600=${UPSCALE_P95_S_4C_4T_2CONC_1600x1600-}
  UPSCALE_P95_S_8C_8T_1CONC_800x1200=${UPSCALE_P95_S_8C_8T_1CONC_800x1200-}
  UPSCALE_P95_S_8C_8T_1CONC_1600x1600=${UPSCALE_P95_S_8C_8T_1CONC_1600x1600-}
  UPSCALE_P95_S_8C_8T_2CONC_800x1200=${UPSCALE_P95_S_8C_8T_2CONC_800x1200-}
  UPSCALE_P95_S_8C_8T_2CONC_1600x1600=${UPSCALE_P95_S_8C_8T_2CONC_1600x1600-}
  # The worker's task deadline is 900 s; the upscale call waits UPSCALE_TIMEOUT_S + 30 s, so 840 is the most.
  UPSCALE_TIMEOUT_MAX_S=840
  # Worker pool per instance. One photo at a time: one connection per in-flight task (2). Several photos at once
  # (today): a delivery's writes take turns on one connection, and its reads, lease renewals and AI cost rows
  # need a second, so 2 per in-flight task (4 at concurrency 2). The budget check below still has the last word.
  if [ -z "${WORKER_DB_POOL_MAX:-}" ]; then
    if [[ "$CATALOG_PHOTO_CONCURRENCY$WORKER_CONCURRENCY" =~ ^[0-9]+$ ]] && [ "$CATALOG_PHOTO_CONCURRENCY" -gt 1 ]; then
      WORKER_DB_POOL_MAX=$((WORKER_CONCURRENCY * 2))
    else
      WORKER_DB_POOL_MAX=2
    fi
  fi
  # Cloud Run CPU quota in asia-south1 is 200 vCPU; keep 10 spare.
  CPU_QUOTA_LIMIT=190
}

# shape_check [live_connection_limit]: prints every problem to stderr and returns 1 if there is any. Sets
# CATALOG_DB_LIMIT, CATALOG_DB_TOTAL, SLOTS_TOTAL, SLOTS_CAPACITY and CPU_TOTAL for the caller's summary lines.
# live_connection_limit is the max_connections ila-pg allows now (empty skips that check).
shape_check() {
  local live=${1:-} ok=0 name value gib
  shape_fail() { echo "ERROR: $*" >&2; ok=1; }
  for name in DB_MAX_CONNECTIONS WORKER_MAX_INSTANCES WORKER_CPU WORKER_CONCURRENCY WORKER_DB_POOL_MAX \
      INGEST_MAX_DISPATCHES BULK_MAX_DISPATCHES TASKS_MAX_DISPATCHES MATTING_CPU_MAX_INSTANCES GPU_MAX_INSTANCES \
      GPU_CPU GPU_CONCURRENCY MAX_RESIDENT_SESSIONS MATTE_INFLIGHT_PER_INSTANCE CATALOG_PHOTO_CONCURRENCY \
      CATALOG_BULK_WINDOW BULK_BATCH_PRODUCTS GPU_CUDA_OVERHEAD_MIB UPSCALE_CPU_VCPU UPSCALE_CONCURRENCY UPSCALE_MAX_INSTANCES \
      UPSCALE_THREADS UPSCALE_TIMEOUT_S; do
    value=${!name}
    if ! [[ "$value" =~ ^[0-9]+$ ]]; then shape_fail "$name must be a whole number, got '$value'"; return 1; fi
  done
  for name in WORKER_MAX_INSTANCES WORKER_CONCURRENCY WORKER_DB_POOL_MAX INGEST_MAX_DISPATCHES TASKS_MAX_DISPATCHES \
      MATTING_CPU_MAX_INSTANCES GPU_MAX_INSTANCES GPU_CONCURRENCY MAX_RESIDENT_SESSIONS MATTE_INFLIGHT_PER_INSTANCE \
      CATALOG_PHOTO_CONCURRENCY CATALOG_BULK_WINDOW BULK_BATCH_PRODUCTS UPSCALE_CONCURRENCY UPSCALE_MAX_INSTANCES UPSCALE_THREADS; do
    [ "${!name}" -ge 1 ] || shape_fail "$name must be at least 1"
  done
  case "$WORKER_CPU" in 1|2|4|6|8) ;; *) shape_fail "WORKER_CPU must be 1, 2, 4, 6 or 8 (Cloud Run), got $WORKER_CPU" ;; esac
  [[ "$WORKER_MEMORY" =~ ^[1-9][0-9]*Gi$ ]] || shape_fail "WORKER_MEMORY must look like 4Gi, got '$WORKER_MEMORY'"
  [[ "$GPU_MEMORY" =~ ^[1-9][0-9]*Gi$ ]] || shape_fail "GPU_MEMORY must look like 32Gi, got '$GPU_MEMORY'"
  [[ -z "$GPU_MEM_LIMIT_BYTES" || "$GPU_MEM_LIMIT_BYTES" =~ ^[1-9][0-9]*$ ]] || shape_fail "GPU_MEM_LIMIT_BYTES must be a byte count such as 6442450944"
  [[ -z "$LLM_INFLIGHT_PER_INSTANCE" || "$LLM_INFLIGHT_PER_INSTANCE" =~ ^[1-9][0-9]*$ ]] || shape_fail "LLM_INFLIGHT_PER_INSTANCE must be empty or a whole number such as 6"
  case "$UPSCALE_SERVICE" in gpu|cpu|dedicated) ;; *) shape_fail "UPSCALE_SERVICE must be gpu, cpu or dedicated, got '$UPSCALE_SERVICE'" ;; esac
  case "$UPSCALE_MEASURE" in 0|1) ;; *) shape_fail "UPSCALE_MEASURE must be 0 or 1, got '$UPSCALE_MEASURE'" ;; esac

  # Connections: every service at max instances, every pool full, inside what ila-pg allows.
  CATALOG_DB_LIMIT=$((DB_MAX_CONNECTIONS - DB_RESERVED_CONNECTIONS - ILA_DB_SHARE))
  CATALOG_DB_TOTAL=$((WORKER_MAX_INSTANCES * WORKER_DB_POOL_MAX + WEB_MAX_INSTANCES * WEB_DB_POOL_MAX + MAX_CONCURRENT_JOBS * JOB_DB_POOL_MAX))
  if [ "$CATALOG_DB_TOTAL" -gt "$CATALOG_DB_LIMIT" ]; then
    shape_fail "catalog connections $CATALOG_DB_TOTAL exceed the budget $CATALOG_DB_LIMIT; see docs/solutions/db-connection-budget.md"
  fi
  if [ -n "$live" ] && [ "$DB_MAX_CONNECTIONS" -gt "$live" ]; then
    shape_fail "DB_MAX_CONNECTIONS=$DB_MAX_CONNECTIONS but ila-pg allows $live now; change the tier first (infra/sql-tier.sh)"
  fi
  # Slots: the queues never hand out more tasks at once than the worker can take, so a big batch waits in the
  # queue instead of meeting 429 "no available instance" and burning retry attempts.
  SLOTS_TOTAL=$((TASKS_MAX_DISPATCHES + BULK_MAX_DISPATCHES + INGEST_MAX_DISPATCHES))
  SLOTS_CAPACITY=$((WORKER_MAX_INSTANCES * WORKER_CONCURRENCY))
  if [ "$SLOTS_TOTAL" -gt "$SLOTS_CAPACITY" ]; then
    shape_fail "queue slots $TASKS_MAX_DISPATCHES + $BULK_MAX_DISPATCHES + $INGEST_MAX_DISPATCHES = $SLOTS_TOTAL exceed the worker's $WORKER_MAX_INSTANCES x $WORKER_CONCURRENCY = $SLOTS_CAPACITY"
  fi
  # CPU quota in asia-south1 (the GPU service counts in asia-southeast1), with catalog-upscale when it is deployed.
  UPSCALE_VCPU_TOTAL=0
  if upscale_deployed; then UPSCALE_VCPU_TOTAL=$((UPSCALE_MAX_INSTANCES * UPSCALE_CPU_VCPU)); fi
  CPU_TOTAL=$((WORKER_MAX_INSTANCES * WORKER_CPU + MATTING_CPU_MAX_INSTANCES * MATTING_CPU_VCPU + UPSCALE_VCPU_TOTAL + WEB_MAX_INSTANCES * WEB_CPU + JOBS_CPU_BUDGET))
  if [ "$CPU_TOTAL" -gt "$CPU_QUOTA_LIMIT" ]; then
    shape_fail "asia-south1 vCPU at max instances $CPU_TOTAL exceeds $CPU_QUOTA_LIMIT of the 200 vCPU quota (worker $((WORKER_MAX_INSTANCES * WORKER_CPU)) + catalog-matting $((MATTING_CPU_MAX_INSTANCES * MATTING_CPU_VCPU)) + catalog-upscale $UPSCALE_VCPU_TOTAL + web and jobs $((WEB_MAX_INSTANCES * WEB_CPU + JOBS_CPU_BUDGET))); lower WORKER_MAX_INSTANCES, MATTING_CPU_MAX_INSTANCES or UPSCALE_MAX_INSTANCES"
  fi
  # GPU: today's L4 quota, and Cloud Run's L4 shape (at least 4 CPU and 16 GiB; 8 CPU and 32 GiB recommended).
  [ "$GPU_MAX_INSTANCES" -le "$GPU_QUOTA" ] || shape_fail "GPU_MAX_INSTANCES=$GPU_MAX_INSTANCES exceeds the L4 quota of $GPU_QUOTA (no quota requests: owner decision 2026-10-27)"
  [ "$GPU_CPU" -ge 4 ] && [ "$GPU_CPU" -le 8 ] || shape_fail "GPU_CPU must be 4 to 8 for one L4, got $GPU_CPU"
  gib=${GPU_MEMORY%Gi}
  if [[ "$gib" =~ ^[0-9]+$ ]]; then
    [ "$gib" -ge 16 ] && [ "$gib" -le 32 ] || shape_fail "GPU_MEMORY must be 16Gi to 32Gi for one L4, got $GPU_MEMORY"
  fi
  [ "$GPU_CONCURRENCY" -le 4 ] || shape_fail "GPU_CONCURRENCY must be at most 4 (one inference runs at a time), got $GPU_CONCURRENCY"
  [ "$MAX_RESIDENT_SESSIONS" -le 4 ] || shape_fail "MAX_RESIDENT_SESSIONS must be at most 4 (the baked models), got $MAX_RESIDENT_SESSIONS"
  case "$INFERENCE_LOCK_SCOPE" in global|session) ;; *) shape_fail "INFERENCE_LOCK_SCOPE must be global or session, got '$INFERENCE_LOCK_SCOPE'" ;; esac
  case "$CUDNN_CONV_ALGO_SEARCH" in ''|DEFAULT|HEURISTIC|EXHAUSTIVE) ;; *) shape_fail "CUDNN_CONV_ALGO_SEARCH must be empty, DEFAULT, HEURISTIC or EXHAUSTIVE, got '$CUDNN_CONV_ALGO_SEARCH'" ;; esac
  case "$CUDNN_CONV_USE_MAX_WORKSPACE" in ''|0|1) ;; *) shape_fail "CUDNN_CONV_USE_MAX_WORKSPACE must be empty, 0 or 1, got '$CUDNN_CONV_USE_MAX_WORKSPACE'" ;; esac
  if [ "$INFERENCE_LOCK_SCOPE" = session ] && [ "$GPU_CONCURRENCY" -gt "$MAX_RESIDENT_SESSIONS" ]; then
    shape_fail "GPU_CONCURRENCY=$GPU_CONCURRENCY exceeds MAX_RESIDENT_SESSIONS=$MAX_RESIDENT_SESSIONS with INFERENCE_LOCK_SCOPE=session"
  fi
  gpu_memory_check
  upscale_check
  return $ok
}

# 0 when this deploy runs catalog-upscale: as the worker's upscaler (dedicated) or as a candidate being measured.
upscale_deployed() { [ "$UPSCALE_SERVICE" = dedicated ] || [ "$UPSCALE_MEASURE" = 1 ]; }

# upscale_p95 <size>: the measured p95 in seconds of the current UPSCALE_CPU_VCPU/THREADS/CONCURRENCY shape, or nothing.
upscale_p95() {
  local name="UPSCALE_P95_S_${UPSCALE_CPU_VCPU}C_${UPSCALE_THREADS}T_${UPSCALE_CONCURRENCY}CONC_$1"
  printf '%s' "${!name:-}"
}

# The size in UPSCALE_SIZES with the most pixels.
upscale_largest_size() {
  local size largest="" most=0 w h
  for size in ${UPSCALE_SIZES//,/ }; do
    w=${size%x*}; h=${size#*x}
    if [ $((w * h)) -gt "$most" ]; then most=$((w * h)); largest=$size; fi
  done
  printf '%s' "$largest"
}

# Spec 18 H1, called by shape_check (its shape_fail and ok): the catalog-upscale shape. Cloud Run's CPU and memory
# pairs always; when it upscales for the worker (dedicated), a measured p95 for every probe size at exactly this
# (vCPU, threads, concurrency) and a request timeout of at least twice the largest size's p95.
upscale_check() {
  local gib size p95 missing="" invalid=0 largest worst
  case "$UPSCALE_CPU_VCPU" in 1|2|4|6|8) ;; *) shape_fail "UPSCALE_CPU_VCPU must be 1, 2, 4, 6 or 8 (Cloud Run), got $UPSCALE_CPU_VCPU"; return 0 ;; esac
  if [[ "$UPSCALE_MEMORY" =~ ^([1-9][0-9]*)Gi$ ]]; then
    gib=${BASH_REMATCH[1]}
    # Cloud Run's memory per CPU (docs.cloud.google.com/run/docs/configuring/services/memory-limits, read 2026-10-29).
    case "$UPSCALE_CPU_VCPU" in
      1) [ "$gib" -le 4 ] || shape_fail "UPSCALE_MEMORY=$UPSCALE_MEMORY is more than Cloud Run allows for 1 vCPU (4Gi)" ;;
      2) [ "$gib" -le 8 ] || shape_fail "UPSCALE_MEMORY=$UPSCALE_MEMORY is more than Cloud Run allows for 2 vCPU (8Gi)" ;;
      4) [ "$gib" -ge 2 ] && [ "$gib" -le 16 ] || shape_fail "UPSCALE_MEMORY must be 2Gi to 16Gi with 4 vCPU (Cloud Run), got $UPSCALE_MEMORY" ;;
      6) [ "$gib" -ge 4 ] && [ "$gib" -le 24 ] || shape_fail "UPSCALE_MEMORY must be 4Gi to 24Gi with 6 vCPU (Cloud Run), got $UPSCALE_MEMORY" ;;
      8) [ "$gib" -ge 4 ] && [ "$gib" -le 32 ] || shape_fail "UPSCALE_MEMORY must be 4Gi to 32Gi with 8 vCPU (Cloud Run), got $UPSCALE_MEMORY" ;;
    esac
  else
    shape_fail "UPSCALE_MEMORY must look like 16Gi, got '$UPSCALE_MEMORY'"
  fi
  [ "$UPSCALE_THREADS" -le "$UPSCALE_CPU_VCPU" ] || shape_fail "UPSCALE_THREADS=$UPSCALE_THREADS exceeds UPSCALE_CPU_VCPU=$UPSCALE_CPU_VCPU (more ONNX threads than vCPU only contend); use at most $UPSCALE_CPU_VCPU"
  [ "$UPSCALE_CONCURRENCY" -le 4 ] || shape_fail "UPSCALE_CONCURRENCY must be at most 4 (tiles run one at a time per instance), got $UPSCALE_CONCURRENCY"
  [ "$UPSCALE_TIMEOUT_S" -ge 60 ] && [ "$UPSCALE_TIMEOUT_S" -le "$UPSCALE_TIMEOUT_MAX_S" ] \
    || shape_fail "UPSCALE_TIMEOUT_S must be 60 to $UPSCALE_TIMEOUT_MAX_S s (the worker's task deadline is 900 s and the client waits 30 s longer), got $UPSCALE_TIMEOUT_S"
  [ -n "${UPSCALE_SIZES//[, ]/}" ] || { shape_fail "UPSCALE_SIZES must list the probe sizes, such as 800x1200,1600x1600"; return 0; }
  for size in ${UPSCALE_SIZES//,/ }; do
    [[ "$size" =~ ^[1-9][0-9]*x[1-9][0-9]*$ ]] || { shape_fail "UPSCALE_SIZES must list sizes such as 800x1200,1600x1600, got '$UPSCALE_SIZES'"; return 0; }
  done
  if [ "$UPSCALE_MEASURE" = 1 ] && [ "$UPSCALE_SERVICE" = dedicated ]; then
    shape_fail "UPSCALE_MEASURE=1 deploys catalog-upscale as a no-traffic candidate; keep the worker on UPSCALE_SERVICE=cpu (or gpu) while measuring"
    return 0
  fi
  [ "$UPSCALE_SERVICE" = dedicated ] || return 0
  if [ "$ENLARGE_CLIENT_WIRED" != 1 ]; then
    shape_fail "UPSCALE_SERVICE=dedicated waits for spec 18 H3: the render does not call catalog-upscale through the enlarge stage yet (ENLARGE_CLIENT_WIRED=0 in infra/lib/shape.sh), and the matting client refuses a dedicated UPSCALE_URL, so every enlargement would fall back to Lanczos; keep UPSCALE_SERVICE=cpu"
    return 0
  fi
  for size in ${UPSCALE_SIZES//,/ }; do
    p95=$(upscale_p95 "$size")
    if [ -z "$p95" ]; then
      missing+=" $size"
    elif ! [[ "$p95" =~ ^[1-9][0-9]*$ ]]; then
      shape_fail "UPSCALE_P95_S_${UPSCALE_CPU_VCPU}C_${UPSCALE_THREADS}T_${UPSCALE_CONCURRENCY}CONC_$size=$p95 must be a whole number of seconds (rounded up), such as 331"
      invalid=1
    fi
  done
  [ "$invalid" = 0 ] || return 0
  if [ -n "$missing" ]; then
    shape_fail "measure first: run infra/check-matting.sh --probe-upscale (no measured p95 for UPSCALE_CPU_VCPU=$UPSCALE_CPU_VCPU UPSCALE_THREADS=$UPSCALE_THREADS UPSCALE_CONCURRENCY=$UPSCALE_CONCURRENCY at$missing; UPSCALE_P95_S_* in infra/lib/shape.sh)"
    return 0
  fi
  [[ "$UPSCALE_MEASURED_ON" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || shape_fail "UPSCALE_MEASURED_ON must be the date of the probe the p95 rows come from, such as 2026-10-30"
  largest=$(upscale_largest_size)
  worst=$(( 2 * $(upscale_p95 "$largest") ))
  if [ "$worst" -gt "$UPSCALE_TIMEOUT_MAX_S" ]; then
    shape_fail "catalog-upscale at $UPSCALE_CPU_VCPU vCPU, $UPSCALE_THREADS threads, concurrency $UPSCALE_CONCURRENCY needs a timeout of 2 x p95 $(upscale_p95 "$largest") s = $worst s for $largest, over the $UPSCALE_TIMEOUT_MAX_S s the worker's task allows; measure a faster shape or lower UPSCALE_MAX_PIXELS"
  elif [ "$UPSCALE_TIMEOUT_S" -lt "$worst" ]; then
    shape_fail "UPSCALE_TIMEOUT_S=$UPSCALE_TIMEOUT_S is below 2 x the measured p95 of $largest ($(upscale_p95 "$largest") s, measured $UPSCALE_MEASURED_ON); set it to at least $worst"
  fi
}

# gpu_model_peak <model id>: the measured peak in MiB from the GPU_MODEL_PEAK_MIB_* table, or nothing.
gpu_model_peak() {
  local name=${1^^}
  name=GPU_MODEL_PEAK_MIB_${name//-/_}
  printf '%s' "${!name:-}"
}

# Spec 17 3.3.3, called by shape_check (its shape_fail and ok). The memory arithmetic of the GPU service from the
# measured peaks. Today's live GPU shape (one resident model, no cap, the global lock) ran before any measurement
# and is not asked for one, so a deploy that keeps it never stops here; a shape that keeps more models in memory,
# caps the arenas or runs two models at once is refused until every model it serves has a measured peak.
gpu_memory_check() {
  if [ -z "$GPU_MEM_LIMIT_BYTES" ] && [ "$MAX_RESIDENT_SESSIONS" -le 1 ] && [ "$INFERENCE_LOCK_SCOPE" = global ]; then
    return 0
  fi
  local model peak largest=0 upscale=0 unmeasured="" cap_mib=0 per need upscalers="" live
  local -a served=(${GPU_MATTE_MODELS//,/ })
  [ "$UPSCALE_SERVICE" = gpu ] && upscalers=${GPU_UPSCALE_MODELS//,/ }
  for model in "${served[@]}" $upscalers; do
    peak=$(gpu_model_peak "$model")
    if ! [[ "$peak" =~ ^[1-9][0-9]*$ ]]; then unmeasured+=" $model"; continue; fi
    if [[ " $upscalers " == *" $model "* ]]; then upscale=$((upscale + peak))
    elif [ "$peak" -gt "$largest" ]; then largest=$peak
    fi
  done
  if [ -n "$unmeasured" ]; then
    shape_fail "measure first: run infra/check-matting.sh --probe (no measured GPU peak for$unmeasured; GPU_MODEL_PEAK_MIB_* in infra/lib/shape.sh)"
    return 0
  fi
  [[ "$GPU_MEASURED_ON" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || shape_fail "GPU_MEASURED_ON must be the date of the probe the peaks come from, such as 2026-10-29"
  if [ -n "$GPU_MEM_LIMIT_BYTES" ]; then
    cap_mib=$((GPU_MEM_LIMIT_BYTES / 1048576))
    for model in "${served[@]}"; do
      peak=$(gpu_model_peak "$model")
      if [ $((peak + 512)) -gt "$cap_mib" ]; then
        shape_fail "GPU_MEM_LIMIT_BYTES=$GPU_MEM_LIMIT_BYTES ($cap_mib MiB) is below $model's measured peak $peak MiB + 512 MiB (measured $GPU_MEASURED_ON)"
      fi
    done
  fi
  per=$(( cap_mib > largest ? cap_mib : largest ))
  # A request still running on a session another request just evicted keeps it alive (services/matting/README.md),
  # so with more than one request at a time and fewer slots than models, one more session can be in memory.
  live=$MAX_RESIDENT_SESSIONS
  if [ "$GPU_CONCURRENCY" -gt 1 ] && [ "$MAX_RESIDENT_SESSIONS" -lt "${#served[@]}" ]; then live=$((MAX_RESIDENT_SESSIONS + 1)); fi
  need=$((live * per + GPU_CUDA_OVERHEAD_MIB + upscale))
  if [ "$need" -gt "$GPU_USABLE_MIB" ]; then
    shape_fail "GPU memory $live sessions x $per MiB + $GPU_CUDA_OVERHEAD_MIB MiB CUDA + $upscale MiB upscalers = $need MiB exceeds the L4's $GPU_USABLE_MIB MiB"
  fi
}
