import dns from "node:dns";
import { describe, expect, it, vi } from "vitest";
import type { SourceItem } from "@catalog/core/catalog/ingest/types";
import { fetchSourceUrl } from "@catalog/core/catalog/ingest/url-list";
import type { Db } from "@catalog/core/db/client";
import { pinnedFetch } from "@catalog/core/safe-url";
import * as storage from "@catalog/core/storage";
import { enqueueTask } from "@catalog/core/tasks";
import { handleIngestTask, workerIngestDeps, type IngestTaskDeps } from "./ingest";

const ingest = {} as IngestTaskDeps["ingest"];
const db = {} as Db;

describe("handleIngestTask", () => {
  it("passes the body to runIngest and answers 200 with its outcome", async () => {
    const run = vi.fn(async () => ({ progress: { done: 25, total: 60, phase: "copying" as const }, outcome: "collected 25 of 60; continuing at 25" }));
    expect(await handleIngestTask({ db, ingest, run }, { batchId: "b1", uploadId: "u1", cursor: "25" })).toEqual({
      httpStatus: 200, outcome: "collected 25 of 60; continuing at 25",
    });
    expect(run).toHaveBeenCalledWith(db, ingest, { batchId: "b1", uploadId: "u1", cursor: "25" });
    await handleIngestTask({ db, ingest, run }, { batchId: "b1", uploadId: "u1" });
    expect(run).toHaveBeenLastCalledWith(db, ingest, { batchId: "b1", uploadId: "u1" });
  });

  it("answers 500 on an unexpected error so Cloud Tasks retries", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const run = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    expect(await handleIngestTask({ db, ingest, run }, { batchId: "b1", uploadId: "u1" })).toEqual({ httpStatus: 500, outcome: "error" });
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });

  it("refuses a body without the batch and upload ids", async () => {
    const run = vi.fn();
    for (const body of [{}, { batchId: "b1" }, { batchId: "b1", uploadId: 7 }, { batchId: "b1", uploadId: "u1", cursor: 3 }]) {
      expect((await handleIngestTask({ db, ingest, run }, body)).httpStatus).toBe(400);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("runs in production with the real storage, Cloud Tasks and 02's DNS-pinned fetch", () => {
    const deps = workerIngestDeps();
    expect(deps.fetch).toBe(pinnedFetch);
    expect(deps.fetch).not.toBe(globalThis.fetch);
    expect(deps.storage.uploadBuffer).toBe(storage.uploadBuffer);
    expect(deps.enqueue).toBe(enqueueTask);
  });

  it("refuses a pasted link whose address turns private at connect time (DNS rebinding) with the production fetch", async () => {
    // safeFetch's pre-check sees a public address; the lookup made while connecting answers loopback.
    const spy = vi.spyOn(dns, "lookup").mockImplementation(((_host: string, opts: dns.LookupOptions, cb: (...a: unknown[]) => void) => {
      if (opts?.all) cb(null, [{ address: "127.0.0.1", family: 4 }]);
      else cb(null, "127.0.0.1", 4);
    }) as unknown as typeof dns.lookup);
    const item: SourceItem = {
      identifier: "ABC", n: 1, suffix: "", originalName: "ABC_1.jpg", folder: null, sheetIdentifier: null, ext: "jpg",
      bytes: { kind: "url", url: "https://rebind.example.com/ABC_1.jpg" }, uploadId: "u1", origin: "url_list", warnings: [],
    };
    try {
      const got = await fetchSourceUrl(item, workerIngestDeps(), { lookup: async () => ["34.120.10.10"] });
      expect(got).toEqual({
        ok: false,
        reason: "https://rebind.example.com/ABC_1.jpg did not return an image (got Links to internal addresses cannot be used: rebind.example.com).",
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
