// Tier 2 scale test (PGlite + fake storage and fetch): a links sheet the size of the USPA one that stalled on
// 2026-10-31 (25,476 rows, 3 photo links per colour shared by every size, about 2,200 colours) against a sku_map of
// about 26,000 rows. Grouping must run in deliveries of at most PRODUCT_BUDGET_ITEMS products, read sku_map once per
// delivery (never per product), and Start's buildPreview and step 2's poll must stay bounded. The second variant
// names every size (about 25,000 products). Numbers are printed as JSON lines for the PR.
import { appendFileSync } from "node:fs";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/client";
import { catalogBatches, catalogBatchProducts, catalogUploads, skuMap, type CatalogBatch } from "../../db/schema";
import { createDbFromPglite, createTestDb } from "../../db/testing";
import { batchPrefix } from "../naming";
import { buildDetectedStep2 } from "./detect-step";
import { buildPreview, PRODUCT_BUDGET_ITEMS, runIngest, type DeliveryBody } from "./index";
import type { IngestDeps } from "./types";

const BUCKET = "test-assets";
const HOST = "https://104.18.38.10";
const ROWS = 25_476;
const COLOURS = 2_213;
const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "3XL", "28", "30", "32", "34", "36"];
/** The request deadline of an ingest delivery (Cloud Tasks dispatch deadline). */
const DEADLINE_MS = 900_000;

let db: Db;
let close: () => Promise<void>;
const queries: string[] = [];

beforeAll(async () => {
  vi.stubEnv("BUCKET", BUCKET);
  const t = await createTestDb();
  close = t.close;
  // The same database, with every statement logged so the test can count them.
  db = createDbFromPglite(t.client, { logger: { logQuery: (q) => queries.push(q) } }).db;
  // A sku_map the size of USPA's: every colour in 12 sizes, plus another brand's rows.
  const rows: (typeof skuMap.$inferInsert)[] = [];
  for (let c = 0; c < COLOURS; c++) {
    for (const size of SIZES) {
      rows.push({
        brand: "USPA", brandSlug: "uspa", line: "softline", source: "warehouse", opptraSku: `ST${c}_NAVY_${size}`, optionKey: `OPT${c}NAVY`,
        optionIdStyleColor: `OPT ${c} NAVY`, ean: `86${String(c * 100 + SIZES.indexOf(size)).padStart(11, "0")}`, channelIds: { styli_sku: `STY${c}${size}`, amazon: `B0${c}${size}` },
      });
    }
  }
  for (let i = 0; i < 2_000; i++) rows.push({ brand: "Penti", brandSlug: "penti", line: "softline", source: "warehouse", opptraSku: `PE${i}_M`, optionKey: `PE${i}`, optionIdStyleColor: null, ean: null, channelIds: {} });
  for (let i = 0; i < rows.length; i += 1000) await db.insert(skuMap).values(rows.slice(i, i + 1000));
}, 600_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});

