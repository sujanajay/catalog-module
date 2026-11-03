import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

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
);
