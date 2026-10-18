import { defineConfig } from "@playwright/test";

// Local client-component regressions only. All APIs are mocked; no IAP session or deployed service is used.
// From the repository root: pnpm --filter @catalog/web exec playwright test --config test/catalog-wizard-ordering.config.ts
export default defineConfig({
  testDir: ".",
  testMatch: "catalog-wizard-ordering.browser.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 3_000 },
  reporter: "list",
  outputDir: "../test-results/wizard-ordering",
  // Windows GPU subprocesses can outlive a closed browser. Keep this test-only GPU in the browser process.
  use: { browserName: "chromium", headless: true, launchOptions: { args: ["--in-process-gpu"] } },
});
