// M1-S4b upscaler outage deadline (docs/program/requirements/M1-intake.md D13, design .runs/2026-11-04-outage-deadline-plan.md).
// One health ledger per upscaler service (catalog_upscaler_health, GPU and CPU), fed by every health probe and every
// call the service answered, holding two stamps: `healthy_at` (the latest proof that the service works) and
// `unhealthy_since` (the first symptom after that proof). An outage is "no proof of health since `unhealthy_since`".
// - Proofs of health: a /health probe answering `ok` or `busy` (429: every instance is working), and a call the
//   service answered (a 200 reply, valid or not, or a 429 from a full fleet).
// - Symptoms: a probe answering `absent`, `timeout`, `no_instance` or anything else (`unknown`: a 404 of a deleted
//   service, a 403 of a broken identity). Symptoms come only from probes; every other failure proves nothing here
//   (spec 18 counts it per photo).
// - Every observation is stamped with the moment its request was sent, so a call accepted before a stop and answered
//   after it never ends an outage, and a symptom older than the latest proof never starts one.
// The sweep (every 10 minutes) probes each service a photo waits on (assessUpscalerOutages); a service is in outage
// when `unhealthy_since` is set and the sweep's own probe is still not a proof. Then:
// - the outage deadline (applyOutageDeadline): in an auto-decide batch (M1-S3) whose deadline
//   (`intake.outage_deadline_hours` from its settings snapshot, default 6, 0 means never) has passed since
//   `unhealthy_since`, every waiting enlargement of that service fails (`outage_deadline`), so the render delivers the
//   plain image `provisional` and M1-S4's improvement re-enlarges it later at the same URL. Spec 18's "time is never a
//   limit" (I8) is amended for auto-decide batches only, after the deadline, only during an outage as defined here;
// - the incidents (syncOutageIncidents, kind `upscaler_outage`): `service_down` per service and `enlarge_wait` per
//   batch waiting on it, opened once the outage is STALL_INCIDENT_MS old and resolved when it ends, plus one
//   `outage_deadline` event per batch the deadline finished.
// Saturation (429), a backlog, a scale-up and a flapping service never trip it; a clean stop, a hung or deleted service
// and a region that can start no instance (a GPU stockout, owner decision 2026-11-04) do.
import { and, eq, inArray, isNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogBatches, catalogEnlargements, catalogIncidents, catalogUpscalerHealth, type UpscalerService } from "../db/schema";
import { settingDef } from "../settings/registry";
import { settingFrom } from "../settings/snapshot";
import { loadSettingsSnapshot } from "../settings/store";
import { enqueueChunk, isBulkBatch } from "./pipeline/dispatch";
import { ENLARGE_CLAIM_MS, lockProductChunks, unparkSettledChunks } from "./pipeline/enlargement";
import { autoDecideOf } from "./auto-decide";
import { isCpuUpscalerId, upscalerFactor } from "./upscale";
import type { UpscaleProbe } from "./enlarge";
import { openIncident, resolveIncidents } from "./reliability";
import type { enqueueTask } from "../tasks";

/** The setting that holds the deadline in hours (M12 registry); 0 means wait without limit. */
export const OUTAGE_DEADLINE_KEY = "intake.outage_deadline_hours";
/** An outage this old opens its incidents (the stall threshold of M6-F3: 10 minutes without progress). */
export const STALL_INCIDENT_MS = 10 * 60_000;
/** `error_kind` of an enlargement the deadline failed. */
export const OUTAGE_DEADLINE_ERROR_KIND = "outage_deadline";
/** catalog_incidents.cause_code of the three upscaler_outage incidents. */
export const OUTAGE_CAUSES = { serviceDown: "service_down", enlargeWait: "enlarge_wait", deadline: "outage_deadline" } as const;

/** What one observation is about the service. */
export type UpscalerObservation = UpscaleProbe | "call_ok" | "call_busy";
export type ObservationClass = "health" | "unhealthy";

