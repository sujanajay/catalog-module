// catalog-graph-export job (M0-S4, docs/program/requirements/M0-catalog-graph.md F5; esbuild entry
// "catalog-graph-export"). The Cloud Run job catalog-graph-export runs it once a day at 02:30 UTC (Cloud Scheduler,
// infra/catalog-graph-export.sh): it writes the catalog graph to the BigQuery dataset catalog_os in this project
// (packages/core/src/graph/export.ts). Runs by hand with: bash infra/catalog-graph-export.sh run
//
// Env: GCP_PROJECT (default image-links-agent), GRAPH_EXPORT_DATASET (default catalog_os), and the worker's DB_* settings.
// Exits non-zero when the run fails; the error is kept on its catalog_graph_export_runs row, and the previous BigQuery
// tables stay whole.
import { closeDb, getDb } from "@catalog/core/db/client";
import { createBigQueryExportSink, DEFAULT_EXPORT_DATASET, EXPORT_LOCATION, runGraphExport } from "@catalog/core/graph/export";
import { recordJobRun } from "@catalog/core/job-cost";
import { log } from "@catalog/core/log";
import { describeError } from "@catalog/core/retry";

const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;

async function main() {
  const startedAt = Date.now();
  const projectId = process.env.GCP_PROJECT?.trim() || "image-links-agent";
  const dataset = process.env.GRAPH_EXPORT_DATASET?.trim() || DEFAULT_EXPORT_DATASET;
  const db = getDb();
  try {
    // Inside the try, so a bad setting still writes the run's cost row and closes the pool (review P3-3).
    if (!DATASET.test(dataset)) throw new Error("GRAPH_EXPORT_DATASET must be a BigQuery dataset name.");
    const sink = createBigQueryExportSink({ projectId, dataset, location: EXPORT_LOCATION });
    const result = await runGraphExport(db, sink);
    log("INFO", "graph export finished", { runId: result.runId, dataset: `${projectId}.${dataset}`, rowsPerTable: result.rowsPerTable, maxSeq: result.maxSeq?.toString() ?? null, ms: Date.now() - startedAt });
  } catch (error) {
    log("ERROR", "graph export failed", { dataset: `${projectId}.${dataset}`, error: describeError(error), ms: Date.now() - startedAt });
    process.exitCode = 1;
  } finally {
    // M6-F1-R3: this run's billable seconds as one cost ledger row (only on Cloud Run, where CLOUD_RUN_JOB is set).
    await recordJobRun(db, { startedAt, outcome: process.exitCode ? "failed" : "ok" });
    await closeDb();
  }
}

main().catch((error) => { console.error(describeError(error)); process.exitCode = 1; });
