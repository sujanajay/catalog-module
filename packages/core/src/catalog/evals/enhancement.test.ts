// Spec 11 D: the enhancement gate's metrics on synthetic images, the verdict logic and the enlargement count.
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { Raster } from "./types";
import { syntheticSource } from "./synthetic";
import { baselineUpscale, countNeedsEnlargement, deltaE2000, deltaEStats, evenCrop, gradientStructureDistance, greyOf, measureRestoration, photoGeometry, reportMarkdown, selectQualifying, shrinkForGate, srgbToLab, ssim, summariseCandidate, textRegions, textureCells, UpscaleClient, verdictOf, type CandidateSummary, type EnhancementReport, type MethodMetrics, type PhotoRecord } from "./enhancement";

const source = (): Raster => { const { prepared } = syntheticSource({ width: 400, height: 400, box: { x: 80, y: 100, w: 240, h: 220 }, logo: { x: 120, y: 150, w: 90, h: 50 } }); return { w: prepared.width, h: prepared.height, rgb: prepared.rgb }; };
const copy = (r: Raster): Raster => ({ w: r.w, h: r.h, rgb: Buffer.from(r.rgb) });
async function blurred(r: Raster, sigma = 2): Promise<Raster> {
  const data = await sharp(r.rgb, { raw: { width: r.w, height: r.h, channels: 3 } }).blur(sigma).raw().toBuffer();
  return { w: r.w, h: r.h, rgb: data };
}
function noisy(r: Raster, amplitude = 24): Raster {
  const out = copy(r);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < out.rgb.length; i++) out.rgb[i] = Math.max(0, Math.min(255, out.rgb[i]! + Math.round((rand() - 0.5) * 2 * amplitude)));
  return out;
}
function shifted(r: Raster, dr: number): Raster {
  const out = copy(r);
  for (let i = 0; i < out.rgb.length; i += 3) out.rgb[i] = Math.min(255, out.rgb[i]! + dr);
  return out;
}

describe("metrics", () => {
  it("identical images give SSIM 1, stand-in distance 0 and dE 0", () => {
    const a = source(), g = greyOf(a), geometry = photoGeometry(a);
    expect(geometry.area.method).toBe("colour_estimate");
    expect(ssim(g, g, a.w, a.h, geometry.area.mask)).toBeCloseTo(1, 6);
    expect(gradientStructureDistance(g, g, a.w, a.h, geometry.area.mask)).toBe(0);
    expect(deltaEStats(a, copy(a), geometry.area.mask)).toEqual({ mean: 0, p95: 0 });
    const m = measureRestoration(a, geometry, copy(a));
    expect(m.texture.flagged).toBe(false);
    expect(m.halo).toBe(0);
    expect(m.textRegions.length).toBe(3);
    for (const s of m.textRegions) expect(s).toBeCloseTo(1, 6);
  });

  it("a blurred copy scores below the original on SSIM, the stand-in distance and the text regions", async () => {
    const a = source(), geometry = photoGeometry(a), b = await blurred(a);
    const m = measureRestoration(a, geometry, b);
    expect(m.ssim).toBeLessThan(0.98);
    expect(m.lpipsStandIn).toBeGreaterThan(0.02);
    expect(Math.max(...m.textRegions)).toBeLessThan(0.98);
    expect(m.halo).toBeGreaterThan(0.5);
  });

  it("a colour-shifted copy exceeds dE 2 while keeping its structure", () => {
    const a = source(), geometry = photoGeometry(a), b = shifted(a, 14);
    const m = measureRestoration(a, geometry, b);
    expect(m.deMean).toBeGreaterThan(2);
    expect(m.deP95).toBeGreaterThanOrEqual(m.deMean);
    expect(m.ssim).toBeGreaterThan(0.9);
  });

  it("texture flags fire on noise added and on a flattened copy, not on the original", async () => {
    const a = source(), g = greyOf(a), mask = photoGeometry(a).area.mask;
    const noise = textureCells(g, greyOf(noisy(a)), a.w, a.h, mask);
    expect(noise.inventedShare).toBeGreaterThan(0.5);
    expect(noise.flagged).toBe(true);
    const flat = textureCells(g, greyOf(await blurred(a, 4)), a.w, a.h, mask);
    expect(flat.flattenedShare).toBeGreaterThan(0.05);
    expect(flat.flagged).toBe(true);
    expect(textureCells(g, g, a.w, a.h, mask).flagged).toBe(false);
  });

  it("CIEDE2000 matches the published test pairs", () => {
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 3);
    expect(deltaE2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 3);
    expect(deltaE2000([50, 2.5, 0], [50, 3.1736, 0.5854])).toBeCloseTo(1, 3);
    const [L, a, b] = srgbToLab(255, 255, 255);
    expect(L).toBeCloseTo(100, 1); expect(Math.abs(a)).toBeLessThan(0.1); expect(Math.abs(b)).toBeLessThan(0.1);
  });

  it("text regions sit on the logo and the product edges, never overlapping", () => {
    const a = source(), regions = textRegions(greyOf(a), a.w, a.h, photoGeometry(a).area.mask);
    expect(regions.length).toBe(3);
    for (const r of regions) expect(r).toMatchObject({ w: 128, h: 128 });
    for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
      const p = regions[i]!, q = regions[j]!;
      expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h).toBe(false);
    }
  });

  it("the baseline restores a 2x shrink to the original size and beats a plain blur", async () => {
    const a = evenCrop(source()), geometry = photoGeometry(a);
    const { raster, upload } = await shrinkForGate(a);
    expect([raster.w, raster.h]).toEqual([200, 200]);
    expect(await sharp(upload).metadata()).toMatchObject({ format: "jpeg", chromaSubsampling: "4:4:4" });
    const restored = await baselineUpscale(raster);
    expect([restored.w, restored.h]).toEqual([a.w, a.h]);
    const m = measureRestoration(a, geometry, restored), blur = measureRestoration(a, geometry, await blurred(a, 3));
    expect(m.ssim).toBeGreaterThan(blur.ssim);
    expect(m.lpipsStandIn).toBeLessThan(blur.lpipsStandIn);
    expect(m.deMean).toBeLessThan(blur.deMean);
  });

  it("evenCrop drops an odd row and column", () => {
    const r = evenCrop({ w: 5, h: 3, rgb: Buffer.alloc(45, 7) });
    expect([r.w, r.h, r.rgb.length]).toEqual([4, 2, 24]);
  });
});

