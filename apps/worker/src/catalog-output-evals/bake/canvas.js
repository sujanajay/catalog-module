// Centrepoint-style 3000x3000 canvas: model colour (x4 then lanczos3 down) + Lanczos3 alpha from the stored matte,
// flattened on white, then the render.ts encode ladder (q90..70, 4:4:4) until <= 2,000,000 bytes.
// Usage: node canvas.js <src.jpg> <matte.png> <up.png> <upX> <upY> <f> <bx> <by> <bw> <bh> <scale> <outPrefix>
const sharp = require("sharp");
(async () => {
  const [src, matte, up, ux, uy, f, bx, by, bw, bh, s, out] = process.argv.slice(2);
  const [X, Y, F, BX, BY, BW, BH, S] = [ux, uy, f, bx, by, bw, bh, s].map(Number);
  const tw = Math.round(BW * S), th = Math.round(BH * S);
  const colour = await sharp(up).removeAlpha().extract({ left: (BX - X) * F, top: (BY - Y) * F, width: BW * F, height: BH * F })
    .resize(tw, th, { kernel: "lanczos3", fit: "fill" }).raw().toBuffer();
  const alpha = await sharp(matte).greyscale().extract({ left: BX, top: BY, width: BW, height: BH })
    .resize(tw, th, { kernel: "lanczos3", fit: "fill" }).extractChannel(0).raw().toBuffer();
  const rgba = Buffer.alloc(tw * th * 4);
  for (let i = 0; i < tw * th; i++) { rgba[i * 4] = colour[i * 3]; rgba[i * 4 + 1] = colour[i * 3 + 1]; rgba[i * 4 + 2] = colour[i * 3 + 2]; rgba[i * 4 + 3] = alpha[i]; }
  const product = await sharp(rgba, { raw: { width: tw, height: th, channels: 4 } }).png().toBuffer();
  const png = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: "#ffffff" } })
    .composite([{ input: product, left: Math.round((3000 - tw) / 2), top: Math.round((3000 - th) / 2) }]).png().toBuffer();
  await sharp(png).toFile(out + "_lossless.png");
  const results = [];
  for (const q of [90, 85, 80, 75, 70, 60, 50]) {
    const jpg = await sharp(png).withIccProfile("srgb").jpeg({ quality: q, chromaSubsampling: "4:4:4" }).toBuffer();
    results.push({ q, bytes: jpg.length });
    await sharp(jpg).toFile(`${out}_q${q}.jpg`);
  }
  console.log(JSON.stringify({ tw, th, results }));
})().catch((e) => { console.error(e); process.exit(1); });
