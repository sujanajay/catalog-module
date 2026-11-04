import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { brandMaster, catalogChannelListings, catalogOptions, catalogProducts, skuMap } from "../db/schema";
import { candidateKeys, channelDefaults, defaultChannels, inferBrand, SLICE_CHANNELS } from "./intake-defaults";

// M1-F2-R3 and R4 (M1-S2): the brand is inferred from the dropped names when at least 90% of the identifiers we can
// resolve belong to one brand; the default channels come from where the brand is listed, else the five slice channels.
let db: Db; let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await db.insert(brandMaster).values([
    { slug: "vero-moda", name: "Vero Moda", line: "softline", source: "manual" },
    { slug: "uspa", name: "USPA", line: "softline", source: "manual" },
  ] as never);
  const sku = (opptraSku: string, brandSlug: string, optionKey: string, ean: string | null = null) =>
    ({ opptraSku, brand: brandSlug, brandSlug, line: "softline", optionKey, optionIdStyleColor: optionKey, ean, source: "manual" });
  await db.insert(skuMap).values([
    sku("Z1", "vero-moda", "VM10001BLACK"), sku("Z2", "vero-moda", "VM10002WHITE"), sku("Z3", "vero-moda", "VM10003NAVY"),
    sku("Z4", "uspa", "US20001RED", "8901234567890"),
  ] as never);
  await db.insert(catalogProducts).values({ brandSlug: "uspa", isTest: false, productKey: "USOLD99", pathKey: "US-OLD-99", identifier: "US-OLD-99" } as never);
  const [opt] = await db.insert(catalogOptions).values({ brandSlug: "vero-moda", optionKey: "VM10001BLACK", keySource: "master" } as never).returning();
  await db.insert(catalogChannelListings).values([
    { optionId: opt!.id, channel: "noon", market: "ae", status: "live" },
    { optionId: opt!.id, channel: "namshi", market: "ae", status: "live" },
    { optionId: opt!.id, channel: "amazon", market: "ae", status: "not_listed" },
  ] as never);
}, 180_000);
afterAll(async () => { await close?.(); });

describe("candidate keys from dropped names", () => {
  it("reads the identifier and the folder names, normalised", () => {
    expect(candidateKeys("AW26/VM-10001-BLACK/VM-10001-BLACK_1.jpg")).toEqual(["VM10001BLACK", "AW26"]);
    expect(candidateKeys("vm_10002_white_2.png")).toEqual(["VM10002WHITE"]);
    expect(candidateKeys("8901234567890_1.jpg")).toEqual(["8901234567890"]);
  });
});

describe("brand inference (M1-F2-R3)", () => {
  it("infers the brand when every resolved identifier is that brand's", async () => {
    const r = await inferBrand(db, ["drop/VM10001BLACK_1.jpg", "drop/VM10001BLACK_2.jpg", "drop/VM-10002-WHITE_1.jpg", "drop/unknown-thing_1.jpg"]);
    expect(r).toMatchObject({ brandSlug: "vero-moda", resolved: 2, total: 3 });
  });

  it("matches by EAN and by products made before", async () => {
    expect((await inferBrand(db, ["8901234567890_1.jpg"])).brandSlug).toBe("uspa");
    expect((await inferBrand(db, ["US-OLD-99/front.jpg"])).brandSlug).toBe("uspa");
  });

  it("asks (null) when under 90% of the resolved identifiers are one brand, or nothing resolves", async () => {
    const names = ["VM10001BLACK_1.jpg", "VM10002WHITE_1.jpg", "VM10003NAVY_1.jpg", "US20001RED_1.jpg"];
    expect(await inferBrand(db, names)).toMatchObject({ brandSlug: null, resolved: 4 });
    expect(await inferBrand(db, ["IMG_0001.jpg", "IMG_0002.jpg"])).toMatchObject({ brandSlug: null, resolved: 0 });
    expect(await inferBrand(db, [])).toMatchObject({ brandSlug: null, resolved: 0, total: 0 });
  });
});

describe("default channels (M1-F2-R4)", () => {
  it("are the channels where the brand's options are listed", async () => {
    expect(await defaultChannels(db, "vero-moda")).toEqual(["noon", "namshi"]);
    expect(await channelDefaults(db, "vero-moda")).toEqual({ channels: ["noon", "namshi"], source: "listed" });
  });
  it("are the five slice channels for a brand with no listings", async () => {
    expect(SLICE_CHANNELS).toEqual(["namshi", "noon", "trendyol", "styli", "centrepoint"]);
    expect(await defaultChannels(db, "uspa")).toEqual(SLICE_CHANNELS);
    expect((await channelDefaults(db, "uspa")).source).toBe("slice");
  });
});
