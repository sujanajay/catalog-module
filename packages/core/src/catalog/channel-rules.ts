// M3-S1 (M3-F3-R1 to R3): the channel values the render reads (canvas, margins, anchor, background, image 1
// background, DPI) come from the M5 channel registry of the latest published ruleset, not from the constants in
// channels.ts. The constants stay the seed of ruleset version 1 and the fixture tests render with (M5 decision D7: no
// runtime fallback to channels.ts), so a worker with no published ruleset stops with a clear error instead.
import { desc } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogRulesetSnapshots } from "../db/schema";
import { CHANNEL_RULES_VERSION, CHANNELS, type ChannelSpec } from "./channels";
import { channelSpecOf, loadSnapshot } from "./rules/store";
import type { RulesetSnapshot } from "./rules/types";
import type { ChannelId } from "./types";

/** The channel values one render reads, and the part of its render key they decide. */
export interface ChannelRules {
  /** The published ruleset version these values come from; null for the channels.ts fixture. */
  rulesetVersion: number | null;
  spec(id: ChannelId): ChannelSpec;
  /**
   * The rules part of a render key (M3-F3-R3): the code's CHANNEL_RULES_VERSION plus the version of this channel's
   * registry row, so an admin change to Noon re-renders Noon outputs in the next batch and nothing else. The fixture
   * gives the plain CHANNEL_RULES_VERSION, the key every output had before M3-S1.
   */
  keyVersion(id: ChannelId): string;
}

export class ChannelRulesError extends Error {}

/** The channels.ts constants as rules: for tests, local tools and eval fixtures only, never a production fallback. */
export const FIXTURE_CHANNEL_RULES: ChannelRules = {
  rulesetVersion: null,
  spec: (id) => {
    const spec = CHANNELS[id];
    if (!spec) throw new ChannelRulesError(`Unknown channel: ${String(id)}`);
    return spec;
  },
  keyVersion: () => CHANNEL_RULES_VERSION,
};

/** The render's view of one published snapshot. A channel the registry does not hold (or holds retired) is an error. */
export function channelRulesOf(snapshot: Pick<RulesetSnapshot, "version" | "channels">): ChannelRules {
  const records = new Map(snapshot.channels.filter((c) => c.status !== "retired").map((c) => [c.id, c]));
  const specs = new Map<string, ChannelSpec>();
  const record = (id: ChannelId) => {
    const found = records.get(id);
    if (!found) throw new ChannelRulesError(`Ruleset version ${snapshot.version} has no active channel row for ${id}.`);
    return found;
  };
  return {
    rulesetVersion: snapshot.version,
    spec: (id) => {
      let spec = specs.get(id);
      if (!spec) specs.set(id, (spec = channelSpecOf(record(id))));
      return spec;
    },
    keyVersion: (id) => `${CHANNEL_RULES_VERSION}+c${record(id).version}`,
  };
}

export const CHANNEL_RULES_NOT_PUBLISHED = "No channel ruleset is published yet, so the channel rules cannot be read. Run the migrate job (it seeds the rules).";

/**
 * The latest published channel rules, read through a per-loader cache: one small query for the latest version on each
 * call, the snapshot body only when that version changes. M5-S3 pins a batch to the version it started with; until then
 * each call reads the latest (M3 decision D13).
 */
export function channelRulesLoader(db: Db): () => Promise<ChannelRules> {
  let cached: ChannelRules | null = null;
  return async () => {
    const [latest] = await db.select({ version: catalogRulesetSnapshots.version }).from(catalogRulesetSnapshots).orderBy(desc(catalogRulesetSnapshots.version)).limit(1);
    if (!latest) throw new ChannelRulesError(CHANNEL_RULES_NOT_PUBLISHED);
    if (cached?.rulesetVersion === latest.version) return cached;
    const snapshot = await loadSnapshot(db, latest.version);
    if (!snapshot) throw new ChannelRulesError(CHANNEL_RULES_NOT_PUBLISHED);
    cached = channelRulesOf(snapshot);
    return cached;
  };
}
