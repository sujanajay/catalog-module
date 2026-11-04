// Tier 2 (PGlite): the M12-S1 settings store. Versions, typed validation, levels and the cascade, owner-only settings,
// revert, and the batch snapshot that a later change never reaches (M12 3.3 rule 1).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { brandMaster, catalogSettingsSnapshots, catalogSettingVersions } from "../db/schema";
import { createTestDb } from "../db/testing";
import { seedTaxonomy } from "../analyze/taxonomy-seed";
import { AUTO_DECIDE_CAUSES, DEFAULT_OWNERS, OWNERS_KEY, SETTING_AREAS, SETTING_DEFS, UPSCALE_MIN_SCALE_KEY } from "./registry";
import { scopeKey, settingFrom } from "./snapshot";
import { changeSetting, currentValue, isOwner, loadSettingsSnapshot, ownersOf, revertSetting, SettingsError, settingHistory, takeSettingsSnapshot } from "./store";

const OWNER = DEFAULT_OWNERS[0]!;
const ADMIN = "naaz@opptra.com";
let db: Db, close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedTaxonomy(db);
  await db.insert(brandMaster).values({ slug: "campus", name: "Campus", line: "softline", source: "manual" }).onConflictDoNothing();
}, 120_000);
afterAll(async () => { await close(); });
beforeEach(async () => { await db.delete(catalogSettingVersions); });

async function refused(p: Promise<unknown>): Promise<SettingsError> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SettingsError);
  return err as SettingsError;
}

describe("registry", () => {
  it("gives every setting a plain label, a known area, a default that passes its own type, and unique keys", () => {
    expect(new Set(SETTING_DEFS.map((d) => d.key)).size).toBe(SETTING_DEFS.length);
    for (const d of SETTING_DEFS) {
      expect(SETTING_AREAS).toContain(d.area);
      expect(d.label.length).toBeGreaterThan(3);
      expect(d.help).toMatch(/\.$/);
    }
    // The M1-F3 auto-decide rules are registered per cause, settable per channel (M1-S3 moves onto them).
    for (const cause of AUTO_DECIDE_CAUSES) expect(SETTING_DEFS.find((d) => d.key === `intake.auto_decide.${cause}`)?.scopes).toEqual(["channel"]);
  });

  it("writes a scope as one canonical key whatever the order or empty levels", () => {
    expect(scopeKey({})).toBe("");
    expect(scopeKey({ brand: "campus", channel: "noon" })).toBe("channel=noon;brand=campus");
    expect(scopeKey({ channel: undefined, category: "fashion.footwear" })).toBe("category=fashion.footwear");
  });
});

describe("changeSetting", () => {
  it("versions each change at its level, keeps who and why, and the value applies at once to new reads", async () => {
    expect(await currentValue(db, "intake.start_countdown_seconds")).toBe(10);
    const first = await changeSetting(db, { key: "intake.start_countdown_seconds", value: 5, reason: "Faster start." }, ADMIN);
    expect(first).toMatchObject({ risk: "normal", effective: "next_batch", version: { version: 1, value: 5, changedBy: ADMIN, reason: "Faster start.", scopeKey: "" } });
    const second = await changeSetting(db, { key: "intake.start_countdown_seconds", value: "0" }, ADMIN);
    expect(second.version).toMatchObject({ version: 2, value: 0, reason: null });
    expect(await currentValue(db, "intake.start_countdown_seconds")).toBe(0);
    expect((await settingHistory(db, "intake.start_countdown_seconds")).map((v) => v.version)).toEqual([2, 1]);
  });

  it("refuses values outside the type or range, unknown settings, levels it cannot be set at and unchanged values", async () => {
    expect((await refused(changeSetting(db, { key: "intake.start_countdown_seconds", value: 61 }, ADMIN))).message).toBe("Countdown before a batch starts: enter a number from 0 to 60.");
    expect((await refused(changeSetting(db, { key: "intake.start_countdown_seconds", value: 2.5 }, ADMIN))).status).toBe(400);
    expect((await refused(changeSetting(db, { key: "intake.auto_start", value: "yes" }, ADMIN))).status).toBe(400);
    expect((await refused(changeSetting(db, { key: "intake.auto_decide.corrupt", value: "hold" }, ADMIN))).status).toBe(400);
    expect((await refused(changeSetting(db, { key: "nothing.here", value: 1 }, ADMIN))).status).toBe(404);
    expect((await refused(changeSetting(db, { key: "intake.start_countdown_seconds", scope: { channel: "noon" }, value: 3 }, ADMIN))).message).toBe("Countdown before a batch starts cannot be set for one channel.");
    expect((await refused(changeSetting(db, { key: "intake.auto_start", scope: { brand: "nobody" }, value: false }, ADMIN))).message).toBe("There is no brand called nobody.");
    await changeSetting(db, { key: "intake.auto_start", value: false }, ADMIN);
    expect((await refused(changeSetting(db, { key: "intake.auto_start", value: false }, ADMIN))).status).toBe(409);
    expect(await db.select().from(catalogSettingVersions)).toHaveLength(1);
  });

  it("cascades programme, channel, category, brand: the most specific level that has a value wins", async () => {
    const key = "intake.auto_decide.unusable";
    await changeSetting(db, { key, scope: { channel: "noon" }, value: "drop" }, ADMIN);
    expect(await currentValue(db, key, { channel: "noon" })).toBe("drop");
    expect(await currentValue(db, key, { channel: "namshi" })).toBe("deliver");
    expect(await currentValue(db, key)).toBe("deliver");
    // A category value covers the nodes under it; a brand value beats a category value (unit check on the cascade).
    const versions = [
      { id: "a", key: "k", scope: { category: "fashion.footwear" }, version: 1, value: 1 },
      { id: "b", key: "k", scope: { channel: "noon" as const }, version: 1, value: 2 },
      { id: "c", key: "k", scope: { brand: "campus" }, version: 1, value: 3 },
      { id: "d", key: "k", scope: { brand: "campus", channel: "noon" as const }, version: 1, value: 4 },
    ];
    const snap = { format: 1 as const, defaults: { k: 0 }, versions, taxonomyRevision: 0 };
    expect(settingFrom(snap, "k", { category: "fashion.footwear.sneakers", channel: "noon" })).toBe(1);
    expect(settingFrom(snap, "k", { category: "fashion.apparel", channel: "noon" })).toBe(2);
    expect(settingFrom(snap, "k", { brand: "campus", category: "fashion.footwear" })).toBe(3);
    expect(settingFrom(snap, "k", { brand: "campus", channel: "noon", category: "fashion.footwear" })).toBe(4);
    expect(settingFrom(snap, "k", {})).toBe(0);
  });

  it("lets only an owner change an owner-only setting, and refuses with a sentence naming the owners", async () => {
    expect(await ownersOf(db)).toEqual([...DEFAULT_OWNERS]);
    expect(await isOwner(db, OWNER.toUpperCase())).toBe(true);
    const err = await refused(changeSetting(db, { key: UPSCALE_MIN_SCALE_KEY, value: 1.5 }, ADMIN));
    expect(err.status).toBe(403);
    expect(err.message).toBe(`Only an owner can change enlarge with the quality pass above. Ask ${OWNER}.`);
    expect((await changeSetting(db, { key: UPSCALE_MIN_SCALE_KEY, value: 1.5 }, OWNER)).risk).toBe("needs_owner");
    // The owner list itself: addresses of the allowed domain only, never empty, stored lowercased and sorted.
    expect((await refused(changeSetting(db, { key: OWNERS_KEY, value: ["x@gmail.com"] }, OWNER))).status).toBe(400);
    expect((await refused(changeSetting(db, { key: OWNERS_KEY, value: [] }, OWNER))).message).toBe("Owners: keep at least 1.");
    await changeSetting(db, { key: OWNERS_KEY, value: `${OWNER}, ${ADMIN.toUpperCase()}` }, OWNER);
    expect(await ownersOf(db)).toEqual([ADMIN, OWNER].sort());
    expect((await changeSetting(db, { key: UPSCALE_MIN_SCALE_KEY, value: 2 }, ADMIN)).version.version).toBe(2);
  });
});

