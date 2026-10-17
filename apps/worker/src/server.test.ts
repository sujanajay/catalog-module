import type { AddressInfo } from "node:net";
import type http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig, IdTokenVerifier } from "./auth";
import { createServer, type RouteHandler } from "./server";

const SA = "catalog-worker@image-links-agent.iam.gserviceaccount.com";
const AUD = "https://catalog-worker-847405579637.asia-south1.run.app";

const verifyIdToken = vi.fn();
const syncMaster = vi.fn<RouteHandler>();
const sweep = vi.fn<RouteHandler>();
const auth: AuthConfig = {
  verifier: { verifyIdToken } as unknown as IdTokenVerifier,
  audience: AUD,
  serviceAccountEmail: SA,
  skip: false,
};

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = createServer({
    auth,
    version: "catalog-worker-00001-abc",
    routes: { "/tasks/catalog/sync-master": syncMaster, "/tasks/catalog/sweep": sweep },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  verifyIdToken.mockReset();
  syncMaster.mockReset();
  sweep.mockReset();
  syncMaster.mockResolvedValue({ httpStatus: 200, outcome: "synced:3/40" });
  sweep.mockResolvedValue({ httpStatus: 200, outcome: "swept:0" });
  auth.skip = false;
});

const tokenFor = (email: string, verified = true) =>
  verifyIdToken.mockResolvedValue({ getPayload: () => ({ email, email_verified: verified }) });

const post = (path: string, headers: Record<string, string> = {}, body: unknown = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("worker HTTP", () => {
  it("GET /healthz lists the routes without auth", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: "catalog-worker-00001-abc",
      routes: ["/tasks/catalog/sync-master", "/tasks/catalog/sweep"],
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("405 for anything but POST outside /healthz", async () => {
    expect((await fetch(`${base}/tasks/catalog/sweep`)).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(405);
    expect((await fetch(`${base}/tasks/catalog/sweep`, { method: "PUT" })).status).toBe(405);
  });

  it("401 without a bearer token", async () => {
    const res = await post("/tasks/catalog/sweep");
    expect(res.status).toBe(401);
    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
  });

  it("401 when the token does not verify", async () => {
    verifyIdToken.mockRejectedValue(new Error("Wrong recipient"));
    expect((await post("/tasks/catalog/sweep", { authorization: "Bearer bad" })).status).toBe(401);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("403 for a token from another service account or an unverified email", async () => {
    tokenFor("someone-else@image-links-agent.iam.gserviceaccount.com");
    expect((await post("/tasks/catalog/sweep", { authorization: "Bearer tok" })).status).toBe(403);
    tokenFor(SA, false);
    expect((await post("/tasks/catalog/sweep", { authorization: "Bearer tok" })).status).toBe(403);
    expect(sweep).not.toHaveBeenCalled();
  });

  it("500 when worker auth is not configured", async () => {
    const saved = auth.audience;
    auth.audience = undefined;
    try {
      expect((await post("/tasks/catalog/sweep", { authorization: "Bearer tok" })).status).toBe(500);
    } finally {
      auth.audience = saved;
    }
  });

  it("404 for an unknown route after auth", async () => {
    tokenFor(SA);
    expect((await post("/tasks/catalog/publish", { authorization: "Bearer tok" })).status).toBe(404);
    expect((await post("/tasks/catalog/constructor", { authorization: "Bearer tok" })).status).toBe(404);
  });

  it("400 unless the body is a JSON object", async () => {
    tokenFor(SA);
    for (const body of ["not json", "", "[1,2]", "null", "42"]) {
      expect((await post("/tasks/catalog/sweep", { authorization: "Bearer tok" }, body)).status).toBe(400);
    }
    expect(sweep).not.toHaveBeenCalled();
  });

  it("413 for a body over 64 KB", async () => {
    tokenFor(SA);
    const res = await post("/tasks/catalog/sweep", { authorization: "Bearer tok" }, { pad: "x".repeat(70 * 1024) });
    expect(res.status).toBe(413);
  });

  it("dispatches to the right handler with the body and the Cloud Tasks retry count", async () => {
    tokenFor(SA);
    syncMaster.mockResolvedValue({ httpStatus: 503, outcome: "bigquery_unavailable" });
    const res = await post("/tasks/catalog/sync-master", { authorization: "Bearer tok", "x-cloudtasks-taskretrycount": "2" }, { a: 1 });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ outcome: "bigquery_unavailable" });
    expect(verifyIdToken).toHaveBeenCalledWith({ idToken: "tok", audience: AUD });
    expect(syncMaster).toHaveBeenCalledWith({ a: 1 }, { retryCount: 2 });
    expect(sweep).not.toHaveBeenCalled();

    const res2 = await post("/tasks/catalog/sweep", { authorization: "Bearer tok" });
    expect(res2.status).toBe(200);
    expect(await res2.json()).toEqual({ outcome: "swept:0" });
    expect(sweep).toHaveBeenCalledWith({}, { retryCount: undefined });
  });

  it("logs an unexpected throw as structured JSON and answers 500", async () => {
    tokenFor(SA);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sweep.mockRejectedValue(new Error("db down"));
    const res = await post("/tasks/catalog/sweep", { authorization: "Bearer tok" });
    expect(res.status).toBe(500);
    const line = JSON.parse(String(errorLog.mock.calls[0]![0])) as Record<string, unknown>;
    expect(line).toMatchObject({ severity: "ERROR", route: "/tasks/catalog/sweep", error: "db down" });
    errorLog.mockRestore();
  });

  it("SKIP_OIDC bypasses verification (local dev)", async () => {
    auth.skip = true;
    expect((await post("/tasks/catalog/sweep")).status).toBe(200);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
});
