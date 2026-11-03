// M0 catalog graph (docs/program/requirements/M0-catalog-graph.md, sections 3.1 and 3.2): the value lists of the
// graph tables. Each one is also a CHECK constraint in schema.ts, so Postgres refuses a value that is not here.
import type { ChannelId } from "../catalog/types";

/** The org every row belongs to until a second customer exists (M12 Q1). */
export const DEFAULT_ORG_ID = "opptra";

/** A listing's country: one market, or `ae_sa` where a channel has one key for both. */
export const MARKETS = ["ae", "sa", "ae_sa"] as const;
/** catalog_options.key_source: which key gave the option_key (F1-R2). */
export const OPTION_KEY_SOURCES = ["master", "sku_option", "sku_fallback"] as const;
/** catalog_options.style_key_source (F1-R8). */
export const STYLE_KEY_SOURCES = ["brand_style_code", "name_colour_rule", "own_cluster"] as const;
/** catalog_channel_listings.status. */
export const LISTING_STATUSES = ["unknown", "live", "not_live", "not_listed"] as const;
/** catalog_listing_keys.key_kind (3.1). */
export const KEY_KINDS = ["zsku", "child_zsku", "partner_sku", "barcode", "asin", "seller_sku", "style_id"] as const;
/** catalog_listing_keys.source: 3.1 lists master, sales, scrape, manual; F1-R4 adds channel_report. */
export const KEY_SOURCES = ["master", "sales", "channel_report", "scrape", "manual"] as const;
/** catalog_content_versions.component (video later). */
export const COMPONENTS = ["image", "title", "bullet", "description", "attribute", "size_chart", "keyword"] as const;
/** catalog_content_versions.role, for images. */
export const IMAGE_ROLES = ["front", "back", "side", "detail", "head_shoulders", "full_length", "flat", "packshot", "size_chart", "unknown"] as const;
/** catalog_content_versions.source. */
export const VERSION_SOURCES = ["brand", "scraped_live", "crop", "cleanup", "upscaled", "generated", "vendor", "operator"] as const;
/** catalog_content_versions.hash_kind: sha256 of the bytes or normalized text; crc32c only for backfilled outputs whose object is gone (F4-R2). */
export const HASH_KINDS = ["sha256", "crc32c"] as const;
/** catalog_content_versions.language (null for images). */
export const LANGUAGES = ["en", "ar"] as const;
/** catalog_change_events.kind (3.2). */
export const CHANGE_EVENT_KINDS = ["planned", "links_delivered", "submitted", "verified_live", "observed_other", "removed", "reverted"] as const;
/** catalog_change_events.evidence. */
export const EVIDENCE_KINDS = ["channel_field", "scrape", "tool_publish", "channel_upload_record", "operator", "backfill"] as const;
/** catalog_change_events.reason_kind (F3-R9; required on every event). */
export const REASON_KINDS = ["rule", "experiment", "operator", "learning", "outside_change", "backfill", "auto_decide", "rejection_fix", "new_content"] as const;
/** catalog_live_intervals.state. */
export const LIVE_STATES = ["verified", "assumed"] as const;
/** catalog_treatment_assignments.arm. */
export const ARMS = ["treatment", "control", "excluded"] as const;
/** Producers of versions: a module id (M0 for the verifier's scraped_live versions, M1 to M12) or the backfill job. */
export const PRODUCER_PATTERN = "^(M([0-9]|1[0-2])|backfill)$";
/** Event kinds that put content on a listing; recordChange refuses them on a frozen listing (F3-R7). */
export const GUARDED_KINDS = ["planned", "links_delivered"] as const;

export type Market = (typeof MARKETS)[number];
export type OptionKeySource = (typeof OPTION_KEY_SOURCES)[number];
export type StyleKeySource = (typeof STYLE_KEY_SOURCES)[number];
export type ListingStatus = (typeof LISTING_STATUSES)[number];
export type KeyKind = (typeof KEY_KINDS)[number];
export type KeySource = (typeof KEY_SOURCES)[number];
export type Component = (typeof COMPONENTS)[number];
export type ImageRole = (typeof IMAGE_ROLES)[number];
export type VersionSource = (typeof VERSION_SOURCES)[number];
export type HashKind = (typeof HASH_KINDS)[number];
export type Language = (typeof LANGUAGES)[number];
export type ChangeKind = (typeof CHANGE_EVENT_KINDS)[number];
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type ReasonKind = (typeof REASON_KINDS)[number];
export type LiveState = (typeof LIVE_STATES)[number];
export type Arm = (typeof ARMS)[number];
/** `master` or a channel: which listing family a version is for. */
export type VersionScope = "master" | ChannelId;
/** A slot on a listing: a component, with a 1-based position for repeated ones (`image:3`, `title`). */
export type Slot = Component | `${Component}:${number}`;
