import { describe, expect, it } from "vitest";
import type { ChannelId, OutputFlag } from "../types";
import { holdsAtRender, INFORMATION_FLAGS, triageProduct, type TriageOutput } from "./triage";
import { flagDetails } from "./reasons";
import type { AutoAction } from "../auto-resolve";

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
  // A photo whose background could not be removed (a busy scene, matte-guard.ts) is a hard hold, never dropped or
  // noted: the code-detected `leftover_background`, marked by the matte stage's failed pass-through step.
  const held: AutoAction = {step:"matte_passthrough",trigger:["product_removed","leftover_background"],result:"failed",channels:[],rejudged:false};
  const busy = out(3, ["leftover_background", "cut_in_source", "qa_sampled_out"], {compliance:{auto_actions:[held]}});
  expect(holdsAtRender(busy.flags)).toBe(true);
  expect(action([out(1), out(2), busy, out(4)], busy)).toMatchObject({action:"hold",cause:"unusable",flags:["leftover_background"]});
  // The judge's own leftover background on the same photo is still dropped with a note.
  const judged = out(3, ["leftover_background"]);
  expect(action([out(1), out(2), judged, out(4)], judged)).toMatchObject({action:"drop"});
  expect(flagDetails("leftover_background", {busy:true})).toEqual({why:"The background could not be removed from this photo.",whatToDo:"Use it as is, replace it, or remove it."});
  expect(flagDetails("leftover_background").why).toBe("Some of the original background is still visible around the product.");
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
 it("publishes with a note when only one other good photo remains, unless the image cannot be published or shows our own defect", () => {
  const bad = out(2, ["text_or_watermark"]);
  expect(action([out(1), bad], bad)).toMatchObject({action:"note"});
  // Our own defects left after the re-render loop are never published with a note.
  for (const flag of ["halo", "leftover_background", "placement"] as const) { const own = out(2, [flag]); expect(action([out(1), own], own)).toMatchObject({action:"hold",cause:"not_publishable"}); }
  const rules = out(2, ["failed_compliance"]);
  expect(action([out(1), rules], rules)).toMatchObject({action:"hold",cause:"not_publishable"});
 });
 it("a broken encoder setting left after its re-render is held for the technical team, never dropped, even with good photos left (07 4.6a)", () => {
  const encoder = out(3, ["failed_compliance"], {compliance:{failures:["dims: The image dimensions do not meet this marketplace's canvas rules."]}});
  expect(action([out(1), out(2), encoder, out(4)], encoder)).toMatchObject({action:"hold",cause:"code_fault"});
  // A margin the photo could not be fitted inside is the photo's: dropped like any other own defect.
  const margin = out(3, ["failed_compliance"], {compliance:{failures:["inside_safe_box: The product or shadow reaches outside the required margins."]}});
  expect(action([out(1), out(2), margin, out(4)], margin)).toMatchObject({action:"drop"});
 });
 it("note-only flags never hold or drop, and checks that could not run stay with the operator", () => {
  const cut = out(1, ["complete_product", "low_resolution", "transparent"]);
  expect(action([cut, out(2)], cut)).toMatchObject({action:"none"});
  const capped = out(3, ["qa_cap"]);
  expect(action([out(1), out(2), capped], capped)).toMatchObject({action:"hold",cause:"unchecked"});
 });
 it("leaves a size chart out with a note whatever its position, and photo 1 is the first real photo", () => {
  const chartLast = out(3, ["chart_image"]);
  expect(action([out(1), out(2), chartLast], chartLast)).toMatchObject({action:"drop",flags:["chart_image"]});
  // Photo 1 a chart, or the only other photo a chart: still left out, never held.
  const chartFirst = out(1, ["chart_image"]), two = out(2, ["text_or_watermark"]), three = out(3);
  const decisions = triageProduct([chartFirst, two, three]);
  expect(decisions.get(chartFirst.id)).toMatchObject({action:"drop"});
  // Photo 2 is now photo 1, so its problem holds as photo 1 would.
  expect(decisions.get(two.id)).toMatchObject({action:"hold",cause:"photo_one"});
  const lone = out(1, ["chart_image"]);
  expect(action([lone], lone)).toMatchObject({action:"drop"});
 });
 it("product_removed is our own defect: after the re-render loop it is dropped or held, never published with a note", () => {
  const removed = out(3, ["product_removed"]);
  expect(action([out(1), out(2), removed], removed)).toMatchObject({action:"drop",flags:["product_removed"]});
  const few = out(2, ["product_removed"]);
  expect(action([out(1), few], few)).toMatchObject({action:"hold",cause:"not_publishable"});
 });
 it("judges each channel on its own good photos and skips decided outputs", () => {
  const styli = out(2, ["failed_compliance"], {channel:"styli"}), decided = out(2, ["halo"], {decision:"use_as_is",status:"staged"});
  const outputs = [out(1, [], {channel:"styli"}), styli, out(3, [], {channel:"styli"}), out(4, [], {channel:"styli"}), out(1), decided];
  expect(action(outputs, styli)).toMatchObject({action:"drop"});
  expect(triageProduct(outputs).has(decided.id)).toBe(false);
 });
});
