"""Run one ONNX upscaler with the service's exact tiling (services/matting/app.py upscale_array, overlap 32,
reflect padding, centre kept, rint to uint8).
Usage: infer.py <model> <threads> <mode> <key> [...]
  mode=region: upscale the product box plus a 40 px margin, save PNG to Q:\\up\\<model>\\<key>.png
  mode=whole: upscale the whole photo twice, report time, sha256 of both runs, peak memory (nothing saved)
"""
import ctypes, ctypes.wintypes as wt, hashlib, json, math, sys, time
from pathlib import Path
import numpy as np
import onnxruntime as ort
from PIL import Image

OVERLAP = 32


class PMC(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]


def peak_mb():
    c = PMC(); c.cb = ctypes.sizeof(PMC)
    k = ctypes.WinDLL("kernel32"); k.GetCurrentProcess.restype = wt.HANDLE
    k.K32GetProcessMemoryInfo.argtypes = [wt.HANDLE, ctypes.POINTER(PMC), wt.DWORD]
    k.K32GetProcessMemoryInfo(k.GetCurrentProcess(), ctypes.byref(c), c.cb)
    return round(c.PeakWorkingSetSize / 2**20), round(c.PeakPagefileUsage / 2**20)


def upscale_array(rgb, run, tile, scale, overlap=OVERLAP):
    height, width = rgb.shape[:2]
    core = tile - 2 * overlap
    rows, cols = math.ceil(height / core), math.ceil(width / core)
    source = np.transpose(rgb, (2, 0, 1)).astype(np.float32) / 255.0
    pad = ((0, 0), (overlap, rows * core - height + overlap), (overlap, cols * core - width + overlap))
    padded = np.pad(source, pad, mode="reflect")
    out = np.empty((rows * core * scale, cols * core * scale, 3), dtype=np.uint8)
    keep = slice(overlap * scale, (overlap + core) * scale)
    for row in range(rows):
        for col in range(cols):
            y, x = row * core, col * core
            result = run(np.ascontiguousarray(padded[None, :, y:y + tile, x:x + tile]))
            centre = np.clip(result[0, :, keep, keep], 0.0, 1.0) * 255.0
            out[y * scale:(y + core) * scale, x * scale:(x + core) * scale] = np.rint(centre).astype(np.uint8).transpose(1, 2, 0)
    return out[:height * scale, :width * scale], rows * cols


def session(model, threads):
    o = ort.SessionOptions(); o.use_deterministic_compute = True; o.intra_op_num_threads = threads
    s = ort.InferenceSession(rf"Q:\onnx\{model}.onnx", sess_options=o, providers=["CPUExecutionProvider"])
    i = s.get_inputs()[0]; tile = i.shape[2]
    scale = s.get_outputs()[0].shape[2] // tile if isinstance(s.get_outputs()[0].shape[2], int) else None
    return s, i.name, tile, scale


def main():
    model, threads, mode, keys = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4:]
    s, name, tile, scale = session(model, threads)
    if scale is None:
        scale = s.run(None, {name: np.zeros((1, 3, tile, tile), np.float32)})[0].shape[2] // tile
    run = lambda b: s.run(None, {name: b})[0]
    meta = json.loads(Path(r"Q:\in\meta.json").read_text())
    for key in keys:
        im = Image.open(rf"Q:\in\{key}.jpg").convert("RGB")
        if mode == "whole":
            rgb = np.asarray(im)
            res = []
            for _ in range(2):
                t = time.perf_counter(); out, n = upscale_array(rgb, run, tile, scale); res.append((time.perf_counter() - t, hashlib.sha256(out.tobytes()).hexdigest()))
            print(json.dumps({"model": model, "key": key, "threads": threads, "size": im.size, "tile": tile, "scale": scale, "tiles": n,
                              "s": [round(r[0], 1) for r in res], "identical": res[0][1] == res[1][1], "sha": res[0][1][:16], "peak_mb": peak_mb()}), flush=True)
        else:
            b = meta[key]["bbox"]; W, H = im.size
            x0, y0 = max(0, b["x"] - 40), max(0, b["y"] - 40); x1, y1 = min(W, b["x"] + b["w"] + 40), min(H, b["y"] + b["h"] + 40)
            t = time.perf_counter()
            out, n = upscale_array(np.asarray(im.crop((x0, y0, x1, y1))), run, tile, scale)
            dt = time.perf_counter() - t
            d = Path(rf"Q:\up\{model}"); d.mkdir(parents=True, exist_ok=True)
            Image.fromarray(out).save(d / f"{key}.png", compress_level=1)
            (d / f"{key}.json").write_text(json.dumps({"x": x0, "y": y0, "f": scale}))
            print(json.dumps({"model": model, "key": key, "region": [x0, y0, x1, y1], "tiles": n, "s": round(dt, 1), "peak_mb": peak_mb()}), flush=True)


if __name__ == "__main__":
    main()
