// Tier 2 (PGlite; real Postgres when TEST_PG_URL is set), M0-S2: the key mapping seed (0013), the pure planner (option
// key order, style key, markets, child_zsku on every listing, sales and report keys), and syncGraph against a fake
// BigQuery: idempotent re-run, conflicts (planted, then fixed), hand-written keys left alone, options that leave the
// master, product links, and a BigQuery failure that writes nothing.
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BigQuerySyncError, type BigQueryLike } from "../catalog/master-sync";
import type { Db } from "../db/client";
import {
  catalogChannelListings,
  catalogKeyConflicts,
  catalogKeyMappings,
  catalogListingKeys,
  catalogOptions,
  catalogProducts,
  skuMap,
  type SkuChannelIds,
} from "../db/schema";
import { createRealTestDb, createTestDb, TEST_PG_URL } from "../db/testing";
import {
  GRAPH_MASTER_ATTRS_SQL,
  GRAPH_REPORT_KEYS_SQL,
  GRAPH_SALES_KEYS_SQL,
  GRAPH_SKU_OPTION_SQL,
  keyRef,
  listingRef,
  mergeKeys,
  optionRef,
  planGraph,
  syncGraph,
  type GraphInputs,
  type GraphMapping,
} from "./key-sync";
import { outcomeKeys, resolveListing, resolveOption } from "./resolve";
import { colourVocabulary, styleKeyFor } from "./style-key";

const MAPPINGS: GraphMapping[] = [
  { skuColumn: "namshi_ae", channel: "namshi", market: "ae", keyKind: "zsku" },
  { skuColumn: "child_zsku", channel: null, market: null, keyKind: "child_zsku" },
  { skuColumn: "noon_ae", channel: "noon", market: "ae", keyKind: "partner_sku" },
  { skuColumn: "trendyol", channel: "trendyol", market: null, keyKind: "barcode" },
  { skuColumn: "styli_sku", channel: "styli", market: "ae_sa", keyKind: "child_zsku" },
];

function inputs(over: Partial<GraphInputs> = {}): GraphInputs {
  return {
    skus: [],
    mappings: MAPPINGS,
    attrs: new Map(),
    skuOptions: new Map(),
    sales: [],
    reports: [],
    minConfidence: 0.8,
    ...over,
  };
}

describe("style key (F1-R8)", () => {
  const vocab = colourVocabulary(["Black", "NAVY", "BLK/GOLDEN", "Snow White"]);

  it("uses the sheet's style code first, with confidence 1", () => {
    expect(styleKeyFor({ brandSlug: "uspa", optionKey: "4W ACHILLE MEN OD BLACK", styleCode: "4W Achille Men OD", text: "x" }, vocab)).toEqual({
      styleKey: "uspa|4W ACHILLE MEN OD", source: "brand_style_code", confidence: 1,
    });
  });

  it("strips the trailing colour and the OD marker when there is no style code", () => {
    expect(styleKeyFor({ brandSlug: "fc", optionKey: "559B3 NAVY OD", text: "559B3 NAVY OD" }, vocab)).toEqual({
      styleKey: "fc|559B3", source: "name_colour_rule", confidence: 0.9,
    });
    expect(styleKeyFor({ brandSlug: "c", optionKey: "S1651T BLK/GOLDEN", text: "S1651T BLK/GOLDEN" }, vocab).styleKey).toBe("c|S1651T");
  });

  it("makes an option it cannot place surely its own cluster", () => {
    expect(styleKeyFor({ brandSlug: "campus", optionKey: "S0760B-02", text: "S0760B-02" }, vocab)).toEqual({
      styleKey: "campus|own:S0760B-02", source: "own_cluster", confidence: 0.5,
    });
    // A higher bar sends even a sure rule match to its own cluster.
    expect(styleKeyFor({ brandSlug: "fc", optionKey: "559B3 NAVY OD", text: "559B3 NAVY OD" }, vocab, 0.95).source).toBe("own_cluster");
  });
});

