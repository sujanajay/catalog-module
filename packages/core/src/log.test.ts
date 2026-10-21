import { afterEach, describe, expect, it, vi } from "vitest";
import { ERROR_EVENT_TYPE, LABELS_KEY, log, logEntry, toSeverity } from "./log";

afterEach(() => vi.restoreAllMocks());
const lineOf = (spy: { mock: { calls: unknown[][] } }) => JSON.parse(String(spy.mock.calls[0]![0])) as Record<string, unknown>;

describe("log", () => {
  it("prints one JSON line with severity, message, the fields and the batch label", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    log("INFO", "chunk delivered", { batchId: "b1", chunkId: "c1", stage: "matte", attempt: 2, durationMs: 40 });
    expect(info).toHaveBeenCalledOnce();
    expect(String(info.mock.calls[0]![0])).not.toContain("\n");
    expect(lineOf(info)).toEqual({ severity: "INFO", message: "chunk delivered", batchId: "b1", chunkId: "c1", stage: "matte", attempt: 2, durationMs: 40, [LABELS_KEY]: { app: "catalog", batchId: "b1" } });
  });
  it("adds no label without a batch and routes WARNING and ERROR to warn and error", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined), error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    log("WARNING", "matting_breaker", { service: "cpu", state: "open" });
    log("ERROR", "batch failed", { batchId: "b2", reason: "No progress for 2 hours. Start the batch again." });
    expect(lineOf(warn)).toEqual({ severity: "WARNING", message: "matting_breaker", service: "cpu", state: "open" });
    // A string error is not an Error Reporting event: no @type, no stack.
    expect(lineOf(error)).toEqual({ severity: "ERROR", message: "batch failed", batchId: "b2", reason: "No progress for 2 hours. Start the batch again.", [LABELS_KEY]: { app: "catalog", batchId: "b2" } });
  });
  it("gives an ERROR with an Error object the Error Reporting fields", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("db down");
    log("ERROR", "task handler failed", { route: "/tasks/catalog/sweep", error: failure });
    const line = lineOf(error);
    expect(line).toMatchObject({ severity: "ERROR", message: "task handler failed", route: "/tasks/catalog/sweep", error: "db down", "@type": ERROR_EVENT_TYPE });
    expect(ERROR_EVENT_TYPE).toBe("type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent");
    expect(line.stack_trace).toBe(failure.stack);
    expect(String(line.stack_trace)).toMatch(/^Error: db down\n\s+at /);
    expect(line.serviceContext).toEqual({ service: expect.any(String) });
  });
  it("names the Cloud Run service in serviceContext and keeps a WARNING's Error to its message", () => {
    expect(logEntry("ERROR", "x", { error: new Error("e") }, { K_SERVICE: "catalog-worker" }).serviceContext).toEqual({ service: "catalog-worker" });
    // A Cloud Run job sets CLOUD_RUN_JOB (not K_SERVICE); outside Cloud Run the app name is used.
    expect(logEntry("ERROR", "x", { error: new Error("e") }, { CLOUD_RUN_JOB: "catalog-qa-check" }).serviceContext).toEqual({ service: "catalog-qa-check" });
    expect(logEntry("ERROR", "x", { error: new Error("e") }, {}).serviceContext).toEqual({ service: "catalog" });
    expect(logEntry("WARNING", "chunk failed", { error: new Error("retry me") })).toEqual({ severity: "WARNING", message: "chunk failed", error: "retry me" });
  });
  it("never lets fields replace severity or message, and survives fields JSON cannot write", () => {
    expect(logEntry("INFO", "real", { severity: "ERROR", message: "fake" })).toEqual({ severity: "INFO", message: "real" });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const loop: Record<string, unknown> = {}; loop.self = loop;
    log("INFO", "chunk delivered", { batchId: "b3", loop, big: 1n });
    expect(lineOf(info)).toMatchObject({ severity: "INFO", message: "chunk delivered", batchId: "b3", [LABELS_KEY]: { app: "catalog", batchId: "b3" } });
  });
  it("never throws on null or undefined fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(() => log("INFO", "batch started", null)).not.toThrow();
    expect(() => log("INFO", "batch started", undefined)).not.toThrow();
    expect(lineOf(info)).toEqual({ severity: "INFO", message: "batch started" });
    expect(logEntry("WARNING", "w", null)).toEqual({ severity: "WARNING", message: "w" });
  });
  it("reads a severity name in any case", () => {
    expect(toSeverity("warning")).toBe("WARNING");
    expect(toSeverity("ERROR")).toBe("ERROR");
    expect(toSeverity("loud")).toBeUndefined();
    expect(toSeverity(undefined)).toBeUndefined();
  });
});
