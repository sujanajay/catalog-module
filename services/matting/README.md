# Matting service

Private byte-in, PNG-out FastAPI service. No bucket access, persistence, batching, image logging,
OpenRouter or UI. Cloud Run authenticates callers; localhost has no authentication edge.
`/matte` returns an 8-bit grayscale alpha mask (0 background, 255 product) at received dimensions.
`/convert` accepts HEIC/HEIF only and returns an oriented RGB/RGBA PNG at source resolution.
Both accept multipart `file`, limited to 40,000,000 bytes. `/health` returns loaded models, default,
target and the image's `GIT_SHA`. Every inference call uses an explicit session.

## Models and licences

| Served id | Input size | Licence | Source |
|---|---:|---|---|
| birefnet-general (default) | 1024 | MIT | [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) |
| birefnet-general-lite | 1024 | MIT | [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) |
| birefnet-hrsod | 1024 | MIT | [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) |
| bria-rmbg (RMBG 2.0) | 1024 | CC BY-NC 4.0 | [BRIA model card](https://huggingface.co/briaai/RMBG-2.0) |

The owner approved non-commercial model candidates for this internal tool in spec 08. These are
licence records. rembg itself is MIT. No custom sessions are included.

## Upscaling (`/upscale`)

`POST /upscale?model=<id>&scale=<2 or 4>` takes raw image bytes (`image/jpeg` or `image/png`) as the request
body; a multipart `file` field, as `/matte` takes, is also accepted. It returns `200 image/jpeg`
(quality 95, 4:4:4) at exactly the model's scale times the received pixel dimensions, with `X-Upscale-Model` (the
model used), `X-Upscale-Scale` and `X-Upscale-Ms` (tiling plus inference, excluding a first-use model load). Each
model has one scale (swinir-x2 2, swinir-x4 4); a model and scale that disagree are refused, and a scale alone picks
its model. Alpha is dropped and only RGB is upscaled; an embedded ICC profile is carried over; EXIF is
not, and orientation is not applied, so callers send upright pixels (as they do for `/matte`).
Errors are JSON `{"error": "..."}`: 400 for a bad image, unknown model, unsupported scale, more
than the model's pixel cap (`UPSCALE_MAX_PIXELS` for swinir-x2, `UPSCALE_MAX_PIXELS_X4` for swinir-x4, unset: the x2
cap; default 24,000,000) input pixels or an output side above 65,500 px (the JPEG limit);
413 over 40,000,000 bytes; 503 when the model is unavailable (CPU target, missing file, failed load or failed
determinism check); 500 for an unexpected inference error. Omitting both selects `health.upscale.default`.

`/health` adds `"upscale": {"models": [{"id", "available", "scale"}], "default": <id or null>}`;
the existing fields are unchanged. The CPU image reports every model unavailable and answers 503,
because CPU inference takes tens of seconds per tile; `UPSCALE_CPU=1` enables CPU execution for
tests and the Cloud Build smoke only.

| Served id | Tile (input) | Licence | Source checkpoint (sha256) |
|---|---:|---|---|
| swinir-x2 (default) | 384 | Apache-2.0 | [002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth](https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth) `193b229909ca89cd8b55de9c9e7fce146ae759d59dfcd78d8feb9dd1d6fa0fd7` |
| swinir-x4 | 384 | Apache-2.0 | [002_lightweightSR_DIV2K_s64w8_SwinIR-S_x4.pth](https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/002_lightweightSR_DIV2K_s64w8_SwinIR-S_x4.pth) `09fad24e32ae62722e1a055efde9921328f4137981bab0a42a4a3a806306c58e` |

Spec 18 quality (2026-10-29): Real-ESRGAN x2plus is no longer served (it lost the spec 11 fidelity gate on every
bar and nothing routes to it); the x4 model makes every enlargement above 2.0x in one pass. SwinIR
([repository](https://github.com/JingyunLiang/SwinIR), Apache-2.0) is the classical lightweight model (SwinIR-S,
DIV2K) at x2 and x4; SwinIR publishes no lightweight real-world checkpoint. Its architecture file is fetched from commit
`6545850fbf8df298df73d81f3e8cba638787c8bd` (`models/network_swinir.py`, sha256
`9e143898679ebeebc5d2fc94ad1b89c38aa4a4d43da4e0fcba0f93e476994913`) with the `lightweight_sr`
hyperparameters from `main_test_swinir.py`; its three timm helpers are replaced by inference-time
stand-ins (DropPath is the identity at inference).

The Dockerfile's `upscale-models` stage (Python 3.12, `requirements-convert.txt`: PyTorch 2.9.1 CPU,
onnx 1.19.1, ONNX Runtime 1.23.2) downloads the files from those URLs, fails the build on any
sha256 mismatch, exports fixed-shape fp32 ONNX (opset 17, TorchScript exporter), checks the ONNX
output against PyTorch (max abs difference under 2e-3) and runs it twice to require byte-identical output. The
swinir-x2 export of Cloud Build `bf4d6276-e221-4e92-8d18-7c30cc121198` has the sha256
`9f4a3f856ff12923e5b33f2965ed8ff7e360cb2f7ba9ed76ff04c59bf3021881`; the swinir-x4 export, made locally on
2026-10-29 with the same pinned tools (which reproduce the x2 sha256 above exactly), has
`f477a052442d29a47719fed951d26c7c6b1d67476ca9f4bd33a2604454fb03dd`. Their first 8 hex are
`UPSCALE_MODEL_VERSIONS` in `packages/core/src/catalog/upscale.ts` (part of render_key), so a changed export
must bump that map. The converter pins the same 8 hex (`EXPORT_SHA256_PREFIX` in `tools/convert_upscalers.py`) and
fails the build on any other export, so no render key can name an export that did not make the output; a pytest checks
both lists agree.
Only the ONNX files (about 11 MB each) reach the runtime images, under `/upscale-models`, read-only. Nothing is
downloaded at request time.

