// Brand master and SKU map sync from the warehouse (spec 02, "Brand master and SKU map sync").
// Reads raw_gcc_dimensions.master_sl (softline) and raw_gcc_dimensions.sku_master_sheet_hl
// (hardline) from BigQuery, read only, and upserts brand_master and sku_map. Nothing is deleted.
//
// The BigQuery client is injected (BigQueryLike) so tests use a fake; createBigQuery() builds the
// real one for the worker and the tier 3 test.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  BRAND_LINES,
  SKU_CHANNEL_KEYS,
  brandMaster,
  skuMap,
  type BrandLine,
  type SkuChannelIds,
} from "../db/schema";
import { brandSlug, normalizeKey } from "./naming";
import { stripSizeSegment } from "./sku-mapping";

export interface BigQueryLike {
  query(options: { query: string; location?: string; params?: Record<string, unknown> }): Promise<[Record<string, unknown>[], unknown]>;
}
export interface SyncResult { brands: number; skus: number; warnings: string[] }

export const DEFAULT_BQ_PROJECT = "opptra-datawarehouse";
export const DEFAULT_BQ_LOCATION = "asia-south1";

// Columns confirmed on 2026-10-17 with
// SELECT column_name FROM raw_gcc_dimensions.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '...'.
// family_of_gcc_brand expects the aliased brand (its list is 'USPA', 'CAMPUS', ...), so it is
// applied to alias_gcc_brand(brand), not to the raw spelling. Rows come in sheet order so that the
// last row wins when a product code appears twice.
export const MASTER_SL_SQL = `SELECT product_code, option_id_style_color, ean, color, size,
  fact_gcc.alias_gcc_brand(brand) AS brand,
  fact_gcc.family_of_gcc_brand(fact_gcc.alias_gcc_brand(brand)) AS line,
  image_url, namshi_ae, namshi_sa, child_zsku, noon_ae, noon_sa, trendyol, centerpoint_ae_ksa,
  \`6th_street_ae\` AS sixth_street_ae, \`6th_street_sa\` AS sixth_street_sa,
  styli_ae_ksa, styli_sku, amazon, voga_closet, shein
FROM raw_gcc_dimensions.master_sl
ORDER BY source_row_number`;

// Hardline marketplace ids are mapped onto the sku_map.channel_ids keys: the two Noon UAE/KSA ids
// become noon_ae (marketplace SKU) and noon_sa (retail SKU), the Trendyol id becomes trendyol and
// the Styli KSA id (12 digits, the same shape as softline styli_sku) becomes styli_sku.
export const MASTER_HL_SQL = `SELECT sku, ean,
  fact_gcc.alias_gcc_brand(brand) AS brand,
  fact_gcc.family_of_gcc_brand(fact_gcc.alias_gcc_brand(brand)) AS line,
  amazon_uae_ksa_asin,
  noon_uae_ksa_marketplace_sku AS noon_ae, noon_uae_ksa_retail_sku AS noon_sa,
  trendyol_uae_ksa_id AS trendyol, styli_ksa_id AS styli_sku
FROM raw_gcc_dimensions.sku_master_sheet_hl
ORDER BY source_row_number`;

/** Thrown when a BigQuery read fails, so the worker can answer 503 and Cloud Scheduler retries. */
export class BigQuerySyncError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BigQuerySyncError";
  }
}

/** Real BigQuery client for BQ_PROJECT (default opptra-datawarehouse), using ADC. */
export async function createBigQuery(env: NodeJS.ProcessEnv = process.env): Promise<BigQueryLike> {
  const { BigQuery } = await import("@google-cloud/bigquery");
  const bq = new BigQuery({ projectId: env.BQ_PROJECT || DEFAULT_BQ_PROJECT });
  return {
    query: async (options) => {
      const [rows, job] = await bq.query(options);
      return [rows as Record<string, unknown>[], job];
    },
  };
}

