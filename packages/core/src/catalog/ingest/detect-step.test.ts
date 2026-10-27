import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client";
import { catalogBatches, catalogProducts, catalogSourceImages, catalogUploads, DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import { createTestDb } from "../../db/testing";
import { batchPrefix, normalizeKey } from "../naming";
import { itemKey, manifestPath } from "./manifest";
import { parsePastedLinks, urlListItems } from "./url-list";
import type { BatchOptions, UploadKind } from "../types";
import { buildDetectedStep2, columnLetter, formatsSentence, headerRange, sheetColumnsSentence } from "./detect-step";
import type { Detected, IngestDeps } from "./types";

let db: Db;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  vi.stubEnv("BUCKET", "bkt");
  ({ db, close } = await createTestDb());
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});

/** Step 2 reads the link uploads' manifests (spec 14b F5); `objects` holds the ones a test writes. */
const objects = new Map<string, Buffer>();
const deps = {
  storage: {
    headObject: async (gsUri: string) => ({ exists: objects.has(gsUri), size: objects.get(gsUri)?.length ?? null, contentType: null, generation: null, crc32c: null }),
    downloadBuffer: async (gsUri: string) => ({ buf: objects.get(gsUri)!, mime: "application/json" }),
  } as unknown as IngestDeps["storage"],
};
const sign = async (gsUri: string) => `https://signed.example/${gsUri.slice(5)}?ttl=900`;

/** The links sheet of the prototype: identifier in B, photos in H to M. */
const VENDOR_HEADERS = ["Barcode", "Vendor Style Number", "Product Name", "Colour", "Size", "MRP", "Category",
  "Product Image 1", "Product Image 2", "Product Image 3", "Product Image 4", "Product Image 5", "Product Image 6"];
const vendorSheet: Detected = {
  kind: "sheet", title: "Spring delivery", rows: 412, columns: VENDOR_HEADERS, headerRow: 0,
  identifierColumn: 1, identifierHeader: "Vendor Style Number", styleColumn: null, colourColumn: null,
  urlColumns: [7, 8, 9, 10, 11, 12], eanColumn: 0, cannotRead: null, message: "Sheet read.",
};

async function batch(options: Partial<BatchOptions> = {}): Promise<string> {
  const [b] = await db.insert(catalogBatches).values({
    brandSlug: "uspa", brandName: "USPA", name: `b${++seq}`, createdBy: "op@opptra.com",
    options: { ...DEFAULT_BATCH_OPTIONS, ...options },
  }).returning();
  return b!.id;
}

/**
 * PGlite's clock ticks in milliseconds, so two quick inserts can share created_at and the random
 * id tie-break would shuffle them. Each upload gets its own strictly later created_at, so the
 * step lists uploads in the order the test added them, as it does for real pastes.
 */
const T0 = Date.now();

async function addUpload(batchId: string, kind: UploadKind, detected: Detected | null, over: { name?: string; sourceUrl?: string; error?: string } = {}): Promise<string> {
  const n = ++seq;
  const [u] = await db.insert(catalogUploads).values({
    batchId, kind, name: over.name ?? `${kind}-${n}`, status: "collected", detected: detected as Record<string, unknown> | null,
    sourceUrl: over.sourceUrl ?? null, error: over.error ?? null, createdAt: new Date(T0 + n * 1000),
  }).returning();
  return u!.id;
}

/** Source rows for `identifier` with the given original names (shot order = list order). */
async function addProduct(batchId: string, uploadId: string, identifier: string, names: string[]): Promise<void> {
  const [p] = await db.insert(catalogProducts).values({
    brandSlug: "uspa", productKey: `${normalizeKey(identifier)}${++seq}`, pathKey: `${identifier}-${seq}`, identifier,
  }).returning();
  await db.insert(catalogSourceImages).values(
    names.map((originalName, i) => ({
      productId: p!.id, batchId, uploadId, n: i + 1, sha256: `${seq}-${i}`, originalName,
      rawUri: `gs://bkt/catalog/uspa/${batchId}/raw/${identifier}/${identifier}_${i + 1}.jpg`, mime: "image/jpeg",
    })),
  );
}

const files = (jpg: number, png = 0, heic = 0, other = 0): Detected => ({ kind: "image", fileCount: jpg + png + heic + other, formats: { jpg, png, heic, other }, message: "" });

