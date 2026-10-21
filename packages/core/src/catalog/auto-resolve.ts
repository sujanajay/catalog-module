import type { ChannelId, OutputFlag } from "./types";
import { ENCODER_CODES, failureCodes, type ComplianceCode } from "./compliance";
import { borderBand } from "./shadow";
import type { RenderMeasured } from "./render";

/**
 * The automatic-resolution loop (07 4.6a): defects we produced are re-made by the pipeline before a
 * product is ever held. This module holds the pure parts: the diagnosis (which repair answers which
 * failure, computed from the measurement where there is one), the bounds and the `auto_actions`
 * record; the worker supplies the rendering, storage and judge.
 */

/**
 * Judge flags that describe our own output (image 2 against image 1), not the brand's photo:
 * `product_removed` (the cut-out took away part of the product), `halo` and `leftover_background`.
 */
export const JUDGED_DEFECT_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["product_removed", "halo", "leftover_background"]);
/** Every defect we produced: the judge's output flags, a failed channel rule and a placement failure. */
export const OWN_DEFECT_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>([...JUDGED_DEFECT_FLAGS, "failed_compliance", "placement"]);
/** Flags the renderer sets; a re-render replaces them with its own. */
export const RENDER_FLAGS: ReadonlySet<OutputFlag> = new Set<OutputFlag>(["low_resolution", "no_shadow_source", "shadow_synthesised", "passthrough", "fallback_matte", "failed_compliance", "cut_in_source", "alpha_source", "small_source", "matte_passthrough", "upscaled"]);

/**
 * The judge saw the brand's photo cut at its own frame edge: the `complete_product` flag, or a
 * `source_cut` dimension (true, or the flag of that name) when the judge reports one. The cut
 * detector then re-runs relaxed (`judgedCut`, render.ts) to place the cut flush (`flush_cut`).
 */
export function judgeSawSourceCut(flags: readonly string[], qaScores?: Record<string, unknown> | null): boolean {
  return flags.includes("complete_product") || flags.includes("source_cut") || qaScores?.source_cut === true;
}

/**
 * The repairs the loop can take. Render-level steps change one channel's render only; matte steps
 * change the photo's shared cut-out and every channel is re-checked afterwards.
 * - `shadow_off`: the contact shadow we added is left out.
 * - `source_shadow_off`: the shadow kept from the source photo is left out.
 * - `refit`: the product is fitted smaller inside the same canvas, by the factor the measurement asks for.
 * - `reshift`: the product is moved by the exact move the Styli guide check measured.
 * - `reencode`: the same pixels saved at a lower JPEG quality (a file over 2 MB).
 * - `re_render`: one plain re-render with the same inputs (a transient encoder fault).
 * - `second_matte`: the policy's second cut-out model (per photo).
 * - `matte_passthrough`: the whole frame kept (matte-guard.ts; per photo, only for `product_removed`).
 */
export const RENDER_STEPS = ["reshift", "reencode", "shadow_off", "source_shadow_off", "refit", "re_render"] as const;
export const MATTE_STEPS = ["second_matte", "matte_passthrough"] as const;
export type RenderStep = typeof RENDER_STEPS[number];
export type MatteStep = typeof MATTE_STEPS[number];
export type RepairStep = RenderStep | MatteStep;
/** Bounds per run: render-level repairs per output, and judge looks per photo (each is an LLM call). */
export const MAX_REPAIRS_PER_OUTPUT = 3;
export const MAX_REJUDGES_PER_PHOTO = 3;
/** A computed refit lands this far inside the box it has to fit (the JPEG encode may ring a pixel or two further). */
export const REFIT_SLACK = 0.01;
/** No refit goes below this factor of the first fit: the product must stay the product, not a stamp. */
export const REFIT_MIN_SCALE = 0.6;
/** The refit factor when no measurement is stored (rows made before the measurement existed). */
export const REFIT_FALLBACK_SCALE = 0.95;
/** The quality floor of the `reencode` repair (the first render stops at JPEG_QUALITY_MIN, 70). */
export const JPEG_QUALITY_REPAIR_MIN = 50;

/** How one output is rendered: the render options the repairs turn. A render never puts a shadow back once a step took it off. */
export interface RenderVariant { synthesiseShadow?: false; keepSourceShadow?: false; matte: "first" | "second" | "passthrough"; fitScale: number; anchorShift?: { dx: number; dy: number }; jpegQualityMin?: number }
export const FIRST_VARIANT: RenderVariant = Object.freeze({ matte: "first", fitScale: 1 });
export interface Repair { step: RepairStep; scope: "output" | "photo"; variant: RenderVariant; /** Short technical note for the record; never shown to operators. */ why: string }

