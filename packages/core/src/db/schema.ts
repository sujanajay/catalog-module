// Database schema (spec 02, "Database"). The migration drizzle/0000_init.sql is generated from this
// file with `pnpm --filter @catalog/core db:generate --name init`.
//
// Text enums: Drizzle's `text(..., { enum })` only narrows the TypeScript type, it does not check
// values in the database. Every enum column therefore also gets a CHECK constraint built from the
// same array in catalog/types.ts, so an invalid value is rejected by Postgres too.
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { SkuMethod } from "../catalog/sku-mapping";
import {
  ALIAS_KINDS,
  BATCH_STATUSES,
  CHANGE_KINDS,
  CHANNEL_IDS,
  DECISIONS,
  EVAL_LABELS,
  EVENT_KINDS,
  LINK_STATUSES,
  OUTPUT_STATUSES,
  POLICY_SOURCES,
  PRODUCT_TYPES,
  QA_MODES,
  ROLES,
  UPLOAD_KINDS,
  type BatchCost,
  type BatchCounts,
  type BatchOptions,
  type ChannelId,
  type OutputFlag,
  type ProductType,
  type Role,
} from "../catalog/types";

// ---------------------------------------------------------------------------
// Value lists that exist only in the database contract
// ---------------------------------------------------------------------------

export const BRAND_LINES = ["softline", "hardline"] as const;
export const MASTER_SOURCES = ["warehouse", "manual"] as const;
export const MATTE_TARGETS = ["cpu", "gpu"] as const;
export const SHADOW_MODES = ["preserve_only", "preserve_else_synthesise"] as const;
export const UPLOAD_STATUSES = ["pending", "uploaded", "collected", "failed", "removed"] as const;
export const SOURCE_IMAGE_STATUSES = ["pending", "prepared", "matted", "failed", "unsupported"] as const;
export const CHUNK_STAGES = ["matte", "render", "qa"] as const;
export const CHUNK_STATUSES = ["queued", "running", "done", "failed"] as const;
/** spend_days.engine values. Re-exported by spend.ts as part of its contract. */
export const SPEND_ENGINES = ["catalog_qa", "catalog_compute"] as const;
/** model_policy.category: a ProductType or "*" (any). */
export const POLICY_CATEGORIES = [...PRODUCT_TYPES, "*"] as const;
/** catalog_cost_events.stage: where in the pipeline the money or time went. */
export const COST_STAGES = ["matte", "render", "upscale", "qa", "classify", "publish", "finalize"] as const;
/** catalog_cost_events.kind: what was priced or timed. */
export const COST_KINDS = ["llm_call", "matte_call", "render", "upscale_call", "compute"] as const;
/** catalog_cost_events.outcome. `fallback`: the simple cut-out stood in for a failed service call. */
export const COST_OUTCOMES = ["ok", "failed", "rate_limited", "cap", "fallback"] as const;

export type BrandLine = (typeof BRAND_LINES)[number];
export type MasterSource = (typeof MASTER_SOURCES)[number];
export type SpendEngine = (typeof SPEND_ENGINES)[number];
export type CostStage = (typeof COST_STAGES)[number];
export type CostKind = (typeof COST_KINDS)[number];
export type CostOutcome = (typeof COST_OUTCOMES)[number];

/**
 * sku_map.channel_ids keys. Softline columns keep their warehouse names (6th_street_* becomes
 * sixth_street_*); the hardline master's id columns are mapped onto the same keys in master-sync.ts.
 */
export const SKU_CHANNEL_KEYS = [
  "namshi_ae", "namshi_sa", "child_zsku", "noon_ae", "noon_sa", "trendyol", "centerpoint_ae_ksa",
  "sixth_street_ae", "sixth_street_sa", "styli_ae_ksa", "styli_sku", "amazon", "voga_closet", "shein",
  "amazon_uae_ksa_asin",
] as const;
export type SkuChannelKey = (typeof SKU_CHANNEL_KEYS)[number];
export type SkuChannelIds = Partial<Record<SkuChannelKey, string>>;

export const DEFAULT_BATCH_OPTIONS: BatchOptions = {
  identifierMode: "filename",
  precedence: "uploads_then_links",
  sheetColumns: null,
};

