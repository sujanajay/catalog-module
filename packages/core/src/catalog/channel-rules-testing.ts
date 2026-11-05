// Test support for M3-S1: what the M5 rules editor (M5-S5, not built yet) will do when an admin saves one channel's
// render values: a new ruleset version holding the next version of that channel's row, published at once. M5-S3 adds the
// same for one rule (an admin raising the background minimum, for example).
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogChannelRecords, catalogRules } from "../db/schema";
import { openRulesetVersion, publishRulesetVersion, rulesWriteTransaction } from "./rules/store";
import type { ChannelId } from "./types";

type ChannelRecordPatch = Partial<Pick<typeof catalogChannelRecords.$inferInsert, "background" | "firstImageBackground" | "dpi" | "margins" | "minCanvas" | "targetCanvas" | "anchor">>;

/** Publishes a ruleset version that changes one channel's row; returns the new ruleset version. Tests only. */
export async function publishChannelChange(db: Db, channelId: ChannelId, patch: ChannelRecordPatch, by = "admin@opptra.com"): Promise<number> {
  return rulesWriteTransaction(db, async (tx) => {
    const [row] = await tx.select().from(catalogChannelRecords).where(and(eq(catalogChannelRecords.channelId, channelId))).orderBy(desc(catalogChannelRecords.version)).limit(1);
    if (!row) throw new Error(`No channel row for ${channelId}.`);
    const version = await openRulesetVersion(tx, { reason: `Admin change to ${channelId}.`, changedRuleIds: [], by });
    const { createdAt: _createdAt, ...rest } = row;
    await tx.insert(catalogChannelRecords).values({ ...rest, ...patch, version: row.version + 1, rulesetVersion: version, reason: `Admin change to ${channelId}.`, createdBy: by });
    await publishRulesetVersion(tx, version, by);
    return version;
  });
}

type RulePatch = Partial<Pick<typeof catalogRules.$inferInsert, "value" | "declaredSeverity" | "status" | "evidence" | "confirmedBy">>;

/** Publishes a ruleset version that changes one rule (its next version); returns the new ruleset version. Tests only. */
export async function publishRuleChange(db: Db, ruleId: string, patch: RulePatch, by = "admin@opptra.com"): Promise<number> {
  return rulesWriteTransaction(db, async (tx) => {
    const [row] = await tx.select().from(catalogRules).where(eq(catalogRules.ruleId, ruleId)).orderBy(desc(catalogRules.version)).limit(1);
    if (!row) throw new Error(`No rule ${ruleId}.`);
    const version = await openRulesetVersion(tx, { reason: `Admin change to ${ruleId}.`, changedRuleIds: [ruleId], by });
    const { createdAt: _createdAt, ...rest } = row;
    await tx.insert(catalogRules).values({ ...rest, ...patch, version: row.version + 1, rulesetVersion: version, reason: `Admin change to ${ruleId}.`, createdBy: by });
    await publishRulesetVersion(tx, version, by);
    return version;
  });
}
