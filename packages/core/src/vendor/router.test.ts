import { describe, expect, it } from "vitest";
import { CircuitBreakers } from "./circuit";
import { callRoutes, createRouter, planRoutes, type PlannedRoute, type RouteAttempt } from "./router";
import { NO_TRAINING_PENDING, OPENROUTER_NO_TRAINING_POSITION, SEED_ROUTES, hasNoTrainingPosition, routeId, type RouteDef } from "./routes";

/** The seeds as they are once the owner has recorded a no-training position and switched them on. */
const SERVING = SEED_ROUTES.map(r => ({...r, state: "serving" as const, noTrainingTerms: "test: written position on file"}));
const judgeRoutes = () => SERVING.filter(r => r.capability === "judge.render");
const off = (routes: readonly RouteDef[], rank: number) => routes.map(r => r.rank === rank ? {...r, state: "off" as const} : r);
const models = (plan: PlannedRoute[]) => plan.map(r => r.model);
const [FIRST, SECOND, THIRD] = judgeRoutes().map(r => r.model) as [string, string, string];

describe("M7-F2 route plan", () => {
  it("seeds at least two ranked routes and a fallback of different providers for the judge and the reader (R2)", () => {
    for (const capability of ["judge.render", "vision.read"] as const) {
      const rows = SEED_ROUTES.filter(r => r.capability === capability);
      expect(rows.map(r => r.rank)).toEqual([1, 2, 3]);
      expect(new Set(rows.map(r => r.model.split("/")[0])).size).toBe(3);
      expect(rows.every(r => r.id === routeId(capability, r.adapter, r.model))).toBe(true);
      // R7: the owner's recorded position (OpenRouter's provider data policy, 2026-11-03) is on file, so the seeds serve.
      expect(rows.every(r => r.state === "serving" && r.noTrainingTerms === OPENROUTER_NO_TRAINING_POSITION)).toBe(true);
      expect(models(planRoutes(createRouter(SEED_ROUTES), capability, [rows[0]!.model]))).toEqual(rows.map(r => r.model));
    }
  });
  it("R7: the recorded OpenRouter position is a written one: it names the owner decision and links the provider data policy", () => {
    expect(hasNoTrainingPosition(OPENROUTER_NO_TRAINING_POSITION)).toBe(true);
    expect(OPENROUTER_NO_TRAINING_POSITION).toMatch(/^OpenRouter provider data policy .*https:\/\/openrouter\.ai\/docs\/guides\/privacy\/data-collection.*; owner decision 2026-11-03$/);
  });
  it("R7: a serving route without a written no-training position is never planned for a brand-photo capability", () => {
    const pending = judgeRoutes().map(r => r.rank === 1 ? {...r, noTrainingTerms: NO_TRAINING_PENDING} : r.rank === 2 ? {...r, noTrainingTerms: null} : r);
    expect(models(planRoutes(createRouter(pending), "judge.render", [FIRST, SECOND]))).toEqual([THIRD]);
  });
  it("puts the policy's models first, then the other serving routes by rank", () => {
    const router = createRouter(SERVING);
    expect(models(planRoutes(router, "judge.render", [SECOND, FIRST]))).toEqual([SECOND, FIRST, THIRD]);
    // With a table, a policy model without a row has no recorded position, so it is not asked (R7); without a table
    // (unit tests, the eval job) the policy's models are the plan, on the OpenRouter adapter.
    expect(models(planRoutes(router, "judge.render", ["test/judge", undefined]))).toEqual([FIRST, SECOND, THIRD]);
    expect(planRoutes(undefined, "judge.render", ["test/judge"])[0]).toMatchObject({id: "judge.render:openrouter:test/judge", fromTable: false});
  });
  it("never plans a switched-off route, even when the policy prefers it (the kill switch, R5)", () => {
    const router = createRouter(off(judgeRoutes(), 1));
    expect(models(planRoutes(router, "judge.render", [FIRST, SECOND]))).toEqual([SECOND, THIRD]);
  });
  it("leaves out a route whose circuit is open, and plans the preferred models alone without a router", () => {
    const circuits = new CircuitBreakers({now: () => 0});
    for (let i = 0; i < 5; i++) circuits.failure(judgeRoutes()[1]!.id);
    expect(models(planRoutes(createRouter(SERVING, circuits), "judge.render", [FIRST, SECOND]))).toEqual([FIRST, THIRD]);
    expect(models(planRoutes(undefined, "judge.render", [FIRST, SECOND, FIRST, null]))).toEqual([FIRST, SECOND]);
  });
});

