// Cloud Run job entry (catalog-migrate): apply migrations, seed the first admin (spec 03) and the
// test brand test_brand with its manual SKUs (owner decision 2026-10-19), then exit.
import { closeDb, getDb } from "@catalog/core/db/client";
import { resolveMigrationsFolder, runMigrations } from "@catalog/core/db/migrate";
import { seedAdmin } from "@catalog/core/people";
import { seedTestBrand } from "@catalog/core/catalog/brands";
import { defaultMigrationsDir } from "./runtime";

async function main(): Promise<void> {
  defaultMigrationsDir();
  const folder = resolveMigrationsFolder();
  console.log(`migrate: applying migrations from ${folder}`);
  await runMigrations(getDb(), folder);
  console.log("migrate: migrations applied");
  const adminEmail = process.env.SEED_ADMIN_EMAIL?.trim() || "sujan@opptra.com";
  const inserted = await seedAdmin(getDb(), adminEmail);
  console.log(`migrate: admin ${adminEmail.toLowerCase()} ${inserted ? "seeded" : "already present (left unchanged)"}`);
  const test = await seedTestBrand(getDb());
  console.log(`migrate: test brand ${test.brand.slug} present (${test.brand.source}); ${test.skusAdded} manual SKUs added`);
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    const cause = err instanceof Error && err.cause instanceof Error ? ` (cause: ${err.cause.message})` : "";
    console.error(`migrate: failed: ${err instanceof Error ? err.message : String(err)}${cause}`);
    await closeDb().catch(() => undefined);
    process.exit(1);
  });
