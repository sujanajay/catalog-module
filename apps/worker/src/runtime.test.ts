import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { installWarningLog, WARNING_LOG_EVERY, WARNING_LOG_FIRST } from "./runtime";

describe("spec 18 H4: process warnings are logged with their stack", () => {
  it("names the emitter, event and listener count of a real MaxListenersExceededWarning", async () => {
    const log = vi.fn(), onWarning = installWarningLog(log, new EventEmitter() as never);
    const warned = once(process, "warning");
    const stream = new PassThrough();
    for (let i = 0; i < 11; i++) stream.on("error", () => {});
    const [warning] = (await warned) as [Error];
    onWarning(warning);
    expect(log).toHaveBeenCalledWith("WARNING", "process warning", expect.objectContaining({ warning: "MaxListenersExceededWarning", emitter: "PassThrough", event: "error", listeners: 11, seen: 1, stack: expect.stringContaining("runtime.test.ts") }));
  });
  it("logs the first few of a kind, then one line per thousand", () => {
    const log = vi.fn(), proc = new EventEmitter();
    installWarningLog(log, proc as never);
    for (let i = 0; i < WARNING_LOG_EVERY; i++) proc.emit("warning", Object.assign(new Error("11 close listeners added"), { name: "MaxListenersExceededWarning" }));
    proc.emit("warning", Object.assign(new Error("something else"), { name: "DeprecationWarning" }));
    expect(log).toHaveBeenCalledTimes(WARNING_LOG_FIRST + 1 + 1);
    expect(log.mock.calls[WARNING_LOG_FIRST]![2]).toMatchObject({ seen: WARNING_LOG_EVERY });
  });
});
