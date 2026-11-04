// M1-F2-R6 (M1-S2): the auto-start task, queued with the countdown's delay when collection ends (armAutoStart).
import { runAutoStart } from "@catalog/core/catalog/pipeline/start";
import type { HandleResult } from "../server";
import type { CatalogDeps } from "./deps";

export async function handleAutoStartTask(deps: Pick<CatalogDeps, "db" | "storage" | "enqueue" | "now">, body: Record<string, unknown>): Promise<HandleResult> {
  if (typeof body.batchId !== "string" || typeof body.at !== "string") return { httpStatus: 400, outcome: "batchId and at are required" };
  const outcome = await runAutoStart(deps.db, deps, { batchId: body.batchId, at: body.at });
  return { httpStatus: 200, outcome };
}
