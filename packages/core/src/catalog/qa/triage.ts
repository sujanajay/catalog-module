import type { ChannelId, OutputFlag } from "../types";
import { busyBackgroundHold, encoderFault, OWN_DEFECT_FLAGS } from "../auto-resolve";

/**
 * Information flags (07 4.6): they never hold the publish gate and never create an attention item on
 * their own. One list for the attention model, the decision scope and the triage below.
 * `complete_product` (the brand's photo is cut at its own frame edge; we never crop) and
 * `transparent` (a cut-out hint) are note-only since judge v2. `upscaled` (spec 11: the GPU upscaler made the
 * colour of an enlargement beyond its threshold) is a sheet note only.
 */
export const INFORMATION_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>([
  "low_resolution", "no_shadow_source", "shadow_synthesised", "passthrough", "alpha_source", "qa_sampled_out",
  "numbering_gap", "type_unknown", "cut_in_source", "complete_product", "transparent", "auto_dropped",
  "matte_passthrough", "upscaled",
]);
/** Always held for the operator: a different item confirmed by two judges, or several photos in one. */
export const HARD_HOLD_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["different_product", "collage"]);
/**
 * Flags that make the render stage stage an output as `needs_attention` (held before the judge). At the render
 * stage `leftover_background` can only come from the matte stage (a busy background, busyBackgroundHold); the
 * judge raises it later, in the QA stage. Spec 18: `enlargement_failed` (the photo needed the upscaler and has no
 * stored enlargement) holds too, so a plain resize never stands in.
 */
export const RENDER_HOLD_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["small_source", "fallback_matte", "leftover_background", "enlargement_failed"]);
export const holdsAtRender = (flags: readonly OutputFlag[]) => flags.some(flag => RENDER_HOLD_FLAGS.has(flag));
/**
 * Left out with a note, never held: a size chart or text-only image (the judge's `chart` view) is
 * not a product photo for a marketplace, whatever its position or the other photos.
 */
export const LEFT_OUT_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["chart_image"]);
/** No verdict exists (the check could not run), so nothing is dropped or published unseen. */
export const UNCHECKED_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["qa_unavailable", "qa_cap"]);

export const problemFlags = (flags: readonly OutputFlag[]) => flags.filter(flag => !INFORMATION_FLAGS.has(flag));

export type AutoAction = "none" | "note" | "drop" | "hold";
export type HoldCause = "wrong_item" | "collage" | "unusable" | "corrupt" | "unchecked" | "photo_one" | "every_photo" | "not_publishable" | "code_fault" | "not_enlarged";
export interface TriageOutput {
  id: string; n: number; channel: ChannelId; status: string; flags: readonly OutputFlag[];
  decision: string | null; stagingUri: string | null;
  /** The row's `compliance` (its `auto_actions` say whether the matte stage held it for a busy background). */
  compliance?: unknown;
}
export interface TriageDecision { action: AutoAction; cause?: HoldCause; flags: OutputFlag[] }

/**
 * Turns the problems of one product's outputs in this batch into automatic actions (07 4.1 v2).
 * Hard holds: a confirmed different item, a collage, a photo whose background could not be removed
 * (`leftover_background` from the matte stage, busyBackgroundHold), a corrupt file (status `failed`), photo 1 with
 * a problem, and every photo of a channel with a problem; plus the "no verdict" holds (`qa_cap`,
 * `qa_unavailable`) and an image that cannot be published (not made, or failing the channel rules)
 * when it cannot be dropped. Any other problem is dropped with a note when the photo is not photo 1
 * and at least two good photos remain on that channel, else published with a note. Our own defects
 * (`OWN_DEFECT_FLAGS`, still there after the re-render loop) are dropped the same way or held, never noted.
 * A size chart or text-only image (`LEFT_OUT_FLAGS`) is always left out with a note, never held, and
 * photo 1 is the lowest photo that is not one.
 * `keptLive` lists (channel, n) pairs whose live image stays unchanged in this batch; they count as good.
 */
