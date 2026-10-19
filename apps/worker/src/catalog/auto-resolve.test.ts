import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogChunks, catalogOutputs, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import * as storage from "@catalog/core/storage";
import { listAttention } from "@catalog/core/catalog/attention";
import { attentionRate } from "@catalog/core/catalog/pipeline/report";
import { autoActionsOf, type AutoAction } from "@catalog/core/catalog/auto-resolve";
import type { ChannelId, ProductType, ResolvedPolicy } from "@catalog/core/catalog/types";
import type { Matte } from "@catalog/core/catalog/render";
import { workerCatalogDeps, type CatalogDeps } from "./deps";
import { handleChunkTask } from "./chunk";

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
/** Saturated 2 px red and blue checks: JPEG chroma ringing pushes past the margin at full fit (real render). */
const checker: Shot = { draw: rgb => rect(rgb, 200, 50, 400, 700, (x, y) => (((x >> 1) + (y >> 1)) & 1 ? [255, 0, 0] : [0, 0, 255])) };
/**
 * A cut-out on the photo's own plain background, cut at the knees 40 px above the frame bottom: no photo edge shows,
 * so only the judge can say the legs end at a cut. `hand` adds a hand cut by the left frame edge, which the detector
 * places flush on its own.
 */
const legs = (hand = false): Shot => ({ draw: rgb => { rect(rgb, 250, 200, 300, 400, () => PLAIN); rect(rgb, 250, 600, 60, 160, () => PLAIN); rect(rgb, 490, 600, 60, 160, () => PLAIN); if (hand) rect(rgb, 0, 300, 250, 60, () => PLAIN); } });

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
  for (let y = Math.max(0, y1 - 40); y <= Math.min(h - 1, y1 + 40); y++) for (let x = Math.max(0, x0 - 40); x <= Math.min(w - 1, x1 + 40); x++) { if (x >= x0 && x <= x1 && y <= y1) continue; const c = px(x, y); if (luma(bg) - luma(c) >= 4 && !near(c) && Math.max(...c) - Math.min(...c) < 6) patch++; }
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
  for (let stage = 0; stage < 3; stage++) expect((await handleChunkTask(w.deps, { chunkId: chunk!.id })).httpStatus).toBe(200);
  const outputs = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, batch!.id)).orderBy(catalogOutputs.n, catalogOutputs.channel);
  const held = await listAttention(db, batch!.id, async uri => uri);
  return { batch: batch!, product: product!, outputs, held };
}
const steps = (actions: AutoAction[]) => actions.map(a => `${a.step}:${a.result}`);
const own = ["halo", "leftover_background", "failed_compliance"];

