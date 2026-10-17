// catalog-worker HTTP entry: /healthz plus the task routes (spec 02 "Worker server").
import { OAuth2Client } from "google-auth-library";
import { createBigQuery, type BigQueryLike } from "@catalog/core/catalog/master-sync";
import { releaseLocks } from "@catalog/core/catalog/products";
import { closeDb, getDb } from "@catalog/core/db/client";
import { authConfigFromEnv } from "./auth";
import { handleSweep } from "./catalog/sweep";
import { handleSyncMaster } from "./catalog/sync-master";
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

// One BigQuery client per process, created on first use so /healthz never needs BigQuery.
let bigQuery: Promise<BigQueryLike> | undefined;
const getBigQuery = (): Promise<BigQueryLike> => (bigQuery ??= createBigQuery(process.env));

const routes: ServerDeps["routes"] = {
  // Order matters: /healthz lists ["/tasks/catalog/sync-master", "/tasks/catalog/sweep"].
  // The DB handle is taken lazily inside each handler so /healthz works before the DB is reachable.
  "/tasks/catalog/sync-master": async (body) =>
    handleSyncMaster({ db: getDb(), bq: await getBigQuery(), env: process.env }, body),
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
