// M0 catalog graph contract (docs/program/requirements/M0-catalog-graph.md 3.4), slice M0-S1: assets, content
// versions, the change log with its read cursor, liveAt and the experiment guard. Every write is idempotent and runs
// inside the caller's transaction when it is given one (pass the transaction as `db`). No write calls another module.
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  catalogAssets,
  catalogChangeEvents,
  catalogChannelListings,
  catalogContentVersions,
  catalogLiveIntervals,
  catalogTreatmentAssignments,
  type CatalogChangeEvent,
} from "../db/schema";
import {
  GUARDED_KINDS,
  type ChangeKind,
  type Component,
  type EvidenceKind,
  type HashKind,
  type ImageRole,
  type Language,
  type LiveState,
  type Market,
  type ReasonKind,
  type Slot,
  type VersionScope,
  type VersionSource,
} from "./types";

export * from "./types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A database handle or an open transaction; writes join the transaction when one is given. */
export type GraphDb = Db | Tx;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const UINT64_MAX = (1n << 64n) - 1n;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** recordChange refused a planned or links_delivered event on a frozen listing (F3-R7). */
export class ListingFrozenError extends Error {
  constructor(
    readonly listingId: string,
    readonly reason: "frozen_control" | "frozen_treatment",
    readonly experimentId: string,
  ) {
    super(`Listing ${listingId} is not writable: ${reason} (experiment ${experimentId})`);
    this.name = "ListingFrozenError";
  }
}

