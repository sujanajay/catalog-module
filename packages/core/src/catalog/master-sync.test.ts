// Tier 2: syncMaster with a fake BigQuery into PGlite.
//
// Warehouse columns confirmed on 2026-10-17 (INFORMATION_SCHEMA.COLUMNS of raw_gcc_dimensions):
// master_sl: ean, category_code, option_id_style_color, product_code, name, description,
//   scan_identifier, ean_1, gender, color, size, brand, image_url, mrp, category_name, hsn_code,
//   noon_ae, noon_sa, namshi_ae, child_zsku, namshi_sa, trendyol, trendyol_sku, centerpoint_ae_ksa,
//   our_sku, 6th_street_ae, our_sku_2, 6th_street_sa, styli_ae_ksa, styli_sku, our_sku_3,
//   amazon_reji, amazon, our_sku_4, voga_closet, shein, combined, uae, ksa, fz, uae_total, ... ,
//   region, dimension_type, createdDate, source_file_name, source_file_path, source_row_number,
//   ingestion_run_id.
// sku_master_sheet_hl: sku, sku_alias, sku_type, ean, category, brand, amazon_uae_ksa_asin,
//   noon_uae_ksa_marketplace_sku, noon_uae_ksa_retail_sku, carrefour_uae_id, home_centre_id,
//   danube_home_uae_id, trendyol_uae_ksa_id, styli_ksa_id, sharaf_dg_id, noon_nsku_without_1,
//   barcode, sku_1, prices..., region, dimension_type, createdDate, source_file_name,
//   source_file_path, source_row_number, ingestion_run_id.
// The fake rows below have the shape the two SELECTs return (aliases applied).
import { asc } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { brandMaster, skuMap } from "../db/schema";
import { createTestDb } from "../db/testing";
import { BigQuerySyncError, MASTER_HL_SQL, MASTER_SL_SQL, syncMaster, type BigQueryLike } from "./master-sync";
import { resolveSkus } from "./sku-mapping";

const SL_ROWS: Record<string, unknown>[] = [
  { product_code: "5F_NUPI_JR_GLB_5PR_BLUE_OD_38", option_id_style_color: "5F NUPI JR GLB 5PR BLUE OD", ean: "8684626830429", color: "BLUE", size: "38", brand: "USPA", line: "softline", image_url: "https://img/1.jpg", namshi_ae: "ZE7A133D7E13BBB15F66FZ", namshi_sa: "", child_zsku: "ZE7A133D7E13BBB15F66FZ-10", noon_ae: "5F NUPI JR GLB 5PR_BLUE_OD_38", noon_sa: null, trendyol: "", centerpoint_ae_ksa: "", sixth_street_ae: "5F-NUPI-JR-GLB-5PR_BLUE_OD_Navy", sixth_street_sa: "", styli_ae_ksa: "2125282903", styli_sku: "212528290329", amazon: "B0FMRHZ9GB", voga_closet: "", shein: "" },
  { product_code: "5F_NUPI_JR_GLB_5PR_BLUE_OD_39", option_id_style_color: "5F NUPI JR GLB 5PR BLUE OD", ean: "8684626830436", color: "BLUE", size: "39", brand: "USPA", line: "softline", image_url: "", styli_ae_ksa: "2125282903" },
  { product_code: "PLQELK3126IY_CREAM-PINK_OD_75B", option_id_style_color: "PLQELK3126IY CREAM-PINK OD", ean: "6300671911846", color: "CREAM PINK", size: "75B", brand: "Penti", line: "softline", amazon: "B0HFKHZ9S1" },
  { product_code: "VM_10351209_Black_S", option_id_style_color: "", ean: "5715914319999", color: "", size: "", brand: "Vero Moda", line: "softline" },
  { product_code: "  ", option_id_style_color: "BLANK", ean: "1", brand: "USPA", line: "softline" },
];
const HL_ROWS: Record<string, unknown>[] = [
  { sku: "BGIN-9235", ean: "8904389624593", brand: "Bergner", line: "hardline", amazon_uae_ksa_asin: "B0DJF9L2JC", noon_ae: "Z0A8EEB3C3A70ACD82E0AZ-1", noon_sa: "Z3E8234552CC8559CBDC0Z-1", trendyol: "8904389624593", styli_sku: "291598713220" },
  { sku: "NTS-1500", ean: "6290361790885", brand: "NutriBullet", line: "hardline", amazon_uae_ksa_asin: "B0DWFDZZ5L", noon_ae: "N70152468V-1", noon_sa: "N70152468V-1", trendyol: "6290361790885", styli_sku: "291612280120" },
  { sku: "A11941", ean: "693199519417", brand: "Carote", line: "hardline", amazon_uae_ksa_asin: "B0GVDWM18Y", noon_ae: "", noon_sa: "", trendyol: "", styli_sku: "" },
];

