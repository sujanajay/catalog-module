import { getDb, type Db } from "@catalog/core/db/client";

let override: Db | undefined;

/** Lazily initialised DB handle (never touched at build time or module load). */
export function db(): Db {
  return override ?? getDb();
}

/** Tests only: route db() to another database (a PGlite test db); undefined goes back to the pool. */
export function setDbForTests(next: Db | undefined): void {
  override = next;
}

export type { Db };
