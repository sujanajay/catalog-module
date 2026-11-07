// R1 exit proof, cause 1: a frame-filling close-up cannot survive a cut-out. The plain fabric reads as a pad band to the cut
// detector. The cut detector's fix comes first: fabric running off the frame is a cut, never a band of the backdrop.
import { describe, expect, it } from "vitest";
import { NO_CUT, shotGeometry } from "./render";

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
