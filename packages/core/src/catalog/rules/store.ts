// M5 rules store (M5-S1): the one writer of the M5 tables and the one reader of ruleset snapshots. Rules, channel
// records and image policies are append-only versions tagged with the ruleset version they take effect in; publishing a
// ruleset version freezes the state as of that version into catalog_ruleset_snapshots, which batches pin (M5 3.3).
import { createHash } from "node:crypto";
import { asc, desc, eq, lte, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  catalogChannelRecords,
  catalogImagePolicies,
  catalogRuleConflicts,
  catalogRuleDecisions,
  catalogRules,
  catalogRulesetSnapshots,
  catalogRulesets,
  catalogTaxonomyNodes,
  type ChannelRecordRow,
  type ImagePolicyRow,
  type RuleRow,
} from "../../db/schema";
import type { ChannelSpec } from "../channels";
import type { ChannelId } from "../types";
import type { CategoryNode, ChannelRecord, ConflictRecord, ImagePolicy, Rule, RulesetSnapshot } from "./types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Advisory lock held by every M5 rules write, so ruleset versions are handed out one at a time. */
export const RULES_WRITE_LOCK = 920_260_005;

export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesError";
  }
}

export async function rulesWriteTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RULES_WRITE_LOCK})`);
    return fn(tx);
  });
}

// ---------------------------------------------------------------------------
// Row to shape
// ---------------------------------------------------------------------------

export function ruleOf(row: RuleRow): Rule {
  return {
    id: row.ruleId,
    version: row.version,
    rulesetVersion: row.rulesetVersion,
    channel: row.channel,
    market: row.market,
    categoryScope: row.categoryScope,
    datasetScope: row.datasetScope ?? null,
    audience: row.audience ?? null,
    brandScope: row.brandScope,
    language: row.language,
    component: row.component,
    field: row.field,
    operator: row.operator,
    value: row.value ?? null,
    text: row.text,
    declaredSeverity: row.declaredSeverity,
    evidence: row.evidence,
    confirmedBy: row.confirmedBy,
    source: row.source,
    conflictsWith: row.conflictsWith,
    checkable: row.checkable,
    judgeMethod: row.judgeMethod,
    status: row.status,
    reason: row.reason,
    createdBy: row.createdBy,
  };
}

export function channelRecordOf(row: ChannelRecordRow): ChannelRecord {
  return {
    id: row.channelId,
    version: row.version,
    rulesetVersion: row.rulesetVersion,
    label: row.label,
    group: row.group,
    minCanvas: row.minCanvas,
    targetCanvas: row.targetCanvas,
    margins: row.margins,
    anchor: row.anchor,
    background: row.background,
    firstImageBackground: row.firstImageBackground,
    dpi: row.dpi,
    fixedCanvas: row.fixedCanvas,
    uniformScaleDefault: row.uniformScaleDefault,
    sheetText: row.sheetText,
    notes: row.notes,
    markets: row.markets,
    languages: row.languages,
    status: row.status,
    pushMethod: row.pushMethod,
    fileKind: row.fileKind,
    owner: row.owner,
    reason: row.reason,
    createdBy: row.createdBy,
  };
}

function imagePolicyOf(row: ImagePolicyRow): ImagePolicy {
  return {
    channel: row.channelId,
    nodeId: row.nodeId,
    version: row.version,
    rulesetVersion: row.rulesetVersion,
    roles: row.roles,
    addOns: row.addOns,
    minCount: row.minCount,
    maxCount: row.maxCount,
    evidence: row.evidence,
    source: row.source,
    status: row.status,
    reason: row.reason,
    createdBy: row.createdBy,
  };
}

/**
 * A channel record in the shape of today's `ChannelSpec` (channels.ts): what the render reads. The parity test proves
 * ruleset v1 gives back exactly the constants; M5-S3 switches the render to this.
 */
export function channelSpecOf(record: ChannelRecord): ChannelSpec {
  return {
    id: record.id as ChannelId,
    label: record.label,
    group: record.group,
    minCanvas: record.minCanvas,
    targetCanvas: record.targetCanvas,
    margins: record.margins,
    anchor: record.anchor,
    background: record.background,
    ...(record.firstImageBackground !== null ? { firstImageBackground: record.firstImageBackground } : {}),
    dpi: record.dpi,
    fixedCanvas: record.fixedCanvas,
    uniformScaleDefault: record.uniformScaleDefault,
    sheetText: record.sheetText,
    ...(record.notes !== null ? { notes: record.notes } : {}),
  };
}

/** The highest version of each key among rows already in force at a ruleset version. */
function latestBy<T extends { version: number }>(rows: T[], key: (row: T) => string): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const k = key(row);
    const seen = best.get(k);
    if (!seen || row.version > seen.version) best.set(k, row);
  }
  return [...best.values()];
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every level, so equal content always serialises (and hashes) the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function snapshotHash(snapshot: Omit<RulesetSnapshot, "hash" | "publishedAt">): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

/** The ruleset as of `version`: the latest version of every rule, channel and policy tagged at or before it. */
export async function buildSnapshotContent(tx: Tx, version: number): Promise<Omit<RulesetSnapshot, "hash" | "publishedAt">> {
  const [ruleRows, channelRows, policyRows, nodeRows, conflictRows, decisionRows] = await Promise.all([
    tx.select().from(catalogRules).where(lte(catalogRules.rulesetVersion, version)),
    tx.select().from(catalogChannelRecords).where(lte(catalogChannelRecords.rulesetVersion, version)),
    tx.select().from(catalogImagePolicies).where(lte(catalogImagePolicies.rulesetVersion, version)),
    tx.select().from(catalogTaxonomyNodes).orderBy(asc(catalogTaxonomyNodes.id)),
    tx.select().from(catalogRuleConflicts).orderBy(asc(catalogRuleConflicts.id)),
    tx.select().from(catalogRuleDecisions).where(lte(catalogRuleDecisions.rulesetVersion, version)),
  ]);
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const rules = latestBy(ruleRows, (r) => r.ruleId).map(ruleOf).sort(byId);
  const channels = latestBy(channelRows, (r) => r.channelId).map(channelRecordOf).sort(byId);
  // Channel ids and node ids never hold a space, so "<channel> <node>" is a unique, sortable key.
  const policyKey = (channel: string, nodeId: string) => `${channel} ${nodeId}`;
  const imagePolicies = latestBy(policyRows, (r) => policyKey(r.channelId, r.nodeId))
    .map(imagePolicyOf)
    .sort((a, b) => (policyKey(a.channel, a.nodeId) < policyKey(b.channel, b.nodeId) ? -1 : 1));
  const categories: CategoryNode[] = nodeRows.map((n) => ({ id: n.id, parentId: n.parentId, level: n.level, name: n.name, status: n.status }));
  // A conflict is decided in this version only if its decision was published at or before it.
  const decisions = new Map(decisionRows.map((d) => [d.id, d]));
  const conflicts: ConflictRecord[] = conflictRows.map((c) => {
    const d = c.decisionId ? decisions.get(c.decisionId) : undefined;
    return {
      id: c.id,
      topic: c.topic,
      severity: c.severity,
      ruleIds: c.ruleIds,
      options: c.options,
      recommendation: c.recommendation,
      reasoning: c.reasoning,
      status: d ? "decided" : "open",
      decision: d
        ? { id: d.id, option: d.option, reason: d.reason, decidedBy: d.decidedBy, decidedAt: d.decidedAt.toISOString(), rulesetVersion: d.rulesetVersion }
        : null,
    };
  });
  return { id: `ruleset-v${version}`, version, rules, channels, categories, imagePolicies, conflicts };
}

/** Opens a new draft ruleset version (the next number). Its rows are written in the same transaction. */
export async function openRulesetVersion(tx: Tx, input: { reason: string; changedRuleIds: string[]; by: string; version?: number }): Promise<number> {
  const [last] = await tx.select({ version: catalogRulesets.version }).from(catalogRulesets).orderBy(desc(catalogRulesets.version)).limit(1);
  const version = input.version ?? (last?.version ?? 0) + 1;
  if (last && version <= last.version) throw new RulesError(`Ruleset version ${version} is not after the latest version ${last.version}.`);
  await tx.insert(catalogRulesets).values({ version, status: "draft", reason: input.reason, changedRuleIds: input.changedRuleIds, createdBy: input.by });
  return version;
}

/** Publishes a draft ruleset version: freezes its snapshot and stamps who and when. */
export async function publishRulesetVersion(tx: Tx, version: number, by: string, at: Date = new Date()): Promise<RulesetSnapshot> {
  const [row] = await tx.select().from(catalogRulesets).where(eq(catalogRulesets.version, version));
  if (!row) throw new RulesError(`Ruleset version ${version} does not exist.`);
  if (row.status !== "draft") throw new RulesError(`Ruleset version ${version} is already published.`);
  const content = await buildSnapshotContent(tx, version);
  const snapshot: RulesetSnapshot = { ...content, hash: snapshotHash(content), publishedAt: at.toISOString() };
  await tx.insert(catalogRulesetSnapshots).values({ version, hash: snapshot.hash, body: snapshot });
  await tx.update(catalogRulesets).set({ status: "published", publishedBy: by, publishedAt: at }).where(eq(catalogRulesets.version, version));
  return snapshot;
}

/** A published snapshot: the given version, or the latest published one. Null when none is published yet. */
export async function loadSnapshot(db: Db, version?: number): Promise<RulesetSnapshot | null> {
  const query = db.select({ body: catalogRulesetSnapshots.body }).from(catalogRulesetSnapshots);
  const [row] = version === undefined
    ? await query.orderBy(desc(catalogRulesetSnapshots.version)).limit(1)
    : await query.where(eq(catalogRulesetSnapshots.version, version));
  return row?.body ?? null;
}
