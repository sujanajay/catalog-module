// M5-S3: pipelines read the snapshot (M5 3.3, F4-R4, F4-R8, C10). A batch pins the ruleset version it read at Start
// and keeps it through a later publish; the background check and the compliance numbers come from the snapshot and its
// channel rows; when the snapshot table cannot be read, the snapshot file in private storage stands in.
// PGlite with the real migrations and seeds.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import { createTestDb } from "../db/testing";
import { seedTaxonomy } from "../analyze/taxonomy-seed";
import { seedChannelRules } from "./rules/seed";
import { loadSnapshot } from "./rules/store";
import { snapshotFilePath, type SnapshotFileStorage } from "./rules/snapshot-file";
import { analyseBackground } from "./shadow";
import { CHANNEL_ORDER, CHANNELS } from "./channels";
import { channelRulesLoader, FIXTURE_CHANNEL_RULES, pinRuleset, rulesDatabaseUnavailable, snapshotBackgroundBreach } from "./channel-rules";
import { publishChannelChange, publishRuleChange } from "./channel-rules-testing";
import { checkOutput } from "./compliance";
import { renderSource, type Matte, type Prepared } from "./render";

vi.setConfig({ testTimeout: 120_000 });

let db: Db, close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 120_000);
afterAll(async () => close());

/** An in-memory private bucket "assets" with the calls the snapshot file uses. */
function fakeStorage() {
  const objects = new Map<string, Buffer>(), uploads: string[] = [];
  const storage: SnapshotFileStorage = {
    getBucketName: () => "assets",
    uploadBuffer: async (path, buf) => { uploads.push(path); objects.set(`gs://assets/${path}`, buf); return `gs://assets/${path}`; },
    downloadBuffer: async (uri) => { const buf = objects.get(uri); if (!buf) throw new Error(`No object ${uri}`); return { buf, mime: "application/json" }; },
    headObject: async (uri) => (objects.has(uri) ? { exists: true, size: objects.get(uri)!.length, contentType: "application/json", generation: "1", crc32c: null } : { exists: false, size: null, contentType: null, generation: null, crc32c: null }),
    listObjects: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
  };
  return { storage, objects, uploads };
}
/** A database whose every query fails, as when the rules database is down. */
const brokenDb = { select: () => { throw new Error("connect ECONNREFUSED"); } } as unknown as Db;

function fixture(box: { x0: number; x1: number; y0: number; y1: number }): { prepared: Prepared; matte: Matte } {
  const width = 800, height = 800, rgb = Buffer.alloc(width * height * 3, 255), alpha = Buffer.alloc(width * height);
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) { const i = y * width + x; rgb[i * 3] = 40; rgb[i * 3 + 1] = 60; rgb[i * 3 + 2] = 150; alpha[i] = 255; }
  return { prepared: { width, height, rgb, alphaSource: null, background: analyseBackground(rgb, width, height), flags: [], sourceMime: "image/png" }, matte: { alpha, width, height, model: "synthetic", ms: 0, source: "model", target: "cpu", sentLongSide: null } };
}

describe("M5-S3 pinning: nothing published yet", () => {
  it("a Start before any ruleset is published pins nothing (the batch then reads the latest, as before)", async () => {
    const { storage, uploads } = fakeStorage();
    expect(await pinRuleset(db, { storage })).toBeNull();
    expect(uploads).toEqual([]);
  });
});

