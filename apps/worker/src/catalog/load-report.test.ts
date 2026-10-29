import { describe, expect, it, vi } from "vitest";
import type { LinkResult } from "@catalog/core/catalog/recheck/check";
import { problemCodes, RECHECK_LINKS_PER_PROBLEM, recheckEvidence, reportThenCleanup } from "./load-report";

const link = (i: number, problem: string, http: number | null = 200): LinkResult => ({ url: `https://storage.googleapis.com/b/catalog-test/x/noon/p${i}_1.jpg`, identifier: `P${i}`, channel: "noon", n: 1, status: problem ? "failed" : "ok", http, bytes: null, width: null, height: null, generation: null, problem });

describe("spec 18 H4: load report evidence", () => {
  it("keeps every failed link's reason, grouped by problem", () => {
    const results = [link(1, ""), link(2, "http_status", 404), link(3, "fetch_error: socket hang up", null), link(4, "wrong_generation; http_status", 503)];
    const evidence = recheckEvidence({ results, problems: [{ problem: "row_count", detail: "The sheet has 3 product rows; 4 were expected." }], summary: { ok: 1, total: 5, line: "1 of 5 links OK", passed: false } }, "recheck-b1.csv");
    expect(evidence).toMatchObject({ line: "1 of 5 links OK", passed: false, ok: 1, total: 5, csv: "recheck-b1.csv", sheetProblems: [{ problem: "row_count" }] });
    expect(Object.fromEntries(Object.entries(evidence.failuresByProblem).map(([k, v]) => [k, v.links.map(l => l.identifier)]))).toEqual({ http_status: ["P2", "P4"], fetch_error: ["P3"], wrong_generation: ["P4"] });
    expect(evidence.failuresByProblem.fetch_error!.links[0]).toMatchObject({ http: null, problem: "fetch_error: socket hang up" });
  });
  it("counts every failure but keeps a sample of links per problem in the JSON", () => {
    const results = Array.from({ length: RECHECK_LINKS_PER_PROBLEM + 7 }, (_, i) => link(i, "http_status", 404));
    const group = recheckEvidence({ results, problems: [], summary: { ok: 0, total: results.length, line: "", passed: false } }, null).failuresByProblem.http_status!;
    expect(group.count).toBe(RECHECK_LINKS_PER_PROBLEM + 7);
    expect(group.links).toHaveLength(RECHECK_LINKS_PER_PROBLEM);
  });
  it("reads problem codes without their detail", () => {
    expect(problemCodes({ problem: "wrong_dimensions; fetch_error: reset: again" })).toEqual(["wrong_dimensions", "fetch_error"]);
    expect(problemCodes({ problem: "" })).toEqual([]);
  });
  it("writes the report before the cleanup runs, then again with the cleanup's outcome", async () => {
    const order: string[] = [], written: unknown[] = [];
    const write = vi.fn(async (r: { cleanup: unknown }) => { order.push("write"); written.push(structuredClone(r.cleanup)); });
    const cleanup = vi.fn(async () => { order.push("cleanup"); return { objects: 12, ms: 5 }; });
    const report = await reportThenCleanup({ run: "load-1", cleanup: "pending" as unknown }, { write, cleanup });
    expect(order).toEqual(["write", "cleanup", "write"]);
    expect(written).toEqual(["pending", { objects: 12, ms: 5 }]);
    expect(report.cleanup).toEqual({ objects: 12, ms: 5 });
  });
  it("writes once when there is no cleanup (--keep)", async () => {
    const write = vi.fn(async () => {});
    await reportThenCleanup({ cleanup: "kept" }, { write });
    expect(write).toHaveBeenCalledOnce();
  });
});
