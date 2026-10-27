import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogChunks, catalogCostEvents, catalogOutputs, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import * as storage from "@catalog/core/storage";
import { listAttention } from "@catalog/core/catalog/attention";
import { attentionRate, cutInSourceNote } from "@catalog/core/catalog/pipeline/report";
import { hasCutBandNote } from "@catalog/core/catalog/channels";
import { autoActionsOf, busyBackgroundHold, type AutoAction } from "@catalog/core/catalog/auto-resolve";
import type { ChannelId, ProductType, ResolvedPolicy } from "@catalog/core/catalog/types";
import type { Matte } from "@catalog/core/catalog/render";
import { flagReason } from "@catalog/core/catalog/types";
import { workerCatalogDeps, type CatalogDeps } from "./deps";
import { currentChunkTask, handleChunkTask } from "./chunk";

// 07 auto-resolve, end to end through the chunk: the real prepare, render and compliance guard; a
// mocked judge that reads the rendered pixels; mocked cut-out models; in-memory storage.
let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => close());

const W = 800, H = 800, BG = 150;
type RGB = [number, number, number];
const PLAIN: RGB = [40, 40, 40];
/** Marker colours the fake cut-out models react to. */
const HALO_FIRST: RGB = [30, 30, 110], HALO_ALWAYS: RGB = [110, 30, 30];
interface Shot { draw: (rgb: Buffer) => void }
const rect = (rgb: Buffer, x0: number, y0: number, w: number, h: number, color: (x: number, y: number) => RGB) => {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) rgb.set(color(x, y), (y * W + x) * 3);
};
const block = (color: RGB, w = 400, h = 700): Shot => ({ draw: rgb => rect(rgb, (W - w) >> 1, (H - h) >> 1, w, h, () => color) });
/** Saturated 2 px red and blue checks: the strongest JPEG chroma tint, which stays inside the product's own 8 x 8 blocks. */
const checker: Shot = { draw: rgb => rect(rgb, 200, 50, 400, 700, (x, y) => (((x >> 1) + (y >> 1)) & 1 ? [255, 0, 0] : [0, 0, 255])) };
/**
 * A cut-out on the photo's own plain background, cut at the knees 40 px above the frame bottom: no photo edge shows,
 * so only the judge can say the legs end at a cut. `hand` adds a hand cut by the left frame edge, which the detector
 * places flush on its own.
 */
// `flared`: the legs are twice as wide 10 rows above the cut, so only the judge-relaxed share finds the cut.
const legs = (hand = false, flared = false): Shot => ({ draw: rgb => { rect(rgb, 250, 200, 300, 400, () => PLAIN); rect(rgb, 250, 600, 60, 160, () => PLAIN); rect(rgb, 490, 600, 60, 160, () => PLAIN); if (flared) { rect(rgb, 220, 600, 120, 150, () => PLAIN); rect(rgb, 460, 600, 120, 150, () => PLAIN); } if (hand) rect(rgb, 0, 300, 250, 60, () => PLAIN); } });

/** Product where the pixel differs from the plain source background; the first model leaves a 10 px rim on marked products. */
function fakeMatte(rgb: Buffer, model: string): Matte {
  let alpha = Buffer.alloc(W * H);
  let marker: RGB | null = null;
  for (let i = 0; i < W * H; i++) {
    const c = [rgb[i * 3]!, rgb[i * 3 + 1]!, rgb[i * 3 + 2]!];
    if (Math.max(...c.map(v => Math.abs(v - BG))) > 40) { alpha[i] = 255; marker ??= c as RGB; }
  }
  const halo = (marker?.join() === HALO_FIRST.join() && model === "first") || marker?.join() === HALO_ALWAYS.join();
  if (halo) {
    const dilate = (src: Buffer, horizontal: boolean) => { const out = Buffer.alloc(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let v = 0; for (let d = -10; d <= 10 && !v; d++) { const xx = horizontal ? x + d : x, yy = horizontal ? y : y + d; if (xx >= 0 && xx < W && yy >= 0 && yy < H) v = src[yy * W + xx]!; } out[y * W + x] = v; } return out; };
    alpha = dilate(dilate(alpha, true), false);
  }
  return { alpha, width: W, height: H, model, ms: 5, source: "model", target: "cpu", sentLongSide: 1024 };
}

