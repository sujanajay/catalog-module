import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import { parseShotName } from "../naming";
import type { BatchOptions, IdentifierMode, Precedence } from "../types";
import {
  baseName,
  duplicateShotMessage,
  groupItems,
  leftOutProducts,
  noIdentifierMessage,
  noShotNumbersMessage,
  notChosenMessage,
  photosUnderSeveralProducts,
  olderSameProductMessage,
  originalOf,
  sameProductMessage,
  previewRows,
  shotFlags,
  warningSentences,
  type ItemDimensions,
  type ProductListRow,
} from "./group";
import { notImageMessage, unsupportedMessage } from "./image-check";
import { duplicatePhotosPair, samePhotosPair } from "./same-photos";
import { linkStatuses } from "./product-list";
import { supabaseFolderText } from "./supabase-folder";
import { parseSupabaseFolderLink } from "./supabase-link";
import { parsePastedLinks, urlListItems } from "./url-list";
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

describe("a clash on one shot number is judged by bytes (R1 exit 2 finding 1)", () => {
  // The real shape: softlines/vero-moda holds each shot as both X_1.jpg and X_1.jpeg.
  const shas = (byName: Record<string, string>) => (item: SourceItem) => byName[item.originalName];

  it("keeps one file of X_1.jpg and X_1.jpeg with the same bytes, whatever order they come in, and says so", () => {
    const items = ["10255347_Black/10255347_Black_1.jpg", "10255347_Black/10255347_Black_1.jpeg", "10255347_Black/10255347_Black_2.jpg", "10255347_Black/10255347_Black_2.jpeg"].map((p) => file(p));
    const sha = shas({ [items[0]!.originalName]: "a", [items[1]!.originalName]: "a", [items[2]!.originalName]: "b", [items[3]!.originalName]: "b" });
    const g = groupItems(items, opts(), undefined, sha);
    expect(g.rejected).toEqual([]);
    expect(g.products.get("10255347_Black")!.map((i) => [i.n, baseName(i)])).toEqual([[1, "10255347_Black_1.jpeg"], [2, "10255347_Black_2.jpeg"]]);
    expect(g.products.get("10255347_Black")![0]!.warnings).toEqual(["10255347_Black_1.jpeg and 10255347_Black_1.jpg are the same photo, so one was used."]);
    expect(g.sameFiles).toEqual([
      { identifier: "10255347_Black", n: 1, kept: "10255347_Black/10255347_Black_1.jpeg", dropped: ["10255347_Black/10255347_Black_1.jpg"] },
      { identifier: "10255347_Black", n: 2, kept: "10255347_Black/10255347_Black_2.jpeg", dropped: ["10255347_Black/10255347_Black_2.jpg"] },
    ]);
    for (const seed of [1, 7, 42]) expect(groupItems(shuffle(items, seed), opts(), undefined, sha).products.get("10255347_Black")!.map(baseName)).toEqual(["10255347_Black_1.jpeg", "10255347_Black_2.jpeg"]);
  });

  it("still leaves the product out when the same names hold different bytes", () => {
    const a = file("10288257_Chocolate-Torte_1.jpg"), b = file("10288257_Chocolate-Torte_1.jpeg"), other = file("10288257_Chocolate-Torte_2.jpg");
    const g = groupItems([a, b, other], opts(), undefined, shas({ [a.originalName]: "a", [b.originalName]: "b", [other.originalName]: "c" }));
    expect(g.products.size).toBe(0);
    expect(g.sameFiles).toBeUndefined();
    expect(g.rejected.map((r) => r.reason)).toEqual(Array(3).fill("Two files claim shot 1 of 10288257_Chocolate-Torte: 10288257_Chocolate-Torte_1.jpeg, 10288257_Chocolate-Torte_1.jpg. Rename one and re-upload."));
  });

  it("drops the copies but still refuses a third file with different bytes, and never merges when the bytes are not known", () => {
    const a = file("M_1.jpg"), b = file("M_1.jpeg"), c = file("M-1.png");
    const g = groupItems([a, b, c], opts(), undefined, shas({ [a.originalName]: "a", [b.originalName]: "a", [c.originalName]: "z" }));
    expect(g.products.size).toBe(0);
    expect(g.rejected[0]!.reason).toBe("Two files claim shot 1 of M: M_1.jpeg, M-1.png. Rename one and re-upload.");
    expect(groupItems([a, b], opts(), undefined, () => null).products.size).toBe(0);
    expect(groupItems([a, b], opts()).products.size).toBe(0);
  });

  it("treats files with no shot number, one stem and the same bytes as one file", () => {
    const a = file("T.jpg"), b = file("T.jpeg");
    const g = groupItems([a, b], opts(), undefined, () => "same");
    expect(g.rejected).toEqual([]);
    expect(g.products.get("T")!.map((i) => [i.n, baseName(i)])).toEqual([[1, "T.jpeg"]]);
    expect(groupItems([a, b], opts(), undefined, (i) => i.originalName).products.size).toBe(0);
  });
});

