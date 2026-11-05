// The first worksheet of an xlsx, as an xlsx of its own. ExcelJS's workbook.xlsx.load parses every worksheet into cell
// objects, so a reader that needs only the Links sheet of a links workbook would also build the Exceptions and
// "Delivered with a note" sheets (225k rows at the M1-F4 target; review P1 and P2-1). This drops the other worksheets
// from the zip before the load, so the reader's memory and time follow the first sheet only, and every reader keeps
// ExcelJS's full model (merged cells, hyperlinks) for that sheet.
import JSZip from "jszip";

const SHEET_TAG = /<(?:\w+:)?sheet\b[^>]*?\/>/g;
const RELATIONSHIP_TAG = /<(?:\w+:)?Relationship\b[^>]*?\/>/g;

const attr = (tag: string, name: string): string | null => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** A relationship target as a zip path: "worksheets/sheet2.xml" or "/xl/worksheets/sheet2.xml" -> "xl/worksheets/sheet2.xml". */
const partPath = (target: string): string => (target.startsWith("/") ? target.slice(1) : `xl/${target}`);

/**
 * `xlsx` with every worksheet after the first removed: their parts, their relationships, their <sheet> entries in
 * workbook.xml and the workbook's defined names (print areas and the like, which may name a removed sheet). The parts
 * that are kept are copied as they were (still compressed). A workbook with one sheet, or one this cannot take apart,
 * is returned unchanged, so the caller then simply loads all of it.
 */
export async function firstSheetOnly(xlsx: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(xlsx); } catch { return xlsx; }
  const book = zip.file("xl/workbook.xml"), rels = zip.file("xl/_rels/workbook.xml.rels");
  if (!book || !rels) return xlsx;
  const bookXml = await book.async("string"), relsXml = await rels.async("string");
  const sheets = bookXml.match(SHEET_TAG) ?? [];
  if (sheets.length <= 1) return xlsx;
  const targets = new Map<string, string>();
  for (const tag of relsXml.match(RELATIONSHIP_TAG) ?? []) {
    const id = attr(tag, "Id"), target = attr(tag, "Target");
    if (id && target) targets.set(id, target);
  }
  const dropped = sheets.slice(1).map(tag => {
    const id = attr(tag, "(?:\\w+:)?id");
    return { tag, id, target: id ? targets.get(id) : undefined };
  });
  if (dropped.some(d => !d.id || !d.target)) return xlsx;
  let nextBook = bookXml.replace(/<(?:\w+:)?definedNames\b[\s\S]*?<\/(?:\w+:)?definedNames>/, "").replace(/\sactiveTab="\d+"/, "").replace(/\sfirstSheet="\d+"/, "");
  let nextRels = relsXml;
  for (const { tag, id, target } of dropped) {
    nextBook = nextBook.replace(tag, "");
    nextRels = nextRels.replace(RELATIONSHIP_TAG, rel => (attr(rel, "Id") === id ? "" : rel));
    const part = partPath(target!);
    zip.remove(part);
    const slash = part.lastIndexOf("/");
    zip.remove(`${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`);
  }
  zip.file("xl/workbook.xml", nextBook);
  zip.file("xl/_rels/workbook.xml.rels", nextRels);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
