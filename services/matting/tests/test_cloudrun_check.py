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
    threads, the tile once a call has loaded the model, and `uptime` (seconds since the instance started). `work_ms(path,
    count)`, when given, is the X-Upscale-Ms header of each answer (the service's inference time; None leaves it out)."""

    def __init__(self, mode="ok", instances=("up01",), busy_calls=(), uptime=1000.0, health_delay=0.0, work_ms=None):
        self.mode, self.calls, self.loaded, self.work_ms = mode, [], False, work_ms
        self.instances, self.busy_calls, self.uptime, self.health_delay = list(instances), set(busy_calls), uptime, health_delay
        self.health_calls = 0
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body, kind, instance=None, ms=None):
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                if instance:
                    self.send_header("X-Instance-Id", instance)
                if ms is not None:
                    self.send_header("X-Upscale-Ms", str(ms))
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
                self.reply(200, encoded.getvalue(), "image/jpeg", instance, fake.work_ms and fake.work_ms(self.path, count))

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
                                  ["--bucket", "image-links-agent-public"], ["--run", "../x"], ["--x4-max-pixels", "-1"], ["--x4-max-pixels", "100000001"], ["--x2-max-pixels", "-1"], ["--x2-max-pixels", "100000001"]])
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


# The x4 timeout check (2026-10-31): the x4 cap must fit the timeout at the measured x4 p95 per megapixel, judged over
# every timed call of a size (the rounds and the determinism round), with one slow call set aside from 10 calls up.
SMALL, LARGE = (800, 1200), (1600, 1600)


def test_timing_p95_sets_aside_one_slow_call_only_with_enough_calls():
    assert probe.timing_p95([]) is None and probe.timing_p95([145.2]) == 145.2
    # 9 calls: judged whole, so the slow call is the p95.
    assert probe.timing_p95([130.0] * 8 + [300.0]) == 300.0
    # 13 calls (the gate's 1 round + 12 determinism calls): the second slowest.
    assert probe.timing_p95([130.0] * 11 + [140.0, 300.0]) == 140.0
    assert probe.timing_p95([130.0] * 11 + [290.0, 300.0]) == 290.0


def test_x4_timeout_check_passes_one_slow_outlier():
    # 12 calls near the measured 123 to 145 s and one call at 300 s (a noisy neighbour): set aside, the gate passes.
    x4 = [124.0, 126.0, 128.0, 129.0, 130.0, 131.0, 133.0, 135.0, 137.0, 140.0, 142.0, 145.2, 300.0]
    entry, failures = probe.cap_timeout_check({"swinir-x2": {SMALL: [96.4] * 13, LARGE: [199.1]}, "swinir-x4": {SMALL: x4, LARGE: [248.9]}},
                                             {4: 4_900_000}, 1740)
    assert failures == [] and entry["passed"] is True
    [model] = entry["models"]
    # The second slowest, 145.2 s, over 0.96 MP; the 1600x1600 call (97 s per MP) is not the worst.
    assert (model["worstSize"], model["sPerMp"], model["needS"]) == ("800x1200", 151.25, 1482.2)
    small = next(s for s in model["sizes"] if s["size"] == "800x1200")
    assert (small["calls"], small["p50S"], small["maxS"], small["x4OverX2Median"]) == (13, 133.0, 300.0, 1.38)


def test_x4_timeout_check_fails_a_consistently_slow_x4():
    # Every call at 180 s: 187.5 s per MP x 4.9 MP x 2 = 1838 s, above 1740 s.
    entry, failures = probe.cap_timeout_check({"swinir-x4": {SMALL: [180.0] * 13, LARGE: [250.0]}}, {4: 4_900_000}, 1740)
    assert entry["passed"] is False and len(failures) == 1
    assert failures[0] == ("swinir-x4: UPSCALE_MAX_PIXELS_X4=4900000 needs 2 x 919 s = 1838 s at the slowest measured p95 of 187.5 s per MP "
                           "(800x1200, 13 calls), above the 1740 s timeout; lower UPSCALE_MAX_PIXELS_X4 to at most 4640000 and raise "
                           "UPSCALE_X4_TIME_RATIO to match (infra/lib/shape.sh)")


def test_x4_timeout_check_fails_two_slow_calls_in_thirteen():
    # Two slow calls are a tail, not an outlier: the second slowest (185 s) is judged.
    _, failures = probe.cap_timeout_check({"swinir-x4": {SMALL: [130.0] * 11 + [185.0, 190.0]}}, {4: 4_900_000}, 1740)
    assert len(failures) == 1 and "192.71 s per MP" in failures[0]