describe("leftOutProducts: every product grouping left out, for any reason", () => {
  const row = (identifier: string, name: string, reason: string) => ({ identifier, name, reason });
  const NOT_IMAGE = "notes.pdf is not an image.";

  it("names each reason, and leaves out what is not a left-out product", () => {
    const rejected = [
      row("DUP", "DUP_1.jpg", duplicateShotMessage(1, "DUP", ["DUP_1.jpeg", "DUP_1.jpg"])), row("DUP", "DUP_1.jpeg", duplicateShotMessage(1, "DUP", ["DUP_1.jpeg", "DUP_1.jpg"])),
      row("NONUM", "NONUM.jpg", noShotNumbersMessage("NONUM", ["NONUM.jpg", "NONUM.png"])),
      row("TWO", "TWO_1.jpg", sameProductMessage(["TWO", "TWO-A"])),
      row("BADNAME", "BADNAME_1.jpg", '"BADNAME" cannot be used in an image link. Rename it.'),
      row("BMP", "BMP_1.bmp", unsupportedMessage("BMP_1.bmp", "BMP")),
      row("OLD", "OLD_1.jpg", olderSameProductMessage("OLD", "NEW")),
      row("notes", "notes.pdf", NOT_IMAGE),
      row("", "1.jpg", noIdentifierMessage("1.jpg")),
      row("KEPT", "KEPT_2.bmp", unsupportedMessage("KEPT_2.bmp", "BMP")),
    ];
    const left = leftOutProducts(rejected, ["kept", "NEW"]);
    expect(left.map((l) => [l.identifier, l.why, l.photos])).toEqual([["BADNAME", "refused", 1], ["BMP", "unreadable", 1], ["DUP", "same_shot", 2], ["NONUM", "no_shot_numbers", 1], ["TWO", "same_product", 1]]);
    expect(left.find((l) => l.identifier === "DUP")).toMatchObject({ files: ["DUP_1.jpg", "DUP_1.jpeg"], reason: duplicateShotMessage(1, "DUP", ["DUP_1.jpeg", "DUP_1.jpg"]) });
  });

  it("says links when every photo of the product was a link that could not be downloaded", () => {
    const a1 = link("LNK", 1);
    const g = groupItems([a1], opts(), new Map([[a1, `Row 2, column Image 1: ${(a1.bytes as { url: string }).url} did not return an image (got 404).`]]));
    expect(leftOutProducts(g.rejected.map((r) => ({ identifier: r.item.identifier, name: r.item.originalName, reason: r.reason })), g.products.keys())).toMatchObject([{ identifier: "LNK", why: "links", photos: 1 }]);
  });

  it("gives the preview a sentence for products with no shot numbers, as it has for duplicate ones", () => {
    const g = groupItems([file("T.jpg"), file("T.png")], opts());
    expect(warningSentences(g, null, ["noon"])).toEqual([{ headline: "1 product has files with no shot numbers: T.", detail: "They are left out until the files are renamed; see the grouping table." }]);
  });
});

