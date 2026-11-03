// The copy lint (UX design system, sections 7 and 13.4), run by `pnpm lint` through eslint.config.mjs:
// - copy/no-em-dash: no em dash anywhere in a linted file (code, comments and copy; AGENTS.md).
// - copy/no-vendor-names: no vendor or model name in operator copy (section 7 rule 2). The admin Ops page is exempt.
// - copy/word-list: the "Avoid" words of the section 7 word list, with the word to use instead.
// - copy/reading-grade: copy reads at Flesch-Kincaid grade 8 or lower (section 7 rule 1).
// "Copy" is JSX text, JSX attributes and string and template literals, except engineering text: imports, log calls,
// SQL, object keys, comparisons, tagged templates and the values of code attributes (className, href, ...). Copy that was there before the lint is listed in eslint-suppressions.json and
// is fixed as each screen is rebuilt; new copy must pass.

const EM_DASH = String.fromCharCode(0x2014);
/**
 * The em dash itself, as an HTML entity (named, decimal, hex) or as a JavaScript escape. Built from pieces so this
 * file does not match itself.
 */
const EM_DASH_FORMS = new RegExp([EM_DASH, "&" + "mdash;", "&#0*8212;", "&#x0*2014;", "\\\\" + "u0*2014", "\\\\" + "u\\{0*2014\\}"].join("|"), "gi");

/** Vendor, product and model family names, and model id paths such as "google/gemini-2.5-flash-lite". */
export const VENDOR_NAME = new RegExp([
  String.raw`\b(?:open ?router|openai|anthropic|claude|gemini|chatgpt|gpt(?:-?[\w.]+)?|dall-?e|midjourney|stable diffusion|stability ai|sdxl`,
  String.raw`black forest labs|flux|replicate|fal\.ai|fal-ai|recraft|ideogram|seedream|seededit|bytedance|qwen|deepseek|mistral|llama`,
  String.raw`birefnet|rmbg|bria|inspyre|ben_custom|esrgan|swinir|topaz|photoroom|remove\.bg|clipdrop|imagen|nano banana|vertex ai|kling)\b`,
  String.raw`\b(?:google|openai|anthropic|meta-llama|qwen|black-forest-labs|bytedance|mistralai|x-ai)\/[\w.:-]+`,
].join("|"), "i");

/** The section 7 word list: each avoided word and the word to use instead. */
export const WORD_LIST = [
  { avoid: /\bSKUs?\b/, use: "product" },
  { avoid: /\b(?:options?|style[- ]colou?rs?)\b/i, use: "product" },
  { avoid: /\b(?:marketplaces?|platforms?|storefronts?)\b/i, use: "channel, or the channel's name" },
  { avoid: /\b(?:assets?|outputs?|render(?:s|ed|ing)?)\b/i, use: "photo (from the brand) or image (what we send)" },
  { avoid: /\b(?:URLs?|CDN)\b/, use: "links" },
  { avoid: /\b(?:attention|review(?:s|ed|ing)?|action required)\b/i, use: "needs you" },
  { avoid: /\b(?:provisional|pending regeneration)\b/i, use: "improving by itself" },
  { avoid: /\b(?:failed|rejected|errors?)\b/i, use: "not made, or the plain reason" },
  { avoid: /\b(?:audits?|evals?)\b/i, use: "quality check" },
  { avoid: /\bQA\b/, use: "quality check" },
  { avoid: /\b(?:config|configuration|parameters?|flags?)\b/i, use: "setting" },
  { avoid: /\b(?:test arms?|holdouts?)\b|\bA\/B\b/i, use: "experiment" },
];

export const MAX_GRADE = 8;
/** Shorter copy (labels, buttons, short lines) gives no stable grade, so it is not graded. */
export const MIN_GRADED_WORDS = 10;

/**
 * JSX attributes whose own value is code, not copy (class names, links, ids, types, SVG geometry). Every other
 * attribute, custom props such as message= or text= included, is read as copy, and so is any string deeper inside an
 * attribute's expression, such as the text of a setError(...) call in onClick.
 */
const CODE_ATTRIBUTES = new Set(["className", "class", "href", "src", "srcSet", "key", "id", "type", "name", "value", "defaultValue",
  "style", "role", "rel", "target", "method", "action", "htmlFor", "form", "encType", "accept", "autoComplete", "inputMode", "pattern",
  "lang", "dir", "d", "viewBox", "fill", "stroke", "width", "height", "xmlns", "sizes", "loading", "decoding", "tabIndex", "colSpan",
  "rowSpan", "scope", "download", "hrefLang", "media", "as", "crossOrigin", "referrerPolicy", "ref", "cx", "cy", "r", "x", "y",
  "points", "transform", "focusable"]);
const COPY_ARIA = new Set(["aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "aria-placeholder"]);
const isCodeAttribute = (name) => CODE_ATTRIBUTES.has(name) || /^(?:data-|stroke|fill)/.test(name) || (name.startsWith("aria-") && !COPY_ARIA.has(name));
/** Expressions a code attribute's value passes through and stays code: `className={on ? "a" : `b ${c}`}`. */
const PASS_THROUGH = new Set(["JSXExpressionContainer", "ConditionalExpression", "LogicalExpression", "TemplateLiteral", "BinaryExpression"]);
const LOG_OBJECTS = new Set(["console", "logger", "log"]);
const COMPARISONS = new Set(["===", "!==", "==", "!="]);

/** Syllables in one word, by the usual vowel-group estimate. */
export function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 0);
}

