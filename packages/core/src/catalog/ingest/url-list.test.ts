import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CatalogUpload } from "../../db/schema";
import { readFileSync } from "node:fs";
import { fetchSourceUrl, parsePastedLinks, urlListAdapter, urlListItems } from "./url-list";
import { cellUrls } from "./links-sheet";
import type { IngestDeps, SourceItem } from "./types";

const SUPA = "https://scbaqsxhzeouxqnijoex.supabase.co/storage/v1/object/public/softlines/fcuk";
const lookup = async () => ["104.18.38.10"];

/** Fake fetch: answers from a table by URL and records every request's method. */
function fakeFetch(answers: Record<string, () => Response>) {
  const calls: { url: string; method: string }[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    const answer = answers[url];
    return answer ? answer() : new Response("missing", { status: 404 });
  };
  return { f, calls };
}

const item = (url: string): SourceItem => urlListItems(parsePastedLinks(url), "u1")[0]!;
/** The old one-link-per-line reading: (identifier, url) per link. */
const parseUrlList = (text: string) => parsePastedLinks(text).rows.flatMap((r) => r.urls.map((url) => ({ identifier: r.identifier, url })));

describe("parsePastedLinks, one link per line (unchanged)", () => {
  it("reads plain lines, identifier<TAB>url lines and skips blank lines", () => {
    const text = [
      `${SUPA}/ABC123/ABC123_1.jpeg`,
      "",
      "   ",
      `XYZ-9\t${SUPA}/x/front.jpg`,
      `  ${SUPA}/DEF456/DEF456-2.jpeg  `,
      "not a link",
      `${SUPA}/T/T_1.jpg\t`,
    ].join("\r\n");
    expect(parseUrlList(text)).toEqual([
      { identifier: null, url: `${SUPA}/ABC123/ABC123_1.jpeg` },
      { identifier: "XYZ-9", url: `${SUPA}/x/front.jpg` },
      { identifier: null, url: `${SUPA}/DEF456/DEF456-2.jpeg` },
      { identifier: null, url: `${SUPA}/T/T_1.jpg` },
    ]);
  });
});

const fixture = (name: string) => readFileSync(new URL(`../../../test-fixtures/catalog/intake/${name}`, import.meta.url), "utf8");
const H = "https://example.com/test_brand";

