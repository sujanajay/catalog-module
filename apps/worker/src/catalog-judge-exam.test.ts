import { describe, expect, it } from "vitest";
import { planRoutes } from "@catalog/core/vendor/router";
import { SEED_ROUTES } from "@catalog/core/vendor/routes";
import { examBlocked, examExitCode, examFlags, examPlan, routerWithout } from "./catalog-judge-exam";

const judges = SEED_ROUTES.filter(r => r.capability === "judge.render");
const [first, second] = judges.map(r => r.model) as [string, string];

describe("the judge exam's exit code (M1 D43)", () => {
  it("0 on a pass, 1 only on a judge proven below a bar, 3 on no result", () => {
    expect(examExitCode({ pass: true, failedJudges: [] })).toBe(0);
    expect(examExitCode({ pass: false, failedJudges: [first] })).toBe(1);
    expect(examExitCode({ pass: false, failedJudges: [] })).toBe(3);
  });
});

describe("the judge exam's plan (M1 D43)", () => {
  it("examines every judge a verdict can come from: the first with its second opinion, the next with the first switched off", () => {
    expect(examPlan(judges, first)).toEqual([{ name: "first judge", judge: first, off: [] }, { name: "fallback judge", judge: second, off: [first] }]);
  });
  it("with one judge left there is one exam; with no route the first judge is still examined, gets no answer and fails", () => {
    expect(examPlan([judges[0]!], first)).toHaveLength(1);
    expect(examPlan([], first)).toEqual([{ name: "first judge", judge: first, off: [] }]);
  });
  it("a drill or a switched-off judge reads as could not run, never as a judge failure", () => {
    expect(examBlocked(judges, [first, second])).toBeNull();
    expect(examBlocked(judges.map(r => (r.model === first ? { ...r, state: "off" as const } : r)), [first, second])).toContain(first);
    expect(examBlocked(judges.map(r => (r.model === second ? { ...r, state: "off" as const } : r)), [first, second])).toContain(second);
    expect(examBlocked([], [first, second])).toContain("not serving");
  });
  it("the fallback judge is marked on what it saw when the second opinion it cannot have left the photo unchecked; with a second opinion the verdict stands", () => {
    const scores = { complete_product: 100, same_product: 100, edge_quality: 100, background_clean: 40, no_text_or_watermark: 100, orientation_ok: 100, product_intact: 100, overall: 40 };
    const unchecked = { flags: ["qa_unavailable"], route: "r", scores, leftover: { first: true, second: null, secondModel: null, confirmed: false, located: true }, wrongItem: { first: true, second: null, secondModel: null, confirmed: false } } as never;
    expect(examFlags(unchecked, false, 75, 60)).toEqual(["leftover_background", "different_product"]);
    expect(examFlags(unchecked, true, 75, 60)).toEqual(["qa_unavailable"]);
    expect(examFlags({ ...(unchecked as object), route: null } as never, false, 75, 60)).toEqual(["qa_unavailable"]);
    expect(examFlags({ flags: ["halo"], route: "r", scores } as never, false, 75, 60)).toEqual(["halo"]);
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
