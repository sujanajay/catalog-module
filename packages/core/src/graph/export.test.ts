// Tier 2 (PGlite), M0-S4: the daily graph export (docs/program/requirements/M0-catalog-graph.md F5) against an
// in-memory sink that behaves like BigQuery for what the export relies on: a load replaces a staging table, and one
// commit replaces every snapshot table, merges the new change events on seq and appends the run row, all or nothing.
// F5 acceptance 2 is "kill the job half way; the next run completes and no reader saw a partial table": the sink
// throws at a chosen step, the final tables keep the previous set, and the next run completes. The BigQuery sink is
// tested against a fake client: the empty-table path, the commit script (schema steps, one transaction, explicit
// column lists) and the JSON value forms BigQuery's load reads. No BigQuery dataset or table is touched.
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import {
  catalogBatches,
  catalogChangeEvents,
  catalogChannelListings,
  catalogContentVersions,
  catalogGraphExportRuns,
  catalogKeyConflicts,
  catalogListingKeys,
  catalogLiveIntervals,
  catalogOptions,
  catalogTreatmentAssignments,
} from "../db/schema";
import { createTestDb } from "../db/testing";
import {
  EXPORT_TABLES,
  commitScript,
  createBigQueryExportSink,
  runGraphExport,
  type BqClientLike,
  type ExportRunRecord,
  type ExportSink,
  type ExportTable,
  type Row,
} from "./export";
import { recordChange, recordVersion } from "./index";

type Step = "maxEventSeq" | "stage" | "commit";

/** In-memory stand-in for the catalog_os dataset. `failAt` throws on the n-th call of a step (1-based). */
class MemorySink implements ExportSink {
  staging = new Map<string, Row[]>();
  tables = new Map<string, Row[]>();
  runs: ExportRunRecord[] = [];
  calls: string[] = [];
  failAt: { step: Step; n: number } | null = null;
  private seen = new Map<Step, number>();

  private tick(step: Step, detail = "") {
    const n = (this.seen.get(step) ?? 0) + 1;
    this.seen.set(step, n);
    this.calls.push(detail ? `${step}:${detail}` : step);
    if (this.failAt && this.failAt.step === step && this.failAt.n === n) throw new Error(`killed at ${step} ${n}`);
  }

  async maxEventSeq() {
    this.tick("maxEventSeq");
    const events = this.tables.get("change_events");
    if (!events) return null;
    return events.reduce<bigint | null>((m, r) => (m === null || BigInt(r.seq as string) > m ? BigInt(r.seq as string) : m), null);
  }
  async stage(table: string, _columns: unknown, file: string, rows: number) {
    this.tick("stage", table);
    const text = await readFile(file, "utf8");
    const parsed = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
    expect(parsed).toHaveLength(rows);
    this.staging.set(table, parsed);
  }
  async commit(tables: readonly ExportTable[], run: ExportRunRecord) {
    this.tick("commit");
    // Built aside and swapped at the end: a commit either lands whole or not at all.
    const next = new Map(this.tables);
    for (const t of tables) {
      const staged = this.staging.get(t.name) ?? [];
      if (t.incremental) {
        const have = next.get(t.name) ?? [];
        const seqs = new Set(have.map((r) => r.seq));
        next.set(t.name, [...have, ...staged.filter((r) => !seqs.has(r.seq))]);
      } else next.set(t.name, [...staged]);
    }
    this.tables = next;
    this.runs.push(run);
  }
  resetCounters() {
    this.seen.clear();
    this.calls = [];
    this.failAt = null;
  }
}

let db: Db, close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
}, 60_000);
afterAll(async () => {
  await close();
});

let n = 0;
const ids = { option: "", listing: "", liveVersion: "", testVersion: "" };

