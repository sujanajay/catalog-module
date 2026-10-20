import { describe, expect, it, vi } from "vitest";
import { describeError, isTransientDbError } from "../../retry";
import { pollUntilEnd } from "./poll";

/** The error the first load run died on: Drizzle's "Failed query" wrapping Cloud SQL's 53300. */
const slotsFull = () => Object.assign(new Error('Failed query: select "id" from "catalog_batches" where "catalog_batches"."id" = $1'), {
  cause: Object.assign(new Error('remaining connection slots are reserved for roles with privileges of the "pg_use_reserved_connections" role'), { code: "53300" }),
});

/** A fake database read: fails `failures` times, then answers each status in turn. */
function fakeDb(failures: number, statuses: string[]) {
  let calls = 0;
  const read = vi.fn(async () => {
    calls++;
    if (calls <= failures) throw slotsFull();
    return { status: statuses[Math.min(calls - failures - 1, statuses.length - 1)]! };
  });
  return read;
}

const noSleep = () => vi.fn(async (_ms: number) => {});

describe("pollUntilEnd", () => {
  it("survives a read that fails twice with too many connections, then follows the batch to its end", async () => {
    const read = fakeDb(2, ["rendering", "qa", "done"]), sleep = noSleep(), seen: string[] = [], errors: string[] = [];
    const r = await pollUntilEnd({ read, isEnd: b => b.status === "done", deadline: Number.MAX_SAFE_INTEGER, intervalMs: 15_000, sleep, onValue: b => seen.push(b.status), onError: e => errors.push(e) });
    expect(r).toEqual({ ended: true, last: { status: "done" }, errors: [] });
    expect(read).toHaveBeenCalledTimes(5);
    expect(seen).toEqual(["rendering", "qa", "done"]);
    expect(errors).toEqual([]);
    // Backoff 1 s then 2 s for the two failures, then the poll interval between polls.
    expect(sleep.mock.calls.map(c => c[0])).toEqual([1000, 2000, 15_000, 15_000]);
  });

  it("records a read that fails all its retries and keeps polling until the end state", async () => {
    const read = fakeDb(5, ["done"]), errors: string[] = [];
    const r = await pollUntilEnd({ read, isEnd: b => b.status === "done", deadline: Number.MAX_SAFE_INTEGER, intervalMs: 10, sleep: noSleep(), onError: e => errors.push(e) });
    expect(r.ended).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("remaining connection slots");
    expect(errors[0]).toContain("[53300]");
  });

  it("stops at the deadline without an end state", async () => {
    let t = 0;
    const r = await pollUntilEnd({ read: async () => ({ status: "rendering" }), isEnd: b => b.status === "done", deadline: 30, intervalMs: 10, now: () => t, sleep: async ms => { t += ms; } });
    expect(r.ended).toBe(false);
    expect(r.last).toEqual({ status: "rendering" });
  });
});

describe("isTransientDbError", () => {
  it.each([
    ["too many connections behind Drizzle's wrapper", slotsFull()],
    ["connection exception", Object.assign(new Error("x"), { code: "08006" })],
    ["admin shutdown", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })],
    ["pg connection drop", new Error("Connection terminated unexpectedly")],
    ["pool connect timeout", new Error("timeout exceeded when trying to connect")],
  ])("retries %s", (_name, err) => expect(isTransientDbError(err)).toBe(true));

  it.each([
    ["a unique violation", Object.assign(new Error("duplicate key"), { code: "23505" })],
    ["a plain bug", new TypeError("x is undefined")],
  ])("does not retry %s", (_name, err) => expect(isTransientDbError(err)).toBe(false));

  it("describeError keeps the wrapped driver error", () => {
    expect(describeError(slotsFull())).toMatch(/^Failed query: .* <- caused by: remaining connection slots .* \[53300\]$/);
  });
});
