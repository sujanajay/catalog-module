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
export const SUPABASE_PAUSED = "Supabase stopped answering while this folder was being read. Press Try again, or paste the link again, to carry on from where it stopped.";
export const SUPABASE_PAUSED_CONTINUE = "A Supabase folder stopped part way. Press Try again on it, or remove it, then continue.";

/** A folder row whose listing paused on Supabase errors: failed, but holding where it got to (links.ts). */
export function isPausedFolder(upload: { status: string; kind: string; detected: unknown }): boolean {
  return upload.status === "failed" && upload.kind === "url_list" && !!(upload.detected as { supabaseFolder?: { listing?: unknown } } | null)?.supabaseFolder?.listing;
}
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
/**
 * List calls in flight at once across every folder read in one catalog-web instance (review P2-1). The cap is per
 * instance: with N instances up, the shared Supabase project can see up to N times this many.
 */
export const SUPABASE_GLOBAL_CONCURRENCY = 24;
/** Tries per list call: a 429, a 5xx, a timeout or a dropped connection is retried with jittered backoff before the listing pauses. */
export const SUPABASE_LIST_ATTEMPTS = 4;
/** Times one folder may pause a listing (over all requests) before the read fails with that folder named. */
export const SUPABASE_MAX_PAUSES = 3;
/** Longest one list call may take before it is given up and retried (a hung connection would hold a slot). */
export const SUPABASE_CALL_TIMEOUT_MS = 20_000;
const BACKOFF_MS = 500;
const MAX_WAIT_MS = 10_000;

class TooLarge extends Error {}

