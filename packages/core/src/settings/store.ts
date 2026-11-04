// M12-S1 settings store (docs/program/requirements/M12-admin-self-serve.md M12-F1, section 7 slice M12-S1).
//
//   Write (the admin list page, later M12-S2): changeSetting, revertSetting
//   Read:  currentVersions, settingHistory, currentValue, ownersOf
//   Batch: takeSettingsSnapshot (Start, in the Start transaction), loadSettingsSnapshot; values through
//          snapshot.ts settingFrom
//
// Rules of the store:
// - Append-only. A change or a revert is a new row in catalog_setting_versions (the `setting.changed` event, M12 3.2)
//   and a structured log line of the same name. Nothing is updated or deleted.
// - Every write first takes one transaction-level advisory lock (SETTINGS_WRITE_LOCK), so version numbers per setting
//   and level are handed out one at a time and the owner check reads the owner list as it is at commit.
// - A setting marked `needs_owner` is changed or reverted only by someone on the owner list (`people.owners`).
//   Until owner approvals (M12-S4), a request from anyone else is refused with a sentence naming the owners.
// - Changes apply from the next batch (M12-F1-R6): a batch reads the store once, at Start, into a snapshot.
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { CHANNEL_IDS } from "../catalog/types";
import type { Db } from "../db/client";
import { brandMaster, catalogSettingsSnapshots, catalogSettingVersions, catalogTaxonomyChanges, catalogTaxonomyNodes, type SettingVersionRow } from "../db/schema";
import { DEFAULT_ORG_ID } from "../graph/types";
import { log } from "../log";
import { allowedDomainFromEnv, isEmailOfDomain, normalizeEmail } from "../people";
import { OWNERS_KEY, SCOPE_LEVELS, SETTING_DEFS, settingDef, type SettingDef, type SettingScope, type SettingValue } from "./registry";
import { cleanScope, scopeKey, settingFrom, type SettingsSnapshot, type SettingsSnapshotData, type SnapshotVersion } from "./snapshot";

/** A refused change, with the HTTP status the web returns and a plain sentence for the admin. */
export class SettingsError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/** Key of the advisory lock every settings write holds until it commits (an arbitrary fixed number, unique in this repo). */
export const SETTINGS_WRITE_LOCK = 920_260_012;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Conn = Db | Tx;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The value in its stored form, or a SettingsError 400 naming the limit it breaks. */
export function parseSettingValue(def: SettingDef, raw: unknown, allowedDomain: string = allowedDomainFromEnv()): SettingValue {
  const t = def.type;
  switch (t.kind) {
    case "switch":
      if (typeof raw !== "boolean") throw new SettingsError(400, `${def.label}: choose on or off.`);
      return raw;
    case "whole":
    case "decimal": {
      const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n) || (t.kind === "whole" && !Number.isInteger(n))) {
        throw new SettingsError(400, `${def.label}: enter a ${t.kind === "whole" ? "whole number" : "number"}.`);
      }
      if (n < t.min || n > t.max) throw new SettingsError(400, `${def.label}: enter a number from ${t.min} to ${t.max}.`);
      return t.kind === "decimal" ? Math.round(n * 10_000) / 10_000 : n;
    }
    case "choice":
      if (typeof raw !== "string" || !t.choices.some((c) => c.value === raw)) throw new SettingsError(400, `${def.label}: pick one of the choices.`);
      return raw;
    case "emails": {
      const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : null;
      if (!list || list.some((e) => typeof e !== "string")) throw new SettingsError(400, `${def.label}: enter email addresses.`);
      const emails = [...new Set((list as string[]).map(normalizeEmail).filter(Boolean))];
      const bad = emails.find((e) => !isEmailOfDomain(e, allowedDomain));
      if (bad) throw new SettingsError(400, `${def.label}: only @${allowedDomain} addresses can be added.`);
      if (emails.length < t.min) throw new SettingsError(400, `${def.label}: keep at least ${t.min}.`);
      return emails.sort();
    }
  }
}

async function checkScope(db: Conn, def: SettingDef, scope: SettingScope): Promise<void> {
  for (const level of SCOPE_LEVELS) {
    if (scope[level] && !def.scopes.includes(level)) throw new SettingsError(400, `${def.label} cannot be set for one ${level}.`);
  }
  if (scope.channel && !(CHANNEL_IDS as readonly string[]).includes(scope.channel)) throw new SettingsError(400, `There is no channel called ${scope.channel}.`);
  if (scope.category) {
    const [node] = await db.select({ id: catalogTaxonomyNodes.id }).from(catalogTaxonomyNodes).where(eq(catalogTaxonomyNodes.id, scope.category));
    if (!node) throw new SettingsError(400, `There is no category called ${scope.category}.`);
  }
  if (scope.brand) {
    const [brand] = await db.select({ slug: brandMaster.slug }).from(brandMaster).where(eq(brandMaster.slug, scope.brand));
    if (!brand) throw new SettingsError(400, `There is no brand called ${scope.brand}.`);
  }
}

