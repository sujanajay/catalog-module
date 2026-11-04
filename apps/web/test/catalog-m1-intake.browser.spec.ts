import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { expect, test, type Page } from "@playwright/test";

// M1-S1 and M1-S2 browser scenarios, on the intake harness (test/catalog-intake.server.ts): the real one-page New
// batch, routes, runIngest and the auto-start task over PGlite and in-memory storage.
// - M1-F2 acceptance test 1: the sharing email and Copy are visible before anything is pasted.
// - M1-F1 acceptance test 1 (S1 form): three brand folders of different shapes plus an xlsx of image
//   links, dragged onto the drop zone together in one drag, are grouped per folder as a person would
//   group them, with no grouping question.
// - M1-F2 acceptance tests 2-4 (M1-S2) and the UX 13.1 action budgets (UX3 guard): T2, an every-day upload of a
//   brand the names identify, is 2 required actions (open, drop) and 0 after the drop; T1, a brand that must be
//   asked, is at most 3 (open, drop, brand) with none after the brand, and under 60 s to walking away.
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
  // M1-S2: option ids of Vero Moda in the harness SKU master (listed on Noon and Namshi), and names nobody knows.
  VM_AW26: ["VM10001BLACK_1.jpg", "VM10001BLACK_2.jpg", "VM10002WHITE_1.jpg"],
  // Another Vero Moda delivery: the harness never finishes a batch, so test 4 needs products test 2 does not lock.
  VM_SS27: ["VM10003NAVY_1.jpg", "VM10003NAVY_2.jpg"],
  Unknown: ["QQQ900_1.jpg", "QQQ901_1.jpg"],
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

// The auto-start task runs after its own 10 s countdown in these scenarios (catalog-intake's scenarios lengthen it).
test.beforeEach(async ({ page }) => {
  expect((await page.request.post("/harness/queue", { data: { autoStartDelayMs: null } })).ok()).toBe(true);
  // Started batches of earlier scenarios (or runs on a reused server) are finished, so their products are free.
  expect((await page.request.post("/harness/settle")).ok()).toBe(true);
});

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
  // The brand is chosen up front (?brand=), so this scenario is only about grouping.
  await page.goto("/catalog/new?brand=test_brand");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/catalog/batches") && r.request().method() === "POST");
  // The three folders and the xlsx in one drag (M1-F1-R1: several inputs in one action).
  await dragOnto(page, ["USPA_AW26", "Flat", "Nested", XLSX]);
  const id = ((await (await created).json()) as { id: string }).id;
  const inputs = page.getByRole("list", { name: "What this batch holds" }).getByRole("listitem");
  await expect(inputs.filter({ hasText: /Uploaded( Remove)?$/ })).toHaveCount(14, { timeout: 60_000 });

  // No Continue: collection starts by itself. Wait, so the batch stays a draft while the grouping is read.
  await page.getByRole("button", { name: "Wait", exact: true }).click({ timeout: 90_000 });
  // The one grouping sentence is shown under What we found; nothing has to be answered.
  await expect(page.getByText(/Folder Flat grouped by file name, folder Nested by file name, folder USPA_AW26 by folder name, sheet intake-xlsx-grid\.xlsx by column [A-Z]+ \(Option Id\)\.$/).first()).toBeVisible({ timeout: 60_000 });
  await page.locator("summary", { hasText: "Change how products are grouped" }).click();
  await expect(page.getByRole("radio", { name: /Each folder, zip and sheet on its own/ })).toBeChecked();

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

/**
 * The UX 13.1 action budget guard (UX3): every required action of a flow goes through `act`, which counts it; the
 * flow then waits with no action at all. `afterDrop` counts the actions after the drop (or after the brand answer).
 */
