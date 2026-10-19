import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { autoTags, buildGolden, deriveBytes, goldenCounts, goldenSourcePath, parseGolden, readGoldenBytes, serializeGolden, sha256, type GoldenBuild } from "./golden";

async function photo(width: number, height: number, product: [number, number, number], bg: [number, number, number] = [255, 255, 255], box = { left: Math.round(width * 0.3), top: Math.round(height * 0.2), width: Math.round(width * 0.4), height: Math.round(height * 0.6) }) {
  const overlay = await sharp({ create: { width: box.width, height: box.height, channels: 3, background: { r: product[0], g: product[1], b: product[2] } } }).png().toBuffer();
  return sharp({ create: { width, height, channels: 3, background: { r: bg[0], g: bg[1], b: bg[2] } } }).composite([{ input: overlay, left: box.left, top: box.top }]).jpeg({ quality: 92 }).toBuffer();
}

describe("golden manifest", () => {
  it("builds from folders with auto tags, derived hard cases and a planted wrong item, pins sha256 and round-trips", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "golden-")), shoes = path.join(root, "shoes"), tops = path.join(root, "tops"), derived = path.join(root, "derived");
    await Promise.all([mkdir(shoes), mkdir(tops), mkdir(derived)]);
    await writeFile(path.join(shoes, "S1_1.jpg"), await photo(800, 800, [160, 30, 50]));
    await writeFile(path.join(shoes, "S1_2.jpg"), await photo(800, 800, [30, 30, 30]));
    await writeFile(path.join(shoes, "S2_1.jpg"), await photo(800, 800, [240, 240, 240]));
    await writeFile(path.join(tops, "T1_1.jpg"), await photo(800, 1200, [60, 90, 200], [230, 230, 230]));
    await writeFile(path.join(tops, "T1_2.jpg"), await photo(800, 1200, [60, 90, 200], [230, 230, 230], { left: 200, top: 0, width: 400, height: 1200 }));
    const build: GoldenBuild = {
      roots: { shoes, tops, derived }, seed: 3,
      plans: [{ root: "shoes", brand: "anta", category: "footwear" }, { root: "tops", brand: "test_brand", category: "apparel_model", identifiers: ["T1"] }],
      overrides: { S2: { tags: ["thin_straps"], expect: { attention: false } } },
      derive: [{ from: "S1_1", op: "downscale_450", brand: "anta", category: "footwear" }, { from: "T1_2", op: "cut_bottom_15", brand: "test_brand", category: "apparel_model" }],
      plant: [{ into: "S1", from: "T1_1" }],
    };
    const writes = new Map<string, Buffer>();
    const manifest = await buildGolden(build, async (name, bytes) => { await writeFile(path.join(derived, name), bytes); writes.set(name, bytes); return name; });
    const counts = goldenCounts(manifest);
    expect(counts).toMatchObject({ products: 6, photos: 10, brands: { anta: 4, test_brand: 2 }, planted: 1, expectedAttention: 2 });
    const s2 = manifest.entries.find(e => e.identifier === "S2")!;
    expect(s2.tags).toEqual(expect.arrayContaining(["white_on_white", "thin_straps"]));
    expect(manifest.entries.find(e => e.identifier === "S1" && e.n === 2)!.tags).toContain("dark_product");
    expect(manifest.entries.find(e => e.identifier === "T1" && e.n === 1)!.tags).toContain("grey_background");
    expect(manifest.entries.find(e => e.identifier === "T1" && e.n === 2)!.tags).toContain("cut_edge");
    const small = manifest.entries.find(e => e.derived?.op === "downscale_450")!;
    expect(small).toMatchObject({ identifier: "S1-downscale450", width: 450, expect: { attention: true, flags: ["small_source"], detector: "code" } });
    expect(small.tags).toContain("px500");
    const cut = manifest.entries.find(e => e.derived?.op === "cut_bottom_15")!;
    expect(cut.height).toBe(1020);
    expect(cut.tags).toContain("cut_edge");
    const planted = manifest.entries.filter(e => e.identifier === "S1-planted");
    expect(planted.map(e => e.n)).toEqual([1, 2, 3]);
    expect(planted[2]).toMatchObject({ planted: { from: "T1_1" }, brand: "anta", category: "footwear", expect: { attention: true, flags: ["different_product"], detector: "judge" } });
    expect(planted[2]!.sha256).toBe(manifest.entries.find(e => e.identifier === "T1" && e.n === 1)!.sha256);
    expect(goldenSourcePath(planted[2]!)).toBe("catalog-test/evals/golden/sources/anta/S1-planted_3.jpg");
    const again = parseGolden(serializeGolden(manifest));
    expect(again).toEqual(manifest);
    expect(sha256(await readGoldenBytes(again, small))).toBe(small.sha256);
    expect(sha256(await deriveBytes(await readFile(path.join(shoes, "S1_1.jpg")), "downscale_450"))).toBe(small.sha256);
    await writeFile(path.join(shoes, "S1_1.jpg"), await photo(800, 800, [161, 30, 50]));
    await expect(readGoldenBytes(again, again.entries[0]!)).rejects.toThrow(/sha256/);
    await expect(buildGolden({ ...build, plans: [{ root: "shoes", brand: "anta", category: "footwear", identifiers: ["NOPE"] }] }, async () => "")).rejects.toThrow(/not in shoes/);
    const tags = await autoTags(await photo(400, 400, [10, 10, 10]));
    expect(tags.tags).toEqual(expect.arrayContaining(["px500", "dark_product"]));
  }, 60_000);
});
