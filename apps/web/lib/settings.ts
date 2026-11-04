// M12-S1: what the plain Settings list page and GET /api/settings show. Every registered setting, grouped by area,
// with its value at each level, who set it and when, and its recent history. Admin copy: plain words, no model ids.
import { channel } from "@catalog/core/catalog/channels";
import { CHANNEL_IDS, type ChannelId } from "@catalog/core/catalog/types";
import type { Db } from "@catalog/core/db/client";
import type { SettingVersionRow } from "@catalog/core/db/schema";
import { SETTING_AREAS, SETTING_DEFS, type SettingArea, type SettingDef, type SettingScope, type SettingValue } from "@catalog/core/settings/registry";
import { cleanScope } from "@catalog/core/settings/snapshot";
import { currentVersions, isOwner, settingHistory } from "@catalog/core/settings/store";
import { AREA_TITLES } from "./settings-copy";

/** Recent versions shown per setting. */
export const HISTORY_SHOWN = 10;

export interface SettingLevelView {
  versionId: string;
  version: number;
  scope: SettingScope;
  /** "Everywhere", "Noon", "Campus on Noon" ... */
  where: string;
  value: SettingValue | null;
  shown: string;
  by: string;
  at: string;
  reason: string | null;
  /** True for a revert: the change it undid is named in `reason`. */
  undo: boolean;
  /** The current value at its level: the only change Undo is offered on (an older undo would drop newer values). */
  latest: boolean;
}

export interface SettingView {
  key: string;
  label: string;
  help: string;
  type: SettingDef["type"];
  default: SettingValue;
  defaultShown: string;
  scopes: SettingDef["scopes"];
  ownerOnly: boolean;
  inUse: boolean;
  /** The current value at every level that has one (programme default first). */
  levels: SettingLevelView[];
  history: SettingLevelView[];
}

export interface SettingsView {
  /** The signed-in person may change owner-only settings. */
  owner: boolean;
  channels: { id: ChannelId; name: string }[];
  areas: { area: SettingArea; title: string; settings: SettingView[] }[];
}

/** A value as the admin reads it. */
export function shownValue(def: SettingDef, value: SettingValue | null): string {
  if (value === null) return "Back to the level above";
  const t = def.type;
  switch (t.kind) {
    case "switch": return value ? "On" : "Off";
    case "choice": return t.choices.find((c) => c.value === value)?.label ?? String(value);
    case "emails": return (value as string[]).join(", ");
    default: return t.unit ? `${value} ${t.unit}` : String(value);
  }
}

/** Where a value applies, in plain words. */
export function whereText(scope: SettingScope): string {
  const parts = [scope.brand, scope.category ? `category ${scope.category}` : null].filter(Boolean) as string[];
  const ch = scope.channel ? channel(scope.channel).label : null;
  if (!parts.length) return ch ?? "Everywhere";
  return ch ? `${parts.join(", ")} on ${ch}` : parts.join(", ");
}

function levelView(def: SettingDef, r: SettingVersionRow, latest: boolean): SettingLevelView {
  const scope = cleanScope(r.scope);
  return {
    versionId: r.id, version: r.version, scope, where: whereText(scope), value: r.value, shown: shownValue(def, r.value),
    by: r.changedBy, at: r.createdAt.toISOString(), reason: r.reason, undo: r.revertsVersionId !== null, latest,
  };
}

export async function settingsView(db: Db, email: string, area?: SettingArea): Promise<SettingsView> {
  const current = await currentVersions(db);
  const areas = [];
  for (const a of SETTING_AREAS) {
    if (area && a !== area) continue;
    const defs = SETTING_DEFS.filter((d) => d.area === a);
    if (!defs.length) continue;
    const settings: SettingView[] = [];
    for (const def of defs) {
      const latestIds = new Set(current.filter((r) => r.key === def.key).map((r) => r.id));
      const levels = current.filter((r) => r.key === def.key && r.value !== null).sort((x, y) => x.scopeKey.localeCompare(y.scopeKey)).map((r) => levelView(def, r, true));
      const history = (await settingHistory(db, def.key, undefined, HISTORY_SHOWN)).map((r) => levelView(def, r, latestIds.has(r.id)));
      settings.push({
        key: def.key, label: def.label, help: def.help, type: def.type, default: def.default, defaultShown: shownValue(def, def.default),
        scopes: def.scopes, ownerOnly: def.risk === "needs_owner", inUse: def.inUse, levels, history,
      });
    }
    areas.push({ area: a, title: AREA_TITLES[a], settings });
  }
  return { owner: await isOwner(db, email), channels: CHANNEL_IDS.map((id) => ({ id, name: channel(id).label })), areas };
}
