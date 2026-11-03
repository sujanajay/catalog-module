// M1-F1-R2 per-root grouping and M1-F1 acceptance test 1 in its grouping form: three brand folders of
// different shapes plus a links sheet in one drop are grouped as a person would group them, with no
// question and no mode chosen by the operator.
import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_OPTIONS } from "../../db/schema";
import type { BatchOptions } from "../types";
import { groupItems } from "./group";
import { sourceItemFromPath } from "./local-files";
import { detectRoots, FOLDER_PHOTOS_MAX, groupingSentence, rootOf } from "./roots";
import { folderIdentifier } from "./group";
import type { GroupingResult, SourceItem } from "./types";

const perRoot: BatchOptions = { ...DEFAULT_BATCH_OPTIONS, perRoot: true };

/** A file dropped inside a folder (relative path kept), one upload per file as the browser sends them. */
const file = (path: string, origin: SourceItem["origin"] = "image", uploadId = `u-${path}`): SourceItem =>
  sourceItemFromPath(path, { kind: "gcs", gsUri: `gs://bkt/p/uploads/${uploadId}/${path}` }, uploadId, origin);

/** A links-sheet row link, as the sheet adapter makes it. */
const sheetLink = (id: string, n: number, uploadId = "sheet1"): SourceItem => ({
  identifier: id, n, suffix: "", originalName: `${id}-${n}.jpg`, folder: null, sheetIdentifier: id,
  ext: "jpg", bytes: { kind: "url", url: `https://img.example.com/${id}-${n}.jpg` }, uploadId, origin: "sheet", warnings: [],
});

const shape = (g: GroupingResult) => Object.fromEntries([...g.products].map(([id, items]) => [id, items.map((i) => i.originalName)]));

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

// The drop of acceptance test 1: one folder per product (view names, no product code in the file
// names), one flat folder named ABC123_1.jpg style, one folder with sub-folders by category whose
// files carry the product code, and an xlsx of image links.
const PER_PRODUCT = ["USPA_AW26/ZSKU100/front.jpg", "USPA_AW26/ZSKU100/back.jpg", "USPA_AW26/ZSKU101/front.jpg", "USPA_AW26/ZSKU101/back.jpg", "USPA_AW26/ZSKU101/side.jpg"];
const FLAT = ["Flat/DEF200_1.jpg", "Flat/DEF200_2.jpg", "Flat/DEF201_1.jpg"];
const NESTED = ["Nested/Men/GHI300_1.jpg", "Nested/Men/GHI300_2.jpg", "Nested/Men/GHI301_1.jpg", "Nested/Women/GHI300_3.jpg", "Nested/Women/GHI302_1.jpg"];
const DROP = (): SourceItem[] => [...PER_PRODUCT, ...FLAT, ...NESTED].map((p) => file(p)).concat([sheetLink("JKL400", 1), sheetLink("JKL400", 2), sheetLink("JKL401", 1)]);

