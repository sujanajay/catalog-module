// M1-S5 (M1-F4): the digest builder, its words, the digest email and the two new sheets.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { catalogBatches, catalogOutputs, catalogProducts } from "../db/schema";
import { parseCsv } from "../csv";
import { seedLargeBatch } from "./pipeline/large-batch-fixture";
import { buildReport } from "./pipeline/report";
import { APPEND_TAKEN_NOTE, HOLDOUT_KEPT_NOTE, overLimitNote } from "./pipeline/publish";
import { buildDigest, digestFrom, digestWithTrueCost, groupReasons, readImprovements, type BatchDigest, type DigestOutput } from "./digest";
import { digestCostLine, digestEmail, digestHeadline, digestReasonLines, digestTiles, digestTimeLine, duration } from "./digest-copy";
import { compareXlsxCsv, EXCEPTIONS_SHEET, NO_EXCEPTIONS, NOTES_SHEET, writeExceptionsCsv, writeLinksCsv, writeLinksXlsx } from "./sheet";

let db: Db, close: () => Promise<void>, batchId = "";
const id = (i: number) => `SKU-${String(i).padStart(6, "0")}`;
const cost = { usd: 1.2, inr: null, usdPerProduct: 0.2, inrPerProduct: null };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  ({ batchId } = await seedLargeBatch(db, { products: 6, photosPerProduct: 2, channels: ["noon", "namshi"], status: "done" }));
  const run = (q: ReturnType<typeof sql>) => db.execute(q);
  // 1: complete. 2: Noon image 2 sent with a note (not enlarged yet, an improvement still trying).
  await run(sql`UPDATE catalog_outputs o SET flags = '["provisional"]'::jsonb, compliance = '{"auto_decide":{"rule":"not_enlarged:*","cause":"not_enlarged","action":"deliver"}}'::jsonb FROM catalog_products p WHERE p.id = o.product_id AND p.identifier = ${id(2)} AND o.channel = 'noon' AND o.n = 2`);
  await run(sql`INSERT INTO catalog_improvements (batch_id, product_id, source_image_id, tries) SELECT o.batch_id, o.product_id, o.source_image_id, 1 FROM catalog_outputs o JOIN catalog_products p ON p.id = o.product_id WHERE p.identifier = ${id(2)} AND o.channel = 'noon' AND o.n = 2`);
  // 3: photo 2 left out on both channels (a different product in the photo).
  await run(sql`UPDATE catalog_outputs o SET status = 'skipped', is_live = false, flags = '["auto_dropped"]'::jsonb, reason = 'A different product may be in this photo.', compliance = '{"auto_decide":{"rule":"wrong_item:*","cause":"wrong_item","action":"drop"}}'::jsonb FROM catalog_products p WHERE p.id = o.product_id AND p.identifier = ${id(3)} AND o.n = 2`);
  // 4: its Noon listing is a control in a running experiment: the live image was kept (not an exception).
  await run(sql`UPDATE catalog_outputs o SET status = 'skipped', is_live = false, reason = ${HOLDOUT_KEPT_NOTE} FROM catalog_products p WHERE p.id = o.product_id AND p.identifier = ${id(4)} AND o.channel = 'noon'`);
  // 5: held for a person (a batch started before auto-decide).
  await run(sql`UPDATE catalog_batch_products bp SET change = 'pending_attention' FROM catalog_products p WHERE p.id = bp.product_id AND p.identifier = ${id(5)}`);
  await run(sql`UPDATE catalog_outputs o SET status = 'needs_attention', is_live = false FROM catalog_products p WHERE p.id = o.product_id AND p.identifier = ${id(5)}`);
  // 6: Namshi image 1 removed by the operator on purpose (not an exception).
  await run(sql`UPDATE catalog_outputs o SET status = 'skipped', is_live = false, decision = 'remove', reason = 'Removed by op@opptra.com' FROM catalog_products p WHERE p.id = o.product_id AND p.identifier = ${id(6)} AND o.channel = 'namshi' AND o.n = 1`);
}, 120_000);
afterAll(async () => { await close(); });

