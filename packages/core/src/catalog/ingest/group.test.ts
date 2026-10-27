import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import { parseShotName } from "../naming";
import type { BatchOptions, IdentifierMode, Precedence } from "../types";
import {
  duplicatePhotosPair,
  groupItems,
  originalOf,
  previewRows,
  samePhotosPair,
  shotFlags,
  warningSentences,
  type ItemDimensions,
  type ProductListRow,
} from "./group";
import { notImageMessage, unsupportedMessage } from "./image-check";
import { linkStatuses } from "./product-list";
import { sourceItemFromPath } from "./local-files";
import type { GroupingResult, SourceItem } from "./types";
import { nestedZipMessage } from "./zip";

const opts = (identifierMode: IdentifierMode = "filename", precedence: Precedence = "uploads_then_links"): BatchOptions => ({
  ...DEFAULT_BATCH_OPTIONS, identifierMode, precedence,
});

const file = (path: string, uploadId = "u1"): SourceItem =>
  sourceItemFromPath(path, { kind: "gcs", gsUri: `gs://bkt/p/uploads/${uploadId}/${path}` }, uploadId, "image");

/** A links-sheet item as the sheet adapter makes it: sheet identifier, n from the column order. */
const link = (sheetIdentifier: string, n: number): SourceItem => ({
  identifier: sheetIdentifier, n, suffix: "", originalName: `${sheetIdentifier}-${n}.jpg`, folder: null, sheetIdentifier,
  ext: "jpg", bytes: { kind: "url", url: `https://x.supabase.co/storage/v1/object/public/a/${sheetIdentifier}-${n}.jpg` },
  uploadId: "sheet1", origin: "sheet", warnings: [],
});

/** identifier -> [n, originalName][] */
function shape(g: GroupingResult) {
  return Object.fromEntries([...g.products].map(([id, items]) => [id, items.map((i) => [i.n, i.originalName])]));
}

