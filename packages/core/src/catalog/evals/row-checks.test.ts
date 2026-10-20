import { describe, expect, it } from "vitest";
import { checkAttention, flagRows } from "./attention";
import { CHART_SKIP_NOTE, checkCompleteness, expectedOutcome, STYLI_SKIP_NOTE, type CompletenessInput, type OutputRow } from "./completeness";
import { checkIdentical, checkOverwrite, type LiveRow } from "./overwrite";
import { buildReport, reportHtml, summaryLine } from "./report";
import { policyRowsFor, rankModels, scoreModels, winnersByScope, type MatteTrial } from "./matte-bakeoff";
import type { CheckResult, Expectation } from "./types";
import type { ChannelId } from "../types";

const failed = (results: CheckResult[]) => results.filter(r => r.status === "fail").map(r => r.id);
const NONE: Expectation = { attention: false, flags: [], detector: "code" };

function completenessWorld() {
  const channels: ChannelId[] = ["noon", "styli", "amazon"];
  const sources = [{ identifier: "A", n: 1, width: 800, height: 800 }, { identifier: "A", n: 2, width: 800, height: 800 }, { identifier: "A", n: 3, width: 2000, height: 3000 }];
  const outputs: OutputRow[] = [], publicHeads = new Map(), stagingHeads = new Map(), sheet: CompletenessInput["sheet"] = [];
  for (const s of sources) for (const ch of channels) {
    const skip = expectedOutcome(s, ch) === "skip", url = `https://x/${s.identifier}/${ch}/${s.identifier}_${s.n}.jpg`;
    outputs.push({ identifier: s.identifier, n: s.n, channel: ch, status: skip ? "skipped" : "verified", isLive: !skip, reason: skip ? STYLI_SKIP_NOTE : null, generation: skip ? null : 7, bytes: skip ? null : 100, crc32c: skip ? null : "c", publicUrl: url, stagingUri: skip ? null : `gs://a/${ch}/${s.n}` });
    if (!skip) { publicHeads.set(url, { exists: true, size: 100, generation: "7", contentType: "image/jpeg" }); stagingHeads.set(`gs://a/${ch}/${s.n}`, { exists: true, size: 100, generation: "1", contentType: "image/jpeg" }); }
    sheet.push({ identifier: s.identifier, channel: ch, n: s.n, url: skip ? null : url });
  }
  const input: CompletenessInput = { channels, sources, outputs, publicHeads, stagingHeads, sheet, sheetNotes: new Map([["A", `Styli img 1: ${STYLI_SKIP_NOTE}; Styli img 2: ${STYLI_SKIP_NOTE}`]]), counts: { outputs: 9, verified: 7, skipped: 2, recheckOk: 7, recheckTotal: 7 } };
  return input;
}

