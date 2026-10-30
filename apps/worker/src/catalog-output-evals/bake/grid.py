import sys
from pathlib import Path
from PIL import Image, ImageDraw
IN = Path(r"Q:\in")
keys = sys.argv[1].split(","); x0, y0, x1, y1 = [int(v) for v in sys.argv[2].split(",")] if len(sys.argv) > 2 else (None,) * 4
tiles = []
for k in keys:
    im = Image.open(IN / f"{k}.jpg").convert("RGB")
    if x0 is not None: im = im.crop((x0, y0, x1, y1)); ox, oy = x0, y0
    else: ox = oy = 0
    d = ImageDraw.Draw(im)
    for gx in range(0, im.width, 50):
        d.line([(gx, 0), (gx, im.height)], fill=(255, 0, 0) if (gx + ox) % 100 == 0 else (255, 180, 180), width=1)
        if (gx + ox) % 100 == 0: d.text((gx + 2, 2), str(gx + ox), fill=(255, 0, 0))
    for gy in range(0, im.height, 50):
        d.line([(0, gy), (im.width, gy)], fill=(0, 0, 255) if (gy + oy) % 100 == 0 else (180, 180, 255), width=1)
        if (gy + oy) % 100 == 0: d.text((2, gy + 2), str(gy + oy), fill=(0, 0, 255))
    tiles.append(im)
W = sum(t.width for t in tiles); H = max(t.height for t in tiles)
s = Image.new("RGB", (W, H), "white"); x = 0
for t in tiles: s.paste(t, (x, 0)); x += t.width
s.save(r"Q:\out\grid.png")
