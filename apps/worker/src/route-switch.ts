// The operator surface of the route kill switch (M7-F2-R5, R1 exit item 3), run by the Cloud Run job
// catalog-route-switch (catalog-route-switch.ts, infra/catalog-route-switch.sh):
//   show   print the route table
//   set    set one route to off or serving, logged in vendor_route_changes with the reason and who asked. Turning off
//          the last serving route of a capability needs ROUTE_FORCE=1.
//   drill  turn off the route a batch would call first (its policy's judge for judge.render, the classifier model for
//          vision.read, or the route named in DRILL_ROUTE), then restore it when the given batch finishes or the minutes
//          run out, whichever is first. The drill is recorded on the route (drill_id, restore_at), so the router
//          restores it at expiry even when this job is stopped; the job's own restore is the early end and only ever
//          ends its own drill.
// Every command prints the routes of the capability before and after. Route ids are internal and reach only this
// job's log, never operator UI text (M7-F2-R6).
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, type VendorRouteRow } from "@catalog/core/db/schema";
import { CATALOG_CLASSIFIER_MODEL, CATALOG_QA_DEFAULT_MODEL } from "@catalog/core/catalog/qa/classify";
import { resolvePolicy } from "@catalog/core/catalog/qa/policy";
import { CircuitBreakers } from "@catalog/core/vendor/circuit";
import { endDrill, loadRouteRows, loadRoutes, RouteChangeError, setRoute, startDrill } from "@catalog/core/vendor/route-table";
import { createRouter, planRoutes, type PlannedRoute } from "@catalog/core/vendor/router";
import { CAPABILITIES, routeCallable, type Capability } from "@catalog/core/vendor/routes";

/** The states this surface sets; the other states belong to the harness (M7-F6). */
export const SWITCH_STATES = ["off", "serving"] as const;
export type SwitchState = (typeof SWITCH_STATES)[number];
/** A batch in one of these is finished, so the drill tied to it ends. */
export const FINISHED_BATCH_STATUSES = ["done", "failed", "cancelled"] as const;
/** How often a running drill looks at its batch and its expiry. */
export const DRILL_POLL_MS = 30_000;

export type RouteSwitchCommand =
  | { command: "show"; capability?: Capability }
  | { command: "set"; routeId: string; state: SwitchState; reason: string; actor: string; force?: boolean }
  | { command: "drill"; capability: Capability; minutes: number; batchId?: string; routeId?: string; reason: string; actor: string };

export interface RouteSwitchDeps {
  db: Db;
  print: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Aborted when the job is told to stop (SIGTERM): a running drill restores its route at once. */
  signal?: AbortSignal;
  pollMs?: number;
  /** The worker's environment, for CATALOG_QA_DEFAULT_MODEL (the built-in first judge and classifier model). */
  env?: NodeJS.ProcessEnv;
}

const isCapability = (v: string): v is Capability => (CAPABILITIES as readonly string[]).includes(v);
const isSwitchState = (v: string): v is SwitchState => (SWITCH_STATES as readonly string[]).includes(v);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The command from the job's environment (set per execution by infra/catalog-route-switch.sh). */
export function parseRouteSwitchEnv(env: NodeJS.ProcessEnv): RouteSwitchCommand {
  const get = (name: string) => env[name]?.trim() ?? "";
  const command = get("ROUTE_COMMAND") || "show";
  const reason = get("ROUTE_REASON"), actor = get("ROUTE_ACTOR");
  const needWhoWhy = () => { if (!reason || !actor) throw new RouteChangeError("ROUTE_REASON and ROUTE_ACTOR are required: every route change records why and who asked."); };
  if (command === "show") {
    const capability = get("ROUTE_CAPABILITY");
    if (capability && !isCapability(capability)) throw new RouteChangeError(`Unknown capability ${capability}.`);
    return { command, ...(capability ? { capability: capability as Capability } : {}) };
  }
  if (command === "set") {
    const routeId = get("ROUTE_ID"), state = get("ROUTE_STATE");
    if (!routeId) throw new RouteChangeError("ROUTE_ID is required.");
    if (!isSwitchState(state)) throw new RouteChangeError(`ROUTE_STATE must be one of ${SWITCH_STATES.join(", ")}.`);
    needWhoWhy();
    return { command, routeId, state, reason, actor, ...(get("ROUTE_FORCE") === "1" ? { force: true } : {}) };
  }
  if (command === "drill") {
    const capability = get("DRILL_CAPABILITY"), minutes = Number(get("DRILL_MINUTES")), batchId = get("DRILL_BATCH"), routeId = get("DRILL_ROUTE");
    if (!isCapability(capability)) throw new RouteChangeError(`DRILL_CAPABILITY must be one of ${CAPABILITIES.join(", ")}.`);
    if (batchId && !UUID.test(batchId)) throw new RouteChangeError("DRILL_BATCH must be a batch id.");
    needWhoWhy();
    return { command, capability, minutes, ...(batchId ? { batchId } : {}), ...(routeId ? { routeId } : {}), reason, actor };
  }
  throw new RouteChangeError(`ROUTE_COMMAND must be show, set or drill (got ${command}).`);
}

