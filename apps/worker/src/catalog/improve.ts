// M1-S4 improvement task, the worker side (core catalog/improve.ts holds the rules and the reset; M1-F3-R4, R5).
// - enqueueImprovements: the sweep (every 10 minutes) sends one `/tasks/catalog/improve` task per photo due a try.
// - handleImproveTask: POST /tasks/catalog/improve {batchId, sourceImageId}. A try is made only while the upscaler is
//   switched on and answers its health probe for every upscaler the photo failed with, so an outage never spends a
//   try. Then the photo is reset (improvePhoto) and the batch's finalize re-opened: once the re-made photo is
//   published at the same URL, finalize writes a new links sheet and releases the product again.
import { and, eq, sql } from "drizzle-orm";
import { catalogEnlargements } from "@catalog/core/db/schema";
import { improvementCandidates, improvePhoto, markImproved, noteImprovementWait } from "@catalog/core/catalog/improve";
import type { Db } from "@catalog/core/db/client";
import type { UpscaleProbe } from "@catalog/core/catalog/enlarge";
import type { enqueueTask, TaskRoute } from "@catalog/core/tasks";
import type { HandleResult } from "../server";
import { enqueueFinalize, type CatalogDeps } from "./deps";
import { observeUpscaler, upscaleProbeTimeoutMs } from "./enlarge";

export const IMPROVE_ROUTE = "/tasks/catalog/improve" satisfies TaskRoute;

/**
 * Marks the photos improved since the last run, then sends a task for each photo due a try (none while the upscaler
 * is switched off). The task id names the photo, its try and the hour (IMPROVE_RESEND_MS), so the sweeps of one hour
 * send one task: a photo waiting for the upscaler is probed at most once an hour.
 */
export const IMPROVE_RESEND_MS = 60 * 60_000;
/**
 * P3-2 (review 2026-11-04): an upscaler whose probe did not answer `ok` is not probed again by this instance for this
 * long, so the tasks of one sweep wave share one probe instead of each waking the GPU service.
 */
export const IMPROVE_PROBE_CACHE_MS = 10 * 60_000;
const unavailable = new Map<string, { until: number; probe: UpscaleProbe }>();
/** Tests: forget the probe answers this instance remembers. */
export function clearImproveProbeCache(): void { unavailable.clear(); }

export async function enqueueImprovements(db: Db, enqueue: typeof enqueueTask, now: Date, options: { enlargementOff?: boolean } = {}): Promise<number> {
  await markImproved(db, now);
  if (options.enlargementOff) return 0;
  const due = await improvementCandidates(db, now);
  for (const c of due) await enqueue(IMPROVE_ROUTE, { batchId: c.batchId, sourceImageId: c.sourceImageId }, { taskId: `improve-${c.sourceImageId}-${c.tries + 1}-${Math.floor(+now / IMPROVE_RESEND_MS)}` });
  return due.length;
}

export async function handleImproveTask(deps: CatalogDeps, body: Record<string, unknown>): Promise<HandleResult> {
  if (typeof body.batchId !== "string" || typeof body.sourceImageId !== "string") return { httpStatus: 400, outcome: "batchId and sourceImageId are required" };
  const { batchId, sourceImageId } = body, now = deps.now();
  // The rollback switch (UPSCALE_MODEL=off): nothing to enlarge with.
  if (!deps.enlarge) return { httpStatus: 200, outcome: "upscaler_off" };
  // The rows a call can make again (a size-refused row, route `none`, never can; P3-3).
  const failed = await deps.db.selectDistinct({ upscaler: catalogEnlargements.upscaler, productId: catalogEnlargements.productId }).from(catalogEnlargements)
    .where(and(eq(catalogEnlargements.batchId, batchId), eq(catalogEnlargements.sourceImageId, sourceImageId), eq(catalogEnlargements.wanted, true), eq(catalogEnlargements.status, "failed"), sql`${catalogEnlargements.route} <> 'none'`));
  if (!failed.length) return { httpStatus: 200, outcome: "nothing_to_improve" };
  if (deps.enlargeProbe) {
    for (const upscaler of new Set(failed.map((f) => f.upscaler))) {
      const remembered = unavailable.get(upscaler);
      const fresh = !remembered || remembered.until <= +now;
      const probe = fresh ? await deps.enlargeProbe(upscaler, { timeoutMs: upscaleProbeTimeoutMs() }) : remembered.probe;
      // M1-S4b: a fresh answer feeds the upscaler health ledger (a remembered one was recorded when it was fresh).
      if (fresh) await observeUpscaler(deps, upscaler, probe, now);
      if (probe !== "ok") {
        if (fresh) unavailable.set(upscaler, { until: +now + IMPROVE_PROBE_CACHE_MS, probe });
        await noteImprovementWait(deps.db, { batchId, productId: failed[0]!.productId, sourceImageId }, now);
        deps.log("improvement waits for the upscaler", { batchId, sourceImageId, upscaler, probe });
        return { httpStatus: 200, outcome: "upscaler_unavailable" };
      }
      unavailable.delete(upscaler);
    }
  }
  const result = await improvePhoto(deps.db, deps.enqueue, { batchId, sourceImageId, now, log: deps.log });
  if (result.outcome === "improving") await enqueueFinalize(deps, batchId, undefined, { reopen: true });
  deps.log("improvement", { batchId, sourceImageId, outcome: result.outcome, ...(result.tries ? { tries: result.tries } : {}) });
  return { httpStatus: 200, outcome: result.outcome };
}
