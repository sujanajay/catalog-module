// Tier 4 sign-in helper (spec 03). Opens WEB_URL in a visible Chrome window, waits while you sign in
// on Google's page (IAP), then saves the browser state (IAP's session cookie) so the *.human.spec.ts
// tests can run as you without signing in again.
//
// Saves apps/web/.playwright/auth-state.json, or apps/web/.playwright/auth-state-viewer.json when run
// with the argument "viewer" (or AUTH_STATE=viewer). Use a second Google account that is a viewer for
// that one. When a test later lands on accounts.google.com, the saved state has expired: run this again.
//
// Uses the Chrome installed on this machine (channel "chrome"); no browser is downloaded.
//
// Run from the repo root.
//   PowerShell:
//     $env:WEB_URL = "https://catalog-web-<project-number>.asia-south1.run.app"
//     pnpm --filter @catalog/web human:login            # admin state
//     pnpm --filter @catalog/web human:login viewer     # viewer state
//   bash:
//     WEB_URL=https://... pnpm --filter @catalog/web human:login [viewer]
// (Same as: pnpm --filter @catalog/web exec tsx test/human/login.ts [viewer])

import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { ADMIN_STATE, AUTH_DIR, VIEWER_STATE, webUrl } from "./auth-paths";

const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const url = webUrl();
  const viewer = process.argv.slice(2).includes("viewer") || process.env.AUTH_STATE === "viewer";
  const statePath = viewer ? VIEWER_STATE : ADMIN_STATE;
  const host = new URL(url).host;

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    // Google's sign-in page refuses browsers that announce automation; these two flags avoid that.
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(url);
    console.log(
      `Sign in with your ${viewer ? "viewer " : ""}@opptra.com Google account in the Chrome window. ` +
        `Waiting up to ${SIGN_IN_TIMEOUT_MS / 60000} minutes.`,
    );
    // Back on our own host, and the app has rendered the user menu: the IAP cookie is set.
    await page.waitForURL((u) => u.host === host, { timeout: SIGN_IN_TIMEOUT_MS });
    await page.getByTestId("user-menu-button").waitFor({ state: "visible", timeout: SIGN_IN_TIMEOUT_MS });
    const who = (await page.getByTestId("user-menu-button").textContent())?.trim();

    mkdirSync(AUTH_DIR, { recursive: true });
    await context.storageState({ path: statePath });
    console.log(`Signed in as "${who}". Saved the browser state to ${statePath}.`);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
