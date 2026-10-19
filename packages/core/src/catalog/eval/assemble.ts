// Golden set assembly (spec 08 section 4.2). Reduced scope: only the local real photo folders
// (Anta and French Connection) are collected; the Supabase sheet, master image_url and operator
// sources are accepted by the manifest type but not collected here yet. Sources are read only.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { parseShotName, sanitizeSegment } from "../naming";
import { mimeFromPath, toGsUri } from "../../storage";
import { emptyManifest, manifestCounts, manifestPath, mergeEntries, parseManifest, seededSample, serializeManifest, sourcePath, type EvalCategory, type HardCaseTag, type ManifestEntry } from "./manifest";

export interface AssembleStorage {
  uploadBuffer: (path: string, buf: Buffer, mime: string) => Promise<string>;
  downloadBuffer: (gsUri: string) => Promise<{ buf: Buffer }>;
  listObjects: (gsPrefixUri: string) => Promise<string[]>;
  getBucketName: () => string;
}
export interface AssembleOptions {
  set: string; brand: string; folder: string; category?: EvalCategory;
  sample?: { n: number; seed: number };
}

async function imageFiles(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...await imageFiles(dir, rel));
    else if (/\.(jpe?g|png|webp|heic)$/i.test(entry.name)) found.push(rel);
  }
  return found.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export async function readManifest(storage: AssembleStorage, set: string) {
  const uri = toGsUri(storage.getBucketName(), manifestPath(set));
  const exists = (await storage.listObjects(uri)).includes(uri);
  return exists ? parseManifest((await storage.downloadBuffer(uri)).buf.toString("utf8")) : emptyManifest(set);
}

/** Tags the tool can decide from the bytes alone; the rest are tagged by a human (section 4.2). */
function autoTags(mime: string, width: number, height: number, hasAlpha: boolean): HardCaseTag[] {
  const tags: HardCaseTag[] = [];
  if (Math.max(width, height) < 500) tags.push("px500");
  if (mime === "image/png" && hasAlpha) tags.push("transparent_png");
  if (mime === "image/heic") tags.push("heic");
  return tags;
}

/** Builds or extends catalog-test/eval/<set>/ from a local folder. Idempotent on sha256. */
export async function assembleFromFolder(storage: AssembleStorage, opts: AssembleOptions) {
  const files = await imageFiles(opts.folder);
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const id = parseShotName(path.basename(file)).identifier || path.basename(path.dirname(file));
    groups.set(id, [...groups.get(id) ?? [], file]);
  }
  // The sample is taken over products (identifiers), so every sampled product keeps all its shots.
  const ids = opts.sample ? seededSample([...groups.keys()].sort(), opts.sample.n, opts.sample.seed) : [...groups.keys()];
  const manifest = await readManifest(storage, opts.set);
  const known = new Set(manifest.entries.map(e => e.sha256));
  const entries: ManifestEntry[] = [];
  for (const id of ids) {
    for (const [index, file] of (groups.get(id) ?? []).entries()) {
      const bytes = await readFile(path.join(opts.folder, file));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (known.has(sha256)) continue;
      const meta = await sharp(bytes).metadata();
      const mime = mimeFromPath(file);
      const n = parseShotName(path.basename(file)).n ?? index + 1;
      const identifier = sanitizeSegment(id);
      const ext = path.extname(file).slice(1).toLowerCase();
      const uri = await storage.uploadBuffer(sourcePath(opts.set, opts.brand, identifier, n, ext), bytes, mime);
      entries.push({ identifier, n, brand: opts.brand, ...(opts.category ? { category_override: opts.category } : {}), source: { kind: "local_folder", ref: file.split(path.sep).join("/") }, sha256, width: meta.width ?? 0, height: meta.height ?? 0, mime, hard_case_tags: autoTags(mime, meta.width ?? 0, meta.height ?? 0, !!meta.hasAlpha), uri });
    }
  }
  const merged = mergeEntries(manifest, entries);
  const next = { ...merged.manifest, ...(opts.sample ? { sample: opts.sample } : {}) };
  await storage.uploadBuffer(manifestPath(opts.set), Buffer.from(serializeManifest(next)), "application/json");
  return { added: merged.added.length, counts: manifestCounts(next) };
}