Tiling: the image is reflection-padded and cut into fixed tiles carrying 32 px of context on each
side; only each tile's centre is kept, so tiles abut exactly with no blending. An 800x1200 photo is
12 SwinIR tiles at either scale. Output is cropped to exactly 2x or 4x.

Determinism: fp32 throughout (fp16 was not adopted because its run-to-run determinism on the L4 has
not been verified); `SessionOptions.use_deterministic_compute`; CUDA `cudnn_conv_algo_search=HEURISTIC`
(the default EXHAUSTIVE benchmarks at load and can choose a different algorithm per process);
one tile at a time under the service's inference lock; fixed rounding to 8 bits; deterministic JPEG
encoding. On first load each model runs a fixed probe tile twice and is refused (503, reported
unavailable in health) if the two outputs differ in a single bit. The build smoke repeats the
check end to end over HTTP on CPU.

Memory and speed: models load on first request and then stay resident; matting model switches do
not release them. CUDA options cap each upscaler's arena at 6 GiB (`gpu_mem_limit`, kSameAsRequested,
no maximum cuDNN workspace). Estimated L4 use is about 1 to 2 GB for SwinIR at 384 px, alongside one resident
BiRefNet session, well inside 24 GB; this is an estimate, not a measurement. Measured on a Windows laptop CPU
(2026-10-29, 4 threads, through the service code): swinir-x4 at 1200x1600 took 199 s with a peak commit of 2851 MiB
(2685 MiB after loading, so about 86 B per input pixel for the x4 output and its buffers); x4 over x2 on the same
800x1200 image took 1.193x (pairs 1.283 and 1.133), and the 2026-10-29 bake-off (also laptop runs) timed x4 at
about the x2 time on the same region (51.0 s against 49.2 s). Since 2026-10-31 the deploy gate's probe checks the
x4 cap directly (`--x4-max-pixels`): 2 x `UPSCALE_MAX_PIXELS_X4` x the x4 model's slowest measured p95 seconds per MP
must fit the timeout, over the rounds and the 12 determinism calls on the service's own time (`X-Upscale-Ms`), with
one slow call of 10 or more set aside. It replaced a ratio of one x4 call over one x2 call, which refused a healthy
revision at 1.51 on 2026-10-30. Both models gave byte-identical outputs on a rerun and at 4 and 8 threads.

## Versions and offline models

