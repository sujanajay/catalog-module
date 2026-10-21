import { describe, expect, it } from "vitest";
import { renderSource } from "../render";
import { CHANNEL_IDS, type OutputFlag } from "../types";
import { buildContext } from "./context";
import { checkCutEdge, cutBandNote, CUT_SOURCE_FLAGS } from "./cut-edge";
import { canvasStrips, checkCutout, checkMatte, COLOUR_ESTIMATE_CHECKS, convexSpan, edgeSoftnessBar, OPAQUE_SHARE_MIN, seeThroughBar, texturedSourceEdge } from "./cutout";
import { placedCutSides } from "./context";
import { checkGeometry, checkUniformScale, pixelsCopied, reproductionFloor } from "./geometry";
import { enlargementOf } from "../enhance";
import { backgroundModel, delta, dilate, thresholdMask } from "./image";
import { checkShadow, expectedKeptDarkness, KEPT_MIN_PIXELS, keptChannelConsistency, keptComparedPixels, keptDifferenceBar, keptShadowCanvasMask, sourceDarkness } from "./shadow";
import { runImageChecks } from "./index";
import { canvasColor, editOutput, paintRect, syntheticSource, syntheticSubject } from "./synthetic";
import type { CheckResult, OutputSubject } from "./types";

const failed = (results: CheckResult[]) => results.filter(r => r.status === "fail").map(r => r.id);
const ids = (results: CheckResult[], id: string) => results.filter(r => r.id === id);
async function ctxOf(subject: OutputSubject) { const ctx = await buildContext(subject); if (!ctx) throw new Error("no context"); return ctx; }

describe("image checks on what the real render makes", () => {
  // Wide enough for Styli's 1.5x limit and wide, so it fits by width and leaves room for the contact shadow under it.
  const WIDE = { width: 2600, height: 2600, box: { x: 500, y: 700, w: 1600, h: 800 }, taper: true };
  it.each(CHANNEL_IDS.filter(c => c !== "styli"))("passes every check for a synthetic footwear product on %s", async channel => {
    for (const n of channel === "amazon" || channel === "shein" ? [1, 2] : [1]) {
      const results = await runImageChecks(await syntheticSubject(channel, n, "footwear", WIDE));
      expect(failed(results)).toEqual([]);
      expect(ids(results, "geometry.pixels_copied")[0]?.status).toBe("pass");
    }
  }, 60_000);
  it("passes every check for a flat-lay product on Styli (no shadow)", async () => {
    expect(failed(await runImageChecks(await syntheticSubject("styli", 1, "apparel_flat", WIDE)))).toEqual([]);
  }, 60_000);
  it("passes for a tall product that fills a zero-margin canvas (the shadow fades before the border band)", async () => {
    expect(failed(await runImageChecks(await syntheticSubject("trendyol", 1, "footwear", { width: 2600, height: 2600, box: { x: 700, y: 500, w: 1200, h: 1600 } })))).toEqual([]);
  }, 60_000);
  it("passes for a model photo with no shadow and skips the fringe check when backgrounds match", async () => {
    const results = await runImageChecks(await syntheticSubject("trendyol", 1, "apparel_model", { width: 2000, height: 3000, box: { x: 700, y: 300, w: 600, h: 2400 }, bg: [224, 224, 224] }));
    expect(failed(results)).toEqual([]);
    expect(ids(results, "shadow.forbidden")[0]?.status).toBe("pass");
    expect(ids(results, "cutout.fringe")[0]?.status).toBe("not_run");
  }, 30_000);
});

describe("geometry failures", () => {
  it("fails format on 4:2:0 or the wrong DPI", async () => {
    const base = await syntheticSubject("noon", 1, "footwear");
    const sub = await editOutput(base, () => {}, { chromaSubsampling: "4:2:0" });
    expect(ids(await checkGeometry(await ctxOf(sub)), "geometry.format")[0]?.ok).toBe(false);
    const dpi = await editOutput(base, () => {}, { density: 300 });
    expect(ids(await checkGeometry(await ctxOf(dpi)), "geometry.format")[0]?.detail).toContain("density 300");
  });
  it("fails edges and the border band when a single edge pixel is off", async () => {
    const base = await syntheticSubject("noon", 1, "footwear");
    const sub = await editOutput(base, r => { paintRect(r, 10, 0, 6, 1, [0, 0, 0]); paintRect(r, 30, 5, 3, 3, [0, 0, 0]); });
    const results = await checkGeometry(await ctxOf(sub));
    expect(ids(results, "geometry.edges")[0]?.ok).toBe(false);
    expect(ids(results, "geometry.border_band")[0]?.ok).toBe(false);
  });
  it("fails outside_product for a stray blob and inside_safe_box when it sits in a margin", async () => {
    const base = await syntheticSubject("namshi", 1, "apparel_model", { box: { x: 300, y: 100, w: 200, h: 600 } });
    const blob = await editOutput(base, r => paintRect(r, 60, Math.round(r.h * 0.5), 30, 30, [10, 10, 10]));
    expect(failed(await checkGeometry(await ctxOf(blob)))).toContain("geometry.outside_product");
    const margin = await editOutput(base, r => paintRect(r, Math.round(r.w / 2), 40, 30, 30, [10, 10, 10]));
    expect(failed(await checkGeometry(await ctxOf(margin)))).toContain("geometry.inside_safe_box");
  });
  it("fails extent, centring and margins when the product sits elsewhere than planned", async () => {
    const base = await syntheticSubject("centrepoint", 1, "footwear");
    const shifted = { ...base, placement: { ...base.placement, placedX: base.placement.placedX + 12 } };
    expect(failed(await checkGeometry(await ctxOf(shifted)))).toContain("geometry.extent");
    const bg = canvasColor("centrepoint", 1);
    const moved = await editOutput(base, r => {
      const ctxBox = { x: base.placement.placedX, y: base.placement.placedY };
      const copy = Buffer.from(r.rgb);
      paintRect(r, 0, 0, r.w, r.h, bg);
      for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w - 40; x++) { const from = (y * r.w + x) * 3, to = (y * r.w + x + 40) * 3; r.rgb[to] = copy[from]!; r.rgb[to + 1] = copy[from + 1]!; r.rgb[to + 2] = copy[from + 2]!; }
      void ctxBox;
    });
    const movedPlan = { ...moved, placement: { ...base.placement, placedX: base.placement.placedX + 40 } };
    const results = await checkGeometry(await ctxOf(movedPlan));
    expect(failed(results)).toContain("geometry.centred");
  }, 60_000);
  it("fails the Styli anchor when the product floats above the guide", async () => {
    const base = await syntheticSubject("styli", 1, "footwear", { width: 3000, height: 3000, box: { x: 900, y: 800, w: 1200, h: 1600 } });
    const lifted = await editOutput(base, r => { const bottom = base.placement.placedY + Math.round(1660 * base.placement.scale); paintRect(r, 0, bottom - 30, r.w, 60, canvasColor("styli", 1)); });
    expect(failed(await checkGeometry(await ctxOf(lifted)))).toContain("geometry.anchor");
  }, 30_000);
  it("fails pixels_copied when product pixels were redrawn", async () => {
    const base = await syntheticSubject("amazon", 2, "footwear");
    const p = base.placement, redrawn = await editOutput(base, r => paintRect(r, p.placedX + 40, p.placedY + 120, 200, 200, [0, 200, 0]));
    expect(failed(await checkGeometry(await ctxOf(redrawn)))).toContain("geometry.pixels_copied");
  });
  it("judges Styli uniform scale across angles", () => {
    expect(checkUniformScale("P", [{ n: 1, scale: 1.2, detailShot: false }, { n: 2, scale: 1.2, detailShot: false }, { n: 3, scale: 2, detailShot: true }]).ok).toBe(true);
    expect(checkUniformScale("P", [{ n: 1, scale: 1.2, detailShot: false }, { n: 2, scale: 1.3, detailShot: false }]).ok).toBe(false);
    expect(checkUniformScale("P", [{ n: 1, scale: 1.2, detailShot: false }]).status).toBe("not_run");
  });
});

describe("shadow failures", () => {
  const WIDE = { width: 2600, height: 2600, box: { x: 500, y: 700, w: 1600, h: 800 }, taper: true };
  it("fails forbidden when a model photo has any darkening under the product", async () => {
    const base = await syntheticSubject("trendyol", 1, "apparel_model", { width: 2000, height: 3000, box: { x: 300, y: 300, w: 1400, h: 1400 } });
    const p = base.placement, bg = canvasColor("trendyol", 1);
    const shadowed = await editOutput(base, r => paintRect(r, p.placedX + 100, p.placedY + Math.round(1460 * p.scale) + 6, 200, 20, [bg[0] - 30, bg[1] - 30, bg[2] - 30]));
    expect(ids(checkShadow(await ctxOf(shadowed)), "shadow.forbidden")[0]?.ok).toBe(false);
  }, 30_000);
  it("fails hard edges for a rectangular shadow block under footwear", async () => {
    // A wide product fits by width and leaves room under it (Centrepoint) or beside it in Noon's 5% side margin.
    const base = await syntheticSubject("centrepoint", 1, "footwear", WIDE);
    const p = base.placement, bg = canvasColor("centrepoint", 1), bottom = p.placedY + Math.round(860 * p.scale);
    const block = await editOutput(base, r => paintRect(r, 100, bottom + 4, 2800, 40, [bg[0] - 90, bg[1] - 90, bg[2] - 90]));
    expect(failed(checkShadow(await ctxOf(block)))).toContain("shadow.hard_edge_horizontal");
    const noon = await syntheticSubject("noon", 1, "footwear", WIDE), nb = canvasColor("noon", 1), noonBottom = noon.placement.placedY + Math.round(860 * noon.placement.scale);
    const tall = await editOutput(noon, r => paintRect(r, 10, noonBottom - 200, 30, 300, [nb[0] - 90, nb[1] - 90, nb[2] - 90]));
    expect(failed(checkShadow(await ctxOf(tall)))).toContain("shadow.hard_edge_vertical");
  }, 30_000);
  it("fails darkness for a black slab and monotone when darkness rises away from the product", async () => {
    const base = await syntheticSubject("sixthstreet", 1, "footwear", { width: 2600, height: 2600, box: { x: 700, y: 900, w: 1200, h: 1000 } });
    const p = base.placement, bg = canvasColor("sixthstreet", 1), bottom = p.placedY + Math.round(1060 * p.scale), width = Math.round(1200 * p.scale);
    const slab = await editOutput(base, r => { for (let y = 0; y < 60; y++) { const v = Math.round(bg[0] * (1 - 0.8 * (1 - y / 60))); paintRect(r, p.placedX + 100, bottom + 2 + y, width - 200, 1, [v, v, v]); } });
    expect(failed(checkShadow(await ctxOf(slab)))).toContain("shadow.darkness");
    const ring = await editOutput(base, r => { for (let y = 0; y < 40; y++) { const v = Math.round(bg[0] - 8 - y * 0.8); paintRect(r, p.placedX + 100, bottom + 2 + y, width - 200, 1, [v, v, v]); } });
    expect(failed(checkShadow(await ctxOf(ring)))).toContain("shadow.monotone");
  }, 30_000);
  it("fails footprint when darkening lies outside the contact band", async () => {
    const base = await syntheticSubject("vogacloset", 1, "footwear", { width: 2600, height: 2600, box: { x: 700, y: 900, w: 1200, h: 1000 } });
    const bg = canvasColor("vogacloset", 1);
    const far = await editOutput(base, r => paintRect(r, 40, 40, 30, 30, [bg[0] - 20, bg[1] - 20, bg[2] - 20]));
    expect(failed(checkShadow(await ctxOf(far)))).toContain("shadow.footprint");
  }, 30_000);
});

