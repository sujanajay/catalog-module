// M12-S1: copy for the plain Settings list page. Pure, so the client component and node tests can import it.
import type { ScopeLevel, SettingArea } from "@catalog/core/settings/registry";

export const SETTINGS_TITLE = "Settings";
export const SETTINGS_HREF = "/catalog/settings";
export const AREA_TITLES: Record<SettingArea, string> = {
  brands: "Brands", channels: "Channels", categories: "Categories", rules: "Rules", quality: "Quality", services: "Services",
  experiments: "Experiments", notifications: "Notifications", people: "People",
};
export const LEVEL_WORDS: Record<"all" | ScopeLevel, string> = { all: "Everywhere", channel: "One channel", category: "One category", brand: "One brand" };
/** Shown on settings nothing reads yet, so an admin never expects an effect. */
export const NOT_IN_USE = "Not in use yet. It takes effect when its feature is built.";
export const OWNER_ONLY = "Owner only";
export const SAVED = "Saved. It applies from the next batch.";
