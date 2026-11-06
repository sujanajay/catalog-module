import { describe, expect, it } from "vitest";
import { padBands, shotGeometry } from "./render";

const W = 800, H = 1096, CLEAN = 240;
/** A clean grey photo with a product box; `paint` overwrites rows and columns. */
function photo(box: { x0: number; x1: number; y0: number; y1: number }, paint: (x: number, y: number) => number | null = () => null) {
  const rgb = Buffer.alloc(W * H * 3, CLEAN), alpha = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) { alpha[i] = 255; rgb.fill(90, i * 3, i * 3 + 3); continue; }
    const v = paint(x, y);
    if (v !== null) rgb.fill(v, i * 3, i * 3 + 3);
  }
  return { rgb, alpha };
}

describe("the pad probe reads the band's end beside the product (M1 D43, Z46B n5)", () => {
  const box = { x0: 141, x1: 660, y0: 170, y1: 930 };
  it("a contact shadow under a hem well inside the frame is not a photo edge, so the hem is not read as cut", () => {
    const { rgb, alpha } = photo(box, (x, y) => (y >= 930 && y < 938 && x >= 130 && x < 670 ? 200 : null));
    expect(padBands(rgb, alpha, W, H).bottom.photoEdge).toBe(false);
    expect(shotGeometry(alpha, W, H, { rgb })!.cut.bottom).toBe(false);
  });
  it("a real pad still reads as a photo edge: beside the product the photo's own background is another colour", () => {
    const { rgb, alpha } = photo(box, (_x, y) => (y < 938 ? 200 : null));
    expect(padBands(rgb, alpha, W, H).bottom).toMatchObject({ depth: 158, photoEdge: true });
  });
  it("with too little line beside the product it reads the whole line, as before", () => {
    const wide = { x0: 10, x1: 790, y0: 170, y1: 930 };
    const { rgb, alpha } = photo(wide, (_x, y) => (y >= 930 && y < 938 ? 200 : null));
    expect(padBands(rgb, alpha, W, H).bottom.photoEdge).toBe(true);
  });
});
