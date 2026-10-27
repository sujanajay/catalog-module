// Tier 1: spec 15 timers. The real heartbeat timer renews every 30 s, stops when the deadline is reached
// or when the delivery stops it, and survives a failed renewal. The QA back-off allowance never reaches past
// the delivery's deadline margin.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHUNK_HEARTBEAT_MS } from "@catalog/core/catalog/pipeline/dispatch";
import { defaultHeartbeat } from "./chunk";
import { backoffFor, limitDeliveryBackoff, QA_DELIVERY_BACKOFF_MS } from "./qa-stage";

afterEach(() => { vi.useRealTimers(); });

describe("defaultHeartbeat", () => {
  it("renews every 30 s and stops by itself once renew reports the deadline", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const renew = vi.fn(async () => ++calls < 3);
    defaultHeartbeat(renew);
    await vi.advanceTimersByTimeAsync(CHUNK_HEARTBEAT_MS - 1);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHUNK_HEARTBEAT_MS * 5);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it("keeps beating after a failed renewal and stops when the delivery stops it", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockRejectedValueOnce(new Error("connection reset")).mockResolvedValue(true);
    const stop = defaultHeartbeat(renew);
    await vi.advanceTimersByTimeAsync(CHUNK_HEARTBEAT_MS * 2);
    expect(renew).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(CHUNK_HEARTBEAT_MS * 4);
    expect(renew).toHaveBeenCalledTimes(2);
  });
});

describe("limitDeliveryBackoff", () => {
  it("allows the smaller of the 300 s allowance and the time left before the margin, shrinking with the clock", () => {
    const batch = {} as Parameters<typeof backoffFor>[0];
    let t = 0;
    limitDeliveryBackoff(batch, 1_000_000, () => new Date(t));
    expect(backoffFor(batch).remainingMs).toBe(QA_DELIVERY_BACKOFF_MS);
    t = 800_000;
    expect(backoffFor(batch).remainingMs).toBe(200_000);
    t = 1_100_000;
    expect(backoffFor(batch).remainingMs).toBe(0);
  });

  it("spending lowers the allowance and never raises it", () => {
    const batch = {} as Parameters<typeof backoffFor>[0];
    limitDeliveryBackoff(batch, 10_000_000, () => new Date(0));
    const budget = backoffFor(batch);
    budget.remainingMs -= 100_000;
    expect(budget.remainingMs).toBe(QA_DELIVERY_BACKOFF_MS - 100_000);
    budget.remainingMs = QA_DELIVERY_BACKOFF_MS;
    expect(budget.remainingMs).toBe(QA_DELIVERY_BACKOFF_MS - 100_000);
  });
});
