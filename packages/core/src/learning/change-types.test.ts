// Tier 2 (PGlite): M10-S1a change-type library v0. Every M10-F1-R1 type exists in the table with component, action,
// cost class and channels, the migration's seed equals CHANGE_TYPE_SEED, and readers see the table, not the constant.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_IDS } from "../catalog/types";
import type { Db } from "../db/client";
import { catalogChangeTypes } from "../db/schema";
import { createTestDb } from "../db/testing";
import { COMPONENTS } from "../graph/types";
import { CHANGE_ACTIONS, CHANGE_TYPE, CHANGE_TYPE_SEED, CHANGE_TYPES_V0, changeTypeById, COST_CLASSES, loadChangeTypes } from "./change-types";

/** The M10-F1-R1 list, as the requirement names it. */
const F1_R1 = [
  "img_shotset_crops", "img_shotset_generated", "img_main_replaced", "img_reordered", "img_background_fixed", "img_upscaled",
  "img_footwear_views_added", "title_rewritten_en", "title_arabic_added", "bullets_added", "attributes_completed",
  "keyword_added_title", "keyword_added_backend", "infographic_added", "size_chart_added",
];

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 120_000);
afterAll(async () => { await close(); });

describe("change-type library v0", () => {
  it("has every F1-R1 type in the table with a component, action, cost class and channels", async () => {
    const rows = await loadChangeTypes(db);
    expect(rows.map((r) => r.id).sort()).toEqual([...F1_R1].sort());
    for (const r of rows) {
      expect(COMPONENTS).toContain(r.component);
      expect(CHANGE_ACTIONS).toContain(r.action);
      expect(COST_CLASSES).toContain(r.costClass);
      expect(r.channels.length).toBeGreaterThan(0);
      for (const c of r.channels) expect(CHANNEL_IDS).toContain(c);
      expect(r).toMatchObject({ status: "active", sinceVersion: CHANGE_TYPES_V0, orgId: "opptra" });
    }
  });

  it("seeds exactly CHANGE_TYPE_SEED (the typed ids producers stamp)", async () => {
    const rows = await loadChangeTypes(db);
    expect(rows.map(({ id, name, component, action, costClass, channels }) => ({ id, name, component, action, costClass, channels })).sort((a, b) => a.id.localeCompare(b.id)))
      .toEqual(CHANGE_TYPE_SEED.map((t) => ({ ...t, channels: [...t.channels] })).sort((a, b) => a.id.localeCompare(b.id)));
    expect(CHANGE_TYPE.img_shotset_crops).toBe("img_shotset_crops");
    expect(await changeTypeById(db, "img_upscaled")).toMatchObject({ component: "image", action: "replace", costClass: "compute" });
    expect(await changeTypeById(db, "nope")).toBeNull();
  });

  it("refuses a bad id, component, action or cost class; retired types are hidden by default", async () => {
    const base = { id: "x_type", name: "X", component: "image" as const, action: "add" as const, costClass: "negligible" as const, channels: ["noon" as const], sinceVersion: 2 };
    await expect(db.insert(catalogChangeTypes).values({ ...base, id: "Bad.Id" })).rejects.toThrow();
    await expect(db.insert(catalogChangeTypes).values({ ...base, component: "video" as never })).rejects.toThrow();
    await expect(db.insert(catalogChangeTypes).values({ ...base, action: "move" as never })).rejects.toThrow();
    await expect(db.insert(catalogChangeTypes).values({ ...base, costClass: "cheap" as never })).rejects.toThrow();
    await db.insert(catalogChangeTypes).values({ ...base, status: "retired" });
    expect((await loadChangeTypes(db)).some((r) => r.id === "x_type")).toBe(false);
    expect((await loadChangeTypes(db, { includeRetired: true })).some((r) => r.id === "x_type")).toBe(true);
    await db.delete(catalogChangeTypes).where(eq(catalogChangeTypes.id, "x_type"));
  });
});
