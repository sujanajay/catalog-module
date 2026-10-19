// Real photos stay read-only. Only the in-memory delivery copies receive a run-specific name.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { brandSlug, parseShotName } from "@catalog/core/catalog/naming";
import { cellUrls, readSheetTable, urlFileName } from "@catalog/core/catalog/ingest/links-sheet";
import type { ProductType } from "@catalog/core/catalog/types";

export const dataRoot = () => process.env.REAL_DATA_DIR ?? "C:/Users/Sujan AH/Desktop/opptra-image-links";
export interface RealShot { name: string; originalName?: string; bytes: Buffer }
export interface RealFixture { slug: string; name: string; type: ProductType; shots: RealShot[]; urls: string[]; source: string }

async function files(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...await files(dir, rel));
    else if (/\.(jpg|jpeg|png|webp)$/i.test(entry.name)) found.push(rel);
  }
  return found.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

export async function localFixture(slug: string, full: boolean, run: string): Promise<RealFixture | null> {
  // test_brand (the permanent dummy brand) reuses the real Anta photos under its own slug.
  const testBrand = slug === "test_brand", anta = slug === "anta" || testBrand, fc = slug.replace(/_/g,"-") === "french-connection";
  if (!anta && !fc) return null;
  const dir = path.join(dataRoot(), anta ? "new_resources_4/Images" : "new_resources_3/French Connection Final");
  if (!existsSync(dir)) return null;
  const all = await files(dir);
  if (full && anta && !testBrand) assert.equal(all.length, 630, "The full Anta delivery must contain all 630 photos.");
  const groups = new Map<string, string[]>();
  for (const file of all) {
    const key = parseShotName(path.basename(file)).identifier;
    groups.set(key, [...groups.get(key) ?? [], file]);
  }
  const group = [...groups.values()].find(g => g.length >= 3);
  assert(group, `${slug} needs a real product with at least three shots for overwrite checks.`);
  const selected = full ? all : group;
  return { slug, name: testBrand ? "Test Brand" : anta ? "Anta" : "French Connection", type: anta ? "footwear" : "apparel_model", source: dir, urls: [],
    shots: await Promise.all(selected.map(async file => ({ name: `${run}-${path.basename(file)}`, originalName:file, bytes: await readFile(path.join(dir, file)) }))) };
}

/** Select genuine Campus/Keds rows by the delivery's brand cell or URL directory, never by a guessed filename. */
export async function sheetFixture(slug: "campus" | "keds" | "french-connection", full: boolean, run: string): Promise<RealFixture | null> {
  const selected = new Map<string, string>();
  const sources: string[] = [];
  for (const name of ["new_resources_3_image_links.xlsx", "new_resources_3_preview.xlsx"]) {
    const file = path.join(dataRoot(), "new_resources_3", name);
    if (!existsSync(file)) continue;
    const table = await readSheetTable(await readFile(file), name);
    for (const row of table.rows) {
      const urls = row.flatMap(cellUrls).filter(u => new URL(u).host.endsWith("supabase.co"));
      if (!row.some(cell => brandSlug(cell).replace(/_/g,"-") === slug) && !urls.some(u => decodeURIComponent(new URL(u).pathname).toLowerCase().split("/").includes(slug))) continue;
      for (const url of urls) {
        const shot = parseShotName(urlFileName(url));
        selected.set(`${shot.identifier}#${shot.n}`, url);
      }
    }
    sources.push(file);
  }
  if (!selected.size) return null;
  let urls = [...selected.values()];
  if (!full) {
    const grouped = new Map<string, string[]>();
    for (const url of urls) { const key = parseShotName(urlFileName(url)).identifier; grouped.set(key, [...grouped.get(key) ?? [], url]); }
    const group = [...grouped.values()].find(g => g.length >= 3);
    assert(group, `${slug} needs three real shots in the source sheets.`);
    urls = group;
  }
  return { slug, name: slug === "campus" ? "Campus" : slug === "keds" ? "Keds" : "French Connection", type: slug === "french-connection" ? "apparel_model" : "footwear", shots: [], urls: pastedLines(urls,run), source: sources.join(", ") };
}

/** The supported identifier<TAB>URL syntax isolates public product prefixes across test processes. */
export function pastedLines(urls: string[], run: string): string[] {
  return urls.map(url=>`${run}-${parseShotName(urlFileName(url)).identifier}\t${url}`);
}

/** Lossless PNG preserves every decoded pixel except one central RGB pixel. */
export async function changeOnePixel(bytes: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(bytes).toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const index = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;
  data[index] = data[index] === 255 ? 254 : data[index]! + 1;
  return sharp(data, { raw: info }).png().toBuffer();
}