/** As finalize builds it: from buildReport's rows (the outputs read once), checked against the reader that reads its own. */
async function parts(files: unknown[] = []) {
  const built = await buildReport(db, batchId, { recheck: { ok: 0, total: 0, failures: [] }, exports: { xlsx: "x", csv: "c", report: "r", filledProductList: null, exportsMatch: true } });
  const input = { batch: built.batch, sheet: built.sheet, files, cost };
  const fromRows = digestFrom({ ...input, pairs: built.rows.pairs.map(r => ({ productId: r.pair.productId, identifier: r.product.identifier, change: r.pair.change, notes: r.pair.notes })),
    outputs: built.rows.outputs, improvements: await readImprovements(db, batchId) });
  expect(fromRows).toEqual(await buildDigest(db, input));
  return { built, ...fromRows };
}

describe("buildDigest (M1-F4-R1 to R4)", () => {
  it("counts each kind once: links, notes, left-out photos, controls, held products and unreadable files", async () => {
    const { digest, exceptions, notes } = await parts([{ name: "IMG_77.heic", reason: "This file type is not supported." }]);
    expect(digest).toMatchObject({ products: 6, productsWithLinks: 5, completeEveryChannel: 2, provisionalLinks: 1, improving: 1, stayedAsSent: 0, needsYou: 1, controlsSkipped: 1, photosLeftOut: 2, exceptions: 4 });
    expect(digest.provisionalReasons).toEqual([{ text: "not enlarged yet", count: 1 }]);
    expect(digest.leftOutReasons).toEqual([{ text: "a different product in the photo", count: 1 }, { text: "this file type is not supported", count: 1 }]);
    expect(exceptions.map(e => [e.identifier, e.channel, e.image])).toEqual([["IMG_77.heic", null, null], [id(3), "noon", 2], [id(3), "namshi", 2], [id(5), null, null]]);
    expect(exceptions[1]!.fix).toBe("Send a photo of this product in a new batch.");
    // A product held for a person is in the Exceptions sheet with what to do (review P2-6).
    expect(exceptions[3]!.fix).toBe("Decide on the Needs you tab.");
    expect(notes).toEqual([expect.objectContaining({ identifier: id(2), channel: "noon", image: 2, rule: "not_enlarged:*", improves: true })]);
    expect(digest.exceptionReasons.map(r => r.text)).toEqual(["File not used: this file type is not supported", "Namshi image 2 missing: a different product in the photo", "Noon image 2 missing: a different product in the photo", "Waiting for you: held for you to decide before the photos are sent"]);
    expect(digest.linksPerChannel).toEqual([{ channel: "noon", links: 7 }, { channel: "namshi", links: 8 }]);
  });

  it("is the same on a second build (finalize builds it twice and compares)", async () => {
    expect(JSON.stringify((await parts()).digest)).toBe(JSON.stringify((await parts()).digest));
  });

  it("says an improvement that used every try stays as sent", async () => {
    await db.execute(sql`UPDATE catalog_improvements SET tries = 3 WHERE batch_id = ${batchId}::uuid`);
    try {
      const { digest, notes } = await parts();
      expect(digest).toMatchObject({ improving: 0, stayedAsSent: 1 });
      expect(notes[0]).toMatchObject({ improves: false, better: "We could not enlarge it. Send a larger photo in a new batch." });
    } finally { await db.execute(sql`UPDATE catalog_improvements SET tries = 1 WHERE batch_id = ${batchId}::uuid`); }
  });

  it("lists photos a follow-up did not add, even where another batch's photo holds the place (M1-S6 D30, review P2-1)", async () => {
    const where = (n: number, channel: "noon" | "namshi") => and(eq(catalogOutputs.batchId, batchId), eq(catalogOutputs.n, n), eq(catalogOutputs.channel, channel),
      sql`${catalogOutputs.productId} = (SELECT id FROM ${catalogProducts} WHERE identifier = ${id(1)})`);
    const [taken] = await db.select().from(catalogOutputs).where(where(2, "noon"));
    const [earlier] = await db.insert(catalogBatches).values({ name: "earlier", brandSlug: "vero-moda", brandName: "Vero Moda", createdBy: "op@opptra.com", status: "done" }).returning();
    await db.update(catalogOutputs).set({ status: "skipped", isLive: false, flags: ["not_added"], reason: APPEND_TAKEN_NOTE }).where(where(2, "noon"));
    // The earlier batch's live photo keeps the place, so the sheet still shows a link there.
    const [other] = await db.insert(catalogOutputs).values({ ...taken!, id: undefined as never, batchId: earlier!.id }).returning();
    await db.update(catalogOutputs).set({ status: "skipped", isLive: false, flags: ["not_added"], reason: overLimitNote("namshi", 1) }).where(where(2, "namshi"));
    try {
      const { built, exceptions, digest } = await parts();
      expect(built.sheet.rows.find(r => r.identifier === id(1))!.links.noon?.[1]).toBeTruthy();
      expect(exceptions.filter(e => e.identifier === id(1))).toEqual([
        expect.objectContaining({ channel: "noon", image: 2, reason: APPEND_TAKEN_NOTE, fix: "Nothing to do. The earlier photo keeps its place, and the technical team looks at it.", group: "Noon image 2 not added: another batch's photo already has this place" }),
        expect.objectContaining({ channel: "namshi", image: 2, fix: "Nothing to do. The photos already live are kept.", group: "Namshi image 2 not added: the channel takes no more images of this product" }),
      ]);
      expect(digest.completeEveryChannel).toBe(1);
    } finally {
      await db.delete(catalogOutputs).where(eq(catalogOutputs.id, other!.id));
      await db.update(catalogOutputs).set({ status: taken!.status, isLive: taken!.isLive, flags: taken!.flags, reason: taken!.reason }).where(where(2, "noon"));
      await db.update(catalogOutputs).set({ status: taken!.status, isLive: taken!.isLive, flags: taken!.flags, reason: taken!.reason }).where(where(2, "namshi"));
      await db.delete(catalogBatches).where(eq(catalogBatches.id, earlier!.id));
    }
  });

  it("builds from 210k outputs without overflowing the stack (review P1: no spread of a list that grows with the batch)", () => {
    const products = 70_000, at = Date.UTC(2026, 10, 5);
    const pairs = Array.from({ length: products }, (_, i) => ({ productId: `p${i}`, identifier: id(i), change: "new", notes: null }));
    const outputs: DigestOutput[] = pairs.flatMap((pair, i) => [1, 2, 3].map(n => ({ id: `o${i}-${n}`, batchId: "b", productId: pair.productId, sourceImageId: `s${i}-${n}`, channel: "noon" as const, n,
      status: "verified", isLive: true, flags: [], reason: null, decision: null, compliance: null, publicUrl: `https://x/${i}/${n}`, publishedAt: new Date(at + ((i * 3 + n) % 1000) * 1000) })));
    const sheet = { channels: ["noon" as const], rows: pairs.map((p, i) => ({ brand: "b", identifier: p.identifier, optionIdStyleColor: "", opptraSkuIds: [], links: { noon: [1, 2, 3].map(n => `https://x/${i}/${n}`) }, status: "ok" as const, notes: "", change: "new" as const, changedAt: null })) };
    expect(outputs.length).toBeGreaterThan(200_000);
    const { digest: d } = digestFrom({ batch: { id: "b", channels: ["noon"], status: "done", startedAt: null, updatedAt: new Date(at) }, sheet, files: [], cost, pairs, outputs, improvements: [] });
    expect(d).toMatchObject({ products, productsWithLinks: products, completeEveryChannel: products, exceptions: 0, firstLinksAt: new Date(at).toISOString() });
  }, 60_000);

  it("groups reasons most common first, then by text", () => {
    expect(groupReasons(["b", "a", "b", "c", "a", "b"])).toEqual([{ text: "b", count: 3 }, { text: "a", count: 2 }, { text: "c", count: 1 }]);
  });
});

