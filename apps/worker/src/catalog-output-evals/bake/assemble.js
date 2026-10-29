// Reproduces the colour path of packages/core/src/catalog/enhance.ts with the repo's own sharp build:
// crop -> lanczos3 to the product size -> sharpen(sharpenParams(residual)). Alpha is not involved here.
// Usage: node assemble.js <job.json>; job = {src, bbox, scales:[..], models:[{id, png, x, y, f}], out}
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
sharp.concurrency(4);

const SHARPEN = { sigmaMin: 0.8, sigmaMax: 1.0, x1: 2, m1: 0, amountPerScale: 1.2, amountMax: 1.0, y2: 4, y3: 6 };
function sharpenParams(scale) {
  if (!(scale > 1)) return null;
  const over = Math.min(1, scale - 1);
  return { sigma: SHARPEN.sigmaMin + (SHARPEN.sigmaMax - SHARPEN.sigmaMin) * over, m1: SHARPEN.m1, m2: Math.min(SHARPEN.amountMax, SHARPEN.amountPerScale * (scale - 1)), x1: SHARPEN.x1, y2: SHARPEN.y2, y3: SHARPEN.y3 };
}

async function variant(input, region, tw, th, residual, file) {
  const base = await sharp(input).removeAlpha().extract(region).resize(tw, th, { kernel: "lanczos3", fit: "fill" }).raw().toBuffer();
  const p = sharpenParams(residual);
  const out = p ? await sharp(base, { raw: { width: tw, height: th, channels: 3 } }).sharpen(p).raw().toBuffer() : base;
  await sharp(out, { raw: { width: tw, height: th, channels: 3 } }).png({ compressionLevel: 1 }).toFile(file);
}

(async () => {
  const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const b = job.bbox;
  for (const s of job.scales) {
    const tw = Math.round(b.w * s), th = Math.round(b.h * s);
    const dir = path.join(job.out, `s${s}`);
    fs.mkdirSync(dir, { recursive: true });
    const region = { left: b.x, top: b.y, width: b.w, height: b.h };
    await variant(job.src, region, tw, th, 1, path.join(dir, "lanczos.png"));      // plain, no sharpening (reference)
    await variant(job.src, region, tw, th, s, path.join(dir, "plain.png"));        // current path at <= 1.5x and the fallback
    for (const m of job.models) {
      const r = { left: (b.x - m.x) * m.f, top: (b.y - m.y) * m.f, width: b.w * m.f, height: b.h * m.f };
      await variant(m.png, r, tw, th, s / m.f, path.join(dir, `${m.id}.png`));
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
