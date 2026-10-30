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
import time
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


def test_probe_reads_the_option_equals_value_items_the_job_passes():
    # infra/check-matting.sh sends each option as one --option=value item (gcloud refuses a repeated item in --args).
    args = probe.parse_probe_args(["--probe", "https://candidate---svc-abc.a.run.app", "--models=birefnet-general,bria-rmbg",
                                   "--concurrency=1", "--rounds=1"])
    assert args.models == ["birefnet-general", "bria-rmbg"] and args.concurrency == 1 and args.rounds == 1
    assert args.url == "https://candidate---svc-abc.a.run.app"


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


# Spec 18 H1: the upscale probe against a fake /upscale service on localhost.
class FakeUpscale:
    """Answers /upscale with the received JPEG at 2x (deterministic), or per `mode`: noisy (different bytes every call),
    wrong-size, busy (503), or visible (instance up02 answers with a visible mark). `instances` are the instance ids the
    calls rotate over (the X-Instance-Id header); `busy_calls` are the call numbers (from 1) answered 429. /health reports vCPU,
    threads, the tile once a call has loaded the model, and `uptime` (seconds since the instance started)."""

    def __init__(self, mode="ok", instances=("up01",), busy_calls=(), uptime=1000.0, health_delay=0.0):
        self.mode, self.calls, self.loaded = mode, [], False
        self.instances, self.busy_calls, self.uptime, self.health_delay = list(instances), set(busy_calls), uptime, health_delay
        self.health_calls = 0
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body, kind, instance=None):
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                if instance:
                    self.send_header("X-Instance-Id", instance)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                with fake.lock:
                    fake.health_calls += 1
                if fake.health_delay:
                    time.sleep(fake.health_delay)
                body = {"ok": True, "instanceId": "up01", "uptimeS": fake.uptime, "vcpu": 4, "threads": 4, "preloadMatte": False, "candidate": "catalog-upscale-00001-abc",
                        "upscale": {"models": [{"id": "swinir-x2", "available": True, "scale": 2}, {"id": "swinir-x4", "available": True, "scale": 4}], "default": "swinir-x2"},
                        "upscaleTiles": {"swinir-x2": 384, "swinir-x4": 384} if fake.loaded else {}}
                self.reply(200, json.dumps(body).encode(), "application/json")

            def do_POST(self):
                data = self.rfile.read(int(self.headers["Content-Length"]))
                with fake.lock:
                    fake.calls.append(self.path)
                    fake.loaded = True
                    count = len(fake.calls)
                instance = fake.instances[(count - 1) % len(fake.instances)]
                if count in fake.busy_calls:
                    return self.reply(429, b'{"error": "no instance free"}', "application/json")
                if fake.mode == "busy":
                    return self.reply(503, b'{"error": "upscale model swinir-x2 unavailable"}', "application/json")
                with Image.open(io.BytesIO(data)) as source:
                    factor = 1 if fake.mode == "wrong-size" else int(self.path.rsplit("scale=", 1)[1])
                    out = source.convert("RGB").resize((source.width * factor, source.height * factor), Image.Resampling.NEAREST)
                if fake.mode == "noisy":
                    out.paste((count * 40 % 256, 0, 0), (0, 0, 16, 16))
                if fake.mode == "visible" and instance == "up02":
                    out.paste((255, 0, 0), (0, 0, 16, 16))
                encoded = io.BytesIO()
                out.save(encoded, format="JPEG", quality=95)
                self.reply(200, encoded.getvalue(), "image/jpeg", instance)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


@pytest.fixture
def fake_upscale():
    servers = []

    def start(**kwargs):
        servers.append(FakeUpscale(**kwargs))
        return servers[-1]
    yield start
    for fake in servers:
        fake.server.shutdown()
        fake.server.server_close()


def run_upscale_probe(url, *args):
    reports = []
    code = probe.probe_upscale_main(["--probe-upscale", url, *args, "--run", "up-run"],
                                    report_writer=lambda run, report, file: (reports.append((file, report)), f"gs://bucket/{run}/{file}")[1],
                                    sleep=lambda seconds: None)
    return code, reports


BUCKET = ["--bucket", "image-links-agent-assets"]


