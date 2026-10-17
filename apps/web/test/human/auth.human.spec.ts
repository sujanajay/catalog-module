// Tier 4 (spec 03): sign-in, user menu, People modal, "Preview as viewer" and sign out on the deployed
// web, as a person would use them. Needs WEB_URL and the state saved by login.ts; see
// playwright.config.ts for the commands. The only person this test adds and removes is
// catalog-test-viewer@opptra.com.

import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { ADMIN_STATE, VIEWER_STATE } from "./auth-paths";

const TEST_PERSON = "catalog-test-viewer@opptra.com";
const FORBIDDEN = "You can view this but not change it. Ask an admin for the operator role.";
const XHR = { "X-Requested-With": "XMLHttpRequest" };
const personPath = `/api/people/${encodeURIComponent(TEST_PERSON)}`;

/** Opens `path` and fails with a clear message when the saved sign-in has expired. */
async function openSignedIn(page: Page, path: string): Promise<void> {
  await page.goto(path);
  if (new URL(page.url()).host.endsWith("accounts.google.com")) {
    throw new Error('The saved sign-in has expired. Run "pnpm --filter @catalog/web human:login" again.');
  }
}

test.describe("admin", () => {
  test.afterEach(async ({ request }) => {
    // Leave no test person behind, even when a step failed. Removing an unknown email is a no-op.
    await request.delete(personPath, { headers: XHR });
  });

  test("user menu, People, preview as viewer, sign out", async ({ page, request }) => {
    await request.delete(personPath, { headers: XHR });
    const userButton = page.getByTestId("user-menu-button");
    const toast = page.getByRole("status");

    await test.step("opens /catalog and sees the user menu as Admin", async () => {
      await openSignedIn(page, "/catalog");
      await expect(userButton).toHaveText(/^\S+@opptra\.com · Admin ▾$/);
    });

    const dialog = page.getByRole("dialog", { name: "People" });

    await test.step("opens People", async () => {
      await userButton.click();
      await page.getByRole("menuitem", { name: "People" }).click();
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByText(
          "Anyone with an @opptra.com Google account can sign in and view. Admins decide who can create batches and resolve attention items.",
        ),
      ).toBeVisible();
      await expect(dialog.getByRole("listitem").filter({ hasText: "(you)" })).toBeVisible();
    });

    const testRow = dialog.getByRole("listitem").filter({ hasText: TEST_PERSON });

    await test.step(`adds ${TEST_PERSON} as Viewer`, async () => {
      await dialog.getByLabel("Email address").fill(TEST_PERSON);
      await dialog.getByLabel("Role for the new person").selectOption("viewer");
      await dialog.getByRole("button", { name: "Add person" }).click();
      await expect(toast).toHaveText(`${TEST_PERSON} added as Viewer.`);
      await expect(testRow).toBeVisible();
      await expect(dialog.getByLabel(`Role for ${TEST_PERSON}`)).toHaveValue("viewer");
    });

    await test.step("removes it again", async () => {
      await dialog.getByRole("button", { name: `Remove ${TEST_PERSON}` }).click();
      await expect(testRow).toHaveCount(0);
    });

    await test.step("turns on Preview as viewer", async () => {
      await dialog.getByLabel("Preview as viewer").check();
      await expect(toast).toHaveText("Previewing as a viewer. Action buttons are hidden.");
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(userButton).toHaveText(/ · Viewer \(preview\) ▾$/);
      // 06 adds "New batch"; while previewing it must not be there.
      await expect(page.getByRole("button", { name: "New batch" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "New batch" })).toHaveCount(0);
      await userButton.click();
      await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "People" })).toHaveCount(0);
    });

    await test.step("turns the preview off again", async () => {
      await page.getByRole("menuitemcheckbox", { name: "Preview as viewer" }).click();
      await expect(toast).toHaveText("Back to Admin.");
      await expect(userButton).toHaveText(/ · Admin ▾$/);
      await userButton.click();
      await expect(page.getByRole("menuitem", { name: "People" })).toBeVisible();
    });

    await test.step("signs out and lands on Google's sign-in page", async () => {
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      await expect(page).toHaveURL(/^https:\/\/accounts\.google\.com\//, { timeout: 30_000 });
    });
  });
});

test.describe("viewer", () => {
  test.describe("with a second account saved as the viewer", () => {
    test.skip(
      !existsSync(VIEWER_STATE),
      `No viewer sign-in at ${VIEWER_STATE}. To run this, sign in with a second Google account that is ` +
        'a viewer: "pnpm --filter @catalog/web human:login viewer".',
    );
    test.use({ storageState: VIEWER_STATE });

    test("opens /catalog and sees no action controls", async ({ page }) => {
      await openSignedIn(page, "/catalog");
      const userButton = page.getByTestId("user-menu-button");
      await expect(userButton).toHaveText(/ · Viewer ▾$/);
      await expect(page.getByRole("button", { name: "New batch" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "New batch" })).toHaveCount(0);
      await userButton.click();
      await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "People" })).toHaveCount(0);
    });
  });

  test("the API refuses a viewer's POST /api/people with 403 and the sentence", async ({ browser, baseURL }) => {
    // Use whichever saved state belongs to a viewer: the viewer state, or the main state when the
    // tester's own account is a viewer.
    let viewerState: string | undefined;
    for (const state of [VIEWER_STATE, ADMIN_STATE]) {
      if (!existsSync(state)) continue;
      const context = await browser.newContext({ storageState: state, baseURL });
      try {
        const page = await context.newPage();
        await openSignedIn(page, "/catalog");
        const label = await page.getByTestId("user-menu-button").textContent();
        if (label?.trim().endsWith("· Viewer ▾")) {
          viewerState = state;
          break;
        }
      } finally {
        await context.close();
      }
    }
    test.skip(
      !viewerState,
      'No saved sign-in belongs to a viewer. Save one with "pnpm --filter @catalog/web human:login viewer".',
    );

    const context = await browser.newContext({ storageState: viewerState, baseURL });
    try {
      const res = await context.request.post("/api/people", {
        headers: XHR,
        data: { email: TEST_PERSON, role: "viewer" },
      });
      expect(res.status()).toBe(403);
      expect(await res.json()).toEqual({ error: FORBIDDEN });
    } finally {
      await context.close();
    }
  });
});
