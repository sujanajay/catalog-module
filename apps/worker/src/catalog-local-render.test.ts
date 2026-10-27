import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { renderToReport, validateRenderUpload } from "./catalog-local";
import { CHANNEL_IDS } from "@catalog/core/catalog/types";

// Full-size renders are CPU-bound (about 20 s alone); with three other test workers busy they pass 30 s.
vi.setConfig({ testTimeout: 120_000 });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("refuses non-test, public-bucket, and mismatched-bucket uploads before storage access", () => {
  vi.stubEnv("BUCKET", "image-links-agent-assets");
  expect(validateRenderUpload("gs://image-links-agent-assets/catalog-test/run/")).toBe("catalog-test/run/");
  for (const uri of ["gs://image-links-agent-assets/catalog/live/", "gs://image-links-agent-public/catalog-test/run/", "gs://image-links-agent-assets/catalog-test/", "gs://image-links-agent-assets/catalog-test/run/../other/"]) expect(() => validateRenderUpload(uri)).toThrow();
  vi.stubEnv("BUCKET", "other"); expect(() => validateRenderUpload("gs://image-links-agent-assets/catalog-test/run/")).toThrow();
});

it("renders source alpha without a service, records every selected output and source error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "catalog-render-"));
  const rgb = Buffer.alloc(800 * 800 * 4);
  for (let y = 200; y < 600; y++) for (let x = 200; x < 600; x++) { const i = (y * 800 + x) * 4; rgb[i] = 40; rgb[i + 1] = 60; rgb[i + 2] = 90; rgb[i + 3] = 255; }
  const source = path.join(dir, "source.png");
  await writeFile(source, await sharp(rgb, { raw: { width: 800, height: 800, channels: 4 } }).png().toBuffer());
  const manifest = path.join(dir, "manifest.json");
  await writeFile(manifest, JSON.stringify({ brand: "test", products: [{ identifier: "ABC", shots: [{ n: 1, path: source }, { n: 2, path: path.join(dir, "missing.jpg") }] }] }));
  const report = await renderToReport({ manifest, out: path.join(dir, "out"), channels: [...CHANNEL_IDS], productType: "footwear" });
  expect(report.summary).toMatchObject({ outputs: 18, compliant: 9, skipped: 0, failed: 9 });
  expect(report.outputs.filter((o) => o.n === 2).every((o) => o.status === "failed")).toBe(true);
  expect(report.outputs.find((o) => o.channel === "noon" && o.n === 1)?.matte?.model).toBe("alpha_source");
  expect(report.contactSheet.samples).toBe(9);
  expect((await readFile(path.join(dir, "out", "noon", "ABC_1.jpg"))).subarray(0, 3)).toEqual(Buffer.from([255, 216, 255]));
  expect(JSON.parse(await readFile(path.join(dir, "out", "report.json"), "utf8"))).toMatchObject({ summary: report.summary });
});

it("records service outage for a nonuniform photo without calling it unsupported", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "catalog-render-outage-"));
  const source = path.join(dir, "source.png"), manifest = path.join(dir, "manifest.json");
  const rgb = Buffer.alloc(800 * 800 * 3);
  for (let y = 0; y < 800; y++) for (let x = 0; x < 800; x++) { const i = (y * 800 + x) * 3; rgb[i] = x < 400 ? 220 : 30; rgb[i + 1] = 100; rgb[i + 2] = 50; }
  await writeFile(source, await sharp(rgb, { raw: { width: 800, height: 800, channels: 3 } }).png().toBuffer());
  await writeFile(manifest, JSON.stringify({ brand: "test", products: [{ identifier: "ABC", shots: [{ n: 1, path: source }] }] }));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
  const report = await renderToReport({ manifest, out: path.join(dir, "out"), channels: ["noon", "amazon"] });
  expect(report.summary).toMatchObject({ outputs: 2, failed: 2 });
  expect(report.outputs.every((o) => !o.flags.includes("unsupported") && o.notes.some((n) => n.includes("background is not plain")))).toBe(true);
});
