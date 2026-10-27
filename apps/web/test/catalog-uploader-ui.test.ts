import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SIGNED_PUT_TTL_SEC } from "@catalog/core/storage";
import { FailedUploadStatus, planExpired, sendFile, SIGNED_PUT_TTL_MS, UPLOAD_FAILED, UploadErrorLine, uploadFailureOf, type Plan, type SendDeps } from "../components/catalog/Uploader";
import { WizardApiError } from "../components/catalog/wizard-client";

const STARTED = "This batch has already started. Make a new batch to add more photos.";
const noop = () => {};

describe("uploader errors", () => {
  it("shows the server's sentence, Retry and a new-batch link when the batch has already started", () => {
    const failure = uploadFailureOf(new WizardApiError(STARTED, 409));
    expect(failure).toEqual({ message: STARTED, batchStarted: true });
    const row = renderToStaticMarkup(createElement(FailedUploadStatus, { failure, onRetry: noop }));
    expect(row).toContain(STARTED);
    expect(row).not.toContain("Upload failed");
    expect(row).toContain(">Retry</button>");
    expect(row).toContain('href="/catalog/new"');
    expect(row).toContain("Start a new batch");
    const line = renderToStaticMarkup(createElement(UploadErrorLine, { error: failure }));
    expect(line).toContain('role="alert"');
    expect(line).toContain(STARTED);
    expect(line).toContain('href="/catalog/new"');
  });

  it("shows any other server sentence with Retry and no new-batch link", () => {
    const failure = uploadFailureOf(new WizardApiError("photo.jpg did not finish uploading. Try again.", 400));
    const row = renderToStaticMarkup(createElement(FailedUploadStatus, { failure, onRetry: noop }));
    expect(row).toContain("photo.jpg did not finish uploading. Try again.");
    expect(row).toContain(">Retry</button>");
    expect(row).not.toContain("/catalog/new");
    expect(renderToStaticMarkup(createElement(UploadErrorLine, { error: failure }))).not.toContain("/catalog/new");
  });

  it("falls back to the generic sentence for a network failure and renders no error line when clear", () => {
    expect(uploadFailureOf(new Error(UPLOAD_FAILED))).toEqual({ message: "Upload failed. Try again or remove it.", batchStarted: false });
    expect(renderToStaticMarkup(createElement(FailedUploadStatus, { onRetry: noop }))).toContain("Upload failed. Try again or remove it.");
    expect(renderToStaticMarkup(createElement(UploadErrorLine, { error: null }))).toBe("");
  });

  it("gives a failed row Remove next to Retry (spec 14b F3)", () => {
    const row = renderToStaticMarkup(createElement(FailedUploadStatus, { onRetry: noop, onRemove: noop }));
    expect(row).toContain(">Retry</button>");
    expect(row).toContain(">Remove</button>");
  });
});

describe("uploader retry after the signed link expired (spec 14b F3)", () => {
  type Call = { url: string; method: string };
  function fakes(start: number) {
    const calls: Call[] = [];
    let clock = start;
    let plans = 0;
    let failPut = true;
    const deps: SendDeps = {
      api: async <T,>(url: string, method = "GET") => {
        calls.push({ url, method });
        if (url.endsWith("/uploads") && method === "POST") { plans++; return [{ uploadId: `00000000-0000-0000-0000-00000000000${plans}`, putUrl: `https://upload.example/${plans}`, headers: {} }] as T; }
        return {} as T;
      },
      put: async () => { if (failPut) throw new Error(UPLOAD_FAILED); },
      now: () => clock,
    };
    return { calls, deps, advance: (ms: number) => { clock += ms; }, healPut: () => { failPut = false; } };
  }
  const file = new File([new Uint8Array(10)], "ABC_1.jpg", { type: "image/jpeg" });
  const BATCH = "11111111-1111-1111-1111-111111111111";

  it("matches the server's signed PUT lifetime", () => {
    expect(SIGNED_PUT_TTL_MS).toBe(SIGNED_PUT_TTL_SEC * 1000);
  });

  it("plans again before the PUT when the failed row's plan is older than the TTL", async () => {
    const f = fakes(1_000_000);
    const row: { file: File; relativePath: string; plan?: Plan; plannedAt?: number } = { file, relativePath: "ABC_1.jpg" };
    const on = { plan: (plan: Plan, at: number) => { row.plan = plan; row.plannedAt = at; }, progress: noop };
    await expect(sendFile(row, BATCH, f.deps, on)).rejects.toThrow(UPLOAD_FAILED);
    expect(f.calls.filter((c) => c.url.endsWith("/uploads") && c.method === "POST")).toHaveLength(1);
    f.advance(SIGNED_PUT_TTL_MS + 1);
    f.healPut();
    await sendFile(row, BATCH, f.deps, on);
    const posts = f.calls.filter((c) => c.url.endsWith("/uploads") && c.method === "POST");
    expect(posts).toHaveLength(2);
    // The expired row is removed first, so the batch does not wait for it; the new plan is completed.
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(`/api/catalog/batches/${BATCH}`, "")}`)).toEqual([
      "POST /uploads",
      "DELETE /uploads/00000000-0000-0000-0000-000000000001",
      "POST /uploads",
      "POST /uploads/00000000-0000-0000-0000-000000000002/complete",
    ]);
  });

  it("reuses a plan that is still fresh on Retry", async () => {
    const f = fakes(5_000);
    const row: { file: File; relativePath: string; plan?: Plan; plannedAt?: number } = { file, relativePath: "ABC_1.jpg" };
    const on = { plan: (plan: Plan, at: number) => { row.plan = plan; row.plannedAt = at; }, progress: noop };
    await expect(sendFile(row, BATCH, f.deps, on)).rejects.toThrow();
    f.advance(60_000); f.healPut();
    await sendFile(row, BATCH, f.deps, on);
    expect(f.calls.filter((c) => c.url.endsWith("/uploads") && c.method === "POST")).toHaveLength(1);
    expect(f.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(planExpired(row.plannedAt, row.plannedAt! + SIGNED_PUT_TTL_MS)).toBe(true);
  });
});