describe("cut-out failures", () => {
  it("fails pixels_lost and thin_parts when the matte drops the strap or a region", async () => {
    const base = await syntheticSubject("amazon", 2, "footwear");
    const noStrap = { ...base, alpha: Buffer.from(base.alpha) };
    for (let y = 190; y < 250; y++) for (let x = 0; x < 800; x++) noStrap.alpha[y * 800 + x] = 0;
    const results = checkCutout(await ctxOf(noStrap));
    expect(failed(results)).toContain("cutout.thin_parts");
    const chunk = { ...base, alpha: Buffer.from(base.alpha) };
    for (let y = 250; y < 330; y++) for (let x = 200; x < 300; x++) chunk.alpha[y * 800 + x] = 0;
    expect(failed(checkCutout(await ctxOf(chunk)))).toContain("cutout.pixels_lost");
  });
  it("fails holes for an interior gap and background_kept for matted background", async () => {
    const base = await syntheticSubject("amazon", 2, "footwear");
    const hole = { ...base, alpha: Buffer.from(base.alpha) };
    for (let y = 400; y < 430; y++) for (let x = 350; x < 380; x++) hole.alpha[y * 800 + x] = 0;
    expect(failed(checkCutout(await ctxOf(hole)))).toContain("cutout.holes");
    const kept = { ...base, alpha: Buffer.from(base.alpha) };
    for (let y = 250; y < 630; y++) for (let x = 100; x < 190; x++) kept.alpha[y * 800 + x] = 255;
    expect(failed(checkCutout(await ctxOf(kept)))).toContain("cutout.background_kept");
  });
  it("fails halo for leftover background around the product and fringe for source-coloured edges", async () => {
    const base = await syntheticSubject("amazon", 2, "footwear");
    const p = base.placement;
    const halo = await editOutput(base, r => { const x = p.placedX - 2, y0 = p.placedY + 100; paintRect(r, x, y0, 2, 150, [255, 255, 255]); });
    expect(failed(checkCutout(await ctxOf(halo)))).toContain("cutout.halo");
    const ctx = await ctxOf(base);
    const fringe = await editOutput(base, r => { for (let i = 0; i < ctx.expectedAlpha.length; i++) if (ctx.expectedAlpha[i]! > 10 && ctx.expectedAlpha[i]! <= 200) { r.rgb[i * 3] = 255; r.rgb[i * 3 + 1] = 255; r.rgb[i * 3 + 2] = 255; } });
    expect(failed(checkCutout(await ctxOf(fringe)))).toContain("cutout.fringe");
  });
});

describe("cut sources", () => {
  it("is flush on the cut side on every channel and carries its information flag", async () => {
    const amazon = await syntheticSubject("amazon", 1, "apparel_model", { width: 1600, height: 2400, box: { x: 500, y: 300, w: 600, h: 1000 }, cutBottom: true });
    const results = checkCutEdge(await ctxOf(amazon));
    expect(ids(results, "cut_edge.flush_bottom")[0]?.ok).toBe(true);
    expect(ids(results, "cut_edge.no_line_bottom")[0]?.ok).toBe(true);
    expect(amazon.flags).toContain(CUT_SOURCE_FLAGS[0]);
    expect(ids(results, "cut_edge.flagged")[0]?.ok).toBe(true);
    expect(ids(results, "cut_edge.not_held")[0]?.ok).toBe(true);
    const unflagged = checkCutEdge(await ctxOf({ ...amazon, flags: [] }));
    expect(ids(unflagged, "cut_edge.flagged")[0]?.ok).toBe(false);
    const held = checkCutEdge(await ctxOf({ ...amazon, status: "needs_attention" }));
    expect(ids(held, "cut_edge.not_held")[0]?.ok).toBe(false);
    const noon = await syntheticSubject("noon", 1, "apparel_model", { width: 1600, height: 2400, box: { x: 500, y: 300, w: 600, h: 1000 }, cutBottom: true });
    expect(ids(checkCutEdge(await ctxOf(noon)), "cut_edge.flush_bottom")[0]?.ok).toBe(true);
    const uncut = checkCutEdge(await ctxOf(await syntheticSubject("noon", 1, "apparel_model")));
    expect(uncut[0]?.status).toBe("not_run");
  }, 30_000);
  // Uncut sides of these sources sit deeper than 15% of the frame, so the render's pad-band rule never reads them as cut.
  it("is flush top and bottom on the 2:3 Trendyol canvas when the photo is cut on both, with nothing trimmed", async () => {
    // A 1:4 product cut top and bottom fits the 2:3 canvas by height: both cut edges reach the canvas and the trim is 0.
    const sub = await syntheticSubject("trendyol", 1, "apparel_model", { width: 800, height: 1200, box: { x: 250, y: 100, w: 300, h: 1000 }, cutTop: true, cutBottom: true });
    const results = await runImageChecks(sub);
    expect(failed(results)).toEqual([]);
    for (const id of ["cut_edge.flush_top", "cut_edge.flush_bottom", "cut_edge.trim"]) expect(ids(results, id)[0]?.status, id).toBe("pass");
    expect(ids(results, "cut_edge.trim")[0]?.measured).toBe(0);
  }, 30_000);
  it("accepts a square full-bleed close-up filling the 2:3 Trendyol canvas with a third trimmed off its cut sides, and bounds the trim", async () => {
    // The Anta close-ups: 800 x 800 inside a 10 px white border, cut on all four sides.
    const square = { width: 800, height: 800, box: { x: 100, y: 100, w: 600, h: 600 }, cutTop: true, cutBottom: true, cutLeft: true, cutRight: true, pad: 10 };
    const sub = await syntheticSubject("trendyol", 1, "apparel_model", square);
    const results = await runImageChecks(sub);
    expect(failed(results)).toEqual([]);
    for (const side of ["top", "bottom", "left", "right"]) expect(ids(results, `cut_edge.flush_${side}`)[0]?.ok, side).toBe(true);
    const trim = ids(results, "cut_edge.trim")[0];
    expect(trim?.ok).toBe(true);
    expect(trim?.measured).toBeCloseTo(1 / 3, 2);
    // The pipeline records a larger scale than the canvas has room for: more than a third would be trimmed.
    const tooMuch = checkCutEdge(await ctxOf({ ...sub, placement: { ...sub.placement, scale: sub.placement.scale * 1.2 } }));
    expect(ids(tooMuch, "cut_edge.trim")[0]?.ok).toBe(false);
    expect(ids(tooMuch, "cut_edge.trim")[0]?.detail).toContain("at most a third");
  }, 60_000);
  it("reads an uneven split from the canvas when the render keeps a logo near one cut side whole", async () => {
    // A square full-bleed close-up with a logo near the left: on Noon the render takes most of the side trim off the right.
    const square = { width: 800, height: 800, box: { x: 100, y: 100, w: 600, h: 600 }, cutTop: true, cutBottom: true, cutLeft: true, cutRight: true, pad: 10, logo: { x: 120, y: 360, w: 76, h: 120 } };
    const sub = await syntheticSubject("noon", 1, "apparel_model", square);
    const ctx = await ctxOf(sub), extra = ctx.sourceBox.w - ctx.sourceCrop.w;
    expect(extra).toBeGreaterThan(0);
    expect(ctx.sourceCrop.x - ctx.sourceBox.x).toBeLessThan(Math.floor(extra / 2));
    expect(failed(await runImageChecks(sub))).toEqual([]);
  }, 60_000);
  it("passes flush as information when the render fits a photo cut top and bottom by rule and notes the band beside the top cut, fails it without the note, and fails trim when a placement would trim the uncut sides instead", async () => {
    // Wider than 2:3 and cut only top and bottom: the render may not trim the uncut sides, so it fits by width and a band sits above the top cut.
    const sub = await syntheticSubject("trendyol", 1, "apparel_model", { width: 1000, height: 800, box: { x: 200, y: 100, w: 600, h: 600 }, cutTop: true, cutBottom: true });
    expect(cutBandNote(sub.reason).sides).toEqual(new Set(["top"]));
    const results = checkCutEdge(await ctxOf(sub));
    expect(ids(results, "cut_edge.trim")[0]?.ok).toBe(true);
    expect(ids(results, "cut_edge.flush_bottom")[0]?.ok).toBe(true);
    expect(ids(results, "cut_edge.flush_top")[0]?.ok).toBe(true);
    expect(ids(results, "cut_edge.flush_top")[0]?.unit).toBe("px, fitted by rule");
    expect(ids(results, "cut_edge.flush_top")[0]?.detail).toContain("off the uncut left or right");
    // The same output without the render's note claims a flush edge it does not have.
    const claimed = checkCutEdge(await ctxOf({ ...sub, reason: null }));
    expect(ids(claimed, "cut_edge.flush_top")[0]?.ok).toBe(false);
    expect(ids(claimed, "cut_edge.flush_top")[0]?.unit).toBe("px");
    // A placement that fills the height instead (what a render trimming the uncut left and right would record) fails on the
    // placement alone: the extent and pixel checks cannot tell a trimmed flat texture apart, so trim is the guard.
    const wrongSide = checkCutEdge(await ctxOf({ ...sub, placement: { ...sub.placement, scale: sub.placement.h / 800, placedY: 0 } }));
    expect(ids(wrongSide, "cut_edge.trim")[0]?.ok).toBe(false);
    expect(ids(wrongSide, "cut_edge.trim")[0]?.detail).toContain("not cut at the left or right");
  }, 60_000);
  it("fails no_line when a floating line sits under the cut", async () => {
    const amazon = await syntheticSubject("amazon", 1, "apparel_model", { width: 1600, height: 2400, box: { x: 500, y: 300, w: 600, h: 1000 }, cutBottom: true });
    const ctx = await ctxOf(amazon);
    // Product ends on the canvas edge, so a line can only float when it ends short: lift it by painting the last rows.
    const lifted = await editOutput(amazon, r => { paintRect(r, 0, r.h - 20, r.w, 20, canvasColor("amazon", 1)); paintRect(r, ctx.productBox.x + 50, r.h - 12, 200, 2, [120, 120, 120]); });
    const results = checkCutEdge(await ctxOf(lifted));
    expect(ids(results, "cut_edge.flush_bottom")[0]?.ok).toBe(false);
    expect(ids(results, "cut_edge.no_line_bottom")[0]?.ok).toBe(false);
  }, 30_000);
});

