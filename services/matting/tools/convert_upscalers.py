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
import torch.nn.functional as F

# Official sources. Changing any URL requires updating its sha256 and services/matting/README.md.
REALESRGAN_URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth"
REALESRGAN_SHA256 = "49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb"
SWINIR_URL = "https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth"
SWINIR_SHA256 = "193b229909ca89cd8b55de9c9e7fce146ae759d59dfcd78d8feb9dd1d6fa0fd7"
SWINIR_COMMIT = "6545850fbf8df298df73d81f3e8cba638787c8bd"
SWINIR_ARCH_URL = f"https://raw.githubusercontent.com/JingyunLiang/SwinIR/{SWINIR_COMMIT}/models/network_swinir.py"
SWINIR_ARCH_SHA256 = "9e143898679ebeebc5d2fc94ad1b89c38aa4a4d43da4e0fcba0f93e476994913"

# Fixed tile input sizes. The service reads the tile size back from the ONNX input shape.
REALESRGAN_TILE = 512
SWINIR_TILE = 384  # a multiple of the SwinIR window size (8)
OPSET = 17


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


# RRDBNet as defined in basicsr/archs/rrdbnet_arch.py (BasicSR, Apache-2.0), the architecture
# Real-ESRGAN x2plus uses. Reproduced to avoid installing basicsr; strict state-dict loading
# below proves the layout matches the checkpoint exactly.
def pixel_unshuffle(x, scale):
    b, c, hh, hw = x.size()
    h, w = hh // scale, hw // scale
    return x.view(b, c, h, scale, w, scale).permute(0, 1, 3, 5, 2, 4).reshape(b, c * scale * scale, h, w)


class ResidualDenseBlock(nn.Module):
    def __init__(self, num_feat=64, num_grow_ch=32):
        super().__init__()
        self.conv1 = nn.Conv2d(num_feat, num_grow_ch, 3, 1, 1)
        self.conv2 = nn.Conv2d(num_feat + num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv3 = nn.Conv2d(num_feat + 2 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv4 = nn.Conv2d(num_feat + 3 * num_grow_ch, num_grow_ch, 3, 1, 1)
        self.conv5 = nn.Conv2d(num_feat + 4 * num_grow_ch, num_feat, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x))
        x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1)))
        x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        x5 = self.conv5(torch.cat((x, x1, x2, x3, x4), 1))
        return x5 * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, num_feat, num_grow_ch=32):
        super().__init__()
        self.rdb1 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb2 = ResidualDenseBlock(num_feat, num_grow_ch)
        self.rdb3 = ResidualDenseBlock(num_feat, num_grow_ch)

    def forward(self, x):
        return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x


class RRDBNetX2(nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23, num_grow_ch=32):
        super().__init__()
        self.conv_first = nn.Conv2d(num_in_ch * 4, num_feat, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(num_feat, num_grow_ch) for _ in range(num_block)])
        self.conv_body = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up1 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_hr = nn.Conv2d(num_feat, num_feat, 3, 1, 1)
        self.conv_last = nn.Conv2d(num_feat, num_out_ch, 3, 1, 1)
        self.lrelu = nn.LeakyReLU(negative_slope=0.2, inplace=True)

    def forward(self, x):
        feat = self.conv_first(pixel_unshuffle(x, 2))
        feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode="nearest")))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode="nearest")))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


def realesrgan(folder):
    model = RRDBNetX2()
    state = torch.load(fetch(REALESRGAN_URL, REALESRGAN_SHA256, folder), map_location="cpu", weights_only=True)
    model.load_state_dict(state["params_ema"], strict=True)
    return model


def swinir(folder):
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
    model = namespace["SwinIR"](upscale=2, in_chans=3, img_size=64, window_size=8, img_range=1.0,
                                depths=[6, 6, 6, 6], embed_dim=60, num_heads=[6, 6, 6, 6], mlp_ratio=2,
                                upsampler="pixelshuffledirect", resi_connection="1conv")
    state = torch.load(fetch(SWINIR_URL, SWINIR_SHA256, folder), map_location="cpu", weights_only=True)
    model.load_state_dict(state["params"], strict=True)
    return model


def probe(tile):
    # Deterministic structured input: gradients plus a hard edge, values in [0, 1].
    y, x = np.mgrid[0:tile, 0:tile].astype(np.float32) / max(tile - 1, 1)
    edge = ((x > 0.5) ^ (y > 0.3)).astype(np.float32)
    return np.ascontiguousarray(np.stack([x, y, 0.25 + 0.5 * edge])[None])


def export(model_id, model, tile, out_dir):
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
    if first.shape != (1, 3, tile * 2, tile * 2):
        raise SystemExit(f"{model_id}: unexpected output shape {first.shape}")
    if first.tobytes() != second.tobytes():
        raise SystemExit(f"{model_id}: ONNX Runtime output differs between identical runs")
    difference = float(np.abs(first - expected).max())
    if difference > 2e-3:
        raise SystemExit(f"{model_id}: ONNX output differs from PyTorch by {difference}")
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    print(f"exported {model_id} tile={tile} max_abs_diff={difference:.2e} sha256={digest}", flush=True)
    return {"file": target.name, "tile": tile, "scale": 2, "sha256": digest}


def main():
    out_dir, downloads = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    downloads.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(4)
    manifest = {
        "realesrgan-x2plus": export("realesrgan-x2plus", realesrgan(downloads), REALESRGAN_TILE, out_dir),
        "swinir-x2": export("swinir-x2", swinir(downloads), SWINIR_TILE, out_dir),
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
