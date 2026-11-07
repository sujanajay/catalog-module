// R1 exit proof, cause 1: a frame-filling close-up cannot survive a cut-out. The plain fabric reads as a pad band to the cut
// detector, so that comes first: fabric running off the frame is a cut, never a band of the backdrop. What the models still
// destroy takes the whole-frame route, which only the judge's reading opens and the judge checks again.
import { describe, expect, it } from "vitest";
import { channel, CHANNELS } from "./channels";
import { diagnoseOutput, FIRST_VARIANT, type Diagnosis } from "./auto-resolve";
import { wholeFrameMatte, wholeFrameRoute } from "./matte-guard";
import { CUT_FILL_MAX_TRIM, NO_CUT, planCanvas, renderSource, shotGeometry, TRIM_UNCUT_SIDES, trimRules, WHOLE_FRAME_MODEL, type Prepared } from "./render";
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
    expect(wholeFrameRoute(shirt, "detail")).toMatchObject({ allowed: false, detail: expect.stringMatching(/flat top side/) });
  });
});

describe("the ladder", () => {
  const base: Diagnosis = { channel: "noon", trigger: ["product_removed"], failures: [], measured: null, current: FIRST_VARIANT, tried: [], secondMatte: true };
  const steps = (d: Partial<Diagnosis>) => diagnoseOutput({ ...base, ...d }).map(r => r.step);
  it("the close-up step comes after the second cut-out and before the pass-through", () => {
    expect(steps({ wholeFrame: true })).toEqual(["second_matte", "matte_whole_frame", "matte_passthrough"]);
    expect(steps({ wholeFrame: true, tried: ["second_matte"] })).toEqual(["matte_whole_frame", "matte_passthrough"]);
  });
  it("closed, or for another defect, it never appears", () => {
    expect(steps({ tried: ["second_matte"] })).toEqual(["matte_passthrough"]);
    expect(steps({ trigger: ["halo"], wholeFrame: true, tried: ["second_matte"] })).toEqual([]);
  });
});

describe("the whole-frame matte", () => {
  const rgb = image(fabric), p = prepared(rgb), whole = wholeFrameMatte(p);
  it("is opaque everywhere and every side counts as cut", () => {
    expect(whole.alpha.every(v => v === 255)).toBe(true);
    expect(whole.model).toBe(WHOLE_FRAME_MODEL);
    expect(trimRules("apparel_flat", whole)).toMatchObject({ wholeFrame: true, noTrim: false });
    expect(shotGeometry(whole.alpha, W, H, { rgb, ...trimRules("apparel_flat", whole) })!.cut).toEqual({ top: true, bottom: true, left: true, right: true });
  });
  it.each(Object.keys(CHANNELS) as ChannelId[])("fills the %s canvas flush, with nothing left on the canvas colour, and passes its rules", async id => {
    const r = await renderSource({ prepared: p, matte: whole, channel: id, shotNumber: 2, productType: "apparel_flat" });
    expect(r.compliance.failures).toEqual([]);
    expect(r.flags).toContain("cut_in_source");
    expect(r.notes.join(" ")).not.toMatch(/a band shows/);
    const box = r.plan.productBox!;
    expect([box.x, box.y, r.plan.w - box.x - box.w, r.plan.h - box.y - box.h]).toEqual([0, 0, 0, 0]);
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