describe("calibrated measurements (eval run 2)", () => {
  it("measures the extent against the source: a white product on a white canvas passes, a vanished coloured part fails", async () => {
    const white = await syntheticSubject("centrepoint", 1, "footwear", { color: [230, 230, 230] });
    const results = await checkGeometry(await ctxOf(white));
    for (const id of ["geometry.extent", "geometry.centred", "geometry.anchor"]) expect(ids(results, id)[0]?.status, id).toBe("pass");
    const base = await syntheticSubject("centrepoint", 1, "footwear");
    const p = base.placement, bg = canvasColor("centrepoint", 1);
    // The bottom 20% of the product painted out: a vanished sole.
    const vanished = await editOutput(base, r => paintRect(r, 0, p.placedY + Math.round(360 * p.scale), r.w, Math.round(90 * p.scale), bg));
    expect(failed(await checkGeometry(await ctxOf(vanished)))).toContain("geometry.extent");
  }, 60_000);
  it("does not centre or anchor a product on a cut axis (placed flush by rule)", async () => {
    const cut = await syntheticSubject("noon", 1, "apparel_model", { width: 1600, height: 2400, box: { x: 500, y: 300, w: 600, h: 1000 }, cutBottom: true });
    const results = await checkGeometry(await ctxOf(cut));
    expect(ids(results, "geometry.anchor")[0]?.status).toBe("not_run");
    expect(ids(results, "geometry.centred")[0]?.status).toBe("pass");
    const side = await syntheticSubject("noon", 1, "footwear", { width: 1600, height: 1000, box: { x: 300, y: 200, w: 900, h: 500 }, cutLeft: true });
    const sideResults = await checkGeometry(await ctxOf(side));
    expect(ids(sideResults, "geometry.centred")[0]?.status).toBe("not_run");
    expect(ids(sideResults, "geometry.noon_wide")[0]?.status).toBe("not_run");
    expect(ids(sideResults, "geometry.anchor")[0]?.status).toBe("pass");
  }, 60_000);
  it("compares a kept photographic shadow with the source, and fails a block or a slab added under it", async () => {
    // Wide, so it fits by width and leaves room under it for the photo's shadow.
    const kept = await syntheticSubject("amazon", 1, "footwear", { sourceShadow: true, box: { x: 100, y: 300, w: 600, h: 300 } });
    expect(kept.flags).not.toContain("shadow_synthesised");
    const results = await runImageChecks(kept);
    expect(failed(results)).toEqual([]);
    expect(ids(results, "shadow.kept_matches_source")[0]?.status).toBe("pass");
    expect(ids(results, "shadow.hard_edge_horizontal")[0]?.status).toBe("not_run");
    expect(ids(results, "shadow.monotone")[0]?.status).toBe("not_run");
    const p = kept.placement, bg = canvasColor("amazon", 1), bottom = p.placedY + Math.round(360 * p.scale), width = Math.round(600 * p.scale);
    const block = await editOutput(kept, r => paintRect(r, p.placedX + 40, bottom + 8, width - 80, 40, [bg[0] - 60, bg[1] - 60, bg[2] - 60]));
    expect(failed(checkShadow(await ctxOf(block)))).toContain("shadow.kept_matches_source");
    const slab = await editOutput(kept, r => paintRect(r, p.placedX + 40, bottom + 8, width - 80, 20, [40, 40, 40]));
    expect(failed(checkShadow(await ctxOf(slab)))).toContain("shadow.darkness");
  }, 60_000);
  it("excludes the kept shadow from the halo ring but still fails a grey halo higher up the product", async () => {
    const kept = await syntheticSubject("amazon", 1, "footwear", { sourceShadow: true, box: { x: 100, y: 300, w: 600, h: 300 } });
    expect(ids(checkCutout(await ctxOf(kept)), "cutout.halo")[0]?.ok).toBe(true);
    // A 3 px grey strip along the top edge of the body (left of the strap), inside the halo ring and above the shadow band.
    const p = kept.placement, bodyTop = p.placedY + Math.round(60 * p.scale);
    const halo = await editOutput(kept, r => paintRect(r, p.placedX + 50, bodyTop - 3, 300, 3, [200, 200, 200]));
    expect(failed(checkCutout(await ctxOf(halo)))).toContain("cutout.halo");
  }, 60_000);
  it("fails pixels_lost for a 20% loss and a dropped sole sliver, but not for a floor reflection", async () => {
    const base = await syntheticSubject("amazon", 2, "footwear");
    const lost = { ...base, alpha: Buffer.from(base.alpha) };
    for (let y = 554; y < 630; y++) for (let x = 0; x < 800; x++) lost.alpha[y * 800 + x] = 0;
    const results = checkCutout(await ctxOf(lost));
    expect(failed(results)).toContain("cutout.pixels_lost");
    expect(ids(results, "cutout.pixels_lost")[0]?.measured).toBeGreaterThan(0.2);
    expect(failed(checkCutout(await ctxOf(await syntheticSubject("amazon", 2, "footwear", { sliver: true }))))).toContain("cutout.pixels_lost");
    const reflection = checkCutout(await ctxOf(await syntheticSubject("amazon", 2, "footwear", { reflection: true })));
    expect(failed(reflection)).toEqual([]);
  }, 60_000);
  it("skips halo and fringe on a pass-through, runs background_kept on it, and skips the colour checks on a source without a uniform border", async () => {
    const base = await syntheticSubject("amazon", 2, "footwear");
    const passthrough = checkCutout(await ctxOf({ ...base, flags: ["matte_passthrough"] }));
    expect(ids(passthrough, "cutout.background_kept")[0]?.status).toBe("pass");
    expect(ids(passthrough, "cutout.fringe")[0]?.status).toBe("not_run");
    expect(ids(passthrough, "cutout.halo")[0]?.status).toBe("not_run");
    // A flood that stopped short of the product leaves a strip of flat background inside the pass-through (eval run 3,
    // vero_moda Z40E29CD878FAA726501DZ n=1 published as a ragged pass-through): the kept accounting runs on it as on a matte.
    const kept = { ...base, flags: ["matte_passthrough" as const], alpha: Buffer.from(base.alpha) };
    for (let y = 250; y < 630; y++) for (let x = 100; x < 190; x++) kept.alpha[y * 800 + x] = 255;
    expect(failed(checkCutout(await ctxOf(kept)))).toContain("cutout.background_kept");
    // A busy border (stripes through the 2% band) fits no background model, so the colour checks stay not run.
    const striped = Buffer.from(base.source.rgb), w = base.source.w, h = base.source.h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 16 || x >= w - 16 || y < 16 || y >= h - 16) { const v = (x * 53 + y * 97) % 256; striped[(y * w + x) * 3] = v; striped[(y * w + x) * 3 + 1] = v; striped[(y * w + x) * 3 + 2] = v; }
    expect(backgroundModel({ ...base.source, rgb: striped }, { uniform: false, color: base.sourceBackground.color })).toBeNull();
    // A texture whose rows share a median is not a background either (a checkerboard border).
    const checker = Buffer.from(base.source.rgb);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < 16 || x >= w - 16 || y < 16 || y >= h - 16) { const v = (x + y) % 2 ? 0 : 255; checker[(y * w + x) * 3] = v; checker[(y * w + x) * 3 + 1] = v; checker[(y * w + x) * 3 + 2] = v; }
    expect(backgroundModel({ ...base.source, rgb: checker }, { uniform: false, color: base.sourceBackground.color })).toBeNull();
    const busy = checkCutout(await ctxOf({ ...base, source: { ...base.source, rgb: striped }, sourceBackground: { ...base.sourceBackground, uniform: false } }));
    expect(ids(busy, "cutout.pixels_lost")[0]?.status).toBe("not_run");
    expect(ids(busy, "cutout.fringe")[0]?.status).toBe("not_run");
    expect(ids(busy, "cutout.edge_softness")[0]?.status).toBe("pass");
  }, 30_000);
  it("is flush with a white hem on a white canvas, fails a 150 px band beside the cut, and fires on pixels beyond the edge", async () => {
    const white = await syntheticSubject("amazon", 1, "apparel_model", { width: 1600, height: 2400, box: { x: 500, y: 300, w: 600, h: 1000 }, cutBottom: true, color: [230, 230, 230] });
    const results = checkCutEdge(await ctxOf(white));
    expect(ids(results, "cut_edge.flush_bottom")[0]?.ok).toBe(true);
    expect(ids(results, "cut_edge.no_line_bottom")[0]?.ok).toBe(true);
    const coloured = await syntheticSubject("amazon", 1, "apparel_model", { width: 1600, height: 2400, box: { x: 500, y: 300, w: 600, h: 1000 }, cutBottom: true });
    const band = await editOutput(coloured, r => paintRect(r, 0, r.h - 150, r.w, 150, canvasColor("amazon", 1)));
    const banded = checkCutEdge(await ctxOf(band));
    expect(ids(banded, "cut_edge.flush_bottom")[0]?.ok).toBe(false);
    expect(ids(banded, "cut_edge.flush_bottom")[0]?.measured).toBeGreaterThanOrEqual(148);
    // The product drawn 40 px lower than recorded: product pixels lie beyond the mask's bottom edge.
    const beyond = checkCutEdge(await ctxOf({ ...coloured, placement: { ...coloured.placement, placedY: coloured.placement.placedY - 40 } }));
    expect(ids(beyond, "cut_edge.no_line_bottom")[0]?.ok).toBe(false);
    expect(ids(beyond, "cut_edge.no_line_bottom")[0]?.unit).toBe("pixels beyond the edge");
  }, 60_000);
});

