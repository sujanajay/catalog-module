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

describe("a garment cut at the edge of a narrow photo inside side pads stays cut (M1 D43, review P2-1)", () => {
  /** White pads around a grey photo; the garment reaches the photo's bottom edge, cut flat there. */
  function padded(w: number, h: number, photoX: [number, number], garment: [number, number], background: number) {
    const rgb = Buffer.alloc(w * h * 3, 255), alpha = Buffer.alloc(w * h), photoBottom = Math.round(h * 0.9), photoTop = Math.round(h * 0.1), garmentTop = Math.round(h * 0.2);
    for (let y = photoTop; y < photoBottom; y++) for (let x = photoX[0]; x < photoX[1]; x++) {
      const i = y * w + x, onGarment = x >= garment[0] && x < garment[1] && y >= garmentTop;
      rgb.fill(onGarment ? 60 : background, i * 3, i * 3 + 3);
      if (onGarment) alpha[i] = 255;
    }
    return { rgb, alpha, w, h };
  }
  const cases: [string, ReturnType<typeof padded>, boolean][] = [
    ["A: 1000x1000, photo x 180-820, garment 230-770", padded(1000, 1000, [180, 820], [230, 770], 200), true],
    ["E: 1000x1000, side pads 12%, garment 170-830", padded(1000, 1000, [120, 880], [170, 830], 200), true],
    ["F: 1000x1250, side pads 8%, garment 130-870", padded(1000, 1250, [80, 920], [130, 870], 190), true],
    ["B: as A, garment 300-700: the photo shows beside it", padded(1000, 1000, [180, 820], [300, 700], 200), true],
    ["D: a full-width photo with no side pads", padded(1000, 1000, [0, 1000], [230, 770], 200), true],
  ];
  it.each(cases)("%s", (_name, { rgb, alpha, w, h }, cut) => {
    expect(shotGeometry(alpha, w, h, { rgb })!.cut.bottom).toBe(cut);
  });
});
