// M10-S1a change-type library v0 (docs/program/requirements/M10-learning.md M10-F1-R1, slice M10-S1a).
//
// The taxonomy is data: rows in `catalog_change_types`, seeded by migration 0021 with the list below. Every producer
// that writes an M0 change event stamps one of these ids in `change_type_id` (M0-F3-R9, M10 decision D2); the column
// has a foreign key to the table, so an unknown id is refused by Postgres, never stored. This file holds the v0 seed
// as typed constants so producers name ids without typos; a test checks it equals the migration's seed rows. Types an
// admin adds later (M10-S1b) live only in the table, so readers that must see every type use loadChangeTypes.
import { asc, eq } from "drizzle-orm";
import { CHANNEL_IDS, type ChannelId } from "../catalog/types";
import type { Db } from "../db/client";
import { catalogChangeTypes, type ChangeTypeRow } from "../db/schema";
import type { Component } from "../graph/types";
import type { ChangeAction, CostClass } from "./types";
export { CHANGE_ACTIONS, CHANGE_TYPE_STATUSES, COST_CLASSES, type ChangeAction, type ChangeTypeStatus, type CostClass } from "./types";

/** The taxonomy version that introduced a type (`since_version`). v0 is version 1. */
export const CHANGE_TYPES_V0 = 1;

export interface ChangeTypeSeed {
  id: string;
  name: string;
  component: Component;
  action: ChangeAction;
  costClass: CostClass;
  /**
   * Channels where the change can be made. v0 lists every channel for every type (decision D8): whether a channel
   * accepts a given change is M5's rule store, not this table.
   */
  channels: readonly ChannelId[];
}

const ALL = CHANNEL_IDS;

/** The M10-F1-R1 list. Ids are stable: a type is retired, never renamed or deleted (events keep pointing at it). */
export const CHANGE_TYPE_SEED = [
  { id: "img_shotset_crops", name: "Missing photo roles filled by crops", component: "image", action: "add", costClass: "compute", channels: ALL },
  { id: "img_shotset_generated", name: "Missing photo roles filled by generated images", component: "image", action: "add", costClass: "generation", channels: ALL },
  { id: "img_main_replaced", name: "Main image replaced", component: "image", action: "replace", costClass: "compute", channels: ALL },
  { id: "img_reordered", name: "Gallery re-ordered", component: "image", action: "reorder", costClass: "negligible", channels: ALL },
  { id: "img_background_fixed", name: "Background fixed to the channel rule", component: "image", action: "replace", costClass: "compute", channels: ALL },
  { id: "img_upscaled", name: "Image enlarged with the quality pass", component: "image", action: "replace", costClass: "compute", channels: ALL },
  { id: "img_footwear_views_added", name: "Footwear views added", component: "image", action: "add", costClass: "generation", channels: ALL },
  { id: "title_rewritten_en", name: "English title rewritten", component: "title", action: "replace", costClass: "model_call", channels: ALL },
  { id: "title_arabic_added", name: "Arabic title added", component: "title", action: "add", costClass: "model_call", channels: ALL },
  { id: "bullets_added", name: "Bullets added", component: "bullet", action: "add", costClass: "model_call", channels: ALL },
  { id: "attributes_completed", name: "Attributes completed", component: "attribute", action: "add", costClass: "model_call", channels: ALL },
  { id: "keyword_added_title", name: "Keyword added to the title", component: "title", action: "replace", costClass: "model_call", channels: ALL },
  { id: "keyword_added_backend", name: "Backend search keyword added", component: "keyword", action: "add", costClass: "model_call", channels: ALL },
  { id: "infographic_added", name: "Infographic added", component: "image", action: "add", costClass: "generation", channels: ALL },
  { id: "size_chart_added", name: "Size chart added", component: "size_chart", action: "add", costClass: "negligible", channels: ALL },
] as const satisfies readonly ChangeTypeSeed[];

/** A v0 change-type id, for producers that stamp one (`changeTypeId: CHANGE_TYPE.img_shotset_crops`). */
export type ChangeTypeId = (typeof CHANGE_TYPE_SEED)[number]["id"];
export const CHANGE_TYPE = Object.fromEntries(CHANGE_TYPE_SEED.map((t) => [t.id, t.id])) as { readonly [K in ChangeTypeId]: K };

/** Every type in the table (admin-added ones included), active first, by id. */
export async function loadChangeTypes(db: Db, options: { includeRetired?: boolean } = {}): Promise<ChangeTypeRow[]> {
  const rows = await db.select().from(catalogChangeTypes).orderBy(asc(catalogChangeTypes.status), asc(catalogChangeTypes.id));
  return options.includeRetired ? rows : rows.filter((r) => r.status === "active");
}

export async function changeTypeById(db: Db, id: string): Promise<ChangeTypeRow | null> {
  const [row] = await db.select().from(catalogChangeTypes).where(eq(catalogChangeTypes.id, id));
  return row ?? null;
}