const metrics = (over: Partial<MethodMetrics> = {}): MethodMetrics => ({ ssim: 0.9, lpipsStandIn: 0.1, deMean: 1, deP95: 2, texture: { cells: 100, invented: 0, flattened: 0, inventedShare: 0, flattenedShare: 0, flagged: false }, textRegions: [0.9, 0.9, 0.9], halo: 2, ...over });
const okCalls = (ms = 500) => [{ ok: true, wallMs: ms, serviceMs: ms - 50 }, { ok: true, wallMs: ms, serviceMs: ms - 50 }];
function photo(i: number, candidates: PhotoRecord["candidates"]): PhotoRecord {
  return { identifier: `P${i}`, n: 1, brand: "anta", width: 1600, height: 1600, productShare: 0.4, productMethod: "colour_estimate", baseline: metrics(), candidates };
}
const good = (over: Partial<MethodMetrics> = {}) => ({ metrics: metrics({ ssim: 0.95, lpipsStandIn: 0.05, ...over }), calls: okCalls(), deterministic: true });

describe("verdict", () => {
  it("a candidate better than the baseline everywhere passes every bar and wins", () => {
    const photos = Array.from({ length: 10 }, (_, i) => photo(i, { good: good(), weak: { metrics: metrics({ ssim: 0.85 }), calls: okCalls(), deterministic: true } }));
    const summaries = [summariseCandidate("good", photos), summariseCandidate("weak", photos)];
    expect(summaries[0]!.pass).toBe(true);
    expect(summaries[0]!.bars.map(b => b.id)).toEqual(["ssim_share", "ssim_mean", "lpips_share", "lpips_mean", "de_mean", "text_logo", "texture", "halo", "determinism", "error_rate", "p95"]);
    expect(summaries[1]!.pass).toBe(false);
    expect(summaries[1]!.bars.filter(b => !b.ok).map(b => b.id)).toEqual(["ssim_share", "ssim_mean", "lpips_share", "lpips_mean"]);
    const verdict = verdictOf(summaries);
    expect(verdict.winner).toBe("good");
    expect(verdict.line).toMatch(/^Enhancement gate: winner good/);
  });

  it("better on 70% of photos fails the share bar; dE over 2 on one photo, a text drop, texture flags, halo, determinism, errors and p95 each fail their bar", () => {
    const base = Array.from({ length: 10 }, (_, i) => photo(i, {
      share: good({ ssim: i < 7 ? 0.95 : 0.85 }),
      de: good({ deMean: i === 3 ? 2.5 : 1 }),
      text: good({ textRegions: [0.9, 0.88, 0.9] }),
      texture: good({ texture: { cells: 100, invented: 10, flattened: 0, inventedShare: 0.1, flattenedShare: 0, flagged: true } }),
      halo: good({ halo: 3.5 }),
      nondet: { ...good(), deterministic: i === 0 ? false : true },
      errors: { ...good(), calls: i === 0 ? [{ ok: false, wallMs: 10, serviceMs: null, error: "Upscale returned 503." }, okCalls()[0]!] : okCalls() },
      slow: { ...good(), calls: i === 9 ? okCalls(12_000) : okCalls() },
    }));
    const failing = (method: string) => summariseCandidate(method, base).bars.filter(b => !b.ok).map(b => b.id);
    expect(failing("share")).toEqual(["ssim_share"]);
    expect(failing("de")).toEqual(["de_mean"]);
    expect(failing("text")).toEqual(["text_logo"]);
    expect(failing("texture")).toEqual(["texture"]);
    expect(failing("halo")).toEqual(["halo"]);
    expect(failing("nondet")).toEqual(["determinism"]);
    expect(failing("errors")).toEqual(["error_rate"]);
    expect(failing("slow")).toEqual(["p95"]);
    expect(summariseCandidate("slow", base).timing.coldStartMs).toBe(500);
    expect(verdictOf([summariseCandidate("share", base), summariseCandidate("de", base)])).toEqual({ winner: null, line: "Enhancement gate: none passes (share fails ssim_share; de fails de_mean)." });
  });

  it("the winner is the passing candidate with the highest mean SSIM; a candidate without any successful call fails", () => {
    const photos = Array.from({ length: 5 }, (_, i) => photo(i, { a: good({ ssim: 0.94 }), b: good({ ssim: 0.96 }), dead: { metrics: null, calls: [{ ok: false, wallMs: 5, serviceMs: null, error: "Upscale returned 503." }], deterministic: null } }));
    const summaries = ["a", "b", "dead"].map(m => summariseCandidate(m, photos));
    expect(verdictOf(summaries).winner).toBe("b");
    expect(verdictOf(summaries).line).toContain("also passing: a");
    const dead = summaries[2]!;
    expect(dead.pass).toBe(false);
    expect(dead.errorRate).toBe(1);
    expect(dead.determinism).toBeNull();
  });

  it("the markdown report carries every bar, the verdict and the stand-in label", () => {
    const photos = [photo(0, { good: good() })];
    const summaries: CandidateSummary[] = [summariseCandidate("good", photos)];
    const report: EnhancementReport = { run: "enh-test", startedAt: "s", finishedAt: "f", endpoint: "http://localhost:8081", scale: 2, selection: selectQualifying([{ w: 1600, h: 1200 }]).selection, qualifying: [{ identifier: "P0", n: 1, brand: "anta", width: 1600, height: 1600 }], needsEnlargement: countNeedsEnlargement([{ w: 800, h: 800 }]), productArea: "test", metrics: { lpipsStandIn: "stand-in" }, baseline: { method: "baseline", means: summaries[0]!.means }, candidates: summaries, photos, verdict: verdictOf(summaries), notes: ["note"] };
    const md = reportMarkdown(report);
    expect(md).toContain("Enhancement gate: winner good");
    for (const b of summaries[0]!.bars) expect(md).toContain(b.label);
    expect(md).toContain("LPIPS stand-in");
    expect(md).toContain("| trendyol | 1200x1800 |");
    expect(md).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("selection and the share of photos that need enlargement", () => {
  it("takes 1,600 px photos, falls back to 1,400 px below 20, and honours an explicit minimum", () => {
    const big = Array.from({ length: 25 }, () => ({ w: 1700, h: 1100 }));
    expect(selectQualifying([...big, { w: 1500, h: 1000 }]).selection).toMatchObject({ minLongSide: 1600, counts: { at1600: 25, at1400: 26, atChosen: 25 }, fallback: false });
    const few = [...big.slice(0, 5), ...Array.from({ length: 20 }, () => ({ w: 900, h: 1450 }))];
    const fallback = selectQualifying(few);
    expect(fallback.selection).toMatchObject({ minLongSide: 1400, fallback: true, counts: { at1600: 5, at1400: 25, atChosen: 25 } });
    expect(fallback.selection.note).toContain("1,400 px are accepted");
    expect(selectQualifying([{ w: 1200, h: 800 }], 1200).chosen.length).toBe(1);
  });

  it("counts photos needing more than 1.5x per exact-size channel with a fake channel table", () => {
    const table = [
      { id: "fixed_a", fixedCanvas: true, targetCanvas: { w: 1200, h: 1800 }, margins: { top: 0, bottom: 0, left: 0, right: 0, unit: "fraction" as const } },
      { id: "fixed_b", fixedCanvas: true, targetCanvas: { w: 3000, h: 3000 }, margins: { top: 0.1, bottom: 0.1, left: 0.1, right: 0.1, unit: "fraction" as const } },
      { id: "adaptive", fixedCanvas: false, targetCanvas: { w: 2000, h: 2000 }, margins: { top: 0, bottom: 0, left: 0, right: 0, unit: "fraction" as const } },
    ];
    const photos = [{ w: 800, h: 1200 }, { w: 800, h: 800 }, { w: 1600, h: 2400 }, { w: 2400, h: 2400 }];
    const need = countNeedsEnlargement(photos, table);
    expect(need.channels.map(c => c.channel)).toEqual(["fixed_a", "fixed_b"]);
    // fixed_a: 800x1200 fits at exactly 1.5 (not over), 800x800 at 1.5, 1600x2400 at 0.75, 2400x2400 at 0.5.
    expect(need.channels[0]).toMatchObject({ needing: 0, photos: 4, share: 0 });
    // fixed_b safe box 2400x2400: 800x1200 needs 2, 800x800 needs 3, 1600x2400 needs 1, 2400x2400 needs 1.
    expect(need.channels[1]).toMatchObject({ needing: 2, share: 0.5, scaleP50: 2 });
    expect(need.anyChannel).toEqual({ photos: 4, needing: 2, share: 0.5 });
    // The real table: trendyol, styli and centrepoint are the exact-size channels.
    expect(countNeedsEnlargement([{ w: 800, h: 800 }]).channels.map(c => c.channel)).toEqual(["trendyol", "styli", "centrepoint"]);
  });
});

describe("UpscaleClient", () => {
  it("posts the image bytes with the model and scale, reads the headers and the size, and reports a 503", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const jpeg = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/health")) return new Response(JSON.stringify({ ok: true, upscale: { models: ["realesrgan-x2plus", { id: "swinir-x2" }] } }), { status: 200 });
      if (String(url).includes("model=down")) return new Response("busy", { status: 503 });
      return new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg", "x-upscale-model": "realesrgan-x2plus", "x-upscale-ms": "123" } });
    }) as typeof fetch;
    const client = new UpscaleClient({ baseUrl: "https://gpu.example.run.app/", fetch: fetchMock, idToken: async () => "tok" });
    expect(await client.health()).toEqual({ ok: true, models: ["realesrgan-x2plus", "swinir-x2"] });
    const result = await client.upscale(Buffer.from([1, 2, 3]), "realesrgan-x2plus");
    expect(result).toMatchObject({ model: "realesrgan-x2plus", serviceMs: 123, width: 20, height: 10 });
    expect(result.jpeg.equals(jpeg)).toBe(true);
    expect(seen[1]!.url).toBe("https://gpu.example.run.app/upscale?model=realesrgan-x2plus&scale=2");
    expect(new Headers(seen[1]!.init.headers).get("authorization")).toBe("Bearer tok");
    expect(new Headers(seen[1]!.init.headers).get("content-type")).toBe("image/png");
    await expect(client.upscale(Buffer.from([1]), "down")).rejects.toMatchObject({ status: 503 });
  });
});
