// Grouping (spec 04, "Grouping"): which product every file belongs to and at which shot position,
// under the three identifier modes and the three precedences; the step 4 grouping rows and warning
// sentences. Deterministic: the order items arrive in never changes the result.
import { STYLI_MIN_SOURCE_HEIGHT_PX } from "../channels";
import { normalizeKey, renumberShots } from "../naming";
import type { BatchOptions, ChannelId, IdentifierMode, OutputFlag } from "../types";
import { classifyImageReject } from "./image-check";
import { matchProductList, missingIdentifier, type ProductListRow } from "./product-list";
import type { GroupingResult, PreviewRow, SourceItem } from "./types";
import { collectRejectReason } from "./zip";

export type { ProductListRow };

/** Known width and height per item (from checkImage); keyed by the collected item. */
export type ItemDimensions = Map<SourceItem, { width: number | null; height: number | null }>;

// --- Sentences ---------------------------------------------------------------

export function duplicateShotMessage(n: number, identifier: string, names: string[]): string {
  return `Two files claim shot ${n} of ${identifier}: ${names.join(", ")}. Rename one and re-upload.`;
}
export function noShotNumbersMessage(identifier: string, names: string[]): string {
  return `Files for ${identifier} have no shot numbers: ${names.join(", ")}. Rename them ${identifier}_1.jpg, ${identifier}_2.jpg.`;
}
export function shotMissingMessage(name: string): string {
  return `Shot number missing on ${name}; placed last.`;
}
export function noIdentifierMessage(name: string): string {
  return `Could not tell which product ${name} belongs to. Rename it like ABC123_1.jpg, or put it in a folder named after the product.`;
}

const DUPLICATE_REJECT = /^Two files claim shot \d+ of .+: .+\. Rename one and re-upload\.$/;
const NO_NUMBERS_REJECT = /^Files for .+ have no shot numbers: /;
const GAP_NOTE = /^(Shot numbers .+|Some shot numbers) are missing in the upload; images shifted left in this row\.$/;

/** True for the per-product rejects that leave a product out until a file is renamed. */
export function isDuplicateReject(reason: string): boolean {
  return DUPLICATE_REJECT.test(reason) || NO_NUMBERS_REJECT.test(reason);
}

const SAME_PRODUCT_REJECT = / are the same product\. Keep one\.$/;

/** Readable photos left out only because of their names (duplicate or missing shot numbers, two spellings). */
function leftOutForItsName(reason: string): boolean {
  return isDuplicateReject(reason) || SAME_PRODUCT_REJECT.test(reason);
}

/** Flags of a grouped shot for its version row (`numbering_gap` when its product had a gap). */
export function shotFlags(item: SourceItem): OutputFlag[] {
  return item.warnings.some((w) => GAP_NOTE.test(w)) ? ["numbering_gap"] : [];
}

// --- Identifiers ---------------------------------------------------------------

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "variant" });
const byText = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

const baseName = (item: SourceItem) => item.originalName.split(/[\\/]/).pop() || item.originalName;

/** File names for a sentence: base names, or the relative paths when two base names are the same. */
function namesOf(items: SourceItem[]): string[] {
  const bases = items.map(baseName);
  const clash = new Set(bases).size < bases.length;
  return (clash ? items.map((i) => i.originalName) : bases).sort(byText);
}

function shapeOf(folder: string | undefined): "" | "_rect" | "_square" {
  const f = (folder ?? "").toLowerCase();
  return f.startsWith("rect") ? "_rect" : f.startsWith("sq") ? "_square" : "";
}

/**
 * The folder-derived parts of an item: a parent or grandparent folder whose lowercase name starts
 * with `rect` / `sq` gives `_rect` / `_square`, and the nearest folder that is not such a shape
 * folder names the product (`ABC123/Square/1.jpg` is shot 1 of `ABC123_square`).
 */
function folderParts(item: SourceItem): { folder: string | null; shape: "" | "_rect" | "_square" } {
  let dirs = item.originalName.split(/[\\/]/).filter(Boolean).slice(0, -1);
  if (!dirs.length && item.folder) dirs = [item.folder];
  const parent = dirs[dirs.length - 1];
  const grand = dirs[dirs.length - 2];
  if (shapeOf(parent)) return { folder: grand ?? null, shape: shapeOf(parent) }; // ABC123/Square/1.jpg
  if (shapeOf(grand)) return { folder: parent ?? null, shape: shapeOf(grand) };  // Rectangle/ABC123/1.jpg
  return { folder: parent ?? null, shape: "" };
}