describe("pure helpers", () => {
  it("letters columns like a spreadsheet", () => {
    expect([0, 1, 7, 12, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(["A", "B", "H", "M", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
    expect(() => columnLetter(-1)).toThrow();
  });

  it("joins a header range without repeating shared words", () => {
    expect(headerRange("Product Image 1", "Product Image 6")).toBe("Product Image 1 to 6");
    expect(headerRange("Image", "Lifestyle 2")).toBe("Image to Lifestyle 2");
    expect(headerRange("Image 1", "Image 1")).toBe("Image 1");
  });

  it("writes the formats sentence with and without PNG and HEIC", () => {
    expect(formatsSentence({ jpg: 1612, png: 34, heic: 2, other: 0 })).toBe(
      "1,612 JPG, 34 PNG (transparent backgrounds kept), 2 HEIC (iPhone format, converted automatically).",
    );
    expect(formatsSentence({ jpg: 12, png: 0, heic: 0, other: 0 })).toBe("12 JPG.");
    expect(formatsSentence({ jpg: 12, png: 0, heic: 3, other: 0 })).toBe("12 JPG, 3 HEIC (iPhone format, converted automatically).");
    expect(formatsSentence({ jpg: 12, png: 1, heic: 0, other: 2 })).toBe("12 JPG, 1 PNG (transparent backgrounds kept), 2 other.");
  });

  it("writes the sheet columns sentence", () => {
    const d = { identifierColumn: 1, identifierHeader: "Vendor Style Number", styleColumn: null, colourColumn: null, urlColumns: [7, 8, 9, 10, 11, 12] };
    expect(sheetColumnsSentence(d, VENDOR_HEADERS)).toBe(
      "We will use column B (Vendor Style Number) as the identifier and columns H to M (Product Image 1 to 6) as photos.",
    );
    expect(sheetColumnsSentence({ ...d, urlColumns: [7] }, VENDOR_HEADERS)).toBe(
      "We will use column B (Vendor Style Number) as the identifier and column H (Product Image 1) as photos.",
    );
    expect(sheetColumnsSentence({ ...d, identifierColumn: -1, styleColumn: 0, colourColumn: 3 }, ["Style No", "x", "y", "Colour Code"])).toBe(
      "Grouped by style and colour code (Style No + Colour Code)",
    );
    expect(sheetColumnsSentence({ ...d, identifierColumn: -1, identifierHeader: null }, VENDOR_HEADERS)).toBe("Could not tell which column holds the identifier.");
  });
});

describe("buildDetectedStep2", () => {
  it("files only: filename mode, precedence hidden, no sheet card, three examples with thumbnails", async () => {
    const b = await batch();
    const u = await addUpload(b, "image", files(7, 0, 0, 0));
    await addProduct(b, u, "ABC123", ["ABC123_1.jpg", "ABC123_2.jpg", "ABC123_3.jpg"]);
    await addProduct(b, u, "DEF456", ["DEF456_1.jpg", "DEF456_2.jpg"]);
    await addProduct(b, u, "ZZZ", ["ZZZ_1.jpg"]);
    await addProduct(b, u, "GHI789", ["GHI789_1.jpg"]);

    const s = await buildDetectedStep2(db, b, deps, { sign });
    expect(s.identifierMode.detected).toBe("filename");
    expect(s.identifierMode.options).toEqual(["filename"]);
    expect(s.identifierMode.examples).toEqual([
      {
        identifier: "ABC123", label: "from ABC123_1.jpg ... _3.jpg",
        thumbs: [1, 2, 3].map((n) => `https://signed.example/bkt/catalog/uspa/${b}/raw/ABC123/ABC123_${n}.jpg?ttl=900`),
      },
      { identifier: "DEF456", label: "from DEF456_1.jpg ... _2.jpg", thumbs: expect.any(Array) },
      { identifier: "GHI789", label: "from GHI789_1.jpg", thumbs: [`https://signed.example/bkt/catalog/uspa/${b}/raw/GHI789/GHI789_1.jpg?ttl=900`] },
    ]);
    expect(s.precedence).toEqual({ shown: false, default: "uploads_then_links" });
    expect(s.sheetColumns).toBeNull();
    expect(s.sheets).toEqual([]);
    expect(s.googleAccess).toEqual([]);
    expect(s.groupedBy).toBe("Grouped by file name (<identifier>_<n>)");
    expect(s.formats).toEqual({ jpg: 7, png: 0, heic: 0, other: 0, sentence: "7 JPG." });
  });

  it("files plus a sheet: precedence shown, sheet card and sheets[] entry with the exact sentence", async () => {
    const b = await batch();
    const z = await addUpload(b, "zip", { ...files(10, 2, 1), kind: "zip", topLevelFolders: ["Spring"] });
    const sheetId = await addUpload(b, "sheet", vendorSheet, { name: "spring.xlsx" });
    await addProduct(b, z, "ABC123", ["Spring/ABC123_1.jpg"]);

    const s = await buildDetectedStep2(db, b, deps, { sign });
    expect(s.precedence.shown).toBe(true);
    expect(s.identifierMode.detected).toBe("filename");
    expect(s.identifierMode.options).toEqual(["filename", "folder", "sheet_column"]);
    expect(s.formats.sentence).toBe("10 JPG, 2 PNG (transparent backgrounds kept), 1 HEIC (iPhone format, converted automatically).");
    expect(s.sheetColumns).toEqual({
      identifier: 1,
      images: [7, 8, 9, 10, 11, 12],
      sentence: "We will use column B (Vendor Style Number) as the identifier and columns H to M (Product Image 1 to 6) as photos.",
      choices: {
        identifier: VENDOR_HEADERS.map((header, column) => ({ column, header })),
        images: [{ columns: [7, 8, 9, 10, 11, 12], header: "Product Image 1 to 6" }],
      },
    });
    expect(s.sheets).toEqual([
      { uploadId: sheetId, name: "Spring delivery", identifierColumn: 1, identifierHeader: "Vendor Style Number", imageColumns: [7, 8, 9, 10, 11, 12], kind: "sheet", reading: false, cannotRead: null },
    ]);
  });

  it("a url list with files also shows the precedence card; a product list alone does not", async () => {
    const b1 = await batch();
    await addUpload(b1, "image", files(1));
    await addUpload(b1, "url_list", { kind: "url_list", message: "3 image links" });
    expect((await buildDetectedStep2(db, b1, deps, { sign })).precedence.shown).toBe(true);

    const b2 = await batch();
    await addUpload(b2, "image", files(1));
    await addUpload(b2, "sheet", { ...vendorSheet, urlColumns: [] });
    const s2 = await buildDetectedStep2(db, b2, deps, { sign });
    expect(s2.precedence.shown).toBe(false);
    expect(s2.sheets[0]!.kind).toBe("product_list");
    expect(s2.sheetColumns).toBeNull();
  });

  it("numeric stems in folders: folder mode detected, examples by folder", async () => {
    const b = await batch({ identifierMode: "folder" });
    const u = await addUpload(b, "image", files(5));
    await addProduct(b, u, "COSTER JR WHITE", ["COSTER JR WHITE/1.jpg", "COSTER JR WHITE/2.jpg", "COSTER JR WHITE/03.jpg"]);
    await addProduct(b, u, "ACHILLE", ["ACHILLE/1.jpg"]);
    await addProduct(b, u, "X", ["X_1.jpg"]);

    const s = await buildDetectedStep2(db, b, deps, { sign });
    expect(s.identifierMode.detected).toBe("folder");
    expect(s.identifierMode.options).toEqual(["filename", "folder"]);
    expect(s.identifierMode.examples.map((e) => [e.identifier, e.label])).toEqual([
      ["ACHILLE/", "1 files in the folder"],
      ["COSTER JR WHITE/", "3 files in the folder"],
      ["X/", "1 files in the folder"],
    ]);
    expect(s.groupedBy).toBe("Grouped by folder name");
  });

  it("only a sheet: sheet_column mode, the sheet column line and column labels", async () => {
    const b = await batch({ identifierMode: "sheet_column" });
    const u = await addUpload(b, "sheet", vendorSheet);
    await addProduct(b, u, "6W_COSTER_JR_OD_WHITE", ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "e.jpg"]);
    const s = await buildDetectedStep2(db, b, deps, { sign });
    expect(s.identifierMode.detected).toBe("sheet_column");
    expect(s.identifierMode.examples[0]).toMatchObject({ identifier: "6W_COSTER_JR_OD_WHITE", label: "column B, 5 photo links" });
    expect(s.identifierMode.examples[0]!.thumbs).toHaveLength(5);
    expect(s.groupedBy).toBe("Grouped by the sheet column Vendor Style Number");

    // An operator override of the columns wins over detection.
    await db.update(catalogBatches).set({ options: { ...DEFAULT_BATCH_OPTIONS, identifierMode: "sheet_column", sheetColumns: { identifier: 2, images: [7, 8] } } }).where(eq(catalogBatches.id, b));
    const o = await buildDetectedStep2(db, b, deps, { sign });
    expect(o.groupedBy).toBe("Grouped by the sheet column Product Name");
    expect(o.sheetColumns?.sentence).toBe("We will use column C (Product Name) as the identifier and columns H to I (Product Image 1 to 2) as photos.");
  });

  it("a composite style + colour sheet and a product list matched inside file names", async () => {
    const headers = ["Style Number", "Colour Code", "Colour Name", "Image 1", "Image 2"];
    const composite: Detected = {
      kind: "sheet", columns: headers, identifierColumn: -1, identifierHeader: undefined, styleColumn: 0, colourColumn: 1,
      urlColumns: [3, 4], eanColumn: null, cannotRead: null, message: "",
    };
    const b = await batch({ identifierMode: "sheet_column" });
    await addUpload(b, "sheet", composite);
    const s = await buildDetectedStep2(db, b, deps, { sign });
    expect(s.groupedBy).toBe("Grouped by style and colour code (Style Number + Colour Code)");
    expect(s.sheetColumns?.sentence).toBe("Grouped by style and colour code (Style Number + Colour Code)");

    const b2 = await batch();
    await addUpload(b2, "zip", { ...files(4), kind: "zip" });
    await addUpload(b2, "product_list", { ...composite, kind: "product_list", urlColumns: [] });
    expect((await buildDetectedStep2(db, b2, deps, { sign })).groupedBy).toBe("Matched by style and colour code found inside the file names");
  });

  it("a sheet whose identifier column could not be told carries cannotRead", async () => {
    const b = await batch();
    const id = await addUpload(b, "sheet", { ...vendorSheet, identifierColumn: -1, identifierHeader: undefined, cannotRead: "Could not tell which column holds the identifier." });
    const s = await buildDetectedStep2(db, b, deps, { sign });
    expect(s.sheets).toEqual([
      { uploadId: id, name: "Spring delivery", identifierColumn: -1, identifierHeader: null, imageColumns: [7, 8, 9, 10, 11, 12], kind: "sheet", reading: false, cannotRead: "Could not tell which column holds the identifier." },
    ]);
    expect(s.sheetColumns?.sentence).toBe("Could not tell which column holds the identifier.");
  });

  it("a sheet upload not read yet (no columns) is reading, not cannot-read", async () => {
    const b = await batch();
    // What the upload route stores when the file finishes uploading: no columns until the ingest reads it.
    const id = await addUpload(b, "sheet", { completedAt: "2026-10-27T10:00:00.000Z" } as unknown as Detected, { name: "grid.xlsx" });
    const s = await buildDetectedStep2(db, b, deps, { sign });
    expect(s.sheets).toEqual([
      { uploadId: id, name: "grid.xlsx", identifierColumn: -1, identifierHeader: null, imageColumns: [], kind: "sheet", reading: true, cannotRead: null },
    ]);
  });

  it("a failed sheet upload without columns is not reading", async () => {
    const b = await batch();
    await addUpload(b, "google_sheet", { kind: "google_sheet", message: "No access yet." }, { error: "No access yet." });
    const s = await buildDetectedStep2(db, b, deps, { sign });
    expect(s.sheets[0]).toMatchObject({ reading: false, cannotRead: "Could not tell which column holds the identifier." });
  });

  it("lists every pasted Google link with its access sentence", async () => {
    const b = await batch();
    await addUpload(b, "google_sheet", { kind: "google_sheet", title: "Deliveries", message: 'Google Sheet "Deliveries", 412 rows, 6 image columns found.' }, { sourceUrl: "https://docs.google.com/spreadsheets/d/1aB/edit" });
    await addUpload(b, "drive_folder", null, { sourceUrl: "https://drive.google.com/drive/folders/1xY", error: "Share the folder with the address above, then paste again." });
    await addUpload(b, "drive_folder", null, {
      sourceUrl: "https://drive.google.com/drive/folders/2zZ",
      error: "Your Google settings block sharing with our address. Download the folder as a zip and drop it instead.",
    });
    const s = await buildDetectedStep2(db, b, deps, { sign });
    expect(s.googleAccess).toEqual([
      { url: "https://docs.google.com/spreadsheets/d/1aB/edit", kind: "google_sheet", status: "ok", sentence: 'Google Sheet "Deliveries", 412 rows, 6 image columns found.' },
      { url: "https://drive.google.com/drive/folders/1xY", kind: "drive_folder", status: "no_access", sentence: "Share the folder with the address above, then paste again." },
      { url: "https://drive.google.com/drive/folders/2zZ", kind: "drive_folder", status: "blocked", sentence: "Your Google settings block sharing with our address. Download the folder as a zip and drop it instead." },
    ]);
  });

  it("the linkFailures block (spec 14b F5): failures by reason with the first example, temporary count and products, from the manifests", async () => {
    const b = await batch();
    const paste = await addUpload(b, "url_list", { kind: "url_list", message: "" });
    const H = "https://example.com/test_brand";
    // Row 1: 3 links of TB-A; row 2: 2 links of TB-B (tab cells); row 3 (TB-C): one link after an empty cell.
    const text = `${H}/TB-A_1.JPG\t${H}/TB-A_2.JPG\t${H}/TB-A_3.JPG\n${H}/TB-B_1.JPG\t${H}/TB-B_2.JPG\nTB-C\t\t${H}/TB-C_1.JPG`;
    const items = urlListItems(parsePastedLinks(text), paste);
    const reject = (k: number, got: string) => ({ ok: false as const, reason: `Row ${items[k]!.sheetRow}, column ${items[k]!.sheetHeader}: ${(items[k]!.bytes as { url: string }).url} did not return an image (got ${got}).` });
    const ok = { ok: true as const, sha256: "x", uri: "gs://bkt/x.jpg", mime: "image/jpeg", ext: "jpg", width: 600, height: 800, size: 10, flags: [] };
    const results = {
      [itemKey(items[0]!)]: ok, [itemKey(items[1]!)]: reject(1, "404"), [itemKey(items[2]!)]: reject(2, "404"),
      [itemKey(items[3]!)]: reject(3, "503"), [itemKey(items[4]!)]: reject(4, "text/html"),
      // items[5] (TB-C) not read yet: counted as a link, not as a failure.
    };
    const manifest = { version: 1, items, results, warnings: [], productList: false, detected: { kind: "url_list", message: "" } };
    objects.set(`gs://bkt/${manifestPath(batchPrefix("uspa", b, false), paste)}`, Buffer.from(JSON.stringify(manifest)));
    // Before the collection counted failed links the manifests are not read (step 2 polls this).
    expect((await buildDetectedStep2(db, b, deps, { sign })).linkFailures.total).toBe(0);
    const [row] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, b));
    await db.update(catalogBatches).set({ counts: { ...row!.counts, linkFailures: 4 } }).where(eq(catalogBatches.id, b));

    const s = await buildDetectedStep2(db, b, deps, { sign });
    expect(s.linkFailures).toEqual({
      total: 4, temporary: 1, links: 6, products: 2, attempts: 0,
      byReason: [
        { reason: "answered 'not found' (404)", count: 2, first: { url: `${H}/TB-A_2.JPG`, where: "row 1, column 2" } },
        { reason: "could not be reached", count: 1, first: { url: `${H}/TB-B_1.JPG`, where: "row 2, column 1" } },
        { reason: "returned a web page instead of an image", count: 1, first: { url: `${H}/TB-B_2.JPG`, where: "row 2, column 2" } },
      ],
    });
    expect(items[5]!.sheetHeader).toBe("3");
  });

  it("an empty linkFailures block when the batch holds no links", async () => {
    const b = await batch();
    await addUpload(b, "image", files(2));
    expect((await buildDetectedStep2(db, b, deps, { sign })).linkFailures).toEqual({ total: 0, temporary: 0, links: 0, products: 0, attempts: 0, byReason: [] });
  });

  it("refuses an unknown batch", async () => {
    await expect(buildDetectedStep2(db, "00000000-0000-0000-0000-000000000000", deps, { sign })).rejects.toThrow("This batch does not exist.");
  });
});
