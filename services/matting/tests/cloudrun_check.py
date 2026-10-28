import argparse
import datetime
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

from PIL import Image, ImageDraw
from pillow_heif import register_heif_opener

MODELS = {"birefnet-general", "birefnet-general-lite", "birefnet-hrsod", "bria-rmbg"}
TIMEOUT = 180


class CheckFailure(Exception):
    """Only fixed diagnostic messages, safe for Cloud Logging."""


def require(condition, message):
    if not condition:
        raise CheckFailure(message)


def request(url, token=None, data=None, content_type=None):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if content_type:
        headers["Content-Type"] = content_type
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=TIMEOUT) as response:
        body = response.read(8_000_001)
        require(len(body) <= 8_000_000, "response exceeds check limit")
        return response.headers, body


def identity_token(audience):
    query = urllib.parse.urlencode({"audience": audience})
    url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?" + query
    req = urllib.request.Request(url, headers={"Metadata-Flavor": "Google"})
    with urllib.request.urlopen(req, timeout=10) as response:
        return response.read(32768).decode("ascii")


def upload(url, token, data, filename, mime):
    boundary = "catalog-check-" + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
            f"Content-Type: {mime}\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    return request(url, token, body, "multipart/form-data; boundary=" + boundary)


def png(headers, body, size):
    require(headers.get_content_type() == "image/png", "response is not image/png")
    require(body.startswith(b"\x89PNG\r\n\x1a\n"), "invalid PNG signature")
    image = Image.open(io.BytesIO(body))
    image.load()
    require(image.size == size, "PNG dimensions changed")
    require(int(headers.get("x-ms", "-1")) >= 0, "missing inference timing")
    return image


def check(target, url, version):
    # No authentication token is ever written to stdout or included in an error.
    try:
        request(url + "/health")
    except urllib.error.HTTPError as error:
        require(error.code in (401, 403), "unauthenticated request rejected with unexpected status")
    else:
        raise CheckFailure("service permits unauthenticated health request")
    token = identity_token(url)
    _, body = request(url + "/health", token)
    health = json.loads(body)
    require(health.get("ok") is True, "health is not ok")
    models = health.get("models", [])
    require(len(models) == 4 and {item.get("id") for item in models} == MODELS, "health model list differs")
    require(all(item.get("inputSize") == 1024 and item.get("target") == target for item in models), "health target/inputSize differs")
    require(health.get("default") == "birefnet-general", "health default differs")
    require(health.get("version") == version and version != "dev", "health version differs from deployed image tag")

    register_heif_opener()
    size = (256, 192)
    source = Image.new("RGB", size, "white")
    ImageDraw.Draw(source).rounded_rectangle((64, 40, 192, 160), radius=12, fill="#222244")
    encoded = io.BytesIO()
    source.save(encoded, format="HEIF", quality=90)
    headers, body = upload(url + "/convert", token, encoded.getvalue(), "source.heic", "image/heic")
    converted = png(headers, body, size).convert("RGB")
    require(max(converted.getpixel((128, 96))) < 100
            and min(converted.getpixel((16, 16))) > 220, "HEIC conversion pixels differ")
    require(headers.get("x-input-format") in ("heic", "heif"), "missing HEIC conversion header")

    encoded = io.BytesIO()
    source.save(encoded, format="PNG")
    model = "birefnet-general"
    headers, body = upload(url + "/matte?model=" + model, token, encoded.getvalue(), "source.png", "image/png")
    mask = png(headers, body, size)
    require(mask.mode == "L" and mask.getextrema()[0] < mask.getextrema()[1], "mask is not a varying grayscale image")
    require(mask.getpixel((128, 96)) > 128 and mask.getpixel((16, 16)) < 128, "mask foreground/background differ")
    require(headers.get("x-model") == model and headers.get("x-input-size") == "256x192", "matte model/input headers differ")
    print(json.dumps({"target": target, "version": version, "models": sorted(MODELS), "oidc": "passed",
                      "unauthenticated": "rejected", "convert": "passed", "matte": "passed", "xMs": int(headers["x-ms"])}), flush=True)


# ---------------------------------------------------------------------------------------------
# Spec 17 3.3.1: probe mode. Calls one service URL (usually a tagged no-traffic revision) the way production does
# and measures: per model one warm call at 1024 px, then `concurrency` calls at once for `rounds` rounds, then the
# policy's switching order, reading /health after every step. Prints a markdown table, writes a JSON report to
# gs://image-links-agent-assets/catalog-test/probe/<run>/ and exits non-zero on any non-200, on an unreadable /health,
# or on more than one load of a model on one instance while that instance keeps every probed model resident (with
# fewer resident sessions the switching order reloads by design, so loads are reported there, not failed).
SWITCH_ORDER = ("birefnet-general", "bria-rmbg", "birefnet-general-lite", "birefnet-hrsod")
PROBE_SIZE = 1024
PROBE_BUCKET = "image-links-agent-assets"
PROBE_PREFIX = "catalog-test/probe"