CPU: Python 3.12, rembg 2.0.85 and ONNX Runtime 1.23.2. GPU: CUDA 12.8.1, cuDNN 9,
Ubuntu 24.04's Python 3.12 and ONNX Runtime GPU 1.23.2. The
[ORT compatibility matrix](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
requires CUDA 12.8 and cuDNN 9 for this pinned runtime. GPU startup verifies every session actually
has `CUDAExecutionProvider`; it fails instead of advertising CPU execution as GPU.

The installed rembg 2.0.85 source has `new_session(..., *, sess_opts=...)` and `rembg d <models...>`.
The Docker build verifies `rembg d --help` and downloads all four models with rembg's checksums.
This version stores files under `/models/models/<id>/<id>.onnx` (both `REMBG_HOME` and `U2NET_HOME`
are `/models`). Startup checks all selected files before invoking rembg, so a missing baked file
fails locally without attempting a runtime download. The runtime user cannot write `/models`.
The CLI extra constrains python-multipart to 0.0.21; requirements use that compatible version.

## Build and verify

From the repository root in PowerShell, with Docker Desktop running:

```powershell
docker build --target cpu --build-arg GIT_SHA=$(git rev-parse --short HEAD) -f services/matting/Dockerfile -t catalog-matting:cpu services/matting
docker build --target gpu --build-arg GIT_SHA=$(git rev-parse --short HEAD) -f services/matting/Dockerfile -t catalog-matting:gpu services/matting
docker run --rm --memory=16g --cpus=4 -p 8080:8080 catalog-matting:cpu
```

Both image builds run pytest in an intermediate stage. Endpoint tests mock inference but exercise
actual Pillow, HEIC decoding, multipart handling and error responses. The synthetic HEIC fixture
was generated with Pillow/pillow-heif; its orientation is normalized by the HEIF plugin. It contains
no user data. For real inference, from a second PowerShell with test dependencies installed:

```powershell
python services/matting/tests/container_smoke.py
```

The smoke checks four advertised models, real general/general-lite inference, foreground/background
alpha and HEIC conversion. It does not substitute mocked endpoint tests for model execution.

Build and test remotely using Git Bash, from the committed repository root:

```bash
bash infra/test-matting.sh
```

This submits `services/matting/cloudbuild-test.yaml`: CPU build, a CPU container advertising four models with one resident session,
real inference/conversion smoke, GPU build, then per-commit image pushes. No deployment occurs.
E2_HIGHCPU_32 supplies enough RAM for the 16 GiB container and exists only for the build. GPU images
can build without a GPU; actual CUDA inference requires an L4 and is a separate post-merge check.
The normal `cloudbuild.yaml` also builds both images.

## Memory, startup and deployment

Current deployment is conservatively 16 GiB, one resident session per service, intra-op threads 4, concurrency 1,
CPU 4 vCPU/max 20, GPU L4/4 vCPU/16 GiB/max 3, both min instances 0 and timeout 300s. GPU uses
instance-based billing (`--no-cpu-throttling`) as Cloud Run requires. Any shape beyond that (more resident
sessions, an arena cap, the session lock) is fitted from the measured table in "Measured on L4" below.

Build `2c0b868c-a590-4e8a-b187-e288f89ef079` measured four eager sessions at
4,622,376 KiB resident and startup 15,239 ms. Real general inference completed in 13,130 ms;
the subsequent lite inference killed the 16 GiB container (`OOMKilled=true`). Idle resident
memory did not predict retained inference workspace. CPU now preloads only the default model,
keeps one resident session, disables ONNX CPU arena and memory-pattern retention, and serializes
selection, loading and inference. It releases the previous session before allocating its replacement.
Health still advertises all four baked models. GPU now uses the same single-resident-session policy.
The deployed 100-photo benchmark `catalog-test-real-gktgl` subsequently exposed the same retention
problem on GPU: 100 general requests completed (686.85 ms inference average), but the first lite
request failed to allocate an 822,083,584-byte CUDA arena buffer. The client fell back to CPU and
the benchmark correctly rejected that target. GPU now releases its previous session before loading
a replacement and verifies CUDA on every newly loaded session. Actual post-fix GPU switching and
the complete benchmark remain pending; mocked lifecycle tests do not establish GPU memory use.

This changes the spec's initial four-eager or two-session alternatives based on actual memory
failures. Build `31868513-c828-4f71-848e-4934547b8a68` passed general/lite/general switching at
the same 16 GiB limit without an OOM kill: peak 8,052,648 KiB (7.68 GiB). Keep CPU at 16 GiB
for headroom; this short smoke does not establish sustained or all-model peak memory.

### Spec 16: resident models and the lock (2026-10-27)

- `MAX_RESIDENT_SESSIONS` (default 1, the policy above) keeps that many cut-out sessions loaded, least recently
  used first. A switch with the map full releases only the oldest session (and collects it) before loading.
  Spec 16 runs the GPU service at 3 and the CPU service at 1.
- On the GPU every cut-out session gets the CUDA option `arena_extend_strategy=kSameAsRequested`, and
  `gpu_mem_limit` when `GPU_MEM_LIMIT_BYTES` is set (spec 16: 6 GiB, so 3 sessions stay under 18 GiB of the L4's
  24 GB). This is the guard against the 822 MB arena failure above. On 2026-10-27 that shape failed every
  bria-rmbg call (its arena grew past the 6 GiB cap at 1024 px) and was rolled back to one resident session; spec 17
  replaces "measure in the first run after deploy" with the probe and the refusals below.
- `INFERENCE_LOCK` is held only around ONNX session runs (each session's `inner_session` is wrapped so its `run`
  takes the lock; rembg 2.0.85 calls it inside `predict`) and around loading or evicting a session. Decode,
  rembg's resize and post-processing, the resize back and the PNG encode run outside it, so with
  `--concurrency=2` one request's CPU work overlaps the other's inference. An upscale takes the lock per tile.
- A request that already holds a session evicted by another request finishes with it; that session's memory goes
  when the request ends, so for a moment one more session than `MAX_RESIDENT_SESSIONS` can be alive.
- `/health` adds `resident` (loaded ids, most recent last), `maxResident` and `gpuMemory` (`usedMiB`, `totalMiB`
  from `nvidia-smi`, cached 10 s; null on CPU or when it cannot be read).
- The CPU service serves `/upscale` when `UPSCALE_CPU=1`; spec 16 sets it there so the GPUs do only cut-outs.
- Batching several photos into one GPU call is not done: the baked cut-out exports take a batch of 1.

Measurement procedure: Cloud Build switches CPU general/lite/general while all four models remain supported, captures `session_ready`
logs with actual providers and process resident/high-water KiB, captures `sessions_ready startup_ms`,
then executes the real smoke and `docker stats --no-stream`. The smoke prints version,
wait-to-health milliseconds and per-model `x-ms`. Record these numbers in the execution report
before accepting the final memory choice. App startup measures session loading; smoke wait includes
container/process readiness. The successful build measured session loading at 7,195 ms and
wait-to-health at 64,094 ms. Synthetic general/lite/general requests took 25,509 / 13,925 / 19,279 ms
(including model switching where needed); HEIC conversion took 3 ms. Both CPU and GPU image targets
built, passed 13 Python tests each, and were published as tag `3d03413`. These are synthetic smoke
measurements, not the required 100-photo benchmark. Actual L4 inference and memory, the full real
datasets and image-size measurements remain pending. No actual inference measurements are claimed
by mocked tests.

The client timeout defaults to 180,000 ms, retaining environment and per-client overrides. This
provides headroom above the measured 64,094 ms CPU readiness delay while staying below the
300-second Cloud Run request timeout. The measurement identifies a startup headroom gap in the
former 60,000 ms default; it does not establish a deployed Cloud Run failure.

`infra/deploy.sh` deploys CPU in asia-south1 and GPU in asia-southeast1 before updating worker URLs.
Both are private under `catalog-matting@`; worker already has project-level run.invoker from
bootstrap. Region-aware checks retain the existing private-service IAM pattern. Only GPU quota
refusal permits CPU-only continuation; other errors stop. Refused GPU deployment never forwards
an older GPU URL into the worker's replacement environment. No production deployment occurs
before the human's separate merge decision.

### Spec 17: knobs, health and the probe (2026-10-28)

Each knob is an env var whose unset value is the behaviour before spec 17, so one candidate moves one knob:

- `CUDNN_CONV_ALGO_SEARCH` (`DEFAULT | HEURISTIC | EXHAUSTIVE`) and `CUDNN_CONV_USE_MAX_WORKSPACE` (`0 | 1`) are passed
  to the CUDA provider of every cut-out session when set, as the upscaler already does. Unset keeps ONNX Runtime's
  defaults (EXHAUSTIVE, maximum workspace since 1.14). A value outside the list stops the service at startup.
- `INFERENCE_LOCK_SCOPE` (`global`, default, or `session`). With `session` each cut-out session has its own run lock,
  so two different models may run at once (ONNX sessions are thread-safe for `run`); loads, evictions and upscale
  tiles keep the global lock, but a load may then overlap another model's run, so the probe measures it before it
  goes live.
- `/health` adds `residentModels` (same as `resident`), `arenaBytesByModel` (empty: ONNX Runtime's Python API 1.23
  exposes no per-session arena statistics), `candidate` (Cloud Run's `K_REVISION`), `lockScope`, `instanceId` (random
  per process) and `loadsByModel` (cut-out session loads since start). `/health?fresh=1` reads `gpuMemory` past its
  10 s cache.

The probe (`bash infra/check-matting.sh --probe <url> --models <list> --concurrency <n> --rounds <k>`, run as the
Cloud Run job `catalog-check-matting`) calls one URL, usually the GPU candidate's tag URL (the ID token's audience is
the service URL, also for a tag URL): per model one warm call at 1024 px, then `n` calls at once for `k` rounds,
then the switching order birefnet-general, bria-rmbg, birefnet-general-lite, birefnet-hrsod, birefnet-general, with
`/health?fresh=1` before the first call (the baseline) and after every step. It prints `model | peak VRAM used (MiB) |
p50 ms | p95 ms | non-200 | loads`, writes the JSON report to
`gs://image-links-agent-assets/catalog-test/probe/<execution>/probe.json` and fails on any non-200, on a `/health` it
cannot read (or one without `instanceId`, `loadsByModel` or, on the GPU, `gpuMemory`), and on more than one load of a
model on one instance while that instance keeps every probed model resident (`maxResident` at least the number of
models). With fewer resident sessions the switching order must reload, so loads are reported, not failed; today's
shape (one resident) therefore passes when every call answers 200. Loads are counted from the baseline, so loads
before the probe do not count; they come from each instance's `loadsByModel`, so run the probe against a revision
with max-instances 1 (or read the per-instance rows in the JSON) to see every instance. p50 and p95 are client-side
times of the measured rounds (warm and switching calls excluded). Peak VRAM is `nvidia-smi` for the whole card after
the step, so it includes the CUDA context and every resident model: the per-model peaks for `infra/lib/shape.sh` come
from a one-resident run (the previous model is released before the next loads), where they include the context
once. `shape.sh` adds `GPU_CUDA_OVERHEAD_MIB` on top, which counts the context again: deliberately conservative.

