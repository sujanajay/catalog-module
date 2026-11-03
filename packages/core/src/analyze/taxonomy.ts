// M2-S1 taxonomy store (docs/program/requirements/M2-analyze.md M2-F1-R1 to R3, integration decision D1).
//
// The one category tree of the system, the attribute definitions and the shot roles are data in four tables
// (db/schema.ts, migration 0009). This module is the only way to change them, so every write is validated and logged:
//
//   Write (settings; M5 "Add a category" and M12 settings call these):
//     addTaxonomyNode, updateTaxonomyNode, addAttribute, updateAttribute, addShotRole, updateShotRole
//   Read (the analyzer, M5 rules, M3 plans):
//     loadTaxonomy -> TaxonomySnapshot, then the pure helpers nodePath, attributesFor, shotRolesFor, findNodes
//
// Rules of the store:
// - Nothing is deleted. A definition is retired (status `retired`), so readings made with it still resolve.
// - Node ids are dotted paths from the root (`fashion.apparel.upper.top`); a node never moves and its id never changes.
//   M5 rules and M2 readings store these ids.
// - Every write bumps the row's `version` and appends the full row to catalog_taxonomy_changes in the same
//   transaction. The highest change id is the taxonomy revision (TaxonomySnapshot.revision); M12-S1 records it in a
//   batch's version set.
// - Attributes apply to a node and all its descendants. A node's shot roles are those of the nearest node on its path
//   (itself first) that has active roles.
import { desc, eq, and, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  ATTRIBUTE_SOURCES,
  ATTRIBUTE_TIERS,
  ATTRIBUTE_VALUE_TYPES,
  TAXONOMY_DEF_STATUSES,
  TAXONOMY_LEVELS,
  TAXONOMY_NODE_STATUSES,
  catalogAttributeDefs,
  catalogShotRoles,
  catalogTaxonomyChanges,
  catalogTaxonomyNodes,
  type AttributeAllowedValue,
  type AttributeDefRow,
  type ShotRoleRow,
  type TaxonomyNodeRow,
} from "../db/schema";

export type TaxonomyLevel = (typeof TAXONOMY_LEVELS)[number];
export type TaxonomyNodeStatus = (typeof TAXONOMY_NODE_STATUSES)[number];
export type TaxonomyDefStatus = (typeof TAXONOMY_DEF_STATUSES)[number];
export type AttributeValueType = (typeof ATTRIBUTE_VALUE_TYPES)[number];
export type AttributeTier = (typeof ATTRIBUTE_TIERS)[number];
export type AttributeSource = (typeof ATTRIBUTE_SOURCES)[number];
export type { AttributeAllowedValue };

/** Who made a change: a person's email, `seed`, or a job name. Stored on the change row. */
export interface ChangeMeta {
  by: string;
  note?: string;
}

export interface TaxonomyNodeInput {
  id: string;
  parentId: string | null;
  level: TaxonomyLevel;
  name: string;
  aliases?: string[];
  status?: TaxonomyNodeStatus;
  sortOrder?: number;
}
export type TaxonomyNodePatch = Partial<Pick<TaxonomyNodeInput, "name" | "aliases" | "status" | "sortOrder">>;

export interface AttributeInput {
  id: string;
  name: string;
  valueType: AttributeValueType;
  allowedValues?: AttributeAllowedValue[] | null;
  unit?: string | null;
  nodeIds: string[];
  tier: AttributeTier;
  sourcePrecedence: AttributeSource[];
  status?: TaxonomyDefStatus;
}
export type AttributePatch = Partial<Omit<AttributeInput, "id" | "valueType">>;

export interface ShotRoleInput {
  nodeId: string;
  key: string;
  name: string;
  definition: string;
  sortOrder?: number;
  status?: TaxonomyDefStatus;
}
export type ShotRolePatch = Partial<Pick<ShotRoleInput, "name" | "definition" | "sortOrder" | "status">>;

/** A write the store refuses. `message` is plain words for the admin screen. */
export class TaxonomyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaxonomyError";
  }
}

