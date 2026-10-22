import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogOutputs, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import * as storage from "@catalog/core/storage";
import { autoActionsOf } from "@catalog/core/catalog/auto-resolve";
import type { Matte, Prepared, RenderOutput } from "@catalog/core/catalog/render";
import type { ChannelId, ResolvedPolicy } from "@catalog/core/catalog/types";
import { workerCatalogDeps, type CatalogDeps } from "./deps";
import { resolvePhoto } from "./auto-resolve";

// 07 4.6a, the loop alone: a fabricated renderer says what each channel's render measured, so the test
// sees exactly which channel is re-made, with which options, and that the other channel is never touched.
let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => close());

const policy: ResolvedPolicy = { matteModel: "first", qaModel: "test/judge", threshold: 75, floor: 60, qaMode: "per_source", qaSampleRate: 1, source: "default" };
const prepared: Prepared = { width: 10, height: 10, rgb: Buffer.alloc(300, 150), alphaSource: null, background: { uniform: true, color: [150, 150, 150], stdev: 0 }, flags: [], sourceMime: "image/png" };
const matte: Matte = { alpha: Buffer.alloc(100, 255), width: 10, height: 10, model: "first", ms: 1, source: "model", target: "cpu", sentLongSide: 1024 };
const NO_CUT = { top: false, bottom: false, left: false, right: false };
type Ctx = Parameters<CatalogDeps["renderAllChannels"]>[3];
/** A render result: failing with the given codes and measurement, or passing with a fresh JPEG. */
function made(channel: ChannelId, failures: string[], measured: Record<string, unknown> = {}): RenderOutput {
  const ok = !failures.length, canvas = channel === "styli" ? { w: 2342, h: 3123 } : { w: 1080, h: 1480 };
  return { jpeg: ok ? Buffer.concat([Buffer.from([255, 216, 255]), Buffer.from(`${channel}-${Math.random()}`)]) : null, status: ok ? "ok" : "failed", plan: { ...canvas, lowResolution: false, safeBox: { x: 0, y: 0, ...canvas }, scale: 1, placedX: 0, placedY: 0, detailShot: false }, quality: 90, bytes: 100, flags: ok ? [] : ["failed_compliance"], notes: ok ? [] : failures, attention: null,
    compliance: { ok, failures, measured: { canvas, safe: { x: 150, y: 450, w: 2042, h: 2223 }, seen: { x: 200, y: 500, w: 1000, h: 2000 }, outside: { top: 0, bottom: 0, left: 0, right: 0 }, anchorDelta: null, bandBreach: false, bytes: 100, shadow: "none", cut: NO_CUT, ...measured } } };
}
/** The row's `compliance` column for a render result. */
const stored = (r: RenderOutput): Record<string, unknown> => ({ ...r.compliance });

let count = 0;
async function seed(channels: ChannelId[]) {
  const name = `repair-${++count}`;
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "test@opptra.com", status: "rendering", productType: "footwear", channels, counts: { ...EMPTY_BATCH_COUNTS, products: 1, sources: 1, outputs: channels.length }, options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null, policy } }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: name, pathKey: name, identifier: name, lockBatchId: batch!.id, productType: "footwear" }).returning();
  const [source] = await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: product!.id, n: 1, sha256: name, originalName: `${name}_1.png`, rawUri: `gs://assets/raw/${name}.png`, mime: "image/png", width: 10, height: 10, matteUri: `gs://assets/derived/${name}.matte.png`, matteModel: "first" }).returning();
  const outputs = [];
  for (const channel of channels) {
    const failing = channel === "styli";
    const [o] = await db.insert(catalogOutputs).values({ batchId: batch!.id, productId: product!.id, sourceImageId: source!.id, channel, n: 1, canvasW: 1080, canvasH: 1480, scale: 1, placedX: 0, placedY: 0, bytes: 100, quality: 90, renderKey: `${name}-${channel}`, objectPath: `catalog-test/anta/${name}/${channel}/1.jpg`, publicUrl: `https://public/${name}/${channel}/1.jpg`, stagingUri: `gs://assets/staging/${name}/${channel}/1.jpg`, crc32c: "first", status: failing ? "needs_attention" : "staged", flags: failing ? ["failed_compliance"] : [],
      compliance: stored(failing ? made("styli", ["styli_anchor: The product must be centred on the Styli bottom guide."], { anchorDelta: { dx: 0, dy: -7 } }) : made(channel, [])) }).returning();
    outputs.push(o!);
  }
  return { batch: batch!, product: product!, source: source!, outputs };
}

