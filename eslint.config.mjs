import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { copyPlugin } from "./lint/copy-rules.mjs";

/** Vendor SDKs and the OpenRouter transport: imported only by `packages/core/src/vendor/adapters/` (and `llm/` itself). */
export const VENDOR_SDK_PATTERNS = [
  {
    // Package names only (a regex, so a local module such as ./replicate is not caught).
    regex: "^(?:(?:openai|replicate|groq-sdk|cohere-ai|together-ai|fashn)(?:/.*)?|@(?:anthropic-ai|openrouter|fal-ai|mistralai|photoroom|fashn)/.+|@google/(?:genai|generative-ai)|@google-cloud/(?:vertexai|aiplatform))$",
    message: "Call vendors through the M7 vendor interface (packages/core/src/vendor); only its adapters import a vendor SDK.",
  },
  {
    regex: "(^|/)llm/openrouter$",
    allowTypeImports: true,
    message: "Call OpenRouter through the vendor interface (packages/core/src/vendor/adapters/openrouter.ts); type imports are fine.",
  },
];

/**
 * Operator copy for the copy lint (UX section 7): the web app's pages, components and server copy, and the core files
 * whose strings reach the operator in pages, emails and sheets (the same core files as test/no-model-names.test.ts).
 */
export const OPERATOR_COPY_FILES = [
  "apps/web/app/**/*.{ts,tsx}",
  "apps/web/components/**/*.{ts,tsx}",
  "apps/web/lib/**/*.{ts,tsx}",
  "packages/core/src/catalog/qa/reasons.ts",
  "packages/core/src/catalog/pipeline/status.ts",
  "packages/core/src/catalog/pipeline/dispatch.ts",
  "packages/core/src/catalog/cost.ts",
  "packages/core/src/catalog/cost-report.ts",
  "packages/core/src/catalog/sheet.ts",
  "packages/core/src/catalog/types.ts",
  "packages/core/src/catalog/pipeline/report.ts",
  "packages/core/src/catalog/enhance.ts",
  "packages/core/src/catalog/render.ts",
  "packages/core/src/catalog/status-words.ts",
  "packages/core/src/catalog/ingest/detect.ts",
  "packages/core/src/catalog/ingest/link-reasons.ts",
  "packages/core/src/catalog/ingest/group.ts",
  "packages/core/src/catalog/ingest/index.ts",
  "packages/core/src/catalog/ingest/url-list.ts",
  "packages/core/src/settings/registry.ts",
];

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/next-env.d.ts",
      "**/drizzle/**",
      "services/**",
      ".claude/**",
      // Spec 18: the bake-off scripts, kept as they ran (CommonJS run by node, not part of the build).
      "apps/worker/src/catalog-output-evals/bake/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  // M7-F2-R1 and 4.2.9 test 3: every bought capability is called through the vendor interface, so no source file
  // outside the adapters imports a vendor SDK or the OpenRouter transport (type-only imports are fine).
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    ignores: ["packages/core/src/vendor/adapters/**", "packages/core/src/llm/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: VENDOR_SDK_PATTERNS }],
    },
  },
  // UX2 (UX sections 7 and 13.4): the copy lint. No em dash in any linted file; in operator copy no vendor or model
  // name (the admin Ops page may name vendors), the word list and reading grade 8. Copy from before the lint is listed
  // in eslint-suppressions.json; fix it as each screen is rebuilt and run `pnpm exec eslint . --prune-suppressions`.
  {
    files: ["**/*.{ts,tsx,js,mjs,cjs}"],
    plugins: { copy: copyPlugin },
    rules: { "copy/no-em-dash": "error" },
  },
  {
    files: OPERATOR_COPY_FILES,
    ignores: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
    rules: { "copy/no-vendor-names": "error", "copy/word-list": "error", "copy/reading-grade": "error" },
  },
  {
    files: ["apps/web/app/catalog/ops/**", "apps/web/lib/catalog/ops.ts", "apps/web/lib/catalog/ops-copy.ts"],
    rules: { "copy/no-vendor-names": "off" },
  },
  // CI reliability (2026-11-05): a fixed sleep is a guess, not a sync point; on a loaded runner the guess is wrong and
  // the test flakes (intake scenario 5 waited 3.5 s for a page poll). Wait for the real condition instead: a web-first
  // assertion, expect.poll, a response or the page clock. Older negative checks ("nothing happens for N ms", which can
  // only pass falsely, never fail falsely) are listed in eslint-suppressions.json.
  {
    files: ["**/*.spec.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.property.name='waitForTimeout']",
        message: "No fixed sleeps in browser specs: wait for the condition (a web-first expect, expect.poll, waitForResponse, page.clock).",
      }],
    },
  },
  // Unit tests: no real sleep over 50 ms (new Promise((r) => setTimeout(r, 500))). Short polling ticks are fine.
  {
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "NewExpression[callee.name='Promise'] CallExpression[callee.name='setTimeout'][arguments.0.type='Identifier'][arguments.1.value>50]",
        message: "No real sleeps over 50 ms in unit tests: pass a sleep seam, use vi.useFakeTimers, or wait for the condition.",
      }],
    },
  },
);