describe("completeness", () => {
  it("expects one live output per source and channel, Styli skips only under the minimum, and every Amazon shot", () => {
    const results = checkCompleteness(completenessWorld());
    expect(failed(results)).toEqual([]);
    expect(results.filter(r => r.id === "completeness.amazon_shot")).toHaveLength(3);
    expect(results.filter(r => r.id === "completeness.skip_allowed" && r.measured === `skipped: ${STYLI_SKIP_NOTE}`)).toHaveLength(2);
  });
  it("fails on a missing output, a wrong public object, an extra row and count mismatches", () => {
    const w = completenessWorld();
    w.outputs = w.outputs.filter(o => !(o.channel === "amazon" && o.n === 3));
    w.publicHeads.set("https://x/A/noon/A_1.jpg", { exists: true, size: 99, generation: "7", contentType: "image/jpeg" });
    w.outputs.push({ ...w.outputs[0]!, identifier: "GHOST" });
    w.counts.verified = 6;
    const ids = failed(checkCompleteness(w));
    expect(ids).toContain("completeness.one_output");
    expect(ids).toContain("completeness.public_object");
    expect(ids).toContain("completeness.no_extra_outputs");
    expect(ids).toContain("completeness.counts_verified");
  });
  it("fails a skip the spec does not allow and a sheet cell without its note", () => {
    const w = completenessWorld();
    w.outputs.find(o => o.channel === "noon" && o.n === 1)!.status = "skipped";
    w.sheetNotes.set("A", "");
    const ids = failed(checkCompleteness(w));
    expect(ids).toContain("completeness.skip_allowed");
    expect(ids).toContain("completeness.sheet_cell");
  });
  it("does not require an expected hold to be live or linked, and excludes it from the counts", () => {
    const w = completenessWorld();
    for (const o of w.outputs.filter(row => row.n === 3)) Object.assign(o, { status: "needs_attention", isLive: false, generation: null, bytes: null, crc32c: null });
    for (const cell of w.sheet.filter(c => c.n === 3)) cell.url = null;
    Object.assign(w.counts, { verified: 4, skipped: 2, recheckOk: 4, recheckTotal: 4 });
    w.heldExpected = new Set(["A|3"]);
    const results = checkCompleteness(w);
    expect(failed(results)).toEqual([]);
    expect(results.filter(r => r.id === "completeness.held_unpublished")).toHaveLength(3);
    expect(results.some(r => r.id === "completeness.live" && r.subject.n === 3)).toBe(false);
    // Published after all: the hold is reported here as well as by attention.expected.
    w.outputs.find(o => o.n === 3 && o.channel === "noon")!.isLive = true;
    expect(failed(checkCompleteness(w))).toEqual(["completeness.held_unpublished"]);
  });
  it("accepts a size chart left out on every channel with its note, and fails it without the note", () => {
    const w = completenessWorld();
    for (const o of w.outputs.filter(row => row.n === 3)) Object.assign(o, { status: "skipped", isLive: false, reason: CHART_SKIP_NOTE, generation: null, bytes: null, crc32c: null, stagingUri: null });
    for (const cell of w.sheet.filter(c => c.n === 3)) cell.url = null;
    w.sheetNotes.set("A", `${w.sheetNotes.get("A")}; photo 3: ${CHART_SKIP_NOTE}`);
    Object.assign(w.counts, { verified: 4, skipped: 5, recheckOk: 4, recheckTotal: 4 });
    const results = checkCompleteness(w);
    expect(failed(results)).toEqual([]);
    expect(results.filter(r => r.id === "completeness.skip_allowed" && r.measured === `skipped: ${CHART_SKIP_NOTE}`)).toHaveLength(3);
    w.sheetNotes.set("A", "");
    expect(failed(checkCompleteness(w))).toContain("completeness.sheet_cell");
  });
});

