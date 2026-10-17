# 04 Ingestion

Execute with `docs/specs/00-execution-protocol.md`. Source of truth: `docs/SPEC.md`. Depends on 02
(types, naming, storage, schema, safe-url, csv, products, sku-mapping) and 03 (the roles that guard
the routes which call this code). The wizard copy this spec produces data for is the prototype
transcribed in `01-ui-prototype.md`; the pages and routes themselves ship in 06.

## Goal

Every way images and identifiers arrive becomes rows in `catalog_products`, `catalog_batch_products`
and `catalog_source_images` pointing at `raw/` objects in GCS, with:

- the step 2 data ("Check what we found": identifier mode, precedence, photo formats, sheet columns,
  Google access) that 06 serves at `GET /api/catalog/batches/[id]/detected`;
- the step 4 data (KPIs, warnings, grouping table, overwrite preview, busy products) that 06 serves
  at `GET /api/catalog/batches/[id]/preview`;
- `link_status` from an optional product list;
- a `catalog-local collect` CLI mode that runs the same adapters on a laptop and writes a manifest
  that 05 renders from.

Plain-language terms used below. Identifier: the style+colour code in a file name or sheet column
(`ABC123` in `ABC123_1.jpg`). Shot number `n`: the number after the last `_` or `-` in the file name,
which decides photo order. Product: brand + identifier; defined in 02 as `product_key =
normalizeKey(identifier)`. Alias: another spelling or id (Opptra SKU id, option id, channel id) that
points at the same product. Version: one upload of one shot; the newest is "current".

## Scope and non-scope

In scope: the adapters, detection of what was dropped or pasted, the instant access check for pasted
links, grouping and duplicate rules under the three identifier modes and three precedences, product
list parsing and `link_status`, product matching through aliases, the overwrite preview, source image
versions, the ingest task handler and its self-continuation, the web upload signing helpers (library
functions, not routes), the collection of Google Sheets and Drive folders on the web tier, and the CLI
collect mode.

Out of scope: the HTTP routes and pages (06), matting and rendering (05), SKU resolution logic (02,
called from here), product-type detection (07), locking products at start (06), QA (07).

## Ingestion table

| Source | Operator action | System | Identifier / order |
|---|---|---|---|
| Local folder or files | drag the folder or select files (relative paths kept) | direct-to-GCS signed PUT per file, parallel, progress | filename stem; subfolder name when files are `1.jpg, 2.jpg`; Rectangle/Square folder adds `_rect`/`_square` |
| Zip(s), hundreds of MB | drag | signed PUT; worker expands by GCS range reads; nested folders walked; `__MACOSX`, dotfiles skipped | same |
| Links sheet (xlsx/csv) | drag | parsed on the worker; identifier column and URL columns detected (URL = http(s) in at least half the cells or header says url/link/image); override in step 2 | identifier column; URL column order = shot order; cells split on `,`/`;` |
| Google Sheet link | paste URL | sheet shared with `catalog-web@image-links-agent.iam.gserviceaccount.com` (shown with a copy button and an instant access check); Sheets API; else drop the xlsx | same as links sheet |
| Google Drive folder link | paste URL | folder shared with the same account; Drive API lists recursively and streams into our bucket; if Workspace policy blocks it the wizard asks for a zip | same as folder |
| Pasted image URLs | paste one per line, optionally `identifier<TAB>url` | SSRF-safe fetch (Supabase, `sceimage.blob.core.windows.net`, any https; manual redirects; 40 MB cap) | pasted identifier, else URL filename stem |
| Product list (xlsx/csv) | drag, mark as "product list" in step 2 | parsed; identifier (and EAN) column detected or chosen | gives `link_status` and SKU mapping keys |
| WeTransfer, email attachments, Dropbox | manual download and drop (no API, or not needed now) | | |

Rules for all sources:

- There is no separator option. `parseShotName` (02) reads the number after the last `_` or `-`
  (also `_0n`), so `ABC123_1.jpg`, `ABC123-1.jpg` and `ABC123_01.jpg` all give identifier `ABC123`,
  `n = 1`.
- The identifier mode is chosen in step 2: `identifierMode = filename | folder | sheet_column`
  (`IDENTIFIER_MODES` from 02; default `filename`). The ingest detects the likely mode and the
  operator can change it; a change re-runs the grouping from bytes already in our bucket.
- When both uploaded files and links exist, `precedence = uploads_then_links | links_only |
  uploads_only` (`PRECEDENCES` from 02; default `uploads_then_links`) decides which wins for the same
  `(identifier, n)`. The card is shown only when both kinds exist.
- A duplicate `(identifier, n)` inside the same precedence class rejects that product only; nothing
  else is affected.
- Shot numbering (defined in 02, restated here because this spec applies it): a shot number has at
  most three digits; a trailing `_<number>` or `-<number>` with four or more digits is part of the
  identifier (`ONLY-SHOES_Autumnwinter_5079628_15380145.jpg` is shot 1 of identifier
  `ONLY-SHOES_Autumnwinter_5079628_15380145`; `IMG_2041.heic` is identifier `IMG_2041`, shot 1).
  Shot `n` is the position of the file in the product's upload, counted 1..k in the order of the
  numbers in the file names (`_1`, `_2`, `_4` become positions 1, 2, 3); paths and the sheet use
  positions, so there is never a blank cell for a gap; a gap gives flag `numbering_gap` and the note
  "Shot numbers <list> are missing in the upload; images shifted left in this row." The order files
  arrived in, and their order in a zip or folder listing, never affects shot order.
- HEIC and HEIF files are normal images: they are converted automatically by `POST /convert` on
  `catalog-matting` (05) before decoding. Non-image, BMP and corrupt files are listed with plain
  reasons; nothing is dropped silently.
- No language model takes part in grouping, counting, column detection, SKU resolution or link
  construction (02). Those are deterministic code with unit tests. Detection never guesses: when a
  sheet's identifier column cannot be told, step 2 asks instead of picking one.
- Every source is copied to `rawPath(prefix, pathKey, n, ext)` (02) with its `sha256` computed on the
  way; large collections run on the worker and self-continue ("Collecting files 48 of 310").
- Opptra SKU ids are optional and never a warning. The grouping table shows them when known.

## Files to add or change

