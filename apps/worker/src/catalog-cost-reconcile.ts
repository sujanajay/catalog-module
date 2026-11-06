// catalog-cost-reconcile job (M6-S2, docs/program/requirements/M6-reliability-cost.md M6-F1-R4 to R6 and R10; esbuild
// entry "catalog-cost-reconcile"). The Cloud Run job catalog-cost-reconcile runs it every day at 06:00 UTC (Cloud
// Scheduler, infra/catalog-cost-reconcile.sh): it reads Cloud Run instance time from Cloud Monitoring and the current
// Cloud Run shapes (read only), prices them, compares them with the cost ledger and writes catalog_cost_days and
// catalog_cost_allocations for the last RECONCILE_DAYS complete UTC days (packages/core/src/catalog/cost-reconcile.ts).
// Runs by hand with: bash infra/catalog-cost-reconcile.sh run
//
// Env: GCP_PROJECT (default image-links-agent), COST_RECONCILE_DAYS (default 3, at most 42, for a backfill), and the
// worker's DB_* settings. Exits non-zero when the run fails. A run writes all its days in one transaction at the end, so
// a failed run changes no day; it records a run_failed alert (emailed through the sweep's daily_check_alert, policy 16).
import { GoogleAuth } from "google-auth-library";
import { googleCostReaders, logRun, MAX_RECONCILE_DAYS, RECONCILE_DAYS, runCostReconcile } from "@catalog/core/catalog/cost-reconcile";
import { closeDb, getDb } from "@catalog/core/db/client";
import { recordJobRun } from "@catalog/core/job-cost";
import { log } from "@catalog/core/log";
import { describeError } from "@catalog/core/retry";

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

async function main() {
  const startedAt = Date.now();
  const project = process.env.GCP_PROJECT?.trim() || "image-links-agent";
  const days = process.env.COST_RECONCILE_DAYS?.trim() ? Number(process.env.COST_RECONCILE_DAYS) : RECONCILE_DAYS;
  const db = getDb();
  try {
    if (!PROJECT.test(project)) throw new Error("GCP_PROJECT must be a project id.");
    if (!Number.isInteger(days) || days < 1 || days > MAX_RECONCILE_DAYS) throw new Error(`COST_RECONCILE_DAYS must be a whole number from 1 to ${MAX_RECONCILE_DAYS}.`);
    const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
    const get = async (url: string) => (await auth.fetch(url, { signal: AbortSignal.timeout(60_000) })).data;
    const post = async (url: string, body: unknown) => (await auth.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })).data;
    const result = await runCostReconcile(db, googleCostReaders(get, project, post), { days });
    logRun(result);
    log("INFO", "cost reconcile finished", { days: result.days.map((d) => d.day), alerts: result.alerts.length, newAlerts: result.newAlerts.length, ms: Date.now() - startedAt });
  } catch (error) {
    // A failed run writes no rows and a run_failed alert (policy 16); if the database itself failed, the sweep's
    // cost_reconcile_stale check emails 30 hours on (policy 17).
    log("ERROR", "daily check failed", { check: "run_failed", error: describeError(error), ms: Date.now() - startedAt });
    process.exitCode = 1;
  } finally {
    // M6-F1-R3: this run's billable seconds as one cost ledger row (only on Cloud Run, where CLOUD_RUN_JOB is set).
    await recordJobRun(db, { startedAt, outcome: process.exitCode ? "failed" : "ok" });
    await closeDb();
  }
}

main().catch((error) => { console.error(describeError(error)); process.exitCode = 1; });