## Measured on L4

Measured 2026-10-28 with `infra/check-matting.sh --probe` (spec 17 3.3.4), image `matting-gpu:ea22854`, one L4,
4 vCPU, 16 GiB, 1024 px probe image, the global lock. Peak VRAM is `nvidia-smi` for the whole card after each step
(CUDA context included). p50 and p95 are client times from the probe job in asia-south1 to the service in
asia-southeast1 (upload, inference, PNG back), measured rounds only. Loads are per instance from the baseline; with
fewer resident sessions than models the switching order must reload, so loads are reported, not failed. JSON reports:
`gs://image-links-agent-assets/catalog-test/probe/gpu17-*/probe.json`.

Rung 1, the live revision `catalog-matting-gpu-00033-mug` (1 resident, no cap, ONNX Runtime's cuDNN defaults:
EXHAUSTIVE, maximum workspace), service URL. Concurrency 1, 20 rounds, one instance:

| model | peak VRAM used (MiB) | p50 ms | p95 ms | non-200 | loads |
|---|---:|---:|---:|---:|---:|
| birefnet-general | 13694 | 758 | 890 | 0 | 2 |
| birefnet-general-lite | 10840 | 517 | 586 | 0 | 2 |
| birefnet-hrsod | 13694 | 804 | 823 | 0 | 2 |
| bria-rmbg | 12422 | 728 | 786 | 0 | 2 |

Rung 1, same revision, concurrency 2, 10 rounds (the service takes one request per instance, so a second instance
started during the run; p95 includes the queueing):

| model | peak VRAM used (MiB) | p50 ms | p95 ms | non-200 | loads |
|---|---:|---:|---:|---:|---:|
| birefnet-general | 13694 | 801 | 1459 | 0 | 2 |
| birefnet-general-lite | 10840 | 566 | 920 | 0 | 2 |
| birefnet-hrsod | 13694 | 858 | 1523 | 0 | 2 |
| bria-rmbg | 12422 | 776 | 1471 | 0 | 1 |

Rung 2, candidate `catalog-matting-gpu-00036-tag` (rung 1 + `CUDNN_CONV_ALGO_SEARCH=HEURISTIC`,
`CUDNN_CONV_USE_MAX_WORKSPACE=0`, max 1 instance, no traffic). Concurrency 1, 20 rounds:

| model | peak VRAM used (MiB) | p50 ms | p95 ms | non-200 | loads |
|---|---:|---:|---:|---:|---:|
| birefnet-general | 13704 | 759 | 823 | 0 | 2 |
| birefnet-general-lite | 10842 | 461 | 524 | 0 | 2 |
| birefnet-hrsod | 13696 | 749 | 872 | 0 | 2 |
| bria-rmbg | 12424 | 725 | 847 | 0 | 2 |

