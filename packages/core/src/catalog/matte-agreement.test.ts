// M1 D40. The main risk of matte_agreement is two models agreeing on the same wrong cut, so these run the real rule on real
// golden photos and the real cut-outs the deployed models made for them (fixtures, no model is called). "Same wrong cut" hands one
// real wrong cut-out in as two models of different families, which is the worst case: real models disagree far more.
import { agreedMatte } from "./auto-resolve";
import { triageProduct, type TriageOutput } from "./qa/triage";
import type { OutputFlag } from "./types";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { backgroundRegion, cutSupport, keptOverlap, matteAgreement, matteFamily, resolveMatte, thirdOpinionModel, type MatteVariant } from "./matte-guard";
import { prepare, type Matte } from "./render";

const FIXTURES = new URL("../../test-fixtures/catalog/matte-agreement/", import.meta.url);
const BRIA = "bria-rmbg", GENERAL = "birefnet-general", LITE = "birefnet-general-lite";

async function photo(id: string) {
  const p = await prepare(await readFile(new URL(`${id}.jpg`, FIXTURES)), `${id}.jpg`, async b => b);
  const matte = async (model: string, as = model): Promise<Matte> => ({ alpha: await sharp(await readFile(new URL(`${id}.${model}.png`, FIXTURES))).toColourspace("b-w").raw().toBuffer(), width: p.width, height: p.height, model: as, ms: 1, source: "model", target: "cpu", sentLongSide: 1024 });
  return { p, matte, region: backgroundRegion(p) };
}
/** The apparel_model policy on stored cut-outs: birefnet-general, then -lite, no padded frames, and bria-rmbg as the third opinion. */
async function resolved(id: string) {
  const { p, matte } = await photo(id), asked: MatteVariant[] = [];
  const out = await resolveMatte({ prepared: p, first: await matte(GENERAL), handRule: false, attempt: async variant => { asked.push(variant); return variant === "second" ? matte(LITE) : variant === "third" ? matte(BRIA) : null; } });
  return { ...out, asked, steps: out.actions.map(a => `${a.step}:${a.result}`) };
}
/** One real cut-out, handed in as two models of different families. */
async function sameWrongCut(id: string, model: string) {
  const { p, matte, region } = await photo(id);
  return matteAgreement(p, [await matte(model, BRIA), await matte(model, GENERAL)], region);
}