describe("planGraph", () => {
  const sku = (opptraSku: string, optionIdStyleColor: string | null, channelIds: SkuChannelIds, brandSlug = "uspa", color: string | null = "Black") => ({
    opptraSku, brandSlug, optionIdStyleColor, color, channelIds,
  });

  it("keys an option by the master id, then the marketing option, then the SKU (F1-R2)", () => {
    const plan = planGraph(inputs({
      skus: [sku("A_BLACK_M", "A Black OD", {}), sku("A_BLACK_L", "A Black OD", {}), sku("B_NAVY_M", null, {}), sku("C_X_M", null, {})],
      skuOptions: new Map([["B_NAVY_M", "B NAVY OD"]]),
    }));
    const o = [...plan.options.values()].map((x) => [x.optionKey, x.keySource, x.skus.length]);
    expect(o).toEqual([["A Black OD", "master", 2], ["B NAVY OD", "sku_option", 1], ["sku:C_X_M", "sku_fallback", 1]]);
  });

  it("maps master columns, puts child_zsku on every listing, and takes the Trendyol market from sales (F1-R3)", () => {
    const plan = planGraph(inputs({
      skus: [sku("A_BLACK_M", "A Black OD", { namshi_ae: "ZP1", child_zsku: "ZP1-1", noon_ae: "A_BLACK_M", trendyol: "629000", styli_sku: "0" })],
      sales: [{ opptraSku: "A_BLACK_M", channel: "trendyol", market: "sa", channelSku: "629000", styleId: null }],
    }));
    const o = optionRef("uspa", "A Black OD");
    expect([...plan.listings.keys()].sort()).toEqual(
      [listingRef(o, "namshi", "ae"), listingRef(o, "noon", "ae"), listingRef(o, "trendyol", "sa")].sort(),
    );
    const keys = plan.keys.map((k) => `${k.channel}/${k.market}/${k.keyKind}/${k.keyValue}/${k.source}`);
    expect(keys).toContain("namshi/ae/zsku/ZP1/master");
    expect(keys).toContain("trendyol/sa/barcode/629000/master");
    // child_zsku sits on all three listings; the "0" styli value is not a key.
    expect(keys.filter((k) => k.includes("child_zsku/ZP1-1/master"))).toHaveLength(3);
    expect(keys.some((k) => k.startsWith("styli"))).toBe(false);
  });

  it("adds sales and report keys the master lacks, on the right listing (F1-R4)", () => {
    const plan = planGraph(inputs({
      skus: [sku("A_BLACK_M", "A Black OD", { styli_sku: "7001" })],
      sales: [
        { opptraSku: "A_BLACK_M", channel: "namshi", market: "sa", channelSku: "ZQ-2", styleId: "A Black OD" },
        { opptraSku: "A_BLACK_M", channel: "styli", market: "sa", channelSku: "70-7001", styleId: null },
        { opptraSku: "NOT_IN_MAP", channel: "noon", market: "ae", channelSku: "Z9", styleId: null },
      ],
      reports: [{ opptraSku: "A_BLACK_M", channel: "amazon", market: "ae", keyKind: "seller_sku", keyValue: "A_BLACK_M" }],
    }));
    const keys = plan.keys.map((k) => `${k.channel}/${k.market}/${k.keyKind}/${k.keyValue}/${k.source}`);
    expect(keys).toContain("namshi/sa/child_zsku/ZQ-2/sales");
    expect(keys).toContain("namshi/sa/style_id/A Black OD/sales");
    // Styli has one key for both markets: the KSA sale lands on the ae_sa listing, not a new sa one.
    expect(keys).toContain("styli/ae_sa/child_zsku/70-7001/sales");
    expect(keys).toContain("amazon/ae/seller_sku/A_BLACK_M/channel_report");
    expect(plan.unresolvedSalesRows).toBe(1);
  });

  it("merges proposals and keeps the best source", () => {
    const plan = planGraph(inputs({
      skus: [sku("A_BLACK_M", "A Black OD", { child_zsku: "ZP1-1", namshi_ae: "ZP1" })],
      sales: [{ opptraSku: "A_BLACK_M", channel: "namshi", market: "ae", channelSku: "ZP1-1", styleId: null }],
    }));
    const m = mergeKeys(plan.keys).get(keyRef({ channel: "namshi", market: "ae", keyKind: "child_zsku", keyValue: "ZP1-1" }))!;
    expect([...m.candidates.values()]).toEqual([{ source: "master", skus: new Set(["A_BLACK_M"]) }]);
  });
});

