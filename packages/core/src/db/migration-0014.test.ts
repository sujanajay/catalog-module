// Tier 2 (PGlite): 0014_settings_store.sql applied over a database at the migration before it that holds a batch and
// an output: the rows are kept with a null settings snapshot, the previous release's inserts still work, a snapshot
// and versions can be written, and a second run of the file changes nothing.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { resolveMigrationsFolder, runMigrations } from "./migrate";
import { createDbFromPglite } from "./testing";

const FILE = "0014_settings_store";
let db: Db;
let client: PGlite;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

beforeAll(async () => {
  const real = resolveMigrationsFolder();
  const before = await mkdtemp(path.join(tmpdir(), "catalog-pre0014-"));
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
}, 120_000);

afterAll(async () => {
  await client?.close();
});

async function seedOutput(name: string): Promise<{ batch: string }> {
  const [batch] = await rows<{ id: string }>(sql`insert into catalog_batches (brand_slug, brand_name, name, created_by, status) values ('test_brand', 'Test Brand', ${name}, 't', 'matting') returning id`);
  const [product] = await rows<{ id: string }>(sql`insert into catalog_products (brand_slug, product_key, path_key, identifier) values ('test_brand', ${name}, ${name}, ${name}) returning id`);
  const [source] = await rows<{ id: string }>(sql`insert into catalog_source_images (batch_id, product_id, n, sha256, original_name, raw_uri, mime) values (${batch!.id}, ${product!.id}, 1, ${name}, 'a.jpg', 'gs://a/b', 'image/jpeg') returning id`);
  await db.execute(sql`insert into catalog_outputs (batch_id, product_id, source_image_id, channel, n, canvas_w, canvas_h, scale, placed_x, placed_y, render_key, object_path, public_url)
    values (${batch!.id}, ${product!.id}, ${source!.id}, 'noon', 1, 0, 0, 0, 0, 0, 'k', ${`catalog-test/${name}`}, 'https://x')`);
  return { batch: batch!.id };
}

describe(`${FILE}.sql`, () => {
  it("keeps the rows, adds the store and nullable snapshot columns; a re-run changes nothing", async () => {
    const old = await seedOutput("before");
    await runMigrations(db, resolveMigrationsFolder());

    expect(await rows(sql`select settings_snapshot_id from catalog_batches where id = ${old.batch}`)).toEqual([{ settings_snapshot_id: null }]);
    expect(await rows(sql`select settings_snapshot_id from catalog_outputs where batch_id = ${old.batch}`)).toEqual([{ settings_snapshot_id: null }]);
    // The previous release's code inserts without the new columns (it runs during the deploy overlap, M6-F2-R1).
    await seedOutput("overlap");

    await db.execute(sql`insert into catalog_settings_snapshots (id, batch_id, data, created_by) values ('s1', ${old.batch}, '{"format":1}', 't')`);
    await db.execute(sql`update catalog_batches set settings_snapshot_id = 's1' where id = ${old.batch}`);
    await db.execute(sql`update catalog_outputs set settings_snapshot_id = 's1' where batch_id = ${old.batch}`);
    // A snapshot id that does not exist is refused.
    await expect(db.execute(sql`update catalog_outputs set settings_snapshot_id = 'nope' where batch_id = ${old.batch}`)).rejects.toThrow();
    await db.execute(sql`insert into catalog_setting_versions (key, version, value, schema_version, changed_by) values ('people.owners', 1, '["a@opptra.com"]', 1, 't')`);
    // One version number per setting and level; version 0 is refused.
    await expect(db.execute(sql`insert into catalog_setting_versions (key, version, value, schema_version, changed_by) values ('people.owners', 1, '[]', 1, 't')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into catalog_setting_versions (key, version, value, schema_version, changed_by) values ('x', 0, '1', 1, 't')`)).rejects.toThrow();
    const [org] = await rows<{ org_id: string }>(sql`select org_id from catalog_setting_versions`);
    expect(org!.org_id).toBe("opptra");

    // The file again, as a re-run of the migrate job would (inside one transaction, as the migrator runs it).
    const file = await readFile(path.join(resolveMigrationsFolder(), `${FILE}.sql`), "utf8");
    await db.transaction(async (tx) => {
      for (const stmt of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(stmt));
    });
    expect(await rows(sql`select count(*)::int as n from catalog_setting_versions`)).toEqual([{ n: 1 }]);
    expect(await rows(sql`select settings_snapshot_id from catalog_outputs where batch_id = ${old.batch}`)).toEqual([{ settings_snapshot_id: "s1" }]);
    // A deleted test batch leaves its snapshot (content versions may point at it), with no batch.
    await db.execute(sql`update catalog_batches set settings_snapshot_id = null where id = ${old.batch}`);
    await db.execute(sql`delete from catalog_outputs where batch_id = ${old.batch}`);
    await db.execute(sql`delete from catalog_source_images where batch_id = ${old.batch}`);
    await db.execute(sql`delete from catalog_batches where id = ${old.batch}`);
    expect(await rows(sql`select batch_id from catalog_settings_snapshots where id = 's1'`)).toEqual([{ batch_id: null }]);
  }, 120_000);
});