export const EMPTY_BATCH_COUNTS: BatchCounts = {
  products: 0, sources: 0, outputs: 0, verified: 0, needsAttention: 0,
  attentionProducts: 0, failed: 0, skipped: 0, unchanged: 0, skuResolved: 0,
  missingImages: 0, notInSheet: 0, unsupportedFiles: 0, duplicateFiles: 0,
  collected: 0, collectTotal: null, previewReady: false, latestExport: 0,
  failReason: null, finalizePending: false, policyFallback: false,
  newProducts: 0, existingProducts: 0, shotsToRemove: 0,
  recheckOk: null, recheckTotal: null,
};

export const EMPTY_BATCH_COST: BatchCost = {
  computeVcpuSeconds: 0, mattingMs: 0, renderMs: 0, computeUsd: 0,
  qaUsd: 0, qaCalls: 0, identifiers: 0,
  usdPerIdentifier: null, inrPerIdentifier: null,
};

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date());
const tsNull = (name: string) => timestamp(name, { withTimezone: true });
const money = (name: string) => numeric(name, { precision: 12, scale: 6, mode: "number" });

/** `"col" IN ('a', 'b', ...)` for a CHECK constraint. Values are fixed literals from this repo. */
function inList(col: AnyPgColumn, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
  return sql`${col} IN (${sql.raw(list)})`;
}

/** CHECK constraint named `<table>_<column>_check`. */
function enumCheck(table: string, column: string, col: AnyPgColumn, values: readonly string[]) {
  return check(`${table}_${column}_check`, inList(col, values));
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * People and their roles (spec 03). Emails are stored lowercased (people.ts lowercases every input).
 * The migrate job seeds the first admin; any other verified account gets a viewer row on first sign-in.
 */
export const users = pgTable(
  "users",
  {
    email: text("email").primaryKey(),
    role: text("role", { enum: ROLES }).$type<Role>().notNull(),
    addedBy: text("added_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [enumCheck("users", "role", t.role, ROLES)],
);

export const brandMaster = pgTable(
  "brand_master",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    line: text("line", { enum: BRAND_LINES }).notNull(),
    source: text("source", { enum: MASTER_SOURCES }).notNull(),
    syncedAt: tsNull("synced_at"),
    createdAt: createdAt(),
  },
  (t) => [
    enumCheck("brand_master", "line", t.line, BRAND_LINES),
    enumCheck("brand_master", "source", t.source, MASTER_SOURCES),
  ],
);

export const skuMap = pgTable(
  "sku_map",
  {
    opptraSku: text("opptra_sku").primaryKey(),
    brand: text("brand").notNull(),
    brandSlug: text("brand_slug").notNull(),
    line: text("line", { enum: BRAND_LINES }).notNull(),
    optionKey: text("option_key").notNull(),
    optionIdStyleColor: text("option_id_style_color"),
    ean: text("ean"),
    color: text("color"),
    size: text("size"),
    channelIds: jsonb("channel_ids").$type<SkuChannelIds>().notNull().default({}),
    imageUrl: text("image_url"),
    source: text("source", { enum: MASTER_SOURCES }).notNull(),
    syncedAt: tsNull("synced_at"),
  },
  (t) => [
    index("sku_map_brand_slug_idx").on(t.brandSlug),
    index("sku_map_option_key_idx").on(t.optionKey),
    index("sku_map_ean_idx").on(t.ean),
    enumCheck("sku_map", "line", t.line, BRAND_LINES),
    enumCheck("sku_map", "source", t.source, MASTER_SOURCES),
  ],
);

export const modelPolicy = pgTable(
  "model_policy",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandSlug: text("brand_slug").notNull(),
    category: text("category", { enum: POLICY_CATEGORIES }).notNull(),
    matteModel: text("matte_model").notNull(),
    qaModel: text("qa_model").notNull(),
    threshold: integer("threshold").notNull(),
    floor: integer("floor").notNull(),
    qaMode: text("qa_mode", { enum: QA_MODES }).notNull().default("per_source"),
    qaSampleRate: numeric("qa_sample_rate", { mode: "number" }).notNull().default(1),
    source: text("source", { enum: POLICY_SOURCES }).notNull(),
    matteTarget: text("matte_target", { enum: MATTE_TARGETS }),
    matteModelSecond: text("matte_model_second"),
    shadowMode: text("shadow_mode", { enum: SHADOW_MODES }),
    qaModelSecond: text("qa_model_second"),
    evalBatchIds: jsonb("eval_batch_ids").$type<string[]>().notNull().default([]),
    gates: jsonb("gates").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("model_policy_brand_category_uq").on(t.brandSlug, t.category),
    enumCheck("model_policy", "category", t.category, POLICY_CATEGORIES),
    enumCheck("model_policy", "qa_mode", t.qaMode, QA_MODES),
    enumCheck("model_policy", "source", t.source, POLICY_SOURCES),
    enumCheck("model_policy", "matte_target", t.matteTarget, MATTE_TARGETS),
    enumCheck("model_policy", "shadow_mode", t.shadowMode, SHADOW_MODES),
  ],
);

export const catalogBatches = pgTable(
  "catalog_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandSlug: text("brand_slug").notNull(),
    brandName: text("brand_name").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: BATCH_STATUSES }).notNull().default("draft"),
    isTest: boolean("is_test").notNull().default(false),
    productType: text("product_type", { enum: PRODUCT_TYPES }).notNull().default("auto"),
    channels: jsonb("channels").$type<ChannelId[]>().notNull().default([]),
    options: jsonb("options").$type<BatchOptions>().notNull().default(DEFAULT_BATCH_OPTIONS),
    counts: jsonb("counts").$type<BatchCounts>().notNull().default(EMPTY_BATCH_COUNTS),
    cost: jsonb("cost").$type<BatchCost>().notNull().default(EMPTY_BATCH_COST),
    reportUri: text("report_uri"),
    sheetXlsxUri: text("sheet_xlsx_uri"),
    sheetCsvUri: text("sheet_csv_uri"),
    error: text("error"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    startedAt: tsNull("started_at"),
    finishedAt: tsNull("finished_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("catalog_batches_brand_slug_idx").on(t.brandSlug),
    enumCheck("catalog_batches", "status", t.status, BATCH_STATUSES),
    enumCheck("catalog_batches", "product_type", t.productType, PRODUCT_TYPES),
  ],
);

