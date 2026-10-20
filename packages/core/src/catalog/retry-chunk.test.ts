import { describe, expect, it, vi } from "vitest";
import { CHUNK_RETRY_BUDGET_MS, COLD_START_BUDGET_MS, retryDelayMs, runUntilSettled, waitForCutOutDefault } from "./retry-chunk";

/** A fake clock whose sleep advances time, so the budgets are exercised without waiting. */
function fakeClock() {
  let t = 0;
  const sleep = vi.fn(async (ms: number) => { t += ms; });
  return { now: () => t, sleep, log: vi.fn() };
}
const retry = { httpStatus: 503, outcome: "retry" };
const done = { httpStatus: 200, outcome: "done" };

describe("retryDelayMs", () => {
  it("backs off 5, 10, 20, 30 s, then every 30 s", () => {
    expect([0, 1, 2, 3, 4, 9].map(retryDelayMs)).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000]);
  });
});

describe("runUntilSettled", () => {
  it("retries a chunk that answers retry twice, then returns its 200", async () => {
    const clock = fakeClock();
    const handler = vi.fn().mockResolvedValueOnce(retry).mockResolvedValueOnce(retry).mockResolvedValueOnce(done);
    await expect(runUntilSettled(handler, { ...clock, label: "chunk c1", reason: () => "cold" })).resolves.toEqual(done);
    expect(handler).toHaveBeenCalledTimes(3);
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([5_000, 10_000]);
    expect(clock.log).toHaveBeenCalledWith("task retry", expect.objectContaining({ task: "chunk c1", retry: 1, reason: "cold", waitMs: 5_000 }));
  });

  it("returns a non-retry failure at once", async () => {
    const clock = fakeClock();
    const failed = { httpStatus: 200, outcome: "failed" }, claimLost = { httpStatus: 503, outcome: "claim_lost" };
    await expect(runUntilSettled(async () => failed, clock)).resolves.toEqual(failed);
    await expect(runUntilSettled(async () => claimLost, clock)).resolves.toEqual(claimLost);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("gives up with the last retry result once the 10 minute budget is spent", async () => {
    const clock = fakeClock();
    const handler = vi.fn(async () => retry);
    await expect(runUntilSettled(handler, clock)).resolves.toEqual(retry);
    expect(clock.now()).toBeLessThanOrEqual(CHUNK_RETRY_BUDGET_MS);
    expect(clock.now()).toBeGreaterThan(CHUNK_RETRY_BUDGET_MS - 30_000);
    // 5 + 10 + 20 + 30 s, then 30 s waits up to 600 s: 4 + 17 waits, 22 calls.
    expect(handler).toHaveBeenCalledTimes(22);
    expect(clock.log).toHaveBeenLastCalledWith("task retry budget exhausted", expect.objectContaining({ retries: 21 }));
  });
});

describe("waitForCutOutDefault", () => {
  it("waits through a cold start until a default is reported and logs the elapsed time", async () => {
    const clock = fakeClock();
    const health = vi.fn().mockRejectedValueOnce(new Error("Background removal service returned 503.")).mockResolvedValueOnce({ default: "" }).mockResolvedValueOnce({ default: "m" });
    await expect(waitForCutOutDefault({ health }, clock)).resolves.toBe(15_000);
    expect(clock.log).toHaveBeenLastCalledWith("cut-out service warm", { elapsedMs: 15_000, checks: 3 });
  });

  it("returns at once when the services are already warm", async () => {
    const clock = fakeClock();
    await expect(waitForCutOutDefault({ health: async () => ({ default: "m" }) }, clock)).resolves.toBe(0);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it("fails after 5 minutes without a default", async () => {
    const clock = fakeClock();
    await expect(waitForCutOutDefault({ health: async () => ({ default: "" }) }, clock)).rejects.toThrow(/did not report a default within 300 seconds/);
    expect(clock.now()).toBeLessThanOrEqual(COLD_START_BUDGET_MS);
  });
});
