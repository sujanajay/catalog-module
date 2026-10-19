import { describe, expect, it } from "vitest";
import { flagDetails, problemLine, shortClause } from "./reasons";
import { OUTPUT_FLAGS } from "../types";
describe("operator reasons",()=>{
 it("provides a sentence and action for every flag without model names",()=>{
  for(const flag of OUTPUT_FLAGS) { const pair=flagDetails(flag,{n:4,k:2,channel:"Styli",w:800,h:900,min:1600});expect(pair.why.length).toBeGreaterThan(0);expect(pair.whatToDo.length).toBeGreaterThan(0);expect(JSON.stringify(pair)).not.toMatch(/birefnet|gemini|claude|rmbg/i); }
  expect(flagDetails("qa_cap").why).toBe("Quality check paused: the spending limit was reached.");
  expect(flagDetails("complete_product",{n:4,k:2}).whatToDo).toContain('"Replace photo 4" swaps the photo for all 2 marketplaces.');
 });
 it("produces the v2 clauses, judge sentence and punctuation",()=>{
  expect(problemLine([{n:4,flag:"low_resolution",channel:"Styli"},{n:5,flag:"failed"}])).toBe("Photo 4 is too small for Styli; photo 5 could not be read.");
  expect(problemLine([{n:3,flag:"different_product"}])).toBe("Photo 3 looks like a different product from the others.");
  expect(problemLine([{n:2,flag:"complete_product",reason:"The model's hand looks cut at the frame edge."}])).toBe("Photo 2: the model's hand looks cut at the frame edge.");
  expect(shortClause("halo")).toBe("has a rough edge");expect(problemLine([])).toBe("");
 });
 it("words placement with each channel's own rule",()=>{
  expect(flagDetails("placement",{n:2,channel:"Styli"}).why).toBe("On Styli the product does not sit at the bottom centre inside the guides like the other angles.");
  const centrepoint=flagDetails("placement",{n:2,channel:"Centrepoint"});
  expect(centrepoint.why).toBe("On Centrepoint the product does not sit in the centre of the image like the other angles.");
  expect(JSON.stringify(centrepoint)).not.toMatch(/Styli|guides/);
  for(const label of ["Noon","Namshi","Trendyol","6thStreet","VogaCloset","Amazon","Shein"]) expect(flagDetails("placement",{channel:label}).why).not.toMatch(/Styli|guides/);
  expect(flagDetails("placement").why).toBe("On this marketplace the product does not sit in the same place as the other angles.");
  expect(shortClause("placement",{channel:"Centrepoint"})).toBe("sits differently from the other angles on Centrepoint");
 });
});
