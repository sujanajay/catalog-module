import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// M7 4.2.9 test 3: no source file outside the adapters imports a vendor SDK. `pnpm lint` enforces the rule on the
// repo; this test proves the rule catches a planted import and lets the adapters (and type-only imports) through.
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const eslint = new ESLint({cwd: root});
async function restricted(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, {filePath});
  return result!.messages.filter(m => m.ruleId === "no-restricted-imports").map(m => m.message);
}

describe("M7-F2-R1 lint rule: vendor SDKs only in the adapters", () => {
  it("flags a vendor SDK or the OpenRouter transport imported outside the adapters", async () => {
    for (const [code, file] of [
      ["import OpenAI from \"openai\";\nexport const c = new OpenAI();\n", "packages/core/src/catalog/qa/planted.ts"],
      ["import Anthropic from \"@anthropic-ai/sdk\";\nexport const c = Anthropic;\n", "apps/worker/src/catalog/planted.ts"],
      ["import { GoogleGenAI } from \"@google/genai\";\nexport const c = GoogleGenAI;\n", "apps/web/lib/catalog/planted.ts"],
      ["import { chatCompletion } from \"../../llm/openrouter\";\nexport const c = chatCompletion;\n", "packages/core/src/catalog/qa/planted.ts"],
    ] as const) expect(await restricted(code, file), file).toHaveLength(1);
  }, 60_000);
  it("allows the adapters, the llm transport itself, and type-only imports elsewhere", async () => {
    expect(await restricted("import OpenAI from \"openai\";\nexport const c = OpenAI;\n", "packages/core/src/vendor/adapters/planted.ts")).toEqual([]);
    expect(await restricted("import { chatCompletion } from \"../../llm/openrouter\";\nexport const c = chatCompletion;\n", "packages/core/src/vendor/adapters/planted.ts")).toEqual([]);
    expect(await restricted("import { replicateLive } from \"./replicate\";\nexport const c = replicateLive;\n", "packages/core/src/catalog/load/planted.ts")).toEqual([]);
    expect(await restricted("import type { RetryPolicy } from \"../../llm/openrouter\";\nexport type P = RetryPolicy;\n", "packages/core/src/catalog/qa/planted.ts")).toEqual([]);
  }, 60_000);
});