def test_upscale_probe_measures_each_size_and_prints_the_table(fake_upscale, capsys):
    fake = fake_upscale()
    code, reports = run_upscale_probe(fake.url, "--sizes", "64x96,80x80", "--concurrency", "2", "--rounds", "2", *BUCKET)
    assert code == 0
    # Per size: 1 warm call, then 2 rounds of 2 calls at once.
    assert len(fake.calls) == 2 * (1 + 2 * 2) and all(c == "/upscale?model=swinir-x2&scale=2" for c in fake.calls)
    file, report = reports[0]
    assert file == "upscale.json" and report["passed"] is True and report["service"]["vcpu"] == 4
    rows = {r["size"]: r for r in report["rows"]}
    assert set(rows) == {"64x96", "80x80"}
    for row in rows.values():
        assert (row["vcpu"], row["threads"], row["tile"], row["concurrency"], row["non200"], row["calls"]) == (4, 4, 384, 2, 0, 5)
        assert row["distinctOutputs"] == 1 and len(row["outputSha256"]) == 64
        assert row["p50S"] is not None and row["p95S"] >= row["p50S"] and row["maxS"] >= row["p95S"]
    out = capsys.readouterr().out.splitlines()
    assert out[0] == "| model | size | vCPU | threads | tile | conc | p50 s | p95 s | max s | non-200 | output sha256 |"
    assert out[2].startswith("| swinir-x2 | 64x96 | 4 | 4 | 384 | 2 | ") and out[2].endswith(f" | 0 | {rows['64x96']['outputSha256'][:16]} |")
    assert json.loads(out[-1]) == {"probe": "up-run", "passed": True, "failures": [], "report": "gs://bucket/up-run/upscale.json"}


def test_upscale_markdown_shows_missing_values_as_dashes():
    rows = [{"model": "swinir-x4", "size": "800x1200", "vcpu": None, "threads": 8, "tile": None, "concurrency": 1, "p50S": None, "p95S": None, "maxS": None,
             "non200": 3, "outputSha256": None}]
    assert probe.upscale_markdown(rows).splitlines()[2] == "| swinir-x4 | 800x1200 | - | 8 | - | 1 | - | - | - | 3 | - |"


def test_upscale_probe_output_sha_is_stable_across_runs(fake_upscale):
    # The same input gives the same bytes on every run, so two probes (two thread counts) can be compared by sha.
    fake = fake_upscale()
    first = run_upscale_probe(fake.url, "--sizes", "64x96", "--rounds", "2", *BUCKET)[1][0][1]
    second = run_upscale_probe(fake.url, "--sizes", "64x96", "--rounds", "1", *BUCKET)[1][0][1]
    assert first["rows"][0]["outputSha256"] == second["rows"][0]["outputSha256"]
    assert probe.upscale_image(64, 96) == probe.upscale_image(64, 96)


@pytest.mark.parametrize(("mode", "failure"), [("noisy", "swinir-x2 64x96: instance up01 gave 3 different outputs for the same input"),
                                                ("wrong-size", "swinir-x2 64x96: 3 non-200"), ("busy", "swinir-x2 64x96: 3 non-200")])
def test_upscale_probe_fails_on_differing_output_wrong_size_or_non_200(fake_upscale, mode, failure):
    code, reports = run_upscale_probe(fake_upscale(mode=mode).url, "--sizes", "64x96", "--rounds", "2", *BUCKET)
    assert code == 1 and failure in reports[0][1]["failures"]


def test_upscale_probe_without_a_bucket_writes_no_report(fake_upscale, capsys):
    code, reports = run_upscale_probe(fake_upscale().url, "--sizes", "64x96", "--rounds", "1")
    assert code == 0 and reports == []
    assert json.loads(capsys.readouterr().out.splitlines()[-1])["report"] is None


def test_upscale_probe_counts_an_unreachable_service(fake_upscale):
    fake = fake_upscale()
    fake.server.shutdown()
    fake.server.server_close()
    code, reports = run_upscale_probe(fake.url, "--sizes", "64x96", "--rounds", "1", *BUCKET)
    assert code == 1
    assert reports[0][1]["failures"] == ["swinir-x2 64x96: 2 non-200", "swinir-x2: health unreadable after baseline",
                                         "swinir-x2: health unreadable after warm 64x96"]