/** The identifier an item is grouped under in `mode`, shape suffix included ("" = none). */
function identifierOf(item: SourceItem, mode: IdentifierMode): string {
  const { folder, shape } = folderParts(item);
  let base: string;
  if (mode === "folder") base = item.bytes.kind === "url" ? item.sheetIdentifier ?? item.identifier : folder ?? "";
  else if (mode === "sheet_column" && item.sheetIdentifier) base = item.sheetIdentifier;
  // A purely numeric stem (`1.jpg`) has no identifier of its own: the folder names it in every mode.
  else base = item.identifier || (item.bytes.kind === "url" ? item.sheetIdentifier ?? "" : folder ?? "");
  base = base.trim();
  if (!base) return "";
  return base + (item.suffix || shape);
}

// --- Grouping --------------------------------------------------------------------

/** Grouped and rejected items are copies; this leads back to the collected item (dimension lookups). */
const originals = new WeakMap<SourceItem, SourceItem>();

function copyOf(item: SourceItem, identifier: string, n: number | null, extraWarnings: string[] = []): SourceItem {
  const c: SourceItem = { ...item, identifier, n, warnings: [...item.warnings, ...extraWarnings] };
  originals.set(c, originals.get(item) ?? item);
  return c;
}

/** The collected item a grouped or rejected copy was made from (the item itself otherwise). */
export function originalOf(item: SourceItem): SourceItem {
  return originals.get(item) ?? item;
}

interface Entry { item: SourceItem; id: string; raw: number | null; link: boolean }

const byNameThenUpload = (a: Entry, b: Entry) => byText(a.item.originalName, b.item.originalName) || byText(a.item.uploadId, b.item.uploadId);

/**
 * Groups items into products.
 * - `filename`: the identifier from the file name; a numeric stem takes its folder's name.
 * - `folder`: the nearest folder names the product; `n` from the file name, else the position in
 *   the folder's name-sorted list. Link items keep their sheet identifier.
 * - `sheet_column`: link items use their sheet identifier; files use the file name rules and join
 *   the sheet row with the same `normalizeKey` (taking the sheet's spelling).
 * In every mode a link item joins an uploaded product with the same `normalizeKey`, so precedence
 * applies across the two kinds; two uploaded spellings stay apart (the overwrite preview rejects them).
 *
 * When a product has both uploaded files and links, `options.precedence` decides: `uploads_only`
 * and `links_only` keep one kind, `uploads_then_links` keeps every uploaded shot and fills the other
 * shot numbers from links. A product only one kind has keeps it under every precedence (the step 2
 * card asks "Which wins when both have the same product?"). Shots are sorted by their file-name
 * number and renumbered 1..k.
 *
 * `unreadable` (optional, after the contract's parameters): items that failed `checkImage`, with
 * their reject sentence. They are rejected under their product's identifier instead of grouped.
 * Items carrying a zip reject sentence (`collectRejectReason`) are rejected the same way.
 */
