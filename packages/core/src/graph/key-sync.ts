// M0-S2 graph sync (docs/program/requirements/M0-catalog-graph.md F1-R1 to F1-R6 and F1-R8; decisions D15 to D20):
// builds options, channel listings, listing keys, the key conflict list and the style key from sku_map plus the
// warehouse's sales and channel-report keys, then links tool products to their option. Runs after each master sync.
//
// BigQuery is read only; every read happens before the first write, so a BigQuery failure leaves the previous graph as
// it was (F1 edge cases). Nothing in the graph is deleted except a sync-written key that now points at two listings
// (F1-R5: such a key is not written; it goes to catalog_key_conflicts). Keys written by a scrape or by hand are never
// touched. One transaction under an advisory lock, so two syncs never interleave; products are linked after it commits,
// in small statements, so a running batch never waits on the graph transaction.
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import type { BigQueryLike } from "../catalog/master-sync";
import { BigQuerySyncError, DEFAULT_BQ_LOCATION } from "../catalog/master-sync";
import { stripSizeSegment } from "../catalog/sku-mapping";
import type { ChannelId } from "../catalog/types";
import type { Db } from "../db/client";
import {
  catalogChannelListings,
  catalogKeyConflicts,
  catalogKeyMappings,
  catalogListingKeys,
  catalogOptions,
  catalogProducts,
  skuMap,
  type KeyConflictCandidate,
  type SkuChannelKey,
} from "../db/schema";
import { colourVocabulary, styleKeyFor, styleKeyMinConfidence } from "./style-key";
import { DEFAULT_ORG_ID, KEY_KINDS, type KeyKind, type KeySource, type Market, type OptionKeySource, type StyleKeySource } from "./types";

// ---------------------------------------------------------------------------
// Warehouse reads (read only). Unqualified names resolve in BQ_PROJECT: the warehouse itself, or the image-links-agent
// mirror that infra/bq-mirror.sh keeps (same dataset and table names, key columns only).
// ---------------------------------------------------------------------------

/**
 * Per-SKU attributes the sku_map does not hold: the sheet's style code and the category and gender words. One row per
 * code (D20): about 257 softline codes appear twice in master_sl, one row with the style code and one blank, so the row
 * with a style code wins, then the latest sheet row (the one the master sync keeps).
 */
export const GRAPH_MASTER_ATTRS_SQL = `SELECT TRIM(product_code) AS product_code, description_1, category_name, gender
FROM raw_gcc_dimensions.master_sl
WHERE IFNULL(TRIM(product_code), '') != ''
QUALIFY ROW_NUMBER() OVER (PARTITION BY TRIM(product_code)
  ORDER BY IF(IFNULL(TRIM(description_1), '') = '', 1, 0), source_row_number DESC) = 1`;

/** The marketing option id of each SKU (F1-R2, second choice). sku_key is the upper-case product code. */
export const GRAPH_SKU_OPTION_SQL = `SELECT sku_key, option_id
FROM gcc_marketing.sku_option
WHERE IFNULL(TRIM(option_id), '') != ''`;

/** Sales channels the graph knows, as the sales table spells them. */
export const SALES_CHANNELS: Record<string, ChannelId> = {
  Namshi: "namshi", Noon: "noon", Trendyol: "trendyol", Amazon: "amazon", Styli: "styli",
  Centrepoint: "centrepoint", "6th Street": "sixthstreet", Shein: "shein",
};
const SALES_MARKETS: Record<string, Market> = { UAE: "ae", KSA: "sa" };

/**
 * How far back sales keys are read (D20): long enough to cover the 12-week join and M4's pre-period, short enough that a
 * key the channel moved to another SKU stops being proposed for the old one and its conflict resolves.
 */
export const SALES_KEY_WINDOW_DAYS = 182;

/** Channel SKUs and style ids seen on sale rows in the window (F1-R4). Key columns only: no order, customer or money field. */
export const GRAPH_SALES_KEYS_SQL = `SELECT DISTINCT mapped_opptra_sku, channel, country, channel_sku, style_id
FROM fact_gcc.unified_sales_tertiary_v2
WHERE channel IN (${Object.keys(SALES_CHANNELS).map((c) => `'${c}'`).join(", ")})
  AND country IN ('UAE', 'KSA')
  AND ordered_date >= DATE_SUB(CURRENT_DATE(), INTERVAL ${SALES_KEY_WINDOW_DAYS} DAY)
  AND IFNULL(TRIM(mapped_opptra_sku), '') != ''`;

/** The kind of a sales row's channel_sku per channel (checked against the master on 2026-11-04, decision D16). */
export const SALES_KEY_KINDS: Record<ChannelId, KeyKind> = {
  namshi: "child_zsku", noon: "child_zsku", trendyol: "barcode", amazon: "asin", styli: "child_zsku",
  centrepoint: "child_zsku", sixthstreet: "barcode", shein: "child_zsku", vogacloset: "child_zsku",
};