describe("attention", () => {
  const row = (identifier: string, n: number, channel: ChannelId, extra: Partial<Parameters<typeof checkAttention>[0]["outputs"][number]> = {}) => ({ identifier, n, channel, status: "verified", flags: [] as never[], reason: null, qaScores: null, ...extra });
  it("counts unexpected holds, requires expected ones, and reports the rates", () => {
    const outputs = [row("A", 1, "noon"), row("A", 1, "amazon"), row("B", 1, "noon", { status: "needs_attention", flags: ["halo"], reason: "edge" }), row("B", 1, "amazon", { status: "needs_attention", flags: ["halo"], reason: "edge" }), row("C", 1, "noon"), row("C", 1, "amazon")];
    const out = checkAttention({ products: [{ identifier: "A", change: "new", productType: "footwear", expect: NONE }, { identifier: "B", change: "pending_attention", productType: "footwear", expect: NONE }, { identifier: "C", change: "new", productType: "footwear", expect: { attention: true, flags: ["small_source"], detector: "code" } }], outputs, deterministicPass: new Set(["B|noon|1", "B|amazon|1"]), liveJudge: false, threshold: 75 });
    expect(out.attentionProducts).toBe(1);
    expect(out.attentionRate).toBeCloseTo(1 / 3);
    expect(out.falseHoldRate).toBe(1);
    expect(failed(out.results)).toEqual(expect.arrayContaining(["attention.not_held", "attention.expected", "attention.false_hold_rate"]));
    expect(out.results.find(r => r.id === "attention.not_held" && !r.ok)?.detail).toContain("image 1 for noon: halo (edge)");
  });
  it("treats a pass-through matte as information, not a problem flag", () => {
    const outputs = [row("C", 1, "noon", { status: "needs_attention", flags: ["small_source", "matte_passthrough", "low_resolution"] }), row("C", 1, "amazon", { status: "needs_attention", flags: ["small_source", "matte_passthrough", "low_resolution"] })];
    const out = checkAttention({ products: [{ identifier: "C", change: "pending_attention", productType: "footwear", expect: { attention: true, flags: ["small_source"], detector: "code" } }], outputs, deterministicPass: new Set(), liveJudge: false, threshold: 75 });
    expect(out.results.find(r => r.id === "attention.expected")?.ok).toBe(true);
  });
  it("flags a judge false positive and a false different-product only on a live run, and catches planted items", () => {
    const flagged = { status: "needs_attention", flags: ["different_product"] as never[], reason: "no match", qaScores: { verdict: "flag", same_product: 20, reasons: ["looks different"] } };
    const outputs = [row("A", 1, "noon"), row("A", 2, "noon", flagged), row("P", 1, "noon"), row("P", 2, "noon", flagged)];
    const products = [{ identifier: "A", change: "pending_attention", productType: "footwear", expect: NONE }, { identifier: "P", change: "pending_attention", productType: "footwear", expect: { attention: true, flags: ["different_product"] as never[], detector: "judge" as const }, planted: { n: 2, from: "FC_1" } }];
    const canned = checkAttention({ products, outputs, deterministicPass: new Set(["A|noon|2"]), liveJudge: false, threshold: 75 });
    expect(canned.results.find(r => r.id === "attention.planted_caught")?.status).toBe("not_run");
    expect(failed(canned.results)).not.toContain("attention.judge_false_positive");
    const live = checkAttention({ products, outputs, deterministicPass: new Set(["A|noon|2"]), liveJudge: true, threshold: 75 });
    expect(failed(live.results)).toEqual(expect.arrayContaining(["attention.judge_false_positive", "attention.judge_false_same_product"]));
    expect(live.plantedCaught).toBe(1);
    expect(live.results.find(r => r.id === "attention.planted_rate")?.ok).toBe(true);
    const missed = checkAttention({ products, outputs: outputs.map(o => o.identifier === "P" ? row("P", o.n, "noon") : o), deterministicPass: new Set(), liveJudge: true, threshold: 75 });
    expect(missed.results.find(r => r.id === "attention.planted_rate")?.ok).toBe(false);
  });
  it("requires photo-level flags on every channel, placement from code only, a product type, and no synthesised shadow on models", () => {
    const outputs = [row("A", 1, "noon", { status: "needs_attention", flags: ["halo"] }), row("A", 1, "centrepoint"), row("A", 1, "styli", { flags: ["placement"], compliance: { ok: true, failures: [] } }), row("M", 1, "noon", { flags: ["shadow_synthesised"] })];
    const out = checkAttention({ products: [{ identifier: "A", change: "pending_attention", productType: "auto", expect: NONE }, { identifier: "M", change: "new", productType: "apparel_model", expect: NONE }], outputs, deterministicPass: new Set(), liveJudge: false, threshold: 75 });
    expect(failed(out.results)).toEqual(expect.arrayContaining(["attention.channel_consistent", "attention.channel_consistency", "attention.placement_not_judged", "attention.product_type_set", "shadow.synthesised_on_model"]));
  });
  it("builds one flag row per flag with its dimension, score, model and action", () => {
    const rows = flagRows([row("A", 2, "noon", { status: "needs_attention", flags: ["halo", "low_resolution"], reason: "rough edge", qaScores: { edge_quality: 40 }, qaModel: "m", decision: "use_as_is" })], 75);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ flag: "halo", dimension: "edge_quality", score: 40, threshold: 75, model: "m", action: "held for a decision", humanLabel: "use_as_is", evidence: "rough edge" });
    expect(rows[1]).toMatchObject({ flag: "low_resolution", dimension: null, model: null });
  });
});

