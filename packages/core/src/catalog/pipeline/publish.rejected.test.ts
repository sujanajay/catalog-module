// Tier 2 (PGlite): M1 D45. A run that rejects a photo for what the image shows takes the older live image at its place down; a
// transient failure keeps it. Only under the product's prefix and on the batch's channels.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { createTestDb } from "../../db/testing";
import { catalogBatches, catalogBatchProducts, catalogChangeEvents, catalogOutputs, catalogProductEvents, catalogProducts, catalogSourceImages, DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import { DEFAULT_AUTO_DECIDE_RULES } from "../auto-decide";
import { FIXTURE_CHANNEL_RULES } from "../channel-rules";
import type { ChannelId, OutputFlag } from "../types";
import { NO_DELIVERABLE_PHOTO_REMOVED, planPublish, publishProduct, type Output, type PublishDeps } from "./publish";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { await close(); });

const HOLD = { auto_decide: { rule: "visible_defect:*", cause: "visible_defect", action: "hold" } };
type Row = { n: number; channel?: ChannelId; status: Output["status"]; flags?: OutputFlag[]; reason?: string; compliance?: unknown };

/** A product an older batch delivered on `liveChannels` with shots 1-3, and a new full batch on `channels` with `rows`. */
async function world(name: string, rows: Row[], options: { channels?: ChannelId[]; liveChannels?: ChannelId[]; append?: boolean } = {}) {
  const channels = options.channels ?? ["noon"], liveChannels = options.liveChannels ?? channels;
  const batchRow = (suffix: string, extra: object = {}) => ({ brandSlug: "anta", brandName: "Anta", name: `${name}${suffix}`, isTest: true, createdBy: "test@opptra.com", ...extra });
  const [old] = await db.insert(catalogBatches).values(batchRow("-old", { channels: liveChannels, status: "done" })).returning();
  const [fresh] = await db.insert(catalogBatches).values(batchRow("-new", { channels, status: "publishing", options: { ...DEFAULT_BATCH_OPTIONS, autoDecide: { rules: [...DEFAULT_AUTO_DECIDE_RULES] }, ...(options.append ? { append: true } : {}) } })).returning();
  const product = async (key: string, lock: string | null) => (await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: key, pathKey: key, identifier: key, lockBatchId: lock, lastBatchId: old!.id }).returning())[0]!;
  const main = await product(name, fresh!.id), sibling = await product(`${name}-sibling`, null);
  await db.insert(catalogBatchProducts).values({ batchId: fresh!.id, productId: main.id, change: "updated" });
  const path = (key: string, c: ChannelId, n: number) => `catalog-test/anta/${key}/${c}/${key}_${n}.jpg`;
  const common = (key: string, productId: string, c: ChannelId, n: number) => ({ productId, channel: c, n, canvasW: 800, canvasH: 1000, scale: 1, placedX: 0, placedY: 0, bytes: 4, objectPath: path(key, c, n), publicUrl: `https://storage.googleapis.com/public/${path(key, c, n)}` });
  for (const [key, id] of [[name, main.id], [`${name}-sibling`, sibling.id]] as const) {
    const sources = await db.insert(catalogSourceImages).values([1, 2, 3].map(n => ({ batchId: old!.id, productId: id, n, sha256: `same${n}`, originalName: `${key}_${n}.jpg`, rawUri: `gs://assets/${key}-old${n}.jpg`, mime: "image/jpeg", isCurrent: true }))).returning();
    await db.insert(catalogOutputs).values(sources.flatMap(s => liveChannels.map(c => ({ ...common(key, id, c, s.n), batchId: old!.id, sourceImageId: s.id, renderKey: `old${s.n}${c}`, crc32c: "o", generation: 20, isLive: true, status: "verified" as const, publishedAt: new Date("2026-01-01T00:00:00Z") }))));
  }
  const sources = await db.insert(catalogSourceImages).values([...new Set(rows.map(r => r.n))].map(n => ({ batchId: fresh!.id, productId: main.id, n, sha256: `same${n}`, originalName: `${name}_${n}.jpg`, rawUri: `gs://assets/${name}-new${n}.jpg`, mime: "image/jpeg" }))).returning();
  await db.insert(catalogOutputs).values(rows.map(r => {
    const c = r.channel ?? channels[0]!;
    return { ...common(name, main.id, c, r.n), batchId: fresh!.id, sourceImageId: sources.find(s => s.n === r.n)!.id, renderKey: `new${r.n}${c}`, crc32c: "crc", stagingUri: `gs://assets/staged-${r.n}-${c}.jpg`, status: r.status, flags: r.flags ?? [], reason: r.reason ?? null, compliance: (r.compliance ?? null) as never, qaScores: { overall: 90 } as never };
  }));
  const jpeg = Buffer.from([255, 216, 255, 0]);
  const deps: PublishDeps = {
    db, now: () => new Date("2026-01-02T00:00:00Z"), sleep: async () => {}, channelRules: async () => FIXTURE_CHANNEL_RULES,
    fetch: vi.fn(async () => new Response(jpeg, { status: 200, headers: { "x-goog-generation": "1", "content-type": "image/jpeg", "content-length": "4" } })),
    storage: {
      getPublicBucketName: () => "public",
      downloadBuffer: async () => ({ buf: jpeg, mime: "image/jpeg" }),
      headObject: async () => ({ exists: false, size: null, contentType: null, generation: null, crc32c: null }),
      stageCopyToPublic: vi.fn(async () => ({ generation: "1", crc32c: "crc" })),
      deletePublicObject: vi.fn(async () => true), setCustomTime: vi.fn(async () => {}),
    },
  };
  const live = async (productId = main.id) => (await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId, productId), eq(catalogOutputs.isLive, true)))).map(o => `${o.channel} ${o.n} ${o.batchId === old!.id ? "old" : "new"}`).sort();
  const deleted = () => vi.mocked(deps.storage.deletePublicObject).mock.calls.map(c => c[0]).sort();
  const publish = () => publishProduct(deps, fresh!.id, main.id);
  return { deps, old: old!, fresh: fresh!, main, sibling, live, deleted, publish, path: (c: ChannelId, n: number) => path(name, c, n) };
}

