import argparse
import datetime
import hashlib
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


def request(url, token=None, data=None, content_type=None, timeout=TIMEOUT, limit=8_000_000):
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if content_type:
        headers["Content-Type"] = content_type
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=timeout) as response:
        body = response.read(limit + 1)
        require(len(body) <= limit, "response exceeds check limit")
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


def write_report(run, report, file="probe.json"):
    """Uploads the JSON report through the Cloud Storage JSON API with the job's own service account."""
    name = f"{PROBE_PREFIX}/{run}/{file}"
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


# ---------------------------------------------------------------------------------------------
# Spec 18 H1: the upscale probe. Calls POST /upscale on one service URL (usually a catalog-upscale candidate's tag URL)
# for each model (--model, a comma list; spec 18 quality: swinir-x2 and swinir-x4) with a synthetic JPEG of each size:
# one warm call (loads the model, not measured), then `concurrency` calls at once for `rounds` rounds. Reads /health
# before (vCPU, threads) and after each warm call (the model's tile). Each answer must be a JPEG of exactly the model's
# scale (2x or 4x) of the size. Every answer records its sha256 and the instance that made it (the X-Instance-Id
# header). Answers for one model and size from ONE instance must have the same bytes (the upscaler is deterministic at
# a fixed thread count; the warm call and one round already make a rerun). Answers from DIFFERENT instances may differ
# by float rounding on different CPU platforms (measured on 2026-10-30, .runs/2026-10-30-18-post-deploy-fixes.md), so
# those are compared pixel by pixel and fail only when the difference could be visible (see VISUAL_MAX_ABS).
# Spec 18 gate (plan 7.2), when the gate asks for them:
#   --cold-start-max s      first, before anything warms the candidate: one long /upscale call holds an instance
#                           (concurrency 1), then GET /health is timed until 200. It counts only when /health came from
#                           an instance that started while the probe waited (its uptimeS is below the wait), up to 3
#                           tries; fails when not measured or above s (UPSCALE_COLD_START_S in infra/lib/shape.sh).
#   --determinism-calls n   per model, n calls of the same 800x1200 image at once (429 retried), each with its sha256
#                           and instance id; repeated up to 3 times until at least 2 instances answered. Fails when
#                           fewer than 2 instances answered, on any non-200, on two outputs from one instance, or on
#                           outputs from two instances that differ visibly.
# Prints the table `model | size | vCPU | threads | tile | conc | p50 s | p95 s | max s | non-200 | output sha256` and
# the determinism and cold-start lines, writes the JSON report to
# gs://image-links-agent-assets/catalog-test/probe/<run>/upscale.json when --bucket names that bucket, and exits
# non-zero on any failure above or an unreadable /health.
# The served upscalers and their fixed scale (services/matting/app.py UPSCALE_SCALES).
UPSCALE_PROBE_MODELS = {"swinir-x2": 2, "swinir-x4": 4}
UPSCALE_PROBE_SIZES = "800x1200,1600x1600"
# One 6400x6400 JPEG (1600x1600 at 4x) at quality 95 is a few tens of MB; the check limit leaves room.
UPSCALE_RESPONSE_LIMIT = 160_000_000
# The visual threshold for outputs of the same input from two instances (8-bit RGB after JPEG decode). Two outputs are
# visually identical when no channel of any pixel differs by more than VISUAL_MAX_ABS levels and the PSNR is at least
# VISUAL_MIN_PSNR_DB. Measured on live catalog-upscale on 2026-10-30 (800x1200, 12 calls per model, 4 instances, one
# of which gives other bytes): x2 max 1/255 in 40 of 3.8 M pixels, PSNR 98 dB; x4 max 3/255 in 387 of 15.4 M pixels,
# PSNR 93 dB, with no sign bias (float rounding on another CPU platform). The limits sit well above that and well below
# any real defect: 8/255 (3%) on isolated pixels is invisible on a photo, while a seam, a wrong tile or a dropped
# overlap is tens of levels; 60 dB is 20 dB above the ~40 dB where a difference starts to show, and a broad shift (a
# colour cast of even 3 levels everywhere is about 39 dB) fails it although its max is small.
VISUAL_MAX_ABS = 8
VISUAL_MIN_PSNR_DB = 60.0
DETERMINISM_SIZE = (800, 1200)
DETERMINISM_ATTEMPTS = 3
# A 429 (no instance free within Cloud Run's queue time) is retried after this many seconds, at most this many times.
BUSY_RETRY_S = 10
BUSY_RETRIES = 30
COLD_START_ATTEMPTS = 3
# How long the occupying call runs before /health is sent, so it holds its instance first.
COLD_START_HOLD_S = 5