/** The service an upscaler id runs on: `+cpu` ids on the CPU service, every other id on the shared GPU service. */
export function serviceOf(upscalerId: string): UpscalerService {
  return isCpuUpscalerId(upscalerId) ? "cpu" : "gpu";
}
/** SQL: the enlargement row's upscaler runs on `service`. */
export function onService(service: UpscalerService): SQL {
  return service === "cpu" ? sql`${catalogEnlargements.upscaler} LIKE '%+cpu'` : sql`${catalogEnlargements.upscaler} NOT LIKE '%+cpu'`;
}
/** A proof of health (`ok`, `busy`, an answered call) or a symptom (any other probe answer). */
export function observationClass(kind: UpscalerObservation): ObservationClass {
  return kind === "ok" || kind === "busy" || kind === "call_ok" || kind === "call_busy" ? "health" : "unhealthy";
}

/**
 * Records one observation, stamped `at` (its request start). Two atomic upserts, no read-modify-write:
 * - a proof moves `healthy_at` forward (it never goes back) and clears `unhealthy_since` only when the proof is newer
 *   than the outage's start (a call accepted before a stop and answered after it does not end the outage);
 * - a symptom sets `unhealthy_since` only when none is set and it is newer than the latest proof (a stale symptom never
 *   starts an outage); a running outage keeps its start.
 * `upscaler` is kept for the sweep's probe of a service no photo waits on.
 */
export async function recordUpscalerObservation(db: Pick<Db, "insert">, input: { service: UpscalerService; kind: UpscalerObservation; at: Date; upscaler: string }, now: Date = input.at): Promise<void> {
  const h = catalogUpscalerHealth, at = input.at, probe = input.kind === "call_ok" || input.kind === "call_busy" ? null : input.kind;
  const source = probe ? "probe" : "call";
  const probeSet = probe ? { lastProbe: sql`CASE WHEN ${h.lastProbeAt} IS NULL OR ${h.lastProbeAt} <= ${at.toISOString()}::timestamptz THEN ${probe}::text ELSE ${h.lastProbe} END`, lastProbeAt: sql`GREATEST(${h.lastProbeAt}, ${at.toISOString()}::timestamptz)` } : {};
  if (observationClass(input.kind) === "health") {
    await db.insert(h).values({ service: input.service, healthyAt: at, unhealthySince: null, lastProbe: probe, lastProbeAt: probe ? at : null, lastSource: source, lastUpscaler: input.upscaler, updatedAt: now })
      .onConflictDoUpdate({ target: h.service, set: {
        healthyAt: sql`GREATEST(${h.healthyAt}, ${at.toISOString()}::timestamptz)`,
        unhealthySince: sql`CASE WHEN ${h.unhealthySince} IS NOT NULL AND ${at.toISOString()}::timestamptz > ${h.unhealthySince} THEN NULL ELSE ${h.unhealthySince} END`,
        ...probeSet, lastSource: source, lastUpscaler: input.upscaler, updatedAt: now,
      } });
    return;
  }
  await db.insert(h).values({ service: input.service, healthyAt: null, unhealthySince: at, lastProbe: probe, lastProbeAt: at, lastSource: source, lastUpscaler: input.upscaler, updatedAt: now })
    .onConflictDoUpdate({ target: h.service, set: {
      unhealthySince: sql`CASE WHEN ${h.unhealthySince} IS NULL AND (${h.healthyAt} IS NULL OR ${at.toISOString()}::timestamptz > ${h.healthyAt}) THEN ${at.toISOString()}::timestamptz ELSE ${h.unhealthySince} END`,
      ...probeSet, lastSource: source, lastUpscaler: input.upscaler, updatedAt: now,
    } });
}

export type UpscalerHealth = typeof catalogUpscalerHealth.$inferSelect;
export async function readUpscalerHealth(db: Pick<Db, "select">): Promise<UpscalerHealth[]> {
  return db.select().from(catalogUpscalerHealth);
}