describe("the two digest sheets (M1-F4-R4)", () => {
  it("adds Exceptions and Delivered with a note after an unchanged Links sheet", async () => {
    const { built, exceptions, notes } = await parts();
    const xlsx = await writeLinksXlsx(built.sheet, { exceptions, notes });
    const plain = await writeLinksXlsx(built.sheet);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.map(w => w.name)).toEqual(["Links", EXCEPTIONS_SHEET, NOTES_SHEET]);
    // The links sheet reads the same as before (channel teams' habits) and still matches the csv cell by cell.
    expect(await compareXlsxCsv(xlsx, writeLinksCsv(built.sheet))).toEqual({ equal: true, differences: [] });
    expect(await compareXlsxCsv(plain, writeLinksCsv(built.sheet))).toEqual({ equal: true, differences: [] });
    expect(wb.getWorksheet(EXCEPTIONS_SHEET)!.rowCount - 1).toBe(exceptions.length);
    const noteSheet = wb.getWorksheet(NOTES_SHEET)!;
    expect(noteSheet.getRow(1).values).toEqual([undefined, "identifier", "channel", "image", "link", "reason", "rule", "improves_by_itself", "what_would_make_it_better"]);
    expect(noteSheet.getCell(2, 4).value).toEqual({ text: notes[0]!.link, hyperlink: notes[0]!.link });
  });

  it("has a header and one line \"No exceptions.\" when there are none", () => {
    expect(parseCsv(writeExceptionsCsv([]))).toEqual([["identifier", "channel", "image", "reason", "what_would_fix_it"], [NO_EXCEPTIONS, "", "", "", ""]]);
  });
});

