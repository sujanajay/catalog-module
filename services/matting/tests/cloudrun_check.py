import argparse
import datetime
import hashlib
import io
import json
import math
import os
import re
import statistics
import threading
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


# Gate probes and passing platform errors (2026-11-05, .runs/2026-11-05-r1-deploy-457ea28.md): the catalog-upscale-gpu
# gate failed on one GET /health that Cloud Run answered 503 in 0.7 ms while it retired an idle instance; every
# measurement had passed and /health answered 200 again 3 s later. A probe's /health read is therefore tried up to
# TRANSIENT_ATTEMPTS times, TRANSIENT_DELAYS_S apart and within TRANSIENT_MAX_S, but only after a clearly passing
# platform error (transient_reason): a 429 or 503 whose body is not the service's own JSON answer (the matting service
# answers every error of its own as a JSON object, services/matting/app.py), a connection error before the request was
# sent (refused, reset, connect timeout), or a connection reset before the answer. Every retry is printed. Never retried:
# any other status, the service's own error body, a read timeout (a slow candidate) and a malformed answer. A 502 is the
# exception to "any other status": see Unexplained502s. The measured /matte and /upscale calls have their own, narrower
# rule (PLATFORM_RETRIES below).
TRANSIENT_ATTEMPTS = 3
TRANSIENT_DELAYS_S = (5, 10)
TRANSIENT_MAX_S = 90
TRANSIENT_STATUSES = (429, 503)


def own_answer(error):
    """True when an HTTPError's body is a JSON object, the shape of the service's own errors. Reads the body once."""
    try:
        return isinstance(json.loads(error.read(65536) or b""), dict)
    except Exception:  # noqa: BLE001 - an unreadable or non-JSON body is not the service's own answer
        return False


def transient_reason(error):
    """Why `error` (raised by one request) is a passing platform error worth another try, or None for a real answer."""
    if isinstance(error, urllib.error.HTTPError):
        if error.code not in TRANSIENT_STATUSES:
            return None
        return None if own_answer(error) else f"HTTP {error.code} from the platform, not the service"
    if isinstance(error, urllib.error.URLError) and isinstance(error.reason, (ConnectionError, TimeoutError)):
        # urllib wraps only the connect and send phase in URLError; a timeout waiting for the answer is raised bare.
        return "connection failed before the request was sent"
    if isinstance(error, ConnectionResetError):
        # Includes http.client.RemoteDisconnected: the connection closed before any answer.
        return "connection reset before the answer"
    return None


def read_with_retry(label, url, token, sleep=time.sleep, log=None, clock=time.monotonic, unexplained=None):
    """request(url, token), tried again after a passing platform error only (see TRANSIENT_ATTEMPTS), or after a non-JSON
    502 that `unexplained` still allows. Each retry is printed and appended to `log`; the last error is raised as it came."""
    began = clock()
    for attempt in range(1, TRANSIENT_ATTEMPTS + 1):
        tried = clock()
        try:
            return request(url, token)
        except Exception as error:  # noqa: BLE001 - re-raised unless it is a passing platform error
            if isinstance(error, urllib.error.HTTPError) and error.code == 502:
                reason = platform_rejection(error, clock() - tried)
                if reason and (unexplained is None or not unexplained.allows(label, reason)):
                    reason = None
            else:
                reason = transient_reason(error)
            delay = TRANSIENT_DELAYS_S[min(attempt, len(TRANSIENT_DELAYS_S)) - 1]
            if reason is None:
                raise
            last = attempt == TRANSIENT_ATTEMPTS or clock() - began + delay > TRANSIENT_MAX_S
            entry = {"read": label, "attempt": attempt, "of": TRANSIENT_ATTEMPTS, "reason": reason, "nextInS": None if last else delay}
            if log is not None:
                log.append(entry)
            print(f"retry: {label}: {reason} (attempt {attempt} of {TRANSIENT_ATTEMPTS}); "
                  + ("giving up" if last else f"trying again in {delay} s"), flush=True)
            if last:
                raise
            sleep(delay)
    raise AssertionError("unreachable")


