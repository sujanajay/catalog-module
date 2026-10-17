import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { skuMap } from "../db/schema";
import { createTestDb } from "../db/testing";
import { parseManualMapping, resolveSkus, stripSizeSegment } from "./sku-mapping";

let db: Db;
let close: () => Promise<void>;

const base = { brand: "USPA", brandSlug: "uspa", line: "softline" as const, source: "warehouse" as const };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(skuMap).values([
    // Option 5F NUPI JR GLB 5PR BLUE OD in three sizes, inserted out of order.
    { ...base, opptraSku: "5F_NUPI_JR_GLB_5PR_BLUE_OD_40", optionKey: "5FNUPIJRGLB5PRBLUEOD", optionIdStyleColor: "5F NUPI JR GLB 5PR BLUE OD", ean: "8684626830440", channelIds: { child_zsku: "ZE7A133D7E13BBB15F66FZ-12" } },
    { ...base, opptraSku: "5F_NUPI_JR_GLB_5PR_BLUE_OD_38", optionKey: "5FNUPIJRGLB5PRBLUEOD", optionIdStyleColor: "5F NUPI JR GLB 5PR BLUE OD", ean: "8684626830429", channelIds: { child_zsku: "ZE7A133D7E13BBB15F66FZ-10", styli_ae_ksa: "2125282903" } },
    { ...base, opptraSku: "5F_NUPI_JR_GLB_5PR_BLUE_OD_39", optionKey: "5FNUPIJRGLB5PRBLUEOD", optionIdStyleColor: "5F NUPI JR GLB 5PR BLUE OD", ean: "8684626830436", channelIds: { child_zsku: "ZE7A133D7E13BBB15F66FZ-11" } },
    // Another option of the same brand, matched only by its marketplace ids.
    { ...base, opptraSku: "PENA_GLB_5PR_WOMEN_OD_WHITE_40", optionKey: "PENAGLB5PRWOMENODWHITE", optionIdStyleColor: "PENA GLB 5PR WOMEN OD WHITE", ean: "8684626576204", channelIds: { amazon: "B0FSXF81LZ", namshi_ae: "Z2798064B4D0C538FBD90Z" } },
    // A different brand with a colliding EAN must never be returned for uspa.
    { brand: "Penti", brandSlug: "penti", line: "softline", source: "warehouse", opptraSku: "PENTI_X_OD_S", optionKey: "PENTIXOD", optionIdStyleColor: "PENTI X OD", ean: "1111111111111", channelIds: {} },
  ]);
});

afterAll(async () => {
  await close();
});

const ALL_SIZES = ["5F_NUPI_JR_GLB_5PR_BLUE_OD_38", "5F_NUPI_JR_GLB_5PR_BLUE_OD_39", "5F_NUPI_JR_GLB_5PR_BLUE_OD_40"];

