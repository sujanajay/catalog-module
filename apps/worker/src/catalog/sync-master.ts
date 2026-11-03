// POST /tasks/catalog/sync-master (spec 02): nightly brand master and SKU map sync, called by
// Cloud Scheduler. A BigQuery error answers 503 so the scheduler retries; any other error is
// thrown and the server answers 500.
//
// After the master sync, the catalog graph sync (M0-S2, F1-R1) rebuilds options, listings, keys and style keys from
// the fresh sku_map. The graph sync never fails the master sync: on any error it leaves the previous graph, logs an
// ERROR and the outcome says so; the next nightly run retries it (F1 edge cases).
import { BigQuerySyncError, syncMaster, type BigQueryLike } from "@catalog/core/catalog/master-sync";
import type { Db } from "@catalog/core/db/client";
import { syncGraph } from "@catalog/core/graph/key-sync";
import type { HandleResult } from "../server";

export interface SyncMasterDeps {
  db: Db;
  bq: BigQueryLike;
  env?: NodeJS.ProcessEnv;
}

/** 200 done, 503 retry (BigQuery error), 500 unexpected. */
export type SyncMasterResult = HandleResult;

export async function handleSyncMaster(deps: SyncMasterDeps, _body: Record<string, unknown>): Promise<SyncMasterResult> {
  const env = deps.env ?? process.env;
  let outcome: string;
  try {
    const result = await syncMaster(deps.db, deps.bq, env);
    console.log(
      JSON.stringify({
        severity: result.warnings.length ? "WARNING" : "INFO",
        message: "catalog sync-master done",
        brands: result.brands,
        skus: result.skus,
        warnings: result.warnings,
      }),
    );
    outcome = `synced:${result.brands}/${result.skus}`;
  } catch (err) {
    if (err instanceof BigQuerySyncError) {
      console.error(JSON.stringify({ severity: "ERROR", message: "catalog sync-master BigQuery read failed", error: err.message }));
      return { httpStatus: 503, outcome: "bigquery_unavailable" };
    }
    throw err;
  }
  return { httpStatus: 200, outcome: `${outcome};${await graphOutcome(deps.db, deps.bq, env)}` };
}

async function graphOutcome(db: Db, bq: BigQueryLike, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const g = await syncGraph(db, bq, env);
    console.log(JSON.stringify({ severity: g.conflicts.open ? "WARNING" : "INFO", message: "catalog graph sync done", ...g }));
    return g.skipped ? "graph:locked" : `graph:${g.options}/${g.listings}`;
  } catch (err) {
    console.error(JSON.stringify({ severity: "ERROR", message: "catalog graph sync failed; the previous graph is kept", error: err instanceof Error ? err.message : String(err) }));
    return err instanceof BigQuerySyncError ? "graph:bigquery_unavailable" : "graph:failed";
  }
}
