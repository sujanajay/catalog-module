// Tier 2 (PGlite): 0010_deploy_safe_cost_ledger.sql applied over a database at 0008 that holds a batch, an upload and
// ledger rows: the rows are kept, the new columns are null (ingest_failures 0), an insert as the previous release's code
// writes it still works, the wider value lists and rows of no batch are allowed, and a second run changes nothing.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { resolveMigrationsFolder, runMigrations } from "./migrate";
import { createDbFromPglite } from "./testing";

const FILE = "0010_deploy_safe_cost_ledger";
let db: Db;
let client: PGlite;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

beforeAll(async () => {
  const real = resolveMigrationsFolder();
  const before = await mkdtemp(path.join(tmpdir(), "catalog-pre0010-"));
  try {
    await mkdir(path.join(before, "meta"));
    const journal = JSON.parse(await readFile(path.join(real, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const target = journal.entries.find((e) => e.tag === FILE);
    if (!target) throw new Error(`${FILE} is not in the journal`);
    const earlier = journal.entries.filter((e) => e.idx < target.idx);
    for (const e of earlier) await copyFile(path.join(real, `${e.tag}.sql`), path.join(before, `${e.tag}.sql`));
    await writeFile(path.join(before, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: earlier }));
    ({ db, client } = createDbFromPglite());
    await runMigrations(db, before);
  } finally {
    await rm(before, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await client?.close();
});

describe(`${FILE}.sql`, () => {
  it("keeps the rows, adds nullable columns, widens the value lists and allows rows of no batch; a re-run changes nothing", async () => {
    const [batch] = await rows<{ id: string }>(sql`insert into catalog_batches (brand_slug, brand_name, name, created_by, status) values ('test_brand', 'Test Brand', 'b', 't', 'ingesting') returning id`);
    await db.execute(sql`insert into catalog_uploads (batch_id, kind, name, status) values (${batch!.id}, 'zip', 'a.zip', 'uploaded')`);
    await db.execute(sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine, ms, outcome) values (${batch!.id}, 'test_brand', 'matte', 'matte_call', 'gpu', 1200, 'failed')`);
    // Before: a job row of no batch and the new values are refused.
    await expect(db.execute(sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine) values (null, null, 'system', 'job', 'job')`)).rejects.toThrow();

    await runMigrations(db, resolveMigrationsFolder());

    expect(await rows(sql`select stage, kind, engine, ms, outcome, component, content_version_id, billable_ms from catalog_cost_events`)).toEqual([
      { stage: "matte", kind: "matte_call", engine: "gpu", ms: 1200, outcome: "failed", component: null, content_version_id: null, billable_ms: null },
    ]);
    expect(await rows(sql`select name, ingest_failures from catalog_uploads`)).toEqual([{ name: "a.zip", ingest_failures: 0 }]);

    // The previous release's code inserts without the new columns (it runs during the deploy overlap, M6-F2-R1).
    await db.execute(sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine, ms) values (${batch!.id}, 'test_brand', 'qa', 'llm_call', 'm', 10)`);
    await db.execute(sql`insert into catalog_uploads (batch_id, kind, name, status) values (${batch!.id}, 'zip', 'b.zip', 'uploaded')`);
    // The new code's rows: no batch, a job, the new outcomes.
    await db.execute(sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine, component, billable_ms) values (null, null, 'system', 'job', 'job', 'catalog-migrate', 5000)`);
    for (const outcome of ["timeout", "killed", "duplicate"]) {
      await db.execute(sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine, outcome) values (${batch!.id}, 'test_brand', 'upscale', 'upscale_call', 'cpu', ${outcome})`);
    }
    await db.execute(sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine) values (${batch!.id}, 'test_brand', 'ingest', 'wait', 'worker')`);
    // Values outside even the wider lists are still refused.
    await expect(db.execute(sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine) values (null, null, 'intake', 'job', 'job')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into catalog_cost_events (batch_id, brand_slug, stage, kind, engine, outcome) values (null, null, 'system', 'job', 'job', 'skipped')`)).rejects.toThrow();
    const count = async () => (await rows<{ n: number }>(sql`select count(*)::int as n from catalog_cost_events`))[0]!.n;
    expect(await count()).toBe(7);

    // The file again, as a re-run of the migrate job would (inside one transaction, as the migrator runs it).
    const file = await readFile(path.join(resolveMigrationsFolder(), `${FILE}.sql`), "utf8");
    await db.transaction(async (tx) => {
      for (const stmt of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(stmt));
    });
    expect(await count()).toBe(7);
    expect(await rows(sql`select conname from pg_constraint where conname like 'catalog_cost_events_%_check' order by conname`)).toEqual([
      { conname: "catalog_cost_events_channel_check" },
      { conname: "catalog_cost_events_kind_check" },
      { conname: "catalog_cost_events_outcome_check" },
      { conname: "catalog_cost_events_stage_check" },
    ]);
  });
});