The cuDNN knob moved no memory (within 10 MiB) and cut p50 by 0 to 11% (general-lite most). So the arena is the
model's activations at 1024 px, not the cuDNN workspace. Each model's arena grows on its second call: the first call
leaves about 9.1 GiB on the card (general), the second about 13.7 GiB, then it stays flat.

Rung 3, candidate `catalog-matting-gpu-00037-nef` (rung 2 + `MAX_RESIDENT_SESSIONS=2`, no cap, max 1 instance, no
traffic). Concurrency 1, 20 rounds, all four models:

| model | peak VRAM used (MiB) | p50 ms | p95 ms | non-200 | loads |
|---|---:|---:|---:|---:|---:|
| birefnet-general | 18008 | 769 | 901 | 0 | 2 |
| birefnet-general-lite | 19938 | 476 | 600 | 0 | 2 |
| birefnet-hrsod | 19930 | 776 | 833 | 0 | 2 |
| bria-rmbg | 21634 | 722 | 794 | 0 | 1 |

Rung 3, every pair of models resident together, both run for at least 10 rounds (card total after the pair's
steps): general + lite 19,938; general + hrsod 18,008; general + bria-rmbg 21,328; lite + hrsod 19,930; lite +
bria-rmbg 19,764; hrsod + bria-rmbg 21,634 MiB. All calls answered 200. Two resident models take far less than the
sum of their one-resident peaks (general + hrsod: 18,008, not 26,000), so the one-resident peaks in `shape.sh`
overstate what a second model adds in the probe. But the probe under-covers real traffic: the spec 10 eval run
against this candidate (`evals-20261028170223-eb3fd5`, real golden photos, the bake-off switching all four models)
got 8 HTTP 500s in 349 calls, each an ONNX BFC arena allocation failure in birefnet-general or birefnet-hrsod while
another model was resident. Rung 3 is therefore not safe, and `shape.sh` keeps the one-resident peaks and refuses
it (2 x 13,704 + 2,048 = 29,456 MiB).

Rung 4 (all four resident) does not fit: by the one-resident peaks 4 x 13,704 + 2,048 = 56,864 MiB; even by the probe
pairs a second model adds 4,304 to 7,938 MiB to the first one's peak, so four would need about 13,704 + 3 x 6,000
MiB, over the card, and two already failed under real traffic. Rung 5 needs rung 4. Rung 6 (two GPU services
split by model group) was not built: it needs a second service and the owner's go-ahead (spec 17 owner decision 3).

The measured peaks (the larger of rungs 1 and 2) are `GPU_MODEL_PEAK_MIB_*` with `GPU_MEASURED_ON=2026-10-28` in
`infra/lib/shape.sh`, whose refusals fit the shape: a cap below a model's peak + 512 MiB (the 2026-10-27 F2 shape:
6,144 MiB is below bria-rmbg's 12,424 + 512), more resident memory than 22,528 MiB, or a listed model with no peak
("measure first: run infra/check-matting.sh --probe"). Today's shape (one resident, no cap, the global lock) is not
asked for measurements. The upscalers were not measured (they run on the CPU service).

## Measured on RTX PRO 6000

Spec 18 GPU upscaler (owner approved 2026-10-30: enlargement on GPUs in asia-south2; speed matters, reliability is a
must). The dedicated service `catalog-upscale-gpu` runs the `matting-gpu` image (CUDA 12.8, cuDNN 9, ONNX Runtime GPU
1.23.2) on one NVIDIA RTX PRO 6000 (Blackwell) per instance in asia-south2: 20 vCPU, 80 GiB (the Cloud Run minimum
for this GPU), no zonal redundancy, no CPU throttling, `MAX_RESIDENT_SESSIONS=1`, `PRELOAD_MATTE=0`. The models load
on Blackwell with the CUDA provider; no fallback to L4 was needed. `infra/lib/shape.sh` refuses the service without
its measured rows (`UPSCALE_GPU_P95_S_*` / `UPSCALE_GPU_P50_S_*`, whole seconds rounded up,
`UPSCALE_GPU_MEASURED_ON=2026-10-30`).

