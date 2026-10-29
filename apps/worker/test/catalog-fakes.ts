// Test support for spec 16 (throughput.test.ts, scale.test.ts): in-memory storage, fake cut-out, render and
// judge services with a small real delay (so parallel photos really interleave), two FIFO task queues, and a
// seeded batch. Never a network call.
import { vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogProducts, catalogSourceImages, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import * as storage from "@catalog/core/storage";
import type { ChannelId } from "@catalog/core/catalog/types";
import type { EnqueueTaskOptions, TaskRoute } from "@catalog/core/tasks";
import { workerCatalogDeps, type CatalogDeps } from "../src/catalog/deps";

export interface QueuedTask { route: TaskRoute; taskId: string; body: Record<string, unknown>; bulk: boolean; retryCount: number }

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fakes around the real worker deps. `delayMs` is the real wait inside each fake service call. `imageScale` shrinks
 * the fake photos (default full size, about 600 x 800): the real cut-out checks scan every pixel on the one test
 * thread, so the scale test uses small photos to drain thousands of them in minutes.
 */
export function fakeWorld(db: Db, delayMs = 1, options: { imageScale?: number } = {}) {
  const scale = options.imageScale ?? 1;
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, number>();
  // Spec 18: the custom metadata uploadBuffer wrote (the stored enlargement names its source and upscaler).
  const metadata = new Map<string, Record<string, string>>();
  const tasks: QueuedTask[] = [], names = new Set<string>();
  const log = vi.fn<CatalogDeps["log"]>();
  let inMatte = 0, peakMatte = 0;
  const base = workerCatalogDeps(db);
  const enqueue = vi.fn(async (route: TaskRoute, body: Record<string, unknown>, opts: EnqueueTaskOptions = {}) => {
    // Cloud Tasks refuses a name that exists or ran recently; enqueueTask treats that as success.
    if (opts.taskId && names.has(opts.taskId)) return opts.taskId;
    if (opts.taskId) names.add(opts.taskId);
    tasks.push({ route, taskId: opts.taskId ?? `anon-${tasks.length}`, body, bulk: !!opts.bulk, retryCount: 0 });
    return opts.taskId ?? "task";
  });
  const deps: CatalogDeps = {
    ...base, sleep: async () => {}, now: () => new Date(), log, enqueue: enqueue as unknown as CatalogDeps["enqueue"], heartbeat: () => () => {},
    resolvePolicy: vi.fn<CatalogDeps["resolvePolicy"]>(async () => ({ matteModel: "fixture", qaModel: "test/judge", threshold: 75, floor: 60, qaMode: "per_source", qaSampleRate: 1, source: "default" })),
    storage: { ...storage, getBucketName: () => "assets", getPublicBucketName: () => "public",
      uploadBuffer: async (path: string, buf: Buffer, _mime: string, opts: { metadata?: Record<string, string> } = {}) => { const uri = `gs://assets/${path}`; objects.set(uri, buf); uploads.set(uri, (uploads.get(uri) ?? 0) + 1); if (opts.metadata) metadata.set(uri, opts.metadata); else metadata.delete(uri); return uri; },
      downloadBuffer: async (uri: string) => { await pause(delayMs); const buf = objects.get(uri); if (!buf) throw new Error(`No object ${uri}`); return { buf, mime: "image/jpeg" }; },
      headObject: async (uri: string) => { const buf = objects.get(uri), meta = metadata.get(uri); return buf ? { exists: true, size: buf.length, contentType: "image/jpeg", generation: "1", crc32c: "c", ...(meta ? { metadata: meta } : {}) } : { exists: false, size: null, contentType: null, generation: null, crc32c: null }; } } as unknown as CatalogDeps["storage"],
    matting: { ...base.matting, health: vi.fn(async () => ({ ok: true, models: [{ id: "fixture", inputSize: 1024, target: "cpu" }], default: "fixture", versions: { cpu: null, gpu: null } })), convert: base.matting.convert.bind(base.matting) } as unknown as CatalogDeps["matting"],
    // Each photo has its own size (from its fourth byte), so a product plan that misses a photo would differ.
    prepare: vi.fn(async (buf: Buffer) => { await pause(delayMs); if (buf[3] === 0xee) { const { UnsupportedSourceError } = await import("@catalog/core/catalog/render"); throw new UnsupportedSourceError("corrupt"); } const width = Math.round((600 + (buf[3] ?? 0) * 4) * scale), height = Math.round(800 * scale); return { width, height, rgb: Buffer.alloc(width * height * 3, 128), alphaSource: null, background: { uniform: true, color: [255, 255, 255] as [number, number, number], stdev: 0 }, flags: [], sourceMime: "image/jpeg" }; }) as unknown as CatalogDeps["prepare"],
    matteFor: vi.fn<CatalogDeps["matteFor"]>(async (p) => { inMatte += 1; peakMatte = Math.max(peakMatte, inMatte); try { await pause(delayMs * 2); } finally { inMatte -= 1; } return { alpha: Buffer.alloc(p.width * p.height, 255), width: p.width, height: p.height, model: "fixture", ms: 12, source: "model", target: "cpu", sentLongSide: 800 }; }),
    renderAllChannels: vi.fn<CatalogDeps["renderAllChannels"]>(async (p, _m, channels, ctx) => { await pause(delayMs); return Object.fromEntries(channels.map((channel) => [channel, { jpeg: Buffer.from([255, 216, 255, p.width % 251]), status: "ok", plan: { w: ctx?.canvas?.w ?? p.width, h: ctx?.canvas?.h ?? p.height, lowResolution: false, safeBox: { x: 0, y: 0, w: 1, h: 1 }, scale: ctx?.uniformScale ?? 1, placedX: (ctx?.canvas?.w ?? 0) - p.width, placedY: 0, detailShot: false }, quality: 90, bytes: 4, flags: [], notes: [], attention: null, compliance: { ok: true, failures: [] } }])) as unknown as Awaited<ReturnType<CatalogDeps["renderAllChannels"]>>; }),
    judgeOutput: vi.fn<CatalogDeps["judgeOutput"]>(async (input) => { await pause(delayMs); return { scores: { complete_product: 95, same_product: 95, edge_quality: 95, background_clean: 95, no_text_or_watermark: 95, orientation_ok: 95, product_intact: 95, placement_ok: 95, overall: 95 }, verdict: "pass", reasons: [], isCollage: false, costUsd: 0, calls: 0, usage: {}, model: input.model, flags: [] }; }),
  };
  const deliveries = (outcome?: string) => log.mock.calls.filter(([message, fields]) => message === "chunk delivery" && (!outcome || fields?.outcome === outcome)).map(([, fields]) => fields!);
  return { deps, objects, uploads, metadata, tasks, log, enqueue, deliveries, peakMatte: () => peakMatte };
}
export type FakeWorld = ReturnType<typeof fakeWorld>;

/**
 * One batch in "matting" with its chunks queued (not yet dispatched). `layout` lists each chunk's products' photo
 * counts; `corrupt` names photo numbers (1-based) whose raw bytes fail to decode.
 */
export async function seedBatch(db: Db, w: FakeWorld, name: string, layout: number[][], options: { channels?: ChannelId[]; corrupt?: number[] } = {}) {
  const channels = options.channels ?? ["noon"];
  const photos = layout.flat().reduce((a, b) => a + b, 0);
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name, isTest: true, createdBy: "t@opptra.com", status: "matting", productType: "footwear", channels, startedAt: new Date(), counts: { ...EMPTY_BATCH_COUNTS, products: layout.flat().length, sources: photos, outputs: photos * channels.length } }).returning();
  const chunks: (typeof catalogChunks.$inferSelect)[] = [];
  let p = 0;
  for (const [index, group] of layout.entries()) {
    const productIds: string[] = [];
    for (const shots of group) {
      const key = `${name.replace(/[^a-z0-9]+/gi, "-")}-${p++}`;
      const [product] = await db.insert(catalogProducts).values({ brandSlug: "test_brand", isTest: true, productKey: key, pathKey: key, identifier: key, productType: "footwear", lockBatchId: batch!.id }).returning();
      await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId: product!.id, change: "new" });
      for (let n = 1; n <= shots; n++) {
        const rawUri = await w.deps.storage.uploadBuffer(`catalog-test/test_brand/${batch!.id}/raw/${key}/${n}.jpg`, Buffer.from([255, 216, 255, options.corrupt?.includes(n) ? 0xee : n * 3]), "image/jpeg");
        await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: product!.id, n, sha256: `${key}-${n}`, originalName: `${key}_${n}.jpg`, rawUri, mime: "image/jpeg", width: 800, height: 800 });
      }
      productIds.push(product!.id);
    }
    const [chunk] = await db.insert(catalogChunks).values({ batchId: batch!.id, index, stage: "matte", status: "queued", attempt: 0, productIds }).returning();
    chunks.push(chunk!);
  }
  return { batch: batch!, chunks };
}

export const chunkRow = async (db: Db, id: string) => (await db.select().from(catalogChunks).where(eq(catalogChunks.id, id)))[0]!;
