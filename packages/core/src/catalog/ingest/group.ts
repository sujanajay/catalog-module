// Grouping (spec 04, "Grouping"): which product every file belongs to and at which shot position,
// under the three identifier modes and the three precedences; the step 4 grouping rows and warning
// sentences. Deterministic: the order items arrive in never changes the result.
import { normalizeKey, renumberShots } from "../naming";
import type { BatchOptions, ChannelId, IdentifierMode, OutputFlag } from "../types";
import { classifyImageReject } from "./image-check";
import { classifyLinkReject } from "./link-reasons";
import { matchProductList, missingIdentifier, type ProductListRow } from "./product-list";
import type { GroupingResult, LeftOutProduct, LeftOutWhy, PreviewRow, SameFile, SourceItem } from "./types";
import { collectRejectReason } from "./zip";
import { detectRoots } from "./roots";
import { pushAll } from "../../arrays";

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

/** The note on a shot that came as several files with the same bytes. */
export function sameFileMessage(kept: string, dropped: string[]): string {
  return `${[kept, ...dropped].join(" and ")} are the same photo, so one was used.`;
}

const DUPLICATE_REJECT = /^Two files claim shot \d+ of .+: .+\. Rename one and re-upload\.$/;
const NO_NUMBERS_REJECT = /^Files for .+ have no shot numbers: /;
const GAP_NOTE = /^(Shot numbers .+|Some shot numbers) are missing in the upload; images shifted left in this row\.$/;

/** True for the per-product rejects that leave a product out until a file is renamed. */
export function isDuplicateReject(reason: string): boolean {
  return DUPLICATE_REJECT.test(reason) || NO_NUMBERS_REJECT.test(reason);
}

const SAME_PRODUCT_REJECT = / are the same product\. Keep one\.$| is the same product as .+\. Only the newest photos are used\.$/;

/** "<a> and <b> are the same product. Keep one." for identifiers of one product, in the order given. */
export function sameProductMessage(identifiers: string[]): string {
  return `${identifiers.join(" and ")} are the same product. Keep one.`;
}
/** M1-F2-R7: the spelling left out because another spelling of the product came in a newer upload. */
export function olderSameProductMessage(older: string, newer: string): string {
  return `${older} is the same product as ${newer}. Only the newest photos are used.`;
}
/**
 * M1-F2-R7: of identifiers that are one product, the one whose photos came in the newest upload (by upload time), or
 * null when two share the newest time (for example two spellings in one folder).
 */
export function newestIdentifier(ids: readonly string[], itemsOf: (id: string) => readonly { uploadId: string }[], uploadAt: ReadonlyMap<string, number>): string | null {
  const at = (id: string) => Math.max(-Infinity, ...itemsOf(id).map((i) => uploadAt.get(i.uploadId) ?? -Infinity));
  const ranked = ids.map((id) => [id, at(id)] as const).sort((x, y) => y[1] - x[1]);
  const [first, second] = ranked;
  if (!first || first[1] === -Infinity || (second && second[1] === first[1])) return null;
  return first[0];
}
/** True for the reject of two spellings of one product (see sameProductMessage and olderSameProductMessage). */
export function isSameProductReject(reason: string): boolean {
  return SAME_PRODUCT_REJECT.test(reason);
}

const PRODUCT_REFUSAL = /^".+" (cannot be used in an image link|would share image links with)|^The identifier is empty/;
/** True for findOrCreateProduct's operator sentences (an empty or clashing path). */
export function isProductRefusal(reason: string): boolean {
  return PRODUCT_REFUSAL.test(reason);
}
const OLDER_SPELLING = / is the same product as .+\. Only the newest photos are used\.$/;
/** True for the files of an older spelling: its product carries on under the newest one, so nothing of it is lost. */
export function isOlderSpelling(reason: string): boolean {
  return OLDER_SPELLING.test(reason);
}

/** What leaving a product out means, in plain words: the short reason of its digest line and Exceptions group, and the fix. */
export const LEFT_OUT_WORDS: Record<LeftOutWhy, { text: string; fix: string }> = {
  same_shot: { text: "two different photos have the same shot number", fix: "Keep the right photo for each shot number, then send this product in a new batch." },
  no_shot_numbers: { text: "its photos have no shot numbers", fix: "Add shot numbers to the file names, then send this product in a new batch." },
  same_product: { text: "two names for the same product", fix: "Keep one name, then send this product in a new batch." },
  refused: { text: "its name cannot be used for image links", fix: "Rename the files, then send this product in a new batch." },
  links: { text: "none of its links could be downloaded", fix: "Fix the links, then send this product in a new batch." },
  unreadable: { text: "none of its photos could be read", fix: "Send usable photos of this product in a new batch." },
};

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "tif", "tiff", "bmp", "gif", "avif"]);
/**
 * A stray document, not a photo of a product: "not an image", an extension that is no image type, and a file that names
 * itself (`notes.pdf` under `notes`). A `.jpg` with broken bytes, or a PDF inside a product's folder, is not stray: its
 * product really is left out. A stray file is still a file row and still counted; it just does not make up a product.
 */
