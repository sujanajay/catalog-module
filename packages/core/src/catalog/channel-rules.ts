// M3-S1 (M3-F3-R1 to R3): the channel values the render reads (canvas, margins, anchor, background, image 1
// background, DPI) come from the M5 channel registry of a published ruleset, not from the constants in channels.ts.
// The constants stay the seed of ruleset version 1 and the fixture tests render with (M5 decision D7: no runtime
// fallback to channels.ts), so a worker with no published ruleset stops with a clear error instead.
// M5-S3 (M5 3.3, F4-R4, F4-R8): a batch pins the ruleset version it read at Start (catalog_batches.ruleset_version) and
// every read for that batch goes to that version; the background lightness check reads the snapshot's own image rules
// (C10: R086 grey 240 or more, R228 Amazon image 1 white) through evaluate(); when the snapshot table cannot be read,
// the snapshot file in private storage stands in, with the log line F4-R8 names.
import { desc } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogRulesetSnapshots } from "../db/schema";
import { log as defaultLog, type LogFields, type Severity } from "../log";
import { backgroundOf, backgroundRuleBreach, CHANNEL_RULES_VERSION, CHANNELS, type ChannelSpec } from "./channels";
import { blocks, evaluate } from "./rules/evaluate";
import { ensureSnapshotFile, latestSnapshotFile, readSnapshotFile, type SnapshotFileStorage } from "./rules/snapshot-file";
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
  /**
   * M5-S3 (F4-R4, C10): null when the canvas colour of this shot is allowed, else the sentence naming the breach. From a
   * snapshot it is every blocking result of the snapshot's image background rules for that colour; the fixture keeps
   * the channels.ts rule (backgroundRuleBreach).
   */
  backgroundBreach(id: ChannelId, shotNumber: number): string | null;
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
  backgroundBreach: (id, shotNumber) => backgroundRuleBreach(FIXTURE_CHANNEL_RULES.spec(id), shotNumber),
};

/**
 * The background facts of one shot's canvas colour, keyed by the dataset's field names (M5 D32 entry condition 2):
 * `image.background.rgb_min` on every shot, and the image 1 colour on shot 1. The colour is the one the render paints
 * (the compliance pixel check proves the exposed pixels are that colour), so the rule checks decide on exact values.
 * Null for a colour that is not #RRGGBB.
 */
export function backgroundFacts(color: string, shotNumber: number): Record<string, unknown> | null {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
  const hex = color.toUpperCase(), rgb = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return { "image.background.rgb_min": Math.min(...rgb), ...(shotNumber === 1 ? { "image.1.background_hex": hex, "image.1.background": hex } : {}) };
}

/**
 * The background check of one shot against a snapshot's rules (F4-R4, C10): the canvas colour's facts evaluated as an
 * image of that channel, with no market, category or audience (rules scoped to one do not apply to the canvas colour).
 * Null when nothing blocks; warnings (Shein image 1 white, R229, assumed) never block. A colour that is not #RRGGBB
 * is a breach in itself.
 */
export function snapshotBackgroundBreach(snapshot: RulesetSnapshot, spec: Pick<ChannelSpec, "id" | "label" | "background" | "firstImageBackground">, shotNumber: number): string | null {
  const color = backgroundOf(spec, shotNumber), value = backgroundFacts(color, shotNumber);
  if (!value) return `The ${spec.label} background ${color} is not a #RRGGBB colour.`;
  const results = evaluate(snapshot, { channel: spec.id, market: null, brandId: "", categoryPath: [], language: "en", component: "image", contentVersionId: null, value });
  const blocking = results.filter(blocks);
  return blocking.length ? blocking.map((r) => r.message).join(" ") : null;
}

/** The render's view of one published snapshot. A channel the registry does not hold (or holds retired) is an error. */
export function channelRulesOf(snapshot: RulesetSnapshot): ChannelRules {
  const records = new Map(snapshot.channels.filter((c) => c.status !== "retired").map((c) => [c.id, c]));
  const specs = new Map<string, ChannelSpec>(), breaches = new Map<string, string | null>();
  const record = (id: ChannelId) => {
    const found = records.get(id);
    if (!found) throw new ChannelRulesError(`Ruleset version ${snapshot.version} has no active channel row for ${id}.`);
    return found;
  };
  const rules: ChannelRules = {
    rulesetVersion: snapshot.version,
    spec: (id) => {
      let spec = specs.get(id);
      if (!spec) specs.set(id, (spec = channelSpecOf(record(id))));
      return spec;
    },
    keyVersion: (id) => `${CHANNEL_RULES_VERSION}+c${record(id).version}`,
    // Shot 1 and every later shot are the only two colours a channel has, so at most two evaluations per channel.
    backgroundBreach: (id, shotNumber) => {
      const shot = shotNumber === 1 ? 1 : 2, key = `${id} ${shot}`;
      if (!breaches.has(key)) breaches.set(key, snapshotBackgroundBreach(snapshot, rules.spec(id), shot));
      return breaches.get(key)!;
    },
  };
  return rules;
}