/** The probe the sweep makes: the worker's /health probe of the service an upscaler id runs on. */
export type OutageProbe = (upscaler: string, opts?: { timeoutMs?: number }) => Promise<UpscaleProbe>;
/** One service as the sweep found it. `outage`: `unhealthy_since` is set and this sweep's probe is not a proof. */
export interface ServiceAssessment { service: UpscalerService; probe: UpscaleProbe; since: Date | null; outage: boolean }
export interface OutageAssessment { services: ServiceAssessment[]; at: Date }

/** A live batch: not draft, failed or cancelled (a done batch may wait again: an improvement or a Try again). */
const liveBatch = (): SQL => notInArray(catalogBatches.status, ["draft", "failed", "cancelled"]);
/** A row a photo waits on: wanted and queued. */
const waiting = (): SQL => and(eq(catalogEnlargements.wanted, true), eq(catalogEnlargements.status, "queued"))!;

/**
 * The sweep's probe pass: the services some live batch's photos wait on, plus every service whose ledger shows an
 * outage (so an outage that ended while nothing waited is still closed). Each is probed once, all at once (the sweep's
 * worst case is one probe timeout), with an upscaler id a photo waits on (the x2 one when there is one) or the ledger's
 * last one. A probe that throws counts as `unknown`. Each answer is recorded as an observation stamped at its start.
 */
export async function assessUpscalerOutages(db: Db, probe: OutageProbe, clock: () => Date, log: (message: string, fields?: Record<string, unknown>) => void = () => undefined): Promise<OutageAssessment> {
  const rows = await db.selectDistinct({ upscaler: catalogEnlargements.upscaler }).from(catalogEnlargements)
    .innerJoin(catalogBatches, eq(catalogBatches.id, catalogEnlargements.batchId)).where(and(waiting(), liveBatch()));
  const pick = new Map<UpscalerService, string>();
  for (const { upscaler } of [...rows].sort((a, b) => upscalerFactor(a.upscaler) - upscalerFactor(b.upscaler) || a.upscaler.localeCompare(b.upscaler))) {
    if (!pick.has(serviceOf(upscaler))) pick.set(serviceOf(upscaler), upscaler);
  }
  for (const row of await readUpscalerHealth(db)) {
    if (row.unhealthySince && row.lastUpscaler && !pick.has(row.service)) pick.set(row.service, row.lastUpscaler);
  }
  const answers = await Promise.all([...pick].map(async ([service, upscaler]) => {
    const at = clock();
    let answer: UpscaleProbe;
    try { answer = await probe(upscaler); } catch { answer = "unknown"; }
    try { await recordUpscalerObservation(db, { service, kind: answer, at, upscaler }, clock()); }
    catch (error) { log("upscaler health not recorded", { severity: "WARNING", service, probe: answer, error: error instanceof Error ? error.message : String(error) }); }
    return { service, probe: answer };
  }));
  const state = new Map((await readUpscalerHealth(db)).map((r) => [r.service, r]));
  const services = answers.map(({ service, probe: answer }): ServiceAssessment => {
    const since = state.get(service)?.unhealthySince ?? null;
    return { service, probe: answer, since, outage: !!since && observationClass(answer) === "unhealthy" };
  });
  for (const s of services) if (s.outage) log("upscaler outage", { severity: "WARNING", service: s.service, since: s.since!.toISOString(), probe: s.probe, minutes: Math.round((+clock() - +s.since!) / 60_000) });
  return { services, at: clock() };
}

/** The deadline sentence a failed photo keeps (model-free). */
export function outageDeadlineSentence(hours: number): string {
  return `The enlargement service could not be reached for ${hours} ${hours === 1 ? "hour" : "hours"}, so this photo was delivered without enlargement.`;
}

/**
 * A batch's deadline in hours from its settings snapshot (M12 rule: changes apply from the next batch); a batch with
 * no snapshot, or a snapshot taken before the setting existed, gets the registry default. 0 means never.
 */
