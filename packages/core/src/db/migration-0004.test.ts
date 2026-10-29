// Tier 2 (PGlite): 0004_chunk_leases.sql (spec 15 section 4) applied over a database at 0003 that holds
// chunks in flight, as on the live database during rollout.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { resolveMigrationsFolder, runMigrations } from "./migrate";
import { createDbFromPglite } from "./testing";

let db: Db;
let client: PGlite;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

beforeAll(async () => {
  const real = resolveMigrationsFolder();
  const upTo0003 = await mkdtemp(path.join(tmpdir(), "catalog-0003-"));
  try {
    await mkdir(path.join(upTo0003, "meta"));
    const journal = JSON.parse(await readFile(path.join(real, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const first4 = journal.entries.filter((e) => e.idx <= 3);
    for (const e of first4) await copyFile(path.join(real, `${e.tag}.sql`), path.join(upTo0003, `${e.tag}.sql`));
    await writeFile(path.join(upTo0003, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: first4 }));
    ({ db, client } = createDbFromPglite());
    await runMigrations(db, upTo0003);
  } finally {
    await rm(upTo0003, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await client?.close();
});

describe("0004_chunk_leases.sql", () => {
  it("keeps in-flight rows valid, backfills them as legacy, gives new rows the new defaults, and a second run changes nothing", async () => {
    const [batch] = await rows<{ id: string }>(sql`insert into catalog_batches (brand_slug, brand_name, name, created_by, status) values ('test_brand', 'Test Brand', 'b', 't', 'matting') returning id`);
    const id = batch!.id;
    await db.execute(sql`insert into catalog_chunks (batch_id, index, stage, product_ids, status, task_name, started_at, attempt) values (${id}, 0, 'matte', '[]', 'running', 'claim-1', '2026-10-27T07:00:00Z', 2)`);
    await db.execute(sql`insert into catalog_chunks (batch_id, index, stage, product_ids, status, created_at) values (${id}, 1, 'matte', '[]', 'queued', '2026-10-27T06:00:00Z')`);

    await runMigrations(db, resolveMigrationsFolder());
    const applied = await rows<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied[0]!.n).toBe(JSON.parse(await readFile(path.join(resolveMigrationsFolder(), "meta", "_journal.json"), "utf8")).entries.length);

    const old = await rows<{ status: string; task_name: string | null; attempt: number; step: number; step_known: boolean; lease_until: string | null; dispatched_at: string; stalls: number }>(sql`select * from catalog_chunks order by index`);
    expect(old.map((r) => [r.status, r.task_name, r.attempt, r.step, r.step_known, r.lease_until, new Date(r.dispatched_at).toISOString(), r.stalls])).toEqual([
      ["running", "claim-1", 2, 0, false, null, "2026-10-27T07:00:00.000Z", 0],
      ["queued", null, 1, 0, false, null, "2026-10-27T06:00:00.000Z", 0],
    ]);

    await db.execute(sql`insert into catalog_chunks (batch_id, index, stage, product_ids) values (${id}, 2, 'matte', '[]')`);
    const [fresh] = await rows<{ step: number; step_known: boolean; dispatched_at: string | null; progress_at: string | null }>(sql`select * from catalog_chunks where index = 2`);
    expect(fresh).toMatchObject({ step: 0, step_known: true, dispatched_at: null, progress_at: null });

    // Re-running the file (as a manual re-apply would) leaves the new row's values alone.
    const file = await readFile(path.join(resolveMigrationsFolder(), "0004_chunk_leases.sql"), "utf8");
    await db.transaction(async (tx) => {
      for (const statement of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement));
    });
    const [again] = await rows<{ step_known: boolean; dispatched_at: string | null }>(sql`select * from catalog_chunks where index = 2`);
    expect(again).toMatchObject({ step_known: true, dispatched_at: null });
  });
});
