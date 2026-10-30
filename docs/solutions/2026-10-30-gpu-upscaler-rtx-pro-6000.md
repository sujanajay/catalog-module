# GPU upscaler on RTX PRO 6000 in asia-south2 (spec 18, 2026-10-30)

## Problem
AI enlargement on the CPU service `catalog-upscale` is reliable but slow: about 99 s per 800x1200 x2 photo and 216 s
p95 per 1600x1600, with concurrency 1 only (concurrency 2 was not deterministic). 7,000 products would take days. On
2026-10-30 the owner approved GPUs in asia-south2: speed matters a lot, cost does not, reliability is a must.

## What was measured (job `catalog-check-matting`, banded probe of #129)
- RTX PRO 6000 (Blackwell) loads the SwinIR ONNX models with the CUDA provider of ONNX Runtime GPU 1.23.2 (CUDA 12.8,
  cuDNN 9), Cloud Run driver 580. No L4 fallback was needed.
- Seconds per photo end to end, p50 / p95. Concurrency 1: x2 800x1200 1.1 / 1.2, x2 1600x1600 2.1 / 2.3, x4 800x1200
  1.4 / 2.8, x4 1600x1600 2.6 / 2.9. Concurrency 4: x2 3.3 / 3.4 and 6.7 / 6.9, x4 2.0 / 2.8 and 3.9 / 7.1. About
  90 times faster than the CPU per photo.
- Byte-identical outputs within an instance, across 4 instances and across 2 revisions, at concurrency 4.
- Cold start: about 42 s for a GPU instance to answer `/health` (the container itself was up 1.3 s), plus under 1 s
  to load x2 and about 3 s for x4. A fresh instance during the probe took 42 s and 91.5 s for its first call.

## Gotchas
- RTX PRO 6000 on Cloud Run needs at least 20 vCPU and 80 GiB per instance. `--no-gpu-zonal-redundancy` uses the
  smaller "no zonal redundancy" quota.
- The quota `NvidiaRtxPro6000GpuAllocNoZonalRedundancyPerProjectRegion` is counted in milli GPU: Google granted 3000
  (3 GPUs) in asia-south2 automatically on the first deploy. The increase to 6 is `infra/request-gpu-upscale-quota.sh`
  with preferred value 6000, not 6.
- The probe's x2 determinism round finished in seconds and stayed on one instance, so it proved nothing across
  instances. `infra/check-matting.sh --determinism-seconds N` keeps the round going for N seconds (the gate uses 600).
- The probe's cold-start method holds an instance busy with slow calls; at about 1 s per call it cannot, so the GPU
  row passes cold start 0 and the cold start is measured by hand (scale to zero, wait 25 min, time `/health`).
- The worker SA's project-level `roles/run.invoker` already covers a service in another region; no service-level
  grant was needed.
- CPU and GPU never mix inside a batch: the ids differ (`swinir-x2+cpu` against `swinir-x2`), and Start pins the
  target in `options.enlargement.target`. A worker without `UPSCALE_GPU_URL` refuses a GPU id instead of making it
  on CPU.

## Where
- Numbers: `services/matting/README.md` "Measured on RTX PRO 6000"; shape rows in `infra/lib/shape.sh`.
- Design and rollout: `docs/specs/18-reliable-enlargement.md` 3.7.
