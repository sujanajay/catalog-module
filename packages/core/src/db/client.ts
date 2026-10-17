import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema";

export type Schema = typeof schema;

/**
 * Driver-agnostic Drizzle database handle. Both the production node-postgres client and the
 * PGlite client used in tests (`@catalog/core/db/testing`) satisfy this type.
 */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export const DEFAULT_DB_POOL_MAX = 5;

/** Pool size from DB_POOL_MAX (default 5 locally; deploy sets 2 for the worker and 3 for the web). */
export function poolMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DB_POOL_MAX);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_DB_POOL_MAX;
}

export function poolConfigFromEnv(env: NodeJS.ProcessEnv = process.env): pg.PoolConfig {
  const max = poolMaxFromEnv(env);
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, max };
  const { DB_HOST, DB_NAME, DB_USER, DB_PASSWORD } = env;
  if (!DB_HOST || !DB_NAME || !DB_USER) {
    throw new Error("Database not configured: set DATABASE_URL or DB_HOST, DB_NAME, DB_USER, DB_PASSWORD");
  }
  return { host: DB_HOST, database: DB_NAME, user: DB_USER, password: DB_PASSWORD, port: 5432, max };
}

let pool: pg.Pool | undefined;
let db: Db | undefined;

/** Process-wide singleton (pg Pool + drizzle). */
export function getDb(): Db {
  if (!db) {
    pool = new pg.Pool(poolConfigFromEnv());
    db = drizzle(pool, { schema });
  }
  return db;
}

/** Close the singleton pool (graceful shutdown, one-shot scripts like the migrate job). */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  db = undefined;
  if (p) await p.end();
}

export { schema };
