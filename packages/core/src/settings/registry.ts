// M12-S1 settings registry (docs/program/requirements/M12-admin-self-serve.md M12-F1-R2, section 7).
//
// The structure of every business setting lives here, in code: its key, area, plain label and help sentence, value
// type with limits, default, the levels it may be set at, and its risk class. Structure is not editable from the UI
// (M12-F1-R12); values are, through settings/store.ts, which versions every change. A batch reads all values once at
// Start (store.ts takeSettingsSnapshot) and keeps them to the end (M12 3.3 rule 1).
//
// Labels and help sentences are admin copy: plain words, no vendor or model names (the copy lint reads this file).
import type { ChannelId } from "../catalog/types";

/** The sections of the Settings area (M12-F1-R1), in screen order. */
export const SETTING_AREAS = ["brands", "channels", "categories", "rules", "quality", "services", "experiments", "notifications", "people"] as const;
export type SettingArea = (typeof SETTING_AREAS)[number];

/** Levels below the programme default, in cascade order (M12-F1-R4): channel, then category, then brand. */
export const SCOPE_LEVELS = ["channel", "category", "brand"] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];
/** Where a value applies. Empty is the programme default; `category` is a taxonomy node id (M2), `brand` a brand slug. */
export interface SettingScope { channel?: ChannelId; category?: string; brand?: string }

export const SETTING_RISKS = ["normal", "needs_owner"] as const;
/** `needs_owner`: only an owner may change it (M12-F1-R8; the owner allow-list is `people.owners`). */
export type SettingRisk = (typeof SETTING_RISKS)[number];

export type SettingValue = boolean | number | string | string[];

export type SettingType =
  | { kind: "switch" }
  | { kind: "whole"; min: number; max: number; unit?: string }
  | { kind: "decimal"; min: number; max: number; step: number; unit?: string }
  | { kind: "choice"; choices: readonly { value: string; label: string }[] }
  /** A list of addresses of the allowed sign-in domain, at least `min` of them. */
  | { kind: "emails"; min: number };

export interface SettingDef {
  key: string;
  area: SettingArea;
  /** The module that reads it (M0, M1, M3, M9, M12). Never shown to the admin. */
  module: string;
  label: string;
  help: string;
  type: SettingType;
  default: SettingValue;
  /** The levels below the programme default it may be set at; empty means the programme default only. */
  scopes: readonly ScopeLevel[];
  risk: SettingRisk;
  /**
   * True when the running system reads it today. False for settings registered ahead of the feature that will read
   * them; the list page says so, so an admin never changes a value expecting an effect that does not exist yet.
   */
  inUse: boolean;
  /** Bumped when the type or limits change; stored on every version. */
  schemaVersion: number;
}

/**
 * The hold causes of the M1-F3 auto-decide rules (M1-S3 `catalog_auto_decide_rules`, integration decision D9 in the
 * M12 doc). Kept equal to `HOLD_CAUSES` in catalog/types.ts once M1-S3 merges; a test then checks they match.
 */
export const AUTO_DECIDE_CAUSES = [
  "not_publishable", "unusable", "photo_one", "every_photo", "unchecked", "code_fault", "not_enlarged", "corrupt", "wrong_item", "collage",
] as const;
export type AutoDecideCause = (typeof AUTO_DECIDE_CAUSES)[number];
/** The M1-F3-R1 defaults, as in M1-S3's seed rows. */
export const AUTO_DECIDE_DEFAULTS: Readonly<Record<AutoDecideCause, "deliver" | "drop">> = {
  not_publishable: "deliver", unusable: "deliver", photo_one: "deliver", every_photo: "deliver", unchecked: "deliver",
  code_fault: "deliver", not_enlarged: "deliver", corrupt: "drop", wrong_item: "drop", collage: "drop",
};
const AUTO_DECIDE_WHEN: Readonly<Record<AutoDecideCause, string>> = {
  not_publishable: "When an image still breaks a channel rule after the repair tries",
  unusable: "When the brand photo has a busy background",
  photo_one: "When the first image of a product has a problem",
  every_photo: "When every image of a channel has a problem",
  unchecked: "When the quality check could not run",
  code_fault: "When making the image stopped on our side",
  not_enlarged: "When a photo could not be enlarged to the channel's size",
  corrupt: "When the brand photo file is broken",
  wrong_item: "When the image shows a different item",
  collage: "When the photo holds several photos in one",
};
const AUTO_DECIDE_CHOICES = [
  { value: "deliver", label: "Send the best image now" },
  { value: "drop", label: "Leave this photo out" },
] as const;

/** The owner allow-list key (integration decision D2): Sujan's account until roles arrive with M12-F4. */
export const OWNERS_KEY = "people.owners";
/** The default owner: the account the migrate job seeds as the first admin (apps/worker/src/migrate.ts). */
export const DEFAULT_OWNERS: readonly string[] = ["sujan@opptra.com"];
/** The upscaler threshold, moved from the UPSCALE_MIN_SCALE environment variable (integration decision D10). */
export const UPSCALE_MIN_SCALE_KEY = "images.upscale_min_scale";

