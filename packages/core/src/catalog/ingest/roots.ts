// Per-root grouping (M1-F1-R2): the grouping mode is decided for each input root (each dropped
// folder, zip, Drive folder, sheet or paste), not once per batch, so one drop can mix a
// folder-per-product root, a flat `ABC123_1.jpg` root and a links sheet without a question.
import { normalizeKey } from "../naming";
import type { IdentifierMode } from "../types";
import type { SourceItem } from "./types";

/** What a root is, for its sentence. `files` is every loose file dropped without a folder. */
export type RootKind = "folder" | "files" | "zip" | "drive_folder" | "sheet" | "links";

/** One input root and the mode chosen for it. `uploadId` names the upload for zips, Drive folders, sheets and pastes. */
export interface InputRoot { key: string; kind: RootKind; uploadId: string | null; folder: string | null; mode: IdentifierMode }

/** The stored form of a root (catalog_batches.counts.roots): its kind, display name, mode and, for a sheet, its column words. */
export interface StoredRoot { kind: RootKind; name: string; mode: IdentifierMode; column?: string | null }

/** A product folder with this many photos (inclusive) counts toward folder mode (M1-F1-R2, admin setting later). */
export const FOLDER_PHOTOS_MIN = 1;
export const FOLDER_PHOTOS_MAX = 30;

const isShapeFolder = (name: string) => /^(rect|sq)/i.test(name);

/** The root an item belongs to, and its directories below that root. */
export function rootOf(item: SourceItem): { key: string; kind: RootKind; uploadId: string | null; folder: string | null; dirs: string[] } {
  if (item.bytes.kind === "url") {
    const kind: RootKind = item.origin === "url_list" ? "links" : "sheet";
    return { key: `upload:${item.uploadId}`, kind, uploadId: item.uploadId, folder: null, dirs: [] };
  }
  const segs = item.originalName.split(/[\\/]/).filter(Boolean);
  if (item.origin === "zip" || item.origin === "drive_folder") {
    return { key: `upload:${item.uploadId}`, kind: item.origin, uploadId: item.uploadId, folder: null, dirs: segs.slice(0, -1) };
  }
  if (segs.length > 1) return { key: `folder:${segs[0]}`, kind: "folder", uploadId: null, folder: segs[0]!, dirs: segs.slice(1, -1) };
  return { key: "files", kind: "files", uploadId: null, folder: null, dirs: [] };
}

/** Drops wrapper folders every item of a root shares (`Images/ABC/1.jpg`, `Images/DEF/1.jpg` in a zip). */
function stripWrappers(dirs: string[][]): string[][] {
  let out = dirs;
  while (out.length && out.every((d) => d.length >= 2 && d[0] === out[0]![0])) out = out.map((d) => d.slice(1));
  return out;
}

/** True when every directory list is empty or holds only shape folders (`Square`, `Rectangle`). */
export const onlyShapeFolders = (dirs: string[][]) => dirs.every((d) => d.every(isShapeFolder));

/** A product-code stem (a file-name stem with a digit, such as `ABC123`); `front` or `IMG` is not one. */
const codeOf = (item: SourceItem) => {
  const stem = normalizeKey(item.identifier);
  return /\d/.test(stem) ? stem : "";
};

/**
 * The mode of one root of files (M1-F1-R2). `folder` when all of these hold, else `filename`:
 * - every photo sits in a product folder below the root (shape folders such as `Square` do not count);
 * - each product folder holds FOLDER_PHOTOS_MIN to FOLDER_PHOTOS_MAX photos;
 * - not every photo is already named `<code>_<n>` (then the file names say it all);
 * - no product folder holds two numbered product codes (a category folder such as `Men`);
 * - no product code appears in two product folders (folders by view such as `Front`, `Back`).
 * `productOf` gives an item's product folder (the folder-mode identifier).
 */
