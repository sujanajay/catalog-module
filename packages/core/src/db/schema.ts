// Database schema (spec 02, "Database"). The migration drizzle/0000_init.sql is generated from this
// file with `pnpm --filter @catalog/core db:generate --name init`.
//
// Text enums: Drizzle's `text(..., { enum })` only narrows the TypeScript type, it does not check
// values in the database. Every enum column therefore also gets a CHECK constraint built from the
// same array in catalog/types.ts, so an invalid value is rejected by Postgres too.
import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  pgView,
  real,
  text,
  unique,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { SkuMethod } from "../catalog/sku-mapping";
import type { BatchDigest } from "../catalog/digest-types";
import { CHANGE_ACTIONS, CHANGE_TYPE_STATUSES, COST_CLASSES } from "../learning/types";
import type { SettingScope, SettingValue } from "../settings/registry";
import type { SettingsSnapshotData } from "../settings/snapshot";
import { BRAND_PHOTO_CAPABILITIES, CAPABILITIES, ROUTE_ADAPTERS, ROUTE_STATES } from "../vendor/routes";
import {
  ALIAS_KINDS,
  AUTO_DECIDE_ACTIONS,
  AUTO_DECIDE_CHANNELS,
  BATCH_STATUSES,
  CHANGE_KINDS,
  CHANNEL_IDS,
  DECISIONS,
  EVAL_LABELS,
  EVENT_KINDS,
  HOLD_CAUSES,
  IMPROVEMENT_END_REASONS,
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
import {
  ARMS,
  CHANGE_EVENT_KINDS,
  COMPONENTS,
  DEFAULT_ORG_ID,
  EVIDENCE_KINDS,
  HASH_KINDS,
  IMAGE_ROLES,
  KEY_KINDS,
  KEY_SOURCES,
  LANGUAGES,
  LISTING_STATUSES,
  LIVE_STATES,
  MARKETS,
  OPTION_KEY_SOURCES,
  PRODUCER_PATTERN,
  REASON_KINDS,
  STYLE_KEY_SOURCES,
  VERSION_SOURCES,
  type Slot,
  type VersionScope,
} from "../graph/types";
import {
  CHANNEL_STATUSES,
  CONFLICT_SEVERITIES,
  CONFLICT_STATUSES,
  EVIDENCE_GRADES,
  IMAGE_POLICY_STATUSES,
  PUSH_METHODS,
  RULE_COMPONENTS,
  RULE_LANGUAGES,
  RULE_MARKETS,
  RULE_OUTCOMES,
  RULE_SEVERITIES,
  RULE_STATUSES,
  RULESET_STATUSES,
  type ChannelMargins,
  type RuleAudience,
  type RulesetSnapshot,
  type Size,
} from "../catalog/rules/types";

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
/** Spec 18 lifecycle (0006): an enlargement row's state. Nothing else. */
export const ENLARGEMENT_STATUSES = ["queued", "done", "failed"] as const;
/** Spec 18 lifecycle 3.2: how one identity is made; `none` is the size refusal (no route can make it). */
export const ENLARGEMENT_ROUTES = ["direct", "tiles", "downscale", "downscale_tiles", "none"] as const;
export const CHUNK_STATUSES = ["queued", "running", "done", "failed"] as const;
/** spend_days.engine values. Re-exported by spend.ts as part of its contract. */
export const SPEND_ENGINES = ["catalog_qa", "catalog_compute"] as const;
/** model_policy.category: a ProductType or "*" (any). */
export const POLICY_CATEGORIES = [...PRODUCT_TYPES, "*"] as const;
/**
 * catalog_cost_events.stage: where in the pipeline the money or time went. M6-S1: `ingest` (an intake delivery) and
 * `system` (work of no one batch: the sweep, the master sync, a job run outside a batch).
 */
export const COST_STAGES = ["matte", "render", "upscale", "qa", "classify", "publish", "finalize", "ingest", "system"] as const;
/**
 * catalog_cost_events.kind: what was priced or timed. M6-S1: `job` (one Cloud Run job run, its billable seconds) and
 * `wait` (billed time spent waiting on another service, for the reconciliation of M6-S2).
 */
export const COST_KINDS = ["llm_call", "matte_call", "render", "upscale_call", "compute", "job", "wait"] as const;
/**
 * catalog_cost_events.outcome. `fallback`: the simple cut-out stood in for a failed service call. M6-S1: `timeout` (the
 * call ran out of time), `killed` (the delivery that made the call was cut off before it settled), `duplicate` (the
 * work of a delivery that lost its claim to another copy of the same task).
 */
export const COST_OUTCOMES = ["ok", "failed", "rate_limited", "cap", "fallback", "timeout", "killed", "duplicate"] as const;

/**
 * M6-S6 (M6-F3-R2) catalog_incidents.kind: anything that stopped or slowed a batch without the operator causing it.
 * Written today: `batch_failed`, `chunk_gave_up`, `invariant` (an ERROR check). Reserved for their writers: `http_5xx`
 * (a 5xx burst in a batch window), `deploy_refused`, `contamination` (M0), `alert` (infra/monitoring.sh). Stall and
 * outage incidents are left to the M1-S4b outage slice and its health ledger (M6 decision S6-20).
 */
export const INCIDENT_KINDS = ["batch_failed", "chunk_gave_up", "invariant", "http_5xx", "deploy_refused", "contamination", "alert"] as const;
export const INCIDENT_SEVERITIES = ["warning", "error"] as const;
/**
 * M6-S6 (M6-F3-R3) catalog_batch_touches.action: the operator writes on a batch or its photos after its upload that
 * count against "no person" (a decision, a retry, Fix and continue, a cancel). The wizard's own path (create, add
 * inputs, Continue, review, Start) is not a touch.
 */
/**
 * M6-F3-R3 operator touches. `hold_start` (M1-S5, 0022): "Wait" on the start countdown is a person stepping in
 * (manager decision 2026-11-05), so it counts against the zero-touch target.
 */
export const TOUCH_ACTIONS = ["decision", "retry_photo", "replace_photo", "retry_collect", "retry_links", "fix_and_continue", "cancel", "add_sku_ids", "hold_start"] as const;
/** M6-S6 (M6-F3-R1) catalog_batch_outcomes.status: the batch status the outcome was recorded at. */
export const BATCH_OUTCOME_STATUSES = ["done", "failed", "cancelled"] as const;

/**
 * M2-S1 taxonomy store (0010, docs/program/requirements/M2-analyze.md M2-F1-R1 to R3). The value lists below are the
 * table structure; the nodes, attributes and shot roles themselves are data (analyze/taxonomy.ts).
 * TAXONOMY_LEVELS is ordered from the root down: a node's level is always below its parent's.
 */
export const TAXONOMY_LEVELS = ["vertical", "department", "group", "type"] as const;
/** `not_released`: the node exists (so a gap is visible) but nothing is labelled or ruled for it yet. */
export const TAXONOMY_NODE_STATUSES = ["released", "not_released", "retired"] as const;
/** Nothing is ever deleted from the taxonomy: a definition is retired instead, so old readings still resolve. */
export const TAXONOMY_DEF_STATUSES = ["active", "retired"] as const;
export const ATTRIBUTE_VALUE_TYPES = ["enum", "number", "text", "colour"] as const;
/** `decision`: drives plans and gaps (M2-F1). `listing`: words for listing files (M2-F3). */
export const ATTRIBUTE_TIERS = ["decision", "listing"] as const;
/** Where an attribute value may come from (M2 3.2 AttributeValue.source), listed in precedence order per attribute. */
export const ATTRIBUTE_SOURCES = ["sheet", "listing_text", "image", "rule", "web"] as const;
export const TAXONOMY_ENTITIES = ["node", "attribute", "shot_role"] as const;
export const TAXONOMY_CHANGE_ACTIONS = ["seed", "create", "update"] as const;

export type BrandLine = (typeof BRAND_LINES)[number];
export type MasterSource = (typeof MASTER_SOURCES)[number];
export type SpendEngine = (typeof SPEND_ENGINES)[number];
export type CostStage = (typeof COST_STAGES)[number];
export type CostKind = (typeof COST_KINDS)[number];
export type CostOutcome = (typeof COST_OUTCOMES)[number];
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export type TouchAction = (typeof TOUCH_ACTIONS)[number];
export type BatchOutcomeStatus = (typeof BATCH_OUTCOME_STATUSES)[number];

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
/**
 * jsonb for any JSON value, string scalars included. Drizzle's `jsonb` parses the value the driver hands back a second
 * time, but pg and PGlite already parse jsonb, so a stored string "482" reads back as the number 482. This keeps the
 * driver's value as it is. Same SQL type, so migrations do not change.
 */
const jsonExact = customType<{ data: unknown; driverData: string }>({
  dataType: () => "jsonb",
  toDriver: (value) => JSON.stringify(value),
});

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
    /** M12-S1 (0016): the settings this batch read once at Start and keeps to the end; null before Start and on older batches. */
    settingsSnapshotId: text("settings_snapshot_id"),
    /**
     * M5-S3 (0021, M5 3.3): the channel ruleset version this batch read once at Start; every chunk, retry, repair and
     * publish of the batch uses that snapshot, so a later publish never reaches it. Null before Start, on older batches
     * and when nothing was published at Start (those read the latest published version). No foreign key: a version
     * read from the snapshot file (M5-F4-R8) is pinned the same way.
     */
    rulesetVersion: integer("ruleset_version"),
    /**
     * M1-S5 (M1-F4-R1, 0022): the batch digest, written by finalize from the same snapshot as the sheet, so the batch
     * page reads one row, not the outputs. Null before the first finalize and on batches finished before M1-S5.
     */
    digest: jsonb("digest").$type<BatchDigest>(),
  },
  (t) => [
    index("catalog_batches_brand_slug_idx").on(t.brandSlug),
    // Named: the generated name is longer than Postgres's 63-character limit.
    foreignKey({ name: "catalog_batches_settings_snapshot_id_fk", columns: [t.settingsSnapshotId], foreignColumns: [catalogSettingsSnapshots.id] }),
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
    /**
     * M6-F2-R4: ingest deliveries of this upload that failed in a row (the handler threw). The ingest queue retries
     * without limit; the handler stops the batch at INGEST_MAX_FAILURES, so a 429 or a deploy never counts.
     */
    ingestFailures: integer("ingest_failures").notNull().default(0),
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
    /** M0 (0009): the option this product is, when its keys resolve to exactly one (F1-R6); null until then. */
    optionId: uuid("option_id").references((): AnyPgColumn => catalogOptions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("catalog_products_brand_test_key_uq").on(t.brandSlug, t.isTest, t.productKey),
    // Two products never share public paths (path_key is the public path segment).
    uniqueIndex("catalog_products_brand_test_path_uq").on(t.brandSlug, t.isTest, t.pathKey),
    index("catalog_products_lock_batch_id_idx").on(t.lockBatchId),
    // Partial: the column is null on every existing row, so the build writes almost nothing (lookups are by equality).
    index("catalog_products_option_id_idx").on(t.optionId).where(sql`${t.optionId} IS NOT NULL`),
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
    // Migration 0008: a batch's photos (every step reads them by batch_id) and the same-photo lookups by sha256.
    index("catalog_source_images_batch_id_idx").on(t.batchId),
    index("catalog_source_images_sha256_idx").on(t.sha256),
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
    /** M0 (0009): the content version this render is (F2-R2); null on rows written before M0-S3. */
    contentVersionId: uuid("content_version_id"),
    /** M12-S1 (0016): the settings snapshot of the batch that made it (its version set); null on rows from before. */
    settingsSnapshotId: text("settings_snapshot_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("catalog_outputs_batch_id_idx").on(t.batchId),
    index("catalog_outputs_content_version_id_idx").on(t.contentVersionId).where(sql`${t.contentVersionId} IS NOT NULL`),
    // Named: the generated name is longer than Postgres's 63-character limit.
    foreignKey({ name: "catalog_outputs_content_version_id_fk", columns: [t.contentVersionId], foreignColumns: [catalogContentVersions.id] }).onDelete("set null"),
    foreignKey({ name: "catalog_outputs_settings_snapshot_id_fk", columns: [t.settingsSnapshotId], foreignColumns: [catalogSettingsSnapshots.id] }),
    index("catalog_outputs_product_id_idx").on(t.productId),
    // Exactly one live row per (product, channel, n).
    uniqueIndex("catalog_outputs_live_uq").on(t.productId, t.channel, t.n).where(sql`${t.isLive}`),
    // M1-S4 (0015): the improvement sweep's candidates, the live provisional plain renders, by first delivery.
    index("catalog_outputs_provisional_plain_idx").on(t.publishedAt).where(sql`${t.isLive} AND ${t.status} = 'verified' AND ${t.flags} @> '["provisional", "enlargement_failed"]'::jsonb`),
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
    // Migration 0008: the cross-batch reads by status (sweep, Ops) and by status and task (parked enlargement chunks).
    index("catalog_chunks_status_task_name_idx").on(t.status, t.taskName),
    enumCheck("catalog_chunks", "stage", t.stage, CHUNK_STAGES),
    enumCheck("catalog_chunks", "status", t.status, CHUNK_STATUSES),
  ],
);

/**
 * Spec 18 enlargement lifecycle (migration 0006): one row per (batch, photo, identity) the batch wants, written only
 * by the lifecycle (core pipeline/enlargement.ts and the worker's catalog/enlarge.ts). The identity is the prepared
 * pixels, the upscaler with its export hash and the effective scale (identity_hash); the object is shared by identity
 * across batches. `wanted` false is a released row (status kept). attempts and timeouts are the two counted budgets,
 * delays only visibility; identity_releases counts release events with identity_changed. The x2_* columns of
 * catalog_source_images (0005) are no longer read.
 */
export const catalogEnlargements = pgTable(
  "catalog_enlargements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    sourceImageId: uuid("source_image_id").notNull(),
    upscaler: text("upscaler").notNull(),
    factor: integer("factor").notNull(),
    scale: real("scale").notNull(),
    outW: integer("out_w").notNull(),
    outH: integer("out_h").notNull(),
    route: text("route", { enum: ENLARGEMENT_ROUTES }).notNull(),
    pixelHash: text("pixel_hash").notNull(),
    identityHash: text("identity_hash").notNull(),
    status: text("status", { enum: ENLARGEMENT_STATUSES }).notNull().default("queued"),
    wanted: boolean("wanted").notNull().default(true),
    attempts: integer("attempts").notNull().default(0),
    timeouts: integer("timeouts").notNull().default(0),
    delays: integer("delays").notNull().default(0),
    probeTimeouts: integer("probe_timeouts").notNull().default(0),
    identityReleases: integer("identity_releases").notNull().default(0),
    sends: integer("sends").notNull().default(0),
    retries: integer("retries").notNull().default(0),
    claimedAt: tsNull("claimed_at"),
    claimToken: text("claim_token"),
    tilesDone: integer("tiles_done").notNull().default(0),
    /**
     * Spec 18 lifecycle 3.10 (0007): when this row's current paid call started. Written with `timeouts + 1` before the
     * call (the call is counted before it is made) and cleared by its settle; a later delivery that finds it set knows
     * the call's delivery ended without a settle (killed at its deadline, its worker gone) and writes its cost row.
     */
    callStartedAt: tsNull("call_started_at"),
    uri: text("uri"),
    error: text("error"),
    errorKind: text("error_kind"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("catalog_enlargements_batch_id_idx").on(t.batchId),
    index("catalog_enlargements_source_image_id_idx").on(t.sourceImageId),
    uniqueIndex("catalog_enlargements_identity_uq").on(t.batchId, t.sourceImageId, t.identityHash),
    enumCheck("catalog_enlargements", "status", t.status, ENLARGEMENT_STATUSES),
    enumCheck("catalog_enlargements", "route", t.route, ENLARGEMENT_ROUTES),
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
 * M6-S1: a row of no batch (a job run or a delivery outside a batch) has no batch_id and no brand_slug; `component`
 * is the Cloud Run service or job the cost is billed to (its `component` label), `billable_ms` the instance time the
 * row explains, and `content_version_id` the M0 content version once outputs carry one.
 */
export const catalogCostEvents = pgTable(
  "catalog_cost_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    batchId: uuid("batch_id").references(() => catalogBatches.id, { onDelete: "cascade" }),
    brandSlug: text("brand_slug"),
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
    component: text("component"),
    contentVersionId: uuid("content_version_id"),
    billableMs: integer("billable_ms"),
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
// M6-S6 batch success tracking (migration 0020; docs/program/requirements/M6-reliability-cost.md M6-F3). Written only
// through packages/core/src/catalog/reliability.ts.
// ---------------------------------------------------------------------------

/**
 * One row per batch that reached an end (done, failed, cancelled), rewritten while it can still change (a re-opened
 * finalize, the sweep's 24-hour refresh). `success`: links ready, no operator touch after upload, no incident.
 * `excluded`: left out of the success rate (a cancel within 10 minutes of start is a mistake, not a failure).
 * `true_cost_usd` is filled by the reconciliation (M6-F1, later slices).
 */
export const catalogBatchOutcomes = pgTable(
  "catalog_batch_outcomes",
  {
    batchId: uuid("batch_id").primaryKey().references(() => catalogBatches.id, { onDelete: "cascade" }),
    status: text("status", { enum: BATCH_OUTCOME_STATUSES }).notNull(),
    success: boolean("success").notNull(),
    /** Why it is not a success: touched, incident, failed, cancelled. Null on a success. */
    cause: text("cause"),
    isTest: boolean("is_test").notNull().default(false),
    excluded: boolean("excluded").notNull().default(false),
    startedAt: tsNull("started_at"),
    firstLinksAt: tsNull("first_links_at"),
    linksReadyAt: tsNull("links_ready_at"),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }),
    touches: integer("touches").notNull().default(0),
    incidents: integer("incidents").notNull().default(0),
    deployOverlap: boolean("deploy_overlap").notNull().default(false),
    products: integer("products").notNull().default(0),
    productsWithLinks: integer("products_with_links").notNull().default(0),
    trueCostUsd: money("true_cost_usd"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("catalog_batch_outcomes_ended_at_idx").on(t.endedAt),
    enumCheck("catalog_batch_outcomes", "status", t.status, BATCH_OUTCOME_STATUSES),
  ],
);

/**
 * M6-F3-R2. `dedupe_key` names one incident: a state incident (an invariant) is keyed by what it is about
 * while it is open and gets its id appended when it is resolved, so the next one can open; a one-off event (a failed
 * batch, a chunk that gave up) is keyed by the event and written already resolved. Every writer inserts with
 * ON CONFLICT DO NOTHING, so a repeated sweep never writes a second row. `repeat_of`: the latest earlier incident of
 * the same kind and cause code.
 */
export const catalogIncidents = pgTable(
  "catalog_incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: INCIDENT_KINDS }).notNull(),
    severity: text("severity", { enum: INCIDENT_SEVERITIES }).notNull(),
    batchId: uuid("batch_id").references(() => catalogBatches.id, { onDelete: "cascade" }),
    causeCode: text("cause_code").notNull(),
    cause: text("cause").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    resolvedAt: tsNull("resolved_at"),
    repeatOf: uuid("repeat_of"),
    dedupeKey: text("dedupe_key").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("catalog_incidents_kind_started_at_idx").on(t.kind, t.startedAt),
    index("catalog_incidents_batch_id_idx").on(t.batchId),
    uniqueIndex("catalog_incidents_dedupe_key_uq").on(t.dedupeKey),
    enumCheck("catalog_incidents", "kind", t.kind, INCIDENT_KINDS),
    enumCheck("catalog_incidents", "severity", t.severity, INCIDENT_SEVERITIES),
  ],
);

/** M6-F3-R3: one row per operator write that counts as a touch (TOUCH_ACTIONS), written by the web API layer. */
export const catalogBatchTouches = pgTable(
  "catalog_batch_touches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id").notNull().references(() => catalogBatches.id, { onDelete: "cascade" }),
    outputId: uuid("output_id"),
    action: text("action", { enum: TOUCH_ACTIONS }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("catalog_batch_touches_batch_id_idx").on(t.batchId),
    enumCheck("catalog_batch_touches", "action", t.action, TOUCH_ACTIONS),
  ],
);

/**
 * M6-F3-R1 `deploy_overlap`: every deployed revision of a service registers itself once, when its first instance
 * starts (a deploy's probe starts it). A revision first seen inside a batch's run means a deploy overlapped the batch.
 */
export const catalogRevisions = pgTable(
  "catalog_revisions",
  {
    revision: text("revision").primaryKey(),
    service: text("service").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("catalog_revisions_first_seen_at_idx").on(t.firstSeenAt)],
);

// ---------------------------------------------------------------------------
// M0 catalog graph (migration 0009; docs/program/requirements/M0-catalog-graph.md 3.1 and 7.1). Written only through
// packages/core/src/graph/. Every table has org_id (M12 Q1). Versions and change events are append-only.
// ---------------------------------------------------------------------------

const orgId = () => text("org_id").notNull().default(DEFAULT_ORG_ID);
/** `split_part(slot, ':', 1)` is a component and the rest, if any, a 1-based position. */
const slotCheck = (table: string, col: AnyPgColumn) =>
  check(
    `${table}_slot_check`,
    sql`${col} ~ ${sql.raw(`'^(${COMPONENTS.join("|")})(:[1-9][0-9]*)?$'`)}`,
  );

/** One row per style-colour (F1). option_key: master option id, else sku_option id, else `sku:<opptra_sku>` (F1-R2). */
export const catalogOptions = pgTable(
  "catalog_options",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    brandSlug: text("brand_slug").notNull(),
    optionKey: text("option_key").notNull(),
    keySource: text("key_source", { enum: OPTION_KEY_SOURCES }).notNull(),
    line: text("line", { enum: BRAND_LINES }),
    productType: text("product_type"),
    department: text("department"),
    audience: text("audience"),
    /** False once every SKU of the option left the master; the row is never deleted (F1-R1). */
    inMaster: boolean("in_master").notNull().default(true),
    styleKey: text("style_key"),
    styleKeySource: text("style_key_source", { enum: STYLE_KEY_SOURCES }),
    styleKeyConfidence: real("style_key_confidence"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("catalog_options_brand_option_key_uq").on(t.brandSlug, t.optionKey),
    index("catalog_options_option_key_idx").on(t.optionKey),
    index("catalog_options_style_key_idx").on(t.styleKey),
    enumCheck("catalog_options", "key_source", t.keySource, OPTION_KEY_SOURCES),
    enumCheck("catalog_options", "line", t.line, BRAND_LINES),
    enumCheck("catalog_options", "style_key_source", t.styleKeySource, STYLE_KEY_SOURCES),
    check("catalog_options_style_key_confidence_check", sql`${t.styleKeyConfidence} BETWEEN 0 AND 1`),
  ],
);

/** One row per option x channel x country. */
export const catalogChannelListings = pgTable(
  "catalog_channel_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    optionId: uuid("option_id")
      .notNull()
      .references(() => catalogOptions.id),
    channel: text("channel", { enum: CHANNEL_IDS }).$type<ChannelId>().notNull(),
    market: text("market", { enum: MARKETS }).notNull(),
    status: text("status", { enum: LISTING_STATUSES }).notNull().default("unknown"),
    firstSeenLiveAt: tsNull("first_seen_live_at"),
    lastVerifiedAt: tsNull("last_verified_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("catalog_channel_listings_option_channel_market_uq").on(t.optionId, t.channel, t.market),
    enumCheck("catalog_channel_listings", "channel", t.channel, CHANNEL_IDS),
    enumCheck("catalog_channel_listings", "market", t.market, MARKETS),
    enumCheck("catalog_channel_listings", "status", t.status, LISTING_STATUSES),
  ],
);

/** Every key a listing is known by, at SKU level. A key never points at two listings (F1-R5). */
export const catalogListingKeys = pgTable(
  "catalog_listing_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => catalogChannelListings.id),
    opptraSku: text("opptra_sku"),
    channel: text("channel", { enum: CHANNEL_IDS }).$type<ChannelId>().notNull(),
    market: text("market", { enum: MARKETS }).notNull(),
    keyKind: text("key_kind", { enum: KEY_KINDS }).notNull(),
    keyValue: text("key_value").notNull(),
    source: text("source", { enum: KEY_SOURCES }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("catalog_listing_keys_channel_market_kind_value_uq").on(t.channel, t.market, t.keyKind, t.keyValue),
    index("catalog_listing_keys_opptra_sku_idx").on(t.opptraSku),
    index("catalog_listing_keys_listing_id_idx").on(t.listingId),
    enumCheck("catalog_listing_keys", "channel", t.channel, CHANNEL_IDS),
    enumCheck("catalog_listing_keys", "market", t.market, MARKETS),
    enumCheck("catalog_listing_keys", "key_kind", t.keyKind, KEY_KINDS),
    enumCheck("catalog_listing_keys", "source", t.source, KEY_SOURCES),
    // The literal "0" and blank values are not keys (F1 edge cases).
    check("catalog_listing_keys_key_value_check", sql`btrim(${t.keyValue}) <> '' AND ${t.keyValue} <> '0'`),
  ],
);

/**
 * Which sku_map.channel_ids column maps to which channel, market and key kind (F1-R3, admin data, no code change for a
 * new column). channel null: the key belongs to every listing of the SKU (child_zsku). Rows are written by M0-S2.
 */
export const catalogKeyMappings = pgTable(
  "catalog_key_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    skuColumn: text("sku_column", { enum: SKU_CHANNEL_KEYS }).notNull(),
    channel: text("channel", { enum: CHANNEL_IDS }).$type<ChannelId>(),
    market: text("market", { enum: MARKETS }),
    keyKind: text("key_kind", { enum: KEY_KINDS }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("catalog_key_mappings_org_column_uq").on(t.orgId, t.skuColumn),
    enumCheck("catalog_key_mappings", "sku_column", t.skuColumn, SKU_CHANNEL_KEYS),
    enumCheck("catalog_key_mappings", "channel", t.channel, CHANNEL_IDS),
    enumCheck("catalog_key_mappings", "market", t.market, MARKETS),
    enumCheck("catalog_key_mappings", "key_kind", t.keyKind, KEY_KINDS),
  ],
);

/** One listing a conflicting key points at (F1-R5). */
export type KeyConflictCandidate = { listingId: string; optionId: string; opptraSku: string | null; source: string };

/**
 * Keys that point at two or more listings (F1-R5, migration 0013). Such a key is not written to catalog_listing_keys; it
 * is listed here with every candidate for the Ops page and the export (`catalog_os.key_conflicts`). Rebuilt by the graph
 * sync: a conflict seen again keeps its row, one no longer seen gets `resolved_at`. Never deleted.
 */
export const catalogKeyConflicts = pgTable(
  "catalog_key_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    channel: text("channel", { enum: CHANNEL_IDS }).$type<ChannelId>().notNull(),
    market: text("market", { enum: MARKETS }).notNull(),
    keyKind: text("key_kind", { enum: KEY_KINDS }).notNull(),
    keyValue: text("key_value").notNull(),
    candidates: jsonb("candidates").$type<KeyConflictCandidate[]>().notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: tsNull("resolved_at"),
  },
  (t) => [
    unique("catalog_key_conflicts_org_key_uq").on(t.orgId, t.channel, t.market, t.keyKind, t.keyValue),
    enumCheck("catalog_key_conflicts", "channel", t.channel, CHANNEL_IDS),
    enumCheck("catalog_key_conflicts", "market", t.market, MARKETS),
    enumCheck("catalog_key_conflicts", "key_kind", t.keyKind, KEY_KINDS),
  ],
);

