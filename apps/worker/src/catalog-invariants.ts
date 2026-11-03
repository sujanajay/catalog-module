// catalog-invariants job (spec 17 3.1.3; esbuild entry "catalog-invariants", Cloud Run job catalog-invariants
// prepared by infra/catalog-test-jobs.sh with CATALOG_TEST_JOBS=invariants). Runs every invariant once, on
// demand, the same way the sweep does every 10 minutes, and prints one line per check plus a summary. Each line
// and each summary entry names the violating batches (batchId, test flag, count), so violations are reported per
// batch and test batches can be told apart from delivered ones.
//
//   node dist/catalog-invariants.js [--batch <id>]     (env fallback: INVARIANTS_BATCH)
//
// Exits non-zero when an ERROR check has a violation. Writes nothing but the counts keys silentOutputs,
// heldSiblings and slowestChunkMs on catalog_batches.counts.
import { parseArgs } from "node:util";
import { closeDb, getDb } from "@catalog/core/db/client";
import { runInvariants } from "@catalog/core/catalog/invariants/run";
import { log } from "@catalog/core/log";
import { describeError } from "@catalog/core/retry";
import { recordJobRun } from "@catalog/core/job-cost";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const startedAt = Date.now();
  const { values } = parseArgs({ options: { batch: { type: "string" } } });
  const batchId = values.batch ?? process.env.INVARIANTS_BATCH;
  if (batchId && !UUID.test(batchId)) throw new Error("--batch must be a batch id (a UUID).");
  try {
    const { results } = await runInvariants(getDb(), log, new Date(), batchId ? { batchId } : {});
    const broken = results.filter(r => r.severity === "ERROR" && r.violations > 0);
    log(broken.length ? "ERROR" : "INFO", "invariants summary", { batchId: batchId ?? null, results: results.map(r => ({ id: r.id, violations: r.violations, severity: r.severity, batches: r.batches, batchCount: r.batchCount })) });
    if (broken.length) process.exitCode = 1;
  } finally {
    // M6-F1-R3: this run's billable seconds as one cost ledger row (only on Cloud Run, where CLOUD_RUN_JOB is set).
    await recordJobRun(getDb(), { startedAt, outcome: process.exitCode ? "failed" : "ok", batchId: batchId ?? null });
    await closeDb();
  }
}

main().catch(error => { console.error(describeError(error)); process.exitCode = 1; });
