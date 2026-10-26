import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { catalogBatches, catalogBatchProducts, catalogOutputs, catalogSourceImages, type CatalogOutput } from "@catalog/core/db/schema";
import { signedUrl } from "@catalog/core/storage";
import { channel } from "@catalog/core/catalog/channels";
import { CHANNEL_IDS, type ChannelId } from "@catalog/core/catalog/types";
import { flagDetails, plainFailures } from "@catalog/core/catalog/qa/reasons";
import { busyBackgroundHold, failuresOf } from "@catalog/core/catalog/auto-resolve";
import { db, type Db } from "../db";
import { HttpError } from "../errors";
import { COMPARE_GRADES, COMPARE_PAGE_SIZE, type CompareCell, type CompareGrade } from "./compare-copy";

/** Signed links on the comparison views last one hour, like the preview's short links. */
export const COMPARE_URL_TTL_SEC = 3600;
export const shortSignedUrl = (uri: string) => signedUrl(uri, COMPARE_URL_TTL_SEC);

export { COMPARE_GRADES, COMPARE_PAGE_SIZE, GRADE_LABELS, type CompareCell, type CompareGrade } from "./compare-copy";

type OutputLike = Pick<CatalogOutput, "stagingUri" | "isLive" | "publicUrl">;
/**
 * Which file shows an output (shared with the eval list): the copy made in its own batch (staging, kept per
 * batch), else the public link while it is live. The public link always holds the newest version, so it is
 * never used for an output that is no longer live.
 */
export async function outputUrlOf(o: OutputLike, sign: (uri: string) => Promise<string>): Promise<string | null> {
  return o.stagingUri ? sign(o.stagingUri) : o.isLive ? o.publicUrl : null;
}

type ReasonLike = Pick<CatalogOutput, "n" | "channel" | "flags" | "status" | "compliance" | "reason" | "error">;
/** The plain reason sentences for an output's flags (shared with the eval list). Never a rule id or model id. */
export function whyOf(o: ReasonLike): string {
  const label = channel(o.channel).label;
  const ctx = { n: o.n, channel: label, busy: busyBackgroundHold(o.compliance), failures: plainFailures(failuresOf(o.compliance), label) };
  const lines = o.flags.map(f => flagDetails(f, ctx).why);
  if (o.status === "failed" && !o.flags.length) lines.push(flagDetails("failed", { ...ctx, ...(o.error ?? o.reason ? { error: (o.error ?? o.reason)! } : {}) }).why);
  return lines.join(" ");
}

export interface CompareRow { sourceImageId: string; productId: string; identifier: string; n: number; originalUrl: string; cells: CompareCell[] }
export interface ComparePage { rows: CompareRow[]; total: number; page: number; channels: ChannelId[] }
export interface CompareFilters { page?: number; channel?: string; status?: string; q?: string }

const gradeSql = (o: string) => sql.raw(`case
  when ${o}.id is null then null
  when ${o}.status in ('failed','skipped') then 'failed'
  when ${o}.status = 'needs_attention' then 'attention'
  when ${o}.status in ('staged','verified') and exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(${o}.compliance->'auto_actions') = 'array' then ${o}.compliance->'auto_actions' else '[]'::jsonb end) a
    where a->>'result' = 'passed' and a->>'step' <> 'matte_retry'
      and (jsonb_typeof(a->'channels') is distinct from 'array' or a->'channels' ? ${o}.channel)) then 'repaired'
  when ${o}.status in ('staged','verified') then 'passed'
  else 'waiting' end`);

/**
 * Every input photo of one batch next to what was made from it for each of the batch's channels.
 *
 * Rows: the batch's products (catalog_batch_products) and the photo versions this batch brought for them
 * (catalog_source_images.batch_id), less any photo replaced inside the same batch (an operator replacement).
 * This holds for past batches too: each batch keeps its own source rows, and products are linked per batch.
 *
 * Cells: this batch's output for (photo, channel). A re-run with the same photo makes no new output
 * (apps/worker chunk.ts skips a live output with the same render key), so the cell then falls back to the
 * newest published output of the same product, channel and shot with the same photo bytes, made in an
 * earlier batch before this one finished, marked unchanged.
 *
 * Filters and paging run in SQL, so a large batch never loads whole.
 */
