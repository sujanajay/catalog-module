import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

// Intake scenarios of spec 14a section 6 (1 and 6), spec 14b section 6 (2 and 4) and spec 14c section 6
// (3 and 5 in their release C form, and 7), run against the local harness (test/catalog-intake.server.ts):
// the real wizard, pages and routes, PGlite, in-memory storage, a fake queue running the real
// runIngest, and a fake image host (also behind POST /links). Sentences in quotes are the exact copy
// of spec 14 section 6.
// Run: pnpm --filter @catalog/web exec playwright test --config test/catalog-intake.config.ts

const FIXTURES = path.resolve(__dirname, "../../../packages/core/test-fixtures/catalog/intake");
const XLSX = path.join(FIXTURES, "intake-xlsx-grid.xlsx");
const LARGE_SHEET = path.join(FIXTURES, "intake-large-sheet.csv");
const GRID = readFileSync(path.join(FIXTURES, "intake-pasted-grid.txt"), "utf8");
const VARIANTS = readFileSync(path.join(FIXTURES, "intake-pasted-variants.txt"), "utf8");
/** The grid on the harness host that answers 404 to everything (catalog-intake.fakes.ts MISSING_HOST). */
const GRID_404 = GRID.replaceAll("https://example.com/", "https://missing.example.com/");
/** The grid's 27 links, one per line: what the operator pastes after Fix and continue (scenario 3). */
const GRID_LINES = GRID.split(/[\t\r\n]+/).filter((cell) => /^https?:\/\//.test(cell.trim())).map((cell) => cell.trim()).join("\n");

const CHECKING = "Checking your links...";
const GRID_READBACK = "4 to 5 links per row. This paste has no product code column, so products will be named from the photo file names, for example BH-4610-NE-NERO. To name them yourself, copy the product code column in as the first column. We opened the first 3 links: all fine.";
const GRID_IGNORED = "3 empty or non-link cells were ignored.";
const VARIANTS_SAME_NAME = "Rows 6 and 7 would get the same name, TB-F. Check those rows before you continue.";
const NO_PHOTOS_404 = "No photos could be downloaded from the 27 links you pasted. 27 answered 'not found' (404), for example https://missing.example.com/test_brand/BH-4610-NE-NERO_1.JPG (row 1, column 1). Check that the links open in a browser, then press Fix and continue and paste the corrected links.";
const RETRY_LINKS = "Try the failed links again";

const READING = "Reading your sheet. The columns will appear here when it has been read.";
// Step 2's sheet card once the sheet is read (the column sentence of 14a section 6, scenario 1).
const COLUMNS = "Sheet intake-xlsx-grid.xlsx: identifier column Option Id, 5 image columns, read as links sheet";
const ERROR_HEADING = "Something went wrong on our side.";
const ERROR_SAFE = "Your batch is safe; nothing was lost.";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

test.beforeEach(async ({ page }) => {
  // The Next.js dev overlay (a test-only artefact of next dev) would cover the app's own error page.
  await page.addInitScript(() => {
    const hide = () => document.head.insertAdjacentHTML("beforeend", "<style>nextjs-portal{display:none!important}</style>");
    if (document.head) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
  await queue(page, { delayMs: 1000, fetchDelayMs: 50, budgetItems: 40, paused: false });
});

/** The fake queue and image host settings (POST /harness/queue). */
async function queue(page: Page, settings: { delayMs?: number; fetchDelayMs?: number; budgetItems?: number; paused?: boolean }) {
  const r = await page.request.post("/harness/queue", { data: settings });
  expect(r.ok()).toBe(true);
  return (await r.json()) as { running: number; pending: number };
}

/** Step 1 with Test Brand and a name; uploads one file and waits for "Uploaded". Returns the batch id. */
async function uploadOnStep1(page: Page, name: string, file: string): Promise<string> {
  await page.goto("/catalog/new");
  await page.getByLabel("Which brand?").selectOption("test_brand");
  await page.getByLabel("Batch name (optional)").fill(name);
  const created = page.waitForResponse((r) => r.url().endsWith("/api/catalog/batches") && r.request().method() === "POST");
  await page.locator('input[aria-label="Choose files"]').setInputFiles(file);
  const id = ((await (await created).json()) as { id: string }).id;
  await expect(page.getByRole("listitem").filter({ hasText: path.basename(file) }).filter({ hasText: /Uploaded( Remove)?$/ })).toBeVisible({ timeout: 30_000 });
  return id;
}

/** Step 1 with Test Brand and a name; types `text` into the paste box and leaves it (the check starts on blur). Returns the batch id. */
async function pasteOnStep1(page: Page, name: string, text: string): Promise<string> {
  await page.goto("/catalog/new");
  await page.getByLabel("Which brand?").selectOption("test_brand");
  await page.getByLabel("Batch name (optional)").fill(name);
  const created = page.waitForResponse((r) => r.url().endsWith("/api/catalog/batches") && r.request().method() === "POST");
  await pasteText(page, text);
  return ((await (await created).json()) as { id: string }).id;
}

/** Replaces the paste box text and leaves the box, as an operator pasting then clicking away. */
async function pasteText(page: Page, text: string) {
  const box = page.getByLabel("Or paste a link");
  await box.fill(text);
  await box.blur();
}

/** GET /preview once collection has finished (the groups the batch would make). */
async function finishedPreview(page: Page, id: string) {
  let body: { ready: boolean; totalRows: number; counts: { photos: number }; groups: { identifier: string; shots: number }[] } | null = null;
  await expect.poll(async () => {
    body = await (await page.request.get(`/api/catalog/batches/${id}/preview`)).json();
    return body!.ready;
  }, { timeout: 60_000 }).toBe(true);
  return body!;
}

const inputList = (page: Page) => page.getByRole("list", { name: "What this batch holds" }).getByRole("listitem");
const stepTwo = (page: Page) => page.getByRole("heading", { name: "Check what we found" });
const currentStep = (page: Page) => page.locator('[aria-current="step"]');
/** The batch's card under "Your unfinished batches" on /catalog (spec 14c F4 part 2). */
const unfinishedRow = (page: Page, name: string) => page.getByRole("region", { name: "Your unfinished batches" }).getByRole("listitem").filter({ hasText: name });

/** The page does not scroll sideways (spec 14c scenario 7). */
async function expectNoSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}
/** The element is on screen without scrolling sideways: inside the viewport's width. */
async function expectWithinWidth(locator: Locator) {
  await expect(locator).toBeVisible();
  const box = (await locator.boundingBox())!;
  const width = locator.page().viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

test("2. grid: the paste box says it is checking, reads the grid back, and collection gives 6 products and 27 photos (F2)", async ({ page }) => {
  // Slow image host, so the waiting pill is seen while the first three links are opened.
  await queue(page, { fetchDelayMs: 1_500 });
  const id = await pasteOnStep1(page, "Intake 2 pasted grid", GRID);
  await expect(page.getByText(CHECKING, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  await expect(page.getByText("6 rows, 27 links", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(GRID_READBACK)).toBeVisible();
  await expect(page.getByText(GRID_IGNORED, { exact: true })).toBeVisible();
  await expect(page.getByText(CHECKING)).toHaveCount(0);
  await expect(inputList(page)).toHaveCount(1);

  await queue(page, { fetchDelayMs: 50 });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(stepTwo(page)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("3 of 6 products, so you can check the grouping.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("27 JPG.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Links that could not be downloaded" })).toHaveCount(0);

  const preview = await finishedPreview(page, id);
  expect(preview.totalRows).toBe(6);
  expect(preview.counts.photos).toBe(27);
  expect(preview.groups.find((g) => g.identifier === "BHSS2620Z-WHITE NAVY")?.shots).toBe(5);
});

test("3. grid, all 404, release C form: the no-photos sentence names the links, no retry is offered, and Fix and continue reopens step 1 for the corrected links (F5, F8)", async ({ page }) => {
  const id = await pasteOnStep1(page, "Intake 3 pasted grid 404", GRID_404);
  await expect(page.getByText("6 rows, 27 links", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("We opened the first 3 links: 0 of 3 opened; answered 'not found' (404).")).toBeVisible();

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(stepTwo(page)).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole("alert").filter({ hasText: NO_PHOTOS_404 })).toBeVisible({ timeout: 60_000 });
  const card = page.getByRole("region", { name: "Links that could not be downloaded" });
  await expect(card.getByText("27 of 27 links could not be downloaded (6 products affected).", { exact: true })).toBeVisible();
  await expect(card.getByText("27 answered 'not found' (404), for example https://missing.example.com/test_brand/BH-4610-NE-NERO_1.JPG (row 1, column 1).")).toBeVisible();
  await expect(page.getByRole("button", { name: RETRY_LINKS })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();

  // Show all: the full table of the failed links, from GET /preview.
  await card.getByRole("button", { name: "Show all 27" }).click();
  await expect(card.getByRole("row")).toHaveCount(28);

  // Release C (F8): Fix and continue reopens the batch at step 1 with the reason above the paste.
  const reason = page.getByRole("alert").filter({ hasText: NO_PHOTOS_404 });
  await reason.getByRole("button", { name: "Fix and continue" }).click();
  await expect(page).toHaveURL(new RegExp(`/catalog/new\\?(.*&)?batch=${id}`));
  await expect(currentStep(page)).toHaveText("Brand and files");
  await expect(reason).toBeVisible();
  await expect(inputList(page)).toHaveCount(1);
  await expect(inputList(page).first()).toContainText("Pasted links");
  // The reason is kept on the batch, so a reload still shows it.
  await page.reload();
  await expect(currentStep(page)).toHaveText("Brand and files");
  await expect(reason).toBeVisible();

  // The corrected links, one per line, replace the paste in place; step 2 is ready with the 6 products.
  await pasteText(page, GRID_LINES);
  await expect(page.getByText("27 image links", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(inputList(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  // Step 2 speed is scenarios 1 and 2's bound; here the in-process ingest can slow /detected past 5 s.
  await expect(stepTwo(page)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/of 6 products, so you can check the grouping\./)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(NO_PHOTOS_404)).toHaveCount(0);
  const preview = await finishedPreview(page, id);
  expect(preview.counts.photos).toBe(27);
});

test("4. correction: paste the grid, clear it, paste the variants; one paste input, the same-name warning, and step 2 holds the second paste only (F3)", async ({ page }) => {
  const id = await pasteOnStep1(page, "Intake 4 correction", GRID);
  await expect(page.getByText("6 rows, 27 links", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(inputList(page)).toHaveCount(1);

  await pasteText(page, "");
  await pasteText(page, VARIANTS);
  await expect(page.getByText("7 rows, 12 links", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("1 to 2 links per row. Products will be named by the first column, for example TB-B. We opened the first 3 links: all fine.")).toBeVisible();
  await expect(page.getByText(VARIANTS_SAME_NAME, { exact: true })).toBeVisible();
  await expect(page.getByText("6 rows, 27 links", { exact: true })).toHaveCount(0);
  // The paste changed in place: still one input, the pasted links.
  await expect(inputList(page)).toHaveCount(1);
  await expect(inputList(page).first()).toContainText("Pasted links");

  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(stepTwo(page)).toBeVisible({ timeout: 5_000 });
  // Rows 6 and 7 both become TB-F with shots 1 and 2 (the readback warned about them), so TB-F holds two
  // files per shot and is not among the products with photos; the examples are the second paste's.
  await expect(page.getByText(/^3 of 3 products, so you can check the grouping\.$/)).toBeVisible({ timeout: 60_000 });
  for (const id of ["TB-A", "TB-B", "TB-C"]) await expect(page.locator("code", { hasText: id })).toBeVisible();
  await expect(page.getByText(/BH-46|BHSS2620Z/)).toHaveCount(0);
  // The share page and the http link fail with their reasons; both are permanent, so no retry.
  const card = page.getByRole("region", { name: "Links that could not be downloaded" });
  await expect(card.getByText("2 of 12 links could not be downloaded (2 products affected).", { exact: true })).toBeVisible();
  await expect(card.getByText(/returned a web page instead of an image/)).toBeVisible();
  await expect(card.getByText(/use http instead of https/)).toBeVisible();
  await expect(page.getByRole("button", { name: RETRY_LINKS })).toHaveCount(0);

  const preview = await finishedPreview(page, id);
  expect(preview.groups.map((g) => g.identifier).filter((i) => !/^TB-/.test(i))).toEqual([]);
  expect(preview.groups.filter((g) => g.shots > 0).map((g) => [g.identifier, g.shots])).toEqual([["TB-A", 2], ["TB-B", 2], ["TB-C", 2]]);
});

test("1. xlsx: step 2 renders at once with the reading sentence, then the columns and 6 products (F1)", async ({ page }) => {
  // Hold the first delivery, so step 2 is seen while the sheet is still being read.
  await queue(page, { paused: true });
  await uploadOnStep1(page, "Intake 1 xlsx grid", XLSX);
  const t0 = Date.now();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(stepTwo(page)).toBeVisible({ timeout: 2_000 });
  await expect(page.getByText(READING)).toBeVisible({ timeout: Math.max(1, 2_000 - (Date.now() - t0)) });
  await queue(page, { paused: false });
  await expect(page.getByText(COLUMNS)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/of 6 products, so you can check the grouping/)).toBeVisible();
  await expect(page.getByText(READING)).toHaveCount(0);
});

test.describe("5. leave and return, release C form (F4, F6)", () => {
  // Its video (the config records every scenario) goes in the release reports.
  test("the URL carries ?batch=, the count moves, reload keeps step and count, Continue setting up reopens the wizard, and Your unfinished batches leads back to step 4", async ({ page }) => {
    // The attempt 3 stand-in is the csv the web tier writes for a Google Sheet. Google is disabled in
    // the harness, so the csv is added as a file; collection then runs the same sheet path in runIngest.
    // Pasting the csv text is not possible in release A: the paste box reads one link per line (or
    // identifier<TAB>link), so comma-separated rows yield no links; pasted grids arrive with release B (F2).
    const name = `Intake 5 large sheet ${Date.now()}`;
    const id = await uploadOnStep1(page, name, LARGE_SHEET);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/catalog/new\\?(.*&)?batch=${id}`));
    await expect(stepTwo(page)).toBeVisible({ timeout: 5_000 });

    // The polled count (today's collecting text or, from release C, "Downloading photos <done> of 287").
    const count = page.getByRole("status").filter({ hasText: /\b[\d,]+ of 287\b/ }).first();
    await expect(count).toBeVisible({ timeout: 10_000 });
    const first = await count.innerText();
    await expect(count).not.toHaveText(first, { timeout: 10_000 });
    await expect(page.getByText(/\b0 of 0 products\b/)).toHaveCount(0);

    // Reload while the queue is held: same step, same count.
    await queue(page, { paused: true });
    await expect.poll(async () => (await queue(page, {})).running, { timeout: 30_000 }).toBe(0);
    await page.waitForTimeout(3_500); // one wizard poll (every 2.5 s) shows the last delivery's count
    const before = await count.innerText();
    await page.reload();
    await expect(currentStep(page)).toHaveText("Check what we found");
    await expect(page.getByRole("status").filter({ hasText: before })).toBeVisible();
    await queue(page, { paused: false });

    // Open the batch from the list and press Continue setting up: the wizard at the step.
    await page.goto("/catalog");
    await page.getByRole("table").getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/catalog/${id}$`));
    await page.getByRole("link", { name: "Continue setting up" }).click();
    await expect(page).toHaveURL(new RegExp(`/catalog/new\\?(.*&)?batch=${id}`));
    // No marketplaces are chosen yet, so the batch reopens at step 2 whether or not collection has finished.
    await expect(currentStep(page)).toHaveText("Check what we found");

    // Release C: the batch list opens with "Your unfinished batches", the row in state words with its age.
    await page.goto("/catalog");
    const row = unfinishedRow(page, name);
    await expect(row).toContainText(/Reading your sheet|Downloading photos [\d,]+ of 287|Placing photos [\d,]+ of [\d,]+|Ready to check/);
    await expect(row).toContainText(/created (just now|\d+ minutes? ago)/);
    await finishedPreview(page, id);
    await page.reload();
    await expect(row).toContainText("Ready to check");
    // Continue opens step 2 with the grouping.
    await row.getByRole("link", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/catalog/new\\?(.*&)?batch=${id}`));
    await expect(currentStep(page)).toHaveText("Check what we found");
    await expect(page.getByText(/of [\d,]+ products, so you can check the grouping\./)).toBeVisible({ timeout: 10_000 });
    // Nothing changed on step 2, so its Continue returns at once (spec 14c F7 part 1).
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Where will these images go?" })).toBeVisible({ timeout: 3_000 });
    await page.getByRole("checkbox", { name: /Namshi/ }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(currentStep(page)).toHaveText("Start");
    await expect(page.getByText("images will be made")).toBeVisible({ timeout: 30_000 });
    // Reload: still step 4.
    await page.reload();
    await expect(currentStep(page)).toHaveText("Start");
    await expect(page.getByText("images will be made")).toBeVisible({ timeout: 30_000 });
  });
});

test.describe("7. phone, 390 x 844: the wizard, Your unfinished batches and the State column fit without sideways scroll (F4)", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("scenario 2's paste and scenario 5's list on a phone, then Cancel with its inline confirmation", async ({ page }) => {
    const name = `Intake 7 phone ${Date.now()}`;
    await pasteOnStep1(page, name, GRID);
    await expect(page.getByText("6 rows, 27 links", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expectNoSideScroll(page);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    // Step 2 speed is scenarios 1 and 2's bound; here the in-process ingest can slow /detected past 5 s.
    await expect(stepTwo(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/of 6 products, so you can check the grouping\./)).toBeVisible({ timeout: 60_000 });
    await expectNoSideScroll(page);

    await page.goto("/catalog");
    await expect(page.getByRole("heading", { name: "Your unfinished batches" })).toBeVisible();
    const row = unfinishedRow(page, name);
    await expectWithinWidth(row);
    await expectWithinWidth(row.getByRole("link", { name: "Continue", exact: true }));
    await expectWithinWidth(row.getByRole("button", { name: "Cancel", exact: true }));
    await expectWithinWidth(page.getByRole("columnheader", { name: "State" }));
    await expectNoSideScroll(page);

    // Cancel asks inline, then the batch leaves the section and the default list.
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(row.getByText(`Cancel ${name}? Nothing was processed and nothing was charged.`, { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Keep it" })).toBeVisible();
    await expectNoSideScroll(page);
    await row.getByRole("button", { name: "Yes, cancel" }).click();
    await expect(unfinishedRow(page, name)).toHaveCount(0);
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "Show cancelled" }).click();
    await expect(page.getByRole("row").filter({ hasText: name })).toContainText("Cancelled");
  });
});

test("6. crash boundary: a render error on step 2 shows the error page, and Open this batch returns to the wizard (F1)", async ({ page }) => {
  const id = await uploadOnStep1(page, "Intake 6 crash boundary", XLSX);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(stepTwo(page)).toBeVisible({ timeout: 5_000 });
  await expect(page).toHaveURL(new RegExp(`batch=${UUID}`));

  // Forced render error, test-only: the next poll of /detected answers a body step 2 cannot render.
  // Nothing in the app is changed; only this page's network answer is replaced.
  const detected = `**/api/catalog/batches/${id}/detected`;
  await page.route(detected, (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await expect(page.getByRole("heading", { name: ERROR_HEADING })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(ERROR_SAFE)).toBeVisible();
  await expect(page.getByRole("link", { name: "All batches" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try this page again" })).toBeVisible();
  await page.unroute(detected);

  await page.getByRole("link", { name: "Open this batch" }).click();
  await expect(page).toHaveURL(new RegExp(`/catalog/new\\?(.*&)?batch=${id}`));
  await expect(page.getByRole("heading", { name: "New batch" })).toBeVisible();
  await expect(currentStep(page)).not.toHaveText("Brand and files");
});
