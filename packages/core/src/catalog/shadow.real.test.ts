// Tier 3 visual check for contact shadows on real photos (REAL_DATA=1 only).
// Renders a few sources through the real pipeline and writes the JPEGs for a person to view.
// Mattes come from the deployed matting service once and are cached on disk next to the output.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { MattingClient } from "./matte";
import { prepare, renderSource, type Matte } from "./render";
import type { ChannelId, ProductType } from "./types";

const REAL = process.env.REAL_DATA === "1";
const INPUT = process.env.SHADOW_INPUT_DIR ?? "";
const OUT = process.env.SHADOW_OUT_DIR ?? "";
const CACHE = process.env.SHADOW_MATTE_CACHE ?? path.join(OUT, "..", "mattes");
const SOURCES: { file: string; type: ProductType }[] = (process.env.SHADOW_SOURCES ?? "").split(",").filter(Boolean).map(s => { const [file, type] = s.split(":"); return { file: file!, type: (type ?? "other") as ProductType }; });
const CHANNELS: ChannelId[] = ["trendyol", "noon", "namshi", "shein", "centrepoint", "sixthstreet"];

// The identity token is passed straight into the request header and never printed.
const idToken = async () => execFileSync("gcloud", ["auth", "print-identity-token"], { shell: true, env: { ...process.env, CLOUDSDK_CORE_PROJECT: "image-links-agent" } }).toString().trim();

async function matteFor(file: string, prepared: Awaited<ReturnType<typeof prepare>>): Promise<Matte> {
  const cached = path.join(CACHE, `${path.parse(file).name}.png`);
  if (!existsSync(cached)) {
    const client = new MattingClient({ services: [{ baseUrl: process.env.MATTING_URL!, target: "cpu" }], idToken });
    const matte = await client.matte(prepared);
    await mkdir(CACHE, { recursive: true });
    await sharp(matte.alpha, { raw: { width: matte.width, height: matte.height, channels: 1 } }).png().toFile(cached);
  }
  const alpha = await sharp(cached).toColourspace("b-w").raw().toBuffer();
  return { alpha, width: prepared.width, height: prepared.height, model: "cached", ms: 0, source: "model", target: "cpu", sentLongSide: null };
}

describe.skipIf(!REAL)("contact shadows on real photos", () => {
  test("renders the chosen sources for a visual check", async () => {
    await mkdir(OUT, { recursive: true });
    for (const { file, type } of SOURCES) {
      const prepared = await prepare(await readFile(path.join(INPUT, file)), file, async b => b);
      const matte = await matteFor(file, prepared);
      for (const channel of CHANNELS) {
        const out = await renderSource({ prepared, matte, channel, shotNumber: 2, productType: type, identifier: path.parse(file).name });
        console.log(JSON.stringify({ file, type, channel, status: out.status, flags: out.flags, compliance: out.compliance.failures }));
        expect(out.status).toBe("ok");
        expect(out.compliance.ok).toBe(true);
        await writeFile(path.join(OUT, `${channel}__${type}__${path.parse(file).name}.jpg`), out.jpeg!);
      }
    }
  }, 4 * 60 * 60_000);
});