export function fileRootMode(items: SourceItem[], dirs: string[][], productOf: (item: SourceItem) => string): IdentifierMode {
  if (!items.length) return "filename";
  const below = stripWrappers(dirs);
  if (below.some((d) => !d.some((seg) => !isShapeFolder(seg)))) return "filename";
  if (items.every((item) => codeOf(item) && item.n !== null)) return "filename";
  const photos = new Map<string, number>();
  const stems = new Map<string, Set<string>>();
  const numberedCodes = new Map<string, Set<string>>();
  for (const item of items) {
    const product = productOf(item);
    if (!product) return "filename";
    photos.set(product, (photos.get(product) ?? 0) + 1);
    const code = codeOf(item);
    if (!code) continue;
    stems.set(code, (stems.get(code) ?? new Set()).add(product));
    if (item.n !== null) numberedCodes.set(product, (numberedCodes.get(product) ?? new Set()).add(code));
  }
  if ([...photos.values()].some((n) => n < FOLDER_PHOTOS_MIN || n > FOLDER_PHOTOS_MAX)) return "filename";
  if ([...numberedCodes.values()].some((codes) => codes.size > 1)) return "filename";
  if ([...stems.values()].some((s) => s.size > 1)) return "filename";
  return "folder";
}

/**
 * Every root of `items` with its mode, in first-seen order of a name sort (deterministic), and the
 * mode per item. A sheet root is `sheet_column` when its rows carry an identifier column; a paste
 * of links is `filename` (its rows name their products themselves).
 */
export function detectRoots(items: SourceItem[], productOf: (item: SourceItem) => string): { roots: InputRoot[]; modeOf: (item: SourceItem) => IdentifierMode } {
  const byKey = new Map<string, { root: ReturnType<typeof rootOf>; items: SourceItem[]; dirs: string[][] }>();
  for (const item of items) {
    const root = rootOf(item);
    const entry = byKey.get(root.key) ?? { root, items: [], dirs: [] };
    entry.items.push(item);
    entry.dirs.push(root.dirs);
    byKey.set(root.key, entry);
  }
  const modes = new Map<string, IdentifierMode>();
  const roots: InputRoot[] = [];
  for (const key of [...byKey.keys()].sort()) {
    const { root, items: rootItems, dirs } = byKey.get(key)!;
    let mode: IdentifierMode;
    if (root.kind === "sheet") mode = rootItems.some((i) => i.sheetIdentifier) ? "sheet_column" : "filename";
    else if (root.kind === "links") mode = "filename";
    // A folder dropped with its photos directly inside (shape folders aside) may itself be the product
    // (`ZSKU100/front.jpg`): it is judged as the product folder of its own root.
    else if (root.kind === "folder" && onlyShapeFolders(dirs)) mode = fileRootMode(rootItems, dirs.map((d) => [root.folder!, ...d]), productOf);
    else mode = fileRootMode(rootItems, dirs, productOf);
    modes.set(key, mode);
    roots.push({ key, kind: root.kind, uploadId: root.uploadId, folder: root.folder, mode });
  }
  return { roots, modeOf: (item) => modes.get(rootOf(item).key) ?? "filename" };
}

const MODE_WORDS: Record<IdentifierMode, string> = { folder: "by folder name", filename: "by file name", sheet_column: "by its identifier column" };

function rootWords(r: StoredRoot): string {
  switch (r.kind) {
    case "folder": return `folder ${r.name}`;
    case "files": return "the loose files";
    case "zip": return `zip ${r.name}`;
    case "drive_folder": return `Drive folder ${r.name}`;
    case "sheet": return `sheet ${r.name}`;
    case "links": return r.name;
  }
}

/**
 * The one grouping sentence (M1-F1-R2, M1 section 5): `Folder USPA_AW26 grouped by folder name,
 * sheet links.xlsx by column E (Option Id).` Null when there is no root.
 */
export function groupingSentence(roots: StoredRoot[]): string | null {
  if (!roots.length) return null;
  const parts = roots.map((r, i) => {
    const how = r.mode === "sheet_column" && r.column ? `by ${r.column}` : MODE_WORDS[r.mode];
    return `${rootWords(r)} ${i === 0 ? "grouped " : ""}${how}`;
  });
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