export type TaxonomyNode = TaxonomyNodeRow;
export type AttributeDef = AttributeDefRow;
export type ShotRole = ShotRoleRow;

/** Everything in the store at one revision, retired rows included (old readings still resolve). */
export interface TaxonomySnapshot {
  /** Highest change id; 0 for an empty store. */
  revision: number;
  nodes: Map<string, TaxonomyNode>;
  attributes: Map<string, AttributeDef>;
  /** Keyed by node id, in sort order. */
  shotRoles: Map<string, ShotRole[]>;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const NODE_ID = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;
const ATTRIBUTE_ID = /^[a-z0-9_]+$/;
const ROLE_KEY = /^[A-Za-z0-9_]+$/;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadTaxonomy(db: Db): Promise<TaxonomySnapshot> {
  return db.transaction(async (tx) => {
    const [nodes, attributes, roles, last] = await Promise.all([
      tx.select().from(catalogTaxonomyNodes).orderBy(catalogTaxonomyNodes.sortOrder, catalogTaxonomyNodes.id),
      tx.select().from(catalogAttributeDefs).orderBy(catalogAttributeDefs.id),
      tx.select().from(catalogShotRoles).orderBy(catalogShotRoles.nodeId, catalogShotRoles.sortOrder, catalogShotRoles.key),
      tx.select({ id: catalogTaxonomyChanges.id }).from(catalogTaxonomyChanges).orderBy(desc(catalogTaxonomyChanges.id)).limit(1),
    ]);
    const shotRoles = new Map<string, ShotRole[]>();
    for (const r of roles) shotRoles.set(r.nodeId, [...(shotRoles.get(r.nodeId) ?? []), r]);
    return {
      revision: last[0]?.id ?? 0,
      nodes: new Map(nodes.map((n) => [n.id, n])),
      attributes: new Map(attributes.map((a) => [a.id, a])),
      shotRoles,
    };
    // One consistent view: a write committed between the four reads cannot mix two revisions.
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** The node and its ancestors, root first. Throws for an id the store does not have. */
export function nodePath(snap: TaxonomySnapshot, nodeId: string): TaxonomyNode[] {
  const path: TaxonomyNode[] = [];
  for (let id: string | null = nodeId; id; ) {
    const node = snap.nodes.get(id);
    if (!node) throw new TaxonomyError(`Unknown taxonomy node ${id}.`);
    path.unshift(node);
    id = node.parentId;
  }
  return path;
}

/** The direct children of a node (or the roots for `null`), in sort order, retired ones left out. */
export function childrenOf(snap: TaxonomySnapshot, nodeId: string | null): TaxonomyNode[] {
  return [...snap.nodes.values()].filter((n) => n.parentId === nodeId && n.status !== "retired");
}

/** Active attributes that apply to a node: those defined on it or on any of its ancestors. Optionally one tier. */
export function attributesFor(snap: TaxonomySnapshot, nodeId: string, tier?: AttributeTier): AttributeDef[] {
  const onPath = new Set(nodePath(snap, nodeId).map((n) => n.id));
  return [...snap.attributes.values()].filter(
    (a) => a.status === "active" && (!tier || a.tier === tier) && a.nodeIds.some((id) => onPath.has(id)),
  );
}

/** Active shot roles of the nearest node on the path (the node itself first) that has any; empty when none has. */
export function shotRolesFor(snap: TaxonomySnapshot, nodeId: string): ShotRole[] {
  for (const node of nodePath(snap, nodeId).reverse()) {
    const active = (snap.shotRoles.get(node.id) ?? []).filter((r) => r.status === "active");
    if (active.length) return active;
  }
  return [];
}

/** Nodes (not retired) whose id, last id part, name or an alias equals `word`, ignoring case, spaces and dashes. */
export function findNodes(snap: TaxonomySnapshot, word: string): TaxonomyNode[] {
  const w = normalizeWord(word);
  if (!w) return [];
  return [...snap.nodes.values()].filter(
    (n) =>
      n.status !== "retired" &&
      [n.id, n.id.split(".").pop()!, n.name, ...n.aliases].some((candidate) => normalizeWord(candidate) === w),
  );
}

function normalizeWord(s: string): string {
  return s.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function addTaxonomyNode(db: Db, input: TaxonomyNodeInput, meta: ChangeMeta): Promise<TaxonomyNode> {
  return db.transaction(async (tx) => {
    const parent = await validateNode(tx, input);
    // A new node under a vertical that is not released yet is not released either, unless the admin says so.
    const status = input.status ?? (parent?.status === "not_released" ? "not_released" : "released");
    const [row] = await tx
      .insert(catalogTaxonomyNodes)
      .values({ ...input, name: input.name.trim(), aliases: cleanList(input.aliases ?? []), status })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new TaxonomyError(`A category with id ${input.id} already exists.`);
    await logChange(tx, "node", row.id, row.version, "create", row, meta);
    return row;
  });
}

export async function updateTaxonomyNode(db: Db, id: string, patch: TaxonomyNodePatch, meta: ChangeMeta): Promise<TaxonomyNode> {
  return db.transaction(async (tx) => {
    if (patch.name !== undefined && !patch.name.trim()) throw new TaxonomyError("A category needs a name.");
    if (patch.status && !TAXONOMY_NODE_STATUSES.includes(patch.status)) throw new TaxonomyError(`Unknown category status ${patch.status}.`);
    if (patch.status === "retired") {
      const [child] = await tx
        .select({ id: catalogTaxonomyNodes.id })
        .from(catalogTaxonomyNodes)
        .where(and(eq(catalogTaxonomyNodes.parentId, id), sql`${catalogTaxonomyNodes.status} <> 'retired'`))
        .limit(1);
      if (child) throw new TaxonomyError(`Retire the categories under ${id} first (${child.id}).`);
    }
    const [row] = await tx
      .update(catalogTaxonomyNodes)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.aliases !== undefined ? { aliases: cleanList(patch.aliases) } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        version: sql`${catalogTaxonomyNodes.version} + 1`,
      })
      .where(eq(catalogTaxonomyNodes.id, id))
      .returning();
    if (!row) throw new TaxonomyError(`Unknown taxonomy node ${id}.`);
    await logChange(tx, "node", row.id, row.version, "update", row, meta);
    return row;
  });
}

export async function addAttribute(db: Db, input: AttributeInput, meta: ChangeMeta): Promise<AttributeDef> {
  return db.transaction(async (tx) => {
    const values = normalizeAttribute(input);
    await requireNodes(tx, values.nodeIds);
    const [row] = await tx.insert(catalogAttributeDefs).values(values).onConflictDoNothing().returning();
    if (!row) throw new TaxonomyError(`An attribute with id ${input.id} already exists.`);
    await logChange(tx, "attribute", row.id, row.version, "create", row, meta);
    return row;
  });
}

/** The value type never changes (a value stored as a number must stay a number): retire it and add a new id. */
export async function updateAttribute(db: Db, id: string, patch: AttributePatch, meta: ChangeMeta): Promise<AttributeDef> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(catalogAttributeDefs).where(eq(catalogAttributeDefs.id, id)).for("update");
    if (!current) throw new TaxonomyError(`Unknown attribute ${id}.`);
    const merged = normalizeAttribute({
      id,
      name: patch.name ?? current.name,
      valueType: current.valueType,
      allowedValues: patch.allowedValues !== undefined ? patch.allowedValues : current.allowedValues,
      unit: patch.unit !== undefined ? patch.unit : current.unit,
      nodeIds: patch.nodeIds ?? current.nodeIds,
      tier: patch.tier ?? current.tier,
      sourcePrecedence: patch.sourcePrecedence ?? current.sourcePrecedence,
      status: patch.status ?? current.status,
    });
    const removed = (current.allowedValues ?? []).filter((v) => !merged.allowedValues?.some((m) => m.key === v.key));
    if (removed.length) throw new TaxonomyError(`Values cannot be removed from ${id} (${removed.map((v) => v.key).join(", ")}); add a new attribute instead.`);
    if (patch.nodeIds) await requireNodes(tx, merged.nodeIds);
    const { id: _id, valueType: _type, ...set } = merged;
    const [row] = await tx
      .update(catalogAttributeDefs)
      .set({ ...set, version: sql`${catalogAttributeDefs.version} + 1` })
      .where(eq(catalogAttributeDefs.id, id))
      .returning();
    await logChange(tx, "attribute", row!.id, row!.version, "update", row!, meta);
    return row!;
  });
}

