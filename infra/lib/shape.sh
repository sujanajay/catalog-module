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
#   WORKER_CONCURRENCY=2 ENLARGE_MAX_DISPATCHES=0 ENLARGE_BULK_MAX_DISPATCHES=0 (spec 18: no enlarge queue)
#   UPSCALE_GPU_SERVICE=0 UPSCALE_TARGET=cpu (spec 18 GPU upscaler: spec 11's GPU path and catalog-upscale-gpu both use
#   the plain ids)
# The shape before the spec 18 measured table (enlargement back on catalog-matting), for a rollback:
#   UPSCALE_SERVICE=cpu MATTING_CPU_MAX_INSTANCES=16 UPSCALE_TIMEOUT_S=840 ENLARGE_DISPATCHES_PER_SECOND=0.1
#   ENLARGE_BULK_MAX_DISPATCHES=12 UPSCALE_MAX_PIXELS=24000000
# The shape before the 2026-10-30 scale-out (asia-south1 quota 200 vCPU / 400 GiB), for a rollback:
#   WORKER_MAX_INSTANCES=24 ENLARGE_BULK_MAX_DISPATCHES=10 ENLARGE_DISPATCHES_PER_SECOND=0.075
#   ENLARGE_BULK_DISPATCHES_PER_SECOND=0.075 UPSCALE_MEMORY=16Gi UPSCALE_MAX_INSTANCES=16
# The shape before the GPU upscaler became the default (2026-10-31), for a rollback: UPSCALE_TARGET=cpu (the enlarge
#   lanes then come from ENLARGE_CPU_LANES: 4 + 44 slots at 0.04/s and 0.42/s).
# The shape before the fourth GPU upscaler instance (2026-10-31), for a rollback: UPSCALE_GPU_MAX_INSTANCES=3
#   ENLARGE_BULK_MAX_DISPATCHES=8 ENLARGE_BULK_DISPATCHES_PER_SECOND=2
SHAPE_DEFAULTS=(
  # What Postgres allows on ila-pg: the default of its tier db-custom-2-7680 (ila-pg sets no max_connections flag).
  # Lower it, and deploy, before infra/sql-tier.sh moves to a smaller tier (docs/solutions/db-connection-budget.md).
  DB_MAX_CONNECTIONS=400
  # Spec 18 scale-out (2026-10-30): 24 -> 32 so the worker's slots cover the wider enlarge bulk lane (below).
  WORKER_MAX_INSTANCES=32
  WORKER_CPU=4
  WORKER_MEMORY=4Gi
  # Spec 18 3.3.1: 2 -> 3 so the enlarge lanes get their own slots without taking any from the chunk queues (the
  # DB budget below allows it: 32 x 6 + 6 + 2 = 200 of 393). An enlarge task mostly waits on catalog-upscale.
  WORKER_CONCURRENCY=3
  # Queue slots, main + bulk + ingest + enlarge + enlarge bulk = 62 of the worker's 32 x 3 (96 with the CPU lanes of
  # ENLARGE_CPU_LANES). The ingest queue
  # (new-batch setup) keeps its slots free of batch processing; the bulk queue (spec 16, big batches) is created only
  # when BULK_MAX_DISPATCHES > 0.
  TASKS_MAX_DISPATCHES=8
  BULK_MAX_DISPATCHES=36
  INGEST_MAX_DISPATCHES=4
  # Spec 18 3.3.1: the enlarge lanes (operator <queue>-enlarge, bulk <queue>-enlarge-bulk, created only when
  # ENLARGE_BULK_MAX_DISPATCHES > 0). One slot is one enlargement waiting on the upscaler, so together they never
  # exceed what the upscaler of new batches (UPSCALE_TARGET below) serves at once, together with the preview stack's
  # enlarge lane, which calls the same live upscaler. ENLARGE_DISPATCHES_PER_SECOND paces new enlargements on each
  # operator lane (this stack's and the preview's) and ENLARGE_BULK_DISPATCHES_PER_SECOND on the bulk lane; Cloud Tasks
  # applies a rate per queue, so the SUM over every lane with slots, both stacks, must stay within what that upscaler
  # finishes (spec 18 3.1.5). Each lane's rate is about its slots / p50, so no lane is held back by another's share.
  # These rows are for UPSCALE_TARGET=gpu (the default since 2026-10-31): catalog-upscale-gpu serves
  # UPSCALE_GPU_MAX_INSTANCES x UPSCALE_GPU_CONCURRENCY = 4 x 4 = 16 at once, so 2 + 12 + the preview's 2 = 16, and it
  # finishes 16 / p50(800x1200) 4 s = 4/s, so 2 x 0.5 + 3 = 4/s (upscale_gpu_check). With UPSCALE_TARGET=cpu the lanes
  # come from ENLARGE_CPU_LANES below (the CPU shape, exactly as it ran before the switch).
  # ENLARGE_MAX_DISPATCHES=0 means no enlarge lanes: the worker gets no TASKS_ENLARGE_QUEUE and enlarge tasks share the
  # chunk queues (the rollback line above).
  ENLARGE_MAX_DISPATCHES=2
  ENLARGE_BULK_MAX_DISPATCHES=12
  ENLARGE_DISPATCHES_PER_SECOND=0.5
  ENLARGE_BULK_DISPATCHES_PER_SECOND=3
  # CPU cut-out service catalog-matting (asia-south1, 4 vCPU each). Spec 18: 16 -> 4 to give catalog-upscale its
  # vCPU; the GPU does the cut-outs, the CPU cut-out is a fallback.
  MATTING_CPU_MAX_INSTANCES=4
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
  # (spec 18: catalog-upscale, sized by the UPSCALE_* rows below). The enlarge stage calls either through its own
  # task (spec 18 H3; ENLARGE_CLIENT_WIRED, default 1), and dedicated is refused for a shape without measured rows.
  # Spec 18 section 8: dedicated, 4 vCPU, 4 threads, concurrency 1, from the 2026-10-29 ladder; 50 instances since the
  # 2026-10-30 scale-out.
  UPSCALE_SERVICE=dedicated
  # Spec 18: the dedicated CPU enlargement service catalog-upscale (asia-south1, the catalog-matting image, only the
  # upscaler loaded). Deployed only with UPSCALE_SERVICE=dedicated or UPSCALE_MEASURE=1. UPSCALE_THREADS is its ONNX
  # Runtime intra-op thread count; UPSCALE_TIMEOUT_S its Cloud Run request timeout (the client waits 30 s longer).
  # The asia-south1 quotas (400 vCPU and 800 GiB, granted 2026-10-30; shape_check counts every service in the region,
  # see CPU_QUOTA_VCPU): CPU binds, 50 x 4 = 200 vCPU gives 398 of 400. Memory 16Gi -> 8Gi (2026-10-30): the live p99
  # was 2.9 GiB and the largest x4 working set below is 4844 MiB (5073 MiB at 6.4 MP until 2026-10-31), under 80% of
  # 8 GiB; 50 x 8 = 400 GiB, 654 of 800 in all. A measure rung runs beside the live catalog-upscale (UPSCALE_LIVE_VCPU below), so with 50 x 4 live there is
  # no room for one: lower the live UPSCALE_MAX_INSTANCES first (shape_check counts both).
  # 4 vCPU over 8: 8 vCPU is only about 1.3x faster per call (78 s against 99 s p50 at 800x1200), so 16 x 4 finishes
  # more photos per second than the 8 x 8 the quota allows. Concurrency 1: concurrency 2 gave non-identical outputs
  # (refused by upscale_check). Timeout 1740 s, the most the enlarge task allows (its 1800 s dispatch deadline, the
  # Cloud Tasks maximum, less 30 s for the client and 30 s for the settle). It must cover the largest photo region the
  # service takes for each model, not only the probe sizes (upscale_check): 2 x the model's cap x its time per pixel.
  UPSCALE_CPU_VCPU=4
  UPSCALE_MEMORY=8Gi
  UPSCALE_CONCURRENCY=1
  UPSCALE_MAX_INSTANCES=50
  UPSCALE_THREADS=4
  UPSCALE_TIMEOUT_S=1740
  # Spec 18 lifecycle 3.7 (F57): the worker's health probe of the upscaler waits UPSCALE_COLD_START_S + 60 s, so a
  # scale-to-zero service that loads its model on start answers before the probe gives up. 120 s until the gate
  # measures the cold start; at most UPSCALE_TIMEOUT_S.
  UPSCALE_COLD_START_S=120
  # Spec 18 3.1.5 / 13: the largest image (width x height, before the 2x or 4x) catalog-upscale takes, one cap per
  # model (2026-10-29 review P1-3: one cap sized for x4 held x2 jobs that fit). Larger ones are refused by the service
  # (400) and held by the worker with enlargement_failed before any call, never a crash. The enlarge task sends only
  # the product's region of the prepared photo (its box plus 32 px), so each cap bounds the region, not the photo.
  # SwinIR is tiled, so time grows with pixels; each cap is 2 x the cap x the model's own time per pixel <= the 1740 s
  # timeout (upscale_check), at the slowest measured p95 per pixel of the rows below, 104.17 s per MP (100 s for
  # 800x1200), times the model's time ratio. x2 (UPSCALE_MAX_PIXELS): x UPSCALE_X2_TIME_RATIO (1.52), so
  # 2 x ceil(5.4 x 104.17 x 1.52) = 1712 s <= 1740 s. x4 (UPSCALE_MAX_PIXELS_X4): x UPSCALE_X4_TIME_RATIO (1.7), so
  # 2 x ceil(4.9 x 104.17 x 1.7) = 1736 s. Until 2026-10-31 the caps were 8 MP and 6.4 MP: the gate probes timed x2
  # on Cloud Run at up to 158 s per MP (152 s at 800x1200) and x4 at up to 151 s per MP (145.2 s), so 2 x 8 x 158 =
  # 2533 s and 2 x 6.4 x 151 = 1936 s did not fit. The deploy gate checks both caps on the measured calls of every
  # candidate (cloudrun_check.py cap_timeout_check). A region above its model's cap is not held: the worker makes it in
  # tiles under the cap (packages/core/src/catalog/pipeline/enlargement.ts enlargementRouteFor).
  # An x4 region is small in practice: x4 runs only above 2.0x, so its region is at most about half the largest canvas
  # side (3000 px), about 2.5 MP. Memory at each cap: about 4096 MiB resident plus 160 B per input pixel (the x4
  # model's working set, more than x2 needs), inside UPSCALE_MEMORY (upscale_check). 24 MP (the service's own default)
  # would need about 6500 s, more than one Cloud Tasks delivery (30 minutes) waits.
  UPSCALE_MAX_PIXELS=5400000
  UPSCALE_MAX_PIXELS_X4=4900000
  # Spec 18 GPU upscaler (owner 2026-10-30: AI enlargement on GPUs in a second region, asia-south2; speed matters a lot,
  # cost does not, reliability stays the must-have). UPSCALE_TARGET is where Start pins a new batch's enlargements: gpu
  # (catalog-upscale-gpu, the plain upscaler ids; the default since 2026-10-31, owner-approved after the CPU live test)
  # or cpu (catalog-upscale, the `+cpu` ids). Each batch keeps the target it started with (options.enlargement.target),
  # so `UPSCALE_TARGET=cpu bash infra/deploy.sh` is the rollback switch for new batches (with the CPU lanes of
  # ENLARGE_CPU_LANES) and never moves a running one; both services stay deployed for the batches already on them.
  # UPSCALE_GPU_SERVICE=1 deploys catalog-upscale-gpu (the matting-gpu image, only the upscaler loaded) and gives the
  # worker its URL either way.
  UPSCALE_TARGET=gpu
  UPSCALE_GPU_SERVICE=1
  # One NVIDIA RTX PRO 6000 (Blackwell, 96 GB) per instance in asia-south2, no zonal redundancy: 4 since 2026-10-31,
  # the most the asia-south2 memory quota allows (4 x 80 = 320 of 384 GiB; 5 x 80 = 400 does not fit, see
  # UPSCALE_GPU_REGION_MEMORY_GIB_LIMIT), within the granted GPU quota of 6. Cloud Run needs at least 20 vCPU and 80 GiB with this GPU. Concurrency 4: the
  # requests queue on the service's inference lock (one tile at a time), so 4 at once only overlap decode and encode
  # with inference; measured deterministic (services/matting/README.md "Measured on RTX PRO 6000"). Timeout 300 s:
  # the slowest measured call is a few seconds, and the largest image the caps allow about 20 s (upscale_gpu_check).
  UPSCALE_GPU_REGION=asia-south2
  UPSCALE_GPU_TYPE=nvidia-rtx-pro-6000
  UPSCALE_GPU_CPU=20
  UPSCALE_GPU_MEMORY=80Gi
  UPSCALE_GPU_MAX_INSTANCES=4
  UPSCALE_GPU_CONCURRENCY=4
  UPSCALE_GPU_TIMEOUT_S=300
  # The worker's health probe of the GPU upscaler waits UPSCALE_GPU_COLD_START_S + 60 s. Measured by hand on
  # 2026-10-30 (a fresh instance, image pulled, CUDA up and the first model loaded): 42 s typical, 91.5 s the
  # slowest seen; 180 is about twice that (services/matting/README.md "Measured on RTX PRO 6000").
  UPSCALE_GPU_COLD_START_S=180
  # The upscalers stay resident once used, so with UPSCALE_SERVICE=gpu both count on top of the cut-outs.
  GPU_UPSCALE_MODELS=swinir-x2,swinir-x4
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
# Spec 18 GPU upscaler: the enlarge lanes with UPSCALE_TARGET=cpu, the CPU shape that ran until 2026-10-31. They
# exceed what catalog-upscale-gpu serves, and catalog-upscale-gpu's lanes would leave catalog-upscale mostly idle, so
# the lanes follow the target. catalog-upscale serves UPSCALE_MAX_INSTANCES x UPSCALE_CONCURRENCY = 50 x 1 at once:
# 4 + 44 + the preview's 2 = 50. It finishes 50 x 1 / p50(800x1200) = 50 / 99 s = 0.5051/s, and 2 x 0.04 + 0.42 =
# 0.50/s (4 / 99 s, 44 / 99 s per lane). Env still wins over these rows.
ENLARGE_CPU_LANES=(
  ENLARGE_MAX_DISPATCHES=4
  ENLARGE_BULK_MAX_DISPATCHES=44
  ENLARGE_DISPATCHES_PER_SECOND=0.04
  ENLARGE_BULK_DISPATCHES_PER_SECOND=0.42
)
# The preview stack (CATALOG_PREVIEW=1, infra/deploy-preview.sh) runs the same per-instance shape on fewer worker
# instances and without a bulk queue, so a branch never takes the production worker's share of the asia-south1 CPU
# quota and never creates catalog-preview-bulk. These rows come first; the rest come from SHAPE_DEFAULTS.
PREVIEW_SHAPE_DEFAULTS=(
  WORKER_MAX_INSTANCES=4
  TASKS_MAX_DISPATCHES=6
  BULK_MAX_DISPATCHES=0
  INGEST_MAX_DISPATCHES=2
  ENLARGE_MAX_DISPATCHES=2
  ENLARGE_BULK_MAX_DISPATCHES=0
)

# shape_fill NAME=value ...: gives each NAME that is unset its value; a NAME that is set (also to "") keeps its own.
shape_fill() {
  local row name
  for row in "$@"; do
    name=${row%%=*}
    [ -n "${!name+x}" ] || printf -v "$name" '%s' "${row#*=}"
  done
}

# shape_row ARRAY NAME: the value of NAME's row in ARRAY (SHAPE_DEFAULTS or PREVIEW_SHAPE_DEFAULTS), or nothing.
shape_row() {
  local rows="$1[@]" row
  for row in "${!rows}"; do
    if [ "${row%%=*}" = "$2" ]; then printf '%s' "${row#*=}"; return 0; fi
  done
}

# shape_main_row NAME: the production stack's row of NAME for this deploy's UPSCALE_TARGET (ENLARGE_CPU_LANES with
# cpu, else SHAPE_DEFAULTS). Both stacks share the target, so the other stack's lanes are read with it.
shape_main_row() {
  local v=""
  [ "${UPSCALE_TARGET:-}" = cpu ] && v=$(shape_row ENLARGE_CPU_LANES "$1")
  [ -n "$v" ] || v=$(shape_row SHAPE_DEFAULTS "$1")
  printf '%s' "$v"
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
  # The target first: the enlarge lanes follow it (ENLARGE_CPU_LANES with cpu). Preview rows, then the target's lanes,
  # then the rest, each only where env has not set the name.
  shape_fill "UPSCALE_TARGET=$(shape_row SHAPE_DEFAULTS UPSCALE_TARGET)"
  if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then shape_fill "${PREVIEW_SHAPE_DEFAULTS[@]}"; fi
  if [ "$UPSCALE_TARGET" = cpu ]; then shape_fill "${ENLARGE_CPU_LANES[@]}"; fi
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
  # vCPU and GiB kept for the Cloud Run jobs (load, recheck, QA check, evals, migrate, smoke; 2 vCPU / 4Gi each, 4 at
  # once) in the quota checks.
  JOBS_CPU_BUDGET=8
  JOBS_MEMORY_GIB=16
  MATTING_CPU_VCPU=4
  MATTING_CPU_MEMORY_GIB=16
  WEB_MEMORY_GIB=1
  # The asia-south1 Cloud Run quotas (CpuAllocPerProjectRegion, MemAllocPerProjectRegion): 400 vCPU and 800 GiB,
  # granted 2026-10-30 (`gcloud beta quotas preferences list`). Google checks a single service's max against them at
  # deploy, never the sum; when live allocation reaches the quota, new instances fail to start (a busy answer that
  # costs an enlargement an attempt). So shape_check refuses a shape whose services, all at max instances, could
  # exceed them: this stack, the other catalog stack (preview or production, from its rows), the catalog jobs and
  # OTHER_APPS_*: what the other apps in the region can take at their max, read 2026-10-30 (ila-web 3 x 1 vCPU/1Gi,
  # ila-worker 5 x 1/1Gi, ila jobs 2/1.5Gi, npd-ui 2 x 1/0.5Gi, 7 npd jobs 7/4.5Gi, gcc-asn-bot and noon-asn-api-test
  # 2/4Gi each: 23 vCPU and 23 GiB), rounded up. Raise a quota here only once `grantedValue` shows it.
  CPU_QUOTA_VCPU=400
  MEMORY_QUOTA_GIB=800
  OTHER_APPS_VCPU=24
  OTHER_APPS_MEMORY_GIB=24
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
  GPU_MODEL_PEAK_MIB_SWINIR_X2=${GPU_MODEL_PEAK_MIB_SWINIR_X2-}
  GPU_MODEL_PEAK_MIB_SWINIR_X4=${GPU_MODEL_PEAK_MIB_SWINIR_X4-}
  # What one L4 offers (24 GB, about 22.5 GB usable).
  GPU_USABLE_MIB=22528
  # Spec 18 H1: UPSCALE_MEASURE=1 deploys only catalog-upscale, as a candidate of the UPSCALE_* shape (tag
  # measure-<cpu>c-<threads>t-<concurrency>r) for infra/check-matting.sh --probe-upscale, without asking for a measured
  # row. No other service, image, migration or worker env changes, so a measure rung never needs a new worker image.
  # Rung 1 of a brand-new catalog-upscale serves the service URL (Cloud Run cannot create a service with --no-traffic);
  # later rungs are no-traffic candidates. Not a shape row: a mode for one run.
  UPSCALE_MEASURE=${UPSCALE_MEASURE:-0}
  # Spec 18 H3: 1 when the worker image deployed has the enlarge stage (it calls the upscale service through its own
  # task, apps/worker/src/catalog/enlarge.ts and packages/core/src/catalog/enlarge.ts, and its render reads the stored
  # x2 only). 1 by default since H3. It stays a flag so a deploy (or rollback) of an older worker image, whose render
  # still calls the upscaler through the matting client that refuses catalog-upscale, sets ENLARGE_CLIENT_WIRED=0 and
  # shape_check refuses UPSCALE_SERVICE=dedicated for it.
  ENLARGE_CLIENT_WIRED=${ENLARGE_CLIENT_WIRED:-1}
  # The photo sizes the probe measures (width x height); the largest by pixels sets the timeout check.
  UPSCALE_SIZES=${UPSCALE_SIZES-800x1200,1600x1600}
  # Spec 18 H1: measured p95 in whole seconds (rounded up) of one POST /upscale (swinir-x2) per photo size, one row
  # per catalog-upscale shape: UPSCALE_P95_S_<UPSCALE_CPU_VCPU>C_<UPSCALE_THREADS>T_<UPSCALE_CONCURRENCY>CONC_<size>, copied
  # from the probe table in services/matting/README.md "Measured on CPU" with UPSCALE_MEASURED_ON, the probe's date.
  # Empty = not measured yet. Like the GPU peaks, a name that is set (also to "") wins. 2026-10-29: the ladder on
  # Cloud Run (SwinIR x2, tile 384, 3 rounds; JSON under catalog-test/probe/). The concurrency 2 rows are kept as
  # measured, but their outputs were not identical, so upscale_check refuses UPSCALE_CONCURRENCY above 1.
  UPSCALE_MEASURED_ON=${UPSCALE_MEASURED_ON-2026-10-29}
  UPSCALE_P95_S_4C_4T_1CONC_800x1200=${UPSCALE_P95_S_4C_4T_1CONC_800x1200-100}
  UPSCALE_P95_S_4C_4T_1CONC_1600x1600=${UPSCALE_P95_S_4C_4T_1CONC_1600x1600-216}
  UPSCALE_P95_S_4C_4T_2CONC_800x1200=${UPSCALE_P95_S_4C_4T_2CONC_800x1200-260}
  UPSCALE_P95_S_4C_4T_2CONC_1600x1600=${UPSCALE_P95_S_4C_4T_2CONC_1600x1600-521}
  UPSCALE_P95_S_8C_8T_1CONC_800x1200=${UPSCALE_P95_S_8C_8T_1CONC_800x1200-80}
  UPSCALE_P95_S_8C_8T_1CONC_1600x1600=${UPSCALE_P95_S_8C_8T_1CONC_1600x1600-165}
  UPSCALE_P95_S_8C_8T_2CONC_800x1200=${UPSCALE_P95_S_8C_8T_2CONC_800x1200-103}
  UPSCALE_P95_S_8C_8T_2CONC_1600x1600=${UPSCALE_P95_S_8C_8T_2CONC_1600x1600-342}
  # Spec 18 3.1.5: the measured p50 in whole seconds (rounded up), same naming, same probe and date. It sets the queue
  # rate rule; empty = not measured, and the p95 of the same size then stands in (slower, so a safe bound).
  UPSCALE_P50_S_4C_4T_1CONC_800x1200=${UPSCALE_P50_S_4C_4T_1CONC_800x1200-99}
  UPSCALE_P50_S_4C_4T_1CONC_1600x1600=${UPSCALE_P50_S_4C_4T_1CONC_1600x1600-215}
  UPSCALE_P50_S_4C_4T_2CONC_800x1200=${UPSCALE_P50_S_4C_4T_2CONC_800x1200-126}
  UPSCALE_P50_S_4C_4T_2CONC_1600x1600=${UPSCALE_P50_S_4C_4T_2CONC_1600x1600-494}
  UPSCALE_P50_S_8C_8T_1CONC_800x1200=${UPSCALE_P50_S_8C_8T_1CONC_800x1200-78}
  UPSCALE_P50_S_8C_8T_1CONC_1600x1600=${UPSCALE_P50_S_8C_8T_1CONC_1600x1600-159}
  UPSCALE_P50_S_8C_8T_2CONC_800x1200=${UPSCALE_P50_S_8C_8T_2CONC_800x1200-79}
  UPSCALE_P50_S_8C_8T_2CONC_1600x1600=${UPSCALE_P50_S_8C_8T_2CONC_1600x1600-168}
  # The enlarge task's dispatch deadline is 1800 s (ENLARGE_DISPATCH_DEADLINE_SEC, the Cloud Tasks maximum for an HTTP
  # task); the upscale call waits UPSCALE_TIMEOUT_S + 30 s and the settle keeps 30 s, so 1740 is the most.
  UPSCALE_TIMEOUT_MAX_S=1740
  # The worker's output limit for one enlarged image, every route (packages/core/src/catalog/pipeline/enlargement.ts
  # ENLARGE_MAX_OUTPUT_PIXELS); a constant of the code, not a knob.
  ENLARGE_MAX_OUTPUT_PIXELS=64000000
  # Spec 18 quality: the x4 model's time per megapixel over the x2 rows' (the slowest measured p95 per MP above), used
  # to size UPSCALE_MAX_PIXELS_X4 here and the probe job's budget (services.sh); the deploy gate does not compare it,
  # it checks the x4 cap against the timeout on the measured x4 calls (cloudrun_check.py cap_timeout_check). 1.3 until
  # 2026-10-31, from laptop runs (pairs 1.0 to 1.283). The gate probes on Cloud Run (2026-10-30, five candidates, x4
  # at 800x1200 one call each) timed 123.2 to 145.2 s, 128 to 151 s per MP: up to 1.45 x 104.17. 1.7 keeps about 17%
  # over the slowest seen, so a candidate as slow as the slowest seen still passes the gate's check at the cap.
  UPSCALE_X4_TIME_RATIO=${UPSCALE_X4_TIME_RATIO-1.7}
  # The same for the x2 model (2026-10-31): the rows above are one 2026-10-29 ladder (100 s at 800x1200), but the gate
  # probes on Cloud Run timed x2 at 800x1200 at 96.4 to 152 s (2026-10-30, five candidates, one call each), up to
  # 158.33 s per MP = 1.52 x 104.17. Sizes UPSCALE_MAX_PIXELS here; the deploy gate checks the cap on the measured calls.
  UPSCALE_X2_TIME_RATIO=${UPSCALE_X2_TIME_RATIO-1.52}
  # Spec 18 quality: catalog-upscale memory, from the 2026-10-29 local measure of swinir-x4 through the service code
  # (peak commit 2685 MiB after load, 2851 MiB at 1200x1600: about 86 B per input pixel, the output 16x the input):
  # the resident part (both sessions, Python, ONNX Runtime arenas) rounded up to 4096 MiB, and 160 B per input pixel
  # (the float32 input and padding, the uint8 x4 output, its JPEG), almost twice what was measured.
  UPSCALE_RESIDENT_MIB=${UPSCALE_RESIDENT_MIB-4096}
  UPSCALE_X4_BYTES_PER_PIXEL=${UPSCALE_X4_BYTES_PER_PIXEL-160}
  # Spec 18 P2 (2026-10-29 review): the vCPU the live catalog-upscale takes at max instances, counted beside a measure
  # rung (UPSCALE_MEASURE=1 deploys a candidate of the same service while the live revision keeps serving). From the
  # rows, which are the live shape; set it (also to 0) only when the live service differs from them, such as before
  # the first deploy of UPSCALE_SERVICE=dedicated.
  # UPSCALE_LIVE_GIB is the same for memory.
  if [ -z "${UPSCALE_LIVE_VCPU+x}" ]; then
    UPSCALE_LIVE_VCPU=0
    if [ "$(shape_row SHAPE_DEFAULTS UPSCALE_SERVICE)" = dedicated ]; then
      UPSCALE_LIVE_VCPU=$(( $(shape_row SHAPE_DEFAULTS UPSCALE_MAX_INSTANCES) * $(shape_row SHAPE_DEFAULTS UPSCALE_CPU_VCPU) ))
    fi
  fi
  if [ -z "${UPSCALE_LIVE_GIB+x}" ]; then
    UPSCALE_LIVE_GIB=0
    if [ "$(shape_row SHAPE_DEFAULTS UPSCALE_SERVICE)" = dedicated ]; then
      local live_mem
      live_mem=$(shape_row SHAPE_DEFAULTS UPSCALE_MEMORY)
      UPSCALE_LIVE_GIB=$(( $(shape_row SHAPE_DEFAULTS UPSCALE_MAX_INSTANCES) * ${live_mem%Gi} ))
    fi
  fi
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
  # What the catalog may use of the asia-south1 quotas: the rest is OTHER_APPS_* (above).
  CPU_QUOTA_LIMIT=$((CPU_QUOTA_VCPU - OTHER_APPS_VCPU))
  MEMORY_QUOTA_LIMIT_GIB=$((MEMORY_QUOTA_GIB - OTHER_APPS_MEMORY_GIB))
  # Spec 18 GPU upscaler: the GPU upscaler's region has its own Cloud Run quotas (200 vCPU and 400 GiB per region,
  # read 2026-10-30; nothing else of ours runs in asia-south2), kept 10 vCPU and 16 GiB spare like asia-south1. The
  # per-type GPU quota (no zonal redundancy) there: 6 RTX PRO 6000, granted 2026-10-31 (infra/request-gpu-upscale-quota.sh;
  # 3 were granted automatically on the first deploy). 6 instances at 80 GiB need 480 GiB, above the 400 GiB memory
  # quota: the owner files a memory quota raise for asia-south2 by hand, and then this memory limit is raised.
  UPSCALE_GPU_REGION_CPU_LIMIT=${UPSCALE_GPU_REGION_CPU_LIMIT-190}
  UPSCALE_GPU_REGION_MEMORY_GIB_LIMIT=${UPSCALE_GPU_REGION_MEMORY_GIB_LIMIT-384}
  UPSCALE_GPU_QUOTA=${UPSCALE_GPU_QUOTA-6}
  # Measured p95 and p50 in whole seconds (rounded up) of one POST /upscale per photo size, model swinir-x2, one row per
  # GPU type and concurrency: UPSCALE_GPU_P95_S_<UPSCALE_GPU_TYPE in capitals, "_" for "-">_<conc>CONC_<size>, from
  # infra/check-matting.sh --probe-upscale on the candidate (services/matting/README.md "Measured on RTX PRO 6000"),
  # with UPSCALE_GPU_MEASURED_ON. Empty = not measured: upscale_gpu_check refuses the shape ("measure first").
  # UPSCALE_GPU_X4_TIME_RATIO is the x4 over x2 p95 bound the gate's probe enforces (measured at most 2.3 at 800x1200,
  # where both are about a second and one slow call moves the p95).
  UPSCALE_GPU_MEASURED_ON=${UPSCALE_GPU_MEASURED_ON-2026-10-30}
  UPSCALE_GPU_P95_S_NVIDIA_RTX_PRO_6000_1CONC_800x1200=${UPSCALE_GPU_P95_S_NVIDIA_RTX_PRO_6000_1CONC_800x1200-2}
  UPSCALE_GPU_P95_S_NVIDIA_RTX_PRO_6000_1CONC_1600x1600=${UPSCALE_GPU_P95_S_NVIDIA_RTX_PRO_6000_1CONC_1600x1600-3}
  UPSCALE_GPU_P50_S_NVIDIA_RTX_PRO_6000_1CONC_800x1200=${UPSCALE_GPU_P50_S_NVIDIA_RTX_PRO_6000_1CONC_800x1200-2}
  UPSCALE_GPU_P50_S_NVIDIA_RTX_PRO_6000_1CONC_1600x1600=${UPSCALE_GPU_P50_S_NVIDIA_RTX_PRO_6000_1CONC_1600x1600-3}
  UPSCALE_GPU_P95_S_NVIDIA_RTX_PRO_6000_4CONC_800x1200=${UPSCALE_GPU_P95_S_NVIDIA_RTX_PRO_6000_4CONC_800x1200-4}
  UPSCALE_GPU_P95_S_NVIDIA_RTX_PRO_6000_4CONC_1600x1600=${UPSCALE_GPU_P95_S_NVIDIA_RTX_PRO_6000_4CONC_1600x1600-7}
  UPSCALE_GPU_P50_S_NVIDIA_RTX_PRO_6000_4CONC_800x1200=${UPSCALE_GPU_P50_S_NVIDIA_RTX_PRO_6000_4CONC_800x1200-4}
  UPSCALE_GPU_P50_S_NVIDIA_RTX_PRO_6000_4CONC_1600x1600=${UPSCALE_GPU_P50_S_NVIDIA_RTX_PRO_6000_4CONC_1600x1600-7}
  UPSCALE_GPU_X4_TIME_RATIO=${UPSCALE_GPU_X4_TIME_RATIO-3}
}

# shape_check [live_connection_limit]: prints every problem to stderr and returns 1 if there is any. Sets
# CATALOG_DB_LIMIT, CATALOG_DB_TOTAL, SLOTS_TOTAL, SLOTS_CAPACITY, CPU_TOTAL and MEMORY_TOTAL_GIB for the caller's
# summary lines.
# live_connection_limit is the max_connections ila-pg allows now (empty skips that check).
shape_check() {
  local live=${1:-} ok=0 name value gib
  shape_fail() { echo "ERROR: $*" >&2; ok=1; }
  for name in DB_MAX_CONNECTIONS WORKER_MAX_INSTANCES WORKER_CPU WORKER_CONCURRENCY WORKER_DB_POOL_MAX \
      INGEST_MAX_DISPATCHES BULK_MAX_DISPATCHES TASKS_MAX_DISPATCHES MATTING_CPU_MAX_INSTANCES GPU_MAX_INSTANCES \
      GPU_CPU GPU_CONCURRENCY MAX_RESIDENT_SESSIONS MATTE_INFLIGHT_PER_INSTANCE CATALOG_PHOTO_CONCURRENCY \
      CATALOG_BULK_WINDOW BULK_BATCH_PRODUCTS GPU_CUDA_OVERHEAD_MIB UPSCALE_CPU_VCPU UPSCALE_CONCURRENCY UPSCALE_MAX_INSTANCES \
      UPSCALE_THREADS UPSCALE_TIMEOUT_S UPSCALE_COLD_START_S UPSCALE_MAX_PIXELS UPSCALE_MAX_PIXELS_X4 UPSCALE_LIVE_VCPU ENLARGE_MAX_DISPATCHES ENLARGE_BULK_MAX_DISPATCHES \
      UPSCALE_GPU_CPU UPSCALE_GPU_MAX_INSTANCES UPSCALE_GPU_CONCURRENCY UPSCALE_GPU_TIMEOUT_S UPSCALE_GPU_COLD_START_S UPSCALE_GPU_QUOTA \
      UPSCALE_GPU_REGION_CPU_LIMIT UPSCALE_GPU_REGION_MEMORY_GIB_LIMIT; do
    value=${!name}
    if ! [[ "$value" =~ ^[0-9]+$ ]]; then shape_fail "$name must be a whole number, got '$value'"; return 1; fi
  done
  for name in WORKER_MAX_INSTANCES WORKER_CONCURRENCY WORKER_DB_POOL_MAX INGEST_MAX_DISPATCHES TASKS_MAX_DISPATCHES \
      MATTING_CPU_MAX_INSTANCES GPU_MAX_INSTANCES GPU_CONCURRENCY MAX_RESIDENT_SESSIONS MATTE_INFLIGHT_PER_INSTANCE \
      CATALOG_PHOTO_CONCURRENCY CATALOG_BULK_WINDOW BULK_BATCH_PRODUCTS UPSCALE_CONCURRENCY UPSCALE_MAX_INSTANCES UPSCALE_THREADS UPSCALE_COLD_START_S UPSCALE_MAX_PIXELS UPSCALE_MAX_PIXELS_X4; do
    [ "${!name}" -ge 1 ] || shape_fail "$name must be at least 1"
  done
  # Cloud Tasks takes a rate above 0 and at most 500 per second.
  for name in ENLARGE_DISPATCHES_PER_SECOND ENLARGE_BULK_DISPATCHES_PER_SECOND; do
    value=${!name}
    if ! [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || ! awk -v r="$value" 'BEGIN{exit !(r>0 && r<=500)}'; then
      shape_fail "$name must be a number above 0 and at most 500, such as 0.1, got '$value'"; return 1
    fi
  done
  case "$WORKER_CPU" in 1|2|4|6|8) ;; *) shape_fail "WORKER_CPU must be 1, 2, 4, 6 or 8 (Cloud Run), got $WORKER_CPU" ;; esac
  [[ "$WORKER_MEMORY" =~ ^[1-9][0-9]*Gi$ ]] || shape_fail "WORKER_MEMORY must look like 4Gi, got '$WORKER_MEMORY'"
  # Spec 18 lifecycle 3.2: the worker decodes an enlarged image of at most ENLARGE_MAX_OUTPUT_PIXELS (64,000,000, 3 B
  # each as RGB) and holds about two copies while it stitches or validates; with WORKER_CONCURRENCY deliveries at once
  # that stays within half the worker's memory (the rest is Node, the render and the cut-outs).
  if [[ "$WORKER_MEMORY" =~ ^[1-9][0-9]*Gi$ ]]; then
    local enlarge_mib=$((3 * ENLARGE_MAX_OUTPUT_PIXELS * 2 * WORKER_CONCURRENCY / 1048576)) half_mib=$((${WORKER_MEMORY%Gi} * 512))
    [ "$enlarge_mib" -le "$half_mib" ] || shape_fail "WORKER_CONCURRENCY=$WORKER_CONCURRENCY with WORKER_MEMORY=$WORKER_MEMORY: $WORKER_CONCURRENCY enlarged images of up to $ENLARGE_MAX_OUTPUT_PIXELS pixels need about $enlarge_mib MiB, above half the worker's memory ($half_mib MiB). Raise WORKER_MEMORY or lower WORKER_CONCURRENCY"
  fi
  [[ "$GPU_MEMORY" =~ ^[1-9][0-9]*Gi$ ]] || shape_fail "GPU_MEMORY must look like 32Gi, got '$GPU_MEMORY'"
  [[ -z "$GPU_MEM_LIMIT_BYTES" || "$GPU_MEM_LIMIT_BYTES" =~ ^[1-9][0-9]*$ ]] || shape_fail "GPU_MEM_LIMIT_BYTES must be a byte count such as 6442450944"
  [[ -z "$LLM_INFLIGHT_PER_INSTANCE" || "$LLM_INFLIGHT_PER_INSTANCE" =~ ^[1-9][0-9]*$ ]] || shape_fail "LLM_INFLIGHT_PER_INSTANCE must be empty or a whole number such as 6"
  case "$UPSCALE_SERVICE" in gpu|cpu|dedicated) ;; *) shape_fail "UPSCALE_SERVICE must be gpu, cpu or dedicated, got '$UPSCALE_SERVICE'" ;; esac
  case "$UPSCALE_MEASURE" in 0|1) ;; *) shape_fail "UPSCALE_MEASURE must be 0 or 1, got '$UPSCALE_MEASURE'" ;; esac
  case "$UPSCALE_TARGET" in cpu|gpu) ;; *) shape_fail "UPSCALE_TARGET must be cpu or gpu, got '$UPSCALE_TARGET'" ;; esac
  case "$UPSCALE_GPU_SERVICE" in 0|1) ;; *) shape_fail "UPSCALE_GPU_SERVICE must be 0 or 1, got '$UPSCALE_GPU_SERVICE'" ;; esac

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
  # The enlarge lanes (spec 18) count too: an enlarge task holds a worker slot while it waits on the upscaler.
  SLOTS_TOTAL=$((TASKS_MAX_DISPATCHES + BULK_MAX_DISPATCHES + INGEST_MAX_DISPATCHES + ENLARGE_MAX_DISPATCHES + ENLARGE_BULK_MAX_DISPATCHES))
  SLOTS_CAPACITY=$((WORKER_MAX_INSTANCES * WORKER_CONCURRENCY))
  if [ "$SLOTS_TOTAL" -gt "$SLOTS_CAPACITY" ]; then
    shape_fail "queue slots $TASKS_MAX_DISPATCHES + $BULK_MAX_DISPATCHES + $INGEST_MAX_DISPATCHES + enlarge $ENLARGE_MAX_DISPATCHES + $ENLARGE_BULK_MAX_DISPATCHES = $SLOTS_TOTAL exceed the worker's $WORKER_MAX_INSTANCES x $WORKER_CONCURRENCY = $SLOTS_CAPACITY"
  fi
  # CPU quota in asia-south1 (the GPU service counts in asia-southeast1), with catalog-upscale when it is deployed.
  # A measure rung's candidate runs beside the live catalog-upscale revision (each revision has its own max
  # instances), so both count.
  # Each *_MAX_INSTANCES here is both the revision max and the service-level max: the gate sets the service's --max
  # to the same value (gate_service_max, infra/lib/gate.sh), so this count is what the services can really reach.
  # 2026-10-30: the other catalog stack's worker and web (production when this is the preview, the preview otherwise),
  # from its rows, count too: catalog-matting and catalog-upscale are shared and counted once, here.
  local other_worker other_vcpu other_gib other_label
  if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then
    other_label=production
    other_worker=$(shape_row SHAPE_DEFAULTS WORKER_MAX_INSTANCES)
  else
    other_label=preview
    other_worker=$(shape_row PREVIEW_SHAPE_DEFAULTS WORKER_MAX_INSTANCES)
  fi
  gib=$(shape_row SHAPE_DEFAULTS WORKER_MEMORY)
  other_vcpu=$((other_worker * $(shape_row SHAPE_DEFAULTS WORKER_CPU) + WEB_MAX_INSTANCES * WEB_CPU))
  other_gib=$((other_worker * ${gib%Gi} + WEB_MAX_INSTANCES * WEB_MEMORY_GIB))
  UPSCALE_VCPU_TOTAL=0; UPSCALE_GIB_TOTAL=0
  if upscale_deployed; then
    UPSCALE_VCPU_TOTAL=$((UPSCALE_MAX_INSTANCES * UPSCALE_CPU_VCPU))
    [[ "$UPSCALE_MEMORY" =~ ^[1-9][0-9]*Gi$ ]] && UPSCALE_GIB_TOTAL=$((UPSCALE_MAX_INSTANCES * ${UPSCALE_MEMORY%Gi}))
  fi
  if [ "$UPSCALE_MEASURE" = 1 ]; then
    UPSCALE_VCPU_TOTAL=$((UPSCALE_VCPU_TOTAL + UPSCALE_LIVE_VCPU)); UPSCALE_GIB_TOTAL=$((UPSCALE_GIB_TOTAL + UPSCALE_LIVE_GIB))
  fi
  local measure_note=""
  if [ "$UPSCALE_MEASURE" = 1 ] && [ "$UPSCALE_LIVE_VCPU" -gt 0 ]; then
    measure_note=" (catalog-upscale counts the measure candidate and the live revision's $UPSCALE_LIVE_VCPU vCPU / $UPSCALE_LIVE_GIB GiB: deploy a smaller live UPSCALE_MAX_INSTANCES first)"
  fi
  CPU_TOTAL=$((WORKER_MAX_INSTANCES * WORKER_CPU + MATTING_CPU_MAX_INSTANCES * MATTING_CPU_VCPU + UPSCALE_VCPU_TOTAL + WEB_MAX_INSTANCES * WEB_CPU + JOBS_CPU_BUDGET + other_vcpu))
  if [ "$CPU_TOTAL" -gt "$CPU_QUOTA_LIMIT" ]; then
    shape_fail "asia-south1 vCPU at max instances $CPU_TOTAL exceeds $CPU_QUOTA_LIMIT of the $CPU_QUOTA_VCPU vCPU quota, $OTHER_APPS_VCPU kept for the other apps (worker $((WORKER_MAX_INSTANCES * WORKER_CPU)) + catalog-matting $((MATTING_CPU_MAX_INSTANCES * MATTING_CPU_VCPU)) + catalog-upscale $UPSCALE_VCPU_TOTAL + web and jobs $((WEB_MAX_INSTANCES * WEB_CPU + JOBS_CPU_BUDGET)) + the $other_label stack $other_vcpu); lower WORKER_MAX_INSTANCES, MATTING_CPU_MAX_INSTANCES or UPSCALE_MAX_INSTANCES$measure_note"
  fi
  # 2026-10-30: the same for memory (catalog-matting is 16Gi per instance, services.sh). Not checked before, when the
  # sum at max instances (439 GiB) was already above the 400 GiB quota.
  if [[ "$WORKER_MEMORY" =~ ^[1-9][0-9]*Gi$ ]]; then
    MEMORY_TOTAL_GIB=$((WORKER_MAX_INSTANCES * ${WORKER_MEMORY%Gi} + MATTING_CPU_MAX_INSTANCES * MATTING_CPU_MEMORY_GIB + UPSCALE_GIB_TOTAL + WEB_MAX_INSTANCES * WEB_MEMORY_GIB + JOBS_MEMORY_GIB + other_gib))
    if [ "$MEMORY_TOTAL_GIB" -gt "$MEMORY_QUOTA_LIMIT_GIB" ]; then
      shape_fail "asia-south1 memory at max instances $MEMORY_TOTAL_GIB GiB exceeds $MEMORY_QUOTA_LIMIT_GIB of the $MEMORY_QUOTA_GIB GiB quota, $OTHER_APPS_MEMORY_GIB kept for the other apps (worker $((WORKER_MAX_INSTANCES * ${WORKER_MEMORY%Gi})) + catalog-matting $((MATTING_CPU_MAX_INSTANCES * MATTING_CPU_MEMORY_GIB)) + catalog-upscale $UPSCALE_GIB_TOTAL + web and jobs $((WEB_MAX_INSTANCES * WEB_MEMORY_GIB + JOBS_MEMORY_GIB)) + the $other_label stack $other_gib); lower UPSCALE_MEMORY or a *_MAX_INSTANCES$measure_note"
    fi
  fi
  # GPU: today's L4 quota, and Cloud Run's L4 shape (at least 4 CPU and 16 GiB; 8 CPU and 32 GiB recommended).
  [ "$GPU_MAX_INSTANCES" -le "$GPU_QUOTA" ] || shape_fail "GPU_MAX_INSTANCES=$GPU_MAX_INSTANCES exceeds the L4 quota of $GPU_QUOTA; request more first (gcloud beta quotas preferences create; the owner allows quota requests since 2026-10-30) and raise GPU_QUOTA once it is granted"
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
  upscale_gpu_check
  return $ok
}

