import { describe, expect, it, vi } from "vitest";
import type { Prepared } from "./render";
import { DEPLOYED_MATTE_MODELS } from "./matte";
import { matteThroughRoutes, planMatteRoutes, type MatteRouting } from "./matte-routing";
import { fakeMatting } from "./matting-fake";
import { createRouter } from "../vendor/router";
import { CircuitBreakers } from "../vendor/circuit";
import { IMAGE_SEED_ROUTES, MATTE_ROUTE_MODELS, NO_TRAINING_PENDING, PHOTOROOM_MATTE_MODEL, routeId, type RouteDef } from "../vendor/routes";
import type { OverflowGate } from "../vendor/overflow";

const [M1, M2] = ["birefnet-general", "birefnet-general-lite"];
const VENDOR = routeId("image.matte", "photoroom", PHOTOROOM_MATTE_MODEL);
function prepared(): Prepared {
  const rgb = Buffer.alloc(48 * 32 * 3, 255);
  for (let y = 8; y < 24; y++) for (let x = 12; x < 36; x++) rgb.fill(20, (y * 48 + x) * 3, (y * 48 + x) * 3 + 3);
  return {rgb, width: 48, height: 32, alphaSource: null, background: {uniform: true, color: [255, 255, 255], stdev: 0}, flags: [], sourceMime: "image/jpeg"};
}
/** The seeded image.matte routes; `overflow` switches the vendor on (a position on file and a cap), as an admin would. */
function routes(options: {overflow?: boolean; off?: string[]} = {}): RouteDef[] {
  return IMAGE_SEED_ROUTES.filter(r => r.capability === "image.matte").map(r => r.id === VENDOR && options.overflow ? {...r, state: "serving" as const, noTrainingTerms: "test: vendor DPA on file", dailyCapUsd: 1}
    : options.off?.includes(r.id) ? {...r, state: "off" as const} : r);
}
const gate = (ok = true): OverflowGate => ({reserve: vi.fn(async route => ok ? {ok: true, spentUsd: 0, capUsd: route.dailyCapUsd ?? 0} : {ok: false, reason: "over_cap", spentUsd: 1, capUsd: 1})});
function routing(rows: RouteDef[], world: ReturnType<typeof fakeMatting>, extra: Partial<MatteRouting> = {}): MatteRouting {
  return {router: createRouter(rows, new CircuitBreakers()), preferred: [M1, M2], vendor: {fetch: world.fetch, env: {PHOTOROOM_API_KEY: "test-key"}}, log: vi.fn(), ...extra};
}

describe("M3-S5 image.matte seed routes (M3-F2-R3, M7-F2-R2 and R7, decision D8)", () => {
  it("lists every deployed cut-out model on the GPU and CPU services, in step with the matting service", () => {
    expect(MATTE_ROUTE_MODELS.map(m => m.model)).toEqual([...DEPLOYED_MATTE_MODELS]);
    const matte = IMAGE_SEED_ROUTES.filter(r => r.capability === "image.matte");
    expect(matte.filter(r => r.adapter === "matting-gpu").map(r => r.model)).toEqual([...DEPLOYED_MATTE_MODELS]);
    expect(matte.filter(r => r.adapter === "matting-cpu").map(r => r.model)).toEqual([...DEPLOYED_MATTE_MODELS]);
  });
  it("ships every overflow adapter switched off, with no no-training position and no cap", () => {
    const vendors = IMAGE_SEED_ROUTES.filter(r => r.adapter === "photoroom");
    expect(vendors.map(r => r.capability).sort()).toEqual(["image.matte", "image.upscale"]);
    expect(vendors.every(r => r.state === "off" && r.noTrainingTerms === NO_TRAINING_PENDING && r.dailyCapUsd === null)).toBe(true);
    // The CPU upscaler is an admin switch only (M3-F2-R3: 2.6x the GPU price).
    expect(IMAGE_SEED_ROUTES.filter(r => r.adapter === "upscale-cpu").every(r => r.state === "off")).toBe(true);
  });
  it("orders GPU (policy models first), then the vendor when switched on, then the CPU service", () => {
    const ids = (rows: RouteDef[], preferred = [M1, M2]) => planMatteRoutes(createRouter(rows), preferred).map(r => `${r.adapter}:${r.model}`);
    expect(ids(routes())).toEqual([...DEPLOYED_MATTE_MODELS.map(m => `matting-gpu:${m}`), ...DEPLOYED_MATTE_MODELS.map(m => `matting-cpu:${m}`)]);
    expect(ids(routes({overflow: true}), ["bria-rmbg"]).slice(0, 6)).toEqual(["matting-gpu:bria-rmbg", `matting-gpu:${M1}`, `matting-gpu:${M2}`, "matting-gpu:birefnet-hrsod", `photoroom:${PHOTOROOM_MATTE_MODEL}`, "matting-cpu:bria-rmbg"]);
    // The kill switch: route 1 off is never planned.
    expect(ids(routes({off: [routeId("image.matte", "matting-gpu", M1)]}))[0]).toBe(`matting-gpu:${M2}`);
    // A policy model the table does not know is still asked on our own services, GPU first.
    expect(ids(routes(), ["fixture"]).filter(id => id.endsWith(":fixture"))).toEqual(["matting-gpu:fixture", "matting-cpu:fixture"]);
  });
});

