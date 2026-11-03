// M6-F2-R2 and R3 (M6-S4): a draining worker answers new deliveries 503 without running the handler; a body newer than
// this worker waits (503) for the revision that wrote it; the previous release's bodies (version 1, no field) and the
// current ones run. Drain hooks run once, together, within their time limit.
import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TASK_BODY_VERSION, TASK_VERSION_FIELD, versionedBody } from "@catalog/core/tasks";
import type { AuthConfig } from "./auth";
import { createServer, type RouteHandler } from "./server";
import { isDraining, onDrain, resetDrain, startDrain } from "./drain";

const sweep = vi.fn<RouteHandler>();
const auth = { verifier: {}, audience: "x", serviceAccountEmail: "x", skip: true } as unknown as AuthConfig;
let draining = false;
let server: http.Server;
let base: string;

beforeAll(async () => {
  server = createServer({ auth, version: "test", routes: { "/tasks/catalog/sweep": sweep }, draining: () => draining });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { draining = false; sweep.mockReset(); resetDrain(); });

const post = (body: unknown) => fetch(`${base}/tasks/catalog/sweep`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("deliveries while draining and across releases", () => {
  it("runs the previous release's body (no version) and the current one", async () => {
    sweep.mockResolvedValue({ httpStatus: 200, outcome: "swept:0" });
    expect((await post({})).status).toBe(200);
    expect((await post(versionedBody({}))).status).toBe(200);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sweep.mock.calls[1]![0]).toEqual({ [TASK_VERSION_FIELD]: TASK_BODY_VERSION });
  });

  it("answers a body newer than this worker 503 without running it", async () => {
    const res = await post({ [TASK_VERSION_FIELD]: TASK_BODY_VERSION + 1 });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ outcome: "newer_task_body" });
    expect(sweep).not.toHaveBeenCalled();
  });

  it("answers 503 while draining and never starts the handler", async () => {
    draining = true;
    const res = await post({});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ outcome: "draining" });
    expect(sweep).not.toHaveBeenCalled();
  });
});

describe("drain hooks", () => {
  it("run once when draining starts; a removed hook does not; a hook added later runs at once", async () => {
    const a = vi.fn(), b = vi.fn(), late = vi.fn();
    onDrain(a);
    const removeB = onDrain(b);
    removeB();
    expect(isDraining()).toBe(false);
    await startDrain();
    await startDrain();
    expect(isDraining()).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    onDrain(late);
    await new Promise((r) => setTimeout(r, 0));
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("a slow or failing hook does not hold the drain past its limit", async () => {
    onDrain(() => new Promise(() => undefined));
    onDrain(() => { throw new Error("boom"); });
    const started = Date.now();
    await startDrain(50);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
