// Tier 2 (PGlite): 0010_taxonomy.sql applied over a database at the previous migration (0009) that holds a batch: the four taxonomy tables
// exist, the existing rows are untouched, a second run of the file changes nothing, and the seed then fills the store.
// The file number is taken at merge time (roadmap 3.2); the test finds the file by its tag, not its number.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedTaxonomy } from "../analyze/taxonomy-seed";
import type { Db } from "./client";
import { resolveMigrationsFolder, runMigrations } from "./migrate";
import { createDbFromPglite } from "./testing";

let db: Db;
let client: PGlite;
let taxonomyTag: string;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

const TABLES = ["catalog_attribute_defs", "catalog_shot_roles", "catalog_taxonomy_changes", "catalog_taxonomy_nodes"];
const tables = async () =>
  (await rows<{ table_name: string }>(sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like any (array['catalog_taxonomy_%', 'catalog_attribute_defs', 'catalog_shot_roles']) order by table_name`)).map((r) => r.table_name);

beforeAll(async () => {
  const real = resolveMigrationsFolder();
  const before = await mkdtemp(path.join(tmpdir(), "catalog-pre-taxonomy-"));
  try {
    await mkdir(path.join(before, "meta"));
    const journal = JSON.parse(await readFile(path.join(real, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const taxonomy = journal.entries.find((e) => e.tag.endsWith("_taxonomy"))!;
    taxonomyTag = taxonomy.tag;
    const earlier = journal.entries.filter((e) => e.idx < taxonomy.idx);
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

describe("taxonomy migration", () => {
  it("adds the four tables, leaves existing rows alone, re-runs harmlessly, and the seed fills the store", async () => {
    expect(await tables()).toEqual([]);
    await db.execute(sql`insert into catalog_batches (brand_slug, brand_name, name, created_by, status) values ('test_brand', 'Test Brand', 'b', 't', 'rendering')`);

    await runMigrations(db, resolveMigrationsFolder());
    expect(await tables()).toEqual(TABLES);
    expect(await rows(sql`select name, status from catalog_batches`)).toEqual([{ name: "b", status: "rendering" }]);

    const seeded = await seedTaxonomy(db);
    expect(seeded.nodesAdded).toBeGreaterThan(40);

    // The file again, as a re-run of the migrate job would: nothing fails and the seeded rows stay.
    const file = await readFile(path.join(resolveMigrationsFolder(), `${taxonomyTag}.sql`), "utf8");
    await db.transaction(async (tx) => {
      for (const stmt of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(stmt));
    });
    const [count] = await rows<{ n: number }>(sql`select count(*)::int as n from catalog_taxonomy_nodes`);
    expect(count!.n).toBe(seeded.nodesAdded);
  });
});