async function seed() {
  for (const t of [catalogLiveIntervals, catalogChangeEvents, catalogTreatmentAssignments, catalogContentVersions, catalogListingKeys, catalogKeyConflicts, catalogChannelListings, catalogOptions, catalogGraphExportRuns, catalogBatches]) {
    await db.delete(t);
  }
  const [o] = await db.insert(catalogOptions).values({ brandSlug: "uspa", optionKey: "USPA-1 NAVY", keySource: "master", styleKey: "uspa:USPA-1", styleKeySource: "brand_style_code", styleKeyConfidence: 1 }).returning();
  const [o2] = await db.insert(catalogOptions).values({ brandSlug: "uspa", optionKey: "USPA-1 RED", keySource: "master" }).returning();
  const [l] = await db.insert(catalogChannelListings).values({ optionId: o!.id, channel: "namshi", market: "ae" }).returning();
  const [l2] = await db.insert(catalogChannelListings).values({ optionId: o2!.id, channel: "namshi", market: "ae" }).returning();
  const keys = ["Z1", "Z2", "Z3", "Z4", "Z5"];
  for (const [i, k] of keys.entries()) {
    await db.insert(catalogListingKeys).values({ listingId: i % 2 ? l2!.id : l!.id, opptraSku: `SKU${i}`, channel: "namshi", market: "ae", keyKind: "zsku", keyValue: k, source: "master" });
  }
  await db.insert(catalogKeyConflicts).values({ channel: "namshi", market: "ae", keyKind: "zsku", keyValue: "ZX", candidates: [{ listingId: l!.id, optionId: o!.id, opptraSku: "SKU0", source: "master" }, { listingId: l2!.id, optionId: o2!.id, opptraSku: "SKU1", source: "master" }] });
  const [live] = await db.insert(catalogBatches).values({ brandSlug: "uspa", brandName: "USPA", name: "live", isTest: false, createdBy: "t@opptra.com", channels: ["namshi"] }).returning();
  const [test] = await db.insert(catalogBatches).values({ brandSlug: "uspa", brandName: "USPA", name: "test", isTest: true, createdBy: "t@opptra.com", channels: ["namshi"] }).returning();
  const v = await recordVersion(db, { optionId: o!.id, scope: "namshi", component: "title", source: "operator", aiGenerated: false, producer: "M5", textValue: "Navy polo", batchId: live!.id, createdBy: "t@opptra.com" });
  const tv = await recordVersion(db, { optionId: o!.id, scope: "namshi", component: "title", source: "operator", aiGenerated: false, producer: "M5", textValue: "Test polo", batchId: test!.id, isTest: true, createdBy: "t@opptra.com" });
  await event(l!.id, v.versionId, live!.id);
  await event(l!.id, tv.versionId, test!.id);
  await db.insert(catalogLiveIntervals).values({ listingId: l!.id, slot: "title", versionId: v.versionId, validFrom: new Date("2026-11-01T00:00:00Z"), state: "assumed" });
  await db.insert(catalogLiveIntervals).values({ listingId: l2!.id, slot: "title", versionId: tv.versionId, validFrom: new Date("2026-11-01T00:00:00Z"), state: "assumed" });
  await db.insert(catalogTreatmentAssignments).values({ experimentId: "exp-1", listingId: l2!.id, arm: "control", doNotTouch: true });
  Object.assign(ids, { option: o!.id, listing: l!.id, liveVersion: v.versionId, testVersion: tv.versionId });
}

async function event(listingId: string, toVersionId: string, batchId: string | null) {
  return recordChange(db, {
    idempotencyKey: `e${++n}`,
    listingId,
    slot: "title",
    toVersionId,
    kind: "links_delivered",
    at: new Date("2026-11-02T00:00:00Z"),
    evidence: "tool_publish",
    actor: "worker",
    reasonKind: "new_content",
    changeTypeId: "title_rewrite",
    batchId,
  });
}

const PAGE = { pageSize: 2 };

