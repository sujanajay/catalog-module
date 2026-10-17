// SKU resolution (spec 02, "SKU resolution"). Deterministic: no language model takes part.
//
// Order, stopping at the first hit, all on normalizeKey values and restricted to the batch's brand:
// option_key -> ean -> channel id -> product_code (trailing size segment removed) -> manual map ->
// unresolved. A hit returns every per-size opptra_sku of the matched option, sorted.
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
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

/** The option_key of the first matching row (by opptra_sku), or null. */
async function firstOptionKey(db: Db, brandSlug: string, where: SQL): Promise<string | null> {
  const [row] = await db
    .select({ optionKey: skuMap.optionKey })
    .from(skuMap)
    .where(and(eq(skuMap.brandSlug, brandSlug), where))
    .orderBy(asc(skuMap.opptraSku))
    .limit(1);
  return row?.optionKey ?? null;
}

async function optionResult(db: Db, brandSlug: string, optionKey: string, method: SkuMethod): Promise<ResolveResult> {
  const rows = await db
    .select({ opptraSku: skuMap.opptraSku, optionIdStyleColor: skuMap.optionIdStyleColor })
    .from(skuMap)
    .where(and(eq(skuMap.brandSlug, brandSlug), eq(skuMap.optionKey, optionKey)))
    .orderBy(asc(skuMap.opptraSku));
  return {
    optionIdStyleColor: rows.find((r) => r.optionIdStyleColor)?.optionIdStyleColor ?? null,
    opptraSkuIds: rows.map((r) => r.opptraSku),
    method,
  };
}

function inValues(values: string[]): SQL {
  return sql.join(values.map((v) => sql`${v}`), sql`, `);
}

export async function resolveSkus(db: Db, input: ResolveInput): Promise<ResolveResult> {
  const { brandSlug } = input;
  const idKey = normalizeKey(input.identifier.trim());
  const tryKey = async (where: SQL, method: SkuMethod): Promise<ResolveResult | null> => {
    const key = await firstOptionKey(db, brandSlug, where);
    return key === null ? null : optionResult(db, brandSlug, key, method);
  };

  if (idKey) {
    // 1. option_key (style+colour).
    const hit = await tryKey(eq(skuMap.optionKey, idKey), "option_key");
    if (hit) return hit;
  }

  // 2. EAN: the explicit ean, else the identifier itself (barcode-named files).
  const eans = unique([input.ean ? normalizeKey(input.ean.trim()) : "", idKey].filter(Boolean));
  if (eans.length) {
    const hit = await tryKey(sql`${skuMap.ean} IN (${inValues(eans)})`, "ean");
    if (hit) return hit;
  }

  // 3. Marketplace ids: the given channel ids plus the identifier.
  const ids = unique([...(input.channelIds ?? []).map((c) => normalizeKey(c.trim())), idKey].filter(Boolean));
  if (ids.length) {
    const where = sql`EXISTS (SELECT 1 FROM jsonb_each_text(${skuMap.channelIds}) AS e(key, value)
      WHERE e.key IN (${inValues([...RESOLVE_CHANNEL_KEYS])})
      AND ${normalizedSql(sql`e.value`)} IN (${inValues(ids)}))`;
    const hit = await tryKey(where, "channel_id");
    if (hit) return hit;
  }

  // 4. Per-size product code: the identifier with its size segment removed matches a product code
  //    with its size segment removed (or the full code matches exactly).
  if (idKey) {
    const strippedKey = normalizeKey(stripSizeSegment(input.identifier));
    const where = sql`(${normalizedSql(sql`regexp_replace(${skuMap.opptraSku}, ${SIZE_SEGMENT_RE}, '')`)} = ${strippedKey}
      OR ${normalizedSql(sql`${skuMap.opptraSku}`)} = ${idKey})`;
    const hit = await tryKey(where, "product_code");
    if (hit) return hit;
  }

  // 5. Manual mapping sheet (07): keys are normalised identifiers.
  const manual = input.manual?.get(idKey);
  if (manual && manual.length) {
    return { optionIdStyleColor: null, opptraSkuIds: unique(manual).sort(), method: "manual" };
  }

  return { optionIdStyleColor: null, opptraSkuIds: [], method: "unresolved" };
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
