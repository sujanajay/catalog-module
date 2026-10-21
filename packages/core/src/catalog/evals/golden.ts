// Golden set for the output-quality evals (spec 10 section 9). The manifest is committed under
// packages/core/test-fixtures/catalog/evals/ and pins every photo by sha256; the photos themselves
// stay in the owner's folders (read only) and are copied under catalog-test/evals/golden/ by the
// `upload` command. Derived hard cases (a 450 px copy, a model cut at the knees) are made here from
// golden photos with deterministic sharp operations and pinned like any other entry.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { parseShotName, sanitizeSegment } from "../naming";
import { mimeFromPath } from "../../storage";
import type { OutputFlag } from "../types";
import { seededSample, type EvalCategory } from "../eval/manifest";
import { borderMedian, components, delta, luma, thresholdMask } from "./image";
import type { Expectation } from "./types";

export const GOLDEN_TAGS = ["white_on_white", "dark_product", "grey_background", "wide_product", "thin_straps", "transparent", "reflective", "text_or_watermark", "px500", "cut_edge", "many_shots", "flat_lay", "hardline", "mixed_set"] as const;
export type GoldenTag = (typeof GOLDEN_TAGS)[number];
export const DERIVED_OPS = ["downscale_450", "cut_bottom_15"] as const;
export type DerivedOp = (typeof DERIVED_OPS)[number];

export interface GoldenEntry {
  identifier: string; n: number; brand: string; category: EvalCategory;
  source: { root: string; path: string };
  sha256: string; bytes: number; width: number; height: number; mime: string;
  tags: GoldenTag[]; expect: Expectation;
  derived?: { from: string; op: DerivedOp };
  /** Planted wrong item: this shot's bytes belong to `from` (another golden product) and must be caught as different_product. */
  planted?: { from: string };
}
export interface GoldenManifest { version: 1; seed: number; roots: Record<string, string>; entries: GoldenEntry[] }
export interface GoldenPlan {
  root: string; brand: string; category: EvalCategory;
  /** Seeded sample of products from the folder, added to `identifiers` (the deliberate hard cases). */
  sampleProducts?: number; identifiers?: string[];
  /** Category by shot 1 tag, for folders that mix flat lays and models; the first matching rule wins, overrides win over rules. */
  categoryRules?: { tag: GoldenTag; category: EvalCategory }[];
}
export interface GoldenOverride {
  category?: EvalCategory; tags?: GoldenTag[]; expect?: Partial<Expectation>;
  /** Per shot (keyed by the shot number): tags and an expectation for that photo alone, over the product's. */
  shots?: Record<string, { tags?: GoldenTag[]; expect?: Partial<Expectation> }>;
}
export interface GoldenBuild {
  roots: Record<string, string>; seed: number; plans: GoldenPlan[]; overrides: Record<string, GoldenOverride>;
  derive: { from: string; op: DerivedOp; brand: string; category: EvalCategory }[];
  /** Planted set: a copy of product `into` with the photo `from` (another product, ideally another brand) appended as its last shot. */
  plant: { into: string; from: string }[];
}
export const PLANTED_EXPECTATION: Expectation = { attention: true, flags: ["different_product"], detector: "judge" };

export const NO_ATTENTION: Expectation = { attention: false, flags: [], detector: "code" };
export const GOLDEN_PREFIX = "catalog-test/evals/golden";
export const goldenSourcePath = (e: GoldenEntry) => `${GOLDEN_PREFIX}/sources/${e.brand}/${e.identifier}_${e.n}.${e.source.path.split(".").pop()!.toLowerCase()}`;
export const GOLDEN_MANIFEST_PATH = `${GOLDEN_PREFIX}/manifest.json`;

export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function imageFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...(await imageFiles(path.join(dir, entry.name))).map(f => path.join(entry.name, f)));
    else if (/\.(jpe?g|png|webp)$/i.test(entry.name)) out.push(entry.name);
  }
  return out.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** Tags the tool can decide from the bytes alone; the rest come from the overrides file. */
