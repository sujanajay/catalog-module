import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { autoTags, buildGolden, deriveBytes, goldenCounts, goldenSourcePath, mapShotsBySha, parseGolden, plantedShotNumber, readGoldenBytes, serializeGolden, sha256, uniqueSources, type GoldenBuild, type GoldenEntry } from "./golden";

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
      overrides: { S2: { tags: ["thin_straps"], expect: { attention: false } }, T1: { shots: { "2": { tags: ["grey_background"], expect: { attention: true, flags: ["leftover_background"], detector: "code", reason: "a lifestyle photo" } } } } },
      derive: [{ from: "S1_1", op: "downscale_450", brand: "anta", category: "footwear" }, { from: "T1_2", op: "cut_bottom_15", brand: "test_brand", category: "apparel_model" }],
      plant: [{ into: "S1", from: "T1_1" }],
    };
    const writes = new Map<string, Buffer>();
    const manifest = await buildGolden(build, async (name, bytes) => { await writeFile(path.join(derived, name), bytes); writes.set(name, bytes); return name; });
    const counts = goldenCounts(manifest);
    expect(counts).toMatchObject({ products: 6, photos: 10, brands: { anta: 4, test_brand: 2 }, planted: 1, expectedAttention: 3 });
    // A per-shot override expects a hold for that photo alone.
    expect(manifest.entries.find(e => e.identifier === "T1" && e.n === 1)!.expect).toEqual({ attention: false, flags: [], detector: "code" });
    expect(manifest.entries.find(e => e.identifier === "T1" && e.n === 2)!.expect).toEqual({ attention: true, flags: ["leftover_background"], detector: "code", reason: "a lifestyle photo" });
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

  it("numbers a planted photo after the host's highest shot, so a gap never collides with a real shot", async () => {
    expect(plantedShotNumber([{ n: 1 }, { n: 2 }])).toBe(3);
    expect(plantedShotNumber([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 7 }])).toBe(8);
    const root = await mkdtemp(path.join(tmpdir(), "golden-gap-")), shoes = path.join(root, "shoes"), tops = path.join(root, "tops"), derived = path.join(root, "derived");
    await Promise.all([mkdir(shoes), mkdir(tops), mkdir(derived)]);
    await writeFile(path.join(shoes, "G1_1.jpg"), await photo(800, 800, [160, 30, 50]));
    await writeFile(path.join(shoes, "G1_3.jpg"), await photo(800, 800, [30, 30, 30]));
    await writeFile(path.join(tops, "T1_1.jpg"), await photo(800, 1200, [60, 90, 200], [230, 230, 230]));
    const build: GoldenBuild = {
      roots: { shoes, tops, derived }, seed: 3,
      plans: [{ root: "shoes", brand: "anta", category: "footwear" }, { root: "tops", brand: "test_brand", category: "apparel_model" }],
      overrides: { G1: { shots: { "3": { expect: { attention: false, flags: ["chart_image"], detector: "code", reason: "a size chart" } } } } }, derive: [], plant: [{ into: "G1", from: "T1_1" }],
    };
    const manifest = await buildGolden(build, async name => name);
    const planted = manifest.entries.filter(e => e.identifier === "G1-planted");
    expect(planted.map(e => e.n)).toEqual([1, 3, 4]);
    expect(planted.find(e => e.n === 3)!.sha256).toBe(manifest.entries.find(e => e.identifier === "G1" && e.n === 3)!.sha256);
    expect(planted.find(e => e.n === 4)).toMatchObject({ planted: { from: "T1_1" } });
    // A host shot that expects flags without a hold (a size chart) keeps that expectation in the planted copy; the other host shots carry the planted product's.
    expect(planted.find(e => e.n === 3)!.expect).toEqual({ attention: false, flags: ["chart_image"], detector: "code", reason: "a size chart" });
    expect(planted.find(e => e.n === 1)!.expect).toEqual({ attention: true, flags: ["different_product"], detector: "judge" });
    const paths = manifest.entries.map(goldenSourcePath);
    expect(new Set(paths).size).toBe(paths.length);
    // The batch renumbers the gap (1, 3, 4 become 1, 2, 3): the suite maps its shots to the manifest by sha256, by number only where no entry of the product has the bytes.
    const byBatch = (n: number, sha: string) => ({ identifier: "G1-planted", n, sha256: sha });
    const mapped = mapShotsBySha(manifest.entries, [byBatch(1, planted[0]!.sha256), byBatch(2, planted[1]!.sha256), byBatch(3, planted[2]!.sha256), { identifier: "G1", n: 3, sha256: "unknown" }]);
    expect(mapped.get("G1-planted|2")?.n).toBe(3);
    expect(mapped.get("G1-planted|2")?.expect.flags).toEqual(["chart_image"]);
    expect(mapped.get("G1-planted|3")?.planted).toEqual({ from: "T1_1" });
    expect(mapped.get("G1|3")?.n).toBe(3);
    expect(mapped.has("G1|9")).toBe(false);
  }, 60_000);

  it("counts byte-identical sources once and names the pair (eval run 3, vero_moda: ZA879DC4CE21DC00F08C3Z and ZFEA925E26F8FACC3E40FZ doubled every bake-off number)", () => {
    const entry = (identifier: string, n: number, sha256: string) => ({ identifier, n, sha256 }) as GoldenEntry;
    const { kept, duplicates } = uniqueSources([entry("A", 1, "s1"), entry("A", 2, "s2"), entry("B", 1, "s1"), entry("B", 2, "s2"), entry("C", 1, "s3"), entry("D", 1, "s1")]);
    expect(kept.map(e => `${e.identifier}_${e.n}`)).toEqual(["A_1", "A_2", "C_1"]);
    expect(duplicates).toEqual([{ sha256: "s1", kept: "A_1", dropped: ["B_1", "D_1"] }, { sha256: "s2", kept: "A_2", dropped: ["B_2"] }]);
    expect(uniqueSources([entry("A", 1, "s1")]).duplicates).toEqual([]);
  });
});
