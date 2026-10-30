// Tier 2 (PGlite), T33 (spec 18 lifecycle F33): 0006_enlargements.sql applied over a database at 0005 that holds a
// batch in flight with product events, as on the live database during rollout: 0000 to 0006 apply, the table, its
// columns, indexes and CHECKs exist, the events CHECK takes the two new kinds and still refuses an unknown one, and a
// second run of the file changes nothing.
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
  const upTo0005 = await mkdtemp(path.join(tmpdir(), "catalog-0005-"));
  try {
    await mkdir(path.join(upTo0005, "meta"));
    const journal = JSON.parse(await readFile(path.join(real, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
    const first6 = journal.entries.filter((e) => e.idx <= 5);
    for (const e of first6) await copyFile(path.join(real, `${e.tag}.sql`), path.join(upTo0005, `${e.tag}.sql`));
    await writeFile(path.join(upTo0005, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: first6 }));
    ({ db, client } = createDbFromPglite());
    await runMigrations(db, upTo0005);
  } finally {
    await rm(upTo0005, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await client?.close();
});

describe("0006_enlargements.sql (T33)", () => {
  it("adds catalog_enlargements with its indexes and CHECKs and the two event kinds; old rows are untouched; a second run changes nothing", async () => {
    const [batch] = await rows<{ id: string }>(sql`insert into catalog_batches (brand_slug, brand_name, name, created_by, status) values ('test_brand', 'Test Brand', 'b', 't', 'rendering') returning id`);
    const [product] = await rows<{ id: string }>(sql`insert into catalog_products (brand_slug, is_test, product_key, path_key, identifier) values ('test_brand', true, 'p', 'p', 'p') returning id`);
    const [photo] = await rows<{ id: string }>(sql`insert into catalog_source_images (product_id, batch_id, n, sha256, original_name, raw_uri, mime, matte_uri, x2_model) values (${product!.id}, ${batch!.id}, 1, 'abc', 'p_1.jpg', 'gs://a/p_1.jpg', 'image/jpeg', 'gs://a/m.png', 'swinir-x2+cpu') returning id`);
    await db.execute(sql`insert into catalog_product_events (product_id, batch_id, kind, actor) values (${product!.id}, ${batch!.id}, 'created', 't')`);

    await runMigrations(db, resolveMigrationsFolder());
    const journal = JSON.parse(await readFile(path.join(resolveMigrationsFolder(), "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
    expect(journal.entries.map((e) => e.tag)).toContain("0006_enlargements");
    const applied = await rows<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(applied[0]!.n).toBe(journal.entries.length);

    const columns = await rows<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'catalog_enlargements' order by ordinal_position`);
    const byName = new Map(columns.map((c) => [c.column_name, c]));
    for (const name of ["id", "batch_id", "product_id", "source_image_id", "upscaler", "factor", "scale", "out_w", "out_h", "route", "pixel_hash", "identity_hash", "status", "wanted", "attempts", "timeouts", "delays", "probe_timeouts", "identity_releases", "sends", "retries", "claimed_at", "claim_token", "tiles_done", "uri", "error", "error_kind", "created_at", "updated_at"]) expect(byName.has(name), name).toBe(true);
    expect(byName.get("status")!.column_default).toContain("queued");
    expect(byName.get("wanted")!.column_default).toBe("true");
    for (const counter of ["attempts", "timeouts", "delays", "probe_timeouts", "identity_releases", "sends", "retries", "tiles_done"]) expect([counter, byName.get(counter)!.is_nullable, byName.get(counter)!.column_default]).toEqual([counter, "NO", "0"]);
    expect(byName.get("scale")!.data_type).toBe("real");

    const indexes = (await rows<{ indexname: string }>(sql`select indexname from pg_indexes where tablename = 'catalog_enlargements' order by indexname`)).map((r) => r.indexname);
    expect(indexes).toEqual(expect.arrayContaining(["catalog_enlargements_batch_id_idx", "catalog_enlargements_source_image_id_idx", "catalog_enlargements_identity_uq"]));

    const insert = (status: string, route: string, hash: string) => db.execute(sql`insert into catalog_enlargements (batch_id, product_id, source_image_id, upscaler, factor, scale, out_w, out_h, route, pixel_hash, identity_hash, status) values (${batch!.id}, ${product!.id}, ${photo!.id}, 'swinir-x2+cpu@9f4a3f85', 2, 2, 200, 200, ${route}, 'p', ${hash}, ${status})`);
    await insert("queued", "direct", "h1");
    await expect(insert("in_flight", "direct", "h2")).rejects.toThrow();
    await expect(insert("queued", "region", "h3")).rejects.toThrow();
    // One row per (batch, photo, identity).
    await expect(insert("queued", "tiles", "h1")).rejects.toThrow();

    for (const kind of ["enlargement_retried", "plain_accepted"]) await db.execute(sql`insert into catalog_product_events (product_id, batch_id, kind, actor) values (${product!.id}, ${batch!.id}, ${kind}, 't')`);
    await expect(db.execute(sql`insert into catalog_product_events (product_id, batch_id, kind, actor) values (${product!.id}, ${batch!.id}, 'not_a_kind', 't')`)).rejects.toThrow();

    // The file again (re-runnable): nothing changes, rows and events stay.
    const file = await readFile(path.join(resolveMigrationsFolder(), "0006_enlargements.sql"), "utf8");
    await db.transaction(async (tx) => {
      for (const statement of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement));
    });
    const [count] = await rows<{ n: number }>(sql`select count(*)::int as n from catalog_enlargements`);
    expect(count!.n).toBe(1);
    const kinds = (await rows<{ kind: string }>(sql`select kind from catalog_product_events order by kind`)).map((r) => r.kind);
    expect(kinds).toEqual(["created", "enlargement_retried", "plain_accepted"]);
    const [old] = await rows<{ x2_model: string | null; matte_uri: string }>(sql`select x2_model, matte_uri from catalog_source_images`);
    expect(old).toMatchObject({ x2_model: "swinir-x2+cpu", matte_uri: "gs://a/m.png" });
  });
});