def test_x4_timeout_check_on_the_refused_revision_and_the_old_cap():
    # 2026-10-30 (.runs/2026-10-30-18-cpu-scale.md): x4 145.2 s at 800x1200 against x2 96.4 s, ratio 1.51, refused. The
    # property itself: 151.25 s per MP fits 4.9 MP (2 x 741 s) but not the old 6.4 MP cap (2 x 968 s > 1740 s).
    timings = {"swinir-x2": {SMALL: [96.4], LARGE: [199.1]}, "swinir-x4": {SMALL: [145.2], LARGE: [248.9]}}
    assert probe.cap_timeout_check(timings, {4: 4_900_000}, 1740)[1] == []
    [failure] = probe.cap_timeout_check(timings, {4: 6_400_000}, 1740)[1]
    assert failure.startswith("swinir-x4: UPSCALE_MAX_PIXELS_X4=6400000 needs 2 x 968 s = 1936 s")


def test_x4_timeout_check_needs_a_timed_x4_call_and_off_checks_nothing():
    assert probe.cap_timeout_check({"swinir-x4": {SMALL: [500.0]}}, {4: 0}, 1740) == (None, [])
    entry, failures = probe.cap_timeout_check({"swinir-x2": {SMALL: [96.0]}}, {4: 4_900_000}, 1740)
    assert failures == ["x4 timeout check: no x4 call was timed, so UPSCALE_MAX_PIXELS_X4=4900000 is not shown to fit the 1740 s timeout"]


def test_upscale_probe_times_the_x4_check_on_the_service_time_of_rounds_and_determinism_calls(fake_upscale, capsys):
    # The service reports its inference time (X-Upscale-Ms); the determinism round's calls count too, and their client
    # time (here milliseconds) never enters the check. x4 at 64x96 (0.006144 MP): 1.2 s is 195.3 s per MP.
    fake = fake_upscale(instances=("up01", "up02"), work_ms=lambda path, count: 1200 if "x4" in path else 600)
    code, reports = run_upscale_probe(fake.url, "--model=swinir-x2,swinir-x4", "--sizes", "64x96", "--rounds", "1",
                                      "--determinism-calls=2", "--timeout=60", "--x4-max-pixels=100000", *BUCKET)
    report = reports[0][1]
    assert code == 0, report["failures"]
    [model] = report["capTimeout"]["models"]
    assert [(s["size"], s["calls"], s["p95S"]) for s in model["sizes"]] == [("64x96", 1, 1.2), ("800x1200", 2, 1.2)]
    assert model["worstSize"] == "64x96" and model["sPerMp"] == 195.31 and model["needS"] == 39.1 and model["passed"] is True
    assert report["determinism"][1]["calls"][0]["serverS"] == 1.2
    assert "cap timeout swinir-x4: 2 x 195.31 s per MP (64x96 p95) x 0.1 MP = 39.1 s (timeout 60 s): passed" in capsys.readouterr().out
    # The same service with a 30 s timeout: 39.1 s does not fit, the probe fails with the cap that would.
    code, reports = run_upscale_probe(fake.url, "--model=swinir-x2,swinir-x4", "--sizes", "64x96", "--rounds", "1",
                                      "--timeout=30", "--x4-max-pixels=100000", *BUCKET)
    assert code == 1 and any(f.startswith("swinir-x4: UPSCALE_MAX_PIXELS_X4=100000 needs 2 x 20 s = 39 s") and "at most 76800" in f
                             for f in reports[0][1]["failures"])


def test_upscale_probe_without_the_service_time_uses_the_client_time(fake_upscale):
    fake = fake_upscale()
    code, reports = run_upscale_probe(fake.url, "--model=swinir-x4", "--sizes", "64x96", "--rounds", "1", "--x4-max-pixels=100000", *BUCKET)
    [model] = reports[0][1]["capTimeout"]["models"]
    [row] = reports[0][1]["rows"]
    assert code == 0 and row["callLog"][0]["serverS"] is None
    # The one measured call's client time (the row's p95) is the check's p95.
    assert model["sizes"][0]["calls"] == 1 and model["sizes"][0]["p95S"] == row["p95S"] and model["sPerMp"] > 0


