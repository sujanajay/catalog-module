import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Logger } from "drizzle-orm/logger";
import type { Db } from "./client";
import { runMigrations } from "./migrate";
import * as schema from "./schema";

/**
 * Test-only helpers. Kept out of client.ts so production bundles never pull in PGlite.
 */
export function createDbFromPglite(client: PGlite = new PGlite(), options: { logger?: Logger } = {}): { db: Db; client: PGlite } {
  const db = drizzle(client, { schema, ...(options.logger ? { logger: options.logger } : {}) }) as unknown as Db;
  return { db, client };
}

/** In-memory PGlite database with all migrations applied. Call `close()` when done. */
export async function createTestDb(): Promise<{ db: Db; client: PGlite; close: () => Promise<void> }> {
  const { db, client } = createDbFromPglite();
  await runMigrations(db);
  return { db, client, close: () => client.close() };
}

/**
 * Real Postgres for tests that set TEST_PG_URL (a throwaway server, never ila-pg): creates a fresh database on that
 * server, migrates it up to `migrationsFolder` (default: all), and drops it on `close()`. Undefined when TEST_PG_URL
 * is not set, so the caller falls back to PGlite.
 */
export const TEST_PG_URL = process.env.TEST_PG_URL;

export async function createRealTestDb(options: { migrationsFolder?: string | null } = {}): Promise<{ db: Db; pool: import("pg").Pool; close: () => Promise<void> }> {
  if (!TEST_PG_URL) throw new Error("createRealTestDb needs TEST_PG_URL");
  const { default: pg } = await import("pg");
  const { drizzle: pgDrizzle } = await import("drizzle-orm/node-postgres");
  const name = `catalog_test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: TEST_PG_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(TEST_PG_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  const db = pgDrizzle(pool, { schema }) as unknown as Db;
  if (options.migrationsFolder !== null) await runMigrations(db, options.migrationsFolder);
  return {
    db,
    pool,
    close: async () => {
      await pool.end();
      const drop = new pg.Client({ connectionString: TEST_PG_URL });
      await drop.connect();
      await drop.query(`drop database if exists ${name} with (force)`);
      await drop.end();
    },
  };
}
