// M6-F2-R2 (M6-S4): the previous release's task bodies (version 1: no taskVersion field, the shapes the code before
// M6-S4 enqueues) run through the new handlers on PGlite. Each route reads them (never 400), and a body of this release
// (version 2, with a field the handler does not know) gets the same answer as its version 1 twin.
import { FIXTURE_CHANNEL_RULES } from "@catalog/core/catalog/channel-rules";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches } from "@catalog/core/db/schema";
import { versionedBody, type TaskRoute } from "@catalog/core/tasks";
import { workerCatalogDeps, type CatalogDeps } from "./catalog/deps";
import { handleChunkTask } from "./catalog/chunk";
import { handleEnlargeTask } from "./catalog/enlarge";
import { handleFinalizeTask } from "./catalog/finalize";
import { handleIngestMoreTask, handleIngestTask } from "./catalog/ingest";
import { handlePublishTask } from "./catalog/publish";
import { handleSweep } from "./catalog/sweep";
import type { HandleResult } from "./server";

let db: Db, close: () => Promise<void>;
let batchId: string;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
  const [b] = await db.insert(catalogBatches).values({ brandSlug: "test_brand", brandName: "Test Brand", name: "bodies", isTest: true, createdBy: "t", status: "done" }).returning();
  batchId = b!.id;
}, 120_000);
afterAll(async () => { await close(); });

function handlers(): Partial<Record<TaskRoute, (body: Record<string, unknown>) => Promise<HandleResult>>> {
  const enqueue = vi.fn(async () => "task") as unknown as CatalogDeps["enqueue"];
  const catalog: CatalogDeps = { ...workerCatalogDeps(db,{channelRules:async()=>FIXTURE_CHANNEL_RULES}), enqueue, log: () => undefined, sleep: async () => undefined, heartbeat: () => () => undefined };
  const ingest = { db, ingest: { storage: catalog.storage, fetch: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch, enqueue }, failStopped: async () => false };
  return {
    "/tasks/catalog/sweep": (body) => handleSweep({ db, enqueue, releaseLocks: async () => 0, draftExpiryDays: 30, enlargementOff: true } as unknown as Parameters<typeof handleSweep>[0], body),
    "/tasks/catalog/ingest": (body) => handleIngestTask(ingest as unknown as Parameters<typeof handleIngestTask>[0], body),
    "/tasks/catalog/ingest-more": (body) => handleIngestMoreTask(ingest as unknown as Parameters<typeof handleIngestMoreTask>[0], body),
    "/tasks/catalog/chunk": (body) => handleChunkTask(catalog, body),
    "/tasks/catalog/publish": (body) => handlePublishTask(catalog, body),
    "/tasks/catalog/finalize": (body) => handleFinalizeTask(catalog, body),
    "/tasks/catalog/enlarge": (body) => handleEnlargeTask(catalog, body),
  };
}

/** The bodies the code before M6-S4 enqueues for each route (core tasks, dispatch, hand-off, publish, finalize). */
function previousRelease(): [TaskRoute, Record<string, unknown>][] {
  const uploadId = randomUUID(), chunkId = randomUUID(), productId = randomUUID(), enlargementId = randomUUID();
  return [
    ["/tasks/catalog/sweep", {}],
    ["/tasks/catalog/ingest", { batchId, uploadId }],
    ["/tasks/catalog/ingest", { batchId, uploadId, run: "r1" }],
    ["/tasks/catalog/ingest", { batchId, uploadId, run: "r1", cursor: "c1", place: "0" }],
    ["/tasks/catalog/ingest", { batchId, uploadId, run: "r1", group: "40" }],
    ["/tasks/catalog/ingest-more", { batchId, run: "r1", after: uploadId }],
    ["/tasks/catalog/chunk", { chunkId, stage: "matte", step: 0 }],
    ["/tasks/catalog/publish", { batchId, productId }],
    ["/tasks/catalog/publish", { batchId, productId, trigger: "decision" }],
    ["/tasks/catalog/finalize", { batchId }],
    ["/tasks/catalog/enlarge", { batchId, productId, enlargementId }],
  ];
}

describe("previous release task bodies on the new handlers", () => {
  it("every route reads a version 1 body, and a version 2 body with an unknown field gets the same answer", async () => {
    const run = handlers();
    const seen = new Set<string>();
    for (const [route, body] of previousRelease()) {
      const handler = run[route]!;
      const v1 = await handler(structuredClone(body));
      expect(v1.httpStatus, `${route} ${JSON.stringify(body)}: ${v1.outcome}`).not.toBe(400);
      const v2 = await handler({ ...versionedBody(structuredClone(body)), fieldFromALaterRelease: "ignored" });
      expect({ route, status: v2.httpStatus, outcome: v2.outcome }).toEqual({ route, status: v1.httpStatus, outcome: v1.outcome });
      seen.add(route);
    }
    // sync-master ignores its body (a BigQuery read); every other route is covered.
    expect([...seen].sort()).toEqual(["/tasks/catalog/chunk", "/tasks/catalog/enlarge", "/tasks/catalog/finalize", "/tasks/catalog/ingest", "/tasks/catalog/ingest-more", "/tasks/catalog/publish", "/tasks/catalog/sweep"]);
  }, 300_000);
});