def test_x2_cap_check_passes_one_slow_outlier():
    # The x2 cap gets the same rule: 12 calls across the measured 96 to 152 s range and one at 400 s, set aside. The
    # second slowest, 152 s (158.33 s per MP, the slowest x2 gate call on record), fits 5.4 MP: 2 x 855 = 1710 s.
    x2 = [96.4, 100.0, 102.3, 105.0, 110.0, 117.5, 120.0, 125.0, 129.0, 135.0, 140.0, 152.0, 400.0]
    entry, failures = probe.cap_timeout_check({"swinir-x2": {SMALL: x2, LARGE: [265.9]}}, {2: 5_400_000}, 1740)
    assert failures == [] and entry["passed"] is True
    [model] = entry["models"]
    assert (model["scale"], model["worstSize"], model["sPerMp"], model["needS"]) == (2, "800x1200", 158.33, 1710.0)


def test_x2_cap_check_fails_a_consistently_slow_x2():
    # Every x2 call at 170 s: 177.08 s per MP x 5.4 MP x 2 = 1912 s, above 1740 s.
    entry, failures = probe.cap_timeout_check({"swinir-x2": {SMALL: [170.0] * 13, LARGE: [300.0]}, "swinir-x4": {SMALL: [130.0] * 13}},
                                              {2: 5_400_000, 4: 4_900_000}, 1740)
    assert entry["passed"] is False and len(failures) == 1
    assert failures[0].startswith("swinir-x2: UPSCALE_MAX_PIXELS=5400000 needs 2 x 956 s = 1912 s at the slowest measured p95 of 177.08 s per MP "
                                  "(800x1200, 13 calls), above the 1740 s timeout; lower UPSCALE_MAX_PIXELS to at most 4913")
    assert failures[0].endswith("and raise UPSCALE_X2_TIME_RATIO to match (infra/lib/shape.sh)")
    # The x4 model at 135.42 s per MP fits its own cap; each cap is judged on its own model.
    assert [m["passed"] for m in entry["models"]] == [False, True]


def test_x2_cap_check_on_the_slowest_x2_gate_call_and_the_old_cap():
    # 00005-fec (2026-10-30): x2 152 s at 800x1200 in one call. 158.33 s per MP fits 5.4 MP but not the old 8 MP cap
    # (2 x 1267 s = 2533 s > 1740 s).
    timings = {"swinir-x2": {SMALL: [152.0], LARGE: [241.0]}}
    assert probe.cap_timeout_check(timings, {2: 5_400_000}, 1740)[1] == []
    [failure] = probe.cap_timeout_check(timings, {2: 8_000_000}, 1740)[1]
    assert failure.startswith("swinir-x2: UPSCALE_MAX_PIXELS=8000000 needs 2 x 1267 s = 2533 s")
    assert probe.cap_timeout_check({"swinir-x4": {SMALL: [130.0]}}, {2: 5_400_000}, 1740)[1] == [
        "x2 timeout check: no x2 call was timed, so UPSCALE_MAX_PIXELS=5400000 is not shown to fit the 1740 s timeout"]


def test_upscale_probe_checks_both_caps_the_gate_passes(fake_upscale, capsys):
    fake = fake_upscale(instances=("up01", "up02"), work_ms=lambda path, count: 1200 if "x4" in path else 600)
    code, reports = run_upscale_probe(fake.url, "--model=swinir-x2,swinir-x4", "--sizes", "64x96", "--rounds", "1", "--timeout=60",
                                      "--x2-max-pixels=100000", "--x4-max-pixels=100000", *BUCKET)
    report = reports[0][1]
    assert code == 0, report["failures"]
    assert report["capTimeout"]["caps"] == {"x2": 100000, "x4": 100000}
    assert [(m["model"], m["sPerMp"], m["needS"]) for m in report["capTimeout"]["models"]] == [("swinir-x2", 97.66, 19.5), ("swinir-x4", 195.31, 39.1)]
    out = capsys.readouterr().out
    assert "cap timeout swinir-x2: 2 x 97.66 s per MP (64x96 p95) x 0.1 MP = 19.5 s (timeout 60 s): passed" in out


def test_upscale_probe_reads_the_x4_cap_the_gate_passes():
    args = probe.parse_upscale_args(["--probe-upscale", "https://svc-abc.a.run.app", "--model=swinir-x2,swinir-x4", "--x2-max-pixels=5400000",
                                     "--x4-max-pixels=4900000"])
    assert (args.x2_max_pixels, args.x4_max_pixels) == (5_400_000, 4_900_000)
    default = probe.parse_upscale_args(["--probe-upscale", "https://svc-abc.a.run.app"])
    assert (default.x2_max_pixels, default.x4_max_pixels) == (0, 0)


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