/** The mocked judge reads the image we made: a rim of the old background (halo) and a neutral dark patch by the product (leftover background, such as a shadow block). */
async function looksAt(output: Buffer): Promise<{ edge: number; background: number }> {
  const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, px = (x: number, y: number) => [data[(y * w + x) * 3]!, data[(y * w + x) * 3 + 1]!, data[(y * w + x) * 3 + 2]!];
  const bg = px(2, 2), near = (c: number[]) => c.every(v => Math.abs(v - BG) <= 10);
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = px(x, y); if (Math.max(...c.map((v, k) => Math.abs(v - bg[k]!))) > 70 && !near(c)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
  if (x1 < 0) return { edge: 100, background: 100 };
  let rim = 0, patch = 0;
  for (let y = Math.max(0, y0 - 12); y <= Math.min(h - 1, y1 + 12); y++) for (let x = Math.max(0, x0 - 12); x <= Math.min(w - 1, x1 + 12); x++) if ((x < x0 || x > x1 || y < y0 || y > y1) && near(px(x, y))) rim++;
  const luma = (c: number[]) => (c[0]! + c[1]! + c[2]!) / 3;
  // A leftover patch is a block beside the product, not the JPEG ringing that hugs its edge: the 2 px next to the
  // product box are skipped. Spec 11 sharpens an enlarged product, which makes the saturated 2 px checker ring a
  // little more there (42 to 58 such pixels, over this mock's 50) while no real block is anywhere near that thin.
  for (let y = Math.max(0, y1 - 40); y <= Math.min(h - 1, y1 + 40); y++) for (let x = Math.max(0, x0 - 40); x <= Math.min(w - 1, x1 + 40); x++) { if (x >= x0 - 2 && x <= x1 + 2 && y <= y1 + 2) continue; const c = px(x, y); if (luma(bg) - luma(c) >= 4 && !near(c) && Math.max(...c) - Math.min(...c) < 6) patch++; }
  return { edge: rim > 40 ? 30 : 95, background: patch > 50 ? 30 : 95 };
}

const policy: ResolvedPolicy = { matteModel: "first", matteModelSecond: "second", qaModel: "test/judge", qaModelSecond: "test/second", threshold: 75, floor: 60, qaMode: "per_source", qaSampleRate: 1, source: "default" };

function world(opts: { photoScores?: (n: number) => Record<string, number> } = {}) {
  const objects = new Map<string, Buffer>();
  let generation = 1;
  const upload = async (path: string, buf: Buffer) => { objects.set(`gs://assets/${path}`, buf); generation++; return `gs://assets/${path}`; };
  const base = workerCatalogDeps(db);
  const judgeOutput = vi.fn<CatalogDeps["judgeOutput"]>(async input => {
    const seen = await looksAt(input.output);
    const scores = { complete_product: 95, same_product: 100, edge_quality: seen.edge, background_clean: seen.background, no_text_or_watermark: 95, orientation_ok: 95, ...opts.photoScores?.(input.n) };
    return { scores: { ...scores, overall: Math.min(...Object.values(scores)) } as never, verdict: "pass", reasons: [], isCollage: false, costUsd: 0, calls: 1, usage: {}, model: input.model, flags: [], view: "side", evidence: {}, wrongItem: { first: false, second: null, secondModel: null, confirmed: false } };
  });
  const matteFor = vi.fn<CatalogDeps["matteFor"]>(async (p, _client, model) => fakeMatte(p.rgb, model ?? "first"));
  const deps: CatalogDeps = {
    ...base, sleep: async () => {}, now: () => new Date("2026-01-01T00:00:00Z"), log: () => {}, enqueue: vi.fn(async () => "task"),
    resolvePolicy: vi.fn(async () => ({ ...policy })), judgeOutput, matteFor,
    classifyProductType: vi.fn(async () => ({ type: "other" as const, confidence: 1, costUsd: 0, calls: 0, usage: {}, flags: [] })),
    matting: { ...base.matting, health: vi.fn(async () => ({ ok: true, models: [{ id: "first", inputSize: 1024, target: "cpu" }, { id: "second", inputSize: 1024, target: "cpu" }], default: "first", versions: { cpu: null, gpu: null } })), convert: async (b: Buffer) => b } as unknown as CatalogDeps["matting"],
    storage: { ...storage, getBucketName: () => "assets", getPublicBucketName: () => "public", uploadBuffer: upload,
      downloadBuffer: async uri => { const buf = objects.get(uri); if (!buf) throw new Error(`No object ${uri}`); return { buf, mime: "image/png" }; },
      headObject: async uri => { const buf = objects.get(uri); return buf ? { exists: true, size: buf.length, contentType: "image/jpeg", generation: String(generation), crc32c: `c${buf.length}` } : { exists: false, size: null, contentType: null, generation: null, crc32c: null }; } },
  };
  return { deps, objects, judgeOutput, matteFor };
}

let count = 0;
async function seed(w: ReturnType<typeof world>, productType: ProductType, shots: Shot[], channels: ChannelId[] = ["noon"]) {
  const name = `auto-${++count}`;
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "test@opptra.com", status: "matting", productType, channels, counts: { ...EMPTY_BATCH_COUNTS, products: 1, sources: shots.length, outputs: shots.length * channels.length } }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: name, pathKey: name, identifier: name, lockBatchId: batch!.id }).returning();
  for (const [i, shot] of shots.entries()) {
    const rgb = Buffer.alloc(W * H * 3, BG); shot.draw(rgb);
    const png = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
    const rawUri = await w.deps.storage.uploadBuffer(`catalog-test/anta/${batch!.id}/raw/${name}/${i + 1}.png`, png, "image/png");
    await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: product!.id, n: i + 1, sha256: `${name}-${i}`, originalName: `${name}_${i + 1}.png`, rawUri, mime: "image/png", width: W, height: H });
  }
  const [chunk] = await db.insert(catalogChunks).values({ batchId: batch!.id, index: 0, stage: "matte", productIds: [product!.id] }).returning();
  for (let stage = 0; stage < 3; stage++) expect((await handleChunkTask(w.deps,await currentChunkTask(db,chunk!.id))).httpStatus).toBe(200);
  const outputs = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, batch!.id)).orderBy(catalogOutputs.n, catalogOutputs.channel);
  const held = await listAttention(db, batch!.id, async uri => uri);
  return { batch: batch!, product: product!, outputs, held };
}
const steps = (actions: AutoAction[]) => actions.map(a => `${a.step}:${a.result}`);
const own = ["halo", "leftover_background", "failed_compliance"];

