import { describe, expect, it } from "vitest";
import type { ChannelId, OutputFlag } from "../types";
import { INFORMATION_FLAGS, triageProduct, type TriageOutput } from "./triage";

let next = 0;
const out = (n: number, flags: OutputFlag[] = [], extra: Partial<TriageOutput> = {}): TriageOutput =>
  ({id:`o${++next}`,n,channel:"noon",status:flags.some(f=>!INFORMATION_FLAGS.has(f)) ? "needs_attention" : "staged",flags,decision:null,stagingUri:"gs://assets/staged.jpg",...extra});
const action = (outputs: TriageOutput[], target: TriageOutput, kept: {channel: ChannelId; n: number}[] = []) => triageProduct(outputs, kept).get(target.id);

describe("QA triage: hard holds only", () => {
 it("holds a confirmed different item, a collage and a corrupt file whatever the other photos", () => {
  for (const [flags, cause] of [[["different_product"], "wrong_item"], [["collage"], "collage"]] as const) {
   const bad = out(3, [...flags]);
   expect(action([out(1), out(2), bad, out(4)], bad)).toMatchObject({action:"hold",cause});
  }
  const corrupt = out(4, [], {status:"failed",stagingUri:null});
  expect(action([out(1), out(2), out(3), corrupt], corrupt)).toMatchObject({action:"hold",cause:"corrupt"});
 });
 it("holds photo 1 with a problem, and every photo when none is good", () => {
  const one = out(1, ["halo"]);
  expect(action([one, out(2), out(3), out(4)], one)).toMatchObject({action:"hold",cause:"photo_one"});
  const a = out(1, ["text_or_watermark"]), b = out(2, ["text_or_watermark"]), c = out(3, ["orientation"]);
  const decisions = triageProduct([a, b, c]);
  expect([...decisions.values()].map(d => d.action)).toEqual(["hold", "hold", "hold"]);
  expect(decisions.get(b.id)?.cause).toBe("every_photo");
 });
 it("drops a problem photo with a note when it is not photo 1 and two good photos remain", () => {
  const bad = out(3, ["leftover_background"]);
  expect(action([out(1), out(2), bad], bad)).toMatchObject({action:"drop",flags:["leftover_background"]});
  // A live shot left unchanged in this batch counts as a good photo too.
  const lone = out(3, ["halo"]);
  expect(action([out(1), lone], lone, [{channel:"noon",n:2}])).toMatchObject({action:"drop"});
 });
 it("publishes with a note when only one other good photo remains, unless the image cannot be published", () => {
  const bad = out(2, ["halo"]);
  expect(action([out(1), bad], bad)).toMatchObject({action:"note"});
  const rules = out(2, ["failed_compliance"]);
  expect(action([out(1), rules], rules)).toMatchObject({action:"hold",cause:"not_publishable"});
 });
 it("note-only flags never hold or drop, and checks that could not run stay with the operator", () => {
  const cut = out(1, ["complete_product", "low_resolution", "transparent"]);
  expect(action([cut, out(2)], cut)).toMatchObject({action:"none"});
  const capped = out(3, ["qa_cap"]);
  expect(action([out(1), out(2), capped], capped)).toMatchObject({action:"hold",cause:"unchecked"});
 });
 it("judges each channel on its own good photos and skips decided outputs", () => {
  const styli = out(2, ["failed_compliance"], {channel:"styli"}), decided = out(2, ["halo"], {decision:"use_as_is",status:"staged"});
  const outputs = [out(1, [], {channel:"styli"}), styli, out(3, [], {channel:"styli"}), out(4, [], {channel:"styli"}), out(1), decided];
  expect(action(outputs, styli)).toMatchObject({action:"drop"});
  expect(triageProduct(outputs).has(decided.id)).toBe(false);
 });
});