/** The same idempotency key was sent with a different event (a caller bug, never a retry). */
export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} already names a different change event`);
    this.name = "IdempotencyConflictError";
  }
}

// ---------------------------------------------------------------------------
// Hashes
// ---------------------------------------------------------------------------

/** sha256 hex of bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** content_hash of a text version: sha256 of the text in Unicode NFC with outer whitespace trimmed. */
export function textContentHash(text: string): string {
  return createHash("sha256").update(text.normalize("NFC").trim(), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type NewAsset = {
  sha256: string;
  uri: string;
  mime: string;
  width?: number | null;
  height?: number | null;
  bytes?: number | null;
  /** The 64-bit perceptual hash as an unsigned value (0 to 2^64 - 1). */
  phash?: bigint | null;
  orgId?: string;
};

/** Stored phash (signed bigint column) from the unsigned 64-bit value, and back. */
export const phashToDb = (p: bigint): bigint => {
  if (p < 0n || p > UINT64_MAX) throw new Error("phash must be an unsigned 64-bit value");
  return BigInt.asIntN(64, p);
};
export const phashFromDb = (p: bigint): bigint => BigInt.asUintN(64, p);

/** Records one binary by its sha256. A second call with the same sha256 changes nothing (`created: false`). */
export async function recordAsset(db: GraphDb, a: NewAsset): Promise<{ sha256: string; created: boolean }> {
  if (!SHA256_HEX.test(a.sha256)) throw new Error("recordAsset: sha256 must be 64 lowercase hex characters");
  const inserted = await db
    .insert(catalogAssets)
    .values({
      sha256: a.sha256,
      uri: a.uri,
      mime: a.mime,
      width: a.width ?? null,
      height: a.height ?? null,
      bytes: a.bytes ?? null,
      phash: a.phash == null ? null : phashToDb(a.phash),
      ...(a.orgId ? { orgId: a.orgId } : {}),
    })
    .onConflictDoNothing({ target: catalogAssets.sha256 })
    .returning({ sha256: catalogAssets.sha256 });
  return { sha256: a.sha256, created: inserted.length > 0 };
}

// ---------------------------------------------------------------------------
// Content versions
// ---------------------------------------------------------------------------

export type NewContentVersion = {
  optionId: string | null;
  scope: VersionScope;
  component: Component;
  role?: ImageRole | null;
  position?: number | null;
  source: VersionSource;
  /** Never inferred: the producer says whether a model made it (F2-R4). */
  aiGenerated: boolean;
  /** Module id (M0 to M12) or `backfill`. */
  producer: string;
  producerRef?: string | null;
  /** Exactly one payload, except a crc32c backfill row whose object is gone. */
  assetSha256?: string | null;
  textValue?: string | null;
  jsonValue?: unknown;
  /** Defaults to the asset sha256, or textContentHash of the text. Required for a JSON payload or a crc32c row. */
  contentHash?: string;
  hashKind?: HashKind;
  parentVersionIds?: string[];
  publicUrl?: string | null;
  language?: Language | null;
  market?: Market | null;
  routeId?: string | null;
  promptVersion?: string | null;
  settingsSnapshotId?: string | null;
  batchId?: string | null;
  isTest?: boolean;
  createdBy: string;
  orgId?: string;
};

function contentHashOf(v: NewContentVersion): string {
  if (v.contentHash) return v.contentHash;
  if (v.assetSha256) return v.assetSha256;
  if (v.textValue != null) return textContentHash(v.textValue);
  throw new Error("recordVersion: contentHash is required for a JSON payload or a version without one");
}

/**
 * Records one immutable version. Deduped on (option, scope, component, content hash, producer, producer ref), nulls
 * equal: recording the same content again from the same producer returns the first id with `created: false` (F2-R6).
 */
export async function recordVersion(db: GraphDb, v: NewContentVersion): Promise<{ versionId: string; created: boolean }> {
  if (typeof v.aiGenerated !== "boolean") throw new Error("recordVersion: aiGenerated is required");
  if (v.assetSha256 != null && !SHA256_HEX.test(v.assetSha256)) throw new Error("recordVersion: assetSha256 must be 64 lowercase hex characters");
  const contentHash = contentHashOf(v);
  const producerRef = v.producerRef ?? null;
  const inserted = await db
    .insert(catalogContentVersions)
    .values({
      optionId: v.optionId,
      scope: v.scope,
      component: v.component,
      role: v.role ?? null,
      position: v.position ?? null,
      source: v.source,
      aiGenerated: v.aiGenerated,
      producer: v.producer,
      producerRef,
      assetSha256: v.assetSha256 ?? null,
      textValue: v.textValue ?? null,
      jsonValue: v.jsonValue === undefined ? null : v.jsonValue,
      contentHash,
      hashKind: v.hashKind ?? "sha256",
      parentVersionIds: v.parentVersionIds ?? [],
      publicUrl: v.publicUrl ?? null,
      language: v.language ?? null,
      market: v.market ?? null,
      routeId: v.routeId ?? null,
      promptVersion: v.promptVersion ?? null,
      settingsSnapshotId: v.settingsSnapshotId ?? null,
      batchId: v.batchId ?? null,
      isTest: v.isTest ?? false,
      createdBy: v.createdBy,
      ...(v.orgId ? { orgId: v.orgId } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: catalogContentVersions.id });
  if (inserted[0]) return { versionId: inserted[0].id, created: true };
  const same = (col: SQL | typeof catalogContentVersions.optionId | typeof catalogContentVersions.producerRef, value: string | null) =>
    sql`${col} IS NOT DISTINCT FROM ${value}`;
  const [existing] = await db
    .select({ id: catalogContentVersions.id })
    .from(catalogContentVersions)
    .where(
      and(
        same(catalogContentVersions.optionId, v.optionId),
        eq(catalogContentVersions.scope, v.scope),
        eq(catalogContentVersions.component, v.component),
        eq(catalogContentVersions.contentHash, contentHash),
        eq(catalogContentVersions.producer, v.producer),
        same(catalogContentVersions.producerRef, producerRef),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("recordVersion: insert conflicted but no matching version was found");
  return { versionId: existing.id, created: false };
}

// ---------------------------------------------------------------------------
// Guard (experiments)
// ---------------------------------------------------------------------------

export type WritableResult = { ok: true } | { ok: false; reason: "frozen_control" | "frozen_treatment"; experimentId: string };

/**
 * Whether content may be put on a listing (F3-R7). A listing with an unreleased do_not_touch assignment is a frozen
 * control and takes nothing. A listing in a running experiment's treatment arm (frozen, not released) takes only
 * changes that carry that experiment's id.
 */
export async function isWritable(db: GraphDb, listingId: string, ctx: { experimentId?: string } = {}): Promise<WritableResult> {
  const t = catalogTreatmentAssignments;
  const rows = await db
    .select({ experimentId: t.experimentId, arm: t.arm, doNotTouch: t.doNotTouch, frozenAt: t.frozenAt })
    .from(t)
    .where(and(eq(t.listingId, listingId), isNull(t.releasedAt)))
    .orderBy(asc(t.assignedAt), asc(t.experimentId));
  const control = rows.find((r) => r.doNotTouch);
  if (control) return { ok: false, reason: "frozen_control", experimentId: control.experimentId };
  const now = Date.now();
  const treated = rows.find((r) => r.arm === "treatment" && r.frozenAt != null && r.frozenAt.getTime() <= now && r.experimentId !== ctx.experimentId);
  if (treated) return { ok: false, reason: "frozen_treatment", experimentId: treated.experimentId };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Change log
// ---------------------------------------------------------------------------

export type NewChangeEvent = {
  /** Required: a retry with the same key returns the first event (for example `publish:<output_id>`). */
  idempotencyKey: string;
  listingId: string;
  slot: Slot;
  fromVersionId?: string | null;
  /** Null only for `removed` (the slot was emptied). */
  toVersionId: string | null;
  kind: ChangeKind;
  /** When it happened, not when it was written. */
  at: Date;
  evidence: EvidenceKind;
  evidenceRef?: string | null;
  actor: string;
  /** Required except on observed_other events and backfill rows (F3-R9, D9). */
  reasonKind?: ReasonKind | null;
  reasonRef?: string | null;
  /** Required except on observed_other events and backfill rows (F3-R9, D9). */
  changeTypeId?: string | null;
  changeSetId?: string | null;
  batchId?: string | null;
  experimentId?: string | null;
  orgId?: string;
};

export type ChangeEvent = CatalogChangeEvent;

/**
 * Advisory lock namespace of the change-log read cursor. A writer holds a shared transaction lock (NS, floor) where
 * floor is at most the first seq its transaction takes; readChanges stops below the lowest floor still held, so a
 * consumer that stores its last seq never skips an event that commits after a higher one.
 */
export const CHANGE_CURSOR_LOCK_NS = 0x4d30; // "M0"
const INT4_MAX = 2_147_483_647;

type ExecRows<T> = { rows: T[] };
async function rowsOf<T>(db: GraphDb, q: SQL): Promise<T[]> {
  return ((await db.execute(q)) as unknown as ExecRows<T>).rows;
}

/** Takes this transaction's cursor floor lock once, before its first seq is drawn. */
async function holdCursorFloor(tx: GraphDb): Promise<void> {
  const [held] = await rowsOf<{ held: boolean }>(
    tx,
    sql`select exists(select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid = ${CHANGE_CURSOR_LOCK_NS} and objsubid = 2) as held`,
  );
  if (held?.held) return;
  // last_value is not transactional: every seq drawn after this read is above it.
  const [last] = await rowsOf<{ last_value: string | number }>(tx, sql.raw(`select last_value from catalog_change_events_seq_seq`));
  const floor = Number(last?.last_value ?? 1);
  if (!Number.isSafeInteger(floor) || floor > INT4_MAX) throw new Error("Change-log seq passed the cursor lock range; widen CHANGE_CURSOR_LOCK_NS keys");
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${CHANGE_CURSOR_LOCK_NS}::int, ${floor}::int)`);
}

