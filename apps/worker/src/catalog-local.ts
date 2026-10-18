// catalog-local CLI (spec 04 "CLI"; esbuild entry "catalog-local"). Collect mode only in this spec:
//
//   node dist/catalog-local.js collect --brand <slug> --from <folder|file.zip|links.xlsx|links.csv|urls.txt|https://docs.google.com/...>
//     [--product-list <xlsx|csv>] [--identifier-mode filename|folder|sheet_column] --out <dir>
//
// Runs the same adapters, reading and grouping as the worker's ingest with a filesystem-backed
// IngestDeps: no GCS and no database (matchProducts and the overwrite preview are skipped). Every
// shot is written to <out>/<brand>/raw/<path_key>/<path_key>_<n>.<ext>, <out>/manifest.json lists
// them for 05's render mode, and the step 4 warning sentences are printed. Pasted links are fetched
// with safeFetch (GET only); a Google Sheet or Drive folder is read with Application Default
// Credentials.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { collectDriveFolderOnWeb } from "@catalog/core/catalog/ingest/drive-folder";
import { collectGoogleSheetOnWeb, googleClients } from "@catalog/core/catalog/ingest/google-sheet";
import { collectOffline } from "@catalog/core/catalog/ingest/index";
import type { Detected, IngestDeps } from "@catalog/core/catalog/ingest/types";
import { assertTestPrefix, brandSlug } from "@catalog/core/catalog/naming";
import { CHANNEL_IDS, IDENTIFIER_MODES, PRODUCT_TYPES, type ChannelId, type ProductType, type IdentifierMode, type UploadKind } from "@catalog/core/catalog/types";
import { channel } from "@catalog/core/catalog/channels";
import { MattingClient, matteFor } from "@catalog/core/catalog/matte";
import { bbox, planProduct, prepare, renderSource, UnsupportedSourceError, type Matte, type Prepared, type RenderOutput } from "@catalog/core/catalog/render";
import { contactSheet } from "@catalog/core/catalog/contact-sheet";
import type { CatalogUpload } from "@catalog/core/db/schema";
import { pinnedFetch } from "@catalog/core/safe-url";
import { getBucketName, mimeFromPath, parseGsUri, uploadBuffer } from "@catalog/core/storage";

const USAGE =
  "Usage: node dist/catalog-local.js collect --brand <slug> --from <folder|file.zip|links.xlsx|links.csv|urls.txt|Google Sheet or Drive folder link> " +
  "[--product-list <xlsx|csv>] [--identifier-mode filename|folder|sheet_column] --out <dir>";

/** The bucket name the CLI's storage writes to (`<out>`); the other names are read-only mounts. */
export const OUT_BUCKET = "out";

/**
 * IngestDeps.storage over local folders: `gs://<mount>/<path>` is `<mounts[mount]>/<path>`.
 * uploadBuffer writes under the OUT_BUCKET mount; setCustomTime does nothing.
 */
