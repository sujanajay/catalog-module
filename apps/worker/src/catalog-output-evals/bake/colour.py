"""Mean colour of model output (area-downscaled back to input size) vs the input, per channel, on one 384 tile."""
import sys
import numpy as np, onnxruntime as ort
from PIL import Image
for key in sys.argv[1:]:
    im = Image.open(rf"Q:\in\{key}.jpg").convert("RGB")
    w, h = im.size; x0, y0 = max(0, w // 2 - 192), max(0, h // 2 - 192)
    a = np.asarray(im.crop((x0, y0, x0 + 384, y0 + 384)), np.float32) / 255
    for m in ("swinir-x2", "swinir-x4"):
        o = ort.SessionOptions(); o.intra_op_num_threads = 4
        s = ort.InferenceSession(rf"Q:\onnx\{m}.onnx", o, providers=["CPUExecutionProvider"])
        out = np.clip(s.run(None, {"input": a.transpose(2, 0, 1)[None]})[0][0].transpose(1, 2, 0), 0, 1)
        f = out.shape[0] // 384
        back = out.reshape(384, f, 384, f, 3).mean((1, 3))
        inner = slice(32, -32)
        d = (back[inner, inner] - a[inner, inner]).reshape(-1, 3).mean(0) * 255
        print(key, m, "mean diff RGB (0-255):", np.round(d, 2), "mean abs:", round(float(np.abs(back[inner, inner] - a[inner, inner]).mean() * 255), 2))