function world(render: (channel: ChannelId, ctx: Ctx) => RenderOutput) {
  const objects = new Map<string, Buffer>();
  const base = workerCatalogDeps(db);
  const renderAllChannels = vi.fn<CatalogDeps["renderAllChannels"]>(async (_p, _m, channels, ctx) => Object.fromEntries(channels.map(c => [c, render(c, ctx)])) as Record<ChannelId, RenderOutput>);
  const deps: CatalogDeps = { ...base, now: () => new Date("2026-01-01T00:00:00Z"), log: () => {}, renderAllChannels, matteFor: vi.fn(async () => matte),
    matting: { ...base.matting, health: vi.fn(async () => ({ ok: true, models: [{ id: "first", inputSize: 1024, target: "cpu" }], default: "first", versions: { cpu: null, gpu: null } })) } as unknown as CatalogDeps["matting"],
    storage: { ...storage, getBucketName: () => "assets", getPublicBucketName: () => "public", uploadBuffer: async (path, buf) => { objects.set(`gs://assets/${path}`, buf); return `gs://assets/${path}`; }, downloadBuffer: async uri => ({ buf: objects.get(uri) ?? Buffer.alloc(0), mime: "image/jpeg" }),
      headObject: async uri => { const buf = objects.get(uri); return buf ? { exists: true, size: buf.length, contentType: "image/jpeg", generation: "2", crc32c: `c${buf.length}` } : { exists: false, size: null, contentType: null, generation: null, crc32c: null }; } } };
  return { deps, renderAllChannels };
}
const underClaim: Parameters<typeof resolvePhoto>[1]["underClaim"] = write => write(db);
const statusFor = (flags: string[]) => (flags.includes("failed_compliance") ? "needs_attention" as const : "staged" as const);

