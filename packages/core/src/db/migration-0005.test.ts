// Tier 2 (PGlite): 0005_enlargement.sql (spec 18 section 3.3.9) applied over a database at 0004 that holds photos
// in flight, as on the live database during rollout: 0000 to 0005 apply, the four columns exist with their
// defaults, older rows read as "no enlargement needed", and a second run changes nothing.
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
  const upTo0004 = await mkdtemp(path.join(tmpdir(), "catalog-0004-"));
  try {
    await mkdir(path.join(upTo0004, "meta"));
    const journal = JSON.parse(await readFile(path.join(real, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const first5 = journal.entries.filter((e) => e.idx <= 4);
    for (const e of first5) await copyFile(path.join(real, `${e.tag}.sql`), path.join(upTo0004, `${e.tag}.sql`));
    await writeFile(path.join(upTo0004, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: first5 }));
    ({ db, client } = createDbFromPglite());
    await runMigrations(db, upTo0004);
  } finally {
    await rm(upTo0004, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await client?.close();
});

describe("0005_enlargement.sql", () => {
  it("adds x2_uri, x2_model, x2_error and x2_attempts; old rows read as not needed; a second run changes nothing", async () => {
    const [batch] = await rows<{ id: string }>(sql`insert into catalog_batches (brand_slug, brand_name, name, created_by, status) values ('test_brand', 'Test Brand', 'b', 't', 'rendering') returning id`);
    const [product] = await rows<{ id: string }>(sql`insert into catalog_products (brand_slug, is_test, product_key, path_key, identifier) values ('test_brand', true, 'p', 'p', 'p') returning id`);
    await db.execute(sql`insert into catalog_source_images (product_id, batch_id, n, sha256, original_name, raw_uri, mime, matte_uri) values (${product!.id}, ${batch!.id}, 1, 'abc', 'p_1.jpg', 'gs://a/p_1.jpg', 'image/jpeg', 'gs://a/m.png')`);

    await runMigrations(db, resolveMigrationsFolder());
    const journal = JSON.parse(await readFile(path.join(resolveMigrationsFolder(), "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0005_enlargement");
    const applied = await rows<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied[0]!.n).toBe(journal.entries.length);

    const columns = await rows<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'catalog_source_images' and column_name like 'x2_%' order by column_name`);
    expect(columns.map((c) => [c.column_name, c.data_type, c.is_nullable, c.column_default])).toEqual([
      ["x2_attempts", "integer", "NO", "0"],
      ["x2_error", "text", "YES", null],
      ["x2_model", "text", "YES", null],
      ["x2_uri", "text", "YES", null],
    ]);
    const [old] = await rows<{ x2_uri: string | null; x2_model: string | null; x2_error: string | null; x2_attempts: number; matte_uri: string }>(sql`select * from catalog_source_images`);
    expect(old).toMatchObject({ x2_uri: null, x2_model: null, x2_error: null, x2_attempts: 0, matte_uri: "gs://a/m.png" });

    await db.execute(sql`update catalog_source_images set x2_model = 'swinir-x2+cpu', x2_attempts = 2`);
    const file = await readFile(path.join(resolveMigrationsFolder(), "0005_enlargement.sql"), "utf8");
    await db.transaction(async (tx) => {
      for (const statement of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement));
    });
    const [again] = await rows<{ x2_model: string | null; x2_attempts: number }>(sql`select * from catalog_source_images`);
    expect(again).toMatchObject({ x2_model: "swinir-x2+cpu", x2_attempts: 2 });
  });
});
