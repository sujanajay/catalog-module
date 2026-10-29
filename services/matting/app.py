"""Byte-in, mask/PNG-out service. Cloud Run supplies authentication at its edge."""
import io
import gc
import json
import logging
import math
import os
import time
import uuid
from contextlib import asynccontextmanager
import shutil
import subprocess
from collections import OrderedDict
from contextvars import ContextVar
from pathlib import Path
from threading import Lock

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener
from rembg import new_session, remove

register_heif_opener()
# Structured logs: one JSON line per record, which Cloud Run turns into a LogEntry (severity, jsonPayload.message,
# labels). The worker sends x-catalog-batch and x-catalog-product; LogContextMiddleware puts them in LOG_CONTEXT
# and every line logged while serving that request carries them as batchId and productId.
LOG_CONTEXT = ContextVar("log_context", default={})
CONTEXT_HEADERS = {b"x-catalog-batch": "batchId", b"x-catalog-product": "productId"}


class LogContextFilter(logging.Filter):
    """Stamps the request's ids on the record when it is made, before any handler formats it."""

    def filter(self, record):
        record.log_context = LOG_CONTEXT.get()
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record):
        entry = {"severity": record.levelname, "message": record.getMessage(), **getattr(record, "log_context", {}), **getattr(record, "fields", {})}
        # A traceback (logger.exception, or a library logging exc_info) is kept for Error Reporting.
        if record.exc_info:
            entry["stack_trace"] = self.formatException(record.exc_info)
        if record.stack_info:
            entry["stack_info"] = self.formatStack(record.stack_info)
        if entry.get("batchId"):
            entry["logging.googleapis.com/labels"] = {"app": "catalog", "batchId": str(entry["batchId"])}
        return json.dumps(entry, default=str)


