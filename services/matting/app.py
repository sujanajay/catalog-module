"""Byte-in, mask/PNG-out service. Cloud Run supplies authentication at its edge."""
import io
import gc
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from threading import Lock

import onnxruntime as ort
from fastapi import FastAPI, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener
from rembg import new_session, remove

register_heif_opener()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("matting")
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
SESSIONS = {}
INFERENCE_LOCK = Lock()


def load_sessions():
    if TARGET not in ("cpu", "gpu"):
        raise ValueError("MATTE_TARGET must be cpu or gpu")
    if not MODELS or any(name not in INPUT_SIZES for name in MODELS) or DEFAULT_MODEL not in MODELS:
        raise ValueError("MATTE_MODELS and DEFAULT_MATTE_MODEL must select baked models")
    model_home = Path(os.getenv("U2NET_HOME", os.getenv("REMBG_HOME", "/models")))
    for name in MODELS:
        if not (model_home / "models" / name / f"{name}.onnx").is_file():
            raise RuntimeError(f"baked model missing: {name}; rebuild the image, runtime downloads are disabled")
    return {DEFAULT_MODEL: create_session(DEFAULT_MODEL)}


def create_session(model):
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if TARGET == "gpu" else ["CPUExecutionProvider"]
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    if TARGET == "cpu":
        options.enable_cpu_mem_arena = False
        options.enable_mem_pattern = False
    session = new_session(model, sess_opts=options, providers=providers)
    actual = session.inner_session.get_providers()
    if TARGET == "gpu" and "CUDAExecutionProvider" not in actual:
        raise RuntimeError(f"{model}: CUDAExecutionProvider unavailable; refusing CPU-labelled-as-GPU service")
    status = Path("/proc/self/status")
    memory = [line for line in status.read_text().splitlines() if line.startswith(("VmRSS:", "VmHWM:"))] if status.exists() else []
    logger.info("session_ready model=%s target=%s providers=%s memory=%s", model, TARGET, actual, memory)
    return session


def session_for(model):
    # Release the old session and its retained workspace before loading another model.
    # Callers hold INFERENCE_LOCK through selection and inference on either target.
    if model not in SESSIONS:
        SESSIONS.clear()
        gc.collect()
        SESSIONS[model] = create_session(model)
    return SESSIONS[model]


@asynccontextmanager
async def lifespan(_app):
    started = time.perf_counter()
    SESSIONS.update(load_sessions())
    logger.info("sessions_ready target=%s models=%s startup_ms=%d", TARGET, ",".join(SESSIONS), (time.perf_counter() - started) * 1000)
    yield
    SESSIONS.clear()


app = FastAPI(lifespan=lifespan)


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
def health():
    return {"ok": True, "models": [{"id": name, "inputSize": INPUT_SIZES[name], "target": TARGET} for name in MODELS], "default": DEFAULT_MODEL, "version": os.getenv("GIT_SHA", "dev")}


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
        with INFERENCE_LOCK:
            mask = remove(image, session=session_for(model), only_mask=True).convert("L")
            status = Path("/proc/self/status")
            memory = [line for line in status.read_text().splitlines() if line.startswith(("VmRSS:", "VmHWM:"))] if status.exists() else []
            logger.info("inference_complete model=%s target=%s memory=%s", model, TARGET, memory)
        if mask.size != image.size:
            mask = mask.resize(image.size, Image.Resampling.LANCZOS)
        return png_response(mask, started, {"x-model": model, "x-input-size": f"{image.width}x{image.height}"})
    except Exception:
        # Inference internals and user image bytes do not belong in HTTP errors or logs.
        logger.error("inference_failed target=%s model=%s", TARGET, model)
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