describe("parsePastedLinks, a pasted grid (spec 14b F2)", () => {
  it("reads intake-pasted-grid.txt as 6 rows of 4 to 5 links named from the file names", () => {
    const t = parsePastedLinks(fixture("intake-pasted-grid.txt"));
    expect(t.rows.length).toBe(6);
    expect(t.links).toBe(27);
    expect(t.linksPerRow).toEqual({ min: 4, max: 5 });
    expect(t.shape).toBe("links_grid");
    expect(t.ignoredCells).toBe(3);
    expect(t.collisions).toEqual([]);
    expect(t.rows.every((r) => r.identifier === null)).toBe(true);
    expect(t.rows.map((r) => r.name)).toEqual(["BH-4610-NE-NERO", "BH-4611-BX-BOXER", "BH-4612-MO-MOCHA", "BH-4613-TN-TAN", "BH-4614-OL-OLIVE", "BHSS2620Z-WHITE NAVY"]);
    expect(t.rows[5]!.urls[0]).toBe(`${H}/BHSS2620Z-WHITE NAVY_1.JPG`);

    const items = urlListItems(t, "u1");
    expect(items.filter((i) => i.identifier === "BH-4610-NE-NERO").map((i) => i.n)).toEqual([1, 2, 3, 4, 5]);
    const space = items.filter((i) => i.identifier === "BHSS2620Z-WHITE NAVY");
    expect(space.map((i) => [i.n, i.originalName])).toEqual([1, 2, 3, 4, 5].map((n) => [n, `BHSS2620Z-WHITE NAVY_${n}.JPG`]));
    expect(space.map((i) => (i.bytes.kind === "url" ? i.bytes.url : ""))).toEqual([1, 2, 3, 4, 5].map((n) => `${H}/BHSS2620Z-WHITE%20NAVY_${n}.JPG`));
    // The blank cell of row 5 does not shift the shots of that row.
    expect(items.filter((i) => i.identifier === "BH-4614-OL-OLIVE").map((i) => [i.n, i.originalName])).toEqual([1, 2, 3, 4].map((n) => [n, `BH-4614-OL-OLIVE_${n}.JPG`]));
  });

  it("reads intake-pasted-variants.txt: identifiers, a space-separated pair, single links and a same-name pair", () => {
    const t = parsePastedLinks(fixture("intake-pasted-variants.txt"));
    expect(t.rows.length).toBe(7);
    expect(t.links).toBe(12);
    expect(t.linksPerRow).toEqual({ min: 1, max: 2 });
    expect(t.shape).toBe("id_and_links");
    expect(t.ignoredCells).toBe(0);
    expect(t.rows.map((r) => [r.row, r.identifier, r.urls.length, r.name])).toEqual([
      [1, null, 2, "TB-A"],
      [2, "TB-B", 2, "TB-B"],
      [3, null, 2, "TB-C"],
      [4, null, 1, null],
      [5, null, 1, null],
      [6, null, 2, "TB-F"],
      [7, null, 2, "TB-F"],
    ]);
    expect(t.collisions).toEqual([{ name: "TB-F", rows: [6, 7] }]);
    const items = urlListItems(t, "u1");
    expect(items.filter((i) => i.identifier === "TB-A").map((i) => i.n)).toEqual([1, 2]);
    expect(items.filter((i) => i.identifier === "TB-C").map((i) => i.originalName)).toEqual(["TB-C_1.JPG", "TB-C_2.JPG"]);
    // Rows 4 and 5 keep today's grouping by file name.
    expect(items.filter((i) => i.identifier === "TB-D" || i.identifier === "TB-E").map((i) => [i.identifier, i.n])).toEqual([["TB-D", 1], ["TB-E", 1]]);
  });

  it("never splits a cell inside a link, treats filler cells as ignored and never takes a link as identifier", () => {
    const t = parsePastedLinks([`BH-4610-NE Black\t${H}/X-WHITE NAVY_1.jpg\tn/a\t-\t${H}/X-WHITE NAVY_2.jpg`, `0\t${H}/Y_1.jpg\tcolour\t`].join("\n"));
    expect(t.rows.map((r) => [r.identifier, r.urls, r.name])).toEqual([
      ["BH-4610-NE Black", [`${H}/X-WHITE NAVY_1.jpg`, `${H}/X-WHITE NAVY_2.jpg`], "BH-4610-NE Black"],
      ["colour", [`${H}/Y_1.jpg`], "colour"],
    ]);
    expect(t.ignoredCells).toBe(4);
  });

  it("does not report repeated identifiers of one link per line as a collision", () => {
    expect(parsePastedLinks(`A\t${H}/a_1.jpg\nA\t${H}/a_2.jpg`).collisions).toEqual([]);
    expect(parsePastedLinks(`A\t${H}/a_1.jpg\t${H}/a_2.jpg\nA\t${H}/b_1.jpg\t${H}/b_2.jpg\na\t${H}/c_1.jpg`).collisions).toEqual([{ name: "A", rows: [1, 2, 3] }]);
  });
});

describe("cellUrls (spec 14b F2)", () => {
  it("splits only before a following link, so a link with a space stays whole", () => {
    expect(cellUrls(`${H}/a_1.jpg\n${H}/a_2.jpg`)).toHaveLength(2);
    expect(cellUrls(`${H}/a_1.jpg ${H}/a_2.jpg`)).toHaveLength(2);
    expect(cellUrls(`${H}/a_1.jpg,${H}/a_2.jpg`)).toHaveLength(2);
    expect(cellUrls(`${H}/a_1.jpg; ${H}/a_2.jpg;`)).toEqual([`${H}/a_1.jpg`, `${H}/a_2.jpg`]);
    expect(cellUrls(`${H}/X-WHITE NAVY_1.jpg`)).toEqual([`${H}/X-WHITE NAVY_1.jpg`]);
    expect(cellUrls("BH-4610-NE Black")).toEqual([]);
  });
});

