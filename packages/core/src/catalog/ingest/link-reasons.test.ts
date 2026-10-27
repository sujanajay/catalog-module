// Tier 1: stored link rejects read back as failures with a position, a reason phrase and a class (spec 14b F5 part 1).
import { describe, expect, it } from "vitest";
import { classifyImageReject } from "./image-check";
import { classifyLinkReject, LINK_REASON, noLinkPhotosReason } from "./link-reasons";
import { parsePastedLinks } from "./url-list";

const H = "https://example.com/test_brand";
const sentence = (got: string, where = "Row 2, column 3: ") => `${where}${H}/A_1.JPG did not return an image (got ${got}).`;

describe("classifyLinkReject", () => {
  it("classes statuses: 408, 425, 429 and 5xx of the list may be temporary; 404, 403, 410 are permanent", () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) expect(classifyLinkReject(sentence(String(s)))!.temporary).toBe(true);
    for (const s of [404, 403, 410, 401, 501]) expect(classifyLinkReject(sentence(String(s)))!.temporary).toBe(false);
    expect(classifyLinkReject(sentence("404"))).toEqual({ url: `${H}/A_1.JPG`, where: "row 2, column 3", phrase: LINK_REASON.notFound, temporary: false });
    expect(classifyLinkReject(sentence("403"))!.phrase).toBe(LINK_REASON.refused);
    expect(classifyLinkReject(sentence("504"))!.phrase).toBe(LINK_REASON.timeout);
  });

  it("classes answers and errors: a web page, another type, http only and internal addresses are permanent; timeouts and network errors may be temporary", () => {
    expect(classifyLinkReject(sentence("text/html"))).toMatchObject({ phrase: LINK_REASON.webPage, temporary: false });
    expect(classifyLinkReject(sentence("application/pdf"))).toMatchObject({ phrase: LINK_REASON.unreachable, temporary: false });
    expect(classifyLinkReject(sentence("Only https links can be used: http://example.com/A_1.JPG"))).toMatchObject({ phrase: LINK_REASON.http, temporary: false });
    expect(classifyLinkReject(sentence("Links to internal addresses cannot be used: 10.0.0.1"))).toMatchObject({ phrase: LINK_REASON.unreachable, temporary: false });
    expect(classifyLinkReject(sentence(`Downloading ${H}/A_1.JPG took longer than 60 seconds`))).toMatchObject({ phrase: LINK_REASON.timeout, temporary: true });
    expect(classifyLinkReject(sentence(`Could not download ${H}/A_1.JPG: fetch failed`))).toMatchObject({ phrase: LINK_REASON.unreachable, temporary: true });
  });

  it("reads a sheet header with spaces and a sentence without a position; other sentences are not links", () => {
    expect(classifyLinkReject(sentence("404", "Row 4, column Product Image 2: "))!.where).toBe("row 4, column Product Image 2");
    expect(classifyLinkReject(sentence("404", ""))!.where).toBeNull();
    expect(classifyLinkReject("scan.bmp is a BMP file. Save it as JPEG or PNG and add it again.")).toBeNull();
    expect(classifyImageReject(sentence("404"))).toBe("link");
    expect(classifyImageReject("lookbook.pdf is not an image.")).toBe("not_image");
  });

  it("says the no-photos sentence for links with one line per reason, most first", () => {
    const rejects = [404, 404, 503].map((s, i) => ({ ...classifyLinkReject(sentence(String(s), `Row ${i + 1}, column 1: `))! }));
    expect(noLinkPhotosReason(rejects, 3, "listed in Deliveries")).toBe(
      `No photos could be downloaded from the 3 links you listed in Deliveries. 2 answered 'not found' (404), for example ${H}/A_1.JPG (row 1, column 1). ` +
      `1 could not be reached, for example ${H}/A_1.JPG (row 3, column 1). Some of these may work on a second try. Press Try the failed links again.`,
    );
  });
});

describe("pasted link positions", () => {
  it("gives each link its cell number on the line, counting empty cells and links split in one cell", () => {
    const t = parsePastedLinks(`TB-C\t\t${H}/a_1.jpg\t0\n${H}/b_1.jpg ${H}/b_2.jpg`);
    expect(t.rows.map((r) => [r.row, r.columns])).toEqual([[1, [3]], [2, [1, 2]]]);
  });
});