def full_image_difference(first, second):
    """The comparison before the 2026-10-30 OOM fix: both images decoded and held in full. The reference for equality."""
    import math
    import numpy as np
    with Image.open(io.BytesIO(first)) as a, Image.open(io.BytesIO(second)) as b:
        pa, pb = np.asarray(a.convert("RGB")).astype(np.int64), np.asarray(b.convert("RGB")).astype(np.int64)
    if pa.shape != pb.shape:
        return {"sameSize": False, "maxAbs": 255, "meanAbs": None, "sharePixels": None, "psnrDb": 0.0}
    diff = np.abs(pa - pb)
    mse = int((diff ** 2).sum()) / pa.size
    return {"sameSize": True, "maxAbs": int(diff.max()), "meanAbs": round(int(diff.sum()) / pa.size, 5),
            "sharePixels": round(int((diff.max(axis=2) > 0).sum()) / (pa.shape[0] * pa.shape[1]), 6),
            "psnrDb": None if mse == 0 else round(10 * math.log10(255 ** 2 / mse), 2)}


def jpeg(array, quality=95):
    encoded = io.BytesIO()
    Image.fromarray(array).save(encoded, format="JPEG", quality=quality)
    return encoded.getvalue()


@pytest.mark.parametrize("band_pixels", [1, 100, 1000, 1 << 20])
def test_pixel_difference_in_bands_equals_the_full_image_comparison(monkeypatch, band_pixels):
    import numpy as np
    # Bands of 1 row, a few rows (not dividing the height) and the whole image give the same numbers.
    monkeypatch.setattr(probe, "DIFFERENCE_BAND_PIXELS", band_pixels)
    rng = np.random.default_rng(18)
    base = rng.integers(0, 256, (97, 61, 3), dtype=np.uint8)
    noise = np.clip(base.astype(np.int16) + rng.integers(-3, 4, base.shape), 0, 255).astype(np.uint8)
    seam = base.copy()
    seam[:, 30] = 255 - seam[:, 30]
    gray = Image.fromarray(base).convert("L")
    gray_bytes = io.BytesIO()
    gray.save(gray_bytes, format="JPEG", quality=90)
    pairs = [(jpeg(base), jpeg(noise)), (jpeg(base), jpeg(base)), (jpeg(base), jpeg(seam)), (lossless(base), lossless(noise)),
             (jpeg(base), gray_bytes.getvalue()), (jpeg(base), jpeg(base[:50]))]
    for first, second in pairs:
        assert probe.pixel_difference(first, second) == full_image_difference(first, second)


PEAK_MEMORY_CHILD = r"""
import importlib.util, json, sys


def peak_bytes():
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
                (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
                                                     "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
                                                     "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")]

        counters = Counters(cb=ctypes.sizeof(Counters))
        process = ctypes.windll.kernel32.GetCurrentProcess
        process.restype = wintypes.HANDLE
        ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
        ctypes.windll.psapi.GetProcessMemoryInfo(process(), ctypes.byref(counters), counters.cb)
        return counters.PeakWorkingSetSize
    import resource
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)


spec = importlib.util.spec_from_file_location("cloudrun_check", sys.argv[1])
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
import numpy  # noqa: F401 - imported by pixel_difference; counted in the baseline, not in the comparison
first, second = open(sys.argv[2], "rb").read(), open(sys.argv[3], "rb").read()
before = peak_bytes()
difference = probe.pixel_difference(first, second)
print(json.dumps({"difference": difference, "baselineBytes": before, "peakBytes": peak_bytes()}))
"""