describe("overwrite", () => {
  const live = (identifier: string, n: number, channel: ChannelId, generation: number): LiveRow => ({ identifier, n, channel, publicUrl: `https://x/${identifier}/${channel}/${n}.jpg`, objectPath: `${identifier}/${channel}/${n}.jpg`, generation });
  const channels: ChannelId[] = ["noon", "amazon"];
  const before = [live("A", 1, "noon", 1), live("A", 1, "amazon", 2), live("A", 2, "noon", 3), live("A", 2, "amazon", 4), live("B", 1, "noon", 5), live("B", 1, "amazon", 6)];
  const base = () => ({ before, selected: ["noon"] as ChannelId[], altered: { identifier: "A", n: 1 }, removed: { identifier: "A", n: 2 }, changes: new Map([["A", "shots_removed"], ["B", "unchanged"]]), events: [{ identifier: "A", kind: "overwritten" }, { identifier: "A", kind: "shots_removed" }], removedGone: new Map([["https://x/A/noon/2.jpg", true]]), report: { removedLinks: 1, notRefreshedChannels: ["amazon"] as ChannelId[] }, recheck: { ok: 5, total: 5 } });
  it("passes the contract when only the altered shot changes on the selected channel and the removed shot is gone there", () => {
    const after = [live("A", 1, "noon", 11), live("A", 1, "amazon", 2), live("A", 2, "amazon", 4), live("B", 1, "noon", 5), live("B", 1, "amazon", 6)];
    expect(failed(checkOverwrite({ ...base(), after }))).toEqual([]);
  });
  it("counts the removed shot's live rows before the delivery, not one per selected channel", () => {
    // Styli skipped the removed shot: it has no live row there, and the contract still holds.
    const after = [live("A", 1, "noon", 11), live("A", 1, "amazon", 2), live("A", 2, "amazon", 4), live("B", 1, "noon", 5), live("B", 1, "amazon", 6)];
    const results = checkOverwrite({ ...base(), after, selected: ["noon", "styli"] });
    expect(failed(results)).toEqual([]);
    expect(results.find(r => r.id === "overwrite.removed_not_live")?.measured).toBe("0 of 1");
  });
  it("fails on a rewritten untouched output, a stale altered one, a surviving removed link and a missing report entry", () => {
    const after = [live("A", 1, "noon", 1), live("A", 1, "amazon", 22), live("A", 2, "noon", 3), live("A", 2, "amazon", 4), live("B", 1, "noon", 5), live("B", 1, "amazon", 6)];
    const ids = failed(checkOverwrite({ ...base(), after, report: { removedLinks: 0, notRefreshedChannels: [] } }));
    expect(ids).toEqual(expect.arrayContaining(["overwrite.altered_new_generation", "overwrite.untouched_unchanged", "overwrite.removed_gone", "overwrite.removed_not_live", "overwrite.not_refreshed_listed", "overwrite.removed_links_reported"]));
  });
  it("judges an identical re-upload by generations, zero work and unchanged changes", () => {
    expect(failed(checkIdentical({ before, after: before, changes: new Map([["A", "unchanged"]]), work: { matte: 0, render: 0, copy: 0 }, events: [{ kind: "unchanged" }] }))).toEqual([]);
    expect(failed(checkIdentical({ before, after: before.slice(1), changes: new Map([["A", "updated"]]), work: { matte: 1, render: 0, copy: 0 }, events: [] }))).toEqual(["overwrite.identical_generations", "overwrite.identical_zero_work", "overwrite.identical_change"]);
  });
  void channels;
});