/**
 * Channel-report keys (F1-R4): Amazon seller SKU and ASIN per market, Noon partner SKU and child zsku, Trendyol barcode
 * per market, each tied to a master SKU by its own code or by a key the master already has. market null: the report
 * does not say (Noon); the key goes on the option's existing listings of that channel.
 */
export const GRAPH_REPORT_KEYS_SQL = `WITH m AS (
  SELECT TRIM(product_code) AS opptra_sku, UPPER(TRIM(product_code)) AS pc, UPPER(TRIM(amazon)) AS asin,
    UPPER(TRIM(noon_ae)) AS noon_partner, UPPER(TRIM(child_zsku)) AS child_zsku, UPPER(TRIM(trendyol)) AS barcode,
    UPPER(TRIM(ean)) AS ean
  FROM raw_gcc_dimensions.master_sl WHERE IFNULL(TRIM(product_code), '') != ''
),
amazon AS (
  SELECT 'ae' AS market, TRIM(seller_sku) AS seller_sku, TRIM(asin1) AS asin FROM dimensions.sku_master_amazon_ae
  UNION DISTINCT SELECT 'sa', TRIM(seller_sku), TRIM(asin1) FROM dimensions.sku_master_amazon_sa
),
noon AS (SELECT DISTINCT TRIM(partner_sku) AS partner_sku, TRIM(sku_child) AS sku_child FROM dimensions.sku_master_noon),
trendyol AS (
  SELECT DISTINCT 'ae' AS market, TRIM(barcode) AS barcode, TRIM(supplier_stock_code) AS stock_code
    FROM gcc_channel_reports.product_list_trendyol_3p_uae
  UNION DISTINCT SELECT DISTINCT 'sa', TRIM(barcode), TRIM(supplier_stock_code)
    FROM gcc_channel_reports.product_list_trendyol_3p_ksa
),
keys AS (
  SELECT m.opptra_sku, 'amazon' AS channel, a.market, 'seller_sku' AS key_kind, a.seller_sku AS key_value
    FROM amazon a JOIN m ON m.pc = UPPER(a.seller_sku) OR m.asin = UPPER(a.asin)
  UNION DISTINCT SELECT m.opptra_sku, 'amazon', a.market, 'asin', a.asin
    FROM amazon a JOIN m ON m.pc = UPPER(a.seller_sku) OR m.asin = UPPER(a.asin)
  UNION DISTINCT SELECT m.opptra_sku, 'noon', CAST(NULL AS STRING), 'partner_sku', n.partner_sku
    FROM noon n JOIN m ON m.pc = UPPER(n.partner_sku) OR m.noon_partner = UPPER(n.partner_sku) OR m.child_zsku = UPPER(n.sku_child)
  UNION DISTINCT SELECT m.opptra_sku, 'noon', CAST(NULL AS STRING), 'child_zsku', n.sku_child
    FROM noon n JOIN m ON m.pc = UPPER(n.partner_sku) OR m.noon_partner = UPPER(n.partner_sku) OR m.child_zsku = UPPER(n.sku_child)
  UNION DISTINCT SELECT m.opptra_sku, 'trendyol', t.market, 'barcode', t.barcode
    FROM trendyol t JOIN m ON m.barcode = UPPER(t.barcode) OR m.ean = UPPER(t.barcode) OR m.pc = UPPER(t.stock_code)
)
SELECT opptra_sku, channel, market, key_kind, key_value FROM keys
WHERE IFNULL(TRIM(key_value), '') NOT IN ('', '0')`;

// ---------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------

export type GraphSku = {
  opptraSku: string;
  brandSlug: string;
  optionIdStyleColor: string | null;
  color: string | null;
  channelIds: Partial<Record<SkuChannelKey, string>>;
};
export type GraphMapping = { skuColumn: SkuChannelKey; channel: ChannelId | null; market: Market | null; keyKind: KeyKind };
export type MasterAttrs = { styleCode: string | null; productType: string | null; audience: string | null };
export type SalesKeyRow = { opptraSku: string; channel: ChannelId; market: Market; channelSku: string | null; styleId: string | null };
export type ReportKeyRow = { opptraSku: string; channel: ChannelId; market: Market | null; keyKind: KeyKind; keyValue: string };

export type GraphInputs = {
  skus: GraphSku[];
  mappings: GraphMapping[];
  /** By opptra_sku, from the current master; a SKU missing here has left the master. */
  attrs: Map<string, MasterAttrs>;
  /** By upper-case opptra_sku. */
  skuOptions: Map<string, string>;
  sales: SalesKeyRow[];
  reports: ReportKeyRow[];
  minConfidence: number;
};

