"""Offline runtime-probe regression tests with real HEIF encoding/decoding."""
import email.message
import importlib.util
import io
import json
from pathlib import Path
import urllib.error

from PIL import Image, ImageOps
import pytest

spec = importlib.util.spec_from_file_location("cloudrun_check", Path(__file__).with_name("cloudrun_check.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


@pytest.mark.parametrize(("conversion", "matte"), [("source", "source"), ("white", "source"), ("black", "source"), ("inverted", "source"), ("source", "inverted")])
def test_probe_preserves_foreground_and_background(monkeypatch, conversion, matte, capsys):
    url = "https://private-service.example"

    def request(endpoint, token=None):
        assert endpoint == url + "/health"
        if token is None:
            raise urllib.error.HTTPError(endpoint, 403, "private", {}, None)
        health = {"ok": True, "default": "birefnet-general", "version": "abc1234",
                  "models": [{"id": model, "inputSize": 1024, "target": "cpu"} for model in probe.MODELS]}
        return None, json.dumps(health).encode()

    def upload(endpoint, token, data, filename, mime):
        source = Image.open(io.BytesIO(data))
        source.load()
        headers = email.message.Message()
        headers["Content-Type"] = "image/png"
        headers["x-ms"] = "1"
        if endpoint.endswith("/convert"):
            assert source.format == "HEIF"
            response = source.convert("RGB")
            if conversion in ("white", "black"):
                response = Image.new("RGB", source.size, conversion)
            elif conversion == "inverted":
                response = ImageOps.invert(response)
            headers["x-input-format"] = "heic"
        else:
            response = Image.new("L", source.size)
            response.putpixel((128, 96), 255)
            if matte == "inverted":
                response = ImageOps.invert(response)
            headers["x-model"] = "birefnet-general"
            headers["x-input-size"] = "256x192"
        output = io.BytesIO()
        response.save(output, format="PNG")
        return headers, output.getvalue()

    monkeypatch.setattr(probe, "request", request)
    monkeypatch.setattr(probe, "identity_token", lambda audience: "offline-token")
    monkeypatch.setattr(probe, "upload", upload)
    if conversion == "source" and matte == "source":
        probe.check("cpu", url, "abc1234")
        assert json.loads(capsys.readouterr().out)["convert"] == "passed"
    else:
        message = "HEIC conversion pixels differ" if conversion != "source" else "mask foreground/background differ"
        with pytest.raises(probe.CheckFailure, match=message):
            probe.check("cpu", url, "abc1234")


# Spec 17 3.3.1: probe mode against a fake matting service on localhost.
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PEAKS = {"birefnet-general": 5000, "birefnet-general-lite": 3000, "birefnet-hrsod": 5200, "bria-rmbg": 9000}


class FakeMatting:
    """One instance with `resident` cut-out slots (least recently used out), per-model VRAM and optional failures."""

    def __init__(self, resident=1, fail_model=None, advertised=None, health_extra=None, target="gpu"):
        self.resident, self.fail_model, self.advertised, self.target = resident, fail_model, advertised or resident, target
        self.health_extra = health_extra or {}
        self.sessions, self.loads, self.calls, self.health_queries = ["birefnet-general"], {"birefnet-general": 1}, [], []
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body, kind):
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                fake.health_queries.append(self.path)
                with fake.lock:
                    used = 1000 + sum(PEAKS[m] for m in fake.sessions)
                    body = {"ok": True, "instanceId": "fake01", "loadsByModel": dict(fake.loads), "residentModels": list(fake.sessions),
                            "models": [{"id": m, "inputSize": 1024, "target": fake.target} for m in PEAKS], "maxResident": fake.advertised,
                            "gpuMemory": {"usedMiB": used, "totalMiB": 23034}, "candidate": "catalog-matting-gpu-00042-abc", "lockScope": "global",
                            **fake.health_extra}
                self.reply(200, json.dumps(body).encode(), "application/json")

            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                model = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)["model"][0]
                with fake.lock:
                    fake.calls.append(model)
                    if model in fake.sessions:
                        fake.sessions.remove(model)
                    else:
                        fake.loads[model] = fake.loads.get(model, 0) + 1
                        del fake.sessions[:max(0, len(fake.sessions) - fake.resident + 1)]
                    fake.sessions.append(model)
                if model == fake.fail_model:
                    self.reply(500, b'{"error": "background removal failed"}', "application/json")
                else:
                    self.reply(200, b"\x89PNG\r\n\x1a\n", "image/png")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def fake_matting():
    servers = []

    def start(**kwargs):
        servers.append(FakeMatting(**kwargs))
        return servers[-1]
    yield start
    for fake in servers:
        fake.server.shutdown()
        fake.server.server_close()


def run_probe(url, *args):
    reports = []
    code = probe.probe_main(["--probe", *args, "--run", "test-run", url], report_writer=lambda run, report: (reports.append(report), f"gs://bucket/{run}")[1])
    return code, reports[0]


