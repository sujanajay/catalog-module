import dns from "node:dns";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SourceItem } from "@catalog/core/catalog/ingest/types";
import { fetchSourceUrl } from "@catalog/core/catalog/ingest/url-list";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, catalogUploads } from "@catalog/core/db/schema";
import { createTestDb } from "@catalog/core/db/testing";
import { handOff, HAND_OFF_PAGE, INGEST_MORE_ROUTE, uploadedPage } from "@catalog/core/catalog/ingest/hand-off";
import { pinnedFetch } from "@catalog/core/safe-url";
import * as storage from "@catalog/core/storage";
import { enqueueTask } from "@catalog/core/tasks";
import { handleIngestMoreTask, handleIngestTask, workerIngestDeps, type IngestTaskDeps } from "./ingest";

const ingest = {} as IngestTaskDeps["ingest"];
const db = {} as Db;

describe("handleIngestTask", () => {
  it("passes the body to runIngest and answers 200 with its outcome", async () => {
    const run = vi.fn(async () => ({ progress: { done: 25, total: 60, phase: "copying" as const }, outcome: "collected 25 of 60; continuing at 25" }));
    expect(await handleIngestTask({ db, ingest, run }, { batchId: "b1", uploadId: "u1", cursor: "25" })).toEqual({
      httpStatus: 200, outcome: "collected 25 of 60; continuing at 25",
    });
    expect(run).toHaveBeenCalledWith(db, ingest, { batchId: "b1", uploadId: "u1", cursor: "25" });
    await handleIngestTask({ db, ingest, run }, { batchId: "b1", uploadId: "u1" });
    expect(run).toHaveBeenLastCalledWith(db, ingest, { batchId: "b1", uploadId: "u1" });
    // The hand-off's run id (spec 14c F6 placing token) is passed on when the body carries it.
    await handleIngestTask({ db, ingest, run }, { batchId: "b1", uploadId: "u1", run: "r1" });
    expect(run).toHaveBeenLastCalledWith(db, ingest, { batchId: "b1", uploadId: "u1", run: "r1" });
    // A placing continuation (spec 14d F7 part 2) carries `place`.
    await handleIngestTask({ db, ingest, run }, { batchId: "b1", uploadId: "u1", run: "r1", place: "800" });
    expect(run).toHaveBeenLastCalledWith(db, ingest, { batchId: "b1", uploadId: "u1", run: "r1", place: "800" });
  });

  it("logs one INFO line per delivery with the batch, the progress and the time (spec 14d F12)", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let t = 1_000;
    const run = vi.fn(async () => {
      t += 1_234;
      return { progress: { done: 300, total: 1000, phase: "copying" as const }, outcome: "placed 300 of 1000; continuing at 300" };
    });
    await handleIngestTask({ db, ingest, run, clock: () => t }, { batchId: "b1", uploadId: "u1" });
    await handleIngestTask({ db, ingest, run, clock: () => t }, { batchId: "b1", uploadId: "u1", place: "300" });
    const lines = info.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ severity: "INFO", event: "ingest", batchId: "b1", uploadId: "u1", phase: "copying", done: 300, total: 1000, ms: 1234, outcome: "placed 300 of 1000; continuing at 300" });
    info.mockRestore();
  });

  it("answers 500 on an unexpected error so Cloud Tasks retries", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    expect(await handleIngestTask({ db, ingest, run }, { batchId: "b1", uploadId: "u1" })).toEqual({ httpStatus: 500, outcome: "error" });
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });

  it("refuses a body without the batch and upload ids", async () => {
    const run = vi.fn();
    for (const body of [{}, { batchId: "b1" }, { batchId: "b1", uploadId: 7 }, { batchId: "b1", uploadId: "u1", cursor: 3 }, { batchId: "b1", uploadId: "u1", run: 7 }, { batchId: "b1", uploadId: "u1", place: 3 }]) {
      expect((await handleIngestTask({ db, ingest, run }, body)).httpStatus).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("runs in production with the real storage, Cloud Tasks and 02's DNS-pinned fetch", () => {
    const deps = workerIngestDeps();
    expect(deps.fetch).toBe(pinnedFetch);
    expect(deps.fetch).not.toBe(globalThis.fetch);
    expect(deps.storage.uploadBuffer).toBe(storage.uploadBuffer);
    expect(deps.enqueue).toBe(enqueueTask);
  });

  it("refuses a pasted link whose address turns private at connect time (DNS rebinding) with the production fetch", async () => {
    // safeFetch's pre-check sees a public address; the lookup made while connecting answers loopback.
    const spy = vi.spyOn(dns, "lookup").mockImplementation(((_host: string, opts: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
      if (opts?.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
      else cb(null, "127.0.0.1", 4);
    }) as unknown as typeof dns.lookup);
    const item: SourceItem = {
      identifier: "ABC", n: 1, suffix: "", originalName: "ABC_1.jpg", folder: null, sheetIdentifier: null, ext: "jpg",
      bytes: { kind: "url", url: "https://rebind.example.com/ABC_1.jpg" }, uploadId: "u1", origin: "url_list", warnings: [],
    };
    try {
      const got = await fetchSourceUrl(item, workerIngestDeps(), { lookup: async () => ["34.120.10.10"] });
      expect(got).toEqual({
        ok: false,
        reason: "https://rebind.example.com/ABC_1.jpg did not return an image (got Links to internal addresses cannot be used: rebind.example.com).",
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the paged hand-off (spec 14d F11 part 2, PGlite)", () => {
  let pg: Db;
  let closeDb: () => Promise<void>;
  beforeAll(async () => {
    ({ db: pg, close: closeDb } = await createTestDb());
  });
  afterAll(async () => closeDb());

  async function batchWithUploads(n: number, status: "ingesting" | "cancelled" = "ingesting") {
    const [b] = await pg.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name: `paged ${n}`, isTest: true, createdBy: "op@opptra.com", status }).returning();
    for (let i = 0; i < n; i += 200) {
      await pg.insert(catalogUploads).values(Array.from({ length: Math.min(200, n - i) }, (_, k) => ({ batchId: b!.id, kind: "image" as const, name: `P${i + k}_1.jpg`, status: "uploaded" as const })));
    }
    return b!.id;
  }

  it("1,200 uploads: one web page and two ingest-more deliveries, every upload queued exactly once", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const batchId = await batchWithUploads(1200);
    const queue: { route: string; body: Record<string, unknown>; taskId?: string }[] = [];
    const names = new Set<string>();
    const enqueue = (async (route: string, body: Record<string, unknown>, opts?: { taskId?: string }) => {
      // Cloud Tasks deduplicates task names, as the fake queue does.
      if (opts?.taskId && names.has(opts.taskId)) return "exists";
      if (opts?.taskId) names.add(opts.taskId);
      queue.push({ route, body, ...(opts?.taskId ? { taskId: opts.taskId } : {}) });
      return `task-${queue.length}`;
    }) as never;
    // The web request (ingestBatch): the first page, then one ingest-more task.
    const page = await uploadedPage(pg, batchId, null);
    expect(page.ids).toHaveLength(HAND_OFF_PAGE);
    await handOff(enqueue, batchId, "r1", page);
    let more = 0;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i]!.route !== INGEST_MORE_ROUTE) continue;
      more++;
      expect(await handleIngestMoreTask({ db: pg, ingest: { ...ingest, enqueue } }, queue[i]!.body)).toMatchObject({ httpStatus: 200 });
    }
    expect(more).toBe(2);
    const handed = queue.filter((q) => q.route === "/tasks/catalog/ingest").map((q) => q.body.uploadId as string);
    expect(handed).toHaveLength(1200);
    expect(new Set(handed).size).toBe(1200);
    expect(queue.filter((q) => q.route === "/tasks/catalog/ingest").every((q) => q.body.run === "r1" && q.taskId === `ingest-${q.body.uploadId}-r1`)).toBe(true);
    // A repeated ingest-more delivery (Cloud Tasks retry) queues nothing new.
    const before = queue.length;
    await handleIngestMoreTask({ db: pg, ingest: { ...ingest, enqueue } }, queue.find((q) => q.route === INGEST_MORE_ROUTE)!.body);
    expect(queue).toHaveLength(before);
  });

  it("hands nothing for a batch that is no longer collecting, and refuses a body without its ids", async () => {
    const batchId = await batchWithUploads(3, "cancelled");
    const enqueue = vi.fn();
    expect(await handleIngestMoreTask({ db: pg, ingest: { ...ingest, enqueue: enqueue as never } }, { batchId, run: "r1", after: "x" })).toEqual({ httpStatus: 200, outcome: "noop: the batch is cancelled" });
    expect(enqueue).not.toHaveBeenCalled();
    expect((await handleIngestMoreTask({ db: pg, ingest }, { batchId })).httpStatus).toBe(400);
    expect(await pg.select().from(catalogUploads).where(eq(catalogUploads.batchId, batchId))).toHaveLength(3);
  });
});
