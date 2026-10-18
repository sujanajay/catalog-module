// The page's fetch helper (spec 03, "Expired IAP session during fetch calls").
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, SESSION_ENDED_MESSAGE, SessionEndedError } from "../lib/fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("apiFetch", () => {
  it("sends X-Requested-With: XMLHttpRequest and keeps the caller's headers and options", async () => {
    const fetchMock = stubFetch(200);
    const res = await apiFetch("/api/people", { method: "POST", headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(200);
    const init = fetchMock.mock.calls[0]![1]!;
    const headers = new Headers(init.headers);
    expect(init.method).toBe("POST");
    expect(headers.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("passes other error statuses through for the caller to read", async () => {
    stubFetch(403);
    expect((await apiFetch("/api/people")).status).toBe(403);
  });

  it("throws SessionEndedError with the toast sentence on a 401", async () => {
    stubFetch(401);
    const err = await apiFetch("/api/people").then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SessionEndedError);
    expect(err).toMatchObject({ message: SESSION_ENDED_MESSAGE });
    expect(SESSION_ENDED_MESSAGE).toBe("Your session ended. Reload to sign in again.");
  });
});
