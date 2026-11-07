// Tier 2 (PGlite): M1 D45. With the setting on, a batch that finds a confirmed mark or a two-judge wrong item on a photo takes the older live
// image of that same photo down. Everything else keeps the image. Only under the product's prefix and on the batch's channels.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { createTestDb } from "../../db/testing";
import { catalogBatches, catalogBatchProducts, catalogChangeEvents, catalogOutputs, catalogProductEvents, catalogProducts, catalogSettingsSnapshots, catalogSourceImages, DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import { REJECTED_PHOTO_TAKE_DOWN_KEY, settingDef } from "../../settings/registry";
import { GenerationMismatchError } from "../../storage";
import { DEFAULT_AUTO_DECIDE_RULES, TAKE_DOWN_WHY, takeDownVerdict } from "../auto-decide";
import { FIXTURE_CHANNEL_RULES } from "../channel-rules";
import type { ChannelId, OutputFlag } from "../types";
import { NO_DELIVERABLE_PHOTO_REMOVED, planPublish, publishProduct, type Output, type PublishDeps } from "./publish";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { await close(); });

const HOLD = { auto_decide: { rule: "visible_defect:*", cause: "visible_defect", action: "hold" } };
type Row = { n: number; channel?: ChannelId; status: Output["status"]; flags?: OutputFlag[]; reason?: string; compliance?: unknown; qaScores?: unknown; sha?: string };
/** What the judge stage and the triage leave on a row: the verdict, then the triage's own record. */
const decided = (action: "drop" | "hold", extra: object) => ({ verdict: "flag", autoAction: action, finalStatus: action === "drop" ? "skipped" : "needs_attention", thresholds: { no_text_or_watermark: 75 }, ...extra });
const MARK_SCORES = { no_text_or_watermark: 20, evidence: { text_or_watermark: { sentence: "a star mark at the bottom right" } } };
const mark = (n: number, extra: Partial<Row> = {}): Row => ({ n, status: "skipped", flags: ["text_or_watermark", "auto_dropped"], reason: "A mark.", qaScores: decided("drop", MARK_SCORES), ...extra });
const wrong = (n: number, extra: Partial<Row> = {}): Row => ({ n, status: "skipped", flags: ["different_product", "auto_dropped"], reason: "Another item.", qaScores: decided("drop", { wrongItem: { first: true, second: true, confirmed: true } }), ...extra });