describe("07 auto-resolve: re-render and re-judge before holding", () => {
  it("a leftover background read from the shadow we added is repaired by taking that shadow off, on that channel, and recorded", async () => {
    const w = world(), s = await seed(w, "footwear", [block(PLAIN, 300, 500)]);
    const [o] = s.outputs;
    expect(steps(autoActionsOf(o!.compliance))).toEqual(["shadow_off:passed"]);
    expect(autoActionsOf(o!.compliance)[0]).toMatchObject({ trigger: ["leftover_background"], channels: ["noon"], rejudged: true });
    expect(o).toMatchObject({ status: "staged", compliance: { ok: true } });
    expect(o!.flags).not.toContain("shadow_synthesised");
    for (const flag of own) expect(o!.flags).not.toContain(flag);
    // The first judgement plus exactly one re-judge.
    expect(w.judgeOutput).toHaveBeenCalledTimes(2);
    expect(s.held).toEqual([]);
  }, 120_000);

  it("a halo is repaired by the second cut-out, the photo's matte, and every channel is re-made with it and re-checked", async () => {
    const w = world(), s = await seed(w, "apparel_flat", [block(PLAIN), block(HALO_FIRST)], ["noon", "amazon"]);
    const photo = s.outputs.filter(o => o.n === 2);
    expect(photo).toHaveLength(2);
    for (const o of photo) {
      // No shadow was drawn on apparel, so no shadow step is offered or recorded: the failure names the cut-out.
      expect(steps(autoActionsOf(o.compliance))).toEqual(["second_matte:passed"]);
      expect(autoActionsOf(o.compliance).at(-1)!.channels.sort()).toEqual(["amazon", "noon"]);
      expect(o.status).toBe("staged");
      expect(o.flags).not.toContain("halo");
      // Cost ledger: the matte stage's first cut-out call on this photo, then the repair ladder's second one, which
      // runs here in the render stage and is written by itself outside the chunk claim, so it never carries a chunk id or attempt.
      const calls = await db.select().from(catalogCostEvents).where(and(eq(catalogCostEvents.sourceImageId, o.sourceImageId), eq(catalogCostEvents.kind, "matte_call"))).orderBy(catalogCostEvents.at);
      expect(calls.map(c => [c.outcome, c.chunkId === null])).toEqual([["ok", false], ["ok", true]]);
      expect(o.compliance).toMatchObject({ ok: true });
    }
    const [source] = await db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId, s.batch.id), eq(catalogSourceImages.n, 2)));
    expect(source).toMatchObject({ matteModel: "second" });
    expect(source!.matteUri).toMatch(/\.matte2\.png$/);
    expect(w.matteFor.mock.calls.map(call => call[2])).toEqual(["first", "first", "second"]);
    expect(s.held).toEqual([]);
  }, 180_000);

  it("a margin breach of the channel rules is repaired by a fit computed from the measured overflow, before the judge", async () => {
    const w = world(), real = w.deps.renderAllChannels;
    // The checks no longer judge the checker's JPEG tint inside its own 8 x 8 blocks (compliance.ts JPEG_BLOCK_PX), and
    // nothing else in this world reaches past the margin at full fit, so photo 2's full-fit render is failed here, with
    // a measurement 12 px past the safe box at the top and the bottom for the refit to compute from.
    w.deps.renderAllChannels = async (p, m, channels, ctx) => {
      const out = await real(p, m, channels, ctx);
      if (ctx.shotNumber !== 2 || ctx.fitScale !== undefined) return out;
      const failure = "inside_safe_box: The product or shadow reaches outside the required margins.";
      for (const c of channels) {
        const measured = out[c].compliance.measured!, seen = { ...measured.safe, y: measured.safe.y - 12, h: measured.safe.h + 24 };
        out[c] = { ...out[c], jpeg: null, status: "failed", flags: [...out[c].flags, "failed_compliance"], notes: ["The image we made did not meet Noon's rules: the product reaches into the margins Noon requires."], compliance: { ok: false, failures: [failure], measured: { ...measured, seen, outside: { ...measured.outside, top: 12, bottom: 12 } } } };
      }
      return out;
    };
    const s = await seed(w, "apparel_flat", [block(PLAIN), checker]);
    const o = s.outputs.find(row => row.n === 2)!;
    const actions = autoActionsOf(o.compliance);
    expect(steps(actions)).toEqual(["refit:passed"]);
    expect(actions[0]!).toMatchObject({ channels: ["noon"], trigger: ["failed_compliance"] });
    expect(actions[0]!.detail).toMatch(/^inside_safe_box -> fit 0\.9\d\d$/);
    expect(actions.every(a => !a.rejudged)).toBe(true);
    expect(o).toMatchObject({ status: "staged", compliance: { ok: true, variant: { fitScale: expect.any(Number) } } });
    // The measurement is kept with the image, so a later repair can compute from it.
    expect((o.compliance as { measured: { seen: unknown; shadow: string } }).measured).toMatchObject({ seen: expect.objectContaining({ w: expect.any(Number) }), shadow: "none" });
    expect(o.flags).not.toContain("failed_compliance");
    // The fixed image was judged like any other.
    expect(w.judgeOutput.mock.calls.filter(call => call[0].n === 2)).toHaveLength(1);
    expect(s.held).toEqual([]);
  }, 180_000);

  it("a halo no cut-out fixes on photo 3 with two good photos left drops it with a note saying what was tried, and no hold", async () => {
    const w = world(), s = await seed(w, "apparel_flat", [block(PLAIN), block(PLAIN), block(HALO_ALWAYS)]);
    const o = s.outputs.find(row => row.n === 3)!;
    // The only repair a halo has is the second cut-out (the product's pixels are never redrawn); a smaller fit cannot answer it.
    expect(steps(autoActionsOf(o.compliance))).toEqual(["second_matte:failed"]);
    expect(o.status).toBe("skipped");
    expect(o.flags).toEqual(expect.arrayContaining(["halo", "auto_dropped"]));
    expect(o.reason).toContain("We tried a second cut-out and could not fix it.");
    expect(o.reason).toContain("Left out automatically");
    // Plain words only: no step id, no rule code, no model name.
    expect(o.reason).not.toMatch(/second_matte|_|birefnet|test\/judge/);
    expect(o.qaScores).toMatchObject({ autoAction: "drop" });
    // One judge look per round: the first judging plus one re-judge of the second cut-out.
    expect(w.judgeOutput.mock.calls.filter(call => call[0].n === 3)).toHaveLength(2);
    expect(s.held).toEqual([]);
  }, 180_000);

  it("a halo no cut-out fixes on photo 1 holds the product with the existing flag and the tried sentence on the card", async () => {
    const w = world(), s = await seed(w, "apparel_flat", [block(HALO_ALWAYS), block(PLAIN), block(PLAIN)]);
    const o = s.outputs.find(row => row.n === 1)!;
    expect(steps(autoActionsOf(o.compliance))).toEqual(["second_matte:failed"]);
    expect(o).toMatchObject({ status: "needs_attention", qaScores: { autoAction: "hold", holdCause: "photo_one" } });
    expect(o.flags).toContain("halo");
    expect(s.held.map(p => p.photos.map(photo => photo.n))).toEqual([[1]]);
    expect(s.held[0]!.photos[0]!.why).toContain("We tried a second cut-out and could not fix it.");
  }, 180_000);

  it("a judge-seen cut at the knees with no photo edge is placed flush; it stays a note, never a hold", async () => {
    const w = world({ photoScores: (n): Record<string, number> => (n === 2 ? { complete_product: 30 } : {}) }), s = await seed(w, "apparel_flat", [block(PLAIN), legs()]);
    const o = s.outputs.find(row => row.n === 2)!;
    expect(steps(autoActionsOf(o.compliance))).toEqual(["flush_cut:passed"]);
    expect(o.flags).toEqual(expect.arrayContaining(["complete_product", "cut_in_source"]));
    expect(o).toMatchObject({ status: "staged", compliance: { ok: true } });
    // Flush: the legs reach the canvas bottom.
    expect(o.placedY + Math.round((760 - 200) * o.scale)).toBeGreaterThanOrEqual(o.canvasH - 2);
    expect(s.held).toEqual([]);
  }, 180_000);

  it("a judge-seen cut still runs when another side of the photo was already placed flush", async () => {
    const w = world({ photoScores: (n): Record<string, number> => (n === 2 ? { complete_product: 30 } : {}) }), s = await seed(w, "apparel_flat", [block(PLAIN), legs(true, true)]);
    const o = s.outputs.find(row => row.n === 2)!;
    expect(steps(autoActionsOf(o.compliance))).toEqual(["flush_cut:passed"]);
    expect(o.flags).toContain("cut_in_source");
    expect(o.placedY + Math.round((760 - 200) * o.scale)).toBeGreaterThanOrEqual(o.canvasH - 2);
  }, 180_000);

  it("knees cut in a deep band of the background colour are placed flush at render when the hand is cut at the frame edge", async () => {
    const w = world({ photoScores: (n): Record<string, number> => (n === 2 ? { complete_product: 30 } : {}) }), s = await seed(w, "apparel_flat", [block(PLAIN), legs(true)]);
    const o = s.outputs.find(row => row.n === 2)!;
    expect(steps(autoActionsOf(o.compliance))).toEqual(["flush_cut:skipped"]);
    expect(o.flags).toContain("cut_in_source");
    expect(o.placedY + Math.round((760 - 200) * o.scale)).toBeGreaterThanOrEqual(o.canvasH - 2);
  }, 180_000);

  it("a matte that fell back while the service was down is retried once the service answers", async () => {
    const w = world();
    w.matteFor.mockImplementationOnce(async p => ({ ...fakeMatte(p.rgb, "first"), model: "floodfill", source: "floodfill", target: null }));
    const s = await seed(w, "apparel_flat", [block(PLAIN)]);
    const [o] = s.outputs;
    expect(w.matteFor).toHaveBeenCalledTimes(2);
    expect(steps(autoActionsOf(o!.compliance))).toEqual(["matte_retry:passed"]);
    expect(o!.flags).not.toContain("fallback_matte");
    expect(o!.status).toBe("staged");
  }, 120_000);

  it("a batch whose only problems are our own defects ends with an attention rate of 0", async () => {
    const w = world(), s = await seed(w, "footwear", [block(PLAIN), block(HALO_FIRST), checker]);
    const actions = s.outputs.map(o => steps(autoActionsOf(o.compliance)));
    // Every photo had a defect we made (a stray shadow, a halo, and on the checker its added shadow; its JPEG tint stays
    // inside its own 8 x 8 blocks and no longer breaks the margin, compliance.ts JPEG_BLOCK_PX) and each got its own fix.
    expect(actions.map(list => list.at(-1))).toEqual(["shadow_off:passed", "second_matte:passed", "shadow_off:passed"]);
    for (const o of s.outputs) { expect(o.status).toBe("staged"); for (const flag of own) expect(o.flags).not.toContain(flag); }
    expect(attentionRate(s.held.length, 1)).toBe(0);
  }, 240_000);
});