function routeLine(row: VendorRouteRow & { drillExpired: boolean }): string {
  const drill = row.drillId ? ` (drill ${row.drillId}: back to ${row.restoreState} at ${row.restoreAt!.toISOString()}${row.drillExpired ? ", expired" : ""})` : "";
  return `  ${row.capability} rank ${row.rank} ${row.id}: ${row.state}${drill}`;
}
async function printRoutes(deps: RouteSwitchDeps, title: string, capability?: Capability): Promise<void> {
  deps.print(`${title}:`);
  for (const row of await loadRouteRows(deps.db, capability)) deps.print(routeLine(row));
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
  signal?.addEventListener("abort", done, { once: true });
});

async function batchStatus(db: Db, batchId: string): Promise<string | null> {
  const [batch] = await db.select({ status: catalogBatches.status }).from(catalogBatches).where(eq(catalogBatches.id, batchId));
  return batch?.status ?? null;
}
const finished = (status: string | null) => status !== null && (FINISHED_BATCH_STATUSES as readonly string[]).includes(status);

/**
 * The models a batch (or, without one, a new batch on the built-in policy) asks first for this capability, in the
 * order the worker passes them to planRoutes: the batch's pinned policy judge (its second after a switch to it) for
 * judge.render (apps/worker/src/catalog/qa-stage.ts), the classifier model for vision.read (qa/classify.ts).
 */
async function preferredModels(db: Db, capability: Capability, batchId: string | undefined, env: NodeJS.ProcessEnv): Promise<{ models: string[]; source: string }> {
  const defaultModel = env.CATALOG_QA_DEFAULT_MODEL?.trim() || CATALOG_QA_DEFAULT_MODEL;
  if (capability !== "judge.render" && capability !== "vision.read") return { models: [], source: "route order" };
  const classifierModel = env.CATALOG_CLASSIFIER_MODEL?.trim() || CATALOG_CLASSIFIER_MODEL;
  if (!batchId) return { models: [capability === "vision.read" ? classifierModel : defaultModel], source: "the built-in first model" };
  const [batch] = await db.select().from(catalogBatches).where(eq(catalogBatches.id, batchId));
  if (!batch) throw new RouteChangeError(`No batch ${batchId}.`);
  const resolved = batch.options.policy ?? await resolvePolicy(db, batch.brandSlug, batch.productType === "auto" ? "*" : batch.productType);
  const policy = !batch.options.policy && resolved.source === "default" ? { ...resolved, qaModel: defaultModel } : resolved;
  if (capability === "vision.read") return { models: [classifierModel, policy.qaModelSecond ?? ""].filter(Boolean), source: `batch ${batchId}'s classifier model` };
  const useSecond = !!(batch.counts as { qaUseSecond?: boolean }).qaUseSecond && !!policy.qaModelSecond;
  const first = useSecond ? policy.qaModelSecond! : policy.qaModel, second = useSecond ? policy.qaModel : policy.qaModelSecond;
  return { models: [first, second ?? ""].filter(Boolean), source: `batch ${batchId}'s ${batch.options.policy ? "pinned" : "current"} policy judge${useSecond ? " (switched to its second)" : ""}` };
}
/** The routes this capability would be asked in, now, with fresh circuits (as a new worker process would). */
async function plan(db: Db, capability: Capability, models: readonly string[]): Promise<PlannedRoute[]> {
  return planRoutes(createRouter(await loadRoutes(db, capability), new CircuitBreakers()), capability, models);
}

