import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * In the esbuild bundle the migrations are copied next to the bundle (dist/drizzle). Point
 * MIGRATIONS_DIR there unless the operator set it explicitly.
 */
export function defaultMigrationsDir(env: NodeJS.ProcessEnv = process.env): void {
  if (env.MIGRATIONS_DIR) return;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "drizzle");
  if (existsSync(path.join(bundled, "meta", "_journal.json"))) env.MIGRATIONS_DIR = bundled;
}
