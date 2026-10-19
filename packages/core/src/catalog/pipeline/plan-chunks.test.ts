import { expect, it } from "vitest";
import { planChunks } from "./plan-chunks";
it("keeps products whole in natural identifier order, including an oversized product", () => {
  expect(planChunks([
    { productId: "p10", identifier: "P10", sourceCount: 30 },
    { productId: "p2", identifier: "P2", sourceCount: 10 },
    { productId: "p1", identifier: "P1", sourceCount: 15 },
  ], 25)).toEqual([
    { productIds: ["p1", "p2"], sourceCount: 25 },
    { productIds: ["p10"], sourceCount: 30 },
  ]);
});
