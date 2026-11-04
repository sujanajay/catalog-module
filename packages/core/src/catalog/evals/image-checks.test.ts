// Image checks, part 1 of 3: what the real render makes, and geometry failures.
// The image checks are three files so they run in parallel (one file took 6.5 min of one CI shard, M6-S7a).
import { describe, expect, it } from "vitest";
import { CHANNEL_IDS } from "../types";
import { checkGeometry, checkUniformScale } from "./geometry";
import { buildContext } from "./context";
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
