// catalog-route-switch job (M7-F2-R5 kill switch and its drill, R1 exit item 3; esbuild entry "catalog-route-switch").
// The Cloud Run job catalog-route-switch runs it; infra/catalog-route-switch.sh sets the command per execution:
//   bash infra/catalog-route-switch.sh show [capability]
//   bash infra/catalog-route-switch.sh set <route id> off|serving "<reason>"
//   bash infra/catalog-route-switch.sh drill <capability> <minutes> "<reason>" [batch id]
// Env: ROUTE_COMMAND (show|set|drill), ROUTE_CAPABILITY, ROUTE_ID, ROUTE_STATE, ROUTE_REASON, ROUTE_ACTOR,
// DRILL_CAPABILITY, DRILL_MINUTES, DRILL_BATCH, and the worker's DB_* settings. Logic in route-switch.ts.
// Exits non-zero when the command is refused or fails. On SIGTERM a running drill restores route 1 before exiting;
// if the job dies without that, the stored expiry restores it (the router honours restore_at).
import { closeDb, getDb } from "@catalog/core/db/client";
import { recordJobRun } from "@catalog/core/job-cost";
import { describeError } from "@catalog/core/retry";
import { parseRouteSwitchEnv, runRouteSwitch } from "./route-switch";

async function main() {
  const startedAt = Date.now();
  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());
  const db = getDb();
  try {
    await runRouteSwitch(parseRouteSwitchEnv(process.env), { db, print: line => console.info(line), signal: stop.signal });
  } catch (error) {
    console.error(`Refused or failed: ${describeError(error)}`);
    process.exitCode = 1;
  } finally {
    // M6-F1-R3: this run's billable seconds as one cost ledger row (only on Cloud Run, where CLOUD_RUN_JOB is set).
    await recordJobRun(db, { startedAt, outcome: process.exitCode ? "failed" : "ok" });
    await closeDb();
  }
}

main().catch(error => { console.error(describeError(error)); process.exitCode = 1; });