```
packages/core/package.json                            add deps: unzipper, googleapis (sheets v4, drive v3), file-type (02 lists them; confirm present)
packages/core/src/catalog/ingest/types.ts             NEW  SourceItem, BytesRef, CollectInput, IngestDeps, Adapter, Detected, PreviewRow, GroupingResult, DetectedStep2, OverwritePreview, Preview
packages/core/src/catalog/ingest/detect.ts            NEW  detectUploadKind, detectPastedText, checkLinkAccess
packages/core/src/catalog/ingest/detect-step.ts       NEW  buildDetectedStep2 (step 2 data from the collected uploads)
packages/core/src/catalog/ingest/local-files.ts       NEW  planSignedUploads, completeUploads (server side of the browser PUT flow)
packages/core/src/catalog/ingest/zip.ts               NEW  zip adapter over GCS range reads
packages/core/src/catalog/ingest/links-sheet.ts       NEW  xlsx/csv links sheet adapter, readSheetTable, detectColumns
packages/core/src/catalog/ingest/google-sheet.ts      NEW  Sheets API read on the web tier plus access check
packages/core/src/catalog/ingest/drive-folder.ts      NEW  Drive API listing and streaming on the web tier plus access check
packages/core/src/catalog/ingest/url-list.ts          NEW  pasted URL adapter
packages/core/src/catalog/ingest/product-list.ts      NEW  product list parsing, linkStatuses
packages/core/src/catalog/ingest/group.ts             NEW  groupItems (three identifier modes, precedence), previewRows, warning sentences
packages/core/src/catalog/ingest/image-check.ts       NEW  sniff mime, dimensions, unsupported/corrupt classification (sharp metadata)
packages/core/src/catalog/ingest/overwrite-preview.ts NEW  matchProducts, buildOverwritePreview
packages/core/src/catalog/ingest/index.ts             NEW  ADAPTERS, collect, runIngest, buildPreview
apps/worker/src/catalog/ingest.ts                     NEW  handleIngestTask (route /tasks/catalog/ingest)
apps/worker/src/server.ts                             CHANGE register /tasks/catalog/ingest in the route table from 02
apps/worker/src/catalog-local.ts                      NEW  CLI entry (esbuild entry "catalog-local"); collect mode only in this spec
apps/worker/build.mjs                                 CHANGE add the catalog-local entry; mark sharp and unzipper external if the bundle needs it
apps/worker/Dockerfile                                CHANGE nothing unless a native dependency needs it
infra/bootstrap.sh                                    CHANGE nothing: Sheets and Drive use the service accounts' own identity; APIs enabled in 02
```

## Contracts

### From 02 (used here, not redefined)

`UploadKind`, `BatchOptions`, `IdentifierMode`, `Precedence`, `LinkStatus`, `OutputFlag`, `ChannelId`,
`BatchCounts` and the `catalog_uploads` row type from `catalog/types.ts`; `parseShotName`,
`sanitizeSegment`, `normalizeKey`, `batchPrefix`, `uploadPath`, `rawPath`, `publicObjectPath` from
`catalog/naming.ts`; `signedPutUrl`, `headObject`, `readRange`, `createRangeStream`, `listObjects`,
`uploadBuffer`, `downloadBuffer`, `setCustomTime` from `storage.ts`; `safeFetch` from `safe-url.ts`;
`parseCsv` from `csv.ts`; `enqueueTask` from `tasks.ts`; `resolveSkus` from `catalog/sku-mapping.ts`;
`findOrCreateProduct` and the alias lookup from `catalog/products.ts`; `STYLI_MIN_SOURCE_HEIGHT_PX`
and `CHANNELS` from `catalog/channels.ts`; `Db` from `db/client.ts`. All object paths start from
`prefix = batchPrefix(brandSlug, batchId, isTest)` so test batches stay under `catalog-test/`.

Tables written here (defined in 02): `catalog_uploads` (`status`, `detected`, `error`),
`catalog_products` (new rows only), `catalog_batch_products` (`link_status`), `catalog_source_images`
(version rows), `catalog_batches.counts` and `catalog_batches.status`. Tables read: `catalog_products`,
`catalog_product_aliases`, `catalog_source_images`, `catalog_outputs` (live rows, for the overwrite
preview), `sku_map`.

### Types (`packages/core/src/catalog/ingest/types.ts`)

```ts
export type BytesRef =
  | { kind: "gcs"; gsUri: string }                                  // already in our bucket (uploads/ or raw/)
  | { kind: "url"; url: string }                                    // to fetch with safeFetch
  | { kind: "zip-entry"; zipGsUri: string; entryPath: string; compressedSize: number; uncompressedSize: number };

export interface SourceItem {
  identifier: string;            // verbatim, before sanitisation
  n: number | null;              // shot order; null when it could not be read from the name
  suffix: "" | "_rect" | "_square";
  originalName: string;          // relative path, file name or URL last segment
  folder: string | null;         // nearest parent folder name, for identifierMode "folder"
  sheetIdentifier: string | null;// identifier column value, for identifierMode "sheet_column"
  ext: string;                   // lowercase, from name; corrected after sniffing
  bytes: BytesRef;
  uploadId: string;
  origin: UploadKind;
  warnings: string[];            // plain sentences, shown in step 4
}

export interface CollectInput {
  batchId: string; brandSlug: string; prefix: string;   // prefix = batchPrefix(brandSlug, batchId, isTest) from 02
  upload: CatalogUpload; options: BatchOptions;
  deps: IngestDeps;
  onProgress?(done: number, total: number | null): void;
}

export interface IngestDeps {
  storage: Pick<typeof import("../../storage"), "downloadBuffer" | "uploadBuffer" | "headObject" | "readRange" | "createRangeStream" | "listObjects" | "setCustomTime">;
  fetch: typeof fetch;                               // injected for tests; production passes safeFetch's fetch
  sheets?: SheetsLike; drive?: DriveLike;            // googleapis clients or fakes (web tier only)
  now?: () => Date;
}

export interface Adapter { kind: UploadKind; collect(input: CollectInput): Promise<SourceItem[]> }

export interface Detected {                          // stored in catalog_uploads.detected
  kind: UploadKind;
  title?: string;                                    // sheet title, folder name, zip name
  rows?: number; columns?: string[]; headerRow?: number;
  identifierColumn?: number;                         // -1 when it could not be told (sheet "cannot read")
  identifierHeader?: string; styleColumn?: number | null; colourColumn?: number | null;   // composite key when both set
  urlColumns?: number[]; eanColumn?: number | null;
  matchColumn?: number; sheetNames?: string[];       // product list: what finalize (06) needs for the filled copy
  cannotRead?: string | null;                        // "Could not tell which column holds the identifier."
  fileCount?: number; topLevelFolders?: string[];
  formats?: { jpg: number; png: number; heic: number; other: number };
  rejected?: { name: string; reason: string }[];     // per-upload rejects with their sentences
  message: string;                                   // the one-line text for the wizard
}

export interface PreviewRow {
  identifier: string; opptraSkuIds: string[]; shots: number; firstShotUri: string | null;
  status: "ok" | "missing images" | "duplicate shot" | "unreadable";
  files: { n: number; originalName: string; width: number | null; height: number | null }[];   // the row expands to this list
  notes: string[];
}

export interface GroupingResult {
  products: Map<string, SourceItem[]>;               // identifier -> items sorted by n
  rejected: { item: SourceItem; reason: string }[];  // unsupported, corrupt, duplicate, no identifier
  warnings: string[];                                // batch-level sentences for the step 4 warning list
}

export interface DetectedStep2 {
  identifierMode: { detected: IdentifierMode; options: IdentifierMode[]; examples: { identifier: string; label: string; thumbs: string[] }[] };
  groupedBy: string;                                 // the announcement line, see detect-step.ts
  precedence: { shown: boolean; default: Precedence };
  formats: { jpg: number; png: number; heic: number; other: number; sentence: string };
  sheetColumns: { identifier: number; images: number[]; sentence: string; choices: { identifier: { column: number; header: string }[]; images: { columns: number[]; header: string }[] } } | null;
  sheets: { uploadId: string; name: string; identifierColumn: number; identifierHeader: string | null; imageColumns: number[]; kind: "sheet" | "product_list"; cannotRead: string | null }[];
  googleAccess: { url: string; kind: "google_sheet" | "drive_folder"; status: "ok" | "no_access" | "blocked"; sentence: string }[];
}

export interface OverwritePreview {
  newProducts: number;
  existingProducts: { identifier: string; liveShots: number[]; uploadShots: number[]; shotsToRemove: number[]; channels: ChannelId[] }[];
  renameHints: { newIdentifier: string; existingIdentifier: string }[];
  duplicates: { a: string; b: string }[];
  busy: { identifier: string; batchName: string }[];
}

export interface Preview {                           // step 4 data
  kpis: { products: number; photos: number; channels: number; outputs: number };
  warnings: { headline: string; detail: string }[];
  rows: PreviewRow[]; totalRows: number;
  overwrite: OverwritePreview;
}
```

