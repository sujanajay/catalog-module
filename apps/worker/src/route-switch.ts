// The operator surface of the route kill switch (M7-F2-R5, R1 exit item 3), run by the Cloud Run job
// catalog-route-switch (catalog-route-switch.ts, infra/catalog-route-switch.sh):
//   show   print the route table
//   set    set one route to off or serving, logged in vendor_route_changes with the reason and who asked
//   drill  turn route 1 of a capability off, then restore it when the given batch finishes or the minutes run out,
//          whichever is first. The expiry is stored on the route (restore_at), so the router restores it even when
//          this job is stopped; the job's own restore is the early end.
// Every command prints the routes of the capability before and after. Route ids are internal and reach only this
// job's log, never operator UI text (M7-F2-R6).
import { eq } from "drizzle-orm";
import type { Db } from "@catalog/core/db/client";
import { catalogBatches, type VendorRouteRow } from "@catalog/core/db/schema";
import { endDrill, loadRouteRows, RouteChangeError, setRoute, startDrill } from "@catalog/core/vendor/route-table";
import { CAPABILITIES, type Capability } from "@catalog/core/vendor/routes";

/** The states this surface sets; the other states belong to the harness (M7-F6). */
export const SWITCH_STATES = ["off", "serving"] as const;
export type SwitchState = (typeof SWITCH_STATES)[number];
/** A batch in one of these is finished, so the drill tied to it ends. */
export const FINISHED_BATCH_STATUSES = ["done", "failed", "cancelled"] as const;
/** How often a running drill looks at its batch and its expiry. */
export const DRILL_POLL_MS = 30_000;

export type RouteSwitchCommand =
  | { command: "show"; capability?: Capability }
  | { command: "set"; routeId: string; state: SwitchState; reason: string; actor: string }
  | { command: "drill"; capability: Capability; minutes: number; batchId?: string; reason: string; actor: string };

export interface RouteSwitchDeps {
  db: Db;
  print: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Aborted when the job is told to stop (SIGTERM): a running drill restores route 1 at once. */
  signal?: AbortSignal;
  pollMs?: number;
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
    return { command, routeId, state, reason, actor };
  }
  if (command === "drill") {
    const capability = get("DRILL_CAPABILITY"), minutes = Number(get("DRILL_MINUTES")), batchId = get("DRILL_BATCH");
    if (!isCapability(capability)) throw new RouteChangeError(`DRILL_CAPABILITY must be one of ${CAPABILITIES.join(", ")}.`);
    if (batchId && !UUID.test(batchId)) throw new RouteChangeError("DRILL_BATCH must be a batch id.");
    needWhoWhy();
    return { command, capability, minutes, ...(batchId ? { batchId } : {}), reason, actor };
  }
  throw new RouteChangeError(`ROUTE_COMMAND must be show, set or drill (got ${command}).`);
}

function routeLine(row: VendorRouteRow & { drillExpired: boolean }): string {
  const drill = row.restoreAt ? ` (drill: back to ${row.restoreState} at ${row.restoreAt.toISOString()}${row.drillExpired ? ", expired" : ""})` : "";
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

/** Run one command. Throws RouteChangeError for a refused change (nothing is written then). */
export async function runRouteSwitch(cmd: RouteSwitchCommand, deps: RouteSwitchDeps): Promise<void> {
  const { db } = deps;
  if (cmd.command === "show") return printRoutes(deps, "Routes", cmd.capability);

  if (cmd.command === "set") {
    const [row] = (await loadRouteRows(db)).filter(r => r.id === cmd.routeId);
    if (!row) throw new RouteChangeError(`No route ${cmd.routeId}.`);
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
  await printRoutes(deps, "Before", cmd.capability);
  const runId = `drill:${cmd.capability}:${new Date(now()).toISOString()}`;
  const drill = await startDrill(db, cmd.capability, { minutes: cmd.minutes, changedBy: cmd.actor, reason: cmd.reason, runId });
  deps.print(`Drill started: ${drill.route.id} is off until ${drill.restoreAt.toISOString()}${cmd.batchId ? ` or until batch ${cmd.batchId} finishes` : ""}.`);
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
  const restored = await endDrill(db, drill.route.id, { changedBy: cmd.actor, reason: `kill-switch drill ended: ${why}`, runId });
  deps.print(restored ? `Drill ended (${why}): ${restored.id} is ${restored.state} again.` : `Drill already ended on ${drill.route.id} (restored at expiry or by a manual change).`);
  await printRoutes(deps, "After", cmd.capability);
}
