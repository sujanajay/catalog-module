// M0-S4: the daily export of the catalog graph to BigQuery (docs/program/requirements/M0-catalog-graph.md F5, decision
// D21). Run by the Cloud Run job catalog-graph-export (apps/worker/src/catalog-graph-export.ts; infra/catalog-graph-export.sh).
//
// One run:
// 1. inserts its catalog_graph_export_runs row (F5-R4; the freshness check reads it);
// 2. reads the change-event cursor (the highest seq already in catalog_os.change_events) and the change log's safe
//    bound (changeLogBounds, the readChanges rule), so an event that commits late is exported by a later run, never
//    skipped;
// 3. reads every table in one read-only, repeatable-read transaction (one snapshot), in keyset pages of at most
//    5,000 rows, into one newline-delimited JSON file per table (F5-R5);
// 4. loads each file into a staging table (an empty table is created from its schema instead of loaded);
// 5. commits the whole set in ONE BigQuery multi-statement transaction: every snapshot table is emptied and refilled
//    from its staging table, the staged change events not exported yet are merged on seq (F5-R2), and the run's row
//    is appended to catalog_os.export_runs. Readers see last night's set or tonight's, never a mix of the two, and a
//    run killed at any step changes nothing in the final tables (review of M0-S4, P2-1);
// 6. marks its Postgres row finished.
// Before the transaction (DDL cannot run inside one) each final table is created when missing and given every column
// it lacks (ALTER TABLE ... ADD COLUMN IF NOT EXISTS), and every INSERT names its columns, so adding a column to
// EXPORT_TABLES needs no manual step; renaming or retyping one is not supported (additive only, as for migrations).
// Test content (is_test versions, their events and live intervals, events of test batches) is left out (F5-R3).
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogGraphExportRuns } from "../db/schema";
import { changeLogBounds, type GraphDb } from "./index";

/** F5-R5: rows per page. */
export const EXPORT_PAGE_SIZE = 5000;
/** BigQuery dataset location: the warehouse's, so cross-project joins work (F5-R1). */
export const EXPORT_LOCATION = "asia-south1";
export const DEFAULT_EXPORT_DATASET = "catalog_os";

export type BqType = "STRING" | "INT64" | "FLOAT64" | "BOOL" | "TIMESTAMP";
/** One exported column: its BigQuery name and type, and the SQL that reads it (over the table's FROM aliases). */
export interface ExportColumn { name: string; type: BqType; repeated?: boolean; expr: string }
/** A page key part: SQL over the FROM aliases and the Postgres type its text form is cast back to. */
interface PageKey { expr: string; cast: "uuid" | "bigint" }
export interface ExportTable {
  name: string;
  /** FROM clause with joins (static SQL). */
  from: string;
  /** Static filter (test content), ANDed with the page condition. */
  where?: string;
  /** Unique, non-null, in index order; the keyset of the pages. */
  key: PageKey[];
  columns: ExportColumn[];
  /** Change events: only seq above the exported cursor and up to the safe bound; merged, not replaced. */
  incremental?: true;
}