`examples` carries three products as the prototype shows them: in `filename` mode the label is
`from <id>_1.jpg ... _<k>.jpg`, in `folder` mode `<folder>/` and `<k> files in the folder`, in
`sheet_column` mode `column <L>, <k> photo links`. `thumbs` are signed read URLs of the first shots
(`signedUrl` from 02, short TTL).

### Detection (`detect.ts`)

```ts
export function detectUploadKind(name: string, head: Buffer): UploadKind | "unknown";
/** docs.google.com/spreadsheets -> google_sheet; drive.google.com/drive/folders or /folders/ -> drive_folder; one or more http(s) lines -> url_list; else null. */
export function detectPastedText(text: string): { kind: "google_sheet" | "drive_folder" | "url_list"; ids: string[] } | null;
export async function checkLinkAccess(text: string, deps: Pick<IngestDeps, "sheets" | "drive" | "fetch">): Promise<Detected | { kind: UploadKind; error: string }>;
```

`checkLinkAccess` is the "instant access check" behind `POST /api/catalog/batches/[id]/links` (06).
It runs on the web tier as `catalog-web@`, the address shown next to the box (`SHARE_SA_EMAIL`,
02). Its sentences are exactly the prototype copy:

- a readable sheet: `Google Sheet "<title>", <n> rows, <m> image columns found.`
- a 403 or 404 from Drive for a folder: `Share the folder with the address above, then paste again.`
- a 403 or 404 from Sheets: `Share the sheet with the address above, then paste again.`
- a URL list: pill `<n> image links` and `We will download them when you start. No sharing needed.`
- a 403 whose message mentions domain policy or `cannotShareOutsideDomain`: `Your Google settings
  block sharing with our address. Download the folder as a zip and drop it instead.`