describe("per-root grouping (M1-F1-R2)", () => {
  it("acceptance test 1: three folder shapes and a links sheet in one drop group as a person would", () => {
    const g = groupItems(DROP(), perRoot);
    expect(g.rejected).toEqual([]);
    expect(shape(g)).toEqual({
      // Folder per product: the folder names the product even though every file is "front" or "back".
      ZSKU100: ["USPA_AW26/ZSKU100/back.jpg", "USPA_AW26/ZSKU100/front.jpg"],
      ZSKU101: ["USPA_AW26/ZSKU101/back.jpg", "USPA_AW26/ZSKU101/front.jpg", "USPA_AW26/ZSKU101/side.jpg"],
      // Flat folder: the file names.
      DEF200: ["Flat/DEF200_1.jpg", "Flat/DEF200_2.jpg"],
      DEF201: ["Flat/DEF201_1.jpg"],
      // Category sub-folders: GHI300 has photos in two folders, so the files name the products.
      GHI300: ["Nested/Men/GHI300_1.jpg", "Nested/Men/GHI300_2.jpg", "Nested/Women/GHI300_3.jpg"],
      GHI301: ["Nested/Men/GHI301_1.jpg"],
      GHI302: ["Nested/Women/GHI302_1.jpg"],
      // The sheet: its identifier column.
      JKL400: ["JKL400-1.jpg", "JKL400-2.jpg"],
      JKL401: ["JKL401-1.jpg"],
    });
    expect(g.roots?.map((r) => [r.key, r.mode])).toEqual([
      ["folder:Flat", "filename"], ["folder:Nested", "filename"], ["folder:USPA_AW26", "folder"], ["upload:sheet1", "sheet_column"],
    ]);
  });

  it("the same drop under one batch-wide mode (the old behaviour) mis-groups the folder-per-product root", () => {
    const g = groupItems(DROP(), DEFAULT_BATCH_OPTIONS);
    expect(g.products.has("ZSKU100")).toBe(false);
    expect(g.roots).toBeUndefined();
  });

  it("does not depend on the order the files arrive in", () => {
    const base = JSON.stringify(shape(groupItems(DROP(), perRoot)));
    for (const seed of [1, 7, 42]) expect(JSON.stringify(shape(groupItems(shuffle(DROP(), seed), perRoot)))).toBe(base);
  });

  it("folders by view (the same product code in two folders) are grouped by file name", () => {
    const g = groupItems(["Shoot/Front/MNO1_1.jpg", "Shoot/Back/MNO1_2.jpg", "Shoot/Front/MNO2_1.jpg"].map((p) => file(p)), perRoot);
    expect(shape(g)).toEqual({ MNO1: ["Shoot/Front/MNO1_1.jpg", "Shoot/Back/MNO1_2.jpg"], MNO2: ["Shoot/Front/MNO2_1.jpg"] });
  });

  it(`a product folder with more than ${FOLDER_PHOTOS_MAX} photos is not one product`, () => {
    const many = Array.from({ length: FOLDER_PHOTOS_MAX + 1 }, (_, i) => file(`Big/All/PQR${i}_1.jpg`));
    const { roots } = detectRoots(many, folderIdentifier);
    expect(roots[0]!.mode).toBe("filename");
  });

  it("photos directly in the dropped folder, a single loose file and numbered shots", () => {
    const g = groupItems([file("Loose/STU1_1.jpg"), file("STU2_1.jpg"), file("Num/VWX1/1.jpg"), file("Num/VWX1/2.jpg"), file("Num/VWX2/1.jpg")], perRoot);
    expect(shape(g)).toEqual({ STU1: ["Loose/STU1_1.jpg"], STU2: ["STU2_1.jpg"], VWX1: ["Num/VWX1/1.jpg", "Num/VWX1/2.jpg"], VWX2: ["Num/VWX2/1.jpg"] });
    expect(g.roots?.map((r) => [r.key, r.mode])).toEqual([["files", "filename"], ["folder:Loose", "filename"], ["folder:Num", "folder"]]);
  });

  it("a zip with a wrapper folder and product folders is grouped by folder name; shape folders keep their suffix", () => {
    const zip = (p: string) => file(p, "zip", "zip1");
    const g = groupItems([zip("Images/ABC1/a.jpg"), zip("Images/ABC1/b.jpg"), zip("Images/ABC2/a.jpg"), zip("Images/ABC2/Square/a.jpg")], perRoot);
    expect([...g.products.keys()]).toEqual(["ABC1", "ABC2", "ABC2_square"]);
    expect(rootOf(zip("Images/ABC1/a.jpg"))).toMatchObject({ key: "upload:zip1", kind: "zip" });
  });

  it("a product in two roots under one name is one product (uploads first, then links)", () => {
    const g = groupItems([file("Flat/YZA1_1.jpg"), sheetLink("YZA1", 1), sheetLink("YZA1", 2)], perRoot);
    expect(shape(g)).toEqual({ YZA1: ["Flat/YZA1_1.jpg", "YZA1-2.jpg"] });
  });
});

describe("groupingSentence (M1 section 5)", () => {
  it("names each root and its mode in one sentence", () => {
    expect(groupingSentence([
      { kind: "folder", name: "USPA_AW26", mode: "folder" },
      { kind: "sheet", name: "links.xlsx", mode: "sheet_column", column: "column E (Option Id)" },
      { kind: "zip", name: "Images.zip", mode: "filename" },
      { kind: "files", name: "", mode: "filename" },
      { kind: "links", name: "Supabase folder softlines/anta", mode: "folder" },
    ])).toBe("Folder USPA_AW26 grouped by folder name, sheet links.xlsx by column E (Option Id), zip Images.zip by file name, the loose files by file name, Supabase folder softlines/anta by folder name.");
    expect(groupingSentence([])).toBeNull();
  });
});
