// Spec 18 lifecycle (plan 7b): the enlargement case of the deploy gate's smoke. Two named fixtures (one product above
// 2.0x: the x4 route; one in 1.0-2.0x: the x2 route) run through the real handlers in process, with one photo's
// /upscale answering 8 x 400 (bad input, the fault-proxy rule upscaleBadInputRule under the upscale client). The
// faulted photo is held with enlargement_failed; then "Try again" (core retryEnlargement) with the fault spent makes
// it, and every output above the threshold ends `upscaled`, with zero ERROR invariants. T56 runs it on fakes; the
// smoke (catalog-smoke.ts) runs it against the deployed services. It writes only under catalog-test/.
import { createHash } from "node:crypto";
import sharp from "sharp";
import { and, eq, inArray } from "drizzle-orm";
import { catalogBatches, catalogBatchProducts, catalogChunks, catalogEnlargements, catalogOutputs, catalogProducts, catalogSourceImages, DEFAULT_BATCH_OPTIONS, EMPTY_BATCH_COUNTS } from "@catalog/core/db/schema";
import { retryEnlargement } from "@catalog/core/catalog/decisions";
import { runInvariants } from "@catalog/core/catalog/invariants/run";
import type { EnlargementOption } from "@catalog/core/catalog/pipeline/enlargement";
import type { ChannelId } from "@catalog/core/catalog/types";
import type { TaskRoute } from "@catalog/core/tasks";
import type { CatalogDeps } from "./deps";
import { currentChunkTask, handleChunkTask } from "./chunk";
import { handleEnlargeTask } from "./enlarge";
import { handlePublishTask } from "./publish";
import { handleFinalizeTask } from "./finalize";

/** The two fixtures: a dark product on white filling most of the frame, about 3x (x4) and 1.7x (x2) from Trendyol's canvas; long sides of 500 px or more (never small_source). */
export const ENLARGEMENT_SMOKE_FIXTURES = {
  x4: { name: "enlarge-x4", frame: { w: 420, h: 620 }, product: { w: 380, h: 560 } },
  x2: { name: "enlarge-x2", frame: { w: 700, h: 980 }, product: { w: 640, h: 900 } },
} as const;
export type EnlargementSmokeFixture = keyof typeof ENLARGEMENT_SMOKE_FIXTURES;

export async function enlargementSmokePhoto(fixture: EnlargementSmokeFixture): Promise<Buffer> {
  const f = ENLARGEMENT_SMOKE_FIXTURES[fixture];
  const product = await sharp({ create: { width: f.product.w, height: f.product.h, channels: 3, background: { r: 70, g: 30, b: 25 } } }).png().toBuffer();
  return sharp({ create: { width: f.frame.w, height: f.frame.h, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: product, left: Math.floor((f.frame.w - f.product.w) / 2), top: Math.floor((f.frame.h - f.product.h) / 2) }]).jpeg({ quality: 92 }).toBuffer();
}

export interface EnlargementSmokeInput {
  /** The worker's deps with the upscale client set (its fetch under the fault rule) and a canned judge. */
  deps: CatalogDeps;
  route: EnlargementOption;
  brandSlug: string;
  brandName: string;
  /** Starts with catalog-test (cleanup only touches such batches). */
  name: string;
  channels: ChannelId[];
  /** The fixture whose product's calls the fault answers 400 (the smoke builds the rule once the product exists). */
  faultOn: EnlargementSmokeFixture;
  /** Installs the fault for the product (called after seeding, before the first delivery). */
  fault: (productId: string) => void;
  /** Wait between the retries of a 5xx delivery (Cloud Tasks' back-off); 0 on fakes. */
  backoffMs: number;
  /** The whole run's budget. */
  budgetMs: number;
  log?: (line: string) => void;
}
export interface EnlargementSmokeEvidence {
  batchId: string;
  products: Record<EnlargementSmokeFixture, string>;
  factors: Record<EnlargementSmokeFixture, number[]>;
  heldAfterFault: number;
  deliveries: number;
  invariantErrors: string[];
}

interface Task { route: TaskRoute; body: Record<string, unknown>; retries: number }