const shuffle = <T>(xs: T[], seed: number): T[] => {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

describe("parseShotName (02), as ingestion uses it", () => {
  it("reads _n, -n and _0n alike, keeps hyphens, and finds the shape suffix", () => {
    for (const name of ["ABC123_1.jpg", "ABC123-1.jpg", "ABC123_01.jpg"]) {
      expect(parseShotName(name)).toMatchObject({ identifier: "ABC123", n: 1 });
    }
    expect(parseShotName("ABC-123_2.jpg")).toMatchObject({ identifier: "ABC-123", n: 2 });
    expect(parseShotName("ABC123_rect_3.jpg")).toMatchObject({ identifier: "ABC123", n: 3, suffix: "_rect" });
  });

  it("keeps four or more trailing digits in the identifier, and grouping makes them shot 1", () => {
    const long = "ONLY-SHOES_Autumnwinter_5079628_15380145.jpg";
    expect(parseShotName(long)).toMatchObject({ identifier: "ONLY-SHOES_Autumnwinter_5079628_15380145", n: null });
    expect(parseShotName("IMG_2041.heic")).toMatchObject({ identifier: "IMG_2041", n: null });
    const g = groupItems([file(long), file("IMG_2041.heic")], opts());
    expect(shape(g)).toEqual({
      IMG_2041: [[1, "IMG_2041.heic"]],
      "ONLY-SHOES_Autumnwinter_5079628_15380145": [[1, long]],
    });
  });
});

describe("groupItems", () => {
  const tree = [
    file("Shoes/ABC123/ABC123_1.jpg"),
    file("Shoes/ABC123/ABC123_2.jpg"),
    file("Shoes/DEF456/1.jpg"),
    file("Shoes/DEF456/02.jpg"),
    file("Shoes/XYZ/front.jpg"),
    file("Shoes/XYZ/back.jpg"),
    link("GHI789", 1),
    link("GHI789", 2),
    link("abc-123", 3),
  ];

  it("filename mode: identifiers from file names, numeric stems from their folder, links join by key", () => {
    expect(shape(groupItems(tree, opts("filename")))).toEqual({
      ABC123: [[1, "Shoes/ABC123/ABC123_1.jpg"], [2, "Shoes/ABC123/ABC123_2.jpg"], [3, "abc-123-3.jpg"]],
      back: [[1, "Shoes/XYZ/back.jpg"]],
      DEF456: [[1, "Shoes/DEF456/1.jpg"], [2, "Shoes/DEF456/02.jpg"]],
      front: [[1, "Shoes/XYZ/front.jpg"]],
      GHI789: [[1, "GHI789-1.jpg"], [2, "GHI789-2.jpg"]],
    });
  });

  it("folder mode: the folder names the product and unnumbered files take name order", () => {
    expect(shape(groupItems(tree, opts("folder")))).toEqual({
      ABC123: [[1, "Shoes/ABC123/ABC123_1.jpg"], [2, "Shoes/ABC123/ABC123_2.jpg"], [3, "abc-123-3.jpg"]],
      DEF456: [[1, "Shoes/DEF456/1.jpg"], [2, "Shoes/DEF456/02.jpg"]],
      GHI789: [[1, "GHI789-1.jpg"], [2, "GHI789-2.jpg"]],
      XYZ: [[1, "Shoes/XYZ/back.jpg"], [2, "Shoes/XYZ/front.jpg"]],
    });
  });

  it("sheet_column mode: files join the sheet row with the same key and take its spelling", () => {
    const g = groupItems(tree, opts("sheet_column"));
    expect(shape(g)["abc-123"]).toEqual([[1, "Shoes/ABC123/ABC123_1.jpg"], [2, "Shoes/ABC123/ABC123_2.jpg"], [3, "abc-123-3.jpg"]]);
    expect(Object.keys(shape(g))).toEqual(["abc-123", "back", "DEF456", "front", "GHI789"]);
  });

  it("adds _rect and _square from Rectangle/, rect/, Square/ and sq/ folders (parent or grandparent)", () => {
    const g = groupItems(
      [file("Rectangle/ABC_1.jpg"), file("rect/ABC_2.jpg"), file("Square/ABC_1.jpg"), file("sq/DEF/1.jpg"), file("GHI/Square/1.jpg"), file("JKL_rect_3.jpg")],
      opts(),
    );
    expect(shape(g)).toEqual({
      ABC_rect: [[1, "Rectangle/ABC_1.jpg"], [2, "rect/ABC_2.jpg"]],
      ABC_square: [[1, "Square/ABC_1.jpg"]],
      DEF_square: [[1, "sq/DEF/1.jpg"]],
      GHI_square: [[1, "GHI/Square/1.jpg"]],
      JKL_rect: [[1, "JKL_rect_3.jpg"]],
    });
  });

  it("resolves a duplicate shot across the two kinds by each precedence", () => {
    const items = [file("P_1.jpg"), file("P_2.jpg"), link("P", 2), link("P", 3), link("LINKONLY", 1), file("FILEONLY_1.jpg")];
    const run = (p: Precedence) => shape(groupItems(items, opts("filename", p)));
    expect(run("uploads_then_links")).toEqual({
      FILEONLY: [[1, "FILEONLY_1.jpg"]],
      LINKONLY: [[1, "LINKONLY-1.jpg"]],
      P: [[1, "P_1.jpg"], [2, "P_2.jpg"], [3, "P-3.jpg"]],
    });
    // Precedence decides only for P, which both kinds have; FILEONLY and LINKONLY are kept in every mode.
    expect(run("links_only")).toEqual({ FILEONLY: [[1, "FILEONLY_1.jpg"]], LINKONLY: [[1, "LINKONLY-1.jpg"]], P: [[1, "P-2.jpg"], [2, "P-3.jpg"]] });
    expect(run("uploads_only")).toEqual({ FILEONLY: [[1, "FILEONLY_1.jpg"]], LINKONLY: [[1, "LINKONLY-1.jpg"]], P: [[1, "P_1.jpg"], [2, "P_2.jpg"]] });
  });

  it("rejects only the product with two files for one shot, with the exact sentence", () => {
    const g = groupItems([file("Q_1.jpg"), file("Q-1.jpg"), file("Q_2.jpg"), file("OK_1.jpg")], opts());
    expect(shape(g)).toEqual({ OK: [[1, "OK_1.jpg"]] });
    expect(g.rejected.map((r) => [r.item.originalName, r.reason])).toEqual([
      ["Q_1.jpg", "Two files claim shot 1 of Q: Q_1.jpg, Q-1.jpg. Rename one and re-upload."],
      ["Q_2.jpg", "Two files claim shot 1 of Q: Q_1.jpg, Q-1.jpg. Rename one and re-upload."],
      ["Q-1.jpg", "Two files claim shot 1 of Q: Q_1.jpg, Q-1.jpg. Rename one and re-upload."],
    ]);
  });

  it("renumbers gaps to positions with the numbering_gap note", () => {
    const g = groupItems([file("R_4.jpg"), file("R_1.jpg"), file("R_2.jpg")], opts());
    const r = g.products.get("R")!;
    expect(r.map((i) => [i.n, i.originalName])).toEqual([[1, "R_1.jpg"], [2, "R_2.jpg"], [3, "R_4.jpg"]]);
    expect(r[0]!.warnings).toEqual(["Shot numbers 3 are missing in the upload; images shifted left in this row."]);
    expect(r.map(shotFlags)).toEqual([["numbering_gap"], ["numbering_gap"], ["numbering_gap"]]);
    expect(shotFlags(groupItems([file("S_1.jpg")], opts()).products.get("S")![0]!)).toEqual([]);
  });

  it("gives the same result for any arrival order", () => {
    const items = [...tree, file("R_4.jpg"), file("R_1.jpg"), file("Q_1.jpg"), file("Q-1.jpg"), file("U.jpg"), file("U_1.jpg"), file("U_2.jpg")];
    const strip = (g: GroupingResult) => ({ products: shape(g), rejected: g.rejected.map((r) => [r.item.identifier, r.item.originalName, r.reason]) });
    const expected = strip(groupItems(items, opts()));
    for (const seed of [1, 7, 42, 99]) expect(strip(groupItems(shuffle(items, seed), opts()))).toEqual(expected);
    expect([...groupItems(shuffle(items, 3), opts()).products.keys()]).toEqual(Object.keys(expected.products));
  });

  it("handles unnumbered files: one is shot 1, several are rejected, one beside numbered ones goes last", () => {
    const g = groupItems([file("S.jpg"), file("T.jpg"), file("T.png"), file("U_1.jpg"), file("U.jpg"), file("U_2.jpg")], opts());
    expect(shape(g)).toEqual({ S: [[1, "S.jpg"]], U: [[1, "U_1.jpg"], [2, "U_2.jpg"], [3, "U.jpg"]] });
    expect(g.products.get("S")![0]!.warnings).toEqual([]);
    expect(g.products.get("U")![2]!.warnings).toEqual(["Shot number missing on U.jpg; placed last."]);
    expect(g.rejected.map((r) => r.reason)).toEqual([
      "Files for T have no shot numbers: T.jpg, T.png. Rename them T_1.jpg, T_2.jpg.",
      "Files for T have no shot numbers: T.jpg, T.png. Rename them T_1.jpg, T_2.jpg.",
    ]);
  });

  it("groups a HEIC file like any photo", () => {
    const g = groupItems([file("IMG_2041_1.heic"), file("IMG_2041_2.jpg")], opts());
    expect(g.products.get("IMG_2041")!.map((i) => [i.n, i.ext])).toEqual([[1, "heic"], [2, "jpg"]]);
    expect(g.rejected).toEqual([]);
  });

  it("rejects unreadable files, zip rejects and files without an identifier under their own sentences", () => {
    const bmp = file("V_1.bmp");
    const inner = file("more/inner.zip");
    inner.warnings.push(nestedZipMessage("inner.zip"));
    const g = groupItems([bmp, inner, file("1.jpg"), file("V_2.jpg")], opts(), new Map([[bmp, unsupportedMessage("V_1.bmp", "BMP")]]));
    expect(shape(g)).toEqual({ V: [[1, "V_2.jpg"]] });
    expect(g.rejected.map((r) => [r.item.identifier, r.reason])).toEqual([
      ["", "Could not tell which product 1.jpg belongs to. Rename it like ABC123_1.jpg, or put it in a folder named after the product."],
      ["inner", "Nested zip files are not opened. Unzip inner.zip and upload its contents."],
      ["V", "V_1.bmp is a BMP file. Save it as JPEG or PNG and add it again."],
    ]);
    // Copies lead back to the collected items.
    expect(originalOf(g.products.get("V")![0]!).originalName).toBe("V_2.jpg");
    expect(originalOf(g.rejected[2]!.item)).toBe(bmp);
  });
});

describe("previewRows", () => {
  const ok1 = file("OKP_1.jpg");
  const bmp = file("BAD_1.bmp");
  const items = [ok1, file("OKP_3.jpg"), file("DUP_1.jpg"), file("DUP-1.jpg"), bmp];
  const g = groupItems(items, opts(), new Map([[bmp, unsupportedMessage("BAD_1.bmp", "BMP")]]));
  const dims: ItemDimensions = new Map([[ok1, { width: 800, height: 1200 }]]);

  it("gives the four statuses with their files in shot order", () => {
    const rows = previewRows(g, new Map([["OKP", ["SKU_1", "SKU_2"]]]), (i) => `https://thumb/${i.originalName}`, 50, { missing: ["MISS1", "okp"], dimensions: dims });
    expect(rows).toEqual([
      {
        identifier: "BAD", opptraSkuIds: [], shots: 0, firstShotUri: null, status: "unreadable",
        files: [{ n: 1, originalName: "BAD_1.bmp", width: null, height: null }],
        notes: ["BAD_1.bmp is a BMP file. Save it as JPEG or PNG and add it again."],
      },
      {
        identifier: "DUP", opptraSkuIds: [], shots: 0, firstShotUri: null, status: "duplicate shot",
        files: [{ n: 1, originalName: "DUP_1.jpg", width: null, height: null }, { n: 1, originalName: "DUP-1.jpg", width: null, height: null }],
        notes: ["Two files claim shot 1 of DUP: DUP_1.jpg, DUP-1.jpg. Rename one and re-upload."],
      },
      { identifier: "MISS1", opptraSkuIds: [], shots: 0, firstShotUri: null, status: "missing images", files: [], notes: [] },
      {
        identifier: "OKP", opptraSkuIds: ["SKU_1", "SKU_2"], shots: 2, firstShotUri: "https://thumb/OKP_1.jpg", status: "ok",
        files: [{ n: 1, originalName: "OKP_1.jpg", width: 800, height: 1200 }, { n: 2, originalName: "OKP_3.jpg", width: null, height: null }],
        notes: ["Shot numbers 2 are missing in the upload; images shifted left in this row."],
      },
    ]);
    expect(previewRows(g, new Map(), () => null, 2, {}).map((r) => r.identifier)).toEqual(["BAD", "DUP"]);
  });
});

describe("warningSentences", () => {
  const big = file("Anta/BIG_1.jpg");
  const small = file("Anta/BIG_2.jpg");
  const bmp = file("Anta/BAD_1.bmp");
  const corrupt = file("Campus/CRP_1.jpg");
  const items = [
    big, small, bmp, corrupt,
    file("Campus/ABC_rect_1.jpg"), file("Campus/NOTLISTED_1.jpg"),
    file("Campus/DUP_1.jpg"), file("Campus/DUP-1.jpg"),
    file("Campus/HEICOK_1.heic"),
  ];
  const unreadable = new Map([[bmp, unsupportedMessage("BAD_1.bmp", "BMP")], [corrupt, "CRP_1.jpg is corrupt (cannot be decoded)."]]);
  const g = groupItems(items, opts(), unreadable);
  const list: ProductListRow[] = ["BIG", "ABC", "HEICOK", "dup", "MISS1", "MISS-2", "miss1", "BAD", "CRP"].map((identifier) => ({ identifier, ean: null, raw: {} }));

  it("lists every pair with its counts in the spec's order", () => {
    g.warnings.push("2 identifiers appear more than once in links.xlsx; the first row of each is used.");
    expect(warningSentences(g, list, ["noon", "styli"], { brandName: "Anta" })).toEqual([
      {
        headline: "2 products have no photos.",
        detail: 'They are in your product list but no files matched: MISS1, MISS-2. They will appear in the sheet as "missing images".',
      },
      { headline: "1 products have photos but are not in your product list: NOTLISTED.", detail: "They will appear in the sheet as not in sheet." },
      {
        headline: "2 files could not be read.",
        detail: "BAD_1.bmp: is a BMP file; CRP_1.jpg: is corrupt and could not be decoded. Fix them and use them in a new batch, or continue without them.",
      },
      { headline: "1 products have two files for the same shot number: DUP.", detail: "They are left out until one file is renamed; see the grouping table." },
      {
        headline: "Your upload has 2 top-level folders (Anta, Campus).",
        detail: "Everything in them will be filed under Anta. If these are different brands, make one batch per brand.",
      },
      { headline: "2 identifiers appear more than once in links.xlsx; the first row of each is used.", detail: "" },
    ]);
    g.warnings.pop();
  });
  it("never warns that a photo is too small for Styli: no enlargement cap (owner decision 2026-10-22)", () => {
    expect(warningSentences(g, list, ["styli"], { brandName: "Anta" }).some((w) => /Styli/.test(w.headline + w.detail))).toBe(false);
  });

  it("leaves out the list pairs without a list; one folder gives no folder warning", () => {
    const heads = warningSentences(g, null, ["noon"]).map((w) => w.headline);
    expect(heads).toEqual([
      "2 files could not be read.",
      "1 products have two files for the same shot number: DUP.",
      "Your upload has 2 top-level folders (Anta, Campus).",
    ]);
    const one = groupItems([file("Anta/A_1.jpg"), file("Anta/B_1.jpg"), file("C_1.jpg")], opts());
    expect(warningSentences(one, null, ["styli"])).toEqual([]);
    expect(warningSentences(one, null, ["noon"], { topLevelFolders: ["X", "Y"] })[0]!.detail).toContain("filed under this brand.");
  });

  it("keeps an identifier whose only files were rejected out of the not-in-list sentence and out of not_in_sheet", () => {
    const pdf = file("notes.pdf");
    const gp = groupItems([file("LISTED_1.jpg"), pdf], opts(), new Map([[pdf, notImageMessage("notes.pdf")]]));
    const rows: ProductListRow[] = [{ identifier: "LISTED", ean: null, raw: {} }];
    expect(warningSentences(gp, rows, ["noon"])).toEqual([
      { headline: "1 files could not be read.", detail: "notes.pdf: is not an image. Fix them and use them in a new batch, or continue without them." },
    ]);
    expect([...linkStatuses(rows, gp)]).toEqual([["LISTED", "ok"]]);
    // A product left out for its shot numbers still has photos, so it is named when not listed.
    const gd = groupItems([file("LISTED_1.jpg"), file("DUP_1.jpg"), file("DUP-1.jpg")], opts());
    expect(warningSentences(gd, rows, ["noon"]).map((w) => w.headline)).toContain("1 products have photos but are not in your product list: DUP.");
  });

  it("never lists HEIC files as unreadable", () => {
    const heic = file("IMG_9_1.heic");
    const gh = groupItems([heic], opts(), new Map([[heic, "IMG_9_1.heic is corrupt (cannot be decoded)."]]));
    expect(warningSentences(gh, null, [])).toEqual([]);
  });
});

describe("the step 4 link pair (spec 14b F5 part 1)", () => {
  const failed = (item: SourceItem, row: number, column: string, got: string) =>
    [item, `Row ${row}, column ${column}: ${(item.bytes as { url: string }).url} did not return an image (got ${got}).`] as const;
  const a1 = link("AAA", 1), a2 = link("AAA", 2), b1 = link("BBB", 1), c1 = link("CCC", 1), c2 = link("CCC", 2);
  const bmp = file("BAD_1.bmp");

  it("all permanent: the fix ending, and links stay out of the files sentence", () => {
    const unreadable = new Map([failed(a2, 2, "Image 2", "404"), failed(b1, 3, "Image 1", "text/html"), [bmp, unsupportedMessage("BAD_1.bmp", "BMP")] as const]);
    const g = groupItems([a1, a2, b1, c1, c2, bmp], opts(), new Map(unreadable));
    expect(warningSentences(g, null, ["noon"])).toEqual([
      { headline: "1 files could not be read.", detail: "BAD_1.bmp: is a BMP file. Fix them and use them in a new batch, or continue without them." },
      { headline: "2 links could not be downloaded.", detail: "2 products are missing shots: AAA, BBB. Fix the links, or continue without them." },
    ]);
  });

  it("some temporary: the retry ending", () => {
    const g = groupItems([a1, a2, b1, c1, c2], opts(), new Map([failed(a2, 2, "Image 2", "404"), failed(c2, 4, "Image 2", "503")]));
    expect(warningSentences(g, null, ["noon"])).toEqual([
      { headline: "2 links could not be downloaded.", detail: "2 products are missing shots: AAA, CCC. Try the failed links again, fix the sheet, or continue without them." },
    ]);
  });

  it("names the first 10 products only and says one product in the singular", () => {
    const many = Array.from({ length: 12 }, (_, i) => link(`P${String(i + 1).padStart(2, "0")}`, 1));
    const g = groupItems(many, opts(), new Map(many.map((item, i) => failed(item, i + 2, "Image 1", "404"))));
    const [pair] = warningSentences(g, null, ["noon"]);
    expect(pair).toEqual({ headline: "12 links could not be downloaded.", detail: "12 products are missing shots: P01, P02, P03, P04, P05, P06, P07, P08, P09, P10. Fix the links, or continue without them." });
    const one = groupItems([a1, a2], opts(), new Map([failed(a2, 2, "Image 2", "404")]));
    expect(warningSentences(one, null, ["noon"])).toEqual([{ headline: "1 link could not be downloaded.", detail: "1 product is missing shots: AAA. Fix the links, or continue without them." }]);
  });
});

describe("the same photos pairs (spec 14d F10)", () => {
  const other = { batchId: "b2", name: "BHPC bags", createdAt: "2026-10-26T10:00:00Z", state: "Ready to check", sharedPhotos: 12, example: { here: "BH-4610-NE-NERO_OD", there: "BH-4610-NE-NERO" } };

  it("names the other batch, its state and age, how many photos are shared and the two spellings", () => {
    const p = samePhotosPair(other, 1400, "1 day ago");
    expect(p.before + p.name + p.after).toBe("These photos are already in BHPC bags (ready to check, created 1 day ago).");
    expect(p.name).toBe("BHPC bags");
    expect(p.detail).toBe("12 of 1,400 photos are the same, under different identifiers (BH-4610-NE-NERO there, BH-4610-NE-NERO_OD here). Continue that batch or cancel it before starting this one, so the same product is not made twice.");
    expect(samePhotosPair({ ...other, example: null }, 12, "just now").detail).toBe("12 of 12 photos are the same. Continue that batch or cancel it before starting this one, so the same product is not made twice.");
  });

  it("names one photo under two products and how many more there are", () => {
    expect(duplicatePhotosPair([])).toBeNull();
    const one = { sha256: "a", identifiers: ["BAG-BLACK", "BAG-TAN"], name: "BAG_1.jpg" };
    expect(duplicatePhotosPair([one])).toEqual({ headline: "1 photo appears under two products.", detail: "BAG_1.jpg is in BAG-BLACK and BAG-TAN. Check the sheet before starting." });
    expect(duplicatePhotosPair([one, { ...one, sha256: "b" }, { ...one, sha256: "c" }])).toEqual({ headline: "3 photos appear under two products.", detail: "BAG_1.jpg is in BAG-BLACK and BAG-TAN; 2 more. Check the sheet before starting." });
  });
});
