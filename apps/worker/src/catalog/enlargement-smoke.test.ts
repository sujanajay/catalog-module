// T56 (spec 18 lifecycle, plan 7b): the deploy gate's enlargement smoke on fakes. PGlite, the real handlers, the real
// upscale client over a fake catalog-upscale (HTTP semantics: /health lists the models, /upscale answers the JPEG
// enlarged by its scale), with the fault rule answering 8 x 400 for one product's calls.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import type { Db } from "@catalog/core/db/client";
import { createTestDb } from "@catalog/core/db/testing";
import { faultFetch, pickFault, upscaleBadInputRule, type FaultRule } from "@catalog/core/catalog/load/fault-rules";
import { prepare } from "@catalog/core/catalog/render";
import { enlargeWorld } from "../../test/enlarge-world";
import { workerEnlargeCall, workerEnlargeProbe } from "./enlarge";
import { ENLARGEMENT_SMOKE_FIXTURES, runEnlargementSmoke } from "./enlargement-smoke";

let db: Db, close: () => Promise<void>;
const saved: Record<string, string | undefined> = {};
const ENV = ["BUCKET", "PUBLIC_BUCKET", "UPSCALE_MAX_PIXELS", "UPSCALE_MAX_PIXELS_X4"];
beforeAll(async () => { for (const k of ENV) saved[k] = process.env[k]; process.env.BUCKET = "assets"; process.env.PUBLIC_BUCKET = "public"; process.env.UPSCALE_MAX_PIXELS = "8000000"; process.env.UPSCALE_MAX_PIXELS_X4 = "6400000"; ({ db, close } = await createTestDb()); }, 60_000);
afterAll(async () => { for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; await close(); });

/** A fake catalog-upscale behind fetch: what it was asked, by product. */
function fakeUpscaleService() {
  const calls: { path: string; product: string | null; status: number }[] = [];
  const service = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/health") return Response.json({ upscale: { models: [{ id: "swinir-x2", available: true, scale: 2 }, { id: "swinir-x4", available: true, scale: 4 }], default: "swinir-x2" } });
    const scale = Number(url.searchParams.get("scale") ?? 2), body = Buffer.from(init!.body as Uint8Array), meta = await sharp(body).metadata();
    const jpeg = await sharp({ create: { width: meta.width! * scale, height: meta.height! * scale, channels: 3, background: { r: 60, g: 30, b: 25 } } }).jpeg({ quality: 90 }).toBuffer();
    calls.push({ path: url.pathname, product: new Headers(init?.headers).get("x-catalog-product"), status: 200 });
    return new Response(new Uint8Array(jpeg), { status: 200, headers: { "content-type": "image/jpeg", "x-upscale-ms": "90000", "x-upscale-model": url.searchParams.get("model") ?? "" } });
  }) as typeof fetch;
  return { calls, service };
}

describe("T56: the enlargement smoke on fakes", () => {
  it("the x4 and x2 fixtures route by band; the faulted photo is held with enlargement_failed, Try again makes it, every output upscaled, zero ERROR invariants", async () => {
    const e = enlargeWorld(db);
    const { calls, service } = fakeUpscaleService();
    const rules: FaultRule[] = [];
    // The world's ids are plain (GPU) ids, so the client routes them to UPSCALE_GPU_URL (upscaleRouteFor).
    const env = { UPSCALE_GPU_URL: "https://upscale.test", UPSCALE_GPU_TIMEOUT_S: "60", UPSCALE_GPU_COLD_START_S: "20" };
    const clientDeps = { fetch: faultFetch(rules, service), idToken: async () => "token" };
    e.w.deps.enlarge = workerEnlargeCall("swinir-x2", env, clientDeps);
    e.w.deps.enlargeProbe = workerEnlargeProbe(env, clientDeps);
    // The real prepare, so the fixtures' sizes decide the bands (the fake matte is the whole frame).
    e.w.deps.prepare = prepare;
    const evidence = await runEnlargementSmoke({
      deps: { ...e.w.deps, now: () => new Date() }, route: { model: "swinir-x2", x4Model: "swinir-x4", minScale: 1.5 }, brandSlug: "test_brand", brandName: "Test Brand",
      name: "catalog-test-enlargement-smoke", channels: ["trendyol"], faultOn: "x4", fault: (productId) => rules.push(upscaleBadInputRule(productId)), backoffMs: 0, budgetMs: 240_000,
    });
    expect(evidence.factors).toEqual({ x4: [4], x2: [2] });
    expect(evidence.heldAfterFault).toBe(1);
    expect(evidence.invariantErrors).toEqual([]);
    // The fault answered 8 times (never reaching the service); the Try again call and the x2 photo's one call did.
    expect(calls.filter((c) => c.path === "/upscale").map((c) => c.product).sort()).toEqual([evidence.products.x2, evidence.products.x4].sort());
  }, 300_000);

  it("the fault rule matches one product's /upscale by its trace header, 8 times, then forwards", () => {
    const rule = upscaleBadInputRule("p1"), counters = new Map<string, number>();
    const ask = (product: string) => pickFault([rule], { method: "POST", path: "/upscale?model=swinir-x4&scale=4", headers: { "x-catalog-product": product } }, counters);
    expect(ask("p2")).toBeNull();
    expect(Array.from({ length: 9 }, () => ask("p1")?.action.status ?? null)).toEqual([400, 400, 400, 400, 400, 400, 400, 400, null]);
    expect(ENLARGEMENT_SMOKE_FIXTURES.x4.product.w).toBeLessThan(ENLARGEMENT_SMOKE_FIXTURES.x2.product.w);
  });
});