def test_upscale_probe_reads_the_option_equals_value_items_the_job_passes():
    args = probe.parse_upscale_args(["--probe-upscale", "https://candidate---catalog-upscale-abc-el.a.run.app", "--model=swinir-x2",
                                     "--sizes=800x1200,1600x1600", "--concurrency=2", "--rounds=3", "--timeout=870", "--bucket=image-links-agent-assets"])
    assert args.sizes == [(800, 1200), (1600, 1600)] and args.concurrency == 2 and args.rounds == 3 and args.timeout == 870
    assert probe.parse_upscale_args(["--probe-upscale=https://catalog-upscale-abc-el.a.run.app"]).sizes == [(800, 1200), (1600, 1600)]


def test_upscale_sizes_parsing():
    assert probe.parse_sizes("800x1200") == [(800, 1200)]
    assert probe.parse_sizes(" 800X1200 , 1600x1600 ") == [(800, 1200), (1600, 1600)]
    for bad, message in [("800*1200", "must look like"), ("800x1200,800x1200", "twice"), ("32x32", "64 to 4000"), ("", "must look like")]:
        with pytest.raises(probe.CheckFailure, match=message):
            probe.parse_sizes(bad)


@pytest.mark.parametrize("args", [["--model", "esrgan-x4"], ["--model", "realesrgan-x2plus"], ["--model", "swinir-x2,esrgan-x4"], ["--model", ","], ["--concurrency", "0"], ["--rounds", "51"], ["--timeout", "5"],
                                  ["--bucket", "image-links-agent-public"], ["--run", "../x"], ["--x4-ratio", "0.5"], ["--x4-ratio", "-1"]])
def test_upscale_probe_refuses_bad_arguments(args):
    with pytest.raises(probe.CheckFailure):
        probe.parse_upscale_args(["--probe-upscale", "https://svc-abc.a.run.app", *args])
    with pytest.raises(probe.CheckFailure, match="probe URL"):
        probe.parse_upscale_args(["--probe-upscale", "https://example.com"])


def test_upscale_probe_mints_the_token_again_after_50_minutes():
    minted, now = [], [0.0]

    def mint():
        minted.append(now[0])
        return f"tok{len(minted)}"
    token = probe.RefreshingToken(mint, clock=lambda: now[0])
    assert token() == "tok1"
    now[0] = 49 * 60
    assert token() == "tok1" and len(minted) == 1
    now[0] = 50 * 60
    assert token() == "tok2" and minted == [0.0, 3000]
    up = probe.UpscaleProbe("http://127.0.0.1:1", token, "swinir-x2", [(64, 96)], 30)
    assert up.token == "tok2"
    now[0] = 101 * 60
    assert up.token == "tok3"
    assert probe.UpscaleProbe("http://127.0.0.1:1", None, "swinir-x2", [(64, 96)], 30).token is None


def test_upscale_probe_asks_for_a_token_for_the_service_audience(monkeypatch):
    seen = []
    monkeypatch.setattr(probe.UpscaleProbe, "run", lambda self, concurrency, rounds: None)
    code = probe.probe_upscale_main(["--probe-upscale", "https://candidate---catalog-upscale-abc.a.run.app", "--sizes", "64x96"],
                                    token_for=lambda audience: seen.append(audience) or "tok")
    assert code == 0 and seen == ["https://catalog-upscale-abc.a.run.app"]


def test_upscale_probe_times_x2_and_x4_and_checks_each_reruns_identically(fake_upscale, capsys):
    # Spec 18 quality: the gate probes both served models; each answer must be the model's own scale, and the warm
    # call plus one round already compare two outputs of the same input per model.
    fake = fake_upscale()
    code, reports = run_upscale_probe(fake.url, "--model=swinir-x2,swinir-x4", "--sizes", "64x96", "--rounds", "1", *BUCKET)
    assert code == 0
    assert fake.calls == ["/upscale?model=swinir-x2&scale=2"] * 2 + ["/upscale?model=swinir-x4&scale=4"] * 2
    report = reports[0][1]
    assert report["models"] == ["swinir-x2", "swinir-x4"] and report["passed"] is True
    assert [(r["model"], r["scale"], r["calls"], r["distinctOutputs"]) for r in report["rows"]] == [("swinir-x2", 2, 2, 1), ("swinir-x4", 4, 2, 1)]
    out = capsys.readouterr().out.splitlines()
    assert out[2].startswith("| swinir-x2 | 64x96 |") and out[3].startswith("| swinir-x4 | 64x96 |")


