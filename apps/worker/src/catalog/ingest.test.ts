import { describe, expect, it, vi } from "vitest";
import type { Db } from "@catalog/core/db/client";
import { handleIngestTask, type IngestTaskDeps } from "./ingest";

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
});
