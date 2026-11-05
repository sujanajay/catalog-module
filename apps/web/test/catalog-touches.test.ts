// M6-S6 (M6-F3-R3): the operator touch counter in the API layer, on PGlite with the real routes.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches, catalogBatchTouches } from "@catalog/core/db/schema";
import type { Role } from "@catalog/core/catalog/types";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";
import { countTouch } from "../lib/catalog/touches";
import { POST as cancel } from "../app/api/catalog/batches/[id]/cancel/route";
import { POST as holdStart } from "../app/api/catalog/batches/[id]/hold-start/route";

const API = path.resolve(import.meta.dirname, "../app/api/catalog");

/** Operator write routes whose write is a person stepping in: each calls countTouch after it succeeded. */
const TOUCH_ROUTES = [
  "batches/[id]/cancel", "batches/[id]/hold-start", "batches/[id]/ingest", "batches/[id]/reopen", "batches/[id]/retry-links", "batches/[id]/sku-map",
  "outputs/[id]/decision", "outputs/[id]/replacement/complete", "outputs/[id]/retry-enlargement",
];
/**
 * Operator write routes of the wizard's own path, or a step of a touch counted elsewhere: not touches. The replacement's
 * signed upload URL is the first half of replace_photo (counted on complete); eval labels mark a test batch for the
 * model bake-off and never change it. The one-page New batch's brand inference and a draft's brand change act on a draft
 * before Start, so they are the wizard's own path too. "Wait" (hold-start) is a touch (M1 D33): it stops the countdown.
 */
const NOT_TOUCH_ROUTES = [
  "batches", "batches/[id]", "batches/[id]/detected", "batches/[id]/links", "batches/[id]/links/[uploadId]", "batches/[id]/start",
  "batches/[id]/uploads", "batches/[id]/uploads/[uploadId]", "batches/[id]/uploads/[uploadId]/complete", "batches/[id]/eval-labels",
  "outputs/[id]/replacement", "brands/[slug]/export", "products/[id]", "products/[id]/aliases",
  "brands/infer", "batches/[id]/brand",
];

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? routeFiles(full) : name === "route.ts" ? [full] : [];
  });
}

let db: Db, close: () => Promise<void>;
let role: Role = "operator";
beforeAll(async () => { ({ db, close } = await createTestDb()); setDbForTests(db); });
afterAll(async () => { setDbForTests(undefined); await close(); });
beforeEach(async () => {
  role = "operator";
  vi.stubEnv("SKIP_IAP", "1");
  vi.stubEnv("DEV_USER_EMAIL", "op@opptra.com");
  setUserDeps({ roleLookup: async () => role });
  await db.delete(catalogBatchTouches); await db.delete(catalogBatches);
});
afterEach(() => { resetUserDeps(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (url: string) => new Request(`http://localhost${url}`, { method: "POST" });
const touches = async () => (await db.execute(sql`SELECT batch_id, action FROM catalog_batch_touches`) as unknown as { rows: Record<string, unknown>[] }).rows;

describe("operator touches (M6-F3-R3)", () => {
  it("classifies every operator write route as a touch or not, and only touch routes count one", () => {
    const seen: string[] = [];
    for (const file of routeFiles(API)) {
      const text = readFileSync(file, "utf8");
      const writes = /export (async )?function (POST|PATCH|PUT|DELETE)\b/.test(text);
      if (!writes || !/"operator"/.test(text)) continue;
      const route = path.relative(API, path.dirname(file)).split(path.sep).join("/");
      seen.push(route);
      expect(text.includes("countTouch("), route).toBe(TOUCH_ROUTES.includes(route));
    }
    expect(seen.sort()).toEqual([...TOUCH_ROUTES, ...NOT_TOUCH_ROUTES].sort());
  });

  it("counts a cancel that went through and none for a refused one", async () => {
    const [collecting] = await db.insert(catalogBatches).values({ name: "a", brandSlug: "uspa", brandName: "USPA", createdBy: "op@opptra.com", status: "ingesting" }).returning();
    const [started] = await db.insert(catalogBatches).values({ name: "b", brandSlug: "uspa", brandName: "USPA", createdBy: "op@opptra.com", status: "rendering", startedAt: new Date() }).returning();
    expect((await cancel(req(`/api/catalog/batches/${collecting!.id}/cancel`), ctx(collecting!.id))).status).toBe(200);
    expect((await cancel(req(`/api/catalog/batches/${started!.id}/cancel`), ctx(started!.id))).status).toBe(409);
    expect(await touches()).toEqual([{ batch_id: collecting!.id, action: "cancel" }]);
  });

  it("counts each Wait on a draft's countdown as a touch and none for a batch already started (M1 D33)", async () => {
    const [draft] = await db.insert(catalogBatches).values({ name: "a", brandSlug: "uspa", brandName: "USPA", createdBy: "op@opptra.com", status: "draft" }).returning();
    const [started] = await db.insert(catalogBatches).values({ name: "b", brandSlug: "uspa", brandName: "USPA", createdBy: "op@opptra.com", status: "rendering", startedAt: new Date() }).returning();
    expect((await holdStart(req(`/api/catalog/batches/${draft!.id}/hold-start`), ctx(draft!.id))).status).toBe(200);
    expect((await holdStart(req(`/api/catalog/batches/${started!.id}/hold-start`), ctx(started!.id))).status).toBe(409);
    expect(await touches()).toEqual([{ batch_id: draft!.id, action: "hold_start" }]);
  });

  it("never fails the operator's request when the touch cannot be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setDbForTests({ select: () => { throw new Error("database gone"); } } as unknown as Db);
    try {
      await expect(countTouch("cancel", { batchId: "00000000-0000-4000-8000-000000000000" })).resolves.toBeUndefined();
    } finally { setDbForTests(db); }
    expect(warn.mock.calls.map(([l]) => JSON.parse(String(l)) as Record<string, unknown>)).toEqual([expect.objectContaining({ severity: "WARNING", message: "operator touch not recorded", action: "cancel" })]);
  });
});