function budget() {
  let actions = 0; let marker = -1;
  return {
    act: async <T>(run: () => Promise<T>) => { actions++; return run(); },
    mark: () => { marker = actions; },
    get actions() { return actions; },
    get afterMark() { return marker < 0 ? 0 : actions - marker; },
  };
}
const batchIdOf = (url: string) => /\/catalog\/([0-9a-f-]{36})(?:$|[?#])/.exec(url)?.[1] ?? null;

test("M1-F2 test 2 and T2: a Vero Moda folder starts by itself with the channels where Vero Moda is listed, and the batch page opens", async ({ page }) => {
  const b = budget();
  await b.act(() => page.goto("/catalog/new"));
  const created = page.waitForResponse((r) => r.url().endsWith("/api/catalog/batches") && r.request().method() === "POST");
  await b.act(() => dragOnto(page, ["VM_AW26"]));
  b.mark();
  const id = ((await (await created).json()) as { id: string }).id;
  // R3: the brand is read from the option ids; R4: the channels are where the brand is listed (M0), not the usual five.
  await expect(page.getByText("Brand: Vero Moda")).toBeVisible();
  await expect(page.getByText("Going to: Noon, Namshi (where this brand is listed).")).toBeVisible();
  await expect(page.getByText("Which brand is this?")).toHaveCount(0);
  await expect(page.getByText(/^Starting in \d+ s\. Change anything above, or Wait\./)).toBeVisible({ timeout: 90_000 });
  // R6 and R8: it starts by itself after the countdown and the batch page opens; no click.
  await page.waitForURL(new RegExp(`/catalog/${id}$`), { timeout: 90_000 });
  const batch = (await (await page.request.get(`/api/catalog/batches/${id}`)).json()) as { batch: { status: string; channels: string[]; startedAt: string | null } };
  expect(batch.batch.startedAt).not.toBeNull();
  expect(batch.batch.channels).toEqual(["noon", "namshi"]);
  // T2: 2 required actions (open, drop), 0 after the drop.
  expect(b.actions).toBe(2);
  expect(b.afterMark).toBe(0);
});

test("M1-F2 test 3 and T1: unknown names ask one question, the brand; after choosing it no other click is needed", async ({ page }) => {
  const b = budget();
  const t0 = Date.now();
  await b.act(() => page.goto("/catalog/new"));
  await b.act(() => dragOnto(page, ["Unknown"]));
  const question = page.getByLabel("Which brand is this?");
  await expect(question).toBeVisible({ timeout: 30_000 });
  const created = page.waitForResponse((r) => r.url().endsWith("/api/catalog/batches") && r.request().method() === "POST");
  await b.act(() => question.selectOption("test_brand"));
  b.mark();
  const walkAway = Date.now() - t0;
  const id = ((await (await created).json()) as { id: string }).id;
  // The dropped files upload once the brand is chosen; the usual five channels; then it starts by itself.
  await expect(page.getByText("Going to: Namshi, Noon, Trendyol, Styli, Centrepoint.")).toBeVisible();
  await expect(page.getByText("You can close this page. We will keep going.")).toBeVisible();
  await page.waitForURL(new RegExp(`/catalog/${id}$`), { timeout: 120_000 });
  // T1: at most 3 required actions, none after the brand, and under 60 s to walking away.
  expect(b.actions).toBeLessThanOrEqual(3);
  expect(b.afterMark).toBe(0);
  expect(walkAway).toBeLessThan(60_000);
});

test("M1-F2 test 4: Wait during the countdown keeps the batch a draft with one Start button", async ({ page }) => {
  // Collection, the 10 s countdown, a 12 s wait past it and a Start: more than the 120 s default on a slow runner.
  test.setTimeout(240_000);
  await page.goto("/catalog/new");
  const created = page.waitForResponse((r) => r.url().endsWith("/api/catalog/batches") && r.request().method() === "POST");
  await dragOnto(page, ["VM_SS27"]);
  const id = ((await (await created).json()) as { id: string }).id;
  await expect(page.getByText(/^Starting in \d+ s\./)).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Wait", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(1);
  await expect(page.getByText(/^Starting in/)).toHaveCount(0);
  // Past the 10 s countdown the batch is still a draft and the page has not moved.
  await page.waitForTimeout(12_000);
  expect(batchIdOf(page.url())).toBeNull();
  const batch = (await (await page.request.get(`/api/catalog/batches/${id}`)).json()) as { batch: { status: string; startedAt: string | null; options: { autoStart?: boolean } } };
  expect(batch.batch).toMatchObject({ status: "draft", startedAt: null, options: { autoStart: false } });
  // The one Start button starts it.
  await page.getByRole("button", { name: "Start", exact: true }).click();
  // Start writes the chunk rows and queues the first ones; on the in-process harness this alone can take a minute.
  await page.waitForURL(new RegExp(`/catalog/${id}$`), { timeout: 150_000 });
});
