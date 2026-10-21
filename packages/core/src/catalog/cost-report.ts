// Read-only queries over the cost ledger (catalog_cost_events) for the Ops page. Every query is bounded
// (one batch, a time window, a top-N) and uses the ledger's indexes. Labels never name a model: an
// engine is shown by its kind ("quality check", "cut-out", "image making", "worker").
//
// Attribution rule (SPEC R16): render and upscale rows are direct per output and so per channel; matte,
// classify and judge rows belong to their source image and split evenly across that image's non-skipped
// outputs in the batch; the per-chunk compute row splits evenly across the chunk's non-skipped outputs;
// a publish row (timed, usd 0) splits across its product's non-skipped outputs. A row with nothing to
// split over (every output skipped) stays in `unattributedUsd`.
import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogChunks, catalogCostEvents, catalogOutputs, catalogProducts, catalogSourceImages, type CostKind, type CostStage } from "../db/schema";
import type { ChannelId } from "./types";

export const ENGINE_LABELS = {
  llm_call: "quality check",
  matte_call: "cut-out",
  render: "image making",
  upscale_call: "image making",
  compute: "worker",
} as const satisfies Record<CostKind, string>;
export type EngineLabel = (typeof ENGINE_LABELS)[CostKind];
/** The operator-facing name of a ledger row's engine; never the model id. */
export function engineLabel(kind: CostKind): EngineLabel {
  return ENGINE_LABELS[kind];
}

export interface StageCost { stage: CostStage; usd: number; estimatedUsd: number; ms: number; calls: number }
export interface EngineCost { engine: EngineLabel; usd: number; ms: number; calls: number }
export interface ChannelCost { channel: ChannelId; usd: number; outputs: number }
export interface CostHints {
  /** Cut-out calls for the photo(s): 1 per photo when nothing went wrong. */
  matteCalls: number;
  /** Cut-out calls beyond the first per photo: the retry after a service failure plus guard ladder steps. */
  matteExtraCalls: number;
  /** Quality-check calls (every HTTP attempt, re-judges included). */
  judgeCalls: number;
  upscaleCalls: number;
}
export interface ProductCost { productId: string; identifier: string | null; usd: number; outputs: number; hints: CostHints }
export interface ImageCost { sourceImageId: string; productId: string | null; identifier: string | null; n: number | null; usd: number; outputs: number; hints: CostHints }
export interface BatchAttribution { byChannel: ChannelCost[]; topProducts: ProductCost[]; topImages: ImageCost[]; unattributedUsd: number; totalUsd: number }
export interface BrandCost { brandSlug: string; usd: number; batches: number; products: number; images: number; usdPerProduct: number | null; usdPerImage: number | null }
export interface DayCost { day: string; usd: number; batches: number }

const num = (value: unknown) => { const n = Number(value ?? 0); return Number.isFinite(n) ? n : 0; };
const per = (usd: number, count: number) => (count > 0 ? usd / count : null);

/** USD, time and call count per stage of one batch. */
export async function batchCostByStage(db: Db, batchId: string): Promise<StageCost[]> {
  const rows = await db
    .select({
      stage: catalogCostEvents.stage,
      usd: sql<string>`coalesce(sum(${catalogCostEvents.usd}), 0)`,
      estimatedUsd: sql<string>`coalesce(sum(case when ${catalogCostEvents.estimated} then ${catalogCostEvents.usd} else 0 end), 0)`,
      ms: sql<string>`coalesce(sum(${catalogCostEvents.ms}), 0)`,
      calls: sql<string>`count(*)`,
    })
    .from(catalogCostEvents)
    .where(eq(catalogCostEvents.batchId, batchId))
    .groupBy(catalogCostEvents.stage);
  return rows.map((r) => ({ stage: r.stage, usd: num(r.usd), estimatedUsd: num(r.estimatedUsd), ms: num(r.ms), calls: num(r.calls) })).sort((a, b) => b.usd - a.usd);
}

