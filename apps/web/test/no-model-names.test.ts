// Spec 07: no model name in any page, toast, API response or export. This tier 1 check reads the
// operator-facing source (the web app and the core copy files) and fails when a string literal or
// JSX text names a model or a model provider. Comments, imports and log calls are engineering text
// and are ignored. The deployed-page and API-response check lives in test/human/catalog.human.spec.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import { CATALOG_QA_DEFAULT_MODEL } from "@catalog/core/catalog/qa/classify";
import { DEFAULT_POLICIES } from "@catalog/core/catalog/qa/policy";

const ROOT = path.resolve(__dirname, "../../..");
const WEB_DIRS = ["apps/web/app", "apps/web/components", "apps/web/lib"];
// Core files whose strings reach the operator: flag sentences, banners, cost lines, sheet cells, render attention
// text. upscale.ts is engineering config (it maps model ids to export versions for render_key) and is left out.
const CORE_COPY_FILES = [
  "packages/core/src/catalog/qa/reasons.ts",
  "packages/core/src/catalog/pipeline/status.ts",
  "packages/core/src/catalog/cost.ts",
  "packages/core/src/catalog/cost-report.ts",
  "packages/core/src/catalog/sheet.ts",
  "packages/core/src/catalog/types.ts",
  "packages/core/src/catalog/pipeline/report.ts",
  "packages/core/src/catalog/enhance.ts",
  "packages/core/src/catalog/render.ts",
];

// Every candidate id the policy defines, plus provider and family names (spec 07 section 8).
const POLICY_IDS = Object.values(DEFAULT_POLICIES).flatMap(p => [p.matteModel, p.matteModelSecond, p.qaModel, p.qaModelSecond]);
const CANDIDATE_IDS = [...new Set([CATALOG_QA_DEFAULT_MODEL, ...POLICY_IDS].filter((id): id is string => !!id))];
const SUBSTRINGS = [
  "gemini", "claude", "qwen", "birefnet", "rmbg", "bria", "inspyre", "ben_custom", "esrgan", "swinir",
  "gpt-", "llama", "mistral", "openai/", "anthropic/", "google/", "meta-llama/", "openrouter",
];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MODEL_NAME = new RegExp([...CANDIDATE_IDS, ...SUBSTRINGS].map(escape).join("|"), "i");

const LOG_OBJECTS = new Set(["console", "logger", "log"]);
function isLogCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return LOG_OBJECTS.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && LOG_OBJECTS.has(callee.expression.text);
}

/** The text of every string literal, template piece and JSX text, skipping imports and log calls. */
function userStrings(source: string, fileName: string): { line: number; text: string }[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { line: number; text: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportTypeNode(node) || isLogCall(node)) return;
    if (ts.isExternalModuleReference(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function sourceFiles(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  return readdirSync(abs).flatMap(name => {
    const full = path.join(abs, name), rel = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(rel);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [rel] : [];
  });
}

function offenders(rel: string): string[] {
  return userStrings(readFileSync(path.join(ROOT, rel), "utf8"), rel)
    .filter(s => MODEL_NAME.test(s.text))
    .map(s => `${rel.replace(/\\/g, "/")}:${s.line}: ${JSON.stringify(s.text.trim())}`);
}

describe("no model names in operator-facing copy", () => {
  it("reads strings and ignores comments, imports and log calls", () => {
    const sample = [
      `// the judge is google/gemini-2.5-flash-lite`,
      `import { x } from "./birefnet-helpers";`,
      `console.info("matte model birefnet-general");`,
      `const ok = "Kept in the sheet";`,
      `const bad = "Checked by Claude";`,
      `const el = <p>Cut out with bria-rmbg</p>;`,
    ].join("\n");
    const hits = userStrings(sample, "sample.tsx").filter(s => MODEL_NAME.test(s.text)).map(s => s.line);
    expect(hits).toEqual([5, 6]);
  });

  it("knows every model id the default policy can choose", () => {
    expect(CANDIDATE_IDS.length).toBeGreaterThan(3);
    for (const id of CANDIDATE_IDS) expect(id).toMatch(MODEL_NAME);
  });

  it("finds none in the web app or the core copy files", () => {
    const files = [...WEB_DIRS.flatMap(sourceFiles), ...CORE_COPY_FILES];
    expect(files.length).toBeGreaterThan(20);
    expect(files.flatMap(offenders)).toEqual([]);
  });
});