/** One row per distinct binary. phash: the 64-bit difference hash, stored as a signed bigint (F2-R7). */
export const catalogAssets = pgTable(
  "catalog_assets",
  {
    sha256: text("sha256").primaryKey(),
    orgId: orgId(),
    uri: text("uri").notNull(),
    mime: text("mime").notNull(),
    width: integer("width"),
    height: integer("height"),
    bytes: bigint("bytes", { mode: "number" }),
    phash: bigint("phash", { mode: "bigint" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("catalog_assets_sha256_check", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`)],
);

/**
 * One immutable piece of content (F2). Deduped on (option, scope, component, hash, producer, producer_ref), nulls
 * equal, so recording the same content twice returns the first row (F2-R6). Never updated; only test versions are
 * deleted, by test cleanup (F2-R5).
 */
export const catalogContentVersions = pgTable(
  "catalog_content_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    optionId: uuid("option_id").references(() => catalogOptions.id),
    scope: text("scope").$type<VersionScope>().notNull(),
    component: text("component", { enum: COMPONENTS }).notNull(),
    role: text("role", { enum: IMAGE_ROLES }),
    position: integer("position"),
    source: text("source", { enum: VERSION_SOURCES }).notNull(),
    aiGenerated: boolean("ai_generated").notNull(),
    producer: text("producer").notNull(),
    producerRef: text("producer_ref"),
    assetSha256: text("asset_sha256").references(() => catalogAssets.sha256),
    textValue: text("text_value"),
    jsonValue: jsonb("json_value").$type<unknown>(),
    contentHash: text("content_hash").notNull(),
    hashKind: text("hash_kind", { enum: HASH_KINDS }).notNull().default("sha256"),
    parentVersionIds: uuid("parent_version_ids").array().notNull().default(sql`'{}'::uuid[]`),
    publicUrl: text("public_url"),
    language: text("language", { enum: LANGUAGES }),
    market: text("market", { enum: MARKETS }),
    /** The M7 route that made it; never shown to operators. */
    routeId: text("route_id"),
    promptVersion: text("prompt_version"),
    settingsSnapshotId: text("settings_snapshot_id"),
    batchId: uuid("batch_id").references(() => catalogBatches.id, { onDelete: "set null" }),
    isTest: boolean("is_test").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("catalog_content_versions_identity_uq")
      .on(t.optionId, t.scope, t.component, t.contentHash, t.producer, t.producerRef)
      .nullsNotDistinct(),
    index("catalog_content_versions_option_id_idx").on(t.optionId),
    index("catalog_content_versions_asset_sha256_idx").on(t.assetSha256),
    index("catalog_content_versions_batch_id_idx").on(t.batchId),
    check("catalog_content_versions_scope_check", inList(t.scope, ["master", ...CHANNEL_IDS])),
    enumCheck("catalog_content_versions", "component", t.component, COMPONENTS),
    enumCheck("catalog_content_versions", "role", t.role, IMAGE_ROLES),
    enumCheck("catalog_content_versions", "source", t.source, VERSION_SOURCES),
    enumCheck("catalog_content_versions", "hash_kind", t.hashKind, HASH_KINDS),
    enumCheck("catalog_content_versions", "language", t.language, LANGUAGES),
    enumCheck("catalog_content_versions", "market", t.market, MARKETS),
    check("catalog_content_versions_producer_check", sql`${t.producer} ~ ${sql.raw(`'${PRODUCER_PATTERN}'`)}`),
    check("catalog_content_versions_position_check", sql`${t.position} >= 1`),
    // F2-R4: a generated image is always flagged as AI-made.
    check("catalog_content_versions_ai_generated_check", sql`${t.source} <> 'generated' OR ${t.aiGenerated}`),
    // At most one payload; none only for a crc32c backfill row whose object is gone (F4-R2).
    check(
      "catalog_content_versions_payload_check",
      sql`num_nonnulls(${t.assetSha256}, ${t.textValue}, ${t.jsonValue}) = 1 OR (num_nonnulls(${t.assetSha256}, ${t.textValue}, ${t.jsonValue}) = 0 AND ${t.hashKind} = 'crc32c')`,
    ),
  ],
);

/**
 * The change log (F3, 3.2): append-only, read by cursor (`seq`). Every event names a reason and a change type (F3-R9),
 * except observed_other events and backfill rows (evidence or reason `backfill`), which may lack either (decision D9).
 * to_version_id is null exactly when a slot was emptied.
 */
export const catalogChangeEvents = pgTable(
  "catalog_change_events",
  {
    seq: bigserial("seq", { mode: "bigint" }).primaryKey(),
    orgId: orgId(),
    idempotencyKey: text("idempotency_key").notNull(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => catalogChannelListings.id),
    slot: text("slot").$type<Slot>().notNull(),
    fromVersionId: uuid("from_version_id"),
    toVersionId: uuid("to_version_id"),
    kind: text("kind", { enum: CHANGE_EVENT_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    evidence: text("evidence", { enum: EVIDENCE_KINDS }).notNull(),
    evidenceRef: text("evidence_ref"),
    actor: text("actor").notNull(),
    reasonKind: text("reason_kind", { enum: REASON_KINDS }),
    reasonRef: text("reason_ref"),
    /** M10's change-type id: a row of catalog_change_types (M10-S1a, migration 0019). */
    changeTypeId: text("change_type_id"),
    changeSetId: uuid("change_set_id"),
    batchId: uuid("batch_id").references(() => catalogBatches.id, { onDelete: "set null" }),
    experimentId: text("experiment_id"),
  },
  (t) => [
    unique("catalog_change_events_idempotency_key_uq").on(t.idempotencyKey),
    // Named foreign keys: the generated names pass Postgres's 63-character limit.
    // RESTRICT: deleting a version never erases the log; test cleanup deletes test events explicitly first (D13).
    foreignKey({ name: "catalog_change_events_from_version_id_fk", columns: [t.fromVersionId], foreignColumns: [catalogContentVersions.id] }).onDelete("restrict"),
    foreignKey({ name: "catalog_change_events_to_version_id_fk", columns: [t.toVersionId], foreignColumns: [catalogContentVersions.id] }).onDelete("restrict"),
    // M10-S1a: an unknown change type is refused, never stored (types are retired, never deleted).
    foreignKey({ name: "catalog_change_events_change_type_id_fk", columns: [t.changeTypeId], foreignColumns: [catalogChangeTypes.id] }).onDelete("restrict"),
    index("catalog_change_events_from_version_id_idx").on(t.fromVersionId),
    index("catalog_change_events_to_version_id_idx").on(t.toVersionId),
    index("catalog_change_events_batch_id_idx").on(t.batchId),
    index("catalog_change_events_listing_slot_at_idx").on(t.listingId, t.slot, t.at),
    index("catalog_change_events_experiment_id_idx").on(t.experimentId),
    slotCheck("catalog_change_events", t.slot),
    enumCheck("catalog_change_events", "kind", t.kind, CHANGE_EVENT_KINDS),
    enumCheck("catalog_change_events", "evidence", t.evidence, EVIDENCE_KINDS),
    enumCheck("catalog_change_events", "reason_kind", t.reasonKind, REASON_KINDS),
    // IS NOT DISTINCT FROM: a null reason_kind must make this operand false, not null (a null CHECK passes).
    check(
      "catalog_change_events_reason_check",
      sql`(${t.reasonKind} IS NOT NULL AND ${t.changeTypeId} IS NOT NULL) OR ${t.kind} = 'observed_other' OR ${t.evidence} = 'backfill' OR ${t.reasonKind} IS NOT DISTINCT FROM 'backfill'`,
    ),
    check("catalog_change_events_to_version_check", sql`(${t.toVersionId} IS NULL) = (${t.kind} = 'removed')`),
  ],
);

/** Derived from change events (F3-R6): which version held a slot from when to when. version_id null: slot empty. */
export const catalogLiveIntervals = pgTable(
  "catalog_live_intervals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    listingId: uuid("listing_id").notNull(),
    slot: text("slot").$type<Slot>().notNull(),
    versionId: uuid("version_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    validTo: tsNull("valid_to"),
    state: text("state", { enum: LIVE_STATES }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("catalog_live_intervals_listing_slot_from_uq").on(t.listingId, t.slot, t.validFrom),
    foreignKey({ name: "catalog_live_intervals_listing_id_fk", columns: [t.listingId], foreignColumns: [catalogChannelListings.id] }),
    foreignKey({ name: "catalog_live_intervals_version_id_fk", columns: [t.versionId], foreignColumns: [catalogContentVersions.id] }).onDelete("restrict"),
    index("catalog_live_intervals_version_id_idx").on(t.versionId),
    slotCheck("catalog_live_intervals", t.slot),
    enumCheck("catalog_live_intervals", "state", t.state, LIVE_STATES),
    check("catalog_live_intervals_range_check", sql`${t.validTo} IS NULL OR ${t.validTo} > ${t.validFrom}`),
  ],
);

/** Written by M4 only. A do_not_touch row that is not released freezes the listing (F3-R7). */
export const catalogTreatmentAssignments = pgTable(
  "catalog_treatment_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    experimentId: text("experiment_id").notNull(),
    listingId: uuid("listing_id").notNull(),
    arm: text("arm", { enum: ARMS }).notNull(),
    pairId: text("pair_id"),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    frozenAt: tsNull("frozen_at"),
    doNotTouch: boolean("do_not_touch").notNull().default(false),
    releasedAt: tsNull("released_at"),
  },
  (t) => [
    unique("catalog_treatment_assignments_experiment_listing_uq").on(t.experimentId, t.listingId),
    foreignKey({ name: "catalog_treatment_assignments_listing_id_fk", columns: [t.listingId], foreignColumns: [catalogChannelListings.id] }),
    // The guard's read: a listing's assignments that still hold (control or frozen treatment).
    index("catalog_treatment_assignments_active_idx").on(t.listingId).where(sql`${t.releasedAt} IS NULL`),
    enumCheck("catalog_treatment_assignments", "arm", t.arm, ARMS),
  ],
);

/** Checkpoints of the resumable backfill job (F4-R6). */
export const catalogBackfillRuns = pgTable("catalog_backfill_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  job: text("job").notNull(),
  cursor: jsonb("cursor").$type<Record<string, unknown>>().notNull().default({}),
  counts: jsonb("counts").$type<Record<string, number>>().notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: tsNull("finished_at"),
  error: text("error"),
  updatedAt: updatedAt(),
});

/** One row per BigQuery export run (F5-R4). */
export const catalogGraphExportRuns = pgTable("catalog_graph_export_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: orgId(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: tsNull("finished_at"),
  rowsPerTable: jsonb("rows_per_table").$type<Record<string, number>>().notNull().default({}),
  maxSeq: bigint("max_seq", { mode: "bigint" }),
  error: text("error"),
});

/** The outcome link (3.1): every key of every listing, the join to sales, ads, stock and price rows in BigQuery. */
export const catalogOutcomeKeys = pgView("catalog_outcome_keys").as((qb) =>
  qb
    .select({
      listingId: catalogListingKeys.listingId,
      optionId: catalogChannelListings.optionId,
      channel: catalogChannelListings.channel,
      market: catalogChannelListings.market,
      keyKind: catalogListingKeys.keyKind,
      keyValue: catalogListingKeys.keyValue,
      opptraSku: catalogListingKeys.opptraSku,
      orgId: catalogListingKeys.orgId,
    })
    .from(catalogListingKeys)
    .innerJoin(catalogChannelListings, sql`${catalogChannelListings.id} = ${catalogListingKeys.listingId}`),
);

// ---------------------------------------------------------------------------
// M2 taxonomy store (M2-S1). Read and written only through analyze/taxonomy.ts, which keeps the change log.
// ---------------------------------------------------------------------------

/** One allowed value of an enum attribute. `key` is the stored word; it never changes meaning (retire and add). */
export type AttributeAllowedValue = { key: string; label: string; definition?: string };

/**
 * The one category tree of the system (M2-F1-R1, integration decision D1): M5 rules scope by these ids. `id` is the
 * dotted path from the root (`fashion.apparel.upper.top`), so it is stable and readable in rule data; a node never
 * moves. `aliases` are other words for the node (brand sheet categories, rule dataset scopes), used to map words to a
 * node, never shown as its name.
 */
export const catalogTaxonomyNodes = pgTable(
  "catalog_taxonomy_nodes",
  {
    id: text("id").primaryKey(),
    parentId: text("parent_id").references((): AnyPgColumn => catalogTaxonomyNodes.id),
    level: text("level", { enum: TAXONOMY_LEVELS }).notNull(),
    name: text("name").notNull(),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    status: text("status", { enum: TAXONOMY_NODE_STATUSES }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("catalog_taxonomy_nodes_parent_id_idx").on(t.parentId),
    enumCheck("catalog_taxonomy_nodes", "level", t.level, TAXONOMY_LEVELS),
    enumCheck("catalog_taxonomy_nodes", "status", t.status, TAXONOMY_NODE_STATUSES),
  ],
);

/**
 * Attribute definitions as data (M2-F1-R2). `node_ids`: the nodes it applies to, each with all its descendants.
 * `allowed_values` only for `enum`; `unit` only for `number`. `source_precedence`: the sources allowed, best first.
 */
export const catalogAttributeDefs = pgTable(
  "catalog_attribute_defs",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    valueType: text("value_type", { enum: ATTRIBUTE_VALUE_TYPES }).notNull(),
    allowedValues: jsonb("allowed_values").$type<AttributeAllowedValue[]>(),
    unit: text("unit"),
    nodeIds: jsonb("node_ids").$type<string[]>().notNull(),
    tier: text("tier", { enum: ATTRIBUTE_TIERS }).notNull(),
    sourcePrecedence: jsonb("source_precedence").$type<(typeof ATTRIBUTE_SOURCES)[number][]>().notNull(),
    status: text("status", { enum: TAXONOMY_DEF_STATUSES }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    enumCheck("catalog_attribute_defs", "value_type", t.valueType, ATTRIBUTE_VALUE_TYPES),
    enumCheck("catalog_attribute_defs", "tier", t.tier, ATTRIBUTE_TIERS),
    enumCheck("catalog_attribute_defs", "status", t.status, TAXONOMY_DEF_STATUSES),
  ],
);

/**
 * Shot roles as data per taxonomy node (M2-F1-R3). A node uses the roles of the nearest node on its path (itself
 * first) that has any, so `fashion.apparel` roles serve every apparel type until a type gets its own set.
 */
export const catalogShotRoles = pgTable(
  "catalog_shot_roles",
  {
    nodeId: text("node_id")
      .notNull()
      .references(() => catalogTaxonomyNodes.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    definition: text("definition").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    status: text("status", { enum: TAXONOMY_DEF_STATUSES }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.key] }),
    enumCheck("catalog_shot_roles", "status", t.status, TAXONOMY_DEF_STATUSES),
  ],
);

/**
 * Append-only log of every taxonomy write, with the full row after the write. The highest id is the taxonomy
 * revision: a batch that records it can later tell exactly which definitions it ran with (M12-S1 version sets).
 * That holds because every write holds one advisory lock to its commit (analyze/taxonomy.ts writeTransaction), so
 * ids are handed out in commit order. Any new writer to these tables must use writeTransaction too.
 * `entity_id` is the node or attribute id, or `<node_id>/<key>` for a shot role.
 */
export const catalogTaxonomyChanges = pgTable(
  "catalog_taxonomy_changes",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    entity: text("entity", { enum: TAXONOMY_ENTITIES }).notNull(),
    entityId: text("entity_id").notNull(),
    version: integer("version").notNull(),
    action: text("action", { enum: TAXONOMY_CHANGE_ACTIONS }).notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    changedBy: text("changed_by").notNull(),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    index("catalog_taxonomy_changes_entity_idx").on(t.entity, t.entityId),
    enumCheck("catalog_taxonomy_changes", "entity", t.entity, TAXONOMY_ENTITIES),
    enumCheck("catalog_taxonomy_changes", "action", t.action, TAXONOMY_CHANGE_ACTIONS),
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
export type CatalogEnlargement = typeof catalogEnlargements.$inferSelect;
export type CatalogEvalLabel = typeof catalogEvalLabels.$inferSelect;
export type CatalogEvalJudgement = typeof catalogEvalJudgements.$inferSelect;
export type SpendDay = typeof spendDays.$inferSelect;
export type CatalogCostEvent = typeof catalogCostEvents.$inferSelect;
export type CatalogOption = typeof catalogOptions.$inferSelect;
export type CatalogChannelListing = typeof catalogChannelListings.$inferSelect;
export type CatalogListingKey = typeof catalogListingKeys.$inferSelect;
export type CatalogKeyConflict = typeof catalogKeyConflicts.$inferSelect;
export type CatalogAsset = typeof catalogAssets.$inferSelect;
export type CatalogContentVersion = typeof catalogContentVersions.$inferSelect;
export type CatalogChangeEvent = typeof catalogChangeEvents.$inferSelect;
export type CatalogLiveInterval = typeof catalogLiveIntervals.$inferSelect;
export type CatalogTreatmentAssignment = typeof catalogTreatmentAssignments.$inferSelect;
export type TaxonomyNodeRow = typeof catalogTaxonomyNodes.$inferSelect;
export type AttributeDefRow = typeof catalogAttributeDefs.$inferSelect;
export type ShotRoleRow = typeof catalogShotRoles.$inferSelect;
export type TaxonomyChangeRow = typeof catalogTaxonomyChanges.$inferSelect;

// ---------------------------------------------------------------------------
// M7-F2 vendor routes: the live routing every capability call goes through
// ---------------------------------------------------------------------------

/**
 * One route per capability, adapter and model (M7 3.3 `Route`). `state` is the kill switch: only `serving` routes
 * are called. Seeded check-then-insert by `ensureSeedRoutes` (vendor/route-table.ts); the circuit breaker lives in
 * the worker process, not here.
 */
export const vendorRoutes = pgTable(
  "vendor_routes",
  {
    id: text("id").primaryKey(),
    capability: text("capability", { enum: CAPABILITIES }).notNull(),
    rank: integer("rank").notNull(),
    adapter: text("adapter", { enum: ROUTE_ADAPTERS }).notNull(),
    model: text("model").notNull(),
    paramsVersion: text("params_version").notNull().default("1"),
    priceUsd: money("price_usd"),
    rateLimitPerMin: integer("rate_limit_per_min"),
    region: text("region"),
    licence: text("licence"),
    noTrainingTerms: text("no_training_terms"),
    state: text("state", { enum: ROUTE_STATES }).notNull(),
    /** M3-F2-R3: an overflow route's daily spend cap in USD; null on an overflow route means it is never called. */
    dailyCapUsd: money("daily_cap_usd"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("vendor_routes_capability_adapter_model_uq").on(t.capability, t.adapter, t.model),
    index("vendor_routes_capability_rank_idx").on(t.capability, t.rank),
    enumCheck("vendor_routes", "capability", t.capability, CAPABILITIES),
    enumCheck("vendor_routes", "adapter", t.adapter, ROUTE_ADAPTERS),
    enumCheck("vendor_routes", "state", t.state, ROUTE_STATES),
    // M7-F2-R7: a route that sends brand photos is serving only with a written no-training position (not pending).
    check(
      "vendor_routes_serving_needs_terms_check",
      sql`${t.state} <> 'serving' OR NOT (${inList(t.capability, BRAND_PHOTO_CAPABILITIES)}) OR (btrim(coalesce(${t.noTrainingTerms}, '')) <> '' AND lower(btrim(${t.noTrainingTerms})) NOT LIKE 'pending%')`,
    ),
  ],
);

/** `route.changed` (M7 3.2): every change of a route's state or rank, who made it, and the run that justified it. */
export const vendorRouteChanges = pgTable(
  "vendor_route_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routeId: text("route_id").notNull().references(() => vendorRoutes.id),
    capability: text("capability", { enum: CAPABILITIES }).notNull(),
    fromState: text("from_state", { enum: ROUTE_STATES }),
    toState: text("to_state", { enum: ROUTE_STATES }).notNull(),
    fromRank: integer("from_rank"),
    toRank: integer("to_rank").notNull(),
    changedBy: text("changed_by").notNull(),
    reason: text("reason").notNull(),
    runId: text("run_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("vendor_route_changes_route_id_at_idx").on(t.routeId, t.at),
    enumCheck("vendor_route_changes", "capability", t.capability, CAPABILITIES),
    enumCheck("vendor_route_changes", "from_state", t.fromState, ROUTE_STATES),
    enumCheck("vendor_route_changes", "to_state", t.toState, ROUTE_STATES),
  ],
);

export type VendorRouteRow = typeof vendorRoutes.$inferSelect;
export type VendorRouteChange = typeof vendorRouteChanges.$inferSelect;

// ---------------------------------------------------------------------------
// M1 intake and auto-decide (M1-S3, migration 0014)
// ---------------------------------------------------------------------------

/**
 * M1-F3-R1: the auto-decide rule table. Each hold cause the QA triage finds maps to an automatic action, for one
 * channel or for every channel (`*`); a channel row wins over the `*` row. The id is `<cause>:<channel>`, recorded on
 * every output a rule decided. Seeded by migration 0014 with the M1-F3-R1 defaults. Start copies the enabled rules
 * into the batch (`options.autoDecide`), so a change applies to the next batch, never to one already running.
 */
export const catalogAutoDecideRules = pgTable(
  "catalog_auto_decide_rules",
  {
    id: text("id").primaryKey(),
    cause: text("cause", { enum: HOLD_CAUSES }).notNull(),
    channel: text("channel", { enum: AUTO_DECIDE_CHANNELS }).notNull(),
    action: text("action", { enum: AUTO_DECIDE_ACTIONS }).notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedBy: text("updated_by").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("catalog_auto_decide_rules_cause_channel_uq").on(t.cause, t.channel),
    enumCheck("catalog_auto_decide_rules", "cause", t.cause, HOLD_CAUSES),
    enumCheck("catalog_auto_decide_rules", "channel", t.channel, AUTO_DECIDE_CHANNELS),
    enumCheck("catalog_auto_decide_rules", "action", t.action, AUTO_DECIDE_ACTIONS),
  ],
);

export type AutoDecideRuleRow = typeof catalogAutoDecideRules.$inferSelect;

/**
 * M1-S4 (M1-F3-R4, R5): the improvement of one photo whose plain render a batch delivered `provisional` because the
 * upscaler could not enlarge it. One row per batch and photo: how many tries were made (bounded by IMPROVE_MAX_TRIES
 * within IMPROVE_WINDOW_MS, catalog/improve.ts), when the last one started, and when the photo's slots were found no
 * longer provisional (`improved_at`, the "improved within 72 h" measure). Kept apart from the output's `compliance`,
 * which every render rewrites.
 */
export const catalogImprovements = pgTable(
  "catalog_improvements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => catalogBatches.id, { onDelete: "cascade" }),
    productId: uuid("product_id").notNull(),
    sourceImageId: uuid("source_image_id").notNull(),
    tries: integer("tries").notNull().default(0),
    lastTriedAt: tsNull("last_tried_at"),
    improvedAt: tsNull("improved_at"),
    /**
     * The photo's outputs as they were delivered (rows of catalog_outputs as JSON), kept while a try runs: a re-made slot
     * that does not pass is put back from it, so a failed try never downgrades a delivered link (null between tries).
     */
    previous: jsonb("previous").$type<Record<string, unknown>[]>(),
    /** When the photo stopped being a candidate without being improved, and why (IMPROVEMENT_END_REASONS). */
    endedAt: tsNull("ended_at"),
    endReason: text("end_reason", { enum: IMPROVEMENT_END_REASONS }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("catalog_improvements_batch_photo_uq").on(t.batchId, t.sourceImageId),
    enumCheck("catalog_improvements", "end_reason", t.endReason, IMPROVEMENT_END_REASONS),
  ],
);

export type CatalogImprovement = typeof catalogImprovements.$inferSelect;

// ---------------------------------------------------------------------------
// M12-S1 settings store (migration 0016). Written only through settings/store.ts; the structure of each setting is
// code (settings/registry.ts), the values are rows here.
// ---------------------------------------------------------------------------

/**
 * Every value a setting has had, append-only: `setting.changed` (M12 3.2) is this row. The current value at one level
 * (`scope_key`) is the highest `version` there. `value` null means no value at this level, so the level above applies
 * (a revert of a first override writes it). `scope_key` is the canonical form of `scope`: '' for the programme
 * default, else `channel=noon;category=fashion.footwear;brand=campus` with only the levels set, in that order.
 */
export const catalogSettingVersions = pgTable(
  "catalog_setting_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgId(),
    key: text("key").notNull(),
    scopeKey: text("scope_key").notNull().default(""),
    scope: jsonb("scope").$type<SettingScope>().notNull().default({}),
    version: integer("version").notNull(),
    value: jsonb("value").$type<SettingValue | null>(),
    schemaVersion: integer("schema_version").notNull(),
    changedBy: text("changed_by").notNull(),
    reason: text("reason"),
    /** Set on a revert: the version whose change this one undoes. */
    revertsVersionId: uuid("reverts_version_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("catalog_setting_versions_org_key_scope_version_uq").on(t.orgId, t.key, t.scopeKey, t.version),
    foreignKey({ name: "catalog_setting_versions_reverts_version_id_fk", columns: [t.revertsVersionId], foreignColumns: [t.id] }),
    check("catalog_setting_versions_version_check", sql`${t.version} >= 1`),
  ],
);

/**
 * The version set one batch runs with (M12 3.3 rules 1 and 2): every current setting version at Start, the registry
 * defaults then in force and the taxonomy revision. Immutable. Batches and outputs point here; M0 content versions
 * carry the same id in `settings_snapshot_id`. Text id (a UUID string) to match that column.
 */
export const catalogSettingsSnapshots = pgTable(
  "catalog_settings_snapshots",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    batchId: uuid("batch_id").references((): AnyPgColumn => catalogBatches.id, { onDelete: "set null" }),
    data: jsonb("data").$type<SettingsSnapshotData>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("catalog_settings_snapshots_batch_id_idx").on(t.batchId)],
);

export type SettingVersionRow = typeof catalogSettingVersions.$inferSelect;
export type SettingsSnapshotRow = typeof catalogSettingsSnapshots.$inferSelect;

// ---------------------------------------------------------------------------
// M5 channel rules (M5-S1). Rules, channel records and image policies are append-only versions: an edit inserts a new
// version row tagged with the ruleset version it takes effect in, so every ruleset version can be rebuilt and the
// history is the table itself. Written only through catalog/rules/store.ts, which holds one advisory lock per write.
// ---------------------------------------------------------------------------

const PRIORITY_GROUPS = ["P1", "P2"] as const;
const ANCHORS = ["centre", "bottom-centre"] as const;

/** One ruleset version. Draft while its rows are written; published with a frozen snapshot. */
export const catalogRulesets = pgTable(
  "catalog_rulesets",
  {
    version: integer("version").primaryKey(),
    status: text("status", { enum: RULESET_STATUSES }).notNull(),
    reason: text("reason").notNull(),
    changedRuleIds: jsonb("changed_rule_ids").$type<string[]>().notNull().default([]),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    publishedBy: text("published_by"),
    publishedAt: tsNull("published_at"),
  },
  (t) => [
    enumCheck("catalog_rulesets", "status", t.status, RULESET_STATUSES),
    check("catalog_rulesets_version_check", sql`${t.version} >= 1`),
  ],
);

/** The frozen snapshot of a published ruleset version (M5 3.3): a batch pins one and uses it from start to end. */
export const catalogRulesetSnapshots = pgTable("catalog_ruleset_snapshots", {
  version: integer("version")
    .primaryKey()
    .references(() => catalogRulesets.version),
  hash: text("hash").notNull(),
  body: jsonb("body").$type<RulesetSnapshot>().notNull(),
  createdAt: createdAt(),
});

/** Every version of every rule (M5 3.2 `Rule`). Never updated: an edit is a new (rule_id, version) row. */
export const catalogRules = pgTable(
  "catalog_rules",
  {
    ruleId: text("rule_id").notNull(),
    version: integer("version").notNull(),
    rulesetVersion: integer("ruleset_version")
      .notNull()
      .references(() => catalogRulesets.version),
    channel: text("channel").notNull(),
    market: text("market", { enum: RULE_MARKETS }),
    /** M2 taxonomy node ids, or ["all"]. */
    categoryScope: jsonb("category_scope").$type<string[]>().notNull(),
    /** The dataset's own scope word or list, kept exactly (M5-F1-R2). */
    datasetScope: jsonExact("dataset_scope"),
    audience: jsonb("audience").$type<RuleAudience[]>(),
    brandScope: text("brand_scope").notNull().default("all"),
    language: text("language", { enum: RULE_LANGUAGES }).notNull(),
    component: text("component", { enum: RULE_COMPONENTS }).notNull(),
    field: text("field").notNull(),
    operator: text("operator").notNull(),
    value: jsonExact("value"),
    text: text("text"),
    declaredSeverity: text("declared_severity", { enum: RULE_SEVERITIES }).notNull(),
    evidence: text("evidence", { enum: EVIDENCE_GRADES }).notNull(),
    confirmedBy: text("confirmed_by"),
    source: text("source").notNull(),
    conflictsWith: jsonb("conflicts_with").$type<string[]>().notNull().default([]),
    checkable: boolean("checkable").notNull(),
    judgeMethod: text("judge_method"),
    status: text("status", { enum: RULE_STATUSES }).notNull(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.ruleId, t.version] }),
    index("catalog_rules_ruleset_version_idx").on(t.rulesetVersion),
    enumCheck("catalog_rules", "market", t.market, RULE_MARKETS),
    enumCheck("catalog_rules", "language", t.language, RULE_LANGUAGES),
    enumCheck("catalog_rules", "component", t.component, RULE_COMPONENTS),
    enumCheck("catalog_rules", "declared_severity", t.declaredSeverity, RULE_SEVERITIES),
    enumCheck("catalog_rules", "evidence", t.evidence, EVIDENCE_GRADES),
    enumCheck("catalog_rules", "status", t.status, RULE_STATUSES),
    check("catalog_rules_reason_check", sql`btrim(${t.reason}) <> ''`),
  ],
);

/** The conflict register (M5-F2): sets of rules that cannot all hold, with options and a recommendation. */
export const catalogRuleConflicts = pgTable(
  "catalog_rule_conflicts",
  {
    id: text("id").primaryKey(),
    topic: text("topic").notNull(),
    severity: text("severity", { enum: CONFLICT_SEVERITIES }).notNull(),
    ruleIds: jsonb("rule_ids").$type<string[]>().notNull(),
    options: jsonb("options").$type<string[]>().notNull(),
    recommendation: text("recommendation").notNull(),
    reasoning: text("reasoning").notNull(),
    status: text("status", { enum: CONFLICT_STATUSES }).notNull(),
    /** The decision in force; null while open. */
    decisionId: text("decision_id").references((): AnyPgColumn => catalogRuleDecisions.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    enumCheck("catalog_rule_conflicts", "severity", t.severity, CONFLICT_SEVERITIES),
    enumCheck("catalog_rule_conflicts", "status", t.status, CONFLICT_STATUSES),
  ],
);

/** Every conflict decision ever made (append-only), with who, when, why and the ruleset version it published. */
export const catalogRuleDecisions = pgTable(
  "catalog_rule_decisions",
  {
    id: text("id").primaryKey(),
    conflictId: text("conflict_id")
      .notNull()
      .references(() => catalogRuleConflicts.id),
    option: text("option").notNull(),
    reason: text("reason").notNull(),
    decidedBy: text("decided_by").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    rulesetVersion: integer("ruleset_version")
      .notNull()
      .references(() => catalogRulesets.version),
    createdAt: createdAt(),
  },
  (t) => [index("catalog_rule_decisions_conflict_id_idx").on(t.conflictId)],
);

/** The channel registry (M5-F1-R3): every version of every channel record. Replaces the constants in channels.ts. */
export const catalogChannelRecords = pgTable(
  "catalog_channel_records",
  {
    channelId: text("channel_id").notNull(),
    version: integer("version").notNull(),
    rulesetVersion: integer("ruleset_version")
      .notNull()
      .references(() => catalogRulesets.version),
    label: text("label").notNull(),
    group: text("group", { enum: PRIORITY_GROUPS }).notNull(),
    minCanvas: jsonb("min_canvas").$type<Size>().notNull(),
    targetCanvas: jsonb("target_canvas").$type<Size>().notNull(),
    margins: jsonb("margins").$type<ChannelMargins>().notNull(),
    anchor: text("anchor", { enum: ANCHORS }).notNull(),
    background: text("background").notNull(),
    firstImageBackground: text("first_image_background"),
    dpi: integer("dpi").notNull(),
    fixedCanvas: boolean("fixed_canvas").notNull(),
    uniformScaleDefault: boolean("uniform_scale_default").notNull(),
    sheetText: text("sheet_text").notNull(),
    notes: text("notes"),
    markets: jsonb("markets").$type<string[]>().notNull().default([]),
    languages: jsonb("languages").$type<string[]>().notNull().default([]),
    status: text("status", { enum: CHANNEL_STATUSES }).notNull(),
    pushMethod: text("push_method", { enum: PUSH_METHODS }),
    fileKind: text("file_kind"),
    owner: text("owner"),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.version] }),
    enumCheck("catalog_channel_records", "group", t.group, PRIORITY_GROUPS),
    enumCheck("catalog_channel_records", "anchor", t.anchor, ANCHORS),
    enumCheck("catalog_channel_records", "status", t.status, CHANNEL_STATUSES),
    enumCheck("catalog_channel_records", "push_method", t.pushMethod, PUSH_METHODS),
  ],
);

/** The image set policy per channel x taxonomy node (M3-F4, stored in M5), every version. */
export const catalogImagePolicies = pgTable(
  "catalog_image_policies",
  {
    channelId: text("channel_id").notNull(),
    nodeId: text("node_id")
      .notNull()
      .references(() => catalogTaxonomyNodes.id),
    version: integer("version").notNull(),
    rulesetVersion: integer("ruleset_version")
      .notNull()
      .references(() => catalogRulesets.version),
    roles: jsonb("roles").$type<string[]>().notNull(),
    addOns: jsonb("add_ons").$type<string[]>().notNull().default([]),
    minCount: integer("min_count"),
    maxCount: integer("max_count"),
    evidence: text("evidence", { enum: EVIDENCE_GRADES }).notNull(),
    source: text("source").notNull(),
    status: text("status", { enum: IMAGE_POLICY_STATUSES }).notNull(),
    reason: text("reason").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.nodeId, t.version] }),
    enumCheck("catalog_image_policies", "evidence", t.evidence, EVIDENCE_GRADES),
    enumCheck("catalog_image_policies", "status", t.status, IMAGE_POLICY_STATUSES),
  ],
);

/**
 * One result per rule checked for one M0 content version on one channel under one ruleset version (M5 3.4 need 2,
 * decision D3), so a later readout can say which rules a live listing passed. Writing the same check twice keeps the
 * first row.
 */
export const catalogRuleResults = pgTable(
  "catalog_rule_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contentVersionId: uuid("content_version_id")
      .notNull()
      .references(() => catalogContentVersions.id),
    rulesetVersion: integer("ruleset_version")
      .notNull()
      .references(() => catalogRulesets.version),
    channel: text("channel").notNull(),
    ruleId: text("rule_id").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    outcome: text("outcome", { enum: RULE_OUTCOMES }).notNull(),
    effectiveSeverity: text("effective_severity", { enum: RULE_SEVERITIES }).notNull(),
    measured: jsonExact("measured"),
    message: text("message").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("catalog_rule_results_version_rule_uq").on(t.contentVersionId, t.rulesetVersion, t.channel, t.ruleId),
    index("catalog_rule_results_ruleset_version_idx").on(t.rulesetVersion),
    enumCheck("catalog_rule_results", "outcome", t.outcome, RULE_OUTCOMES),
    enumCheck("catalog_rule_results", "effective_severity", t.effectiveSeverity, RULE_SEVERITIES),
  ],
);

export type RulesetRow = typeof catalogRulesets.$inferSelect;
export type RuleRow = typeof catalogRules.$inferSelect;
export type RuleConflictRow = typeof catalogRuleConflicts.$inferSelect;
export type RuleDecisionRow = typeof catalogRuleDecisions.$inferSelect;
export type ChannelRecordRow = typeof catalogChannelRecords.$inferSelect;
export type ImagePolicyRow = typeof catalogImagePolicies.$inferSelect;
export type RuleResultRow = typeof catalogRuleResults.$inferSelect;

// ---------------------------------------------------------------------------
// M10-S1a change-type library (migration 0019). Seeded by the migration with taxonomy v0 (learning/change-types.ts).
// ---------------------------------------------------------------------------

/**
 * The change types every M0 change event names (M10-F1-R1, M0-F3-R9). `component` uses M0's component list; `channels`
 * are where the change can be made; `cost_class` is what pays for it (M6 prices the classes). A type is retired, never
 * deleted or renamed, so old events keep resolving. `since_version` is the taxonomy version that added it (v0 = 1).
 */
export const catalogChangeTypes = pgTable(
  "catalog_change_types",
  {
    id: text("id").primaryKey(),
    orgId: orgId(),
    name: text("name").notNull(),
    component: text("component", { enum: COMPONENTS }).notNull(),
    action: text("action", { enum: CHANGE_ACTIONS }).notNull(),
    costClass: text("cost_class", { enum: COST_CLASSES }).notNull(),
    channels: jsonb("channels").$type<ChannelId[]>().notNull(),
    status: text("status", { enum: CHANGE_TYPE_STATUSES }).notNull().default("active"),
    sinceVersion: integer("since_version").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("catalog_change_types_id_check", sql`${t.id} ~ '^[a-z][a-z0-9_]*$'`),
    enumCheck("catalog_change_types", "component", t.component, COMPONENTS),
    enumCheck("catalog_change_types", "action", t.action, CHANGE_ACTIONS),
    enumCheck("catalog_change_types", "cost_class", t.costClass, COST_CLASSES),
    enumCheck("catalog_change_types", "status", t.status, CHANGE_TYPE_STATUSES),
  ],
);

export type ChangeTypeRow = typeof catalogChangeTypes.$inferSelect;