/** USD, time and call count per engine label of one batch (render and upscale rows share "image making"). */
export async function batchCostByEngine(db: Db, batchId: string): Promise<EngineCost[]> {
  const rows = await db
    .select({ kind: catalogCostEvents.kind, usd: sql<string>`coalesce(sum(${catalogCostEvents.usd}), 0)`, ms: sql<string>`coalesce(sum(${catalogCostEvents.ms}), 0)`, calls: sql<string>`count(*)` })
    .from(catalogCostEvents)
    .where(eq(catalogCostEvents.batchId, batchId))
    .groupBy(catalogCostEvents.kind);
  const byLabel = new Map<EngineLabel, EngineCost>();
  for (const r of rows) {
    const engine = engineLabel(r.kind);
    const entry = byLabel.get(engine) ?? { engine, usd: 0, ms: 0, calls: 0 };
    entry.usd += num(r.usd); entry.ms += num(r.ms); entry.calls += num(r.calls);
    byLabel.set(engine, entry);
  }
  return [...byLabel.values()].sort((a, b) => b.usd - a.usd);
}

interface LedgerGroup { productId: string | null; sourceImageId: string | null; outputId: string | null; chunkId: string | null; stage: CostStage; kind: CostKind; usd: number; calls: number }
interface OutputRef { id: string; productId: string; sourceImageId: string; channel: ChannelId; skipped: boolean }

const emptyHints = (): CostHints => ({ matteCalls: 0, matteExtraCalls: 0, judgeCalls: 0, upscaleCalls: 0 });

/**
 * One batch's cost per channel, and its dearest products and source images, under the attribution rule
 * above. Reads the batch's ledger grouped per (source, output, chunk, stage, kind), its outputs and its
 * chunks: three indexed, per-batch queries.
 */