const s = (name: string, expr = name): ExportColumn => ({ name, type: "STRING", expr });
const id = (name: string, alias: string): ExportColumn => ({ name, type: "STRING", expr: `${alias}.${name}::text` });
// ISO 8601 in UTC with microseconds, the text form BigQuery's JSON load reads for TIMESTAMP.
const ts = (name: string, alias: string): ExportColumn => ({
  name,
  type: "TIMESTAMP",
  expr: `to_char(${alias}.${name} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
});
const col = (alias: string, ...names: string[]) => names.map((n) => s(n, `${alias}.${n}`));

/** The F5-R1 tables, in export order. Column names match Postgres, so a join reads the same in both places. */
export const EXPORT_TABLES: readonly ExportTable[] = [
  {
    name: "options",
    from: "catalog_options o",
    key: [{ expr: "o.id", cast: "uuid" }],
    columns: [
      id("id", "o"), ...col("o", "org_id", "brand_slug", "option_key", "key_source", "line", "product_type", "department", "audience"),
      { name: "in_master", type: "BOOL", expr: "o.in_master" },
      ...col("o", "style_key", "style_key_source"),
      { name: "style_key_confidence", type: "FLOAT64", expr: "o.style_key_confidence" },
      ts("created_at", "o"), ts("updated_at", "o"),
    ],
  },
  {
    name: "listings",
    from: "catalog_channel_listings l",
    key: [{ expr: "l.id", cast: "uuid" }],
    columns: [
      id("id", "l"), s("org_id", "l.org_id"), id("option_id", "l"), ...col("l", "channel", "market", "status"),
      ts("first_seen_live_at", "l"), ts("last_verified_at", "l"), ts("created_at", "l"), ts("updated_at", "l"),
    ],
  },
  {
    name: "listing_keys",
    from: "catalog_listing_keys k",
    key: [{ expr: "k.id", cast: "uuid" }],
    columns: [
      id("id", "k"), s("org_id", "k.org_id"), id("listing_id", "k"),
      ...col("k", "opptra_sku", "channel", "market", "key_kind", "key_value", "source"), ts("first_seen_at", "k"),
    ],
  },
  {
    name: "key_conflicts",
    from: "catalog_key_conflicts c",
    key: [{ expr: "c.id", cast: "uuid" }],
    columns: [
      id("id", "c"), ...col("c", "org_id", "channel", "market", "key_kind", "key_value"),
      // Every candidate listing as JSON text: [{listingId, optionId, opptraSku, source}].
      s("candidates", "c.candidates::text"),
      ts("first_seen_at", "c"), ts("last_seen_at", "c"), ts("resolved_at", "c"),
    ],
  },
  {
    name: "content_versions",
    from: "catalog_content_versions v",
    where: "NOT v.is_test",
    key: [{ expr: "v.id", cast: "uuid" }],
    columns: [
      id("id", "v"), s("org_id", "v.org_id"), id("option_id", "v"), ...col("v", "scope", "component", "role"),
      { name: "position", type: "INT64", expr: "v.position" },
      s("source", "v.source"), { name: "ai_generated", type: "BOOL", expr: "v.ai_generated" },
      ...col("v", "producer", "producer_ref", "asset_sha256", "text_value"), s("json_value", "v.json_value::text"),
      ...col("v", "content_hash", "hash_kind"),
      { name: "parent_version_ids", type: "STRING", repeated: true, expr: "v.parent_version_ids::text[]" },
      ...col("v", "public_url", "language", "market", "route_id", "prompt_version", "settings_snapshot_id"),
      id("batch_id", "v"), s("created_by", "v.created_by"), ts("created_at", "v"),
    ],
  },
  {
    name: "change_events",
    incremental: true,
    from: `catalog_change_events e
      LEFT JOIN catalog_batches b ON b.id = e.batch_id
      LEFT JOIN catalog_content_versions fv ON fv.id = e.from_version_id
      LEFT JOIN catalog_content_versions tv ON tv.id = e.to_version_id`,
    where: "NOT coalesce(b.is_test, false) AND NOT coalesce(fv.is_test, false) AND NOT coalesce(tv.is_test, false)",
    key: [{ expr: "e.seq", cast: "bigint" }],
    columns: [
      { name: "seq", type: "INT64", expr: "e.seq::text" },
      // listing_id is null for a product with no listing yet; product_id and channel say where (D23).
      ...col("e", "org_id", "idempotency_key"), id("listing_id", "e"), id("product_id", "e"), s("channel", "e.channel"), s("slot", "e.slot"),
      id("from_version_id", "e"), id("to_version_id", "e"), s("kind", "e.kind"), ts("at", "e"), ts("recorded_at", "e"),
      ...col("e", "evidence", "evidence_ref", "actor", "reason_kind", "reason_ref", "change_type_id"),
      id("change_set_id", "e"), id("batch_id", "e"), s("experiment_id", "e.experiment_id"),
    ],
  },
  {
    name: "live_intervals",
    from: "catalog_live_intervals i LEFT JOIN catalog_content_versions v ON v.id = i.version_id",
    where: "NOT coalesce(v.is_test, false)",
    key: [{ expr: "i.id", cast: "uuid" }],
    columns: [
      id("id", "i"), s("org_id", "i.org_id"), id("listing_id", "i"), s("slot", "i.slot"), id("version_id", "i"),
      ts("valid_from", "i"), ts("valid_to", "i"), s("state", "i.state"), ts("updated_at", "i"),
    ],
  },
  {
    name: "treatment_assignments",
    from: "catalog_treatment_assignments a",
    key: [{ expr: "a.id", cast: "uuid" }],
    columns: [
      id("id", "a"), ...col("a", "org_id", "experiment_id"), id("listing_id", "a"), ...col("a", "arm", "pair_id"),
      ts("assigned_at", "a"), ts("frozen_at", "a"), { name: "do_not_touch", type: "BOOL", expr: "a.do_not_touch" },
      ts("released_at", "a"),
    ],
  },
  {
    // The rows of the catalog_outcome_keys view, read from its two tables so the pages follow the keys' primary key.
    name: "outcome_keys",
    from: "catalog_listing_keys k JOIN catalog_channel_listings l ON l.id = k.listing_id",
    key: [{ expr: "k.id", cast: "uuid" }],
    columns: [
      id("listing_id", "k"), s("option_id", "l.option_id::text"), s("channel", "l.channel"), s("market", "l.market"),
      ...col("k", "key_kind", "key_value", "opptra_sku", "org_id"),
    ],
  },
];

export type Row = Record<string, unknown>;
export interface ExportRunRecord {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  rowsPerTable: Record<string, number>;
  maxSeq: bigint | null;
}

/** Where the export writes (catalog_os in BigQuery; an in-memory stand-in in tests). */
export interface ExportSink {
  /** The highest seq already exported to change_events; null before that table exists. */
  maxEventSeq(): Promise<bigint | null>;
  /** Replaces the table's staging copy with the `rows` rows of `file` (newline-delimited JSON; empty when rows is 0). */
  stage(table: string, columns: readonly ExportColumn[], file: string, rows: number): Promise<void>;
  /**
   * In one transaction: replaces every snapshot table with its staging copy, adds the staged change events whose seq
   * is not exported yet, and appends the run's row to export_runs. All or nothing.
   */
  commit(tables: readonly ExportTable[], run: ExportRunRecord): Promise<void>;
}

export interface ExportResult { runId: string; rowsPerTable: Record<string, number>; maxSeq: bigint | null }
export interface ExportOptions { pageSize?: number; tmpDir?: string }

type ExecRows = { rows: Row[] };

/** A Postgres value as BigQuery's JSON load reads it: timestamps as ISO text, bigints as decimal text. */
function jsonValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonValue);
  return v;
}

/** Writes one table's rows to `file`, page by page in key order; returns the row count and the last key seen. */
async function dumpTable(tx: GraphDb, table: ExportTable, file: string, pageSize: number, events: { after: bigint; upTo: bigint } | null): Promise<{ rows: number; last: string[] | null }> {
  const select = [...table.columns.map((c) => `${c.expr} AS "${c.name}"`), ...table.key.map((k, i) => `${k.expr}::text AS "__k${i}"`)].join(", ");
  const keyTuple = `(${table.key.map((k) => k.expr).join(", ")})`;
  const orderBy = table.key.map((k) => k.expr).join(", ");
  const handle = await open(file, "w");
  let rows = 0;
  let last: string[] | null = null;
  try {
    for (;;) {
      const after = last;
      const page = after
        ? sql`AND ${sql.raw(keyTuple)} > (${sql.join(table.key.map((k, i) => sql`${after[i]!}::${sql.raw(k.cast)}`), sql`, `)})`
        : sql``;
      const where = events
        ? sql`(${sql.raw(table.where ?? "true")}) AND ${sql.raw(table.key[0]!.expr)} > ${events.after.toString()}::bigint AND ${sql.raw(table.key[0]!.expr)} <= ${events.upTo.toString()}::bigint`
        : sql`(${sql.raw(table.where ?? "true")})`;
      const result = (await tx.execute(
        sql`SELECT ${sql.raw(select)} FROM ${sql.raw(table.from)} WHERE ${where} ${page} ORDER BY ${sql.raw(orderBy)} LIMIT ${pageSize}`,
      )) as unknown as ExecRows;
      if (!result.rows.length) break;
      let text = "";
      for (const r of result.rows) {
        const out: Row = {};
        for (const c of table.columns) out[c.name] = jsonValue(r[c.name]);
        text += `${JSON.stringify(out)}\n`;
      }
      await handle.write(text);
      rows += result.rows.length;
      const tail = result.rows[result.rows.length - 1]!;
      last = table.key.map((_k, i) => String(tail[`__k${i}`]));
      if (result.rows.length < pageSize) break;
    }
  } finally {
    await handle.close();
  }
  return { rows, last };
}

/** One export run (see the file header). Throws after recording the error on the run's row. */
export async function runGraphExport(db: Db, sink: ExportSink, options: ExportOptions = {}): Promise<ExportResult> {
  const pageSize = options.pageSize ?? EXPORT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > EXPORT_PAGE_SIZE) throw new Error(`runGraphExport: page size must be an integer from 1 to ${EXPORT_PAGE_SIZE}`);
  const [run] = await db.insert(catalogGraphExportRuns).values({}).returning();
  const runId = run!.id;
  const dir = await mkdtemp(path.join(options.tmpDir ?? tmpdir(), "catalog-graph-export-"));
  try {
    const cursor = (await sink.maxEventSeq()) ?? 0n;
    // Read before the snapshot: every event up to here is committed or rolled back by the time the snapshot starts.
    const { cap, floor } = await changeLogBounds(db);
    const upTo = floor != null && floor - 1n < cap ? floor - 1n : cap;
    const rowsPerTable: Record<string, number> = {};
    let maxSeq: bigint | null = cursor > 0n ? cursor : null;
    const files = new Map<string, string>();
    await db.transaction(
      async (tx) => {
        for (const table of EXPORT_TABLES) {
          const file = path.join(dir, `${table.name}.ndjson`);
          const { rows, last } = await dumpTable(tx, table, file, pageSize, table.incremental ? { after: cursor, upTo } : null);
          rowsPerTable[table.name] = rows;
          files.set(table.name, file);
          if (table.incremental && last) maxSeq = BigInt(last[0]!);
        }
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    for (const table of EXPORT_TABLES) await sink.stage(table.name, table.columns, files.get(table.name)!, rowsPerTable[table.name]!);
    const finishedAt = new Date();
    await sink.commit(EXPORT_TABLES, { runId, startedAt: run!.startedAt, finishedAt, rowsPerTable, maxSeq });
    await db.update(catalogGraphExportRuns).set({ finishedAt, rowsPerTable, maxSeq }).where(eq(catalogGraphExportRuns.id, runId));
    return { runId, rowsPerTable, maxSeq };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(catalogGraphExportRuns).set({ error: message.slice(0, 2000) }).where(eq(catalogGraphExportRuns.id, runId));
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// BigQuery sink
// ---------------------------------------------------------------------------

/** The part of @google-cloud/bigquery the sink uses (a fake in tests). */
export interface BqTableLike {
  load(file: string, metadata: Record<string, unknown>): Promise<unknown>;
  exists(): Promise<[boolean]>;
}
export interface BqClientLike {
  dataset(id: string, options?: { location?: string }): { table(id: string): BqTableLike };
  query(options: { query: string; location?: string; params?: Record<string, string> }): Promise<[Row[], ...unknown[]]>;
}

export interface ExportTarget { projectId: string; dataset: string; location: string }

const STAGING = (table: string) => `_staging_${table}`;
/** A column's type in BigQuery DDL. */
const ddlType = (c: ExportColumn) => (c.repeated ? `ARRAY<${c.type}>` : c.type);
const EXPORT_RUNS_COLUMNS = "run_id STRING, started_at TIMESTAMP, finished_at TIMESTAMP, rows_per_table STRING, max_seq INT64";

/**
 * The commit script (see the file header): schema steps first, then one transaction. `ref` names a table in the
 * dataset. Exported for its tests.
 */
export function commitScript(tables: readonly ExportTable[], ref: (table: string) => string): string {
  const out: string[] = [];
  for (const t of tables) {
    out.push(`CREATE TABLE IF NOT EXISTS ${ref(t.name)} (${t.columns.map((c) => `\`${c.name}\` ${ddlType(c)}`).join(", ")});`);
    out.push(`ALTER TABLE ${ref(t.name)} ${t.columns.map((c) => `ADD COLUMN IF NOT EXISTS \`${c.name}\` ${ddlType(c)}`).join(", ")};`);
  }
  out.push(`CREATE TABLE IF NOT EXISTS ${ref("export_runs")} (${EXPORT_RUNS_COLUMNS});`);
  out.push("BEGIN TRANSACTION;");
  for (const t of tables) {
    const names = t.columns.map((c) => `\`${c.name}\``).join(", ");
    if (t.incremental) {
      out.push(
        `MERGE ${ref(t.name)} AS t USING ${ref(STAGING(t.name))} AS s ON t.seq = s.seq`,
        `WHEN NOT MATCHED THEN INSERT (${names}) VALUES (${names});`,
      );
    } else {
      out.push(`TRUNCATE TABLE ${ref(t.name)};`, `INSERT INTO ${ref(t.name)} (${names}) SELECT ${names} FROM ${ref(STAGING(t.name))};`);
    }
  }
  out.push(
    `INSERT INTO ${ref("export_runs")} (run_id, started_at, finished_at, rows_per_table, max_seq)`,
    `VALUES (@runId, TIMESTAMP(@startedAt), TIMESTAMP(@finishedAt), @rowsPerTable, SAFE_CAST(NULLIF(@maxSeq, '') AS INT64));`,
    "COMMIT TRANSACTION;",
  );
  return out.join("\n");
}

