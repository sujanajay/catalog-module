// catalog-worker HTTP entry: /healthz plus the task routes (spec 02 "Worker server").
import { OAuth2Client } from "google-auth-library";
import { closeDb, getDb } from "@catalog/core/db/client";
import { authConfigFromEnv } from "./auth";
import { handleSweep, type ReleaseLocks } from "./catalog/sweep";
import { defaultMigrationsDir } from "./runtime";
import { createServer, type ServerDeps } from "./server";

defaultMigrationsDir();

const port = Number(process.env.PORT) || 8080;
const auth = authConfigFromEnv(new OAuth2Client());
if (auth.skip) {
  console.warn("WARNING: SKIP_OIDC=1 - task routes accept unauthenticated requests. Local dev only.");
} else if (!auth.audience || !auth.serviceAccountEmail) {
  console.error("WORKER_URL and WORKER_SA_EMAIL must be set; task routes return 500 until they are.");
}

// INTEGRATION (spec 02 workstream C): replace this stub with
//   import { releaseLocks } from "@catalog/core/catalog/products";
// and delete it. Until then a sweep that finds a stale batch rolls back and answers 500.
const releaseLocks: ReleaseLocks = () =>
  Promise.reject(new Error("releaseLocks is not wired yet (spec 02 workstream C products.ts)"));

const routes: ServerDeps["routes"] = {
  // INTEGRATION (spec 02 workstream C): add the sync-master route here, built by C in ./catalog/sync-master:
  //   import { handleSyncMaster } from "./catalog/sync-master";
  //   "/tasks/catalog/sync-master": (body) => handleSyncMaster(<deps: getDb(), BigQuery client, env>, body),
  // Keep it first so /healthz lists ["/tasks/catalog/sync-master", "/tasks/catalog/sweep"].
  // The DB handle is taken lazily inside each handler so /healthz works before the DB is reachable.
  "/tasks/catalog/sweep": (body) => handleSweep({ db: getDb(), releaseLocks }, body),
};

const server = createServer({ auth, version: process.env.K_REVISION || "dev", routes });
server.listen(port, () => console.log(`catalog-worker listening on :${port}`));

const shutdown = () => {
  server.close(() => {
    closeDb()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
