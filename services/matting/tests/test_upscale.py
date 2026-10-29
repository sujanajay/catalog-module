"""/upscale contract tests. No GPU and no real model: a stubbed ONNX session stands in for inference."""
import importlib
import io
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

UPSCALE_IDS = ["realesrgan-x2plus", "swinir-x2"]
TILE = 96  # small fixed tile keeps the stub fast; overlap 32 leaves a 32 px core


def nearest(batch):
    return batch.repeat(2, axis=2).repeat(2, axis=3)


def blurred(batch):
    # A local, translation-equivariant stand-in for a real network: nearest 2x then a 5x5 box blur.
    up = nearest(batch)
    padded = np.pad(up, ((0, 0), (0, 0), (2, 2), (2, 2)), mode="reflect")
    height, width = up.shape[2:]
    total = np.zeros_like(up)
    for dy in range(5):
        for dx in range(5):
            total += padded[:, :, dy:dy + height, dx:dx + width]
    return total / 25.0


class FakeSession:
    def __init__(self, tile=TILE, infer=nearest):
        self.tile, self.infer, self.calls = tile, infer, 0

    def get_inputs(self):
        return [SimpleNamespace(name="input", shape=[1, 3, self.tile, self.tile])]

    def run(self, _outputs, feed):
        batch = feed["input"]
        assert batch.dtype == np.float32 and batch.shape == (1, 3, self.tile, self.tile)
        self.calls += 1
        return [self.infer(batch)]


@pytest.fixture
def service(monkeypatch, tmp_path):
    session = SimpleNamespace(inner_session=SimpleNamespace(get_providers=lambda: ["CPUExecutionProvider"]))
    remove = Mock(side_effect=lambda image, **kwargs: ImageOps.invert(image.convert("L")))
    monkeypatch.setitem(sys.modules, "rembg", SimpleNamespace(new_session=Mock(return_value=session), remove=remove))
    monkeypatch.setitem(sys.modules, "onnxruntime", SimpleNamespace(SessionOptions=SimpleNamespace))
    monkeypatch.setenv("MATTE_TARGET", "cpu")
    monkeypatch.setenv("REMBG_HOME", str(tmp_path))
    monkeypatch.setenv("UPSCALE_HOME", str(tmp_path / "upscale"))
    monkeypatch.delenv("U2NET_HOME", raising=False)
    monkeypatch.delenv("UPSCALE_CPU", raising=False)
    for name in ["birefnet-general", "birefnet-general-lite", "birefnet-hrsod", "bria-rmbg"]:
        folder = tmp_path / "models" / name
        folder.mkdir(parents=True)
        (folder / f"{name}.onnx").write_bytes(b"fixture")
    (tmp_path / "upscale").mkdir()
    for name in UPSCALE_IDS:
        (tmp_path / "upscale" / f"{name}.onnx").write_bytes(b"fixture")
    sys.modules.pop("app", None)
    module = importlib.import_module("app")
    sessions = []

    def create(model):
        sessions.append(model)
        return FakeSession()

    monkeypatch.setattr(module, "create_upscale_session", create)
    with TestClient(module.app) as client:
        yield client, module, sessions


@pytest.fixture
def enabled(service, monkeypatch):
    monkeypatch.setenv("UPSCALE_CPU", "1")
    return service


def encoded(image, fmt="PNG"):
    output = io.BytesIO()
    image.save(output, format=fmt)
    return output.getvalue()


def checker(width=50, height=30):
    rng = np.random.default_rng(7)
    return Image.fromarray(rng.integers(0, 256, (height, width, 3), dtype=np.uint8), "RGB")


def post(client, data, query="model=realesrgan-x2plus&scale=2", content_type="image/png"):
    return client.post(f"/upscale?{query}", content=data, headers={"content-type": content_type})


def test_health_keeps_existing_fields_and_reports_cpu_unavailable(service):
    health = service[0].get("/health").json()
    assert health["ok"] is True and health["default"] == "birefnet-general" and len(health["models"]) == 4
    assert health["upscale"] == {"models": [{"id": name, "available": False, "scale": 2} for name in UPSCALE_IDS], "default": None}


def test_health_reports_available_models_when_enabled(enabled):
    upscale = enabled[0].get("/health").json()["upscale"]
    assert upscale == {"models": [{"id": name, "available": True, "scale": 2} for name in UPSCALE_IDS], "default": "realesrgan-x2plus"}
    assert enabled[2] == [], "health must not load models"


@pytest.mark.parametrize("query", ["model=realesrgan-x2plus&scale=2", "model=swinir-x2&scale=2", "scale=2", ""])
def test_cpu_image_answers_503_for_every_model(service, query):
    response = post(service[0], encoded(checker()), query)
    assert response.status_code == 503
    assert set(response.json()) == {"error"}
    assert service[2] == []