export type PlannedOption = {
  ref: string;
  brandSlug: string;
  optionKey: string;
  keySource: OptionKeySource;
  productType: string | null;
  audience: string | null;
  inMaster: boolean;
  styleKey: string;
  styleKeySource: StyleKeySource;
  styleKeyConfidence: number;
  skus: string[];
};
export type PlannedListing = { optionRef: string; channel: ChannelId; market: Market };
export type PlannedKey = {
  listing: string; // listingRef
  channel: ChannelId;
  market: Market;
  keyKind: KeyKind;
  keyValue: string;
  opptraSku: string | null;
  source: KeySource;
};
export type GraphPlan = {
  options: Map<string, PlannedOption>;
  listings: Map<string, PlannedListing>;
  keys: PlannedKey[];
  /** opptra_sku to option ref, for product linking. */
  skuOption: Map<string, string>;
  unresolvedSalesRows: number;
  unresolvedReportRows: number;
  /** Sales and report rows of SKUs that left the master: they propose no key (D20). */
  departedSkuRows: number;
};

export const optionRef = (brandSlug: string, optionKey: string) => `${brandSlug}\u0000${optionKey}`;
export const listingRef = (optRef: string, channel: string, market: string) => `${optRef}\u0001${channel}\u0001${market}`;
/** Key identity, the unique key of catalog_listing_keys. */
export const keyRef = (k: { channel: string; market: string; keyKind: string; keyValue: string }) =>
  `${k.channel}\u0001${k.market}\u0001${k.keyKind}\u0001${k.keyValue}`;

/** A key value, or null for blanks and the literal "0" (F1 edge cases). */
export function keyValueOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" || s === "0" ? null : s;
}

const SOURCE_RANK: Record<KeySource, number> = { master: 0, channel_report: 1, sales: 2, scrape: 3, manual: 4 };
/** Sources the sync owns; keys from any other source (scrape, manual) are never changed by it. */
export const SYNC_KEY_SOURCES: readonly KeySource[] = ["master", "channel_report", "sales"];

/**
 * Builds the whole graph in memory from the inputs. Pure and deterministic: SKUs are taken in code order, so the input
 * order never changes an option's style key or attributes.
 *
 * Only SKUs in the current master (`attrs`) propose keys (D20). A SKU that left the master stays in sku_map with its old
 * channel ids; if it still proposed them, a key the channel moved to another SKU would be a conflict forever. Its
 * option is kept, out of the master, and the keys written for it earlier stay until another listing claims them.
 */