export async function batchCompare(batchId: string, input: CompareFilters = {}, conn: Db = db(), sign = shortSignedUrl): Promise<ComparePage> {
  const [batch] = await conn.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new HttpError(404, "This batch was not found. Return to All batches.");
  const channels = batch.channels.filter(c => !input.channel || c === input.channel);
  const page = Math.max(0, Math.floor(input.page ?? 0));
  const q = (input.q ?? "").trim().toLowerCase();
  const status = (COMPARE_GRADES as readonly string[]).includes(input.status ?? "") ? input.status! : "";
  const finished = batch.status === "done" || batch.status === "failed";
  if (!channels.length) return { rows: [], total: 0, page, channels };

  const channelList = sql.join(channels.map(c => sql`${c}`), sql`, `);
  const cutoff = batch.finishedAt ?? new Date();
  const qFilter: SQL = q ? sql`and strpos(lower(p.identifier), ${q}) > 0` : sql``;
  // One line per (photo, channel): the output shown and its grade.
  const cells = (rows: SQL) => sql`
    select r.source_id, ch.channel, coalesce(own.id, prev.id) as output_id, (own.id is null and prev.id is not null) as unchanged,
      case when own.id is null and prev.id is not null then 'unchanged'
        else coalesce(${gradeSql("o")}, ${finished ? sql`'failed'` : sql`'waiting'`}) end as grade
    from ${rows} r
    cross join unnest(array[${channelList}]::text[]) as ch(channel)
    left join lateral (
      select x.id from catalog_outputs x
      where x.batch_id = ${batchId} and x.source_image_id = r.source_id and x.channel = ch.channel
      order by x.created_at desc limit 1) own on true
    left join lateral (
      select x.id from catalog_outputs x join catalog_source_images xs on xs.id = x.source_image_id
      where own.id is null and x.product_id = r.product_id and x.channel = ch.channel and x.n = r.n
        and xs.sha256 = r.sha256 and x.batch_id <> ${batchId} and x.status = 'verified' and x.created_at < ${cutoff.toISOString()}::timestamptz
      order by x.created_at desc limit 1) prev on true
    left join catalog_outputs o on o.id = coalesce(own.id, prev.id)`;
  const statusFilter: SQL = status ? sql`and exists (select 1 from (${cells(sql`(select r.*)`)}) g where g.grade = ${status})` : sql``;
  const result = await conn.execute(sql`
    with rows as (
      select s.id as source_id, s.product_id, s.n, s.sha256, s.raw_uri, p.identifier
      from catalog_batch_products bp
      join catalog_products p on p.id = bp.product_id
      join catalog_source_images s on s.product_id = bp.product_id and s.batch_id = bp.batch_id
      where bp.batch_id = ${batchId} ${qFilter}
        and not exists (select 1 from catalog_source_images rs where rs.product_id = s.product_id and rs.batch_id = s.batch_id and rs.replaces_id = s.id)
    ),
    picked as (
      select r.*, count(*) over () as total from rows r
      where true ${statusFilter}
      order by r.identifier, r.n, r.source_id
      limit ${COMPARE_PAGE_SIZE} offset ${page * COMPARE_PAGE_SIZE}
    )
    select pk.source_id, pk.product_id, pk.identifier, pk.n, pk.raw_uri, pk.total, c.channel, c.output_id, c.unchanged, c.grade
    from picked pk join (${cells(sql`picked`)}) c on c.source_id = pk.source_id
    order by pk.identifier, pk.n, pk.source_id`);
  const lines = rowsOf(result);
  const total = Number(lines[0]?.total ?? 0);
  if (!lines.length && page > 0) {
    // A page past the end (filters changed): report the real total so the pager can step back.
    const recount = await batchCompare(batchId, { ...input, page: 0 }, conn, async () => "");
    return { rows: [], total: recount.total, page, channels };
  }
  const outputIds = [...new Set(lines.flatMap(l => l.output_id ? [String(l.output_id)] : []))];
  const outputs = new Map((outputIds.length ? await conn.select().from(catalogOutputs).where(inArray(catalogOutputs.id, outputIds)) : []).map(o => [o.id, o]));
  const rows = new Map<string, CompareRow>();
  const originals = new Map<string, Promise<string>>();
  const cellsOf = new Map<string, Promise<CompareCell>[]>();
  for (const l of lines) {
    const id = String(l.source_id);
    if (!rows.has(id)) {
      rows.set(id, { sourceImageId: id, productId: String(l.product_id), identifier: String(l.identifier), n: Number(l.n), originalUrl: "", cells: [] });
      originals.set(id, sign(String(l.raw_uri)));
      cellsOf.set(id, []);
    }
    const o = l.output_id ? outputs.get(String(l.output_id)) : undefined;
    cellsOf.get(id)!.push((async (): Promise<CompareCell> => ({
      channel: l.channel as ChannelId, outputId: o?.id ?? null, url: o ? await outputUrlOf(o, sign) : null,
      grade: l.grade as CompareGrade, unchanged: l.unchanged === true || l.unchanged === "t", skipped: o?.status === "skipped", why: o ? whyOf(o) : "",
    }))());
  }
  for (const [id, row] of rows) {
    row.originalUrl = await originals.get(id)!;
    const cells = await Promise.all(cellsOf.get(id)!);
    row.cells = channels.map(c => cells.find(cell => cell.channel === c)!);
  }
  return { rows: [...rows.values()], total, page, channels };
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/**
 * The product page's comparison: each current photo's original next to its live output per channel,
 * and the batches that touched this product (newest first), each linking to its Compare tab.
 */
export async function productCompare(productId: string, conn: Db = db(), sign = shortSignedUrl) {
  const [sources, live, batches] = await Promise.all([
    conn.select({ id: catalogSourceImages.id, n: catalogSourceImages.n, rawUri: catalogSourceImages.rawUri }).from(catalogSourceImages)
      .where(and(eq(catalogSourceImages.productId, productId), eq(catalogSourceImages.isCurrent, true))).orderBy(asc(catalogSourceImages.n)),
    conn.select().from(catalogOutputs).where(and(eq(catalogOutputs.productId, productId), eq(catalogOutputs.isLive, true))),
    conn.select({ id: catalogBatches.id, name: catalogBatches.name, createdAt: catalogBatches.createdAt, finishedAt: catalogBatches.finishedAt, change: catalogBatchProducts.change })
      .from(catalogBatchProducts).innerJoin(catalogBatches, eq(catalogBatches.id, catalogBatchProducts.batchId))
      .where(eq(catalogBatchProducts.productId, productId)).orderBy(desc(catalogBatches.createdAt)),
  ]);
  const channels = CHANNEL_IDS.filter(c => live.some(o => o.channel === c));
  const shots = [...new Set([...sources.map(s => s.n), ...live.map(o => o.n)])].sort((a, b) => a - b);
  const rows = await Promise.all(shots.map(async n => {
    const source = sources.find(s => s.n === n);
    return {
      n, originalUrl: source ? await sign(source.rawUri) : null,
      cells: await Promise.all(channels.map(async (c): Promise<CompareCell> => {
        const o = live.find(x => x.channel === c && x.n === n);
        return { channel: c, outputId: o?.id ?? null, url: o ? await outputUrlOf(o, sign) : null, grade: o ? "passed" : "failed", unchanged: false, skipped: false, why: "" };
      })),
    };
  }));
  return { channels, rows, batches };
}
export type ProductCompare = Awaited<ReturnType<typeof productCompare>>;
