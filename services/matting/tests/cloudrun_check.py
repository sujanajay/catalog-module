import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

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


def main():
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
