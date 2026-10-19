import type { ChannelId, OutputFlag } from "./types";

/**
 * The automatic-resolution loop (07 auto-resolve): defects we produced are re-made by the pipeline
 * before a product is ever held. This module holds the pure parts (steps, variants, the ladder
 * runner and the `auto_actions` record); the worker supplies the rendering, storage and judge.
 */

/** Judge flags that describe our own output (image 2 against image 1), not the brand's photo. */
export const JUDGED_DEFECT_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["halo", "leftover_background"]);
/** Every defect we produced: the judge's output flags, a failed channel rule and a placement failure. */
export const OWN_DEFECT_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>([...JUDGED_DEFECT_FLAGS, "failed_compliance", "placement"]);
/** Flags the renderer sets; a re-render replaces them with its own. */
export const RENDER_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["low_resolution", "no_shadow_source", "shadow_synthesised", "passthrough", "fallback_matte", "failed_compliance", "cut_in_source", "alpha_source", "small_source"]);

/** Ordered, bounded: at most these three steps per photo, and at most one re-judge per step. */
export const LADDER_STEPS = ["shadow_off", "second_matte", "smaller_fit"] as const;
export type LadderStep = typeof LADDER_STEPS[number];
/** Step (c): the product is fitted 5% smaller inside the same canvas. */
export const SMALLER_FIT_SCALE = 0.95;
/**
 * The judge saw the brand's photo cut at its own frame edge: the `complete_product` flag, or a
 * `source_cut` dimension (true, or the flag of that name) when the judge reports one. The cut
 * detector then re-runs relaxed (`judgedCut`, render.ts) to place the cut flush (`flush_cut`).
 */
export function judgeSawSourceCut(flags: readonly string[], qaScores?: Record<string, unknown> | null): boolean {
  return flags.includes("complete_product") || flags.includes("source_cut") || qaScores?.source_cut === true;
}

/** How one step re-renders. A synthesised shadow is never needed to fix anything, so it stays off after step (a). */
export interface StepVariant { synthesiseShadow: false; matte: "first" | "second"; fitScale: number }
export function stepVariant(step: LadderStep): StepVariant {
  if (step === "second_matte") return { synthesiseShadow: false, matte: "second", fitScale: 1 };
  if (step === "smaller_fit") return { synthesiseShadow: false, matte: "first", fitScale: SMALLER_FIT_SCALE };
  return { synthesiseShadow: false, matte: "first", fitScale: 1 };
}

export type AutoActionKind = LadderStep | "flush_cut" | "matte_retry" | "apply";
/** One entry of an output's `auto_actions` list (kept in `catalog_outputs.compliance`, no schema change). */
export interface AutoAction {
  step: AutoActionKind;
  /** The flags that started the loop. */
  trigger: OutputFlag[];
  result: "passed" | "failed" | "skipped";
  /** The channels the step was checked on (or applied to, for `apply`). */
  channels: ChannelId[];
  /** True when the judge looked at the step's output (at most once per step). */
  rejudged: boolean;
  /** A short technical note for the report and evals; never shown to operators. */
  detail?: string;
}

export interface StepOutcome { passed: boolean; skipped?: boolean; rejudged?: boolean; detail?: string }
/** Stop the ladder (for example the judge's spending limit was reached); the photo keeps its flags. */
export class LadderStopped extends Error {}

/**
 * Runs the steps in order until one passes. `attempt` re-renders the failing channels with the
 * step's variant, re-runs the compliance checks and, when the judge flagged the photo, re-judges
 * once. A skipped step (nothing to change, such as no synthesised shadow) costs nothing.
 */
export async function runLadder(trigger: readonly OutputFlag[], channels: readonly ChannelId[], attempt: (step: LadderStep) => Promise<StepOutcome>): Promise<{ winner: LadderStep | null; actions: AutoAction[] }> {
  const actions: AutoAction[] = [];
  for (const step of LADDER_STEPS) {
    let outcome: StepOutcome;
    try { outcome = await attempt(step); }
    catch (error) {
      if (!(error instanceof LadderStopped)) throw error;
      actions.push({ step, trigger: [...trigger], result: "failed", channels: [...channels], rejudged: false, detail: error.message });
      return { winner: null, actions };
    }
    actions.push({ step, trigger: [...trigger], result: outcome.skipped ? "skipped" : outcome.passed ? "passed" : "failed", channels: [...channels], rejudged: !!outcome.rejudged, ...(outcome.detail ? { detail: outcome.detail } : {}) });
    if (outcome.passed && !outcome.skipped) return { winner: step, actions };
  }
  return { winner: null, actions };
}

/** The ladder's triggers among an output's flags, in a stable order. */
export const ownDefects = (flags: readonly OutputFlag[]): OutputFlag[] => [...new Set(flags.filter(flag => OWN_DEFECT_FLAGS.has(flag)))];

/** The `auto_actions` list recorded on an output (empty when none). */
export function autoActionsOf(compliance: unknown): AutoAction[] {
  const list = (compliance as { auto_actions?: unknown } | null | undefined)?.auto_actions;
  return Array.isArray(list) ? list as AutoAction[] : [];
}
/** `compliance` with more actions appended to its `auto_actions` list. */
export function withAutoActions(compliance: Record<string, unknown> | null | undefined, actions: readonly AutoAction[]): Record<string, unknown> {
  return { ...(compliance ?? {}), auto_actions: [...autoActionsOf(compliance), ...actions] };
}