export function localStorage(mounts: Record<string, string>): IngestDeps["storage"] {
  const fileOf = (gsUri: string) => {
    const { bucket, path: p } = parseGsUri(gsUri);
    const root = mounts[bucket];
    if (!root) throw new Error(`No local folder for ${gsUri}.`);
    return path.join(root, ...p.split("/").filter(Boolean));
  };
  const walk = async (dir: string, rel: string, out: string[]) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r, out);
      else if (e.isFile()) out.push(r);
    }
  };
  return {
    uploadBuffer: async (objectPath, buf) => {
      const gsUri = `gs://${OUT_BUCKET}/${objectPath.replace(/^\/+/, "")}`;
      const file = fileOf(gsUri);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, buf);
      return gsUri;
    },
    downloadBuffer: async (gsUri) => {
      try {
        return { buf: await readFile(fileOf(gsUri)), mime: mimeFromPath(gsUri) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw Object.assign(new Error(`${gsUri} not found`), { code: 404 });
        throw err;
      }
    },
    headObject: async (gsUri) => {
      const s = await stat(fileOf(gsUri)).catch(() => null);
      if (!s?.isFile()) return { exists: false, size: null, contentType: null, generation: null, crc32c: null };
      return { exists: true, size: s.size, contentType: mimeFromPath(gsUri), generation: null, crc32c: null };
    },
    readRange: async (gsUri, start, endInclusive) => {
      const fh = await open(fileOf(gsUri), "r");
      try {
        const buf = Buffer.alloc(endInclusive - start + 1);
        const { bytesRead } = await fh.read(buf, 0, buf.length, start);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
    // fs read streams take an inclusive end, as GCS ranges do.
    createRangeStream: (gsUri, start, endInclusive) => createReadStream(fileOf(gsUri), { start, end: endInclusive }),
    listObjects: async (gsPrefixUri) => {
      const { bucket, path: prefix } = parseGsUri(gsPrefixUri);
      const root = mounts[bucket];
      if (!root) return [];
      // Walk only the folder the prefix names, not the whole mount.
      const dir = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : "";
      const files: string[] = [];
      await walk(path.join(root, ...dir.split("/").filter(Boolean)), dir, files);
      return files.filter((f) => f.startsWith(prefix)).sort().map((f) => `gs://${bucket}/${f}`);
    },
    setCustomTime: async () => undefined,
  };
}

/** The CLI's IngestDeps: local storage and 02's DNS-pinned fetch, as the worker uses for pasted links. */
export function localIngestDeps(storage: IngestDeps["storage"]): IngestDeps {
  return { storage, fetch: pinnedFetch };
}

function uploadRow(kind: UploadKind, name: string, gcsUri: string | null, sourceUrl: string | null = null): CatalogUpload {
  return {
    id: randomUUID(), batchId: "local", kind, name, relativePath: null, gcsUri, sourceUrl, sizeBytes: null, mime: null,
    status: "uploaded", detected: null, error: null, createdAt: new Date(),
  };
}

export interface CollectArgs { brand: string; from: string; productList?: string; identifierMode: IdentifierMode; out: string }

/** Writes the shots and <out>/manifest.json; returns the manifest. */
export async function collectToManifest(args: CollectArgs, log: (line: string) => void = (l) => console.error(l)) {
  const out = path.resolve(args.out);
  const brand = brandSlug(args.brand);
  const mounts: Record<string, string> = { [OUT_BUCKET]: out };
  const storage = localStorage(mounts);
  // index.ts names our own objects by BUCKET; here that is the output folder.
  process.env.BUCKET = OUT_BUCKET;
  const deps = localIngestDeps(storage);
  const prefix = brand;
  const options = { identifierMode: args.identifierMode, precedence: "uploads_then_links" as const, sheetColumns: null };
  const uploads: CatalogUpload[] = [];

  const from = args.from;
  if (/^https?:\/\//i.test(from)) {
    const google = await googleClients();
    const kind: UploadKind = /docs\.google\.com\/spreadsheets/i.test(from) ? "google_sheet" : "drive_folder";
    const upload = uploadRow(kind, from, null, from);
    const input = { batchId: "local", brandSlug: brand, prefix, upload, options, deps: { ...deps, ...google } };
    const result = kind === "google_sheet" ? await collectGoogleSheetOnWeb(input) : await collectDriveFolderOnWeb(input);
    if ("error" in result) throw new Error(result.error);
    upload.detected = result as unknown as Record<string, unknown>;
    uploads.push(upload);
  } else {
    const abs = path.resolve(from);
    const s = await stat(abs).catch(() => null);
    if (!s) throw new Error(`${from} does not exist.`);
    // The parent folder is the mount, so a folder upload's gs:// prefix names the folder itself.
    mounts.src = path.dirname(abs);
    if (s.isDirectory()) {
      uploads.push(uploadRow("image", path.basename(abs), `gs://src/${path.basename(abs)}/`));
    } else {
      const name = path.basename(abs);
      const kind: UploadKind | null = /\.zip$/i.test(name) ? "zip" : /\.(xlsx|xlsm|csv)$/i.test(name) ? "sheet" : /\.txt$/i.test(name) ? "url_list" : null;
      if (!kind) throw new Error(`${name} is not a folder, a zip, a links sheet (xlsx or csv) or a list of links (txt).`);
      uploads.push(uploadRow(kind, name, `gs://src/${name}`));
    }
  }
  if (args.productList) {
    const abs = path.resolve(args.productList);
    mounts.plist = path.dirname(abs);
    uploads.push(uploadRow("product_list", path.basename(abs), `gs://plist/${path.basename(abs)}`));
  }

  let shown = 0;
  const result = await collectOffline({
    brandName: args.brand, prefix, uploads, options, deps,
    onProgress: (done, total) => {
      if (done === total || done - shown >= 100) {
        shown = done;
        log(`Collecting files ${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}`);
      }
    },
  });
  const localPath = (gsUri: string) => path.join(out, ...parseGsUri(gsUri).path.split("/"));
  const manifest = {
    brand,
    identifierMode: args.identifierMode,
    products: result.products.map((p) => ({
      identifier: p.identifier, skus: p.skus,
      shots: p.shots.map((s) => ({ n: s.n, path: localPath(s.uri), sha256: s.sha256, width: s.width, height: s.height, flags: s.flags })),
    })),
    rejected: result.rejected,
    warnings: result.warnings,
  };
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { manifest, missing: result.missing, detected: uploads.map((u) => u.detected as Detected | null) };
}

export interface RenderArgs {
  manifest: string; channels: ChannelId[]; out: string; matting?: string; mattingGpu?: string;
  model?: string; productType?: ProductType; limit?: number; upload?: string;
}
type Manifest = Awaited<ReturnType<typeof collectToManifest>>["manifest"];
type ReportOutput = Omit<RenderOutput, "jpeg"> & {
  identifier: string; n: number; channel: ChannelId; path?: string; uploaded?: string;
  matte: Pick<Matte, "model" | "target" | "sentLongSide" | "ms"> | null;
};

/** Fail closed before rendering or touching storage. uploadBuffer always uses BUCKET. */
export function validateRenderUpload(uri: string): string {
  const { bucket, path: prefix } = parseGsUri(uri);
  assertTestPrefix(prefix);
  if (bucket !== "image-links-agent-assets" || getBucketName() !== bucket) throw new Error("Render uploads require BUCKET=image-links-agent-assets and that same private bucket in --upload.");
  if (!prefix.endsWith("/") || prefix === "catalog-test/" || prefix.split("/").some((s) => s === "." || s === "..")) throw new Error("--upload must name a unique run folder under catalog-test/ and end with /.");
  return prefix;
}

export async function renderToReport(args: RenderArgs) {
  const uploadPrefix = args.upload ? validateRenderUpload(args.upload) : null;
  if (!args.channels.length || args.channels.some((c) => !CHANNEL_IDS.includes(c))) throw new Error("Choose at least one valid channel.");
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit <= 0)) throw new Error("--limit must be a positive whole number.");
  const manifest = JSON.parse(await readFile(args.manifest, "utf8")) as Manifest;
  const out = path.resolve(args.out), outputs: ReportOutput[] = [], contacts: { label: string; jpeg: Buffer }[] = [];
  const client = new MattingClient({ services: [{ baseUrl: args.matting ?? process.env.MATTING_URL ?? "http://localhost:8080", target: "cpu" }, ...(args.mattingGpu ?? process.env.MATTING_GPU_URL ? [{ baseUrl: (args.mattingGpu ?? process.env.MATTING_GPU_URL)!, target: "gpu" as const }] : [])] });
  let processed = 0, renderMs = 0, renderCount = 0;
  const matteTimes: Record<"cpu" | "gpu", number[]> = { cpu: [], gpu: [] };
  await mkdir(out, { recursive: true });
  for (const product of manifest.products) {
    const shots: { n: number; prepared: Prepared; matte: Matte }[] = [];
    for (const shot of product.shots) {
      if (args.limit !== undefined && processed >= args.limit) break;
      processed++;
      let prepared: Prepared | undefined;
      try {
        prepared = await prepare(await readFile(shot.path), path.basename(shot.path), (buf) => client.convert(buf));
        const matte = await matteFor(prepared, client, args.model);
        if (matte.target) matteTimes[matte.target].push(matte.ms);
        shots.push({ n: shot.n, prepared, matte });
      } catch (err) {
        for (const c of args.channels) outputs.push({ identifier: product.identifier, n: shot.n, channel: c, status: "failed", plan: { w: 0, h: 0, lowResolution: false, safeBox: { x: 0, y: 0, w: 0, h: 0 }, scale: 0, placedX: 0, placedY: 0, detailShot: false }, bytes: 0, quality: 0, flags: err instanceof UnsupportedSourceError ? ["unsupported"] : prepared?.flags ?? [], notes: [err instanceof Error ? err.message : String(err)], attention: null, compliance: { ok: false, failures: ["source"] }, matte: null });
      }
    }
    const geometry = shots.flatMap((s) => { const box = bbox(s.matte.alpha, s.prepared.width, s.prepared.height); return box ? [{ box, source: { w: s.prepared.width, h: s.prepared.height } }] : []; });
    for (const c of args.channels) {
      const spec = channel(c);
      const uniformScale = spec.uniformScaleDefault && geometry.length ? planProduct(spec, geometry).uniformScale : undefined;
      for (const shot of shots) {
        const name = `${encodeURIComponent(product.identifier).replace(/\./g, "%2E")}_${shot.n}.jpg`;
        const relative = `${c}/${name}`;
        const start = performance.now();
        const result = await renderSource({ prepared: shot.prepared, matte: shot.matte, channel: c, shotNumber: shot.n, productType: args.productType ?? "other", uniformScale, identifier: product.identifier, publicObjectPath: relative });
        renderMs += performance.now() - start; renderCount++;
        const { jpeg, ...rest } = result;
        const row: ReportOutput = { ...rest, identifier: product.identifier, n: shot.n, channel: c, matte: { model: shot.matte.model, target: shot.matte.target, sentLongSide: shot.matte.sentLongSide, ms: shot.matte.ms } };
        if (jpeg && result.status === "ok") {
          await mkdir(path.join(out, c), { recursive: true });
          row.path = path.join(out, c, name); await writeFile(row.path, jpeg);
          if (contacts.length < 90) contacts.push({ label: `${product.identifier} ${shot.n} ${c}`, jpeg });
          if (uploadPrefix) row.uploaded = await uploadBuffer(`${uploadPrefix}${relative}`, jpeg, "image/jpeg");
        }
        outputs.push(row);
      }
    }
  }
  const avg = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const flagsByKind: Record<string, number> = {};
  for (const row of outputs) for (const flag of row.flags) flagsByKind[flag] = (flagsByKind[flag] ?? 0) + 1;
  const report = { outputs, contactSheet: { samples: contacts.length, policy: "First 90 successful outputs in manifest product, selected channel, shot order." }, summary: { outputs: outputs.length, compliant: outputs.filter((o) => o.status === "ok" && o.compliance.ok).length, skipped: outputs.filter((o) => o.status === "skipped").length, failed: outputs.filter((o) => o.status === "failed").length, flagsByKind, msMatteAvgByTarget: { cpu: avg(matteTimes.cpu), gpu: avg(matteTimes.gpu) }, msRenderAvg: renderCount ? renderMs / renderCount : null } };
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  if (contacts.length) await writeFile(path.join(out, "contact-sheet.jpg"), await contactSheet(contacts, 6));
  return report;
}

