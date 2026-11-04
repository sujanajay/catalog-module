// Every operator of the channel rules dataset with its written meaning (M5-F1-R7). Each check is pure: it gets the
// measured value (already resolved from the subject by evaluate.ts), the rule's value and the channel record, and says
// pass, fail, needs_judge (cannot be decided mechanically, M7 or a person decides) or not_applicable (nothing to check:
// guidance or a permission). An operator missing from this table makes its rules needs_judge, never a silent pass.
import type { ChannelRecord } from "./types";
import { isSentenceCase, isTitleCase, normalizeWord } from "./text";

export type CheckOutcome = "pass" | "fail" | "needs_judge" | "not_applicable";

export interface Check {
  outcome: CheckOutcome;
  /** The rule half of the result sentence, in plain words with the numbers: "allows at most 150". */
  says: string;
}

export interface CheckContext {
  channel: ChannelRecord | null;
  brandName: string | null;
}

export interface OperatorSpec {
  /** What the operator means, in plain words (M5-F1-R7). */
  meaning: string;
  /**
   * True for operators that ask for something to be there: a value that was not measured fails. For every other
   * operator an unmeasured value is not_applicable ("not measured"), so a caller that measures only some facts gets
   * results only for those.
   */
  absenceFails?: boolean;
  check(measured: unknown, value: unknown, ctx: CheckContext): Check;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const pass = (says: string): Check => ({ outcome: "pass", says });
const fail = (says: string): Check => ({ outcome: "fail", says });
const judge = (says: string): Check => ({ outcome: "needs_judge", says });
const nothing = (says: string): Check => ({ outcome: "not_applicable", says });
const ok = (cond: boolean, says: string): Check => (cond ? pass(says) : fail(says));

export function fmt(v: unknown): string {
  if (v === null || v === undefined) return "nothing";
  if (typeof v === "string") return `"${v}"`;
  if (isSize(v)) return `${v.w}x${v.h}`;
  if (Array.isArray(v)) return v.map(fmt).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

type Size = { w: number; h: number };
function isSize(v: unknown): v is Size {
  return !!v && typeof v === "object" && typeof (v as Size).w === "number" && typeof (v as Size).h === "number";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const NOT_A_NUMBER = "value is not a number";

/** Equal for rule purposes: strings ignore case, spacing and underscores; numbers exact; lists and objects deep. */
export function same(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string") return normalizeWord(a) === normalizeWord(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    return same(ka, kb) && ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/** The measured value as a list of words: a list as it is, an object's keys whose values are present, else [value]. */
function asList(measured: unknown): unknown[] {
  if (Array.isArray(measured)) return measured;
  if (measured && typeof measured === "object") return Object.entries(measured).filter(([, v]) => isPresent(v)).map(([k]) => k);
  return [measured];
}

const contains = (list: unknown[], item: unknown) => list.some((x) => same(x, item));

/** Something is there: not null, not false, not an empty string, list or object. */
export function isPresent(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Numbers compare as numbers; sizes compare width and height both. Null when the two cannot be compared. */
function compare(m: unknown, v: unknown, test: (a: number, b: number) => boolean): boolean | null {
  if (isSize(v)) return isSize(m) ? test(m.w, v.w) && test(m.h, v.h) : null;
  if (isNum(v)) return isNum(m) ? test(m, v) : null;
  return null;
}

/** A numeric comparison operator: needs_judge when the rule's own value is not a number or size. */
function numeric(words: string, test: (a: number, b: number) => boolean): OperatorSpec {
  return {
    meaning: `The measured number (or width and height) ${words} the rule's value.`,
    check(m, v) {
      if (!isNum(v) && !isSize(v)) return judge(`has a limit that is not a number (${fmt(v)})`);
      const r = compare(m, v, test);
      return r === null ? fail(NOT_A_NUMBER) : ok(r, `${words} ${fmt(v)}`);
    },
  };
}

function range(m: unknown, v: unknown): Check {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((b) => b === null || isNum(b))) return judge(`has a range that is not two numbers (${fmt(v)})`);
  const [lo, hi] = v as [number | null, number | null];
  const says = lo === null ? `allows at most ${hi}` : hi === null ? `needs at least ${lo}` : `allows ${lo} to ${hi}`;
  if (!isNum(m)) return fail(NOT_A_NUMBER);
  return ok((lo === null || m >= lo) && (hi === null || m <= hi), says);
}

/** A regex from the dataset; a leading "(?i)" means case-insensitive. Null when the pattern does not compile. */
export function ruleRegex(pattern: string): RegExp | null {
  const insensitive = pattern.startsWith("(?i)");
  try {
    return new RegExp(insensitive ? pattern.slice(4) : pattern, insensitive ? "iu" : "u");
  } catch {
    return null;
  }
}

function regexCheck(m: unknown, v: unknown, mustMatch: boolean): Check {
  if (typeof v !== "string") return judge("has a pattern that is not text");
  const re = ruleRegex(v);
  if (!re) return judge("has a pattern that does not compile");
  const texts = Array.isArray(m) ? m : [m];
  if (!texts.every((t) => typeof t === "string")) return fail("value is not text");
  const hits = (texts as string[]).filter((t) => re.test(t));
  return mustMatch ? ok(hits.length === texts.length, "needs the pattern") : ok(hits.length === 0, "does not allow the pattern");
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Whole-word, case-insensitive search of a phrase in text. The word edge applies only where the phrase itself starts or
 * ends with a letter or digit, so markup such as "<b>" is found inside "<b>Soft</b>".
 */
export function hasPhrase(text: string, phrase: string): boolean {
  const p = phrase.trim();
  if (!p) return false;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
  const before = WORD_CHAR.test([...p][0]!) ? "(?<![\\p{L}\\p{N}])" : "";
  const after = WORD_CHAR.test([...p].at(-1)!) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${before}${escaped}${after}`, "iu").test(text);
}

/** Built-in patterns for not_contains_pattern. */
export const CONTACT_PATTERNS: Record<string, RegExp> = {
  url: /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|ae|sa|in|co|shop|store)\b/iu,
  email: /[\w.+-]+@[\w-]+\.[\w.]+/u,
  phone: /(?:\+?\d[\d\s().-]{7,}\d)/u,
};

/** A role list item such as "FM", "FM|FL" or "flat"; anything else in a sequence is prose. */
const ROLE_ITEM = /^[A-Za-z0-9_]+(\|[A-Za-z0-9_]+)*$/u;

/** Hex "#RRGGBB" or [r, g, b] as three numbers; null otherwise. */
export function rgbOf(v: unknown): [number, number, number] | null {
  if (Array.isArray(v) && v.length === 3 && v.every(isNum)) return v as [number, number, number];
  if (typeof v === "string" && /^#[0-9a-f]{6}$/iu.test(v)) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
  return null;
}

/** HSN-style code ranges and lists written in prose: "6401-6406", "6105, 6106, 6110". */
function codeSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of text.matchAll(/(\d{4})(?:\s*-\s*(\d{4}))?/gu)) spans.push([Number(m[1]), Number(m[2] ?? m[1])]);
  return spans;
}

function inCodeSpans(m: unknown, v: unknown): Check {
  if (typeof v !== "string") return judge("has no code list");
  const spans = codeSpans(v);
  if (!spans.length) return judge("has no code list");
  const code = typeof m === "number" ? String(m) : m;
  if (typeof code !== "string" || !/^\d{4}/u.test(code)) return fail("value is not a code");
  const head = Number(code.slice(0, 4));
  return ok(spans.some(([a, b]) => head >= a && head <= b), `allows codes ${v}`);
}

const guidance = (meaning: string): OperatorSpec => ({ meaning, check: () => nothing("is guidance for writers, not a check") });
const judged = (meaning: string): OperatorSpec => ({ meaning, check: () => judge("needs a judgement or data the check does not have") });

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export const OPERATORS: Record<string, OperatorSpec> = {
  equals: {
    meaning: "The measured value is the rule's value (text ignores case and spacing).",
    check: (m, v) => ok(same(m, v), `needs ${fmt(v)}`),
  },
  not_equals: {
    meaning: "The measured value is not the rule's value.",
    check: (m, v) => ok(!same(m, v), `does not allow ${fmt(v)}`),
  },
  equals_rgb: {
    meaning: "The measured colour (hex or [r, g, b]) is exactly the rule's colour.",
    check(m, v) {
      const want = rgbOf(v);
      if (!want) return judge("has a colour that is not RGB");
      const got = rgbOf(m);
      return got ? ok(same(got, want), `needs RGB ${want.join(", ")}`) : fail("value is not a colour");
    },
  },
  in_set: {
    meaning: "The measured value (or every measured value of a list) is one of the rule's values.",
    check(m, v) {
      if (!Array.isArray(v)) return judge("has no list of allowed values");
      return ok(asList(m).every((x) => contains(v, x)), `allows only ${fmt(v)}`);
    },
  },
  allowed_values: {
    meaning: "Same as in_set: the measured value is one of the listed values.",
    check: (m, v, ctx) => OPERATORS.in_set!.check(m, v, ctx),
  },
  not_in: {
    meaning: "No measured value is one of the rule's values.",
    check(m, v) {
      if (!Array.isArray(v)) return judge("has no list of values");
      return ok(!asList(m).some((x) => contains(v, x)), `does not allow ${fmt(v)}`);
    },
  },
  gte: numeric("needs at least", (a, b) => a >= b),
  lte: numeric("allows at most", (a, b) => a <= b),
  lt: numeric("allows less than", (a, b) => a < b),
  between: { meaning: "The measured number is within [min, max]; a null bound is open.", check: range },
  between_max: { meaning: "Same as between; written with an open minimum ([null, max]).", check: range },
  within: {
    meaning: "The measured canvas is at least the rule's minimum, and exactly its target when the rule says fixed.",
    check(m, v) {
      const spec = v as { min?: unknown; target?: unknown; fixed?: unknown } | null;
      if (!spec || !isSize(spec.min) || !isSize(spec.target)) return judge("has no canvas sizes");
      if (!isSize(m)) return fail("value is not a size");
      if (spec.fixed === true) return ok(same(m, spec.target), `needs exactly ${fmt(spec.target)}`);
      return ok(m.w >= spec.min.w && m.h >= spec.min.h, `needs at least ${fmt(spec.min)}`);
    },
  },
  present: {
    meaning: "The measured value is there (not empty, not false).",
    absenceFails: true,
    check: (m) => ok(isPresent(m), "needs it present"),
  },
  required: {
    meaning: "The value is there; when the rule lists allowed values, it is also one of them.",
    absenceFails: true,
    check(m, v) {
      if (!isPresent(m)) return fail("needs it present");
      const allowed = (v as { allowed_values?: unknown } | null)?.allowed_values;
      if (Array.isArray(allowed)) return ok(asList(m).every((x) => contains(allowed, x)), `needs one of ${fmt(allowed)}`);
      return pass("needs it present");
    },
  },
  all_present: {
    meaning: "Every item the rule lists is among the measured items (a list, or an object's filled keys).",
    absenceFails: true,
    check(m, v) {
      if (!Array.isArray(v)) return judge("has no list of items");
      const have = asList(m);
      const missing = v.filter((x) => !contains(have, x));
      return ok(missing.length === 0, missing.length ? `needs ${fmt(missing)} as well` : `needs ${fmt(v)}`);
    },
  },
  includes: {
    meaning: "Same as all_present: every listed item is among the measured items.",
    absenceFails: true,
    check: (m, v, ctx) => OPERATORS.all_present!.check(m, v, ctx),
  },
  includes_fields: {
    meaning: "Same as all_present, for the columns of a table.",
    absenceFails: true,
    check: (m, v, ctx) => OPERATORS.all_present!.check(m, v, ctx),
  },
  includes_any: {
    meaning: "At least one listed item is among the measured items.",
    absenceFails: true,
    check(m, v) {
      if (!Array.isArray(v)) return judge("has no list of items");
      const have = asList(m);
      return ok(v.some((x) => contains(have, x)), `needs one of ${fmt(v)}`);
    },
  },
  uses_field: {
    meaning: "The measured items (table columns) include the rule's one item.",
    absenceFails: true,
    check: (m, v) => ok(contains(asList(m), v), `needs ${fmt(v)}`),
  },
  equals_ordered: {
    meaning:
      'The measured sequence starts with the rule\'s items in that order; "A|B" means either. A sequence written as prose cannot be checked and needs a judgement.',
    check(m, v) {
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && ROLE_ITEM.test(x))) return judge("has an order written as prose");
      if (!Array.isArray(m)) return fail("value is not a sequence");
      const okOrder = v.every((item, i) => (item as string).split("|").some((alt) => same(m[i], alt)));
      return ok(okOrder, `needs the order ${(v as string[]).join(", ")}`);
    },
  },
  matches_regex: {
    meaning: 'The measured text (every item of a list) contains a match of the pattern; "(?i)" means any case.',
    check: (m, v) => regexCheck(m, v, true),
  },
  not_matches_regex: {
    meaning: "No measured text contains a match of the pattern.",
    check: (m, v) => regexCheck(m, v, false),
  },
  not_contains: {
    meaning: "The measured text, or list of words, has none of the listed words or phrases (whole words, any case).",
    check(m, v) {
      if (!Array.isArray(v)) return judge("has no list of words");
      const texts = Array.isArray(m) ? m : [m];
      const found = (v as unknown[]).filter((p) => typeof p === "string" && texts.some((t) => (typeof t === "string" ? hasPhrase(t, p) : same(t, p))));
      return ok(found.length === 0, found.length ? `does not allow ${fmt(found)}` : `does not allow ${fmt(v)}`);
    },
  },
  not_contains_pattern: {
    meaning: "The measured text has no web address, phone number or email address (the kinds the rule lists).",
    check(m, v) {
      if (!Array.isArray(v) || !v.every((k) => typeof k === "string" && k in CONTACT_PATTERNS)) return judge("names a pattern kind the check does not know");
      const texts = Array.isArray(m) ? m : [m];
      if (!texts.every((t) => typeof t === "string")) return fail("value is not text");
      const found = (v as string[]).filter((k) => (texts as string[]).some((t) => CONTACT_PATTERNS[k]!.test(t)));
      return ok(found.length === 0, found.length ? `does not allow a ${found.join(" or ")}` : `does not allow a ${(v as string[]).join(", ")}`);
    },
  },
  in_set_prefix: {
    meaning: "The measured code's first four digits fall in one of the codes or ranges the rule lists in prose.",
    check: inCodeSpans,
  },
  in_range: {
    meaning: 'The measured code\'s first four digits fall in the range "aaaa-bbbb".',
    check: inCodeSpans,
  },
  is_title_case_not_all_caps: {
    meaning: "The text is in title case and not all in capitals.",
    check: (m) => (typeof m !== "string" ? fail("value is not text") : ok(isTitleCase(m), "needs title case, not all capitals")),
  },
  is_sentence_case_not_all_caps: {
    meaning: "The text starts with a capital and is not all in capitals.",
    check: (m) => (typeof m !== "string" ? fail("value is not text") : ok(isSentenceCase(m), "needs sentence case, not all capitals")),
  },
  equals_brand: {
    meaning: "The text starts with the brand's exact name.",
    check(m, _v, ctx) {
      if (!ctx.brandName) return judge("needs the brand's exact name, which the check was not given");
      if (typeof m !== "string") return fail("value is not text");
      return ok(m.trim().startsWith(ctx.brandName), `needs to start with "${ctx.brandName}"`);
    },
  },
  matches_channel: {
    meaning: "The measured width and height have the same ratio as the channel's target canvas (within 1%).",
    check(m, _v, ctx) {
      if (!ctx.channel) return judge("needs the channel's canvas");
      if (!isSize(m)) return fail("value is not a size");
      const want = ctx.channel.targetCanvas.w / ctx.channel.targetCanvas.h;
      return ok(Math.abs(m.w / m.h - want) <= want * 0.01, `needs the ratio of ${fmt(ctx.channel.targetCanvas)}`);
    },
  },
  all_differ_between_sizes: {
    meaning: "No two size rows of the table are the same.",
    check(m) {
      if (!Array.isArray(m)) return fail("value is not a list of rows");
      return ok(m.every((row, i) => m.findIndex((other) => same(other, row)) === i), "needs every size row to differ");
    },
  },
  classify: {
    meaning: "The measured {class, value} has its value inside the band the rule gives for that class.",
    check(m, v) {
      const bands = v as Record<string, unknown> | null;
      if (!bands || typeof bands !== "object") return judge("has no bands");
      const got = m as { class?: unknown; value?: unknown } | null;
      if (!got || typeof got.class !== "string" || !isNum(got.value)) return fail("value is not a class and a number");
      const band = bands[got.class];
      if (!band) return fail(`does not know the class "${got.class}"`);
      return range(got.value, band);
    },
  },
  allowed: {
    meaning: "A permission (something may be done); there is nothing to check.",
    check: () => nothing("is a permission, not a check"),
  },
  suggest_from: guidance("A list of starting words for writers; there is nothing to check."),
  lte_shortest_channel_first: guidance("Writing advice (write to the shortest limit first); the channel limits are checked by their own rules."),
  judge: judged("A judgement rule: M7 or a person decides (M5-F4-R2 step 2)."),
  follows_formula: judged("A title formula in prose; only a judgement can say whether a title follows it."),
  per_channel: judged("A per-channel statement in prose."),
  main_keyword_within_first_chars: judged("The primary keyword appears within the first N characters; needs the primary keyword."),
  equals_primary_keyword: judged("The text starts with the primary keyword; needs the primary keyword."),
  equals_label_on_product: judged("The value matches the label sewn on the product; needs a look at the product."),
  lte_channel_limit: judged("The measured file size is within the channel's limit; the registry holds no file size limit yet."),
  present_if: judged("Present when a condition holds; the condition needs facts the check does not have."),
  must_match_product_type_definition_enum: judged("Values come from the marketplace's product type definition, which M5 does not read yet."),
  from_api: judged("Required attributes come from the marketplace API, which M5 does not read yet."),
  from_template: judged("Required attributes come from the marketplace template, which M5 does not read yet."),
  exists: judged("A process requirement (a document or schema exists); not a content check."),
  applied: judged("A process requirement (formatting was applied); not a content check."),
};

