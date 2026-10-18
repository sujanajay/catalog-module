// Shared contracts for ingestion (spec 04). Every adapter, the grouping, the step 2 and step 4 data
// and the ingest runner use these; nothing here is redefined elsewhere.
import type { Readable } from "node:stream";
import type { CatalogUpload } from "../../db/schema";
import type { BatchOptions, ChannelId, IdentifierMode, Precedence, UploadKind } from "../types";

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

/** The subset of the googleapis Sheets v4 client that ingestion calls (real client or a fake). */
export interface SheetsLike {
  spreadsheets: {
    get(params: { spreadsheetId: string; fields?: string }): Promise<{
      data: { properties?: { title?: string | null } | null; sheets?: { properties?: { sheetId?: number | null; title?: string | null } | null }[] | null };
    }>;
    values: {
      get(params: { spreadsheetId: string; range: string }): Promise<{ data: { values?: unknown[][] | null } }>;
    };
  };
}

/** The subset of the googleapis Drive v3 client that ingestion calls (real client or a fake). */
export interface DriveLike {
  files: {
    list(params: {
      q: string; fields: string; pageSize?: number; pageToken?: string;
      supportsAllDrives?: boolean; includeItemsFromAllDrives?: boolean;
    }): Promise<{
      data: { nextPageToken?: string | null; files?: { id?: string | null; name?: string | null; mimeType?: string | null; size?: string | null }[] | null };
    }>;
    get(params: { fileId: string; alt: "media"; supportsAllDrives?: boolean }, options: { responseType: "stream" }): Promise<{ data: Readable }>;
  };
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
