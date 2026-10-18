// Tier 2 (PGlite): product matching and the overwrite preview (spec 04, "Overwrite preview cases").
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../db/client";
import {
  catalogBatches,
  catalogOutputs,
  catalogProductAliases,
  catalogProducts,
  catalogSourceImages,
  skuMap,
  type CatalogBatch,
} from "../../db/schema";
import { createTestDb } from "../../db/testing";
import { normalizeKey, sanitizeSegment } from "../naming";
import type { BatchStatus, ChannelId } from "../types";
import { buildOverwritePreview, matchProducts } from "./overwrite-preview";
import type { GroupingResult, SourceItem } from "./types";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

async function newBatch(
  name: string,
  opts: { channels?: ChannelId[]; status?: BatchStatus; brandSlug?: string } = {},
): Promise<CatalogBatch> {
  const brandSlug = opts.brandSlug ?? "uspa";
  const [b] = await db
    .insert(catalogBatches)
    .values({ brandSlug, brandName: brandSlug.toUpperCase(), name, channels: opts.channels ?? ["noon"], status: opts.status ?? "draft", createdBy: "op@opptra.com" })
    .returning();
  return b!;
}

/** An existing product with its identifier alias, as findOrCreateProduct would have left it. */
async function seedProduct(identifier: string, opts: { brandSlug?: string; lockBatchId?: string } = {}): Promise<string> {
  const brandSlug = opts.brandSlug ?? "uspa";
  const productKey = normalizeKey(identifier);
  const [p] = await db
    .insert(catalogProducts)
    .values({ brandSlug, productKey, pathKey: sanitizeSegment(identifier), identifier, lockBatchId: opts.lockBatchId ?? null })
    .returning();
  await db.insert(catalogProductAliases).values({ brandSlug, aliasKey: productKey, productId: p!.id, kind: "identifier" });
  return p!.id;
}

/** Current source versions n = 1..k with the given hashes; returns their ids in n order. */
async function seedCurrent(productId: string, batchId: string, shas: string[]): Promise<string[]> {
  const rows = await db
    .insert(catalogSourceImages)
    .values(
      shas.map((sha256, i) => ({
        productId, batchId, n: i + 1, sha256, isCurrent: true, originalName: `${sha256}.jpg`,
        rawUri: `gs://bucket/catalog-test/uspa/${batchId}/raw/${sha256}.jpg`, mime: "image/jpeg", status: "prepared" as const,
      })),
    )
    .returning({ id: catalogSourceImages.id });
  return rows.map((r) => r.id);
}

/** Live outputs for shots 1..sourceIds.length on each channel. */
async function seedLive(productId: string, batchId: string, sourceIds: string[], channels: ChannelId[]): Promise<void> {
  await db.insert(catalogOutputs).values(
    channels.flatMap((channel) =>
      sourceIds.map((sourceImageId, i) => ({
        batchId, productId, sourceImageId, channel, n: i + 1, canvasW: 1080, canvasH: 1480, scale: 1, placedX: 0, placedY: 0,
        renderKey: `rk-${sourceImageId}-${channel}`, objectPath: `catalog-test/uspa/p/${channel}/p_${i + 1}.jpg`,
        publicUrl: `https://storage.googleapis.com/x/catalog-test/uspa/p/${channel}/p_${i + 1}.jpg`, isLive: true, status: "verified" as const,
      })),
    ),
  );
}

/** A previous batch that published a product: current versions plus live outputs. */
async function seedPublished(identifier: string, shas: string[], channels: ChannelId[] = ["noon"]): Promise<string> {
  const earlier = await newBatch(`earlier ${identifier}`, { channels, status: "done" });
  const productId = await seedProduct(identifier);
  const sources = await seedCurrent(productId, earlier.id, shas);
  await seedLive(productId, earlier.id, sources, channels);
  return productId;
}

function item(identifier: string, n: number): SourceItem {
  const name = `${identifier}_${n}.jpg`;
  return {
    identifier, n, suffix: "", originalName: name, folder: null, sheetIdentifier: null, ext: "jpg",
    bytes: { kind: "gcs", gsUri: `gs://bucket/catalog-test/uspa/b/uploads/u1/${name}` }, uploadId: "u1", origin: "image", warnings: [],
  };
}

/** A grouping of products, each with its items' hashes in shot order. */
function grouping(products: Record<string, string[]>): { grouped: GroupingResult; sha256ByItem: Map<SourceItem, string> } {
  const sha256ByItem = new Map<SourceItem, string>();
  const map = new Map<string, SourceItem[]>();
  for (const [identifier, shas] of Object.entries(products)) {
    const items = shas.map((sha, i) => {
      const it = item(identifier, i + 1);
      sha256ByItem.set(it, sha);
      return it;
    });
    map.set(identifier, items);
  }
  return { grouped: { products: map, rejected: [], warnings: [] }, sha256ByItem };
}