export function triageProduct(outputs: readonly TriageOutput[], keptLive: readonly {channel: ChannelId; n: number}[] = []): Map<string, TriageDecision> {
  const leftOut = (o: TriageOutput) => o.flags.some(flag => LEFT_OUT_FLAGS.has(flag));
  const shots = [...new Set([...outputs.filter(o => !leftOut(o)).map(o => o.n), ...keptLive.map(k => k.n)])];
  const photoOne = shots.length ? Math.min(...shots) : 1;
  const good = (o: TriageOutput) => o.decision === "use_as_is" || ((o.status === "staged" || o.status === "verified") && o.decision === null && !problemFlags(o.flags).length);
  const goodShots = (channel: ChannelId, except: number) => new Set([
    ...outputs.filter(o => o.channel === channel && o.n !== except && good(o)).map(o => o.n),
    ...keptLive.filter(k => k.channel === channel && k.n !== except && !outputs.some(o => o.channel === channel && o.n === k.n)).map(k => k.n),
  ]).size;
  const result = new Map<string, TriageDecision>();
  for (const o of outputs) {
    if (o.decision !== null || (o.status !== "staged" && o.status !== "needs_attention" && o.status !== "failed")) continue;
    const problems = problemFlags(o.flags);
    const hold = (cause: HoldCause) => result.set(o.id, {action:"hold",cause,flags:problems});
    if (o.status === "failed") { hold("corrupt"); continue; }
    if (leftOut(o)) { result.set(o.id, {action:"drop",flags:problems}); continue; }
    if (!problems.length) { result.set(o.id, {action:o.status === "needs_attention" ? "hold" : "none",flags:[]}); continue; }
    if (problems.includes("different_product")) { hold("wrong_item"); continue; }
    if (problems.includes("collage")) { hold("collage"); continue; }
    // Spec 18 owner decision 1: an enlargement that failed holds the product with its reason; never dropped or noted.
    if (problems.includes("enlargement_failed")) { hold("not_enlarged"); continue; }
    // The background could not be removed (code-detected `leftover_background`, busyBackgroundHold): a hard hold.
    if (problems.includes("leftover_background") && busyBackgroundHold(o.compliance)) { hold("unusable"); continue; }
    if (problems.some(flag => UNCHECKED_FLAGS.has(flag))) { hold("unchecked"); continue; }
    // A broken encoder setting (dims, format, ...) survived its re-render: a code fault, not the photo. Held for the
    // technical team, never dropped, so it cannot hide (07 4.6a).
    if (problems.includes("failed_compliance") && encoderFault(o.compliance)) { hold("code_fault"); continue; }
    if (o.n === photoOne) { hold("photo_one"); continue; }
    const others = goodShots(o.channel, o.n);
    if (others === 0) { hold("every_photo"); continue; }
    if (others >= 2) { result.set(o.id, {action:"drop",flags:problems}); continue; }
    // Our own defects (halo, leftover background, a broken channel rule) are never published with a
    // note: the re-render loop already tried, so the photo is dropped above or held here.
    const publishable = !!o.stagingUri && !problems.includes("fallback_matte") && !problems.some(flag => OWN_DEFECT_FLAGS.has(flag));
    if (publishable) result.set(o.id, {action:"note",flags:problems}); else hold("not_publishable");
  }
  return result;
}

export interface RepairCandidate { outputId: string; sourceImageId: string; channel: ChannelId; n: number; flags: OutputFlag[] }
/**
 * The re-render-and-re-judge extension point (07 auto-resolve). The QA stage calls it once per
 * product, after judging and before `triageProduct`, with every undecided output whose problems
 * include our own defects (`OWN_DEFECT_FLAGS`: halo, leftover background, a failed channel rule,
 * placement) or a judge-seen frame cut the detector missed. `context` is the caller's (the worker
 * passes the batch, policy and lease). An implementation re-renders those outputs, writes the new
 * staged bytes, flags and `qa_scores` and returns the ids it fixed; the QA stage re-reads the rows,
 * so a fixed output counts as a good photo. The default fixes nothing.
 */
export type RepairOwnDefects<Context = unknown> = (candidates: readonly RepairCandidate[], context: Context) => Promise<ReadonlySet<string>>;
export const noRepair: RepairOwnDefects = async () => new Set<string>();
