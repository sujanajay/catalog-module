import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FailedUploadStatus, UploadErrorLine, uploadFailureOf } from "../components/catalog/Uploader";
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
    expect(uploadFailureOf(new Error("Upload failed. Try again."))).toEqual({ message: "Upload failed. Try again.", batchStarted: false });
    expect(renderToStaticMarkup(createElement(FailedUploadStatus, { onRetry: noop }))).toContain("Upload failed. Try again.");
    expect(renderToStaticMarkup(createElement(UploadErrorLine, { error: null }))).toBe("");
  });
});
