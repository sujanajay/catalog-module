import { describe, expect, it } from "vitest";
import { checkAttention, flagRows } from "./attention";
import { CHART_SKIP_NOTE, checkCompleteness, STYLI_SKIP_NOTE, type CompletenessInput, type OutputRow } from "./completeness";
import { checkIdentical, checkOverwrite, type LiveRow } from "./overwrite";
import { buildReport, reportHtml, summaryLine } from "./report";
import { bakeoffPolicy, policyRowsFor, rankModels, scoreModels, winnersByScope, type MatteTrial } from "./matte-bakeoff";
import { samplePath, selectSets, type SetRecord } from "./progress";
import type { CheckResult, Expectation } from "./types";
import type { ChannelId } from "../types";

const failed = (results: CheckResult[]) => results.filter(r => r.status === "fail").map(r => r.id);
const NONE: Expectation = { attention: false, flags: [], detector: "code" };

function completenessWorld() {
  const channels: ChannelId[] = ["noon", "styli", "amazon"];
  const sources = [{ identifier: "A", n: 1, width: 800, height: 800 }, { identifier: "A", n: 2, width: 800, height: 800 }, { identifier: "A", n: 3, width: 2000, height: 3000 }];
  const outputs: OutputRow[] = [], publicHeads = new Map(), stagingHeads = new Map(), sheet: CompletenessInput["sheet"] = [];
  for (const s of sources) for (const ch of channels) {
    const url = `https://x/${s.identifier}/${ch}/${s.identifier}_${s.n}.jpg`;
    outputs.push({ identifier: s.identifier, n: s.n, channel: ch, status: "verified", isLive: true, reason: null, generation: 7, bytes: 100, crc32c: "c", publicUrl: url, stagingUri: `gs://a/${ch}/${s.n}` });
    publicHeads.set(url, { exists: true, size: 100, generation: "7", contentType: "image/jpeg" }); stagingHeads.set(`gs://a/${ch}/${s.n}`, { exists: true, size: 100, generation: "1", contentType: "image/jpeg" });
    sheet.push({ identifier: s.identifier, channel: ch, n: s.n, url });
  }
  const input: CompletenessInput = { channels, sources, outputs, publicHeads, stagingHeads, sheet, sheetNotes: new Map([["A", ""]]), counts: { outputs: 9, verified: 9, skipped: 0, recheckOk: 9, recheckTotal: 9 } };
  return input;
}

