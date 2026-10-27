import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { accessStatus, checkLinkAccess, detectPastedText, detectUploadKind, pasteReadback } from "./detect";
import { FOLDER_TOO_LARGE } from "./drive-folder";
import type { Detected, DriveLike, SheetsLike } from "./types";

/** Every host resolves to a public address, so no DNS is used. */
const lookup = async () => ["93.184.215.14"];

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

  it("a URL list, one link per line, whose links cannot be reached is still a result", async () => {
    const r = await checkLinkAccess(`${SUPA}/A/A_1.jpeg\n${SUPA}/A/A_2.jpeg\n\n${SUPA}/B/B_1.jpeg`, { fetch: noFetch, lookup });
    expect(r).toMatchObject({ kind: "url_list", fileCount: 3, rows: 3, shape: "one_per_line", sample: { tried: 3, ok: 0, webPages: 0 } });
    expect(accessStatus(r)).toBe("ok");
    expect(pasteReadback(r as Detected)).toEqual({
      pill: "3 image links",
      message: "Products will be named from the file names, for example A. We opened the first 3 links: 0 of 3 opened; could not be reached.",
      notes: [],
    });
  });

  it("rethrows errors that are not about access", async () => {
    await expect(checkLinkAccess(SHEET_URL, { sheets: sheets(gaxios(503, "unavailable")), fetch: noFetch })).rejects.toThrow("unavailable");
  });
});

describe("the paste readback (spec 14b F2)", () => {
  const fixture = (name: string) => readFileSync(new URL(`../../../test-fixtures/catalog/intake/${name}`, import.meta.url), "utf8");
  const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

  /** A fake image host: every example.com link answers a jpeg head with 206 (or what `answer` says); records each request. */
  function imageHost(answer: (url: string) => Response | null = () => null) {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const f: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) } });
      return answer(url) ?? new Response(new Uint8Array(JPEG_HEAD), { status: 206, headers: { "content-type": "application/octet-stream" } });
    };
    return { f, calls };
  }
  const text = (d: Detected) => {
    const r = pasteReadback(d);
    return [r.pill, r.message, ...r.notes];
  };

  it("reads back the grid fixture, opening the first 3 links with a Range header and nothing else", async () => {
    const host = imageHost();
    const r = await checkLinkAccess(fixture("intake-pasted-grid.txt"), { fetch: host.f, lookup });
    expect(r).toMatchObject({ kind: "url_list", rows: 6, fileCount: 27, linksPerRow: { min: 4, max: 5 }, shape: "links_grid", collisions: [], ignoredCells: 3, sample: { tried: 3, ok: 3, webPages: 0, failures: [] } });
    expect(text(r as Detected)).toEqual([
      "6 rows, 27 links",
      "4 to 5 links per row. This paste has no product code column, so products will be named from the photo file names, for example BH-4610-NE-NERO. To name them yourself, copy the product code column in as the first column. We opened the first 3 links: all fine.",
      "3 empty or non-link cells were ignored.",
    ]);
    expect(host.calls).toEqual([1, 2, 3].map((n) => ({ url: `https://example.com/test_brand/BH-4610-NE-NERO_${n}.JPG`, method: "GET", headers: { Range: "bytes=0-1023" } })));
  });

  it("reads back the variants fixture with its same-name rows", async () => {
    const host = imageHost();
    const r = await checkLinkAccess(fixture("intake-pasted-variants.txt"), { fetch: host.f, lookup });
    expect(text(r as Detected)).toEqual([
      "7 rows, 12 links",
      "1 to 2 links per row. Products will be named by the first column, for example TB-B. We opened the first 3 links: all fine.",
      "Rows 6 and 7 would get the same name, TB-F. Check those rows before you continue.",
    ]);
    expect(host.calls).toHaveLength(3);
  });

  it("explains a share page and still accepts the paste", async () => {
    const share = "https://www.dropbox.example.com/s/tbd1share/TB-D_1.JPG?dl=0";
    const host = imageHost(() => new Response("<!doctype html><html>Dropbox</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }));
    const r = await checkLinkAccess(share, { fetch: host.f, lookup });
    expect(accessStatus(r)).toBe("ok");
    expect((r as Detected).sample).toEqual({ tried: 1, ok: 0, webPages: 1, failures: [{ url: "https://www.dropbox.example.com/s/tbd1share/TB-D_1.JPG", reason: "returned a web page instead of an image" }] });
    expect(text(r as Detected)).toEqual([
      "1 image link",
      "Products will be named from the file names, for example TB-D. We opened the link: 0 of 1 opened; returned a web page instead of an image.",
      "These look like share pages, not image links. Download the photos and drop them here, or paste direct image links.",
    ]);
  });

  it("names the first failure: 404, 403, a timeout and an http link", async () => {
    const host = imageHost((url) => (url.includes("_1") ? new Response("gone", { status: 404 }) : url.includes("_2") ? new Response("no", { status: 403 }) : null));
    const r = (await checkLinkAccess(["https://example.com/a/A_1.jpg", "https://example.com/a/A_2.jpg", "http://example.com/a/A_3.jpg"].join("\n"), { fetch: host.f, lookup })) as Detected;
    expect(r.sample!.failures.map((f) => f.reason)).toEqual(["answered 'not found' (404)", "were refused (403)", "use http instead of https"]);
    expect(r.message).toBe("Products will be named from the file names, for example A. We opened the first 3 links: 0 of 3 opened; answered 'not found' (404).");
    // The 5 s timeout ends the request with a TimeoutError (safeFetch's AbortSignal.timeout).
    const timedOut: typeof fetch = async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); };
    const t = (await checkLinkAccess("https://example.com/a/A_1.jpg", { fetch: timedOut, lookup })) as Detected;
    expect(t.sample!.failures[0]!.reason).toBe("did not answer in time");
  });
});
