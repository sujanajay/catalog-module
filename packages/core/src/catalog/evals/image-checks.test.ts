import { describe, expect, it } from "vitest";
import { CHANNEL_IDS } from "../types";
import { buildContext } from "./context";
import { checkCutEdge, CUT_SOURCE_FLAGS } from "./cut-edge";
import { checkCutout } from "./cutout";
import { checkGeometry, checkUniformScale } from "./geometry";
import { checkShadow } from "./shadow";
import { runImageChecks } from "./index";
import { canvasColor, editOutput, paintRect, syntheticSubject } from "./synthetic";
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
  });
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
  it("fails flush when the render fits a photo cut top and bottom and leaves a band beside the top cut, and fails trim when a placement would trim the uncut sides instead", async () => {
    // Wider than 2:3 and cut only top and bottom: the render may not trim the uncut sides, so it fits by width and a band sits above the top cut.
    const sub = await syntheticSubject("trendyol", 1, "apparel_model", { width: 1000, height: 800, box: { x: 200, y: 100, w: 600, h: 600 }, cutTop: true, cutBottom: true });
    const results = checkCutEdge(await ctxOf(sub));
    expect(ids(results, "cut_edge.trim")[0]?.ok).toBe(true);
    expect(ids(results, "cut_edge.flush_bottom")[0]?.ok).toBe(true);
    expect(ids(results, "cut_edge.flush_top")[0]?.ok).toBe(false);
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
