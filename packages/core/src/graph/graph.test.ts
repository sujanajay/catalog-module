// Tier 2 (PGlite; real Postgres when TEST_PG_URL is set), M0-S1 contract tests: recordAsset, recordVersion,
// recordChange (idempotency, required reason and type, the control and treatment refusals, the caller's transaction),
// readChanges (cursor, filters, and on real Postgres a writer still in flight), liveAt and isWritable, plus test
// cleanup taking a test batch's versions with it.
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTestBatches } from "../catalog/test-cleanup";
import type { Db } from "../db/client";
import {
  catalogBatches,
  catalogChangeEvents,
  catalogChannelListings,
  catalogContentVersions,
  catalogLiveIntervals,
  catalogOptions,
  catalogTreatmentAssignments,
} from "../db/schema";
import { createRealTestDb, createTestDb, TEST_PG_URL } from "../db/testing";
import {
  IdempotencyConflictError,
  isWritable,
  liveAt,
  ListingFrozenError,
  phashFromDb,
  readChanges,
  recordAsset,
  recordChange,
  recordVersion,
  sha256Hex,
  textContentHash,
  type NewChangeEvent,
  type NewContentVersion,
} from "./index";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = TEST_PG_URL ? await createRealTestDb() : await createTestDb());
}, 120_000);

afterAll(async () => {
  await close?.();
});

let n = 0;
const sha = (s: string) => sha256Hex(new TextEncoder().encode(s));

async function listing(channel: "noon" | "namshi" = "noon") {
  n += 1;
  const [option] = await db.insert(catalogOptions).values({ brandSlug: "test_brand", optionKey: `opt-${n}`, keySource: "master" }).returning();
  const [l] = await db.insert(catalogChannelListings).values({ optionId: option!.id, channel, market: "ae" }).returning();
  return { optionId: option!.id, listingId: l!.id };
}

async function imageVersion(optionId: string, label: string, extra: Partial<NewContentVersion> = {}) {
  const hash = sha(label);
  await recordAsset(db, { sha256: hash, uri: `gs://b/${label}.jpg`, mime: "image/jpeg" });
  return recordVersion(db, {
    optionId, scope: "noon", component: "image", role: "front", position: 1, source: "cleanup", aiGenerated: false,
    producer: "M3", producerRef: `out-${label}`, assetSha256: hash, createdBy: "test", ...extra,
  });
}

const event = (listingId: string, toVersionId: string | null, extra: Partial<NewChangeEvent> = {}): NewChangeEvent => ({
  idempotencyKey: `k-${listingId}-${toVersionId}-${extra.kind ?? "links_delivered"}`,
  listingId, slot: "image:1", toVersionId, kind: "links_delivered", at: new Date("2026-11-03T10:00:00Z"),
  evidence: "tool_publish", actor: "test", reasonKind: "new_content", changeTypeId: "image.background", ...extra,
});