export function groupItems(items: SourceItem[], options: BatchOptions, unreadable?: Map<SourceItem, string>): GroupingResult {
  const mode = options.identifierMode;
  const rejected: GroupingResult["rejected"] = [];
  let entries: Entry[] = [];

  for (const item of items) {
    const id = identifierOf(item, mode);
    const reason = unreadable?.get(item) ?? collectRejectReason(item);
    if (reason) rejected.push({ item: copyOf(item, id, item.n), reason });
    else if (!id) rejected.push({ item: copyOf(item, id, item.n), reason: noIdentifierMessage(baseName(item)) });
    else entries.push({ item, id, raw: item.n, link: item.bytes.kind === "url" });
  }

  // Join the two kinds of the same product when the other kind has exactly one spelling of it:
  // files take the sheet's spelling in sheet_column mode, links take the files' spelling otherwise.
  const linksJoinFiles = mode !== "sheet_column";
  const spellings = new Map<string, Set<string>>();
  for (const e of entries) {
    if (e.link === linksJoinFiles) continue;
    const k = normalizeKey(e.id);
    spellings.set(k, (spellings.get(k) ?? new Set()).add(e.id));
  }
  entries = entries.map((e) => {
    if (e.link !== linksJoinFiles) return e;
    const s = spellings.get(normalizeKey(e.id));
    return s && s.size === 1 ? { ...e, id: [...s][0]! } : e;
  });

  const byId = new Map<string, Entry[]>();
  for (const e of entries) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);

  const products = new Map<string, SourceItem[]>();
  for (const id of [...byId.keys()].sort(byText)) {
    let list = byId.get(id)!.sort(byNameThenUpload);
    const uploads = list.filter((e) => !e.link);
    const links = list.filter((e) => e.link);
    // Precedence only decides for a product that both kinds have; a product only one kind has keeps it.
    if (uploads.length && links.length) {
      if (options.precedence === "uploads_only") list = uploads;
      else if (options.precedence === "links_only") list = links;
      else {
        const taken = new Set(uploads.map((e) => e.raw).filter((n) => n !== null));
        list = [...uploads, ...links.filter((e) => e.raw === null || !taken.has(e.raw))];
      }
    }
    if (!list.length) continue;

    const rejectAll = (reason: string) => {
      for (const e of list) rejected.push({ item: copyOf(e.item, id, e.raw), reason });
    };

    // A duplicate shot number inside one kind leaves the whole product out.
    const claims = new Map<number, Entry[]>();
    for (const e of list) if (e.raw !== null) claims.set(e.raw, [...(claims.get(e.raw) ?? []), e]);
    const clash = [...claims.entries()].filter(([, es]) => es.length > 1).sort(([a], [b]) => a - b)[0];
    if (clash) {
      rejectAll(duplicateShotMessage(clash[0], id, namesOf(clash[1].map((e) => e.item))));
      continue;
    }

    let numbered = list.filter((e) => e.raw !== null);
    const unnumbered = list.filter((e) => e.raw === null).sort(byNameThenUpload);
    let placedLast = unnumbered;
    if (!numbered.length) {
      if (mode === "folder" || list.length === 1) {
        // Name order gives the positions; a single unnumbered file is shot 1 without a warning.
        numbered = unnumbered.map((e, i) => ({ ...e, raw: i + 1 }));
        placedLast = [];
      } else {
        rejectAll(noShotNumbersMessage(id, namesOf(list.map((e) => e.item))));
        continue;
      }
    }

    const shots = renumberShots(numbered, (e) => e.raw!);
    const gap = shots.note ? [shots.note] : [];
    const out = shots.shots.map((s) => copyOf(s.item.item, id, s.n, gap));
    // An unnumbered file beside numbered ones takes the next free position, in name order.
    for (const e of placedLast) out.push(copyOf(e.item, id, out.length + 1, [...gap, shotMissingMessage(baseName(e.item))]));
    products.set(id, out);
  }

  rejected.sort((a, b) => byText(a.item.identifier, b.item.identifier) || byText(a.item.originalName, b.item.originalName));
  return { products, rejected, warnings: [] };
}

// --- Preview rows ----------------------------------------------------------------

function dimsOf(item: SourceItem, dims: ItemDimensions | undefined): { width: number | null; height: number | null } {
  const d = dims?.get(item) ?? dims?.get(originalOf(item));
  return { width: d?.width || null, height: d?.height || null };
}

const distinct = (xs: string[]) => [...new Set(xs)];

/**
 * The step 4 grouping table, sorted by identifier, first `limit` rows:
 * - grouped products: `ok`, with their shots in order and the notes of their files;
 * - products left out for duplicate or missing shot numbers: `duplicate shot`, with the reason;
 * - products whose every file failed the image check: `unreadable`;
 * - `extra.missing` identifiers (product list rows without photos): `missing images`.
 * `files[].width/height` come from `extra.dimensions` when known, else null (buildPreview fills them).
 */
