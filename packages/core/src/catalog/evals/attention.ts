// Attention rate and judge behaviour (spec 10 section 7). On the golden set no product may end in
// "needs attention" unless the manifest says it must (then with exactly the expected flags); the
// planted wrong-item set must be caught in full; a judge flag on an output every deterministic check
// passed is a false positive of the judge and fails on its own id; a photo-level flag must be the
// same on every channel of that photo; placement is never the judge's call; every product leaves
// the batch with a real product type and model photos never get a synthesised shadow.
import { DIMENSION_FLAGS, QA_DIMENSIONS, scoreOf } from "../qa/judge";
import type { ChannelId, OutputFlag } from "../types";
import { judge, notRun, type CheckResult, type CheckSubject, type Expectation } from "./types";

export interface AttentionOutputRow {
  identifier: string; n: number; channel: ChannelId; status: string; flags: OutputFlag[]; reason: string | null;
  qaScores: Record<string, unknown> | null; qaModel?: string | null; decision?: string | null;
  compliance?: { ok: boolean; failures: string[] } | null;
}
export interface AttentionProductRow {
  identifier: string; change: string | null; productType: string | null; expect: Expectation;
  /** A planted wrong item: shot `n` belongs to another product and must be caught as different_product. */
  planted?: { n: number; from: string } | null;
}
/** A per-shot expectation from the manifest, keyed by the batch's own shot number (mapped by source sha256, section 15d). */
export interface AttentionShotRow { identifier: string; n: number; expect: Expectation }
export interface AttentionInput {
  products: AttentionProductRow[];
  outputs: AttentionOutputRow[];
  /**
   * Shots whose manifest entry expects flags without a hold (a size chart left out as `chart_image`): the flags must be
   * raised on that shot and nothing of it published. A hold is judged per product by `attention.expected`.
   */
  shots?: AttentionShotRow[];
  /** Keys (identifier|channel|n) of outputs whose deterministic image checks all passed. */
  deterministicPass: Set<string>;
  /** The judge ran live (otherwise its verdicts are canned and never assessed). */
  liveJudge: boolean;
  threshold: number;
}
export interface AttentionSummary {
  results: CheckResult[];
  /** Products with an undecided needs_attention or failed output at batch end (expected ones excluded). */
  attentionProducts: number;
  /** attentionProducts divided by products in the batch. */
  attentionRate: number;
  expectedAttention: number;
  /** Holds every deterministic check passed (what a person would resolve with "Use as is") divided by all holds. */
  falseHoldRate: number | null;
  /** Holds already resolved with "Use as is" divided by all holds (from the decision column). */
  useAsIsRate: number | null;
  plantedCaught: number;
  plantedTotal: number;
}

/** Flags that never hold a product (SPEC.md "Other flags" and the cut-source rule of spec 10 section 7): they ride along on a held output without being its reason. */
export const INFORMATION_FLAGS: ReadonlySet<string> = new Set(["low_resolution", "no_shadow_source", "shadow_synthesised", "passthrough", "matte_passthrough", "alpha_source", "qa_sampled_out", "cut_in_source", "numbering_gap", "upscaled"]);
/** Flags that legitimately differ between channels of one photo (spec 07 decision scope). */
export const CHANNEL_SPECIFIC_FLAGS: ReadonlySet<string> = new Set(["placement", "failed_compliance", "low_resolution", "passthrough", "upscaled"]);
export const outputKey = (identifier: string, ch: ChannelId, n: number) => `${identifier}|${ch}|${n}`;
const held = (o: AttentionOutputRow) => (o.status === "needs_attention" || o.status === "failed") && !o.decision;
const problemFlags = (o: AttentionOutputRow) => o.flags.filter(f => !INFORMATION_FLAGS.has(f));
/**
 * Flags only the judge raises. A manifest entry detected by code may still list one (the candle Z011CB57531CA8FA0CBDDZ n=1:
 * held by the render for `leftover_background`, and by the judge for `text_or_watermark`); on a mocked run that flag is
 * neither required nor unexpected, the code-detected ones still are.
 */
export const JUDGE_ONLY_FLAGS: ReadonlySet<string> = new Set(["complete_product", "different_product", "halo", "text_or_watermark", "collage", "orientation"]);
/** A judging that carries one of these returned no verdict (the judge could not be reached, or the spending limit stopped it). */
export const NO_VERDICT_FLAGS: readonly string[] = ["qa_unavailable", "qa_cap"];