/** Supabase answered with an HTTP error; `retryAfterMs` from its Retry-After header when it sent one. */
export class SupabaseHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, retryAfterMs: number | null) {
    super(`Supabase answered ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A listing that stopped on an error after its retries; `state` is where it got to, so a later paste carries on. */
class ListPaused extends Error {
  readonly state: SupabaseListState;
  constructor(state: SupabaseListState) {
    super("Supabase listing paused");
    this.state = state;
  }
}

/**
 * Worth trying again: rate limited, a server error, a timed-out call, or no HTTP answer at all (fetch throws a
 * TypeError when the connection drops). Anything else (a 400, 403 or 404, a refused call, an unreadable answer)
 * will not get better by asking again.
 */
function transient(err: unknown): boolean {
  if (err instanceof SupabaseHttpError) return err.status === 429 || err.status === 408 || err.status >= 500;
  const name = (err as { name?: unknown } | null)?.name;
  return err instanceof TypeError || name === "TimeoutError" || name === "AbortError";
}

/** One folder kept failing over SUPABASE_MAX_PAUSES requests: the read fails, naming it. */
class FolderKeepsFailing extends Error {
  readonly folder: string;
  constructor(folder: string) {
    super("Supabase folder keeps failing");
    this.folder = folder;
  }
}

/** The sentence for a sub-folder Supabase kept failing on. */
export function supabaseFolderFailsMessage(folder: string): string {
  return `Supabase kept failing on the folder ${folder}, so this folder was not read. Check that folder in Supabase, or paste the folders beside it one by one.`;
}

const slots = { used: 0, waiting: [] as (() => void)[] };
/** Runs one list call inside the instance-wide cap (SUPABASE_GLOBAL_CONCURRENCY). */
async function withListSlot<T>(call: () => Promise<T>): Promise<T> {
  if (slots.used >= SUPABASE_GLOBAL_CONCURRENCY) await new Promise<void>((resolve) => slots.waiting.push(resolve));
  else slots.used++;
  try {
    return await call();
  } finally {
    // The slot passes straight to the next waiter, so `used` only drops when nobody waits.
    const next = slots.waiting.shift();
    if (next) next();
    else slots.used--;
  }
}

/** Where a folder listing got to: folders still to list (paths below the folder link), files found, counts. */
export interface SupabaseListState {
  pending: string[]; files: SupabaseFile[]; skipped: number; folders: number;
  /** How many times each folder paused the listing so far (absent: never). */
  pauses?: Record<string, number>;
}

export type SupabaseListing =
  | { done: true; files: SupabaseFile[]; skipped: number; truncated: boolean }
  | { done: false; state: SupabaseListState };

export interface SupabaseListOptions {
  /** Where an earlier request got to; absent, the listing starts at the folder link. */
  state?: SupabaseListState;
  now?: () => number;
  sliceMs?: number;
  concurrency?: number;
  /** Waits between tries of a list call (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1) (tests pass a fixed one). */
  random?: () => number;
}

/**
 * Every file below the folder (sub-folders included), name sorted. Dotfiles and Supabase's
 * `.emptyFolderPlaceholder` are left out; files under 1 KB are skipped and counted. Stops at
 * SUPABASE_MAX_FILES (`truncated`). Folders are listed SUPABASE_LIST_CONCURRENCY at a time (and at most
 * SUPABASE_GLOBAL_CONCURRENCY list calls per instance); when the slice time is up, no new folder is started and
 * the state is returned (`done: false`) for the next request. A folder's entries count only once all its pages
 * are read, so a state never holds half a folder. Each list call is tried SUPABASE_LIST_ATTEMPTS times on a
 * transient error; after that the listing throws ListPaused with the state so far. Throws TooLarge past
 * SUPABASE_MAX_FOLDERS folders.
 */
export async function listSupabaseFolder(client: SupabaseStorageLike, link: SupabaseFolderLink, opts: SupabaseListOptions = {}): Promise<SupabaseListing> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const stopAt = now() + (opts.sliceMs ?? SUPABASE_SLICE_MS);
  const concurrency = Math.max(1, opts.concurrency ?? SUPABASE_LIST_CONCURRENCY);
  const pending = [...(opts.state?.pending ?? [""])];
  const files = [...(opts.state?.files ?? [])];
  let skipped = opts.state?.skipped ?? 0;
  let folders = opts.state?.folders ?? 0;
  let truncated = files.length >= SUPABASE_MAX_FILES;
  let failure: unknown = null;
  const failed: string[] = [];
  let started = 0;

  const listPage = async (prefix: string, offset: number) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await withListSlot(() => client.list(link.bucket, prefix, offset, PAGE));
      } catch (err) {
        if (attempt >= SUPABASE_LIST_ATTEMPTS || !transient(err)) throw err;
        // Jittered, so calls that failed together do not all come back together.
        const hinted = err instanceof SupabaseHttpError ? err.retryAfterMs : null;
        const wait = hinted !== null ? hinted * (1 + random() / 2) : BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + random());
        await sleep(Math.min(MAX_WAIT_MS, Math.round(wait)));
      }
    }
  };

  const listOne = async (rel: string) => {
    const prefix = [link.prefix, rel].filter(Boolean).join("/");
    const found: SupabaseFile[] = [];
    const dirs: string[] = [];
    let small = 0;
    for (let offset = 0; ; offset += PAGE) {
      const page = await listPage(prefix, offset);
      for (const entry of page) {
        if (!entry.name || entry.name.startsWith(".")) continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.id === null) {
          dirs.push(path);
          continue;
        }
        const size = typeof entry.metadata?.size === "number" ? entry.metadata.size : null;
        if (size !== null && size < SUPABASE_PLACEHOLDER_BYTES) small++;
        else found.push({ path, size });
      }
      if (page.length < PAGE) break;
    }
    // The whole folder is read: only now does it count.
    pending.push(...dirs);
    skipped += small;
    for (const file of found) {
      if (files.length >= SUPABASE_MAX_FILES) {
        truncated = true;
        break;
      }
      files.push(file);
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
        .catch((err: unknown) => {
          failure ??= err;
          failed.push(rel);
        })
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    if (!inFlight.size) break;
    await Promise.race(inFlight);
  }
  if (failure instanceof TooLarge) throw failure;
  // An error that asking again will not fix fails the read at once.
  if (failure !== null && !transient(failure)) throw failure;
  if (failure !== null) {
    // The folders that failed are listed again next time; everything read before and beside them is kept. One that
    // keeps failing ends the read, so it never pauses for ever.
    const pauses = { ...(opts.state?.pauses ?? {}) };
    for (const rel of failed) pauses[rel] = (pauses[rel] ?? 0) + 1;
    const stuck = failed.find((rel) => pauses[rel]! >= SUPABASE_MAX_PAUSES);
    if (stuck !== undefined) throw new FolderKeepsFailing(stuck);
    throw new ListPaused({ pending: [...failed, ...pending], files, skipped, folders: folders - failed.length, pauses });
  }
  const pauses = opts.state?.pauses;
  if (!truncated && pending.length) return { done: false, state: { pending, files, skipped, folders, ...(pauses ? { pauses } : {}) } };
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
    // A per-call timeout: a hung connection becomes a TimeoutError, which the listing retries.
    const r = await fetchImpl(`${base}${path}`, { method, headers, redirect: "error", signal: AbortSignal.timeout(SUPABASE_CALL_TIMEOUT_MS), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!r.ok) throw new SupabaseHttpError(r.status, retryAfterMs(r.headers.get("retry-after")));
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

/** A Retry-After header (seconds, or an HTTP date) in milliseconds; null when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
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
  | { ok: false; reading?: false; error: string; url?: string; title?: string; state?: SupabaseListState };

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
    // A listing that paused on Supabase errors keeps where it got to, so pasting the link again carries on.
    // Nothing read at all (the folder link itself failed) is unreadable, as before.
    if (err instanceof FolderKeepsFailing) {
      const named = [parsed.prefix, err.folder].filter(Boolean).join("/");
      return { ok: false, error: supabaseFolderFailsMessage(named) };
    }
    if (err instanceof ListPaused && err.state.folders > 0) return { ok: false, error: SUPABASE_PAUSED, url: canonicalFolderUrl(parsed), title, state: err.state };
    return { ok: false, error: err instanceof TooLarge ? SUPABASE_TOO_LARGE : SUPABASE_UNREADABLE };
  }
}