def test_upscale_probe_fails_an_x4_that_does_not_rerun_identically(fake_upscale):
    code, reports = run_upscale_probe(fake_upscale(mode="noisy").url, "--model=swinir-x4", "--sizes", "64x96", "--rounds", "1", *BUCKET)
    assert code == 1 and "swinir-x4 64x96: instance up01 gave 2 different outputs for the same input" in reports[0][1]["failures"]


def test_x4_ratio_check_fails_an_x4_slower_than_the_ratio_allows():
    # 2026-10-29 review P2-1: the x4 cap assumes x4 takes at most UPSCALE_X4_TIME_RATIO x the x2 time; the gate's probe
    # measures it at each size probed on both models.
    def row(model, scale, size, p95):
        return {"model": model, "scale": scale, "size": size, "p95S": p95}
    rows = [row("swinir-x2", 2, "800x1200", 100.0), row("swinir-x4", 4, "800x1200", 125.0),
            row("swinir-x2", 2, "1600x1600", 200.0), row("swinir-x4", 4, "1600x1600", 300.0), row("swinir-x4", 4, "64x96", 9.0)]
    failures = probe.x4_ratio_failures(rows, 1.3)
    assert len(failures) == 1 and failures[0].startswith("swinir-x4 1600x1600: p95 300.0 s is 1.50 x the swinir-x2 p95 200.0 s")
    assert "UPSCALE_X4_TIME_RATIO=1.3" in failures[0] and "UPSCALE_MAX_PIXELS_X4" in failures[0]
    assert probe.x4_ratio_failures(rows, 0) == []
    assert probe.x4_ratio_failures(rows, 1.5) == []


def test_upscale_probe_reads_the_x4_ratio_the_gate_passes():
    args = probe.parse_upscale_args(["--probe-upscale", "https://svc-abc.a.run.app", "--model=swinir-x2,swinir-x4", "--x4-ratio=1.3"])
    assert args.x4_ratio == 1.3
    assert probe.parse_upscale_args(["--probe-upscale", "https://svc-abc.a.run.app"]).x4_ratio == 0


# Spec 18 gate (plan 7.2, 2026-10-30 finding 1): outputs of the same input from different instances may differ by float
# rounding on different CPU platforms; the probe compares them pixel by pixel and fails only on a visible difference.
def lossless(array):
    encoded = io.BytesIO()
    Image.fromarray(array).save(encoded, format="PNG")
    return encoded.getvalue()


def test_pixel_difference_reports_max_mean_share_and_psnr():
    import numpy as np
    base = np.full((40, 50, 3), 120, dtype=np.uint8)
    nudged = base.copy()
    nudged[0:4, 0:5] += 2  # 20 of 2000 pixels, 2 levels on every channel
    d = probe.pixel_difference(lossless(base), lossless(nudged))
    assert (d["sameSize"], d["maxAbs"], d["meanAbs"], d["sharePixels"]) == (True, 2, 0.02, 0.01)
    assert d["psnrDb"] == round(10 * __import__("math").log10(255 ** 2 / 0.04), 2)
    assert probe.visually_identical(d)
    same = probe.pixel_difference(lossless(base), lossless(base))
    assert same["maxAbs"] == 0 and same["psnrDb"] is None and probe.visually_identical(same)
    seam = base.copy()
    seam[:, 25] = 200  # a one-column seam, 80 levels
    assert not probe.visually_identical(probe.pixel_difference(lossless(base), lossless(seam)))
    assert probe.pixel_difference(lossless(base), lossless(base[:20]))["sameSize"] is False


