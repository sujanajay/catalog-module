import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CatalogUpload } from "../../db/schema";
import { fetchSourceUrl, parseUrlList, urlListAdapter, urlListItems } from "./url-list";
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

const item = (url: string): SourceItem => urlListItems(url, "u1")[0]!;

describe("parseUrlList", () => {
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