export async function autoTags(bytes: Buffer): Promise<{ tags: GoldenTag[]; width: number; height: number }> {
  const { data, info } = await sharp(bytes).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, tags: GoldenTag[] = [];
  if (Math.max(w, h) < 500) tags.push("px500");
  const bg = borderMedian({ w, h, rgb: data }), bgLuma = luma(...bg);
  if (bgLuma < 245 && bgLuma > 120) tags.push("grey_background");
  const fg = new Uint8Array(w * h);
  let count = 0, bright = 0, dark = 0;
  for (let i = 0; i < fg.length; i++) if (delta(data, i, bg) > 12) { fg[i] = 1; count++; const l = luma(data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!); if (l > 225) bright++; if (l < 50) dark++; }
  if (count > 500) {
    if (bgLuma > 235 && bright / count >= 0.3) tags.push("white_on_white");
    if (dark / count >= 0.4) tags.push("dark_product");
    const { labels, sizes } = components(fg, w, h), big = thresholdMask(Uint8Array.from(labels, l => (l && sizes[l]! >= w * h * 0.0002 ? 1 : 0)), 0);
    let x0 = w, y0 = h, x1 = -1, y1 = -1, edge = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (big[y * w + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge++; }
    if (x1 >= 0 && x1 - x0 > y1 - y0) tags.push("wide_product");
    if (edge >= Math.min(w, h) * 0.02) tags.push("cut_edge");
  }
  return { tags, width: w, height: h };
}

/** Deterministic hard-case derivations. */
export async function deriveBytes(bytes: Buffer, op: DerivedOp): Promise<Buffer> {
  const meta = await sharp(bytes).metadata(), w = meta.width!, h = meta.height!;
  if (op === "downscale_450") return sharp(bytes).resize(450, 450, { fit: "inside", kernel: "lanczos3" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
  return sharp(bytes).extract({ left: 0, top: 0, width: w, height: Math.round(h * 0.85) }).jpeg({ quality: 92, chromaSubsampling: "4:4:4" }).toBuffer();
}
export const DERIVED_EXPECTATION: Record<DerivedOp, Expectation> = {
  downscale_450: { attention: true, flags: ["small_source"], detector: "code" },
  cut_bottom_15: NO_ATTENTION,
};

/** Groups a folder's photos by identifier, in shot order. */
export async function groupFolder(dir: string): Promise<Map<string, string[]>> {
  const groups = new Map<string, string[]>();
  for (const file of await imageFiles(dir)) {
    const id = sanitizeSegment(parseShotName(path.basename(file)).identifier || path.basename(path.dirname(file)));
    groups.set(id, [...groups.get(id) ?? [], file]);
  }
  return groups;
}

/** Builds the manifest; `writeDerived` stores derived bytes and returns the relative path under the derived root. */
export async function buildGolden(build: GoldenBuild, writeDerived: (name: string, bytes: Buffer) => Promise<string>): Promise<GoldenManifest> {
  const entries: GoldenEntry[] = [];
  const read = async (root: string, rel: string) => readFile(path.join(build.roots[root]!, rel));
  for (const plan of build.plans) {
    const dir = build.roots[plan.root];
    if (!dir) throw new Error(`Unknown golden root ${plan.root}.`);
    const groups = await groupFolder(dir);
    const sampled = plan.sampleProducts ? seededSample([...groups.keys()].sort(), plan.sampleProducts, build.seed) : plan.identifiers ? [] : [...groups.keys()];
    const ids = [...new Set([...sampled, ...(plan.identifiers ?? [])])].sort();
    for (const id of ids) {
      const files = groups.get(id);
      if (!files) throw new Error(`Golden identifier ${id} is not in ${plan.root}.`);
      const override = build.overrides[id] ?? {};
      let category: EvalCategory | undefined = override.category;
      for (const [index, file] of files.entries()) {
        const bytes = await read(plan.root, file), analysed = await autoTags(bytes), n = parseShotName(path.basename(file)).n ?? index + 1, shot = override.shots?.[String(n)] ?? {};
        const tags = [...new Set([...analysed.tags, ...(override.tags ?? []), ...(shot.tags ?? []), ...(files.length >= 5 ? ["many_shots" as const] : [])])];
        if (index === 0) category ??= plan.categoryRules?.find(rule => tags.includes(rule.tag))?.category ?? plan.category;
        entries.push({ identifier: id, n, brand: plan.brand, category: category ?? plan.category, source: { root: plan.root, path: file.split(path.sep).join("/") }, sha256: sha256(bytes), bytes: bytes.length, width: analysed.width, height: analysed.height, mime: mimeFromPath(file), tags, expect: { ...NO_ATTENTION, ...override.expect, ...shot.expect } });
      }
    }
  }
  for (const d of build.derive) {
    const parent = entries.find(e => `${e.identifier}_${e.n}` === d.from);
    if (!parent) throw new Error(`Derived case ${d.from} is not in the golden set.`);
    const bytes = await deriveBytes(await read(parent.source.root, parent.source.path), d.op);
    const identifier = `${parent.identifier}-${d.op.replace(/_/g, "")}`, name = `${identifier}_1.jpg`;
    const rel = await writeDerived(name, bytes), analysed = await autoTags(bytes);
    const override = build.overrides[identifier] ?? {};
    entries.push({ identifier, n: 1, brand: d.brand, category: override.category ?? d.category, source: { root: "derived", path: rel }, sha256: sha256(bytes), bytes: bytes.length, width: analysed.width, height: analysed.height, mime: "image/jpeg", tags: [...new Set([...analysed.tags, ...(override.tags ?? [])])], expect: { ...DERIVED_EXPECTATION[d.op], ...override.expect }, derived: { from: d.from, op: d.op } });
  }
  for (const p of build.plant) {
    const host = entries.filter(e => e.identifier === p.into && !e.planted && !e.derived).sort((a, b) => a.n - b.n);
    const foreign = entries.find(e => `${e.identifier}_${e.n}` === p.from);
    if (!host.length || !foreign) throw new Error(`Planted case ${p.from} into ${p.into}: both must be in the golden set.`);
    const identifier = `${p.into}-planted`;
    // A host shot that expects flags without a hold (a size chart left out as chart_image) keeps that expectation in the copy.
    for (const e of host) entries.push({ ...e, identifier, source: { ...e.source }, tags: [...new Set([...e.tags, "mixed_set" as const])], expect: !e.expect.attention && e.expect.flags.length ? { ...e.expect } : PLANTED_EXPECTATION });
    entries.push({ ...foreign, identifier, n: plantedShotNumber(host), brand: host[0]!.brand, category: host[0]!.category, source: { ...foreign.source }, tags: [...new Set([...foreign.tags, "mixed_set" as const])], expect: PLANTED_EXPECTATION, planted: { from: p.from } });
  }
  return { version: 1, seed: build.seed, roots: build.roots, entries };
}

/**
 * Maps a batch's shots to their manifest entries by source sha256 (eval run 3: the drive files of Z659062EFB3FB0720BF56Z
 * are numbered 1,2,3,4,5,7 and ingest renumbers them 1..6 with `numbering_gap`, so manifest n=7, a size chart, is the
 * batch's n=6 while n=7 of the planted copy is the planted photo), falling back to the shot number when no entry of the
 * product has the shot's bytes. Keyed by `identifier|n` of the batch's numbering.
 */
export function mapShotsBySha(entries: readonly GoldenEntry[], shots: readonly { identifier: string; n: number; sha256: string }[]): Map<string, GoldenEntry> {
  const out = new Map<string, GoldenEntry>();
  for (const s of shots) {
    const entry = entries.find(e => e.identifier === s.identifier && e.sha256 === s.sha256) ?? entries.find(e => e.identifier === s.identifier && e.n === s.n);
    if (entry) out.set(`${s.identifier}|${s.n}`, entry);
  }
  return out;
}

/**
 * Byte-identical sources counted once (eval run 3, vero_moda: ZA879DC4CE21DC00F08C3Z and ZFEA925E26F8FACC3E40FZ share
 * every photo and doubled every bake-off number without a duplicate flag): the first entry of each sha256 in the given
 * order is kept, the others named as its duplicates.
 */
export function uniqueSources<T extends { identifier: string; n: number; sha256: string }>(entries: readonly T[]): { kept: T[]; duplicates: { sha256: string; kept: string; dropped: string[] }[] } {
  const bySha = new Map<string, { first: T; dropped: string[] }>(), kept: T[] = [];
  for (const e of entries) {
    const seen = bySha.get(e.sha256);
    if (seen) seen.dropped.push(`${e.identifier}_${e.n}`); else { bySha.set(e.sha256, { first: e, dropped: [] }); kept.push(e); }
  }
  return { kept, duplicates: [...bySha.entries()].filter(([, v]) => v.dropped.length).map(([sha256, v]) => ({ sha256, kept: `${v.first.identifier}_${v.first.n}`, dropped: v.dropped })) };
}

/** The planted photo follows the host's highest shot number, so a gap in the host's numbering never makes it collide with a real shot. */
export const plantedShotNumber = (host: readonly { n: number }[]) => Math.max(...host.map(e => e.n)) + 1;

export function parseGolden(text: string): GoldenManifest {
  const raw = JSON.parse(text) as Partial<GoldenManifest>;
  if (raw.version !== 1 || !Array.isArray(raw.entries) || !raw.roots) throw new Error("Not a golden manifest.");
  return raw as GoldenManifest;
}
export const serializeGolden = (m: GoldenManifest) => `${JSON.stringify(m, null, 1)}\n`;

export function goldenCounts(m: GoldenManifest) {
  const products = new Set(m.entries.map(e => `${e.brand}|${e.identifier}`)), tags: Record<string, number> = {}, categories: Record<string, number> = {}, brands: Record<string, number> = {};
  for (const e of m.entries) { for (const t of e.tags) tags[t] = (tags[t] ?? 0) + 1; }
  for (const key of products) { const e = m.entries.find(x => `${x.brand}|${x.identifier}` === key)!; categories[e.category] = (categories[e.category] ?? 0) + 1; brands[e.brand] = (brands[e.brand] ?? 0) + 1; }
  return { products: products.size, photos: m.entries.length, brands, categories, tags, expectedAttention: [...products].filter(key => m.entries.some(e => `${e.brand}|${e.identifier}` === key && e.expect.attention)).length, planted: m.entries.filter(e => e.planted).length };
}

/** Reads every entry's bytes from the local roots and checks the sha256; throws on the first mismatch. */
export async function readGoldenBytes(m: GoldenManifest, entry: GoldenEntry): Promise<Buffer> {
  const root = m.roots[entry.source.root];
  if (!root) throw new Error(`The golden root ${entry.source.root} is not configured.`);
  const bytes = await readFile(path.join(root, entry.source.path));
  if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.source.root}/${entry.source.path} does not match its golden sha256; the owner's photo changed or the derived file was rebuilt differently.`);
  return bytes;
}
export const flagList = (flags: readonly string[]): OutputFlag[] => flags as OutputFlag[];