/** The Flesch-Kincaid grade of a text, or null when it is too short to grade. */
export function readingGrade(text) {
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (words.length < MIN_GRADED_WORDS) return null;
  const sentences = Math.max(1, (text.match(/[.!?]+(?=\s|$)/g) ?? []).length);
  const syllableCount = words.reduce((sum, w) => sum + syllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syllableCount / words.length) - 15.59;
}

/** True for text that reads as words, not as a code value: at least two words. */
const isProse = (text) => /[A-Za-z]{2,}[\s,.;:]+[A-Za-z]{2,}/.test(text);

/** A log call (console.info, logger.warn, log(...)) or a raw SQL piece (sql.raw(...)): engineering text. */
function isCodeCall(node) {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type === "Identifier") return LOG_OBJECTS.has(callee.name);
  return callee.type === "MemberExpression" && callee.object.type === "Identifier" && (LOG_OBJECTS.has(callee.object.name) || callee.object.name === "sql");
}

function attributeName(node) {
  return node.name.type === "JSXNamespacedName" ? `${node.name.namespace.name}:${node.name.name.name}` : node.name.name;
}

/** True when a string or template literal is engineering text rather than copy. */
function isCodeString(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression", "TSExternalModuleReference",
    "TSLiteralType", "TSImportType", "TaggedTemplateExpression", "SwitchCase"].includes(parent.type)) return true;
  if (parent.type === "ExpressionStatement" && parent.directive) return true;
  if ((parent.type === "Property" || parent.type === "TSPropertySignature" || parent.type === "PropertyDefinition") && parent.key === node) return true;
  if (parent.type === "MemberExpression" && parent.property === node) return true;
  if (parent.type === "BinaryExpression" && COMPARISONS.has(parent.operator)) return true;
  let direct = true;
  for (let up = parent; up; up = up.parent) {
    if (isCodeCall(up)) return true;
    if (up.type === "JSXAttribute") return direct && isCodeAttribute(attributeName(up));
    if (up.type === "JSXElement" || up.type === "Program") return false;
    if (!PASS_THROUGH.has(up.type)) direct = false;
  }
  return false;
}

/** The copy in a file: one entry per JSX text, copy attribute, string literal or template literal. */
function copyVisitor(check) {
  return {
    Literal(node) {
      if (typeof node.value === "string" && !isCodeString(node)) check(node, node.value);
    },
    TemplateLiteral(node) {
      if (!isCodeString(node)) check(node, node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" it "));
    },
    JSXText(node) {
      if (node.value.trim()) check(node, node.value);
    },
  };
}

const noEmDash = {
  meta: { type: "problem", docs: { description: "Disallow the em dash (AGENTS.md, UX section 7 rule 8)" }, schema: [] },
  create(context) {
    return {
      Program() {
        const text = context.sourceCode.text;
        for (const match of text.matchAll(EM_DASH_FORMS)) {
          const start = context.sourceCode.getLocFromIndex(match.index);
          context.report({ loc: { start, end: context.sourceCode.getLocFromIndex(match.index + match[0].length) }, message: "No em dash (also not as an entity or escape): use \"-\" or a full stop (UX section 7)." });
        }
      },
    };
  },
};

const noVendorNames = {
  meta: { type: "problem", docs: { description: "Disallow vendor and model names in operator copy (UX section 7 rule 2)" }, schema: [] },
  create(context) {
    return copyVisitor((node, text) => {
      const hit = text.match(VENDOR_NAME);
      if (hit) context.report({ node, message: `No vendor or model name in operator copy ("${hit[0]}"). Say what it does: "image service", "the checker", "our system" (UX section 7).` });
    });
  },
};

const wordList = {
  meta: { type: "suggestion", docs: { description: "Use the words of the UX section 7 word list" }, schema: [] },
  create(context) {
    return copyVisitor((node, text) => {
      if (!isProse(text)) return;
      for (const { avoid, use } of WORD_LIST) {
        const hit = text.match(avoid);
        if (hit) context.report({ node, message: `Use "${use}" instead of "${hit[0]}" (UX section 7 word list).` });
      }
    });
  },
};

const readingGradeRule = {
  meta: { type: "suggestion", docs: { description: "Keep copy at reading grade 8 or lower (UX section 7 rule 1)" }, schema: [] },
  create(context) {
    return copyVisitor((node, text) => {
      const grade = readingGrade(text);
      if (grade !== null && grade > MAX_GRADE) context.report({ node, message: `Reading grade ${grade.toFixed(1)} is above ${MAX_GRADE}: use shorter sentences and plainer words (UX section 7).` });
    });
  },
};

export const copyPlugin = {
  meta: { name: "copy" },
  rules: { "no-em-dash": noEmDash, "no-vendor-names": noVendorNames, "word-list": wordList, "reading-grade": readingGradeRule },
};