export const catalogUploads = pgTable(
  "catalog_uploads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: UPLOAD_KINDS }).notNull(),
    name: text("name").notNull(),
    relativePath: text("relative_path"),
    gcsUri: text("gcs_uri"),
    sourceUrl: text("source_url"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    mime: text("mime"),
    status: text("status", { enum: UPLOAD_STATUSES }).notNull().default("pending"),
    detected: jsonb("detected").$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("catalog_uploads_batch_id_idx").on(t.batchId),
    enumCheck("catalog_uploads", "kind", t.kind, UPLOAD_KINDS),
    enumCheck("catalog_uploads", "status", t.status, UPLOAD_STATUSES),
  ],
);

export const catalogProducts = pgTable(
  "catalog_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandSlug: text("brand_slug").notNull(),
    isTest: boolean("is_test").notNull().default(false),
    productKey: text("product_key").notNull(),
    pathKey: text("path_key").notNull(),
    identifier: text("identifier").notNull(),
    optionIdStyleColor: text("option_id_style_color"),
    opptraSkuIds: jsonb("opptra_sku_ids").$type<string[]>().notNull().default([]),
    skuMethod: text("sku_method").$type<SkuMethod>(),
    productType: text("product_type").$type<ProductType>(),
    lockBatchId: uuid("lock_batch_id").references(() => catalogBatches.id, { onDelete: "set null" }),
    lastBatchId: uuid("last_batch_id").references(() => catalogBatches.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("catalog_products_brand_test_key_uq").on(t.brandSlug, t.isTest, t.productKey),
    // Two products never share public paths (path_key is the public path segment).
    uniqueIndex("catalog_products_brand_test_path_uq").on(t.brandSlug, t.isTest, t.pathKey),
    index("catalog_products_lock_batch_id_idx").on(t.lockBatchId),
  ],
);

export const catalogBatchProducts = pgTable(
  "catalog_batch_products",
  {
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => catalogProducts.id, { onDelete: "cascade" }),
    linkStatus: text("link_status", { enum: LINK_STATUSES }).notNull().default("ok"),
    change: text("change", { enum: CHANGE_KINDS }).notNull(),
    flags: jsonb("flags").$type<OutputFlag[]>().notNull().default([]),
    notes: text("notes").notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.batchId, t.productId] }),
    index("catalog_batch_products_product_id_idx").on(t.productId),
    enumCheck("catalog_batch_products", "link_status", t.linkStatus, LINK_STATUSES),
    enumCheck("catalog_batch_products", "change", t.change, CHANGE_KINDS),
  ],
);

