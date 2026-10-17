import { defineConfig } from "vitest/config";

// Tier 3 (real data). Every *.real.test.ts skips itself unless REAL_DATA=1, so a run without the
// flag passes with everything skipped.
export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.real.test.ts", "{apps,packages}/*/test/**/*.real.test.ts"],
    exclude: ["**/node_modules/**", ".claude/**"],
    environment: "node",
    passWithNoTests: true,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