# 0 when this deploy runs catalog-upscale: as the worker's upscaler (dedicated) or as a candidate being measured.
upscale_deployed() { [ "$UPSCALE_SERVICE" = dedicated ] || [ "$UPSCALE_MEASURE" = 1 ]; }

# upscale_p95 <size>: the measured p95 in seconds of the current UPSCALE_CPU_VCPU/THREADS/CONCURRENCY shape, or nothing.
upscale_p95() {
  local name="UPSCALE_P95_S_${UPSCALE_CPU_VCPU}C_${UPSCALE_THREADS}T_${UPSCALE_CONCURRENCY}CONC_$1"
  printf '%s' "${!name:-}"
}

# upscale_p50 <size>: the measured p50 in seconds of the current shape, or nothing.
upscale_p50() {
  local name="UPSCALE_P50_S_${UPSCALE_CPU_VCPU}C_${UPSCALE_THREADS}T_${UPSCALE_CONCURRENCY}CONC_$1"
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

# The slowest measured p95 per megapixel over UPSCALE_SIZES (seconds, 4 decimals) of the current shape. Needs a
# whole-number p95 for every size (upscale_check checks that first).
upscale_seconds_per_mp() {
  local size w h worst=0
  for size in ${UPSCALE_SIZES//,/ }; do
    w=${size%x*}; h=${size#*x}
    worst=$(awk -v p="$(upscale_p95 "$size")" -v n="$((w * h))" -v m="$worst" 'BEGIN{v = p / n * 1000000; printf "%.4f", (v > m ? v : m)}')
  done
  printf '%s' "$worst"
}

# The size in UPSCALE_SIZES with the fewest pixels.
upscale_smallest_size() {
  local size smallest="" fewest=0 w h
  for size in ${UPSCALE_SIZES//,/ }; do
    w=${size%x*}; h=${size#*x}
    if [ -z "$smallest" ] || [ $((w * h)) -lt "$fewest" ]; then fewest=$((w * h)); smallest=$size; fi
  done
  printf '%s' "$smallest"
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
    || shape_fail "UPSCALE_TIMEOUT_S must be 60 to $UPSCALE_TIMEOUT_MAX_S s (the enlarge task's deadline is 1800 s, the client waits 30 s longer and the settle keeps 30 s), got $UPSCALE_TIMEOUT_S"
  [ "$UPSCALE_COLD_START_S" -le "$UPSCALE_TIMEOUT_S" ] || shape_fail "UPSCALE_COLD_START_S=$UPSCALE_COLD_START_S is above UPSCALE_TIMEOUT_S=$UPSCALE_TIMEOUT_S (a cold start longer than a call cannot be waited for)"
  [ -n "${UPSCALE_SIZES//[, ]/}" ] || { shape_fail "UPSCALE_SIZES must list the probe sizes, such as 800x1200,1600x1600"; return 0; }
  for size in ${UPSCALE_SIZES//,/ }; do
    [[ "$size" =~ ^[1-9][0-9]*x[1-9][0-9]*$ ]] || { shape_fail "UPSCALE_SIZES must list sizes such as 800x1200,1600x1600, got '$UPSCALE_SIZES'"; return 0; }
  done
  if [ "$UPSCALE_MEASURE" = 1 ] && [ "$UPSCALE_SERVICE" = dedicated ]; then
    shape_fail "UPSCALE_MEASURE=1 deploys catalog-upscale as a no-traffic candidate; keep the worker on UPSCALE_SERVICE=cpu (or gpu) while measuring"
    return 0
  fi
  [ "$UPSCALE_SERVICE" = dedicated ] || return 0
  if [ "$UPSCALE_CONCURRENCY" -gt 1 ]; then
    shape_fail "UPSCALE_CONCURRENCY=$UPSCALE_CONCURRENCY is refused: concurrency 2 produced non-identical outputs on 2026-10-29 (ladder rungs 2 and 4); measure and prove determinism before raising"
    return 0
  fi
  if [ "$ENLARGE_CLIENT_WIRED" != 1 ]; then
    shape_fail "UPSCALE_SERVICE=dedicated needs a worker image with the spec 18 H3 enlarge stage (ENLARGE_CLIENT_WIRED=$ENLARGE_CLIENT_WIRED says this one has none): its render would ask the matting client for catalog-upscale, which it refuses; keep UPSCALE_SERVICE=cpu"
    return 0
  fi
  # Spec 18 3.3.1: the enlarge lanes never send more at once than catalog-upscale serves at once. The production and
  # preview stacks both call the one live catalog-upscale, so the other stack's lanes (from its rows) count too: with
  # concurrency 1 there is no slack, and a busy answer costs a photo one of its attempts.
  local other other_name
  if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then
    other_name=production
    other=$(( $(shape_main_row ENLARGE_MAX_DISPATCHES) + $(shape_main_row ENLARGE_BULK_MAX_DISPATCHES) ))
  else
    other_name=preview
    other=$(( $(shape_row PREVIEW_SHAPE_DEFAULTS ENLARGE_MAX_DISPATCHES) + $(shape_row PREVIEW_SHAPE_DEFAULTS ENLARGE_BULK_MAX_DISPATCHES) ))
  fi
  if [ $((ENLARGE_MAX_DISPATCHES + ENLARGE_BULK_MAX_DISPATCHES + other)) -gt $((UPSCALE_MAX_INSTANCES * UPSCALE_CONCURRENCY)) ]; then
    shape_fail "enlarge slots $ENLARGE_MAX_DISPATCHES + $ENLARGE_BULK_MAX_DISPATCHES + the $other_name stack's $other = $((ENLARGE_MAX_DISPATCHES + ENLARGE_BULK_MAX_DISPATCHES + other)) exceed what catalog-upscale serves at once ($UPSCALE_MAX_INSTANCES x $UPSCALE_CONCURRENCY); lower ENLARGE_MAX_DISPATCHES or ENLARGE_BULK_MAX_DISPATCHES"
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
    shape_fail "catalog-upscale at $UPSCALE_CPU_VCPU vCPU, $UPSCALE_THREADS threads, concurrency $UPSCALE_CONCURRENCY needs a timeout of 2 x p95 $(upscale_p95 "$largest") s = $worst s for $largest, over the $UPSCALE_TIMEOUT_MAX_S s the enlarge task allows; measure a faster shape"
  elif [ "$UPSCALE_TIMEOUT_S" -lt "$worst" ]; then
    shape_fail "UPSCALE_TIMEOUT_S=$UPSCALE_TIMEOUT_S is below 2 x the measured p95 of $largest ($(upscale_p95 "$largest") s, measured $UPSCALE_MEASURED_ON); set it to at least $worst"
  fi
  # 2026-10-29 review P1: the largest image the service takes for each model, not only the probe sizes, must finish
  # within the timeout, or it times out on every attempt and is held. Its p95 is estimated from the slowest measured
  # p95 per pixel of the probe sizes (tiled, so time grows with pixels; the smallest size carries the most fixed cost
  # per pixel, a safe bound for larger photos), with the same 2x margin. 2026-10-29 review P1-3: each model has its
  # own cap at its own time per pixel, so the x4 model's longer time never shrinks the x2 model's cap: the x2 model at
  # UPSCALE_X2_TIME_RATIO times the measured rate (UPSCALE_MAX_PIXELS, 2026-10-31: the Cloud Run x2 calls ran up to
  # 1.52 x the rows), the x4 model at UPSCALE_X4_TIME_RATIO times it (UPSCALE_MAX_PIXELS_X4, checked when the x4 model
  # is served: UPSCALE_MODEL_X4, default swinir-x4).
  local per_mp est need fits pair cap_name cap ratio model
  [[ "$UPSCALE_X2_TIME_RATIO" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v r="$UPSCALE_X2_TIME_RATIO" 'BEGIN{exit !(r >= 1)}' \
    || { shape_fail "UPSCALE_X2_TIME_RATIO must be a number of at least 1 (the x2 model's Cloud Run time over the measured rows'), got '$UPSCALE_X2_TIME_RATIO'"; return 0; }
  local -a caps=("UPSCALE_MAX_PIXELS|$UPSCALE_X2_TIME_RATIO|x2 ($UPSCALE_X2_TIME_RATIO x the rows' time)")
  if [ "${UPSCALE_MODEL_X4:-swinir-x4}" != off ]; then
    [[ "$UPSCALE_X4_TIME_RATIO" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v r="$UPSCALE_X4_TIME_RATIO" 'BEGIN{exit !(r >= 1)}' \
      || { shape_fail "UPSCALE_X4_TIME_RATIO must be a number of at least 1 (the x4 model's time over the x2 model's), got '$UPSCALE_X4_TIME_RATIO'"; return 0; }
    caps+=("UPSCALE_MAX_PIXELS_X4|$UPSCALE_X4_TIME_RATIO|x4 ($UPSCALE_X4_TIME_RATIO x the x2 time)")
  fi
  per_mp=$(upscale_seconds_per_mp)
  # Spec 18 quality: each largest image's working set fits the instance (an out-of-memory restart fails every attempt
  # of that photo), kept under 80% of UPSCALE_MEMORY, at the x4 model's bytes per input pixel (the x2 model needs less:
  # a quarter of the output).
  local mem_mib="" work_mib
  [ -n "${gib:-}" ] && mem_mib=$((gib * 1024))
  for pair in "${caps[@]}"; do
    IFS='|' read -r cap_name ratio model <<< "$pair"
    cap=${!cap_name}
    est=$(awk -v p="$cap" -v r="$per_mp" -v x="$ratio" 'BEGIN{v = p / 1000000 * r * x; c = int(v); if (c < v) c++; print c}')
    need=$((2 * est))
    if [ "$need" -gt "$UPSCALE_TIMEOUT_S" ]; then
      fits=$(awk -v t="$UPSCALE_TIMEOUT_S" -v r="$per_mp" -v x="$ratio" 'BEGIN{printf "%d", t / 2 / r / x * 1000000}')
      shape_fail "$cap_name=$cap needs a timeout of 2 x about $est s = $need s on the $model model (the slowest measured p95, $per_mp s per megapixel, measured $UPSCALE_MEASURED_ON), above UPSCALE_TIMEOUT_S=$UPSCALE_TIMEOUT_S: such images would time out on every attempt and be held. Raise UPSCALE_TIMEOUT_S (at most $UPSCALE_TIMEOUT_MAX_S) or lower $cap_name to at most $fits"
    fi
    [ -n "$mem_mib" ] || continue
    work_mib=$(awk -v p="$cap" -v b="$UPSCALE_X4_BYTES_PER_PIXEL" -v r="$UPSCALE_RESIDENT_MIB" 'BEGIN{v = r + p * b / 1048576; c = int(v); if (c < v) c++; print c}')
    if [ $((work_mib * 10)) -gt $((mem_mib * 8)) ]; then
      shape_fail "$cap_name=$cap needs about $work_mib MiB ($UPSCALE_RESIDENT_MIB MiB resident + $UPSCALE_X4_BYTES_PER_PIXEL B per input pixel), more than 80% of UPSCALE_MEMORY=$UPSCALE_MEMORY; raise UPSCALE_MEMORY or lower $cap_name"
    fi
  done
  [ -n "$mem_mib" ] || return 0
  # Spec 18 GPU upscaler: with UPSCALE_TARGET=gpu new batches enlarge on catalog-upscale-gpu and catalog-upscale only
  # finishes the batches started on it; its slot rule above still holds, the rate follows the GPU (upscale_gpu_check).
  [ "$UPSCALE_TARGET" = cpu ] || return 0
  # Spec 18 3.1.5, the queue rate: the SUM of the rates of every enlarge lane that calls catalog-upscale <=
  # UPSCALE_MAX_INSTANCES x UPSCALE_CONCURRENCY / p50, at the smallest size (the usual photo). Without a measured p50 the
  # p95 of that size stands in (a safe bound). Cloud Tasks paces each queue on its own, so each lane with slots counts
  # its own rate: the operator lanes ENLARGE_DISPATCHES_PER_SECOND, the bulk lanes ENLARGE_BULK_DISPATCHES_PER_SECOND,
  # this stack's and the other stack's (from its rows; the rates are shared rows).
  local smallest capacity seconds stat=p50 operator=0 bulk=0 total
  [ "$ENLARGE_MAX_DISPATCHES" -gt 0 ] && operator=$((operator + 1))
  [ "$ENLARGE_BULK_MAX_DISPATCHES" -gt 0 ] && bulk=$((bulk + 1))
  if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then
    [ "$(shape_main_row ENLARGE_MAX_DISPATCHES)" -gt 0 ] && operator=$((operator + 1))
    [ "$(shape_main_row ENLARGE_BULK_MAX_DISPATCHES)" -gt 0 ] && bulk=$((bulk + 1))
  else
    [ "$(shape_row PREVIEW_SHAPE_DEFAULTS ENLARGE_MAX_DISPATCHES)" -gt 0 ] && operator=$((operator + 1))
    [ "$(shape_row PREVIEW_SHAPE_DEFAULTS ENLARGE_BULK_MAX_DISPATCHES)" -gt 0 ] && bulk=$((bulk + 1))
  fi
  [ $((operator + bulk)) -gt 0 ] || return 0
  smallest=$(upscale_smallest_size)
  seconds=$(upscale_p50 "$smallest")
  [[ "$seconds" =~ ^[1-9][0-9]*$ ]] || { seconds=$(upscale_p95 "$smallest"); stat=p95; }
  capacity=$(awk -v n="$((UPSCALE_MAX_INSTANCES * UPSCALE_CONCURRENCY))" -v s="$seconds" 'BEGIN{printf "%.4f", n / s}')
  total=$(awk -v r="$ENLARGE_DISPATCHES_PER_SECOND" -v o="$operator" -v b="$ENLARGE_BULK_DISPATCHES_PER_SECOND" -v k="$bulk" 'BEGIN{printf "%.4f", r * o + b * k}')
  if awk -v t="$total" -v c="$capacity" 'BEGIN{exit !(t > c)}'; then
    shape_fail "enlarge rates ENLARGE_DISPATCHES_PER_SECOND=$ENLARGE_DISPATCHES_PER_SECOND x $operator operator lanes + ENLARGE_BULK_DISPATCHES_PER_SECOND=$ENLARGE_BULK_DISPATCHES_PER_SECOND x $bulk bulk lanes = $total per second exceed what catalog-upscale finishes: $UPSCALE_MAX_INSTANCES x $UPSCALE_CONCURRENCY / $stat $seconds s of $smallest = $capacity per second"
  fi
}

# The measured-table name part of a GPU type: nvidia-rtx-pro-6000 -> NVIDIA_RTX_PRO_6000.
upscale_gpu_type_key() { local t=${UPSCALE_GPU_TYPE^^}; printf '%s' "${t//-/_}"; }

# upscale_gpu_p95 <size> / upscale_gpu_p50 <size>: the measured seconds of the current GPU type and concurrency, or nothing.
upscale_gpu_p95() {
  local name="UPSCALE_GPU_P95_S_$(upscale_gpu_type_key)_${UPSCALE_GPU_CONCURRENCY}CONC_$1"
  printf '%s' "${!name:-}"
}
upscale_gpu_p50() {
  local name="UPSCALE_GPU_P50_S_$(upscale_gpu_type_key)_${UPSCALE_GPU_CONCURRENCY}CONC_$1"
  printf '%s' "${!name:-}"
}

# 0 when this deploy runs catalog-upscale-gpu (not in a measure run, which changes only catalog-upscale).
upscale_gpu_deployed() { [ "$UPSCALE_GPU_SERVICE" = 1 ] && [ "$UPSCALE_MEASURE" != 1 ]; }

# Spec 18 GPU upscaler, called by shape_check (its shape_fail and ok): the catalog-upscale-gpu shape. Cloud Run's GPU
# shapes, the per-type GPU quota and the CPU and memory quotas of its region; a measured p95 for every probe size at
# exactly this (type, concurrency); a timeout that covers twice the largest probe size and the largest image the caps
# allow; and, with UPSCALE_TARGET=gpu, enlarge lanes and a rate sized to the GPU instances.
upscale_gpu_check() {
  if [ "$UPSCALE_TARGET" = gpu ]; then
    [ "$UPSCALE_GPU_SERVICE" = 1 ] || { shape_fail "UPSCALE_TARGET=gpu needs UPSCALE_GPU_SERVICE=1 (catalog-upscale-gpu deployed and its URL on the worker)"; return 0; }
    [ "$ENLARGE_CLIENT_WIRED" = 1 ] || { shape_fail "UPSCALE_TARGET=gpu needs a worker image with the spec 18 enlarge stage (ENLARGE_CLIENT_WIRED=1)"; return 0; }
  fi
  [ "$UPSCALE_GPU_SERVICE" = 1 ] || return 0
  # Spec 11's GPU path names its images with the same plain ids; two GPU upscalers must never share them.
  if [ "$UPSCALE_SERVICE" = gpu ]; then
    shape_fail "UPSCALE_SERVICE=gpu (the cut-out GPU upscales, spec 11) cannot run beside catalog-upscale-gpu: both make the plain upscaler ids. Set UPSCALE_GPU_SERVICE=0 with it"
    return 0
  fi
  local gib
  if [[ "$UPSCALE_GPU_MEMORY" =~ ^([1-9][0-9]*)Gi$ ]]; then gib=${BASH_REMATCH[1]}; else shape_fail "UPSCALE_GPU_MEMORY must look like 80Gi, got '$UPSCALE_GPU_MEMORY'"; return 0; fi
  # Cloud Run's GPU shapes (docs.cloud.google.com/run/docs/configuring/services/gpu, read 2026-10-30).
  case "$UPSCALE_GPU_TYPE" in
    nvidia-rtx-pro-6000)
      [ "$UPSCALE_GPU_CPU" -ge 20 ] || shape_fail "UPSCALE_GPU_CPU must be at least 20 with an RTX PRO 6000 (Cloud Run), got $UPSCALE_GPU_CPU"
      [ "$gib" -ge 80 ] || shape_fail "UPSCALE_GPU_MEMORY must be at least 80Gi with an RTX PRO 6000 (Cloud Run), got $UPSCALE_GPU_MEMORY" ;;
    nvidia-l4)
      [ "$UPSCALE_GPU_CPU" -ge 4 ] && [ "$UPSCALE_GPU_CPU" -le 8 ] || shape_fail "UPSCALE_GPU_CPU must be 4 to 8 with an L4, got $UPSCALE_GPU_CPU"
      [ "$gib" -ge 16 ] && [ "$gib" -le 32 ] || shape_fail "UPSCALE_GPU_MEMORY must be 16Gi to 32Gi with an L4, got $UPSCALE_GPU_MEMORY" ;;
    *) shape_fail "UPSCALE_GPU_TYPE must be nvidia-rtx-pro-6000 or nvidia-l4, got '$UPSCALE_GPU_TYPE'"; return 0 ;;
  esac
  [ "$UPSCALE_GPU_MAX_INSTANCES" -ge 1 ] || shape_fail "UPSCALE_GPU_MAX_INSTANCES must be at least 1"
  [ "$UPSCALE_GPU_CONCURRENCY" -ge 1 ] && [ "$UPSCALE_GPU_CONCURRENCY" -le 4 ] || shape_fail "UPSCALE_GPU_CONCURRENCY must be 1 to 4 (tiles run one at a time per instance), got $UPSCALE_GPU_CONCURRENCY"
  # Quotas. The GPU region must not be asia-south1, whose CPU sum above does not count this service (and which offers
  # neither GPU to this project). An L4 in the cut-out GPU's region shares its L4 quota.
  if [ "$UPSCALE_GPU_REGION" = "${REGION:-asia-south1}" ]; then
    shape_fail "UPSCALE_GPU_REGION=$UPSCALE_GPU_REGION is the main region; the GPU upscaler runs in its own region (asia-south2), whose quotas are counted here"
  fi
  if [ "$UPSCALE_GPU_TYPE" = nvidia-l4 ] && [ "$UPSCALE_GPU_REGION" = "${GPU_REGION:-asia-southeast1}" ]; then
    [ $((UPSCALE_GPU_MAX_INSTANCES + GPU_MAX_INSTANCES)) -le "$GPU_QUOTA" ] || shape_fail "UPSCALE_GPU_MAX_INSTANCES=$UPSCALE_GPU_MAX_INSTANCES + the cut-out GPU's $GPU_MAX_INSTANCES exceed the L4 quota of $GPU_QUOTA in $UPSCALE_GPU_REGION"
  else
    [ "$UPSCALE_GPU_MAX_INSTANCES" -le "$UPSCALE_GPU_QUOTA" ] || shape_fail "UPSCALE_GPU_MAX_INSTANCES=$UPSCALE_GPU_MAX_INSTANCES exceeds the $UPSCALE_GPU_TYPE quota of $UPSCALE_GPU_QUOTA in $UPSCALE_GPU_REGION (no zonal redundancy); file infra/request-gpu-upscale-quota.sh and raise UPSCALE_GPU_QUOTA once granted"
  fi
  [ $((UPSCALE_GPU_MAX_INSTANCES * UPSCALE_GPU_CPU)) -le "$UPSCALE_GPU_REGION_CPU_LIMIT" ] \
    || shape_fail "catalog-upscale-gpu at max instances takes $((UPSCALE_GPU_MAX_INSTANCES * UPSCALE_GPU_CPU)) vCPU, above $UPSCALE_GPU_REGION_CPU_LIMIT of the $UPSCALE_GPU_REGION quota"
  [ $((UPSCALE_GPU_MAX_INSTANCES * gib)) -le "$UPSCALE_GPU_REGION_MEMORY_GIB_LIMIT" ] \
    || shape_fail "catalog-upscale-gpu at max instances takes $((UPSCALE_GPU_MAX_INSTANCES * gib)) GiB, above $UPSCALE_GPU_REGION_MEMORY_GIB_LIMIT GiB of the $UPSCALE_GPU_REGION quota"
  [ "$UPSCALE_GPU_TIMEOUT_S" -ge 60 ] && [ "$UPSCALE_GPU_TIMEOUT_S" -le "$UPSCALE_TIMEOUT_MAX_S" ] \
    || shape_fail "UPSCALE_GPU_TIMEOUT_S must be 60 to $UPSCALE_TIMEOUT_MAX_S s (the enlarge task's deadline), got $UPSCALE_GPU_TIMEOUT_S"
  [ "$UPSCALE_GPU_COLD_START_S" -ge 1 ] && [ "$UPSCALE_GPU_COLD_START_S" -le "$UPSCALE_GPU_TIMEOUT_S" ] \
    || shape_fail "UPSCALE_GPU_COLD_START_S must be 1 to UPSCALE_GPU_TIMEOUT_S=$UPSCALE_GPU_TIMEOUT_S, got $UPSCALE_GPU_COLD_START_S"
  [[ "$UPSCALE_GPU_X4_TIME_RATIO" =~ ^[0-9]+([.][0-9]+)?$ ]] && awk -v r="$UPSCALE_GPU_X4_TIME_RATIO" 'BEGIN{exit !(r >= 1)}' \
    || { shape_fail "UPSCALE_GPU_X4_TIME_RATIO must be a number of at least 1, got '$UPSCALE_GPU_X4_TIME_RATIO'"; return 0; }
  # The measured table (no probe sizes is refused by upscale_check).
  [ -n "${UPSCALE_SIZES//[, ]/}" ] || return 0
  local size p95 missing="" largest worst=0 w h per_mp=0 cap est
  for size in ${UPSCALE_SIZES//,/ }; do
    p95=$(upscale_gpu_p95 "$size")
    if [ -z "$p95" ]; then missing+=" $size"; continue; fi
    [[ "$p95" =~ ^[1-9][0-9]*$ ]] || { shape_fail "UPSCALE_GPU_P95_S_$(upscale_gpu_type_key)_${UPSCALE_GPU_CONCURRENCY}CONC_$size=$p95 must be a whole number of seconds (rounded up)"; return 0; }
    w=${size%x*}; h=${size#*x}
    per_mp=$(awk -v p="$p95" -v n="$((w * h))" -v m="$per_mp" 'BEGIN{v = p / n * 1000000; printf "%.4f", (v > m ? v : m)}')
  done
  if [ -n "$missing" ]; then
    shape_fail "measure first: run infra/check-matting.sh --probe-upscale on catalog-upscale-gpu (no measured p95 for UPSCALE_GPU_TYPE=$UPSCALE_GPU_TYPE UPSCALE_GPU_CONCURRENCY=$UPSCALE_GPU_CONCURRENCY at$missing; UPSCALE_GPU_P95_S_* in infra/lib/shape.sh)"
    return 0
  fi
  [[ "$UPSCALE_GPU_MEASURED_ON" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || shape_fail "UPSCALE_GPU_MEASURED_ON must be the date of the probe the GPU rows come from, such as 2026-10-30"
  largest=$(upscale_largest_size)
  worst=$((2 * $(upscale_gpu_p95 "$largest")))
  [ "$UPSCALE_GPU_TIMEOUT_S" -ge "$worst" ] || shape_fail "UPSCALE_GPU_TIMEOUT_S=$UPSCALE_GPU_TIMEOUT_S is below 2 x the measured GPU p95 of $largest ($(upscale_gpu_p95 "$largest") s); set it to at least $worst"
  # The worker sends the GPU the same regions as the CPU (one cap per model, UPSCALE_MAX_PIXELS and _X4), so the
  # largest of each must finish within the GPU timeout too, at the slowest measured p95 per megapixel (x4 at
  # UPSCALE_GPU_X4_TIME_RATIO times it), twice over.
  local pair cap_name ratio
  local -a caps=("UPSCALE_MAX_PIXELS|1")
  [ "${UPSCALE_MODEL_X4:-swinir-x4}" = off ] || caps+=("UPSCALE_MAX_PIXELS_X4|$UPSCALE_GPU_X4_TIME_RATIO")
  for pair in "${caps[@]}"; do
    IFS='|' read -r cap_name ratio <<< "$pair"
    cap=${!cap_name}
    est=$(awk -v p="$cap" -v r="$per_mp" -v x="$ratio" 'BEGIN{v = p / 1000000 * r * x; c = int(v); if (c < v) c++; print c}')
    [ $((2 * est)) -le "$UPSCALE_GPU_TIMEOUT_S" ] || shape_fail "$cap_name=$cap needs a GPU timeout of 2 x about $est s = $((2 * est)) s ($per_mp s per megapixel measured $UPSCALE_GPU_MEASURED_ON), above UPSCALE_GPU_TIMEOUT_S=$UPSCALE_GPU_TIMEOUT_S"
  done
  [ "$UPSCALE_TARGET" = gpu ] || return 0
  # Spec 18 GPU upscaler, the lanes: with UPSCALE_TARGET=gpu new batches enlarge on the GPU, so the enlarge lanes of
  # both stacks never send more at once than catalog-upscale-gpu serves at once (a busy answer costs a photo one of its
  # attempts), and their rate stays within what it finishes at the smallest size's p50 (the p95 when no p50).
  local other
  if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then
    other=$(( $(shape_main_row ENLARGE_MAX_DISPATCHES) + $(shape_main_row ENLARGE_BULK_MAX_DISPATCHES) ))
  else
    other=$(( $(shape_row PREVIEW_SHAPE_DEFAULTS ENLARGE_MAX_DISPATCHES) + $(shape_row PREVIEW_SHAPE_DEFAULTS ENLARGE_BULK_MAX_DISPATCHES) ))
  fi
  local serves=$((UPSCALE_GPU_MAX_INSTANCES * UPSCALE_GPU_CONCURRENCY))
  if [ $((ENLARGE_MAX_DISPATCHES + ENLARGE_BULK_MAX_DISPATCHES + other)) -gt "$serves" ]; then
    shape_fail "enlarge slots $ENLARGE_MAX_DISPATCHES + $ENLARGE_BULK_MAX_DISPATCHES + the other stack's $other = $((ENLARGE_MAX_DISPATCHES + ENLARGE_BULK_MAX_DISPATCHES + other)) exceed what catalog-upscale-gpu serves at once ($UPSCALE_GPU_MAX_INSTANCES x $UPSCALE_GPU_CONCURRENCY); lower ENLARGE_MAX_DISPATCHES or ENLARGE_BULK_MAX_DISPATCHES"
  fi
  # The rate, as upscale_check counts it for the CPU: the SUM over every lane with slots, both stacks (the rates are
  # shared rows), the operator lanes at ENLARGE_DISPATCHES_PER_SECOND and the bulk lanes at
  # ENLARGE_BULK_DISPATCHES_PER_SECOND.
  local operator=0 bulk=0 smallest seconds stat=p50 capacity total
  [ "$ENLARGE_MAX_DISPATCHES" -gt 0 ] && operator=$((operator + 1))
  [ "$ENLARGE_BULK_MAX_DISPATCHES" -gt 0 ] && bulk=$((bulk + 1))
  if [ "${CATALOG_PREVIEW:-0}" = 1 ]; then
    [ "$(shape_main_row ENLARGE_MAX_DISPATCHES)" -gt 0 ] && operator=$((operator + 1))
    [ "$(shape_main_row ENLARGE_BULK_MAX_DISPATCHES)" -gt 0 ] && bulk=$((bulk + 1))
  else
    [ "$(shape_row PREVIEW_SHAPE_DEFAULTS ENLARGE_MAX_DISPATCHES)" -gt 0 ] && operator=$((operator + 1))
    [ "$(shape_row PREVIEW_SHAPE_DEFAULTS ENLARGE_BULK_MAX_DISPATCHES)" -gt 0 ] && bulk=$((bulk + 1))
  fi
  [ $((operator + bulk)) -gt 0 ] || return 0
  smallest=$(upscale_smallest_size)
  seconds=$(upscale_gpu_p50 "$smallest")
  [[ "$seconds" =~ ^[1-9][0-9]*$ ]] || { seconds=$(upscale_gpu_p95 "$smallest"); stat=p95; }
  capacity=$(awk -v n="$serves" -v s="$seconds" 'BEGIN{printf "%.4f", n / s}')
  total=$(awk -v r="$ENLARGE_DISPATCHES_PER_SECOND" -v o="$operator" -v b="$ENLARGE_BULK_DISPATCHES_PER_SECOND" -v k="$bulk" 'BEGIN{printf "%.4f", r * o + b * k}')
  if awk -v t="$total" -v c="$capacity" 'BEGIN{exit !(t > c)}'; then
    shape_fail "enlarge rates ENLARGE_DISPATCHES_PER_SECOND=$ENLARGE_DISPATCHES_PER_SECOND x $operator operator lanes + ENLARGE_BULK_DISPATCHES_PER_SECOND=$ENLARGE_BULK_DISPATCHES_PER_SECOND x $bulk bulk lanes = $total per second exceed what catalog-upscale-gpu finishes: $UPSCALE_GPU_MAX_INSTANCES x $UPSCALE_GPU_CONCURRENCY / $stat $seconds s of $smallest = $capacity per second"
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