describe("cut-out integrity guard in the matte stage (matte-guard.ts)", () => {
  const grain = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 49 - 24;
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  const LOGO = { x: 350, y: 350, w: 100, h: 100 };
  const inLogo = (x: number, y: number) => x >= LOGO.x && x < LOGO.x + LOGO.w && y >= LOGO.y && y < LOGO.y + LOGO.h;
  /** Orange leather filling the frame with a gold logo: the French Connection bag close-up. */
  const closeUp: Shot = { draw: rgb => rect(rgb, 0, 0, W, H, (x, y) => inLogo(x, y) ? [214, 180, 90] : [clamp(225 + grain(x, y)), clamp(110 + grain(x, y)), clamp(40 + grain(x, y))]) };
  /** A white page with rows of dark glyphs and table lines: the Penti size chart. */
  const sizeChart: Shot = { draw: rgb => rect(rgb, 0, 0, W, H, (x, y) => {
    const row = Math.floor((y - 100) / 30), inTable = row >= 0 && row < 18 && x >= 80 && x < 720;
    if (inTable && ((y - 100) % 30 === 0 || x % 213 === 80)) return [200, 200, 200];
    if (inTable && (y - 100) % 30 >= 10 && (y - 100) % 30 < 20 && (x - 80) % 12 < 7) return [30, 30, 30];
    return [255, 250, 250];
  }) };
  const logoOnly = (model: string): Matte => {
    const alpha = Buffer.alloc(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inLogo(x, y)) alpha[y * W + x] = 255;
    return { alpha, width: W, height: H, model, ms: 5, source: "model", target: "cpu", sentLongSide: 1024 };
  };
  const whole = (model: string): Matte => ({ ...logoOnly(model), alpha: Buffer.alloc(W * H, 255) });

  it("a close-up whose cut-out kept only the logo is re-matted on a padded frame before anything is rendered", async () => {
    const w = world();
    w.matteFor.mockImplementation(async (_p, _client, model, opts) => (opts?.padFraction && model === "second" ? whole : logoOnly)(model ?? "first"));
    const s = await seed(w, "bag_accessory", [closeUp]);
    const [o] = s.outputs;
    expect(w.matteFor.mock.calls.map(call => `${call[2]}${call[3]?.padFraction ? " padded" : ""}`)).toEqual(["first", "second", "first padded", "second padded"]);
    expect(steps(autoActionsOf(o!.compliance)).slice(0, 4)).toEqual(["matte_check:failed", "second_matte:failed", "padded_matte:failed", "padded_matte:passed"]);
    expect(autoActionsOf(o!.compliance)[0]).toMatchObject({ trigger: ["product_removed"] });
    expect(o!.flags).not.toContain("matte_passthrough");
    const [source] = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, s.batch.id));
    expect(source).toMatchObject({ matteModel: "second", status: "matted" });
    expect(s.held).toEqual([]);
  }, 180_000);

  it("when no cut-out keeps the product the whole frame passes through: flagged for information, no shadow, never held", async () => {
    const w = world();
    w.matteFor.mockImplementation(async (_p, _client, model) => logoOnly(model ?? "first"));
    const s = await seed(w, "bag_accessory", [closeUp], ["noon", "amazon"]);
    for (const o of s.outputs) {
      expect(steps(autoActionsOf(o.compliance)).slice(0, 5)).toEqual(["matte_check:failed", "second_matte:failed", "padded_matte:failed", "padded_matte:failed", "matte_passthrough:passed"]);
      expect(o.flags).toContain("matte_passthrough");
      expect(o.flags).not.toContain("shadow_synthesised");
      expect(o.status).toBe("staged");
    }
    const [source] = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, s.batch.id));
    const alpha = await sharp(w.objects.get(source!.matteUri!)!).toColourspace("b-w").raw().toBuffer();
    expect(alpha.every(v => v === 255)).toBe(true);
    expect(s.held).toEqual([]);
  }, 180_000);

  it("a photo on a busy background no cut-out keeps is held whole with its card sentence, never published (FC ZEE79259BBFD83FFA1DB0Z shot 5)", async () => {
    // A hedge across the top of the frame and a textured racket on the court; every model keeps the dark model in the middle only.
    const model = (x: number, y: number) => x >= 300 && x < 500 && y >= 200 && y < 800;
    const scene: Shot = { draw: rgb => rect(rgb, 0, 0, W, H, (x, y) => model(x, y) ? [clamp(30 + grain(x, y)), clamp(30 + grain(x, y)), 34] : y < 120 || (x >= 560 && x < 640 && y >= 500 && y < 580) ? [clamp(70 + grain(x, y) * 2), clamp(110 + grain(x, y) * 2), clamp(50 + grain(x, y))] : [233, 124, 86]) };
    const keepsModel = (name: string): Matte => { const alpha = Buffer.alloc(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (model(x, y)) alpha[y * W + x] = 255; return { alpha, width: W, height: H, model: name, ms: 5, source: "model", target: "cpu", sentLongSide: 1024 }; };
    const w = world();
    w.matteFor.mockImplementation(async (p, _client, name) => p.rgb[0] === BG ? fakeMatte(p.rgb, name ?? "first") : keepsModel(name ?? "first"));
    const s = await seed(w, "apparel_model", [block(PLAIN), scene], ["noon", "amazon"]);
    const busy = s.outputs.filter(o => o.n === 2);
    expect(busy).toHaveLength(2);
    for (const o of busy) {
      expect(steps(autoActionsOf(o.compliance)).slice(0, 5)).toEqual(["matte_check:failed", "second_matte:failed", "padded_matte:failed", "padded_matte:failed", "matte_passthrough:failed"]);
      expect(o.flags).toContain("leftover_background");
      expect(busyBackgroundHold(o.compliance)).toBe(true);
      expect(o.flags).not.toContain("matte_passthrough");
      expect(o.status).toBe("needs_attention");
      // The card sentence first, then the render's band note where a cut side floats (Noon here): "Use as is"
      // publishes this fitted render, so the sheet's flush note must leave the photo out (gate 3f defect 2).
      expect(o.reason).toMatch(/^The background could not be removed from this photo\./);
      expect(o.reason).not.toMatch(/[.!?];/);
      if (o.channel === "noon") {
        expect(o.reason).toMatch(/^The background could not be removed from this photo\. The original photo is cut at the /);
        expect(hasCutBandNote(o.reason)).toBe(true);
      }
      expect(o.qaScores).toMatchObject({ autoAction: "hold", holdCause: "unusable" });
      // The whole photo, fitted: never trimmed.
      expect(o.canvasH).toBeGreaterThan(0);
    }
    const [source] = await db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId, s.batch.id), eq(catalogSourceImages.n, 2)));
    expect(source).toMatchObject({ matteModel: "passthrough" });
    const alpha = await sharp(w.objects.get(source!.matteUri!)!).toColourspace("b-w").raw().toBuffer();
    expect(alpha.every(v => v === 255)).toBe(true);
    expect(s.held).toHaveLength(1);
    expect(s.held[0]!.photos[0]).toMatchObject({ n: 2, whatToDo: "Use it as is, replace it, or remove it." });
    expect(s.held[0]!.photos[0]!.why).toMatch(/^The background could not be removed from this photo\./);
    expect(s.outputs.filter(o => o.n === 1).every(o => o.status === "staged")).toBe(true);
    expect(cutInSourceNote(busy)).toBe("");
  }, 180_000);

  it("a size chart is not cut out: left out on every channel with its note, never held", async () => {
    const w = world(), s = await seed(w, "apparel_flat", [block(PLAIN), sizeChart], ["noon", "amazon"]);
    const chart = s.outputs.filter(o => o.n === 2);
    expect(chart).toHaveLength(2);
    for (const o of chart) expect(o).toMatchObject({ status: "skipped", flags: ["chart_image"], reason: flagReason("chart_image") });
    // Only photo 1 was matted.
    expect(w.matteFor).toHaveBeenCalledTimes(1);
    expect(s.outputs.filter(o => o.n === 1).every(o => o.status === "staged")).toBe(true);
    expect(s.held).toEqual([]);
  }, 180_000);

  it("a chart the classifier saw first is left out and the next photo decides the product type", async () => {
    const w = world();
    vi.mocked(w.deps.classifyProductType).mockResolvedValueOnce({ type: "other", confidence: 1, costUsd: 0, calls: 1, usage: {}, flags: [], chart: true }).mockResolvedValueOnce({ type: "footwear", confidence: 1, costUsd: 0, calls: 1, usage: {}, flags: [], chart: false });
    const s = await seed(w, "auto", [block(PLAIN), block(PLAIN, 300, 500)]);
    expect(w.deps.classifyProductType).toHaveBeenCalledTimes(2);
    expect(s.outputs.find(o => o.n === 1)).toMatchObject({ status: "skipped", flags: ["chart_image"] });
    expect(s.outputs.find(o => o.n === 2)!.status).toBe("staged");
    const [product] = await db.select().from(catalogProducts).where(eq(catalogProducts.id, s.product.id));
    expect(product!.productType).toBe("footwear");
    const sources = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.batchId, s.batch.id)).orderBy(catalogSourceImages.n);
    expect(sources.map(source => source.flags.includes("chart_image"))).toEqual([true, false]);
  }, 180_000);

  it("a judge-seen product_removed goes to the second cut-out, then the same pass-through step, and keeps the winner as the photo's matte", async () => {
    let judged = 0;
    const w = world({ photoScores: (n): Record<string, number> => (n === 2 && ++judged < 3 ? { product_intact: 30 } : {}) });
    const s = await seed(w, "apparel_flat", [block(PLAIN), block(PLAIN)]);
    const o = s.outputs.find(row => row.n === 2)!;
    expect(steps(autoActionsOf(o.compliance))).toEqual(["second_matte:failed", "matte_passthrough:passed"]);
    expect(o.flags).toContain("matte_passthrough");
    expect(o.flags).not.toContain("product_removed");
    expect(o.status).toBe("staged");
    const [source] = await db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId, s.batch.id), eq(catalogSourceImages.n, 2)));
    expect(source!.matteUri).toMatch(/\.matte-whole\.png$/);
    expect(source!.flags).toContain("matte_passthrough");
  }, 180_000);
});
