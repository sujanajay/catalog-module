"""HTTP contract tests with deterministic inference, no model downloads."""
import importlib
import json
import logging
import io
import sys
import time
import weakref
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
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


def counting_sessions(create, module, lock_seen=None):
    """Fresh fake sessions whose inner run counts how many run at once; `lock_seen` records loads under the lock."""
    state = {"active": 0, "peak": 0, "loads": 0}
    counter = Lock()

    def run(*args, **kwargs):
        with counter:
            state["active"] += 1
            state["peak"] = max(state["peak"], state["active"])
        time.sleep(0.03)
        with counter:
            state["active"] -= 1
        return []

    def factory(*args, **kwargs):
        state["loads"] += 1
        if lock_seen is not None:
            lock_seen.append(module.INFERENCE_LOCK.locked())
        return SimpleNamespace(inner_session=SimpleNamespace(get_providers=lambda: ["CPUExecutionProvider"], run=run))

    create.side_effect = factory
    return state


def test_only_the_session_run_holds_the_lock(service):
    """Spec 16 3.1.2: runs never overlap, while the work before and after a run (decode, resize, encode) does."""
    client, module, create, remove = service
    module.SESSIONS.clear()
    loads_under_lock = []
    runs = counting_sessions(create, module, loads_under_lock)
    outside = {"active": 0, "peak": 0}
    counter = Lock()

    def infer(image, session, **kwargs):
        with counter:
            outside["active"] += 1
            outside["peak"] = max(outside["peak"], outside["active"])
        time.sleep(0.05)  # stands for rembg's resize and normalisation
        with counter:
            outside["active"] -= 1
        session.inner_session.run(None, {})
        return ImageOps.invert(image.convert("L"))

    remove.side_effect = infer

    def request(index):
        model = "birefnet-general" if index % 2 else "birefnet-general-lite"
        return client.post(f"/matte?model={model}", files={"file": ("source.png", image_bytes())}).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(request, range(8))) == [200] * 8
    assert runs["peak"] == 1
    assert outside["peak"] >= 2
    assert loads_under_lock and all(loads_under_lock)


def test_resident_sessions_are_least_recently_used(service, monkeypatch):
    """Spec 16 3.1.1: with 3 resident, A B C A D loads 4 sessions and keeps C A D."""
    client, module, create, remove = service
    monkeypatch.setattr(module, "MAX_RESIDENT_SESSIONS", 3)
    module.SESSIONS.clear()
    runs = counting_sessions(create, module)
    remove.side_effect = lambda image, session, **kwargs: (session.inner_session.run(None, {}), ImageOps.invert(image.convert("L")))[1]
    for name in ["birefnet-general", "birefnet-general-lite", "birefnet-hrsod", "birefnet-general", "bria-rmbg"]:
        assert client.post(f"/matte?model={name}", files={"file": ("source.png", image_bytes())}).status_code == 200
    assert runs["loads"] == 4
    assert list(module.SESSIONS) == ["birefnet-hrsod", "birefnet-general", "bria-rmbg"]
    health = client.get("/health").json()
    assert health["resident"] == ["birefnet-hrsod", "birefnet-general", "bria-rmbg"]
    assert health["maxResident"] == 3
    assert health["gpuMemory"] is None


def test_resident_default_is_one(service):
    _, module, _, _ = service
    assert module.MAX_RESIDENT_SESSIONS == 1


