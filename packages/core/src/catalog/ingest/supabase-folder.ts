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
export const SUPABASE_STILL_READING = "A Supabase folder is still being read. Keep this page open until it shows its photos, or paste its link again, then continue.";

/** Files read from one folder at most (M1-F1-R7: 30,000 photos per batch). */
export const SUPABASE_MAX_FILES = 30_000;
/** Files under this size are placeholders and skipped (M1-F1-R6). */
export const SUPABASE_PLACEHOLDER_BYTES = 1024;
const PAGE = 1000;
/** Folders listed at most (sub-folders included), over all requests of one folder link. */
export const SUPABASE_MAX_FOLDERS = 10_000;
/**
 * Folder listings in flight at once. One list call to the brand photo store takes about 200 ms (R1 exit run,
 * 2026-11-05), so a 477-folder brand reads in about 6 s and 5,000 folders in about a minute, while the shared
 * Supabase project never sees more than this many requests from us at a time.
 */
export const SUPABASE_LIST_CONCURRENCY = 16;
/**
 * Time one web request spends listing. A folder that is not finished by then is saved where it got to and the
 * paste box asks again, so a large folder is read over several short requests instead of one that times out.
 */
export const SUPABASE_SLICE_MS = 25_000;

class TooLarge extends Error {}

/** Where a folder listing got to: folders still to list (paths below the folder link), files found, counts. */
export interface SupabaseListState { pending: string[]; files: SupabaseFile[]; skipped: number; folders: number }

export type SupabaseListing =
  | { done: true; files: SupabaseFile[]; skipped: number; truncated: boolean }
  | { done: false; state: SupabaseListState };

export interface SupabaseListOptions {
  /** Where an earlier request got to; absent, the listing starts at the folder link. */
  state?: SupabaseListState;
  now?: () => number;
  sliceMs?: number;
  concurrency?: number;
}

/**
 * Every file below the folder (sub-folders included), name sorted. Dotfiles and Supabase's
 * `.emptyFolderPlaceholder` are left out; files under 1 KB are skipped and counted. Stops at
 * SUPABASE_MAX_FILES (`truncated`). Folders are listed SUPABASE_LIST_CONCURRENCY at a time; when the
 * slice time is up, no new folder is started and the state is returned (`done: false`) for the next request.
 * Throws TooLarge past SUPABASE_MAX_FOLDERS folders.
 */
export async function listSupabaseFolder(client: SupabaseStorageLike, link: SupabaseFolderLink, opts: SupabaseListOptions = {}): Promise<SupabaseListing> {
  const now = opts.now ?? (() => Date.now());
  const stopAt = now() + (opts.sliceMs ?? SUPABASE_SLICE_MS);
  const concurrency = Math.max(1, opts.concurrency ?? SUPABASE_LIST_CONCURRENCY);
  const pending = [...(opts.state?.pending ?? [""])];
  const files = [...(opts.state?.files ?? [])];
  let skipped = opts.state?.skipped ?? 0;
  let folders = opts.state?.folders ?? 0;
  let truncated = files.length >= SUPABASE_MAX_FILES;
  let failure: unknown = null;
  let started = 0;

  const listOne = async (rel: string) => {
    const prefix = [link.prefix, rel].filter(Boolean).join("/");
    for (let offset = 0; ; offset += PAGE) {
      const page = await client.list(link.bucket, prefix, offset, PAGE);
      for (const entry of page) {
        if (!entry.name || entry.name.startsWith(".")) continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.id === null) {
          pending.push(path);
          continue;
        }
        const size = typeof entry.metadata?.size === "number" ? entry.metadata.size : null;
        if (size !== null && size < SUPABASE_PLACEHOLDER_BYTES) {
          skipped++;
          continue;
        }
        if (files.length >= SUPABASE_MAX_FILES) {
          truncated = true;
          return;
        }
        files.push({ path, size });
      }
      if (page.length < PAGE) return;
    }
  };

  const inFlight = new Set<Promise<void>>();
  for (;;) {
    // Each request starts at least one folder, so a listing always moves forward.
    while (failure === null && !truncated && pending.length && inFlight.size < concurrency && (now() < stopAt || started === 0)) {
      // Too many folders: a sentence instead of reading without end.
      if (++folders > SUPABASE_MAX_FOLDERS) {
        failure = new TooLarge();
        break;
      }
      started++;
      const rel = pending.shift()!;
      const task: Promise<void> = listOne(rel)
        .catch((err: unknown) => { failure ??= err; })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    if (!inFlight.size) break;
    await Promise.race(inFlight);
  }
  if (failure !== null) throw failure;
  if (!truncated && pending.length) return { done: false, state: { pending, files, skipped, folders } };
  return { done: true, files: files.sort((a, b) => byText(a.path, b.path)), skipped, truncated };
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
  // A "." or ".." segment (also percent-encoded) would be resolved away by the URL parser before the request is sent.
  if (/^(\.|%2e){1,2}$/i.test(path.split("/").pop() ?? "")) return false;
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

/** What a pasted folder link gives: the paste text, a listing still under way, or the sentence why it cannot be read. */
export type SupabaseFolderRead =
  | { ok: true; url: string; text: string; mode: "folder" | "filename"; photos: number; message: string; title: string }
  | { ok: false; reading: true; url: string; state: SupabaseListState; photos: number; message: string; title: string }
  | { ok: false; reading?: false; error: string };

/** What the paste box says while a large folder is still being read. */
export function supabaseReadingMessage(link: SupabaseFolderLink, state: SupabaseListState): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  return `Reading Supabase folder ${[link.bucket, link.prefix].filter(Boolean).join("/")}: ${fmt(state.files.length)} ${state.files.length === 1 ? "photo" : "photos"} in ${fmt(state.folders)} ${state.folders === 1 ? "folder" : "folders"} so far.`;
}

/**
 * Lists a pasted folder link for up to one slice (SUPABASE_SLICE_MS): the paste text and its sentence, the
 * listing still under way (`reading`, with the state to pass back as `state` next time), or the sentence why
 * it cannot be read.
 */
export async function readSupabaseFolder(client: SupabaseStorageLike | null, link: string, opts: SupabaseListOptions = {}): Promise<SupabaseFolderRead> {
  if (!client) return { ok: false, error: SUPABASE_OFF };
  const parsed = parseSupabaseFolderLink(link);
  if (!parsed) return { ok: false, error: SUPABASE_UNREADABLE };
  if (parsed.origin !== new URL(client.origin).origin) return { ok: false, error: SUPABASE_OTHER_PROJECT };
  const title = `Supabase folder ${[parsed.bucket, parsed.prefix].filter(Boolean).join("/")}`;
  try {
    if (!(await client.isPublic(parsed.bucket))) return { ok: false, error: SUPABASE_PRIVATE };
    const listed = await listSupabaseFolder(client, parsed, opts);
    if (!listed.done) return { ok: false, reading: true, url: canonicalFolderUrl(parsed), state: listed.state, photos: listed.state.files.length, message: supabaseReadingMessage(parsed, listed.state), title };
    const { files, skipped, truncated } = listed;
    if (!files.length) return { ok: false, error: SUPABASE_EMPTY };
    const { text, mode } = supabaseFolderText(parsed, files);
    return { ok: true, url: canonicalFolderUrl(parsed), text, mode, photos: files.length, message: supabaseFolderMessage(parsed, files, skipped, truncated, mode), title };
  } catch (err) {
    return { ok: false, error: err instanceof TooLarge ? SUPABASE_TOO_LARGE : SUPABASE_UNREADABLE };
  }
}
