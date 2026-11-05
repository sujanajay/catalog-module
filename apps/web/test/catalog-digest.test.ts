// M1-S5 and UX4: the Digest tab, GET .../digest, the digest sheet downloads and the batch details read that skips the
// links sheet when the batch has a digest (M1-F4-R5, R6).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { createTestDb } from "@catalog/core/db/testing";
import { catalogBatches } from "@catalog/core/db/schema";
import type { BatchDigest } from "@catalog/core/catalog/digest-types";
import type { Role } from "@catalog/core/catalog/types";
import { setDbForTests, type Db } from "../lib/db";
import { resetUserDeps, setUserDeps } from "../lib/user";
import { batchDetails, batchExportUrl } from "../lib/catalog/exports";
import { GET as digestGet } from "../app/api/catalog/batches/[id]/digest/route";
import DigestTab from "../components/catalog/DigestTab";
import BatchTabs from "../components/catalog/BatchTabs";
import { writeLinksXlsx } from "@catalog/core/catalog/sheet";

const digest: BatchDigest = {
  version: 1, products: 2000, productsWithLinks: 1990, completeEveryChannel: 1700, linksPerChannel: [{ channel: "noon", links: 5800 }, { channel: "namshi", links: 5900 }],
  provisionalLinks: 160, provisionalReasons: [{ text: "not enlarged yet", count: 120 }, { text: "busy background in the photo, so the whole photo was used", count: 40 }],
  improving: 100, stayedAsSent: 20, photosLeftOut: 80, leftOutReasons: [{ text: "a different product in the photo", count: 50 }, { text: "several photos in one", count: 30 }],
  exceptions: 155, exceptionReasons: Array.from({ length: 18 }, (_, i) => ({ text: `Noon image 1 missing: not made, cause ${i}`, count: 20 - i })), exceptionsNotGrouped: 0,
  controlsSkipped: 0, needsYou: 0, startedAt: "2026-11-05T08:00:00.000Z", firstLinksAt: "2026-11-05T08:04:00.000Z", linksReadyAt: "2026-11-05T08:46:00.000Z", cancelledAt: null,
  cost: { usd: 220, inr: 18400, usdPerProduct: 0.11, inrPerProduct: 9.2 },
};

let db: Db, close: () => Promise<void>, role: Role = "viewer";
beforeAll(async () => { ({ db, close } = await createTestDb()); setDbForTests(db); });
afterAll(async () => { setDbForTests(undefined); await close(); });
beforeEach(async () => {
  role = "viewer";
  vi.stubEnv("SKIP_IAP", "1");
  vi.stubEnv("DEV_USER_EMAIL", "viewer@opptra.com");
  setUserDeps({ roleLookup: async () => role });
  await db.delete(catalogBatches);
});
afterEach(() => { resetUserDeps(); vi.unstubAllEnvs(); });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const newBatch = async (values: Partial<typeof catalogBatches.$inferInsert> = {}) =>
  (await db.insert(catalogBatches).values({ name: "Campus Oct lot", brandSlug: "uspa", brandName: "USPA", createdBy: "op@opptra.com", status: "done", ...values }).returning())[0]!;