describe("apparel calibration (eval run 2, french_connection)", () => {
  it("passes no_line for the one-source-pixel ring the matte's soft edge leaves inside the half mask along a two-leg silhouette (Z496A6D49F492382B0B59Z n=1 at 2.1%, Z2392E34E478442A647DBZ n=5 at 3.6%)", async () => {
    // A model cut at the knees on a grey studio background, two legs in the strip; the suite's matte is one source pixel
    // wider than the one the render used, so a ring of canvas background sits inside the half mask along every edge.
    const { prepared, matte } = syntheticSource({ width: 800, height: 1200, box: { x: 250, y: 100, w: 300, h: 1100 }, cutBottom: true, bg: [200, 200, 200], strap: false });
    for (let y = 600; y < 1200; y++) for (let x = 380; x < 420; x++) { const i = y * 800 + x; matte.alpha[i] = 0; prepared.rgb[i * 3] = 200; prepared.rgb[i * 3 + 1] = 200; prepared.rgb[i * 3 + 2] = 200; }
    const out = await renderSource({ prepared, matte, channel: "centrepoint", shotNumber: 1, productType: "apparel_model", identifier: "LEGS", publicObjectPath: "catalog-test/x/LEGS/centrepoint/LEGS_1.jpg" });
    if (!out.jpeg) throw new Error(out.notes.join("; "));
    const wider = dilate(thresholdMask(matte.alpha, 127), 800, 1200, 1), alpha = Buffer.alloc(800 * 1200);
    for (let i = 0; i < alpha.length; i++) alpha[i] = wider[i] ? 255 : 0;
    const subject: OutputSubject = { identifier: "LEGS", n: 1, channel: "centrepoint", productType: "apparel_model", source: { w: 800, h: 1200, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha, jpeg: out.jpeg, placement: { w: out.plan.w, h: out.plan.h, scale: out.plan.scale, placedX: out.plan.placedX, placedY: out.plan.placedY }, flags: out.flags as OutputFlag[], status: "staged", reason: out.notes.join("; ") || null, expect: { attention: false, flags: [], detector: "code" } };
    const ctx = await ctxOf(subject), bg = canvasColor("centrepoint", 1);
    // The fixture reproduces the ring: more than 1% of the half mask's last 12 rows show canvas background.
    let half = 0, ring = 0;
    for (let y = ctx.canvas.h - 12; y < ctx.canvas.h; y++) for (let x = 0; x < ctx.canvas.w; x++) { const i = y * ctx.canvas.w + x; if (!ctx.half[i]) continue; half++; if (delta(ctx.canvas.rgb, i, bg) <= 8) ring++; }
    expect(ring / half).toBeGreaterThan(0.01);
    const results = checkCutEdge(ctx);
    expect(ids(results, "cut_edge.flush_bottom")[0]?.ok).toBe(true);
    expect(ids(results, "cut_edge.no_line_bottom")[0]?.ok).toBe(true);
    // A floating line under the legs still fails: the last rows lifted to background with a grey line across them.
    const lifted = await editOutput(subject, r => { paintRect(r, 0, r.h - 20, r.w, 20, bg); paintRect(r, ctx.productBox.x + 20, r.h - 12, 100, 2, [120, 120, 120]); });
    expect(ids(checkCutEdge(await ctxOf(lifted)), "cut_edge.no_line_bottom")[0]?.ok).toBe(false);
  }, 60_000);
  it("does not judge not_held on a cut photo the manifest expects to be held", async () => {
    const held = await syntheticSubject("amazon", 1, "apparel_model", { width: 1600, height: 2400, box: { x: 500, y: 300, w: 600, h: 1000 }, cutBottom: true });
    const results = checkCutEdge(await ctxOf({ ...held, status: "needs_attention", expect: { attention: true, flags: ["small_source"], detector: "code" } }));
    expect(ids(results, "cut_edge.not_held")[0]?.status).toBe("not_run");
    expect(ids(checkCutEdge(await ctxOf({ ...held, status: "needs_attention" })), "cut_edge.not_held")[0]?.ok).toBe(false);
  }, 30_000);
  it("holds footwear to a 3 px soft edge and apparel, bags and hardline to 4.5 px (eval run 3)", () => {
    expect(edgeSoftnessBar("footwear")).toBe(3);
    expect(edgeSoftnessBar(undefined)).toBe(3);
    for (const type of ["apparel_model", "apparel_flat", "bag_accessory", "other"] as const) expect(edgeSoftnessBar(type)).toBe(4.5);
    // A matte whose edge ramps over 3 px on three sides and 4 px on the bottom: about 3.2 px of soft band per unit of silhouette.
    const { prepared, box } = syntheticSource(), w = prepared.width, h = prepared.height, alpha = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = Math.max(0, box.x - x, x - (box.x + box.w - 1)), dy = Math.max(0, box.y - y, y - (box.y + box.h - 1)), d = Math.max(dx, dy), k = y >= box.y + box.h ? 4 : 3;
      alpha[y * w + x] = d === 0 ? 255 : d <= k ? Math.round(255 * (1 - d / (k + 1))) : 0;
    }
    const input = { identifier: "P", n: 1, source: { w, h, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha };
    const shoe = checkMatte({ ...input, productType: "footwear" }), top = checkMatte({ ...input, productType: "apparel_model" });
    expect(shoe.metrics.edgeSoftness).toBeGreaterThan(3);
    expect(shoe.metrics.edgeSoftness).toBeLessThan(3.5);
    expect(ids(shoe.results, "cutout.edge_softness")[0]?.ok).toBe(false);
    expect(ids(top.results, "cutout.edge_softness")[0]?.ok).toBe(true);
  });
});

describe("run 3 calibration (french_connection.apparel_model, mocked judge)", () => {
  const ramp = (k: number, interior: (x: number, y: number, box: { x: number; y: number; w: number; h: number }) => number | null = () => null) => {
    const { prepared, box } = syntheticSource(), w = prepared.width, h = prepared.height, alpha = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = Math.max(0, box.x - x, x - (box.x + box.w - 1)), dy = Math.max(0, box.y - y, y - (box.y + box.h - 1)), d = Math.max(dx, dy);
      alpha[y * w + x] = d === 0 ? interior(x, y, box) ?? 255 : d <= k ? Math.round(255 * (1 - d / (k + 1))) : 0;
    }
    return { input: { identifier: "P", n: 1, source: { w, h, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha }, box, w, h };
  };
  it("counts edge softness within 8 px of the silhouette only: a sheer interior is fabric, a 12 px blurred halo still measures over 7 and fails, a full-bleed close-up is not run", () => {
    // A 3 px ramp with the whole interior at alpha 200 (sheer chiffon, Z2392E34E478442A647DBZ n=1 to 5 at 4.7 to 8.8 under the old count).
    const { input } = ramp(3, (x, y, box) => (x > box.x + 12 && x < box.x + box.w - 12 && y > box.y + 12 && y < box.y + box.h - 12 ? 200 : null));
    const sheer = checkMatte({ ...input, productType: "apparel_model" });
    expect(sheer.metrics.edgeSoftness).toBeLessThan(4.5);
    expect(ids(sheer.results, "cutout.edge_softness")[0]?.ok).toBe(true);
    const halo = checkMatte({ ...ramp(12).input, productType: "apparel_model" });
    expect(halo.metrics.edgeSoftness).toBeGreaterThan(7);
    expect(ids(halo.results, "cutout.edge_softness")[0]?.ok).toBe(false);
    // The silhouette is the frame (Z5A0B7DE13FC67EDEAC9DZ n=4, 6.87 on almost no edge): nothing to measure.
    const full = { ...ramp(3).input, alpha: Buffer.alloc(800 * 800, 255), productType: "apparel_model" as const };
    expect(ids(checkMatte(full).results, "cutout.edge_softness")[0]?.status).toBe("not_run");
  });
  it("holds see-through to 1.5% on the soft types and 0.2% on footwear: a 1% faint patch passes on apparel, a 3% patch fails on both", () => {
    expect(seeThroughBar("footwear")).toBe(0.002);
    for (const type of ["apparel_model", "apparel_flat", "bag_accessory", "other"] as const) expect(seeThroughBar(type)).toBe(0.015);
    const patch = (size: number) => { const { prepared, matte } = syntheticSource(), w = prepared.width; for (let y = 400; y < 400 + size; y++) for (let x = 300; x < 300 + size; x++) matte.alpha[y * w + x] = 150; return { identifier: "P", n: 1, source: { w, h: prepared.height, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha: matte.alpha }; };
    const faint = patch(38), top = checkMatte({ ...faint, productType: "apparel_model" }), shoe = checkMatte({ ...faint, productType: "footwear" });
    expect(top.metrics.seeThrough).toBeGreaterThan(0.005);
    expect(ids(top.results, "cutout.see_through")[0]?.ok).toBe(true);
    expect(ids(shoe.results, "cutout.see_through")[0]?.ok).toBe(false);
    const big = checkMatte({ ...patch(68), productType: "apparel_model" });
    expect(big.metrics.seeThrough).toBeGreaterThan(0.015);
    expect(ids(big.results, "cutout.see_through")[0]?.ok).toBe(false);
  });
  it("does not call a white hem kept background: woven white below the body and a white panel between the legs pass, a flat white chunk below the base still fails", () => {
    // A coloured body with 40 rows of near-white woven fabric under it, matted as product: no colour evidence, not flat.
    const hem = (flat: boolean) => {
      const { prepared, matte, box } = syntheticSource({ strap: false }), w = prepared.width;
      for (let y = box.y + box.h; y < box.y + box.h + 40; y++) for (let x = box.x; x < box.x + box.w; x++) { const i = y * w + x, v = flat ? 255 : (x + y) % 2 ? 236 : 252; prepared.rgb[i * 3] = v; prepared.rgb[i * 3 + 1] = v; prepared.rgb[i * 3 + 2] = v; matte.alpha[i] = 255; }
      return { identifier: "P", n: 1, source: { w, h: prepared.height, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha: matte.alpha, productType: "apparel_model" as const };
    };
    const woven = checkMatte(hem(false));
    expect(woven.metrics.backgroundKept).toBeLessThan(0.01);
    expect(ids(woven.results, "cutout.background_kept")[0]?.ok).toBe(true);
    const chunk = checkMatte(hem(true));
    expect(chunk.metrics.backgroundKept).toBeGreaterThan(0.04);
    expect(ids(chunk.results, "cutout.background_kept")[0]?.ok).toBe(false);
    // Two coloured legs with a flat white panel between them (a white skirt's rows below the arms): inside the span.
    const { prepared, matte, box } = syntheticSource({ strap: false }), w = prepared.width;
    for (let y = box.y + 200; y < box.y + box.h; y++) for (let x = box.x + 120; x < box.x + box.w - 120; x++) { const i = y * w + x; prepared.rgb[i * 3] = 255; prepared.rgb[i * 3 + 1] = 255; prepared.rgb[i * 3 + 2] = 255; }
    const legs = checkMatte({ identifier: "P", n: 1, source: { w, h: prepared.height, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha: matte.alpha, productType: "apparel_model" });
    expect(legs.metrics.backgroundKept).toBe(0);
    expect(ids(legs.results, "cutout.background_kept")[0]?.ok).toBe(true);
    // The span itself: a triangle's rows widen from the apex, grown by 2 px.
    const rowMin = new Int32Array(10).fill(10), rowMax = new Int32Array(10).fill(-1);
    for (let y = 0; y < 5; y++) { rowMin[y] = 5 - y; rowMax[y] = 5 + y; }
    const span = convexSpan(rowMin, rowMax, 10, 2);
    expect([span.left[0], span.right[0]]).toEqual([1, 9]);
    expect([span.left[4], span.right[4]]).toEqual([-1, 11]);
    expect([span.left[6], span.right[6]]).toEqual([-1, 11]);
    expect(span.right[8]).toBe(-Infinity);
  });
  it("re-derives the cut sides from the placed crop: a side whose touching rows the trim removed is not cut (Z03E68A3989163039BCFEZ n=3)", () => {
    // 800 x 1200, cut at the bottom; a collar touches the left edge only in the last 100 rows.
    const w = 800, h = 1200, alpha = Buffer.alloc(w * h);
    for (let y = 100; y < h; y++) for (let x = y >= 1100 ? 0 : 200; x < 600; x++) alpha[y * w + x] = 255;
    const box = { x: 0, y: 100, w: 600, h: 1100 }, cut = { top: false, bottom: true, left: true, right: false };
    expect(placedCutSides(alpha, { w, h }, box, box, cut)).toEqual(["bottom", "left"]);
    // 32% trimmed off the bottom: the left is no longer touched; the bottom, trimmed, is still cut (the product continues beyond the crop).
    expect(placedCutSides(alpha, { w, h }, box, { ...box, h: 748 }, cut)).toEqual(["bottom"]);
    // A touch shorter than 2% of the edge (8 of 1200 rows) is not a cut either.
    for (let y = 1100; y < h - 16; y++) for (let x = 0; x < 200; x++) alpha[y * w + x] = 0;
    expect(placedCutSides(alpha, { w, h }, box, box, cut)).toEqual(["bottom"]);
  });
  it("does not measure flush on a held output (the expected hold ZEE79259BBFD83FFA1DB0Z n=5 waits fitted and centred)", async () => {
    const cut = await syntheticSubject("amazon", 1, "apparel_model", { width: 1600, height: 2400, box: { x: 500, y: 300, w: 600, h: 1000 }, cutBottom: true });
    const held = checkCutEdge(await ctxOf({ ...cut, status: "needs_attention", expect: { attention: true, flags: ["leftover_background"], detector: "code" } }));
    expect(ids(held, "cut_edge.flush_bottom")[0]?.status).toBe("not_run");
    expect(ids(held, "cut_edge.no_line_bottom")[0]?.status).toBe("pass");
    expect(ids(checkCutEdge(await ctxOf(cut)), "cut_edge.flush_bottom")[0]?.status).toBe("pass");
  }, 30_000);
  it("runs no image check on a planted photo (the Anta shoe under Z023DBEC95DCF485E9E6EZ, the model photo under bd-152638122-2): measured, recorded as not run", async () => {
    const kept = await syntheticSubject("amazon", 1, "apparel_model", { sourceShadow: true, box: { x: 100, y: 300, w: 600, h: 300 } });
    const real = await runImageChecks(kept);
    expect(ids(real, "cutout.halo")[0]?.status).toBe("pass");
    const p = kept.placement, bg = canvasColor("amazon", 1), bottom = p.placedY + Math.round(360 * p.scale);
    const block = await editOutput(kept, r => paintRect(r, p.placedX + 40, bottom + 8, Math.round(600 * p.scale) - 80, 40, [bg[0] - 60, bg[1] - 60, bg[2] - 60]));
    expect(failed(await runImageChecks(block))).toContain("shadow.kept_matches_source");
    const planted = await runImageChecks({ ...block, planted: true });
    expect(failed(planted)).toEqual([]);
    expect(planted.every(r => r.status === "not_run")).toBe(true);
    expect(ids(planted, "shadow.kept_matches_source")[0]?.detail).toContain("Planted wrong item (fail");
  }, 60_000);
  it("compares a kept shadow with what the render's own rule keeps, on the source grid: a detached shadow the render drops is not a difference, a block under the product still is", async () => {
    // A contact shadow plus a detached grey patch below it (a raised toe's shadow): preservedDarkness keeps only the connected part.
    const { prepared, matte, box } = syntheticSource({ sourceShadow: true, taper: true, box: { x: 100, y: 300, w: 600, h: 300 } });
    const w = prepared.width;
    for (let y = box.y + box.h + 52; y < box.y + box.h + 66; y++) for (let x = box.x + 60; x < box.x + 200; x++) { const i = (y * w + x) * 3; prepared.rgb[i] = 150; prepared.rgb[i + 1] = 150; prepared.rgb[i + 2] = 150; }
    const out = await renderSource({ prepared, matte, channel: "amazon", shotNumber: 1, productType: "footwear", identifier: "TOE", publicObjectPath: "catalog-test/x/TOE/amazon/TOE_1.jpg" });
    if (!out.jpeg) throw new Error(out.notes.join("; "));
    const subject: OutputSubject = { identifier: "TOE", n: 1, channel: "amazon", productType: "footwear", source: { w, h: prepared.height, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha: matte.alpha, jpeg: out.jpeg, placement: { w: out.plan.w, h: out.plan.h, scale: out.plan.scale, placedX: out.plan.placedX, placedY: out.plan.placedY }, flags: out.flags as OutputFlag[], status: "staged", reason: out.notes.join("; ") || null, expect: { attention: false, flags: [], detector: "code" } };
    expect(subject.flags).not.toContain("no_shadow_source");
    const ctx = await ctxOf(subject), results = checkShadow(ctx);
    expect(ids(results, "shadow.kept_matches_source")[0]?.ok).toBe(true);
    expect(ids(results, "shadow.kept_matches_source")[0]?.measured).toBeLessThanOrEqual(2);
    // The plain source darkness (the old expectation) still carries the detached patch; the render's rule does not.
    const expected = expectedKeptDarkness(ctx), patch = (box.y + box.h + 58) * w + box.x + 100;
    expect(expected[patch]).toBe(0);
    expect(sourceDarkness(ctx)[patch]).toBeGreaterThan(0.3);
    const p = subject.placement, bg = canvasColor("amazon", 1), bottom = p.placedY + Math.round(box.h * p.scale);
    const block = await editOutput(subject, r => paintRect(r, p.placedX + 40, bottom + 8, Math.round(600 * p.scale) - 80, 40, [bg[0] - 60, bg[1] - 60, bg[2] - 60]));
    expect(ids(checkShadow(await ctxOf(block)), "shadow.kept_matches_source")[0]?.ok).toBe(false);
  }, 60_000);
  it("does not run background_kept and fringe on an expected hold (the held 450 px copy) nor on white on near-white (the penti bra set on 245 grey), and still measures a kept chunk on a coloured product", async () => {
    const base = await syntheticSubject("amazon", 2, "footwear", { bg: [245, 245, 245] });
    const held = checkCutout(await ctxOf({ ...base, status: "needs_attention", expect: { attention: true, flags: ["small_source"], detector: "code" } }));
    for (const id of ["cutout.background_kept", "cutout.fringe"]) expect(ids(held, id)[0]?.status, id).toBe("not_run");
    expect(ids(held, "cutout.pixels_lost")[0]?.status).toBe("pass");
    // A white product on 245 grey: the estimate cannot see it, the matte is complete.
    const white = await syntheticSubject("amazon", 2, "footwear", { bg: [245, 245, 245], color: [246, 247, 248], strap: false });
    const results = checkCutout(await ctxOf(white));
    expect(ids(results, "cutout.background_kept")[0]?.status).toBe("not_run");
    expect(ids(results, "cutout.background_kept")[0]?.detail).toContain("White on near-white");
    expect(ids(results, "cutout.fringe")[0]?.status).toBe("not_run");
    // The coloured product keeps its measurement: a 90 px strip of matted background still fails.
    const kept = { ...base, alpha: Buffer.from(base.alpha) };
    for (let y = 250; y < 630; y++) for (let x = 100; x < 190; x++) kept.alpha[y * 800 + x] = 255;
    expect(failed(checkCutout(await ctxOf(kept)))).toContain("cutout.background_kept");
  }, 60_000);
  it("reads a floor reflection against the sole edge: a pink mirror of a red sole edge under a grey row is not a lost part, a lime sliver still is", () => {
    // A black upper with a two-row red sole edge; under it a grey gap row, then a pink reflection line, then white.
    const paint = (reflection: [number, number, number]) => {
      const { prepared, matte, box } = syntheticSource({ color: [30, 30, 30], strap: false }), w = prepared.width, bottom = box.y + box.h;
      for (let x = box.x; x < box.x + box.w; x++) {
        for (let y = bottom - 2; y < bottom; y++) { const i = (y * w + x) * 3; prepared.rgb[i] = 115; prepared.rgb[i + 1] = 20; prepared.rgb[i + 2] = 28; }
        for (const [dy, c] of [[0, [203, 205, 204]], [1, reflection], [2, reflection]] as const) { const i = ((bottom + dy) * w + x) * 3; prepared.rgb[i] = c[0]; prepared.rgb[i + 1] = c[1]; prepared.rgb[i + 2] = c[2]; }
      }
      return checkMatte({ identifier: "R", n: 1, source: { w, h: prepared.height, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha: matte.alpha, productType: "footwear" });
    };
    expect(ids(paint([187, 108, 95]).results, "cutout.pixels_lost")[0]?.ok).toBe(true);
    expect(ids(paint([180, 255, 60]).results, "cutout.pixels_lost")[0]?.ok).toBe(false);
  });
  it("passes flush as information for a 2:3 close-up cut on four sides that the render fits on a square canvas because filling it would trim more than a third", async () => {
    const sub = await syntheticSubject("centrepoint", 1, "apparel_model", { width: 800, height: 1300, box: { x: 100, y: 100, w: 600, h: 1100 }, cutTop: true, cutBottom: true, cutLeft: true, cutRight: true, pad: 10 });
    expect(cutBandNote(sub.reason).sides).toEqual(new Set(["left", "right"]));
    const results = await runImageChecks(sub);
    expect(failed(results)).toEqual([]);
    for (const side of ["left", "right"]) { expect(ids(results, `cut_edge.flush_${side}`)[0]?.unit, side).toBe("px, fitted by rule"); expect(ids(results, `cut_edge.flush_${side}`)[0]?.detail, side).toContain("at most a third"); }
    for (const side of ["top", "bottom"]) expect(ids(results, `cut_edge.flush_${side}`)[0]?.measured, side).toBe(0);
    expect(failed(checkCutEdge(await ctxOf({ ...sub, reason: null })))).toEqual(["cut_edge.flush_left", "cut_edge.flush_right"]);
  }, 60_000);
  it("allows a kept photographic shadow on apparel (SPEC.md preserve_only), compares it with the source and keeps it out of the halo ring and the stray count", async () => {
    // A wide product on a model-photo type: the render keeps the photo's own shadow and sets no shadow flag.
    const kept = await syntheticSubject("amazon", 1, "apparel_model", { sourceShadow: true, box: { x: 100, y: 300, w: 600, h: 300 } });
    expect(kept.flags).not.toContain("no_shadow_source");
    expect(kept.flags).not.toContain("shadow_synthesised");
    const results = await runImageChecks(kept);
    expect(failed(results)).toEqual([]);
    expect(ids(results, "shadow.forbidden")[0]?.status).toBe("not_run");
    expect(ids(results, "shadow.kept_matches_source")[0]?.status).toBe("pass");
    for (const id of ["geometry.outside_product", "cutout.halo"]) expect(ids(results, id)[0]?.status, id).toBe("pass");
    const p = kept.placement, bg = canvasColor("amazon", 1), bottom = p.placedY + Math.round(360 * p.scale), width = Math.round(600 * p.scale);
    const block = await editOutput(kept, r => paintRect(r, p.placedX + 40, bottom + 8, width - 80, 40, [bg[0] - 60, bg[1] - 60, bg[2] - 60]));
    expect(failed(checkShadow(await ctxOf(block)))).toContain("shadow.kept_matches_source");
    // The same darkening on an output that says it carries no shadow is a forbidden shadow.
    const none = await ctxOf({ ...block, flags: [...block.flags, "no_shadow_source"] });
    expect(ids(checkShadow(none), "shadow.forbidden")[0]?.ok).toBe(false);
    expect(failed(await checkGeometry(none))).toContain("geometry.outside_product");
  }, 60_000);
  it("runs the colour checks on a graded studio background and on a white border a cut product crosses, and still catches a lost region there", async () => {
    const graded = await syntheticSubject("amazon", 1, "footwear", { gradient: 100 });
    expect(graded.sourceBackground.uniform).toBe(false);
    const model = backgroundModel(graded.source, graded.sourceBackground);
    expect(model?.kind).toBe("graded");
    expect(model!.residual).toBeLessThanOrEqual(2);
    expect(model!.at(0)[0]).toBeGreaterThanOrEqual(253);
    expect(model!.at(799)[0]).toBeLessThanOrEqual(157);
    const results = checkCutout(await ctxOf(graded));
    expect(failed(results)).toEqual([]);
    for (const id of ["cutout.pixels_lost", "cutout.thin_parts", "cutout.background_kept", "cutout.edge_softness", "cutout.fringe"]) expect(ids(results, id)[0]?.status, id).toBe("pass");
    const chunk = { ...graded, alpha: Buffer.from(graded.alpha) };
    for (let y = 250; y < 330; y++) for (let x = 200; x < 300; x++) chunk.alpha[y * 800 + x] = 0;
    expect(failed(checkCutout(await ctxOf(chunk)))).toContain("cutout.pixels_lost");
    // A model cut at the bottom of a white frame: prepare calls the border "not uniform" (the legs cross it), the row medians are white.
    const cut = await syntheticSubject("amazon", 1, "apparel_model", { width: 800, height: 1200, box: { x: 150, y: 100, w: 500, h: 1100 }, cutBottom: true });
    const cutModel = backgroundModel(cut.source, { uniform: false, color: cut.sourceBackground.color });
    expect(cutModel?.kind).toBe("graded");
    expect(cutModel!.at(1199)).toEqual([255, 255, 255]);
    expect(ids(checkCutout(await ctxOf({ ...cut, sourceBackground: { ...cut.sourceBackground, uniform: false } })), "cutout.pixels_lost")[0]?.status).toBe("pass");
  }, 60_000);
});

describe("run 3 calibration 2 (penti.apparel_model, vero_moda and the small sets, mocked judge)", () => {
  const WIDE = { width: 2600, height: 2600, box: { x: 500, y: 700, w: 1600, h: 800 }, taper: true };
  const rampAlpha = (k: number, interior: (x: number, y: number, box: { x: number; y: number; w: number; h: number }) => number | null = () => null) => {
    const { prepared, box } = syntheticSource(), w = prepared.width, h = prepared.height, alpha = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = Math.max(0, box.x - x, x - (box.x + box.w - 1)), dy = Math.max(0, box.y - y, y - (box.y + box.h - 1)), d = Math.max(dx, dy);
      alpha[y * w + x] = d === 0 ? interior(x, y, box) ?? 255 : d <= k ? Math.round(255 * (1 - d / (k + 1))) : 0;
    }
    return { identifier: "P", n: 1, source: { w, h, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha, productType: "apparel_model" as const };
  };
  it("does not measure flush on a pass-through placed fitted by rule (Z91D419FC9238E844BF77Z n=4, ZE24FAC8A6A40C5FE5400Z n=3) and still judges trim, no_line and the flag", async () => {
    const sub = await syntheticSubject("centrepoint", 1, "apparel_model", { width: 800, height: 1300, box: { x: 100, y: 100, w: 600, h: 1100 }, cutTop: true, cutBottom: true, cutLeft: true, cutRight: true, pad: 10 });
    // Without the band note the fitted bands beside the cut sides fail; on a pass-through the fit is the rule.
    expect(failed(checkCutEdge(await ctxOf({ ...sub, reason: null })))).toEqual(["cut_edge.flush_left", "cut_edge.flush_right"]);
    const results = checkCutEdge(await ctxOf({ ...sub, reason: null, flags: [...sub.flags, "matte_passthrough" as const] }));
    expect(failed(results)).toEqual([]);
    for (const side of ["top", "bottom", "left", "right"]) expect(ids(results, `cut_edge.flush_${side}`)[0]?.status, side).toBe("not_run");
    expect(ids(results, "cut_edge.trim")[0]?.status).toBe("pass");
    for (const side of ["top", "bottom", "left", "right"]) expect(ids(results, `cut_edge.no_line_${side}`)[0]?.status, side).toBe("pass");
    expect(ids(results, "cut_edge.flagged")[0]?.ok).toBe(true);
    expect(ids(results, "cut_edge.not_held")[0]?.ok).toBe(true);
  }, 60_000);
  it("subtracts a flat canvas strip pasted along a frame edge from the product estimate (Z41E81A2CE5C612624C11Z n=3: 100% of a cell and 80.5% of the thin pixels were a white strip) but not a textured product edge", () => {
    const strip = (textured: boolean) => {
      const { prepared, matte } = syntheticSource({ bg: [200, 200, 200], strap: false }), w = prepared.width, h = prepared.height;
      for (let y = 0; y < h; y++) for (let x = w - 24; x < w; x++) { const i = (y * w + x) * 3, v = textured ? 232 + ((x + y) % 7) * 3 : 255; prepared.rgb[i] = v; prepared.rgb[i + 1] = v; prepared.rgb[i + 2] = v; }
      const input = { identifier: "S", n: 1, source: { w, h, rgb: prepared.rgb }, sourceBackground: { uniform: true, color: [200, 200, 200] as [number, number, number] }, alpha: matte.alpha, productType: "apparel_model" as const };
      return { input, strips: canvasStrips(input.source, backgroundModel(input.source, input.sourceBackground)!) };
    };
    const flat = strip(false);
    expect(flat.strips.depth).toEqual({ top: 0, bottom: 0, left: 0, right: 24 });
    const results = checkMatte(flat.input).results;
    expect(ids(results, "cutout.pixels_lost")[0]?.ok).toBe(true);
    expect(ids(results, "cutout.pixels_lost")[0]?.measured).toBe(0);
    // The same 24 columns textured (a product edge cut at the frame, luma range over 6): product, and dropping them is a loss.
    const textured = strip(true);
    expect(textured.strips.depth.right).toBe(0);
    expect(ids(checkMatte(textured.input).results, "cutout.pixels_lost")[0]?.ok).toBe(false);
  });
  it("fails opaque_share and pixels_copied on a translucent matte (ZBE55F7B86F158FEA0EB9Z n=5, a ghost published at effective alpha 0.22); a sheer interior at alpha 200 and hair at alpha 150 over a tenth of the body pass", async () => {
    expect(OPAQUE_SHARE_MIN).toBe(0.8);
    const ghost = checkMatte(rampAlpha(3, () => 50));
    expect(ghost.metrics.opaqueShare).toBe(0);
    expect(ids(ghost.results, "cutout.opaque_share")[0]?.ok).toBe(false);
    expect(ids(ghost.results, "cutout.opaque_share")[0]?.detail).toContain("ghost");
    expect(ids(checkMatte(rampAlpha(3, () => 200)).results, "cutout.opaque_share")[0]?.ok).toBe(true);
    const hair = checkMatte(rampAlpha(3, (x, y, box) => (y < box.y + box.h * 0.1 ? 150 : null)));
    expect(hair.metrics.opaqueShare).toBeGreaterThan(0.85);
    expect(ids(hair.results, "cutout.opaque_share")[0]?.ok).toBe(true);
    // On the canvas: the output carries the product, the matte says it is translucent, so no opaque product pixel reaches the canvas and nothing was copied.
    const base = await syntheticSubject("amazon", 2, "footwear"), alpha = Buffer.from(base.alpha);
    for (let i = 0; i < alpha.length; i++) if (alpha[i]) alpha[i] = 60;
    const results = await checkGeometry(await ctxOf({ ...base, alpha }));
    expect(ids(results, "geometry.pixels_copied")[0]?.status).toBe("fail");
    expect(ids(results, "geometry.pixels_copied")[0]?.detail).toContain("No opaque product pixels");
  }, 30_000);
  it("keeps the render's own kept shadow out of footprint and halo on every side of a flat lay (vero_moda: 97 halo and 64 footprint fails on exactly the 20 kept-shadow photos) and still fails darkening where the render kept none", async () => {
    const { prepared, matte, box } = syntheticSource({ sourceShadow: true, strap: false, box: { x: 150, y: 250, w: 500, h: 300 } }), w = prepared.width;
    // The photographer's shadow beside the garment, joined to the contact shadow under it (a flat lay lit from above).
    for (let y = box.y + 40; y < box.y + box.h + 40; y++) for (const x0 of [box.x - 30, box.x + box.w]) for (let x = x0; x < x0 + 30; x++) {
      const i = y * w + x; if (matte.alpha[i]) continue;
      const v = Math.round(255 * (1 - 0.3 * (1 - Math.abs(x - (x0 + 15)) / 15))); prepared.rgb[i * 3] = v; prepared.rgb[i * 3 + 1] = v; prepared.rgb[i * 3 + 2] = v;
    }
    const out = await renderSource({ prepared, matte, channel: "amazon", shotNumber: 1, productType: "apparel_flat", identifier: "LAY", publicObjectPath: "catalog-test/x/LAY/amazon/LAY_1.jpg" });
    if (!out.jpeg) throw new Error(out.notes.join("; "));
    const subject: OutputSubject = { identifier: "LAY", n: 1, channel: "amazon", productType: "apparel_flat", source: { w, h: prepared.height, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha: matte.alpha, jpeg: out.jpeg, placement: { w: out.plan.w, h: out.plan.h, scale: out.plan.scale, placedX: out.plan.placedX, placedY: out.plan.placedY }, flags: out.flags as OutputFlag[], status: "staged", reason: out.notes.join("; ") || null, expect: { attention: false, flags: [], detector: "code" } };
    expect(subject.flags).not.toContain("no_shadow_source");
    const ctx = await ctxOf(subject);
    expect(keptShadowCanvasMask(ctx)).not.toBeNull();
    const results = await runImageChecks(subject);
    expect(failed(results)).toEqual([]);
    expect(ids(results, "shadow.footprint")[0]?.detail).toContain("kept-darkness mask");
    expect(ids(results, "cutout.halo")[0]?.detail).toContain("kept-darkness mask");
    // A grey patch above the garment (the render kept no darkness there) still fails footprint; a grey strip along the top edge still fails halo.
    const p = subject.placement, bg = canvasColor("amazon", 1);
    const patch = await editOutput(subject, r => paintRect(r, p.placedX + 100, p.placedY - 80, 40, 30, [bg[0] - 25, bg[1] - 25, bg[2] - 25]));
    expect(failed(checkShadow(await ctxOf(patch)))).toContain("shadow.footprint");
    const halo = await editOutput(subject, r => paintRect(r, p.placedX + 60, p.placedY - 3, 300, 3, [200, 200, 200]));
    expect(failed(checkCutout(await ctxOf(halo)))).toContain("cutout.halo");
    // The mask exists only in kept mode: the same output said to carry no shadow gets none, and its side shadow is then a stray.
    expect(keptShadowCanvasMask(await ctxOf({ ...subject, flags: [...subject.flags, "no_shadow_source" as const] }))).toBeNull();
  }, 60_000);
  it("leaves hair and straps (the matte's thin structures) out of the fringe count (vero_moda: 14 fails of 8 to 13.6% on amazon and shein on hair and sheer tights) and does not run it on a source tagged transparent", async () => {
    const base = await syntheticSubject("amazon", 2, "footwear"), ctx = await ctxOf(base), p = base.placement, strapBottom = p.placedY + Math.round(60 * p.scale);
    // The soft edge along the 3 px strap painted in the source's white: thin structure, left out; the body's edge is clean.
    const strap = await editOutput(base, r => { for (let i = 0; i < ctx.expectedAlpha.length; i++) { const a = ctx.expectedAlpha[i]!; if (Math.floor(i / r.w) < strapBottom && a > 10 && a <= 200) { r.rgb[i * 3] = 255; r.rgb[i * 3 + 1] = 255; r.rgb[i * 3 + 2] = 255; } } });
    const fringe = ids(checkCutout(await ctxOf(strap)), "cutout.fringe")[0];
    expect(fringe?.ok).toBe(true);
    const counts = /(\d+) thin-structure pixels of hair, straps or sheer fabric left out of (\d+)/.exec(fringe?.detail ?? "");
    expect(counts).not.toBeNull();
    // Counted as edge, the strap's white pixels alone would be over the 1% bar.
    expect(Number(counts![1]) / Number(counts![2])).toBeGreaterThan(0.01);
    expect(ids(checkCutout(await ctxOf({ ...base, tags: ["transparent"] })), "cutout.fringe")[0]?.status).toBe("not_run");
    // The body's soft edge in the source colour still fails (the existing fringe case, with the strap left out).
    const body = await editOutput(base, r => { for (let i = 0; i < ctx.expectedAlpha.length; i++) { const a = ctx.expectedAlpha[i]!; if (a > 10 && a <= 200) { r.rgb[i * 3] = 255; r.rgb[i * 3 + 1] = 255; r.rgb[i * 3 + 2] = 255; } } });
    expect(failed(checkCutout(await ctxOf(body)))).toContain("cutout.fringe");
  }, 30_000);
  it("records a missing synthesised shadow on a bag or hardline product standing on a contact line as information, never a failure (the standing clutch Z02B2EE44E3A08044B816Z n=7/8, the candles), and does not run it on apparel, a cut source, a hanging product or a drawn shadow", async () => {
    const lay = await syntheticSubject("amazon", 1, "apparel_flat", WIDE);
    expect(lay.flags).toContain("no_shadow_source");
    expect(ids(checkShadow(await ctxOf(lay)), "shadow.expected_synthesis")[0]?.status).toBe("not_run");
    const bag = { ...lay, productType: "bag_accessory" as const }, row = ids(checkShadow(await ctxOf(bag)), "shadow.expected_synthesis")[0];
    expect(row?.status).toBe("info");
    expect(row?.ok).toBe(true);
    expect(row?.detail).toContain("wider than tall");
    expect(failed(await runImageChecks(bag))).toEqual([]);
    const tall = { ...await syntheticSubject("amazon", 1, "apparel_flat", { width: 2600, height: 2600, box: { x: 900, y: 500, w: 800, h: 1600 } }), productType: "other" as const };
    expect(ids(checkShadow(await ctxOf(tall)), "shadow.expected_synthesis")[0]?.detail).toContain("taller than wide");
    const cut = { ...await syntheticSubject("amazon", 1, "apparel_flat", { ...WIDE, cutLeft: true }), productType: "bag_accessory" as const };
    expect(ids(checkShadow(await ctxOf(cut)), "shadow.expected_synthesis")[0]?.detail).toContain("cut at the source left");
    // Hanging: the lowest 120 rows of the box hold a 24 px hook only (wider than the radius-8 opening, so it is the base the
    // suite reads); a 12 px strap below a wide base is dropped by the opening and the base is the contact line (section 15e).
    const sw = bag.source.w, c0 = await ctxOf(bag), bgc = canvasColor("amazon", 1), alpha = Buffer.from(bag.alpha);
    for (let y = 1500 - 120; y < 1500; y++) for (let x = 500; x < 2100; x++) if (x < 1288 || x >= 1312) alpha[y * sw + x] = 0;
    const rowOf = (sy: number) => c0.productBox.y + Math.round((sy - c0.sourceCrop.y) * c0.productBox.h / c0.sourceCrop.h);
    const hanging = { ...await editOutput(bag, r => paintRect(r, 0, rowOf(1380) - 2, r.w, rowOf(1500) - rowOf(1380) + 6, bgc)), alpha };
    expect(ids(checkShadow(await ctxOf(hanging)), "shadow.expected_synthesis")[0]?.detail).toContain("does not stand on a contact line");
    const strap = Buffer.from(bag.alpha);
    for (let y = 1500 - 40; y < 1500; y++) for (let x = 500; x < 2100; x++) if (x < 1290 || x >= 1302) strap[y * sw + x] = 0;
    expect(ids(checkShadow(await ctxOf({ ...await editOutput(bag, r => paintRect(r, 0, rowOf(1460) - 2, r.w, rowOf(1500) - rowOf(1460) + 6, bgc)), alpha: strap })), "shadow.expected_synthesis")[0]?.status).toBe("info");
    const shoe = await syntheticSubject("amazon", 1, "footwear", WIDE);
    expect(shoe.flags).toContain("shadow_synthesised");
    expect(ids(checkShadow(await ctxOf(shoe)), "shadow.expected_synthesis")[0]?.detail).toContain("synthesised a shadow");
  }, 90_000);
});

describe("live run calibration 3 (session 5, live judge, build 13fe10d)", () => {
  it("compares pixels_copied with the render's own reproduction (lanczos3 plus the spec 11 sharpening at the render's alpha weight) on an enlargement and with the source on a downscale, and still fails a redrawn product and a ghost", async () => {
    const enlarged = await syntheticSubject("centrepoint", 1, "footwear", { logo: { x: 300, y: 350, w: 120, h: 80 } });
    const ctx = await ctxOf(enlarged), scale = enlargementOf(ctx.sourceCrop, ctx.productBox);
    expect(scale).toBeGreaterThan(1);
    const floor = await reproductionFloor(ctx, scale);
    let changed = 0;
    for (let i = 0; i < floor.length; i++) if (floor[i] !== ctx.sourceRgb[i]) changed++;
    expect(changed).toBeGreaterThan(0);
    // The silhouette edge keeps its plain lanczos colour: a pixel whose alpha within 2 px is under the floor is untouched.
    const { productBox: pb, canvas } = ctx;
    for (let y = 0; y < pb.h; y++) for (let x = 0; x < pb.w; x++) {
      const a = ctx.expectedAlpha[(pb.y + y) * canvas.w + pb.x + x]!;
      if (a > 0 && a <= 200) for (let c = 0; c < 3; c++) expect(floor[(y * pb.w + x) * 3 + c]).toBe(ctx.sourceRgb[(y * pb.w + x) * 3 + c]);
    }
    const row = await pixelsCopied(ctx, { identifier: "S", n: 1, channel: "centrepoint" });
    expect(row.status).toBe("pass");
    expect(row.detail).toContain("the render's own reproduction (lanczos3 at");
    const downscaled = await syntheticSubject("noon", 1, "footwear", { width: 3000, height: 3000, box: { x: 300, y: 300, w: 2400, h: 2000 } });
    const dctx = await ctxOf(downscaled);
    expect(enlargementOf(dctx.sourceCrop, dctx.productBox)).toBeLessThanOrEqual(1);
    const plain = await pixelsCopied(dctx, { identifier: "S", n: 1, channel: "noon" });
    expect(plain.status).toBe("pass");
    expect(plain.detail).toContain("differ from the source by");
    const p = enlarged.placement, redrawn = await editOutput(enlarged, r => paintRect(r, p.placedX + Math.round(80 * p.scale), p.placedY + Math.round(120 * p.scale), 600, 600, [0, 200, 0]));
    expect(failed(await checkGeometry(await ctxOf(redrawn)))).toContain("geometry.pixels_copied");
    const ghost = Buffer.from(enlarged.alpha);
    for (let i = 0; i < ghost.length; i++) if (ghost[i]) ghost[i] = 60;
    expect(ids(await checkGeometry(await ctxOf({ ...enlarged, alpha: ghost })), "geometry.pixels_copied")[0]?.status).toBe("fail");
  }, 90_000);
  it("holds a kept footwear shadow to 8 luma and apparel to 4, needs 400 compared source pixels, and still fails a block under the product", async () => {
    expect(keptDifferenceBar("footwear")).toBe(8);
    expect(keptDifferenceBar("apparel_model")).toBe(4);
    expect(KEPT_MIN_PIXELS).toBe(400);
    const kept = await syntheticSubject("amazon", 1, "footwear", { sourceShadow: true, box: { x: 100, y: 300, w: 600, h: 300 } });
    const results = checkShadow(await ctxOf(kept)), row = ids(results, "shadow.kept_matches_source")[0]!;
    expect(row.status).toBe("pass");
    expect(row.threshold).toBe(8);
    expect(keptComparedPixels(row)).toBeGreaterThanOrEqual(400);
    const p = kept.placement, bg = canvasColor("amazon", 1), bottom = p.placedY + Math.round(360 * p.scale), width = Math.round(600 * p.scale);
    const block = await editOutput(kept, r => paintRect(r, p.placedX + 40, bottom + 8, width - 80, 40, [bg[0] - 60, bg[1] - 60, bg[2] - 60]));
    expect(failed(checkShadow(await ctxOf(block)))).toContain("shadow.kept_matches_source");
    // Kept mode with nothing under the product on this channel: recorded with 0 compared pixels, so the per-photo row can read it.
    const faded = await editOutput(kept, r => paintRect(r, 0, bottom + 1, r.w, r.h - bottom - 1, bg));
    const none = ids(checkShadow(await ctxOf(faded)), "shadow.kept_matches_source")[0]!;
    expect(none.status).toBe("not_run");
    expect(keptComparedPixels(none)).toBe(0);
    const consistency = keptChannelConsistency("P", 1, [{ channel: "trendyol", compared: 8344 }, { channel: "noon", compared: 2 }, { channel: "amazon", compared: 0 }]);
    expect(consistency.status).toBe("info");
    expect(consistency.detail).toContain("trendyol (8344)");
    expect(keptChannelConsistency("P", 1, [{ channel: "trendyol", compared: 8344 }, { channel: "noon", compared: 900 }]).status).toBe("not_run");
  }, 60_000);
  it("reads a contact shadow under the sole (less saturated than the sole edge by 30 chroma) and a dark product's edge blend as shadow, not product, while the lime sliver and a dropped dark part still count", async () => {
    // A tan colour-bleed patch (chroma 100) under a red sole edge (chroma over 130): shadow. The lime sliver (chroma 195): product.
    const { prepared, matte, box } = syntheticSource({ taper: true }), w = prepared.width;
    for (let row = 0; row < 6; row++) for (let x = box.x + 60; x < box.x + box.w - 60; x++) { const i = ((box.y + box.h + row) * w + x) * 3; prepared.rgb[i] = 200; prepared.rgb[i + 1] = 150; prepared.rgb[i + 2] = 100; }
    const input = { identifier: "P", n: 1, source: { w, h: prepared.height, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha: matte.alpha, productType: "footwear" as const };
    expect(ids(checkMatte(input).results, "cutout.pixels_lost")[0]?.ok).toBe(true);
    expect(failed(checkCutout(await ctxOf(await syntheticSubject("amazon", 2, "footwear", { sliver: true }))))).toContain("cutout.pixels_lost");
    // A black garment: its soft edge blends into greys the foreground delta calls product; outside the matte they are the blend.
    const dark = syntheticSource({ color: [25, 25, 30], strap: false, box: { x: 200, y: 200, w: 400, h: 450 } }), dw = dark.prepared.width;
    for (let y = dark.box.y - 12; y < dark.box.y + dark.box.h + 12; y++) for (let x = dark.box.x - 12; x < dark.box.x + dark.box.w + 12; x++) {
      if (dark.matte.alpha[y * dw + x]) continue;
      const d = Math.max(dark.box.x - x, x - (dark.box.x + dark.box.w - 1), dark.box.y - y, y - (dark.box.y + dark.box.h - 1)), v = Math.round(60 + 190 * (d / 12));
      const i = (y * dw + x) * 3; dark.prepared.rgb[i] = v; dark.prepared.rgb[i + 1] = v; dark.prepared.rgb[i + 2] = v;
    }
    const darkInput = { identifier: "D", n: 1, source: { w: dw, h: dark.prepared.height, rgb: dark.prepared.rgb }, sourceBackground: dark.prepared.background, alpha: dark.matte.alpha, productType: "apparel_model" as const };
    expect(ids(checkMatte(darkInput).results, "cutout.pixels_lost")[0]?.ok).toBe(true);
    const dropped = Buffer.from(dark.matte.alpha);
    // A dropped part above the lower zone (where any unmatted darkening is read as the contact shadow by the footwear rule).
    for (let y = dark.box.y; y < dark.box.y + 150; y++) for (let x = dark.box.x; x < dark.box.x + 120; x++) dropped[y * dw + x] = 0;
    expect(ids(checkMatte({ ...darkInput, alpha: dropped }).results, "cutout.pixels_lost")[0]?.ok).toBe(false);
  }, 60_000);
  it("leaves the soft edge of a textured source (hair) out of the fringe count and still fails a smooth garment edge carrying the background colour", async () => {
    const base = await syntheticSubject("amazon", 2, "footwear"), ctx = await ctxOf(base), sw = base.source.w;
    const fringeOn = (subject: OutputSubject) => editOutput(subject, r => { for (let i = 0; i < ctx.expectedAlpha.length; i++) if (ctx.expectedAlpha[i]! > 10 && ctx.expectedAlpha[i]! <= 200) { r.rgb[i * 3] = 255; r.rgb[i * 3 + 1] = 255; r.rgb[i * 3 + 2] = 255; } });
    const smooth = ids(checkCutout(await ctxOf(await fringeOn(base))), "cutout.fringe")[0]!;
    expect(smooth.ok).toBe(false);
    // Hair along the whole outline: a 6 px outer soft band (alpha 60) whose source pixels alternate dark strands and background.
    const hair = { ...base, alpha: Buffer.from(base.alpha), source: { ...base.source, rgb: Buffer.from(base.source.rgb) } };
    const matted = thresholdMask(base.alpha, 10), band = dilate(matted, sw, base.source.h, 6);
    for (let i = 0; i < band.length; i++) if (band[i] && !matted[i]) { hair.alpha[i] = 60; const x = i % sw, y = (i - x) / sw; if ((x + y) % 2 === 0) { hair.source.rgb[i * 3] = 40; hair.source.rgb[i * 3 + 1] = 30; hair.source.rgb[i * 3 + 2] = 20; } }
    expect(texturedSourceEdge(hair.source, hair.alpha, 300, 247)).toBe(true);
    expect(texturedSourceEdge(base.source, base.alpha, 300, 247)).toBe(false);
    const hairCtx = await ctxOf(hair), textured = ids(checkCutout(await ctxOf(await editOutput(hair, r => { for (let i = 0; i < hairCtx.expectedAlpha.length; i++) if (hairCtx.expectedAlpha[i]! > 10 && hairCtx.expectedAlpha[i]! <= 200) { r.rgb[i * 3] = 255; r.rgb[i * 3 + 1] = 255; r.rgb[i * 3 + 2] = 255; } }))), "cutout.fringe")[0]!;
    expect(textured.detail).toContain("textured source edge (hair)");
    expect(Number(/(\d+) pixels on a textured source edge/.exec(textured.detail)?.[1] ?? 0)).toBeGreaterThan(1000);
  }, 60_000);
  it("lists a sheer garment's edge softness as information (see-through over 0.5%, soft interior over 10%) and keeps a ghost failing by name", () => {
    const { prepared, box } = syntheticSource(), w = prepared.width, h = prepared.height;
    const alphaOf = (interior: (x: number, y: number) => number) => { const a = Buffer.alloc(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h; const d = inside ? 0 : Math.max(box.x - x, x - (box.x + box.w - 1), box.y - y, y - (box.y + box.h - 1)); a[y * w + x] = inside ? interior(x, y) : d <= 6 ? Math.round(255 * (1 - d / 7)) : 0; } return a; };
    const input = (alpha: Buffer) => ({ identifier: "S", n: 1, source: { w, h, rgb: prepared.rgb }, sourceBackground: prepared.background, alpha, productType: "apparel_model" as const });
    const sheer = checkMatte(input(alphaOf((x, y) => ((x * 7 + y * 3) % 10 < 3 ? 215 : (x + y) % 97 === 0 ? 150 : 255))));
    expect(sheer.metrics.sheer).toBe(true);
    expect(ids(sheer.results, "cutout.edge_softness")[0]?.status).toBe("info");
    expect(ids(sheer.results, "cutout.edge_softness")[0]?.detail).toContain("Sheer fabric");
    const solid = checkMatte(input(alphaOf(() => 255)));
    expect(solid.metrics.sheer).toBe(false);
    expect(ids(solid.results, "cutout.edge_softness")[0]?.status).toBe("fail");
    const ghost = checkMatte(input(alphaOf(() => 50)));
    expect(ghost.metrics.sheer).toBe(false);
    expect(ids(ghost.results, "cutout.opaque_share")[0]?.ok).toBe(false);
    expect(ids(ghost.results, "cutout.edge_softness")[0]?.status).toBe("fail");
  });
  it("fits a flat border the product crosses on its cut sides from the plain rows outside the matte's span, records every colour-estimate check as not run without a model, and still fits nothing on a busy border", async () => {
    // A wide box cut at the left and right over 45% of the rows of a white frame: 55% plain rows, accepted (over the 50% overall bar).
    // The product is textured (a two-colour weave), so the rows it crosses are not plain, as a real box or bottle is not.
    const weave = (subject: OutputSubject) => { const rgb = Buffer.from(subject.source.rgb), w = subject.source.w; for (let i = 0; i < subject.alpha.length; i++) if (subject.alpha[i]) { const x = i % w, y = (i - x) / w, c = (x + y) % 2 ? [60, 120, 200] : [160, 30, 50]; rgb[i * 3] = c[0]!; rgb[i * 3 + 1] = c[1]!; rgb[i * 3 + 2] = c[2]!; } return { ...subject, source: { ...subject.source, rgb } }; };
    const wide = weave(await syntheticSubject("amazon", 1, "other", { width: 800, height: 800, box: { x: 10, y: 220, w: 780, h: 360 }, cutLeft: true, cutRight: true, strap: false }));
    const src = wide.source, notUniform = { uniform: false, color: wide.sourceBackground.color };
    expect(backgroundModel(src, notUniform)?.kind).toBe("graded");
    // Crossing 70% of the rows: under 50% overall, accepted with the matte (the rows outside the span are all plain), not without it.
    const tall = weave(await syntheticSubject("amazon", 1, "other", { width: 800, height: 800, box: { x: 10, y: 120, w: 780, h: 560 }, cutLeft: true, cutRight: true, strap: false }));
    expect(backgroundModel(tall.source, { uniform: false, color: tall.sourceBackground.color })).toBeNull();
    expect(backgroundModel(tall.source, { uniform: false, color: tall.sourceBackground.color }, tall.alpha)?.kind).toBe("graded");
    expect(ids(checkCutout(await ctxOf({ ...tall, sourceBackground: { ...tall.sourceBackground, uniform: false } })), "cutout.pixels_lost")[0]?.status).toBe("pass");
    // A busy border (random noise everywhere) fits nothing, and every colour-estimate check says so.
    const busy = { ...tall, source: { ...tall.source, rgb: Buffer.from(tall.source.rgb) } };
    for (let i = 0; i < busy.source.rgb.length; i++) busy.source.rgb[i] = (i * 7919) % 256;
    const results = checkMatte({ identifier: "B", n: 1, source: busy.source, sourceBackground: { uniform: false, color: [255, 255, 255] }, alpha: busy.alpha, productType: "other" });
    for (const id of COLOUR_ESTIMATE_CHECKS) expect(ids(results.results, id)[0]?.status, id).toBe("not_run");
  }, 60_000);
  it("takes the render's band note as read on a whole-frame close-up cut on all four sides, keeps failing a band without the note, and protects the top of a model shot in the fill rule", async () => {
    const sub = await syntheticSubject("centrepoint", 1, "apparel_model", { width: 800, height: 1300, box: { x: 100, y: 100, w: 600, h: 1100 }, cutTop: true, cutBottom: true, cutLeft: true, cutRight: true, pad: 10 });
    const results = checkCutEdge(await ctxOf(sub));
    for (const side of ["left", "right"]) expect(ids(results, `cut_edge.flush_${side}`)[0]?.unit, side).toBe("px, fitted by rule");
    expect(failed(checkCutEdge(await ctxOf({ ...sub, reason: null })))).toEqual(["cut_edge.flush_left", "cut_edge.flush_right"]);
    // Cut at the top (and both sides) only: filling the width would trim the uncut bottom, and the top is never trimmed on a model shot.
    const top = await syntheticSubject("centrepoint", 1, "apparel_model", { width: 800, height: 1300, box: { x: 100, y: 10, w: 600, h: 1000 }, cutTop: true, cutLeft: true, cutRight: true, pad: 10 });
    const topResults = checkCutEdge(await ctxOf(top));
    expect(failed(topResults)).toEqual([]);
    const flushLeft = ids(topResults, "cut_edge.flush_left")[0];
    if (flushLeft?.unit === "px, fitted by rule") expect(flushLeft.detail).toContain("never trimmed");
  }, 60_000);
});