describe("a rejected photo leaves no older image live (M1 D45)", () => {
  it("a watermark left out takes the older image down, at the link and in the database, with its reason in the version history", async () => {
    const reason = "The image still shows text, a watermark or a logo overlay.";
    const s = await world("r-mark", [{ n: 1, status: "staged" }, { n: 2, status: "skipped", flags: ["text_or_watermark", "auto_dropped"], reason }, { n: 3, status: "staged" }]);
    expect(await s.publish()).toMatchObject({ outcome: "published", changed: true });
    expect(s.deleted()).toEqual([s.path("noon", 2)]);
    expect(await s.live()).toEqual(["noon 1 new", "noon 3 new"]);
    const [gone] = await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, s.old.id), eq(catalogOutputs.productId, s.main.id), eq(catalogOutputs.n, 2)));
    expect(gone).toMatchObject({ isLive: false, status: "skipped", reason: `Removed in batch r-mark-new: ${reason}` });
    const [rejecting] = await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, s.fresh.id), eq(catalogOutputs.n, 2)));
    const events = await db.select().from(catalogChangeEvents).where(and(eq(catalogChangeEvents.productId, s.main.id), eq(catalogChangeEvents.kind, "removed")));
    expect(events).toMatchObject([{ slot: "image:2", channel: "noon", toVersionId: null, reasonKind: "auto_decide", reasonRef: `catalog_outputs:${rejecting!.id}`, evidenceRef: `catalog_outputs:${gone!.id}` }]);
    const [event] = await db.select().from(catalogProductEvents).where(and(eq(catalogProductEvents.productId, s.main.id), eq(catalogProductEvents.kind, "shots_removed")));
    expect(event!.details.removedLinks).toMatchObject([{ channel: "noon", n: 2, reason, rejectedBy: rejecting!.id }]);
  });

  it("a wrong item and a photo held for a person come down too; image 1 held stays until the person decides", async () => {
    const s = await world("r-wrong", [
      { n: 1, status: "needs_attention", flags: ["product_removed"], compliance: HOLD, reason: "Part of the product went missing." },
      { n: 2, status: "skipped", flags: ["different_product", "auto_dropped"], reason: "This photo does not match photo 1." },
      { n: 3, status: "needs_attention", flags: ["halo"], compliance: HOLD, reason: "The edge looks rough." },
    ]);
    await s.publish();
    expect(s.deleted()).toEqual([s.path("noon", 2), s.path("noon", 3)]);
    expect(await s.live()).toEqual(["noon 1 old"]);
  });

  it("a transient failure keeps the existing image: judge down, judge capped, enlargement failed, service down, corrupt file", async () => {
    const s = await world("r-transient", [
      { n: 1, status: "staged" },
      { n: 2, status: "needs_attention", flags: ["qa_unavailable"], reason: "The check could not run." },
      { n: 3, status: "needs_attention", flags: ["enlargement_failed", "halo"], compliance: HOLD, reason: "Could not be enlarged." },
    ]);
    await s.publish();
    expect(s.deleted()).toEqual([]);
    expect(await s.live()).toEqual(["noon 1 new", "noon 2 old", "noon 3 old"]);
    const plan = (flags: OutputFlag[], status: Output["status"] = "skipped") => planPublish({ brandSlug: "anta", pathKey: "A", isTest: false, channels: ["noon"], sources: [{ n: 1 }, { n: 2 }], batchId: "new", live: [slot({ batchId: "old" })], outputs: [slot({ id: "x", batchId: "new", isLive: false, status, flags })] }).deletes;
    for (const flags of [["qa_cap", "auto_dropped"], ["qa_unavailable", "halo", "auto_dropped"], ["fallback_matte", "halo", "auto_dropped"], ["auto_dropped"]] as OutputFlag[][]) expect(plan(flags)).toEqual([]);
    expect(plan([], "failed")).toEqual([]);
    expect(plan(["failed_compliance", "auto_dropped"])).toEqual([]);
    expect(plan(["halo", "auto_dropped"])).toHaveLength(1);
  });

  it("touches neither a sibling product nor a channel outside the batch, and only the rejected channel", async () => {
    const s = await world("r-scope", [
      { n: 1, channel: "noon", status: "staged" }, { n: 1, channel: "amazon", status: "staged" },
      { n: 2, channel: "noon", status: "skipped", flags: ["text_or_watermark", "auto_dropped"], reason: "A mark." }, { n: 2, channel: "amazon", status: "staged" },
      { n: 3, channel: "noon", status: "staged" }, { n: 3, channel: "amazon", status: "staged" },
    ], { channels: ["noon", "amazon"], liveChannels: ["noon", "amazon", "styli"] });
    await s.publish();
    expect(s.deleted()).toEqual([s.path("noon", 2)]);
    const live = await s.live();
    expect(live).not.toContain("noon 2 old");
    expect(live).toEqual(expect.arrayContaining(["amazon 2 new", "styli 1 old", "styli 2 old", "styli 3 old"]));
    expect(await s.live(s.sibling.id)).toEqual(["amazon 1 old", "amazon 2 old", "amazon 3 old", "noon 1 old", "noon 2 old", "noon 3 old", "styli 1 old", "styli 2 old", "styli 3 old"]);
    for (const object of s.deleted()) expect(object).toMatch(/^catalog-test\/anta\/r-scope\/noon\//);
  });

  it("a follow-up batch never takes down another batch's image", async () => {
    const s = await world("r-append", [{ n: 2, status: "skipped", flags: ["text_or_watermark", "auto_dropped"], reason: "A mark." }], { append: true });
    await s.publish();
    expect(s.deleted()).toEqual([]);
  });

  it("with nothing delivered the note says what was taken down", async () => {
    const s = await world("r-nothing", [
      { n: 1, status: "needs_attention", flags: ["qa_unavailable"], reason: "The check could not run." },
      { n: 2, status: "skipped", flags: ["text_or_watermark", "auto_dropped"], reason: "A mark." },
      { n: 3, status: "needs_attention", flags: ["qa_unavailable"], reason: "The check could not run." },
    ]);
    expect((await s.publish()).outcome).toBe("failed");
    expect(s.deleted()).toEqual([s.path("noon", 2)]);
    expect(await s.live()).toEqual(["noon 1 old", "noon 3 old"]);
    const [pair] = await db.select().from(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId, s.fresh.id), eq(catalogBatchProducts.productId, s.main.id)));
    expect(pair!.notes).toContain(NO_DELIVERABLE_PHOTO_REMOVED);
  });

  it("refuses a live object outside the product's prefix, and never deletes where this batch delivers", () => {
    const base = { brandSlug: "anta", pathKey: "A", isTest: false, channels: ["noon"] as ChannelId[], sources: [{ n: 1 }, { n: 2 }], batchId: "new" };
    const rejected = slot({ id: "x", batchId: "new", isLive: false, status: "skipped", flags: ["halo", "auto_dropped"] });
    expect(() => planPublish({ ...base, live: [slot({ batchId: "old", objectPath: "catalog/anta/OTHER/noon/OTHER_2.jpg" })], outputs: [rejected] })).toThrow();
    const remade = slot({ id: "y", batchId: "new", isLive: false, status: "staged" });
    expect(planPublish({ ...base, live: [slot({ batchId: "old" })], outputs: [rejected, remade] }).deletes).toEqual([]);
    const usedAsIs = slot({ id: "z", batchId: "new", isLive: false, status: "staged", flags: ["halo"], decision: "use_as_is" });
    expect(planPublish({ ...base, live: [slot({ batchId: "old" })], outputs: [usedAsIs] }).deletes).toEqual([]);
  });
});

function slot(patch: Partial<Output>): Output {
  return { id: "o", channel: "noon", n: 2, objectPath: "catalog/anta/A/noon/A_2.jpg", generation: 20, status: "verified", decision: null, flags: [], compliance: null, isLive: true, ...patch } as Output;
}
