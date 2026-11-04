// M5 3.3: the daily BigQuery copy of `rules`, `conflicts` and `rule_results` into `catalog_os.*`, with the M0 export.
// M5 owns what is exported (the rows and their BigQuery schema); the M0 export job (M0-F5, M0-S4) owns the run: the
// schedule, the staging-table swap, the export_runs row and the freshness alert (decision D13). Each table is read in
// pages in a stable order, as M0-F5-R5 asks, and rule results of test content are left out (M0-F5-R3).
import { asc, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { catalogContentVersions, catalogRuleConflicts, catalogRuleDecisions, catalogRuleResults, catalogRules } from "../../db/schema";

/** A BigQuery column (ITableFieldSchema). JSON-shaped values are exported as JSON text in STRING columns. */
export interface ExportField {
  name: string;
  type: "STRING" | "INT64" | "BOOL" | "TIMESTAMP";
  mode: "REQUIRED" | "NULLABLE";
}

export type ExportRow = Record<string, string | number | boolean | null>;

export interface RulesExportTable {
  /** The table name inside the `catalog_os` dataset. */
  table: "rules" | "conflicts" | "rule_results";
  schema: ExportField[];
  /** One page of rows in a stable order; an empty page means the end. */
  read(db: Db, page: { offset: number; limit: number }): Promise<ExportRow[]>;
}

const f = (name: string, type: ExportField["type"], mode: ExportField["mode"] = "REQUIRED"): ExportField => ({ name, type, mode });
const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));
const ts = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Every version of every rule: the history is the table (M5 6 measurement reads it). */
const rules: RulesExportTable = {
  table: "rules",
  schema: [
    f("rule_id", "STRING"), f("version", "INT64"), f("ruleset_version", "INT64"), f("channel", "STRING"), f("market", "STRING", "NULLABLE"),
    f("category_scope", "STRING"), f("audience", "STRING", "NULLABLE"), f("brand_scope", "STRING"), f("language", "STRING"),
    f("component", "STRING"), f("field", "STRING"), f("operator", "STRING"), f("value", "STRING", "NULLABLE"), f("text", "STRING", "NULLABLE"),
    f("declared_severity", "STRING"), f("evidence", "STRING"), f("confirmed_by", "STRING", "NULLABLE"), f("source", "STRING"),
    f("conflicts_with", "STRING"), f("checkable", "BOOL"), f("status", "STRING"), f("reason", "STRING"), f("created_by", "STRING"), f("created_at", "TIMESTAMP"),
  ],
  async read(db, { offset, limit }) {
    const rows = await db.select().from(catalogRules).orderBy(asc(catalogRules.ruleId), asc(catalogRules.version)).limit(limit).offset(offset);
    return rows.map((r) => ({
      rule_id: r.ruleId,
      version: r.version,
      ruleset_version: r.rulesetVersion,
      channel: r.channel,
      market: r.market,
      category_scope: json(r.categoryScope),
      audience: json(r.audience),
      brand_scope: r.brandScope,
      language: r.language,
      component: r.component,
      field: r.field,
      operator: r.operator,
      value: json(r.value),
      text: r.text,
      declared_severity: r.declaredSeverity,
      evidence: r.evidence,
      confirmed_by: r.confirmedBy,
      source: r.source,
      conflicts_with: json(r.conflictsWith),
      checkable: r.checkable,
      status: r.status,
      reason: r.reason,
      created_by: r.createdBy,
      created_at: ts(r.createdAt),
    }));
  },
};

/** The conflict register as it stands, with the decision in force. */
const conflicts: RulesExportTable = {
  table: "conflicts",
  schema: [
    f("conflict_id", "STRING"), f("topic", "STRING"), f("severity", "STRING"), f("rule_ids", "STRING"), f("status", "STRING"),
    f("recommendation", "STRING"), f("decision_id", "STRING", "NULLABLE"), f("decided_option", "STRING", "NULLABLE"),
    f("decided_by", "STRING", "NULLABLE"), f("decided_at", "TIMESTAMP", "NULLABLE"), f("decision_ruleset_version", "INT64", "NULLABLE"),
  ],
  async read(db, { offset, limit }) {
    const rows = await db
      .select({ c: catalogRuleConflicts, d: catalogRuleDecisions })
      .from(catalogRuleConflicts)
      .leftJoin(catalogRuleDecisions, eq(catalogRuleDecisions.id, catalogRuleConflicts.decisionId))
      .orderBy(asc(catalogRuleConflicts.id))
      .limit(limit)
      .offset(offset);
    return rows.map(({ c, d }) => ({
      conflict_id: c.id,
      topic: c.topic,
      severity: c.severity,
      rule_ids: json(c.ruleIds),
      status: c.status,
      recommendation: c.recommendation,
      decision_id: d?.id ?? null,
      decided_option: d?.option ?? null,
      decided_by: d?.decidedBy ?? null,
      decided_at: ts(d?.decidedAt ?? null),
      decision_ruleset_version: d?.rulesetVersion ?? null,
    }));
  },
};

/** Rule results of real content only (test content versions are left out). */
const ruleResults: RulesExportTable = {
  table: "rule_results",
  schema: [
    f("content_version_id", "STRING"), f("ruleset_version", "INT64"), f("channel", "STRING"), f("rule_id", "STRING"), f("rule_version", "INT64"),
    f("outcome", "STRING"), f("effective_severity", "STRING"), f("measured", "STRING", "NULLABLE"), f("message", "STRING"), f("created_at", "TIMESTAMP"),
  ],
  async read(db, { offset, limit }) {
    const rows = await db
      .select({ r: catalogRuleResults })
      .from(catalogRuleResults)
      .innerJoin(catalogContentVersions, eq(catalogContentVersions.id, catalogRuleResults.contentVersionId))
      .where(sql`not ${catalogContentVersions.isTest}`)
      .orderBy(asc(catalogRuleResults.id))
      .limit(limit)
      .offset(offset);
    return rows.map(({ r }) => ({
      content_version_id: r.contentVersionId,
      ruleset_version: r.rulesetVersion,
      channel: r.channel,
      rule_id: r.ruleId,
      rule_version: r.ruleVersion,
      outcome: r.outcome,
      effective_severity: r.effectiveSeverity,
      measured: json(r.measured),
      message: r.message,
      created_at: ts(r.createdAt),
    }));
  },
};

export const RULES_EXPORT_TABLES: readonly RulesExportTable[] = [rules, conflicts, ruleResults];
