// Brand list for the wizard (spec 02, "Brands"). There is no add-brand form; a brand missing from
// the warehouse is added by the admin (see docs/solutions/manual-brand.md) and reconciled by the
// nightly master sync when the warehouse catches up.
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { brandMaster } from "../db/schema";
import { brandSlug } from "./naming";

export interface BrandOption { slug: string; name: string; line: "softline" | "hardline"; source: "warehouse" | "manual" }

const brandOptionColumns = { slug: brandMaster.slug, name: brandMaster.name, line: brandMaster.line, source: brandMaster.source };

/** Every brand, grouped by line (softline first), sorted by name. */
export async function listBrandOptions(db: Db): Promise<BrandOption[]> {
  return db
    .select(brandOptionColumns)
    .from(brandMaster)
    .orderBy(
      sql`CASE WHEN ${brandMaster.line} = 'softline' THEN 0 ELSE 1 END`,
      sql`lower(${brandMaster.name})`,
      asc(brandMaster.slug),
    );
}

/**
 * Adds a brand with `source = manual`. Idempotent on the slug: an existing brand (manual or from
 * the warehouse) is returned unchanged. `createdBy` is written to the log line only; brand_master
 * has no creator column.
 */
export async function addManualBrand(
  db: Db,
  input: { name: string; line: "softline" | "hardline"; createdBy: string },
): Promise<BrandOption> {
  const name = input.name.trim();
  const slug = brandSlug(name);
  if (!slug) throw new Error("Brand name is empty. Give the brand's name as it should appear in the list.");
  const inserted = await db
    .insert(brandMaster)
    .values({ name, slug, line: input.line, source: "manual" })
    .onConflictDoNothing({ target: brandMaster.slug })
    .returning({ id: brandMaster.id });
  if (inserted.length) {
    console.log(JSON.stringify({ severity: "INFO", message: "manual brand added", slug, createdBy: input.createdBy }));
  }
  const [row] = await db
    .select(brandOptionColumns)
    .from(brandMaster)
    .where(eq(brandMaster.slug, slug));
  if (!row) throw new Error(`Brand ${slug} could not be read back after insert.`);
  return row;
}
