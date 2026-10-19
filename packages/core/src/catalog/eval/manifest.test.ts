import { describe, expect, it } from "vitest";
import { emptyManifest, manifestPath, mergeEntries, parseManifest, seededSample, serializeManifest, type ManifestEntry } from "./manifest";

const entry = (sha256: string, n = 1): ManifestEntry => ({ identifier: "ABC", n, brand: "anta", source: { kind: "local_folder", ref: `ABC_${n}.jpg` }, sha256, width: 800, height: 800, mime: "image/jpeg", hard_case_tags: [], uri: `gs://b/catalog-test/eval/anta/sources/anta/ABC_${n}.jpg` });

describe("eval manifest", () => {
  it("round trips through JSON and keeps every field", () => {
    const m = { ...mergeEntries(emptyManifest("anta"), [entry("a"), { ...entry("b", 2), category_override: "footwear" as const, hard_case_tags: ["px500" as const] }]).manifest, sample: { n: 2, seed: 7 } };
    expect(parseManifest(serializeManifest(m))).toEqual(m);
    expect(manifestPath("anta")).toBe("catalog-test/eval/anta/manifest.json");
  });
  it("is idempotent on sha256", () => {
    const first = mergeEntries(emptyManifest("anta"), [entry("a"), entry("a", 2)]);
    expect(first.added).toHaveLength(1);
    const again = mergeEntries(first.manifest, [entry("a"), entry("c")]);
    expect(again.manifest.entries.map(e => e.sha256)).toEqual(["a", "c"]);
    expect(again.skipped).toBe(1);
  });
  it("samples deterministically per seed", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    expect(seededSample(items, 5, 1)).toEqual(seededSample(items, 5, 1));
    expect(seededSample(items, 5, 1)).not.toEqual(seededSample(items, 5, 2));
    expect(new Set(seededSample(items, 50, 3)).size).toBe(50);
  });
});