Zip detection is by magic bytes `50 4B 03 04`; xlsx is also a zip, so when the name ends in `.xlsx`
or the zip contains `xl/workbook.xml` it is a sheet. `.csv` is a sheet. Image types are sniffed with
`file-type` (jpeg, png, webp, tiff, gif, avif, heic). Whether a sheet is a links sheet or a product
list is decided by content (`links-sheet.ts` column detection) and can be overridden in step 2
(`catalog_uploads.kind` updated to `product_list` by 06's `PATCH`).

### Step 2 data (`detect-step.ts`)

```ts
export async function buildDetectedStep2(db: Db, batchId: string, deps: Pick<IngestDeps, "storage">): Promise<DetectedStep2>;
```

Reads the batch's `catalog_uploads.detected` rows and the batch options and produces:

- `identifierMode.detected`: `sheet_column` when the only image source is a sheet; `folder` when
  more than half of the files have purely numeric stems (`1.jpg`, `02.jpg`); else `filename`.
  `options` lists the modes that make sense for what arrived (`sheet_column` only with a sheet,
  `folder` only with folders). The operator's current choice is `options.identifierMode`.
- `precedence.shown`: true only when at least one upload of kind `zip | image | drive_folder` and
  at least one of kind `sheet | google_sheet | url_list` exist. `default` is `uploads_then_links`.
- `groupedBy`: the announcement line 06 shows above the grouping table: `Grouped by file name
  (<identifier>_<n>)`, `Grouped by folder name`, `Grouped by the sheet column <header>`, `Grouped by
  style and colour code (<style header> + <colour header>)`, or `Matched by style and colour code
  found inside the file names` (the product-list case below).
- `formats.sentence`: `<a> JPG, <b> PNG (transparent backgrounds kept), <c> HEIC (iPhone format,
  converted automatically).` with the PNG and HEIC parts omitted when their count is 0, and `, <d>
  other` appended when `other > 0`.
- `sheetColumns`: from the links sheet's `detectColumns` result (null when no sheet). `sentence` is
  `We will use column <L> (<header>) as the identifier and columns <L1> to <L2> (<header range>) as
  photos.` where `<L>` is the spreadsheet letter and `<header range>` is the first and last header
  joined with ` to ` (for example `Product Image 1 to 6`); with a composite key the sentence is
  `Grouped by style and colour code (<style header> + <colour header>)`. `choices` lists every
  column as a possible identifier and every run of adjacent URL columns as a possible photo range.
- `sheets`: one entry per sheet upload (links sheet or product list), the data behind the real
  step 2 controls: the identifier-column picker, the image-columns picker and the sheet-kind choice
  (`links sheet` | `product list`). 06 shows each as "Sheet `<name>`: identifier column `<header>`,
  <m> image columns, read as <links sheet | product list>" with "Change". A sheet whose
  `identifierColumn` is -1 carries `cannotRead = "Could not tell which column holds the
  identifier."`; 06 shows the picker open and disables Continue until a column is chosen. Saving a
  change re-runs the grouping from bytes already in our bucket (no re-download).
- `googleAccess`: one entry per pasted Google link with the `checkLinkAccess` sentence and status.

### Local files (`local-files.ts`)

```ts
export interface PlannedUpload { relativePath: string; objectPath: string; putUrl: string; contentType: string }
/** One signed PUT per file; objectPath = uploadPath(prefix, uploadId, relativePath); TTL is signedPutUrl's default (02). */
export async function planSignedUploads(input: { prefix: string; uploadId: string; files: { relativePath: string; size: number; type: string }[] }, sign: typeof signedPutUrl): Promise<PlannedUpload[]>;
/** After the browser finishes: HEAD each object, record size and mime, produce SourceItems with bytes {kind:"gcs"}. */
export async function completeUploads(input: CollectInput): Promise<SourceItem[]>;
```

Every item carries `folder` (nearest parent folder from the relative path) and the
`parseShotName(baseName)` result; the identifier mode is applied later in `groupItems`, so a step 2
change never needs the files again. Relative paths are kept in `originalName`.

### Zip (`zip.ts`)

Library: `unzipper` `Open.custom(source)` where `source = { size: () => Promise<number>, stream:
(offset, length) => Readable }` (confirmed in current docs; builders re-confirm before coding). The
`Open` methods read only the central directory, never the whole archive; the result has `files[]`
with `path`, `type`, `uncompressedSize`, `compressedSize` and `stream()`. The GCS
`createRangeStream(gsUri, start, endInclusive)` (02) takes an inclusive end, so the source passes
`end = offset + length - 1`; a unit test with a fake reader asserts the exact byte count so the
off-by-one cannot slip in.

```ts
export const zipAdapter: Adapter;  // kind "zip"
```

Rules: walk nested folders; skip directories, `__MACOSX/`, dotfiles, zero-byte entries; nested zips
are rejected with "Nested zip files are not opened. Unzip <name> and upload its contents."; each entry
becomes a `SourceItem` with `bytes = {kind:"zip-entry"}` and `folder` from the entry path. The copy to
`raw/` happens in `runIngest`, streaming entry by entry; entries larger than 40 MB are rejected with
"<name> is larger than 40 MB and was skipped."

### Links sheet (`links-sheet.ts`)

```ts
export interface SheetTable { title: string; header: string[]; rows: string[][] }
export async function readSheetTable(buf: Buffer, name: string): Promise<SheetTable>;   // xlsx via ExcelJS workbook.xlsx.load + eachRow; csv via parseCsv
export interface ColumnDetection { headerRow: number; identifierColumn: number; identifierHeader: string | null; styleColumn: number | null; colourColumn: number | null; urlColumns: number[]; eanColumn: number | null; isProductList: boolean; cannotRead: string | null; sentence: string }
export function detectColumns(table: SheetTable): ColumnDetection;
export function normalizeHeader(h: string): string;   // lowercase, every character that is not a letter or digit removed
export const linksSheetAdapter: Adapter;  // kind "sheet"; honours options.sheetColumns when set
```

Column detection rules (deterministic, no guessing):
- Header row: the first row in which at least half the cells are non-empty text and at least two
  cells match a known heading; rows above it are ignored, so workbooks with a title row above the
  header parse without editing.
- Headers are compared after `normalizeHeader`, so `Color Code`, `color_code` and `COLORCODE` are
  the same heading.
- URL column = http(s) in at least half the non-empty cells, or header contains `url`, `link` or
  `image`.
- An EAN, barcode, GTIN or UPC column is never chosen as the identifier; it is recorded as
  `eanColumn` for SKU mapping only.
- Identifier column = the header matching `identifier`, `option` or `optionidstylecolor`; else, when
  the header has both a style column (`style`, `stylenumber`, `styleid`, `stylecode`, `styleno`) and
  a colour-code column (`colorcode`, `colourcode`, `colorid`, `colourid`), the identifier is the
  composite `<style>_<colour code>` (`styleColumn` and `colourColumn` set) and the step 2 sentence is
  `Grouped by style and colour code (<style header> + <colour header>)`; a colour-name column
  (`colourname`, `colorname`) is display only and never part of the key; else the first non-URL
  column whose non-empty values are at least 90% unique.
- When nothing matches, `identifierColumn = -1`, `cannotRead = "Could not tell which column holds the
  identifier."`, and the upload is marked `cannot read` in the file list; step 2 shows the picker
  and Continue stays disabled until a column is chosen.
- `isProductList` = no URL columns.

Reading rules: cells are split on `,` and `;` and trimmed; URL column order is shot order (first URL
column -> `n = 1`), and a cell with several URLs continues the numbering. Rows whose identifier is
empty are rejected with "Row <r> has no identifier." When the same normalised identifier appears on
more than one row, the first row is used, the later rows' URLs are not added, and step 4 warns
"<k> identifiers appear more than once in `<sheet>`; the first row of each is used." A URL that
fails to fetch or is not an image is reported as "Row <r>, column <header>: <url> did not return an
image (got <status or content-type>)." and the product keeps its other shots. Supabase public URLs
are plain https and need no special handling. Each item carries `sheetIdentifier` and
`bytes = {kind:"url"}`.

### Google Sheet and Drive folder (`google-sheet.ts`, `drive-folder.ts`)

googleapis calls (confirmed in current docs; builders re-confirm before coding):
`new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly",
"https://www.googleapis.com/auth/drive.readonly"] })`; `google.sheets({ version: "v4", auth })`;
`sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title,sheets.properties(sheetId,title)" })`;
`sheets.spreadsheets.values.get({ spreadsheetId, range: "<sheet title>" })` with `res.data.values`
as `string[][]`; `google.drive({ version: "v3", auth })`; `drive.files.list({ q: "'<folderId>' in
parents and trashed = false", fields: "nextPageToken, files(id, name, mimeType, size)", pageSize,
pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true })` looped on `nextPageToken`,
folders (`mimeType === "application/vnd.google-apps.folder"`) recursed; `drive.files.get({ fileId,
alt: "media" }, { responseType: "stream" })` with `res.data` piped to a GCS write stream.

```ts
export function parseSpreadsheetId(url: string): string | null;      // reads #gid= when present
export function parseFolderId(url: string): string | null;
/** Web tier: read the sheet as catalog-web@, write it as <uploads>/<uploadId>/<title>.csv, set detected. */
export async function collectGoogleSheetOnWeb(input: CollectInput): Promise<void>;
/** Web tier: list the folder as catalog-web@, stream every image into <uploads>/<uploadId>/<relative path>, set detected. */
export async function collectDriveFolderOnWeb(input: CollectInput): Promise<void>;
export const googleSheetAdapter: Adapter;   // kind "google_sheet": worker side, reads the csv written above like a links sheet
export const driveFolderAdapter: Adapter;   // kind "drive_folder": worker side, behaves like completeUploads over the streamed files
```

Which service account reads Google. The operator shares with one address only,
`catalog-web@image-links-agent.iam.gserviceaccount.com`. The wizard's access check runs on the web
tier as that account. The worker runs as `catalog-worker@`, which the operator never sees, and a
file shared with one service account is not readable by another. The decision for this spec is
therefore: the web tier performs the collection for Google Sheets and Drive folders too. 06's
`POST /api/catalog/batches/[id]/ingest` calls `collectGoogleSheetOnWeb` or `collectDriveFolderOnWeb`
for uploads of those kinds before enqueueing the worker task; the data lands under the batch's
`uploads/<uploadId>/` in our bucket and from there the worker treats it like a dropped sheet or a
dropped folder. Sheets reads are small. Drive folder downloads stream server-side from the web
container inside one request; the Cloud Run request limit of 900 s is a builder constraint, and the
builder sets `DRIVE_FOLDER_MAX_BYTES` (builder constant, from the summed `size` of the listing) above
which the collection stops before downloading and the step 2 Google access card says "This folder is
too large to read directly. Download it as a zip and drop it instead." (status `blocked`).

Open point for tier 3 (recorded in the report and in `docs/solutions/`): whether the organisation's
Drive sharing settings let `catalog-worker@` read what was shared only with `catalog-web@` (for
example through a shared drive or a Google group holding both addresses). If yes, the worker takes
over the collection in a later spec and the web tier keeps only the access check; if no, the rule
above stands.

### URL list (`url-list.ts`)

```ts
export function parseUrlList(text: string): { identifier: string | null; url: string }[];  // one per line; optional `identifier<TAB>url`
export const urlListAdapter: Adapter;  // kind "url_list"
```

Identifier = the pasted identifier, else `parseShotName(last path segment)`. Fetching uses
`safeFetch` with the 40 MB cap and manual redirects (GET only; Supabase is only ever read); a
non-image response is rejected with "<url> did not return an image (got <content-type>)."

### Product list (`product-list.ts`)

```ts
export interface ProductListRow { identifier: string; ean: string | null; raw: Record<string, string> }
export async function readProductList(buf: Buffer, name: string, columns?: { identifier: number; ean?: number }): Promise<ProductListRow[]>;
/** ok = in list and has images; missing_images = in list, no images; not_in_sheet = has images, not in list. */
export function linkStatuses(list: ProductListRow[], grouped: GroupingResult): Map<string, LinkStatus>;
```

The product list never creates `catalog_source_images`. For identifiers in the list with no images
it creates the product (through `findOrCreateProduct`, so a known alias lands on the existing row)
and a `catalog_batch_products` row with `link_status = missing_images`; grouped identifiers absent
from the list get `not_in_sheet`; everything else `ok`. Without a product list every grouped
identifier is `ok`. The EAN column, when present, is passed to `resolveSkus` as an extra key.

Matching rules, in order, all on `normalizeKey` values:
- Exact: the row's identifier equals the grouped identifier.
- Shape suffix: a row matches `ABC_rect` and `ABC_square` by its base identifier `ABC`. The row is
  `ok` when at least one shape has images; shapes the folder does not contain are not reported
  missing. The two shapes are two sheet rows that share the row's SKU ids.
- Size-level keys: when the list's key is size-level (`<style>/<size>/<unit>`, `<style>-<size>`, or
  several rows share a prefix that equals an uploaded identifier), matching removes the trailing size
  segment (the part after the first `/`, or the last `_` or `-` segment) the way 02's `product_code`
  rule does. Step 4 says "<k> size rows matched <m> products." Every per-size `opptra_sku_id` found
  on those rows goes into `opptra_sku_ids`.