def answer(digest, instance):
    return probe.UpscaleAnswer(200, 1.0, digest, instance)


def test_judge_outputs_allows_a_negligible_cross_instance_difference_and_fails_a_visible_one():
    import numpy as np
    base = np.full((40, 50, 3), 120, dtype=np.uint8)
    small, big = base.copy(), base.copy()
    small[0, 0] += 1
    big[0:10, 0:10] = 0
    bodies = {"a": lossless(base), "b": lossless(small), "c": lossless(big)}
    summary, failures = probe.judge_outputs("x", [answer("a", "i1"), answer("a", "i1"), answer("b", "i2")], bodies)
    assert failures == [] and summary["distinctOutputs"] == 2 and summary["instances"] == 2
    assert summary["outputs"] == {"a": ["i1"], "b": ["i2"]} and summary["worst"]["maxAbs"] == 1
    summary, failures = probe.judge_outputs("x", [answer("a", "i1"), answer("c", "i2")], bodies)
    assert failures == ["x: outputs from different instances differ visibly (max 120/255, PSNR " + str(summary["worst"]["psnrDb"]) + " dB; the limit is 8/255 and 60 dB)"]
    # One instance with two outputs is a race inside one process: a failure however small the difference.
    _, failures = probe.judge_outputs("x", [answer("a", "i1"), answer("b", "i1")], bodies)
    assert failures == ["x: instance i1 gave 2 different outputs for the same input"]
    summary, failures = probe.judge_outputs("x", [answer("a", "i1"), probe.UpscaleAnswer(503, 1.0)], bodies)
    assert failures == [] and summary["distinctOutputs"] == 1 and summary["worst"] is None


def test_upscale_probe_records_the_instance_of_every_answer_and_passes_identical_outputs_across_instances(fake_upscale):
    fake = fake_upscale(instances=("up01", "up02"))
    code, reports = run_upscale_probe(fake.url, "--sizes", "64x96", "--concurrency", "2", "--rounds", "1", *BUCKET)
    row = reports[0][1]["rows"][0]
    assert code == 0 and row["instances"] == 2 and row["distinctOutputs"] == 1
    assert list(row["outputs"].values()) == [["up01", "up02"]]
    assert len(row["callLog"]) == 3 and {c["instance"] for c in row["callLog"]} == {"up01", "up02"}
    assert all(c["sha256"] == row["outputSha256"] for c in row["callLog"])


def test_upscale_probe_fails_a_visible_difference_between_instances(fake_upscale):
    fake = fake_upscale(mode="visible", instances=("up01", "up02"))
    code, reports = run_upscale_probe(fake.url, "--sizes", "64x96", "--concurrency", "2", "--rounds", "1", *BUCKET)
    assert code == 1
    [failure] = reports[0][1]["failures"]
    assert failure.startswith("swinir-x2 64x96: outputs from different instances differ visibly (max ")


def test_determinism_round_calls_at_once_with_sha_and_instance_per_call(fake_upscale, capsys):
    fake = fake_upscale(instances=("up01", "up02", "up03"), busy_calls=(3, 4))
    code, reports = run_upscale_probe(fake.url, "--sizes", "64x96", "--rounds", "1", "--determinism-calls=4", *BUCKET)
    assert code == 0, reports[0][1]["failures"]
    [entry] = reports[0][1]["determinism"]
    # The two 429s were retried; 4 answers, each with its sha256 and instance; one round was enough (3 instances).
    assert entry["size"] == "800x1200" and entry["rounds"] == 1 and len(entry["calls"]) == 4
    assert all(c["status"] == 200 and len(c["sha256"]) == 64 and c["instance"] in {"up01", "up02", "up03"} for c in entry["calls"])
    assert entry["instances"] >= 2 and entry["distinctOutputs"] == 1 and entry["passed"] is True
    assert "/upscale?model=swinir-x2&scale=2" in fake.calls[-1]
    out = capsys.readouterr().out
    assert "determinism swinir-x2 800x1200: 4 calls, " in out and "1 distinct outputs (byte-identical): passed" in out