export interface Diagnosis {
  channel: ChannelId;
  /** The flags that started the loop on this output: `failed_compliance` and/or the judge's own-defect flags. */
  trigger: readonly OutputFlag[];
  /** The compliance failures of the current render ("code: sentence"). */
  failures: readonly string[];
  /** What the current render measured; null for rows made before the measurement existed. */
  measured: RenderMeasured | null;
  /** The output's current render options. */
  current: RenderVariant;
  /** Steps already taken for this output (this run and earlier runs). */
  tried: readonly AutoActionKind[];
  /** A second cut-out model may exist for this photo (the worker still checks the service). */
  secondMatte: boolean;
}

const REPEATABLE: ReadonlySet<RepairStep> = new Set<RepairStep>(["reshift", "refit"]);
const delta = (m: RenderMeasured | null) => m?.anchorDelta && (m.anchorDelta.dx || m.anchorDelta.dy) ? m.anchorDelta : null;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The repairs for one output, from what failed and what was measured, cheapest first, never a step
 * already tried. Render-level steps (one channel) come before matte steps (the whole photo). The
 * worker takes them in order and re-diagnoses after each.
 */
export function diagnoseOutput(d: Diagnosis): Repair[] {
  const out: Repair[] = [], tried = new Set(d.tried), has = (step: RepairStep) => out.some(r => r.step === step);
  // A computed move or fit may run again on a residual (the fade after a shift, ringing after a fit), within the output bound; every other step runs once.
  const add = (step: RepairStep, scope: Repair["scope"], variant: Partial<RenderVariant>, why: string) => { if ((REPEATABLE.has(step) || !tried.has(step)) && !has(step)) out.push({ step, scope, variant: { ...d.current, ...variant }, why }); };
  const m = d.measured, codes = new Set<ComplianceCode>(failureCodes(d.failures));
  const shadow = m?.shadow ?? "none";
  // A drawn shadow comes off before anything else moves: it is the usual reason a margin or the band is breached.
  const shadowOff = (why: string) => {
    if (shadow === "synthesised") add("shadow_off", "output", { synthesiseShadow: false }, why);
    else if (shadow === "kept") add("source_shadow_off", "output", { keepSourceShadow: false, synthesiseShadow: false }, why);
  };
  // The factor that puts the seen box inside the box it has to fit (both axes), with the slack; null without a measurement.
  const refit = (why: string, factor: number | null) => {
    const f = factor === null ? REFIT_FALLBACK_SCALE : Math.min(1, factor) * (1 - REFIT_SLACK);
    const next = Math.max(REFIT_MIN_SCALE, round3(d.current.fitScale * f));
    if (next < d.current.fitScale) add("refit", "output", { fitScale: next }, `${why} -> fit ${next}`);
  };
  const reshift = (why: string) => { const a = delta(m); if (!a) return false; const prev = d.current.anchorShift ?? { dx: 0, dy: 0 }; add("reshift", "output", { anchorShift: { dx: prev.dx + a.dx, dy: prev.dy + a.dy } }, `${why}: dx ${a.dx}, dy ${a.dy}`); return true; };
  if (codes.has("styli_anchor")) reshift("styli_anchor");
  if (codes.has("bytes")) add("reencode", "output", { jpegQualityMin: JPEG_QUALITY_REPAIR_MIN }, `bytes: ${m?.bytes ?? "over 2 MB"}, quality floor ${JPEG_QUALITY_REPAIR_MIN}`);
  if (codes.has("inside_safe_box")) {
    shadowOff(`inside_safe_box: ${shadow} shadow drawn`);
    refit("inside_safe_box", m?.seen ? Math.min(m.safe.w / m.seen.w, m.safe.h / m.seen.h) : null);
  }
  if (codes.has("noon_wide")) refit("noon_wide", m?.seen ? 0.9 * m.canvas.w / m.seen.w : null);
  if (codes.has("background")) {
    shadowOff(`background: ${shadow} shadow drawn`);
    // Without a shadow the breach is the product's own ringing: the seen box must clear the border band (compliance's borderBand).
    if (m?.seen && m.bandBreach) { const band = borderBand(m.canvas.w, m.canvas.h); refit("background", Math.min((m.canvas.w - 2 * band.x) / m.seen.w, (m.canvas.h - 2 * band.y) / m.seen.h)); }
    else refit("background", null);
  }
  for (const code of ENCODER_CODES) if (codes.has(code)) add("re_render", "output", {}, `${code}: encoder settings, one plain re-render`);
  // The judge's own-defect flags.
  if (d.trigger.includes("leftover_background")) shadowOff("leftover_background: a drawn shadow reads as background");
  if (d.trigger.includes("placement") && !reshift("placement")) add("re_render", "output", {}, "placement: re-placed by rule");
  if (d.secondMatte && d.current.matte === "first" && (d.trigger.includes("halo") || d.trigger.includes("leftover_background") || d.trigger.includes("product_removed"))) add("second_matte", "photo", { matte: "second" }, "second cut-out model");
  if (d.trigger.includes("product_removed")) add("matte_passthrough", "photo", { matte: "passthrough" }, "the whole frame kept");
  // Cheapest first: a move or a re-encode before a shadow change, a refit, a plain re-render, then the matte steps.
  const order: RepairStep[] = [...RENDER_STEPS, ...MATTE_STEPS];
  return out.sort((a, b) => order.indexOf(a.step) - order.indexOf(b.step));
}