def test_pixel_difference_of_a_6400x6400_pair_needs_at_most_one_decode_and_one_compact_copy(tmp_path):
    """2026-10-30: comparing two 6400x6400 x4 outputs (1600x1600 at 4x) that differ by cross-instance float noise
    OOM-killed the 512 MiB probe job (the old comparison peaked at about 21 bytes per pixel, 905 MiB in all). Pillow
    cannot decode a JPEG in parts, so one decode (4 bytes per pixel) plus one uint8 copy (3) is the floor. In a fresh
    process, the comparison must add at most 9 bytes per pixel to the peak resident memory, and the whole process
    (interpreter, numpy, Pillow and both JPEG bodies) must stay under 512 MiB. The probe job has 1Gi for the bodies."""
    import subprocess
    import sys
    import numpy as np
    side = 6400
    ramp = np.linspace(0, 255, side, dtype=np.float32)
    photo = np.empty((side, side, 3), dtype=np.uint8)
    photo[..., 0] = ramp[None, :]
    photo[..., 1] = ramp[:, None]
    photo[..., 2] = 128
    first = jpeg(photo)
    photo[::97, ::89] ^= 3  # isolated pixels a few levels off, like the measured cross-instance noise
    second = jpeg(photo)
    del photo
    (tmp_path / "a.jpg").write_bytes(first)
    (tmp_path / "b.jpg").write_bytes(second)
    script = Path(__file__).with_name("cloudrun_check.py")
    done = subprocess.run([sys.executable, "-c", PEAK_MEMORY_CHILD, str(script), str(tmp_path / "a.jpg"), str(tmp_path / "b.jpg")],
                          capture_output=True, text=True, timeout=600, check=True)
    result = json.loads(done.stdout.strip().splitlines()[-1])
    difference = result["difference"]
    assert difference["sameSize"] is True and 0 < difference["maxAbs"] <= 255 and difference["sharePixels"] > 0
    added = result["peakBytes"] - result["baselineBytes"]
    measured = f"baseline {result['baselineBytes'] / 2 ** 20:.0f} MiB, peak {result['peakBytes'] / 2 ** 20:.0f} MiB, {added / side ** 2:.2f} bytes per pixel"
    print(measured)
    assert added < 9 * side * side, measured
    assert result["peakBytes"] < 512 * 2 ** 20, measured


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


def test_upscale_probe_keeps_one_body_per_distinct_output_and_drops_them_once_a_size_is_judged(fake_upscale, monkeypatch):
    fake = fake_upscale(mode="visible", instances=("up01", "up02"))
    up = probe.UpscaleProbe(fake.url, None, "swinir-x2", [(64, 96), (80, 80)], 30)
    kept, real_judge = [], probe.judge_outputs

    def judge(label, answers, bodies):
        kept.append((label, len(answers), sorted(bodies)))
        return real_judge(label, answers, bodies)
    monkeypatch.setattr(probe, "judge_outputs", judge)
    up.run(2, 1)
    # Each size was judged right after its calls, with one body per distinct sha256, and no body is left afterwards.
    assert [label for label, _, _ in kept] == ["swinir-x2 64x96", "swinir-x2 80x80"]
    for (label, calls, digests), entry in zip(kept, up.sizes.values()):
        assert calls == 3 and digests == sorted({a.digest for a in entry["answers"]}) and len(digests) == 2
        assert entry["bodies"] == {} and all(a.body is None and len(a.digest) == 64 for a in entry["answers"])
    rows = up.rows(2)
    assert [r["distinctOutputs"] for r in rows] == [2, 2] and all(r["outputFailures"] for r in rows)


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


def test_determinism_round_keeps_going_for_its_seconds_budget_when_one_instance_answers(fake_upscale):
    fake = fake_upscale(instances=("up01",))
    up = probe.UpscaleProbe(fake.url, None, "swinir-x2", [(64, 96)], 30)
    ticks = iter(range(0, 10_000, 10))
    entry = up.determinism_round(2, size=(64, 96), sleep=lambda s: None, seconds_budget=50, clock=lambda: next(ticks))
    # 3 rounds always, then one more per check while under 50 s (10, 20, 30, 40); the 50 s check stops it.
    assert entry["rounds"] == 7 and len(entry["calls"]) == 14 and entry["passed"] is False
    assert entry["failures"] == ["swinir-x2 64x96 determinism: 1 instance(s) answered in 7 rounds of 2 calls; at least 2 are needed"]
    # Without a budget it stops after DETERMINISM_ATTEMPTS rounds, as before.
    assert up.determinism_round(2, size=(64, 96), sleep=lambda s: None)["rounds"] == probe.DETERMINISM_ATTEMPTS


def test_upscale_probe_takes_determinism_seconds_and_refuses_a_bad_value():
    assert probe.parse_upscale_args(["--probe-upscale", "https://x.run.app", "--determinism-seconds=300"]).determinism_seconds == 300
    assert probe.parse_upscale_args(["--probe-upscale", "https://x.run.app"]).determinism_seconds == 0
    with pytest.raises(probe.CheckFailure):
        probe.parse_upscale_args(["--probe-upscale", "https://x.run.app", "--determinism-seconds=4000"])


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