export const CHANNEL_RULES_NOT_PUBLISHED = "No channel ruleset is published yet, so the channel rules cannot be read. Run the migrate job (it seeds the rules).";

/** The F4-R8 log line: the snapshot table could not be read and the snapshot file stood in. */
export const rulesDatabaseUnavailable = (version: number) => `rules database unavailable; used snapshot v${version}`;

type Log = (severity: Severity, message: string, fields?: LogFields) => void;

export interface ChannelRulesSource {
  /** The private-storage copy of each published snapshot (M5 3.3), read when the snapshot table cannot be. */
  storage?: SnapshotFileStorage;
  log?: Log;
}

const logOf = (source: ChannelRulesSource): Log => source.log ?? ((severity, message, fields) => defaultLog(severity, message, fields));
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Channel rules by ruleset version, read through a per-loader cache. With a version (a batch's pin) the result is that
 * snapshot, read once and kept: a published snapshot never changes. Without one (a batch older than M5-S3, one started
 * while nothing was published, and the pre-Start preview) it is the latest published version: one small query per
 * call, the body only when the version changes. When the snapshot table cannot be read, the snapshot file of that
 * version (or the newest file) stands in and the F4-R8 line is logged; with no file either, the read error stands.
 */
export function channelRulesLoader(db: Db, source: ChannelRulesSource = {}): (version?: number | null) => Promise<ChannelRules> {
  const pinned = new Map<number, Promise<ChannelRules>>();
  let latest: ChannelRules | null = null;
  const log = logOf(source);
  const fromFile = async (error: unknown, version: number | null): Promise<ChannelRules> => {
    const snapshot = source.storage ? await (version === null ? latestSnapshotFile(source.storage) : readSnapshotFile(source.storage, version)).catch(() => null) : null;
    if (!snapshot) throw error;
    log("WARNING", rulesDatabaseUnavailable(snapshot.version), { rulesetVersion: snapshot.version, error: messageOf(error) });
    return channelRulesOf(snapshot);
  };
  const readVersion = async (version: number): Promise<ChannelRules> => {
    let snapshot: RulesetSnapshot | null;
    try {
      snapshot = await loadSnapshot(db, version);
    } catch (error) {
      return fromFile(error, version);
    }
    if (!snapshot) throw new ChannelRulesError(`Ruleset version ${version} is not published, so this batch's channel rules cannot be read.`);
    return channelRulesOf(snapshot);
  };
  return async (version) => {
    if (version !== undefined && version !== null) {
      let found = pinned.get(version);
      if (!found) {
        pinned.set(version, (found = readVersion(version)));
        // A failed read is not kept, so the next delivery tries again.
        found.catch(() => pinned.delete(version));
      }
      return found;
    }
    let newest: { version: number } | undefined;
    try {
      [newest] = await db.select({ version: catalogRulesetSnapshots.version }).from(catalogRulesetSnapshots).orderBy(desc(catalogRulesetSnapshots.version)).limit(1);
    } catch (error) {
      return fromFile(error, null);
    }
    if (!newest) throw new ChannelRulesError(CHANNEL_RULES_NOT_PUBLISHED);
    if (latest?.rulesetVersion !== newest.version) latest = await readVersion(newest.version);
    return latest;
  };
}

export interface PinnedRuleset {
  version: number;
  /** Where the snapshot was read: the snapshot table, or the private-storage file when the table could not be read. */
  source: "database" | "file";
}

/**
 * The ruleset version a batch starts on (M5 3.3, F4-R8), read once at Start, before the Start transaction: the latest
 * published snapshot. Its file in private storage is written when missing (check-then-write), so the version can stand
 * in later; a failed file write is logged and never stops a Start. When the snapshot table cannot be read, the newest
 * snapshot file is used and the F4-R8 line is logged. Null when nothing is published: the batch then reads the latest
 * version as it goes, as batches did before M5-S3 (and the render stops with CHANNEL_RULES_NOT_PUBLISHED meanwhile).
 */
export async function pinRuleset(db: Db, source: ChannelRulesSource = {}): Promise<PinnedRuleset | null> {
  const log = logOf(source);
  let snapshot: RulesetSnapshot | null;
  try {
    snapshot = await loadSnapshot(db);
  } catch (error) {
    const file = source.storage ? await latestSnapshotFile(source.storage).catch(() => null) : null;
    if (!file) throw error;
    log("WARNING", rulesDatabaseUnavailable(file.version), { rulesetVersion: file.version, error: messageOf(error) });
    return { version: file.version, source: "file" };
  }
  if (!snapshot) return null;
  if (source.storage) {
    try {
      await ensureSnapshotFile(source.storage, snapshot);
    } catch (error) {
      log("WARNING", "rules snapshot file not written", { rulesetVersion: snapshot.version, error: messageOf(error) });
    }
  }
  return { version: snapshot.version, source: "database" };
}
