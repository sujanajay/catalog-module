// The page's fetch helper (spec 03, "Expired IAP session during fetch calls").
import { afterEach, describe, expect, it, vi } from "vitest";
import { wizardApi, WizardApiError } from "../components/catalog/wizard-client";
import { PLATFORM_ERROR, PLATFORM_TIMEOUT } from "../lib/catalog/copy";
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

// Spec 14c F11 part 1: a platform page that is not JSON gives a plain sentence, never a parse error.
describe("wizardApi platform errors", () => {
  function stubAnswer(status: number, body: string | null, contentType?: string) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status, headers: contentType ? { "Content-Type": contentType } : {} })));
  }
  const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
  const LB_PAGE = "<!DOCTYPE html><html><body><h1>504 Gateway Timeout</h1></body></html>";

  it("an HTML 504 gives the timeout sentence with the status", async () => {
    stubAnswer(504, LB_PAGE, "text/html; charset=UTF-8");
    const err = await failure(wizardApi("/api/catalog/batches/b1/detected", "PATCH", {}));
    expect(err).toBeInstanceOf(WizardApiError);
    expect(err).toMatchObject({ status: 504, message: "The server did not answer in time. Your files are safe. Reload this page to continue." });
  });

  it.each([502, 503])("an HTML %i gives the timeout sentence", async (status) => {
    stubAnswer(status, LB_PAGE, "text/html");
    expect(await failure(wizardApi("/x"))).toMatchObject({ status, message: PLATFORM_TIMEOUT });
  });

  it("any other non-JSON answer gives the general sentence", async () => {
    stubAnswer(500, "Internal Server Error", "text/plain");
    expect(await failure(wizardApi("/x"))).toMatchObject({ status: 500, message: "This did not finish. Reload this page and try again." });
    stubAnswer(200, LB_PAGE, "text/html");
    expect(await failure(wizardApi("/x"))).toMatchObject({ status: 200, message: PLATFORM_ERROR });
  });

  it("a JSON content type with a body that does not parse gives the sentence for its status", async () => {
    stubAnswer(504, "<html>", "application/json");
    expect(await failure(wizardApi("/x"))).toMatchObject({ status: 504, message: PLATFORM_TIMEOUT });
    stubAnswer(503, null, "application/json");
    expect(await failure(wizardApi("/x"))).toMatchObject({ status: 503, message: PLATFORM_TIMEOUT });
  });

  it("JSON answers behave as before: the server's sentence on a refusal, the body on success", async () => {
    stubAnswer(409, JSON.stringify({ error: "This batch has already started. Make a new batch to add more photos." }), "application/json");
    expect(await failure(wizardApi("/x", "POST", {}))).toMatchObject({ status: 409, message: "This batch has already started. Make a new batch to add more photos." });
    stubAnswer(500, JSON.stringify({}), "application/json");
    expect(await failure(wizardApi("/x"))).toMatchObject({ status: 500, message: "This did not finish. Try again." });
    stubAnswer(200, JSON.stringify({ id: "b1" }), "application/json; charset=utf-8");
    expect(await wizardApi("/x")).toEqual({ id: "b1" });
  });
});
