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

This submits `services/matting/cloudbuild-test.yaml`: CPU build, a CPU container with four sessions,
real inference/conversion smoke, GPU build, then per-commit image pushes. No deployment occurs.
E2_HIGHCPU_32 supplies enough RAM for the 16 GiB container and exists only for the build. GPU images
can build without a GPU; actual CUDA inference requires an L4 and is a separate post-merge check.
The normal `cloudbuild.yaml` also builds both images.

## Memory, startup and deployment

Current deployment is conservatively 16 GiB, four eager sessions, intra-op threads 4, concurrency 1,
CPU 4 vCPU/max 20, GPU L4/4 vCPU/16 GiB/max 3, both min instances 0 and timeout 300s. GPU uses
instance-based billing (`--no-cpu-throttling`) as Cloud Run requires. An 8 GiB/two-session LRU
configuration is not implemented without measurements demonstrating it is needed.

Measurement procedure: Cloud Build starts CPU with all four models, captures `session_ready`
logs with actual providers and process resident/high-water KiB, captures `sessions_ready startup_ms`,
then executes the real smoke and `docker stats --no-stream`. The smoke prints version,
wait-to-health milliseconds and per-model `x-ms`. Record these numbers in the execution report
before accepting the final memory choice. App startup measures session loading; smoke wait includes
container/process readiness. All-four memory, image sizes, startup and model timings: **pending
Cloud Build**. No actual inference measurements are claimed by mocked tests.

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