describe("runGraphExport (M0-F5)", () => {
  let sink: MemorySink;
  beforeEach(async () => {
    await seed();
    sink = new MemorySink();
  });

  it("writes every F5-R1 table, the run row in Postgres and in catalog_os.export_runs, and leaves out test content", async () => {
    const result = await runGraphExport(db, sink, PAGE);
    expect([...sink.tables.keys()].sort()).toEqual(
      ["change_events", "content_versions", "key_conflicts", "listing_keys", "listings", "live_intervals", "options", "outcome_keys", "treatment_assignments"],
    );
    expect(EXPORT_TABLES.map((t) => t.name).sort()).toEqual([...sink.tables.keys()].sort());
    const rows = (t: string) => sink.tables.get(t)!;
    expect(rows("options")).toHaveLength(2);
    expect(rows("listings")).toHaveLength(2);
    expect(rows("listing_keys")).toHaveLength(5);
    expect(rows("outcome_keys")).toHaveLength(5);
    expect(rows("outcome_keys")[0]).toEqual(expect.objectContaining({ option_id: expect.any(String), channel: "namshi", market: "ae", key_kind: "zsku" }));
    expect(rows("key_conflicts")).toHaveLength(1);
    expect(JSON.parse(rows("key_conflicts")[0]!.candidates as string)).toHaveLength(2);
    // F5-R3: the test batch's version, its event and its live interval stay out.
    expect(rows("content_versions").map((r) => r.id)).toEqual([ids.liveVersion]);
    expect(rows("change_events")).toHaveLength(1);
    expect(rows("change_events")[0]!.to_version_id).toBe(ids.liveVersion);
    expect(rows("live_intervals").map((r) => r.version_id)).toEqual([ids.liveVersion]);
    expect(rows("treatment_assignments")).toEqual([expect.objectContaining({ experiment_id: "exp-1", do_not_touch: true })]);
    // Values are BigQuery-ready: timestamps as ISO text, seq as a decimal string, arrays as arrays.
    expect(rows("options").find((r) => r.id === ids.option)!.created_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(rows("change_events")[0]!.seq).toMatch(/^\d+$/);
    expect(rows("content_versions")[0]!.parent_version_ids).toEqual([]);
    // No binary or test flag column goes out (F5-R1: URLs and hashes only).
    for (const t of EXPORT_TABLES) for (const c of t.columns) expect(["is_test", "bytes"]).not.toContain(c.name);

    const [run] = await db.select().from(catalogGraphExportRuns);
    expect(run!.finishedAt).not.toBeNull();
    expect(run!.error).toBeNull();
    expect(run!.rowsPerTable).toMatchObject({ options: 2, listing_keys: 5, change_events: 1, content_versions: 1 });
    expect(run!.maxSeq).toBe(BigInt(rows("change_events")[0]!.seq as string));
    expect(sink.runs).toEqual([expect.objectContaining({ runId: run!.id, rowsPerTable: run!.rowsPerTable, maxSeq: run!.maxSeq })]);
    expect(result).toMatchObject({ runId: run!.id, rowsPerTable: run!.rowsPerTable });
    // Every table is staged, then one commit replaces the whole set.
    expect(sink.calls.filter((c) => c.startsWith("stage"))).toHaveLength(EXPORT_TABLES.length);
    expect(sink.calls.at(-1)).toBe("commit");
  });

  it("is idempotent: a second run leaves every table the same and adds no change event twice", async () => {
    await runGraphExport(db, sink, PAGE);
    const first = new Map([...sink.tables].map(([k, v]) => [k, JSON.stringify(v)]));
    sink.resetCounters();
    await runGraphExport(db, sink, PAGE);
    for (const [k, v] of first) expect(JSON.stringify(sink.tables.get(k)), k).toBe(v);
    expect(sink.staging.get("change_events")).toEqual([]);
    expect(await db.select().from(catalogGraphExportRuns)).toHaveLength(2);
  });

  it("exports change events incrementally by seq (F5-R2)", async () => {
    await runGraphExport(db, sink, PAGE);
    const added = await event(ids.listing, ids.liveVersion, null);
    sink.resetCounters();
    await runGraphExport(db, sink, PAGE);
    expect(sink.staging.get("change_events")!.map((r) => r.seq)).toEqual([String(added.seq)]);
    expect(sink.tables.get("change_events")).toHaveLength(2);
  });

  it("a run killed half way leaves the previous snapshot whole, records the error, and the next run completes (F5 test 2)", async () => {
    await runGraphExport(db, sink, PAGE);
    const before = new Map([...sink.tables].map(([k, v]) => [k, JSON.stringify(v)]));
    await db.insert(catalogOptions).values({ brandSlug: "uspa", optionKey: "USPA-2 WHITE", keySource: "master" });
    await event(ids.listing, ids.liveVersion, null);

    // Killed while staging: no final table changed.
    sink.resetCounters();
    sink.failAt = { step: "stage", n: 5 };
    await expect(runGraphExport(db, sink, PAGE)).rejects.toThrow("killed at stage 5");
    for (const [k, v] of before) expect(JSON.stringify(sink.tables.get(k)), k).toBe(v);
    const failed = (await db.select().from(catalogGraphExportRuns)).find((r) => r.error);
    expect(failed).toMatchObject({ finishedAt: null, error: expect.stringContaining("killed at stage 5") });

    // Killed at the commit: still the whole previous set, no table from tonight next to one from last night.
    sink.resetCounters();
    sink.failAt = { step: "commit", n: 1 };
    await expect(runGraphExport(db, sink, PAGE)).rejects.toThrow("killed at commit 1");
    for (const [k, v] of before) expect(JSON.stringify(sink.tables.get(k)), k).toBe(v);
    expect(sink.runs).toHaveLength(1);

    sink.resetCounters();
    await runGraphExport(db, sink, PAGE);
    expect(sink.tables.get("options")).toHaveLength(3);
    expect(sink.tables.get("change_events")).toHaveLength(2);
    const runs = await db.select().from(catalogGraphExportRuns);
    expect(runs.filter((r) => r.finishedAt && !r.error)).toHaveLength(2);
  });

  it("pages of one row and of 5,000 rows give the same tables (keyset paging on every table)", async () => {
    await runGraphExport(db, sink, { pageSize: 1 });
    const small = new Map([...sink.tables].map(([k, v]) => [k, JSON.stringify(v)]));
    const big = new MemorySink();
    await db.delete(catalogGraphExportRuns);
    await runGraphExport(db, big, { pageSize: 5000 });
    for (const [k, v] of small) expect(JSON.stringify(big.tables.get(k)), k).toBe(v);
  });

  it("refuses a page size outside 1 to 5,000", async () => {
    await expect(runGraphExport(db, sink, { pageSize: 0 })).rejects.toThrow(/page size/);
    await expect(runGraphExport(db, sink, { pageSize: 5001 })).rejects.toThrow(/page size/);
    expect(await db.select().from(catalogGraphExportRuns).where(eq(catalogGraphExportRuns.orgId, "opptra"))).toHaveLength(0);
  });
});

describe("createBigQueryExportSink", () => {
  function fakeClient(opts: { eventsTable?: boolean; maxSeq?: string | null } = {}) {
    const calls: { op: string; table?: string; meta?: Record<string, unknown>; query?: string; params?: unknown }[] = [];
    const table = (id: string) => ({
      load: async (_file: string, meta: Record<string, unknown>) => { calls.push({ op: "load", table: id, meta }); return [{}]; },
      exists: async () => [id === "change_events" ? Boolean(opts.eventsTable) : true] as [boolean],
    });
    const client: BqClientLike = {
      dataset: () => ({ table }),
      query: async (q) => { calls.push({ op: "query", query: q.query, params: q.params }); return [[{ m: opts.maxSeq ?? null }]]; },
    };
    return { client, calls };
  }
  const where = { projectId: "image-links-agent", dataset: "catalog_os", location: "asia-south1" };
  const ref = (t: string) => `\`image-links-agent.catalog_os.${t}\``;
  const table = (name: string) => EXPORT_TABLES.find((t) => t.name === name)!;

  it("stages rows with a load that replaces the staging table and carries the BigQuery schema", async () => {
    const { client, calls } = fakeClient();
    await createBigQueryExportSink(where, client).stage("options", table("options").columns, "/tmp/options.ndjson", 2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "load", table: "_staging_options", meta: { sourceFormat: "NEWLINE_DELIMITED_JSON", writeDisposition: "WRITE_TRUNCATE", createDisposition: "CREATE_IF_NEEDED" } });
    const fields = (calls[0]!.meta!.schema as { fields: { name: string; type: string; mode: string }[] }).fields;
    expect(fields.find((f) => f.name === "id")).toEqual({ name: "id", type: "STRING", mode: "NULLABLE" });
    expect(fields.find((f) => f.name === "style_key_confidence")).toMatchObject({ type: "FLOAT64" });
    expect(fields.find((f) => f.name === "created_at")).toMatchObject({ type: "TIMESTAMP" });
  });

  it("an empty table is never loaded: its staging table is created empty from the schema (review P2-2)", async () => {
    const { client, calls } = fakeClient();
    await createBigQueryExportSink(where, client).stage("content_versions", table("content_versions").columns, "/tmp/empty.ndjson", 0);
    expect(calls.map((c) => c.op)).toEqual(["query"]);
    expect(calls[0]!.query).toMatch(/^CREATE OR REPLACE TABLE `image-links-agent\.catalog_os\._staging_content_versions` \(`id` STRING, /);
    expect(calls[0]!.query).toContain("`position` INT64");
    expect(calls[0]!.query).toContain("`parent_version_ids` ARRAY<STRING>");
    expect(calls[0]!.query).toContain("`created_at` TIMESTAMP");
  });

  it("reads the event cursor from catalog_os.change_events, null before the table exists", async () => {
    expect(await createBigQueryExportSink(where, fakeClient({ eventsTable: false }).client).maxEventSeq()).toBeNull();
    expect(await createBigQueryExportSink(where, fakeClient({ eventsTable: true, maxSeq: "42" }).client).maxEventSeq()).toBe(42n);
    expect(await createBigQueryExportSink(where, fakeClient({ eventsTable: true, maxSeq: null }).client).maxEventSeq()).toBeNull();
  });

  it("commits in one query: schema steps first, then one transaction that swaps every table, merges events and adds the run row", async () => {
    const { client, calls } = fakeClient();
    await createBigQueryExportSink(where, client).commit(EXPORT_TABLES, { runId: "r1", startedAt: new Date("2026-11-04T02:30:00Z"), finishedAt: new Date("2026-11-04T02:41:00Z"), rowsPerTable: { options: 2 }, maxSeq: 7n });
    expect(calls).toHaveLength(1);
    const q = calls[0]!.query!;
    expect(calls[0]!.params).toEqual({ runId: "r1", startedAt: "2026-11-04T02:30:00.000Z", finishedAt: "2026-11-04T02:41:00.000Z", rowsPerTable: '{"options":2}', maxSeq: "7" });
    const begin = q.indexOf("BEGIN TRANSACTION;"), commit = q.indexOf("COMMIT TRANSACTION;");
    expect(begin).toBeGreaterThan(0);
    expect(commit).toBe(q.length - "COMMIT TRANSACTION;".length);
    // No DDL on permanent tables inside the transaction (BigQuery refuses it).
    expect(q.slice(begin)).not.toMatch(/CREATE TABLE|ALTER TABLE/);
    for (const t of EXPORT_TABLES) {
      const names = t.columns.map((c) => `\`${c.name}\``).join(", ");
      expect(q.slice(0, begin)).toContain(`CREATE TABLE IF NOT EXISTS ${ref(t.name)} (`);
      if (t.incremental) {
        expect(q.slice(begin)).toContain(`MERGE ${ref(t.name)} AS t USING ${ref(`_staging_${t.name}`)} AS s ON t.seq = s.seq\nWHEN NOT MATCHED THEN INSERT (${names}) VALUES (${names});`);
      } else {
        expect(q.slice(begin)).toContain(`TRUNCATE TABLE ${ref(t.name)};\nINSERT INTO ${ref(t.name)} (${names}) SELECT ${names} FROM ${ref(`_staging_${t.name}`)};`);
      }
    }
    expect(q.slice(0, begin)).toContain(`CREATE TABLE IF NOT EXISTS ${ref("export_runs")} (run_id STRING, started_at TIMESTAMP, finished_at TIMESTAMP, rows_per_table STRING, max_seq INT64);`);
    expect(q.slice(begin)).toContain(`INSERT INTO ${ref("export_runs")} (run_id, started_at, finished_at, rows_per_table, max_seq)`);
  });

  it("a column added to change_events reaches the existing table: every column is added if missing before the merge (review P2-4)", () => {
    const events = table("change_events");
    const grown: ExportTable = { ...events, columns: [...events.columns, { name: "new_field", type: "STRING", expr: "null" }] };
    const q = commitScript([grown], ref);
    expect(q).toContain(`ALTER TABLE ${ref("change_events")} ADD COLUMN IF NOT EXISTS \`seq\` INT64, `);
    expect(q).toContain("ADD COLUMN IF NOT EXISTS `new_field` STRING;");
    expect(q.indexOf("ADD COLUMN IF NOT EXISTS `new_field`")).toBeLessThan(q.indexOf("BEGIN TRANSACTION;"));
    expect(q).toMatch(/INSERT \(`seq`, .*`new_field`\) VALUES \(`seq`, .*`new_field`\);/);
  });
});

describe("exported values (the JSON forms BigQuery's load reads)", () => {
  beforeEach(seed);

  it("TIMESTAMP as ISO 8601 UTC with microseconds, INT64 as decimal text, FLOAT64 and BOOL as JSON numbers and booleans, arrays as arrays", async () => {
    const sink = new MemorySink();
    await runGraphExport(db, sink, PAGE);
    const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
    for (const t of EXPORT_TABLES) {
      for (const row of sink.tables.get(t.name)!) {
        for (const c of t.columns) {
          const v = row[c.name];
          if (v === null) continue;
          if (c.repeated) expect(Array.isArray(v), `${t.name}.${c.name}`).toBe(true);
          else if (c.type === "TIMESTAMP") expect(v, `${t.name}.${c.name}`).toMatch(TS);
          else if (c.type === "INT64") expect(String(v), `${t.name}.${c.name}`).toMatch(/^-?\d+$/);
          else if (c.type === "FLOAT64") expect(typeof v, `${t.name}.${c.name}`).toBe("number");
          else if (c.type === "BOOL") expect(typeof v, `${t.name}.${c.name}`).toBe("boolean");
          else expect(typeof v, `${t.name}.${c.name}`).toBe("string");
        }
      }
    }
    // The live interval's valid_from is exactly the stored instant.
    expect(sink.tables.get("live_intervals")![0]!.valid_from).toBe("2026-11-01T00:00:00.000000Z");
  });
});