export async function addShotRole(db: Db, input: ShotRoleInput, meta: ChangeMeta): Promise<ShotRole> {
  return db.transaction(async (tx) => {
    if (!ROLE_KEY.test(input.key)) throw new TaxonomyError(`Shot role key ${input.key} may use only letters, digits and _.`);
    if (!input.name.trim() || !input.definition.trim()) throw new TaxonomyError("A shot role needs a name and a definition.");
    await requireNodes(tx, [input.nodeId]);
    const [row] = await tx
      .insert(catalogShotRoles)
      .values({ ...input, name: input.name.trim(), definition: input.definition.trim() })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new TaxonomyError(`Shot role ${input.key} already exists on ${input.nodeId}.`);
    await logChange(tx, "shot_role", `${row.nodeId}/${row.key}`, row.version, "create", row, meta);
    return row;
  });
}

export async function updateShotRole(db: Db, nodeId: string, key: string, patch: ShotRolePatch, meta: ChangeMeta): Promise<ShotRole> {
  return db.transaction(async (tx) => {
    if ((patch.name !== undefined && !patch.name.trim()) || (patch.definition !== undefined && !patch.definition.trim()))
      throw new TaxonomyError("A shot role needs a name and a definition.");
    if (patch.status && !TAXONOMY_DEF_STATUSES.includes(patch.status)) throw new TaxonomyError(`Unknown status ${patch.status}.`);
    const [row] = await tx
      .update(catalogShotRoles)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.definition !== undefined ? { definition: patch.definition.trim() } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        version: sql`${catalogShotRoles.version} + 1`,
      })
      .where(and(eq(catalogShotRoles.nodeId, nodeId), eq(catalogShotRoles.key, key)))
      .returning();
    if (!row) throw new TaxonomyError(`Unknown shot role ${key} on ${nodeId}.`);
    await logChange(tx, "shot_role", `${row.nodeId}/${row.key}`, row.version, "update", row, meta);
    return row;
  });
}

