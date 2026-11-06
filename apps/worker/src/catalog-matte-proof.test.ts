import { expect, test } from "vitest";
import { matteProofCommand, parsePhotoList, proofVerdict, PROOF_CONTROLS, PROOF_REAL } from "./catalog-matte-proof";

test("the proof covers the 19 false rejections and the controls the guard rightly caught", () => {
  expect(new Set(PROOF_REAL.map(([id, n]) => `${id}_${n}`)).size).toBe(19);
  expect(PROOF_CONTROLS.filter(c => !c.agrees).map(c => c.why)).toEqual(expect.arrayContaining(["ghost", "candle", "logo-only", "cut through the skin"]));
});

test("a real photo passes only as a clean cut-out; a control only as the list says", () => {
  const real = { group: "real" as const, agreed: true, busy: false, passthrough: false, flags: [] as string[] };
  expect(proofVerdict(real, true).pass).toBe(true);
  expect(proofVerdict({ ...real, busy: true }, true).pass).toBe(false);
  expect(proofVerdict({ ...real, flags: ["product_removed"] }, true)).toEqual({ pass: false, note: "judge: product_removed" });
  const control = { ...real, group: "control" as const };
  expect(proofVerdict(control, false).pass).toBe(false);
  expect(proofVerdict({ ...control, agreed: false }, false).pass).toBe(true);
});

test("proof refuses to run without LIVE_SMOKE=1, before touching anything", async () => {
  const before = process.env.LIVE_SMOKE, code = process.exitCode;
  delete process.env.LIVE_SMOKE;
  try {
    await matteProofCommand(null as never, {});
    expect(process.exitCode).toBe(2);
  } finally { process.exitCode = code; if (before !== undefined) process.env.LIVE_SMOKE = before; }
});

test("parses a photo list", () => {
  expect(parsePhotoList("Z1Z_3, 10350171_5096307_4")).toEqual([{ identifier: "Z1Z", n: 3 }, { identifier: "10350171_5096307", n: 4 }]);
  expect(() => parsePhotoList("nonumber")).toThrow();
});