function sameEvent(row: CatalogChangeEvent, e: NewChangeEvent): boolean {
  return row.listingId === e.listingId && row.slot === e.slot && row.kind === e.kind && (row.toVersionId ?? null) === (e.toVersionId ?? null);
}

/**
 * Appends one change event, idempotent on `idempotencyKey`: a retry returns the first event (`created: false`); the
 * same key with a different listing, slot, kind or version throws IdempotencyConflictError. A planned or
 * links_delivered event on a frozen listing throws ListingFrozenError and writes nothing (F3-R7).
 */
export async function recordChange(db: GraphDb, e: NewChangeEvent): Promise<{ seq: bigint; created: boolean }> {
  if (!e.idempotencyKey?.trim()) throw new Error("recordChange: idempotencyKey is required");
  const exempt = e.kind === "observed_other" || e.evidence === "backfill" || e.reasonKind === "backfill";
  if (!exempt && !e.reasonKind) throw new Error("recordChange: reasonKind is required except on observed_other events and backfill rows");
  if (!exempt && !e.changeTypeId) throw new Error("recordChange: changeTypeId is required except on observed_other events and backfill rows");
  const existing = async (tx: GraphDb) =>
    (await tx.select().from(catalogChangeEvents).where(eq(catalogChangeEvents.idempotencyKey, e.idempotencyKey)).limit(1))[0];
  const settle = (row: CatalogChangeEvent) => {
    if (!sameEvent(row, e)) throw new IdempotencyConflictError(e.idempotencyKey);
    return { seq: row.seq, created: false };
  };

  return db.transaction(async (tx) => {
    const before = await existing(tx);
    if (before) return settle(before);
    if ((GUARDED_KINDS as readonly string[]).includes(e.kind)) {
      // Holds the listing against a concurrent assignment change until this event commits.
      await tx.select({ id: catalogChannelListings.id }).from(catalogChannelListings).where(eq(catalogChannelListings.id, e.listingId)).for("key share");
      const w = await isWritable(tx, e.listingId, { experimentId: e.experimentId ?? undefined });
      if (!w.ok) throw new ListingFrozenError(e.listingId, w.reason, w.experimentId);
    }
    await holdCursorFloor(tx);
    const inserted = await tx
      .insert(catalogChangeEvents)
      .values({
        idempotencyKey: e.idempotencyKey,
        listingId: e.listingId,
        slot: e.slot,
        fromVersionId: e.fromVersionId ?? null,
        toVersionId: e.toVersionId,
        kind: e.kind,
        at: e.at,
        evidence: e.evidence,
        evidenceRef: e.evidenceRef ?? null,
        actor: e.actor,
        reasonKind: e.reasonKind ?? null,
        reasonRef: e.reasonRef ?? null,
        changeTypeId: e.changeTypeId ?? null,
        changeSetId: e.changeSetId ?? null,
        batchId: e.batchId ?? null,
        experimentId: e.experimentId ?? null,
        ...(e.orgId ? { orgId: e.orgId } : {}),
      })
      .onConflictDoNothing({ target: catalogChangeEvents.idempotencyKey })
      .returning({ seq: catalogChangeEvents.seq });
    if (inserted[0]) return { seq: inserted[0].seq, created: true };
    const raced = await existing(tx);
    if (!raced) throw new Error("recordChange: insert conflicted but no event was found");
    return settle(raced);
  });
}

