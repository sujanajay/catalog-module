import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// Intake scenarios of spec 14a section 6 (1, 5 in its release A form, and 6), run against the local
// harness (test/catalog-intake.server.ts): the real wizard, pages and routes, PGlite, in-memory storage,
// a fake queue running the real runIngest, and a fake image host. Sentences in quotes are the exact
// copy of spec 14 section 6.
// Run: pnpm --filter @catalog/web exec playwright test --config test/catalog-intake.config.ts

const FIXTURES = path.resolve(__dirname, "../../../packages/core/test-fixtures/catalog/intake");
const XLSX = path.join(FIXTURES, "intake-xlsx-grid.xlsx");
const LARGE_SHEET = path.join(FIXTURES, "intake-large-sheet.csv");

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
}

/** Step 1 with Test Brand and a name; uploads one file and waits for "Uploaded". Returns the batch id. */
async function uploadOnStep1(page: Page, name: string, file: string): Promise<string> {
  await page.goto("/catalog/new");
  await page.getByLabel("Which brand?").selectOption("test_brand");
  await page.getByLabel("Batch name (optional)").fill(name);
  const created = page.waitForResponse((r) => r.url().endsWith("/api/catalog/batches") && r.request().method() === "POST");
  await page.locator('input[aria-label="Choose files"]').setInputFiles(file);
  const id = ((await (await created).json()) as { id: string }).id;
  await expect(page.getByRole("listitem").filter({ hasText: path.basename(file) }).filter({ hasText: /Uploaded$/ })).toBeVisible({ timeout: 30_000 });
  return id;
}

const stepTwo = (page: Page) => page.getByRole("heading", { name: "Check what we found" });
const currentStep = (page: Page) => page.locator('[aria-current="step"]');

test("1. xlsx: step 2 renders at once with the reading sentence, then the columns and 6 products (F1)", async ({ page }) => {
  // Hold the first delivery, so step 2 is seen while the sheet is still being read.
  await queue(page, { paused: true });
  await uploadOnStep1(page, "Intake 1 xlsx grid", XLSX);
  const t0 = Date.now();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(stepTwo(page)).toBeVisible({ timeout: 2_000 });
  await expect(page.getByText(READING)).toBeVisible({ timeout: Math.max(1, 2_000 - (Date.now() - t0)) });
  await queue(page, { paused: false });
  await expect(page.getByText(COLUMNS)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/of 6 products, so you can check the grouping/)).toBeVisible();
  await expect(page.getByText(READING)).toHaveCount(0);
});

test.describe("5. leave and return, release A form (F4, F6)", () => {
  // Its video (the config records every scenario) goes in the release A report.
  test("the URL carries ?batch=, the count moves, reload keeps step and count, Continue setting up reopens the wizard", async ({ page }) => {
    // The attempt 3 stand-in is the csv the web tier writes for a Google Sheet. Google is disabled in
    // the harness, so the csv is added as a file; collection then runs the same sheet path in runIngest.
    const name = `Intake 5 large sheet ${Date.now()}`;
    const id = await uploadOnStep1(page, name, LARGE_SHEET);
    await page.getByRole("button", { name: "Continue" }).click();
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
    await page.waitForTimeout(3_000); // let the delivery in flight finish and the poll catch up
    const before = await count.innerText();
    await page.reload();
    await expect(currentStep(page)).toHaveText("Check what we found");
    await expect(page.getByRole("status").filter({ hasText: before })).toBeVisible();
    await queue(page, { paused: false });

    // Open the batch from the list and press Continue setting up: the wizard at the step.
    await page.goto("/catalog");
    await page.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/catalog/${id}$`));
    await page.getByRole("link", { name: "Continue setting up" }).click();
    await expect(page).toHaveURL(new RegExp(`/catalog/new\\?(.*&)?batch=${id}`));
    await expect(currentStep(page)).not.toHaveText("Brand and files");
  });
});

test("6. crash boundary: a render error on step 2 shows the error page, and Open this batch returns to the wizard (F1)", async ({ page }) => {
  const id = await uploadOnStep1(page, "Intake 6 crash boundary", XLSX);
  await page.getByRole("button", { name: "Continue" }).click();
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