- Token containment: when the list has a composite style+colour key and no file stem equals it, a
  stem matches when both tokens appear as whole `_`-separated segments of it, in either order. The
  sheet key becomes the product identifier and `path_key`, and `groupedBy` becomes `Matched by style
  and colour code found inside the file names`.
- Match column: a product list column whose values equal file stems with or without a trailing
  `_<n>` may be chosen as the match column (step 2 picker); the match strips the trailing `_<n>`.

The product list upload is kept verbatim under `uploads/`; its `catalog_uploads.detected` records
`matchColumn` and `sheetNames` so finalize (06) can write the filled copy of the workbook
(`<original-stem>-filled-v<k>.xlsx`, defined in 02's `fillProductListWorkbook`).

### Grouping (`group.ts`)

```ts
export function groupItems(items: SourceItem[], options: BatchOptions): GroupingResult;
export function previewRows(grouped: GroupingResult, skus: Map<string, string[]>, firstShotThumb: (item: SourceItem) => string | null, limit: number): PreviewRow[];
export function warningSentences(grouped: GroupingResult, list: ProductListRow[] | null, channels: ChannelId[]): { headline: string; detail: string }[];
```

Identifier per mode:
- `filename`: `parseShotName(baseName)`; a purely numeric stem (`1.jpg`, `02.jpg`) uses the parent
  folder name as the identifier and the number as `n` even in this mode, because such files carry
  no identifier of their own.
- `folder`: identifier = `item.folder`; `n` = the number read from the file name when present, else
  the position in the folder's name-sorted file list.
- `sheet_column`: identifier = `item.sheetIdentifier`; items from files are grouped by file name
  rules and matched to sheet rows by `normalizeKey`.
- In every mode a parent or grandparent folder whose lowercase name starts with `rect` adds `_rect`
  and one that starts with `sq` adds `_square` to the identifier (`suffix` from `parseShotName` when
  it is in the name).

Order and duplicates: the shot number read from the name has at most three digits (02); items are
sorted by that number and renumbered to positions 1..k, so paths and the sheet never have a blank
cell for a gap; a gap gives flag `numbering_gap` and the note "Shot numbers <list> are missing in
the upload; images shifted left in this row." The order files arrived in, and their order in a zip
or folder listing, never affects shot order. A product whose single file carries no shot number
gets `n = 1` without a warning; with several unnumbered files the product is rejected with "Files
for <identifier> have no shot numbers: <names>. Rename them `<identifier>_1.jpg`,
`<identifier>_2.jpg`."; an unnumbered file in a product that also has numbered files gets the next
free position and the warning "Shot number missing on <name>; placed last." A duplicate
`(identifier, n)` across the two kinds is resolved by `options.precedence` (`uploads_then_links`:
uploaded bytes `gcs` and `zip-entry` win and `url` items fill the gaps; `links_only`: `url` items
only; `uploads_only`: uploaded bytes only); a duplicate inside the same precedence class rejects the
whole product with "Two files claim shot <n> of <identifier>: <a>, <b>. Rename one and re-upload."
(the product is listed in the report, nothing else is affected).

Step 4 warning sentences (headline in bold, detail after it), exactly:
- `<k> products have no photos.` + `They are in your product list but no files matched: <ids>. They
  will appear in the sheet as "missing images".`
- `<k> products have photos but are not in your product list: <ids>. They will appear in the sheet
  as not in sheet.`
- `<k> files could not be read.` + `<names>: <reason>. Fix them and use them in a new batch, or
  continue without them.` (BMP, corrupt and non-image files with their reject reasons; HEIC files
  are never listed here)
- `<k> photos are smaller than Styli needs (under <px> px).` + `Styli will skip them and note it in
  the sheet, as agreed with Styli.` where `<px>` is `STYLI_MIN_SOURCE_HEIGHT_PX` from 02 (1482) and a
  photo counts when its height is below it; shown only when `styli` is among the batch's channels.
  This is the wizard's estimate; 05's bbox rule decides which Styli outputs are `skipped`.
- `<k> products have two files for the same shot number: <ids>. They are left out until one file is
  renamed; see the grouping table.` (the grouping table row carries the per-product sentence above)
- `Your upload has <k> top-level folders (<names>). Everything in them will be filed under <brand>.
  If these are different brands, make one batch per brand.` (whenever more than one top-level folder
  contains images; `topLevelFolders` from `Detected`)
- `<k> identifiers appear more than once in <sheet>; the first row of each is used.`
- `<k> size rows matched <m> products.`

There is no SKU warning and no SKU KPI.

### Image check (`image-check.ts`)

```ts
export interface ImageInfo { mime: string; ext: string; width: number; height: number; hasAlpha: boolean; pages: number; orientation: number | null; space: string; ok: true }
export type ImageCheck = ImageInfo | { ok: false; reason: "unsupported" | "corrupt" | "not_image"; message: string };
export async function checkImage(head: Buffer, fullOrNull: Buffer | null, name: string): Promise<ImageCheck>;
```

Sniff with `file-type`. HEIC/HEIF -> a normal image with `mime = image/heic`, `ext = heic`; width and
height are read from the file's own metadata (the `ispe` box the sniffer exposes; the builder adds a
small reader) and, when that fails, left null until 05's `prepare()` converts the file through
`catalog-matting`'s `POST /convert` and fills them. BMP -> `unsupported` with "<name> is a BMP file.
Save it as JPEG or PNG and add it again."; PDF, docx and the like -> `not_image` with "<name> is not
an image."; every other image (jpeg, png, webp, tiff, gif, avif) is probed with `sharp(buf, { pages:
1, failOn: "warning" }).metadata()` (`width`, `height`, `hasAlpha`, `pages`, `orientation`, `space`
are documented fields; confirmed in current docs); a decode error -> `corrupt` with "<name> is
corrupt (cannot be decoded)." Images under 500 px on the long side (`MIN_SOURCE_LONG_SIDE_PX`, 02)
get the `small_source` flag on their version row; 05 turns it into an attention item.

### Product matching and the overwrite preview (`overwrite-preview.ts`)

```ts
export interface ProductMatch { identifier: string; productId: string | null; pathKey: string; isNew: boolean; matchedBy: "alias" | "option_key" | null }
/** Dry run of findOrCreateProduct (02): alias hit -> existing; resolveSkus option_key alias hit -> existing; else new (productId null). Never writes. */
export async function matchProducts(db: Db, batch: CatalogBatch, identifiers: string[]): Promise<ProductMatch[]>;
export async function buildOverwritePreview(db: Db, batch: CatalogBatch, grouped: GroupingResult, matches: ProductMatch[], sha256ByItem: Map<SourceItem, string>): Promise<OverwritePreview>;
```

- `newProducts`: matches with `isNew`.
- `existingProducts`: for each existing match, `liveShots` = the distinct `n` of `catalog_outputs`
  rows with `is_live` for that product on the batch's channels; `uploadShots` = the `n` in this
  upload; `shotsToRemove` = live shots not in the upload; `channels` = the batch's channels. 06
  renders this as "<n> products are new", "<m> products already exist and will be overwritten
  (<list>)" and per product "ABC123: 5 photos live, 3 in this upload; _4 and _5 will be removed".
- `renameHints`: a new identifier whose sha256 set equals the sha256 set of an existing product's
  current versions in the same brand; 06 shows "NEW-ID has the same photos as ABC123. If this is a
  rename, add an alias on the product page instead of uploading." A hint, not a block.
- `duplicates`: two grouped identifiers of this batch that map to the same product (two spellings);
  both are rejected from the grouping and 06 shows "ABC-123 and ABC123 are the same product. Keep one."
- `busy`: existing products whose `lock_batch_id` is set to another unfinished batch, with that
  batch's name; 06 refuses Start with "ABC123 and 4 others are still being processed in batch
  <name>. Wait for it to finish or remove them from this upload."

### Ingest run (`ingest/index.ts` and `apps/worker/src/catalog/ingest.ts`)

```ts
export const ADAPTERS: Record<UploadKind, Adapter>;    // image uses completeUploads; google kinds read what the web tier wrote
export async function collect(input: CollectInput): Promise<SourceItem[]>;
export interface IngestProgress { done: number; total: number | null; phase: "listing" | "copying" | "grouping" | "done" }
export const INGEST_BUDGET_ITEMS: number;              // builder constant: items copied per task call, chosen to finish well inside 900 s
/** Idempotent: an item whose raw object already exists with the same sha256 is skipped. Processes at most INGEST_BUDGET_ITEMS items per call and re-enqueues itself with the same body plus a cursor while work remains. */
export async function runIngest(db: Db, deps: IngestDeps & { enqueue: typeof enqueueTask }, body: { batchId: string; uploadId: string; cursor?: string }): Promise<{ progress: IngestProgress; outcome: string }>;
export async function buildPreview(db: Db, batchId: string, deps: Pick<IngestDeps, "storage">): Promise<Preview>;
```

Per upload (one task per `catalog_uploads` row; 06 enqueues one per upload with status `uploaded`):
1. `collect` lists the upload's items. Each item's bytes are streamed to
   `rawPath(prefix, sanitizeSegment(identifier), n, sniffedExt)` while a `sha256` is computed;
   `checkImage` runs on the head and, for the dimensions, on the full bytes (HEIC dimensions from the
   container metadata; no conversion at ingest). The original name is kept for
   `catalog_source_images.original_name`. Rejects are appended to `catalog_uploads.detected.rejected`;
   `detected.formats` and `detected.topLevelFolders` are filled. Progress is written to `catalog_batches.counts.collected` and
   `counts.collectTotal` after every call so the batch list can show "Collecting files 48 of 310".
2. When the budget is spent, the task enqueues itself (`enqueueTask("/tasks/catalog/ingest", { batchId,
   uploadId, cursor })`) and returns 200. A repeated call with the same cursor is a no-op for items
   already in `raw/` with the same `sha256` (`headObject` plus the version row by `raw_uri`).
3. When the upload is done it is marked `collected` (or `failed` with `error` when nothing could be
   read).

Batch-wide step, run once by the task that finds every upload of the batch `collected` or `failed`:
1. `groupItems` over all items of the batch with `options.identifierMode` and `options.precedence`
   (so precedence across uploads works), then the product list and `linkStatuses`.
2. `matchProducts`, then `resolveSkus` for every identifier (02), then `findOrCreateProduct` for
   every grouped identifier and every product-list identifier. New `catalog_products` rows get
   `path_key = sanitizeSegment(identifier)`, `product_type` = the batch's `product_type` (07
   refines it per product later), their first alias, and `sku_method`, `option_id_style_color`,
   `opptra_sku_ids` from `resolveSkus`. Existing rows are not changed here (06 updates `identifier`
   to the latest spelling and `last_batch_id` when the batch starts).
3. `catalog_batch_products` rows for every product of the batch with `link_status`.
4. `catalog_source_images`: one new version row per `(product, n)` with `batch_id` (brought by),
   `sha256`, `raw_uri`, `original_name`, `upload_id`, `mime`, `width`, `height`, `bytes`, `flags`,
   `status = prepared` (or `unsupported`), `is_current = false`, `replaces_id` = the current row of
   that `(product, n)` or null. Nothing about the current version changes at ingest: the new row
   becomes current only when the product goes live in 06's publish step, which then sets
   `is_current = false` and `superseded_at` on the old row and `setCustomTime(old.raw_uri, now)` so
   the 180-day raw lifecycle (02) starts for it. A source whose `sha256` equals the current version
   at the same `n` still gets its own row for this batch (the publish step marks the pair
   `unchanged` by `render_key`). A draft that is abandoned or re-grouped therefore leaves every
   product exactly as it was; Start refuses busy products anyway (06).
5. `buildOverwritePreview`; counts `products`, `sources`, `skuResolved`, `missingImages`,
   `notInSheet`, `unsupportedFiles`, `duplicateFiles`, `newProducts`, `existingProducts`,
   `shotsToRemove`; then `counts.previewReady = true` and the batch status back to `draft` so the
   wizard can show step 2 and step 4.
6. Zero images in the whole batch -> status `failed` with `counts.failReason` = "No photos were found
   in what you uploaded. <what was found>. Upload photos and start again." where `<what was found>`
   is built from the formats and rejects (for example "1 BMP file and 1 PDF").

Re-run after a step 2 change (`identifierMode`, `precedence`, `sheetColumns`, or an upload marked as
a product list): 06 calls `POST /api/catalog/batches/[id]/ingest` again while the batch is `draft`.
Nothing is downloaded again: items whose bytes are already in our bucket (`uploads/` or `raw/` of this
batch) are copied server-side to their new `raw/` path when the identifier changed, and the
batch-wide step runs again. Before it does, the batch's own `catalog_source_images` (all not
current) and `catalog_batch_products` rows are removed; no other product state was touched, so
nothing needs restoring and no `customTime` is ever set during a draft.

`buildPreview` is computed on request from `catalog_batch_products`, `catalog_source_images`,
`catalog_uploads.detected` and `buildOverwritePreview`: `kpis.products` = batch products with
images (products are counted as identifiers, never as files), `kpis.photos` = current source rows of
the batch, `kpis.channels` = the batch's channels, `kpis.outputs = photos x channels`; `rows` = the
first `limit` preview rows, each with its `files` list in shot order so 06 can expand a row to the
file names with shot number and size (06 shows "Showing 6 of 412"); `warnings` from
`warningSentences`.

Worker handler `handleIngestTask(deps, body)` wraps `runIngest`, returns `{ httpStatus: 200, outcome
}` on progress or completion, 500 on an unexpected error so Cloud Tasks retries (5 attempts, queue
`TASKS_QUEUE`, default `catalog`, from 02). It is registered on `/tasks/catalog/ingest` in the route
table 02 created in `apps/worker/src/server.ts`, behind the OIDC check from `auth.ts`.

### CLI (`apps/worker/src/catalog-local.ts`)

```
node dist/catalog-local.js collect --brand <slug> --from <folder|file.zip|links.xlsx|links.csv|urls.txt|https://docs.google.com/...> [--product-list <xlsx|csv>] [--identifier-mode filename|folder|sheet_column] --out <dir>
```

Runs the same adapters with a filesystem-backed `IngestDeps` (no GCS, no DB; `matchProducts` and
the overwrite preview are skipped), writes `<out>/manifest.json` (`{ brand, identifierMode, products:
[{ identifier, skus, shots: [{ n, path, sha256, width, height, flags }] }], rejected, warnings }`)
and prints the step 4 warning sentences. 05 adds the `render` mode and reads this manifest. The other
CLIs (`catalog-smoke` in 06, `catalog-eval` in 08, `catalog-load` and `catalog-recheck` in 09) are
separate esbuild entries in `apps/worker/src/` built the same way. `build.mjs` gets the
`catalog-local` entry.

## Build order and workstreams

Workstream A "files-and-zip" (worktree `catalog-module-wt/04-files-and-zip`): `types.ts`,
`detect.ts`, `detect-step.ts`, `image-check.ts`, `local-files.ts`, `zip.ts`, `group.ts`.

Workstream B "sheets-and-links" (worktree `catalog-module-wt/04-sheets-and-links`):
`links-sheet.ts`, `google-sheet.ts`, `drive-folder.ts`, `url-list.ts`, `product-list.ts`. Starts
from A's `types.ts` copied verbatim (integration keeps one copy).

Workstream C "runner-preview-cli" (worktree `catalog-module-wt/04-runner-preview-cli`):
`overwrite-preview.ts`, `ingest/index.ts`, `apps/worker/src/catalog/ingest.ts`, `server.ts` route,
`catalog-local.ts`, `build.mjs`. Uses fakes for adapters until integration.

Integration: merge A, B, C; wire `ADAPTERS`; run tiers 1 to 3.

## Test plan

Tier 1 (unit, fixtures under `packages/core/test-fixtures/catalog/`):
- `naming.parseShotName` (02's function, exercised here): `ABC123_1.jpg`, `ABC123-1.jpg`,
  `ABC123_01.jpg` all give `ABC123` and `n = 1` in one test; `ABC-123_2.jpg` keeps the hyphen in the
  identifier; `ABC123_rect_3.jpg` gives suffix `_rect`; the three-digit cap:
  `ONLY-SHOES_Autumnwinter_5079628_15380145.jpg` and `IMG_2041.heic` keep the long number in the
  identifier and get `n = null` (then position 1).
- `detect.ts`: zip vs xlsx vs csv vs image by bytes; pasted sheet URL, folder URL, URL list, junk; the
  five access-check sentences with fakes (readable sheet, 403 sheet, 403 folder, domain-policy 403,
  URL list).
- `detect-step.ts`: files only -> `filename` detected, precedence hidden, `sheetColumns` null; files
  plus sheet -> precedence shown; numeric stems -> `folder`; the formats sentence with and without
  PNG and HEIC (`converted automatically`); the sheet columns sentence `We will use column B (Vendor
  Style Number) as the identifier and columns H to M (Product Image 1 to 6) as photos.` from a
  fixture with those headers; `sheets[]` entries and the five `groupedBy` lines; a sheet with
  `identifierColumn -1` carries `cannotRead`.
- `links-sheet.detectColumns`: header normalisation (`Color Code` / `color_code` / `COLORCODE`);
  an EAN column present but never chosen; composite style+colour key detection with its sentence and
  a colour-name column ignored; header-row discovery under a title row; refusal with
  `identifierColumn -1` when no header matches and no column is 90% unique; duplicate identifier rows
  (first row used, later URLs not added, the warning sentence); a row-named URL failure sentence.
- `image-check.ts`: sharp-generated jpeg, png with alpha, webp, tiff, avif, 2-frame gif (pages > 1),
  a small HEIC fixture -> `image/heic` with dimensions and no reject, a BMP -> unsupported with its
  sentence, a truncated jpeg -> corrupt, a PDF -> not_image, a 400 px image -> `small_source`.
- `zip.ts`: a zip built in the test with nested folders, `__MACOSX/._x.jpg`, `.DS_Store`, a nested
  zip, a 0-byte file; a fake range reader counts bytes served and asserts the inclusive-end maths;
  entries listed with correct sizes and `folder`.
- `links-sheet.ts`: xlsx and csv fixtures: header-named URL columns, unnamed URL columns detected by
  content, cells with `,`/`;`, an identifier column named `Option ID`, a product list with no URLs
  (`isProductList` true), a sheet with Supabase URLs, `options.sheetColumns` overriding detection.
- `google-sheet.ts`, `drive-folder.ts`: fakes returning `values`, paginated `files.list`, 403 and
  domain-policy errors -> the exact sentences; `DRIVE_FOLDER_MAX_BYTES` exceeded -> `blocked` with the
  too-large sentence and no download call.
- `url-list.ts`: plain lines, `identifier<TAB>url`, blank lines, a non-image response rejected with
  its sentence; the fake fetch records that every request was GET.
- `product-list.ts`: `linkStatuses` yields ok / missing_images / not_in_sheet with normalised keys;
  `_rect`/`_square` base matching (one shape present -> `ok`, the absent shape not reported);
  size-level matching on ANTA-style `<style>/<size>/EA` rows (the per-size SKU ids collected, the
  "<k> size rows matched <m> products." sentence); token-containment matching of a composite key
  inside file stems in either order with the key becoming the identifier; the match-column stem rule
  with a trailing `_<n>` stripped; `detected.matchColumn` and `sheetNames` recorded.
- `group.ts`: the three identifier modes on one fixture tree; numeric stems with folder identifiers
  in `filename` mode; `_rect`/`_square` from `Rectangle/`, `rect/`, `Square/`, `sq/` folders;
  duplicate across kinds resolved by each of the three precedences; duplicate within one kind rejects
  the product with the exact sentence; gaps renumbered to positions with the `numbering_gap` note;
  a shuffled input order gives the same output order; one unnumbered file -> `n = 1`; several
  unnumbered files -> rejected with the sentence; missing `n` beside numbered files placed last with
  its sentence; a HEIC fixture grouped as a normal image; preview rows with the four statuses and
  their `files` lists; every warning pair with correct counts, the Styli pair absent when `styli` is
  not a channel, and the multi-folder warning when two top-level folders hold images.

Tier 2 (PGlite + fake storage, `packages/core/src/catalog/ingest/ingest.test.ts`):
- `runIngest` over a fake bucket with 60 items and `INGEST_BUDGET_ITEMS` 25: three calls, the second
  and third enqueued by the first with a cursor; re-running the first call is a no-op (idempotent by
  `raw_uri` and `sha256`); one corrupt item does not stop the others; counts and statuses correct; a
  product list adds `missing_images` rows and `not_in_sheet`; `failed` batch with the `failReason`
  sentence when zero images.
- Re-upload of a known product: a second batch for the same brand uploads `ABC123_1..3` again with
  shot 2 changed; the result is new version rows with `is_current = false`, `replaces_id` set, the
  previous rows still current and untouched, and the fake storage records no `setCustomTime` call
  (06 tests the switch at publish).
- A step 2 re-run (`identifierMode` changed from `filename` to `folder`) removes the batch's own
  rows, leaves every other product's rows untouched, copies bytes server-side and downloads
  nothing (the fake fetch counts zero calls).
- Overwrite preview cases (09 section 5): fewer shots -> `shotsToRemove` lists the missing `n`; more
  shots -> `shotsToRemove` empty; reorder (same sha256 set, different `n`) -> no removal, no hint;
  rename (new identifier, same sha256 set) -> one `renameHints` entry; the same product under two
  spellings in one batch -> one `duplicates` entry and both rejected; a product locked by another
  batch -> one `busy` entry with that batch's name; channels not selected in the batch do not count
  towards `liveShots`.

Tier 3 (`REAL_DATA=1 pnpm test:real`, `packages/core/src/catalog/ingest/ingest.real.test.ts`; each
case copies into `gs://image-links-agent-assets/catalog-test/<run-id>/`, uses a PGlite db with the
real storage client, and deletes that prefix in `finally` with `deleteTestObjects`):
- Anta zip: the test zips `C:\Users\Sujan AH\Desktop\opptra-image-links\new_resources_4\Images`
  (630 footwear images, 800x800) into the run prefix, runs the zip adapter and `runIngest`; asserts
  630 source images, zero rejects, every raw object exists with `image/jpeg` and a 64-hex `sha256`.
