import { describe, expect, it, vi } from "vitest";
import { isTransientError, retryTransient } from "./retry";

const grpc = (code: number, message: string) => Object.assign(new Error(message), { code });
const noSleep = () => vi.fn(async (_ms: number) => {});

describe("isTransientError", () => {
  it.each([
    ["gRPC UNAVAILABLE (the live ECONNRESET)", Object.assign(grpc(14, "14 UNAVAILABLE: read ECONNRESET"), { details: "read ECONNRESET" })],
    ["gRPC DEADLINE_EXCEEDED", grpc(4, "4 DEADLINE_EXCEEDED")],
    ["gRPC RESOURCE_EXHAUSTED", grpc(8, "8 RESOURCE_EXHAUSTED")],
    ["gRPC INTERNAL", grpc(13, "13 INTERNAL")],
    ["HTTP 429", Object.assign(new Error("Too many"), { code: 429 })],
    ["HTTP 503 on status", Object.assign(new Error("Unavailable"), { status: 503 })],
    ["HTTP 500 on response.status", Object.assign(new Error("Backend"), { response: { status: 500 } })],
    ["socket reset", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["reset named only in the message", new Error("read ECONNRESET")],
  ])("retries %s", (_name, err) => expect(isTransientError(err)).toBe(true));

  it.each([
    ["gRPC PERMISSION_DENIED", grpc(7, "7 PERMISSION_DENIED")],
    ["gRPC ALREADY_EXISTS", grpc(6, "6 ALREADY_EXISTS")],
    ["gRPC INVALID_ARGUMENT", grpc(3, "3 INVALID_ARGUMENT")],
    ["HTTP 403", Object.assign(new Error("Forbidden"), { code: 403 })],
    ["a plain bug", new TypeError("x is undefined")],
    ["not an error", "boom"],
  ])("does not retry %s", (_name, err) => expect(isTransientError(err)).toBe(false));
});

describe("retryTransient", () => {
  it("retries UNAVAILABLE and returns the later success", async () => {
    const sleep = noSleep();
    const fn = vi.fn().mockRejectedValueOnce(grpc(14, "14 UNAVAILABLE: read ECONNRESET")).mockResolvedValueOnce("ok");
    await expect(retryTransient(fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("surfaces a permanent error at once, without waiting", async () => {
    const sleep = noSleep();
    const denied = grpc(7, "7 PERMISSION_DENIED");
    const fn = vi.fn().mockRejectedValue(denied);
    await expect(retryTransient(fn, { sleep })).rejects.toBe(denied);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after 5 tries with doubling waits capped at 8 s, about 15 s in all", async () => {
    const sleep = noSleep();
    const fn = vi.fn().mockRejectedValue(grpc(14, "14 UNAVAILABLE"));
    await expect(retryTransient(fn, { sleep })).rejects.toThrow(/UNAVAILABLE/);
    expect(fn).toHaveBeenCalledTimes(5);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000, 8000]);
  });
});
