// catalog-worker HTTP entry: /health plus the task routes (spec 02 "Worker server").
import { OAuth2Client } from "google-auth-library";
import { createBigQuery, type BigQueryLike } from "@catalog/core/catalog/master-sync";
import { releaseLocks } from "@catalog/core/catalog/products";
import { closeDb, getDb } from "@catalog/core/db/client";
import { authConfigFromEnv } from "./auth";
import { handleIngestMoreTask, handleIngestTask, workerIngestDeps } from "./catalog/ingest";
import { workerCatalogDeps } from "./catalog/deps";
import { handleChunkTask } from "./catalog/chunk";
import { handlePublishTask } from "./catalog/publish";
import { handleFinalizeTask } from "./catalog/finalize";
import { draftExpiryDaysFromEnv, handleSweep } from "./catalog/sweep";
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

// One BigQuery client per process, created on first query so /health never needs BigQuery. A failed
// start is not cached, and it fails inside syncMaster's query, so the route answers 503 and the
// scheduler retries.
let bigQuery: Promise<BigQueryLike> | undefined;
const lazyBigQuery: BigQueryLike = {
  query: async (options) => {
    bigQuery ??= createBigQuery(process.env).catch((err: unknown) => {
      bigQuery = undefined;
      throw err;
    });
    return (await bigQuery).query(options);
  },
};

// Ingest reads and writes the private bucket (BUCKET) and fetches pasted links through safeFetch
// (fetchSourceUrl) with the DNS-pinned fetch, which checks every hop.
const ingestDeps = workerIngestDeps();

const routes: ServerDeps["routes"] = {
  // The DB handle is taken lazily inside each handler so /health works before the DB is reachable.
  "/tasks/catalog/sync-master": (body) => handleSyncMaster({ db: getDb(), bq: lazyBigQuery, env: process.env }, body),
  "/tasks/catalog/sweep": (body) => handleSweep({ db: getDb(), releaseLocks, draftExpiryDays: draftExpiryDaysFromEnv(process.env) }, body),
  "/tasks/catalog/ingest": (body) => handleIngestTask({ db: getDb(), ingest: ingestDeps }, body),
  "/tasks/catalog/ingest-more": (body) => handleIngestMoreTask({ db: getDb(), ingest: ingestDeps }, body),
  "/tasks/catalog/chunk": (body, opts) => handleChunkTask(workerCatalogDeps(getDb()), body, opts),
  "/tasks/catalog/publish": (body) => handlePublishTask(workerCatalogDeps(getDb()), body),
  "/tasks/catalog/finalize": (body) => handleFinalizeTask(workerCatalogDeps(getDb()), body),
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