def test_missing_model_file_is_unavailable(enabled, tmp_path):
    (tmp_path / "upscale" / "swinir-x2.onnx").unlink()
    assert post(enabled[0], encoded(checker()), "model=swinir-x2&scale=2").status_code == 503
    models = enabled[0].get("/health").json()["upscale"]["models"]
    assert [m["available"] for m in models] == [True, False]


@pytest.mark.parametrize("query,message", [
    ("model=esrgan-x4&scale=2", "unknown model esrgan-x4"),
    ("model=realesrgan-x2plus&scale=4", "unsupported scale 4; only 2 is supported"),
    ("model=realesrgan-x2plus&scale=1", "unsupported scale 1; only 2 is supported"),
    ("model=realesrgan-x2plus&scale=two", "unsupported scale two; only 2 is supported"),
])
def test_route_validation(enabled, query, message):
    response = post(enabled[0], encoded(checker()), query)
    assert response.status_code == 400
    assert response.json()["error"] == message


@pytest.mark.parametrize("data", [b"", b"bad", encoded(checker(), "GIF")])
def test_bad_image(enabled, data):
    response = post(enabled[0], data)
    assert response.status_code == 400
    assert response.json() == {"error": "not a PNG or JPEG file"}


def test_body_over_limit(service, monkeypatch):
    client, module, sessions = service
    monkeypatch.setattr(module, "MAX_INPUT_BYTES", 16)
    assert post(client, b"x" * 17).status_code == 413
    assert client.post("/upscale?scale=2", files={"file": ("a.png", b"x" * 17)}).status_code == 413
    assert sessions == []


def test_too_many_pixels(enabled, monkeypatch):
    monkeypatch.setattr(enabled[1], "UPSCALE_MAX_PIXELS", 100)
    assert post(enabled[0], encoded(checker(11, 10))).status_code == 400


@pytest.mark.parametrize("fmt,content_type", [("PNG", "image/png"), ("JPEG", "image/jpeg")])
def test_upscale_returns_exact_2x_jpeg(enabled, fmt, content_type):
    source = Image.new("RGB", (37, 23), (200, 120, 40))
    response = post(enabled[0], encoded(source, fmt), content_type=content_type)
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["x-upscale-model"] == "realesrgan-x2plus"
    assert int(response.headers["x-upscale-ms"]) >= 0
    result = Image.open(io.BytesIO(response.content))
    assert result.format == "JPEG" and result.mode == "RGB" and result.size == (74, 46)
    assert [layer[1:3] for layer in result.layer] == [(1, 1)] * 3, "4:4:4, no chroma subsampling"
    pixels = np.asarray(result, dtype=np.int16)
    assert np.abs(pixels - pixels[0, 0]).max() <= 1, "constant image must stay constant"
    assert np.abs(pixels[0, 0] - np.array([200, 120, 40])).max() <= 2


def test_jpeg_is_quality_95_444(enabled, monkeypatch):
    saved = {}
    original = Image.Image.save

    def spy(self, fp, format=None, **params):
        if format == "JPEG":
            saved.update(params)
        return original(self, fp, format=format, **params)

    monkeypatch.setattr(Image.Image, "save", spy)
    assert post(enabled[0], encoded(checker())).status_code == 200
    assert saved["quality"] == 95 and saved["subsampling"] == 0


def test_default_model_and_multipart(enabled):
    response = enabled[0].post("/upscale?scale=2", files={"file": ("a.png", encoded(checker()), "image/png")})
    assert response.status_code == 200
    assert response.headers["x-upscale-model"] == "realesrgan-x2plus"
    assert Image.open(io.BytesIO(response.content)).size == (100, 60)


def test_alpha_is_dropped(enabled):
    source = Image.new("RGBA", (20, 12), (10, 200, 30, 0))
    response = post(enabled[0], encoded(source), "model=swinir-x2&scale=2")
    assert response.status_code == 200
    assert response.headers["x-upscale-model"] == "swinir-x2"
    result = Image.open(io.BytesIO(response.content))
    assert result.mode == "RGB" and result.size == (40, 24)
    assert np.abs(np.asarray(result, dtype=np.int16) - np.array([10, 200, 30])).max() <= 2


def test_rerun_is_byte_identical_and_model_stays_resident(enabled):
    client, module, sessions = enabled
    data = encoded(checker(130, 70))
    first = post(client, data)
    # A matting model switch releases matting sessions only; the upscaler stays resident.
    assert client.post("/matte?model=birefnet-general-lite", files={"file": ("a.png", data)}).status_code == 200
    second = post(client, data)
    assert first.status_code == second.status_code == 200
    assert first.content == second.content
    assert sessions == ["realesrgan-x2plus"]
    assert list(module.UPSCALERS) == ["realesrgan-x2plus"]
    post(client, data, "model=swinir-x2&scale=2")
    assert sessions == ["realesrgan-x2plus", "swinir-x2"]


