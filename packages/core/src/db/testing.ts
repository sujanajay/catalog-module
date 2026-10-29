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
