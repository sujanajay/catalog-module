// R1 exit proof, cause 1: a frame-filling close-up cannot survive a cut-out. The plain fabric reads as a pad band to the cut
// detector, so that comes first: fabric running off the frame is a cut, never a band of the backdrop. What the models still
// destroy takes the whole-frame route, which only the judge's reading opens and the judge checks again.
import { describe, expect, it } from "vitest";
import { channel, CHANNELS } from "./channels";
import { diagnoseOutput, FIRST_VARIANT, type Diagnosis } from "./auto-resolve";
import { wholeFrameMatte, wholeFrameRoute } from "./matte-guard";
import { CUT_FILL_MAX_TRIM, NO_CUT, planCanvas, renderSource, shotGeometry, TRIM_UNCUT_SIDES, trimRules, wholeFrameFills, WHOLE_FRAME_MODEL, type Prepared } from "./render";
import type { ChannelId } from "./types";

const W = 600, H = 800;
type RGB = readonly [number, number, number];
const image = (paint: (x: number, y: number) => RGB) => { const rgb = Buffer.alloc(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb.set(paint(x, y), (y * W + x) * 3); return rgb; };
const mask = (keep: (x: number, y: number) => boolean) => { const a = Buffer.alloc(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (keep(x, y)) a[y * W + x] = 255; return a; };
const PALE: RGB = [231, 228, 224], WHITE: RGB = [248, 248, 248], DARK: RGB = [30, 30, 40];

describe("a cut at the frame edge through plain fabric", () => {
  // 529E110, 529K410, 569E920: studio white above the collar, the pale shirt filling the frame below it. The bottom lines are uniform for over 15% of the height.
  const shirt = image((x, y) => (y < 100 ? WHITE : PALE));
  const kept = mask((x, y) => y >= 100);

  it("reads the bottom as cut: the band the matte keeps, in a colour other than the backdrop, is the product", () => {
    expect(shotGeometry(kept, W, H, { rgb: shirt })!.cut).toMatchObject({ bottom: true, left: true, right: true });
  });
  it("control: a band of the backdrop's own colour the matte kept is not a cut product", () => {
    // A white plinth kept below a dark product on the same white backdrop: the matte is opaque on the frame's last lines, the colour is the backdrop's.
    const plinth = image((x, y) => (y >= 200 && y < 600 && x >= 150 && x < 450 ? DARK : WHITE));
    const alpha = mask((x, y) => (y >= 200 && y < 600 && x >= 150 && x < 450) || (y >= 600 && x >= 100 && x < 500));
    expect(shotGeometry(alpha, W, H, { rgb: plinth })!.cut.bottom).toBe(false);
  });
  it("control: a hem inside a deep uniform band is not cut", () => {
    const dress = image((x, y) => (y >= 100 && y < 640 && x >= 150 && x < 450 ? DARK : WHITE));
    const alpha = mask((x, y) => y >= 100 && y < 640 && x >= 150 && x < 450);
    expect(shotGeometry(alpha, W, H, { rgb: dress })!.cut).toEqual(NO_CUT);
  });
  it("control: a matte opaque on under 90% of the product's extent on that line stays uncut", () => {
    const alpha = mask((x, y) => y >= 100 && (y < H - 1 || x < 300));
    expect(shotGeometry(alpha, W, H, { rgb: shirt })!.cut.bottom).toBe(false);
  });
});

const prepared = (rgb: Buffer): Prepared => ({ width: W, height: H, rgb, alphaSource: null, background: { uniform: true, color: [255, 255, 255], stdev: 0 }, flags: [], sourceMime: "image/jpeg" });
const noise = (x: number, y: number) => ((x * 31 + y * 17) ^ (x * y)) % 9 - 4;
const shade = (v: number, n: number) => Math.max(0, Math.min(255, v + n));
/** Plain pale fabric with slow folds and a little grain. */
const fabric = (x: number, y: number): RGB => { const n = noise(x, y) + Math.round(7 * Math.sin(x / 37) + 6 * Math.sin((x + y) / 61)); return [shade(PALE[0], n), shade(PALE[1], n), shade(PALE[2], n)]; };
const SKIN: RGB = [214, 160, 130];

describe("wholeFrameRoute", () => {
  const close = prepared(image(fabric));
  it("opens on the judge's detail view of plain fabric", () => {
    expect(wholeFrameRoute(close, "detail")).toMatchObject({ allowed: true });
  });
  it.each(["on-model", "front", "back", "flat", "inside", null, undefined])("stays shut on the view %s", view => {
    expect(wholeFrameRoute(close, view).allowed).toBe(false);
  });
  it("control: a person in the picture never takes it, even when the judge reads a detail", () => {
    const person = prepared(image((x, y) => (x >= 150 && x < 450 && y < 300 ? SKIN : fabric(x, y))));
    expect(wholeFrameRoute(person, "detail")).toMatchObject({ allowed: false, detail: expect.stringMatching(/skin/) });
  });
  it("control: the white band above a collar (529E110) is never published, even when the judge reads a detail", () => {
    const shirt = prepared(image((x, y) => (y < 100 ? WHITE : fabric(x, y))));
    expect(wholeFrameRoute(shirt, "detail")).toMatchObject({ allowed: false, detail: expect.stringMatching(/top side/) });
  });
  describe("white backdrop on a side, which the flat-side rule cannot see (review B1)", () => {
    const shut = (paint: (x: number, y: number) => RGB) => wholeFrameRoute(prepared(image(paint)), "detail");
    const grain = (v: number, x: number, y: number): RGB => { const n = v + noise(x, y) % 6; return [shade(n, 0), shade(n, 0), shade(n, 0)]; };
    it("a white band over most of the frame: its colour is the frame's median", () => {
      expect(shut((x, y) => (y < 500 ? WHITE : fabric(x, y)))).toMatchObject({ allowed: false, detail: expect.stringMatching(/white backdrop on the top side/) });
    });
    it("a band with JPEG noise of 5 levels", () => {
      expect(shut((x, y) => (y < 100 ? grain(248, x, y) : fabric(x, y))).allowed).toBe(false);
    });
    it("a thin band of 4 px", () => {
      expect(shut((x, y) => (y < 4 ? WHITE : fabric(x, y))).allowed).toBe(false);
    });
    it("a collar touching the top on 20% of the line", () => {
      expect(shut((x, y) => (y < 100 && (x < 240 || x >= 360) ? WHITE : fabric(x, y))).allowed).toBe(false);
    });
    it("a whole garment at 40% of the frame on white", () => {
      expect(shut((x, y) => (x >= 110 && x < 490 && y >= 150 && y < 650 ? [60, 60, 90] : WHITE)).allowed).toBe(false);
    });
    it("control: pale fabric just under the white line, the known good close-ups (529E410: 229, 228, 225) stay open", () => {
      expect(shut((x, y) => { const c = fabric(x, y); return [c[0] + 4, c[1] + 4, c[2] + 4]; })).toMatchObject({ allowed: true });
    });
    it("control: dark fabric with a little backdrop in one corner (under 10% of each side) stays open", () => {
      expect(shut((x, y) => (x < 40 && y < 40 ? WHITE : DARK))).toMatchObject({ allowed: true });
    });
  });
});

describe("the ladder", () => {
  const base: Diagnosis = { channel: "noon", trigger: ["product_removed"], failures: [], measured: null, current: FIRST_VARIANT, tried: [], secondMatte: true };
  const steps = (d: Partial<Diagnosis>) => diagnoseOutput({ ...base, ...d }).map(r => r.step);
  it("the close-up step comes after the second cut-out, and with the route open no pass-through follows it: on the same frame that would only bring the band back", () => {
    expect(steps({ wholeFrame: true })).toEqual(["second_matte", "matte_whole_frame"]);
    expect(steps({ wholeFrame: true, tried: ["second_matte"] })).toEqual(["matte_whole_frame"]);
    expect(steps({ wholeFrame: true, tried: ["second_matte", "matte_whole_frame"] })).toEqual([]);
    expect(steps({ tried: ["second_matte", "matte_whole_frame"] })).toEqual([]);
  });
  it("closed, or for another defect, it never appears", () => {
    expect(steps({ tried: ["second_matte"] })).toEqual(["matte_passthrough"]);
    expect(steps({ trigger: ["halo"], wholeFrame: true, tried: ["second_matte"] })).toEqual([]);
  });
});

describe("the whole-frame matte", () => {
  const rgb = image(fabric), p = prepared(rgb), whole = wholeFrameMatte(p);
  const FILLED_3_4: ChannelId[] = ["styli", "sixthstreet", "vogacloset"];
  it("is opaque everywhere, every side counts as cut, and no side may be trimmed", () => {
    expect(whole.alpha.every(v => v === 255)).toBe(true);
    expect(whole.model).toBe(WHOLE_FRAME_MODEL);
    expect(trimRules("apparel_flat", whole)).toMatchObject({ wholeFrame: true, noTrim: true });
    const shot = shotGeometry(whole.alpha, W, H, { rgb, ...trimRules("apparel_flat", whole) })!;
    expect(shot.cut).toEqual({ top: true, bottom: true, left: true, right: true });
    expect(shot.trimRoom).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });
  it.each(Object.keys(CHANNELS) as ChannelId[])("on %s: flush with the whole frame drawn where it fills; refused with no image and the named failure where it would float", async id => {
    const r = await renderSource({ prepared: p, matte: whole, channel: id, shotNumber: 2, productType: "apparel_flat" });
    expect(wholeFrameFills(channel(id), { w: W, h: H })).toBe(FILLED_3_4.includes(id));
    if (FILLED_3_4.includes(id)) {
      expect(r.compliance.failures).toEqual([]);
      expect(r.status).toBe("ok");
      expect(r.flags).toContain("cut_in_source");
      expect(r.notes.join(" ")).not.toMatch(/a band shows/);
      expect(r.plan.sourceCrop).toEqual({ x: 0, y: 0, w: W, h: H });
      const box = r.plan.productBox!;
      expect(Math.max(box.x, box.y, r.plan.w - box.x - box.w, r.plan.h - box.y - box.h)).toBeLessThanOrEqual(1);
    } else {
      expect(r.status).toBe("failed");
      expect(r.jpeg).toBeNull();
      expect(r.compliance.ok).toBe(false);
      expect(r.compliance.failures).toEqual([expect.stringMatching(/^whole_frame_band: /)]);
      expect(r.flags).toContain("failed_compliance");
      // Never cropped to fit, on the plan either.
      expect(r.plan.sourceCrop).toEqual({ x: 0, y: 0, w: W, h: H });
    }
  });
  it("a smaller fit of a frame that fills makes it float, so it is refused too", async () => {
    expect(wholeFrameFills(channel("styli"), { w: W, h: H }, { fitScale: 0.95 })).toBe(false);
    const r = await renderSource({ prepared: p, matte: whole, channel: "styli", shotNumber: 2, productType: "apparel_flat", fitScale: 0.95 });
    expect(r.compliance.failures).toEqual([expect.stringMatching(/^whole_frame_band: /)]);
  });
  // The real frames of the review, by their size: 729M610_DETAIL and 73ZNQ40 (the C3 look on Amazon and Shein), FRENCH_CONNECTION_FCC006 (top-stuck on Noon), and the shapes the review tried.
  it.each([
    ["729M610_DETAIL", 2250, 3000, FILLED_3_4],
    ["729M610_649", 2249, 3000, FILLED_3_4],
    ["73ZNQ40", 2250, 3000, FILLED_3_4],
    ["FRENCH_CONNECTION_FCC006", 6048, 4032, []],
    ["landscape 3:2", 1200, 800, []],
    ["landscape 5:2", 1500, 600, []],
    ["landscape 4:3", 800, 600, []],
    ["tall", 500, 1200, []],
    ["square", 800, 800, ["centrepoint", "amazon", "shein"]],
    ["2:3", 800, 1200, ["trendyol"]],
  ] as [string, number, number, ChannelId[]][])("%s (%i x %i) fills only the canvases of its own shape", (_name, w, h, fills) => {
    expect((Object.keys(CHANNELS) as ChannelId[]).filter(id => wholeFrameFills(channel(id), { w, h }))).toEqual(fills);
  });
  it("a landscape frame is refused on the render as well, on every channel, top-stuck never", async () => {
    const w = 600, h = 400, flat = Buffer.alloc(w * h * 3, 120), landscape: Prepared = { ...prepared(flat), width: w, height: h };
    for (const id of Object.keys(CHANNELS) as ChannelId[]) {
      const r = await renderSource({ prepared: landscape, matte: wholeFrameMatte(landscape), channel: id, shotNumber: 2, productType: "apparel_flat" });
      expect(r.jpeg).toBeNull();
      expect(r.compliance.failures).toEqual([expect.stringMatching(/^whole_frame_band: /)]);
    }
  });
  it("control: the pass-through keeps its fit with the band note, as before", async () => {
    const r = await renderSource({ prepared: p, matte: { ...whole, model: "passthrough" }, channel: "amazon", shotNumber: 2, productType: "apparel_flat" });
    expect(r.status).toBe("ok");
    expect(r.notes.join(" ")).toMatch(/a band shows/);
  });
  it("control: a real cut-out that floats keeps its fit with the band note", async () => {
    const r = await renderSource({ prepared: p, matte: { ...whole, model: "first" }, channel: "amazon", shotNumber: 2, productType: "apparel_flat" });
    expect(r.status).toBe("ok");
  });
});

describe("TRIM_UNCUT_SIDES", () => {
  const box = { x: 0, y: 40, w: 600, h: 720 }, cut = { top: false, bottom: false, left: true, right: true }, source = { w: W, h: H };
  it("is off: a fit leaves the cut sides where they are", () => {
    expect(TRIM_UNCUT_SIDES).toBe(false);
    const plan = planCanvas(channel("noon"), box, source, { cut });
    expect(plan.sourceCrop).toEqual(box);
    expect(plan.cut).toEqual(cut);
    expect(plan.productBox!.x).toBeGreaterThan(1);
  });
  it("on: the cut sides reach the canvas and the overflow comes off the uncut sides, by at most a third", () => {
    const plan = planCanvas(channel("amazon"), box, source, { cut, trimUncut: true, trimRoom: { top: 720, bottom: 720, left: 600, right: 600 } });
    expect(plan.productBox!.x).toBe(0);
    expect(plan.productBox!.w).toBe(plan.w);
    expect(plan.sourceCrop!.w).toBe(600);
    expect((box.h - plan.sourceCrop!.h) / box.h).toBeLessThanOrEqual(CUT_FILL_MAX_TRIM + 0.01);
    expect(plan.sourceCrop!.y).toBeGreaterThan(box.y);
  });
  it("on: a model photo's top is never trimmed; the overflow comes off the bottom", () => {
    const plan = planCanvas(channel("amazon"), box, source, { cut, trimUncut: true, trimRoom: { top: 0, bottom: 720, left: 600, right: 600 } });
    expect(plan.sourceCrop!.y).toBe(box.y);
    expect(plan.sourceCrop!.h).toBeLessThan(box.h);
  });
  it("on: past a third, the plan stays a fit with its original sides", () => {
    const tall = { x: 0, y: 0, w: 400, h: 800 };
    const plan = planCanvas(channel("amazon"), tall, { w: 400, h: 800 }, { cut, trimUncut: true });
    expect(plan.cut).toEqual(cut);
    expect(plan.sourceCrop).toEqual(tall);
  });
});
