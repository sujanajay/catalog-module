// Supabase folder links (M1-F1-R4): a public or signed Supabase Storage URL of a folder (the brand
// photo store) is a paste kind. The web tier lists the folder through the Storage API (read only:
// list and bucket lookups, never a write) and saves it as a paste of image links, so the worker reads
// the photos like any other pasted link. Product sub-folders are kept as the products' names when the
// folder looks like one folder per product (fileRootMode, the same rule as a dropped folder).
import { normalizeKey } from "../naming";
import { byText, folderIdentifier } from "./group";
import { sourceItemFromPath } from "./local-files";
import { fileRootMode } from "./roots";

/** A Supabase folder link, split into its parts. `prefix` has no leading or trailing slash. */
export interface SupabaseFolderLink { origin: string; host: string; bucket: string; prefix: string }

/** One listed file: its path below the folder and its size in bytes (null when unknown). */
export interface SupabaseFile { path: string; size: number | null }

/** The subset of the Supabase Storage HTTP API the folder paste calls (a real client or a fake). */
export interface SupabaseStorageLike {
  /** The project origin the client talks to (`https://<ref>.supabase.co`): a link to any other host is refused. */
  origin: string;
  /** POST /storage/v1/object/list/<bucket>: entries directly under `prefix`; a folder entry has `id: null`. */
  list(bucket: string, prefix: string, offset: number, limit: number): Promise<{ name: string; id: string | null; metadata: { size?: number } | null }[]>;
  /** GET /storage/v1/bucket/<bucket>: whether its objects can be read through the public object path. */
  isPublic(bucket: string): Promise<boolean>;
}

export const SUPABASE_OFF = "Supabase folder links are not switched on yet. Download the photos and drop them here.";
export const SUPABASE_OTHER_PROJECT = "This Supabase link is from a project we cannot read. Download the photos and drop them here.";
export const SUPABASE_PRIVATE = "This Supabase folder is private, so its photos cannot be read by link. Download the photos and drop them here.";
export const SUPABASE_EMPTY = "This Supabase folder has no photos. Check the link, then paste again.";
export const SUPABASE_UNREADABLE = "This Supabase folder could not be read. Check the link, then paste again.";

/** Files read from one folder at most (M1-F1-R7: 30,000 photos per batch). */
export const SUPABASE_MAX_FILES = 30_000;
/** Files under this size are placeholders and skipped (M1-F1-R6). */
export const SUPABASE_PLACEHOLDER_BYTES = 1024;
const PAGE = 1000;

const FOLDER_LINK = /https?:\/\/[^\s/]+\.supabase\.co\/storage\/v1\/object\/(?:public|sign|authenticated)\/[^\s]+/gi;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|tiff?|heic|heif|avif)$/i;

/** The folder links in a paste (an object link, ending in an image name, is an image link instead). */
export function supabaseFolderLinks(text: string): string[] {
  return [...new Set([...text.matchAll(FOLDER_LINK)].map((m) => m[0]).filter((u) => parseSupabaseFolderLink(u) !== null))];
}

/** The parts of a Supabase folder link, or null for anything else (an object link included). */
export function parseSupabaseFolderLink(link: string): SupabaseFolderLink | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co")) return null;
  const m = /^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/?(.*)$/.exec(url.pathname);
  if (!m) return null;
  const segs = m[2]!.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  if (segs.length && IMAGE_EXT.test(segs[segs.length - 1]!)) return null;
  return { origin: url.origin, host: url.hostname, bucket: decodeURIComponent(m[1]!), prefix: segs.join("/") };
}

/**
 * Every file below the folder (sub-folders included), name sorted. Dotfiles and Supabase's
 * `.emptyFolderPlaceholder` are left out; files under 1 KB are skipped and counted. Stops at
 * SUPABASE_MAX_FILES (`truncated`).
 */
export async function listSupabaseFolder(client: SupabaseStorageLike, link: SupabaseFolderLink): Promise<{ files: SupabaseFile[]; skipped: number; truncated: boolean }> {
  const files: SupabaseFile[] = [];
  let skipped = 0;
  const queue = [""];
  while (queue.length) {
    const rel = queue.shift()!;
    const prefix = [link.prefix, rel].filter(Boolean).join("/");
    for (let offset = 0; ; offset += PAGE) {
      const page = await client.list(link.bucket, prefix, offset, PAGE);
      for (const entry of page) {
        if (!entry.name || entry.name.startsWith(".")) continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.id === null) {
          queue.push(path);
          continue;
        }
        const size = typeof entry.metadata?.size === "number" ? entry.metadata.size : null;
        if (size !== null && size < SUPABASE_PLACEHOLDER_BYTES) {
          skipped++;
          continue;
        }
        files.push({ path, size });
        if (files.length >= SUPABASE_MAX_FILES) return { files: files.sort((a, b) => byText(a.path, b.path)), skipped, truncated: true };
      }
      if (page.length < PAGE) break;
    }
  }
  return { files: files.sort((a, b) => byText(a.path, b.path)), skipped, truncated: false };
}