describe("identical files merge in every grouping mode (PR 187 review P1-3)", () => {
  const link = parseSupabaseFolderLink("https://projref.supabase.co/storage/v1/object/public/softlines/brand")!;
  /** Through the real paste path: the folder's listing, its text, the paste parser, its items, the grouping. */
  const pasted = (names: string[], shaOf: (name: string) => string) => {
    const { text, mode } = supabaseFolderText(link, names.map((path) => ({ path, size: 90_000 })));
    const items = urlListItems(parsePastedLinks(text), "u1");
    return { mode, g: groupItems(items, opts(), undefined, (i) => shaOf(decodeURIComponent(i.originalName.split("/").pop()!))) };
  };
  const shot = (name: string) => name.replace(/\.jpe?g$/, "");

  it("merges doubled shots when one stray file name flips the folder to folder mode, and leaves no false gap", () => {
    const { mode, g } = pasted(["10255347_Black/10255347_Black_1.jpg", "10255347_Black/10255347_Black_1.jpeg", "10255347_Black/10255347_Black_2.jpg", "10255347_Black/10255347_Black_2.jpeg", "10255347_Black/size chart.jpg"], shot);
    expect(mode).toBe("folder");
    const items = g.products.get("10255347_Black")!;
    expect(items.map((i) => i.n)).toEqual([1, 2, 3]);
    expect(items.every((i) => !shotFlags(i).includes("numbering_gap"))).toBe(true);
    expect(g.sameFiles).toHaveLength(2);
    expect(g.rejected).toEqual([]);
  });

  it("different bytes at one named shot leave the product out in folder mode too, the same as filename mode (P2-A)", () => {
    const different = pasted(["P/P_1.jpg", "P/P_1.jpeg", "P/size chart.jpg"], (n) => n);
    expect(different.mode).toBe("folder");
    expect(different.g.products.size).toBe(0);
    expect(different.g.rejected[0]!.reason).toBe(duplicateShotMessage(1, "P", ["P_1.jpeg", "P_1.jpg"]));
  });

  it("the clash sentence names the shot the sender numbered, not the closed-up one (P3-1)", () => {
    const items = ["X_1.jpg", "X_2.jpg", "X_3.jpg", "X_3.jpeg"].map((n) => sourceItemFromPath(n, { kind: "gcs", gsUri: "" }, "u", "image"));
    const g = groupItems(items, opts(), undefined, (i) => (i.originalName.startsWith("X_3") ? i.originalName : "same"));
    expect(g.rejected[0]!.reason).toContain("shot 3 of X");
  });

  it("records no merge for a product left out, and lists all of its files, copies too (P3-1)", () => {
    const items = ["X_1.jpg", "X_1.jpeg", "X_1.png"].map((n) => sourceItemFromPath(n, { kind: "gcs", gsUri: "" }, "u", "image"));
    const g = groupItems(items, opts(), undefined, (i) => (i.originalName === "X_1.png" ? "other" : "same"));
    expect(g.products.size).toBe(0);
    expect(g.sameFiles).toBeUndefined();
    expect(g.rejected.map((r) => r.item.originalName).sort()).toEqual(["X_1.jpeg", "X_1.jpg", "X_1.png"]);
  });
});

describe("leftOutProducts (PR 187 review P1-2, P2-2)", () => {
  const notImage = (name: string) => ({ name, reason: notImageMessage(name) });
  it("a photo whose bytes are not an image leaves its product out; a stray document does not make a product", () => {
    const left = leftOutProducts([{ identifier: "X", ...notImage("X_1.jpg") }, { identifier: "notes", ...notImage("notes.pdf") }, { identifier: "Y", ...notImage("Y/spec.pdf") }], []);
    expect(left.map((l) => l.identifier)).toEqual(["X", "Y"]);
    expect(left[0]).toMatchObject({ why: "unreadable", photos: 1 });
  });
  it("two spellings of one product are one left out, as the digest counts them", () => {
    const reason = "Two files claim shot 1 of ABC-1: a, b. Rename one and re-upload.";
    const left = leftOutProducts([{ identifier: "ABC-1", name: "ABC-1_1.jpg", reason }, { identifier: "abc1", name: "abc1_1.jpg", reason }], []);
    expect(left).toHaveLength(1);
    expect(left[0]!.files).toEqual(["ABC-1_1.jpg", "abc1_1.jpg"]);
  });
});