# Measured calls and platform rejections (2026-11-05, catalog-check-upscale-gpu-7g6tv, .runs/2026-11-05-gpu-determinism.md):
# one x4 determinism /upscale call got a 503 from Cloud Run's front end in 0.5 ms (0.1 s at the probe), routed to an idle
# GPU instance at the moment scale-down retired it; the container never saw the call, and the 11 other answers were
# byte-identical across 2 instances. Such a rejection says nothing about the candidate's output or speed, so a measured
# /matte or /upscale call is tried again, up to PLATFORM_RETRIES times, PLATFORM_RETRY_DELAYS_S apart, only after a
# platform rejection: an HTTP 429 or 503 whose body is not the service's own JSON answer (transient_reason) that came back
# within PLATFORM_REJECTION_MAX_S (a call turned away at the front door; an instance that crashes during inference fails
# the call after its run time, and that stays a failure). Each retry is printed and recorded; only the attempt a container
# answered is timed. Never retried: the service's own error (a JSON body), any other status, a transport failure or
# timeout, a wrong answer. A round (one burst of calls at once) fails when Cloud Run turned away more than
# PLATFORM_REJECTIONS_PER_ROUND of its attempts, so a real capacity problem still fails the gate; the gate runs have seen
# at most 1 (7g6tv) and before that 0 in 8 GPU gate runs.
PLATFORM_RETRIES = 2
PLATFORM_RETRY_DELAYS_S = (5, 10)
PLATFORM_REJECTION_MAX_S = 2.0
PLATFORM_REJECTIONS_PER_ROUND = 2

# Unexplained 502s (2026-11-06, catalog-check-upscale-pbm8w, 12 x4 determinism calls on the CPU service): one call got a
# 502 after 250 s and stopped a deploy.
# Known: the request log has that call as a 200, and its instance finished the work about 14 s after the client's 502. Other
# calls of that round answered 200 after 355 s and 377 s, so 250 s is no fixed limit. It is the only such 502 seen.
# Not known: the cause, the 502's body (the probe keeps none), and what a client receives when a container dies during a
# call. No crash has been observed here, and Cloud Run's troubleshooting page does not mention 502. So a non-JSON 502 cannot
# be told apart from a lost call, and timing does not help: it is not taken to be harmless.
# A blip costs one rerun of a gate and a shipped crash costs far more, so the allowance is small: UNEXPLAINED_502_ALLOWANCE
# for a whole probe run, on every path (/matte, /upscale and /health, any elapsed time, any round size). Within it the
# call is tried again; the next one is not retried and fails the gate. An intermittent crash that happens to give at most
# one such 502 in a run still passes: the allowance narrows that gap and does not close it. The line this prints reaches
# the deploy report (gate_probe_lines in infra/lib/gate.sh). The attempt a 502 ended stays in the row's timing, and its size
# gives up the outlier trim of the cap timeout check (timing_p95), so a retry never improves either number.
UNEXPLAINED_502_ALLOWANCE = 1


class Unexplained502s:
    """The non-JSON 502s of one probe run, across every thread, path and model."""

    def __init__(self, allowance=UNEXPLAINED_502_ALLOWANCE):
        self.allowance, self.seen, self.lock = allowance, [], threading.Lock()

    def allows(self, where, reason):
        """Records one; True while the run is within the allowance, when the caller may try once more."""
        with self.lock:
            self.seen.append(f"{where}: {reason}")
            return len(self.seen) <= self.allowance

    def failures(self):
        if len(self.seen) <= self.allowance:
            return []
        return [f"{len(self.seen)} unexplained 502s in one gate run (at most {self.allowance}): " + "; ".join(self.seen)]

    def line(self):
        """The gate output's one line; infra/lib/gate.sh matches its start, so keep "unexplained 502s: <count>"."""
        seen = f": {'; '.join(self.seen)}" if self.seen else ""
        return f"unexplained 502s: {len(self.seen)} (at most {self.allowance} in one gate run){seen}"

    def report(self):
        return {"allowance": self.allowance, "seen": list(self.seen)}


def platform_rejection(error, elapsed):
    """Why a measured call's `error` counts as a platform rejection, or None: Cloud Run turning the call away (fast and
    not JSON), or a non-JSON 502 at any time, which only Unexplained502s may let through."""
    if not isinstance(error, urllib.error.HTTPError):
        return None
    if error.code == 502:
        return None if own_answer(error) else f"non-JSON HTTP 502 after {elapsed:.1f} s, cause unknown"
    if elapsed > PLATFORM_REJECTION_MAX_S:
        return None
    return transient_reason(error)