// ---------------------------------------------------------------------------
// syncGraph against PGlite (or real Postgres) and a fake BigQuery
// ---------------------------------------------------------------------------

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = TEST_PG_URL ? await createRealTestDb() : await createTestDb());
}, 120_000);

afterAll(async () => {
  await close?.();
});

type Fake = { attrs: Record<string, unknown>[]; options: Record<string, unknown>[]; sales: Record<string, unknown>[]; reports: Record<string, unknown>[]; fail?: boolean };

function fakeBq(f: Fake): BigQueryLike {
  return {
    query: async ({ query }) => {
      if (f.fail) throw new Error("503 backend error");
      if (query === GRAPH_MASTER_ATTRS_SQL) return [f.attrs, {}];
      if (query === GRAPH_SKU_OPTION_SQL) return [f.options, {}];
      if (query === GRAPH_SALES_KEYS_SQL) return [f.sales, {}];
      if (query === GRAPH_REPORT_KEYS_SQL) return [f.reports, {}];
      throw new Error(`unexpected query ${query.slice(0, 40)}`);
    },
  };
}

async function putSku(opptraSku: string, optionIdStyleColor: string | null, channelIds: SkuChannelIds, brandSlug = "uspa_t") {
  await db
    .insert(skuMap)
    .values({ opptraSku, brand: brandSlug, brandSlug, line: "softline", optionKey: opptraSku, optionIdStyleColor, color: "Black", channelIds, source: "warehouse" })
    .onConflictDoUpdate({ target: skuMap.opptraSku, set: { optionIdStyleColor, channelIds } });
}

const keysOf = async (value: string) => db.select().from(catalogListingKeys).where(eq(catalogListingKeys.keyValue, value));

describe("key mapping seed (0013, D10)", () => {
  it("seeds one row per key column except voga_closet", async () => {
    const rows = await db.select().from(catalogKeyMappings);
    expect(rows.map((r) => r.skuColumn).sort()).toEqual([
      "amazon", "amazon_uae_ksa_asin", "centerpoint_ae_ksa", "child_zsku", "namshi_ae", "namshi_sa", "noon_ae", "noon_sa",
      "shein", "sixth_street_ae", "sixth_street_sa", "styli_ae_ksa", "styli_sku", "trendyol",
    ]);
    expect(rows.find((r) => r.skuColumn === "child_zsku")).toMatchObject({ channel: null, market: null, keyKind: "child_zsku" });
  });
});

