import { describe, expect, it } from "vitest";
import { eachLimit, mapLimit, positiveIntEnv, serialLock } from "./concurrency";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("mapLimit", () => {
  it("keeps input order with at most `limit` running", async () => {
    let running = 0, peak = 0;
    const out = await mapLimit([5, 1, 3, 2], 2, async (n) => { running++; peak = Math.max(peak, running); await pause(n); running--; return n * 10; });
    expect(out).toEqual([50, 10, 30, 20]);
    expect(peak).toBe(2);
  });
});

describe("eachLimit", () => {
  it("runs `limit` at once and reports every item started", async () => {
    let running = 0, peak = 0;
    expect(await eachLimit([1, 2, 3, 4, 5], 3, async () => { running++; peak = Math.max(peak, running); await pause(2); running--; })).toBeNull();
    expect(peak).toBe(3);
  });

  it("starts nothing new after stop, lets started items finish, and returns the first not started", async () => {
    const started: number[] = [], finished: number[] = [];
    let stop = false;
    const at = await eachLimit([0, 1, 2, 3, 4, 5], 2, async (n) => { started.push(n); if (n === 1) stop = true; await pause(3); finished.push(n); }, () => stop);
    expect(started).toEqual([0, 1]);
    expect(finished.sort()).toEqual([0, 1]);
    expect(at).toBe(2);
  });

  it("after an error starts nothing new, waits for the started items, then rethrows the first error", async () => {
    const finished: number[] = [];
    await expect(eachLimit([0, 1, 2, 3], 2, async (n) => {
      if (n === 0) { await pause(1); throw new Error("first"); }
      await pause(10); finished.push(n);
      if (n === 1) throw new Error("second");
    })).rejects.toThrow("first");
    expect(finished).toEqual([1]);
  });
});

describe("serialLock", () => {
  it("runs one at a time in call order, and a failure does not block the next", async () => {
    const turn = serialLock(), order: string[] = [];
    let inside = 0, peak = 0;
    const job = (name: string, fail = false) => turn(async () => { inside++; peak = Math.max(peak, inside); await pause(2); order.push(name); inside--; if (fail) throw new Error(name); return name; });
    const results = await Promise.allSettled([job("a"), job("b", true), job("c")]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(peak).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

it("positiveIntEnv reads a positive whole number or falls back", () => {
  expect(positiveIntEnv("4", 1)).toBe(4);
  expect(positiveIntEnv(undefined, 1)).toBe(1);
  expect(positiveIntEnv("0", 1)).toBe(1);
  expect(positiveIntEnv("2.5", 1)).toBe(1);
});
