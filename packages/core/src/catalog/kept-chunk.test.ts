// R1 exit proof, cause 2: a piece of backdrop left in a cut-out is taken out of it, not a reason to throw the cut-out away. The
// lower-half rule the guard has is kept; an upper-half patch at the neck is only looked for when the judge saw leftover background.
import { describe, expect, it } from "vitest";
import { agreedMatte, diagnoseOutput, FIRST_VARIANT, type Diagnosis } from "./auto-resolve";
import { backgroundRegion, checkMatteIntegrity, keptBackgroundMask, resolveMatte, withoutKeptBackground } from "./matte-guard";
import type { Matte, Prepared } from "./render";

const W = 400, H = 600;
const WHITE = [250, 250, 250], DARK = [40, 40, 60];
const inside = (x: number, y: number, x0: number, y0: number, w: number, h: number) => x >= x0 && x < x0 + w && y >= y0 && y < y0 + h;
const garment = (x: number, y: number) => inside(x, y, 120, 100, 160, 400);
const dressOnWhite: Pick<Prepared, "width" | "height" | "rgb"> = (() => {
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = garment(x, y) ? DARK : WHITE; rgb.set(c, (y * W + x) * 3); }
  return { width: W, height: H, rgb };
})();
const matteOf = (keep: (x: number, y: number) => boolean, model = "first"): Matte => {
  const alpha = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (keep(x, y)) alpha[y * W + x] = 255;
  return { alpha, width: W, height: H, model, ms: 1, source: "model" };
};
const region = backgroundRegion(dressOnWhite);
const lowChunk = (x: number, y: number) => garment(x, y) || inside(x, y, 280, 380, 60, 60);
const neckPatch = (x: number, y: number) => garment(x, y) || inside(x, y, 280, 110, 60, 60);

describe("a kept background chunk", () => {
  it("the guard's rule stays: a chunk in the lower half rejects the cut-out, a patch in the upper half does not", () => {
    expect(checkMatteIntegrity(dressOnWhite, matteOf(lowChunk), { handRule: false, region }).detail).toMatch(/^kept background/);
    expect(checkMatteIntegrity(dressOnWhite, matteOf(neckPatch), { handRule: false, region }).ok).toBe(true);
  });

  it("is taken out of the cut-out and the rest kept to the pixel", () => {
    const clean = withoutKeptBackground(dressOnWhite, matteOf(lowChunk), region)!;
    expect(clean.model).toBe("first");
    expect(clean.alpha[400 * W + 300]).toBe(0);
    expect(clean.alpha[300 * W + 200]).toBe(255);
    expect(checkMatteIntegrity(dressOnWhite, clean, { handRule: false, region }).ok).toBe(true);
  });

  it("a patch in the upper half comes out only when asked for", () => {
    expect(withoutKeptBackground(dressOnWhite, matteOf(neckPatch), region)).toBeNull();
    const clean = withoutKeptBackground(dressOnWhite, matteOf(neckPatch), region, { anyDepth: true })!;
    expect(clean.alpha[130 * W + 300]).toBe(0);
    expect(clean.alpha[130 * W + 200]).toBe(255);
  });

  it("a cut-out with nothing to take out is left alone: null, so the repair is not offered", () => {
    expect(withoutKeptBackground(dressOnWhite, matteOf(garment), region, { anyDepth: true })).toBeNull();
  });

  it("control: white on the backdrop's white that touches nothing the matte dropped stays (a label inside the garment)", () => {
    const labelled = { ...dressOnWhite, rgb: Buffer.from(dressOnWhite.rgb) };
    for (let y = 200; y < 300; y++) for (let x = 170; x < 230; x++) labelled.rgb.set(WHITE, (y * W + x) * 3);
    expect(keptBackgroundMask(labelled, matteOf(garment).alpha, backgroundRegion(labelled), { anyDepth: true }).some(v => v)).toBe(false);
  });

  it("the ladder uses it last: every model kept the chunk and none agree, so the first cut-out is cleaned, re-checked, and always judged", async () => {
    const asked: string[] = [];
    const out = await resolveMatte({ prepared: dressOnWhite, first: matteOf(lowChunk), handRule: true, attempt: async v => { asked.push(v); return matteOf(lowChunk, v); } });
    expect(asked).toEqual(["second", "padded_first", "padded_second"]);
    expect(out).toMatchObject({ passthrough: false, busyBackground: false });
    expect(out.actions.at(-1)).toMatchObject({ step: "matte_chunk_removed", result: "passed", channels: [] });
    expect(out.matte.alpha[400 * W + 300]).toBe(0);
    expect(out.matte.model).toBe("first");
    // The judge stands behind it whatever the sample rate (qa-stage.ts), and an unseen one is never delivered (triage.ts).
    expect(agreedMatte({ auto_actions: out.actions })).toBe(true);
  });

  it("control: a second cut-out that passes the guard still wins, the photo costs what it cost and looks as it looked", async () => {
    const out = await resolveMatte({ prepared: dressOnWhite, first: matteOf(lowChunk), handRule: true, attempt: async v => (v === "second" ? matteOf(garment, v) : null) });
    expect(out.matte.model).toBe("second");
    expect(out.actions.some(a => a.step === "matte_chunk_removed")).toBe(false);
    expect(agreedMatte({ auto_actions: out.actions })).toBe(false);
  });
});

describe("the repair ladder and a backdrop patch", () => {
  const base: Diagnosis = { channel: "noon", trigger: [], failures: [], measured: null, current: FIRST_VARIANT, tried: [], secondMatte: true };
  const stepsOf = (d: Partial<Diagnosis>) => diagnoseOutput({ ...base, ...d }).map(r => r.step);
  it("the judge's leftover background takes the patch out before asking a second model", () => {
    expect(stepsOf({ trigger: ["leftover_background"], keptPatch: true })).toEqual(["matte_patch_removed", "second_matte"]);
  });
  it("with no patch to take out, or another flag, the ladder is as it was", () => {
    expect(stepsOf({ trigger: ["leftover_background"] })).toEqual(["second_matte"]);
    expect(stepsOf({ trigger: ["halo"], keptPatch: true })).toEqual(["second_matte"]);
  });
  it("the judge flags the patched image: the second model still has its turn, and the patch is not tried again", () => {
    expect(stepsOf({ trigger: ["leftover_background"], keptPatch: true, tried: ["matte_patch_removed"], current: { ...FIRST_VARIANT, matte: "patched" } })).toEqual(["second_matte"]);
  });
});