export function checkAttention(input: AttentionInput): AttentionSummary {
  const A = "attention" as const, results: CheckResult[] = [];
  let attentionProducts = 0, expectedAttention = 0, plantedCaught = 0, plantedTotal = 0;
  const all: CheckSubject = { identifier: "*", n: null, channel: null };
  for (const product of input.products) {
    const who: CheckSubject = { identifier: product.identifier, n: null, channel: null };
    const rows = input.outputs.filter(o => o.identifier === product.identifier);
    const problems = rows.filter(held);
    const isHeld = product.change === "pending_attention" || problems.length > 0;
    const listed = problems.map(o => `image ${o.n} for ${o.channel}: ${problemFlags(o).join(", ") || o.status}${o.reason ? ` (${o.reason})` : ""}`);
    results.push(judge(!!product.productType && product.productType !== "auto", "attention.product_type_set", A, who, product.productType ?? "null", "footwear | apparel_model | apparel_flat | bag_accessory | other", "type", product.productType && product.productType !== "auto" ? `Product type ${product.productType}.` : "The product left the batch without a detected product type (the classifier did not run)."));
    if (product.planted) {
      plantedTotal++;
      if (!input.liveJudge) { results.push(notRun("attention.planted_caught", A, who, "Wrong-item detection needs the live judge.")); continue; }
      const caught = rows.filter(o => o.n === product.planted!.n && o.flags.includes("different_product") && held(o));
      const wrongShot = rows.filter(o => o.n !== product.planted!.n && o.flags.includes("different_product"));
      if (caught.length) plantedCaught++;
      results.push(judge(caught.length > 0 && !wrongShot.length, "attention.planted_caught", A, { ...who, n: product.planted.n }, caught.length ? "caught" : "missed", "caught", "wrong item", caught.length ? (wrongShot.length ? `The planted photo was caught but image ${wrongShot[0]!.n} was also called a different product.` : `The planted ${product.planted.from} photo was held as a different product.`) : `The planted ${product.planted.from} photo under ${product.identifier} went to the sheet.`));
      continue;
    }
    if (!product.expect.attention) {
      if (isHeld) attentionProducts++;
      results.push(judge(!isHeld, "attention.not_held", A, who, listed.length, 0, "problem photos", isHeld ? `Needs attention: ${listed.join("; ")}` : "Went straight to the sheet."));
      continue;
    }
    expectedAttention++;
    if (product.expect.detector === "judge" && !input.liveJudge) { results.push(notRun("attention.expected", A, who, "This case is detected by the judge, which did not run live.")); continue; }
    const raised = new Set(rows.flatMap(o => o.flags));
    const missing = product.expect.flags.filter(f => !raised.has(f) && (input.liveJudge || !JUDGE_ONLY_FLAGS.has(f)));
    const unexpected = [...new Set(problems.flatMap(problemFlags))].filter(f => !product.expect.flags.includes(f) && (input.liveJudge || !JUDGE_ONLY_FLAGS.has(f)));
    results.push(judge(isHeld && !missing.length && !unexpected.length, "attention.expected", A, who, `${isHeld ? "held" : "not held"}; flags ${[...raised].join(",") || "none"}`, `held with ${product.expect.flags.join(",")}`, "flags", !isHeld ? `Expected the pipeline to hold this product (${product.expect.flags.join(", ")}) but it went to the sheet.` : missing.length ? `Expected flags missing: ${missing.join(", ")}.` : unexpected.length ? `Unexpected flags: ${unexpected.join(", ")}.` : "Held with exactly the expected flags."));
  }
  // Per-shot expected flags without a hold (eval run 3, penti: the size chart Z659062EFB3FB0720BF56Z n=7, renumbered 6 by the
  // batch, was published on every channel as a pass-through instead of left out as chart_image, and carried no expectation).
  for (const shot of input.shots ?? []) {
    const required = shot.expect.flags.filter(f => input.liveJudge || !JUDGE_ONLY_FLAGS.has(f));
    const rows = input.outputs.filter(o => o.identifier === shot.identifier && o.n === shot.n);
    if (!required.length || !rows.length) continue;
    const who: CheckSubject = { identifier: shot.identifier, n: shot.n, channel: null };
    const raised = new Set(rows.flatMap(o => o.flags)), missing = required.filter(f => !raised.has(f)), published = rows.filter(o => o.status === "verified" || o.status === "staged");
    if (shot.expect.attention) {
      // A per-shot hold expectation (the lifestyle candle's shot 1; a judge-detected flag on a shot whose product a sibling
      // holds): the flags must be raised on that shot's own rows, held or staged under the product's hold, so a manifest line
      // that expects a flag the judge rightly never raises fails by name instead of passing silently under the sibling hold
      // (live run D2, french_connection.other, section 15e). Whether the product holds is attention.expected's call.
      results.push(judge(!missing.length, "attention.expected_flags", A, who, `flags ${[...raised].join(",") || "none"}`, `${required.join(",")}, on a held or staged shot`, "flags", missing.length ? `Expected flags missing on image ${shot.n}: ${missing.join(", ")} (the manifest expects this shot held for them${shot.expect.reason ? `: ${shot.expect.reason}` : ""}).` : `Image ${shot.n} carries ${required.join(", ")} as the manifest expects.`));
      continue;
    }
    results.push(judge(!missing.length && !published.length, "attention.expected_flags", A, who, `flags ${[...raised].join(",") || "none"}; ${published.length} of ${rows.length} outputs published`, `${required.join(",")}, left out`, "flags", missing.length ? `Expected flags missing on image ${shot.n}: ${missing.join(", ")}${published.length ? ` (${published.length} outputs published instead of left out)` : ""}${shot.expect.reason ? `. ${shot.expect.reason}` : "."}` : published.length ? `Image ${shot.n} carries ${required.join(", ")} but ${published.length} outputs were published instead of left out.` : `Image ${shot.n} carries ${required.join(", ")} as the manifest expects and nothing of it was published.`));
  }
  if (plantedTotal && input.liveJudge) results.push(judge(plantedCaught === plantedTotal, "attention.planted_rate", A, all, `${plantedCaught} of ${plantedTotal}`, `${plantedTotal} of ${plantedTotal}`, "planted wrong items caught", "Every planted wrong item must be caught."));

  // Consistency across channels: a photo-level flag and its hold apply to every channel of that photo.
  const byPhoto = new Map<string, AttentionOutputRow[]>();
  for (const o of input.outputs) if (o.status !== "skipped") { const k = `${o.identifier}|${o.n}`; byPhoto.set(k, [...byPhoto.get(k) ?? [], o]); }
  for (const [k, rows] of byPhoto) {
    if (rows.length < 2) continue;
    const [identifier, n] = k.split("|");
    const sets = rows.map(o => problemFlags(o).filter(f => !CHANNEL_SPECIFIC_FLAGS.has(f)).sort().join(","));
    const holds = rows.map(o => held(o) && problemFlags(o).some(f => !CHANNEL_SPECIFIC_FLAGS.has(f)));
    const consistent = new Set(sets).size === 1 && new Set(holds).size === 1;
    if (!consistent) results.push(judge(false, "attention.channel_consistent", A, { identifier: identifier!, n: Number(n), channel: null }, rows.map(o => `${o.channel}: ${o.status}${sets[rows.indexOf(o)] ? ` [${sets[rows.indexOf(o)]}]` : ""}`).join("; "), "same on every channel", "flags", "The same photo was judged differently on different channels."));
  }
  results.push(judge(!results.some(r => r.id === "attention.channel_consistent"), "attention.channel_consistency", A, all, results.filter(r => r.id === "attention.channel_consistent").length, 0, "inconsistent photos", "Photo-level flags apply to every channel of the photo."));

  // Placement is decided by code (styli_anchor compliance), never by the model.
  const placementByJudge = input.outputs.filter(o => o.flags.includes("placement") && !(o.compliance && !o.compliance.ok && o.compliance.failures.some(f => f.startsWith("styli_anchor"))));
  results.push(judge(placementByJudge.length === 0, "attention.placement_not_judged", A, all, placementByJudge.length, 0, "outputs", placementByJudge.length ? `${placementByJudge.length} outputs carry a placement flag that did not come from the code check: ${placementByJudge.slice(0, 3).map(o => `${o.identifier} ${o.channel} ${o.n}`).join("; ")}.` : "No placement flag came from the model."));

  // Model photos never get a synthesised shadow.
  const synthOnModel = input.outputs.filter(o => o.flags.includes("shadow_synthesised") && input.products.find(p => p.identifier === o.identifier)?.productType === "apparel_model");
  results.push(judge(synthOnModel.length === 0, "shadow.synthesised_on_model", "shadow", all, synthOnModel.length, 0, "outputs", synthOnModel.length ? `${synthOnModel.length} apparel-on-model outputs carry a synthesised shadow: ${synthOnModel.slice(0, 3).map(o => `${o.identifier} ${o.channel} ${o.n}`).join("; ")}.` : "No synthesised shadow on model photos."));

  // Judge false positives and the false-hold rate.
  const holds = input.outputs.filter(o => o.status === "needs_attention" || o.status === "failed");
  const useAsIs = holds.filter(o => o.decision === "use_as_is").length;
  const falseHolds = holds.filter(o => input.deterministicPass.has(outputKey(o.identifier, o.channel, o.n)) && !input.products.find(p => p.identifier === o.identifier)?.expect.attention && !input.products.find(p => p.identifier === o.identifier)?.planted).length;
  const falseHoldRate = holds.length ? falseHolds / holds.length : null, useAsIsRate = holds.length ? useAsIs / holds.length : null;
  results.push(judge(falseHolds === 0, "attention.false_hold_rate", A, all, falseHoldRate === null ? "no holds" : Math.round(falseHoldRate * 1000) / 1000, 0, "false holds / holds", holds.length ? `${falseHolds} of ${holds.length} holds pass every deterministic check (a person would click "Use as is"); ${useAsIs} were already resolved that way.` : "No output was held."));
  if (!input.liveJudge) results.push(notRun("attention.judge_false_positive", A, all, "The judge did not run live; its verdicts were canned."));
  else for (const o of input.outputs) {
    const scores = o.qaScores;
    if (!scores || scores.verdict !== "flag") continue;
    const product = input.products.find(p => p.identifier === o.identifier);
    if (product?.expect.attention) continue;
    const who: CheckSubject = { identifier: o.identifier, n: o.n, channel: o.channel };
    // A judging that returned no verdict (live run D2, section 15e: 14 judge_false_positive rows on outputs the judge never read,
    // held on a 429 with zeroed scores) is counted on its own row, never as a false positive: there is no opinion to be wrong.
    const noVerdict = NO_VERDICT_FLAGS.find(f => o.flags.includes(f as OutputFlag));
    if (noVerdict) { results.push(judge(false, "attention.judge_unavailable", A, who, noVerdict, "a verdict", "judging", `The judge returned no verdict for this output (${noVerdict}${o.reason ? `: ${o.reason}` : ""}) and the output is ${held(o) ? "held without one" : o.status}. A judging without a verdict is not a judge false positive; the hold is the pipeline's, not the judge's.`)); continue; }
    const lowest = QA_DIMENSIONS.map(d => [d, scoreOf(scores, d)] as const).sort((a, b) => a[1] - b[1])[0]!;
    const reasons = Array.isArray(scores.reasons) ? (scores.reasons as unknown[]).map(String).join(" ") : "";
    if (o.flags.includes("different_product") && o.n > 1 && !(product?.planted && product.planted.n === o.n)) results.push(judge(false, "attention.judge_false_same_product", A, who, `same_product ${Number(scores.same_product ?? 0)}`, `>= ${input.threshold}`, "score", `The judge said image ${o.n} does not match photo 1, but it is a sole, back, inside, detail or on-model view of the same golden product. ${reasons}`.trim()));
    if (!input.deterministicPass.has(outputKey(o.identifier, o.channel, o.n)) || (product?.planted && product.planted.n === o.n)) continue;
    // A complete_product note on a source cut at the frame (live run D2: "the skirt runs off the bottom edge of the photo") is true of
    // the photo and the information the spec intends; the code already says the cut is in the original (cut_in_source). It keeps
    // failing on an uncut source, and when the note held the output.
    if (lowest[0] === "complete_product" && o.flags.includes("cut_in_source") && !held(o)) { results.push(judge(true, "attention.judge_false_positive", A, who, `${lowest[0]} ${lowest[1]}`, `>= ${input.threshold}`, "lowest dimension", `The judge noted complete_product ${lowest[1]} on a source cut at the frame (cut_in_source) and the output was published with the note: the sentence is true of the original photo, not a false positive. ${reasons}`.trim())); continue; }
    results.push(judge(false, "attention.judge_false_positive", A, who, `${lowest[0]} ${lowest[1]}`, `>= ${input.threshold}`, "lowest dimension", `The judge flagged an output every deterministic check passed (${lowest[0]} ${lowest[1]}). ${reasons}`.trim()));
  }
  return { results, attentionProducts, attentionRate: input.products.length ? attentionProducts / input.products.length : 0, expectedAttention, falseHoldRate, useAsIsRate, plantedCaught, plantedTotal };
}

/** One row per flag raised, held or not (the report's flag table). The model id is for the JSON report only. */
export interface FlagRow { identifier: string; n: number; channel: ChannelId; flag: string; dimension: string | null; score: number | null; threshold: number; model: string | null; evidence: string; action: string; finalStatus: string; humanLabel: string }
export function flagRows(outputs: AttentionOutputRow[], threshold: number): FlagRow[] {
  const dimensionOf = Object.fromEntries(Object.entries(DIMENSION_FLAGS).map(([d, f]) => [f, d])) as Record<string, string>;
  const rows: FlagRow[] = [];
  for (const o of outputs) for (const flag of o.flags) {
    const dimension = dimensionOf[flag] ?? null, scores = o.qaScores;
    rows.push({ identifier: o.identifier, n: o.n, channel: o.channel, flag, dimension, score: dimension && scores ? Number(scores[dimension] ?? NaN) : null, threshold, model: dimension ? o.qaModel ?? null : null, evidence: o.reason ?? "", action: o.status === "needs_attention" ? "held for a decision" : o.status === "failed" ? "failed, nothing published" : o.status === "skipped" ? "skipped with a note" : "published with a note", finalStatus: o.status, humanLabel: o.decision ?? "" });
  }
  return rows;
}
