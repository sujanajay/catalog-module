// M12-S1: a batch's settings snapshot and how a value is read from it (M12 3.3 rules 1 and 2, M12-F1-R4).
//
// Pure: no database. store.ts writes snapshots at Start; every stage reads values through settingFrom, so a change
// made mid-batch never reaches a batch that already started.
import { SCOPE_LEVELS, settingDef, type SettingScope, type SettingValue } from "./registry";

/** One setting version as the snapshot keeps it. `value` null: no value at this level (the level above applies). */
export interface SnapshotVersion {
  id: string;
  key: string;
  scope: SettingScope;
  version: number;
  value: SettingValue | null;
}

/** `catalog_settings_snapshots.data`. */
export interface SettingsSnapshotData {
  /** Format of this object; bumped if it changes. */
  format: 1;
  /** The registry defaults in force at Start, so a default changed by a later deploy never reaches this batch. */
  defaults: Record<string, SettingValue>;
  /** The current version of every setting at every level, at Start (the batch's version set). */
  versions: SnapshotVersion[];
  /** M2 taxonomy revision at Start (analyze/taxonomy.ts TaxonomySnapshot.revision); 0 for an empty store. */
  taxonomyRevision: number;
}

export interface SettingsSnapshot extends SettingsSnapshotData {
  id: string;
}

/** Canonical text of a scope: '' for the programme default, else `channel=x;category=y;brand=z` (levels set only). */
export function scopeKey(scope: SettingScope | null | undefined): string {
  return SCOPE_LEVELS.filter((level) => scope?.[level]).map((level) => `${level}=${scope![level]}`).join(";");
}

/** The levels of a scope, empty ones dropped (so `{ channel: undefined }` and `{}` are the same scope). */
export function cleanScope(scope: SettingScope | null | undefined): SettingScope {
  const out: SettingScope = {};
  for (const level of SCOPE_LEVELS) if (scope?.[level]) (out as Record<string, string>)[level] = scope[level]!;
  return out;
}

/** A category scope covers its own node and every node under it (taxonomy ids are dotted paths, M2-F1-R1). */
function categoryCovers(scoped: string, wanted: string | undefined): boolean {
  return !!wanted && (wanted === scoped || wanted.startsWith(`${scoped}.`));
}

/**
 * How specific a scope is, or -1 when it does not apply to `context`. Cascade (M12-F1-R4): programme default, then
 * channel, then category (deeper nodes win), then brand; a scope with more levels is more specific.
 */
export function scopeRank(scope: SettingScope, context: SettingScope): number {
  if (scope.channel && scope.channel !== context.channel) return -1;
  if (scope.brand && scope.brand !== context.brand) return -1;
  if (scope.category && !categoryCovers(scope.category, context.category)) return -1;
  return (scope.brand ? 10_000 : 0) + (scope.category ? 100 + scope.category.split(".").length : 0) + (scope.channel ? 1 : 0);
}

/** The version that decides `key` in `context`, or null when the default applies. */
export function deciding(versions: readonly SnapshotVersion[], key: string, context: SettingScope = {}): SnapshotVersion | null {
  let best: SnapshotVersion | null = null, bestRank = -1;
  for (const v of versions) {
    if (v.key !== key || v.value === null) continue;
    const rank = scopeRank(v.scope, context);
    if (rank > bestRank) { best = v; bestRank = rank; }
  }
  return best;
}

/**
 * The value of `key` for `context` in this snapshot: the most specific version that applies, else the default the
 * snapshot recorded, else the registry default (a setting added after the batch started). Throws for an unknown key.
 */
export function settingFrom<T extends SettingValue>(snapshot: SettingsSnapshotData, key: string, context: SettingScope = {}): T {
  const v = deciding(snapshot.versions, key, context);
  if (v) return v.value as T;
  if (key in snapshot.defaults) return snapshot.defaults[key] as T;
  const def = settingDef(key);
  if (!def) throw new Error(`Unknown setting ${key}.`);
  return def.default as T;
}
