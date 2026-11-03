// M6-F1-R2 (M6-S1): one compute row per delivery of a wrapped route with the worker's wall time, also when the handler
// throws (the error passes on); the batch's row when the body names one, else a row of no batch.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogCostEvents } from "@catalog/core/db/schema";
import { deliveryOutcome, deliveryUsd, withDeliveryCost } from "./delivery-cost";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); }, 120_000);
afterAll(async () => { await close(); });

const env = { K_SERVICE: "catalog-worker", COMPUTE_USD_PER_VCPU_SECOND: "0.000024", WORKER_CPU: "4", WORKER_CONCURRENCY: "4" };

describe("delivery compute rows", () => {
  it("prices wall time at the delivery's vCPU share and reads a 500 or a throw as failed", () => {
    expect(deliveryUsd(1000, {})).toBe(0);
    expect(deliveryUsd(10_000, env)).toBeGreaterThan(0);
    expect(deliveryOutcome(null)).toBe("failed");
    expect(deliveryOutcome({ httpStatus: 500, outcome: "error" })).toBe("failed");
    expect(deliveryOutcome({ httpStatus: 503, outcome: "busy" })).toBe("ok");
  });

  it("writes the batch's row with its wall time, and a row of no batch for the sweep", async () => {
    const [b] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name: "delivery", isTest: true, createdBy: "t" }).returning();
    let t = 0;
    const wrapped = withDeliveryCost({ db: () => db, now: () => t, env }, "finalize", async () => { t += 2500; return { httpStatus: 200, outcome: "done" }; });
    expect(await wrapped({ batchId: b!.id }, {})).toEqual({ httpStatus: 200, outcome: "done" });
    const [row] = await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.batchId, b!.id));
    expect(row).toMatchObject({ stage: "finalize", kind: "compute", engine: "worker", component: "catalog-worker", ms: 2500, billableMs: 2500, outcome: "ok", isTest: true, brandSlug: "anta" });

    const sweep = withDeliveryCost({ db: () => db, now: () => t, env }, "system", async () => { t += 100; return { httpStatus: 200, outcome: "swept:0" }; });
    await sweep({}, {});
    const system = (await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.stage, "system")));
    expect(system).toEqual([expect.objectContaining({ batchId: null, brandSlug: null, ms: 100, component: "catalog-worker" })]);
  });

  it("writes a failed row when the handler throws, and passes the error on", async () => {
    const [b] = await db.insert(catalogBatches).values({ brandSlug: "anta", brandName: "Anta", name: "delivery-throws", isTest: true, createdBy: "t" }).returning();
    const wrapped = withDeliveryCost({ db: () => db, env }, "ingest", async () => { throw new Error("boom"); });
    await expect(wrapped({ batchId: b!.id, uploadId: "u" }, {})).rejects.toThrow("boom");
    const [row] = await db.select().from(catalogCostEvents).where(eq(catalogCostEvents.batchId, b!.id));
    expect(row).toMatchObject({ stage: "ingest", outcome: "failed" });
  });
});