def served_call(call, label, sleep=time.sleep, log=None, busy_retries=0, busy_sleep_s=0, unexplained=None):
    """call() (one attempt, an answer with .status and .rejection) until a container answered: a 429 is tried again up to
    `busy_retries` times, `busy_sleep_s` apart (the determinism round's queue wait), and a platform rejection up to
    PLATFORM_RETRIES times. A non-JSON 502 is tried again only while `unexplained` allows it. Returns the last attempt,
    with .rejections set to the platform rejections it took (the last attempt included when it was one too) and .lost_502
    to the attempts a 502 ended, which the timing keeps (see Unexplained502s)."""
    rejections = busy = 0
    lost = []
    while True:
        answer = call()
        if answer.status == 429 and busy < busy_retries:
            busy += 1
            sleep(busy_sleep_s)
            continue
        if answer.status == 502 and answer.rejection:
            if unexplained is not None and unexplained.allows(label, answer.rejection):
                lost.append(answer)
            else:
                answer.rejection = None
        if answer.rejection:
            rejections += 1
            last = rejections > PLATFORM_RETRIES
            delay = None if last else PLATFORM_RETRY_DELAYS_S[min(rejections, len(PLATFORM_RETRY_DELAYS_S)) - 1]
            if log is not None:
                log.append({"call": label, "attempt": rejections, "of": PLATFORM_RETRIES + 1, "status": answer.status,
                            "reason": answer.rejection, "nextInS": delay})
            print(f"retry: {label}: {answer.rejection} (attempt {rejections} of {PLATFORM_RETRIES + 1}); "
                  + ("giving up" if last else f"trying again in {delay} s"), flush=True)
            if not last:
                sleep(delay)
                continue
        answer.rejections, answer.lost_502 = rejections, lost
        return answer


def non200_text(answers):
    """'N non-200: <why>' for the failed answers (.status, .rejection) of one row, so a failure always names its reason."""
    kinds = {}
    for answer in answers:
        if answer.status == 200:
            continue
        if answer.rejection:
            kind = f"platform {answer.status} after {PLATFORM_RETRIES} retries"
        elif answer.status == 0:
            kind = "no answer (transport failure or timeout)"
        elif answer.status == -1:
            kind = "not an image of the expected type and size"
        else:
            kind = f"HTTP {answer.status}"
        kinds[kind] = kinds.get(kind, 0) + 1
    total = sum(kinds.values())
    if len(kinds) == 1:
        return f"{total} non-200: {next(iter(kinds))}"
    return f"{total} non-200: " + ", ".join(f"{count} x {kind}" for kind, count in kinds.items())


def round_rejections(label, answers, problems):
    """Adds a problem when Cloud Run turned away more than PLATFORM_REJECTIONS_PER_ROUND attempts of one round."""
    rejected = sum(answer.rejections for answer in answers)
    if rejected > PLATFORM_REJECTIONS_PER_ROUND:
        problems.append(f"{label}: Cloud Run turned away {rejected} attempts in one round of {len(answers)} calls "
                        f"(at most {PLATFORM_REJECTIONS_PER_ROUND}); a capacity problem, not a passing rejection")
    return rejected


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


class MatteAnswer:
    """One /matte attempt: status (0 for a transport failure or timeout), client ms, and the platform rejection reason
    (platform_rejection) when it counts as one. rejections, lost_502: set by served_call."""

    def __init__(self, status, ms, rejection=None):
        self.status, self.ms, self.rejection, self.rejections, self.lost_502 = status, ms, rejection, 0, []


def timed_matte(url, token, model, data):
    """One /matte attempt as a MatteAnswer."""
    started = time.perf_counter()
    rejection = None
    try:
        upload(url + "/matte?model=" + urllib.parse.quote(model), token, data, "probe.png", "image/png")
        status = 200
    except urllib.error.HTTPError as error:
        status, rejection = error.code, platform_rejection(error, time.perf_counter() - started)
    except Exception:  # noqa: BLE001 - any failure is a non-200 for the probe; no detail is printed
        status = 0
    return MatteAnswer(status, int((time.perf_counter() - started) * 1000), rejection)


