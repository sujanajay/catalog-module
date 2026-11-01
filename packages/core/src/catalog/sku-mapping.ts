// SKU resolution (spec 02, "SKU resolution"). Deterministic: no language model takes part.
//
// Order, stopping at the first hit, all on normalizeKey values and restricted to the batch's brand:
// option_key -> ean -> channel id -> product_code (trailing size segment removed) -> manual map ->
// unresolved. A hit returns every per-size opptra_sku of the matched option, sorted.
import { asc, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { skuMap } from "../db/schema";
import { normalizeKey } from "./naming";

export type SkuMethod = "option_key" | "ean" | "channel_id" | "product_code" | "manual" | "unresolved";
export interface ResolveInput {
  brandSlug: string;
  identifier: string;
  ean?: string | null;
  channelIds?: string[];
  manual?: Map<string, string[]>;
}
export interface ResolveResult { optionIdStyleColor: string | null; opptraSkuIds: string[]; method: SkuMethod }

/** channel_ids keys searched by the channel id step. */
export const RESOLVE_CHANNEL_KEYS = [
  "styli_sku", "styli_ae_ksa", "child_zsku", "noon_ae", "noon_sa", "amazon", "amazon_uae_ksa_asin",
] as const;

/** Postgres regex that matches what normalizeKey removes (whitespace, "_" and "-"). */
const STRIP_RE = "[\\s_-]";
/** Postgres regex for the trailing `_<size>` segment of a per-size product code. */
const SIZE_SEGMENT_RE = "_[^_]*$";

/**
 * Removes the trailing `_<size>` segment of a per-size product code
 * (`10148253_BrightWhite_OD_M` -> `10148253_BrightWhite_OD`). Codes without "_" (hardline SKUs
 * such as `BGIN-9235`) have no size segment and are returned unchanged.
 */
export function stripSizeSegment(code: string): string {
  const s = code.trim();
  const i = s.lastIndexOf("_");
  return i > 0 ? s.slice(0, i) : s;
}

const normalizedSql = (expr: SQL): SQL => sql`upper(regexp_replace(${expr}, ${STRIP_RE}, '', 'g'))`;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** One sku_map row as the resolver holds it; the normalised forms are computed by Postgres, as the per-query version compared them. */
interface ResolverRow {
  opptraSku: string;
  optionKey: string;
  optionIdStyleColor: string | null;
  ean: string | null;
  /** normalised(opptra_sku with its size segment removed by SIZE_SEGMENT_RE). */
  strippedCode: string;
  /** normalised(opptra_sku). */
  fullCode: string;
  /** normalised values of the RESOLVE_CHANNEL_KEYS entries of channel_ids. */
  channelValues: string[];
}

/** Resolves SKUs for one brand from rows read once (loadSkuResolver). */
export interface SkuResolver {
  brandSlug: string;
  /** How many sku_map rows were read. */
  rows: number;
  resolve(input: Omit<ResolveInput, "brandSlug"> & { brandSlug?: string }): ResolveResult;
}

/** Keeps the first row seen per key: rows are visited in opptra_sku order, so that is the first hit by opptra_sku. */
function firstBy(map: Map<string, number>, key: string | null | undefined, rank: number): void {
  if (key !== null && key !== undefined && !map.has(key)) map.set(key, rank);
}

/**
 * Reads the brand's sku_map rows once and returns a resolver with exactly resolveSkus' order and results
 * (spec 02, "SKU resolution"), so a batch resolves every product with one query instead of up to four per
 * product, two of them full scans of the brand's rows. Rows come back in Postgres' own `ORDER BY opptra_sku`
 * (its collation decides "first", as before), and the stored values are normalised by the same SQL
 * expressions the per-query version used; the input side uses normalizeKey and stripSizeSegment as before.
 */
export async function loadSkuResolver(db: Db, brandSlug: string): Promise<SkuResolver> {
  const channelKeys = sql.join(RESOLVE_CHANNEL_KEYS.map((k) => sql`${k}`), sql`, `);
  const rows = (await db
    .select({
      opptraSku: skuMap.opptraSku,
      optionKey: skuMap.optionKey,
      optionIdStyleColor: skuMap.optionIdStyleColor,
      ean: skuMap.ean,
      strippedCode: sql<string>`${normalizedSql(sql`regexp_replace(${skuMap.opptraSku}, ${SIZE_SEGMENT_RE}, '')`)}`,
      fullCode: sql<string>`${normalizedSql(sql`${skuMap.opptraSku}`)}`,
      channelValues: sql<string[]>`ARRAY(SELECT ${normalizedSql(sql`e.value`)} FROM jsonb_each_text(${skuMap.channelIds}) AS e(key, value) WHERE e.key IN (${channelKeys}))`,
    })
    .from(skuMap)
    .where(eq(skuMap.brandSlug, brandSlug))
    .orderBy(asc(skuMap.opptraSku))) as ResolverRow[];

  const byOptionKey = new Map<string, number>();
  const byEan = new Map<string, number>();
  const byChannel = new Map<string, number>();
  const byStripped = new Map<string, number>();
  const byFull = new Map<string, number>();
  const ranksOfOption = new Map<string, number[]>();
  rows.forEach((r, rank) => {
    firstBy(byOptionKey, r.optionKey, rank);
    firstBy(byEan, r.ean, rank);
    for (const v of r.channelValues ?? []) firstBy(byChannel, v, rank);
    firstBy(byStripped, r.strippedCode, rank);
    firstBy(byFull, r.fullCode, rank);
    const list = ranksOfOption.get(r.optionKey);
    if (list) list.push(rank);
    else ranksOfOption.set(r.optionKey, [rank]);
  });

  /** The first row (lowest rank) any of `keys` finds in `map`, or null. */
  const first = (map: Map<string, number>, keys: string[]): number | null => {
    let best: number | null = null;
    for (const k of keys) {
      const r = map.get(k);
      if (r !== undefined && (best === null || r < best)) best = r;
    }
    return best;
  };
  const optionResult = (rank: number, method: SkuMethod): ResolveResult => {
    const option = (ranksOfOption.get(rows[rank]!.optionKey) ?? []).map((i) => rows[i]!);
    return {
      optionIdStyleColor: option.find((r) => r.optionIdStyleColor)?.optionIdStyleColor ?? null,
      opptraSkuIds: option.map((r) => r.opptraSku),
      method,
    };
  };

  return {
    brandSlug,
    rows: rows.length,
    resolve(input) {
      if (input.brandSlug !== undefined && input.brandSlug !== brandSlug) {
        throw new Error(`This SKU resolver holds ${brandSlug}, not ${input.brandSlug}.`);
      }
      const idKey = normalizeKey(input.identifier.trim());
      const hit = (rank: number | null, method: SkuMethod) => (rank === null ? null : optionResult(rank, method));

      // 1. option_key (style+colour).
      if (idKey) {
        const r = hit(first(byOptionKey, [idKey]), "option_key");
        if (r) return r;
      }
      // 2. EAN: the explicit ean, else the identifier itself (barcode-named files).
      const eans = unique([input.ean ? normalizeKey(input.ean.trim()) : "", idKey].filter(Boolean));
      if (eans.length) {
        const r = hit(first(byEan, eans), "ean");
        if (r) return r;
      }
      // 3. Marketplace ids: the given channel ids plus the identifier.
      const ids = unique([...(input.channelIds ?? []).map((c) => normalizeKey(c.trim())), idKey].filter(Boolean));
      if (ids.length) {
        const r = hit(first(byChannel, ids), "channel_id");
        if (r) return r;
      }
      // 4. Per-size product code: the identifier with its size segment removed matches a product code
      //    with its size segment removed (or the full code matches exactly).
      if (idKey) {
        const strippedKey = normalizeKey(stripSizeSegment(input.identifier));
        const a = first(byStripped, [strippedKey]);
        const b = first(byFull, [idKey]);
        const r = hit(a === null ? b : b === null ? a : Math.min(a, b), "product_code");
        if (r) return r;
      }
      // 5. Manual mapping sheet (07): keys are normalised identifiers.
      const manual = input.manual?.get(idKey);
      if (manual && manual.length) {
        return { optionIdStyleColor: null, opptraSkuIds: unique(manual).sort(), method: "manual" };
      }
      return { optionIdStyleColor: null, opptraSkuIds: [], method: "unresolved" };
    },
  };
}

/** One product's SKUs (one query). A batch resolves many products with one loadSkuResolver instead. */
export async function resolveSkus(db: Db, input: ResolveInput): Promise<ResolveResult> {
  return (await loadSkuResolver(db, input.brandSlug)).resolve(input);
}

/**
 * Parses the manual mapping sheet: columns identifier, opptra_sku_id; several rows per identifier
 * allowed. A header row (first cell "identifier") and blank rows are skipped. Keys are
 * normalizeKey(identifier); values are unique SKU ids, sorted.
 */
export function parseManualMapping(rows: string[][]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  rows.forEach((row, i) => {
    const identifier = (row[0] ?? "").trim();
    const sku = (row[1] ?? "").trim();
    if (i === 0 && identifier.toLowerCase() === "identifier") return;
    if (!identifier || !sku) return;
    const key = normalizeKey(identifier);
    const list = out.get(key) ?? [];
    if (!list.includes(sku)) list.push(sku);
    out.set(key, list);
  });
  for (const [k, v] of out) out.set(k, v.sort());
  return out;
}
