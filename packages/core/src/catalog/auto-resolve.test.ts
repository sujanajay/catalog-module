import { describe, expect, it } from "vitest";
import { diagnoseOutput, FIRST_VARIANT, JPEG_QUALITY_REPAIR_MIN, REFIT_FALLBACK_SCALE, REFIT_MIN_SCALE, variantOf, type Diagnosis } from "./auto-resolve";
import type { RenderMeasured } from "./render";
import { plainFailures, triedSentence } from "./qa/reasons";

// 07 4.6a: the repair is picked from the failure and computed from the measurement, per channel.
const NO_CUT = { top: false, bottom: false, left: false, right: false };
const measured = (over: Partial<RenderMeasured> = {}): RenderMeasured => ({ canvas: { w: 1080, h: 1480 }, safe: { x: 0, y: 148, w: 1080, h: 1184 }, seen: { x: 100, y: 140, w: 880, h: 1200 }, outside: { top: 8, bottom: 8, left: 0, right: 0 }, anchorDelta: null, bandBreach: false, bytes: 500_000, shadow: "none", cut: NO_CUT, ...over });
const diagnosis = (over: Partial<Diagnosis>): Diagnosis => ({ channel: "noon", trigger: ["failed_compliance"], failures: [], measured: measured(), current: { ...FIRST_VARIANT }, tried: [], secondMatte: true, ...over });
const steps = (d: Diagnosis) => diagnoseOutput(d).map(r => `${r.step}:${r.scope}`);

