// Tier 2 (PGlite): 0008_batch_indexes.sql applied over a database at 0007 that holds a batch with photos and chunks:
// the three indexes exist, the planner can use them for the reads they are for, the rows are untouched, and a second
// run of the file changes nothing.
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
  const upTo0007 = await mkdtemp(path.join(tmpdir(), "catalog-0007-"));
  try {
    await mkdir(path.join(upTo0007, "meta"));
    const journal = JSON.parse(await readFile(path.join(real, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const first8 = journal.entries.filter((e) => e.idx <= 7);
    for (const e of first8) await copyFile(path.join(real, `${e.tag}.sql`), path.join(upTo0007, `${e.tag}.sql`));
    await writeFile(path.join(upTo0007, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: first8 }));
    ({ db, client } = createDbFromPglite());
    await runMigrations(db, upTo0007);
  } finally {
    await rm(upTo0007, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await client?.close();
});

const indexes = async () =>
  (await rows<{ indexname: string; indexdef: string }>(sql`select indexname, indexdef from pg_indexes where indexname in ('catalog_source_images_batch_id_idx', 'catalog_source_images_sha256_idx', 'catalog_chunks_status_task_name_idx') order by indexname`));

describe("0008_batch_indexes.sql", () => {
  it("adds the batch_id and sha256 indexes on photos and the status, task_name index on chunks; rows are untouched; a second run changes nothing", async () => {
    expect(await indexes()).toEqual([]);
    const [batch] = await rows<{ id: string }>(sql`insert into catalog_batches (brand_slug, brand_name, name, created_by, status) values ('test_brand', 'Test Brand', 'b', 't', 'rendering') returning id`);
    const [product] = await rows<{ id: string }>(sql`insert into catalog_products (brand_slug, is_test, product_key, path_key, identifier) values ('test_brand', true, 'p', 'p', 'p') returning id`);
    await db.execute(sql`insert into catalog_source_images (product_id, batch_id, n, sha256, original_name, raw_uri, mime) values (${product!.id}, ${batch!.id}, 1, 'abc', 'p_1.jpg', 'gs://a/p_1.jpg', 'image/jpeg')`);
    await db.execute(sql`insert into catalog_chunks (batch_id, index, stage, product_ids, status, task_name) values (${batch!.id}, 0, 'matte', '[]'::jsonb, 'queued', 'enlarging')`);

    await runMigrations(db, resolveMigrationsFolder());
    expect((await indexes()).map((i) => [i.indexname, i.indexdef.replace(/^.* USING btree /, "")])).toEqual([
      ["catalog_chunks_status_task_name_idx", "(status, task_name)"],
      ["catalog_source_images_batch_id_idx", "(batch_id)"],
      ["catalog_source_images_sha256_idx", "(sha256)"],
    ]);
    expect(await rows(sql`select n, sha256 from catalog_source_images`)).toEqual([{ n: 1, sha256: "abc" }]);
    expect(await rows(sql`select status, task_name from catalog_chunks`)).toEqual([{ status: "queued", task_name: "enlarging" }]);

    // The planner can serve the reads with them (sequential scans off, so a tiny table still shows the choice).
    await db.execute(sql`set enable_seqscan = off`);
    const plan = async (q: ReturnType<typeof sql>) => (await rows<{ "QUERY PLAN": string }>(q)).map((r) => r["QUERY PLAN"]).join("\n");
    expect(await plan(sql`explain select * from catalog_source_images where batch_id = ${batch!.id}`)).toContain("catalog_source_images_batch_id_idx");
    expect(await plan(sql`explain select * from catalog_source_images where sha256 in ('abc', 'def')`)).toContain("catalog_source_images_sha256_idx");
    expect(await plan(sql`explain select * from catalog_chunks where task_name = 'enlarging' and status = 'queued'`)).toContain("catalog_chunks_status_task_name_idx");
    await db.execute(sql`set enable_seqscan = on`);

    // The file again, as a re-run of the migrate job would.
    const file = await readFile(path.join(resolveMigrationsFolder(), "0008_batch_indexes.sql"), "utf8");
    await db.transaction(async (tx) => {
      for (const stmt of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(stmt));
    });
    expect(await indexes()).toHaveLength(3);
  });
});
