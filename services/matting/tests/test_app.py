"""HTTP contract tests with deterministic inference, no model downloads."""
import importlib
import io
import sys
import time
import weakref
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture
def service(monkeypatch, tmp_path):
    session = SimpleNamespace(inner_session=SimpleNamespace(get_providers=lambda: ["CPUExecutionProvider"]))
    create = Mock(return_value=session)
    remove = Mock(side_effect=lambda image, **kwargs: ImageOps.invert(image.convert("L")))
    monkeypatch.setitem(sys.modules, "rembg", SimpleNamespace(new_session=create, remove=remove))
    monkeypatch.setitem(sys.modules, "onnxruntime", SimpleNamespace(SessionOptions=SimpleNamespace))
    monkeypatch.setenv("MATTE_TARGET", "cpu")
    monkeypatch.setenv("REMBG_HOME", str(tmp_path))
    monkeypatch.delenv("U2NET_HOME", raising=False)
    for name in ["birefnet-general", "birefnet-general-lite", "birefnet-hrsod", "bria-rmbg"]:
        folder = tmp_path / "models" / name
        folder.mkdir(parents=True)
        (folder / f"{name}.onnx").write_bytes(b"fixture")
    sys.modules.pop("app", None)
    module = importlib.import_module("app")
    with TestClient(module.app) as client:
        yield client, module, create, remove


def image_bytes(fmt="PNG"):
    image = Image.new("RGB", (32, 24), "white")
    ImageDraw.Draw(image).rectangle((8, 6, 24, 20), fill="black")
    output = io.BytesIO()
    image.save(output, format=fmt)
    return output.getvalue()


def test_health_and_explicit_sessions(service):
    client, _, create, _ = service
    health = client.get("/health").json()
    assert health["ok"] is True
    assert health["default"] == "birefnet-general"
    assert len(health["models"]) == 4
    assert all(m["inputSize"] == 1024 and m["target"] == "cpu" for m in health["models"])
    assert create.call_count == 1
    assert list(service[1].SESSIONS) == ["birefnet-general"]
    assert all(call.kwargs["sess_opts"].intra_op_num_threads == 4 for call in create.call_args_list)
    assert all(call.kwargs["sess_opts"].enable_cpu_mem_arena is False for call in create.call_args_list)
    assert all(call.kwargs["sess_opts"].enable_mem_pattern is False for call in create.call_args_list)


@pytest.mark.parametrize("fmt", ["PNG", "JPEG"])
def test_matte_preserves_received_dimensions(service, fmt):
    client, _, _, remove = service
    response = client.post("/matte?model=birefnet-general-lite", files={"file": ("source", image_bytes(fmt))})
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.headers["x-model"] == "birefnet-general-lite"
    assert response.headers["x-input-size"] == "32x24"
    assert int(response.headers["x-ms"]) >= 0
    mask = Image.open(io.BytesIO(response.content))
    assert mask.mode == "L" and mask.size == (32, 24)
    assert mask.getextrema() == (0, 255)
    assert mask.getpixel((0, 0)) == 0
    assert mask.getpixel((16, 12)) == 255
    assert remove.call_args.kwargs["only_mask"] is True
    assert "session" in remove.call_args.kwargs


def test_cpu_releases_previous_session_before_loading_next(service):
    client, module, create, remove = service
    module.SESSIONS.clear()
    refs = []

    class Session:
        inner_session = SimpleNamespace(get_providers=lambda: ["CPUExecutionProvider"])

    def factory(*args, **kwargs):
        assert all(ref() is None for ref in refs), "old session retained while loading replacement"
        session = Session()
        refs.append(weakref.ref(session))
        return session

    create.side_effect = factory
    create.reset_mock()
    for name in ["birefnet-general", "birefnet-general", "birefnet-general-lite", "birefnet-hrsod", "bria-rmbg", "birefnet-general"]:
        response = client.post(f"/matte?model={name}", files={"file": ("source.png", image_bytes())})
        assert response.status_code == 200
        assert list(module.SESSIONS) == [name]
        assert len(client.get("/health").json()["models"]) == 4
        remove.reset_mock()
    assert create.call_count == 5


def test_inference_and_session_switch_are_serialized(service):
    client, _, _, remove = service
    active = 0
    peak = 0

    def infer(image, **kwargs):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        time.sleep(0.03)
        active -= 1
        return ImageOps.invert(image.convert("L"))

    remove.side_effect = infer

    def request(index):
        model = "birefnet-general" if index % 2 else "birefnet-general-lite"
        return client.post(f"/matte?model={model}", files={"file": ("source.png", image_bytes())}).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(request, range(8))) == [200] * 8
    assert peak == 1


def test_unknown_model(service):
    response = service[0].post("/matte?model=unknown", files={"file": ("a.png", image_bytes())})
    assert response.status_code == 400
    assert response.json()["error"] == "unknown model unknown"
    assert len(response.json()["models"]) == 4


def test_bad_matte_and_inference_error(service):
    client, _, _, remove = service
    assert client.post("/matte", files={"file": ("a.png", b"bad")}).status_code == 400
    remove.side_effect = RuntimeError("do not leak internal details")
    response = client.post("/matte", files={"file": ("a.png", image_bytes())})
    assert response.status_code == 500
    assert response.json() == {"error": "background removal failed"}


def test_size_limit(service, monkeypatch):
    client, module, _, _ = service
    monkeypatch.setattr(module, "MAX_INPUT_BYTES", 16)
    for route in ["/matte", "/convert"]:
        assert client.post(route, files={"file": ("a", b"x" * 17)}).status_code == 413


def test_heic_convert_real_fixture(service):
    data = (Path(__file__).parent / "fixtures" / "small.heic").read_bytes()
    response = service[0].post("/convert", files={"file": ("small.heic", data)})
    assert response.status_code == 200
    assert response.headers["x-input-format"] == "heic"
    converted = Image.open(io.BytesIO(response.content))
    assert converted.format == "PNG"
    assert converted.size == (32, 24)  # pillow-heif already normalizes the stored orientation.
    assert converted.mode == "RGB"
    assert converted.getexif().get(274, 1) == 1


@pytest.mark.parametrize("data", [b"bad", image_bytes()])
def test_convert_rejects_non_heif(service, data):
    response = service[0].post("/convert", files={"file": ("pretend.heic", data)})
    assert response.status_code == 400
    assert response.json() == {"error": "not a HEIC or HEIF file"}


def test_gpu_cannot_advertise_cpu_fallback(service, monkeypatch):
    module = service[1]
    monkeypatch.setattr(module, "TARGET", "gpu")
    with pytest.raises(RuntimeError, match="CUDAExecutionProvider"):
        module.load_sessions()


def test_missing_baked_model_fails_without_download(service, monkeypatch, tmp_path):
    _, module, create, _ = service
    monkeypatch.setenv("REMBG_HOME", str(tmp_path / "absent"))
    create.reset_mock()
    with pytest.raises(RuntimeError, match="baked model missing"):
        module.load_sessions()
    create.assert_not_called()
