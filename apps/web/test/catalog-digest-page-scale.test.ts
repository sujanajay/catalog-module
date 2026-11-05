// M1-S5 review P2-3: the batch page of a finished 25,000-product batch with a digest reads the digest row, never the
// report, the links sheet or the outputs, so it loads inside 2 s at any batch size (M1-F4 non-functional). The reads are
// the ones the page makes when it shows the digest: batchDetails without the sheet and details, the follow-up links,
// and GET .../digest. SCALE_PRODUCTS sets another size.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import type { Logger } from "drizzle-orm/logger";
import { eq } from "drizzle-orm";
import { createDbFromPglite } from "@catalog/core/db/testing";
import { runMigrations } from "@catalog/core/db/migrate";
import { catalogBatches } from "@catalog/core/db/schema";
import { seedLargeBatch } from "@catalog/core/catalog/pipeline/large-batch-fixture";
import { buildReport } from "@catalog/core/catalog/pipeline/report";
import { batchLinks } from "@catalog/core/catalog/follow-up";
import type { BatchDigest } from "@catalog/core/catalog/digest-types";
import type { Db } from "../lib/db";
import { batchDetails, batchExportUrl } from "../lib/catalog/exports";
import { batchDigest } from "../lib/catalog/digest";

const PRODUCTS = Number(process.env.SCALE_PRODUCTS ?? 25_000), PHOTOS = 3;
let db: Db, close: () => Promise<void>, batchId = "";
const queries: string[] = [];
const logger: Logger = { logQuery: (query) => { queries.push(query); } };
const digest: BatchDigest = {
  version: 1, products: PRODUCTS, productsWithLinks: PRODUCTS, completeEveryChannel: PRODUCTS, linksPerChannel: [{ channel: "noon", links: PRODUCTS * PHOTOS }],
  provisionalLinks: 0, provisionalReasons: [], improving: 0, stayedAsSent: 0, photosLeftOut: 0, leftOutReasons: [], exceptions: 0, exceptionReasons: [], exceptionsNotGrouped: 0,
  controlsSkipped: 0, unchanged: 0, needsYou: 0, startedAt: null, firstLinksAt: null, linksReadyAt: null, cancelledAt: null, cost: { usd: 1, inr: null, usdPerProduct: null, inrPerProduct: null },
  page: { exceptionsCsv: "gs://private/exceptions-v1.csv", notesCsv: "gs://private/delivered-with-a-note-v1.csv", filled: false, notRefreshedChannels: [], keptPhotos: 0, styliSkipped: 0 },
};

beforeAll(async () => {
  const made = createDbFromPglite(undefined, { logger });
  db = made.db as unknown as Db; close = () => made.client.close();
  await runMigrations(made.db);
  ({ batchId } = await seedLargeBatch(made.db, { products: PRODUCTS, photosPerProduct: PHOTOS, channels: ["noon"], status: "done" }));
  await made.db.update(catalogBatches).set({ digest, reportUri: "gs://private/report-v1.json", sheetXlsxUri: "gs://private/links-v1.xlsx" }).where(eq(catalogBatches.id, batchId));
}, 600_000);
afterAll(async () => { await close(); });

it(`shows the digest of a ${PRODUCTS.toLocaleString("en")}-product batch from its row, within 2 s, with no outputs query and no file read`, async () => {
  const read = vi.fn(async () => { throw new Error("no file is read for the digest page"); });
  queries.length = 0;
  const t = performance.now();
  const data = await batchDetails(batchId, db, read, { sheet: "unless-digest" });
  await batchLinks(db as never, { id: batchId, parentBatchId: data.batch.parentBatchId ?? null });
  const shown = await batchDigest(batchId, db);
  const ms = performance.now() - t;
  console.log(`digest page reads: ${Math.round(ms)} ms, ${queries.length} queries`);
  expect(ms).toBeLessThan(2000);
  expect(read).not.toHaveBeenCalled();
  expect(queries.filter(q => q.includes("catalog_outputs"))).toEqual([]);
  expect(data).toMatchObject({ failures: [], recheckFailures: [], filled: false, keptPhotos: 0, styliSkipped: 0, sheet: { rows: [] } });
  // The storage paths stay on the server.
  expect(shown.digest).not.toHaveProperty("page");
  // The two csv downloads sign the paths in the digest without reading the report.
  const signedUrl = vi.fn(async (uri: string) => `https://signed/${uri.split("/").pop()}`);
  expect(await batchExportUrl(batchId, "exceptions", db, { signedUrl, downloadBuffer: read })).toBe("https://signed/exceptions-v1.csv");
  expect(await batchExportUrl(batchId, "notes", db, { signedUrl, downloadBuffer: read })).toBe("https://signed/delivered-with-a-note-v1.csv");
  expect(read).not.toHaveBeenCalled();
}, 300_000);

// M1-S5 review 2 P2-2: the Details tab still reads the report and three output queries. It is timed here on the same
// batch with the report this batch's finalize would write (built from the seeded rows).
it(`opens the Details tab of a ${PRODUCTS.toLocaleString("en")}-product batch within 2 s`, async () => {
  const exports = { xlsx: "gs://private/links-v1.xlsx", csv: "gs://private/links-v1.csv", report: "gs://private/report-v1.json", filledProductList: null, exportsMatch: true };
  const { report } = await buildReport(db as never, batchId, { recheck: { ok: PRODUCTS * PHOTOS, total: PRODUCTS * PHOTOS, failures: [] }, exports });
  const stored = Buffer.from(JSON.stringify(report));
  const read = vi.fn(async (uri: string) => {
    if (uri !== "gs://private/report-v1.json") throw new Error(`the Details tab read ${uri}`);
    return { buf: stored };
  });
  const t = performance.now();
  const data = await batchDetails(batchId, db, read as never, { sheet: "unless-digest", details: true });
  const ms = performance.now() - t;
  console.log(`details tab reads: ${Math.round(ms)} ms, report ${(stored.length / 1e6).toFixed(1)} MB`);
  expect(ms).toBeLessThan(2000);
  expect(read).toHaveBeenCalledTimes(1);
  expect(data).toMatchObject({ failures: [], recheckFailures: [], sheet: { rows: [] } });
}, 300_000);
