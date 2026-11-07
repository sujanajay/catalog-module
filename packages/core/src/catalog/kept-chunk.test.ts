// R1 exit proof, cause 2: a piece of backdrop left in a cut-out is taken out of it, not a reason to throw the cut-out away. The
// lower-half rule the guard has is kept; an upper-half patch at the neck is only looked for when the judge saw leftover background.
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { agreedMatte, diagnoseOutput, FIRST_VARIANT, type Diagnosis } from "./auto-resolve";
import { backgroundRegion, checkMatteIntegrity, KEPT_BACKGROUND_REMOVAL_MAX_SHARE, keptBackgroundMask, resolveMatte, withoutKeptBackground } from "./matte-guard";
import { prepare, type Matte, type Prepared } from "./render";

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
  return { alpha, width: W, height: H, model, ms: 1, source: "model", target: "cpu", sentLongSide: 1024 };
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

describe("a removal that would eat the product", () => {
  /** White ground with a white garment on it: only its dark print and fold lines differ, and the matte keeps the whole garment plus whatever the test adds. */
  const paint = (dark: (x: number, y: number) => boolean) => { const rgb = Buffer.alloc(W * H * 3); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb.set(dark(x, y) ? DARK : WHITE, (y * W + x) * 3); return { width: W, height: H, rgb }; };
  const removedShare = (matte: Matte, clean: Matte) => { let kept = 0, gone = 0; for (let i = 0; i < W * H; i++) if (matte.alpha[i]! > 128) { kept++; if (clean.alpha[i]! <= 128) gone++; } return gone / kept; };

  it("real photo: the white top on a near-white wall (Z40E29CD878FAA726501DZ shot 1, 15.5% of what the matte keeps, holes through the top) is refused on every model's cut-out", async () => {
    const dir = new URL("../../test-fixtures/catalog/matte-agreement/", import.meta.url), id = "Z40E29CD878FAA726501DZ_1";
    const p = await prepare(await readFile(new URL(`${id}.jpg`, dir)), `${id}.jpg`, async b => b);
    for (const model of ["bria-rmbg", "birefnet-general", "birefnet-general-lite"]) {
      const alpha = await sharp(await readFile(new URL(`${id}.${model}.png`, dir))).toColourspace("b-w").raw().toBuffer();
      const matte: Matte = { alpha, width: p.width, height: p.height, model, ms: 0, source: "model", target: null, sentLongSide: null };
      const region = backgroundRegion(p);
      expect(keptBackgroundMask(p, alpha, region, { anyDepth: true }).some(v => v)).toBe(true);
      expect(withoutKeptBackground(p, matte, region, { anyDepth: true })).toBeNull();
    }
  }, 60_000);

  it("a white garment nearly all taken out (the review's D2: 6.6% left, and checkMatteIntegrity still says kept) is refused by the cap", () => {
    const logo = (x: number, y: number) => inside(x, y, 190, 280, 20, 20);
    const photo = paint(logo), matte = matteOf((x, y) => inside(x, y, 120, 100, 160, 400));
    const mask = keptBackgroundMask(photo, matte.alpha, backgroundRegion(photo), { anyDepth: true });
    expect(mask.some(v => v)).toBe(true);
    expect(withoutKeptBackground(photo, matte, backgroundRegion(photo), { anyDepth: true })).toBeNull();
  });

  it("a garment left in pieces by what looks like backdrop is refused, under the cap", () => {
    // White fabric between dark seams: the seams hold, the fabric between them is the wall's colour, so the rest falls into 4 bands.
    const seams = (x: number, y: number) => inside(x, y, 120, 100, 160, 400) && (y - 100) % 100 < 45;
    const photo = paint(seams), matte = matteOf((x, y) => inside(x, y, 120, 100, 160, 400));
    const mask = keptBackgroundMask(photo, matte.alpha, backgroundRegion(photo), { anyDepth: true });
    let gone = 0, kept = 0; for (let i = 0; i < W * H; i++) { if (matte.alpha[i]! > 128) kept++; if (mask[i]) gone++; }
    expect(gone / kept).toBeLessThan(KEPT_BACKGROUND_REMOVAL_MAX_SHARE);
    expect(withoutKeptBackground(photo, matte, backgroundRegion(photo), { anyDepth: true })).toBeNull();
  });

  it("control: a cut-out that kept its whole backdrop beside the product (Z0D5EC n2: 73%) stays rescued, just under the cap", () => {
    // A dark product of about a quarter of what is kept, the rest backdrop in one piece.
    const product = (x: number, y: number) => inside(x, y, 150, 150, 100, 160);
    const photo = paint(product), matte = matteOf((x, y) => product(x, y) || inside(x, y, 110, 110, 180, 300));
    const clean = withoutKeptBackground(photo, matte, backgroundRegion(photo), { anyDepth: true })!;
    expect(clean).not.toBeNull();
    expect(removedShare(matte, clean)).toBeGreaterThan(0.6);
    expect(removedShare(matte, clean)).toBeLessThanOrEqual(KEPT_BACKGROUND_REMOVAL_MAX_SHARE);
  });

  it("control: two pieces, a backdrop that ran between a pair, stay rescued", () => {
    const pair = (x: number, y: number) => inside(x, y, 110, 150, 60, 200) || inside(x, y, 230, 150, 60, 200);
    const photo = paint(pair), matte = matteOf((x, y) => pair(x, y) || inside(x, y, 170, 230, 60, 60));
    expect(withoutKeptBackground(photo, matte, backgroundRegion(photo), { anyDepth: true })).not.toBeNull();
  });

  it("the matte stage's re-check has the last word: taking the big chunk out leaves a smaller one the guard now rejects, so nothing is cleaned and the ladder goes on", async () => {
    // The small chunk is under 2% of what the first cut-out keeps, so it stays in; with the big one gone it is over 2%, and the re-check refuses the result.
    const big = (x: number, y: number) => inside(x, y, 280, 320, 110, 170), small = (x: number, y: number) => inside(x, y, 80, 460, 40, 40);
    const keeps = (x: number, y: number) => garment(x, y) || big(x, y) || small(x, y);
    const first = matteOf(keeps), clean = withoutKeptBackground(dressOnWhite, first, region)!;
    expect(clean).not.toBeNull();
    expect(checkMatteIntegrity(dressOnWhite, clean, { handRule: false, region }).detail).toMatch(/^kept background/);
    const out = await resolveMatte({ prepared: dressOnWhite, first, handRule: true, attempt: async v => matteOf(keeps, v) });
    expect(out.actions.some(a => a.step === "matte_chunk_removed")).toBe(false);
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