function fakeBq(sl = SL_ROWS, hl = HL_ROWS): BigQueryLike & { calls: { query: string; location?: string }[] } {
  const calls: { query: string; location?: string }[] = [];
  return {
    calls,
    async query(options) {
      calls.push({ query: options.query, location: options.location });
      if (options.query === MASTER_SL_SQL) return [sl.map((r) => ({ ...r })), {}];
      if (options.query === MASTER_HL_SQL) return [hl.map((r) => ({ ...r })), {}];
      throw new Error(`unexpected query ${options.query}`);
    },
  };
}

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  // A manual brand the warehouse now carries, a manual brand it does not, and a manual SKU row
  // (07 mapping sheet) that the warehouse later carries.
  await db.insert(brandMaster).values([
    { name: "Penti", slug: "penti", line: "softline", source: "manual" },
    { name: "Anta", slug: "anta", line: "softline", source: "manual" },
  ]);
  await db.insert(skuMap).values([
    { opptraSku: "A11941", brand: "Carote", brandSlug: "carote", line: "hardline", optionKey: "OLD", source: "manual" },
    { opptraSku: "ANTA_1", brand: "Anta", brandSlug: "anta", line: "softline", optionKey: "ANTA1", source: "manual" },
  ]);
});

afterAll(async () => {
  await close();
});

const strip = <T extends { syncedAt: Date | null }>(rows: T[]) => rows.map(({ syncedAt: _s, ...r }) => r);