export async function runEnlargementSmoke(input: EnlargementSmokeInput): Promise<EnlargementSmokeEvidence> {
  const { db } = input.deps, started = Date.now(), log = input.log ?? (() => {});
  const queue: Task[] = [], names = new Set<string>();
  const enqueue = (async (route: TaskRoute, body: Record<string, unknown>, opts: { taskId?: string } = {}) => {
    if (opts.taskId && names.has(opts.taskId)) return opts.taskId;
    if (opts.taskId) names.add(opts.taskId);
    queue.push({ route, body, retries: 0 });
    return opts.taskId ?? "smoke";
  }) as CatalogDeps["enqueue"];
  const deps: CatalogDeps = { ...input.deps, enqueue };

  // The batch, as Start leaves it: pinned route, two products of one photo each, one matte chunk.
  const now = new Date();
  const [batch] = await db.insert(catalogBatches).values({ brandSlug: input.brandSlug, brandName: input.brandName, name: input.name, isTest: true, createdBy: "smoke@opptra.com", status: "matting", productType: "footwear", channels: input.channels, startedAt: now,
    options: { ...DEFAULT_BATCH_OPTIONS, enlargement: input.route }, counts: { ...EMPTY_BATCH_COUNTS, products: 2, sources: 2, outputs: 2 * input.channels.length } }).returning();
  const batchId = batch!.id, products = {} as Record<EnlargementSmokeFixture, string>;
  for (const fixture of ["x4", "x2"] as const) {
    const key = `${input.name}-${ENLARGEMENT_SMOKE_FIXTURES[fixture].name}`.replace(/[^a-z0-9-]+/gi, "-");
    const [product] = await db.insert(catalogProducts).values({ brandSlug: input.brandSlug, isTest: true, productKey: key, pathKey: key, identifier: key, productType: "footwear", lockBatchId: batchId }).returning();
    await db.insert(catalogBatchProducts).values({ batchId, productId: product!.id, change: "new" });
    const bytes = await enlargementSmokePhoto(fixture), meta = await sharp(bytes).metadata();
    const rawUri = await deps.storage.uploadBuffer(`catalog-test/${input.brandSlug}/${batchId}/raw/${key}/1.jpg`, bytes, "image/jpeg");
    await db.insert(catalogSourceImages).values({ batchId, productId: product!.id, n: 1, sha256: createHash("sha256").update(bytes).digest("hex"), originalName: `${key}_1.jpg`, rawUri, mime: "image/jpeg", width: meta.width ?? null, height: meta.height ?? null, bytes: bytes.length });
    products[fixture] = product!.id;
  }
  const [chunk] = await db.insert(catalogChunks).values({ batchId, index: 0, stage: "matte", status: "queued", attempt: 0, productIds: Object.values(products), dispatchedAt: now }).returning();
  input.fault(products[input.faultOn]);
  const first = await currentChunkTask(db, chunk!.id);
  await enqueue("/tasks/catalog/chunk", first, { taskId: `chunk-${chunk!.id}-${String(first.step)}` });

  let deliveries = 0;
  const drain = async (label: string) => {
    for (;;) {
      if (Date.now() - started > input.budgetMs) throw new Error(`Enlargement smoke: ${label} did not finish within ${Math.round(input.budgetMs / 60_000)} min.`);
      const task = queue.shift();
      if (!task) {
        const [b] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
        const open = await db.select({ id: catalogChunks.id }).from(catalogChunks).where(and(eq(catalogChunks.batchId, batchId), inArray(catalogChunks.status, ["queued", "running"])));
        if (b!.status === "done" && !open.length) return;
        throw new Error(`Enlargement smoke: ${label} stopped with the batch ${b!.status} and ${open.length} open chunk(s) and nothing queued.`);
      }
      deliveries++;
      const result = task.route === "/tasks/catalog/chunk" ? await handleChunkTask(deps, task.body, { retryCount: task.retries })
        : task.route === "/tasks/catalog/enlarge" ? await handleEnlargeTask(deps, task.body)
        : task.route === "/tasks/catalog/publish" ? await handlePublishTask(deps, task.body)
        : task.route === "/tasks/catalog/finalize" ? await handleFinalizeTask(deps, task.body)
        : { httpStatus: 200, outcome: "ignored" };
      log(`${label}: ${task.route} ${result.httpStatus} ${result.outcome ?? ""}`);
      if (result.httpStatus >= 500) {
        task.retries++;
        if (input.backoffMs) await new Promise((resolve) => setTimeout(resolve, input.backoffMs));
        queue.push(task);
      }
    }
  };
  const outputs = () => db.select().from(catalogOutputs).where(eq(catalogOutputs.batchId, batchId));
  const rows = () => db.select().from(catalogEnlargements).where(eq(catalogEnlargements.batchId, batchId));

  await drain("first run");
  const factors = { x4: [] as number[], x2: [] as number[] };
  for (const r of await rows()) for (const fixture of ["x4", "x2"] as const) if (r.productId === products[fixture] && r.wanted) factors[fixture].push(r.factor);
  const held = (await outputs()).filter((o) => o.productId === products[input.faultOn]);
  if (!held.length || !held.every((o) => o.status === "needs_attention" && o.decision === null && o.flags.includes("enlargement_failed")))
    throw new Error(`Enlargement smoke: the faulted photo is not held with enlargement_failed (${held.map((o) => `${o.status}/${o.flags.join("+")}`).join(", ")}).`);
  for (const o of (await outputs()).filter((x) => x.productId !== products[input.faultOn]))
    if (!o.flags.includes("upscaled") || o.status !== "verified") throw new Error(`Enlargement smoke: output ${o.id} is ${o.status} without the upscaler (${o.flags.join("+")}).`);

  // Try again, the fault spent: the photo is made and published, and the batch's sheet written again.
  await retryEnlargement(db, enqueue, { outputId: held[0]!.id, actor: "smoke@opptra.com" });
  await drain("try again");
  for (const o of await outputs()) {
    if (o.status !== "verified" || !o.flags.includes("upscaled") || o.flags.includes("enlargement_failed")) throw new Error(`Enlargement smoke: after Try again output ${o.id} is ${o.status} (${o.flags.join("+")}).`);
  }
  const run = await runInvariants(db, () => {}, new Date(), { batchId });
  const invariantErrors = run.results.filter((r) => r.severity === "ERROR" && r.violations > 0).map((r) => `${r.id}: ${r.violations}`);
  if (invariantErrors.length) throw new Error(`Enlargement smoke: invariants failed: ${invariantErrors.join("; ")}`);
  return { batchId, products, factors, heldAfterFault: held.length, deliveries, invariantErrors };
}