function isStrayFile(identifier: string, name: string, reason: string): boolean {
  if (classifyImageReject(reason) !== "not_image") return false;
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || IMAGE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())) return false;
  return normalizeKey(base.slice(0, dot)).startsWith(normalizeKey(identifier));
}

/** The same bytes under several product names: never merged, since which name is right would be a guess. */
export interface SharedPhotos { identifiers: string[]; products: number; photos: number }
const SHARED_NAMES_KEPT = 10;
/**
 * The photos delivered under more than one product, one row per set of products: every shot of a product sent under two
 * names is one row, and a size chart in 400 products is one row. Reads the hashes already in the ledger, so it costs no read.
 */
export function photosUnderSeveralProducts(products: readonly { identifier?: string; items: readonly { sha256?: string | null }[] }[]): SharedPhotos[] {
  const bySha = new Map<string, Set<string>>();
  for (const p of products) {
    if (!p.identifier) continue;
    for (const i of p.items) {
      if (!i.sha256) continue;
      const ids = bySha.get(i.sha256);
      if (ids) ids.add(p.identifier);
      else bySha.set(i.sha256, new Set([p.identifier]));
    }
  }
  const rows = new Map<string, { identifiers: string[]; photos: number }>();
  for (const ids of bySha.values()) {
    if (ids.size < 2) continue;
    const identifiers = [...ids].sort(byText);
    const key = identifiers.join("\n");
    const row = rows.get(key);
    if (row) row.photos++;
    else rows.set(key, { identifiers, photos: 1 });
  }
  return [...rows.values()]
    .map((r) => ({ identifiers: r.identifiers.slice(0, SHARED_NAMES_KEPT), products: r.identifiers.length, photos: r.photos }))
    .sort((a, b) => byText(a.identifiers[0]!, b.identifiers[0]!) || byText(a.identifiers[1]!, b.identifiers[1]!));
}

/**
 * Every product grouping left out whole, in identifier order, one per product (spellings that normalize alike are one):
 * an identifier with rejected files and no photo in `products`. Not one: files with no identifier, stray documents
 * (isStrayFile), and an older spelling of a product whose newest spelling carries on. The one definition behind the
 * digest, the Exceptions sheet, report.json and the outcome. Rows are the reject ledger, so stored batches can be read.
 */
export function leftOutProducts(rejected: readonly { identifier: string; name: string; reason: string }[], products: Iterable<string>): LeftOutProduct[] {
  const kept = new Set([...products].map(normalizeKey));
  const byKey = new Map<string, { identifier: string; rows: { name: string; reason: string }[] }>();
  for (const r of rejected) {
    const key = normalizeKey(r.identifier);
    if (!r.identifier || !key || kept.has(key)) continue;
    const entry = byKey.get(key);
    if (entry) entry.rows.push(r);
    else byKey.set(key, { identifier: r.identifier, rows: [r] });
  }
  const out: LeftOutProduct[] = [];
  for (const { identifier, rows } of byKey.values()) {
    if (rows.some((r) => OLDER_SPELLING.test(r.reason))) continue;
    const first = (test: (reason: string) => boolean) => rows.find((r) => test(r.reason));
    const named: [LeftOutWhy, ((reason: string) => boolean)][] = [["same_shot", (r) => DUPLICATE_REJECT.test(r)], ["no_shot_numbers", (r) => NO_NUMBERS_REJECT.test(r)], ["same_product", isSameProductReject], ["refused", isProductRefusal]];
    const hit = named.find(([, test]) => first(test));
    const photos = rows.filter((r) => !isStrayFile(identifier, r.name, r.reason));
    if (!hit && !photos.length) continue;
    const why: LeftOutWhy = hit ? hit[0] : photos.every((r) => classifyLinkReject(r.reason)) ? "links" : "unreadable";
    const reason = (hit ? first(hit[1])! : photos[0]!).reason;
    out.push({ identifier, why, reason, photos: rows.length, files: rows.map((r) => r.name) });
  }
  return out.sort((a, b) => byText(a.identifier, b.identifier));
}