export function previewRows(
  grouped: GroupingResult,
  skus: Map<string, string[]>,
  firstShotThumb: (item: SourceItem) => string | null,
  limit: number,
  extra: { missing?: string[]; dimensions?: ItemDimensions } = {},
): PreviewRow[] {
  const skuIds = (id: string) => skus.get(id) ?? skus.get(normalizeKey(id)) ?? [];
  const fileRow = (items: SourceItem[]) =>
    items.map((it, i) => ({ n: it.n ?? i + 1, originalName: it.originalName, ...dimsOf(it, extra.dimensions) }));

  const rejectedById = new Map<string, GroupingResult["rejected"]>();
  for (const r of grouped.rejected) if (r.item.identifier) rejectedById.set(r.item.identifier, [...(rejectedById.get(r.item.identifier) ?? []), r]);

  const rows: PreviewRow[] = [];
  for (const [id, items] of grouped.products) {
    const extraNotes = (rejectedById.get(id) ?? []).map((r) => r.reason);
    rows.push({
      identifier: id, opptraSkuIds: skuIds(id), shots: items.length, firstShotUri: items[0] ? firstShotThumb(items[0]) : null,
      status: "ok", files: fileRow(items), notes: distinct([...items.flatMap((i) => i.warnings), ...extraNotes]),
    });
  }
  for (const [id, rs] of rejectedById) {
    if (grouped.products.has(id)) continue;
    const items = rs.map((r) => r.item).sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity) || byText(a.originalName, b.originalName));
    rows.push({
      identifier: id, opptraSkuIds: skuIds(id), shots: 0, firstShotUri: null,
      status: rs.some((r) => isDuplicateReject(r.reason)) ? "duplicate shot" : "unreadable",
      files: fileRow(items), notes: distinct(rs.map((r) => r.reason)),
    });
  }
  const present = new Set(rows.map((r) => normalizeKey(r.identifier)));
  for (const id of extra.missing ?? []) {
    if (present.has(normalizeKey(id))) continue;
    present.add(normalizeKey(id));
    rows.push({ identifier: id, opptraSkuIds: skuIds(id), shots: 0, firstShotUri: null, status: "missing images", files: [], notes: [] });
  }
  return rows.sort((a, b) => byText(a.identifier, b.identifier)).slice(0, Math.max(0, limit));
}

// --- Warning sentences --------------------------------------------------------------

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Product list matching for the warnings, through product-list.ts's matchProductList (exact, shape
 * suffix, size-level keys, token containment, match column): the list-only identifiers (named as
 * linkStatuses names them), the identifiers with photos that no row matched (after token-containment
 * renames) and the size-row sentence.
 */
function matchList(list: ProductListRow[], identifiers: string[], withPhotos: Set<string>, byMatchColumn: boolean): { listOnly: string[]; notInList: string[]; sizeSentence: string | null } {
  const m = matchProductList(list, identifiers, { byMatchColumn });
  const finals = identifiers.map((id) => m.renamed.get(id) ?? id);
  const notInList = distinct(identifiers.filter((id) => withPhotos.has(id)).map((id) => m.renamed.get(id) ?? id).filter((id) => !m.byIdentifier.has(id)));
  const seen = new Set(finals.map(normalizeKey));
  const listOnly: string[] = [];
  for (const row of m.unmatchedRows) {
    const id = missingIdentifier(row, m.sizeRowsMatched > 0, byMatchColumn);
    const k = normalizeKey(id);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    listOnly.push(id);
  }
  return { listOnly, notInList, sizeSentence: m.sizeSentence };
}

/** Headline = the first sentence, detail = the rest (the step 4 row: bold sentence, then the action). */
function split(sentence: string): { headline: string; detail: string } {
  const m = /^(.+?[.!?])(?:\s+(.*))?$/s.exec(sentence.trim());
  return m ? { headline: m[1]!, detail: m[2] ?? "" } : { headline: sentence, detail: "" };
}

function readPhrase(reason: string): string | null {
  switch (classifyImageReject(reason)) {
    case "unsupported": return /is an? \S+ file/.exec(reason)?.[0] ?? "is not a supported image";
    case "corrupt": return "is corrupt and could not be decoded";
    case "not_image": return "is not an image";
  }
  if (reason.startsWith("Nested zip files are not opened.")) return "is a zip file inside the zip";
  if (reason.endsWith(" is larger than 40 MB and was skipped.")) return "is larger than 40 MB";
  if (reason.startsWith("Could not tell which product ")) return "has no identifier in its name or folder";
  return null;
}

/**
 * The step 4 warning list, in the order of spec 04, each `{ headline, detail }`. `list` is the
 * product list (null without one). Optional `extra` (after the contract's parameters):
 * - `brandName` for the top-level folders sentence (default "this brand");
 * - `dimensions` for the Styli estimate (photos whose height is unknown are not counted);
 * - `topLevelFolders` from `Detected` (default: the first folder of every uploaded file's path);
 * - `byMatchColumn` when the product list's match column was chosen in step 2 (see matchProductList).
 * Batch-level sentences in `grouped.warnings` (for example the duplicate sheet rows sentence from
 * the links sheet adapter) follow, split into headline and detail.
 */