describe("completeness", () => {
  it("expects one live output per source and channel, Styli included for 800 px photos, and every Amazon shot", () => {
    const results = checkCompleteness(completenessWorld());
    expect(failed(results)).toEqual([]);
    expect(results.filter(r => r.id === "completeness.amazon_shot")).toHaveLength(3);
    expect(results.filter(r => r.id === "completeness.live" && r.subject.channel === "styli")).toHaveLength(3);
  });
  it("fails a Styli skip for the photo's size: no channel has an enlargement cap (owner decision 2026-10-22)", () => {
    const w = completenessWorld(), styli = w.outputs.find(o => o.channel === "styli" && o.n === 1)!;
    Object.assign(styli, { status: "skipped", isLive: false, reason: STYLI_SKIP_NOTE, generation: null, bytes: null, crc32c: null });
    w.sheet.find(c => c.channel === "styli" && c.n === 1)!.url = null;
    w.sheetNotes.set("A", `Styli img 1: ${STYLI_SKIP_NOTE}`);
    Object.assign(w.counts, { verified: 8, skipped: 1, recheckOk: 8, recheckTotal: 8 });
    const ids = failed(checkCompleteness(w));
    expect(ids).toContain("completeness.skip_allowed");
    expect(ids).toContain("completeness.counts_verified");
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
    w.sheet.find(c => c.channel === "noon" && c.n === 1)!.url = null;
    const ids = failed(checkCompleteness(w));
    expect(ids).toContain("completeness.skip_allowed");
    expect(ids).toContain("completeness.sheet_cell");
  });
  it("does not require an expected hold to be live or linked, and excludes it from the counts", () => {
    const w = completenessWorld();
    for (const o of w.outputs.filter(row => row.n === 3)) Object.assign(o, { status: "needs_attention", isLive: false, generation: null, bytes: null, crc32c: null });
    for (const cell of w.sheet.filter(c => c.n === 3)) cell.url = null;
    // A hold is per product: the siblings of the expected hold are staged as well, and every shot leaves the counts.
    for (const o of w.outputs.filter(row => row.n !== 3)) Object.assign(o, { status: "staged", isLive: false, generation: null, bytes: null, crc32c: null });
    for (const cell of w.sheet) cell.url = null;
    Object.assign(w.counts, { verified: 0, skipped: 0, recheckOk: 0, recheckTotal: 0 });
    w.heldExpected = new Set(["A|3"]);
    const results = checkCompleteness(w);
    expect(failed(results)).toEqual([]);
    // Every row of the product is held, Styli included (no Styli size skips): 9 holds.
    expect(results.filter(r => r.id === "completeness.held_unpublished")).toHaveLength(9);
    expect(results.some(r => r.id === "completeness.live")).toBe(false);
    expect(results.find(r => r.id === "completeness.held_unpublished" && r.subject.n === 1)?.detail).toContain("a sibling of the expected hold on image 3");
    expect(results.find(r => r.id === "completeness.held_unpublished" && r.subject.n === 3)?.detail).toContain("(expected hold)");
    // Published after all: the hold is reported here as well as by attention.expected.
    w.outputs.find(o => o.n === 3 && o.channel === "noon")!.isLive = true;
    expect(failed(checkCompleteness(w))).toEqual(["completeness.held_unpublished"]);
  });
  it("expects the siblings of an expected hold staged, not live (eval run 3: ZEE79259BBFD83FFA1DB0Z n=1/2/3/4/6 beside the held n=5)", () => {
    const w = completenessWorld();
    // Product B: two shots, the manifest expects n=2 held; the pipeline stages n=1 as well.
    for (const n of [1, 2]) {
      w.sources.push({ identifier: "B", n, width: 2000, height: 3000 });
      for (const ch of w.channels) { w.outputs.push({ identifier: "B", n, channel: ch, status: n === 2 ? "needs_attention" : "staged", isLive: false, reason: null, generation: null, bytes: null, crc32c: null, publicUrl: `https://x/B/${ch}/B_${n}.jpg`, stagingUri: `gs://a/B/${ch}/${n}` }); w.sheet.push({ identifier: "B", channel: ch, n, url: null }); }
    }
    w.counts.outputs = 15;
    w.heldExpected = new Set(["B|2"]);
    const results = checkCompleteness(w);
    expect(failed(results)).toEqual([]);
    expect(results.filter(r => r.id === "completeness.held_unpublished" && r.subject.identifier === "B")).toHaveLength(6);
    expect(results.some(r => r.id === "completeness.live" && r.subject.identifier === "B")).toBe(false);
    expect(results.find(r => r.id === "completeness.counts_verified")?.threshold).toBe("9 verified, 0 skipped");
    // A sibling that went live while its product is held is a fault, as the held shot itself would be.
    const live = w.outputs.find(o => o.identifier === "B" && o.n === 1 && o.channel === "noon")!;
    Object.assign(live, { status: "verified", isLive: true, generation: 7, bytes: 100, crc32c: "c" });
    expect(failed(checkCompleteness(w))).toEqual(["completeness.held_unpublished"]);
  });
  it("reports a product held as a whole once (completeness.product_held) and leaves its outputs out of the counts (eval run 3: the FC bag's three false holds produced 210 completeness rows for one defect)", () => {
    const w = completenessWorld();
    // Product B: n=1 held on every channel, n=2 staged with it, nothing live, no links.
    for (const n of [1, 2]) {
      w.sources.push({ identifier: "B", n, width: 2000, height: 3000 });
      for (const ch of w.channels) { w.outputs.push({ identifier: "B", n, channel: ch, status: n === 1 ? "needs_attention" : "staged", isLive: false, reason: n === 1 ? "halo" : null, generation: null, bytes: null, crc32c: null, publicUrl: `https://x/B/${ch}/B_${n}.jpg`, stagingUri: `gs://a/B/${ch}/${n}` }); w.sheet.push({ identifier: "B", channel: ch, n, url: null }); }
    }
    w.counts.outputs = 15;
    const results = checkCompleteness(w);
    expect(failed(results)).toEqual(["completeness.product_held"]);
    const row = results.find(r => r.id === "completeness.product_held")!;
    expect(row.subject).toEqual({ identifier: "B", n: null, channel: null });
    expect(row.measured).toBe("0 of 6 live: product held");
    expect(row.detail).toContain("image 1");
    expect(results.some(r => r.id === "completeness.live" && r.subject.identifier === "B")).toBe(false);
    expect(results.filter(r => r.id === "completeness.one_output" && r.subject.identifier === "B")).toHaveLength(6);
    expect(results.find(r => r.id === "completeness.counts_verified")?.ok).toBe(true);
    // Partly published: one shot live while another is held is not a product-level hold, every output is judged on its own.
    const live = w.outputs.find(o => o.identifier === "B" && o.n === 2 && o.channel === "noon")!;
    Object.assign(live, { status: "verified", isLive: true, generation: 7, bytes: 100, crc32c: "c" });
    const partial = checkCompleteness(w);
    expect(failed(partial)).not.toContain("completeness.product_held");
    expect(failed(partial)).toContain("completeness.live");
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
  it("asserts a judge-only flag on a code-detected expectation only on a live run (the candle Z011CB57531CA8FA0CBDDZ n=1: leftover_background by code, text_or_watermark by the judge)", () => {
    const expect_: Expectation = { attention: true, flags: ["leftover_background", "text_or_watermark"], detector: "code" };
    const outputs = [row("K", 1, "noon", { status: "needs_attention", flags: ["leftover_background", "cut_in_source"] }), row("K", 1, "amazon", { status: "needs_attention", flags: ["leftover_background", "cut_in_source"] })];
    const mocked = checkAttention({ products: [{ identifier: "K", change: "pending_attention", productType: "other", expect: expect_ }], outputs, deterministicPass: new Set(), liveJudge: false, threshold: 75 });
    expect(mocked.results.find(r => r.id === "attention.expected")?.ok).toBe(true);
    const live = checkAttention({ products: [{ identifier: "K", change: "pending_attention", productType: "other", expect: expect_ }], outputs, deterministicPass: new Set(), liveJudge: true, threshold: 75 });
    expect(live.results.find(r => r.id === "attention.expected")?.detail).toContain("missing: text_or_watermark");
    // The code-detected flag is still required on a mocked run, and a judge flag raised there is not unexpected.
    const none = checkAttention({ products: [{ identifier: "K", change: "pending_attention", productType: "other", expect: expect_ }], outputs: [row("K", 1, "noon", { status: "needs_attention", flags: ["halo"] })], deterministicPass: new Set(), liveJudge: false, threshold: 75 });
    expect(none.results.find(r => r.id === "attention.expected")?.detail).toContain("missing: leftover_background");
  });
  it("treats cut_in_source and numbering_gap as information on an expected hold (the 450 px copy of a cut photo)", () => {
    const flags = ["small_source", "cut_in_source", "numbering_gap", "low_resolution", "no_shadow_source"] as never[];
    const outputs = [row("C", 1, "noon", { status: "needs_attention", flags }), row("C", 1, "amazon", { status: "needs_attention", flags })];
    const out = checkAttention({ products: [{ identifier: "C", change: "pending_attention", productType: "apparel_model", expect: { attention: true, flags: ["small_source"], detector: "code" } }], outputs, deterministicPass: new Set(), liveJudge: false, threshold: 75 });
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
  it("requires a per-shot expected flag without a hold on that shot and nothing published (the size chart Z659062EFB3FB0720BF56Z n=7, batch n=6, published on every channel as a pass-through)", () => {
    const shots = [{ identifier: "C", n: 6, expect: { attention: false, flags: ["chart_image"] as never[], detector: "code" as const, reason: "a size chart" } }];
    const products = [{ identifier: "C", change: "new", productType: "apparel_model", expect: NONE }];
    const leftOut = checkAttention({ products, outputs: [row("C", 6, "noon", { status: "skipped", flags: ["chart_image"] }), row("C", 6, "amazon", { status: "skipped", flags: ["chart_image"] }), row("C", 6, "styli", { status: "skipped", flags: ["low_resolution"] })], shots, deterministicPass: new Set(), liveJudge: false, threshold: 75 });
    expect(leftOut.results.find(r => r.id === "attention.expected_flags")?.ok).toBe(true);
    const published = checkAttention({ products, outputs: [row("C", 6, "noon", { flags: ["matte_passthrough"] }), row("C", 6, "amazon", { flags: ["matte_passthrough"] })], shots, deterministicPass: new Set(), liveJudge: false, threshold: 75 });
    const miss = published.results.find(r => r.id === "attention.expected_flags");
    expect(miss?.ok).toBe(false);
    expect(miss?.subject).toEqual({ identifier: "C", n: 6, channel: null });
    expect(miss?.detail).toContain("missing on image 6: chart_image (2 outputs published instead of left out). a size chart");
    // The flag raised but the outputs still published is a failure too; a judge-only flag is not required on a mocked run.
    const flagged = checkAttention({ products, outputs: [row("C", 6, "noon", { flags: ["chart_image"] })], shots, deterministicPass: new Set(), liveJudge: false, threshold: 75 });
    expect(flagged.results.find(r => r.id === "attention.expected_flags")?.detail).toContain("1 outputs were published instead of left out");
    const judgeOnly = checkAttention({ products, outputs: [row("C", 6, "noon")], shots: [{ identifier: "C", n: 6, expect: { attention: false, flags: ["text_or_watermark"] as never[], detector: "judge" } }], deterministicPass: new Set(), liveJudge: false, threshold: 75 });
    expect(judgeOnly.results.some(r => r.id === "attention.expected_flags")).toBe(false);
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
    expect(report.summary).toMatchObject({ checks: 3, passed: 1, failed: 2, notRun: 1, information: 0, attentionProducts: 1, passedAll: false });
    expect(report.summary.line).toBe(summaryLine(1, 3, 1));
    expect(report.summary.line).toBe("Output-quality eval: 1 of 3 checks passed, 1 products need attention (target 0)");
    expect(report.byGroup.geometry).toEqual({ checks: 2, passed: 1, failed: 1, notRun: 0, information: 0 });
    expect(report.attention).toEqual([{ identifier: "B", detail: "Needs attention: image 1 for noon: halo" }]);
    const html = await reportHtml(report, [{ identifier: "A", n: 1, channel: "noon", original: null, output: null }]);
    expect(html).toContain("geometry.edges");
    expect(html).toContain("5 edge pixels.");
    expect(html).toContain("Attention rate 50.00%");
    expect(html).not.toContain("gemini");
  });
  it("lists an information row (shadow.expected_synthesis) on its own, never as a pass, a failure or a not-run", async () => {
    const info: CheckResult = { id: "shadow.expected_synthesis", group: "shadow", subject: { identifier: "A", n: 1, channel: "noon" }, ok: true, status: "info", measured: "none drawn; 900x400 box, contact line 92%", threshold: "synthesised", unit: "shadow", detail: "OPEN owner question." };
    const report = buildReport({ run: "r2", startedAt: new Date(0), finishedAt: new Date(1000), mode: "mocked judge", golden: { products: 1, photos: 1, brands: {}, categories: {}, tags: {} }, results: [info], attention: { attentionProducts: 0, attentionRate: 0, expectedAttention: 0, falseHoldRate: null, useAsIsRate: null, plantedCaught: 0, plantedTotal: 0 }, flags: [], batches: [] });
    expect(report.summary).toMatchObject({ checks: 0, passed: 0, failed: 0, notRun: 0, information: 1, passedAll: true });
    expect(report.byGroup.shadow).toEqual({ checks: 1, passed: 0, failed: 0, notRun: 0, information: 1 });
    expect(report.information).toEqual([info]);
    const html = await reportHtml(report, []);
    expect(html).toContain("Recorded as information: 1");
    expect(html).toContain("contact line 92%");
  });
});

describe("live run calibration 3 (session 5)", () => {
  const row = (identifier: string, n: number, channel: ChannelId, extra: Partial<Parameters<typeof checkAttention>[0]["outputs"][number]> = {}) => ({ identifier, n, channel, status: "verified", flags: [] as never[], reason: null, qaScores: null, ...extra });
  it("counts a judging without a verdict (qa_unavailable, qa_cap) under judge_unavailable, never as a judge false positive", () => {
    const zeroed = { verdict: "flag", complete_product: 0, same_product: 100, edge_quality: 0, reasons: ["The quality check could not read this image."] };
    const outputs = [row("A", 1, "noon", { status: "needs_attention", flags: ["qa_unavailable"], reason: "The quality check could not read this image.", qaScores: zeroed }), row("A", 1, "amazon", { status: "needs_attention", flags: ["qa_unavailable"], qaScores: zeroed }), row("B", 1, "noon", { status: "needs_attention", flags: ["qa_cap"], qaScores: zeroed })];
    const out = checkAttention({ products: [{ identifier: "A", change: "pending_attention", productType: "apparel_model", expect: NONE }, { identifier: "B", change: "pending_attention", productType: "apparel_model", expect: NONE }], outputs, deterministicPass: new Set(["A|noon|1", "A|amazon|1", "B|noon|1"]), liveJudge: true, threshold: 75 });
    expect(failed(out.results)).not.toContain("attention.judge_false_positive");
    const unavailable = out.results.filter(r => r.id === "attention.judge_unavailable");
    expect(unavailable).toHaveLength(3);
    expect(unavailable.every(r => r.status === "fail")).toBe(true);
    expect(unavailable[0]!.detail).toContain("held without one");
    expect(unavailable[2]!.measured).toBe("qa_cap");
    // The hold is still counted: not_held per product and the false-hold rate.
    expect(failed(out.results).filter(id => id === "attention.not_held")).toHaveLength(2);
    expect(out.falseHoldRate).toBe(1);
  });
  it("passes a complete_product note on a source cut at the frame (cut_in_source) and keeps failing it on an uncut source or when it held the output", () => {
    const note = { verdict: "flag", complete_product: 55, same_product: 100, edge_quality: 100, background_clean: 100, no_text_or_watermark: 100, orientation_ok: 100, product_intact: 100, reasons: ["The skirt runs off the bottom edge of the photo."] };
    const outputs = [row("A", 2, "noon", { flags: ["complete_product", "cut_in_source"], qaScores: note }), row("A", 3, "noon", { flags: ["complete_product"], qaScores: note }), row("A", 4, "noon", { status: "needs_attention", flags: ["complete_product", "cut_in_source"], qaScores: note })];
    const out = checkAttention({ products: [{ identifier: "A", change: "pending_attention", productType: "apparel_model", expect: NONE }], outputs, deterministicPass: new Set(["A|noon|2", "A|noon|3", "A|noon|4"]), liveJudge: true, threshold: 75 });
    const rows = out.results.filter(r => r.id === "attention.judge_false_positive");
    expect(rows.map(r => [r.subject.n, r.status])).toEqual([[2, "pass"], [3, "fail"], [4, "fail"]]);
    expect(rows[0]!.detail).toContain("true of the original photo");
  });
  it("asserts a per-shot hold expectation on that shot's own rows, held or staged under a sibling's hold, on a live run (the candle Z011CB57531CA8FA0CBDDZ: shot 1 holds, shots 2 to 6 expect nothing)", () => {
    const shots = [{ identifier: "K", n: 1, expect: { attention: true, flags: ["leftover_background", "text_or_watermark"] as never[], detector: "code" as const } }, { identifier: "K", n: 2, expect: { attention: true, flags: ["text_or_watermark"] as never[], detector: "judge" as const, reason: "a wrong manifest line" } }];
    const outputs = [row("K", 1, "noon", { status: "needs_attention", flags: ["leftover_background", "text_or_watermark", "cut_in_source"] }), row("K", 2, "noon", { status: "staged", flags: ["no_shadow_source"] })];
    const products = [{ identifier: "K", change: "pending_attention", productType: "other", expect: shots[0]!.expect }];
    const live = checkAttention({ products, outputs, shots, deterministicPass: new Set(), liveJudge: true, threshold: 75 });
    const rows = live.results.filter(r => r.id === "attention.expected_flags");
    expect(rows.map(r => [r.subject.n, r.status])).toEqual([[1, "pass"], [2, "fail"]]);
    expect(rows[1]!.detail).toContain("missing on image 2: text_or_watermark");
    expect(rows[1]!.detail).toContain("a wrong manifest line");
    expect(live.results.find(r => r.id === "attention.expected")?.ok).toBe(true);
    // On a mocked run the judge-only expectation of shot 2 is not asserted and shot 1's code flag still is.
    const mocked = checkAttention({ products, outputs, shots, deterministicPass: new Set(), liveJudge: false, threshold: 75 });
    expect(mocked.results.filter(r => r.id === "attention.expected_flags").map(r => [r.subject.n, r.status])).toEqual([[1, "pass"]]);
  });
  it("fails a chart leave-out of a shot the manifest does not expect to be a chart, and accepts the expected one", () => {
    const w = completenessWorld();
    for (const o of w.outputs.filter(o => o.n === 3)) Object.assign(o, { status: "skipped", isLive: false, reason: CHART_SKIP_NOTE, generation: null, bytes: null, crc32c: null, stagingUri: null });
    for (const cell of w.sheet.filter(c => c.n === 3)) cell.url = null;
    w.sheetNotes.set("A", `${w.sheetNotes.get("A")}; photo 3: ${CHART_SKIP_NOTE}`);
    Object.assign(w.counts, { verified: 4, skipped: 5, recheckOk: 4, recheckTotal: 4 });
    expect(failed(checkCompleteness({ ...w, chartExpected: new Set(["A|3"]) }))).toEqual([]);
    const unexpected = checkCompleteness({ ...w, chartExpected: new Set() });
    expect(unexpected.filter(r => r.id === "completeness.skip_allowed" && !r.ok)).toHaveLength(3);
    expect(unexpected.find(r => r.id === "completeness.skip_allowed" && !r.ok)?.detail).toContain("Left out as a size chart without an expectation");
    expect(unexpected.find(r => r.id === "completeness.counts_verified")?.ok).toBe(true);
  });
  it("writes the bake-off runner-up as the second matte model and re-plans the rows from a run's set records without re-running a set", () => {
    const trial = (model: string, identifier: string, regionLoss: number, fails = false): MatteTrial => ({ brand: "vero_moda", category: "apparel_model", identifier, n: 1, model, target: "gpu", ms: 500, tags: [], results: fails ? [{ id: "cutout.pixels_lost", group: "cutout", subject: { identifier, n: 1, channel: null }, ok: false, status: "fail", measured: regionLoss, threshold: 0.01, unit: "", detail: "" }] : [], metrics: { regionLoss, globalLoss: 0, thinLoss: 0, backgroundKept: 0, holes: 0, seeThrough: 0, edgeSoftness: 3.6 } });
    const trials = ["A", "B", "C"].flatMap(id => [trial("bria-rmbg", id, 0.001), trial("birefnet-general", id, 0.002, id === "C"), trial("birefnet-general-lite", id, 0.01, id !== "A")]);
    const done = (set: string, extra: Partial<SetRecord>): SetRecord => ({ set, brand: "vero_moda", category: "apparel_model", status: "done", error: null, startedAt: "2026-10-21T06:48:28.000Z", finishedAt: "2026-10-21T08:51:06.000Z", photos: 3, products: 3, results: [], thumbs: [], deterministicPass: [], attentionRows: [], attentionProducts: [], trials: [], overwriteRan: false, batches: ["b1"], ...extra });
    const records = new Map([["vero_moda.apparel_model", done("vero_moda.apparel_model", { trials })]]);
    // A resume of the completed run: every set is skipped and the policy step runs from the records alone.
    expect(selectSets(["vero_moda.apparel_model"], records)).toEqual({ run: [], skipped: ["vero_moda.apparel_model"] });
    const { winners, rows } = bakeoffPolicy([...records.values()].flatMap(r => r.trials), { batchIds: [...records.values()].flatMap(r => r.batches), judges: ["judge-a"], existing: [{ brandSlug: "*", category: "apparel_model", qaModel: "prior-judge", threshold: 80, floor: 60, qaMode: "per_output", qaSampleRate: 1 }], minSources: 3 });
    expect(winners.find(w => w.brand === "*")?.ranking.map(m => m.model)).toEqual(["bria-rmbg", "birefnet-general", "birefnet-general-lite"]);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ matteModel: "bria-rmbg", matteModelSecond: "birefnet-general", source: "bakeoff", evalBatchIds: ["b1"] });
    expect(rows.find(r => r.brandSlug === "*")).toMatchObject({ qaModel: "prior-judge", threshold: 80 });
    expect((rows[0]!.gates as unknown as { candidates: { judges: string[] } }).candidates.judges).toEqual(["judge-a"]);
    expect(bakeoffPolicy([trial("bria-rmbg", "A", 0.001)], { batchIds: [], judges: [], existing: [], minSources: 1 }).rows[0]?.matteModelSecond).toBeNull();
  });
  it("renders the samples of an all-pass set on their own, apart from the failing images", async () => {
    const report = buildReport({ run: "r3", startedAt: new Date(0), finishedAt: new Date(1000), mode: "live judge", golden: { products: 1, photos: 1, brands: {}, categories: {}, tags: {} }, results: [{ id: "geometry.edges", group: "geometry", subject: { identifier: "A", n: 1, channel: "noon" }, ok: true, status: "pass", measured: 0, threshold: 0, unit: "px", detail: "ok" }], attention: { attentionProducts: 0, attentionRate: 0, expectedAttention: 0, falseHoldRate: null, useAsIsRate: null, plantedCaught: 0, plantedTotal: 0 }, flags: [], batches: [] });
    const html = await reportHtml(report, [{ identifier: "A", n: 1, channel: "noon", original: null, output: null, evidence: "catalog-test/evals/r3/evidence/vero_moda.bag_accessory/A__noon__1__sample.jpg", sample: true }]);
    expect(html).toContain("Samples of all-pass sets (1)");
    expect(html).toContain("A__noon__1__sample.jpg");
    expect(html).toContain("Failing images (0)");
    expect(samplePath("r3", "vero_moda.bag_accessory", "A", "noon", 1)).toBe("catalog-test/evals/r3/evidence/vero_moda.bag_accessory/A__noon__1__sample.jpg");
  });
});