def parse_sizes(text):
    """'800x1200,1600x1600' -> [(800, 1200), (1600, 1600)]: width x height, each 64 to 4000 px, each size once."""
    sizes = []
    for item in (part.strip().lower() for part in text.split(",")):
        match = re.fullmatch(r"([1-9][0-9]{1,3})x([1-9][0-9]{1,3})", item)
        require(match is not None, "--sizes must look like 800x1200,1600x1600")
        size = (int(match.group(1)), int(match.group(2)))
        require(all(64 <= side <= 4000 for side in size), "--sizes sides must be 64 to 4000 px")
        require(size not in sizes, "--sizes lists a size twice")
        sizes.append(size)
    return sizes


def upscale_image(width, height):
    """A deterministic product-like JPEG: a soft background, a garment-sized shape with stripes and a detail, quality 92.
    Inference time does not depend on the content (fixed tiles); the content only has to be a real photo-sized JPEG."""
    image = Image.linear_gradient("L").resize((width, height)).convert("RGB")
    draw = ImageDraw.Draw(image)
    box = (width // 5, height // 8, width * 4 // 5, height * 7 // 8)
    draw.rounded_rectangle(box, radius=max(4, width // 20), fill="#3a4f7a")
    for y in range(box[1], box[3], max(4, height // 60)):
        draw.line((box[0], y, box[2], y), fill="#c9a227", width=max(1, height // 400))
    draw.ellipse((width * 2 // 5, height // 3, width * 3 // 5, height // 2), fill="#f2f2f2", outline="#111111", width=3)
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG", quality=92)
    return encoded.getvalue()


class UpscaleAnswer:
    """One /upscale call. status: 200, the HTTP error, 0 for a transport failure or timeout, -1 for an answer that is
    not a JPEG of exactly `scale` times `size`. instance: the X-Instance-Id header (None from a revision before it)."""

    def __init__(self, status, seconds, digest=None, instance=None, body=None):
        self.status, self.seconds, self.digest, self.instance, self.body = status, seconds, digest, instance, body

    def __iter__(self):
        # (status, seconds, digest), as callers before the instance id unpacked it.
        return iter((self.status, self.seconds, self.digest))


def timed_upscale(url, token, model, data, size, timeout, scale=2):
    """One /upscale call as an UpscaleAnswer."""
    started = time.perf_counter()
    digest = instance = kept = None
    try:
        headers, body = request(f"{url}/upscale?model={urllib.parse.quote(model)}&scale={scale}", token, data, "image/jpeg", timeout, UPSCALE_RESPONSE_LIMIT)
        try:
            with Image.open(io.BytesIO(body)) as answer:
                ok = headers.get_content_type() == "image/jpeg" and answer.format == "JPEG" and answer.size == (size[0] * scale, size[1] * scale)
        except Exception:  # noqa: BLE001 - an unreadable answer is a failed call; no detail is printed
            ok = False
        instance = headers.get("X-Instance-Id")
        status, digest, kept = (200, hashlib.sha256(body).hexdigest(), body) if ok else (-1, None, None)
    except urllib.error.HTTPError as error:
        status = error.code
    except Exception:  # noqa: BLE001 - any failure is a non-200 for the probe; no detail is printed
        status = 0
    return UpscaleAnswer(status, time.perf_counter() - started, digest, instance, kept)


def upscale_until_served(url, token, model, data, size, timeout, scale, sleep=time.sleep):
    """timed_upscale, retrying a 429 (every instance busy) BUSY_RETRIES times, BUSY_RETRY_S apart."""
    for _ in range(BUSY_RETRIES):
        answer = timed_upscale(url, token, model, data, size, timeout, scale)
        if answer.status != 429:
            return answer
        sleep(BUSY_RETRY_S)
    return timed_upscale(url, token, model, data, size, timeout, scale)


# pixel_difference compares bands of about this many pixels at a time, so its temporary arrays stay about 3 MB each at
# any image size.
DIFFERENCE_BAND_PIXELS = 1 << 18


def rgb_image(image):
    """The decoded image in RGB (a JPEG answer already is; anything else is converted)."""
    image.load()
    return image if image.mode == "RGB" else image.convert("RGB")


def pixel_difference(first, second):
    """Two decoded JPEGs compared per 8-bit channel: the largest and mean absolute difference, the share of pixels with
    any difference, and the PSNR (None when identical).
    Memory (2026-10-30, a 6400x6400 x4 pair OOM-killed the 512 MiB probe job): Pillow cannot decode a JPEG in parts, so
    each image is decoded once in full. The first is copied band by band into one uint8 array (3 bytes per pixel) and
    its decoded image (4 bytes per pixel in Pillow) is freed before the second is decoded; the two are then compared
    band by band with small integer arrays. The peak is about 7 bytes per pixel: measured on a 6400x6400 pair of 16 MB
    JPEGs, 371 MiB for the whole process (80 MiB before the call) against 905 MiB when both decodes, their RGB copies
    and full-size arrays were held at once."""
    import numpy as np  # the service image has numpy; imported here so the matte probe does not need it

    with Image.open(io.BytesIO(first)) as a, Image.open(io.BytesIO(second)) as b:
        same_size = a.size == b.size
    if not same_size:
        return {"sameSize": False, "maxAbs": 255, "meanAbs": None, "sharePixels": None, "psnrDb": 0.0}
    with Image.open(io.BytesIO(first)) as opened:
        width, height = opened.size
        band = max(1, DIFFERENCE_BAND_PIXELS // width)
        reference = np.empty((height, width, 3), dtype=np.uint8)
        decoded = rgb_image(opened)
        for top in range(0, height, band):
            reference[top:top + band] = np.asarray(decoded.crop((0, top, width, min(height, top + band))))
        del decoded
    largest, total, squares, differing = 0, 0, 0, 0
    with Image.open(io.BytesIO(second)) as opened:
        decoded = rgb_image(opened)
        for top in range(0, height, band):
            other = np.asarray(decoded.crop((0, top, width, min(height, top + band)))).astype(np.int32)
            diff = np.abs(other - reference[top:top + band])
            largest = max(largest, int(diff.max()))
            total += int(diff.sum(dtype=np.int64))
            squares += int(np.square(diff).sum(dtype=np.int64))
            differing += int(np.count_nonzero(diff.max(axis=2)))
        del decoded
    values, pixels = reference.size, height * width
    mse = squares / values
    return {"sameSize": True, "maxAbs": largest, "meanAbs": round(total / values, 5), "sharePixels": round(differing / pixels, 6),
            "psnrDb": None if mse == 0 else round(10 * math.log10(255 ** 2 / mse), 2)}


def visually_identical(difference):
    return difference["maxAbs"] <= VISUAL_MAX_ABS and (difference["psnrDb"] is None or difference["psnrDb"] >= VISUAL_MIN_PSNR_DB)


def keep_bodies(answers, bodies):
    """Moves each answer's bytes into `bodies` (one copy per sha256), so a probe keeps one body per distinct output."""
    for answer in answers:
        if answer.body is not None:
            bodies.setdefault(answer.digest, answer.body)
            answer.body = None
    return answers


def judge_outputs(label, answers, bodies):
    """Compares the successful answers for one input (`bodies`: sha256 -> bytes). Returns (summary, failures): one
    instance with two outputs fails (a race inside one process); outputs only from different instances are compared
    pixel by pixel and fail when not visually identical."""
    outputs = {}
    for answer in answers:
        if answer.status == 200 and answer.digest:
            outputs.setdefault(answer.digest, {"instances": set()})["instances"].add(answer.instance)
    by_instance = {}
    for digest, entry in outputs.items():
        for instance in entry["instances"]:
            if instance is not None:
                by_instance.setdefault(instance, set()).add(digest)
    failures = [f"{label}: instance {instance} gave {len(digests)} different outputs for the same input"
                for instance, digests in sorted(by_instance.items()) if len(digests) > 1]
    pairs = []
    digests = sorted(outputs)
    for i, first in enumerate(digests):
        for second in digests[i + 1:]:
            difference = pixel_difference(bodies[first], bodies[second])
            pairs.append({"a": first, "b": second, **difference, "visuallyIdentical": visually_identical(difference)})
    worst = max(pairs, key=lambda p: (p["maxAbs"], -(p["psnrDb"] or 1000.0)), default=None)
    if worst and not worst["visuallyIdentical"]:
        failures.append(f"{label}: outputs from different instances differ visibly (max {worst['maxAbs']}/255, PSNR {worst['psnrDb']} dB; "
                        f"the limit is {VISUAL_MAX_ABS}/255 and {VISUAL_MIN_PSNR_DB:g} dB)")
    summary = {"distinctOutputs": len(outputs), "instances": len({a.instance for a in answers if a.status == 200 and a.instance}),
               "outputs": {digest: sorted(i or "unknown" for i in entry["instances"]) for digest, entry in outputs.items()},
               "pairs": pairs, "worst": worst and {k: worst[k] for k in ("maxAbs", "meanAbs", "sharePixels", "psnrDb")}}
    return summary, failures


def seconds(value):
    return None if value is None else round(value, 1)


# Google ID tokens live one hour; a ladder probe (several sizes, rounds at 2 x p95 each) can run longer.
TOKEN_MAX_AGE_S = 50 * 60


class RefreshingToken:
    """The probe's ID token, minted again once it is older than TOKEN_MAX_AGE_S. Never printed."""

    def __init__(self, mint, clock=time.monotonic):
        self.mint, self.clock = mint, clock
        self.value, self.minted_at = mint(), clock()

    def __call__(self):
        if self.clock() - self.minted_at >= TOKEN_MAX_AGE_S:
            self.value, self.minted_at = self.mint(), self.clock()
        return self.value


def current_token(source):
    return source() if callable(source) else source


class UpscaleProbe:
    def __init__(self, url, token, model, sizes, timeout):
        # `token`: None (a local URL), a token, or a callable that returns the current one (RefreshingToken).
        self.url, self.token_source, self.model, self.timeout = url, token, model, timeout
        self.scale = UPSCALE_PROBE_MODELS.get(model, 2)
        # Per size: the bodies of its distinct outputs (sha256 -> bytes) until it is judged, then its judgement. Only the
        # size being probed holds bodies, so at most one input's distinct outputs are in memory at once.
        self.sizes = {size: {"data": upscale_image(*size), "s": [], "answers": [], "bodies": {}, "judged": None} for size in sizes}
        self.service = {}
        self.steps = []
        self.problems = []
        self.determinism = None

    @property
    def token(self):
        return current_token(self.token_source)

    def health(self, step):
        try:
            _, body = request(self.url + "/health", self.token)
            health = json.loads(body)
        except Exception:  # noqa: BLE001 - recorded as a probe failure; no detail is printed
            self.problems.append(f"health unreadable after {step}")
            self.steps.append({"step": step, "health": None})
            return
        listed = next((m for m in (health.get("upscale") or {}).get("models", []) if m.get("id") == self.model), {})
        if not listed.get("available"):
            self.problems.append(f"{self.model} is not available on the service at {step}")
        tile = (health.get("upscaleTiles") or {}).get(self.model)
        self.service.update(vcpu=health.get("vcpu"), threads=health.get("threads"), candidate=health.get("candidate"),
                            preloadMatte=health.get("preloadMatte"), instanceId=health.get("instanceId"))
        if tile is not None:
            self.service["tile"] = tile
        self.steps.append({"step": step, "instance": health.get("instanceId"), "tile": tile})

    def calls(self, size, count, measured):
        entry = self.sizes[size]
        token = self.token
        with ThreadPoolExecutor(max_workers=count) as pool:
            results = list(pool.map(lambda _: timed_upscale(self.url, token, self.model, entry["data"], size, self.timeout, self.scale), range(count)))
        entry["answers"].extend(keep_bodies(results, entry["bodies"]))
        if measured:
            entry["s"].extend(a.seconds for a in results if a.status == 200)

    def run(self, concurrency, rounds):
        self.health("baseline")
        for size in self.sizes:
            self.calls(size, 1, measured=False)
            self.health(f"warm {size[0]}x{size[1]}")
            for _ in range(rounds):
                self.calls(size, concurrency, measured=True)
            self.judge(size)

    def judge(self, size):
        """Compares this size's outputs once, then drops their bodies (each call keeps only its sha256)."""
        entry = self.sizes[size]
        if entry["judged"] is None:
            entry["judged"] = judge_outputs(f"{self.model} {size[0]}x{size[1]}", entry["answers"], entry["bodies"])
            entry["bodies"] = {}
        return entry["judged"]

    def determinism_round(self, count, size=DETERMINISM_SIZE, sleep=time.sleep):
        """Spec 18 gate (plan 7.2): `count` calls of one image at once, until at least 2 instances answered (at most
        DETERMINISM_ATTEMPTS rounds). Every call keeps its sha256 and instance id."""
        data, label = upscale_image(*size), f"{self.model} {size[0]}x{size[1]} determinism"
        answers, calls, bodies = [], [], {}
        for attempt in range(1, DETERMINISM_ATTEMPTS + 1):
            token = self.token
            with ThreadPoolExecutor(max_workers=count) as pool:
                results = list(pool.map(lambda _: upscale_until_served(self.url, token, self.model, data, size, self.timeout, self.scale, sleep), range(count)))
            answers += keep_bodies(results, bodies)
            calls += [{"attempt": attempt, "status": a.status, "s": seconds(a.seconds), "instance": a.instance, "sha256": a.digest} for a in results]
            if len({a.instance for a in answers if a.status == 200 and a.instance}) >= 2:
                break
        summary, failures = judge_outputs(label, answers, bodies)
        bodies.clear()
        non200 = sum(1 for a in answers if a.status != 200)
        if non200:
            failures.insert(0, f"{label}: {non200} non-200")
        if summary["instances"] < 2:
            failures.append(f"{label}: {summary['instances']} instance(s) answered in {DETERMINISM_ATTEMPTS} rounds of {count} calls; at least 2 are needed")
        self.determinism = {"model": self.model, "size": f"{size[0]}x{size[1]}", "callsPerRound": count, "rounds": attempt, "calls": calls,
                            **summary, "passed": not failures, "failures": failures}
        return self.determinism

    def rows(self, concurrency):
        out = []
        for (width, height), entry in self.sizes.items():
            summary, failures = self.judge((width, height))
            digests = sorted(summary["outputs"])
            statuses = [a.status for a in entry["answers"]]
            out.append({"model": self.model, "scale": self.scale, "size": f"{width}x{height}", "vcpu": self.service.get("vcpu"), "threads": self.service.get("threads"),
                        "tile": self.service.get("tile"), "concurrency": concurrency, "p50S": seconds(percentile(entry["s"], 0.5)),
                        "p95S": seconds(percentile(entry["s"], 0.95)), "maxS": seconds(max(entry["s"], default=None)),
                        "non200": sum(1 for status in statuses if status != 200), "calls": len(statuses),
                        "outputSha256": digests[0] if len(digests) == 1 else None, "distinctOutputs": len(digests),
                        "instances": summary["instances"], "outputs": summary["outputs"], "difference": summary["worst"], "outputFailures": failures,
                        "callLog": [{"status": a.status, "s": seconds(a.seconds), "instance": a.instance, "sha256": a.digest} for a in entry["answers"]]})
        return out

    def failures(self, rows):
        return ([f"{r['model']} {r['size']}: {r['non200']} non-200" for r in rows if r["non200"]]
                + [failure for r in rows for failure in r["outputFailures"]]
                + (self.determinism["failures"] if self.determinism else [])
                + [f"{self.model}: {problem}" for problem in dict.fromkeys(self.problems)])


def measure_cold_start(url, token_source, model, size, timeout, limit_s, hold_s=COLD_START_HOLD_S, sleep=time.sleep):
    """Spec 18 gate (plan 7.2): the time from GET /health to its 200 on a fresh instance. A long /upscale call first
    holds an instance (concurrency 1), so /health needs another one; the wait counts only when that instance started
    while the probe waited (its uptimeS is below the wait). Up to COLD_START_ATTEMPTS tries, each holding one more
    instance (a warm idle instance takes the next hold). Returns the report entry and the failures."""
    scale, data = UPSCALE_PROBE_MODELS.get(model, 2), upscale_image(*size)
    holds, attempts, measured = [], [], None
    with ThreadPoolExecutor(max_workers=COLD_START_ATTEMPTS) as pool:
        for attempt in range(1, COLD_START_ATTEMPTS + 1):
            token = current_token(token_source)
            holds.append(pool.submit(timed_upscale, url, token, model, data, size, timeout, scale))
            sleep(hold_s)
            started = time.perf_counter()
            try:
                _, body = request(url + "/health", token, timeout=max(TIMEOUT, 2 * limit_s))
                health = json.loads(body)
                waited = time.perf_counter() - started
                uptime = health.get("uptimeS")
                fresh = isinstance(uptime, (int, float)) and uptime <= waited
                attempts.append({"attempt": attempt, "waitS": seconds(waited), "instance": health.get("instanceId"), "uptimeS": uptime, "fresh": fresh})
            except Exception:  # noqa: BLE001 - recorded as an unmeasured try; no detail is printed
                attempts.append({"attempt": attempt, "waitS": seconds(time.perf_counter() - started), "instance": None, "uptimeS": None, "fresh": False, "error": True})
                fresh, waited = False, None
            if fresh:
                measured = waited
                break
        held = [h.result() for h in holds]
    entry = {"model": model, "size": f"{size[0]}x{size[1]}", "coldStartS": seconds(measured), "limitS": limit_s, "attempts": attempts,
             "holds": [{"status": a.status, "s": seconds(a.seconds), "instance": a.instance} for a in held]}
    failures = []
    if measured is None:
        failures.append(f"cold start not measured: no /health in {COLD_START_ATTEMPTS} tries came from a fresh instance")
    elif measured > limit_s:
        failures.append(f"cold start {measured:.1f} s is above UPSCALE_COLD_START_S={limit_s} (infra/lib/shape.sh); raise it to the measured value")
    entry["passed"] = not failures
    return entry, failures


def x4_ratio_failures(rows, ratio):
    """2026-10-29 review P2-1: the x4 cap (infra/lib/shape.sh UPSCALE_MAX_PIXELS_X4) assumes the x4 model takes at most
    `ratio` (UPSCALE_X4_TIME_RATIO) times the x2 model's time. At each size probed on both, an x4 p95 above that fails
    the probe, with the ratio measured. 0 checks nothing."""
    if not ratio:
        return []
    by_size = {}
    for r in rows:
        if r["p95S"] is not None:
            by_size.setdefault(r["size"], {})[r["scale"]] = r
    out = []
    for size, pair in by_size.items():
        x2, x4 = pair.get(2), pair.get(4)
        if x2 and x4 and x4["p95S"] > x2["p95S"] * ratio:
            out.append(f"{x4['model']} {size}: p95 {x4['p95S']} s is {x4['p95S'] / x2['p95S']:.2f} x the {x2['model']} p95 {x2['p95S']} s, "
                       f"above UPSCALE_X4_TIME_RATIO={ratio:g}; raise it and lower UPSCALE_MAX_PIXELS_X4 to fit the timeout (infra/lib/shape.sh)")
    return out


def upscale_markdown(rows):
    def cell(value):
        return "-" if value is None else str(value)
    lines = ["| model | size | vCPU | threads | tile | conc | p50 s | p95 s | max s | non-200 | output sha256 |",
             "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|"]
    lines += [f"| {r['model']} | {r['size']} | {cell(r['vcpu'])} | {cell(r['threads'])} | {cell(r['tile'])} | {r['concurrency']} | {cell(r['p50S'])} | "
              f"{cell(r['p95S'])} | {cell(r['maxS'])} | {r['non200']} | {cell(r['outputSha256'] and r['outputSha256'][:16])} |" for r in rows]
    return "\n".join(lines)


def determinism_line(entry):
    worst = entry["worst"]
    difference = "byte-identical" if not worst else (f"max {worst['maxAbs']}/255, mean {worst['meanAbs']}, {worst['sharePixels'] * 100:.3f}% of pixels, "
                                                       f"PSNR {worst['psnrDb']} dB")
    return (f"determinism {entry['model']} {entry['size']}: {len(entry['calls'])} calls, {entry['instances']} instances, "
            f"{entry['distinctOutputs']} distinct outputs ({difference}): {'passed' if entry['passed'] else 'FAILED'}")


def parse_upscale_args(argv):
    parser = argparse.ArgumentParser(prog="cloudrun_check.py --probe-upscale")
    parser.add_argument("--probe-upscale", dest="url", required=True)
    parser.add_argument("--model", default="swinir-x2")
    parser.add_argument("--sizes", default=UPSCALE_PROBE_SIZES)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--x4-ratio", dest="x4_ratio", type=float, default=0.0)
    parser.add_argument("--determinism-calls", dest="determinism_calls", type=int, default=0)
    parser.add_argument("--cold-start-max", dest="cold_start_max", type=int, default=0)
    parser.add_argument("--bucket", default="")
    parser.add_argument("--run", default="")
    args = parser.parse_args(argv)
    args.url = args.url.rstrip("/")
    args.sizes = parse_sizes(args.sizes)
    args.models = list(dict.fromkeys(m.strip() for m in args.model.split(",") if m.strip()))
    require(bool(args.models) and all(m in UPSCALE_PROBE_MODELS for m in args.models),
            f"--model must list served upscalers ({', '.join(UPSCALE_PROBE_MODELS)})")
    require(1 <= args.concurrency <= 8 and 1 <= args.rounds <= 50, "--concurrency must be 1 to 8 and --rounds 1 to 50")
    require(30 <= args.timeout <= 3600, "--timeout must be 30 to 3600 seconds")
    require(args.x4_ratio == 0 or args.x4_ratio >= 1, "--x4-ratio must be 0 (no check) or at least 1")
    require(args.determinism_calls == 0 or 2 <= args.determinism_calls <= 16, "--determinism-calls must be 0 (none) or 2 to 16")
    require(0 <= args.cold_start_max <= 3600, "--cold-start-max must be 0 (none) to 3600 seconds")
    require(args.bucket in ("", PROBE_BUCKET), f"--bucket may only name {PROBE_BUCKET}")
    require(re.fullmatch(r"https://[a-z0-9.-]+\.run\.app|http://(localhost|127\.0\.0\.1):[0-9]+", args.url) is not None, "probe URL must be a run.app or local URL")
    require(not args.run or re.fullmatch(r"[A-Za-z0-9._-]{1,80}", args.run) is not None, "--run must be a short name")
    return args


def probe_upscale_main(argv, token_for=None, report_writer=None, now=None, sleep=time.sleep):
    """Runs the upscale probe and returns the exit code. Tokens never reach stdout."""
    args = parse_upscale_args(argv)
    audience = audience_for(args.url)
    token = None if args.url.startswith("http://") else RefreshingToken(lambda: (token_for or identity_token)(audience))
    started = now or datetime.datetime.now(datetime.timezone.utc)
    run = args.run or os.environ.get("CLOUD_RUN_EXECUTION") or started.strftime("%Y%m%dT%H%M%SZ")
    rows, failures, steps, service, determinism, cold_start = [], [], [], {}, [], None
    # First, before any call warms the candidate (spec 18 gate, plan 7.2).
    if args.cold_start_max:
        cold_start, cold_failures = measure_cold_start(args.url, token, args.models[0], DETERMINISM_SIZE, args.timeout, args.cold_start_max, sleep=sleep)
        failures += cold_failures
    # One model after the other (the service runs one tile at a time; a concurrency 1 shape must never see two models).
    for model in args.models:
        probe = UpscaleProbe(args.url, token, model, args.sizes, args.timeout)
        probe.run(args.concurrency, args.rounds)
        if args.determinism_calls:
            determinism.append(probe.determinism_round(args.determinism_calls, sleep=sleep))
        model_rows = probe.rows(args.concurrency)
        rows += model_rows
        failures += probe.failures(model_rows)
        steps += [{"model": model, **step} for step in probe.steps]
        service.update(probe.service)
    failures += x4_ratio_failures(rows, args.x4_ratio)
    report = {"run": run, "url": args.url, "startedAt": started.isoformat(), "models": args.models,
              "sizes": [f"{w}x{h}" for w, h in args.sizes], "concurrency": args.concurrency, "rounds": args.rounds,
              "timeoutS": args.timeout, "service": service, "rows": rows, "steps": steps, "determinism": determinism,
              "coldStart": cold_start, "visualLimit": {"maxAbs": VISUAL_MAX_ABS, "minPsnrDb": VISUAL_MIN_PSNR_DB},
              "passed": not failures, "failures": failures}
    print(upscale_markdown(rows), flush=True)
    for entry in determinism:
        print(determinism_line(entry), flush=True)
    if cold_start:
        print(f"UPSCALE_COLD_START_S measured: {cold_start['coldStartS'] if cold_start['coldStartS'] is not None else 'not measured'} s "
              f"(limit {cold_start['limitS']} s): {'passed' if cold_start['passed'] else 'FAILED'}", flush=True)
    location = (report_writer or write_report)(run, report, "upscale.json") if args.bucket else None
    print(json.dumps({"probe": run, "passed": not failures, "failures": failures, "report": location}), flush=True)
    return 1 if failures else 0


def main():
    if any(arg == "--probe-upscale" or arg.startswith("--probe-upscale=") for arg in sys.argv[1:]):
        sys.exit(probe_upscale_main(sys.argv[1:]))
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