Measured 2026-10-30 with `infra/check-matting.sh --probe-upscale` (job `catalog-check-matting`, banded comparison of
#129), seconds per photo end to end from the job in asia-south1, p50 / p95:

| model | size | concurrency 1 | concurrency 4 (chosen) |
|---|---|---|---|
| swinir-x2 | 800x1200 | 1.1 / 1.2 | 3.3 / 3.4 |
| swinir-x2 | 1600x1600 | 2.1 / 2.3 | 6.7 / 6.9 |
| swinir-x4 | 800x1200 | 1.4 / 2.8 | 2.0 / 2.8 |
| swinir-x4 | 1600x1600 | 2.6 / 2.9 | 3.9 / 7.1 |

Runs `gpu18-rtx-probe1` (execution `catalog-check-matting-rxfs8`) and `gpu18-rtx-probe2-c4` (execution
`catalog-check-matting-26w29`). Inference alone is about 0.8 s for an 800x1200 x2 photo; the GPU runs one tile at a
time under the inference lock, so concurrency 4 queues requests on the instance (latency rises, throughput per
instance stays about one photo per second at 800x1200). The output matches a Lanczos resize at 43.2 dB PSNR (a sanity
check that the model works, not a quality gate).

Determinism: byte-identical outputs within and across instances and across two revisions (4 instances; sha256
prefixes x2 800 `44b4359b23355ffb`, x2 1600 `948fd06e4e168ff9`, x4 800 `de3f015e185a44e9`, x4 1600
`b7af22c3d791da47`). Unlike CPU concurrency 2, GPU concurrency 4 stays deterministic, because inference is serialised
by the lock and cuDNN runs with deterministic, heuristic algorithm choice. The probe's x2 determinism round could stay
on one instance when calls take a second; `--determinism-seconds` keeps it running until the budget ends (the deploy
gate passes 600) so it reaches other instances.

Cold start (scaled to zero, then one call): `/health` answered after 41.9 s (instance uptime 1.3 s, so most of it is
the GPU instance start), the first x2 call took 0.5 s more, the first x4 3.1 s, and a warm x2 1.3 s. Two fresh
instances during the probe answered their first call after 42 s and 91.5 s end to end. `UPSCALE_GPU_COLD_START_S` is
180 (about twice the slowest). The probe's hold method for the cold start cannot work when a call takes about one
second, so the deploy gate passes cold start 0 for this service and these numbers are measured by hand.

Quota: Google granted 3 GPUs (3000 milli GPU, `NvidiaRtxPro6000GpuAllocNoZonalRedundancyPerProjectRegion`) in
asia-south2 on the first deploy. `UPSCALE_GPU_MAX_INSTANCES=3`, `UPSCALE_GPU_CONCURRENCY=4`; the increase to 6 GPUs is
`infra/request-gpu-upscale-quota.sh`.

## Measured on CPU

Spec 18 H1. Measured on Cloud Run on 2026-10-29 (the ladder below). Spec 16 assumed 5.9 to 7.8 s per 800x1200
photo; on 2026-10-29 one took about 121 s on the 4 vCPU catalog-matting service under load, so nothing is sized from
an estimate: the dedicated enlargement service `catalog-upscale` is refused by `infra/lib/shape.sh` ("measure first")
unless its shape has a row here and in `UPSCALE_P95_S_*` / `UPSCALE_P50_S_*` there (whole seconds, rounded up, with
`UPSCALE_MEASURED_ON=2026-10-29`).

Knobs (each env var's unset value is the behaviour before spec 18):

- `ORT_INTRA_OP_THREADS` (default 4, 1 to 64): ONNX Runtime intra-op threads of every session, cut-outs and
  upscalers. `catalog-upscale` sets it from `UPSCALE_THREADS`.
- `PRELOAD_MATTE` (default 1): 0 loads no cut-out model at start, so `catalog-upscale` holds only the upscaler (a
  `/matte` call there would still load its model on demand).
- `/health` adds `vcpu` (the container's cgroup v2 CPU quota, else the cgroup v1 quota, else the CPUs it may run
  on), `threads`, `preloadMatte` and `upscaleTiles` (the tile of each loaded upscaler). `/health` never takes the
  inference lock, so it answers while an upscale runs. Caveat: on 2026-10-29 the 4 vCPU revisions reported `vcpu` 8
  (no quota was visible in the container, so it fell back to the host's CPUs), and the probe copies that value into
  its vCPU column. `vcpu` is informational only: the configured `--cpu`, `UPSCALE_CPU_VCPU` in `infra/lib/shape.sh`,
  is the source of truth, and the table below gives the configured value. The cgroup v1 fallback was added after the
  ladder and is not yet verified on Cloud Run.

The probe: deploy a candidate of one shape, then time it. `UPSCALE_MEASURE=1 bash infra/deploy.sh` deploys ONLY
`catalog-upscale`: it builds only the matting image (if this commit has none), skips migrations and queues, reuses
catalog-matting, catalog-matting-gpu, catalog-worker and catalog-web as they are, never rebuilds the worker's env,
prints the candidate URL and the probe command, and stops before the worker and web gates. A measure rung never needs a
new worker image, and the worker keeps calling whatever its `UPSCALE_URL` names. Each rung is tagged
`measure-<cpu>c-<threads>t-<concurrency>r`, so every rung keeps its own URL. Rung 1 of a brand-new `catalog-upscale`
serves the service URL, because Cloud Run cannot create a service with `--no-traffic`; nothing calls it. The deploy
gate never tags a measure rung `previous`, never treats a live measure rung as a SKIP match (the first dedicated
deploy still runs its two-size probe), and `--rollback` returns to a measure rung only when it is named.

CPU quota: asia-south1 allows 190 of its 200 vCPU here. On 2026-10-29 the shape counted 171 (worker 24 x 4,
catalog-matting 16 x 4, web and jobs 11), so the ladder ran with `UPSCALE_MAX_INSTANCES` at most 4 at 4 vCPU
(171 + 16 = 187) and at most 2 at 8 vCPU (171 + 16 = 187). The dedicated shape chosen from it (spec 18 section 8)
lowers `MATTING_CPU_MAX_INSTANCES` from 16 to 4: 96 + 16 + 16 x 4 + 11 = 187. A measure rung deploys a candidate
of the same service while the live revision keeps its own max instances, so once the dedicated shape is live
`shape_check` counts both (`UPSCALE_LIVE_VCPU`, 64): with 3 vCPU to spare, a new rung needs a smaller live
`UPSCALE_MAX_INSTANCES` first.

Since 2026-10-30 the asia-south1 quotas are 400 vCPU and 800 GiB, and `catalog-upscale` runs 50 x 4 vCPU / 8Gi (spec
18 section 8, scale-out). `shape_check` now counts every service in the region at max instances, for CPU and for
memory: both catalog stacks, the jobs and 24 vCPU / 24 GiB for the other apps (ila, npd). With 374 of 376 vCPU used,
a measure rung beside the live 200 vCPU (`UPSCALE_LIVE_VCPU`, and `UPSCALE_LIVE_GIB` 400) still needs a smaller live
`UPSCALE_MAX_INSTANCES` first.

How the ladder was run (2026-10-29, the shape defaults then had `UPSCALE_SERVICE=cpu`; since the dedicated shape is
the default, a measure run must say `UPSCALE_SERVICE=cpu` too, because measure mode refuses `dedicated`. It still
changes only `catalog-upscale`: the worker's env is not rebuilt, so it keeps calling what its `UPSCALE_URL` names):

```bash
# Git Bash, repo root. The four rungs (one at a time; each prints UPSCALE_CANDIDATE_URL and its probe line).
UPSCALE_SERVICE=cpu UPSCALE_MEASURE=1 UPSCALE_CPU_VCPU=4 UPSCALE_THREADS=4 UPSCALE_CONCURRENCY=1 UPSCALE_MAX_INSTANCES=4 bash infra/deploy.sh
UPSCALE_SERVICE=cpu UPSCALE_MEASURE=1 UPSCALE_CPU_VCPU=4 UPSCALE_THREADS=4 UPSCALE_CONCURRENCY=2 UPSCALE_MAX_INSTANCES=4 bash infra/deploy.sh
UPSCALE_SERVICE=cpu UPSCALE_MEASURE=1 UPSCALE_CPU_VCPU=8 UPSCALE_THREADS=8 UPSCALE_CONCURRENCY=1 UPSCALE_MAX_INSTANCES=2 bash infra/deploy.sh
UPSCALE_SERVICE=cpu UPSCALE_MEASURE=1 UPSCALE_CPU_VCPU=8 UPSCALE_THREADS=8 UPSCALE_CONCURRENCY=2 UPSCALE_MAX_INSTANCES=2 bash infra/deploy.sh
# The probe deploy.sh prints for a rung (its candidate URL and its concurrency filled in; the ladder ran with the
# 840 s timeout of that day, today's default prints 1740):
bash infra/check-matting.sh --probe-upscale <candidate URL> --model=swinir-x2 --sizes=800x1200,1600x1600 --concurrency=<1 or 2> --rounds=3 --timeout=840
```

Spec 18 quality: the probe now takes `--model=swinir-x2,swinir-x4` (the deploy gate always passes both), times each
model in turn and requires each model's answers to be its exact scale and byte-identical on a rerun. The p95 rows
are of swinir-x2; `UPSCALE_X4_TIME_RATIO` (1.7 since 2026-10-31: Cloud Run gate probes timed x4 at up to 1.45 x the
x2 rows' time per MP) scales them for x4 when shape.sh sizes the x4 cap, and the gate checks that cap on the measured
x4 calls.

`UPSCALE_SERVICE=dedicated` (the worker's enlargements on `catalog-upscale`) needs a worker image with the spec 18 H3
enlarge stage (`apps/worker/src/catalog/enlarge.ts` calls the service through `packages/core/src/catalog/enlarge.ts`;
the render reads the stored x2 only). `ENLARGE_CLIENT_WIRED` defaults to 1; a deploy of an older worker image sets it
to 0 and `shape.sh` then refuses dedicated.

It runs `services/matting/tests/cloudrun_check.py --probe-upscale` as the Cloud Run job `catalog-check-matting`: per
size one warm call (it loads the model; not measured), then `concurrency` calls at once for `rounds` rounds, with a
synthetic product-like JPEG of that size. p50, p95 and max are client seconds of the measured rounds (upload,
tiling and inference, JPEG back). Every answer must be a JPEG of exactly twice the size, and every answer for one
size must have the same bytes (the output sha256; a thread count that changes it bumps the upscaler's version). The
JSON report goes to `gs://image-links-agent-assets/catalog-test/probe/<execution>/upscale.json`. Ladder: 4 vCPU / 4
threads and 8 vCPU / 8 threads, each at concurrency 1 and 2, both sizes.

2026-10-29, model swinir-x2, tile 384, one warm call then 3 rounds per size (4 calls per size at concurrency 1, 7 at
concurrency 2). vCPU is the configured `--cpu` (`/health` reported 8 on the 4 vCPU rungs, see the caveat above).
JSON: `gs://image-links-agent-assets/catalog-test/probe/<execution>/upscale.json`.

| rung | size | vCPU | threads | tile | conc | p50 s | p95 s | max s | non-200 | output sha256 | probe execution |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| 1 | 800x1200 | 4 | 4 | 384 | 1 | 99.0 | 99.5 | 99.5 | 0 | f730fb0abc8cd7ba987a96cd0485a1c4d888f420edbf4ac082b603d7ece370c9 | catalog-check-matting-92wz6 |
| 1 | 1600x1600 | 4 | 4 | 384 | 1 | 215.0 | 215.6 | 215.6 | 0 | b8fbeeefdb0eb4250058dc3fe59a98d238f2939de7b94de1694d05d8219a493c | catalog-check-matting-92wz6 |
| 2 | 800x1200 | 4 | 4 | 384 | 2 | 125.6 | 259.6 | 259.6 | 0 | NOT deterministic: 2 distinct outputs in 7 calls | catalog-check-matting-mgkgs |
| 2 | 1600x1600 | 4 | 4 | 384 | 2 | 493.3 | 520.8 | 520.8 | 0 | NOT deterministic: 2 distinct outputs in 7 calls | catalog-check-matting-mgkgs |
| 3 | 800x1200 | 8 | 8 | 384 | 1 | 77.4 | 79.2 | 79.2 | 0 | f730fb0abc8cd7ba987a96cd0485a1c4d888f420edbf4ac082b603d7ece370c9 | catalog-check-matting-bqqdn |
| 3 | 1600x1600 | 8 | 8 | 384 | 1 | 158.7 | 164.3 | 164.3 | 0 | b8fbeeefdb0eb4250058dc3fe59a98d238f2939de7b94de1694d05d8219a493c | catalog-check-matting-bqqdn |
| 4 | 800x1200 | 8 | 8 | 384 | 2 | 78.3 | 102.4 | 102.4 | 0 | NOT deterministic: 2 distinct outputs in 7 calls | catalog-check-matting-6h62d |
| 4 | 1600x1600 | 8 | 8 | 384 | 2 | 167.3 | 341.4 | 341.4 | 0 | NOT deterministic: 2 distinct outputs in 7 calls | catalog-check-matting-6h62d |

Determinism: rungs 1 and 3 gave one output per size, the same bytes at 4 and 8 threads, so the thread count does not
change the output and `UPSCALER_VERSION` needs no bump. Rungs 2 and 4 (container concurrency 2) gave two different
outputs for the same input, and the rung 2 gate probe (catalog-check-matting-lkkds) already did so on two sequential
calls that landed on two instances. Cause not proven: the leading guess is instances on different host CPUs (a
different SIMD path in ONNX Runtime rounds floats differently); the probe records neither the sha256 nor the instance
per call, so the next probe change should log both. `infra/lib/shape.sh` therefore refuses `UPSCALE_CONCURRENCY` above
1 for the dedicated service ("measure and prove determinism before raising"). Concurrency 1 is deterministic in these
runs, not proven deterministic on every host.

The shape chosen (spec 18 section 8, spec 18 quality): 16 x 4 vCPU, 16 GiB, 4 threads, concurrency 1,
`UPSCALE_TIMEOUT_S=1740`, and one pixel cap per model (2026-10-29 review): `UPSCALE_MAX_PIXELS=5400000` for x2 and
`UPSCALE_MAX_PIXELS_X4=4900000` for x4 (8 MP and 6.4 MP until 2026-10-31, when Cloud Run gate times showed x2 at up
to 158 s per MP and x4 at up to 151 s per MP, so 2 x 8 x 158 = 2533 s and 2 x 6.4 x 151 = 1936 s did not fit). A
region above its model's cap is made in tiles under the cap by the worker, never held for its size.

| rule (infra/lib/shape.sh upscale_check) | arithmetic | result |
|---|---|---|
| timeout covers the largest x2 image | 2 x ceil(5.4 MP x 104.17 s per MP x 1.52) = 2 x 856 s | 1712 s <= 1740 s |
| the same on the measured x2 calls (deploy gate) | 2 x 5.4 MP x the x2 p95 per MP (158.33 s on 2026-10-30) = 1710 s | at most 161.1 s per MP |
| timeout covers the largest x4 image | 2 x ceil(4.9 MP x 104.17 s per MP x 1.7) = 2 x 868 s | 1736 s <= 1740 s |
| the same on the measured x4 calls (deploy gate) | 2 x 4.9 MP x the x4 p95 per MP (151.25 s on 2026-10-30) = 1482 s | at most 177.5 s per MP |
| x4 at an 8 MP cap | 2 x ceil(8 MP x 104.17 x 1.7) = 2 x 1417 s | 2834 s, refused |
| x4 memory of the largest image under 80% of 8 GiB (16 GiB until 2026-10-30) | 4096 MiB resident + 4.9 MP x 160 B | 4844 MiB <= 6553 MiB |
| x4 output size (sharp's default input limit 268,402,689 px) | 4.9 MP x 16 | 78.4 MP |
| deploy probe budget, both models, both sizes | 300 + 4 x (100 + 130) + 4 x (216 + 281) | 3208 s |

The timeout must cover the largest image the service takes, not only the probe sizes: SwinIR is tiled, so time grows
with pixels, and the slowest measured p95 per pixel (100 s for 0.96 MP, 104.2 s per MP) is scaled by
`UPSCALE_X4_TIME_RATIO` for the x4 model. Spec 18 quality sends only the product's region (its box plus 32 px), so the
limit bounds the region; a region needs enlarging only when it is smaller than the channel's canvas (at most
3000x3000). 1740 s is the most one enlarge task allows (its 1800 s dispatch deadline less two 30 s margins); the 24
MP service default would need about 6500 s. Per photo, 4 vCPU costs 4 x 99 = 396 vCPU-s against 8 x 77.4 = 619 for
8 vCPU, and within the same 64 vCPU 16 x 4 finishes about 1.5x the photos per hour of 8 x 8 (about 580 against 370
photos of 800x1200 per hour). The enlarge queue rate follows: 2 lanes x `ENLARGE_DISPATCHES_PER_SECOND` 0.075 =
0.15 per second <= 16 x 1 / p50 99 s = 0.16. Since the 2026-10-30 scale-out (50 instances, live hourly p99 memory 2.9
GiB, so 8Gi each): the bulk lane has 44 slots at its own `ENLARGE_BULK_DISPATCHES_PER_SECOND` 0.42 and the operator
lanes (production and preview) 0.04 each; the sum, 0.50 per second, is within 50 x 1 / 99 s = 0.505.

## Host verification limitations

On 2026-10-18 Docker Desktop 4.86.0 could not initialize its Inference manager: the
`dockerInference` Unix listener path could not be accessed before the Linux engine started.
This matches [Docker issue 625](https://github.com/docker/desktop-feedback/issues/625) and
[issue 460](https://github.com/docker/desktop-feedback/issues/460). No reset or global file deletion
was performed. Local container checks remain pending host repair. The Cloud Build real-container
smoke supplies Linux image evidence while this local limitation remains explicitly reported.
Windows Python's actual ONNX Runtime 1.23.2 import also failed with `DLL initialization routine
failed`; mocked endpoint tests pass but direct host inference is blocked pending runtime repair.