class LogContextMiddleware:
    """Pure ASGI: reads the trace headers into LOG_CONTEXT for the rest of the request."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.inner(scope, receive, send)
        context = {CONTEXT_HEADERS[name]: value.decode("latin-1")[:128] for name, value in scope.get("headers", []) if name in CONTEXT_HEADERS and value}
        token = LOG_CONTEXT.set(context)
        try:
            await self.inner(scope, receive, send)
        finally:
            LOG_CONTEXT.reset(token)


_handler = logging.StreamHandler()
_handler.setFormatter(JsonFormatter())
# basicConfig is a no-op when the root logger already has handlers: fine under the Dockerfile's uvicorn CMD, but
# gunicorn or uvicorn --log-config would configure logging first and these lines would revert to plain text.
logging.basicConfig(level=logging.INFO, handlers=[_handler])
logger = logging.getLogger("matting")
# One filter, also when the module is imported again (the tests do): the newest reads the current LOG_CONTEXT.
for _old in [f for f in logger.filters if type(f).__name__ == "LogContextFilter"]:
    logger.removeFilter(_old)
logger.addFilter(LogContextFilter())
INPUT_SIZES = {
    "birefnet-general": 1024,
    "birefnet-general-lite": 1024,
    "birefnet-hrsod": 1024,
    "bria-rmbg": 1024,
}
MODELS = tuple(dict.fromkeys(os.getenv("MATTE_MODELS", ",".join(INPUT_SIZES)).split(",")))
DEFAULT_MODEL = os.getenv("DEFAULT_MATTE_MODEL", "birefnet-general")
TARGET = os.getenv("MATTE_TARGET", "cpu")
MAX_INPUT_BYTES = int(os.getenv("MAX_INPUT_BYTES", "40000000"))
# Spec 16 3.1.1: cut-out sessions kept loaded, least recently used first. 1 (the default) keeps one model and
# releases it before loading the next; the GPU service runs 3 so a model switch does not pay a 4 to 8 s reload.
MAX_RESIDENT_SESSIONS = max(1, int(os.getenv("MAX_RESIDENT_SESSIONS", "1") or "1"))
# Caps each GPU cut-out session's CUDA arena so one model cannot grow into another's memory. Unset: no cap.
GPU_MEM_LIMIT_BYTES = os.getenv("GPU_MEM_LIMIT_BYTES", "").strip()
# Spec 17 3.3.2: cuDNN convolution options on GPU cut-out sessions, the same ones the upscaler sets. Unset keeps
# ONNX Runtime's defaults (EXHAUSTIVE search, maximum workspace), which is today's behaviour.
CUDNN_CONV_ALGO_SEARCH = os.getenv("CUDNN_CONV_ALGO_SEARCH", "").strip()
CUDNN_CONV_USE_MAX_WORKSPACE = os.getenv("CUDNN_CONV_USE_MAX_WORKSPACE", "").strip()
# Spec 17 3.3.2: global (default) = one cut-out run at a time on the instance; session = one run at a time per
# session, so two different models may run at once (ONNX sessions are thread-safe for run). Loads and evictions
# always take the global lock.
INFERENCE_LOCK_SCOPE = os.getenv("INFERENCE_LOCK_SCOPE", "global").strip() or "global"
# Spec 18 H1: ONNX Runtime intra-op threads for every session (cut-outs and upscalers). 4 (the default) is the value
# before spec 18; the probe measures 4 and 8 on 4 and 8 vCPU before a shape uses it.
ORT_INTRA_OP_THREADS = os.getenv("ORT_INTRA_OP_THREADS", "4").strip() or "4"
# Spec 18 H2: 1 (the default) loads the default cut-out model at start. 0 loads none, so the dedicated upscale service
# (catalog-upscale) holds only the upscaler; a /matte call there would still load its model on demand.
PRELOAD_MATTE = os.getenv("PRELOAD_MATTE", "1").strip() or "1"
SESSIONS = OrderedDict()
# Cut-out session loads since this process started, by model; with INSTANCE_ID the probe counts loads per instance.
LOADS = {}
INSTANCE_ID = uuid.uuid4().hex[:12]
# Spec 16 3.1.2: held only around ONNX session runs and around loading or evicting a session. Decode, resize,
# normalisation, mask post-processing and PNG encode run outside it, so with concurrency 2 one request's CPU work
# overlaps the other's inference.
INFERENCE_LOCK = Lock()


class LockedRun:
    """Wraps an ONNX InferenceSession so only `run` takes `lock` (INFERENCE_LOCK, or the session's own lock when
    INFERENCE_LOCK_SCOPE=session); every other attribute passes through."""

    def __init__(self, inner, lock):
        self._inner = inner
        self._lock = lock

    def run(self, *args, **kwargs):
        with self._lock:
            return self._inner.run(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def load_sessions():
    if TARGET not in ("cpu", "gpu"):
        raise ValueError("MATTE_TARGET must be cpu or gpu")
    if not MODELS or any(name not in INPUT_SIZES for name in MODELS) or DEFAULT_MODEL not in MODELS:
        raise ValueError("MATTE_MODELS and DEFAULT_MATTE_MODEL must select baked models")
    if CUDNN_CONV_ALGO_SEARCH not in ("", "DEFAULT", "HEURISTIC", "EXHAUSTIVE"):
        raise ValueError("CUDNN_CONV_ALGO_SEARCH must be DEFAULT, HEURISTIC or EXHAUSTIVE")
    if CUDNN_CONV_USE_MAX_WORKSPACE not in ("", "0", "1"):
        raise ValueError("CUDNN_CONV_USE_MAX_WORKSPACE must be 0 or 1")
    if INFERENCE_LOCK_SCOPE not in ("global", "session"):
        raise ValueError("INFERENCE_LOCK_SCOPE must be global or session")
    if not ORT_INTRA_OP_THREADS.isdigit() or not 1 <= int(ORT_INTRA_OP_THREADS) <= 64:
        raise ValueError("ORT_INTRA_OP_THREADS must be a whole number from 1 to 64")
    if PRELOAD_MATTE not in ("0", "1"):
        raise ValueError("PRELOAD_MATTE must be 0 or 1")
    model_home = Path(os.getenv("U2NET_HOME", os.getenv("REMBG_HOME", "/models")))
    for name in MODELS:
        if not (model_home / "models" / name / f"{name}.onnx").is_file():
            raise RuntimeError(f"baked model missing: {name}; rebuild the image, runtime downloads are disabled")
    if PRELOAD_MATTE == "0":
        return {}
    return {DEFAULT_MODEL: create_session(DEFAULT_MODEL)}


def cuda_options():
    """CUDA provider options for a cut-out session (ONNX Runtime CUDA EP docs, read 2026-10-27): the arena grows by
    what is asked, not the next power of two, and GPU_MEM_LIMIT_BYTES caps it when set. The cuDNN options (read
    2026-10-28: cudnn_conv_algo_search EXHAUSTIVE | HEURISTIC | DEFAULT, default EXHAUSTIVE;
    cudnn_conv_use_max_workspace default 1 since ORT 1.14, 0 clamps the workspace to 32 MB) are passed only when set."""
    options = {"arena_extend_strategy": "kSameAsRequested"}
    if GPU_MEM_LIMIT_BYTES:
        options["gpu_mem_limit"] = GPU_MEM_LIMIT_BYTES
    if CUDNN_CONV_ALGO_SEARCH:
        options["cudnn_conv_algo_search"] = CUDNN_CONV_ALGO_SEARCH
    if CUDNN_CONV_USE_MAX_WORKSPACE:
        options["cudnn_conv_use_max_workspace"] = CUDNN_CONV_USE_MAX_WORKSPACE
    return options


def create_session(model):
    # rembg passes a providers list through to onnxruntime.InferenceSession unchanged, so a (name, options) tuple works.
    providers = [("CUDAExecutionProvider", cuda_options()), "CPUExecutionProvider"] if TARGET == "gpu" else ["CPUExecutionProvider"]
    options = ort.SessionOptions()
    options.intra_op_num_threads = int(ORT_INTRA_OP_THREADS)
    if TARGET == "cpu":
        options.enable_cpu_mem_arena = False
        options.enable_mem_pattern = False
    session = new_session(model, sess_opts=options, providers=providers)
    actual = session.inner_session.get_providers()
    if TARGET == "gpu" and "CUDAExecutionProvider" not in actual:
        raise RuntimeError(f"{model}: CUDAExecutionProvider unavailable; refusing CPU-labelled-as-GPU service")
    # rembg's predict calls inner_session.run between its own resize and post-processing; only that run takes the lock.
    if not isinstance(session.inner_session, LockedRun):
        session.inner_session = LockedRun(session.inner_session, INFERENCE_LOCK if INFERENCE_LOCK_SCOPE == "global" else Lock())
    LOADS[model] = LOADS.get(model, 0) + 1
    status = Path("/proc/self/status")
    memory = [line for line in status.read_text().splitlines() if line.startswith(("VmRSS:", "VmHWM:"))] if status.exists() else []
    logger.info("session_ready model=%s target=%s providers=%s memory=%s resident=%d", model, TARGET, actual, memory, len(SESSIONS) + 1)
    return session


def session_for(model):
    """The session for `model`, loading it when it is not resident. When MAX_RESIDENT_SESSIONS are loaded, the least
    recently used one is released (and its workspace collected) before the new one loads. Holds INFERENCE_LOCK while
    it looks up, evicts and loads, so with INFERENCE_LOCK_SCOPE=global a load never overlaps an inference (with
    session, runs of other models take their own locks and may overlap a load). A request that already holds an evicted
    session finishes with it; its memory goes when that request ends."""
    with INFERENCE_LOCK:
        if model in SESSIONS:
            SESSIONS.move_to_end(model)
            return SESSIONS[model]
        while len(SESSIONS) >= MAX_RESIDENT_SESSIONS:
            SESSIONS.popitem(last=False)
        gc.collect()
        SESSIONS[model] = create_session(model)
        return SESSIONS[model]


GPU_MEMORY_TTL_S = 10.0
_gpu_memory = {"at": -math.inf, "value": None}


def cpu_limit():
    """The vCPU this container may use: the cgroup v2 quota (cpu.max), else the cgroup v1 quota (cpu.cfs_quota_us over
    cpu.cfs_period_us), else the CPUs the process may run on. None when none can be read. Informational only: on
    2026-10-29 a 4 vCPU Cloud Run revision reported 8 here (no quota visible, so the host's CPUs); the configured
    --cpu (UPSCALE_CPU_VCPU in infra/lib/shape.sh) is the source of truth."""
    try:
        quota, period = Path("/sys/fs/cgroup/cpu.max").read_text().split()[:2]
        if quota != "max":
            return round(int(quota) / int(period), 2)
    except (OSError, ValueError):
        pass
    try:
        quota = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text().strip())
        period = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text().strip())
        if quota > 0 and period > 0:
            return round(quota / period, 2)
    except (OSError, ValueError):
        pass
    try:
        return len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        return os.cpu_count()


def gpu_memory(fresh=False):
    """Used and total VRAM of GPU 0 in MiB from nvidia-smi, or None (CPU target, no nvidia-smi, any failure). Cached 10 s
    unless `fresh` (the probe reads it after every step)."""
    if TARGET != "gpu":
        return None
    now = time.monotonic()
    if not fresh and now - _gpu_memory["at"] < GPU_MEMORY_TTL_S:
        return _gpu_memory["value"]
    value = None
    tool = shutil.which("nvidia-smi")
    if tool:
        try:
            out = subprocess.run([tool, "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=2, check=True).stdout
            used, total = (int(part.strip()) for part in out.splitlines()[0].split(","))
            value = {"usedMiB": used, "totalMiB": total}
        except (OSError, subprocess.SubprocessError, ValueError, IndexError):
            value = None
    _gpu_memory.update(at=now, value=value)
    return value


@asynccontextmanager
async def lifespan(_app):
    started = time.perf_counter()
    SESSIONS.update(load_sessions())
    logger.info("sessions_ready target=%s models=%s startup_ms=%d", TARGET, ",".join(SESSIONS), (time.perf_counter() - started) * 1000)
    yield
    SESSIONS.clear()


app = FastAPI(lifespan=lifespan)
app.add_middleware(LogContextMiddleware)


def png_response(image, started, headers):
    output = io.BytesIO()
    image.info.clear()
    image.save(output, format="PNG")
    return Response(output.getvalue(), media_type="image/png", headers={"x-ms": str(int((time.perf_counter() - started) * 1000)), **headers})


def read_upload(file):
    data = file.file.read(MAX_INPUT_BYTES + 1)
    if len(data) > MAX_INPUT_BYTES:
        return None, JSONResponse({"error": "file exceeds 40 MB limit"}, status_code=413)
    return data, None


@app.get("/health")
def health(fresh: bool = False):
    # Spec 18 H1: never takes INFERENCE_LOCK (it reads dicts and files only), so it answers while an upscale runs.
    resident = list(SESSIONS)
    # ONNX Runtime's Python API (1.23) exposes no per-session arena statistics, so arenaBytesByModel stays empty
    # until it does; gpuMemory is the card-wide figure the probe reads instead.
    return {"ok": True, "models": [{"id": name, "inputSize": INPUT_SIZES[name], "target": TARGET} for name in MODELS], "default": DEFAULT_MODEL, "version": os.getenv("GIT_SHA", "dev"), "upscale": upscale_health(),
            "resident": resident, "residentModels": resident, "maxResident": MAX_RESIDENT_SESSIONS, "gpuMemory": gpu_memory(fresh), "arenaBytesByModel": {},
            "candidate": os.getenv("K_REVISION") or None, "lockScope": INFERENCE_LOCK_SCOPE, "instanceId": INSTANCE_ID, "loadsByModel": dict(LOADS),
            "vcpu": cpu_limit(), "threads": int(ORT_INTRA_OP_THREADS) if ORT_INTRA_OP_THREADS.isdigit() else None, "preloadMatte": PRELOAD_MATTE == "1",
            # The tile of each loaded upscaler (from its ONNX input); a model that has not loaded yet is absent.
            # A copy: a first /upscale may add a model while this iterates (health never takes INFERENCE_LOCK).
            "upscaleTiles": {model: upscaler.tile for model, upscaler in list(UPSCALERS.items())}}


@app.post("/matte")
def matte(file: UploadFile, model: str = DEFAULT_MODEL):
    if model not in MODELS:
        return JSONResponse({"error": f"unknown model {model}", "models": list(MODELS)}, status_code=400)
    started = time.perf_counter()
    data, error = read_upload(file)
    if error is not None:
        return error
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format not in ("PNG", "JPEG"):
                raise ValueError("PNG or JPEG required")
            image = source.convert("RGB")
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return JSONResponse({"error": "not a PNG or JPEG file"}, status_code=400)
    try:
        # Only the session's inner run holds INFERENCE_LOCK (LockedRun); rembg's resize and post-processing do not.
        mask = remove(image, session=session_for(model), only_mask=True).convert("L")
        status = Path("/proc/self/status")
        memory = [line for line in status.read_text().splitlines() if line.startswith(("VmRSS:", "VmHWM:"))] if status.exists() else []
        ms = int((time.perf_counter() - started) * 1000)
        logger.info("inference_complete model=%s target=%s memory=%s ms=%d", model, TARGET, memory, ms, extra={"fields": {"model": model, "target": TARGET, "ms": ms}})
        if mask.size != image.size:
            mask = mask.resize(image.size, Image.Resampling.LANCZOS)
        return png_response(mask, started, {"x-model": model, "x-input-size": f"{image.width}x{image.height}"})
    except Exception:
        # Inference internals and user image bytes do not belong in HTTP errors or logs.
        logger.error("inference_failed target=%s model=%s", TARGET, model, extra={"fields": {"model": model, "target": TARGET}})
        return JSONResponse({"error": "background removal failed"}, status_code=500)


@app.post("/convert")
def convert(file: UploadFile):
    started = time.perf_counter()
    data, error = read_upload(file)
    if error is not None:
        return error
    try:
        with Image.open(io.BytesIO(data)) as source:
            if source.format != "HEIF":
                raise ValueError("HEIF required")
            image = ImageOps.exif_transpose(source)
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        # HEIC uses HEVC; the HEIF container may carry a generic mif1 brand.
        brand = data[8:12]
        input_format = "heic" if brand in (b"heic", b"heix", b"hevc", b"hevx") else "heif"
        return png_response(image, started, {"x-input-format": input_format})
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return JSONResponse({"error": "not a HEIC or HEIF file"}, status_code=400)


# ---------------------------------------------------------------------------------------------
# Upscaling. Fixed-tile ONNX models converted at image build time (tools/convert_upscalers.py).
# Loaded lazily on first use and then kept resident; matting session switches never release them.
UPSCALE_MODELS = ("realesrgan-x2plus", "swinir-x2")  # preference order for the default
UPSCALE_SCALE = 2
UPSCALE_OVERLAP = 32
UPSCALE_MAX_PIXELS = int(os.getenv("UPSCALE_MAX_PIXELS", "24000000"))
UPSCALERS = {}
UPSCALE_FAILED = {}


class UpscaleUnavailable(Exception):
    pass


def upscale_home():
    return Path(os.getenv("UPSCALE_HOME", "/upscale-models"))


def upscale_enabled():
    # CPU inference of these models takes minutes per photo, so only the GPU image serves them.
    # UPSCALE_CPU=1 enables CPU execution for tests and the build smoke.
    return TARGET == "gpu" or os.getenv("UPSCALE_CPU") == "1"


def upscale_available(model):
    return upscale_enabled() and model not in UPSCALE_FAILED and (upscale_home() / f"{model}.onnx").is_file()


def upscale_default():
    return next((model for model in UPSCALE_MODELS if upscale_available(model)), None)


def upscale_health():
    models = [{"id": model, "available": upscale_available(model), "scale": UPSCALE_SCALE} for model in UPSCALE_MODELS]
    return {"models": models, "default": upscale_default()}


def create_upscale_session(model):
    path = upscale_home() / f"{model}.onnx"
    options = ort.SessionOptions()
    options.use_deterministic_compute = True
    options.intra_op_num_threads = int(ORT_INTRA_OP_THREADS)
    if TARGET == "gpu":
        # HEURISTIC picks the same cuDNN algorithm for the same shapes on every run and restart;
        # the default EXHAUSTIVE benchmarks at load time and can pick a different one.
        cuda = {"cudnn_conv_algo_search": "HEURISTIC", "cudnn_conv_use_max_workspace": "0",
                "arena_extend_strategy": "kSameAsRequested", "gpu_mem_limit": str(6 * 1024 ** 3)}
        providers = [("CUDAExecutionProvider", cuda), "CPUExecutionProvider"]
    else:
        options.enable_cpu_mem_arena = False
        providers = ["CPUExecutionProvider"]
    session = ort.InferenceSession(str(path), sess_options=options, providers=providers)
    if TARGET == "gpu" and "CUDAExecutionProvider" not in session.get_providers():
        raise RuntimeError(f"{model}: CUDAExecutionProvider unavailable")
    return session


class Upscaler:
    """Runs one fixed-size NCHW float32 tile at a time; the tile size comes from the ONNX input."""

    def __init__(self, session):
        self.session = session
        model_input = session.get_inputs()[0]
        self.input_name = model_input.name
        tile = model_input.shape[2]
        if not isinstance(tile, int) or tile != model_input.shape[3] or tile <= 2 * UPSCALE_OVERLAP:
            raise RuntimeError("upscale model must have a fixed square tile input")
        self.tile = tile

    def run(self, batch):
        return self.session.run(None, {self.input_name: batch})[0]


def probe_tile(tile):
    y, x = np.mgrid[0:tile, 0:tile].astype(np.float32) / max(tile - 1, 1)
    return np.ascontiguousarray(np.stack([x, y, ((x > 0.5) ^ (y > 0.3)).astype(np.float32)])[None])


def load_upscaler(model):
    """Called with INFERENCE_LOCK held. Raises UpscaleUnavailable when the model cannot serve."""
    if model in UPSCALERS:
        return UPSCALERS[model]
    if not upscale_available(model):
        raise UpscaleUnavailable(model)
    started = time.perf_counter()
    try:
        upscaler = Upscaler(create_upscale_session(model))
        # Determinism self-check: identical input must give identical bytes, or the model is not served.
        first = upscaler.run(probe_tile(upscaler.tile))
        second = upscaler.run(probe_tile(upscaler.tile))
        if first.shape != (1, 3, upscaler.tile * UPSCALE_SCALE, upscaler.tile * UPSCALE_SCALE):
            raise RuntimeError("unexpected output shape")
        if first.tobytes() != second.tobytes():
            raise RuntimeError("non-deterministic output")
    except Exception as error:
        UPSCALE_FAILED[model] = type(error).__name__
        logger.error("upscaler_failed model=%s target=%s reason=%s", model, TARGET, error)
        raise UpscaleUnavailable(model) from error
    UPSCALERS[model] = upscaler
    logger.info("upscaler_ready model=%s target=%s tile=%d load_ms=%d", model, TARGET, upscaler.tile, (time.perf_counter() - started) * 1000)
    return upscaler


def upscale_array(rgb, run, tile, overlap=UPSCALE_OVERLAP, scale=UPSCALE_SCALE):
    """Upscale an HxWx3 uint8 array by `scale` with fixed tiles.

    Each tile carries `overlap` pixels of context on every side (reflection beyond the image edge)
    and only its centre is kept, so tiles abut exactly with no blending and no seams. The result is
    exactly (H*scale)x(W*scale)x3 uint8.
    """
    height, width = rgb.shape[:2]
    core = tile - 2 * overlap
    rows, cols = math.ceil(height / core), math.ceil(width / core)
    source = np.transpose(rgb, (2, 0, 1)).astype(np.float32) / 255.0
    pad = ((0, 0), (overlap, rows * core - height + overlap), (overlap, cols * core - width + overlap))
    padded = np.pad(source, pad, mode="reflect")
    out = np.empty((rows * core * scale, cols * core * scale, 3), dtype=np.uint8)
    keep = slice(overlap * scale, (overlap + core) * scale)
    for row in range(rows):
        for col in range(cols):
            y, x = row * core, col * core
            result = run(np.ascontiguousarray(padded[None, :, y:y + tile, x:x + tile]))
            if result.shape != (1, 3, tile * scale, tile * scale):
                raise RuntimeError("upscale tile has unexpected shape")
            centre = np.clip(result[0, :, keep, keep], 0.0, 1.0) * 255.0
            out[y * scale:(y + core) * scale, x * scale:(x + core) * scale] = np.rint(centre).astype(np.uint8).transpose(1, 2, 0)
    return out[:height * scale, :width * scale]


def upscale_error(message, status):
    return JSONResponse({"error": message}, status_code=status)


async def read_upscale_body(request):
    """Raw image bytes are the contract; a multipart `file` field (as /matte takes) is also accepted."""
    too_large = upscale_error("file exceeds 40 MB limit", 413)
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_INPUT_BYTES + 1024 * 1024:
        return None, too_large
    if request.headers.get("content-type", "").startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if upload is None or isinstance(upload, str):
            return None, upscale_error("multipart body needs a file field", 400)
        data = await upload.read(MAX_INPUT_BYTES + 1)
    else:
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_INPUT_BYTES:
                return None, too_large
            chunks.append(chunk)
        data = b"".join(chunks)
    if len(data) > MAX_INPUT_BYTES:
        return None, too_large
    return data, None


def decode_rgb(data):
    with Image.open(io.BytesIO(data)) as source:
        if source.format not in ("PNG", "JPEG"):
            raise ValueError("PNG or JPEG required")
        icc = source.info.get("icc_profile")
        # Alpha is never processed: it is dropped and only RGB is upscaled.
        image = source.convert("RGB")
    return image, icc


def run_upscale(model, image):
    with INFERENCE_LOCK:
        upscaler = load_upscaler(model)

    def locked_tile(batch):
        # Spec 16 3.1.2: the lock is held per tile, so a cut-out can run between two tiles of an upscale.
        with INFERENCE_LOCK:
            return upscaler.run(batch)

    started = time.perf_counter()
    pixels = upscale_array(np.asarray(image, dtype=np.uint8), locked_tile, upscaler.tile)
    elapsed = int((time.perf_counter() - started) * 1000)
    logger.info("upscale_complete model=%s target=%s size=%dx%d ms=%d", model, TARGET, image.width, image.height, elapsed, extra={"fields": {"model": model, "target": TARGET, "ms": elapsed}})
    return Image.fromarray(pixels, "RGB"), elapsed


@app.post("/upscale")
async def upscale(request: Request, model: str | None = None, scale: str = str(UPSCALE_SCALE)):
    if model is not None and model not in UPSCALE_MODELS:
        return JSONResponse({"error": f"unknown model {model}", "models": list(UPSCALE_MODELS)}, status_code=400)
    if scale != str(UPSCALE_SCALE):
        return upscale_error(f"unsupported scale {scale}; only {UPSCALE_SCALE} is supported", 400)
    data, error = await read_upscale_body(request)
    if error is not None:
        return error
    chosen = model or upscale_default()
    if chosen is None or not upscale_available(chosen):
        return upscale_error(f"upscale model {chosen or 'default'} unavailable", 503)
    try:
        image, icc = decode_rgb(data)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return upscale_error("not a PNG or JPEG file", 400)
    if image.width * image.height > UPSCALE_MAX_PIXELS:
        return upscale_error(f"image exceeds {UPSCALE_MAX_PIXELS} pixels for upscaling", 400)
    try:
        result, elapsed = await run_in_threadpool(run_upscale, chosen, image)
    except UpscaleUnavailable:
        return upscale_error(f"upscale model {chosen} unavailable", 503)
    except Exception:
        # Inference internals and user image bytes do not belong in HTTP errors or logs.
        logger.error("upscale_failed target=%s model=%s", TARGET, chosen, extra={"fields": {"model": chosen, "target": TARGET}})
        return upscale_error("upscale failed", 500)
    output = io.BytesIO()
    options = {"quality": 95, "subsampling": 0}
    if icc:
        options["icc_profile"] = icc
    result.save(output, format="JPEG", **options)
    return Response(output.getvalue(), media_type="image/jpeg", headers={"X-Upscale-Model": chosen, "X-Upscale-Ms": str(elapsed)})
