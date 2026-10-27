// Tier 2 (PGlite): 0003_intake_states.sql (spec 14b section 4.1) applied over a database at 0002.
// It widens two CHECK constraints: upload status `removed` and batch status `cancelled`.
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
let batchId: string;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

const insertBatch = (status: string) =>
  db.execute(sql`insert into catalog_batches (brand_slug, brand_name, name, created_by, status) values ('test_brand', 'Test Brand', 'b', 't', ${status}) returning id`);
const insertUpload = (status: string) =>
  db.execute(sql`insert into catalog_uploads (batch_id, kind, name, status) values (${batchId}, 'image', 'a_1.jpg', ${status})`);

beforeAll(async () => {
  const real = resolveMigrationsFolder();
  const upTo0002 = await mkdtemp(path.join(tmpdir(), "catalog-0002-"));
  try {
    await mkdir(path.join(upTo0002, "meta"));
    const journal = JSON.parse(await readFile(path.join(real, "meta", "_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    const first3 = journal.entries.filter((e) => e.idx <= 2);
    for (const e of first3) await copyFile(path.join(real, `${e.tag}.sql`), path.join(upTo0002, `${e.tag}.sql`));
    await writeFile(path.join(upTo0002, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: first3 }));
    ({ db, client } = createDbFromPglite());
    await runMigrations(db, upTo0002);
  } finally {
    await rm(upTo0002, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await client?.close();
});

describe("0003_intake_states.sql", () => {
  it("refuses the new values at 0002, accepts them after 0003 and still refuses an unknown status", async () => {
    // At 0002 the old constraints hold.
    await insertBatch("draft");
    const created = await rows<{ id: string }>(sql`select id from catalog_batches limit 1`);
    batchId = created[0]!.id;
    await expect(insertBatch("cancelled")).rejects.toThrow();
    await expect(insertUpload("removed")).rejects.toThrow();

    await runMigrations(db, resolveMigrationsFolder());
    const applied = await rows<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied[0]!.n).toBeGreaterThanOrEqual(4);

    await insertBatch("cancelled");
    await insertUpload("removed");
    await insertUpload("uploaded");
    await expect(insertBatch("paused")).rejects.toThrow();
    await expect(insertUpload("deleted")).rejects.toThrow();
    const statuses = await rows<{ status: string }>(sql`select status from catalog_uploads order by status`);
    expect(statuses.map((s) => s.status)).toEqual(["removed", "uploaded"]);
  });
});
