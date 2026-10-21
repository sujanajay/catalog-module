// Tier 3: real source sets, the built CLI, real model inference and private test uploads.
// All full renders stay on disk. Only a small rerender is uploaded, then its exact prefix is cleaned.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import * as storage from "../storage";
import { channel, backgroundFor } from "./channels";
import { BG_TOLERANCE } from "./compliance";
import { contactSheet } from "./contact-sheet";
import { MattingClient } from "./matte";
import { bbox, prepare, renderSource, type RenderOutput } from "./render";
import { ALPHA_BBOX_THRESHOLD, preservedDarkness, SHADOW_MIN_DARKNESS, shadowLayer } from "./shadow";
import { CHANNEL_IDS, type ChannelId, type ProductType } from "./types";

const REAL = process.env.REAL_DATA === "1";
const DATA = process.env.REAL_DATA_DIR ?? "C:/Users/Sujan AH/Desktop/opptra-image-links";
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLI = fileURLToPath(new URL("../../../../apps/worker/dist/catalog-local.js", import.meta.url));
const RUN = `render-05-${randomUUID()}`;
const UPLOAD_ROOT = process.env.RENDER_REAL_UPLOAD_PREFIX ?? `gs://image-links-agent-assets/catalog-test/${RUN}/`;
// Cleanup only removes the per-product-type leaf appended below, never this root.
// Require a unique run name and plain folder segments; reject broad roots and traversal.
if (!/^gs:\/\/image-links-agent-assets\/catalog-test\/[a-z0-9][a-z0-9-]{7,79}\/(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)*$/.test(UPLOAD_ROOT)) {
  throw new Error("RENDER_REAL_UPLOAD_PREFIX must name a unique private run folder under catalog-test/ and end with /.");
}
const OUT = path.resolve(process.env.RENDER_REAL_OUT ?? path.join(ROOT, "var", RUN));
const CPU = process.env.MATTING_URL ?? "http://localhost:8080";
const GPU = process.env.MATTING_GPU_URL;
const MODEL = process.env.RENDER_REAL_MODEL ?? "birefnet-general-lite";
// 3,280 CPU mattes and 29,520 JPEG renders can take hours; each CLI child has the same bound.
const FULL_TIMEOUT = 24 * 60 * 60_000;
const BENCH_TIMEOUT = 4 * 60 * 60_000;
const execute = promisify(execFile);

interface Manifest { products: { identifier: string; shots: { n: number; path: string }[] }[]; rejected: unknown[] }
interface Row extends Omit<RenderOutput, "jpeg"> {
  identifier: string; n: number; channel: ChannelId; path?: string; uploaded?: string;
  matte: { model: string; target: "cpu" | "gpu" | null; sentLongSide: number | null; ms: number } | null;
}
interface Report { outputs: Row[]; summary: { outputs: number; compliant: number; skipped: number; failed: number; flagsByKind: Record<string, number>; msMatteAvgByTarget: { cpu: number | null; gpu: number | null }; msRenderAvg: number | null } }

async function cli(args: string[], timeout = FULL_TIMEOUT): Promise<void> {
  expect(existsSync(CLI), "Build the worker CLI before running the real render suite.").toBe(true);
  const { stdout, stderr } = await execute(process.execPath, [CLI, ...args], { timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, BUCKET: "image-links-agent-assets" } });
  console.log(stdout.trim());
  if (stderr.trim()) console.log(stderr.trim());
}

async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }

async function collect(name: string, from: string): Promise<{ manifest: Manifest; file: string }> {
  const out = path.join(OUT, name, "collect");
  await cli(["collect", "--brand", name, "--from", from, "--identifier-mode", "filename", "--out", out]);
  const file = path.join(out, "manifest.json");
  return { manifest: await readJson<Manifest>(file), file };
}

function renderArgs(manifest: string, out: string, productType: ProductType): string[] {
  return ["render", "--manifest", manifest, "--channels", CHANNEL_IDS.join(","), "--matting", CPU, ...(GPU ? ["--matting-gpu", GPU] : []), "--model", MODEL, "--product-type", productType, "--out", out];
}