export const catalogProductAliases = pgTable(
  "catalog_product_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandSlug: text("brand_slug").notNull(),
    isTest: boolean("is_test").notNull().default(false),
    aliasKey: text("alias_key").notNull(),
    productId: uuid("product_id")
      .notNull()
      .references(() => catalogProducts.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ALIAS_KINDS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("catalog_product_aliases_brand_test_key_uq").on(t.brandSlug, t.isTest, t.aliasKey),
    index("catalog_product_aliases_product_id_idx").on(t.productId),
    enumCheck("catalog_product_aliases", "kind", t.kind, ALIAS_KINDS),
  ],
);

export const catalogProductEvents = pgTable(
  "catalog_product_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => catalogProducts.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").references(() => catalogBatches.id, { onDelete: "set null" }),
    kind: text("kind", { enum: EVENT_KINDS }).notNull(),
    actor: text("actor").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("catalog_product_events_product_id_idx").on(t.productId),
    enumCheck("catalog_product_events", "kind", t.kind, EVENT_KINDS),
  ],
);

export const catalogSourceImages = pgTable(
  "catalog_source_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => catalogProducts.id, { onDelete: "cascade" }),
    /** The batch that brought this version. */
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id),
    n: integer("n").notNull(),
    sha256: text("sha256").notNull(),
    isCurrent: boolean("is_current").notNull().default(false),
    supersededAt: tsNull("superseded_at"),
    replacesId: uuid("replaces_id").references((): AnyPgColumn => catalogSourceImages.id, { onDelete: "set null" }),
    originalName: text("original_name").notNull(),
    uploadId: uuid("upload_id").references(() => catalogUploads.id, { onDelete: "set null" }),
    rawUri: text("raw_uri").notNull(),
    mime: text("mime").notNull(),
    width: integer("width"),
    height: integer("height"),
    bytes: bigint("bytes", { mode: "number" }),
    matteUri: text("matte_uri"),
    matteModel: text("matte_model"),
    matteMs: integer("matte_ms"),
    // Spec 18 (migration 0005): the photo's stored enlargement, made once by the enlarge task. x2_model is set when
    // the photo is queued (the upscaler id asked for) and becomes the id that made x2_uri; null: no enlargement
    // needed. x2_attempts counts the failed tries; at ENLARGE_MAX_ATTEMPTS with x2_uri null the photo failed
    // (x2_error says why). Mirrors matte_uri / matte_model. x2_claimed_at: the in-flight claim of the delivery calling
    // the upscale service now (live for the task's dispatch deadline), so a second live delivery never calls or bills.
    x2Uri: text("x2_uri"),
    x2Model: text("x2_model"),
    x2Error: text("x2_error"),
    x2Attempts: integer("x2_attempts").notNull().default(0),
    x2ClaimedAt: tsNull("x2_claimed_at"),
    flags: jsonb("flags").$type<OutputFlag[]>().notNull().default([]),
    status: text("status", { enum: SOURCE_IMAGE_STATUSES }).notNull().default("pending"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("catalog_source_images_product_id_idx").on(t.productId),
    uniqueIndex("catalog_source_images_product_n_sha_batch_uq").on(t.productId, t.n, t.sha256, t.batchId),
    enumCheck("catalog_source_images", "status", t.status, SOURCE_IMAGE_STATUSES),
  ],
);

export const catalogOutputs = pgTable(
  "catalog_outputs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id),
    productId: uuid("product_id")
      .notNull()
      .references(() => catalogProducts.id),
    sourceImageId: uuid("source_image_id")
      .notNull()
      .references(() => catalogSourceImages.id),
    channel: text("channel", { enum: CHANNEL_IDS }).notNull(),
    n: integer("n").notNull(),
    canvasW: integer("canvas_w").notNull(),
    canvasH: integer("canvas_h").notNull(),
    scale: numeric("scale", { mode: "number" }).notNull(),
    placedX: integer("placed_x").notNull(),
    placedY: integer("placed_y").notNull(),
    bytes: integer("bytes"),
    quality: integer("quality"),
    renderKey: text("render_key").notNull(),
    stagingUri: text("staging_uri"),
    objectPath: text("object_path").notNull(),
    publicUrl: text("public_url").notNull(),
    /** GCS object generation (microseconds since epoch; fits a JS number until the 2200s). */
    generation: bigint("generation", { mode: "number" }),
    crc32c: text("crc32c"),
    isLive: boolean("is_live").notNull().default(false),
    compliance: jsonb("compliance").$type<Record<string, unknown>>(),
    qaScores: jsonb("qa_scores").$type<Record<string, unknown>>(),
    qaModel: text("qa_model"),
    status: text("status", { enum: OUTPUT_STATUSES }).notNull().default("pending"),
    flags: jsonb("flags").$type<OutputFlag[]>().notNull().default([]),
    reason: text("reason"),
    decision: text("decision", { enum: DECISIONS }),
    decidedBy: text("decided_by"),
    decidedAt: tsNull("decided_at"),
    publishedAt: tsNull("published_at"),
    publishedBy: text("published_by"),
    supersededAt: tsNull("superseded_at"),
    supersededByOutputId: uuid("superseded_by_output_id").references((): AnyPgColumn => catalogOutputs.id, {
      onDelete: "set null",
    }),
    attempt: integer("attempt").notNull().default(1),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("catalog_outputs_batch_id_idx").on(t.batchId),
    index("catalog_outputs_product_id_idx").on(t.productId),
    // Exactly one live row per (product, channel, n).
    uniqueIndex("catalog_outputs_live_uq").on(t.productId, t.channel, t.n).where(sql`${t.isLive}`),
    enumCheck("catalog_outputs", "channel", t.channel, CHANNEL_IDS),
    enumCheck("catalog_outputs", "status", t.status, OUTPUT_STATUSES),
    enumCheck("catalog_outputs", "decision", t.decision, DECISIONS),
  ],
);