describe(`M0 graph contract on ${TEST_PG_URL ? "real Postgres" : "PGlite"}`, () => {
  it("recordAsset is idempotent on sha256, refuses a bad hash and keeps a 64-bit perceptual hash exactly", async () => {
    const hash = sha("asset-1");
    const phash = 0xfedcba9876543210n; // top bit set: stored as a negative signed bigint
    expect(await recordAsset(db, { sha256: hash, uri: "gs://b/a.jpg", mime: "image/jpeg", width: 10, height: 20, bytes: 300, phash })).toEqual({ sha256: hash, created: true });
    expect(await recordAsset(db, { sha256: hash, uri: "gs://b/other.jpg", mime: "image/png" })).toEqual({ sha256: hash, created: false });
    const [row] = await db.execute(sql`select uri, phash from catalog_assets where sha256 = ${hash}`).then((r) => (r as unknown as { rows: { uri: string; phash: string | bigint }[] }).rows);
    expect(row!.uri).toBe("gs://b/a.jpg");
    expect(phashFromDb(BigInt(row!.phash))).toBe(phash);
    await expect(recordAsset(db, { sha256: "ABC", uri: "x", mime: "image/jpeg" })).rejects.toThrow(/sha256/);
    await expect(recordAsset(db, { sha256: sha("asset-2"), uri: "x", mime: "image/jpeg", phash: -1n })).rejects.toThrow(/phash/);
  });

  it("recordVersion dedupes the same content from the same producer, nulls included, and keeps versions immutable by key", async () => {
    const { optionId } = await listing();
    const first = await imageVersion(optionId, "v-1");
    expect(first.created).toBe(true);
    expect(await imageVersion(optionId, "v-1")).toEqual({ versionId: first.versionId, created: false });
    // Another producer_ref is another version of the same bytes.
    const other = await imageVersion(optionId, "v-1", { producerRef: "out-other" });
    expect(other.created).toBe(true);

    // No option and no producer_ref (nulls equal): still one row.
    const text = { optionId: null, scope: "master" as const, component: "title" as const, source: "operator" as const, aiGenerated: false, producer: "M8", textValue: "  Navy polo  ", createdBy: "test" };
    const t1 = await recordVersion(db, text);
    expect(await recordVersion(db, text)).toEqual({ versionId: t1.versionId, created: false });
    const [row] = await db.select().from(catalogContentVersions).where(eq(catalogContentVersions.id, t1.versionId));
    expect(row).toMatchObject({ contentHash: textContentHash("Navy polo"), hashKind: "sha256", orgId: "opptra", parentVersionIds: [], aiGenerated: false });

    // Lineage and the AI flag.
    const gen = await imageVersion(optionId, "v-gen", { source: "generated", aiGenerated: true, parentVersionIds: [first.versionId] });
    const [g] = await db.select().from(catalogContentVersions).where(eq(catalogContentVersions.id, gen.versionId));
    expect(g!.parentVersionIds).toEqual([first.versionId]);
    await expect(imageVersion(optionId, "v-gen-2", { source: "generated", aiGenerated: false })).rejects.toThrow();
    // Payload rules: none only for a crc32c backfill row; never two.
    await expect(recordVersion(db, { ...text, textValue: null, jsonValue: undefined, contentHash: "x" })).rejects.toThrow();
    const crc = await recordVersion(db, { ...text, component: "image", scope: "noon", textValue: null, contentHash: "crc32c:AAAA", hashKind: "crc32c", producer: "backfill" });
    expect(crc.created).toBe(true);
    await expect(recordVersion(db, { ...text, textValue: "a", jsonValue: { a: 1 }, contentHash: "y" })).rejects.toThrow();
    await expect(recordVersion(db, { ...text, producer: "M13" })).rejects.toThrow();
  });

  it("recordChange is idempotent on its key and refuses the same key for a different event", async () => {
    const { optionId, listingId } = await listing();
    const v = await imageVersion(optionId, "c-1");
    const e = event(listingId, v.versionId, { idempotencyKey: "publish:out-c-1" });
    const first = await recordChange(db, e);
    expect(first.created).toBe(true);
    expect(await recordChange(db, e)).toEqual({ seq: first.seq, created: false });
    expect(await db.select().from(catalogChangeEvents).where(eq(catalogChangeEvents.idempotencyKey, "publish:out-c-1"))).toHaveLength(1);
    await expect(recordChange(db, { ...e, slot: "image:2" })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("recordChange requires a reason and a change type, except on observed_other events and backfill rows", async () => {
    const { optionId, listingId } = await listing();
    const v = await imageVersion(optionId, "r-1");
    await expect(recordChange(db, event(listingId, v.versionId, { changeTypeId: null }))).rejects.toThrow(/changeTypeId/);
    // A normal event without a reason is refused, by the contract and by the database.
    await expect(recordChange(db, event(listingId, v.versionId, { reasonKind: null }))).rejects.toThrow(/reasonKind/);
    await expect(db.execute(sql`insert into catalog_change_events (idempotency_key, listing_id, slot, to_version_id, kind, at, evidence, actor, change_type_id) values ('raw-1', ${listingId}, 'image:1', ${v.versionId}, 'planned', now(), 'operator', 't', 'image.background')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into catalog_change_events (idempotency_key, listing_id, slot, to_version_id, kind, at, evidence, actor, reason_kind) values ('raw-2', ${listingId}, 'image:1', ${v.versionId}, 'planned', now(), 'operator', 't', 'operator')`)).rejects.toThrow();
    // observed_other and backfill rows are accepted without a reason or a change type.
    expect((await recordChange(db, event(listingId, v.versionId, { kind: "observed_other", evidence: "scrape", reasonKind: null, changeTypeId: null }))).created).toBe(true);
    expect((await recordChange(db, event(listingId, v.versionId, { kind: "links_delivered", evidence: "backfill", reasonKind: null, changeTypeId: null, idempotencyKey: "bf-1" }))).created).toBe(true);
    expect((await recordChange(db, event(listingId, v.versionId, { kind: "verified_live", evidence: "channel_field", reasonKind: "backfill", changeTypeId: null }))).created).toBe(true);
    await db.execute(sql`insert into catalog_change_events (idempotency_key, listing_id, slot, to_version_id, kind, at, evidence, actor) values ('raw-3', ${listingId}, 'image:1', ${v.versionId}, 'observed_other', now(), 'scrape', 't')`);
    await db.execute(sql`insert into catalog_change_events (idempotency_key, listing_id, slot, to_version_id, kind, at, evidence, actor) values ('raw-4', ${listingId}, 'image:1', ${v.versionId}, 'links_delivered', now(), 'backfill', 't')`);
    // A removal empties the slot; nothing else may.
    expect((await recordChange(db, event(listingId, null, { kind: "removed" }))).created).toBe(true);
    await expect(recordChange(db, event(listingId, null, { kind: "planned" }))).rejects.toThrow();
    await expect(recordChange(db, event(listingId, v.versionId, { slot: "image:0" as never, idempotencyKey: "bad-slot" }))).rejects.toThrow();
  });

  it("refuses planned and links_delivered on a frozen control and writes nothing; observations still land", async () => {
    const { optionId, listingId } = await listing("namshi");
    const v = await imageVersion(optionId, "ctl-1");
    await db.insert(catalogTreatmentAssignments).values({ experimentId: "exp-1", listingId, arm: "control", doNotTouch: true, frozenAt: new Date() });
    expect(await isWritable(db, listingId)).toEqual({ ok: false, reason: "frozen_control", experimentId: "exp-1" });
    expect(await isWritable(db, listingId, { experimentId: "exp-1" })).toEqual({ ok: false, reason: "frozen_control", experimentId: "exp-1" });

    for (const kind of ["planned", "links_delivered"] as const) {
      const err = await recordChange(db, event(listingId, v.versionId, { kind, experimentId: "exp-1" })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ListingFrozenError);
      expect(err).toMatchObject({ reason: "frozen_control", experimentId: "exp-1", listingId });
    }
    expect(await db.select().from(catalogChangeEvents).where(eq(catalogChangeEvents.listingId, listingId))).toHaveLength(0);
    // The verifier still records what the channel shows (contamination is detected, not prevented, F3-R8).
    expect((await recordChange(db, event(listingId, v.versionId, { kind: "observed_other", evidence: "scrape", reasonKind: "outside_change", changeTypeId: null }))).created).toBe(true);

    // Released: writable again.
    await db.update(catalogTreatmentAssignments).set({ releasedAt: new Date() }).where(eq(catalogTreatmentAssignments.listingId, listingId));
    expect(await isWritable(db, listingId)).toEqual({ ok: true });
    expect((await recordChange(db, event(listingId, v.versionId))).created).toBe(true);
  });

  it("a frozen treatment listing takes only changes that carry its experiment id", async () => {
    const { optionId, listingId } = await listing("noon");
    const v = await imageVersion(optionId, "trt-1");
    // Assigned but not frozen yet: open.
    await db.insert(catalogTreatmentAssignments).values({ experimentId: "exp-2", listingId, arm: "treatment" });
    expect(await isWritable(db, listingId)).toEqual({ ok: true });
    await db.update(catalogTreatmentAssignments).set({ frozenAt: new Date(Date.now() - 1000) }).where(eq(catalogTreatmentAssignments.listingId, listingId));
    expect(await isWritable(db, listingId)).toEqual({ ok: false, reason: "frozen_treatment", experimentId: "exp-2" });
    await expect(recordChange(db, event(listingId, v.versionId, { kind: "planned" }))).rejects.toMatchObject({ reason: "frozen_treatment" });
    await expect(recordChange(db, event(listingId, v.versionId, { experimentId: "exp-other", idempotencyKey: "trt-other" }))).rejects.toBeInstanceOf(ListingFrozenError);
    expect(await isWritable(db, listingId, { experimentId: "exp-2" })).toEqual({ ok: true });
    expect((await recordChange(db, event(listingId, v.versionId, { experimentId: "exp-2", reasonKind: "experiment", reasonRef: "exp-2" }))).created).toBe(true);
    // An excluded arm does not freeze anything.
    const other = await listing("noon");
    await db.insert(catalogTreatmentAssignments).values({ experimentId: "exp-2", listingId: other.listingId, arm: "excluded", frozenAt: new Date() });
    expect(await isWritable(db, other.listingId)).toEqual({ ok: true });
  });

  it("writes join the caller's transaction: a rollback leaves no event, version or asset", async () => {
    const { optionId, listingId } = await listing();
    const hash = sha("tx-1");
    await expect(
      db.transaction(async (tx) => {
        await recordAsset(tx, { sha256: hash, uri: "gs://b/tx.jpg", mime: "image/jpeg" });
        const v = await recordVersion(tx, { optionId, scope: "noon", component: "image", source: "cleanup", aiGenerated: false, producer: "M3", producerRef: "tx", assetSha256: hash, createdBy: "t" });
        await recordChange(tx, event(listingId, v.versionId, { idempotencyKey: "tx-1" }));
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");
    expect(await db.select().from(catalogChangeEvents).where(eq(catalogChangeEvents.idempotencyKey, "tx-1"))).toHaveLength(0);
    expect(await db.execute(sql`select 1 from catalog_assets where sha256 = ${hash}`).then((r) => (r as unknown as { rows: unknown[] }).rows)).toHaveLength(0);
  });

  it("readChanges pages by seq, oldest first, with kind and listing filters", async () => {
    const { optionId, listingId } = await listing();
    const other = await listing();
    const start = BigInt(((await db.execute(sql`select coalesce(max(seq), 0)::text as m from catalog_change_events`)) as unknown as { rows: { m: string }[] }).rows[0]!.m);
    const seqs: bigint[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const v = await imageVersion(optionId, `rc-${i}`);
      seqs.push((await recordChange(db, event(i % 2 ? listingId : other.listingId, v.versionId, { idempotencyKey: `rc-${i}`, kind: i === 5 ? "planned" : "links_delivered" }))).seq);
    }
    const page1 = await readChanges(db, start, 2);
    expect(page1.map((e) => e.seq)).toEqual(seqs.slice(0, 2));
    const page2 = await readChanges(db, page1.at(-1)!.seq, 10);
    expect(page2.map((e) => e.seq)).toEqual(seqs.slice(2));
    expect((await readChanges(db, start, 10, { kinds: ["planned"] })).map((e) => e.seq)).toEqual([seqs[4]]);
    expect((await readChanges(db, start, 10, { listingIds: [other.listingId] })).map((e) => e.seq)).toEqual([seqs[1], seqs[3]]);
    await expect(readChanges(db, start, 0)).rejects.toThrow(/limit/);
    await expect(readChanges(db, start, 5001)).rejects.toThrow(/limit/);
  });

  it.skipIf(!TEST_PG_URL)("readChanges never passes an event of a transaction still in flight (real Postgres, two connections)", async () => {
    const { optionId, listingId } = await listing();
    const v1 = await imageVersion(optionId, "fl-1");
    const v2 = await imageVersion(optionId, "fl-2");
    const start = BigInt(((await db.execute(sql`select coalesce(max(seq), 0)::text as m from catalog_change_events`)) as unknown as { rows: { m: string }[] }).rows[0]!.m);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let slowSeq = 0n;
    const recorded = vi.fn();
    // Writer A draws the lower seq and stays open; writer B draws a higher seq and commits first.
    const slow = db.transaction(async (tx) => {
      slowSeq = (await recordChange(tx, event(listingId, v1.versionId, { idempotencyKey: "fl-slow" }))).seq;
      recorded();
      await gate;
    });
    await vi.waitFor(() => expect(recorded).toHaveBeenCalled(), { timeout: 10_000 });
    const fast = await recordChange(db, event(listingId, v2.versionId, { idempotencyKey: "fl-fast" }));
    expect(fast.seq).toBeGreaterThan(slowSeq);
    // B is committed but sits above A's seq: a reader must not return it yet, or a stored cursor would skip A.
    expect((await readChanges(db, start, 100)).map((e) => e.seq)).toEqual([]);
    release();
    await slow;
    expect((await readChanges(db, start, 100)).map((e) => e.seq)).toEqual([slowSeq, fast.seq]);
  });

  it("liveAt returns what each slot held at a time, verified or assumed, null for an emptied slot", async () => {
    const { optionId, listingId } = await listing();
    const a = await imageVersion(optionId, "la-a");
    const b = await imageVersion(optionId, "la-b");
    const t = (d: string) => new Date(`2026-11-${d}T00:00:00Z`);
    await db.insert(catalogLiveIntervals).values([
      { listingId, slot: "image:1", versionId: a.versionId, validFrom: t("01"), validTo: t("05"), state: "verified" },
      { listingId, slot: "image:1", versionId: b.versionId, validFrom: t("05"), state: "assumed" },
      { listingId, slot: "image:2", versionId: a.versionId, validFrom: t("01"), validTo: t("03"), state: "assumed" },
      { listingId, slot: "image:2", versionId: null, validFrom: t("03"), state: "verified" },
    ]);
    expect(await liveAt(db, listingId, t("02"))).toEqual({ "image:1": { versionId: a.versionId, state: "verified" }, "image:2": { versionId: a.versionId, state: "assumed" } });
    expect(await liveAt(db, listingId, t("06"))).toEqual({ "image:1": { versionId: b.versionId, state: "assumed" }, "image:2": null });
    expect(await liveAt(db, listingId, new Date("2026-10-01T00:00:00Z"))).toEqual({});
  });

  it("test cleanup deletes a test batch's versions with their events, and keeps every other version", async () => {
    const { optionId, listingId } = await listing();
    const [batch] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test", name: "catalog-test graph", isTest: true, createdBy: "t", status: "done" }).returning();
    const testV = await imageVersion(optionId, "tc-test", { batchId: batch!.id, isTest: true });
    const keptV = await imageVersion(optionId, "tc-kept");
    await recordChange(db, event(listingId, testV.versionId, { idempotencyKey: "tc-1", batchId: batch!.id }));
    await cleanupTestBatches(db, { deleteTestObjects: vi.fn(async () => 0), getBucketName: () => "a", getPublicBucketName: () => "p" }, [batch!.id], new Date());
    expect(await db.select().from(catalogContentVersions).where(eq(catalogContentVersions.id, testV.versionId))).toHaveLength(0);
    expect(await db.select().from(catalogChangeEvents).where(eq(catalogChangeEvents.idempotencyKey, "tc-1"))).toHaveLength(0);
    expect(await db.select().from(catalogContentVersions).where(eq(catalogContentVersions.id, keptV.versionId))).toHaveLength(1);
  });
});
