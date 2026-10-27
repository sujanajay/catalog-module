import path from "node:path";
import { defineConfig } from "@playwright/test";

// Intake browser scenarios (spec 14 section 8.3): the real app in next dev mode with PGlite, in-memory
// storage, a fake queue running the real runIngest and a fake image host (test/catalog-intake.server.ts).
// No IAP session, no deployed service, no GCP. From the repository root:
//   pnpm --filter @catalog/web exec playwright test --config test/catalog-intake.config.ts
// The first start compiles every page and route the scenarios use (a few minutes on Windows). Locally a
// harness already running on the port is reused; set INTAKE_CHANNEL=chrome to use the installed Chrome
// instead of Playwright's Chromium.
const port = Number(process.env.INTAKE_PORT || 3417);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "catalog-intake.browser.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "../test-results/catalog-intake",
  webServer: {
    command: "pnpm exec tsx test/catalog-intake.server.ts",
    cwd: path.join(__dirname, ".."),
    url: `${origin}/harness/health`,
    env: { INTAKE_PORT: String(port) },
    timeout: 600_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
  use: {
    baseURL: origin,
    browserName: "chromium",
    channel: process.env.INTAKE_CHANNEL || undefined,
    headless: true,
    viewport: { width: 1280, height: 900 },
    // Every scenario is recorded: the release reports carry the scenario 5 video.
    video: "on",
    trace: "retain-on-failure",
    // Windows GPU subprocesses can outlive a closed browser. Keep this test-only GPU in the browser process.
    launchOptions: { args: ["--in-process-gpu"] },
  },
});