describe("resolveSkus", () => {
  it("option_key: the style+colour id in any spelling returns every size, sorted", async () => {
    for (const identifier of ["5F NUPI JR GLB 5PR BLUE OD", "5f_nupi_jr_glb_5pr_blue_od", "5F-NUPI-JR-GLB-5PR-BLUE-OD"]) {
      expect(await resolveSkus(db, { brandSlug: "uspa", identifier })).toEqual({
        optionIdStyleColor: "5F NUPI JR GLB 5PR BLUE OD",
        opptraSkuIds: ALL_SIZES,
        method: "option_key",
      });
    }
  });

  it("ean: from the input or a barcode identifier", async () => {
    expect(await resolveSkus(db, { brandSlug: "uspa", identifier: "IMG_1", ean: "8684626830436" })).toMatchObject({
      opptraSkuIds: ALL_SIZES,
      method: "ean",
    });
    expect(await resolveSkus(db, { brandSlug: "uspa", identifier: "8684626576204" })).toMatchObject({
      opptraSkuIds: ["PENA_GLB_5PR_WOMEN_OD_WHITE_40"],
      method: "ean",
    });
  });

  it("channel_id: only the listed keys count, values compared normalised", async () => {
    expect(await resolveSkus(db, { brandSlug: "uspa", identifier: "2125282903" })).toMatchObject({
      opptraSkuIds: ALL_SIZES,
      method: "channel_id",
    });
    expect(await resolveSkus(db, { brandSlug: "uspa", identifier: "x", channelIds: ["ze7a133d7e13bbb15f66fz_11"] })).toMatchObject({
      opptraSkuIds: ALL_SIZES,
      method: "channel_id",
    });
    expect(await resolveSkus(db, { brandSlug: "uspa", identifier: "B0FSXF81LZ" })).toMatchObject({
      optionIdStyleColor: "PENA GLB 5PR WOMEN OD WHITE",
      method: "channel_id",
    });
    // namshi_ae is not one of the resolution keys.
    expect((await resolveSkus(db, { brandSlug: "uspa", identifier: "Z2798064B4D0C538FBD90Z" })).method).toBe("unresolved");
  });

  it("product_code: a per-size code resolves to its option", async () => {
    expect(await resolveSkus(db, { brandSlug: "uspa", identifier: "PENA_GLB_5PR_WOMEN_OD_WHITE_42" })).toMatchObject({
      opptraSkuIds: ["PENA_GLB_5PR_WOMEN_OD_WHITE_40"],
      method: "product_code",
    });
    expect(await resolveSkus(db, { brandSlug: "uspa", identifier: "5F_NUPI_JR_GLB_5PR_BLUE_OD_39" })).toMatchObject({
      opptraSkuIds: ALL_SIZES,
      method: "product_code",
    });
  });

  it("is restricted to the brand", async () => {
    expect((await resolveSkus(db, { brandSlug: "uspa", identifier: "1111111111111" })).method).toBe("unresolved");
    expect((await resolveSkus(db, { brandSlug: "penti", identifier: "1111111111111" })).method).toBe("ean");
    expect((await resolveSkus(db, { brandSlug: "penti", identifier: "5F NUPI JR GLB 5PR BLUE OD" })).method).toBe("unresolved");
  });

  it("manual map wins only after every warehouse method misses", async () => {
    const manual = parseManualMapping([["identifier", "opptra_sku_id"], ["5F NUPI JR GLB 5PR BLUE OD", "MANUAL_1"], ["ABC-123", "M_2"], ["abc123", "M_1"]]);
    expect((await resolveSkus(db, { brandSlug: "uspa", identifier: "5F NUPI JR GLB 5PR BLUE OD", manual })).method).toBe("option_key");
    expect(await resolveSkus(db, { brandSlug: "uspa", identifier: "ABC_123", manual })).toEqual({
      optionIdStyleColor: null,
      opptraSkuIds: ["M_1", "M_2"],
      method: "manual",
    });
  });

  it("unresolved is a normal result", async () => {
    expect(await resolveSkus(db, { brandSlug: "uspa", identifier: "NOPE999" })).toEqual({
      optionIdStyleColor: null,
      opptraSkuIds: [],
      method: "unresolved",
    });
  });
});

describe("parseManualMapping", () => {
  it("groups several rows per identifier, skips header and blanks, dedupes and sorts", () => {
    const m = parseManualMapping([
      ["identifier", "opptra_sku_id"],
      ["ABC-123", "SKU_B"],
      ["", "SKU_X"],
      ["abc_123", "SKU_A"],
      ["ABC123", "SKU_B"],
      ["DEF", ""],
      ["DEF 9", " SKU_C "],
    ]);
    expect([...m.entries()]).toEqual([
      ["ABC123", ["SKU_A", "SKU_B"]],
      ["DEF9", ["SKU_C"]],
    ]);
  });
});

describe("stripSizeSegment", () => {
  it("removes the trailing _<size> segment only", () => {
    expect(stripSizeSegment("10148253_BrightWhite_OD_M")).toBe("10148253_BrightWhite_OD");
    expect(stripSizeSegment("719M0_BLACK_OD_XL/14")).toBe("719M0_BLACK_OD");
    expect(stripSizeSegment("BGIN-9235")).toBe("BGIN-9235");
  });
});