export async function main(argv: string[]): Promise<number> {
  const [mode, ...rest] = argv;
  if (mode === "render") {
    let values;
    try {
      ({ values } = parseArgs({ args: rest, options: Object.fromEntries(["manifest", "channels", "out", "matting", "matting-gpu", "model", "product-type", "limit", "upload"].map((key) => [key, { type: "string" as const }])) }));
      const channels = String(values.channels ?? "").split(",") as ChannelId[];
      const productType = (values["product-type"] ?? "other") as ProductType;
      if (!values.manifest || !values.out || channels.some((c) => !CHANNEL_IDS.includes(c)) || !PRODUCT_TYPES.includes(productType)) throw new Error("Missing or invalid render options.");
      const report = await renderToReport({ manifest: String(values.manifest), channels: [...new Set(channels)], out: String(values.out), matting: values.matting as string | undefined, mattingGpu: values["matting-gpu"] as string | undefined, model: values.model as string | undefined, productType, limit: values.limit === undefined ? undefined : Number(values.limit), upload: values.upload as string | undefined });
      console.log(JSON.stringify(report.summary));
      return report.summary.failed ? 1 : 0;
    } catch (err) { console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}\nRender: render --manifest <manifest.json> --channels <comma-separated channels> --out <dir>`); return 2; }
  }
  if (mode !== "collect") {
    console.error(USAGE);
    return 2;
  }
  let values: { brand?: string; from?: string; "product-list"?: string; "identifier-mode"?: string; out?: string };
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { brand: { type: "string" }, from: { type: "string" }, "product-list": { type: "string" }, "identifier-mode": { type: "string" }, out: { type: "string" } },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n${USAGE}`);
    return 2;
  }
  const identifierMode = (values["identifier-mode"] ?? "filename") as IdentifierMode;
  if (!values.brand || !values.from || !values.out || !IDENTIFIER_MODES.includes(identifierMode)) {
    console.error(USAGE);
    return 2;
  }
  const { manifest } = await collectToManifest({ brand: values.brand, from: values.from, productList: values["product-list"], identifierMode, out: values.out });
  const shots = manifest.products.reduce((s, p) => s + p.shots.length, 0);
  console.log(`${manifest.products.length.toLocaleString("en-US")} products, ${shots.toLocaleString("en-US")} shots, ${manifest.rejected.length.toLocaleString("en-US")} files not used.`);
  for (const w of manifest.warnings) console.log(w.detail ? `${w.headline} ${w.detail}` : w.headline);
  console.log(`Manifest: ${path.join(path.resolve(values.out), "manifest.json")}`);
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