const digest = (over: Partial<BatchDigest> = {}): BatchDigest => ({
  version: 1, products: 312, productsWithLinks: 312, completeEveryChannel: 271, linksPerChannel: [{ channel: "noon", links: 1200 }], provisionalLinks: 41,
  provisionalReasons: [{ text: "not checked yet; it is checked later", count: 22 }, { text: "not enlarged yet", count: 12 }], improving: 12, stayedAsSent: 0,
  photosLeftOut: 3, leftOutReasons: [{ text: "a different product in the photo", count: 2 }, { text: "the photo file is damaged", count: 1 }], exceptions: 5,
  exceptionReasons: [{ text: "Noon image 4 missing: a different product in the photo", count: 2 }], exceptionsNotGrouped: 0, controlsSkipped: 12, unchanged: 0, needsYou: 0,
  startedAt: "2026-11-05T08:00:00.000Z", firstLinksAt: "2026-11-05T08:04:00.000Z", linksReadyAt: "2026-11-05T08:46:00.000Z", cancelledAt: null,
  cost: { usd: 34.32, inr: null, usdPerProduct: 0.11, inrPerProduct: null }, ...over,
});

describe("the digest words (UX 5.3, M1 section 5 screen 3)", () => {
  it("says in one sentence whether every product has links", () => {
    expect(digestHeadline(digest())).toBe("All 312 products have links.");
    expect(digestHeadline(digest({ products: 2000, productsWithLinks: 1992 }))).toBe("1,992 of 2,000 products have links. 8 do not; the Exceptions sheet says why.");
    expect(digestHeadline(digest({ products: 2000, productsWithLinks: 1990, needsYou: 3 }))).toBe("1,990 of 2,000 products have links. 7 do not; the Exceptions sheet says why. 3 need you.");
    expect(digestHeadline(digest({ products: 1, productsWithLinks: 1 }))).toBe("The product has links.");
  });

  it("shows four number tiles with their meaning", () => {
    expect(digestTiles(digest()).map(t => [t.label, t.value])).toEqual([["Products with links", "312 of 312"], ["Complete for every channel", "271"], ["Improving by itself", "12"], ["Need you", "0"]]);
  });

  it("shows at most ten reason lines and counts the rest", () => {
    const many = digest({ exceptionReasons: Array.from({ length: 30 }, (_, i) => ({ text: `Noon image ${i + 1} missing: no photo`, count: 30 - i })) });
    const { lines, more } = digestReasonLines(many);
    expect(lines).toHaveLength(10);
    expect(lines[0]).toBe("41 images were sent with the best image we have. Main reasons: not checked yet; it is checked later (22), not enlarged yet (12).");
    expect(lines[2]).toBe("3 photos were left out: a different product in the photo (2), the photo file is damaged (1). See the Exceptions sheet.");
    expect(lines[4]).toBe("Noon image 1 missing: no photo - 30");
    expect(more).toBe(30 - 6);
    expect(digestReasonLines(digest({ provisionalLinks: 0, improving: 0, photosLeftOut: 0, controlsSkipped: 0, exceptionReasons: [] }))).toEqual({ lines: [], more: 0 });
  });

  it("gives the time to first links and to all links", () => {
    expect(digestTimeLine(digest())).toBe("Time to first links 4 min, to all links 46 min.");
    expect(duration(30_000)).toBe("under a minute");
    expect(duration(126 * 60_000)).toBe("2 h 6 min");
  });

  it("writes the same content as one email (UX 6, T3)", () => {
    const mail = digestEmail({ name: "Campus Oct lot", url: "https://catalog.example/catalog/b1" }, digest({ products: 412, productsWithLinks: 412 }));
    expect(mail.subject).toBe("Campus Oct lot: links are ready for all 412 products. Nothing needs you.");
    expect(mail.text.split("\n").slice(0, 2)).toEqual(["All 412 products have links.", "Nothing needs you."]);
    expect(mail.text).toContain("Open the batch: https://catalog.example/catalog/b1");
    expect(digestEmail({ name: "Lot", url: "u" }, digest({ needsYou: 3, productsWithLinks: 309 })).subject).toBe("Lot: links are ready for 309 of 312 products. 3 products need you.");
    expect(`${mail.subject}${mail.text}`).not.toContain(String.fromCharCode(0x2014));
  });
});