function defOf(key: string): SettingDef {
  const def = settingDef(key);
  if (!def) throw new SettingsError(404, `There is no setting called ${key}.`);
  return def;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The current version of every setting at every level it has been set at (highest version per key and level). */
export async function currentVersions(db: Conn, org: string = DEFAULT_ORG_ID): Promise<SettingVersionRow[]> {
  return db.selectDistinctOn([catalogSettingVersions.key, catalogSettingVersions.scopeKey]).from(catalogSettingVersions)
    .where(eq(catalogSettingVersions.orgId, org))
    .orderBy(catalogSettingVersions.key, catalogSettingVersions.scopeKey, desc(catalogSettingVersions.version));
}

/** Every version of one setting, newest first, at every level. */
export async function settingHistory(db: Conn, key: string, org: string = DEFAULT_ORG_ID): Promise<SettingVersionRow[]> {
  return db.select().from(catalogSettingVersions)
    .where(and(eq(catalogSettingVersions.orgId, org), eq(catalogSettingVersions.key, key)))
    .orderBy(desc(catalogSettingVersions.createdAt), desc(catalogSettingVersions.version));
}

const toSnapshotVersion = (r: SettingVersionRow): SnapshotVersion => ({ id: r.id, key: r.key, scope: cleanScope(r.scope), version: r.version, value: r.value });

/** The value `key` has right now for `context` (not a batch's value: batches read their snapshot). */
export async function currentValue<T extends SettingValue>(db: Conn, key: string, context: SettingScope = {}, org: string = DEFAULT_ORG_ID): Promise<T> {
  defOf(key);
  const rows = await db.select().from(catalogSettingVersions)
    .where(and(eq(catalogSettingVersions.orgId, org), eq(catalogSettingVersions.key, key)))
    .orderBy(asc(catalogSettingVersions.scopeKey), desc(catalogSettingVersions.version));
  const latest = rows.filter((r, i) => i === 0 || rows[i - 1]!.scopeKey !== r.scopeKey);
  return settingFrom<T>({ format: 1, defaults: {}, versions: latest.map(toSnapshotVersion), taxonomyRevision: 0 }, key, context);
}

/** The owner allow-list (integration decision D2). */
export async function ownersOf(db: Conn, org: string = DEFAULT_ORG_ID): Promise<string[]> {
  return currentValue<string[]>(db, OWNERS_KEY, {}, org);
}

export async function isOwner(db: Conn, email: string, org: string = DEFAULT_ORG_ID): Promise<boolean> {
  return (await ownersOf(db, org)).includes(normalizeEmail(email));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface SettingChangeInput {
  key: string;
  scope?: SettingScope;
  value: unknown;
  /** One optional sentence (M12-F1-R7). */
  reason?: string | null;
}

export interface SettingChangeResult {
  version: SettingVersionRow;
  risk: SettingDef["risk"];
  /** M12-F1-R6: a change never reaches a batch that has started. */
  effective: "next_batch";
}

async function writeVersion(tx: Tx, def: SettingDef, scope: SettingScope, value: SettingValue | null, by: string, reason: string | null, org: string, revertsVersionId: string | null): Promise<SettingChangeResult> {
  const email = normalizeEmail(by);
  if (def.risk === "needs_owner") {
    const owners = await ownersOf(tx, org);
    if (!owners.includes(email)) throw new SettingsError(403, `Only an owner can change ${def.label.toLowerCase()}. Ask ${owners.join(" or ")}.`);
  }
  const key = scopeKey(scope);
  const [last] = await tx.select().from(catalogSettingVersions)
    .where(and(eq(catalogSettingVersions.orgId, org), eq(catalogSettingVersions.key, def.key), eq(catalogSettingVersions.scopeKey, key)))
    .orderBy(desc(catalogSettingVersions.version)).limit(1);
  if (!revertsVersionId && same(last?.value ?? null, value)) throw new SettingsError(409, `${def.label} already has this value.`);
  const [row] = await tx.insert(catalogSettingVersions).values({
    orgId: org, key: def.key, scopeKey: key, scope, version: (last?.version ?? 0) + 1, value, schemaVersion: def.schemaVersion,
    changedBy: email, reason: reason?.trim() || null, revertsVersionId,
  }).returning();
  // The value of an address list is not logged, only its size.
  const shown = (v: SettingValue | null | undefined) => (Array.isArray(v) ? `${v.length} addresses` : v ?? null);
  log("INFO", "setting.changed", {
    area: def.area, key: def.key, scope: key, from: shown(last?.value), to: shown(value), version: row!.version, reverts: revertsVersionId, effective: "next_batch",
  });
  return { version: row!, risk: def.risk, effective: "next_batch" };
}

function writeTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETTINGS_WRITE_LOCK})`);
    return fn(tx);
  });
}

/** Sets a value at one level (programme default when `scope` is empty), as a new version. */
export async function changeSetting(db: Db, input: SettingChangeInput, by: string, org: string = DEFAULT_ORG_ID): Promise<SettingChangeResult> {
  const def = defOf(input.key);
  const scope = cleanScope(input.scope);
  const value = parseSettingValue(def, input.value);
  await checkScope(db, def, scope);
  return writeTransaction(db, (tx) => writeVersion(tx, def, scope, value, by, input.reason ?? null, org, null));
}

/**
 * M12-F1-R7: undoes one change by writing the value it replaced as a new version. Undoing the first value at a level
 * writes "no value here", so the level above (or the default) applies again.
 */
export async function revertSetting(db: Db, versionId: string, by: string, reason: string | null = null, org: string = DEFAULT_ORG_ID): Promise<SettingChangeResult> {
  return writeTransaction(db, async (tx) => {
    const [target] = await tx.select().from(catalogSettingVersions).where(and(eq(catalogSettingVersions.id, versionId), eq(catalogSettingVersions.orgId, org)));
    if (!target) throw new SettingsError(404, "That change was not found.");
    const def = defOf(target.key);
    const [before] = await tx.select().from(catalogSettingVersions)
      .where(and(eq(catalogSettingVersions.orgId, org), eq(catalogSettingVersions.key, target.key), eq(catalogSettingVersions.scopeKey, target.scopeKey), eq(catalogSettingVersions.version, target.version - 1)));
    const value = before?.value ?? null;
    // The old value must still fit today's limits (a later schema change may have narrowed them).
    if (value !== null) {
      try { parseSettingValue(def, value); } catch { throw new SettingsError(409, `${def.label}: the earlier value no longer fits the allowed range.`); }
    }
    const [latest] = await tx.select({ value: catalogSettingVersions.value }).from(catalogSettingVersions)
      .where(and(eq(catalogSettingVersions.orgId, org), eq(catalogSettingVersions.key, target.key), eq(catalogSettingVersions.scopeKey, target.scopeKey)))
      .orderBy(desc(catalogSettingVersions.version)).limit(1);
    if (same(latest?.value ?? null, value)) throw new SettingsError(409, `${def.label} already has the earlier value.`);
    return writeVersion(tx, def, cleanScope(target.scope), value, by, reason ?? `Undo of version ${target.version}.`, org, target.id);
  });
}

// ---------------------------------------------------------------------------
// Batch snapshots (M12 3.3 rules 1 and 2)
// ---------------------------------------------------------------------------

export interface SnapshotInput {
  batchId?: string | null;
  /** Who started the batch, or the job that did. */
  by: string;
  org?: string;
}

/**
 * Reads every current setting version once and stores it, with the registry defaults and the taxonomy revision, as an
 * immutable snapshot. Call it in the Start transaction and record the id on the batch; every stage then reads values
 * from it, so a change made after Start applies to the next batch only.
 */
export async function takeSettingsSnapshot(db: Conn, input: SnapshotInput): Promise<SettingsSnapshot> {
  const org = input.org ?? DEFAULT_ORG_ID;
  const [versions, [last]] = await Promise.all([
    currentVersions(db, org),
    db.select({ id: catalogTaxonomyChanges.id }).from(catalogTaxonomyChanges).orderBy(desc(catalogTaxonomyChanges.id)).limit(1),
  ]);
  const data: SettingsSnapshotData = {
    format: 1,
    defaults: Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d.default])),
    versions: versions.map(toSnapshotVersion),
    taxonomyRevision: last?.id ?? 0,
  };
  const id = crypto.randomUUID();
  await db.insert(catalogSettingsSnapshots).values({ id, orgId: org, batchId: input.batchId ?? null, data, createdBy: input.by });
  return { id, ...data };
}

export async function loadSettingsSnapshot(db: Conn, id: string): Promise<SettingsSnapshot | null> {
  const [row] = await db.select().from(catalogSettingsSnapshots).where(eq(catalogSettingsSnapshots.id, id));
  return row ? { id: row.id, ...row.data } : null;
}