describe("diagnoseOutput: the repair answers the failure", () => {
  it("a Styli guide miss is a re-shift by the exact measured delta, nothing else", () => {
    const d = diagnosis({ channel: "styli", failures: ["styli_anchor: The product must be centred on the Styli bottom guide."], measured: measured({ anchorDelta: { dx: 2, dy: -7 } }) });
    const [repair, ...rest] = diagnoseOutput(d);
    expect(rest).toEqual([]);
    expect(repair).toMatchObject({ step: "reshift", scope: "output", variant: { anchorShift: { dx: 2, dy: -7 }, fitScale: 1 } });
    // A second miss adds to the move already made.
    expect(diagnoseOutput({ ...d, current: { ...FIRST_VARIANT, anchorShift: { dx: 2, dy: -7 } }, measured: measured({ anchorDelta: { dx: 0, dy: 1 } }) })[0]!.variant.anchorShift).toEqual({ dx: 2, dy: -6 });
  });

  it("a margin breach with a drawn shadow takes that shadow off first, then fits by the measured overflow", () => {
    const synthesised = diagnosis({ failures: ["inside_safe_box: The product or shadow reaches outside the required margins."], measured: measured({ shadow: "synthesised" }) });
    expect(steps(synthesised)).toEqual(["shadow_off:output", "refit:output"]);
    expect(diagnoseOutput(synthesised)[0]!.variant).toMatchObject({ synthesiseShadow: false, fitScale: 1 });
    const kept = diagnosis({ failures: ["inside_safe_box: x"], measured: measured({ shadow: "kept" }) });
    expect(diagnoseOutput(kept)[0]).toMatchObject({ step: "source_shadow_off", variant: { keepSourceShadow: false, synthesiseShadow: false } });
    // The seen box is 1200 tall in a 1184 safe box: the fit is 1184 / 1200 less the slack, to three decimals.
    const none = diagnosis({ failures: ["inside_safe_box: x"] });
    expect(diagnoseOutput(none)).toEqual([expect.objectContaining({ step: "refit", variant: expect.objectContaining({ fitScale: 0.977 }) })]);
    // Already fitted once: the next fit compounds on the current one and never goes under the floor.
    expect(diagnoseOutput({ ...none, current: { ...FIRST_VARIANT, fitScale: 0.61 } })[0]!.variant.fitScale).toBe(REFIT_MIN_SCALE);
  });

  it("a file over 2 MB is re-encoded, never re-fitted; encoder-setting codes get one plain re-render", () => {
    expect(diagnoseOutput(diagnosis({ failures: ["bytes: Could not get x under 2 MB."] }))).toEqual([expect.objectContaining({ step: "reencode", variant: expect.objectContaining({ jpegQualityMin: JPEG_QUALITY_REPAIR_MIN }) })]);
    expect(steps(diagnosis({ failures: ["dims: The image dimensions do not meet this marketplace's canvas rules."] }))).toEqual(["re_render:output"]);
    expect(steps(diagnosis({ failures: ["dims: x"], tried: ["re_render"] }))).toEqual([]);
  });

  it("a wide Noon shot inside its 5% margins is fitted to 90% of the width; a band breach without a shadow is fitted to clear the band", () => {
    expect(diagnoseOutput(diagnosis({ failures: ["noon_wide: x"], measured: measured({ seen: { x: 20, y: 400, w: 1040, h: 600 } }) }))[0]!.variant.fitScale).toBe(0.925);
    const band = diagnosis({ failures: ["background: x"], measured: measured({ bandBreach: true, seen: { x: 10, y: 10, w: 1060, h: 1460 } }) });
    expect(diagnoseOutput(band)[0]!.variant.fitScale).toBeLessThan(1);
    // Without a measurement (an old row) the fallback factor applies.
    expect(diagnoseOutput(diagnosis({ failures: ["background: x"], measured: null }))[0]!.variant.fitScale).toBe(Math.round(REFIT_FALLBACK_SCALE * 1000) / 1000);
  });

  it("the judge's flags: a leftover background takes the drawn shadow off before the second cut-out; a halo has only the second cut-out; product_removed ends in the pass-through", () => {
    expect(steps(diagnosis({ trigger: ["leftover_background"], measured: measured({ shadow: "synthesised" }) }))).toEqual(["shadow_off:output", "second_matte:photo"]);
    expect(steps(diagnosis({ trigger: ["halo"] }))).toEqual(["second_matte:photo"]);
    expect(steps(diagnosis({ trigger: ["halo"], secondMatte: false }))).toEqual([]);
    expect(steps(diagnosis({ trigger: ["product_removed"], tried: ["second_matte"] }))).toEqual(["matte_passthrough:photo"]);
    // A step already taken is never offered again, in this run or a later one.
    expect(steps(diagnosis({ trigger: ["product_removed"], tried: ["second_matte", "matte_passthrough"] }))).toEqual([]);
  });

  it("a judge placement flag re-shifts when the check measured a delta, else re-renders once", () => {
    expect(steps(diagnosis({ channel: "styli", trigger: ["placement"], measured: measured({ anchorDelta: { dx: 0, dy: 3 } }) }))).toEqual(["reshift:output"]);
    expect(steps(diagnosis({ trigger: ["placement"] }))).toEqual(["re_render:output"]);
  });

  it("the options a repaired row was made with are read back relative to the stored matte", () => {
    expect(variantOf(null)).toEqual(FIRST_VARIANT);
    expect(variantOf({ variant: { matte: "second", fitScale: 0.9, synthesiseShadow: false } })).toEqual({ matte: "first", fitScale: 0.9, synthesiseShadow: false });
  });
});

describe("operator copy for repairs", () => {
  it("names the rule in plain words, never its code, and says what was tried", () => {
    expect(plainFailures(["inside_safe_box: The product or shadow reaches outside the required margins.", "bytes: x", "inside_safe_box: y"], "Noon")).toBe("the product reaches into the margins Noon requires; the file is larger than the 2 MB this marketplace allows");
    expect(plainFailures(["dims: x"], "Trendyol")).toBe("the file format or size is not what Trendyol accepts");
    expect(plainFailures([])).toBe("");
    expect(triedSentence(["shadow_off", "refit", "refit"])).toBe("We tried the added shadow removed and a smaller fit and could not fix it.");
    expect(triedSentence(["second_matte"])).toBe("We tried a second cut-out and could not fix it.");
    expect(triedSentence(["matte_check", "flush_cut"])).toBe("");
    for (const text of [plainFailures(["styli_anchor: x", "noon_wide: y", "background: z"]), triedSentence(["source_shadow_off", "reshift", "reencode", "matte_passthrough"])]) expect(text).not.toMatch(/_|birefnet|bria|gemini/);
  });
});