export const SETTING_DEFS: readonly SettingDef[] = [
  // M12: the owner allow-list.
  {
    key: OWNERS_KEY, area: "people", module: "M12", label: "Owners",
    help: "People who may change the settings marked owner only. Keep at least one.",
    type: { kind: "emails", min: 1 }, default: [...DEFAULT_OWNERS], scopes: [], risk: "needs_owner", inUse: true, schemaVersion: 1,
  },
  // M3: the enlargement threshold (M3-F2 "upscale thresholds"), read by Start for every new batch.
  {
    key: UPSCALE_MIN_SCALE_KEY, area: "quality", module: "M3", label: "Enlarge with the quality pass above",
    help: "A photo enlarged more than this many times goes through the quality pass. 1 means every enlarged photo.",
    type: { kind: "decimal", min: 1, max: 4, step: 0.1, unit: "times" }, default: 1, scopes: [], risk: "needs_owner", inUse: true, schemaVersion: 1,
  },
  // M1-F2: automatic start.
  {
    key: "intake.auto_start", area: "rules", module: "M1", label: "Start batches by themselves",
    help: "When on, a batch starts after the countdown once its files are in.",
    type: { kind: "switch" }, default: true, scopes: ["brand"], risk: "normal", inUse: false, schemaVersion: 1,
  },
  {
    key: "intake.start_countdown_seconds", area: "rules", module: "M1", label: "Countdown before a batch starts",
    help: "Seconds the team has to change the brand or channels before the start.",
    type: { kind: "whole", min: 0, max: 60, unit: "seconds" }, default: 10, scopes: [], risk: "normal", inUse: false, schemaVersion: 1,
  },
  {
    key: "intake.brand_guess_min_percent", area: "rules", module: "M1", label: "Sure enough to pick the brand",
    help: "How sure the system must be before it picks the brand by itself.",
    type: { kind: "whole", min: 50, max: 100, unit: "percent" }, default: 90, scopes: [], risk: "normal", inUse: false, schemaVersion: 1,
  },
  {
    key: "intake.auto_start_max_products", area: "rules", module: "M1", label: "Most products in a batch that starts by itself",
    help: "A bigger drop waits for a person to press Start.",
    type: { kind: "whole", min: 1, max: 100_000, unit: "products" }, default: 30_000, scopes: [], risk: "normal", inUse: false, schemaVersion: 1,
  },
  // M1-F3: the auto-decide rules (M1-S3's table moves here; integration decision D9).
  ...AUTO_DECIDE_CAUSES.map((cause): SettingDef => ({
    key: `intake.auto_decide.${cause}`, area: "rules", module: "M1", label: AUTO_DECIDE_WHEN[cause],
    help: "What happens to that photo, so nothing waits for a person.",
    type: { kind: "choice", choices: AUTO_DECIDE_CHOICES }, default: AUTO_DECIDE_DEFAULTS[cause], scopes: ["channel"], risk: "normal", inUse: false, schemaVersion: 1,
  })),
  {
    key: "intake.improve_tries", area: "rules", module: "M1", label: "Tries to improve an image sent early",
    help: "How many times the system tries again to make a better image.",
    type: { kind: "whole", min: 0, max: 10, unit: "tries" }, default: 3, scopes: [], risk: "normal", inUse: false, schemaVersion: 1,
  },
  {
    key: "intake.improve_window_hours", area: "rules", module: "M1", label: "Time to improve an image sent early",
    help: "After this time the image stays as it is.",
    type: { kind: "whole", min: 1, max: 720, unit: "hours" }, default: 72, scopes: [], risk: "normal", inUse: false, schemaVersion: 1,
  },
  // M1-S4b (M1 D13): read per batch from its snapshot by the sweep's outage deadline (catalog/upscaler-health.ts).
  {
    key: "intake.outage_deadline_hours", area: "rules", module: "M1", label: "Hours to wait for the enlargement service",
    help: "When the enlargement service is down, photos wait this long, then the batch sends plain images and improves them later. 0 means wait without limit.",
    type: { kind: "whole", min: 0, max: 72, unit: "hours" }, default: 6, scopes: [], risk: "normal", inUse: true, schemaVersion: 1,
  },
  // M0-F1 and M0-F3: style grouping and live photo matching (decision D5 of the M0 doc: one match distance).
  {
    key: "graph.style_group_min_confidence", area: "quality", module: "M0", label: "Sure enough to group colours of a style",
    help: "How sure the system must be before it groups colours of one style by itself.",
    type: { kind: "decimal", min: 0.5, max: 1, step: 0.05 }, default: 0.8, scopes: [], risk: "needs_owner", inUse: false, schemaVersion: 1,
  },
  {
    key: "graph.photo_match_distance", area: "quality", module: "M0", label: "Live photo counts as ours up to",
    help: "How far a live photo may differ from ours and still count as the same. Lower is stricter.",
    type: { kind: "whole", min: 0, max: 64, unit: "of 64" }, default: 6, scopes: [], risk: "needs_owner", inUse: false, schemaVersion: 1,
  },
  {
    key: "graph.photo_match_unsure_max", area: "quality", module: "M0", label: "Live photo is unsure up to",
    help: "Past the match distance and up to this, a live photo is kept as unsure.",
    type: { kind: "whole", min: 0, max: 64, unit: "of 64" }, default: 12, scopes: [], risk: "needs_owner", inUse: false, schemaVersion: 1,
  },
  // M9-F1: checking our live listings politely.
  {
    key: "monitor.seconds_between_requests", area: "channels", module: "M9", label: "Wait between checks of one site",
    help: "Seconds between two checks of our live listings on the same site.",
    type: { kind: "whole", min: 1, max: 60, unit: "seconds" }, default: 2, scopes: ["channel"], risk: "normal", inUse: false, schemaVersion: 1,
  },
];

const BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));
export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}
