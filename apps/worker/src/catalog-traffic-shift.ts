// catalog-traffic-shift job (M6-F3-R1 deploy_overlap, M6 decision C6; esbuild entry "catalog-traffic-shift"). The deploy
// gate (infra/lib/gate.sh gate_record_shift) starts one execution each time traffic moves on a catalog service, because
// the laptop running infra/deploy.sh cannot reach the private database. Writes one catalog_traffic_shifts row.
// Env: SHIFT_SERVICE, SHIFT_REVISION, SHIFT_AT (set per execution) and the worker's DB_* settings. Exits non-zero when
// refused or failed; the job's retries repeat the same row, which is a no-op.
import { parseTrafficShift, recordTrafficShift } from "@catalog/core/catalog/reliability";
import { closeDb, getDb } from "@catalog/core/db/client";
import { recordJobRun } from "@catalog/core/job-cost";
import { log } from "@catalog/core/log";
import { describeError } from "@catalog/core/retry";

async function main() {
  const startedAt = Date.now();
  const db = getDb();
  try {
    const shift = parseTrafficShift(process.env);
    const marked = await recordTrafficShift(db, shift);
    log("INFO", "traffic shift recorded", { service: shift.service, revision: shift.revision, at: shift.at.toISOString(), batchesMarked: marked });
  } catch (error) {
    log("ERROR", "traffic shift not recorded", { error: describeError(error) });
    process.exitCode = 1;
  } finally {
    // M6-F1-R3: this run's billable seconds as one cost ledger row (only on Cloud Run, where CLOUD_RUN_JOB is set).
    await recordJobRun(db, { startedAt, outcome: process.exitCode ? "failed" : "ok" });
    await closeDb();
  }
}

main().catch((error) => { console.error(describeError(error)); process.exitCode = 1; });
