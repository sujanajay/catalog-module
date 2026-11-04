// M3-S1: the render reads the M5 channel registry (M3-F3-R1 to R4). PGlite with the real migrations and seeds.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { Db } from "../db/client";
import { createTestDb } from "../db/testing";
import { catalogChannelListings, catalogOptions, catalogTreatmentAssignments } from "../db/schema";
import { seedTaxonomy } from "../analyze/taxonomy-seed";
import { seedChannelRules } from "./rules/seed";
import { analyseBackground } from "./shadow";
import { backgroundRuleBreach, CHANNEL_ORDER, CHANNEL_RULES_VERSION, CHANNELS } from "./channels";
import { channelRulesLoader, channelRulesOf, ChannelRulesError, FIXTURE_CHANNEL_RULES } from "./channel-rules";
import { publishChannelChange } from "./channel-rules-testing";
import { checkOutput } from "./compliance";
import { renderSource, type Matte, type Prepared } from "./render";
import { frozenChannels } from "./holdout";

vi.setConfig({ testTimeout: 120_000 });

let db: Db, close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 120_000);
afterAll(async () => close());

function fixture(): { prepared: Prepared; matte: Matte } {
  const width = 800, height = 800, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  // A product taller than wide, so every canvas (Amazon's square one too) shows background at its corners.
  for (let y = 150; y < 650; y++) for (let x = 250; x < 550; x++) { const i = y * width + x; rgb[i * 3] = 160; rgb[i * 3 + 1] = 30; rgb[i * 3 + 2] = 50; alpha[i] = 255; }
  return { prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/png" }, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null } };
}
/** The canvas colour at the corner, within 1 of `v` on each channel (a JPEG round trip of a flat colour). */
const expectCorner = async (jpeg: Buffer, v: number) => { for (const c of await sharp(jpeg).extract({ left: 2, top: 2, width: 1, height: 1 }).removeAlpha().raw().toBuffer()) expect(Math.abs(c - v)).toBeLessThanOrEqual(1); };

describe("M3-S1 background rule (M3-F3-R2)", () => {
  it("allows only a grey of 240 or more, and pure white for Amazon image 1", () => {
    const at = (id: keyof typeof CHANNELS, background: string, first?: string) => ({ ...CHANNELS[id], background, ...(first ? { firstImageBackground: first } : {}) });
    expect(backgroundRuleBreach(at("noon", "#F0F0F0"), 1)).toBeNull();
    expect(backgroundRuleBreach(at("noon", "#E0E0E0"), 1)).toMatch(/darker than 240/);
    expect(backgroundRuleBreach(at("noon", "#F0EFF0"), 2)).toMatch(/darker than 240/);
    expect(backgroundRuleBreach(at("noon", "grey"), 2)).toMatch(/#RRGGBB/);
    expect(backgroundRuleBreach(at("amazon", "#F0F0F0", "#FFFFFF"), 1)).toBeNull();
    expect(backgroundRuleBreach(at("amazon", "#F0F0F0", "#F8F8F8"), 1)).toMatch(/pure white/);
    expect(backgroundRuleBreach({ ...CHANNELS.amazon, firstImageBackground: undefined }, 1)).toMatch(/pure white/);
    expect(backgroundRuleBreach(at("amazon", "#F0F0F0", "#FFFFFF"), 2)).toBeNull();
    // Shein image 1 white is an assumed M5 row (R229), read from the row, not enforced by code.
    expect(backgroundRuleBreach({ ...CHANNELS.shein, firstImageBackground: undefined }, 1)).toBeNull();
  });

  it("the channels.ts fixture renders grey 240 and Amazon image 1 white on every channel", () => {
    for (const id of CHANNEL_ORDER) for (const n of [1, 2]) expect(backgroundRuleBreach(CHANNELS[id], n)).toBeNull();
    expect(CHANNELS.noon.background).toBe("#F0F0F0");
  });
});

describe("M3-S1 render from the M5 registry (M3-F3-R1, R3)", () => {
  it("stops with a clear error while no ruleset is published (no fallback to channels.ts, M5 D7)", async () => {
    await expect(channelRulesLoader(db)()).rejects.toBeInstanceOf(ChannelRulesError);
  });

  it("seeded: ruleset v2 gives back exactly the channels.ts values, keyed by each channel row's version", async () => {
    await seedTaxonomy(db);
    await seedChannelRules(db);
    const rules = await channelRulesLoader(db)();
    expect(rules.rulesetVersion).toBe(2);
    for (const id of CHANNEL_ORDER) {
      expect(rules.spec(id)).toEqual(CHANNELS[id]);
      expect(rules.keyVersion(id)).toBe(`${CHANNEL_RULES_VERSION}+c2`);
    }
    expect(FIXTURE_CHANNEL_RULES.keyVersion("noon")).toBe(CHANNEL_RULES_VERSION);
  });

  it("an admin change to Noon reaches the next read, changes only Noon's key, and the render uses it and passes", async () => {
    const load = channelRulesLoader(db), before = await load();
    const version = await publishChannelChange(db, "noon", { background: "#F5F5F5" });
    const after = await load();
    expect(after.rulesetVersion).toBe(version);
    expect(after.spec("noon").background).toBe("#F5F5F5");
    expect(after.keyVersion("noon")).not.toBe(before.keyVersion("noon"));
    for (const id of CHANNEL_ORDER.filter((c) => c !== "noon")) expect(after.keyVersion(id)).toBe(before.keyVersion(id));

    const out = await renderSource({ ...fixture(), channel: "noon", shotNumber: 2, productType: "apparel_flat", channelRules: after });
    expect(out.compliance).toMatchObject({ ok: true, failures: [] });
    await expectCorner(out.jpeg!, 245);
    // The fixture would have drawn the default grey: the registry, not the constant, decided the colour.
    const fixtureOut = await renderSource({ ...fixture(), channel: "noon", shotNumber: 2, productType: "apparel_flat" });
    await expectCorner(fixtureOut.jpeg!, 240);
  });

  it("Amazon image 1 renders pure white, image 2 the grey, both passing compliance", async () => {
    const rules = await channelRulesLoader(db)();
    const first = await renderSource({ ...fixture(), channel: "amazon", shotNumber: 1, productType: "apparel_flat", channelRules: rules });
    const second = await renderSource({ ...fixture(), channel: "amazon", shotNumber: 2, productType: "apparel_flat", channelRules: rules });
    expect(first.compliance.ok && second.compliance.ok).toBe(true);
    await expectCorner(first.jpeg!, 255);
    await expectCorner(second.jpeg!, 240);
  });

  it("a background row darker than 240 renders but fails compliance with background_light (M3-F3-R4)", async () => {
    const version = await publishChannelChange(db, "namshi", { background: "#E0E0E0" });
    const rules = await channelRulesLoader(db)();
    expect(rules.rulesetVersion).toBe(version);
    const out = await renderSource({ ...fixture(), channel: "namshi", shotNumber: 2, productType: "apparel_flat", channelRules: rules });
    expect(out.compliance.ok).toBe(false);
    expect(out.compliance.failures.some((f) => f.startsWith("background_light:"))).toBe(true);
    expect(out.flags).toContain("failed_compliance");
    // The check reads the spec it is given: the same JPEG against the fixture fails on the colour itself instead.
    const checked = await checkOutput({ jpeg: out.jpeg ?? Buffer.alloc(0), channel: "namshi", spec: rules.spec("namshi"), shotNumber: 2, plan: out.plan, identifier: "x", n: 2, publicObjectPath: "x_2.jpg" });
    expect(checked.failures.map((f) => f.split(":")[0])).toContain("background_light");
  });

  it("a snapshot without a channel row (or with it retired) is an error, never a silent default", () => {
    const rules = channelRulesOf({ version: 9, channels: [] });
    expect(() => rules.spec("noon")).toThrow(ChannelRulesError);
    expect(() => rules.keyVersion("noon")).toThrow(ChannelRulesError);
  });
});

describe("M3-S1 holdout guard (M3-F3-R3)", () => {
  it("names the channels whose listing is a frozen control, and nothing for an option with no key or no assignment", async () => {
    const [option] = await db.insert(catalogOptions).values({ brandSlug: "anta", optionKey: "M3S1-CONTROL", keySource: "master" }).returning();
    const [noon] = await db.insert(catalogChannelListings).values({ optionId: option!.id, channel: "noon", market: "ae" }).returning();
    await db.insert(catalogChannelListings).values({ optionId: option!.id, channel: "amazon", market: "ae" });
    expect(await frozenChannels(db, option!.id, ["noon", "amazon"])).toEqual([]);
    await db.insert(catalogTreatmentAssignments).values({ experimentId: "exp-1", listingId: noon!.id, arm: "control", doNotTouch: true });
    expect(await frozenChannels(db, option!.id, ["noon", "amazon"])).toEqual([{ channel: "noon", reason: "frozen_control", experimentId: "exp-1" }]);
    expect(await frozenChannels(db, null, ["noon", "amazon"])).toEqual([]);
    expect(await frozenChannels(db, option!.id, ["amazon"])).toEqual([]);
  });
});