export function planGraph(input: GraphInputs): GraphPlan {
  const vocab = colourVocabulary(input.skus.map((s) => s.color));
  const options = new Map<string, PlannedOption>();
  const skuOption = new Map<string, string>();
  const skus = [...input.skus].sort((a, b) => (a.opptraSku < b.opptraSku ? -1 : a.opptraSku > b.opptraSku ? 1 : 0));
  const current = (sku: string) => input.attrs.has(sku);

  // Options (F1-R1, F1-R2) and the style key (F1-R8).
  for (const s of skus) {
    const master = s.optionIdStyleColor ? normalizeSpaces(s.optionIdStyleColor) : "";
    const marketing = input.skuOptions.get(s.opptraSku.toUpperCase());
    const [optionKey, keySource]: [string, OptionKeySource] = master
      ? [master, "master"]
      : marketing
        ? [normalizeSpaces(marketing), "sku_option"]
        : [`sku:${s.opptraSku}`, "sku_fallback"];
    const ref = optionRef(s.brandSlug, optionKey);
    const attrs = input.attrs.get(s.opptraSku);
    let o = options.get(ref);
    if (!o) {
      const text = keySource === "sku_fallback" ? stripSizeSegment(s.opptraSku) : optionKey;
      const style = styleKeyFor({ brandSlug: s.brandSlug, optionKey, styleCode: attrs?.styleCode, text }, vocab, input.minConfidence);
      o = {
        ref, brandSlug: s.brandSlug, optionKey, keySource,
        productType: attrs?.productType ?? null, audience: attrs?.audience ?? null, inMaster: false,
        styleKey: style.styleKey, styleKeySource: style.source, styleKeyConfidence: style.confidence, skus: [],
      };
      options.set(ref, o);
    } else if (attrs?.styleCode && o.styleKeySource !== "brand_style_code") {
      // A later SKU of the option carries the sheet's style code: it wins over the rule.
      const style = styleKeyFor({ brandSlug: s.brandSlug, optionKey, styleCode: attrs.styleCode, text: optionKey }, vocab, input.minConfidence);
      Object.assign(o, { styleKey: style.styleKey, styleKeySource: style.source, styleKeyConfidence: style.confidence });
    }
    o.productType ??= attrs?.productType ?? null;
    o.audience ??= attrs?.audience ?? null;
    if (attrs) o.inMaster = true;
    o.skus.push(s.opptraSku);
    skuOption.set(s.opptraSku, ref);
  }

  const listings = new Map<string, PlannedListing>();
  const optionListings = new Map<string, Set<string>>(); // optionRef -> listing refs
  const skuListings = new Map<string, Set<string>>(); // opptraSku -> listing refs
  const keys: PlannedKey[] = [];
  const addListing = (optRef: string, channel: ChannelId, market: Market): string => {
    const ref = listingRef(optRef, channel, market);
    if (!listings.has(ref)) {
      listings.set(ref, { optionRef: optRef, channel, market });
      setOf(optionListings, optRef).add(ref);
    }
    return ref;
  };
  const addKey = (sku: string, lRef: string, keyKind: KeyKind, keyValue: string, source: KeySource) => {
    const l = listings.get(lRef)!;
    keys.push({ listing: lRef, channel: l.channel, market: l.market, keyKind, keyValue, opptraSku: sku, source });
    setOf(skuListings, sku).add(lRef);
  };

  // Markets seen in sales and reports per channel key value, for mappings with no market (trendyol, amazon).
  const seenMarkets = new Map<string, Set<Market>>();
  for (const r of input.sales) {
    const v = keyValueOf(r.channelSku);
    if (v) setOf(seenMarkets, `${r.channel}\u0001${v.toUpperCase()}`).add(r.market);
  }
  for (const r of input.reports) if (r.market) setOf(seenMarkets, `${r.channel}\u0001${r.keyValue.toUpperCase()}`).add(r.market);

  // Master keys (F1-R3). child_zsku-like mappings (channel null) wait until every listing of the SKU is known.
  const everyListing = input.mappings.filter((m) => m.channel === null);
  for (const s of skus) {
    if (!current(s.opptraSku)) continue;
    const optRef = skuOption.get(s.opptraSku)!;
    for (const m of input.mappings) {
      if (m.channel === null) continue;
      const v = keyValueOf(s.channelIds[m.skuColumn]);
      if (!v) continue;
      const markets: Market[] = m.market ? [m.market] : [...(seenMarkets.get(`${m.channel}\u0001${v.toUpperCase()}`) ?? new Set<Market>(["ae_sa"]))];
      for (const market of markets.sort()) addKey(s.opptraSku, addListing(optRef, m.channel, market), m.keyKind, v, "master");
    }
  }

  // Sales and channel-report keys (F1-R4). On a channel whose master keys are all one-key-for-both (ae_sa: Styli,
  // Centrepoint, Shein) the key always goes on the ae_sa listing (D16). Elsewhere a market-specific key uses the option's
  // listing in that market, else its ae_sa listing, else a new listing in that market.
  const bothMarkets = new Set<ChannelId>();
  for (const m of input.mappings) if (m.channel && input.mappings.every((x) => x.channel !== m.channel || x.market === "ae_sa")) bothMarkets.add(m.channel);
  const listingFor = (optRef: string, channel: ChannelId, market: Market): string => {
    if (bothMarkets.has(channel)) return addListing(optRef, channel, "ae_sa");
    const exact = listingRef(optRef, channel, market);
    if (listings.has(exact)) return exact;
    const both = listingRef(optRef, channel, "ae_sa");
    if (listings.has(both)) return both;
    return addListing(optRef, channel, market);
  };
  let unresolvedSalesRows = 0;
  let departedSkuRows = 0;
  for (const r of input.sales) {
    const optRef = skuOption.get(r.opptraSku);
    if (!optRef) { unresolvedSalesRows++; continue; }
    if (!current(r.opptraSku)) { departedSkuRows++; continue; }
    const lRef = listingFor(optRef, r.channel, r.market);
    const v = keyValueOf(r.channelSku);
    if (v) addKey(r.opptraSku, lRef, SALES_KEY_KINDS[r.channel], v, "sales");
    const style = keyValueOf(r.styleId);
    if (style) addKey(r.opptraSku, lRef, "style_id", style, "sales");
  }
  let unresolvedReportRows = 0;
  for (const r of input.reports) {
    const optRef = skuOption.get(r.opptraSku);
    if (!optRef) { unresolvedReportRows++; continue; }
    if (!current(r.opptraSku)) { departedSkuRows++; continue; }
    const targets = r.market
      ? [listingFor(optRef, r.channel, r.market)]
      : [...(optionListings.get(optRef) ?? [])].filter((ref) => listings.get(ref)!.channel === r.channel);
    if (targets.length === 0) targets.push(addListing(optRef, r.channel, "ae_sa"));
    for (const lRef of targets) addKey(r.opptraSku, lRef, r.keyKind, r.keyValue, "channel_report");
  }

  // Keys that go on every listing of the SKU (child_zsku).
  for (const m of everyListing) {
    for (const s of skus) {
      if (!current(s.opptraSku)) continue;
      const v = keyValueOf(s.channelIds[m.skuColumn]);
      if (!v) continue;
      for (const lRef of [...(skuListings.get(s.opptraSku) ?? [])].sort()) addKey(s.opptraSku, lRef, m.keyKind, v, "master");
    }
  }

  return { options, listings, keys, skuOption, unresolvedSalesRows, unresolvedReportRows, departedSkuRows };
}

