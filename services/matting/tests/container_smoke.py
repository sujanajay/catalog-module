"""Real CPU image smoke, invoked against a running container by Cloud Build.

This is deliberately separate from mocked endpoint tests. No OpenRouter or cloud
services are called. The all-model service must already be running on localhost.
"""
import io
import json
import time
from pathlib import Path

import httpx
from PIL import Image, ImageDraw

started = time.perf_counter()
with httpx.Client(base_url="http://127.0.0.1:8080", timeout=300) as client:
    for attempt in range(180):
        try:
            health = client.get("/health")
            if health.status_code == 200:
                break
        except httpx.TransportError:
            pass
        time.sleep(2)
    else:
        raise RuntimeError("CPU container did not become healthy within 360s")
    payload = health.json()
    assert payload["ok"] and len(payload["models"]) == 4, payload
    assert {model["target"] for model in payload["models"]} == {"cpu"}
    print(json.dumps({"health": payload, "startup_wait_ms": round((time.perf_counter() - started) * 1000)}), flush=True)
    # A contrasting geometric object tests real model execution and output geometry.
    image = Image.new("RGB", (512, 512), "white")
    ImageDraw.Draw(image).ellipse((96, 64, 416, 448), fill=(32, 70, 180))
    source = io.BytesIO()
    image.save(source, format="PNG")
    for model in ("birefnet-general", "birefnet-general-lite"):
        response = client.post("/matte", params={"model": model}, files={"file": ("synthetic.png", source.getvalue(), "image/png")})
        response.raise_for_status()
        mask = Image.open(io.BytesIO(response.content))
        assert mask.mode == "L" and mask.size == image.size
        assert mask.getpixel((256, 256)) > 128, (model, "missing foreground")
        assert mask.getpixel((0, 0)) < 128, (model, "background retained")
        print(json.dumps({"model": model, "inference_ms": int(response.headers["x-ms"])}), flush=True)
    data = (Path(__file__).parent / "fixtures" / "small.heic").read_bytes()
    response = client.post("/convert", files={"file": ("small.heic", data, "image/heic")})
    response.raise_for_status()
    converted = Image.open(io.BytesIO(response.content))
    assert converted.format == "PNG" and converted.size == (32, 24)
    print(json.dumps({"heic_convert_ms": int(response.headers["x-ms"]), "ok": True}), flush=True)
