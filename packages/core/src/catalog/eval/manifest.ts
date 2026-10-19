// Golden set manifest (spec 08 section 4.1). Pure types and helpers; storage I/O lives in assemble.ts.
// Golden sets live under catalog-test/eval/<set>/ in the private bucket (reduced scope: every eval
// artifact stays under catalog-test/).
import { TEST_PREFIX } from "../naming";
import type { ProductType } from "../types";

export const HARD_CASE_TAGS = ["white_on_white", "dark_shadow", "mesh", "transparent_png", "px500", "heic", "collage", "watermark", "mixed_product"] as const;
export type HardCaseTag = (typeof HARD_CASE_TAGS)[number];
export const SOURCE_KINDS = ["supabase_sheet", "local_folder", "master_image_url", "operator_set", "hard_case"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type EvalCategory = Exclude<ProductType, "auto">;

export interface ManifestEntry {
  identifier: string; n: number; brand: string; category_override?: EvalCategory;
  source: { kind: SourceKind; ref: string };
  sha256: string; width: number; height: number; mime: string; hard_case_tags: HardCaseTag[];
  /** gs:// URI of the copy under catalog-test/eval/<set>/sources/. */
  uri: string;
}
export interface EvalManifest {
  set: string;
  sample?: { n: number; seed: number };
  /** Brands the manifest knows have no images yet (section 4.2). */
  no_sources_yet: string[];
  entries: ManifestEntry[];
}

const SET_NAME = /^[a-z0-9][a-z0-9_-]*$/;
export function assertSetName(set: string): string {
  if (!SET_NAME.test(set)) throw new Error(`Invalid eval set name: ${set}`);
  return set;
}
export const evalRoot = (set: string) => `${TEST_PREFIX}eval/${assertSetName(set)}`;
export const manifestPath = (set: string) => `${evalRoot(set)}/manifest.json`;
export const sourcePath = (set: string, brand: string, identifier: string, n: number, ext: string) => `${evalRoot(set)}/sources/${brand}/${identifier}_${n}.${ext}`;
export const labelsPath = (set: string, runId: string) => `${evalRoot(set)}/labels/labels-${runId}.csv`;
export const reportPath = (set: string, runId: string, ext: "html" | "json") => `${evalRoot(set)}/reports/bakeoff-${runId}.${ext}`;
export const contactPath = (set: string, batchId: string) => `${evalRoot(set)}/reports/contact-${batchId}.html`;

export const emptyManifest = (set: string): EvalManifest => ({ set: assertSetName(set), no_sources_yet: [], entries: [] });

export function parseManifest(text: string): EvalManifest {
  const raw = JSON.parse(text) as Partial<EvalManifest>;
  if (typeof raw.set !== "string" || !Array.isArray(raw.entries)) throw new Error("The eval manifest is missing its set name or entries.");
  return { set: assertSetName(raw.set), ...(raw.sample ? { sample: raw.sample } : {}), no_sources_yet: raw.no_sources_yet ?? [], entries: raw.entries };
}
export const serializeManifest = (m: EvalManifest) => `${JSON.stringify(m, null, 2)}\n`;

/** Adds entries whose sha256 is new. Idempotent: the same bytes never produce a second entry. */
export function mergeEntries(manifest: EvalManifest, entries: readonly ManifestEntry[]): { manifest: EvalManifest; added: ManifestEntry[]; skipped: number } {
  const seen = new Set(manifest.entries.map(e => e.sha256));
  const added: ManifestEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.sha256)) continue;
    seen.add(entry.sha256);
    added.push(entry);
  }
  return { manifest: { ...manifest, entries: [...manifest.entries, ...added] }, added, skipped: entries.length - added.length };
}

/** Deterministic sample of `n` items for a seed (mulberry32 + Fisher-Yates). */
export function seededSample<T>(items: readonly T[], n: number, seed: number): T[] {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, Math.max(0, n));
}

/** Counts per brand and per hard-case tag, printed by `assemble`. */
export function manifestCounts(m: EvalManifest) {
  const brands: Record<string, number> = {}, tags: Record<string, number> = {};
  for (const e of m.entries) {
    brands[e.brand] = (brands[e.brand] ?? 0) + 1;
    for (const t of e.hard_case_tags) tags[t] = (tags[t] ?? 0) + 1;
  }
  return { set: m.set, total: m.entries.length, brands, tags, no_sources_yet: m.no_sources_yet };
}