describe("the Digest tab (UX 5.3)", () => {
  it("shows the headline, four tiles, at most ten reason lines and the downloads, and no product", () => {
    const html = renderToStaticMarkup(createElement(DigestTab, { id: "b1", digest, sheets: { xlsx: true, exceptions: true, notes: true } }));
    expect(html).toContain("1,990 of 2,000 products have links. 10 need photos.");
    for (const label of ["Products with links", "Complete for every channel", "Improving by itself", "Need you"]) expect(html).toContain(label);
    expect(html.match(/<li>/g)).toHaveLength(10);
    expect(html).toContain("More reasons are in the Exceptions sheet.");
    expect(html).toContain("/api/catalog/batches/b1/export?format=exceptions");
    expect(html).toContain("/api/catalog/batches/b1/export?format=notes");
    expect(html).toContain("Cost: INR 9.20 per product (INR 18,400.00 for this batch).");
    expect(html).toContain("Time to first links 4 min, to all links 46 min.");
    expect(html).not.toMatch(/SKU-\d|class="pc"/);
    expect(html).not.toContain(String.fromCharCode(0x2014));
  });

  it("is the first tab, named Digest, and the links sheet loads from a link when it was not rendered", () => {
    const html = renderToStaticMarkup(createElement(BatchTabs, { attentionCount: 0, overview: "DIGEST", overviewLabel: "Digest", attention: "A", sheet: "S", sheetHref: "?tab=sheet", details: "D" }));
    expect(html).toMatch(/aria-selected="true"[^>]*>Digest<\/button>/);
    expect(html).not.toContain("Needs attention");
  });
});

describe("GET /api/catalog/batches/:id/digest (M1-F4-R1)", () => {
  it("returns the stored digest to a viewer, null before the first finalize, and 404 for no batch", async () => {
    const done = await newBatch({ digest }), draft = await newBatch({ status: "draft" });
    const res = await digestGet(new Request(`http://localhost/api/catalog/batches/${done.id}/digest`), ctx(done.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: done.id, name: "Campus Oct lot", status: "done", digest });
    expect(await (await digestGet(new Request("http://localhost/x"), ctx(draft.id))).json()).toMatchObject({ digest: null });
    expect((await digestGet(new Request("http://localhost/x"), ctx("00000000-0000-4000-8000-000000000000"))).status).toBe(404);
  });
});

describe("digest downloads and the quick batch read", () => {
  it("signs the Exceptions and Delivered with a note csv files, and says when a batch finished before them", async () => {
    const batch = await newBatch({ digest, reportUri: "gs://private/report-v1.json", sheetXlsxUri: "gs://private/links-v1.xlsx" });
    const report = { exports: { exceptionsCsv: "gs://private/exceptions-v1.csv", notesCsv: "gs://private/delivered-with-a-note-v1.csv" } };
    const signedUrl = vi.fn(async (uri: string) => `https://signed/${uri.split("/").pop()}`);
    const downloadBuffer = vi.fn(async () => ({ buf: Buffer.from(JSON.stringify(report)), mime: "application/json" }));
    expect(await batchExportUrl(batch.id, "exceptions", db, { signedUrl, downloadBuffer })).toBe("https://signed/exceptions-v1.csv");
    expect(await batchExportUrl(batch.id, "notes", db, { signedUrl, downloadBuffer })).toBe("https://signed/delivered-with-a-note-v1.csv");
    const old = vi.fn(async () => ({ buf: Buffer.from("{}"), mime: "application/json" }));
    await expect(batchExportUrl(batch.id, "exceptions", db, { signedUrl, downloadBuffer: old })).rejects.toMatchObject({ status: 404, message: "This batch finished before these sheets were made. Download the links sheet instead." });
  });

  it("skips reading the links sheet for a batch with a digest unless the sheet tab asks for it", async () => {
    const batch = await newBatch({ digest, sheetXlsxUri: "gs://private/links-v1.xlsx" });
    const xlsx = await writeLinksXlsx({ channels: ["noon"], rows: [] });
    const read = vi.fn(async () => ({ buf: xlsx, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    const data = await batchDetails(batch.id, db, read, { sheet: "unless-digest" });
    expect(data.sheet.rows).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    await batchDetails(batch.id, db, read, { sheet: "always" });
    expect(read).toHaveBeenCalledWith("gs://private/links-v1.xlsx");
    read.mockClear();
    await db.update(catalogBatches).set({ digest: null }).where(eq(catalogBatches.id, batch.id));
    await batchDetails(batch.id, db, read, { sheet: "unless-digest" });
    expect(read).toHaveBeenCalledWith("gs://private/links-v1.xlsx");
  });
});
