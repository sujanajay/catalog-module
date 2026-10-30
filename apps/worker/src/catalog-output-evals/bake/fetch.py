import hashlib, sys, urllib.request
from pathlib import Path

W = Path(r"Q:\w")
URLS = [
    "https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth",
    "https://raw.githubusercontent.com/JingyunLiang/SwinIR/6545850fbf8df298df73d81f3e8cba638787c8bd/models/network_swinir.py",
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-x4v3.pth",
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesr-general-wdn-x4v3.pth",
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/RealESRGAN_x2plus.pth",
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth",
    "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.1/RealESRNet_x4plus.pth",
    "https://raw.githubusercontent.com/xinntao/Real-ESRGAN/master/realesrgan/archs/srvgg_arch.py",
]
PINNED = {
    "002_lightweightSR_DIV2K_s64w8_SwinIR-S_x2.pth": "193b229909ca89cd8b55de9c9e7fce146ae759d59dfcd78d8feb9dd1d6fa0fd7",
    "network_swinir.py": "9e143898679ebeebc5d2fc94ad1b89c38aa4a4d43da4e0fcba0f93e476994913",
    "RealESRGAN_x2plus.pth": "49fafd45f8fd7aa8d31ab2a22d14d91b536c34494a5cfe31eb5d89c2fa266abb",
}
for url in (sys.argv[1:] or URLS):
    name = url.rsplit("/", 1)[1]
    target = W / name
    if not target.is_file():
        with urllib.request.urlopen(url, timeout=600) as r:
            target.write_bytes(r.read())
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    ok = PINNED.get(name)
    flag = "" if ok is None else (" PINNED-OK" if ok == digest else " PINNED-MISMATCH")
    print(f"{name} {target.stat().st_size} {digest}{flag}", flush=True)