describe("M7-F2-R3 circuit breaker", () => {
  it("opens after 5 failures within 2 minutes, probes after 60 s, closes on a success and reopens on a failed probe", () => {
    let now = 0;
    const circuits = new CircuitBreakers({now: () => now});
    for (let i = 0; i < 4; i++) { circuits.failure("r"); now += 10_000; }
    expect(circuits.state("r")).toBe("closed");
    circuits.failure("r");
    expect(circuits.state("r")).toBe("open");expect(circuits.canCall("r")).toBe(false);
    now += 59_999;expect(circuits.canCall("r")).toBe(false);
    now += 1;expect(circuits.state("r")).toBe("probing");
    circuits.failure("r");expect(circuits.state("r")).toBe("open");
    now += 60_000;circuits.success("r");expect(circuits.state("r")).toBe("closed");
  });
  it("forgets failures older than the window", () => {
    let now = 0;
    const circuits = new CircuitBreakers({now: () => now});
    for (let i = 0; i < 4; i++) circuits.failure("r");
    now += 120_000;circuits.failure("r");
    expect(circuits.state("r")).toBe("closed");
  });
});

describe("M7-F2 callRoutes", () => {
  const route = (model: string): PlannedRoute => ({id: routeId("judge.render", "openrouter", model), capability: "judge.render", rank: 1, adapter: "openrouter", model, fromTable: true});
  const plan = [route("a/one"), route("b/two"), route("c/three")];
  const failing = (kind: string, status: number | null = null): RouteAttempt<string> => ({value: null, failure: {kind, status}, costUsd: .001, calls: 1});
  const answer = (value: string): RouteAttempt<string> => ({value, failure: null, costUsd: .002, calls: 1});
  it("moves to the next route on a rate limit, a timeout or a refusal, and names the route that answered", async () => {
    const replies = [failing("rate_limit", 429), failing("empty_reply"), answer("ok")];
    const asked: number[] = [];
    const result = await callRoutes(plan, async (_route, index) => { asked.push(index); return replies[index]!; });
    expect(asked).toEqual([0, 1, 2]);
    expect(result).toMatchObject({ok: true, output: "ok", routeId: "judge.render:openrouter:c/three", costUsd: .004, calls: 3, refusal: false, error: null});
    expect(result.tried.map(t => t.failure?.kind ?? "ok")).toEqual(["rate_limit", "empty_reply", "ok"]);
  });
  it("a model gone at the vendor (404) moves to the next route and counts on the circuit", async () => {
    const circuits = new CircuitBreakers({now: () => 0}), router = createRouter([], circuits);
    const result = await callRoutes(plan, async (_r, i) => i === 0 ? failing("model_unavailable", 404) : answer("ok"), {router});
    expect(result).toMatchObject({ok: true, routeId: plan[1]!.id});
    for (let i = 0; i < 4; i++) await callRoutes([plan[0]!], async () => failing("model_unavailable", 404), {router});
    expect(circuits.state(plan[0]!.id)).toBe("open");
  });
  it("a stop of the caller's own (spend cap, lease lost) propagates: no next route, no circuit failure", async () => {
    const circuits = new CircuitBreakers({now: () => 0}), router = createRouter([], circuits), asked: string[] = [];
    await expect(callRoutes(plan, async route => { asked.push(route.id); throw new Error("Batch QA spend cap reached"); }, {router})).rejects.toThrow(/spend cap/);
    expect(asked).toEqual([plan[0]!.id]);
    expect(plan.every(r => circuits.state(r.id) === "closed")).toBe(true);
  });
  it("stops at an auth failure (shared key): no other route is asked", async () => {
    const result = await callRoutes(plan, async () => failing("auth", 401));
    expect(result).toMatchObject({ok: false, output: null, route: null, calls: 1, error: {kind: "auth", status: 401}});
  });
  it("all routes failing: not ok, a refusal is reported, every cost kept; an empty plan answers nothing", async () => {
    const result = await callRoutes(plan, async (_r, i) => failing(i === 1 ? "empty_reply" : "server", 503));
    expect(result).toMatchObject({ok: false, refusal: true, calls: 3, costUsd: .003, error: {kind: "server"}});
    expect(await callRoutes([], async () => answer("never"))).toMatchObject({ok: false, calls: 0, error: {kind: "no_route"}});
  });
  it("counts route failures on the circuit but not refusals, and a success closes it", async () => {
    const circuits = new CircuitBreakers({now: () => 0}), router = createRouter([], circuits);
    for (let i = 0; i < 5; i++) await callRoutes([plan[0]!], async () => failing("empty_reply"), {router});
    expect(circuits.state(plan[0]!.id)).toBe("closed");
    for (let i = 0; i < 5; i++) await callRoutes([plan[0]!], async () => failing("server", 502), {router});
    expect(circuits.state(plan[0]!.id)).toBe("open");
    await callRoutes([plan[1]!], async () => answer("ok"), {router});
    expect(circuits.state(plan[1]!.id)).toBe("closed");
  });
});
