// catalog-local collect on a zip and on a links xlsx (spec 04 Done: "The CLI collect mode works on a
// folder, a zip and a links xlsx"; the folder case is in catalog-local.test.ts). Links are fetched
// through safe-url's pinnedFetch; this file swaps that one export for an in-memory web so the test
// needs no network (the links use a public IP literal, so safeFetch makes no DNS lookup either).
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildZip } from "../../../packages/core/test-fixtures/catalog/ingest-a/builders";
import { collectToManifest } from "./catalog-local";

const web = vi.hoisted(() => ({ pages: new Map<string, Buffer>(), requests: [] as string[] }));

vi.mock("@catalog/core/safe-url", async (importOriginal) => {
  const real = await importOriginal<typeof import("@catalog/core/safe-url")>();
  const pinnedFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    web.requests.push(`${init?.method ?? "GET"} ${url}`);
    const body = web.pages.get(url);
    if (!body) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  return { ...real, pinnedFetch };
});

const LINKS = "https://104.18.38.10/links";
const FIXTURE = new URL("../../../packages/core/test-fixtures/catalog/ingest-b/cli-links.xlsx", import.meta.url);

let tmp: string;

beforeAll(async () => {
  vi.stubEnv("BUCKET", "unused");
  tmp = await mkdtemp(path.join(os.tmpdir(), "catalog-local-inputs-"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(tmp, { recursive: true, force: true });
});

const jpeg = (r: number) => sharp({ create: { width: 600, height: 800, channels: 3, background: { r, g: 40, b: 90 } } }).jpeg().toBuffer();

describe("catalog-local collect", () => {
  it("collects a zip: nested folders walked, __MACOSX and dotfiles skipped, a nested zip rejected", async () => {
    const [a1, a2, b1] = [await jpeg(11), await jpeg(12), await jpeg(13)];
    const zip = path.join(tmp, "Images.zip");
    await writeFile(zip, buildZip([
      { path: "Images/" },
      { path: "Images/Shoes/AB1_1.jpg", data: a1, compress: true },
      { path: "Images/Shoes/AB1_2.jpg", data: a2 },
      { path: "Images/More/CD2-1.jpg", data: b1, compress: true },
      { path: "__MACOSX/Images/._AB1_1.jpg", data: Buffer.from("junk") },
      { path: "Images/.DS_Store", data: Buffer.from("junk") },
      { path: "Images/inner.zip", data: buildZip([{ path: "x.jpg", data: a1 }]) },
    ]));
    const out = path.join(tmp, "out-zip");
    const { manifest } = await collectToManifest({ brand: "anta", from: zip, identifierMode: "filename", out }, () => undefined);
    expect(manifest.identifierMode).toBe("filename");
    expect(manifest.products.map((p) => [p.identifier, p.shots.map((s) => s.n)])).toEqual([["AB1", [1, 2]], ["CD2", [1]]]);
    const shot = manifest.products[0]!.shots[1]!;
    expect(shot.path).toBe(path.join(out, "anta", "raw", "AB1", "AB1_2.jpg"));
    expect((await readFile(shot.path)).equals(a2)).toBe(true);
    expect(shot.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.rejected).toEqual([{ name: "Images/inner.zip", reason: "Nested zip files are not opened. Unzip inner.zip and upload its contents." }]);
  });

  it("collects a links xlsx: the header under a title row, URL columns in shot order, a failed link reported by row", async () => {
    const [s11, s12, s21] = [await jpeg(21), await jpeg(22), await jpeg(23)];
    web.pages.set(`${LINKS}/SH1_1.jpg`, s11);
    web.pages.set(`${LINKS}/SH1_2.jpg`, s12);
    web.pages.set(`${LINKS}/SH2_1.jpg`, s21);
    const from = path.join(tmp, "links.xlsx");
    await writeFile(from, await readFile(FIXTURE));
    const out = path.join(tmp, "out-xlsx");
    const { manifest } = await collectToManifest({ brand: "anta", from, identifierMode: "filename", out }, () => undefined);
    expect(manifest.products.map((p) => [p.identifier, p.shots.map((s) => s.n)])).toEqual([["SH1", [1, 2]], ["SH2", [1]]]);
    expect((await readFile(manifest.products[0]!.shots[1]!.path)).equals(s12)).toBe(true);
    expect(manifest.rejected).toEqual([
      { name: "SH2_missing.jpg", reason: `Row 4, column Product Image 2: ${LINKS}/SH2_missing.jpg did not return an image (got 404).` },
    ]);
    expect(web.requests.every((r) => r.startsWith("GET "))).toBe(true);
    expect(web.requests).toHaveLength(4);
  });
});