interface SkuRow {
  opptraSku: string;
  brand: string;
  brandSlug: string;
  line: BrandLine;
  optionKey: string;
  optionIdStyleColor: string | null;
  ean: string | null;
  color: string | null;
  size: string | null;
  channelIds: SkuChannelIds;
  imageUrl: string | null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function channelIdsOf(row: Record<string, unknown>): SkuChannelIds {
  const out: SkuChannelIds = {};
  for (const key of SKU_CHANNEL_KEYS) {
    const v = str(row[key]);
    if (v !== null) out[key] = v;
  }
  return out;
}

function lineOf(v: unknown, fallback: BrandLine): BrandLine {
  const s = str(v);
  return s && (BRAND_LINES as readonly string[]).includes(s) ? (s as BrandLine) : fallback;
}

async function runQuery(bq: BigQueryLike, query: string, location: string, table: string): Promise<Record<string, unknown>[]> {
  try {
    const [rows] = await bq.query({ query, location });
    return rows;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BigQuerySyncError(`Reading ${table} from BigQuery failed: ${msg}`, { cause: err });
  }
}

const CHUNK = 1000;
const excluded = (col: string) => sql.raw(`excluded.${col}`);

/**
 * Upserts brand_master (by slug, source = warehouse) and sku_map (by opptra_sku, source =
 * warehouse) from the two warehouse masters. A manual brand or SKU row with the same key is taken
 * over by the warehouse and keeps its id. Nothing is deleted. `synced_at` is set on every touched row.
 */
export async function syncMaster(db: Db, bq: BigQueryLike, env: NodeJS.ProcessEnv = process.env): Promise<SyncResult> {
  const location = env.BQ_LOCATION || DEFAULT_BQ_LOCATION;
  const slRows = await runQuery(bq, MASTER_SL_SQL, location, "raw_gcc_dimensions.master_sl");
  const hlRows = await runQuery(bq, MASTER_HL_SQL, location, "raw_gcc_dimensions.sku_master_sheet_hl");

  const warnings: string[] = [];
  const skus = new Map<string, SkuRow>();
  const brands = new Map<string, { name: string; line: BrandLine }>();
  let noKey = 0;
  let noBrand = 0;
  let duplicates = 0;

  const add = (row: SkuRow) => {
    if (skus.has(row.opptraSku)) duplicates++;
    skus.set(row.opptraSku, row);
    if (!brands.has(row.brandSlug)) brands.set(row.brandSlug, { name: row.brand, line: row.line });
  };

  for (const r of slRows) {
    const opptraSku = str(r.product_code);
    const brand = str(r.brand);
    if (!opptraSku) { noKey++; continue; }
    if (!brand) { noBrand++; continue; }
    const optionIdStyleColor = str(r.option_id_style_color);
    add({
      opptraSku,
      brand,
      brandSlug: brandSlug(brand),
      line: lineOf(r.line, "softline"),
      // A row without an option id falls back to its product code minus the size segment.
      optionKey: normalizeKey(optionIdStyleColor ?? stripSizeSegment(opptraSku)),
      optionIdStyleColor,
      ean: str(r.ean),
      color: str(r.color),
      size: str(r.size),
      channelIds: channelIdsOf(r),
      imageUrl: str(r.image_url),
    });
  }
  for (const r of hlRows) {
    const opptraSku = str(r.sku);
    const brand = str(r.brand);
    if (!opptraSku) { noKey++; continue; }
    if (!brand) { noBrand++; continue; }
    add({
      opptraSku,
      brand,
      brandSlug: brandSlug(brand),
      line: lineOf(r.line, "hardline"),
      optionKey: normalizeKey(stripSizeSegment(opptraSku)),
      optionIdStyleColor: null,
      ean: str(r.ean),
      color: null,
      size: null,
      channelIds: channelIdsOf(r),
      imageUrl: null,
    });
  }
  if (noKey) warnings.push(`Skipped ${noKey} warehouse rows with no product code or SKU.`);
  if (noBrand) warnings.push(`Skipped ${noBrand} warehouse rows with no recognised brand.`);
  if (duplicates) warnings.push(`${duplicates} SKU codes appear more than once in the warehouse; the last row was kept.`);

  const syncedAt = new Date();
  await db.transaction(async (tx) => {
    const brandValues = [...brands].map(([slug, b]) => ({
      name: b.name, slug, line: b.line, source: "warehouse" as const, syncedAt,
    }));
    for (let i = 0; i < brandValues.length; i += CHUNK) {
      await tx
        .insert(brandMaster)
        .values(brandValues.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: brandMaster.slug,
          set: { name: excluded("name"), line: excluded("line"), source: excluded("source"), syncedAt: excluded("synced_at") },
        });
    }
    const skuValues = [...skus.values()].map((s) => ({ ...s, source: "warehouse" as const, syncedAt }));
    for (let i = 0; i < skuValues.length; i += CHUNK) {
      await tx
        .insert(skuMap)
        .values(skuValues.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: skuMap.opptraSku,
          set: {
            brand: excluded("brand"),
            brandSlug: excluded("brand_slug"),
            line: excluded("line"),
            optionKey: excluded("option_key"),
            optionIdStyleColor: excluded("option_id_style_color"),
            ean: excluded("ean"),
            color: excluded("color"),
            size: excluded("size"),
            channelIds: excluded("channel_ids"),
            imageUrl: excluded("image_url"),
            source: excluded("source"),
            syncedAt: excluded("synced_at"),
          },
        });
    }
  });

  return { brands: brands.size, skus: skus.size, warnings };
}