describe("syncGraph", () => {
  const fake: Fake = { attrs: [], options: [], sales: [], reports: [] };

  beforeEach(() => {
    fake.fail = false;
  });

  it("builds options, listings, keys and style keys, then links products (F1-R1 to R6, R8)", async () => {
    await putSku("UT_A_BLACK_M", "UT-A Black OD", { namshi_ae: "ZUTA", child_zsku: "ZUTA-1", noon_ae: "UT_A_BLACK_M", trendyol: "62901" });
    await putSku("UT_A_BLACK_L", "UT-A Black OD", { namshi_ae: "ZUTA", child_zsku: "ZUTA-2", trendyol: "62902" });
    await putSku("UT_A_NAVY_M", "UT-A Navy OD", { namshi_ae: "ZUTB", child_zsku: "ZUTB-1" });
    await putSku("UT_Z_M", null, { noon_ae: "UT_Z_M" });
    fake.attrs = [
      { product_code: "UT_A_BLACK_M", description_1: "UT-A", category_name: "Polo", gender: "Male" },
      { product_code: "UT_A_BLACK_L", description_1: "UT-A" },
      { product_code: "UT_A_NAVY_M", description_1: "UT-A" },
      { product_code: "UT_Z_M" },
    ];
    fake.sales = [{ mapped_opptra_sku: "UT_A_BLACK_M", channel: "Trendyol", country: "UAE", channel_sku: "62901", style_id: "UT-A Black OD" }];
    const [product] = await db.insert(catalogProducts).values({ brandSlug: "uspa_t", identifier: "UT-A Black OD", productKey: "uta", pathKey: "UTA", opptraSkuIds: ["UT_A_BLACK_M"] }).returning();

    const r = await syncGraph(db, fakeBq(fake), {});
    expect(r.skipped).toBeUndefined();
    expect(r.conflicts.open).toBe(0);

    const options = await db.select().from(catalogOptions).where(eq(catalogOptions.brandSlug, "uspa_t"));
    expect(options.map((o) => [o.optionKey, o.keySource, o.styleKey, o.styleKeySource]).sort()).toEqual([
      ["UT-A Black OD", "master", "uspa_t|UT-A", "brand_style_code"],
      ["UT-A Navy OD", "master", "uspa_t|UT-A", "brand_style_code"],
      ["sku:UT_Z_M", "sku_fallback", "uspa_t|own:sku:UT_Z_M", "own_cluster"],
    ]);
    expect(options.find((o) => o.optionKey === "UT-A Black OD")).toMatchObject({ productType: "Polo", audience: "Male", inMaster: true, line: "softline" });

    // Trendyol: the sold barcode is on the UAE listing, the unsold one on ae_sa.
    expect((await keysOf("62901")).map((k) => [k.market, k.keyKind, k.source, k.opptraSku])).toEqual([["ae", "barcode", "master", "UT_A_BLACK_M"]]);
    expect((await keysOf("62902")).map((k) => k.market)).toEqual(["ae_sa"]);
    // child_zsku is on every listing of its SKU: namshi ae, noon ae, trendyol ae.
    expect((await keysOf("ZUTA-1")).map((k) => k.channel).sort()).toEqual(["namshi", "noon", "trendyol"]);
    // The option-level zsku is one row with no single SKU.
    expect((await keysOf("ZUTA")).map((k) => k.opptraSku)).toEqual([null]);

    const [linked] = await db.select().from(catalogProducts).where(eq(catalogProducts.id, product!.id));
    expect(linked!.optionId).toBe(options.find((o) => o.optionKey === "UT-A Black OD")!.id);

    // Resolution reads (3.4).
    expect((await resolveOption(db, { brandSlug: "uspa_t", opptraSku: "UT_A_BLACK_L" }))?.optionKey).toBe("UT-A Black OD");
    expect((await resolveOption(db, { brandSlug: "uspa_t", identifier: "ZUTB-1" }))?.optionKey).toBe("UT-A Navy OD");
    expect(await resolveOption(db, { brandSlug: "uspa_t", identifier: "nothing" })).toBeNull();
    const listing = await resolveListing(db, { channel: "namshi", market: "ae", keyValue: "ZUTA-2" });
    expect(listing?.optionId).toBe(linked!.optionId);
    expect((await outcomeKeys(db, listing!.listingId)).map((k) => `${k.keyKind}:${k.keyValue}`)).toEqual(["child_zsku:ZUTA-1", "child_zsku:ZUTA-2", "zsku:ZUTA"]);
  });

  it("writes nothing new on a second run with the same inputs (idempotent)", async () => {
    const before = await db.select().from(catalogListingKeys);
    const r = await syncGraph(db, fakeBq(fake), {});
    expect(r.keys).toMatchObject({ inserted: 0, moved: 0, removedForConflict: 0 });
    expect(r.keys.unchanged).toBeGreaterThan(0);
    const after = await db.select().from(catalogListingKeys);
    expect(after.map((k) => k.id).sort()).toEqual(before.map((k) => k.id).sort());
  });

  it("lists a key planted on two listings as a conflict and does not write it, then resolves it (F1-R5)", async () => {
    // ZUTB is planted on a second option too.
    await putSku("UT_C_RED_M", "UT-C Red OD", { namshi_ae: "ZUTB" });
    fake.attrs.push({ product_code: "UT_C_RED_M", description_1: "UT-C" });
    const r = await syncGraph(db, fakeBq(fake), {});
    expect(r.conflicts.open).toBe(1);
    expect(r.keys.removedForConflict).toBe(1);
    expect(await keysOf("ZUTB")).toEqual([]);
    const [c] = await db.select().from(catalogKeyConflicts).where(eq(catalogKeyConflicts.keyValue, "ZUTB"));
    expect(c).toMatchObject({ channel: "namshi", market: "ae", keyKind: "zsku", resolvedAt: null });
    expect(c!.candidates).toHaveLength(2);

    // The master is fixed: the conflict resolves and the key is written again.
    await putSku("UT_C_RED_M", "UT-C Red OD", { namshi_ae: "ZUTC" });
    const r2 = await syncGraph(db, fakeBq(fake), {});
    expect(r2.conflicts).toEqual({ open: 0, resolved: 1 });
    expect((await keysOf("ZUTB")).map((k) => k.source)).toEqual(["master"]);
    const [c2] = await db.select().from(catalogKeyConflicts).where(eq(catalogKeyConflicts.keyValue, "ZUTB"));
    expect(c2!.resolvedAt).not.toBeNull();
  });

  it("never moves a key written by hand; a sync key that disagrees becomes a conflict", async () => {
    const [other] = await db.select().from(catalogOptions).where(and(eq(catalogOptions.brandSlug, "uspa_t"), eq(catalogOptions.optionKey, "UT-C Red OD")));
    const [l] = await db.insert(catalogChannelListings).values({ optionId: other!.id, channel: "namshi", market: "sa" }).returning();
    await db.insert(catalogListingKeys).values({ listingId: l!.id, channel: "namshi", market: "sa", keyKind: "child_zsku", keyValue: "ZHAND", source: "manual" });
    await putSku("UT_A_NAVY_M", "UT-A Navy OD", { namshi_ae: "ZUTB", child_zsku: "ZUTB-1" });
    fake.sales.push({ mapped_opptra_sku: "UT_A_NAVY_M", channel: "Namshi", country: "KSA", channel_sku: "ZHAND", style_id: null });
    const r = await syncGraph(db, fakeBq(fake), {});
    expect(r.conflicts.open).toBe(1);
    expect((await keysOf("ZHAND")).map((k) => [k.listingId, k.source])).toEqual([[l!.id, "manual"]]);
    fake.sales.pop();
  });

  it("keeps an option whose SKUs left the master, out of the master (F1-R1)", async () => {
    fake.attrs = fake.attrs.filter((a) => a.product_code !== "UT_Z_M");
    await syncGraph(db, fakeBq(fake), {});
    const [o] = await db.select().from(catalogOptions).where(eq(catalogOptions.optionKey, "sku:UT_Z_M"));
    expect(o!.inMaster).toBe(false);
  });

  it("leaves the graph as it was when BigQuery fails", async () => {
    const before = (await db.select().from(catalogListingKeys)).length;
    await putSku("UT_D_M", "UT-D Black OD", { namshi_ae: "ZUTD" });
    fake.fail = true;
    await expect(syncGraph(db, fakeBq(fake), {})).rejects.toBeInstanceOf(BigQuerySyncError);
    expect((await db.select().from(catalogListingKeys)).length).toBe(before);
    expect(await db.select().from(catalogOptions).where(eq(catalogOptions.optionKey, "UT-D Black OD"))).toEqual([]);
  });

  it("refuses an empty master instead of marking every option gone", async () => {
    await expect(syncGraph(db, fakeBq({ attrs: [], options: [], sales: [], reports: [] }), {})).rejects.toThrow(/no rows/);
  });
});