// ---------------------------------------------------------------------------
// Validation and the change log (shared with taxonomy-seed.ts)
// ---------------------------------------------------------------------------

/** Checks a new node against the rules of the tree and returns its parent (null for a vertical). */
async function validateNode(tx: Tx, input: TaxonomyNodeInput): Promise<TaxonomyNode | null> {
  if (!NODE_ID.test(input.id)) throw new TaxonomyError(`Category id ${input.id} must be lower-case words joined by dots.`);
  if (!TAXONOMY_LEVELS.includes(input.level)) throw new TaxonomyError(`Unknown category level ${input.level}.`);
  if (input.status && !TAXONOMY_NODE_STATUSES.includes(input.status)) throw new TaxonomyError(`Unknown category status ${input.status}.`);
  if (!input.name.trim()) throw new TaxonomyError("A category needs a name.");
  if (input.parentId === null) {
    if (input.id.includes(".")) throw new TaxonomyError(`Category ${input.id} needs a parent.`);
    if (input.level !== "vertical") throw new TaxonomyError("Only a vertical can sit at the top of the tree.");
    return null;
  }
  if (!input.id.startsWith(`${input.parentId}.`) || input.id.slice(input.parentId.length + 1).includes("."))
    throw new TaxonomyError(`Category id ${input.id} must be its parent's id plus one more part.`);
  const [parent] = await tx.select().from(catalogTaxonomyNodes).where(eq(catalogTaxonomyNodes.id, input.parentId));
  if (!parent || parent.status === "retired") throw new TaxonomyError(`Parent category ${input.parentId} does not exist.`);
  if (TAXONOMY_LEVELS.indexOf(input.level) <= TAXONOMY_LEVELS.indexOf(parent.level))
    throw new TaxonomyError(`A ${input.level} cannot sit under a ${parent.level}.`);
  return parent;
}

