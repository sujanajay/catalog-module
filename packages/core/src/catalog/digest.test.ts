// M1-S5 (M1-F4): the digest builder, its words, the digest email and the two new sheets.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import ExcelJS from "exceljs";
import { createTestDb } from "../db/testing";
import type { Db } from "../db/client";
import { catalogBatches, catalogOutputs, catalogProducts } from "../db/schema";
import { parseCsv } from "../csv";
import { seedLargeBatch } from "./pipeline/large-batch-fixture";
import { batchCostFigure } from "./cost-report";
import { buildReport } from "./pipeline/report";
import { APPEND_TAKEN_NOTE, HOLDOUT_KEPT_NOTE, overLimitNote } from "./pipeline/publish";
import { buildDigest, digestFrom, digestWithCost, groupReasons, readImprovements, type BatchDigest, type DigestOutput } from "./digest";
import { digestCostLine, digestEmail, digestHeadline, digestLeftOutLine, digestReasonLines, digestTiles, digestTimeLine, duration } from "./digest-copy";
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

describe("products grouping left out (R1 exit 2 finding 1)", () => {
  const sameShot = { identifier: "10255347_Black", why: "same_shot" as const, reason: "Two files claim shot 1 of 10255347_Black: 10255347_Black_1.jpeg, 10255347_Black_1.jpg. Rename one and re-upload.", photos: 2, files: ["10255347_Black_1.jpeg", "10255347_Black_1.jpg"] };
  const links = { identifier: "LNK", why: "links" as const, reason: "Row 2, Image 1: the link answered 404.", photos: 1, files: ["LNK_1.jpg"] };
  const digestOf = async (leftOutProducts: Parameters<typeof digestFrom>[0]["leftOutProducts"], files: unknown[] = [], sameFilesMerged = 0, sharedPhotos: Parameters<typeof digestFrom>[0]["sharedPhotos"] = []) => {
    const built = await buildReport(db, batchId, { recheck: { ok: 0, total: 0, failures: [] }, exports: { xlsx: "x", csv: "c", report: "r", filledProductList: null, exportsMatch: true } });
    return digestFrom({ batch: built.batch, sheet: built.sheet, files, cost, leftOutProducts, sameFilesMerged, sharedPhotos, pairs: built.rows.pairs.map(r => ({ productId: r.pair.productId, identifier: r.product.identifier, change: r.pair.change, notes: r.pair.notes })), outputs: built.rows.outputs, improvements: await readImprovements(db, batchId) });
  };

  it("counts them in the total and gives each an Exceptions row with its reason and what to do, so All N can never be said", async () => {
    const { digest, exceptions } = await digestOf([sameShot, links], [{ name: sameShot.files[0], identifier: sameShot.identifier, reason: sameShot.reason }, { name: "LNK_1.jpg", identifier: "LNK", reason: links.reason }]);
    expect(digest).toMatchObject({ products: 8, productsWithLinks: 5, productsLeftOut: 2, productsLeftOutReasons: [{ text: "none of its links could be downloaded", count: 1 }, { text: "two different photos have the same shot number", count: 1 }] });
    expect(exceptions.filter(e => e.identifier === sameShot.identifier)).toEqual([{ identifier: sameShot.identifier, channel: null, image: null, reason: sameShot.reason, fix: "Keep the right photo for each shot number, then send this product in a new batch.", group: "Product left out: two different photos have the same shot number" }]);
    // A link failure keeps its own file row beside the product's: it says which link.
    expect(exceptions.filter(e => e.identifier === "LNK").map(e => e.group)).toEqual(["Product left out: none of its links could be downloaded"]);
    expect(exceptions.some(e => e.identifier === "LNK_1.jpg")).toBe(true);
    expect(digest.photosLeftOut).toBe(2 + 1 + 1);
    expect(digestHeadline(digest)).toBe("5 of 8 products have links. 2 products were left out; the Exceptions sheet says why. 1 needs you.");
    expect(digestLeftOutLine(digest)).toBe("2 products were left out of this batch: none of its links could be downloaded (1), two different photos have the same shot number (1). Any links they already had stay as they were. The Exceptions sheet names each one and what to do.");
  });

  it("says All N only when nothing was left out, in the headline, the tile and the email", () => {
    const whole = digest({ products: 3, productsWithLinks: 3 });
    expect(digestHeadline(whole)).toBe("All 3 products have links.");
    expect(digestLeftOutLine(whole)).toBeNull();
    const left = digest({ products: 477, productsWithLinks: 386, productsLeftOut: 91, productsLeftOutReasons: [{ text: "two different photos have the same shot number", count: 91 }] });
    expect(digestHeadline(left)).toBe("386 of 477 products have links. 91 products were left out; the Exceptions sheet says why.");
    expect(digestTiles(left).find(t => t.label === "Need you")!.meaning).not.toBe("Nothing needs you.");
    const mail = digestEmail({ name: "Lot", url: "u" }, left);
    expect(mail.subject).toBe("Lot: links are ready for 386 of 477 products. 91 products were left out.");
    expect(mail.text).toContain("91 products were left out of this batch: two different photos have the same shot number (91).");
  });

  it("never says all done while anything is out: a failed upload or an unused file, in the headline, the line, the tile and the email (P1-1)", () => {
    const failed = digest({ products: 3, productsWithLinks: 3, uploadsNotRead: 1 });
    expect(digestHeadline(failed)).toBe("All 3 products have links. 1 upload could not be read; the Exceptions sheet says why.");
    expect(digestLeftOutLine(failed)).toBe("1 upload could not be read, so what it holds is not in this batch. The Exceptions sheet names each one and what to do.");
    expect(digestTiles(failed).find(t => t.label === "Need you")!.meaning).not.toBe("Nothing needs you.");
    expect(digestEmail({ name: "Lot", url: "u" }, failed).text).not.toContain("Nothing needs you.");
    const files = digest({ products: 1, productsWithLinks: 1, filesLeftOut: 2 });
    expect(digestHeadline(files)).toBe("The product has links. 2 files were not used; the Exceptions sheet says why.");
    expect(digestHeadline(digest({ products: 0, productsWithLinks: 0, uploadsNotRead: 2 }))).toBe("This batch had no products. 2 uploads could not be read; the Exceptions sheet says why.");
    expect(digestHeadline(digest({ products: 4, productsWithLinks: 1, productsLeftOut: 2, filesLeftOut: 3, uploadsNotRead: 1 }))).toBe("1 of 4 products have links. 1 does not; the Exceptions sheet says why. 2 products were left out, 1 upload could not be read and 3 files were not used; the Exceptions sheet says why.");
  });

  it("names the same photo under two product names on the Exceptions sheet and the digest, without changing what counts as out", async () => {
    const { digest: d, exceptions } = await digestOf([], [], 0, [{ identifiers: ["A", "B"], products: 2, photos: 3 }, { identifiers: ["C", "D", "E", "F"], products: 400, photos: 1 }]);
    expect(d.productsLeftOut).toBe(0);
    expect(d.photosUnderSeveralProducts).toBe(4);
    expect(exceptions.filter(e => e.group.startsWith("Check:")).map(e => e.reason)).toEqual(["3 photos are the same in A and B. Each product kept its links; nothing was merged.", "1 photo is the same in C, D, E and 397 more. Each product kept its links; nothing was merged."]);
    expect(digestReasonLines(d).lines.join(" ")).toContain("4 photos are under more than one product name.");
  });

  it("counts a left-out product with a product list row once, and says when copies of a photo were dropped", async () => {
    const { digest, exceptions } = await digestOf([{ ...sameShot, identifier: id(1) }], [], 276);
    expect(digest).toMatchObject({ products: 6, productsLeftOut: 1, sameFilesMerged: 276 });
    expect(exceptions.filter(e => e.identifier === id(1))).toHaveLength(1);
    expect(digestReasonLines(digest).lines).toContain("276 files were copies of a photo already in the batch, so one of each was used.");
  });
});

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
  it("says the cost is not final until the daily cost check's final run, and older digests read as before", () => {
    const usd = { usd: 2.8796, inr: null, usdPerProduct: 0.0204, inrPerProduct: null };
    expect(digestCostLine(digest({ cost: usd }))).toBe("Cost: USD 0.0204 per product (USD 2.8796 for this batch).");
    expect(digestCostLine(digest({ cost: { ...usd, basis: "recorded" } }))).toBe("Cost so far (not final): USD 0.0204 per product (USD 2.8796 for this batch). Idle machine time is added by the daily cost check.");
    const inr = { usd: 7, inr: 588, usdPerProduct: 0.05, inrPerProduct: 4.2 };
    expect(digestCostLine(digest({ cost: { ...inr, basis: "provisional" } })))
      .toBe("Cost (not final): INR 4.20 per product (INR 588.00 for this batch). This includes idle machine time and the shared database, and can still change for two days.");
    expect(digestCostLine(digest({ cost: { ...inr, basis: "true" } }))).toBe("Cost: INR 4.20 per product (INR 588.00 for this batch). This includes idle machine time and the shared database.");
  });

  it("shows one live figure per product with links: the ledger, then the daily check's (not final, then final), also for a batch that ended on a later day", async () => {
    const [linked] = (await db.execute(sql`SELECT count(DISTINCT product_id)::int AS n FROM catalog_outputs WHERE batch_id = ${batchId}::uuid AND published_at IS NOT NULL`) as unknown as { rows: { n: number }[] }).rows;
    const n = Number(linked!.n);
    expect(n).toBeGreaterThan(0);
    // The digest's own count of products with links: the same products, so the digest page never reads the outputs.
    const d = digest({ productsWithLinks: n, cost: { usd: 99, inr: null, usdPerProduct: 99, inrPerProduct: null, basis: "recorded" } });
    await db.execute(sql`INSERT INTO catalog_cost_events (batch_id, brand_slug, stage, kind, engine, ms, usd, outcome, at) VALUES
      (${batchId}, 'uspa', 'upscale', 'upscale_call', 'gpu', 1000, 0.25, 'ok', '2026-11-05T23:40:00Z'),
      (${batchId}, 'uspa', 'upscale', 'upscale_call', 'gpu', 1000, 0.05, 'failed', '2026-11-05T23:50:00Z')`);
    const ledger = Number(((await db.execute(sql`SELECT sum(usd)::float8 AS u FROM catalog_cost_events WHERE batch_id = ${batchId}::uuid`)) as unknown as { rows: { u: number }[] }).rows[0]!.u);
    // Running (no outcome) and before any check: the whole ledger, per product with links, not final.
    expect((await digestWithCost(db, batchId, d, 84)).cost).toEqual({ usd: ledger, inr: ledger * 84, usdPerProduct: ledger / n, inrPerProduct: (ledger / n) * 84, basis: "recorded" });
    // Ended later than its work (a failed batch the sweep touched on 2026-11-08), checked for 2026-11-05 only: the idle
    // tail of the 23:50 row runs into 2026-11-06, so the figure waits for that day.
    await db.execute(sql`INSERT INTO catalog_batch_outcomes (batch_id, status, success, ended_at, products, products_with_links)
      VALUES (${batchId}, 'failed', false, '2026-11-08T10:00:00Z', 9, ${n}) ON CONFLICT (batch_id) DO UPDATE SET ended_at = '2026-11-08T10:00:00Z'`);
    const day = (on: string, provisional: boolean) => db.execute(sql`INSERT INTO catalog_cost_days (day, component, kind, env, source, billed_usd, provisional)
      VALUES (${on}, 'catalog-upscale-gpu', 'service', 'live', 'monitoring', 1, ${provisional})
      ON CONFLICT (day, component, env, source) DO UPDATE SET provisional = ${provisional}`);
    const alloc = (on: string, attributed: number, idle: number) => db.execute(sql`INSERT INTO catalog_cost_allocations (day, source, batch_id, component, busy_ms, attributed_usd, idle_usd, shared_usd)
      VALUES (${on}, 'monitoring', ${batchId}, 'catalog-upscale-gpu', 0, ${attributed}, ${idle}, 0)`);
    await day("2026-11-05", true);
    await alloc("2026-11-05", 0.3, 0.6);
    expect((await digestWithCost(db, batchId, d, null)).cost.basis).toBe("recorded");
    await day("2026-11-06", true);
    await alloc("2026-11-06", 0, 0.1);
    expect((await digestWithCost(db, batchId, d, null)).cost).toEqual({ usd: 1, inr: null, usdPerProduct: 1 / n, inrPerProduct: null, basis: "provisional" });
    await day("2026-11-05", false);
    expect((await digestWithCost(db, batchId, d, null)).cost.basis).toBe("provisional");
    await day("2026-11-06", false);
    const shown = await digestWithCost(db, batchId, d, null);
    expect(shown.cost).toEqual({ usd: 1, inr: null, usdPerProduct: 1 / n, inrPerProduct: null, basis: "true" });
    expect({ ...shown, cost: d.cost }).toEqual(d);
    // The batch page line and report.json use the same figure (batchCostFigure).
    expect(await batchCostFigure(db, batchId)).toEqual({ usd: 1, products: n, usdPerProduct: 1 / n, basis: "true" });
  });
});
