import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { catalogBatches, catalogProductAliases, catalogProductEvents, catalogProducts } from "../db/schema";
import { createTestDb } from "../db/testing";
import { addAlias, findOrCreateProduct, lockProducts, recordEvent, releaseLocks } from "./products";
import type { ResolveResult } from "./sku-mapping";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});

afterAll(async () => {
  await close();
});

async function newBatch(name: string): Promise<string> {
  const [b] = await db.insert(catalogBatches).values({ brandSlug: "uspa", brandName: "USPA", name, createdBy: "op@opptra.com" }).returning();
  return b!.id;
}

async function events(productId: string) {
  return db.select().from(catalogProductEvents).where(eq(catalogProductEvents.productId, productId));
}

const actor = "op@opptra.com";

describe("findOrCreateProduct", () => {
  it("treats ABC-123 and abc_123 as the same product and keeps the first path_key", async () => {
    const first = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "ABC-123", skus: null, actor });
    expect(first.isNew).toBe(true);
    expect(first.product).toMatchObject({ productKey: "ABC123", pathKey: "ABC-123", identifier: "ABC-123" });
    const second = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "abc_123", skus: null, actor });
    expect(second.isNew).toBe(false);
    expect(second.product.id).toBe(first.product.id);
    expect(second.product.pathKey).toBe("ABC-123");
    expect((await events(first.product.id)).map((e) => e.kind)).toEqual(["created"]);
  });

  it("refuses an identifier whose path would be empty or shared with another product", async () => {
    await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "PATH1", skus: null, actor });
    await expect(findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "PATH(1)", skus: null, actor })).rejects.toThrow(
      '"PATH(1)" would share image links with PATH1.',
    );
    await expect(findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "日本", skus: null, actor })).rejects.toThrow(
      /no plain letters or digits/,
    );
    await expect(findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "..", skus: null, actor })).rejects.toThrow(
      /no plain letters or digits/,
    );
  });

  it("keeps test and real products and brands apart", async () => {
    const real = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "SEP-1", skus: null, actor });
    const test = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: true, identifier: "SEP-1", skus: null, actor });
    const other = await findOrCreateProduct(db, { brandSlug: "penti", isTest: false, identifier: "SEP-1", skus: null, actor });
    expect(new Set([real.product.id, test.product.id, other.product.id]).size).toBe(3);
  });

  it("lands an identifier matching a resolved option_id alias on the existing product", async () => {
    const skus: ResolveResult = { optionIdStyleColor: "5F NUPI JR GLB 5PR BLUE OD", opptraSkuIds: ["SKU_38", "SKU_39"], method: "option_key" };
    const created = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "5F NUPI JR GLB 5PR BLUE OD", skus, actor });
    expect(created.isNew).toBe(true);
    expect(created.product.opptraSkuIds).toEqual(["SKU_38", "SKU_39"]);
    expect(created.product.pathKey).toBe("5F_NUPI_JR_GLB_5PR_BLUE_OD");

    // A barcode-named upload resolved to the same option.
    const viaOption = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "8684626830429", skus, actor });
    expect(viaOption.isNew).toBe(false);
    expect(viaOption.product.id).toBe(created.product.id);

    const aliases = await db.select().from(catalogProductAliases).where(eq(catalogProductAliases.productId, created.product.id));
    expect(aliases.map((a) => [a.aliasKey, a.kind]).sort()).toEqual(
      [
        ["5FNUPIJRGLB5PRBLUEOD", "identifier"],
        ["8684626830429", "identifier"],
        ["SKU38", "opptra_sku"],
        ["SKU39", "opptra_sku"],
      ].sort(),
    );
  });

  it("an option_id alias is added when the product was created before its SKUs were known", async () => {
    const p = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "STYLE-9", skus: null, actor });
    const skus: ResolveResult = { optionIdStyleColor: "STYLE 9 RED", opptraSkuIds: ["S9_RED_M"], method: "product_code" };
    const again = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "STYLE-9", skus, actor });
    expect(again.product.id).toBe(p.product.id);
    expect(again.product.optionIdStyleColor).toBe("STYLE 9 RED");
    const viaOption = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "STYLE 9 RED", skus: null, actor });
    expect(viaOption.product.id).toBe(p.product.id);
  });

  it("new SKU ids are merged and write sku_ids_added", async () => {
    const one: ResolveResult = { optionIdStyleColor: null, opptraSkuIds: ["Z_1"], method: "ean" };
    const p = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "SKUADD", skus: one, actor });
    const same = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "SKUADD", skus: one, actor });
    expect((await events(p.product.id)).map((e) => e.kind)).toEqual(["created"]);
    expect(same.product.opptraSkuIds).toEqual(["Z_1"]);

    const more: ResolveResult = { optionIdStyleColor: null, opptraSkuIds: ["Z_0", "Z_1"], method: "ean" };
    const updated = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "SKUADD", skus: more, actor });
    expect(updated.product.opptraSkuIds).toEqual(["Z_0", "Z_1"]);
    const ev = await events(p.product.id);
    expect(ev.map((e) => e.kind).sort()).toEqual(["created", "sku_ids_added"]);
    expect(ev.find((e) => e.kind === "sku_ids_added")?.details).toEqual({ added: ["Z_0"] });
  });
});