/** Every step a record may carry: the repairs, the matte stage's integrity ladder (`matte_check`, `padded_matte`), `flush_cut`, `matte_retry`, and the retired ladder's `smaller_fit` and `apply` on old rows. */
export type AutoActionKind = RepairStep | "smaller_fit" | "flush_cut" | "matte_retry" | "apply" | "matte_check" | "padded_matte";
/** One entry of an output's `auto_actions` list (kept in `catalog_outputs.compliance`, no schema change). */
export interface AutoAction {
  step: AutoActionKind;
  /** The flags that started the loop. */
  trigger: OutputFlag[];
  result: "passed" | "failed" | "skipped";
  /** The channels the step was checked on (a render step: the one channel it changed). */
  channels: ChannelId[];
  /** True when the judge looked at the step's output (at most once per step). */
  rejudged: boolean;
  /** A short technical note for the report and evals; never shown to operators. */
  detail?: string;
}

/** Stop the loop (for example the judge's spending limit was reached); the photo keeps its flags. */
export class LadderStopped extends Error {}

/** The loop's triggers among an output's flags, in a stable order. */
export const ownDefects = (flags: readonly OutputFlag[]): OutputFlag[] => [...new Set(flags.filter(flag => OWN_DEFECT_FLAGS.has(flag)))];

/** The `auto_actions` list recorded on an output (empty when none). */
export function autoActionsOf(compliance: unknown): AutoAction[] {
  const list = (compliance as { auto_actions?: unknown } | null | undefined)?.auto_actions;
  return Array.isArray(list) ? list as AutoAction[] : [];
}
/**
 * The steps recorded on an output that touched its own channel: its render repairs and the photo's matte
 * steps. Every output of a photo carries the photo's whole record, so a repair made on another channel is
 * left out here: it was not tried on this one (07 4.6a, a fix applies only to the failing channel).
 */
export function actionsOn(compliance: unknown, channel: ChannelId): AutoAction[] {
  return autoActionsOf(compliance).filter(action => !Array.isArray(action.channels) || action.channels.includes(channel));
}
/** The compliance measurement recorded on an output (null on rows made before it existed). */
export function measuredOf(compliance: unknown): RenderMeasured | null {
  const m = (compliance as { measured?: unknown } | null | undefined)?.measured;
  return m && typeof m === "object" ? m as RenderMeasured : null;
}
/**
 * The render options a repaired output was last made with (kept in `compliance.variant`, relative to the photo's
 * stored matte, so `matte` is always "first"); the first render's options on a row never repaired.
 */
export function variantOf(compliance: unknown): RenderVariant {
  const v = (compliance as { variant?: Partial<RenderVariant> } | null | undefined)?.variant;
  return v && typeof v === "object" ? { ...FIRST_VARIANT, ...v, matte: "first" } : { ...FIRST_VARIANT };
}
/** The compliance failures recorded on an output ("code: sentence"). */
export function failuresOf(compliance: unknown): string[] {
  const list = (compliance as { failures?: unknown } | null | undefined)?.failures;
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
}
/** The output breaks a rule our own encoder settings decide (a code fault, not the photo): held, never dropped (07 4.6a). */
export const encoderFault = (compliance: unknown): boolean => failureCodes(failuresOf(compliance)).some(code => ENCODER_CODES.includes(code));
/**
 * The matte stage held this photo because its background is busy (matte-guard.ts `busyBackground`): its
 * `matte_passthrough` step failed with the trigger `leftover_background`. The same flag the judge raises for
 * a leftover background, but code-detected: a hard hold (triage), never re-made by the repair loop.
 */
export function busyBackgroundHold(compliance: unknown): boolean {
  return autoActionsOf(compliance).some(a => a.step === "matte_passthrough" && a.result === "failed" && a.trigger.includes("leftover_background"));
}
/** `compliance` with more actions appended to its `auto_actions` list. */
export function withAutoActions(compliance: Record<string, unknown> | null | undefined, actions: readonly AutoAction[]): Record<string, unknown> {
  return { ...(compliance ?? {}), auto_actions: [...autoActionsOf(compliance), ...actions] };
}
