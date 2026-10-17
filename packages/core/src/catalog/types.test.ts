import { describe, expect, it } from "vitest";
import { CHANNEL_IDS, OUTPUT_FLAGS, ROLES, flagReason } from "./types";

describe("types", () => {
  it("lists the nine channels and three roles", () => {
    expect(CHANNEL_IDS).toHaveLength(9);
    expect(ROLES).toEqual(["admin", "operator", "viewer"]);
  });

  it("has unique flags", () => {
    expect(new Set(OUTPUT_FLAGS).size).toBe(OUTPUT_FLAGS.length);
  });
});

describe("flagReason", () => {
  it("returns the exact fallback_matte sentence", () => {
    expect(flagReason("fallback_matte")).toBe(
      "Background was removed with the simple method because the cut-out service was unavailable. Check the edges.",
    );
  });

  it("fills details from ctx", () => {
    expect(flagReason("low_resolution", { w: 800, h: 1000, min: 1600, channel: "Styli" })).toContain(
      "The original is 800 x 1000. Styli wants at least 1600 px",
    );
    expect(flagReason("numbering_gap", { list: "3" })).toBe(
      "Shot numbers 3 are missing in the upload; images shifted left in this row.",
    );
  });

  it("has no sentence for shadow_synthesised and a non-empty one for every other flag", () => {
    expect(flagReason("shadow_synthesised")).toBe("");
    for (const f of OUTPUT_FLAGS.filter((f) => f !== "shadow_synthesised")) {
      const s = flagReason(f);
      expect(s.length).toBeGreaterThan(0);
      expect(s).not.toMatch(/[<>]/);
      expect(s).not.toContain(String.fromCharCode(0x2014)); // no em dash in operator text
    }
  });
});