describe("addAlias", () => {
  it("adds an alias with an alias_added event and refuses a key owned by another product", async () => {
    const a = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "ALIAS-A", skus: null, actor });
    const b = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "ALIAS-B", skus: null, actor });
    await addAlias(db, { productId: a.product.id, aliasKey: "old name a", kind: "manual", actor });
    await addAlias(db, { productId: a.product.id, aliasKey: "OLD-NAME-A", kind: "manual", actor }); // same key again: no-op
    expect((await events(a.product.id)).filter((e) => e.kind === "alias_added")).toHaveLength(1);
    await expect(addAlias(db, { productId: b.product.id, aliasKey: "Old_Name_A", kind: "manual", actor })).rejects.toThrow(
      "This name already belongs to ALIAS-A.",
    );
    const found = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "OLD NAME A", skus: null, actor });
    expect(found.product.id).toBe(a.product.id);
  });
});

describe("recordEvent", () => {
  it("writes an event with the actor", async () => {
    const p = await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier: "EVT-1", skus: null, actor });
    await recordEvent(db, { productId: p.product.id, kind: "removed", actor: "system", details: { why: "test" } });
    const ev = (await events(p.product.id)).find((e) => e.kind === "removed");
    expect(ev).toMatchObject({ actor: "system", batchId: null, details: { why: "test" } });
  });
});

describe("lockProducts and releaseLocks", () => {
  it("rolls back on contention and names the batch that holds the lock", async () => {
    const batch1 = await newBatch("Batch one");
    const batch2 = await newBatch("Batch two");
    const ids: string[] = [];
    for (const identifier of ["LOCK-1", "LOCK-2", "LOCK-3", "LOCK-4", "LOCK-5", "LOCK-6"]) {
      ids.push((await findOrCreateProduct(db, { brandSlug: "uspa", isTest: false, identifier, skus: null, actor })).product.id);
    }
    const [p1, p2, p3, p4, p5, p6] = ids as [string, string, string, string, string, string];

    expect(await lockProducts(db, batch1, [p1, p2, p3])).toEqual({ ok: true });
    expect(await lockProducts(db, batch1, [p1, p2, p3])).toEqual({ ok: true }); // re-lock by the holder is fine

    const r = await lockProducts(db, batch2, [p3, p4, p5, p6]);
    expect(r).toEqual({ ok: false, busy: [{ productId: p3, identifier: "LOCK-3", batchId: batch1, batchName: "Batch one" }] });

    const rows = await db.select({ id: catalogProducts.id, lock: catalogProducts.lockBatchId }).from(catalogProducts);
    const lockOf = (id: string) => rows.find((x) => x.id === id)?.lock ?? null;
    expect([p1, p2, p3].map(lockOf)).toEqual([batch1, batch1, batch1]);
    expect([p4, p5, p6].map(lockOf)).toEqual([null, null, null]); // the batch 2 update was rolled back

    expect(await releaseLocks(db, batch1)).toBe(3);
    expect(await releaseLocks(db, batch1)).toBe(0);
    expect(await lockProducts(db, batch2, [p3, p4, p5, p6])).toEqual({ ok: true });
    expect(await releaseLocks(db, batch2)).toBe(4);
  });
});
