import { getDb, type Db } from "@catalog/core/db/client";
import { registerOwnRevision } from "@catalog/core/catalog/reliability";

let override: Db | undefined;

/**
 * Lazily initialised DB handle (never touched at build time or module load). M6-F3-R1: the first use on Cloud Run also
 * registers this web revision once (deploy_overlap), in the background; a failure is logged once.
 */
export function db(): Db {
  if (override) return override;
  void registerOwnRevision(getDb, process.env, (error) => console.warn(JSON.stringify({ severity: "WARNING", message: "revision not registered", error: error instanceof Error ? error.message : String(error) })));
  return getDb();
}

/** Tests only: route db() to another database (a PGlite test db); undefined goes back to the pool. */
export function setDbForTests(next: Db | undefined): void {
  override = next;
}

export type { Db };
