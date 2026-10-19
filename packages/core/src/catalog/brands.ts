// Brand list for the wizard (spec 02, "Brands"). There is no add-brand form; a brand missing from
// the warehouse is added by the admin (see docs/solutions/manual-brand.md) and reconciled by the
// nightly master sync when the warehouse catches up.
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { brandMaster, skuMap } from "../db/schema";
import { brandSlug, normalizeKey } from "./naming";

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

/**
 * The permanent dummy brand for testing (owner decision 2026-10-19). Every batch for it is a test
 * batch (`is_test = true`), so its objects only land under catalog-test/ and it never appears in
 * real brand reports.
 */
export const TEST_BRAND = { slug: "test_brand", name: "Test Brand", line: "softline" } as const;

/** Five made-up softline SKUs (one size each) so the SKU mapping screens have rows to show. */
export const TEST_BRAND_SKUS = [
  { opptraSku: "TB100001_Black_OD_M", optionIdStyleColor: "TB100001_Black", color: "Black", size: "M" },
  { opptraSku: "TB100002_White_OD_M", optionIdStyleColor: "TB100002_White", color: "White", size: "M" },
  { opptraSku: "TB100003_Navy_OD_L", optionIdStyleColor: "TB100003_Navy", color: "Navy", size: "L" },
  { opptraSku: "TB100004_Grey_OD_S", optionIdStyleColor: "TB100004_Grey", color: "Grey", size: "S" },
  { opptraSku: "TB100005_Red_OD_M", optionIdStyleColor: "TB100005_Red", color: "Red", size: "M" },
] as const;

/** Idempotent seed of the test brand and its manual sku_map rows; run by the catalog-migrate job. */
export async function seedTestBrand(db: Db): Promise<{ brand: BrandOption; skusAdded: number }> {
  const brand = await addManualBrand(db, { name: TEST_BRAND.name, line: TEST_BRAND.line, createdBy: "catalog-migrate" });
  const added = await db
    .insert(skuMap)
    .values(TEST_BRAND_SKUS.map((s) => ({
      ...s,
      brand: TEST_BRAND.name,
      brandSlug: TEST_BRAND.slug,
      line: TEST_BRAND.line,
      optionKey: normalizeKey(s.optionIdStyleColor),
      source: "manual" as const,
    })))
    .onConflictDoNothing({ target: skuMap.opptraSku })
    .returning({ opptraSku: skuMap.opptraSku });
  return { brand, skusAdded: added.length };
}