export function warningSentences(
  grouped: GroupingResult,
  list: ProductListRow[] | null,
  channels: ChannelId[],
  extra: { brandName?: string; dimensions?: ItemDimensions; topLevelFolders?: string[]; byMatchColumn?: boolean } = {},
): { headline: string; detail: string }[] {
  const out: { headline: string; detail: string }[] = [];
  // Every identifier seen, so a list row whose files were all unreadable is not also "no photos";
  // only identifiers with readable photos can be "not in your product list" (an identifier whose
  // files were all rejected, such as notes.pdf, belongs only in "files could not be read").
  const seen = distinct([...grouped.products.keys(), ...grouped.rejected.map((r) => r.item.identifier).filter(Boolean)]);
  const withPhotos = new Set([...grouped.products.keys(), ...grouped.rejected.filter((r) => r.item.identifier && leftOutForItsName(r.reason)).map((r) => r.item.identifier)]);

  const match = list ? matchList(list, seen, withPhotos, extra.byMatchColumn ?? false) : null;
  if (match?.listOnly.length) {
    out.push({
      headline: `${fmt(match.listOnly.length)} products have no photos.`,
      detail: `They are in your product list but no files matched: ${match.listOnly.join(", ")}. They will appear in the sheet as "missing images".`,
    });
  }
  if (match?.notInList.length) {
    out.push(split(`${fmt(match.notInList.length)} products have photos but are not in your product list: ${match.notInList.join(", ")}. They will appear in the sheet as not in sheet.`));
  }

  const unreadable = grouped.rejected.filter((r) => readPhrase(r.reason) !== null && r.item.ext !== "heic" && r.item.ext !== "heif");
  if (unreadable.length) {
    const groups = new Map<string, SourceItem[]>();
    for (const r of unreadable) groups.set(readPhrase(r.reason)!, [...(groups.get(readPhrase(r.reason)!) ?? []), r.item]);
    const parts = [...groups].map(([phrase, items]) => `${namesOf(items).join(", ")}: ${phrase}`);
    out.push({
      headline: `${fmt(unreadable.length)} files could not be read.`,
      detail: `${parts.join("; ")}. Fix them and use them in a new batch, or continue without them.`,
    });
  }

  if (channels.includes("styli")) {
    let small = 0;
    for (const items of grouped.products.values()) {
      for (const it of items) {
        const h = dimsOf(it, extra.dimensions).height;
        if (h !== null && h < STYLI_MIN_SOURCE_HEIGHT_PX) small++;
      }
    }
    if (small) {
      out.push({
        headline: `${fmt(small)} photos are smaller than Styli needs (under ${STYLI_MIN_SOURCE_HEIGHT_PX} px).`,
        detail: "Styli will skip them and note it in the sheet, as agreed with Styli.",
      });
    }
  }

  const duplicates = distinct(grouped.rejected.filter((r) => DUPLICATE_REJECT.test(r.reason)).map((r) => r.item.identifier));
  if (duplicates.length) {
    out.push(split(`${fmt(duplicates.length)} products have two files for the same shot number: ${duplicates.join(", ")}. They are left out until one file is renamed; see the grouping table.`));
  }

  const folders = extra.topLevelFolders ?? topLevelFolders(grouped);
  if (folders.length > 1) {
    out.push(split(`Your upload has ${fmt(folders.length)} top-level folders (${folders.join(", ")}). Everything in them will be filed under ${extra.brandName ?? "this brand"}. If these are different brands, make one batch per brand.`));
  }

  for (const w of grouped.warnings) out.push(split(w));

  if (match?.sizeSentence) out.push({ headline: match.sizeSentence, detail: "" });
  return out;
}

/** First folder of every uploaded (not linked) grouped file's path, sorted. */
function topLevelFolders(grouped: GroupingResult): string[] {
  const names = new Set<string>();
  for (const items of grouped.products.values()) {
    for (const it of items) {
      if (it.bytes.kind === "url") continue;
      const segs = it.originalName.split(/[\\/]/).filter(Boolean);
      if (segs.length > 1) names.add(segs[0]!);
    }
  }
  return [...names].sort(byText);
}