async function verifyReport(report: Report, manifest: Manifest, sourceCount: number, out: string): Promise<void> {
  const keys = new Set(report.outputs.map((o) => `${o.identifier}\0${o.n}\0${o.channel}`));
  expect(report.outputs).toHaveLength(sourceCount * CHANNEL_IDS.length);
  expect(keys.size).toBe(sourceCount * CHANNEL_IDS.length);
  for (const product of manifest.products) for (const shot of product.shots) for (const id of CHANNEL_IDS) expect(keys.has(`${product.identifier}\0${shot.n}\0${id}`)).toBe(true);
  const failures = report.outputs.filter((o) => o.status === "failed" || (o.status === "ok" && !o.compliance.ok));
  console.log(JSON.stringify({ out, summary: report.summary, firstFailures: failures.slice(0, 10) }, null, 2));
  expect(failures, "Every planned outcome must succeed (no Styli skip since 2026-10-22).").toEqual([]);
  expect(report.summary).toMatchObject({ outputs: sourceCount * 9, compliant: sourceCount * 9, skipped: 0, failed: 0 });
  for (const row of report.outputs) {
    expect(row.matte?.model).toBe(MODEL);
    expect(["cpu", "gpu"]).toContain(row.matte?.target);
    expect(row.flags).not.toContain("fallback_matte");
    expect(row.status).toBe("ok");
    expect(row.compliance).toEqual({ ok: true, failures: [] });
    const spec = channel(row.channel), plan = row.plan, box = plan.productBox!;
    expect(plan.w).toBeGreaterThanOrEqual(spec.minCanvas.w);
    expect(plan.h).toBeGreaterThanOrEqual(spec.minCanvas.h);
    expect(plan.w).toBeLessThanOrEqual(spec.targetCanvas.w);
    expect(plan.h).toBeLessThanOrEqual(spec.targetCanvas.h);
    expect(Math.abs(plan.h - plan.w * spec.targetCanvas.h / spec.targetCanvas.w)).toBeLessThanOrEqual(1);
    expect(box.x).toBeGreaterThanOrEqual(plan.safeBox.x);
    expect(box.y).toBeGreaterThanOrEqual(plan.safeBox.y);
    expect(box.x + box.w).toBeLessThanOrEqual(plan.safeBox.x + plan.safeBox.w);
    expect(box.y + box.h).toBeLessThanOrEqual(plan.safeBox.y + plan.safeBox.h);
    if (row.channel === "noon" && plan.sourceBox!.w > plan.sourceBox!.h) {
      expect(box.x).toBeGreaterThanOrEqual(Math.ceil(plan.w * 0.05));
      expect(box.x + box.w).toBeLessThanOrEqual(Math.floor(plan.w * 0.95));
    }
    expect(row.path?.endsWith(".jpg")).toBe(true);
    expect((await stat(row.path!)).size).toBe(row.bytes);
    if ((row.channel === "amazon" || row.channel === "shein") && row.n === 1) {
      expect(backgroundFor(row.channel, 1)).toBe("#FFFFFF");
      // Inspect exposed corners only: zero-margin foreground may legitimately meet an edge.
      const corners = [[0, 0], [plan.w - 1, 0], [0, plan.h - 1], [plan.w - 1, plan.h - 1]];
      for (const [x, y] of corners) if (x! < box.x || x! >= box.x + box.w || y! < box.y || y! >= box.y + box.h) {
        const pixel = await sharp(row.path!).extract({ left: x!, top: y!, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
        expect(Math.min(...pixel)).toBeGreaterThanOrEqual(255 - BG_TOLERANCE);
      }
    }
  }
  expect((await stat(path.join(out, "contact-sheet.jpg"))).size).toBeGreaterThan(0);
  // Spread visual evidence across the whole dataset rather than only its first products.
  const selected = Array.from({ length: Math.min(12, manifest.products.length) }, (_, i) => manifest.products[Math.round(i * (manifest.products.length - 1) / 11)]!.identifier);
  const samples = report.outputs.filter((row) => selected.includes(row.identifier) && row.n === manifest.products.find((p) => p.identifier === row.identifier)!.shots[0]!.n && row.status === "ok");
  await writeFile(path.join(out, "verification-contact-sheet.jpg"), await contactSheet(await Promise.all(samples.map(async (row) => ({ label: `${row.identifier} ${row.n} ${row.channel}`, jpeg: await readFile(row.path!) }))), 8));
  await writeFile(path.join(out, "verification-selection.json"), JSON.stringify(samples.map(({ identifier, n, channel, path: file }) => ({ identifier, n, channel, path: file })), null, 2));
}

async function verifyUpload(manifest: string, out: string, type: ProductType): Promise<void> {
  const prefix = `${UPLOAD_ROOT}full-upload/${type}/`;
  try {
    await cli([...renderArgs(manifest, out, type), "--limit", "2", "--upload", prefix]);
    const report = await readJson<Report>(path.join(out, "report.json"));
    expect(report.summary.failed).toBe(0);
    const uploaded = report.outputs.filter((o) => o.uploaded);
    expect(uploaded).toHaveLength(16);
    for (const row of uploaded) {
      expect(row.uploaded!.startsWith(prefix)).toBe(true);
      expect(row.uploaded!.endsWith(".jpg")).toBe(true);
      expect(await storage.headObject(row.uploaded!)).toMatchObject({ exists: true, contentType: "image/jpeg", size: row.bytes });
      expect(await storage.readRange(row.uploaded!, 0, 2)).toEqual(Buffer.from([255, 216, 255]));
    }
    expect(await storage.listObjects(prefix)).toHaveLength(uploaded.length);
  } finally {
    const deleted = await storage.deleteTestObjects(prefix);
    expect(await storage.listObjects(prefix)).toEqual([]);
    console.log(JSON.stringify({ testPrefix: prefix, deleted, remaining: 0 }));
  }
}

describe.skipIf(!REAL)("real matting and all-channel rendering", () => {
  const sets = [
    { name: "anta", from: path.join(DATA, "new_resources_4", "Images"), products: 126, sources: 630, type: "footwear" as const },
    { name: "french-connection", from: path.join(DATA, "new_resources_3", "French Connection Final"), products: 607, sources: 3280, type: "apparel_model" as const },
  ];
  for (const set of sets) test(`${set.name}: full dataset, all nine channels and private upload sample`, { timeout: FULL_TIMEOUT }, async () => {
    expect(existsSync(set.from), `Missing required real dataset: ${set.from}`).toBe(true);
    const { manifest, file } = await collect(set.name, set.from);
    expect(manifest.products).toHaveLength(set.products);
    expect(manifest.products.flatMap((p) => p.shots)).toHaveLength(set.sources);
    expect(manifest.rejected).toEqual([]);
    const out = path.join(OUT, set.name, "render");
    await cli(renderArgs(file, out, set.type));
    await verifyReport(await readJson<Report>(path.join(out, "report.json")), manifest, set.sources, out);
    process.env.BUCKET ??= "image-links-agent-assets";
    expect(storage.getBucketName()).toBe("image-links-agent-assets");
    await verifyUpload(file, path.join(OUT, set.name, "upload-sample"), set.type);
  });

  test("100 Anta sources: per-model CPU and optional GPU timings", { timeout: BENCH_TIMEOUT }, async () => {
    const { manifest } = await collect("anta-benchmark", sets[0]!.from);
    const shots = manifest.products.flatMap((p) => p.shots).slice(0, 100);
    expect(shots).toHaveLength(100);
    const timings: { model: string; target: string; sources: number; msAverage: number; msWallAverage: number }[] = [];
    for (const target of GPU ? ["cpu", "gpu"] as const : ["cpu"] as const) {
      const client = new MattingClient({ services: [{ baseUrl: CPU, target: "cpu" }, ...(target === "gpu" ? [{ baseUrl: GPU!, target: "gpu" as const }] : [])] });
      expect((await client.health()).ok).toBe(true);
      for (const model of ["birefnet-general", "birefnet-general-lite"]) {
        let ms = 0, wall = 0;
        for (const shot of shots) {
          const prepared = await prepare(await readFile(shot.path), path.basename(shot.path), (buf) => client.convert(buf));
          const start = performance.now(), matte = await client.matte(prepared, model);
          wall += performance.now() - start;
          expect(matte.source).toBe("model");
          expect(matte.target).toBe(target);
          expect(matte.model).toBe(model);
          expect(matte.ms).toBeGreaterThan(0);
          ms += matte.ms;
        }
        timings.push({ model, target, sources: shots.length, msAverage: ms / shots.length, msWallAverage: wall / shots.length });
        console.log(JSON.stringify(timings.at(-1)));
      }
    }
    await mkdir(OUT, { recursive: true });
    await writeFile(path.join(OUT, "benchmark.json"), JSON.stringify({ timings, gpu: GPU ? "measured" : "pending deployment or GPU quota" }, null, 2));
    if (!GPU) console.log("GPU benchmark pending: MATTING_GPU_URL is not set.");
  });

  test("630 Anta sources: real footwear shadow decisions", { timeout: FULL_TIMEOUT }, async () => {
    const { manifest } = await collect("anta-shadow-audit", sets[0]!.from);
    const shots = manifest.products.flatMap((product) => product.shots.map((shot) => ({ ...shot, identifier: product.identifier })));
    expect(shots).toHaveLength(630);
    const target = GPU ? "gpu" : "cpu";
    const client = new MattingClient({ services: [{ baseUrl: CPU, target: "cpu" }, ...(GPU ? [{ baseUrl: GPU, target: "gpu" as const }] : [])] });
    expect((await client.health()).ok).toBe(true);
    const rows: { identifier: string; n: number; preserved: boolean; sourceDarkness: number | null; layerMin: number }[] = [];
    const contacts: { jpeg: Buffer; label: string }[] = [];
    const samples = new Set(Array.from({ length: 12 }, (_, i) => Math.floor(i * shots.length / 12)));
    for (const [index, shot] of shots.entries()) {
      const prepared = await prepare(await readFile(shot.path), path.basename(shot.path), (buffer) => client.convert(buffer));
      const matte = await client.matte(prepared, MODEL);
      expect(matte.source).toBe("model");
      expect(matte.target).toBe(target);
      const box = bbox(matte.alpha, prepared.width, prepared.height);
      expect(box).not.toBeNull();
      const darkness = preservedDarkness(prepared, matte, box!, "footwear");
      let sourceDarkness: number | null = null;
      if (darkness) {
        let sum = 0, pixels = 0;
        for (let i = 0; i < darkness.length; i++) if (darkness[i] && matte.alpha[i]! <= ALPHA_BBOX_THRESHOLD) { sum += darkness[i]! / 255; pixels++; }
        expect(pixels).toBeGreaterThan(0);
        sourceDarkness = sum / pixels;
        expect(sourceDarkness).toBeGreaterThan(SHADOW_MIN_DARKNESS);
      }
      const rendered = await renderSource({ prepared, matte, channel: "noon", shotNumber: shot.n, productType: "footwear" });
      expect(rendered.status).toBe("ok");
      expect(rendered.compliance.ok).toBe(true);
      expect(rendered.flags.includes("shadow_synthesised")).toBe(!darkness);
      expect(rendered.flags).not.toContain("no_shadow_source");
      const shadow = await shadowLayer(prepared, matte, box!, rendered.plan, "footwear", backgroundFor("noon", shot.n));
      expect(shadow.layer).not.toBeNull();
      const layerMin = Math.min(...(await sharp(shadow.layer!).stats()).channels.map((item) => item.min));
      expect(layerMin).toBeLessThan(255);
      rows.push({ identifier: shot.identifier, n: shot.n, preserved: !!darkness, sourceDarkness, layerMin });
      if (samples.has(index)) contacts.push({ jpeg: rendered.jpeg!, label: `${shot.identifier}_${shot.n}: ${darkness ? "preserved" : "synthesised"}` });
      if (rows.length % 25 === 0) console.log(JSON.stringify({ shadowAuditProgress: rows.length, total: shots.length }));
    }
    const preserved = rows.filter((row) => row.preserved).length;
    const summary = { target, model: MODEL, sources: rows.length, preserved, synthesised: rows.length - preserved };
    await writeFile(path.join(OUT, "shadow-audit.json"), JSON.stringify({ summary, rows }, null, 2));
    await writeFile(path.join(OUT, "shadow-audit-contact-sheet.jpg"), await contactSheet(contacts, 4));
    console.log(JSON.stringify(summary));
  });

});