export async function deadlineHoursFor(db: Db, batch: { settingsSnapshotId: string | null }, cache: Map<string, number> = new Map()): Promise<number> {
  const fallback = Number(settingDef(OUTAGE_DEADLINE_KEY)?.default ?? 0);
  if (!batch.settingsSnapshotId) return fallback;
  const cached = cache.get(batch.settingsSnapshotId);
  if (cached !== undefined) return cached;
  const snapshot = await loadSettingsSnapshot(db, batch.settingsSnapshotId);
  const hours = snapshot ? Number(settingFrom<number>(snapshot, OUTAGE_DEADLINE_KEY)) : fallback;
  cache.set(batch.settingsSnapshotId, hours);
  return hours;
}

/** One batch the deadline finished. */
export interface DeadlineFailure { batchId: string; service: UpscalerService; rows: number; since: Date; hours: number }

/**
 * The outage deadline for every service in outage: in each live auto-decide batch with photos waiting on the service
 * whose deadline has passed since the outage began, every waiting row of that service without a live claim fails
 * (`outage_deadline`), per product under the settle's lock order (the product's chunks by id, then the rows), and the
 * chunks with nothing left to wait for are unparked in the same transaction (a batch that is not processing gets its
 * chunks sent directly; a processing batch's window, which the sweep tops up next, picks them up). A row held by a
 * live delivery is left to it. Batches started before M1-S3 (no auto-decide copy) keep spec 18's wait. Writes one
 * `outage_deadline` incident per batch. Returns the batches it finished.
 */
export async function applyOutageDeadline(db: Db, enqueue: typeof enqueueTask, assessment: OutageAssessment, now: Date, log: (message: string, fields?: Record<string, unknown>) => void = () => undefined): Promise<DeadlineFailure[]> {
  const out: DeadlineFailure[] = [], cache = new Map<string, number>();
  for (const s of assessment.services) {
    if (!s.outage || !s.since) continue;
    const batches = await db.selectDistinct({ id: catalogBatches.id, options: catalogBatches.options, settingsSnapshotId: catalogBatches.settingsSnapshotId, isTest: catalogBatches.isTest, name: catalogBatches.name, counts: catalogBatches.counts })
      .from(catalogBatches).innerJoin(catalogEnlargements, eq(catalogEnlargements.batchId, catalogBatches.id))
      .where(and(liveBatch(), waiting(), onService(s.service)));
    for (const batch of batches) {
      if (!autoDecideOf(batch.options)) continue;
      const hours = await deadlineHoursFor(db, batch, cache);
      if (!(hours > 0) || +now - +s.since < hours * 3_600_000) continue;
      const rows = await failWaitingRows(db, enqueue, { batchId: batch.id, service: s.service, hours, bulk: isBulkBatch(batch) }, now, log);
      if (!rows) continue;
      out.push({ batchId: batch.id, service: s.service, rows, since: s.since, hours });
      log("enlargement outage deadline", { severity: "WARNING", batchId: batch.id, service: s.service, rows, since: s.since.toISOString(), hours });
      await openIncident(db, { kind: "upscaler_outage", severity: "warning", batchId: batch.id, causeCode: OUTAGE_CAUSES.deadline, cause: `Photos waited ${hours} ${hours === 1 ? "hour" : "hours"} for the enlargement service and were delivered without enlargement.`, startedAt: s.since, resolvedAt: now, dedupeKey: `upscaler_outage:${OUTAGE_CAUSES.deadline}:${batch.id}:${+s.since}`, detail: { service: s.service, rows, hours } });
    }
  }
  return out;
}