function fakeWorld() {
  const objects = new Map<string, { buf: Buffer; mime: string; sha256?: string }>();
  const gs = (p: string) => `gs://${BUCKET}/${p}`;
  const notFound = () => Object.assign(new Error("No such object"), { code: 404 });
  const storage: IngestDeps["storage"] = {
    uploadBuffer: async (path, buf, mime, opts) => {
      objects.set(gs(path), { buf, mime, ...(opts?.sha256 ? { sha256: opts.sha256 } : {}) });
      return gs(path);
    },
    downloadBuffer: async (gsUri) => {
      const o = objects.get(gsUri);
      if (!o) throw notFound();
      return { buf: o.buf, mime: o.mime };
    },
    headObject: async (gsUri) => {
      const o = objects.get(gsUri);
      return { exists: !!o, size: o ? o.buf.length : null, contentType: o?.mime ?? null, generation: o ? "1" : null, crc32c: null, ...(o?.sha256 ? { sha256: o.sha256 } : {}) };
    },
    readRange: async (gsUri, start, end) => objects.get(gsUri)!.buf.subarray(start, end + 1),
    createRangeStream: (gsUri, start, end) => Readable.from([objects.get(gsUri)!.buf.subarray(start, end + 1)]),
    listObjects: async (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    setCustomTime: async () => {},
  };
  const web = new Map<string, Buffer>();
  const fetch: typeof globalThis.fetch = async (input) => {
    const body = web.get(String(input));
    if (!body) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  const enqueued: { route: string; body: Record<string, unknown> }[] = [];
  const enqueue = async (route: string, body: Record<string, unknown>) => {
    enqueued.push({ route, body });
    return `task-${enqueued.length}`;
  };
  return { objects, storage, web, fetch, enqueue, enqueued, put: (p: string, buf: Buffer, mime: string) => objects.set(gs(p), { buf, mime }) };
}

/** The sheet: ROWS rows over COLOURS colours, each row one size, 3 links per colour shared by its sizes. */
async function sheetBatch(name: string, perSize: boolean) {
  const w = fakeWorld();
  const [batch] = await db.insert(catalogBatches).values({
    brandSlug: "uspa", brandName: "USPA", name, isTest: true, createdBy: "op@opptra.com", channels: ["noon"],
    options: { identifierMode: "sheet_column", precedence: "uploads_then_links", sheetColumns: null },
  }).returning();
  const lines = ["Option ID,Image 1,Image 2,Image 3"];
  const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  for (let r = 0; r < ROWS; r++) {
    const c = r % COLOURS;
    const size = SIZES[Math.floor(r / COLOURS) % SIZES.length]!;
    const links = [1, 2, 3].map((n) => `${HOST}/c${c}_${n}.jpg`);
    // A distinct photo per link (the bytes' sha256 tells the photos apart).
    for (const [k, l] of links.entries()) if (!w.web.has(l)) w.web.set(l, Buffer.concat([jpeg, Buffer.from(`${c}-${k}`)]));
    // Per colour: the style+colour code, which no sku_map step finds (the worst case: every step looked at).
    // Per size: a size-level code of its own (sizes that resolve to one option would be one product, refused as
    // the same product: see the report), also found by no step.
    lines.push([perSize ? `SZ${c}-Q${size}` : `STYLE${c}-NAVY`, ...links].join(","));
  }
  const prefix = batchPrefix(batch!.brandSlug, batch!.id, batch!.isTest);
  w.put(`${prefix}/uploads/s/links.csv`, Buffer.from(lines.join("\n") + "\n"), "text/csv");
  const [u] = await db.insert(catalogUploads).values({ batchId: batch!.id, kind: "sheet", name: "links.csv", gcsUri: `gs://${BUCKET}/${prefix}/uploads/s/links.csv`, status: "uploaded" }).returning();
  return { w, batch: batch!, uploadId: u!.id };
}

const skuMapQueries = (from: number) => queries.slice(from).filter((q) => /from "sku_map"/i.test(q)).length;

/** Collects the sheet (large budgets: collecting is not what is measured), then runs every grouping and placing delivery. */
async function runToStep3(w: ReturnType<typeof fakeWorld>, batch: CatalogBatch, uploadId: string) {
  const deps = { storage: w.storage, fetch: w.fetch, enqueue: w.enqueue as never, sleep: async () => {}, budgetItems: 10_000, placeBudgetItems: 100_000 };
  let body: DeliveryBody = { batchId: batch.id, uploadId, run: batch.name };
  const deliveries: { kind: string; ms: number; queries: number; skuMapQueries: number; outcome: string }[] = [];
  for (let guard = 0; guard < 500; guard++) {
    const from = queries.length;
    const t0 = performance.now();
    const before = w.enqueued.length;
    const r = await runIngest(db, deps, body);
    const kind = body.group !== undefined ? "group" : body.place !== undefined ? "place" : /^collected \d+ of/.test(r.outcome) ? "collect" : "group";
    deliveries.push({ kind, ms: Math.round(performance.now() - t0), queries: queries.length - from, skuMapQueries: skuMapQueries(from), outcome: r.outcome });
    if (w.enqueued.length === before) break;
    body = w.enqueued.at(-1)!.body as unknown as DeliveryBody;
  }
  return deliveries;
}

// The per-size variant takes several minutes on PGlite, so CI runs it only with CATALOG_SCALE_FULL=1.
const variants = [
  { variant: "per colour", perSize: false, products: COLOURS },
  ...(process.env.CATALOG_SCALE_FULL === "1" ? [{ variant: "per size", perSize: true, products: ROWS }] : []),
];
describe.each(variants)("a 25,476-row links sheet grouped $variant", ({ variant, perSize, products }) => {
  it(`reaches step 3 with about ${products.toLocaleString("en-US")} products in budgeted deliveries, one sku_map read each, and bounded polls`, async () => {
    const { w, batch, uploadId } = await sheetBatch(`scale-${perSize ? "size" : "colour"}`, perSize);
    const startedAt = performance.now();
    const deliveries = await runToStep3(w, batch, uploadId);
    const totalMs = Math.round(performance.now() - startedAt);
    const [row] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batch.id));
    expect(row).toMatchObject({ status: "draft", counts: { previewReady: true, phase: "ready" } });
    const [made] = await db.select({ n: sql<number>`count(*)::int` }).from(catalogBatchProducts).where(eq(catalogBatchProducts.batchId, batch.id));
    expect(made!.n).toBe(products);

    const grouping = deliveries.filter((d) => d.kind === "group");
    const perDelivery = grouping.map((d) => Number(/grouped (\d+) of/.exec(d.outcome)?.[1] ?? products));
    // Every grouping delivery stays inside its budget: at most PRODUCT_BUDGET_ITEMS new products each, far inside the deadline.
    const steps = perDelivery.map((n, i) => n - (perDelivery[i - 1] ?? 0));
    expect(Math.max(...steps)).toBeLessThanOrEqual(PRODUCT_BUDGET_ITEMS);
    expect(grouping.length).toBe(Math.ceil(products / PRODUCT_BUDGET_ITEMS));
    for (const d of grouping) expect(d.ms).toBeLessThan(DEADLINE_MS);
    // sku_map is read once per grouping delivery: zero reads per product.
    const skuReads = grouping.reduce((n, d) => n + d.skuMapQueries, 0);
    expect(skuReads).toBe(grouping.length);
    // About 20 statements per product (findOrCreateProduct's transaction, aliases, the batch row), never a scan per product.
    const maxStatementsPerProduct = Math.max(...grouping.map((d, i) => d.queries / Math.max(1, steps[i]!)));

    // Start's buildPreview and the step 2 poll, timed and counted.
    let from = queries.length;
    let t0 = performance.now();
    const preview = await buildPreview(db, batch.id, { storage: w.storage });
    const previewMs = Math.round(performance.now() - t0);
    const previewQueries = queries.length - from;
    expect(preview.kpis.products).toBe(products);
    from = queries.length;
    t0 = performance.now();
    await buildDetectedStep2(db, batch.id, { storage: w.storage }, { sign: async (u) => u });
    const step2Ms = Math.round(performance.now() - t0);
    const step2Queries = queries.length - from;
    // Bounded: the number of statements does not grow per product (IN lists of 1,000 at most).
    expect(previewQueries).toBeLessThan(20 + 10 * Math.ceil(products / 1000));
    expect(step2Queries).toBeLessThan(20);
    const numbers = JSON.stringify({
      event: "scale", variant, rows: ROWS, products, skuMapRows: COLOURS * SIZES.length + 2000, totalMs,
      grouping: grouping.map((d) => ({ ms: d.ms, queries: d.queries, skuMapQueries: d.skuMapQueries })), skuMapReads: skuReads,
      maxStatementsPerProduct: Math.round(maxStatementsPerProduct * 10) / 10, previewMs, previewQueries, step2Ms, step2Queries,
      deliveries: deliveries.length,
    });
    console.info(numbers);
    if (process.env.CATALOG_SCALE_OUT) appendFileSync(process.env.CATALOG_SCALE_OUT, numbers + String.fromCharCode(10));
  }, 1_800_000);
});