describe("M5-S3 background rules from the snapshot (F4-R4, C10)", () => {
  beforeAll(async () => {
    await seedTaxonomy(db);
    await seedChannelRules(db);
  }, 120_000);

  it("seeded v2: every channel's canvas colours pass, the same as the channels.ts rule", async () => {
    const rules = await channelRulesLoader(db)();
    expect(rules.rulesetVersion).toBe(2);
    for (const id of CHANNEL_ORDER) for (const n of [1, 2, 3]) {
      expect(rules.backgroundBreach(id, n), `${id} ${n}`).toBeNull();
      expect(FIXTURE_CHANNEL_RULES.backgroundBreach(id, n)).toBeNull();
    }
  });

  it("a grey under 240 blocks on R086, a grey Amazon image 1 blocks on R228, a grey Shein image 1 only warns (R229 assumed)", async () => {
    const v2 = (await loadSnapshot(db, 2))!;
    const noon = snapshotBackgroundBreach(v2, { ...CHANNELS.noon, background: "#EFEFEF" }, 2);
    expect(noon).toMatch(/239/);
    expect(noon).toMatch(/240/);
    expect(snapshotBackgroundBreach(v2, { ...CHANNELS.noon, background: "#F0F0F0" }, 2)).toBeNull();
    // A pure white canvas is 240 or more too.
    expect(snapshotBackgroundBreach(v2, { ...CHANNELS.trendyol, background: "#FFFFFF" }, 1)).toBeNull();
    const amazon = snapshotBackgroundBreach(v2, { ...CHANNELS.amazon, firstImageBackground: "#F0F0F0" }, 1);
    expect(amazon).toMatch(/FFFFFF|255/);
    expect(snapshotBackgroundBreach(v2, { ...CHANNELS.amazon, firstImageBackground: "#F0F0F0" }, 2)).toBeNull();
    const { firstImageBackground: _white, ...greyShein } = CHANNELS.shein;
    expect(snapshotBackgroundBreach(v2, greyShein, 1)).toBeNull();
    expect(snapshotBackgroundBreach(v2, { ...CHANNELS.noon, background: "grey" }, 2)).toMatch(/#RRGGBB/);
  });

  it("an admin raising R086 to 245 makes the 240 grey fail in the new version only; the fixture and the pinned version are unchanged", async () => {
    const load = channelRulesLoader(db);
    const before = await load(2);
    const version = await publishRuleChange(db, "R086", { value: 245 });
    const after = await load(version);
    expect(after.backgroundBreach("noon", 2)).toMatch(/245/);
    expect(after.backgroundBreach("amazon", 1)).toBeNull();
    expect(before.backgroundBreach("noon", 2)).toBeNull();
    expect((await load(2)).backgroundBreach("noon", 2)).toBeNull();
    expect(FIXTURE_CHANNEL_RULES.backgroundBreach("noon", 2)).toBeNull();
    // The render of the new version fails compliance on the canvas colour (background_light); the pinned one passes.
    const box = { x0: 250, x1: 550, y0: 150, y1: 650 };
    const failing = await renderSource({ ...fixture(box), channel: "noon", shotNumber: 2, productType: "apparel_flat", channelRules: after });
    expect(failing.compliance.failures.map((f) => f.split(":")[0])).toContain("background_light");
    const passing = await renderSource({ ...fixture(box), channel: "noon", shotNumber: 2, productType: "apparel_flat", channelRules: before });
    expect(passing.compliance).toMatchObject({ ok: true, failures: [] });
    // Put R086 back for the tests below.
    await publishRuleChange(db, "R086", { value: 240 });
  });
});

describe("M5-S3 compliance numbers come from the channel row (F4-R4)", () => {
  it("the wide-shot side margin is the row's: 5% passes, a row asking 10% fails with its own number", async () => {
    const rules = await channelRulesLoader(db)();
    const noon = rules.spec("noon");
    const out = await renderSource({ ...fixture({ x0: 100, x1: 700, y0: 300, y1: 500 }), channel: "noon", shotNumber: 2, productType: "apparel_flat", channelRules: rules });
    expect(out.compliance).toMatchObject({ ok: true, failures: [] });
    const input = { jpeg: out.jpeg!, channel: "noon" as const, shotNumber: 2, plan: out.plan, identifier: "x", n: 2, publicObjectPath: "x_2.jpg", rules };
    expect((await checkOutput({ ...input, spec: noon })).failures).toEqual([]);
    const wider = await checkOutput({ ...input, spec: { ...noon, margins: { ...noon.margins, left: 0.1, right: 0.1 } } });
    expect(wider.failures).toContain("noon_wide: Wide Noon shots need at least 10% side margins.");
    // A channel row without the wide-shot flag has no wide-shot check, whatever its id.
    const flat = await checkOutput({ ...input, spec: { ...noon, margins: { ...noon.margins, left: 0.1, right: 0.1, sidesOnlyWhenWide: false } } });
    expect(flat.failures.map((f) => f.split(":")[0])).not.toContain("noon_wide");
  });

  it("the bottom guide is the row's bottom margin: Styli's 450 px passes, a row asking 400 px fails the guide", async () => {
    const rules = await channelRulesLoader(db)();
    const styli = rules.spec("styli");
    const out = await renderSource({ ...fixture({ x0: 250, x1: 550, y0: 150, y1: 650 }), channel: "styli", shotNumber: 2, productType: "apparel_flat", channelRules: rules });
    expect(out.compliance).toMatchObject({ ok: true, failures: [] });
    const input = { jpeg: out.jpeg!, channel: "styli" as const, shotNumber: 2, plan: out.plan, identifier: "x", n: 2, publicObjectPath: "x_2.jpg", rules, ...(out.foregroundMask ? { foregroundMask: out.foregroundMask } : {}) };
    expect((await checkOutput({ ...input, spec: styli })).failures).toEqual([]);
    const moved = await checkOutput({ ...input, spec: { ...styli, margins: { ...styli.margins, bottom: 400 } } });
    expect(moved.failures.map((f) => f.split(":")[0])).toContain("styli_anchor");
    expect(moved.measured.anchorDelta?.dy).toBe(50);
  });
});

describe("M5-S3 batch pinning and the snapshot file (M5 3.3, F4-R8)", () => {
  it("Start pins the latest version and writes its snapshot file once; a later publish never reaches the pinned version", async () => {
    const { storage, objects, uploads } = fakeStorage();
    const pin = await pinRuleset(db, { storage });
    const latest = (await loadSnapshot(db))!;
    expect(pin).toEqual({ version: latest.version, source: "database" });
    expect(uploads).toEqual([snapshotFilePath(latest.version)]);
    expect(JSON.parse(objects.get(`gs://assets/rules/snapshots/v${latest.version}.json`)!.toString("utf8"))).toEqual(latest);
    // A second Start on the same version finds the file and writes nothing.
    expect(await pinRuleset(db, { storage })).toEqual(pin);
    expect(uploads).toHaveLength(1);

    const load = channelRulesLoader(db, { storage });
    const pinned = await load(pin!.version);
    const published = await publishChannelChange(db, "noon", { background: "#F8F8F8" });
    expect((await load(pin!.version)).spec("noon").background).toBe(pinned.spec("noon").background);
    expect((await load(pin!.version)).keyVersion("noon")).toBe(pinned.keyVersion("noon"));
    expect((await load(published)).spec("noon").background).toBe("#F8F8F8");
    expect((await load()).rulesetVersion).toBe(published);
    // The next Start pins the new version.
    expect((await pinRuleset(db, { storage }))!.version).toBe(published);
  });

  it("a failed snapshot file write never stops a Start", async () => {
    const { storage } = fakeStorage(), logs: string[] = [];
    const failing: SnapshotFileStorage = { ...storage, uploadBuffer: async () => { throw new Error("403 forbidden"); } };
    const pin = await pinRuleset(db, { storage: failing, log: (_s, message) => logs.push(message) });
    expect(pin?.source).toBe("database");
    expect(logs).toEqual(["rules snapshot file not written"]);
  });

  it("with the snapshot table unreadable, Start uses the newest snapshot file and logs the F4-R8 line; a pinned read does the same", async () => {
    const { storage } = fakeStorage();
    const first = (await pinRuleset(db, { storage }))!;
    const logs: { severity: string; message: string }[] = [], log = (severity: string, message: string) => logs.push({ severity, message });
    const pin = await pinRuleset(brokenDb, { storage, log });
    expect(pin).toEqual({ version: first.version, source: "file" });
    expect(logs).toEqual([{ severity: "WARNING", message: rulesDatabaseUnavailable(first.version) }]);
    expect(rulesDatabaseUnavailable(7)).toBe("rules database unavailable; used snapshot v7");

    const rules = await channelRulesLoader(brokenDb, { storage, log })(first.version);
    expect(rules.rulesetVersion).toBe(first.version);
    expect(rules.spec("noon").background).toBe("#F8F8F8");
    expect(rules.backgroundBreach("noon", 2)).toBeNull();
    expect((await channelRulesLoader(brokenDb, { storage, log })()).rulesetVersion).toBe(first.version);
    expect(logs.every((l) => l.message === rulesDatabaseUnavailable(first.version))).toBe(true);

    // No file either: the read error stands (no fallback to channels.ts).
    const empty = fakeStorage().storage;
    await expect(pinRuleset(brokenDb, { storage: empty })).rejects.toThrow(/ECONNREFUSED/);
    await expect(channelRulesLoader(brokenDb, { storage: empty })(first.version)).rejects.toThrow(/ECONNREFUSED/);
    await expect(channelRulesLoader(brokenDb)(first.version)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("a pinned version that was never published is an error, not the latest", async () => {
    await expect(channelRulesLoader(db)(999)).rejects.toThrow(/Ruleset version 999 is not published/);
  });
});
