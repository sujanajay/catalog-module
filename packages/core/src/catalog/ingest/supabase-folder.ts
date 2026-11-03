// Supabase folder links (M1-F1-R4): a public or signed Supabase Storage URL of a folder (the brand
// photo store) is a paste kind. The web tier lists the folder through the Storage API (read only:
// list and bucket lookups, never a write) and saves it as a paste of image links, so the worker reads
// the photos like any other pasted link. Product sub-folders are kept as the products' names when the
// folder looks like one folder per product (fileRootMode, the same rule as a dropped folder).
import { normalizeKey } from "../naming";
import { byText, folderIdentifier } from "./group";
import { sourceItemFromPath } from "./local-files";
import { fileRootMode, onlyShapeFolders } from "./roots";
import { canonicalFolderUrl, parseSupabaseFolderLink, type SupabaseFolderLink } from "./supabase-link";

export { canonicalFolderUrl, parseSupabaseFolderLink, supabaseFolderLinks, withoutSupabaseFolders, type SupabaseFolderLink } from "./supabase-link";

/** One listed file: its path below the folder and its size in bytes (null when unknown). */
export interface SupabaseFile { path: string; size: number | null }

/**
 * The subset of the Supabase Storage HTTP API the folder paste calls (a real client or a fake). Read
 * only by construction: there is no upload, move, copy, sign or delete call (Supabase is never written).
 */
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
export const SUPABASE_TOO_LARGE = "This Supabase folder is too large to read by link. Paste a smaller folder inside it, or download the photos and drop them here.";

/** Files read from one folder at most (M1-F1-R7: 30,000 photos per batch). */
export const SUPABASE_MAX_FILES = 30_000;
/** Files under this size are placeholders and skipped (M1-F1-R6). */
export const SUPABASE_PLACEHOLDER_BYTES = 1024;
const PAGE = 1000;
/** Folders listed and time spent at most, so the listing ends well inside one web request. */
export const SUPABASE_MAX_FOLDERS = 5_000;
export const SUPABASE_LIST_DEADLINE_MS = 45_000;

class TooLarge extends Error {}

/**
 * Every file below the folder (sub-folders included), name sorted. Dotfiles and Supabase's
 * `.emptyFolderPlaceholder` are left out; files under 1 KB are skipped and counted. Stops at
 * SUPABASE_MAX_FILES (`truncated`).
 */
export async function listSupabaseFolder(client: SupabaseStorageLike, link: SupabaseFolderLink, now: () => number = Date.now): Promise<{ files: SupabaseFile[]; skipped: number; truncated: boolean }> {
  const files: SupabaseFile[] = [];
  let skipped = 0;
  const queue = [""];
  const stopAt = now() + SUPABASE_LIST_DEADLINE_MS;
  let folders = 0;
  while (queue.length) {
    // Too many folders or too long: a sentence instead of a web request that times out.
    if (++folders > SUPABASE_MAX_FOLDERS || now() > stopAt) throw new TooLarge();
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
  // A folder with its photos directly inside may itself be the product: it is judged under its own name.
  const dirsOf = (path: string) => path.split("/").slice(0, -1);
  const own = link.prefix.split("/").pop()!;
  const direct = onlyShapeFolders(files.map((f) => dirsOf(f.path)));
  const paths = files.map((f) => (direct ? `${own}/${f.path}` : f.path));
  const items = paths.map((path) => sourceItemFromPath(path, { kind: "gcs", gsUri: "" }, "supabase", "drive_folder"));
  const mode = fileRootMode(items, paths.map(dirsOf), folderIdentifier) === "folder" ? "folder" : "filename";
  const lines = items.map((item, i) => {
    const url = supabaseObjectUrl(link, files[i]!.path);
    const folder = folderIdentifier(item);
    if (folder && (mode === "folder" || !normalizeKey(item.identifier))) return `${folder}\t${url}`;
    return url;
  });
  return { text: lines.join("\n"), mode };
}

/**
 * The Storage client for the project at `origin` (SUPABASE_URL and SUPABASE_SERVICE_KEY on the web
 * tier, from Secret Manager). The only key the project holds is the service-role key, which could
 * write; this client can only send the two reads in READ_CALLS (checked before every request) and
 * has no other method. The key goes only to `origin`; it is never logged or returned.
 */
export function supabaseStorageClient(origin: string, key: string, fetchImpl: typeof fetch = fetch): SupabaseStorageLike {
  const base = new URL(origin).origin;
  const headers = { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" };
  const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
    if (!isReadCall(method, path)) throw new Error(`Supabase call refused: ${method} ${path}`);
    const r = await fetchImpl(`${base}${path}`, { method, headers, redirect: "error", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw new Error(`Supabase answered ${r.status}`);
    return r.json();
  };
  return Object.freeze({
    origin: base,
    async list(bucket: string, prefix: string, offset: number, limit: number) {
      return (await send("POST", `/storage/v1/object/list/${encodeURIComponent(bucket)}`, { prefix, offset, limit, sortBy: { column: "name", order: "asc" } })) as { name: string; id: string | null; metadata: { size?: number } | null }[];
    },
    async isPublic(bucket: string) {
      return ((await send("GET", `/storage/v1/bucket/${encodeURIComponent(bucket)}`)) as { public?: boolean }).public === true;
    },
  });
}

/** The only Supabase requests this module sends: list a folder (a search, POST by API design) and read a bucket's settings. */
export function isReadCall(method: string, path: string): boolean {
  if (method === "POST") return /^\/storage\/v1\/object\/list\/[^/]+$/.test(path);
  if (method === "GET") return /^\/storage\/v1\/bucket\/[^/]+$/.test(path);
  return false;
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
export async function readSupabaseFolder(client: SupabaseStorageLike | null, link: string): Promise<{ ok: true; url: string; text: string; mode: "folder" | "filename"; photos: number; message: string; title: string } | { ok: false; error: string }> {
  if (!client) return { ok: false, error: SUPABASE_OFF };
  const parsed = parseSupabaseFolderLink(link);
  if (!parsed) return { ok: false, error: SUPABASE_UNREADABLE };
  if (parsed.origin !== new URL(client.origin).origin) return { ok: false, error: SUPABASE_OTHER_PROJECT };
  try {
    if (!(await client.isPublic(parsed.bucket))) return { ok: false, error: SUPABASE_PRIVATE };
    const { files, skipped, truncated } = await listSupabaseFolder(client, parsed);
    if (!files.length) return { ok: false, error: SUPABASE_EMPTY };
    const { text, mode } = supabaseFolderText(parsed, files);
    return { ok: true, url: canonicalFolderUrl(parsed), text, mode, photos: files.length, message: supabaseFolderMessage(parsed, files, skipped, truncated, mode), title: `Supabase folder ${[parsed.bucket, parsed.prefix].filter(Boolean).join("/")}` };
  } catch (err) {
    return { ok: false, error: err instanceof TooLarge ? SUPABASE_TOO_LARGE : SUPABASE_UNREADABLE };
  }
}
