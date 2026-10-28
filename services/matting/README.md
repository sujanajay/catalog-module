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

`POST /upscale?model=<id>&scale=2` takes raw image bytes (`image/jpeg` or `image/png`) as the request
body; a multipart `file` field, as `/matte` takes, is also accepted. It returns `200 image/jpeg`
(quality 95, 4:4:4) at exactly 2x the received pixel dimensions, with `X-Upscale-Model` (the model
used) and `X-Upscale-Ms` (tiling plus inference, excluding a first-use model load). Only `scale=2`
exists. Alpha is dropped and only RGB is upscaled; an embedded ICC profile is carried over; EXIF is
not, and orientation is not applied, so callers send upright pixels (as they do for `/matte`).
Errors are JSON `{"error": "..."}`: 400 for a bad image, unknown model, unsupported scale or more
than `UPSCALE_MAX_PIXELS` (default 24,000,000) input pixels; 413 over 40,000,000 bytes; 503 when
the model is unavailable (CPU target, missing file, failed load or failed determinism check); 500
for an unexpected inference error. Omitting `model` selects `health.upscale.default`.

`/health` adds `"upscale": {"models": [{"id", "available", "scale": 2}], "default": <id or null>}`;
the existing fields are unchanged. The CPU image reports every model unavailable and answers 503,
because CPU inference takes tens of seconds per tile; `UPSCALE_CPU=1` enables CPU execution for
tests and the Cloud Build smoke only.

| Served id | Tile (input) | Licence | Source checkpoint (sha256) |
|---|---:|---|---|
| realesrgan-x2plus (default) | 512 | BSD-3-Clause | [RealESRGAN_x2plus.pth](https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth) `49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb` |
| swinir-x2 | 384 | Apache-2.0 | [002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth](https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth) `193b229909ca89cd8b55de9c9e7fce146ae759d59dfcd78d8feb9dd1d6fa0fd7` |

Real-ESRGAN ([repository](https://github.com/xinntao/Real-ESRGAN), BSD-3-Clause) uses the RRDBNet
architecture from BasicSR (Apache-2.0); `tools/convert_upscalers.py` reproduces it and loads the
checkpoint's `params_ema` with strict key matching. SwinIR ([repository](https://github.com/JingyunLiang/SwinIR),
Apache-2.0) is the classical lightweight x2 model (SwinIR-S, DIV2K); SwinIR publishes no lightweight
real-world x2 checkpoint. Its architecture file is fetched from commit
`6545850fbf8df298df73d81f3e8cba638787c8bd` (`models/network_swinir.py`, sha256
`9e143898679ebeebc5d2fc94ad1b89c38aa4a4d43da4e0fcba0f93e476994913`) with the `lightweight_sr`
hyperparameters from `main_test_swinir.py`; its three timm helpers are replaced by inference-time
stand-ins (DropPath is the identity at inference).

The Dockerfile's `upscale-models` stage (Python 3.12, `requirements-convert.txt`: PyTorch 2.9.1 CPU,
onnx 1.19.1, ONNX Runtime 1.23.2) downloads the three files from those URLs, fails the build on any
sha256 mismatch, exports fixed-shape fp32 ONNX (opset 17, TorchScript exporter), checks the ONNX
output against PyTorch (max abs difference under 2e-3; measured 2.2e-4 and 1.0e-6) and runs it twice
to require byte-identical output. The exports of Cloud Build `bf4d6276-e221-4e92-8d18-7c30cc121198` have the
sha256 `e828354d9b32d1462f0fd421a513015c80ebd6985e3e394f7d86285c102d79dd` (realesrgan-x2plus) and
`9f4a3f856ff12923e5b33f2965ed8ff7e360cb2f7ba9ed76ff04c59bf3021881` (swinir-x2); their first 8 hex are
`UPSCALE_MODEL_VERSIONS` in `packages/core/src/catalog/upscale.ts` (part of render_key), so a changed export
must bump that map. Only the ONNX files (about 67 MB and 11 MB) reach the runtime
images, under `/upscale-models`, read-only. Nothing is downloaded at request time.

Tiling: the image is reflection-padded and cut into fixed tiles carrying 32 px of context on each
side; only each tile's centre is kept, so tiles abut exactly with no blending. An 800x1200 photo is
6 Real-ESRGAN tiles or 12 SwinIR tiles. Output is cropped to exactly 2x.

Determinism: fp32 throughout (fp16 was not adopted because its run-to-run determinism on the L4 has
not been verified); `SessionOptions.use_deterministic_compute`; CUDA `cudnn_conv_algo_search=HEURISTIC`
(the default EXHAUSTIVE benchmarks at load and can choose a different algorithm per process);
one tile at a time under the service's inference lock; fixed rounding to 8 bits; deterministic JPEG
encoding. On first load each model runs a fixed probe tile twice and is refused (503, reported
unavailable in health) if the two outputs differ in a single bit. The build smoke repeats the
check end to end over HTTP on CPU.

Memory and speed: models load on first request and then stay resident; matting model switches do
not release them. CUDA options cap each upscaler's arena at 6 GiB (`gpu_mem_limit`, kSameAsRequested,
no maximum cuDNN workspace). Estimated L4 use is about 1.5 to 2.5 GB for Real-ESRGAN at 512 px tiles
and 1 to 2 GB for SwinIR at 384 px, alongside one resident BiRefNet session, well inside 24 GB.
Estimated L4 time for an 800x1200 photo is roughly 1 to 3 s per model, plus a one-off load and probe
of a few seconds; these are estimates, not measurements. Measured on a Windows laptop CPU: one 512 px
Real-ESRGAN tile took 25 to 29 s, one 384 px SwinIR tile 15 to 33 s.

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

## Host verification limitations

On 2026-10-18 Docker Desktop 4.86.0 could not initialize its Inference manager: the
`dockerInference` Unix listener path could not be accessed before the Linux engine started.
This matches [Docker issue 625](https://github.com/docker/desktop-feedback/issues/625) and
[issue 460](https://github.com/docker/desktop-feedback/issues/460). No reset or global file deletion
was performed. Local container checks remain pending host repair. The Cloud Build real-container
smoke supplies Linux image evidence while this local limitation remains explicitly reported.
Windows Python's actual ONNX Runtime 1.23.2 import also failed with `DLL initialization routine
failed`; mocked endpoint tests pass but direct host inference is blocked pending runtime repair.
