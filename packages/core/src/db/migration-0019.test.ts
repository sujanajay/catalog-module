// Tier 2 (PGlite): 0019_change_types.sql applied over a database at the migration before it that already holds a
// change event with a change type no table defines: the event is kept (the foreign key is NOT VALID), the seed rows
// arrive, a new event with an unknown type is refused, and a second run of the file changes nothing (an admin's edit
// to a seeded row survives).
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { resolveMigrationsFolder, runMigrations } from "./migrate";
import { createDbFromPglite } from "./testing";

const FILE = "0019_change_types";
let db: Db;
let client: PGlite;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

beforeAll(async () => {
  const real = resolveMigrationsFolder();
  const before = await mkdtemp(path.join(tmpdir(), "catalog-pre0019-"));
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

async function seedVersion(label: string): Promise<{ listing: string; version: string }> {
  const [option] = await rows<{ id: string }>(sql`insert into catalog_options (brand_slug, option_key, key_source) values ('test_brand', ${label}, 'master') returning id`);
  const [listing] = await rows<{ id: string }>(sql`insert into catalog_channel_listings (option_id, channel, market) values (${option!.id}, 'noon', 'ae') returning id`);
  const [version] = await rows<{ id: string }>(sql`insert into catalog_content_versions (option_id, scope, component, source, ai_generated, producer, text_value, content_hash, created_by)
    values (${option!.id}, 'noon', 'title', 'brand', false, 'M8', ${label}, ${label}, 't') returning id`);
  return { listing: listing!.id, version: version!.id };
}

const insertEvent = (key: string, v: { listing: string; version: string }, type: string) =>
  db.execute(sql`insert into catalog_change_events (idempotency_key, listing_id, slot, to_version_id, kind, at, evidence, actor, reason_kind, change_type_id)
    values (${key}, ${v.listing}, 'title', ${v.version}, 'links_delivered', now(), 'tool_publish', 't', 'new_content', ${type})`);

describe(`${FILE}.sql`, () => {
  it("keeps old events, seeds the v0 types, refuses unknown types on new events; a re-run changes nothing", async () => {
    const old = await seedVersion("before");
    await insertEvent("old", old, "image.background");

    await runMigrations(db, resolveMigrationsFolder());

    expect(await rows(sql`select change_type_id from catalog_change_events where idempotency_key = 'old'`)).toEqual([{ change_type_id: "image.background" }]);
    expect(await rows(sql`select count(*)::int as n from catalog_change_types`)).toEqual([{ n: 15 }]);
    const next = await seedVersion("after");
    await expect(insertEvent("new-bad", next, "image.crops")).rejects.toThrow();
    await insertEvent("new-ok", next, "title_rewritten_en");

    // An admin's later edit to a seeded row is not undone by a re-run.
    await db.execute(sql`update catalog_change_types set name = 'English title rewritten (edited)' where id = 'title_rewritten_en'`);
    const file = await readFile(path.join(resolveMigrationsFolder(), `${FILE}.sql`), "utf8");
    await db.transaction(async (tx) => {
      for (const stmt of file.split("--> statement-breakpoint")) await tx.execute(sql.raw(stmt));
    });
    expect(await rows(sql`select count(*)::int as n from catalog_change_types`)).toEqual([{ n: 15 }]);
    expect(await rows(sql`select name from catalog_change_types where id = 'title_rewritten_en'`)).toEqual([{ name: "English title rewritten (edited)" }]);
    expect(await rows(sql`select conname from pg_constraint where conname = 'catalog_change_events_change_type_id_fk'`)).toHaveLength(1);
  }, 120_000);
});
