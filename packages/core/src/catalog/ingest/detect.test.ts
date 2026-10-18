import ExcelJS from "exceljs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { accessStatus, checkLinkAccess, detectPastedText, detectUploadKind } from "./detect";
import { FOLDER_TOO_LARGE } from "./drive-folder";
import type { DriveLike, SheetsLike } from "./types";

const SHEET_ID = "1aBcD_efGhIjKlMnOpQrStUvWxYz0123456789";
const FOLDER_ID = "1xYzFolder_0123456789abc";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`;
const FOLDER_URL = `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`;
const SUPA = "https://scbaqsxhzeouxqnijoex.supabase.co/storage/v1/object/public/softlines/anta";
const noFetch: typeof fetch = async () => { throw new Error("the access check never fetches"); };

const gaxios = (status: number, message: string, reason?: string) =>
  Object.assign(new Error(message), { status, response: { status, data: { error: { code: status, message, errors: reason ? [{ reason }] : [] } } } });

function sheets(fail?: unknown): SheetsLike {
  return {
    spreadsheets: {
      async get() {
        if (fail) throw fail;
        return { data: { properties: { title: "Styli - Kids 1 Option Sneaker" }, sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] } };
      },
      values: {
        async get() {
          const header = ["Option ID", "Name", ...[1, 2, 3, 4, 5, 6].map((n) => `Image ${n}`)];
          const row = (id: string) => [id, "Sneaker", ...[1, 2, 3, 4, 5, 6].map((n) => `${SUPA}/${id}/${id}_${n}.jpeg`)];
          return { data: { values: [header, ...["A1", "A2", "A3", "A4", "A5"].map(row)] } };
        },
      },
    },
  };
}

function drive(opts: { fail?: unknown; files?: { id: string; name: string; mimeType: string }[] }): DriveLike {
  return {
    files: {
      async list() {
        if (opts.fail) throw opts.fail;
        return { data: { files: opts.files ?? [], nextPageToken: null } };
      },
      async get() {
        throw new Error("the access check never downloads");
      },
    },
  };
}

describe("detectUploadKind", () => {
  it("tells zip, xlsx, csv and images apart by their bytes", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S").addRow(["Option ID"]);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const zipHead = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from("Images/ABC123_1.jpg")]);
    const xlsxHead = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from("xl/workbook.xml")]);
    const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } }).jpeg().toBuffer();
    const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#0000" } }).png().toBuffer();
    const webp = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } }).webp().toBuffer();
    const tiff = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } }).tiff().toBuffer();
    const gif = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#fff" } }).gif().toBuffer();
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(12)]);

    expect(detectUploadKind("photos.zip", zipHead)).toBe("zip");
    expect(detectUploadKind("delivery.xlsx", xlsx.subarray(0, 64))).toBe("sheet");
    expect(detectUploadKind("download", xlsxHead)).toBe("sheet");
    expect(detectUploadKind("links.csv", Buffer.from("Option ID,Image 1\r\n"))).toBe("sheet");
    expect(detectUploadKind("LINKS.CSV", Buffer.from("a,b"))).toBe("sheet");
    for (const [name, buf] of [["a.jpg", jpeg], ["a.png", png], ["a.webp", webp], ["a.tif", tiff], ["a.gif", gif], ["IMG_2041.HEIC", ftyp("heic")], ["a.avif", ftyp("avif")]] as const) {
      expect(detectUploadKind(name, buf), name).toBe("image");
    }
    expect(detectUploadKind("scan.bmp", Buffer.from([0x42, 0x4d, 0, 0, 0, 0]))).toBe("unknown");
    expect(detectUploadKind("spec.pdf", Buffer.from("%PDF-1.7"))).toBe("unknown");
  });
});

describe("detectPastedText", () => {
  it("finds a pasted sheet link, a folder link, a URL list, and nothing in junk", () => {
    expect(detectPastedText(`  ${SHEET_URL}  `)).toEqual({ kind: "google_sheet", ids: [SHEET_ID] });
    expect(detectPastedText(FOLDER_URL)).toEqual({ kind: "drive_folder", ids: [FOLDER_ID] });
    expect(detectPastedText(`https://drive.google.com/drive/u/0/folders/${FOLDER_ID}`)).toEqual({ kind: "drive_folder", ids: [FOLDER_ID] });
    expect(detectPastedText(`${SUPA}/A/A_1.jpeg\n\nB1\t${SUPA}/B/x.jpeg\n`)).toEqual({ kind: "url_list", ids: [`${SUPA}/A/A_1.jpeg`, `${SUPA}/B/x.jpeg`] });
    expect(detectPastedText("hello there\nnot a link")).toBeNull();
    expect(detectPastedText("")).toBeNull();
  });
});