async function preview(batch: CatalogBatch, products: Record<string, string[]>) {
  const { grouped, sha256ByItem } = grouping(products);
  const matches = await matchProducts(db, batch, [...grouped.products.keys()]);
  const result = await buildOverwritePreview(db, batch, grouped, matches, sha256ByItem);
  return { result, grouped, matches };
}

const sha = (s: string): string => s.padEnd(64, "0");

describe("matchProducts", () => {
  it("matches by alias, by the resolved option id, or not at all, and never writes", async () => {
    const batch = await newBatch("match");
    const byAlias = await seedProduct("MATCH-ALIAS-1");
    const byOption = await seedProduct("MATCH OPT BLUE");
    await db.insert(skuMap).values({
      opptraSku: "MATCH_OPT_BLUE_40", brand: "USPA", brandSlug: "uspa", line: "softline", source: "warehouse",
      optionKey: "MATCHOPTBLUE", optionIdStyleColor: "MATCH OPT BLUE", ean: "8680000000017",
    });
    const before = { products: (await db.select().from(catalogProducts)).length, aliases: (await db.select().from(catalogProductAliases)).length };

    const matches = await matchProducts(db, batch, ["match_alias_1", "8680000000017", "Brand New 7", "match_alias_1"]);
    expect(matches).toEqual([
      { identifier: "match_alias_1", productId: byAlias, pathKey: "MATCH-ALIAS-1", isNew: false, matchedBy: "alias" },
      { identifier: "8680000000017", productId: byOption, pathKey: "MATCH_OPT_BLUE", isNew: false, matchedBy: "option_key" },
      { identifier: "Brand New 7", productId: null, pathKey: "Brand_New_7", isNew: true, matchedBy: null },
      { identifier: "match_alias_1", productId: byAlias, pathKey: "MATCH-ALIAS-1", isNew: false, matchedBy: "alias" },
    ]);
    expect((await db.select().from(catalogProducts)).length).toBe(before.products);
    expect((await db.select().from(catalogProductAliases)).length).toBe(before.aliases);
  });

  it("keeps brands and test products apart", async () => {
    await seedProduct("SEP-BRAND-1", { brandSlug: "penti" });
    const batch = await newBatch("sep", { brandSlug: "uspa" });
    const [m] = await matchProducts(db, batch, ["SEP-BRAND-1"]);
    expect(m).toMatchObject({ isNew: true, productId: null });
  });
});