/** Run one command. Throws RouteChangeError for a refused change (nothing is written then). */
export async function runRouteSwitch(cmd: RouteSwitchCommand, deps: RouteSwitchDeps): Promise<void> {
  const { db } = deps;
  if (cmd.command === "show") return printRoutes(deps, "Routes", cmd.capability);

  if (cmd.command === "set") {
    const rows = await loadRouteRows(db);
    const row = rows.find(r => r.id === cmd.routeId);
    if (!row) throw new RouteChangeError(`No route ${cmd.routeId}.`);
    const others = rows.filter(r => r.capability === row.capability && r.id !== row.id && routeCallable(r));
    if (cmd.state === "off" && !others.length) {
      if (!cmd.force) throw new RouteChangeError(`${cmd.routeId} is the last serving ${row.capability} route; turning it off stops the capability. Run set again with --force to do it anyway.`);
      deps.print(`WARNING: ${row.capability} has no other serving route; it stops until a route serves again (forced).`);
    }
    await printRoutes(deps, "Before", row.capability);
    await setRoute(db, cmd.routeId, { state: cmd.state, changedBy: cmd.actor, reason: cmd.reason });
    await printRoutes(deps, "After", row.capability);
    return;
  }

  const now = deps.now ?? Date.now, sleep = deps.sleep ?? defaultSleep, pollMs = deps.pollMs ?? DRILL_POLL_MS;
  if (cmd.batchId) {
    const status = await batchStatus(db, cmd.batchId);
    if (status === null) throw new RouteChangeError(`No batch ${cmd.batchId}.`);
    if (finished(status)) throw new RouteChangeError(`Batch ${cmd.batchId} is already ${status}; start the drill before or during the batch.`);
  }
  const preferred = await preferredModels(db, cmd.capability, cmd.batchId, deps.env ?? process.env);
  const before = await plan(db, cmd.capability, preferred.models);
  const first = before[0]?.id;
  const target = cmd.routeId ?? first;
  if (!target) throw new RouteChangeError(`${cmd.capability} has no serving route to turn off.`);
  deps.print(cmd.routeId
    ? `Drill target: ${target} (named in DRILL_ROUTE). Asked first for ${preferred.source}: ${first ?? "nothing"}${first === target ? "" : " (a different route)"}.`
    : `Drill target: ${target}, the route asked first for ${preferred.source}.`);
  await printRoutes(deps, "Before", cmd.capability);
  const runId = `drill:${cmd.capability}:${new Date(now()).toISOString()}`;
  const drill = await startDrill(db, cmd.capability, { minutes: cmd.minutes, routeId: target, changedBy: cmd.actor, reason: cmd.reason, runId });
  const during = await plan(db, cmd.capability, preferred.models);
  deps.print(`Drill ${drill.drillId} started: ${drill.route.id} is off until ${drill.restoreAt.toISOString()}${cmd.batchId ? ` or until batch ${cmd.batchId} finishes` : ""}.`);
  deps.print(`Serving instead: ${during[0]?.id ?? "no route"}${during.length > 1 ? `, then ${during.slice(1).map(r => r.id).join(", ")}` : ""}.`);
  await printRoutes(deps, "During", cmd.capability);

  let why = "drill time is up";
  for (;;) {
    if (deps.signal?.aborted) { why = "the drill job was stopped"; break; }
    if (now() >= drill.restoreAt.getTime()) break;
    if (cmd.batchId) {
      const status = await batchStatus(db, cmd.batchId);
      if (finished(status)) { why = `batch ${cmd.batchId} is ${status}`; break; }
    }
    await sleep(Math.max(0, Math.min(pollMs, drill.restoreAt.getTime() - now())), deps.signal);
  }
  const restored = await endDrill(db, drill.route.id, { changedBy: cmd.actor, reason: `kill-switch drill ${drill.drillId} ended: ${why}`, runId, drillId: drill.drillId });
  deps.print(restored ? `Drill ended (${why}): ${restored.id} is ${restored.state} again.` : `Drill ${drill.drillId} already ended on ${drill.route.id} (restored at expiry or by a manual change).`);
  await printRoutes(deps, "After", cmd.capability);
}
