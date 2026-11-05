// M0-S3 review P1-1: an output row delivered once and made again in place (an M1-S4 improvement, the operator's Try
// again) is published again at the same URL. Its change log gets a second event from the first version to the new
// one, with the reason of whoever re-made it, and the publish never fails for the log. Tier 2 (PGlite + fakes), the
// same world as the M1-S4 improvement tests, with the product's option on a Trendyol listing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogChangeEvents, catalogChannelListings, catalogContentVersions, catalogOptions, catalogProducts } from "@catalog/core/db/schema";
import { retryEnlargement } from "@catalog/core/catalog/decisions";
import { autoDecideSnapshot } from "@catalog/core/catalog/auto-decide";
import { IMPROVE_FIRST_DELAY_MS } from "@catalog/core/catalog/improve";
import { batchOf, drain, enlargeWorld, outputsOf, seedEnlargeBatch, startChunks, sweep, type EnlargeWorld } from "../../test/enlarge-world";
import { clearImproveProbeCache } from "./improve";
import { enqueueFinalize } from "./deps";
import { handlePublishTask } from "./publish";

let db: Db, close: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV = ["BUCKET", "PUBLIC_BUCKET", "UPSCALE_MAX_PIXELS", "UPSCALE_MAX_PIXELS_X4"];
beforeAll(async () => { for (const k of ENV) saved[k] = process.env[k]; process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; process.env.UPSCALE_MAX_PIXELS = "8000000"; process.env.UPSCALE_MAX_PIXELS_X4 = "6400000"; ({ db, close } = await createTestDb()); }, 60_000);
beforeEach(() => clearImproveProbeCache());
afterAll(async () => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; await close(); });

const only = (s: { batch: { id: string } }) => ({ only: { db, batchId: s.batch.id } });
const eventsOf = (batchId: string) => db.select().from(catalogChangeEvents).where(eq(catalogChangeEvents.batchId, batchId)).orderBy(asc(catalogChangeEvents.seq));

/**
 * An auto-decide batch whose product has an option with a Trendyol listing, run to its end with the upscaler refusing
 * every photo: the slot is delivered as the plain render, `provisional`, and logged once.
 */
async function provisionalBatch(name: string): Promise<EnlargeWorld & { s: Awaited<ReturnType<typeof seedEnlargeBatch>>; listingId: string }> {
  const e = enlargeWorld(db);
  const s = await seedEnlargeBatch(db, e.w, name, [[1]], { channels: ["trendyol"] });
  const [option] = await db.insert(catalogOptions).values({ brandSlug: "test_brand", optionKey: `${name}-opt`, keySource: "master" }).returning();
  const [listing] = await db.insert(catalogChannelListings).values({ optionId: option!.id, channel: "trendyol", market: "ae_sa" }).returning();
  await db.update(catalogProducts).set({ optionId: option!.id }).where(eq(catalogProducts.id, s.chunks[0]!.productIds[0]!));
  await db.update(catalogBatches).set({ options: { ...s.batch.options, autoDecide: await autoDecideSnapshot(db) } }).where(eq(catalogBatches.id, s.batch.id));
  e.service.state.mode = "badInput";
  await startChunks(db, e.w, s.chunks.map((c) => c.id));
  await drain(e.w, only(s));
  e.service.state.mode = "ok";
  expect((await batchOf(db, s.batch.id)).status).toBe("done");
  const events = await eventsOf(s.batch.id);
  expect(events.map((x) => [x.kind, x.reasonKind, x.changeTypeId, x.fromVersionId])).toEqual([["links_delivered", "auto_decide", "img_background_fixed", null]]);
  return { ...e, s, listingId: listing!.id };
}

async function expectRepublished(e: Awaited<ReturnType<typeof provisionalBatch>>, before: { id: string; generation: number | null; contentVersionId: string | null }, reason: { reasonKind: string; actor: string }) {
  const [after] = await outputsOf(db, e.s.batch.id);
  expect(after).toMatchObject({ id: before.id, status: "verified", isLive: true });
  expect(after!.flags).toContain("upscaled");
  expect(after!.generation).not.toBe(before.generation);
  expect(after!.contentVersionId).not.toBe(before.contentVersionId);
  const events = await eventsOf(e.s.batch.id);
  expect(events).toHaveLength(2);
  const second = events[1]!;
  expect(second).toMatchObject({ kind: "links_delivered", listingId: e.listingId, slot: "image:1", fromVersionId: before.contentVersionId, toVersionId: after!.contentVersionId, reasonKind: reason.reasonKind, changeTypeId: "img_upscaled" });
  expect(second.reasonRef).toMatch(/^catalog_product_events:/);
  const [v] = await db.select().from(catalogContentVersions).where(eq(catalogContentVersions.id, after!.contentVersionId!));
  expect(v).toMatchObject({ source: "upscaled", producerRef: before.id });
  // A repeated publish task writes nothing more.
  await handlePublishTask(e.w.deps, { batchId: e.s.batch.id, productId: after!.productId });
  expect(await eventsOf(e.s.batch.id)).toHaveLength(2);
}

describe("M0-S3 review P1-1: a delivered row made again in place is logged and published", () => {
  it("an M1-S4 improvement republishes the upscaled image at the same URL with a second event (auto_decide, img_upscaled)", async () => {
    const e = await provisionalBatch("m0s3-improve");
    const [before] = await outputsOf(db, e.s.batch.id);
    e.clock.tick(IMPROVE_FIRST_DELAY_MS / 60_000);
    await sweep(db, e.w);
    await drain(e.w, only(e.s));
    await expectRepublished(e, before!, { reasonKind: "auto_decide", actor: "auto-improve" });
  }, 600_000);

  it("the operator's Try again on a delivered provisional slot republishes with a second event (operator, img_upscaled)", async () => {
    const e = await provisionalBatch("m0s3-try-again");
    const [before] = await outputsOf(db, e.s.batch.id);
    await retryEnlargement(db, e.w.deps.enqueue, { outputId: before!.id, actor: "op@opptra.com", now: e.clock.now() });
    await enqueueFinalize(e.w.deps, e.s.batch.id, undefined, { reopen: true });
    await drain(e.w, only(e.s));
    await expectRepublished(e, before!, { reasonKind: "operator", actor: "op@opptra.com" });
  }, 600_000);
});
