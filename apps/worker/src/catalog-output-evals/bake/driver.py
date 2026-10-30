"""Per image: run every model (region mode), assemble every scale with sharp, measure, save crop sheets, clean up.
Usage: driver.py <key> <model,model,...> [scales]   (key t24/t30 = synthetic ground-truth set)"""
import json, math, shutil, subprocess, sys, hashlib
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw

PY = r"Q:\venv\Scripts\python.exe"
OUT = Path(r"Q:\out"); SHEETS = OUT / "sheets"; SHEETS.mkdir(parents=True, exist_ok=True)
FACTOR = {"swinir-x2": 2, "realesrgan-x2plus": 2}


def gblur(a, sigma):
    r = max(1, int(3 * sigma + 0.5)); x = np.arange(-r, r + 1); k = np.exp(-x * x / (2 * sigma * sigma)); k /= k.sum()
    for ax in (0, 1):
        p = np.pad(a, [(r, r) if i == ax else (0, 0) for i in range(a.ndim)], mode="reflect")
        n = a.shape[ax]
        a = sum(k[i] * np.take(p, np.arange(i, i + n), axis=ax) for i in range(2 * r + 1))
    return a


def luma(rgb):
    rgb = rgb.astype(np.float64)
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


def ssim_map(a, b):
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    ma, mb = gblur(a, 1.5), gblur(b, 1.5)
    va, vb, cov = gblur(a * a, 1.5) - ma * ma, gblur(b * b, 1.5) - mb * mb, gblur(a * b, 1.5) - ma * mb
    return ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2))


def psnr(a, b, m):
    mse = np.mean((a[m] - b[m]) ** 2)
    return 99.0 if mse == 0 else 10 * math.log10(255 ** 2 / mse)


def lab(rgb):
    c = rgb.astype(np.float64) / 255
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def lap(y):
    return 4 * y[1:-1, 1:-1] - y[:-2, 1:-1] - y[2:, 1:-1] - y[1:-1, :-2] - y[1:-1, 2:]


def minmax_filter(a, r, fn):
    out = a
    for ax in (0, 1):
        p = np.pad(out, [(r, r) if i == ax else (0, 0) for i in range(2)], mode="edge"); n = out.shape[ax]
        acc = np.take(p, np.arange(0, n), axis=ax)
        for i in range(1, 2 * r + 1): acc = fn(acc, np.take(p, np.arange(i, i + n), axis=ax))
        out = acc
    return out


def blockiness(y, m, ox, oy):
    dh = np.abs(np.diff(y, axis=1)); dv = np.abs(np.diff(y, axis=0))
    bh = ((ox + np.arange(dh.shape[1]) + 1) % 8 == 0)[None, :] & m[:, 1:] & m[:, :-1]
    nh = ~((ox + np.arange(dh.shape[1]) + 1) % 8 == 0)[None, :] & m[:, 1:] & m[:, :-1]
    bv = ((oy + np.arange(dv.shape[0]) + 1) % 8 == 0)[:, None] & m[1:, :] & m[:-1, :]
    nv = ~((oy + np.arange(dv.shape[0]) + 1) % 8 == 0)[:, None] & m[1:, :] & m[:-1, :]
    return float((dh[bh].sum() + dv[bv].sum()) / (bh.sum() + bv.sum()) / ((dh[nh].sum() + dv[nv].sum()) / (nh.sum() + nv.sum())))


