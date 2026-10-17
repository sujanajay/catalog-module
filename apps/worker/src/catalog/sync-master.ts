// POST /tasks/catalog/sync-master (spec 02): nightly brand master and SKU map sync, called by
// Cloud Scheduler. A BigQuery error answers 503 so the scheduler retries; any other error is
// thrown and the server answers 500.
import { BigQuerySyncError, syncMaster, type BigQueryLike } from "@catalog/core/catalog/master-sync";
import type { Db } from "@catalog/core/db/client";

export interface SyncMasterDeps {
  db: Db;
  bq: BigQueryLike;
  env?: NodeJS.ProcessEnv;
}

/** Same shape as HandleResult in server.ts: 200 done, 503 retry, 500 unexpected. */
export interface SyncMasterResult { httpStatus: number; outcome: string }

export async function handleSyncMaster(deps: SyncMasterDeps, _body: Record<string, unknown>): Promise<SyncMasterResult> {
  try {
    const result = await syncMaster(deps.db, deps.bq, deps.env ?? process.env);
    console.log(
      JSON.stringify({
        severity: result.warnings.length ? "WARNING" : "INFO",
        message: "catalog sync-master done",
        brands: result.brands,
        skus: result.skus,
        warnings: result.warnings,
      }),
    );
    return { httpStatus: 200, outcome: `synced:${result.brands}/${result.skus}` };
  } catch (err) {
    if (err instanceof BigQuerySyncError) {
      console.error(JSON.stringify({ severity: "ERROR", message: "catalog sync-master BigQuery read failed", error: err.message }));
      return { httpStatus: 503, outcome: "bigquery_unavailable" };
    }
    throw err;
  }
}