/** The public object URL of a file in the folder (each path segment encoded). */
export function supabaseObjectUrl(link: SupabaseFolderLink, path: string): string {
  const full = [link.prefix, path].filter(Boolean).join("/");
  return `${link.origin}/storage/v1/object/public/${encodeURIComponent(link.bucket)}/${full.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * The paste text the folder becomes, and the mode its photos are named by. In folder mode every line
 * is `<product folder><TAB><url>`; otherwise a photo named like `ABC123_1.jpg` is a bare link (its
 * name gives product and shot), and a photo with a number only (`1.jpg`) is named by its folder.
 */
export function supabaseFolderText(link: SupabaseFolderLink, files: SupabaseFile[]): { text: string; mode: "folder" | "filename" } {
  // Read as the files of a dropped folder would be, so folder names and shape folders give the same names.
  const items = files.map((f) => sourceItemFromPath(f.path, { kind: "gcs", gsUri: "" }, "supabase", "drive_folder"));
  const mode = fileRootMode(items, files.map((f) => f.path.split("/").slice(0, -1)), folderIdentifier) === "folder" ? "folder" : "filename";
  const lines = items.map((item, i) => {
    const url = supabaseObjectUrl(link, files[i]!.path);
    const folder = folderIdentifier(item);
    if (folder && (mode === "folder" || !normalizeKey(item.identifier))) return `${folder}\t${url}`;
    return url;
  });
  return { text: lines.join("\n"), mode };
}

/**
 * The Storage client for the project at `origin` with a read key (SUPABASE_URL and
 * SUPABASE_SERVICE_KEY on the web tier, from Secret Manager). Only list and bucket reads are sent.
 * The key goes only to `origin`; it is never logged or returned.
 */
export function supabaseStorageClient(origin: string, key: string, fetchImpl: typeof fetch = fetch): SupabaseStorageLike {
  const base = new URL(origin).origin;
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
  return {
    origin: base,
    async list(bucket, prefix, offset, limit) {
      const r = await fetchImpl(`${base}/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
        method: "POST", headers, body: JSON.stringify({ prefix, offset, limit, sortBy: { column: "name", order: "asc" } }), redirect: "error",
      });
      if (!r.ok) throw new Error(`Supabase list answered ${r.status}`);
      return (await r.json()) as { name: string; id: string | null; metadata: { size?: number } | null }[];
    },
    async isPublic(bucket) {
      const r = await fetchImpl(`${base}/storage/v1/bucket/${encodeURIComponent(bucket)}`, { headers, redirect: "error" });
      if (!r.ok) throw new Error(`Supabase bucket answered ${r.status}`);
      return ((await r.json()) as { public?: boolean }).public === true;
    },
  };
}

/** What the paste box says for a listed folder. */
export function supabaseFolderMessage(link: SupabaseFolderLink, files: SupabaseFile[], skipped: number, truncated: boolean, mode: "folder" | "filename"): string {
  const folders = new Set(files.map((f) => f.path.split("/").slice(0, -1).join("/")).filter(Boolean)).size;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const where = `Supabase folder ${[link.bucket, link.prefix].filter(Boolean).join("/")}`;
  const parts = [`${where}: ${fmt(files.length)} ${files.length === 1 ? "photo" : "photos"}${folders ? ` in ${fmt(folders)} ${folders === 1 ? "folder" : "folders"}` : ""}, grouped ${mode === "folder" ? "by folder name" : "by file name"}.`];
  if (skipped) parts.push(`${fmt(skipped)} ${skipped === 1 ? "file" : "files"} under 1 KB skipped.`);
  if (truncated) parts.push(`Only the first ${fmt(SUPABASE_MAX_FILES)} photos are read; make a second batch for the rest.`);
  return parts.join(" ");
}

/** Lists a pasted folder link: the paste text and its sentence, or the sentence why it cannot be read. */
export async function readSupabaseFolder(client: SupabaseStorageLike | null, link: string): Promise<{ ok: true; text: string; mode: "folder" | "filename"; photos: number; message: string; title: string } | { ok: false; error: string }> {
  if (!client) return { ok: false, error: SUPABASE_OFF };
  const parsed = parseSupabaseFolderLink(link);
  if (!parsed) return { ok: false, error: SUPABASE_UNREADABLE };
  if (parsed.origin !== new URL(client.origin).origin) return { ok: false, error: SUPABASE_OTHER_PROJECT };
  try {
    if (!(await client.isPublic(parsed.bucket))) return { ok: false, error: SUPABASE_PRIVATE };
    const { files, skipped, truncated } = await listSupabaseFolder(client, parsed);
    if (!files.length) return { ok: false, error: SUPABASE_EMPTY };
    const { text, mode } = supabaseFolderText(parsed, files);
    return { ok: true, text, mode, photos: files.length, message: supabaseFolderMessage(parsed, files, skipped, truncated, mode), title: `Supabase folder ${[parsed.bucket, parsed.prefix].filter(Boolean).join("/")}` };
  } catch {
    return { ok: false, error: SUPABASE_UNREADABLE };
  }
}