/** A product an older batch delivered on `liveChannels` with shots 1-3, and a new full batch on `channels` with `rows`. */
async function world(name: string, rows: Row[], options: { channels?: ChannelId[]; liveChannels?: ChannelId[]; append?: boolean; setting?: boolean | null; liveShots?: number[] } = {}) {
  const channels = options.channels ?? ["noon"], liveChannels = options.liveChannels ?? channels;
  const batchRow = (suffix: string, extra: object = {}) => ({ brandSlug: "anta", brandName: "Anta", name: `${name}${suffix}`, isTest: true, createdBy: "test@opptra.com", ...extra });
  const [old] = await db.insert(catalogBatches).values(batchRow("-old", { channels: liveChannels, status: "done" })).returning();
  // `setting`: the batch's settings snapshot says on or off; null is a batch with no snapshot. Default on, since most tests here are about the rule.
  const setting = options.setting === undefined ? true : options.setting;
  const settingsSnapshotId = setting === null ? null : crypto.randomUUID();
  if (settingsSnapshotId) await db.insert(catalogSettingsSnapshots).values({ id: settingsSnapshotId, data: { format: 1, defaults: { [REJECTED_PHOTO_TAKE_DOWN_KEY]: setting as boolean }, versions: [], taxonomyRevision: 0 }, createdBy: "test@opptra.com" });
  const [fresh] = await db.insert(catalogBatches).values(batchRow("-new", { settingsSnapshotId, channels, status: "publishing", options: { ...DEFAULT_BATCH_OPTIONS, autoDecide: { rules: [...DEFAULT_AUTO_DECIDE_RULES] }, ...(options.append ? { append: true } : {}) } })).returning();
  const product = async (key: string, lock: string | null) => (await db.insert(catalogProducts).values({ brandSlug: "anta", isTest: true, productKey: key, pathKey: key, identifier: key, lockBatchId: lock, lastBatchId: old!.id }).returning())[0]!;
  const main = await product(name, fresh!.id), sibling = await product(`${name}-sibling`, null);
  await db.insert(catalogBatchProducts).values({ batchId: fresh!.id, productId: main.id, change: "updated" });
  const path = (key: string, c: ChannelId, n: number) => `catalog-test/anta/${key}/${c}/${key}_${n}.jpg`;
  const common = (key: string, productId: string, c: ChannelId, n: number) => ({ productId, channel: c, n, canvasW: 800, canvasH: 1000, scale: 1, placedX: 0, placedY: 0, bytes: 4, objectPath: path(key, c, n), publicUrl: `https://storage.googleapis.com/public/${path(key, c, n)}` });
  for (const [key, id] of [[name, main.id], [`${name}-sibling`, sibling.id]] as const) {
    const sources = await db.insert(catalogSourceImages).values((options.liveShots ?? [1, 2, 3]).map(n => ({ batchId: old!.id, productId: id, n, sha256: `same${n}`, originalName: `${key}_${n}.jpg`, rawUri: `gs://assets/${key}-old${n}.jpg`, mime: "image/jpeg", isCurrent: true }))).returning();
    await db.insert(catalogOutputs).values(sources.flatMap(s => liveChannels.map(c => ({ ...common(key, id, c, s.n), batchId: old!.id, sourceImageId: s.id, renderKey: `old${s.n}${c}`, crc32c: "o", generation: 20, isLive: true, status: "verified" as const, publishedAt: new Date("2026-01-01T00:00:00Z") }))));
  }
  const sources = await db.insert(catalogSourceImages).values([...new Set(rows.map(r => r.n))].map(n => ({ batchId: fresh!.id, productId: main.id, n, sha256: rows.find(r => r.n === n)!.sha ?? `same${n}`, originalName: `${name}_${n}.jpg`, rawUri: `gs://assets/${name}-new${n}.jpg`, mime: "image/jpeg" }))).returning();
  await db.insert(catalogOutputs).values(rows.map(r => {
    const c = r.channel ?? channels[0]!;
    return { ...common(name, main.id, c, r.n), batchId: fresh!.id, sourceImageId: sources.find(s => s.n === r.n)!.id, renderKey: `new${r.n}${c}`, crc32c: "crc", stagingUri: `gs://assets/staged-${r.n}-${c}.jpg`, status: r.status, flags: r.flags ?? [], reason: r.reason ?? null, compliance: (r.compliance ?? null) as never, qaScores: (r.qaScores ?? { overall: 90 }) as never };
  }));
  const jpeg = Buffer.from([255, 216, 255, 0]);
  const deps: PublishDeps = {
    db, now: () => new Date("2026-01-02T00:00:00Z"), sleep: async () => {}, channelRules: async () => FIXTURE_CHANNEL_RULES,
    fetch: vi.fn(async () => new Response(jpeg, { status: 200, headers: { "x-goog-generation": "1", "content-type": "image/jpeg", "content-length": "4" } })),
    storage: {
      getPublicBucketName: () => "public",
      downloadBuffer: async () => ({ buf: jpeg, mime: "image/jpeg" }),
      headObject: async () => ({ exists: false, size: null, contentType: null, generation: null, crc32c: null }),
      stageCopyToPublic: vi.fn(async () => ({ generation: "1", crc32c: "crc" })),
      deletePublicObject: vi.fn(async () => true), setCustomTime: vi.fn(async () => {}),
    },
  };
  const live = async (productId = main.id) => (await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId, productId), eq(catalogOutputs.isLive, true)))).map(o => `${o.channel} ${o.n} ${o.batchId === old!.id ? "old" : "new"}`).sort();
  const deleted = () => vi.mocked(deps.storage.deletePublicObject).mock.calls.map(c => c[0]).sort();
  const publish = () => publishProduct(deps, fresh!.id, main.id);
  return { deps, old: old!, fresh: fresh!, main, sibling, live, deleted, publish, path: (c: ChannelId, n: number) => path(name, c, n) };
}