it("the stored digest column round-trips through the batch row", async () => {
  const { digest: d } = await parts();
  await db.update(catalogBatches).set({ digest: d }).where(eq(catalogBatches.id, batchId));
  const [row] = await db.select({ digest: catalogBatches.digest }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
  expect(row!.digest).toEqual(d);
});

describe("R1 exit item 4: the digest cost", () => {
  it("says a recorded cost is before idle time and a true cost includes it; older digests read as before", () => {
    const usd = { usd: 2.8796, inr: null, usdPerProduct: 0.0204, inrPerProduct: null };
    expect(digestCostLine(digest({ cost: usd }))).toBe("Cost: USD 0.0204 per product (USD 2.8796 for this batch).");
    expect(digestCostLine(digest({ cost: { ...usd, basis: "recorded" } }))).toBe("Cost so far: USD 0.0204 per product (USD 2.8796 for this batch). Idle machine time is added by the daily cost check.");
    expect(digestCostLine(digest({ cost: { usd: 7.16, inr: 601.44, usdPerProduct: 0.0508, inrPerProduct: 4.2672, basis: "true" } })))
      .toBe("Cost: INR 4.27 per product (INR 601.44 for this batch). This includes idle machine time and the shared database.");
  });

  it("shows the true cost once the daily cost check covered the day the batch ended, per product with links", async () => {
    const d = digest({ productsWithLinks: 6, cost: { usd: 0.5, inr: null, usdPerProduct: 0.1, inrPerProduct: null, basis: "recorded" } });
    // No outcome row, or no reconciled day yet: as recorded.
    expect(await digestWithTrueCost(db, batchId, d, 84)).toBe(d);
    await db.execute(sql`INSERT INTO catalog_batch_outcomes (batch_id, status, success, ended_at, products, products_with_links, true_cost_usd)
      VALUES (${batchId}, 'done', true, '2026-11-05T15:56:07Z', 6, 4, 1.2) ON CONFLICT (batch_id) DO UPDATE SET true_cost_usd = 1.2, products_with_links = 4, ended_at = '2026-11-05T15:56:07Z'`);
    // True cost from an earlier day only (a batch that crossed midnight, checked for its first day): still as recorded.
    await db.execute(sql`INSERT INTO catalog_cost_allocations (day, source, batch_id, component, busy_ms, attributed_usd, idle_usd, shared_usd, computed_at)
      VALUES ('2026-11-04', 'monitoring', ${batchId}, 'catalog-worker', 0, 0.2, 0.1, 0, now())`);
    expect(await digestWithTrueCost(db, batchId, d, 84)).toBe(d);
    await db.execute(sql`INSERT INTO catalog_cost_allocations (day, source, batch_id, component, busy_ms, attributed_usd, idle_usd, shared_usd, computed_at)
      VALUES ('2026-11-05', 'monitoring', ${batchId}, 'catalog-upscale-gpu', 0, 0.3, 0.6, 0, now())`);
    const shown = await digestWithTrueCost(db, batchId, d, 84);
    expect(shown.cost).toEqual({ usd: 1.2, inr: 1.2 * 84, usdPerProduct: 0.3, inrPerProduct: 0.3 * 84, basis: "true" });
    expect({ ...shown, cost: d.cost }).toEqual(d);
  });
});
