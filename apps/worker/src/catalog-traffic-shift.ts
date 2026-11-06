// catalog-traffic-shift job (M6-F3-R1 deploy_overlap, M6 decision C6; esbuild entry "catalog-traffic-shift"). The deploy
// gate (infra/lib/gate.sh gate_record_shift) starts one execution each time traffic moves on a catalog service, because
// the laptop running infra/deploy.sh cannot reach the private database. Writes one catalog_traffic_shifts row.
// With SHIFT_SYNC=1 (gate_shift_report starts one at the end of each deploy) it instead fills any missing record from Cloud
// Audit Logs, with the real time (traffic-sync.ts).
// Env: SHIFT_SERVICE, SHIFT_REVISION, SHIFT_AT or SHIFT_SYNC (set per execution), GCP_PROJECT (default image-links-agent) and
// the worker's DB_* settings. Exits non-zero when refused or failed; the job's retries repeat the same row, which is a no-op.
import { GoogleAuth } from "google-auth-library";
import { googleCostReaders } from "@catalog/core/catalog/cost-reconcile";
import { parseTrafficShift, recordTrafficShift } from "@catalog/core/catalog/reliability";
import { googleTrafficAudit, syncTrafficShifts } from "@catalog/core/catalog/traffic-sync";
import { closeDb, getDb } from "@catalog/core/db/client";
import { recordJobRun } from "@catalog/core/job-cost";
import { log } from "@catalog/core/log";
import { describeError } from "@catalog/core/retry";

async function main() {
  const startedAt = Date.now();
  const db = getDb();
  try {
    if (process.env.SHIFT_SYNC === "1") {
      const project = process.env.GCP_PROJECT?.trim() || "image-links-agent";
      const auth = new GoogleAuth({ scopes: "https://www.googleapis.com/auth/cloud-platform" });
      const get = async (url: string) => (await auth.fetch(url, { signal: AbortSignal.timeout(60_000) })).data;
      const post = async (url: string, body: unknown) => (await auth.fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })).data;
      const result = await syncTrafficShifts(db, googleTrafficAudit(post, project), await googleCostReaders(get, project).resources());
      log("INFO", "traffic shifts synced from the audit log", { ...result });
      return;
    }
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
