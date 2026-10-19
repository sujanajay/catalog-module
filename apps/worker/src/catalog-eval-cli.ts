// Small, testable pieces of the bake-off CLI (catalog-eval.ts runs main() on import, so it is not
// importable from a test).
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { brandMaster, catalogBatches } from "@catalog/core/db/schema";
import { evalRoot } from "@catalog/core/catalog/eval/manifest";
import type * as storage from "@catalog/core/storage";

export type CliFlags = Record<string, string | true>;

/**
 * Words and flags. A flag takes the next token as its value unless that token is missing or is
 * itself a flag. "--name=value" is the same as "--name value": infra/catalog-eval.sh folds pairs
 * into that form because gcloud refuses a repeated value inside --args ("--sample 1 --seed 1").
 */
export function parseArgs(argv: readonly string[]): { words: string[]; flags: CliFlags } {
  const words: string[] = [], flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { words.push(a); continue; }
    const eq = a.indexOf("=");
    if (eq > 2) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = true;
    else { flags[a.slice(2)] = next; i++; }
  }
  return { words, flags };
}

/** `run` needs the brand in the brand master; check it before assemble writes anything. */
export async function assertBrandInMaster(db: Db, brand: string): Promise<void> {
  const [row] = await db.select({ slug: brandMaster.slug }).from(brandMaster).where(eq(brandMaster.slug, brand));
  if (!row) throw new Error(`Brand ${brand} is not in the brand master, so its eval batches could not run. Nothing was written. Add the brand to the brand master (or use its slug from there), then assemble again.`);
}

/**
 * Removes an eval set folder (catalog-test/eval/<set>/ in the private bucket), for example one left
 * behind when assemble succeeded but run could not start. Refuses while an eval batch of the set
 * still exists: clean those up first with `cleanup --batches`.
 */
export async function cleanupEvalSet(db: Db, deps: Pick<typeof storage, "deleteTestObjects" | "getBucketName" | "toGsUri">, set: string) {
  const prefix = `${evalRoot(set)}/`;
  const batches = await db.select({ id: catalogBatches.id }).from(catalogBatches)
    .where(and(eq(catalogBatches.isTest, true), sql`${catalogBatches.options}->>'evalSet' = ${set}`, sql`coalesce(${catalogBatches.options}->>'cleanedUp', 'false') <> 'true'`));
  if (batches.length) throw new Error(`The eval set ${set} still has eval batches (${batches.map(b => b.id).join(", ")}). Clean them up first with cleanup --batches.`);
  return { set, folder: deps.toGsUri(deps.getBucketName(), prefix), objects: await deps.deleteTestObjects(deps.toGsUri(deps.getBucketName(), prefix)) };
}
