"""Bake-off conversion: candidate checkpoints to fixed-tile ONNX, same recipe as
services/matting/tools/convert_upscalers.py (opset 17, dynamo=False, constant folding, ORT determinism check).
Usage: python -I convert.py <model-id> [...]
"""
import hashlib, sys, types, time
from pathlib import Path
import numpy as np
import onnx, onnxruntime as ort
import torch, torch.nn as nn, torch.nn.functional as F

W = Path(r"Q:\w")
OUT = Path(r"Q:\onnx")
OUT.mkdir(exist_ok=True)


def stub_timm():
    layers = types.ModuleType("timm.models.layers")
    layers.DropPath = lambda *a, **k: nn.Identity()
    layers.to_2tuple = lambda v: v if isinstance(v, tuple) else (v, v)
    layers.trunc_normal_ = nn.init.trunc_normal_
    timm = types.ModuleType("timm"); timm.models = types.ModuleType("timm.models"); timm.models.layers = layers
    sys.modules.update({"timm": timm, "timm.models": timm.models, "timm.models.layers": layers})


def load_module(path):
    ns = {"__name__": path.stem}
    exec(compile(path.read_text(encoding="utf-8"), str(path), "exec"), ns)
    return ns


def pixel_unshuffle(x, scale):
    b, c, hh, hw = x.size(); h, w = hh // scale, hw // scale
    return x.view(b, c, h, scale, w, scale).permute(0, 1, 3, 5, 2, 4).reshape(b, c * scale * scale, h, w)


class RDB(nn.Module):
    def __init__(self, nf=64, gc=32):
        super().__init__()
        self.conv1 = nn.Conv2d(nf, gc, 3, 1, 1); self.conv2 = nn.Conv2d(nf + gc, gc, 3, 1, 1)
        self.conv3 = nn.Conv2d(nf + 2 * gc, gc, 3, 1, 1); self.conv4 = nn.Conv2d(nf + 3 * gc, gc, 3, 1, 1)
        self.conv5 = nn.Conv2d(nf + 4 * gc, nf, 3, 1, 1); self.lrelu = nn.LeakyReLU(0.2, True)

    def forward(self, x):
        x1 = self.lrelu(self.conv1(x)); x2 = self.lrelu(self.conv2(torch.cat((x, x1), 1)))
        x3 = self.lrelu(self.conv3(torch.cat((x, x1, x2), 1))); x4 = self.lrelu(self.conv4(torch.cat((x, x1, x2, x3), 1)))
        return self.conv5(torch.cat((x, x1, x2, x3, x4), 1)) * 0.2 + x


class RRDB(nn.Module):
    def __init__(self, nf):
        super().__init__(); self.rdb1 = RDB(nf); self.rdb2 = RDB(nf); self.rdb3 = RDB(nf)

    def forward(self, x):
        return self.rdb3(self.rdb2(self.rdb1(x))) * 0.2 + x


class RRDBNet(nn.Module):
    """basicsr rrdbnet_arch.RRDBNet (Apache-2.0), scale 2 (pixel unshuffle) or 4."""
    def __init__(self, scale, nf=64, nb=23):
        super().__init__()
        self.scale = scale
        self.conv_first = nn.Conv2d(3 * (4 if scale == 2 else 1), nf, 3, 1, 1)
        self.body = nn.Sequential(*[RRDB(nf) for _ in range(nb)])
        self.conv_body = nn.Conv2d(nf, nf, 3, 1, 1); self.conv_up1 = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_up2 = nn.Conv2d(nf, nf, 3, 1, 1); self.conv_hr = nn.Conv2d(nf, nf, 3, 1, 1)
        self.conv_last = nn.Conv2d(nf, 3, 3, 1, 1); self.lrelu = nn.LeakyReLU(0.2, True)

    def forward(self, x):
        feat = self.conv_first(pixel_unshuffle(x, 2) if self.scale == 2 else x)
        feat = feat + self.conv_body(self.body(feat))
        feat = self.lrelu(self.conv_up1(F.interpolate(feat, scale_factor=2, mode="nearest")))
        feat = self.lrelu(self.conv_up2(F.interpolate(feat, scale_factor=2, mode="nearest")))
        return self.conv_last(self.lrelu(self.conv_hr(feat)))


def rrdb(scale, file):
    m = RRDBNet(scale)
    st = torch.load(W / file, map_location="cpu", weights_only=True)
    m.load_state_dict(st.get("params_ema", st.get("params", st)), strict=True)
    return m


def compact(strength):
    src = (W / "srvgg_arch.py").read_text(encoding="utf-8").replace("from basicsr.utils.registry import ARCH_REGISTRY\n", "").replace("@ARCH_REGISTRY.register()\n", "")
    ns = {"__name__": "srvgg"}; exec(compile(src, "srvgg_arch.py", "exec"), ns)
    m = ns["SRVGGNetCompact"](num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=32, upscale=4, act_type="prelu")
    a = torch.load(W / "realesr-general-x4v3.pth", map_location="cpu", weights_only=True)["params"]
    b = torch.load(W / "realesr-general-wdn-x4v3.pth", map_location="cpu", weights_only=True)["params"]
    # Real-ESRGAN dni: weight strength on x4v3, (1 - strength) on wdn (inference_realesrgan.py).
    m.load_state_dict({k: strength * a[k] + (1 - strength) * b[k] for k in a}, strict=True)
    return m