- French Connection folder: `new_resources_3\French Connection Final` (3,280 images, 800x1200)
  through the local-files path (the test uploads with `uploadBuffer` in place of the browser PUT);
  asserts 3,280 source images and that the grouping yields products with the expected shot counts
  (every product has at least one shot; no duplicate rejections); then the same set again as a second
  batch and asserts every product is matched as existing with `shotsToRemove` empty.
- Pasted Supabase link list: the first 20 URLs from one `new_resources_3/*.xlsx` delivery sheet are
  fetched with `safeFetch`; asserts 20 raw objects, identifiers from the URL stems, and that no
  request was anything but GET (Supabase is only read).
- Shared Google Sheet: env `REAL_GSHEET_URL` points at a sheet the tester created from one of the
  delivery xlsx files and shared with `catalog-web@image-links-agent.iam.gserviceaccount.com` as
  Viewer; `collectGoogleSheetOnWeb` reads it with ADC and the result equals the links-sheet adapter's
  result on the same xlsx. A second step tries the same read with `catalog-worker@` credentials and
  records the outcome (the open point above) in the test log. Skips with a clear message when the env
  var is unset.
- CLI: `node dist/catalog-local.js collect --brand anta --from <Images folder> --out <tmp>` writes a
  manifest with 630 shots and `identifierMode: "filename"`.