describe("M3-S5 routed cut-out (4.2.9 tests 1 and 2 at the unit level)", () => {
  it("all services up: GPU model 1 answers, one call", async () => {
    const w = fakeMatting();
    const matte = await matteThroughRoutes(prepared(), w.client, routing(routes(), w));
    expect(matte).toMatchObject({source: "model", target: "gpu", model: M1, route: {routeId: routeId("image.matte", "matting-gpu", M1)}});
    expect(w.state.calls).toEqual([`gpu:${M1}`]);
  });
  it("GPU model 1 broken, the service up: model 2 on the GPU answers (route 2), logged as a fallback", async () => {
    const w = fakeMatting(), r = routing(routes(), w);
    w.state.failing.gpu.add(M1);
    const matte = await matteThroughRoutes(prepared(), w.client, r);
    expect(matte).toMatchObject({target: "gpu", model: M2, route: {routeId: routeId("image.matte", "matting-gpu", M2)}});
    expect(r.log).toHaveBeenCalledWith("catalog matte route fallback", expect.objectContaining({kind: "no_response", fallbackModel: M2}));
  });
  it("GPU service stopped, overflow off: the vendor is never asked and the CPU service answers with model 1", async () => {
    const w = fakeMatting(), r = routing(routes(), w, {overflow: gate()});
    w.state.down.gpu = true;
    const matte = await matteThroughRoutes(prepared(), w.client, r);
    expect(matte).toMatchObject({target: "cpu", model: M1, route: {routeId: routeId("image.matte", "matting-cpu", M1)}});
    expect(w.state.calls).toEqual([`cpu:${M1}`]);
    expect(r.overflow!.reserve).not.toHaveBeenCalled();
  });
  it("GPU and CPU stopped, overflow off: the simple method, no route (fallback_matte follows, never an error)", async () => {
    const w = fakeMatting();
    w.state.down = {gpu: true, cpu: true};
    const matte = await matteThroughRoutes(prepared(), w.client, routing(routes(), w));
    expect(matte).toMatchObject({source: "floodfill", route: {routeId: null}});
  });
  it("GPU stopped, overflow on within its cap: the vendor answers before the CPU service, with its cost and reason", async () => {
    const w = fakeMatting(), r = routing(routes({overflow: true}), w, {overflow: gate()});
    w.state.down.gpu = true;
    const matte = await matteThroughRoutes(prepared(), w.client, r);
    expect(matte).toMatchObject({source: "model", target: null, model: PHOTOROOM_MATTE_MODEL, width: 48, height: 32, route: {routeId: VENDOR, overflow: {engine: "photoroom", usd: 0.02, reason: expect.stringMatching(/^own routes unavailable/)}}});
    expect(matte.alpha).toHaveLength(48 * 32);
    expect(w.state.calls).toEqual(["vendor"]);
    expect(w.state.vendorKeys).toEqual(["test-key"]);
    expect(r.log).toHaveBeenCalledWith("catalog matte overflow", expect.objectContaining({route: VENDOR, usd: 0.02}));
    // The key is never logged.
    expect(JSON.stringify(vi.mocked(r.log!).mock.calls)).not.toContain("test-key");
  });
  it("the vendor over its daily cap, refused, out of credit, keyless or the wrong size: the CPU service answers", async () => {
    for (const setup of [{gate: gate(false)}, {status: 402}, {status: 401}, {key: ""}, {vendor: "wrong_size" as const}]) {
      const w = fakeMatting(), r = routing(routes({overflow: true}), w, {overflow: setup.gate ?? gate(), vendor: {fetch: w.fetch, env: {PHOTOROOM_API_KEY: setup.key ?? "test-key"}}});
      w.state.down.gpu = true;
      if (setup.status) w.state.vendor = setup.status;
      if (setup.vendor) w.state.vendor = setup.vendor;
      const matte = await matteThroughRoutes(prepared(), w.client, r);
      expect(matte, JSON.stringify(setup)).toMatchObject({target: "cpu", model: M1, route: {routeId: routeId("image.matte", "matting-cpu", M1)}});
      expect(matte.route?.overflow).toBeUndefined();
    }
  });
  it("without a gate no overflow route is ever called, even when serving", async () => {
    const w = fakeMatting();
    w.state.down.gpu = true;
    await matteThroughRoutes(prepared(), w.client, routing(routes({overflow: true}), w));
    expect(w.state.calls).toEqual([`cpu:${M1}`]);
  });
  it("a photo with its own transparency keeps it: no route is asked", async () => {
    const w = fakeMatting(), p = {...prepared(), alphaSource: Buffer.alloc(48 * 32, 255)};
    expect(await matteThroughRoutes(p, w.client, routing(routes(), w))).toMatchObject({source: "alpha_source", route: {routeId: null}});
    expect(w.state.calls).toEqual([]);
  });
});