describe("revertSetting", () => {
  it("restores the value before a change as a new version; undoing the first value goes back to the level above", async () => {
    const key = "intake.improve_tries";
    const v1 = await changeSetting(db, { key, value: 5 }, ADMIN);
    const v2 = await changeSetting(db, { key, value: 7 }, ADMIN);
    const undo = await revertSetting(db, v2.version.id, ADMIN);
    expect(undo.version).toMatchObject({ version: 3, value: 5, revertsVersionId: v2.version.id, reason: "Undo of version 2." });
    expect(await currentValue(db, key)).toBe(5);
    expect((await refused(revertSetting(db, v2.version.id, ADMIN))).status).toBe(409);
    const back = await revertSetting(db, v1.version.id, ADMIN);
    expect(back.version).toMatchObject({ version: 4, value: null });
    expect(await currentValue(db, key)).toBe(3);
    expect((await refused(revertSetting(db, "00000000-0000-0000-0000-000000000000", ADMIN))).status).toBe(404);
  });

  it("keeps owner-only settings owner-only on revert", async () => {
    const v = await changeSetting(db, { key: UPSCALE_MIN_SCALE_KEY, value: 1.5 }, OWNER);
    expect((await refused(revertSetting(db, v.version.id, ADMIN))).status).toBe(403);
  });
});

describe("takeSettingsSnapshot (M12-S1 acceptance, store side)", () => {
  it("records the version set at Start; a change after it reaches the next snapshot only", async () => {
    const key = "intake.auto_decide.corrupt";
    const v1 = await changeSetting(db, { key, scope: { channel: "noon" }, value: "deliver" }, ADMIN);
    const a = await takeSettingsSnapshot(db, { by: ADMIN });
    await changeSetting(db, { key, scope: { channel: "noon" }, value: "drop" }, ADMIN);
    await changeSetting(db, { key: UPSCALE_MIN_SCALE_KEY, value: 1.5 }, OWNER);
    const b = await takeSettingsSnapshot(db, { by: ADMIN });

    const storedA = (await loadSettingsSnapshot(db, a.id))!;
    expect(settingFrom(storedA, key, { channel: "noon" })).toBe("deliver");
    expect(settingFrom(storedA, UPSCALE_MIN_SCALE_KEY)).toBe(1);
    expect(storedA.versions.map((v) => v.id)).toEqual([v1.version.id]);
    expect(storedA.taxonomyRevision).toBeGreaterThan(0);
    expect(storedA.defaults[UPSCALE_MIN_SCALE_KEY]).toBe(1);

    const storedB = (await loadSettingsSnapshot(db, b.id))!;
    expect(settingFrom(storedB, key, { channel: "noon" })).toBe("drop");
    expect(settingFrom(storedB, UPSCALE_MIN_SCALE_KEY)).toBe(1.5);
    expect(storedB.versions.map((v) => v.version).sort()).toEqual([1, 2]);
    expect((await db.select().from(catalogSettingsSnapshots).where(eq(catalogSettingsSnapshots.id, b.id)))[0]!.createdBy).toBe(ADMIN);
  });
});
