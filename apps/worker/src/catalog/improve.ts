// M1-S4 improvement task, the worker side (core catalog/improve.ts holds the rules and the reset; M1-F3-R4, R5).
// - enqueueImprovements: the sweep (every 10 minutes) sends one `/tasks/catalog/improve` task per photo due a try.
// - handleImproveTask: POST /tasks/catalog/improve {batchId, sourceImageId}. A try is made only while the upscaler is
//   switched on and answers its health probe for every upscaler the photo failed with, so an outage never spends a
//   try. Then the photo is reset (improvePhoto) and the batch's finalize re-opened: once the re-made photo is
//   published at the same URL, finalize writes a new links sheet and releases the product again.
import { and, eq } from "drizzle-orm";
import { catalogEnlargements } from "@catalog/core/db/schema";
import { improvementCandidates, improvePhoto, markImproved } from "@catalog/core/catalog/improve";
import type { Db } from "@catalog/core/db/client";
import type { enqueueTask, TaskRoute } from "@catalog/core/tasks";
import type { HandleResult } from "../server";
import { enqueueFinalize, type CatalogDeps } from "./deps";
import { upscaleProbeTimeoutMs } from "./enlarge";

export const IMPROVE_ROUTE = "/tasks/catalog/improve" satisfies TaskRoute;

/**
 * Marks the photos improved since the last run, then sends a task for each photo due a try (none while the upscaler
 * is switched off). The task id names the photo, its try and the hour (IMPROVE_RESEND_MS), so the sweeps of one hour
 * send one task: a photo waiting for the upscaler is probed at most once an hour.
 */
export const IMPROVE_RESEND_MS = 60 * 60_000;
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
  const failed = await deps.db.selectDistinct({ upscaler: catalogEnlargements.upscaler }).from(catalogEnlargements)
    .where(and(eq(catalogEnlargements.batchId, batchId), eq(catalogEnlargements.sourceImageId, sourceImageId), eq(catalogEnlargements.wanted, true), eq(catalogEnlargements.status, "failed")));
  if (!failed.length) return { httpStatus: 200, outcome: "nothing_to_improve" };
  if (deps.enlargeProbe) {
    for (const { upscaler } of failed) {
      const probe = await deps.enlargeProbe(upscaler, { timeoutMs: upscaleProbeTimeoutMs() });
      if (probe !== "ok") { deps.log("improvement waits for the upscaler", { batchId, sourceImageId, upscaler, probe }); return { httpStatus: 200, outcome: "upscaler_unavailable" }; }
    }
  }
  const result = await improvePhoto(deps.db, deps.enqueue, { batchId, sourceImageId, now, log: deps.log });
  if (result.outcome === "improving") await enqueueFinalize(deps, batchId, undefined, { reopen: true });
  deps.log("improvement", { batchId, sourceImageId, outcome: result.outcome, ...(result.tries ? { tries: result.tries } : {}) });
  return { httpStatus: 200, outcome: result.outcome };
}