describe("07 auto-resolve: re-render and re-judge before holding", () => {
  it("a leftover-background failure is resolved at step (a), shadow off, and recorded", async () => {
    const w = world(), s = await seed(w, "footwear", [block(PLAIN, 300, 500)]);
    const [o] = s.outputs;
    expect(steps(autoActionsOf(o!.compliance))).toEqual(["shadow_off:passed", "apply:passed"]);
    expect(autoActionsOf(o!.compliance)[0]).toMatchObject({ trigger: ["leftover_background"], channels: ["noon"], rejudged: true });
    expect(o).toMatchObject({ status: "staged", compliance: { ok: true } });
    expect(o!.flags).not.toContain("shadow_synthesised");
    for (const flag of own) expect(o!.flags).not.toContain(flag);
    // The first judgement plus exactly one re-judge.
    expect(w.judgeOutput).toHaveBeenCalledTimes(2);
    expect(s.held).toEqual([]);
  }, 120_000);

  it("a halo is resolved at step (b), the second matte, and the winner is applied to every channel of the photo", async () => {
    const w = world(), s = await seed(w, "apparel_flat", [block(PLAIN), block(HALO_FIRST)], ["noon", "amazon"]);
    const photo = s.outputs.filter(o => o.n === 2);
    expect(photo).toHaveLength(2);
    for (const o of photo) {
      // No synthesised shadow on apparel, so step (a) has nothing to change and costs nothing.
      expect(steps(autoActionsOf(o.compliance))).toEqual(["shadow_off:skipped", "second_matte:passed", "apply:passed"]);
      expect(autoActionsOf(o.compliance).at(-1)!.channels.sort()).toEqual(["amazon", "noon"]);
      expect(o.status).toBe("staged");
      expect(o.flags).not.toContain("halo");
      expect(o.compliance).toMatchObject({ ok: true });
    }
    const [source] = await db.select().from(catalogSourceImages).where(and(eq(catalogSourceImages.batchId, s.batch.id), eq(catalogSourceImages.n, 2)));
    expect(source).toMatchObject({ matteModel: "second" });
    expect(source!.matteUri).toMatch(/\.matte2\.png$/);
    expect(w.matteFor.mock.calls.map(call => call[2])).toEqual(["first", "first", "second"]);
    expect(s.held).toEqual([]);
  }, 180_000);

  it("a placement failure of the channel rules is resolved at step (c), a 5% smaller fit, before the judge", async () => {
    const w = world(), s = await seed(w, "apparel_flat", [block(PLAIN), checker]);
    const o = s.outputs.find(row => row.n === 2)!;
    const actions = autoActionsOf(o.compliance);
    expect(steps(actions)).toEqual(["shadow_off:skipped", "second_matte:failed", "smaller_fit:passed", "apply:passed"]);
    expect(actions[1]!.detail).toMatch(/inside_safe_box/);
    expect(actions.every(a => !a.rejudged)).toBe(true);
    expect(o).toMatchObject({ status: "staged", compliance: { ok: true } });
    expect(o.flags).not.toContain("failed_compliance");
    // The fixed image was judged like any other.
    expect(w.judgeOutput.mock.calls.filter(call => call[0].n === 2)).toHaveLength(1);
    expect(s.held).toEqual([]);
  }, 180_000);

  it("an exhausted ladder on photo 3 with two good photos left drops it with a note and no hold", async () => {
    const w = world(), s = await seed(w, "apparel_flat", [block(PLAIN), block(PLAIN), block(HALO_ALWAYS)]);
    const o = s.outputs.find(row => row.n === 3)!;
    expect(steps(autoActionsOf(o.compliance))).toEqual(["shadow_off:skipped", "second_matte:failed", "smaller_fit:failed"]);
    expect(o.status).toBe("skipped");
    expect(o.flags).toEqual(expect.arrayContaining(["halo", "auto_dropped"]));
    expect(o.reason).toContain("Left out automatically");
    expect(o.qaScores).toMatchObject({ autoAction: "drop" });
    // At most one re-judge per step that ran: judge + second matte + smaller fit.
    expect(w.judgeOutput.mock.calls.filter(call => call[0].n === 3)).toHaveLength(3);
    expect(s.held).toEqual([]);
  }, 180_000);

  it("an exhausted ladder on photo 1 holds the product with the existing flag", async () => {
    const w = world(), s = await seed(w, "apparel_flat", [block(HALO_ALWAYS), block(PLAIN), block(PLAIN)]);
    const o = s.outputs.find(row => row.n === 1)!;
    expect(steps(autoActionsOf(o.compliance))).toEqual(["shadow_off:skipped", "second_matte:failed", "smaller_fit:failed"]);
    expect(o).toMatchObject({ status: "needs_attention", qaScores: { autoAction: "hold", holdCause: "photo_one" } });
    expect(o.flags).toContain("halo");
    expect(s.held.map(p => p.photos.map(photo => photo.n))).toEqual([[1]]);
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
    const w = world({ photoScores: (n): Record<string, number> => (n === 2 ? { complete_product: 30 } : {}) }), s = await seed(w, "apparel_flat", [block(PLAIN), legs(true)]);
    const o = s.outputs.find(row => row.n === 2)!;
    expect(steps(autoActionsOf(o.compliance))).toEqual(["flush_cut:passed"]);
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
    // Every photo had a defect we made (a stray shadow, a halo, ringing past the margin) and every one was re-made.
    expect(actions.every(list => list.at(-1) === "apply:passed")).toBe(true);
    for (const o of s.outputs) { expect(o.status).toBe("staged"); for (const flag of own) expect(o.flags).not.toContain(flag); }
    expect(attentionRate(s.held.length, 1)).toBe(0);
  }, 240_000);
});
