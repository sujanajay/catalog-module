import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { STATUS_WORDS } from "@catalog/core/catalog/status-words";

// UX2 (UX section 13.4): the copy lint runs inside `pnpm lint`, so CI fails on copy that breaks section 7. These
// tests plant bad copy in a file path and prove each rule catches it, and that engineering text is left alone.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const eslint = new ESLint({ cwd: root });
async function copyMessages(code: string, filePath: string): Promise<{ rule: string; message: string }[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter(m => m.ruleId?.startsWith("copy/")).map(m => ({ rule: m.ruleId!, message: m.message }));
}
const rules = async (code: string, filePath: string) => (await copyMessages(code, filePath)).map(m => m.rule);
const PAGE = "apps/web/app/catalog/planted/page.tsx";
const COMPONENT = "apps/web/components/catalog/Planted.tsx";

describe("UX2 acceptance: the copy lint fails on a planted vendor name and an em dash", () => {
  it("flags an em dash in UI copy, in a comment and in any linted source file", async () => {
    const dash = String.fromCharCode(0x2014);
    expect(await rules(`export const P = () => <p>Links ready ${dash} every product has links.</p>;\n`, PAGE)).toEqual(["copy/no-em-dash"]);
    expect(await rules(`// keep going ${dash} later\nexport const n = 1;\n`, "packages/core/src/catalog/planted.ts")).toEqual(["copy/no-em-dash"]);
    expect(await rules(`export const s = "a ${dash} b";\n`, "apps/worker/src/planted.ts")).toEqual(["copy/no-em-dash"]);
  }, 60_000);

  it("flags a vendor or model name in operator copy: JSX text, strings, templates and copy attributes", async () => {
    for (const code of [
      "export const P = () => <p>Made with OpenRouter.</p>;\n",
      "export const s = \"Checked by Claude\";\n",
      "export const t = (n: number) => `${n} images made by Gemini`;\n",
      "export const P = () => <img alt=\"Cut out with BiRefNet\" src=\"/x.png\" />;\n",
      "export const s = \"google/gemini-2.5-flash-lite\";\n",
      "export const s = \"Enlarged by Replicate\";\n",
    ]) expect(await rules(code, COMPONENT), code).toEqual(["copy/no-vendor-names"]);
    expect(await rules("export const s = \"Checked by Claude\";\n", "packages/core/src/catalog/pipeline/status.ts")).toContain("copy/no-vendor-names");
  }, 60_000);

  it("leaves engineering text alone: imports, comments, log calls, class names and links", async () => {
    const code = [
      "// the judge is google/gemini-2.5-flash-lite",
      "import { x } from \"./openrouter-helpers\";",
      "console.info(\"matte model birefnet-general\", x);",
      "export const P = () => <a className=\"openrouter-link\" href=\"https://openrouter.ai/x\">Links</a>;",
    ].join("\n");
    expect(await rules(code, COMPONENT)).toEqual([]);
  }, 60_000);

  it("allows vendor names on the admin Ops page, but never an em dash there", async () => {
    expect(await rules("export const P = () => <p>OpenRouter spend today.</p>;\n", "apps/web/app/catalog/ops/page.tsx")).toEqual([]);
    expect(await rules(`export const P = () => <p>Spend ${String.fromCharCode(0x2014)} today.</p>;\n`, "apps/web/app/catalog/ops/page.tsx")).toEqual(["copy/no-em-dash"]);
  }, 60_000);
});

describe("UX section 7 word list and reading grade", () => {
  it("flags an avoided word and names the word to use", async () => {
    const found = await copyMessages("export const P = () => <p>3 products need attention.</p>;\n", COMPONENT);
    expect(found.map(m => m.rule)).toEqual(["copy/word-list"]);
    expect(found[0]!.message).toContain("needs you");
    expect(await rules("export const s = \"We could not read 2 SKUs from your sheet.\";\n", COMPONENT)).toEqual(["copy/word-list"]);
    expect(await rules("export const s = \"The image failed.\";\n", COMPONENT)).toEqual(["copy/word-list"]);
  }, 60_000);

  it("does not read code words as copy: status values, comparisons and single words", async () => {
    const code = [
      "export const isBad = (s: string) => s === \"failed\" || s === \"error\";",
      "export const kind: \"asset\" | \"output\" = \"asset\";",
      "export const P = () => <input type=\"text\" name=\"config\" />;",
    ].join("\n");
    expect(await rules(code, COMPONENT)).toEqual([]);
  }, 60_000);

  it("flags copy above reading grade 8 and passes plain sentences", async () => {
    const hard = "export const s = \"Notwithstanding considerable infrastructural complications, organisational reconfiguration necessitates comprehensive reconsideration of operational methodologies.\";\n";
    expect(await rules(hard, COMPONENT)).toEqual(["copy/reading-grade"]);
    expect(await rules("export const s = \"We used the next best photo. You can change it on the product page.\";\n", COMPONENT)).toEqual([]);
  }, 60_000);

  it("the status words themselves pass every copy rule", async () => {
    const code = `export const words = ${JSON.stringify(Object.values(STATUS_WORDS).map(w => `${w.word}. ${w.meaning}.`))};\n`;
    expect(await rules(code, COMPONENT)).toEqual([]);
  }, 60_000);
});