export const catalogChunks = pgTable(
  "catalog_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    stage: text("stage", { enum: CHUNK_STAGES }).notNull(),
    productIds: jsonb("product_ids").$type<string[]>().notNull(),
    sourceImageIds: jsonb("source_image_ids").$type<string[]>(),
    status: text("status", { enum: CHUNK_STATUSES }).notNull().default("queued"),
    attempt: integer("attempt").notNull().default(1),
    taskName: text("task_name"),
    startedAt: tsNull("started_at"),
    finishedAt: tsNull("finished_at"),
    error: text("error"),
    createdAt: createdAt(),
    // Spec 15 (migration 0004). The holder of a running chunk renews lease_until while it works; a lapsed
    // lease means the holder is dead. step names the chunk's one live task (chunk-<id>-<stage>-<step>);
    // step_known is false on rows from before 0004, whose tasks carry no step. dispatched_at is when the
    // chunk's current task was queued (null: waiting for the batch window). progress_at is the last time a
    // photo finished; stalls counts deliveries in a row that finished none.
    leaseUntil: tsNull("lease_until"),
    step: integer("step").notNull().default(0),
    stepKnown: boolean("step_known").notNull().default(true),
    dispatchedAt: tsNull("dispatched_at"),
    progressAt: tsNull("progress_at"),
    stalls: integer("stalls").notNull().default(0),
  },
  (t) => [
    index("catalog_chunks_batch_id_idx").on(t.batchId),
    enumCheck("catalog_chunks", "stage", t.stage, CHUNK_STAGES),
    enumCheck("catalog_chunks", "status", t.status, CHUNK_STATUSES),
  ],
);

export const catalogEvalLabels = pgTable(
  "catalog_eval_labels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id, { onDelete: "cascade" }),
    outputId: uuid("output_id")
      .notNull()
      .references(() => catalogOutputs.id, { onDelete: "cascade" }),
    sourceImageId: uuid("source_image_id")
      .notNull()
      .references(() => catalogSourceImages.id),
    setName: text("set_name").notNull(),
    identifier: text("identifier").notNull(),
    channel: text("channel", { enum: CHANNEL_IDS }).notNull(),
    labeler: text("labeler").notNull(),
    label: text("label", { enum: EVAL_LABELS }).notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    note: text("note"),
    judgeVerdict: text("judge_verdict"),
    judgeScores: jsonb("judge_scores").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("catalog_eval_labels_batch_id_idx").on(t.batchId),
    enumCheck("catalog_eval_labels", "channel", t.channel, CHANNEL_IDS),
    enumCheck("catalog_eval_labels", "label", t.label, EVAL_LABELS),
  ],
);

export const catalogEvalJudgements = pgTable(
  "catalog_eval_judgements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id, { onDelete: "cascade" }),
    outputId: uuid("output_id")
      .notNull()
      .references(() => catalogOutputs.id, { onDelete: "cascade" }),
    judgeModel: text("judge_model").notNull(),
    scores: jsonb("scores").$type<Record<string, unknown>>().notNull(),
    verdict: text("verdict", { enum: EVAL_LABELS }).notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    costUsd: money("cost_usd").notNull().default(0),
    ms: integer("ms").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("catalog_eval_judgements_batch_id_idx").on(t.batchId),
    uniqueIndex("catalog_eval_judgements_output_model_uq").on(t.outputId, t.judgeModel),
    enumCheck("catalog_eval_judgements", "verdict", t.verdict, EVAL_LABELS),
  ],
);

