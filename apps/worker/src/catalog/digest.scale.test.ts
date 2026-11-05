// M1-S5 acceptance (M1-F4 tests 1 and 2, on PGlite): a 2,000-product batch with images sent with a note, photos left
// out, products with no image at all and many reasons finishes with one digest whose numbers equal the rows of the
// workbook's Exceptions and "Delivered with a note" sheets and of their csv files, at most 10 reason lines on the page,
// a digest read from one row in well under 2 s and under 200 KB, and a later finalize that keeps it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { performance } from "node:perf_hooks";
import type { Db } from "@catalog/core/db/client";
import { createDbFromPglite } from "@catalog/core/db/testing";
import { runMigrations } from "@catalog/core/db/migrate";
import { catalogBatches } from "@catalog/core/db/schema";
import { parseCsv } from "@catalog/core/csv";
import { seedLargeBatch } from "@catalog/core/catalog/pipeline/large-batch-fixture";
import { workbookCsvSheets } from "@catalog/core/catalog/pipeline/report";
import { NO_DELIVERABLE_PHOTO } from "@catalog/core/catalog/pipeline/publish";
import { DIGEST_REASON_LINES } from "@catalog/core/catalog/digest";
import { digestReasonLines } from "@catalog/core/catalog/digest-copy";
import { EXCEPTIONS_SHEET, NOTES_SHEET } from "@catalog/core/catalog/sheet";
import { handleFinalizeTask } from "./finalize";
import { fakeWorld } from "../../test/catalog-fakes";

const PRODUCTS = 2_000, PHOTOS = 3;
let db: Db, close: () => Promise<void>, batchId = "";
const run = (q: ReturnType<typeof sql>) => db.execute(q);
const batchRow = async () => (await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId)))[0]!;
/** The products of the batch numbered 1..PRODUCTS by identifier, as a SQL condition on catalog_products p. */
const productRange = (from: number, to: number) => sql`p.identifier BETWEEN ${`SKU-${String(from).padStart(6, "0")}`} AND ${`SKU-${String(to).padStart(6, "0")}`}`;

async function finalize(w: ReturnType<typeof fakeWorld>): Promise<string> {
  let outcome = "";
  for (let i = 0; i < 20 && outcome !== "done"; i++) outcome = (await handleFinalizeTask(w.deps, { batchId })).outcome!;
  return outcome;
}

beforeAll(async () => {
  const made = createDbFromPglite();
  db = made.db; close = () => made.client.close();
  await runMigrations(db);
  ({ batchId } = await seedLargeBatch(db, { products: PRODUCTS, photosPerProduct: PHOTOS, channels: ["noon", "namshi"], status: "publishing" }));
  // 120 products: Noon image 2 sent with a note because it is not enlarged yet; 100 of them are still being improved,
  // 20 used every try (they stay as sent).
  await run(sql`UPDATE catalog_outputs o SET flags = '["provisional"]'::jsonb, compliance = '{"auto_decide":{"rule":"not_enlarged:*","cause":"not_enlarged","action":"deliver"}}'::jsonb
    FROM catalog_products p WHERE p.id = o.product_id AND o.channel = 'noon' AND o.n = 2 AND ${productRange(1, 120)}`);
  await run(sql`INSERT INTO catalog_improvements (batch_id, product_id, source_image_id, tries)
    SELECT o.batch_id, o.product_id, o.source_image_id, CASE WHEN ${productRange(101, 120)} THEN 3 ELSE 1 END
    FROM catalog_outputs o JOIN catalog_products p ON p.id = o.product_id WHERE o.channel = 'noon' AND o.n = 2 AND ${productRange(1, 120)}`);
  // 40 products: Namshi image 1 sent with a note for a busy background.
  await run(sql`UPDATE catalog_outputs o SET flags = '["provisional"]'::jsonb, compliance = '{"auto_decide":{"rule":"unusable:*","cause":"unusable","action":"deliver"}}'::jsonb
    FROM catalog_products p WHERE p.id = o.product_id AND o.channel = 'namshi' AND o.n = 1 AND ${productRange(121, 160)}`);
  // 50 products: photo 3 left out on both channels (a different product in the photo).
  await run(sql`UPDATE catalog_outputs o SET status = 'skipped', is_live = false, flags = '["auto_dropped"]'::jsonb, reason = 'A different product may be in this photo. Left out of this channel by a rule.',
    compliance = '{"auto_decide":{"rule":"wrong_item:*","cause":"wrong_item","action":"drop"}}'::jsonb
    FROM catalog_products p WHERE p.id = o.product_id AND o.n = 3 AND ${productRange(201, 250)}`);
  // 10 products with nothing delivered at all.
  await run(sql`UPDATE catalog_outputs o SET status = 'skipped', is_live = false, flags = '["auto_dropped"]'::jsonb, reason = 'Several photos in one.',
    compliance = '{"auto_decide":{"rule":"collage:*","cause":"collage","action":"drop"}}'::jsonb
    FROM catalog_products p WHERE p.id = o.product_id AND ${productRange(301, 310)}`);
  await run(sql`UPDATE catalog_batch_products bp SET change = 'failed', notes = ${NO_DELIVERABLE_PHOTO} FROM catalog_products p WHERE p.id = bp.product_id AND ${productRange(301, 310)}`);
  // 45 products: Noon image 1 not made, for 15 different reasons (more reason lines than the page shows).
  await run(sql`UPDATE catalog_outputs o SET status = 'failed', is_live = false, reason = 'Not made, cause ' || (substring(p.identifier from 5)::int % 15) || '.'
    FROM catalog_products p WHERE p.id = o.product_id AND o.channel = 'noon' AND o.n = 1 AND ${productRange(401, 445)}`);
}, 600_000);
afterAll(async () => { await close(); });

