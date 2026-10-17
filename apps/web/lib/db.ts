import { getDb, type Db } from "@catalog/core/db/client";

/** Lazily initialised DB handle (never touched at build time or module load). */
export function db(): Db {
  return getDb();
}

export type { Db };