export async function batchCostAttribution(db: Db, batchId: string, opts: { top?: number } = {}): Promise<BatchAttribution> {
  const top = opts.top ?? 10;
  const groups: LedgerGroup[] = (await db
    .select({
      productId: catalogCostEvents.productId, sourceImageId: catalogCostEvents.sourceImageId, outputId: catalogCostEvents.outputId, chunkId: catalogCostEvents.chunkId,
      stage: catalogCostEvents.stage, kind: catalogCostEvents.kind, usd: sql<string>`coalesce(sum(${catalogCostEvents.usd}), 0)`, calls: sql<string>`count(*)`,
    })
    .from(catalogCostEvents)
    .where(eq(catalogCostEvents.batchId, batchId))
    .groupBy(catalogCostEvents.productId, catalogCostEvents.sourceImageId, catalogCostEvents.outputId, catalogCostEvents.chunkId, catalogCostEvents.stage, catalogCostEvents.kind))
    .map((r) => ({ ...r, usd: num(r.usd), calls: num(r.calls) }));
  const outputs: OutputRef[] = (await db
    .select({ id: catalogOutputs.id, productId: catalogOutputs.productId, sourceImageId: catalogOutputs.sourceImageId, channel: catalogOutputs.channel, status: catalogOutputs.status })
    .from(catalogOutputs)
    .where(eq(catalogOutputs.batchId, batchId)))
    .map((o) => ({ id: o.id, productId: o.productId, sourceImageId: o.sourceImageId, channel: o.channel, skipped: o.status === "skipped" }));
  const chunks = await db.select({ id: catalogChunks.id, productIds: catalogChunks.productIds, sourceImageIds: catalogChunks.sourceImageIds }).from(catalogChunks).where(eq(catalogChunks.batchId, batchId));

  const byId = new Map(outputs.map((o) => [o.id, o]));
  const live = outputs.filter((o) => !o.skipped);
  const bySource = new Map<string, OutputRef[]>(), byProduct = new Map<string, OutputRef[]>();
  for (const o of live) {
    bySource.set(o.sourceImageId, [...(bySource.get(o.sourceImageId) ?? []), o]);
    byProduct.set(o.productId, [...(byProduct.get(o.productId) ?? []), o]);
  }
  const byChunk = new Map(chunks.map((c) => {
    const products = new Set(c.productIds), sources = c.sourceImageIds?.length ? new Set(c.sourceImageIds) : null;
    return [c.id, live.filter((o) => products.has(o.productId) && (!sources || sources.has(o.sourceImageId)))];
  }));

  const share = new Map<string, number>();
  let unattributedUsd = 0, totalUsd = 0;
  const spread = (targets: OutputRef[] | undefined, usd: number) => {
    if (!targets?.length) { unattributedUsd += usd; return; }
    for (const o of targets) share.set(o.id, (share.get(o.id) ?? 0) + usd / targets.length);
  };
  for (const g of groups) {
    totalUsd += g.usd;
    if (g.usd === 0) continue;
    const direct = g.outputId ? byId.get(g.outputId) : undefined;
    if (direct && (g.kind === "render" || g.kind === "upscale_call")) spread(direct.skipped ? [] : [direct], g.usd);
    else if (g.kind === "compute" && g.chunkId && byChunk.has(g.chunkId)) spread(byChunk.get(g.chunkId), g.usd);
    else if (g.sourceImageId) spread(bySource.get(g.sourceImageId), g.usd);
    else if (g.productId) spread(byProduct.get(g.productId), g.usd);
    else unattributedUsd += g.usd;
  }

  const channels = new Map<ChannelId, ChannelCost>();
  for (const o of live) {
    const entry = channels.get(o.channel) ?? { channel: o.channel, usd: 0, outputs: 0 };
    entry.usd += share.get(o.id) ?? 0; entry.outputs += 1;
    channels.set(o.channel, entry);
  }

  // Hints come from the call counts per source; a product's hints are the sum over its photos.
  const sourceHints = new Map<string, CostHints>();
  for (const g of groups) {
    if (!g.sourceImageId) continue;
    const h = sourceHints.get(g.sourceImageId) ?? emptyHints();
    if (g.kind === "matte_call") h.matteCalls += g.calls;
    else if (g.kind === "llm_call" && g.stage === "qa") h.judgeCalls += g.calls;
    else if (g.kind === "upscale_call") h.upscaleCalls += g.calls;
    sourceHints.set(g.sourceImageId, h);
  }
  for (const h of sourceHints.values()) h.matteExtraCalls = Math.max(0, h.matteCalls - 1);
  const addHints = (into: CostHints, from: CostHints | undefined) => { if (!from) return; into.matteCalls += from.matteCalls; into.matteExtraCalls += from.matteExtraCalls; into.judgeCalls += from.judgeCalls; into.upscaleCalls += from.upscaleCalls; };

  const productIds = [...byProduct.keys()], sourceIds = [...bySource.keys()];
  const products = productIds.length ? await db.select({ id: catalogProducts.id, identifier: catalogProducts.identifier }).from(catalogProducts).where(sql`${catalogProducts.id} in ${productIds}`) : [];
  const sources = sourceIds.length ? await db.select({ id: catalogSourceImages.id, n: catalogSourceImages.n }).from(catalogSourceImages).where(sql`${catalogSourceImages.id} in ${sourceIds}`) : [];
  const identifierOf = new Map(products.map((p) => [p.id, p.identifier])), shotOf = new Map(sources.map((s) => [s.id, s.n]));

  const topProducts: ProductCost[] = productIds.map((productId) => {
    const rows = byProduct.get(productId)!, hints = emptyHints();
    for (const sourceId of new Set(rows.map((o) => o.sourceImageId))) addHints(hints, sourceHints.get(sourceId));
    return { productId, identifier: identifierOf.get(productId) ?? null, usd: rows.reduce((sum, o) => sum + (share.get(o.id) ?? 0), 0), outputs: rows.length, hints };
  }).sort((a, b) => b.usd - a.usd).slice(0, top);
  const topImages: ImageCost[] = sourceIds.map((sourceImageId) => {
    const rows = bySource.get(sourceImageId)!, productId = rows[0]?.productId ?? null;
    return { sourceImageId, productId, identifier: productId ? identifierOf.get(productId) ?? null : null, n: shotOf.get(sourceImageId) ?? null, usd: rows.reduce((sum, o) => sum + (share.get(o.id) ?? 0), 0), outputs: rows.length, hints: sourceHints.get(sourceImageId) ?? emptyHints() };
  }).sort((a, b) => b.usd - a.usd).slice(0, top);

  return { byChannel: [...channels.values()].sort((a, b) => b.usd - a.usd), topProducts, topImages, unattributedUsd, totalUsd };
}

