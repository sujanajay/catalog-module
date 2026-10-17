import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as pgMigrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./client";

/**
 * Resolve the drizzle migrations folder: MIGRATIONS_DIR env, else packages/core/drizzle
 * (relative to this source file), else packages/core/drizzle or ./drizzle under the cwd
 * (covers a bundled worker where import.meta.url no longer points at the source tree).
 */
export function resolveMigrationsFolder(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MIGRATIONS_DIR) return path.resolve(env.MIGRATIONS_DIR);
  const candidates: string[] = [];
  try {
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle"));
  } catch {
    // import.meta.url unavailable (e.g. CJS bundle) - fall through to cwd-based candidates.
  }
  candidates.push(path.resolve(process.cwd(), "packages/core/drizzle"), path.resolve(process.cwd(), "drizzle"));
  const found = candidates.find((c) => existsSync(path.join(c, "meta", "_journal.json")));
  if (!found) throw new Error(`Migrations folder not found (tried ${candidates.join(", ")}); set MIGRATIONS_DIR`);
  return found;
}

/**
 * Apply pending migrations. Works for both node-postgres and PGlite databases: drizzle's
 * per-driver migrators are identical (`readMigrationFiles` + `db.dialect.migrate`), so the
 * node-postgres one is used for both.
 */
export async function runMigrations(db: Db, folder?: string): Promise<void> {
  const migrationsFolder = folder ?? resolveMigrationsFolder();
  await pgMigrate(db as unknown as NodePgDatabase<Record<string, unknown>>, { migrationsFolder });
}