/** The fail of one batch's waiting rows of one service, product by product. Returns the rows failed. */
async function failWaitingRows(db: Db, enqueue: typeof enqueueTask, input: { batchId: string; service: UpscalerService; hours: number; bulk: boolean }, now: Date, log: (message: string, fields?: Record<string, unknown>) => void): Promise<number> {
  const unclaimed = or(isNull(catalogEnlargements.claimedAt), lt(catalogEnlargements.claimedAt, new Date(+now - ENLARGE_CLAIM_MS)))!;
  const scope = and(eq(catalogEnlargements.batchId, input.batchId), waiting(), onService(input.service), unclaimed)!;
  const products = await db.selectDistinct({ productId: catalogEnlargements.productId }).from(catalogEnlargements).where(scope);
  const sentence = outageDeadlineSentence(input.hours);
  let failed = 0;
  for (const { productId } of products) {
    const { rows, unparked } = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const chunks = await lockProductChunks(t, input.batchId, productId);
      const rows = await t.update(catalogEnlargements).set({ status: "failed", error: sentence, errorKind: OUTAGE_DEADLINE_ERROR_KIND, claimedAt: null, claimToken: null, updatedAt: now })
        .where(and(scope, eq(catalogEnlargements.productId, productId))).returning({ id: catalogEnlargements.id });
      return { rows: rows.length, unparked: await unparkSettledChunks(t, input.batchId, chunks, now) };
    });
    failed += rows;
    for (const chunk of unparked) {
      log("chunk enlarged", { batchId: input.batchId, chunkId: chunk.id, direct: chunk.direct, reason: OUTAGE_DEADLINE_ERROR_KIND });
      if (!chunk.direct) continue;
      // A failed send leaves dispatched_at set: the sweep's lost-task rule sends it (F60).
      try { await enqueueChunk(enqueue, chunk, {}, input.bulk); }
      catch (error) { log("chunk dispatch failed", { severity: "WARNING", batchId: input.batchId, chunkId: chunk.id, error: error instanceof Error ? error.message : String(error) }); }
    }
  }
  return failed;
}

/**
 * The upscaler_outage incidents for this sweep's assessment. While a service has been in outage for STALL_INCIDENT_MS:
 * one `service_down` incident (no batch) and one `enlarge_wait` incident per live batch with photos waiting on it
 * (the batch's stall), each started at `unhealthy_since` and keyed by it, so one outage is one incident however many
 * sweeps see it. Every open `service_down` or `enlarge_wait` incident this sweep does not find is resolved now: the
 * service answered again, or the batch no longer waits (its photos were made, or the deadline delivered them).
 */
export async function syncOutageIncidents(db: Db, assessment: OutageAssessment, now: Date): Promise<{ opened: number; resolved: number }> {
  const current = new Set<string>();
  let opened = 0;
  for (const s of assessment.services) {
    if (!s.outage || !s.since || +now - +s.since < STALL_INCIDENT_MS) continue;
    const key = `upscaler_outage:${OUTAGE_CAUSES.serviceDown}:${s.service}:${+s.since}`;
    current.add(key);
    if (await openIncident(db, { kind: "upscaler_outage", severity: "error", batchId: null, causeCode: OUTAGE_CAUSES.serviceDown, cause: "The enlargement service is not answering.", startedAt: s.since, dedupeKey: key, detail: { service: s.service, lastProbe: s.probe } })) opened++;
    const batches = await db.selectDistinct({ id: catalogBatches.id }).from(catalogBatches).innerJoin(catalogEnlargements, eq(catalogEnlargements.batchId, catalogBatches.id))
      .where(and(liveBatch(), waiting(), onService(s.service)));
    for (const b of batches) {
      const waitKey = `upscaler_outage:${OUTAGE_CAUSES.enlargeWait}:${b.id}:${s.service}:${+s.since}`;
      current.add(waitKey);
      if (await openIncident(db, { kind: "upscaler_outage", severity: "warning", batchId: b.id, causeCode: OUTAGE_CAUSES.enlargeWait, cause: "Photos are waiting because the enlargement service is not answering.", startedAt: s.since, dedupeKey: waitKey, detail: { service: s.service } })) opened++;
    }
  }
  const open = await db.select({ id: catalogIncidents.id, key: catalogIncidents.dedupeKey }).from(catalogIncidents)
    .where(and(eq(catalogIncidents.kind, "upscaler_outage"), inArray(catalogIncidents.causeCode, [OUTAGE_CAUSES.serviceDown, OUTAGE_CAUSES.enlargeWait]), isNull(catalogIncidents.resolvedAt)));
  const resolved = await resolveIncidents(db, open.filter((o) => !current.has(o.key)).map((o) => o.id), now);
  return { opened, resolved };
}
