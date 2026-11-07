import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { autoDecide, autoDecideNote, autoDecideOf, DEFAULT_AUTO_DECIDE_RULES, deliverable, HOLD_SENTENCE, ruleFor, type AutoDecideSnapshot } from "./auto-decide";
import { HOLD_CAUSES, PROVISIONAL_SENTENCE } from "./types";
import { INFORMATION_FLAGS } from "./qa/triage";

const staged = { status: "needs_attention" as const, stagingUri: "gs://assets/x.jpg", bytes: 10, flags: [] as never[], channel: "noon" as const };

describe("M1-F3-R1 auto-decide rules", () => {
  it("has one default per hold cause, and migration 0014 seeds exactly those rows", () => {
    expect(DEFAULT_AUTO_DECIDE_RULES.map(r => r.cause)).toEqual([...HOLD_CAUSES]);
    const sql = readFileSync(path.join(import.meta.dirname, "..", "..", "drizzle", "0014_auto_decide_rules.sql"), "utf8");
    const seeded = [...sql.matchAll(/\('([a-z_]+):\*', '([a-z_]+)', '\*', '(deliver|drop)', 'seed'\)/g)].map(m => ({ id: `${m[1]}:*`, cause: m[2], channel: "*", action: m[3] }));
    // M1 D40: migration 0029 adds visible_defect (hold) and changes unusable to hold.
    const later = readFileSync(path.join(import.meta.dirname, "..", "..", "drizzle", "0029_auto_decide_hold.sql"), "utf8");
    expect(later).toContain("('visible_defect:*', 'visible_defect', '*', 'hold', 'seed')");
    expect(later).toMatch(/SET "action" = 'hold' WHERE "id" = 'unusable:\*' AND "updated_by" = 'seed'/);
    const after = [...seeded.map(r => r.cause === "unusable" ? { ...r, action: "hold" } : r), { id: "visible_defect:*", cause: "visible_defect", channel: "*", action: "hold" }];
    expect(after.sort((a, b) => a.id.localeCompare(b.id))).toEqual([...DEFAULT_AUTO_DECIDE_RULES].sort((a, b) => a.id.localeCompare(b.id)));
    // Product truth and unreadable photos are dropped; an uncut photo and a visible defect are held (D40); everything else is delivered provisional.
    expect(DEFAULT_AUTO_DECIDE_RULES.filter(r => r.action === "drop").map(r => r.cause).sort()).toEqual(["collage", "corrupt", "wrong_item"]);
  });

  it("a channel rule wins over the * rule; a cause missing from the snapshot falls back to the default", () => {
    const snapshot: AutoDecideSnapshot = { rules: [{ id: "unusable:*", cause: "unusable", channel: "*", action: "deliver" }, { id: "unusable:amazon", cause: "unusable", channel: "amazon", action: "drop" }] };
    expect(ruleFor(snapshot, "unusable", "amazon").id).toBe("unusable:amazon");
    expect(ruleFor(snapshot, "unusable", "noon").id).toBe("unusable:*");
    expect(ruleFor(snapshot, "corrupt", "noon")).toEqual({ id: "corrupt:*", cause: "corrupt", channel: "*", action: "drop" });
  });

  it("delivers only a made image that passes the channel's hard rules; otherwise the slot is dropped", () => {
    const snapshot = { rules: [...DEFAULT_AUTO_DECIDE_RULES] };
    expect(autoDecide(snapshot, "not_publishable", staged)).toMatchObject({ action: "deliver", fellBack: false });
    expect(deliverable({ ...staged, flags: ["failed_compliance"] })).toBe(false);
    expect(autoDecide(snapshot, "code_fault", { ...staged, flags: ["failed_compliance"] })).toMatchObject({ action: "drop", fellBack: true, rule: { id: "code_fault:*" } });
    expect(autoDecide(snapshot, "unchecked", { ...staged, stagingUri: null })).toMatchObject({ action: "drop", fellBack: true });
    expect(autoDecide(snapshot, "corrupt", { ...staged, status: "failed" })).toMatchObject({ action: "drop", fellBack: false });
  });

  it("a batch without rules (started before M1-S3) keeps the holds", () => {
    expect(autoDecideOf({})).toBeNull();
    expect(autoDecideOf(null)).toBeNull();
    expect(autoDecideOf({ autoDecide: { rules: [] } })).toEqual({ rules: [] });
  });

  it("provisional is an information flag (it never holds) and its sentences name no model", () => {
    expect(INFORMATION_FLAGS.has("provisional")).toBe(true);
    expect(autoDecideNote("deliver", "This photo could not be checked")).toBe(`This photo could not be checked. ${PROVISIONAL_SENTENCE}`);
    expect(autoDecideNote("drop", null)).toMatch(/^Left out automatically/);
  });

  it("a hold names the product's other photos only when some are delivered", () => {
    expect(autoDecideNote("hold", "The edge is rough")).toBe(`The edge is rough. ${HOLD_SENTENCE}`);
    expect(HOLD_SENTENCE).toContain("other photos are delivered");
    expect(autoDecideNote("hold", "The edge is rough", false)).toBe("The edge is rough. It has no link yet. Replace it, use it as it is, or remove it.");
    expect(autoDecideNote("drop", "The edge is rough")).toContain("the product's other photos are delivered");
    expect(autoDecideNote("drop", "The edge is rough", false)).toBe("The edge is rough. Left out automatically; this photo gets no new link here.");
  });
});