def percentile(values, share):
    """Nearest-rank percentile; None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(share * len(ordered)) - 1)]


class Probe:
    def __init__(self, url, token, models, sleep=time.sleep, unexplained=None):
        self.url, self.token, self.data, self.sleep = url, token, probe_image(), sleep
        self.models = {model: {"ms": [], "answers": [], "platformRetries": 0, "peakMiB": None} for model in models}
        self.instances = {}
        self.steps = []
        self.problems = []
        self.retries = []
        self.unexplained = unexplained or Unexplained502s()

    def health(self, step, model=None):
        """Reads /health (fresh VRAM) after a step and keeps each instance's newest load counters. The first read of an
        instance before any call is its baseline, so loads from before the probe do not count. A passing platform error
        is tried again (read_with_retry)."""
        try:
            _, body = read_with_retry(f"/health after {step}{' ' + model if model else ''}", self.url + "/health?fresh=1", self.token,
                                      self.sleep, self.retries, unexplained=self.unexplained)
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
        """`count` calls at once; a platform rejection is tried again (served_call) and only the answered attempt is timed,
        plus any attempt a 502 ended."""
        with ThreadPoolExecutor(max_workers=count) as pool:
            results = list(pool.map(lambda _: served_call(lambda: timed_matte(self.url, self.token, model, self.data), f"{model} /matte",
                                                          self.sleep, self.retries, unexplained=self.unexplained), range(count)))
        entry = self.models[model]
        entry["answers"].extend(results)
        entry["platformRetries"] += round_rejections(model, results, self.problems)
        if measured:
            entry["ms"].extend(a.ms for a in results if a.status == 200)
            entry["ms"].extend(lost.ms for a in results for lost in a.lost_502)

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
                 "non200": sum(1 for a in entry["answers"] if a.status != 200), "non200Text": non200_text(entry["answers"]),
                 "calls": len(entry["answers"]), "platformRetries": entry["platformRetries"], "loads": self.loads(model)}
                for model, entry in self.models.items()]

    def failures(self, rows):
        """Any non-200 (with its reason), any unreadable health, a round with too many platform rejections, more non-JSON
        502s than the run allows, and a reload when the shape keeps every probed model resident. With fewer resident
        sessions than models the switching order must reload, so loads are reported, not failed."""
        reloads = [f"{r['model']}: {r['loads']} loads on one instance" for r in rows if r["loads"] > 1] if self.holds_all() else []
        return ([f"{r['model']}: {r['non200Text']}" for r in rows if r["non200"]] + reloads + list(dict.fromkeys(self.problems))
                + self.unexplained.failures())


def print_platform_retries(rows):
    """One line per table row whose calls Cloud Run turned away and the probe tried again (none on a clean run)."""
    for r in rows:
        if r["platformRetries"]:
            print(f"platform retries {r['model']}{' ' + r['size'] if 'size' in r else ''}: {r['platformRetries']} in {r['calls']} calls "
                  f"(not timed; at most {PLATFORM_REJECTIONS_PER_ROUND} per round)", flush=True)


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


def probe_main(argv, token_for=None, report_writer=None, now=None, sleep=time.sleep):
    """Runs the probe and returns the exit code. Tokens never reach stdout."""
    args = parse_probe_args(argv)
    token = None if args.url.startswith("http://") else (token_for or identity_token)(audience_for(args.url))
    started = now or datetime.datetime.now(datetime.timezone.utc)
    run = args.run or os.environ.get("CLOUD_RUN_EXECUTION") or started.strftime("%Y%m%dT%H%M%SZ")
    probe = Probe(args.url, token, args.models, sleep)
    probe.run(args.concurrency, args.rounds)
    rows = probe.rows()
    failures = probe.failures(rows)
    report = {"run": run, "url": args.url, "startedAt": started.isoformat(), "imagePx": PROBE_SIZE, "models": args.models,
              "concurrency": args.concurrency, "rounds": args.rounds, "rows": rows, "reloadsChecked": probe.holds_all(),
              "instances": probe.instances, "steps": probe.steps, "retries": probe.retries, "unexplained502s": probe.unexplained.report(),
              "passed": not failures, "failures": failures}
    print(markdown(rows), flush=True)
    print_platform_retries(rows)
    print(probe.unexplained.line(), flush=True)
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
#   --determinism-calls n   per model, n calls of the same 800x1200 image at once (429 retried; like every measured
#                           call, a platform rejection too, see PLATFORM_RETRIES), each with its sha256
#                           and instance id; repeated up to 3 times until at least 2 instances answered. Fails when
#                           fewer than 2 instances answered, on any non-200, on two outputs from one instance, or on
#                           outputs from two instances that differ visibly.
#   --x2-max-pixels p       the cap timeout check (cap_timeout_check), per model: the largest image the service takes
#   --x4-max-pixels p       for it (p pixels, UPSCALE_MAX_PIXELS and UPSCALE_MAX_PIXELS_X4) must finish within --timeout
#                           (the service's request timeout) with CAP_TIMEOUT_MARGIN to spare, at that model's slowest
#                           measured p95 seconds per megapixel.
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
# Spec 18 GPU upscaler (2026-10-30): with --determinism-seconds s the round keeps going past DETERMINISM_ATTEMPTS until
# 2 instances answered or s seconds passed, at most this many rounds. A GPU round of 12 calls ends in about 10 s, long
# before Cloud Run starts a second GPU instance (42 to 92 s measured), so 3 rounds alone stayed on one instance.
DETERMINISM_MAX_ROUNDS = 200
# A 429 (no instance free within Cloud Run's queue time) is retried after this many seconds, at most this many times.
BUSY_RETRY_S = 10
BUSY_RETRIES = 30
COLD_START_ATTEMPTS = 3
# How long the occupying call runs before /health is sent, so it holds its instance first.
COLD_START_HOLD_S = 5
# The cap timeout check (2026-10-31, replaces the x4/x2 ratio of two single calls, which refused a healthy revision at
# 1.51 when one x2 call was the fastest on record; .runs/2026-10-30-18-cpu-scale.md). The margin is shape.sh's: a
# service timeout covers twice the p95 of the largest image it takes.
CAP_TIMEOUT_MARGIN = 2
# Per scale: the pixel cap's variable (infra/lib/shape.sh) and the static time ratio that sizes it there.
CAP_VARIABLES = {2: ("UPSCALE_MAX_PIXELS", "UPSCALE_X2_TIME_RATIO"), 4: ("UPSCALE_MAX_PIXELS_X4", "UPSCALE_X4_TIME_RATIO")}
# A size with at least this many timed calls sets its slowest call aside before taking the p95 (timing_p95), so one
# slow call (a noisy neighbour, one slow host) cannot fail the gate while two slow calls in 13 still can.
TIMING_TRIM_MIN_CALLS = 10


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
    not a JPEG of exactly `scale` times `size`. instance: the X-Instance-Id header (None from a revision before it).
    server_seconds: the service's own inference time (the X-Upscale-Ms header; None when absent or unreadable)."""

    def __init__(self, status, seconds, digest=None, instance=None, body=None, server_seconds=None, rejection=None):
        self.status, self.seconds, self.digest, self.instance, self.body = status, seconds, digest, instance, body
        # rejection: why this attempt counts as a platform rejection (platform_rejection), else None; rejections, lost_502:
        # set by served_call.
        self.server_seconds, self.rejection, self.rejections, self.lost_502 = server_seconds, rejection, 0, []

    def __iter__(self):
        # (status, seconds, digest), as callers before the instance id unpacked it.
        return iter((self.status, self.seconds, self.digest))

    @property
    def work_seconds(self):
        """The call's time for the timeout check: the service's inference time, which a cold start, a 429 queue or the
        upload never inflate (the determinism round's calls mostly start new instances), else the client's time."""
        return self.server_seconds if self.server_seconds is not None else self.seconds


