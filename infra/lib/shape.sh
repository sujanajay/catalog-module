# Spec 16 3.2: the shape of the catalog services as env, with today's values as defaults, and the checks that
# refuse a shape that does not fit before anything is changed. Sourced by infra/deploy.sh (and infra/sql-tier.sh
# for tier_max_connections). Pure bash and arithmetic, no gcloud, so infra/tests/shape.test.mjs runs it offline.
#
# F2 run values (docs/specs/16-throughput.md section 8):
#   WORKER_MAX_INSTANCES=24 WORKER_CPU=4 WORKER_MEMORY=4Gi TASKS_MAX_DISPATCHES=8 BULK_MAX_DISPATCHES=36
#   INGEST_MAX_DISPATCHES=4 DB_MAX_CONNECTIONS=400 MATTING_CPU_MAX_INSTANCES=16 GPU_CPU=8 GPU_MEMORY=32Gi
#   GPU_CONCURRENCY=2 MAX_RESIDENT_SESSIONS=3 GPU_MEM_LIMIT_BYTES=6442450944 UPSCALE_SERVICE=cpu
#   CATALOG_PHOTO_CONCURRENCY=4 CATALOG_BULK_WINDOW=30 LLM_INFLIGHT_PER_INSTANCE=6 (the worker pool then becomes 4)

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
  # Database connection budget (docs/solutions/db-connection-budget.md). DB_MAX_CONNECTIONS is what Postgres allows
  # on ila-pg (the tier's default; ila-pg sets no max_connections flag); raise it only after infra/sql-tier.sh.
  DB_MAX_CONNECTIONS=${DB_MAX_CONNECTIONS:-25}
  DB_RESERVED_CONNECTIONS=3
  ILA_DB_SHARE=4
  WORKER_MAX_INSTANCES=${WORKER_MAX_INSTANCES:-4}
  WORKER_CPU=${WORKER_CPU:-2}
  WORKER_MEMORY=${WORKER_MEMORY:-2Gi}
  WORKER_CONCURRENCY=${WORKER_CONCURRENCY:-2}
  WEB_MAX_INSTANCES=3
  WEB_CPU=1
  WEB_DB_POOL_MAX=2
  MAX_CONCURRENT_JOBS=2
  JOB_DB_POOL_MAX=1
  # vCPU kept for the Cloud Run jobs (load, recheck, QA check, evals, migrate, smoke) in the CPU quota check.
  JOBS_CPU_BUDGET=8
  # Queue slots. The ingest queue (new-batch setup) keeps its slots free of batch processing; the bulk queue
  # (spec 16, big batches) is created only when BULK_MAX_DISPATCHES > 0. Unset TASKS_MAX_DISPATCHES takes what is
  # left of the worker's capacity, as before (4 x 2 - 2 = 6).
  INGEST_MAX_DISPATCHES=${INGEST_MAX_DISPATCHES:-2}
  BULK_MAX_DISPATCHES=${BULK_MAX_DISPATCHES:-0}
  if [ -z "${TASKS_MAX_DISPATCHES:-}" ]; then
    # Only from whole numbers; anything else is reported by shape_check instead of failing in the arithmetic.
    if [[ "$WORKER_MAX_INSTANCES$WORKER_CONCURRENCY$INGEST_MAX_DISPATCHES$BULK_MAX_DISPATCHES" =~ ^[0-9]+$ ]]; then
      TASKS_MAX_DISPATCHES=$((WORKER_MAX_INSTANCES * WORKER_CONCURRENCY - INGEST_MAX_DISPATCHES - BULK_MAX_DISPATCHES))
    else
      TASKS_MAX_DISPATCHES=unset
    fi
  fi
  # CPU cut-out service catalog-matting (asia-south1, 4 vCPU each).
  MATTING_CPU_MAX_INSTANCES=${MATTING_CPU_MAX_INSTANCES:-20}
  MATTING_CPU_VCPU=4
  # GPU cut-out service catalog-matting-gpu (asia-southeast1, one L4 each; the L4 quota there is 3).
  GPU_QUOTA=3
  GPU_MAX_INSTANCES=${GPU_MAX_INSTANCES:-3}
  GPU_CPU=${GPU_CPU:-4}
  GPU_MEMORY=${GPU_MEMORY:-16Gi}
  GPU_CONCURRENCY=${GPU_CONCURRENCY:-1}
  MAX_RESIDENT_SESSIONS=${MAX_RESIDENT_SESSIONS:-1}
  GPU_MEM_LIMIT_BYTES=${GPU_MEM_LIMIT_BYTES:-}
  # Spec 17 3.3.2 knobs of the GPU service; empty keeps ONNX Runtime's defaults, global keeps one run at a time.
  CUDNN_CONV_ALGO_SEARCH=${CUDNN_CONV_ALGO_SEARCH:-}
  CUDNN_CONV_USE_MAX_WORKSPACE=${CUDNN_CONV_USE_MAX_WORKSPACE:-}
  INFERENCE_LOCK_SCOPE=${INFERENCE_LOCK_SCOPE:-global}
  # The cut-out models the GPU service serves (its MATTE_MODELS; unset there means all four).
  GPU_MATTE_MODELS=${GPU_MATTE_MODELS:-birefnet-general,birefnet-general-lite,birefnet-hrsod,bria-rmbg}
  # Which matting service upscales: gpu (spec 11) or cpu (spec 16, the GPUs then do only cut-outs).
  UPSCALE_SERVICE=${UPSCALE_SERVICE:-gpu}
  # The upscalers stay resident once used, so with UPSCALE_SERVICE=gpu both count on top of the cut-outs.
  GPU_UPSCALE_MODELS=${GPU_UPSCALE_MODELS:-realesrgan-x2plus,swinir-x2}
  # Spec 17 3.3.3: measured GPU memory in MiB, one row per model (GPU_MODEL_PEAK_MIB_ + the id in capitals with "_"
  # for "-"), copied from the one-resident probe table in services/matting/README.md "Measured on L4"
  # (infra/check-matting.sh --probe; card-wide, so each includes the CUDA context once, on top of
  # GPU_CUDA_OVERHEAD_MIB: conservative) together with its date. Empty = not measured yet. A new model is a new row.
  GPU_MEASURED_ON=${GPU_MEASURED_ON:-}
  GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL=${GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL:-}
  GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL_LITE=${GPU_MODEL_PEAK_MIB_BIREFNET_GENERAL_LITE:-}
  GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD=${GPU_MODEL_PEAK_MIB_BIREFNET_HRSOD:-}
  GPU_MODEL_PEAK_MIB_BRIA_RMBG=${GPU_MODEL_PEAK_MIB_BRIA_RMBG:-}
  GPU_MODEL_PEAK_MIB_REALESRGAN_X2PLUS=${GPU_MODEL_PEAK_MIB_REALESRGAN_X2PLUS:-}
  GPU_MODEL_PEAK_MIB_SWINIR_X2=${GPU_MODEL_PEAK_MIB_SWINIR_X2:-}
  # CUDA context and library handles outside the model arenas, and what one L4 offers (24 GB, about 22.5 GB usable).
  GPU_CUDA_OVERHEAD_MIB=${GPU_CUDA_OVERHEAD_MIB:-2048}
  GPU_USABLE_MIB=22528
  MATTE_INFLIGHT_PER_INSTANCE=${MATTE_INFLIGHT_PER_INSTANCE:-4}
  # Spec 16 F3, read by the worker (and the bulk values by the web).
  CATALOG_PHOTO_CONCURRENCY=${CATALOG_PHOTO_CONCURRENCY:-1}
  CATALOG_BULK_WINDOW=${CATALOG_BULK_WINDOW:-8}
  BULK_BATCH_PRODUCTS=${BULK_BATCH_PRODUCTS:-100}
  # AI check pacing per worker instance (spec 16 F3); empty means no cap (today).
  LLM_INFLIGHT_PER_INSTANCE=${LLM_INFLIGHT_PER_INSTANCE:-}
  # Worker pool per instance. One photo at a time: one connection per in-flight task (2, today). Several photos
  # at once: a delivery's writes take turns on one connection, and its reads, lease renewals and AI cost rows
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
      CATALOG_BULK_WINDOW BULK_BATCH_PRODUCTS GPU_CUDA_OVERHEAD_MIB; do
    value=${!name}
    if ! [[ "$value" =~ ^[0-9]+$ ]]; then shape_fail "$name must be a whole number, got '$value'"; return 1; fi
  done
  for name in WORKER_MAX_INSTANCES WORKER_CONCURRENCY WORKER_DB_POOL_MAX INGEST_MAX_DISPATCHES TASKS_MAX_DISPATCHES \
      MATTING_CPU_MAX_INSTANCES GPU_MAX_INSTANCES GPU_CONCURRENCY MAX_RESIDENT_SESSIONS MATTE_INFLIGHT_PER_INSTANCE \
      CATALOG_PHOTO_CONCURRENCY CATALOG_BULK_WINDOW BULK_BATCH_PRODUCTS; do
    [ "${!name}" -ge 1 ] || shape_fail "$name must be at least 1"
  done
  case "$WORKER_CPU" in 1|2|4|6|8) ;; *) shape_fail "WORKER_CPU must be 1, 2, 4, 6 or 8 (Cloud Run), got $WORKER_CPU" ;; esac
  [[ "$WORKER_MEMORY" =~ ^[1-9][0-9]*Gi$ ]] || shape_fail "WORKER_MEMORY must look like 4Gi, got '$WORKER_MEMORY'"
  [[ "$GPU_MEMORY" =~ ^[1-9][0-9]*Gi$ ]] || shape_fail "GPU_MEMORY must look like 32Gi, got '$GPU_MEMORY'"
  [[ -z "$GPU_MEM_LIMIT_BYTES" || "$GPU_MEM_LIMIT_BYTES" =~ ^[1-9][0-9]*$ ]] || shape_fail "GPU_MEM_LIMIT_BYTES must be a byte count such as 6442450944"
  [[ -z "$LLM_INFLIGHT_PER_INSTANCE" || "$LLM_INFLIGHT_PER_INSTANCE" =~ ^[1-9][0-9]*$ ]] || shape_fail "LLM_INFLIGHT_PER_INSTANCE must be empty or a whole number such as 6"
  case "$UPSCALE_SERVICE" in gpu|cpu) ;; *) shape_fail "UPSCALE_SERVICE must be gpu or cpu, got '$UPSCALE_SERVICE'" ;; esac

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
  # CPU quota in asia-south1 (the GPU service counts in asia-southeast1).
  CPU_TOTAL=$((WORKER_MAX_INSTANCES * WORKER_CPU + MATTING_CPU_MAX_INSTANCES * MATTING_CPU_VCPU + WEB_MAX_INSTANCES * WEB_CPU + JOBS_CPU_BUDGET))
  if [ "$CPU_TOTAL" -gt "$CPU_QUOTA_LIMIT" ]; then
    shape_fail "asia-south1 vCPU at max instances $CPU_TOTAL exceeds $CPU_QUOTA_LIMIT of the 200 vCPU quota"
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
  return $ok
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
