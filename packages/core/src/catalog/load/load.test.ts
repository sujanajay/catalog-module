import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { parseShotName } from "../naming";
import { classifyOutputs } from "./classify";
import { FAULT_SCENARIOS, parseFaultRules, pickFault, type FaultRule } from "./fault-rules";
import { groupSourceFiles, loadIdentifier, replicateOptions, zipGroups } from "./replicate";
import { alterOnePixelRow, planReupload, reuploadSampleSize } from "./reupload";
import { againstTarget, perMinute, percentile, stageWindows } from "./timing";

const files = ["ABC123_1.jpg", "ABC123_2.jpg", "ABC123_3.jpg", "X_9_1.JPG", "X_9_2.jpg", "X_9_3.jpg", "X_9_4.jpg", "X_9_5.jpg", "X_9_6.jpg", "SHORT_1.jpg", "SHORT_2.jpg"].map(name => ({ name, item: name }));

describe("replication", () => {
  it("names replicas LT<k>_<identifier> and keeps _<n> parseable through parseShotName", () => {
    expect(loadIdentifier(3, "ABC123")).toBe("LT3_ABC123");
    const options = replicateOptions(groupSourceFiles(files), 5);
    expect(options.map(o => o.identifier)).toEqual(["LT1_ABC123", "LT1_X_9", "LT2_ABC123", "LT2_X_9", "LT3_ABC123"]);
    for (const o of options) for (const s of o.shots) {
      const parsed = parseShotName(s.name);
      expect(parsed.identifier).toBe(o.identifier);
      expect(parsed.n).toBe(s.n);
    }
    expect(options[1]!.shots).toHaveLength(5);
    expect(options[1]!.shots[0]!.name).toBe("LT1_X_9_1.jpg");
  });
  it("never splits one option over two zips", () => {
    const groups = zipGroups(replicateOptions(groupSourceFiles(files), 4), 7);
    expect(groups.map(g => g.map(o => o.identifier))).toEqual([["LT1_ABC123"], ["LT1_X_9"], ["LT2_ABC123"], ["LT2_X_9"]]);
  });
});

describe("re-upload builder", () => {
  it("alters exactly one photo and drops exactly one shot per sampled product", () => {
    const options = replicateOptions(groupSourceFiles(files), 20);
    const plan = planReupload(options, reuploadSampleSize(270));
    expect(plan.options).toHaveLength(20);
    for (const o of plan.options) {
      const source = options.find(x => x.identifier === o.identifier)!;
      expect(o.shots.filter(s => s.alter)).toHaveLength(1);
      expect(o.shots).toHaveLength(source.shots.length - 1);
      expect(o.shots.map(s => s.n)).not.toContain(source.shots.at(-1)!.n);
    }
    expect(plan.altered).toHaveLength(plan.options.length);
    expect(plan.dropped).toHaveLength(plan.options.length);
  });
  it("changes the photo's sha256 and keeps its size", async () => {
    const photo = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    const altered = await alterOnePixelRow(photo);
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(sha(altered)).not.toBe(sha(photo));
    expect(await sharp(altered).metadata()).toMatchObject({ width: 40, height: 30, format: "jpeg" });
  });
});

describe("timing math", () => {
  it("percentiles, stage windows, throughput and the 2-hour target", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    const t = (m: number) => new Date(Date.UTC(2026, 9, 19, 10, m));
    const windows = stageWindows([
      { at: t(1), chunks: [{ id: "a", stage: "matte", status: "running", startedAt: t(0) }] },
      { at: t(5), chunks: [{ id: "a", stage: "render", status: "running", startedAt: t(4) }] },
      { at: t(9), chunks: [{ id: "a", stage: "render", status: "done", startedAt: t(4), finishedAt: t(8) }] },
    ]);
    expect(windows.matte).toEqual({ startAt: t(0), endAt: t(1), ms: 60_000 });
    expect(windows.render?.ms).toBe(4 * 60_000);
    expect(perMinute(30, 10 * 60_000)).toBe(3);
    expect(againstTarget(t(0), t(119))).toEqual({ ms: 119 * 60_000, withinTarget: true });
    expect(againstTarget(t(0), new Date(t(0).getTime() + 121 * 60_000)).withinTarget).toBe(false);
  });
  it("classifies every output and lists the silent ones", () => {
    const base = { channel: "noon", n: 1, productId: "p" };
    const c = classifyOutputs([
      { ...base, id: "1", status: "verified", reason: null },
      { ...base, id: "2", status: "failed", reason: "Uploaded file could not be read back from the public link" },
      { ...base, id: "3", status: "failed", reason: null },
      { ...base, id: "4", status: "staged", reason: null },
    ]);
    expect(c.byStatus).toEqual({ verified: 1, failed: 2, staged: 1 });
    expect(c.failed.map(f => f.id)).toEqual(["2"]);
    expect(c.silent.map(s => s.id)).toEqual(["3", "4"]);
  });
});

describe("fault proxy rules", () => {
  const post = { method: "POST", path: "/matte?model=x" };
  it("matches on method and path", () => {
    const rules = FAULT_SCENARIOS.matting_down!;
    expect(pickFault(rules, post, new Map())?.action.status).toBe(503);
    expect(pickFault(rules, { method: "GET", path: "/matte" }, new Map())).toBeNull();
    expect(pickFault(rules, { method: "POST", path: "/health" }, new Map())).toBeNull();
  });
  it("fires every n-th call, for a share of calls, and only up to a limit", () => {
    const counters = new Map();
    const every: FaultRule[] = [{ name: "e", path: "^/matte", every: 3, action: { delayMs: 1 } }];
    expect([1, 2, 3, 4, 5, 6].map(() => pickFault(every, post, counters) !== null)).toEqual([false, false, true, false, false, true]);
    const ratio: FaultRule[] = [{ name: "r", path: ".*", ratio: 0.1, action: { status: 503 } }];
    expect(pickFault(ratio, post, new Map(), () => 0.05)).not.toBeNull();
    expect(pickFault(ratio, post, new Map(), () => 0.5)).toBeNull();
    const limited = new Map();
    const limit: FaultRule[] = [{ name: "l", path: ".*", limit: 2, action: { status: 503 } }];
    expect([1, 2, 3].map(() => pickFault(limit, post, limited) !== null)).toEqual([true, true, false]);
  });
  it("parses a rules file and refuses a rule without an action", () => {
    expect(parseFaultRules([{ path: "^/x", action: { status: 500 } }])[0]!.name).toBe("rule_1");
    expect(() => parseFaultRules([{ path: "^/x" }])).toThrow(/action/);
  });
});
