import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../db/testing";
import type { Db } from "../../db/client";
import { modelPolicy } from "../../db/schema";
import { ensureDefaultPolicies } from "../qa/policy";
import { planPolicy, writePolicyRows } from "./policy-writer";
import { MATTE_CANDIDATES } from "./run";
import type { EvalJudgementRow, EvalLabelRow, EvalOutputRow } from "./score";

let db: Db, close: () => Promise<void>;
beforeAll(async () => { ({ db, close } = await createTestDb()); });
afterAll(async () => close());

const at = new Date("2026-10-19T00:00:00Z");
const out = (outputId: string, brand: string, category: string): EvalOutputRow => ({ outputId, batchId: "b1", brand, category, matteModel: "birefnet-general", matteTarget: "cpu", matteMs: 800, complianceOk: true });
const judged = (outputId: string, score: number): EvalJudgementRow => ({ outputId, judgeModel: "google/gemini-2.5-flash-lite", verdict: score >= 75 ? "pass" : "flag", costUsd: 0.0004, ms: 50, scores: Object.fromEntries(["complete_product", "same_product", "edge_quality", "background_clean", "no_text_or_watermark", "orientation_ok", "placement_ok", "overall"].map(k => [k, score])) });
const label = (outputId: string, l: "pass" | "flag"): EvalLabelRow => ({ outputId, labeler: "a@opptra.com", label: l, reasons: l === "flag" ? ["halo"] : [], createdAt: at });

describe("policy write", () => {
  it("plans (brand, category), (*, category) and (*, *) rows, replaces default and pending, never manual", async () => {
    await ensureDefaultPolicies(db);
    await db.insert(modelPolicy).values([
      { brandSlug: "anta", category: "footwear", matteModel: "x", qaModel: "q", threshold: 75, floor: 60, source: "pending" },
      { brandSlug: "french_connection", category: "apparel_model", matteModel: "kept", qaModel: "q", threshold: 80, floor: 60, source: "manual" },
    ]);
    const outputs = [out("a1", "anta", "footwear"), out("a2", "anta", "footwear"), out("f1", "french_connection", "apparel_model"), out("f2", "french_connection", "apparel_model")];
    const plan = planPolicy({ outputs, judgements: [judged("a1", 90), judged("a2", 40), judged("f1", 90), judged("f2", 40)], labels: [label("a1", "pass"), label("a2", "flag"), label("f1", "pass"), label("f2", "flag")], candidates: MATTE_CANDIDATES, seen: { matte: [{ id: "birefnet-general", target: "cpu" }], judges: ["google/gemini-2.5-flash-lite"] } });
    const rows = plan.flatMap(s => s.row ? [s.row] : []);
    expect(rows.map(r => `${r.brandSlug}|${r.category}`).sort()).toEqual(["*|*", "*|apparel_model", "*|footwear", "anta|footwear", "french_connection|apparel_model"]);
    expect(rows.find(r => r.brandSlug === "anta")).toMatchObject({ matteModel: "birefnet-general", matteTarget: "cpu", qaModel: "google/gemini-2.5-flash-lite", threshold: 75, source: "bakeoff", gates: { met: true, n_labelled: 2 } });

    const dry = await writePolicyRows(db, rows, true);
    expect((await db.select().from(modelPolicy)).find(r => r.brandSlug === "anta")!.source).toBe("pending");
    expect(dry.find(r => r.row.brandSlug === "french_connection")!.outcome).toBe("kept_manual");

    const written = await writePolicyRows(db, rows);
    expect(Object.fromEntries(written.map(w => [`${w.row.brandSlug}|${w.row.category}`, w.outcome]))).toMatchObject({ "anta|footwear": "replaced", "*|footwear": "replaced", "*|*": "inserted", "french_connection|apparel_model": "kept_manual" });
    const stored = await db.select().from(modelPolicy);
    expect(stored.find(r => r.brandSlug === "anta")).toMatchObject({ source: "bakeoff", matteModel: "birefnet-general", matteTarget: "cpu", evalBatchIds: ["b1"] });
    expect(stored.find(r => r.brandSlug === "*" && r.category === "footwear")).toMatchObject({ source: "bakeoff", shadowMode: "preserve_else_synthesise" });
    expect(stored.find(r => r.brandSlug === "french_connection")).toMatchObject({ source: "manual", matteModel: "kept", threshold: 80 });
  });
});
