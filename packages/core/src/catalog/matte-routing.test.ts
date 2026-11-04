import { describe, expect, it, vi } from "vitest";
import type { Prepared } from "./render";
import { DEPLOYED_MATTE_MODELS, MATTE_BUSY_TRIES } from "./matte";
import { matteThroughRoutes, planMatteRoutes, type MatteRouting, type VendorCall } from "./matte-routing";
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
/** A gate that always allows (or always refuses); `released` counts the reservations given back. */
function gate(ok = true) {
  const released = {count: 0};
  const reserve = vi.fn<OverflowGate["reserve"]>(async route => ok
    ? {ok: true, spentUsd: 0, capUsd: route.dailyCapUsd ?? 0, release: () => { released.count++; }}
    : {ok: false, reason: "over_cap", spentUsd: 1, capUsd: 1});
  return Object.assign({reserve} satisfies OverflowGate, {released});
}
function routing(rows: RouteDef[], world: ReturnType<typeof fakeMatting>, extra: Partial<MatteRouting> = {}) {
  const recorded: VendorCall[] = [];
  const r: MatteRouting = {router: createRouter(rows, new CircuitBreakers()), preferred: [M1, M2], vendor: {fetch: world.fetch, env: {PHOTOROOM_API_KEY: "test-key"}}, log: vi.fn(),
    record: vi.fn(async (call: VendorCall) => { recorded.push(call); return true; }), ...extra};
  return Object.assign(r, {recorded});
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
  it("P2-2: plans only the policy's models, in policy order: GPU, then the vendor when switched on, then the CPU service", () => {
    const ids = (rows: RouteDef[], preferred: string[] = [M1, M2]) => planMatteRoutes(createRouter(rows), preferred).map(r => `${r.adapter}:${r.model}`);
    expect(ids(routes())).toEqual([`matting-gpu:${M1}`, `matting-gpu:${M2}`, `matting-cpu:${M1}`, `matting-cpu:${M2}`]);
    expect(ids(routes({overflow: true}), ["bria-rmbg", M1])).toEqual(["matting-gpu:bria-rmbg", `matting-gpu:${M1}`, `photoroom:${PHOTOROOM_MATTE_MODEL}`, "matting-cpu:bria-rmbg", `matting-cpu:${M1}`]);
    // A model the policy did not choose is never planned.
    expect(ids(routes({overflow: true})).some(id => /hrsod|bria/.test(id))).toBe(false);
    // The kill switch: route 1 off is never planned.
    expect(ids(routes({off: [routeId("image.matte", "matting-gpu", M1)]}))).toEqual([`matting-gpu:${M2}`, `matting-cpu:${M1}`, `matting-cpu:${M2}`]);
    // A policy model the table does not know is still asked on our own services, GPU first.
    expect(ids(routes(), ["fixture"])).toEqual(["matting-gpu:fixture", "matting-cpu:fixture"]);
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
    expect(r.log).toHaveBeenCalledWith("catalog matte route fallback", expect.objectContaining({kind: "server", fallbackModel: M2}));
  });
  it("P2-2: GPU models 1 and 2 broken: CPU model 1 answers, never a model the policy did not choose", async () => {
    const w = fakeMatting([...DEPLOYED_MATTE_MODELS]);
    w.state.failing.gpu.add(M1); w.state.failing.gpu.add(M2);
    const matte = await matteThroughRoutes(prepared(), w.client, routing(routes(), w));
    expect(matte).toMatchObject({target: "cpu", model: M1});
    expect(w.state.calls).toEqual([`gpu:${M1}`, `gpu:${M2}`, `cpu:${M1}`]);
  });
  it("P2-1: a busy GPU (429 on every call) costs one model's busy retries and waits, as before, then CPU model 1", async () => {
    const w = fakeMatting([...DEPLOYED_MATTE_MODELS]);
    w.state.busy.gpu = true;
    const matte = await matteThroughRoutes(prepared(), w.client, routing(routes(), w));
    expect(matte).toMatchObject({target: "cpu", model: M1});
    expect(w.state.calls).toEqual([...Array<string>(MATTE_BUSY_TRIES).fill(`gpu:${M1}`), `cpu:${M1}`]);
    expect(w.state.sleeps).toHaveLength(MATTE_BUSY_TRIES - 1);
    expect(w.state.sleeps.every(ms => ms >= 1000 && ms <= 3000)).toBe(true);
    // One breaker failure per busy photo on the shared GPU breaker, as before.
    expect(w.client.gpuBreakers[0]!.failures).toBe(1);
  });
  it("GPU service stopped, overflow off: the vendor is never asked and the CPU service answers with model 1", async () => {
    const w = fakeMatting(), g = gate(), r = routing(routes(), w, {overflow: g});
    w.state.down.gpu = true;
    const matte = await matteThroughRoutes(prepared(), w.client, r);
    expect(matte).toMatchObject({target: "cpu", model: M1, route: {routeId: routeId("image.matte", "matting-cpu", M1)}});
    expect(w.state.calls).toEqual([`cpu:${M1}`]);
    expect(g.reserve).not.toHaveBeenCalled();
  });
  it("GPU and CPU stopped, overflow off: the simple method, no route (fallback_matte follows, never an error)", async () => {
    const w = fakeMatting();
    w.state.down = {gpu: true, cpu: true};
    const matte = await matteThroughRoutes(prepared(), w.client, routing(routes(), w));
    expect(matte).toMatchObject({source: "floodfill", route: {routeId: null}});
  });
  it("GPU stopped, overflow on within its cap: the vendor answers before the CPU service; the call is recorded at once, then released", async () => {
    const w = fakeMatting(), g = gate(), r = routing(routes({overflow: true}), w, {overflow: g});
    w.state.down.gpu = true;
    const matte = await matteThroughRoutes(prepared(), w.client, r);
    expect(matte).toMatchObject({source: "model", target: null, model: PHOTOROOM_MATTE_MODEL, width: 48, height: 32, route: {routeId: VENDOR, overflow: {engine: "photoroom", usd: 0.02, reason: expect.stringMatching(/^own routes unavailable/)}}});
    expect(matte.alpha).toHaveLength(48 * 32);
    expect(w.state.calls).toEqual(["vendor"]);
    expect(w.state.vendorKeys).toEqual(["test-key"]);
    expect(r.recorded).toEqual([expect.objectContaining({routeId: VENDOR, engine: "photoroom", usd: 0.02, estimated: true, outcome: "ok"})]);
    expect(g.released.count).toBe(1);
    expect(r.log).toHaveBeenCalledWith("catalog matte overflow", expect.objectContaining({route: VENDOR, usd: 0.02}));
    // The key is never logged.
    expect(JSON.stringify(vi.mocked(r.log!).mock.calls)).not.toContain("test-key");
  });
  it("P2-5: every vendor HTTP call reaches the ledger: a wrong size and a timeout are priced, a refusal is free; CPU answers", async () => {
    for (const [vendor, usd, outcome] of [["wrong_size", 0.02, "failed"], ["timeout", 0.02, "timeout"], [402, 0, "failed"], [503, 0, "failed"]] as const) {
      const w = fakeMatting(), g = gate(), r = routing(routes({overflow: true}), w, {overflow: g});
      w.state.down.gpu = true; w.state.vendor = vendor;
      const matte = await matteThroughRoutes(prepared(), w.client, r);
      expect(matte, String(vendor)).toMatchObject({target: "cpu", model: M1});
      expect(matte.route?.overflow).toBeUndefined();
      expect(r.recorded, String(vendor)).toEqual([expect.objectContaining({routeId: VENDOR, usd, outcome})]);
      expect(g.released.count).toBe(1);
    }
  });
  it("P2-5: a vendor call whose ledger write failed keeps its reservation (it keeps counting against the cap)", async () => {
    const w = fakeMatting(), g = gate(), r = routing(routes({overflow: true}), w, {overflow: g, record: vi.fn(async () => false)});
    w.state.down.gpu = true;
    await matteThroughRoutes(prepared(), w.client, r);
    expect(g.released.count).toBe(0);
  });
  it("over its daily cap, or without a key (checked before any reservation): no vendor call, the CPU service answers", async () => {
    for (const setup of [{gate: gate(false), key: "test-key"}, {gate: gate(), key: ""}]) {
      const w = fakeMatting(), r = routing(routes({overflow: true}), w, {overflow: setup.gate, vendor: {fetch: w.fetch, env: {PHOTOROOM_API_KEY: setup.key}}});
      w.state.down.gpu = true;
      const matte = await matteThroughRoutes(prepared(), w.client, r);
      expect(matte).toMatchObject({target: "cpu", model: M1});
      expect(w.state.calls).not.toContain("vendor");
      expect(r.recorded).toEqual([]);
      if (!setup.key) expect(setup.gate.reserve).not.toHaveBeenCalled();
    }
  });
  it("without a gate or a ledger writer no overflow route is ever called, even when serving", async () => {
    for (const extra of [{overflow: undefined}, {overflow: gate(), record: undefined}]) {
      const w = fakeMatting();
      w.state.down.gpu = true;
      await matteThroughRoutes(prepared(), w.client, routing(routes({overflow: true}), w, extra));
      expect(w.state.calls).toEqual([`cpu:${M1}`]);
    }
  });
  it("a photo with its own transparency keeps it: no route is asked", async () => {
    const w = fakeMatting(), p = {...prepared(), alphaSource: Buffer.alloc(48 * 32, 255)};
    expect(await matteThroughRoutes(p, w.client, routing(routes(), w))).toMatchObject({source: "alpha_source", route: {routeId: null}});
    expect(w.state.calls).toEqual([]);
  });
});
