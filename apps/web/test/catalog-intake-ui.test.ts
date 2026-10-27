// Tier 1: the step 1 input list of spec 14b F3 (InputList), rendered to static markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DID_NOT_FINISH, inputRows, InputListView, type ServerInput } from "../components/catalog/InputList";
import type { LocalUpload } from "../components/catalog/Uploader";

const server = (id: string, status: string, extra: Partial<ServerInput> = {}): ServerInput => ({ id, kind: "image", name: `${id}.jpg`, relativePath: `${id}.jpg`, sizeBytes: 2 * 1024 * 1024, status, error: null, ...extra });
const local = (key: string, extra: Partial<LocalUpload> = {}): LocalUpload => ({ key, name: `${key}.jpg`, relativePath: `${key}.jpg`, size: 1024 * 1024, progress: 40, status: "uploading", retry: vi.fn(), remove: vi.fn(), ...extra });
const render = (rows: ReturnType<typeof inputRows>) => renderToStaticMarkup(createElement(InputListView, { rows }));
const none = new Set<string>();

describe("input list (spec 14b F3)", () => {
  it("shows a pending server row this session is not uploading as cut off, with Remove", () => {
    const removeServer = vi.fn();
    const rows = inputRows([server("CUT_1", "pending")], [], none, removeServer);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe(DID_NOT_FINISH);
    const html = render(rows);
    expect(html).toContain("Upload did not finish. Add the file again or remove it.");
    expect(html).toContain(">Remove</button>");
    expect(html).toContain("CUT_1.jpg");
    rows[0]!.remove!();
    expect(removeServer).toHaveBeenCalledWith(expect.objectContaining({ id: "CUT_1" }));
  });

  it("shows a pending server row this session is uploading with its progress, not as cut off", () => {
    const rows = inputRows([server("u-1", "pending")], [local("a", { uploadId: "u-1", progress: 40 })], none, vi.fn());
    expect(rows.map((r) => r.state)).toEqual(["Uploading 40%"]);
    expect(render(rows)).not.toContain(DID_NOT_FINISH);
  });

  it("lists every kind with its kind word, name, size and state word", () => {
    const rows = inputRows([
      server("u-1", "uploaded"),
      server("u-2", "collected", { kind: "zip", name: "photos.zip", relativePath: "photos.zip" }),
      server("u-3", "uploaded", { kind: "url_list", name: "Image links", relativePath: null, sizeBytes: null }),
      server("u-4", "failed", { kind: "google_sheet", name: "https://docs.google.com/spreadsheets/d/x", relativePath: null, sizeBytes: null, error: "Share the sheet with the address above, then paste it again." }),
      server("u-5", "failed"),
    ], [], none, vi.fn());
    expect(rows.map((r) => r.state)).toEqual(["Uploaded", "Checked", "Uploaded", "Share the sheet with the address above, then paste it again.", "Upload failed. Try again or remove it."]);
    const html = render(rows);
    for (const word of ["Photo", "Zip", "Pasted links", "Google Sheet", "photos.zip", "2.0 MB"]) expect(html).toContain(word);
    expect(html.match(/>Remove<\/button>/g)).toHaveLength(5);
  });

  it("hides older removed rows and shows the ones removed here as Removed, without Remove", () => {
    const rows = inputRows([server("old", "removed"), server("now", "removed")], [], new Set(["now"]), vi.fn());
    expect(rows.map((r) => [r.key, r.state])).toEqual([["now", "Removed"]]);
    expect(render(rows)).not.toContain(">Remove</button>");
  });

  it("gives a failed upload of this session Retry and Remove, and lists files not yet planned", () => {
    const failed = local("f", { uploadId: "u-9", status: "failed", failure: { message: "Upload failed. Try again or remove it.", batchStarted: false } });
    const queued = local("q", { status: "queued", progress: 0 });
    const rows = inputRows([server("u-9", "pending")], [failed, queued], none, vi.fn());
    expect(rows.map((r) => r.state)).toEqual(["Upload failed. Try again or remove it.", "Uploading 0%"]);
    const html = render(rows);
    expect(html).toContain(">Retry</button>");
    expect(html).toContain(">Remove</button>");
    expect(html).not.toContain(DID_NOT_FINISH);
  });

  it("renders nothing for an empty batch", () => {
    expect(render(inputRows([], [], none, vi.fn()))).toBe("");
  });
});