describe("buildOverwritePreview", () => {
  it("fewer shots: shotsToRemove lists the live shots not in the upload", async () => {
    await seedPublished("FEW1", [sha("f1"), sha("f2"), sha("f3"), sha("f4"), sha("f5")]);
    const batch = await newBatch("fewer");
    const { result } = await preview(batch, { FEW1: [sha("f1"), sha("f2"), sha("g3")] });
    expect(result.newProducts).toBe(0);
    expect(result.existingProducts).toEqual([
      { identifier: "FEW1", liveShots: [1, 2, 3, 4, 5], uploadShots: [1, 2, 3], shotsToRemove: [4, 5], channels: ["noon"] },
    ]);
    expect(result.renameHints).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.busy).toEqual([]);
  });

  it("more shots: nothing to remove", async () => {
    await seedPublished("MORE1", [sha("m1"), sha("m2")]);
    const batch = await newBatch("more");
    const { result } = await preview(batch, { MORE1: [sha("m1"), sha("m2"), sha("m3"), sha("m4")] });
    expect(result.existingProducts).toEqual([
      { identifier: "MORE1", liveShots: [1, 2], uploadShots: [1, 2, 3, 4], shotsToRemove: [], channels: ["noon"] },
    ]);
  });

  it("reorder: the same photos in a different order remove nothing and give no hint", async () => {
    await seedPublished("ORD1", [sha("o1"), sha("o2"), sha("o3")]);
    const batch = await newBatch("reorder");
    const { result } = await preview(batch, { ORD1: [sha("o3"), sha("o1"), sha("o2")] });
    expect(result.existingProducts).toEqual([
      { identifier: "ORD1", liveShots: [1, 2, 3], uploadShots: [1, 2, 3], shotsToRemove: [], channels: ["noon"] },
    ]);
    expect(result.renameHints).toEqual([]);
    expect(result.newProducts).toBe(0);
  });

  it("rename: a new identifier with the same photos as an existing product of the brand gives one hint", async () => {
    await seedPublished("OLD-NAME-1", [sha("r1"), sha("r2")]);
    // The same photos under another brand never count.
    const other = await newBatch("penti earlier", { brandSlug: "penti", status: "done" });
    const pentiProduct = await seedProduct("PENTI-SAME-1", { brandSlug: "penti" });
    await seedCurrent(pentiProduct, other.id, [sha("r1"), sha("r2")]);

    const batch = await newBatch("rename");
    const { result } = await preview(batch, {
      "NEW-NAME-1": [sha("r2"), sha("r1")],
      "PARTIAL-1": [sha("r1")],
    });
    expect(result.newProducts).toBe(2);
    expect(result.existingProducts).toEqual([]);
    expect(result.renameHints).toEqual([{ newIdentifier: "NEW-NAME-1", existingIdentifier: "OLD-NAME-1" }]);
  });

  it("two spellings of one product in a batch: one duplicates entry and both rejected", async () => {
    await seedPublished("DUP123", [sha("d1")]);
    const batch = await newBatch("dup");
    const { result, grouped } = await preview(batch, {
      "DUP-123": [sha("d1")],
      DUP123: [sha("d1"), sha("d2")],
      "FRESH-9": [sha("n1")],
      fresh_9: [sha("n2")],
      KEEP1: [sha("k1")],
    });
    expect(result.duplicates).toEqual([
      { a: "DUP-123", b: "DUP123" },
      { a: "FRESH-9", b: "fresh_9" },
    ]);
    expect([...grouped.products.keys()]).toEqual(["KEEP1"]);
    expect(grouped.rejected.map((r) => [r.item.identifier, r.reason])).toEqual([
      ["DUP-123", "DUP-123 and DUP123 are the same product. Keep one."],
      ["DUP123", "DUP-123 and DUP123 are the same product. Keep one."],
      ["DUP123", "DUP-123 and DUP123 are the same product. Keep one."],
      ["FRESH-9", "FRESH-9 and fresh_9 are the same product. Keep one."],
      ["fresh_9", "FRESH-9 and fresh_9 are the same product. Keep one."],
    ]);
    // The rejected spellings are neither new nor overwritten.
    expect(result.newProducts).toBe(1);
    expect(result.existingProducts).toEqual([]);
  });

  it("busy: a product locked by another unfinished batch is listed with that batch's name", async () => {
    const holder = await newBatch("USPA week 41", { status: "matting" });
    const finished = await newBatch("USPA week 40", { status: "done" });
    const batch = await newBatch("busy");
    await seedProduct("BUSY1", { lockBatchId: holder.id });
    await seedProduct("STALE1", { lockBatchId: finished.id });
    await seedProduct("MINE1", { lockBatchId: batch.id });
    await seedProduct("FREE1");
    const { result } = await preview(batch, { BUSY1: [sha("b1")], STALE1: [sha("s1")], MINE1: [sha("x1")], FREE1: [sha("e1")] });
    expect(result.busy).toEqual([{ identifier: "BUSY1", batchName: "USPA week 41" }]);
    expect(result.existingProducts.map((p) => p.identifier)).toEqual(["BUSY1", "FREE1", "MINE1", "STALE1"]);
  });

  it("channels not selected in the batch do not count towards liveShots", async () => {
    const earlier = await newBatch("earlier CH1", { channels: ["noon", "styli"], status: "done" });
    const productId = await seedProduct("CH1");
    const sources = await seedCurrent(productId, earlier.id, [sha("c1"), sha("c2"), sha("c3"), sha("c4"), sha("c5")]);
    await seedLive(productId, earlier.id, sources.slice(0, 3), ["noon"]);
    await seedLive(productId, earlier.id, sources, ["styli"]);
    // A non-live (superseded) row on a selected channel does not count either.
    await db.insert(catalogOutputs).values({
      batchId: earlier.id, productId, sourceImageId: sources[4]!, channel: "noon", n: 5, canvasW: 1080, canvasH: 1480, scale: 1,
      placedX: 0, placedY: 0, renderKey: "rk-old", objectPath: "catalog-test/uspa/CH1/noon/CH1_5.jpg",
      publicUrl: "https://storage.googleapis.com/x/catalog-test/uspa/CH1/noon/CH1_5.jpg", isLive: false, status: "verified",
    });

    const noonOnly = await newBatch("noon only", { channels: ["noon"] });
    const { result } = await preview(noonOnly, { CH1: [sha("c1"), sha("c2"), sha("c3")] });
    expect(result.existingProducts).toEqual([
      { identifier: "CH1", liveShots: [1, 2, 3], uploadShots: [1, 2, 3], shotsToRemove: [], channels: ["noon"] },
    ]);

    const withStyli = await newBatch("noon and styli", { channels: ["noon", "styli"] });
    const both = await preview(withStyli, { CH1: [sha("c1"), sha("c2"), sha("c3")] });
    expect(both.result.existingProducts[0]).toMatchObject({ liveShots: [1, 2, 3, 4, 5], shotsToRemove: [4, 5], channels: ["noon", "styli"] });

    const none = await newBatch("no channels yet", { channels: [] });
    const empty = await preview(none, { CH1: [sha("c1")] });
    expect(empty.result.existingProducts[0]).toMatchObject({ liveShots: [], shotsToRemove: [] });
  });

  it("refuses a grouping with an identifier that was never matched", async () => {
    const batch = await newBatch("unmatched");
    const { grouped, sha256ByItem } = grouping({ LOST1: [sha("l1")] });
    await expect(buildOverwritePreview(db, batch, grouped, [], sha256ByItem)).rejects.toThrow(/No product match was computed for LOST1/);
  });
});
