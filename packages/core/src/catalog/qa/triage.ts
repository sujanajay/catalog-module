import type { ChannelId, OutputFlag } from "../types";

/**
 * Information flags (07 4.6): they never hold the publish gate and never create an attention item on
 * their own. One list for the attention model, the decision scope and the triage below.
 * `complete_product` (the brand's photo is cut at its own frame edge; we never crop) and
 * `transparent` (a cut-out hint) are note-only since judge v2.
 */
export const INFORMATION_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>([
  "low_resolution", "no_shadow_source", "shadow_synthesised", "passthrough", "alpha_source", "qa_sampled_out",
  "numbering_gap", "type_unknown", "complete_product", "transparent",
]);
/** Always held for the operator: a different item confirmed by two judges, or several photos in one. */
export const HARD_HOLD_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["different_product", "collage"]);
/** No verdict exists (the check could not run), so nothing is dropped or published unseen. */
export const UNCHECKED_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["qa_unavailable", "qa_cap"]);
/** Our own rendering defects: the re-render loop (`RepairOwnDefects`) may fix them before triage. */
export const OWN_DEFECT_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["halo", "leftover_background"]);

export const problemFlags = (flags: readonly OutputFlag[]) => flags.filter(flag => !INFORMATION_FLAGS.has(flag));

export type AutoAction = "none" | "note" | "drop" | "hold";
export type HoldCause = "wrong_item" | "collage" | "corrupt" | "unchecked" | "photo_one" | "every_photo" | "not_publishable";
export interface TriageOutput {
  id: string; n: number; channel: ChannelId; status: string; flags: readonly OutputFlag[];
  decision: string | null; stagingUri: string | null;
}
export interface TriageDecision { action: AutoAction; cause?: HoldCause; flags: OutputFlag[] }

/**
 * Turns the problems of one product's outputs in this batch into automatic actions (07 4.1 v2).
 * Hard holds: a confirmed different item, a collage, a corrupt file (status `failed`), photo 1 with
 * a problem, and every photo of a channel with a problem; plus the "no verdict" holds (`qa_cap`,
 * `qa_unavailable`) and an image that cannot be published (not made, or failing the channel rules)
 * when it cannot be dropped. Any other problem is dropped with a note when the photo is not photo 1
 * and at least two good photos remain on that channel, else published with a note.
 * `keptLive` lists (channel, n) pairs whose live image stays unchanged in this batch; they count as good.
 */
export function triageProduct(outputs: readonly TriageOutput[], keptLive: readonly {channel: ChannelId; n: number}[] = []): Map<string, TriageDecision> {
  const shots = [...new Set([...outputs.map(o => o.n), ...keptLive.map(k => k.n)])];
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
    if (!problems.length) { result.set(o.id, {action:o.status === "needs_attention" ? "hold" : "none",flags:[]}); continue; }
    if (problems.includes("different_product")) { hold("wrong_item"); continue; }
    if (problems.includes("collage")) { hold("collage"); continue; }
    if (problems.some(flag => UNCHECKED_FLAGS.has(flag))) { hold("unchecked"); continue; }
    if (o.n === photoOne) { hold("photo_one"); continue; }
    const others = goodShots(o.channel, o.n);
    if (others === 0) { hold("every_photo"); continue; }
    if (others >= 2) { result.set(o.id, {action:"drop",flags:problems}); continue; }
    const publishable = !!o.stagingUri && !problems.includes("failed_compliance") && !problems.includes("fallback_matte");
    if (publishable) result.set(o.id, {action:"note",flags:problems}); else hold("not_publishable");
  }
  return result;
}

export interface RepairCandidate { outputId: string; sourceImageId: string; channel: ChannelId; n: number; flags: OutputFlag[] }
/**
 * Extension point for the re-render-and-re-judge loop (built separately). The QA stage calls it once
 * per product, after judging and before `triageProduct`, with every undecided output whose problems
 * include our own defects (`OWN_DEFECT_FLAGS`). An implementation re-renders those outputs, writes the
 * new staged bytes and `qa_scores` (status `staged`, defect flags cleared when the re-judge passes)
 * and returns the ids it fixed. The QA stage re-reads the rows afterwards, so a fixed output counts as
 * a good photo and is never held, dropped or noted. The default fixes nothing.
 */
export type RepairOwnDefects = (candidates: readonly RepairCandidate[]) => Promise<ReadonlySet<string>>;
export const noRepair: RepairOwnDefects = async () => new Set<string>();