const event = (s: { main: { id: string } }, kind: "shots_removed" | "unchanged") => db.select().from(catalogProductEvents).where(and(eq(catalogProductEvents.productId, s.main.id), eq(catalogProductEvents.kind, kind)));

describe("a rejected photo may take its older image down (M1 D45)", () => {
  it("is off by default, for a batch with no snapshot, and when its snapshot says off", async () => {
    expect(settingDef(REJECTED_PHOTO_TAKE_DOWN_KEY)).toMatchObject({ default: false, risk: "needs_owner", inUse: true });
    for (const [name, setting] of [["r-off", false], ["r-none", null]] as const) {
      const s = await world(name, [{ n: 1, status: "staged" }, mark(2), { n: 3, status: "staged" }], { setting });
      expect(await s.publish()).toMatchObject({ outcome: "published" });
      expect(s.deleted()).toEqual([]);
      expect(await s.live()).toEqual(["noon 1 new", "noon 2 old", "noon 3 new"]);
    }
  });

  it("a confirmed mark on the same photo takes the older image down, at the link and in the database, with a true reason in the version history", async () => {
    const s = await world("r-mark", [{ n: 1, status: "staged" }, mark(2), { n: 3, status: "staged" }]);
    expect(await s.publish()).toMatchObject({ outcome: "published", changed: true });
    expect(s.deleted()).toEqual([s.path("noon", 2)]);
    expect(await s.live()).toEqual(["noon 1 new", "noon 3 new"]);
    const [gone] = await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, s.old.id), eq(catalogOutputs.productId, s.main.id), eq(catalogOutputs.n, 2)));
    expect(gone).toMatchObject({ isLive: false, status: "skipped", reason: `Removed in batch r-mark-new: ${TAKE_DOWN_WHY.text_or_watermark}` });
    const [rejecting] = await db.select().from(catalogOutputs).where(and(eq(catalogOutputs.batchId, s.fresh.id), eq(catalogOutputs.n, 2)));
    const events = await db.select().from(catalogChangeEvents).where(and(eq(catalogChangeEvents.productId, s.main.id), eq(catalogChangeEvents.kind, "removed")));
    expect(events).toMatchObject([{ slot: "image:2", channel: "noon", toVersionId: null, reasonKind: "auto_decide", reasonRef: `catalog_outputs:${rejecting!.id}`, evidenceRef: `catalog_outputs:${gone!.id}` }]);
    const [removedEvent] = await event(s, "shots_removed");
    expect(removedEvent!.details.removedLinks).toMatchObject([{ channel: "noon", n: 2, reason: TAKE_DOWN_WHY.text_or_watermark, rejectedBy: rejecting!.id }]);
  });

  it("a wrong item two judges agree on comes down, also when held for a person; image 1 stays", async () => {
    const s = await world("r-wrong", [
      { n: 1, status: "staged" },
      wrong(2),
      { n: 3, status: "staged" },
      wrong(4, { status: "needs_attention", flags: ["different_product"], compliance: HOLD, qaScores: decided("hold", { wrongItem: { confirmed: true } }) }),
      { n: 5, status: "staged" },
    ], { liveShots: [1, 2, 3, 4, 5] });
    await s.publish();
    expect(s.deleted()).toEqual([s.path("noon", 2), s.path("noon", 4)]);
  });

  it("a verdict on another photo acts on nothing: the older image must be of the same bytes", async () => {
    const s = await world("r-sha", [{ n: 1, status: "staged" }, mark(2, { sha: "another-photo" }), { n: 3, status: "staged" }]);
    await s.publish();
    expect(s.deleted()).toEqual([]);
    expect(await s.live()).toContain("noon 2 old");
  });

  it("not when wrong-item covers most of the product's photos: it may be photo 1 that is the odd one", async () => {
    const s = await world("r-majority", [{ n: 1, status: "staged" }, wrong(2), wrong(3)]);
    await s.publish();
    expect(s.deleted()).toEqual([]);
    expect(await s.live()).toEqual(["noon 1 new", "noon 2 old", "noon 3 old"]);
  });

  it("never image 1, the lowest number or triage's: a chart at n=1 makes n=2 photo 1", async () => {
    const first = await world("r-one", [mark(1), { n: 2, status: "staged" }, { n: 3, status: "staged" }]);
    await first.publish();
    expect(first.deleted()).toEqual([]);
    const chart = await world("r-chart-one", [{ n: 1, status: "skipped", flags: ["chart_image"], reason: "A chart." }, mark(2), { n: 3, status: "staged" }]);
    await chart.publish();
    expect(chart.deleted()).toEqual([]);
    expect(await chart.live()).toContain("noon 2 old");
  });

  it("never the last live link on a channel, and only that channel keeps it", async () => {
    const s = await world("r-last", [mark(2), mark(3)], { liveShots: [2, 3] });
    await s.publish();
    // n=2 is photo 1 here, so n=3 alone is a candidate, and n=2 stays as the link.
    expect(s.deleted()).toEqual([s.path("noon", 3)]);
    expect(await s.live()).toEqual(["noon 2 old"]);
    const plan = (rows: Output[], live: Output[]) => planPublish({ brandSlug: "anta", pathKey: "A", isTest: false, channels: ["noon"], sources: rows.map(r => ({ n: r.n })), batchId: "new", live, outputs: rows, takeDown: { shaOf: new Map([["s", "same"]]) } }).deletes;
    const live = (n: number) => slot({ id: `l${n}`, batchId: "old", n, sourceImageId: "s", objectPath: `catalog/anta/A/noon/A_${n}.jpg` });
    const rejected = (n: number) => slot({ id: `r${n}`, batchId: "new", n, sourceImageId: "s", isLive: false, status: "skipped", flags: ["text_or_watermark", "auto_dropped"], qaScores: decided("drop", MARK_SCORES) as never });
    // Photo 1 is a chart with no live image, and n=2 is not photo 1 only because a lower live place stays. Remove that place and the guard is what holds.
    expect(plan([slot({ id: "p", batchId: "new", n: 1, sourceImageId: "s", isLive: false, status: "skipped", flags: ["text_suspected"] }), rejected(2), rejected(3)], [live(2), live(3)]).map(d => d.output.n)).toEqual([3]);
  });

  it("a person's decision on the older image stands", async () => {
    const s = await world("r-person", [{ n: 1, status: "staged" }, mark(2), { n: 3, status: "staged" }]);
    await db.update(catalogOutputs).set({ decision: "use_as_is", decidedBy: "op@opptra.com" }).where(and(eq(catalogOutputs.batchId, s.old.id), eq(catalogOutputs.productId, s.main.id), eq(catalogOutputs.n, 2)));
    await s.publish();
    expect(s.deleted()).toEqual([]);
  });

  it("no other verdict counts: render verdicts, collage, charts, crash, cap, outage, repair, a broken rule, an unconfirmed verdict", () => {
    const row = (patch: Partial<Output>) => ({ status: "skipped", decision: null, flags: ["text_or_watermark", "auto_dropped"], compliance: null, qaScores: decided("drop", MARK_SCORES), ...patch }) as never;
    expect(takeDownVerdict(row({}))).toBe("text_or_watermark");
    expect(takeDownVerdict(row({ flags: ["different_product", "auto_dropped"], qaScores: decided("drop", { wrongItem: { confirmed: true } }) as never }))).toBe("different_product");
    // Each flag alone, and beside a mark, which is what a repair stage or a mixed row leaves.
    for (const flag of ["product_removed", "halo", "leftover_background", "collage", "chart_image", "orientation", "failed_compliance", "placement", "small_source", "qa_unavailable", "qa_cap", "enlargement_failed", "fallback_matte"] as OutputFlag[]) {
      expect(takeDownVerdict(row({ flags: [flag, "auto_dropped"] })), flag).toBeNull();
      expect(takeDownVerdict(row({ flags: [flag, "text_or_watermark", "auto_dropped"] })), `${flag} and a mark`).toBeNull();
    }
    expect(takeDownVerdict(row({ flags: ["chart_image"], qaScores: null }))).toBeNull();
    // A crash before the triage: publish's own drop leaves the row with no triage record.
    expect(takeDownVerdict(row({ qaScores: { ...decided("drop", MARK_SCORES), autoAction: null, finalStatus: undefined } as never }))).toBeNull();
    expect(takeDownVerdict(row({ qaScores: null }))).toBeNull();
    // A repair step touched it.
    expect(takeDownVerdict(row({ compliance: { auto_actions: [{ step: "flush_cut", trigger: ["halo"], result: "failed" }] } as never }))).toBeNull();
    // Not confirmed: one judge on a wrong item, a score above the line, no evidence.
    expect(takeDownVerdict(row({ flags: ["different_product", "auto_dropped"], qaScores: decided("drop", { wrongItem: { first: true, second: false, confirmed: false } }) as never }))).toBeNull();
    expect(takeDownVerdict(row({ qaScores: decided("drop", { ...MARK_SCORES, no_text_or_watermark: 90 }) as never }))).toBeNull();
    expect(takeDownVerdict(row({ qaScores: decided("drop", { no_text_or_watermark: 20 }) as never }))).toBeNull();
    // A person decided, and a row that is neither dropped nor held.
    expect(takeDownVerdict(row({ decision: "use_as_is" }))).toBeNull();
    expect(takeDownVerdict(row({ status: "staged" }))).toBeNull();
  });

  it("touches neither a sibling product nor a channel outside the batch, and only the rejected channel", async () => {
    const s = await world("r-scope", [
      { n: 1, channel: "noon", status: "staged" }, { n: 1, channel: "amazon", status: "staged" },
      mark(2, { channel: "noon" }), { n: 2, channel: "amazon", status: "staged" },
      { n: 3, channel: "noon", status: "staged" }, { n: 3, channel: "amazon", status: "staged" },
    ], { channels: ["noon", "amazon"], liveChannels: ["noon", "amazon", "styli"] });
    await s.publish();
    expect(s.deleted()).toEqual([s.path("noon", 2)]);
    const live = await s.live();
    expect(live).not.toContain("noon 2 old");
    expect(live).toEqual(expect.arrayContaining(["amazon 2 new", "styli 1 old", "styli 2 old", "styli 3 old"]));
    expect(await s.live(s.sibling.id)).toEqual(["amazon 1 old", "amazon 2 old", "amazon 3 old", "noon 1 old", "noon 2 old", "noon 3 old", "styli 1 old", "styli 2 old", "styli 3 old"]);
    for (const object of s.deleted()) expect(object).toMatch(/^catalog-test\/anta\/r-scope\/noon\//);
  });

  it("a follow-up batch never takes down another batch's image", async () => {
    const s = await world("r-append", [mark(2)], { append: true });
    await s.publish();
    expect(s.deleted()).toEqual([]);
  });

  it("with nothing delivered the note says what was taken down", async () => {
    const s = await world("r-nothing", [
      { n: 1, status: "needs_attention", flags: ["qa_unavailable"], reason: "The check could not run." },
      mark(2),
      { n: 3, status: "needs_attention", flags: ["qa_unavailable"], reason: "The check could not run." },
    ]);
    expect((await s.publish()).outcome).toBe("failed");
    expect(s.deleted()).toEqual([s.path("noon", 2)]);
    expect(await s.live()).toEqual(["noon 1 old", "noon 3 old"]);
    const [pair] = await db.select().from(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId, s.fresh.id), eq(catalogBatchProducts.productId, s.main.id)));
    expect(pair!.notes).toContain(NO_DELIVERABLE_PHOTO_REMOVED);
  });

  it("a redelivery does not rewrite history: the change stays shots_removed and the note stays", async () => {
    const held = { status: "needs_attention" as const, flags: ["halo"] as OutputFlag[], compliance: HOLD, reason: "The edge looks rough." };
    const s = await world("r-again", [{ n: 1, status: "staged" }, mark(2), { n: 3, ...held }, { n: 4, status: "staged" }], { liveShots: [1, 2, 3, 4] });
    await s.publish();
    const pairOf = async () => (await db.select().from(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId, s.fresh.id), eq(catalogBatchProducts.productId, s.main.id))))[0]!;
    const first = await pairOf();
    expect(first.change).toBe("shots_removed");
    expect(first.notes).toContain("photos 2 removed in batch r-again-new");
    await s.publish();
    const second = await pairOf();
    expect(second.change).toBe("shots_removed");
    expect(second.notes).toContain("photos 2 removed in batch r-again-new");
    expect(await event(s, "unchanged")).toEqual([]);
    expect(await event(s, "shots_removed")).toHaveLength(1);
    expect(s.deleted()).toEqual([s.path("noon", 2)]);
  });

  it("a delete that finds the object already gone ends as gone, whichever answer the store gives, so a retry converges", async () => {
    const s = await world("r-gone-412", [{ n: 1, status: "staged" }, mark(2), { n: 3, status: "staged" }]);
    vi.mocked(s.deps.storage.deletePublicObject).mockRejectedValueOnce(new GenerationMismatchError("x"));
    expect(await s.publish()).toMatchObject({ outcome: "published" });
    expect(await s.live()).toEqual(["noon 1 new", "noon 3 new"]);
    const missing = await world("r-gone-404", [{ n: 1, status: "staged" }, mark(2), { n: 3, status: "staged" }]);
    vi.mocked(missing.deps.storage.deletePublicObject).mockResolvedValueOnce(false);
    expect(await missing.publish()).toMatchObject({ outcome: "published" });
    expect(await missing.live()).toEqual(["noon 1 new", "noon 3 new"]);
  });

  it("an object changed outside the batch is not deleted, does not throw, and the note says so", async () => {
    const s = await world("r-changed", [{ n: 1, status: "staged" }, mark(2), { n: 3, status: "staged" }]);
    vi.mocked(s.deps.storage.deletePublicObject).mockRejectedValueOnce(new GenerationMismatchError("x"));
    const head = s.deps.storage.headObject;
    s.deps.storage.headObject = async uri => uri.endsWith(s.path("noon", 2)) ? { exists: true, size: 4, contentType: "image/jpeg", generation: "99", crc32c: "other" } : head(uri);
    expect(await s.publish()).toMatchObject({ outcome: "published" });
    expect(await s.live()).toContain("noon 2 old");
    const [pair] = await db.select().from(catalogBatchProducts).where(and(eq(catalogBatchProducts.batchId, s.fresh.id), eq(catalogBatchProducts.productId, s.main.id)));
    expect(pair!.notes).toContain("changed outside this batch, so it was not removed.");
  });

  it("refuses a live object outside the product's prefix, and never deletes where this batch delivers", () => {
    const base = { brandSlug: "anta", pathKey: "A", isTest: false, channels: ["noon"] as ChannelId[], sources: [{ n: 1 }, { n: 2 }], batchId: "new", takeDown: { shaOf: new Map([["s", "same"]]) } };
    const rejected = slot({ id: "x", batchId: "new", sourceImageId: "s", isLive: false, status: "skipped", flags: ["text_or_watermark", "auto_dropped"], qaScores: decided("drop", MARK_SCORES) as never });
    const stays = slot({ id: "k", batchId: "old", n: 1, sourceImageId: "s", objectPath: "catalog/anta/A/noon/A_1.jpg" });
    expect(() => planPublish({ ...base, live: [stays, slot({ batchId: "old", sourceImageId: "s", objectPath: "catalog/anta/OTHER/noon/OTHER_2.jpg" })], outputs: [rejected] })).toThrow();
    expect(planPublish({ ...base, live: [stays, slot({ batchId: "old", sourceImageId: "s" })], outputs: [rejected] }).deletes.map(d => d.output.n)).toEqual([2]);
    const remade = slot({ id: "y", batchId: "new", sourceImageId: "s", isLive: false, status: "staged" });
    expect(planPublish({ ...base, live: [stays, slot({ batchId: "old", sourceImageId: "s" })], outputs: [rejected, remade] }).deletes).toEqual([]);
  });
});

function slot(patch: Partial<Output>): Output {
  return { id: "o", channel: "noon", n: 2, objectPath: "catalog/anta/A/noon/A_2.jpg", generation: 20, status: "verified", decision: null, flags: [], compliance: null, qaScores: null, isLive: true, ...patch } as Output;
}
