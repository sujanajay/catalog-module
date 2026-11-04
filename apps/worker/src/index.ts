// catalog-worker HTTP entry: /health plus the task routes (spec 02 "Worker server").
import { OAuth2Client } from "google-auth-library";
import { createBigQuery, type BigQueryLike } from "@catalog/core/catalog/master-sync";
import { releaseLocks } from "@catalog/core/catalog/products";
import { closeDb, getDb, workerDbTimeoutDefaults } from "@catalog/core/db/client";
import { authConfigFromEnv } from "./auth";
import { handleIngestMoreTask, handleIngestTask, workerIngestDeps } from "./catalog/ingest";
import { workerCatalogDeps } from "./catalog/deps";
import { handleChunkTask } from "./catalog/chunk";
import { handleEnlargeTask } from "./catalog/enlarge";
import { upscaleConfigFromEnv } from "@catalog/core/catalog/upscale";
import { handlePublishTask } from "./catalog/publish";
import { handleImproveTask } from "./catalog/improve";
import { handleFinalizeTask } from "./catalog/finalize";
import { draftExpiryDaysFromEnv, handleSweep } from "./catalog/sweep";
import { handleSyncMaster } from "./catalog/sync-master";
import { log } from "@catalog/core/log";
import { defaultMigrationsDir, installWarningLog } from "./runtime";
import { createServer, type ServerDeps } from "./server";
import { DRAIN_GRACE_MS, isDraining, startDrain } from "./drain";
import { withDeliveryCost } from "./delivery-cost";

defaultMigrationsDir();
// Spec 18 H4: a warning flood (MaxListenersExceededWarning) names its emitter with a stack in the logs.
installWarningLog(log);
// A runaway statement is cancelled instead of keeping the shared Cloud SQL instance busy after its request is gone.
workerDbTimeoutDefaults(process.env);

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

// M6-F1-R2: every delivery's wall time is a compute row in the cost ledger. The chunk and publish handlers write
// their own; the other routes are wrapped (delivery-cost.ts).
const costed = { db: getDb };
const routes: ServerDeps["routes"] = {
  // The DB handle is taken lazily inside each handler so /health works before the DB is reachable.
  "/tasks/catalog/sync-master": withDeliveryCost(costed, "system", (body) => handleSyncMaster({ db: getDb(), bq: lazyBigQuery, env: process.env }, body)),
  "/tasks/catalog/sweep": withDeliveryCost(costed, "system", (body) => handleSweep({ db: getDb(), releaseLocks, draftExpiryDays: draftExpiryDaysFromEnv(process.env), enlargementOff: !upscaleConfigFromEnv().model }, body)),
  "/tasks/catalog/ingest": withDeliveryCost(costed, "ingest", (body, opts) => handleIngestTask({ db: getDb(), ingest: ingestDeps }, body, opts)),
  "/tasks/catalog/ingest-more": withDeliveryCost(costed, "ingest", (body) => handleIngestMoreTask({ db: getDb(), ingest: ingestDeps }, body)),
  "/tasks/catalog/chunk": (body, opts) => handleChunkTask(workerCatalogDeps(getDb()), body, opts),
  "/tasks/catalog/enlarge": withDeliveryCost(costed, "upscale", (body, opts) => handleEnlargeTask(workerCatalogDeps(getDb()), body, opts)),
  "/tasks/catalog/publish": (body) => handlePublishTask(workerCatalogDeps(getDb()), body),
  "/tasks/catalog/improve": withDeliveryCost(costed, "system", (body) => handleImproveTask(workerCatalogDeps(getDb()), body)),
  "/tasks/catalog/finalize": withDeliveryCost(costed, "finalize", (body) => handleFinalizeTask(workerCatalogDeps(getDb()), body)),
};

const server = createServer({ auth, version: process.env.K_REVISION || "dev", routes, draining: isDraining });
server.listen(port, () => console.log(`catalog-worker listening on :${port}`));

// M6-F2-R3: SIGTERM starts the drain (drain.ts): new deliveries get 503, chunk deliveries start no new photo and hand
// off, enlargement calls in flight give their count back. In-flight requests get DRAIN_GRACE_MS, inside Cloud Run's
// 10 s grace; whatever is still running then is left to its lease or claim.
const shutdown = () => {
  if (isDraining()) return;
  const started = Date.now();
  setTimeout(() => process.exit(0), DRAIN_GRACE_MS).unref();
  void startDrain().finally(() => {
    log("INFO", "worker draining", { event: "drain", revision: process.env.K_REVISION ?? "dev", ms: Date.now() - started });
    server.close(() => {
      closeDb()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
    server.closeIdleConnections();
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