def test_probe_measures_every_model_and_passes_when_all_stay_resident(fake_matting, capsys):
    fake = fake_matting(resident=4)
    code, report = run_probe(fake.url, "--concurrency", "2", "--rounds", "3")
    assert code == 0 and report["passed"] is True
    rows = {r["model"]: r for r in report["rows"]}
    # 1 warm + 2 x 3 measured per model, then the switching order general, bria, lite, hrsod, general.
    assert fake.calls[:7] == ["birefnet-general"] * 7
    assert fake.calls[-5:] == ["birefnet-general", "bria-rmbg", "birefnet-general-lite", "birefnet-hrsod", "birefnet-general"]
    assert len(fake.calls) == 4 * 7 + 5
    # The default model was loaded at startup, before the probe's baseline read: it does not count.
    assert rows["birefnet-general"]["loads"] == 0 and all(rows[m]["loads"] == 1 for m in PEAKS if m != "birefnet-general")
    assert all(r["non200"] == 0 for r in rows.values()) and report["reloadsChecked"] is True
    assert rows["birefnet-general"]["calls"] == 9 and rows["bria-rmbg"]["calls"] == 8
    assert rows["bria-rmbg"]["peakVramUsedMiB"] == 1000 + sum(PEAKS.values())
    assert rows["birefnet-general"]["p50Ms"] is not None and rows["birefnet-general"]["p95Ms"] >= rows["birefnet-general"]["p50Ms"]
    # /health is read after every step, past the VRAM cache.
    assert len(fake.health_queries) == 1 + 4 * (1 + 3) + 5 and all(q == "/health?fresh=1" for q in fake.health_queries)
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "| model | peak VRAM used (MiB) | p50 ms | p95 ms | non-200 | loads |"
    assert len(out) == 2 + 4 + 1
    assert json.loads(out[-1]) == {"probe": "test-run", "passed": True, "failures": [], "report": "gs://bucket/test-run"}
    assert report["instances"]["fake01"]["candidate"] == "catalog-matting-gpu-00042-abc"


def test_probe_reports_but_does_not_fail_the_reloads_of_fewer_resident_sessions(fake_matting):
    # Today's shape (one resident) must reload on every switch; the probe reports it and still passes.
    code, report = run_probe(fake_matting(resident=1).url, "--rounds", "1")
    assert code == 0 and report["reloadsChecked"] is False
    assert {r["model"]: r["loads"] for r in report["rows"]} == {"birefnet-general": 2, "bria-rmbg": 2, "birefnet-general-lite": 2, "birefnet-hrsod": 2}


def test_probe_fails_on_a_reload_and_on_non_200(fake_matting):
    # Advertises four resident but keeps one: the reloads are a failure.
    code, report = run_probe(fake_matting(resident=1, advertised=4).url, "--rounds", "1")
    assert code == 1
    assert report["failures"] == ["birefnet-general: 2 loads on one instance", "bria-rmbg: 2 loads on one instance",
                                  "birefnet-general-lite: 2 loads on one instance", "birefnet-hrsod: 2 loads on one instance"]
    code, report = run_probe(fake_matting(resident=4, fail_model="bria-rmbg").url, "--models", "birefnet-general,bria-rmbg", "--rounds", "2")
    assert code == 1
    assert report["failures"] == ["bria-rmbg: 4 non-200"]
    rows = {r["model"]: r for r in report["rows"]}
    assert rows["bria-rmbg"]["p50Ms"] is None and rows["birefnet-general"]["non200"] == 0


def test_probe_counts_an_unreachable_service_as_non_200(fake_matting):
    fake = fake_matting()
    url = fake.url
    fake.server.shutdown()
    fake.server.server_close()
    code, report = run_probe(url, "--models", "birefnet-hrsod", "--rounds", "1")
    assert code == 1 and report["rows"][0]["non200"] == 2 and report["rows"][0]["peakVramUsedMiB"] is None
    assert report["failures"] == ["birefnet-hrsod: 2 non-200", "health unreadable after baseline", "health unreadable after warm", "health unreadable after round 1"]


@pytest.mark.parametrize(("extra", "target", "failure"), [({"loadsByModel": None}, "gpu", "health after baseline has no instanceId or loadsByModel (a revision before spec 17?)"),
                                                           ({"gpuMemory": None}, "gpu", "GPU memory unreadable after baseline")])
def test_probe_fails_when_health_cannot_measure(fake_matting, extra, target, failure):
    code, report = run_probe(fake_matting(resident=4, health_extra=extra, target=target).url, "--models", "bria-rmbg", "--rounds", "1")
    assert code == 1 and failure in report["failures"]


def test_probe_on_the_cpu_service_needs_no_gpu_memory(fake_matting):
    code, report = run_probe(fake_matting(resident=4, health_extra={"gpuMemory": None}, target="cpu").url, "--models", "bria-rmbg", "--rounds", "1")
    assert code == 0 and report["rows"][0]["peakVramUsedMiB"] is None


def test_probe_audience_is_the_service_url_also_for_a_tag_url():
    assert probe.audience_for("https://candidate---catalog-matting-gpu-abc-as.a.run.app") == "https://catalog-matting-gpu-abc-as.a.run.app"
    assert probe.audience_for("https://catalog-matting-gpu-abc-as.a.run.app") == "https://catalog-matting-gpu-abc-as.a.run.app"


def test_probe_asks_for_a_token_for_the_service_audience(monkeypatch):
    seen = []
    monkeypatch.setattr(probe.Probe, "run", lambda self, concurrency, rounds: None)
    code = probe.probe_main(["--probe", "--models", "bria-rmbg", "https://candidate---svc-abc.a.run.app"],
                            token_for=lambda audience: seen.append(audience) or "tok", report_writer=lambda run, report: "gs://x")
    assert code == 0 and seen == ["https://svc-abc.a.run.app"]


@pytest.mark.parametrize("args", [["--models", "u2net"], ["--concurrency", "0"], ["--rounds", "500"], ["--run", "../escape"]])
def test_probe_refuses_bad_arguments(args):
    with pytest.raises(probe.CheckFailure):
        probe.parse_probe_args(["--probe", *args, "https://svc-abc.a.run.app"])
    with pytest.raises(probe.CheckFailure, match="probe URL"):
        probe.parse_probe_args(["--probe", "https://example.com"])


def test_percentile_is_nearest_rank():
    assert probe.percentile([], 0.5) is None
    assert probe.percentile([30, 10, 20, 40], 0.5) == 20
    assert probe.percentile(list(range(1, 101)), 0.95) == 95
