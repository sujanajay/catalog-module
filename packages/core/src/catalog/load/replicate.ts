// Load test replication (spec 09 section 4.1): real products are repeated under generated
// identifiers `LT<k>_<identifier>` until the wanted number of options exists. File names stay
// `<identifier>_<n>.<ext>`, so 02's parseShotName reads the same identifier and shot number back.
import { parseShotName } from "../naming";

/** Run A's full scale; the default for a run is set by the driver (one tenth on the first go-live). */
export const FULL_LOAD_OPTIONS = 2700;
/** Options use real products with 3 to 5 shots (the plan's "3 to 5 shots each"). */
export const MIN_SHOTS = 3;
export const MAX_SHOTS = 5;

export interface SourceProduct<T> { identifier: string; shots: { n: number; ext: string; item: T }[] }
export interface LoadShot<T> { name: string; n: number; item: T }
export interface LoadOption<T> { identifier: string; shots: LoadShot<T>[] }

/** `LT<k>_<identifier>`, k counting from 1. */
export function loadIdentifier(k: number, identifier: string): string {
  if (!Number.isInteger(k) || k < 1) throw new Error(`The replica number must be a positive integer, got ${k}.`);
  return `LT${k}_${identifier}`;
}

/** Group file names into products by 02's parseShotName; files without a shot number are left out. */
export function groupSourceFiles<T>(files: { name: string; item: T }[]): SourceProduct<T>[] {
  const groups = new Map<string, SourceProduct<T>>();
  for (const file of files) {
    const parsed = parseShotName(file.name);
    if (!parsed.identifier || parsed.n === null || parsed.suffix) continue;
    const dot = file.name.lastIndexOf(".");
    const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "jpg";
    const group = groups.get(parsed.identifier) ?? { identifier: parsed.identifier, shots: [] };
    if (!group.shots.some(s => s.n === parsed.n)) group.shots.push({ n: parsed.n, ext, item: file.item });
    groups.set(parsed.identifier, group);
  }
  return [...groups.values()].map(g => ({ ...g, shots: [...g.shots].sort((a, b) => a.n - b.n) }));
}

/**
 * `count` options built from the eligible products (3 or more shots, the first 5 kept), cycling
 * through them; the k-th pass over the list prefixes `LT<k>_`. Deterministic: the same input and
 * count give the same names, so Run B repeats Run A's products exactly.
 */
export function replicateOptions<T>(products: SourceProduct<T>[], count: number): LoadOption<T>[] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`The number of options must be a positive integer, got ${count}.`);
  const eligible = products.filter(p => p.shots.length >= MIN_SHOTS).sort((a, b) => (a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0));
  if (!eligible.length) throw new Error(`No real product has at least ${MIN_SHOTS} shots.`);
  const options: LoadOption<T>[] = [];
  for (let i = 0; i < count; i++) {
    const source = eligible[i % eligible.length]!, k = Math.floor(i / eligible.length) + 1;
    const identifier = loadIdentifier(k, source.identifier);
    options.push({ identifier, shots: source.shots.slice(0, MAX_SHOTS).map((s, j) => ({ name: `${identifier}_${j + 1}.${s.ext}`, n: j + 1, item: s.item })) });
  }
  return options;
}

/** Split the files into zips of at most `perZip` files, never splitting one option over two zips. */
export function zipGroups<O extends { shots: readonly unknown[] }>(options: readonly O[], perZip: number): O[][] {
  const groups: O[][] = [];
  let current: O[] = [], size = 0;
  for (const option of options) {
    if (current.length && size + option.shots.length > perZip) { groups.push(current); current = []; size = 0; }
    current.push(option); size += option.shots.length;
  }
  if (current.length) groups.push(current);
  return groups;
}
