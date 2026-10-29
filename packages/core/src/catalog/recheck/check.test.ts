import ExcelJS from "exceljs";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { writeLinksCsv, writeLinksXlsx, type SheetSpec } from "../sheet";
import { checkLink, recheckCsv, recheckLinks, sheetProblems, summarize } from "./check";
import { readCsvLinks, readSheetLinks } from "./links";

const noonJpeg = () => sharp({ create: { width: 1080, height: 1480, channels: 3, background: "#E0E0E0" } }).withDensity(72).withIccProfile("srgb").jpeg().toBuffer();
const reply = (body: Buffer, headers: Record<string, string> = {}, status = 200) =>
  vi.fn(async () => new Response(new Uint8Array(body), { status, headers: { "content-type": "image/jpeg", "x-goog-generation": "111", ...headers } }));
const url = "https://storage.googleapis.com/b/catalog-test/test_brand/abc/noon/abc_1.jpg";
const target = { url, identifier: "ABC", channel: "noon" as const, n: 1 };

describe("spec 18 H4: link check retries", () => {
  const answers = (...steps: (number | Error)[]) => {
    const jpegPromise = noonJpeg();
    return vi.fn(async () => {
      const step = steps.shift() ?? 200;
      if (step instanceof Error) throw step;
      return step === 200 ? new Response(new Uint8Array(await jpegPromise), { headers: { "content-type": "image/jpeg", "x-goog-generation": "111" } }) : new Response("busy", { status: step });
    });
  };
  it("retries a network error, a 5xx and a 429 twice, waiting 2 s then 5 s", async () => {
    for (const first of [new TypeError("fetch failed"), 503, 429]) {
      const sleep = vi.fn(async () => {}), f = answers(first, 500);
      const r = await checkLink(target, f, { sleep });
      expect(r).toMatchObject({ status: "ok", http: 200, problem: "" });
      expect(f).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls).toEqual([[2000], [5000]]);
    }
  });
  it("reports the last answer after two retries", async () => {
    const sleep = vi.fn(async () => {});
    expect((await checkLink(target, answers(503, 503, 502), { sleep })).problem).toBe("http_status");
    expect((await checkLink(target, answers(503, 503, 502), { sleep })).http).toBe(502);
    expect((await checkLink(target, answers(new TypeError("a"), new TypeError("b"), new TypeError("reset")), { sleep })).problem).toBe("fetch_error: reset");
  });
  it("never retries a 404 or a 403", async () => {
    for (const status of [404, 403]) {
      const sleep = vi.fn(async () => {}), f = answers(status);
      expect((await checkLink(target, f, { sleep })).problem).toBe("http_status");
      expect(f).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    }
  });
});

describe("re-check classification", () => {
  it("passes a compliant link at the recorded generation", async () => {
    const r = await checkLink({ ...target, expectedGeneration: "111" }, reply(await noonJpeg()));
    expect(r).toMatchObject({ status: "ok", http: 200, width: 1080, height: 1480, generation: "111", problem: "" });
  });
  it("names every failure kind", async () => {
    const jpeg = await noonJpeg();
    const problem = async (t: Parameters<typeof checkLink>[0], f = reply(jpeg)) => (await checkLink(t, f)).problem;
    expect(await problem({ ...target, expectedGeneration: "222" })).toBe("wrong_generation");
    expect(await problem({ ...target, url: url.replace(".jpg", ".JPG") })).toBe("bad_suffix");
    expect(await problem({ ...target, url: url.replace("https:", "http:") })).toBe("not_https");
    expect(await problem({ ...target, hyperlinkOk: false })).toBe("not_a_hyperlink");
    expect(await problem(target, reply(Buffer.from("missing"), {}, 404))).toBe("http_status");
    expect(await problem(target, reply(jpeg, { "content-type": "image/png" }))).toBe("not_jpeg_type");
    expect(await problem(target, reply(Buffer.from("not a jpeg")))).toBe("not_jpeg_bytes");
    expect(await problem({ ...target, channel: "styli" })).toBe("wrong_dimensions; wrong_density");
    expect(await problem(target, reply(await sharp({ create: { width: 1080, height: 1480, channels: 3, background: "#E0E0E0" } }).withDensity(72).jpeg().toBuffer()))).toBe("no_srgb_profile");
    expect((await checkLink(target, vi.fn(async () => { throw new TypeError("fetch failed"); }), { delaysMs: [0, 0] })).problem).toBe("fetch_error: fetch failed");
  });
  it("flags a duplicate URL without fetching it twice, and counts sheet problems in the total", async () => {
    const f = reply(await noonJpeg());
    const results = await recheckLinks([target, { ...target, n: 2 }], { fetch: f });
    expect(f).toHaveBeenCalledOnce();
    expect(results.map(r => r.problem)).toEqual(["", "duplicate_url"]);
    const problems = sheetProblems(["ABC", "ABC"], 1);
    expect(problems.map(p => p.problem)).toEqual(["duplicate_row", "row_count"]);
    expect(summarize(results, problems)).toEqual({ ok: 1, total: 4, line: "1 of 4 links OK", passed: false });
    expect(summarize([])).toEqual({ ok: 0, total: 1, line: "0 of 1 links OK", passed: false });
    expect(recheckCsv(results).split("\r\n")[0]).toContain("url,identifier,channel,n,status,http,bytes,width,height,generation,expected_generation,problem");
  });
});

describe("sheet readers", () => {
  const spec: SheetSpec = { channels: ["noon", "sixthstreet"], rows: [
    { brand: "Test Brand", identifier: "A", optionIdStyleColor: "", opptraSkuIds: [], links: { noon: ["https://x/a_n1.jpg", "https://x/a_n2.jpg"], sixthstreet: ["https://x/a_s1.jpg"] }, status: "ok", notes: "", change: "new", changedAt: null },
    { brand: "Test Brand", identifier: "B", optionIdStyleColor: "", opptraSkuIds: [], links: { noon: ["https://x/b_n1.jpg"], sixthstreet: ["https://x/b_s1.jpg"] }, status: "ok", notes: "", change: "new", changedAt: null },
  ] };
  it("reads the merged channel headers of the xlsx and the flat csv headers alike", async () => {
    const x = await readSheetLinks(await writeLinksXlsx(spec)), c = readCsvLinks(writeLinksCsv(spec));
    const shape = (l: { channel: string; n: number; identifier: string; url: string }) => `${l.identifier} ${l.channel} ${l.n} ${l.url}`;
    expect(x.links.map(shape)).toEqual(["A noon 1 https://x/a_n1.jpg", "A noon 2 https://x/a_n2.jpg", "A sixthstreet 1 https://x/a_s1.jpg", "B noon 1 https://x/b_n1.jpg", "B sixthstreet 1 https://x/b_s1.jpg"]);
    expect(c.links.map(shape)).toEqual(x.links.map(shape));
    expect(x.identifiers).toEqual(["A", "B"]);
    expect(x.links.every(l => l.hyperlinkOk)).toBe(true);
    expect(x.problems).toEqual([]);
  });
  it("marks a text cell that is not a hyperlink", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await writeLinksXlsx(spec) as unknown as Parameters<typeof wb.xlsx.load>[0]);
    wb.worksheets[0]!.getCell(3, 5).value = "https://x/a_n1.jpg";
    const x = await readSheetLinks(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(x.links.find(l => l.url === "https://x/a_n1.jpg")?.hyperlinkOk).toBe(false);
  });
});
