import { describe, expect, it } from "vitest";
import { renderSource } from "../render";
import { CHANNEL_IDS, type OutputFlag } from "../types";
import { buildContext } from "./context";
import { checkCutEdge, cutBandNote, CUT_SOURCE_FLAGS } from "./cut-edge";
import { checkCutout, checkMatte, edgeSoftnessBar } from "./cutout";
import { checkGeometry, checkUniformScale } from "./geometry";
import { backgroundModel, delta, dilate, thresholdMask } from "./image";
import { checkShadow } from "./shadow";
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
  it("skips background_kept and fringe on a pass-through and on a source without a uniform border", async () => {
    const base = await syntheticSubject("amazon", 2, "footwear");
    const passthrough = checkCutout(await ctxOf({ ...base, flags: ["matte_passthrough"] }));
    expect(ids(passthrough, "cutout.background_kept")[0]?.status).toBe("not_run");
    expect(ids(passthrough, "cutout.fringe")[0]?.status).toBe("not_run");
    expect(ids(passthrough, "cutout.halo")[0]?.status).toBe("not_run");
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
  it("holds footwear to a 3 px soft edge and apparel, bags and hardline to 3.5 px", () => {
    expect(edgeSoftnessBar("footwear")).toBe(3);
    expect(edgeSoftnessBar(undefined)).toBe(3);
    for (const type of ["apparel_model", "apparel_flat", "bag_accessory", "other"] as const) expect(edgeSoftnessBar(type)).toBe(3.5);
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