def test_determinism_round_repeats_then_fails_when_one_instance_answers(fake_upscale):
    fake = fake_upscale(instances=("up01",))
    code, reports = run_upscale_probe(fake.url, "--sizes", "64x96", "--rounds", "1", "--determinism-calls=2", *BUCKET)
    [entry] = reports[0][1]["determinism"]
    assert code == 1 and entry["rounds"] == 3 and len(entry["calls"]) == 6
    assert "swinir-x2 800x1200 determinism: 1 instance(s) answered in 3 rounds of 2 calls; at least 2 are needed" in reports[0][1]["failures"]


def test_determinism_round_fails_a_visible_cross_instance_difference(fake_upscale):
    fake = fake_upscale(mode="visible", instances=("up01", "up02"))
    code, reports = run_upscale_probe(fake.url, "--model=swinir-x4", "--sizes", "64x96", "--rounds", "1", "--determinism-calls=2", *BUCKET)
    assert code == 1
    assert any(f.startswith("swinir-x4 800x1200 determinism: outputs from different instances differ visibly") for f in reports[0][1]["failures"])


def test_cold_start_is_timed_on_a_fresh_instance_while_a_call_holds_another(fake_upscale, capsys):
    fake = fake_upscale(uptime=0.0)
    code, reports = run_upscale_probe(fake.url, "--sizes", "64x96", "--rounds", "1", "--cold-start-max=120", *BUCKET)
    cold = reports[0][1]["coldStart"]
    assert code == 0 and cold["passed"] is True and cold["coldStartS"] is not None and cold["limitS"] == 120
    assert len(cold["attempts"]) == 1 and cold["attempts"][0]["fresh"] is True and len(cold["holds"]) == 1
    # The hold is an /upscale call of the first model at 800x1200, made before anything else.
    assert fake.calls[0] == "/upscale?model=swinir-x2&scale=2"
    assert "UPSCALE_COLD_START_S measured: " in capsys.readouterr().out


def test_cold_start_fails_when_only_warm_instances_answer_or_when_too_slow(fake_upscale):
    code, reports = run_upscale_probe(fake_upscale(uptime=1000.0).url, "--sizes", "64x96", "--rounds", "1", "--cold-start-max=120", *BUCKET)
    cold = reports[0][1]["coldStart"]
    assert code == 1 and len(cold["attempts"]) == 3 and len(cold["holds"]) == 3 and cold["coldStartS"] is None
    assert "cold start not measured: no /health in 3 tries came from a fresh instance" in reports[0][1]["failures"]
    code, reports = run_upscale_probe(fake_upscale(uptime=0.0, health_delay=1.2).url, "--sizes", "64x96", "--rounds", "1", "--cold-start-max=1", *BUCKET)
    assert code == 1 and any(f.startswith("cold start 1.") and "above UPSCALE_COLD_START_S=1 (infra/lib/shape.sh)" in f for f in reports[0][1]["failures"])


@pytest.mark.parametrize("args", [["--determinism-calls=1"], ["--determinism-calls=17"], ["--cold-start-max=-1"], ["--cold-start-max=3601"]])
def test_upscale_probe_refuses_bad_gate_options(args):
    with pytest.raises(probe.CheckFailure):
        probe.parse_upscale_args(["--probe-upscale", "https://svc-abc.a.run.app", *args])
    parsed = probe.parse_upscale_args(["--probe-upscale", "https://svc-abc.a.run.app", "--determinism-calls=12", "--cold-start-max=120"])
    assert (parsed.determinism_calls, parsed.cold_start_max) == (12, 120)


def test_visual_limit_passes_the_measured_cross_instance_difference_and_fails_a_shift_or_a_seam():
    # 2026-10-30 on live catalog-upscale (.runs/2026-10-30-18-post-deploy-fixes.md): x2 max 1, 98 dB; x4 max 3, 93 dB.
    assert probe.visually_identical({"maxAbs": 1, "psnrDb": 97.95}) and probe.visually_identical({"maxAbs": 3, "psnrDb": 93.05})
    assert not probe.visually_identical({"maxAbs": 3, "psnrDb": 38.6}), "a 3-level colour cast on every pixel"
    assert not probe.visually_identical({"maxAbs": 40, "psnrDb": 70.0}), "a local defect such as a seam"
