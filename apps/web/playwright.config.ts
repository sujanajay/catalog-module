// Playwright config for the tier 4 (human-like) tests in test/human/*.human.spec.ts. They run against
// the deployed web (WEB_URL) with the browser state saved by test/human/login.ts, in the Chrome
// installed on this machine (no browser download), and record a video of every test.
//
// Run from the repo root (PowerShell):
//   $env:WEB_URL = "https://catalog-web-<project-number>.asia-south1.run.app"
//   pnpm --filter @catalog/web human:login     # once, or whenever a test lands on accounts.google.com
//   pnpm --filter @catalog/web human:test      # add --headed to watch
// Videos land in apps/web/test-results/, the HTML report in apps/web/playwright-report/.
//
// vitest never runs these files: the root vitest.config.ts excludes *.human.spec.ts.

import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { ADMIN_STATE, webUrl } from "./test/human/auth-paths";

if (!existsSync(ADMIN_STATE)) {
  throw new Error(`No saved sign-in at ${ADMIN_STATE}. Run "pnpm --filter @catalog/web human:login" first.`);
}

export default defineConfig({
  testDir: "./test/human",
  testMatch: "**/*.human.spec.ts",
  // The tests share live state (the People list), so they run one at a time, in file order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  outputDir: "test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: webUrl(),
    channel: "chrome",
    storageState: ADMIN_STATE,
    video: "on",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