export const spendDays = pgTable(
  "spend_days",
  {
    day: date("day").notNull(), // 'YYYY-MM-DD' (UTC)
    brandSlug: text("brand_slug").notNull(),
    engine: text("engine", { enum: SPEND_ENGINES }).notNull(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id),
    costUsd: money("cost_usd").notNull().default(0),
    calls: integer("calls").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.brandSlug, t.engine, t.batchId] }),
    index("spend_days_batch_id_idx").on(t.batchId),
    enumCheck("spend_days", "engine", t.engine, SPEND_ENGINES),
  ],
);

/**
 * Cost ledger (observability plan, part A): one row per priced or timed event of a batch, written
 * beside the existing spend_days and catalog_batches.cost updates (which stay the source for the caps
 * and the cost line). Additive and never read by the pipeline; the Ops page reads it through
 * catalog/cost-report.ts. `engine` is `cpu`, `gpu`, `worker` or a model id, never shown in the UI.
 * Only batch_id is a foreign key (test cleanup deletes batches); the other ids are plain references
 * because outputs and source images are deleted while their batch is kept.
 */
export const catalogCostEvents = pgTable(
  "catalog_cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id, { onDelete: "cascade" }),
    brandSlug: text("brand_slug").notNull(),
    isTest: boolean("is_test").notNull().default(false),
    productId: uuid("product_id"),
    sourceImageId: uuid("source_image_id"),
    outputId: uuid("output_id"),
    channel: text("channel", { enum: CHANNEL_IDS }),
    stage: text("stage", { enum: COST_STAGES }).notNull(),
    kind: text("kind", { enum: COST_KINDS }).notNull(),
    engine: text("engine").notNull(),
    ms: integer("ms").notNull().default(0),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    usd: numeric("usd", { precision: 12, scale: 8, mode: "number" }).notNull().default(0),
    /** A fallback price was used (no billed cost from the provider, or a rate from the environment). */
    estimated: boolean("estimated").notNull().default(false),
    outcome: text("outcome", { enum: COST_OUTCOMES }).notNull().default("ok"),
    chunkId: uuid("chunk_id"),
    /** The attempt number of this call: a judge's HTTP attempt, or a photo's n-th cut-out call in a delivery. */
    attempt: integer("attempt"),
  },
  (t) => [
    index("catalog_cost_events_batch_id_idx").on(t.batchId),
    index("catalog_cost_events_brand_slug_at_idx").on(t.brandSlug, t.at),
    index("catalog_cost_events_output_id_idx").on(t.outputId),
    // Day totals across brands read a time window only.
    index("catalog_cost_events_at_idx").on(t.at),
    enumCheck("catalog_cost_events", "channel", t.channel, CHANNEL_IDS),
    enumCheck("catalog_cost_events", "stage", t.stage, COST_STAGES),
    enumCheck("catalog_cost_events", "kind", t.kind, COST_KINDS),
    enumCheck("catalog_cost_events", "outcome", t.outcome, COST_OUTCOMES),
  ],
);

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type BrandMasterRow = typeof brandMaster.$inferSelect;
export type SkuMapRow = typeof skuMap.$inferSelect;
export type ModelPolicyRow = typeof modelPolicy.$inferSelect;
export type CatalogBatch = typeof catalogBatches.$inferSelect;
export type CatalogUpload = typeof catalogUploads.$inferSelect;
export type CatalogProduct = typeof catalogProducts.$inferSelect;
export type CatalogBatchProduct = typeof catalogBatchProducts.$inferSelect;
export type CatalogProductAlias = typeof catalogProductAliases.$inferSelect;
export type CatalogProductEvent = typeof catalogProductEvents.$inferSelect;
export type CatalogSourceImage = typeof catalogSourceImages.$inferSelect;
export type CatalogOutput = typeof catalogOutputs.$inferSelect;
export type CatalogChunk = typeof catalogChunks.$inferSelect;
export type CatalogEvalLabel = typeof catalogEvalLabels.$inferSelect;
export type CatalogEvalJudgement = typeof catalogEvalJudgements.$inferSelect;
export type SpendDay = typeof spendDays.$inferSelect;
export type CatalogCostEvent = typeof catalogCostEvents.$inferSelect;
