// Evidence helpers of the catalog-load driver (spec 18 H4). Kept apart from catalog-load.ts, which runs
// its main() on import, so the report's shape and its write-before-cleanup order are tested.
import type { LinkResult, SheetProblem } from "@catalog/core/catalog/recheck/check";
import type { BatchRecheck } from "./recheck-batch";

/** Links kept per problem in load-report.json; recheck-<batchId>.csv has every link. */
export const RECHECK_LINKS_PER_PROBLEM = 50;

export interface RecheckFailure { url: string; identifier: string; channel: string | null; n: number | null; http: number | null; problem: string }
export interface RecheckEvidence {
  line: string; passed: boolean; ok: number; total: number;
  /** Failed links grouped by problem code (`fetch_error: socket hang up` counts as fetch_error); a link with two problems is in both. */
  failuresByProblem: Record<string, { count: number; links: RecheckFailure[] }>;
  sheetProblems: SheetProblem[];
  /** The file name of the per-link CSV next to the report, or null when it could not be written. */
  csv: string | null;
}

/** The problem codes of one link result: "wrong_dimensions; fetch_error: reset" -> ["wrong_dimensions", "fetch_error"]. */
export function problemCodes(result: Pick<LinkResult, "problem">): string[] {
  return [...new Set(result.problem.split(";").map(p => p.split(":")[0]!.trim()).filter(Boolean))];
}

export function recheckEvidence(recheck: BatchRecheck, csv: string | null): RecheckEvidence {
  const failuresByProblem: RecheckEvidence["failuresByProblem"] = {};
  for (const r of recheck.results) {
    if (r.status === "ok") continue;
    for (const code of problemCodes(r)) {
      const group = (failuresByProblem[code] ??= { count: 0, links: [] });
      group.count++;
      if (group.links.length < RECHECK_LINKS_PER_PROBLEM) group.links.push({ url: r.url, identifier: r.identifier, channel: r.channel, n: r.n, http: r.http, problem: r.problem });
    }
  }
  const { ok, total, line, passed } = recheck.summary;
  return { line, passed, ok, total, failuresByProblem, sheetProblems: recheck.problems, csv };
}

/**
 * Writes the report, then runs the cleanup, then writes the report again with the cleanup's outcome. The
 * report exists before any object is deleted, so a cleanup that hangs or kills the job keeps the evidence.
 */
export async function reportThenCleanup<R extends { cleanup: unknown }>(report: R, steps: { write: (report: R) => Promise<void>; cleanup?: () => Promise<R["cleanup"]> }): Promise<R> {
  await steps.write(report);
  if (!steps.cleanup) return report;
  report.cleanup = await steps.cleanup();
  await steps.write(report);
  return report;
}