describe("copies across folders and names (owner, 2026-11-06)", () => {
  const link = parseSupabaseFolderLink("https://projref.supabase.co/storage/v1/object/public/softlines/all")!;
  const paste = (uploadId: string, paths: string[]) => urlListItems(parsePastedLinks(supabaseFolderText(link, paths.map((path) => ({ path, size: 90_000 }))).text), uploadId);
  const fileItems = (names: string[]) => names.map((n) => sourceItemFromPath(n, { kind: "gcs", gsUri: `gs://b/${n}` }, "u", "image"));
  const shaByFile = (shas: Record<string, string>) => (i: { originalName: string; bytes: { kind: string } }) => shas[decodeURIComponent(i.originalName.split("/").pop()!)];

  it("(a) one product in two folders of one paste: same bytes are one photo, new photos are added", () => {
    const items = paste("u1", ["vm-ol/X/X_1.jpg", "vm-ol/X/X_2.jpg", "vero-moda/X/X_1.jpg", "vero-moda/X/X_3.jpg"]);
    const g = groupItems(items, opts(), undefined, (i) => (i.originalName.endsWith("_3.jpg") ? "c" : i.originalName.endsWith("_2.jpg") ? "b" : "a"));
    expect(g.products.get("X")!.map((i) => i.n)).toEqual([1, 2, 3]);
    expect(g.sameFiles).toHaveLength(1);
    expect(g.rejected).toEqual([]);
  });

  it("(a) one product across two pastes: identical pastes make one set, and row numbers never clash", () => {
    const row = (u: string, ...urls: string[]) => urlListItems(parsePastedLinks(urls.map((url) => `X\thttps://h/${u}/${url}`).join("\n")), u);
    const same = groupItems([...row("u1", "a.jpg", "b.jpg"), ...row("u2", "a.jpg", "b.jpg")], opts(), undefined, (i) => i.originalName);
    expect(same.products.get("X")!.map((i) => [i.n, i.originalName])).toEqual([[1, "a.jpg"], [2, "b.jpg"]]);
    const other = groupItems([...row("u1", "a.jpg", "b.jpg"), ...row("u2", "c.jpg", "d.jpg")], opts(), undefined, (i) => i.originalName);
    expect(other.rejected).toEqual([]);
    expect(other.products.get("X")!.map((i) => [i.n, i.originalName])).toEqual([[1, "a.jpg"], [2, "b.jpg"], [3, "c.jpg"], [4, "d.jpg"]]);
  });

  it("(a) one product in two folders with different bytes at one named shot is a choice we do not guess: left out, on the record", () => {
    const g = groupItems(fileItems(["vm-ol/X/X_1.jpg", "vero-moda/X/X_1.jpeg"]), opts(), undefined, (i) => i.originalName);
    expect(g.products.size).toBe(0);
    expect(leftOutProducts(g.rejected.map((r) => ({ identifier: r.item.identifier, name: r.item.originalName, reason: r.reason })), [])).toMatchObject([{ identifier: "X", why: "same_shot" }]);
  });

  it("(b) the same bytes under different shot numbers or names take one slot, and later shots close up", () => {
    const g = groupItems(fileItems(["X_1.jpg", "X_2.jpg", "X_3.jpg", "X_4.jpg"]), opts(), undefined, shaByFile({ "X_1.jpg": "a", "X_2.jpg": "b", "X_3.jpg": "a", "X_4.jpg": "c" }) as never);
    expect(g.products.get("X")!.map((i) => [i.n, i.originalName])).toEqual([[1, "X_1.jpg"], [2, "X_2.jpg"], [3, "X_4.jpg"]]);
    expect(g.products.get("X")!.every((i) => !shotFlags(i).includes("numbering_gap"))).toBe(true);
    expect(g.sameFiles).toEqual([{ identifier: "X", n: 1, kept: "X_1.jpg", dropped: ["X_3.jpg"] }]);
  });

  it("(b) keeps the lowest shot number whichever name sorts first", () => {
    const g = groupItems(fileItems(["X_10.jpg", "X_2.jpg"]), opts(), undefined, () => "a");
    expect(g.products.get("X")!.map((i) => i.originalName)).toEqual(["X_2.jpg"]);
  });

  it("(c) the same bytes under two product names are both kept and named, one row per pair, and a shared chart is one row", () => {
    const g = groupItems(fileItems(["A_1.jpg", "A_2.jpg", "B_1.jpg", "B_2.jpg", "C_1.jpg"]), opts(), undefined, shaByFile({ "A_1.jpg": "x", "A_2.jpg": "y", "B_1.jpg": "x", "B_2.jpg": "y", "C_1.jpg": "z" }) as never);
    expect([...g.products.keys()]).toEqual(["A", "B", "C"]);
    const row = (identifier: string, ...sha: string[]) => ({ identifier, items: sha.map((sha256) => ({ sha256 })) });
    expect(photosUnderSeveralProducts([row("A", "x", "y"), row("B", "x", "y"), row("C", "z")])).toEqual([{ identifiers: ["A", "B"], products: 2, photos: 2 }]);
    expect(photosUnderSeveralProducts(Array.from({ length: 400 }, (_, i) => row(`P${String(i).padStart(3, "0")}`, "chart", `own${i}`)))).toEqual([expect.objectContaining({ products: 400, photos: 1 })]);
  });

  it("two pastes keep one shot order whatever their upload ids, so a re-send stays unchanged (P2-B)", () => {
    const row = (u: string, dir: string, ...names: string[]) => urlListItems(parsePastedLinks(names.map((n) => `X\thttps://h/${dir}/${n}`).join("\n")), u);
    const order = (one: string, two: string) => groupItems([...row(one, "vm-ol", "a.jpg", "b.jpg"), ...row(two, "vero-moda", "a.jpg", "b.jpg")], opts(), undefined, (i) => (i.bytes.kind === "url" ? i.bytes.url : "")).products.get("X")!.map((i) => (i.bytes.kind === "url" ? i.bytes.url : ""));
    expect(order("u1", "u2")).toEqual(order("zz", "aa"));
    expect(order("u1", "u2")).toHaveLength(4);
  });

  describe("a product with both uploads and links never loses a distinct photo silently (P1-A)", () => {
    const row = (...names: string[]) => urlListItems(parsePastedLinks(names.map((n) => `X\thttps://h/p/${n}`).join("\n")), "paste");
    const sha = (i: { originalName: string }) => i.originalName;

    it("pasted rows with no named shot follow the uploads", () => {
      const g = groupItems([...fileItems(["X_1.jpg", "X_2.jpg"]), ...row("front.jpg", "back.jpg", "side.jpg")], opts(), undefined, sha as never);
      expect(g.products.get("X")!.map((i) => [i.n, i.originalName])).toEqual([[1, "X_1.jpg"], [2, "X_2.jpg"], [3, "front.jpg"], [4, "back.jpg"], [5, "side.jpg"]]);
      expect(g.rejected).toEqual([]);
    });

    it("a pasted row naming an uploaded shot with other bytes is a file row; with the same bytes it is only a copy", () => {
      const g = groupItems([...fileItems(["X_1.jpg"]), ...row("X_1.jpeg", "X_2.jpeg")], opts(), undefined, sha as never);
      expect(g.products.get("X")!.map((i) => i.originalName)).toEqual(["X_1.jpg", "X_2.jpeg"]);
      expect(g.rejected.map((r) => [r.item.originalName, r.reason])).toEqual([["X_1.jpeg", notChosenMessage("X_1.jpeg", "uploads_then_links", 1)]]);
      const copy = groupItems([...fileItems(["X_1.jpg"]), ...row("X_1.jpeg")], opts(), undefined, () => "same");
      expect(copy.rejected).toEqual([]);
    });

    it("uploads_only and links_only name each photo they did not choose, and the product carries on", () => {
      const both = () => [...fileItems(["X_1.jpg"]), ...row("back.jpg")];
      const uploads = groupItems(both(), opts("filename", "uploads_only"), undefined, sha as never);
      expect(uploads.rejected.map((r) => [r.item.originalName, r.reason])).toEqual([["back.jpg", notChosenMessage("back.jpg", "uploads_only", null)]]);
      const links = groupItems(both(), opts("filename", "links_only"), undefined, sha as never);
      expect(links.rejected.map((r) => r.item.originalName)).toEqual(["X_1.jpg"]);
      expect(leftOutProducts(uploads.rejected.map((r) => ({ identifier: r.item.identifier, name: r.item.originalName, reason: r.reason })), uploads.products.keys())).toEqual([]);
    });
  });

  it("stays fast at real size: 30,000 files, all copied once", () => {
    const names = Array.from({ length: 15_000 }, (_, i) => `P${i % 3000}_${i % 5 + 1}`);
    const items = fileItems(names.flatMap((n) => [`${n}.jpg`, `${n}.jpeg`]));
    const started = Date.now();
    const g = groupItems(items, opts(), undefined, (i) => baseName(i).replace(/\..*$/, ""));
    expect(g.products.size).toBe(3000);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