describe("urlListAdapter", () => {
  it("takes the pasted identifier, else the URL file name stem", async () => {
    const text = [`${SUPA}/ABC123/ABC123_1.jpeg`, `${SUPA}/ABC123/ABC123_02.jpeg`, `XYZ-9\t${SUPA}/x/front.jpg`, `xyz9\t${SUPA}/x/back.jpg`, `${SUPA}/P1/1.jpg`].join("\n");
    const upload = { id: "u1", kind: "url_list", name: "Pasted links", sourceUrl: text, gcsUri: null } as CatalogUpload;
    const items = await urlListAdapter.collect({
      batchId: "b", brandSlug: "fcuk", prefix: "catalog-test/fcuk/b", upload,
      options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null },
      deps: { storage: {} as IngestDeps["storage"], fetch: async () => { throw new Error("collect never fetches"); } },
    });
    expect(items.map((i) => [i.identifier, i.n, i.folder, i.originalName, i.ext])).toEqual([
      ["ABC123", 1, "ABC123", "ABC123_1.jpeg", "jpeg"],
      ["ABC123", 2, "ABC123", "ABC123_02.jpeg", "jpeg"],
      ["XYZ-9", 1, "x", "front.jpg", "jpg"],
      ["xyz9", 2, "x", "back.jpg", "jpg"],
      ["", 1, "P1", "1.jpg", "jpg"],
    ]);
    expect(items.every((i) => i.bytes.kind === "url" && i.origin === "url_list" && i.sheetIdentifier === null)).toBe(true);
  });

  it("reads the pasted text from the upload object when it was stored", async () => {
    const upload = { id: "u2", kind: "url_list", name: "links.txt", sourceUrl: null, gcsUri: "gs://b/p/uploads/u2/links.txt" } as CatalogUpload;
    const storage = { downloadBuffer: async () => ({ buf: Buffer.from(`${SUPA}/A/A_1.jpg\n`), mime: "text/plain" }) } as unknown as IngestDeps["storage"];
    const items = await urlListAdapter.collect({
      batchId: "b", brandSlug: "fcuk", prefix: "p", upload,
      options: { identifierMode: "filename", precedence: "uploads_then_links", sheetColumns: null },
      deps: { storage, fetch: async () => new Response() },
    });
    expect(items.map((i) => i.identifier)).toEqual(["A"]);
  });
});

describe("fetchSourceUrl", () => {
  it("returns the image bytes, sniffing them when the content type is generic, with GET only", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#ffffff" } }).png().toBuffer();
    const a = `${SUPA}/A/A_1.jpeg`;
    const b = "https://sceimage.blob.core.windows.net/img/B_1";
    const { f, calls } = fakeFetch({
      [a]: () => new Response(png, { status: 200, headers: { "content-type": "image/jpeg" } }),
      [b]: () => new Response(png, { status: 200, headers: { "content-type": "application/octet-stream" } }),
    });
    const ra = await fetchSourceUrl(item(a), { fetch: f }, { lookup });
    expect(ra).toMatchObject({ ok: true, mime: "image/jpeg", finalUrl: a });
    const rb = await fetchSourceUrl(item(b), { fetch: f }, { lookup });
    expect(rb).toMatchObject({ ok: true, mime: "image/png" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
  });

  it("rejects a non-image response with its sentence and never sends anything but GET", async () => {
    const url = `${SUPA}/ABC123/ABC123_1.jpeg?token=secret`;
    const { f, calls } = fakeFetch({
      [url]: () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
      "https://cdn.example.com/moved.jpg": () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/gone.jpg" } }),
    });
    expect(await fetchSourceUrl(item(url), { fetch: f }, { lookup })).toEqual({
      ok: false, reason: `${SUPA}/ABC123/ABC123_1.jpeg did not return an image (got text/html).`,
    });
    expect(await fetchSourceUrl(item("https://cdn.example.com/moved.jpg"), { fetch: f }, { lookup })).toEqual({
      ok: false, reason: "https://cdn.example.com/moved.jpg did not return an image (got 404).",
    });
    expect(calls.map((c) => [c.url, c.method])).toEqual([
      [url, "GET"], ["https://cdn.example.com/moved.jpg", "GET"], ["https://cdn.example.com/gone.jpg", "GET"],
    ]);
  });

  it("reports a refused link with the safe-fetch reason, without fetching", async () => {
    const { f, calls } = fakeFetch({});
    expect(await fetchSourceUrl(item("http://cdn.example.com/a_1.jpg"), { fetch: f }, { lookup })).toEqual({
      ok: false, reason: "http://cdn.example.com/a_1.jpg did not return an image (got Only https links can be used: http://cdn.example.com/a_1.jpg).",
    });
    expect(calls).toEqual([]);
  });
});
