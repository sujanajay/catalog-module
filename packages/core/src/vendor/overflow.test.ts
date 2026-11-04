import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { catalogCostEvents } from "../db/schema";
import { ledgerOverflowGate } from "./overflow";
import { IMAGE_SEED_ROUTES } from "./routes";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({db, close} = await createTestDb()); }, 120_000);
afterAll(async () => close());
beforeEach(async () => { await db.delete(catalogCostEvents); });

const vendor = {...IMAGE_SEED_ROUTES.find(r => r.capability === "image.matte" && r.adapter === "photoroom")!, state: "serving" as const, dailyCapUsd: 0.05};
const at = new Date("2031-03-04T10:00:00Z");
const row = (usd: number, when: Date, kind: "matte_call" | "upscale_call" = "matte_call", engine = "photoroom") =>
  ({stage: "matte" as const, kind, engine, usd, at: when, isTest: true});

describe("M3-F2-R3 overflow daily cap", () => {
  it("a route without a cap is never called", async () => {
    expect(await ledgerOverflowGate(db, {now: () => at}).reserve({...vendor, dailyCapUsd: null})).toMatchObject({ok: false, reason: "no_cap"});
  });
  it("counts today's ledger rows of the route's engine and kind, plus this process's reservations", async () => {
    // Yesterday's spend, another kind and another engine do not count.
    await db.insert(catalogCostEvents).values([row(0.02, at), row(1, new Date("2031-03-03T23:59:00Z")), row(1, at, "upscale_call"), row(1, at, "matte_call", "gpu")]);
    const gate = ledgerOverflowGate(db, {now: () => at});
    expect(await gate.reserve(vendor)).toMatchObject({ok: true, spentUsd: 0.02});
    // 0.02 recorded + 0.02 reserved + 0.02 would pass 0.05.
    expect(await gate.reserve(vendor)).toMatchObject({ok: false, reason: "over_cap", spentUsd: 0.04, capUsd: 0.05});
  });
  it("parallel reservations of one process never pass the cap together", async () => {
    const gate = ledgerOverflowGate(db, {now: () => at});
    const results = await Promise.all(Array.from({length: 5}, () => gate.reserve({...vendor, dailyCapUsd: 0.04})));
    expect(results.filter(r => r.ok)).toHaveLength(2);
  });
});