def server_seconds(headers):
    value = headers.get("X-Upscale-Ms")
    return int(value) / 1000 if value is not None and re.fullmatch(r"[0-9]{1,9}", value.strip()) else None


def timed_upscale(url, token, model, data, size, timeout, scale=2):
    """One /upscale call as an UpscaleAnswer."""
    started = time.perf_counter()
    digest = instance = kept = served = rejection = None
    try:
        headers, body = request(f"{url}/upscale?model={urllib.parse.quote(model)}&scale={scale}", token, data, "image/jpeg", timeout, UPSCALE_RESPONSE_LIMIT)
        try:
            with Image.open(io.BytesIO(body)) as answer:
                ok = headers.get_content_type() == "image/jpeg" and answer.format == "JPEG" and answer.size == (size[0] * scale, size[1] * scale)
        except Exception:  # noqa: BLE001 - an unreadable answer is a failed call; no detail is printed
            ok = False
        instance = headers.get("X-Instance-Id")
        status, digest, kept = (200, hashlib.sha256(body).hexdigest(), body) if ok else (-1, None, None)
        served = server_seconds(headers) if ok else None
    except urllib.error.HTTPError as error:
        status, rejection = error.code, platform_rejection(error, time.perf_counter() - started)
    except Exception:  # noqa: BLE001 - any failure is a non-200 for the probe; no detail is printed
        status = 0
    return UpscaleAnswer(status, time.perf_counter() - started, digest, instance, kept, served, rejection)


