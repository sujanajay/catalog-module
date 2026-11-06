// M6 decision C6: fills catalog_traffic_shifts from Cloud Audit Logs, the authority on when traffic moved. The deploy gate's
// record can be lost, and a hand move has none. Each deploy (the job catalog-traffic-shift with SHIFT_SYNC=1) and each daily
// cost check run this, so a missing record comes back with its real time, on any commit, even after its revision is replaced.
import { catalogTrafficShifts } from "../db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { recordTrafficShift, TRAFFIC_SHIFT_SERVICES } from "./reliability";

/** The end of migration 0028's seed. Moves before it are not filled in: outcomes of that time are not backfilled. */
export const TRAFFIC_SYNC_FLOOR_MS = Date.parse("2026-11-06T05:47:56Z");
export const TRAFFIC_SYNC_LOOKBACK_MS = 14 * 86_400_000;
/** The gate's time and the audit entry's differ by the length of the call: a record this close is the same move. */
export const SAME_SHIFT_MS = 10 * 60_000;

/** One accepted change of a service's traffic: the revisions with a share of it right after. */
export interface TrafficEntry { service: string; atMs: number; serving: string[] }
export type TrafficAudit = (from: Date, to: Date) => Promise<TrafficEntry[]>;
export type GooglePost = (url: string, body: unknown) => Promise<unknown>;

interface AuditLogEntry {
  timestamp?: string;
  resource?: { labels?: { service_name?: string } };
  protoPayload?: {
    status?: { code?: number };
    request?: { service?: { spec?: { traffic?: AuditTraffic[] }; traffic?: AuditTraffic[] } };
  };
}
/** v1 (`revisionName`, gcloud) and v2 (`revision`). A share "to the latest" names no revision and is left out. */
interface AuditTraffic { percent?: number; revisionName?: string; revision?: string }

/** A Cloud Run service update as a traffic entry; null for a refused call or one that names no serving revision. */
export function trafficEntryFrom(entry: AuditLogEntry): TrafficEntry | null {
  const service = entry.resource?.labels?.service_name, atMs = Date.parse(entry.timestamp ?? "");
  if (!service || Number.isNaN(atMs) || entry.protoPayload?.status?.code) return null;
  const request = entry.protoPayload?.request?.service;
  const serving = (request?.spec?.traffic ?? request?.traffic ?? []).filter((t) => (t.percent ?? 0) > 0).flatMap((t) => t.revisionName ?? t.revision ?? []);
  return serving.length ? { service, atMs, serving } : null;
}

export function googleTrafficAudit(post: GooglePost, project: string): TrafficAudit {
  return async (from, to) => {
    const filter = [
      `logName="projects/${project}/logs/cloudaudit.googleapis.com%2Factivity"`,
      `protoPayload.methodName=("google.cloud.run.v1.Services.ReplaceService" OR "google.cloud.run.v2.Services.UpdateService")`,
      `timestamp>="${from.toISOString()}"`, `timestamp<="${to.toISOString()}"`,
    ].join(" AND ");
    const out: TrafficEntry[] = [];
    let pageToken = "";
    do {
      const body = (await post("https://logging.googleapis.com/v2/entries:list", {
        resourceNames: [`projects/${project}`], filter, orderBy: "timestamp asc", pageSize: 1000, ...(pageToken ? { pageToken } : {}),
      })) as { entries?: AuditLogEntry[]; nextPageToken?: string };
      for (const entry of body.entries ?? []) { const e = trafficEntryFrom(entry); if (e) out.push(e); }
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
    return out;
  };
}

export interface TrafficSyncResult { recorded: string[]; unknownTime: string[] }

/**
 * Records each move in the audit log that has no record. A revision serving now with neither a record nor an audit entry
 * has an unknown time, so it gets a window, from the service's last record to now: batches in it read deploy_overlap
 * true, because they may have overlapped and a false would be a guess. A later audit entry replaces the window.
 * Throws when the audit log cannot be read; nothing is guessed then, and the callers report it.
 */
export async function syncTrafficShifts(db: Db, audit: TrafficAudit, resources: readonly { name: string; liveRevisions?: string[] }[], now: Date = new Date()): Promise<TrafficSyncResult> {
  const entries = await audit(new Date(Math.max(TRAFFIC_SYNC_FLOOR_MS, +now - TRAFFIC_SYNC_LOOKBACK_MS)), now);
  const stored = await db.select({ service: catalogTrafficShifts.service, revision: catalogTrafficShifts.revision, at: catalogTrafficShifts.shiftedAt, until: catalogTrafficShifts.shiftedUntil }).from(catalogTrafficShifts);
  const rows = stored.map((r) => ({ service: r.service, revision: r.revision, atMs: +r.at, windowed: r.until !== null }));
  const recorded: string[] = [];
  const serving = new Map<string, string[]>();
  for (const e of [...entries].sort((a, b) => a.atMs - b.atMs)) {
    if (!TRAFFIC_SHIFT_SERVICES.includes(e.service)) continue;
    // Before the first entry read, what served is the service's newest record then. Later entries restate it on every deploy.
    const before = serving.get(e.service) ?? rows.filter((r) => r.service === e.service && r.atMs <= e.atMs).sort((a, b) => b.atMs - a.atMs).slice(0, 1).map((r) => r.revision);
    for (const revision of e.serving) {
      if (before.includes(revision)) continue;
      if (rows.some((r) => r.revision === revision && !r.windowed && Math.abs(r.atMs - e.atMs) <= SAME_SHIFT_MS)) continue;
      await recordTrafficShift(db, { service: e.service, revision, at: new Date(e.atMs) });
      rows.push({ service: e.service, revision, atMs: e.atMs, windowed: false });
      recorded.push(revision);
    }
    serving.set(e.service, e.serving);
  }
  const unknownTime: string[] = [];
  for (const resource of resources) {
    if (!TRAFFIC_SHIFT_SERVICES.includes(resource.name)) continue;
    for (const revision of resource.liveRevisions ?? []) {
      const own = rows.filter((r) => r.revision === revision);
      if (own.some((r) => r.windowed) && own.some((r) => !r.windowed)) {
        await db.delete(catalogTrafficShifts).where(and(eq(catalogTrafficShifts.revision, revision), isNotNull(catalogTrafficShifts.shiftedUntil)));
      } else if (own.some((r) => r.windowed)) {
        unknownTime.push(revision);
      } else if (!own.length) {
        const last = Math.max(...rows.filter((r) => r.service === resource.name).map((r) => r.atMs));
        if (!Number.isFinite(last)) continue; // No record of this service at all: nothing bounds the time.
        await recordTrafficShift(db, { service: resource.name, revision, at: new Date(last), until: now });
        unknownTime.push(revision);
      }
    }
  }
  return { recorded, unknownTime };
}