describe("resolvePhoto: the fix is computed from the measurement and applied to the failing channel only", () => {
  it("a Styli guide miss is re-shifted by the exact delta; Noon is never re-made and its row keeps its image", async () => {
    // The first re-render still misses by one row (the fade), the second lands.
    let styliRenders = 0;
    const w = world((channel, ctx) => {
      if (channel !== "styli") throw new Error(`re-made ${channel}`);
      styliRenders++;
      if (styliRenders === 1) { expect(ctx.anchorShift).toEqual({ dx: 0, dy: -7 }); return made("styli", ["styli_anchor: x"], { anchorDelta: { dx: 0, dy: 1 } }); }
      expect(ctx.anchorShift).toEqual({ dx: 0, dy: -6 });
      return made("styli", []);
    });
    const s = await seed(["noon", "styli"]);
    const result = await resolvePhoto(w.deps, { batch: s.batch, product: s.product, source: s.source, policy, underClaim, outputs: s.outputs, failing: s.outputs.filter(o => o.channel === "styli"), trigger: ["failed_compliance"], shadowAllowed: true, statusFor, prepared, matte });
    expect(w.renderAllChannels.mock.calls.map(call => call[2])).toEqual([["styli"], ["styli"]]);
    const rows = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, s.batch.id));
    const noon = rows.find(o => o.channel === "noon")!, styli = rows.find(o => o.channel === "styli")!;
    expect(result.fixed).toEqual(new Set([styli.id]));
    expect(styli).toMatchObject({ status: "staged", flags: [], crc32c: expect.stringMatching(/^c\d+$/), compliance: { ok: true, variant: { anchorShift: { dx: 0, dy: -6 }, fitScale: 1, matte: "first" } } });
    expect(styli.stagingUri).toMatch(/\/staging\/.*\/styli\/[^/]+_1\.jpg$/);
    expect(autoActionsOf(styli.compliance).map(a => `${a.step}:${a.result}:${a.channels.join()}`)).toEqual(["reshift:failed:styli", "reshift:passed:styli"]);
    expect(autoActionsOf(styli.compliance)[0]!.detail).toBe("styli_anchor: dx 0, dy -7; styli_anchor");
    // Noon: same bytes, same staged file, same checksum; only the record of what happened to the photo is appended.
    expect(noon).toMatchObject({ status: "staged", bytes: 100, crc32c: "first", stagingUri: `gs://assets/staging/${s.product.pathKey}/noon/1.jpg`, flags: [] });
    expect(autoActionsOf(noon.compliance)).toHaveLength(2);
  }, 60_000);

  it("a file over 2 MB is saved smaller on that channel; a drawn shadow in the margin comes off before any refit", async () => {
    const seen: Ctx[] = [];
    const w = world((channel, ctx) => { seen.push(ctx); return made(channel, []); });
    const s = await seed(["styli"]);
    const styli = s.outputs[0]!;
    // The row's failure is a 2.3 MB file; the planner answers it with the quality floor, nothing else changes.
    await db.update(catalogOutputs).set({ compliance: stored(made("styli", ["bytes: Could not get x under 2 MB."], { bytes: 2_300_000 })) }).where(eq(catalogOutputs.id, styli.id));
    const [row] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, styli.id));
    await resolvePhoto(w.deps, { batch: s.batch, product: s.product, source: s.source, policy, underClaim, outputs: [row!], failing: [row!], trigger: ["failed_compliance"], shadowAllowed: true, statusFor, prepared, matte });
    expect(seen).toEqual([expect.objectContaining({ jpegQualityMin: 50, synthesiseShadow: true })]);
    expect(seen[0]!.fitScale).toBeUndefined();
    const [after] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, styli.id));
    expect(autoActionsOf(after!.compliance).map(a => `${a.step}:${a.result}`)).toEqual(["reencode:passed"]);

    // A kept source shadow past the margin: the photo's shadow comes off first and that alone passes.
    const s2 = await seed(["styli"]);
    const o2 = s2.outputs[0]!;
    await db.update(catalogOutputs).set({ compliance: stored(made("styli", ["inside_safe_box: x"], { shadow: "kept", outside: { top: 0, bottom: 30, left: 0, right: 0 } })) }).where(eq(catalogOutputs.id, o2.id));
    const [row2] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, o2.id));
    seen.length = 0;
    await resolvePhoto(w.deps, { batch: s2.batch, product: s2.product, source: s2.source, policy, underClaim, outputs: [row2!], failing: [row2!], trigger: ["failed_compliance"], shadowAllowed: true, statusFor, prepared, matte });
    expect(seen).toEqual([expect.objectContaining({ keepSourceShadow: false, synthesiseShadow: false })]);
    expect(seen[0]!.fitScale).toBeUndefined();
    const [after2] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, o2.id));
    expect(autoActionsOf(after2!.compliance).map(a => `${a.step}:${a.result}`)).toEqual(["source_shadow_off:passed"]);
  }, 60_000);

  it("an encoder-setting failure gets one plain re-render and then keeps its first image, bounded, with no second guess", async () => {
    const w = world(channel => made(channel, ["dims: x"]));
    const s = await seed(["styli"]);
    const styli = s.outputs[0]!;
    await db.update(catalogOutputs).set({ compliance: stored(made("styli", ["dims: x"])) }).where(eq(catalogOutputs.id, styli.id));
    const [row] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, styli.id));
    const result = await resolvePhoto(w.deps, { batch: s.batch, product: s.product, source: s.source, policy, underClaim, outputs: [row!], failing: [row!], trigger: ["failed_compliance"], shadowAllowed: true, statusFor, prepared, matte });
    expect(result.fixed.size).toBe(0);
    expect(w.renderAllChannels).toHaveBeenCalledTimes(1);
    const [after] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, styli.id));
    expect(after).toMatchObject({ status: "needs_attention", crc32c: "first" });
    expect(autoActionsOf(after!.compliance).map(a => `${a.step}:${a.result}`)).toEqual(["re_render:failed"]);
  }, 60_000);

  it("a step made on another channel of the photo is still offered on this one (the record is the photo's, the repair was not)", async () => {
    const seen: { channel: ChannelId; ctx: Ctx }[] = [];
    const w = world((channel, ctx) => { seen.push({ channel, ctx }); return made(channel, []); });
    const s = await seed(["noon"]);
    const noon = s.outputs[0]!;
    // Styli's shadow came off earlier in the run; the record sits on Noon's row too. Noon now breaks its margin with its own added shadow.
    const styliShadowOff = { step: "shadow_off", trigger: ["failed_compliance"], result: "passed", channels: ["styli"], rejudged: false };
    await db.update(catalogOutputs).set({ flags: ["failed_compliance"], compliance: { ...stored(made("noon", ["inside_safe_box: x"], { shadow: "synthesised" })), auto_actions: [styliShadowOff] } }).where(eq(catalogOutputs.id, noon.id));
    const [row] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, noon.id));
    await resolvePhoto(w.deps, { batch: s.batch, product: s.product, source: s.source, policy, underClaim, outputs: [row!], failing: [row!], trigger: ["failed_compliance"], shadowAllowed: true, statusFor, prepared, matte });
    expect(seen).toEqual([{ channel: "noon", ctx: expect.objectContaining({ synthesiseShadow: false }) }]);
    const [after] = await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, noon.id));
    expect(autoActionsOf(after!.compliance).map(a => `${a.step}:${a.result}:${a.channels.join()}`)).toEqual(["shadow_off:passed:styli", "shadow_off:passed:noon"]);
  }, 60_000);
});