describe("syncMaster", () => {
  it("upserts brands and SKUs from both masters", async () => {
    const pentiBefore = (await db.select().from(brandMaster)).find((b) => b.slug === "penti")!;
    const bq = fakeBq();
    const result = await syncMaster(db, bq, { BQ_LOCATION: "asia-south1" });
    expect(bq.calls.map((c) => c.location)).toEqual(["asia-south1", "asia-south1"]);
    expect(result.brands).toBe(6);
    expect(result.skus).toBe(7);
    expect(result.warnings).toEqual(["Skipped 1 warehouse rows with no product code or SKU."]);

    const brands = await db.select().from(brandMaster).orderBy(asc(brandMaster.slug));
    expect(brands.map((b) => [b.slug, b.name, b.line, b.source])).toEqual([
      ["anta", "Anta", "softline", "manual"],
      ["bergner", "Bergner", "hardline", "warehouse"],
      ["carote", "Carote", "hardline", "warehouse"],
      ["nutribullet", "NutriBullet", "hardline", "warehouse"],
      ["penti", "Penti", "softline", "warehouse"],
      ["uspa", "USPA", "softline", "warehouse"],
      ["vero_moda", "Vero Moda", "softline", "warehouse"],
    ]);
    // The manual Penti row is reconciled to warehouse and keeps its id.
    const penti = brands.find((b) => b.slug === "penti")!;
    expect(penti.id).toBe(pentiBefore.id);
    expect(penti.syncedAt).not.toBeNull();
    expect(brands.find((b) => b.slug === "anta")!.syncedAt).toBeNull();

    const skus = await db.select().from(skuMap).orderBy(asc(skuMap.opptraSku));
    expect(skus).toHaveLength(8); // 7 from the warehouse + the untouched manual ANTA_1
    const uspa38 = skus.find((s) => s.opptraSku === "5F_NUPI_JR_GLB_5PR_BLUE_OD_38")!;
    expect(uspa38).toMatchObject({
      brand: "USPA",
      brandSlug: "uspa",
      line: "softline",
      optionKey: "5FNUPIJRGLB5PRBLUEOD",
      optionIdStyleColor: "5F NUPI JR GLB 5PR BLUE OD",
      ean: "8684626830429",
      size: "38",
      imageUrl: "https://img/1.jpg",
      source: "warehouse",
      channelIds: {
        namshi_ae: "ZE7A133D7E13BBB15F66FZ",
        child_zsku: "ZE7A133D7E13BBB15F66FZ-10",
        noon_ae: "5F NUPI JR GLB 5PR_BLUE_OD_38",
        sixth_street_ae: "5F-NUPI-JR-GLB-5PR_BLUE_OD_Navy",
        styli_ae_ksa: "2125282903",
        styli_sku: "212528290329",
        amazon: "B0FMRHZ9GB",
      },
    });
    // No option id: the option key falls back to the product code minus its size.
    expect(skus.find((s) => s.opptraSku === "VM_10351209_Black_S")).toMatchObject({ optionKey: "VM10351209BLACK", optionIdStyleColor: null, color: null });
    // Hardline: own SKU is the option; ids mapped onto the channel keys.
    expect(skus.find((s) => s.opptraSku === "BGIN-9235")).toMatchObject({
      brandSlug: "bergner",
      line: "hardline",
      optionKey: "BGIN9235",
      channelIds: { amazon_uae_ksa_asin: "B0DJF9L2JC", noon_ae: "Z0A8EEB3C3A70ACD82E0AZ-1", noon_sa: "Z3E8234552CC8559CBDC0Z-1", trendyol: "8904389624593", styli_sku: "291598713220" },
    });
    // The manual SKU row the warehouse now carries is overwritten.
    expect(skus.find((s) => s.opptraSku === "A11941")).toMatchObject({ source: "warehouse", optionKey: "A11941", channelIds: { amazon_uae_ksa_asin: "B0GVDWM18Y" } });

    expect(await resolveSkus(db, { brandSlug: "uspa", identifier: "5F_NUPI_JR_GLB_5PR_BLUE_OD" })).toEqual({
      optionIdStyleColor: "5F NUPI JR GLB 5PR BLUE OD",
      opptraSkuIds: ["5F_NUPI_JR_GLB_5PR_BLUE_OD_38", "5F_NUPI_JR_GLB_5PR_BLUE_OD_39"],
      method: "option_key",
    });
    expect((await resolveSkus(db, { brandSlug: "bergner", identifier: "B0DJF9L2JC" })).method).toBe("channel_id");
  });

  it("a second run changes nothing but synced_at and deletes nothing", async () => {
    const brandsBefore = await db.select().from(brandMaster).orderBy(asc(brandMaster.slug));
    const skusBefore = await db.select().from(skuMap).orderBy(asc(skuMap.opptraSku));
    await new Promise((r) => setTimeout(r, 5));
    const result = await syncMaster(db, fakeBq(), {});
    expect(result).toMatchObject({ brands: 6, skus: 7 });
    const brandsAfter = await db.select().from(brandMaster).orderBy(asc(brandMaster.slug));
    const skusAfter = await db.select().from(skuMap).orderBy(asc(skuMap.opptraSku));
    expect(strip(brandsAfter)).toEqual(strip(brandsBefore));
    expect(strip(skusAfter)).toEqual(strip(skusBefore));
    const uspaBefore = brandsBefore.find((b) => b.slug === "uspa")!.syncedAt!.getTime();
    expect(brandsAfter.find((b) => b.slug === "uspa")!.syncedAt!.getTime()).toBeGreaterThan(uspaBefore);
  });

  it("keeps the last row of a duplicated code and warns", async () => {
    const dup = { ...SL_ROWS[2]!, color: "PINK" };
    const result = await syncMaster(db, fakeBq([...SL_ROWS, dup], HL_ROWS), {});
    expect(result.warnings).toContain("1 SKU codes appear more than once in the warehouse; the last row was kept.");
    const all = await db.select().from(skuMap);
    expect(all.find((s) => s.opptraSku === "PLQELK3126IY_CREAM-PINK_OD_75B")?.color).toBe("PINK");
  });

  it("wraps a BigQuery failure in BigQuerySyncError and writes nothing", async () => {
    const before = await db.select().from(skuMap);
    const bq: BigQueryLike = { query: async () => { throw new Error("Access Denied: bigquery.jobs.create"); } };
    await expect(syncMaster(db, bq, {})).rejects.toBeInstanceOf(BigQuerySyncError);
    expect(await db.select().from(skuMap)).toHaveLength(before.length);
  });
});