def audience_for(url):
    """Cloud Run checks the ID token against the service URL, also for a tag URL (https://<tag>---<service host>)."""
    parsed = urllib.parse.urlsplit(url)
    return f"{parsed.scheme}://{parsed.netloc.split('---', 1)[-1]}"


def probe_image():
    image = Image.new("RGB", (PROBE_SIZE, PROBE_SIZE), "white")
    ImageDraw.Draw(image).rounded_rectangle((256, 160, 768, 864), radius=48, fill="#222244")
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    return encoded.getvalue()


def timed_matte(url, token, model, data):
    """One /matte call: (status, client ms). A transport failure or timeout counts as status 0."""
    started = time.perf_counter()
    try:
        upload(url + "/matte?model=" + urllib.parse.quote(model), token, data, "probe.png", "image/png")
        status = 200
    except urllib.error.HTTPError as error:
        status = error.code
    except Exception:  # noqa: BLE001 - any failure is a non-200 for the probe; no detail is printed
        status = 0
    return status, int((time.perf_counter() - started) * 1000)


def percentile(values, share):
    """Nearest-rank percentile; None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(share * len(ordered)) - 1)]


class Probe:
    def __init__(self, url, token, models):
        self.url, self.token, self.data = url, token, probe_image()
        self.models = {model: {"ms": [], "statuses": [], "peakMiB": None} for model in models}
        self.instances = {}
        self.steps = []
        self.problems = []

    def health(self, step, model=None):
        """Reads /health (fresh VRAM) after a step and keeps each instance's newest load counters. The first read of an
        instance before any call is its baseline, so loads from before the probe do not count."""
        try:
            _, body = request(self.url + "/health?fresh=1", self.token)
            health = json.loads(body)
        except Exception:  # noqa: BLE001 - recorded as a probe failure; no detail is printed
            self.steps.append({"step": step, "model": model, "health": None})
            self.problems.append(f"health unreadable after {step}")
            return
        instance, loads = health.get("instanceId"), health.get("loadsByModel")
        if not isinstance(instance, str) or not isinstance(loads, dict):
            self.problems.append(f"health after {step} has no instanceId or loadsByModel (a revision before spec 17?)")
            return
        gpu = any(item.get("target") == "gpu" for item in health.get("models", []))
        used = (health.get("gpuMemory") or {}).get("usedMiB")
        if gpu and not isinstance(used, int):
            self.problems.append(f"GPU memory unreadable after {step}")
        seen = self.instances.setdefault(instance, {"baseline": dict(loads) if model is None else {}})
        seen.update(loadsByModel=loads, maxResident=health.get("maxResident"), residentModels=health.get("residentModels"),
                    candidate=health.get("candidate"), lockScope=health.get("lockScope"))
        if model is not None and isinstance(used, int):
            entry = self.models[model]
            entry["peakMiB"] = used if entry["peakMiB"] is None else max(entry["peakMiB"], used)
        self.steps.append({"step": step, "model": model, "instance": instance, "usedMiB": used, "residentModels": health.get("residentModels")})

    def calls(self, model, count, measured):
        with ThreadPoolExecutor(max_workers=count) as pool:
            results = list(pool.map(lambda _: timed_matte(self.url, self.token, model, self.data), range(count)))
        entry = self.models[model]
        entry["statuses"].extend(status for status, _ in results)
        if measured:
            entry["ms"].extend(ms for status, ms in results if status == 200)

    def run(self, concurrency, rounds):
        self.health("baseline")
        for model in self.models:
            self.calls(model, 1, measured=False)
            self.health("warm", model)
            for index in range(rounds):
                self.calls(model, concurrency, measured=True)
                self.health(f"round {index + 1}", model)
        order = [model for model in SWITCH_ORDER if model in self.models]
        if len(order) < 2:
            return
        for model in [*order, order[0]]:
            self.calls(model, 1, measured=False)
            self.health("switch", model)

    def loads(self, model):
        """The most loads of `model` during the probe on one instance."""
        return max((int(i["loadsByModel"].get(model, 0)) - int(i["baseline"].get(model, 0)) for i in self.instances.values()), default=0)

    def holds_all(self):
        """True when every instance seen keeps all probed models resident; only then is a reload a failure."""
        return bool(self.instances) and all(isinstance(i["maxResident"], int) and i["maxResident"] >= len(self.models) for i in self.instances.values())

    def rows(self):
        return [{"model": model, "peakVramUsedMiB": entry["peakMiB"], "p50Ms": percentile(entry["ms"], 0.5), "p95Ms": percentile(entry["ms"], 0.95),
                 "non200": sum(1 for status in entry["statuses"] if status != 200), "calls": len(entry["statuses"]), "loads": self.loads(model)}
                for model, entry in self.models.items()]

    def failures(self, rows):
        """Any non-200, any unreadable health, and a reload when the shape keeps every probed model resident. With fewer
        resident sessions than models the switching order must reload, so loads are reported, not failed."""
        reloads = [f"{r['model']}: {r['loads']} loads on one instance" for r in rows if r["loads"] > 1] if self.holds_all() else []
        return [f"{r['model']}: {r['non200']} non-200" for r in rows if r["non200"]] + reloads + list(dict.fromkeys(self.problems))


def markdown(rows):
    def cell(value):
        return "-" if value is None else str(value)
    lines = ["| model | peak VRAM used (MiB) | p50 ms | p95 ms | non-200 | loads |", "|---|---:|---:|---:|---:|---:|"]
    lines += [f"| {r['model']} | {cell(r['peakVramUsedMiB'])} | {cell(r['p50Ms'])} | {cell(r['p95Ms'])} | {r['non200']} | {r['loads']} |" for r in rows]
    return "\n".join(lines)


def access_token():
    url = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
    with urllib.request.urlopen(urllib.request.Request(url, headers={"Metadata-Flavor": "Google"}), timeout=10) as response:
        return json.loads(response.read(65536))["access_token"]


def write_report(run, report):
    """Uploads the JSON report through the Cloud Storage JSON API with the job's own service account."""
    name = f"{PROBE_PREFIX}/{run}/probe.json"
    url = f"https://storage.googleapis.com/upload/storage/v1/b/{PROBE_BUCKET}/o?uploadType=media&name=" + urllib.parse.quote(name, safe="")
    req = urllib.request.Request(url, data=json.dumps(report, indent=2).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + access_token(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60):
        pass
    return f"gs://{PROBE_BUCKET}/{name}"


def parse_probe_args(argv):
    parser = argparse.ArgumentParser(prog="cloudrun_check.py --probe")
    parser.add_argument("--probe", action="store_true", required=True)
    parser.add_argument("--models", default=",".join(SWITCH_ORDER))
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--rounds", type=int, default=5)
    parser.add_argument("--run", default="")
    parser.add_argument("url")
    args = parser.parse_args(argv)
    args.models = list(dict.fromkeys(m.strip() for m in args.models.split(",") if m.strip()))
    args.url = args.url.rstrip("/")
    require(args.models and all(m in MODELS for m in args.models), "--models must list served cut-out models")
    require(1 <= args.concurrency <= 16 and 1 <= args.rounds <= 100, "--concurrency must be 1 to 16 and --rounds 1 to 100")
    require(re.fullmatch(r"https://[a-z0-9.-]+\.run\.app|http://(localhost|127\.0\.0\.1):[0-9]+", args.url) is not None, "probe URL must be a run.app or local URL")
    require(not args.run or re.fullmatch(r"[A-Za-z0-9._-]{1,80}", args.run) is not None, "--run must be a short name")
    return args


def probe_main(argv, token_for=None, report_writer=None, now=None):
    """Runs the probe and returns the exit code. Tokens never reach stdout."""
    args = parse_probe_args(argv)
    token = None if args.url.startswith("http://") else (token_for or identity_token)(audience_for(args.url))
    started = now or datetime.datetime.now(datetime.timezone.utc)
    run = args.run or os.environ.get("CLOUD_RUN_EXECUTION") or started.strftime("%Y%m%dT%H%M%SZ")
    probe = Probe(args.url, token, args.models)
    probe.run(args.concurrency, args.rounds)
    rows = probe.rows()
    failures = probe.failures(rows)
    report = {"run": run, "url": args.url, "startedAt": started.isoformat(), "imagePx": PROBE_SIZE, "models": args.models,
              "concurrency": args.concurrency, "rounds": args.rounds, "rows": rows, "reloadsChecked": probe.holds_all(),
              "instances": probe.instances, "steps": probe.steps, "passed": not failures, "failures": failures}
    print(markdown(rows), flush=True)
    location = (report_writer or write_report)(run, report)
    print(json.dumps({"probe": run, "passed": not failures, "failures": failures, "report": location}), flush=True)
    return 1 if failures else 0


def main():
    if "--probe" in sys.argv[1:]:
        sys.exit(probe_main(sys.argv[1:]))
    check("cpu", os.environ["MATTING_URL"], os.environ["CPU_VERSION"])
    if os.environ.get("MATTING_GPU_URL"):
        check("gpu", os.environ["MATTING_GPU_URL"], os.environ["GPU_VERSION"])
    else:
        print(json.dumps({"target": "gpu", "status": "not checked", "reason": "deployed worker has no GPU URL; see deployment quota receipt"}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Do not print arbitrary exception text, request headers, response bodies or tokens.
        detail = str(error) if isinstance(error, CheckFailure) else type(error).__name__
        if isinstance(error, urllib.error.HTTPError):
            detail += " status=" + str(error.code)
        print("matting runtime check FAILED: " + detail, file=sys.stderr)
        sys.exit(1)
