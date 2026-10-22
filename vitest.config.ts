import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  // The web app's "@/" import alias (apps/web/tsconfig.json), so tests can render its pages.
  resolve: { alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./apps/web/", import.meta.url)) }] },
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts", "{apps,packages}/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.real.test.ts", "**/*.human.spec.ts", ".claude/**"],
    environment: "node",
    // PGlite (in-process Postgres) takes several seconds to start when test files run in parallel.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each worker boots its own PGlite; one per CPU (the default) starves them on a busy machine, 4 matches a CI runner.
    maxWorkers: 4,
  },
});
