import { expect, test } from "vitest";
import { matteProofCommand, parsePhotoList, proofHolds, proofHtml, proofSummary, proofVerdict, PROOF_CONTROLS, PROOF_MARKED, PROOF_REAL, type ProofRow } from "./catalog-matte-proof";

const base = { agreed: false, busy: false, passthrough: false, flags: [] as string[], judged: true };

test("the proof covers the 19 false rejections and the controls the guard rightly caught", () => {
  expect(new Set(PROOF_REAL.map(([id, n]) => `${id}_${n}`)).size).toBe(19);
  expect(PROOF_REAL.map(([id, n]) => `${id}_${n}`)).toContain(PROOF_MARKED);
  expect(PROOF_CONTROLS.map(c => c.why)).toEqual(expect.arrayContaining(["ghost", "candle", "logo-only", "cut through the skin"]));
  expect(PROOF_CONTROLS.some(c => c.path.includes("ZEE79259BBFD83FFA1DB0Z"))).toBe(true);
});

test("a real photo passes only as a clean cut-out the judge has seen", () => {
  const real = { ...base, group: "real" as const, agreed: true };
  expect(proofVerdict(real).result).toBe("pass");
  expect(proofVerdict({ ...real, busy: true }).result).toBe("fail");
  expect(proofVerdict({ ...real, passthrough: true }).result).toBe("fail");
  expect(proofVerdict({ ...real, judged: false }).result).toBe("fail");
  expect(proofVerdict({ ...real, flags: ["product_removed"] })).toEqual({ result: "fail", note: "judge: product_removed" });
  expect(proofVerdict({ ...real, flags: ["qa_unavailable"] }).result).toBe("fail");
});

test("the marked photo passes when the mark is named, and a correct system does not fail the proof on it", () => {
  const marked = { ...base, group: "marked" as const, agreed: true };
  expect(proofVerdict({ ...marked, flags: ["text_or_watermark"] }).result).toBe("pass");
  expect(proofVerdict(marked)).toMatchObject({ result: "fail", note: "the mark was not named" });
  expect(proofVerdict({ ...marked, flags: ["halo"] }).result).toBe("fail");
});

test("a control must not agree; it is held, named by the judge, or left for a person to look at", () => {
  const control = { ...base, group: "control" as const };
  expect(proofVerdict({ ...control, agreed: true }).result).toBe("fail");
  expect(proofVerdict({ ...control, busy: true }).result).toBe("pass");
  expect(proofVerdict({ ...control, flags: ["leftover_background"] }).result).toBe("pass");
  expect(proofVerdict(control).result).toBe("look");
});

test("the backstop fails when the judge passes the agreed wrong cut, and when it was never shown one", () => {
  const backstop = { ...base, group: "backstop" as const, agreed: true };
  expect(proofVerdict({ ...backstop, flags: ["leftover_background"] }).result).toBe("pass");
  expect(proofVerdict(backstop).result).toBe("fail");
  expect(proofVerdict({ ...backstop, judged: false }).note).toContain("not tested");
});

test("one failure fails the proof, a look does not, and the verdict is the first line", () => {
  expect(proofSummary([{ photo: "a", result: "pass", note: "" }, { photo: "b", result: "look", note: "look at it" }])).toEqual({ pass: true, lines: ["PROOF PASS: 1 passed, 0 failed, 1 to look at, of 2.", "LOOK b: look at it"] });
  const failed = proofSummary([{ photo: "a", result: "pass", note: "" }, { photo: "c", result: "fail", note: "held" }]);
  expect(failed.pass).toBe(false);
  expect(failed.lines[0]).toMatch(/^PROOF FAIL/);
  expect(failed.lines).toContain("FAIL c: held");
  expect(proofSummary([]).pass).toBe(false);
  expect(proofSummary([{ photo: "a", result: "pass", note: "" }], "the judge reached $10").pass).toBe(false);
});

test("the page carries its images, leads with what failed, and escapes what it prints", () => {
  const row = (photo: string, result: ProofRow["result"]): ProofRow => ({ photo, group: "real", steps: [], model: "m", agreed: true, busy: false, passthrough: false, images: [{ channel: "noon", path: "p", thumb: "QUJD", verdict: "pass", flags: [], scores: {} }], result, note: "<why>" });
  const html = proofHtml("run", [row("good", "pass"), row("bad", "fail")], ["PROOF FAIL"]);
  expect(html).toContain("data:image/jpeg;base64,QUJD");
  expect(html.indexOf("FAIL bad")).toBeLessThan(html.indexOf("PASS good"));
  expect(html).toContain("&lt;why&gt;");
  expect(html).not.toContain("<why>");
});

test("proof refuses to run without LIVE_SMOKE=1, before touching anything", async () => {
  const before = process.env.LIVE_SMOKE, code = process.exitCode;
  delete process.env.LIVE_SMOKE;
  try {
    await matteProofCommand(null as never, {});
    expect(process.exitCode).toBe(2);
  } finally { process.exitCode = code; if (before !== undefined) process.env.LIVE_SMOKE = before; }
});

test("M1 D40: the verdict counts the photos that would be held or left out, real photos and controls apart", () => {
  const row = (group: ProofRow["group"], busy: boolean, flags: string[] = []) => ({ group, busy, images: [{ channel: "noon", path: "", thumb: "", verdict: "", flags, scores: null }] });
  const holds = proofHolds([row("real", false), row("real", true), row("marked", false, ["text_or_watermark"]), row("real", false, ["qa_sampled_out"]), row("control", true), row("control", false), row("backstop", false, ["halo"])]);
  expect(holds.real).toEqual({ held: 2, of: 4 });
  expect(holds.controls).toEqual({ held: 1, of: 2 });
  expect(holds.line).toBe("HOLDS at most: real photos 2 of 4 (50.0%), controls 1 of 2 (50.0%). These photos only, not a brand's rate.");
  expect(proofHolds([]).line).toContain("0 of 0 (0.0%)");
});

test("parses a photo list", () => {
  expect(parsePhotoList("Z1Z_3, 10350171_5096307_4")).toEqual([{ identifier: "Z1Z", n: 3 }, { identifier: "10350171_5096307", n: 4 }]);
  expect(() => parsePhotoList("nonumber")).toThrow();
});
