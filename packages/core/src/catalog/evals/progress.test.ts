import { describe, expect, it, vi } from "vitest";
import { parseSetRecord, parseSetsFlag, selectSets, serializeSetRecord, setId, setRecordPath, withEvalRetry, type SetRecord } from "./progress";

/** The error node-fetch raises inside the storage client when GCS drops the socket mid-read. */
const hangUp = () => Object.assign(new Error("request to https://storage.googleapis.com/storage/v1/b/x/o/y? failed, reason: socket hang up"), { type: "system", code: "ECONNRESET", errno: "ECONNRESET" });

const record = (set: string, status: SetRecord["status"], extra: Partial<SetRecord> = {}): SetRecord => ({
  set, brand: set.split(".")[0]!, category: set.split(".")[1]!, status, error: status === "failed" ? "boom" : null, startedAt: "2026-10-20T01:00:00.000Z", finishedAt: "2026-10-20T01:30:00.000Z",
  photos: 3, products: 1, results: [], thumbs: [], deterministicPass: [], attentionRows: [], attentionProducts: [], trials: [], overwriteRan: false, batches: [], ...extra,
});

describe("withEvalRetry", () => {
  it("retries a golden-source read that hangs up twice and returns the third answer", async () => {
    const downloadBuffer = vi.fn().mockRejectedValueOnce(hangUp()).mockRejectedValueOnce(hangUp()).mockResolvedValueOnce({ buf: Buffer.from("jpeg"), mime: "image/jpeg" });
    const sleep = vi.fn(async (_ms: number) => {});
    const storage = withEvalRetry({ downloadBuffer, uploadBuffer: vi.fn(), headObject: vi.fn(), listObjects: vi.fn() }, { tries: 5, sleep });
    await expect(storage.downloadBuffer("gs://b/catalog-test/evals/golden/sources/vero_moda/x_2.jpg")).resolves.toEqual({ buf: Buffer.from("jpeg"), mime: "image/jpeg" });
    expect(downloadBuffer).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
  });

  it("retries uploads, heads and listings the same way, and gives up after the fifth attempt", async () => {
    const uploadBuffer = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Service Unavailable"), { code: 503 })).mockResolvedValueOnce("gs://b/p");
    const headObject = vi.fn().mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })).mockResolvedValueOnce({ exists: true, size: 1, contentType: "image/jpeg", generation: "1", crc32c: "c" });
    const listObjects = vi.fn().mockRejectedValue(hangUp());
    const sleep = vi.fn(async () => {});
    const storage = withEvalRetry({ downloadBuffer: vi.fn(), uploadBuffer, headObject, listObjects }, { tries: 5, sleep });
    await expect(storage.uploadBuffer("catalog-test/evals/r/sets/a.b.json", Buffer.from("{}"), "application/json")).resolves.toBe("gs://b/p");
    expect((await storage.headObject("gs://b/p")).exists).toBe(true);
    await expect(storage.listObjects("gs://b/catalog-test/evals/r/sets/")).rejects.toThrow(/socket hang up/);
    expect(listObjects).toHaveBeenCalledTimes(5);
  });

  it("does not retry a permanent error", async () => {
    const downloadBuffer = vi.fn().mockRejectedValue(Object.assign(new Error("No such object"), { code: 404 }));
    const storage = withEvalRetry({ downloadBuffer, uploadBuffer: vi.fn(), headObject: vi.fn(), listObjects: vi.fn() }, { tries: 5, sleep: async () => {} });
    await expect(storage.downloadBuffer("gs://b/missing")).rejects.toThrow(/No such object/);
    expect(downloadBuffer).toHaveBeenCalledTimes(1);
  });
});

describe("set records", () => {
  it("round-trips a record with its thumbnails and names its object under the run's sets/ folder", () => {
    const original = record("anta.footwear", "done", {
      results: [{ id: "geometry.edges", group: "geometry", subject: { identifier: "A1", n: 1, channel: "amazon" }, ok: false, status: "fail", measured: 3, threshold: 0, unit: "px", detail: "x" }],
      thumbs: [{ identifier: "A1", n: 1, channel: "amazon", original: Buffer.from([1, 2, 3]), output: null }],
      deterministicPass: ["A1|noon|1"], trials: [], overwriteRan: true, batches: ["b1", "b2"],
    });
    const parsed = parseSetRecord(serializeSetRecord(original));
    expect(parsed).toEqual(original);
    expect(Buffer.isBuffer(parsed.thumbs[0]!.original)).toBe(true);
    expect(setId("anta", "footwear")).toBe("anta.footwear");
    expect(setRecordPath("evals-20261020-abc123", "anta.footwear")).toBe("catalog-test/evals/evals-20261020-abc123/sets/anta.footwear.json");
    expect(() => parseSetRecord("{}")).toThrow(/Not an eval set record/);
  });
});

describe("selectSets", () => {
  const all = ["anta.footwear", "french_connection.apparel_model", "penti.apparel_model", "vero_moda.apparel_model"];

  it("skips sets recorded as done, re-runs failed ones and keeps the manifest order", () => {
    const stored = new Map([["anta.footwear", record("anta.footwear", "done")], ["penti.apparel_model", record("penti.apparel_model", "failed")]]);
    expect(selectSets(all, stored)).toEqual({ run: ["french_connection.apparel_model", "penti.apparel_model", "vero_moda.apparel_model"], skipped: ["anta.footwear"] });
  });

  it("narrows to --sets and rejects an unknown id", () => {
    expect(parseSetsFlag("vero_moda.apparel_model, anta.footwear", all)).toEqual(["vero_moda.apparel_model", "anta.footwear"]);
    expect(selectSets(all, new Map(), ["vero_moda.apparel_model", "anta.footwear"])).toEqual({ run: ["anta.footwear", "vero_moda.apparel_model"], skipped: [] });
    expect(() => parseSetsFlag("anta.shoes", all)).toThrow(/Unknown set anta.shoes. Known sets: anta.footwear/);
    expect(() => parseSetsFlag(" , ", all)).toThrow(/at least one set id/);
  });
});
