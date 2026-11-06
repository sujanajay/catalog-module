// M6 decision C6 (review round 2 of PR #188): a lost shift record comes back from Cloud Audit Logs with its real time. PGlite,
// the real migrations.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { catalogBatches, catalogTrafficShifts } from "../db/schema";
import { createTestDb } from "../db/testing";
import { recordBatchOutcome, recordTrafficShift } from "./reliability";
import { googleTrafficAudit, syncTrafficShifts, trafficEntryFrom, type TrafficEntry } from "./traffic-sync";

const SERVICE = "catalog-worker", OLD = `${SERVICE}-00090-old`, X = `${SERVICE}-00091-xxx`, Y = `${SERVICE}-00092-yyy`;
const t = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00Z`);
const entry = (hhmm: string, ...serving: string[]): TrafficEntry => ({ service: SERVICE, atMs: +t(hhmm), serving });
const NOW = t("23:00");

describe("reading the audit log", () => {
  // Shapes copied from the live entries of 2026-11-06 (catalog-worker's shift, and a call refused with a conflict).
  const live = {
    timestamp: "2026-11-06T05:47:55.278658Z", resource: { labels: { service_name: SERVICE } },
    protoPayload: { status: {}, request: { service: { spec: { traffic: [{ percent: 100, revisionName: "catalog-worker-00083-xof" }, { revisionName: "catalog-worker-00083-xof", tag: "candidate" }, { revisionName: "catalog-worker-00080-qaz", tag: "previous" }] } } } },
  };
  it("takes the revision with a share, not the tags; skips a refused call and a share to the latest", () => {
    expect(trafficEntryFrom(live)).toEqual({ service: SERVICE, atMs: Date.parse(live.timestamp), serving: ["catalog-worker-00083-xof"] });
    expect(trafficEntryFrom({ ...live, protoPayload: { ...live.protoPayload, status: { code: 10 } } })).toBeNull();
    expect(trafficEntryFrom({ ...live, protoPayload: { status: {}, request: { service: { spec: { traffic: [{ percent: 100 }] } } } } })).toBeNull();
    expect(trafficEntryFrom({ ...live, protoPayload: { request: { service: { traffic: [{ percent: 100, revision: X }] } } } })?.serving).toEqual([X]);
  });
  it("asks for Cloud Run's updates in the time range and follows the pages", async () => {
    const bodies: { filter: string; pageToken?: string }[] = [];
    const audit = googleTrafficAudit(async (_url, body) => {
      bodies.push(body as { filter: string; pageToken?: string });
      return bodies.length === 1 ? { entries: [live], nextPageToken: "n" } : { entries: [] };
    }, "image-links-agent");
    expect(await audit(t("00:00"), t("01:00"))).toHaveLength(1);
    expect(bodies.map((b) => b.pageToken)).toEqual([undefined, "n"]);
    expect(bodies[0]!.filter).toContain("cloudaudit.googleapis.com%2Factivity");
    expect(bodies[0]!.filter).toContain("google.cloud.run.v1.Services.ReplaceService");
    expect(bodies[0]!.filter).toContain('timestamp>="2026-11-10T00:00:00.000Z"');
  });
});

describe("syncTrafficShifts", () => {
  let db: Db, close: () => Promise<void>;
  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    await db.delete(catalogTrafficShifts);
    await recordTrafficShift(db, { service: SERVICE, revision: OLD, at: t("01:00") });
  });
  afterEach(async () => { await close(); });

  const batch = async (from: Date, to: Date) => {
    const id = randomUUID();
    await db.insert(catalogBatches).values({ id, brandSlug: "b", brandName: "B", name: id, status: "done", createdBy: "x@example.com", startedAt: from, finishedAt: to });
    await recordBatchOutcome(db, id, to);
    return id;
  };
  const overlap = async (id: string) => {
    const { rows } = (await db.execute(sql`SELECT deploy_overlap FROM catalog_batch_outcomes WHERE batch_id = ${id}`)) as unknown as { rows: { deploy_overlap: boolean }[] };
    return rows[0]!.deploy_overlap;
  };
  const shifts = async () => (await db.select().from(catalogTrafficShifts)).map((r) => [r.revision, r.shiftedAt.toISOString(), r.shiftedUntil?.toISOString() ?? null]).sort();

  it("the review's repro: a lost record comes back at the real time, so both batches read right", async () => {
    // X was created at 09:50 and took traffic at 10:10; the record of that was lost.
    const across = await batch(t("10:00"), t("10:30")), before = await batch(t("09:40"), t("09:55"));
    expect(await overlap(across)).toBe(false);
    const result = await syncTrafficShifts(db, async () => [entry("09:50", OLD), entry("10:10", X)], [{ name: SERVICE, liveRevisions: [X] }], NOW);
    expect(result).toEqual({ recorded: [X], unknownTime: [] });
    expect(await overlap(across)).toBe(true);
    expect(await overlap(before)).toBe(false);
    expect(await shifts()).toContainEqual([X, t("10:10").toISOString(), null]);
  });

  it("works on a new commit: a replaced revision's lost move still comes back", async () => {
    // Y is the new commit's revision, with its own record; X was replaced with no record.
    await recordTrafficShift(db, { service: SERVICE, revision: Y, at: new Date(+t("12:00") + 3000) });
    const across = await batch(t("10:00"), t("10:30"));
    const result = await syncTrafficShifts(db, async () => [entry("10:10", X), entry("12:00", Y)], [{ name: SERVICE, liveRevisions: [Y] }], NOW);
    expect(result.recorded).toEqual([X]);
    expect(await overlap(across)).toBe(true);
    expect((await shifts()).filter((s) => s[0] === Y)).toHaveLength(1); // The gate's record, seconds off the audit's, is the same move.
  });

  it("a restated entry is no move, and a second run changes nothing", async () => {
    const audit = async () => [entry("09:50", OLD), entry("10:10", X), entry("11:00", X)];
    await syncTrafficShifts(db, audit, [], NOW);
    const first = await shifts();
    expect(first).toHaveLength(2);
    expect((await syncTrafficShifts(db, audit, [], NOW)).recorded).toEqual([]);
    expect(await shifts()).toEqual(first);
  });

  it("a rollback to an earlier revision is a move of its own", async () => {
    const result = await syncTrafficShifts(db, async () => [entry("10:10", X), entry("11:00", OLD)], [], NOW);
    expect(result.recorded).toEqual([X, OLD]);
  });

  it("other services and preview ones are left out", async () => {
    const result = await syncTrafficShifts(db, async () => [{ service: "npd-ui", atMs: +t("10:00"), serving: ["npd-ui-1"] }, { service: `${SERVICE}-preview`, atMs: +t("10:00"), serving: ["p-1"] }], [{ name: "npd-ui", liveRevisions: ["npd-ui-1"] }], NOW);
    expect(result).toEqual({ recorded: [], unknownTime: [] });
  });

  it("the time cannot be found: batches in the window read true rather than a confident false, and a later entry narrows it", async () => {
    const before = await batch(t("00:10"), t("00:50")), inside = await batch(t("10:00"), t("10:30"));
    const result = await syncTrafficShifts(db, async () => [], [{ name: SERVICE, liveRevisions: [X] }], NOW);
    expect(result).toEqual({ recorded: [], unknownTime: [X] });
    expect(await shifts()).toContainEqual([X, t("01:00").toISOString(), NOW.toISOString()]);
    expect(await overlap(inside)).toBe(true);
    expect(await overlap(before)).toBe(false);
    // A batch that ends later, still inside the window, reads it as well.
    expect(await overlap(await batch(t("20:00"), t("20:30")))).toBe(true);
    // Still unknown on the next run: said again, no second window.
    expect((await syncTrafficShifts(db, async () => [], [{ name: SERVICE, liveRevisions: [X] }], t("23:30"))).unknownTime).toEqual([X]);
    expect((await shifts()).filter((s) => s[0] === X)).toHaveLength(1);
    // The audit entry turns up: the exact row replaces the window.
    const later = await syncTrafficShifts(db, async () => [entry("10:10", X)], [{ name: SERVICE, liveRevisions: [X] }], t("23:40"));
    expect(later).toEqual({ recorded: [X], unknownTime: [] });
    expect((await shifts()).filter((s) => s[0] === X)).toEqual([[X, t("10:10").toISOString(), null]]);
    expect(await overlap(await batch(t("10:20"), t("10:40")))).toBe(false);
  });

  it("an unreadable audit log throws and writes nothing", async () => {
    await expect(syncTrafficShifts(db, async () => { throw new Error("403"); }, [{ name: SERVICE, liveRevisions: [X] }], NOW)).rejects.toThrow("403");
    expect(await shifts()).toHaveLength(1);
  });
});
