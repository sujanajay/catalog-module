import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { createTestDb } from "../db/testing";
import { brandMaster, catalogBatches, catalogBatchProducts, catalogChunks, catalogOutputs, catalogProductAliases, catalogProductEvents, catalogProducts, catalogSourceImages, skuMap } from "../db/schema";
import { applyDecision, applySkuMap, completeReplacement, decisionScope, startReplacement, type ReplacementDeps } from "./decisions";
import type { ChannelId, OutputFlag } from "./types";

let db: Db, close: () => Promise<void>, sequence = 0;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(brandMaster).values({ name: "Anta", slug: "anta", line: "softline", source: "manual" });
}, 60_000);
afterAll(async () => { await close(); });
async function seed(flags: OutputFlag[] = ["halo"], statuses = ["needs_attention", "needs_attention"]) {
  const name = `decision-${++sequence}`;
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name, isTest: true, createdBy: "operator@opptra.com", channels: ["noon", "styli"] }).returning();
  const [product] = await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, identifier: name, productKey: name, pathKey: name, opptraSkuIds: ["OLD"], lockBatchId: batch!.id }).returning();
  await db.insert(catalogBatchProducts).values({ batchId: batch!.id, productId: product!.id, change: "pending_attention" });
  await db.insert(catalogProductAliases).values({ brandSlug: "anta", isTest: true, productId: product!.id, aliasKey: name.replaceAll("-", "").toUpperCase(), kind: "identifier" });
  const [source] = await db.insert(catalogSourceImages).values({ batchId: batch!.id, productId: product!.id, n: 1, sha256: "original", rawUri: `gs://private/catalog-test/anta/${batch!.id}/raw/${name}/${name}_1.jpg`, originalName: "original.jpg", mime: "image/jpeg", isCurrent: true }).returning();
  const outputs = await db.insert(catalogOutputs).values((["noon", "styli"] as ChannelId[]).map((channel, i) => ({ batchId: batch!.id, productId: product!.id, sourceImageId: source!.id, channel, n: 1, canvasW: 800, canvasH: 1000, scale: 1, placedX: 0, placedY: 0, renderKey: `${name}-${channel}`, objectPath: `${name}/${channel}.jpg`, publicUrl: `https://example.com/${name}/${channel}.jpg`, status: statuses[i] as "needs_attention" | "failed" | "verified", flags, reason: "The edge looks rough.", stagingUri: statuses[i] === "failed" ? null : "gs://private/staging.jpg" }))).returning();
  return { batch: batch!, product: product!, source: source!, outputs };
}
const actor = "operator@opptra.com", now = new Date("2026-10-19T01:00:00Z");
it("scopes shared photo decisions across channels and rejects a repeated decision", async () => {
  const s = await seed();
  expect(decisionScope(s.outputs[0]!, s.outputs).map(o => o.id)).toEqual(s.outputs.map(o => o.id));
  const result = await applyDecision(db, { outputId: s.outputs[0]!.id, decision: "use_as_is", actor, now });
  expect(result.outputIds.sort()).toEqual(s.outputs.map(o => o.id).sort());
  const rows = await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, s.batch.id));
  expect(rows.every(o => o.status === "staged" && o.decision === "use_as_is" && o.decidedBy === actor && o.decidedAt?.getTime() === +now && o.flags.includes("halo") && o.reason === "The edge looks rough.")).toBe(true);
  await expect(applyDecision(db, { outputId: s.outputs[1]!.id, decision: "remove", actor })).rejects.toMatchObject({ status: 409, message: "Already decided." });
});
it("limits channel-only decisions but mixed flags affect all undecided siblings", async () => {
  const s = await seed(["placement"]);
  expect(decisionScope(s.outputs[1]!, s.outputs).map(o => o.id)).toEqual([s.outputs[1]!.id]);
  await applyDecision(db, { outputId: s.outputs[1]!.id, decision: "remove", actor });
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, s.outputs[0]!.id)))[0]!.decision).toBeNull();
  const [event] = await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId, s.batch.id));
  expect(event).toMatchObject({ kind: "removed_photo", actor, details: { n: 1, channels: ["styli"] } });
  const mixed = await seed(["placement", "halo"]);
  expect(decisionScope(mixed.outputs[1]!, mixed.outputs)).toHaveLength(2);
});
it("ignores information flags when scoping a Styli-only placement removal", async () => {
  const s = await seed(["placement", "shadow_synthesised"], ["needs_attention", "needs_attention"]);
  await db.update(catalogOutputs).set({ flags: ["failed_compliance"] }).where(eq(catalogOutputs.id, s.outputs[0]!.id));
  const result = await applyDecision(db, { outputId: s.outputs[1]!.id, decision: "remove", actor });
  expect(result.outputIds).toEqual([s.outputs[1]!.id]);
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, s.outputs[0]!.id)))[0]!).toMatchObject({ decision: null, status: "needs_attention" });
});
it("refuses use-as-is atomically when a scoped photo failed", async () => {
  const s = await seed(["halo"], ["needs_attention", "failed"]);
  await expect(applyDecision(db, { outputId: s.outputs[0]!.id, decision: "use_as_is", actor })).rejects.toMatchObject({ status: 400, message: "Nothing was made from this photo. Remove it or replace it." });
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, s.batch.id))).every(o => o.decision === null)).toBe(true);
});
async function storageWorld() {
  const buf = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#808080" } }).jpeg().toBuffer();
  const storage: ReplacementDeps["storage"] = {
    getBucketName: () => "private",
    signedPutUrl: vi.fn(async () => "https://example.com/signed-put"),
    headObject: vi.fn(async () => ({ exists: true, size: buf.length, contentType: "image/jpeg", generation: "1", crc32c: "crc" })),
    downloadBuffer: vi.fn(async () => ({ buf, mime: "image/jpeg" })),
    uploadBuffer: vi.fn(async (path: string) => `gs://private/${path}`),
  };
  return { deps: { db, storage, now: () => now } satisfies ReplacementDeps, storage, buf };
}
it("records a scoped replacement upload, preserves originals, and queues exactly one source", async () => {
  const s = await seed(), w = await storageWorld();
  const upload = await startReplacement(w.deps, { outputId: s.outputs[0]!.id, name: "new.jpg", size: w.buf.length, mime: "image/jpeg" });
  expect(upload.signedPutUrl).toBe("https://example.com/signed-put");
  expect(w.storage.signedPutUrl).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^catalog-test/anta/${s.batch.id}/uploads/replacements-`)), "image/jpeg");
  const result = await completeReplacement(w.deps, { outputId: s.outputs[0]!.id, uploadId: upload.uploadId, actor });
  const [source] = await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.id, result.sourceImageId));
  expect(source).toMatchObject({ batchId: s.batch.id, productId: s.product.id, n: 1, replacesId: s.source.id, isCurrent: false, status: "prepared", bytes: w.buf.length });
  expect(source!.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(source!.rawUri).not.toBe(s.source.rawUri);
  expect((await db.select().from(catalogSourceImages).where(eq(catalogSourceImages.id, s.source.id)))[0]!.rawUri).toBe(s.source.rawUri);
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, s.batch.id))).every(o => o.decision === "replaced" && o.status === "skipped" && o.reason === "Replaced by a new photo")).toBe(true);
  const [chunk] = await db.select().from(catalogChunks).where(eq(catalogChunks.id, result.chunkId));
  expect(chunk).toMatchObject({ stage: "matte", status: "queued", productIds: [s.product.id], sourceImageIds: [source!.id] });
  expect((await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId, s.batch.id)))[0]).toMatchObject({ kind: "replacement_uploaded", actor, details: { n: 1, oldSha256: "original", newSha256: source!.sha256 } });
  await expect(completeReplacement(w.deps, { outputId: s.outputs[0]!.id, uploadId: upload.uploadId, actor })).rejects.toMatchObject({ status: 409 });
  expect(await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, s.batch.id))).toHaveLength(1);
});
it("rejects another photo's replacement upload and an incomplete PUT", async () => {
  const a = await seed(), b = await seed(), w = await storageWorld();
  const upload = await startReplacement(w.deps, { outputId: a.outputs[0]!.id, name: "new.jpg", size: w.buf.length, mime: "image/jpeg" });
  await expect(completeReplacement(w.deps, { outputId: b.outputs[0]!.id, uploadId: upload.uploadId, actor })).rejects.toMatchObject({ status: 400 });
  vi.mocked(w.storage.headObject).mockResolvedValueOnce({ exists: false, size: null, contentType: null, generation: null, crc32c: null });
  await expect(completeReplacement(w.deps, { outputId: a.outputs[0]!.id, uploadId: upload.uploadId, actor })).rejects.toMatchObject({ status: 400 });
  expect(w.storage.uploadBuffer).not.toHaveBeenCalled();
});
it("refuses replacement names that are only dots or separators", async () => {
  const a = await seed(), w = await storageWorld();
  for (const name of ["..", "../..", " / "]) await expect(startReplacement(w.deps, { outputId: a.outputs[0]!.id, name, size: w.buf.length, mime: "image/jpeg" })).rejects.toMatchObject({ status: 400 });
  expect(w.storage.signedPutUrl).not.toHaveBeenCalled();
});
it("adds normalized alias matches, semicolon ids and manual master mappings without rerendering", async () => {
  const s = await seed();
  await db.insert(brandMaster).values({ name: "Anta", slug: "anta", line: "softline", source: "manual" }).onConflictDoNothing();
  const rows = [["unicommerce", "style"], ["NEW-1; NEW-2; NEW-1", s.product.identifier.toUpperCase().replaceAll("-", "_")], ["NEW-2", s.product.identifier], ["IGNORED", "missing-style"]];
  expect(await applySkuMap(db, { batchId: s.batch.id, rows, actor, now })).toEqual({ added: 2, matched: 1, unmatched: ["MISSINGSTYLE"] });
  expect((await db.select().from(catalogProducts).where(eq(catalogProducts.id, s.product.id)))[0]!.opptraSkuIds).toEqual(["NEW-1", "NEW-2", "OLD"]);
  const master = await db.select().from(skuMap);
  expect(master.filter(m => m.opptraSku.startsWith("NEW-"))).toHaveLength(2);
  expect(master.find(m => m.opptraSku === "NEW-1")).toMatchObject({ brandSlug: "anta", brand: "Anta", source: "manual", line: "softline", optionKey: s.product.identifier.replaceAll("-", "").toUpperCase() });
  const events = await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId, s.batch.id));
  expect(events.filter(e => e.kind === "alias_added")).toHaveLength(2);
  expect(events.filter(e => e.kind === "sku_ids_added")).toHaveLength(1);
  expect(await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, s.batch.id))).toHaveLength(0);
  expect((await applySkuMap(db, { batchId: s.batch.id, rows, actor })).added).toBe(0);
});


it("rolls back SKU additions when an id is already an alias of another product", async () => {
  const s = await seed(), other = await seed();
  await db.insert(catalogProductAliases).values({ brandSlug: "anta", isTest: true, productId: other.product.id, aliasKey: "TAKENID", kind: "opptra_sku" });
  await expect(applySkuMap(db, { batchId: s.batch.id, rows: [["identifier", "product_code"], [s.product.identifier, "NEW-GOOD;TAKEN-ID"]], actor })).rejects.toMatchObject({ status: 409 });
  expect((await db.select().from(catalogProducts).where(eq(catalogProducts.id, s.product.id)))[0]!.opptraSkuIds).toEqual(["OLD"]);
  expect(await db.select().from(catalogProductEvents).where(eq(catalogProductEvents.batchId, s.batch.id))).toHaveLength(0);
  expect((await db.select().from(skuMap)).some(row => row.opptraSku === "NEW-GOOD")).toBe(false);
});
it("refuses decisions when another batch owns the product and rejects unreadable replacement bytes", async () => {
  const s = await seed(), other = await seed(), w = await storageWorld();
  await db.update(catalogProducts).set({ lockBatchId: other.batch.id }).where(eq(catalogProducts.id, s.product.id));
  await expect(applyDecision(db, { outputId: s.outputs[0]!.id, decision: "remove", actor })).rejects.toMatchObject({ status: 409 });
  expect((await db.select().from(catalogOutputs).where(eq(catalogOutputs.id, s.outputs[0]!.id)))[0]!.decision).toBeNull();
  await db.update(catalogProducts).set({ lockBatchId: s.batch.id }).where(eq(catalogProducts.id, s.product.id));
  const corrupt = Buffer.from("not a photo");
  const upload = await startReplacement(w.deps, { outputId: s.outputs[0]!.id, name: "bad.jpg", size: corrupt.length, mime: "image/jpeg" });
  vi.mocked(w.storage.headObject).mockResolvedValue({ exists: true, size: corrupt.length, contentType: "image/jpeg", generation: "1", crc32c: "crc" });
  vi.mocked(w.storage.downloadBuffer).mockResolvedValue({ buf: corrupt, mime: "image/jpeg" });
  await expect(completeReplacement(w.deps, { outputId: s.outputs[0]!.id, uploadId: upload.uploadId, actor })).rejects.toMatchObject({ status: 400 });
  expect(w.storage.uploadBuffer).not.toHaveBeenCalled();
  expect(await db.select().from(catalogChunks).where(eq(catalogChunks.batchId, s.batch.id))).toHaveLength(0);
});

