// Supabase folder links (M1-F1-R4), the dependency-free part shared by the browser (paste-check.ts)
// and the server (detect.ts, supabase-folder.ts): which pasted cell is a folder link, its parts and
// its canonical form. A cell is a folder link only when the whole cell is one Supabase Storage URL
// whose path does not end in an image name, so a pasted photo link (with a space or not) stays an
// image link.

/** File endings that make a Supabase Storage link a photo, not a folder. */
export const IMAGE_EXT = /\.(jpe?g|png|webp|gif|tiff?|heic|heif|avif)$/i;

const FOLDER_CELL = /^https:\/\/[^\s/]+\.supabase\.co\/storage\/v1\/object\/(?:public|sign|authenticated)\/\S+$/i;

/** A Supabase folder link, split into its parts. `prefix` has no leading or trailing slash. */
export interface SupabaseFolderLink { origin: string; host: string; bucket: string; prefix: string }

/** The parts of a Supabase folder link, or null for anything else (a photo link included). */
export function parseSupabaseFolderLink(link: string): SupabaseFolderLink | null {
  const cell = link.trim();
  if (!FOLDER_CELL.test(cell)) return null;
  let url: URL;
  try {
    url = new URL(cell);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".supabase.co")) return null;
  const m = /^\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/?(.*)$/.exec(url.pathname);
  if (!m) return null;
  let segs: string[];
  try {
    segs = m[2]!.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
  if (!segs.length || IMAGE_EXT.test(segs[segs.length - 1]!)) return null;
  return { origin: url.origin, host: url.hostname, bucket: decodeURIComponent(m[1]!), prefix: segs.join("/") };
}

/** True when the whole trimmed cell or line is a Supabase folder link. */
export function isSupabaseFolderCell(cell: string): boolean {
  return parseSupabaseFolderLink(cell) !== null;
}

/**
 * The one spelling of a folder, whatever form was pasted (public or signed, a trailing slash, a
 * query string or token): `<origin>/storage/v1/object/public/<bucket>/<prefix>`. Tokens are never kept.
 */
export function canonicalFolderUrl(link: SupabaseFolderLink): string {
  return `${link.origin}/storage/v1/object/public/${encodeURIComponent(link.bucket)}/${link.prefix.split("/").map(encodeURIComponent).join("/")}`;
}

/** The cells of a pasted text: its lines, split on tabs, trimmed. */
const cellsOf = (text: string) => text.split(/\r?\n/).flatMap((line) => line.split("\t")).map((c) => c.trim());

/** Every distinct folder in a pasted text, canonical (each cell that is a whole folder link). */
export function supabaseFolderLinks(text: string): string[] {
  return [...new Set(cellsOf(text).flatMap((cell) => {
    const link = parseSupabaseFolderLink(cell);
    return link ? [canonicalFolderUrl(link)] : [];
  }))];
}

/** The pasted text with every folder-link cell blanked, keeping lines and cells as pasted. */
export function withoutSupabaseFolders(text: string): string {
  return text.split(/(\r?\n)/).map((part) => (/^\r?\n$/.test(part) ? part : part.split("\t").map((cell) => (isSupabaseFolderCell(cell) ? "" : cell)).join("\t"))).join("");
}
