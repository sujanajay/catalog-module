import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { collectToManifest, main } from "./catalog-local";

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "catalog-local-"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

const jpeg = (r: number) => sharp({ create: { width: 600, height: 800, channels: 3, background: { r, g: 40, b: 90 } } }).jpeg().toBuffer();

describe("catalog-local collect", () => {
  it("writes every shot and a manifest for a folder, with the product list's warnings", async () => {
    vi.stubEnv("BUCKET", "unused");
    const from = path.join(tmp, "Photos");
    await mkdir(path.join(from, "Shoes"), { recursive: true });
    await writeFile(path.join(from, "Shoes", "AB-1_1.jpg"), await jpeg(10));
    await writeFile(path.join(from, "Shoes", "AB-1_3.jpg"), await jpeg(20));
    await writeFile(path.join(from, "Shoes", "CD2_1.jpg"), await jpeg(30));
    await writeFile(path.join(from, "Shoes", "CD2_2.jpg"), Buffer.from("%PDF-1.4\n", "latin1"));
    const list = path.join(tmp, "list.csv");
    await writeFile(list, "identifier,name\nAB-1,first\nEF3,missing\n");
    const out = path.join(tmp, "out");

    const lines: string[] = [];
    const { manifest, missing } = await collectToManifest({ brand: "Anta", from, productList: list, identifierMode: "filename", out }, (l) => lines.push(l));
    expect(manifest.brand).toBe("anta");
    expect(manifest.identifierMode).toBe("filename");
    expect(manifest.products.map((p) => [p.identifier, p.shots.map((s) => s.n)])).toEqual([["AB-1", [1, 2]], ["CD2", [1]]]);
    const shot = manifest.products[0]!.shots[1]!;
    expect(shot).toMatchObject({ width: 600, height: 800, flags: ["numbering_gap"] });
    expect(shot.path).toBe(path.join(out, "anta", "raw", "AB-1", "AB-1_2.jpg"));
    expect((await readFile(shot.path)).equals(await readFile(path.join(from, "Shoes", "AB-1_3.jpg")))).toBe(true);
    expect(manifest.rejected).toEqual([{ name: "Shoes/CD2_2.jpg", reason: "CD2_2.jpg is not an image." }]);
    expect(missing).toEqual(["EF3"]);
    expect(manifest.warnings.map((w) => w.headline)).toEqual([
      "1 products have no photos.",
      "1 products have photos but are not in your product list: CD2.",
      "1 files could not be read.",
    ]);
    expect(JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"))).toEqual(JSON.parse(JSON.stringify(manifest)));
    expect(lines.at(-1)).toBe("Collecting files 4 of 4");
  });

  it("prints the usage for a wrong command line", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await main(["render"])).toBe(2);
    expect(await main(["collect", "--brand", "anta"])).toBe(2);
    expect(await main(["collect", "--brand", "anta", "--from", tmp, "--out", tmp, "--identifier-mode", "colour"])).toBe(2);
    expect(errors.mock.calls.every(([m]) => String(m).includes("Usage: node dist/catalog-local.js collect"))).toBe(true);
    errors.mockRestore();
    expect(existsSync(path.join(tmp, "manifest.json"))).toBe(false);
  });
});