/** Validates an attribute definition and returns the row to store. Exported for the seed. */
export function normalizeAttribute(input: AttributeInput): typeof catalogAttributeDefs.$inferInsert & { nodeIds: string[]; allowedValues: AttributeAllowedValue[] | null } {
  if (!ATTRIBUTE_ID.test(input.id)) throw new TaxonomyError(`Attribute id ${input.id} must be lower-case letters, digits and _.`);
  if (!input.name.trim()) throw new TaxonomyError("An attribute needs a name.");
  if (!ATTRIBUTE_VALUE_TYPES.includes(input.valueType)) throw new TaxonomyError(`Unknown value type ${input.valueType}.`);
  if (!ATTRIBUTE_TIERS.includes(input.tier)) throw new TaxonomyError(`Unknown tier ${input.tier}.`);
  if (input.status && !TAXONOMY_DEF_STATUSES.includes(input.status)) throw new TaxonomyError(`Unknown status ${input.status}.`);
  const nodeIds = cleanList(input.nodeIds);
  if (!nodeIds.length) throw new TaxonomyError(`Attribute ${input.id} must apply to at least one category.`);
  const sources = input.sourcePrecedence;
  if (!sources.length || new Set(sources).size !== sources.length || sources.some((s) => !ATTRIBUTE_SOURCES.includes(s)))
    throw new TaxonomyError(`Attribute ${input.id} needs a source order made of distinct ${ATTRIBUTE_SOURCES.join(", ")}.`);
  let allowedValues: AttributeAllowedValue[] | null = null;
  if (input.valueType === "enum") {
    allowedValues = (input.allowedValues ?? []).map((v) => ({ ...v, key: v.key.trim(), label: v.label.trim() }));
    if (!allowedValues.length) throw new TaxonomyError(`List attribute ${input.id} needs at least one allowed value.`);
    if (allowedValues.some((v) => !ATTRIBUTE_ID.test(v.key) || !v.label)) throw new TaxonomyError(`Every value of ${input.id} needs a key (lower-case, _) and a label.`);
    if (new Set(allowedValues.map((v) => v.key)).size !== allowedValues.length) throw new TaxonomyError(`Values of ${input.id} must be distinct.`);
  } else if (input.allowedValues?.length) {
    throw new TaxonomyError(`Only a list attribute has allowed values (${input.id} is ${input.valueType}).`);
  }
  const unit = input.unit?.trim() || null;
  if (unit && input.valueType !== "number") throw new TaxonomyError(`Only a number attribute has a unit (${input.id}).`);
  return {
    id: input.id,
    name: input.name.trim(),
    valueType: input.valueType,
    allowedValues,
    unit,
    nodeIds,
    tier: input.tier,
    sourcePrecedence: [...sources],
    status: input.status ?? "active",
  };
}

async function requireNodes(tx: Tx, ids: string[]): Promise<void> {
  const rows = await tx.select({ id: catalogTaxonomyNodes.id, status: catalogTaxonomyNodes.status }).from(catalogTaxonomyNodes);
  const live = new Set(rows.filter((r) => r.status !== "retired").map((r) => r.id));
  const missing = ids.filter((id) => !live.has(id));
  if (missing.length) throw new TaxonomyError(`Unknown categories: ${missing.join(", ")}.`);
}

export async function logChange(
  tx: Tx,
  entity: "node" | "attribute" | "shot_role",
  entityId: string,
  version: number,
  action: "seed" | "create" | "update",
  row: object,
  meta: ChangeMeta,
): Promise<void> {
  if (!meta.by.trim()) throw new TaxonomyError("A change needs the name of who made it.");
  await tx.insert(catalogTaxonomyChanges).values({
    entity,
    entityId,
    version,
    action,
    data: JSON.parse(JSON.stringify(row)) as Record<string, unknown>,
    changedBy: meta.by.trim(),
    note: meta.note ?? null,
  });
}

function cleanList(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}