def test_load_failure_is_503_and_reported(enabled, monkeypatch):
    client, module, _ = enabled

    def broken(model):
        raise RuntimeError("cuda init failed")

    monkeypatch.setattr(module, "create_upscale_session", broken)
    response = post(client, encoded(checker()))
    assert response.status_code == 503 and set(response.json()) == {"error"}
    upscale = client.get("/health").json()["upscale"]
    assert upscale["models"][0]["available"] is False and upscale["default"] == "swinir-x2"


def test_nondeterministic_model_is_not_served(enabled, monkeypatch):
    client, module, _ = enabled
    rng = np.random.default_rng()
    monkeypatch.setattr(module, "create_upscale_session", lambda model: FakeSession(infer=lambda b: nearest(b) + rng.random(1).astype(np.float32)))
    assert post(client, encoded(checker())).status_code == 503
    assert "realesrgan-x2plus" in module.UPSCALE_FAILED


def test_inference_error_is_500_without_details(enabled, monkeypatch):
    client, module, _ = enabled
    session = FakeSession()
    monkeypatch.setattr(module, "create_upscale_session", lambda model: session)
    calls = {"n": 0}

    def flaky(batch):
        calls["n"] += 1
        if calls["n"] > 2:  # the two load-time determinism probes succeed
            raise RuntimeError("secret internals")
        return nearest(batch)

    session.infer = flaky
    response = post(client, encoded(checker()))
    assert response.status_code == 500 and response.json() == {"error": "upscale failed"}


@pytest.mark.parametrize("size", [(1, 1), (5, 7), (32, 32), (33, 31), (64, 65), (130, 71), (200, 97)])
def test_tiling_reassembles_exactly(service, size):
    module = service[1]
    height, width = size
    rgb = np.random.default_rng(height * 1000 + width).integers(0, 256, (height, width, 3), dtype=np.uint8)
    session = FakeSession()
    out = module.upscale_array(rgb, lambda b: session.run(None, {"input": b})[0], TILE)
    assert out.shape == (height * 2, width * 2, 3) and out.dtype == np.uint8
    assert np.array_equal(out, rgb.repeat(2, axis=0).repeat(2, axis=1))
    core = TILE - 2 * module.UPSCALE_OVERLAP
    assert session.calls == -(-height // core) * -(-width // core)


def test_tiling_has_no_seams(service):
    module = service[1]
    y, x = np.mgrid[0:150, 0:170]
    rgb = np.stack([(x * 1.3) % 256, (y * 1.7) % 256, ((x + y) * 3) % 256], axis=-1).astype(np.uint8)
    tiled = module.upscale_array(rgb, blurred, TILE)
    whole = module.upscale_array(rgb, blurred, 2 * module.UPSCALE_OVERLAP + 256)  # one tile covers it all
    assert tiled.shape == whole.shape == (300, 340, 3)
    assert np.array_equal(tiled, whole)


def test_constant_image_stays_constant_across_tiles(service):
    rgb = np.full((300, 410, 3), (17, 128, 250), dtype=np.uint8)
    out = service[1].upscale_array(rgb, blurred, TILE)
    assert out.shape == (600, 820, 3)
    assert (out == np.array([17, 128, 250], dtype=np.uint8)).all()


def test_upscale_log_line_carries_the_batch_and_ms(enabled, caplog):
    client, module = enabled[0], enabled[1]
    caplog.set_level(logging.INFO, logger="matting")
    response = client.post("/upscale?model=realesrgan-x2plus&scale=2", content=encoded(checker()), headers={"content-type": "image/png", "x-catalog-batch": "b1", "x-catalog-product": "p1"})
    assert response.status_code == 200
    formatter = module.JsonFormatter()
    [line] = [json.loads(formatter.format(r)) for r in caplog.records if r.getMessage().startswith("upscale_complete")]
    assert line["severity"] == "INFO" and line["batchId"] == "b1" and line["productId"] == "p1"
    assert line["model"] == "realesrgan-x2plus" and line["ms"] == int(response.headers["x-upscale-ms"])


def test_health_reports_the_tile_of_a_loaded_upscaler(enabled):
    # Spec 18 H1: the probe reads the tile from /health once the warm call has loaded the model.
    client = enabled[0]
    assert client.get("/health").json()["upscaleTiles"] == {}
    assert post(client, encoded(checker()), "model=swinir-x2&scale=2").status_code == 200
    assert client.get("/health").json()["upscaleTiles"] == {"swinir-x2": TILE}