describe(`the digest of a ${PRODUCTS.toLocaleString("en")}-product batch`, () => {
  const w = () => world!;
  let world: ReturnType<typeof fakeWorld> | undefined;

  it("finalize writes one digest whose numbers equal the rows of the Exceptions and Delivered with a note sheets", async () => {
    world = fakeWorld(db);
    w().deps.fetch = (async () => new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } })) as typeof fetch;
    expect(await finalize(w())).toBe("done");
    const batch = await batchRow(), d = batch.digest!;
    expect(d).toMatchObject({ version: 1, products: PRODUCTS, productsWithLinks: PRODUCTS - 10, provisionalLinks: 160, improving: 100, stayedAsSent: 20, needsYou: 0, controlsSkipped: 0 });
    // Exceptions: 50 products x 2 channels for photo 3, 10 products with nothing, 45 Noon image 1 not made.
    expect(d.exceptions).toBe(50 * 2 + 10 + 45);
    // Photos left out: photo 3 of 50 products and every photo of the 10 products with nothing (each photo once).
    expect(d.photosLeftOut).toBe(50 + 10 * PHOTOS);
    expect(d.provisionalReasons).toEqual([{ text: "not enlarged yet", count: 120 }, { text: "busy background in the photo, so the whole photo was used", count: 40 }]);
    expect(d.completeEveryChannel).toBe(PRODUCTS - 160 - 50 - 10 - 45);
    expect(d.linksReadyAt).toBe(batch.finishedAt!.toISOString());
    expect(d.firstLinksAt).not.toBeNull();

    // The workbook: Links first and unchanged, then the two digest sheets with one row per digest item.
    const sheets = await workbookCsvSheets((await w().deps.storage.downloadBuffer(batch.sheetXlsxUri!)).buf);
    const rowsOf = (name: string) => parseCsv(sheets.find(s => s.name === name)!.csv).length - 1;
    expect(sheets.map(s => s.name)).toEqual(["Links", EXCEPTIONS_SHEET, NOTES_SHEET]);
    expect(rowsOf("Links") - 1).toBe(PRODUCTS);
    expect(rowsOf(EXCEPTIONS_SHEET)).toBe(d.exceptions);
    expect(rowsOf(NOTES_SHEET)).toBe(d.provisionalLinks);
    // The csv files carry the same rows.
    const report = JSON.parse((await w().deps.storage.downloadBuffer(batch.reportUri!)).buf.toString()) as { exports: { exceptionsCsv: string; notesCsv: string } };
    const csvRows = async (uri: string) => parseCsv((await w().deps.storage.downloadBuffer(uri)).buf.toString()).length - 1;
    expect(await csvRows(report.exports.exceptionsCsv)).toBe(d.exceptions);
    expect(await csvRows(report.exports.notesCsv)).toBe(d.provisionalLinks);

    // The page: at most 10 reason lines, the rest in the sheet.
    const lines = digestReasonLines(d);
    expect(lines.lines.length).toBeLessThanOrEqual(DIGEST_REASON_LINES);
    expect(lines.lines.length).toBe(DIGEST_REASON_LINES);
    expect(lines.more).toBeGreaterThan(0);
    expect(lines.lines.join("\n")).not.toMatch(/SKU-\d/);
  }, 600_000);

  it("is read from one row, small and fast (M1-F4-R6 and the 200 KB budget)", async () => {
    const t = performance.now();
    const [row] = await db.select({ digest: catalogBatches.digest }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(2_000);
    expect(Buffer.byteLength(JSON.stringify(row!.digest))).toBeLessThan(200_000);
  });

  it("a later finalize (an improvement, Add SKU ids) rebuilds the same digest and keeps its links ready time", async () => {
    const before = (await batchRow()).digest!;
    await run(sql`UPDATE catalog_batches SET counts = counts || '{"finalizePending":true}'::jsonb WHERE id = ${batchId}::uuid`);
    const later = new Date(Date.now() + 3_600_000);
    w().deps.now = () => later;
    expect(await finalize(w())).toBe("done");
    const after = await batchRow();
    expect(after.finishedAt!.toISOString()).toBe(later.toISOString());
    expect(after.digest).toEqual(before);
  }, 600_000);
});
