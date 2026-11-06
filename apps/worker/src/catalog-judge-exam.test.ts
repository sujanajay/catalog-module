import { describe, expect, it } from "vitest";
import { planRoutes } from "@catalog/core/vendor/router";
import { SEED_ROUTES } from "@catalog/core/vendor/routes";
import { examPlan, routerWithout } from "./catalog-judge-exam";

const judges = SEED_ROUTES.filter(r => r.capability === "judge.render");
const [first, second] = judges.map(r => r.model) as [string, string];

describe("the judge exam's plan (M1 D43)", () => {
  it("examines every judge a verdict can come from: the first with its second opinion, the next with the first switched off", () => {
    expect(examPlan(judges, first)).toEqual([{ name: "first judge", judge: first, off: [] }, { name: "fallback judge", judge: second, off: [first] }]);
  });
  it("with one judge left there is one exam; with no route the first judge is still examined, gets no answer and fails", () => {
    expect(examPlan([judges[0]!], first)).toHaveLength(1);
    expect(examPlan([], first)).toEqual([{ name: "first judge", judge: first, off: [] }]);
  });
  it("a route that is not serving is not examined as the fallback", () => {
    expect(examPlan(judges.map(r => (r.model === second ? { ...r, state: "off" as const } : r)), first)).toHaveLength(1);
  });
  it("with the first judge switched off the plan asks the fallback first, as in a drill; the classifier's routes are not touched", () => {
    const router = routerWithout(SEED_ROUTES, [first]);
    expect(planRoutes(router, "judge.render", [first]).map(r => r.model)).toEqual([second]);
    expect(planRoutes(router, "vision.read", []).length).toBeGreaterThan(0);
  });
});