describe("matte bake-off", () => {
  const trial = (model: string, identifier: string, regionLoss: number, thin: number, fails = false): MatteTrial => ({ brand: "anta", category: "footwear", identifier, n: 1, model, target: "cpu", ms: model === "fast" ? 100 : 500, tags: identifier === "H" ? ["thin_straps"] : [], results: fails ? [{ id: "cutout.pixels_lost", group: "cutout", subject: { identifier, n: 1, channel: null }, ok: false, status: "fail", measured: regionLoss, threshold: 0.01, unit: "", detail: "" }] : [], metrics: { regionLoss, globalLoss: regionLoss / 3, thinLoss: thin, backgroundKept: 0, holes: 0, seeThrough: 0, edgeSoftness: 1 } });
  it("ranks models by failing sources, then the composite, then speed, and reports the margin", () => {
    const trials = [trial("good", "A", 0.001, 0.01), trial("good", "H", 0.002, 0.03), trial("fast", "A", 0.001, 0.01), trial("fast", "H", 0.002, 0.03), trial("weak", "A", 0.004, 0.2), trial("weak", "H", 0.03, 0.5, true)];
    const ranking = rankModels(scoreModels(trials));
    expect(ranking.map(r => r.model)).toEqual(["fast", "good", "weak"]);
    expect(ranking[2]!.failRate).toBe(0.5);
    expect(ranking[2]!.hardCaseFailRate).toBe(1);
    const winners = winnersByScope(trials);
    expect(winners.map(w => `${w.brand}/${w.category}`)).toEqual(["*/footwear", "anta/footwear"]);
    expect(winners[0]!.winner?.model).toBe("fast");
    expect(winners[0]!.margin).toBe(0);
    // The composite is unbounded: a model that drops 12% of the consensus product scores above 1 and its margin is real.
    const heavy = scoreModels([{ ...trial("heavy", "A", 0.002, 0.01), metrics: { ...trial("heavy", "A", 0.002, 0.01).metrics, consensusLoss: 0.12, consensusExtra: 0.02 } }]);
    expect(heavy[0]!.composite).toBeCloseTo(10 * 0.002 + 3 * 0.01 + 0.02 + 1.2 + 0.2, 4);
    expect(heavy[0]!.composite).toBeGreaterThan(1);
    const rows = policyRowsFor(winners, { batchIds: ["b1"], seen: { matte: [{ id: "fast", target: "cpu" }], judges: ["j"] }, existing: [{ brandSlug: "*", category: "footwear", qaModel: "prior-judge", threshold: 80, floor: 60, qaMode: "per_output", qaSampleRate: 1 }], minSources: 2 });
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.brandSlug === "*")).toMatchObject({ matteModel: "fast", qaModel: "prior-judge", threshold: 80, source: "bakeoff", evalBatchIds: ["b1"] });
    expect((rows[0]!.gates as unknown as { matteBakeoff: { winner: string } }).matteBakeoff.winner).toBe("fast");
    expect(policyRowsFor(winners, { batchIds: [], seen: { matte: [], judges: [] }, existing: [], minSources: 10 })).toHaveLength(0);
  });
});

describe("report", () => {
  it("summarises, groups and renders the failing images with their numbers", async () => {
    const results: CheckResult[] = [
      { id: "geometry.edges", group: "geometry", subject: { identifier: "A", n: 1, channel: "noon" }, ok: false, status: "fail", measured: 5, threshold: 0, unit: "px", detail: "5 edge pixels." },
      { id: "geometry.canvas", group: "geometry", subject: { identifier: "A", n: 1, channel: "noon" }, ok: true, status: "pass", measured: "1080x1480", threshold: "", unit: "px", detail: "ok" },
      { id: "cutout.fringe", group: "cutout", subject: { identifier: "A", n: 1, channel: "noon" }, ok: true, status: "not_run", measured: null, threshold: null, unit: "", detail: "n/a" },
      { id: "attention.not_held", group: "attention", subject: { identifier: "B", n: null, channel: null }, ok: false, status: "fail", measured: 1, threshold: 0, unit: "", detail: "Needs attention: image 1 for noon: halo" },
    ];
    const report = buildReport({ run: "r1", startedAt: new Date(0), finishedAt: new Date(1000), mode: "mocked judge", golden: { products: 2, photos: 2, brands: { anta: 2 }, categories: { footwear: 2 }, tags: {} }, results, attention: { attentionProducts: 1, attentionRate: 0.5, expectedAttention: 0, falseHoldRate: 0, useAsIsRate: null, plantedCaught: 0, plantedTotal: 0 }, flags: [], batches: ["b"] });
    expect(report.summary).toMatchObject({ checks: 3, passed: 1, failed: 2, notRun: 1, attentionProducts: 1, passedAll: false });
    expect(report.summary.line).toBe(summaryLine(1, 3, 1));
    expect(report.summary.line).toBe("Output-quality eval: 1 of 3 checks passed, 1 products need attention (target 0)");
    expect(report.byGroup.geometry).toEqual({ checks: 2, passed: 1, failed: 1, notRun: 0 });
    expect(report.attention).toEqual([{ identifier: "B", detail: "Needs attention: image 1 for noon: halo" }]);
    const html = await reportHtml(report, [{ identifier: "A", n: 1, channel: "noon", original: null, output: null }]);
    expect(html).toContain("geometry.edges");
    expect(html).toContain("5 edge pixels.");
    expect(html).toContain("Attention rate 50.00%");
    expect(html).not.toContain("gemini");
  });
});