/**
 * USD per brand from `since` (omit for lifetime), with the distinct batches, products and source images
 * the money went to and the USD per product and per image. Test batches are left out unless asked for.
 */
export async function brandCostTotals(db: Db, opts: { since?: Date; includeTest?: boolean } = {}): Promise<BrandCost[]> {
  const conditions = [
    ...(opts.since ? [gte(catalogCostEvents.at, opts.since)] : []),
    ...(opts.includeTest ? [] : [eq(catalogCostEvents.isTest, false)]),
  ];
  const rows = await db
    .select({
      brandSlug: catalogCostEvents.brandSlug,
      usd: sql<string>`coalesce(sum(${catalogCostEvents.usd}), 0)`,
      batches: sql<string>`count(distinct ${catalogCostEvents.batchId})`,
      products: sql<string>`count(distinct ${catalogCostEvents.productId})`,
      images: sql<string>`count(distinct ${catalogCostEvents.sourceImageId})`,
    })
    .from(catalogCostEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(catalogCostEvents.brandSlug);
  return rows
    .map((r) => { const usd = num(r.usd), products = num(r.products), images = num(r.images); return { brandSlug: r.brandSlug, usd, batches: num(r.batches), products, images, usdPerProduct: per(usd, products), usdPerImage: per(usd, images) }; })
    .sort((a, b) => b.usd - a.usd);
}

export const BRAND_REPORT_DAYS = 30;
/** Per-brand totals for the last 30 days and for all time. */
export async function brandCostReport(db: Db, opts: { now?: Date; includeTest?: boolean } = {}): Promise<{ last30Days: BrandCost[]; lifetime: BrandCost[] }> {
  const now = opts.now ?? new Date();
  const since = new Date(+now - BRAND_REPORT_DAYS * 86_400_000);
  const base = opts.includeTest === undefined ? {} : { includeTest: opts.includeTest };
  const [last30Days, lifetime] = await Promise.all([brandCostTotals(db, { ...base, since }), brandCostTotals(db, base)]);
  return { last30Days, lifetime };
}

/** USD per UTC day over the last `days` days (default 30), oldest first; days without spend are absent. */
export async function dayCostTotals(db: Db, opts: { days?: number; now?: Date; includeTest?: boolean } = {}): Promise<DayCost[]> {
  const days = opts.days ?? 30, now = opts.now ?? new Date();
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  const day = sql<string>`to_char(${catalogCostEvents.at} at time zone 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({ day, usd: sql<string>`coalesce(sum(${catalogCostEvents.usd}), 0)`, batches: sql<string>`count(distinct ${catalogCostEvents.batchId})` })
    .from(catalogCostEvents)
    .where(and(gte(catalogCostEvents.at, since), ...(opts.includeTest ? [] : [eq(catalogCostEvents.isTest, false)])))
    .groupBy(day)
    .orderBy(day);
  return rows.map((r) => ({ day: r.day, usd: num(r.usd), batches: num(r.batches) }));
}
