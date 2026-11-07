// M1-F3 auto-decide (M1-S3, docs/program/requirements/M1-intake.md): what happens to an output the QA triage would
// hold for a person. Each hold cause maps to `deliver` (published now, flagged `provisional`), `drop` (no link for
// that photo on that channel; the rest of the set is delivered) or, the rare last resort, `hold` (M1 D40: no link for that
// photo until a person decides; the rest of the set is delivered), read from `catalog_auto_decide_rules` at Start and
// kept on the batch (options.autoDecide). No product becomes `pending_attention` and no batch waits for a person.
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { catalogAutoDecideRules } from "../db/schema";
import { autoActionsOf } from "./auto-resolve";
import { problemFlags } from "./qa/triage";
import { HOLD_CAUSES, PROVISIONAL_SENTENCE, type AutoDecideAction, type BatchOptions, type ChannelId, type HoldCause, type OutputFlag, type OutputStatus } from "./types";

export type AutoDecideSnapshot = NonNullable<BatchOptions["autoDecide"]>;
export type AutoDecideRule = AutoDecideSnapshot["rules"][number];

/**
 * The M1-F3-R1 defaults (migration 0014's seed rows, changed by 0029). Hold (M1 D40, owner 2026-11-06): a photo that
 * could not be cut out, and a defect a shopper would see that the repair loop could not remove. Deliver: a non-visible
 * problem after the repair loop, an image 1 problem, every photo of a channel with a problem, no verdict (judge down or
 * capped), an encoder fault, a failed enlargement. Drop: a corrupt source, a different item (product truth), a collage
 * (several photos in one is not a product photo for a marketplace; integration decision D7).
 */
export const DEFAULT_AUTO_DECIDE_ACTIONS: Readonly<Record<HoldCause, AutoDecideAction>> = {
  not_publishable: "deliver", unusable: "hold", photo_one: "deliver", every_photo: "deliver", unchecked: "deliver",
  code_fault: "deliver", not_enlarged: "deliver", corrupt: "drop", wrong_item: "drop", collage: "drop", visible_defect: "hold",
};
export const DEFAULT_AUTO_DECIDE_RULES: readonly AutoDecideRule[] = HOLD_CAUSES.map(cause => ({ id: `${cause}:*`, cause, channel: "*", action: DEFAULT_AUTO_DECIDE_ACTIONS[cause] }));

/** The enabled rules now, for Start to keep on the batch (a later change never affects a running batch). */
export async function autoDecideSnapshot(db: Db): Promise<AutoDecideSnapshot> {
  const rows = await db.select().from(catalogAutoDecideRules).where(eq(catalogAutoDecideRules.enabled, true)).orderBy(asc(catalogAutoDecideRules.id));
  return { rules: rows.map(({ id, cause, channel, action }) => ({ id, cause, channel, action })) };
}

/** The batch's rules, or null for a batch started before M1-S3 (it keeps the holds for a person). */
export function autoDecideOf(options: Pick<BatchOptions, "autoDecide"> | null | undefined): AutoDecideSnapshot | null {
  const value = options?.autoDecide;
  return value && typeof value === "object" && Array.isArray(value.rules) ? value : null;
}

/** The channel's own rule, else the `*` rule, else the built-in default. */
export function ruleFor(snapshot: AutoDecideSnapshot, cause: HoldCause, channel: ChannelId): AutoDecideRule {
  return snapshot.rules.find(r => r.cause === cause && r.channel === channel)
    ?? snapshot.rules.find(r => r.cause === cause && r.channel === "*")
    ?? DEFAULT_AUTO_DECIDE_RULES.find(r => r.cause === cause)!;
}

export interface AutoDecideTarget { status: OutputStatus; stagingUri: string | null; bytes: number | null; flags: readonly OutputFlag[] }
/**
 * The staged image can be delivered: it was made (staged bytes exist) and it passes the channel's hard rules
 * (`failed_compliance` is a broken channel rule, including an encoder fault and a size the channel refuses). A failed
 * source never has one.
 */
export function deliverable(o: AutoDecideTarget): boolean {
  return (o.status === "staged" || o.status === "needs_attention") && !!o.stagingUri && o.bytes !== null && !o.flags.includes("failed_compliance");
}

export interface AutoDecision {
  action: AutoDecideAction;
  rule: AutoDecideRule;
  /** The rule said deliver or hold but there is nothing deliverable, so the slot is dropped with its reason. */
  fellBack: boolean;
}
export function autoDecide(snapshot: AutoDecideSnapshot, cause: HoldCause, o: AutoDecideTarget & { channel: ChannelId }): AutoDecision {
  const rule = ruleFor(snapshot, cause, o.channel);
  if (rule.action !== "drop" && !deliverable(o)) return { action: "drop", rule, fellBack: true };
  return { action: rule.action, rule, fellBack: false };
}

