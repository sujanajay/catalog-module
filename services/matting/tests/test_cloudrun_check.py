"""Offline runtime-probe regression tests with real HEIF encoding/decoding."""
import email.message
import importlib.util
import io
import json
from pathlib import Path
import urllib.error

from PIL import Image
import pytest

spec = importlib.util.spec_from_file_location("cloudrun_check", Path(__file__).with_name("cloudrun_check.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


@pytest.mark.parametrize("conversion", ["source", "white", "black", "inverted"])
def test_convert_preserves_heic_content(monkeypatch, conversion, capsys):
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
                from PIL import ImageOps
                response = ImageOps.invert(response)
            headers["x-input-format"] = "heic"
        else:
            response = Image.new("L", source.size)
            response.putpixel((128, 96), 255)
            headers["x-model"] = "birefnet-general"
            headers["x-input-size"] = "256x192"
        output = io.BytesIO()
        response.save(output, format="PNG")
        return headers, output.getvalue()

    monkeypatch.setattr(probe, "request", request)
    monkeypatch.setattr(probe, "identity_token", lambda audience: "offline-token")
    monkeypatch.setattr(probe, "upload", upload)
    if conversion == "source":
        probe.check("cpu", url, "abc1234")
        assert json.loads(capsys.readouterr().out)["convert"] == "passed"
    else:
        with pytest.raises(probe.CheckFailure, match="HEIC conversion pixels differ"):
            probe.check("cpu", url, "abc1234")
