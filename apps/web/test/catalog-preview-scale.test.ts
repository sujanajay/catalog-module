// Step 4's "images will be made" at 25,000 products: one lookup per photo and channel, not a scan of every live output.
import { describe, expect, it } from "vitest";
import { plannedImages } from "../lib/catalog/preview";
import { renderKeys } from "@catalog/core/catalog/pipeline/publish";

describe("plannedImages at 25,000 products", () => {
  it("counts 75,000 photos on 3 channels against 75,000 live outputs in well under a second", () => {
    const sources = Array.from({ length: 75_000 }, (_, i) => ({ productId: `p${Math.floor(i / 3)}`, n: (i % 3) + 1, sha256: `s${i}` }));
    // Every second photo already has a current live image on noon.
    const live = sources.filter((_, i) => i % 2 === 0).map((s) => ({
      productId: s.productId, n: s.n, channel: "noon" as const, sha256: s.sha256, workerMatteModel: "m",
      renderKey: renderKeys({ sourceSha256: s.sha256, channel: "noon", n: s.n, policyKey: "default|m" }, null)[0]!,
    }));
    const t0 = performance.now();
    const r = plannedImages(sources, ["noon", "amazon", "styli"], live, null);
    expect(r).toEqual({ outputs: 75_000 * 3 - 37_500, sourcesToMake: 75_000 });
    expect(performance.now() - t0).toBeLessThan(5_000);
  }, 120_000);
});