/** The record kept on the output (`compliance.auto_decide`): which rule decided, for which cause, and what it did. */
export interface AutoDecideRecord { rule: string; cause: HoldCause; action: AutoDecideAction; fellBack?: true }
export function autoDecideRecord(cause: HoldCause, d: AutoDecision): AutoDecideRecord {
  return { rule: d.rule.id, cause, action: d.action, ...(d.fellBack ? { fellBack: true as const } : {}) };
}
export function autoDecideRecordOf(compliance: unknown): AutoDecideRecord | null {
  const r = (compliance as { auto_decide?: unknown } | null | undefined)?.auto_decide;
  return r && typeof r === "object" && typeof (r as AutoDecideRecord).rule === "string" ? r as AutoDecideRecord : null;
}

/** What a person can do with a held photo (M1 D40). */
export const HOLD_SENTENCE = "It has no link yet and the product's other photos are delivered. Replace it, use it as it is, or remove it.";
/** An output an auto-decide rule held for a person: no link, and the product and the batch go on without it (M1 D40). */
export function heldForPerson(o: { status: string; decision?: string | null; compliance: unknown }): boolean {
  return o.status === "needs_attention" && !o.decision && autoDecideRecordOf(o.compliance)?.action === "hold";
}

/** M1 D45: the only verdicts that may take an older live image down. Both are about the source photo, not about this run's render. */
export type TakeDownVerdict = "text_or_watermark" | "different_product";
const TAKE_DOWN_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["text_or_watermark", "different_product"]);
interface VerdictScores { verdict?: string; autoAction?: string | null; finalStatus?: string; no_text_or_watermark?: number; thresholds?: { no_text_or_watermark?: number }; evidence?: { text_or_watermark?: unknown }; wrongItem?: { confirmed?: boolean } | null }
/**
 * M1 D45: the verdict on this output that may take down an older image of the same photo, or null. A mark the judge confirmed, or a different
 * item two judges agree on, and nothing else on the row. Never a render verdict (`product_removed`, `halo`, `leftover_background`), a collage,
 * a chart, or any other problem beside it, such as a failed enlargement, a broken channel rule or an unchecked photo. Never a person's decision. The
 * triage must have decided the row (a crash, cap or outage before it leaves no `finalStatus`), and no repair step may have touched it.
 */
export function takeDownVerdict(o: { status: string; decision?: string | null; flags: readonly OutputFlag[]; compliance: unknown; qaScores?: unknown }): TakeDownVerdict | null {
  if (o.decision || !(heldForPerson(o) || (o.status === "skipped" && o.flags.includes("auto_dropped")))) return null;
  const problems = problemFlags(o.flags);
  if (!problems.length || problems.some(flag => !TAKE_DOWN_FLAGS.has(flag)) || autoActionsOf(o.compliance).length) return null;
  const scores = o.qaScores as VerdictScores | null | undefined;
  if (scores?.verdict !== "flag" || (scores.autoAction !== "drop" && scores.autoAction !== "hold") || scores.finalStatus !== o.status) return null;
  if (problems.includes("different_product")) return scores.wrongItem?.confirmed === true ? "different_product" : null;
  const { no_text_or_watermark: score, thresholds, evidence } = scores;
  return evidence?.text_or_watermark && typeof score === "number" && typeof thresholds?.no_text_or_watermark === "number" && score < thresholds.no_text_or_watermark ? "text_or_watermark" : null;
}
/** The reason on the older row: what this batch found on the same photo, not a verdict on that older image. */
export const TAKE_DOWN_WHY: Record<TakeDownVerdict, string> = {
  text_or_watermark: "this batch checked the same photo and found a mark on it.",
  different_product: "this batch checked the same photo and two checks found a different item.",
};

/** A hold on a photo with no other photo of the product delivered on its channel. */
export const HOLD_SENTENCE_ALONE = "It has no link yet. Replace it, use it as it is, or remove it.";

/**
 * The operator sentence of an auto decision: the problem first (when known), then what was done. Model-free.
 * `othersDelivered` false: the product has no other photo delivered here, so a hold or a drop does not claim one.
 */
export function autoDecideNote(action: AutoDecideAction, why: string | null, othersDelivered = true): string {
  const lead = why ? `${why.trim()}${/[.!?]$/.test(why.trim()) ? "" : "."} ` : "";
  if (action === "hold") return `${lead}${othersDelivered ? HOLD_SENTENCE : HOLD_SENTENCE_ALONE}`;
  return action === "deliver"
    ? `${lead}${PROVISIONAL_SENTENCE}`
    : `${lead}Left out automatically; this photo gets no link here${othersDelivered ? " and the product's other photos are delivered" : ""}.`;
}