/**
 * Change events after `afterSeq`, oldest first, at most `limit` (1 to 5,000). Stops below the seq of any transaction
 * still writing events, so storing the last returned seq as the cursor never skips one.
 */
export async function readChanges(
  db: GraphDb,
  afterSeq: bigint,
  limit: number,
  filter: { kinds?: ChangeKind[]; listingIds?: string[] } = {},
): Promise<ChangeEvent[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error("readChanges: limit must be an integer from 1 to 5000");
  const [floor] = await rowsOf<{ floor: string | number | null }>(
    db,
    sql`select min(objid::bigint) as floor from pg_locks where locktype = 'advisory' and classid = ${CHANGE_CURSOR_LOCK_NS} and objsubid = 2 and pid <> pg_backend_pid()`,
  );
  const conditions: SQL[] = [gt(catalogChangeEvents.seq, afterSeq)];
  if (floor?.floor != null) conditions.push(sql`${catalogChangeEvents.seq} < ${BigInt(floor.floor)}`);
  if (filter.kinds?.length) conditions.push(inArray(catalogChangeEvents.kind, filter.kinds));
  if (filter.listingIds?.length) conditions.push(inArray(catalogChangeEvents.listingId, filter.listingIds));
  return db
    .select()
    .from(catalogChangeEvents)
    .where(and(...conditions))
    .orderBy(asc(catalogChangeEvents.seq))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// What was live
// ---------------------------------------------------------------------------

export type LiveSlot = { versionId: string; state: LiveState } | null;

/**
 * What each slot of a listing held at `at`, from catalog_live_intervals: a version and whether that was seen on the
 * channel (`verified`) or only delivered (`assumed`); null for a slot that was empty then. Slots with no interval
 * covering `at` are absent.
 */
export async function liveAt(db: GraphDb, listingId: string, at: Date): Promise<Record<string, LiveSlot>> {
  const i = catalogLiveIntervals;
  const rows = await db
    .select({ slot: i.slot, versionId: i.versionId, state: i.state })
    .from(i)
    .where(and(eq(i.listingId, listingId), lte(i.validFrom, at), or(isNull(i.validTo), gt(i.validTo, at))))
    .orderBy(asc(i.slot), desc(i.validFrom));
  const out: Record<string, LiveSlot> = {};
  for (const r of rows) {
    if (r.slot in out) continue;
    out[r.slot] = r.versionId ? { versionId: r.versionId, state: r.state } : null;
  }
  return out;
}
