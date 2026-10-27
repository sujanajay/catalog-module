// Tier 1: the step 1 input list of spec 14b F3 (InputList), rendered to static markup.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DID_NOT_FINISH, inputRows, InputListView, type ServerInput } from "../components/catalog/InputList";
import type { LocalUpload } from "../components/catalog/Uploader";
import { LinkFailuresView, type LinkFailureRow } from "../components/catalog/LinkFailures";
import { canRetryLinks } from "../lib/catalog/copy";
import type { LinkFailuresBlock } from "@catalog/core/catalog/ingest/types";
import UnfinishedBatches, { CancelConfirmView } from "../components/catalog/UnfinishedBatches";
import { ToastProvider } from "../components/Toast";
import { ViewerPreviewProvider } from "../components/ViewerPreview";
import type { UnfinishedBatch } from "../lib/catalog/batches";

vi.mock("next/navigation", async (actual) => ({
  ...(await actual<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }),
}));

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

describe("link failures card (spec 14b F5 part 1)", () => {
  const H = "https://example.com/test_brand";
  const block = (temporary: number): LinkFailuresBlock => ({
    total: 3, temporary, links: 27, products: 2,
    byReason: [
      { reason: "answered 'not found' (404)", count: 2, first: { url: `${H}/A_2.JPG`, where: "row 1, column 2" } },
      { reason: temporary ? "did not answer in time" : "use http instead of https", count: 1, first: { url: `${H}/B_1.JPG`, where: "row 2, column 1" } },
    ],
  });
  const card = (failures: LinkFailuresBlock, rows?: LinkFailureRow[]) => renderToStaticMarkup(createElement(LinkFailuresView, { failures, rows }));

  it("names the failures by reason with an example and where it is, and offers Show all", () => {
    const html = card(block(1));
    expect(html).toContain("<h3>Links that could not be downloaded</h3>");
    expect(html).toContain("3 of 27 links could not be downloaded (2 products affected).");
    expect(html).toContain(`2 answered &#x27;not found&#x27; (404), for example ${H}/A_2.JPG (row 1, column 2).`);
    expect(html).toContain(`1 did not answer in time, for example ${H}/B_1.JPG (row 2, column 1).`);
    expect(html).toContain(">Show all 3</button>");
  });

  it("offers Try the failed links again when some may be temporary, and not when every failure is permanent", () => {
    expect(card(block(1))).toContain(">Try the failed links again</button>");
    expect(card(block(0))).not.toContain("Try the failed links again");
    expect(canRetryLinks(block(0))).toBe(false);
    expect(canRetryLinks(block(1))).toBe(true);
  });

  it("shows the full table after Show all, and nothing when no link failed", () => {
    const html = card(block(0), [{ url: `${H}/A_2.JPG`, where: "row 1, column 2", reason: "answered 'not found' (404)" }]);
    expect(html).toContain(`<td>row 1, column 2</td>`);
    expect(html).not.toContain("Show all");
    expect(card({ total: 0, temporary: 0, links: 4, products: 0, byReason: [] })).toBe("");
  });
});

describe("Your unfinished batches (spec 14c F4 part 2)", () => {
  const ID = "0b6f3a52-6f0e-4c1e-9d1a-2f6f1b1c9e01", FAILED = "0b6f3a52-6f0e-4c1e-9d1a-2f6f1b1c9e02";
  const rows: UnfinishedBatch[] = [
    { id: ID, name: "October lot", brandName: "Test Brand", createdBy: "operator@opptra.com", age: "5 minutes ago", words: "Ready to check", fixable: false, collecting: false },
    { id: FAILED, name: "Grid paste", brandName: "Test Brand", createdBy: "other@opptra.com", age: "2 days ago", words: "Could not start: No photos could be downloaded.", fixable: true, collecting: false },
  ];
  const section = (props: { rows: UnfinishedBatch[]; canAct: boolean; showCreator: boolean }) => renderToStaticMarkup(createElement(ViewerPreviewProvider, null, createElement(ToastProvider, null, createElement(UnfinishedBatches, props))));

  it("lists each batch with its name, brand, state words, age, Continue and Cancel", () => {
    const html = section({ rows, canAct: true, showCreator: false });
    expect(html).toContain("<h2 id=\"unfinished-heading\">Your unfinished batches</h2>");
    for (const text of ["October lot", "Test Brand", "Ready to check", "created 5 minutes ago", "created 2 days ago"]) expect(html).toContain(text);
    expect(html).toContain(`<a class="btn primary sm" href="/catalog/new?batch=${ID}">Continue</a>`);
    expect(html.match(/>Cancel<\/button>/g)).toHaveLength(2);
    expect(html).not.toContain("by operator@opptra.com");
  });

  it("a batch that failed before Start carries Fix and continue instead of Continue", () => {
    const html = section({ rows: [rows[1]!], canAct: true, showCreator: false });
    expect(html).toContain("Could not start: No photos could be downloaded.");
    expect(html).toContain(">Fix and continue</button>");
    expect(html).not.toContain(">Continue</a>");
  });

  it("names the creator for an admin, and gives a viewer the rows without buttons", () => {
    expect(section({ rows, canAct: true, showCreator: true })).toContain("created 2 days ago by other@opptra.com");
    const viewer = section({ rows, canAct: false, showCreator: true });
    expect(viewer).toContain("October lot"); expect(viewer).toContain("Ready to check");
    expect(viewer).not.toContain("<button"); expect(viewer).not.toContain(">Continue</a>");
  });

  it("is absent when nothing is unfinished", () => {
    expect(section({ rows: [], canAct: true, showCreator: false })).toBe("");
  });

  it("asks inline before cancelling, with Yes, cancel and Keep it", () => {
    const yes = vi.fn(), keep = vi.fn();
    const html = renderToStaticMarkup(createElement(CancelConfirmView, { name: "October lot", onYes: yes, onKeep: keep }));
    expect(html).toContain("Cancel October lot? Nothing was processed and nothing was charged.");
    expect(html).toContain(">Yes, cancel</button>"); expect(html).toContain(">Keep it</button>");
    expect(html).not.toContain("modal");
  });
});
