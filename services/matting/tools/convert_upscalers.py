"""Build-time conversion of the pinned upscaler checkpoints to fixed-tile ONNX.

Runs only in the Dockerfile's upscale-models stage. Every source file is downloaded from its
official release URL and checked against a pinned sha256 before use; nothing is fetched at
request time. Each export is checked against PyTorch (max abs difference) and run twice through
ONNX Runtime to prove byte-identical output for identical input.

Usage: python convert_upscalers.py <output-dir> <download-dir>
"""
import hashlib
import json
import sys
import types
import urllib.request
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn as nn

# Official sources. Changing any URL requires updating its sha256 and services/matting/README.md.
# Spec 18 quality (2026-10-29 bake-off): only SwinIR-S lightweight (DIV2K bicubic, Apache-2.0) is served, x2 for
# enlargements up to 2x and x4 above. Real-ESRGAN is no longer built: on real brand photos it invented or erased
# texture and shifted colour.
SWINIR_RELEASE = "https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/"
SWINIR_WEIGHTS = {
    2: ("002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth", "193b229909ca89cd8b55de9c9e7fce146ae759d59dfcd78d8feb9dd1d6fa0fd7"),
    4: ("002_lightweightSR_DIV2K_s64w8_SwinIR-S_x4.pth", "09fad24e32ae62722e1a055efde9921328f4137981bab0a42a4a3a806306c58e"),
}
SWINIR_COMMIT = "6545850fbf8df298df73d81f3e8cba638787c8bd"
SWINIR_ARCH_URL = f"https://raw.githubusercontent.com/JingyunLiang/SwinIR/{SWINIR_COMMIT}/models/network_swinir.py"
SWINIR_ARCH_SHA256 = "9e143898679ebeebc5d2fc94ad1b89c38aa4a4d43da4e0fcba0f93e476994913"

# Fixed tile input size. The service reads the tile size back from the ONNX input shape and the scale from its output.
SWINIR_TILE = 384  # a multiple of the SwinIR window size (8)
OPSET = 17

# 2026-10-29 review P2-7: the first 8 hex of each export's sha256, as packages/core/src/catalog/upscale.ts
# UPSCALE_MODEL_VERSIONS names it in every render key. A build that exports other bytes fails here, so no output can
# carry a key naming an export that did not make it (tests/test_upscale.py checks both lists agree).
EXPORT_SHA256_PREFIX = {"swinir-x2": "9f4a3f85", "swinir-x4": "f477a052"}


def fetch(url, sha256, folder):
    target = folder / url.rsplit("/", 1)[1]
    if not target.is_file():
        with urllib.request.urlopen(url, timeout=600) as response:
            target.write_bytes(response.read())
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    if digest != sha256:
        raise SystemExit(f"sha256 mismatch for {url}: got {digest}, pinned {sha256}")
    print(f"verified {url} sha256={digest}", flush=True)
    return target


def swinir(folder, scale):
    # network_swinir.py imports three helpers from timm. At inference DropPath is the identity and
    # the init helpers are overwritten by the checkpoint, so minimal stand-ins avoid installing timm.
    layers = types.ModuleType("timm.models.layers")
    layers.DropPath = lambda *args, **kwargs: nn.Identity()
    layers.to_2tuple = lambda value: value if isinstance(value, tuple) else (value, value)
    layers.trunc_normal_ = nn.init.trunc_normal_
    timm = types.ModuleType("timm")
    timm.models = types.ModuleType("timm.models")
    timm.models.layers = layers
    sys.modules.update({"timm": timm, "timm.models": timm.models, "timm.models.layers": layers})
    source = fetch(SWINIR_ARCH_URL, SWINIR_ARCH_SHA256, folder)
    namespace = {"__name__": "network_swinir"}
    exec(compile(source.read_text(encoding="utf-8"), str(source), "exec"), namespace)
    # Hyperparameters from main_test_swinir.py, task lightweight_sr, at the pinned commit.
    model = namespace["SwinIR"](upscale=scale, in_chans=3, img_size=64, window_size=8, img_range=1.0,
                                depths=[6, 6, 6, 6], embed_dim=60, num_heads=[6, 6, 6, 6], mlp_ratio=2,
                                upsampler="pixelshuffledirect", resi_connection="1conv")
    name, sha256 = SWINIR_WEIGHTS[scale]
    state = torch.load(fetch(SWINIR_RELEASE + name, sha256, folder), map_location="cpu", weights_only=True)
    model.load_state_dict(state["params"], strict=True)
    return model


def probe(tile):
    # Deterministic structured input: gradients plus a hard edge, values in [0, 1].
    y, x = np.mgrid[0:tile, 0:tile].astype(np.float32) / max(tile - 1, 1)
    edge = ((x > 0.5) ^ (y > 0.3)).astype(np.float32)
    return np.ascontiguousarray(np.stack([x, y, 0.25 + 0.5 * edge])[None])


def export(model_id, model, tile, scale, out_dir):
    torch.manual_seed(0)
    model.eval()
    target = out_dir / f"{model_id}.onnx"
    sample = torch.from_numpy(probe(tile))
    with torch.inference_mode():
        expected = model(sample).numpy()
    with torch.no_grad():
        torch.onnx.export(model, (sample,), str(target), input_names=["input"], output_names=["output"],
                          opset_version=OPSET, dynamo=False, do_constant_folding=True)
    onnx.checker.check_model(str(target))
    options = ort.SessionOptions()
    options.use_deterministic_compute = True
    session = ort.InferenceSession(str(target), sess_options=options, providers=["CPUExecutionProvider"])
    first = session.run(None, {"input": probe(tile)})[0]
    second = session.run(None, {"input": probe(tile)})[0]
    if first.shape != (1, 3, tile * scale, tile * scale):
        raise SystemExit(f"{model_id}: unexpected output shape {first.shape}")
    if first.tobytes() != second.tobytes():
        raise SystemExit(f"{model_id}: ONNX Runtime output differs between identical runs")
    difference = float(np.abs(first - expected).max())
    if difference > 2e-3:
        raise SystemExit(f"{model_id}: ONNX output differs from PyTorch by {difference}")
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    print(f"exported {model_id} tile={tile} scale={scale} max_abs_diff={difference:.2e} sha256={digest}", flush=True)
    if not digest.startswith(EXPORT_SHA256_PREFIX[model_id]):
        raise SystemExit(f"{model_id}: export sha256 {digest} does not start with the pinned {EXPORT_SHA256_PREFIX[model_id]}; "
                         "a new export needs a new pin here and in UPSCALE_MODEL_VERSIONS (packages/core/src/catalog/upscale.ts)")
    return {"file": target.name, "tile": tile, "scale": scale, "sha256": digest}


def main():
    out_dir, downloads = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    downloads.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    manifest = {
        f"swinir-x{scale}": export(f"swinir-x{scale}", swinir(downloads, scale), SWINIR_TILE, scale, out_dir)
        for scale in sorted(SWINIR_WEIGHTS)
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