/** catalog_os in BigQuery. Builds a client for `target.projectId` with ADC unless one is given. */
export function createBigQueryExportSink(target: ExportTarget, client?: BqClientLike): ExportSink {
  const { projectId, dataset, location } = target;
  const ref = (table: string) => `\`${projectId}.${dataset}.${table}\``;
  let bq: Promise<BqClientLike> | undefined = client ? Promise.resolve(client) : undefined;
  const get = () =>
    (bq ??= import("@google-cloud/bigquery").then(({ BigQuery }) => new BigQuery({ projectId }) as unknown as BqClientLike));
  const ds = async () => (await get()).dataset(dataset, { location });
  return {
    async maxEventSeq() {
      const [exists] = await (await ds()).table("change_events").exists();
      if (!exists) return null;
      const [rows] = await (await get()).query({ query: `SELECT CAST(MAX(seq) AS STRING) AS m FROM ${ref("change_events")}`, location });
      const m = rows[0]?.m;
      return m == null ? null : BigInt(String(m));
    },
    async stage(table, columns, file, rows) {
      if (rows === 0) {
        // No load of an empty file: the staging table is made empty from its schema (review of M0-S4, P2-2).
        const cols = columns.map((c) => `\`${c.name}\` ${ddlType(c)}`).join(", ");
        await (await get()).query({ query: `CREATE OR REPLACE TABLE ${ref(STAGING(table))} (${cols});`, location });
        return;
      }
      const fields = columns.map((c) => ({ name: c.name, type: c.type, mode: c.repeated ? "REPEATED" : "NULLABLE" }));
      await (await ds()).table(STAGING(table)).load(file, {
        sourceFormat: "NEWLINE_DELIMITED_JSON",
        schema: { fields },
        writeDisposition: "WRITE_TRUNCATE",
        createDisposition: "CREATE_IF_NEEDED",
      });
    },
    async commit(tables, run) {
      await (await get()).query({
        query: commitScript(tables, ref),
        location,
        params: {
          runId: run.runId,
          startedAt: run.startedAt.toISOString(),
          finishedAt: run.finishedAt.toISOString(),
          rowsPerTable: JSON.stringify(run.rowsPerTable),
          maxSeq: run.maxSeq == null ? "" : run.maxSeq.toString(),
        },
      });
    },
  };
}