def swinir_s():
    stub_timm(); ns = load_module(W / "network_swinir.py")
    m = ns["SwinIR"](upscale=2, in_chans=3, img_size=64, window_size=8, img_range=1.0, depths=[6, 6, 6, 6], embed_dim=60,
                     num_heads=[6, 6, 6, 6], mlp_ratio=2, upsampler="pixelshuffledirect", resi_connection="1conv")
    m.load_state_dict(torch.load(W / "002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth", map_location="cpu", weights_only=True)["params"], strict=True)
    return m


def swinir_s4():
    stub_timm(); ns = load_module(W / "network_swinir.py")
    m = ns["SwinIR"](upscale=4, in_chans=3, img_size=64, window_size=8, img_range=1.0, depths=[6, 6, 6, 6], embed_dim=60,
                     num_heads=[6, 6, 6, 6], mlp_ratio=2, upsampler="pixelshuffledirect", resi_connection="1conv")
    m.load_state_dict(torch.load(W / "002_lightweightSR_DIV2K_s64w8_SwinIR-S_x4.pth", map_location="cpu", weights_only=True)["params"], strict=True)
    return m


def swin2sr_real():
    stub_timm(); ns = load_module(W / "network_swin2sr.py")
    m = ns["Swin2SR"](upscale=4, in_chans=3, img_size=64, window_size=8, img_range=1.0, depths=[6] * 6, embed_dim=180,
                      num_heads=[6] * 6, mlp_ratio=2, upsampler="nearest+conv", resi_connection="1conv")
    st = torch.load(W / "Swin2SR_RealworldSR_X4_64_BSRGAN_PSNR.pth", map_location="cpu", weights_only=True)
    m.load_state_dict(st.get("params_ema", st), strict=True)
    return m


MODELS = {
    # id: (builder, tile, scale)
    "swinir-x2": (swinir_s, 384, 2),
    "general-x4v3-d10": (lambda: compact(1.0), 384, 4),
    "general-x4v3-d05": (lambda: compact(0.5), 384, 4),
    "general-x4v3-d00": (lambda: compact(0.0), 384, 4),
    "realesrgan-x2plus": (lambda: rrdb(2, "RealESRGAN_x2plus.pth"), 512, 2),
    "realesrgan-x4plus": (lambda: rrdb(4, "RealESRGAN_x4plus.pth"), 256, 4),
    "realesrnet-x4plus": (lambda: rrdb(4, "RealESRNet_x4plus.pth"), 256, 4),
    "swin2sr-real-x4": (swin2sr_real, 128, 4),
    "swinir-x4": (swinir_s4, 384, 4),
}


def probe(tile):
    y, x = np.mgrid[0:tile, 0:tile].astype(np.float32) / max(tile - 1, 1)
    edge = ((x > 0.5) ^ (y > 0.3)).astype(np.float32)
    return np.ascontiguousarray(np.stack([x, y, 0.25 + 0.5 * edge])[None])


def export(mid):
    build, tile, scale = MODELS[mid]
    torch.manual_seed(0)
    model = build().eval()
    target = OUT / f"{mid}.onnx"
    sample = torch.from_numpy(probe(tile))
    with torch.inference_mode():
        expected = model(sample).numpy()
    with torch.no_grad():
        torch.onnx.export(model, (sample,), str(target), input_names=["input"], output_names=["output"],
                          opset_version=17, dynamo=False, do_constant_folding=True)
    onnx.checker.check_model(str(target))
    o = ort.SessionOptions(); o.use_deterministic_compute = True; o.intra_op_num_threads = 4
    s = ort.InferenceSession(str(target), sess_options=o, providers=["CPUExecutionProvider"])
    a = s.run(None, {"input": probe(tile)})[0]; b = s.run(None, {"input": probe(tile)})[0]
    assert a.shape == (1, 3, tile * scale, tile * scale), a.shape
    print(f"{mid} tile={tile} scale={scale} params={sum(p.numel() for p in model.parameters())} "
          f"maxdiff_vs_torch={float(np.abs(a - expected).max()):.2e} rerun_identical={a.tobytes() == b.tobytes()} "
          f"size={target.stat().st_size} sha256={hashlib.sha256(target.read_bytes()).hexdigest()[:16]}", flush=True)


if __name__ == "__main__":
    torch.set_num_threads(4)
    for mid in sys.argv[1:]:
        t = time.time()
        try:
            export(mid)
        except Exception as e:
            print(f"{mid} FAILED {type(e).__name__}: {str(e)[:300]}", flush=True)
        print(f"  {time.time() - t:.0f}s", flush=True)

