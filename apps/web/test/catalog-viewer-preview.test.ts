import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// "Preview as viewer" is on: every ActionOnly control renders nothing, as for a real viewer (spec 03 UI).
vi.mock("../components/ViewerPreview", () => ({ ActionOnly: () => null }));
vi.mock("../components/AutoRefresh", () => ({ default: () => null }));
vi.mock("../lib/catalog/batches", () => ({ listBatches: vi.fn(async () => []), unfinishedBatches: vi.fn(async () => []) }));
vi.mock("../lib/user", () => ({ requireRole: vi.fn(async () => ({ email: "operator@opptra.com", role: "operator" })), atLeast: () => true }));

describe("batch list under Preview as viewer", () => {
  it("hides New batch for an operator previewing as a viewer", async () => {
    const { default: CatalogPage } = await import("../app/catalog/page");
    const html = renderToStaticMarkup(await CatalogPage());
    expect(html).toContain("Catalog images");
    expect(html).not.toContain("New batch");
  });
});
