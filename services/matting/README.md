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
to require byte-identical output. Only the ONNX files (about 67 MB and 11 MB) reach the runtime
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
instance-based billing (`--no-cpu-throttling`) as Cloud Run requires. An 8 GiB/two-session LRU
configuration is not assumed to fit without measurements.

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

## Host verification limitations

On 2026-10-18 Docker Desktop 4.86.0 could not initialize its Inference manager: the
`dockerInference` Unix listener path could not be accessed before the Linux engine started.
This matches [Docker issue 625](https://github.com/docker/desktop-feedback/issues/625) and
[issue 460](https://github.com/docker/desktop-feedback/issues/460). No reset or global file deletion
was performed. Local container checks remain pending host repair. The Cloud Build real-container
smoke supplies Linux image evidence while this local limitation remains explicitly reported.
Windows Python's actual ONNX Runtime 1.23.2 import also failed with `DLL initialization routine
failed`; mocked endpoint tests pass but direct host inference is blocked pending runtime repair.
