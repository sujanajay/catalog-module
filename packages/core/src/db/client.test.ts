import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkBudget, formatBudget, parseBudget } from "./budget";
import { connectWithRetry, isTooManyConnections, RetryingPool } from "./client";

const tooMany = () => Object.assign(new Error("remaining connection slots are reserved for roles with privileges of the pg_use_reserved_connections role"), { code: "53300" });
const noSleep = () => Promise.resolve();

describe("isTooManyConnections", () => {
  it("matches SQLSTATE 53300 and the slot messages, nothing else", () => {
    expect(isTooManyConnections(tooMany())).toBe(true);
    expect(isTooManyConnections(new Error("sorry, too many clients already"))).toBe(true);
    expect(isTooManyConnections(Object.assign(new Error("relation does not exist"), { code: "42P01" }))).toBe(false);
    expect(isTooManyConnections(undefined)).toBe(false);
  });
});

describe("connectWithRetry", () => {
  it("retries too-many-connections with growing waits and then succeeds", async () => {
    const waits: number[] = [];
    let calls = 0;
    const got = await connectWithRetry(async () => {
      calls++;
      if (calls < 3) throw tooMany();
      return "client";
    }, { sleep: async ms => { waits.push(ms); }, baseMs: 100 });
    expect(got).toBe("client");
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
    expect(waits[1]!).toBeGreaterThan(waits[0]!);
  });

  it("is bounded: rethrows after the last attempt", async () => {
    let calls = 0;
    await expect(connectWithRetry(async () => { calls++; throw tooMany(); }, { attempts: 4, sleep: noSleep })).rejects.toMatchObject({ code: "53300" });
    expect(calls).toBe(4);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(connectWithRetry(async () => { calls++; throw new Error("password authentication failed"); }, { sleep: noSleep })).rejects.toThrow("password");
    expect(calls).toBe(1);
  });
});

describe("RetryingPool", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retries pool.connect() in both the promise and the callback form (query() uses the callback form)", async () => {
    const client = { release: vi.fn() } as unknown as pg.PoolClient;
    let calls = 0;
    vi.spyOn(pg.Pool.prototype, "connect").mockImplementation((() => {
      calls++;
      return calls % 2 === 1 ? Promise.reject(tooMany()) : Promise.resolve(client);
    }) as never);
    const pool = new RetryingPool({ max: 1 }, { sleep: noSleep, onRetry: () => {} });
    await expect(pool.connect()).resolves.toBe(client);
    const viaCallback = await new Promise<pg.PoolClient | undefined>((resolve, reject) =>
      pool.connect((err, c) => (err ? reject(err) : resolve(c))));
    expect(viaCallback).toBe(client);
    expect(calls).toBe(4);
  });
});

describe("connection budget", () => {
  it("the deployed shape fits db-f1-micro with the ila share", () => {
    const b = parseBudget("max=25;reserved=3;ila=4;worker=4x2;web=3x2;jobs=2x1");
    const c = checkBudget(b);
    expect(c).toMatchObject({ available: 22, catalogLimit: 18, catalogTotal: 16, headroom: 2, fits: true });
    expect(formatBudget(b)).toContain("= 16");
  });

  it("the incident shape does not fit", () => {
    expect(checkBudget(parseBudget("max=25,reserved=3,ila=4,worker=10x2,web=3x3,jobs=1x2")).fits).toBe(false);
  });

  it("rejects a malformed budget", () => {
    expect(() => parseBudget("max=25,reserved=3,ila=4,worker=4,web=3x2,jobs=2x1")).toThrow("worker");
  });
});