describe("checkLinkAccess", () => {
  it("a readable sheet", async () => {
    const r = await checkLinkAccess(SHEET_URL, { sheets: sheets(), fetch: noFetch });
    expect(r).toMatchObject({ kind: "google_sheet", title: "Styli - Kids 1 Option Sneaker", rows: 5, message: 'Google Sheet "Styli - Kids 1 Option Sneaker", 5 rows, 6 image columns found.' });
    expect(accessStatus(r)).toBe("ok");
  });

  it("a 403 from Sheets", async () => {
    const r = await checkLinkAccess(SHEET_URL, { sheets: sheets(gaxios(403, "The caller does not have permission")), fetch: noFetch });
    expect(r).toEqual({ kind: "google_sheet", error: "Share the sheet with the address above, then paste again." });
    expect(accessStatus(r)).toBe("no_access");
  });

  it("a 403 or 404 from Drive for a folder", async () => {
    for (const fail of [gaxios(403, "Insufficient permissions"), gaxios(404, "File not found")]) {
      expect(await checkLinkAccess(FOLDER_URL, { drive: drive({ fail }), fetch: noFetch })).toEqual({ kind: "drive_folder", error: "Share the folder with the address above, then paste again." });
    }
    expect(await checkLinkAccess(FOLDER_URL, { drive: drive({ files: [] }), fetch: noFetch })).toEqual({ kind: "drive_folder", error: "Share the folder with the address above, then paste again." });
    const ok = await checkLinkAccess(FOLDER_URL, { drive: drive({ files: [{ id: "f", name: "ABC_1.jpg", mimeType: "image/jpeg" }] }), fetch: noFetch });
    expect(ok).toEqual({ kind: "drive_folder", message: "Drive folder found. We will copy its files when you start." });
  });

  it("a 403 that mentions domain policy or cannotShareOutsideDomain", async () => {
    const sentence = "Your Google settings block sharing with our address. Download the folder as a zip and drop it instead.";
    const r1 = await checkLinkAccess(FOLDER_URL, { drive: drive({ fail: gaxios(403, "Forbidden", "cannotShareOutsideDomain") }), fetch: noFetch });
    const r2 = await checkLinkAccess(SHEET_URL, { sheets: sheets(gaxios(403, "Access denied by domain policy")), fetch: noFetch });
    expect(r1).toEqual({ kind: "drive_folder", error: sentence });
    expect(r2).toEqual({ kind: "google_sheet", error: sentence });
    expect(accessStatus(r1)).toBe("blocked");
    expect(accessStatus({ kind: "drive_folder", error: FOLDER_TOO_LARGE })).toBe("blocked");
  });

  it("a URL list", async () => {
    const r = await checkLinkAccess(`${SUPA}/A/A_1.jpeg\n${SUPA}/A/A_2.jpeg\n\n${SUPA}/B/B_1.jpeg`, { fetch: noFetch });
    expect(r).toEqual({ kind: "url_list", fileCount: 3, rows: 3, message: "We will download them when you start. No sharing needed." });
  });

  it("rethrows errors that are not about access", async () => {
    await expect(checkLinkAccess(SHEET_URL, { sheets: sheets(gaxios(503, "unavailable")), fetch: noFetch })).rejects.toThrow("unavailable");
  });
});
