// Cloud Run job entry (catalog-migrate): apply migrations, then exit. 03 adds the SEED_ADMIN_EMAIL seed here.
import { closeDb, getDb } from "@catalog/core/db/client";
import { resolveMigrationsFolder, runMigrations } from "@catalog/core/db/migrate";
import { defaultMigrationsDir } from "./runtime";

async function main(): Promise<void> {
  defaultMigrationsDir();
  const folder = resolveMigrationsFolder();
  console.log(`migrate: applying migrations from ${folder}`);
  await runMigrations(getDb(), folder);
  console.log("migrate: migrations applied");
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