Tiers 4 and 5 are not required by this spec.

## Done criteria

- Every adapter in the table exists behind `Adapter.collect` and is dispatched by `ADAPTERS`; the two
  Google kinds have their web-tier collection functions.
- `checkLinkAccess` returns the five prototype sentences; `buildDetectedStep2` returns the step 2
  cards' data with the exact sentences, including `sheets[]` for the real sheet controls and
  `groupedBy`; a sheet whose identifier column cannot be told is refused, never guessed.
- `groupItems` handles the three identifier modes and three precedences; `parseShotName` accepts
  `_<n>`, `-<n>` and `_0<n>` without an option and caps shot numbers at three digits; shots are
  positions; input order never changes the result.
- HEIC files are ingested as normal images; BMP and undecodable files are listed with their sentences.
- Product lists match by base identifier for `_rect`/`_square`, by size-level keys and by token
  containment, and the upload is kept verbatim with `matchColumn` recorded for 06's filled copy.
- Products are matched through aliases, new rows get a fixed `path_key`, source images are versioned
  as not-current rows that 06 switches at publish; no draft ever changes a current version or sets
  `customTime`.
- `buildOverwritePreview` covers new, existing, shots to remove, rename hint, duplicate spellings and
  busy products; the preview has no SKU KPI and no SKU warning.
- Tier 1 and 2 green in CI; tier 3 green on the integrator's machine with cleanup confirmed (the test
  logs `deleted <n> objects under catalog-test/<run-id>/` and a final `listObjects` is empty).
- `handleIngestTask` registered on `/tasks/catalog/ingest`; the deployed worker's `/healthz` lists it.
- The CLI collect mode works on a folder, a zip and a links xlsx.
- `pnpm lint && pnpm typecheck && pnpm test` green; CI green.

## Merge, deploy, report

Follow `00-execution-protocol.md`. This spec deploys the worker (new route) with `infra/deploy.sh`.
The report lists the per-adapter test counts, the tier 3 numbers (630, 3,280, 20, the sheet row
count), the recorded answer to the Google-share question (can `catalog-worker@` read what was
shared with `catalog-web@`; where the web tier keeps collecting or the worker can take over), and
the `docs/solutions/` entry written for it. Report ends with "Ready for the next spec: 05 Matting and
render".