def label(im, text):
    c = Image.new("RGB", (im.width, im.height + 14), "white"); c.paste(im, (0, 14)); ImageDraw.Draw(c).text((2, 1), text[:max(4, im.width // 6)], fill=(0, 0, 0)); return c


def main():
    key, models = sys.argv[1], sys.argv[2].split(",")
    scales = [float(s) for s in sys.argv[3].split(",")] if len(sys.argv) > 3 else [1.2, 1.5, 2.0, 2.5, 3.5]
    meta = json.loads(Path(r"Q:\in\meta.json").read_text())[key]
    b = meta["bbox"]; bx, by, bw, bh = b["x"], b["y"], b["w"], b["h"]
    src_im = Image.open(rf"Q:\in\{key}.jpg").convert("RGB")
    src = np.asarray(src_im.crop((bx, by, bx + bw, by + bh)))
    matte = np.asarray(Image.open(rf"Q:\in\{key}.matte.png").convert("L").crop((bx, by, bx + bw, by + bh)))
    mask = minmax_filter(matte.astype(np.float64), 3, np.minimum) >= 250
    gt_full = Image.open(meta["gt"]).convert("RGB") if "gt" in meta else None
    runs = {}
    for m in models:
        if not Path(rf"Q:\up\{m}\{key}.png").is_file():
            r = subprocess.run([PY, "-I", r"Q:\scripts\infer.py", m, "4", "region", key], capture_output=True, text=True)
            if r.returncode: print(m, "INFER FAILED", r.stderr[-800:], flush=True); continue
            runs[m] = json.loads(r.stdout.strip().splitlines()[-1]); print(r.stdout.strip(), flush=True)
    models = [m for m in models if Path(rf"Q:\up\{m}\{key}.png").is_file()]
    job = {"src": rf"Q:\in\{key}.jpg", "bbox": b, "scales": scales, "out": rf"Q:\var\{key}",
           "models": [dict(id=m, png=rf"Q:\up\{m}\{key}.png", **json.loads(Path(rf"Q:\up\{m}\{key}.json").read_text())) for m in models]}
    Path(r"Q:\var").mkdir(exist_ok=True); jf = Path(rf"Q:\var\{key}.job.json"); jf.write_text(json.dumps(job))
    subprocess.run(["node", r"Q:\scripts\assemble.js", str(jf)], check=True)
    ysrc = luma(src); labsrc = lab(gblur(src.astype(np.float64), 2.0))
    with open(OUT / "metrics.jsonl", "a") as log:
        for s in scales:
            d = Path(rf"Q:\var\{key}\s{s:g}")
            tw, th = math.floor(bw * s + 0.5), math.floor(bh * s + 0.5)  # JS Math.round, as in assemble.js
            mo = np.asarray(Image.fromarray(mask).resize((tw, th), Image.NEAREST))
            ref = luma(np.asarray(Image.open(d / "lanczos.png"))); r = math.ceil(s)
            rmax, rmin = minmax_filter(ref, r, np.maximum), minmax_filter(ref, r, np.minimum)
            gt = None
            if gt_full is not None:
                k = gt_full.width / src_im.width
                gt = np.asarray(gt_full.resize((tw, th), Image.LANCZOS, box=(bx * k, by * k, (bx + bw) * k, (by + bh) * k)))
                ygt = luma(gt)
            variants = ["lanczos", "plain"] + models
            tiles = {w["name"]: [] for w in meta["windows"]}
            for w in meta["windows"]:
                wx, wy, ws = w["x"] - bx, w["y"] - by, w["size"]
                nn = Image.fromarray(src[wy:wy + ws, wx:wx + ws]).resize((round(ws * s), round(ws * s)), Image.NEAREST)
                tiles[w["name"]].append(label(nn, "source NN"))
            for v in variants:
                out = np.asarray(Image.open(d / f"{v}.png")); y = luma(out)
                back = np.asarray(Image.fromarray(out).resize((bw, bh), Image.LANCZOS)); yb = luma(back)
                rec = {"key": key, "scale": s, "variant": v, "sha": hashlib.sha256(out.tobytes()).hexdigest()[:12],
                       "psnr_back": round(psnr(yb, ysrc, mask), 2), "ssim_back": round(float(ssim_map(yb, ysrc)[mask].mean()), 4),
                       "dE_back": round(float(np.sqrt(((lab(gblur(back.astype(np.float64), 2.0)) - labsrc) ** 2).sum(-1))[mask].mean()), 3),
                       "block_back": round(blockiness(yb, mask, bx, by), 3),
                       "lapvar_product": round(float(lap(y)[mo[1:-1, 1:-1]].var()), 1),
                       "overshoot": round(float((np.maximum(0, y - rmax) + np.maximum(0, rmin - y))[mo].mean()), 4)}
                if gt is not None:
                    rec["psnr_gt"] = round(psnr(y, ygt, mo), 2); rec["ssim_gt"] = round(float(ssim_map(y, ygt)[mo].mean()), 4)
                    rec["dE_gt"] = round(float(np.sqrt(((lab(gblur(out.astype(np.float64), 2.0 * s)) - lab(gblur(gt.astype(np.float64), 2.0 * s))) ** 2).sum(-1))[mo].mean()), 3)
                wl = {}
                for w in meta["windows"]:
                    x0, y0, n = round((w["x"] - bx) * s), round((w["y"] - by) * s), round(w["size"] * s)
                    wl[w["name"]] = round(float(lap(y[y0:y0 + n, x0:x0 + n]).var()), 1)
                    tiles[w["name"]].append(label(Image.fromarray(out[y0:y0 + n, x0:x0 + n]), v))
                rec["lapvar_windows"] = wl
                log.write(json.dumps(rec) + "\n"); print(json.dumps(rec), flush=True)
            if gt is not None:
                for w in meta["windows"]:
                    x0, y0, n = round((w["x"] - bx) * s), round((w["y"] - by) * s), round(w["size"] * s)
                    tiles[w["name"]].append(label(Image.fromarray(gt[y0:y0 + n, x0:x0 + n]), "TRUTH"))
            for name, ts in tiles.items():
                sheet = Image.new("RGB", (sum(t.width + 4 for t in ts), max(t.height for t in ts)), "white"); x = 0
                for t in ts: sheet.paste(t, (x, 0)); x += t.width + 4
                sheet.save(SHEETS / f"{key}_s{s}_{name}.png")
    shutil.rmtree(rf"Q:\var\{key}"); jf.unlink()
    if "--keep" not in sys.argv:
        for m in models: Path(rf"Q:\up\{m}\{key}.png").unlink(missing_ok=True)
    if runs: (OUT / "region_runs.jsonl").open("a").write("".join(json.dumps(v) + "\n" for v in runs.values()))


if __name__ == "__main__":
    main()