function normalizeSpaces(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function setOf<K, V>(m: Map<K, Set<V>>, k: K): Set<V> {
  let s = m.get(k);
  if (!s) m.set(k, (s = new Set()));
  return s;
}

/** One proposed key after merging every proposal for the same identity. */
export type MergedKey = {
  channel: ChannelId;
  market: Market;
  keyKind: KeyKind;
  keyValue: string;
  /** listing ref to the best source and the SKUs that proposed it. */
  candidates: Map<string, { source: KeySource; skus: Set<string> }>;
};

/** Groups planned keys by identity (channel, market, kind, value). */
export function mergeKeys(keys: PlannedKey[]): Map<string, MergedKey> {
  const out = new Map<string, MergedKey>();
  for (const k of keys) {
    const id = keyRef(k);
    let m = out.get(id);
    if (!m) out.set(id, (m = { channel: k.channel, market: k.market, keyKind: k.keyKind, keyValue: k.keyValue, candidates: new Map() }));
    const c = m.candidates.get(k.listing);
    if (!c) m.candidates.set(k.listing, { source: k.source, skus: new Set(k.opptraSku ? [k.opptraSku] : []) });
    else {
      if (SOURCE_RANK[k.source] < SOURCE_RANK[c.source]) c.source = k.source;
      if (k.opptraSku) c.skus.add(k.opptraSku);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sync (reads, plan, one write transaction, product links)
// ---------------------------------------------------------------------------

/** Single-bigint advisory key of the graph sync ("M0" namespace, slot 2); the cursor lock uses the two-int4 form. */
export const GRAPH_SYNC_LOCK = 0x4d30_0002;
const CHUNK = 1000;

export type GraphSyncResult = {
  skipped?: "locked";
  options: number;
  /** Planned options none of whose SKUs is in the current master. */
  optionsNotInMaster: number;
  /** Options newly marked out of the master because no softline SKU produces them any more (for example re-keyed). */
  optionsWithoutSkus: number;
  listings: number;
  keys: { inserted: number; moved: number; unchanged: number; removedForConflict: number };
  conflicts: { open: number; resolved: number };
  products: { linked: number; unresolved: number };
  unresolvedSalesRows: number;
  unresolvedReportRows: number;
  departedSkuRows: number;
  /** Set when the graph was written but linking products to options failed after the commit (F1-R6). */
  productsError?: string;
};

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

async function readBq(bq: BigQueryLike, query: string, location: string, what: string): Promise<Record<string, unknown>[]> {
  try {
    const [rows] = await bq.query({ query, location });
    return rows;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new BigQuerySyncError(`Reading ${what} from BigQuery failed: ${msg}`, { cause: err });
  }
}

const isChannel = (c: string | null): c is ChannelId => c !== null && Object.values(SALES_CHANNELS).includes(c as ChannelId);
const isMarket = (m: string | null): m is Market => m === "ae" || m === "sa" || m === "ae_sa";
const KEY_KIND_SET = new Set<string>(KEY_KINDS);

/** Reads every warehouse input. Throws BigQuerySyncError before anything is written. */
export async function readWarehouseKeys(bq: BigQueryLike, env: NodeJS.ProcessEnv = process.env) {
  const location = env.BQ_LOCATION || DEFAULT_BQ_LOCATION;
  const [attrRows, optionRows, salesRows, reportRows] = await Promise.all([
    readBq(bq, GRAPH_MASTER_ATTRS_SQL, location, "raw_gcc_dimensions.master_sl attributes"),
    readBq(bq, GRAPH_SKU_OPTION_SQL, location, "gcc_marketing.sku_option"),
    readBq(bq, GRAPH_SALES_KEYS_SQL, location, "fact_gcc.unified_sales_tertiary_v2 keys"),
    readBq(bq, GRAPH_REPORT_KEYS_SQL, location, "channel report keys"),
  ]);
  // An empty master would mark every option as gone: keep the previous graph instead (F1 edge cases).
  if (attrRows.length === 0) throw new BigQuerySyncError("raw_gcc_dimensions.master_sl returned no rows; the graph was left as it was");

  const attrs = new Map<string, MasterAttrs>();
  for (const r of attrRows) {
    const code = str(r.product_code);
    if (!code) continue;
    const row = { styleCode: str(r.description_1), productType: str(r.category_name), audience: str(r.gender) };
    // The SQL already keeps one row per code; this keeps the same rule if a source returns two (D20).
    const had = attrs.get(code);
    if (!had || (!had.styleCode && row.styleCode)) attrs.set(code, row);
  }
  const skuOptions = new Map<string, string>();
  for (const r of optionRows) {
    const k = str(r.sku_key);
    const o = str(r.option_id);
    if (k && o) skuOptions.set(k.toUpperCase(), o);
  }
  const sales: SalesKeyRow[] = [];
  for (const r of salesRows) {
    const channel = SALES_CHANNELS[String(r.channel ?? "")];
    const market = SALES_MARKETS[String(r.country ?? "")];
    const opptraSku = str(r.mapped_opptra_sku);
    if (!channel || !market || !opptraSku) continue;
    sales.push({ opptraSku, channel, market, channelSku: str(r.channel_sku), styleId: str(r.style_id) });
  }
  const reports: ReportKeyRow[] = [];
  for (const r of reportRows) {
    const opptraSku = str(r.opptra_sku);
    const channel = str(r.channel);
    const market = str(r.market);
    const keyKind = str(r.key_kind);
    const keyValue = keyValueOf(r.key_value);
    if (!opptraSku || !isChannel(channel) || !keyKind || !KEY_KIND_SET.has(keyKind) || !keyValue) continue;
    reports.push({ opptraSku, channel, market: isMarket(market) ? market : null, keyKind: keyKind as KeyKind, keyValue });
  }
  return { attrs, skuOptions, sales, reports };
}

type ExistingKey = { id: string; listingId: string; channel: ChannelId; market: Market; keyKind: KeyKind; keyValue: string; opptraSku: string | null; source: KeySource };

/**
 * The graph sync. Reads the softline sku_map and the key mappings from Postgres and the warehouse inputs from
 * BigQuery, then writes options, listings, keys and conflicts in one transaction and links products after it.
 */
export async function syncGraph(db: Db, bq: BigQueryLike, env: NodeJS.ProcessEnv = process.env, orgId = DEFAULT_ORG_ID): Promise<GraphSyncResult> {
  const warehouse = await readWarehouseKeys(bq, env);
  const skuRows = await db
    .select({ opptraSku: skuMap.opptraSku, brandSlug: skuMap.brandSlug, optionIdStyleColor: skuMap.optionIdStyleColor, color: skuMap.color, channelIds: skuMap.channelIds })
    .from(skuMap)
    .where(eq(skuMap.line, "softline"))
    .orderBy(skuMap.opptraSku);
  const mappingRows = await db
    .select({ skuColumn: catalogKeyMappings.skuColumn, channel: catalogKeyMappings.channel, market: catalogKeyMappings.market, keyKind: catalogKeyMappings.keyKind })
    .from(catalogKeyMappings)
    .where(eq(catalogKeyMappings.orgId, orgId));
  const plan = planGraph({ skus: skuRows, mappings: mappingRows, ...warehouse, minConfidence: styleKeyMinConfidence(env) });
  const merged = mergeKeys(plan.keys);

  const result = await db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`select pg_try_advisory_xact_lock(${GRAPH_SYNC_LOCK}::bigint) as ok`)) as unknown as { rows: { ok: boolean }[] };
    if (!locked.rows[0]?.ok) return null;

    // Options: upsert by (brand, option_key); the style key and attributes follow the master each run.
    const optionIds = new Map<string, string>();
    const optionValues = [...plan.options.values()];
    for (let i = 0; i < optionValues.length; i += CHUNK) {
      const rows = await tx
        .insert(catalogOptions)
        .values(optionValues.slice(i, i + CHUNK).map((o) => ({
          orgId, brandSlug: o.brandSlug, optionKey: o.optionKey, keySource: o.keySource, line: "softline" as const,
          productType: o.productType, audience: o.audience, inMaster: o.inMaster,
          styleKey: o.styleKey, styleKeySource: o.styleKeySource, styleKeyConfidence: o.styleKeyConfidence,
        })))
        .onConflictDoUpdate({
          target: [catalogOptions.brandSlug, catalogOptions.optionKey],
          set: {
            keySource: sql.raw("excluded.key_source"), line: sql.raw("excluded.line"), productType: sql.raw("excluded.product_type"),
            audience: sql.raw("excluded.audience"), inMaster: sql.raw("excluded.in_master"), styleKey: sql.raw("excluded.style_key"),
            styleKeySource: sql.raw("excluded.style_key_source"), styleKeyConfidence: sql.raw("excluded.style_key_confidence"),
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: catalogOptions.id, brandSlug: catalogOptions.brandSlug, optionKey: catalogOptions.optionKey });
      for (const r of rows) optionIds.set(optionRef(r.brandSlug, r.optionKey), r.id);
    }
    // An option no SKU of the softline map produces any more keeps its row, out of the master (F1-R1).
    const gone = (await tx.execute(sql`
      update catalog_options set in_master = false, updated_at = now()
      where org_id = ${orgId} and in_master and line = 'softline'
        and not (id = any(${sqlUuidArray([...optionIds.values()])}))
      returning id`)) as unknown as { rows: unknown[] };

    // Listings: insert the missing ones, then read every listing of the planned options.
    const listingValues = [...plan.listings.values()].map((l) => ({ orgId, optionId: optionIds.get(l.optionRef)!, channel: l.channel, market: l.market }));
    for (let i = 0; i < listingValues.length; i += CHUNK) {
      await tx.insert(catalogChannelListings).values(listingValues.slice(i, i + CHUNK)).onConflictDoNothing();
    }
    const refByOptionId = new Map([...optionIds].map(([ref, id]) => [id, ref]));
    const listingIds = new Map<string, string>();
    const optionOfListing = new Map<string, string>();
    for (const l of await tx
      .select({ id: catalogChannelListings.id, optionId: catalogChannelListings.optionId, channel: catalogChannelListings.channel, market: catalogChannelListings.market })
      .from(catalogChannelListings)
      .where(eq(catalogChannelListings.orgId, orgId))) {
      optionOfListing.set(l.id, l.optionId);
      const ref = refByOptionId.get(l.optionId);
      if (ref) listingIds.set(listingRef(ref, l.channel, l.market), l.id);
    }

    // Keys: one listing per key, or a conflict (F1-R5).
    const existing = new Map<string, ExistingKey>();
    for (const k of (await tx.select().from(catalogListingKeys).where(eq(catalogListingKeys.orgId, orgId))) as ExistingKey[]) existing.set(keyRef(k), k);
    const inserts: (typeof catalogListingKeys.$inferInsert)[] = [];
    const moves: { id: string; listingId: string; opptraSku: string | null; source: KeySource }[] = [];
    const removals: string[] = [];
    const conflicts: { channel: ChannelId; market: Market; keyKind: KeyKind; keyValue: string; candidates: KeyConflictCandidate[] }[] = [];
    let unchanged = 0;
    for (const [id, m] of merged) {
      const cands = new Map<string, KeyConflictCandidate>();
      for (const [lRef, c] of m.candidates) {
        const listingId = listingIds.get(lRef)!;
        cands.set(listingId, { listingId, optionId: optionOfListing.get(listingId)!, opptraSku: c.skus.size === 1 ? [...c.skus][0]! : null, source: c.source });
      }
      const old = existing.get(id);
      const oldIsOurs = old ? SYNC_KEY_SOURCES.includes(old.source) : false;
      if (old && !oldIsOurs && !cands.has(old.listingId)) {
        cands.set(old.listingId, { listingId: old.listingId, optionId: optionOfListing.get(old.listingId) ?? "", opptraSku: old.opptraSku, source: old.source });
      }
      if (cands.size > 1) {
        conflicts.push({ channel: m.channel, market: m.market, keyKind: m.keyKind, keyValue: m.keyValue, candidates: [...cands.values()].sort((a, b) => a.listingId.localeCompare(b.listingId)) });
        if (old && oldIsOurs) removals.push(old.id);
        continue;
      }
      const only = [...cands.values()][0]!;
      if (!old) {
        inserts.push({ orgId, listingId: only.listingId, opptraSku: only.opptraSku, channel: m.channel, market: m.market, keyKind: m.keyKind, keyValue: m.keyValue, source: only.source as KeySource });
      } else if (oldIsOurs && (old.listingId !== only.listingId || old.opptraSku !== only.opptraSku || old.source !== only.source)) {
        moves.push({ id: old.id, listingId: only.listingId, opptraSku: only.opptraSku, source: only.source as KeySource });
      } else unchanged++;
    }
    for (let i = 0; i < inserts.length; i += CHUNK) await tx.insert(catalogListingKeys).values(inserts.slice(i, i + CHUNK)).onConflictDoNothing();
    for (let i = 0; i < moves.length; i += CHUNK) {
      const values = sql.join(moves.slice(i, i + CHUNK).map((m) => sql`(${m.id}::uuid, ${m.listingId}::uuid, ${m.opptraSku}, ${m.source})`), sql`, `);
      await tx.execute(sql`
        update catalog_listing_keys k set listing_id = v.listing_id, opptra_sku = v.opptra_sku, source = v.source
        from (values ${values}) as v(id, listing_id, opptra_sku, source) where k.id = v.id`);
    }
    for (let i = 0; i < removals.length; i += CHUNK) {
      await tx.delete(catalogListingKeys).where(inArray(catalogListingKeys.id, removals.slice(i, i + CHUNK)));
    }

    // Conflicts: seen ones are open with their current candidates; open ones not seen this run are resolved.
    for (let i = 0; i < conflicts.length; i += CHUNK) {
      await tx
        .insert(catalogKeyConflicts)
        .values(conflicts.slice(i, i + CHUNK).map((c) => ({ orgId, ...c })))
        .onConflictDoUpdate({
          target: [catalogKeyConflicts.orgId, catalogKeyConflicts.channel, catalogKeyConflicts.market, catalogKeyConflicts.keyKind, catalogKeyConflicts.keyValue],
          set: { candidates: sql.raw("excluded.candidates"), lastSeenAt: sql`now()`, resolvedAt: sql`null` },
        });
    }
    const resolved = (await tx.execute(sql`
      update catalog_key_conflicts set resolved_at = now()
      where org_id = ${orgId} and resolved_at is null and last_seen_at < now()
      returning id`)) as unknown as { rows: unknown[] };

    return {
      optionIds,
      summary: {
        options: optionIds.size,
        optionsNotInMaster: [...plan.options.values()].filter((o) => !o.inMaster).length,
        optionsWithoutSkus: gone.rows.length,
        listings: listingIds.size,
        keys: { inserted: inserts.length, moved: moves.length, unchanged, removedForConflict: removals.length },
        conflicts: { open: conflicts.length, resolved: resolved.rows.length },
      },
    };
  });

  const rowCounts = { unresolvedSalesRows: plan.unresolvedSalesRows, unresolvedReportRows: plan.unresolvedReportRows, departedSkuRows: plan.departedSkuRows };
  if (!result) {
    return {
      skipped: "locked", options: 0, optionsNotInMaster: 0, optionsWithoutSkus: 0, listings: 0,
      keys: { inserted: 0, moved: 0, unchanged: 0, removedForConflict: 0 }, conflicts: { open: 0, resolved: 0 },
      products: { linked: 0, unresolved: 0 }, ...rowCounts,
    };
  }
  // The graph is committed by now: a product-link failure is reported as such, not as a failed graph sync.
  try {
    const products = await linkProducts(db, plan, result.optionIds);
    return { ...result.summary, products, ...rowCounts };
  } catch (err) {
    return { ...result.summary, products: { linked: 0, unresolved: 0 }, productsError: err instanceof Error ? err.message : String(err), ...rowCounts };
  }
}

function sqlUuidArray(ids: string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

/**
 * F1-R6: a product gets its option when its option id, its SKUs or its identifier resolve to exactly one option of its
 * brand. A product that resolves to none or to several keeps what it has and is counted as unresolved.
 */
export async function linkProducts(db: Db, plan: GraphPlan, optionIds: Map<string, string>): Promise<{ linked: number; unresolved: number }> {
  const byBrandKey = new Map<string, string>(); // brand + upper option key -> option id
  for (const o of plan.options.values()) byBrandKey.set(`${o.brandSlug}\u0000${o.optionKey.toUpperCase()}`, optionIds.get(o.ref)!);
  const bySku = new Map<string, string>(); // upper sku -> option id
  for (const [sku, ref] of plan.skuOption) bySku.set(sku.toUpperCase(), optionIds.get(ref)!);

  const products = await db
    .select({ id: catalogProducts.id, brandSlug: catalogProducts.brandSlug, identifier: catalogProducts.identifier, optionIdStyleColor: catalogProducts.optionIdStyleColor, opptraSkuIds: catalogProducts.opptraSkuIds, optionId: catalogProducts.optionId })
    .from(catalogProducts)
    .where(eq(catalogProducts.isTest, false));
  const updates: { id: string; optionId: string }[] = [];
  let unresolved = 0;
  for (const p of products) {
    const found = new Set<string>();
    const byKey = (k: string | null) => {
      if (!k) return;
      const id = byBrandKey.get(`${p.brandSlug}\u0000${normalizeSpaces(k).toUpperCase()}`);
      if (id) found.add(id);
    };
    byKey(p.optionIdStyleColor);
    byKey(p.identifier);
    for (const s of [...(p.opptraSkuIds ?? []), p.identifier]) {
      const id = bySku.get(s.trim().toUpperCase());
      if (id) found.add(id);
    }
    if (found.size !== 1) { unresolved++; continue; }
    const id = [...found][0]!;
    if (p.optionId !== id) updates.push({ id: p.id, optionId: id });
  }
  for (let i = 0; i < updates.length; i += 500) {
    const values = sql.join(updates.slice(i, i + 500).map((u) => sql`(${u.id}::uuid, ${u.optionId}::uuid)`), sql`, `);
    await db.execute(sql`update catalog_products p set option_id = v.option_id from (values ${values}) as v(id, option_id) where p.id = v.id`);
  }
  return { linked: products.length - unresolved, unresolved };
}