def upscale_until_served(url, token, model, data, size, timeout, scale, sleep=time.sleep, log=None, busy_retries=BUSY_RETRIES, unexplained=None):
    """timed_upscale until a container answered (served_call): a 429 (every instance busy) is tried again `busy_retries`
    times, BUSY_RETRY_S apart (the determinism round), and a platform rejection PLATFORM_RETRIES times."""
    return served_call(lambda: timed_upscale(url, token, model, data, size, timeout, scale), f"{model} {size[0]}x{size[1]} /upscale",
                       sleep, log, busy_retries, BUSY_RETRY_S, unexplained)


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
    def __init__(self, url, token, model, sizes, timeout, sleep=time.sleep, unexplained=None):
        # `token`: None (a local URL), a token, or a callable that returns the current one (RefreshingToken).
        self.url, self.token_source, self.model, self.timeout, self.sleep = url, token, model, timeout, sleep
        self.retries = []
        self.scale = UPSCALE_PROBE_MODELS.get(model, 2)
        # Per size: the bodies of its distinct outputs (sha256 -> bytes) until it is judged, then its judgement. Only the
        # size being probed holds bodies, so at most one input's distinct outputs are in memory at once.
        self.sizes = {size: {"data": upscale_image(*size), "s": [], "answers": [], "bodies": {}, "judged": None, "platformRetries": 0} for size in sizes}
        self.service = {}
        self.steps = []
        self.problems = []
        self.determinism = None
        # Per size: the work_seconds of every measured 200 (the rounds and the determinism round, not the warm call).
        self.work = {}
        # The sizes where a 502 ended a measured attempt: timing_p95 keeps their slowest call.
        self.lost_sizes = set()
        self.unexplained = unexplained or Unexplained502s()

    @property
    def token(self):
        return current_token(self.token_source)

    def health(self, step):
        # A passing platform error is tried again (read_with_retry); the 2026-11-05 gate failure was one such 503 here.
        try:
            _, body = read_with_retry(f"{self.model} /health after {step}", self.url + "/health", self.token, self.sleep, self.retries,
                                      unexplained=self.unexplained)
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
            results = list(pool.map(lambda _: upscale_until_served(self.url, token, self.model, entry["data"], size, self.timeout, self.scale, self.sleep,
                                                                   self.retries, busy_retries=0, unexplained=self.unexplained), range(count)))
        entry["answers"].extend(keep_bodies(results, entry["bodies"]))
        entry["platformRetries"] += round_rejections(f"{size[0]}x{size[1]} round", results, self.problems)
        if measured:
            entry["s"].extend(a.seconds for a in results if a.status == 200)
            entry["s"].extend(lost.seconds for a in results for lost in a.lost_502)
            self.work.setdefault(size, []).extend(a.work_seconds for a in results if a.status == 200)
            self.note_lost(size, results)

    def note_lost(self, size, results):
        if any(a.lost_502 for a in results):
            self.lost_sizes.add(size)

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

    def determinism_round(self, count, size=DETERMINISM_SIZE, sleep=time.sleep, seconds_budget=0, clock=time.monotonic):
        """Spec 18 gate (plan 7.2): `count` calls of one image at once, until at least 2 instances answered (at most
        DETERMINISM_ATTEMPTS rounds, or more while fewer than `seconds_budget` seconds passed, up to
        DETERMINISM_MAX_ROUNDS). Every call keeps its sha256 and instance id."""
        data, label = upscale_image(*size), f"{self.model} {size[0]}x{size[1]} determinism"
        answers, calls, bodies, capacity = [], [], {}, []
        began = clock()
        for attempt in range(1, DETERMINISM_MAX_ROUNDS + 1):
            if attempt > DETERMINISM_ATTEMPTS and clock() - began >= seconds_budget:
                attempt -= 1
                break
            token = self.token
            with ThreadPoolExecutor(max_workers=count) as pool:
                results = list(pool.map(lambda _: upscale_until_served(self.url, token, self.model, data, size, self.timeout, self.scale, sleep,
                                                                       self.retries, unexplained=self.unexplained), range(count)))
            round_rejections(f"{label} round {attempt}", results, capacity)
            answers += keep_bodies(results, bodies)
            self.work.setdefault(size, []).extend(a.work_seconds for a in results if a.status == 200)
            self.note_lost(size, results)
            calls += [{"attempt": attempt, "status": a.status, "s": seconds(a.seconds), "serverS": seconds(a.server_seconds), "instance": a.instance,
                       "sha256": a.digest, "platformRetries": a.rejections} for a in results]
            if len({a.instance for a in answers if a.status == 200 and a.instance}) >= 2:
                break
        summary, failures = judge_outputs(label, answers, bodies)
        bodies.clear()
        if any(a.status != 200 for a in answers):
            failures.insert(0, f"{label}: {non200_text(answers)}")
        failures += list(dict.fromkeys(capacity))
        if summary["instances"] < 2:
            failures.append(f"{label}: {summary['instances']} instance(s) answered in {attempt} rounds of {count} calls; at least 2 are needed")
        self.determinism = {"model": self.model, "size": f"{size[0]}x{size[1]}", "callsPerRound": count, "rounds": attempt, "calls": calls,
                            "platformRetries": sum(a.rejections for a in answers), **summary, "passed": not failures, "failures": failures}
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
                        "non200": sum(1 for status in statuses if status != 200), "non200Text": non200_text(entry["answers"]), "calls": len(statuses),
                        "platformRetries": entry["platformRetries"],
                        "outputSha256": digests[0] if len(digests) == 1 else None, "distinctOutputs": len(digests),
                        "instances": summary["instances"], "outputs": summary["outputs"], "difference": summary["worst"], "outputFailures": failures,
                        "callLog": [{"status": a.status, "s": seconds(a.seconds), "serverS": seconds(a.server_seconds), "instance": a.instance, "sha256": a.digest,
                                     "platformRetries": a.rejections} for a in entry["answers"]]})
        return out

    def failures(self, rows):
        return ([f"{r['model']} {r['size']}: {r['non200Text']}" for r in rows if r["non200"]]
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


def timing_p95(values, trim=True):
    """The p95 the x4 timeout check judges: nearest-rank, after setting aside the single slowest call when a size has at
    least TIMING_TRIM_MIN_CALLS calls. With the gate's 13 x4 calls at 800x1200 (1 round + 12 determinism calls) it is
    the second slowest: one outlier passes, two slow calls (15%, a real tail) or a slow model fail. Fewer calls are
    judged whole (a single call is its own p95). None for no values.
    trim=False (a 502 ended one of this size's attempts): nothing is set aside. The lost attempt has no inference time
    to judge and it may have been a slow one, so it uses up the one outlier the size is allowed: with at most one lost
    attempt the answer is never below what the size would have got had that attempt been answered."""
    ordered = sorted(values)
    if trim and len(ordered) >= TIMING_TRIM_MIN_CALLS:
        ordered = ordered[:-1]
    return percentile(ordered, 0.95)


def cap_timeout_check(timings, caps, timeout, margin=CAP_TIMEOUT_MARGIN, lost=()):
    """The property each pixel cap needs (spec 18 3.6.6, infra/lib/shape.sh upscale_check): the largest image the
    service takes for a model of scale s, `caps[s]` (UPSCALE_MAX_PIXELS for x2, UPSCALE_MAX_PIXELS_X4 for x4), finishes
    within the service timeout `timeout` with `margin` to spare. Its time is estimated as shape.sh does: the slowest
    measured p95 seconds per megapixel over the probe sizes (the smallest size carries the most fixed cost per pixel, a
    safe bound for larger images) times its megapixels. The p95 per size is timing_p95 over every timed call of that
    size (the rounds and the determinism round), on the service's own inference time (UpscaleAnswer.work_seconds).
    This replaces the 2026-10-29 x4/x2 ratio check (one x4 call over one x2 call), which tested an assumption of the
    static sizing instead of the property, and whose two single calls could land on different hosts: a fast x2 call
    alone failed a healthy revision at 1.51 (2026-10-30). The x4/x2 median ratio is reported, never judged.
    `timings`: {model: {(width, height): [seconds, ...]}}; `caps`: {scale: pixels}, 0 or absent checks nothing for that
    scale; `lost`: the (model, size) pairs where a 502 ended a measured attempt, judged untrimmed. Returns (report entry
    or None when no cap is checked, failures)."""
    caps = {scale: pixels for scale, pixels in caps.items() if pixels}
    if not caps:
        return None, []
    x2_models = [m for m in timings if UPSCALE_PROBE_MODELS.get(m) == 2]
    entry = {"timeoutS": timeout, "margin": margin, "caps": {f"x{s}": p for s, p in sorted(caps.items())}, "models": []}
    failures = []
    for scale, max_pixels in sorted(caps.items()):
        variable, ratio = CAP_VARIABLES[scale]
        models = [m for m in timings if UPSCALE_PROBE_MODELS.get(m) == scale]
        if not any(any(timings[m].values()) for m in models):
            failures.append(f"x{scale} timeout check: no x{scale} call was timed, so {variable}={max_pixels} is not shown to fit the {timeout} s timeout")
        for model in models:
            sizes = []
            for (width, height), values in timings[model].items():
                if not values:
                    continue
                megapixels = width * height / 1_000_000
                p95 = timing_p95(values, trim=(model, (width, height)) not in lost)
                median = statistics.median(values)
                size = {"size": f"{width}x{height}", "calls": len(values), "p50S": seconds(median), "p95S": seconds(p95),
                        "maxS": seconds(max(values)), "sPerMp": round(p95 / megapixels, 2)}
                if scale == 4:
                    x2_median = next((statistics.median(timings[m][(width, height)]) for m in x2_models if timings[m].get((width, height))), None)
                    size["x4OverX2Median"] = round(median / x2_median, 3) if x2_median else None
                sizes.append(size)
            if not sizes:
                continue
            worst = max(sizes, key=lambda s: s["sPerMp"])
            estimate = worst["sPerMp"] * max_pixels / 1_000_000
            need = margin * estimate
            fits = int(timeout / margin / worst["sPerMp"] * 1_000_000)
            entry["models"].append({"model": model, "scale": scale, "maxPixels": max_pixels, "sizes": sizes, "worstSize": worst["size"],
                                    "sPerMp": worst["sPerMp"], "estimateS": seconds(estimate), "needS": seconds(need), "fitsMaxPixels": fits,
                                    "passed": need <= timeout})
            if need > timeout:
                failures.append(f"{model}: {variable}={max_pixels} needs {margin:g} x {estimate:.0f} s = {need:.0f} s at the slowest measured "
                                f"p95 of {worst['sPerMp']} s per MP ({worst['size']}, {worst['calls']} calls), above the {timeout} s timeout; "
                                f"lower {variable} to at most {fits} and raise {ratio} to match (infra/lib/shape.sh)")
    entry["passed"] = not failures
    return entry, failures


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
    # A FAILED line always names why (the failures without their "<model> <size> determinism: " label).
    prefix = f"{entry['model']} {entry['size']} determinism: "
    reasons = "; ".join(f[len(prefix):] if f.startswith(prefix) else f for f in entry["failures"])
    return (f"determinism {entry['model']} {entry['size']}: {len(entry['calls'])} calls, {entry.get('platformRetries', 0)} platform retries, "
            f"{entry['instances']} instances, {entry['distinctOutputs']} distinct outputs ({difference}): "
            + ("passed" if entry["passed"] else f"FAILED ({reasons})"))


def parse_upscale_args(argv):
    parser = argparse.ArgumentParser(prog="cloudrun_check.py --probe-upscale")
    parser.add_argument("--probe-upscale", dest="url", required=True)
    parser.add_argument("--model", default="swinir-x2")
    parser.add_argument("--sizes", default=UPSCALE_PROBE_SIZES)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--x2-max-pixels", dest="x2_max_pixels", type=int, default=0)
    parser.add_argument("--x4-max-pixels", dest="x4_max_pixels", type=int, default=0)
    parser.add_argument("--determinism-calls", dest="determinism_calls", type=int, default=0)
    parser.add_argument("--determinism-seconds", dest="determinism_seconds", type=int, default=0)
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
    require(0 <= args.x2_max_pixels <= 100_000_000, "--x2-max-pixels must be 0 (no check) to 100000000 pixels")
    require(0 <= args.x4_max_pixels <= 100_000_000, "--x4-max-pixels must be 0 (no check) to 100000000 pixels")
    require(args.determinism_calls == 0 or 2 <= args.determinism_calls <= 16, "--determinism-calls must be 0 (none) or 2 to 16")
    require(0 <= args.determinism_seconds <= 3600, "--determinism-seconds must be 0 (3 rounds only) to 3600 seconds")
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
    rows, failures, steps, service, determinism, cold_start, timings, retries = [], [], [], {}, [], None, {}, []
    unexplained, lost = Unexplained502s(), set()
    # First, before any call warms the candidate (spec 18 gate, plan 7.2).
    if args.cold_start_max:
        cold_start, cold_failures = measure_cold_start(args.url, token, args.models[0], DETERMINISM_SIZE, args.timeout, args.cold_start_max, sleep=sleep)
        failures += cold_failures
    # One model after the other (the service runs one tile at a time; a concurrency 1 shape must never see two models).
    for model in args.models:
        probe = UpscaleProbe(args.url, token, model, args.sizes, args.timeout, sleep, unexplained)
        probe.run(args.concurrency, args.rounds)
        if args.determinism_calls:
            determinism.append(probe.determinism_round(args.determinism_calls, sleep=sleep, seconds_budget=args.determinism_seconds))
        model_rows = probe.rows(args.concurrency)
        rows += model_rows
        failures += probe.failures(model_rows)
        steps += [{"model": model, **step} for step in probe.steps]
        service.update(probe.service)
        timings[model] = probe.work
        lost |= {(model, size) for size in probe.lost_sizes}
        retries += probe.retries
    cap_timeout, cap_failures = cap_timeout_check(timings, {2: args.x2_max_pixels, 4: args.x4_max_pixels}, args.timeout, lost=lost)
    failures += cap_failures + unexplained.failures()
    report = {"run": run, "url": args.url, "startedAt": started.isoformat(), "models": args.models,
              "sizes": [f"{w}x{h}" for w, h in args.sizes], "concurrency": args.concurrency, "rounds": args.rounds,
              "timeoutS": args.timeout, "service": service, "rows": rows, "steps": steps, "determinism": determinism,
              "coldStart": cold_start, "capTimeout": cap_timeout, "retries": retries, "unexplained502s": unexplained.report(), "visualLimit": {"maxAbs": VISUAL_MAX_ABS, "minPsnrDb": VISUAL_MIN_PSNR_DB},
              "passed": not failures, "failures": failures}
    print(upscale_markdown(rows), flush=True)
    print_platform_retries(rows)
    print(unexplained.line(), flush=True)
    for entry in determinism:
        print(determinism_line(entry), flush=True)
    for entry in (cap_timeout or {}).get("models", []):
        print(f"cap timeout {entry['model']}: {cap_timeout['margin']:g} x {entry['sPerMp']} s per MP ({entry['worstSize']} p95) x "
              f"{entry['maxPixels'] / 1_000_000:g} MP = {entry['needS']} s (timeout {cap_timeout['timeoutS']} s): "
              f"{'passed' if entry['passed'] else 'FAILED'}", flush=True)
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
