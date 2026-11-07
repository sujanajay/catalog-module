import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defectClass, JUDGE_EXAM_BARS, judgeExamLine, parseJudgeExamSet, scoreJudgeExam, type JudgeExamAnswer, type JudgeExamImage } from "./judge-exam";

const image = (id: string, expect: "defect" | "good", defect = "added mark stays"): JudgeExamImage => ({ id, expect, ...(expect === "defect" ? { defect } : {}), identifier: id, n: 1, channel: "noon", productType: "apparel_model", source: "s", sourceSha256: "a", output: "o", outputSha256: "b" });
const answer = (id: string, flags: string[], model: string | null = "m"): JudgeExamAnswer => ({ id, model, secondModel: null, flags, scores: {}, costUsd: 0.001 });
const bars = { minCaught: 2, maxFalseFlags: 1, maxUnanswered: 1, minPerClass: {} };
const images = [image("d1", "defect"), image("d2", "defect"), image("d3", "defect"), image("g1", "good"), image("g2", "good"), image("g3", "good")];

describe("the judge exam score", () => {
  it("passes a judge over its bars and names what it missed", () => {
    const score = scoreJudgeExam("m", images, [answer("d1", ["text_or_watermark"]), answer("d2", ["text_or_watermark"]), answer("d3", []), answer("g1", []), answer("g2", ["halo"]), answer("g3", [])], bars);
    expect(score).toMatchObject({ pass: true, caught: 2, defects: 3, falseFlags: 1, good: 3, unanswered: 0, missed: ["d3"], falselyFlagged: ["g2"] });
  });
  it("a judge that passes everything fails: its silence is not a catch", () => {
    const score = scoreJudgeExam("m", images, images.map(i => answer(i.id, [])), bars);
    expect(score.pass).toBe(false);
    expect(score.failures[0]).toContain("caught 0 of 3");
  });
  it("a judge that flags everything fails, which is what keeps people away from a real batch", () => {
    const score = scoreJudgeExam("m", images, images.map(i => answer(i.id, ["text_or_watermark"])), bars);
    expect(score.pass).toBe(false);
    expect(score.failures[0]).toContain("falsely flagged 3 of 3");
  });
  it("a note that holds nothing is neither a catch nor a false flag", () => {
    const score = scoreJudgeExam("m", images, images.map(i => answer(i.id, ["complete_product"])), bars);
    expect(score).toMatchObject({ caught: 0, falseFlags: 0 });
  });
  it("no answer is never a catch, and a fallback that answered instead proves nothing about the judge under exam", () => {
    const score = scoreJudgeExam("m", images, [answer("d1", ["qa_unavailable"]), answer("d2", ["text_or_watermark"], "other"), answer("d3", ["text_or_watermark"]), answer("g1", []), answer("g2", []), answer("g3", [])], bars);
    expect(score).toMatchObject({ caught: 1, unanswered: 2, pass: false, models: { m: 5, other: 1 } });
  });
  it("an image with no answer at all counts as no answer", () => {
    expect(scoreJudgeExam("m", images, [], bars).unanswered).toBe(6);
  });
  it("the line names the judge and the second opinion, with the numbers and the bars", () => {
    const score = scoreJudgeExam("the/judge", images, images.map(i => answer(i.id, [], "the/judge")), bars);
    expect(judgeExamLine("first judge", score, "the/second", bars)).toBe("JUDGE EXAM FAIL first judge the/judge (second opinion the/second): caught 0 of 3 (bar 2), falsely flagged 0 of 3 (bar 1), no answer 0 (bar 1), $0.01. By class: mark 0/3.");
  });
  it("a catch must fit the defect: a flag about something else on the image is a miss", () => {
    const score = scoreJudgeExam("m", [image("d1", "defect"), image("d2", "defect", "court and hedge")], [answer("d1", ["halo"]), answer("d2", ["text_or_watermark"])], bars);
    expect(score).toMatchObject({ caught: 0, missed: ["d1", "d2"] });
  });
  it("a judge blind to a whole class fails, however many others it catches", () => {
    const set = [image("m1", "defect"), image("m2", "defect"), image("m3", "defect"), image("l1", "defect", "court and hedge")];
    const score = scoreJudgeExam("m", set, set.map(i => answer(i.id, i.id.startsWith("m") ? ["text_or_watermark"] : [])), { ...bars, minPerClass: { leftover: 1 } });
    expect(score).toMatchObject({ pass: false, caught: 3, classes: { mark: { caught: 3, of: 3 }, leftover: { caught: 0, of: 1 } } });
    expect(score.failures).toEqual(["caught 0 of 1 leftover defects, the bar is at least 1"]);
  });
});

describe("the committed exam set", () => {
  const set = parseJudgeExamSet(readFileSync(new URL("../../../test-fixtures/catalog/evals/judge-exam-set.json", import.meta.url), "utf8"));
  it("holds the known defects and the known-good images, each pinned, all under catalog-test/", () => {
    expect(set.prefix.startsWith("catalog-test/")).toBe(true);
    expect(set.images.filter(i => i.expect === "defect")).toHaveLength(25);
    expect(set.images.filter(i => i.expect === "good")).toHaveLength(155);
    expect(set.images.filter(i => defectClass(i.defect) === "wrong_item")).toHaveLength(7);
    for (const i of set.images.filter(x => x.n > 1)) expect(i.referenceSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const i of set.images) { expect(i.outputSha256).toMatch(/^[0-9a-f]{64}$/); expect(i.sourceSha256).toMatch(/^[0-9a-f]{64}$/); }
    for (const i of set.images.filter(x => x.expect === "defect")) expect(i.defect).toBeTruthy();
  });
  it("the bar can be met without the four faint floor patches, which no judge sees", () => {
    const seen = set.images.filter(i => i.expect === "defect" && i.defect !== "faint floor patch").length;
    expect(JUDGE_EXAM_BARS.minCaught).toBeLessThanOrEqual(seen);
  });
  it("refuses a set outside catalog-test/ and a repeated id", () => {
    expect(() => parseJudgeExamSet(JSON.stringify({ version: "x", prefix: "catalog/x", images: [image("a", "good")] }))).toThrow();
    expect(() => parseJudgeExamSet(JSON.stringify({ version: "x", prefix: "catalog-test/x", images: [image("a", "good"), image("a", "good")] }))).toThrow();
    expect(() => parseJudgeExamSet(JSON.stringify({ version: "x", prefix: "catalog-test/x", images: [{ ...image("a", "good"), n: 2 }] }))).toThrow(/must pin shot one/);
    expect(() => parseJudgeExamSet(JSON.stringify({ version: "x", prefix: "catalog-test/x", images: [image("a", "defect", "something new")] }))).toThrow(/no class/);
  });
});
