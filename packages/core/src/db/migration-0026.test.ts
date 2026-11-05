// Tier 2 (PGlite): 0026_graph_role_events.sql applied over a database at the migration before it that already holds a
// version with role `unknown` and a change event on a listing: both are kept and the widened CHECKs validate over them;
// new versions take `main` and `additional`; an event with no listing needs a product and a channel; a second run of
// the file changes nothing (R1 exit item 5, M0 decisions D23 revised and D28).
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { resolveMigrationsFolder, runMigrations } from "./migrate";
import { createDbFromPglite } from "./testing";

const FILE = "0026_graph_role_events";
let db: Db;
let client: PGlite;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

beforeAll(async () => {
  const real = resolveMigrationsFolder();
  const before = await mkdtemp(path.join(tmpdir(), "catalog-pre0026-"));
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

async function seedVersion(label: string, role: string): Promise<{ listing: string; version: string }> {
  const [option] = await rows<{ id: string }>(sql`insert into catalog_options (brand_slug, option_key, key_source) values ('test_brand', ${label}, 'master') returning id`);
  const [listing] = await rows<{ id: string }>(sql`insert into catalog_channel_listings (option_id, channel, market) values (${option!.id}, 'noon', 'ae') returning id`);
  const [version] = await rows<{ id: string }>(sql`insert into catalog_content_versions (option_id, scope, component, role, position, source, ai_generated, producer, text_value, content_hash, created_by)
    values (${option!.id}, 'noon', 'title', ${role}, 1, 'brand', false, 'M8', ${label}, ${label}, 't') returning id`);
  return { listing: listing!.id, version: version!.id };
}

const insertEvent = (key: string, listing: string | null, version: string, extra: { productId?: string | null; channel?: string | null } = {}) =>
  db.execute(sql`insert into catalog_change_events (idempotency_key, listing_id, product_id, channel, slot, to_version_id, kind, at, evidence, actor, reason_kind, change_type_id)
    values (${key}, ${listing}, ${extra.productId ?? null}, ${extra.channel ?? null}, 'image:1', ${version}, 'links_delivered', now(), 'tool_publish', 't', 'new_content', 'img_background_fixed')`);
const insertOldEvent = (key: string, listing: string, version: string) =>
  db.execute(sql`insert into catalog_change_events (idempotency_key, listing_id, slot, to_version_id, kind, at, evidence, actor, reason_kind, change_type_id)
    values (${key}, ${listing}, 'image:1', ${version}, 'links_delivered', now(), 'tool_publish', 't', 'new_content', 'img_background_fixed')`);

describe(`${FILE}.sql`, () => {
  it("keeps old rows, takes the new roles and listing-less events with a product and channel; a re-run changes nothing", async () => {
    const old = await seedVersion("before", "unknown");
    await insertOldEvent("old", old.listing, old.version);
    await expect(seedVersion("main-too-early", "main")).rejects.toThrow();

    await runMigrations(db, resolveMigrationsFolder());

    expect(await rows(sql`select role from catalog_content_versions where id = ${old.version}`)).toEqual([{ role: "unknown" }]);
    expect(await rows(sql`select listing_id, product_id, channel from catalog_change_events where idempotency_key = 'old'`)).toEqual([{ listing_id: old.listing, product_id: null, channel: null }]);
    const main = await seedVersion("main", "main");
    await seedVersion("additional", "additional");
    await expect(seedVersion("bad-role", "hero")).rejects.toThrow();
    const productId = "00000000-0000-4000-8000-000000000026";
    await insertEvent("bare", null, main.version, { productId, channel: "amazon" });
    await expect(insertEvent("no-product", null, main.version, { channel: "amazon" })).rejects.toThrow();
    await expect(insertEvent("no-channel", null, main.version, { productId })).rejects.toThrow();
    await expect(insertEvent("bad-channel", null, main.version, { productId, channel: "ebay" })).rejects.toThrow();

    const file = await readFile(path.join(resolveMigrationsFolder(), `${FILE}.sql`), "utf8");
    await db.transaction(async (tx) => {
      for (const stmt of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(stmt));
    });
    expect(await rows(sql`select count(*)::int as n from catalog_change_events`)).toEqual([{ n: 2 }]);
    expect(await rows(sql`select conname from pg_constraint where conname in ('catalog_change_events_target_check', 'catalog_change_events_channel_check', 'catalog_content_versions_role_check') and convalidated order by conname`))
      .toEqual([{ conname: "catalog_change_events_channel_check" }, { conname: "catalog_change_events_target_check" }, { conname: "catalog_content_versions_role_check" }]);
    expect(await rows(sql`select indexname from pg_indexes where indexname = 'catalog_change_events_product_slot_idx'`)).toHaveLength(1);
  }, 120_000);
});
