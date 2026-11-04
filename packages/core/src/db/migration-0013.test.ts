// Tier 2 (PGlite): 0013_graph_key_sync.sql applied over a database at 0012 where an admin already set one key mapping:
// the conflict table appears, the seed fills the other mappings without overwriting the admin's row, the migration
// passes the additive-only lint, and executing 0013's statements again changes nothing.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "./client";
import { lintMigration } from "./migration-lint";
import { resolveMigrationsFolder, runMigrations } from "./migrate";
import { createDbFromPglite } from "./testing";

const FILE = "0013_graph_key_sync";
let db: Db;
let client: PGlite;

async function rows<T>(q: ReturnType<typeof sql>): Promise<T[]> {
  return ((await db.execute(q)) as unknown as { rows: T[] }).rows;
}

beforeAll(async () => {
  const real = resolveMigrationsFolder();
  const before = await mkdtemp(path.join(tmpdir(), "catalog-pre0013-"));
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
  it("is additive under the migration lint", async () => {
    const text = await readFile(path.join(resolveMigrationsFolder(), `${FILE}.sql`), "utf8");
    expect(lintMigration(`${FILE}.sql`, text)).toEqual([]);
  });

  it("adds the conflict table and seeds the mappings, keeping an admin's row; a re-run changes nothing", async () => {
    await expect(rows(sql`select 1 from catalog_key_conflicts`)).rejects.toThrow();
    await db.execute(sql`insert into catalog_key_mappings (sku_column, channel, market, key_kind) values ('trendyol', 'trendyol', 'ae', 'barcode')`);

    await runMigrations(db, resolveMigrationsFolder());
    // Run 0013's own statements a second time (the journal would skip the file): nothing changes, nothing fails.
    const text = await readFile(path.join(resolveMigrationsFolder(), `${FILE}.sql`), "utf8");
    await db.transaction(async (tx) => {
      for (const statement of text.split("--> statement-breakpoint")) await tx.execute(sql.raw(statement));
    });

    const mappings = await rows<{ sku_column: string; market: string | null }>(sql`select sku_column, market from catalog_key_mappings order by sku_column`);
    expect(mappings).toHaveLength(14);
    expect(mappings.find((m) => m.sku_column === "trendyol")!.market).toBe("ae");
    expect(mappings.some((m) => m.sku_column === "voga_closet")).toBe(false);
    expect(await rows(sql`select count(*)::int as n from catalog_key_conflicts`)).toEqual([{ n: 0 }]);

    await db.execute(sql`insert into catalog_key_conflicts (channel, market, key_kind, key_value, candidates) values ('namshi', 'ae', 'zsku', 'Z1', '[]')`);
    await expect(db.execute(sql`insert into catalog_key_conflicts (channel, market, key_kind, key_value, candidates) values ('namshi', 'ae', 'zsku', 'Z1', '[]')`)).rejects.toThrow();
    await expect(db.execute(sql`insert into catalog_key_conflicts (channel, market, key_kind, key_value, candidates) values ('ebay', 'ae', 'zsku', 'Z2', '[]')`)).rejects.toThrow();
  });
});
