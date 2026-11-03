import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, test, type Page } from "@playwright/test";

// M1-S1 browser scenarios, on the intake harness (test/catalog-intake.server.ts): the real wizard,
// routes and runIngest over PGlite and in-memory storage.
// - M1-F2 acceptance test 1: the sharing email and Copy are visible before anything is pasted.
// - M1-F1 acceptance test 1 (S1 form): three brand folders of different shapes plus an xlsx of image
//   links, dragged onto the drop zone together in one drag, are grouped per folder as a person would
//   group them, with no grouping question. Starting by itself is M1-S2.
// Run: pnpm --filter @catalog/web exec playwright test --config test/catalog-intake.config.ts catalog-m1-intake

const FIXTURES = path.resolve(__dirname, "../../../packages/core/test-fixtures/catalog/intake");
const XLSX = path.join(FIXTURES, "intake-xlsx-grid.xlsx");
const EMAIL = "catalog-reader@example.iam.gserviceaccount.com";
const SHARE_LINE = `To use a Google Sheet or Drive folder, share it with ${EMAIL} as Viewer.`;

/** The three folders of the scenario: one per product (view names), flat file names, category sub-folders. */
const FOLDERS: Record<string, string[]> = {
  USPA_AW26: ["ZSKU100/front.jpg", "ZSKU100/back.jpg", "ZSKU101/front.jpg", "ZSKU101/back.jpg", "ZSKU101/side.jpg"],
  Flat: ["DEF200_1.jpg", "DEF200_2.jpg", "DEF201_1.jpg"],
  Nested: ["Men/GHI300_1.jpg", "Men/GHI300_2.jpg", "Men/GHI301_1.jpg", "Women/GHI300_3.jpg", "Women/GHI302_1.jpg"],
};
/** What a person groups the three folders into (the hand count). */
const BY_HAND: Record<string, number> = { ZSKU100: 2, ZSKU101: 3, DEF200: 2, DEF201: 1, GHI300: 3, GHI301: 1, GHI302: 1 };

let dir = "";
test.beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), "m1-s1-"));
  let k = 0;
  for (const [root, files] of Object.entries(FOLDERS)) {
    for (const f of files) {
      const target = path.join(dir, root, f);
      mkdirSync(path.dirname(target), { recursive: true });
      k++;
      // A distinct photo per file, so no two files are the same photo.
      await sharp({ create: { width: 900, height: 1200, channels: 3, background: { r: (k * 41) % 256, g: (k * 83) % 256, b: (k * 29) % 256 } } }).jpeg({ quality: 70 }).toFile(target);
    }
  }
});
/**
 * One drag of several folders and files onto the drop zone, as the operator does it from their file
 * manager: a single `drop` event whose `dataTransfer.items` hand out the folder entries
 * (webkitGetAsEntry), the way the browser does for a dragged folder. Playwright cannot drag files from
 * the desktop, so the entries are built in the page from the files on disk; the Uploader's own walk
 * and upload code does the rest.
 */
async function dragOnto(page: Page, roots: string[]) {
  const files: { path: string; b64: string; type: string }[] = [];
  const add = (abs: string, rel: string) => files.push({ path: rel, b64: readFileSync(abs).toString("base64"), type: abs.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "image/jpeg" });
  for (const root of roots) {
    if (root.endsWith(".xlsx")) add(root, path.basename(root));
    else for (const f of FOLDERS[root]!) add(path.join(dir, root, f), `${root}/${f}`);
  }
  await page.locator(".drop").evaluate((zone, list) => {
    type Node = { name: string; file?: File; children: Map<string, Node> };
    const top = new Map<string, Node>();
    for (const f of list) {
      const segs = f.path.split("/");
      let level = top;
      segs.forEach((seg, i) => {
        const node = level.get(seg) ?? { name: seg, children: new Map<string, Node>() };
        if (i === segs.length - 1) node.file = new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], seg, { type: f.type });
        level.set(seg, node);
        level = node.children;
      });
    }
    const entry = (n: Node): unknown => n.file
      ? { isFile: true, isDirectory: false, name: n.name, file: (ok: (file: File) => void) => ok(n.file!) }
      : { isFile: false, isDirectory: true, name: n.name, createReader: () => { let read = false; return { readEntries: (ok: (e: unknown[]) => void) => { ok(read ? [] : [...n.children.values()].map(entry)); read = true; } }; } };
    const items = [...top.values()].map((n) => ({ kind: "file", type: n.file?.type ?? "", webkitGetAsEntry: () => entry(n), getAsFile: () => n.file ?? null }));
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { items, files: [], types: ["Files"] } });
    zone.dispatchEvent(drop);
  }, files);
}

test.afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("M1-F2 test 1: the sharing email and Copy are visible before anything is pasted; Copy puts the email on the clipboard", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/catalog/new");
  await expect(page.getByText(SHARE_LINE)).toBeVisible();
  await expect(page.getByLabel("Or paste a link")).toHaveValue("");
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(EMAIL);
});

test("M1-F1 test 1 (S1): three folder shapes and an xlsx of links are grouped per folder with no grouping question", async ({ page }) => {
  await page.goto("/catalog/new");
  await page.getByLabel("Which brand?").selectOption("test_brand");
  await page.getByLabel("Batch name (optional)").fill("M1-S1 three folders and a sheet");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/catalog/batches") && r.request().method() === "POST");
  // The three folders and the xlsx in one drag (M1-F1-R1: several inputs in one action).
  await dragOnto(page, [...Object.keys(FOLDERS), XLSX]);
  const id = ((await (await created).json()) as { id: string }).id;
  const inputs = page.getByRole("list", { name: "What this batch holds" }).getByRole("listitem");
  await expect(inputs.filter({ hasText: /Uploaded( Remove)?$/ })).toHaveCount(14, { timeout: 60_000 });

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check what we found" })).toBeVisible({ timeout: 60_000 });
  // The per-root choice is selected with the one grouping sentence; nothing has to be answered.
  const perRoot = page.getByRole("radio", { name: /Each folder, zip and sheet on its own/ });
  await expect(perRoot).toBeChecked({ timeout: 60_000 });
  await expect(page.getByText(/^Recommended\. Folder Flat grouped by file name, folder Nested by file name, folder USPA_AW26 by folder name, sheet intake-xlsx-grid\.xlsx by column [A-Z]+ \(Option Id\)\.$/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();

  let groups: { identifier: string; shots: number }[] = [];
  let total = 0;
  await expect.poll(async () => {
    const body = (await (await page.request.get(`/api/catalog/batches/${id}/preview`)).json()) as { ready: boolean; totalRows: number; groups: { identifier: string; shots: number }[] };
    groups = body.groups; total = body.totalRows;
    return body.ready;
  }, { timeout: 60_000 }).toBe(true);
  const folderProducts = Object.fromEntries(groups.filter((g) => g.identifier in BY_HAND).map((g) => [g.identifier, g.shots]));
  expect(folderProducts).toEqual(BY_HAND);
  // The xlsx's 6 products are there too, and nothing else (no product named after a view such as "front").
  expect(total).toBe(Object.keys(BY_HAND).length + 6);
  expect(groups.some((g) => /^(front|back|side)$/i.test(g.identifier))).toBe(false);
});