def test_gpu_session_gets_the_memory_options(service, monkeypatch):
    _, module, create, _ = service
    monkeypatch.setattr(module, "TARGET", "gpu")
    monkeypatch.setattr(module, "GPU_MEM_LIMIT_BYTES", "6442450944")
    create.side_effect = lambda *args, **kwargs: SimpleNamespace(inner_session=SimpleNamespace(get_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"]))
    module.create_session("birefnet-general")
    providers = create.call_args.kwargs["providers"]
    assert providers == [("CUDAExecutionProvider", {"arena_extend_strategy": "kSameAsRequested", "gpu_mem_limit": "6442450944"}), "CPUExecutionProvider"]
    monkeypatch.setattr(module, "GPU_MEM_LIMIT_BYTES", "")
    module.create_session("birefnet-general")
    assert create.call_args.kwargs["providers"][0] == ("CUDAExecutionProvider", {"arena_extend_strategy": "kSameAsRequested"})


def test_gpu_memory_reads_nvidia_smi_and_tolerates_its_absence(service, monkeypatch):
    _, module, _, _ = service
    monkeypatch.setattr(module, "TARGET", "gpu")
    monkeypatch.setattr(module, "_gpu_memory", {"at": -float("inf"), "value": None})
    monkeypatch.setattr(module.shutil, "which", lambda name: "/usr/bin/nvidia-smi")
    monkeypatch.setattr(module.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout="5120, 23034\n"))
    assert module.gpu_memory() == {"usedMiB": 5120, "totalMiB": 23034}
    monkeypatch.setattr(module, "_gpu_memory", {"at": -float("inf"), "value": None})
    monkeypatch.setattr(module.shutil, "which", lambda name: None)
    assert module.gpu_memory() is None


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


def test_gpu_releases_resident_workspace_before_model_switch(service, monkeypatch):
    client, module, create, remove = service
    monkeypatch.setattr(module, "TARGET", "gpu")
    module.SESSIONS.clear()
    refs = []

    class Session:
        inner_session = SimpleNamespace(get_providers=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"])

    def factory(*args, **kwargs):
        assert all(ref() is None for ref in refs), "previous GPU session still owns its workspace"
        assert [p if isinstance(p, str) else p[0] for p in kwargs["providers"]] == ["CUDAExecutionProvider", "CPUExecutionProvider"]
        session = Session()
        refs.append(weakref.ref(session))
        return session

    create.side_effect = factory
    module.SESSIONS.update(module.load_sessions())
    assert list(module.SESSIONS) == [module.DEFAULT_MODEL]
    for name in ["birefnet-general", "birefnet-general-lite", "birefnet-general", "birefnet-hrsod", "bria-rmbg"]:
        response = client.post(f"/matte?model={name}", files={"file": ("source.png", image_bytes())})
        assert response.status_code == 200
        assert list(module.SESSIONS) == [name]
        assert len(client.get("/health").json()["models"]) == 4
        remove.reset_mock()


def test_gpu_rejects_cpu_only_replacement_session(service, monkeypatch):
    client, module, _, _ = service
    monkeypatch.setattr(module, "TARGET", "gpu")
    response = client.post("/matte?model=birefnet-general-lite", files={"file": ("source.png", image_bytes())})
    assert response.status_code == 500
    assert not module.SESSIONS or "birefnet-general-lite" not in module.SESSIONS


def json_lines(module, caplog, prefix):
    """The matting logger's records starting with `prefix`, formatted by the service's JSON formatter."""
    formatter = module.JsonFormatter()
    return [json.loads(formatter.format(r)) for r in caplog.records if r.name == "matting" and r.getMessage().startswith(prefix)]


def test_matte_logs_one_json_line_with_the_batch_from_the_headers(service, caplog):
    client, module, _, _ = service
    caplog.set_level(logging.INFO, logger="matting")
    headers = {"x-catalog-batch": "batch-123", "x-catalog-product": "product-456"}
    assert client.post("/matte?model=birefnet-general", files={"file": ("a.png", image_bytes())}, headers=headers).status_code == 200
    [line] = json_lines(module, caplog, "inference_complete")
    assert line["severity"] == "INFO"
    assert line["message"].startswith("inference_complete model=birefnet-general target=cpu memory=")
    assert line["batchId"] == "batch-123" and line["productId"] == "product-456"
    assert line["model"] == "birefnet-general" and line["target"] == "cpu" and line["ms"] >= 0
    assert line["logging.googleapis.com/labels"] == {"app": "catalog", "batchId": "batch-123"}


def test_matte_log_without_headers_has_no_batch_and_errors_are_error_severity(service, caplog):
    client, module, _, remove = service
    caplog.set_level(logging.INFO, logger="matting")
    assert client.post("/matte", files={"file": ("a.png", image_bytes())}).status_code == 200
    [line] = json_lines(module, caplog, "inference_complete")
    assert "batchId" not in line and "logging.googleapis.com/labels" not in line
    remove.side_effect = RuntimeError("do not leak internal details")
    assert client.post("/matte", files={"file": ("a.png", image_bytes())}, headers={"x-catalog-batch": "b9"}).status_code == 500
    [failed] = json_lines(module, caplog, "inference_failed")
    assert failed["severity"] == "ERROR" and failed["batchId"] == "b9"
    assert "do not leak" not in json.dumps(failed)


def test_json_formatter_keeps_a_traceback_as_stack_trace(service):
    _, module, _, _ = service
    try:
        raise RuntimeError("library failure")
    except RuntimeError:
        record = logging.getLogger("matting").makeRecord("matting", logging.ERROR, __file__, 1, "inference_failed target=%s", ("cpu",), sys.exc_info())
    line = json.loads(module.JsonFormatter().format(record))
    assert line["severity"] == "ERROR" and line["message"] == "inference_failed target=cpu"
    assert line["stack_trace"].startswith("Traceback (most recent call last):")
    assert "RuntimeError: library failure" in line["stack_trace"]
    plain = logging.getLogger("matting").makeRecord("matting", logging.INFO, __file__, 1, "sessions_ready", (), None)
    assert "stack_trace" not in json.loads(module.JsonFormatter().format(plain))
