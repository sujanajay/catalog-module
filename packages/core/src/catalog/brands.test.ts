import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import { brandMaster } from "../db/schema";
import { createTestDb } from "../db/testing";
import { addManualBrand, listBrandOptions } from "./brands";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  vi.spyOn(console, "log").mockImplementation(() => {});
  await db.insert(brandMaster).values([
    { name: "Tower", slug: "tower", line: "hardline", source: "warehouse" },
    { name: "USPA", slug: "uspa", line: "softline", source: "warehouse" },
    { name: "Bergner", slug: "bergner", line: "hardline", source: "warehouse" },
    { name: "CAMPUS", slug: "campus", line: "softline", source: "warehouse" },
  ]);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await close();
});

describe("brands", () => {
  it("lists softline first, then hardline, each sorted by name", async () => {
    expect((await listBrandOptions(db)).map((b) => b.name)).toEqual(["CAMPUS", "USPA", "Bergner", "Tower"]);
  });

  it("addManualBrand is idempotent on the slug and never overwrites a warehouse brand", async () => {
    const anta = await addManualBrand(db, { name: " Anta ", line: "softline", createdBy: "admin@opptra.com" });
    expect(anta).toEqual({ slug: "anta", name: "Anta", line: "softline", source: "manual" });
    expect(await addManualBrand(db, { name: "ANTA", line: "hardline", createdBy: "admin@opptra.com" })).toEqual(anta);
    expect(await addManualBrand(db, { name: "uspa", line: "hardline", createdBy: "admin@opptra.com" })).toEqual({
      slug: "uspa", name: "USPA", line: "softline", source: "warehouse",
    });
    expect((await listBrandOptions(db)).map((b) => b.slug)).toEqual(["anta", "campus", "uspa", "bergner", "tower"]);
    await expect(addManualBrand(db, { name: "  ", line: "softline", createdBy: "a" })).rejects.toThrow(/empty/);
  });
});