/** Readable photos left out only because of their names (duplicate or missing shot numbers, two spellings). */
function leftOutForItsName(reason: string): boolean {
  return isDuplicateReject(reason) || isSameProductReject(reason);
}

/** Flags of a grouped shot for its version row (`numbering_gap` when its product had a gap). */
export function shotFlags(item: SourceItem): OutputFlag[] {
  return item.warnings.some((w) => GAP_NOTE.test(w)) ? ["numbering_gap"] : [];
}

// --- Identifiers ---------------------------------------------------------------

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "variant" });
/** Natural text order ("P2" before "P10"), ties broken by code units so the order is total. */
export const byText = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** The file name of an item, without its folders. */
export const baseName = (item: SourceItem) => item.originalName.split(/[\\/]/).pop() || item.originalName;

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

/** The product an item belongs to by its folder (`ABC123/Square/1.jpg` gives `ABC123_square`), "" when it has none. */
export function folderIdentifier(item: SourceItem): string {
  return identifierOf(item, "folder");
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

interface Entry { item: SourceItem; id: string; raw: number | null; link: boolean; mode: IdentifierMode; notes?: string[] }

const byNameThenUpload = (a: Entry, b: Entry) => byText(a.item.originalName, b.item.originalName) || byText(a.item.uploadId, b.item.uploadId);

/** The name of an item without its folders and extension: `X.jpg` and `X.jpeg` have one stem. */
/**
 * One file per photo, in every grouping mode: all entries of a product with the same bytes are one file, whatever their
 * names, folders or shot numbers, so a photo never goes out twice or takes two image slots. The lowest shot number is
 * kept (then list order: name, then upload) and a note names the rest. A place only a dropped copy held closes up, so it
 * does not read as a missing shot; a real gap stays. Unknown bytes never merge, and bytes that differ stay for the clash
 * check to judge.
 */
function mergeSameFiles(id: string, list: Entry[], sha256Of: (item: SourceItem) => string | null | undefined): { list: Entry[]; same: SameFile[] } {
  const keep = new Map<string, Entry>();
  const dropped = new Map<Entry, Entry[]>();
  for (const e of [...list].sort((a, b) => (a.raw ?? Infinity) - (b.raw ?? Infinity))) {
    const sha = sha256Of(e.item);
    const first = sha ? keep.get(sha) : undefined;
    if (first) dropped.set(first, [...(dropped.get(first) ?? []), e]);
    else if (sha) keep.set(sha, e);
  }
  if (!dropped.size) return { list, same: [] };
  const gone = new Set([...dropped.values()].flat());
  const out = list.filter((e) => !gone.has(e));
  const held = new Set(out.map((e) => e.raw));
  const closed = [...new Set([...dropped.values()].flat().map((e) => e.raw))].filter((r): r is number => r !== null && !held.has(r));
  const same: SameFile[] = [];
  return {
    same,
    list: out.map((e) => {
      const raw = e.raw === null ? null : e.raw - closed.filter((r) => r < e.raw!).length;
      const others = dropped.get(e);
      if (!others) return { ...e, raw };
      same.push({ identifier: id, n: raw, kept: e.item.originalName, dropped: others.map((o) => o.item.originalName) });
      return { ...e, raw, notes: [sameFileMessage(baseName(e.item), others.map((o) => baseName(o.item)))] };
    }),
  };
}

/**
 * Pasted rows are numbered by their place in their own paste, so two pastes of one product (the same folder name in
 * vm-ol and vero-moda) both start at 1. Those numbers are not the sender's, so they cannot clash: a later paste carries
 * on after the one before, the same numbers one paste of both would give.
 */
function pastesInOrder(list: Entry[]): Entry[] {
  const pastes = new Map<string, Entry[]>();
  for (const e of list) if (e.item.positional && e.raw !== null) pastes.set(e.item.uploadId, [...(pastes.get(e.item.uploadId) ?? []), e]);
  if (pastes.size < 2) return list;
  const after = new Map<Entry, number>();
  let offset = 0;
  for (const rows of pastes.values()) {
    for (const e of rows) after.set(e, e.raw! + offset);
    offset = Math.max(...rows.map((e) => after.get(e)!));
  }
  return list.map((e) => (after.has(e) ? { ...e, raw: after.get(e)! } : e));
}

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
 *
 * `options.perRoot` (M1-F1-R2): the mode is decided per input root by detectRoots instead of
 * `options.identifierMode`, and links always take the uploaded files' spelling. The roots and their
 * modes come back in `roots`.
 *
 * `sha256Of` (optional): the sha256 of an item's bytes. Every item has been downloaded and hashed before the batch-wide
 * step groups it, so a same-number clash is judged by bytes here at no extra read: the same bytes are one file
 * (mergeSameFiles, listed in `sameFiles`), and different bytes leave the product out, since we cannot tell which is right.
 */
export function groupItems(items: SourceItem[], options: BatchOptions, unreadable?: Map<SourceItem, string>, sha256Of?: (item: SourceItem) => string | null | undefined): GroupingResult {
  const perRoot = options.perRoot === true;
  const detected = perRoot ? detectRoots(items, folderIdentifier) : null;
  const modeOf = detected ? detected.modeOf : () => options.identifierMode;
  const rejected: GroupingResult["rejected"] = [];
  const sameFiles: SameFile[] = [];
  let entries: Entry[] = [];

  for (const item of items) {
    const mode = modeOf(item);
    const id = identifierOf(item, mode);
    const reason = unreadable?.get(item) ?? collectRejectReason(item);
    if (reason) rejected.push({ item: copyOf(item, id, item.n), reason });
    else if (!id) rejected.push({ item: copyOf(item, id, item.n), reason: noIdentifierMessage(baseName(item)) });
    else entries.push({ item, id, raw: item.n, link: item.bytes.kind === "url", mode });
  }

  // Join the two kinds of the same product when the other kind has exactly one spelling of it:
  // files take the sheet's spelling in sheet_column mode, links take the files' spelling otherwise.
  const linksJoinFiles = perRoot || options.identifierMode !== "sheet_column";
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
    let list = pastesInOrder(byId.get(id)!.sort(byNameThenUpload));
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
    // A product left out takes every file with it, copies included, and records no merge: nothing of it was used.
    const whole = list;
    const merged = sha256Of ? mergeSameFiles(id, list, sha256Of) : { list, same: [] };
    list = merged.list;

    const rejectAll = (reason: string) => {
      for (const e of whole) rejected.push({ item: copyOf(e.item, id, e.raw), reason });
    };

    // Two different photos at one shot number leave the whole product out: we cannot tell which is right.
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
      if (list.some((e) => e.mode === "folder") || list.length === 1) {
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
    const out = shots.shots.map((s) => copyOf(s.item.item, id, s.n, [...gap, ...(s.item.notes ?? [])]));
    // An unnumbered file beside numbered ones takes the next free position, in name order.
    for (const e of placedLast) out.push(copyOf(e.item, id, out.length + 1, [...gap, ...(e.notes ?? []), shotMissingMessage(baseName(e.item))]));
    products.set(id, out);
    pushAll(sameFiles, merged.same);
  }

  rejected.sort((a, b) => byText(a.item.identifier, b.item.identifier) || byText(a.item.originalName, b.item.originalName));
  return { products, rejected, warnings: [], ...(detected ? { roots: detected.roots } : {}), ...(sameFiles.length ? { sameFiles } : {}) };
}

// --- Preview rows ----------------------------------------------------------------

function dimsOf(item: SourceItem, dims: ItemDimensions | undefined): { width: number | null; height: number | null } {
  const d = dims?.get(item) ?? dims?.get(originalOf(item));
  return { width: d?.width || null, height: d?.height || null };
}

export const distinct = (xs: string[]) => [...new Set(xs)];

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

export const fmt = (n: number) => n.toLocaleString("en-US");

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
    // A link that could not be downloaded has its own reason phrase and its own warning (spec 14b F5).
    case "link": return classifyLinkReject(reason)!.phrase;
  }
  if (reason.startsWith("Nested zip files are not opened.")) return "is a zip file inside the zip";
  if (reason.endsWith(" is larger than 40 MB and was skipped.")) return "is larger than 40 MB";
  if (reason.startsWith("Could not tell which product ")) return "has no identifier in its name or folder";
  return null;
}

