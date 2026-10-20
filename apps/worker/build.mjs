/* global console */
// Bundles the worker for Node 22 (ESM). Externals are installed as real node_modules in the image.
import { cpSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "dist");
rmSync(dist, { recursive: true, force: true });

await build({
  entryPoints: {
    index: path.join(here, "src/index.ts"),
    migrate: path.join(here, "src/migrate.ts"),
    "catalog-local": path.join(here, "src/catalog-local.ts"),
    "catalog-smoke": path.join(here, "src/catalog-smoke.ts"),
    "catalog-qa-check": path.join(here, "src/catalog-qa-check.ts"),
    "catalog-eval": path.join(here, "src/catalog-eval.ts"),
    "catalog-load": path.join(here, "src/catalog-load.ts"),
    "catalog-recheck": path.join(here, "src/catalog-recheck.ts"),
    "catalog-output-evals": path.join(here, "src/catalog-output-evals.ts"),
    "fault-proxy": path.join(here, "src/fault-proxy.ts"),
  },
  outdir: dist,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // @aws-sdk/client-s3: unzipper requires it only inside Open.s3_v3, which we never call.
  external: ["@google-cloud/*", "google-auth-library", "pg", "pg-native", "sharp", "@aws-sdk/client-s3"],
  // Some bundled CJS deps call require() for node builtins.
  banner: {
    js: "import { createRequire as __catalogCreateRequire } from 'node:module'; const require = __catalogCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

cpSync(path.join(here, "../../packages/core/drizzle"), path.join(dist, "drizzle"), { recursive: true });
console.log("copied packages/core/drizzle -> dist/drizzle");