describe("matte agreement on real photos", () => {
  // False rejections from the Vero Moda batch: the hardest two by outline support. Both models cut the same clean outline.
  it("uses the cut-out two families agree on when the guard doubted it: a white top on a grey wall", async () => {
    const r = await resolved("Z40E29CD878FAA726501DZ_1");
    expect(r.steps).toContain("matte_agreement:passed");
    expect(r).toMatchObject({ passthrough: false, busyBackground: false });
    expect(r.matte.model).toBe(GENERAL);
    expect(r.asked).toContain("third");
  }, 60_000);

  // S1 of the diagnosis: on this photo the old pass-through left a white box in the frame, and the judge scored it 95. The two families agree, so no pass-through runs.
  it("Vero Moda 5715909336543 shot 1: the cut-out is used, so the pass-through's white box cannot come back", async () => {
    const r = await resolved("5715909336543_1");
    expect(r.steps).toContain("matte_agreement:passed");
    expect(r).toMatchObject({ passthrough: false, busyBackground: false });
    expect(r.steps.some(step => step.startsWith("matte_passthrough"))).toBe(false);
    // Full size on purpose: a copy at 800 px passes the guard on its first matte, so it would prove nothing here.
  }, 300_000);

  it("takes the batch's weakest outline support, inside the bars", async () => {
    const { p, matte, region } = await photo("Z83A7DA7F6815765CDF92Z_4");
    expect(matteAgreement(p, [await matte(BRIA), await matte(GENERAL)], region).matte?.model).toBe(BRIA);
  }, 60_000);

  // The families do agree here (every outline on a real edge), and both keep orange court and a piece of the net post inside
  // the rackets, seen at full size: the same class spec 05 rejects. No bar here sees it, so the judge has to: an agreed cut-out is always judged, and one it flags is never published.
  it("the tennis-court photo: the families agree on a cut with court inside the rackets, and only the judge stands between it and the channel", async () => {
    const { p, matte, region } = await photo("ZEE79259BBFD83FFA1DB0Z_5");
    expect(matteAgreement(p, [await matte(BRIA), await matte(GENERAL)], region).matte).not.toBeNull();
    const r = await resolved("ZEE79259BBFD83FFA1DB0Z_5");
    expect(r.steps).toContain("matte_agreement:passed");
    // The policy's two models are of one family here, so the third model was asked: one more cut-out call.
    expect(r.asked).toContain("third");
    expect(r.busyBackground).toBe(false);
    expect(agreedMatte({ auto_actions: r.actions })).toBe(true);
    const row = (flags: OutputFlag[]): TriageOutput => ({ id: "court", n: 5, channel: "noon", status: "needs_attention", flags, decision: null, stagingUri: "gs://assets/staged.jpg", compliance: { auto_actions: r.actions } });
    // Flagged by the judge: never published, whatever the other photos are.
    const lone = row(["leftover_background"]), photos = [1, 2, 3].map(n => ({ ...row([]), id: `o${n}`, n, status: "staged" as const }));
    expect(triageProduct([lone, photos[0]!], []).get("court")).toMatchObject({ action: "hold" });
    expect(triageProduct([lone, ...photos], []).get("court")).toMatchObject({ action: "drop" });
    // Not seen by the judge at all: the same.
    expect(triageProduct([row(["qa_unavailable"]), photos[0]!], []).get("court")).toMatchObject({ action: "hold", cause: "unusable" });
  }, 60_000);

  it("ghost, Penti ZBE55F7B86F158FEA0EB9Z shot 5: a frame-filling photo never reaches agreement and spends no third call", async () => {
    const r = await resolved("ZBE55F7B86F158FEA0EB9Z_5");
    expect(r.steps).toContain("matte_agreement:failed");
    expect(r.asked).not.toContain("third");
    expect(r.passthrough).toBe(true);
    await expect(sameWrongCut("ZBE55F7B86F158FEA0EB9Z_5", GENERAL)).resolves.toMatchObject({ matte: null, detail: "frame-filling" });
  }, 60_000);

  it("Penti Z91D419FC9238E844BF77Z shot 4, cut through the skin: stopped by outline support, and the real models disagree anyway", async () => {
    const { p, matte } = await photo("Z91D419FC9238E844BF77Z_4");
    expect(keptOverlap(await matte(BRIA), await matte(GENERAL))).toBeLessThan(0.5);
    const cut = cutSupport(p, (await matte(BRIA)).alpha);
    expect(cut.unsupportedShare).toBeGreaterThan(0.1);
    expect(cut.longestRun).toBeGreaterThan(0.2);
    const twin = await sameWrongCut("Z91D419FC9238E844BF77Z_4", BRIA);
    expect(twin.matte).toBeNull();
    expect(twin.detail).toContain("on no edge");
  }, 60_000);

  it("the candle Z15276411CE85C2E728DEZ shot 4: the wedge of backdrop is stopped by outline support; the third opinion that passes the guard wins", async () => {
    const twin = await sameWrongCut("Z15276411CE85C2E728DEZ_4", GENERAL);
    expect(twin.matte).toBeNull();
    expect(twin.detail).toContain("on no edge");
    const r = await resolved("Z15276411CE85C2E728DEZ_4");
    expect(r.matte.model).toBe(BRIA);
    expect(r.steps).toContain("second_matte:passed");
  }, 60_000);

  it("the lifestyle candle Z011CB57531CA8FA0CBDDZ shot 1: one family agreeing with itself is not agreement, so it stays held", async () => {
    const { matte } = await photo("Z011CB57531CA8FA0CBDDZ_1");
    expect(keptOverlap(await matte(GENERAL), await matte(LITE))).toBeGreaterThan(0.98);
    const r = await resolved("Z011CB57531CA8FA0CBDDZ_1");
    expect(r.steps).toContain("matte_agreement:failed");
    expect(r.busyBackground).toBe(true);
  }, 60_000);

  it("logo-only, the bag close-up Z02B2EE44E3A08044B816Z shot 6: a small keep is stopped; the real families disagree", async () => {
    const { matte } = await photo("Z02B2EE44E3A08044B816Z_6");
    expect(keptOverlap(await matte(BRIA), await matte(GENERAL))).toBeLessThan(0.5);
    const twin = await sameWrongCut("Z02B2EE44E3A08044B816Z_6", GENERAL);
    expect(twin.matte).toBeNull();
    expect(twin.detail).toContain("of the frame");
  }, 60_000);

  // The honest limit, pinned so nobody reads more into the bars. This cut-out (the clasp and a torn piece of leather) follows
  // edges that are in the photo and keeps 20% of the frame, so no pixel measure stops it if two families ever shared it.
  // What protects a real photo is that families do not share it (overlap 0.495 here), that this is a bag and the rule is
  // apparel only, and that the judge still looks at every result.
  it("known limit: a wrong cut along real edges, if two families shared it, passes these bars", async () => {
    const twin = await sameWrongCut("Z02B2EE44E3A08044B816Z_6", BRIA);
    expect(twin.matte).not.toBeNull();
  }, 60_000);
});

describe("third opinion", () => {
  it("asks a family not asked yet, then any other served model", () => {
    const served = [BRIA, GENERAL, LITE, "birefnet-hrsod"];
    expect(thirdOpinionModel(served, [GENERAL, LITE])).toBe(BRIA);
    expect(thirdOpinionModel(served, [BRIA, GENERAL])).toBe(LITE);
    expect(thirdOpinionModel([GENERAL, LITE], [GENERAL, LITE])).toBeNull();
    expect(matteFamily("birefnet-hrsod")).toBe(matteFamily(GENERAL));
  });
});