/**
 * The step 4 warning list, in the order of spec 04, each `{ headline, detail }`. `list` is the
 * product list (null without one). `_channels` stays in the contract but no sentence depends on it: no channel
 * leaves a photo out for its size (owner decision 2026-10-22, Styli included). Optional `extra` (after the contract's parameters):
 * - `brandName` for the top-level folders sentence (default "this brand");
 * - `topLevelFolders` from `Detected` (default: the first folder of every uploaded file's path);
 * - `byMatchColumn` when the product list's match column was chosen in step 2 (see matchProductList).
 * Batch-level sentences in `grouped.warnings` (for example the duplicate sheet rows sentence from
 * the links sheet adapter) follow, split into headline and detail.
 */
export function warningSentences(
  grouped: GroupingResult,
  list: ProductListRow[] | null,
  _channels: ChannelId[],
  extra: { brandName?: string; topLevelFolders?: string[]; byMatchColumn?: boolean } = {},
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

  // Files only: links that could not be downloaded are the pair below.
  const unreadable = grouped.rejected.filter((r) => readPhrase(r.reason) !== null && classifyImageReject(r.reason) !== "link" && r.item.ext !== "heic" && r.item.ext !== "heif");
  if (unreadable.length) {
    const groups = new Map<string, SourceItem[]>();
    for (const r of unreadable) groups.set(readPhrase(r.reason)!, [...(groups.get(readPhrase(r.reason)!) ?? []), r.item]);
    const parts = [...groups].map(([phrase, items]) => `${namesOf(items).join(", ")}: ${phrase}`);
    out.push({
      headline: `${fmt(unreadable.length)} files could not be read.`,
      detail: `${parts.join("; ")}. Fix them and use them in a new batch, or continue without them.`,
    });
  }

  const linkPair = linkFailureWarning(grouped.rejected);
  if (linkPair) out.push(linkPair);

  const duplicates = distinct(grouped.rejected.filter((r) => DUPLICATE_REJECT.test(r.reason)).map((r) => r.item.identifier));
  if (duplicates.length) {
    out.push(split(`${fmt(duplicates.length)} products have two files for the same shot number: ${duplicates.join(", ")}. They are left out until one file is renamed; see the grouping table.`));
  }

  // Left out by name too, with no sentence of their own until now: the preview says so before the batch moves on.
  const noNumbers = distinct(grouped.rejected.filter((r) => NO_NUMBERS_REJECT.test(r.reason)).map((r) => r.item.identifier));
  if (noNumbers.length) {
    out.push(split(`${fmt(noNumbers.length)} ${noNumbers.length === 1 ? "product has" : "products have"} files with no shot numbers: ${noNumbers.join(", ")}. They are left out until the files are renamed; see the grouping table.`));
  }
  const refused = distinct(grouped.rejected.filter((r) => isProductRefusal(r.reason)).map((r) => r.item.identifier));
  if (refused.length) {
    out.push(split(`${fmt(refused.length)} ${refused.length === 1 ? "product has" : "products have"} a name that cannot be used for image links: ${refused.join(", ")}. They are left out until the files are renamed; see the grouping table.`));
  }

  const folders = extra.topLevelFolders ?? topLevelFolders(grouped);
  if (folders.length > 1) {
    out.push(split(`Your upload has ${fmt(folders.length)} top-level folders (${folders.join(", ")}). Everything in them will be filed under ${extra.brandName ?? "this brand"}. If these are different brands, make one batch per brand.`));
  }

  for (const w of grouped.warnings) out.push(split(w));

  if (match?.sizeSentence) out.push({ headline: match.sizeSentence, detail: "" });
  return out;
}

/** Products named in the step 4 link pair. */
const LINK_PAIR_IDS = 10;

/**
 * The step 4 link pair (spec 14b F5 part 1): "<k> links could not be downloaded." and "<products>
 * products are missing shots: <ids, first 10>." with the retry ending when some failures may be
 * temporary, else the fix ending. Null when no link failed.
 */
export function linkFailureWarning(rejected: GroupingResult["rejected"]): { headline: string; detail: string } | null {
  const links = rejected.flatMap((r) => {
    const link = classifyLinkReject(r.reason);
    return link ? [{ link, identifier: r.item.identifier }] : [];
  });
  if (!links.length) return null;
  const ids = distinct(links.map((l) => l.identifier).filter(Boolean)).sort(byText);
  const temporary = links.some((l) => l.link.temporary);
  const products = `${fmt(ids.length)} ${ids.length === 1 ? "product is" : "products are"} missing shots: ${ids.slice(0, LINK_PAIR_IDS).join(", ")}.`;
  return {
    headline: `${fmt(links.length)} ${links.length === 1 ? "link" : "links"} could not be downloaded.`,
    detail: `${products} ${temporary ? "Try the failed links again, fix the sheet, or continue without them." : "Fix the links, or continue without them."}`,
  };
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
